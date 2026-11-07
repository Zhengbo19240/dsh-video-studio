export const meta = { title: '克拉尼沙纹', duration: 4 };
export function render(ctx, t, env) {
  const w = env.width, h = env.height;
  ctx.save();
  ctx.fillStyle = env.props.bg || '#05060a'; ctx.fillRect(0, 0, w, h);
  const n = 2 + Math.floor((t / 4) * 4), m = 3 + Math.floor((t / 4) * 3);
  const dots = 2600;
  ctx.fillStyle = env.props.color || 'rgba(180,220,255,.75)';
  for (let i = 0; i < dots; i += 1) {
    const a = i * 0.6180339887, r = Math.sqrt(i / dots);
    const x = (0.5 + Math.cos(a) * r * 0.46);
    const y = (0.5 + Math.sin(a) * r * 0.46);
    const v = Math.abs(Math.sin(n * Math.PI * x) * Math.sin(m * Math.PI * y));
    if (v > 0.55) continue;
    const px = x * w, py = y * h;
    ctx.globalAlpha = 0.15 + (1 - v) * 0.85;
    ctx.fillRect(px, py, 2.2, 2.2);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}
