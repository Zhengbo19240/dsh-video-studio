/**
 * sc-orbit-ring-title-open · 轨道环开场（2026-11-06 修好版）
 *
 * 配方来源：video-shotcraft / references/shots/opening/orbit-ring-title-open.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 2026-11-06 修复记录：
 *   旧版写死 8 张卡，且不管给几条素材都拿同一张图切 4×2 个区域 —— 只有一条素材时，
 *   八张卡其实是「同一张图在转」，和原片「八个不同产品画面」完全不是一回事。
 *   现在环上张数按素材数自适应：
 *     - 给 1–3 条素材 → 环上 4 张（素材各占一张，其余用**互不相同**的占位卡，不再重复同一张）；
 *     - 给 4–7 条 → 有几条上几张；
 *     - 给 0 条 → 8 张互不相同的占位卡；
 *     - 给 ≥8 条 → 8 张（多出来的不用）。
 *   占位卡是带色相和版式的假产品页（图表/表格/看板/信息流/宫格/对话框），
 *   一眼看得出是占位，不会被误读成「同一张素材」。
 *
 * 卡文要点（没变）：
 *   - θ = -π/2 + i·2π/N + t·0.3；x = cx + cosθ·RX、y = cy + sinθ·RY，RY/RX≈0.53；
 *   - **卡身永不倾斜**：只换位置，自身只有缩放；纵深完全交给 depth = sinθ →
 *     scale = 1 + 0.12·depth、z 序、远处失焦 + 压暗；
 *   - 环入场 f0–24 ringScale .62→1（expo-out），逐卡淡入；
 *   - 卡内容 f24 之前冻结首帧、f24 起统一开播；
 *   - 两级标题 blur-slide 逐字，马克块 spring 横扫、扫过处字反白为墨；
 *   - hold 段极缓推近 2.5%，环继续匀速转。
 */

export const meta = {
  title: '轨道环开场',
  duration: 4.6,
  source: 'shotcraft',
  sourcePath: 'references/shots/opening/orbit-ring-title-open.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

const MAX_SLOTS = 8;
const MIN_SLOTS = 4;

/** 素材 id 列表：支持 props.assetIds（多张）+ props.assetId（一张）。 */
export function media(props) {
  const p = props || {};
  const out = [];
  if (Array.isArray(p.assetIds)) {
    for (const id of p.assetIds) {
      if (id === undefined || id === null || id === '') continue;
      const s = String(id);
      if (!out.includes(s)) out.push(s);
    }
  }
  const single = p.assetId;
  if (single !== undefined && single !== null && single !== '') {
    const s = String(single);
    if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, MAX_SLOTS);
}

/**
 * 环上摆几张卡、每张放什么。纯函数，测试直接调用。
 * 返回 { slots, mediaCount, placeholders, cards:[{kind:'media',assetIndex}|{kind:'placeholder',variant}] }
 */
export function ringPlan(mediaCount) {
  const raw = Number(mediaCount);
  const n = Math.max(0, Math.min(MAX_SLOTS, Number.isFinite(raw) ? Math.floor(raw) : 0));
  const slots = n === 0 ? MAX_SLOTS : n >= MAX_SLOTS ? MAX_SLOTS : Math.max(MIN_SLOTS, n);
  const cards = [];
  for (let i = 0; i < slots; i += 1) {
    cards.push(i < n ? { kind: 'media', assetIndex: i } : { kind: 'placeholder', variant: i });
  }
  return { slots, mediaCount: n, placeholders: slots - n, cards };
}

const FPS = 30;
const RX_RATIO = 0.375;
const RY_RATIO = 0.352;
const CARD_W = 0.208;
const CARD_H = 0.2083;
const SPIN = 0.3;
const PLAY_START = 24 / FPS;
const RING_IN = 24 / FPS;
const MARK_AT = 50 / FPS;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outExpo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp01(x)));
const quintOut = (x) => 1 - Math.pow(1 - clamp01(x), 5);

