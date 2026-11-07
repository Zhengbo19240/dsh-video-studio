/**
 * sc-circle-match-iris · 圆心匹配光圈切（宿主上下文版）
 *
 * 配方来源：video-shotcraft / references/shots/transition/circle-match-iris.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡是 CSS clip-path 的圆形裁切 + 两屏同心匹配；这里用 Canvas2D 重写，
 *           并且**真的读切点两侧的画面**：
 *             env.transition.cutAt / env.transition.prev.frame() / env.transition.next.frame()
 *           圆心的语义靠「前后两镜是同一套全画幅坐标」保证：卡片不缩放、不位移任一侧，
 *           所以 (cx, cy) 在旧画面里对应的是哪个位置，在新画面里就还是那个位置。
 *           原卡需要人工找到旧画面里圆形元素的圆心；本卡把这件事收敛成一个 props：
 *           cx / cy（0..1）。卡不做逐像素圆检测（那是全帧读像素，性能红线）。
 *
 * 合成帧（docs/transition-host.md）：
 *   transitionNeeds 声明了 composed:'both'，宿主交来的 frame() 是**整帧合成后的画面**——
 *   邻镜自己的位移 / 滤镜 / 蒙版、以及它上面的文字与画中画叠层都在里面。
 *   合成失败时 frame() 返回 null（composed:false），本卡退回 rawFrame()（素材原始帧），
 *   并在 props.debug 的角标里写清走的是哪条路。
 *
 * 降级（没有邻帧时）：
 *   prev + next 都没有 → 深色渐变底 + 扩散光圈（仍是可用的装饰过渡）
 *   只有 prev          → 旧画面常驻，光圈只做「压暗 + 脉冲」，不假装揭示新画面
 *   只有 next          → 新画面常驻，光圈做一次扫光，不假装有旧画面
 *
 * 契约：render(ctx2d, t, env)；纯函数，任意 seek 一致。
 */

export const meta = {
  title: '圆心匹配光圈切',
  duration: 2.4,
  kind: '转场',
  source: 'shotcraft',
  sourcePath: 'references/shots/transition/circle-match-iris.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
  needsHostContext: 'transition',
};

// 声明要看切点两侧，并且要**合成帧**（含邻镜 transform / 滤镜 / 上层叠层）。
// 宿主只在声明 composed 后才走合成；老宿主忽略这个字段，frame() 仍是原始素材帧。
export const transitionNeeds = () => ({ prev: true, next: true, composed: 'both' });

const TAU = Math.PI * 2;

