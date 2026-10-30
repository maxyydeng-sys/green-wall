import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDailyDigest, parseSnapshot, requireCompleteDigest, validateContent, calendarDate, localDay } from './digest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const date = '2026-10-30';
const now = new Date('2026-10-30T07:00:00Z');
const content = { learning: { enabled: true, notesDir: 'notes' }, projects: { enabled: true, repositories: ['test/demo'] }, publicData: { enabled: true, nodejsRelease: true } };
const notes = '# Daily\n\n## 学习笔记\n\n- 先演练，再运行。\n\n## 知识卡片\n\nQ: 演练会提交吗？\nA: 不会提交。\n\n```text\nQ: 示例代码里的问答不算卡片？\nA: 不算。\n```\n\n## 待办\n\n- [x] 核对来源\n- [ ] 阅读发布说明\n';
const root = () => mkdtempSync(path.join(os.tmpdir(), 'green-wall-digest-'));
const input = cwd => {
  mkdirSync(path.join(cwd, 'notes'), { recursive: true });
  writeFileSync(path.join(cwd, 'notes', `${date}.md`), notes);
};
const response = (data, truncated = false) => new Response(JSON.stringify(data), { headers: truncated ? { link: '<https://api.github.com/next>; rel="next"' } : {} });
function fakeApi({ truncated = false, isPrivate = false, calls = [] } = {}) {
  return async (url, options) => {
    calls.push({ url, options });
    const u = new URL(url);
    assert.equal(u.origin, 'https://api.github.com');
    if (u.pathname === '/repos/test/demo') return response({ private: isPrivate, stargazers_count: 5, forks_count: 2, open_issues_count: 2 });
    if (u.pathname.endsWith('/commits')) return response([
      { sha: 'a'.repeat(40), commit: { message: 'feat: real progress', committer: { date: '2026-10-30T02:00:00Z' } } },
      { sha: 'b'.repeat(40), commit: { message: '[auto] daily record', committer: { date: '2026-10-30T03:00:00Z' } } },
      { sha: 'c'.repeat(40), commit: { message: 'outside selected day', committer: { date: '2026-10-29T15:00:00Z' } } },
    ], truncated);
    if (u.pathname.endsWith('/issues') && u.searchParams.get('state') === 'open') return response([
      { number: 1, title: 'fix | item <unsafe>', updated_at: now.toISOString() },
      { number: 2, title: 'a pull request', pull_request: {}, updated_at: now.toISOString() },
    ], truncated);
    if (u.pathname.endsWith('/issues')) return response([
      { number: 3, closed_at: '2026-10-30T02:00:00Z' },
      { number: 4, closed_at: '2026-10-30T03:00:00Z', pull_request: {} },
      { number: 5, closed_at: '2026-10-29T00:00:00Z' },
    ], truncated);
    if (u.pathname === '/repos/nodejs/node/releases/latest') return response({ tag_name: 'v24.1.0', draft: false, prerelease: false, published_at: '2026-10-29T08:00:00Z', body: 'must-not-be-archived', token: 'never-persist-this' });
    throw new Error('Unexpected request');
  };
}

test('learning extracts source-backed Q/A and checklists, ignoring fenced examples', async () => {
  const cwd = root(); input(cwd);
  const result = await buildDailyDigest({ cwd, date, now, content: { learning: content.learning }, fetchImpl: () => { throw new Error('No network expected'); } });
  assert.equal(result.snapshot.learning.cards, 1);
  assert.equal(result.snapshot.learning.tasksDone, 1);
  assert.equal(result.snapshot.learning.tasksOpen, 1);
  assert.match(result.markdown, /先演练，再运行/);
  assert.match(result.markdown, /来源：notes\/2026-10-30.md 第 9 行/);
  assert.doesNotMatch(result.markdown, /示例代码里的问答不算卡片/);
  assert.equal(parseSnapshot(result.markdown).learning.sha256.length, 64);
});

