// 原生移植自 skill: light-spotlight-render
export const meta = { title: '聚光灯扫字', duration: 4 };
export function render(ctx, t, env) {
  const w = env.width, h = env.height;
  const props = env.props || {};
  const text = props.text || 'SPOTLIGHT';
  const swing = Number(props.swing == null ? 0.35 : props.swing);
  const dur = Number(props.duration || 4);
  const p = Math.max(0, Math.min(1, t / dur));
  const x = w * (0.5 + Math.sin(p * Math.PI * 2) * swing * 0.5);

  ctx.save();
  ctx.fillStyle = props.bg || '#050505';
  ctx.fillRect(0, 0, w, h);

  // 光锥
  const cone = ctx.createLinearGradient(x, 0, x, h);
  cone.addColorStop(0, 'rgba(255,246,214,0.22)');
  cone.addColorStop(1, 'rgba(255,246,214,0)');
  ctx.beginPath();
  ctx.moveTo(x - w * 0.02, 0);
  ctx.lineTo(x + w * 0.02, 0);
  ctx.lineTo(x + w * 0.22, h);
  ctx.lineTo(x - w * 0.22, h);
  ctx.closePath();
  ctx.fillStyle = cone;
  ctx.fill();

  // 灯头
  ctx.beginPath();
  ctx.arc(x, h * 0.08, w * 0.018, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,250,230,0.95)';
  ctx.fill();

  // 文字（只在光锥半径内显形）
  ctx.font = '700 ' + Math.round(h * 0.16) + 'px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = props.color || '#ffffff';
  const clipR = w * 0.3;
  ctx.beginPath();
  ctx.arc(x, h * 0.55, clipR, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillText(text, w / 2, h * 0.55);
  ctx.restore();
}
