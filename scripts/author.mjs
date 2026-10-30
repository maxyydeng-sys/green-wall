#!/usr/bin/env node
/**
 * author.mjs —— 提交身份（author name / email）解析与校验。
 *
 * 这是整个项目里最关键的一个文件：GitHub 是否把一次提交计入你的贡献图，
 * 完全取决于 commit 的 author email 是不是你账号里「已验证的邮箱」。
 * 用平台/机器人邮箱提交，push 会成功、Actions 会变绿，
 * 但你的贡献图一个格子都不会亮——而且你可能几周后才发现。
 *
 * 零第三方依赖，Node >= 20。
 *
 * 三种用法：
 *   1. 被 auto-commit.mjs import
 *   2. `node scripts/author.mjs --actor <login>`      # 只解析并打印，CI 里做前置体检
 *   3. `node scripts/author.mjs --verify-last-commit` # 校验最近一次提交的归属是否安全
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * 机器人 / 平台邮箱判定。
 *
 * 这里宁可误杀也不要漏放：漏放的后果是「静默刷出一堆不绿的提交」，
 * 误杀的后果只是一条明确的报错，用户改一下配置就好。
 *
 * 规则分三层：
 *   1) 整个 @github.com 域一律拒绝。GitHub 自己的服务账号（actions@、support@、
 *      no-reply@、notifications@、security@、dependabot@、copilot@ …）全在这个域下，
 *      逐个列举必然漏。真人里只有 GitHub 员工持有该域邮箱，为他们留了显式逃生舱。
 *   2) 任何含 [bot] 的地址一律拒绝（GitHub App 的标准形态）。
 *   3) @users.noreply.github.com 的 local part 含 bot / actions / dependabot /
 *      copilot / renovate / ci 等词时拒绝——这类地址不可能计入个人贡献图。
 */
