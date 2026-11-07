export const meta = { title: '扫光', duration: 1.6 };
export function render(ctx, t, env) {
  const w = env.width, h = env.height;
  const p = Math.max(0, Math.min(1, t / 1.6));
  const x = -w * 0.4 + p * w * 1.8;
  const g = ctx.createLinearGradient(x - w * 0.25, -h * 0.2, x + w * 0.25, h * 1.2);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g;
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-0.35);
  ctx.translate(-w / 2, -h / 2);
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}
