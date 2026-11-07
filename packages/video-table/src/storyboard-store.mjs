/**
 * 分镜文件的落盘层。
 *
 * 一份分镜就是工程目录下的 storyboard.json，和 project.json 平级：
 * 它属于工程，不属于某一次工具调用，所以能保存、能重读、能被 apply 落地。
 *
 * 约定（版本 1）：
 *   {
 *     "version": 1,
 *     "updatedAt": "ISO 时间",
 *     "source": "srt" | "manual",
 *     "shots": [{ index, start, end, text, kind, suggestedEffect, reason, clipId }]
 *   }
 *
 * 三条边界：
 *  - 读：文件不存在 → 默认空文档；文件写坏 → 默认空文档 + warning，绝不抛。
 *  - 写：严格校验，坏数据直接抛 DomainError（写坏盘比报错更难查）。
 *  - 路径：所有读写都夹在工程目录里，越界抛 OUTSIDE_PROJECT。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DomainError } from './domain.mjs';
import { EFFECT_CHOICES } from './storyboard.mjs';

export const STORYBOARD_FILE = 'storyboard.json';
export const STORYBOARD_VERSION = 1;

/** 镜头类型白名单，与 buildStoryboard 的分类保持一致。 */
export const SHOT_KINDS = ['hook', 'point', 'evidence', 'transition', 'outro'];
export const SHOT_SOURCES = ['srt', 'manual'];

const round3 = (n) => Math.round(n * 1000) / 1000;

/** 一份空分镜：没有任何镜头，也没有更新时间。 */
export function defaultStoryboard() {
  return { version: STORYBOARD_VERSION, updatedAt: null, source: 'manual', shots: [] };
}

/** storyboard.json 的绝对路径；root 为空或越界时抛中文错误。 */
export function storyboardPath(root) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new DomainError('INVALID_ARG', '缺少工程目录 root，无法定位 storyboard.json');
  }
  const base = path.resolve(root);
  const file = path.join(base, STORYBOARD_FILE);
  const rel = path.relative(base, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new DomainError('OUTSIDE_PROJECT', 'storyboard.json 的路径越出工程目录');
  }
  return file;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeShot(raw, index, { strict, dropped }) {
  const fail = (message) => {
    if (strict) throw new DomainError('INVALID_ARG', `${message}（第 ${index} 镜）`);
    dropped.push(message);
    return null;
  };
  if (!isPlainObject(raw)) return fail('不是对象');

  const start = Number(raw.start);
  const end = Number(raw.end);
  if (!Number.isFinite(start) || start < 0) return fail('start 不是非负数字');
  if (!Number.isFinite(end) || end <= start) return fail('end 必须晚于 start');

  const text = String(raw.text == null ? '' : raw.text).trim();
  if (!text) return fail('text 为空');

  const kind = SHOT_KINDS.includes(raw.kind) ? raw.kind : 'point';
  const effect = EFFECT_CHOICES.includes(raw.suggestedEffect) ? raw.suggestedEffect : 'none';
  const clipId =
    typeof raw.clipId === 'string' && raw.clipId.trim() ? raw.clipId.trim() : null;

  return {
    index: index + 1,
    start: round3(start),
    end: round3(end),
    text,
    kind,
    suggestedEffect: effect,
    reason: String(raw.reason == null ? '' : raw.reason),
    clipId,
  };
}

/**
 * 校验并规范一份分镜文档。
 * strict=true 时任何不合格都抛错；否则丢坏镜头、补默认字段。
 */
export function normalizeStoryboard(value, { strict = false, dropped = [] } = {}) {
  const fail = (message) => {
    if (strict) throw new DomainError('INVALID_ARG', message);
    dropped.push(message);
    return null;
  };

  if (!isPlainObject(value)) return fail('分镜文档不是对象') || defaultStoryboard();

  const version = Number(value.version);
  if (strict && version !== STORYBOARD_VERSION) {
    throw new DomainError('INVALID_ARG', `分镜版本应为 ${STORYBOARD_VERSION}，实际是 ${value.version}`);
  }

  const source = SHOT_SOURCES.includes(value.source) ? value.source : 'manual';
  const rawShots = Array.isArray(value.shots) ? value.shots : [];
  if (strict && !Array.isArray(value.shots)) {
    throw new DomainError('INVALID_ARG', 'shots 必须是数组');
  }

  const shots = [];
  rawShots.forEach((raw, i) => {
    const shot = normalizeShot(raw, i, { strict, dropped });
    if (shot) shots.push(shot);
  });
  // 保存的镜头按时间排；index 重新编号，保证「第 N 镜」永远指时间上的第 N 段
  shots.sort((a, b) => a.start - b.start);
  shots.forEach((shot, i) => {
    shot.index = i + 1;
  });

  return {
    version: STORYBOARD_VERSION,
    updatedAt: value.updatedAt == null ? null : String(value.updatedAt),
    source,
    shots,
  };
}

/**
 * 读一份分镜。
 * 永远返回 { doc, warning, path, exists }：文件不存在或写坏都退化成默认空文档，
 * 只有「读失败的原因」通过 warning 说出来。
 */
export async function readStoryboard(root) {
  const file = storyboardPath(root);

  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { doc: defaultStoryboard(), warning: null, path: file, exists: false };
    }
    return {
      doc: defaultStoryboard(),
      warning: `读不到 storyboard.json（${(e && e.message) || e}），先按空分镜处理`,
      path: file,
      exists: false,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      doc: defaultStoryboard(),
      warning: `storyboard.json 不是合法 JSON（${e.message}），已按空分镜处理；重新保存会覆盖它`,
      path: file,
      exists: true,
    };
  }

  const dropped = [];
  const doc = normalizeStoryboard(parsed, { strict: false, dropped });
  const warning = dropped.length
    ? `storyboard.json 里有 ${dropped.length} 条镜头不规范，已跳过：${dropped[0]}`
    : null;
  return { doc, warning, path: file, exists: true };
}

/**
 * 写一份分镜（原子写：先写 .tmp 再 rename）。
 * 写盘前严格校验；updatedAt 缺省时补当前时间。
 * 返回 { path, doc }，doc 是真正落盘的那一份。
 */
export async function writeStoryboard(root, doc) {
  const file = storyboardPath(root);
  const normalized = normalizeStoryboard(doc, { strict: true });
  normalized.updatedAt =
    doc && typeof doc.updatedAt === 'string' && doc.updatedAt ? doc.updatedAt : new Date().toISOString();

  await fs.mkdir(path.resolve(root), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
  return { path: file, doc: normalized };
}
