/**
 * sc-transition-travel · 旅行转场（字腔穿越，人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/transition/transition-travel.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实（A 式 字腔穿越 letterform-zoom）：
 *   - 盖板（暖黑）+ 黑字挖洞（遮罩孔），洞里透出新页面 —— 暖黑盖板 vs 页面亮面，
 *     「洞里有东西」才成立（洞里是深色块会让那几个字母读作实心字）；
 *   - transform-origin 对准**字形笔画（洞）中心**：锚在字腔里推到底撑满的是盖板不是洞；
 *   - scale = 30^u，u 52f bezier(0.6,0,0.85,0.5) 慢起陡收；推前 26–34f 吸 2% 预备；
 *   - 撤场：scale∈[14,26] 盖板 opacity 1→0；u>0.35 起期望模糊 0→20px（除以 scale）；
 *     四层更早 0.8–3.2 帧的半透明盖板残影叠成径向变焦拖尾；
 *   - 接管瞬间页面 brightness +12% 一闪回落；后景视差：页面只推 1→1.08、向左漂 28px。
 */

export const meta = {
  title: '旅行转场',
  duration: 3.0,
  source: 'shotcraft',
  sourcePath: 'references/shots/transition/transition-travel.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const INHALE_A = 26 / FPS;
const INHALE_B = 34 / FPS;
const RUSH_A = 34 / FPS;
const RUSH_DUR = 52 / FPS;
const ZOOM_MAX = 30;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const quintOut = (x) => 1 - Math.pow(1 - clamp01(x), 5);

/** bezier(0.6, 0, 0.85, 0.5)：慢起陡收。 */
function rushEase(u) {
  const p = clamp01(u);
  let lo = 0;
  let hi = 1;
  let q = p;
  for (let i = 0; i < 18; i += 1) {
    const bx = 3 * (1 - q) * (1 - q) * q * 0.6 + 3 * (1 - q) * q * q * 0.85 + q * q * q;
    if (bx < p) lo = q;
    else hi = q;
    q = (lo + hi) / 2;
  }
  return 3 * (1 - q) * (1 - q) * q * 0 + 3 * (1 - q) * q * q * 0.5 + q * q * q;
}

let coverCache = { key: '', canvas: null };

/** 暖黑盖板 + 黑字挖洞（缓存：纯函数输出，不影响可复现性）。 */
function buildCover(W, H, word, fontSize, weight, tracking, textX, textY) {
  if (typeof OffscreenCanvas !== 'function') return null;
  const key = W + 'x' + H + '|' + word + '|' + fontSize;
  try {
    if (coverCache.key === key && coverCache.canvas) return coverCache.canvas;
    const off = new OffscreenCanvas(Math.max(1, Math.round(W)), Math.max(1, Math.round(H)));
    const c = off.getContext('2d');
    if (!c) return null;
    const g = c.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.55, W * 0.8);
    g.addColorStop(0, '#241a12');
    g.addColorStop(0.6, '#1a120c');
    g.addColorStop(1, '#0e0a07');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    // 挖洞
    c.globalCompositeOperation = 'destination-out';
    c.font = weight + ' ' + fontSize + 'px system-ui, "Segoe UI", sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const chars = Array.from(word);
    let total = 0;
    const widths = chars.map((ch) => {
      const cw = c.measureText(ch).width + tracking;
      total += cw;
      return cw;
    });
    let x = textX - total / 2;
    for (let i = 0; i < chars.length; i += 1) {
      c.fillText(chars[i], x + widths[i] / 2, textY);
      x += widths[i];
    }
    // 字缘一圈模糊橙色描边：光从洞里漏出来（画在盖板区域）
    c.globalCompositeOperation = 'source-over';
    coverCache = { key, canvas: off };
    return off;
  } catch {
    return null;
  }
}

