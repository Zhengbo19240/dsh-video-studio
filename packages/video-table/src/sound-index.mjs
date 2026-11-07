/**
 * 声学标签索引（默认 ~/.dsh/sound-index.json）的读取、过滤与返回装饰。
 *
 * 这个文件只做三件事：
 *   1) 说清索引文件在哪、什么形状、读坏了怎么办（永远不抛，回 warning）；
 *   2) 把「条目」映射到索引里的 key（root/providerId），给检索用同一套口径；
 *   3) 把测量值过滤成一组可搜索的维度，并把 measured 挂回命中条目。
 *
 * ★ 一条硬规矩：这里的所有字段都是**声学测量值**，不是听感结论。
 *   字段名用 materialGuess 而不是 material —— 带 Guess 就是提醒调用方「这是猜的」。
 *   任何返回里都必须带得上 MEASURED_CAVEAT。
 *
 * 索引文件由 tools/analyze-sounds.mjs 生成；本模块只读不写。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 测量值的免责说明。这句话会出现在索引顶层、搜索结果顶层、每条命中里。
 * 改它就等于改所有对外文案，别随手改。
 */
export const MEASURED_CAVEAT =
  '标签由声学测量得出（ffmpeg 频谱统计 + PCM 包络/过零/自相关），不是听感结论；实际音色请试听确认。';

/** 索引结构版本。字段增删时 +1，读旧版本不会被当成坏文件。 */
export const SOUND_INDEX_VERSION = 1;

/** 分析器署名，写进索引的 analyzer 字段 */
export const ANALYZER_NAME = 'ffmpeg+自算';

/** 三个枚举维度的合法取值。检索时用它们校验参数，拼错不静默。 */
export const SHAPE_VALUES = ['短促', '中', '拖尾'];
export const BRIGHTNESS_VALUES = ['暗', '中', '亮'];
export const MATERIAL_VALUES = ['金属倾向', '木质倾向', '塑料倾向', '合成倾向'];

/** 索引文件路径：DSH_SOUND_INDEX 优先（测试用），否则 ~/.dsh/sound-index.json */
export function soundIndexFile() {
  const fromEnv = process.env.DSH_SOUND_INDEX;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.dsh', 'sound-index.json');
}

/**
 * 条目 → 索引 key。
 *
 * 用 `<根名>/<packId>/<相对路径>`（正斜杠）而不是绝对路径：换盘符、换用户名都不会
 * 让整库索引失效。同一个物理文件若被两个根同时收录，会得到两个 key —— 这是刻意的，
 * 因为两个根里的 sidecar / 分类可能不同，条目 id 本来就不同。
 */
export function indexKeyOf(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const root = typeof entry.root === 'string' && entry.root ? entry.root : 'default';
  const pid = typeof entry.providerId === 'string' ? entry.providerId : '';
  if (!pid) return '';
  return root + '/' + pid.replace(/\\/g, '/');
}

function emptyIndex(file) {
  return {
    exists: false,
    file,
    version: null,
    generatedAt: null,
    caveat: null,
    items: {},
    errors: [],
    warning: null,
  };
}

/**
 * 读索引。**永不抛错**：
 *   - 文件不存在 → exists:false，检索时按「没有测量数据」处理；
 *   - 文件坏了 / 顶层不是对象 → items:{}, warning 里说明；
 *   - 单条坏数据（不是对象 / 字段类型不对）→ 丢掉那一条，不毁整库。
 */
export async function loadSoundIndex() {
  const file = soundIndexFile();
  const base = emptyIndex(file);

  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return base;
    return { ...base, warning: '读取声学索引失败（' + e.message + '）：' + file };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ...base, exists: true, warning: '声学索引不是合法 JSON，已忽略：' + file };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ...base, exists: true, warning: '声学索引的顶层不是对象，已忽略：' + file };
  }

  const rawItems = data.items && typeof data.items === 'object' && !Array.isArray(data.items) ? data.items : {};
  const items = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(rawItems)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      dropped += 1;
      continue;
    }
    items[key] = value;
  }

  const errors = Array.isArray(data.errors)
    ? data.errors.filter((x) => x && typeof x === 'object').slice(0, 200)
    : [];

  const warning = dropped ? '声学索引里有 ' + dropped + ' 条坏条目，已跳过' : null;

  return {
    exists: true,
    file,
    version: Number.isFinite(data.version) ? data.version : null,
    generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : null,
    caveat: typeof data.caveat === 'string' && data.caveat.trim() ? data.caveat.trim() : null,
    items,
    errors,
    warning,
  };
}

