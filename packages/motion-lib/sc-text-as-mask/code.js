/**
 * sc-text-as-mask · 文字当遮罩（2026-11-06 修好版）
 *
 * 配方来源：video-shotcraft / references/shots/opening/text-as-mask.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 2026-11-06 修复记录（诚实交接，别抹掉）：
 *   旧实现把「文字形状的面板」缓存进一张离屏图，但那张图在 Chrome 里**每次都是全透明**：
 *   面板画完后 destination-in + fillText 没有留下像素，于是渲染出来只剩舞台 + 一排淡字，
 *   根本没有「字内透出面板」。用 getImageData 直接数 alpha 像素可以复现（0/129600）。
 *   现在改成：
 *     - 每帧重建遮罩（面板 → destination-in 字形），并在建完后**自检 alpha 像素数**，
 *       自检不过就当没有遮罩，走明确的降级画面，绝不再假装成功；
 *     - 遮罩表面不再写死 OffscreenCanvas：依次尝试 OffscreenCanvas → DOM canvas，
 *       两条都没有才降级（Worker 路径恒有 OffscreenCanvas；主线程导出有 DOM canvas）；
 *     - 「字内漂移」改成面板在遮罩里按 drift 平移，字形窗口不动（旧版平移整张遮罩 = 字也跟着动）。
 *
 * 卡文要点（仍然是这张卡的命门）：
 *   - 瓷白舞台 + 超粗大标题字（470px / 900 / 字距 −22），字内部透出缓慢平移的暗色产品面板；
 *   - 字内漂移：面板 +150 → −150，两端轻缓，字形静止；
 *   - 吸气 f96–104：字 1 → 0.965；冲入 24f：0.965 → 46，对数空间 t^1.8；
 *   - 内容层反向补偿 scale(1/S)，面板不随遮罩几何畸变；
 *   - 接管保险：竖笔撑满全屏之后才淡入无遮罩全屏面板；
 *   - 收尾 hold，面板仍缓慢流动。
 */

export const meta = {
  title: '文字当遮罩',
  duration: 3.4,
  source: 'shotcraft',
  sourcePath: 'references/shots/opening/text-as-mask.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const ENTER_DUR = 18 / FPS;      // 入场 18f
const DRIFT_A = 18 / FPS;
const DRIFT_B = 96 / FPS;        // 字内漂移 78f
const INHALE_A = 96 / FPS;
const INHALE_B = 104 / FPS;
const RUSH_A = 104 / FPS;
const RUSH_B = 128 / FPS;        // 冲入 24f
const TAKE_MAX = 46;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const inOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

/** 对数空间插值：S = s0·(46/s0)^(t^1.8)。 */
function rushScale(u) {
  const s0 = 0.965;
  const t = Math.pow(clamp01(u), 1.8);
  return s0 * Math.pow(TAKE_MAX / s0, t);
}

/** 产品面板：暗色渲染看板（大块饱和色 + 亮线，透进笔画才读得出）。 */
function drawDashPanel(ctx, x, y, w, h, t, src, scale) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#0b1220');
  g.addColorStop(0.55, '#0d1526');
  g.addColorStop(1, '#080d16');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  if (src) {
    const sw = src.width || w;
    const sh = src.height || h;
    const k = Math.max(w / sw, h / sh) * 1.06;
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.drawImage(src, (w - sw * k) / 2, (h - sh * k) / 2, sw * k, sh * k);
    ctx.restore();
  }

  // 流式面积图：持续向左流（产品活着）
  const flow = ((t * 0.12) % 1) * w * 0.5;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, h * 0.34, w, h * 0.66);
  ctx.clip();
  const area = ctx.createLinearGradient(0, h * 0.4, 0, h);
  area.addColorStop(0, 'rgba(64, 160, 255, 0.55)');
  area.addColorStop(0.6, 'rgba(36, 112, 230, 0.28)');
  area.addColorStop(1, 'rgba(20, 70, 160, 0.05)');
  ctx.fillStyle = area;
  ctx.beginPath();
  ctx.moveTo(-w * 0.1, h);
  for (let i = 0; i <= 40; i += 1) {
    const px = -w * 0.1 + (i / 40) * w * 1.2 - flow;
    const py = h * (0.62 - 0.16 * Math.sin(i * 0.42 + t * 0.6) - 0.06 * Math.sin(i * 1.1));
    ctx.lineTo(px, py);
  }
  ctx.lineTo(w * 1.1, h);
  ctx.closePath();
  ctx.fill();
  // 亮线
  ctx.strokeStyle = 'rgba(150, 226, 255, 0.95)';
  ctx.lineWidth = Math.max(1.5, h * 0.006);
  ctx.beginPath();
  for (let i = 0; i <= 40; i += 1) {
    const px = -w * 0.1 + (i / 40) * w * 1.2 - flow;
    const py = h * (0.62 - 0.16 * Math.sin(i * 0.42 + t * 0.6) - 0.06 * Math.sin(i * 1.1));
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.restore();

  // 渲染队列柱状图（呼吸）
  for (let i = 0; i < 9; i += 1) {
    const bh = h * (0.08 + 0.1 * Math.abs(Math.sin(i * 0.9 + t * 1.4)));
    ctx.fillStyle = 'rgba(120, 190, 255, 0.5)';
    ctx.fillRect(w * (0.08 + i * 0.06), h * 0.9 - bh, w * 0.032, bh);
  }

  // 眉题 + 计数
  ctx.fillStyle = 'rgba(210, 232, 255, 0.95)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '700 ' + Math.round(h * 0.045) + 'px system-ui, sans-serif';
  ctx.fillText('VIDEO-SHOTCRAFT', w * 0.08, h * 0.12);
  ctx.fillStyle = 'rgba(150, 200, 255, 0.7)';
  ctx.font = '500 ' + Math.round(h * 0.03) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('FRAMES  ' + String(240 + Math.floor(t * 8)).padStart(4, '0') + ' / 240', w * 0.08, h * 0.19);
  ctx.restore();
}

