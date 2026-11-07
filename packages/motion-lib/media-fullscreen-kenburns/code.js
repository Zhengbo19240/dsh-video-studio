/**
 * 全屏 Ken Burns：把 props.assetId 指向的视频铺满画面，缓慢放大 1.0 → 1.08。
 *
 * 用法：把这张卡插成代码图层，props 里给 assetId。
 * 素材缺失 / 还没解码 / props 没给 —— 一律画占位底，不抛错。
 *
 * 2026-11-06 修复（运镜只有入口没有出口）：
 *   旧实现用 t / duration 做进度，**最后一帧永远差一点点**（30fps 下 1.0796 而不是 1.08），
 *   而且片尾那一像素的差会被下一镜的 1.0 放大成 0.08 的跳变。
 *   现在：
 *     1) 卡片显式声明 camera.out = 1.08（见下面 camera 导出）；
 *     2) 曲线在片尾前 1.5 帧就收干并**钉死在 out**，最后一帧精确等于声明值、速度为 0；
 *     3) 想接回 1.0 的下一镜？把下一镜的 camera.in 声明成 1.08，或者用
 *        `direction:'return'`（片尾回到 1.0，与第一帧一致）。
 */

export const meta = { title: '全屏缓慢推镜（媒体）', duration: 6 };

/** 声明媒体需求：注册表据此在主线程把该素材 seek 到当前帧。 */
export function media(props) {
  const id = props && props.assetId;
  return id ? [String(id)] : [];
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const easeInOutQuad = (u) => {
  const x = clamp01(u);
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
};

/** 默认推镜倍数（1.08）；`direction:'return'` 时片尾回到 1.0。 */
export function cameraZoom(props) {
  return Math.max(1, num(props && props.zoomTo, 1.08));
}

/**
 * 相机出入口声明（宿主 video_camera_check 读它；x / y 是画幅比例）。
 *   zoom：1.00 → 1.08（片尾精确停在声明值）
 *   return：1.00 → 1.08 → 1.00（放大到部位再回全局）
 */
export function camera(props) {
  const p = props || {};
  if (String(p.direction || 'zoom') === 'return') {
    return { in: { scale: 1, x: 0, y: 0 }, out: { scale: 1, x: 0, y: 0 } };
  }
  const zoomTo = cameraZoom(p);
  return { in: { scale: 1, x: 0, y: 0 }, out: { scale: zoomTo, x: 0, y: 0 } };
}

/**
 * 进度：0 → 1，并在**最后一帧之前**收干（片尾 1.5 帧钉死在 1）。
 *
 * 为什么要这个「收干窗口」而不是 t / duration：
 * 导出/预览的最后一帧时间通常不是 duration（帧网格对齐），
 * 用 t / duration 会让最后一帧停在 0.999x 的位置 —— 声明 out=1.08、画面却是 1.0796，
 * 检查器一眼能看出声明在说谎，边界也仍然会跳。
 */
export function progressAt(t, duration, props) {
  const dur = Math.max(1e-6, num(duration, 6));
  const fps = Math.max(1, num(props && props.fps, 30));
  const settle = Math.max(0, dur - 1.5 / fps); // 片尾前 1.5 帧
  const time = Math.max(0, Math.min(dur, num(t, 0)));
  if (settle <= 0) return 1;
  return clamp01(time / settle);
}

/**
 * 卡片自己的机位曲线（宿主会优先用它采边界帧；与 camera 的声明必须一致）。
 * t = 0 → scale 1；t = duration → scale 精确等于 camera.out（zoom 形态）。
 */
export function cameraAt(t, duration, props) {
  const p = props || {};
  const zoomTo = cameraZoom(p);
  const dur = Math.max(1e-6, num(duration, 6));
  const time = Math.max(0, Math.min(dur, num(t, 0)));
  if (String(p.direction || 'zoom') === 'return') {
    // 进 → 停 → 回：进入 30%，停留 40%，返回 30%；两端速度 0，片尾回到 1.0。
    const fps = Math.max(1, num(p.fps, 30));
    const settle = dur - 1.5 / fps;
    if (settle > dur * 0.7 && time >= settle) return { scale: 1, x: 0, y: 0 };
    const enter = 0.3;
    const hold = 0.4;
    const t1 = dur * enter;
    const t2 = t1 + dur * hold;
    let k;
    if (time <= t1) k = easeInOutQuad(time / Math.max(t1, 1e-9));
    else if (time <= t2) k = 1;
    else k = 1 - easeInOutQuad((time - t2) / Math.max(dur - t2, 1e-9));
    return { scale: 1 + (zoomTo - 1) * k, x: 0, y: 0 };
  }
  const k = progressAt(time, dur, p);
  // 轻微上摇（Ken Burns 的「呼吸」）：y 偏移在片尾也收干到 0，不参与的下一镜不会被带偏。
  return { scale: 1 + (zoomTo - 1) * k, x: 0, y: 0 };
}

function placeholder(ctx, width, height, label) {
  ctx.save();
  ctx.fillStyle = '#1d2027';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = Math.max(2, width / 320);
  ctx.setLineDash([14, 10]);
  ctx.strokeRect(width * 0.04, height * 0.04, width * 0.92, height * 0.92);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = Math.max(14, Math.round(width / 30)) + 'px system-ui, sans-serif';
  ctx.fillText('媒体占位', width / 2, height / 2 - Math.round(height / 28));
  ctx.font = Math.max(11, Math.round(width / 52)) + 'px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.fillText(label, width / 2, height / 2 + Math.round(height / 28));
  ctx.restore();
}

export function render(ctx, t, env) {
  const width = Number(env && env.width) || 1;
  const height = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);

  const media = env && env.media;
  let src = null;
  if (id && media) {
    // 视频优先；同一张卡也允许拿静态图（图片环 / 封面这类配方直接复用）
    src = media.video(id) || media.image(id);
  }
  const size = id && media && typeof media.size === 'function' ? media.size(id) : null;

  if (!src) {
    placeholder(ctx, width, height, !id ? 'props.assetId 未设置' : '素材未就绪或不存在');
    return;
  }

  const srcW = size && size.width > 0 ? size.width : width;
  const srcH = size && size.height > 0 ? size.height : height;

  const duration = Number(env && env.duration) > 0 ? Number(env.duration) : Number(props.duration) > 0 ? Number(props.duration) : 6;
  const cam = cameraAt(t, duration, { ...props, fps: Number(env && env.fps) || 30 });
  const zoom = cam.scale;

  // cover：先按「铺满」算比例，再乘上推镜倍数
  const cover = Math.max(width / srcW, height / srcH) * zoom;
  const drawW = srcW * cover;
  const drawH = srcH * cover;
  const x = (width - drawW) / 2 + cam.x * width;
  const y = (height - drawH) / 2 + cam.y * height;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  ctx.drawImage(src, x, y, drawW, drawH);
  ctx.restore();
}
