/**
 * sc-deck-deal-flyin · 发牌飞入（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/ui-entrance/deck-deal-flyin.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权与归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - 26 张卡，堆叠高度 STACK_STEP=3px，姿态抖动用确定性公式 (((k*7)%9)−4)*2（渲染必须可复现）；
 *   - 预备拍：26→36f 牌堆整体下压 48px + 顶卡回拉 30px（幅度必须过肉眼阈值，4px 版被判无感）；
 *   - 发牌节拍 cue = 36 + 4k − 0.0792·k(k−1)（硬加速，均匀间隔会被读作机械）；
 *   - 单卡飞行 deal 8f（z 弧顶 +110px、scale 峰值 1.06）+ settle 4f 过冲 + press 2f 回弹；
 *   - 相机追着发牌升高后仰，落在跑道式俯瞰；满板后 hold 只留 1.5% 极缓推近；
 *   - 石墨桌面：顶光 radial + 镜面高光带 + 拉丝纹 + 冷灰渐变；页面板先是暗的，灯从牌堆揭开。
 */

export const meta = {
  title: '发牌飞入',
  duration: 5.0,
  source: 'shotcraft',
  sourcePath: 'references/shots/ui-entrance/deck-deal-flyin.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const f2s = (f) => f / FPS;
const PRE_END = f2s(36);       // 1.2s：预备拍结束、首发
const DEAL_END = f2s(120);     // 4.0s：最后一张落定
const TOTAL_CARDS = 26;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const inOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
/** 落地要弹：y1 > 1 的三次 bezier 近似（过冲再回落）。 */
function overshootBezier(u) {
  const p = clamp01(u);
  return 1 - Math.pow(1 - p, 3) * (1 - 0.18 * p);
}

/** 确定性伪随机：避开 Math.random，保证同 t 重放一致。 */
function detJitter(k, salt) {
  return ((((k * 7 + salt * 5) % 9) + 9) % 9 - 4) * 2;
}

/** 发牌 cue：36 + 4k − 0.0792k(k−1) 帧 → 秒。 */
function cueOf(k) {
  const f = 36 + 4 * k - 0.0792 * k * (k - 1);
  return f2s(Math.max(36, f));
}

const DECK = { cols: 5, rows: 6 };

/** 页面板网格里第 k 个格位的世界坐标（归一化，0→1 为板范围）。 */
function slotOf(k) {
  const c = k % DECK.cols;
  const r = Math.floor(k / DECK.cols);
  return { u: (c + 0.5) / DECK.cols, v: (r + 0.5) / DECK.rows };
}

/** 相机：追着发牌升高后仰 —— 用 zoom / rot / squashY 近似 rotX 抬头。 */
function cameraAt(t, w, h) {
  const u = inOutCubic(clamp01(t / (DEAL_END - 0.3)));
  const zoom = 1.58 + (0.5 - 1.58) * u;
  const squash = 1 - 0.26 * u;         // rotX 由 22° 抬到 52° 的视觉压缩
  const rot = (-3 + -24 * u) * (Math.PI / 180);
  const shiftX = 0.02 + 0.1 * u;       // 屏幕右移给左下标语让位
  // 满板后再留 1.5% 极缓推近
  const rest = clamp01((t - (DEAL_END - 0.1)) / 1.1);
  const push = 1 - 0.015 * rest;
  return { zoom: zoom * push, squash, rot, shiftX, u };
}

function worldToScreen(u, v, cam, w, h) {
  const bw = w * 0.9;
  const bh = h * 0.9;
  let x = (u - 0.5) * bw;
  let y = (v - 0.5) * bh;
  x *= cam.zoom;
  y *= cam.zoom * cam.squash;
  const cos = Math.cos(cam.rot);
  const sin = Math.sin(cam.rot);
  const rx = x * cos - y * sin;
  const ry = x * sin + y * cos;
  return { x: w * (0.5 + cam.shiftX) + rx, y: h * 0.5 + ry, s: cam.zoom, squash: cam.squash };
}

function pileScreen(w, h, cam, press, pull) {
  const base = worldToScreen(0.02, 0.5, cam, w, h);
  return { x: base.x - w * 0.3 + pull, y: base.y + press, s: base.s };
}

/** 画一张卡：有素材的卡铺素材，其余用确定性色块假装页面切片。 */
function drawCardFace(ctx, cw, ch, k, src) {
  if (k === 0 && src) {
    const sw = src.width || cw;
    const sh = src.height || ch;
    const kk = Math.max(cw / sw, ch / sh);
    ctx.drawImage(src, -cw / 2 + (cw - sw * kk) / 2, -ch / 2 + (ch - sh * kk) / 2, sw * kk, sh * kk);
    return;
  }
  if (k === 0 && !src) {
    // 首卡是素材槽：画带说明的占位，让观众知道这里要放什么
    ctx.fillStyle = '#20242c';
    ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
    ctx.strokeStyle = 'rgba(120, 176, 255, 0.5)';
    ctx.lineWidth = Math.max(1, cw / 90);
    ctx.setLineDash([cw * 0.05, cw * 0.035]);
    ctx.strokeRect(-cw * 0.4, -ch * 0.36, cw * 0.8, ch * 0.5);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(198, 220, 255, 0.94)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.max(9, cw * 0.075) + 'px system-ui, sans-serif';
    ctx.fillText('首卡素材槽', 0, -ch * 0.1);
    ctx.font = Math.max(7, cw * 0.048) + 'px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(160, 190, 230, 0.75)';
    ctx.fillText('给 props.assetId 一张', 0, 0);
    ctx.fillText('真实页面截图切片', 0, ch * 0.075);
    return;
  }
  // 其余卡：确定性色块「页面切片」，避免手搓假卡的一眼假
  const hue = 198 + ((k * 37) % 60) - 30;
  ctx.fillStyle = 'hsl(' + hue + ', 18%, ' + (16 + ((k * 13) % 9)) + '%)';
  ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
  const rows = 3 + (k % 3);
  for (let i = 0; i < rows; i += 1) {
    const rw = cw * (0.28 + ((k * 11 + i * 17) % 50) / 100);
    const rh = ch * (0.05 + (i % 2) * 0.03);
    ctx.fillStyle = 'rgba(196, 214, 240, ' + (0.1 + (i % 3) * 0.045).toFixed(3) + ')';
    ctx.fillRect(-cw * 0.4, -ch * 0.34 + i * ch * 0.19, rw, rh);
  }
  ctx.fillStyle = 'rgba(120, 176, 255, 0.75)';
  ctx.fillRect(-cw * 0.4, ch * 0.3, cw * 0.14, ch * 0.055);
}

function __renderInner(ctx, t, env) {
  const w = Number(env && env.width) || 1;
  const h = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const time = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
  const m = env && env.media;
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);
  const src = id && m ? (m.image(id) || m.video(id)) : null;

  const cam = cameraAt(time, w, h);

  ctx.save();
  // ---- 石墨桌面（4 层叠加）----
  const desk = ctx.createLinearGradient(0, 0, w * 0.4, h);
  desk.addColorStop(0, '#20242a');
  desk.addColorStop(0.5, '#171a20');
  desk.addColorStop(1, '#0d1014');
  ctx.fillStyle = desk;
  ctx.fillRect(0, 0, w, h);

  // 拉丝纹：低频斜线（俯视下对比压到极低，避免摩尔纹）
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = 'rgba(200, 214, 232, 0.5)';
  ctx.lineWidth = 1;
  const brushGap = Math.max(3, h / 190);
  for (let y = -h; y < h * 2; y += brushGap) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y + w * 0.22);
    ctx.stroke();
  }
  ctx.restore();

  // 顶光 radial（随拉远扩大）+ 104° 镜面高光带
  const top = ctx.createRadialGradient(w * 0.34, h * 0.3, 0, w * 0.34, h * 0.3, w * (0.3 + 0.5 * cam.u));
  top.addColorStop(0, 'rgba(210, 228, 255, 0.11)');
  top.addColorStop(1, 'rgba(210, 228, 255, 0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, w, h);
  const sheen = ctx.createLinearGradient(0, 0, w * 0.7, h);
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0)');
  sheen.addColorStop(0.42, 'rgba(226, 238, 255, 0.07)');
  sheen.addColorStop(0.58, 'rgba(226, 238, 255, 0.03)');
  sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, w, h);

  // ---- 页面板（既是「展板」也是网格容器）----
  const boardA = worldToScreen(0, 0, cam, w, h);
  const boardB = worldToScreen(1, 1, cam, w, h);
  const bx = Math.min(boardA.x, boardB.x);
  const by = Math.min(boardA.y, boardB.y);
  const bwPx = Math.abs(boardB.x - boardA.x);
  const bhPx = Math.abs(boardB.y - boardA.y);
  ctx.save();
  ctx.fillStyle = 'rgba(236, 240, 246, 0.94)';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(bx, by, bwPx, bhPx, Math.min(bwPx, bhPx) * 0.02) : ctx.rect(bx, by, bwPx, bhPx);
  ctx.fill();
  // 板内极淡网格
  ctx.strokeStyle = 'rgba(96, 120, 150, 0.12)';
  ctx.lineWidth = Math.max(1, w / 1600);
  for (let c = 1; c < DECK.cols; c += 1) {
    const p = worldToScreen(c / DECK.cols, 0, cam, w, h);
    ctx.beginPath();
    ctx.moveTo(p.x, by);
    ctx.lineTo(p.x, by + bhPx);
    ctx.stroke();
  }
  for (let r = 1; r < DECK.rows; r += 1) {
    const p = worldToScreen(0, r / DECK.rows, cam, w, h);
    ctx.beginPath();
    ctx.moveTo(bx, p.y);
    ctx.lineTo(bx + bwPx, p.y);
    ctx.stroke();
  }
  ctx.restore();

  // 开场：板被 0.88 暗层盖住，34→64f 以牌堆为圆心柔边光圈揭开
  const revealCenter = pileScreen(w, h, cam, 0, 0);
  const reveal = clamp01((time - f2s(34)) / f2s(30));
  if (reveal < 1) {
    ctx.save();
    const rv = ctx.createRadialGradient(revealCenter.x, revealCenter.y, 0, revealCenter.x, revealCenter.y, w * (0.1 + 0.85 * outCubic(reveal)));
    rv.addColorStop(0, 'rgba(10, 12, 16, ' + (0.88 * (1 - reveal)).toFixed(3) + ')');
    rv.addColorStop(0.62, 'rgba(10, 12, 16, ' + (0.88 * (1 - reveal)).toFixed(3) + ')');
    rv.addColorStop(1, 'rgba(10, 12, 16, 0.88)');
    ctx.fillStyle = rv;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // ---- 预备拍：牌堆下压 48px + 顶卡回拉 30px ----
  const preU = clamp01((time - f2s(26)) / f2s(10));
  const press = (h / 720) * 48 * outCubic(preU);
  const pull = (w / 1280) * 30 * outCubic(preU);
  const pile = pileScreen(w, h, cam, press, -pull);

  // ---- 牌堆：未发出的卡叠在堆上 ----
  // 性能：牌堆只画最上面 8 张（下面 18 张的卡面在视觉上被完全遮住），
  // 其余用一块板厚度一次性表示 —— 26 张全画在 1080p 下会吃掉几毫秒。
  const PILE_DRAW_TOP = 8;
  const dealt = [];
  const pending = [];
  for (let k = 0; k < TOTAL_CARDS; k += 1) {
    if (time < cueOf(k)) pending.push(k);
  }
  if (pending.length > PILE_DRAW_TOP) {
    const restCount = pending.length - PILE_DRAW_TOP;
    ctx.save();
    ctx.fillStyle = 'rgba(30, 34, 42, 0.95)';
    ctx.fillRect(pile.x - w * 0.09, pile.y - restCount * 3 * (h / 720), w * 0.18, restCount * 3 * (h / 720) + h * 0.02);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.strokeRect(pile.x - w * 0.09, pile.y - restCount * 3 * (h / 720), w * 0.18, restCount * 3 * (h / 720) + h * 0.02);
    ctx.restore();
  }
  for (let k = 0; k < TOTAL_CARDS; k += 1) {
    const cue = cueOf(k);
    if (time < cue) {
      const depth = pending.indexOf(k);
      if (depth < pending.length - PILE_DRAW_TOP) {
        dealt.push({ k, state: 'pile' });
        continue;
      }
      ctx.save();
      ctx.translate(pile.x + detJitter(k, 1) * (w / 1280), pile.y - depth * 3 * (h / 720) + detJitter(k, 2) * (h / 720));
      ctx.rotate((detJitter(k, 3) / 720) * 3 * (Math.PI / 180));
      const cw = w * 0.3 * pile.s * 0.6;
      const ch = cw * 0.62;
      ctx.fillStyle = 'rgba(6, 8, 10, 0.4)';
      ctx.fillRect(-cw / 2 + cw * 0.02, -ch / 2 + ch * 0.05, cw, ch);
      drawCardFace(ctx, cw, ch, k, src);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 1;
      ctx.strokeRect(-cw / 2, -ch / 2, cw, ch);
      ctx.restore();
      dealt.push({ k, state: 'pile' });
    } else {
      dealt.push({ k, state: 'dealt' });
    }
  }

  // ---- 已发出的卡：deal 8f → settle 4f → press 2f ----
  for (const item of dealt) {
    if (item.state !== 'dealt') continue;
    const k = item.k;
    const cue = cueOf(k);
    const fly = 8 / FPS;
    const settle = 4 / FPS;
    const pressF = 2 / FPS;
    const uFly = clamp01((time - cue) / fly);
    const slot = slotOf(k);
    const to = worldToScreen(slot.u, slot.v, cam, w, h);
    const cw = w * 0.3 * to.s * 0.28;
    const ch = cw * 0.62;

    let x;
    let y;
    let rot;
    let scale;
    let alpha = 1;
    if (uFly < 1) {
      const e = inOutCubic(uFly);
      const from = pile;
      x = from.x + (to.x - from.x) * e;
      y = from.y + (to.y - from.y) * e;
      // z 弧顶 +110px
      y -= Math.sin(uFly * Math.PI) * (h / 720) * 110;
      rot = (detJitter(k, 4) / 720) * 4 * (Math.PI / 180) * (1 - e);
      scale = 1 + 0.06 * Math.sin(uFly * Math.PI);
    } else if (time - cue < fly + settle) {
      const e = overshootBezier((time - cue - fly) / settle);
      x = to.x;
      y = to.y;
      rot = 0;
      scale = 1 + 0.03 * (1 - e);
    } else {
      x = to.x;
      y = to.y;
      rot = 0;
      const p = clamp01((time - cue - fly - settle) / pressF);
      scale = 0.996 + 0.004 * p;
      // 拖拽层级：卡体落定即锁定，残影尾梢再拖几帧
      const ghost = clamp01(1 - (time - cue - fly - settle) / (6 / FPS));
      if (ghost > 0) alpha = 1;
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(scale, scale * (0.7 + 0.3 * to.squash));
    // 落影：0 32px → 0 2px 收敛，滞后卡体 2–4f
    ctx.save();
    ctx.shadowColor = 'rgba(8, 10, 14, 0.42)';
    ctx.shadowBlur = cw * 0.2;
    ctx.shadowOffsetY = ch * 0.18;
    ctx.fillStyle = 'rgba(30, 34, 42, 0.9)';
    ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(-cw / 2, -ch / 2, cw, ch);
    ctx.clip();
    drawCardFace(ctx, cw, ch, k, src);
    ctx.restore();
    ctx.strokeStyle = 'rgba(20, 26, 34, 0.28)';
    ctx.lineWidth = Math.max(0.5, cw / 180);
    ctx.strokeRect(-cw / 2, -ch / 2, cw, ch);
    ctx.restore();
  }

  // ---- 左下标语 + mono 计数行（计数跟着落地张数跳）----
  const landCount = dealt.filter((d) => d.state === 'dealt' && time > cueOf(d.k) + 8 / FPS).length;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const tagIn = outCubic(clamp01((time - PRE_END) / 0.4));
  ctx.globalAlpha = tagIn;
  ctx.fillStyle = 'rgba(232, 240, 252, 0.96)';
  ctx.font = '700 ' + Math.round(h * 0.058) + 'px system-ui, sans-serif';
  ctx.fillText(String(props.slogan || 'EVERYTHING, DEALT IN'), w * 0.05, h * 0.87);
  ctx.fillStyle = 'rgba(130, 176, 240, 0.9)';
  ctx.font = '500 ' + Math.round(h * 0.032) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('DEALT ' + String(landCount).padStart(2, '0') + ' / ' + TOTAL_CARDS + '   ·   GRID ' + DECK.cols + '×' + DECK.rows, w * 0.05, h * 0.935);
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
