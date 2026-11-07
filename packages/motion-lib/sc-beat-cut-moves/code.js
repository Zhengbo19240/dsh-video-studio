/**
 * sc-beat-cut-moves · 硬切当节拍（人工重写版）
 *
 * 配方来源：video-shotcraft / references/shots/rhythm/beat-cut-moves.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡为 Remotion/DOM 逐帧切换裁切；这里重写为 Canvas2D 纯函数，用一次
 *           "相机取景"状态机表达同一件事：三次白闪各自硬切同一画面的一个更近裁切。
 *
 * 配方要点（照卡文）：
 *   - 连闪定格：三次白闪，每次紧跟一个硬切（无补间），取景从全景 → 卡片 → 特写；
 *   - 快门余韵：白闪过后的 0.12s 内画面轻微下沉回稳（0.986 → 1.0），读作"快门回位"；
 *   - 末段停在特写，不再动 —— 这段静止是收束，不是没做完。
 *
 * 契约：render(ctx2d, t, env)，t 单位秒，env = { width, height, props, fps, duration }。
 * 只依赖 Canvas2D；不读时钟、不碰 DOM，任意 seek 结果一致。
 */

export const meta = {
  title: '硬切节拍',
  duration: 4.7,
  kind: '几何',
  source: 'shotcraft',
  sourcePath: 'references/shots/rhythm/beat-cut-moves.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
};

// 设计基准画布：所有几何按 480×270 摆放，再等比 contain 到实际画布。
const DW = 480;
const DH = 270;

const DEFAULTS = {
  lead: 0.25,
  flashPeak: 0.92,
  flashDur: 0.16,
  shutterDip: 0.986,
  hold: 1.1,
  background: '#14161c',
  paper: '#f3efe6',
  accent: '#ff5a3c',
  ink: '#1b1d23',
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, p) => a + (b - a) * p;
const num = (v, def, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
};
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

/** 同一张"画面"的几何构成：网格底 + 主圆 + 色带 + 信息块。三次裁切都拍它。 */
function paintScene(ctx, cfg) {
  ctx.fillStyle = cfg.paper;
  ctx.fillRect(0, 0, DW, DH);

  // 细网格
  ctx.strokeStyle = 'rgba(27,29,35,0.09)';
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let x = 0; x <= DW; x += 24) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, DH);
  }
  for (let y = 0; y <= DH; y += 24) {
    ctx.moveTo(0, y);
    ctx.lineTo(DW, y);
  }
  ctx.stroke();

  // 主圆（三次裁切的锚点）
  const cx = 232;
  const cy = 132;
  const r = 74;
  const grad = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.15, cx, cy, r);
  grad.addColorStop(0, '#ff8b6a');
  grad.addColorStop(1, cfg.accent);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // 圆内高光弧
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 12, Math.PI * 1.08, Math.PI * 1.62);
  ctx.stroke();

  // 横向色带（横向参照）
  ctx.fillStyle = cfg.ink;
  ctx.fillRect(0, cy + r + 16, DW, 14);
  ctx.fillStyle = cfg.accent;
  ctx.fillRect(0, cy + r + 38, DW * 0.62, 8);

  // 右上信息块
  ctx.fillStyle = 'rgba(27,29,35,0.82)';
  roundRect(ctx, 344, 46, 96, 40, 6);
  ctx.fill();
  ctx.fillStyle = cfg.paper;
  ctx.fillRect(354, 58, 62, 4);
  ctx.fillRect(354, 68, 44, 4);

  // 左下角标签
  ctx.fillStyle = 'rgba(27,29,35,0.55)';
  ctx.fillRect(28, 218, 78, 5);
  ctx.fillRect(28, 229, 52, 5);
}

