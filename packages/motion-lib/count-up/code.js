export const meta = { title: '数字滚动', duration: 2 };
export function render(ctx, t, env) {
  const w = env.width, h = env.height;
  const props = env.props || {};
  const target = Number(props.target == null ? 1280 : props.target);
  const dur = Number(props.duration || 2);
  const p = Math.max(0, Math.min(1, t / dur));
  const eased = 1 - Math.pow(1 - p, 3);
  const value = Math.round(target * eased);
  ctx.save();
  ctx.fillStyle = props.color || '#ffffff';
  ctx.font = '600 ' + Math.round(h * 0.22) + 'px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(value), w / 2, h / 2);
  ctx.restore();
}
