/**
 * sc-integration-hub-map · 集成枢纽图（2026-11-06 修好版）
 *
 * 配方来源：video-shotcraft / references/shots/ui-entrance/integration-hub-map.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 2026-11-06 修复记录：
 *   旧版翻面是「整页 scaleX(|cosθ|) + 背面水平镜像」—— 仿射近似，整页前后等宽、
 *   没有近大远小，侧棱只有一道平面光带，读起来像「一张图被压扁」而不是「一页纸翻过去」。
 *   现在改成：
 *     - 按投影做**条带渲染**：x' = x·cosθ·d / (d − x·sinθ)（d 为视距），
 *       每一竖条单独算投影宽度再拉伸贴图 —— 这是真正的透视收束，右缘（近）比左缘（远）宽；
 *     - 页面有厚度 t：翻面期间在右缘画一条 t·|sinθ| 的**侧棱面**，90° 时刻最宽、
 *       并保留 2f 脉冲 bloom（4f 归零）；
 *     - 只剩下翻面那 35 帧用条带（40 条）；翻面前后各只画一次整页，性能不炸。
 *   注意：这是「二维投影 + 逐条带贴图」，不是真的 3D 引擎；斜边接缝会有极细的竖纹，
 *   40 条带下看不出来，但别把这条当「100% 还原」吹。
 *
 * 卡文要点（没变）：完整 180°、35f、ease-out(cubic)；两拍制接入（五图标同帧 → +10f 五管同帧起画、9f 齐长）；
 * 光管内脉冲沿「图标 → 中枢」循环。
 */

