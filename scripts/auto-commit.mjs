#!/usr/bin/env node
/**
 * auto-commit.mjs —— 每天往仓库写一条有内容的记录并提交，用于维持 GitHub 贡献图。
 *
 * 设计原则：
 *   - 幂等：同一天重复运行不会产生第二个提交（除非显式 --empty）
 *   - 诚实：提交信息带 [auto] 前缀，文件里写明生成时间与触发方式，回填会被标注
 *   - 安全：不 force push、不改写历史、脏工作区默认拒绝运行，绝不误提交你未保存的其他改动
 *   - 零依赖：只用 Node >= 20 内置模块
 *
 * 本地用法：
 *   node scripts/auto-commit.mjs --dry-run              # 演练，不写文件不提交
 *   node scripts/auto-commit.mjs --no-push              # 只提交，不推送
 *   node scripts/auto-commit.mjs --date 2026-10-20      # 回填指定日期（author+committer 日期都会设为该日）
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveAuthor, classifyEmail } from './author.mjs';
import { loadConfig } from './config.mjs';
import { buildDailyDigest, requireCompleteDigest } from './digest.mjs';
import { git, gitSafe, failure, repositoryRoot, detectDefaultBranch, validateBranch, safeDataFile, withRepositoryLock, pushWithRetry, checkPendingCommits } from './repository.mjs';

const log = (text) => (process.argv.includes('--json') ? process.stderr : process.stdout).write(text);

const DEFAULT_TZ = process.env.TZ || 'Asia/Shanghai';
const DEFAULT_DATA_DIR = 'data/daily';

/* ------------------------------ 参数解析 ------------------------------ */

const FLAG_KEYS = new Set([
  'date',
  'tz',
  'dir',
  'cwd',
  'data-dir',
  'author-name',
  'author-email',
  'actor',
  'branch',
  'trigger',
  'message',
  'summary-out',
  'push-attempts',
]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (FLAG_KEYS.has(key)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`参数 --${key} 缺少取值`);
      }
      out[key] = next;
      i += 1;
    } else {
      if (!new Set(['help', 'dry-run', 'no-push', 'empty', 'force-dirty', 'allow-non-default-branch', 'no-fallback', 'allow-github-com-email', 'json']).has(key)) throw failure('INVALID_ARGUMENT', `未知参数 --${key}；请运行 --help 查看用法。`);
      out[key] = true;
    }
  }
  if (out._.length) throw failure('INVALID_ARGUMENT', `未知位置参数：${out._.join(' ')}`);
  return out;
}

const HELP = `用法：node scripts/auto-commit.mjs [选项]

日期与时区：
  --date YYYY-MM-DD   目标日期，默认按 --tz 计算的「今天」
  --tz <IANA>         时区，默认 Asia/Shanghai（贡献图按你的本地自然日算，别用 UTC）

身份：
  --author-name <n>   提交者名，默认取 GIT_AUTHOR_NAME
  --author-email <e>  提交者邮箱，默认取 GIT_AUTHOR_EMAIL；必须是你账号里已验证的邮箱
  --actor <login>     GitHub 用户名，用于按账号 ID 推导别名邮箱兜底
  --no-fallback       禁止调 GitHub API 推导，只认显式配置

行为：
  --dry-run           只打印将要做的事，不写文件、不提交、不推送
  --no-push           提交但不推送（本地跑常用）
  --empty             当天记录已存在时，仍然产生一个空提交
  --force-dirty       工作区有未提交改动时也继续（默认拒绝）。
                      注意：即使加了这个参数，也只会提交本脚本生成的那一个文件，
                      你已 staged 的其他改动不会被带走
  --allow-non-default-branch
                      当前分支不是默认分支时也继续（默认拒绝，因为那种提交不计入贡献图）
  --data-dir <path>   每日记录目录，默认 data/daily；必须在仓库内
  --branch <name>     推送目标分支，默认当前分支
  --trigger <name>    写进记录的触发方式，默认取 GITHUB_EVENT_NAME 或 manual
  --message <text>    自定义提交信息模板，{date} 会被替换
  --summary-out <p>   把 JSON 摘要写到该文件
  --push-attempts <n>  推送重试次数，1–5，默认 3
  --allow-github-com-email  允许 GitHub 员工企业邮箱
  --json              摘要打印到 stdout（供管道消费）
  --help              显示本帮助
`;

