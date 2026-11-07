/**
 * sc-bezier-source-converge-merge · 贝塞尔四源汇聚（人工重写版）
 *
 * 配方来源：video-shotcraft / references/shots/ui-entrance/bezier-source-converge-merge.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡为 Remotion/SVG path 实现；这里用 Canvas2D 的三次贝塞尔 + dash 偏移重写，
 *           路径长度由采样累加得到，因此 draw-on / draw-off 在两个方向上都是精确的。
 *
 * 配方要点（照卡文）：
 *   - 四个来源节点各有一条细贝塞尔曲线连向右侧同一汇聚点；
 *   - 曲线错峰由左向右 draw-on；
 *   - 节点沿自己的曲线滑向汇聚点，三段式加速缩小到消失；
 *   - 强调色数据包全程沿路径滑行；
 *   - 吞并完成后曲线从左端反向擦除，只留品牌标志（白瓷圆片）。
 *
 * 契约：render(ctx2d, t, env)；纯函数，任意 seek 一致。
 */

export const meta = {
  title: '贝塞尔四源汇聚',
  duration: 5.6,
  kind: '几何',
  source: 'shotcraft',
  sourcePath: 'references/shots/ui-entrance/bezier-source-converge-merge.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
};

const DW = 480;
const DH = 270;
const SINK = { x: 404, y: 135 };

const DEFAULTS = {
  sources: 4,
  drawStart: 0.25,
  drawGap: 0.14,
  drawDur: 0.85,
  mergeStart: 1.55,
  mergeGap: 0.16,
  mergeDur: 1.15,
  eraseStart: 3.95,
  wipeDur: 0.75,
  packetSpeed: 0.55,
  background: '#0b0d14',
  ink: '#e9edf6',
  accent: '#5ad1ff',
  nodeColor: '#7f8ea8',
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, p) => a + (b - a) * p;
const num = (v, def, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
};
const inOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
// 三段式加速：前段慢、中段快、末段更快 —— 与卡里"三段式加速缩小"同义。
const accel3 = (x) => {
  const p = clamp01(x);
  if (p < 1 / 3) return (p * p) / 6;
  if (p < 2 / 3) return 1 / 54 + (p - 1 / 3) * ((1 / 3) * (p - 1 / 3) + 1 / 9);
  return 0.5 - Math.pow(1 - p, 3) * 0.5;
};

function cubicAt(p0, c1, c2, p3, u) {
  const v = 1 - u;
  const a = v * v * v;
  const b = 3 * v * v * u;
  const c = 3 * v * u * u;
  const d = u * u * u;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
  };
}

function pathLength(p0, c1, c2, p3, steps) {
  let len = 0;
  let prev = p0;
  for (let i = 1; i <= steps; i += 1) {
    const pt = cubicAt(p0, c1, c2, p3, i / steps);
    len += Math.hypot(pt.x - prev.x, pt.y - prev.y);
    prev = pt;
  }
  return Math.max(1, len);
}

/** 一条来源曲线的几何：控制点让弧线先平后收，越靠下的源弧越弯。 */
function curveFor(index, count) {
  const padTop = 34;
  const usable = DH - padTop * 2;
  const y = count <= 1 ? DH / 2 : padTop + (usable * index) / (count - 1);
  const p0 = { x: 58, y };
  const p3 = { x: SINK.x, y: SINK.y };
  const bow = (index - (count - 1) / 2) / Math.max(1, (count - 1) / 2);
  return {
    p0,
    c1: { x: 186, y: y + bow * 10 },
    c2: { x: 306, y: SINK.y + bow * 26 },
    p3,
    len: 0,
  };
}

