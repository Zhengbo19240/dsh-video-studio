/**
 * sc-fui-hud-moves · HUD 准星咬合（人工重写版）
 *
 * 配方来源：video-shotcraft / references/shots/effects/fui-hud-moves.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡为 Remotion/DOM 的 FUI 元件；这里用 Canvas2D 的 L 形角标 + 超调回弹重写，
 *           回弹用 backOut 数学缓动，不用 CSS transition。
 *
 * 配方要点（照卡文）：
 *   - 四个 L 形角标组成的取景框从画外飞入；
 *   - 超调回弹后咬合锁定目标（over-shoot 一次，别回弹两次）；
 *   - 锁定帧是打击点：闪一下强调色，随后进入低能量呼吸。
 *
 * 契约：render(ctx2d, t, env)；纯函数，任意 seek 一致。
 */

export const meta = {
  title: 'HUD 准星咬合',
  duration: 3,
  kind: '几何',
  source: 'shotcraft',
  sourcePath: 'references/shots/effects/fui-hud-moves.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
};

const DW = 480;
const DH = 270;

const DEFAULTS = {
  flyIn: 0.62,
  overshoot: 2.4,
  lockAt: 0.78,
  arm: 26,
  weight: 3,
  background: '#070a0f',
  ink: '#cfe4ff',
  accent: '#61f2c8',
  warn: '#ff6a4d',
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

const FRAME = { x: 118, y: 74, w: 244, h: 124 };

export function render(ctx, t, env) {
  const w = Math.max(1, Math.round(Number(env && env.width) || DW));
  const h = Math.max(1, Math.round(Number(env && env.height) || DH));
  const props = (env && env.props) || {};
  const cfg = {
    flyIn: num(props.flyIn, DEFAULTS.flyIn, 0.1, 2),
    overshoot: num(props.overshoot, DEFAULTS.overshoot, 0, 4),
    lockAt: num(props.lockAt, DEFAULTS.lockAt, 0.1, 2.5),
    arm: num(props.arm, DEFAULTS.arm, 8, 60),
    weight: num(props.weight, DEFAULTS.weight, 1, 8),
    background: props.background || DEFAULTS.background,
    ink: props.ink || DEFAULTS.ink,
    accent: props.accent || DEFAULTS.accent,
    warn: props.warn || DEFAULTS.warn,
  };

  const duration = num(env && env.duration, meta.duration, 0.4, 120);
  const tt = Math.min(duration, Math.max(0, Number.isFinite(Number(t)) ? Number(t) : 0));

  const s = Math.min(w / DW, h / DH);
  const ox = (w - DW * s) / 2;
  const oy = (h - DH * s) / 2;

  ctx.save();
  ctx.fillStyle = cfg.background;
  ctx.fillRect(0, 0, w, h);

  ctx.translate(ox, oy);
  ctx.scale(s, s);

  // 背景微网格 + 扫描噪点（低对比，给 FUI 一层底）
  ctx.strokeStyle = 'rgba(97,242,200,0.05)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let x = 0; x <= DW; x += 16) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, DH);
  }
  for (let y = 0; y <= DH; y += 16) {
    ctx.moveTo(0, y);
    ctx.lineTo(DW, y);
  }
  ctx.stroke();

  // 目标本体：同心圆 + 十字 + 四点（t=0 也要读得出"在瞄什么"）
  const cx = FRAME.x + FRAME.w / 2;
  const cy = FRAME.y + FRAME.h / 2;
  const appear = outCubic(clamp01(tt / 0.35));
  ctx.globalAlpha = 0.45 + 0.55 * appear;
  ctx.strokeStyle = 'rgba(130,190,255,0.62)';
  ctx.lineWidth = 1;
  for (const r of [16, 30, 48]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(120,180,255,0.22)';
  ctx.beginPath();
  ctx.moveTo(cx - 66, cy);
  ctx.lineTo(cx + 66, cy);
  ctx.moveTo(cx, cy - 56);
  ctx.lineTo(cx, cy + 56);
  ctx.stroke();
  ctx.fillStyle = 'rgba(180,215,255,0.7)';
  for (const [dx, dy] of [[0, -48], [48, 0], [0, 48], [-48, 0]]) {
    ctx.beginPath();
    ctx.arc(cx + dx, cy + dy, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 四角 L 形角标：从画外飞入 + 一次超调回弹咬合
  const flyP = clamp01(tt / cfg.flyIn);
  const e = backOut(cfg.overshoot)(flyP);
  const dist = 64 * (1 - e);
  const locked = tt >= cfg.lockAt;
  const lockFlash = tt >= cfg.lockAt ? 1 - clamp01((tt - cfg.lockAt) / 0.22) : 0;

  // 锁定后 0.22s 的抖动（衰减，读作"咔"）
  const shakeAmp = locked ? Math.max(0, 1 - (tt - cfg.lockAt) / 0.22) * 2.2 : 0;
  const shakeX = shakeAmp * Math.sin(tt * 96);
  const shakeY = shakeAmp * Math.cos(tt * 121);

  const corners = [
    { sx: -1, sy: -1, x: FRAME.x, y: FRAME.y },
    { sx: 1, sy: -1, x: FRAME.x + FRAME.w, y: FRAME.y },
    { sx: -1, sy: 1, x: FRAME.x, y: FRAME.y + FRAME.h },
    { sx: 1, sy: 1, x: FRAME.x + FRAME.w, y: FRAME.y + FRAME.h },
  ];

  const lockColor = lockFlash > 0.05 ? cfg.accent : cfg.ink;
  const breath = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(tt * 3.1));
  ctx.save();
  ctx.translate(shakeX, shakeY);
  ctx.strokeStyle = lockColor;
  ctx.lineWidth = cfg.weight;
  ctx.lineCap = 'square';
  ctx.globalAlpha = (0.3 + 0.7 * clamp01(flyP * 1.4)) * (locked ? breath : 0.85);
  for (const c of corners) {
    const px = c.x + c.sx * dist;
    const py = c.y + c.sy * dist;
    ctx.beginPath();
    ctx.moveTo(px, py + c.sy * cfg.arm);
    ctx.lineTo(px, py);
    ctx.lineTo(px + c.sx * cfg.arm, py);
    ctx.stroke();
  }
  ctx.restore();

  // 锁定瞬间：四角各打一枚短刻度，把"咬合"说清楚
  if (locked) {
    const mP = clamp01((tt - cfg.lockAt) / 0.18);
    ctx.globalAlpha = (1 - mP) * 0.9;
    ctx.strokeStyle = cfg.accent;
    ctx.lineWidth = 2;
    for (const c of corners) {
      ctx.beginPath();
      ctx.moveTo(c.x + c.sx * (cfg.arm + 4), c.y + c.sy * (cfg.arm + 4));
      ctx.lineTo(c.x + c.sx * (cfg.arm + 12), c.y + c.sy * (cfg.arm + 12));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // 扫描细线（竖线，慢速左右扫）
  const scanX = FRAME.x + ((tt * 42) % FRAME.w);
  const scanGrad = ctx.createLinearGradient(scanX - 26, 0, scanX, 0);
  scanGrad.addColorStop(0, 'rgba(97,242,200,0)');
  scanGrad.addColorStop(1, 'rgba(97,242,200,0.16)');
  ctx.fillStyle = scanGrad;
  ctx.fillRect(scanX - 26, FRAME.y, 26, FRAME.h);
  ctx.fillStyle = 'rgba(97,242,200,0.35)';
  ctx.fillRect(scanX, FRAME.y, 0.8, FRAME.h);

  // 四边刻度
  ctx.strokeStyle = 'rgba(160,200,255,0.28)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let i = 0; i <= 10; i += 1) {
    const x = FRAME.x + (FRAME.w * i) / 10;
    const len = i % 5 === 0 ? 6 : 3;
    ctx.moveTo(x, FRAME.y - 8);
    ctx.lineTo(x, FRAME.y - 8 + len);
    ctx.moveTo(x, FRAME.y + FRAME.h + 8);
    ctx.lineTo(x, FRAME.y + FRAME.h + 8 - len);
  }
  for (let i = 0; i <= 5; i += 1) {
    const y = FRAME.y + (FRAME.h * i) / 5;
    const len = i === 0 || i === 5 ? 6 : 3;
    ctx.moveTo(FRAME.x - 8, y);
    ctx.lineTo(FRAME.x - 8 + len, y);
    ctx.moveTo(FRAME.x + FRAME.w + 8, y);
    ctx.lineTo(FRAME.x + FRAME.w + 8 - len, y);
  }
  ctx.stroke();

  // 角标读数
  const font = '9px ui-monospace, Consolas, monospace';
  ctx.font = font;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = locked ? cfg.accent : 'rgba(160,200,255,0.55)';
  ctx.fillText('TGT-07 // ' + (locked ? 'LOCKED' : 'ACQUIRING'), 118, 44);
  ctx.fillStyle = 'rgba(160,200,255,0.42)';
  ctx.fillText('FOV 62°  GAIN 1.4', 118, 56);

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(160,200,255,0.42)';
  ctx.fillText('41°12\u2032N  92°08\u2032E', 362, 44);
  ctx.fillStyle = locked ? cfg.accent : 'rgba(160,200,255,0.42)';
  ctx.fillText(locked ? 'RANGE 412m  ✓' : 'RANGE ---', 362, 56);

  // 底部状态：一条进度（采集 → 锁定）
  const barW = 120;
  const barP = clamp01(tt / cfg.lockAt);
  ctx.fillStyle = 'rgba(160,200,255,0.16)';
  ctx.fillRect(118, 220, barW, 2);
  ctx.fillStyle = locked ? cfg.accent : 'rgba(160,200,255,0.6)';
  ctx.fillRect(118, 220, barW * barP, 2);
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(160,200,255,0.34)';
  ctx.fillText('SYNC ' + String(Math.round(barP * 100)).padStart(3, '0') + '%', 118, 228);

  // 右上角小警告灯（锁定后转常亮）
  ctx.fillStyle = locked && lockFlash > 0.5 ? cfg.warn : 'rgba(255,106,77,0.35)';
  ctx.beginPath();
  ctx.arc(362, 22, 2.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}
