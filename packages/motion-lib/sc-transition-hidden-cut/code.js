/**
 * sc-transition-hidden-cut · 藏切点：扫光带过切点（宿主上下文版）
 *
 * 配方来源：video-shotcraft / references/shots/transition/transition-hidden-cut.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡是「前景遮挡隐形切 / 对撞开屏 / 暖色漏光」三式，靠两个成对镜头。
 *           这里做其中最适合宿主上下文的一式——**暖色漏光扫过切点**：
 *           一条高光带从左扫到右，画面在光带经过的地方从旧镜头换成新镜头，
 *           硬切藏在光带最亮的那 1–2 帧里；同时有一组尘点与一条细光轴按 t 连续运动，
 *           它们跨过切点不变，给眼睛一条「动作连续」的线索。
 *
 * 为什么能藏住切点：
 *   换画面的边界**就是光带本身**，不是整帧同时切换；光带的移动是 t 的连续函数，
 *   所以观众读到的是「光扫过去」，而不是「剪刀」。
 *
 * 依赖宿主上下文（docs/transition-host.md）：
 *   env.transition.cutAt  —— 光带正中央经过画面的时刻
 *   env.transition.prev.frame() / next.frame() —— 两侧的**合成画面**
 *     （transitionNeeds 声明了 composed:'both'：邻镜的位移 / 滤镜 / 蒙版 / 上层叠层都在里面；
 *      合成失败时 frame() 为 null、composed:false，本卡退回 rawFrame() 并在 debug 角标注明）
 *
 * 降级：
 *   两侧都有 → 完整效果
 *   只有一侧 → 光带与尘点照常运动，只是不换画面（看起来像一次漏光）
 *   两侧都没有 → 程序化背景 + 光带 + 尘点，仍是一次可用的过场
 *
 * 契约：render(ctx2d, t, env)；纯函数，任意 seek 一致。
 */

export const meta = {
  title: '藏切点：扫光带',
  duration: 2.2,
  kind: '转场',
  source: 'shotcraft',
  sourcePath: 'references/shots/transition/transition-hidden-cut.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
  needsHostContext: 'transition',
};

export const transitionNeeds = () => ({ prev: true, next: true, composed: 'both' });

const TAU = Math.PI * 2;

