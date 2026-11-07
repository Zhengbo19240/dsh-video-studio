/**
 * sc-trailer-grammar-moves · 预告片语法（人工重写版）
 *
 * 配方来源：video-shotcraft / references/shots/rhythm/trailer-grammar-moves.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡为 Remotion 的 Sequence 速剪；这里用 Canvas2D 的离散镜号 + 黑场 + 标题冲量重写。
 *
 * 配方要点（照卡文）：
 *   - trailer-bumper：三镜 9 帧速剪（每镜 0.3s @30fps），每镜自带一点运动；
 *   - 黑场静默一拍（0.25s）——这一拍是留给观众的"吸气"；
 *   - 再开场标题，落定后不再动。
 *
 * 契约：render(ctx2d, t, env)；纯函数，任意 seek 一致。
 */

export const meta = {
  title: '预告片语法',
  duration: 4.7,
  kind: '几何',
  source: 'shotcraft',
  sourcePath: 'references/shots/rhythm/trailer-grammar-moves.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
};

const DW = 480;
const DH = 270;

const DEFAULTS = {
  shotDur: 0.3,
  blackDur: 0.25,
  titleIn: 0.42,
  fps: 30,
  background: '#08090d',
  paper: '#f2efe7',
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, p) => a + (b - a) * p;
const num = (v, def, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
};
const outCubic = (x) => 1 - Math.pow(1 - x, 3);
const outExpo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
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

