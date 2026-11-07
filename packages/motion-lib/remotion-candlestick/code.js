export const meta = { title: 'K 线动画', duration: 4 };
export function render(ctx, t, env) {
  const w = env.width, h = env.height, n = 24;
  ctx.save();
  ctx.fillStyle = env.props.bg || '#0b0f14'; ctx.fillRect(0, 0, w, h);
  const pad = w * 0.08, cw = (w - pad * 2) / n;
  const mid = h * 0.55, amp = h * 0.28;
  const clamp = (v) => Math.max(0.06, Math.min(0.94, v));
  let prev = 0.5;
  const pts = [];
  for (let i = 0; i < n; i += 1) {
    const open = prev, close = clamp(prev + Math.sin(i * 0.7) * 0.12 + Math.cos(i * 0.31) * 0.05);
    const high = clamp(Math.max(open, close) + 0.06), low = clamp(Math.min(open, close) - 0.06);
    pts.push({ open, close, high, low });
    prev = close;
  }
  const shown = Math.floor(Math.min(n, (t / 4) * n));
  for (let i = 0; i < shown; i += 1) {
    const c = pts[i], x = pad + cw * (i + 0.5), up = c.close >= c.open;
    const Y = (v) => mid + (0.5 - v) * amp * 2;
    ctx.strokeStyle = up ? '#26c281' : '#e5484d'; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, Y(c.high)); ctx.lineTo(x, Y(c.low)); ctx.stroke();
    ctx.fillRect(x - cw * 0.3, Math.min(Y(c.open), Y(c.close)), cw * 0.6, Math.max(2, Math.abs(Y(c.close) - Y(c.open))));
  }
  ctx.strokeStyle = 'rgba(255,209,102,.9)'; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < shown; i += 1) {
    const x = pad + cw * (i + 0.5), y = mid + (0.5 - pts[i].close) * amp * 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}
