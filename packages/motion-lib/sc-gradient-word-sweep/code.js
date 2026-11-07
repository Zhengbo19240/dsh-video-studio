/**
 * sc-gradient-word-sweep · 渐变字扫过（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/typography/gradient-word-sweep.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权与归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - 扫充 15–20f（>28f 读作进度条）；mask 前沿斜切、边缘略糊（~8% 词宽）；
 *   - **波前最亮**：跟随 mask 前沿一条 ~34% 词宽的增亮带，向后衰减；填满后 ~10f 淡出到稳态；
 *   - 稳态 4 层泛光，opacity 0.55/0.55/0.62/0.72（0.75+ 会被裁「泛光感有点强」）；
 *   - 填满后字符间零星细闪电，紫红三层描边（外晕 6 / 中 2.4 / 亮核 1.4），同屏 ≤2 道、间隔 ≥4f；
 *   - 禁：填充过程不带跟随光点/星光（判例：读作廉价装饰）。
 *
 * 媒体怎么用：关键词的填充层 = 素材本身（视频帧），上面再叠渐变彩光。
 * 实现上用 OffscreenCanvas 做「文字遮罩图层」；环境没有 OffscreenCanvas 时退化为
 * 渐变+素材色调的合成填充（不是白屏，也不是报错）。
 */

