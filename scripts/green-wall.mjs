#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, mkdtempSync, rmSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_NAME, defaults, loadConfig, validateConfig, effectiveAuthor } from './config.mjs';
import { resolveAuthor } from './author.mjs';
import { buildDailyDigest, calendarDate } from './digest.mjs';
import { failure, repositoryRoot, git, gitSafe, detectDefaultBranch, safeDataFile, safeRepositoryPath, lockPath } from './repository.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const help = `Green Wall · 自动提交系统（Node >= 20，零第三方依赖）

  node scripts/green-wall.mjs init --author-name <名字> --author-email <邮箱> [--actor <GitHub用户名>] [--repo owner/repo]
  node scripts/green-wall.mjs doctor [--network] [--json]
  node scripts/green-wall.mjs status [--json]
  node scripts/green-wall.mjs note [--date YYYY-MM-DD]
  node scripts/green-wall.mjs preview [--date YYYY-MM-DD] [--json]
  node scripts/green-wall.mjs run [--dry-run] [--no-push] [--date YYYY-MM-DD] [其他 auto-commit 参数]
  node scripts/green-wall.mjs test [--network]

所有命令支持 --dir <仓库路径>。init 仅生成配置和忽略规则，可选添加 origin；不会提交或推送。
run 默认读 green-wall.config.json；enabled=false 时暂停，不访问网络。
run 的 JSON 摘要、最近 30 次记录保存在 .green-wall/（已忽略）；演练不保存运行文件。
`;

function take(argv, key) {
  const index = argv.indexOf(`--${key}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw failure('INVALID_ARGUMENT', `--${key} 缺少取值`);
  argv.splice(index, 2);
  return value;
}

function assertFlags(argv, flags) {
  for (const arg of argv) if (!flags.includes(arg)) throw failure('INVALID_ARGUMENT', `未知参数 ${arg}；请使用 --help 查看用法。`);
}

function statePaths(cwd) {
  const { absolute } = safeDataFile(cwd, '.green-wall', '2000-01-01');
  const dir = path.dirname(absolute);
  return { dir, summary: safeRepositoryPath(cwd, path.join(dir, 'last-run.json')).absolute,
    runs: safeRepositoryPath(cwd, path.join(dir, 'runs')).absolute };
}

