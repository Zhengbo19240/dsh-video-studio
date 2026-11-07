/**
 * Preview compositor.
 *
 * Draws the current timeline frame onto a 2D canvas. Media clips are backed by
 * one hidden <video> per asset; while playing we let the video run and correct
 * drift, while scrubbing we seek. Nothing here mutates the project.
 *
 * 合成器同时负责两件事，预览和导出共用同一份代码：
 *   1. 转场：同轨相邻片段的交界处，把前后两个画面的透明/位移/裁剪混合起来；
 *   2. 变速：把时间线上的时间映射回素材的源时间（关键帧按曲线积分）。
 *
 * A black frame is a bug we refuse to ship: every failure path reports an
 * explicit, structured diagnostic through `onMediaState`; the panel draws it in
 * a DOM overlay, never into the composited canvas (exports/headless must not
 * carry Chinese hint text inside the picture).
 */

import { TRANSITION_TYPES, sourceOffsetOf, bezierEase, isValidBezier, normalizeTextStyle } from '../domain.mjs';
// 素材类型（视频 / 音频 / 图片）的唯一判定在 media-kind.mjs：预览池、就绪判定、
// 合成与诊断都只认它，避免「音频被当成视频」这类分歧再次出现在三处代码里。
import { isAudioAsset, isVideoAsset } from '../media-kind.mjs';

// ---------------------------------------------------------------- 布局 ------
//
// 工作台的尺寸只有一个权威源：这里。main.js 只把这份常量贴到 style 上，
// scripts/playback-test.mjs 也断言这份常量 —— 布局若被人改回「按内容撑开」，
// 测试会先红，而不是等用户截图来报。
//
// 背景：宿主给的 slot 容器没有高度，`height:100%` 会退化成 auto，
// 于是内容按自身高度把整页撑长，时间线被顶出视口，右侧检查器的 overflow 失效。
// 所以根容器除了 height:100% 还要有「视口兜底」的确定高度（fitPanelHeight）。

export const WORKBENCH_LAYOUT = Object.freeze({
  timelineHeight: 240,
  mediaBinWidth: 220,
  inspectorWidth: 260,
  minPanelHeight: 240,
  minPreviewHeight: 180,
});

/**
 * 根容器高度：100% 之外再按视口算一个确定值（两者都写，谁生效用谁）。
 * - space：从面板顶部到视口底，可用高度；
 * - parentHeight：父级已经有确定高度时，不许超过它（嵌在小面板里时也对）；
 * - 下限 minPanelHeight，避免窗口很小时压成负数。
 *
 * 纯函数，测试直接断言数字。
 */
export function fitPanelHeight(options = {}) {
  const viewport = Number(options.viewportHeight) > 0 ? Number(options.viewportHeight) : 0;
  const top = Math.max(0, Number(options.top) || 0);
  const min = Math.max(0, Number(options.min == null ? WORKBENCH_LAYOUT.minPanelHeight : options.min) || 0);
  const space = Math.max(min, viewport - top);
  const parent = Number(options.parentHeight) > 0 ? Number(options.parentHeight) : space;
  return Math.max(min, Math.floor(Math.min(parent, space)));
}

/**
 * 工作台每一层的 style。数字全来自 WORKBENCH_LAYOUT —— 不在 JSX 里散落魔法数。
 *
 * 规则：
 *   root       确定高度 + overflow hidden（页面不滚，工作台内部滚）
 *   row        flex:1 + minHeight:0（高度链上每一层都要能收缩）
 *   preview    flex:1 1 0 + minHeight:0 + overflow hidden（绝不按内容长高）
 *   timeline   固定 240，永远留在视口内
 *   bin / inspector  各自 overflowY:auto + overscrollBehavior:contain（滚到边界不漏给页面）
 */
export function layoutStyles(extra = {}) {
  const L = WORKBENCH_LAYOUT;
  return {
    root: {
      display: 'flex',
      flexDirection: 'column',
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 'auto',
      height: extra.height || '100%',
      maxHeight: extra.maxHeight || '100%',
      minHeight: 0,
      overflow: 'hidden',
      position: 'relative',
    },
    row: { flexGrow: 1, flexShrink: 1, flexBasis: 0, display: 'flex', minHeight: 0, overflow: 'hidden' },
    mediaBin: {
      width: L.mediaBinWidth,
      flexGrow: 0,
      flexShrink: 0,
      minHeight: 0,
      overflowY: 'auto',
      overflowX: 'hidden',
      overscrollBehavior: 'contain',
    },
    main: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0,
      minHeight: 0,
      overflow: 'hidden',
    },
    preview: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minHeight: 0,
      overflow: 'hidden',
      background: '#000',
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    timeline: {
      height: L.timelineHeight,
      flexGrow: 0,
      flexShrink: 0,
      flexBasis: L.timelineHeight,
      minHeight: 0,
      overflowY: 'auto',
      overflowX: 'hidden',
      overscrollBehavior: 'contain',
    },
    inspector: {
      width: L.inspectorWidth,
      flexGrow: 0,
      flexShrink: 0,
      minHeight: 0,
      overflowY: 'auto',
      overflowX: 'hidden',
      overscrollBehavior: 'contain',
    },
  };
}

// ---------------------------------------------------------------- 播放 ------
//
// 预览的时间轴只有一个来源：这里。规则（三条，缺一条就会「暂停不住」或「黑屏」）：
//
//   1. 只有一个东西写 playhead —— rAF 里用 performance.now() 算；媒体的
//      timeupdate / 自己的播放进度一律不参与。暂停时 rAF 被真正取消，
//      不是「继续跑但跳过绘制」。
//   2. 暂停 = 取消 rAF → 停掉池子里所有 <video>（**不看 readyState**）→
//      停音频 → 再精确 seek 一帧并画出来。
//   3. 画之前先问「这一帧的视频真的定位到目标时间了吗」：
//      seeked + readyState>=2 才算。没就绪就保留上一帧，绝不清屏成黑。

/** 播放中允许的漂移：超过它就纠正（也是「seek 算不算完成」的重试阈值）。 */
export const DRIFT_TOLERANCE = 0.25;
/** 暂停时「这一帧就是目标帧」的容差。 */
export const SEEK_EPS = 0.04;
/** 一次 seek 最多等多久，超时就给中文诊断。 */
export const SEEK_TIMEOUT_MS = 1200;
/** 超时后最多重试几次。 */
export const MAX_SEEK_RETRIES = 3;
/** 拖动播放头时相邻两次绘制的最小间隔（节流）。 */
export const SCRUB_INTERVAL_MS = 60;

export function clampTime(t, duration) {
  const n = Number(t);
  const v = Number.isFinite(n) ? n : 0;
  const d = Number(duration);
  const max = Number.isFinite(d) && d > 0 ? d : Infinity;
  return Math.max(0, Math.min(v, max));
}

const pool = new Map(); // assetId -> HTMLVideoElement

/**
 * 预览池上限。
 *
 * 一个 <video> 元素真的会占 30–80MB（浏览器缓存解码帧），工程里素材一多，
 * 光是「都建出来」就能把标签页拖死。所以池子有硬上限：超过就按最久未用淘汰，
 * 但**当前时间线引用的元素一个都不动**（否则正在播的帧会突然变黑）。
 */
export const POOL_LIMIT = 8;

/** LRU 记账：每次取/建元素都 touched 一次，淘汰时按这个序号从小到大。 */
const lastUsed = new Map();
let useTick = 0;
function touch(assetId) {
  useTick += 1;
  lastUsed.set(assetId, useTick);
}

/** 池子里现在有几个 <video>（测试与诊断用）。 */
export function poolSize() {
  return pool.size;
}

/** 池子里所有 assetId（按创建顺序，测试用）。 */
export function poolIds() {
  return [...pool.keys()];
}


/**
 * 媒体就绪计数器：任何一个 <video> 的元数据/首帧/错误状态变了就 +1。
 * 预览循环把它拼进「这一帧要不要重画」的 key 里 —— 否则暂停时首帧到了也不会重绘，
 * 画面就永远停在加载提示上。
 */
let mediaGeneration = 0;
export function mediaGenerationValue() {
  return mediaGeneration;
}

