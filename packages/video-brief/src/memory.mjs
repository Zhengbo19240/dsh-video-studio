/**
 * 全局偏好的只读视图。
 *
 * 来源是 grill-first 已经在用的 `~/.dsh/grill-first/global.json`（跨插件共享同一份用户偏好），
 * 本插件**只读**，不写、不改、不新增字段。读不到就返回空数组，绝不抛错。
 */

import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** global.json 的默认位置；`DSH_VIDEO_BRIEF_GRILL_HOME` 可覆盖（测试用）。 */
export function globalMemoryPath(home = homedir()) {
  const override = process.env.DSH_VIDEO_BRIEF_GRILL_HOME;
  const base = typeof override === 'string' && override.trim() !== ''
    ? path.resolve(override.trim())
    : path.join(home, '.dsh', 'grill-first');
  return path.join(base, 'global.json');
}

/**
 * 读全局偏好。坏 JSON / 文件不存在 / 结构不对，都退成空数组。
 * @returns {Promise<Array<{text:string, tags:string[], updated:number}>>}
 */
export async function loadPreferences(options = {}) {
  const fs = options.fs;
  const file = options.file ?? globalMemoryPath();
  try {
    const text = fs
      ? await fs.readFile(file, 'utf8')
      : await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    const list = parsed && Array.isArray(parsed.preferences) ? parsed.preferences : [];
    const out = [];
    for (const item of list) {
      if (!item || typeof item.text !== 'string' || item.text.trim() === '') continue;
      out.push({
        text: item.text.trim(),
        tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string') : [],
        updated: Number.isFinite(item.updated) ? item.updated : 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** 把文本拆成可比较的片段：中文按 2 字滑窗，英文/数字按词。 */
export function tokenize(text) {
  const source = typeof text === 'string' ? text.toLowerCase() : '';
  const tokens = new Set();
  for (const word of source.match(/[a-z0-9][a-z0-9_-]+/g) ?? []) {
    if (word.length >= 2) tokens.add(word);
  }
  const cjk = source.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i + 2 <= cjk.length; i += 1) tokens.add(cjk.slice(i, i + 2));
  return [...tokens];
}

/** 截断到指定长度（按字符）。 */
function clip(text, limit) {
  const flat = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * 从全局偏好里挑跟本次主题相关的那几条。
 *
 * 打分就是"主题片段在偏好文本里出现了几个"。一个都不命中时：
 * 有主题 → 返回空（宁可不给，也不要塞无关偏好）；
 * 没主题 → 返回最近更新的几条，当作通用偏好。
 *
 * @param {Array<{text:string, tags?:string[], updated?:number}>} preferences
 * @param {string} topic
 * @param {{limit?: number, clipLength?: number}} [options]
 * @returns {string[]}
 */
export function pickRelatedPreferences(preferences, topic, options = {}) {
  const limit = Math.max(1, Number(options.limit) || 5);
  const clipLength = Math.max(20, Number(options.clipLength) || 80);
  const list = Array.isArray(preferences) ? preferences : [];
  const tokens = tokenize(topic);
  if (tokens.length === 0) {
    return [...list]
      .sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0))
      .slice(0, Math.min(limit, 3))
      .map((item) => clip(item.text, clipLength));
  }
  const scored = [];
  for (const item of list) {
    const haystack = `${item.text} ${(item.tags ?? []).join(' ')}`.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) score += token.length >= 3 ? 2 : 1;
    }
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || (Number(b.item.updated) || 0) - (Number(a.item.updated) || 0));
  return scored.slice(0, limit).map(({ item }) => clip(item.text, clipLength));
}
