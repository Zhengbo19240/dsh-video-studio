/**
 * sc-page-turn-transitions · 对开门裂幕（人工重写版）
 *
 * 配方来源：video-shotcraft / references/shots/transition/page-turn-transitions.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡为 Remotion/DOM 的两层 div 裂幕；这里用 Canvas2D 的双半页裁切 + 透视梯形重写，
 *           两个半页各自有转轴缩放与内侧阴影，所以"门"的厚度来自几何不是阴影特效。
 *
 * 配方要点（照卡文）：
 *   - barn-door-split：旧页从中间裂成两半，各自向左右滑出；
 *   - 新页从后方向上"迎"过来（略大 → 落定），不等旧页走完就开始；
 *   - 裂缝是一条亮线：裂开前先亮一下，裂开后线消失。
 *
 * 这是单图层内的过场：旧页与新页都在同一张画布上，不需要前后两镜的宿主。
 *
 * 契约：render(ctx2d, t, env)；纯函数，任意 seek 一致。
 */

export const meta = {
  title: '对开门裂幕',
  duration: 5,
  kind: '转场',
  source: 'shotcraft',
  sourcePath: 'references/shots/transition/page-turn-transitions.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
};

const DW = 480;
const DH = 270;

const DEFAULTS = {
  seamLead: 0.3,
  openDur: 1.25,
  drift: 0.06,
  background: '#0a0b0f',
  accent: '#f2c14e',
  paper: '#efe9dc',
  ink: '#1a1b20',
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

/** 旧页：深色底 + 大号几何 + 一把斜尺，裂纹会从中间劈开它。 */
function paintOldPage(ctx, cfg) {
  ctx.fillStyle = '#14161d';
  ctx.fillRect(0, 0, DW, DH);

  // 斜向粗带
  ctx.save();
  ctx.translate(DW / 2, DH / 2);
  ctx.rotate(-0.32);
  ctx.fillStyle = 'rgba(242,193,78,0.9)';
  ctx.fillRect(-DW * 0.75, -22, DW * 1.5, 44);
  ctx.fillStyle = 'rgba(20,22,29,0.75)';
  ctx.fillRect(-DW * 0.75, 6, DW * 1.5, 10);
  ctx.restore();

  // 大圆
  ctx.strokeStyle = 'rgba(239,233,220,0.28)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(DW / 2, DH / 2, 74, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(DW / 2, DH / 2, 40, 0, Math.PI * 2);
  ctx.stroke();

  // 角标
  ctx.fillStyle = 'rgba(239,233,220,0.4)';
  ctx.font = '9px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('CH.02 / OLD', 16, 14);
  ctx.textAlign = 'right';
  ctx.fillText('SPLIT →', DW - 16, DH - 22);
}

/** 新页：纸底章节页，标题 + 色块 + 细线。 */
function paintNewPage(ctx, cfg, settle, tt) {
  ctx.fillStyle = cfg.paper;
  ctx.fillRect(0, 0, DW, DH);

  // 左侧色块（落定时从左推进）
  const barP = outCubic(clamp01((settle - 0.25) / 0.55));
  ctx.fillStyle = cfg.accent;
  ctx.fillRect(0, 0, DW * 0.055 * barP, DH);

  // 细网格
  ctx.strokeStyle = 'rgba(26,27,32,0.07)';
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let y = 40; y < DH; y += 26) {
    ctx.moveTo(52, y);
    ctx.lineTo(DW - 40, y);
  }
  ctx.stroke();

  const appear = outCubic(clamp01((settle - 0.15) / 0.6));
  ctx.globalAlpha = appear;

  ctx.fillStyle = cfg.ink;
  ctx.font = '700 42px system-ui, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('新的一章', 56, 124);

  ctx.font = '600 13px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillStyle = 'rgba(26,27,32,0.6)';
  ctx.fillText('CHAPTER 03 / 接着往下讲', 58, 152);

  // 三条短横线（读作目录）
  for (let i = 0; i < 3; i += 1) {
    const wpx = 120 - i * 26;
    ctx.fillStyle = i === 0 ? cfg.accent : 'rgba(26,27,32,0.28)';
    ctx.fillRect(58, 178 + i * 15, wpx, i === 0 ? 4 : 2);
  }

  // 右下角圆章
  ctx.strokeStyle = 'rgba(26,27,32,0.22)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(DW - 74, DH - 66, 30, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(DW - 74, DH - 66, 21, 0, Math.PI * 2);
  ctx.stroke();

  ctx.globalAlpha = 1;
}

