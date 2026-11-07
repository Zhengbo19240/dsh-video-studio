/**
 * sc-segmented-thumb-hero · 分段控件 thumb 特写（人工重写版）
 *
 * 配方来源：video-shotcraft / references/shots/interaction/segmented-thumb-hero.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡为 Remotion/DOM 的 segmented control；这里用 Canvas2D 几何重写，
 *           thumb 位移是主角，所以它比控件本身还大一圈、下面还有一条位移标尺。
 *
 * 配方要点（照卡文）：
 *   - 超大胶囊 segmented control 弹簧浮入；
 *   - 描边箭头光标画外滑入按下；
 *   - 白 thumb 8 帧 ease-out 滑到另一段；
 *   - 到位瞬间新图标 spring 弹出、旧图标收起。
 *
 * 契约：render(ctx2d, t, env)；纯函数，任意 seek 一致。
 */

export const meta = {
  title: '分段控件 thumb 特写',
  duration: 3.5,
  kind: '几何',
  source: 'shotcraft',
  sourcePath: 'references/shots/interaction/segmented-thumb-hero.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
};

const DW = 480;
const DH = 270;

const DEFAULTS = {
  segments: 4,
  from: 0,
  to: 2,
  popAt: 0.62,
  slideAt: 1.05,
  slideDur: 0.27,
  background: '#101318',
  track: '#232c38',
  thumb: '#f4f6fa',
  ink: '#8c96a6',
  accent: '#3b82f6',
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const num = (v, def, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
};
const outCubic = (x) => 1 - Math.pow(1 - x, 3);
const backOut = (s) => (x) => {
  const u = clamp01(x) - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
};

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

/** 四个图标：圆点 / 三横 / 三角 / 方块，全部用几何画。 */
function paintIcon(ctx, kind, cx, cy, size, color, alpha) {
  if (alpha <= 0.001) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.2, size * 0.11);
  ctx.lineCap = 'round';
  if (kind === 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.3, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 1) {
    for (let i = 0; i < 3; i += 1) {
      ctx.beginPath();
      ctx.moveTo(cx - size * 0.36, cy - size * 0.24 + i * size * 0.24);
      ctx.lineTo(cx + size * 0.36, cy - size * 0.24 + i * size * 0.24);
      ctx.stroke();
    }
  } else if (kind === 2) {
    ctx.beginPath();
    ctx.moveTo(cx - size * 0.3, cy + size * 0.26);
    ctx.lineTo(cx, cy - size * 0.3);
    ctx.lineTo(cx + size * 0.3, cy + size * 0.26);
    ctx.closePath();
    ctx.stroke();
  } else {
    ctx.lineWidth = Math.max(1.2, size * 0.12);
    roundRect(ctx, cx - size * 0.28, cy - size * 0.28, size * 0.56, size * 0.56, size * 0.12);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCursor(ctx, x, y, alpha, press) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.scale(1 - press * 0.14, 1 - press * 0.14);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 19);
  ctx.lineTo(4.8, 14.4);
  ctx.lineTo(8.2, 21.6);
  ctx.lineTo(11.6, 19.8);
  ctx.lineTo(8.2, 12.6);
  ctx.lineTo(14.4, 12.6);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#0b0e13';
  ctx.lineWidth = 1.3;
  ctx.stroke();
  ctx.restore();
}