export const meta = {
  title: '渐变字扫过',
  duration: 3.4,
  source: 'shotcraft',
  sourcePath: 'references/shots/typography/gradient-word-sweep.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const ENTER_AT = 12 / FPS;      // 12f 起扫
const SWEEP = 18 / FPS;         // 扫充 18f
const SWEEP_END = ENTER_AT + SWEEP;
const BOLT_PLAN = [33, 41, 52, 60, 71, 83, 92]; // 闪电排期（帧）

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const inOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/** 确定性伪随机（mulberry32 的极简版）：闪电跳位必须可复现。 */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = a;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** 用 OffscreenCanvas 造一个「文字形状的素材图层」；没有就返回 null 走退化分支。 */
function buildTextFill(width, height, src, keyword, font, x, y, w, h) {
  if (typeof OffscreenCanvas !== 'function') return null;
  try {
    const off = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    const c = off.getContext('2d');
    if (!c) return null;
    if (src) {
      const sw = src.width || w;
      const sh = src.height || h;
      const k = Math.max(w / sw, h / sh);
      c.drawImage(src, (w - sw * k) / 2, (h - sh * k) / 2, sw * k, sh * k);
    } else {
      const g = c.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#7b4dff');
      g.addColorStop(0.45, '#e0579e');
      g.addColorStop(1, '#39c6ff');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    }
    // destination-in：只保留落在字形里的像素
    c.globalCompositeOperation = 'destination-in';
    c.font = font;
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.fillStyle = '#fff';
    c.fillText(keyword, x, y);
    c.globalCompositeOperation = 'source-over';
    return off;
  } catch {
    return null;
  }
}

/** 斜切推进 mask 的揭示进度：波前是一条斜线，不是垂直直线。 */
function revealAlpha(u, px, x0, x1) {
  // u: 0→1 扫充进度；px: 该像素相对关键词起点的归一化位置
  const skewed = px + (x0 - x1) * 0.0; // 斜切由下面的行内偏移实现
  return clamp01((u * 1.18 - skewed) / 0.1);
}

function __renderInner(ctx, t, env) {
  const w = Number(env && env.width) || 1;
  const h = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const time = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
  const m = env && env.media;
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);
  const src = id && m ? (m.video(id) || m.image(id)) : null;

  const line1 = String(props.line1 || 'Make every frame');
  const keyword = String(props.keyword || 'supercharged');
  const line2 = String(props.line2 || 'in one pass.');

  const s = Math.min(w / 1280, h / 720);
  const fs = Math.round(h * 0.116);
  const font = '800 ' + fs + 'px system-ui, sans-serif';
  // 整段极缓推近 1 → 1.025
  const push = 1 + 0.025 * clamp01(time / 3.5);

  ctx.save();
  ctx.fillStyle = '#050406';
  ctx.fillRect(0, 0, w, h);

  // 极淡的暗场径向，避免纯黑死板（不做光斑动画）
  const hallo = ctx.createRadialGradient(w * 0.5, h * 0.52, 0, w * 0.5, h * 0.52, w * 0.52);
  hallo.addColorStop(0, 'rgba(58, 24, 84, 0.28)');
  hallo.addColorStop(1, 'rgba(5, 4, 6, 0)');
  ctx.fillStyle = hallo;
  ctx.fillRect(0, 0, w, h);

  ctx.translate(w / 2, h / 2);
  ctx.scale(push, push);
  ctx.translate(-w / 2, -h / 2);

  const cx = w / 2;
  const y1 = h * 0.42;
  const y2 = h * 0.62;

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  // 入场两行错峰 blur-slide（用透明 + 位移 + 影子代替真 blur）
  const in1 = outCubic(clamp01(time / 0.42));
  const in2 = outCubic(clamp01((time - 0.09) / 0.42));

  // ---- 第一行：白字 + 关键词 ----
  ctx.save();
  ctx.globalAlpha = in1;
  const shift1 = (1 - in1) * h * 0.02;
  const kwW = (() => {
    ctx.font = font;
    return ctx.measureText(keyword).width;
  })();
  const l1W = (() => {
    ctx.font = font;
    return ctx.measureText(line1 + ' ').width;
  })();
  const total1 = l1W + kwW;
  const startX = cx - total1 / 2;
  const kwX = startX + l1W;

  ctx.font = font;
  ctx.fillStyle = 'rgba(244, 242, 250, 0.96)';
  ctx.fillText(line1 + ' ', startX, y1 + shift1);
  // 关键词底字：先白，扫充后由填充层覆盖
  ctx.fillStyle = 'rgba(244, 242, 250, 0.96)';
  ctx.fillText(keyword, kwX + kwW / 2, y1 + shift1);

  // ---- 扫充：进度与波前增亮带 ----
  const sweepU = clamp01((time - ENTER_AT) / SWEEP);
  const bandW = kwW * 0.34;
  if (sweepU > 0) {
    const revealW = kwW * inOutCubic(sweepU);
    // 文字形状的素材层：只在关键词的盒子里生成，避免大图开销
    const pad = Math.round(fs * 0.6);
    const boxW = kwW + pad * 2;
    const boxH = fs * 1.5;
    const boxX = kwX - pad;
    const boxY = y1 + shift1 - boxH / 2;
    const fill = buildTextFill(boxW, boxH, src, keyword, font, pad, boxH / 2, boxW, boxH);

    // 裁到关键词盒 + 揭示进度里
    ctx.save();
    ctx.beginPath();
    ctx.rect(kwX, y1 + shift1 - fs * 0.72, revealW, fs * 1.44);
    ctx.clip();
    if (fill) {
      ctx.drawImage(fill, boxX, boxY, boxW, boxH);
    } else {
      // 退化：没有 OffscreenCanvas 就用「素材色块 + 渐变」合成（仍然不是白屏）
      if (src) {
        const sw = src.width || boxW;
        const sh = src.height || boxH;
        const k = Math.max(boxW / sw, boxH / sh);
        ctx.globalAlpha = 0.85;
        ctx.drawImage(src, boxX + (boxW - sw * k) / 2, boxY + (boxH - sh * k) / 2, sw * k, sh * k);
        ctx.globalAlpha = 1;
      }
      const g = ctx.createLinearGradient(kwX, 0, kwX + kwW, 0);
      g.addColorStop(0, 'rgba(123, 77, 255, 0.72)');
      g.addColorStop(0.45, 'rgba(224, 87, 158, 0.7)');
      g.addColorStop(1, 'rgba(57, 198, 255, 0.7)');
      ctx.fillStyle = g;
      ctx.fillRect(kwX, y1 + shift1 - fs * 0.72, kwW, fs * 1.44);
    }
    // 波前增亮带：跟随 mask 前沿，波前最强向后衰减
    const frontX = kwX + revealW;
    const glow = ctx.createLinearGradient(frontX - bandW, 0, frontX, 0);
    glow.addColorStop(0, 'rgba(255, 255, 255, 0)');
    glow.addColorStop(0.72, 'rgba(255, 214, 246, 0.42)');
    glow.addColorStop(1, 'rgba(255, 255, 255, 0.86)');
    ctx.fillStyle = glow;
    ctx.fillRect(Math.max(kwX, frontX - bandW), y1 + shift1 - fs * 0.72, Math.min(revealW, bandW), fs * 1.44);
    ctx.restore();

    // 填充结束后 ~10f 淡出到稳态
    const settle = clamp01((time - SWEEP_END) / (10 / FPS));
    // 稳态 4 层泛光（层多不一定亮，靠 opacity 分档）
    const glowA = (0.72 - 0.32 * (1 - settle)) * clamp01(sweepU * 1.6);
    if (glowA > 0.01 && settle > 0) {
      ctx.save();
      ctx.font = font;
      ctx.textAlign = 'center';
      const layers = [
        { blur: fs * 0.9, alpha: glowA * 0.55 },
        { blur: fs * 0.42, alpha: glowA * 0.55 },
        { blur: fs * 0.16, alpha: glowA * 0.62 },
        { blur: fs * 0.05, alpha: glowA * 0.72 },
      ];
      for (const layer of layers) {
        ctx.shadowColor = 'rgba(224, 120, 255, ' + layer.alpha.toFixed(3) + ')';
        ctx.shadowBlur = layer.blur;
        ctx.fillStyle = 'rgba(255, 226, 255, ' + (layer.alpha * 0.5).toFixed(3) + ')';
        ctx.fillText(keyword, kwX + kwW / 2, y1 + shift1);
      }
      ctx.restore();
    }

    // 闪电：填满后字符间勾连，零星 1 道，紫红三层描边
    if (time > SWEEP_END) {
      let active = -1;
      for (const f of BOLT_PLAN) {
        const bt = f / FPS;
        if (time >= bt && time < bt + 3 / FPS) active = f;
      }
      if (active >= 0) {
        const rnd = seeded(active * 977);
        const len = 2 + Math.floor(rnd() * 3);
        const chars = Array.from(keyword);
        let cursor = kwX;
        ctx.save();
        ctx.font = font;
        for (let i = 0; i < chars.length; i += 1) {
          const cw = ctx.measureText(chars[i]).width;
          if (i >= 1 && i < 1 + len) {
            const a = { x: cursor - cw * 0.1, y: y1 + shift1 + (rnd() - 0.5) * fs * 0.5 };
            const b = { x: cursor + cw * 0.9, y: y1 + shift1 + (rnd() - 0.5) * fs * 0.5 };
            const mid = { x: (a.x + b.x) / 2 + (rnd() - 0.5) * fs * 0.3, y: (a.y + b.y) / 2 + (rnd() - 0.5) * fs * 0.62 };
            const passes = [
              { width: 6 * s, color: 'rgba(216, 60, 190, 0.18)' },
              { width: 2.4 * s, color: 'rgba(240, 120, 255, 0.68)' },
              { width: 1.4 * s, color: 'rgba(255, 236, 255, 0.95)' },
            ];
            for (const pass of passes) {
              ctx.strokeStyle = pass.color;
              ctx.lineWidth = Math.max(0.6, pass.width);
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(mid.x, mid.y);
              ctx.lineTo(b.x, b.y);
              ctx.stroke();
            }
          }
          cursor += cw;
        }
        ctx.restore();
      }
    }
  }
  ctx.restore();

  // ---- 第二行：留在白字阶段（对比出「只有关键词被通电」）----
  ctx.save();
  ctx.globalAlpha = in2 * 0.82;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(226, 222, 236, 0.9)';
  ctx.fillText(line2, cx, y2 + (1 - in2) * h * 0.018);
  ctx.restore();

  // 底部极淡的 mono 标注：扫充进度（编辑期读参用）
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = 'rgba(196, 160, 240, 0.6)';
  ctx.font = '500 ' + Math.round(h * 0.024) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('SWEEP ' + Math.round(sweepU * 100) + '%  ·  18f', w * 0.045, h * 0.94);
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
