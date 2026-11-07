/**
 * sc-outro-group-photo-launch · 合影尾声（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/outro/outro-group-photo-launch.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - 9 个元素从四方带旋转飞入，cue 从 4f 起每 3f 一个、各飞 12f，起点偏移 ±360–500px，
 *     渲染顺序 = cue 顺序（后到者叠上）；飞行段按屏幕速度做方向性运动模糊（0.3×px/帧，封顶 22）；
 *   - 落地压实：cue+9→16f 接触影收紧 + 1.5% 轻压（**不逐个发光**，Q4）；
 *   - 飞入缓动必须是会过冲的 bezier（y1 > 1），「落地要弹」不是修辞；
 *   - 退后排：字标登场时全员 opacity −12% / saturate −8%（主角登场配角必须让位）；
 *   - crane：rotateX 4°→0 + scale 1.06→1 在前 40f 落下，之后缓推 +0.035；幅度就这么小；
 *   - 氛围三件套：开场光带 2–14f、字标背后舞台光 42→50→58、金尘 20 颗（确定性派生）；
 *   - 字标 letterpress 逐字（delay = 42 + i·1.8, 8f），rule 58→70f 长出、两端延长线射出 6f 淡去。
 *
 * 媒体怎么用：中央那张「合影主照」是素材；其余 8 个元素是抽象功能代表块。
 */

export const meta = {
  title: '合影尾声',
  duration: 4.2,
  source: 'shotcraft',
  sourcePath: 'references/shots/outro/outro-group-photo-launch.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const CUE0 = 4 / FPS;
const CUE_STEP = 3 / FPS;
const FLY = 12 / FPS;
const MARK_AT = 42 / FPS;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);

/** bezier(0.34, 1.4, 0.44, 1)：y1 > 1 才有真过冲（旧版 0.9 从来不过 1，落地发死）。 */
function overBezier(u) {
  const p = clamp01(u);
  const p1x = 0.34;
  const p1y = 1.4;
  const p2x = 0.44;
  const p2y = 1;
  let lo = 0;
  let hi = 1;
  let q = p;
  for (let i = 0; i < 16; i += 1) {
    const bx = 3 * (1 - q) * (1 - q) * q * p1x + 3 * (1 - q) * q * q * p2x + q * q * q;
    if (bx < p) lo = q;
    else hi = q;
    q = (lo + hi) / 2;
  }
  return 3 * (1 - q) * (1 - q) * q * p1y + 3 * (1 - q) * q * q * p2y + q * q * q;
}

