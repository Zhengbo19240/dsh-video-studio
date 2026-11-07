/**
 * sc-letterspace-materialize · 字距材质化（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/opening/letterspace-materialize.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - 字标不是淡入也不是打字机，而是「结晶」：**全部字母同帧起笔、同帧收笔**（零错峰）；
 *   - **连续**：笔画是连续画出的过程，不许遮罩分段（任何中间帧都该像「写到一半」）；
 *   - 字形方正略宽（字面宽高比 ~1.07）、细笔画 + 大字距（≈0.6em）；
 *   - 描画 ~50f（f16 起 f68 收），整体 ease-in-out、中段略快首尾略缓；
 *   - 终态静置 ≥30f：结晶完成后必须让观众读一次整词；
 *   - 底景是氛围空镜（= 素材），字标是画面唯一动作。
 *
 * 与卡文的偏差（已记在 meta.calibrationNote）：Canvas2D 拿不到字体的骨架笔画路径，
 * 这里用**字形轮廓的 dash 描画**代替 SVG 骨架 path（strokeText + lineDashOffset 从满长走到 0），
 * 仍然是「同帧起笔、连续生长、同帧齐收」，但描的是轮廓不是单线骨架。
 */

export const meta = {
  title: '字距材质化',
  duration: 3.8,
  source: 'shotcraft',
  sourcePath: 'references/shots/opening/letterspace-materialize.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const STILL = 15 / FPS;      // 静置 ~15f
const DRAW_AT = 16 / FPS;
const DRAW_END = 68 / FPS;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** 整体 ease-in-out、中段略快首尾略缓（起笔收笔的手感）。 */
function penEase(u) {
  const p = clamp01(u);
  // 复合：0.42 的三次 in-out 叠一点正弦，中段更利落
  const cubic = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  return cubic * 0.72 + (0.5 - 0.5 * Math.cos(p * Math.PI)) * 0.28;
}

function __renderInner(ctx, t, env) {
  const w = Number(env && env.width) || 1;
  const h = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const time = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
  const m = env && env.media;
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);
  const src = id && m ? (m.video(id) || m.image(id)) : null;

  const s = Math.min(w / 1280, h / 720);
  const word = String(props.word || 'shotcraft');
  const chars = Array.from(word);

  // ---- 底景：暮色山景（素材）；没有素材就画一个暮色渐变 + 山形剪影 ----
  // 整段极缓推近 1 → 1.03（字标是唯一动作，底景只呼吸）
  const push = 1 + 0.03 * clamp01(time / 3.8);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(push, push);
  ctx.translate(-w / 2, -h / 2);

  if (src) {
    const sw = src.width || w;
    const sh = src.height || h;
    const k = Math.max(w / sw, h / sh);
    ctx.drawImage(src, (w - sw * k) / 2, (h - sh * k) / 2, sw * k, sh * k);
    // 压暗：字标必须读得出来
    const dim = ctx.createLinearGradient(0, 0, 0, h);
    dim.addColorStop(0, 'rgba(6, 8, 14, 0.34)');
    dim.addColorStop(0.5, 'rgba(6, 8, 14, 0.5)');
    dim.addColorStop(1, 'rgba(6, 8, 14, 0.68)');
    ctx.fillStyle = dim;
    ctx.fillRect(0, 0, w, h);
  } else {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#1b2236');
    sky.addColorStop(0.4, '#3d3b52');
    sky.addColorStop(0.62, '#7a5a58');
    sky.addColorStop(0.76, '#c07a52');
    sky.addColorStop(1, '#2a1e1c');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    // 三层山脊剪影（越远越淡）
    const ridges = [
      { y: 0.62, amp: 0.05, color: 'rgba(38, 34, 52, 0.55)' },
      { y: 0.72, amp: 0.075, color: 'rgba(28, 24, 36, 0.72)' },
      { y: 0.83, amp: 0.045, color: 'rgba(16, 14, 22, 0.92)' },
    ];
    for (let r = 0; r < ridges.length; r += 1) {
      const ridge = ridges[r];
      ctx.fillStyle = ridge.color;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i <= 32; i += 1) {
        const x = (i / 32) * w;
        const y = h * (ridge.y + Math.sin(i * 0.7 + r * 2.1) * ridge.amp + Math.cos(i * 1.9) * ridge.amp * 0.4);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();
    }
    // 占位说明：只在底部极淡一行，不抢字标
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(238, 226, 214, 0.6)';
    ctx.font = '500 ' + Math.round(h * 0.024) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText('底景待素材 → props.assetId（暮色空镜 / 实拍底）', w * 0.5, h * 0.93);
    ctx.restore();
  }

  // ---- 字标：全部字符同帧起笔、同帧齐收 ----
  const p = penEase((time - DRAW_AT) / (DRAW_END - DRAW_AT));
  const trackRatio0 = Number.isFinite(Number(props.track)) ? Number(props.track) : 0.6;
  let fontSize = Math.round(Math.min(h * 0.2, w * 0.16));
  {
    // 大字距是这张卡的身份，但字标必须完整在画内：超过 88% 画宽就等比收字号
    ctx.save();
    ctx.font = '500 ' + fontSize + 'px system-ui, "Segoe UI", sans-serif';
    let tw = 0;
    for (const ch of Array.from(word)) tw += ctx.measureText(ch).width + trackRatio0 * fontSize;
    ctx.restore();
    if (tw > w * 0.88) fontSize = Math.max(10, Math.floor((fontSize * (w * 0.88)) / tw));
  }
  const trackRatio = Number.isFinite(Number(props.track)) ? Number(props.track) : 0.6;
  const font = '500 ' + fontSize + 'px system-ui, "Segoe UI", sans-serif';

  ctx.save();
  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  // 先量一次总宽（字距 0.6em，这是本卡的身份，不能压）
  const gap = fontSize * trackRatio;
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + gap * (chars.length - 1);
  const startX = w * 0.5 - total / 2;
  // 方正略宽：canvas 字形本身不是 1.07 宽高比，这里做一次水平拉伸
  const aspectFix = 1.07;
  const baseY = h * 0.5;

  ctx.translate(startX, baseY);
  ctx.scale(aspectFix, 1);

  // 每个字符的轮廓长度估算：笔画周长 ≈ (宽 + 高) * 2 * 系数
  for (let i = 0; i < chars.length; i += 1) {
    const cw = widths[i];
    const cx = (widths.slice(0, i).reduce((a, b) => a + b, 0) + gap * i) / aspectFix;
    const perimeter = (cw + fontSize) * 2 * 0.95;

    ctx.save();
    // 极淡的底字：让「字标的位置」在起笔前就已经成立（不是凭空出现）
    ctx.globalAlpha = 0.08 * (0.6 + 0.4 * clamp01(time / (STILL + 0.2)));
    ctx.fillStyle = 'rgba(246, 240, 234, 0.9)';
    ctx.fillText(chars[i], cx, 0);
    ctx.restore();

    if (p > 0) {
      ctx.save();
      // dash 描画：从「整块空白」走到「整圈画完」
      const dashLen = perimeter;
      ctx.setLineDash([dashLen, dashLen * 2]);
      ctx.lineDashOffset = dashLen * (1 - p);
      ctx.strokeStyle = 'rgba(250, 246, 240, 0.94)';
      ctx.lineWidth = Math.max(1.4, fontSize * 0.028);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeText(chars[i], cx, 0);
      ctx.setLineDash([]);
      // 笔尖：正在写的那一段的头部有一点点更亮（连续的证据）
      if (p < 1) {
        const tipX = cx + cw * (p * 1.1 % 1);
        ctx.fillStyle = 'rgba(255, 252, 246, 0.9)';
        ctx.beginPath();
        ctx.arc(tipX, -fontSize * 0.3 + (p * 2 % 1) * fontSize * 0.6, Math.max(1.2, fontSize * 0.022), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // 结晶完成：极淡填充一次（细笔画字标的「落定」），不是另一段动画
  const crystal = clamp01((time - DRAW_END) / (10 / FPS));
  if (crystal > 0) {
    ctx.save();
    ctx.globalAlpha = 0.16 * crystal;
    ctx.fillStyle = 'rgba(250, 246, 240, 1)';
    for (let i = 0; i < chars.length; i += 1) {
      const cx = (widths.slice(0, i).reduce((a, b) => a + b, 0) + gap * i) / aspectFix;
      ctx.fillText(chars[i], cx, 0);
    }
    ctx.restore();
  }
  ctx.restore();

  // ---- 眉题 / 副题：静置段才出现，轻到几乎只是「落款」 ----
  const kicker = clamp01((time - DRAW_END) / 0.4);
  if (kicker > 0) {
    ctx.save();
    ctx.globalAlpha = kicker * 0.72;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(240, 232, 224, 0.9)';
    ctx.font = '500 ' + Math.round(h * 0.024) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText(String(props.kicker || 'VIDEO-SHOTCRAFT · MOTION RECIPES'), w * 0.5, baseY + fontSize * 0.92);
    ctx.restore();
  }

  // 四周暗角：静谧感的收束
  const vg = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.28, w * 0.5, h * 0.5, Math.max(w, h) * 0.78);
  vg.addColorStop(0, 'rgba(4, 5, 9, 0)');
  vg.addColorStop(1, 'rgba(4, 5, 9, 0.62)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);

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