test('missing notes are explicit, never fabricated as learning', async () => {
  const cwd = root();
  const result = await buildDailyDigest({ cwd, date, now, content: { learning: content.learning } });
  assert.equal(result.snapshot.learning.status, 'missing');
  assert.equal(result.snapshot.learning.cards, 0);
  assert.match(result.markdown, /当天尚无学习输入/);
  assert.deepEqual(result.errors, []);
});

test('project reports separate PRs, auto commits, real updates and time windows', async () => {
  const cwd = root(); input(cwd);
  const calls = [];
  const result = requireCompleteDigest(await buildDailyDigest({ cwd, date, now, content, fetchImpl: fakeApi({ calls }) }));
  const p = result.snapshot.projects[0];
  assert.equal(p.openIssues, 1); assert.equal(p.openPullRequests, 1);
  assert.equal(p.closedIssues, 1); assert.equal(p.developmentCommits, 1); assert.equal(p.automaticCommits, 1);
  assert.equal(p.recentCommits.length, 1);
  assert.match(result.markdown, /fix \\\| item \\<unsafe\\>/);
  assert.equal(result.snapshot.period.start, '2026-10-29T16:00:00.000Z');
  assert.equal(new URL(calls.find(c => c.url.includes('/commits?')).url).searchParams.get('until'), '2026-10-30T15:59:59.999Z');
  assert.ok(calls.every(c => c.options.redirect === 'error'));
  assert.doesNotMatch(result.markdown, /must-not-be-archived|never-persist-this/);
});

test('relative links are rebased from notes to the daily report directory', async () => {
  const cwd = root(); input(cwd);
  writeFileSync(path.join(cwd, 'notes', `${date}.md`), '# Daily\n\n## 学习笔记\n\n[配置](../green-wall.config.json) [站点](https://example.com)\n');
  const result = await buildDailyDigest({ cwd, date, now, content: { learning: content.learning } });
  assert.match(result.markdown, /\[配置\]\(\.\.\/\.\.\/green-wall.config.json\)/);
  assert.match(result.markdown, /\[站点\]\(https:\/\/example.com\)/);
});

test('structured snapshots compare against the latest earlier record and preserve provenance', async () => {
  const cwd = root();
  mkdirSync(path.join(cwd, 'data/daily'), { recursive: true });
  const old = { version: 1, date: '2026-10-29', projects: [{ repository: 'test/demo', status: 'ok', stars: 3, forks: 1 }], nodejs: { status: 'ok', version: 'v24.0.0' } };
  const file = path.join(cwd, 'data/daily/2026-10-29.md');
  const before = `# prior\n<!-- green-wall:snapshot:v1\n${JSON.stringify(old)}\n-->\n`;
  writeFileSync(file, before);
  const result = await buildDailyDigest({ cwd, date, now, content, fetchImpl: fakeApi() });
  assert.match(result.markdown, /对比基线：2026-10-29/);
  assert.match(result.markdown, /较基线 \+2 \/ \+1/);
  assert.match(result.markdown, /v24.0.0 → v24.1.0/);
  assert.equal(parseSnapshot(result.markdown).nodejs.version, 'v24.1.0');
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(result.sources.length, 5);
});

test('pagination limits produce lower bounds rather than false exact counts', async () => {
  const result = await buildDailyDigest({ cwd: root(), date, now, content, fetchImpl: fakeApi({ truncated: true }) });
  assert.equal(result.snapshot.projects[0].openTruncated, true);
  assert.match(result.markdown, /至少 1/);
  assert.match(result.markdown, /计数为下界/);
});

test('failed sources do not masquerade as zero activity or allow a commit', async () => {
  const cwd = root(); let calls = 0;
  const result = await buildDailyDigest({ cwd, date, now, content, fetchImpl: async () => { calls += 1; return new Response('do-not-leak-body', { status: 503 }); } });
  assert.equal(result.errors.length, 2); assert.equal(calls, 4);
  assert.equal(result.snapshot.projects[0].status, 'unavailable');
  assert.equal(result.snapshot.nodejs.status, 'unavailable');
  assert.throws(() => requireCompleteDigest(result), { code: 'DIGEST_SOURCE_FAILED' });
  assert.doesNotMatch(result.markdown, /do-not-leak-body/);
  assert.deepEqual(readdirSync(cwd), []);
});

