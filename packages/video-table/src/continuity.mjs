/**
 * 连续性检查器：把「一卡一卡 / 不线性」这种主观抱怨变成可复现的数字。
 *
 * 为什么需要它：
 *   用户的反馈是「同一张卡片，前一帧字在左、下一帧字跑到右了」和「运镜一顿一顿」。
 *   这两种症状在代码里长得完全不一样（前者是布局量突变，后者是时间/缓动不连续），
 *   但在成片上都是同一件事：**相邻两帧之间的状态差，比它周围的帧大一个数量级。**
 *   所以检查器的核心不是「像不像」，而是「这一帧比邻居异常多少」。
 *
 * 它做什么：
 *   1) 按 fps 连续渲 N 帧（走 headless 同一条渲染核，绝不另写一套画法）；
 *   2) 相邻帧算像素 MAD（平均绝对差）；
 *   3) 每帧算内容包围盒（bbox），拿 bbox 中心位移判「内容整体挪了多少」；
 *   4) 把这两件事跟**局部基线**（前后 window 帧的中位数）比：
 *      正常运动是连续的，跳变是离群的 —— 这就是「正常运动」和「跳变」的分界。
 *
 * 它不做什么：
 *   不做图像识别，不说「这是圆角矩形」。所有输出都是像素统计量，说得出算法。
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DomainError } from './domain.mjs';
import { decodePng } from './headless-png.mjs';
import { renderFramesHeadless } from './headless.mjs';
import { readEntryCode } from './motion-lib.mjs';
import { readCode } from './code-store.mjs';

/**
 * 默认参数，以及每个数字是怎么来的。
 *
 * threshold = 0.035（像素 MAD，0..1）
 *   实测数据（见 docs/motion-continuity.md 的体检表）：在 480×270、30fps 下，
 *   一张卡正常的连续运动（横移、弹立、淡入）相邻帧 MAD 落在 0.002–0.030；
 *   而真正的单帧瞬移（内容整体挪动 10% 画宽）MAD 在 0.06–0.25。
 *   0.035 落在中间那段空档里：比所有「正常运动」高，比所有「瞬移」低。
 *   ★ 它是**地板**，不是唯一判据 —— 还要过局部基线那一关（见 spike）。
 *
 * shiftThreshold = 0.05（bbox 中心位移 / 画宽）
 *   需求里定的「bbox 突然平移 > 画面宽 5%」。低于 5% 的位移多半是文字逐字生长、
 *   数字位数变化这类「内容自己在变」而不是「布局跳」。
 *
 * lumaThreshold = 0.06（整帧平均亮度变化）
 *   淡入淡出一帧最多 1/30 的行程；整帧亮度一次跳 6% 已经肉眼可见地「闪了一下」。
 *
 * spike = 2.5（相对局部基线的倍数）
 *   纯绝对阈值会在「本来就有大运动」的卡上误报（比如镜头快速掠过）。
 *   要求跳变点的 MAD 同时是周围 ±6 帧中位数的 2.5 倍以上，才叫「离群」。
 *   2.5 倍是经验值：实测卡上正常运动的帧间波动最大约 1.8 倍。
 *
 * stationaryRatio = 0.001（位移 < 0.1% 画宽算「没动」）
 *   判「卡住」用：连续很多帧不动，也是不丝滑的一种（节奏死点）。
 */
export const CONTINUITY_DEFAULTS = Object.freeze({
  start: 0,
  end: 3,
  fps: 30,
  threshold: 0.035,
  shiftThreshold: 0.05,
  lumaThreshold: 0.06,
  spike: 2.5,
  window: 6,
  stationary: 0.001,
  jitterFloor: 0.002,
  maxDim: 480,
  maxFrames: 240,
  minFps: 1,
  maxFps: 60,
  bgTolerance: 24,
});

// ------------------------------------------------------------------ 小工具 ----

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

