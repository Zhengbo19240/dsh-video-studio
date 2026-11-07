/**
 * sc-gradient-transition · 渐变类型过渡（人工重写版）
 *
 * 配方来源：video-shotcraft / references/shots/transition/gradient-transition.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡为 CSS 的 linear/radial/conic 渐变互转；这里用 Canvas2D 重写：
 *           - linear / radial 用原生 createLinearGradient / createRadialGradient；
 *           - conic 优先用 createConicGradient（Chromium 99+），不支持时退化成 72 段扇形，
 *             退化路径也只用 fill，不做逐像素。
 *
 * 配方要点（照卡文）：
 *   - linear → radial → conic 三类渐变间平滑过渡；
 *   - 角度、色标、中心、半径逐参数插值；
 *   - 段间交叉淡化换类型（不是硬切）。
 *
 * 这是单图层内的过场：背景本身在换类型，前景只留一条细线与角标保持连续。
 *
 * 契约：render(ctx2d, t, env)；纯函数，任意 seek 一致。
 */

export const meta = {
  title: '渐变类型过渡',
  duration: 6.67,
  kind: '转场',
  source: 'shotcraft',
  sourcePath: 'references/shots/transition/gradient-transition.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
};

const DW = 480;
const DH = 270;

const DEFAULTS = {
  seg1: 0.45,
  seg2: 2.55,
  seg3: 4.7,
  xfade: 0.34,
  colorsA: ['#ff5a3c', '#f0b429', '#2f7bff'],
  colorsB: ['#7b5cff', '#25d8c0', '#0b0d14'],
  colorsC: ['#ff5a3c', '#7b5cff', '#25d8c0', '#ff5a3c'],
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const num = (v, def, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
};
const inOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const outCubic = (x) => 1 - Math.pow(1 - x, 3);

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

function hexToRgb(hex) {
  const h = String(hex || '#000000').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
const mixColor = (a, b, p) => {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  const q = clamp01(p);
  return `rgb(${Math.round(A.r + (B.r - A.r) * q)},${Math.round(A.g + (B.g - A.g) * q)},${Math.round(A.b + (B.b - A.b) * q)})`;
};

/** 线性渐变的绘制：角度用弧度，长度覆盖对角线，保证任何旋转都不露边。 */
function paintLinear(ctx, w, h, angle, colors, shift) {
  const cx = w / 2;
  const cy = h / 2;
  const len = Math.hypot(w, h) / 2;
  const dx = Math.cos(angle) * len;
  const dy = Math.sin(angle) * len;
  const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  const n = colors.length;
  for (let i = 0; i < n; i += 1) {
    const p = clamp01((i / n + shift) % 1);
    g.addColorStop(p, colors[i]);
  }
  // 补一个头尾同色的停止点，避免 0/1 处发白
  g.addColorStop(0, colors[0]);
  g.addColorStop(1, colors[n - 1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function paintRadial(ctx, w, h, cx, cy, radius, colors, shift) {
  const g = ctx.createRadialGradient(cx, cy, Math.max(1, radius * 0.05), cx, cy, Math.max(2, radius));
  const n = colors.length;
  for (let i = 0; i < n; i += 1) {
    const p = clamp01((i / n + shift) % 1);
    g.addColorStop(p, colors[i]);
  }
  g.addColorStop(0, colors[0]);
  g.addColorStop(1, colors[n - 1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** conic：优先原生；退化时用 72 段扇形（纯 fill，无逐像素）。 */
function paintConic(ctx, w, h, angleOffset, colors) {
  const cx = w / 2;
  const cy = h / 2;
  const nColors = colors.length;
  if (typeof ctx.createConicGradient === 'function') {
    const g = ctx.createConicGradient(angleOffset, cx, cy);
    for (let i = 0; i <= 4; i += 1) {
      g.addColorStop(i / 4, colors[i % nColors]);
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  const segs = 72;
  const r = Math.hypot(w, h);
  for (let i = 0; i < segs; i += 1) {
    const a0 = angleOffset + (i / segs) * Math.PI * 2;
    const a1 = angleOffset + ((i + 1) / segs) * Math.PI * 2;
    const t = i / segs;
    const idx = t * nColors;
    const i0 = Math.floor(idx) % nColors;
    const i1 = (i0 + 1) % nColors;
    ctx.fillStyle = mixColor(colors[i0], colors[i1], idx - Math.floor(idx));
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1 + 0.004);
    ctx.closePath();
    ctx.fill();
  }
}

export function render(ctx, t, env) {
  const w = Math.max(1, Math.round(Number(env && env.width) || DW));
  const h = Math.max(1, Math.round(Number(env && env.height) || DH));
  const props = (env && env.props) || {};
  const cfg = {
    seg1: num(props.seg1, DEFAULTS.seg1, 0.1, 3),
    seg2: num(props.seg2, DEFAULTS.seg2, 0.3, 6),
    seg3: num(props.seg3, DEFAULTS.seg3, 0.5, 9),
    xfade: num(props.xfade, DEFAULTS.xfade, 0.05, 1.5),
    colorsA: Array.isArray(props.colorsA) && props.colorsA.length >= 2 ? props.colorsA : DEFAULTS.colorsA,
    colorsB: Array.isArray(props.colorsB) && props.colorsB.length >= 2 ? props.colorsB : DEFAULTS.colorsB,
    colorsC: Array.isArray(props.colorsC) && props.colorsC.length >= 3 ? props.colorsC : DEFAULTS.colorsC,
  };

  const duration = num(env && env.duration, meta.duration, 1, 120);
  const tt = Math.min(duration, Math.max(0, Number.isFinite(Number(t)) ? Number(t) : 0));

  // 三段的时间窗（交叉淡化在边界处重叠）
  const s1 = cfg.seg1;
  const s2 = cfg.seg2;
  const s3 = cfg.seg3;
  const xf = cfg.xfade;

  ctx.save();
  ctx.fillStyle = '#0b0d14';
  ctx.fillRect(0, 0, w, h);

  // ① 线性：角度缓慢旋转 + 色标漂移
  const linP = clamp01((tt - 0.1) / Math.max(0.2, s2 - 0.1));
  const linAngle = -0.6 + linP * 1.9;
  const linOut = 1 - clamp01((tt - s2) / xf);
  if (linOut > 0.001) {
    ctx.save();
    ctx.globalAlpha = linOut;
    paintLinear(ctx, w, h, linAngle, cfg.colorsA, linP * 0.18);
    ctx.restore();
  }

  // ② 径向：中心游走 + 半径呼吸
  const radIn = clamp01((tt - (s2 - xf * 0.3)) / xf);
  const radOut = 1 - clamp01((tt - s3) / xf);
  if (radIn > 0.001 && radOut > 0.001) {
    const rp = clamp01((tt - s2) / Math.max(0.2, s3 - s2));
    const cx = w * (0.5 + Math.sin(rp * Math.PI * 1.2) * 0.22);
    const cy = h * (0.5 + Math.cos(rp * Math.PI * 0.9) * 0.2);
    const radius = Math.max(w, h) * (0.62 + 0.16 * Math.sin(rp * Math.PI));
    ctx.save();
    ctx.globalAlpha = radIn * radOut;
    paintRadial(ctx, w, h, cx, cy, radius, cfg.colorsB, rp * 0.22);
    ctx.restore();
  }

  // ③ 圆锥：原地旋转（最后一段，权重到 1）
  const conIn = clamp01((tt - (s3 - xf * 0.3)) / xf);
  if (conIn > 0.001) {
    const cp = clamp01((tt - s3) / Math.max(0.2, duration - s3));
    ctx.save();
    ctx.globalAlpha = conIn;
    paintConic(ctx, w, h, cp * Math.PI * 2.2, cfg.colorsC);
    ctx.restore();

    // conic 段的一层柔化：中心径向的暗角（渐变，不是 blur）
    ctx.save();
    ctx.globalAlpha = conIn * 0.5;
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.18, w / 2, h / 2, Math.max(w, h) * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // ④ 前景细线（连续元素：类型在换，这条线不动）
  const lineP = outCubic(clamp01(tt / 0.6));
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.strokeStyle = 'rgba(255,255,255,0.82)';
  ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.004);
  ctx.beginPath();
  ctx.moveTo(-w * 0.1, h * 0.5);
  ctx.lineTo(-w * 0.1 + (w * 1.2) * lineP, h * 0.5);
  ctx.stroke();
  ctx.restore();

  // ⑤ 角标：当前类型（让"换的是类型"可读）
  const label = tt < s2 ? 'LINEAR' : tt < s3 ? 'RADIAL' : 'CONIC';
  const pad = Math.round(Math.min(w, h) * 0.055);
  const fs = Math.max(9, Math.round(Math.min(w, h) * 0.035));
  ctx.font = `${fs}px ui-monospace, Consolas, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(label, pad, pad);
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.fillText('GRADIENT SHIFT', pad, pad + fs * 1.4);

  // 三格进度
  const stage = tt < s2 - xf * 0.5 ? 0 : tt < s3 - xf * 0.5 ? 1 : 2;
  for (let i = 0; i < 3; i += 1) {
    ctx.fillStyle = i <= stage ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.24)';
    ctx.fillRect(pad + i * fs * 1.2, pad + fs * 2.8, fs * 0.9, Math.max(1, fs * 0.12));
  }

  // 右下角：色标数量（换类型时色标数也变了，这是一个可读的变化）
  const stops = stage === 0 ? cfg.colorsA.length : stage === 1 ? cfg.colorsB.length : cfg.colorsC.length;
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${stops} STOPS`, w - pad, h - pad);

  ctx.restore();
}