/** 取一个条目的测量值（没有就 null） */
export function measuredItemOf(entry, index) {
  if (!index || !index.items) return null;
  const key = indexKeyOf(entry);
  if (!key) return null;
  return index.items[key] || null;
}

/**
 * 把内部条目裁成对外返回的 measured 形状。
 *
 * 刻意只给这五个字段：shape / brightness / materialGuess / centroidHz / decayMs。
 * 原始条目里还有 zcr / flatness / f0Hz 之类的中间量，对外不给 —— 免得被当成真理引用。
 */
export function measuredSummary(item) {
  if (!item) return null;
  return {
    shape: item.shape ?? null,
    brightness: item.brightness ?? null,
    materialGuess: item.materialGuess ?? null,
    centroidHz: typeof item.centroidHz === 'number' ? Math.round(item.centroidHz) : null,
    decayMs: typeof item.decayMs === 'number' ? Math.round(item.decayMs * 10) / 10 : null,
  };
}

/** 一条命中的条目要不要带 measured（有测量数据才带） */
export function decorateMeasured(entry, index) {
  const item = measuredItemOf(entry, index);
  if (!item) return entry;
  const measured = measuredSummary(item);
  if (!measured) return entry;
  return { ...entry, measured, measuredCaveat: MEASURED_CAVEAT };
}

/**
 * 归一化检索参数。坏值抛 DomainError（在 sound-tools 里），这里只返回 null/值，
 * 由调用方决定抛不抛 —— 保持本模块零依赖，方便单测。
 */
export function pickMeasuredFilters({ shape, brightness, material, maxDurationMs } = {}) {
  const out = { shape: null, brightness: null, material: null, maxDurationMs: null };
  if (typeof shape === 'string' && shape.trim()) out.shape = shape.trim();
  if (typeof brightness === 'string' && brightness.trim()) out.brightness = brightness.trim();
  if (typeof material === 'string' && material.trim()) out.material = material.trim();
  if (typeof maxDurationMs === 'number' && Number.isFinite(maxDurationMs) && maxDurationMs > 0) {
    out.maxDurationMs = maxDurationMs;
  }
  return out;
}

export function hasMeasuredFilters(filters) {
  if (!filters) return false;
  return Boolean(filters.shape || filters.brightness || filters.material || filters.maxDurationMs != null);
}

/**
 * 按测量维度过滤条目。
 *
 * 语义：**只要有测量维度被指定，就只保留有测量数据的条目。** 没有测量数据的条目
 * 不会被「放行」—— 那等于把「没测」当成「符合」，正是这里要避免的事。
 * 调用方负责在索引缺失时给出 warning。
 *
 * 返回 { entries, total }：total 是过滤后、截断前的条数。
 */
export function filterByMeasured(entries, filters, index) {
  if (!hasMeasuredFilters(filters)) return { entries: entries || [], total: (entries || []).length };
  const kept = [];
  for (const entry of entries || []) {
    const item = measuredItemOf(entry, index);
    if (!item) continue;
    if (filters.shape && item.shape !== filters.shape) continue;
    if (filters.brightness && item.brightness !== filters.brightness) continue;
    if (filters.material && item.materialGuess !== filters.material) continue;
    if (filters.maxDurationMs != null) {
      const ms = measuredDurationMs(entry, item);
      // 时长测不出来时不能猜：过滤条件下必须有值才算命中
      if (ms == null || ms > filters.maxDurationMs) continue;
    }
    kept.push(entry);
  }
  return { entries: kept, total: kept.length };
}

/** 时长优先用测量值，其次用条目自带的 duration（秒） */
function measuredDurationMs(entry, item) {
  if (item && typeof item.durationMs === 'number' && Number.isFinite(item.durationMs)) return item.durationMs;
  if (entry && typeof entry.duration === 'number' && Number.isFinite(entry.duration)) return entry.duration * 1000;
  return null;
}