const DEFAULTS = {
  angle: -14, // 光带倾角（度，负值=右上到左下）
  band: 0.2, // 光带宽度（占画面对角线比例）
  sweep: 0.85, // 光带从一侧扫到另一侧所需秒数（以 cutAt 为中心）
  tint: '#ffd9a0',
  warm: '#ff9a4d',
  dots: 5,
  debug: false,
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/** 0..1 的循环小数（只依赖 t，保证同一 t 一致）。 */
function fract(value) {
  return value - Math.floor(value);
}

function drawCover(ctx, bitmap, W, H) {
  const iw = num(bitmap && bitmap.width, W) || W;
  const ih = num(bitmap && bitmap.height, H) || H;
  const scale = Math.max(W / iw, H / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(bitmap, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function drawBackdrop(ctx, W, H, warm) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#0d1119');
  g.addColorStop(0.5, '#161c28');
  g.addColorStop(1, '#07090d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W * 0.62, H * 0.4, 0, W * 0.62, H * 0.4, Math.max(W, H) * 0.65);
  glow.addColorStop(0, 'rgba(255,154,77,0.12)');
  glow.addColorStop(1, 'rgba(255,154,77,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.strokeStyle = warm;
  ctx.lineWidth = Math.max(1, H * 0.0015);
  for (let i = 0; i < 9; i += 1) {
    const y = (i + 0.5) * (H / 9);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y - H * 0.05);
    ctx.stroke();
  }
  ctx.restore();
}

/** 说明这一侧的画面是哪条路来的（只用于 debug 角标）。 */
function sideSource(side) {
  if (!side) return '无';
  if (side.composed) return '合成帧';
  if (side.composed === false && typeof side.rawFrame === 'function') return '原始素材帧（合成不可用）';
  return '原始素材帧';
}

/** 合成帧优先；合成被声明但失败时退回原始素材帧，保证「有画面」与「没画面」不混淆。 */
function pickSide(side) {
  if (!side) return null;
  const frame = typeof side.frame === 'function' ? side.frame() : null;
  if (frame) return frame;
  if (side.composed === false && typeof side.rawFrame === 'function') return side.rawFrame();
  return null;
}

export function render(ctx, t, env) {
  const W = Math.max(1, Math.round(num(env && env.width, 960)));
  const H = Math.max(1, Math.round(num(env && env.height, 540)));
  const props = (env && env.props) || {};
  const read = (key) => (props[key] === undefined ? DEFAULTS[key] : props[key]);

  const angle = (num(read('angle'), DEFAULTS.angle) * Math.PI) / 180;
  const bandRatio = clamp(num(read('band'), DEFAULTS.band), 0.03, 0.6);
  const sweep = Math.max(0.12, num(read('sweep'), DEFAULTS.sweep));
  const tint = String(read('tint') || DEFAULTS.tint);
  const warm = String(read('warm') || DEFAULTS.warm);
  const dotCount = Math.round(clamp(num(read('dots'), DEFAULTS.dots), 0, 12));

  const tr = env && env.transition;
  const duration = Math.max(0.001, num(env && env.duration, 0) || 2.2);
  const cutAt = tr && Number.isFinite(Number(tr.cutAt)) ? clamp(Number(tr.cutAt), 0, duration) : duration / 2;
  const prev = pickSide(tr && tr.prev);
  const next = pickSide(tr && tr.next);

  const diagonal = Math.hypot(W, H);
  const bandPx = Math.max(2, (bandRatio * diagonal) / 2);
  const K = diagonal * 0.72 + bandPx;

  // 光带中心在切点附近扫过：q=0 → 完全在左侧屏外，q=1 → 完全在右侧屏外
  const q = (t - (cutAt - sweep / 2)) / sweep;
  const boundary = (clamp(q, -0.15, 1.15) * 2 - 1) * K;

  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const nx = -uy;
  const ny = ux;
  const centerX = W / 2;
  const centerY = H / 2;
  const lineX = centerX + nx * boundary;
  const lineY = centerY + ny * boundary;

  // 边界完全在画面外时就不要画另一侧了（省一次整帧 drawImage，也让语义干净）
  const maxDistance = diagonal / 2;
  const showPrev = boundary < maxDistance;
  const showNext = boundary > -maxDistance;

  // ---- 底层 ----
  if (prev && showPrev) {
    drawCover(ctx, prev, W, H);
  } else if (next && showNext) {
    drawCover(ctx, next, W, H);
  } else {
    drawBackdrop(ctx, W, H, warm);
  }

  // ---- 新画面：只出现在光带的「后侧」（s < boundary），边界就是光带 ----
  if (next && prev && showPrev && showNext) {
    const ax = lineX - ux * diagonal;
    const ay = lineY - uy * diagonal;
    const bx = lineX + ux * diagonal;
    const by = lineY + uy * diagonal;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx - nx * diagonal, by - ny * diagonal);
    ctx.lineTo(ax - nx * diagonal, ay - ny * diagonal);
    ctx.closePath();
    ctx.clip();
    drawCover(ctx, next, W, H);
    ctx.restore();
  }

  // ---- 光带（漏光） ----
  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(angle);
  const gradient = ctx.createLinearGradient(0, boundary - bandPx, 0, boundary + bandPx);
  gradient.addColorStop(0, 'rgba(255,217,160,0)');
  gradient.addColorStop(0.34, 'rgba(255,200,140,0.28)');
  gradient.addColorStop(0.48, 'rgba(255,246,225,0.92)');
  gradient.addColorStop(0.5, 'rgba(255,255,250,0.98)');
  gradient.addColorStop(0.56, 'rgba(255,206,150,0.6)');
  gradient.addColorStop(1, 'rgba(255,154,77,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(-diagonal, boundary - bandPx, diagonal * 2, bandPx * 2);
  ctx.restore();

  // ---- 切点瞬间的闪白：把切换那一两帧彻底糊住 ----
  const flash = Math.exp(-Math.pow((t - cutAt) / 0.13, 2)) * 0.34;
  if (flash > 0.002) {
    ctx.save();
    ctx.globalAlpha = flash;
    ctx.fillStyle = '#fff4e2';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // ---- 连续运动元素一：光带上的尘点（跨切点位置连续，不跟画面换） ----
  if (dotCount > 0) {
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(angle);
    for (let i = 0; i < dotCount; i += 1) {
      const along = fract(t * 0.42 + i / Math.max(1, dotCount)) * 2 - 1; // -1..1
      const x = along * diagonal * 0.75;
      const y = boundary + Math.sin((t + i) * 2.1) * bandPx * 0.35;
      const r = Math.max(1, bandPx * 0.035 * (0.7 + 0.5 * fract(i * 0.37)));
      ctx.globalAlpha = 0.5 * (1 - Math.abs(along));
      ctx.fillStyle = i % 2 === 0 ? tint : warm;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- 连续运动元素二：一条贯穿全屏的细光轴（只依赖 t，跨切点绝对连续） ----
  const axisY = H * (0.18 + 0.64 * fract(t * 0.47 + 0.13));
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = tint;
  ctx.lineWidth = Math.max(1, H * 0.0025);
  ctx.beginPath();
  ctx.moveTo(0, axisY);
  ctx.lineTo(W, axisY);
  ctx.stroke();
  const headX = fract(t * 0.62) * (W + 200) - 100;
  const head = ctx.createLinearGradient(headX - 120, 0, headX + 120, 0);
  head.addColorStop(0, 'rgba(255,217,160,0)');
  head.addColorStop(0.5, 'rgba(255,240,210,0.55)');
  head.addColorStop(1, 'rgba(255,217,160,0)');
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = head;
  ctx.lineWidth = Math.max(1, H * 0.004);
  ctx.beginPath();
  ctx.moveTo(0, axisY);
  ctx.lineTo(W, axisY);
  ctx.stroke();
  ctx.restore();

  // ---- 调试角标 ----
  if (props.debug) {
    const tr2 = env.transition || {};
    const reason = (tr2.prev && tr2.prev.message) || (tr2.next && tr2.next.message) || '';
    const label =
      'cutAt=' + cutAt.toFixed(2) + 's · prev=' + sideSource(tr2.prev) + ' · next=' + sideSource(tr2.next) +
      (reason ? ' · ' + reason : '');
    const size = Math.max(9, Math.round(H * 0.035));
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(8, H - 32, Math.min(W - 16, label.length * size * 0.62 + 16), 24);
    ctx.fillStyle = '#ffd9a8';
    ctx.font = size + 'px system-ui, "Microsoft YaHei", sans-serif';
    ctx.fillText(label, 16, H - 15);
    ctx.restore();
  }
}
