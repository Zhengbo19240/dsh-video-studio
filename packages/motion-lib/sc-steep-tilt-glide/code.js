/**
 * sc-steep-tilt-glide · 陡倾滑移（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/camera/steep-tilt-glide.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - **物动镜不动是命门**：perspective / origin / rotateY 全程常数（-60° 是用户精确定值，
 *     -45° 被裁「角度不对」、-53°「再大一点」），唯一动的量是页面局部 translateX；
 *   - 页面沿其 3D 横面方向 +60→-4100 滑移，bezier(0.3,0.12,0.72,0.9)：
 *     起步柔和后近匀速，**尾段斜率不归零**（中途停死被抓、全 linear 又少了起步呼吸）；
 *   - 速度重影：拖尾层 = 过去 f-1.6 / -3.2 / -4.8 的局部位置重投影，透明度 ∝ 滑移速度；
 *   - 悬空贴落：元素悬浮 230–280px 带同形软影，随滑移进程错峰贴落；
 *   - 揭亮：起始面板压暗 0.7，~1.4s 揭到全亮；左缘额外渐变阴影同退。
 */

export const meta = {
  title: '陡倾滑移',
  duration: 4.0,
  source: 'shotcraft',
  sourcePath: 'references/shots/camera/steep-tilt-glide.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const SLIDE_FROM = 60;
const SLIDE_TO = -4100;
const TILT_Y = -60;         // 用户精确定值，别动
const TILT_Z = -2;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);

/** bezier(0.3, 0.12, 0.72, 0.9)：尾段斜率不归零。 */
function glideEase(u) {
  const p = clamp01(u);
  let lo = 0;
  let hi = 1;
  let q = p;
  for (let i = 0; i < 18; i += 1) {
    const bx = 3 * (1 - q) * (1 - q) * q * 0.3 + 3 * (1 - q) * q * q * 0.72 + q * q * q;
    if (bx < p) lo = q;
    else hi = q;
    q = (lo + hi) / 2;
  }
  return 3 * (1 - q) * (1 - q) * q * 0.12 + 3 * (1 - q) * q * q * 0.9 + q * q * q;
}

function slideAt(time) {
  return SLIDE_FROM + (SLIDE_TO - SLIDE_FROM) * glideEase(clamp01(time / 3.4));
}

/** 常数机位：perspective 1100、origin 30% 58%、rotateY(-60°) + rotateZ(-2°)。 */
function applyCamera(ctx, W, H, s) {
  const ox = W * 0.3;
  const oy = H * 0.58;
  ctx.translate(ox, oy);
  ctx.rotate((TILT_Z * Math.PI) / 180);
  // rotateY(-60°)：x 压缩 + 右近左远的透视（用 x 方向非线性近似做不到，
  // 这里用 cos(-60°)=0.5 的横向压缩 + 右缘放大 1.35 的仿射近似）
  const cy = Math.cos((TILT_Y * Math.PI) / 180); // 0.5
  ctx.transform(cy, 0, 0, 1, 0, 0);
  ctx.translate(-ox, -oy);
  void s;
}

/** 超宽页面板：6200×2400 内容坐标（这里按画幅比例折算）。 */
function pageMetrics(W, H) {
  return { pw: W * 4.8, ph: H * 1.65, py: -H * 0.12 };
}

function drawPage(ctx, W, H, src, offset, dim, alpha) {
  const { pw, ph, py } = pageMetrics(W, H);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(offset, 0);

  // 面板底
  ctx.fillStyle = '#12141c';
  ctx.fillRect(0, py, pw, ph);

  // 内容：若干「区块」（真页面读作被切开的段落）
  const blocks = 7;
  const bw = pw / blocks;
  for (let i = 0; i < blocks; i += 1) {
    const bx = i * bw + bw * 0.03;
    const by = py + ph * 0.06;
    const bwid = bw * 0.94;
    const bh = ph * 0.88;
    ctx.save();
    ctx.fillStyle = '#1b2030';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(bx, by, bwid, bh, bw * 0.02) : ctx.rect(bx, by, bwid, bh);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(bx, by, bwid, bh, bw * 0.02) : ctx.rect(bx, by, bwid, bh);
    ctx.clip();
    if (src) {
      const sw = src.width || bwid;
      const sh = src.height || bh;
      const k = Math.max(bwid / sw, bh / sh);
      ctx.drawImage(src, bx + (bwid - sw * k) / 2, by + (bh - sh * k) / 2, sw * k, sh * k);
    } else {
      ctx.fillStyle = 'rgba(60, 72, 104, 0.8)';
      ctx.fillRect(bx + bwid * 0.06, by + bh * 0.06, bwid * 0.5, bh * 0.06);
      for (let r = 0; r < 4; r += 1) {
        ctx.fillStyle = 'rgba(120, 150, 210, ' + (0.2 - r * 0.03).toFixed(3) + ')';
        ctx.fillRect(bx + bwid * 0.06, by + bh * (0.2 + r * 0.18), bwid * (0.82 - r * 0.1), bh * 0.1);
      }
      ctx.fillStyle = 'rgba(186, 206, 250, 0.7)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 ' + Math.round(bh * 0.05) + 'px system-ui, sans-serif';
      ctx.fillText('区块 ' + (i + 1) + ' · 待素材', bx + bwid / 2, by + bh * 0.92);
    }
    ctx.restore();
    // 左缘渐变阴影（揭亮时同退）
    const edge = ctx.createLinearGradient(bx, 0, bx + bwid * 0.14, 0);
    edge.addColorStop(0, 'rgba(4, 5, 9, ' + (0.5 * dim).toFixed(3) + ')');
    edge.addColorStop(1, 'rgba(4, 5, 9, 0)');
    ctx.fillStyle = edge;
    ctx.fillRect(bx, by, bwid * 0.14, bh);
    ctx.restore();
  }

  // 压暗
  if (dim > 0.001) {
    ctx.fillStyle = 'rgba(6, 7, 12, ' + dim.toFixed(3) + ')';
    ctx.fillRect(0, py, pw, ph);
  }
  ctx.restore();
}

