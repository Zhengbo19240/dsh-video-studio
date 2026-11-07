// 原生移植自 skill: claude-typer
export const meta = { title: '提示词打字机', duration: 3 };
export function render(ctx, t, env) {
  const w = env.width, h = env.height;
  const props = env.props || {};
  const text = String(props.text || '帮我把这段视频剪成 30 秒的竖版短片');
  const dur = Number(props.duration || 3);
  const p = Math.max(0, Math.min(1, t / dur));
  const shown = text.slice(0, Math.floor(text.length * p));

  ctx.save();
  ctx.fillStyle = props.bg || '#0f0f10';
  ctx.fillRect(0, 0, w, h);

  const pad = w * 0.08;
  const barY = h * 0.12;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(0, 0, w, h * 0.06);
  ['#ff5f56', '#ffbd2e', '#27c93f'].forEach((c, i) => {
    ctx.beginPath();
    ctx.arc(w * 0.03 + i * w * 0.018, h * 0.03, w * 0.006, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
  });

  ctx.font = '500 ' + Math.round(h * 0.055) + 'px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = props.color || '#e8e8ea';
  ctx.fillText('> ' + shown, pad, barY + h * 0.05);

  const cursorOn = Math.floor(t * 2) % 2 === 0;
  if (cursorOn) {
    const tw = ctx.measureText('> ' + shown).width;
    ctx.fillStyle = props.cursor || '#8ab4f8';
    ctx.fillRect(pad + tw + 4, barY + h * 0.05, h * 0.03, h * 0.06);
  }
  ctx.restore();
}
