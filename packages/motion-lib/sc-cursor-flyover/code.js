/**
 * sc-cursor-flyover · 相机飞越四区（人工重写版）
 *
 * 配方来源：video-shotcraft / references/shots/camera/cursor-flyover.md
 * 来源仓库：https://github.com/Vincentwei1021/video-shotcraft
 * 作者：Vincentwei1021
 * 许可：Apache-2.0（可改可商用；保留版权与归属声明、随副本带 LICENSE、标注改动过的文件）
 * 改动声明：原卡为 Remotion/DOM 运动相机；这里用 Canvas2D 的 world→screen 变换重写，
 *           相机定在"世界坐标"里，四区内容与光标共用同一套坐标，所以放大后不会错位。
 *
 * 配方要点（照卡文）：
 *   - 整页俯瞰后，相机依次飞到四个功能区 zoom-in 特写；
 *   - 光标先一步到位指点，点击留下涟漪并触发界面响应；
 *   - 最后拉回俯瞰。
 *
 * 契约：render(ctx2d, t, env)；纯函数，任意 seek 一致。
 */

export const meta = {
  title: '相机飞越四区',
  duration: 8,
  kind: '几何',
  source: 'shotcraft',
  sourcePath: 'references/shots/camera/cursor-flyover.md',
  license: 'Apache-2.0',
  author: 'Vincentwei1021',
  humanCalibrated: true,
};

// 世界画布（16:9）：相机在这个坐标系里移动，画布只负责把世界等比装进去。
const WW = 900;
const WH = 506;

const DEFAULTS = {
  overview: 0.62,
  closeup: 1.85,
  flyTime: 1.08,
  dwell: 1.0,
  background: '#0e1116',
  panel: '#161b23',
  ink: '#e8edf5',
  muted: '#8b97a8',
  accent: '#39d0c4',
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const num = (v, def, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
};
const inOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const outCubic = (x) => 1 - Math.pow(1 - x, 3);
// zoom 用对数插值才均匀（线性插值会在中途"忽快忽慢"）。
const zoomLerp = (a, b, p) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * clamp01(p));

const ZONES = [
  { x: 70, y: 62, w: 360, h: 172, label: 'OVERVIEW', tag: 'A' },
  { x: 470, y: 62, w: 360, h: 172, label: 'LIST', tag: 'B' },
  { x: 70, y: 272, w: 360, h: 172, label: 'CHART', tag: 'C' },
  { x: 470, y: 272, w: 360, h: 172, label: 'ACTION', tag: 'D' },
];

const CLICK_POINT = [
  { x: 250, y: 150 },
  { x: 642, y: 150 },
  { x: 250, y: 360 },
  { x: 644, y: 358 },
];

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