/**
 * 媒体就绪状态变了就通知。暂停态下必须靠它重新定格一帧 ——
 * 旧代码把 generation 拼进绘制 key，但那只在循环还在跑时才有机会重绘。
 */
const mediaReadyListeners = new Set();
export function onMediaReady(fn) {
  if (typeof fn !== 'function') return () => {};
  mediaReadyListeners.add(fn);
  return () => mediaReadyListeners.delete(fn);
}

function bumpMediaGeneration() {
  mediaGeneration += 1;
  for (const fn of mediaReadyListeners) {
    try {
      fn(mediaGeneration);
    } catch {
      /* 订阅者自己的错不该毁掉媒体事件 */
    }
  }
}

const MEDIA_EVENTS = ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'error', 'emptied', 'stalled', 'suspend'];

/**
 * 取（或建）某个素材的 <video>。
 *
 * force=true 会先 release 再重建 —— 面板上的「重新加载」和 R 键走这条路。
 * 元素只在第一次创建、或 url 真的变了时才 load()，避免每帧重置播放进度。
 */
export function videoFor(assetId, url, options = {}) {
  let v = pool.get(assetId);
  if (v && options.force) {
    releaseAsset(assetId);
    v = null;
  }
  if (!v) {
    v = document.createElement('video');
    v.preload = 'auto';
    v.muted = true; // 预览静音由音频引擎独立处理；先保证画面
    v.playsInline = true;
    v.crossOrigin = 'anonymous';
    v.src = url;
    v.load();
    if (typeof v.addEventListener === 'function') {
      for (const ev of MEDIA_EVENTS) v.addEventListener(ev, bumpMediaGeneration);
    }
    pool.set(assetId, v);
    touch(assetId);
    return v;
  }
  // 同一个 assetId 换了地址（例如工程重开、路由参数变了）时重新指向
  if (url && v.getAttribute && v.getAttribute('src') !== url) {
    v.src = url;
    v.load();
  }
  touch(assetId);
  return v;
}

/**
 * 按工程里的素材清单补齐预览池：有素材、但池子里没有元素的，全部建出来。
 *
 * 这是修「正在解码…永不消失」的那一刀：以前只有 probeAsset（且只对没有
 * probe 的素材跑）会建元素，于是重开工程 / 刷新页面之后池子永远是空的，
 * 画面就永远停在提示语上。返回这次新建的元素数。
 *
 * LRU：补完之后如果池子超过 POOL_LIMIT，就按「最久未用」淘汰，
 * 但 options.keep 里的（当前时间线引用的）assetId 一个都不动。
 * 淘汰只影响「下一次要重建」，不影响 drawFrame / mediaDiagnostic 的判定语义。
 */
export function ensureVideos(assets, urlFor, options = {}) {
  let created = 0;
  for (const a of assets || []) {
    if (!a || !a.id) continue;
    // 只有视频需要 <video>。音频（以及图片、未知类型）绝不建元素 ——
    // 音频的 videoWidth 永远是 0，建出来只会让就绪判定永远不过、整帧被 hold。
    if (!isVideoAsset(a)) continue;
    if (pool.has(a.id) && !options.force) continue;
    videoFor(a.id, urlFor(a.id), { force: !!options.force });
    created += 1;
  }
  const keep = new Set();
  for (const id of options.keep || []) if (id) keep.add(id);
  trimPool(keep);
  return created;
}

/**
 * 淘汰到上限以内。返回这次释放了几个。
 * 全部都被 keep 挡住时宁可暂时超限 —— 正在播的画面比内存更重要。
 */
function trimPool(keep) {
  let released = 0;
  while (pool.size > POOL_LIMIT) {
    let victim = null;
    let oldest = Infinity;
    for (const id of pool.keys()) {
      if (keep.has(id)) continue;
      const tick = lastUsed.get(id) || 0;
      if (tick < oldest) {
        oldest = tick;
        victim = id;
      }
    }
    if (!victim) break;
    releaseAsset(victim);
    released += 1;
  }
  return released;
}

export function releaseAsset(assetId) {
  const v = pool.get(assetId);
  if (v) {
    v.pause();
    v.removeAttribute('src');
    v.load();
    pool.delete(assetId);
  }
  lastUsed.delete(assetId);
}

export function clearPool() {
  for (const id of [...pool.keys()]) releaseAsset(id);
  lastUsed.clear();
}

export function videoState(assetId) {
  return pool.get(assetId) || null;
}

// ------------------------------------------------------------ 诊断 ----------

/** MediaError.code 的中文解释。数字是浏览器规范里固定的。 */
export const MEDIA_ERRORS = {
  1: { name: 'MEDIA_ERR_ABORTED', text: '加载被中断（可能是切换工程或暂停）' },
  2: { name: 'MEDIA_ERR_NETWORK', text: '网络中断，素材没下完' },
  3: { name: 'MEDIA_ERR_DECODE', text: '数据到了但解不出来，文件可能损坏或编码不受支持' },
  4: { name: 'MEDIA_ERR_SRC_NOT_SUPPORTED', text: '浏览器不支持这个编码或容器' },
};

/** 转码命令：给用户的下一步必须是可执行的，不是「请转码」四个字。 */
export const H264_TRANSCODE =
  'ffmpeg -i 输入.mp4 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart 输出.mp4';

/**
 * 客户端编码能力探测。没有 ffprobe 时，这是唯一能问到的「本机能不能放 HEVC」。
 * 返回 '' 表示不支持，'maybe' / 'probably' 表示可能支持。
 */
export function codecSupport(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || typeof d.createElement !== 'function') return { hvc1: '', h264: '' };
  try {
    const el = d.createElement('video');
    const can = typeof el.canPlayType === 'function' ? el.canPlayType.bind(el) : null;
    if (!can) return { hvc1: '', h264: '' };
    return {
      hvc1: can('video/mp4; codecs="hvc1.1.6.L93.B0"') || '',
      h264: can('video/mp4; codecs="avc1.640028"') || '',
    };
  } catch {
    return { hvc1: '', h264: '' };
  }
}

/**
 * 为什么这一帧没有画面 —— 一条诊断，四种互不相同的真相。
 * 纯函数：只看 asset + <video> 的状态，不画东西，所以测试能直接断言。
 *
 * @returns {{code, title, detail, hint, blocker}} code ∈
 *   no-asset | audio-asset | no-element | error | loading | metadata | no-frame | ready
 */
