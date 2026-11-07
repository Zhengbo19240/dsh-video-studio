/**
 * sc-icon-field-colorize · 图标场着色（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/opening/icon-field-colorize.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权与归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - 17×10 键帽图标场（暗场里灰阶 = 「还没通电」的深色键帽：发丝边 + 顶沿受光 + 暗灰字形）；
 *   - 浮现 10 批错峰、按离中心距离 + 确定性噪声分组（读作从中心向外铺开），
 *     每枚 0.6→1.06→1 微弹 + 上浮 10px；静置一拍后最后 10f 整场压暗 12% 蓄力；
 *   - **翻色不是同帧硬翻**：4 道同色系色波按行推进（行差 1.4f + 列微倾 0.25f + 每图标抖动），
 *     波前沿斜切；单枚翻色 4f 新色自上而下 clip 灌满 + 1.22x 正弦 pop + 5f 白闪；
 *   - 光溢出：每行亮起后身后舞台染上同色横向光带；
 *   - 落版：中心径向暗幕 + 眉题 + 两行大标题逐词升起（第二行不超暗幕宽度）。
 *
 * 媒体怎么用：中央 3×2 的键帽不放字形，改为素材缩略图 —— 着色波扫过后它们「通电」亮起，
 * 是这张卡唯一需要真实像素的地方。
 */

export const meta = {
  title: '图标场着色',
  duration: 4.2,
  source: 'shotcraft',
  sourcePath: 'references/shots/opening/icon-field-colorize.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const COLS = 17;
const ROWS = 10;
/** 字形种类数（旧版是 8，170 个键帽按索引取模就能看出循环）。 */
const SHAPES = 14;
const BATCHES = 10;
const BATCH_STEP = 4.4 / FPS;
const REVEAL_SPAN = 48 / FPS;
const DARK_AT = REVEAL_SPAN + 0.06;   // 静置一拍后蓄力
const WAVE_START = DARK_AT + 10 / FPS;
const WAVE_SPAN = 30 / FPS;
const ROW_DELTA = 1.4 / FPS;
const TITLE_AT = WAVE_START + WAVE_SPAN;

/** 4 道同色系（金 → 琥珀 → 橙 → 珊瑚红），不是跨色相彩虹。 */
const WAVES = [
  { startRow: 0, color: '#ffd479', glow: 'rgba(255, 212, 121,' },
  { startRow: 2, color: '#ffb04a', glow: 'rgba(255, 176, 74,' },
  { startRow: 5, color: '#ff8330', glow: 'rgba(255, 131, 48,' },
  { startRow: 7, color: '#ff5f5a', glow: 'rgba(255, 95, 90,' },
];

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const outBack = (x) => {
  const p = clamp01(x);
  const c = 1.7;
  return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
};

/** 确定性伪随机：分组/灰度/形状必须可复现。 */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let r = a;
    r = Math.imul(r ^ (r >>> 16), 0x21f0aaad);
    r = Math.imul(r ^ (r >>> 15), 0x735a2d97);
    return ((r ^ (r >>> 15)) >>> 0) / 4294967296;
  };
}

/**
 * 键帽字形方案（纯函数，测试直接用）。
 * 2026-11-06：旧版只有 8 种形状、170 个键帽按索引取模 —— 数到第八个就能看出循环。
 * 现在 14 种字形 × 4 种变体（14×4=56 种组合），形状由「列/行的错位 + 噪声」混合决定，
 * 再加四个灰阶，170 个键帽里同一组合最多出现个位数次。
 */
export function glyphPlan() {
  const count = COLS * ROWS;
  const rnd = seeded(0x51ce);
  const hashes = new Float32Array(count);
  const kinds = new Uint8Array(count);
  const variants = new Uint8Array(count);
  const grays = new Uint8Array(count);
  const combos = SHAPES * 4;
  for (let i = 0; i < count; i += 1) {
    hashes[i] = rnd();
    // 56 种组合按 37 步长在 170 个键位上轮转（37 与 56 互质 → 每 56 个一循环但相位/序号不同），
    // 再按行段错位一次：每种组合全场出现 3–4 次，相邻键位永远不同。
    const sig = (i * 37 + Math.floor(i / combos) * 13) % combos;
    kinds[i] = sig % SHAPES;
    variants[i] = Math.floor(sig / SHAPES) % 4;
    grays[i] = Math.floor(rnd() * 4);
  }
  return { count, hashes, kinds, variants, grays, shapes: SHAPES, variantCount: 4 };
}

