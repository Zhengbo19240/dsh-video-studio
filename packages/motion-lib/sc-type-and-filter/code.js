/**
 * sc-type-and-filter · 输入筛选（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/interaction/type-and-filter.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - 相机贴近搜索框（zoom 2.0，输入字有效字高 ≈30px）逐字符打字（3f/字符，这是「unhurried」的定稿值），
 *     光标打字中**常亮**、之后 8f 周期闪烁（常亮→闪烁的切换本身就是「打完了」的信号）；
 *   - 打完留一口气（~11f）再过滤 —— 打完立刻过滤读作机器自动，观众跟不上因果；
 *   - 非目标卡按阅读序 0.4f 间隔错峰淡出 + 下沉 8px（同时消失读作页面崩溃）；
 *   - 目标卡 10f 滑到首行槽位（bezier(.35,0,.2,1)），途中 sin 浮起 + scale +0.02 + 阴影变宽；
 *   - 点击确认：两圈同心强调色 ripple（起点差 3f、各 10f）+ 3px 描边 + 40px 辉光，随后相机 16f 推进。
 */

export const meta = {
  title: '输入筛选',
  duration: 4.2,
  source: 'shotcraft',
  sourcePath: 'references/shots/interaction/type-and-filter.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const TYPE_START = 0.32;
const TYPE_STEP = 3 / FPS;
const QUERY = 'nano-lab';
const BREATH = 11 / FPS;
const FILTER_AT = TYPE_START + QUERY.length * TYPE_STEP + BREATH;
const FILTER_STEP = 0.4 / FPS;
const SLIDE_AT = FILTER_AT + 0.3;
const SLIDE_DUR = 10 / FPS;
const CLICK_AT = SLIDE_AT + SLIDE_DUR + 0.34;
const PUSH_AT = CLICK_AT + 16 / FPS;
const PUSH_DUR = 16 / FPS;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const inOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

const GRID = 5;
const CELLS = GRID * GRID;
const TARGET = 6;

function cellLabel(i) {
  const names = ['atlas-lab', 'nano-lab', 'orbit-kit', 'pixel-desk', 'mint-ops'];
  if (i === TARGET) return 'nano-lab';
  return names[i % names.length] + ' ' + (i + 1);
}

function __renderInner(ctx, t, env) {
  const W = Number(env && env.width) || 1;
  const H = Number(env && env.height) || 1;
  const props = (env && env.props) || {};
  const time = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
  const m = env && env.media;
  const id = props.assetId === undefined || props.assetId === null ? '' : String(props.assetId);
  const src = id && m ? (m.image(id) || m.video(id)) : null;
  const accent = String(props.accent || '#f2b23c');

  const s = Math.min(W / 1280, H / 720);
  // 相机：贴搜索框 zoom 2.0 → 呼吸位拉开到 1.0 → 点击后 2.2
  let zoom = 1;
  if (time < TYPE_START) zoom = 1 + 1.0 * outCubic(clamp01(time / TYPE_START));
  else if (time < FILTER_AT) zoom = 2.0;
  else if (time < PUSH_AT) zoom = 2.0 + (1.0 - 2.0) * inOut(clamp01((time - FILTER_AT) / 0.36));
  else zoom = 1.0 + 1.2 * inOut(clamp01((time - PUSH_AT) / PUSH_DUR));
  const focusY = time < FILTER_AT ? H * 0.2 : H * 0.42;

  ctx.save();
  ctx.fillStyle = '#f7f4ee';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-W / 2, -focusY);

  // 顶栏
  ctx.fillStyle = '#22202a';
  ctx.fillRect(0, 0, W, H * 0.08);
  ctx.fillStyle = 'rgba(247,244,238,0.9)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 ' + Math.round(H * 0.032) + 'px system-ui, sans-serif';
  ctx.fillText('Library', W * 0.06, H * 0.04);

  // 搜索框：页面底色补丁盖掉纹理里的 placeholder，文字层叠上去打
  const sx = W * 0.06;
  const sy = H * 0.13;
  const sw = W * 0.42;
  const sh = H * 0.07;
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(sx, sy, sw, sh, sh * 0.28) : ctx.rect(sx, sy, sw, sh);
  ctx.fill();
  ctx.strokeStyle = 'rgba(70, 64, 56, 0.18)';
  ctx.lineWidth = Math.max(1, 2 * s);
  ctx.stroke();
  // 放大镜
  ctx.strokeStyle = 'rgba(90, 84, 74, 0.55)';
  ctx.lineWidth = Math.max(1.2, 2.2 * s);
  ctx.beginPath();
  ctx.arc(sx + sh * 0.5, sy + sh * 0.46, sh * 0.17, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx + sh * 0.62, sy + sh * 0.6);
  ctx.lineTo(sx + sh * 0.72, sy + sh * 0.72);
  ctx.stroke();

  // 打字：3f/字符；有效字高 ≈30px（zoom 2.0 时）
  const typed = Math.max(0, Math.min(QUERY.length, Math.floor((time - TYPE_START) / TYPE_STEP) + (time >= TYPE_START ? 0 : -1)));
  const shown = QUERY.slice(0, Math.max(0, typed));
  ctx.fillStyle = 'rgba(40, 36, 32, 0.95)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '500 ' + Math.round(H * 0.038) + 'px ui-monospace, Menlo, monospace';
  const textX = sx + sh * 1.05;
  ctx.fillText(shown, textX, sy + sh * 0.52);
  // 光标：打字时常亮 → 之后 8f 周期闪烁（打完了的信号）
  const typing = time < TYPE_START + QUERY.length * TYPE_STEP;
  const blinkOn = typing || ((time * FPS) % 16) < 8;
  if (blinkOn && time < CLICK_AT + 0.3) {
    const cw = ctx.measureText(shown).width;
    ctx.fillStyle = 'rgba(40, 36, 32, 0.85)';
    ctx.fillRect(textX + cw + 2 * s, sy + sh * 0.26, Math.max(1.6, 2.4 * s), sh * 0.48);
  }
  ctx.restore();

  // 网格 5×5（目标卡在第 7 格）
  const gw = W * 0.16;
  const gh = H * 0.19;
  const gapX = W * 0.018;
  const gapY = H * 0.028;
  const gridX = W * 0.06;
  const gridY = H * 0.26;
  const slotOf = (i) => ({
    x: gridX + (i % GRID) * (gw + gapX),
    y: gridY + Math.floor(i / GRID) * (gh + gapY),
  });

  for (let i = 0; i < CELLS; i += 1) {
    if (i === TARGET) continue;
    const slot = slotOf(i);
    // 非目标卡：按阅读序 0.4f 间隔错峰淡出 + 下沉 8px
    const order = i < TARGET ? i : i - 1;
    const at = FILTER_AT + order * FILTER_STEP;
    const u = clamp01((time - at) / (5 / FPS));
    if (u >= 1) continue;
    const alpha = 1 - u;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(0, u * 8 * s);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(slot.x, slot.y, gw, gh, gw * 0.05) : ctx.rect(slot.x, slot.y, gw, gh);
    ctx.fill();
    ctx.strokeStyle = 'rgba(70, 64, 56, 0.14)';
    ctx.lineWidth = Math.max(1, 1.6 * s);
    ctx.stroke();
    ctx.fillStyle = 'rgba(150, 142, 130, 0.2)';
    ctx.fillRect(slot.x + gw * 0.1, slot.y + gh * 0.12, gw * 0.8, gh * 0.42);
    ctx.fillStyle = 'rgba(60, 54, 46, 0.7)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = Math.round(gh * 0.14) + 'px system-ui, sans-serif';
    ctx.fillText(cellLabel(i), slot.x + gw * 0.08, slot.y + gh * 0.78);
    ctx.restore();
  }

  // 目标卡：10f 滑到首行槽位（途中 sin 浮起 + scale +0.02 + 阴影变宽）
  {
    const from = slotOf(TARGET);
    const to = slotOf(0);
    const u = clamp01((time - SLIDE_AT) / SLIDE_DUR);
    const e = inOut(clamp01((time - SLIDE_AT) / SLIDE_DUR));
    const x = from.x + (to.x - from.x) * e;
    const y = from.y + (to.y - from.y) * e - Math.sin(u * Math.PI) * H * 0.04;
    const scale = 1 + 0.02 * Math.sin(u * Math.PI);
    ctx.save();
    ctx.shadowColor = 'rgba(60, 48, 30, ' + (0.2 + 0.25 * Math.sin(u * Math.PI)).toFixed(3) + ')';
    ctx.shadowBlur = gw * (0.06 + 0.12 * Math.sin(u * Math.PI));
    ctx.shadowOffsetY = gh * 0.05;
    ctx.translate(x + gw / 2, y + gh / 2);
    ctx.scale(scale, scale);
    ctx.translate(-gw / 2, -gh / 2);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(0, 0, gw, gh, gw * 0.05) : ctx.rect(0, 0, gw, gh);
    ctx.fill();
    // 素材作为目标卡缩略图
    ctx.save();
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(gw * 0.1, gh * 0.12, gw * 0.8, gh * 0.42, gw * 0.03) : ctx.rect(gw * 0.1, gh * 0.12, gw * 0.8, gh * 0.42);
    ctx.clip();
    if (src) {
      const sw2 = src.width || gw;
      const sh2 = src.height || gh;
      const k = Math.max((gw * 0.8) / sw2, (gh * 0.42) / sh2);
      ctx.drawImage(src, gw * 0.1 + (gw * 0.8 - sw2 * k) / 2, gh * 0.12 + (gh * 0.42 - sh2 * k) / 2, sw2 * k, sh2 * k);
    } else {
      ctx.fillStyle = 'rgba(150, 142, 130, 0.22)';
      ctx.fillRect(gw * 0.1, gh * 0.12, gw * 0.8, gh * 0.42);
      ctx.fillStyle = 'rgba(120, 108, 92, 0.75)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 ' + Math.round(gh * 0.09) + 'px system-ui, sans-serif';
      ctx.fillText('目标卡 = 素材', gw * 0.5, gh * 0.33);
    }
    ctx.restore();
    ctx.fillStyle = 'rgba(40, 36, 32, 0.9)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.round(gh * 0.14) + 'px system-ui, sans-serif';
    ctx.fillText('nano-lab', gw * 0.08, gh * 0.68);
    ctx.fillStyle = 'rgba(140, 130, 116, 0.8)';
    ctx.font = Math.round(gh * 0.1) + 'px system-ui, sans-serif';
    ctx.fillText('1 result · exact match', gw * 0.08, gh * 0.84);
    ctx.restore();

    // 指针 + 双圈 ripple（起点差 3f、各 10f）
    const ptrIn = clamp01((time - SLIDE_AT - SLIDE_DUR) / 0.18);
    if (ptrIn > 0) {
      const px = x + gw * 0.52;
      const py = y + gh * 0.5;
      ctx.save();
      ctx.globalAlpha = ptrIn;
      ctx.fillStyle = 'rgba(24, 20, 16, 0.92)';
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + H * 0.026, py + H * 0.05);
      ctx.lineTo(px + H * 0.011, py + H * 0.049);
      ctx.lineTo(px + H * 0.019, py + H * 0.072);
      ctx.lineTo(px, py + H * 0.076);
      ctx.closePath();
      ctx.fill();
      for (let k = 0; k < 2; k += 1) {
        const since = time - (CLICK_AT + k * (3 / FPS));
        if (since >= 0 && since < 10 / FPS) {
          const q = since / (10 / FPS);
          ctx.globalAlpha = (1 - q) * ptrIn;
          ctx.strokeStyle = accent;
          ctx.lineWidth = Math.max(1.6, 3 * s);
          ctx.beginPath();
          ctx.arc(px + H * 0.02, py + H * 0.03, H * (0.02 + q * 0.05) * (1 + k * 0.5), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      // 点击瞬间 3px 描边 + 辉光
      const clickK = clamp01((time - CLICK_AT) / 0.24);
      if (clickK > 0 && clickK < 1) {
        ctx.globalAlpha = 1 - clickK;
        ctx.strokeStyle = accent;
        ctx.lineWidth = Math.max(2, 3 * s);
        ctx.shadowColor = accent;
        ctx.shadowBlur = 40 * s;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x, y, gw, gh, gw * 0.05) : ctx.rect(x, y, gw, gh);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  ctx.restore();

  // 右下 mono：因果链时刻表（编辑期校对「呼吸位」是否留够）
  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(120, 110, 96, 0.5)';
  ctx.font = '500 ' + Math.round(H * 0.024) + 'px ui-monospace, Menlo, monospace';
  const phase = time < FILTER_AT ? 'TYPING' : time < SLIDE_AT ? 'FILTERING' : time < CLICK_AT ? 'SLIDING' : 'PUSH';
  ctx.fillText('TYPE 3f/CHAR  ·  BREATH ' + Math.round(BREATH * 30) + 'f  ·  ' + phase, W * 0.95, H * 0.955);
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