/** 悬空元素：路径穿越时错峰贴落（影随高度收敛）。 */
const FLOATS = [
  { at: 0.06, u: 0.12, label: 'Navigation' },
  { at: 0.2, u: 0.28, label: 'Hero block' },
  { at: 0.34, u: 0.44, label: 'Chart' },
  { at: 0.5, u: 0.6, label: 'Grid' },
  { at: 0.64, u: 0.76, label: 'Table' },
  { at: 0.8, u: 0.9, label: 'Footer' },
];

function drawFloat(ctx, W, H, x, y, lift, label, alpha) {
  const w = W * 0.1;
  const h = H * 0.055;
  ctx.save();
  ctx.globalAlpha = alpha;
  // 同形软影
  if (lift > 2) {
    ctx.save();
    ctx.globalAlpha = alpha * 0.3 * clamp01(lift / 240);
    ctx.fillStyle = 'rgba(0,0,0,1)';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = (8 + lift * 0.1) * (W / 1280);
    ctx.shadowOffsetY = lift * 0.4;
    ctx.fillRect(x, y + lift * 0.4, w, h);
    ctx.restore();
  }
  ctx.fillStyle = 'rgba(24, 28, 40, 0.94)';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, h * 0.2) : ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.strokeStyle = 'rgba(150, 120, 255, 0.5)';
  ctx.lineWidth = Math.max(1, W / 1400);
  ctx.stroke();
  ctx.fillStyle = 'rgba(214, 200, 255, 0.85)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 ' + Math.round(h * 0.34) + 'px system-ui, sans-serif';
  ctx.fillText(label, x + w * 0.08, y + h * 0.5);
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
  const reveal = outCubic(clamp01((time - 0.2) / 1.2));   // ~1.4s 揭到全亮
  const dim = (1 - reveal) * 0.7;                          // 起始压暗 0.7
  const offset = slideAt(time);

  ctx.save();
  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, W, H);

  // 背景：暗场里的一点极光（页面之外没有内容，别让观众看到「空舞台」）
  const halo = ctx.createRadialGradient(W * 0.6, H * 0.5, 0, W * 0.6, H * 0.5, W * 0.7);
  halo.addColorStop(0, 'rgba(54, 32, 96, 0.24)');
  halo.addColorStop(1, 'rgba(5, 6, 10, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  applyCamera(ctx, W, H, s);

  // 速度重影：过去 f-1.6 / -3.2 / -4.8 的局部位置重投影，透明度 ∝ 速度
  const speed = Math.abs(slideAt(time + 1 / FPS) - slideAt(time));
  const speedK = clamp01(speed / 42);
  for (let layer = 3; layer >= 1; layer -= 1) {
    const back = (layer * 1.6) / FPS;
    const trailOffset = slideAt(Math.max(0, time - back));
    ctx.save();
    ctx.globalAlpha = 0.26 * speedK * (1 / layer);
    drawPage(ctx, W, H, src, trailOffset, dim, 0.7);
    ctx.restore();
  }

  // 本体
  drawPage(ctx, W, H, src, offset, dim, 1);

  // 悬空贴落元素：随滑移进程错峰（滑过观众面前的先落）
  const { pw, ph, py } = pageMetrics(W, H);
  for (const f of FLOATS) {
    // 元素的世界位置由「滑移进度」决定（它们钉在页面的某一段上）
    const pageU = clamp01((0 - offset) / (Math.abs(SLIDE_TO) + 0.001));
    const appear = clamp01((pageU + 0.1 - f.at) / 0.18);
    if (appear <= 0) continue;
    const fx = W * 0.06 + (f.u * pw + offset);
    if (fx < -W * 0.4 || fx > W * 1.4) continue;
    const fall = clamp01((pageU + 0.18 - f.at) / 0.2);
    const lift = 250 * s * (1 - outCubic(fall));
    drawFloat(ctx, W, H, fx, py + ph * 0.12, lift, f.label, 0.9);
  }
  ctx.restore();

  // 地板网格（暗场里的空间参照；与页面同一套透视常数）
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = 'rgba(120, 100, 220, 0.6)';
  ctx.lineWidth = Math.max(1, s);
  for (let i = 0; i < 9; i += 1) {
    const y = H * (0.78 + i * 0.03);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y - H * 0.02);
    ctx.stroke();
  }
  ctx.restore();

  // 右下 mono：机位常数（证明「镜头不动」）
  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(150, 130, 220, 0.45)';
  ctx.font = '500 ' + Math.round(H * 0.024) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('CAM CONST  ·  ROT-Y ' + TILT_Y + '°  ·  SLIDE ' + Math.round(offset) + 'px  ·  TRAIL ' + (speedK * 100).toFixed(0) + '%', W * 0.945, H * 0.95);
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
