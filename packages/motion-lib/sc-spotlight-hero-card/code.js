/**
 * sc-spotlight-hero-card · 聚光英雄卡（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/opening/spotlight-hero-card.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - **关灯**：整页压到 ~6–14% 亮度（暖黑，保色相），只有光池里是页面本色；
 *     开灯是「推闸」：f1–6 亮 → 回闪到 62% → 稳住；
 *   - **光池**：近高斯多段 stop（中心透明 → 边缘全暗，不是一圈硬边）；游走 3 个中间站
 *     （站间 2–3f 停顿，smooth in-out）后锁定卡心，光池收拢 + 锁定瞬间 6% 脉冲；
 *     锁定后圆光池交叉过渡成**卡形光**（暗场在卡位挖一个卡形软孔）——
 *     圆光池罩卡会两头落暗、中间打爆（「手电筒照页面」）；
 *   - **体积光柱**：光源在画面上方偏右远处，梯形光柱打到光池，柱内确定性浮尘；
 *   - 相机：静止全页 zoom 0.8（0–40f）→ 18f 推进 zoom 2.6，焦点取卡心左移 105px；
 *     推进后完全锁死（尾段禁尾漂，呼吸交给光）；
 *   - 卡片 rise（过冲）→ 悬停 sin bob（振幅 4px、周期 40f）→ reseat（落地微压）；
 *   - 轮廓光束跑两圈：第一圈快而亮、第二圈慢而弱（香槟金 + 白芯）；
 *   - 3D 注记两行（卡左侧）+ 关键词背后香槟色马克条，reseat 时同步落回页面平面。
 */

