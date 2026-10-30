#!/usr/bin/env node
/**
 * selftest.mjs —— 冒烟测试：在一次性临时 git 仓库里把关键行为全部跑一遍。
 *
 *   node scripts/selftest.mjs                     # 离线用例（系统 tmpdir，macOS 会自动清理）
 *   node scripts/selftest.mjs --workdir <dir>     # 指定测试目录
 *   node scripts/selftest.mjs --network           # 额外跑需要外网的 T21
 *
 * 覆盖：
 *   T1  --dry-run 不写文件、不提交、不推送
 *   T2  未配置 author 时报错，并指向 settings/emails
 *   T3  机器人邮箱被拒绝，不产生提交
 *   T4  首次提交：author 归属正确、[auto] 前缀、记录文件生成
 *   T5  同一天重复运行幂等跳过
 *   T6  --empty 产生真正的空提交
 *   T7  --date 回填后 %aI 与 %cI 都是目标日期，且标注回填
 *   T8  脏工作区以 DIRTY_WORKTREE 中止，用户改动原样保留
 *   T9  提交成功推送到 origin（默认分支已识别的正例）
 *   T10 --verify-last-commit 对正常提交通过
 *   T11 --verify-last-commit 对 bot 提交失败
 *   T12 summary.mjs 的 --field 与 --to-step-summary
 *   T13 非法 --date / --tz 给出明确错误
 *   T14 摘要文件损坏时 --field 以退出码 1 结束（不被误读成「没有新提交」）
 *   T15 非默认分支拒绝运行；--allow-non-default-branch 可放行
 *   T16 不存在的历法日期（2026-02-30）被拒绝，不会静默滚到 3 月 2 日
 *   T17 残留的 GIT_AUTHOR_* 环境变量不会覆盖显式身份，空值也不会让 git fatal
 *   T18 各类平台/机器人邮箱变体全部被拦截
 *   T19 --force-dirty 只提交生成的文件，不带走用户已 staged 的改动
 *   T20 --data-dir 在仓库外时报错；仓库内的绝对路径可用
 *   T21 按账号 ID 推导别名邮箱（需 --network）
 *
 * 所有子进程都在**清理过 GIT_AUTHOR_* / GIT_COMMITTER_* / GITHUB_* 的环境**里运行，
 * 否则用户 shell 里导出的身份变量会污染断言（README 正好教用户导出这两个变量）。
 *
 * 说明：破坏性场景（脏工作区、bot 提交、非默认分支）各自使用独立的一次性仓库，
 * 因此全程不需要 reset/checkout 之类的破坏性操作。零第三方依赖。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withRepositoryLock, lockPath } from './repository.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUTO_COMMIT = path.join(HERE, 'auto-commit.mjs');
const AUTHOR = path.join(HERE, 'author.mjs');
const SUMMARY = path.join(HERE, 'summary.mjs');
const SYSTEM = path.join(HERE, 'green-wall.mjs');

const GOOD_EMAIL = '1234567+testuser@users.noreply.github.com';
const GOOD_NAME = 'testuser';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
const TZ = 'Asia/Shanghai';

/** 会污染断言的环境变量：git 身份类 + Actions 上下文类。 */
const POLLUTING_VARS = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GITHUB_ACTIONS',
  'GITHUB_ACTOR',
  'GITHUB_REF_NAME',
  'GITHUB_EVENT_NAME',
  'GITHUB_EVENT_PATH',
  'GITHUB_TOKEN',
  'GITHUB_API_TOKEN',
  'GREEN_WALL_ALLOW_GITHUB_COM',
];

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of POLLUTING_VARS) delete env[key];
  return { ...env, ...extra };
}

const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok === 'skip' ? '○' : ok ? '✓' : '✗';
  process.stdout.write(`${mark} ${name}${detail ? `  —  ${detail}` : ''}\n`);
}

function sh(cmd, args, opts = {}) {
  const { env, ...rest } = opts;
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnv(env),
    ...rest,
  }).trim();
}

function git(repo, args, opts = {}) {
  return sh('git', ['-C', repo, ...args], opts);
}

