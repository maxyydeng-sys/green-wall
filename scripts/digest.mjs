import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { failure, safeDataFile } from './repository.mjs';

export const contentDefaults = {
  learning: { enabled: false, notesDir: 'notes' },
  projects: { enabled: false, repositories: [] },
  publicData: { enabled: false, nodejsRelease: true },
};

export function validateContent(value = {}, cwd) {
  const invalid = message => { throw failure('INVALID_CONFIG', `content：${message}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('必须是对象');
  for (const key of Object.keys(value)) if (!Object.hasOwn(contentDefaults, key)) invalid(`未知字段 ${key}`);
  const result = {};
  for (const [key, base] of Object.entries(contentDefaults)) {
    const input = value[key] === undefined ? {} : value[key];
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid(`${key} 必须是对象`);
    for (const name of Object.keys(input)) if (!Object.hasOwn(base, name)) invalid(`未知字段 ${key}.${name}`);
    result[key] = { ...base, ...input };
    if (typeof result[key].enabled !== 'boolean') invalid(`${key}.enabled 必须为布尔值`);
  }
  const { notesDir } = result.learning;
  if (typeof notesDir !== 'string' || !notesDir || path.isAbsolute(notesDir)) invalid('learning.notesDir 必须是仓库内相对路径');
  safeDataFile(cwd, notesDir, '2000-01-01');
  const repos = result.projects.repositories;
  if (!Array.isArray(repos) || repos.length > 10 || repos.some(repo => typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes('..'))) invalid('projects.repositories 必须是最多 10 个 owner/repo');
  if (result.projects.enabled && !repos.length) invalid('启用 projects 时必须填写 repositories');
  if (typeof result.publicData.nodejsRelease !== 'boolean') invalid('publicData.nodejsRelease 必须为布尔值');
  return result;
}

export function calendarDate(value) {
  const time = Date.parse(`${value}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw failure('INVALID_DATE', '--date 必须是实际存在的 YYYY-MM-DD 日期');
  }
  return value;
}

export function localDay(date, timezone) {
  calendarDate(date);
  function midnight(wall) {
    let guess = wall;
    for (let i = 0; i < 4; i += 1) {
      const offset = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'longOffset' }).formatToParts(new Date(guess)).find(p => p.type === 'timeZoneName').value;
      const m = /GMT([+-])(\d\d):(\d\d)/.exec(offset);
      const minutes = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
      const next = wall - minutes * 60000;
      if (guess === next) break;
      guess = next;
    }
    return new Date(guess).toISOString();
  }
  const wall = Date.parse(`${date}T00:00:00Z`);
  return { start: midnight(wall), end: midnight(wall + 86400000) };
}

