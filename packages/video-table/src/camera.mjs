/**
 * 摄像机状态契约（camera continuity）
 *
 * 问题（用户实测）：很多「运镜」卡只有入口、没有出口 —— 片尾停在放大后的构图上，
 * 下一镜又从 1.0 起。两帧之间 scale / 偏移突变，肉眼就是「卡一下 + 位置变了」。
 *
 * 本模块只做三件事，都是纯函数，不读盘、不渲染：
 *   1. cameraAt(t, duration, { points | in/out })  —— 按关键帧插值出某一帧的机位
 *   2. cameraKeyframes({ zoomTo, hold, enter, exit }) —— 生成「进 → 停 → 回」的标准点集
 *   3. cameraContinuity(prev, next) / scanCameraContinuity(clips) —— 判两个镜头的边界连不连
 *
 * 每张卡在 code.js 里声明自己的出入口（宿主的 video_camera_check 会读它）：
 *
 *   export const camera = {
 *     in:  { scale: 1.0, x: 0, y: 0 },   // 第一帧
 *     out: { scale: 1.0, x: 0, y: 0 },   // 最后一帧（省略 = 恒等 1/0/0）
 *   };
 *
 * 想自证曲线与声明一致，再导出（可选，宿主会优先用它采边界帧）：
 *
 *   export function cameraAt(t, duration, props) { return { scale, x, y }; }
 *
 * 坐标约定：scale 是相对全画幅的放大倍数（1 = 原始构图）；x / y 是画面偏移，
 * 单位是「画幅比例」而不是像素（0.1 = 画宽的 10%），这样同一张卡在 720p / 1080p
 * 下声明值不变。卡片内部要像素时自己乘 W / H。
 *
 * 没有声明 camera 的卡 = 恒等机位，不算错（老卡不动）。
 */

/** 默认容差：相邻两帧的 scale / 偏移差在 1e-3 以内算接上了。 */
export const CAMERA_EPS = 1e-3;

/** 恒等机位。冻结 —— 常数被谁改一笔，整个检查器都会疯。 */
export const IDENTITY_CAMERA = Object.freeze({ scale: 1, x: 0, y: 0 });

/** 三段式默认比例：进入 25% / 停留 40% / 返回 35%。 */
export const DEFAULT_CAMERA_RATIO = Object.freeze({ enter: 0.25, hold: 0.4, exit: 0.35 });

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

function safeScale(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * 把一个机位声明归一成 { scale, x, y }。
 *
 * 接受：undefined / null（恒等）、数字（只给 scale）、{scale,x,y}、函数（调用后取返回值）。
 * 非法值一律退回恒等，不抛 —— 一张坏声明不该让整个时间线检查失败。
 */
export function normalizeCamera(value) {
  if (typeof value === 'function') {
    try {
      return normalizeCamera(value());
    } catch {
      return { ...IDENTITY_CAMERA };
    }
  }
  if (typeof value === 'number') return { scale: safeScale(value), x: 0, y: 0 };
  if (!value || typeof value !== 'object') return { ...IDENTITY_CAMERA };
  return {
    scale: safeScale(value.scale),
    x: num(value.x, 0),
    y: num(value.y, 0),
  };
}

/**
 * 归一化一个「出入口」声明：{ in, out }（省略哪边就恒等）。
 * 已经是单个机位（{scale,x,y}）时，两边都取它 —— 方便调用方少写一层。
 */
export function normalizeCameraSpec(spec) {
  if (!spec || typeof spec !== 'object') return { in: { ...IDENTITY_CAMERA }, out: { ...IDENTITY_CAMERA } };
  const hasSide = Object.prototype.hasOwnProperty.call(spec, 'in') || Object.prototype.hasOwnProperty.call(spec, 'out');
  if (!hasSide) {
    const one = normalizeCamera(spec);
    return { in: { ...one }, out: { ...one } };
  }
  return { in: normalizeCamera(spec.in), out: normalizeCamera(spec.out) };
}

// ---------------------------------------------------------------- 缓动 ----

export const easeLinear = (t) => clamp01(t);
/** 快进慢出：一上来就走，到点收住（速度在 1 处为 0）。 */
export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);
/** 慢进慢出：两端速度都为 0，且关于中点奇对称。 */
export const easeInOutQuad = (t) => {
  const u = clamp01(t);
  return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
};
/** easeOutCubic 的时间镜像：u³。往返的「返回段」用它，才和进入段严格互为镜像。 */
export const easeInCubic = (t) => Math.pow(clamp01(t), 3);

