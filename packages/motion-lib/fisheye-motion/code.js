export const meta = { title: '鱼眼屏摄', duration: 3 };
export function render(ctx, t, env) {
  const w = env.width, h = env.height, cx = w / 2, cy = h / 2;
  ctx.save();
  ctx.fillStyle = env.props.bg || '#05060a'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(90,200,255,.35)'; ctx.lineWidth = 1.5;
  for (let i = -6; i <= 6; i += 1) {
    ctx.beginPath();
    for (let s = 0; s <= 40; s += 1) {
      const yy = (s / 40) * h;
      const bulge = 1 + 0.25 * (1 - Math.pow((yy - cy) / cy, 2));
      const xx = cx + i * (w / 14) * bulge;
      s === 0 ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy);
    }
    ctx.stroke();
  }
  const p = (t / 3) % 1;
  ctx.fillStyle = 'rgba(255,255,255,.05)';
  for (let y = 0; y < h; y += 4) ctx.fillRect(0, y + ((t * 40) % 4), w, 1);
  const r = Math.max(w, h) * 0.75;
  const vig = ctx.createRadialGradient(cx, cy, r * 0.35, cx, cy, r);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.85)');
  ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,220,80,.9)';
  const bx = w * (0.15 + p * 0.7);
  ctx.fillRect(bx, h * 0.62, w * 0.18, h * 0.05);
  ctx.restore();
}