const DEFAULTS = {
  cx: 0.5, // 圆心（画面归一化）
  cy: 0.46,
  expand: 0.75, // 切点后光圈扩散到覆盖全屏所需秒数
  ring: 0.006, // 光圈描边宽度（占短边）
  tint: '#ffd9a8', // 光圈颜色
  dim: 0.28, // 旧画面在圆圈外的压暗量（0..1）
  ease: 2.6, // 扩散缓动指数（越大越"炸开"）
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function easeOut(value, power) {
  const x = clamp01(value);
  return 1 - Math.pow(1 - x, power || 2);
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/** cover 铺满整帧；不做任何缩放/位移 cropping 之外的变换，保证两侧坐标一致。 */
function drawCover(ctx, bitmap, W, H) {
  const iw = num(bitmap && bitmap.width, W) || W;
  const ih = num(bitmap && bitmap.height, H) || H;
  const scale = Math.max(W / iw, H / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(bitmap, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function drawBackdrop(ctx, W, H, tint) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#12151c');
  g.addColorStop(0.55, '#1b2130');
  g.addColorStop(1, '#0b0d12');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.45, Math.max(W, H) * 0.7);
  glow.addColorStop(0, 'rgba(255,217,168,0.10)');
  glow.addColorStop(1, 'rgba(255,217,168,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // 极轻的斜纹，避免纯色底看起来像渲染失败
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.strokeStyle = tint;
  ctx.lineWidth = Math.max(1, H * 0.0015);
  for (let i = -1; i < 12; i += 1) {
    ctx.beginPath();
    ctx.moveTo(-W * 0.2 + i * W * 0.12, H);
    ctx.lineTo(W * 0.2 + i * W * 0.12, 0);
    ctx.stroke();
  }
  ctx.restore();
}

/** 圆心匹配的「锚点标记」：一个短促的脉冲环，告诉观众圆心在哪。 */
function drawPulseRing(ctx, cx, cy, radius, alpha, width, tint) {
  if (!(radius > 0) || alpha <= 0.002) return;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.strokeStyle = tint;
  ctx.lineWidth = Math.max(1, width);
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

/** 说明这一侧的画面是哪条路来的（只用于 debug 角标）。 */
function sideSource(side) {
  if (!side) return '无';
  if (side.composed) return '合成帧';
  if (side.composed === false && typeof side.rawFrame === 'function') return '原始素材帧（合成不可用）';
  return '原始素材帧';
}

/**
 * 取这一侧的画面：合成帧优先；合成被声明但失败时（composed:false）退回原始素材帧，
 * 让「有画面但没对齐」与「完全没画面」两件事不混在一起。老宿主没有 rawFrame，行为不变。
 */
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

  const cx = clamp01(num(read('cx'), DEFAULTS.cx)) * W;
  const cy = clamp01(num(read('cy'), DEFAULTS.cy)) * H;
  const expand = Math.max(0.08, num(read('expand'), DEFAULTS.expand));
  const tint = String(read('tint') || DEFAULTS.tint);
  const dim = clamp01(num(read('dim'), DEFAULTS.dim));
  const ringWidth = Math.max(1, num(read('ring'), DEFAULTS.ring) * Math.min(W, H));
  const power = Math.max(1, num(read('ease'), DEFAULTS.ease));

  const tr = env && env.transition;
  const duration = Math.max(0.001, num(env && env.duration, 0) || 2.4);
  const cutAt = tr && Number.isFinite(Number(tr.cutAt)) ? Math.max(0, Math.min(duration, Number(tr.cutAt))) : duration / 2;

  const prev = pickSide(tr && tr.prev);
  const next = pickSide(tr && tr.next);

  // 光圈要覆盖整帧所需半径（从圆心到最远角）
  const maxRadius =
    Math.max(
      Math.hypot(cx, cy),
      Math.hypot(W - cx, cy),
      Math.hypot(cx, H - cy),
      Math.hypot(W - cx, H - cy),
    ) * 1.04;

  const sinceCut = t - cutAt;
  const reveal = sinceCut > 0 ? easeOut(sinceCut / expand, power) : 0;
  const radius = maxRadius * reveal;

  // ---- 底层：旧画面（没有旧画面就用新画面，都没有才画底） ----
  if (prev) {
    drawCover(ctx, prev, W, H);
  } else if (next) {
    drawCover(ctx, next, W, H);
  } else {
    drawBackdrop(ctx, W, H, tint);
  }

  // ---- 切点前：锚点脉冲（最后 0.45s 逐渐出现） ----
  if (prev && next && sinceCut <= 0) {
    const lead = clamp01(1 - -sinceCut / 0.45); // 离切点越近越亮
    const pulse = 0.5 + 0.5 * Math.sin(t * TAU * 1.6);
    drawPulseRing(ctx, cx, cy, Math.min(W, H) * (0.09 + 0.012 * pulse), 0.1 + 0.35 * lead, ringWidth * 0.7, tint);
    drawPulseRing(ctx, cx, cy, Math.min(W, H) * 0.035, 0.08 + 0.22 * lead, ringWidth * 0.5, tint);
  }

  // ---- 切点后：新画面从圆心扩散 ----
  if (next && sinceCut > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, Math.min(maxRadius, radius), 0, TAU);
    ctx.clip();
    drawCover(ctx, next, W, H);
    ctx.restore();

    // 圆圈内侧一圈柔光，让「新画面接在旧画面的圆上」有过渡
    if (radius > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TAU);
      ctx.lineWidth = Math.max(1, Math.min(W, H) * 0.012);
      ctx.strokeStyle = 'rgba(255,232,200,0.22)';
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---- 圈外压暗（只有旧画面、还没有新画面时，靠它讲「光圈要来了」） ----
  if (prev && sinceCut > 0 && dim > 0) {
    const g = ctx.createRadialGradient(cx, cy, Math.max(0, radius * 0.92), cx, cy, Math.max(radius * 1.15, radius + 1));
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,' + (dim * 0.35).toFixed(3) + ')');
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // ---- 只有 next（没有 prev）：新画面常驻，做一次扫光式光圈 ----
  if (!prev && next) {
    const sweep = clamp01(sinceCut > 0 ? sinceCut / Math.max(expand, 0.2) : t / Math.max(duration, 0.2));
    const r = maxRadius * easeOut(sweep, 1.6);
    ctx.save();
    ctx.globalAlpha = 0.45 * (1 - sweep);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.lineWidth = Math.max(1, ringWidth * 1.6);
    ctx.strokeStyle = tint;
    ctx.stroke();
    ctx.restore();
  }

  // ---- 光圈描边（有 next 且还没铺满时最明显） ----
  if (next && sinceCut > 0 && radius < maxRadius * 0.999) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, radius), 0, TAU);
    ctx.lineWidth = ringWidth;
    ctx.strokeStyle = tint;
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.restore();
  }

  // ---- 首尾收边：切点前最后一帧保持旧画面；扩散完成后不再画任何遮罩 ----
  if (!prev && !next) {
    // 完全降级：光圈仍然要从圆心长出来，否则这一层看起来像静态色块
    const r = maxRadius * easeOut(clamp01(t / Math.max(duration, 0.2)), 1.4) * 0.82;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, r), 0, TAU);
    ctx.lineWidth = ringWidth * 1.4;
    ctx.strokeStyle = tint;
    ctx.stroke();
    ctx.restore();
  }

  // 调试角标：props.debug=true 时把宿主给的降级原因画出来（正式画面默认关闭）
  if (props.debug) {
    const tr2 = env.transition || {};
    const reason = (tr2.prev && tr2.prev.message) || (tr2.next && tr2.next.message) || '';
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const label =
      'cutAt=' + cutAt.toFixed(2) + 's · prev=' + sideSource(tr2.prev) + ' · next=' + sideSource(tr2.next) +
      (reason ? ' · ' + reason : '');
    ctx.font = Math.max(9, Math.round(H * 0.035)) + 'px system-ui, "Microsoft YaHei", sans-serif';
    const width = Math.min(W - 16, label.length * Math.max(9, Math.round(H * 0.035)) * 0.62 + 16);
    roundRect(ctx, 8, H - 32, width, 24, 6);
    ctx.fill();
    ctx.fillStyle = '#ffd9a8';
    ctx.fillText(label, 16, H - 15);
    ctx.restore();
  }
}
