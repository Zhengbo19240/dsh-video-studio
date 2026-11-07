/**
 * radial-wave · 点阵涟漪（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/ui-entrance/radial-wave.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0
 *   —— 可改可商用；须保留版权与归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（改动声明：原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡的配方（照卡文）：
 *   - 17×9 点阵，每点归一化到波源的欧氏距离 dist；
 *   - 第一道波：起点按 dist*0.35 错峰、单点行程 0.18、outCubic；scale 用
 *     w1*(1+0.5*sin(w1π)) 在行程正中鼓到 1.5 再落回；
 *   - 第二道波：起点 0.62+(1-dist)*0.25（外圈先动）、窗 0.15、sin(w2π) 纯脉冲，
 *     叠加 0.8 scale 与 0.25 透明度，峰值 >0.3 时硬切 #b9f2ff + 光晕；
 *   - 常亮底 0.25，深底 #0a0b10 是发光的前提。
 */

export const meta = {
  title: 'radial-wave',
  duration: 3.8,
  source: 'shotcraft',
  sourcePath: 'references/shots/ui-entrance/radial-wave.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

const DESIGN_W = 480;
const DESIGN_H = 270;

const DEFAULTS = {
  cols: 17,
  rows: 9,
  dotSize: 10,
  background: '#0a0b10',
  baseColor: '#6c8cff',
  peakColor: '#b9f2ff',
  glowColor: '#7fd8ff',
  waveSpeed: 0.35,
  travel: 0.18,
  overshoot: 0.5,
  pulseAt: 0.62,
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - x, 3);

/** 段函数：a→b 之间的归一化进度，套缓动。 */
function seg(t, a, b, ease) {
  if (b <= a) return t >= b ? 1 : 0;
  const p = clamp01((t - a) / (b - a));
  return ease ? ease(p) : p;
}

export function render(ctx, t, env) {
  const w = env.width;
  const h = env.height;
  const props = env.props || {};
  const cols = Math.max(2, Math.min(64, Math.round(Number(props.cols) || DEFAULTS.cols)));
  const rows = Math.max(2, Math.min(64, Math.round(Number(props.rows) || DEFAULTS.rows)));
  const bg = props.background || DEFAULTS.background;
  const baseColor = props.baseColor || DEFAULTS.baseColor;
  const peakColor = props.peakColor || DEFAULTS.peakColor;
  const glowColor = props.glowColor || DEFAULTS.glowColor;
  const waveSpeed = Number.isFinite(Number(props.waveSpeed)) ? Number(props.waveSpeed) : DEFAULTS.waveSpeed;
  const travel = Number.isFinite(Number(props.travel)) ? Number(props.travel) : DEFAULTS.travel;
  const overshoot = Number.isFinite(Number(props.overshoot)) ? Number(props.overshoot) : DEFAULTS.overshoot;
  const pulseAt = Number.isFinite(Number(props.pulseAt)) ? Number(props.pulseAt) : DEFAULTS.pulseAt;

  const s = Math.min(w / DESIGN_W, h / DESIGN_H);
  const dotR = (Math.max(1, Number(props.dotSize) || DEFAULTS.dotSize) * s) / 2;

  ctx.save();
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  const maxD = Math.hypot(cx, cy) || 1;

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const dist = Math.hypot(c - cx, r - cy) / maxD;
      const w1 = seg(t, dist * waveSpeed, dist * waveSpeed + travel, outCubic);
      const p2Start = pulseAt + (1 - dist) * 0.25;
      const w2 = seg(t, p2Start, p2Start + 0.15);
      const pulse2 = Math.sin(w2 * Math.PI);
      const scale = w1 * (1 + overshoot * Math.sin(w1 * Math.PI)) + pulse2 * 0.8;
      const alpha = Math.max(0, Math.min(1, 0.25 + w1 * 0.5 + pulse2 * 0.25));
      if (scale <= 0.001) continue;

      const x = ((c + 0.5) / cols) * w;
      const y = ((r + 0.5) / rows) * h;
      const peak = pulse2 > 0.3;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = peak ? peakColor : baseColor;
      if (peak) {
        // 光晕 = canvas 的 shadowBlur（对应 CSS box-shadow 0 0 12px）
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = 12 * s;
      }
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, dotR * scale), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  ctx.restore();
}
