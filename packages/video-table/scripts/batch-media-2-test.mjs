/**
 * 媒体卡第二批（后一半 34 张）离线校验。
 *
 *   node scripts/batch-media-2-test.mjs [--verbose]
 *
 * 这是测试，不是产品代码：Node 里没有 Canvas2D，所以用一台会「记账」的 2D 上下文
 * 代替——它记录每次绘制的设备坐标包围盒、虚线矩形（占位）、drawImage 目标矩形、
 * 文字位置，并支持变换 / save / restore / clip 求交。
 *
 * 覆盖：
 *   1. 清单与目录：34 张卡齐全、id 与 catalog 后半段一致
 *   2. 模块契约：render / media / meta 导出正确
 *   3. 首帧非空（ops ≥ 4 且有文字）
 *   4. 有 / 无素材两种路径都不抛错，横竖画布各一遍
 *   5. 无素材时画占位，并且说清缺什么
 *   6. 占位与真实 drawImage 目标矩形同框（逐帧、逐槽位）
 *   7. 文字不溢出两种画布（设备坐标）
 *   8. 无素材路径单帧 ≤ 16ms（1080p）
 *   9. render 主体相似度两两 < 80%
 *  10. meta.json：humanCalibrated / mediaNeeded / 来源与许可 / paramsSchema
 *  11. 样张：有 / 无素材各 3 帧 + thumb，PNG 有效且不是纯色
 *  12. 相似度 / 性能 / 样张记账汇总到 reports/batch-media-2-report.json
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const LIB = path.join(os.homedir(), '.dsh', 'motion-lib');
const PREVIEW = path.join(ROOT, '.build', 'media-previews-2', 'previews');
const MANIFEST = path.join(ROOT, 'tools', 'recipes', 'batch-media-2.json');
const CATALOG = path.join(ROOT, 'tools', 'recipes', 'catalog.json');
const REPORT = path.join(ROOT, 'reports', 'batch-media-2-report.json');

const EXCLUDE = new Set([
  'sc-circle-match-iris', 'sc-transition-hidden-cut', 'tc-source-converge', 'tc-chat-gpt',
  'tc-claude-code', 'tc-cursor-actor-demo', 'tc-subscribe-cta', 'media-pip', 'media-fullscreen-kenburns',
]);
const VERBOSE = process.argv.includes('--verbose');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    if (VERBOSE) console.log('  ok   ' + name);
  } else {
    fail += 1;
    failures.push(name + (extra ? ' :: ' + extra : ''));
    console.log('  FAIL ' + name + (extra ? ' :: ' + extra : ''));
  }
}

// ---------------------------------------------------------------- 画布桩 ----
function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
function bboxOfPoints(pts) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, x1 - x), h: Math.max(0, y1 - y) };
}
function parseFont(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(font || ''));
  return m ? Number(m[1]) : 16;
}

function makeCtx(width, height) {
  const state = {
    m: [1, 0, 0, 1, 0, 0],
    clip: { x: 0, y: 0, w: width, h: height },
    dash: [],
    font: '16px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    alpha: 1,
  };
  const stack = [];
  let path = [];
  const rec = { ops: 0, text: 0, images: [], slots: [], texts: [], fills: [] };

  const ctx = {
    canvas: { width, height },
    save() {
      stack.push({ ...state, clip: { ...state.clip }, dash: state.dash.slice() });
    },
    restore() {
      const s = stack.pop();
      if (s) Object.assign(state, s);
    },
    translate(x, y) { state.m = mul(state.m, [1, 0, 0, 1, x, y]); },
    rotate(a) {
      const c = Math.cos(a);
      const s = Math.sin(a);
      state.m = mul(state.m, [c, s, -s, c, 0, 0]);
    },
    scale(x, y) { state.m = mul(state.m, [x, 0, 0, y, 0, 0]); },
    transform(a, b, c, d, e, f) { state.m = mul(state.m, [a, b, c, d, e, f]); },
    setTransform(a, b, c, d, e, f) { state.m = [a, b, c, d, e, f]; },
    resetTransform() { state.m = [1, 0, 0, 1, 0, 0]; },
    beginPath() { path = []; },
    closePath() { /* bbox 已含端点 */ },
    moveTo(x, y) { path.push([x, y]); },
    lineTo(x, y) { path.push([x, y]); },
    quadraticCurveTo(cx, cy, x, y) { path.push([cx, cy], [x, y]); },
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { path.push([c1x, c1y], [c2x, c2y], [x, y]); },
    arcTo(x1, y1, x2, y2) { path.push([x1, y1], [x2, y2]); },
    arc(cx, cy, r) { path.push([cx - r, cy - r], [cx + r, cy + r]); },
    ellipse(cx, cy, rx, ry) { path.push([cx - rx, cy - ry], [cx + rx, cy + ry]); },
    rect(x, y, w, h) { path.push([x, y], [x + w, y + h]); },
    roundRect(x, y, w, h) { path.push([x, y], [x + w, y + h]); },
    clip() {
      if (!path.length) return;
      const dev = path.map((p) => apply(state.m, p[0], p[1]));
      state.clip = intersect(state.clip, bboxOfPoints(dev));
    },
    fill() { rec.ops += 1; },
    stroke() {
      rec.ops += 1;
      if (state.dash.length && path.length) {
        const dev = path.map((p) => apply(state.m, p[0], p[1]));
        const b = bboxOfPoints(dev);
        if (b.w > 2 && b.h > 2) rec.slots.push(b);
      }
    },
    fillRect(x, y, w, h) {
      rec.ops += 1;
      const dev = [
        apply(state.m, x, y), apply(state.m, x + w, y),
        apply(state.m, x + w, y + h), apply(state.m, x, y + h),
      ];
      rec.fills.push(bboxOfPoints(dev));
    },
    strokeRect(x, y, w, h) {
      rec.ops += 1;
      const dev = [
        apply(state.m, x, y), apply(state.m, x + w, y),
        apply(state.m, x + w, y + h), apply(state.m, x, y + h),
      ];
      const b = bboxOfPoints(dev);
      if (state.dash.length && b.w > 2 && b.h > 2) rec.slots.push(b);
    },
    drawImage(img, ...args) {
      rec.ops += 1;
      let dx;
      let dy;
      let dw;
      let dh;
      if (args.length >= 8) {
        [dx, dy, dw, dh] = args.slice(4);
      } else if (args.length >= 4) {
        [dx, dy, dw, dh] = args;
      } else {
        [dx, dy] = args;
        dw = Number(img && img.width) || 32;
        dh = Number(img && img.height) || 32;
      }
      const dev = [
        apply(state.m, dx, dy), apply(state.m, dx + dw, dy),
        apply(state.m, dx + dw, dy + dh), apply(state.m, dx, dy + dh),
      ];
      rec.images.push(bboxOfPoints(dev));
    },
    fillText(text, x, y) {
      rec.ops += 1;
      rec.text += 1;
      const size = parseFont(state.font);
      const w = String(text).length * size * 0.62;
      const h = size;
      const left = state.textAlign === 'right' ? x - w : state.textAlign === 'center' ? x - w / 2 : x;
      const dev = [
        apply(state.m, left, y - h), apply(state.m, left + w, y - h),
        apply(state.m, left + w, y + h * 0.3), apply(state.m, left, y + h * 0.3),
      ];
      rec.texts.push({ text: String(text), box: bboxOfPoints(dev), size });
    },
    strokeText() { rec.ops += 1; },
    measureText(s) {
      const size = parseFont(state.font);
      return { width: String(s).length * size * 0.62 };
    },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    createPattern() { return null; },
    setLineDash(v) { state.dash = Array.isArray(v) ? v.slice() : []; },
    getLineDash() { return state.dash.slice(); },
  };
  for (const key of ['fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'filter', 'lineDashOffset', 'miterLimit', 'globalCompositeOperation', 'imageSmoothingEnabled']) {
    let v = key === 'lineWidth' ? 1 : null;
    Object.defineProperty(ctx, key, { get: () => v, set: (nv) => { v = nv; } });
  }
  Object.defineProperty(ctx, 'font', { get: () => state.font, set: (v) => { state.font = v; } });
  Object.defineProperty(ctx, 'textAlign', { get: () => state.textAlign, set: (v) => { state.textAlign = v; } });
  Object.defineProperty(ctx, 'textBaseline', { get: () => state.textBaseline, set: (v) => { state.textBaseline = v; } });
  Object.defineProperty(ctx, 'globalAlpha', { get: () => state.alpha, set: (v) => { state.alpha = v; } });
  ctx.__rec = rec;
  return ctx;
}

