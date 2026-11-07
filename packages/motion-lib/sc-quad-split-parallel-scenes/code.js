/**
 * sc-quad-split-parallel-scenes · 四分割并行（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/rhythm/quad-split-parallel-scenes.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - 画面硬切 2×2 四宫格，四象限并行跑各自的微场景，**全程无转场**；
 *   - **错拍是灵魂**：TL tab 6/11/16/21 + 页面 44；TR 输出 27/33 + 急推 37；
 *     BL 词 14/30/49；BR 点击 25、变色 27、点击 52、通知 56 —— 相邻重事件 ≥3 帧，
 *     永远有东西在动但从不齐动；
 *   - 两处打字光标闪烁周期错开（16f vs 14f +5 相位），避免同闪；
 *   - 四格明度棋盘交错（奶油 / 暖黑 / 橙实底 / 拿铁），8px 暖黑缝 + 20px 圆角分格；
 *   - TR 的 37–47f whip 急推是全卡最重的一拍（scale 1.85 + sin 包络 blur 5px，旧行退到 8%）；
 *   - 62f 后四格停在终态拼成一张完整海报，hold 28f。
 *
 * 媒体怎么用：左上「浏览器象限」的页面区就是素材（视频帧）；其余三格是矢量微场景。
 */

export const meta = {
  title: '四分割并行',
  duration: 3.6,
  source: 'shotcraft',
  sourcePath: 'references/shots/rhythm/quad-split-parallel-scenes.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const HOLD_AT = 62 / FPS;
const GUTTER = 8;
const RADIUS = 20;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const inQuad = (x) => clamp01(x) * clamp01(x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
function backOut(u) {
  const p = clamp01(u);
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
}

function clipPane(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, RADIUS) : ctx.rect(x, y, w, h);
  ctx.clip();
}

/** 打字光标：两处周期刻意错开（16f vs 14f + 5 相位），避免同闪。 */
function caretOn(time, periodFrames, phaseFrames) {
  return ((time * FPS + phaseFrames) % periodFrames) < periodFrames * 0.55;
}

/* ---------------- TL：浏览器 tab 弹入 + 地址栏打字 + 页面载入 ---------------- */
function paneTL(ctx, x, y, w, h, time, src) {
  ctx.save();
  ctx.fillStyle = '#f7eee4';
  ctx.fillRect(x, y, w, h);
  clipPane(ctx, x, y, w, h);

  // 慢推 1→1.1（origin 50% 90%）：静格也不静
  const push = 1 + 0.1 * inQuad(clamp01(time / 2.4));
  ctx.translate(x + w * 0.5, y + h * 0.9);
  ctx.scale(push, push);
  ctx.translate(-(x + w * 0.5), -(y + h * 0.9));

  // 浏览器 chrome
  ctx.fillStyle = '#e9dccd';
  ctx.fillRect(x, y, w, h * 0.16);

  // 四个 tab：6/11/16/21f 依次 overshoot 弹入
  const tabCues = [6, 11, 16, 21].map((f) => f / FPS);
  for (let i = 0; i < 4; i += 1) {
    const u = clamp01((time - tabCues[i]) / 0.2);
    if (u <= 0) continue;
    const tw = w * 0.17;
    const th = h * 0.085;
    const tx = x + w * 0.03 + i * (tw + w * 0.012);
    const ty = y + h * 0.045;
    const sc = 0.6 + 0.4 * backOut(u);
    ctx.save();
    ctx.translate(tx + tw / 2, ty + th / 2);
    ctx.scale(sc, sc * 0.96 + 0.04);
    ctx.translate(-(tx + tw / 2), -(ty + th / 2));
    ctx.fillStyle = i === 3 ? '#fffdf9' : '#dccdba';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(tx, ty, tw, th, th * 0.22) : ctx.rect(tx, ty, tw, th);
    ctx.fill();
    ctx.fillStyle = 'rgba(90, 74, 58, 0.55)';
    ctx.fillRect(tx + tw * 0.12, ty + th * 0.34, tw * 0.5, th * 0.26);
    ctx.restore();
  }

  // 地址栏：逐字打字（20 字符 / 0–40f）
  const url = 'shotcraft.studio/library';
  const typed = Math.floor(clamp01(time / (40 / FPS)) * url.length);
  ctx.fillStyle = '#fffdf9';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x + w * 0.03, y + h * 0.185, w * 0.94, h * 0.07, h * 0.035) : ctx.rect(x + w * 0.03, y + h * 0.185, w * 0.94, h * 0.07);
  ctx.fill();
  ctx.fillStyle = 'rgba(72, 60, 48, 0.8)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '500 ' + Math.round(h * 0.036) + 'px ui-monospace, Menlo, monospace';
  const shown = url.slice(0, typed);
  ctx.fillText(shown, x + w * 0.05, y + h * 0.221);
  if (caretOn(time, 16, 0)) {
    ctx.fillStyle = 'rgba(200, 96, 60, 0.9)';
    const cw = ctx.measureText(shown).width;
    ctx.fillRect(x + w * 0.05 + cw + 2, y + h * 0.198, Math.max(1.5, w * 0.004), h * 0.045);
  }

  // 页面载入：44f 大标题自下滑入
  const loadP = outCubic(clamp01((time - 44 / FPS) / (14 / FPS)));
  const pageY = y + h * 0.32;
  ctx.save();
  ctx.globalAlpha = clamp01(loadP * 1.5);
  ctx.translate(0, (1 - loadP) * h * 0.1);
  if (src) {
    const sw = src.width || w;
    const sh = src.height || h;
    const k = Math.max((w * 0.86) / sw, (h * 0.34) / sh);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x + w * 0.07, pageY, w * 0.86, h * 0.34, h * 0.02) : ctx.rect(x + w * 0.07, pageY, w * 0.86, h * 0.34);
    ctx.clip();
    ctx.drawImage(src, x + w * 0.07 + (w * 0.86 - sw * k) / 2, pageY + (h * 0.34 - sh * k) / 2, sw * k, sh * k);
    ctx.restore();
  } else {
    ctx.fillStyle = '#e2d6c6';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x + w * 0.07, pageY, w * 0.86, h * 0.34, h * 0.02) : ctx.rect(x + w * 0.07, pageY, w * 0.86, h * 0.34);
    ctx.fill();
    ctx.strokeStyle = 'rgba(140, 116, 92, 0.55)';
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(104, 86, 68, 0.85)';
    ctx.textAlign = 'center';
    ctx.font = '600 ' + Math.round(h * 0.052) + 'px system-ui, sans-serif';
    ctx.fillText('页面截图 = 素材', x + w * 0.5, pageY + h * 0.15);
    ctx.font = Math.round(h * 0.036) + 'px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(130, 110, 90, 0.75)';
    ctx.fillText('props.assetId', x + w * 0.5, pageY + h * 0.24);
  }
  ctx.fillStyle = '#3f3327';
  ctx.textAlign = 'left';
  ctx.font = '800 ' + Math.round(h * 0.1) + 'px system-ui, sans-serif';
  ctx.fillText('Launch film.', x + w * 0.07, pageY + h * 0.48);
  ctx.restore();

  ctx.restore();
}

