/**
 * sc-text-column-converge · 文字列汇聚（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/typography/text-column-converge.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - **钉死是命门**：轮换期两词位置一像素不动、左右屏边距完全相等（原片实测 412 / 413 @1280）；
 *     任何渐进收缩都会提前剧透合拢、把揭晓稀释成进度条（判例：渐进收缩版被驳回重做）；
 *   - 词轮换纯硬切，停留帧数不均（16/12/9/8/7/8/10 @30fps，机器节奏带人味）；
 *   - **唯一一次合拢**：末词停稳 ~10f 后，36f ease-in-out（cubic）连续滑动到以屏幕中线居中定格；
 *     无 stamp 缩放、无二次补偿移动；
 *   - 合拢终点按等宽字体实际步进算（0.6em + letterSpacing × 字符数），两词恰好一空格咬合；
 *   - 定格 ~18f 后斜体小字近乎硬切浮现（4f 快淡、零位移）；
 *   - 质感：冷色深底 + 极淡顶光 + 暗角；词换瞬间 1 帧提亮；合拢中 NEW 从次级灰提亮到主色。
 */

export const meta = {
  title: '文字列汇聚',
  duration: 3.6,
  source: 'shotcraft',
  sourcePath: 'references/shots/typography/text-column-converge.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
// 停留帧数不均：机器节奏带人味
const DWELL = [16, 12, 9, 8, 7, 8, 10];
const WORDS = ['edits', 'grades', 'frames', 'renders', 'ships', 'scales', 'shotcraft'];
const DWELL_S = DWELL.map((f) => f / FPS);
const SWAP = DWELL_S.reduce((acc, d, i) => {
  acc.push((i === 0 ? 0 : acc[i - 1]) + DWELL_S[i - 1]);
  return acc;
}, []);
const LAST_SETTLE = SWAP[SWAP.length - 1] + DWELL_S[DWELL_S.length - 1];
const CONVERGE_AT = LAST_SETTLE + 10 / FPS;
const CONVERGE_DUR = 36 / FPS;
const SUB_AT = CONVERGE_AT + CONVERGE_DUR + 18 / FPS;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeInOutCubic = (x) => {
  const p = clamp01(x);
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
};

/** 当前是第几个词（纯硬切）。 */
function wordIndexAt(time) {
  let idx = 0;
  for (let i = 0; i < SWAP.length; i += 1) {
    if (time >= SWAP[i]) idx = i;
  }
  return idx;
}

function __renderInner(ctx, t, env) {
  const W = Number(env && env.width) || 1;
  const H = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const time = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
  const m = env && env.media;
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);
  const src = id && m ? (m.video(id) || m.image(id)) : null;

  // 这卡是「小字规格清单」气质：字号 = 屏幕宽的 3.28%（≈42@1280）
  const fs = Math.round(W * 0.0328);
  const font = '600 ' + fs + 'px ui-monospace, Menlo, "SF Mono", monospace';
  const margin = W * 0.322;            // 412/1280：左右完全相等
  const baseY = H * 0.5;

  const idx = wordIndexAt(time);
  const word = WORDS[Math.min(WORDS.length - 1, idx)];
  const leftText = String(props.left || 'NEW');
  const rightText = String(props.right || word);

  // 合拢
  const convU = easeInOutCubic(clamp01((time - CONVERGE_AT) / CONVERGE_DUR));
  const converging = convU > 0;

  ctx.save();
  // 冷色深底 + 极淡顶光 + 暗角 + 颗粒
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#14161c');
  bg.addColorStop(0.55, '#0e1015');
  bg.addColorStop(1, '#080a0e');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const topLight = ctx.createRadialGradient(W * 0.5, -H * 0.2, 0, W * 0.5, -H * 0.2, H * 1.2);
  topLight.addColorStop(0, 'rgba(150, 176, 220, 0.16)');
  topLight.addColorStop(1, 'rgba(150, 176, 220, 0)');
  ctx.fillStyle = topLight;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.globalAlpha = 0.05;
  for (let i = 0; i < 220; i += 1) {
    const hx = Math.sin(i * 12.9898) * 43758.5453;
    const hy = Math.sin(i * 78.233) * 43758.5453;
    const px = (hx - Math.floor(hx)) * W;
    const py = (hy - Math.floor(hy)) * H;
    ctx.fillStyle = '#dfe8ff';
    ctx.fillRect(px, py, 1, 1);
  }
  ctx.restore();

  ctx.font = font;
  ctx.textBaseline = 'middle';
  const leftW = ctx.measureText(leftText).width;
  const rightW = ctx.measureText(rightText).width;

  // 轮换期：左词左缘钉死、右词右缘钉死，间距**零收缩**
  let leftX = margin;
  let rightEdge = W - margin;

  if (converging) {
    // 合拢终点：两词以屏幕中线居中，恰好一空格咬合
    const spaceW = ctx.measureText(' ').width;
    const totalW = leftW + spaceW + rightW;
    const targetLeft = (W - totalW) / 2;
    leftX = margin + (targetLeft - margin) * convU;
    rightEdge = W - margin + (targetLeft + leftW + spaceW + rightW - (W - margin)) * convU;
  }

  // 词换瞬间 1 帧提亮：用「本词开始后的前 1 帧」判定
  const sinceSwap = time - SWAP[idx];
  const popFlash = sinceSwap >= 0 && sinceSwap < 1 / FPS ? 1 : 0;

  // 合拢滑动按速度加水平运动模糊（≤4px，静止为 0）
  const convSpeed = converging ? Math.abs(easeInOutCubic(clamp01((time + 1 / FPS - CONVERGE_AT) / CONVERGE_DUR)) - convU) : 0;
  const blurPx = Math.min(4, convSpeed * W * 0.5);

  // NEW 轮换期为次级灰、合拢中随进度提亮到主色
  const leftColor = 'rgba(' + Math.round(122 + 116 * convU) + ',' + Math.round(128 + 114 * convU) + ',' + Math.round(142 + 108 * convU) + ', 0.96)';
  const rightColor = 'rgba(242, 246, 255, ' + (0.94 + 0.06 * popFlash).toFixed(3) + ')';

  const passes = blurPx > 0.6 ? 3 : 1;
  for (let p = 0; p < passes; p += 1) {
    const bx = p === 0 ? 0 : (p - 2) * blurPx * 0.5;
    ctx.save();
    ctx.globalAlpha = p === 0 ? 1 : 0.2;
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = leftColor;
    ctx.fillText(leftText, leftX + bx, baseY);
    ctx.textAlign = 'right';
    ctx.fillStyle = rightColor;
    ctx.fillText(rightText, rightEdge + bx, baseY);
    ctx.restore();
  }

  // 右词右缘定位：换长换短右缘不动（用 rightAlign 已保证）
  // 合拢时露出咬合处的空格（视觉上就是缝隙轮廓），其余时间不画

  // 定格 +18f 后斜体小字近乎硬切浮现（4f 快淡、零位移）
  const subP = clamp01((time - SUB_AT) / (4 / FPS));
  if (subP > 0) {
    ctx.save();
    ctx.globalAlpha = subP * 0.72;
    ctx.font = 'italic 500 ' + Math.round(fs * 0.92) + 'px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(198, 208, 226, 0.9)';
    ctx.fillText(String(props.sub || 'CRAFT THE SHOT.'), margin, baseY + fs * 2.1);
    ctx.restore();
  }

  // 右下 mono：节拍与合拢状态（编辑期校对「钉死」是否真的零收缩）
  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(140, 156, 186, 0.4)';
  ctx.font = '500 ' + Math.round(H * 0.024) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText(
    'MARGIN ' + Math.round(margin) + '=' + Math.round(W - margin - W) + '  ·  WORD ' + (idx + 1) + '/' + WORDS.length + '  ·  ' + (converging ? 'CONVERGE ' + Math.round(convU * 100) + '%' : 'PINNED'),
    W * 0.95, H * 0.95,
  );
  ctx.restore();

  ctx.restore();
  void src;
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
