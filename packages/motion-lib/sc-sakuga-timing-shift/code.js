/**
 * sc-sakuga-timing-shift · 一拍三转一拍一（人工重写版）
 *
 * 配方来源：video-shotcraft / references/shots/rhythm/sakuga-timing-shift.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡为 Remotion 的帧量化（每 3 帧一步）；这里用 Canvas2D 把 t 先按帧栅格化，
 *           再采样位置 —— 帧率突变是数学上的采样变化，不是换一套动画。
 *
 * 配方要点（照卡文）：
 *   - 先以"每 3 帧一步"的手翻书顿挫移动；
 *   - 高潮瞬间切成逐帧丝滑冲刺；
 *   - 帧率量化的突变本身就是看点 —— 所以底部要有帧格，让人看见"跳"变"滑"。
 *
 * 契约：render(ctx2d, t, env)；纯函数，任意 seek 一致。
 */

export const meta = {
  title: '一拍三转一拍一',
  duration: 5,
  kind: '几何',
  source: 'shotcraft',
  sourcePath: 'references/shots/rhythm/sakuga-timing-shift.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
};

const DW = 480;
const DH = 270;

const DEFAULTS = {
  fps: 24,
  step: 3,
  switchAt: 2.5,
  sprintDur: 1.15,
  background: '#0a0c11',
  trail: '#5ad1ff',
  accent: '#ffcf5a',
  ink: '#e8eef8',
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const num = (v, def, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
};
const outCubic = (x) => 1 - Math.pow(1 - x, 3);
const inOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/** 主角的运动轨迹：一条横穿画面的弧线。 */
function pathAt(p) {
  const x = 42 + p * (DW - 84);
  const y = DH * 0.5 - Math.sin(p * Math.PI) * 66 - 10;
  return { x, y };
}

export function render(ctx, t, env) {
  const w = Math.max(1, Math.round(Number(env && env.width) || DW));
  const h = Math.max(1, Math.round(Number(env && env.height) || DH));
  const props = (env && env.props) || {};
  const cfg = {
    fps: Math.round(num(props.fps, DEFAULTS.fps, 8, 60)),
    step: Math.round(num(props.step, DEFAULTS.step, 1, 8)),
    switchAt: num(props.switchAt, DEFAULTS.switchAt, 0.2, 5),
    sprintDur: num(props.sprintDur, DEFAULTS.sprintDur, 0.2, 3),
    background: props.background || DEFAULTS.background,
    trail: props.trail || DEFAULTS.trail,
    accent: props.accent || DEFAULTS.accent,
  };

  const duration = num(env && env.duration, meta.duration, 0.8, 120);
  const tt = Math.min(duration, Math.max(0, Number.isFinite(Number(t)) ? Number(t) : 0));

  const s = Math.min(w / DW, h / DH);
  const ox = (w - DW * s) / 2;
  const oy = (h - DH * s) / 2;

  // 运动区间：前段"一拍三"，switchAt 之后切"一拍一"
  const moveStart = 0.35;
  const moveEnd = Math.max(cfg.switchAt + 0.1, duration - 1.15);
  const inSprint = tt >= cfg.switchAt;

  // 帧栅格化：一拍三 = 每 3 帧才更新一次位置
  const frame = Math.floor(tt * cfg.fps + 1e-6);
  const quantFrame = Math.floor(frame / cfg.step) * cfg.step;
  const sampledT = inSprint ? tt : quantFrame / cfg.fps;

  const rawP = clamp01((sampledT - moveStart) / Math.max(0.2, moveEnd - moveStart));
  // 高潮段：速度上冲（用 outCubic 让末段冲刺更明显）
  const p = inSprint ? outCubic(rawP) : inOutCubic(rawP);

  ctx.save();
  ctx.fillStyle = cfg.background;
  ctx.fillRect(0, 0, w, h);

  ctx.translate(ox, oy);
  ctx.scale(s, s);

  // 背板：一条参考弧（虚线），让人看见"路径是连续的，动的是采样"
  ctx.strokeStyle = 'rgba(90,209,255,0.24)';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([3, 5]);
  ctx.beginPath();
  for (let i = 0; i <= 60; i += 1) {
    const pt = pathAt(i / 60);
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // 起终点锚（首帧也要有构图，不能只有一个小方块）
  const startPt = pathAt(0);
  const endPt = pathAt(1);
  for (const [pt, r] of [[startPt, 20], [endPt, 12]]) {
    ctx.strokeStyle = 'rgba(90,209,255,0.35)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(90,209,255,0.16)';
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }
  // 地面线
  ctx.strokeStyle = 'rgba(232,238,248,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, DH - 48);
  ctx.lineTo(DW - 40, DH - 48);
  ctx.stroke();

  // 残影：非冲刺段只留 2 个很淡的前一姿势；冲刺段留一串
  const ghostCount = inSprint ? 7 : 2;
  for (let g = ghostCount; g >= 1; g -= 1) {
    const behindFrame = frame - g * (inSprint ? 1 : cfg.step);
    const behindT = inSprint ? tt - g / cfg.fps : behindFrame / cfg.fps;
    const bp = inSprint
      ? outCubic(clamp01((behindT - moveStart) / Math.max(0.2, moveEnd - moveStart)))
      : inOutCubic(clamp01((behindT - moveStart) / Math.max(0.2, moveEnd - moveStart)));
    const bpClamped = clamp01(bp);
    const pt = pathAt(bpClamped);
    ctx.globalAlpha = (0.1 + 0.1 * (inSprint ? 1 : 0.4)) * (1 - g / (ghostCount + 2));
    ctx.fillStyle = cfg.trail;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 主角：一个方块（刻意"不圆滑"，好让顿挫暴露出来）
  const cur = pathAt(p);
  const speed = inSprint ? outCubic(rawP) : 0.25;
  ctx.save();
  ctx.translate(cur.x, cur.y);
  ctx.rotate(p * 2.6);
  const size = 15;
  ctx.fillStyle = inSprint ? cfg.accent : cfg.ink;
  ctx.fillRect(-size / 2, -size / 2, size, size);
  ctx.strokeStyle = 'rgba(10,12,17,0.6)';
  ctx.lineWidth = 1.4;
  ctx.strokeRect(-size / 2, -size / 2, size, size);
  ctx.restore();

  // 速度尾迹（冲刺段拉长）
  if (inSprint && p > 0.05) {
    const back = pathAt(Math.max(0, p - 0.06));
    ctx.strokeStyle = cfg.accent;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(back.x, back.y);
    ctx.lineTo(cur.x, cur.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // 换挡瞬间：一圈扩散环 + 一次极短白闪（"高潮"的打击点）
  const shiftP = clamp01((tt - cfg.switchAt) / 0.4);
  if (tt >= cfg.switchAt && shiftP < 1) {
    ctx.strokeStyle = `rgba(255,207,90,${(1 - shiftP) * 0.8})`;
    ctx.lineWidth = 2 * (1 - shiftP) + 0.5;
    ctx.beginPath();
    ctx.arc(cur.x, cur.y, 12 + shiftP * 58, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = `rgba(255,255,255,${(1 - shiftP) * 0.35})`;
    ctx.fillRect(0, 0, DW, DH);
  }

  // 底部帧格：每格 = 一帧；一拍三时每 3 格才亮一格，切换后逐格亮
  const cellCount = Math.min(48, Math.max(12, info_cells(cfg, moveStart, moveEnd)));
  const cellW = (DW - 80) / cellCount;
  const cellY = DH - 30;
  for (let i = 0; i < cellCount; i += 1) {
    const cellP = (i + 0.5) / cellCount;
    const cellT = moveStart + cellP * (moveEnd - moveStart);
    const cellFrame = Math.round(cellT * cfg.fps);
    const active = inSprint
      ? cellT <= sampledT
      : Math.floor(cellFrame / cfg.step) * cfg.step <= quantFrame;
    const isCurrent = inSprint
      ? Math.abs(cellFrame - frame) < 0.5
      : Math.floor(cellFrame / cfg.step) === Math.floor(frame / cfg.step);
    ctx.fillStyle = isCurrent ? cfg.accent : active ? 'rgba(232,238,248,0.3)' : 'rgba(232,238,248,0.1)';
    ctx.fillRect(40 + i * cellW + 0.6, cellY, Math.max(1, cellW - 1.4), isCurrent ? 7 : 4);
  }

  // 顶部标识：当前的"拍"
  ctx.fillStyle = inSprint ? cfg.accent : 'rgba(232,238,248,0.6)';
  ctx.font = '9px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(inSprint ? `ON 1s · ${cfg.fps}fps` : `ON 3s · every ${cfg.step} frames`, 40, 18);
  ctx.fillStyle = 'rgba(232,238,248,0.28)';
  ctx.fillText(`F ${String(frame).padStart(4, '0')}`, 40, 31);

  ctx.restore();
}

/** 帧格数量：按运动区间长度算，夹在合理范围。 */
function info_cells(cfg, start, end) {
  const span = Math.max(0.2, end - start);
  return Math.round(span * cfg.fps);
}