export function mediaDiagnostic(asset, v, options = {}) {
  const hvc1 = options.hvc1 == null ? '' : String(options.hvc1);
  const assetId = (asset && asset.id) || options.assetId || '?';

  if (!asset) {
    return {
      code: 'no-asset',
      title: '素材没准备好（工程里没有这个 asset）',
      detail: '片段指向 ' + assetId + '，但素材表里没有它。',
      hint: '重新导入这个文件，或删掉片段重插。',
      blocker: true,
    };
  }

  // 音频素材：它本来就没有画面，永远等不到 videoWidth。把它报成「没就绪」
  // 会让预览整帧 hold，用户点「重新加载」也永远修不好 —— 所以单独一条诊断：
  // 不阻塞画面（blocker:false），并直接给出下一步（移到音频轨）。
  if (isAudioAsset(asset)) {
    return {
      code: 'audio-asset',
      title: '音频素材不参与画面',
      detail: assetId + ' 是音频（' + (asset.mime || '未知类型') + '），没有视频流，不该放在视频轨上。',
      hint: '把它移到音频轨（a1）就能正常播放；画面合成会直接跳过它，不再等首帧。',
      blocker: false,
    };
  }

  if (!v) {
    return {
      code: 'no-element',
      title: '素材没准备好（pool 里没有）',
      detail: assetId + ' 还没有 <video> 元素 —— 这帧不是「在解码」，是根本没开始加载。',
      hint: '点「重新加载」或按 R 重建元素。',
      blocker: true,
    };
  }

  const err = v.error;
  if (err && v.readyState < 2) {
    const info = MEDIA_ERRORS[err.code] || { name: 'MEDIA_ERR_UNKNOWN(' + err.code + ')', text: '未知错误' };
    const codecIssue = err.code === 3 || err.code === 4;
    let hint;
    if (codecIssue && !hvc1) {
      hint =
        '浏览器不支持这个编码，可能是 HEVC/H.265（本机 hvc1 探测：不支持）。用 ffmpeg 转成 H.264 再导入：' +
        H264_TRANSCODE;
    } else if (codecIssue) {
      hint =
        '本机浏览器自称支持 HEVC，这个文件仍被拒：可能是 10bit / ProRes / 文件损坏。检查后转 H.264：' +
        H264_TRANSCODE;
    } else {
      hint = '文件可能不完整或被占用：先确认它能用播放器打开，再点「重新加载」。';
    }
    return {
      code: 'error',
      title: '解码失败：' + err.code + ' ' + info.name,
      detail: info.text + (err.message ? '　' + err.message : '') + '（readyState=' + v.readyState + '，networkState=' + v.networkState + '）',
      hint,
      blocker: true,
    };
  }

  if (v.readyState < 1) {
    const noSource = v.networkState === 3;
    return {
      code: 'loading',
      title: '载入中…',
      detail:
        'readyState=' + v.readyState + '，networkState=' + v.networkState +
        (noSource ? '（NETWORK_NO_SOURCE：浏览器判定没有可用源）' : ''),
      hint: noSource
        ? 'networkState=3 基本等于「拿不到能播的源」：检查文件是否存在、路由是否 404/403，或编码是否不受支持。'
        : '首次导入会等几秒。一直停在这里就点「重新加载」。',
      blocker: false,
    };
  }

  if (v.readyState < 2) {
    return {
      code: 'metadata',
      title: '载入中…（已拿到元数据，等首帧）',
      detail: 'readyState=' + v.readyState + '，networkState=' + v.networkState,
      hint: '元数据已经解出来了，说明容器和编码能认；等首帧或点「重新加载」。',
      blocker: false,
    };
  }

  if (!(v.videoWidth > 0)) {
    return {
      code: 'no-frame',
      title: '拿到了数据但解不出画面',
      detail: 'readyState=' + v.readyState + '，但 videoWidth=' + v.videoWidth + '（容器能认，视频轨可能为空或损坏）',
      hint: '用 ffprobe 看有没有视频流；没有就重新导出，有的就转 H.264：' + H264_TRANSCODE,
      blocker: true,
    };
  }

  return { code: 'ready', title: '', detail: '', hint: '', blocker: false };
}

/** 当前这一帧涉及的媒体图层诊断（面板用它，drawFrame 用同一套判断）。 */
export function mediaDiagnostics(view) {
  const layers = view.layers || frameLayers(view.clips, view.t);
  const byId = new Map((view.assets || []).map((a) => [a.id, a]));
  const hvc1 = (view.codecs || codecSupport()).hvc1;
  const out = [];
  const seen = new Set();
  for (const layer of layers) {
    if (layer.kind !== 'media') continue;
    const c = layer.clip;
    const asset = byId.get(c.assetId);
    const v = asset ? pool.get(asset.id) : null;
    const d = mediaDiagnostic(asset, v, { hvc1, assetId: c.assetId });
    if (d.code === 'ready') continue;
    const key = d.code + '|' + c.assetId;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(Object.assign({ assetId: c.assetId, clipId: c.id }, d));
  }
  return out;
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * 关键帧缓动：帧间进度 k（0..1）→ 缓动后的 k。
 * 关键帧带 bezier（[x1,y1,x2,y2]）时优先于 kind；没有才回落到 easeIn/out/inOut/linear。
 * 坏数据（非数组、分量越界）不抛错，直接回落到 kind —— 渲染路径不该因为一个
 * 手工改坏的 JSON 整帧黑掉。
 */
export function ease(k, kind, bezier) {
  if (isValidBezier(bezier)) return bezierEase(bezier[0], bezier[1], bezier[2], bezier[3], k);
  if (kind === 'easeIn') return k * k;
  if (kind === 'easeOut') return 1 - (1 - k) * (1 - k);
  if (kind === 'easeInOut') return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
  return k;
}

export function evaluateTransform(clip, localT) {
  const base = Object.assign({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, clip.transform || {});
  const keys = clip.keyframes || [];
  if (!keys.length) return base;
  const out = Object.assign({}, base);
  const props = new Set(keys.map((k) => k.property));
  for (const prop of props) {
    const track = keys.filter((k) => k.property === prop).sort((a, b) => a.t - b.t);
    if (!track.length) continue;
    if (localT <= track[0].t) {
      out[prop] = track[0].value;
      continue;
    }
    if (localT >= track[track.length - 1].t) {
      out[prop] = track[track.length - 1].value;
      continue;
    }
    for (let i = 1; i < track.length; i += 1) {
      const a = track[i - 1];
      const b = track[i];
      if (localT <= b.t) {
        const span = b.t - a.t;
        const raw = span <= 0 ? 0 : (localT - a.t) / span;
        // bezier 优先于 kind：同一段区间里，上一帧或下一帧带的贝塞尔曲线说了算。
        const k = ease(raw, b.ease || a.ease || 'linear', b.bezier || a.bezier || null);
        out[prop] = a.value + (b.value - a.value) * k;
        break;
      }
    }
  }
  return out;
}

export function filterFor(clip) {
  const map = { brightness: '', contrast: '', saturate: '', blur: '', grayscale: '', temperature: '', tint: '' };
  for (const e of clip.effects || []) {
    if (e.type === 'brightness') map.brightness = 'brightness(' + e.value + ')';
    else if (e.type === 'contrast') map.contrast = 'contrast(' + e.value + ')';
    else if (e.type === 'saturate') map.saturate = 'saturate(' + e.value + ')';
    else if (e.type === 'grayscale') map.grayscale = e.value > 0 ? 'grayscale(' + Math.min(1, e.value) + ')' : '';
    else if (e.type === 'blur') map.blur = e.value > 0 ? 'blur(' + e.value + 'px)' : '';
    else if (e.type === 'temperature') {
      if (e.value > 0) map.temperature = 'sepia(' + (0.25 * e.value).toFixed(3) + ') saturate(' + (1 + 0.12 * e.value).toFixed(3) + ')';
      else if (e.value < 0) map.temperature = 'hue-rotate(' + Math.round(-18 * e.value) + 'deg) saturate(' + (1 + 0.06 * e.value).toFixed(3) + ')';
    } else if (e.type === 'tint') {
      if (Math.abs(e.value) > 0.001) map.tint = 'hue-rotate(' + Math.round(28 * e.value) + 'deg)';
    }
  }
  const out = [map.brightness, map.contrast, map.saturate, map.grayscale, map.temperature, map.tint, map.blur].filter(Boolean).join(' ');
  return out || 'none';
}

// ------------------------------------------------------------------ 变速 ----

/**
 * 时间线局部时间 → 素材源时间（秒）。
 * 恒速时是 sourceIn + localT * speed；关键帧时按速度曲线积分（见 domain.sourceOffsetOf）。
 * localT 允许越界：转场要画相邻片段的「延长帧」。
 */
export function sourceTime(clip, localT) {
  return (clip.sourceIn || 0) + sourceOffsetOf(clip, localT);
}

// ------------------------------------------------------------------ 转场 ----

/**
 * 找出 t 落在哪个转场窗口里。只有同轨、首尾相接的相邻片段才有转场窗口；
 * 跨轨一律不做。同时存在「前一段的 out」和「后一段的 in」时，in 优先。
 *
 * @returns {null | {a, b, side:'in'|'out', type, progress, start, duration}}
 */
export function transitionAt(clips, t) {
  const byTrack = new Map();
  for (const c of clips || []) {
    if (!c || !c.trackId) continue;
    if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []);
    byTrack.get(c.trackId).push(c);
  }
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i += 1) {
      const a = list[i - 1];
      const b = list[i];
      if (Math.abs(a.start + a.duration - b.start) > 1e-3) continue; // 中间有缝，不转场
      const inc = b.transition && b.transition.in;
      const outg = a.transition && a.transition.out;
      if (inc && inc.duration > 0 && t >= b.start - 1e-6 && t < b.start + inc.duration) {
        return {
          a,
          b,
          side: 'in',
          type: inc.type,
          progress: clamp01((t - b.start) / inc.duration),
          start: b.start,
          duration: inc.duration,
        };
      }
      if (outg && outg.duration > 0) {
        const from = a.start + a.duration - outg.duration;
        if (t >= from - 1e-6 && t < a.start + a.duration) {
          return {
            a,
            b,
            side: 'out',
            type: outg.type,
            progress: clamp01((t - from) / outg.duration),
            start: from,
            duration: outg.duration,
          };
        }
      }
    }
  }
  return null;
}

