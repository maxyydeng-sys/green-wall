#!/usr/bin/env node
/**
 * summary.mjs —— 把 auto-commit.mjs 产出的 JSON 摘要转成 CI 里方便看的形式。
 *
 *   node scripts/summary.mjs --field <key>      # 打印某个字段（值为空/不存在则打印空字符串）
 *   node scripts/summary.mjs --to-step-summary  # 追加 Markdown 到 $GITHUB_STEP_SUMMARY
 *
 * 摘要文件路径取自环境变量 SUMMARY_PATH。
 *
 * 退出码约定（workflow 依赖它区分「正常跳过」和「摘要丢了」）：
 *   0  摘要存在且可解析，或摘要文件根本不存在（当天记录已存在时脚本仍会写摘要，
 *      所以文件不存在通常意味着前置步骤就挂了）
 *   1  摘要文件存在但无法解析成 JSON —— 这种情况下不能把「字段为空」误读成「没有新提交」
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

function load() {
  const p = process.env.SUMMARY_PATH;
  if (!p) return { status: 'missing', data: null };
  if (!existsSync(p)) return { status: 'missing', data: null };
  const raw = readFileSync(p, 'utf8');
  try {
    return { status: 'ok', data: JSON.parse(raw) };
  } catch (err) {
    return { status: 'corrupt', data: null, error: `${err.message}`, raw: raw.slice(0, 300) };
  }
}

function toStepSummary(loaded) {
  const s = loaded.data;
  if (loaded.status === 'corrupt') {
    return [
      '### auto-commit 摘要无法解析',
      '',
      `- 原因：\`${loaded.error}\``,
      '- 摘要文件已存在但不是合法 JSON，请把上方日志一并贴给维护者。',
      '',
    ].join('\n');
  }
  if (!s) {
    return [
      '### auto-commit',
      '',
      '本次运行没有产生摘要文件（可能在身份体检阶段就失败了，请查看上方日志）。',
      '',
    ].join('\n');
  }
  if (s.ok === false) {
    const lines = ['### auto-commit 未完全成功', ''];
    if (s.error) {
      lines.push(`- 错误：\`${s.error}\``);
      lines.push(`- 错误码：\`${s.code || '-'}\``);
    }
    if (s.pushError) {
      lines.push(`- 推送失败：\`${s.pushError}\``);
      lines.push('- 提交本身可能已在本地/runner 上生成，但没进远端，贡献图不会亮');
    }
    if (!s.error && !s.pushError) {
      lines.push('- 未知错误，请查看上方日志');
    }
    if (s.date) lines.push(`- 目标日期：${s.date}`);
    if (s.sha) lines.push(`- 提交：\`${String(s.sha).slice(0, 7)}\``);
    lines.push('');
    return lines.join('\n');
  }

  const rows = [
    ['目标日期', s.date || '-'],
    ['结果', s.action || '-'],
    ['记录文件', s.file ? `\`${s.file}\`` : '-'],
    ['提交', s.sha ? `\`${String(s.sha).slice(0, 7)}\`` : '-'],
    ['author', s.author ? `${s.author.email}（来源：${s.author.source}）` : '-'],
    ['分支', s.branch || '-'],
    ['已推送', s.pushed ? '是' : s.dryRun ? '（演练）' : '否'],
    ['回填', s.backfill ? '是' : '否'],
    ['触发方式', s.trigger || '-'],
  ];
  const lines = [`### auto-commit · ${s.date || ''} ${s.action || ''}`.trimEnd(), ''];
  lines.push('| 项 | 值 |', '| --- | --- |');
  for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`);
  if (Array.isArray(s.notices) && s.notices.length > 0) {
    lines.push('', '**提示**', '');
    for (const n of s.notices) lines.push(`- ${n}`);
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const loaded = load();

  if (loaded.status === 'corrupt') {
    process.stderr.write(`摘要文件无法解析：${loaded.error}\n片段：${loaded.raw}\n`);
  }

  const fieldIdx = argv.indexOf('--field');
  if (fieldIdx !== -1) {
    if (loaded.status === 'corrupt') return 1;
    const key = argv[fieldIdx + 1];
    const value = loaded.data && key ? loaded.data[key] : '';
    process.stdout.write(value === undefined || value === null ? '' : String(value));
    return 0;
  }

  if (argv.includes('--to-step-summary')) {
    const md = toStepSummary(loaded);
    const target = process.env.GITHUB_STEP_SUMMARY;
    if (target) appendFileSync(target, md, 'utf8');
    process.stdout.write(md);
    return loaded.status === 'corrupt' ? 1 : 0;
  }

  process.stdout.write(`${JSON.stringify(loaded.data, null, 2)}\n`);
  return loaded.status === 'corrupt' ? 1 : 0;
}

process.exitCode = main();