export const meta = {
  title: '集成枢纽图',
  duration: 4.4,
  source: 'shotcraft',
  sourcePath: 'references/shots/ui-entrance/integration-hub-map.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const FLIP_AT = 0.5;
const FLIP_DUR = 35 / FPS;
const LAND = FLIP_AT + FLIP_DUR;
const ICONS_AT = LAND + 3 / FPS;
const PIPES_AT = ICONS_AT + 10 / FPS;
const PIPE_DUR = 9 / FPS;

/** 视距（与页宽同数量级：太小会畸变，太大就退化成仿射）。 */
const PERSP = 0.85;
/** 页面厚度（画幅高的比例）。 */
const THICK = 0.022;
const STRIPS = 40;

const APP_NAMES = ['Git', 'Figma', 'Slack', 'Drive', 'Jira'];
const PIPE_COLORS = [
  { line: 'rgba(96, 214, 255, 0.85)', glow: 'rgba(96, 214, 255,' },
  { line: 'rgba(168, 130, 255, 0.85)', glow: 'rgba(168, 130, 255,' },
  { line: 'rgba(120, 240, 180, 0.85)', glow: 'rgba(120, 240, 180,' },
  { line: 'rgba(255, 196, 100, 0.85)', glow: 'rgba(255, 196, 100,' },
  { line: 'rgba(255, 130, 160, 0.85)', glow: 'rgba(255, 130, 160,' },
];

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const outBack = (x) => {
  const p = clamp01(x);
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
};

/**
 * 页面绕自身竖轴转 θ 后，世界坐标 x 的屏幕投影（相对页心）。
 * 透视相机在 z = +d：x' = x·cosθ·d / (d − x·sinθ)。
 * 纯函数，测试直接调。
 */
export function projectX(worldX, theta, d) {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const dist = Math.max(1e-6, d);
  const denom = dist - worldX * sin;
  if (Math.abs(denom) < 1e-6) return 0;
  return (worldX * cos * dist) / denom;
}

/** 翻到 θ 时，右缘的侧棱在屏幕上的可见宽度（|t·sinθ| 的投影近似）。 */
export function edgeWidth(theta, thickness) {
  return Math.abs(Math.sin(theta)) * thickness;
}

/** 旧文档页：背面用不到的「上一代」页面 —— 纯线框，读作旧版。 */
function drawOldPage(ctx, pw, ph) {
  ctx.save();
  ctx.fillStyle = '#20222c';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(0, 0, pw, ph, pw * 0.012);
  else ctx.rect(0, 0, pw, ph);
  ctx.fill();
  ctx.fillStyle = 'rgba(150, 160, 190, 0.35)';
  ctx.fillRect(pw * 0.07, ph * 0.1, pw * 0.32, ph * 0.035);
  for (let i = 0; i < 9; i += 1) {
    ctx.fillStyle = 'rgba(130, 142, 170, ' + (0.22 - i * 0.018).toFixed(3) + ')';
    ctx.fillRect(pw * 0.07, ph * (0.2 + i * 0.08), pw * (0.66 - (i % 3) * 0.12), ph * 0.028);
  }
  ctx.fillStyle = 'rgba(120, 190, 255, 0.5)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 ' + Math.round(ph * 0.045) + 'px system-ui, sans-serif';
  ctx.fillText('OLD DOCS', pw * 0.07, ph * 0.93);
  ctx.restore();
}

/** 新中枢页：中央卡是素材；四周留出五个接入位。 */
function drawHubPage(ctx, pw, ph, src) {
  ctx.save();
  ctx.fillStyle = '#0e1020';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(0, 0, pw, ph, pw * 0.012);
  else ctx.rect(0, 0, pw, ph);
  ctx.fill();

  ctx.fillStyle = 'rgba(30, 34, 58, 0.9)';
  ctx.fillRect(0, 0, pw, ph * 0.08);
  ctx.fillStyle = 'rgba(130, 150, 220, 0.5)';
  ctx.fillRect(pw * 0.03, ph * 0.028, pw * 0.16, ph * 0.024);

  const cw = pw * 0.4;
  const chh = ph * 0.34;
  const cx = pw * 0.5 - cw / 2;
  const cy = ph * 0.44 - chh / 2;
  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(cx, cy, cw, chh, cw * 0.03);
  else ctx.rect(cx, cy, cw, chh);
  ctx.clip();
  if (src) {
    const sw = src.width || cw;
    const sh = src.height || chh;
    const k = Math.max(cw / sw, chh / sh);
    ctx.drawImage(src, cx + (cw - sw * k) / 2, cy + (chh - sh * k) / 2, sw * k, sh * k);
  } else {
    ctx.fillStyle = '#191d34';
    ctx.fillRect(cx, cy, cw, chh);
    ctx.strokeStyle = 'rgba(120, 176, 255, 0.44)';
    ctx.setLineDash([pw * 0.008, pw * 0.007]);
    ctx.lineWidth = Math.max(1, pw * 0.0016);
    ctx.strokeRect(cx + cw * 0.06, cy + chh * 0.08, cw * 0.88, chh * 0.84);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(196, 218, 255, 0.9)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.round(chh * 0.11) + 'px system-ui, sans-serif';
    ctx.fillText('中枢卡 = 素材', cx + cw / 2, cy + chh * 0.42);
    ctx.font = Math.round(chh * 0.075) + 'px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(150, 176, 226, 0.72)';
    ctx.fillText('props.assetId（产品页截图）', cx + cw / 2, cy + chh * 0.58);
  }
  ctx.restore();

  ctx.strokeStyle = 'rgba(120, 160, 240, 0.45)';
  ctx.lineWidth = Math.max(1, pw * 0.0014);
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(cx, cy, cw, chh, cw * 0.03);
  else ctx.rect(cx, cy, cw, chh);
  ctx.stroke();

  ctx.fillStyle = 'rgba(40, 46, 76, 0.8)';
  ctx.fillRect(pw * 0.05, ph * 0.84, pw * 0.9, ph * 0.09);
  ctx.fillStyle = 'rgba(150, 196, 255, 0.55)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 ' + Math.round(ph * 0.036) + 'px system-ui, sans-serif';
  ctx.fillText('NEW HUB · 5 INTEGRATIONS', pw * 0.07, ph * 0.885);
  ctx.restore();
}

/** 图标位：翻面落定后五枚**同帧**弹现。 */
function iconSpots(pw, ph) {
  return [
    { x: 0.11, y: 0.24 },
    { x: 0.11, y: 0.62 },
    { x: 0.89, y: 0.24 },
    { x: 0.89, y: 0.62 },
    { x: 0.5, y: 0.86 },
  ].map((p) => ({ x: p.x * pw, y: p.y * ph }));
}

function drawAppIcon(ctx, x, y, r, name, p, color) {
  if (p <= 0) return;
  const scale = 0.55 + 0.45 * outBack(p);
  ctx.save();
  ctx.globalAlpha = clamp01(p * 1.6);
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.fillStyle = 'rgba(22, 26, 46, 0.96)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-r, -r, r * 2, r * 2, r * 0.3);
  else ctx.rect(-r, -r, r * 2, r * 2);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.4, r * 0.09);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.2, r * 0.1);
  ctx.beginPath();
  if (name === 'Git') {
    ctx.arc(0, 0, r * 0.42, 0, Math.PI * 2);
    ctx.moveTo(-r * 0.42, 0);
    ctx.lineTo(r * 0.42, 0);
  } else if (name === 'Figma') {
    ctx.arc(-r * 0.18, -r * 0.22, r * 0.22, 0, Math.PI * 2);
    ctx.arc(r * 0.18, -r * 0.22, r * 0.22, 0, Math.PI * 2);
    ctx.arc(-r * 0.18, r * 0.22, r * 0.22, 0, Math.PI * 2);
  } else if (name === 'Slack') {
    ctx.moveTo(-r * 0.3, -r * 0.32);
    ctx.lineTo(r * 0.3, -r * 0.32);
    ctx.moveTo(-r * 0.3, 0);
    ctx.lineTo(r * 0.3, 0);
    ctx.moveTo(-r * 0.3, r * 0.32);
    ctx.lineTo(r * 0.3, r * 0.32);
  } else if (name === 'Drive') {
    ctx.moveTo(0, -r * 0.44);
    ctx.lineTo(r * 0.44, 0);
    ctx.lineTo(0, r * 0.44);
    ctx.lineTo(-r * 0.44, 0);
    ctx.closePath();
  } else {
    ctx.moveTo(-r * 0.42, 0);
    ctx.lineTo(-r * 0.1, -r * 0.34);
    ctx.lineTo(r * 0.42, r * 0.34);
    ctx.lineTo(-r * 0.42, r * 0.34);
    ctx.closePath();
  }
  ctx.stroke();
  ctx.restore();
}

