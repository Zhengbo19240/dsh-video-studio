/**
 * Code-layer registry: keeps one sandboxed worker per code clip and feeds it
 * the current time.
 *
 * 媒体注入（见 docs/code-layer-media.md）：
 *   Worker 里没有 DOM，所以「已经 seek 到当前帧」这件事只能由主线程做。
 *   注册表负责：
 *     1) 从模块声明的 media 需求（layer.mediaNeeds()）知道要哪几个素材；
 *     2) 用独立的 <video> 池 seek 到片段局部时间，createImageBitmap 抓帧；
 *     3) 把帧位图 + 素材浅清单 + fps/duration 随 render 消息 transfer 进去。
 *   时间基准是 frameLayers 给的 localT（与 drawFrame 同一份时间轴），所以
 *   预览 / 导出 / 采样三条路径看到的媒体帧时刻一致。
 *
 * Preview is drift-free by construction (see docs/playback-loop.md):
 *   - 时间只来自播放头，**不拿墙钟做丢帧判断**；
 *   - 每个图层最多一份渲染在飞，新请求只更新「最新想要的 t」；
 *   - 渲染完成后按 generation 判定：过期结果丢弃，绝不让旧帧盖新帧。
 * 导出仍然精确：renderAt() 会先把预览请求作废，再逐帧 await。
 */

import { sourceOffsetOf } from '../domain.mjs';
import { createCodeLayer } from './code-layer.js';
import {
  drawFrame as playerDrawFrame,
  frameLayers as playerFrameLayers,
  sourceTime as playerSourceTime,
} from './player.js';
import { rpc, state } from './bridge.js';

// --------------------------------------------------------------- 素材浅信息 ----

/** 由 mime 判断素材种类；不认识的一律 'other'。 */
export function assetKindOf(asset) {
  const mime = String((asset && asset.mime) || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  return 'other';
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 工程素材 → env.assets 的浅清单（不给路径、不给位图，卡片只该用它做选择）。
 * @returns {Array<{id, kind, width, height, duration}>}
 */
export function assetSummary(assets) {
  const out = [];
  for (const asset of assets || []) {
    if (!asset || !asset.id) continue;
    const probe = asset.probe || {};
    out.push({
      id: asset.id,
      kind: assetKindOf(asset),
      width: positive(probe.width),
      height: positive(probe.height),
      duration: positive(probe.duration),
    });
  }
  return out;
}

/**
 * 图层局部时间 → 素材取帧时间。越界一律夹紧，绝不给负时间。
 * 时长未知时只保证非负。
 */
export function mediaFrameTime(localT, duration) {
  const t = Number(localT);
  const safe = Number.isFinite(t) ? t : 0;
  const total = Number(duration);
  if (Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.min(safe, Math.max(0, total - 1e-3)));
  }
  return Math.max(0, safe);
}

// --------------------------------------------------------- 主线程媒体桥 ----

const DEFAULT_MEDIA_TIMEOUT_MS = 2500;

function waitForEvent(target, events, timeoutMs, ready) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ok);
    };
    const onOk = () => finish(true);
    const onErr = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      for (const event of events) target.removeEventListener(event, onOk);
      target.removeEventListener('error', onErr);
    }
    for (const event of events) target.addEventListener(event, onOk, { once: true });
    target.addEventListener('error', onErr, { once: true });
    // 事件可能在我们挂监听之前就已经发生（readyState 已经到位）；再查一次。
    if (typeof ready === 'function') {
      let already = false;
      try {
        already = !!ready();
      } catch (error) {
        already = false;
      }
      if (already) finish(true);
    }
  });
}

/**
 * 默认媒体桥：真的去解码。
 *
 * 这里刻意**不复用 player 的预览池** —— 预览池的 <video> 正被时间线媒体图层
 * 按播放头驱动；代码图层如果也去 seek 同一批元素，两边会互相把currentTime
 * 拽走，画面上就是「视频抖一下」。多一组静音元素换一条干净的 seek 通道。
 */
export function createDomMediaBridge(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_MEDIA_TIMEOUT_MS;
  const urlFor = typeof options.urlFor === 'function' ? options.urlFor : () => null;
  // 合成通道由注册表注入（它知道 drawFrame / 时间线 / revision）。
  // 不注入时 composeNeighborFrame 一律返回 null，老行为不受影响。
  const compose = typeof options.compose === 'function' ? options.compose : null;
  const videos = new Map(); // assetId -> { v, url, failed }
  const images = new Map(); // assetId -> HTMLImageElement
  const canCreate = () => typeof document !== 'undefined' && typeof document.createElement === 'function';

  function releaseVideo(assetId) {
    const entry = videos.get(assetId);
    if (!entry) return;
    try {
      entry.v.pause();
      entry.v.removeAttribute('src');
      entry.v.load();
    } catch (error) {
      /* 忽略 */
    }
    videos.delete(assetId);
  }

  function videoEntry(asset, url) {
    const existing = videos.get(asset.id);
    if (existing && existing.url === url) return existing;
    if (existing) releaseVideo(asset.id);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.src = url;
    video.load();
    const entry = { v: video, url: url, failed: false };
    video.addEventListener('error', () => {
      entry.failed = true;
    });
    videos.set(asset.id, entry);
    return entry;
  }

  async function videoFrame(asset, localT, url) {
    const entry = videoEntry(asset, url);
    const video = entry.v;
    if (entry.failed || video.error) return null;

    if (video.readyState < 1) {
      const ready = await waitForEvent(video, ['loadedmetadata'], timeoutMs, () => video.readyState >= 1);
      if (!ready) return null;
    }
    if (video.readyState < 2) {
      const ready = await waitForEvent(video, ['loadeddata', 'canplay'], timeoutMs, () => video.readyState >= 2);
      if (!ready) return null;
    }
    if (video.error || video.readyState < 2 || !(video.videoWidth > 0)) return null;

    const sourceDuration =
      Number.isFinite(video.duration) && video.duration > 0 ? video.duration : positive(asset.probe && asset.probe.duration) || 0;
    const want = mediaFrameTime(localT, sourceDuration);

    if (Math.abs(video.currentTime - want) > 1e-3) {
      if (!video.paused) video.pause();
      let seeked;
      try {
        video.currentTime = want;
        // 有的浏览器同步就把 seeking/currentTime 更新完，此时不该再等一个不会来的事件。
        seeked = video.seeking
          ? waitForEvent(video, ['seeked'], timeoutMs, () => !video.seeking && Math.abs(video.currentTime - want) <= 1e-3)
          : Promise.resolve(Math.abs(video.currentTime - want) <= 1e-3);
      } catch (error) {
        return null;
      }
      const ok = await seeked;
      // seek 失败就返回 null：宁可让卡片画占位，也不拿上一帧冒充当前帧。
      if (!ok) return null;
    }

    // 再核对一次：浏览器偶尔把 seek 停在关键帧附近，差太远就不认。
    if (!(Math.abs(video.currentTime - want) <= 0.25)) return null;

    let bitmap;
    try {
      if (typeof createImageBitmap !== 'function') return null;
      bitmap = await createImageBitmap(video);
    } catch (error) {
      return null;
    }
    return { bitmap: bitmap, width: video.videoWidth, height: video.videoHeight, time: video.currentTime };
  }

  async function imageFrame(asset, url) {
    let image = images.get(asset.id);
    if (image && image.__codeMediaUrl !== url) {
      images.delete(asset.id);
      image = null;
    }
    if (!image) {
      image = document.createElement('img');
      image.crossOrigin = 'anonymous';
      image.decoding = 'async';
      image.__codeMediaUrl = url;
      const loaded = new Promise((resolve) => {
        image.onload = () => resolve(true);
        image.onerror = () => resolve(false);
      });
      image.src = url;
      images.set(asset.id, image);
      const timer = new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs));
      const ok = await Promise.race([loaded, timer]);
      if (!ok || !(image.naturalWidth > 0)) {
        images.delete(asset.id);
        return null;
      }
    }
    if (!(image.naturalWidth > 0)) return null;
    try {
      const bitmap = await createImageBitmap(image);
      return { bitmap: bitmap, width: image.naturalWidth, height: image.naturalHeight, time: null };
    } catch (error) {
      return null;
    }
  }

  return {
    /**
     * 合成取帧：按**时间线时间**把整帧合成成一张位图（含邻镜的 transform / 滤镜 /
     * 蒙版 / 上层的媒体与文字叠层），给转场卡当邻帧用。
     *
     * 失败（没有合成通道 / 合成出错 / 超时）返回 null，并把中文原因写进诊断；
     * **不抛**。返回的位图归调用方所有（可以 transfer / close），缓存里那一份不会被交出去。
     *
     * @param {number} globalTime 时间线时间（秒）
     * @param {{clipId?: string}} [info] 请求方片段 id（只用于诊断）
     * @returns {Promise<ImageBitmap|null>}
     */
    async composeNeighborFrame(globalTime, info) {
      if (!compose) return null;
      let entry = null;
      try {
        entry = await compose(globalTime, info || {});
      } catch (error) {
        entry = null;
      }
      if (!entry || !entry.bitmap) return null;
      try {
        // 缓存里的那一份不能被 transfer 走，必须复制一份给调用方。
        if (typeof createImageBitmap !== 'function') return null;
        return await createImageBitmap(entry.bitmap);
      } catch (error) {
        return null;
      }
    },
    /**
     * 按**源时间**（素材自己的时间轴，秒）取一帧。转场上下文取邻帧走这里：
     * 「前一镜最后一帧」= 源时间 duration-ε，「后一镜第一帧」= 源时间 0+ε。
     * 内部复用同一套 <video> 池与 seek 核对逻辑，所以失败语义与 media 通道一致：
     * 任何一步不满足就返回 null，不拿上一帧冒充。
     *
     * @param {object} asset 素材记录（需要 id / mime / probe）
     * @param {number} sourceTime 素材源时间（秒）
     * @returns {Promise<null | {bitmap, width, height, time}>}
     */
    async frameAt(asset, sourceTime) {
      if (!canCreate() || typeof createImageBitmap !== 'function') return null;
      if (!asset || !asset.id) return null;
      const kind = assetKindOf(asset);
      if (kind !== 'video' && kind !== 'image') return null;
      const url = urlFor(asset.id);
      if (!url) return null;
      try {
        if (kind === 'image') return await imageFrame(asset, url);
        return await videoFrame(asset, sourceTime, url);
      } catch (error) {
        // 取邻帧失败不该毁掉这一帧：卡片会拿到 null 并走降级分支。
        return null;
      }
    },
    /**
     * @param {Array<{id:string}>} needs 模块声明的媒体需求
     * @param {Map<string, object>} byId 素材表
     * @param {number} localT 片段局部时间
     * @returns {Promise<{frames: Array}>} 位图由调用方 transfer 给 worker
     */
    async frames(needs, byId, localT) {
      const frames = [];
      if (!canCreate() || typeof createImageBitmap !== 'function') return { frames: frames };
      for (const need of needs || []) {
        const asset = byId.get(need && need.id);
        if (!asset) continue;
        const kind = assetKindOf(asset);
        if (kind !== 'video' && kind !== 'image') continue;
        const url = urlFor(asset.id);
        if (!url) continue;
        const frame = kind === 'video' ? await videoFrame(asset, localT, url) : await imageFrame(asset, url);
        if (!frame || !frame.bitmap) continue;
        frames.push({
          id: asset.id,
          kind: kind,
          bitmap: frame.bitmap,
          width: frame.width,
          height: frame.height,
          time: frame.time,
        });
      }
      return { frames: frames };
    },
    dispose() {
      for (const id of [...videos.keys()]) releaseVideo(id);
      for (const image of images.values()) {
        try {
          image.src = '';
        } catch (error) {
          /* 忽略 */
        }
      }
      images.clear();
    },
  };
}

