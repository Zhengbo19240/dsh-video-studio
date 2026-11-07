/**
 * 媒体画中画：把 props.assetId 指向的视频缩到右下角，圆角裁切 + 0.5 秒淡入。
 *
 * 用法：把这张卡插成代码图层，props 里给 assetId（例如 'asset_ab12cd34'）。
 * 素材缺失 / 还没解码 / props 没给 —— 一律画占位框，不抛错。
 */

export const meta = { title: '画中画（媒体）', duration: 4 };

/** 声明媒体需求：注册表据此在主线程把该素材 seek 到当前帧。 */
export function media(props) {
  const id = props && props.assetId;
  return id ? [String(id)] : [];
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
}

function drawPlaceholder(ctx, x, y, w, h, radius, label) {
  ctx.save();
  roundRectPath(ctx, x, y, w, h, radius);
  ctx.fillStyle = 'rgba(40, 44, 52, 0.92)';
  ctx.fill();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.lineWidth = Math.max(1, w / 160);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = Math.max(10, Math.round(w / 14)) + 'px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('媒体占位', x + w / 2, y + h / 2 - w / 22);
  ctx.font = Math.max(8, Math.round(w / 22)) + 'px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.fillText(label, x + w / 2, y + h / 2 + w / 24);
  ctx.restore();
}

export function render(ctx, t, env) {
  const width = Number(env && env.width) || 1;
  const height = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);

  const boxW = width * Math.max(0.1, Math.min(0.9, Number(props.scale) > 0 ? Number(props.scale) : 0.32));
  const margin = Math.round(Math.min(width, height) * 0.04);
  const radius = Math.round(boxW * 0.06);
  const x = width - boxW - margin;

  const media = env && env.media;
  const src = id && media ? media.video(id) : null;
  const size = id && media && typeof media.size === 'function' ? media.size(id) : null;
  const aspect = size && size.width > 0 ? size.height / size.width : 9 / 16;
  const boxH = boxW * aspect;
  const y = height - boxH - margin;

  if (!src) {
    const why = !id ? 'props.assetId 未设置' : '素材未就绪或不存在';
    drawPlaceholder(ctx, x, y, boxW, boxH, radius, why);
    return;
  }

  // 0.5 秒淡入：初帧不硬切进来
  const fade = Math.max(0, Math.min(1, Number(t) / 0.5));

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.save();
  roundRectPath(ctx, x, y, boxW, boxH, radius);
  ctx.clip();
  ctx.drawImage(src, x, y, boxW, boxH);
  ctx.restore();

  roundRectPath(ctx, x, y, boxW, boxH, radius);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
  ctx.lineWidth = Math.max(1, width / 480);
  ctx.stroke();
  ctx.restore();
}