/**
 * 遮罩表面：OffscreenCanvas → DOM canvas → null。
 * 返回 { canvas, ctx, mode }；mode 会进自检和测试，别改名。
 */
function scratchSurface(W, H) {
  if (typeof OffscreenCanvas === 'function') {
    try {
      const cv = new OffscreenCanvas(Math.max(1, Math.round(W)), Math.max(1, Math.round(H)));
      const c = cv.getContext('2d');
      if (c) return { canvas: cv, ctx: c, mode: 'offscreen' };
    } catch {
      /* 继续尝试 DOM canvas */
    }
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    try {
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(W));
      cv.height = Math.max(1, Math.round(H));
      const c = cv.getContext('2d');
      if (c) return { canvas: cv, ctx: c, mode: 'dom' };
    } catch {
      /* 落到 null */
    }
  }
  return null;
}

/** 遮罩表面缓存：尺寸/文案不变就复用同一张离屏画布，避免每帧分配。 */
const scratchCache = { key: '', surface: null };
let lastMask = { mode: 'none', opaque: 0, built: 0, frames: 0, failed: 0 };

/** 只读诊断：上次遮罩是怎么建的、有没有像素。测试与排障用，不影响渲染。 */
export function maskInfo() {
  return {
    mode: lastMask.mode,
    opaque: lastMask.opaque,
    built: lastMask.built,
    frames: lastMask.frames,
    failed: lastMask.failed,
  };
}

/** 统计 alpha 像素（自检用：遮罩若是全透明，说明 destination-in 没生效）。 */
function countOpaque(ctx, W, H) {
  try {
    const data = ctx.getImageData(0, 0, Math.round(W), Math.round(H)).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) n += 1;
    return n;
  } catch {
    // 拿不到像素（某些环境 getImageData 被禁）时不下结论，返回 -1
    return -1;
  }
}

/**
 * 建一张「字形窗口里透出面板」的遮罩。
 * panX 是面板在字形窗口里相对中心的位移（字内漂移），字形窗口本身不动。
 * 返回 { canvas, mode } 或 null（建不出来 → 调用方走降级，不许假装成功）。
 */