function median(values) {
  const list = values.filter((v) => finite(v)).sort((a, b) => a - b);
  if (!list.length) return 0;
  const mid = list.length >> 1;
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/** 分位数（线性插值）。空数组返回 0，不给 NaN。 */
export function quantile(values, q) {
  const list = values.filter((v) => finite(v)).sort((a, b) => a - b);
  if (!list.length) return 0;
  const p = Math.max(0, Math.min(1, finite(q) ? q : 0.95));
  const pos = (list.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return list[lo];
  return list[lo] + (list[hi] - list[lo]) * (pos - lo);
}

const round = (n, digits = 5) => {
  if (!finite(n)) return 0;
  const k = 10 ** digits;
  return Math.round(n * k) / k;
};

// -------------------------------------------------------------- 单帧统计 ----

/**
 * 一帧的统计量：背景色、内容包围盒、内容占比、平均亮度。
 *
 * 背景 = 出现次数最多的量化颜色（5 bit/通道）。为什么用众数而不是四角采样：
 * 卡片经常有整幅出血的底色、四角却被角标/进度条占着，众数对这两种都稳。
 *
 * 内容掩码 = 与背景色的最大通道差 > bgTolerance 的像素。抗锯齿的文字边缘天然被
 * 算进内容，这正是我们要的：bbox 要包住「看得见的东西」。
 */
export function frameStats(image, options = {}) {
  const tolerance = finite(options.bgTolerance) ? options.bgTolerance : CONTINUITY_DEFAULTS.bgTolerance;
  const width = Number(image && image.width) || 0;
  const height = Number(image && image.height) || 0;
  const data = image && image.data;
  if (!width || !height || !data || data.length < width * height * 4) {
    throw new DomainError('INVALID_ARG', 'frameStats 需要 {width, height, data(RGBA)}');
  }
  const total = width * height;
  const histogram = new Uint32Array(32768); // 5 bit × 3
  for (let i = 0; i < data.length; i += 4) {
    histogram[((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)] += 1;
  }
  let bestKey = 0;
  let bestCount = 0;
  for (let key = 0; key < histogram.length; key += 1) {
    if (histogram[key] > bestCount) {
      bestCount = histogram[key];
      bestKey = key;
    }
  }
  const bg = [((bestKey >> 10) & 31) << 3, ((bestKey >> 5) & 31) << 3, (bestKey & 31) << 3];

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let maskCount = 0;
  let lumaSum = 0;
  // 墨迹剖面：判「运镜丝不丝滑」用。bbox 中心在「整幅一条横线」的卡上是退化的
  // （轴线横跨整幅、位置不变 → 相机移动看不出来），剖面互相关不会退化。
  const colInk = new Float32Array(width);
  const rowInk = new Float32Array(height);
  for (let y = 0; y < height; y += 1) {
    let row = y * width * 4;
    for (let x = 0; x < width; x += 1, row += 4) {
      const r = data[row];
      const g = data[row + 1];
      const b = data[row + 2];
      lumaSum += 0.299 * r + 0.587 * g + 0.114 * b;
      const dr = r > bg[0] ? r - bg[0] : bg[0] - r;
      const dg = g > bg[1] ? g - bg[1] : bg[1] - g;
      const db = b > bg[2] ? b - bg[2] : bg[2] - b;
      if (dr > tolerance || dg > tolerance || db > tolerance) {
        maskCount += 1;
        colInk[x] += 1;
        rowInk[y] += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const bbox =
    maskCount > 0
      ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
      : null;
  return {
    width,
    height,
    bg,
    bbox,
    center: bbox ? { x: (bbox.x + bbox.w / 2) / width, y: (bbox.y + bbox.h / 2) / height } : null,
    contentRatio: maskCount / total,
    meanLuma: lumaSum / total / 255,
    colInk,
    rowInk,
  };
}

/**
 * 一维墨迹剖面的互相关位移估计：b(x) ≈ a(x - s) 时返回 s（像素，正 = 内容向右）。
 *
 * 为什么不用 bbox 中心：卡片上常有一条横跨整幅的参照物（时间轴线、分隔线、背景条），
 * 它们的 bbox 永远铺满整幅、中心不动 —— 于是「相机在横移」被量成「没动」。
 * 墨迹剖面按列/行累加内容像素，移动的内容会整体推着剖面走，参照线不影响峰值位置。
 *
 * 峰值不唯一时偏向 0（d 从 0 向两边扫，只用「严格更大」才换）：
 * 纯色/对称画面必须给出 0，而不是随便挑一个端点造成假抖动。
 */
export function estimateShift(prevProfiles, curProfiles, maxShiftRatio = 0.2) {
  const scan = (a, b) => {
    const n = Math.min(a.length, b.length);
    if (!n) return 0;
    const max = Math.max(1, Math.min(n >> 1, Math.floor(n * maxShiftRatio)));
    let meanA = 0;
    let meanB = 0;
    for (let i = 0; i < n; i += 1) {
      meanA += a[i];
      meanB += b[i];
    }
    meanA /= n;
    meanB /= n;
    const scoreAt = (d) => {
      const lo = Math.max(0, -d);
      const hi = Math.min(n, n - d);
      if (hi - lo < n * 0.6) return null;
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = lo; i < hi; i += 1) {
        const av = a[i] - meanA;
        const bv = b[i + d] - meanB;
        dot += av * bv;
        na += av * av;
        nb += bv * bv;
      }
      if (na <= 1e-9 || nb <= 1e-9) return 0; // 扁平剖面：不提供信息
      return dot / Math.sqrt(na * nb);
    };
    let best = 0;
    let bestScore = scoreAt(0);
    if (bestScore === null || !finite(bestScore)) bestScore = 0;
    let zeroScore = bestScore;
    for (let d = 1; d <= max; d += 1) {
      for (const sign of [1, -1]) {
        const score = scoreAt(sign * d);
        if (score === null) continue;
        if (score > bestScore + 1e-9) {
          bestScore = score;
          best = sign * d;
        }
      }
    }
    // 「明显好于不动」才认这步位移。没有这条，纯改内容（数字换字形）也会被
    // 互相关硬凑出一个位移峰值，把「字变了」误报成「字跑了」。
    if (best !== 0 && bestScore - zeroScore < 0.02) return 0;
    return best;
  };
  const dx = scan(prevProfiles.colInk, curProfiles.colInk);
  const dy = scan(prevProfiles.rowInk, curProfiles.rowInk);
  return { dx, dy, magnitude: Math.hypot(dx, dy) };
}

/** 两张同尺寸 RGBA 图的平均绝对差（0..1）。只比 RGB，alpha 不参与。 */
export function madOf(a, b) {
  if (!a || !b) throw new DomainError('INVALID_ARG', 'madOf 需要两张图');
  if (a.width !== b.width || a.height !== b.height) {
    throw new DomainError('INVALID_ARG', `尺寸不一致: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  let sum = 0;
  const da = a.data;
  const db = b.data;
  for (let i = 0; i < da.length; i += 4) {
    sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
  }
  return sum / (a.width * a.height * 3 * 255);
}

/**
 * 相邻两帧的差异包：像素差 + bbox 位移 + 亮度跳变。
 *
 * bboxShiftRatio 用「中心欧氏距离 / 画宽」归一化 —— 这样 5% 这个阈值在 16:9 和
 * 9:16 上含义一致，不会因为换画幅就漂。
 */
export function pairDiff(prev, cur) {
  const mad = madOf(prev.image, cur.image);
  let bboxShift = 0;
  let bboxShiftRatio = 0;
  let sizeChange = 0;
  if (prev.center && cur.center) {
    const dx = (cur.center.x - prev.center.x) * cur.width;
    const dy = (cur.center.y - prev.center.y) * cur.height;
    bboxShift = Math.hypot(dx, dy);
    bboxShiftRatio = Math.abs(dx) / cur.width + Math.abs(dy) / cur.width;
    const a1 = prev.bbox.w * prev.bbox.h;
    const a2 = cur.bbox.w * cur.bbox.h;
    sizeChange = Math.abs(a2 - a1) / Math.max(1, a2, a1);
  } else if (Boolean(prev.center) !== Boolean(cur.center)) {
    // 一帧有内容、一帧空白：bbox 从「没有」变成「有」，按满幅位移算
    bboxShiftRatio = 1;
    sizeChange = 1;
  }
  // 内容整体位移：剖面互相关。bbox 在「横跨整幅的参照线」上会退化，剖面不会。
  const motion =
    prev.colInk && cur.colInk && prev.rowInk && cur.rowInk
      ? estimateShift(prev, cur, 0.2)
      : { dx: 0, dy: 0, magnitude: 0 };
  const motionShiftRatio = motion.magnitude / Math.max(1, cur.width);
  const lumaDelta =
    finite(prev.meanLuma) && finite(cur.meanLuma) ? Math.abs(cur.meanLuma - prev.meanLuma) : 0;
  return {
    mad,
    bboxShift,
    bboxShiftRatio,
    motion,
    motionShiftRatio,
    // 判定用的「内容挪了多少」：两条路取大的那条
    shiftRatio: Math.max(bboxShiftRatio, motionShiftRatio),
    sizeChange,
    lumaDelta,
    contentRatio: Math.min(prev.contentRatio, cur.contentRatio),
  };
}

/**
 * 判定一对相邻帧是不是「跳变」。纯函数，只吃差异包和阈值。
 *
 * baseline 是局部基线（周围帧的 MAD / bbox 位移中位数）。spike > 0 时要求
 * 本次差异至少是基线的 spike 倍 —— 这才是「离群」。spike = 0 时退化成纯绝对阈值，
 * 测试用它做阈值边界断言。
 *
 * 返回 null（不是跳变）或 'layout' | 'opacity' | 'camera' | 'other'。
 */
export function judge(diff, options = {}) {
  const o = Object.assign({}, CONTINUITY_DEFAULTS, options);
  const mad = finite(diff && diff.mad) ? diff.mad : 0;
  const shift = finite(diff && diff.shiftRatio)
    ? diff.shiftRatio
    : finite(diff && diff.bboxShiftRatio)
      ? diff.bboxShiftRatio
      : 0;
  const luma = finite(diff && diff.lumaDelta) ? diff.lumaDelta : 0;
  const contentRatio = finite(diff && diff.contentRatio) ? diff.contentRatio : 0;
  const sizeChange = finite(diff && diff.sizeChange) ? diff.sizeChange : 0;
  const madBaseline = finite(o.madBaseline) ? Math.max(0, o.madBaseline) : 0;
  const shiftBaseline = finite(o.shiftBaseline) ? Math.max(0, o.shiftBaseline) : 0;
  const spike = finite(o.spike) ? o.spike : 0;

  const madHigh = mad >= o.threshold;
  const shiftHigh = shift >= o.shiftThreshold;
  if (!madHigh && !shiftHigh) return null;

  const madSpikes = spike <= 0 || madBaseline <= 0 ? true : mad >= spike * madBaseline;
  const shiftSpikes = spike <= 0 || shiftBaseline <= 0 ? true : shift >= spike * shiftBaseline;

  // bbox 挪了但画面几乎没变（mad 很低）= 掩码边缘在抖（抗锯齿/半透明），不是布局跳。
  // 需求里写的判据就是「bbox 突然平移 > 5% **且** MAD 突增」，两条必须同时成立。
  if (shiftHigh && shiftSpikes) {
    if (!(madHigh && madSpikes)) return null;
    // 整幅内容刚性平移（内容铺满 + 面积没变）→ 是运镜；否则是布局重排
    return contentRatio >= 0.6 && sizeChange <= 0.06 ? 'camera' : 'layout';
  }
  if (!(madHigh && madSpikes)) return null;
  if (luma >= o.lumaThreshold) return 'opacity';
  return 'other';
}

// -------------------------------------------------------------- 序列分析 ----

/**
 * 分析一串连续帧。
 *
 * @param {Array} frames [{ t, width, height, data: Uint8Array(RGBA) }]
 * @param {object} options 见 CONTINUITY_DEFAULTS
 * @returns {{samples, jumps, smoothness, verdict, ...}}
 */
export function analyzeSeries(frames, options = {}) {
  const o = Object.assign({}, CONTINUITY_DEFAULTS, options);
  if (!Array.isArray(frames) || frames.length < 2) {
    throw new DomainError('INVALID_ARG', `至少需要 2 帧才能比连续性，收到 ${Array.isArray(frames) ? frames.length : 0} 帧`);
  }
  const stats = frames.map((f) => frameStats(f, o));
  const images = frames.map((f, i) => ({
    image: f,
    center: stats[i].center,
    bbox: stats[i].bbox,
    width: f.width,
    height: f.height,
    contentRatio: stats[i].contentRatio,
    meanLuma: stats[i].meanLuma,
    colInk: stats[i].colInk,
    rowInk: stats[i].rowInk,
  }));
  const diffs = [];
  for (let i = 1; i < frames.length; i += 1) diffs.push(pairDiff(images[i - 1], images[i]));

  const madSeries = diffs.map((d) => d.mad);
  const shiftSeries = diffs.map((d) => d.shiftRatio);
  const jumps = [];

  for (let i = 0; i < diffs.length; i += 1) {
    // 局部基线：跳过自身，取前后 window 帧
    const neighbors = [];
    for (let k = Math.max(0, i - o.window); k <= Math.min(diffs.length - 1, i + o.window); k += 1) {
      if (k !== i) neighbors.push(k);
    }
    const madBaseline = median(neighbors.map((k) => madSeries[k]));
    const shiftBaseline = median(neighbors.map((k) => shiftSeries[k]));
    const kind = judge(diffs[i], { ...o, madBaseline, shiftBaseline });
    if (!kind) continue;
    // diffs[i] 比的是 frames[i] 和 frames[i+1]，所以报出来的 t 是**后一帧**的时间：
    // 「这一帧相对上一帧跳了」。写成 frames[i] 会让所有点早一帧，排错时对不上图。
    jumps.push({
      t: round(frames[i + 1].t, 4),
      from: i,
      to: i + 1,
      mad: round(diffs[i].mad, 5),
      kind,
      bboxFrom: stats[i].bbox ? { ...stats[i].bbox } : null,
      bboxTo: stats[i + 1].bbox ? { ...stats[i + 1].bbox } : null,
    });
  }

  // 位移序列（px）：用剖面互相关的整体位移，而不是 bbox 中心 ——
  // 后者在「横跨整幅的参照线」上会退化成恒定值，把真实的运镜量成 0。
  const deltas = diffs.map((d) => ({ dx: d.motion.dx, dy: d.motion.dy }));
  const span = frames[0].width || 1;
  const speeds = deltas.map((d) => Math.hypot(d.dx, d.dy));
  const jerks = [];
  for (let i = 1; i < deltas.length; i += 1) {
    jerks.push(Math.hypot(deltas[i].dx - deltas[i - 1].dx, deltas[i].dy - deltas[i - 1].dy));
  }
  let jitterCount = 0;
  for (let i = 1; i < deltas.length; i += 1) {
    const a = deltas[i - 1];
    const b = deltas[i];
    const dot = a.dx * b.dx + a.dy * b.dy;
    if (dot < 0 && Math.hypot(a.dx, a.dy) > o.jitterFloor * span && Math.hypot(b.dx, b.dy) > o.jitterFloor * span) {
      jitterCount += 1;
    }
  }
  const stationaryCount = speeds.filter((v) => v <= o.stationary * span).length;

  const smoothness = {
    velocityJerkP95: round(quantile(jerks, 0.95), 3),
    jerkMax: round(jerks.length ? Math.max(...jerks) : 0, 3),
    meanSpeed: round(speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0, 3),
    stationaryRatio: round(speeds.length ? stationaryCount / speeds.length : 0, 4),
    jitterCount,
    // 方向翻转率：jitter / 有效运动帧数，换画幅也能比
    jitterRatio: round(speeds.length ? jitterCount / speeds.length : 0, 4),
  };

  const fatal = jumps.filter((j) => j.kind === 'layout' || j.kind === 'camera');
  let verdict = 'smooth';
  if (fatal.length > 0) verdict = 'broken';
  else if (jumps.length > 0) verdict = 'minor-jumps';

  const out = {
    samples: frames.length,
    jumps,
    smoothness,
    verdict,
    width: frames[0].width,
    height: frames[0].height,
    fps: o.fps,
    threshold: o.threshold,
    shiftThreshold: o.shiftThreshold,
    worst: jumps.slice().sort((a, b) => b.mad - a.mad).slice(0, 3),
  };
  // 给标定用的原始序列：默认**不加这个键**（不是 null、不是 undefined ——
  // 有键就得多带 90 个数回来，而且 undefined 会让「无损 JSON」这关过不去）
  if (o.includeSeries) {
    out.series = {
      t: frames.slice(1).map((f) => round(f.t, 4)),
      mad: madSeries.map((v) => round(v, 6)),
      shift: shiftSeries.map((v) => round(v, 6)),
      luma: diffs.map((d) => round(d.lumaDelta, 6)),
      dx: diffs.map((d) => d.motion.dx),
      dy: diffs.map((d) => d.motion.dy),
    };
  }
  return out;
}

/**
 * 同上，但吃 PNG buffer 列表。
 * 注意：它一次性把所有帧解进内存（90 帧 480×270 约 47MB），只适合小批量的外部调用；
 * 工具路径 `measureContinuity` 走的是同一条 `analyzeSeries`，但自己在调用点逐帧解码。
 */
export function analyzePngBuffers(buffers, options = {}) {
  if (!Array.isArray(buffers) || buffers.length < 2) {
    throw new DomainError('INVALID_ARG', `至少需要 2 张 PNG，收到 ${Array.isArray(buffers) ? buffers.length : 0} 张`);
  }
  const frames = buffers.map((buf) => {
    const img = decodePng(buf);
    return { t: 0, width: img.width, height: img.height, data: img.data };
  });
  return analyzeSeries(frames, options);
}

// ------------------------------------------------------------ 采样编排 ----

/** 把 [start,end) 按 fps 切成时间点；帧数不够或超上限时给可读错误。 */
export function planTimes({ start, end, fps }) {
  const o = CONTINUITY_DEFAULTS;
  const s = Number(start);
  const e = Number(end);
  const f = fps == null ? o.fps : Number(fps);
  if (!Number.isFinite(s)) throw new DomainError('INVALID_ARG', 'start 必须是数字（秒）');
  if (!Number.isFinite(e)) throw new DomainError('INVALID_ARG', 'end 必须是数字（秒）');
  if (!Number.isFinite(f)) throw new DomainError('INVALID_ARG', 'fps 必须是数字');
  if (s < 0) throw new DomainError('INVALID_ARG', `start 不能为负（收到 ${s}）`);
  if (e <= s) throw new DomainError('INVALID_ARG', `end(${e}) 必须大于 start(${s})，空区间没有连续性可测`);
  if (f < o.minFps || f > o.maxFps) {
    throw new DomainError('INVALID_ARG', `fps 必须在 ${o.minFps}..${o.maxFps} 之间，收到 ${f}`);
  }
  const count = Math.round((e - s) * f);
  if (count < 2) {
    throw new DomainError('INVALID_ARG', `区间 ${s}–${e}s @${f}fps 只有 ${count} 帧，至少要 2 帧`);
  }
  if (count > o.maxFrames) {
    throw new DomainError(
      'INVALID_ARG',
      `一次最多采 ${o.maxFrames} 帧，当前 ${count} 帧；缩短区间或降低 fps（例如 ${o.maxFrames / f} 秒以内）`,
    );
  }
  const times = [];
  for (let i = 0; i < count; i += 1) times.push(Math.round((s + i / f) * 10000) / 10000);
  return { times, fps: f, start: s, end: e, count };
}

/** motion-<cardId> / cardId / 工程里的 layerId，取到源码的那一个 id。 */
function stripMotionPrefix(id) {
  return /^motion-/.test(id) ? id.slice('motion-'.length) : id;
}

/**
 * 决定这次到底渲什么：
 *   - 传了 layerId 且动效库里有这张卡 → 卡片模式：临时工程里放一个覆盖 [start,end) 的
 *     代码片段，localT 就等于 t（卡片自己的时间轴）；
 *   - 否则（纯工程）→ 时间线模式：[start,end) 是**时间线秒数**，按真实工程渲。
 */
export async function resolveTarget({ store, projectId, layerId, start, end, fps, props }) {
  const plan = planTimes({ start, end, fps });
  const cleanId = layerId ? String(layerId) : null;
  if (cleanId) {
    const code = await readEntryCode(stripMotionPrefix(cleanId));
    if (code) {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vw-continuity-'));
      const duration = plan.end + 1 / plan.fps + 0.5;
      return {
        mode: 'card',
        root,
        temp: true,
        targetId: stripMotionPrefix(cleanId),
        times: plan.times,
        fps: plan.fps,
        clips: [
          {
            id: 'continuity_clip',
            trackId: 'v1',
            type: 'code',
            layerId: 'continuity_layer',
            codeHash: 'continuity',
            props: props && typeof props === 'object' ? props : {},
            start: 0,
            duration,
          },
        ],
        assets: [],
        codeSources: { continuity_layer: code },
        doc: {
          projectId: 'continuity',
          revision: 0,
          fps: plan.fps,
          duration,
          tracks: [{ id: 'v1', kind: 'video', name: 'v1' }],
        },
      };
    }
  }

  if (!store) throw new DomainError('REF_NOT_FOUND', `动效库里没有 ${cleanId}，也没有可用的工程可以渲时间线`);
  const doc = projectId ? store.get(projectId).doc : null;
  if (!doc) throw new DomainError('REF_NOT_FOUND', '没有这个工程：' + projectId);
  const codeSources = {};
  for (const clip of doc.clips || []) {
    if (!clip || clip.type !== 'code' || !clip.layerId) continue;
    if (Object.prototype.hasOwnProperty.call(codeSources, clip.layerId)) continue;
    try {
      codeSources[clip.layerId] = await readCode(doc.root, clip.layerId);
    } catch {
      /* 缺源码的图层由渲染页记一条 CODE_SOURCE_MISSING，其余照画 */
    }
  }
  if (cleanId && !(doc.clips || []).some((c) => c && c.layerId === cleanId)) {
    throw new DomainError('REF_NOT_FOUND', `工程里没有图层 ${cleanId}，动效库里也没有这张卡`);
  }
  return {
    mode: 'timeline',
    root: doc.root,
    temp: false,
    targetId: cleanId || null,
    times: plan.times,
    fps: plan.fps,
    clips: doc.clips,
    assets: doc.assets,
    codeSources,
    doc,
    projectId: doc.projectId,
  };
}

/**
 * 渲帧 + 分析，一次做完。工具层和体检脚本共用这一条路径。
 */
export async function measureContinuity({ store, projectId, layerId, start, end, fps, threshold, maxDim, props, timeoutMs, includeSeries }) {
  const o = CONTINUITY_DEFAULTS;
  const target = await resolveTarget({ store, projectId, layerId, start, end, fps, props });
  const startedAt = Date.now();
  try {
    const rendered = await renderFramesHeadless({
      root: target.root,
      doc: target.doc,
      clips: target.clips,
      assets: target.assets,
      times: target.times,
      maxDim: finite(maxDim) ? Math.max(160, Math.min(1024, Math.round(maxDim))) : o.maxDim,
      codeSources: target.codeSources,
      timeoutMs: finite(timeoutMs) ? timeoutMs : 30000 + target.times.length * 250,
    });
    if (rendered.frames.length < 2) {
      throw new DomainError('HEADLESS_FAILED', `只渲出 ${rendered.frames.length} 帧，不足以比连续性`, {
        errors: rendered.errors,
      });
    }
    const buffers = await Promise.all(rendered.frames.map((f) => fsp.readFile(f.path)));
    const series = analyzeSeries(
      buffers.map((buf, index) => {
        const img = decodePng(buf);
        return { t: rendered.frames[index].time, width: img.width, height: img.height, data: img.data };
      }),
      { threshold: finite(threshold) ? threshold : o.threshold, fps: target.fps, includeSeries: includeSeries === true },
    );
    return {
      ...series,
      target: { kind: target.mode, id: target.targetId, layerId: layerId || null },
      range: { start: Number(start), end: Number(end) },
      via: 'headless',
      backend: rendered.backend,
      elapsedMs: Date.now() - startedAt,
      warnings: rendered.errors || [],
    };
  } finally {
    if (target.temp) await fsp.rm(target.root, { recursive: true, force: true }).catch(() => {});
  }
}
