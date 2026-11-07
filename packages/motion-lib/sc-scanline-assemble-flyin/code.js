/**
 * sc-scanline-assemble-flyin · 扫描线装配（人工重写版）
 *
 * 配方来源：video-shotcraft / references/shots/effects/scanline-assemble-flyin.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡为 Remotion/DOM + mask 的装配动画；这里用 Canvas2D 手写：扫描线位置是
 *           纯函数，每个槽位按"线经过它的时刻"触发飞入，方向性残影用 2 层偏移复制（不是 blur）。
 *
 * 配方要点（照卡文）：
 *   - 开场是一张只有网格与虚线槽位的蓝图画板；
 *   - 一条亮扫描线自上而下掠过；
 *   - 扫到每个槽位，该处组件就从画外飞入、过冲贴合，带方向性残影与落位咬合角标；
 *   - 扫完整页恰好装配完成。
 *
 * 契约：render(ctx2d, t, env)；纯函数，任意 seek 一致。
 */

export const meta = {
  title: '扫描线装配',
  duration: 5.2,
  kind: '几何',
  source: 'shotcraft',
  sourcePath: 'references/shots/effects/scanline-assemble-flyin.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
};

const DW = 480;
const DH = 270;

const DEFAULTS = {
  scanStart: 0.45,
  scanDur: 1.55,
  slotDelay: 0.05,
  flyDur: 0.34,
  background: '#071019',
  blueprint: 'rgba(90,180,230,0.32)',
  ink: '#cfe8f7',
  accent: '#5ce1ff',
  panel: '#10202c',
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

// 六个槽位：2 列 × 3 行
const SLOTS = [];
for (let row = 0; row < 3; row += 1) {
  for (let col = 0; col < 2; col += 1) {
    SLOTS.push({ x: 52 + col * 216, y: 36 + row * 82, w: 160, h: 66, row, col });
  }
}

/** 槽位的组件：三种母题轮换，都画在 (x,y,w,h) 内。 */
function paintComponent(ctx, i, x, y, w, h, cfg) {
  ctx.fillStyle = cfg.panel;
  roundRect(ctx, x, y, w, h, 4);
  ctx.fill();

  ctx.strokeStyle = 'rgba(92,225,255,0.32)';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 4);
  ctx.stroke();

  const cx = x + w / 2;
  const cy = y + h / 2;
  if (i % 3 === 0) {
    // 柱状
    const vals = [0.4, 0.7, 0.55, 0.9];
    for (let k = 0; k < vals.length; k += 1) {
      const bh = (h - 26) * vals[k];
      ctx.fillStyle = k === 3 ? cfg.accent : 'rgba(207,232,247,0.3)';
      ctx.fillRect(x + 22 + k * 30, y + h - 13 - bh, 18, bh);
    }
  } else if (i % 3 === 1) {
    // 文本行
    for (let k = 0; k < 3; k += 1) {
      ctx.fillStyle = k === 0 ? cfg.accent : 'rgba(207,232,247,0.28)';
      ctx.fillRect(x + 18, y + 18 + k * 13, (w - 36) * (0.9 - k * 0.22), k === 0 ? 4 : 2.6);
    }
  } else {
    // 半环仪表
    ctx.strokeStyle = 'rgba(207,232,247,0.24)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy + 6, 20, Math.PI * 1.08, Math.PI * 1.92);
    ctx.stroke();
    ctx.strokeStyle = cfg.accent;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy + 6, 20, Math.PI * 1.08, Math.PI * 1.08 + Math.PI * 0.84 * 0.72);
    ctx.stroke();
  }
}

