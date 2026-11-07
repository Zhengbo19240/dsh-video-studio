/**
 * sc-speed-ramp-freeze · 变速冻结（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/rhythm/speed-ramp-freeze.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实（技术根是**帧号 remap**：斜率即速率）：
 *   - 流动段斜率 1（26px/源帧）→ 定格段斜率 **0**（瞬时切换，无缓入，定格要干脆）→
 *     解冻段 smootherstep（ease-in 起步）22f 走完一张卡、平均斜率 >1 补偿时长；
 *   - **blur 联动速率**：按 remap 后的实际速度给方向性模糊，|v|<8px/f 不挂（定格段裸渲）；
 *   - 定格那一帧给「按下暂停」的信号：快门白闪 3f + 取景框四角弹入 + 时间码从 LIVE 走字切 PAUSED 并停住；
 *   - 强调色马克笔超椭圆一笔圈 10f（1.08 圈、**收笔不闭合**）+ 箭杆 6f + 箭头 3f 点题 + 一行批注；
 *   - 目标卡对位屏中并被「拾起」（抬高 + 放大 3–5% + 阴影加深），其余卡退暗 / 去饱和；
 *   - 解冻后墨迹 8f 淡出，但目标卡角留一枚评论图钉随卡离场。
 */

export const meta = {
  title: '变速冻结',
  duration: 4.0,
  source: 'shotcraft',
  sourcePath: 'references/shots/rhythm/speed-ramp-freeze.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const FREEZE_AT = 40 / FPS;        // 流动 40f 后定格
const FREEZE_HOLD = 67 / FPS;      // 定格 ≥45f（这里 67f，宁慢勿快）
const THAW_AT = FREEZE_AT + FREEZE_HOLD;
const THAW_DUR = 22 / FPS;
const CARD_W = 0.46;               // 卡宽（画面比例）
const CARD_H = 0.6;
const STEP_PX = 26;                // 源帧步进（px/源帧）

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const smootherstep = (x) => {
  const p = clamp01(x);
  return p * p * p * (p * (p * 6 - 15) + 10);
};

/**
 * 帧号 remap：返回「已经走过的源帧数」。
 * 斜率就是速率：流动段 1、定格段 0、解冻段 smootherstep（斜率从 0 起、峰值 >1）。
 */
function sourceFrames(time) {
  if (time <= FREEZE_AT) {
    return (time - 0) * FPS;                 // 斜率 1
  }
  if (time <= THAW_AT) {
    return FREEZE_AT * FPS;                  // 斜率 0（瞬时切换，无缓入）
  }
  // 解冻：22f 内走完一张卡（1.4 张卡的距离），平均斜率 >1 补偿定格吃掉的时间
  const u = clamp01((time - THAW_AT) / THAW_DUR);
  const cardSpan = (CARD_W + 0.04) * 1280 / STEP_PX;  // 一张卡折算成多少源帧
  return FREEZE_AT * FPS + smootherstep(u) * cardSpan * 1.4;
}

/** 速率（源帧/秒）→ 屏幕 px/帧。 */
function speedPxPerFrame(time) {
  const dt = 1 / FPS;
  return Math.abs(sourceFrames(time + dt) - sourceFrames(time)) * STEP_PX;
}

function drawStripCard(ctx, x, y, w, h, i, src, dim, pickup) {
  ctx.save();
  // 抬高后的落影（拾起才有影子加长）
  ctx.save();
  ctx.shadowColor = 'rgba(16, 12, 8, ' + (0.28 + pickup * 0.3).toFixed(3) + ')';
  ctx.shadowBlur = w * (0.05 + pickup * 0.1);
  ctx.shadowOffsetY = h * (0.03 + pickup * 0.09);
  ctx.fillStyle = '#15161a';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, w * 0.035) : ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, w * 0.035) : ctx.rect(x, y, w, h);
  ctx.clip();
  if (src) {
    // 每张卡取素材不同区域（卡流里是不同的卡片）
    const sw = src.width || w;
    const sh = src.height || h;
    const cw = sw * 0.42;
    const chh = sh * 0.72;
    const sx = ((i * 0.31) % 1) * (sw - cw);
    const sy = ((i * 0.19) % 1) * (sh - chh);
    const k = Math.max(w / cw, h / chh);
    ctx.drawImage(src, sx, sy, cw, chh, x + (w - cw * k) / 2, y + (h - chh * k) / 2, cw * k, chh * k);
  } else {
    ctx.fillStyle = '#20242c';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(200, 214, 240, 0.24)';
    ctx.fillRect(x + w * 0.08, y + h * 0.1, w * 0.55, h * 0.07);
    for (let k = 0; k < 4; k += 1) {
      ctx.fillStyle = 'rgba(180, 196, 226, ' + (0.18 - k * 0.03).toFixed(3) + ')';
      ctx.fillRect(x + w * 0.08, y + h * (0.26 + k * 0.14), w * (0.8 - k * 0.1), h * 0.06);
    }
    if (i === 2) {
      ctx.fillStyle = 'rgba(232, 240, 252, 0.85)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 ' + Math.round(w * 0.06) + 'px system-ui, sans-serif';
      ctx.fillText('素材卡（待 props.assetId）', x + w / 2, y + h * 0.86);
    }
  }
  ctx.restore();

  ctx.strokeStyle = 'rgba(238, 244, 255, 0.16)';
  ctx.lineWidth = Math.max(1, w * 0.005);
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, w * 0.035) : ctx.rect(x, y, w, h);
  ctx.stroke();

  // 退暗 / 去饱和：定格时非目标卡让位
  if (dim > 0) {
    ctx.fillStyle = 'rgba(10, 12, 18, ' + (0.5 * dim).toFixed(3) + ')';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, w, h, w * 0.035) : ctx.rect(x, y, w, h);
    ctx.fill();
    // 去饱和：叠一层中性灰 + 提高暗部（便宜的「去色」近似）
    ctx.globalCompositeOperation = 'saturation';
    ctx.fillStyle = 'rgba(128, 128, 128, ' + (0.8 * dim).toFixed(3) + ')';
    ctx.fillRect(x, y, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
}

