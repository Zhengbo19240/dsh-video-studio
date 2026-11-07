/**
 * sc-list-stack-press · 列表堆叠按压（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/ui-entrance/list-stack-press.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - 预备拍：首卡前 4–6f 计数器先亮起 micro（scale 0.96→1），把视线引到堆叠区；
 *   - 5 张卡从画面下方 600px 升入，CUES=[18,30,42,54,66] 等距 12f，每张飞 22f，
 *     bezier(0.45,0.05,0.25,1.12) 末端过冲；交替 ±2° 倾斜后收平，scale 1.06→1；
 *   - **压感**：后一张到场时整摞压下 6px、8f 弹回（脉冲 [cue,cue+4,cue+8]→[0,6,0]）——
 *     这一笔就是「有重量」的来源，砍掉后堆叠变成简单排版；
 *   - 拖拽层级：卡体先停 → 整摞弹回 → 高亮条滞后 2–4f 长出；
 *   - 收尾一道 glaze 扫光掠过整摞（只此一次、扫整摞不逐卡）；
 *   - 计数器按落一张滚一格，单格 8f 滚定（必须短于 12f 节拍）；
 *   - 相机 zoom 1.35→0.86 一条连续曲线跟随堆叠向下（避免分段关键帧处速度归零）。
 */

export const meta = {
  title: '列表堆叠按压',
  duration: 3.4,
  source: 'shotcraft',
  sourcePath: 'references/shots/ui-entrance/list-stack-press.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const CUES = [18, 30, 42, 54, 66].map((f) => f / FPS);
const FLY = 22 / FPS;
const PRESS = 8 / FPS;
const MICRO_AT = 12 / FPS;
const GLAZE_AT = 74 / FPS;
const GLAZE_SPAN = 13 / FPS;

const NAMES = ['Inbox feed', 'Saved radar', 'Research list', 'Client briefs', 'Archive 2025'];

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);