export function render(ctx, t, env) {
  const w = Math.max(1, Math.round(Number(env && env.width) || DW));
  const h = Math.max(1, Math.round(Number(env && env.height) || DH));
  const props = (env && env.props) || {};
  const cfg = {
    scanStart: num(props.scanStart, DEFAULTS.scanStart, 0, 3),
    scanDur: num(props.scanDur, DEFAULTS.scanDur, 0.3, 4),
    slotDelay: num(props.slotDelay, DEFAULTS.slotDelay, 0, 0.5),
    flyDur: num(props.flyDur, DEFAULTS.flyDur, 0.1, 1.2),
    background: props.background || DEFAULTS.background,
    blueprint: props.blueprint || DEFAULTS.blueprint,
    ink: props.ink || DEFAULTS.ink,
    accent: props.accent || DEFAULTS.accent,
    panel: props.panel || DEFAULTS.panel,
  };

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

  // 蓝图网格（细 + 粗两层）
  ctx.strokeStyle = 'rgba(90,180,230,0.08)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let x = 0; x <= DW; x += 12) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, DH);
  }
  for (let y = 0; y <= DH; y += 12) {
    ctx.moveTo(0, y);
    ctx.lineTo(DW, y);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(90,180,230,0.14)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let x = 0; x <= DW; x += 60) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, DH);
  }
  for (let y = 0; y <= DH; y += 60) {
    ctx.moveTo(0, y);
    ctx.lineTo(DW, y);
  }
  ctx.stroke();

  // 虚线槽位（还没装配出来的地方）
  const scanY = -8 + (DH + 16) * clamp01((tt - cfg.scanStart) / cfg.scanDur);
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(90,180,230,0.3)';
  ctx.lineWidth = 1;
  for (const slot of SLOTS) {
    const built = scanY > slot.y + slot.h * 0.5;
    if (built) continue;
    ctx.strokeRect(slot.x, slot.y, slot.w, slot.h);
    // 槽位中心十字
    ctx.beginPath();
    ctx.moveTo(slot.x + slot.w / 2 - 6, slot.y + slot.h / 2);
    ctx.lineTo(slot.x + slot.w / 2 + 6, slot.y + slot.h / 2);
    ctx.moveTo(slot.x + slot.w / 2, slot.y + slot.h / 2 - 6);
    ctx.lineTo(slot.x + slot.w / 2, slot.y + slot.h / 2 + 6);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // 组件飞入（每个槽位按扫描线经过它的时刻触发）
  for (let i = 0; i < SLOTS.length; i += 1) {
    const slot = SLOTS[i];
    const trigger = cfg.scanStart + ((slot.y + slot.h * 0.5 + 8) / (DH + 16)) * cfg.scanDur + cfg.slotDelay;
    const p = clamp01((tt - trigger) / cfg.flyDur);
    if (p <= 0) continue;
    const e = backOut(2.3)(p);
    // 从画外方向飞入（左列从左边、右列从右边；行序给一点纵向分量）
    const dirX = slot.col === 0 ? -1 : 1;
    const dx = dirX * 28 * (1 - e);
    const dy = (slot.row - 1) * 14 * (1 - e);
    const sc = 0.86 + 0.14 * e;

    // 方向性残影：两层偏移复制（不是 blur，性能安全）
    if (p < 0.85) {
      for (let k = 2; k >= 1; k -= 1) {
        ctx.save();
        ctx.globalAlpha = 0.16 / k;
        ctx.translate(dx - dirX * k * 7, dy);
        ctx.translate(slot.x + slot.w / 2, slot.y + slot.h / 2);
        ctx.scale(sc, sc);
        ctx.translate(-(slot.x + slot.w / 2), -(slot.y + slot.h / 2));
        paintComponent(ctx, i, slot.x, slot.y, slot.w, slot.h, cfg);
        ctx.restore();
      }
    }

    // 本体
    ctx.save();
    ctx.globalAlpha = clamp01(p * 1.6);
    ctx.translate(dx, dy);
    ctx.translate(slot.x + slot.w / 2, slot.y + slot.h / 2);
    ctx.scale(sc, sc);
    ctx.translate(-(slot.x + slot.w / 2), -(slot.y + slot.h / 2));
    paintComponent(ctx, i, slot.x, slot.y, slot.w, slot.h, cfg);
    ctx.restore();

    // 落位咬合角标（到位后 0.2s 亮一下）
    const lockP = clamp01((tt - trigger - cfg.flyDur * 0.8) / 0.22);
    if (lockP > 0 && lockP < 1) {
      ctx.globalAlpha = (1 - lockP) * 0.9;
      ctx.strokeStyle = cfg.accent;
      ctx.lineWidth = 1.6;
      const arm = 7;
      const x0 = slot.x - 2;
      const y0 = slot.y - 2;
      const x1 = slot.x + slot.w + 2;
      const y1 = slot.y + slot.h + 2;
      for (const c of [
        { x: x0, y: y0, sx: 1, sy: 1 },
        { x: x1, y: y0, sx: -1, sy: 1 },
        { x: x0, y: y1, sx: 1, sy: -1 },
        { x: x1, y: y1, sx: -1, sy: -1 },
      ]) {
        ctx.beginPath();
        ctx.moveTo(c.x, c.y + c.sy * arm);
        ctx.lineTo(c.x, c.y);
        ctx.lineTo(c.x + c.sx * arm, c.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  // 扫描线本体：亮带 + 上下两层很短的渐变尾
  if (scanY > -4 && scanY < DH + 4) {
    const g = ctx.createLinearGradient(0, scanY - 26, 0, scanY);
    g.addColorStop(0, 'rgba(92,225,255,0)');
    g.addColorStop(1, 'rgba(92,225,255,0.22)');
    ctx.fillStyle = g;
    ctx.fillRect(0, scanY - 26, DW, 26);
    ctx.fillStyle = 'rgba(190,245,255,0.92)';
    ctx.fillRect(0, scanY - 0.7, DW, 1.4);
    // 扫描线两侧的刻度
    ctx.fillStyle = 'rgba(92,225,255,0.6)';
    for (let x = 8; x < DW; x += 24) {
      ctx.fillRect(x, scanY - 3, 1, 2);
    }
  }

  // 顶部状态：装配进度
  const built = SLOTS.filter((slot) => scanY > slot.y + slot.h * 0.5).length;
  ctx.fillStyle = 'rgba(207,232,247,0.5)';
  ctx.font = '8px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`ASSEMBLY ${String(built).padStart(2, '0')}/${String(SLOTS.length).padStart(2, '0')}`, 20, 12);
  ctx.fillStyle = 'rgba(92,225,255,0.8)';
  ctx.fillRect(20, 24, 90 * (built / SLOTS.length), 1.6);

  ctx.restore();
}