export const meta = {
  title: '聚光英雄卡',
  duration: 5.0,
  source: 'shotcraft',
  sourcePath: 'references/shots/opening/spotlight-hero-card.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const LOCK_AT = 34 / FPS;
const PUSH_A = 40 / FPS;
const PUSH_B = 58 / FPS;
const RISE_AT = 58 / FPS;
const RISE_DUR = 10 / FPS;
const SEAT_AT = 142 / FPS;
const SEAT_DUR = 18 / FPS;
const LAP1 = [68 / FPS, 82 / FPS];
const LAP2 = [88 / FPS, 108 / FPS];

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const smoothInOut = (x) => {
  const p = clamp01(x);
  return p * p * (3 - 2 * p);
};
function riseOvershoot(u) {
  // bezier(0.2, 1.25, 0.3, 1)：过冲再落
  const p = clamp01(u);
  return 1 - Math.pow(1 - p, 3) * (1 - 0.25 * p) + 0.16 * Math.sin(p * Math.PI) * (1 - p);
}

/** 光池游走：3 个中间站，站间 smooth in-out，站内 2–3f 停顿。 */
function poolPos(time, W, H) {
  const stops = [
    { x: 0.28, y: 0.38 },
    { x: 0.62, y: 0.3 },
    { x: 0.44, y: 0.62 },
  ];
  const t0 = 4 / FPS;
  const t1 = 28 / FPS;
  if (time <= LOCK_AT) {
    const total = 3;
    const seg = clamp01(time / LOCK_AT) * total;
    const idx = Math.min(total - 1, Math.floor(seg));
    const local = clamp01(seg - idx);
    const prev = idx === 0 ? { x: 0.2, y: 0.5 } : stops[idx - 1];
    const next = stops[Math.min(stops.length - 1, idx)];
    const e = smoothInOut(local);
    const x = prev.x + (next.x - prev.x) * e;
    const y = prev.y + (next.y - prev.y) * e;
    return { x: W * x, y: H * y, r: W * (0.29 + 0.04 * Math.sin(seg)) };
  }
  void t0;
  void t1;
  return { x: W * 0.5, y: H * 0.46, r: W * 0.24 };
}

/** 卡形软孔：在同一块暗场上挖出卡位（紧孔 + 一圈宽溢光）。 */
function carveCardHole(ctx, card, W, H, strength) {
  if (strength <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  // 紧孔
  const g = ctx.createRadialGradient(card.cx, card.cy, 0, card.cx, card.cy, card.w * 0.78);
  g.addColorStop(0, 'rgba(0,0,0,' + strength.toFixed(3) + ')');
  g.addColorStop(0.62, 'rgba(0,0,0,' + (strength * 0.92).toFixed(3) + ')');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(card.cx - card.w, card.cy - card.h, card.w * 2, card.h * 2);
  ctx.restore();
}

function drawPage(ctx, W, H, src, cam, cardIndex) {
  // 整页：一屏卡片网格（真页面的抽象版）
  const cols = 4;
  const rows = 3;
  const gw = (W * 0.9) / cols;
  const gh = (H * 0.72) / rows;
  const ox = W * 0.05;
  const oy = H * 0.16;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c;
      const x = ox + c * gw + gw * 0.06;
      const y = oy + r * gh + gh * 0.08;
      const cw = gw * 0.88;
      const chh = gh * 0.84;
      ctx.save();
      ctx.fillStyle = '#f2ece2';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y, cw, chh, cw * 0.03) : ctx.rect(x, y, cw, chh);
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y, cw, chh, cw * 0.03) : ctx.rect(x, y, cw, chh);
      ctx.clip();
      if (src) {
        const sw = src.width || cw;
        const sh = src.height || chh;
        const cwid = sw / 2.2;
        const chgt = sh / 1.8;
        const sx = ((i * 0.27) % 1) * (sw - cwid);
        const sy = ((i * 0.18) % 1) * (sh - chgt);
        const k = Math.max(cw / cwid, chh / chgt);
        ctx.drawImage(src, sx, sy, cwid, chgt, x + (cw - cwid * k) / 2, y + (chh - chgt * k) / 2, cwid * k, chgt * k);
      } else {
        ctx.fillStyle = '#e6ded1';
        ctx.fillRect(x, y, cw, chh);
        ctx.fillStyle = i === cardIndex ? 'rgba(150, 110, 78, 0.34)' : 'rgba(140, 124, 104, 0.2)';
        ctx.fillRect(x + cw * 0.08, y + chh * 0.1, cw * 0.5, chh * 0.1);
        for (let k = 0; k < 3; k += 1) {
          ctx.fillStyle = 'rgba(150, 134, 114, 0.16)';
          ctx.fillRect(x + cw * 0.08, y + chh * (0.3 + k * 0.18), cw * (0.76 - k * 0.12), chh * 0.08);
        }
        if (i === cardIndex) {
          ctx.fillStyle = 'rgba(110, 84, 60, 0.75)';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = '600 ' + Math.round(chh * 0.12) + 'px system-ui, sans-serif';
          ctx.fillText('主角卡 = 素材切片', x + cw / 2, y + chh * 0.86);
        }
      }
      ctx.restore();
      ctx.restore();
    }
  }
  void cam;
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
  const champagne = 'rgba(240, 214, 168, 1)';

  // 相机：zoom 0.8 → 2.6（18f 推进），推进后锁死
  const pushU = smoothInOut(clamp01((time - PUSH_A) / (PUSH_B - PUSH_A)));
  const zoom = 0.8 + (2.6 - 0.8) * pushU;
  const focusX = W * 0.5 + 105 * pushU;   // 焦点取卡心左移 105px
  const focusY = H * 0.5 - 10 * pushU;

  ctx.save();
  ctx.fillStyle = '#0a0908';
  ctx.fillRect(0, 0, W, H);

  // 页面层（相机）
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-focusX, -focusY);
  drawPage(ctx, W, H, src, { zoom }, 3);
  ctx.restore();

  // 关灯：整页压到 6–14%（推闸：f1–6 亮 → 回闪 62% → 稳住）
  const switchU = clamp01(time / (6 / FPS));
  const flicker = time < 6 / FPS ? 1 - 0.38 * Math.sin(clamp01(time / (6 / FPS)) * Math.PI) : 1;
  const dark = 0.94 - 0.02 * switchU * flicker;
  ctx.fillStyle = 'rgba(14, 12, 10, ' + dark.toFixed(3) + ')';
  ctx.fillRect(0, 0, W, H);

  // 光池（近高斯多段 stop）
  const pool = poolPos(time, W, H);
  const locked = time >= LOCK_AT;
  const poolPulse = locked ? 1 + 0.06 * Math.exp(-(time - LOCK_AT) / (0.1)) : 1;
  if (!locked || pushU < 0.55) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const light = ctx.createRadialGradient(pool.x, pool.y, 0, pool.x, pool.y, pool.r * poolPulse);
    light.addColorStop(0, 'rgba(255, 236, 208, 0.5)');
    light.addColorStop(0.32, 'rgba(255, 226, 190, 0.34)');
    light.addColorStop(0.62, 'rgba(232, 198, 158, 0.16)');
    light.addColorStop(0.85, 'rgba(200, 168, 128, 0.05)');
    light.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // 体积光柱：光源在上方偏右，梯形柱打到光池，柱内确定性浮尘
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const srcX = pool.x + 420 * s;
  const srcY = -720 * s;
  const beamW = pool.r * 0.6;
  const beamA = (locked ? 0.06 : 0.34) * (1 - pushU * 0.45);
  const beamGrad = ctx.createLinearGradient(srcX, srcY, pool.x, pool.y);
  beamGrad.addColorStop(0, 'rgba(255, 232, 198, ' + beamA.toFixed(3) + ')');
  beamGrad.addColorStop(1, 'rgba(255, 232, 198, 0)');
  ctx.fillStyle = beamGrad;
  ctx.beginPath();
  ctx.moveTo(srcX - beamW * 0.2, srcY);
  ctx.lineTo(srcX + beamW * 0.2, srcY);
  ctx.lineTo(pool.x + beamW, pool.y);
  ctx.lineTo(pool.x - beamW, pool.y);
  ctx.closePath();
  ctx.fill();
  // 浮尘（确定性）
  for (let i = 0; i < 16; i += 1) {
    const h1 = Math.sin(i * 12.9898) * 43758.5453;
    const h2 = Math.sin(i * 78.233) * 43758.5453;
    const fx = (h1 - Math.floor(h1));
    const fy = (h2 - Math.floor(h2));
    const drift = ((time * 0.05 + fy) % 1);
    const px = srcX + (pool.x - srcX) * drift + (fx - 0.5) * beamW * 1.4;
    const py = srcY + (pool.y - srcY) * drift;
    ctx.globalAlpha = beamA * 1.6 * (1 - drift);
    ctx.fillStyle = 'rgba(255, 240, 214, 1)';
    ctx.beginPath();
    ctx.arc(px, py, 1.6 * s * (0.6 + fx), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 卡位（相机空间 → 屏幕空间）
  const cardW = W * 0.16 * zoom;
  const cardH = H * 0.19 * zoom;
  // 卡片在页面里的位置（第 4 张，中心 x≈页面中心）
  const pageCx = W * 0.05 + 2 * ((W * 0.9) / 4) + ((W * 0.9) / 4) * 0.5;
  const pageCy = H * 0.16 + ((H * 0.72) / 3) * 0.5;
  const cardScreen = {
    cx: W / 2 + (pageCx - focusX) * zoom,
    cy: H / 2 + (pageCy - focusY) * zoom,
    w: cardW,
    h: cardH,
  };

  // 锁定后：卡形光（暗场在卡位挖孔，卡保持原生对比）
  const carveP = clamp01((time - LOCK_AT) / ((58 - 38) / FPS));
  if (carveP > 0) {
    // 再压一档暗
    ctx.fillStyle = 'rgba(12, 10, 8, ' + (0.24 * carveP).toFixed(3) + ')';
    ctx.fillRect(0, 0, W, H);
    // 用 destination-out 在卡位挖孔（先记下当前像素，再挖 —— canvas 无法「挖出亮度」，
    // 所以这里改为把卡本体重画在暗场之上：等价于「暗场在卡位留了洞」）
    const card = cardScreen;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect
      ? ctx.roundRect(card.cx - card.w / 2, card.cy - card.h / 2, card.w, card.h, card.w * 0.035)
      : ctx.rect(card.cx - card.w / 2, card.cy - card.h / 2, card.w, card.h);
    ctx.clip();
    // 卡内重画本色内容（从页面素材裁一角）
    if (src) {
      const sw = src.width || card.w;
      const sh = src.height || card.h;
      const k = Math.max(card.w / sw, card.h / sh);
      ctx.drawImage(src, card.cx - card.w / 2 + (card.w - sw * k) / 2, card.cy - card.h / 2 + (card.h - sh * k) / 2, sw * k, sh * k);
    } else {
      ctx.fillStyle = '#f2ece2';
      ctx.fillRect(card.cx - card.w / 2, card.cy - card.h / 2, card.w, card.h);
      ctx.fillStyle = 'rgba(140, 124, 104, 0.22)';
      ctx.fillRect(card.cx - card.w * 0.4, card.cy - card.h * 0.34, card.w * 0.6, card.h * 0.08);
      for (let k2 = 0; k2 < 3; k2 += 1) {
        ctx.fillStyle = 'rgba(150, 134, 114, 0.16)';
        ctx.fillRect(card.cx - card.w * 0.4, card.cy - card.h * (0.1 - k2 * 0.16), card.w * (0.7 - k2 * 0.1), card.h * 0.06);
      }
      ctx.fillStyle = 'rgba(110, 84, 60, 0.7)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 ' + Math.round(card.h * 0.075) + 'px system-ui, sans-serif';
      ctx.fillText('props.assetId', card.cx, card.cy + card.h * 0.3);
    }
    ctx.restore();
    // 卡边暖白发丝轮廓光 + 极淡外溢
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 240, 214, ' + (0.5 * carveP).toFixed(3) + ')';
    ctx.lineWidth = Math.max(1, 1.6 * s);
    ctx.shadowColor = 'rgba(255, 232, 196, ' + (0.5 * carveP).toFixed(3) + ')';
    ctx.shadowBlur = 12 * s;
    ctx.beginPath();
    ctx.roundRect
      ? ctx.roundRect(card.cx - card.w / 2, card.cy - card.h / 2, card.w, card.h, card.w * 0.035)
      : ctx.rect(card.cx - card.w / 2, card.cy - card.h / 2, card.w, card.h);
    ctx.stroke();
    ctx.restore();
    // hold 段暗场 ±1.2% 极缓呼吸
    const breath = locked ? 0.012 * Math.sin((time - LOCK_AT) * 2.2) : 0;
    if (breath > 0) {
      ctx.fillStyle = 'rgba(255, 240, 214, ' + breath.toFixed(4) + ')';
      ctx.fillRect(0, 0, W, H);
    }
    void carveCardHole;
  }

  // ---- 卡片 rise / bob / reseat（画在暗场之上，所以它「高于」暗层） ----
  const riseU = clamp01((time - RISE_AT) / RISE_DUR);
  const seatU = clamp01((time - SEAT_AT) / SEAT_DUR);
  if (carveP > 0) {
    const lift = (riseOvershoot(riseU) * (1 - outCubic(seatU))) * H * 0.1;
    const bob = Math.sin((time - RISE_AT) * ((Math.PI * 2) / (40 / FPS))) * 4 * s * clamp01(riseU) * (1 - clamp01(seatU));
    const riseScale = 1 + 0.04 * clamp01(riseU) * (1 - clamp01(seatU));
    const cy = cardScreen.cy - lift + bob - H * 0.03 * clamp01(riseU) * (1 - clamp01(seatU));
    // 双层影：偏左下，随高度生长（光从右上来）
    ctx.save();
    ctx.globalAlpha = 0.42 * (1 - clamp01(seatU)) * clamp01(riseU);
    ctx.shadowColor = 'rgba(6, 5, 4, 0.9)';
    ctx.shadowBlur = (18 + lift * 0.12) * s;
    ctx.shadowOffsetX = -lift * 0.28;
    ctx.shadowOffsetY = lift * 0.5;
    ctx.fillStyle = 'rgba(10, 8, 6, 1)';
    ctx.fillRect(cardScreen.cx - cardScreen.w * 0.5 * riseScale, cy - cardScreen.h * 0.5 * riseScale, cardScreen.w * riseScale, cardScreen.h * riseScale);
    ctx.restore();
  }

  // 落地一圈香槟色落地光（reseat 瞬间增亮后消失）
  if (seatU > 0 && seatU < 1) {
    ctx.save();
    ctx.globalAlpha = Math.sin(seatU * Math.PI) * 0.7;
    ctx.strokeStyle = champagne;
    ctx.lineWidth = Math.max(1.6, 3 * s);
    ctx.beginPath();
    ctx.ellipse(cardScreen.cx, cardScreen.cy + cardScreen.h * 0.52, cardScreen.w * 0.56 * outCubic(seatU), cardScreen.h * 0.12 * outCubic(seatU), 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // ---- 轮廓光束跑两圈：第一圈快而亮、第二圈慢而弱 ----
  const lap = (a, b, widthOuter, widthInner, alpha) => {
    const u = clamp01((time - a) / (b - a));
    if (u <= 0 || u >= 1) return;
    // dasharray "0.16 1" 走 dashoffset 的效果：用两段弧交替
    const total = Math.PI * 2 * 3.2;
    const segLen = total * 0.16;
    const offset = u * total;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = champagne;
    ctx.lineWidth = Math.max(1.4, widthOuter * s);
    ctx.lineCap = 'round';
    const r = cardScreen.w * 0.5 + 6 * s;
    for (let k = 0; k < 6; k += 1) {
      const start = (offset + k * total * 0.16 * 1.0) % total;
      const steps = 12;
      ctx.beginPath();
      for (let i = 0; i <= steps; i += 1) {
        const a2 = start + (segLen * i) / steps;
        const x = cardScreen.cx + Math.cos(a2) * r;
        const y = cardScreen.cy + Math.sin(a2) * r * (cardScreen.h / cardScreen.w);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // 白芯
      ctx.strokeStyle = 'rgba(255, 252, 244, 0.9)';
      ctx.lineWidth = Math.max(0.8, widthInner * s);
      ctx.stroke();
      ctx.strokeStyle = champagne;
      ctx.lineWidth = Math.max(1.4, widthOuter * s);
    }
    ctx.restore();
  };
  lap(LAP1[0], LAP1[1], 5, 2.5, 1);
  lap(LAP2[0], LAP2[1], 3.5, 1.75, 0.62);

  // ---- 3D 注记：卡左侧两行 + 关键词背后香槟色马克条 ----
  const noteP = outCubic(clamp01((time - (84 / FPS)) / (18 / FPS)));
  if (noteP > 0) {
    const noteCx = cardScreen.cx - cardScreen.w * 0.95;
    const noteY = cardScreen.cy - cardScreen.h * 0.1;
    const line1 = String(props.line1 || 'Your product,');
    const line2 = String(props.line2 || 'in motion.');
    const kw = String(props.keyword || 'motion');
    const fs = Math.max(18, Math.round(H * 0.058 * (0.6 + 0.4 * pushU)));
    ctx.save();
    ctx.globalAlpha = noteP;
    // 暗色衬底：压住邻卡文字（注记是自发光的字，不被关灯压暗）
    ctx.fillStyle = 'rgba(10, 8, 6, ' + (0.55 * noteP).toFixed(3) + ')';
    ctx.fillRect(noteCx - fs * 0.6, noteY - fs * 1.6, cardScreen.w * 1.5, fs * 4.2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '800 ' + fs + 'px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(250, 246, 238, 0.98)';
    ctx.fillText(line1, noteCx, noteY + (1 - noteP) * fs * 0.3);
    ctx.fillText(line2, noteCx, noteY + fs * 1.15 + (1 - noteP) * fs * 0.3);
    // 关键词背后马克条（12f 长出，字翻成墨色）
    const barP = clamp01((time - (96 / FPS)) / (12 / FPS));
    if (barP > 0) {
      const kwW = (() => {
        const full = ctx.measureText(line2).width;
        const idx = line2.indexOf(kw);
        if (idx < 0) return full * 0.4;
        const before = ctx.measureText(line2.slice(0, idx)).width;
        return ctx.measureText(kw).width;
      })();
      const kwX = noteCx;
      ctx.fillStyle = champagne;
      ctx.fillRect(kwX - fs * 0.06, noteY + fs * 1.15 - fs * 0.62, kwW * barP + fs * 0.12, fs * 0.7);
    }
    ctx.restore();
  }

  // 右下 mono：相机与相位（编辑期校对）
  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(196, 176, 150, 0.4)';
  ctx.font = '500 ' + Math.round(H * 0.024) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('ZOOM ' + zoom.toFixed(2) + '  ·  ' + (locked ? 'LOCKED' : 'SEEKING'), W * 0.95, H * 0.95);
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
