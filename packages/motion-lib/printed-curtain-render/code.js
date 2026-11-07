export const meta = { title: '印花幕布', duration: 4 };
export function render(ctx, t, env) {
  const w = env.width, h = env.height, n = 26;
  ctx.save();
  ctx.fillStyle = env.props.bg || '#120d10'; ctx.fillRect(0, 0, w, h);
  const reveal = Math.min(1, t / 3.2);
  for (let i = 0; i < n; i += 1) {
    const x = (w * i) / n, bw = w / n + 1;
    const phase = i * 0.5 + t * 2.2;
    const sway = Math.sin(phase) * w * 0.012 * (1 - reveal * 0.4);
    const shade = 0.35 + 0.25 * Math.sin(i * 0.9 + t);
    ctx.fillStyle = 'rgba(' + Math.round(210 * shade + 40) + ',' + Math.round(120 * shade + 30) + ',' + Math.round(150 * shade + 40) + ',1)';
    ctx.save();
    ctx.translate(sway, 0);
    ctx.fillRect(x, 0, bw, h * (1 - reveal * 0.7) + h * 0.15);
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.fillRect(x, 0, bw * 0.25, h);
    ctx.restore();
  }
  ctx.fillStyle = 'rgba(255,255,255,' + (0.08 + reveal * 0.1) + ')';
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}
