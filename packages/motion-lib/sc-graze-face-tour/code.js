/**
 * sc-graze-face-tour · 贴脸横扫（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/camera/graze-face-tour.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权与归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - 把 UI 拍成地形：大倾角 + 沿界面一条路径持续推进 + 浅景深（远处 blur 渐强）；
 *   - 戏眼是**文字空中贴落**：初始悬浮 120–180px（沿面法线抬起），
 *     easeFall 加速下落 + 软着陆（加速而不是 ease-out，否则读作气球飘）；
 *   - **同形软影**：blur / offset / opacity 全部随当前悬浮高度变化，落地必须归零；
 *   - 错峰按镜头行进方向 0.2→0.85 归一化排布，错开起点但下落过程重叠并行；
 *   - 素材是界面截图（UI 地形）；缺素材时画带说明的「地形剖面」占位。
 */

export const meta = {
  title: '贴脸横扫',
  duration: 4.0,
  source: 'shotcraft',
  sourcePath: 'references/shots/camera/graze-face-tour.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FALL = 0.62;          // 单元素下落时长（重叠并行，不是串行等待）
const MOVE_END = 3.7;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeFall = (u) => clamp01(u) * clamp01(u) * (2 - clamp01(u) * 0.35); // 加速 + 软着陆
const easeInOut = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);

/**
 * 台面变换：把「平面坐标」映射到屏幕。
 * 用 rotate + 纵向压缩 + 斜切近似 perspective(1100px) rotateX(72°) rotateY(-34°)。
 */
function applyPlane(ctx, w, h, cam) {
  const skewX = -0.42;
  const squashY = 0.42;
  ctx.translate(w * 0.5, h * 0.5);
  ctx.rotate((-8 * Math.PI) / 180);
  ctx.transform(1, 0, skewX, squashY, 0, 0);
  ctx.translate(-cam.panX, -cam.panY);
}

/** 平面上的「地形元素」：侧栏树 / 顶栏 / 列表行 —— UI 被读成地貌。 */
function drawTerrain(ctx, w, h, cam) {
  const PW = w * 2.4;
  const PH = h * 1.6;
  // 侧栏
  ctx.fillStyle = 'rgba(22, 26, 38, 0.94)';
  ctx.fillRect(0, 0, PW * 0.18, PH);
  ctx.fillStyle = 'rgba(96, 140, 220, 0.5)';
  for (let i = 0; i < 14; i += 1) {
    const indent = i % 4 === 0 ? 0 : PW * 0.02;
    ctx.fillRect(PW * 0.024 + indent, PH * (0.08 + i * 0.058), PW * (0.1 - (i % 4) * 0.008), PH * 0.012);
  }
  // 顶栏
  ctx.fillStyle = 'rgba(30, 36, 52, 0.95)';
  ctx.fillRect(PW * 0.18, 0, PW * 0.82, PH * 0.1);
  ctx.fillStyle = 'rgba(150, 186, 255, 0.35)';
  for (let i = 0; i < 5; i += 1) {
    ctx.fillRect(PW * (0.22 + i * 0.09), PH * 0.042, PW * 0.05, PH * 0.014);
  }
  // 列表行：越靠右越远，越远越亮（浅景深 + 空气透视）
  for (let r = 0; r < 7; r += 1) {
    const y = PH * (0.16 + r * 0.115);
    const far = clamp01((r * 0.08 + 0.1));
    ctx.fillStyle = 'rgba(38, 46, 66, ' + (0.9 - far * 0.35).toFixed(3) + ')';
    ctx.fillRect(PW * 0.2, y, PW * 0.74, PH * 0.09);
    ctx.fillStyle = 'rgba(160, 196, 255, ' + (0.36 - far * 0.14).toFixed(3) + ')';
    ctx.fillRect(PW * 0.215, y + PH * 0.022, PW * 0.3, PH * 0.014);
    ctx.fillStyle = 'rgba(120, 160, 230, ' + (0.22 - far * 0.08).toFixed(3) + ')';
    ctx.fillRect(PW * 0.215, y + PH * 0.052, PW * (0.42 - r * 0.02), PH * 0.01);
  }
  // 远处光斑：贴面的霓虹缘光
  ctx.save();
  const light = ctx.createRadialGradient(PW * 0.8, PH * 0.22, 0, PW * 0.8, PH * 0.22, PW * 0.24);
  light.addColorStop(0, 'rgba(90, 170, 255, 0.22)');
  light.addColorStop(1, 'rgba(90, 170, 255, 0)');
  ctx.fillStyle = light;
  ctx.fillRect(cam.panX - w, cam.panY - h, w * 3, h * 3);
  ctx.restore();
}

/** 在平面上画素材：cover 铺满地形范围（这是「界面」本体）。 */
function drawTerrainMedia(ctx, w, h, src) {
  const PW = w * 2.4;
  const PH = h * 1.6;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, PW, PH);
  ctx.clip();
  if (src) {
    const sw = src.width || PW;
    const sh = src.height || PH;
    const k = Math.max(PW / sw, PH / sh);
    ctx.globalAlpha = 0.9;
    ctx.drawImage(src, (PW - sw * k) / 2, (PH - sh * k) / 2, sw * k, sh * k);
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(10, 14, 22, 0.42)';
    ctx.fillRect(0, 0, PW, PH);
  } else {
    ctx.fillStyle = '#12161f';
    ctx.fillRect(0, 0, PW, PH);
    // 占位地形剖面：让「这里是一条要被飞掠的界面」读得出来
    ctx.strokeStyle = 'rgba(110, 160, 240, 0.35)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 6; i += 1) {
      ctx.beginPath();
      ctx.moveTo(PW * 0.2, PH * (0.2 + i * 0.12));
      ctx.lineTo(PW * 0.94, PH * (0.2 + i * 0.12));
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(190, 214, 255, 0.86)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.round(PH * 0.028) + 'px system-ui, sans-serif';
    ctx.fillText('地形待素材：一张整页 UI 截图（侧栏 + 列表）', PW * 0.21, PH * 0.55);
    ctx.fillStyle = 'rgba(140, 176, 230, 0.62)';
    ctx.font = Math.round(PH * 0.019) + 'px system-ui, sans-serif';
    ctx.fillText('props.assetId 未设置 —— 镜头会沿着这张界面低飞掠过', PW * 0.21, PH * 0.6);
  }
  ctx.restore();
}