/** 三镜：各用自己的构图与底色，镜内自带 0.3s 的微运动。 */
function paintShot(ctx, index, p, cfg) {
  const palettes = [
    { bg: '#e2542c', fg: '#141414', mark: '#f2efe7' },
    { bg: '#1b3a5c', fg: '#e8edf5', mark: '#f2c14e' },
    { bg: '#f2c14e', fg: '#141414', mark: '#1b3a5c' },
  ];
  const pal = palettes[index % 3];
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, DW, DH);

  // 镜内微运动：缓慢推入 + 元素位移（速剪里也有动，不然像三张静态图）
  const zoom = 1.06 - 0.06 * outCubic(p);
  ctx.save();
  ctx.translate(DW / 2, DH / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-DW / 2, -DH / 2);

  if (index === 0) {
    ctx.fillStyle = pal.mark;
    ctx.beginPath();
    ctx.arc(DW * 0.62, DH * 0.46, 62, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = pal.fg;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(DW * 0.62, DH * 0.46, 40, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = pal.fg;
    for (let i = 0; i < 4; i += 1) {
      ctx.fillRect(40, 52 + i * 22 + p * 8, 84 - i * 12, 4);
    }
  } else if (index === 1) {
    for (let i = 0; i < 7; i += 1) {
      const x = 48 + i * 56;
      const hgt = 90 + ((i * 37) % 110);
      ctx.fillStyle = i % 2 === 0 ? 'rgba(232,237,245,0.16)' : 'rgba(242,193,78,0.5)';
      ctx.fillRect(x + p * 10, DH - 46 - hgt, 34, hgt);
    }
    ctx.fillStyle = pal.fg;
    ctx.fillRect(0, DH - 46, DW, 3);
  } else {
    ctx.fillStyle = pal.mark;
    ctx.beginPath();
    ctx.moveTo(DW * 0.5, DH * 0.18);
    ctx.lineTo(DW * 0.5 + 96, DH * 0.82);
    ctx.lineTo(DW * 0.5 - 96, DH * 0.82);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = pal.fg;
    ctx.lineWidth = 1;
    for (let i = 0; i < 9; i += 1) {
      ctx.beginPath();
      ctx.moveTo(0, 18 + i * 30 + p * 6);
      ctx.lineTo(DW, 18 + i * 30 + p * 6);
      ctx.stroke();
    }
  }
  ctx.restore();

  // 胶片孔（每镜都在，读作"这是一卷片子"）
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  for (let i = 0; i < 6; i += 1) {
    roundRect(ctx, 8, 12 + i * 44, 10, 22, 3);
    ctx.fill();
    roundRect(ctx, DW - 18, 12 + i * 44, 10, 22, 3);
    ctx.fill();
  }

  // 镜号 / 帧号
  ctx.fillStyle = index === 2 ? 'rgba(20,20,20,0.7)' : 'rgba(242,239,231,0.8)';
  ctx.font = '9px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`TK ${String(index + 1).padStart(2, '0')} / 03`, 28, 16);
}

export function render(ctx, t, env) {
  const w = Math.max(1, Math.round(Number(env && env.width) || DW));
  const h = Math.max(1, Math.round(Number(env && env.height) || DH));
  const props = (env && env.props) || {};
  const cfg = {
    shotDur: num(props.shotDur, DEFAULTS.shotDur, 0.06, 1.5),
    blackDur: num(props.blackDur, DEFAULTS.blackDur, 0, 1.5),
    titleIn: num(props.titleIn, DEFAULTS.titleIn, 0.15, 2),
    fps: Math.round(num(props.fps, DEFAULTS.fps, 12, 60)),
    background: props.background || DEFAULTS.background,
    paper: props.paper || DEFAULTS.paper,
  };

  const duration = num(env && env.duration, meta.duration, 0.8, 120);
  const tt = Math.min(duration, Math.max(0, Number.isFinite(Number(t)) ? Number(t) : 0));

  const s = Math.min(w / DW, h / DH);
  const ox = (w - DW * s) / 2;
  const oy = (h - DH * s) / 2;

  const shotsEnd = cfg.shotDur * 3;
  const blackEnd = shotsEnd + cfg.blackDur;
  const titleAt = blackEnd;

  ctx.save();
  ctx.fillStyle = cfg.background;
  ctx.fillRect(0, 0, w, h);

  ctx.translate(ox, oy);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.rect(0, 0, DW, DH);
  ctx.clip();

  if (tt < shotsEnd) {
    // ① 三镜速剪（离散，不插值）
    const idx = Math.min(2, Math.floor(tt / cfg.shotDur + 1e-6));
    const p = clamp01((tt - idx * cfg.shotDur) / cfg.shotDur);
    paintShot(ctx, idx, p, cfg);

    // 每镜末尾 1 帧的白闪（速剪的"咔"）
    const tailP = clamp01((p - 0.82) / 0.18);
    if (tailP > 0) {
      ctx.fillStyle = `rgba(255,255,255,${tailP * 0.5})`;
      ctx.fillRect(0, 0, DW, DH);
    }

    // 帧号
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '8px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`F ${String(Math.round(tt * cfg.fps)).padStart(3, '0')}`, DW - 28, 16);
  } else if (tt < titleAt) {
    // ② 黑场静默一拍：只留胶片孔在暗处微微闪
    ctx.fillStyle = '#06070a';
    ctx.fillRect(0, 0, DW, DH);
    const holeP = 0.04 + 0.03 * Math.sin(tt * 26);
    ctx.fillStyle = `rgba(242,239,231,${holeP})`;
    for (let i = 0; i < 6; i += 1) {
      roundRect(ctx, 8, 12 + i * 44, 10, 22, 3);
      ctx.fill();
      roundRect(ctx, DW - 18, 12 + i * 44, 10, 22, 3);
      ctx.fill();
    }
  } else {
    // ③ 开场标题：冲量落定后不再动
    const tp = clamp01((tt - titleAt) / cfg.titleIn);
    const scale = lerp(1.42, 1, backOut(2.1)(tp));
    ctx.fillStyle = '#06070a';
    ctx.fillRect(0, 0, DW, DH);

    // 中心微光（渐变，不是 blur）
    const g = ctx.createRadialGradient(DW / 2, DH * 0.46, 10, DW / 2, DH * 0.46, 220);
    g.addColorStop(0, 'rgba(242,193,78,0.1)');
    g.addColorStop(1, 'rgba(6,7,10,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, DW, DH);

    ctx.save();
    ctx.translate(DW / 2, DH * 0.46);
    ctx.scale(scale, scale);
    ctx.translate(-DW / 2, -DH * 0.46);
    ctx.globalAlpha = clamp01(tp * 1.6);

    ctx.fillStyle = cfg.paper;
    ctx.font = '700 52px system-ui, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('即 将 开 始', DW / 2, DH * 0.44);

    // 标题左右的横线（随 scale 一起落定）
    ctx.fillStyle = 'rgba(242,193,78,0.85)';
    ctx.fillRect(DW / 2 - 116, DH * 0.44 + 38, 72, 2);
    ctx.fillRect(DW / 2 + 44, DH * 0.44 + 38, 72, 2);
    ctx.restore();

    // 副标（落定后才出现）
    const subP = clamp01((tt - titleAt - cfg.titleIn * 0.8) / 0.4);
    if (subP > 0) {
      ctx.globalAlpha = subP;
      ctx.fillStyle = 'rgba(242,239,231,0.55)';
      ctx.font = '600 10px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('A FILM BY AGENT — COMING SOON', DW / 2, DH * 0.44 + 58);
      ctx.globalAlpha = 1;
    }

    // 顶部/底部细线（海报边）
    ctx.fillStyle = 'rgba(242,239,231,0.1)';
    ctx.fillRect(0, 18, DW, 1);
    ctx.fillRect(0, DH - 18, DW, 1);
  }

  ctx.restore();
}
