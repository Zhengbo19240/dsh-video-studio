/**
 * sc-row-embed · 行内嵌入（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/ui-entrance/row-embed.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - 行按**越落越快**的节拍逐条飞入：cue = 12/22/31/39/46（间隔 10→7 递减），飞行 12f，
 *     最后一行 58f 落地、色缝 66f 收尾（≤ 镜头 68f 预算）；
 *   - 飞行姿态：translateY(−120·air) + rotateX(16°·air)，缓动 bezier(.5,0,.8,.75)（末段仍有速度），
 *     scale 1.06→0.995 再 4f press-bounce 回 1——**rotateX 收平是「嵌入」的关键读感**，
 *     纯垂直下落读作贴纸；
 *   - 槽位先盖页面真实底色补丁 + 极淡虚线框；落地后补丁消失让纹理透出；
 *   - 嵌入瞬间行底边一道 2px 强调色缝从中心向两侧展开（5f，ease-out cubic）后 8f 淡出，带 7px 辉光；
 *     **缝只在底边、只闪一次**（四边都闪读作选中框）；
 *   - 相机：cy 500→740、zoom 1.12→1.25，68f 缓动下摇 + 微推；与行雨并行。
 *
 * 媒体怎么用：每行的「飞行体」是从整页素材里按行位裁出的纹理切片（不重绘内容）。
 */