// ------------------------------------------------------------- 转场上下文 ----
//
// 「转场类」代码图层（圆形匹配光圈、藏切点…）的卖点是「切点两侧对得上」。
// 它们需要知道三件事：切点在自己时间轴的哪里、前面那一镜最后一帧、
// 后面那一镜第一帧。这里只做纯计算与帧准备，取帧仍然走媒体桥
// （主线程 seek → createImageBitmap），和 media 通道共用同一套失败语义。
//
// 数据来源：context.clips / context.tracks（默认取 state.clips / state.doc.tracks），
// 与合成器 frameLayers 用的是同一份时间线，所以预览 / 导出 / 采样看到同一个切点。

/** 帧级 LRU 默认容量：8 帧。 */
export const TRANSITION_CACHE_LIMIT = 8;
/** 判断「切点这一侧有没有片段」时的时间试探量（秒）。比一帧还小。 */
export const TRANSITION_EPSILON = 0.0005;
const DEFAULT_TRANSITION_TIMEOUT_MS = 2500;

const REASON_TEXT = {
  none: '这一侧没有相邻片段',
  ok: '',
  'no-media': '相邻片段不是媒体（文字卡 / 纯色卡 / 代码卡），没有可取的源帧',
  'no-asset': '相邻片段引用的素材不在工程素材表里',
  'decode-failed': '取帧失败：seek 超时、落点偏差过大或解码失败',
  timeout: '取帧超时',
  'compose-failed': '合成邻帧失败：无法按这一时刻合成画面（详见合成诊断）',
  'compose-timeout': '合成邻帧超时',
  'copy-failed': '取帧成功但无法复制位图（浏览器不支持 createImageBitmap(ImageBitmap)）',
  'no-bridge': '当前环境没有可用的媒体桥（无法解码）',
};

/** 原因码 → 中文诊断（卡片可以直接画在画面角落排查用）。 */
export function transitionReasonText(reason, detail) {
  const base = REASON_TEXT[reason];
  if (base === undefined) return detail ? String(detail) : '未知原因：' + String(reason);
  if (reason === 'timeout' && detail) return base + '（>' + Math.round(Number(detail)) + 'ms）';
  return base;
}

const finiteNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function clipKindOf(clip) {
  if (!clip) return '';
  if (clip.type === 'media') return 'video';
  if (clip.type === 'code') return 'code';
  if (clip.type === 'text') return 'text';
  if (clip.type === 'audio') return 'audio';
  return 'other';
}

function trackKindOf(trackId, tracks) {
  if (!trackId || !Array.isArray(tracks)) return '';
  const found = tracks.find((t) => t && t.id === trackId);
  return found && found.kind ? String(found.kind) : '';
}

const TRACK_ORDER = { video: 0, code: 1, text: 2, other: 3, audio: 9 };

function trackRank(kind, trackId, tracks) {
  const order = TRACK_ORDER[kind] === undefined ? 3 : TRACK_ORDER[kind];
  const index = Array.isArray(tracks) ? tracks.findIndex((t) => t && t.id === trackId) : -1;
  return [order, index < 0 ? 99 : index];
}

/**
 * 切点归一化：给了就用（夹到 [0, duration]），没给就交给调用方推断。
 * 越界不抛错 —— 一个坏 props 不该让整帧黑掉，夹紧后那一侧自然没有邻居。
 *
 * @returns {{cutAt:number, supplied:boolean, clamped:boolean}}
 */
export function normalizeCutAt(value, duration) {
  const total = Number(duration);
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
  const raw = value === null || value === undefined || value === '' ? NaN : Number(value);
  if (!Number.isFinite(raw)) return { cutAt: safeTotal / 2, supplied: false, clamped: false };
  const cutAt = Math.max(0, Math.min(safeTotal, raw));
  return { cutAt, supplied: true, clamped: cutAt !== raw };
}

/**
 * 从时间线里推断「这个图层盖住的真实切点」：同一条视觉轨上 A 结束、B 开始的时刻。
 * 多个候选时取离 duration/2 最近的那个（转场图层通常把切点放在中间）。
 * 没有真切点返回 null。
 */
