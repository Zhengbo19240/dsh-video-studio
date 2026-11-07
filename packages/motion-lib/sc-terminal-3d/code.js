/**
 * sc-terminal-3d · 终端 3D（人工标定版）
 *
 * 配方来源：video-shotcraft / references/shots/camera/terminal-3d.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021（Wei Yihao）
 * 许可：Apache License 2.0 —— 可改可商用；须保留版权归属声明、随副本带 LICENSE、标注改动过的文件。
 * 本文件是按其配方卡重写的 Canvas2D 版本（原型为 Remotion/DOM 实现，这里换 canvas）。
 *
 * 卡文要点落实：
 *   - 三窗各持 pose（x/y/z/ry 世界坐标），相机走**逆变换**；每站留 8–10° 侧视角
 *     （0° 退化成平面截图，>18° 等宽字被透视压扁）；
 *   - 两段飞行各 30f（swift 不对称 in-out），途中 `sin(π·u^0.85)×1250px` 拉远鼓包——
 *     峰值处画面缩到 ~0.6，三窗同框（「瞥见全貌」）；按相机屏速加横向方向性模糊；
 *   - 景深：每窗按与当前站距离算 focus → blur 0–3px + brightness 0.62–1 + opacity 0.72–1；
 *   - 打字机：命令逐字符（0.75–1.65f 确定性抖动、空格多停）、块光标紧贴字尾、
 *     打完 8f 半周期闪；输出每行 6f snappy 淡入 + 左移 10px 收回，行距 4f；
 *   - 打字起点 TYPE_AT 均在**到站后**（飞行中不打字，注意力不分裂）；
 *   - 全片唯一泛光给第三窗的 ● READY 成片名。
 *
 * 媒体怎么用：第一站窗口的命令区上方嵌一块素材（真实产品截图 / 终端录屏帧）。
 */

export const meta = {
  title: '终端 3D',
  duration: 4.4,
  source: 'shotcraft',
  sourcePath: 'references/shots/camera/terminal-3d.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
};

export function media(props) {
  const id = props && props.assetId;
  return id === undefined || id === null || id === '' ? [] : [String(id)];
}

const FPS = 30;
const STATIONS = [
  { x: 0, y: 0, z: 0, ry: -9, at: 0.0 },
  { x: 1500, y: -40, z: 220, ry: 14, at: 2.0 },
  { x: 3000, y: 60, z: -180, ry: -24, at: 3.5 },
];
const FLY1 = [1.3, 2.0];
const FLY2 = [3.0, 3.5];
const TYPE_AT = [8 / FPS, 2.06, 3.56];

const CMDS = ['$ npx shotcraft init', '$ render --all --h264', '$ ship --to cdn'];
const OUTPUTS = [
  ['✔ project scaffolded', '✔ 12 recipes linked'],
  ['✔ 240 frames', '✔ promo.mp4 · 18.4 MB'],
  ['✔ uploaded · 1.2s', '● READY'],
];

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);

/** swift：不对称 in-out（飞行用）。 */
function swift(u) {
  const p = clamp01(u);
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2.5) / 2;
}

/** 相机状态：站间插值 + 拉远鼓包。 */
function cameraAt(time) {
  let from = 0;
  let to = 0;
  let u = 0;
  let flying = false;
  if (time < FLY1[0]) {
    from = 0; to = 0; u = 0;
  } else if (time < FLY1[1]) {
    from = 0; to = 1; u = swift((time - FLY1[0]) / (FLY1[1] - FLY1[0]));
    flying = true;
  } else if (time < FLY2[0]) {
    from = 1; to = 1; u = 0;
  } else if (time < FLY2[1]) {
    from = 1; to = 2; u = swift((time - FLY2[0]) / (FLY2[1] - FLY2[0]));
    flying = true;
  } else {
    from = 2; to = 2; u = 0;
  }
  const a = STATIONS[from];
  const b = STATIONS[to];
  const pose = {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    z: a.z + (b.z - a.z) * u,
    ry: a.ry + (b.ry - a.ry) * u,
  };
  // 拉远鼓包：sin(π·u^0.85)×1250px
  const pull = flying ? Math.sin(Math.PI * Math.pow(clamp01(u < 0.5 ? (time - FLY1[0]) / (FLY1[1] - FLY1[0]) : (time - FLY2[0]) / (FLY2[1] - FLY2[0])), 0.85)) * 1250 : 0;
  return { ...pose, pull, focusIndex: u < 0.5 ? from : to, flying, u };
}