/** 马克笔超椭圆一笔圈：1.08 圈、收笔不闭合（dash 走 92% 就停）。 */
function markerEllipse(ctx, cx, cy, rx, ry, progress, color, s) {
  if (progress <= 0) return;
  const turns = 1.08;
  const closed = 0.92;               // 收笔不闭合
  const arc = Math.PI * 2 * turns * Math.min(1, progress / closed);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(3, 8 * s);
  ctx.lineCap = 'round';
  // 手绘抖动：低频确定性扰动
  const steps = 64;
  ctx.beginPath();
  for (let i = 0; i <= steps; i += 1) {
    const k = (i / steps) * arc;
    const wob = 1 + 0.035 * Math.sin(k * 3.1) + 0.02 * Math.sin(k * 7.3 + 1.2);
    const x = cx + Math.cos(k - Math.PI / 2) * rx * wob;
    const y = cy + Math.sin(k - Math.PI / 2) * ry * wob;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
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
  const accent = String(props.accent || '#ff5a36');

  const s = Math.min(W / 1280, H / 720);
  const cw = W * CARD_W;
  const chh = H * CARD_H;
  const gap = W * 0.04;
  const freezeU = clamp01((time - FREEZE_AT) / 0.001);
  const thawU = clamp01((time - THAW_AT) / THAW_DUR);

  // 卡流位置由 remap 后的源帧决定（斜率即速率）
  const frames = sourceFrames(time);
  const travel = frames * STEP_PX * s;
  const speed = speedPxPerFrame(time);
  const blurPx = speed >= 8 ? Math.min(18, speed * 0.16) : 0;

  ctx.save();
  ctx.fillStyle = '#0c0d11';
  ctx.fillRect(0, 0, W, H);

  // 卡流：8 张，目标卡是第 2 张（定格时对位屏中）
  const target = 2;
  const baseY = H * 0.5 - chh / 2;
  for (let i = 0; i < 8; i += 1) {
    const rel = i - target;
    let x = W * 0.5 - cw / 2 + rel * (cw + gap) - (travel - (FREEZE_AT * FPS * STEP_PX * s));
    if (freezeU > 0) {
      // 定格段：目标卡吸到屏中，其余退暗
      x = W * 0.5 - cw / 2 + rel * (cw + gap);
    }
    const isTarget = i === target;
    const pickup = isTarget ? clamp01((time - FREEZE_AT) / (10 / FPS)) * (1 - clamp01((time - THAW_AT) / THAW_DUR)) : 0;
    const dim = isTarget ? 0 : clamp01((time - FREEZE_AT) / (8 / FPS)) * (1 - clamp01((time - THAW_AT) / (10 / FPS)));

    // 方向性运动模糊：按屏幕速度给拖影（|v|<8px/f 不挂）
    const passes = blurPx > 0.4 ? 3 : 1;
    for (let p = 0; p < passes; p += 1) {
      ctx.save();
      ctx.globalAlpha = p === 0 ? 1 : 0.22;
      const bx = p === 0 ? 0 : (p - 2) * blurPx * 0.6;
      const scale = 1 + 0.04 * pickup;
      ctx.translate(x + cw / 2 + bx, baseY + chh / 2 - pickup * H * 0.03);
      ctx.scale(scale, scale);
      ctx.translate(-(x + cw / 2), -(baseY + chh / 2));
      drawStripCard(ctx, x, baseY - pickup * H * 0.03, cw, chh, i, src, dim, pickup);
      ctx.restore();
    }
  }

  // ---- 定格信号：快门白闪 3f + 取景框四角弹入 ----
  const sinceFreeze = time - FREEZE_AT;
  if (sinceFreeze >= 0 && sinceFreeze < 3 / FPS) {
    const k = 1 - sinceFreeze / (3 / FPS);
    ctx.fillStyle = 'rgba(255, 252, 246, ' + (0.5 * k).toFixed(3) + ')';
    ctx.fillRect(0, 0, W, H);
  }

  if (sinceFreeze >= 0 && thawU < 1) {
    const cornersP = outCubic(clamp01(sinceFreeze / (10 / FPS)));
    const L = Math.min(W, H) * 0.085 * cornersP;
    const inset = Math.min(W, H) * 0.05;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 250, 240, ' + (0.8 * (1 - thawU)).toFixed(3) + ')';
    ctx.lineWidth = Math.max(1.6, 3 * s);
    const corners = [
      [inset, inset, 1, 1],
      [W - inset, inset, -1, 1],
      [inset, H - inset, 1, -1],
      [W - inset, H - inset, -1, -1],
    ];
    for (const [x, y, sx, sy] of corners) {
      ctx.beginPath();
      ctx.moveTo(x + sx * L, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + sy * L);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- 时间码：LIVE 走字 → PAUSED 停住 ----
  const paused = time >= FREEZE_AT;
  const secs = paused ? FREEZE_AT : time;
  const tc = '00:00:' + String(Math.floor(secs * 30) % 30).padStart(2, '0') + '.' + String(Math.floor(secs) % 60).padStart(2, '0');
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 ' + Math.round(H * 0.028) + 'px ui-monospace, Menlo, monospace';
  ctx.fillStyle = paused ? accent : 'rgba(226, 234, 248, 0.75)';
  ctx.fillText(paused ? 'PAUSED' : 'LIVE', W * 0.055, H * 0.075);
  ctx.fillStyle = 'rgba(226, 234, 248, 0.55)';
  ctx.fillText(tc, W * 0.055, H * 0.115);
  // 速率读数（remap 的证据）
  ctx.fillStyle = 'rgba(160, 176, 200, 0.42)';
  ctx.fillText('RATE ' + speed.toFixed(1) + 'px/f', W * 0.055, H * 0.155);
  ctx.restore();

  // ---- 圈注：10f 一笔 + 箭杆 6f + 箭头 3f + 批注 ----
  const markAt = FREEZE_AT + 12 / FPS;
  const markP = clamp01((time - markAt) / (10 / FPS));
  const markFade = 1 - clamp01((time - THAW_AT) / (8 / FPS));
  if (markP > 0 && markFade > 0) {
    const tcx = W * 0.5;
    const tcy = H * 0.5 - H * 0.03;
    ctx.save();
    ctx.globalAlpha = markFade;
    markerEllipse(ctx, tcx, tcy, cw * 0.58, chh * 0.56, markP, accent, s);

    // 箭杆 6f + 箭头 3f
    const shaftP = clamp01((time - markAt - 10 / FPS) / (6 / FPS));
    const headP = clamp01((time - markAt - 16 / FPS) / (3 / FPS));
    if (shaftP > 0) {
      const ax0 = tcx + cw * 0.62;
      const ay0 = tcy - chh * 0.5;
      const ax1 = tcx + cw * 0.72 + (W * 0.1) * shaftP;
      const ay1 = ay0 - H * 0.06 * shaftP;
      ctx.strokeStyle = accent;
      ctx.lineWidth = Math.max(2, 4 * s);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ax0, ay0);
      ctx.lineTo(ax1, ay1);
      ctx.stroke();
      if (headP > 0) {
        const ang = Math.atan2(ay1 - ay0, ax1 - ax0);
        const hl = Math.min(1, headP) * Math.min(W, H) * 0.03;
        ctx.beginPath();
        ctx.moveTo(ax1, ay1);
        ctx.lineTo(ax1 - Math.cos(ang - 0.45) * hl, ay1 - Math.sin(ang - 0.45) * hl);
        ctx.moveTo(ax1, ay1);
        ctx.lineTo(ax1 - Math.cos(ang + 0.45) * hl, ay1 - Math.sin(ang + 0.45) * hl);
        ctx.stroke();
      }
    }

    // 批注：一行粗体 + 手绘下划线
    const noteP = clamp01((time - markAt - 18 / FPS) / (8 / FPS));
    if (noteP > 0) {
      const nx = W * 0.5 - cw * 0.1;
      const ny = H * 0.5 + chh * 0.5 + H * 0.085;
      ctx.globalAlpha = markFade * noteP;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(250, 246, 238, 0.96)';
      ctx.font = '800 ' + Math.round(H * 0.072) + 'px system-ui, sans-serif';
      ctx.fillText(String(props.note || 'this frame. hold it.'), nx, ny);
      const nw = ctx.measureText(String(props.note || 'this frame. hold it.')).width;
      ctx.strokeStyle = accent;
      ctx.lineWidth = Math.max(2, 4 * s);
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i <= 18; i += 1) {
        const u = i / 18;
        const x = nx + nw * u * noteP;
        const y = ny + H * 0.032 + Math.sin(u * 9) * H * 0.004;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- 解冻后：目标卡角留一枚评论图钉，随卡离场 ----
  if (thawU > 0 && thawU < 1) {
    const pinX = W * 0.5 + cw * 0.42 + thawU * W * 0.16;
    const pinY = H * 0.5 - chh * 0.44 + thawU * H * 0.05;
    ctx.save();
    ctx.globalAlpha = 1 - thawU;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(pinX, pinY, Math.min(W, H) * 0.018, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0c0d11';
    ctx.beginPath();
    ctx.arc(pinX, pinY, Math.min(W, H) * 0.007, 0, Math.PI * 2);
    ctx.fill();
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