/** 新页面（后景）：只给光不给字（洞里的卡片做成亮面）。 */
function drawNextPage(ctx, W, H, src, push, drift) {
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(push, push);
  ctx.translate(-W / 2 + drift, -H / 2);

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#3a2a16');
  g.addColorStop(0.45, '#6b4a1f');
  g.addColorStop(0.7, '#9a6a2c');
  g.addColorStop(1, '#2a1c10');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  if (src) {
    const sw = src.width || W;
    const sh = src.height || H;
    const k = Math.max(W / sw, H / sh) * 1.02;
    ctx.save();
    ctx.globalAlpha = 0.82;
    ctx.drawImage(src, (W - sw * k) / 2, (H - sh * k) / 2, sw * k, sh * k);
    ctx.restore();
    // 熔金渐变罩：洞里是「亮面」而不是一张死图
    const gold = ctx.createLinearGradient(0, 0, W, H);
    gold.addColorStop(0, 'rgba(255, 196, 96, 0.34)');
    gold.addColorStop(0.5, 'rgba(255, 224, 160, 0.16)');
    gold.addColorStop(1, 'rgba(120, 70, 20, 0.34)');
    ctx.fillStyle = gold;
    ctx.fillRect(0, 0, W, H);
  }

  // 卡片位一团奶白光、标题位一抹暗赤（洞里只给光不给字）
  const card = ctx.createRadialGradient(W * 0.5, H * 0.56, 0, W * 0.5, H * 0.56, W * 0.24);
  card.addColorStop(0, 'rgba(255, 244, 220, 0.9)');
  card.addColorStop(0.7, 'rgba(255, 238, 205, 0.35)');
  card.addColorStop(1, 'rgba(255, 238, 205, 0)');
  ctx.fillStyle = card;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(120, 40, 26, 0.5)';
  ctx.fillRect(W * 0.3, H * 0.26, W * 0.4, H * 0.06);
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

  const word = String(props.word || 'EDITS');
  const fontSize = Math.round(H * 0.62);   // 560/900 的比例感
  const tracking = -H * 0.012;
  const textX = W * 0.5;
  const textY = H * 0.5;

  // 推前 26–34f 吸 2% 预备
  const inhale = 1 - 0.02 * clamp01((time - INHALE_A) / (INHALE_B - INHALE_A));
  const rushU = clamp01((time - RUSH_A) / RUSH_DUR);
  const scale = rushU > 0 ? Math.pow(ZOOM_MAX, rushEase(rushU)) : inhale;

  // 后景视差：页面推 1→1.08（主推期 0.7u，接管后 quint-out 补完）、向左漂 28px
  const pushPage = 1 + 0.08 * (rushU > 0 ? 0.7 * rushEase(rushU) + 0.3 * quintOut(rushU) : 0);
  const driftPage = -28 * clamp01(time / (100 / FPS)) * (W / 1280);

  ctx.save();
  drawNextPage(ctx, W, H, src, pushPage, driftPage);

  // transform-origin：对准字形笔画（洞）中心 —— 取「I 竖笔」位置（词里有 I 就钉在 I 上）
  const iIdx = word.toUpperCase().indexOf(String(props.anchor || 'I'));
  const originX = iIdx >= 0 ? textX + (iIdx / Math.max(1, word.length - 1) - 0.5) * fontSize * 0.42 : textX;
  const originY = textY;

  const cover = buildCover(W, H, word, fontSize, 900, tracking, textX, textY);

  // 盖板 opacity：scale ∈ [14, 26] 时 1→0
  const coverAlpha = rushU > 0 ? 1 - clamp01((scale - 14) / (26 - 14)) : 1;
  // u>0.35 起期望模糊 0→20px（除以 scale 写进 blur）
  const expectBlur = rushU > 0.35 ? (1 - coverAlpha) * 20 : 0;
  const blurOut = expectBlur / Math.max(1, scale * 0.15);

  // 四层更早 0.8–3.2 帧的半透明盖板残影（叠成径向变焦拖尾）
  ctx.save();
  ctx.translate(originX, originY);
  ctx.scale(scale, scale);
  ctx.translate(-originX, -originY);
  for (let layer = 4; layer >= 1; layer -= 1) {
    const back = (layer * 0.8) / FPS;
    const backU = clamp01((time - back - RUSH_A) / RUSH_DUR);
    const backScale = backU > 0 ? Math.pow(ZOOM_MAX, rushEase(backU)) / scale : 1;
    if (backScale >= 1) continue;
    ctx.save();
    ctx.globalAlpha = coverAlpha * 0.16 * (layer / 4);
    ctx.translate(originX, originY);
    ctx.scale(backScale, backScale);
    ctx.translate(-originX, -originY);
    if (cover) ctx.drawImage(cover, 0, 0, W, H);
    ctx.restore();
  }
  ctx.save();
  ctx.globalAlpha = coverAlpha;
  if (blurOut > 0.2 && typeof ctx.filter === 'string') ctx.filter = 'blur(' + blurOut.toFixed(2) + 'px)';
  if (cover) {
    ctx.drawImage(cover, 0, 0, W, H);
  } else {
    // 退化：不挖洞，画盖板 + 洞的暗示（不白屏、不崩）
    ctx.fillStyle = '#1a120c';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255, 200, 130, 0.7)';
    ctx.lineWidth = Math.max(2, fontSize * 0.01);
    ctx.font = '900 ' + fontSize + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeText(word, textX, textY);
  }
  if (typeof ctx.filter === 'string') ctx.filter = 'none';
  ctx.restore();
  ctx.restore();

  // 接管瞬间页面亮度 +12% 一闪回落。
  // ★ 连续性修正（2026-11-06）：旧写法 `k = 1 - sinceTake/0.16` 在 sinceTake=0 处
  //   直接给到 12% 白 —— 整幅亮度一帧内从 0 跳到 12%，是「分段硬起」（t 上不连续）。
  //   现在用 sin² 包络：两端斜率为 0、峰值仍是 12%，拉到 0.30s（30fps 约 9 帧）。
  //   体感还是「一闪」，但每一帧只走一小步。
  const FLASH_DUR = 0.3;
  const sinceTake = time - (RUSH_A + RUSH_DUR * 0.82);
  if (sinceTake >= 0 && sinceTake < FLASH_DUR) {
    const u = sinceTake / FLASH_DUR;
    const k = Math.sin(Math.PI * u) ** 2;
    ctx.fillStyle = 'rgba(255, 236, 200, ' + (0.12 * k).toFixed(5) + ')';
    ctx.fillRect(0, 0, W, H);
  }

  // 字缘暖白切口边：只在盖板还在时画（漏光的证据）
  if (coverAlpha > 0.02) {
    ctx.save();
    ctx.globalAlpha = coverAlpha * 0.5;
    ctx.translate(originX, originY);
    ctx.scale(scale, scale);
    ctx.translate(-originX, -originY);
    ctx.strokeStyle = 'rgba(255, 232, 198, 0.9)';
    ctx.lineWidth = Math.max(0.6, (1.5 / Math.max(1, scale)) * 2);
    ctx.font = '900 ' + fontSize + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeText(word, textX, textY);
    ctx.restore();
  }

  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255, 220, 170, 0.45)';
  ctx.font = '500 ' + Math.round(H * 0.024) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('SCALE ×' + scale.toFixed(2) + '  ·  ' + (thumbStage(coverAlpha, rushU)), W * 0.95, H * 0.95);
  ctx.restore();

  ctx.restore();
}

function thumbStage(coverAlpha, rushU) {
  if (rushU <= 0) return 'HOLD';
  if (coverAlpha > 0.98) return 'RUSH START';
  if (coverAlpha > 0.02) return 'RUSH';
  return 'HANDOFF';
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