const GITHUB_COM_DOMAIN = /@github\.com$/i;
const BOT_TOKEN_IN_LOCAL = /\[bot\]/i;
const NOREPLY_DOMAIN = /@users\.noreply\.github\.com$/i;
const NOREPLY_BOT_LOCAL =
  /(?:^|[+._-])(?:bots?|dependabot|copilot|actions?|renovate|greenkeeper|netlify|vercel|ci|cd|automation|robot|sre)(?:$|[._-]|\[)/i;

/** 形如 1234567+username@users.noreply.github.com 的新式别名邮箱（推荐）。 */
const ID_NOREPLY_RE = /^\d+\+[^\s@]+@users\.noreply\.github\.com$/i;

/** 形如 username@users.noreply.github.com 的旧式别名邮箱。 */
const LEGACY_NOREPLY_RE = /^[^\s@]+@users\.noreply\.github\.com$/i;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ESCAPE_HATCH_HINT =
  '如果你确实是 GitHub 员工、要用 @github.com 的企业邮箱，' +
  '加 --allow-github-com-email（或设 GREEN_WALL_ALLOW_GITHUB_COM=1）跳过这条拦截。';

export function looksLikeEmail(value) {
  return typeof value === 'string' && EMAIL_RE.test(value.trim());
}

/**
 * 判定一个邮箱是否会导致「提交不计入贡献图」。
 * @returns {{blocked: boolean, reason: string|null}}
 */
export function classifyEmail(value, { allowGitHubComEmail = false } = {}) {
  if (typeof value !== 'string') return { blocked: true, reason: '邮箱为空' };
  const email = value.trim();
  const lower = email.toLowerCase();
  const local = lower.split('@')[0] || '';

  if (BOT_TOKEN_IN_LOCAL.test(lower)) {
    return { blocked: true, reason: `"${email}" 是 GitHub App 的机器人地址，提交不会计入贡献图。` };
  }
  if (GITHUB_COM_DOMAIN.test(lower)) {
    if (allowGitHubComEmail) return { blocked: false, reason: null };
    return {
      blocked: true,
      reason: `"${email}" 属于 @github.com 域，默认拦截平台地址。${ESCAPE_HATCH_HINT}`,
    };
  }
  if (NOREPLY_DOMAIN.test(lower) && NOREPLY_BOT_LOCAL.test(local)) {
    return {
      blocked: true,
      reason: `"${email}" 看起来是自动化账号的 noreply 别名（local part 含机器人特征词），提交不会计入个人贡献图。`,
    };
  }
  return { blocked: false, reason: null };
}

/** 兼容旧调用：只回答「是不是会被拦截」。 */
export function isBotEmail(value, options) {
  return classifyEmail(value, options).blocked;
}

/** 返回一段人类可读的邮箱风险提示；没有风险时 level 为 ok。 */
export function inspectEmail(value, options) {
  const classification = classifyEmail(value, options);
  if (!looksLikeEmail(value)) {
    return { level: 'error', message: `"${value}" 不是合法的邮箱格式` };
  }
  if (classification.blocked) {
    return { level: 'error', message: classification.reason };
  }
  const email = String(value).trim();
  if (ID_NOREPLY_RE.test(email)) {
    return { level: 'ok', message: 'ID 别名邮箱格式；仍需确认这是你 GitHub Settings → Emails 中的地址' };
  }
  if (LEGACY_NOREPLY_RE.test(email)) {
    return {
      level: 'warn',
      message:
        '这是旧式 noreply 别名。只有当它确实出现在你 GitHub 账号 Settings → Emails 的已验证列表里时才会被计入；' +
        '否则请换成 <数字ID>+<用户名>@users.noreply.github.com',
    };
  }
  return {
    level: 'warn',
    message:
      '这是你的真实邮箱。它必须已在 GitHub Settings → Emails 里验证过，提交才会计入贡献图',
  };
}

function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'green-wall-auto-commit',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  // GitHub 托管 runner 的出口 IP 是共享的，匿名请求只有 60 次/小时，很容易 403。
  // workflow 里注入 GITHUB_TOKEN 后可以提到 5000 次/小时。token 只用于这一个 GET，不打印、不落盘。
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_API_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * 从 GitHub 公开 API 推导 actor 的 ID 别名邮箱：<数字ID>+<用户名>@users.noreply.github.com。
 *
 * 为什么不是「从事件流里反查历史提交的邮箱」：GitHub 的 /events/public 早已不再返回
 * payload.commits（PushEvent 的 payload 现在只有 repository_id / push_id / ref / head / before），
 * 那条路是死路。账号 ID 是公开且稳定的，别名邮箱格式也是固定的，所以直接推导更可靠。
 *
 * 注意：2017 年前注册的老账号，Settings → Emails 里显示的可能是**不带 ID** 的
 * <用户名>@users.noreply.github.com。推导结果只是兜底，调用方必须把它当「待确认」处理。
 *
 * @returns {Promise<{email: string|null, error: string|null}>} 永不抛错
 */
export async function deriveActorEmail(actor) {
  if (!actor || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(actor)) {
    return { email: null, error: `GitHub 用户名 "${actor}" 不合法` };
  }
  const url = `https://api.github.com/users/${encodeURIComponent(actor)}`;
  try {
    const res = await fetch(url, { headers: githubHeaders(), signal: AbortSignal.timeout(8000) });
    if (res.status === 403 || res.status === 429) {
      return { email: null, error: `GitHub API 限流或拒绝（HTTP ${res.status}）；在 Actions 里注入 GITHUB_TOKEN 可解决` };
    }
    if (!res.ok) {
      return { email: null, error: `GitHub API 返回 HTTP ${res.status}（账号不存在？）` };
    }
    const user = await res.json();
    if (typeof user?.id !== 'number' || typeof user?.login !== 'string') {
      return { email: null, error: 'GitHub API 返回结构异常' };
    }
    return { email: `${user.id}+${user.login}@users.noreply.github.com`, error: null };
  } catch (err) {
    return { email: null, error: `请求 GitHub API 失败：${err?.message || err}` };
  }
}

const HOW_TO_FIND_EMAIL = [
  '如何拿到正确的 author email：',
  '  1. 打开 https://github.com/settings/emails',
  '  2. 找到形如 12345678+yourname@users.noreply.github.com 的那一行（Primary 区块下）',
  '  3. 复制它，填到仓库 Settings → Secrets and variables → Actions → Variables：',
  '       GIT_AUTHOR_EMAIL = 12345678+yourname@users.noreply.github.com',
  '       GIT_AUTHOR_NAME  = yourname',
  '  本地运行也可以直接用环境变量或 --author-email 参数传入。',
].join('\n');

/**
 * 解析出本次提交要用的 author 身份。
 * 优先级：显式参数 > 环境变量 > 按账号 ID 从 GitHub API 推导 > 报错。
 *
 * @returns {Promise<{name: string, email: string, source: string, notices: string[], warnings: string[]}>}
 */
export async function resolveAuthor(options = {}) {
  const {
    name,
    email,
    actor = process.env.GITHUB_ACTOR || '',
    allowFallback = true,
    allowGitHubComEmail = process.env.GREEN_WALL_ALLOW_GITHUB_COM === '1',
    cwd = process.cwd(),
  } = options;

  const notices = [];
  const warnings = [];
  let resolvedName = (name || process.env.GIT_AUTHOR_NAME || '').trim();
  let resolvedEmail = (email || process.env.GIT_AUTHOR_EMAIL || '').trim();
  let source = 'explicit';

  if (!resolvedEmail && allowFallback && actor) {
    const { email: derived, error } = await deriveActorEmail(actor);
    if (derived) {
      resolvedEmail = derived;
      source = 'github-api-derived';
      warnings.push(
        `未配置 GIT_AUTHOR_EMAIL，已根据 GitHub 账号 @${actor} 的数字 ID 推导出 ${derived}。` +
          '请到 Settings → Emails 确认这个地址在你的已验证邮箱列表里——' +
          '2017 年前注册的老账号，正确形式可能是不带 ID 的 <用户名>@users.noreply.github.com。' +
          '确认后仍建议把 GIT_AUTHOR_EMAIL 显式配成仓库变量，不要依赖网络推导。'
      );
    } else if (error) {
      notices.push(`按账号 ID 推导邮箱失败：${error}`);
    }
  }

  if (!resolvedName) {
    resolvedName = actor || tryGit(cwd, ['config', 'user.name']) || 'green-wall';
    notices.push(`未配置 GIT_AUTHOR_NAME，回退为 "${resolvedName}"`);
  }

  if (!resolvedEmail) {
    const err = new Error(
      `无法确定提交身份：GIT_AUTHOR_EMAIL 未配置${actor ? `，且无法从 GitHub API 推导出 @${actor} 的别名邮箱` : ''}。\n\n${HOW_TO_FIND_EMAIL}`
    );
    err.code = 'AUTHOR_UNRESOLVED';
    throw err;
  }

  const inspection = inspectEmail(resolvedEmail, { allowGitHubComEmail });
  if (inspection.level === 'error') {
    const err = new Error(`author email 校验失败：${inspection.message}\n\n${HOW_TO_FIND_EMAIL}`);
    err.code = 'AUTHOR_REJECTED';
    throw err;
  }
  if (inspection.level === 'warn') warnings.push(inspection.message);

  return { name: resolvedName, email: resolvedEmail, source, notices, warnings };
}

function tryGit(cwd, args) {
  try {
    return git(args, cwd);
  } catch {
    return '';
  }
}

/**
 * 校验仓库最近一次提交的 author 是否安全（不是平台/机器人邮箱）。
 * CI 的最后一步用它兜底：宁可 workflow 变红，也不要静默刷出一堆不计入贡献图的提交。
 *
 * 用 %x1f（单元分隔符）做字段分隔，避免 author name 里含 tab 时串位。
 */
export function verifyLastCommit({ cwd = process.cwd(), ref = 'HEAD', allowGitHubComEmail = false } = {}) {
  const raw = git(['log', '-1', '--format=%an%x1f%ae%x1f%cn%x1f%ce%x1f%s', ref], cwd);
  const [name, email, committerName, committerEmail, subject] = raw.split('\u001f');
  const problems = [];
  if (!looksLikeEmail(email)) problems.push(`author email 非法：${email}`);
  const classification = classifyEmail(email, { allowGitHubComEmail });
  if (classification.blocked) {
    problems.push(`author email 会被 GitHub 判为平台/机器人地址，提交不计入贡献图：${classification.reason}`);
  }
  return {
    ok: problems.length === 0,
    name,
    email,
    committerName,
    committerEmail,
    subject,
    problems,
  };
}

/* ------------------------------- CLI ------------------------------- */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allowGitHubComEmail =
    args['allow-github-com-email'] === true || process.env.GREEN_WALL_ALLOW_GITHUB_COM === '1';

  if (args.help) {
    process.stdout.write(
      [
        '用法：',
        '  node scripts/author.mjs [--actor <login>] [--author-name <n>] [--author-email <e>] [--strict] [--json]',
        '  node scripts/author.mjs --verify-last-commit [--cwd <dir>]',
        '',
        '选项：',
        '  --actor                GitHub 用户名，用于按账号 ID 推导别名邮箱（CI 里传 github.actor）',
        '  --author-name          显式指定提交者名，优先级最高',
        '  --author-email         显式指定提交者邮箱，优先级最高',
        '  --no-fallback          禁止调用 GitHub API 推导，只认显式配置',
        '  --allow-github-com-email  放行 @github.com 邮箱（仅供 GitHub 员工使用）',
        '  --strict               出现 warn 级别提示时以退出码 1 结束（info 级别提示不算）',
        '  --json                 以 JSON 输出，便于脚本消费',
        '  --verify-last-commit   校验最近一次提交的归属，失败则退出码 1',
        '',
        '环境变量：GITHUB_TOKEN / GITHUB_API_TOKEN（提高 GitHub API 限额）、',
        '          GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL、GREEN_WALL_ALLOW_GITHUB_COM=1',
      ].join('\n')
    );
    return 0;
  }

  if (args['verify-last-commit']) {
    const result = verifyLastCommit({ cwd: args.cwd || process.cwd(), allowGitHubComEmail });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.ok) {
      process.stdout.write(`归属校验通过：${result.name} <${result.email}>\n`);
      if (classifyEmail(result.committerEmail, { allowGitHubComEmail }).blocked) {
        process.stdout.write(
          `  ! committer 是 ${result.committerEmail}。GitHub 只按 author 归属贡献，所以不影响绿墙，但历史记录里会看到机器人作为提交者。\n`
        );
      }
    } else {
      process.stderr.write(`归属校验失败：\n${result.problems.map((p) => `  - ${p}`).join('\n')}\n`);
    }
    return result.ok ? 0 : 1;
  }

  try {
    const author = await resolveAuthor({
      name: typeof args['author-name'] === 'string' ? args['author-name'] : undefined,
      email: typeof args['author-email'] === 'string' ? args['author-email'] : undefined,
      actor: typeof args.actor === 'string' ? args.actor : undefined,
      allowFallback: args['no-fallback'] !== true,
      allowGitHubComEmail,
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(author, null, 2)}\n`);
    } else {
      process.stdout.write(`author: ${author.name} <${author.email}>  (来源: ${author.source})\n`);
      for (const n of author.notices) process.stdout.write(`  · ${n}\n`);
      for (const w of author.warnings) process.stdout.write(`  ! ${w}\n`);
    }
    if (args.strict && author.warnings.length > 0) return 1;
    return 0;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, code: err.code || 'ERROR' })}\n`);
    }
    return 1;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err?.stack || err}\n`);
      process.exit(1);
    }
  );
}
