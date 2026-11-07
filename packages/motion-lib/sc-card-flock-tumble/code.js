/**
 * sc-card-flock-tumble · 卡片群翻飞转场（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/transition/card-flock-tumble.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权与归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas + 单文件纯函数）。
 *
 * 卡文要点落实：
 *   - 三张页卡各自 k0（近 90° 侧棱薄边）→ k1（翻飞中段）→ k2（阶梯站定），**一条 Catmull-Rom 贯穿**，
 *     分段 lerp 会被读出速度台阶（判例原话「丝滑流畅」）；
 *   - 站定后**不许静止**：ry/rx/rz 继续以 0.34/-0.1/0.05 度每帧慢转；
 *   - 收束 10f ease-in 吸入中心、透明度前 60% 满格（吸入必须可读）；
 *   - 闪核：径向白热核 + 全屏 12% 微曝，6f 指数衰减；
 *   - 烟雾环**单圈**：极坐标絮边 + 奶桃→粉→紫竖向渐变，只加径向光，不画描边几何环、不放粒子；
 *   - 巨字收束到点后 4f 就砸进来：14f 1.22→1 且字距 +0.06em→−0.025em，之后极缓长大；
 *   - 全程零 blur（判例：翻飞/收束加模糊均被裁）。
 */

export const meta = {
  title: '卡片群翻飞转场',
  duration: 4.5,
  source: 'shotcraft',
  sourcePath: 'references/shots/transition/card-flock-tumble.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

/** 声明媒体需求：三张页卡共用同一条素材，props.assetId 缺省时走占位。 */
export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const FLY_END = 44 / FPS;        // ~1.467s：翻飞完
const COLLAPSE_END = 62 / FPS;   // ~2.067s：吸入到点
const CORE_AT = COLLAPSE_END;    // 闪核与吸入同帧
const WORD_AT = 66 / FPS;        // 到点后 4f 砸字
const WORD_SNAP = 14 / FPS;      // 14f snappy

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const inQuad = (x) => clamp01(x) * clamp01(x);
const seg = (t, a, b, ease) => (b <= a ? (t >= b ? 1 : 0) : (ease || clamp01)(clamp01((t - a) / (b - a))));

/** Catmull-Rom：p1→p2 段，u∈[0,1]，切向连续（这就是「丝滑」的机制）。 */
function catmull(p0, p1, p2, p3, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

/** 确定性伪随机：同一 k 每次渲染得到同一抖动（渲染必须可复现）。 */
function jitter(k, axis) {
  return ((((k * 7 + axis * 13) % 9) + 9) % 9 - 4) * 2;
}

/** 三卡的姿态关键帧（归一化坐标，随画布缩放）。 */
function poseKeyframes(w, h) {
  const cx = w / 2;
  const cy = h / 2 + h * 0.055; // 画面中心下移 30px（按 720p 折算）
  const cw = w * 0.36;
  const ch = h * 0.4;
  const stair = [
    { dx: -0.78, dy: 0.1, ry: -86, rx: 6, rz: -9, s: 0.86 },
    { dx: -0.5, dy: 0.02, ry: -72, rx: 4, rz: -4, s: 0.94 },
    { dx: -0.22, dy: -0.06, ry: -60, rx: 2, rz: -1, s: 1.0 },
  ];
  const mid = [
    { dx: -0.62, dy: -0.26, ry: 42, rx: -16, rz: 16, s: 1.18 },
    { dx: -0.34, dy: -0.2, ry: 28, rx: -10, rz: 11, s: 1.22 },
    { dx: -0.06, dy: -0.14, ry: 14, rx: -6, rz: 7, s: 1.26 },
  ];
  // 阶梯站定：三卡大幅重叠成一叠（判例：阶梯要读作一组，不是三张分开）
  const rest = [
    { dx: 0.02, dy: 0.1, ry: 13, rx: 7, rz: -3.2, s: 1.62 },
    { dx: 0.0, dy: 0.04, ry: 9, rx: 5, rz: -1.4, s: 1.68 },
    { dx: -0.015, dy: -0.03, ry: 5, rx: 3, rz: 0.4, s: 1.74 },
  ];
  return { cx, cy, cw, ch, stair, mid, rest };
}

function cardPose(t, k, geo) {
  const s0 = geo.stair[k];
  const m1 = geo.mid[k];
  const r2 = geo.rest[k];
  const jx = jitter(k, 1) / 720;
  const jy = jitter(k, 2) / 720;

  // k0：侧棱薄边（x 方向压到近 0 靠 ry 逼近 90°），初始在画外更靠左
  const p0 = { dx: s0.dx - 0.16, dy: s0.dy + 0.04, ry: s0.ry, rx: s0.rx, rz: s0.rz, s: s0.s };
  const p1 = { dx: m1.dx, dy: m1.dy, ry: m1.ry, rx: m1.rx, rz: m1.rz, s: m1.s };
  const p3 = { dx: r2.dx + 0.1, dy: r2.dy, ry: r2.ry + 8, rx: r2.rx, rz: r2.rz + 3, s: r2.s };

  // 翻飞段：一条 Catmull-Rom 贯穿 p0→p1→p3（端点镜像当幽灵控制点）
  const u = seg(t, 0, FLY_END, outCubic);
  const g0 = { dx: p0.dx * 2 - p1.dx, dy: p0.dy * 2 - p1.dy, ry: p0.ry * 2 - p1.ry, rx: p0.rx * 2 - p1.rx, rz: p0.rz * 2 - p1.rz, s: p0.s * 2 - p1.s };
  const g3 = { dx: p3.dx * 2 - p1.dx, dy: p3.dy * 2 - p1.dy, ry: p3.ry * 2 - p1.ry, rx: p3.rx * 2 - p1.rx, rz: p3.rz * 2 - p1.rz, s: p3.s * 2 - p1.s };

  // 样条分两段（p0→p1，u<0.5；p1→p3，u≥0.5），每段各自 Catmull-Rom 保证一阶导连续
  let q;
  if (u < 0.5) {
    const v = u * 2;
    q = {
      dx: catmull(g0.dx, p0.dx, p1.dx, p3.dx, v * 0.8),
      dy: catmull(g0.dy, p0.dy, p1.dy, p3.dy, v * 0.8),
      ry: catmull(g0.ry, p0.ry, p1.ry, p3.ry, v * 0.8),
      rx: catmull(g0.rx, p0.rx, p1.rx, p3.rx, v * 0.8),
      rz: catmull(g0.rz, p0.rz, p1.rz, p3.rz, v * 0.8),
      s: catmull(g0.s, p0.s, p1.s, p3.s, v * 0.8),
    };
  } else {
    const v = (u - 0.5) * 2;
    q = {
      dx: catmull(p0.dx, p1.dx, p3.dx, g3.dx, 0.2 + v * 0.8),
      dy: catmull(p0.dy, p1.dy, p3.dy, g3.dy, 0.2 + v * 0.8),
      ry: catmull(p0.ry, p1.ry, p3.ry, g3.ry, 0.2 + v * 0.8),
      rx: catmull(p0.rx, p1.rx, p3.rx, g3.rx, 0.2 + v * 0.8),
      rz: catmull(p0.rz, p1.rz, p3.rz, g3.rz, 0.2 + v * 0.8),
      s: catmull(p0.s, p1.s, p3.s, g3.s, 0.2 + v * 0.8),
    };
    q.dx += jx * v;
    q.dy += jy * v;
  }

  // 站定慢转：从 FLY_END 起叠加低角速度（静态帧会被判成「停住了」）
  const idleT = Math.max(0, t - FLY_END);
  const idleEase = clamp01(idleT / (14 / FPS));
  const idleEaseSq = idleEase * idleEase;
  q.ry += 0.34 * (idleT * FPS) * idleEaseSq;
  q.rx += -0.1 * (idleT * FPS) * idleEaseSq;
  q.rz += 0.05 * (idleT * FPS) * idleEaseSq;

  // 收束：10f ease-in 吸入中心缩小；透明度前 60% 满格
  const col = seg(t, FLY_END + 0.3, COLLAPSE_END, inQuad);
  let alpha = 1;
  if (col > 0) {
    q.dx *= 1 - col;
    q.dy *= 1 - col;
    q.s *= 1 - 0.82 * col;
    q.ry *= 1 - col;
    q.rx *= 1 - col;
    q.rz *= 1 - col;
    alpha = col < 0.6 ? 1 : 1 - (col - 0.6) / 0.4;
  }
  return {
    x: geo.cx + q.dx * geo.cw,
    y: geo.cy + q.dy * geo.ch,
    ry: q.ry,
    rx: q.rx,
    rz: q.rz,
    s: q.s,
    alpha: Math.max(0, Math.min(1, alpha)),
  };
}

/** 页卡：按 ry 做横向压缩 + 亮面/暗面 shading，读出「薄边翻过来」的体积。 */
function drawCard(ctx, pose, w, h, src, label, index) {
  const cw = w * 0.36 * pose.s;
  const ch = h * 0.4 * pose.s;
  const ry = (pose.ry * Math.PI) / 180;
  const squeeze = Math.max(0.06, Math.abs(Math.cos(ry)));
  const flipSign = Math.cos(ry) < 0 ? -1 : 1;

  ctx.save();
  ctx.globalAlpha = pose.alpha;
  ctx.translate(pose.x, pose.y);
  ctx.rotate((pose.rz * Math.PI) / 180);
  ctx.transform(squeeze * flipSign, Math.tan((pose.rx * Math.PI) / 180) * 0.18, 0, 1, 0, 0);

  // 落影：扩散渐变代替 shadowBlur（软件光栅下 shadowBlur 每张卡都要重算一次模糊，很贵）
  ctx.save();
  const sh = ctx.createLinearGradient(0, -ch / 2, 0, ch / 2 + ch * 0.16);
  sh.addColorStop(0, 'rgba(6, 4, 14, 0)');
  sh.addColorStop(0.72, 'rgba(6, 4, 14, 0.34)');
  sh.addColorStop(1, 'rgba(6, 4, 14, 0)');
  ctx.fillStyle = sh;
  ctx.fillRect(-cw / 2 - cw * 0.05, -ch / 2, cw * 1.1, ch * 1.16);
  ctx.restore();

  // 卡面：有素材就铺满裁切，没有就画带信息量的占位
  ctx.save();
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(-cw / 2, -ch / 2, cw, ch, cw * 0.028) : ctx.rect(-cw / 2, -ch / 2, cw, ch);
  ctx.clip();
  if (src) {
    const sw = src.width || cw;
    const sh = src.height || ch;
    const k = Math.max(cw / sw, ch / sh);
    ctx.drawImage(src, -cw / 2 + (cw - sw * k) / 2, -ch / 2 + (ch - sh * k) / 2, sw * k, sh * k);
  } else {
    ctx.fillStyle = '#1b1a2b';
    ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
    ctx.strokeStyle = 'rgba(168, 156, 255, 0.22)';
    ctx.lineWidth = Math.max(1, cw / 220);
    for (let i = -ch / 2 - cw; i < ch / 2; i += Math.max(6, cw / 14)) {
      ctx.beginPath();
      ctx.moveTo(-cw / 2, i);
      ctx.lineTo(cw / 2, i + cw);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(226, 220, 255, 0.9)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.max(10, cw / 12) + 'px system-ui, sans-serif';
    ctx.fillText('页卡 ' + (index + 1) + ' / 3', 0, -ch * 0.06);
    ctx.font = Math.max(9, cw / 22) + 'px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(196, 188, 240, 0.66)';
    ctx.fillText('缺素材：props.assetId', 0, ch * 0.06);
    ctx.fillText(label, 0, ch * 0.155);
  }
  // 卡面内侧高光 + 边缘描边
  const sheen = ctx.createLinearGradient(-cw / 2, -ch / 2, cw / 2, ch / 2);
  sheen.addColorStop(0, 'rgba(255,255,255,0.14)');
  sheen.addColorStop(0.42, 'rgba(255,255,255,0.02)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.16)');
  ctx.fillStyle = sheen;
  ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
  ctx.restore();

  ctx.strokeStyle = 'rgba(210, 200, 255, 0.42)';
  ctx.lineWidth = Math.max(1, cw / 260);
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(-cw / 2, -ch / 2, cw, ch, cw * 0.028) : ctx.rect(-cw / 2, -ch / 2, cw, ch);
  ctx.stroke();
  ctx.restore();
}

/** 单圈烟雾环：极坐标絮边 + 竖向 aurora 渐变；不画几何描边。 */
function drawSmokeRing(ctx, cx, cy, radius, grow, alpha, w) {
  if (alpha <= 0.001 || radius <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const rings = [
    { mul: 1.0, phase: 0.0, a: alpha },
    { mul: 0.86, phase: 1.7, a: alpha * 0.55 },
  ];
  for (const ring of rings) {
    const grad = ctx.createLinearGradient(cx, cy - radius * ring.mul, cx, cy + radius * ring.mul);
    grad.addColorStop(0, 'rgba(255, 226, 205, 0.55)');
    grad.addColorStop(0.45, 'rgba(240, 152, 214, 0.5)');
    grad.addColorStop(1, 'rgba(128, 96, 226, 0.42)');
    ctx.fillStyle = grad;
    ctx.globalAlpha = ring.a;
    ctx.beginPath();
    const steps = 132;
    for (let i = 0; i <= steps; i += 1) {
      const a = (i / steps) * Math.PI * 2;
      const p = a * 3 + ring.phase;
      // 三组位移取「絮边」：低频鼓包 + 中频抖动 + 高频毛刺
      const nx = radius * (0.12 * Math.sin(p * 1.0) + 0.06 * Math.sin(p * 2.7 + 0.6) + 0.035 * Math.sin(p * 6.1 + 1.9));
      const r = radius * ring.mul + nx + radius * 0.06 * grow;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r * 0.78;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawWordWall(ctx, w, h, t, tint) {
  const size = h * 0.42;
  ctx.save();
  ctx.font = '800 ' + size + 'px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.strokeStyle = tint;
  ctx.lineWidth = Math.max(1, size * 0.006);
  ctx.textAlign = 'left';
  const drift = ((t * 12) % (size * 6)) - size * 2;
  for (let row = 0; row < 2; row += 1) {
    const dir = row === 0 ? 1 : -1;
    const y = h * (row === 0 ? 0.24 : 0.78);
    ctx.save();
    ctx.translate(dir * drift, y);
    ctx.fillText('SHOTCRAFT  ·  MOTION  ·  SHOTCRAFT  ·', 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

function __renderInner(ctx, t, env) {
  const w = Number(env && env.width) || 1;
  const h = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const time = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
  const m = env && env.media;
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);
  const src = id && m ? (m.image(id) || m.video(id)) : null;

  const geo = poseKeyframes(w, h);
  const word = String(props.title || 'MOTION');

  ctx.save();
  // 背景：暗场压暗
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#0a0714');
  bg.addColorStop(0.55, '#0d0a18');
  bg.addColorStop(1, '#06040c');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // 收束时字墙向心收缩淡出
  const collide = seg(time, FLY_END + 0.3, COLLAPSE_END, inQuad);
  ctx.save();
  ctx.globalAlpha = 1 - collide * 0.85;
  drawWordWall(ctx, w, h, time, 'rgba(150, 128, 255, 0.16)');
  ctx.restore();

  // 卡后极光主光：托起卡片群
  const aurora = ctx.createRadialGradient(geo.cx, geo.cy - h * 0.06, 0, geo.cx, geo.cy - h * 0.06, w * 0.46);
  aurora.addColorStop(0, 'rgba(120, 88, 255, 0.34)');
  aurora.addColorStop(0.5, 'rgba(88, 60, 190, 0.12)');
  aurora.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = aurora;
  ctx.fillRect(0, 0, w, h);

  // 三卡：按 k 顺序画，后画的压在前面的上面（阶梯阅读序）
  for (let k = 0; k < 3; k += 1) {
    const pose = cardPose(time, k, geo);
    if (pose.alpha > 0.003) drawCard(ctx, pose, w, h, src, k === 2 ? '素材槽 3' : '素材槽 ' + (k + 1), k);
  }

  // 闪核：径向白热核 + 全屏 12% 微曝，6f 指数衰减
  const sinceCore = time - CORE_AT;
  if (sinceCore >= 0) {
    const decay = Math.exp(-sinceCore / (6 / FPS) * 1.0);
    const flashR = w * (0.06 + 0.16 * (1 - decay));
    const core = ctx.createRadialGradient(geo.cx, geo.cy, 0, geo.cx, geo.cy, flashR);
    core.addColorStop(0, 'rgba(255, 255, 255, ' + (0.95 * decay).toFixed(4) + ')');
    core.addColorStop(0.42, 'rgba(226, 208, 255, ' + (0.5 * decay).toFixed(4) + ')');
    core.addColorStop(1, 'rgba(180, 150, 255, 0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(geo.cx, geo.cy, flashR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 250, 245, ' + (0.12 * decay).toFixed(4) + ')';
    ctx.fillRect(0, 0, w, h);
  }

  // 烟雾环：从闪核里长出来，减速外扩、衰减极慢驻留
  const ringT = Math.max(0, time - CORE_AT);
  if (ringT > 0) {
    const p = clamp01(ringT / 2.2);
    const grow = 1 - Math.pow(1 - p, 2.4);
    const radius = w * (0.05 + 0.36 * grow);
    const alpha = 0.9 * Math.pow(1 - p, 0.55);
    drawSmokeRing(ctx, geo.cx, geo.cy, radius, grow, alpha, w);
  }

  // 巨字：到点后 4f 砸进来，14f 1.22→1 + 字距收拢，之后极缓长大
  const wordT = time - WORD_AT;
  if (wordT >= 0) {
    const snap = clamp01(wordT / WORD_SNAP);
    const snappy = 1 - Math.pow(1 - snap, 3);
    const scale = 1.22 + (1 - 1.22) * snappy + 0.012 * clamp01((wordT - WORD_SNAP) / 2.2);
    const trackEm = 0.06 + (-0.025 - 0.06) * snappy;
    const fontSize = h * 0.392;
    ctx.save();
    ctx.translate(geo.cx, geo.cy);
    ctx.scale(scale, scale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'italic 900 ' + fontSize + 'px system-ui, sans-serif';
    // 手写字距：逐字排布（canvas 无 letter-spacing）
    const chars = Array.from(word);
    const widths = chars.map((c) => ctx.measureText(c).width + trackEm * fontSize);
    const total = widths.reduce((a, b) => a + b, 0);
    let x = -total / 2;
    // 粉紫双层泛光
    ctx.shadowColor = 'rgba(240, 150, 230, 0.72)';
    ctx.shadowBlur = fontSize * 0.22;
    for (let pass = 0; pass < 2; pass += 1) {
      const grad = ctx.createLinearGradient(0, -fontSize * 0.5, 0, fontSize * 0.5);
      if (pass === 0) {
        grad.addColorStop(0, 'rgba(255, 255, 255, 0.98)');
        grad.addColorStop(1, 'rgba(226, 210, 255, 0.9)');
      } else {
        grad.addColorStop(0, 'rgba(255, 246, 255, 0.6)');
        grad.addColorStop(0.62, 'rgba(206, 168, 255, 0.5)');
        grad.addColorStop(1, 'rgba(150, 116, 236, 0.34)');
      }
      ctx.fillStyle = grad;
      ctx.globalAlpha = pass === 0 ? 1 : 0.9;
      let cx0 = x;
      for (let i = 0; i < chars.length; i += 1) {
        ctx.fillText(chars[i], cx0 + widths[i] / 2, 0);
        cx0 += widths[i];
      }
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.restore();

    // 环心内上方眉题 + 下方标语，错峰升起
    const eyebrow = clamp01((wordT - 0.1) / 0.34);
    const slogan = clamp01((wordT - 0.2) / 0.4);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = eyebrow * 0.95;
    ctx.fillStyle = 'rgba(238, 230, 255, 0.95)';
    ctx.font = '700 ' + Math.max(9, h * 0.031) + 'px system-ui, sans-serif';
    ctx.fillText(String(props.eyebrow || 'VIDEO-SHOTCRAFT'), geo.cx, geo.cy - h * 0.2 - (1 - eyebrow) * h * 0.02);
    ctx.globalAlpha = slogan * 0.9;
    ctx.fillStyle = 'rgba(214, 202, 246, 0.9)';
    ctx.font = Math.max(9, h * 0.061) + 'px system-ui, sans-serif';
    ctx.fillText(String(props.slogan || 'MOVE THE FRAME, MOVE THE MIND'), geo.cx, geo.cy + h * 0.215 + (1 - slogan) * h * 0.02);
    ctx.restore();
  }

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
