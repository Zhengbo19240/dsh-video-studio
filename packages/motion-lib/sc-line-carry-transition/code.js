/**
 * sc-line-carry-transition · 线条带走（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/transition/line-carry-transition.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - 3840 宽世界容器用 translateX 当镜头：56–112f 移 1920px，smooth in-out（bezier .65,0,.35,1）；
 *   - 一条手写折线（进度条 648 + 冲出段 + 直角 + 720×480 矩形框）全程按「已画长度」推进；
 *   - **命门：横移段 drawn = 1144 + cam**，线生长与镜头同速，笔头钉在画面 x≈1480 偏右，
 *     永不出画也永不落后；
 *   - 交接处速度连续：进度条 ease-out 落到零速 → 满格停 6f（对勾弹出）→ 冲出段两端零速 →
 *     镜头 in-out 零速起步 → 收框 in-out 零速接住镜头落点；
 *   - 笔头是全片唯一的强调色点（赤陶 r=14 + 晕圈），框闭合后消散并**条件卸载**（残留即毁静止）；
 *   - 横移时世界内容做水平运动模糊，线与笔头在模糊层外始终锐利；
 *   - 框闭合之后框内海报才长出来（顺序反了线的悬念白搭）。
 */

export const meta = {
  title: '线条带走',
  duration: 3.0,
  source: 'shotcraft',
  sourcePath: 'references/shots/transition/line-carry-transition.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const BAR_FILL = 36 / FPS;      // 进度条走满
const BURST = 10 / FPS;         // 冲出
const PAN = 56 / FPS;           // 横移
const FRAME_DRAW = 24 / FPS;    // 收框
const POSTER_AT = 136 / FPS;    // 框闭合后才出内容
const T_PAN0 = BAR_FILL + BURST;
const T_PAN1 = T_PAN0 + PAN;
const T_FRAME1 = T_PAN1 + FRAME_DRAW;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const inOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
/** bezier(.65,0,.35,1)：两端零速的对称 in-out（镜头起步与收框都要零速接住）。 */
function smoothInOut(u) {
  const p = clamp01(u);
  return p * p * p * (p * (p * 6 - 15) + 10); // smootherstep：一阶、二阶导在两端都为 0
}

/**
 * 折线（世界坐标，世界宽 3840）。段落顺序：
 *   0 进度条（648 长）→ 1 冲出段 → 2 直角下折 → 3 水平 → 4 竖直（框左边）→ 5 上边 → 6 右边 → 7 底边
 */
function buildPath(worldW) {
  const barY = 900;
  const barX0 = 320;
  const pts = [];
  pts.push([barX0, barY]);               // 起点：进度条左端
  pts.push([barX0 + 648, barY]);         // 进度条右端（走满）
  pts.push([barX0 + 648 + 496, barY]);   // 冲出段
  pts.push([barX0 + 648 + 496, barY + 260]); // 直角下折
  const fx = barX0 + 648 + 496;          // 框左上角
  const fy = barY + 260;
  const fw = 720;
  const fh = 480;
  pts.push([fx, fy + fh * 0]);           // 左边上端点（已在）
  pts.push([fx + fw, fy]);               // 上边
  pts.push([fx + fw, fy + fh]);          // 右边
  pts.push([fx, fy + fh]);               // 底边
  pts.push([fx, fy]);                    // 闭合
  void worldW;
  return { pts, barX0, barY, barLen: 648, fx, fy, fw, fh };
}

/** 按累计长度取折线上的点与总长。 */
function pathMetrics(pts) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    segs.push({ x0, y0, x1, y1, len, start: total });
    total += len;
  }
  return { segs, total };
}

function pointAt(segs, d) {
  for (const s of segs) {
    if (d <= s.start + s.len) {
      const u = s.len > 0 ? (d - s.start) / s.len : 0;
      return { x: s.x0 + (s.x1 - s.x0) * u, y: s.y0 + (s.y1 - s.y0) * u, angle: Math.atan2(s.y1 - s.y0, s.x1 - s.x0) };
    }
  }
  const last = segs[segs.length - 1];
  return { x: last.x1, y: last.y1, angle: 0 };
}