/* ---------------- TR：终端打字 + 37f whip 急推 ---------------- */
function paneTR(ctx, x, y, w, h, time, src) {
  ctx.save();
  ctx.fillStyle = '#160d09';
  ctx.fillRect(x, y, w, h);
  clipPane(ctx, x, y, w, h);

  const whip = clamp01((time - 37 / FPS) / (10 / FPS));
  const scale = 1 + 0.85 * easeWhip(whip);
  const blur = Math.sin(clamp01(whip) * Math.PI) * 5;

  ctx.save();
  ctx.translate(x + w * 0.5, y + h * 0.5);
  ctx.scale(scale, scale);
  ctx.translate(-(x + w * 0.5), -(y + h * 0.5));
  if (blur > 0.2 && typeof ctx.filter === 'string') ctx.filter = 'blur(' + blur.toFixed(2) + 'px)';

  const lines = ['$ npm run render', 'rendering 1–240 frames', 'promo.mp4 ready'];
  const cues = [0, 27 / FPS, 33 / FPS];
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '500 ' + Math.round(h * 0.045) + 'px ui-monospace, Menlo, monospace';
  for (let i = 0; i < lines.length; i += 1) {
    const u = clamp01((time - cues[i]) / (10 / FPS));
    if (u <= 0 && i > 0) continue;
    // 急推后旧行退到 8%
    const faded = i < 2 ? 1 - 0.92 * clamp01((time - 37 / FPS) / (6 / FPS)) : 1;
    const text = i === 0 ? lines[0].slice(0, Math.floor(clamp01(time / (24 / FPS)) * lines[0].length)) : lines[i];
    ctx.globalAlpha = (i === 0 ? 1 : clamp01(u * 1.6)) * faded;
    ctx.fillStyle = i === 2 ? '#8ef0b8' : i === 0 ? 'rgba(240, 226, 210, 0.9)' : 'rgba(214, 196, 178, 0.8)';
    ctx.fillText(text, x + w * 0.06, y + h * (0.26 + i * 0.16));
  }
  // 光标（14f 周期 + 5 相位）
  if (caretOn(time, 14, 5)) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#c6f432';
    ctx.fillRect(x + w * 0.06, y + h * (0.26 + 3 * 0.16) - h * 0.02, w * 0.035, h * 0.045);
  }
  if (typeof ctx.filter === 'string') ctx.filter = 'none';
  ctx.restore();

  // 顶栏：目录 + 状态灯
  ctx.fillStyle = 'rgba(60, 30, 20, 0.85)';
  ctx.fillRect(x, y, w, h * 0.1);
  ctx.fillStyle = 'rgba(220, 186, 158, 0.7)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 ' + Math.round(h * 0.034) + 'px system-ui, sans-serif';
  ctx.fillText('~/shotcraft', x + w * 0.04, y + h * 0.052);
  void src;

  ctx.restore();
}

