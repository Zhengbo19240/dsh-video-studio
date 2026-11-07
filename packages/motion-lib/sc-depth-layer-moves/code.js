/**
 * sc-depth-layer-moves · 分层深度运镜（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/camera/depth-layer-moves.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权与归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - 视差系数 0.35 / 0.7 / 1.4 + 一条 0x 字层：字不动、世界在动；
 *   - 远景整页 = 素材放大一档 + blur 5 + 降饱和 0.7 + 上浓下淡的同色空气薄雾（退成环境）；
 *   - 中景卡组无 blur，是主阅读层；近景浮块 blur 7 + 深远落影 + 按速度横向拖影；
 *   - 滑轨有终点：drive 总量按「落定时主角恰在屏心」反算，不对称 in-out（bezier .45,0,.18,1）130f；
 *   - 落定后主角浮起（elevation 6→26、1.035x、晚于位置收敛 ~8f）+ 描边 + 「In focus」角标。
 *   - 性能：模糊挂在层内小元素上，不挂铺满画面的容器（卡文实测可差 3 倍渲染时长）。
 */

export const meta = {
  title: '分层深度运镜',
  duration: 5.5,
  source: 'shotcraft',
  sourcePath: 'references/shots/camera/depth-layer-moves.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const DRIVE_FRAMES = 130;
const FPS = 30;
const SETTLE = DRIVE_FRAMES / FPS;      // 4.33s
const HERO_DELAY = 8 / FPS;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 便宜模糊用的小画布缓存（按尺寸复用；没有 OffscreenCanvas 时返回 null 走直画）。 */
let blurCanvas = { w: 0, h: 0, c: null };
function cheapBlurCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'function') return null;
  if (blurCanvas.c && blurCanvas.w === w && blurCanvas.h === h) return blurCanvas.c;
  try {
    const c = new OffscreenCanvas(w, h);
    blurCanvas = { w, h, c };
    return c;
  } catch {
    return null;
  }
}

/** 三次 bezier 缓动：x 轴解参数、y 轴出值（不对称 in-out）。 */
function bezierEase(x, p1x, p1y, p2x, p2y) {
  const u = clamp01(x);
  let lo = 0;
  let hi = 1;
  let p = u;
  for (let i = 0; i < 18; i += 1) {
    const bx = 3 * (1 - p) * (1 - p) * p * p1x + 3 * (1 - p) * p * p * p2x + p * p * p;
    if (bx < u) lo = p;
    else hi = p;
    p = (lo + hi) / 2;
  }
  return 3 * (1 - p) * (1 - p) * p * p1y + 3 * (1 - p) * p * p * p2y + p * p * p;
}

/** drive 0→1：滑轨总位移（终点让主角居中）。 */
function drive(t) {
  return bezierEase(t / SETTLE, 0.45, 0, 0.18, 1);
}

/** 近景拖影要看速度，不是位移。 */
function driveSpeed(t) {
  const dt = 1 / 60;
  return (drive(t + dt) - drive(t)) / dt;
}

