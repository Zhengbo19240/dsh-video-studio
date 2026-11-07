/**
 * sc-mosaic-reframe · 瓦片重排（人工重写版）
 *
 * 配方来源：video-shotcraft / references/shots/transition/mosaic-reframe.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡为 Remotion/DOM 的 CSS grid → mosaic 变形；这里用 Canvas2D 把三种排版
 *           写成三组 rect，位置/宽高各自插值，逐片错峰，段间留 hold。
 *
 * 配方要点（照卡文）：
 *   - 12 张瓦片在规则网格、feature mosaic、对角瀑布串三种排版间连续变形；
 *   - 位置与宽高各自插值（不是整体 scale），所以瓦片是"长"成新形状；
 *   - 逐片微错峰，段间留 hold —— hold 是让人看清排版的那一拍。
 *
 * 契约：render(ctx2d, t, env)；纯函数，任意 seek 一致。
 */

export const meta = {
  title: '瓦片重排',
  duration: 7.13,
  kind: '转场',
  source: 'shotcraft',
  sourcePath: 'references/shots/transition/mosaic-reframe.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
};

const DW = 480;
const DH = 270;
const TILES = 12;

const DEFAULTS = {
  morphDur: 1.15,
  stagger: 0.045,
  holdDur: 0.55,
  background: '#0d0f14',
  ink: '#f2f4f8',
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, p) => a + (b - a) * p;
const num = (v, def, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
};
const inOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const outCubic = (x) => 1 - Math.pow(1 - x, 3);

const PALETTE = [
  ['#1c2b45', '#3f6fa8'], ['#3a1f2a', '#b5533f'], ['#1f3330', '#3f8c78'],
  ['#2b2440', '#7059b8'], ['#3a2f18', '#b08a3f'], ['#1e2c3a', '#4a8bb0'],
  ['#331f2e', '#a34d7c'], ['#233019', '#6f9a45'], ['#2d2a2f', '#8b8794'],
  ['#1a2536', '#557fa8'], ['#33261c', '#a86a3f'], ['#1f2a2c', '#4f8f91'],
];

function layoutGrid() {
  const out = [];
  const cols = 4;
  const gap = 8;
  const cw = (DW - gap * (cols + 1)) / cols;
  const rows = 3;
  const ch = (DH - gap * (rows + 1)) / rows;
  for (let i = 0; i < TILES; i += 1) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push({ x: gap + c * (cw + gap), y: gap + r * (ch + gap), w: cw, h: ch, r: 5 });
  }
  return out;
}

function layoutFeature() {
  const out = [];
  // 左上大块
  out.push({ x: 10, y: 10, w: 204, h: 160, r: 7 });
  // 右列 4 条
  for (let i = 0; i < 4; i += 1) out.push({ x: 222, y: 10 + i * 41.5, w: 112, h: 36, r: 4 });
  // 右上宽块
  out.push({ x: 342, y: 10, w: 128, h: 160, r: 7 });
  // 底部 6 块
  const bw = (DW - 20 - 5 * 6) / 6;
  for (let i = 0; i < 6; i += 1) out.push({ x: 10 + i * (bw + 6), y: 178, w: bw, h: 82, r: 4 });
  return out;
}

function layoutWaterfall() {
  const out = [];
  for (let i = 0; i < TILES; i += 1) {
    out.push({
      x: 10 + i * 30,
      y: 8 + i * 18.4,
      w: 98,
      h: 52,
      r: 5,
    });
  }
  return out;
}

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