export function inferCutOffset(clip, clips, tracks) {
  const start = Number(clip && clip.start);
  const duration = Number(clip && clip.duration);
  if (!Number.isFinite(start) || !(duration > 0)) return null;
  const mid = duration / 2;
  let best = null;
  const byTrack = new Map();
  for (const other of clips || []) {
    if (!other || !other.id || other.id === clip.id) continue;
    if (clipKindOf(other) !== 'video') continue;
    if (other.trackId && clip.trackId && other.trackId === clip.trackId) continue;
    const trackId = String(other.trackId || '');
    if (!byTrack.has(trackId)) byTrack.set(trackId, []);
    byTrack.get(trackId).push(other);
  }
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const next = list[i];
      if (Math.abs(prev.start + prev.duration - next.start) > 1e-3) continue;
      const local = next.start - start;
      if (!(local > 1e-6 && local < duration - 1e-6)) continue;
      const score = Math.abs(local - mid);
      if (!best || score < best.score) best = { offset: local, score };
    }
  }
  return best ? best.offset : null;
}

/**
 * 相邻片段的结构判定：在 cutGlobal-ε 上正在播的是「前一镜」，+ε 上是「后一镜」。
 * 只在**别的轨道**上找 —— 转场图层自己是盖在切点上的一层，不是被它盖住的那一镜。
 * 主轨（video 类型里最靠前的轨道）优先，其次代码轨、文字轨；音频轨不参与。
 */
export function pickNeighborClip(clip, clips, tracks, t) {
  const candidates = [];
  for (const other of clips || []) {
    if (!other || !other.id || !other.trackId) continue;
    if (other.id === clip.id) continue;
    if (clip.trackId && other.trackId === clip.trackId) continue;
    const kind = trackKindOf(other.trackId, tracks) || clipKindOf(other);
    if (kind === 'audio') continue;
    const start = Number(other.start);
    const duration = Number(other.duration);
    if (!Number.isFinite(start) || !(duration > 0)) continue;
    if (!(start <= t && t < start + duration)) continue;
    candidates.push({ clip: other, rank: trackRank(kind, other.trackId, tracks) });
  }
  if (!candidates.length) return { has: false, clip: null, reason: 'none' };
  candidates.sort(
    (a, b) =>
      a.rank[0] - b.rank[0] ||
      a.rank[1] - b.rank[1] ||
      String(a.clip.id).localeCompare(String(b.clip.id)),
  );
  const best = candidates[0].clip;
  return { has: true, clip: best, reason: neighborFrameReason(best) };
}

/** 结构上有没有邻帧可取（还没查素材表）。 */
export function neighborFrameReason(clip) {
  if (!clip) return 'none';
  const kind = clipKindOf(clip);
  if (kind !== 'video') return 'no-media';
  if (!clip.assetId) return 'no-asset';
  return 'ok';
}

/**
 * 解析一个代码图层此刻的转场上下文。
 *
 * @param {object} clip 代码片段（需要 id / trackId / start / duration / props）
 * @param {{clips?:Array, tracks?:Array, fps?:number}} [options]
 * @returns {{cutAt:number, cutGlobal:number, source:'props'|'cut'|'middle'|'clamped',
 *            prev:object, next:object, fps:number}}
 */
export function resolveTransitionContext(clip, options = {}) {
  const clips = Array.isArray(options.clips) ? options.clips : [];
  const tracks = Array.isArray(options.tracks) ? options.tracks : [];
  const duration = Number(clip && clip.duration) > 0 ? Number(clip.duration) : 0;
  const fps = Number(options.fps) > 0 ? Number(options.fps) : 30;
  const props = (clip && clip.props) || {};
  const supplied = props.cutAt !== undefined && props.cutAt !== null ? props.cutAt : clip && clip.cutAt;
  const normalized = normalizeCutAt(supplied, duration);

  let cutAt = normalized.cutAt;
  let source = normalized.supplied ? 'props' : 'middle';
  if (normalized.clamped) source = 'clamped';
  if (!normalized.supplied) {
    const inferred = inferCutOffset(clip, clips, tracks);
    if (inferred !== null) {
      cutAt = inferred;
      source = 'cut';
    }
  }

  const start = Number(clip && clip.start) || 0;
  const cutGlobal = start + cutAt;
  return {
    cutAt,
    cutGlobal,
    source,
    fps,
    prev: pickNeighborClip(clip, clips, tracks, cutGlobal - TRANSITION_EPSILON),
    next: pickNeighborClip(clip, clips, tracks, cutGlobal + TRANSITION_EPSILON),
  };
}

/**
 * 邻帧默认取哪一帧（素材源时间，秒）：
 *   prev —— 前一镜**最后一帧**（duration - 半帧）
 *   next —— 后一镜**第一帧**（半帧）
 * 变速片段的映射交给 sourceOffsetOf，和合成器同一套公式。
 */
export function neighborFrameTime(neighbor, side, fps) {
  const duration = Number(neighbor && neighbor.duration);
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const frame = 1 / (Number(fps) > 0 ? Number(fps) : 30);
  const localT = side === 'next' ? Math.min(total, frame * 0.5) : Math.max(0, total - frame * 0.5);
  return Math.max(0, (Number(neighbor && neighbor.sourceIn) || 0) + sourceOffsetOf(neighbor || {}, localT));
}

/** 缓存键：同一 (clipId, 源时间) 只解码一次。worker 侧用同一套字面量算法。 */
export function transitionFrameKey(clipId, time) {
  const n = Number(time);
  const safe = Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
  return String(clipId) + '@' + safe.toFixed(3);
}

/**
 * 帧级 LRU。`load(key, loader)` 负责三件事：
 *   1) 命中直接返回（并把该键挪到最新）；
 *   2) 未命中才调 loader，成功才计入 decodes；
 *   3) 超过容量先淘汰最旧的（回调 onEvict 让调用方释放位图）。
 * 同一个 key 的并发请求会合并成一次 loader（single-flight）。
 */
export function createTransitionFrameCache(options = {}) {
  const limit = Math.max(1, Math.round(Number(options.limit) > 0 ? Number(options.limit) : TRANSITION_CACHE_LIMIT));
  const onEvict = typeof options.onEvict === 'function' ? options.onEvict : null;
  const map = new Map();
  const inflight = new Map();
  const stats = { hits: 0, misses: 0, decodes: 0, evictions: 0, failures: 0 };

  function evict(key) {
    const value = map.get(key);
    map.delete(key);
    stats.evictions += 1;
    if (onEvict) {
      try {
        onEvict(value, key);
      } catch (error) {
        /* 释放失败不该影响渲染 */
      }
    }
  }

  async function load(key, loader) {
    if (map.has(key)) {
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      stats.hits += 1;
      return value;
    }
    if (inflight.has(key)) return inflight.get(key);
    stats.misses += 1;
    const task = (async () => {
      let value = null;
      try {
        value = await loader();
      } catch (error) {
        value = null;
      }
      if (!value) {
        stats.failures += 1;
        return null;
      }
      stats.decodes += 1;
      while (map.size >= limit) evict(map.keys().next().value);
      map.set(key, value);
      return value;
    })();
    inflight.set(key, task);
    try {
      return await task;
    } finally {
      inflight.delete(key);
    }
  }

  return {
    load,
    has: (key) => map.has(key),
    size: () => map.size,
    keys: () => [...map.keys()],
    stats,
    clear() {
      for (const key of [...map.keys()]) evict(key);
      inflight.clear();
    },
  };
}

// --------------------------------------------------------- 合成帧（composed） ----
//
// 原始素材帧只包含「邻镜这一帧的素材像素」：邻片的 transform / 滤镜 / 蒙版、
// 上层画中画、文字叠层都不在里面，于是圆形匹配、藏切点这类卡会对不上真实画面。
// 合成帧换一条路：按**时间线时间**跑一次完整合成（player.drawFrame），
// 把这一时刻所有媒体/文字图层烤进一张 960×540 的位图，再随 render 消息送进 worker。
//
// 成本：每帧一次整屏合成 + 每个媒体图层一次取帧。比素材帧贵一个量级，
// 所以只有模块显式声明 transitionNeeds.composed 才走这条路，缓存也只有 4 帧。

/** 合成帧 LRU 默认容量：4 帧（比素材帧更贵，容量更小）。 */
export const COMPOSITE_CACHE_LIMIT = 4;
const DEFAULT_COMPOSE_TIMEOUT_MS = 4000;

