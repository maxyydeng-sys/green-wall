import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { classifyEmail, looksLikeEmail } from './author.mjs';
import { failure, safeDataFile } from './repository.mjs';
import { validateContent } from './digest.mjs';

export const CONFIG_NAME = 'green-wall.config.json';
export const defaults = {
  version: 1, enabled: true, timezone: 'Asia/Shanghai', dataDir: 'data/daily',
  pushAttempts: 3, author: { name: '', email: '', actor: '' },
  content: {},
};

export function validateConfig(value, cwd) {
  const reject = message => { throw failure('INVALID_CONFIG', `${CONFIG_NAME}：${message}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('必须是 JSON 对象');
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaults, key)) reject(`未知字段 ${key}（配置中不允许存储 token 或密钥）`);
  const config = { ...defaults, ...value, author: { ...defaults.author, ...value.author } };
  if (config.version !== 1 || typeof config.enabled !== 'boolean') reject('version 必须为 1，enabled 必须为布尔值');
  if (typeof config.timezone !== 'string' || !config.timezone) reject('timezone 必须是 IANA 时区');
  try { new Intl.DateTimeFormat('en', { timeZone: config.timezone }); } catch { reject('timezone 不是合法 IANA 时区'); }
  if (typeof config.dataDir !== 'string' || !config.dataDir || path.isAbsolute(config.dataDir)) reject('dataDir 必须是仓库内相对路径');
  safeDataFile(cwd, config.dataDir, '2000-01-01');
  if (!Number.isInteger(config.pushAttempts) || config.pushAttempts < 1 || config.pushAttempts > 5) reject('pushAttempts 必须是 1–5 的整数');
  if (value.author !== undefined && (!value.author || typeof value.author !== 'object' || Array.isArray(value.author))) reject('author 必须是对象');
  for (const [key, item] of Object.entries(config.author)) {
    if (!Object.hasOwn(defaults.author, key) || typeof item !== 'string' || /[\r\n\x00]/.test(item)) reject(`author.${key} 不合法`);
    config.author[key] = item.trim();
  }
  if (config.author.email && (!looksLikeEmail(config.author.email) || classifyEmail(config.author.email, { allowGitHubComEmail: process.env.GREEN_WALL_ALLOW_GITHUB_COM === '1' }).blocked)) reject('author.email 格式不正确或属于平台/机器人地址');
  if (config.author.actor && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(config.author.actor)) reject('author.actor 不是合法 GitHub 用户名');
  config.content = validateContent(config.content, cwd);
  return config;
}

export function loadConfig(cwd) {
  const file = path.join(cwd, CONFIG_NAME);
  if (!existsSync(file)) return validateConfig({}, cwd);
  try { return validateConfig(JSON.parse(readFileSync(file, 'utf8')), cwd); }
  catch (error) { throw failure('INVALID_CONFIG', `无法加载 ${CONFIG_NAME}：${error.message}`); }
}

export function effectiveAuthor(config) {
  // Actions repository variables and explicit shell values override shared project configuration.
  return {
    name: process.env.GIT_AUTHOR_NAME?.trim() || config.author.name,
    email: process.env.GIT_AUTHOR_EMAIL?.trim() || config.author.email,
    actor: config.author.actor || process.env.GITHUB_ACTOR || '',
  };
}
