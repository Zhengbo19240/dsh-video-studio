/**
 * sc-page-waterfall-wall · 瀑布墙（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/ui-entrance/page-waterfall-wall.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - 后仰成墙：perspective(1000) rotateX(20°) scale(1.2)（这里用「纵向压缩 + 上窄下宽 + 顶行透视压暗」近似）；
 *   - 每列内容翻倍后取模 translateY 0→−50% 做无缝循环；**循环周期必须恰等于单副本周期**
 *     （用「内容高 + gap」算，不是 flex gap，否则差 gap/2 跳帧）；
 *   - **差速反向是视差命门**：3 列 loop 时长 12/9/14s，中列反向；等速同向读作一张大图在滚；
 *   - 镜头缓推寄生在外层（scale 1→1.06 线性铺满全镜），墙自身循环、镜头单向，两个运动源不打架；
 *   - 上下 200px 渐变遮罩收边；scale 1.2 是补透视收缩的底值，低于它四角露底。
 */

export const meta = {
  title: '瀑布墙',
  duration: 3.8,
  source: 'shotcraft',
  sourcePath: 'references/shots/ui-entrance/page-waterfall-wall.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const COLS = 3;
const LOOPS = [12, 9, 14];       // 秒：相邻列差 ≥25%
const DIR = [-1, 1, -1];         // 中列反向
const TILE_KINDS = 4;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 一列里的瓦片高度（相对列宽），按 kind 变，读作不同页面卡片。 */
function tileHeight(kind, colW) {
  if (kind === 0) return colW * 1.24;
  if (kind === 1) return colW * 0.74;
  if (kind === 2) return colW * 1.02;
  return colW * 0.62;
}

function drawTile(ctx, x, y, w, h, kind, src, col, idx, t, farDim) {
  ctx.save();
  // 卡片底
  ctx.fillStyle = '#f0ebe3';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, w * 0.045) : ctx.rect(x, y, w, h);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, w * 0.045) : ctx.rect(x, y, w, h);
  ctx.clip();
  if (src) {
    // 每片取素材不同区域：同一张页面读成一墙卡级切块
    const sw = src.width || w;
    const sh = src.height || h;
    const cw = sw / 2.4;
    const chh = sh / 2.4;
    const sx = ((col * 0.31 + idx * 0.17) % 1) * (sw - cw);
    const sy = ((idx * 0.23 + col * 0.11) % 1) * (sh - chh);
    // 瓦片内部随循环极缓上移（墙在流动的微观证据）
    const inner = (t * 0.012 * (1 + col * 0.2)) % 1;
    const k = Math.max(w / cw, h / chh);
    ctx.drawImage(src, sx, sy + inner * chh * 0.12, cw, chh, x + (w - cw * k) / 2, y + (h - chh * k) / 2, cw * k, chh * k);
  } else {
    ctx.fillStyle = '#e4ded4';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(140, 124, 104, 0.25)';
    ctx.fillRect(x + w * 0.1, y + h * 0.1, w * 0.62, h * 0.09);
    for (let i = 0; i < 3; i += 1) {
      ctx.fillStyle = 'rgba(150, 134, 114, ' + (0.18 - i * 0.04).toFixed(3) + ')';
      ctx.fillRect(x + w * 0.1, y + h * (0.28 + i * 0.16), w * (0.8 - i * 0.12), h * 0.07);
    }
    if (col === 1 && idx === 0) {
      ctx.fillStyle = 'rgba(96, 82, 66, 0.8)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 ' + Math.round(w * 0.09) + 'px system-ui, sans-serif';
      ctx.fillText('页面切片待素材', x + w / 2, y + h * 0.66);
      ctx.font = Math.round(w * 0.065) + 'px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(120, 104, 86, 0.7)';
      ctx.fillText('props.assetId（整页截图）', x + w / 2, y + h * 0.78);
    }
  }
  ctx.restore();

  // 卡边
  ctx.strokeStyle = 'rgba(120, 104, 84, 0.16)';
  ctx.lineWidth = Math.max(0.8, w * 0.006);
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, w * 0.045) : ctx.rect(x, y, w, h);
  ctx.stroke();

  // 远处压暗（空气透视）
  if (farDim > 0) {
    ctx.fillStyle = 'rgba(28, 22, 16, ' + farDim.toFixed(3) + ')';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, w, h, w * 0.045) : ctx.rect(x, y, w, h);
    ctx.fill();
  }
  ctx.restore();
}