function springAt(time) {
  const since = time - MARK_AT;
  if (since <= 0) return 0;
  const k = 14 / FPS;
  const u = clamp01(since / k);
  return Math.min(1.03, 1 - Math.pow(1 - u, 2.2) * Math.cos(u * Math.PI * 0.5));
}

/** 占位卡：6 种互不相同的假产品页（色相 + 版式都不同），一眼看得出是占位。 */
const PH = [
  { hue: '#4f7cff', label: '分析面板' },
  { hue: '#ff8a4f', label: '数据表格' },
  { hue: '#4fd6a8', label: '任务看板' },
  { hue: '#c86bff', label: '信息流' },
  { hue: '#ffd45c', label: '宫格画廊' },
  { hue: '#ff6b8a', label: '对话框' },
];

function drawPlaceholder(ctx, cw, ch, variant, t) {
  const ph = PH[variant % PH.length];
  const drift = t * 0.05;
  ctx.fillStyle = '#12151d';
  ctx.fillRect(0, 0, cw, ch);
  const g = ctx.createLinearGradient(0, 0, cw, ch);
  g.addColorStop(0, ph.hue + '22');
  g.addColorStop(1, ph.hue + '05');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cw, ch);

  ctx.fillStyle = ph.hue;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(cw * 0.06, ch * 0.07, cw * (0.34 + ((variant % 3) * 0.1)), ch * 0.05);
  ctx.globalAlpha = 1;

  const kind = variant % PH.length;
  ctx.save();
  ctx.translate(-drift * cw * 0.08, 0);
  if (kind === 0) {
    // 面积图
    ctx.strokeStyle = ph.hue;
    ctx.lineWidth = Math.max(1, cw * 0.008);
    ctx.beginPath();
    for (let i = 0; i <= 12; i += 1) {
      const x = cw * (0.08 + (i / 12) * 0.84);
      const y = ch * (0.72 - 0.3 * Math.abs(Math.sin(i * 0.7 + 0.4)));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  } else if (kind === 1) {
    // 表格
    for (let r = 0; r < 4; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        ctx.fillStyle = r === 0 ? ph.hue + '77' : 'rgba(190,205,235,0.16)';
        ctx.fillRect(cw * (0.08 + c * 0.3), ch * (0.28 + r * 0.16), cw * 0.24, ch * 0.1);
      }
    }
  } else if (kind === 2) {
    // 看板三列
    for (let c = 0; c < 3; c += 1) {
      ctx.fillStyle = 'rgba(160,180,220,0.12)';
      ctx.fillRect(cw * (0.07 + c * 0.31), ch * 0.3, cw * 0.26, ch * 0.56);
      for (let k = 0; k < 2; k += 1) {
        ctx.fillStyle = ph.hue + (k === 0 ? '99' : '55');
        ctx.fillRect(cw * (0.09 + c * 0.31), ch * (0.34 + k * 0.2), cw * 0.22, ch * 0.12);
      }
    }
  } else if (kind === 3) {
    // 信息流
    for (let r = 0; r < 3; r += 1) {
      ctx.fillStyle = 'rgba(170,190,230,0.14)';
      ctx.fillRect(cw * 0.08, ch * (0.3 + r * 0.2), cw * 0.84, ch * 0.14);
      ctx.fillStyle = ph.hue + '88';
      ctx.beginPath();
      ctx.arc(cw * 0.16, ch * (0.37 + r * 0.2), cw * 0.035, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (kind === 4) {
    // 宫格
    for (let r = 0; r < 2; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        ctx.fillStyle = ph.hue + (r === 0 ? '66' : '33');
        ctx.fillRect(cw * (0.08 + c * 0.29), ch * (0.3 + r * 0.28), cw * 0.25, ch * 0.24);
      }
    }
  } else {
    // 对话框
    ctx.fillStyle = 'rgba(170,190,230,0.16)';
    ctx.fillRect(cw * 0.1, ch * 0.32, cw * 0.5, ch * 0.16);
    ctx.fillRect(cw * 0.38, ch * 0.54, cw * 0.52, ch * 0.16);
    ctx.fillStyle = ph.hue + '99';
    ctx.fillRect(cw * 0.62, ch * 0.62, cw * 0.16, ch * 0.05);
  }
  ctx.restore();

  ctx.fillStyle = 'rgba(214,224,244,0.72)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 ' + Math.max(7, Math.round(ch * 0.075)) + 'px system-ui, sans-serif';
  ctx.fillText('占位 ' + String(variant + 1).padStart(2, '0') + ' · ' + ph.label, cw * 0.06, ch * 0.93);
}

/** 卡内内容：媒体卡按 cover 画素材；占位卡画互不相同的假页面。 */
function drawCardContent(ctx, cw, ch, src, slot, playT, frozen, kind, variant) {
  const t = frozen ? 0 : playT;
  ctx.save();
  if (kind === 'media' && src) {
    const sw = src.width || cw;
    const sh = src.height || ch;
    const k = Math.max(cw / sw, ch / sh);
    const drift = t * 0.06;
    ctx.drawImage(src, cw / 2 - (sw * k) / 2 - drift * cw * 0.1, ch / 2 - (sh * k) / 2, sw * k, sh * k);
  } else if (kind === 'media') {
    // 素材给了 id 但环境里取不到：也要明确是「缺素材」，不装成占位卡
    ctx.fillStyle = '#1a1420';
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = 'rgba(255,140,140,0.85)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.round(ch * 0.085) + 'px system-ui, sans-serif';
    ctx.fillText('素材缺失', cw / 2, ch * 0.46);
    ctx.font = Math.round(ch * 0.06) + 'px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(220,180,180,0.7)';
    ctx.fillText('env.media 里没有这个 assetId', cw / 2, ch * 0.62);
  } else {
    drawPlaceholder(ctx, cw, ch, variant, t);
  }
  ctx.restore();
  void slot;
}

/** 逐字 blur-slide：位移先停、模糊后停。 */
function drawChars(ctx, text, x, y, fontSize, color, startAt, stagger, duration, weight, now) {
  const chars = Array.from(text);
  let cursor = x;
  for (let i = 0; i < chars.length; i += 1) {
    const at = startAt + i * stagger;
    const p = quintOut(clamp01((now - at) / duration));
    ctx.save();
    ctx.font = (weight || 600) + ' ' + fontSize + 'px system-ui, sans-serif';
    const cw = ctx.measureText(chars[i]).width;
    const dropP = quintOut(clamp01((now - at) / (duration / 3)));
    ctx.globalAlpha = clamp01(p * 1.25);
    ctx.shadowColor = color.replace(/[\d.]+\)$/, '1)');
    ctx.shadowBlur = (1 - p) * (fontSize / 6);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(chars[i], cursor, y + (1 - dropP) * fontSize * 0.22);
    ctx.restore();
    cursor += cw;
  }
  return cursor - x;
}