function paintZone(ctx, zi, active, cfg, tt) {
  const z = ZONES[zi];
  const accent = cfg.accent;
  ctx.fillStyle = cfg.panel;
  roundRect(ctx, z.x, z.y, z.w, z.h, 10);
  ctx.fill();
  ctx.strokeStyle = active > 0 ? `rgba(57,208,196,${0.28 + 0.45 * active})` : 'rgba(255,255,255,0.07)';
  ctx.lineWidth = active > 0 ? 2 : 1;
  roundRect(ctx, z.x, z.y, z.w, z.h, 10);
  ctx.stroke();

  // 标题行
  ctx.fillStyle = cfg.muted;
  ctx.font = '600 11px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${z.tag} · ${z.label}`, z.x + 16, z.y + 14);

  const bx = z.x + 16;
  const by = z.y + 42;
  const bw = z.w - 32;

  if (zi === 0) {
    // 大数字 + 迷你折线
    ctx.fillStyle = accent;
    ctx.font = '700 46px system-ui, "Microsoft YaHei", sans-serif';
    ctx.fillText('86.4', bx, by);
    ctx.fillStyle = cfg.muted;
    ctx.font = '600 12px ui-monospace, Consolas, monospace';
    ctx.fillText('+12.8%', bx + 128, by + 26);
    ctx.strokeStyle = 'rgba(57,208,196,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 34; i += 1) {
      const px = bx + (i / 34) * bw;
      const py = z.y + z.h - 26 - Math.sin(i * 0.52 + 0.6) * 14 - (i / 34) * 26;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  } else if (zi === 1) {
    // 列表：三条行 + 圆点
    for (let i = 0; i < 3; i += 1) {
      const ry = by + i * 34;
      ctx.fillStyle = i === 0 && active > 0 ? 'rgba(57,208,196,0.16)' : 'rgba(255,255,255,0.04)';
      roundRect(ctx, bx, ry, bw, 26, 6);
      ctx.fill();
      ctx.fillStyle = i === 0 ? accent : 'rgba(255,255,255,0.28)';
      ctx.beginPath();
      ctx.arc(bx + 16, ry + 13, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(232,237,245,0.55)';
      ctx.fillRect(bx + 30, ry + 8, bw * 0.4, 4);
      ctx.fillRect(bx + 30, ry + 16, bw * 0.22, 3);
    }
  } else if (zi === 2) {
    // 柱状图
    const vals = [0.36, 0.58, 0.44, 0.82, 0.66, 0.94];
    for (let i = 0; i < vals.length; i += 1) {
      const bwd = 26;
      const gap = 12;
      const x = bx + i * (bwd + gap);
      const hgt = (z.h - 90) * vals[i];
      ctx.fillStyle = i === vals.length - 1 ? accent : 'rgba(255,255,255,0.18)';
      roundRect(ctx, x, z.y + z.h - 26 - hgt, bwd, hgt, 4);
      ctx.fill();
    }
  } else {
    // 按钮 + 开关
    ctx.fillStyle = active > 0 ? accent : 'rgba(57,208,196,0.5)';
    roundRect(ctx, bx, by + 8, 132, 36, 18);
    ctx.fill();
    ctx.fillStyle = '#08120f';
    ctx.font = '700 13px system-ui, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('APPLY', bx + 66, by + 26);
    // 开关
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    roundRect(ctx, bx + 156, by + 14, 52, 24, 12);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(bx + 156 + (active > 0 ? 38 : 14), by + 26, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = 'left';
  }

  // 点击后的响应：区内一圈扫光
  if (active > 0) {
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, z.x, z.y, z.w, z.h, 10);
    ctx.clip();
    ctx.fillStyle = `rgba(57,208,196,${0.1 * active})`;
    ctx.fillRect(z.x, z.y, z.w, z.h);
    ctx.restore();
  }
}

function drawCursor(ctx, x, y, alpha, press) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  const s = 1 - press * 0.16;
  ctx.scale(s, s);
  // 箭头（SVG 光标的几何近似）
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 17);
  ctx.lineTo(4.4, 12.8);
  ctx.lineTo(7.6, 19.4);
  ctx.lineTo(10.8, 17.8);
  ctx.lineTo(7.6, 11.4);
  ctx.lineTo(13.2, 11.4);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#0b0e13';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();
}