/** bezier(0.45, 0.05, 0.25, 1.12)：末端过冲再回落（落地要弹就得 y1 > 1）。 */
function overshoot(u) {
  const p = clamp01(u);
  const p1x = 0.45;
  const p1y = 0.05;
  const p2x = 0.25;
  const p2y = 1.12;
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

/** 压感脉冲：到场那帧起 0 → 6 → 0，8f 弹回（先压下再回，不是先上）。 */
function pressAt(time, cue) {
  const since = time - cue;
  if (since < 0) return 0;
  const marks = [0, 4 / FPS, 8 / FPS];
  const vals = [0, 6, 0];
  if (since >= marks[2]) return 0;
  if (since <= marks[1]) {
    const u = since / marks[1];
    return vals[1] * outCubic(u) * -1; // 向下为正（屏幕 y 增大）
  }
  const u = (since - marks[1]) / (marks[2] - marks[1]);
  return -(vals[1] * (1 - u));
}

/** 一张列表卡：整摞按压时它也跟着压（传递动能）。 */
function drawCardBody(ctx, cw, ch, index, src, isTop) {
  ctx.fillStyle = '#fbfaf7';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(-cw / 2, -ch / 2, cw, ch, Math.min(cw, ch) * 0.045) : ctx.rect(-cw / 2, -ch / 2, cw, ch);
  ctx.fill();

  // 左侧缩略图：只有最上面那张用素材，其余用色块
  const th = ch * 0.62;
  const tw = th * 1.35;
  const tx = -cw / 2 + cw * 0.035;
  const ty = -ch / 2 + (ch - th) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(tx, ty, tw, th, th * 0.12) : ctx.rect(tx, ty, tw, th);
  ctx.clip();
  if (isTop && src) {
    const sw = src.width || tw;
    const sh = src.height || th;
    const k = Math.max(tw / sw, th / sh);
    ctx.drawImage(src, tx + (tw - sw * k) / 2, ty + (th - sh * k) / 2, sw * k, sh * k);
  } else {
    const hue = 26 + index * 9;
    ctx.fillStyle = 'hsl(' + hue + ', 34%, ' + (72 - index * 4) + '%)';
    ctx.fillRect(tx, ty, tw, th);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillRect(tx + tw * 0.12, ty + th * 0.2, tw * 0.5, th * 0.12);
    if (isTop && !src) {
      ctx.strokeStyle = 'rgba(150, 96, 62, 0.7)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = Math.max(1, th * 0.05);
      ctx.strokeRect(tx + tw * 0.08, ty + th * 0.08, tw * 0.84, th * 0.84);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(120, 70, 40, 0.9)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 ' + Math.round(th * 0.19) + 'px system-ui, sans-serif';
      ctx.fillText('首卡缩略图', tx + tw / 2, ty + th * 0.42);
      ctx.font = Math.round(th * 0.135) + 'px system-ui, sans-serif';
      ctx.fillText('= props.assetId', tx + tw / 2, ty + th * 0.62);
    }
  }
  ctx.restore();

  // 文本两行
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(38, 34, 30, 0.92)';
  ctx.font = '600 ' + Math.round(ch * 0.19) + 'px system-ui, sans-serif';
  ctx.fillText(NAMES[index % NAMES.length], tx + tw + cw * 0.04, -ch * 0.12);
  ctx.fillStyle = 'rgba(120, 112, 102, 0.72)';
  ctx.font = Math.round(ch * 0.14) + 'px system-ui, sans-serif';
  ctx.fillText(index % 2 === 0 ? 'updated 2h ago' : '12 items · shared', tx + tw + cw * 0.04, ch * 0.14);

  // 右侧箭头
  ctx.strokeStyle = 'rgba(120, 112, 102, 0.5)';
  ctx.lineWidth = Math.max(1.2, ch * 0.03);
  ctx.beginPath();
  ctx.moveTo(cw / 2 - cw * 0.05, -ch * 0.08);
  ctx.lineTo(cw / 2 - cw * 0.032, 0);
  ctx.lineTo(cw / 2 - cw * 0.05, ch * 0.08);
  ctx.stroke();
}

/** 荧光笔高亮：滞后卡体 2–4f 在项目名那一行长出（multiply 叠在字下的感觉）。 */
function drawHighlight(ctx, x, y, wdt, hgt, p) {
  if (p <= 0) return;
  ctx.save();
  ctx.globalAlpha = 0.5 * p;
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = 'rgba(255, 198, 72, 1)';
  ctx.fillRect(x, y, wdt * p, hgt);
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
  const cw = W * 0.62;
  const ch = H * 0.155;
  const gapY = ch * 0.12;

  // 相机：zoom 1.35 → 0.86 一条连续曲线，跟着堆叠往下走
  const camU = clamp01(time / 2.6);
  const zoom = 1.35 + (0.86 - 1.35) * camU;
  // 堆叠中心随卡片数下移
  let landed = 0;
  for (let i = 0; i < CUES.length; i += 1) if (time >= CUES[i] + FLY) landed += 1;
  const stackH = landed * (ch + gapY);
  const camY = H * 0.5 + stackH * 0.28 * camU;

  ctx.save();
  // 背景：微暖的纸面
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#f2ece2');
  bg.addColorStop(1, '#e6ddd0');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.translate(W / 2, camY);
  ctx.scale(zoom, zoom);
  ctx.translate(0, -H * 0.5);

  // 整摞的总压量 = 各卡到场脉冲之和（新卡的动能传给整摞）
  let stackPress = 0;
  for (const cue of CUES) stackPress += pressAt(time, cue);

  // ---- 卡片：升入 → 落定 → 逐层堆叠 ----
  for (let i = 0; i < CUES.length; i += 1) {
    const cue = CUES[i];
    const u = (time - cue) / FLY;
    if (time < cue) continue;
    const settled = u >= 1;
    const e = overshoot(clamp01(u));
    // 从下方 600px 升入
    const flyY = (1 - e) * 600 * s;
    const tiltDeg = (settled ? 0 : (1 - clamp01(u)) * (i % 2 === 0 ? -2 : 2));
    const cardScale = settled ? 1 : 1.06 + (1 - 1.06) * clamp01(u);
    // 落定后的堆叠位：越晚的卡越靠上（后摞在前面的上面）
    const slotY = H * 0.5 + (i - (CUES.length - 1) / 2) * (ch * 0.62 + gapY) * 0.9;
    const y = slotY + flyY + (settled ? stackPress * 0.55 : 0);

    ctx.save();
    ctx.translate(0, y);
    ctx.rotate((tiltDeg * Math.PI) / 180);
    ctx.scale(cardScale, cardScale);

    // 两层软影：空中 elevation≈56、落定 3（被压时更贴地）
    const elev = settled ? 3 : 56 * (1 - clamp01(u));
    ctx.save();
    ctx.shadowColor = 'rgba(60, 44, 30, ' + (0.16 + (1 - elev / 56) * 0.14).toFixed(3) + ')';
    ctx.shadowBlur = (6 + elev * 0.5) * s;
    ctx.shadowOffsetY = (2 + elev * 0.28) * s;
    ctx.translate(-cw / 2, -ch / 2);
    drawCardBody(ctx, cw, ch, i, src, i === CUES.length - 1);
    ctx.restore();

    // 拖拽层级：高亮条滞后卡体 2–4f
    if (settled) {
      const hiP = clamp01((time - cue - FLY - 3 / FPS) / (7 / FPS));
      if (hiP > 0) {
        ctx.save();
        ctx.translate(-cw / 2, -ch / 2);
        drawHighlight(ctx, cw * 0.4, ch * 0.36, cw * 0.26, ch * 0.22, hiP);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  // ---- glaze 扫光：最后一张落定后从 −500 扫到 +2300，只扫一次、扫整摞 ----
  if (time > GLAZE_AT) {
    const gp = clamp01((time - GLAZE_AT) / GLAZE_SPAN);
    const gx = -500 * s + (2300 + 500) * s * gp;
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.translate(gx, H * 0.5);
    ctx.rotate((14 * Math.PI) / 180);
    const g = ctx.createLinearGradient(-180 * s, 0, 180 * s, 0);
    g.addColorStop(0, 'rgba(255, 255, 255, 0)');
    g.addColorStop(0.5, 'rgba(255, 255, 255, 0.72)');
    g.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(-180 * s, -H, 360 * s, H * 2);
    ctx.restore();
  }
  ctx.restore();

  // ---- 计数器：digit-roll，每落一张滚一格，单格 8f 滚定 ----
  const pos = (() => {
    let p = 0;
    for (let i = 0; i < CUES.length; i += 1) {
      const land = CUES[i] + FLY;
      const u = clamp01((time - land) / (8 / FPS));
      // bezier(0.25,0.8,0.25,1) 近似
      const roll = 1 - Math.pow(1 - u, 2.4);
      p += roll;
    }
    return p;
  })();
  const count = Math.round(pos);
  const micro = withMicro(time);
  ctx.save();
  ctx.translate(W * 0.5, H * 0.115);
  ctx.scale(micro, micro);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 数字带：双份 0-9 拼接下滚
  const lineH = H * 0.1;
  ctx.save();
  ctx.beginPath();
  ctx.rect(-W * 0.12, -lineH * 0.5, W * 0.24, lineH);
  ctx.clip();
  const seq = String(Math.floor(pos) % 10) + String((Math.floor(pos) + 1) % 10);
  const frac = pos - Math.floor(pos);
  ctx.fillStyle = '#3a3128';
  ctx.font = '800 ' + Math.round(H * 0.088) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText(seq[0], 0, -frac * lineH);
  ctx.fillText(seq[1], 0, (1 - frac) * lineH);
  ctx.restore();
  ctx.fillStyle = 'rgba(120, 108, 94, 0.8)';
  ctx.font = '600 ' + Math.round(H * 0.026) + 'px system-ui, sans-serif';
  ctx.fillText('ITEMS STACKED', 0, lineH * 0.72);
  ctx.restore();

  // 右上角 mono：真实计数（用来对照 digit-roll 的连续性）
  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(120, 108, 94, 0.55)';
  ctx.font = '500 ' + Math.round(H * 0.024) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('ROLL ' + pos.toFixed(2) + '  →  ' + count + ' / ' + CUES.length, W * 0.95, H * 0.06);
  ctx.restore();

  ctx.restore();
}

/** 预备拍：计数器先于首卡 4–6f 亮起 micro（0.96 → 1）。 */
function withMicro(time) {
  const u = clamp01((time - MICRO_AT) / 0.2);
  return 0.96 + 0.04 * outCubic(u);
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