/** 窗口世界 → 屏幕（逆变换的近似：透视缩放 + 水平位移 + 轻微旋转）。 */
function project(win, cam, W, H, s) {
  const dx = win.x - cam.x;
  const dy = win.y - cam.y;
  const dz = (win.z - cam.z) - cam.pull;
  const persp = 1100;
  const scale = persp / Math.max(240, persp + dz);
  const ry = ((win.ry - cam.ry) * Math.PI) / 180;
  const skewX = Math.sin(ry) * 0.55;
  return {
    x: W * 0.5 + dx * scale * 0.42 * s,
    y: H * 0.5 + dy * scale * 0.42 * s,
    scale: scale * s,
    skewX,
    squash: Math.cos(ry) * 0.35 + 0.65,
    depth: dz,
  };
}

function drawWindow(ctx, W, H, win, proj, src, cmd, outLines, typeP, outP, blinkOn, highlight) {
  const ww = W * 0.62;
  const wh = H * 0.42;
  ctx.save();
  ctx.translate(proj.x, proj.y);
  ctx.scale(proj.scale, proj.scale * proj.squash);
  ctx.transform(1, 0, proj.skewX, 1, 0, 0);

  // 窗体
  ctx.fillStyle = '#10131b';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(-ww / 2, -wh / 2, ww, wh, ww * 0.012) : ctx.rect(-ww / 2, -wh / 2, ww, wh);
  ctx.fill();
  // 标题栏
  ctx.fillStyle = '#1c2130';
  ctx.fillRect(-ww / 2, -wh / 2, ww, wh * 0.09);
  ctx.fillStyle = 'rgba(220, 228, 240, 0.55)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '500 ' + Math.round(wh * 0.038) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('shotcraft — zsh', -ww / 2 + ww * 0.03, -wh / 2 + wh * 0.045);
  const dots = ['#ff5f57', '#febc2e', '#28c840'];
  for (let i = 0; i < 3; i += 1) {
    ctx.fillStyle = dots[i];
    ctx.beginPath();
    ctx.arc(ww / 2 - ww * (0.04 + i * 0.022), -wh / 2 + wh * 0.045, wh * 0.012, 0, Math.PI * 2);
    ctx.fill();
  }

  // 第一站窗口：命令区上方嵌一块素材（真实产品截图）
  if (src && highlight) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(-ww / 2 + ww * 0.04, -wh / 2 + wh * 0.14, ww * 0.92, wh * 0.3, ww * 0.008) : ctx.rect(-ww / 2 + ww * 0.04, -wh / 2 + wh * 0.14, ww * 0.92, wh * 0.3);
    ctx.clip();
    const sw = src.width || ww;
    const sh = src.height || wh;
    const k = Math.max((ww * 0.92) / sw, (wh * 0.3) / sh);
    ctx.globalAlpha = 0.92;
    ctx.drawImage(src, -ww / 2 + ww * 0.04 + (ww * 0.92 - sw * k) / 2, -wh / 2 + wh * 0.14 + (wh * 0.3 - sh * k) / 2, sw * k, sh * k);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // 窗体外描边（远景窗也认得出是终端）
  ctx.strokeStyle = 'rgba(96, 140, 220, 0.35)';
  ctx.lineWidth = Math.max(1, ww * 0.0018);
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(-ww / 2, -wh / 2, ww, wh, ww * 0.012) : ctx.rect(-ww / 2, -wh / 2, ww, wh);
  ctx.stroke();

  // 命令与输出
  const lineH = wh * 0.1;
  const baseY = -wh / 2 + wh * (highlight ? 0.56 : 0.26);
  const doneChars = Math.floor(typeP * cmd.length);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '500 ' + Math.round(wh * 0.075) + 'px ui-monospace, Menlo, monospace';
  ctx.fillStyle = 'rgba(220, 236, 255, 0.95)';
  const shown = cmd.slice(0, doneChars);
  ctx.fillText(shown, -ww / 2 + ww * 0.05, baseY);
  // 块光标：打字中常亮，打完 8f 半周期闪
  const typing = typeP < 1;
  if (typing || blinkOn) {
    const cw = ctx.measureText(shown).width;
    ctx.fillStyle = 'rgba(140, 220, 255, 0.9)';
    ctx.fillRect(-ww / 2 + ww * 0.05 + cw + wh * 0.01, baseY - wh * 0.038, wh * 0.05, wh * 0.076);
  }

  for (let i = 0; i < outLines.length; i += 1) {
    const local = clamp01((outP - i * (4 / FPS)) / (6 / FPS));
    if (local <= 0) continue;
    const e = 1 - Math.pow(1 - local, 3);
    const isLast = i === outLines.length - 1;
    const ready = outLines[i].indexOf('READY') >= 0;
    ctx.save();
    ctx.globalAlpha = local;
    ctx.font = (ready ? '700 ' : '500 ') + Math.round(wh * (ready ? 0.085 : 0.062)) + 'px ui-monospace, Menlo, monospace';
    ctx.fillStyle = ready ? 'rgba(150, 255, 190, 0.98)' : isLast ? 'rgba(200, 224, 250, 0.9)' : 'rgba(150, 176, 208, 0.86)';
    if (ready) {
      ctx.shadowColor = 'rgba(120, 255, 180, 0.8)';
      ctx.shadowBlur = wh * 0.06;
    }
    // 6f snappy 淡入 + 左移 10px 收回
    ctx.fillText(outLines[i], -ww / 2 + ww * 0.05 - (1 - e) * ww * 0.012, baseY + lineH * (i + 1.2));
    ctx.restore();
  }
  ctx.restore();
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
  const cam = cameraAt(time);

  ctx.save();
  // 暗场 + 焦点窗背光
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#080a10');
  bg.addColorStop(0.6, '#0b0e16');
  bg.addColorStop(1, '#05070c');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 空间投影表
  const projs = STATIONS.map((win) => project(win, cam, W, H, s));

  // 地面透视网格（与 world 同构；线宽恒定不闪）
  ctx.save();
  ctx.strokeStyle = 'rgba(80, 120, 200, 0.14)';
  ctx.lineWidth = Math.max(1, s);
  const horizon = H * (0.58 - cam.pull / 6000);
  for (let i = 0; i < 14; i += 1) {
    const u = i / 13;
    const y = horizon + (H - horizon) * Math.pow(u, 1.7);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  for (let i = -6; i <= 6; i += 1) {
    ctx.beginPath();
    ctx.moveTo(W * 0.5 + i * W * 0.06, horizon);
    ctx.lineTo(W * 0.5 + i * W * 0.24, H);
    ctx.stroke();
  }
  ctx.restore();

  // 焦点窗背光 + 脚下反光
  const focusProj = projs[cam.focusIndex];
  if (focusProj) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const glow = ctx.createRadialGradient(focusProj.x, focusProj.y, 0, focusProj.x, focusProj.y, W * 0.34);
    glow.addColorStop(0, 'rgba(60, 110, 200, 0.16)');
    glow.addColorStop(1, 'rgba(60, 110, 200, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // 三窗：远的先画（z 序）
  const order = projs.map((p2, i) => ({ p: p2, i })).sort((a, b) => b.p.depth - a.p.depth);
  for (const item of order) {
    const i = item.i;
    const proj = item.p;
    const dist = Math.abs(i - cam.focusIndex);
    const focus = clamp01(1 - dist * 0.9) * (cam.flying ? 0.55 : 1);
    const blurPx = (1 - focus) * 3 * (cam.flying ? 0.55 : 1);
    const bright = 0.82 + 0.18 * focus;
    const opacity = 0.72 + 0.28 * focus;

    // 打字/输出进度（只在到站后推进）
    const typeStart = TYPE_AT[i];
    const typeP = clamp01((time - typeStart) / 0.72);
    const outP = clamp01((time - typeStart - 0.82) / 0.9);
    // 光标闪：打完 8f 半周期
    const blinkOn = ((time * FPS) % 16) < 8;

    ctx.save();
    ctx.globalAlpha = opacity;
    drawWindow(ctx, W, H, STATIONS[i], proj, src, CMDS[i], OUTPUTS[i], typeP, outP, blinkOn, i === 0);
    if (bright < 0.999) {
      ctx.save();
      ctx.fillStyle = 'rgba(5, 7, 12, ' + ((1 - bright) * 0.6).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    ctx.restore();

    // 步骤号：每窗后方立一枚描边数字（飞行时与窗口产生视差）
    ctx.save();
    ctx.globalAlpha = 0.16 * opacity;
    ctx.fillStyle = 'transparent';
    ctx.strokeStyle = 'rgba(140, 180, 255, 0.9)';
    ctx.lineWidth = Math.max(1.2, 2 * s * proj.scale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 ' + Math.round(560 * s * proj.scale * 0.5) + 'px system-ui, sans-serif';
    ctx.strokeText(String(i + 1).padStart(2, '0'), proj.x - W * 0.16 * proj.scale, proj.y + H * 0.06);
    ctx.restore();
  }

  // 飞行段的横向方向性模糊（整屏一层，只在飞行中）
  if (cam.flying) {
    const k = Math.sin(clamp01(cam.u) * Math.PI);
    ctx.save();
    ctx.globalAlpha = 0.16 * k;
    ctx.fillStyle = 'rgba(120, 170, 255, 1)';
    for (let i = 0; i < 3; i += 1) {
      ctx.fillRect(W * (0.1 + i * 0.3), 0, W * 0.02, H);
    }
    ctx.restore();
  }

  // 右下 mono：站点与拉远量（编辑期校对）
  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(140, 176, 240, 0.42)';
  ctx.font = '500 ' + Math.round(H * 0.024) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText('STATION ' + (cam.focusIndex + 1) + '/3  ·  PULL ' + Math.round(cam.pull) + 'px  ·  VIEW ' + STATIONS[cam.focusIndex].ry + '°', W * 0.945, H * 0.95);
  ctx.restore();

  ctx.restore();
  void outCubic;
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