const EASES = {
  linear: easeLinear,
  easeOutCubic,
  easeInOutQuad,
  easeInCubic,
  // 返回段：把进入段的曲线倒着放 —— g(u) = 1 - f(1-u)。
  // 与 EASES.easeOutCubic 配对时等价于 easeInCubic，但名字写的是语义而不是数学。
  mirror: (u) => 1 - easeOutCubic(1 - clamp01(u)),
};

export function resolveEase(name) {
  if (typeof name === 'function') return name;
  return EASES[String(name || 'linear')] || EASES.linear;
}

/**
 * 镜像缓动：一条「进 + 回」的对称相位曲线。
 *
 * 前半段用 easeOutCubic（0.5 × f(2u)），后半段是它的严格镜像。
 * 性质（测试逐条验）：
 *   - mirrorEase(0) = 0，mirrorEase(1) = 1，mirrorEase(0.5) = 0.5
 *   - 关于中点奇对称：mirrorEase(1 - u) = 1 - mirrorEase(u)
 *   - 1 处一阶导为 0（落点不抖）；0 处不为 0（起手有速度）
 *
 * 与 `easeInOutQuad` 的区别：后者两端速度都是 0，适合「一段独立的缓动」；
 * `mirrorEase` 用于「同一段里先出后回」，两端（0 与 1）是同一条曲线的两端，
 * 所以看起来是同一口气，而不是两段拼接。
 */
export function mirrorEase(t) {
  const u = clamp01(t);
  if (u <= 0.5) return 0.5 * easeOutCubic(2 * u);
  return 1 - 0.5 * easeOutCubic(2 * (1 - u));
}

// ------------------------------------------------------------- 关键帧 ----

function normalizePoints(points, duration) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const list = points
    .filter((p) => p && typeof p === 'object')
    .map((p, index) => ({
      t: Math.min(duration, Math.max(0, num(p.t, index === 0 ? 0 : duration))),
      scale: safeScale(p.scale),
      x: num(p.x, 0),
      y: num(p.y, 0),
      ease: typeof p.ease === 'string' ? p.ease : 'linear',
      index,
    }))
    // 稳定排序：t 相同的关键帧保持书写顺序（别让浮点相等毁掉作者意图）
    .sort((a, b) => a.t - b.t || a.index - b.index)
    .map(({ t, scale, x, y, ease }) => ({ t, scale, x, y, ease }));
  return list;
}

/**
 * 按关键帧取 t 时刻的机位。
 *
 * @param {number} t        图层内时间（秒）
 * @param {number} duration 图层时长（秒）
 * @param {object} opts
 *   - points: [{ t, scale, x, y, ease }]，ease 作用于「从这一帧出发的那一段」
 *   - in / out: 没有 points 时的两端（默认恒等），按 opts.ease（默认 linear）插值
 *   - ease: 两端插值用的缓动名
 * @returns {{scale:number,x:number,y:number}} 纯数据，永远可 JSON 往返
 *
 * 边界语义：t ≤ 首帧取首帧；t ≥ 末帧取末帧；越界不抛。
 * 首帧放在 t=0、末帧放在 t=duration 时，cameraAt(0) 与 cameraAt(duration)
 * 精确等于声明值（不是「约等于」）。
 */
export function cameraAt(t, duration, opts = {}) {
  const dur = Math.max(0, num(duration, 0));
  const time = num(t, 0);
  const points = normalizePoints(opts && opts.points, dur);
  const spec = normalizeCameraSpec(opts && (opts.in !== undefined || opts.out !== undefined) ? opts : null);

  if (points.length === 0) {
    const ease = resolveEase(opts && opts.ease);
    const u = dur > 0 ? clamp01(time / dur) : 0;
    const k = ease(u);
    return {
      scale: spec.in.scale + (spec.out.scale - spec.in.scale) * k,
      x: spec.in.x + (spec.out.x - spec.in.x) * k,
      y: spec.in.y + (spec.out.y - spec.in.y) * k,
    };
  }

  if (points.length === 1) return { scale: points[0].scale, x: points[0].x, y: points[0].y };
  if (time <= points[0].t) return { scale: points[0].scale, x: points[0].x, y: points[0].y };
  const last = points[points.length - 1];
  if (time >= last.t) return { scale: last.scale, x: last.x, y: last.y };

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (time > b.t) continue;
    const span = b.t - a.t;
    const u = span > 0 ? clamp01((time - a.t) / span) : 1;
    const k = resolveEase(a.ease)(u);
    return {
      scale: a.scale + (b.scale - a.scale) * k,
      x: a.x + (b.x - a.x) * k,
      y: a.y + (b.y - a.y) * k,
    };
  }
  return { scale: last.scale, x: last.x, y: last.y };
}

/**
 * 数值一阶导（每秒）。采样步长默认 1ms —— 够小到能看清「速度是不是 0」，
 * 又不至于被浮点噪声骗。测试与排错用，渲染路径不要每帧调。
 */
