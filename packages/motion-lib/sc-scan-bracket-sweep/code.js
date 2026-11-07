/**
 * sc-scan-bracket-sweep · 扫描取景扫读（人工重写版）
 *
 * 配方来源：video-shotcraft / references/shots/effects/scan-bracket-sweep.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡为 Remotion/DOM + mask 的扫描；这里用 Canvas2D clip + 线性渐变光带重写，
 *           光带只在文档矩形内绘制（clip 全包裹 save/restore），没有全屏模糊。
 *
 * 配方要点（照卡文）：
 *   - 文档弹到中央，全程静止；
 *   - 四角落下 L 形取景括号；
 *   - 一条扫描光带拖着渐变尾迹在文档上往复扫 5 趟 —— 光在读它，文档不动。
 *
 * 契约：render(ctx2d, t, env)；纯函数，任意 seek 一致。
 */

export const meta = {
  title: '扫描取景扫读',
  duration: 5,
  kind: '几何',
  source: 'shotcraft',
  sourcePath: 'references/shots/effects/scan-bracket-sweep.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
};

const DW = 480;
const DH = 270;

const DEFAULTS = {
  passes: 5,
  passDur: 0.72,
  bracketAt: 0.55,
  docW: 214,
  docH: 150,
  background: '#080a0f',
  paper: '#eae3d4',
  ink: '#1d1f26',
  accent: '#5ce1ff',
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

/** 文档内容：像一页说明书的排版（标题 + 段落线 + 图块 + 表格）。 */
function paintDoc(ctx, x, y, w, h, cfg) {
  ctx.fillStyle = cfg.paper;
  roundRect(ctx, x, y, w, h, 3);
  ctx.fill();

  const pad = 14;
  ctx.fillStyle = cfg.ink;
  ctx.font = '700 13px system-ui, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('技术说明', x + pad, y + pad);

  ctx.fillStyle = 'rgba(29,31,38,0.22)';
  ctx.fillRect(x + pad, y + pad + 22, w - pad * 2, 1);

  // 段落线
  for (let i = 0; i < 5; i += 1) {
    const lw = (w - pad * 2) * (i === 4 ? 0.54 : i % 2 === 0 ? 0.92 : 0.78);
    ctx.fillStyle = `rgba(29,31,38,${0.18 + (i % 2) * 0.06})`;
    ctx.fillRect(x + pad, y + pad + 32 + i * 9, lw, 2.4);
  }

  // 图块（右侧）
  const gx = x + w - pad - 62;
  const gy = y + pad + 32;
  ctx.fillStyle = 'rgba(236,74,44,0.16)';
  ctx.fillRect(gx, gy, 62, 30);
  ctx.strokeStyle = 'rgba(236,74,44,0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(gx, gy, 62, 30);
  ctx.fillStyle = 'rgba(236,74,44,0.6)';
  ctx.fillRect(gx + 8, gy + 18, 20, 3);
  ctx.fillRect(gx + 8, gy + 24, 34, 2);

  // 表格
  const ty = y + h - pad - 34;
  ctx.strokeStyle = 'rgba(29,31,38,0.2)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let r = 0; r <= 3; r += 1) {
    ctx.moveTo(x + pad, ty + r * 11);
    ctx.lineTo(x + w - pad, ty + r * 11);
  }
  for (let c = 0; c <= 3; c += 1) {
    const cx2 = x + pad + ((w - pad * 2) / 3) * c;
    ctx.moveTo(cx2, ty);
    ctx.lineTo(cx2, ty + 33);
  }
  ctx.stroke();

  // 页码
  ctx.fillStyle = 'rgba(29,31,38,0.35)';
  ctx.font = '7px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('P. 04 / 12', x + w - pad, y + h - 6);
}

