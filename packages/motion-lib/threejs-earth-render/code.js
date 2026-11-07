export const meta = { title: '地球航线', duration: 5 };
export function render(ctx, t, env) {
  const w = env.width, h = env.height, cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.33;
  ctx.save();
  ctx.fillStyle = env.props.bg || '#03040a'; ctx.fillRect(0, 0, w, h);
  ctx.beginPath(); ctx.arc(cx, cy, R * 1.06, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(70,140,255,.08)'; ctx.fill();
  const g = ctx.createRadialGradient(cx - R * 0.4, cy - R * 0.4, R * 0.1, cx, cy, R);
  g.addColorStop(0, '#2f6fd0'); g.addColorStop(1, '#071b33');
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = 'rgba(140,200,255,.22)'; ctx.lineWidth = 1;
  for (let i = 1; i < 7; i += 1) {
    const ry = R * Math.cos((i * Math.PI) / 7);
    ctx.beginPath(); ctx.ellipse(cx, cy, R, Math.abs(ry), 0, 0, Math.PI * 2); ctx.stroke();
  }
  for (let i = 0; i < 8; i += 1) {
    const rx = R * Math.abs(Math.cos((i * Math.PI) / 8));
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, R, 0, 0, Math.PI * 2); ctx.stroke();
  }
  const p = Math.min(1, t / 4);
  const ax = cx - R * 0.75, ay = cy + R * 0.35, bx = cx + R * 0.7, by = cy - R * 0.45;
  ctx.strokeStyle = 'rgba(255,209,102,.85)'; ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.quadraticCurveTo(cx, cy - R * 0.85, ax + (bx - ax) * p, ay + (by - ay) * p);
  ctx.stroke();
  ctx.fillStyle = '#ffd166';
  ctx.beginPath(); ctx.arc(ax + (bx - ax) * p, ay + (by - ay) * p, R * 0.025, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