function strokeCurve(ctx, cv, reveal, reversed) {
  // reveal ∈ [0,1]：正向时从左端露出；reversed 时从右端（汇聚点）开始消失。
  if (reveal <= 0.001) return;
  ctx.beginPath();
  if (reversed) {
    ctx.moveTo(cv.p3.x, cv.p3.y);
    ctx.bezierCurveTo(cv.c2.x, cv.c2.y, cv.c1.x, cv.c1.y, cv.p0.x, cv.p0.y);
  } else {
    ctx.moveTo(cv.p0.x, cv.p0.y);
    ctx.bezierCurveTo(cv.c1.x, cv.c1.y, cv.c2.x, cv.c2.y, cv.p3.x, cv.p3.y);
  }
  ctx.setLineDash([cv.len, cv.len]);
  ctx.lineDashOffset = cv.len * (1 - clamp01(reveal));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

function drawChip(ctx, x, y, r, alpha, cfg) {
  if (alpha <= 0.001) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  // 白瓷圆片
  const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.45, r * 0.1, x, y, r);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.62, '#eef3fb');
  g.addColorStop(1, '#b9c6dd');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  // 镜刻标记：两个同心弧 + 一条斜刻线
  ctx.strokeStyle = 'rgba(24,34,52,0.78)';
  ctx.lineWidth = Math.max(1, r * 0.11);
  ctx.beginPath();
  ctx.arc(x, y, r * 0.52, Math.PI * 0.86, Math.PI * 1.78);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.3, Math.PI * 0.16, Math.PI * 0.72);
  ctx.stroke();
  ctx.strokeStyle = cfg.accent;
  ctx.lineWidth = Math.max(1, r * 0.1);
  ctx.beginPath();
  ctx.moveTo(x - r * 0.34, y + r * 0.36);
  ctx.lineTo(x + r * 0.4, y - r * 0.3);
  ctx.stroke();
  ctx.restore();
}

