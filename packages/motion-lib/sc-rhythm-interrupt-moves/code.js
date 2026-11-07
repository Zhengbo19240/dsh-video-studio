/**
 * sc-rhythm-interrupt-moves · 三级跳切推近（人工重写版）
 *
 * 配方来源：video-shotcraft / references/shots/rhythm/rhythm-interrupt-moves.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡为 Remotion 的 Sequence 硬切；这里用 Canvas2D 的三段离散取景重写。
 *
 * 配方要点（照卡文）：
 *   - jump-cut-punch-in：同构图三次无补间硬跳放大，逐级逼近目标；
 *   - 没有任何插值 —— 那几帧的"没过程"就是节奏本身；
 *   - 每一级都保留同一个构图中心，只是取景更近。
 *
 * 契约：render(ctx2d, t, env)；纯函数，任意 seek 一致。
 */

export const meta = {
  title: '三级跳切推近',
  duration: 4.5,
  kind: '几何',
  source: 'shotcraft',
  sourcePath: 'references/shots/rhythm/rhythm-interrupt-moves.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
};

const DW = 480;
const DH = 270;

const DEFAULTS = {
  cut1: 1.0,
  cut2: 2.2,
  cut3: 3.3,
  zooms: [1, 1.72, 2.86],
  flash: 0.28,
  background: '#0b0d12',
  accent: '#ffb83d',
  ink: '#e9eef7',
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const num = (v, def, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
};

/** 同构图：一个"人物"（几何剪影）+ 背景横线，任何取景下都读得出是同一个画面。 */
function paintSubject(ctx, cfg) {
  ctx.fillStyle = '#12151c';
  ctx.fillRect(0, 0, DW, DH);

  // 背景：横向节奏线（越往上越密）
  for (let i = 0; i < 16; i += 1) {
    const y = 12 + i * i * 0.92;
    if (y > DH) break;
    ctx.fillStyle = `rgba(233,238,247,${0.03 + (i % 3) * 0.012})`;
    ctx.fillRect(0, y, DW, 1);
  }

  // 地面线
  ctx.fillStyle = 'rgba(233,238,247,0.16)';
  ctx.fillRect(0, 214, DW, 1.4);

  // 主体：肩上视角（头 + 躯干 + 一只手抬起）
  const cx = 268;
  const baseY = 214;

  // 躯干
  ctx.fillStyle = '#2a3140';
  ctx.beginPath();
  ctx.moveTo(cx - 46, baseY);
  ctx.lineTo(cx - 30, baseY - 96);
  ctx.quadraticCurveTo(cx, baseY - 116, cx + 30, baseY - 96);
  ctx.lineTo(cx + 46, baseY);
  ctx.closePath();
  ctx.fill();

  // 头
  ctx.fillStyle = '#3a4354';
  ctx.beginPath();
  ctx.arc(cx, baseY - 140, 30, 0, Math.PI * 2);
  ctx.fill();

  // 手（朝右指）
  ctx.strokeStyle = '#3a4354';
  ctx.lineWidth = 13;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx + 26, baseY - 92);
  ctx.lineTo(cx + 86, baseY - 118);
  ctx.lineTo(cx + 118, baseY - 104);
  ctx.stroke();

  // 手指方向的目标：一个小方块（"指的东西"）
  ctx.fillStyle = cfg.accent;
  ctx.fillRect(cx + 128, baseY - 124, 20, 20);
  ctx.fillStyle = 'rgba(255,184,61,0.24)';
  ctx.fillRect(cx + 121, baseY - 131, 34, 34);

  // 暖色边光（一条斜向渐变）
  const g = ctx.createLinearGradient(cx - 60, baseY - 170, cx + 40, baseY);
  g.addColorStop(0, 'rgba(255,184,61,0)');
  g.addColorStop(0.6, 'rgba(255,184,61,0.14)');
  g.addColorStop(1, 'rgba(255,184,61,0)');
  ctx.fillStyle = g;
  ctx.fillRect(cx - 80, baseY - 190, 220, 200);
}