function __renderInner(ctx, t, env) {
  const W = Number(env && env.width) || 1;
  const H = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const time = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
  const m = env && env.media;
  const ids = media(props);
  const plan = ringPlan(ids.length);
  const srcAt = (index) => {
    const id = ids[index];
    if (!id || !m) return null;
    return m.video(id) || m.image(id) || null;
  };

  const s = Math.min(W / 1280, H / 720);
  const cx = W * 0.5;
  const cy = H * 0.5;
  const RX = W * RX_RATIO;
  const RY = H * RY_RATIO;

  const push = 1 + 0.025 * clamp01((time - 40 / FPS) / 3.0);

  ctx.save();
  const bg = ctx.createRadialGradient(cx, cy * 0.9, 0, cx, cy, W * 0.75);
  bg.addColorStop(0, '#20242e');
  bg.addColorStop(0.55, '#14171e');
  bg.addColorStop(1, '#08090d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.translate(cx, cy);
  ctx.scale(push, push);
  ctx.translate(-cx, -cy);

  const ringScale = 0.62 + 0.38 * outExpo(clamp01(time / RING_IN));
  const ringRX = RX * ringScale;
  const ringRY = RY * ringScale;

  // 椭圆轨道发丝线
  const ringDraw = clamp01(time / (30 / FPS));
  ctx.save();
  ctx.strokeStyle = 'rgba(120, 150, 255, 0.16)';
  ctx.lineWidth = Math.max(1, 1.4 * s);
  ctx.beginPath();
  const ringSteps = 96;
  for (let i = 0; i <= ringSteps * ringDraw; i += 1) {
    const a = (i / ringSteps) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(a) * ringRX;
    const y = cy + Math.sin(a) * ringRY;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();

  // ---- 环上卡：按 depth 排序，远的先画 ----
  const cards = [];
  for (let i = 0; i < plan.slots; i += 1) {
    const theta = -Math.PI / 2 + (i * 2 * Math.PI) / plan.slots + time * SPIN;
    const depth = Math.sin(theta);
    cards.push({ i, theta, depth });
  }
  cards.sort((a, b) => a.depth - b.depth);

  const cw = W * CARD_W;
  const chh = H * CARD_H;
  for (const card of cards) {
    const fadeAt = 2 / FPS + (1.5 * card.i) / FPS;
    const fadeP = clamp01((time - fadeAt) / (11 / FPS));
    if (fadeP <= 0) continue;
    const slot = plan.cards[card.i];
    const x = cx + Math.cos(card.theta) * ringRX;
    const y = cy + Math.sin(card.theta) * ringRY;
    const scale = (1 + 0.12 * card.depth) * (0.9 + 0.1 * outExpo(fadeP)) * ringScale * 0.92;
    const dim = card.depth < 0 ? 1 + card.depth * 0.45 : 1;
    const blurPx = card.depth < 0 ? Math.abs(card.depth) * 1.6 * s : 0;

    ctx.save();
    ctx.globalAlpha = fadeP * (0.55 + 0.45 * (card.depth + 1) / 2);
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.fillStyle = '#0f1219';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-cw / 2, -chh / 2, cw, chh, cw * 0.02);
    else ctx.rect(-cw / 2, -chh / 2, cw, chh);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-cw / 2, -chh / 2, cw, chh, cw * 0.02);
    else ctx.rect(-cw / 2, -chh / 2, cw, chh);
    ctx.clip();
    if (blurPx > 0.2 && typeof ctx.filter === 'string') ctx.filter = 'blur(' + blurPx.toFixed(2) + 'px)';
    ctx.translate(-cw / 2, -chh / 2);
    drawCardContent(
      ctx, cw, chh,
      slot.kind === 'media' ? srcAt(slot.assetIndex) : null,
      card.i,
      time - PLAY_START,
      time < PLAY_START,
      slot.kind,
      slot.kind === 'placeholder' ? slot.variant : 0,
    );
    if (typeof ctx.filter === 'string') ctx.filter = 'none';
    ctx.restore();
    if (dim < 1) {
      ctx.fillStyle = 'rgba(8, 10, 16, ' + (1 - dim).toFixed(3) + ')';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(-cw / 2, -chh / 2, cw, chh, cw * 0.02);
      else ctx.rect(-cw / 2, -chh / 2, cw, chh);
      ctx.fill();
    }
    if (card.depth > 0.3) {
      const top = ctx.createLinearGradient(0, -chh / 2, 0, -chh / 2 + chh * 0.28);
      top.addColorStop(0, 'rgba(255, 255, 255, ' + (0.1 * card.depth).toFixed(3) + ')');
      top.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = top;
      ctx.fillRect(-cw / 2, -chh / 2, cw, chh * 0.28);
    }
    ctx.strokeStyle = 'rgba(150, 176, 240, 0.14)';
    ctx.lineWidth = Math.max(0.8, 1.2 * s);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-cw / 2, -chh / 2, cw, chh, cw * 0.02);
    else ctx.rect(-cw / 2, -chh / 2, cw, chh);
    ctx.stroke();
    ctx.restore();
  }

  // 标题 scrim
  const scrim = ctx.createRadialGradient(cx, cy + H * 0.02, 0, cx, cy + H * 0.02, W * 0.34);
  scrim.addColorStop(0, 'rgba(8, 10, 16, 0.82)');
  scrim.addColorStop(0.62, 'rgba(8, 10, 16, 0.5)');
  scrim.addColorStop(1, 'rgba(8, 10, 16, 0)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, W, H);

  // ---- 两级标题：逐字 blur-slide ----
  const upFont = Math.round(H * 0.089);
  const mainFont = Math.round(H * 0.216);
  const line1 = String(props.line1 || 'a whole library of');
  const line2 = String(props.line2 || 'moving shots');

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '500 ' + upFont + 'px system-ui, sans-serif';
  const w1 = ctx.measureText(line1).width;
  drawChars(ctx, line1, cx - w1 / 2, cy - H * 0.055, upFont, 'rgba(178, 190, 214, 0.92)', 10 / FPS, 1 / FPS, 27 / FPS, 500, time);

  ctx.font = '600 ' + mainFont + 'px system-ui, sans-serif';
  const w2 = ctx.measureText(line2).width;
  const l2x = cx - w2 / 2;
  const l2y = cy + H * 0.115;
  drawChars(ctx, line2, l2x, l2y, mainFont, 'rgba(244, 247, 255, 0.97)', 18 / FPS, 2 / FPS, 32 / FPS, 600, time);
  ctx.restore();

  // 马克块横扫 + 扫过处反白为墨
  const markScale = springAt(time);
  if (markScale > 0) {
    const padEm = 0.14 * mainFont;
    const blockW = (w2 + padEm * 2) * markScale;
    const blockH = mainFont * 1.02;
    const blockX = l2x - padEm;
    const blockY = l2y - mainFont * 0.78;
    const front = blockX + blockW;

    ctx.save();
    ctx.fillStyle = 'rgba(198, 244, 50, 0.94)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(blockX, blockY, blockW, blockH, mainFont * 0.04);
    else ctx.rect(blockX, blockY, blockW, blockH);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.rect(front, 0, W - front, H);
    ctx.clip();
    ctx.font = '600 ' + mainFont + 'px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(16, 20, 28, 0.96)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(line2, l2x, l2y);
    ctx.restore();
    ctx.restore();
  }

  // ---- 副行 ----
  const subP = clamp01((time - 60 / FPS) / (16 / FPS));
  if (subP > 0) {
    ctx.save();
    ctx.globalAlpha = subP * 0.85;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(206, 218, 240, 0.9)';
    ctx.font = '500 ' + Math.round(H * 0.042) + 'px system-ui, sans-serif';
    ctx.fillText(String(props.wordmark || 'video-shotcraft'), cx, cy + H * 0.245);
    ctx.fillStyle = 'rgba(150, 168, 200, 0.72)';
    ctx.font = '500 ' + Math.round(H * 0.036) + 'px ui-monospace, Menlo, monospace';
    const mono = 'SHOT RECIPE CARDS';
    const gap = H * 0.0072;
    let mw = 0;
    for (const ch of mono) mw += ctx.measureText(ch).width + gap;
    let mx = cx - mw / 2;
    for (const chm of mono) {
      ctx.fillText(chm, mx + ctx.measureText(chm).width / 2, cy + H * 0.3);
      mx += ctx.measureText(chm).width + gap;
    }
    ctx.restore();
  }

  // 编辑期读数：环上到底几张、几条素材（这张卡的诚实度就写在这儿）
  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = 0.42;
  ctx.fillStyle = 'rgba(170, 186, 216, 0.8)';
  ctx.font = '500 ' + Math.round(H * 0.022) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('RING ' + plan.slots + ' · 素材 ' + plan.mediaCount + ' · 占位 ' + plan.placeholders, W * 0.96, H * 0.955);
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