/* ------------------------------ 时区工具 ------------------------------ */

function zonedDateParts(tz, date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function zonedClock(tz, date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function zonedOffset(tz, date) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
    }).formatToParts(date);
    const part = parts.find((p) => p.type === 'timeZoneName');
    const m = /GMT([+-]\d{2}:?\d{2})/.exec(part?.value || '');
    if (!m) return '+00:00';
    const raw = m[1];
    // V8 的 longOffset 恒为 GMT±HH:MM；万一拿到不带冒号的 ±HHMM，补冒号而不是丢掉分钟
    return raw.includes(':') ? raw : `${raw.slice(0, 3)}:${raw.slice(3)}`;
  } catch {
    return '+00:00';
  }
}

/**
 * 校验 YYYY-MM-DD 是真实存在的历法日期。
 * 注意 `new Date('2026-02-30T12:00:00Z')` 不会得到 Invalid Date，而是静默滚成 2026-03-02，
 * 所以必须构造后回读比对——否则格子会亮在错误的日子上，而且幂等键与真实日期脱钩。
 */
function assertRealCalendarDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) {
    throw new Error(`--date 格式应为 YYYY-MM-DD，收到 "${dateStr}"`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new Error(`--date "${dateStr}" 不是真实存在的日期（该月没有 ${day} 号）`);
  }
  return { year, month, day };
}

/** 把 YYYY-MM-DD 解析成该时区正午的 Date；非法日期抛错。 */
function noonInZone(tz, dateStr) {
  assertRealCalendarDate(dateStr);
  const probe = new Date(`${dateStr}T12:00:00Z`);
  // 用该时区的偏移把正午对齐回真实时刻，保证 git 拿到的日期字符串就是 dateStr
  const offset = zonedOffset(tz, probe);
  const sign = offset[0] === '-' ? -1 : 1;
  const oh = Number(offset.slice(1, 3));
  const om = Number(offset.slice(4, 6));
  const shiftMs = sign * (oh * 3600 + (Number.isFinite(om) ? om : 0) * 60) * 1000;
  const result = new Date(probe.getTime() - shiftMs);
  // 兜底断言：对齐后在该时区看到的日期必须仍等于 dateStr，
  // 否则宁可报错，也不要提交到错误的日子上。
  if (zonedDateParts(tz, result) !== dateStr) {
    throw new Error(
      `内部错误：无法把 ${dateStr} 正午对齐到时区 ${tz}（得到 ${zonedDateParts(tz, result)}）。` +
        '请换一个 --tz，或改用不带 --date 的运行方式。'
    );
  }
  return result;
}

function isoWithOffset(date, tz) {
  return `${zonedDateParts(tz, date)}T${zonedClock(tz, date)}${zonedOffset(tz, date)}`;
}

/* ------------------------------ 主流程 ------------------------------ */

async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    log(HELP);
    return { code: 0 };
  }

  const cwd = repositoryRoot(path.resolve(args.dir || args.cwd || process.cwd()));
  return withRepositoryLock(cwd, args['dry-run'] === true, () => runLocked(args, cwd));
}

