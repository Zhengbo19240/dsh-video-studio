/**
 * sc-hashtag-to-pill-materialize · 井号变胶囊（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/interaction/hashtag-to-pill-materialize.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权与归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实（骨架是「两次硬切夹一次滑动」，挪动任何一段的性质整卡就塌）：
 *   - 打字：#word 居中、红实心光标**恒亮不闪**（原片实测），人手节奏 4–6f/字带确定性抖动；
 *   - **实体化 = 1 帧硬切**：文字+光标整层消失，同帧出现无描边浅灰胶囊 + 图标 + 词
 *     （字号不变、原位等大，# 被图标替换），仅允许 3f 1.03→1 微落定；
 *   - 胶囊 hold 0.6s → 一段 bezier easeInOut 缩小左移（0.55x、14f），位置与缩放同曲线同起止；
 *   - 落位后再 1 帧硬切揭示成品页：底色/标题/正文/胶囊配色同帧全变，之后真静止。
 */

export const meta = {
  title: '井号变胶囊',
  duration: 3.6,
  source: 'shotcraft',
  sourcePath: 'references/shots/interaction/hashtag-to-pill-materialize.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const TYPE_START = 0.12;
const CUT1 = 40 / FPS;        // 1.333s：硬切实体化
const HOLD_END = 58 / FPS;    // 1.933s：hold 结束
const SHIFT_END = 72 / FPS;   // 2.4s：缩移结束
const CUT2 = 75 / FPS;        // 2.5s：硬切揭示
const TYPE_STEP = 5 / FPS;    // 4–6f/字

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
/** bezier(0.5, 0, 0.25, 1)：缩放与位移走同一条曲线，分开调会读作两个动画。 */
function bez(u) {
  const p = clamp01(u);
  let lo = 0;
  let hi = 1;
  let q = p;
  for (let i = 0; i < 16; i += 1) {
    const bx = 3 * (1 - q) * (1 - q) * q * 0.5 + 3 * (1 - q) * q * q * 0.25 + q * q * q;
    if (bx < p) lo = q;
    else hi = q;
    q = (lo + hi) / 2;
  }
  return 3 * (1 - q) * q * q * 1 + q * q * q;
}

function det(k) {
  return ((((k * 7 + 3) % 9) + 9) % 9 - 4) / 4; // ±1 的确定性抖动
}

/** 胶囊：无描边宽大浅灰 + 图标 + 词。绘制在原点，靠外层 transform 缩放（origin 0 0）。 */
function drawPill(ctx, pw, ph, word, src, dark) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(0, 0, pw, ph, ph / 2) : ctx.rect(0, 0, pw, ph);
  ctx.fillStyle = dark ? '#2a2d34' : '#e9e9ec';
  ctx.fill();
  ctx.restore();

  const pad = ph * 0.26;
  const iconR = ph * 0.24;
  const cy = ph / 2;

  // 图标：有素材就当胶囊头像，没素材就画一个话题图标（#）
  ctx.save();
  if (src) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(pad + iconR, cy, iconR, 0, Math.PI * 2);
    ctx.clip();
    const sw = src.width || iconR * 2;
    const sh = src.height || iconR * 2;
    const k = Math.max((iconR * 2) / sw, (iconR * 2) / sh);
    ctx.drawImage(src, pad + iconR - (sw * k) / 2, cy - (sh * k) / 2, sw * k, sh * k);
    ctx.restore();
  } else {
    ctx.fillStyle = dark ? '#3a3f48' : '#cfd0d6';
    ctx.beginPath();
    ctx.arc(pad + iconR, cy, iconR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = dark ? 'rgba(230,236,246,0.85)' : 'rgba(60,62,70,0.85)';
    ctx.lineWidth = Math.max(1.2, ph * 0.035);
    ctx.lineCap = 'round';
    for (let i = -1; i <= 1; i += 2) {
      ctx.beginPath();
      ctx.moveTo(pad + iconR + i * iconR * 0.42, cy - iconR * 0.72);
      ctx.lineTo(pad + iconR + i * iconR * 0.28, cy + iconR * 0.72);
      ctx.stroke();
    }
    for (let i = -1; i <= 1; i += 2) {
      ctx.beginPath();
      ctx.moveTo(pad + iconR - iconR * 0.72, cy + i * iconR * 0.34);
      ctx.lineTo(pad + iconR + iconR * 0.72, cy + i * iconR * 0.22);
      ctx.stroke();
    }
  }
  ctx.restore();

  // 词：字号不变、原位等大，# 已被图标替换
  ctx.save();
  ctx.fillStyle = dark ? 'rgba(238, 242, 250, 0.96)' : 'rgba(32, 34, 40, 0.94)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 ' + Math.round(ph * 0.46) + 'px system-ui, sans-serif';
  ctx.fillText(word, pad + iconR * 2 + ph * 0.18, cy);
  ctx.restore();
}

