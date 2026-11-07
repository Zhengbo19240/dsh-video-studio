/**
 * sc-print-texture-transitions · 墨渗揭示（人工重写版）
 *
 * 配方来源：video-shotcraft / references/shots/transition/print-texture-transitions.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡为 Remotion/DOM + SVG filter 的墨渗；这里用 Canvas2D 的多瓣 irregular blob 重写，
 *           渗边靠"半径高频扰动"做出来（不靠 blur），所以每帧只有几次 path 填充。
 *
 * 配方要点（照卡文）：
 *   - ink-bleed-reveal：墨从落点洇开，须状渗边一点点吃掉旧景；
 *   - 新景在被墨吃掉的地方浮现（墨即遮罩）；
 *   - 干边比湿边深 —— 墨缘一圈更黑的描边。
 *
 * 这是单图层内的过场：旧景与新景同画布，墨形状既遮旧景也露新景。
 *
 * 契约：render(ctx2d, t, env)；纯函数，任意 seek 一致。
 */

export const meta = {
  title: '墨渗揭示',
  duration: 4.5,
  kind: '转场',
  source: 'shotcraft',
  sourcePath: 'references/shots/transition/print-texture-transitions.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
};

const DW = 480;
const DH = 270;

const DEFAULTS = {
  inkAt: 0.22,
  bleedDur: 1.9,
  seeds: 3,
  background: '#0b0a09',
  ink: '#120e0b',
  inkDeep: '#070504',
  paper: '#e8dfcc',
  accent: '#c8452a',
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const num = (v, def, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
};
const outCubic = (x) => 1 - Math.pow(1 - x, 3);
const inOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** 旧景：印刷品（网点 + 大字 + 色带），墨正要吃掉它。 */
function paintOld(ctx, cfg) {
  ctx.fillStyle = cfg.paper;
  ctx.fillRect(0, 0, DW, DH);

  // 网点（错位双色，读作印刷）
  for (let y = 6; y < DH; y += 9) {
    for (let x = 6; x < DW; x += 9) {
      const off = (Math.floor(y / 9) % 2) * 4.5;
      const a = 0.05 + hash(x * 0.7 + y) * 0.05;
      ctx.fillStyle = `rgba(30,24,18,${a})`;
      ctx.beginPath();
      ctx.arc(x + off, y, 1.25, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 大字（吃水线会压过它）
  ctx.fillStyle = 'rgba(30,24,18,0.86)';
  ctx.font = '700 56px system-ui, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('印刷', 44, 118);
  ctx.font = '700 46px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillText('质感', 44, 176);

  // 红色色带
  ctx.fillStyle = cfg.accent;
  ctx.fillRect(0, 208, DW, 16);
  ctx.fillStyle = 'rgba(30,24,18,0.7)';
  ctx.fillRect(0, 232, DW, 2);

  // 边框
  ctx.strokeStyle = 'rgba(30,24,18,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(14, 14, DW - 28, DH - 28);
}

/** 新景：暗底 + 金色标题，墨吃掉旧景后才看得见。 */
function paintNew(ctx, cfg) {
  ctx.fillStyle = '#12100d';
  ctx.fillRect(0, 0, DW, DH);

  // 暖光晕（渐变，不是 blur）
  const g = ctx.createRadialGradient(DW * 0.62, DH * 0.42, 8, DW * 0.62, DH * 0.42, 190);
  g.addColorStop(0, 'rgba(200,69,42,0.28)');
  g.addColorStop(1, 'rgba(18,16,13,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, DW, DH);

  ctx.fillStyle = '#f3e7cf';
  ctx.font = '700 34px system-ui, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('墨之下', 300, 126);

  ctx.fillStyle = 'rgba(243,231,207,0.55)';
  ctx.font = '600 9px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillText('UNDER THE INK', 302, 146);

  ctx.fillStyle = cfg.accent;
  ctx.fillRect(302, 160, 62, 2.4);
  ctx.fillStyle = 'rgba(243,231,207,0.3)';
  ctx.fillRect(302, 168, 34, 2.4);
}

/**
 * 一片墨瓣：48 段，半径带两层高频扰动 → 须状渗边。
 * 返回用于裁剪的 path（不 fill），调用方决定 fill 还是 clip。
 */
function inkPath(ctx, cx, cy, radius, seed, wobble, tNow, append) {
  const segs = 64;
  // 扰动必须"低频大、高频小"：主频给有机形状，高频只给一点点毛边。
  // （第一版把高低频都放大了，渗边被画成碎玻璃——不是墨。）
  if (!append) ctx.beginPath();
  for (let i = 0; i <= segs; i += 1) {
    const a = (i / segs) * Math.PI * 2;
    const wob = 0.062 * Math.sin(a * 5 + seed * 2.1 + tNow * 1.1) + 0.03 * Math.sin(a * 11 + seed * 5.3 - tNow * 1.5);
    const r = radius * (1 + wob + wobble * 0.02 * Math.sin(a * 3 + seed));
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r * 0.94;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export function render(ctx, t, env) {
  const w = Math.max(1, Math.round(Number(env && env.width) || DW));
  const h = Math.max(1, Math.round(Number(env && env.height) || DH));
  const props = (env && env.props) || {};
  const cfg = {
    inkAt: num(props.inkAt, DEFAULTS.inkAt, 0, 2),
    bleedDur: num(props.bleedDur, DEFAULTS.bleedDur, 0.3, 5),
    seeds: Math.round(num(props.seeds, DEFAULTS.seeds, 1, 6)),
    background: props.background || DEFAULTS.background,
    ink: props.ink || DEFAULTS.ink,
    inkDeep: props.inkDeep || DEFAULTS.inkDeep,
    paper: props.paper || DEFAULTS.paper,
    accent: props.accent || DEFAULTS.accent,
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
  ctx.beginPath();
  ctx.rect(0, 0, DW, DH);
  ctx.clip();

  // 旧景
  paintOld(ctx, cfg);

  const bleedP = clamp01((tt - cfg.inkAt) / cfg.bleedDur);
  const radius = 128 * inOutCubic(bleedP);

  // 主落点 + 两三个卫星瓣（一起洇开，形状才有机）
  const seeds = [];
  seeds.push({ x: DW * 0.56, y: DH * 0.46, k: 1, seed: 1.7 });
  const extra = cfg.seeds;
  for (let i = 0; i < extra; i += 1) {
    const a = (i / extra) * Math.PI * 2 + 0.9;
    seeds.push({
      x: DW * 0.56 + Math.cos(a) * (26 + hash(i + 3) * 58),
      y: DH * 0.46 + Math.sin(a) * (18 + hash(i + 9) * 40),
      k: 0.46 + hash(i + 17) * 0.3,
      seed: i + 3.3,
    });
  }

  // 新景：只在墨的并集里可见
  if (bleedP > 0.001) {
    ctx.save();
    for (let si = 0; si < seeds.length; si += 1) {
      const sd = seeds[si];
      inkPath(ctx, sd.x, sd.y, radius * sd.k, sd.seed, bleedP, tt, si > 0);
    }
    ctx.clip();
    paintNew(ctx, cfg);

    // 墨的"湿"感：半透明墨层压在纸上（让过渡期不是生硬的两张图）
    ctx.globalAlpha = 0.22 * (1 - outCubic(bleedP));
    ctx.fillStyle = cfg.inkDeep;
    ctx.fillRect(0, 0, DW, DH);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // 墨缘：只描主瓣一圈更深的干边（卫星瓣不描 —— 内部线条会读成碎裂）
  if (bleedP > 0.001) {
    const main = seeds[0];
    inkPath(ctx, main.x, main.y, radius * main.k, main.seed, bleedP, tt, false);
    ctx.strokeStyle = 'rgba(7,5,4,0.85)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 落纸瞬间：一滴比主瓣更黑的墨心 + 两个溅点
  const splashP = clamp01((tt - cfg.inkAt) / 0.32);
  if (splashP > 0 && splashP < 1) {
    ctx.globalAlpha = 1 - splashP;
    ctx.fillStyle = cfg.inkDeep;
    ctx.beginPath();
    ctx.arc(DW * 0.56, DH * 0.46, 4 + splashP * 14, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 5; i += 1) {
      const a = i * 1.31;
      const d = 22 + splashP * (46 + i * 9);
      ctx.beginPath();
      ctx.arc(DW * 0.56 + Math.cos(a) * d, DH * 0.46 + Math.sin(a) * d * 0.8, 1.8 * (1 - splashP) + 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // 收尾：右下角一点纸纹与孤立墨点（给静态画面一点"还在发生"的暗示）
  if (tt > cfg.inkAt + cfg.bleedDur) {
    const holdP = clamp01((tt - cfg.inkAt - cfg.bleedDur) / 0.5);
    ctx.globalAlpha = holdP * 0.5;
    ctx.fillStyle = cfg.accent;
    ctx.beginPath();
    ctx.arc(DW - 48, DH - 44, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = holdP * 0.24;
    ctx.beginPath();
    ctx.arc(DW - 48 + 9, DH - 44 + 5, 1.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}
