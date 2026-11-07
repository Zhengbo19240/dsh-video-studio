/**
 * sc-word-relay-filmstrip · 词接力胶片条（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/typography/word-relay-filmstrip.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实（两个命门）：
 *   1. **步进制**：左列平时完全静止，只在切词瞬间滚动一格（滚动 = 换证据的机械动作）；
 *      持续滚动会让左列沦为背景装饰、切词失去「咔哒」感；
 *   2. **对齐**：大词块垂直中心必须与当前页面卡中点**精确对齐**（差 >8px 可感），
 *      歪了整个版式的「编辑部严谨感」就塌了。
 *   - 左列等高页面卡黑白相间（不等高/同色系读不出步进）；
 *   - 景深：dist = |卡点 - 焦点| / 归一，邻卡压暗 0.68·dist、缩到 0.94、虚化 ≤3px；
 *   - 右侧衬线两行：名词正体次级墨恒定，动词斜体白字原位接力 ——
 *     旧词 10f 灰化 → 切点起 8f ease-in 从遮罩上沿升出（先出）；
 *     新词切点 +7f 起逐字母从遮罩下沿升起（1.2f 错峰，金色句点最后到，后进）；
 *     **先出后进不许叠影**（判例：叠影「resebuilds」被抓）。
 */

export const meta = {
  title: '词接力胶片条',
  duration: 4.0,
  source: 'shotcraft',
  sourcePath: 'references/shots/typography/word-relay-filmstrip.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(props.assetId)];
}

const FPS = 30;
const WORD_SPAN = 45 / FPS;     // 词期 ~45f
const VERBS = ['frames', 'builds', 'ships'];
const NOUN = 'Shotcraft';
const SCROLL_DUR = 18 / FPS;    // 滚动窗口 16–18f

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const inOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

/** 当前词索引与切点时刻。 */
function relayAt(time) {
  const idx = Math.min(VERBS.length - 1, Math.floor(time / WORD_SPAN));
  const cut = idx * WORD_SPAN;
  return { idx, cut };
}

