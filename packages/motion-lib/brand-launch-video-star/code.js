export const meta = { title: '品牌发布片', duration: 5 };
export function render(ctx, t, env) {
  const w = env.width, h = env.height;
  const title = String(env.props.title || 'VIBE MOTION');
  const sub = String(env.props.subtitle || '全新的动效工作流');
  ctx.save();
  ctx.fillStyle = env.props.bg || '#0a0a0c'; ctx.fillRect(0, 0, w, h);
  const wipe = Math.min(1, Math.max(0, (t - 0.2) / 1.1));
  ctx.fillStyle = env.props.accent || '#4f8cff';
  ctx.fillRect(0, h * 0.42, w * wipe, h * 0.2);
  const chars = title.split('');
  const size = Math.round(h * 0.17);
  ctx.font = '800 ' + size + 'px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  chars.forEach((ch, i) => {
    const delay = 0.9 + i * 0.06;
    const k = Math.min(1, Math.max(0, (t - delay) / 0.45));
    if (k <= 0) return;
    const e = 1 - Math.pow(1 - k, 3);
    ctx.globalAlpha = e;
    ctx.fillStyle = env.props.color || '#ffffff';
    const total = ctx.measureText(title).width;
    const x = w / 2 - total / 2 + ctx.measureText(title.slice(0, i)).width + ctx.measureText(ch).width / 2;
    ctx.fillText(ch, x, h * 0.5 + (1 - e) * size * 0.9);
  });
  ctx.globalAlpha = 1;
  const ks = Math.min(1, Math.max(0, (t - 2.4) / 0.7));
  if (ks > 0) {
    ctx.globalAlpha = ks;
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    ctx.font = '500 ' + Math.round(h * 0.05) + 'px system-ui, sans-serif';
    ctx.fillText(sub, w / 2, h * 0.68);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}