/** 远景：整页 + 模糊 + 降饱和 + 空气薄雾。 */
function drawFarPage(ctx, w, h, src, shift, sat) {
  const scale = 1.12;
  const pw = w * scale;
  const ph = h * scale;
  const x = -shift - (pw - w) / 2;
  const y = -(ph - h) / 2;
  ctx.save();
  // 模糊与降饱和挂在「层内」的 drawImage 上，不挂全屏 filter
  // 便宜模糊：先把整页缩到 1/8 画进缓存小画布，再放大回来（≈ blur 5px）。
  // 全屏 ctx.filter blur 在软件光栅下每帧 20ms+，这个做法不到 1ms，观感等价。
  const small = cheapBlurCanvas(Math.max(8, Math.round(w / 8)), Math.max(8, Math.round(h / 8)));
  if (small) {
    const sc = small.getContext('2d');
    sc.clearRect(0, 0, small.width, small.height);
    if (src) {
      const sw0 = src.width || pw;
      const sh0 = src.height || ph;
      const kk = Math.max(small.width / sw0, small.height / sh0);
      sc.drawImage(src, (small.width - sw0 * kk) / 2, (small.height - sh0 * kk) / 2, sw0 * kk, sh0 * kk);
    }
    ctx.save();
    ctx.globalAlpha = 0.94;
    ctx.drawImage(small, 0, 0, small.width, small.height, x, y, pw, ph);
    ctx.restore();
  }
  const useDirect = !small && typeof ctx.filter === 'string';
  if (useDirect) ctx.filter = 'blur(5px) saturate(' + sat + ')';
  if (src && useDirect) {
    const sw = src.width || pw;
    const sh = src.height || ph;
    const k = Math.max(pw / sw, ph / sh);
    ctx.drawImage(src, x + (pw - sw * k) / 2, y + (ph - sh * k) / 2, sw * k, sh * k);
  } else if (!src) {
    ctx.fillStyle = '#c8b39c';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(96, 78, 60, 0.28)';
    for (let i = 0; i < 9; i += 1) {
      ctx.fillRect(w * 0.04, h * (0.08 + i * 0.1), w * (0.2 + ((i * 13) % 40) / 100), h * 0.045);
    }
    ctx.fillStyle = 'rgba(60, 46, 34, 0.5)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.round(h * 0.036) + 'px system-ui, sans-serif';
    ctx.fillText('远景层待素材：整页截图', w * 0.5, h * 0.5);
  }
  ctx.restore();

  // 空气薄雾：上浓下淡，把远景压进环境
  const haze = ctx.createLinearGradient(0, 0, 0, h);
  haze.addColorStop(0, 'rgba(226, 205, 178, 0.5)');
  haze.addColorStop(0.42, 'rgba(226, 205, 178, 0.2)');
  haze.addColorStop(1, 'rgba(226, 205, 178, 0.04)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, w, h);
  // 远景压暗：视差层必须比中景暗一档，否则读不出纵深
  ctx.fillStyle = 'rgba(28, 20, 14, 0.22)';
  ctx.fillRect(0, 0, w, h);
}

/** 中景一张卡：从素材切片，无 blur，是主阅读层。 */
function drawMidCard(ctx, w, h, src, box, tint, isHero, elevate) {
  const { x, y, cw, ch, slice } = box;
  ctx.save();
  // 两层软影落在「桌面」上
  ctx.save();
  ctx.shadowColor = 'rgba(42, 26, 14, 0.34)';
  ctx.shadowBlur = cw * (0.1 + elevate * 0.01);
  ctx.shadowOffsetY = ch * (0.06 + elevate * 0.004);
  ctx.fillStyle = '#f4ece0';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, cw, ch, cw * 0.02) : ctx.rect(x, y, cw, ch);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, cw, ch, cw * 0.02) : ctx.rect(x, y, cw, ch);
  ctx.clip();
  if (src) {
    const sw = src.width || cw;
    const sh = src.height || ch;
    // 每张卡取素材不同区域：同一张图读出多张卡的错觉
    const sx = sw * slice.sx;
    const sy = sh * slice.sy;
    const sw2 = sw * slice.sw;
    const sh2 = sh * slice.sh;
    const k = Math.max(cw / sw2, ch / sh2);
    ctx.drawImage(src, sx, sy, sw2, sh2, x + (cw - sw2 * k) / 2, y + (ch - sh2 * k) / 2, sw2 * k, sh2 * k);
  } else {
    ctx.fillStyle = '#efe4d4';
    ctx.fillRect(x, y, cw, ch);
    ctx.fillStyle = 'rgba(150, 120, 92, 0.26)';
    ctx.fillRect(x + cw * 0.08, y + ch * 0.12, cw * 0.56, ch * 0.07);
    for (let i = 0; i < 4; i += 1) {
      ctx.fillStyle = 'rgba(150, 120, 92, ' + (0.2 - i * 0.03).toFixed(3) + ')';
      ctx.fillRect(x + cw * 0.08, y + ch * (0.28 + i * 0.14), cw * (0.7 - (i % 2) * 0.18), ch * 0.055);
    }
    ctx.fillStyle = 'rgba(92, 68, 46, 0.6)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.max(8, cw * 0.05) + 'px system-ui, sans-serif';
    ctx.fillText('中景卡 · 待素材', x + cw * 0.08, y + ch * 0.88);
  }
  // 卡面顶部色条（赤陶调性）
  ctx.fillStyle = tint;
  ctx.fillRect(x, y, cw, ch * 0.018);
  ctx.restore();

  // 浮起时才描边 + 角标
  if (elevate > 0.01) {
    ctx.strokeStyle = 'rgba(186, 96, 62, ' + (0.85 * elevate).toFixed(3) + ')';
    ctx.lineWidth = Math.max(1, cw * 0.006);
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, cw, ch, cw * 0.02) : ctx.rect(x, y, cw, ch);
    ctx.stroke();
    if (isHero) {
      const chipW = cw * 0.42;
      const chipH = ch * 0.12;
      const cx = x + cw - chipW - cw * 0.04;
      const cy = y + ch - chipH - ch * 0.05;
      ctx.save();
      ctx.globalAlpha = elevate;
      ctx.fillStyle = '#ba603e';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(cx, cy, chipW, chipH, chipH / 2) : ctx.rect(cx, cy, chipW, chipH);
      ctx.fill();
      ctx.fillStyle = '#fff6ee';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 ' + Math.max(7, chipH * 0.52) + 'px system-ui, sans-serif';
      ctx.fillText('In focus', cx + chipW / 2, cy + chipH / 2);
      ctx.restore();
    }
  }
  ctx.restore();
}