/** 成品页：底色/标题/正文/胶囊同帧全变（揭示是硬切，不是转场）。 */
function drawRevealedPage(ctx, w, h, src, word) {
  ctx.save();
  ctx.fillStyle = '#f6f4f0';
  ctx.fillRect(0, 0, w, h);
  const s = Math.min(w / 1280, h / 720);

  // 顶部栏
  ctx.fillStyle = '#1d1e22';
  ctx.fillRect(0, 0, w, h * 0.1);
  ctx.fillStyle = 'rgba(246, 244, 240, 0.9)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 ' + Math.round(h * 0.036) + 'px system-ui, sans-serif';
  ctx.fillText(String(word), w * 0.04, h * 0.052);

  // 大图：素材本身（笔记里的封面）
  const ix = w * 0.07;
  const iy = h * 0.17;
  const iw = w * 0.86;
  const ih = h * 0.44;
  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(ix, iy, iw, ih, h * 0.02);
  else ctx.rect(ix, iy, iw, ih);
  ctx.clip();
  if (src) {
    const sw = src.width || iw;
    const sh = src.height || ih;
    const k = Math.max(iw / sw, ih / sh);
    ctx.drawImage(src, ix + (iw - sw * k) / 2, iy + (ih - sh * k) / 2, sw * k, sh * k);
  } else {
    ctx.fillStyle = '#e2ded6';
    ctx.fillRect(ix, iy, iw, ih);
    ctx.strokeStyle = 'rgba(120, 112, 100, 0.5)';
    ctx.setLineDash([10 * s, 8 * s]);
    ctx.lineWidth = 2 * s;
    ctx.strokeRect(ix + 12 * s, iy + 12 * s, iw - 24 * s, ih - 24 * s);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(90, 84, 74, 0.8)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.round(h * 0.038) + 'px system-ui, sans-serif';
    ctx.fillText('成品页主图 = 素材', ix + iw / 2, iy + ih / 2 - h * 0.02);
    ctx.font = Math.round(h * 0.026) + 'px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(110, 102, 92, 0.75)';
    ctx.fillText('props.assetId 未给：这张卡会在揭示时把素材铺成封面', ix + iw / 2, iy + ih / 2 + h * 0.03);
  }
  ctx.restore();

  // 标题 + 正文
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#22232a';
  ctx.font = '700 ' + Math.round(h * 0.062) + 'px system-ui, sans-serif';
  ctx.fillText(String(word) + ' 主题聚合', w * 0.07, h * 0.71);
  ctx.fillStyle = 'rgba(60, 62, 70, 0.7)';
  ctx.font = Math.round(h * 0.032) + 'px system-ui, sans-serif';
  for (let i = 0; i < 2; i += 1) {
    ctx.fillRect(w * 0.07, h * (0.78 + i * 0.05), w * (0.7 - i * 0.16), h * 0.016);
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
  const src = id && m ? (m.video(id) || m.image(id)) : null;

  const word = String(props.word || '笔记方法');
  const s = Math.min(w / 1280, h / 720);
  const fs = Math.round(h * 0.13);

  if (time >= CUT2) {
    // 第二记硬切：成品页
    drawRevealedPage(ctx, w, h, src, word);
    return;
  }

  ctx.save();
  ctx.fillStyle = '#f4f2ee';
  ctx.fillRect(0, 0, w, h);

  // 胶囊几何：740×236@1080p → 按 h 归一
  const pwFull = h * 0.436 * 1.5;
  const phFull = h * 0.218 * 1.5;

  if (time < CUT1) {
    // ---- 打字段 ----
    const typed = Math.min(word.length, Math.max(0, Math.floor((time - TYPE_START) / TYPE_STEP) + 1));
    const shown = word.slice(0, Math.max(0, typed));
    // 打字时文字位置按最终胶囊的文字位置对齐（硬切时「字号不变、原位等大」）
    const px = w / 2 - pwFull / 2;
    const py = h / 2 - phFull / 2;
    const pad = phFull * 0.26;
    const iconR = phFull * 0.24;
    const textX = px + pad + iconR * 2 + phFull * 0.18;
    const baseY = h / 2;

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.round(phFull * 0.46) + 'px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(26, 28, 34, 0.94)';
    const hashW = ctx.measureText('#').width;
    ctx.fillText('#' + shown, textX, baseY);
    // 红实心光标：恒亮不闪
    const cursorX = textX + hashW + (shown ? ctx.measureText(shown).width : 0) + phFull * 0.03;
    ctx.fillStyle = '#e5352b';
    ctx.fillRect(cursorX, baseY - phFull * 0.27, Math.max(2, phFull * 0.055), phFull * 0.54);
    ctx.restore();

    // 打字期的极淡键盘提示（让人读出「在输入」，不抢主体）
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.strokeStyle = 'rgba(90, 92, 100, 0.5)';
    ctx.lineWidth = Math.max(1, 2 * s);
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(px, py, pwFull, phFull, phFull / 2) : ctx.rect(px, py, pwFull, phFull);
    ctx.setLineDash([8 * s, 10 * s]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  } else {
    // ---- 硬切后：胶囊 ----
    const settle = clamp01((time - CUT1) / (3 / FPS));
    const micro = 1.03 + (1 - 1.03) * outCubic(settle);
    const shiftU = clamp01((time - HOLD_END) / (SHIFT_END - HOLD_END));
    const e = bez(shiftU);
    // 落点：页面标签位（左上），0.55x
    const targetScale = 0.55;
    const targetX = w * 0.07;
    const targetY = h * 0.135;

    const scale = (1 * micro) * (1 + (targetScale - 1) * e);
    const pxStart = w / 2 - (pwFull * micro) / 2;
    const pyStart = h / 2 - (phFull * micro) / 2;
    const px = pxStart + (targetX - pxStart) * e;
    const py = pyStart + (targetY - pyStart) * e;

    // 落位后胶囊变深色（成品页配色），与揭示同帧衔接
    const darken = shiftU > 0.9 ? 1 : 0;
    ctx.save();
    ctx.translate(px, py);
    ctx.scale(scale / micro, scale / micro);
    drawPill(ctx, pwFull, phFull, word, src, darken === 1);
    ctx.restore();

    // hold 期：右下角一行小字说明「这一步是硬切」
    if (time < HOLD_END) {
      ctx.save();
      ctx.globalAlpha = clamp01((time - CUT1) / 0.12) * 0.55;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(90, 92, 100, 0.85)';
      ctx.font = '500 ' + Math.round(h * 0.026) + 'px ui-monospace, Menlo, monospace';
      ctx.fillText('1-FRAME HARD CUT → ENTITY', w / 2, h * 0.5 + phFull * 0.82);
      ctx.restore();
    }
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
