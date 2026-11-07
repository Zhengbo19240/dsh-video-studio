/**
 * Freesound 在线声音源。
 *
 * 只在配置了 FREESOUND_API_KEY 时可用；没有 key 时明确抛 NO_API_KEY，
 * 不静默返回空数组 —— 空结果和「没配置」是两件事，调用方要能分开。
 *
 * 排序（sort）：
 *   rating    —— 直接向 Freesound 要 rating_desc（纯评分）
 *   downloads —— 直接向 Freesound 要 downloads_desc（纯下载量）
 *   blend     —— 默认。先按 rating_desc 多取一倍样本，再本地重排：
 *                0.6 * 归一化评分 + 0.3 * 归一化 log(下载量) + 0.1 * 时长匹配度
 *                评分样本数 < 3 的条目把「评分」这一项减半 —— 1 个 5 星不该排第一。
 *
 * 网络错误统一转成 NETWORK（附原始 message），下载预览失败转成 DOWNLOAD_FAILED。
 * 超时 8 秒（AbortController），预览下载上限 20MB。
 */

import { DomainError } from './domain.mjs';

const SEARCH_URL = 'https://freesound.org/apiv2/search/text/';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
const FIELDS =
  'id,name,previews,duration,tags,num_downloads,avg_rating,num_ratings,license,username,url';

/** 允许的排序模式（工具 / RPC 的 sort 参数共用这一份） */
export const FREESOUND_SORT_MODES = Object.freeze(['rating', 'downloads', 'blend']);
export const DEFAULT_FREESOUND_SORT = 'blend';

/** blend 权重：评分 0.6 / 下载量 0.3 / 时长匹配 0.1 */
export const BLEND_WEIGHTS = Object.freeze({ rating: 0.6, downloads: 0.3, duration: 0.1 });

/** sort → Freesound 的 sort 参数；blend 先要评分序，再本地重排 */
const SORT_QUERY = Object.freeze({ rating: 'rating_desc', downloads: 'downloads_desc', blend: 'rating_desc' });

/** blend 多取一倍样本，才有东西可重排 */
const BLEND_FETCH_MULTIPLIER = 2;
/** 评分样本少于这个数就降权 */
const MIN_RATING_SAMPLES = 3;
/** 降权系数：只作用在「评分」这一项上 */
const FEW_SAMPLES_FACTOR = 0.5;

/**
 * 归一化 sort 参数：空值 → blend；不认识的值抛 INVALID_ARG（别静默改成别的排序）。
 */
export function normalizeFreesoundSort(sort) {
  if (sort == null || sort === '') return DEFAULT_FREESOUND_SORT;
  const mode = String(sort);
  if (!FREESOUND_SORT_MODES.includes(mode)) {
    throw new DomainError('INVALID_ARG', 'sort 只能是 rating / downloads / blend');
  }
  return mode;
}

/**
 * 搜索结果缓存：insert / preview 只拿得到 entryId，靠这份缓存把条目找回来。
 * 上限 500 条，按插入顺序淘汰最旧的。
 */
const entryCache = new Map();
const CACHE_MAX = 500;

/** 把条目放进缓存（searchFreesound 自动调用；测试也用它注入离线条目） */
export function rememberEntries(entries) {
  if (!Array.isArray(entries)) return;
  for (const e of entries) {
    if (!e || typeof e.id !== 'string' || !e.id) continue;
    if (entryCache.has(e.id)) entryCache.delete(e.id);
    entryCache.set(e.id, e);
  }
  while (entryCache.size > CACHE_MAX) {
    const first = entryCache.keys().next().value;
    entryCache.delete(first);
  }
}

/** 按 id 取缓存条目；没有时返回 null */
export function getCachedEntry(entryId) {
  return entryCache.get(String(entryId == null ? '' : entryId)) || null;
}

/** 是否配置了 Freesound key */
export function freesoundEnabled() {
  const key = process.env.FREESOUND_API_KEY;
  return typeof key === 'string' && key.trim() !== '';
}

/**
 * 搜索 Freesound，归一化成与本地条目相同的形状。
 * 返回条目数组；没有 key 抛 NO_API_KEY，sort 不认识抛 INVALID_ARG，
 * 时长区间非法（min > max）抛 INVALID_ARG，网络/协议失败抛 NETWORK。
 *
 * sort='blend' 时会多取一倍样本再本地重排，最后仍只返回 limit 条。
 * minDuration / maxDuration 直接拼进 Freesound 的 filter=duration:[min TO max]：
 * 只给下限时上限写 `*`（Solr 的「无上限」），不给下限时下限写 0（沿用旧行为）。
 */