/** 每片瓦片自己的"图像"：渐变底 + 一个几何母题，构图随索引变。 */
function paintTile(ctx, i, x, y, w, h, r, visible) {
  if (!visible || w < 2 || h < 2) return;
  const pair = PALETTE[i % PALETTE.length];
  ctx.save();
  ctx.beginPath();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();

  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, pair[0]);
  g.addColorStop(1, pair[1]);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);

  const cx = x + w / 2;
  const cy = y + h / 2;
  const m = Math.min(w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.34)';
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = Math.max(1, m * 0.02);

  if (i % 3 === 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, m * 0.24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, m * 0.1, 0, Math.PI * 2);
    ctx.fill();
  } else if (i % 3 === 1) {
    for (let k = 0; k < 3; k += 1) {
      ctx.fillRect(x + w * 0.18, y + h * (0.28 + k * 0.18), w * (0.64 - k * 0.12), Math.max(1.4, h * 0.035));
    }
  } else {
    ctx.beginPath();
    ctx.moveTo(x + w * 0.16, y + h * 0.76);
    ctx.lineTo(x + w * 0.5, y + h * 0.24);
    ctx.lineTo(x + w * 0.84, y + h * 0.76);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + w * 0.5, y + h * 0.58, m * 0.07, 0, Math.PI * 2);
    ctx.fill();
  }

  // 角标序号
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = `${Math.max(6, Math.round(m * 0.1))}px ui-monospace, Consolas, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(String(i + 1).padStart(2, '0'), x + Math.max(3, m * 0.07), y + Math.max(3, m * 0.07));
  ctx.restore();
}

export function render(ctx, t, env) {
  const w = Math.max(1, Math.round(Number(env && env.width) || DW));
  const h = Math.max(1, Math.round(Number(env && env.height) || DH));
  const props = (env && env.props) || {};
  const cfg = {
    morphDur: num(props.morphDur, DEFAULTS.morphDur, 0.2, 3),
    stagger: num(props.stagger, DEFAULTS.stagger, 0, 0.3),
    holdDur: num(props.holdDur, DEFAULTS.holdDur, 0, 3),
    background: props.background || DEFAULTS.background,
  };

  const duration = num(env && env.duration, meta.duration, 1.2, 120);
  const tt = Math.min(duration, Math.max(0, Number.isFinite(Number(t)) ? Number(t) : 0));

  const s = Math.min(w / DW, h / DH);
  const ox = (w - DW * s) / 2;
  const oy = (h - DH * s) / 2;

  ctx.save();
  ctx.fillStyle = cfg.background;
  ctx.fillRect(0, 0, w, h);

  ctx.translate(ox, oy);
  ctx.scale(s, s);

  const layouts = [layoutGrid(), layoutFeature(), layoutWaterfall()];

  // 三段变形：入场 → 网格→mosaic → mosaic→瀑布 → 收尾 hold
  const introDur = 0.45;
  const seg1Start = introDur + cfg.holdDur;
  const seg2Start = introDur + cfg.holdDur * 2 + cfg.morphDur;

  function tileRect(i, tNow) {
    const g = layouts[0][i];
    const f = layouts[1][i];
    const wf = layouts[2][i];
    let a = layouts[0][i];
    let b = layouts[0][i];
    let p = 0;
    const at1 = seg1Start + i * cfg.stagger;
    const at2 = seg2Start + i * cfg.stagger;
    if (tNow <= at1) {
      a = g;
      b = g;
      p = 0;
    } else if (tNow < at1 + cfg.morphDur) {
      a = g;
      b = f;
      p = inOutCubic((tNow - at1) / cfg.morphDur);
    } else if (tNow <= at2) {
      a = f;
      b = f;
      p = 0;
    } else if (tNow < at2 + cfg.morphDur) {
      a = f;
      b = wf;
      p = inOutCubic((tNow - at2) / cfg.morphDur);
    } else {
      a = wf;
      b = wf;
      p = 0;
    }
    return {
      x: lerp(a.x, b.x, p),
      y: lerp(a.y, b.y, p),
      w: lerp(a.w, b.w, p),
      h: lerp(a.h, b.h, p),
      r: lerp(a.r, b.r, p),
    };
  }

  // 入场：每片从中心弹出。首帧必须已经有画面 —— 所以从 0.34 起步，
  // 不是从 0 长起来（否则 t=0 是一张空画布，读作"没渲染"）。
  for (let i = 0; i < TILES; i += 1) {
    const staggerP = clamp01((tt - i * 0.018) / (introDur + 0.1));
    const rect = tileRect(i, tt);
    const grow = 0.34 + 0.66 * outCubic(staggerP);
    if (grow <= 0.001) continue;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const gw = rect.w * grow;
    const gh = rect.h * grow;
    const gx = cx - gw / 2;
    const gy = cy - gh / 2;
    paintTile(ctx, i, gx, gy, gw, gh, Math.min(rect.r, gh / 2, gw / 2), true);
  }

  // 段标识（底部三段进度）
  const segs = [
    { at: 0, name: 'GRID' },
    { at: seg1Start, name: 'MOSAIC' },
    { at: seg2Start, name: 'WATERFALL' },
  ];
  let active = 0;
  for (let i = 0; i < segs.length; i += 1) if (tt >= segs[i].at) active = i;
  ctx.font = '8px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  for (let i = 0; i < segs.length; i += 1) {
    const x = DW - 12 - (segs.length - 1 - i) * 42;
    ctx.fillStyle = i === active ? 'rgba(242,244,248,0.72)' : 'rgba(242,244,248,0.2)';
    ctx.fillText(segs[i].name, x, DH - 8);
    if (i === active) {
      ctx.fillStyle = 'rgba(242,244,248,0.5)';
      ctx.fillRect(x - 40, DH - 7, 4, 1.6);
    }
  }

  ctx.restore();
}