/** 左列滚动位移：只在切词瞬间滚一格（其余时间零位移）。 */
function scrollOffset(time, cut, cardH, idx) {
  const u = clamp01((time - cut) / SCROLL_DUR);
  // 不对称 in-out（EASE.swift）：起步快、尾段制动
  const e = inOut(Math.pow(u, 0.72));
  return (idx + e) * cardH;
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
  const gold = 'rgba(212, 176, 106, 1)';
  const { idx, cut } = relayAt(time);

  // 舞台：graphite 近单色暗场 + 金色点缀
  ctx.save();
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#17181c');
  bg.addColorStop(0.55, '#111216');
  bg.addColorStop(1, '#0a0b0e');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const topLight = ctx.createRadialGradient(W * 0.3, -H * 0.1, 0, W * 0.3, -H * 0.1, H * 1.1);
  topLight.addColorStop(0, 'rgba(214, 196, 160, 0.1)');
  topLight.addColorStop(1, 'rgba(214, 196, 160, 0)');
  ctx.fillStyle = topLight;
  ctx.fillRect(0, 0, W, H);

  // ---- 左列：等高页面卡，黑白相间 ----
  const cardW = W * 0.5;
  const cardH = H * 0.49;              // 530/1080 的比例
  const gap = H * 0.097;               // 105/1080
  const step = cardH + gap;
  const colX = W * 0.045;
  const focusY = H * 0.5;              // 焦点卡中点（= 540/1080）
  const shift = scrollOffset(time, cut, step, idx);
  const speed = Math.abs(scrollOffset(time + 1 / FPS, cut, step, idx) - shift);
  const blurPx = Math.min(4, speed * 40);

  const total = VERBS.length + 2;
  for (let i = 0; i < total; i += 1) {
    const y = focusY - cardH / 2 + (i - shift) * step;
    if (y > H + cardH || y + cardH < -cardH) continue;
    // 景深：dist = |卡中点 - 焦点| / (卡高 + gap)
    const dist = Math.abs((y + cardH / 2) - focusY) / step;
    const dim = 0.68 * dist;
    const scale = 1 - 0.06 * clamp01(dist);
    const cardBlur = Math.min(3, dist * 1.4);

    ctx.save();
    ctx.globalAlpha = clamp01(1 - dim * 0.9);
    if (cardBlur > 0.3 && typeof ctx.filter === 'string') ctx.filter = 'blur(' + cardBlur.toFixed(2) + 'px)';
    if (blurPx > 0.6) {
      // 快段叠纵向运动模糊
      ctx.save();
      ctx.translate(colX + cardW / 2, y + cardH / 2);
      ctx.scale(scale, scale);
      ctx.translate(-(colX + cardW / 2), -(y + cardH / 2));
      ctx.globalAlpha *= 0.3;
      ctx.fillStyle = 'rgba(30, 30, 34, 1)';
      ctx.fillRect(colX, y - blurPx, cardW, cardH + blurPx * 2);
      ctx.restore();
    }
    ctx.translate(colX + cardW / 2, y + cardH / 2);
    ctx.scale(scale, scale);
    ctx.translate(-(colX + cardW / 2), -(y + cardH / 2));

    // 黑白相间：强对比是「步进」的证据
    const isLight = i % 2 === 0;
    ctx.fillStyle = isLight ? '#f2efe8' : '#22242a';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(colX, y, cardW, cardH, cardW * 0.012) : ctx.rect(colX, y, cardW, cardH);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(colX, y, cardW, cardH, cardW * 0.012) : ctx.rect(colX, y, cardW, cardH);
    ctx.clip();
    if (src) {
      const sw = src.width || cardW;
      const sh = src.height || cardH;
      const cwid = sw * 0.7;
      const chgt = sh * 0.62;
      const sx = ((i * 0.29) % 1) * (sw - cwid);
      const sy = ((i * 0.37) % 1) * (sh - chgt);
      const k = Math.max(cardW / cwid, cardH / chgt);
      ctx.globalAlpha = isLight ? 0.95 : 0.86;
      ctx.drawImage(src, sx, sy, cwid, chgt, colX + (cardW - cwid * k) / 2, y + (cardH - chgt * k) / 2, cwid * k, chgt * k);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = isLight ? 'rgba(150, 140, 124, 0.2)' : 'rgba(120, 126, 140, 0.18)';
      ctx.fillRect(colX + cardW * 0.06, y + cardH * 0.1, cardW * 0.42, cardH * 0.1);
      for (let r = 0; r < 4; r += 1) {
        ctx.fillStyle = isLight ? 'rgba(140, 128, 110, 0.14)' : 'rgba(150, 158, 176, 0.12)';
        ctx.fillRect(colX + cardW * 0.06, y + cardH * (0.28 + r * 0.15), cardW * (0.84 - r * 0.1), cardH * 0.07);
      }
      if (!src && i === 0) {
        ctx.fillStyle = isLight ? 'rgba(90, 80, 66, 0.8)' : 'rgba(210, 200, 180, 0.8)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = '600 ' + Math.round(cardH * 0.05) + 'px system-ui, sans-serif';
        ctx.fillText('页面证据卡 · props.assetId', colX + cardW * 0.06, y + cardH * 0.9);
      }
    }
    ctx.restore();
    ctx.strokeStyle = isLight ? 'rgba(60, 56, 48, 0.2)' : 'rgba(220, 214, 200, 0.12)';
    ctx.lineWidth = Math.max(1, 1.4 * s);
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(colX, y, cardW, cardH, cardW * 0.012) : ctx.rect(colX, y, cardW, cardH);
    ctx.stroke();
    ctx.restore();
    if (typeof ctx.filter === 'string') ctx.filter = 'none';

    // 焦点卡的金色角标：证明「哪一张是证据」
    if (dist < 0.35) {
      ctx.save();
      ctx.fillStyle = gold;
      ctx.fillRect(colX + cardW - cardW * 0.02, y + cardH * 0.08, Math.max(2, cardW * 0.006), cardH * 0.22);
      ctx.restore();
    }
  }

  // ---- 右侧：衬线两行（名词恒定 / 动词接力）----
  const blockCenterY = focusY;
  const rightX = W * 0.62;
  // 右列必须完整在画内：按「可用宽度 / 实测字宽」收字号（衬线体比无衬线宽）
  const avail = W * 0.97 - rightX;
  const fitFont = (size, text, weight, italic) => {
    ctx.save();
    ctx.font = (italic ? 'italic ' : '') + weight + ' ' + size + 'px Georgia, "Times New Roman", serif';
    const wpx = ctx.measureText(String(text)).width;
    ctx.restore();
    return wpx > avail ? Math.max(10, Math.floor((size * avail) / wpx)) : size;
  };
  const verbFont = fitFont(Math.round(H * 0.194), String(props.verb || NOUN), 400, true);
  const nounFont = fitFont(Math.round(H * 0.155), String(props.noun || NOUN), 400, false);

  // 名词（正体次级墨）
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '400 ' + nounFont + 'px Georgia, "Times New Roman", serif';
  ctx.fillStyle = 'rgba(176, 170, 156, 0.92)';
  ctx.fillText(String(props.noun || NOUN), rightX, blockCenterY - verbFont * 0.52);
  ctx.restore();

  // 动词：旧词灰化升出（先出）→ 新词逐字母从下沿升起（后进），不叠影
  const prevIdx = Math.max(0, idx - 1);
  const settled = time - cut;

  // 旧词：切点起 8f ease-in 从遮罩上沿升出；之前 10f 灰化
  if (idx > 0) {
    const grayU = clamp01((time - (cut - 10 / FPS)) / (10 / FPS));
    const outU = clamp01(settled / (8 / FPS));
    if (outU < 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rightX - W * 0.02, blockCenterY - verbFont * 0.62, W * 0.4, verbFont * 0.72);
      ctx.clip();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = 'italic 400 ' + verbFont + 'px Georgia, "Times New Roman", serif';
      ctx.fillStyle = 'rgba(' + Math.round(232 - 120 * grayU) + ',' + Math.round(230 - 120 * grayU) + ',' + Math.round(224 - 116 * grayU) + ', 0.95)';
      ctx.fillText(VERBS[prevIdx], rightX, blockCenterY + verbFont * 0.18 - outU * verbFont * 0.9);
      ctx.restore();
    }
  }

  // 新词：切点 +7f 起逐字母升起（1.2f 错峰，金色句点最后到）
  const newAt = cut + 7 / FPS;
  const verb = String(props.verb || VERBS[idx]);
  const chars = Array.from(verb);
  ctx.save();
  ctx.beginPath();
  ctx.rect(rightX - W * 0.02, blockCenterY - verbFont * 0.42, W * 0.42, verbFont * 0.92);
  ctx.clip();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = 'italic 400 ' + verbFont + 'px Georgia, "Times New Roman", serif';
  let cx = rightX;
  for (let i = 0; i < chars.length; i += 1) {
    const at = newAt + (i * 1.2) / FPS;
    const p = outCubic(clamp01((time - at) / (16 / FPS)));
    const cw = ctx.measureText(chars[i]).width;
    if (p > 0) {
      ctx.save();
      ctx.globalAlpha = clamp01(p * 1.5);
      ctx.fillStyle = 'rgba(246, 244, 238, 0.98)';
      // 从遮罩下沿升起
      ctx.fillText(chars[i], cx, blockCenterY + verbFont * 0.18 + (1 - p) * verbFont * 0.9);
      ctx.restore();
    }
    cx += cw;
  }
  // 金色句点最后到
  const dotP = outCubic(clamp01((time - (newAt + chars.length * 1.2 / FPS)) / (0.2)));
  if (dotP > 0) {
    ctx.save();
    ctx.globalAlpha = dotP;
    ctx.fillStyle = gold;
    ctx.beginPath();
    ctx.arc(cx + verbFont * 0.05, blockCenterY + verbFont * 0.18, Math.max(2, verbFont * 0.045), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  // ---- 金色引线：从焦点卡右缘指向词块中线；切词起 6f 收回、切点 +10f 后 16f 重画 ----
  {
    const retractA = cut;
    const redrawA = cut + 10 / FPS;
    let drawK = 1;
    if (time >= retractA && time < redrawA) {
      drawK = 1 - clamp01((time - retractA) / (6 / FPS));
    } else if (time >= redrawA) {
      drawK = clamp01((time - redrawA) / (16 / FPS));
    }
    if (drawK > 0) {
      const x0 = colX + cardW;
      const y0 = blockCenterY;
      const x1 = rightX - W * 0.024;
      ctx.save();
      ctx.globalAlpha = 0.7 * drawK;
      ctx.strokeStyle = gold;
      ctx.lineWidth = Math.max(1, 1.6 * s);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + (x1 - x0) * drawK, y0);
      ctx.stroke();
      // 端点小圆
      ctx.fillStyle = gold;
      ctx.beginPath();
      ctx.arc(x0 + (x1 - x0) * drawK, y0, Math.max(1.6, 2.4 * s), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // mono 序号 + 32px 证据注脚（随动词同步接力）
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = gold;
  ctx.font = '500 ' + Math.round(H * 0.024) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText(String(idx + 1).padStart(2, '0') + ' / ' + String(VERBS.length).padStart(2, '0'), rightX, blockCenterY - verbFont * 0.82);
  const capP = outCubic(clamp01((time - newAt) / (20 / FPS)));
  ctx.globalAlpha = capP;
  ctx.fillStyle = 'rgba(178, 172, 158, 0.9)';
  ctx.font = '400 ' + fitFont(Math.round(H * 0.044), String(props.caption || 'the same page, doing a different job'), 400, false) + 'px Georgia, serif';
  ctx.fillText(String(props.caption || 'the same page, doing a different job'), rightX, blockCenterY + verbFont * 0.72);
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