/**
 * 纯函数：给定转场类型、进度和前后两个片段，算出混合参数。
 * 不碰 canvas，测试可以直接算。
 *
 * dx 是「画面宽度的比例」：0 = 原位，1 = 向右移出一屏，-1 = 向左移出一屏。
 * clip* 是归一化裁剪矩形 {x, y, w, h}（0..1），null 表示整帧。
 */
export function mixTransition({ type, progress, a, b } = {}) {
  const p = clamp01(Number.isFinite(progress) ? progress : 0);
  if (!TRANSITION_TYPES.includes(type)) {
    throw new Error('不支持的转场类型: ' + type);
  }
  const out = { type, progress: p, alphaA: 1, alphaB: 1, dxA: 0, dxB: 0, clipA: null, clipB: null };
  if (type === 'crossfade') {
    out.alphaA = 1 - p;
    out.alphaB = p;
    return out;
  }
  if (type === 'push') {
    // 入向：新画面从左推入；出向：旧画面向左推出，新画面从右补上
    const side = b && b.transition && b.transition.in ? 'in' : a && a.transition && a.transition.out ? 'out' : 'in';
    if (side === 'in') {
      out.dxA = p;
      out.dxB = -(1 - p);
    } else {
      out.dxA = -p;
      out.dxB = 1 - p;
    }
    return out;
  }
  // wipe：后一个画面按从左到右的进度露出来，示意图里 A 保持不动
  out.clipB = { x: 0, y: 0, w: p, h: 1 };
  return out;
}

function legacyFade(clip, localT) {
  const left = clip.duration - localT;
  const fin = clip.transitionIn ? Math.min(1, Math.max(0, localT / clip.transitionIn)) : 1;
  const fout = clip.transitionOut ? Math.min(1, Math.max(0, left / clip.transitionOut)) : 1;
  return Math.max(0, Math.min(fin, fout));
}

/**
 * 把这一帧要画的所有图层摊平成一个有序数组（先媒体，再文字，最后代码）。
 * 导出、预览、采样都调它，所以三条路径的画面必然一致。
 *
 * 每个 layer：
 *   { clip, kind:'media'|'text'|'code', localT, alpha, dx, dy, clipRect }
 * localT 可能落在 [0, duration] 之外 —— 转场需要画相邻片段的延长帧。
 */
export function frameLayers(clips, t) {
  const tr = transitionAt(clips, t);
  const buckets = { media: [], text: [], code: [] };
  const push = (clip, localT, spec) => {
    const kind = clip.type === 'media' ? 'media' : clip.type === 'text' ? 'text' : clip.type === 'code' ? 'code' : null;
    if (!kind) return;
    buckets[kind].push({
      clip,
      kind,
      localT,
      alpha: spec && spec.alpha != null ? spec.alpha : 1,
      dx: (spec && spec.dx) || 0,
      dy: (spec && spec.dy) || 0,
      clipRect: (spec && spec.rect) || null,
      transition: spec && spec.transition ? true : false,
    });
  };

  for (const c of clips || []) {
    const inside = c.start <= t && c.start + c.duration > t;
    const inTransition = tr && (tr.a.id === c.id || tr.b.id === c.id);
    if (!inside && !inTransition) continue;
    if (inTransition) continue; // 交给下面的混合逻辑，避免画两遍
    push(c, t - c.start, { alpha: legacyFade(c, t - c.start) });
  }

  if (tr) {
    const spec = mixTransition({ type: tr.type, progress: tr.progress, a: tr.a, b: tr.b });
    push(tr.a, t - tr.a.start, {
      alpha: spec.alphaA * legacyFade(tr.a, t - tr.a.start),
      dx: spec.dxA,
      rect: spec.clipA,
      transition: true,
    });
    push(tr.b, t - tr.b.start, {
      alpha: spec.alphaB * legacyFade(tr.b, t - tr.b.start),
      dx: spec.dxB,
      rect: spec.clipB,
      transition: true,
    });
  }

  return buckets.media.concat(buckets.text, buckets.code);
}

function rectPath(ctx, rect, width, height) {
  ctx.beginPath();
  ctx.rect(rect.x * width, rect.y * height, rect.w * width, rect.h * height);
  ctx.clip();
}

/**
 * 把一个媒体画面（<video> 或合成通道给的 ImageBitmap）按这一层的
 * transform / 滤镜 / 蒙版 / 转场裁剪画到 ctx 上。
 *
 * 抽出来是为了让「预览池的 <video>」和「转场合成帧的位图」走**同一条**绘制路径：
 * 两者画出来必须一模一样，否则合成帧和真实画面会有细微偏差。
 */
function paintMediaSource(ctx, source, sourceWidth, sourceHeight, options) {
  const clip = options.clip;
  const layer = options.layer;
  const tf = options.tf || {};
  const width = options.width;
  const height = options.height;
  const srcW = Number(sourceWidth) > 0 ? Number(sourceWidth) : width;
  const srcH = Number(sourceHeight) > 0 ? Number(sourceHeight) : height;

  const hasMask = clip.mask && clip.mask.shape && clip.mask.shape !== 'none';
  const rect = hasMask
    ? {
        x: clip.mask.x - clip.mask.w / 2,
        y: clip.mask.y - clip.mask.h / 2,
        w: clip.mask.w,
        h: clip.mask.h,
      }
    : null;

  ctx.save();
  // 转场的裁剪矩形（wipe）与蒙版叠加
  if (layer.clipRect) rectPath(ctx, layer.clipRect, width, height);
  if (rect) {
    ctx.save();
    ctx.beginPath();
    if (clip.mask.shape === 'circle') {
      ctx.ellipse(
        clip.mask.x * width,
        clip.mask.y * height,
        (clip.mask.w * width) / 2,
        (clip.mask.h * height) / 2,
        0,
        0,
        Math.PI * 2,
      );
    } else {
      ctx.rect(rect.x * width, rect.y * height, rect.w * width, rect.h * height);
    }
    ctx.clip();
  }
  ctx.globalAlpha = options.alpha;
  ctx.translate(width / 2 + (tf.x || 0) + layer.dx * width, height / 2 + (tf.y || 0) + layer.dy * height);
  ctx.rotate(((tf.rotation || 0) * Math.PI) / 180);
  const scale = tf.scale || 1;
  const vw = width * scale;
  const vh = (srcH / srcW) * vw;
  ctx.filter = filterFor(clip);
  ctx.drawImage(source, -vw / 2, -vh / 2, vw, vh);
  ctx.filter = 'none';
  if (rect) ctx.restore();
  ctx.restore();
}

/** 白名单字体 → canvas font-family 栈（中文缺字时依次回退，不会掉成方块）。 */
const FONT_STACKS = {
  'system-ui': 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  'Microsoft YaHei': '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif',
  SimHei: 'SimHei, "Heiti SC", "Microsoft YaHei", sans-serif',
  serif: 'Georgia, "Songti SC", SimSun, serif',
  monospace: 'ui-monospace, Consolas, "Cascadia Mono", monospace',
};

function fontStack(family) {
  return FONT_STACKS[family] || FONT_STACKS['system-ui'];
}

// ------------------------------------------------------- 像素对齐契约 ----
//
// 「导出的 MP4 里文字在抖，预览不抖」的根因不在编码器，而在两条渲染路径
// 各自决定了坐标空间与对齐方式：
//
//   - 预览画布 960×540，导出 1920×1080；字号/基线用的是**绝对像素**，
//     于是同一份文字在两条路径上占画面的比例不同（导出小一半）。
//   - 基线 y = height * style.y 天然带小数（1080×0.82 = 885.6），x 也常是小数；
//     字形落在半像素上，边缘抗锯齿每帧都要重采样。
//   - 预览画布会被 CSS 缩小显示，缩小本身就是一次盒式平均，正好把 0.6px 的
//     边缘起伏抹平；导出一比一像素输出，同样的起伏就看得见 —— 所以「预览稳、
//     成片抖」。
//
// 这里定下一条**两路共用**的规则（导出、预览、无头采样都只走 drawFrame）：
//
//   1. 构图以 540p 为参考，字号按 height / 540 等比换算 —— 两条路径的构图
//      比例一致（textPixels）。
//   2. **静态几何**（锚点、基线静止位置、边距）取整到设备像素网格；
//   3. **动画偏移**（关键帧的 x/y/scale、转场位移）保持连续，绝不逐帧取整。
//
// 第 2 条消除静止文字的半像素重采样；第 3 条保证运镜仍是连续位移 ——
// 如果把带关键帧的坐标也取整，推镜就会变成「每帧跳一格」的卡顿。
// 二者冲突时的取舍：静止部分对齐、运动部分连续。像素对齐只作用于不动的
// 那条基准线，不作用于速度。