export function render(ctx, t, env) {
  const w = Math.max(1, Math.round(Number(env && env.width) || DW));
  const h = Math.max(1, Math.round(Number(env && env.height) || DH));
  const props = (env && env.props) || {};
  const cfg = {
    lead: num(props.lead, DEFAULTS.lead, 0.05, 2),
    flashPeak: num(props.flashPeak, DEFAULTS.flashPeak, 0, 1),
    flashDur: num(props.flashDur, DEFAULTS.flashDur, 0.04, 0.6),
    shutterDip: num(props.shutterDip, DEFAULTS.shutterDip, 0.9, 1),
    hold: num(props.hold, DEFAULTS.hold, 0, 4),
    background: props.background || DEFAULTS.background,
    paper: props.paper || DEFAULTS.paper,
    accent: props.accent || DEFAULTS.accent,
    ink: props.ink || DEFAULTS.ink,
  };

  // t 越界（负数 / 超时长）一律夹到 [0, duration]，绝不抛。
  const duration = num(env && env.duration, meta.duration, 0.4, 120);
  const tt = Math.min(duration, Math.max(0, Number.isFinite(Number(t)) ? Number(t) : 0));

  // 合并形态（2026-11-06）：subject:'figure' 走原 sc-rhythm-interrupt-moves 的人物剪影
  // 三级跳切。主体图形不同但节奏装置相同（离散取景、无补间、切点闪）。
  if (String(props.subject || 'card') === 'figure') {
    renderFigureCuts(ctx, w, h, props, tt, duration);
    return;
  }

  // 三次硬切的时间点：留给末段 hold，保证末帧停在特写。
  const tail = Math.max(0.3, Math.min(cfg.hold, duration * 0.4));
  const cutLast = duration - tail;
  const cut1 = cfg.lead;
  const cut2 = lerp(cut1, cutLast, 0.52);
  const cut3 = cutLast;

  const SHOTS = [
    { zoom: 1.0, fx: DW / 2, fy: DH / 2 },
    { zoom: 1.62, fx: 262, fy: 126 },
    { zoom: 2.72, fx: 258, fy: 122 },
  ];
  let shot = 0;
  if (tt >= cut3 - 1e-6) shot = 2;
  else if (tt >= cut2 - 1e-6) shot = 1;

  // 快门回位：每刀之后 0.12s 的轻微下沉，硬切本身无补间。
  const lastCut = shot === 0 ? cut1 : shot === 1 ? cut2 : cut3;
  const dipP = clamp01((tt - lastCut) / 0.12);
  const dipScale = lerp(cfg.shutterDip, 1, outCubic(dipP));

  const view = SHOTS[shot];
  const s = Math.min(w / DW, h / DH);
  const ox = (w - DW * s) / 2;
  const oy = (h - DH * s) / 2;

  ctx.save();
  ctx.fillStyle = cfg.background;
  ctx.fillRect(0, 0, w, h);

  // 相机：把焦点搬到画面中心，再按 zoom 放大（等价于 transform-origin 0 0）。
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.rect(0, 0, DW, DH);
  ctx.clip();
  ctx.translate(DW / 2, DH / 2);
  ctx.scale(view.zoom * dipScale, view.zoom * dipScale);
  ctx.translate(-view.fx, -view.fy);
  paintScene(ctx, cfg);
  ctx.restore();

  // 白闪：切点紧跟一次，衰减 flashDur —— 硬切的"响"。
  let flash = 0;
  for (const c of [cut1, cut2, cut3]) {
    if (tt >= c - 1e-6) {
      const p = clamp01((tt - c) / cfg.flashDur);
      flash = Math.max(flash, cfg.flashPeak * (1 - p) * (1 - p));
    }
  }
  if (flash > 0.004) {
    ctx.fillStyle = `rgba(255,255,255,${flash})`;
    ctx.fillRect(0, 0, w, h);
  }

  // 画框 + 刀号：把"这是第三个机位"说清楚。
  const pad = Math.round(Math.min(w, h) * 0.035);
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = Math.max(1, Math.round(s * 1.4));
  ctx.strokeRect(pad, pad, w - pad * 2, h - pad * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.font = `${Math.round(Math.min(w, h) * 0.035)}px system-ui, "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`CUT ${shot + 1}/3`, pad * 1.6, pad * 1.55);

  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* 合并形态：原 sc-rhythm-interrupt-moves（人物剪影三级跳切）           */
/* ------------------------------------------------------------------ */

function renderFigureCuts(ctx, w, h, props, tt, duration) {
  const FDW = 480;
  const FDH = 270;

  const paintFigure = (accent) => {
    ctx.fillStyle = '#12151c';
    ctx.fillRect(0, 0, FDW, FDH);
    for (let i = 0; i < 16; i += 1) {
      const y = 12 + i * i * 0.92;
      if (y > FDH) break;
      ctx.fillStyle = `rgba(233,238,247,${0.03 + (i % 3) * 0.012})`;
      ctx.fillRect(0, y, FDW, 1);
    }
    ctx.fillStyle = 'rgba(233,238,247,0.16)';
    ctx.fillRect(0, 214, FDW, 1.4);
    const cx = 268;
    const baseY = 214;
    ctx.fillStyle = '#2a3140';
    ctx.beginPath();
    ctx.moveTo(cx - 46, baseY);
    ctx.lineTo(cx - 30, baseY - 96);
    ctx.quadraticCurveTo(cx, baseY - 116, cx + 30, baseY - 96);
    ctx.lineTo(cx + 46, baseY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#3a4354';
    ctx.beginPath();
    ctx.arc(cx, baseY - 140, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#3a4354';
    ctx.lineWidth = 13;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + 26, baseY - 92);
    ctx.lineTo(cx + 86, baseY - 118);
    ctx.lineTo(cx + 118, baseY - 104);
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.fillRect(cx + 128, baseY - 124, 20, 20);
    ctx.fillStyle = 'rgba(255,184,61,0.24)';
    ctx.fillRect(cx + 121, baseY - 131, 34, 34);
    const g = ctx.createLinearGradient(cx - 60, baseY - 170, cx + 40, baseY);
    g.addColorStop(0, 'rgba(255,184,61,0)');
    g.addColorStop(0.6, 'rgba(255,184,61,0.14)');
    g.addColorStop(1, 'rgba(255,184,61,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - 80, baseY - 190, 220, 200);
  };

  // 用合并卡自己的节奏参数（cut1/2/3 + zooms），未给时退回原卡默认。
  const rawCuts = [Number(props.cut1) || 1.0, Number(props.cut2) || 2.2, Number(props.cut3) || 3.3].sort((a, b) => a - b);
  const cuts = rawCuts.map((v) => Math.min(Math.max(0.1, v), duration - 0.1));
  const zooms = Array.isArray(props.zooms) && props.zooms.length >= 3 ? props.zooms : [1, 1.72, 2.86];
  const flashPeak = props.flash == null ? 0.28 : Number(props.flash);
  const accent = props.accent || '#ffb83d';

  let level = 0;
  if (tt >= cuts[2]) level = 2;
  else if (tt >= cuts[1]) level = 1;
  else if (tt >= cuts[0]) level = 0;
  const zoom = Math.max(0.4, Math.min(8, Number(zooms[level]) || 1));

  const s = Math.min(w / FDW, h / FDH);
  const ox = (w - FDW * s) / 2;
  const oy = (h - FDH * s) / 2;

  ctx.save();
  ctx.fillStyle = props.background || '#0b0d12';
  ctx.fillRect(0, 0, w, h);

  const focusX = [FDW / 2, FDW / 2 + 22, FDW / 2 + 56][level];
  const focusY = [FDH / 2, FDH / 2 - 6, FDH / 2 - 34][level];

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.translate(ox + w / 2, oy + h / 2);
  ctx.scale(s * zoom, s * zoom);
  ctx.translate(-focusX, -focusY);
  paintFigure(accent);
  ctx.restore();

  let flash = 0;
  for (const c of cuts) {
    if (tt >= c - 1e-6) {
      const p = clamp01((tt - c) / 0.09);
      flash = Math.max(flash, (Number.isFinite(flashPeak) ? flashPeak : 0.28) * (1 - p));
    }
  }
  if (flash > 0.005) {
    ctx.fillStyle = `rgba(255,255,255,${flash})`;
    ctx.fillRect(0, 0, w, h);
  }

  const pad = Math.round(Math.min(w, h) * 0.04);
  const fs = Math.round(Math.min(w, h) * 0.032);
  ctx.font = `${fs}px ui-monospace, Consolas, monospace`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(233,238,247,0.72)';
  ctx.fillText(`JUMP ${level + 1}/3  ×${zoom.toFixed(2)}`, w - pad, pad);
  for (let i = 0; i < 3; i += 1) {
    const bx = w - pad - (2 - i) * (fs * 1.5);
    const by = pad + fs * 1.7;
    ctx.fillStyle = i <= level ? accent : 'rgba(233,238,247,0.18)';
    ctx.fillRect(bx, by, fs * 1.1, Math.max(1, Math.round(fs * 0.12)));
  }
  for (let i = 0; i < 3; i += 1) {
    if (i > level) continue;
    const zz = Math.max(0.4, Number(zooms[i]) || 1);
    const bw = (w * 0.72) / zz;
    const bh = (h * 0.72) / zz;
    ctx.strokeStyle = `rgba(255,184,61,${i === level ? 0.22 : 0.08})`;
    ctx.lineWidth = 1;
    ctx.strokeRect(w / 2 - bw / 2, h / 2 - bh / 2, bw, bh);
  }

  ctx.restore();
}
