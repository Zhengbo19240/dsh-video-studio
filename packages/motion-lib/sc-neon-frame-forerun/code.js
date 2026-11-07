/**
 * sc-neon-frame-forerun · 霓虹边框先行（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/ui-entrance/neon-frame-forerun.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - 霓虹框：强透视直角框，自**左缘中点**两颗白热亮头上下分头奔画（20f，swift 起步快），
 *     在右缘中点制动相撞并闪一下；灯管四层描边叠辉光（宽软晕 / 中晕 / 色芯 / 白热芯），
 *     **不用模糊滤镜**（便宜且锐）；
 *   - 页面点亮：框合拢后页面才从黑里浮出（16–30f），再由暗转亮（24–84f smooth），
 *     同时一层冷紫暗罩自左缘向右退去；
 *   - 组件贴落：真 3D 悬空（这里用「抬高 + 同形软影 + 尺寸放大」近似 translateZ），
 *     每件 24f 加速下落 + 软着陆，落点 54→104f 按「侧栏自上而下 → 主区自上而下」错峰，
 *     比点亮晚 ~20f 收尾；**错开起点、下落重叠并行**（串行等待被裁）；
 *   - 背景霓虹隧道：同形框 5 层纵深回声，框合拢后由近到远逐层打火，终段中段先熄两端后熄；
 *   - 机位 rotateY −30° → −12° 长减速，hold 段再极缓转 1.5°。
 */

export const meta = {
  title: '霓虹边框先行',
  duration: 4.0,
  source: 'shotcraft',
  sourcePath: 'references/shots/ui-entrance/neon-frame-forerun.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const DRAW_DUR = 20 / FPS;          // 20f 两头对奔
const PAGE_IN = 16 / FPS;
const LIGHT_A = 24 / FPS;
const LIGHT_B = 84 / FPS;
const DROP_A = 54 / FPS;
const DROP_B = 104 / FPS;
const DROP_DUR = 24 / FPS;
const KILL_A = 94 / FPS;
const KILL_B = 118 / FPS;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const outExpo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp01(x)));
const swift = (x) => {
  // swift：起步快、尾段制动（两端零速不成立，右端要「撞」）
  const p = clamp01(x);
  return p * (2 - p) * 0.72 + outExpo(p) * 0.28;
};

/** 强透视框：上边窄、下边宽（rotateY 与 rotateX 的合成近似）。 */
function frameQuad(w, h, skew, camYaw) {
  const left = w * (0.64 + 0.04 * camYaw);
  const right = w * 0.06;
  const top = h * 0.16;
  const bottom = h * 0.86;
  // 左侧近、右侧远：左边高一点，上下边向右侧收敛
  const conv = 0.045 + 0.03 * camYaw;
  return {
    tl: { x: left, y: top + h * conv * 0.4 },
    tr: { x: right + w * 0.44, y: top + h * conv },
    br: { x: right + w * 0.52, y: bottom - h * conv * 0.6 },
    bl: { x: left - w * 0.02, y: bottom },
    skew,
  };
}

function quadPoints(q) {
  return [q.tl, q.tr, q.br, q.bl];
}

/** 折线取点：按总长比例插值（描画用）。 */
function pointOnQuad(pts, u) {
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segs.push({ a, b, len, start: total });
    total += len;
  }
  const d = clamp01(u) * total;
  for (const s of segs) {
    if (d <= s.start + s.len) {
      const k = s.len > 0 ? (d - s.start) / s.len : 0;
      return { x: s.a.x + (s.b.x - s.a.x) * k, y: s.a.y + (s.b.y - s.a.y) * k, angle: Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x) };
    }
  }
  return { x: segs[0].a.x, y: segs[0].a.y, angle: 0 };
}