const inline = value => String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/[\\`*_\[\]<>|]/g, '\\$&');
const hash = value => createHash('sha256').update(value).digest('hex');
const number = value => Number.isInteger(value) && value >= 0;

function rebaseLinks(markdown, sourceFile, reportFile) {
  let fence = false;
  return markdown.split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return line; }
    if (fence) return line;
    return line.replace(/(!?\[[^\]\n]*\]\()([^\s)]+)(\))/g, (full, before, url, after) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(url)) return full;
      const [, destination, suffix = ''] = /^([^?#]*)(.*)$/.exec(url);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), destination));
      return `${before}${path.posix.relative(path.posix.dirname(reportFile), target)}${suffix}${after}`;
    });
  }).join('\n');
}

function learningInput(cwd, date, config, dataDir) {
  if (!config.enabled) return { status: 'disabled' };
  const file = safeDataFile(cwd, config.notesDir, date);
  if (!existsSync(file.absolute)) return { status: 'missing', path: file.relative, cards: [], tasks: [] };
  if (!statSync(file.absolute).isFile() || statSync(file.absolute).size > 65536) throw failure('INVALID_NOTES', '学习笔记必须是 64 KiB 以内的 Markdown 文件');
  const text = readFileSync(file.absolute, 'utf8');
  const lines = text.split(/\r?\n/);
  const cards = [], tasks = [];
  let question = null, fence = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const q = /^Q[:：]\s*(.+)$/.exec(lines[i]);
    const a = /^A[:：]\s*(.+)$/.exec(lines[i]);
    const task = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(lines[i]);
    if (q) question = { question: q[1], line: i + 1 };
    if (a && question) { cards.push({ ...question, answer: a[1] }); question = null; }
    if (task) tasks.push({ done: task[1] !== ' ', text: task[2], line: i + 1 });
  }
  const section = /(?:^|\n)##[ \t]+学习笔记[ \t]*\n([\s\S]*?)(?=\n##[ \t]|$)/.exec(text)?.[1]?.trim();
  const reportFile = safeDataFile(cwd, dataDir, date);
  const summary = rebaseLinks((section ?? text.trim()).slice(0, 12000), file.relative, reportFile.relative);
  const reportDir = path.dirname(reportFile.absolute);
  return { status: 'ok', path: file.relative, link: path.relative(reportDir, file.absolute).split(path.sep).join('/'),
    sha256: hash(text), summary, cards, tasks, truncated: (section ?? text).length > 12000 };
}

export function parseSnapshot(markdown) {
  const raw = /<!-- green-wall:snapshot:v1 -->\n```json\n([\s\S]*?)\n```/.exec(markdown)?.[1]
    || /<!-- green-wall:snapshot:v1\n([\s\S]*?)\n-->/.exec(markdown)?.[1];
  if (!raw || raw.length > 200000) return null;
  try { const data = JSON.parse(raw); return data?.version === 1 && /^\d{4}-\d{2}-\d{2}$/.test(data.date) ? data : null; }
  catch { return null; }
}

function previousSnapshot(cwd, date, dataDir) {
  const dir = path.dirname(safeDataFile(cwd, dataDir, date).absolute);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name) && name.slice(0, 10) < date).sort().reverse().slice(0, 366);
  for (const name of files) {
    const file = safeDataFile(cwd, dataDir, name.slice(0, 10)).absolute;
    if (statSync(file).size > 250000) continue;
    const data = parseSnapshot(readFileSync(file, 'utf8'));
    if (data && data.date === name.slice(0, 10)) return data;
  }
  return null;
}

function apiClient(fetchImpl) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'green-wall-daily-digest', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return async function request(endpoint) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response;
      try { response = await fetchImpl(`https://api.github.com${endpoint}`, { headers, redirect: 'error', signal: AbortSignal.timeout(8000) }); }
      catch {
        if (!attempt) continue;
        throw failure('DIGEST_SOURCE_FAILED', 'GitHub API 网络请求失败或超时');
      }
      if (response.status >= 500 && !attempt) continue;
      if (!response.ok) throw failure('DIGEST_SOURCE_FAILED', `GitHub API HTTP ${response.status}；请检查来源、权限或限额`);
      const body = await response.text();
      if (body.length > 2000000) throw failure('DIGEST_SOURCE_FAILED', 'GitHub API 响应超过大小限制');
      try { return { data: JSON.parse(body), truncated: /rel="next"/.test(response.headers.get('link') || '') }; }
      catch { throw failure('DIGEST_SOURCE_FAILED', 'GitHub API 返回了无法解析的数据'); }
    }
  };
}

async function projectSnapshot(repo, request, period) {
  const base = `/repos/${repo}`;
  const { data: meta } = await request(base);
  if (meta.private !== false) throw failure('DIGEST_SOURCE_FAILED', '只归档公开仓库；来源不可确认公开');
  if (!number(meta.stargazers_count) || !number(meta.forks_count) || !number(meta.open_issues_count)) throw failure('DIGEST_SOURCE_FAILED', '仓库统计字段不完整');
  const query = new URLSearchParams({ since: period.start, until: new Date(Date.parse(period.end) - 1).toISOString(), per_page: '100' });
  const [commits, open, closed] = await Promise.all([
    request(`${base}/commits?${query}`), request(`${base}/issues?state=open&per_page=100`),
    request(`${base}/issues?state=closed&since=${encodeURIComponent(period.start)}&per_page=100`),
  ]);
  if (![commits.data, open.data, closed.data].every(Array.isArray)) throw failure('DIGEST_SOURCE_FAILED', '项目活动接口未返回列表');
  const inDay = value => value && Date.parse(value) >= Date.parse(period.start) && Date.parse(value) < Date.parse(period.end);
  const actual = commits.data.filter(c => inDay(c.commit?.committer?.date));
  const issues = open.data.filter(i => !i.pull_request);
  const pulls = open.data.filter(i => i.pull_request);
  return { status: 'ok', repository: repo, url: `https://github.com/${repo}`, stars: meta.stargazers_count, forks: meta.forks_count,
    openItems: meta.open_issues_count, openIssues: issues.length, openPullRequests: pulls.length, openTruncated: open.truncated,
    commits: actual.length, automaticCommits: actual.filter(c => c.commit.message.startsWith('[auto]')).length,
    developmentCommits: actual.filter(c => !c.commit.message.startsWith('[auto]')).length, commitsTruncated: commits.truncated,
    closedIssues: closed.data.filter(i => !i.pull_request && inDay(i.closed_at)).length, closedTruncated: closed.truncated,
    recentCommits: actual.filter(c => !c.commit.message.startsWith('[auto]')).slice(0, 10).map(c => ({ sha: String(c.sha).slice(0, 7), title: String(c.commit.message).split('\n')[0] })),
    todo: issues.slice(0, 20).map(i => ({ number: i.number, title: i.title, updatedAt: i.updated_at })),
    sources: [`https://api.github.com${base}`, `https://api.github.com${base}/commits?${query}`, `https://api.github.com${base}/issues?state=open&per_page=100`, `https://api.github.com${base}/issues?state=closed&since=${encodeURIComponent(period.start)}&per_page=100`] };
}