export function cameraVelocityAt(t, duration, opts = {}, dt = 1e-3) {
  const h = Math.max(1e-6, num(dt, 1e-3));
  const a = cameraAt(num(t, 0) - h, duration, opts);
  const b = cameraAt(num(t, 0) + h, duration, opts);
  return { scale: (b.scale - a.scale) / (2 * h), x: (b.x - a.x) / (2 * h), y: (b.y - a.y) / (2 * h) };
}

/**
 * 生成「进入 → 停留 → 返回」三段点集（用户要的「放大到部位几秒再回全局」）。
 *
 * @param {object} opts
 *   - duration  图层时长（秒，必填；缺省 1）
 *   - zoomTo    进入段的放大倍数（默认 1.6；= 1 时退化成纯平移）
 *   - center    {x, y} 停留时的偏移（画幅比例，默认 0/0）
 *   - enter/hold/exit  三段比例，默认 25% / 40% / 35%；不要求和为 1，会归一到 1
 *   - in / out  两端机位，默认恒等（1/0/0）
 *   - enterEase 进入段缓动，默认 'easeOutCubic'
 *   - exitEase  返回段缓动，默认 'mirror'（严格镜像；想落点更稳可给 'easeInOutQuad'）
 *
 * @returns {{duration:number,points:Array,segments:object,ratio:object}}
 *
 * 为什么 hold 段两端一阶导为 0：进入段 easeOutCubic 在 1 处速度为 0；
 * 返回段用 mirror，在 0 处的速度 = 进入段在 1 处的速度 = 0。
 * 两边都收住，画面才不会在「到位 / 起步」那一下抽一下。
 */
export function cameraKeyframes(opts = {}) {
  const duration = Math.max(1e-6, num(opts.duration, 1));
  const zoomTo = Math.max(0.01, num(opts.zoomTo, 1.6));
  const centered = opts.center && typeof opts.center === 'object' ? opts.center : {};
  const cx = num(centered.x, 0);
  const cy = num(centered.y, 0);
  const inCam = normalizeCamera(opts.in);
  const outCam = normalizeCamera(opts.out);

  let enter = Math.max(0, num(opts.enter, DEFAULT_CAMERA_RATIO.enter));
  let hold = Math.max(0, num(opts.hold, DEFAULT_CAMERA_RATIO.hold));
  let exit = Math.max(0, num(opts.exit, DEFAULT_CAMERA_RATIO.exit));
  const sum = enter + hold + exit;
  if (sum <= 0) {
    enter = DEFAULT_CAMERA_RATIO.enter;
    hold = DEFAULT_CAMERA_RATIO.hold;
    exit = DEFAULT_CAMERA_RATIO.exit;
  } else {
    enter /= sum;
    hold /= sum;
    exit /= sum;
  }

  const enterEase = typeof opts.enterEase === 'string' ? opts.enterEase : 'easeOutCubic';
  const exitEase = typeof opts.exitEase === 'string' ? opts.exitEase : 'mirror';
  const t1 = duration * enter;
  const t2 = t1 + duration * hold;

  const points = [
    { t: 0, scale: inCam.scale, x: inCam.x, y: inCam.y, ease: enterEase },
    { t: t1, scale: zoomTo, x: cx, y: cy, ease: 'linear' },
    { t: t2, scale: zoomTo, x: cx, y: cy, ease: exitEase },
    { t: duration, scale: outCam.scale, x: outCam.x, y: outCam.y, ease: 'linear' },
  ];

  return {
    duration,
    points,
    ratio: { enter, hold, exit },
    segments: {
      enter: { start: 0, end: t1, ease: enterEase },
      hold: { start: t1, end: t2, ease: 'linear' },
      exit: { start: t2, end: duration, ease: exitEase },
    },
  };
}

// ------------------------------------------------------------- 连续性 ----

/** 四舍五入到 1e-6，只用于文案与返回值（判定仍按原始值）。 */
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const fmt = (v) => (Math.abs(v) < 1e-9 ? '0' : String(round6(v)));

/** 取一个「边界机位」：优先 side 字段（out / in），否则当成裸机位。 */
function boundaryCamera(value, side) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, side)) {
    const spec = normalizeCameraSpec(value);
    return spec[side];
  }
  return normalizeCamera(value);
}

/**
 * 判断「上一镜的出口」是否接得上「下一镜的入口」。
 *
 * @param prev  { out: {scale,x,y} } 或裸机位
 * @param next  { in: {scale,x,y} } 或裸机位
 * @param eps   容差（默认 1e-3）
 * @returns {{ok:boolean, delta:{scale,x,y}, message:string}}
 *
 * delta = 上一镜出镜 − 下一镜入镜（正数 = 下一镜比上一镜「收」了，画面会突然变小）。
 * 不抛：任何看不懂的输入都当恒等处理。message 是给人看的，delta 是给测试看的。
 */