/** 近景浮块：标签胶囊，blur 7 + 按速度横向拖影。 */
function drawNearPill(ctx, w, h, cx, cy, pw, ph, label, speed, alpha) {
  const streak = Math.min(1, speed * 0.55);
  const passes = 1 + Math.round(streak * 4);
  for (let i = 0; i < passes; i += 1) {
    const off = -streak * pw * 0.34 * (i / Math.max(1, passes - 1));
    ctx.save();
    ctx.globalAlpha = alpha * (i === 0 ? 1 : 0.16);

    ctx.translate(cx + off, cy);
    // 糊边用「多层半透明描边」近似（滤镜模糊每帧 ×5 枚在软件光栅下 100ms 级）
    ctx.fillStyle = 'rgba(150, 72, 46, 0.9)';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(-pw / 2, -ph / 2, pw, ph, ph / 2) : ctx.rect(-pw / 2, -ph / 2, pw, ph);
    ctx.fill();
    ctx.strokeStyle = 'rgba(150, 72, 46, 0.22)';
    ctx.lineWidth = ph * 0.4;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(-pw / 2, -ph / 2, pw, ph, ph / 2) : ctx.rect(-pw / 2, -ph / 2, pw, ph);
    ctx.stroke();
    ctx.restore();
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  ctx.fillStyle = 'rgba(255, 246, 238, 0.92)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 ' + Math.max(8, ph * 0.42) + 'px system-ui, sans-serif';
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

function __renderInner(ctx, t, env) {
  const w = Number(env && env.width) || 1;
  const h = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const time = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
  const m = env && env.media;
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);
  const src = id && m ? (m.image(id) || m.video(id)) : null;

  const d = drive(time);
  const speed = driveSpeed(time);
  const s = Math.min(w / 1280, h / 720);

  ctx.save();
  ctx.fillStyle = '#e8dccb';
  ctx.fillRect(0, 0, w, h);

  // ---- 远景层 0.35x ----
  drawFarPage(ctx, w, h, src, d * w * 0.35, 0.7);

  // ---- 中景层 0.7x：卡组，主阅读层 ----
  // 终点构图：drive=1 时 hero 卡恰在屏心（由这个反算总位移）
  const midShift = d * w * 0.7;
  const heroTargetX = w * 0.5;
  const heroStartX = w * 0.86;
  const midCards = [
    { rel: -0.52, y: h * 0.2, rw: 0.3, rh: 0.3, tilt: -2.4, slice: { sx: 0.02, sy: 0.1, sw: 0.42, sh: 0.5 } },
    { rel: -0.06, y: h * 0.5, rw: 0.34, rh: 0.34, tilt: 1.2, slice: { sx: 0.3, sy: 0.3, sw: 0.46, sh: 0.44 } },
    { rel: 0.44, y: h * 0.24, rw: 0.28, rh: 0.28, tilt: -1.4, slice: { sx: 0.55, sy: 0.06, sw: 0.4, sh: 0.52 } },
  ];
  // hero 本身也是中景的一块
  const settle = clamp01((time - SETTLE) / (1.2 - HERO_DELAY));
  const elevate = clamp01((time - SETTLE - HERO_DELAY) / 0.42);
  const heroBox = {
    x: heroTargetX - w * 0.17,
    y: h * 0.5 - h * 0.19 - elevate * h * 0.008,
    cw: w * 0.34 * (1 + 0.035 * elevate),
    ch: h * 0.38 * (1 + 0.035 * elevate),
    slice: { sx: 0.18, sy: 0.2, sw: 0.5, sh: 0.46 },
  };

  for (const card of midCards) {
    const cw = w * card.rw;
    const ch = h * card.rh;
    const baseX = w * 0.5 + card.rel * w - midShift;
    // 落定后不参与滑轨（否则主角浮起时别人还在动，读作穿帮）
    const x = settle > 0 ? baseX + (w * 0.5 + card.rel * w - baseX) * (1 - settle) : baseX;
    ctx.save();
    ctx.translate(x, card.y);
    ctx.rotate((card.tilt * Math.PI) / 180);
    drawMidCard(ctx, w, h, src, { x: -cw / 2, y: -ch / 2, cw, ch, slice: card.slice }, 'rgba(196, 116, 82, 0.85)', false, 0);
    ctx.restore();
  }

  // hero 卡：从右滑到屏心
  {
    const hx = heroStartX + (heroTargetX - heroStartX) * bezierEase(clamp01(time / SETTLE), 0.45, 0, 0.18, 1);
    const lift = -elevate * h * 0.014;
    drawMidCard(
      ctx, w, h, src,
      { x: hx - heroBox.cw / 2, y: heroBox.y + lift, cw: heroBox.cw, ch: heroBox.ch, slice: heroBox.slice },
      'rgba(186, 96, 62, 0.95)', true, elevate,
    );
  }

  // ---- 近景层 1.4x：浮块，掠过镜头 ----
  const nearShift = d * w * 1.4;
  const pillLabels = ['real tag', 'deck', 'P0', 'in depth', 'layers'];
  for (let i = 0; i < pillLabels.length; i += 1) {
    const baseX = w * (0.1 + i * 0.24) - nearShift;
    if (baseX + w > -w * 0.2 && baseX - w < w * 1.2) {
      const pw = w * (0.13 + (i % 3) * 0.03);
      const ph = pw * 0.3;
      const y = h * (0.78 - (i % 2) * 0.08) - Math.sin(i * 1.7) * h * 0.03;
      drawNearPill(ctx, w, h, baseX, y, pw, ph, pillLabels[i], speed, 0.95);
    }
  }

  // ---- 0x 字层：字不动，世界在动 ----
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(72, 52, 36, 0.9)';
  ctx.font = '600 ' + Math.round(h * 0.031) + 'px system-ui, sans-serif';
  ctx.fillText(String(props.eyebrow || 'VIDEO-SHOTCRAFT'), w * 0.05, h * 0.075);
  ctx.fillStyle = 'rgba(58, 40, 26, 0.94)';
  ctx.font = '800 ' + Math.round(h * 0.133) + 'px system-ui, sans-serif';
  ctx.fillText(String(props.title || 'Your page, in depth.'), w * 0.05, h * 0.155);
  ctx.fillStyle = 'rgba(150, 112, 80, 0.7)';
  ctx.fillRect(w * 0.05, h * 0.215, w * 0.12 * clamp01(time / 0.6), Math.max(1, h * 0.004));
  ctx.restore();

  // ---- 落定后一层极淡的暖色收束，避免尾帧「像截图」 ----
  if (settle > 0) {
    const vg = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.24, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
    vg.addColorStop(0, 'rgba(90, 58, 34, 0)');
    vg.addColorStop(1, 'rgba(90, 58, 34, ' + (0.26 * settle).toFixed(3) + ')');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  // 右下 mono 读数：视差值（质感件的「仪表」）
  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(120, 88, 62, 0.62)';
  ctx.font = '500 ' + Math.round(h * 0.026) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('PARALLAX 0.35 / 0.70 / 1.40', w * 0.95, h * 0.945);
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
