/**
 * sc-bottom-push-stack-wipe · 底边上推换章（人工重写版）
 *
 * 配方来源：video-shotcraft / references/shots/transition/bottom-push-stack-wipe.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡为 Remotion/DOM 多层堆叠；这里用 Canvas2D 逐层裁切 + 位移重写。
 *
 * 配方要点（照卡文）：
 *   - 新场景连底色整屏从底边向上推入，把旧场景物理顶出画外；
 *   - 连推数章，各配一种饱和底色；
 *   - 内容钉死在各自色底坐标系里，随底色一起走 —— 所以内容永远"长"在自己的底色上。
 *
 * 契约：render(ctx2d, t, env)；纯函数，任意 seek 一致。
 */

export const meta = {
  title: '底边上推换章',
  duration: 5.7,
  kind: '转场',
  source: 'shotcraft',
  sourcePath: 'references/shots/transition/bottom-push-stack-wipe.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
};

const DW = 480;
const DH = 270;

const DEFAULTS = {
  pushDur: 1.05,
  hold: 1.15,
  ease: 'inOut',
  colors: ['#16233d', '#e2542c', '#f1ece1'],
  labels: ['01 · 起点', '02 · 转折', '03 · 落点'],
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const num = (v, def, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
};
const inOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const outCubic = (x) => 1 - Math.pow(1 - x, 3);

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

/** 每章的内容：钉在自己的底色坐标系里（单位是设计坐标，整块随底色上移）。 */
function paintChapter(ctx, index, cfg, progress) {
  const color = cfg.colors[index % cfg.colors.length];
  const light = index === 2;
  const ink = light ? '#1b2230' : '#f4f1e8';
  const accent = light ? '#e2542c' : '#f4c26b';

  ctx.fillStyle = color;
  ctx.fillRect(0, 0, DW, DH);

  // 底色肌理：斜向细条，随章节换密度
  ctx.strokeStyle = light ? 'rgba(27,34,48,0.06)' : 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = -DH; i < DW; i += 18) {
    ctx.moveTo(i, 0);
    ctx.lineTo(i + DH * 0.35, DH);
  }
  ctx.stroke();

  // 章节号（大数字，压在左侧）
  ctx.fillStyle = light ? 'rgba(27,34,48,0.12)' : 'rgba(255,255,255,0.1)';
  ctx.font = '700 148px system-ui, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(String(index + 1), 26, 196);

  // 主体几何：随章节改变构成
  const cx = 292;
  const cy = 128;
  if (index === 0) {
    // 双环 + 地平线
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(cx, cy, 52, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy, 34, Math.PI * 0.15, Math.PI * 0.9);
    ctx.stroke();
    ctx.fillStyle = 'rgba(244,241,232,0.22)';
    ctx.fillRect(196, 208, 250, 2);
  } else if (index === 1) {
    // 上升阶梯
    ctx.fillStyle = ink;
    for (let i = 0; i < 4; i += 1) {
      const bw = 30;
      const bh = 26 + i * 22;
      roundRect(ctx, 216 + i * 42, 196 - bh, bw, bh, 4);
      ctx.fill();
    }
    ctx.fillStyle = accent;
    roundRect(ctx, 216 + 3 * 42, 196 - (26 + 3 * 22) - 8, 30, 8, 3);
    ctx.fill();
  } else {
    // 落点：同心扩散 + 一条锚线
    ctx.strokeStyle = 'rgba(27,34,48,0.5)';
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 3; i += 1) {
      ctx.beginPath();
      ctx.arc(cx, cy, 26 + i * 20, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(cx, cy, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(27,34,48,0.55)';
    ctx.fillRect(cx, cy + 62, 1.6, 34);
  }

  // 章节标签条
  ctx.fillStyle = light ? 'rgba(27,34,48,0.9)' : 'rgba(0,0,0,0.32)';
  roundRect(ctx, 26, 232, 132, 24, 12);
  ctx.fill();
  ctx.fillStyle = light ? '#f1ece1' : '#f4f1e8';
  ctx.font = '600 11px system-ui, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(cfg.labels[index % cfg.labels.length], 26 + 66, 244);

  // 顶边压条：告诉眼睛"这层正在上移"
  ctx.fillStyle = light ? 'rgba(27,34,48,0.14)' : 'rgba(255,255,255,0.16)';
  ctx.fillRect(0, 0, DW, 2);
}

export function render(ctx, t, env) {
  const w = Math.max(1, Math.round(Number(env && env.width) || DW));
  const h = Math.max(1, Math.round(Number(env && env.height) || DH));
  const props = (env && env.props) || {};
  const cfg = {
    pushDur: num(props.pushDur, DEFAULTS.pushDur, 0.2, 4),
    hold: num(props.hold, DEFAULTS.hold, 0, 6),
    colors: Array.isArray(props.colors) && props.colors.length >= 2 ? props.colors : DEFAULTS.colors,
    labels: Array.isArray(props.labels) && props.labels.length >= 2 ? props.labels : DEFAULTS.labels,
  };

  const duration = num(env && env.duration, meta.duration, 0.6, 120);
  const tt = Math.min(duration, Math.max(0, Number.isFinite(Number(t)) ? Number(t) : 0));

  const chapters = 3;
  const tail = Math.max(0.4, Math.min(cfg.hold, duration * 0.35));
  const usable = Math.max(0.6, duration - tail - cfg.pushDur * (chapters - 1));
  const gap = usable / (chapters - 1 || 1);

  const s = Math.min(w / DW, h / DH);
  const ox = (w - DW * s) / 2;
  const oy = (h - DH * s) / 2;

  ctx.save();
  ctx.fillStyle = cfg.colors[0] || '#16233d';
  ctx.fillRect(0, 0, w, h);

  ctx.translate(ox, oy);
  ctx.scale(s, s);

  // 从最底下的章开始画，后面的章上推覆盖前面的章
  for (let i = 0; i < chapters; i += 1) {
    let offsetY = 0;
    if (i > 0) {
      const at = gap * (i - 1) + cfg.pushDur * (i - 1);
      const p = clamp01((tt - at) / cfg.pushDur);
      if (p <= 0) break; // 还没轮到它，且它上面的章全都没进来
      offsetY = DH * (1 - inOutCubic(p));
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, DW, DH);
    ctx.clip();

    ctx.save();
    ctx.translate(0, offsetY);
    paintChapter(ctx, i, cfg, offsetY / DH);
    ctx.restore();

    // 推进时顶边的高光边（读作"这一层的厚度"）
    if (offsetY > 0.5) {
      const shine = ctx.createLinearGradient(0, offsetY - 3, 0, offsetY + 10);
      shine.addColorStop(0, 'rgba(255,255,255,0.42)');
      shine.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = shine;
      ctx.fillRect(0, offsetY - 3, DW, 13);
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(0, offsetY + 10, DW, 2);
    }

    ctx.restore();
  }

  // 右下角章节进度：三格点
  const dotsX = DW - 22;
  const dotsY = DH - 20;
  for (let i = 0; i < chapters; i += 1) {
    const at = i === 0 ? 0 : gap * (i - 1) + cfg.pushDur * (i - 1);
    const on = tt >= at && (i === chapters - 1 || tt < gap * i + cfg.pushDur * i);
    ctx.fillStyle = on ? '#f4f1e8' : 'rgba(244,241,232,0.3)';
    ctx.beginPath();
    ctx.arc(dotsX - (chapters - 1 - i) * 9, dotsY, on ? 2.6 : 1.9, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}
