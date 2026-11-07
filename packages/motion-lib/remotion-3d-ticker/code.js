export const meta = { title: '3D 照片墙', duration: 5 };
export function render(ctx, t, env) {
  const w = env.width, h = env.height, cols = 4, rows = 7;
  ctx.save();
  ctx.fillStyle = env.props.bg || '#0b0b0f'; ctx.fillRect(0, 0, w, h);
  const cardW = w / (cols + 1), cardH = cardW * 0.66;
  const colors = ['#4f8cff', '#8a63ff', '#37c98b', '#e0a336', '#e5484d', '#5ad1d1'];
  for (let c = 0; c < cols; c += 1) {
    const cx = w * (0.5 + (c - (cols - 1) / 2) * 0.24);
    const depth = 1 - Math.abs(c - (cols - 1) / 2) * 0.12;
    for (let r = 0; r < rows; r += 1) {
      const y = ((r * (cardH + h * 0.03) + t * h * 0.12 * (c % 2 ? -1 : 1)) % (rows * (cardH + h * 0.03))) - cardH;
      const px = cx - (cardW * depth) / 2;
      ctx.globalAlpha = 0.35 + 0.6 * (1 - Math.abs(y + cardH / 2 - h / 2) / h);
      ctx.fillStyle = colors[(r + c) % colors.length];
      ctx.fillRect(px, y, cardW * depth, cardH * depth);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}