test('private sources and malformed API responses are refused without exporting content', async () => {
  const privateResult = await buildDailyDigest({ cwd: root(), date, now, content: { projects: content.projects }, fetchImpl: fakeApi({ isPrivate: true }) });
  assert.equal(privateResult.snapshot.projects[0].status, 'unavailable');
  assert.match(privateResult.errors[0], /只归档公开仓库/);
  const broken = await buildDailyDigest({ cwd: root(), date, now, content: { publicData: content.publicData }, fetchImpl: async () => new Response('secret invalid json') });
  assert.equal(broken.errors.length, 1);
  assert.doesNotMatch(broken.markdown, /secret invalid json/);
});

test('config rejects unknown sources, tokens, bad dates and symlinked notes', async () => {
  const cwd = root();
  for (const bad of [{ token: 'forbidden' }, { projects: { enabled: true, repositories: ['https://example.com'] } }, { learning: { notesDir: '../private' } }]) {
    assert.throws(() => validateContent(bad, cwd));
  }
  for (const bad of ['2026-02-30', '2026-99-01', '../2026-10-30']) assert.throws(() => calendarDate(bad), { code: 'INVALID_DATE' });
  const outside = root(); symlinkSync(outside, path.join(cwd, 'notes'), 'dir');
  await assert.rejects(buildDailyDigest({ cwd, date, now, content: { learning: content.learning } }), { code: 'UNSAFE_DATA_PATH' });
});

test('time windows respect Shanghai and daylight-saving day lengths', () => {
  assert.deepEqual(localDay(date, 'Asia/Shanghai'), { start: '2026-10-29T16:00:00.000Z', end: '2026-10-30T16:00:00.000Z' });
  const spring = localDay('2026-03-08', 'America/New_York');
  assert.equal((Date.parse(spring.end) - Date.parse(spring.start)) / 3600000, 23);
});

test('CLI preview stays read-only; a daily run commits just one rich report; note scaffolds never overwrite', () => {
  const cwd = root(); input(cwd);
  const git = args => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']); git(['config', 'user.name', 'testuser']); git(['config', 'user.email', '1234567+testuser@users.noreply.github.com']);
  writeFileSync(path.join(cwd, 'green-wall.config.json'), JSON.stringify({ content: { learning: content.learning } }));
  git(['add', '.']); git(['commit', '-m', 'prepare learning input']);
  const run = (file, args) => spawnSync(process.execPath, [path.join(here, file), ...args], { cwd, encoding: 'utf8', timeout: 15000 });
  const preview = run('green-wall.mjs', ['preview', '--date', date, '--json']);
  assert.equal(preview.status, 0, preview.stderr); assert.equal(JSON.parse(preview.stdout).snapshot.learning.cards, 1);
  assert.equal(git(['status', '--porcelain']), '');
  const commit = run('auto-commit.mjs', ['--no-push', '--no-fallback', '--date', date, '--author-name', 'testuser', '--author-email', '1234567+testuser@users.noreply.github.com', '--json']);
  assert.equal(commit.status, 0, commit.stderr);
  assert.equal(JSON.parse(commit.stdout).content.cards, 1);
  assert.equal(git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']), `data/daily/${date}.md`);
  assert.equal(parseSnapshot(readFileSync(path.join(cwd, 'data/daily', `${date}.md`), 'utf8')).learning.cards, 1);
  const note = run('green-wall.mjs', ['note', '--date', '2026-10-31']);
  assert.equal(note.status, 0, note.stderr);
  const repeat = run('green-wall.mjs', ['note', '--date', '2026-10-31']);
  assert.equal(repeat.status, 1); assert.match(repeat.stderr, /NOTES_EXIST/);
});