/** 构图参考高度：预览画布为 540p，所有排版单位都以它为准。 */
export const COMPOSE_REFERENCE_HEIGHT = 540;

/** 设备像素对齐：只用于静态几何。NaN/Infinity 折成 0，渲染路径不因坏数据整帧黑。 */
export function snapDevicePixel(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * 排版单位 → 设备像素。全工程唯一一处字号换算。
 * 540p 时是 1:1（预览构图不变），1080p 时 ×2（与预览构图一致）。
 */
export function textPixels(sizeAtReference, height) {
  const size = Number(sizeAtReference);
  const h = Number(height);
  if (!Number.isFinite(size) || size <= 0) return 12;
  const scale = Number.isFinite(h) && h > 0 ? h / COMPOSE_REFERENCE_HEIGHT : 1;
  return Math.max(1, Math.round(size * scale));
}

/**
 * 一个文字图层的绘制几何。预览与导出都只从这里取坐标 —— 规则只有一份。
 *
 * @param {object} input { style, width, height, tf, layer }
 * @returns {{x:number, y:number, fontPx:number, lineStep:number, margin:number, aligned:boolean}}
 *   x/y 是**这一帧**的落点：静态部分已取整，动画部分连续。
 */
export function textAnchor(input = {}) {
  const style = input.style || {};
  const width = Number(input.width) || 0;
  const height = Number(input.height) || 0;
  const tf = input.tf || {};
  const layer = input.layer || {};

  const fontPx = textPixels(style.fontSize, height);
  const margin = snapDevicePixel(width * 0.05);
  const anchorX =
    style.align === 'left' ? margin : style.align === 'right' ? snapDevicePixel(width - margin) : snapDevicePixel(width / 2);

  // 静止基准取整；关键帧 / 转场带来的位移原样保留（连续）。
  const restX = anchorX;
  const restY = snapDevicePixel(height * (Number(style.y) || 0));
  const dx = (Number(tf.x) || 0) + (Number(layer.dx) || 0) * width;
  const dy = (Number(tf.y) || 0) + (Number(layer.dy) || 0) * height;

  return {
    x: restX + dx,
    y: restY + dy,
    fontPx,
    // 行距也取整：多行文字每行都落在整像素上，行与行之间不会出现「有的行清楚、
    // 有的行发虚」。字号本身已取整，所以这里不会把行距压成 0。
    lineStep: Math.max(1, snapDevicePixel(fontPx * (Number(style.lineHeight) || 1.2))),
    margin,
    // 只有完全静止的图层才落在整像素上；有动画时如实报告 false（测试据此判定）。
    aligned: dx === 0 && dy === 0,
  };
}

/**
 * 这一帧所有文字图层真正会用到的字体签名（给 FontFaceSet.load 预热）。
 * 顺序去重，导出前一次性等它们就绪，避免「前几帧用 fallback 度量」。
 */
export function textFontSpecs(layers, height) {
  const specs = [];
  const seen = new Set();
  for (const layer of layers || []) {
    if (!layer || layer.kind !== 'text') continue;
    const style = normalizeTextStyle((layer.clip && layer.clip.style) || {});
    const spec = `${style.fontWeight} ${textPixels(style.fontSize, height)}px ${fontStack(style.fontFamily)}`;
    if (seen.has(spec)) continue;
    seen.add(spec);
    specs.push(spec);
  }
  return specs;
}

/**
 * 等字体就绪（预览与导出共用）。带超时：字体一直不就绪时不能让导出卡死。
 *
 * 为什么必须等：canvas 的 fillText 在字体还没进字形缓存时会先用 fallback 度量，
 * 等字体到位后同一句话的宽度/基线都变 —— 逐帧画下来就是「前几帧字距不对」，
 * 或者干脆整段字幕在跳。
 *
 * @param {object} [options] { specs, timeoutMs, fonts }
 * @returns {Promise<{ok:boolean, timedOut:boolean, reason:string, specs:number}>}
 */
export async function ensureFontsReady(options = {}) {
  const fonts =
    options.fonts !== undefined
      ? options.fonts
      : typeof document !== 'undefined' && document
        ? document.fonts
        : null;
  const specs = Array.isArray(options.specs) ? options.specs.filter((s) => typeof s === 'string' && s) : [];
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 1500;

  if (!fonts) return { ok: true, timedOut: false, reason: 'no-font-api', specs: specs.length };
  if (fonts.status === 'loaded' && typeof fonts.ready !== 'undefined') {
    // ready 已经 resolve 过也要把具体字重/字号预热一遍：status === 'loaded'
    // 只说明已排队的字体加载完了，不代表这个字号已经被光栅化过。
  }

  const loadAll = async () => {
    if (typeof fonts.load !== 'function') return;
    await Promise.all(
      specs.map((spec) =>
        Promise.resolve(fonts.load(spec)).catch(() => {
          /* 单个字体加载失败不该拖住整帧 */
        }),
      ),
    );
  };

  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const work = (async () => {
      await loadAll();
      if (fonts.ready && typeof fonts.ready.then === 'function') await fonts.ready;
      return 'ready';
    })().catch(() => 'error');
    const outcome = await Promise.race([work, timeout]);
    return {
      ok: outcome === 'ready',
      timedOut: outcome === 'timeout',
      reason: outcome === 'ready' ? 'ready' : outcome === 'timeout' ? 'timeout' : 'error',
      specs: specs.length,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} view { clips, assets, t, width, height, layers?, codeCanvas?, codecs?, onMediaState? }
 *   layers       —— 可选，调用方已经算好的 frameLayers（导出/采样要先按同一份清单渲染代码图层）
 *   codeCanvas   —— 可选，(clip) => canvas|null，代码图层由调用方提供（见 code-registry.js）
 *   mediaFrame   —— 可选，(clip, localT) => ImageBitmap|null，**合成通道**：调用方已经按目标时刻
 *                   解好这一层的画面（转场邻帧合成用），有返回值时不再看预览池的 <video>。
 *                   位图走和视频完全一样的 transform / 滤镜 / 蒙版 / 转场裁剪路径。
 *   codecs       —— 可选，codecSupport() 的结果；不给就现场探一次
 *   onMediaState —— 可选，(diagnostics) => void，这一帧没画出来的媒体图层及原因
 */
export function drawFrame(ctx, view) {
  const { clips, assets, t, width, height } = view;
  const layers = view.layers || frameLayers(clips, t);
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);

  const byId = new Map((assets || []).map((a) => [a.id, a]));
  const hvc1 = (view.codecs || codecSupport()).hvc1;
  const pending = []; // 画不出来的媒体图层，各自带一条能诊断的原因

  for (const layer of layers) {
    if (layer.kind !== 'media') continue;
    const c = layer.clip;
    const tf = evaluateTransform(c, layer.localT);
    const alpha = (tf.opacity == null ? 1 : tf.opacity) * layer.alpha;
    if (alpha <= 0.001) continue; // 完全透明：这一层本来就不该有画面，不算失败
    const asset = byId.get(c.assetId);
    // 音频素材不参与画面合成：直接跳过，连 pending 都不进 —— 否则它又会变成
    // 「这一帧没就绪」的理由，整帧被 hold。面板的提示走 mediaDiagnostics()。
    if (asset && isAudioAsset(asset)) continue;
    // 合成帧通道：调用方按目标时刻给了这一层的位图，就不再依赖预览池。
    const composedSource = typeof view.mediaFrame === 'function' && asset ? view.mediaFrame(c, layer.localT) : null;
    if (composedSource) {
      paintMediaSource(ctx, composedSource, composedSource.width || width, composedSource.height || height, {
        clip: c,
        layer: layer,
        tf: tf,
        alpha: alpha,
        width: width,
        height: height,
      });
      continue;
    }
    const v = asset ? pool.get(asset.id) : null;
    if (!asset || !v || v.readyState < 2 || !(v.videoWidth > 0)) {
      const d = mediaDiagnostic(asset, v, { hvc1, assetId: c.assetId });
      if (d.code !== 'ready') pending.push(Object.assign({ assetId: c.assetId, clipId: c.id }, d));
      continue;
    }

    try {
      paintMediaSource(ctx, v, v.videoWidth, v.videoHeight, {
        clip: c,
        layer: layer,
        tf: tf,
        alpha: alpha,
        width: width,
        height: height,
      });
    } catch {
      /* frame not ready */
    }
  }

  // 暗角：整帧径向渐变叠加（按第一个开启暗角的片段计算）
  const actives = layers.filter((l) => l.kind === 'media' || l.kind === 'text' || l.kind === 'code').map((l) => l.clip);
  const vig = actives.find((c) => (c.effects || []).some((e) => e.type === 'vignette' && e.value > 0));
  if (vig) {
    const strength = (vig.effects.find((e) => e.type === 'vignette') || {}).value || 0;
    const g = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.25, width / 2, height / 2, Math.max(width, height) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,' + Math.min(0.9, strength).toFixed(2) + ')');
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  for (const layer of layers) {
    if (layer.kind !== 'text') continue;
    const c = layer.clip;
    const tf = evaluateTransform(c, layer.localT);
    const alpha = (tf.opacity == null ? 1 : tf.opacity) * layer.alpha;
    if (alpha <= 0.001) continue;
    ctx.save();
    if (layer.clipRect) rectPath(ctx, layer.clipRect, width, height);
    ctx.globalAlpha = alpha;
    const style = normalizeTextStyle(c.style || {});
    // 坐标只在 textAnchor 一处算：字号等比换算 + 静态几何取整 + 动画偏移连续。
    // 预览、导出、无头采样都经过这里，所以三路必然同一条规则。
    const anchor = textAnchor({ style, width, height, tf, layer });
    ctx.font = `${style.fontWeight} ${anchor.fontPx}px ${fontStack(style.fontFamily)}`;
    ctx.textAlign = style.align;
    ctx.textBaseline = 'middle';
    const cx = anchor.x;
    const cy = anchor.y;
    const lineGap = anchor.lineStep;
    const lines = String(c.text || '').split('\n');
    // 静止的多行文字：首行基线也取整，行距是整数 → 每一行都在整像素上。
    // 有动画时保持连续，不然多行字幕会跟着运镜一格一格跳。
    const centered = cy - ((lines.length - 1) * lineGap) / 2;
    const firstY = anchor.aligned ? snapDevicePixel(centered) : centered;
    ctx.fillStyle = style.color;
    if (style.stroke) {
      ctx.lineWidth = style.stroke.width;
      ctx.strokeStyle = style.stroke.color;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
    }
    if (style.shadow) {
      ctx.shadowColor = style.shadow.color;
      ctx.shadowBlur = style.shadow.blur;
      ctx.shadowOffsetX = style.shadow.x;
      ctx.shadowOffsetY = style.shadow.y;
    }
    for (let i = 0; i < lines.length; i += 1) {
      const y = firstY + i * lineGap;
      if (style.stroke && style.stroke.width > 0) ctx.strokeText(lines[i], cx, y);
      ctx.fillText(lines[i], cx, y);
    }
    ctx.restore();
  }

  // 代码图层：画布由调用方（code-registry）提供，这里只负责叠加与转场参数
  if (typeof view.codeCanvas === 'function') {
    for (const layer of layers) {
      if (layer.kind !== 'code') continue;
      const canvas = view.codeCanvas(layer.clip);
      if (!canvas) continue;
      const tf = evaluateTransform(layer.clip, layer.localT);
      const alpha = (tf.opacity == null ? 1 : tf.opacity) * layer.alpha;
      if (alpha <= 0.001) continue;
      ctx.save();
      if (layer.clipRect) rectPath(ctx, layer.clipRect, width, height);
      ctx.globalAlpha = alpha;
      ctx.translate(layer.dx * width, layer.dy * height);
      // 代码图层画布按 960×540 光栅化（见 code-registry），画到更大的输出帧上
      // 必然是放大。放大本身两条路径一样，但采样质量必须写死：默认值随浏览器变，
      // 预览与导出可能一个用 bilinear、一个用 nearest，看起来就是「边缘在跳」。
      ctx.imageSmoothingEnabled = true;
      try {
        ctx.imageSmoothingQuality = 'high';
      } catch {
        /* 老浏览器没有这个属性，忽略 */
      }
      try {
        ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, width, height);
      } catch {
        /* 帧未就绪 */
      }
      ctx.restore();
    }
  }

  // 诊断只回传给调用方（面板的 overlay 层），**绝不画进合成帧**。
  //
  // 这里曾经把「素材未就绪 / 拿到了数据但解不出画面」直接 fillText 到画布上：
  // 面板里看着像提示，导出和无头采样却把它当成了画面的一部分 —— 同一帧被
  // 无头采样出来后，图里就带着这行中文。现在画布只负责画面，文字归 DOM overlay。
  if (typeof view.onMediaState === 'function') {
    try {
      view.onMediaState(pending);
    } catch {
      /* 回调里的错不该毁掉这一帧 */
    }
  }

  ctx.restore();
}