export function render(ctx, t, env) {
  const w = Math.max(1, Math.round(Number(env && env.width) || DW));
  const h = Math.max(1, Math.round(Number(env && env.height) || DH));
  const props = (env && env.props) || {};
  const cfg = {
    passes: Math.round(num(props.passes, DEFAULTS.passes, 1, 20)),
    passDur: num(props.passDur, DEFAULTS.passDur, 0.15, 3),
    bracketAt: num(props.bracketAt, DEFAULTS.bracketAt, 0, 3),
    docW: num(props.docW, DEFAULTS.docW, 80, 420),
    docH: num(props.docH, DEFAULTS.docH, 60, 260),
    background: props.background || DEFAULTS.background,
    paper: props.paper || DEFAULTS.paper,
    ink: props.ink || DEFAULTS.ink,
    accent: props.accent || DEFAULTS.accent,
  };

  const duration = num(env && env.duration, meta.duration, 0.8, 120);
  const tt = Math.min(duration, Math.max(0, Number.isFinite(Number(t)) ? Number(t) : 0));

  const s = Math.min(w / DW, h / DH);
  const ox = (w - DW * s) / 2;
  const oy = (h - DH * s) / 2;

  // 合并形态（第二轮 · 2026-11-06）：mode:'lock' 走 sc-fui-hud-moves 的
  // 「四角 L 从画外扑入 → 超调回弹咬合 → 锁定帧白闪」。默认 'sweep' 不变。
  if (String(props.mode || 'sweep') === 'lock') {
    renderLockOn(ctx, w, h, props, tt, s, ox, oy);
    return;
  }

  ctx.save();
  ctx.fillStyle = cfg.background;
  ctx.fillRect(0, 0, w, h);

  // 背景微网格
  ctx.strokeStyle = 'rgba(92,225,255,0.045)';
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let x = 0; x < w; x += Math.max(18, s * 24)) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let y = 0; y < h; y += Math.max(18, s * 24)) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  ctx.translate(ox, oy);
  ctx.scale(s, s);

  // 文档弹入：从下方 16px、scale 0.94，带一次超调
  const inP = clamp01(tt / 0.45);
  const docY = (1 - backOut(1.8)(inP)) * 16;
  const docS = 0.94 + 0.06 * backOut(1.8)(inP);
  const docX = (DW - cfg.docW) / 2;
  const docYBase = (DH - cfg.docH) / 2;

  ctx.save();
  ctx.globalAlpha = 0.4 + 0.6 * clamp01(inP * 1.8);
  ctx.translate(DW / 2, DH / 2 + docY);
  ctx.scale(docS, docS);
  ctx.translate(-DW / 2, -DH / 2);
  paintDoc(ctx, docX, docYBase, cfg.docW, cfg.docH, cfg);
  ctx.restore();

  // 文档投影（在文档下方，一个暗色矩形，不是 blur）
  if (inP > 0.2) {
    ctx.globalAlpha = 0.35 * clamp01((inP - 0.2) / 0.6);
    ctx.fillStyle = '#000000';
    roundRect(ctx, docX + 4, docYBase + 7 + docY, cfg.docW, cfg.docH, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // 四角 L 形取景括号：从四个方向落下
  const brP = clamp01((tt - cfg.bracketAt) / 0.5);
  if (brP > 0) {
    const e = backOut(2.2)(brP);
    const gap = 7 + (1 - e) * 26;
    const arm = 18;
    const x0 = docX - gap;
    const y0 = docYBase - gap + docY;
    const x1 = docX + cfg.docW + gap;
    const y1 = docYBase + cfg.docH + gap + docY;

    ctx.globalAlpha = clamp01(brP * 1.6);
    ctx.strokeStyle = cfg.accent;
    ctx.lineWidth = 2;
    ctx.lineCap = 'square';
    const corners = [
      { x: x0, y: y0, sx: 1, sy: 1 },
      { x: x1, y: y0, sx: -1, sy: 1 },
      { x: x0, y: y1, sx: 1, sy: -1 },
      { x: x1, y: y1, sx: -1, sy: -1 },
    ];
    for (const c of corners) {
      ctx.beginPath();
      ctx.moveTo(c.x, c.y + c.sy * arm);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(c.x + c.sx * arm, c.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 括号标签
    ctx.fillStyle = 'rgba(92,225,255,0.55)';
    ctx.font = '7px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('SCAN 5×', x0, y0 - 4);
  }

  // 扫描光带：往复（三角波），只在文档内
  const scanStart = cfg.bracketAt + 0.45;
  if (tt > scanStart) {
    const cycle = cfg.passDur;
    const elapsed = tt - scanStart;
    const totalCycles = cfg.passes;
    const cyc = Math.floor(elapsed / cycle);
    if (cyc < totalCycles) {
      const phase = (elapsed % cycle) / cycle; // 0→1 一趟
      const tri = 1 - Math.abs(2 * phase - 1); // 上下往复
      const down = phase < 0.5;
      const bandY = docYBase + docY + tri * cfg.docH;
      const tailH = 42;

      // clip 到文档（save/restore 必须成对）
      ctx.save();
      ctx.beginPath();
      roundRect(ctx, docX, docYBase + docY, cfg.docW, cfg.docH, 3);
      ctx.clip();

      // 尾迹：朝向运动来的方向
      const g = ctx.createLinearGradient(0, down ? bandY - tailH : bandY, 0, down ? bandY : bandY + tailH);
      g.addColorStop(0, 'rgba(92,225,255,0)');
      g.addColorStop(0.72, 'rgba(92,225,255,0.26)');
      g.addColorStop(1, `rgba(180,248,255,0.9)`);
      ctx.fillStyle = g;
      ctx.fillRect(docX, down ? bandY - tailH : bandY, cfg.docW, tailH);

      // 亮线
      ctx.fillStyle = 'rgba(220,252,255,0.95)';
      ctx.fillRect(docX, bandY - 0.8, cfg.docW, 1.6);

      // 线上横向的读数刻度（读作"逐行扫描"）
      ctx.fillStyle = 'rgba(92,225,255,0.5)';
      for (let i = 0; i < 12; i += 1) {
        ctx.fillRect(docX + 4 + i * (cfg.docW - 8) / 11, bandY - 4, 1, 2);
      }
      ctx.restore();

      // 文档外的光带外溢（很短，避免"光跑出纸"）
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = cfg.accent;
      ctx.fillRect(docX - 4, bandY - 0.6, 4, 1.2);
      ctx.fillRect(docX + cfg.docW, bandY - 0.6, 4, 1.2);
      ctx.restore();
    }
  }

  // 右下角：趟数读数
  if (tt > scanStart) {
    const done = Math.min(cfg.passes, Math.floor((tt - scanStart) / cfg.passDur));
    ctx.fillStyle = 'rgba(92,225,255,0.6)';
    ctx.font = '8px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`PASS ${String(done).padStart(2, '0')}/${cfg.passes}`, DW - 14, DH - 10);
  }

  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* 合并形态：sc-fui-hud-moves（四角扑入 → 超调咬合 → 锁定帧白闪）        */
/* 同一套「L 形角标 + 目标框」；扫描的光带换成一次性扑入 + 回弹，          */
/* 触发方式从「匀速扫过多目标」变成「单目标锁定」。                      */
/* ------------------------------------------------------------------ */
function renderLockOn(ctx, w, h, props, tt, s, ox, oy) {
  const accent = props.accent || DEFAULTS.accent;
  const targetName = props.targetName || 'TARGET';

  ctx.save();
  ctx.fillStyle = '#080a0f';
  ctx.fillRect(0, 0, w, h);

  // 背景微网格 + 低对比噪点（给 FUI 一层底）
  ctx.save();
  ctx.strokeStyle = 'rgba(92,225,255,0.045)';
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let x = 0; x < w; x += Math.max(18, s * 24)) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let y = 0; y < h; y += Math.max(18, s * 24)) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
  ctx.restore();

  ctx.translate(ox, oy);
  ctx.scale(s, s);

  const cx = DW / 2;
  const cy = DH / 2;
  const r = 46;

  // 目标本体：同心圆 + 十字 + 四点（t=0 也要读得出「在瞄什么」）
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = 'rgba(92,225,255,0.55)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 3; i += 1) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * (0.55 + i * 0.22), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - 8, cy);
  ctx.lineTo(cx + 8, cy);
  ctx.moveTo(cx, cy - 8);
  ctx.lineTo(cx, cy + 8);
  ctx.stroke();
  ctx.fillStyle = 'rgba(92,225,255,0.8)';
  for (let i = 0; i < 4; i += 1) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * r * 1.35, cy + Math.sin(a) * r * 1.35, 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 四角 L：flyAt 起从画外（±700, ±500）扑向目标 bbox 的 2.2 倍，
  // arriveAt 收缩过头到 0.94，lockAt 用 back.out 回弹到 1。
  const flyAt = 0.8;
  const arriveAt = flyAt + 0.33;
  const lockAt = arriveAt + 0.2;
  const flyP = clamp01((tt - flyAt) / (arriveAt - flyAt));
  const e = outCubic(flyP);

  let k = 2.2;
  if (tt >= arriveAt) k = 2.2 + (0.94 - 2.2) * clamp01((tt - arriveAt) / 0.2);
  if (tt >= lockAt) k = 0.94 + (1 - 0.94) * backOut(2)(clamp01((tt - lockAt) / 0.15));

  const lockP = clamp01((tt - lockAt) / 0.24);
  const arm = 16;
  const half = r * 1.12 * k;

  // 锁定瞬间：目标框内白闪，之后常驻微亮
  let flash = 0;
  if (tt >= lockAt) {
    flash = tt < lockAt + 0.04 ? 0.55 : 0.55 + (0.28 - 0.55) * clamp01((tt - lockAt - 0.04) / 0.2);
  }
  if (flash > 0.001) {
    ctx.save();
    ctx.globalAlpha = flash;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
  }

  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.lineCap = 'square';
  const corners = [
    { sx: -1, sy: -1 },
    { sx: 1, sy: -1 },
    { sx: -1, sy: 1 },
    { sx: 1, sy: 1 },
  ];
  for (let i = 0; i < corners.length; i += 1) {
    const c = corners[i];
    // 每个角从自己的画外方向扑入（±700, ±500）
    const ox0 = c.sx * 700;
    const oy0 = c.sy * 500;
    const px = cx + c.sx * half - ox0 * (1 - e);
    const py = cy + c.sy * half - oy0 * (1 - e);
    ctx.globalAlpha = clamp01(flyP * 1.6);
    ctx.beginPath();
    ctx.moveTo(px, py + c.sy * arm);
    ctx.lineTo(px, py);
    ctx.lineTo(px + c.sx * arm, py);
    ctx.stroke();
    // 锁定帧：四角各打一枚短刻度，把「咬合」说清楚
    if (tt >= lockAt && lockP > 0) {
      ctx.globalAlpha = 1 - lockP;
      ctx.beginPath();
      ctx.moveTo(px, py + c.sy * (arm + 4));
      ctx.lineTo(px, py + c.sy * (arm + 10));
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // 扫描细线（竖线，慢速左右扫）
  const sweepX = cx + Math.sin(tt * 1.7) * (DW * 0.34);
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = accent;
  ctx.fillRect(sweepX, 18, 1, DH - 36);
  ctx.restore();

  // 标签：锁定同帧 back 弹出在目标右侧
  const labelP = clamp01((tt - lockAt) / 0.35);
  if (labelP > 0) {
    const label = props.label || '就是这个按钮';
    const lx = cx + r + 22;
    const ly = cy - 18;
    ctx.save();
    ctx.globalAlpha = labelP;
    ctx.font = '600 8px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const lw = ctx.measureText(label).width + 14;
    ctx.fillStyle = 'rgba(92,225,255,0.14)';
    ctx.fillRect(lx, ly, lw * labelP, 13);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(lx, ly, lw * labelP, 13);
    ctx.fillStyle = accent;
    ctx.fillText(label, lx + 7, ly + 6.5);
    ctx.restore();
  }

  // 顶部读数 + 底部状态
  ctx.save();
  ctx.fillStyle = 'rgba(92,225,255,0.55)';
  ctx.font = '7px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('FUI / HUD', 14, 12);
  ctx.textAlign = 'right';
  ctx.fillText(tt >= lockAt ? 'LOCKED' : 'ACQUIRING', DW - 14, 12);
  ctx.restore();

  // 底部状态条：采集 → 锁定
  const barP = clamp01(tt / lockAt);
  ctx.save();
  ctx.fillStyle = 'rgba(92,225,255,0.18)';
  ctx.fillRect(14, DH - 18, DW - 28, 2);
  ctx.fillStyle = accent;
  ctx.fillRect(14, DH - 18, (DW - 28) * barP, 2);
  ctx.restore();

  // 右上角小警告灯（锁定后转常亮）
  ctx.save();
  ctx.globalAlpha = tt >= lockAt ? 1 : 0.35 + 0.35 * Math.sin(tt * 8);
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(DW - 22, 26, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 角标读数
  ctx.save();
  ctx.fillStyle = 'rgba(92,225,255,0.45)';
  ctx.font = '6px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(targetName, 14, DH - 26);
  ctx.restore();

  ctx.restore();
}