/** 键帽上的字形：14 种极简功能字形 × 4 种变体（不是随机涂鸦，也不是 8 个循环）。 */
function glyph(ctx, kind, variant, cx, cy, r, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.2, r * 0.16);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const k = ((kind % SHAPES) + SHAPES) % SHAPES;
  ctx.beginPath();
  if (k === 0) {
    ctx.moveTo(cx - r * 0.6, cy);
    ctx.lineTo(cx + r * 0.6, cy);
    ctx.moveTo(cx + r * 0.24, cy - r * 0.36);
    ctx.lineTo(cx + r * 0.6, cy);
    ctx.lineTo(cx + r * 0.24, cy + r * 0.36);
    ctx.stroke();
  } else if (k === 1) {
    ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.16, 0, Math.PI * 2);
    ctx.fill();
  } else if (k === 2) {
    ctx.rect(cx - r * 0.52, cy - r * 0.4, r * 1.04, r * 0.8);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.52, cy - r * 0.1);
    ctx.lineTo(cx + r * 0.52, cy - r * 0.1);
    ctx.stroke();
  } else if (k === 3) {
    ctx.moveTo(cx - r * 0.5, cy + r * 0.42);
    ctx.lineTo(cx - r * 0.16, cy - r * 0.42);
    ctx.lineTo(cx + r * 0.18, cy + r * 0.42);
    ctx.lineTo(cx + r * 0.52, cy - r * 0.42);
    ctx.stroke();
  } else if (k === 4) {
    for (let i = -1; i <= 1; i += 1) {
      ctx.moveTo(cx - r * 0.55, cy + i * r * 0.34);
      ctx.lineTo(cx + r * 0.55, cy + i * r * 0.34);
    }
    ctx.stroke();
  } else if (k === 5) {
    ctx.moveTo(cx, cy - r * 0.5);
    ctx.lineTo(cx + r * 0.46, cy + r * 0.3);
    ctx.lineTo(cx - r * 0.46, cy + r * 0.3);
    ctx.closePath();
    ctx.stroke();
  } else if (k === 6) {
    ctx.arc(cx, cy, r * 0.48, Math.PI * 0.15, Math.PI * 1.55);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.14, 0, Math.PI * 2);
    ctx.fill();
  } else if (k === 7) {
    for (let i = 0; i < 3; i += 1) {
      ctx.moveTo(cx - r * 0.5, cy + (i - 1) * r * 0.38);
      ctx.lineTo(cx + r * 0.12, cy + (i - 1) * r * 0.38);
      ctx.moveTo(cx + r * 0.24, cy + (i - 1) * r * 0.38);
      ctx.lineTo(cx + r * 0.5, cy + (i - 1) * r * 0.38);
    }
    ctx.stroke();
  } else if (k === 8) {
    ctx.moveTo(cx - r * 0.5, cy);
    ctx.lineTo(cx + r * 0.5, cy);
    ctx.moveTo(cx, cy - r * 0.5);
    ctx.lineTo(cx, cy + r * 0.5);
    ctx.stroke();
  } else if (k === 9) {
    for (let i = 0; i < 4; i += 1) {
      const dx = i % 2 === 0 ? -1 : 1;
      const dy = i < 2 ? -1 : 1;
      ctx.rect(cx + dx * r * 0.44 - r * 0.16, cy + dy * r * 0.44 - r * 0.16, r * 0.32, r * 0.32);
    }
    ctx.stroke();
  } else if (k === 10) {
    // 钟形 / 通知
    ctx.moveTo(cx - r * 0.4, cy + r * 0.24);
    ctx.quadraticCurveTo(cx - r * 0.34, cy - r * 0.46, cx, cy - r * 0.46);
    ctx.quadraticCurveTo(cx + r * 0.34, cy - r * 0.46, cx + r * 0.4, cy + r * 0.24);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.34, r * 0.1, 0, Math.PI * 2);
    ctx.fill();
  } else if (k === 11) {
    // 图层：三层叠片
    for (let i = 0; i < 3; i += 1) {
      const yy = cy - r * 0.28 + i * r * 0.2;
      ctx.moveTo(cx - r * 0.5, yy);
      ctx.lineTo(cx, yy - r * 0.16);
      ctx.lineTo(cx + r * 0.5, yy);
      ctx.lineTo(cx, yy + r * 0.16);
      ctx.closePath();
    }
    ctx.stroke();
  } else if (k === 12) {
    // 气泡
    ctx.moveTo(cx - r * 0.5, cy - r * 0.34);
    ctx.lineTo(cx + r * 0.5, cy - r * 0.34);
    ctx.lineTo(cx + r * 0.5, cy + r * 0.2);
    ctx.lineTo(cx - r * 0.06, cy + r * 0.2);
    ctx.lineTo(cx - r * 0.26, cy + r * 0.46);
    ctx.lineTo(cx - r * 0.26, cy + r * 0.2);
    ctx.lineTo(cx - r * 0.5, cy + r * 0.2);
    ctx.closePath();
    ctx.stroke();
  } else {
    // 星芒
    for (let i = 0; i < 4; i += 1) {
      const a = (i * Math.PI) / 4;
      ctx.moveTo(cx - Math.cos(a) * r * 0.5, cy - Math.sin(a) * r * 0.5);
      ctx.lineTo(cx + Math.cos(a) * r * 0.5, cy + Math.sin(a) * r * 0.5);
    }
    ctx.stroke();
  }

  // 变体修饰：右上角小点 / 底部短线 / 左上角折角 / 外圈虚点
  const v = ((variant | 0) % 4 + 4) % 4;
  ctx.beginPath();
  if (v === 1) {
    ctx.arc(cx + r * 0.52, cy - r * 0.48, Math.max(1, r * 0.1), 0, Math.PI * 2);
    ctx.fill();
  } else if (v === 2) {
    ctx.moveTo(cx - r * 0.34, cy + r * 0.56);
    ctx.lineTo(cx + r * 0.34, cy + r * 0.56);
    ctx.stroke();
  } else if (v === 3) {
    ctx.moveTo(cx - r * 0.56, cy - r * 0.36);
    ctx.lineTo(cx - r * 0.36, cy - r * 0.56);
    ctx.moveTo(cx - r * 0.56, cy - r * 0.36);
    ctx.lineTo(cx - r * 0.56, cy - r * 0.2);
    ctx.stroke();
  } else {
    ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
    ctx.globalAlpha = 0.32;
    ctx.setLineDash([Math.max(1, r * 0.1), Math.max(1.4, r * 0.14)]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/** 某一行在翻色波里的时间偏移（行差 + 列微倾由列号补齐）。 */
function waveTimeFor(row, col, w) {
  return ROW_DELTA * row + 0.25 / FPS * col + (w.hashes[row * COLS + col] || 0) * 1.5 / FPS;
}

function __renderInner(ctx, t, env) {
  const w = Number(env && env.width) || 1;
  const h = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const time = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
  const m = env && env.media;
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);
  const src = id && m ? (m.video(id) || m.image(id)) : null;

  const s = Math.min(w / 1280, h / 720);
  const cellW = w / COLS;
  const cellH = h / ROWS;
  const capW = cellW * 0.62;
  const capH = cellH * 0.62;

  const plan = glyphPlan();
  const hashes = plan.hashes;
  const kinds = plan.kinds;
  const variants = plan.variants;
  const grays = plan.grays;

  ctx.save();
  // 暖黑底
  const bg = ctx.createRadialGradient(w * 0.5, h * 0.48, 0, w * 0.5, h * 0.5, w * 0.66);
  bg.addColorStop(0, '#17130f');
  bg.addColorStop(0.6, '#0e0b09');
  bg.addColorStop(1, '#070505');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // 蓄力：静置后压暗 12%，第一道波到达时回满
  const inhale = clamp01((time - DARK_AT) / (10 / FPS));
  const exhale = clamp01((time - WAVE_START) / (4 / FPS));
  const dimming = 0.12 * inhale * (1 - exhale);
  if (dimming > 0.001) {
    ctx.fillStyle = 'rgba(0, 0, 0, ' + dimming.toFixed(3) + ')';
    ctx.fillRect(0, 0, w, h);
  }

  const cxGrid = (COLS - 1) / 2;
  const cyGrid = (ROWS - 1) / 2;
  const maxDist = Math.hypot(cxGrid, cyGrid);

  // 中央 3×2 的键位改为素材缩略图
  const mediaCells = new Set();
  for (let r = 4; r <= 5; r += 1) {
    for (let c = 7; c <= 9; c += 1) mediaCells.add(r * COLS + c);
  }

  for (let row = 0; row < ROWS; row += 1) {
    // 光溢出：整行已亮比例 → 身后舞台横向光带
    let litRatio = 0;
    for (let col = 0; col < COLS; col += 1) {
      const idx = row * COLS + col;
      const dist = Math.hypot(col - cxGrid, row - cyGrid) / maxDist;
      // 浮现：批号按距离 75% + 噪声
      const batch = Math.min(BATCHES - 1, Math.floor((dist * 0.75 + hashes[idx] * 0.25) * BATCHES));
      // 底子先亮一档：分批浮现之前，整片键帽已经以很低的透明度在场（首帧不得全空）
      const rawT = (time - batch * BATCH_STEP) / (7 / FPS);
      const localT = rawT > 0 ? clamp01(rawT) : 0;
      const baseA = rawT > 0 ? 1 : 0.22;

      const pop = outBack(clamp01(localT / 0.42));
      const scale = 0.6 + 0.46 * pop * (1 + 0.06 * Math.sin(clamp01(localT) * Math.PI));
      const lift = (1 - outCubic(localT)) * 10 * s;
      const alpha = rawT > 0 ? clamp01(localT * 1.6) : 0.22;

      // 翻色：找覆盖这一行的那道波
      let wave = null;
      for (const cand of WAVES) {
        if (row >= cand.startRow) wave = cand;
      }
      let colorP = 0;
      let popFlash = 0;
      if (wave && time > WAVE_START) {
        const wt = waveTimeFor(row, col, { hashes });
        const start = WAVE_START + wt;
        const p = clamp01((time - start) / (4 / FPS));
        colorP = p;
        if (p > 0) {
          popFlash = clamp01((time - start - 4 / FPS) / (5 / FPS));
          litRatio += p >= 1 ? 1 : p;
        }
      }

      const x = (col + 0.5) * cellW;
      const y = (row + 0.5) * cellH - lift;
      const cw = capW * scale;
      const chh = capH * scale;

      ctx.save();
      ctx.globalAlpha = alpha;

      // 键帽底：灰阶 = 未通电
      const grayStep = grays[idx];
      const baseGray = 26 + grayStep * 9;
      ctx.fillStyle = 'rgb(' + baseGray + ',' + (baseGray - 2) + ',' + (baseGray - 5) + ')';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x - cw / 2, y - chh / 2, cw, chh, cw * 0.24) : ctx.rect(x - cw / 2, y - chh / 2, cw, chh);
      ctx.fill();
      // 发丝边 + 顶沿受光
      ctx.strokeStyle = 'rgba(255, 236, 214, 0.09)';
      ctx.lineWidth = Math.max(0.8, 1.2 * s);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 240, 220, 0.05)';
      ctx.fillRect(x - cw / 2 + cw * 0.12, y - chh / 2 + chh * 0.1, cw * 0.76, chh * 0.12);

      if (mediaCells.has(idx)) {
        // 素材缩略图：未通电时是暗格，通电后显影
        ctx.save();
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x - cw / 2, y - chh / 2, cw, chh, cw * 0.24) : ctx.rect(x - cw / 2, y - chh / 2, cw, chh);
        ctx.clip();
        if (src && colorP > 0) {
          // 自上而下 clip 灌满（与波方向一致，不做透明度混合）
          const revealH = chh * outCubic(colorP);
          ctx.save();
          ctx.beginPath();
          ctx.rect(x - cw / 2, y - chh / 2, cw, revealH);
          ctx.clip();
          const sw = src.width || cw;
          const sh = src.height || chh;
          const k = Math.max(cw / sw, chh / sh);
          ctx.drawImage(src, x - cw / 2 + (cw - sw * k) / 2, y - chh / 2 + (chh - sh * k) / 2, sw * k, sh * k);
          ctx.restore();
        } else {
          ctx.fillStyle = src ? 'rgba(60, 52, 44, 0.85)' : 'rgba(46, 40, 34, 0.9)';
          ctx.fillRect(x - cw / 2, y - chh / 2, cw, chh);
          if (!src) {
            ctx.strokeStyle = 'rgba(210, 176, 130, 0.5)';
            ctx.setLineDash([3 * s, 3 * s]);
            ctx.lineWidth = Math.max(0.8, s);
            ctx.strokeRect(x - cw * 0.34, y - chh * 0.3, cw * 0.68, chh * 0.6);
            ctx.setLineDash([]);
          }
        }
        ctx.restore();
      } else {
        // 字形：未通电暗灰 → 通电深色字形压在色块上
        if (colorP > 0) {
          // 新色自上而下灌满
          const waveColor = wave ? wave.color : '#ffb04a';
          ctx.save();
          ctx.beginPath();
          ctx.roundRect ? ctx.roundRect(x - cw / 2, y - chh / 2, cw, chh, cw * 0.24) : ctx.rect(x - cw / 2, y - chh / 2, cw, chh);
          ctx.clip();
          ctx.beginPath();
          ctx.rect(x - cw / 2, y - chh / 2, cw, chh * outCubic(colorP));
          ctx.clip();
          ctx.fillStyle = waveColor;
          ctx.fillRect(x - cw / 2, y - chh / 2, cw, chh);
          // 同色泛光
          ctx.shadowColor = wave ? wave.glow + '0.65)' : 'rgba(255,176,74,0.65)';
          ctx.shadowBlur = cw * 0.34;
          ctx.fillRect(x - cw / 2, y - chh / 2, cw, chh * outCubic(colorP));
          ctx.restore();
        }
        const inkColor = colorP > 0.5 ? 'rgba(26, 20, 14, 0.88)' : 'rgba(148, 140, 130, 0.7)';
        glyph(ctx, kinds[idx], variants[idx], x, y, Math.min(cw, chh) * 0.32, inkColor);
        // 通电白闪（5f screen 白闪）
        if (popFlash > 0 && popFlash < 1) {
          ctx.fillStyle = 'rgba(255, 250, 238, ' + (0.42 * (1 - popFlash)).toFixed(3) + ')';
          ctx.beginPath();
          ctx.roundRect ? ctx.roundRect(x - cw / 2, y - chh / 2, cw, chh, cw * 0.24) : ctx.rect(x - cw / 2, y - chh / 2, cw, chh);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // 舞台光带：该行已亮比例决定强度
    if (litRatio > 0) {
      const lit = clamp01(litRatio / COLS);
      let rowWave = WAVES[0];
      for (const cand of WAVES) if (row >= cand.startRow) rowWave = cand;
      const bandY = (row + 0.5) * cellH;
      const band = ctx.createLinearGradient(0, bandY - cellH, 0, bandY + cellH);
      band.addColorStop(0, 'rgba(0,0,0,0)');
      band.addColorStop(0.5, rowWave.glow + (0.14 * lit).toFixed(3) + ')');
      band.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = band;
      ctx.fillRect(0, bandY - cellH, w, cellH * 2);
    }
  }

  // 落版：中心径向暗幕（只压中心，四周光保留）+ 眉题 + 两行标题逐词升起
  if (time > TITLE_AT - 0.15) {
    const veil = clamp01((time - (TITLE_AT - 0.15)) / 0.5);
    const vg = ctx.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, w * 0.46);
    vg.addColorStop(0, 'rgba(8, 6, 5, ' + (0.86 * veil).toFixed(3) + ')');
    vg.addColorStop(0.72, 'rgba(8, 6, 5, ' + (0.44 * veil).toFixed(3) + ')');
    vg.addColorStop(1, 'rgba(8, 6, 5, 0)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const eyebrow = outCubic(clamp01((time - TITLE_AT + 0.1) / 0.34));
    ctx.globalAlpha = eyebrow * veil;
    ctx.fillStyle = 'rgba(255, 214, 168, 0.85)';
    ctx.font = '600 ' + Math.round(h * 0.028) + 'px system-ui, sans-serif';
    ctx.fillText(String(props.eyebrow || 'VIDEO-SHOTCRAFT'), w * 0.5, h * 0.38);

    const lines = [String(props.line1 || 'Every shot,'), String(props.line2 || 'one place.')];
    for (let i = 0; i < lines.length; i += 1) {
      const p = outCubic(clamp01((time - TITLE_AT - i * 0.08) / 0.42));
      ctx.globalAlpha = p;
      ctx.fillStyle = 'rgba(248, 242, 234, 0.97)';
      ctx.font = '800 ' + Math.round(h * 0.137) + 'px system-ui, sans-serif';
      // 第二行不许超过暗幕宽度：超了就按宽度缩
      const wpx = ctx.measureText(lines[i]).width;
      const maxW = w * 0.56;
      const fit = wpx > maxW ? maxW / wpx : 1;
      ctx.save();
      ctx.translate(w * 0.5, h * (0.46 + i * 0.16) + (1 - p) * h * 0.022);
      ctx.scale(fit, fit);
      ctx.fillText(lines[i], 0, 0);
      ctx.restore();
    }
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