async function runLocked(args, cwd) {
  const tz = typeof args.tz === 'string' ? args.tz : DEFAULT_TZ;
  const dataDir = typeof args['data-dir'] === 'string' ? args['data-dir'] : DEFAULT_DATA_DIR;
  const dryRun = args['dry-run'] === true;
  const noPush = args['no-push'] === true;
  const allowEmpty = args.empty === true;
  const forceDirty = args['force-dirty'] === true;
  const notices = [];
  const allowGitHubComEmail = args['allow-github-com-email'] === true || process.env.GREEN_WALL_ALLOW_GITHUB_COM === '1';
  const pushAttempts = Number(args['push-attempts'] || 3);
  if (!Number.isInteger(pushAttempts) || pushAttempts < 1 || pushAttempts > 5) throw failure('INVALID_ARGUMENT', '--push-attempts 必须为 1–5 的整数');

  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
  } catch {
    throw new Error(`--tz "${tz}" 不是合法的 IANA 时区名`);
  }

  // 1) 必须在 git 仓库里
  if (gitSafe(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    throw new Error(`当前目录不是 git 仓库：${cwd}`);
  }

  // 2) 解析提交身份（失败会抛带指引的错误）
  const author = await resolveAuthor({
    name: typeof args['author-name'] === 'string' ? args['author-name'] : undefined,
    email: typeof args['author-email'] === 'string' ? args['author-email'] : undefined,
    actor: typeof args.actor === 'string' ? args.actor : undefined,
    allowFallback: args['no-fallback'] !== true,
    cwd,
    allowGitHubComEmail,
  });
  notices.push(...author.notices, ...author.warnings);

  // 3) 分支校验：贡献图只统计默认分支上的提交，推错分支等于白跑
  const currentBranch = gitSafe(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || '';
  const explicitBranch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : null;
  const defaultBranch = detectDefaultBranch(cwd, { network: !noPush && !dryRun });
  const targetBranch =
    explicitBranch || (currentBranch && currentBranch !== 'HEAD' ? currentBranch : null);

  validateBranch(cwd, targetBranch);
  if (explicitBranch && explicitBranch !== currentBranch) {
    throw failure('BRANCH_MISMATCH', `当前分支 ${currentBranch || '(detached)'} 与 --branch ${explicitBranch} 不一致。请先 git switch 到目标分支。`);
  }
  if (defaultBranch && targetBranch !== defaultBranch && args['allow-non-default-branch'] !== true) {
    throw failure('NOT_DEFAULT_BRANCH', `当前分支 "${targetBranch}" 不是默认分支 "${defaultBranch}"。请 git switch ${defaultBranch}，或显式使用 --allow-non-default-branch。`);
  }
  if (!defaultBranch) {
    if (!noPush && !dryRun && args['allow-non-default-branch'] !== true) {
      throw failure('DEFAULT_BRANCH_UNKNOWN', '无法确认远端默认分支。请检查 origin 联网状态，或运行 git remote set-head origin -a 后重试。');
    }
    notices.push('离线演练/仅本地提交：未确认远端默认分支，推送前必须完成检查。');
  }

  // 4) 目标日期
  const now = new Date();
  const explicitDate = typeof args.date === 'string' && args.date.trim() !== '' ? args.date.trim() : null;
  const targetDate = explicitDate || zonedDateParts(tz, now);
  assertRealCalendarDate(targetDate);
  const isBackfill = Boolean(explicitDate) && explicitDate !== zonedDateParts(tz, now);
  const commitTime = isBackfill ? noonInZone(tz, explicitDate) : now;
  const commitIso = isoWithOffset(commitTime, tz);

  if (isBackfill) {
    const days = Math.round((now - commitTime) / 86400000);
    const when = days >= 0 ? `${days} 天前` : `${Math.abs(days)} 天后（未来）`;
    notices.push(`回填模式：目标日期 ${targetDate}，约 ${when}，提交时间已设为该日正午 ${tz} → ${commitIso}`);
    if (days > 366) {
      notices.push('提示：贡献图只展示最近一年，超过 366 天的回填不会显示');
    }
    if (commitTime > now) {
      notices.push('提示：目标日期在未来，GitHub 可能不计入贡献图');
    }
  }

  // 5) 脏工作区保护（在写任何文件之前检查）
  const preStatus = git(cwd, ['status', '--porcelain']);
  if (preStatus.trim() && !forceDirty && !dryRun) {
    const err = new Error(
      [
        '工作区存在未提交改动，为避免误提交你的其他工作，已中止：',
        ...preStatus.split('\n').slice(0, 10).map((l) => `  ${l}`),
        '',
        '处理方式：先提交或 git stash，或显式加 --force-dirty（仅提交系统记录，保留其他暂存改动）。',
      ].join('\n')
    );
    err.code = 'DIRTY_WORKTREE';
    throw err;
  }

  // 6) 生成当日记录
  const { absolute: absFile, relative: relFile } = safeDataFile(cwd, dataDir, targetDate);
  const fileExists = existsSync(absFile);
  if (fileExists && gitSafe(cwd, ['cat-file', '-e', `HEAD:${relFile}`]) === null) {
    throw failure('RECORD_NOT_COMMITTED', `记录 ${relFile} 已存在但未进入 HEAD。请检查上次提交失败的原因并手动处理该文件，再重跑。`);
  }

  const trigger =
    (typeof args.trigger === 'string' && args.trigger) ||
    process.env.GITHUB_EVENT_NAME ||
    'manual';

  let totalCommits = Number(gitSafe(cwd, ['rev-list', '--count', 'HEAD']) || '0');
  if (!Number.isFinite(totalCommits)) totalCommits = 0;

  let content = [
    `# ${targetDate}`,
    '',
    `- 生成时间：${isoWithOffset(now, tz)}`,
    `- 触发方式：${trigger}`,
    `- 仓库累计提交：${totalCommits}`,
    isBackfill ? `- 回填：是（--date ${targetDate}）` : '- 回填：否',
    '- 由 scripts/auto-commit.mjs 自动生成',
    '',
  ].join('\n');

  const contentConfig = loadConfig(cwd).content;
  let digest = null;
  if (!fileExists && Object.values(contentConfig).some(source => source.enabled)) {
    digest = requireCompleteDigest(await buildDailyDigest({ cwd, date: targetDate, timezone: tz, dataDir, content: contentConfig, now }));
    content += `\n${digest.markdown}`;
  }

  let action;
  if (fileExists) {
    action = allowEmpty ? 'empty-commit' : 'skipped-existing';
  } else {
    action = dryRun ? 'dry-run' : 'committed';
  }

  let message =
    typeof args.message === 'string' && args.message
      ? args.message.replaceAll('{date}', targetDate)
      : `[auto] daily record for ${targetDate}`;

  if (!message.startsWith('[auto]')) message = `[auto] ${message}`;

  const planned = [];
  if (!fileExists) {
    planned.push(`write ${relFile}`);
  }
  if (action !== 'skipped-existing') {
    planned.push(`git add -- ${relFile}`);
    const envPrefix = isBackfill
      ? `GIT_AUTHOR_DATE=${commitIso} GIT_COMMITTER_DATE=${commitIso} `
      : '';
    const dateFlag = isBackfill ? ` --date ${commitIso}` : '';
    const tail = allowEmpty && fileExists ? ' --allow-empty --only' : ` --only -- ${relFile}`;
    planned.push(
      `${envPrefix}git -c user.name=${JSON.stringify(author.name)} ` +
        `-c user.email=${JSON.stringify(author.email)} commit -m ${JSON.stringify(message)}${dateFlag}${tail}`
    );
  }
  if (!noPush) {
    planned.push(`git push origin HEAD:refs/heads/${targetBranch || '<未确定>'}`);
  }

  if (dryRun) {
    log(
      [
        '=== DRY RUN（未写文件、未提交、未推送）===',
        `仓库目录  : ${cwd}`,
        `目标日期  : ${targetDate}（时区 ${tz}${isBackfill ? '，回填' : ''}）`,
        `记录文件  : ${relFile}${fileExists ? '（已存在，将跳过写入）' : ''}`,
        `提交身份  : ${author.name} <${author.email}>  来源=${author.source}`,
        `触发方式  : ${trigger}`,
        `将执行    :`,
        ...planned.map((p) => `  - ${p}`),
        '--- 文件内容预览 ---',
        content.trimEnd(),
        '----------------------',
        ...notices.map((n) => `! ${n}`),
        '',
      ].join('\n')
    );
    return { code: 0, summary: buildSummary() };
  }

  if (action === 'skipped-existing') {
    log(`今天（${targetDate}）的记录已存在，跳过生成，不产生新提交。\n`);
    if (noPush) return { code: 0, summary: buildSummary() };
    const sha = git(cwd, ['rev-parse', 'HEAD']);
    try {
      const pending = checkPendingCommits(cwd, targetBranch, author.email, dataDir, allowGitHubComEmail, classifyEmail);
      const result = pending.alreadyPushed
        ? { pushed: true, pushError: null, pushAttempts: 0 }
        : await pushWithRetry(cwd, targetBranch, pushAttempts);
      if (!pending.alreadyPushed) action = 'recovered-push';
      log(result.pushed ? '远端同步已确认。\n' : `${result.pushError}\n`);
      return { code: result.pushError ? 1 : 0, summary: buildSummary({ ...result, sha, pendingCount: pending.pendingCount }) };
    } catch (error) {
      throw error;
    }
  }

  // 7) 写文件 + 提交
  if (!fileExists) {
    mkdirSync(path.dirname(absFile), { recursive: true });
    // Recheck the path immediately before exclusive creation; never overwrite a record.
    safeDataFile(cwd, dataDir, targetDate);
    writeFileSync(absFile, content, { encoding: 'utf8', flag: 'wx' });
    log(`已写入 ${relFile}\n`);
  }

  if (!fileExists) git(cwd, ['add', '--', relFile]);

  const isEmptyCommit = allowEmpty && fileExists;
  const commitArgs = [
    '-c',
    `user.name=${author.name}`,
    '-c',
    `user.email=${author.email}`,
    'commit',
    '-m',
    message,
  ];
  if (isBackfill) {
    // 必须放在 `--` 之前：`--` 之后的所有内容都会被 git 当作 pathspec
    commitArgs.push('--date', commitIso);
  }
  if (isEmptyCommit) {
    commitArgs.push('--allow-empty', '--only');
  } else {
    // 用 pathspec 限定提交范围：即使调用方加了 --force-dirty，
    // 也只提交我们生成的这一个文件，绝不把用户已经 staged 的无关改动一起带走。
    commitArgs.push('--only', '--', relFile);
  }

  // git 的环境变量优先级高于 -c user.email：
  //   - CI 里 vars 未配置时注入的是空字符串，空的 GIT_AUTHOR_EMAIL 会让 git 直接
  //     fatal: empty ident name，报错还完全看不出是变量没配；
  //   - 非空时会静默覆盖我们用 -c 指定的正确身份，刷出一堆不计入贡献图的提交。
  // 所以这里先把这 6 个变量全部清掉，再只设自己需要的。
  const commitEnv = { ...process.env };
  for (const key of [
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'GIT_COMMITTER_DATE',
  ]) {
    delete commitEnv[key];
  }
  if (isBackfill) {
    // 贡献图按 author date 归属，但只有 author/committer 日期一致才不会被判定为可疑历史，
    // 所以两个日期都设为目标日期。
    commitEnv.GIT_AUTHOR_DATE = commitIso;
    commitEnv.GIT_COMMITTER_DATE = commitIso;
  }

  const commitOut = git(cwd, commitArgs, { env: commitEnv });
  log(`${commitOut}\n`);

  const sha = gitSafe(cwd, ['rev-parse', 'HEAD']) || '';
  const actualAuthorEmail = gitSafe(cwd, ['log', '-1', '--format=%ae']) || '';
  const actualAuthorDate = gitSafe(cwd, ['log', '-1', '--format=%aI']) || '';

  // 提交后自检：身份被 hook / includeIf / 残留环境变量改写时，宁可停下也不要推上去。
  const classify = classifyEmail(actualAuthorEmail, { allowGitHubComEmail });
  if (actualAuthorEmail !== author.email || classify.blocked) {
    const reason = classify.blocked
      ? `实际 author email 是平台/机器人地址：${classify.reason}`
      : `期望 author email ${author.email}，实际 ${actualAuthorEmail}`;
    const err = new Error(
      [
        `提交后校验失败：${reason}`,
        '请检查是否有 git hook、includeIf 或残留的 GIT_AUTHOR_* 环境变量覆盖了身份。',
        `提交已产生但尚未推送（${sha.slice(0, 7)}）。确认后可自行撤销：git reset --soft HEAD~1`,
        '（本脚本不会替你执行任何改写历史的操作。）',
      ].join('\n')
    );
    err.code = 'AUTHOR_MISMATCH_AFTER_COMMIT';
    throw err;
  }

  // 8) Bounded retries; rejected updates never trigger force-push or history rewriting.
  const pushResult = noPush
    ? { pushed: false, pushError: null, pushAttempts: 0 }
    : await pushWithRetry(cwd, targetBranch, pushAttempts);
  const { pushed, pushError } = pushResult;
  if (pushError) notices.push(pushError);
  if (pushed) log(`已推送到 origin/${targetBranch}\n`);

  for (const n of notices) log(`! ${n}\n`);
  log(
    `完成：${action} ${sha.slice(0, 7)} ${targetDate} <${author.email}>${pushed ? ' 已推送' : noPush ? ' 未推送(--no-push)' : ''}\n`
  );

  return {
    code: pushError ? 1 : 0,
    summary: buildSummary({ sha, ...pushResult, actualAuthorDate }),
  };

  function buildSummary(extra = {}) {
    return {
      ok: !extra.pushError,
      action,
      date: targetDate,
      tz,
      backfill: isBackfill,
      file: relFile,
      fileExistedBefore: fileExists,
      branch: targetBranch || null,
      defaultBranch: defaultBranch || null,
      trigger,
      author: { name: author.name, email: author.email, source: author.source },
      sha: extra.sha || null,
      authorDate: extra.actualAuthorDate || null,
      pushed: extra.pushed ?? false,
      pushError: extra.pushError || null,
      pushAttempts: extra.pushAttempts || 0,
      pendingCount: extra.pendingCount || 0,
      dryRun,
      notices,
      content: digest ? { version: 1, cards: digest.snapshot.learning.cards, projects: digest.snapshot.projects.length,
        nodejsVersion: digest.snapshot.nodejs?.version || null, sources: digest.sources.length } : null,
    };
  }
}

/* -------------------------------- CLI -------------------------------- */

async function main() {
  const argv = process.argv.slice(2);
  const wantsJson = argv.includes('--json');
  let summaryOut = null;
  const soIdx = argv.indexOf('--summary-out');
  if (soIdx !== -1 && argv[soIdx + 1] && !argv[soIdx + 1].startsWith('--')) summaryOut = argv[soIdx + 1];

  try {
    const { code, summary } = await run(argv);
    if (summary && summaryOut) {
      mkdirSync(path.dirname(path.resolve(summaryOut)), { recursive: true });
      writeFileSync(path.resolve(summaryOut), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    }
    if (summary && wantsJson) process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = code;
  } catch (err) {
    process.stderr.write(`\n[auto-commit] 失败：${err.message}\n`);
    if (err.code) process.stderr.write(`[auto-commit] 错误码：${err.code}\n`);
    const failed = { ok: false, error: err.message, code: err.code || 'ERROR' };
    if (summaryOut) {
      try {
        mkdirSync(path.dirname(path.resolve(summaryOut)), { recursive: true });
        writeFileSync(path.resolve(summaryOut), `${JSON.stringify(failed, null, 2)}\n`, 'utf8');
      } catch {
        /* 摘要写不进去不应该掩盖真实错误 */
      }
    }
    if (wantsJson) process.stdout.write(`${JSON.stringify(failed)}\n`);
    process.exitCode = 1;
  }
}

main();
