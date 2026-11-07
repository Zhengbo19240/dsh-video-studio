/**
 * sc-marker-underline-title · 马克笔下划线（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/typography/marker-underline-title.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - 划线 10f 一笔呵成（14f 版被判偏慢，>14f 读作进度条）；
 *   - **贴字底** ≈ -0.1em；**跟字势**：左低右高微上斜（画反一眼假，返工判例）；
 *   - 笔形变宽：中段 ~0.12em，首尾 ~0.6x；边缘轻噪声（太糙读作故障，全平滑读作 CSS border）；
 *   - 时机：标题完全落定后 +4~8f 起笔（与标题同动就抢戏），ease-out 微收尾＝手劲；
 *   - demo 节奏：标题两行错峰 22f 落定 → f32–42 划线 → 静止 33f。
 *
 * 媒体怎么用：这一笔「马克笔」的墨是被素材喂的 —— 笔画形状里铺素材帧，再压一层暖墨 multiply。
 * 没素材时退回实心赤陶墨（仍然是完整的一笔，不是空白）。
 */

export const meta = {
  title: '马克笔下划线',
  duration: 3.2,
  source: 'shotcraft',
  sourcePath: 'references/shots/typography/marker-underline-title.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const TITLE_AT = 0;
const LINE1_AT = 2 / FPS;
const LINE2_AT = 12 / FPS;
const LINE_SETTLE = 22 / FPS;
const MARK_AT = 32 / FPS;      // 标题落定后 +4f 起笔
const MARK_DUR = 10 / FPS;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const outQuint = (x) => 1 - Math.pow(1 - clamp01(x), 5);

/** 确定性噪声：毛糙边必须可复现（真随机会渲染间抖动）。 */
function noise(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * 笔画形状（局部坐标：x∈[0,len]，y 以 0 为笔画中线）：
 * 变宽笔形（中段最宽、首尾 0.6x）+ 微上斜 + 边缘轻噪声。
 */
function strokeBand(ctx, len, thick, slant, rough) {
  const steps = 26;
  const top = [];
  const bottom = [];
  for (let i = 0; i <= steps; i += 1) {
    const u = i / steps;
    const x = len * u;
    // 中间最宽：sin 隆起，端部 0.6x
    const wProfile = (0.6 + 0.4 * Math.sin(u * Math.PI)) * thick;
    // 微上斜（左低右高 → y 随 x 减小）
    const spine = -slant * u;
    const wob = (noise(i * 3.7) - 0.5) * rough;
    top.push([x, spine - wProfile / 2 + wob]);
    bottom.push([x, spine + wProfile / 2 - (noise(i * 5.1 + 9) - 0.5) * rough]);
  }
  ctx.beginPath();
  ctx.moveTo(top[0][0], top[0][1]);
  for (let i = 1; i < top.length; i += 1) ctx.lineTo(top[i][0], top[i][1]);
  for (let i = bottom.length - 1; i >= 0; i -= 1) ctx.lineTo(bottom[i][0], bottom[i][1]);
  ctx.closePath();
}

/** 手写体的字底位置：关键词起止（用 measureText 反解，别硬编码）。 */
function keywordRange(ctx, font, line, keyword) {
  ctx.font = font;
  const at = line.indexOf(keyword);
  if (at < 0) return { x0: 0, x1: ctx.measureText(line).width };
  const before = ctx.measureText(line.slice(0, at)).width;
  const kw = ctx.measureText(keyword).width;
  return { x0: before, x1: before + kw };
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
  const line1 = String(props.line1 || 'Now everything');
  const line2 = String(props.line2 || 'is finally free');
  const keyword = String(props.keyword || 'free');

  const fs = Math.round(H * 0.108);
  const font = '700 ' + fs + 'px system-ui, sans-serif';
  const italicFont = 'italic 700 ' + fs + 'px system-ui, sans-serif';

  ctx.save();
  // 暖白纸面 + 极淡纹理（马克笔要在纸上才成立）
  const paper = ctx.createLinearGradient(0, 0, W * 0.4, H);
  paper.addColorStop(0, '#f7f3ea');
  paper.addColorStop(0.6, '#f2ece0');
  paper.addColorStop(1, '#e9e1d3');
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = 'rgba(170, 150, 122, 0.16)';
  ctx.lineWidth = 1;
  for (let y = 0; y < H; y += Math.max(3, 5 * s)) {
    ctx.beginPath();
    ctx.moveTo(0, y + Math.sin(y * 0.05) * 2);
    ctx.lineTo(W, y + Math.cos(y * 0.04) * 2);
    ctx.stroke();
  }
  ctx.restore();

  // 两行标题：错峰 22f 落定（先落第一行，第二行跟上）
  const lines = [
    { text: line1, at: LINE1_AT, y: H * 0.44, weight: 700 },
    { text: line2, at: LINE2_AT, y: H * 0.44 + fs * 1.22, weight: 700 },
  ];
  const leftX = W * 0.14;

  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    const p = outQuint(clamp01((time - l.at) / (LINE_SETTLE - l.at)));
    ctx.save();
    ctx.globalAlpha = clamp01(p * 1.4);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = i === 1 ? italicFont : font;
    ctx.fillStyle = 'rgba(34, 30, 26, 0.95)';
    // 落定：从下方 12px 抬上来（安静，不是弹跳）
    ctx.fillText(l.text, leftX, l.y + (1 - p) * fs * 0.16);

    // 第二行里的关键词：先靠「字重/颜色」被读出来（但还不划线）
    if (i === 1) {
      const range = keywordRange(ctx, italicFont, l.text, keyword);
      ctx.save();
      ctx.font = italicFont;
      ctx.fillStyle = 'rgba(34, 30, 26, 0.98)';
      ctx.fillText(keyword, leftX + range.x0, l.y + (1 - p) * fs * 0.16);
      ctx.restore();
    }
    ctx.restore();
  }

  // ---- 马克笔下划线 ----
  const markP = clamp01((time - MARK_AT) / MARK_DUR);
  if (markP > 0) {
    const eased = outCubic(markP);
    ctx.save();
    ctx.font = italicFont;
    const range = keywordRange(ctx, italicFont, line2, keyword);
    const lineY = H * 0.44 + fs * 1.22 + fs * 0.1;   // 贴字底 ≈ -0.1em（基线下方）
    const len = (range.x1 - range.x0) * (1 + 0.06);   // 右端略微冲出字宽（手写会冲）
    const thick = fs * 0.12;
    const slant = fs * 0.14;                         // 左低右高微上斜
    const rough = fs * 0.012;

    ctx.translate(leftX + range.x0 - fs * 0.02, lineY);
    // 用 clip 做「从左到右的描画」：笔画形状按 eased 比例截断
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, -thick * 2, len * eased, thick * 4);
    ctx.clip();

    // 笔画形状里铺素材（被墨喂过的马克笔）
    ctx.save();
    strokeBand(ctx, len, thick, slant, rough);
    ctx.clip();
    if (src) {
      const sw = src.width || len;
      const sh = src.height || thick * 4;
      const k = Math.max(len / sw, (thick * 3) / sh);
      ctx.drawImage(src, (len - sw * k) / 2, -thick * 1.5, sw * k, sh * k);
      // 暖墨 multiply：素材要有颜色但不抢字
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = 'rgba(196, 118, 44, 0.62)';
      ctx.fillRect(-thick, -thick * 2, len + thick * 2, thick * 4);
      ctx.globalCompositeOperation = 'source-over';
    } else {
      // 无素材：实心赤陶墨（仍然是一笔完整的笔迹，不是空白）
      ctx.fillStyle = 'rgba(206, 124, 52, 0.9)';
      ctx.fillRect(-thick, -thick * 2, len + thick * 2, thick * 4);
      ctx.restore();
      ctx.save();
      strokeBand(ctx, len, thick, slant, rough);
      ctx.strokeStyle = 'rgba(150, 78, 26, 0.34)';
      ctx.lineWidth = Math.max(1, fs * 0.008);
      ctx.stroke();
    }
    ctx.restore();

    // 干笔飞白：沿笔向拉长的高频噪声阈值
    ctx.save();
    strokeBand(ctx, len, thick, slant, rough);
    ctx.clip();
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 26; i += 1) {
      const n1 = noise(i * 1.7 + 3);
      const n2 = noise(i * 2.3 + 11);
      ctx.globalAlpha = 0.12 + n2 * 0.3;
      ctx.fillStyle = 'rgba(0,0,0,1)';
      ctx.fillRect(n1 * len, -thick * 0.6 + n2 * thick * 0.6, len * 0.06 + n1 * 0.1 * len, thick * 0.05);
    }
    ctx.restore();

    // 笔尖痕迹：收笔处略淡（ease-out 微收尾＝手劲）
    if (markP < 1) {
      ctx.save();
      ctx.globalAlpha = 0.5 * (1 - markP);
      ctx.fillStyle = 'rgba(120, 70, 30, 1)';
      ctx.beginPath();
      ctx.ellipse(len * eased, 0, thick * 0.38, thick * 0.44, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    ctx.restore();
  }

  // 页脚：手写批注式的小字（说明这一笔的身份）
  ctx.save();
  const noteP = clamp01((time - MARK_AT - MARK_DUR) / 0.3);
  if (noteP > 0) {
    ctx.globalAlpha = noteP * 0.6;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(96, 82, 66, 0.9)';
    ctx.font = '500 ' + Math.round(H * 0.024) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText(
      src ? 'MARKER INK = props.assetId' : 'MARKER INK · props.assetId 未给 → 实心墨',
      W * 0.14, H * 0.86,
    );
  }
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