const COMPOSE_REASON_TEXT = {
  ok: '',
  'no-draw': '当前环境没有可用的合成器（drawFrame），无法合成邻帧',
  'no-layer': '这一时刻时间线上没有任何可合成的图层',
  'no-media': '邻镜没有取到素材帧（素材缺失 / 解码失败），无法合成',
  'no-canvas': '无法创建离屏画布，无法合成邻帧',
  'draw-error': '合成时报错：某一图层绘制失败',
  timeout: '合成邻帧超时',
  'compose-timeout': '合成邻帧超时',
  'bitmap-failed': '合成完成但无法转成位图',
  'no-compose': '这一帧没有可用的合成通道',
};

/** 合成失败原因码 → 中文诊断（会写进 cards 的 message 与注册表诊断）。 */
export function composeReasonText(reason, detail) {
  const base = COMPOSE_REASON_TEXT[reason];
  if (base === undefined) return detail ? String(detail) : '未知合成失败原因：' + String(reason);
  if ((reason === 'timeout' || reason === 'compose-timeout') && detail) {
    return base + '（>' + Math.round(Number(detail)) + 'ms）';
  }
  if (reason === 'draw-error' && detail) return base + '：' + String(detail);
  return base;
}

/** 合成帧缓存键：时间线时间（毫秒量化）+ 工程 revision。 */
export function compositeFrameKey(globalTime, revision) {
  const n = Number(globalTime);
  const ms = Number.isFinite(n) ? Math.round(n * 1000) : 0;
  const rev = Math.round(Number(revision) || 0);
  return 'c' + ms + 'ms@r' + rev;
}

/** worker 侧合成帧的帧表键（与素材帧的 clipId@源时间 区分开）。 */
export function composedFrameKey(clipId, globalTime) {
  const n = Number(globalTime);
  const ms = Number.isFinite(n) ? Math.round(n * 1000) : 0;
  return String(clipId) + '#c@' + ms;
}

/**
 * `transitionNeeds.composed` 的归一化：只认 prev / next / both / true。
 * 结果受「这一侧本来要不要邻帧」约束 —— 声明 both 但只调 prev，就只合成 prev。
 *
 * @returns {false|'prev'|'next'|'both'}
 */
export function normalizeComposedNeeds(value, wanted) {
  const prev = !!(wanted && wanted.prev);
  const next = !!(wanted && wanted.next);
  if (!prev && !next) return false;
  let side = false;
  if (value === true) side = 'both';
  else if (typeof value === 'string') {
    const s = value.toLowerCase();
    if (s === 'prev') side = 'prev';
    else if (s === 'next') side = 'next';
    else if (s === 'both' || s === 'all' || s === 'true') side = 'both';
  }
  if (!side) return false;
  if (side === 'both') {
    if (prev && next) return 'both';
    return prev ? 'prev' : 'next';
  }
  if (side === 'prev') return prev ? 'prev' : next ? 'next' : false;
  if (side === 'next') return next ? 'next' : prev ? 'prev' : false;
  return false;
}

function defaultCompositeCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') {
    try {
      return new OffscreenCanvas(width, height);
    } catch (error) {
      /* 有的环境暴露构造器却不可用，继续兜底 */
    }
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

function defaultCompositeBitmap(canvas) {
  if (!canvas) return Promise.resolve(null);
  if (typeof canvas.transferToImageBitmap === 'function') {
    return Promise.resolve(canvas.transferToImageBitmap());
  }
  if (typeof createImageBitmap === 'function') return createImageBitmap(canvas);
  return Promise.resolve(null);
}

/**
 * 合成帧 provider：把某一时间线时刻的整帧合成成一张 ImageBitmap。
 *
 * 关键约束（都是刻意的）：
 *   - **不画代码图层**。转场卡自己就在代码轨上，合成里再画代码层是递归；
 *     文字层与媒体层（含上层画中画）照常合成。
 *   - 出错一律返回 null + 中文诊断，**不抛**；失败不缓存（下一帧还有机会）。
 *   - 缓存键是「毫秒 + revision」，revision 一变整缓存作废。
 *   - 同一键的并发请求合并成一次合成（single-flight）。
 *
 * @param {object} [options]
 * @param {() => {clips:Array, assets:Array, revision?:number}} [options.context]
 * @param {(ctx:object, view:object) => void} [options.drawFrame]
 * @param {(clips:Array, t:number) => Array} [options.frameLayers]
 * @param {(clip:object, localT:number) => number} [options.sourceTime]
 * @param {(asset:object, sourceTime:number, clip:object) => Promise<object|null>} [options.resolveMediaFrame]
 *        返回 `{bitmap,width,height}` 或位图本身；**所有权归 provider**（合成后会 close）。
 */