/** 画到 d 长度为止的折线（切掉超出的那一段）。 */
function drawPartial(ctx, segs, d, width, color) {
  if (d <= 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  ctx.moveTo(segs[0].x0, segs[0].y0);
  for (const s of segs) {
    if (d >= s.start + s.len) {
      ctx.lineTo(s.x1, s.y1);
    } else {
      const u = s.len > 0 ? (d - s.start) / s.len : 0;
      ctx.lineTo(s.x0 + (s.x1 - s.x0) * u, s.y0 + (s.y1 - s.y0) * u);
      break;
    }
  }
  ctx.stroke();
  ctx.restore();
}

/** 世界内容（场景 A 的卡 / 点阵 / 展签），横移时按镜头速度做水平运动模糊。 */
function drawWorldA(ctx, w, h, speedPx) {
  const blur = Math.min(16, speedPx * 0.5);
  const passes = blur > 1.5 ? 3 : 1;
  for (let p = 0; p < passes; p += 1) {
    ctx.save();
    ctx.globalAlpha = p === 0 ? 1 : 0.24;
    ctx.translate(p === 0 ? 0 : (p - 2) * blur * 0.5, 0);
    // 点阵
    for (let r = 0; r < 6; r += 1) {
      for (let c = 0; c < 18; c += 1) {
        ctx.fillStyle = 'rgba(226, 218, 206, ' + (0.1 + ((r + c) % 3) * 0.04).toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(180 + c * 96, 320 + r * 88, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // 两张卡
    for (let i = 0; i < 2; i += 1) {
      const x = 380 + i * 520;
      const y = 240;
      ctx.fillStyle = 'rgba(244, 238, 228, 0.94)';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y, 300, 190, 10) : ctx.rect(x, y, 300, 190);
      ctx.fill();
      ctx.fillStyle = 'rgba(150, 86, 62, 0.85)';
      ctx.fillRect(x + 22, y + 28, 130, 12);
      ctx.fillStyle = 'rgba(90, 82, 72, 0.4)';
      for (let k = 0; k < 3; k += 1) ctx.fillRect(x + 22, y + 62 + k * 26, 210 - k * 30, 8);
    }
    ctx.restore();
  }
  void w;
  void h;
}

/** 场景 B 的展签（在框外，可以先升起）。 */
function drawPlacard(ctx, x, y, text) {
  ctx.save();
  ctx.fillStyle = 'rgba(84, 62, 46, 0.9)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 34px system-ui, sans-serif';
  ctx.fillText(text, x, y);
  ctx.fillStyle = 'rgba(186, 96, 62, 0.9)';
  ctx.fillRect(x, y + 26, 96, 3);
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

  const s = H / 1080;
  const worldW = 3840;
  const { pts, fx, fy, fw, fh } = buildPath(worldW);
  const { segs, total } = pathMetrics(pts);

  // 镜头：0 → 1920（smooth in-out，两端零速）
  const panU = clamp01((time - T_PAN0) / PAN);
  const cam = 1920 * smoothInOut(panU);
  const camSpeed = panU > 0 && panU < 1 ? 1920 * 0.5 * (6 * Math.pow(panU, 5) - 15 * Math.pow(panU, 4) + 10 * Math.pow(panU, 3)) / (PAN * FPS) : 0;

  // 已画长度：三段接力，交接处速度连续
  let drawn = 0;
  if (time <= BAR_FILL) {
    drawn = 648 * outCubic(time / BAR_FILL);
  } else if (time <= BAR_FILL + 6 / FPS) {
    drawn = 648; // 满格停 6f（对勾弹出）
  } else if (time <= T_PAN0 + 0.0001) {
    // 冲出段：两端零速
    const u = clamp01((time - (BAR_FILL + 6 / FPS)) / (BURST - 6 / FPS));
    drawn = 648 + 496 * smoothInOut(u);
  } else if (time <= T_PAN1) {
    // **横移段：drawn = 1144 + cam（线生长与镜头同速，笔头钉住）**
    drawn = 1144 + cam;
  } else {
    // 收框：in-out，接住镜头落点
    const u = clamp01((time - T_PAN1) / FRAME_DRAW);
    drawn = 1144 + 1920 + (total - (1144 + 1920)) * inOut(u);
  }
  drawn = Math.max(0, Math.min(total, drawn));

  ctx.save();
  // 世界平移（镜头）；背景是纸面
  ctx.save();
  ctx.fillStyle = '#efe7da';
  ctx.fillRect(0, 0, W, H);
  // 纸面颗粒：极淡的斜线纹
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = 'rgba(150, 130, 108, 0.18)';
  ctx.lineWidth = 1;
  for (let y = -H; y < H * 2; y += Math.max(4, 6 * s)) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y + W * 0.06);
    ctx.stroke();
  }
  ctx.restore();

  // 世界坐标 → 屏幕：世界按 1920 宽对位（1080p 世界）
  const k = H / 1080;
  ctx.translate(-cam * k, 0);
  ctx.scale(k, k);

  // 场景 A 内容（带速度模糊）
  if (time < T_PAN1) drawWorldA(ctx, W, H, camSpeed);

  // 场景 B 展签：镜头快到位时先升起
  const placardIn = clamp01((time - (T_PAN0 + PAN * 0.72)) / 0.3);
  if (placardIn > 0) {
    ctx.save();
    ctx.globalAlpha = placardIn * 0.9;
    drawPlacard(ctx, fx, fy - 78 - (1 - placardIn) * 16, String(props.placard || 'SCENE B · 图 B-1'));
    ctx.restore();
  }

  // 框内海报：**框闭合之后**才长出来
  const closed = 1144 + 1920 + (total - (1144 + 1920));
  if (drawn >= closed - 1.5) {
    const grow = clamp01((time - POSTER_AT) / 0.35);
    if (grow > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(fx + 8, fy + 8, fw - 16, fh - 16);
      ctx.clip();
      const inset = fw * 0.03;
      const pw = fw - inset * 2;
      const ph = fh - inset * 2;
      const px = fx + inset;
      const py = fy + inset;
      ctx.globalAlpha = grow;
      if (src) {
        const sw = src.width || pw;
        const sh = src.height || ph;
        const kk = Math.max(pw / sw, ph / sh);
        ctx.drawImage(src, px + (pw - sw * kk) / 2, py + (ph - sh * kk) / 2, sw * kk, sh * kk);
      } else {
        ctx.fillStyle = '#e2d6c4';
        ctx.fillRect(px, py, pw, ph);
        ctx.strokeStyle = 'rgba(140, 112, 86, 0.55)';
        ctx.setLineDash([14, 10]);
        ctx.lineWidth = 3;
        ctx.strokeRect(px + 16, py + 16, pw - 32, ph - 32);
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(104, 80, 58, 0.86)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '600 ' + Math.round(ph * 0.09) + 'px system-ui, sans-serif';
        ctx.fillText('框内海报 = 素材', px + pw / 2, py + ph * 0.44);
        ctx.font = Math.round(ph * 0.055) + 'px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(130, 106, 82, 0.8)';
        ctx.fillText('框闭合后 props.assetId 的画面才长出', px + pw / 2, py + ph * 0.56);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  // 线的身份：先画满格的进度条底（走满后留一条淡底，线的起点有出处）
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = '#6b5a48';
  ctx.fillRect(320, 900 - 4, 648, 8);
  ctx.restore();

  // 主折线：8px 墨色实线，方头 + 直角 miter
  drawPartial(ctx, segs, drawn, 8, 'rgba(38, 32, 26, 0.95)');

  // 线下制图刻度：横移中段给眼睛一个速度参照
  if (time > T_PAN0) {
    const head = pointAt(segs, drawn);
    ctx.save();
    ctx.strokeStyle = 'rgba(70, 58, 46, 0.42)';
    ctx.lineWidth = 2;
    const tickStep = 96;
    for (let d = 648 + 40; d < Math.min(drawn, 1144 + 1920); d += tickStep) {
      const pt = pointAt(segs, d);
      const nx = Math.cos(pt.angle + Math.PI / 2);
      const ny = Math.sin(pt.angle + Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(pt.x - nx * 8, pt.y - ny * 8);
      ctx.lineTo(pt.x + nx * 22, pt.y + ny * 22);
      ctx.stroke();
    }
    void head;
    ctx.restore();
  }

  // 进度条满格的对勾（状态翻成完成）
  if (time > BAR_FILL) {
    const tick = outCubic(clamp01((time - BAR_FILL) / (5 / FPS)));
    if (tick > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(186, 96, 62, ' + tick.toFixed(3) + ')';
      ctx.lineWidth = 9;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(320 + 648 + 22, 900 - 6);
      ctx.lineTo(320 + 648 + 52, 900 + 26);
      ctx.lineTo(320 + 648 + 108, 900 - 42);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 笔头：全片唯一强调色点（赤陶 r=14 + 晕圈）；框闭合后消散并条件卸载
  const fadeOut = clamp01((time - (T_FRAME1 - 0.06)) / 0.2);
  if (fadeOut < 1) {
    const head = pointAt(segs, drawn);
    ctx.save();
    ctx.globalAlpha = 1 - fadeOut;
    ctx.fillStyle = 'rgba(186, 96, 62, 0.22)';
    ctx.beginPath();
    ctx.arc(head.x, head.y, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ba603e';
    ctx.beginPath();
    ctx.arc(head.x, head.y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();

  // 右下 mono：镜头与已画长度（编辑期校对）
  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(110, 92, 74, 0.6)';
  ctx.font = '500 ' + Math.round(H * 0.024) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('CAM ' + Math.round(cam) + 'px  ·  DRAWN ' + Math.round(drawn) + '/' + Math.round(total), W * 0.96, H * 0.95);
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