export async function searchFreesound(query, { limit = 20, minDuration, maxDuration, sort } = {}) {
  const key = process.env.FREESOUND_API_KEY;
  if (typeof key !== 'string' || key.trim() === '') {
    throw new DomainError('NO_API_KEY', '未配置 FREESOUND_API_KEY');
  }

  const q = String(query == null ? '' : query).trim();
  if (!q) throw new DomainError('INVALID_ARG', 'Freesound 搜索需要关键词');

  const mode = normalizeFreesoundSort(sort);
  const size = clampInt(limit, 1, 150);
  const minDur = positiveSeconds(minDuration);
  const maxDur = positiveSeconds(maxDuration);
  if (minDur != null && maxDur != null && minDur > maxDur) {
    throw new DomainError('INVALID_ARG', 'minDuration（' + minDur + ' 秒）不能大于 maxDuration（' + maxDur + ' 秒）');
  }
  // blend 要有一批可比样本才谈得上重排；直接多取一倍（上限还是 150）
  const pageSize = mode === 'blend' ? clampInt(size * BLEND_FETCH_MULTIPLIER, 2, 150) : size;

  const url = new URL(SEARCH_URL);
  url.searchParams.set('query', q);
  url.searchParams.set('fields', FIELDS);
  url.searchParams.set('sort', SORT_QUERY[mode]);
  url.searchParams.set('page_size', String(pageSize));
  url.searchParams.set('token', key.trim());
  if (minDur != null || maxDur != null) {
    const lo = minDur != null ? minDur : 0;
    const hi = maxDur != null ? maxDur : '*';
    url.searchParams.set('filter', `duration:[${lo} TO ${hi}]`);
  }

  let res;
  try {
    res = await fetchWithTimeout(url.toString());
  } catch (e) {
    throw new DomainError('NETWORK', `Freesound 请求失败: ${errText(e)}`);
  }
  if (!res.ok) {
    throw new DomainError('NETWORK', `Freesound 请求失败: HTTP ${res.status}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new DomainError('NETWORK', `Freesound 响应不是合法 JSON: ${errText(e)}`);
  }

  const results = Array.isArray(data && data.results) ? data.results : [];
  let entries = results.filter((r) => r && r.id != null).map(normalizeEntry);
  if (mode === 'blend') {
    entries = rankByBlend(entries, { limit: size, minDuration: minDur, maxDuration: maxDur });
  }
  rememberEntries(entries);
  return entries;
}

/** 把一条 Freesound 记录归一化成和 local 一样的条目形状 */
function normalizeEntry(raw) {
  const previews = raw.previews && typeof raw.previews === 'object' ? raw.previews : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => String(t)).filter(Boolean) : [];

  return {
    id: 'freesound:' + raw.id,
    provider: 'freesound',
    providerId: String(raw.id),
    title: str(raw.name) || String(raw.id),
    previewUrl: str(previews['preview-hq-mp3']) || str(previews['preview-lq-mp3']),
    duration: typeof raw.duration === 'number' && Number.isFinite(raw.duration) ? raw.duration : null,
    tags,
    category: null,
    license: str(raw.license),
    attribution: 'by ' + (str(raw.username) || 'unknown'),
    pageUrl: str(raw.url) || `https://freesound.org/s/${raw.id}/`,
    // ratings 是「有多少人打过分」——blend 靠它判断这个平均分可不可信
    stats: { downloads: num(raw.num_downloads), rating: num(raw.avg_rating), ratings: num(raw.num_ratings) },
    // 找 BGM 时想知道「能不能拿来垫循环」。false = 没打 loop 标签，不代表技术上不能循环；
    // 本地库没有这类元数据，所以本地条目一律 null（见 sound-lib 的 describeLocalFile）。
    loopable: tags.some((t) => t.toLowerCase() === 'loop'),
  };
}

// ------------------------------------------------------------ blend 排序 ---
//
// 全部是纯函数：不联网、不读环境变量。工具、RPC 与测试共用同一份规则。

/** 条目评分（0~5），缺失按 0 */
function ratingOf(entry) {
  const n = Number(entry && entry.stats && entry.stats.rating);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 评分样本数，缺失按 0（按「样本太少」降权处理） */
function ratingCountOf(entry) {
  const n = Number(entry && entry.stats && entry.stats.ratings);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 下载量，缺失按 0 */
function downloadsOf(entry) {
  const n = Number(entry && entry.stats && entry.stats.downloads);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * min-max 归一化到 [0,1]。区间为 0（所有样本一样）或数值不合法时返回 0.5 ——
 * 这是「没有区分度」的中性分，同时避免 0 除。
 */
function minMaxNorm(value, min, max) {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return 0.5;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/**
 * 时长匹配度（0~1）：
 *   - 两个边界都没给 → 固定 0.5（这条维度没有信息）
 *   - 时长未知 → 0.5（不奖励也不惩罚）
 *   - 短于下限 → 0（明确不合要求）
 *   - 超过上限 → 0
 *   - 给定区间 → 落在区间的相对位置；只有下限时按 min/d（越接近下限越贴）
 */
export function durationFit(duration, maxDuration, minDuration) {
  const min = positiveSeconds(minDuration);
  const max = positiveSeconds(maxDuration);
  if (min == null && max == null) return 0.5;

  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0) return 0.5;
  if (min != null && d < min) return 0;
  if (max != null) {
    if (d > max) return 0;
    const span = min != null ? Math.max(max - min, 1e-9) : max;
    return Math.min(1, Math.max(0, (d - (min || 0)) / span));
  }
  // 只有下限：够长就行；越贴近下限越贴（98 秒的曲子不该总压过 60 秒的）
  return Math.min(1, min / d);
}

/**
 * 算出每条条目的 blend 分数，按分数降序返回 [{ entry, index, score, parts }]。
 * 同分时下载量高的在前，再同就保持原顺序（稳定）。
 *
 * score = 0.6 * 归一化评分 * 样本系数 + 0.3 * 归一化 log(下载量) + 0.1 * 时长匹配度
 * 样本系数：评分样本 >= 3 → 1；否则 0.5（1 个 5 星不该压过 400 人打出的 4.9）。
 */
export function blendScores(entries, { minDuration, maxDuration } = {}) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  if (!list.length) return [];

  const ratings = list.map(ratingOf);
  const logs = list.map((e) => Math.log1p(downloadsOf(e)));
  const rMin = Math.min(...ratings);
  const rMax = Math.max(...ratings);
  const lMin = Math.min(...logs);
  const lMax = Math.max(...logs);

  return list
    .map((entry, index) => {
      const ratingNorm = minMaxNorm(ratingOf(entry), rMin, rMax);
      const downloadsNorm = minMaxNorm(Math.log1p(downloadsOf(entry)), lMin, lMax);
      const fit = durationFit(entry.duration, maxDuration, minDuration);
      const sampleFactor = ratingCountOf(entry) >= MIN_RATING_SAMPLES ? 1 : FEW_SAMPLES_FACTOR;
      const score =
        BLEND_WEIGHTS.rating * ratingNorm * sampleFactor +
        BLEND_WEIGHTS.downloads * downloadsNorm +
        BLEND_WEIGHTS.duration * fit;
      return { entry, index, score, parts: { ratingNorm, downloadsNorm, durationFit: fit, sampleFactor } };
    })
    .sort((a, b) => b.score - a.score || downloadsOf(b.entry) - downloadsOf(a.entry) || a.index - b.index);
}

/** blend 排序后取前 limit 条；limit 不合法时返回全部 */
export function rankByBlend(entries, { limit, minDuration, maxDuration } = {}) {
  const ranked = blendScores(entries, { minDuration, maxDuration }).map((s) => s.entry);
  const n = Number(limit);
  return Number.isFinite(n) && n > 0 ? ranked.slice(0, n) : ranked;
}

/**
 * 下载条目的预览音频，返回 { bytes: Buffer, contentType }。
 * 失败（没 URL / 网络 / 非 2xx / 超限 / 空文件）抛 DOWNLOAD_FAILED。
 */
export async function downloadFreesoundPreview(entry) {
  const url = entry && typeof entry.previewUrl === 'string' ? entry.previewUrl.trim() : '';
  if (!url) throw new DomainError('DOWNLOAD_FAILED', '该条目没有可下载的预览音频');

  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch (e) {
    throw new DomainError('DOWNLOAD_FAILED', `下载预览失败: ${errText(e)}`);
  }
  if (!res.ok) throw new DomainError('DOWNLOAD_FAILED', `下载预览失败: HTTP ${res.status}`);

  const contentType = (res.headers && res.headers.get('content-type')) || 'audio/mpeg';
  const declared = Number(res.headers && res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PREVIEW_BYTES) {
    throw new DomainError('DOWNLOAD_FAILED', '预览音频超过 20MB 上限');
  }

  try {
    const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
    if (!reader) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_PREVIEW_BYTES) {
        throw new DomainError('DOWNLOAD_FAILED', '预览音频超过 20MB 上限');
      }
      if (!buf.length) throw new DomainError('DOWNLOAD_FAILED', '预览音频为空');
      return { bytes: buf, contentType };
    }

    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_PREVIEW_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* 取消失败不影响报错 */
        }
        throw new DomainError('DOWNLOAD_FAILED', '预览音频超过 20MB 上限');
      }
      chunks.push(Buffer.from(value));
    }
    if (!total) throw new DomainError('DOWNLOAD_FAILED', '预览音频为空');
    return { bytes: Buffer.concat(chunks, total), contentType };
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError('DOWNLOAD_FAILED', `下载预览失败: ${errText(e)}`);
  }
}

// --------------------------------------------------------------- 内部工具 ---

/** 8 秒超时的 fetch；超时表现为 AbortError，由调用方包装成 DomainError */
async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function clampInt(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  return Math.min(Math.max(Math.trunc(n), lo), hi);
}

/** 正数秒；0 / 负数 / NaN / 空值一律当「没给」 */
function positiveSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function errText(e) {
  return e && e.message ? e.message : String(e);
}