export function createCompositeFrameProvider(options = {}) {
  const limit = Math.max(
    1,
    Math.round(Number(options.cacheLimit) > 0 ? Number(options.cacheLimit) : COMPOSITE_CACHE_LIMIT),
  );
  const width = Math.max(2, Math.round(Number(options.width) > 0 ? Number(options.width) : 960));
  const height = Math.max(2, Math.round(Number(options.height) > 0 ? Number(options.height) : 540));
  const drawFrame = typeof options.drawFrame === 'function' ? options.drawFrame : null;
  const frameLayers = typeof options.frameLayers === 'function' ? options.frameLayers : null;
  const sourceTime = typeof options.sourceTime === 'function' ? options.sourceTime : null;
  const resolveMediaFrame =
    typeof options.resolveMediaFrame === 'function' ? options.resolveMediaFrame : null;
  const context = typeof options.context === 'function' ? options.context : () => ({});
  const createCanvas = typeof options.createCanvas === 'function' ? options.createCanvas : defaultCompositeCanvas;
  const toBitmap = typeof options.toBitmap === 'function' ? options.toBitmap : defaultCompositeBitmap;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const log = typeof options.log === 'function' ? options.log : null;
  const timeoutMs =
    Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_COMPOSE_TIMEOUT_MS;

  const map = new Map();
  const inflight = new Map();
  let lastRevision = null;
  const stats = {
    hits: 0,
    misses: 0,
    builds: 0,
    evictions: 0,
    failures: 0,
    mediaDecodes: 0,
    lastMs: 0,
    totalMs: 0,
    maxMs: 0,
  };

  function closeBitmap(bitmap) {
    if (bitmap && typeof bitmap.close === 'function') {
      try {
        bitmap.close();
      } catch (error) {
        /* 已释放就算了 */
      }
    }
  }

  function note(code, detail, extra) {
    const message = composeReasonText(code, detail);
    const issue = Object.assign({ ok: false, code: code, message: message }, extra || {});
    if (log) {
      try {
        log(issue);
      } catch (error) {
        /* 诊断写失败不该影响渲染 */
      }
    }
    return issue;
  }

  function evictOldest() {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    const entry = map.get(oldest);
    map.delete(oldest);
    stats.evictions += 1;
    closeBitmap(entry && entry.bitmap);
  }

  function pruneRevision(revision) {
    if (lastRevision === null) {
      lastRevision = revision;
      return;
    }
    if (revision === lastRevision) return;
    lastRevision = revision;
    clear();
  }

  function safeContext() {
    try {
      return context() || {};
    } catch (error) {
      return {};
    }
  }

  function revisionOf(view) {
    return Math.round(Number(view && view.revision) || 0);
  }

  async function build(globalTime) {
    const started = now();
    const view = safeContext();
    if (!drawFrame || !frameLayers || !sourceTime) {
      return note('no-draw', '', { globalTime: globalTime });
    }
    const clips = Array.isArray(view.clips) ? view.clips : [];
    const assets = Array.isArray(view.assets) ? view.assets : [];
    const allLayers = frameLayers(clips, globalTime) || [];
    // 代码图层不参与合成：转场卡自己在代码轨上，合成里再画代码层会递归。
    const layers = allLayers.filter((layer) => layer && layer.kind !== 'code');
    if (!layers.length) return note('no-layer', '', { globalTime: globalTime });

    const byId = new Map(assets.filter((a) => a && a.id).map((a) => [a.id, a]));
    const media = new Map();
    const owned = [];
    for (const layer of layers) {
      if (layer.kind !== 'media') continue;
      const clip = layer.clip;
      if (!clip || !clip.assetId || !resolveMediaFrame) continue;
      const asset = byId.get(clip.assetId);
      if (!asset) continue;
      let frame = null;
      try {
        frame = await resolveMediaFrame(asset, sourceTime(clip, layer.localT), clip);
      } catch (error) {
        frame = null;
      }
      if (!frame) continue;
      const bitmap = frame.bitmap || frame;
      if (!bitmap) continue;
      media.set(clip.id, bitmap);
      owned.push(bitmap);
      stats.mediaDecodes += 1;
    }
    if (!media.size) {
      return note('no-media', '', { globalTime: globalTime });
    }

    const canvas = createCanvas(width, height);
    if (!canvas || typeof canvas.getContext !== 'function') {
      closeOwned(owned);
      return note('no-canvas', '', { globalTime: globalTime });
    }
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) {
      closeOwned(owned);
      return note('no-canvas', '', { globalTime: globalTime });
    }

    try {
      drawFrame(ctx, {
        clips: clips,
        assets: assets,
        t: globalTime,
        width: width,
        height: height,
        layers: layers,
        mediaFrame: (clip) => (clip && media.get(clip.id)) || null,
      });
    } catch (error) {
      closeOwned(owned);
      return note('draw-error', error && error.message, { globalTime: globalTime });
    }
    closeOwned(owned);

    let bitmap = null;
    try {
      bitmap = await toBitmap(canvas);
    } catch (error) {
      bitmap = null;
    }
    if (!bitmap) return note('bitmap-failed', '', { globalTime: globalTime });

    const ms = Math.max(0, now() - started);
    stats.builds += 1;
    stats.totalMs += ms;
    stats.lastMs = ms;
    stats.maxMs = Math.max(stats.maxMs, ms);
    return {
      ok: true,
      code: 'ok',
      message: '',
      bitmap: bitmap,
      width: width,
      height: height,
      time: globalTime,
      ms: ms,
      cached: false,
    };
  }

  function closeOwned(list) {
    for (const bitmap of list) closeBitmap(bitmap);
  }

  function raceTimeout(promise, ms) {
    if (!(ms > 0)) return promise.then((value) => ({ timedOut: false, value: value }));
    const TIMEOUT = { __timeout: true };
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), ms);
    });
    return Promise.race([promise, timeout]).then(
      (value) => {
        if (timer) clearTimeout(timer);
        return { timedOut: value === TIMEOUT, value: value === TIMEOUT ? null : value };
      },
      (error) => {
        if (timer) clearTimeout(timer);
        return { timedOut: false, value: null, error: error };
      },
    );
  }

  function clear() {
    for (const key of [...map.keys()]) {
      const entry = map.get(key);
      map.delete(key);
      closeBitmap(entry && entry.bitmap);
    }
    inflight.clear();
  }

  /**
   * 合成某一时间线时刻的一帧。
   *
   * @param {number} globalTime 时间线时间（秒）
   * @param {{clipId?:string}} [info] 请求方（只用于诊断）
   * @returns {Promise<null | {bitmap,width,height,time,ms,cached}>}
   */
  async function compose(globalTime, info) {
    const t = Number(globalTime);
    if (!Number.isFinite(t)) return null;
    const clipId = info && info.clipId ? String(info.clipId) : null;
    const view = safeContext();
    const revision = revisionOf(view);
    pruneRevision(revision);
    const key = compositeFrameKey(t, revision);

    if (map.has(key)) {
      const entry = map.get(key);
      map.delete(key);
      map.set(key, entry);
      stats.hits += 1;
      return Object.assign({}, entry, { cached: true });
    }
    if (inflight.has(key)) return inflight.get(key);

    stats.misses += 1;
    const task = (async () => {
      const result = await raceTimeout(build(t), timeoutMs);
      if (result.timedOut) {
        stats.failures += 1;
        note('timeout', timeoutMs, { globalTime: t, clipId: clipId });
        return null;
      }
      const entry = result.value;
      if (!entry || !entry.ok || !entry.bitmap) {
        stats.failures += 1;
        return null;
      }
      while (map.size >= limit) evictOldest();
      map.set(key, entry);
      return Object.assign({}, entry, { cached: false });
    })();

    inflight.set(key, task);
    try {
      return await task;
    } finally {
      inflight.delete(key);
    }
  }

  return {
    compose,
    width: width,
    height: height,
    cacheLimit: limit,
    size: () => map.size,
    keys: () => [...map.keys()],
    stats,
    clear,
    dispose: clear,
  };
}

// ------------------------------------------------------- 预览播放循环 ----
//
// 旧实现的两个坑（docs/playback-loop.md 有一整份推导与实测）：
//   1) 用**墙钟**判断「这一帧要不要重画」：`now - lastAt < (playing ? 16 : 40)`
//      —— 120Hz 屏幕上每个 rAF 只有 8.3ms，于是每隔一帧就被砍掉；
//   2) `renderCode(...)` fire-and-forget：每个 rAF 都往图层的串行渲染链里塞一帧，
//      渲染比帧率慢时队列无限增长，画面越来越落后（25ms 渲染 / 60Hz → 3 秒后落后约 1 秒），
//      而且「取帧/转场准备」的耗时抖动会让后发的请求先到，旧帧盖掉新帧。
//
// 现在的规则只有三条：
//   1) 时间只来自播放头；墙钟只用来记指标，不用来丢帧；
//   2) 每个图层最多一份渲染在飞。在飞期间的新请求只更新 wantT（合并），不排队；
//   3) 渲染完成后比对 generation：只有**最新一代**算上屏；过期结果计入 staleDrops 并丢弃，
//      紧接着用最新的 wantT 再渲一次。
// 于是：渲染跟不上时呈现帧率下降，但呈现的 t 单调、永不回退、永不是过期帧。

/** presentedFps 的统计窗口（毫秒）。 */
export const PRESENTED_FPS_WINDOW_MS = 1000;

/** 把一段文本稳定成纳秒级比较用的整数（避免 1.0000001 之类的抖动触发重渲）。 */
function timeKey(t) {
  return Math.round(Number(t) * 1e6);
}



/**
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {(error: Error, clip: object) => void} [opts.onError]
 * @param {() => {assets: Array, fps: number, duration?: number}} [opts.context] 素材/帧率来源（测试注入）
 * @param {object|null} [opts.mediaBridge] 媒体桥；传 null 表示完全关闭媒体注入
 * @param {(assetId: string) => string} [opts.urlFor]
 * @param {(layerId: string) => Promise<string>} [opts.readLayerSource]
 * @param {typeof createCodeLayer} [opts.layerFactory]
 */