function buildTextMask(W, H, word, fontSize, weight, tracking, src, time, panX) {
  const key = Math.round(W) + 'x' + Math.round(H) + '|' + word + '|' + fontSize + '|' + weight + '|' + tracking;
  if (scratchCache.key !== key || !scratchCache.surface) {
    const surface = scratchSurface(W, H);
    scratchCache.key = key;
    scratchCache.surface = surface;
  }
  const surface = scratchCache.surface;
  if (!surface) {
    lastMask.mode = 'none';
    return null;
  }
  const c = surface.ctx;
  try {
    // 明确把状态摆正：上一帧可能停在 destination-in 或某个缩放上
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, W, H);

    // 面板铺满、并留出左右各 panX 的冗余，保证漂移时字内始终有内容
    c.save();
    c.translate(panX, 0);
    drawDashPanel(c, -Math.abs(panX), 0, W + Math.abs(panX) * 2, H, time, src, 1);
    c.restore();

    // 只保留字形里的像素。
    // 整词一次 fillText：逐字排版在离屏上下文里量出来的字宽会和舞台上的不一致
    // （同一字号、不同上下文，字宽能差一倍），结果是字全被推到画布外、遮罩整张空白。
    // 字距交给 letterSpacing（有就设，没有就是默认字距，差别很小）。
    c.globalCompositeOperation = 'destination-in';
    c.fillStyle = '#ffffff';
    c.font = weight + ' ' + fontSize + 'px system-ui, "Segoe UI", sans-serif';
    if ('letterSpacing' in c) {
      try {
        c.letterSpacing = tracking + 'px';
      } catch {
        /* 不支持就算了 */
      }
    }
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(word, W * 0.5, H * 0.5);
    if ('letterSpacing' in c) {
      try {
        c.letterSpacing = '0px';
      } catch {
        /* 同上 */
      }
    }
    c.globalCompositeOperation = 'source-over';

    // 自检：0 像素 = 这张遮罩是空的，宁可降级也不许假装
    const opaque = countOpaque(c, W, H);
    lastMask.mode = surface.mode;
    lastMask.opaque = opaque;
    lastMask.built += 1;
    if (opaque === 0) {
      lastMask.failed += 1;
      return null;
    }
    return { canvas: surface.canvas, mode: surface.mode };
  } catch {
    lastMask.failed += 1;
    return null;
  }
}

