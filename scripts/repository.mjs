import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, openSync, closeSync, writeFileSync, unlinkSync, realpathSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

export function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...options,
  }).trim();
}

export function gitSafe(cwd, args) {
  try { return git(cwd, args); } catch { return null; }
}

export function repositoryRoot(cwd) {
  const root = gitSafe(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) throw failure('NOT_A_REPOSITORY', `当前目录不是 git 仓库：${cwd}`);
  return realpathSync(root);
}

export function validateBranch(cwd, branch) {
  if (!branch || gitSafe(cwd, ['check-ref-format', `refs/heads/${branch}`]) === null) {
    throw failure('INVALID_BRANCH', `分支名不合法：${branch || '(空)'}。请使用实际分支名。`);
  }
  return branch;
}

export function detectDefaultBranch(cwd, { network = false } = {}) {
  // Event metadata describes the repository; GITHUB_REF_NAME describes the selected ref.
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_EVENT_PATH) {
    try {
      const branch = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))?.repository?.default_branch;
      if (branch) return validateBranch(cwd, branch);
    } catch (error) {
      throw failure('INVALID_EVENT_METADATA', `无法读取 Actions 仓库默认分支：${error.message}`);
    }
  }
  const symref = gitSafe(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (symref) return validateBranch(cwd, symref.replace(/^origin\//, ''));
  if (network && gitSafe(cwd, ['remote', 'get-url', 'origin'])) {
    const remoteHead = gitSafe(cwd, ['ls-remote', '--symref', 'origin', 'HEAD']);
    const branch = /^ref: refs\/heads\/(.+)\s+HEAD$/m.exec(remoteHead || '')?.[1];
    if (branch) return validateBranch(cwd, branch);
  }
  return null;
}

export function safeDataFile(cwd, dataDir, date) {
  return safeRepositoryPath(cwd, path.resolve(cwd, dataDir, `${date}.md`));
}

export function safeRepositoryPath(cwd, target) {
  const root = realpathSync(cwd);
  let absolute = path.resolve(root, target);
  // macOS /var and /private/var may name the same repository. Normalize only
  // the repository prefix, so symlinks below the repository remain visible.
  for (let probe = path.dirname(absolute); probe !== path.dirname(probe); probe = path.dirname(probe)) {
    if (existsSync(probe) && realpathSync(probe) === root) {
      absolute = path.resolve(root, path.relative(probe, absolute));
      break;
    }
  }
  const relative = path.relative(root, absolute);
  const parts = relative.split(path.sep);
  if (!relative || parts[0] === '..' || path.isAbsolute(relative) || parts.some(p => p.toLowerCase() === '.git')) {
    throw failure('UNSAFE_DATA_PATH', `路径 "${target}" 落在仓库 ${root} 之外或 Git 元数据内。请使用仓库内的数据目录。`);
  }
  let probe = root;
  for (const part of parts) {
    probe = path.join(probe, part);
    try {
      if (lstatSync(probe).isSymbolicLink()) {
        throw failure('UNSAFE_DATA_PATH', `数据路径含符号链接：${probe}。请改用仓库内的真实目录。`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { absolute, relative: parts.join('/') };
}

export function lockPath(cwd) {
  const id = createHash('sha256').update(repositoryRoot(cwd)).digest('hex').slice(0, 24);
  return path.join(os.tmpdir(), `green-wall-${id}.lock`);
}

export async function withRepositoryLock(cwd, dryRun, action) {
  if (dryRun) return action();
  const lock = lockPath(cwd);
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw failure('RUN_LOCKED', `已有运行或遗留锁：${lock}。先确认其他进程已结束，再删除该锁文件重试。`);
  }
  const release = () => { if (existsSync(lock)) unlinkSync(lock); };
  const interrupted = () => { release(); process.exit(130); };
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    closeSync(fd);
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
    return await action();
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    release();
  }
}

export async function pushWithRetry(cwd, branch, attempts = 3) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      git(cwd, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
      return { pushed: true, pushError: null, pushAttempts: attempt };
    } catch (error) {
      // Report only a controlled message: remote URLs may contain credentials.
      last = /non-fast-forward|fetch first|rejected/i.test(String(error.stderr || ''))
        ? '远端已更新或分支策略拒绝推送。请检查远端权限与分支规则，并在同步后的干净仓库重跑；系统不会强推或改写历史。'
        : '无法推送到 origin。请检查网络、origin 地址与仓库写权限；本地提交已保留，修复后用相同日期重跑补推。';
      if (/non-fast-forward|fetch first|rejected/i.test(String(error.stderr || ''))) {
        return { pushed: false, pushError: last, pushAttempts: attempt };
      }
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
  }
  return { pushed: false, pushError: last, pushAttempts: attempts };
}

export function checkPendingCommits(cwd, branch, authorEmail, dataDir, allowGitHubComEmail, classifyEmail) {
  try { git(cwd, ['fetch', '--no-tags', 'origin', `refs/heads/${branch}`]); }
  catch { throw failure('RECOVERY_FETCH_FAILED', '无法检查远端状态。请检查网络和 origin 写权限，恢复后用相同日期重跑。'); }
  const remote = git(cwd, ['rev-parse', 'FETCH_HEAD']);
  const head = git(cwd, ['rev-parse', 'HEAD']);
  if (remote === head) return { alreadyPushed: true, pendingCount: 0 };
  if (gitSafe(cwd, ['merge-base', '--is-ancestor', remote, head]) === null) {
    throw failure('REMOTE_DIVERGED', '远端包含本地没有的提交。请先手动同步并解决冲突后重跑；系统不会强推、rebase 或自动合并。');
  }
  const pending = git(cwd, ['rev-list', `${remote}..${head}`]).split('\n').filter(Boolean);
  const prefix = path.relative(cwd, path.resolve(cwd, dataDir)).split(path.sep).join('/');
  for (const sha of pending) {
    const [email, subject] = git(cwd, ['show', '-s', '--format=%ae%x1f%s', sha]).split('\x1f');
    const files = git(cwd, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', sha]).split('\n').filter(Boolean);
    const safeFiles = files.length <= 1 && files.every(file => path.posix.dirname(file) === (prefix || '.') && /^\d{4}-\d{2}-\d{2}\.md$/.test(path.posix.basename(file)));
    const parents = git(cwd, ['rev-list', '--parents', '-n', '1', sha]).split(' ');
    if (email !== authorEmail || classifyEmail(email, { allowGitHubComEmail }).blocked || !subject.startsWith('[auto]') || !safeFiles || parents.length > 2) {
      throw failure('UNSAFE_PENDING_COMMITS', `补推范围含非本系统记录或身份不符的提交 ${sha.slice(0, 7)}，已停止。请检查 git log 后手动处理。`);
    }
  }
  return { alreadyPushed: false, pendingCount: pending.length };
}