function strokePath(ctx, pts, fromU, toU) {
  if (toU <= fromU) return;
  const steps = Math.max(2, Math.ceil((toU - fromU) * 24));
  ctx.beginPath();
  for (let i = 0; i <= steps; i += 1) {
    const p = pointOnQuad(pts, fromU + (toU - fromU) * (i / steps));
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

/** 四层描边叠辉光（宽软晕 / 中晕 / 色芯 / 白热芯）—— 不用 blur 滤镜。 */
function neonStroke(ctx, pts, fromU, toU, hue, intensity, scale) {
  const layers = [
    { w: 18, c: 'rgba(120, 96, 255, 0.1)', a: 1 },
    { w: 8, c: 'rgba(150, 120, 255, 0.28)', a: 1 },
    { w: 3.2, c: hue, a: 1 },
    { w: 1.1, c: 'rgba(255, 246, 255, 0.95)', a: 1 },
  ];
  for (const layer of layers) {
    ctx.save();
    ctx.globalAlpha = layer.a * intensity;
    ctx.strokeStyle = layer.c;
    ctx.lineWidth = Math.max(0.7, layer.w * scale);
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'butt';
    strokePath(ctx, pts, fromU, toU);
    ctx.restore();
  }
}

/** 面板内的组件：侧栏 4 项 + 问候 + 3 张数字卡 + 4 行任务。 */
const COMPONENTS = [
  { kind: 'bar', rel: 0.10, axis: 'side' },
  { kind: 'bar', rel: 0.17, axis: 'side' },
  { kind: 'bar', rel: 0.24, axis: 'side' },
  { kind: 'bar', rel: 0.31, axis: 'side' },
  { kind: 'greet', rel: 0.12, axis: 'main' },
  { kind: 'card', rel: 0.30, axis: 'main' },
  { kind: 'card', rel: 0.52, axis: 'main' },
  { kind: 'card', rel: 0.74, axis: 'main' },
  { kind: 'row', rel: 0.56, axis: 'list' },
  { kind: 'row', rel: 0.68, axis: 'list' },
  { kind: 'row', rel: 0.80, axis: 'list' },
  { kind: 'row', rel: 0.92, axis: 'list' },
];

function drawComponent(ctx, comp, x, y, w, h, lit, lift, src) {
  const shadowA = 0.4 * clamp01(lift / 150);
  const shadowBlur = 10 + lift * 0.22;
  const shadowOff = lift * 0.42;
  // 同形软影（越高越大越虚越淡、偏向右下）
  if (lift > 1) {
    ctx.save();
    ctx.globalAlpha = shadowA;
    ctx.fillStyle = 'rgba(4, 3, 10, 1)';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = shadowBlur;
    ctx.shadowOffsetX = lift * 0.16;
    ctx.shadowOffsetY = shadowOff;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
  // 本体
  ctx.save();
  ctx.globalAlpha = clamp01(0.25 + lit * 0.75) * (0.4 + 0.6 * clamp01(1 - lift / 200));
  if (comp.kind === 'bar') {
    ctx.fillStyle = 'rgba(196, 214, 255, 0.72)';
    ctx.fillRect(x, y, w * (0.6 + lit * 0.3), h);
  } else if (comp.kind === 'greet') {
    ctx.fillStyle = 'rgba(236, 244, 255, 0.94)';
    ctx.fillRect(x, y, w * 0.52, h * 0.62);
    ctx.fillStyle = 'rgba(150, 176, 230, 0.6)';
    ctx.fillRect(x, y + h * 0.78, w * 0.32, h * 0.24);
  } else if (comp.kind === 'card') {
    ctx.fillStyle = 'rgba(38, 44, 78, 0.94)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(150, 130, 255, ' + (0.32 + lit * 0.4).toFixed(3) + ')';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(x, y, w, h);
    if (src) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + w * 0.1, y + h * 0.14, w * 0.8, h * 0.42);
      ctx.clip();
      const sw = src.width || w;
      const sh = src.height || h;
      const k = Math.max((w * 0.8) / sw, (h * 0.42) / sh);
      ctx.globalAlpha = 0.9;
      ctx.drawImage(src, x + w * 0.1 + (w * 0.8 - sw * k) / 2, y + h * 0.14 + (h * 0.42 - sh * k) / 2, sw * k, sh * k);
      ctx.restore();
    } else {
      ctx.fillStyle = 'rgba(120, 150, 230, 0.22)';
      ctx.fillRect(x + w * 0.1, y + h * 0.14, w * 0.8, h * 0.42);
    }
    ctx.fillStyle = 'rgba(200, 216, 255, 0.7)';
    ctx.fillRect(x + w * 0.1, y + h * 0.66, w * 0.46, h * 0.12);
  } else {
    ctx.fillStyle = 'rgba(44, 50, 88, 0.86)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(170, 194, 240, 0.6)';
    ctx.fillRect(x + w * 0.04, y + h * 0.28, w * 0.4, h * 0.4);
    ctx.fillStyle = 'rgba(130, 160, 220, 0.4)';
    ctx.fillRect(x + w * 0.52, y + h * 0.28, w * 0.3, h * 0.4);
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
  const src = id && m ? (m.video(id) || m.image(id)) : null;

  const s = Math.min(W / 1280, H / 720);
  // 机位 -30° → -12° 长减速，hold 段再极缓转 1.5°
  const yawU = outCubic(clamp01(time / (96 / FPS)));
  const camYaw = (30 - 18 * yawU) / 30 + 0.015 * clamp01((time - 96 / FPS) / 2);

  ctx.save();
  ctx.fillStyle = '#07060d';
  ctx.fillRect(0, 0, W, H);
  const bgGlow = ctx.createRadialGradient(W * 0.52, H * 0.5, 0, W * 0.52, H * 0.5, W * 0.7);
  bgGlow.addColorStop(0, 'rgba(64, 40, 130, 0.22)');
  bgGlow.addColorStop(1, 'rgba(7, 6, 13, 0)');
  ctx.fillStyle = bgGlow;
  ctx.fillRect(0, 0, W, H);

  const q = frameQuad(W, H, 0.04, camYaw);
  const pts = quadPoints(q);

  // ---- 背景霓虹隧道：5 层同形框纵深回声，打火 → 中段先熄 ----
  const tunnel = [];
  for (let i = 4; i >= 1; i -= 1) {
    const scaleUp = 1 + i * 0.11;
    const cx = W * 0.38;
    const cy = H * 0.5;
    const echo = pts.map((p) => ({ x: cx + (p.x - cx) * scaleUp, y: cy + (p.y - cy) * scaleUp }));
    tunnel.push({ i, echo });
  }
  const igniteAt = DRAW_DUR + 0.05;
  for (let k = 0; k < tunnel.length; k += 1) {
    const { i, echo } = tunnel[k];
    const ignite = clamp01((time - igniteAt - (tunnel.length - 1 - k) * (7 / FPS)) / (6 / FPS));
    // 打火：确定性闪烁（荧光管启辉）
    const flicker = ignite >= 1 ? 1 : (Math.sin(time * 90 + i * 3.7) > -0.2 ? ignite : ignite * 0.2);
    // 终段中段先熄、两端后熄：i 小的先熄
    const killOrder = 4 - i;
    const kill = clamp01((time - (KILL_A + killOrder * (KILL_B - KILL_A) / 3)) / (6 / FPS));
    const alive = clamp01(1 - kill);
    if (flicker * alive <= 0.01) continue;
    ctx.save();
    ctx.globalAlpha = flicker * alive * (0.5 - i * 0.07);
    ctx.strokeStyle = 'rgba(150, 120, 255, 1)';
    ctx.lineWidth = Math.max(1, 2.4 * s / (1 + i * 0.3));
    ctx.beginPath();
    for (let p = 0; p < echo.length; p += 1) {
      const pt = echo[p];
      if (p === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  // ---- 框奔画：自左缘中点两头分头奔画 ----
  const drawP = swift(clamp01(time / DRAW_DUR));
  // 左缘中点把周长切成两半：两半各走 drawP
  ctx.save();
  ctx.globalAlpha = 1;
  neonStroke(ctx, pts, 0, drawP, 'rgba(146, 116, 255, 1)', 1, s);
  neonStroke(ctx, pts, 1 - drawP, 1, 'rgba(146, 116, 255, 1)', 1, s);
  ctx.restore();

  // 两颗白热亮头（到位后相撞闪一下）
  const collideAt = DRAW_DUR;
  const headUp = pointOnQuad(pts, drawP);
  const headDown = pointOnQuad(pts, 1 - drawP);
  const sinceHit = time - collideAt;
  if (sinceHit < 0) {
    for (const head of [headUp, headDown]) {
      ctx.save();
      ctx.fillStyle = 'rgba(255, 252, 255, 0.95)';
      ctx.shadowColor = 'rgba(200, 180, 255, 0.9)';
      ctx.shadowBlur = 22 * s;
      ctx.beginPath();
      ctx.arc(head.x, head.y, 4.2 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  } else if (sinceHit < 8 / FPS) {
    const k = 1 - sinceHit / (8 / FPS);
    const hit = pointOnQuad(pts, 1);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const flash = ctx.createRadialGradient(hit.x, hit.y, 0, hit.x, hit.y, W * 0.12 * (1.4 - k));
    flash.addColorStop(0, 'rgba(255, 250, 255, ' + (0.85 * k).toFixed(3) + ')');
    flash.addColorStop(1, 'rgba(180, 150, 255, 0)');
    ctx.fillStyle = flash;
    ctx.beginPath();
    ctx.arc(hit.x, hit.y, W * 0.12 * (1.4 - k), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---- 页面点亮：框合拢后从黑里浮出，再由暗转亮；冷紫暗罩自左向右退去 ----
  const pageIn = clamp01((time - PAGE_IN) / (14 / FPS));
  const light = clamp01((time - LIGHT_A) / (LIGHT_B - LIGHT_A));
  if (pageIn > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.clip();

    const dim = 0.94 - 0.9 * light;
    const paper = ctx.createLinearGradient(pts[1].x, pts[0].y, pts[3].x, pts[2].y);
    paper.addColorStop(0, 'rgba(18, 22, 40, ' + pageIn.toFixed(3) + ')');
    paper.addColorStop(1, 'rgba(10, 12, 24, ' + pageIn.toFixed(3) + ')');
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, W, H);

    // 面板底色（点亮后是冷白）
    ctx.globalAlpha = pageIn;
    const panel = ctx.createLinearGradient(pts[0].x, 0, pts[1].x, 0);
    panel.addColorStop(0, 'rgba(' + Math.round(232 - dim * 180) + ',' + Math.round(236 - dim * 180) + ',' + Math.round(246 - dim * 176) + ', 1)');
    panel.addColorStop(1, 'rgba(' + Math.round(208 - dim * 160) + ',' + Math.round(214 - dim * 160) + ',' + Math.round(228 - dim * 158) + ', 1)');
    ctx.fillStyle = panel;
    ctx.fillRect(0, 0, W, H);

    ctx.restore();

    // ---- 组件贴落：落点 54→104f，按「侧栏自上而下 → 主区自上而下」错峰 ----
    const inner = {
      x0: Math.min(pts[1].x, pts[0].x),
      x1: Math.max(pts[0].x, pts[2].x),
      y0: Math.min(pts[0].y, pts[1].y),
      y1: Math.max(pts[3].y, pts[2].y),
    };
    const pw = inner.x1 - inner.x0;
    const ph = inner.y1 - inner.y0;
    const sideW = pw * 0.16;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.clip();

    for (let i = 0; i < COMPONENTS.length; i += 1) {
      const comp = COMPONENTS[i];
      // 错开起点、下落重叠并行（先密后疏：用 EASE.out 分布落点）
      const t0 = DROP_A + (DROP_B - DROP_A) * Math.pow(i / (COMPONENTS.length - 1), 0.72);
      const u = clamp01((time - t0) / DROP_DUR);
      if (u <= 0) continue;
      const lift = 150 * (1 - outCubic(u));
      const settle = u >= 1 ? 1 : outCubic(u);

      let cx;
      let cy;
      let cw;
      let chh;
      if (comp.axis === 'side') {
        cx = inner.x0 + pw * 0.035;
        cy = inner.y0 + ph * comp.rel;
        cw = sideW;
        chh = ph * 0.035;
      } else if (comp.axis === 'main') {
        cx = inner.x0 + sideW + pw * 0.06;
        cy = inner.y0 + ph * comp.rel;
        cw = comp.kind === 'greet' ? pw * 0.42 : pw * 0.2;
        chh = comp.kind === 'greet' ? ph * 0.14 : ph * 0.2;
      } else {
        cx = inner.x0 + sideW + pw * 0.06;
        cy = inner.y0 + ph * comp.rel;
        cw = pw * 0.7;
        chh = ph * 0.06;
      }
      // 悬浮时朝镜头（上方）抬起；size 也略微放大（translateZ 的视觉）
      const liftPx = lift * s;
      const grow = 1 + 0.05 * (1 - settle);
      ctx.save();
      ctx.translate(cx, cy - liftPx);
      ctx.scale(grow, grow);
      drawComponent(ctx, comp, 0, 0, cw, chh, light, lift, src);
      ctx.restore();
    }

    // 冷紫暗罩：自左缘向右退去（「霓虹把页面点亮」）
    const veil = 1 - clamp01((time - LIGHT_A) / ((LIGHT_B - LIGHT_A) * 0.8));
    if (veil > 0.01) {
      const g = ctx.createLinearGradient(inner.x0, 0, inner.x0 + pw * 0.9 * (0.3 + veil), 0);
      g.addColorStop(0, 'rgba(58, 34, 110, ' + (0.62 * veil).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(58, 34, 110, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(inner.x0, inner.y0, pw, ph);
    }
    ctx.restore();

    // 框光并入面板 rim 辉光：成型后芯线退成发丝
    ctx.save();
    const rimA = 0.4 + 0.6 * clamp01((time - DRAW_DUR) / 0.5);
    ctx.strokeStyle = 'rgba(176, 158, 255, ' + (0.5 * rimA).toFixed(3) + ')';
    ctx.lineWidth = Math.max(1, 1.6 * s);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 1) {
      if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
      else ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  // 底部 mono：机位与阶段（编辑期校对）
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(160, 140, 240, 0.55)';
  ctx.font = '500 ' + Math.round(H * 0.024) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('YAW ' + (-30 + 18 * yawU).toFixed(1) + '°  ·  LIT ' + Math.round(light * 100) + '%', W * 0.04, H * 0.95);
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