export function render(ctx, t, env) {
  const w = Math.max(1, Math.round(Number(env && env.width) || DW));
  const h = Math.max(1, Math.round(Number(env && env.height) || DH));
  const props = (env && env.props) || {};
  const cfg = {
    cut1: num(props.cut1, DEFAULTS.cut1, 0.1, 6),
    cut2: num(props.cut2, DEFAULTS.cut2, 0.2, 8),
    cut3: num(props.cut3, DEFAULTS.cut3, 0.3, 10),
    zooms: Array.isArray(props.zooms) && props.zooms.length >= 3 ? props.zooms : DEFAULTS.zooms,
    flash: num(props.flash, DEFAULTS.flash, 0, 1),
    background: props.background || DEFAULTS.background,
    accent: props.accent || DEFAULTS.accent,
  };

  const duration = num(env && env.duration, meta.duration, 0.6, 120);
  const tt = Math.min(duration, Math.max(0, Number.isFinite(Number(t)) ? Number(t) : 0));

  // 硬跳：不含任何插值
  const cuts = [cfg.cut1, cfg.cut2, cfg.cut3].sort((a, b) => a - b);
  let level = 0;
  if (tt >= cuts[2]) level = 2;
  else if (tt >= cuts[1]) level = 1;
  else if (tt >= cuts[0]) level = 0;
  const zoom = Math.max(0.4, Math.min(8, Number(cfg.zooms[level]) || 1));

  const s = Math.min(w / DW, h / DH);
  const ox = (w - DW * s) / 2;
  const oy = (h - DH * s) / 2;

  ctx.save();
  ctx.fillStyle = cfg.background;
  ctx.fillRect(0, 0, w, h);

  // 取景中心：随级别微移（越近越偏向右手的指向）——但仍然是离散跳，不是推镜
  const focusX = [DW / 2, DW / 2 + 22, DW / 2 + 56][level];
  const focusY = [DH / 2, DH / 2 - 6, DH / 2 - 34][level];

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.translate(ox + w / 2, oy + h / 2);
  ctx.scale(s * zoom, s * zoom);
  ctx.translate(-focusX, -focusY);
  paintSubject(ctx, cfg);
  ctx.restore();

  // 每次跳切的单帧闪（很短，像快门）
  let flash = 0;
  for (const c of cuts) {
    if (tt >= c - 1e-6) {
      const p = clamp01((tt - c) / 0.09);
      flash = Math.max(flash, cfg.flash * (1 - p));
    }
  }
  if (flash > 0.005) {
    ctx.fillStyle = `rgba(255,255,255,${flash})`;
    ctx.fillRect(0, 0, w, h);
  }

  // 右上角：跳切层级 + 三格进度（这是节奏卡，读数就是内容的一部分）
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
    ctx.fillStyle = i <= level ? cfg.accent : 'rgba(233,238,247,0.18)';
    ctx.fillRect(bx, by, fs * 1.1, Math.max(1, Math.round(fs * 0.12)));
  }

  // 取景框：三级各画一个残影框（说明"同一个构图被切了三次"）
  for (let i = 0; i < 3; i += 1) {
    if (i > level) continue;
    const zz = Math.max(0.4, Number(cfg.zooms[i]) || 1);
    const bw = (w * 0.72) / zz;
    const bh = (h * 0.72) / zz;
    const alpha = i === level ? 0.22 : 0.08;
    ctx.strokeStyle = `rgba(255,184,61,${alpha})`;
    ctx.lineWidth = 1;
    ctx.strokeRect(w / 2 - bw / 2, h / 2 - bh / 2, bw, bh);
  }

  // 左侧刻度：竖直的"推近速率"（每级位移一大格）
  const railX = pad * 0.55;
  const railTop = h * 0.24;
  const railH = h * 0.52;
  ctx.strokeStyle = 'rgba(233,238,247,0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(railX, railTop);
  ctx.lineTo(railX, railTop + railH);
  ctx.stroke();
  const tickY = railTop + railH * (level / 2);
  ctx.fillStyle = cfg.accent;
  ctx.beginPath();
  ctx.arc(railX, tickY, Math.max(2, fs * 0.22), 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}