export function render(ctx, t, env) {
  const w = Math.max(1, Math.round(Number(env && env.width) || DW));
  const h = Math.max(1, Math.round(Number(env && env.height) || DH));
  const props = (env && env.props) || {};
  const cfg = {
    seamLead: num(props.seamLead, DEFAULTS.seamLead, 0, 2),
    openDur: num(props.openDur, DEFAULTS.openDur, 0.2, 4),
    drift: num(props.drift, DEFAULTS.drift, 0, 0.4),
    background: props.background || DEFAULTS.background,
    accent: props.accent || DEFAULTS.accent,
    paper: props.paper || DEFAULTS.paper,
    ink: props.ink || DEFAULTS.ink,
  };

  const duration = num(env && env.duration, meta.duration, 0.8, 120);
  const tt = Math.min(duration, Math.max(0, Number.isFinite(Number(t)) ? Number(t) : 0));

  // 合并形态（第二轮 · 2026-11-06）：mode:'push' 走 sc-bottom-push-stack-wipe 的
  // 「新章连底色从底边整屏上推、把旧章顶出画外」。默认 'split' 不变。
  if (String(props.mode || 'split') === 'push') {
    renderPushWipe(ctx, w, h, props, tt, duration);
    return;
  }

  const s = Math.min(w / DW, h / DH);
  const ox = (w - DW * s) / 2;
  const oy = (h - DH * s) / 2;

  ctx.save();
  ctx.fillStyle = cfg.background;
  ctx.fillRect(0, 0, w, h);

  ctx.translate(ox, oy);
  ctx.scale(s, s);

  // 开场前：裂缝先亮一下（一条竖线在中间）
  const seamP = clamp01(tt / cfg.seamLead);
  const openP = clamp01((tt - cfg.seamLead) / cfg.openDur);
  const e = inOutCubic(openP);
  const settle = clamp01((tt - cfg.seamLead * 0.6) / (cfg.openDur * 1.1));

  // 新页在最底下：从略大落到 1.0（"迎上"）
  const newScale = 1 + cfg.drift * (1 - outCubic(settle));
  ctx.save();
  ctx.translate(DW / 2, DH / 2);
  ctx.scale(newScale, newScale);
  ctx.translate(-DW / 2, -DH / 2);
  ctx.beginPath();
  ctx.rect(0, 0, DW, DH);
  ctx.clip();
  paintNewPage(ctx, cfg, settle, tt);
  ctx.restore();

  if (openP < 1) {
    // 旧页被劈成两半：左右各自滑出，转轴在画布外缘一侧
    const halfW = DW / 2;
    const slide = halfW * 1.06 * e;
    const shrink = 1 - 0.16 * e;
    const tilt = 0.05 * e;
    const sides = [
      { x0: 0, dir: -1, pivot: 0 },
      { x0: halfW, dir: 1, pivot: DW },
    ];

    for (const side of sides) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(side.x0, 0, halfW, DH);
      ctx.clip();

      // 转轴：远离中心的一侧作为铰链
      const px = side.pivot;
      const py = DH / 2;
      ctx.translate(px, py);
      ctx.rotate(side.dir * tilt);
      ctx.scale(shrink, 1);
      ctx.translate(-px, -py);

      // 位移（向外滑出）
      ctx.translate(side.dir * slide, 0);

      paintOldPage(ctx, cfg);

      // 内侧阴影：靠近裂缝的边缘更暗，读作"门页的厚度"
      const shaftW = 66;
      const gx = side.dir < 0 ? halfW - shaftW : halfW;
      const g = ctx.createLinearGradient(side.dir < 0 ? halfW : halfW - shaftW, 0, side.dir < 0 ? halfW - shaftW : halfW, 0);
      g.addColorStop(0, 'rgba(0,0,0,0.72)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(gx, 0, shaftW, DH);

      // 被踢起的一角：半页顶部的暗边
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(side.x0, 0, halfW, 6);

      ctx.restore();
    }

    // 裂缝亮线（开场 → 裂开瞬间）
    const lineAlpha = seamP > 0 ? (1 - clamp01((openP - 0.04) / 0.22)) * 0.9 : 0;
    if (lineAlpha > 0.01) {
      const lw = 1.6 + 6 * (1 - openP) * Math.min(1, seamP);
      const lg = ctx.createLinearGradient(DW / 2 - 14, 0, DW / 2 + 14, 0);
      lg.addColorStop(0, 'rgba(242,193,78,0)');
      lg.addColorStop(0.5, `rgba(255,240,200,${lineAlpha})`);
      lg.addColorStop(1, 'rgba(242,193,78,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(DW / 2 - 14, 0, 28, DH);
      ctx.fillStyle = `rgba(255,255,255,${lineAlpha * 0.85})`;
      ctx.fillRect(DW / 2 - lw / 2, 0, lw, DH);
    }

    // 裂开瞬间的两道飞屑（短条，给"劈"一点物理）
    const chipP = clamp01((openP - 0.02) / 0.3);
    if (chipP > 0 && chipP < 1) {
      for (let i = 0; i < 6; i += 1) {
        const dir = i % 2 === 0 ? -1 : 1;
        const yy = 30 + ((i * 41) % (DH - 60));
        const xx = DW / 2 + dir * (12 + chipP * (60 + i * 18));
        ctx.save();
        ctx.globalAlpha = (1 - chipP) * 0.8;
        ctx.translate(xx, yy + chipP * (i % 3 - 1) * 26);
        ctx.rotate(dir * chipP * 1.6 + i);
        ctx.fillStyle = i % 3 === 0 ? cfg.accent : 'rgba(239,233,220,0.8)';
        ctx.fillRect(-3, -1, 6 + (i % 3) * 3, 1.6);
        ctx.restore();
      }
    }
  }

  // 右下角落点：新页就位后的小标记（读作"翻好了"）
  const dotP = clamp01((settle - 0.75) / 0.4);
  if (dotP > 0) {
    ctx.globalAlpha = dotP;
    ctx.fillStyle = cfg.accent;
    ctx.fillRect(DW - 46, DH - 26, 22 * dotP, 2);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* 合并形态：sc-bottom-push-stack-wipe（新章连底色从底边上推）           */
/* 同一套「用整幅换场当章节节拍」；差别只在换场几何：                    */
/* 开页两半滑出 → 换成整屏上推，新章底色把旧章顶出画外。                 */
/* ------------------------------------------------------------------ */
function paintPushChapter(ctx, ch, pushP) {
  ctx.fillStyle = ch.color;
  ctx.fillRect(0, 0, DW, DH);

  // 底色肌理：斜向细条（随章节换密度）
  ctx.strokeStyle = ch.light ? 'rgba(27,34,48,0.06)' : 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = -DH; i < DW; i += 18) {
    ctx.moveTo(i, 0);
    ctx.lineTo(i + DH * 0.35, DH);
  }
  ctx.stroke();

  // 章节号（大数字压左侧）
  ctx.fillStyle = ch.light ? 'rgba(27,34,48,0.12)' : 'rgba(255,255,255,0.1)';
  ctx.font = '700 148px system-ui, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(ch.num, 26, 196);

  // 主体几何：同心环 + 锚线（随章节微调）
  const cx = 292;
  const cy = 128;
  ctx.strokeStyle = ch.ink;
  ctx.lineWidth = 2.4;
  for (let i = 0; i < 2; i += 1) {
    ctx.beginPath();
    ctx.arc(cx, cy, 52 - i * 18, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = ch.accent;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx, cy, 34, Math.PI * 0.15, Math.PI * 0.9);
  ctx.stroke();

  // 章节标签条
  ctx.fillStyle = ch.light ? 'rgba(27,34,48,0.9)' : 'rgba(0,0,0,0.32)';
  roundRect(ctx, 26, 232, 132, 24, 12);
  ctx.fill();
  ctx.fillStyle = ch.light ? '#f1ece1' : '#f4f1e8';
  ctx.font = '600 11px system-ui, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ch.label, 26 + 66, 244);

  // 顶边压条：告诉眼睛「这层正在上移」
  ctx.fillStyle = ch.light ? 'rgba(27,34,48,0.16)' : 'rgba(255,255,255,0.18)';
  ctx.fillRect(0, 0, DW, 2);

  // 落定后的一点点内容呼吸（不是另一段动画）
  ctx.globalAlpha = 0.5 * (1 - pushP);
  ctx.fillStyle = ch.accent;
  ctx.fillRect(DW - 92, DH - 30, 52, 2);
  ctx.globalAlpha = 1;
}

function renderPushWipe(ctx, w, h, props, tt, duration) {
  const s = Math.min(w / DW, h / DH);
  const ox = (w - DW * s) / 2;
  const oy = (h - DH * s) / 2;

  const chapters = Array.isArray(props.chapters) && props.chapters.length >= 2
    ? props.chapters.map((c, i) => ({
      color: c.color || ['#1d2a3a', '#7a2e1d', '#e8e2d4'][i % 3],
      ink: c.ink || ['#f4f1e8', '#f7e9d7', '#1b2230'][i % 3],
      accent: c.accent || ['#f4c26b', '#ffd08a', '#e2542c'][i % 3],
      label: c.label || '第 ' + (i + 1) + ' 章',
      num: c.num || String(i + 1).padStart(2, '0'),
      light: c.light != null ? !!c.light : i % 3 === 2,
    }))
    : [
      { color: '#1d2a3a', ink: '#f4f1e8', accent: '#f4c26b', label: '第一章', num: '01', light: false },
      { color: '#7a2e1d', ink: '#f7e9d7', accent: '#ffd08a', label: '第二章', num: '02', light: false },
      { color: '#e8e2d4', ink: '#1b2230', accent: '#e2542c', label: '第三章', num: '03', light: true },
    ];

  ctx.save();
  ctx.fillStyle = props.background || DEFAULTS.background;
  ctx.fillRect(0, 0, w, h);
  ctx.translate(ox, oy);
  ctx.scale(s, s);

  const pushDur = num(props.pushDur, 0.9, 0.2, 4);
  const firstAt = num(props.firstAt, 1.0, 0, 8);
  const gap = num(props.gap, 1.6, pushDur + 0.2, 8);

  let index = 0;
  let pushP = 0;
  for (let i = 0; i < chapters.length - 1; i += 1) {
    const at = firstAt + i * gap;
    if (tt >= at) {
      index = i + 1;
      pushP = clamp01((tt - at) / pushDur);
    }
  }
  const e = inOutCubic(pushP);

  // 旧章：整屏上移，被顶出画外
  if (index > 0) {
    ctx.save();
    ctx.translate(0, -e * DH);
    paintPushChapter(ctx, chapters[index - 1], e);
    ctx.restore();
  }

  // 新章：从底边推入
  ctx.save();
  ctx.translate(0, (1 - e) * DH);
  paintPushChapter(ctx, chapters[index], 1 - e);
  ctx.restore();

  // 顶边阴影：上移的那层压在新章上（读作「物理顶」）
  if (e > 0 && e < 1) {
    const g = ctx.createLinearGradient(0, 0, 0, 26);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, DW, 26);
  }

  // 章节读数（右下角）
  ctx.fillStyle = 'rgba(244,241,232,0.6)';
  ctx.font = '9px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('CH ' + chapters[index].num + ' / ' + String(chapters.length).padStart(2, '0'), DW - 14, DH - 10);

  // 收尾淡出（与整卡同收）
  const outP = clamp01((tt - (duration - 0.35)) / 0.35);
  if (outP > 0) {
    ctx.globalAlpha = outP;
    ctx.fillStyle = props.background || DEFAULTS.background;
    ctx.fillRect(0, 0, DW, DH);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}