export function render(ctx, t, env) {
  const w = Math.max(1, Math.round(Number(env && env.width) || DW));
  const h = Math.max(1, Math.round(Number(env && env.height) || DH));
  const props = (env && env.props) || {};
  const cfg = {
    segments: Math.round(num(props.segments, DEFAULTS.segments, 2, 6)),
    from: Math.round(num(props.from, DEFAULTS.from, 0, 5)),
    to: Math.round(num(props.to, DEFAULTS.to, 0, 5)),
    popAt: num(props.popAt, DEFAULTS.popAt, 0.1, 3),
    slideAt: num(props.slideAt, DEFAULTS.slideAt, 0.2, 3),
    slideDur: num(props.slideDur, DEFAULTS.slideDur, 0.08, 1),
    background: props.background || DEFAULTS.background,
    track: props.track || DEFAULTS.track,
    thumb: props.thumb || DEFAULTS.thumb,
    ink: props.ink || DEFAULTS.ink,
    accent: props.accent || DEFAULTS.accent,
  };
  const segs = cfg.segments;
  const from = Math.min(segs - 1, Math.max(0, cfg.from));
  const to = Math.min(segs - 1, Math.max(0, cfg.to));

  const duration = num(env && env.duration, meta.duration, 0.8, 120);
  const tt = Math.min(duration, Math.max(0, Number.isFinite(Number(t)) ? Number(t) : 0));

  const s = Math.min(w / DW, h / DH);
  const ox = (w - DW * s) / 2;
  const oy = (h - DH * s) / 2;

  ctx.save();
  ctx.fillStyle = cfg.background;
  ctx.fillRect(0, 0, w, h);

  ctx.translate(ox, oy);
  ctx.scale(s, s);

  // 控件几何
  const padX = 34;
  const trackW = DW - padX * 2;
  const trackH = 66;
  const trackX = padX;
  const trackY = 96;
  const inset = 6;
  const segW = (trackW - inset * 2) / segs;

  // ① 胶囊弹簧浮入
  const popP = clamp01(tt / cfg.popAt);
  const pop = backOut(1.9)(popP);
  ctx.save();
  ctx.globalAlpha = 0.72 + 0.28 * clamp01(popP * 1.7);
  ctx.translate(DW / 2, DH / 2);
  ctx.scale(0.82 + 0.18 * pop, 0.82 + 0.18 * pop);
  ctx.translate(-DW / 2, -DH / 2 - (1 - pop) * 16);

  // 控件阴影（暗色偏移，不是 blur）
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  roundRect(ctx, trackX + 2, trackY + 8, trackW, trackH, trackH / 2);
  ctx.fill();

  // 轨道
  ctx.fillStyle = cfg.track;
  roundRect(ctx, trackX, trackY, trackW, trackH, trackH / 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  roundRect(ctx, trackX, trackY, trackW, trackH, trackH / 2);
  ctx.stroke();

  // ② thumb：从 from 滑到 to（8 帧 ease-out），比轨道内高一点，突出它是主角
  const slideP = clamp01((tt - cfg.slideAt) / cfg.slideDur);
  const slideEase = outCubic(slideP);
  const thumbX = trackX + inset + (from + (to - from) * slideEase) * segW;
  const thumbW = segW - 4;
  const thumbH = trackH - inset * 2 + 3;
  const thumbY = trackY + (trackH - thumbH) / 2;
  if (popP > 0.2) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    roundRect(ctx, thumbX + 1.5, thumbY + 4, thumbW, thumbH, thumbH / 2);
    ctx.fill();
    ctx.fillStyle = cfg.thumb;
    roundRect(ctx, thumbX, thumbY, thumbW, thumbH, thumbH / 2);
    ctx.fill();
  }

  // ③ 图标：旧图标收起、新图标 spring 弹出
  const iconSize = 20;
  for (let i = 0; i < segs; i += 1) {
    const cx = trackX + inset + i * segW + segW / 2;
    const cy = trackY + trackH / 2;
    const isFrom = i === from;
    const isTo = i === to;
    let alpha = 0.55;
    let scale = 1;
    if (isFrom && from !== to) {
      // 旧图标收起（在 thumb 到达前就开始）
      const out = clamp01((tt - cfg.slideAt) / (cfg.slideDur * 0.7));
      alpha = 0.55 * (1 - out);
      scale = 1 - 0.3 * out;
    }
    if (isTo) {
      const arrive = cfg.slideAt + cfg.slideDur;
      const sp = clamp01((tt - arrive) / 0.34);
      if (sp > 0) {
        scale = backOut(2.6)(sp);
        alpha = clamp01(sp * 1.8);
      } else if (from !== to) {
        alpha = 0;
      }
    }
    const color = i === to ? cfg.accent : cfg.ink;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(Math.max(0.01, scale), Math.max(0.01, scale));
    ctx.translate(-cx, -cy);
    paintIcon(ctx, i % 4, cx, cy, iconSize, color, alpha);
    ctx.restore();
  }

  // ④ 位移标尺（thumb 是主角：把它的行程画成一条刻度）
  const rulerY = trackY + trackH + 26;
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(trackX + inset, rulerY);
  ctx.lineTo(trackX + trackW - inset, rulerY);
  ctx.stroke();
  for (let i = 0; i < segs; i += 1) {
    const cx = trackX + inset + i * segW + segW / 2;
    ctx.beginPath();
    ctx.moveTo(cx, rulerY - 4);
    ctx.lineTo(cx, rulerY + 4);
    ctx.stroke();
    ctx.fillStyle = i === to ? cfg.accent : 'rgba(255,255,255,0.24)';
    ctx.beginPath();
    ctx.arc(cx, rulerY, i === to ? 2.4 : 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  // 走过的行程用 accent 填
  if (from !== to) {
    const sx = trackX + inset + from * segW + segW / 2;
    const ex = trackX + inset + to * segW + segW / 2;
    ctx.strokeStyle = cfg.accent;
    ctx.lineWidth = 2;
    ctx.globalAlpha = clamp01(slideP * 1.5);
    ctx.beginPath();
    ctx.moveTo(sx, rulerY + 10);
    ctx.lineTo(sx + (ex - sx) * slideEase, rulerY + 10);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ⑤ 读数：段号 + 行程（"thumb 当主角"的旁注）
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  ctx.font = '9px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const dist = Math.abs(to - from);
  ctx.fillText(`THUMB  ${String(from + 1).padStart(2, '0')} → ${String(to + 1).padStart(2, '0')}`, trackX, rulerY + 22);
  ctx.fillStyle = cfg.accent;
  ctx.fillText(`Δ ${dist} SEG · 8f ease-out`, trackX, rulerY + 34);

  ctx.restore(); // 控件弹簧变换

  // ⑥ 光标：从画外滑入 → 按下 → 离开
  const cursorIn = clamp01((tt - (cfg.slideAt - 0.42)) / 0.36);
  const cursorOut = clamp01((tt - (cfg.slideAt + cfg.slideDur + 0.45)) / 0.4);
  const cursorAlpha = cursorIn * (1 - cursorOut);
  if (cursorAlpha > 0.01) {
    const targetX = trackX + inset + to * segW + segW / 2 + 16;
    const targetY = trackY + trackH / 2 + 12;
    const slideIn = (1 - outCubic(cursorIn)) * 90;
    const press = 1 - clamp01(Math.abs(tt - (cfg.slideAt - 0.04)) / 0.09);
    drawCursor(ctx, targetX + slideIn, targetY - slideIn * 0.3, cursorAlpha, Math.max(0, press));
    if (press > 0.05) {
      ctx.strokeStyle = `rgba(59,130,246,${press * 0.7})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(targetX + 5, targetY + 8, 6 + press * 16, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.restore();
}