function __renderInner(ctx, t, env) {
  const W = Number(env && env.width) || 1;
  const H = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const time = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
  const m = env && env.media;
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);
  const src = id && m ? (m.image(id) || m.video(id)) : null;

  const s = Math.min(W / 1280, H / 720);
  // 镜头缓推：1 → 1.06 线性铺满全镜（寄生在外层，与墙的循环不打架）
  const push = 1 + 0.06 * clamp01(time / 4.6);
  const wallScale = 1.2 * push;         // 1.2 是补透视收缩的底值

  ctx.save();
  ctx.fillStyle = '#1a1511';
  ctx.fillRect(0, 0, W, H);

  // 墙面：整体后仰（纵向压缩 + 上窄下宽的梯形近似 rotateX 20°）
  ctx.translate(W / 2, H / 2);
  ctx.scale(wallScale, wallScale);
  // rotateX 20°：y 方向压缩，越靠上收得越紧
  ctx.transform(1, 0, 0, 0.92, 0, 0);
  ctx.translate(-W / 2, -H * 0.52);

  const gap = W * 0.014;
  const colW = (W - gap * (COLS + 1)) / COLS;
  const maskTop = H * 0.28;
  const maskBottom = H * 0.24;

  for (let col = 0; col < COLS; col += 1) {
    const x = gap + col * (colW + gap);
    // 单副本周期：内容高 + gap（循环 −50% 必须恰等于它）
    const tiles = [];
    let contentH = 0;
    for (let i = 0; i < 6; i += 1) {
      const kind = (col * 3 + i) % TILE_KINDS;
      const th = tileHeight(kind, colW);
      tiles.push({ i, kind, h: th });
      contentH += th + gap;
    }
    const loop = LOOPS[col];
    const dir = DIR[col];
    // progress 0→1 循环，位移 = progress * contentH（= −50% of double copy）
    const prog = ((time / loop) * dir) % 1;
    const shift = (prog < 0 ? prog + 1 : prog) * contentH;

    // 画两遍副本以保证无缝
    for (let copy = 0; copy < 2; copy += 1) {
      let y = copy * contentH - shift;
      for (const tile of tiles) {
        const ty = y;
        y += tile.h + gap;
        // 视口裁剪：只画落在画面附近的瓦片
        if (ty + tile.h < -maskTop || ty > H + maskBottom) continue;
        // 远处压暗：越靠上越暗（rotateX 之后的空气透视）
        const depthDim = clamp01((H * 0.5 - ty) / (H * 0.7)) * 0.28;
        drawTile(ctx, x, ty, colW, tile.h, tile.kind, src, col, tile.i, time, depthDim);
      }
    }
  }
  ctx.restore();

  // 上下渐变遮罩收边（200px 档，按画布高折算）
  const topMask = ctx.createLinearGradient(0, 0, 0, maskTop);
  topMask.addColorStop(0, 'rgba(26, 21, 17, 1)');
  topMask.addColorStop(0.6, 'rgba(26, 21, 17, 0.55)');
  topMask.addColorStop(1, 'rgba(26, 21, 17, 0)');
  ctx.fillStyle = topMask;
  ctx.fillRect(0, 0, W, maskTop);
  const botMask = ctx.createLinearGradient(0, H - maskBottom, 0, H);
  botMask.addColorStop(0, 'rgba(26, 21, 17, 0)');
  botMask.addColorStop(0.45, 'rgba(26, 21, 17, 0.55)');
  botMask.addColorStop(1, 'rgba(26, 21, 17, 1)');
  ctx.fillStyle = botMask;
  ctx.fillRect(0, H - maskBottom, W, maskBottom);

  // 左上角标题：墙是背景，标语要压得住（统一在遮罩之上）
  const titleP = clamp01((time - 0.15) / 0.5);
  if (titleP > 0) {
    ctx.save();
    ctx.globalAlpha = titleP;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(250, 242, 230, 0.97)';
    ctx.font = '800 ' + Math.round(H * 0.075) + 'px system-ui, sans-serif';
    ctx.fillText(String(props.title || 'Every page, still moving'), W * 0.055, H * 0.135);
    ctx.fillStyle = 'rgba(214, 196, 172, 0.72)';
    ctx.font = '500 ' + Math.round(H * 0.03) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText('3 COLUMNS  ·  LOOP 12 / 9 / 14s  ·  MID COLUMN REVERSED', W * 0.055, H * 0.2);
    ctx.restore();
  }

  // 右下 mono：视差参数（质感件的仪表）
  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(196, 176, 150, 0.4)';
  ctx.font = '500 ' + Math.round(H * 0.024) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('ROTATE-X 20°  ·  SCALE ' + wallScale.toFixed(3), W * 0.945, H * 0.95);
  ctx.restore();

  ctx.restore();
  void s;
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