/** 悬浮元素：本体 + 同形软影（影随高度收敛，落地归零）。 */
function drawFloat(ctx, text, x, y, lift, size) {
  const shadowBlur = size * (0.08 + lift * 0.012);
  const shadowOff = lift * 0.55;
  const shadowAlpha = 0.42 * clamp01(lift / 140);
  if (lift > 0.5) {
    ctx.save();
    ctx.globalAlpha = shadowAlpha;
    ctx.fillStyle = 'rgba(4, 6, 12, 1)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '700 ' + size + 'px system-ui, sans-serif';
    ctx.fillText(text, x, y + shadowOff);
    ctx.restore();
  }
  ctx.save();
  // 悬浮时略亮，落地回到正常亮度（空间关系）
  ctx.fillStyle = 'rgba(232, 240, 255, ' + (0.72 + 0.26 * clamp01(1 - lift / 160)).toFixed(3) + ')';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '700 ' + size + 'px system-ui, sans-serif';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function __renderInner(ctx, t, env) {
  const w = Number(env && env.width) || 1;
  const h = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const time = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
  const m = env && env.media;
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);
  const src = id && m ? (m.video(id) || m.image(id)) : null;

  const w2 = env && env.width;
  const h2 = env && env.height;
  const s = Math.min((Number(w2) || 1280) / 1280, (Number(h2) || 720) / 720);

  // 机位沿界面持续推进：panX 从 0.16→0.72 个界面宽
  const u = easeInOut(clamp01(time / MOVE_END));
  const cam = {
    panX: w * (0.2 + 0.86 * u),
    panY: h * (0.16 + 0.1 * u),
  };

  ctx.save();
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#0a0d14');
  bg.addColorStop(1, '#05070b');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // 整块地形：一次平面变换
  ctx.save();
  applyPlane(ctx, w, h, cam);
  if (src) {
    drawTerrainMedia(ctx, w, h, src);
  } else {
    drawTerrainMedia(ctx, w, h, null);
  }
  drawTerrain(ctx, w, h, cam);
  ctx.restore();

  // ---- 悬浮文字：错峰 0.2→0.85 贴落，下落过程重叠并行 ----
  const items = [
    { text: 'Workspace', at: 0.2, x: 0.16, y: 0.3, size: 0.052 },
    { text: 'Collections', at: 0.38, x: 0.42, y: 0.46, size: 0.044 },
    { text: 'Recent drafts', at: 0.56, x: 0.66, y: 0.36, size: 0.038 },
    { text: 'Shared with me', at: 0.7, x: 0.82, y: 0.58, size: 0.034 },
    { text: 'Archive', at: 0.85, x: 0.94, y: 0.42, size: 0.03 },
  ];
  ctx.save();
  applyPlane(ctx, w, h, cam);
  const PW = w * 2.4;
  const PH = h * 1.6;
  for (const item of items) {
    const start = item.at * 0.85;
    const fallU = clamp01((time / MOVE_END - start) / (FALL / MOVE_END));
    const lift = 160 * (1 - easeFall(fallU));
    const px = PW * item.x;
    const py = PH * item.y;
    // 悬空时朝镜头方向抬起（法线向上 = 平面坐标里 -y）
    drawFloat(ctx, item.text, px, py - lift * 0.9, lift, Math.round(PH * item.size));
    // 落地瞬间的一记极细高光（软着陆的可感信号）
    if (fallU > 0.94) {
      ctx.save();
      ctx.globalAlpha = 1 - (fallU - 0.94) / 0.06;
      ctx.strokeStyle = 'rgba(140, 200, 255, 0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, py + PH * 0.02);
      ctx.lineTo(px + PH * 0.09, py + PH * 0.02);
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();

  // ---- 浅景深：远处（屏幕上方）加一层向下渐深的暗雾，近处（下方）保持清晰 ----
  const dof = ctx.createLinearGradient(0, 0, 0, h);
  dof.addColorStop(0, 'rgba(6, 9, 15, 0.72)');
  dof.addColorStop(0.42, 'rgba(6, 9, 15, 0.16)');
  dof.addColorStop(1, 'rgba(6, 9, 15, 0)');
  ctx.fillStyle = dof;
  ctx.fillRect(0, 0, w, h);

  // ---- 霓虹缘光：贴面掠过时的边缘反光 ----
  ctx.save();
  const rim = ctx.createLinearGradient(0, h * 0.62, w, h * 0.96);
  rim.addColorStop(0, 'rgba(70, 150, 255, 0)');
  rim.addColorStop(0.5, 'rgba(96, 178, 255, ' + (0.18 + 0.12 * Math.sin(time * 2.1)).toFixed(3) + ')');
  rim.addColorStop(1, 'rgba(150, 96, 255, 0)');
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  // 底部 mono：机位读数（编辑期定位用）
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(130, 180, 250, 0.55)';
  ctx.font = '500 ' + Math.round(h * 0.025) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('GRAZE · TILT 72° / YAW -34° · PAN ' + Math.round(0.2 + 0.86 * u * 100) / 100, w * 0.04, h * 0.95);
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