function emit(value, json, human) {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${human}\n`);
}

function inspect(cwd, config, network) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  add('Node', Number(process.versions.node.split('.')[0]) >= 20, process.version);
  add('首次提交', gitSafe(cwd, ['rev-parse', '--verify', 'HEAD']), '先把项目文件提交到仓库');
  add('工作区', git(cwd, ['status', '--porcelain']) === '', '运行前请提交或暂存保管当前改动');
  const author = effectiveAuthor(config);
  add('提交邮箱', author.email, author.email || '请运行 init 配置邮箱，或设置 Actions 的 GIT_AUTHOR_EMAIL 变量');
  const branch = gitSafe(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const remote = gitSafe(cwd, ['remote', 'get-url', 'origin']);
  add('origin', remote, remote ? '已配置（地址不在日志中展开）' : '请使用 init --repo owner/repo 或 git remote add origin <地址>');
  let defaultBranch;
  try { defaultBranch = detectDefaultBranch(cwd, { network }); }
  catch (error) { add('默认分支元数据', false, error.message); }
  add('默认分支', defaultBranch && defaultBranch === branch, defaultBranch ? `当前 ${branch || '(detached)'} / 默认 ${defaultBranch}` : '请运行 doctor --network 检查，或 git remote set-head origin -a');
  add('运行锁', !existsSync(lockPath(cwd)), `若进程已结束，可删除遗留锁：${lockPath(cwd)}`);
  if (network && remote) add('远端读取', gitSafe(cwd, ['ls-remote', 'origin', 'HEAD']), '仅验证网络和读取权限；写权限需实际推送验证');
  return { ok: checks.every(c => c.ok), enabled: config.enabled, checks };
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv.shift() || 'help';
  if (command === 'help' || command === '--help') { process.stdout.write(help); return 0; }
  const directory = take(argv, 'dir');
  const cwd = repositoryRoot(path.resolve(directory || process.cwd()));

  if (command === 'init') {
    const values = {
      name: take(argv, 'author-name'), email: take(argv, 'author-email'), actor: take(argv, 'actor'),
      timezone: take(argv, 'tz'), repo: take(argv, 'repo'),
    };
    assertFlags(argv, []);
    const file = path.join(cwd, CONFIG_NAME);
    if (existsSync(file)) throw failure('CONFIG_EXISTS', `${CONFIG_NAME} 已存在；请直接编辑，init 不会覆盖配置。`);
    const config = validateConfig({ ...defaults, timezone: values.timezone || defaults.timezone,
      author: { name: values.name || '', email: values.email || '', actor: values.actor || '' } }, cwd);
    if (!config.author.email) throw failure('AUTHOR_UNRESOLVED', 'init 需要 --author-email；请从 https://github.com/settings/emails 复制自己的邮箱。');
    if (values.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repo)) throw failure('INVALID_REPOSITORY', '--repo 必须为 owner/repo');
    if (values.repo && gitSafe(cwd, ['remote', 'get-url', 'origin'])) throw failure('REMOTE_EXISTS', 'origin 已存在；请省略 --repo，系统不会覆盖远端。');
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
    const ignore = safeRepositoryPath(cwd, '.gitignore').absolute;
    if (existsSync(ignore) && !readFileSync(ignore, 'utf8').split(/\r?\n/).includes('.green-wall/')) appendFileSync(ignore, '\n.green-wall/\n');
    if (!existsSync(ignore)) writeFileSync(ignore, '.green-wall/\n');
    if (values.repo) git(cwd, ['remote', 'add', 'origin', `https://github.com/${values.repo}.git`]);
    process.stdout.write(`已生成 ${CONFIG_NAME}。请检查并提交配置，再运行 doctor --network 和 run --dry-run。\n`);
    return 0;
  }

  if (command === 'test') {
    assertFlags(argv, ['--network']);
    const result = spawnSync(process.execPath, [path.join(here, 'selftest.mjs'), ...argv], { cwd, stdio: 'inherit' });
    return result.status ?? 1;
  }

  const config = loadConfig(cwd);
  const json = argv.includes('--json');
  if (command === 'note' || command === 'preview') {
    const date = calendarDate(take(argv, 'date') || new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
    assertFlags(argv, command === 'preview' ? ['--json'] : []);
    if (command === 'note') {
      const file = safeDataFile(cwd, config.content.learning.notesDir, date);
      if (existsSync(file.absolute)) throw failure('NOTES_EXIST', `学习笔记已存在：${file.relative}，不会覆盖。`);
      mkdirSync(path.dirname(file.absolute), { recursive: true });
      safeDataFile(cwd, config.content.learning.notesDir, date);
      writeFileSync(file.absolute, `# ${date}\n\n## 学习笔记\n\n## 知识卡片\n\n## 待办\n`, { flag: 'wx' });
      process.stdout.write(`已创建 ${file.relative}。填写笔记与 Q:/A: 问答，提交推送后，线上日报才能读取。\n`);
      return 0;
    }
    const digest = await buildDailyDigest({ cwd, date, timezone: config.timezone, dataDir: config.dataDir, content: config.content });
    emit(digest, json, digest.markdown);
    return digest.errors.length ? 1 : 0;
  }
  if (command === 'doctor') {
    assertFlags(argv, ['--network', '--json']);
    const result = inspect(cwd, config, argv.includes('--network'));
    try {
      await resolveAuthor({ ...effectiveAuthor(config), allowFallback: false, cwd });
    } catch (error) {
      result.ok = false;
      result.checks.push({ name: '身份校验', ok: false, detail: error.message });
    }
    emit(result, json, result.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}：${c.detail}`).join('\n') + `\n调度：${config.enabled ? '启用' : '暂停'}；${result.ok ? '本地检查通过' : '请处理以上未通过项'}`);
    return result.ok ? 0 : 1;
  }

  if (command === 'status') {
    assertFlags(argv, ['--json']);
    const state = statePaths(cwd);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const { absolute } = safeDataFile(cwd, config.dataDir, today);
    const dir = path.dirname(absolute);
    const records = existsSync(dir) ? readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort() : [];
    const lastRun = existsSync(state.summary) ? JSON.parse(readFileSync(state.summary, 'utf8')) : null;
    const tracked = gitSafe(cwd, ['cat-file', '-e', `HEAD:${path.relative(cwd, absolute).split(path.sep).join('/')}`]) !== null;
    const result = { enabled: config.enabled, timezone: config.timezone, today, todayRecorded: tracked,
      records: records.length, latestRecord: records.at(-1) || null,
      branch: gitSafe(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      originConfigured: Boolean(gitSafe(cwd, ['remote', 'get-url', 'origin'])), lastRun };
    emit(result, json, `Green Wall · ${config.enabled ? '启用' : '暂停'}\n日期：${today} (${config.timezone})\n今日记录：${tracked ? '已提交到本地仓库' : '尚未提交'}\n记录总数：${records.length}\n最近运行：${lastRun ? `${lastRun.action || lastRun.code} / ${lastRun.ok ? '成功' : '失败'} / ${lastRun.pushed ? '已推送' : '未确认推送'}` : '无记录'}\n线上运行请查看 GitHub Actions；本地状态不会假定远端成功。`);
    return 0;
  }

  if (command === 'run') {
    // The core parser rejects every unrecognized option before doing any work.
    if (!config.enabled) {
      emit({ ok: true, action: 'paused', pushed: false }, json, '系统已暂停（enabled=false），本次不生成或推送。');
      return 0;
    }
    if (argv.includes('--summary-out')) throw failure('INVALID_ARGUMENT', '统一入口自动管理运行摘要；自定义摘要请直接使用 auto-commit.mjs。');
    const author = effectiveAuthor(config);
    const flags = ['--dir', cwd, '--tz', config.timezone, '--data-dir', config.dataDir, '--push-attempts', String(config.pushAttempts)];
    if (author.name) flags.push('--author-name', author.name);
    if (author.email) flags.push('--author-email', author.email);
    if (author.actor) flags.push('--actor', author.actor);
    const dryRun = argv.includes('--dry-run');
    const state = statePaths(cwd);
    const temp = dryRun ? null : mkdtempSync(path.join(os.tmpdir(), 'green-wall-run-'));
    const summaryFile = temp && path.join(temp, 'summary.json');
    if (summaryFile) flags.push('--summary-out', summaryFile);
    try {
      const result = spawnSync(process.execPath, [path.join(here, 'auto-commit.mjs'), ...flags, ...argv], { cwd, stdio: 'inherit' });
      if (summaryFile && existsSync(summaryFile)) {
        const record = { finishedAt: new Date().toISOString(), ...JSON.parse(readFileSync(summaryFile, 'utf8')) };
        mkdirSync(state.runs, { recursive: true });
        statePaths(cwd);
        const runName = `${Date.now()}-${process.pid}.json`;
        const body = `${JSON.stringify(record, null, 2)}\n`;
        const runFile = safeRepositoryPath(cwd, path.join(state.runs, runName)).absolute;
        writeFileSync(runFile, body, { flag: 'wx' });
        const snapshot = safeRepositoryPath(cwd, path.join(state.dir, `last-${process.pid}.tmp`)).absolute;
        writeFileSync(snapshot, body, { flag: 'wx' });
        renameSync(snapshot, state.summary);
        for (const old of readdirSync(state.runs).filter(f => /^\d+-\d+\.json$/.test(f)).sort().slice(0, -30)) {
          rmSync(safeRepositoryPath(cwd, path.join(state.runs, old)).absolute);
        }
      }
      return result.status ?? 1;
    } finally {
      if (temp) rmSync(temp, { recursive: true });
    }
  }
  throw failure('INVALID_COMMAND', `未知命令 ${command}；请运行 --help。`);
}

main().then(code => { process.exitCode = code; }).catch(error => {
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ ok: false, code: error.code || 'ERROR', error: error.message })}\n`);
  else process.stderr.write(`[green-wall] ${error.code || 'ERROR'}：${error.message}\n`);
  process.exitCode = 1;
});
