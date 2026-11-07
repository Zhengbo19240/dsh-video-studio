export const meta = { title: '程序鱼', duration: 5 };
export function render(ctx, t, env) {
  const w = env.width, h = env.height;
  ctx.save();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, env.props.bgA || '#03263a');
  g.addColorStop(1, env.props.bgB || '#01101a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 9; i += 1) {
    const speed = 0.25 + (i % 3) * 0.12;
    const size = h * (0.03 + (i % 4) * 0.012);
    const cy = h * (0.25 + ((i * 0.13) % 0.55));
    const cx = ((t * speed * w * 0.12 + i * w * 0.19) % (w * 1.3)) - w * 0.15;
    const wob = Math.sin(t * 2 + i) * size * 0.5;
    ctx.save();
    ctx.translate(cx, cy + wob);
    ctx.fillStyle = env.props.color || 'rgba(120,220,240,.85)';
    ctx.beginPath(); ctx.ellipse(0, 0, size * 1.6, size * 0.8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-size * 1.5, 0);
    ctx.lineTo(-size * 2.4, -size * 0.8 + Math.sin(t * 8 + i) * size * 0.2);
    ctx.lineTo(-size * 2.4, size * 0.8 + Math.sin(t * 8 + i) * size * 0.2);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.beginPath(); ctx.arc(size * 0.9, -size * 0.15, size * 0.16, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}