export const meta = {
  title: '行内嵌入',
  duration: 3.0,
  source: 'shotcraft',
  sourcePath: 'references/shots/ui-entrance/row-embed.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const CUES = [12, 22, 31, 39, 46].map((f) => f / FPS);
const FLY = 12 / FPS;
const SEAM_AT = 66 / FPS;
const SEAM_DUR = 5 / FPS;
const SEAM_FADE = 8 / FPS;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const inOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

/** bezier(.5, 0, .8, .75)：末段仍有速度（砸进槽位，不是飘进去）。 */
function dropEase(u) {
  const p = clamp01(u);
  let lo = 0;
  let hi = 1;
  let q = p;
  for (let i = 0; i < 16; i += 1) {
    const bx = 3 * (1 - q) * (1 - q) * q * 0.5 + 3 * (1 - q) * q * q * 0.8 + q * q * q;
    if (bx < p) lo = q;
    else hi = q;
    q = (lo + hi) / 2;
  }
  return 3 * (1 - q) * (1 - q) * q * 0 + 3 * (1 - q) * q * q * 0.75 + q * q * q;
}

const ROWS = [
  { label: 'Project name', value: 'Atlas — brand system' },
  { label: 'Owner', value: 'Studio North' },
  { label: 'Status', value: 'In review · 3 comments' },
  { label: 'Timeline', value: 'Mar 12 → Apr 08' },
  { label: 'Deliverables', value: '24 files · 1.8 GB' },
];

/** 一行：飞行体从整页素材裁片（不重绘内容）。 */
function drawRowBody(ctx, x, y, w, h, i, src, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#fbf8f3';
  ctx.fillRect(x, y, w, h);
  if (src) {
    // 按行位从整页素材裁一条纹理
    const sw = src.width || w;
    const sh = src.height || h;
    const sliceH = sh / (ROWS.length + 2);
    const sy = sliceH * (i + 0.8);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.drawImage(src, 0, sy, sw, sliceH, x, y, w, h);
    ctx.restore();
  }
  // 行内结构：标签 + 值（纹理之外仍要读得出来）
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(120, 110, 96, 0.7)';
  ctx.font = '500 ' + Math.round(h * 0.32) + 'px system-ui, sans-serif';
  ctx.fillText(ROWS[i].label, x + w * 0.03, y + h * 0.5);
  ctx.fillStyle = 'rgba(40, 34, 28, 0.9)';
  ctx.font = '600 ' + Math.round(h * 0.36) + 'px system-ui, sans-serif';
  ctx.fillText(ROWS[i].value, x + w * 0.24, y + h * 0.5);
  // 行分隔线
  ctx.fillStyle = 'rgba(150, 136, 118, 0.22)';
  ctx.fillRect(x, y + h - Math.max(1, h * 0.02), w, Math.max(1, h * 0.02));
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
  const accent = String(props.accent || '#d9542b');

  // 相机：cy 500→740、zoom 1.12→1.25（68f 缓动），与行雨并行
  const camU = inOut(clamp01(time / (68 / FPS)));
  const zoom = 1.12 + (1.25 - 1.12) * camU;
  const camY = H * (0.5 + 0.24 * camU);

  ctx.save();
  // 页面底：真实的页面底色（补丁要贴得上，偏白会读成一块白板）
  ctx.fillStyle = '#f9f6f1';
  ctx.fillRect(0, 0, W, H);

  // 页面骨架（页头 / 侧栏 / 行框）
  ctx.save();
  ctx.translate(W / 2, H * 0.5);
  ctx.scale(zoom, zoom);
  ctx.translate(-W / 2, -camY);

  // 页头
  ctx.fillStyle = '#232019';
  ctx.fillRect(0, 0, W, H * 0.09);
  ctx.fillStyle = 'rgba(249, 246, 241, 0.9)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 ' + Math.round(H * 0.038) + 'px system-ui, sans-serif';
  ctx.fillText(String(props.pageTitle || 'Project settings'), W * 0.05, H * 0.045);

  // 行区
  const rowX = W * 0.08;
  const rowW = W * 0.84;
  const rowH = H * 0.086;
  const rowGap = H * 0.012;
  const firstY = H * 0.18;

  for (let i = 0; i < ROWS.length; i += 1) {
    const slotY = firstY + i * (rowH + rowGap);
    const cue = CUES[i];
    const u = (time - cue) / FLY;
    const landed = u >= 1;

    if (!landed) {
      // 槽位：先盖页面真实底色补丁 + 极淡虚线框
      ctx.save();
      ctx.fillStyle = '#f9f6f1';
      ctx.fillRect(rowX, slotY, rowW, rowH);
      ctx.strokeStyle = 'rgba(150, 136, 118, 0.28)';
      ctx.setLineDash([Math.max(4, 8 * s), Math.max(3, 6 * s)]);
      ctx.lineWidth = Math.max(1, 1.4 * s);
      ctx.strokeRect(rowX + 1, slotY + 1, rowW - 2, rowH - 2);
      ctx.setLineDash([]);
      ctx.restore();
    } else {
      // 落地后补丁消失，让纹理透出
      ctx.save();
      ctx.fillStyle = '#f9f6f1';
      ctx.fillRect(rowX, slotY, rowW, rowH);
      ctx.restore();
    }

    if (time < cue) continue;
    const air = 1 - dropEase(clamp01(u));
    // 落地后 press-bounce 4f
    const press = landed ? clamp01((time - cue - FLY) / (4 / FPS)) : 1;
    const scale = landed ? 0.995 + 0.005 * outCubic(press) : 1.06 + (0.995 - 1.06) * clamp01(u);

    ctx.save();
    // 接触影：随行接近收紧变实
    if (!landed) {
      ctx.save();
      ctx.globalAlpha = 0.22 * (1 - air) + 0.06;
      ctx.shadowColor = 'rgba(60, 48, 34, 0.6)';
      ctx.shadowBlur = (18 * air + 4) * s;
      ctx.shadowOffsetY = (10 * air + 2) * s;
      ctx.fillStyle = 'rgba(20, 16, 12, 1)';
      ctx.fillRect(rowX, slotY + rowH * 0.86, rowW, rowH * 0.16);
      ctx.restore();
    }

    // 飞行姿态：translateY(−120·air) + rotateX(16°·air)（这里用纵向压缩 + 上移近似）
    const lift = 120 * air * s;
    ctx.translate(rowX + rowW / 2, slotY + rowH / 2 - lift);
    ctx.scale(scale, scale * (1 - 0.16 * air));
    ctx.translate(-(rowX + rowW / 2), -(slotY + rowH / 2));

    // 飞行段纵向运动模糊（末段有速度 → 拖影最明显）
    const speed = landed ? 0 : Math.abs(dropEase(clamp01(u + 1 / 30)) - dropEase(clamp01(u)));
    const blurPasses = speed * 120 > 3 ? 2 : 1;
    for (let p = 0; p < blurPasses; p += 1) {
      drawRowBody(ctx, rowX, slotY, rowW, rowH, i, src, p === 0 ? 1 : 0.28);
    }

    // 嵌入瞬间：底边 2px 强调色缝从中心向两侧展开（5f）后 8f 淡出
    const seamSince = time - (cue + FLY);
    if (seamSince >= 0 && seamSince < SEAM_DUR + SEAM_FADE) {
      const grow = outCubic(clamp01(seamSince / SEAM_DUR));
      const fade = 1 - clamp01((seamSince - SEAM_DUR) / SEAM_FADE);
      const seamW = rowW * grow;
      const seamX = rowX + (rowW - seamW) / 2;
      const seamY = slotY + rowH - Math.max(1, 2 * s);
      ctx.save();
      ctx.globalAlpha = fade;
      // 两端羽化 + 7px 辉光：用 shadowBlur 而不是滤镜（便宜且锐）
      ctx.shadowColor = accent;
      ctx.shadowBlur = 7 * s;
      const g = ctx.createLinearGradient(seamX, 0, seamX + seamW, 0);
      g.addColorStop(0, accent + '00');
      g.addColorStop(0.12, accent);
      g.addColorStop(0.88, accent);
      g.addColorStop(1, accent + '00');
      ctx.fillStyle = g;
      ctx.fillRect(seamX, seamY, seamW, Math.max(1, 2 * s));
      ctx.restore();
    }
    ctx.restore();
  }

  // 段落级的强调色提示（页脚）
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(120, 108, 92, 0.5)';
  ctx.font = '500 ' + Math.round(H * 0.026) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('ROW CUES 12 / 22 / 31 / 39 / 46f  ·  SEAM ' + accent, W * 0.08, H * 0.72);
  ctx.restore();

  ctx.restore();

  // 尾段极淡暗角（避免尾帧像一张静态截图）
  const tail = clamp01((time - 2.0) / 0.6);
  if (tail > 0) {
    const vg = ctx.createRadialGradient(W * 0.5, H * 0.5, Math.min(W, H) * 0.3, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(60, 48, 34, 0)');
    vg.addColorStop(1, 'rgba(60, 48, 34, ' + (0.14 * tail).toFixed(3) + ')');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
  }

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