export function cameraContinuity(prev, next, eps = CAMERA_EPS) {
  const a = boundaryCamera(prev, 'out');
  const b = boundaryCamera(next, 'in');
  const tol = Math.max(0, num(eps, CAMERA_EPS));
  const delta = { scale: a.scale - b.scale, x: a.x - b.x, y: a.y - b.y };
  const ok = Math.abs(delta.scale) <= tol && Math.abs(delta.x) <= tol && Math.abs(delta.y) <= tol;
  const message = ok
    ? `机位连续：上一镜出镜 scale=${fmt(a.scale)}，下一镜入镜 scale=${fmt(b.scale)}（容差 ${tol}）`
    : `镜头不连续：上一镜出镜 scale=${fmt(a.scale)} / 下一镜入镜 scale=${fmt(b.scale)}，` +
      `差 ${fmt(delta.scale)}（容差 ${tol}）；位置差 x=${fmt(delta.x)} y=${fmt(delta.y)}。` +
      `下一镜开头会跳一下 —— 让上一镜片尾回到 out，或让下一镜的 in 等于上一镜的 out。`;
  return { ok, delta, message };
}

/**
 * 扫描一条（或几条）时间线上的相邻片段，逐对比较出口 / 入口。
 *
 * @param {Array} clips  片段数组（同一轨道请自己先分好；函数内部按 start 排序）
 * @param {object} opts
 *   - resolve(clip, side) -> { scale, x, y }   取某一段的边界机位（side: 'in' | 'out'）
 *   - eps      容差，默认 1e-3
 *   - joinEps  认为「两个片段贴在一起」的时间容差，默认 1e-3（有黑场的间隙不算一次切）
 *   - trackId  只扫这一条轨道（可选）
 *
 * @returns {{pairs:Array, broken:number, total:number, warnings:string[]}}
 *
 * pairs 里每项：{ prevClipId, nextClipId, trackId, boundary, prevOut, nextIn, delta, ok, message }
 * 只比较「首尾相接」的片段：中间隔着空档时，边界本来就要黑场，机位差不算 bug。
 */
export function scanCameraContinuity(clips, opts = {}) {
  const eps = num(opts.eps, CAMERA_EPS);
  const joinEps = Math.max(0, num(opts.joinEps, 1e-3));
  const resolve =
    typeof opts.resolve === 'function'
      ? opts.resolve
      : (clip, side) => {
          const spec = normalizeCameraSpec(clip && (clip.camera || (clip.props && clip.props.camera)));
          return spec[side];
        };

  const list = (Array.isArray(clips) ? clips : [])
    .filter((c) => c && typeof c === 'object' && Number.isFinite(Number(c.start)))
    .filter((c) => (opts.trackId ? c.trackId === opts.trackId : true))
    .slice()
    .sort((a, b) => num(a.start, 0) - num(b.start, 0) || String(a.id).localeCompare(String(b.id)));

  const pairs = [];
  const warnings = [];
  let broken = 0;

  for (let i = 0; i < list.length - 1; i += 1) {
    const prev = list[i];
    const next = list[i + 1];
    if (prev.trackId !== next.trackId) continue;
    const prevEnd = num(prev.start, 0) + num(prev.duration, 0);
    const gap = num(next.start, 0) - prevEnd;
    if (Math.abs(gap) > joinEps) continue; // 有空档 / 有重叠：不是一次硬切

    const prevOut = normalizeCamera(resolve(prev, 'out'));
    const nextIn = normalizeCamera(resolve(next, 'in'));
    const verdict = cameraContinuity({ out: prevOut }, { in: nextIn }, eps);
    if (!verdict.ok) broken += 1;
    pairs.push({
      prevClipId: prev.id,
      nextClipId: next.id,
      trackId: prev.trackId,
      boundary: round6(prevEnd),
      prevOut: { scale: round6(prevOut.scale), x: round6(prevOut.x), y: round6(prevOut.y) },
      nextIn: { scale: round6(nextIn.scale), x: round6(nextIn.x), y: round6(nextIn.y) },
      delta: { scale: round6(verdict.delta.scale), x: round6(verdict.delta.x), y: round6(verdict.delta.y) },
      ok: verdict.ok,
      message: verdict.message,
    });
    if (!verdict.ok) {
      warnings.push(
        `边界 ${round6(prevEnd)}s：${prev.id} → ${next.id} 机位不连续（Δscale=${round6(
          verdict.delta.scale,
        )}）。播放不阻塞，但这一帧会跳。`,
      );
    }
  }

  return { pairs, broken, total: pairs.length, warnings };
}
