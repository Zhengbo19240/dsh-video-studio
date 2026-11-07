export const meta = { title: '尺子进度条', duration: 3 };
export function render(ctx, t, env) {
  const w = env.width, h = env.height, p = Math.min(1, Math.max(0, t / Number(env.props.duration || 3)));
  ctx.save();
  ctx.fillStyle = env.props.bg || '#0d1117';
  ctx.fillRect(0, 0, w, h);
  const y = h * 0.55, x0 = w * 0.08, x1 = w * 0.92;
  ctx.strokeStyle = 'rgba(255,255,255,.35)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  for (let i = 0; i <= 40; i += 1) {
    const x = x0 + ((x1 - x0) * i) / 40;
    const major = i % 5 === 0;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + (major ? 18 : 9));
    ctx.stroke();
  }
  const px = x0 + (x1 - x0) * p;
  ctx.fillStyle = env.props.color || '#4f8cff';
  ctx.fillRect(x0, y - 8, px - x0, 8);
  ctx.beginPath(); ctx.moveTo(px, y - 26); ctx.lineTo(px - 10, y - 42); ctx.lineTo(px + 10, y - 42); ctx.closePath(); ctx.fill();
  ctx.font = '700 ' + Math.round(h * 0.12) + 'px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
  ctx.fillText(Math.round(p * 100) + '%', w / 2, h * 0.25);
  ctx.restore();
}