const BITMAP = { width: 1600, height: 900, __mock: true };
function makeMedia() {
  return {
    has: (id) => typeof id === 'string' && id.length > 0,
    video: () => BITMAP,
    image: () => BITMAP,
    size: () => ({ width: 1600, height: 900 }),
    kind: () => 'image',
    time: () => 0,
  };
}

function envFor(width, height, duration, props, media) {
  return { width, height, fps: 30, duration, assets: [], props: props || {}, media: media || null };
}

// ------------------------------------------------------------ 相似度 ----
function renderSource(text) {
  const i = text.indexOf('export function render');
  if (i < 0) return '';
  return text.slice(i);
}
function tokens(src) {
  return (src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
    .match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_$]/g) || []);
}
function shingles(src, n = 4) {
  const t = tokens(src);
  const set = new Set();
  for (let i = 0; i + n <= t.length; i += 1) set.add(t.slice(i, i + n).join('\u0001'));
  return set;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter += 1;
  return inter / (a.size + b.size - inter);
}

// ---------------------------------------------------------------- 主流程 ----
async function main() {
  const catalog = JSON.parse(await fs.readFile(CATALOG, 'utf8'));
  const all = catalog.cards
    .filter((c) => c.mediaNeeded && c.mediaNeeded.length)
    .filter((c) => !EXCLUDE.has(c.id))
    .map((c) => c.id)
    .sort();
  const half = Math.ceil(all.length / 2);
  const ids = all.slice(half);

  console.log('第二批媒体卡：' + ids.length + ' 张（catalog 共 ' + all.length + ' 张，后一半）');

  // 1. 清单
  let manifest = null;
  try {
    manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
  } catch {
    /* 后面报错 */
  }
  ok('清单 tools/recipes/batch-media-2.json 存在且可解析', !!manifest);
  ok('清单 id 与 catalog 后半段完全一致',
    !!manifest && JSON.stringify((manifest.ids || []).slice().sort()) === JSON.stringify(ids),
    manifest ? 'manifest=' + (manifest.ids || []).length : 'none');

  const modules = new Map();
  const files = new Map();
  const metas = new Map();
  for (const id of ids) {
    const dir = path.join(LIB, id);
    let code = '';
    let meta = null;
    try {
      code = await fs.readFile(path.join(dir, 'code.js'), 'utf8');
    } catch {
      /* 报错 */
    }
    try {
      meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
    } catch {
      /* 报错 */
    }
    files.set(id, code);
    metas.set(id, meta);
    if (code) {
      try {
        modules.set(id, await import('file:///' + path.join(dir, 'code.js').replace(/\\/g, '/')));
      } catch (e) {
        modules.set(id, null);
        ok(id + ' 可被 ESM 导入', false, e.message);
      }
    }
  }

  // 2. 模块契约
  let contractBad = [];
  let firstBad = [];
  let placeholderBad = [];
  let slotBad = [];
  let textBad = [];
  let mediaBad = [];
  for (const id of ids) {
    const mod = modules.get(id);
    ok(id + ' 可被 ESM 导入', !!mod);
    if (!mod) continue;
    if (typeof mod.render !== 'function' || typeof mod.media !== 'function') {
      contractBad.push(id);
      continue;
    }
    if (mod.media(undefined) !== undefined && !Array.isArray(mod.media(undefined))) contractBad.push(id + '(media undefined)');
    const declared = mod.media({ assetId: 'a1', assetIdB: 'b1', assetIdGfx: 'g1', assetIds: ['a1', 'a2', 'a3', 'a4', 'a5'], srcs: ['a1'] });
    if (!Array.isArray(declared) || declared.includes(undefined)) contractBad.push(id + '(media props)');
    const none = mod.media({});
    if (!Array.isArray(none) || none.length !== 0) mediaBad.push(id + ' (空 props 应返回 [])');

    const duration = Number(mod.meta && mod.meta.duration) || 4;
    const samples = [0, 0.25, 0.5, 0.75].map((f) => f * duration);

    // 3/4/5 首帧、无素材、占位
    const ctx0 = makeCtx(1920, 1080);
    try {
      mod.render(ctx0, 0, envFor(1920, 1080, duration, {}, null));
    } catch (e) {
      firstBad.push(id + ' 抛错: ' + e.message);
    }
    if (!(ctx0.__rec.ops >= 4 && ctx0.__rec.text >= 1)) {
      firstBad.push(id + ' ops=' + ctx0.__rec.ops + ' text=' + ctx0.__rec.text);
    }
    let noMediaOk = true;
    let slotText = '';
    for (const [w, h] of [[1920, 1080], [1080, 1920]]) {
      for (const t of samples) {
        const ctx = makeCtx(w, h);
        try {
          mod.render(ctx, t, envFor(w, h, duration, {}, null));
        } catch (e) {
          noMediaOk = false;
          placeholderBad.push(id + ' ' + w + 'x' + h + ' t=' + t.toFixed(2) + ': ' + e.message);
          break;
        }
        slotText += ctx.__rec.texts.map((x) => x.text).join('|');
      }
    }
    if (noMediaOk && !(slotText.includes('素材') || slotText.includes('未设置') || slotText.includes('缺'))) {
      placeholderBad.push(id + ' 占位没有说明缺什么');
    }

    // 6. 占位与真实 drawImage 同框
    for (const t of samples.slice(1)) {
      const real = makeCtx(1920, 1080);
      try {
        mod.render(real, t, envFor(1920, 1080, duration, { assetId: 'a1', assetIdB: 'b1', assetIdGfx: 'g1', assetIds: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], srcs: ['a1', 'a2'] }, makeMedia()));
      } catch (e) {
        slotBad.push(id + ' 有素材抛错: ' + e.message);
        break;
      }
      const ghost = makeCtx(1920, 1080);
      try {
        mod.render(ghost, t, envFor(1920, 1080, duration, {}, null));
      } catch (e) {
        slotBad.push(id + ' 无素材抛错: ' + e.message);
        break;
      }
      const imgs = real.__rec.images;
      const slots = ghost.__rec.slots;
      if (imgs.length === 0) continue;
      if (slots.length < imgs.length) {
        slotBad.push(id + ' t=' + t.toFixed(2) + ' 有 ' + imgs.length + ' 个 drawImage，占位只记到 ' + slots.length + ' 个');
        continue;
      }
      for (let i = 0; i < imgs.length; i += 1) {
        const a = imgs[i];
        const b = slots[i];
        const tol = 2.5;
        if (Math.abs(a.x - b.x) > tol || Math.abs(a.y - b.y) > tol || Math.abs(a.w - b.w) > tol || Math.abs(a.h - b.h) > tol) {
          slotBad.push(
            id + ' t=' + t.toFixed(2) + ' 槽 ' + i +
            ' 真实=' + [a.x, a.y, a.w, a.h].map((v) => Math.round(v)).join(',') +
            ' 占位=' + [b.x, b.y, b.w, b.h].map((v) => Math.round(v)).join(','),
          );
          break;
        }
      }
    }

    // 7. 文字不溢出
    for (const [w, h] of [[1920, 1080], [1080, 1920]]) {
      const ctx = makeCtx(w, h);
      for (const t of samples) {
        try {
          mod.render(ctx, t, envFor(w, h, duration, {}, null));
        } catch {
          /* 已记录 */
        }
      }
      for (const item of ctx.__rec.texts) {
        const b = item.box;
        // 被裁切的占位文字（写在媒体槽内部、槽本身出画）不算布局溢出
        const cx0 = b.x + b.w / 2;
        const cy0 = b.y + b.h / 2;
        const inSlot = ctx.__rec.slots.concat(ctx.__rec.images).some((s) => (
          cx0 >= s.x - 1 && cx0 <= s.x + s.w + 1 && cy0 >= s.y - 1 && cy0 <= s.y + s.h + 1
        ));
        if (inSlot) continue;
        if (b.x > w || b.x + b.w < 0 || b.y > h || b.y + b.h < 0) continue;
        if (b.x < -8 || b.y < -8 || b.x + b.w > w + 8 || b.y + b.h > h + 8) {
          textBad.push(id + ' ' + w + 'x' + h + ' 「' + item.text.slice(0, 12) + '」 x=' + Math.round(b.x) + ' y=' + Math.round(b.y) + ' w=' + Math.round(b.w));
          break;
        }
      }
    }
  }
  ok('每张卡都导出 render 与合法 media()', contractBad.length === 0, contractBad.slice(0, 5).join('; '));
  ok('media({}) 一律返回空数组（缺素材时不发请求）', mediaBad.length === 0, mediaBad.slice(0, 5).join('; '));
  ok('首帧非空（绘制 ≥4 且至少一次文字）', firstBad.length === 0, firstBad.slice(0, 6).join('; '));
  ok('无素材时占位并写明缺什么', placeholderBad.length === 0, placeholderBad.slice(0, 4).join('; '));
  ok('占位矩形与真实 drawImage 目标矩形同框（逐帧逐槽）', slotBad.length === 0, slotBad.slice(0, 6).join('; '));
  ok('文字不溢出两种画布（1080p 横 / 竖）', textBad.length === 0, textBad.slice(0, 6).join('; '));

  // 8. 性能：无素材 1080p 单帧均值 ≤16ms
  const perf = [];
  for (const id of ids) {
    const mod = modules.get(id);
    if (!mod) continue;
    const duration = Number(mod.meta && mod.meta.duration) || 4;
    const ctxs = [];
    for (let i = 0; i < 8; i += 1) ctxs.push(makeCtx(1920, 1080));
    const t0 = process.hrtime.bigint();
    const frames = 40;
    for (let i = 0; i < frames; i += 1) {
      mod.render(ctxs[i % 8], (duration * i) / frames, envFor(1920, 1080, duration, {}, null));
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / frames;
    perf.push({ id, ms: Number(ms.toFixed(3)) });
  }
  const worst = perf.slice().sort((a, b) => b.ms - a.ms)[0];
  const mean = perf.reduce((s, p) => s + p.ms, 0) / Math.max(1, perf.length);
  ok('无素材路径单帧均值 ≤16ms（1080p，34 张合计）', mean <= 16, 'mean=' + mean.toFixed(3) + 'ms');
  ok('无素材路径单帧最坏 ≤16ms（单张）', !!worst && worst.ms <= 16, worst ? worst.id + ' ' + worst.ms + 'ms' : 'none');

  // 9. 相似度
  const sh = new Map();
  for (const id of ids) sh.set(id, shingles(renderSource(files.get(id) || '')));
  const pairs = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      pairs.push({ a: ids[i], b: ids[j], s: jaccard(sh.get(ids[i]), sh.get(ids[j])) });
    }
  }
  pairs.sort((a, b) => b.s - a.s);
  const top = pairs.slice(0, 5);
  ok('任意两张 render 主体相似度 < 80%', !top.length || top[0].s < 0.8, top.map((p) => p.a + '~' + p.b + ' ' + (p.s * 100).toFixed(1) + '%').join('; '));

  // 10. meta
  const metaBad = [];
  for (const id of ids) {
    const meta = metas.get(id);
    if (!meta) {
      metaBad.push(id + ' 缺 meta.json');
      continue;
    }
    if (meta.humanCalibrated !== true) metaBad.push(id + ' humanCalibrated');
    if (meta.mediaNeeded !== true) metaBad.push(id + ' mediaNeeded');
    if (!meta.source || !meta.license || !meta.sourceRepo) metaBad.push(id + ' 来源/许可');
    if (!meta.paramsSchema || !meta.paramsSchema.properties) metaBad.push(id + ' paramsSchema');
    const keys = Object.keys(meta.paramsSchema.properties || {});
    if (!keys.some((k) => /asset|src/i.test(k))) metaBad.push(id + ' paramsSchema 缺素材入参');
    if (Number(meta.duration) <= 0) metaBad.push(id + ' duration');
  }
  ok('meta.json：humanCalibrated / mediaNeeded / 来源许可 / paramsSchema / duration 齐备', metaBad.length === 0, metaBad.slice(0, 6).join('; '));

  // 11. 样张
  const previewBad = [];
  let previewReport = null;
  try {
    previewReport = JSON.parse(await fs.readFile(path.join(PREVIEW, 'report.json'), 'utf8'));
  } catch {
    /* 报错 */
  }
  ok('样张记账 .build/media-previews-2/previews/report.json 存在', !!previewReport);
  for (const id of ids) {
    for (const kind of ['with-1', 'with-2', 'with-3', 'none-1', 'none-2', 'none-3']) {
      const file = path.join(PREVIEW, id, kind + '.png');
      try {
        const buf = await fs.readFile(file);
        const sig = buf.slice(0, 8).toString('hex');
        if (sig !== '89504e470d0a1a0a') throw new Error('不是 PNG');
        if (buf.length < 4000) throw new Error('太小 ' + buf.length);
      } catch (e) {
        previewBad.push(id + '/' + kind + ': ' + e.message);
      }
    }
    try {
      const thumb = await fs.readFile(path.join(LIB, id, 'thumb.png'));
      if (thumb.slice(0, 8).toString('hex') !== '89504e470d0a1a0a' || thumb.length < 2000) throw new Error('thumb 无效');
    } catch (e) {
      previewBad.push(id + '/thumb: ' + e.message);
    }
  }
  ok('每张卡有 6 帧样张 + thumb，PNG 有效', previewBad.length === 0, previewBad.slice(0, 5).join('; '));
  const varianceBad = [];
  if (previewReport && Array.isArray(previewReport.frames)) {
    for (const f of previewReport.frames) {
      const floor = f.kind.startsWith('none') || f.kind === 'thumb' ? 8 : 14;
      if (!(f.variance >= floor)) varianceBad.push(f.id + '/' + f.kind + ' variance=' + f.variance);
    }
  }
  ok('样张不是纯色（有素材 ≥14 / 占位 ≥8 像素方差）', !!previewReport && varianceBad.length === 0, varianceBad.slice(0, 6).join('; '));

  // 12. 记账
  const report = {
    generatedAt: new Date().toISOString(),
    ids,
    count: ids.length,
    source: 'tools/recipes/catalog.json (mediaNeeded, second half)',
    perf: { meanMs: Number(mean.toFixed(3)), worst },
    similarity: { max: top[0] ? Number(top[0].s.toFixed(4)) : 0, top },
    checks: { pass, fail, failures },
  };
  await fs.mkdir(path.dirname(REPORT), { recursive: true });
  await fs.writeFile(REPORT, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log('');
  console.log('相似度最高：' + top.map((p) => p.a + ' ~ ' + p.b + ' ' + (p.s * 100).toFixed(1) + '%').join(' | '));
  console.log('性能：mean ' + mean.toFixed(3) + 'ms / worst ' + (worst ? worst.id + ' ' + worst.ms + 'ms' : '-'));
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});


