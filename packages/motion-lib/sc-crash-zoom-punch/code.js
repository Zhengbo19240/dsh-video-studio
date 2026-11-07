/**
 * sc-crash-zoom-punch · 急推冲击（镜头版，人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/camera/crash-zoom-punch.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权与归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - 急推 6f ease-in（1 → 2.6），cx/cy 同步收敛到目标；
 *   - 急推前 6–8f 预备回拉 3–4%（先退后冲），全景 hold 段 2–3% 极缓 creep；
 *   - 落位「回弹款」：过冲后 5f 回收 3–6%（2.6 → 2.45）；
 *   - 运动模糊**只包急推段**（子帧逐层 opacity 1/(i+1) 等权叠加，子帧数按位移自适应）；
 *   - 舞台：暖黑 ember + 后仰 11° 的浏览器窗口 + 橙色背光 + 四条橙色角标先收拢锁定；
 *   - 到位帧一记暖色曝光闪（指数衰减 ~8f），周边压暗 86% + 目标轮廓光；
 *   - 回弹收干后相机左移 320px，右侧落一组大号读数。
 */

export const meta = {
  title: '急推冲击（镜头）',
  duration: 3.2,
  source: 'shotcraft',
  sourcePath: 'references/shots/camera/crash-zoom-punch.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const F = 1 / 30;
const HOLD_END = 0.7;          // 全景 hold（带 creep）
const ANTICIP = 0.22;          // 预备回拉 6–8f
const CRASH = 6 * F;           // 急推 6f
const BOUNCE = 5 * F;          // 回弹 5f
const CRASH_AT = HOLD_END + ANTICIP;      // 0.92
const LAND_AT = CRASH_AT + CRASH;         // 1.12
const SETTLE_AT = LAND_AT + BOUNCE;       // 1.29
const PAN_AT = 1.78;
const PAN_DUR = 0.55;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeInQuad = (x) => clamp01(x) * clamp01(x);
const easeOutCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const lerp = (a, b, u) => a + (b - a) * u;

/** 急推进度：ease-in 急加速（6f 内完成 1 → 2.6）。 */
function zoomAt(t) {
  if (t < HOLD_END) {
    // 全景 hold：极缓 creep 2–3%
    return 1 + 0.025 * clamp01(t / HOLD_END);
  }
  if (t < CRASH_AT) {
    // 预备：先退 3–4%（反向），观众的眼睛先被压一下
    const u = clamp01((t - HOLD_END) / ANTICIP);
    return lerp(1.025, 0.96, easeOutCubic(u));
  }
  if (t < LAND_AT) {
    const u = easeInQuad((t - CRASH_AT) / CRASH);
    return lerp(0.96, 2.6, u);
  }
  if (t < SETTLE_AT) {
    const u = clamp01((t - LAND_AT) / BOUNCE);
    return lerp(2.6, 2.45, easeOutCubic(u));
  }
  // 回弹收干后极缓推近，别再动大
  return 2.45 + 0.03 * clamp01((t - SETTLE_AT) / 1.6);
}

/** 曝光闪：到位帧一记暖色，指数衰减 ~8f。 */
function flashAt(t) {
  const since = t - LAND_AT;
  if (since < 0) return 0;
  return Math.exp(-since / (8 * F));
}

/** 相机让位：回弹收干后左移 320px（按 720p 折算 0.25w）。 */
function panAt(t) {
  const u = easeOutCubic((t - PAN_AT) / PAN_DUR);
  return -0.25 * u;
}

/** 子帧数量按本帧位移自适应：位移越大层数越多，上限 12（性能红线）。 */
function blurSamples(zoomNow, zoomNext, w) {
  const px = Math.abs(zoomNext - zoomNow) * w * 0.35;
  return Math.max(1, Math.min(6, Math.round(px / 52)));
}

function paintWindow(ctx, w, h, src, zoom, panX, tiltDeg, bright) {
  const cw = w * 0.62 * zoom;
  const ch = h * 0.46 * zoom;
  const cx = w / 2 + panX * w;
  const cy = h * 0.52;
  const tilt = (tiltDeg * Math.PI) / 180;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(tilt * 0.0);
  ctx.transform(1, Math.tan(tilt) * 0.42, 0, 1, 0, 0);

  // 橙色背光（ember 舞台）
  ctx.save();
  ctx.shadowColor = 'rgba(255, 122, 42, ' + (0.5 * bright).toFixed(3) + ')';
  ctx.shadowBlur = cw * 0.14;
  ctx.fillStyle = '#14100d';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(-cw / 2, -ch / 2, cw, ch, cw * 0.012) : ctx.rect(-cw / 2, -ch / 2, cw, ch);
  ctx.fill();
  ctx.restore();

  // 窗口内容：裁切后铺素材
  ctx.save();
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(-cw / 2, -ch / 2, cw, ch, cw * 0.012) : ctx.rect(-cw / 2, -ch / 2, cw, ch);
  ctx.clip();
  if (src) {
    const sw = src.width || cw;
    const sh = src.height || ch;
    const k = Math.max(cw / sw, ch / sh);
    ctx.drawImage(src, -cw / 2 + (cw - sw * k) / 2, -ch / 2 + (ch - sh * k) / 2, sw * k, sh * k);
  } else {
    // 有信息量的占位：画出「这里要放什么」——一张被急推聚焦的页面截图
    ctx.fillStyle = '#1a1512';
    ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
    const rows = 7;
    for (let i = 0; i < rows; i += 1) {
      const y = -ch / 2 + ch * (0.1 + i * 0.115);
      ctx.fillStyle = 'rgba(255, 176, 108, ' + (0.16 - i * 0.012).toFixed(3) + ')';
      ctx.fillRect(-cw * 0.4, y, cw * (0.34 + ((i * 7) % 5) * 0.07), ch * 0.052);
    }
    ctx.fillStyle = 'rgba(255, 236, 216, 0.92)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.max(11, cw / 34) + 'px system-ui, sans-serif';
    ctx.fillText('素材槽：待聚焦的高清截图', 0, -ch * 0.02);
    ctx.font = Math.max(9, cw / 52) + 'px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255, 190, 140, 0.72)';
    ctx.fillText('props.assetId 未给 → 急推终点必须是 Q2 级高清纹理', 0, ch * 0.06);
  }
  // 窗口条
  ctx.fillStyle = 'rgba(20, 16, 13, 0.92)';
  ctx.fillRect(-cw / 2, -ch / 2, cw, ch * 0.075);
  ctx.fillStyle = 'rgba(255, 150, 80, 0.85)';
  for (let i = 0; i < 3; i += 1) {
    ctx.beginPath();
    ctx.arc(-cw / 2 + cw * (0.024 + i * 0.019), -ch / 2 + ch * 0.0375, ch * 0.010, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 轮廓光
  ctx.strokeStyle = 'rgba(255, 168, 96, ' + (0.55 * bright).toFixed(3) + ')';
  ctx.lineWidth = Math.max(1, cw / 380);
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(-cw / 2, -ch / 2, cw, ch, cw * 0.012) : ctx.rect(-cw / 2, -ch / 2, cw, ch);
  ctx.stroke();
  ctx.restore();
  return { cx, cy, cw, ch, tilt };
}

/** 四条橙色角标：从外扩 150px 收拢锁定（全景里先「点名」）。 */
function cornerBrackets(ctx, box, lock, w) {
  const { cx, cy, cw, ch } = box;
  const spread = w * 0.117 * (1 - lock);
  const L = Math.min(cw, ch) * 0.13;
  const x0 = cx - cw / 2 - spread;
  const y0 = cy - ch / 2 - spread;
  const x1 = cx + cw / 2 + spread;
  const y1 = cy + ch / 2 + spread;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 138, 56, ' + (0.5 + 0.45 * lock).toFixed(3) + ')';
  ctx.lineWidth = Math.max(2, w / 420);
  const corners = [
    [x0, y0, 1, 1],
    [x1, y0, -1, 1],
    [x0, y1, 1, -1],
    [x1, y1, -1, -1],
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

function __renderInner(ctx, t, env) {
  const w = Number(env && env.width) || 1;
  const h = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const time = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
  const m = env && env.media;
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);
  const src = id && m ? (m.image(id) || m.video(id)) : null;

  const zoom = zoomAt(time);
  const panX = panAt(time);
  // 后仰 11° 随急推同曲线拉正
  const crashU = clamp01((time - CRASH_AT) / CRASH);
  const tiltDeg = 11 * (1 - easeInQuad(crashU));

  ctx.save();
  // 暖黑 ember 舞台
  const stage = ctx.createRadialGradient(w * 0.5, h * 0.44, 0, w * 0.5, h * 0.5, w * 0.62);
  stage.addColorStop(0, '#241a13');
  stage.addColorStop(0.45, '#140f0c');
  stage.addColorStop(1, '#080605');
  ctx.fillStyle = stage;
  ctx.fillRect(0, 0, w, h);

  // 地面反光：窗口下方一条暖色渐隐
  const floor = ctx.createLinearGradient(0, h * 0.62, 0, h);
  floor.addColorStop(0, 'rgba(255, 132, 52, 0.13)');
  floor.addColorStop(1, 'rgba(255, 132, 52, 0)');
  ctx.fillStyle = floor;
  ctx.fillRect(0, h * 0.62, w, h * 0.38);

  // 急推段：子帧等权叠加做运动模糊（只包急推段）
  const inCrash = time >= CRASH_AT && time < LAND_AT + 1e-6;
  const bright = 1;
  let box;
  if (inCrash) {
    const samples = blurSamples(zoom, zoomAt(time + F), w);
    box = null;
    for (let i = 0; i < samples; i += 1) {
      const sub = CRASH_AT + ((time - CRASH_AT) + F * (i / samples)) * 1;
      const zs = zoomAt(sub);
      ctx.save();
      ctx.globalAlpha = 1 / (i + 1);
      box = paintWindow(ctx, w, h, src, zs, panX, tiltDeg, bright);
      ctx.restore();
    }
  } else {
    box = paintWindow(ctx, w, h, src, zoom, panX, tiltDeg, bright);
  }

  // 角标：全景阶段从外扩收拢，锁定后消失
  const lock = easeOutCubic(clamp01(time / (HOLD_END - 0.1)));
  if (time < LAND_AT) {
    ctx.save();
    ctx.globalAlpha = clamp01(1 - (time - (LAND_AT - 0.1)) / 0.1);
    cornerBrackets(ctx, box || { cx: w / 2, cy: h * 0.52, cw: w * 0.62 * zoom, ch: h * 0.46 * zoom }, lock, w);
    ctx.restore();
  }

  // 曝光闪：暖色 + 全屏微曝
  const flash = flashAt(time);
  if (flash > 0.002) {
    ctx.fillStyle = 'rgba(255, 198, 132, ' + (0.36 * flash).toFixed(4) + ')';
    ctx.fillRect(0, 0, w, h);
  }

  // 到位后周边压暗 86%（vignette），目标区留亮
  const dim = clamp01((time - LAND_AT) / 0.18);
  if (dim > 0) {
    const vg = ctx.createRadialGradient(w / 2, h * 0.5, Math.min(w, h) * 0.18, w / 2, h * 0.5, Math.max(w, h) * 0.72);
    vg.addColorStop(0, 'rgba(6, 4, 3, 0)');
    vg.addColorStop(1, 'rgba(6, 4, 3, ' + (0.86 * dim).toFixed(3) + ')');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  // 右侧读数栏：回弹收干后错峰落位（大号数字 + 说明）
  const colIn = clamp01((time - (SETTLE_AT + 0.12)) / 0.4);
  if (colIn > 0) {
    const x = w * 0.855;
    ctx.save();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const numIn = easeOutCubic(clamp01(colIn / 0.7));
    const capIn = easeOutCubic(clamp01((colIn - 0.25) / 0.75));
    ctx.globalAlpha = numIn;
    ctx.fillStyle = '#ffc48a';
    ctx.font = '800 ' + Math.round(h * 0.322) + 'px system-ui, sans-serif';
    ctx.fillText(String(props.readout || '232'), x, h * 0.46 + (1 - numIn) * h * 0.03);
    ctx.globalAlpha = capIn;
    ctx.fillStyle = 'rgba(255, 226, 200, 0.8)';
    ctx.font = '600 ' + Math.round(h * 0.056) + 'px system-ui, sans-serif';
    ctx.fillText(String(props.caption || 'THE ONE LINE'), x, h * 0.655);
    ctx.fillStyle = 'rgba(255, 168, 96, 0.55)';
    ctx.fillRect(x - w * 0.17 * capIn, h * 0.605, w * 0.17 * capIn, Math.max(1, h * 0.003));
    ctx.restore();
  }

  // 左上角 mono 小字：镜头信息（现实用不到时可以 props 关掉）
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255, 176, 108, 0.5)';
  ctx.font = '500 ' + Math.round(h * 0.028) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('CRASH ZOOM · 6f · ' + (zoom).toFixed(2) + 'x', w * 0.045, h * 0.06);
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
