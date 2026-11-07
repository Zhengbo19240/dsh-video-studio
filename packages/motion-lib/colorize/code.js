export const meta = { title: '黑白上色揭示', duration: 2.5 };
export function render(ctx, t, env) {
  const w = env.width, h = env.height, p = Math.min(1, Math.max(0, t / Number(env.props.duration || 2.5)));
  ctx.save();
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, env.props.colorA || '#ff6b6b');
  grad.addColorStop(1, env.props.colorB || '#4f8cff');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(0,0,0,.25)';
  for (let i = 0; i < 7; i += 1) ctx.fillRect(w * 0.08, h * (0.14 + i * 0.1), w * 0.84, h * 0.04);
  const edge = w * p;
  ctx.filter = 'grayscale(1) contrast(1.1)';
  ctx.fillStyle = grad; ctx.fillRect(0, 0, edge, h);
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  for (let i = 0; i < 7; i += 1) ctx.fillRect(w * 0.08, h * (0.14 + i * 0.1), w * 0.84, h * 0.04);
  ctx.filter = 'none';
  ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(edge - 2, 0, 4, h);
  ctx.restore();
}
