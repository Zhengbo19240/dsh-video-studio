/**
 * sc-spotlight-sweep-moves · 扫光（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/effects/spotlight-sweep-moves.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实（三式共用「贴边紫色辉光光线」这个身份元素）：
 *   - **匀速是命门**：聚光的移动/扩张严格 linear —— 加 ease 读作「光有主观意图」；
 *   - A 醒睡扫过：radial 显影罩跟随光头从左向右匀速移动，范围外全黑；贴顶边紫色光线三层辉光
 *     （宽糊 + 中层 + 亮芯 + 粉色偏移层）随扫光同步走；到右缘点亮竖直残光；尾段光走面板沉回黑暗
 *     —— 有醒有睡；
 *   - B 贴边泛光横摇：光线锚定面板边缘（先绕左上角竖缘、转角后沿顶边横走），紫光晕染渗入 UI 顶部内侧；
 *     聚光头匀速右移显影、面板同时匀速左滑＝相机右摇感；
 *   - C 角落匀速显影：左上角径向聚光半径**严格 linear** 扩张，照到显影照不到沉黑，片末刚好铺满全屏；
 *   - 显影罩要「硬边略糊」（feather ~15%）：边太硬像圆形遮罩，太糊就没有「照到/照不到」的界线。
 *
 * props.mode: 'A' | 'B' | 'C'（默认 A）。
 */