function __renderInner(ctx, t, env) {
  const W = Number(env && env.width) || 1;
  const H = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const time = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
  const m = env && env.media;
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);
  const src = id && m ? (m.image(id) || m.video(id)) : null;

  const word = String(props.word || 'SHOTCRAFT');
  const fontSize = Math.round(H * 0.652);   // 470/720
  const tracking = -H * 0.0305;             // −22/720
  const textX = W * 0.5;
  const textY = H * 0.5;

  // ---- 瓷白舞台 ----
  ctx.save();
  const stage = ctx.createRadialGradient(W * 0.5, H * 0.38, 0, W * 0.5, H * 0.5, W * 0.72);
  stage.addColorStop(0, '#fbfaf7');
  stage.addColorStop(0.6, '#f2f0eb');
  stage.addColorStop(1, '#dcd8d0');
  ctx.fillStyle = stage;
  ctx.fillRect(0, 0, W, H);
  const vg = ctx.createRadialGradient(W * 0.5, H * 0.5, Math.min(W, H) * 0.34, W * 0.5, H * 0.5, Math.max(W, H) * 0.82);
  vg.addColorStop(0, 'rgba(60, 54, 48, 0)');
  vg.addColorStop(1, 'rgba(60, 54, 48, 0.26)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  // 入场：遮罩从基线向上擦出（16f）+ 1.04→1 落定
  const enterP = outCubic(clamp01(time / ENTER_DUR));
  const enterScale = 1.04 + (1 - 1.04) * enterP;
  // 字内漂移：+150 → −150（两端轻缓）
  const driftU = inOut(clamp01((time - DRIFT_A) / (DRIFT_B - DRIFT_A)));
  const driftX = 150 - 300 * driftU;
  // 吸气 1 → 0.965，然后冲入
  const inhaleU = clamp01((time - INHALE_A) / (INHALE_B - INHALE_A));
  const inhale = 1 - 0.035 * inOut(inhaleU);
  const rushU = clamp01((time - RUSH_A) / (RUSH_B - RUSH_A));
  const scale = rushU > 0 ? rushScale(rushU) : inhale * enterScale;

  const mask = buildTextMask(W, H, word, fontSize, 900, tracking, src, time, driftX * (W / 1280));

  // 字形投影（同字形、带色相、模糊）：字像被挖进舞台的窗
  ctx.save();
  ctx.globalAlpha = 0.16 * enterP * (rushU > 0 ? 1 - clamp01(rushU * 3) : 1);
  ctx.font = '900 ' + fontSize + 'px system-ui, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(90, 74, 60, 1)';
  ctx.shadowColor = 'rgba(70, 56, 44, 0.9)';
  ctx.shadowBlur = fontSize * 0.06;
  ctx.fillText(word, textX + fontSize * 0.01, textY + fontSize * 0.02);
  ctx.restore();

  // 遮罩层：原点钉在实心笔画内（保证冲入时先撑满竖笔）
  const originX = textX - fontSize * 0.16;
  const originY = textY;
  ctx.save();
  // 入场：从基线向上擦出（clip 高度随 enterP 增加）
  ctx.beginPath();
  ctx.rect(0, textY + fontSize * 0.5 - fontSize * 1.02 * enterP, W, fontSize * 1.02 * enterP);
  ctx.clip();

  ctx.translate(originX, originY);
  ctx.scale(scale, scale);
  ctx.translate(-originX, -originY);

  if (mask) {
    // 字形窗口里透出的面板：遮罩已经是「面板 ∩ 字形」，直接整张贴
    ctx.drawImage(mask.canvas, 0, 0, W, H);
  } else {
    // 降级：不假装是遮罩。面板整屏压到低透明度 + 字形描边 + 明确文字说明。
    ctx.save();
    ctx.globalAlpha = 0.9;
    drawDashPanel(ctx, 0, 0, W, H, time, src, 1);
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#fbfaf7';
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(251, 250, 247, 0.9)';
    ctx.lineWidth = Math.max(2, fontSize * 0.012);
    ctx.font = '900 ' + fontSize + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeText(word, textX, textY);
    ctx.restore();
  }
  ctx.restore();

  // ---- 接管保险：竖笔撑满全屏之后才淡入全屏面板 ----
  const handoff = clamp01((rushU - 0.86) / 0.09);
  if (handoff > 0) {
    ctx.save();
    ctx.globalAlpha = handoff;
    drawDashPanel(ctx, 0, 0, W, H, time, src, 1);
    ctx.restore();
  }

  // 眉题 / 副题：入场时出现，吸气时 ease-in 退场
  const kickerP = outCubic(clamp01((time - 0.08) / 0.4)) * (1 - clamp01((time - INHALE_A) / (INHALE_B - INHALE_A)));
  if (kickerP > 0) {
    ctx.save();
    ctx.globalAlpha = kickerP * 0.7;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(66, 58, 50, 0.9)';
    ctx.font = '600 ' + Math.round(H * 0.03) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText(String(props.kicker || 'FROM ONE PROMPT TO A FINISHED LAUNCH FILM'), W * 0.5, H * 0.175);
    ctx.restore();
  }

  // 降级时的诚实标注（编辑器里一眼能看见，不在成片里）
  if (!mask) {
    ctx.save();
    ctx.globalAlpha = 0.72;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#7a2f1c';
    ctx.font = '600 ' + Math.round(H * 0.026) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText('无 OffscreenCanvas / DOM canvas → 遮罩降级为描边示意（不是字内透视）', W * 0.04, H * 0.94);
    ctx.restore();
  }

  // 右下 mono：遮罩倍率 + 遮罩通道（编辑期校对）
  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = rushU > 0.5 ? 'rgba(240, 246, 255, 0.75)' : 'rgba(90, 80, 70, 0.7)';
  ctx.font = '500 ' + Math.round(H * 0.024) + 'px ui-monospace, Menlo, monospace';
  const modeLabel = mask ? (mask.mode === 'offscreen' ? 'OFFSCREEN' : 'DOM') : 'FALLBACK';
  ctx.fillText('MASK ×' + scale.toFixed(2) + '  ·  ' + (handoff > 0 ? 'HANDOFF' : rushU > 0 ? 'RUSH' : 'DRIFT') + '  ·  ' + modeLabel, W * 0.95, H * 0.965);
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
    lastMask.frames += 1;
    __renderInner(ctx, t, env);
  } finally {
    ctx.restore();
  }
}