async function nodeSnapshot(request) {
  const { data } = await request('/repos/nodejs/node/releases/latest');
  if (typeof data.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(data.tag_name) || data.draft !== false || data.prerelease !== false || !data.published_at || !Number.isFinite(Date.parse(data.published_at))) throw failure('DIGEST_SOURCE_FAILED', 'Node.js 发布信息字段不完整');
  return { status: 'ok', repository: 'nodejs/node', version: data.tag_name, publishedAt: data.published_at,
    url: `https://github.com/nodejs/node/releases/tag/${encodeURIComponent(data.tag_name)}`, source: 'https://api.github.com/repos/nodejs/node/releases/latest' };
}

export function requireCompleteDigest(digest) {
  if (digest.errors.length) throw failure('DIGEST_SOURCE_FAILED', `日报数据源采集失败，未生成或提交记录：${digest.errors.join('；')}。稍后重跑即可。`);
  return digest;
}

export async function buildDailyDigest({ cwd, date, timezone = 'Asia/Shanghai', dataDir = 'data/daily', content = {}, now = new Date(), fetchImpl = fetch, previous }) {
  const config = validateContent(content, cwd);
  const period = localDay(date, timezone);
  const baseline = previous === undefined ? previousSnapshot(cwd, date, dataDir) : previous;
  const request = apiClient(fetchImpl);
  const errors = [];
  const learning = learningInput(cwd, date, config.learning, dataDir);
  const projects = await Promise.all((config.projects.enabled ? config.projects.repositories : []).map(async repository => {
    try { return await projectSnapshot(repository, request, period); }
    catch (error) { errors.push(`${repository}：${error.message}`); return { status: 'unavailable', repository }; }
  }));
  let nodejs = null;
  if (config.publicData.enabled && config.publicData.nodejsRelease) {
    try { nodejs = await nodeSnapshot(request); }
    catch (error) { errors.push(`Node.js：${error.message}`); nodejs = { status: 'unavailable' }; }
  }
  const snapshot = { version: 1, date, timezone, observedAt: now.toISOString(), period,
    learning: { status: learning.status, path: learning.path || null, sha256: learning.sha256 || null, cards: learning.cards?.length || 0,
      tasksDone: learning.tasks?.filter(t => t.done).length || 0, tasksOpen: learning.tasks?.filter(t => !t.done).length || 0 }, projects, nodejs };
  const lines = [`## 每日资料 · ${date}`, '', `- 采集时间：${snapshot.observedAt}`, `- 项目提交窗口：${period.start} 至 ${period.end}（${timezone} 自然日）`,
    '- Issue、仓库统计与 Node.js 版本是采集时快照；回填不代表还原历史状态。',
    '- 提交统计采集于本条日报生成前，不包含本次尚未生成的提交。', `- 对比基线：${baseline?.date || '暂无，首次建立快照'}`, ''];

  lines.push('### 学习积累', '');
  if (learning.status === 'ok') {
    lines.push(`来源：[${inline(learning.path)}](${learning.link})`, '', learning.summary || '学习正文尚未填写。', '');
    if (learning.truncated) lines.push('正文超过展示上限，请查看来源文件。', '');
    lines.push('#### 知识卡片', '');
    if (!learning.cards.length) lines.push('没有可提取的 Q:/A: 问答；系统不会编造知识卡片。', '');
    else for (const [i, card] of learning.cards.slice(0, 20).entries()) lines.push(`${i + 1}. **问：${inline(card.question)}**`, `   答：${inline(card.answer)}`, `   来源：${inline(learning.path)} 第 ${card.line} 行`, '');
    lines.push(`笔记待办：已完成 ${snapshot.learning.tasksDone} 项，待处理 ${snapshot.learning.tasksOpen} 项。`, '');
  } else lines.push(learning.status === 'missing' ? `当天尚无学习输入：\`${learning.path}\`。可用 \`./green-wall note\` 创建并填写。` : '学习来源未启用。', '');

  lines.push('### 项目管理', '');
  if (!projects.length) lines.push('项目来源未启用。', '');
  for (const project of projects) {
    lines.push(`#### ${inline(project.repository)}`, '');
    if (project.status !== 'ok') { lines.push('来源采集失败，数量未知。', ''); continue; }
    const old = Array.isArray(baseline?.projects) ? baseline.projects.find(p => p.repository === project.repository && p.status === 'ok') : null;
    const change = (value, before) => number(before) ? `${value - before >= 0 ? '+' : ''}${value - before}` : '首次快照';
    const atLeast = (value, truncated) => `${truncated ? '至少 ' : ''}${value}`;
    lines.push('| 指标 | 当前值 |', '| --- | --- |',
      `| 当日非自动记录提交 | ${atLeast(project.developmentCommits, project.commitsTruncated)} |`,
      `| 当日自动记录提交 | ${atLeast(project.automaticCommits, project.commitsTruncated)} |`,
      `| 当前未关闭 Issue | ${atLeast(project.openIssues, project.openTruncated)}（较基线 ${project.openTruncated || old?.openTruncated ? '分页不足，不比较' : change(project.openIssues, old?.openIssues)}） |`,
      `| 当前未关闭 PR | ${atLeast(project.openPullRequests, project.openTruncated)} |`,
      `| 当日关闭 Issue | ${atLeast(project.closedIssues, project.closedTruncated)} |`,
      `| Star / Fork | ${project.stars} / ${project.forks}（较基线 ${change(project.stars, old?.stars)} / ${change(project.forks, old?.forks)}） |`, '');
    if (project.recentCommits.length) {
      lines.push('最近非自动记录更新（最多 10 条）：', '');
      for (const commit of project.recentCommits) lines.push(`- [${inline(commit.sha)}](${project.url}/commit/${commit.sha}) ${inline(commit.title)}`);
      lines.push('');
    }
    lines.push('待处理 Issue（最多 20 条）：', '');
    if (!project.todo.length) lines.push(project.openTruncated ? '本页未返回普通 Issue，请查看完整列表。' : '暂无待处理 Issue。');
    for (const issue of project.todo) lines.push(`- [#${issue.number}](${project.url}/issues/${issue.number}) ${inline(issue.title)}`);
    lines.push('', `[完整项目活动](${project.url}/activity) · [Issue 列表](${project.url}/issues)`, '');
    if (project.openTruncated || project.commitsTruncated || project.closedTruncated) lines.push('接口分页已达本次上限，相关计数为下界；完整数据请查看源站。', '');
  }

  lines.push('### 公开数据归档', '');
  if (nodejs?.status === 'ok') {
    const oldVersion = baseline?.nodejs?.status === 'ok' ? baseline.nodejs.version : null;
    lines.push(`- Node.js 最新非预发布 Release：[${inline(nodejs.version)}](${nodejs.url})`, `- 发布时间：${nodejs.publishedAt}`,
      `- 较基线：${oldVersion ? oldVersion === nodejs.version ? '版本未变化' : `${inline(oldVersion)} → ${inline(nodejs.version)}` : '首次快照'}`,
      '- 此项是 GitHub Latest Release，不等于专门筛选 LTS，也不代表本项目已自动升级。', '');
  } else lines.push(nodejs ? 'Node.js 来源采集失败，版本未知。' : '公开数据来源未启用。', '');
  if (errors.length) lines.push('### 采集问题', '', ...errors.map(error => `- ${inline(error)}`), '');
  const sources = [...new Set([...projects.flatMap(p => p.sources || []), ...(nodejs?.source ? [nodejs.source] : [])])];
  if (sources.length) lines.push('### 数据来源', '', ...sources.map(url => `- <${url}>`), '');
  // Store only selected public fields, never API response bodies, headers or tokens.
  const raw = JSON.stringify(snapshot, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  lines.push('<details>', '<summary>结构化快照（供后续日期比较）</summary>', '', '<!-- green-wall:snapshot:v1 -->', '```json', raw, '```', '', '</details>', '');
  return { markdown: lines.join('\n'), snapshot, errors, sources };
}