function easeWhip(u) {
  // 急推：起步猛、末段制动
  const p = clamp01(u);
  return 1 - Math.pow(1 - p, 2.6);
}

/* ---------------- BL：三个大词逐个 overshoot 砸入 ---------------- */
function paneBL(ctx, x, y, w, h, time) {
  ctx.save();
  ctx.fillStyle = '#ff8330';
  ctx.fillRect(x, y, w, h);
  clipPane(ctx, x, y, w, h);
  const words = ['Prompt.', 'Render.', 'Ship.'];
  const cues = [14 / FPS, 30 / FPS, 49 / FPS];
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '800 ' + Math.round(h * 0.24) + 'px system-ui, sans-serif';
  for (let i = 0; i < words.length; i += 1) {
    const u = clamp01((time - cues[i]) / (0.24));
    if (u <= 0) continue;
    const sc = 0.72 + 0.28 * backOut(u);
    ctx.save();
    ctx.globalAlpha = clamp01(u * 1.8);
    ctx.translate(x + w * 0.09, y + h * (0.24 + i * 0.26));
    ctx.scale(sc, sc);
    ctx.fillStyle = 'rgba(24, 14, 8, 0.94)';
    ctx.fillText(words[i], 0, 0);
    ctx.restore();
  }
  // 右下角小编号（节奏参照）
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = 'rgba(40, 22, 12, 0.9)';
  ctx.textAlign = 'right';
  ctx.font = '600 ' + Math.round(h * 0.032) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('BEAT 14 / 30 / 49', x + w * 0.94, y + h * 0.92);
  ctx.restore();
  ctx.restore();
}