function pauseVideo(v) {
  try {
    if (!v.paused) v.pause();
  } catch {
    /* 元素可能在销毁中 */
  }
}

function playVideo(v) {
  try {
    const p = v.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* 自动播放策略拒绝：画面照样由 seek 兜底 */
  }
}

function setVideoTime(v, t) {
  try {
    v.currentTime = t;
  } catch {
    /* 元数据还没到时设 currentTime 会抛，忽略即可 */
  }
}

/** 暂停 / 播放共用的一套「把视频摆到时间 t」的逻辑，返回这次需要的 seek 清单。 */
export function syncMedia(view, options = {}) {
  const playing = !!options.playing;
  const driftTolerance = Number.isFinite(options.driftTolerance) ? options.driftTolerance : DRIFT_TOLERANCE;
  const seekEps = Number.isFinite(options.seekEps) ? options.seekEps : SEEK_EPS;
  const { clips, assets, t } = view;
  const byId = new Map((assets || []).map((a) => [a.id, a]));
  const tr = transitionAt(clips, t);
  let buffering = 0;
  const seeks = [];
  const active = new Set();
  for (const c of clips || []) {
    if (c.type !== 'media') continue;
    const asset = byId.get(c.assetId);
    if (!asset) continue;
    // 音频素材没有 <video> 可驱动（也不该有）：驱动与 seek 一律跳过。
    if (isAudioAsset(asset)) continue;
    const v = pool.get(asset.id);
    if (!v) continue;
    const inside = c.start <= t && c.start + c.duration > t;
    const partner = !!(tr && (tr.a.id === c.id || tr.b.id === c.id));
    if (!inside && !partner) {
      pauseVideo(v);
      continue;
    }
    active.add(asset.id);
    // 变速：时间线时间 → 源时间；转场伙伴可能是越界的延长帧
    const want = sourceTime(c, t - c.start);
    if (playing) {
      if (v.readyState < 2) {
        buffering += 1;
        seeks.push({ assetId: asset.id, clipId: c.id, want, reason: 'not-ready', playing: true });
        continue;
      }
      if (v.paused) playVideo(v);
      if (v.seeking) {
        seeks.push({ assetId: asset.id, clipId: c.id, want, reason: 'seeking' });
      } else if (Math.abs(v.currentTime - want) > driftTolerance) {
        setVideoTime(v, want);
        seeks.push({ assetId: asset.id, clipId: c.id, want, reason: 'drift', corrected: true });
      }
      continue;
    }
    // 暂停：先停，再定位。
    // 这两行的顺序就是「暂停不住」的根因修复 —— 旧代码在 readyState<2 时
    // continue 掉了，<video> 根本没收到 pause()，于是它自己继续往前播。
    pauseVideo(v);
    if (v.readyState < 2) {
      buffering += 1;
      seeks.push({ assetId: asset.id, clipId: c.id, want, reason: 'not-ready' });
      continue;
    }
    if (v.seeking) {
      seeks.push({ assetId: asset.id, clipId: c.id, want, reason: 'seeking' });
      continue;
    }
    if (Math.abs(v.currentTime - want) > seekEps) {
      setVideoTime(v, want);
      seeks.push({ assetId: asset.id, clipId: c.id, want, reason: 'seek' });
    }
  }
  for (const [id, v] of pool) {
    if (!active.has(id)) pauseVideo(v);
  }
  return { buffering, seeks, active: [...active] };
}