export function render(ctx, t, env) {
  const w = Math.max(1, Math.round(Number(env && env.width) || WW));
  const h = Math.max(1, Math.round(Number(env && env.height) || WH));
  const props = (env && env.props) || {};
  const cfg = {
    overview: num(props.overview, DEFAULTS.overview, 0.2, 2),
    closeup: num(props.closeup, DEFAULTS.closeup, 0.6, 6),
    flyTime: num(props.flyTime, DEFAULTS.flyTime, 0.2, 3),
    dwell: num(props.dwell, DEFAULTS.dwell, 0.2, 4),
    background: props.background || DEFAULTS.background,
    panel: props.panel || DEFAULTS.panel,
    ink: props.ink || DEFAULTS.ink,
    muted: props.muted || DEFAULTS.muted,
    accent: props.accent || DEFAULTS.accent,
  };

  const duration = num(env && env.duration, meta.duration, 1, 120);
  const tt = Math.min(duration, Math.max(0, Number.isFinite(Number(t)) ? Number(t) : 0));

  // 相机关键帧：俯瞰 → A → B → C → D → 俯瞰；每段前 0.28s 留一点"看"的时间。
  const fly = cfg.flyTime;
  const dwell = cfg.dwell;
  const keys = [
    { at: 0, x: WW / 2, y: WH / 2, zoom: cfg.overview, zone: -1 },
    { at: 0.55, x: WW / 2, y: WH / 2, zoom: cfg.overview, zone: -1 },
  ];
  for (let i = 0; i < ZONES.length; i += 1) {
    const arrive = keys[keys.length - 1].at + fly;
    keys.push({ at: arrive, x: ZONES[i].x + ZONES[i].w / 2, y: ZONES[i].y + ZONES[i].h / 2, zoom: cfg.closeup, zone: i });
    keys.push({ at: arrive + dwell, x: ZONES[i].x + ZONES[i].w / 2, y: ZONES[i].y + ZONES[i].h / 2, zoom: cfg.closeup, zone: i });
  }
  const back = keys[keys.length - 1].at + fly;
  keys.push({ at: back, x: WW / 2, y: WH / 2, zoom: cfg.overview, zone: -1 });
  keys.push({ at: duration, x: WW / 2, y: WH / 2, zoom: cfg.overview, zone: -1 });

  // 找当前段并插值
  let cam = keys[keys.length - 1];
  let segStart = keys[keys.length - 1];
  let segP = 1;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (tt <= keys[i + 1].at) {
      const a = keys[i];
      const b = keys[i + 1];
      const span = Math.max(1e-4, b.at - a.at);
      const p = clamp01((tt - a.at) / span);
      // 停在原地（a、b 同点）时不要缓动
      const same = Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.zoom - b.zoom) < 0.001;
      const e = same ? 0 : inOutCubic(p);
      cam = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, zoom: zoomLerp(a.zoom, b.zoom, e), zone: e > 0.5 ? b.zone : a.zone };
      segStart = a;
      segP = p;
      break;
    }
  }

  const s = Math.min(w / WW, h / WH);
  const ox = (w - WW * s) / 2;
  const oy = (h - WH * s) / 2;

  ctx.save();
  ctx.fillStyle = cfg.background;
  ctx.fillRect(0, 0, w, h);

  // world → screen
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.translate(ox + w / 2, oy + h / 2);
  ctx.scale(s * cam.zoom, s * cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  // 世界底：细点阵
  ctx.fillStyle = 'rgba(255,255,255,0.025)';
  for (let x = 20; x < WW; x += 40) {
    for (let y = 20; y < WH; y += 40) {
      ctx.fillRect(x, y, 1.6, 1.6);
    }
  }

  // 四个区：判断"正在被点"的响应强度
  for (let i = 0; i < ZONES.length; i += 1) {
    const clickAt = keys[3 + i * 2].at + 0.34;
    const resp = i === (cam.zone === -1 ? -1 : cam.zone) ? clamp01((tt - clickAt) / 0.22) * (1 - clamp01((tt - clickAt - 0.55) / 0.5)) : 0;
    paintZone(ctx, i, resp, cfg, tt);
  }

  // 点击涟漪
  for (let i = 0; i < CLICK_POINT.length; i += 1) {
    const clickAt = keys[3 + i * 2].at + 0.34;
    for (let k = 0; k < 2; k += 1) {
      const p = clamp01((tt - clickAt - k * 0.1) / 0.55);
      if (p <= 0 || p >= 1) continue;
      ctx.strokeStyle = `rgba(57,208,196,${(1 - p) * 0.75})`;
      ctx.lineWidth = 2.2 * (1 - p) + 0.5;
      ctx.beginPath();
      ctx.arc(CLICK_POINT[i].x, CLICK_POINT[i].y, 6 + p * 34, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.restore();

  // 光标在屏幕坐标里画（不随 zoom 放大，读作"系统光标"）
  const scaleToScreen = s * cam.zoom;
  let cursorAlpha = 0;
  let cursorX = 0;
  let cursorY = 0;
  let press = 0;
  for (let i = 0; i < CLICK_POINT.length; i += 1) {
    const arrive = keys[3 + i * 2].at;
    const clickAt = arrive + 0.34;
    const lead = 0.62;
    if (tt < arrive - lead) continue;
    const zoomForPoint = cam.zoom;
    const px = ox + w / 2 + (CLICK_POINT[i].x - cam.x) * s * zoomForPoint;
    const py = oy + h / 2 + (CLICK_POINT[i].y - cam.y) * s * zoomForPoint;
    const inP = clamp01((tt - (arrive - lead)) / 0.4);
    const outP = i < CLICK_POINT.length - 1 ? clamp01((tt - (clickAt + 0.35)) / 0.3) : 0;
    const a = inP * (1 - outP);
    if (a <= 0) continue;
    cursorAlpha = Math.max(cursorAlpha, a);
    // 从右侧滑入（"先一步到位"）
    const slide = (1 - outCubic(inP)) * 46;
    cursorX = px + slide;
    cursorY = py + slide * 0.55;
    press = 1 - clamp01(Math.abs(tt - clickAt) / 0.1);
    if (press < 0.01) press = 0;
  }
  if (cursorAlpha > 0) {
    drawCursor(ctx, cursorX, cursorY, cursorAlpha, press);
    // 点击瞬间的白色闪环
    if (press > 0.02) {
      ctx.strokeStyle = `rgba(255,255,255,${0.5 * press})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cursorX + 5, cursorY + 8, 5 + (1 - press) * 20, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 左上角阶段指示：俯瞰 / A-D
  const stage = cam.zone >= 0 ? `ZONE ${ZONES[cam.zone].tag}` : 'OVERVIEW';
  ctx.fillStyle = 'rgba(232,237,245,0.62)';
  ctx.font = `${Math.round(Math.min(w, h) * 0.032)}px ui-monospace, Consolas, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(stage, Math.round(Math.min(w, h) * 0.05), Math.round(Math.min(w, h) * 0.045));
  ctx.fillStyle = 'rgba(57,208,196,0.85)';
  ctx.fillRect(
    Math.round(Math.min(w, h) * 0.05),
    Math.round(Math.min(w, h) * 0.045) + Math.round(Math.min(w, h) * 0.048),
    Math.round(Math.min(w, h) * 0.12) * clamp01(tt / duration),
    2,
  );

  ctx.restore();
}
