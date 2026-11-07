/**
 * sc-glow-flyline-moves · 光斑与飞线三式（人工重写版）
 *
 * 配方来源：video-shotcraft / references/shots/effects/glow-flyline-moves.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡为 Remotion/DOM + CSS filter 的发光层；这里用 Canvas2D 的径向渐变画光，
 *           一次 ctx.filter 都不用 —— 光靠渐变叠加，1080p 下没有全屏模糊代价。
 *
 * 配方要点（照卡文）：
 *   - glow-orb-ambient：暗场光斑底噪（多处缓慢漂移的柔光）；
 *   - flyline-arc：飞线连接（弧线 draw-on + 沿线流动的光点 + 端点脉冲）；
 *   - orb-flyline-relay：同帧共振组合（三线同时亮，与中心球体一起呼吸）。
 *
 * 契约：render(ctx2d, t, env)；纯函数，任意 seek 一致。
 */

export const meta = {
  title: '光斑与飞线',
  duration: 5.7,
  kind: '几何',
  source: 'shotcraft',
  sourcePath: 'references/shots/effects/glow-flyline-moves.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
};

const DW = 480;
const DH = 270;

const DEFAULTS = {
  orbs: 6,
  lineAt: 1.55,
  lineGap: 0.2,
  lineDur: 0.85,
  relayAt: 3.75,
  background: '#05070c',
  glowA: '#2f7bff',
  glowB: '#8b5cff',
  glowC: '#25d8c0',
  ink: '#dfe9ff',
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const num = (v, def, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
};
const outCubic = (x) => 1 - Math.pow(1 - x, 3);

/** 固定伪随机（不读 Math.random，保证同 t 同画面）。 */
function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const NODES = [
  { x: 96, y: 192 },
  { x: 386, y: 84 },
  { x: 84, y: 92 },
  { x: 392, y: 190 },
  { x: 240, y: 224 },
  { x: 240, y: 52 },
];

const LINES = [
  { a: 0, b: 1, ctrl: { x: 200, y: 96 }, color: 'glowA' },
  { a: 2, b: 3, ctrl: { x: 268, y: 182 }, color: 'glowB' },
  { a: 4, b: 5, ctrl: { x: 296, y: 138 }, color: 'glowC' },
];

function quadAt(a, c, b, u) {
  const v = 1 - u;
  return {
    x: v * v * a.x + 2 * v * u * c.x + u * u * b.x,
    y: v * v * a.y + 2 * v * u * c.y + u * u * b.y,
  };
}

export function render(ctx, t, env) {
  const w = Math.max(1, Math.round(Number(env && env.width) || DW));
  const h = Math.max(1, Math.round(Number(env && env.height) || DH));
  const props = (env && env.props) || {};
  const cfg = {
    orbs: Math.round(num(props.orbs, DEFAULTS.orbs, 1, 16)),
    lineAt: num(props.lineAt, DEFAULTS.lineAt, 0, 5),
    lineGap: num(props.lineGap, DEFAULTS.lineGap, 0, 1),
    lineDur: num(props.lineDur, DEFAULTS.lineDur, 0.2, 2.5),
    relayAt: num(props.relayAt, DEFAULTS.relayAt, 0, 9),
    background: props.background || DEFAULTS.background,
    glowA: props.glowA || DEFAULTS.glowA,
    glowB: props.glowB || DEFAULTS.glowB,
    glowC: props.glowC || DEFAULTS.glowC,
    ink: props.ink || DEFAULTS.ink,
  };

  const duration = num(env && env.duration, meta.duration, 0.6, 120);
  const tt = Math.min(duration, Math.max(0, Number.isFinite(Number(t)) ? Number(t) : 0));

  const s = Math.min(w / DW, h / DH);
  const ox = (w - DW * s) / 2;
  const oy = (h - DH * s) / 2;

  ctx.save();
  ctx.fillStyle = cfg.background;
  ctx.fillRect(0, 0, w, h);

  ctx.translate(ox, oy);
  ctx.scale(s, s);

  // ① 光斑底噪：径向渐变圆，缓慢漂移
  const orbColors = [cfg.glowA, cfg.glowB, cfg.glowC];
  for (let i = 0; i < cfg.orbs; i += 1) {
    const rnd = hash(i + 1);
    const rnd2 = hash(i + 31);
    const baseX = 30 + rnd * (DW - 60);
    const baseY = 24 + rnd2 * (DH - 48);
    const drift = 10 + rnd * 14;
    const cx = baseX + Math.sin(tt * (0.32 + rnd * 0.2) + i) * drift;
    const cy = baseY + Math.cos(tt * (0.26 + rnd2 * 0.2) + i * 1.7) * drift * 0.7;
    const radius = 42 + rnd * 66;
    const color = orbColors[i % orbColors.length];
    const alpha = 0.13 + rnd2 * 0.12;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(5,7,12,0)');
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 星点（弱，给暗场一点颗粒）
  for (let i = 0; i < 46; i += 1) {
    const x = hash(i * 3 + 7) * DW;
    const y = hash(i * 3 + 11) * DH;
    const a = 0.08 + hash(i + 5) * 0.16;
    ctx.fillStyle = `rgba(210,225,255,${a})`;
    ctx.fillRect(x, y, 0.9, 0.9);
  }

  // ② 飞线：draw-on + 流动光点 + 端点脉冲
  const relay = clamp01((tt - cfg.relayAt) / 0.5);
  for (let i = 0; i < LINES.length; i += 1) {
    const ln = LINES[i];
    const a = NODES[ln.a];
    const b = NODES[ln.b];
    const color = cfg[ln.color];
    const at = cfg.lineAt + i * cfg.lineGap;
    const p = clamp01((tt - at) / cfg.lineDur);
    if (p <= 0) continue;
    const reveal = outCubic(p);

    // 弧线本体（用 dash 做 draw-on，长度按 48 段近似）
    let len = 0;
    let prev = a;
    for (let k = 1; k <= 48; k += 1) {
      const pt = quadAt(a, ln.ctrl, b, k / 48);
      len += Math.hypot(pt.x - prev.x, pt.y - prev.y);
      prev = pt;
    }
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.26 + 0.34 * relay;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(ln.ctrl.x, ln.ctrl.y, b.x, b.y);
    ctx.setLineDash([len, len]);
    ctx.lineDashOffset = len * (1 - reveal);
    ctx.stroke();
    ctx.restore();

    // 流动光点
    if (reveal > 0.02) {
      const flow = (tt * 0.42 + i * 0.31) % 1;
      const u = flow * reveal;
      const pt = quadAt(a, ln.ctrl, b, u);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.4, 0, Math.PI * 2);
      ctx.fill();
      // 光点外的柔光（3 层递减，不是 blur）
      for (let k = 1; k <= 3; k += 1) {
        ctx.globalAlpha = 0.16 / k;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 2.4 + k * 4.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // 拖尾
      const back = quadAt(a, ln.ctrl, b, Math.max(0, u - 0.05));
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(back.x, back.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 端点：a 端小圆，b 端脉冲环
    const pulse = 0.5 + 0.5 * Math.sin(tt * 4.4 + i * 2.1);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.35 + 0.3 * pulse;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 5 + pulse * 2.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ③ 共振：中心球体（圆 + 两条经纬椭圆 + 呼吸环）
  if (relay > 0) {
    const cx = DW / 2;
    const cy = DH / 2;
    const pulse = 0.5 + 0.5 * Math.sin(tt * 3.4);
    const r = 30 + pulse * 1.6;
    ctx.globalAlpha = relay * 0.85;
    const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
    g.addColorStop(0, 'rgba(96,168,255,0.55)');
    g.addColorStop(0.7, 'rgba(60,70,160,0.2)');
    g.addColorStop(1, 'rgba(5,7,12,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(180,215,255,0.55)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.82, 0, Math.PI * 2);
    ctx.stroke();
    // 经线（两条椭圆）
    for (const k of [0.42, 0.78]) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, r * 0.82 * k, r * 0.82, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 0.82, r * 0.82 * 0.42, 0, 0, Math.PI * 2);
    ctx.stroke();

    // 呼吸环
    for (let k = 0; k < 2; k += 1) {
      const rp = (tt * 0.5 + k * 0.5) % 1;
      ctx.globalAlpha = relay * (1 - rp) * 0.4;
      ctx.strokeStyle = cfg.glowC;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.9 + rp * 56, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // 右下角小注：三式名（伽位信息，不是调试）
  ctx.fillStyle = 'rgba(200,215,240,0.34)';
  ctx.font = '8px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  const stageName = tt < cfg.lineAt ? 'ORB-AMBIENT' : tt < cfg.relayAt ? 'FLYLINE-ARC' : 'RELAY';
  ctx.fillText(stageName, DW - 14, DH - 12);

  ctx.restore();
}
