export const meta = { title: '黑胶唱机', duration: 5 };
export function render(ctx, t, env) {
  const w = env.width, h = env.height, cx = w * 0.4, cy = h * 0.55, R = Math.min(w, h) * 0.3;
  ctx.save();
  ctx.fillStyle = env.props.bg || '#14100e'; ctx.fillRect(0, 0, w, h);
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(t * 1.4);
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fillStyle = '#111'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  for (let i = 1; i < 8; i += 1) { ctx.beginPath(); ctx.arc(0, 0, R * (i / 8), 0, Math.PI * 2); ctx.stroke(); }
  ctx.beginPath(); ctx.arc(0, 0, R * 0.22, 0, Math.PI * 2); ctx.fillStyle = env.props.label || '#e0a336'; ctx.fill();
  ctx.restore();
  const p = Math.min(1, Math.max(0, (t - 0.4) / 0.8));
  const ang = -0.9 + p * 0.55;
  ctx.save(); ctx.translate(w * 0.78, h * 0.28); ctx.rotate(ang);
  ctx.fillStyle = '#c9c9cf'; ctx.fillRect(-6, 0, 12, h * 0.32);
  ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(90,200,255,.7)'; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 64; i += 1) {
    const x = w * 0.06 + (w * 0.88 * i) / 64;
    const y = h * 0.9 + Math.sin(i * 0.5 + t * 6) * h * 0.03 * (1 - i / 96);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}