/** Drive videos to `t`; returns how many are still buffering. */
export function syncVideos(view, opts = {}) {
  return syncMedia(view, opts).buffering;
}

/** 池子里所有 <video> 都停 —— 暂停语义是「全都停」，不看 readyState。 */
export function pauseAllVideos() {
  for (const v of pool.values()) pauseVideo(v);
}

// ------------------------------------------------------- 这一帧能画吗 ------

/**
 * 这一帧的视频是否真的定位到了目标时间。
 *
 * 旧代码在 `seeked` 之前就 drawImage：readyState<2 或者帧还是旧位置，
 * 画出来就是黑的。这里把「能不能画」变成一次显式判断，调用方据此
 * 保留上一帧（不清屏），而不是把黑画上去。
 *
 * @returns {{ready: boolean, pending: Array<object>}}
 */
export function frameMediaReadiness(view) {
  const t = view.t;
  const layers = view.layers || frameLayers(view.clips, t);
  const byId = new Map((view.assets || []).map((a) => [a.id, a]));
  const hvc1 = (view.codecs || codecSupport()).hvc1;
  const pending = [];
  for (const layer of layers) {
    if (layer.kind !== 'media') continue;
    const c = layer.clip;
    const tf = evaluateTransform(c, layer.localT);
    const alpha = (tf.opacity == null ? 1 : tf.opacity) * layer.alpha;
    if (alpha <= 0.001) continue; // 本来就不该有画面：不算「没就绪」
    const asset = byId.get(c.assetId);
    // 音频素材不参与画面，也就永远没有「这一帧能画吗」的问题：
    // 不跳过它，就绪判定会永远 pending，整帧被 hold 成黑屏（用户的实测回放）。
    if (asset && isAudioAsset(asset)) continue;
    const v = asset ? pool.get(asset.id) : null;
    const want = sourceTime(c, layer.localT);
    if (!asset || !v) {
      const d = mediaDiagnostic(asset, v, { hvc1, assetId: c.assetId });
      pending.push(Object.assign({ assetId: c.assetId, clipId: c.id, want, reason: d.code }, d));
      continue;
    }
    if (v.readyState < 2 || !(v.videoWidth > 0)) {
      const d = mediaDiagnostic(asset, v, { hvc1, assetId: c.assetId });
      pending.push(
        Object.assign({ assetId: c.assetId, clipId: c.id, want, reason: 'not-ready', drift: 0 }, d),
      );
      continue;
    }
    if (v.seeking) {
      pending.push({
        code: 'seek-pending',
        title: '这一帧还在定位（seek 未完成）',
        detail: '素材 ' + c.assetId + ' 目标 ' + want.toFixed(2) + 's，还停在 ' + Number(v.currentTime || 0).toFixed(2) + 's',
        hint: '画面保持上一帧，不黑屏。',
        blocker: false,
        assetId: c.assetId,
        clipId: c.id,
        want,
        reason: 'seeking',
        drift: Math.abs(Number(v.currentTime || 0) - want),
      });
      continue;
    }
    const drift = Math.abs(Number(v.currentTime || 0) - want);
    if (drift > DRIFT_TOLERANCE) {
      pending.push({
        code: 'seek-drift',
        title: '这一帧对不上（时间漂移）',
        detail:
          '素材 ' + c.assetId + ' 目标 ' + want.toFixed(2) + 's，当前 ' + Number(v.currentTime || 0).toFixed(2) + 's，偏差 ' + drift.toFixed(2) + 's',
        hint: '会重试 seek；画面保持上一帧。',
        blocker: false,
        assetId: c.assetId,
        clipId: c.id,
        want,
        reason: 'drift',
        drift,
      });
    }
  }
  return { ready: pending.length === 0, pending };
}

/**
 * 预览专用的一帧：就绪才画；没就绪就**一个像素都不动**（保留上一帧）。
 * 返回 {painted, pending}，调用方据此决定是否排重试。
 */
export function paintPreviewFrame(ctx, view) {
  const readiness = frameMediaReadiness(view);
  if (typeof view.onMediaState === 'function') {
    try {
      view.onMediaState(readiness.pending);
    } catch {
      /* 回调里的错不该毁掉这一帧 */
    }
  }
  if (!readiness.ready) return { painted: false, pending: readiness.pending };
  const inner = Object.assign({}, view);
  delete inner.onMediaState; // 上面已经回报过一次，别重复
  drawFrame(ctx, inner);
  return { painted: true, pending: [] };
}

// ------------------------------------------------------------ 播放引擎 ----

/**
 * 预览的单一时间源。用可注入的 now/raf/schedule 写成纯逻辑，所以
 * scripts/playback-test.mjs 不需要真实 DOM 就能钉死这四条：
 *
 *   - 暂停后 rAF 真的被取消（旧帧回调再被触发也不推进 playhead）
 *   - 暂停 = 所有 <video>.pause() + 音频 pause() + 定格画一帧
 *   - seek 没完成不画（不清屏）；seeked + readyState>=2 才画，且画的就是目标时间
 *   - 漂移超过阈值会重试，重试用尽后给中文诊断，而不是黑屏
 */