/** 确定性伪随机（金尘、姿态）：同一 index 每次渲染一致。 */
function hash(i, salt) {
  const x = Math.sin((i + 1) * 12.9898 + (salt + 1) * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** 9 个元素：方位 / 尺寸 / 姿态，最后一个是合影主照（素材）。 */
const ELEMENTS = [
  { kind: 'nav', w: 0.2, h: 0.055, x: 0.34, y: 0.3, from: [-1, -0.6] },
  { kind: 'card', w: 0.16, h: 0.13, x: 0.16, y: 0.52, from: [-1, 0.4] },
  { kind: 'bar', w: 0.18, h: 0.036, x: 0.62, y: 0.27, from: [1, -0.7] },
  { kind: 'search', w: 0.2, h: 0.05, x: 0.48, y: 0.4, from: [0.6, -1] },
  { kind: 'hero', w: 0.34, h: 0.3, x: 0.5, y: 0.56, from: [0, 1] },
  { kind: 'stat', w: 0.14, h: 0.08, x: 0.76, y: 0.56, from: [1, 0.6] },
  { kind: 'item', w: 0.145, h: 0.045, x: 0.26, y: 0.73, from: [-1, 0.9] },
  { kind: 'doc', w: 0.16, h: 0.11, x: 0.7, y: 0.72, from: [1, 0.9] },
  { kind: 'row', w: 0.28, h: 0.04, x: 0.5, y: 0.83, from: [0.4, 1] },
];

function drawElement(ctx, el, cw, ch, src) {
  if (el.kind === 'hero') {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(0, 0, cw, ch, Math.min(cw, ch) * 0.03) : ctx.rect(0, 0, cw, ch);
    ctx.clip();
    if (src) {
      const sw = src.width || cw;
      const sh = src.height || ch;
      const k = Math.max(cw / sw, ch / sh);
      ctx.drawImage(src, (cw - sw * k) / 2, (ch - sh * k) / 2, sw * k, sh * k);
    } else {
      ctx.fillStyle = '#22262e';
      ctx.fillRect(0, 0, cw, ch);
      ctx.strokeStyle = 'rgba(226, 208, 168, 0.5)';
      ctx.setLineDash([8, 6]);
      ctx.lineWidth = Math.max(1.4, cw * 0.006);
      ctx.strokeRect(cw * 0.06, ch * 0.08, cw * 0.88, ch * 0.84);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(240, 230, 210, 0.9)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 ' + Math.round(ch * 0.08) + 'px system-ui, sans-serif';
      ctx.fillText('合影主照 = 素材', cw / 2, ch * 0.42);
      ctx.font = Math.round(ch * 0.055) + 'px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(210, 196, 168, 0.75)';
      ctx.fillText('props.assetId（团队照 / 产品全家福）', cw / 2, ch * 0.56);
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(238, 226, 200, 0.3)';
    ctx.lineWidth = Math.max(1, cw * 0.004);
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(0, 0, cw, ch, Math.min(cw, ch) * 0.03) : ctx.rect(0, 0, cw, ch);
    ctx.stroke();
    return;
  }
  ctx.save();
  ctx.fillStyle = 'rgba(30, 34, 42, 0.95)';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(0, 0, cw, ch, Math.min(cw, ch) * 0.09) : ctx.rect(0, 0, cw, ch);
  ctx.fill();
  ctx.strokeStyle = 'rgba(226, 208, 168, 0.22)';
  ctx.lineWidth = Math.max(1, cw * 0.006);
  ctx.stroke();
  // 各类元素的内部骨架
  if (el.kind === 'nav') {
    ctx.fillStyle = 'rgba(238, 224, 196, 0.5)';
    for (let i = 0; i < 4; i += 1) ctx.fillRect(cw * (0.05 + i * 0.13), ch * 0.42, cw * 0.08, ch * 0.16);
  } else if (el.kind === 'card') {
    ctx.fillStyle = 'rgba(226, 208, 168, 0.28)';
    ctx.fillRect(cw * 0.1, ch * 0.12, cw * 0.8, ch * 0.46);
    ctx.fillStyle = 'rgba(238, 224, 196, 0.42)';
    ctx.fillRect(cw * 0.1, ch * 0.68, cw * 0.5, ch * 0.1);
  } else if (el.kind === 'bar') {
    ctx.fillStyle = 'rgba(238, 224, 196, 0.45)';
    ctx.fillRect(cw * 0.06, ch * 0.3, cw * 0.5, ch * 0.4);
  } else if (el.kind === 'search') {
    ctx.strokeStyle = 'rgba(238, 224, 196, 0.5)';
    ctx.lineWidth = Math.max(1, ch * 0.1);
    ctx.beginPath();
    ctx.arc(cw * 0.1, ch * 0.5, ch * 0.22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(200, 186, 160, 0.35)';
    ctx.fillRect(cw * 0.22, ch * 0.42, cw * 0.6, ch * 0.16);
  } else if (el.kind === 'stat') {
    ctx.fillStyle = 'rgba(226, 208, 168, 0.6)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 ' + Math.round(ch * 0.44) + 'px system-ui, sans-serif';
    ctx.fillText('3×', cw / 2, ch * 0.46);
  } else if (el.kind === 'item') {
    ctx.fillStyle = 'rgba(226, 208, 168, 0.32)';
    ctx.fillRect(cw * 0.06, ch * 0.34, cw * 0.12, ch * 0.32);
    ctx.fillRect(cw * 0.24, ch * 0.38, cw * 0.5, ch * 0.24);
  } else if (el.kind === 'doc') {
    ctx.fillStyle = 'rgba(226, 208, 168, 0.24)';
    for (let i = 0; i < 4; i += 1) ctx.fillRect(cw * 0.12, ch * (0.16 + i * 0.2), cw * (0.72 - i * 0.1), ch * 0.07);
  } else {
    ctx.fillStyle = 'rgba(226, 208, 168, 0.34)';
    ctx.fillRect(cw * 0.04, ch * 0.34, cw * 0.3, ch * 0.32);
    ctx.fillRect(cw * 0.4, ch * 0.34, cw * 0.56, ch * 0.32);
  }
  ctx.restore();
}

function __renderInner(ctx, t, env) {
  const W = Number(env && env.width) || 1;
  const H = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const time = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
  const m = env && env.media;
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);
  const src = id && m ? (m.image(id) || m.video(id)) : null;

  const s = Math.min(W / 1280, H / 720);
  const baseY = H * 0.5;
  const baseX = W * 0.5;

  ctx.save();
  // 暗场舞台
  const bg = ctx.createRadialGradient(baseX, baseY * 0.86, 0, baseX, baseY, W * 0.78);
  bg.addColorStop(0, '#1d2027');
  bg.addColorStop(0.5, '#111318');
  bg.addColorStop(1, '#07080b');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 背景页面 blur 化作景深（抽象成一片极淡的横向结构线）
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = 'rgba(180, 190, 210, 0.5)';
  ctx.lineWidth = Math.max(1, 2 * s);
  for (let i = 0; i < 9; i += 1) {
    ctx.beginPath();
    ctx.moveTo(W * 0.06, H * (0.16 + i * 0.075));
    ctx.lineTo(W * (0.94 - (i % 3) * 0.1), H * (0.16 + i * 0.075));
    ctx.stroke();
  }
  ctx.restore();

  // ---- crane：rotateX 4°→0（用纵向压缩近似）+ scale 1.06→1 ----
  const craneU = outCubic(clamp01(time / (40 / FPS)));
  const craneScale = 1.06 + (1 - 1.06) * craneU + 0.035 * clamp01((time - 36 / FPS) / 2.2);
  const squash = 1 - 0.04 * (1 - craneU);

  ctx.translate(baseX, baseY);
  ctx.scale(craneScale, craneScale * squash);
  ctx.translate(-baseX, -baseY);

  // ---- 9 个元素：飞入 → 压实 ----
  for (let i = 0; i < ELEMENTS.length; i += 1) {
    const el = ELEMENTS[i];
    const cue = CUE0 + i * CUE_STEP;
    const u = (time - cue) / FLY;
    const cw = W * el.w;
    const chh = H * el.h;
    const tx = W * el.x - cw / 2;
    const ty = H * el.y - chh / 2;
    if (time < cue) continue;

    const e = overBezier(clamp01(u));
    const offX = el.from[0] * (360 + hash(i, 1) * 140) * s;
    const offY = el.from[1] * (360 + hash(i, 2) * 140) * s;
    const px = tx + offX * (1 - e);
    const py = ty + offY * (1 - e);
    const rot = (1 - clamp01(u)) * (el.from[0] >= 0 ? 5 : -5) * (Math.PI / 180);
    // 落地压实：cue+9 → 16f 轻压 1.5%
    const press = clamp01((time - cue - 9 / FPS) / (7 / FPS));
    const pressScale = 1 - 0.015 * Math.sin(press * Math.PI);
    const scale = (1 + 0.12 * (1 - outCubic(clamp01(u)))) * pressScale;

    // 飞行段方向性运动模糊（按屏幕速度）
    const speedPx = Math.hypot(offX, offY) * (Math.abs(1 - e) > 0 ? Math.abs(overBezier(clamp01(u + 1 / 30)) - e) : 0) * 30;
    const blurPx = Math.min(22, speedPx * 0.3);
    const passes = blurPx > 2 ? 3 : 1;

    // 退后排：字标登场时全员让位
    const yieldP = clamp01((time - MARK_AT) / (8 / FPS));
    const dimA = 1 - 0.12 * yieldP;

    for (let p = 0; p < passes; p += 1) {
      ctx.save();
      ctx.globalAlpha = (p === 0 ? 1 : 0.3) * dimA * clamp01(u * 2.2);
      const bx = p === 0 ? 0 : (p - 2) * blurPx * 0.6;
      ctx.translate(px + cw / 2 + bx, py + chh / 2);
      ctx.rotate(rot);
      ctx.scale(scale, scale);
      ctx.translate(-cw / 2, -chh / 2);
      // 接触影：飞行段悬空（大而糊），落地收紧
      const contact = outCubic(clamp01((time - cue - 6 / FPS) / (10 / FPS)));
      ctx.save();
      ctx.globalAlpha = (p === 0 ? 1 : 0) * 0.5;
      ctx.shadowColor = 'rgba(4, 5, 8, ' + (0.5 - contact * 0.18).toFixed(3) + ')';
      ctx.shadowBlur = (26 - contact * 20) * s;
      ctx.shadowOffsetY = (16 - contact * 13) * s;
      ctx.fillStyle = 'rgba(12, 14, 18, 1)';
      ctx.fillRect(0, 0, cw, chh);
      ctx.restore();
      drawElement(ctx, el, cw, chh, src);
      ctx.restore();
    }
  }

  // ---- 开场光带：2–14f 扫过（600px 宽 overlay 峰值 0.12）----
  const bandP = clamp01((time - 2 / FPS) / (12 / FPS));
  if (bandP > 0 && bandP < 1) {
    const bx = -0.3 * W + bandP * 1.6 * W;
    const g = ctx.createLinearGradient(bx - W * 0.24, 0, bx + W * 0.24, 0);
    g.addColorStop(0, 'rgba(255, 246, 226, 0)');
    g.addColorStop(0.5, 'rgba(255, 246, 226, ' + (0.12 * Math.sin(bandP * Math.PI)).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(255, 246, 226, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // ---- 金尘：20 颗，确定性派生，微闪 ----
  for (let i = 0; i < 20; i += 1) {
    const r = 2.4 + hash(i, 3) * 1.8;
    const drift = (time * (0.02 + hash(i, 4) * 0.03)) % 1;
    const gx = W * (0.08 + hash(i, 5) * 0.84);
    const gy = H * (0.9 - drift * 0.75);
    const op = (0.35 + hash(i, 6) * 0.35) * (0.6 + 0.4 * Math.sin(time * 3 + i));
    ctx.save();
    ctx.globalAlpha = clamp01(op);
    ctx.fillStyle = 'rgba(255, 226, 168, 1)';
    ctx.shadowColor = 'rgba(255, 214, 140, 0.9)';
    ctx.shadowBlur = r * 4;
    ctx.beginPath();
    ctx.arc(gx, gy, r * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---- 舞台光：42→50→58f 0→0.5→0.25（字标背后）----
  const stageAt = (time - MARK_AT) / (16 / FPS);
  if (stageAt > 0) {
    const k = stageAt < 0.5 ? stageAt * 2 : 1 - (stageAt - 0.5) * 1.5;
    const stage = ctx.createRadialGradient(baseX, H * 0.42, 0, baseX, H * 0.42, W * 0.42);
    stage.addColorStop(0, 'rgba(255, 226, 170, ' + (0.5 * clamp01(k)).toFixed(3) + ')');
    stage.addColorStop(0.55, 'rgba(255, 206, 140, ' + (0.16 * clamp01(k)).toFixed(3) + ')');
    stage.addColorStop(1, 'rgba(255, 206, 140, 0)');
    ctx.fillStyle = stage;
    ctx.fillRect(0, 0, W, H);
  }

  // ---- 字标 letterpress 逐字 ----
  const wordmark = String(props.wordmark || 'video-shotcraft');
  const wmChars = Array.from(wordmark);
  const wmFont = Math.round(H * 0.164);
  ctx.save();
  ctx.font = '700 ' + wmFont + 'px system-ui, sans-serif';
  const wmWidths = wmChars.map((c) => ctx.measureText(c).width);
  const wmTotal = wmWidths.reduce((a, b) => a + b, 0);
  let wmX = baseX - wmTotal / 2;
  const wmY = H * 0.4;
  for (let i = 0; i < wmChars.length; i += 1) {
    const at = MARK_AT + i * 1.8 / FPS;
    const p = outCubic(clamp01((time - at) / (8 / FPS)));
    if (p > 0) {
      ctx.save();
      ctx.globalAlpha = clamp01(p * 1.4) * (1 - 0.12 * clamp01((time - MARK_AT - 8 / FPS) / 0.3) * 0.4);
      // letterpress：从上方 0.12em 压下来 + 压痕
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(250, 244, 232, ' + (0.55 + 0.45 * p).toFixed(3) + ')';
      ctx.fillText(wmChars[i], wmX, wmY + (1 - p) * wmFont * 0.12);
      // 压痕：极淡的下缘暗线
      ctx.shadowColor = 'rgba(10, 8, 6, 0.6)';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 2 * s * (1 - p);
      ctx.fillStyle = 'rgba(250, 244, 232, ' + (0.1 * p).toFixed(3) + ')';
      ctx.fillText(wmChars[i], wmX, wmY + (1 - p) * wmFont * 0.12);
      ctx.restore();
    }
    wmX += wmWidths[i];
  }
  ctx.restore();

  // ---- rule：58→70f 长出；两端延长线 8f 射出、6f 淡去 ----
  const ruleU = outCubic(clamp01((time - 58 / FPS) / (12 / FPS)));
  if (ruleU > 0) {
    const ruleW = W * 0.34 * ruleU;
    const ruleY = H * 0.455;
    ctx.save();
    ctx.fillStyle = 'rgba(238, 226, 200, 0.7)';
    ctx.fillRect(baseX - ruleW / 2, ruleY, ruleW, Math.max(1, 2 * s));
    // 延长线
    const extP = clamp01((time - 66 / FPS) / (8 / FPS));
    if (extP > 0) {
      const fade = 1 - clamp01((time - 74 / FPS) / (6 / FPS));
      if (fade > 0) {
        ctx.globalAlpha = fade * 0.7;
        ctx.fillStyle = 'rgba(238, 226, 200, 0.5)';
        const extW = W * 0.19 * outCubic(extP);
        ctx.fillRect(baseX - ruleW / 2 - extW, ruleY, extW, Math.max(1, 1.4 * s));
        ctx.fillRect(baseX + ruleW / 2, ruleY, extW, Math.max(1, 1.4 * s));
      }
    }
    ctx.restore();
  }

  // 眉题：品牌短句（字标上方，晚于字标）
  const kickerP = outCubic(clamp01((time - (MARK_AT + 6 / FPS)) / (14 / FPS)));
  if (kickerP > 0) {
    ctx.save();
    ctx.globalAlpha = kickerP * 0.7;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(238, 226, 200, 0.85)';
    ctx.font = '500 ' + Math.round(H * 0.03) + 'px system-ui, sans-serif';
    ctx.fillText(String(props.kicker || 'ONE PRODUCT, ONE STAGE'), baseX, H * 0.315);
    ctx.restore();
  }

  ctx.restore();

  // 尾帧：落定后 sign-off hold（不加解说 caption，保持干净）
  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = 'rgba(226, 208, 168, 0.6)';
  ctx.font = '500 ' + Math.round(H * 0.022) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('GROUP PHOTO · 9 ELEMENTS', W * 0.95, H * 0.95);
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