export function createCodeRegistry(opts = {}) {
  const projectId = opts.projectId;
  const onError = opts.onError;
  const records = new Map(); // clipId -> { key, layer, wantT/wantGen, inflight, doneT/doneKey }
  const layerFactory = typeof opts.layerFactory === 'function' ? opts.layerFactory : createCodeLayer;

  let bridge = null;

  function defaultContext() {
    const doc = state.doc || {};
    const assets = (state.assets && state.assets.length ? state.assets : doc.assets) || [];
    return {
      assets: assets,
      fps: Number(doc.fps) || 30,
      duration: Number(doc.duration) || 0,
      clips: state.clips || doc.clips || [],
      tracks: doc.tracks || [],
      // 合成帧缓存按它作废：revision 一变，旧帧对应的就是别的时间线了。
      revision: Math.round(Number(doc.revision) || 0),
      doc: doc,
    };
  }

  function readContext() {
    try {
      return (typeof opts.context === 'function' ? opts.context() : defaultContext()) || { assets: [], fps: 30 };
    } catch (error) {
      return { assets: [], fps: 30 };
    }
  }

  function assetUrl(assetId) {
    if (typeof opts.urlFor === 'function') return opts.urlFor(assetId);
    return (
      '/api/video/media?projectId=' + encodeURIComponent(projectId) +
      '&assetId=' + encodeURIComponent(assetId) +
      '&variant=preview'
    );
  }

  function getBridge() {
    if (bridge) return bridge;
    if (opts.mediaBridge === null) return null;
    if (opts.mediaBridge) {
      bridge = opts.mediaBridge;
      return bridge;
    }
    bridge = createDomMediaBridge({
      urlFor: assetUrl,
      timeoutMs: opts.mediaTimeoutMs,
      // 媒体桥的合成入口最终落到注册表的合成 provider（它知道时间线与 revision）。
      compose: (globalTime, info) => composeFrameAt(globalTime, info),
    });
    return bridge;
  }

  async function readLayerSource(layerId) {
    if (typeof opts.readLayerSource === 'function') return opts.readLayerSource(layerId);
    const value = await rpc('code.read', { projectId, layerId });
    return value && value.source;
  }

  // 素材清单每帧都会用到；引用没变就不重算。
  let summaryRef = null;
  let summary = [];
  let byId = new Map();
  // 时间线引用：变了就说明发生过编辑，邻帧缓存要作废。
  let clipsRef = null;

  function contextAssets(context) {
    const assets = (context && context.assets) || [];
    if (assets !== summaryRef) {
      summaryRef = assets;
      summary = assetSummary(assets);
      byId = new Map(assets.filter((a) => a && a.id).map((a) => [a.id, a]));
    }
    return { summary: summary, byId: byId };
  }

  // ---- 转场上下文：帧缓存 + 邻帧准备 ----

  function closeBitmap(bitmap) {
    if (bitmap && typeof bitmap.close === 'function') {
      try {
        bitmap.close();
      } catch (error) {
        /* 已释放就算了 */
      }
    }
  }

  const transitionCache = createTransitionFrameCache({
    limit: opts.transitionCacheLimit,
    onEvict:
      typeof opts.onTransitionFrameEvict === 'function'
        ? opts.onTransitionFrameEvict
        : (entry) => closeBitmap(entry && entry.bitmap),
  });

  async function copyFrameForTransfer(bitmap) {
    // 缓存里那一份不能被 transfer 走，必须复制一份给 worker。
    if (typeof opts.copyFrame === 'function') return opts.copyFrame(bitmap);
    if (typeof createImageBitmap !== 'function') return null;
    return createImageBitmap(bitmap);
  }

  function withTimeout(promise, timeoutMs) {
    if (!(timeoutMs > 0)) return promise.then((value) => ({ value, timedOut: false }));
    const TIMEOUT = { __timeout: true };
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    });
    return Promise.race([promise, timeout]).then(
      (value) => {
        if (timer) clearTimeout(timer);
        return { value: value === TIMEOUT ? null : value, timedOut: value === TIMEOUT };
      },
      (error) => {
        if (timer) clearTimeout(timer);
        return { value: null, timedOut: false, error };
      },
    );
  }

  function bareSide(info) {
    return {
      has: !!(info && info.has),
      clipId: info && info.clip ? String(info.clip.id) : null,
      reason: info && info.reason ? String(info.reason) : 'none',
      message: transitionReasonText(info && info.reason),
      time: null,
      // 这一侧拿到的是不是合成帧。合成失败时保持 false，frame() 返回 null（rawFrame 仍可用）。
      composed: false,
      // 这一侧**有没有要求**合成。合成失败时 composed=false 但 wanted=true，
      // worker 据此决定 frame() 返回 null 而不是退回原始帧。
      composedWanted: false,
      composedKey: null,
    };
  }

  // ---- 合成帧（composed）：把「邻镜在这一时刻的真实画面」整帧合成出来 ----
  // 只有模块显式声明 transitionNeeds.composed 才会走到这里；老卡片一次也不合成。

  const composeDiagnostics = Array.isArray(opts.composeDiagnostics) ? opts.composeDiagnostics : null;
  let lastComposeDiagnostic = null;
  let composer = null;

  function recordComposeDiagnostic(issue) {
    if (!issue) return;
    const record = Object.assign({ at: Date.now() }, issue);
    lastComposeDiagnostic = record;
    if (composeDiagnostics) composeDiagnostics.push(record);
    if (typeof opts.onComposeDiagnostic === 'function') {
      try {
        opts.onComposeDiagnostic(record);
      } catch (error) {
        /* 诊断回调里的错不该影响渲染 */
      }
    }
  }

  function getComposer() {
    if (composer) return composer;
    if (typeof opts.composeFrame === 'function') {
      composer = { compose: (globalTime, info) => opts.composeFrame(globalTime, info), stats: null };
      return composer;
    }
    composer = createCompositeFrameProvider({
      width: opts.composeWidth,
      height: opts.composeHeight,
      context: () => {
        const current = readContext();
        return { clips: current.clips, assets: current.assets, revision: current.revision };
      },
      drawFrame: typeof opts.drawFrame === 'function' ? opts.drawFrame : playerDrawFrame,
      frameLayers: typeof opts.frameLayers === 'function' ? opts.frameLayers : playerFrameLayers,
      sourceTime: typeof opts.sourceTime === 'function' ? opts.sourceTime : playerSourceTime,
      resolveMediaFrame: (asset, sourceTime) => {
        const mediaBridge = getBridge();
        if (!mediaBridge || typeof mediaBridge.frameAt !== 'function') return null;
        return mediaBridge.frameAt(asset, sourceTime);
      },
      cacheLimit: opts.compositeCacheLimit,
      timeoutMs: opts.composeTimeoutMs,
      log: recordComposeDiagnostic,
    });
    return composer;
  }

  /** 合成一帧；任何异常都折叠成 null（诊断已经写进 composeDiagnostics）。 */
  async function composeFrameAt(globalTime, info) {
    try {
      return await getComposer().compose(globalTime, info || {});
    } catch (error) {
      return null;
    }
  }

  async function prepareSide(side, info, context, frames, globalTime, composedWanted) {
    const out = bareSide(info);
    out.composedWanted = !!composedWanted;
    if (!out.has || !info.clip) return out;
    if (out.reason !== 'ok') return out;

    const neighbor = info.clip;
    const assets = contextAssets(context);
    const asset = assets.byId.get(neighbor.assetId);
    if (!asset) {
      out.reason = 'no-asset';
      out.message = transitionReasonText('no-asset');
      return out;
    }
    const kind = assetKindOf(asset);
    if (kind !== 'video' && kind !== 'image') {
      out.reason = 'no-media';
      out.message = transitionReasonText('no-media');
      return out;
    }

    const fps = Number(context.fps) > 0 ? Number(context.fps) : 30;
    const time = neighborFrameTime(neighbor, side, fps);
    out.time = time;
    const key = transitionFrameKey(neighbor.id, time);
    const timeoutMs =
      Number(opts.transitionTimeoutMs) > 0 ? Number(opts.transitionTimeoutMs) : DEFAULT_TRANSITION_TIMEOUT_MS;

    const prepared = await withTimeout(
      transitionCache.load(key, async () => {
        const mediaBridge = getBridge();
        if (!mediaBridge || typeof mediaBridge.frameAt !== 'function') return null;
        try {
          return await mediaBridge.frameAt(asset, time);
        } catch (error) {
          return null;
        }
      }),
      timeoutMs,
    );

    if (prepared.timedOut) {
      out.reason = 'timeout';
      out.message = transitionReasonText('timeout', timeoutMs);
    } else if (!prepared.value || !prepared.value.bitmap) {
      out.reason = 'decode-failed';
      out.message = transitionReasonText('decode-failed');
    } else {
      let bitmap = null;
      try {
        bitmap = await copyFrameForTransfer(prepared.value.bitmap);
      } catch (error) {
        bitmap = null;
      }
      if (!bitmap) {
        out.reason = 'copy-failed';
        out.message = transitionReasonText('copy-failed');
      } else {
        out.reason = 'ok';
        out.message = '';
        frames.push({
          key: key,
          bitmap: bitmap,
          width: Number(prepared.value.width) || 0,
          height: Number(prepared.value.height) || 0,
          time: time,
          clipId: out.clipId,
          side: side,
          composed: false,
        });
      }
    }

    if (!composedWanted) return out;

    // 合成帧：失败时 frame() 返回 null、composed=false —— 不拿原始帧冒充合成帧。
    const composeTimeoutMs =
      Number(opts.composeTimeoutMs) > 0 ? Number(opts.composeTimeoutMs) : DEFAULT_COMPOSE_TIMEOUT_MS;
    const composedKey = composedFrameKey(neighbor.id, globalTime);
    const composedPrepared = await withTimeout(
      composeFrameAt(globalTime, { clipId: out.clipId, revision: context.revision, side: side }),
      composeTimeoutMs,
    );
    if (composedPrepared.timedOut) {
      out.reason = 'compose-timeout';
      out.message = composeReasonText('compose-timeout', composeTimeoutMs);
      out.composed = false;
      return out;
    }
    const entry = composedPrepared.value;
    if (!entry || !entry.bitmap) {
      out.reason = 'compose-failed';
      out.message =
        (lastComposeDiagnostic && lastComposeDiagnostic.globalTime === globalTime && lastComposeDiagnostic.message) ||
        composeReasonText('compose-failed');
      out.composed = false;
      return out;
    }

    let composedBitmap = null;
    try {
      composedBitmap = await copyFrameForTransfer(entry.bitmap);
    } catch (error) {
      composedBitmap = null;
    }
    if (!composedBitmap) {
      out.reason = 'copy-failed';
      out.message = transitionReasonText('copy-failed');
      out.composed = false;
      return out;
    }

    out.reason = 'ok';
    out.message = '';
    out.composed = true;
    out.composedKey = composedKey;
    frames.push({
      key: composedKey,
      bitmap: composedBitmap,
      width: Number(entry.width) || 0,
      height: Number(entry.height) || 0,
      time: globalTime,
      clipId: out.clipId,
      side: side,
      composed: true,
    });
    return out;
  }

  /**
   * 为这一帧准备转场上下文。结构信息（有没有邻居、切点在哪）永远给出；
   * 只有模块显式声明了 transitionNeeds 才真的解码邻帧 —— 老卡片不会多付一次 seek。
   */
  async function prepareTransition(clip, context, rec) {
    // 时间线一变（任何编辑都会换一个新 clips 数组），旧的邻帧缓存就可能对应到别的素材上了。
    // 清掉比「按 assetId 做键」简单，而且编辑不是每帧发生的。
    if (context.clips !== clipsRef) {
      if (clipsRef !== null) transitionCache.clear();
      clipsRef = context.clips;
    }
    const plan = resolveTransitionContext(clip, {
      clips: context.clips,
      tracks: context.tracks,
      fps: context.fps,
    });
    const payload = {
      cutAt: plan.cutAt,
      cutGlobal: plan.cutGlobal,
      declared: false,
      composed: false,
      source: plan.source,
      prev: bareSide(plan.prev),
      next: bareSide(plan.next),
    };
    const frames = [];

    let needs = null;
    try {
      needs = typeof rec.layer.transitionNeeds === 'function' ? rec.layer.transitionNeeds() : null;
    } catch (error) {
      needs = null;
    }
    const wanted = { prev: !!(needs && needs.prev), next: !!(needs && needs.next) };
    payload.declared = wanted.prev || wanted.next;
    if (!payload.declared) return { payload, frames };

    // composed 缺省 false：老卡只拿原始素材帧，一次合成都不做。
    const composedFor = normalizeComposedNeeds(needs && needs.composed, wanted);
    payload.composed = composedFor;

    if (wanted.prev) {
      payload.prev = await prepareSide(
        'prev',
        plan.prev,
        context,
        frames,
        plan.cutGlobal,
        composedFor === 'prev' || composedFor === 'both',
      );
    }
    if (wanted.next) {
      payload.next = await prepareSide(
        'next',
        plan.next,
        context,
        frames,
        plan.cutGlobal,
        composedFor === 'next' || composedFor === 'both',
      );
    }
    return { payload, frames };
  }

  async function ensure(clip) {
    const key = String(clip.layerId) + ':' + String(clip.codeHash || '');
    const existing = records.get(clip.id);
    if (existing && existing.key === key) return existing;
    if (existing) {
      existing.layer.dispose();
      records.delete(clip.id);
    }
    const [source, context] = [await readLayerSource(clip.layerId), readContext()];
    const assets = contextAssets(context);
    const layer = layerFactory({
      layerId: clip.layerId,
      moduleSource: source,
      props: clip.props || {},
      width: 960,
      height: 540,
      assets: assets.summary,
      fps: Number(context.fps) > 0 ? Number(context.fps) : 30,
      duration: Number(clip.duration) > 0 ? Number(clip.duration) : 0,
    });
    await layer.ready();
    const rec = {
      key: key,
      layer: layer,
      // 最近一次「请求过」的 t（诊断用）
      lastT: -999,
      // 预览：最新想要的一帧 / 它属于哪一代 / 正在渲染的那一代
      wantT: null,
      wantKey: null,
      wantGen: 0,
      inflight: null,
      inflightT: null,
      inflightKey: null,
      // 画布上现在真的是哪一帧（只有它算「上屏」）
      doneT: null,
      doneKey: null,
      doneGen: 0,
    };
    records.set(clip.id, rec);
    return rec;
  }

  function active(clips, t) {
    return clips.filter((c) => c.type === 'code' && t >= c.start && t < c.start + c.duration);
  }

  // ---- 预览播放：单飞 + 合并 + generation 丢弃 ----

  const presented = []; // 最近一个统计窗口内的上屏时刻（毫秒）
  const previewStats = {
    requested: 0,
    renders: 0,
    presented: 0,
    staleDrops: 0,
    lateFrames: 0,
    coalesced: 0,
  };

  const nowMs =
    typeof opts.now === 'function'
      ? opts.now
      : () =>
          typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();

  function notePresented() {
    const stamp = nowMs();
    previewStats.presented += 1;
    presented.push(stamp);
    const cut = stamp - PRESENTED_FPS_WINDOW_MS;
    while (presented.length && presented[0] < cut) presented.shift();
  }

  function presentedFps() {
    if (!presented.length) return 0;
    const now = nowMs();
    const span = Math.max(1, Math.min(PRESENTED_FPS_WINDOW_MS, now - presented[0]));
    return Math.round((presented.length / span) * 1000 * 10) / 10;
  }

  /**
   * 播放循环的指标（控制台可查：`__dshPlaybackStats()`）。
   *   requested      需要新帧的请求数（同一 t 的重复请求不算）
   *   renders        真正发起渲染的次数（≤ requested）
   *   presented      上屏的帧数（画布真的换过一次）
   *   droppedFrames  requested - presented：没被画出来的帧（合并掉的 + 还没轮到的）
   *   staleDrops     过期结果被丢弃的次数（播放头倒退 / 预览被导出作废）—— 正常播放恒为 0
   *   lateFrames     渲染完成时播放头已前进的帧数（仍上屏，是最新完成的一帧）
   *   coalesced      在飞期间被合并掉的新请求数
   *   presentedFps   最近一个窗口内的实际呈现帧率
   */
  function playbackStats() {
    return {
      requested: previewStats.requested,
      renders: previewStats.renders,
      presented: previewStats.presented,
      droppedFrames: Math.max(0, previewStats.requested - previewStats.presented),
      staleDrops: previewStats.staleDrops,
      lateFrames: previewStats.lateFrames,
      coalesced: previewStats.coalesced,
      presentedFps: presentedFps(),
      windowMs: PRESENTED_FPS_WINDOW_MS,
      layers: records.size,
    };
  }

  /**
   * 一份渲染在飞时，新的请求只更新 wantT；渲染完成后按 generation 判定上不上屏。
   * 这一层「单飞」是防旧帧盖新帧的关键：同一图层永远只有一份结果在写画布，
   * 所以完成顺序 = 开始顺序，t 在向前播放时单调。
   */
  async function pumpPreview(rec, clip) {
    for (;;) {
      const wantT = rec.wantT;
      if (wantT === null) return;
      const wantKey = rec.wantKey;
      const gen = rec.wantGen;
      rec.inflightT = wantT;
      rec.inflightKey = wantKey;
      previewStats.renders += 1;
      let ok = true;
      try {
        await renderCode(rec, clip, wantT);
      } catch (error) {
        ok = false;
        if (onError) onError(error, clip);
      }
      // 过期判定只看**播放头方向**，不看「渲染期间有没有来过新请求」：
      //   - 播放头前进（正常播放）：这份结果仍然是最新完成的一帧，上屏它，再立刻渲最新；
      //   - 播放头后退 / 预览被导出作废：它属于「过去的位置」，上屏就是旧帧盖新帧 —— 丢弃。
      const superseded = gen !== rec.wantGen;
      const wantNow = rec.wantT;
      const wentBackwards =
        superseded && (wantNow === null || (Number.isFinite(wantNow) && wantNow < wantT - 1e-9));
      if (wentBackwards) {
        previewStats.staleDrops += 1;
        if (wantNow === null) return;
        continue;
      }
      if (ok) {
        rec.doneT = wantT;
        rec.doneKey = wantKey;
        rec.doneGen = gen;
        if (superseded) previewStats.lateFrames += 1;
        notePresented();
      }
      if (!superseded) return;
    }
  }

  function startPreview(rec, clip) {
    if (rec.inflight) return rec.inflight;
    const task = pumpPreview(rec, clip);
    rec.inflight = task;
    const clear = () => {
      if (rec.inflight === task) {
        rec.inflight = null;
        rec.inflightT = null;
        rec.inflightKey = null;
      }
    };
    task.then(clear, clear);
    return task;
  }

  /**
   * 预览的一帧请求。返回 'skipped' | 'started' | 'coalesced'。
   * 只看「播放头要的是哪个 t」，**不看墙钟** —— 帧率由渲染能力决定。
   */
  function requestPreview(rec, clip, localT) {
    const want = Number(localT) || 0;
    const key = timeKey(want);
    if (rec.inflight) {
      // 正在渲染的就是这一帧：不重复请求，也不换代（否则会把在飞的一代误判成过期）
      if (rec.inflightKey === key) return 'skipped';
      rec.wantT = want;
      rec.wantKey = key;
      rec.wantGen += 1;
      rec.lastT = want;
      previewStats.requested += 1;
      previewStats.coalesced += 1;
      return 'coalesced';
    }
    // 画布上已经是这一帧：暂停 / 静止时到此为止，一个像素都不用重画
    if (rec.doneKey === key) return 'skipped';
    rec.wantT = want;
    rec.wantKey = key;
    rec.wantGen += 1;
    rec.lastT = want;
    previewStats.requested += 1;
    startPreview(rec, clip);
    return 'started';
  }

  /**
   * 让预览请求作废并等它落地。导出 / 采样要的是「这一刻」的确定结果，
   * 不能和预览抢同一块画布。
   */
  async function retirePreview(rec) {
    rec.wantT = null;
    rec.wantKey = null;
    rec.wantGen += 1;
    const task = rec.inflight;
    if (!task) return;
    try {
      await task;
    } catch (error) {
      /* 预览的错不该阻断导出 */
    }
  }

  /** 准备这一帧的媒体帧与邻帧，并等图层画完（导出/采样的严格路径）。 */
  async function renderCode(rec, clip, localT) {
    const context = readContext();
    const assets = contextAssets(context);
    let media = [];

    const needs = typeof rec.layer.mediaNeeds === 'function' ? rec.layer.mediaNeeds() : [];
    if (needs && needs.length) {
      const mediaBridge = getBridge();
      if (mediaBridge && typeof mediaBridge.frames === 'function') {
        try {
          const prepared = await mediaBridge.frames(needs, assets.byId, localT);
          media = (prepared && prepared.frames) || [];
        } catch (error) {
          // 媒体准备失败不是图层的错：降级成「没有媒体」，卡片自己画占位。
          media = [];
        }
      }
    }

    let transition = null;
    try {
      transition = await prepareTransition(clip, context, rec);
    } catch (error) {
      // 邻帧准备失败同样不该让整帧黑掉：给一个「有结构、没帧」的空上下文。
      transition = {
        payload: {
          cutAt: 0,
          declared: false,
          prev: bareSide({ has: false, reason: 'none' }),
          next: bareSide({ has: false, reason: 'none' }),
        },
        frames: [],
      };
    }

    await rec.layer.render(localT, {
      media: media,
      assets: assets.summary,
      fps: Number(context.fps) > 0 ? Number(context.fps) : 30,
      duration: Number(clip.duration) > 0 ? Number(clip.duration) : 0,
      transition: transition.payload,
      transitionFrames: transition.frames,
    });
  }

  /**
   * 预览：请求当前这一帧。不等待、不排队、不用墙钟丢帧。
   * 时间只来自播放头；重复的 t 直接跳过，正在渲染的 t 不重复请求。
   */
  async function tick(clips, t, playing) {
    void playing; // 旧里 playing 决定节流间隔；现在帧率由渲染能力决定，参数只为兼容保留
    for (const clip of active(clips, t)) {
      let rec;
      try {
        rec = await ensure(clip);
      } catch (e) {
        onError && onError(e, clip);
        continue;
      }
      requestPreview(rec, clip, t - clip.start);
    }
  }

  /** 导出：逐帧等待渲染完成（预览的请求先作废，避免两路抢同一块画布）。 */
  async function renderAt(clips, t) {
    for (const clip of active(clips, t)) {
      const rec = await ensure(clip);
      await retirePreview(rec);
      await renderCode(rec, clip, t - clip.start);
      rec.doneT = t - clip.start;
      rec.doneKey = timeKey(t - clip.start);
      rec.doneGen = rec.wantGen;
    }
  }

  /** 给合成器取某一帧的图层画布（没有就返回 null，合成器会跳过这一层）。 */
  function canvasFor(clip) {
    const rec = records.get(clip.id);
    return rec && rec.layer ? rec.layer.canvas() : null;
  }

  /**
   * 按合成器给的图层清单渲染代码图层。
   * localT 可能落在片段之外（转场要画相邻片段的延长帧），所以不能只按 active 过滤。
   */
  async function renderLayers(layers) {
    for (const layer of layers || []) {
      if (!layer || layer.kind !== 'code') continue;
      const rec = await ensure(layer.clip);
      await retirePreview(rec);
      await renderCode(rec, layer.clip, layer.localT);
      rec.doneT = layer.localT;
      rec.doneKey = timeKey(layer.localT);
      rec.doneGen = rec.wantGen;
    }
  }

  /** 预览：按合成器给的图层清单请求当前帧（单飞 + 合并，不用墙钟丢帧）。 */
  async function tickLayers(layers, playing) {
    void playing; // 帧率由渲染能力决定；参数只为兼容保留
    for (const layer of layers || []) {
      if (!layer || layer.kind !== 'code') continue;
      const clip = layer.clip;
      let rec;
      try {
        rec = await ensure(clip);
      } catch (e) {
        onError && onError(e, clip);
        continue;
      }
      requestPreview(rec, clip, layer.localT);
    }
  }

  function draw(ctx, clips, t, w, h) {
    for (const clip of active(clips, t)) {
      const canvas = canvasFor(clip);
      if (!canvas) continue;
      try {
        ctx.drawImage(canvas, 0, 0, w, h);
      } catch {
        /* 帧未就绪 */
      }
    }
  }

  function dispose() {
    for (const rec of records.values()) rec.layer.dispose();
    records.clear();
    transitionCache.clear();
    if (composer && typeof composer.dispose === 'function') {
      try {
        composer.dispose();
      } catch (error) {
        /* 释放失败不该阻断销毁 */
      }
    }
    composer = null;
    if (bridge && typeof bridge.dispose === 'function') {
      try {
        bridge.dispose();
      } catch (error) {
        /* 忽略 */
      }
    }
    bridge = null;
  }

  const api = {
    tick,
    renderAt,
    draw,
    dispose,
    canvasFor,
    renderLayers,
    tickLayers,
    /** 播放循环指标（requested / renders / presented / droppedFrames / staleDrops / presentedFps）。 */
    playbackStats,
    /** 合成一帧邻镜画面（调试 / 采样 / 测试用）；失败返回 null。 */
    composeFrame: composeFrameAt,
    /** 合成 provider 的统计（hits / misses / builds / lastMs / maxMs…）；没启用时是 null。 */
    composeStats: () => (composer && composer.stats) || null,
    /** 最近的合成诊断（中文）；没有失败时为 null。 */
    lastComposeDiagnostic: () => lastComposeDiagnostic,
    transitionCache,
  };

  // 控制台挂钩：不打开 devtools 也能回归 —— `__dshPlaybackStats()`。
  // 只挂指标函数，不多暴露可变状态；多个注册表时「最后一个创建的那个」生效。
  try {
    if (typeof globalThis !== 'undefined') globalThis.__dshPlaybackStats = playbackStats;
  } catch (error) {
    /* 控制台挂钩失败不该影响注册表 */
  }

  return api;
}