/** 运行被测脚本，永不抛错，返回 { code, stdout, stderr }。 */
function runScript(script, args, { cwd, env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd,
      encoding: 'utf8',
      env: cleanEnv({ GIT_AUTHOR_NAME: GOOD_NAME, GIT_AUTHOR_EMAIL: GOOD_EMAIL, ...env }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function zonedDateStr(tz, date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function daysAgo(n) {
  return zonedDateStr(TZ, new Date(Date.now() - n * 86400000));
}

function initRepo(dir, { remote, setHead = false } = {}) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.name', 'local-dev']);
  git(dir, ['config', 'user.email', 'local-dev@example.com']);
  writeFileSync(path.join(dir, 'README.md'), '# green-wall selftest\n', 'utf8');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'chore: init']);
  if (remote) {
    sh('git', ['init', '--bare', '-b', 'main', remote]);
    git(dir, ['remote', 'add', 'origin', remote]);
    git(dir, ['push', '-u', 'origin', 'main']);
    if (setHead) git(dir, ['remote', 'set-head', 'origin', 'main']);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const wdIdx = argv.indexOf('--workdir');
  let workdir;
  if (wdIdx !== -1 && argv[wdIdx + 1]) {
    workdir = path.resolve(argv[wdIdx + 1]);
    mkdirSync(workdir, { recursive: true });
  } else {
    workdir = mkdtempSync(path.join(os.tmpdir(), 'green-wall-selftest-'));
  }

  const repo = path.join(workdir, 'repo');
  const remote = path.join(workdir, 'remote.git');
  const sandbox = path.join(workdir, 'sandbox-repo'); // T8 / T11 / T19
  const branchRepo = path.join(workdir, 'branch-repo'); // T15
  const branchRemote = path.join(workdir, 'branch-remote.git');
  const envRepo = path.join(workdir, 'env-repo'); // T17 / T18 / T20
  process.stdout.write(`测试工作目录：${workdir}\n\n`);

  initRepo(repo, { remote, setHead: true });
  initRepo(sandbox);
  initRepo(branchRepo, { remote: branchRemote, setHead: true });
  initRepo(envRepo);

  const today = zonedDateStr(TZ, new Date());
  const todayFile = path.join(repo, 'data/daily', `${today}.md`);
  const baseArgs = ['--dir', repo, '--tz', TZ, '--no-fallback'];

  // ---------- T1 ----------
  {
    const r = runScript(AUTO_COMMIT, [...baseArgs, '--dry-run'], { cwd: repo });
    const ok =
      r.code === 0 &&
      r.stdout.includes('DRY RUN') &&
      r.stdout.includes(GOOD_EMAIL) &&
      r.stdout.includes(today) &&
      !existsSync(todayFile);
    record('T1 dry-run：只演练，不写文件不提交', ok, ok ? '' : `code=${r.code}\n${r.stdout}\n${r.stderr}`);
  }

  // ---------- T2 ----------
  {
    const r = runScript(AUTO_COMMIT, [...baseArgs, '--dry-run'], {
      cwd: repo,
      env: { GIT_AUTHOR_EMAIL: '', GIT_AUTHOR_NAME: '' },
    });
    const ok = r.code !== 0 && /GIT_AUTHOR_EMAIL/.test(r.stderr) && /settings\/emails/.test(r.stderr);
    record('T2 未配置 author：报错并指向 settings/emails', ok, ok ? '' : `code=${r.code} ${r.stderr.slice(0, 200)}`);
  }

  // ---------- T3 ----------
  {
    const r = runScript(AUTO_COMMIT, [...baseArgs, '--dry-run', '--author-email', BOT_EMAIL], { cwd: repo });
    const ok = r.code !== 0 && /机器人/.test(r.stderr) && !existsSync(todayFile);
    record('T3 bot 邮箱：拒绝运行', ok, ok ? '' : `code=${r.code} ${r.stderr.slice(0, 200)}`);
  }

  // ---------- T4 ----------
  {
    const summaryPath = path.join(workdir, 'summary-t4.json');
    const r = runScript(AUTO_COMMIT, [...baseArgs, '--no-push', '--summary-out', summaryPath], { cwd: repo });
    const ae = r.code === 0 ? git(repo, ['log', '-1', '--format=%ae']) : '';
    const subject = r.code === 0 ? git(repo, ['log', '-1', '--format=%s']) : '';
    const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : {};
    const body = existsSync(todayFile) ? readFileSync(todayFile, 'utf8') : '';
    const ok =
      r.code === 0 &&
      ae === GOOD_EMAIL &&
      subject.startsWith('[auto]') &&
      summary.action === 'committed' &&
      summary.pushed === false &&
      summary.branch === 'main' &&
      summary.defaultBranch === 'main' &&
      body.includes(today) &&
      body.includes('回填：否');
    record('T4 首次提交：author 归属正确 + [auto] 前缀 + 记录生成', ok, ok ? '' : `code=${r.code} ae=${ae} subject=${subject} branch=${summary.branch}/${summary.defaultBranch}\n${r.stderr.slice(0, 300)}`);
  }

  // ---------- T5 ----------
  {
    const before = git(repo, ['rev-list', '--count', 'HEAD']);
    const r = runScript(AUTO_COMMIT, [...baseArgs, '--no-push'], { cwd: repo });
    const after = git(repo, ['rev-list', '--count', 'HEAD']);
    const ok = r.code === 0 && before === after && /跳过/.test(r.stdout);
    record('T5 幂等：当天重复运行不产生新提交', ok, ok ? `${before} → ${after}` : `code=${r.code} ${before}→${after}\n${r.stdout.slice(0, 200)}`);
  }

  // ---------- T6 ----------
  {
    const before = Number(git(repo, ['rev-list', '--count', 'HEAD']));
    const r = runScript(AUTO_COMMIT, [...baseArgs, '--no-push', '--empty'], { cwd: repo });
    const after = Number(git(repo, ['rev-list', '--count', 'HEAD']));
    const tree = r.code === 0 ? git(repo, ['log', '-1', '--format=%T']) : '';
    const parentTree = r.code === 0 ? git(repo, ['log', '-1', '--format=%T', 'HEAD~1']) : '';
    const ok = r.code === 0 && after === before + 1 && tree === parentTree;
    record('T6 --empty：产生空提交（tree 与父提交一致）', ok, ok ? '' : `code=${r.code} ${before}→${after}\n${r.stderr.slice(0, 200)}`);
  }

  // ---------- T7 ----------
  {
    const past = daysAgo(7);
    const r = runScript(AUTO_COMMIT, [...baseArgs, '--no-push', '--date', past], { cwd: repo });
    const aI = r.code === 0 ? git(repo, ['log', '-1', '--format=%aI']) : '';
    const cI = r.code === 0 ? git(repo, ['log', '-1', '--format=%cI']) : '';
    const f = path.join(repo, 'data/daily', `${past}.md`);
    const ok = r.code === 0 && aI.startsWith(past) && cI.startsWith(past) && existsSync(f) && /回填：是/.test(readFileSync(f, 'utf8'));
    record('T7 回填：author/committer 日期都对齐，且标注回填', ok, ok ? `${aI} / ${cI}` : `code=${r.code} aI=${aI} cI=${cI}\n${r.stderr.slice(0, 200)}`);
  }

  // ---------- T8（独立仓库）----------
  {
    writeFileSync(path.join(sandbox, 'wip.md'), '我还没写完的重要改动\n', 'utf8');
    const target = daysAgo(3);
    const r = runScript(AUTO_COMMIT, ['--dir', sandbox, '--tz', TZ, '--no-fallback', '--no-push', '--date', target], { cwd: sandbox });
    const stillDirty = git(sandbox, ['status', '--porcelain']).includes('wip.md');
    const ok =
      r.code !== 0 &&
      /DIRTY_WORKTREE/.test(r.stderr) &&
      stillDirty &&
      !existsSync(path.join(sandbox, 'data/daily', `${target}.md`));
    record('T8 脏工作区：以 DIRTY_WORKTREE 中止，用户改动原样保留', ok, ok ? '' : `code=${r.code} ${r.stderr.slice(0, 200)}`);
  }

  // ---------- T9 ----------
  {
    const d = daysAgo(2);
    const summaryPath = path.join(workdir, 'summary-t9.json');
    const r = runScript(AUTO_COMMIT, [...baseArgs, '--date', d, '--summary-out', summaryPath], { cwd: repo });
    const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : {};
    const localCount = git(repo, ['rev-list', '--count', 'main']);
    const remoteCount = git(remote, ['rev-list', '--count', 'main']);
    const ok = r.code === 0 && summary.pushed === true && localCount === remoteCount;
    record('T9 推送：本地提交已同步到 origin（默认分支正例）', ok, ok ? `本地 = 远端 = ${localCount}` : `code=${r.code} local=${localCount} remote=${remoteCount}\n${r.stderr.slice(0, 300)}`);
  }

  // ---------- T10 ----------
  {
    const r = runScript(AUTHOR, ['--verify-last-commit', '--cwd', repo]);
    record('T10 归属校验（正常提交）：通过', r.code === 0, r.code === 0 ? '' : `${r.stdout}${r.stderr}`.slice(0, 200));
  }

  // ---------- T11（独立仓库）----------
  {
    git(sandbox, ['-c', 'user.name=github-actions[bot]', '-c', `user.email=${BOT_EMAIL}`, 'commit', '--allow-empty', '-m', 'chore: simulate bot commit']);
    const r = runScript(AUTHOR, ['--verify-last-commit', '--cwd', sandbox]);
    const ok = r.code === 1 && /机器人/.test(r.stderr);
    record('T11 归属校验（bot 提交）：判定失败并说明原因', ok, ok ? '' : `code=${r.code} ${r.stdout}${r.stderr}`.slice(0, 200));
  }

  // ---------- T12 ----------
  {
    const summaryPath = path.join(workdir, 'summary-t9.json');
    const stepSummary = path.join(workdir, 'step-summary.md');
    const fieldRun = runScript(SUMMARY, ['--field', 'action'], { cwd: repo, env: { SUMMARY_PATH: summaryPath } });
    const shaRun = runScript(SUMMARY, ['--field', 'sha'], { cwd: repo, env: { SUMMARY_PATH: summaryPath } });
    const mdRun = runScript(SUMMARY, ['--to-step-summary'], {
      cwd: repo,
      env: { SUMMARY_PATH: summaryPath, GITHUB_STEP_SUMMARY: stepSummary },
    });
    const md = existsSync(stepSummary) ? readFileSync(stepSummary, 'utf8') : '';
    const ok =
      fieldRun.code === 0 &&
      fieldRun.stdout.trim() === 'committed' &&
      /^[0-9a-f]{7,40}$/.test(shaRun.stdout.trim()) &&
      mdRun.code === 0 &&
      md.includes('### auto-commit') &&
      md.includes('| 目标日期 |');
    record('T12 summary.mjs：--field 取字段、--to-step-summary 出 Markdown', ok, ok ? '' : `action="${fieldRun.stdout}" sha="${shaRun.stdout}" md=${md.slice(0, 120)}`);
  }

  // ---------- T13 ----------
  {
    const badDate = runScript(AUTO_COMMIT, [...baseArgs, '--dry-run', '--date', '2026-13-45'], { cwd: repo });
    const badTz = runScript(AUTO_COMMIT, ['--dir', repo, '--dry-run', '--tz', 'Mars/Olympus', '--no-fallback'], { cwd: repo });
    const ok =
      badDate.code !== 0 &&
      /格式|真实存在/.test(badDate.stderr) &&
      badTz.code !== 0 &&
      /IANA/.test(badTz.stderr);
    record('T13 非法 --date / --tz：给出明确错误', ok, ok ? '' : `date=${badDate.code}:${badDate.stderr.slice(0, 80)} | tz=${badTz.code}:${badTz.stderr.slice(0, 80)}`);
  }

  // ---------- T14 ----------
  {
    const corrupt = path.join(workdir, 'summary-corrupt.json');
    writeFileSync(corrupt, '{"action": "committed", 这不是合法 JSON', 'utf8');
    const missing = path.join(workdir, 'summary-does-not-exist.json');
    const rCorrupt = runScript(SUMMARY, ['--field', 'action'], { cwd: repo, env: { SUMMARY_PATH: corrupt } });
    const rMissing = runScript(SUMMARY, ['--field', 'action'], { cwd: repo, env: { SUMMARY_PATH: missing } });
    const ok = rCorrupt.code === 1 && rCorrupt.stdout.trim() === '' && rMissing.code === 0 && rMissing.stdout.trim() === '';
    record('T14 摘要损坏时 --field 以退出码 1 结束（不被误读成「没有新提交」）', ok, ok ? '' : `corrupt=${rCorrupt.code} missing=${rMissing.code}`);
  }

  // ---------- T15（独立仓库）----------
  {
    git(branchRepo, ['switch', '-c', 'feature/x']);
    const blocked = runScript(AUTO_COMMIT, ['--dir', branchRepo, '--tz', TZ, '--no-fallback', '--no-push'], { cwd: branchRepo });
    const blockedOk = blocked.code !== 0 && /NOT_DEFAULT_BRANCH/.test(blocked.stderr) && /默认分支/.test(blocked.stderr);
    const allowed = runScript(AUTO_COMMIT, ['--dir', branchRepo, '--tz', TZ, '--no-fallback', '--no-push', '--allow-non-default-branch'], { cwd: branchRepo });
    const allowedBranch = allowed.code === 0 ? git(branchRepo, ['rev-parse', '--abbrev-ref', 'HEAD']) : '';
    const ok = blockedOk && allowed.code === 0 && allowedBranch === 'feature/x';
    record('T15 非默认分支：默认拒绝，--allow-non-default-branch 可放行', ok, ok ? '' : `blocked=${blocked.code}:${blocked.stderr.slice(0, 120)} allowed=${allowed.code}`);
  }

  // ---------- T16 ----------
  {
    const r = runScript(AUTO_COMMIT, [...baseArgs, '--dry-run', '--date', '2026-02-30'], { cwd: repo });
    const noFile = !existsSync(path.join(repo, 'data/daily', '2026-02-30.md')) && !existsSync(path.join(repo, 'data/daily', '2026-03-02.md'));
    const ok = r.code !== 0 && /真实存在的日期/.test(r.stderr) && noFile;
    record('T16 不存在的历法日期（2026-02-30）：拒绝，不静默滚到 03-02', ok, ok ? '' : `code=${r.code} ${r.stderr.slice(0, 160)}`);
  }

  // ---------- T17（独立仓库）----------
  {
    // 场景 A：残留的 GIT_AUTHOR_EMAIL 是平台邮箱，但显式参数指定了正确身份 -> 必须用正确的
    const dA = daysAgo(5);
    const rA = runScript(AUTO_COMMIT, ['--dir', envRepo, '--tz', TZ, '--no-fallback', '--no-push', '--date', dA, '--author-email', GOOD_EMAIL, '--author-name', GOOD_NAME], {
      cwd: envRepo,
      env: { GIT_AUTHOR_EMAIL: 'actions@github.com', GIT_AUTHOR_NAME: 'GitHub Actions', GIT_COMMITTER_EMAIL: 'actions@github.com' },
    });
    const aeA = rA.code === 0 ? git(envRepo, ['log', '-1', '--format=%ae']) : '';
    const ceA = rA.code === 0 ? git(envRepo, ['log', '-1', '--format=%ce']) : '';
    const okA = rA.code === 0 && aeA === GOOD_EMAIL && ceA === GOOD_EMAIL;

    // 场景 B：GIT_AUTHOR_EMAIL 为空字符串（正是 vars 未配置时 CI 注入的值）-> 不能 fatal
    const dB = daysAgo(6);
    const rB = runScript(AUTO_COMMIT, ['--dir', envRepo, '--tz', TZ, '--no-fallback', '--no-push', '--date', dB, '--author-email', GOOD_EMAIL, '--author-name', GOOD_NAME], {
      cwd: envRepo,
      env: { GIT_AUTHOR_EMAIL: '', GIT_AUTHOR_NAME: '' },
    });
    const aeB = rB.code === 0 ? git(envRepo, ['log', '-1', '--format=%ae']) : '';
    const okB = rB.code === 0 && aeB === GOOD_EMAIL && !/empty ident/.test(rB.stderr);

    record('T17 残留/空的 GIT_AUTHOR_* 环境变量不会覆盖显式身份', okA && okB, okA && okB ? '' : `A(code=${rA.code},ae=${aeA},ce=${ceA}) B(code=${rB.code},ae=${aeB}) ${rA.stderr.slice(0, 120)}${rB.stderr.slice(0, 120)}`);
  }

  // ---------- T18 ----------
  {
    const variants = [
      'actions@github.com',
      'action@github.com',
      'support@github.com',
      'dependabot@github.com',
      'no-reply@github.com',
      'noreply@github.com',
      'notifications@github.com',
      'security@github.com',
      'copilot@github.com',
      'bot@github.com',
      BOT_EMAIL,
      '1234+dependabot[bot]@users.noreply.github.com',
      'semantic-release-bot@users.noreply.github.com',
      'renovate[bot]@users.noreply.github.com',
      'github-actions@users.noreply.github.com',
    ];
    const leaked = [];
    for (const v of variants) {
      const r = runScript(AUTHOR, ['--author-email', v, '--author-name', 'x', '--no-fallback'], { cwd: envRepo });
      if (r.code === 0) leaked.push(v);
    }
    // 正例：合法身份必须放行
    const goodRun = runScript(AUTHOR, ['--author-email', GOOD_EMAIL, '--author-name', GOOD_NAME, '--no-fallback'], { cwd: envRepo });
    const legacyRun = runScript(AUTHOR, ['--author-email', 'testuser@users.noreply.github.com', '--author-name', GOOD_NAME, '--no-fallback'], { cwd: envRepo });
    const escapeRun = runScript(AUTHOR, ['--author-email', 'staff@github.com', '--author-name', 'staff', '--no-fallback', '--allow-github-com-email'], { cwd: envRepo });
    const ok = leaked.length === 0 && goodRun.code === 0 && legacyRun.code === 0 && escapeRun.code === 0;
    record('T18 平台/机器人邮箱变体全部被拦截，合法身份与逃生舱放行', ok, ok ? `${variants.length} 个变体全拦` : `漏网：${leaked.join(', ')} good=${goodRun.code} legacy=${legacyRun.code} escape=${escapeRun.code}`);
  }

  // ---------- T19（独立仓库）----------
  {
    writeFileSync(path.join(sandbox, 'staged-wip.txt'), '用户已经 git add 的无关改动\n', 'utf8');
    git(sandbox, ['add', 'staged-wip.txt']);
    const before = git(sandbox, ['rev-list', '--count', 'HEAD']);
    const d = daysAgo(4);
    const r = runScript(AUTO_COMMIT, ['--dir', sandbox, '--tz', TZ, '--no-fallback', '--no-push', '--force-dirty', '--date', d], { cwd: sandbox });
    const files = r.code === 0 ? git(sandbox, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n').filter(Boolean) : [];
    const stillStaged = git(sandbox, ['status', '--porcelain']).includes('staged-wip.txt');
    const after = git(sandbox, ['rev-list', '--count', 'HEAD']);
    const ok =
      r.code === 0 &&
      Number(after) === Number(before) + 1 &&
      files.length === 1 &&
      files[0] === `data/daily/${d}.md` &&
      stillStaged;
    record('T19 --force-dirty：只提交生成的文件，用户 staged 改动原样保留', ok, ok ? `提交含 ${files.join(',')}` : `code=${r.code} files=[${files.join(',')}] stillStaged=${stillStaged}\n${r.stderr.slice(0, 200)}`);
  }

  // ---------- T20 ----------
  {
    const outside = path.join(workdir, 'outside-data');
    const rOutside = runScript(AUTO_COMMIT, ['--dir', envRepo, '--tz', TZ, '--no-fallback', '--dry-run', '--data-dir', outside], { cwd: envRepo });
    const insideAbs = path.join(envRepo, 'data', 'custom');
    const rInside = runScript(AUTO_COMMIT, ['--dir', envRepo, '--tz', TZ, '--no-fallback', '--dry-run', '--data-dir', insideAbs], { cwd: envRepo });
    const ok =
      rOutside.code !== 0 &&
      /之外/.test(rOutside.stderr) &&
      !existsSync(outside) &&
      rInside.code === 0 &&
      rInside.stdout.includes('data/custom/');
    record('T20 --data-dir：仓库外报错，仓库内绝对路径可用', ok, ok ? '' : `outside=${rOutside.code}:${rOutside.stderr.slice(0, 100)} inside=${rInside.code}:${rInside.stdout.slice(0, 100)}`);
  }

  // ---------- T21（需要外网，默认跳过）----------
  if (argv.includes('--network')) {
    const r = runScript(AUTHOR, ['--actor', 'torvalds', '--json'], {
      cwd: repo,
      env: { GIT_AUTHOR_EMAIL: '', GIT_AUTHOR_NAME: '' },
    });
    let parsed = null;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      parsed = null;
    }
    const ok =
      r.code === 0 &&
      parsed?.source === 'github-api-derived' &&
      /^\d+\+torvalds@users\.noreply\.github\.com$/.test(parsed?.email || '');
    record('T21 按账号 ID 推导别名邮箱（需外网）', ok, ok ? parsed.email : `code=${r.code} out=${r.stdout.slice(0, 120)} err=${r.stderr.slice(0, 160)}`);
  } else {
    record('T21 按账号 ID 推导别名邮箱', 'skip', '加 --network 启用（需要访问 api.github.com）');
  }


  // ---------- T22: --empty must not consume any part of the user's index ----------
  {
    const d = path.join(workdir, 'empty-isolation');
    initRepo(d);
    const first = runScript(AUTO_COMMIT, ['--no-push'], { cwd: d });
    writeFileSync(path.join(d, 'private-wip.txt'), 'staged version\n');
    git(d, ['add', 'private-wip.txt']);
    writeFileSync(path.join(d, 'private-wip.txt'), 'unstaged version\n');
    const before = git(d, ['diff', '--cached']);
    const tree = git(d, ['rev-parse', 'HEAD^{tree}']);
    const r = runScript(AUTO_COMMIT, ['--no-push', '--force-dirty', '--empty'], { cwd: d });
    const ok = first.code === 0 && r.code === 0 && tree === git(d, ['rev-parse', 'HEAD^{tree}']) && before === git(d, ['diff', '--cached']) && readFileSync(path.join(d, 'private-wip.txt'), 'utf8') === 'unstaged version\n';
    record('T22 空提交保留用户暂存和未暂存内容', ok, ok ? '' : `${r.code} ${r.stderr}`);
  }

  // ---------- T23: directory, final-file and dangling symlinks; Git metadata ----------
  {
    const d = path.join(workdir, 'path-boundaries');
    initRepo(d);
    const outside = path.join(workdir, 'outside-symlink');
    mkdirSync(outside);
    symlinkSync(outside, path.join(d, 'linked'), 'dir');
    git(d, ['add', 'linked']); git(d, ['commit', '-m', 'tracked link']);
    const dirRun = runScript(AUTO_COMMIT, ['--no-push', '--data-dir', 'linked'], { cwd: d });
    mkdirSync(path.join(d, 'data/daily'), { recursive: true });
    const externalFile = path.join(outside, 'private.md');
    symlinkSync(externalFile, path.join(d, 'data/daily', `${today}.md`));
    git(d, ['add', 'data']); git(d, ['commit', '-m', 'dangling file link']);
    const fileRun = runScript(AUTO_COMMIT, ['--no-push'], { cwd: d });
    const metadata = runScript(AUTO_COMMIT, ['--no-push', '--data-dir', '.git'], { cwd: d });
    const ok = [dirRun, fileRun, metadata].every(r => r.code !== 0 && /UNSAFE_DATA_PATH/.test(r.stderr)) && !existsSync(externalFile) && !existsSync(path.join(outside, `${today}.md`)) && !existsSync(path.join(d, '.git', `${today}.md`));
    record('T23 目录/文件/悬空符号链接及 Git 元数据均禁止写入', ok, ok ? '' : [dirRun, fileRun, metadata].map(r => r.stderr).join('\n'));
  }

  // ---------- T24: dispatch ref is not repository.default_branch ----------
  {
    const d = path.join(workdir, 'dispatch');
    const dest = path.join(workdir, 'dispatch.git');
    initRepo(d, { remote: dest });
    git(d, ['switch', '-c', 'feature']);
    const event = path.join(workdir, 'dispatch-event.json');
    writeFileSync(event, JSON.stringify({ repository: { default_branch: 'main' } }));
    const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'feature', GITHUB_EVENT_PATH: event };
    const r = runScript(AUTO_COMMIT, ['--no-push'], { cwd: d, env });
    const fallback = runScript(AUTO_COMMIT, [], { cwd: d, env: { ...env, GITHUB_EVENT_PATH: '' } });
    const ok = [r, fallback].every(v => v.code !== 0 && /NOT_DEFAULT_BRANCH/.test(v.stderr)) && !existsSync(path.join(d, 'data/daily', `${today}.md`));
    record('T24 手动选择 feature 不能冒充默认分支（事件元数据/远端两条路径）', ok, ok ? '' : `${r.stderr}\n${fallback.stderr}`);
  }

  // ---------- T25: retry an already-created commit without creating a second one ----------
  {
    const d = path.join(workdir, 'recover');
    const dest = path.join(workdir, 'recover.git');
    initRepo(d, { remote: dest, setHead: true });
    const hook = path.join(dest, 'hooks/pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "rejected for test" >&2\nexit 1\n', { mode: 0o755 });
    const first = runScript(AUTO_COMMIT, ['--push-attempts', '1'], { cwd: d });
    const count = git(d, ['rev-list', '--count', 'HEAD']);
    unlinkSync(hook);
    const recovered = runScript(AUTO_COMMIT, ['--json'], { cwd: d });
    const third = runScript(AUTO_COMMIT, ['--json'], { cwd: d });
    let result = {}, skipped = {};
    try { result = JSON.parse(recovered.stdout); skipped = JSON.parse(third.stdout); } catch {}
    const ok = first.code !== 0 && recovered.code === 0 && third.code === 0 && result.action === 'recovered-push' && result.pushed && skipped.action === 'skipped-existing' && skipped.pushed && count === git(d, ['rev-list', '--count', 'HEAD']) && git(d, ['rev-parse', 'HEAD']) === git(dest, ['rev-parse', 'main']);
    record('T25 推送失败后恢复补推且不重复提交，第三次确认同步', ok, ok ? '' : `${first.code}/${recovered.code}/${third.code} ${recovered.stderr} ${recovered.stdout}`);
  }

  // ---------- T26: recovery refuses unrelated local commits and diverged histories ----------
  {
    const d = path.join(workdir, 'unsafe-recover');
    const dest = path.join(workdir, 'unsafe-recover.git');
    initRepo(d, { remote: dest, setHead: true });
    runScript(AUTO_COMMIT, ['--no-push'], { cwd: d });
    writeFileSync(path.join(d, 'work.txt'), 'unrelated work\n');
    git(d, ['add', 'work.txt']); git(d, ['commit', '-m', 'human change']);
    const r = runScript(AUTO_COMMIT, [], { cwd: d });
    const clone = path.join(workdir, 'other-clone');
    sh('git', ['clone', dest, clone]);
    git(clone, ['config', 'user.name', GOOD_NAME]); git(clone, ['config', 'user.email', GOOD_EMAIL]);
    writeFileSync(path.join(clone, 'remote.txt'), 'remote work\n');
    git(clone, ['add', 'remote.txt']); git(clone, ['commit', '-m', 'remote update']); git(clone, ['push']);
    const head = git(d, ['rev-parse', 'HEAD']);
    const divergent = runScript(AUTO_COMMIT, [], { cwd: d });
    const ok = r.code !== 0 && /UNSAFE_PENDING_COMMITS/.test(r.stderr) && divergent.code !== 0 && /REMOTE_DIVERGED/.test(divergent.stderr) && head === git(d, ['rev-parse', 'HEAD']);
    record('T26 补推拒绝夹带人工提交和远端分叉，不改写历史', ok, ok ? '' : `${r.stderr}\n${divergent.stderr}`);
  }

  // ---------- T27: mistyped flags cannot turn dry-run into a real commit ----------
  {
    const d = path.join(workdir, 'argument-errors'); initRepo(d);
    const before = git(d, ['rev-parse', 'HEAD']);
    const runs = [['--dryrun'], ['--date', '--no-push'], ['--push-attempts', '99'], ['unexpected']].map(args => runScript(AUTO_COMMIT, args, { cwd: d }));
    const ok = runs.every(r => r.code !== 0) && before === git(d, ['rev-parse', 'HEAD']) && !existsSync(path.join(d, 'data'));
    record('T27 参数拼错、缺值、非法次数均在写入前失败', ok, ok ? '' : runs.map(r => `${r.code}:${r.stderr}`).join('\n'));
  }

  // ---------- T28: a custom message remains marked; escape hatch works end-to-end ----------
  {
    const d = path.join(workdir, 'author-escape'); initRepo(d);
    const r = runScript(AUTO_COMMIT, ['--no-push', '--message', 'snapshot {date}', '--author-email', 'staff@github.com', '--allow-github-com-email'], { cwd: d });
    const blocked = runScript(AUTHOR, ['--author-email', 'fake[bot]@github.com', '--allow-github-com-email', '--no-fallback'], { cwd: d });
    const ok = blocked.code !== 0 && r.code === 0 && git(d, ['log', '-1', '--format=%s']).startsWith('[auto] snapshot') && git(d, ['log', '-1', '--format=%ae']) === 'staff@github.com';
    record('T28 自定义信息仍标记 [auto]，企业邮箱放行贯穿提交后校验', ok, ok ? '' : r.stderr);
  }

  // ---------- T29: concurrent execution is refused without removing another process's lock ----------
  {
    const d = path.join(workdir, 'locking'); initRepo(d);
    let result, held;
    await withRepositoryLock(d, false, async () => {
      result = runScript(AUTO_COMMIT, ['--no-push'], { cwd: d });
      held = existsSync(lockPath(d));
    });
    const next = runScript(AUTO_COMMIT, ['--no-push'], { cwd: d });
    const ok = result.code !== 0 && /RUN_LOCKED/.test(result.stderr) && held && next.code === 0 && !existsSync(lockPath(d));
    record('T29 并发运行拒绝且不删除他人锁，正常退出释放锁', ok, ok ? '' : `${result.stderr} ${next.stderr}`);
  }

  // ---------- T30: initialization validates configuration and never overwrites it ----------
  {
    const d = path.join(workdir, 'system-init'); initRepo(d);
    const bad = runScript(SYSTEM, ['init', '--author-email', BOT_EMAIL], { cwd: d });
    const absentAfterBad = !existsSync(path.join(d, 'green-wall.config.json'));
    const r = runScript(SYSTEM, ['init', '--author-name', GOOD_NAME, '--author-email', GOOD_EMAIL], { cwd: d });
    const before = readFileSync(path.join(d, 'green-wall.config.json'), 'utf8');
    const repeated = runScript(SYSTEM, ['init', '--author-email', 'other@example.com'], { cwd: d });
    const ok = bad.code !== 0 && absentAfterBad && r.code === 0 && repeated.code !== 0 && /CONFIG_EXISTS/.test(repeated.stderr) && before === readFileSync(path.join(d, 'green-wall.config.json'), 'utf8') && readFileSync(path.join(d, '.gitignore'), 'utf8').includes('.green-wall/');
    record('T30 配置初始化校验身份、不覆盖配置、运行文件自动忽略', ok, ok ? '' : `${bad.stderr} ${r.stderr} ${repeated.stderr}`);
  }

  // ---------- T31: unified run/status/doctor, machine JSON, bounded per-run history ----------
  {
    const d = path.join(workdir, 'system-run');
    const dest = path.join(workdir, 'system-run.git');
    initRepo(d, { remote: dest, setHead: true });
    runScript(SYSTEM, ['init', '--author-name', GOOD_NAME, '--author-email', GOOD_EMAIL], { cwd: d });
    git(d, ['add', 'green-wall.config.json', '.gitignore']); git(d, ['commit', '-m', 'configure']); git(d, ['push']);
    const doctor = runScript(SYSTEM, ['doctor', '--network', '--json'], { cwd: d });
    const dry = runScript(SYSTEM, ['run', '--dry-run', '--json'], { cwd: d });
    const noDryState = !existsSync(path.join(d, '.green-wall'));
    const r = runScript(SYSTEM, ['run', '--json'], { cwd: d });
    const status = runScript(SYSTEM, ['status', '--json'], { cwd: d });
    let doc = {}, preview = {}, result = {}, state = {};
    try { doc = JSON.parse(doctor.stdout); preview = JSON.parse(dry.stdout); result = JSON.parse(r.stdout); state = JSON.parse(status.stdout); } catch {}
    const ok = doctor.code === 0 && doc.ok && dry.code === 0 && preview.dryRun && noDryState && r.code === 0 && result.pushed && status.code === 0 && state.todayRecorded && state.lastRun.pushed && existsSync(path.join(d, '.green-wall/runs')) && git(d, ['status', '--porcelain']) === '';
    record('T31 统一入口：体检、演练无落盘、运行推送、状态与审计一致', ok, ok ? '' : `${doctor.stderr} ${dry.stderr} ${r.stderr} ${status.stderr} ${r.stdout}`);
  }

  // ---------- T32: pause and invalid config cannot create a commit ----------
  {
    const d = path.join(workdir, 'pause'); initRepo(d);
    const file = path.join(d, 'green-wall.config.json');
    writeFileSync(file, JSON.stringify({ enabled: false }));
    const head = git(d, ['rev-parse', 'HEAD']);
    const paused = runScript(SYSTEM, ['run', '--json'], { cwd: d });
    const failures = [{ token: 'not-a-real-secret' }, { timezone: 'Mars/Crater' }, { dataDir: '../outside' }, { pushAttempts: 0 }, { author: { email: BOT_EMAIL } }].map(config => {
      writeFileSync(file, JSON.stringify(config)); return runScript(SYSTEM, ['run'], { cwd: d });
    });
    const ok = paused.code === 0 && JSON.parse(paused.stdout).action === 'paused' && failures.every(r => r.code !== 0) && head === git(d, ['rev-parse', 'HEAD']);
    record('T32 暂停和非法配置不提交；配置禁止 token/越界路径/机器人身份', ok, ok ? '' : failures.map(r => `${r.code}:${r.stderr}`).join('\n'));
  }

  // ---------- T33: explicit push target cannot bypass the checked-out branch ----------
  {
    const d = path.join(workdir, 'branch-overrides');
    initRepo(d, { remote: path.join(workdir, 'branch-overrides.git'), setHead: true });
    git(d, ['switch', '-c', 'feature']);
    const override = runScript(AUTO_COMMIT, ['--no-push', '--branch', 'main'], { cwd: d });
    git(d, ['switch', '--detach', 'HEAD']);
    const detached = runScript(AUTO_COMMIT, ['--no-push'], { cwd: d });
    const ok = override.code !== 0 && /BRANCH_MISMATCH/.test(override.stderr) && detached.code !== 0 && !existsSync(path.join(d, 'data'));
    record('T33 --branch 不能夹带 feature 历史，detached HEAD 不写入', ok, ok ? '' : `${override.stderr} ${detached.stderr}`);
  }

  // ---------- T34: an existing uncommitted record cannot be reported as success ----------
  {
    const d = path.join(workdir, 'uncommitted-record'); initRepo(d);
    mkdirSync(path.join(d, 'data/daily'), { recursive: true });
    const file = path.join(d, 'data/daily', `${today}.md`);
    writeFileSync(file, 'unfinished record');
    const r = runScript(AUTO_COMMIT, ['--no-push', '--force-dirty'], { cwd: d });
    const ok = r.code !== 0 && /RECORD_NOT_COMMITTED/.test(r.stderr) && readFileSync(file, 'utf8') === 'unfinished record' && git(d, ['rev-list', '--count', 'HEAD']) === '1';
    record('T34 已存在但未提交的记录明确失败并保留内容', ok, ok ? '' : r.stderr);
  }


  // ---------- T35: execute the real workflow shell with an argv-recording Node shim ----------
  {
    const workflow = readFileSync(path.join(HERE, '../.github/workflows/auto-commit.yml'), 'utf8');
    const match = /- name: 演练并运行自动提交系统[\s\S]*?run:\s*\|\n([\s\S]*?)(?=\n      - name:)/.exec(workflow);
    const temp = path.join(workdir, 'workflow-shell');
    mkdirSync(temp);
    const shim = path.join(temp, 'node');
    writeFileSync(shim, `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.CALLS,JSON.stringify(process.argv.slice(2))+'\\n');process.stdout.write(JSON.stringify({ok:true})+'\\n');\n`, { mode: 0o755 });
    const callsFile = path.join(temp, 'calls.jsonl');
    const marker = path.join(temp, 'must-not-exist');
    const payload = `2026-10-30; touch ${marker}`;
    let ok = Boolean(match), detail = '';
    if (match) {
      const body = match[1].replace(/^ {10}/gm, '');
      const shellEnv = { PATH: `${temp}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: temp, CALLS: callsFile, INPUT_DATE: payload };
      sh('bash', ['-c', body], { cwd: repo, env: { ...shellEnv, INPUT_DRY_RUN: 'false' } });
      const actualAll = readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
      const actual = actualAll.filter(args => args[1] === 'run');
      writeFileSync(callsFile, '');
      sh('bash', ['-c', body], { cwd: repo, env: { ...shellEnv, INPUT_DRY_RUN: 'true' } });
      const dryAll = readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
      const dry = dryAll.filter(args => args[1] === 'run');
      ok = actualAll.filter(args => args[1] === 'preview').length === 1 && dryAll.filter(args => args[1] === 'preview').length === 1 && actual.length === 2 && actual[0].includes('--dry-run') && !actual[1].includes('--dry-run') && dry.length === 1 && dry[0].includes('--dry-run') && [...actual, ...dry].every(args => args[args.indexOf('--date') + 1] === payload) && !existsSync(marker);
      detail = `actual=${actual.length}, dry=${dry.length}`;
    }
    record('T35 工作流先演练再执行，演练模式不执行真实任务，日期输入不注入 shell', ok, ok ? '' : detail);
  }

  // ---------- T36: source adapters and rich-report integration (node:test) ----------
  {
    const r = runScript(path.join(HERE, 'digest.test.mjs'), [], { cwd: repo });
    record('T36 日报资料接入回归（来源、比较、失败和 CLI 场景）', r.code === 0, r.code === 0 ? '' : `${r.stdout}\n${r.stderr}`);
  }

  // ---------- 汇总 ----------
  const passed = results.filter((r) => r.ok === true).length;
  const failed = results.filter((r) => r.ok === false).length;
  const skipped = results.filter((r) => r.ok === 'skip').length;
  process.stdout.write(
    `\n${'='.repeat(56)}\n通过 ${passed}，失败 ${failed}，跳过 ${skipped}（共 ${results.length} 项）\n`
  );
  if (failed > 0) {
    process.stdout.write('失败项：\n');
    for (const r of results.filter((x) => x.ok === false)) {
      process.stdout.write(`  - ${r.name}\n`);
      if (r.detail) process.stdout.write(`      ${r.detail.split('\n').join('\n      ')}\n`);
    }
  }
  process.stdout.write(`测试目录保留在：${workdir}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`selftest 崩溃：${err?.stack || err}\n`);
  process.exitCode = 1;
});