export const meta = {
  title: '扫光',
  duration: 3.2,
  source: 'shotcraft',
  sourcePath: 'references/shots/effects/spotlight-sweep-moves.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 显影罩：黑底 + 区域内画面板 + 边缘羽化（透明中心 → 边缘全黑）。 */
function revealCircle(ctx, W, H, cx, cy, r, feather, drawPanel) {
  if (r <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  drawPanel();
  // 羽化：从 (1-feather) 处开始转黑
  const g = ctx.createRadialGradient(cx, cy, r * (1 - feather), cx, cy, r);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.7, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = g;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
}

/** 面板本体（UI 截图 / 占位）。 */
function drawPanel(ctx, x, y, w, h, src, label) {
  ctx.save();
  ctx.fillStyle = '#12141c';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, w * 0.014) : ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, w * 0.014) : ctx.rect(x, y, w, h);
  ctx.clip();
  if (src) {
    const sw = src.width || w;
    const sh = src.height || h;
    const k = Math.max(w / sw, h / sh);
    ctx.drawImage(src, x + (w - sw * k) / 2, y + (h - sh * k) / 2, sw * k, sh * k);
  } else {
    // 面板骨架：顶栏 + 侧栏 + 内容块（让「点亮」有东西可点亮）
    ctx.fillStyle = '#1b2030';
    ctx.fillRect(x, y, w, h * 0.11);
    ctx.fillStyle = 'rgba(150, 176, 240, 0.4)';
    ctx.fillRect(x + w * 0.03, y + h * 0.04, w * 0.16, h * 0.03);
    // logo
    ctx.fillStyle = 'rgba(220, 214, 255, 0.85)';
    ctx.beginPath();
    ctx.arc(x + w * 0.085, y + h * 0.058, h * 0.022, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#141828';
    ctx.fillRect(x, y + h * 0.11, w * 0.17, h * 0.89);
    for (let i = 0; i < 6; i += 1) {
      ctx.fillStyle = 'rgba(130, 156, 210, ' + (0.28 - i * 0.025).toFixed(3) + ')';
      ctx.fillRect(x + w * 0.025, y + h * (0.16 + i * 0.09), w * 0.12, h * 0.028);
    }
    for (let r = 0; r < 4; r += 1) {
      ctx.fillStyle = 'rgba(44, 52, 78, 0.9)';
      ctx.fillRect(x + w * 0.2, y + h * (0.16 + r * 0.2), w * 0.76, h * 0.16);
      ctx.fillStyle = 'rgba(160, 186, 240, 0.24)';
      ctx.fillRect(x + w * 0.22, y + h * (0.19 + r * 0.2), w * 0.3, h * 0.028);
    }
    ctx.fillStyle = 'rgba(186, 206, 250, 0.75)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.round(h * 0.045) + 'px system-ui, sans-serif';
    ctx.fillText(label, x + w * 0.58, y + h * 0.94);
  }
  ctx.restore();
  ctx.restore();
}

/** 贴边紫色辉光：四层（宽糊 / 中层 / 亮芯 / 粉色偏移）。 */
function edgeGlowLine(ctx, x0, y0, x1, y1, s, intensity) {
  if (intensity <= 0.01) return;
  const layers = [
    { w: 26, c: 'rgba(120, 78, 255, 0.16)' },
    { w: 9, c: 'rgba(150, 104, 255, 0.34)' },
    { w: 3, c: 'rgba(198, 172, 255, 0.8)' },
    { w: 1.2, c: 'rgba(255, 244, 255, 0.95)' },
  ];
  for (const layer of layers) {
    ctx.save();
    ctx.globalAlpha = intensity;
    ctx.strokeStyle = layer.c;
    ctx.lineWidth = Math.max(0.8, layer.w * s);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.restore();
  }
  // 粉色偏移层（光晕的「色散」）
  ctx.save();
  ctx.globalAlpha = intensity * 0.6;
  ctx.strokeStyle = 'rgba(255, 140, 220, 0.7)';
  ctx.lineWidth = Math.max(1.4, 5 * s);
  ctx.beginPath();
  ctx.moveTo(x0 + 6 * s, y0 + 5 * s);
  ctx.lineTo(x1 + 6 * s, y1 + 5 * s);
  ctx.stroke();
  ctx.restore();
}

function __renderInner(ctx, t, env) {
  const W = Number(env && env.width) || 1;
  const H = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const time = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
  const m = env && env.media;
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);
  const src = id && m ? (m.video(id) || m.image(id)) : null;

  const s = Math.min(W / 1280, H / 720);
  const mode = String(props.mode || 'A').toUpperCase();
  const DUR = Number(env && env.duration) > 0 ? Number(env.duration) : 3.2;
  // **严格 linear**：全程零缓动
  const p = clamp01(time / DUR);

  // 合并形态（第二轮 · 2026-11-06）：variant:'hero' 走 sc-spotlight-hero-card 的
  // 「关灯 → 光池游走 → 锁定卡片 → 卡片弹起 + 轮廓光束」。默认 'sweep'（A/B/C）不变。
  if (String(props.variant || 'sweep') === 'hero') {
    renderHeroCard(ctx, W, H, props, env, time);
    return;
  }

  const panelX = W * 0.08;
  const panelY = H * 0.16;
  const panelW = W * 0.84;
  const panelH = H * 0.68;

  ctx.save();
  ctx.fillStyle = '#050409';
  ctx.fillRect(0, 0, W, H);

  const drawPanelHere = () => drawPanel(ctx, panelX, panelY, panelW, panelH, src, 'PANEL · props.assetId');

  if (mode === 'C') {
    // ---- C 角落匀速显影：半径 linear，片末刚好覆盖全屏 ----
    const maxR = Math.hypot(W, H) * 1.02;
    const r = maxR * p;
    revealCircle(ctx, W, H, 0, 0, r, 0.15, drawPanelHere);
    // 角落光源的一点点可见「灯头」
    if (p < 1) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, W * 0.1);
      g.addColorStop(0, 'rgba(196, 172, 255, ' + (0.5 * (1 - p)).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(120, 78, 255, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    // 贴边紫光沿顶边（顺着显影边界走）
    edgeGlowLine(ctx, 0, panelY * 0.6, Math.min(W, r), panelY * 0.6, s, 0.55 * (1 - p * 0.6));
  } else if (mode === 'B') {
    // ---- B 贴边泛光横摇：光锚边缘 + 面板匀速左滑 ----
    const headX = W * p;
    // 面板匀速左滑（相机右摇感）
    ctx.save();
    ctx.translate(-W * 0.16 * p, 0);
    // 显影：垂直光刃从左向右扫（linear）
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, headX, H);
    ctx.clip();
    drawPanelHere();
    // 顶部内侧紫光渗入（光从边缘渗进界面）
    const bleed = ctx.createLinearGradient(0, panelY, 0, panelY + panelH * 0.3);
    bleed.addColorStop(0, 'rgba(150, 104, 255, 0.22)');
    bleed.addColorStop(1, 'rgba(150, 104, 255, 0)');
    ctx.fillStyle = bleed;
    ctx.fillRect(panelX, panelY, panelW, panelH * 0.3);
    ctx.restore();
    // 光刃边缘的羽化
    const feather = ctx.createLinearGradient(headX - W * 0.05, 0, headX, 0);
    feather.addColorStop(0, 'rgba(5, 4, 9, 1)');
    feather.addColorStop(1, 'rgba(5, 4, 9, 0)');
    ctx.fillStyle = feather;
    ctx.fillRect(headX - W * 0.05, 0, W * 0.05, H);
    ctx.restore();

    // 贴边紫光：先绕左上角竖缘（0–0.35），转角后沿顶边横走（0.35–1）
    if (p < 0.35) {
      const u = p / 0.35;
      const y1 = panelY + panelH * 0.35 * u;
      edgeGlowLine(ctx, panelX, panelY, panelX, y1, s, 0.9);
    } else {
      const u = (p - 0.35) / 0.65;
      const x1 = panelX + panelW * u;
      edgeGlowLine(ctx, panelX, panelY, x1, panelY, s, 0.9);
      // 转角处的竖向余晖
      edgeGlowLine(ctx, panelX, panelY, panelX, panelY + panelH * 0.18, s, 0.5 * (1 - u));
    }
  } else {
    // ---- A 醒睡扫过：光池匀速右移 + 贴顶边紫光 + 右缘残光 + 尾段沉黑 ----
    const headX = W * (0.12 + 0.9 * p);
    const radius = W * 0.42;
    revealCircle(ctx, W, H, headX, panelY + panelH * 0.45, radius, 0.15, drawPanelHere);

    // 贴顶边紫色光线：随扫光同步走（锚定顶边，不脱离边缘）
    const lineFrom = Math.max(panelX, headX - radius * 0.9);
    const lineTo = Math.min(panelX + panelW, headX + radius * 0.7);
    if (lineTo > lineFrom) {
      const intensity = 0.95 * (p < 0.86 ? 1 : 1 - (p - 0.86) / 0.14);
      edgeGlowLine(ctx, lineFrom, panelY, lineTo, panelY, s, intensity);
    }

    // 经过 logo 时描光（logo 在面板 x≈0.085 处）
    const logoX = panelX + panelW * 0.085;
    if (headX > logoX && headX < logoX + W * 0.3) {
      const k = 1 - Math.abs(headX - logoX) / (W * 0.3);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      const g = ctx.createRadialGradient(logoX, panelY + panelH * 0.06, 0, logoX, panelY + panelH * 0.06, H * 0.1);
      g.addColorStop(0, 'rgba(210, 190, 255, ' + (0.5 * k).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(150, 104, 255, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(logoX - H * 0.1, panelY - H * 0.04, H * 0.2, H * 0.2);
      ctx.restore();
    }

    // 右缘竖直残光（光头接近右缘时点亮）
    if (p > 0.6) {
      const k = clamp01((p - 0.6) / 0.3) * (p < 0.92 ? 1 : 1 - (p - 0.92) / 0.08);
      edgeGlowLine(ctx, panelX + panelW, panelY, panelX + panelW, panelY + panelH * 0.7, s, 0.8 * k);
    }

    // 尾段：光走面板沉回黑暗（有醒有睡）
    if (p > 0.78) {
      const sink = clamp01((p - 0.78) / 0.22);
      ctx.fillStyle = 'rgba(5, 4, 9, ' + (0.8 * sink).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }
  }

  // 极淡暗角 + 底部 mono：模式与进度（编辑期校对）
  const vg = ctx.createRadialGradient(W * 0.5, H * 0.5, Math.min(W, H) * 0.35, W * 0.5, H * 0.5, Math.max(W, H) * 0.8);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(176, 150, 255, 0.5)';
  ctx.font = '500 ' + Math.round(H * 0.024) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('MODE ' + mode + '  ·  LINEAR ' + Math.round(p * 100) + '%  ·  零缓动', W * 0.04, H * 0.955);
  ctx.restore();

  ctx.restore();
}


/**
 * 画框适配外壳（本批 35 张统一）：
 * 卡是按 16:9 构的；画布更窄（尤其 720×1280）时把整幅构图等比缩到能放下为止并居中，
 * 而不是让每个坐标自己去适应 —— 这样任何画框下都不会有内容越出边界。
 * 16:9 下 k=1，与未加外壳时逐像素一致。
 */
export function render(ctx, t, env) {
  const W = Number(env && env.width) || 1;
  const H = Number(env && env.height) || 1;
  const k = Math.min(1, (W / H) / (16 / 9));
  ctx.save();
  if (k < 0.999) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(W / 2, H / 2);
    ctx.scale(k, k);
    ctx.translate(-W / 2, -H / 2);
  }
  try {
    __renderInner(ctx, t, env);
  } finally {
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */
/* 合并形态：sc-spotlight-hero-card（关灯 → 光池游走 → 锁定 → 卡片弹起）   */
/* 同一套「黑场 + 光池 + 页面显影」；差别在光的落点与后续：                */
/* 光池游走三站后锁死一张卡，相机推近、卡片弹起、轮廓光束跑两圈。          */
/* ------------------------------------------------------------------ */
const HERO_STOPS = [
  { x: 0.26, y: 0.4 },
  { x: 0.55, y: 0.56 },
  { x: 0.62, y: 0.46 },
];

function renderHeroCard(ctx, W, H, props, env, time) {
  const s = Math.min(W / 1280, H / 720);
  const tt = Number.isFinite(Number(time)) ? Math.max(0, Number(time)) : 0;
  const dur = Number(env && env.duration) > 0 ? Number(env.duration) : 5;
  const clamp01l = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const smooth = (x) => {
    const p = clamp01l(x);
    return p * p * (3 - 2 * p);
  };

  // 卡片位（页面坐标）：居中偏右
  const cardW = 300 * s;
  const cardH = 190 * s;
  const cardCx = W * 0.62;
  const cardCy = H * 0.47;

  // 光池：三站游走（站间 smooth in-out），1.9s 后锁死卡心
  let poolX = cardCx;
  let poolY = cardCy;
  const lockAt = 1.9;
  if (tt < lockAt) {
    const u = clamp01l(tt / lockAt) * (HERO_STOPS.length - 1);
    const i = Math.min(HERO_STOPS.length - 2, Math.floor(u));
    const f = smooth(u - i);
    const a = HERO_STOPS[i];
    const b = HERO_STOPS[i + 1];
    poolX = W * (a.x + (b.x - a.x) * f);
    poolY = H * (a.y + (b.y - a.y) * f);
  }
  const lockP = clamp01l((tt - lockAt) / 0.35);
  poolX = poolX + (cardCx - poolX) * smooth(lockP);
  poolY = poolY + (cardCy - poolY) * smooth(lockP);
  const poolR = (170 + 40 * Math.sin(tt * 1.1)) * s * (1 + 0.9 * smooth(lockP));

  // 相机：0–0.8s 静止全页 zoom 0.86，0.9–1.5s 推进到 1.7，之后锁死
  const zoom = 0.86 + (1.7 - 0.86) * smooth(clamp01l((tt - 0.9) / 0.6));

  // ---- 页面层（相机）----
  ctx.save();
  ctx.fillStyle = '#0b0b10';
  ctx.fillRect(0, 0, W, H);
  ctx.translate(cardCx, cardCy);
  ctx.scale(zoom, zoom);
  ctx.translate(-cardCx, -cardCy);

  // 一屏卡片网格（真页面的抽象版）
  ctx.fillStyle = '#14151d';
  ctx.fillRect(0, 0, W, H);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      const bw = (W * 0.19);
      const bh = (H * 0.21);
      const bx = W * 0.05 + c * (W * 0.235);
      const by = H * 0.09 + r * (H * 0.27);
      ctx.fillStyle = r === 1 && c === 2 ? '#20222c' : '#171923';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(bx + 12 * s, by + 14 * s, bw * 0.5, 8 * s);
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(bx + 12 * s, by + 34 * s, bw * 0.7, 5 * s);
    }
  }
  ctx.restore();

  // ---- 关灯：径向暗场（光池内透明，光池外压到 ~8%）----
  const dark = ctx.createRadialGradient(poolX, poolY, poolR * 0.18, poolX, poolY, poolR);
  dark.addColorStop(0, 'rgba(6, 5, 8, 0)');
  dark.addColorStop(0.55, 'rgba(6, 5, 8, 0.35)');
  dark.addColorStop(1, 'rgba(6, 5, 8, 0.94)');
  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, W, H);

  // ---- 体积光柱：光源在上方偏右，梯形柱打到光池 ----
  const srcX = poolX + 150 * s;
  const srcY = -40 * s;
  const beam = ctx.createLinearGradient(srcX, srcY, poolX, poolY);
  beam.addColorStop(0, 'rgba(255, 226, 170, 0.10)');
  beam.addColorStop(1, 'rgba(255, 226, 170, 0.02)');
  ctx.fillStyle = beam;
  ctx.beginPath();
  ctx.moveTo(srcX - 26 * s, srcY);
  ctx.lineTo(srcX + 26 * s, srcY);
  ctx.lineTo(poolX + poolR * 0.55, poolY);
  ctx.lineTo(poolX - poolR * 0.55, poolY);
  ctx.closePath();
  ctx.fill();

  // 浮尘（确定性）
  for (let i = 0; i < 16; i += 1) {
    const seed = Math.sin(i * 12.9898) * 43758.5453;
    const f = seed - Math.floor(seed);
    const fy = srcY + ((poolY - srcY) * ((f + tt * 0.06) % 1));
    const fx = srcX + (poolX - srcX) * ((f + tt * 0.06) % 1) + Math.sin(i + tt) * 14 * s;
    ctx.fillStyle = 'rgba(255, 232, 190, ' + (0.08 + 0.16 * f).toFixed(3) + ')';
    ctx.fillRect(fx, fy, 1.4 * s, 1.4 * s);
  }

  // ---- 锁定后：卡片弹起 + 轮廓光束 + 悬停呼吸 ----
  const riseP = smooth(clamp01l((tt - (lockAt + 0.25)) / 0.45));
  const bob = Math.sin((tt - lockAt) * 4.4) * 4 * s;
  const cy2 = cardCy - riseP * 14 * s + bob * riseP;

  ctx.save();
  ctx.globalAlpha = 0.35 * riseP;
  ctx.fillStyle = '#000';
  ctx.fillRect(cardCx - cardW / 2 + 10 * s, cardCy + cardH / 2 + 12 * s, cardW, 10 * s);
  ctx.restore();

  // 卡本体（用页面底色 + 边框，读作「从页面里浮起来」）
  ctx.save();
  ctx.translate(cardCx, cy2);
  const pop = 1 + 0.03 * riseP;
  ctx.scale(pop, pop);
  ctx.fillStyle = '#20222c';
  ctx.fillRect(-cardW / 2, -cardH / 2, cardW, cardH);
  ctx.strokeStyle = 'rgba(255, 226, 170, ' + (0.35 + 0.45 * riseP).toFixed(3) + ')';
  ctx.lineWidth = 1.5 * s;
  ctx.strokeRect(-cardW / 2, -cardH / 2, cardW, cardH);
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(-cardW / 2 + 18 * s, -cardH / 2 + 20 * s, cardW * 0.55, 10 * s);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  for (let i = 0; i < 4; i += 1) {
    ctx.fillRect(-cardW / 2 + 18 * s, -cardH / 2 + 46 * s + i * 24 * s, cardW * (0.8 - i * 0.1), 6 * s);
  }

  // 轮廓光束两圈：第一圈快而亮、第二圈慢而弱
  if (riseP > 0) {
    const loop = clamp01l((tt - (lockAt + 0.55)) / 0.9);
    if (loop > 0) {
      ctx.strokeStyle = 'rgba(255, 222, 160, ' + (0.85 * (1 - loop * 0.4)).toFixed(3) + ')';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.rect(-cardW / 2 - 3 * s, -cardH / 2 - 3 * s, cardW + 6 * s, cardH + 6 * s);
      ctx.stroke();
    }
    const loop2 = clamp01l((tt - (lockAt + 1.2)) / 1.5);
    if (loop2 > 0 && loop2 < 1) {
      ctx.strokeStyle = 'rgba(255, 236, 200, ' + (0.5 * (1 - loop2)).toFixed(3) + ')';
      ctx.lineWidth = 1 * s;
      ctx.beginPath();
      ctx.rect(-cardW / 2 - 9 * s, -cardH / 2 - 9 * s, cardW + 18 * s, cardH + 18 * s);
      ctx.stroke();
    }
  }
  ctx.restore();

  // ---- 3D 注记：两行落在卡片左侧 ----
  const noteP = smooth(clamp01l((tt - (lockAt + 0.9)) / 0.5));
  if (noteP > 0) {
    const line1 = String(props.line1 || 'Your product,');
    const line2 = String(props.line2 || 'in motion.');
    const kw = String(props.keyword || 'motion');
    ctx.save();
    ctx.globalAlpha = noteP;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '700 ' + Math.round(44 * s) + 'px system-ui, "Microsoft YaHei", sans-serif';
    const baseX = W * 0.1;
    const baseY = H * 0.52 - (1 - noteP) * 12 * s;
    ctx.fillStyle = '#f3ede2';
    ctx.fillText(line1, baseX, baseY);
    const w1 = ctx.measureText(line1).width;
    ctx.fillText(line2.slice(0, Math.max(0, line2.indexOf(kw))), baseX, baseY + 52 * s);
    // 关键词背后的香槟色马克条
    const pre = line2.indexOf(kw) >= 0 ? line2.slice(0, line2.indexOf(kw)) : '';
    const kwX = baseX + ctx.measureText(pre).width;
    const kwW = ctx.measureText(kw).width;
    ctx.fillStyle = 'rgba(255, 213, 150, 0.35)';
    ctx.fillRect(kwX - 2 * s, baseY + 30 * s, kwW + 4 * s, 26 * s);
    ctx.fillStyle = '#ffe6bd';
    ctx.fillText(kw + line2.slice(line2.indexOf(kw) + kw.length), baseX + ctx.measureText(pre).width, baseY + 52 * s);
    void w1;
    ctx.restore();
  }

  // 底部读数
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#d8cbb5';
  ctx.font = '10px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('SPOT · HERO / ZOOM ' + zoom.toFixed(2) + '×', W - 22 * s, H - 18 * s);
  ctx.restore();
  void dur;
}