/* ---------------- BR：审批卡滑入 + 光标点击链 + 通知 ---------------- */
function paneBR(ctx, x, y, w, h, time) {
  ctx.save();
  ctx.fillStyle = '#e9d7c4';
  ctx.fillRect(x, y, w, h);
  clipPane(ctx, x, y, w, h);

  // 审批卡滑入（4f 起）
  const cardU = outCubic(clamp01((time - 4 / FPS) / (0.3)));
  ctx.save();
  ctx.translate(0, (1 - cardU) * h * 0.16);
  ctx.globalAlpha = clamp01(cardU * 1.4);
  const cx = x + w * 0.08;
  const cy = y + h * 0.14;
  const cw = w * 0.84;
  const ch = h * 0.34;
  ctx.fillStyle = '#fffaf3';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(cx, cy, cw, ch, h * 0.03) : ctx.rect(cx, cy, cw, ch);
  ctx.fill();
  ctx.fillStyle = 'rgba(70, 54, 40, 0.9)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '700 ' + Math.round(h * 0.06) + 'px system-ui, sans-serif';
  ctx.fillText('Ship to production?', cx + cw * 0.05, cy + ch * 0.3);
  ctx.fillStyle = 'rgba(130, 110, 92, 0.85)';
  ctx.font = Math.round(h * 0.038) + 'px system-ui, sans-serif';
  ctx.fillText('1,214 visitors today', cx + cw * 0.05, cy + ch * 0.62);

  // 两个按钮：27f 起 Approved 变色
  const approved = time >= 27 / FPS;
  const btnW = cw * 0.38;
  const btnH = ch * 0.34;
  const by = cy + ch * 0.66;
  ctx.fillStyle = approved ? '#22c07a' : 'rgba(58, 46, 36, 0.9)';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(cx + cw * 0.05, by, btnW, btnH, btnH * 0.4) : ctx.rect(cx + cw * 0.05, by, btnW, btnH);
  ctx.fill();
  ctx.fillStyle = '#fffaf3';
  ctx.textAlign = 'center';
  ctx.font = '700 ' + Math.round(h * 0.038) + 'px system-ui, sans-serif';
  ctx.fillText(approved ? 'Approved' : 'Approve', cx + cw * 0.05 + btnW / 2, by + btnH / 2);

  ctx.fillStyle = time >= 52 / FPS ? '#2b6fff' : 'rgba(200, 186, 170, 0.55)';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(cx + cw * 0.5, by, btnW, btnH, btnH * 0.4) : ctx.rect(cx + cw * 0.5, by, btnW, btnH);
  ctx.fill();
  ctx.fillStyle = time >= 52 / FPS ? '#fff' : 'rgba(70, 58, 46, 0.7)';
  ctx.fillText('Publish', cx + cw * 0.5 + btnW / 2, by + btnH / 2);
  ctx.restore();

  // 光标：14f 起巡游 → 25f 点到 Approve → 38f 二段 → 52f 点 Publish
  const cursor = cursorPath(time, { cx, cy, cw, ch, btnW, btnH, by });
  ctx.save();
  ctx.fillStyle = 'rgba(20, 14, 10, 0.92)';
  ctx.beginPath();
  const px = cursor.x;
  const py = cursor.y;
  ctx.moveTo(px, py);
  ctx.lineTo(px + h * 0.028, py + h * 0.062);
  ctx.lineTo(px + h * 0.012, py + h * 0.06);
  ctx.lineTo(px + h * 0.02, py + h * 0.085);
  ctx.lineTo(px, py + h * 0.09);
  ctx.closePath();
  ctx.fill();
  // 点击涟漪
  for (const clickAt of [25 / FPS, 52 / FPS]) {
    const since = time - clickAt;
    if (since >= 0 && since < 0.22) {
      const k = since / 0.22;
      ctx.save();
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = 'rgba(40, 28, 20, 0.7)';
      ctx.lineWidth = Math.max(1.4, h * 0.006);
      ctx.beginPath();
      ctx.arc(cursor.clickX || px, cursor.clickY || py, h * (0.02 + k * 0.06), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();

  // 通知：56f overshoot 弹出
  const notifU = clamp01((time - 56 / FPS) / 0.26);
  if (notifU > 0) {
    const sc = 0.7 + 0.3 * backOut(notifU);
    const nx = x + w * 0.16;
    const ny = y + h * 0.68;
    const nw = w * 0.68;
    const nh = h * 0.16;
    ctx.save();
    ctx.translate(nx + nw / 2, ny + nh / 2);
    ctx.scale(sc, sc);
    ctx.translate(-(nx + nw / 2), -(ny + nh / 2));
    ctx.globalAlpha = clamp01(notifU * 1.6);
    ctx.fillStyle = '#1f1a16';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(nx, ny, nw, nh, nh * 0.34) : ctx.rect(nx, ny, nw, nh);
    ctx.fill();
    ctx.fillStyle = 'rgba(238, 230, 220, 0.94)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.round(h * 0.042) + 'px system-ui, sans-serif';
    ctx.fillText('Live · 3,214 views', nx + nw * 0.07, ny + nh * 0.5);
    ctx.fillStyle = '#22c07a';
    ctx.beginPath();
    ctx.arc(nx + nw * 0.93, ny + nh * 0.5, nh * 0.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

/** 光标贝塞尔巡游：14f 起，25f 点击，38f 二段，52f 点击。 */
function cursorPath(time, b) {
  const target1 = { x: b.cx + b.cw * 0.24, y: b.by + b.btnH * 0.55 };
  const target2 = { x: b.cx + b.cw * 0.7, y: b.by + b.btnH * 0.55 };
  const start = { x: b.cx + b.cw * 0.9, y: b.cy + b.ch * 0.9 };
  const seg = (from, to, a, c) => {
    const u = clamp01((time - a) / (c - a));
    const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    // 弧线：中点抬一点
    return {
      x: from.x + (to.x - from.x) * e,
      y: from.y + (to.y - from.y) * e - Math.sin(e * Math.PI) * b.ch * 0.12,
    };
  };
  const p1 = seg(start, target1, 14 / FPS, 25 / FPS);
  const p2 = seg(target1, target2, 38 / FPS, 52 / FPS);
  const pos = time < 25 / FPS ? p1 : (time < 38 / FPS ? target1 : p2);
  return { x: pos.x, y: pos.y, clickX: pos.x, clickY: pos.y };
}

function __renderInner(ctx, t, env) {
  const W = Number(env && env.width) || 1;
  const H = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const time = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
  const m = env && env.media;
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);
  const src = id && m ? (m.video(id) || m.image(id)) : null;

  ctx.save();
  // 硬切分格：8px 暖黑缝
  ctx.fillStyle = '#140d09';
  ctx.fillRect(0, 0, W, H);

  const gw = (W - GUTTER * 3) / 2;
  const gh = (H - GUTTER * 3) / 2;
  const x0 = GUTTER;
  const y0 = GUTTER;
  const x1 = GUTTER * 2 + gw;
  const y1 = GUTTER * 2 + gh;

  // 四格按棋盘明度交错：奶油 / 暖黑 / 橙实底 / 拿铁
  paneTL(ctx, x0, y0, gw, gh, time, src);
  paneTR(ctx, x1, y0, gw, gh, time, src);
  paneBL(ctx, x0, y1, gw, gh, time);
  paneBR(ctx, x1, y1, gw, gh, time);

  // 收尾：62f 后四格停在终态，拼成一张完整海报（只留一层极淡的统一底光）
  if (time > HOLD_AT) {
    const k = clamp01((time - HOLD_AT) / 0.3);
    ctx.save();
    ctx.globalAlpha = 0.06 * k;
    ctx.fillStyle = '#fff3e2';
    ctx.fillRect(0, 0, W, H);
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