export function render(ctx, t, env) {
  const w = Math.max(1, Math.round(Number(env && env.width) || DW));
  const h = Math.max(1, Math.round(Number(env && env.height) || DH));
  const props = (env && env.props) || {};
  const cfg = {
    sources: Math.round(num(props.sources, DEFAULTS.sources, 2, 8)),
    drawStart: num(props.drawStart, DEFAULTS.drawStart, 0, 3),
    drawGap: num(props.drawGap, DEFAULTS.drawGap, 0, 0.5),
    drawDur: num(props.drawDur, DEFAULTS.drawDur, 0.15, 2.5),
    mergeStart: num(props.mergeStart, DEFAULTS.mergeStart, 0, 5),
    mergeGap: num(props.mergeGap, DEFAULTS.mergeGap, 0, 0.5),
    mergeDur: num(props.mergeDur, DEFAULTS.mergeDur, 0.2, 3),
    eraseStart: num(props.eraseStart, DEFAULTS.eraseStart, 0, 8),
    wipeDur: num(props.wipeDur, DEFAULTS.wipeDur, 0.1, 2),
    packetSpeed: num(props.packetSpeed, DEFAULTS.packetSpeed, 0.1, 3),
    background: props.background || DEFAULTS.background,
    ink: props.ink || DEFAULTS.ink,
    accent: props.accent || DEFAULTS.accent,
    nodeColor: props.nodeColor || DEFAULTS.nodeColor,
  };

  const duration = num(env && env.duration, meta.duration, 0.5, 120);
  const tt = Math.min(duration, Math.max(0, Number.isFinite(Number(t)) ? Number(t) : 0));

  const s = Math.min(w / DW, h / DH);
  const ox = (w - DW * s) / 2;
  const oy = (h - DH * s) / 2;

  ctx.save();
  ctx.fillStyle = cfg.background;
  ctx.fillRect(0, 0, w, h);

  ctx.translate(ox, oy);
  ctx.scale(s, s);

  // 背景细网格（低对比，给"这是数据流动"一点空间感）
  ctx.strokeStyle = 'rgba(120,150,190,0.12)';
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let x = 24; x < DW; x += 24) {
    ctx.moveTo(x, 12);
    ctx.lineTo(x, DH - 12);
  }
  for (let y = 24; y < DH; y += 24) {
    ctx.moveTo(12, y);
    ctx.lineTo(DW - 12, y);
  }
  ctx.stroke();

  const curves = [];
  for (let i = 0; i < cfg.sources; i += 1) {
    const cv = curveFor(i, cfg.sources);
    cv.len = pathLength(cv.p0, cv.c1, cv.c2, cv.p3, 48);
    curves.push(cv);
  }

  // 起笔锚点：t=0 也要有东西可看（首帧不能只是一张空网格）
  // 每个来源先立一张小卡（框 + 三行），曲线再从卡右缘长出去。
  for (let i = 0; i < curves.length; i += 1) {
    const cv = curves[i];
    const bx = cv.p0.x - 18;
    const by = cv.p0.y - 11;
    ctx.fillStyle = 'rgba(27,37,56,0.85)';
    ctx.beginPath();
    ctx.moveTo(bx + 3, by);
    ctx.lineTo(bx + 36, by);
    ctx.lineTo(bx + 36, by + 19);
    ctx.lineTo(bx + 3, by + 19);
    ctx.quadraticCurveTo(bx, by + 19, bx, by + 16);
    ctx.lineTo(bx, by + 3);
    ctx.quadraticCurveTo(bx, by, bx + 3, by);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,150,190,0.42)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.fillStyle = 'rgba(159,180,255,0.55)';
    ctx.fillRect(bx + 4, by + 5, 16, 2);
    ctx.fillStyle = 'rgba(120,150,190,0.3)';
    ctx.fillRect(bx + 4, by + 10, 24, 1.6);
    ctx.fillRect(bx + 4, by + 14, 12, 1.6);
    // 卡右缘的接线点
    ctx.fillStyle = 'rgba(90,209,255,0.7)';
    ctx.beginPath();
    ctx.arc(cv.p0.x + 18, cv.p0.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // ① 曲线 draw-on（错峰）
  for (let i = 0; i < curves.length; i += 1) {
    const at = cfg.drawStart + i * cfg.drawGap;
    const p = clamp01((tt - at) / cfg.drawDur);
    if (p <= 0) continue;
    const ease = inOutCubic(p);
    ctx.strokeStyle = i === curves.length - 1 ? 'rgba(90,209,255,0.5)' : 'rgba(120,150,190,0.42)';
    ctx.lineWidth = 1.15;
    strokeCurve(ctx, curves[i], ease, false);
  }

  // ② 数据包：沿各自路径循环滑行，越接近汇聚点越亮
  for (let i = 0; i < curves.length; i += 1) {
    const at = cfg.drawStart + i * cfg.drawGap;
    const reveal = clamp01((tt - at) / cfg.drawDur);
    if (reveal <= 0.02) continue;
    const cv = curves[i];
    for (let k = 0; k < 2; k += 1) {
      const u = ((tt * cfg.packetSpeed + i * 0.23 + k * 0.5) % 1 + 1) % 1;
      if (u > reveal) continue;
      const pt = cubicAt(cv.p0, cv.c1, cv.c2, cv.p3, u);
      const glow = 0.25 + 0.75 * u;
      ctx.globalAlpha = glow;
      ctx.fillStyle = cfg.accent;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 1.5 + 1.5 * u, 0, Math.PI * 2);
      ctx.fill();
      // 拖尾
      ctx.globalAlpha = glow * 0.3;
      const back = cubicAt(cv.p0, cv.c1, cv.c2, cv.p3, Math.max(0, u - 0.035));
      ctx.strokeStyle = cfg.accent;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(back.x, back.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ③ 来源节点 + 沿曲线滑向汇聚点
  for (let i = 0; i < curves.length; i += 1) {
    const cv = curves[i];
    const appear = clamp01((tt - cfg.drawStart - i * cfg.drawGap) / 0.24);
    if (appear <= 0) continue;
    const at = cfg.mergeStart + i * cfg.mergeGap;
    const mp = clamp01((tt - at) / cfg.mergeDur);
    const e = accel3(mp);
    const pos = cubicAt(cv.p0, cv.c1, cv.c2, cv.p3, e);
    const scale = lerp(1, 0.06, e);
    const alpha = appear * (1 - clamp01((mp - 0.82) / 0.18));
    if (alpha <= 0.005) continue;
    ctx.globalAlpha = alpha;
    const r = 9 * scale;
    ctx.fillStyle = 'rgba(22,30,46,0.92)';
    ctx.strokeStyle = cfg.nodeColor;
    ctx.lineWidth = Math.max(0.6, 1.3 * scale);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, Math.max(0.6, r), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // 节点芯
    ctx.fillStyle = i % 2 === 0 ? cfg.accent : '#9fb4ff';
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, Math.max(0.4, r * 0.38), 0, Math.PI * 2);
    ctx.fill();
    // 起点出生脉冲
    if (appear < 1) {
      ctx.globalAlpha = appear * (1 - appear) * 1.6;
      ctx.strokeStyle = cfg.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cv.p0.x, cv.p0.y, 10 + appear * 12, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ④ 吞并脉冲：每个节点到达汇聚点时一圈扩散
  for (let i = 0; i < curves.length; i += 1) {
    const arrive = cfg.mergeStart + i * cfg.mergeGap + cfg.mergeDur;
    const p = clamp01((tt - arrive) / 0.42);
    if (p <= 0 || p >= 1) continue;
    ctx.strokeStyle = cfg.accent;
    ctx.globalAlpha = (1 - p) * 0.7;
    ctx.lineWidth = 2 * (1 - p) + 0.4;
    ctx.beginPath();
    ctx.arc(SINK.x, SINK.y, 6 + p * 46, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ⑤ 曲线反向擦除（从汇聚点往回吃），留品牌标志
  const eraseGlobal = clamp01((tt - cfg.eraseStart) / (cfg.wipeDur * 1.8));
  if (eraseGlobal > 0) {
    for (let i = 0; i < curves.length; i += 1) {
      const at = cfg.eraseStart + i * 0.06;
      const p = clamp01((tt - at) / cfg.wipeDur);
      if (p <= 0 || p >= 1) continue;
      // 用背景色重画这段（等价于擦除），再让剩余部分继续可见
      ctx.save();
      ctx.strokeStyle = cfg.background;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(curves[i].p3.x, curves[i].p3.y);
      ctx.bezierCurveTo(curves[i].c2.x, curves[i].c2.y, curves[i].c1.x, curves[i].c1.y, curves[i].p0.x, curves[i].p0.y);
      ctx.setLineDash([curves[i].len, curves[i].len]);
      ctx.lineDashOffset = -curves[i].len * clamp01(p);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.restore();
    }
  }

  // 汇聚点常亮小点（吞并后仍在）
  if (tt > cfg.mergeStart + cfg.mergeDur * 0.5) {
    const pulse = 0.5 + 0.5 * Math.sin(tt * 4.2);
    ctx.fillStyle = cfg.accent;
    ctx.globalAlpha = 0.35 + 0.3 * pulse;
    ctx.beginPath();
    ctx.arc(SINK.x, SINK.y, 2.2 + pulse * 1.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // ⑥ 品牌白瓷圆片（末段成形并定格）
  const chipAt = cfg.eraseStart + cfg.wipeDur * 0.9;
  const chipP = clamp01((tt - chipAt) / 0.5);
  if (chipP > 0) {
    const ease = 1 - Math.pow(1 - chipP, 3);
    // 圆片外的一圈光（末帧只剩标志时，这点光是"卡还在"的证据）
    ctx.globalAlpha = 0.34 * ease;
    ctx.strokeStyle = cfg.accent;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(SINK.x, SINK.y, 30 + Math.sin(tt * 2.4) * 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.16 * ease;
    ctx.fillStyle = cfg.accent;
    ctx.beginPath();
    ctx.arc(SINK.x, SINK.y, 44, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    drawChip(ctx, SINK.x, SINK.y, 18 * (0.82 + 0.18 * ease) + Math.sin(Math.min(1, chipP) * Math.PI) * 0.9, ease, cfg);
  }

  // 左上角小标注：来源计数（设计内的信息，不是调试）
  ctx.fillStyle = 'rgba(190,205,225,0.45)';
  ctx.font = '9px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const merged = curves.filter((_, i) => tt >= cfg.mergeStart + i * cfg.mergeGap + cfg.mergeDur).length;
  ctx.fillText(`SRC ${String(merged).padStart(2, '0')}/${String(cfg.sources).padStart(2, '0')} → 1`, 18, 16);

  ctx.restore();
}