export function createPlaybackEngine(options = {}) {
  const opts = options || {};
  const getView = typeof opts.getView === 'function' ? opts.getView : () => ({ clips: [], assets: [], duration: 0 });
  const draw = typeof opts.draw === 'function' ? opts.draw : () => {};
  const onTick = typeof opts.onTick === 'function' ? opts.onTick : () => {};
  const onEnd = typeof opts.onEnd === 'function' ? opts.onEnd : () => {};
  const onDiagnostic = typeof opts.onDiagnostic === 'function' ? opts.onDiagnostic : () => {};
  const getAudio = typeof opts.getAudio === 'function' ? opts.getAudio : () => opts.audio || null;
  const now =
    typeof opts.now === 'function'
      ? opts.now
      : () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const raf = typeof opts.raf === 'function' ? opts.raf : (cb) => requestAnimationFrame(cb);
  const caf = typeof opts.caf === 'function' ? opts.caf : (id) => cancelAnimationFrame(id);
  const schedule = typeof opts.schedule === 'function' ? opts.schedule : (fn, ms) => setTimeout(fn, ms);
  const unschedule = typeof opts.unschedule === 'function' ? opts.unschedule : (id) => clearTimeout(id);
  const driftTolerance = Number.isFinite(opts.driftTolerance) ? opts.driftTolerance : DRIFT_TOLERANCE;
  const seekEps = Number.isFinite(opts.seekEps) ? opts.seekEps : SEEK_EPS;
  const seekTimeoutMs = Number.isFinite(opts.seekTimeoutMs) ? opts.seekTimeoutMs : SEEK_TIMEOUT_MS;
  const maxSeekRetries = Number.isFinite(opts.maxSeekRetries) ? opts.maxSeekRetries : MAX_SEEK_RETRIES;
  const scrubIntervalMs = Number.isFinite(opts.scrubIntervalMs) ? opts.scrubIntervalMs : SCRUB_INTERVAL_MS;

  let playing = false;
  let t = 0;
  let lastTick = 0;
  let hasTick = false;
  let frameId = 0;
  let retryTimer = 0;
  let settleSeq = 0;
  let retries = 0;
  let lastScrubAt = -Infinity;
  let disposed = false;
  let diagnostics = [];
  let waitCleanup = null;
  const stats = { frames: 0, paints: 0, holds: 0, retries: 0, plays: 0, pauses: 0 };

  const durationOf = () => {
    const v = getView() || {};
    const d = Number(v.duration);
    return Number.isFinite(d) && d > 0 ? d : 0;
  };
  const viewAt = (time) => Object.assign({}, getView() || {}, { t: time });

  function emitDiagnostics(list) {
    diagnostics = Array.isArray(list) ? list : [];
    try {
      onDiagnostic(diagnostics);
    } catch {
      /* 诊断回调不能打断播放 */
    }
  }

  function cancelFrame() {
    if (frameId) {
      caf(frameId);
      frameId = 0;
    }
  }

  function cancelWait() {
    if (waitCleanup) {
      try {
        waitCleanup();
      } catch {
        /* ignore */
      }
      waitCleanup = null;
    }
    if (retryTimer) {
      unschedule(retryTimer);
      retryTimer = 0;
    }
  }

  function audioCall(name, arg) {
    const audio = getAudio();
    if (audio && typeof audio[name] === 'function') {
      try {
        audio[name](arg);
      } catch {
        /* 音频失败不该打断画面 */
      }
    }
  }

  /** 唯一推进 playhead 的地方。 */
  function tick(stamp) {
    frameId = 0;
    if (disposed || !playing) return; // 暂停后旧回调被触发也拒绝推进
    const duration = durationOf();
    const dt = hasTick ? Math.max(0, (stamp - lastTick) / 1000) : 0;
    hasTick = true;
    lastTick = stamp;
    t = clampTime(t + dt, duration);
    stats.frames += 1;
    syncMedia(viewAt(t), { playing: true, driftTolerance, seekEps });
    onTick(t);
    draw(t, { playing: true });
    stats.paints += 1;
    if (duration > 0 && t >= duration - 1e-6) {
      const end = t;
      pause();
      onEnd(end);
      return;
    }
    frameId = raf(tick);
  }

  function play(fromT) {
    if (disposed) return;
    const start = clampTime(fromT == null ? t : fromT, durationOf());
    t = start;
    if (playing) {
      onTick(t);
      return;
    }
    cancelWait();
    retries = 0;
    playing = true;
    stats.plays += 1;
    lastTick = now();
    hasTick = true;
    syncMedia(viewAt(t), { playing: true, driftTolerance, seekEps });
    audioCall('play', t);
    onTick(t);
    draw(t, { playing: true });
    stats.paints += 1;
    if (!frameId) frameId = raf(tick);
  }

  function pause() {
    if (disposed) return;
    const wasPlaying = playing;
    playing = false;
    stats.pauses += 1;
    cancelFrame();
    cancelWait();
    retries = 0;
    pauseAllVideos();
    syncMedia(viewAt(t), { playing: false, driftTolerance, seekEps });
    audioCall('pause');
    onTick(t);
    settle(t, wasPlaying ? 'pause' : 'idle');
  }

  /**
   * 暂停/拖动后「定格」到 target：等 seeked + readyState>=2 再画。
   * 每次调用递增 settleSeq，旧的等待链自动作废。
   */
  function settle(target, reason) {
    const seq = ++settleSeq;
    cancelWait();
    retries = 0;

    const attempt = () => {
      if (disposed || seq !== settleSeq || playing) return;
      const view = viewAt(target);
      const readiness = frameMediaReadiness(view);
      if (readiness.ready) {
        emitDiagnostics([]);
        draw(target, { playing: false, reason, settled: true });
        stats.paints += 1;
        return;
      }
      if (retries < maxSeekRetries) {
        retries += 1;
        stats.retries += 1;
        // 重试要真的再对一次位置，而不只是干等 —— 旧实现只画一次，漂了就永远黑。
        syncMedia(viewAt(target), { playing: false, driftTolerance, seekEps });
        waitForReady(readiness.pending, attempt, Math.max(120, Math.round(seekTimeoutMs / Math.max(1, maxSeekRetries))));
        return;
      }
      // 重试用尽：给中文诊断，画面保持上一帧 —— 绝不画黑
      const pending = readiness.pending;
      const seekish = pending.some((p) => p.reason === 'seeking' || p.reason === 'drift' || p.reason === 'seek');
      const first = pending[0] || {};
      emitDiagnostics([
        {
          code: seekish ? 'seek-timeout' : 'media-not-ready',
          title: seekish ? '这一帧没解出来（seek 超时）' : '素材未就绪',
          detail: seekish
            ? 'seek 超时 ' + (seekTimeoutMs / 1000).toFixed(1) + 's，已重试 ' + maxSeekRetries + ' 次；播放头 ' +
              Number(target).toFixed(2) + 's，素材停在 ' + Number(first.want || 0).toFixed(2) + 's 附近'
            : '播放头 ' + Number(target).toFixed(2) + 's，素材还没解出画面（readyState < 2）',
          hint: '画面保留上一帧，不会黑屏。可以点「重新加载」或按 R 重建元素。',
          blocker: false,
          assetId: first.assetId,
          clipId: first.clipId,
          phase: reason,
        },
      ]);
      stats.holds += 1;
    };

    attempt();
  }

  /** 等 seeked / 首帧；超时也回调一次，让 settle 自己重试。 */
  function waitForReady(pending, done, waitMs) {
    const videos = [];
    for (const p of pending) {
      const v = p.assetId ? pool.get(p.assetId) : null;
      if (v && videos.indexOf(v) < 0) videos.push(v);
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const v of videos) {
        if (typeof v.removeEventListener === 'function') v.removeEventListener('seeked', onSeeked);
      }
      waitCleanup = null;
      if (retryTimer) {
        unschedule(retryTimer);
        retryTimer = 0;
      }
      done();
    };
    const onSeeked = () => {
      if (videos.every((v) => !v.seeking)) finish();
    };
    for (const v of videos) {
      if (typeof v.addEventListener === 'function') v.addEventListener('seeked', onSeeked);
      if (typeof v.requestVideoFrameCallback === 'function') {
        try {
          v.requestVideoFrameCallback(() => finish());
        } catch {
          /* 旧浏览器没有 rVFC 就只靠 seeked/超时 */
        }
      }
    }
    waitCleanup = () => {
      for (const v of videos) {
        if (typeof v.removeEventListener === 'function') v.removeEventListener('seeked', onSeeked);
      }
    };
    retryTimer = schedule(finish, waitMs);
  }

  function seek(to, seekOptions = {}) {
    if (disposed) return;
    const target = clampTime(to, durationOf());
    t = target;
    lastTick = now();
    settleSeq += 1;
    cancelWait();
    retries = 0;
    audioCall('seek', target);
    if (playing) {
      audioCall('play', target);
      syncMedia(viewAt(target), { playing: true, driftTolerance, seekEps });
      onTick(target);
      draw(target, { playing: true, scrub: !!seekOptions.scrub });
      stats.paints += 1;
      return;
    }
    syncMedia(viewAt(target), { playing: false, driftTolerance, seekEps });
    onTick(target);
    if (seekOptions.scrub) {
      // 拖动中：节流；有帧就画，没帧保留上一帧。绝不为了跟手去清屏。
      const at = now();
      if (seekOptions.force || at - lastScrubAt >= scrubIntervalMs) {
        lastScrubAt = at;
        const readiness = frameMediaReadiness(viewAt(target));
        if (readiness.ready) {
          emitDiagnostics([]);
          draw(target, { playing: false, scrub: true });
          stats.paints += 1;
        } else {
          stats.holds += 1;
        }
      }
      return;
    }
    settle(target, 'seek');
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    playing = false;
    settleSeq += 1;
    cancelFrame();
    cancelWait();
    pauseAllVideos();
    audioCall('pause');
  }

  return {
    play,
    pause,
    seek,
    dispose,
    /** 媒体就绪状态变了（loadeddata / 重新加载）时叫一次：暂停态下重新定格。 */
    refresh() {
      if (disposed) return;
      if (playing) syncMedia(viewAt(t), { playing: true, driftTolerance, seekEps });
      else settle(t, 'refresh');
    },
    isPlaying: () => playing,
    playhead: () => t,
    setPlayhead(value) {
      t = clampTime(value, durationOf());
    },
    diagnostics: () => diagnostics.slice(),
    stats: () => Object.assign({}, stats),
    /** 测试/诊断用：当前挂着的 rAF id（0 表示循环已停）。 */
    pendingFrame: () => frameId,
  };
}

/** 预建整条时间线上的 <video>。等价于 ensureVideos，留着给老调用点。 */
export function prewarm(assets, urlFor) {
  return ensureVideos(assets, urlFor);
}