/** 光管：按各自长度归一，同帧到达；管内亮脉冲沿「图标 → 中枢」方向循环。 */
function drawPipe(ctx, from, to, color, progress, time, phase, pw) {
  if (progress <= 0) return;
  const totalLen = Math.hypot(to.x - from.x, to.y - from.y);
  const built = totalLen * progress;
  const midX = (from.x + to.x) / 2;
  const elbow = { x: midX, y: from.y };
  const seg1 = Math.hypot(elbow.x - from.x, elbow.y - from.y);
  const seg2 = Math.hypot(to.x - elbow.x, to.y - elbow.y);
  const pathLen = seg1 + seg2 || 1;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = color.glow + '0.14)';
  ctx.lineWidth = Math.max(5, pw * 0.008);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  let remain = built;
  if (remain <= seg1) {
    ctx.lineTo(from.x + (elbow.x - from.x) * (remain / (seg1 || 1)), from.y);
  } else {
    ctx.lineTo(elbow.x, elbow.y);
    remain -= seg1;
    ctx.lineTo(elbow.x, elbow.y + (to.y - elbow.y) * (remain / (seg2 || 1)));
  }
  ctx.stroke();
  ctx.strokeStyle = color.line;
  ctx.lineWidth = Math.max(1.6, pw * 0.0022);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  remain = built;
  if (remain <= seg1) {
    ctx.lineTo(from.x + (elbow.x - from.x) * (remain / (seg1 || 1)), from.y);
  } else {
    ctx.lineTo(elbow.x, elbow.y);
    remain -= seg1;
    ctx.lineTo(elbow.x, elbow.y + (to.y - elbow.y) * (remain / (seg2 || 1)));
  }
  ctx.stroke();

  if (progress >= 1) {
    const speed = 4.6 * 30;
    const t = (time * speed) / pathLen + phase;
    const cycle = t - Math.floor(t / 1.4) * 1.4;
    const head = clamp01(cycle / 1.0);
    const posAt = (u) => {
      const d = u * pathLen;
      if (d <= seg1) return { x: from.x + (elbow.x - from.x) * (d / (seg1 || 1)), y: from.y };
      const d2 = d - seg1;
      return { x: elbow.x, y: elbow.y + (to.y - elbow.y) * (d2 / (seg2 || 1)) };
    };
    const p0 = posAt(Math.max(0, head - 0.14));
    const p1 = posAt(head);
    const grad = ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
    grad.addColorStop(0, color.glow + '0)');
    grad.addColorStop(1, color.glow + '0.95)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = Math.max(2.4, pw * 0.004);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    const steps = 10;
    for (let i = 1; i <= steps; i += 1) {
      const q = posAt(Math.max(0, head - 0.14 + (0.14 * i) / steps));
      ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
    ctx.fillStyle = color.glow + '1)';
    ctx.beginPath();
    ctx.arc(p1.x, p1.y, Math.max(2, pw * 0.0028), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 一页的两面怎么画。 */
function drawFace(ctx, pw, ph, src, back) {
  if (back) drawHubPage(ctx, pw, ph, src);
  else drawOldPage(ctx, pw, ph);
}

/**
 * 条带翻面：逐竖条做投影贴图。
 * 每条带把「世界 x 区间」线性映射到「投影后的屏幕区间」——40 条下透视收束看得很真。
 */
function drawFlippedFace(ctx, pw, ph, src, theta, d, back) {
  const half = pw / 2;
  let drawn = 0;
  for (let i = 0; i < STRIPS; i += 1) {
    const u0 = -1 + (2 * i) / STRIPS;
    const u1 = -1 + (2 * (i + 1)) / STRIPS;
    const x0 = projectX(u0 * half, theta, d);
    const x1 = projectX(u1 * half, theta, d);
    const wpx = Math.abs(x1 - x0);
    if (wpx < 0.35) continue;
    const worldW = (u1 - u0) * half;
    if (Math.abs(worldW) < 1e-6) continue;
    const sx = (x1 - x0) / worldW;

    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.min(x0, x1), -ph / 2 - 1, wpx + 0.6, ph + 2);
    ctx.clip();
    ctx.translate(x0, 0);
    ctx.scale(sx, 1);
    ctx.translate(-u0 * half, 0);
    ctx.translate(-pw / 2, -ph / 2);
    // 背面内容预镜像：翻过去看到的是「正面朝外」的新页，而不是镜像反转的文字
    if (back) {
      ctx.translate(pw, 0);
      ctx.scale(-1, 1);
    }
    drawFace(ctx, pw, ph, src, back);
    ctx.restore();
    drawn += 1;
  }
  return drawn;
}

/** 侧棱：页面厚度在翻面时露出的那条窄面。 */
function drawSideEdge(ctx, pw, ph, theta, thick, s) {
  const half = pw / 2;
  const wband = edgeWidth(theta, thick);
  if (wband < 0.6) return 0;
  const x = projectX(half, theta, PERSP * pw * 0.5);
  const front = Math.sin(theta) >= 0;
  const bandX = front ? x : x - wband;
  const g = ctx.createLinearGradient(bandX, -ph / 2, bandX + wband, ph / 2);
  g.addColorStop(0, 'rgba(226, 236, 255, 0.92)');
  g.addColorStop(0.35, 'rgba(150, 172, 220, 0.75)');
  g.addColorStop(1, 'rgba(70, 86, 130, 0.6)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(bandX, -ph / 2, Math.max(0.8, wband), ph);
  // 纸的厚度分层的极细亮线（让它读成「有厚度」而不是「一条光带」）
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = Math.max(0.6, s * 0.8);
  ctx.beginPath();
  ctx.moveTo(bandX + 0.5, -ph / 2);
  ctx.lineTo(bandX + 0.5, ph / 2);
  ctx.stroke();
  ctx.restore();
  return wband;
}

function __renderInner(ctx, t, env) {
  const w = Number(env && env.width) || 1;
  const h = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const time = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
  const m = env && env.media;
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);
  const src = id && m ? (m.video(id) || m.image(id)) : null;

  const s = Math.min(w / 1280, h / 720);
  const pw = w * 0.66;
  const ph = h * 0.72;
  const thick = h * THICK;
  const d = pw * PERSP;

  ctx.save();
  const bg = ctx.createRadialGradient(w * 0.5, h * 0.46, 0, w * 0.5, h * 0.5, w * 0.72);
  bg.addColorStop(0, '#181229');
  bg.addColorStop(0.55, '#0e0a18');
  bg.addColorStop(1, '#06040b');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.globalAlpha = 0.5;
  const neonRects = [
    [0.06, 0.12, 0.14, 0.2],
    [0.82, 0.16, 0.12, 0.16],
    [0.74, 0.72, 0.18, 0.14],
    [0.1, 0.68, 0.1, 0.16],
  ];
  for (const [rx, ry, rw, rh] of neonRects) {
    ctx.strokeStyle = 'rgba(140, 110, 255, 0.22)';
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeRect(w * rx, h * ry, w * rw, h * rh);
  }
  ctx.restore();

  // ---- 翻面：35f ease-out(cubic)，完整 180°；翻面期间条带透视，前后各画一次整页 ----
  const flipU = clamp01((time - FLIP_AT) / FLIP_DUR);
  const angle = outCubic(flipU) * Math.PI;
  // 用**几何角度**判断露哪一面：翻页缓动是 ease-out，时间过半时早就转过 90° 了
  const showingBack = angle >= Math.PI / 2;

  ctx.save();
  ctx.translate(w / 2, h / 2);
  if (flipU <= 0) {
    ctx.translate(-pw / 2, -ph / 2);
    drawFace(ctx, pw, ph, src, false);
  } else if (flipU >= 1) {
    ctx.translate(-pw / 2, -ph / 2);
    drawFace(ctx, pw, ph, src, true);
  } else {
    drawFlippedFace(ctx, pw, ph, src, angle, d, showingBack);
    drawSideEdge(ctx, pw, ph, angle, thick, s);
  }
  ctx.restore();

  // ---- 侧棱瞬闪：跟着**几何角度**走（ease-out 让 90° 比时间中点早到，按时间算会错位）----
  const nearEdgeOn = 1 - Math.min(1, Math.abs(angle - Math.PI / 2) / 0.3);
  if (nearEdgeOn > 0) {
    const pulse = Math.pow(nearEdgeOn, 1.5);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const g = ctx.createLinearGradient(w * 0.5 - w * 0.06, 0, w * 0.5 + w * 0.06, 0);
    g.addColorStop(0, 'rgba(255, 240, 255, 0)');
    g.addColorStop(0.5, 'rgba(255, 244, 255, ' + (0.85 * pulse).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(255, 240, 255, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(w * 0.44, h * 0.1, w * 0.12, h * 0.8);
    ctx.restore();
  }

  // ---- 两拍制接入：五图标同帧 → +10f 五管同帧 ----
  const spots = iconSpots(pw * 0.9, ph * 0.9).map((p) => ({ x: p.x + pw * 0.05, y: p.y + ph * 0.05 }));
  const hub = { x: w / 2, y: h / 2 - ph / 2 + ph * 0.44 };
  const iconP = clamp01((time - ICONS_AT) / 0.28);
  const pipeP = clamp01((time - PIPES_AT) / PIPE_DUR);

  for (let i = 0; i < spots.length; i += 1) {
    const from = { x: w / 2 - pw / 2 + spots[i].x, y: h / 2 - ph / 2 + spots[i].y };
    const to = i === 4 ? { x: hub.x, y: hub.y + ph * 0.17 } : { x: i < 2 ? hub.x - pw * 0.2 : hub.x + pw * 0.2, y: hub.y };
    drawPipe(ctx, from, to, PIPE_COLORS[i], pipeP, time, i * 0.28, pw);
  }

  for (let i = 0; i < spots.length; i += 1) {
    drawAppIcon(ctx, w / 2 - pw / 2 + spots[i].x, h / 2 - ph / 2 + spots[i].y, Math.min(pw, ph) * 0.062, APP_NAMES[i], iconP, PIPE_COLORS[i].line);
  }

  if (pipeP >= 1) {
    const breath = 0.5 + 0.5 * Math.sin((time - PIPES_AT - PIPE_DUR) * 2.4);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const g = ctx.createRadialGradient(hub.x, hub.y, 0, hub.x, hub.y, pw * 0.42);
    g.addColorStop(0, 'rgba(120, 160, 255, ' + (0.05 + 0.09 * breath).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(120, 160, 255, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(w / 2 - pw / 2, h / 2 - ph / 2, pw, ph);
    ctx.restore();
  }

  // 顶部 mono：翻面角度（编辑期校对用）
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(150, 170, 230, 0.5)';
  ctx.font = '500 ' + Math.round(h * 0.024) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('ROTATE-Y ' + String(Math.round((angle * 180) / Math.PI)).padStart(3, ' ') + '°  ·  STRIPS ' + STRIPS + '  ·  PERSP ' + PERSP, w * 0.04, h * 0.055);
  ctx.restore();

  ctx.restore();
}


/**
 * 画框适配外壳（本批 35 张统一）：
 * 卡是按 16:9 构的；画布更窄（尤其 720×1280）时把整幅构图等比缩到能放下为止并居中，
 * 而不是让每个坐标自己去适应 —— 这样任何画框下都不会有内容越出边界。
 * 16:9 下 k=1，与未加外壳时逐像素一致。
 */
export function render(ctx, t, env) {
  const W = Number(env && env.width) || 1;
  const H = Number(env && env.height) || 1;
  const k = Math.min(1, (W / H) / (16 / 9));
  ctx.save();
  if (k < 0.999) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(W / 2, H / 2);
    ctx.scale(k, k);
    ctx.translate(-W / 2, -H / 2);
  }
  try {
    __renderInner(ctx, t, env);
  } finally {
    ctx.restore();
  }
}
