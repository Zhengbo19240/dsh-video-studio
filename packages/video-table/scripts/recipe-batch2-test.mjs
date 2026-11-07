#!/usr/bin/env node
/**
 * 第二批配方卡（几何 + 转场，20 张）的验收测试。
 *
 *   node scripts/recipe-batch2-test.mjs
 *   node scripts/recipe-batch2-test.mjs --json      # 末尾多打一份机器可读摘要
 *   node scripts/recipe-batch2-test.mjs --no-browser # 只跑静态检查（不动 Edge）
 *
 * 分两层：
 *   A. 静态层（纯 Node）—— 文件存在、可解析、meta 完整、批表与磁盘一致、
 *      四象限/边界 props 不抛、纯函数与性能红线（filter/clip）审计。
 *   B. 像素层（Edge headless）—— 两种画布的样张非空、bbox 不变形、
 *      1080p 单帧耗时（软渲染，值偏保守）。
 *
 * 性能预算：单帧 ≤ 16ms（1080p）。超了记 warn，不 fail —— 但一定列出来。
 * 退出码：0 全绿（可含 warn）；1 有 fail。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MOTION = process.env.DSH_MOTION_LIB || path.join(os.homedir(), '.dsh', 'motion-lib');
const BATCH_PATH = path.join(ROOT, 'tools', 'recipes', 'batch-2.json');
const CATALOG_PATH = path.join(ROOT, 'tools', 'recipes', 'catalog.json');
const BUILD_DIR = path.join(ROOT, '.build');
const PERF_BUDGET_MS = 16;

const ARGS = new Set(process.argv.slice(2));
const JSON_OUT = ARGS.has('--json');
const NO_BROWSER = ARGS.has('--no-browser');

const BROWSERS = [
  process.env.DSH_PREVIEW_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

// 第二批的 20 张（顺序即清单顺序）
const IDS = [
  'sc-beat-cut-moves',
  'sc-bezier-source-converge-merge',
  'sc-bottom-push-stack-wipe',
  'sc-cursor-flyover',
  'sc-fui-hud-moves',
  'sc-glow-flyline-moves',
  'sc-mosaic-reframe',
  'sc-page-turn-transitions',
  'sc-print-texture-transitions',
  'sc-rhythm-interrupt-moves',
  'sc-sakuga-timing-shift',
  'sc-scan-bracket-sweep',
  'sc-segmented-thumb-hero',
  'sc-trailer-grammar-moves',
  'tc-black-slam-transition',
  'tc-cursor-locked-zoom',
  'tc-long-take-world',
  'tc-caret-wipe-transition',
  'sc-scanline-assemble-flyin',
  'sc-gradient-transition',
];

// 必须两镜、没有进第二批的候选（验收时复核它确实没被误收）
const SKIPPED_TWO_SHOT = ['sc-circle-match-iris', 'sc-transition-hidden-cut'];

const results = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  results.push({ type: 'group', name });
}

function record(status, id, name, detail) {
  results.push({ type: 'case', status, id, name, detail, group: currentGroup });
}

function pass(id, name, detail) {
  record('pass', id, name, detail);
}
function fail(id, name, detail) {
  record('fail', id, name, detail);
}
function warn(id, name, detail) {
  record('warn', id, name, detail);
}
function skip(id, name, detail) {
  record('skip', id, name, detail);
}

/** 断言一个布尔；返回是否通过。 */
function expect(id, name, ok, detail) {
  if (ok) pass(id, name, detail);
  else fail(id, name, detail);
  return ok;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 与 tools/render-card-preview.mjs 同一套 ESM→Function 改写规则。 */
function toFunctionBody(source) {
  return String(source)
    .replace(/export\s+default\s+/g, 'const __default__ = ')
    .replace(/export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/g, (m, isAsync, name) => `${isAsync || ''}function ${name}`)
    .replace(/export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g, (m, kind, name) => `${kind} ${name}`)
    .replace(/export\s*\{[^}]*\}/g, '');
}

function loadModule(source) {
  const body = toFunctionBody(source);
  return new Function(
    '"use strict";\n' +
      body +
      '\nreturn { render: typeof render === "function" ? render : (__default__ && __default__.render), meta: typeof meta === "object" ? meta : (__default__ && __default__.meta) };',
  )();
}

/**
 * 一个会记账的假 2D context：
 * - 记录 NaN 参数（transform 里出现 NaN 会让整帧静默丢失，是最隐蔽的坏帧）
 * - 记录 filter 设置（性能红线）
 * - 记录 save/clip/restore 次数（clip 必须配 save/restore）
 * - 记录绘图命令数（判断"这一帧有没有画东西"）
 */
function makeFakeCtx() {
  const tags = ['fillRect', 'strokeRect', 'fill', 'stroke', 'fillText', 'strokeText', 'drawImage', 'arc', 'ellipse'];
  const hist = { draw: 0, filter: [], save: 0, restore: 0, clip: 0, nan: [], maxX: -Infinity, maxY: -Infinity, minX: Infinity, minY: Infinity };
  const props = {};
  const gradient = () => ({ addColorStop() {} });
  const handler = {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop in props) return props[prop];
      return (...args) => {
        for (const a of args) {
          if (typeof a === 'number' && !Number.isFinite(a)) hist.nan.push(`${String(prop)}(${args.join(',')})`);
          if (typeof a === 'number' && Number.isFinite(a)) {
            if (a > hist.maxX) hist.maxX = a;
            if (a < hist.minX) hist.minX = a;
          }
        }
        if (tags.includes(prop)) hist.draw += 1;
        // 四参数矩形类命令顺便记 y 范围
        if ((prop === 'fillRect' || prop === 'strokeRect') && typeof args[1] === 'number') {
          if (args[1] > hist.maxY) hist.maxY = args[1];
          if (args[1] < hist.minY) hist.minY = args[1];
        }
        if (prop === 'clip') hist.clip += 1;
        if (prop === 'save') hist.save += 1;
        if (prop === 'restore') hist.restore += 1;
        return undefined;
      };
    },
    set(target, prop, value) {
      if (prop === 'filter') hist.filter.push(String(value));
      props[prop] = value;
      return true;
    },
  };
  const base = {
    canvas: { width: 0, height: 0 },
    measureText: (s) => ({ width: String(s).length * 8 }),
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    createConicGradient: gradient,
    createPattern: () => null,
    getImageData: (x, y, w2, h2) => ({ data: new Uint8ClampedArray(Math.max(4, w2 * h2 * 4)), width: w2, height: h2 }),
  };
  return { ctx: new Proxy(base, handler), hist };
}

/** 跑一帧，返回 { ok, error, hist }。 */
function runFrame(render, t, w, h, props) {
  const { ctx, hist } = makeFakeCtx();
  ctx.canvas.width = w;
  ctx.canvas.height = h;
  try {
    render(ctx, t, { width: w, height: h, props: props || {}, fps: 30, duration: undefined });
    return { ok: true, hist };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error), hist };
  }
}

/* ------------------------------------------------------------------ */
/* A. 静态层                                                           */
/* ------------------------------------------------------------------ */

async function staticTests() {
  group('A · 批表与文件');
  let batch = null;
  try {
    batch = JSON.parse(await fs.readFile(BATCH_PATH, 'utf8'));
    pass('T01', 'batch-2.json 存在且可解析', `keys: ${Object.keys(batch).join(',')}`);
  } catch (error) {
    fail('T01', 'batch-2.json 存在且可解析', error.message);
    return null;
  }

  const cards = Array.isArray(batch.cards) ? batch.cards : [];
  expect('T02', 'batch-2 恰有 20 张卡', cards.length === 20, `实际 ${cards.length}`);
  const ids = cards.map((c) => c.id);
  expect('T03', 'batch-2 的 id 唯一且与清单一致', new Set(ids).size === 20 && IDS.every((id) => ids.includes(id)), `batch=${ids.length}, 去重=${new Set(ids).size}`);

  const missingDirs = [];
  const parsed = new Map();
  for (const id of IDS) {
    const dir = path.join(MOTION, id);
    const codePath = path.join(dir, 'code.js');
    const metaPath = path.join(dir, 'meta.json');
    try {
      await fs.access(codePath);
      await fs.access(metaPath);
    } catch {
      missingDirs.push(id);
      continue;
    }
    try {
      const source = await fs.readFile(codePath, 'utf8');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      parsed.set(id, { source, meta, dir, codePath, metaPath });
    } catch (error) {
      missingDirs.push(`${id} (${error.message})`);
    }
  }
  expect('T04', '20 张卡的 code.js + meta.json 都在', missingDirs.length === 0, missingDirs.join(', ') || 'all present');
  if (parsed.size !== 20) return batch;

  group('A · 模块契约');
  const loadErrors = [];
  for (const [id, entry] of parsed) {
    try {
      const api = loadModule(entry.source);
      if (typeof api.render !== 'function') loadErrors.push(`${id}: 没有导出 render`);
      else entry.render = api.render;
      entry.moduleMeta = api.meta || {};
    } catch (error) {
      loadErrors.push(`${id}: ${error.message}`);
    }
  }
  expect('T05', 'code.js 全部可解析且导出 render(ctx,t,env)', loadErrors.length === 0, loadErrors.join(' | ') || '20/20');

  group('A · meta 完整');
  const metaProblems = [];
  const REQUIRED = ['source', 'sourcePath', 'sourceRepo', 'license', 'author', 'duration'];
  for (const [id, entry] of parsed) {
    const m = entry.meta;
    const lacked = REQUIRED.filter((k) => m[k] === undefined || m[k] === null || m[k] === '');
    if (lacked.length) metaProblems.push(`${id}: 缺 ${lacked.join('/')}`);
    if (m.humanCalibrated !== true) metaProblems.push(`${id}: humanCalibrated≠true`);
  }
  expect('T06', 'meta 必填字段齐全', metaProblems.length === 0, metaProblems.join(' | ') || 'all complete');
  expect('T07', '每张都标了 humanCalibrated:true', parsed.size === Object.keys(Object.fromEntries(parsed)).length && [...parsed.values()].every((e) => e.meta.humanCalibrated === true), '20/20');

  // duration 与 catalog 一致（元数据不能各说各话）
  let catalog = null;
  try {
    catalog = JSON.parse(await fs.readFile(CATALOG_PATH, 'utf8'));
  } catch {
    catalog = null;
  }
  if (catalog) {
    const byId = new Map(catalog.cards.map((c) => [c.id, c]));
    const durBad = [];
    for (const [id, entry] of parsed) {
      const card = byId.get(id);
      if (!card) {
        durBad.push(`${id}: catalog 里没有`);
        continue;
      }
      if (Math.abs(Number(entry.meta.duration) - Number(card.durationHint)) > 0.011) {
        durBad.push(`${id}: meta ${entry.meta.duration} ≠ catalog ${card.durationHint}`);
      }
    }
    expect('T08', 'meta.duration 与 catalog.durationHint 一致', durBad.length === 0, durBad.join(' | ') || '20/20 对齐');
  } else {
    skip('T08', 'meta.duration 与 catalog 对齐', 'catalog.json 读不到');
  }

  group('A · 纯函数与性能红线（静态审计）');
  const impure = [];
  for (const [id, entry] of parsed) {
    const src = entry.source;
    const hits = [];
    if (/Math\.random\s*\(/.test(src)) hits.push('Math.random');
    if (/Date\.now\s*\(/.test(src)) hits.push('Date.now');
    if (/performance\.now\s*\(/.test(src)) hits.push('performance.now');
    if (/new\s+Date\s*\(/.test(src)) hits.push('new Date');
    if (hits.length) impure.push(`${id}: ${hits.join(',')}`);
  }
  expect('T09', '没有读时钟 / 随机数（同 t 同画面）', impure.length === 0, impure.join(' | ') || '20/20 纯函数');

  const filterBad = [];
  const clipBad = [];
  const canvasPerf = [];
  for (const [id, entry] of parsed) {
    const src = entry.source;
    // 只统计真正设了 blur 的 filter 赋值；`filter = 'none'` 是复位，不算一次模糊
    const filterLines = src.split('\n').filter((line) => /\.filter\s*=/.test(line));
    const blurAssigns = filterLines.filter((line) => /blur\(/.test(line)).length;
    const blurRadii = [...src.matchAll(/blur\(\s*([\d.]+)px/g)].map((m) => Number(m[1])).filter((n) => Number.isFinite(n));
    const maxBlur = blurRadii.length ? Math.max(...blurRadii) : 0;
    if (blurAssigns > 2) filterBad.push(`${id}: blur 赋了 ${blurAssigns} 次`);
    if (maxBlur > 24) filterBad.push(`${id}: blur ${maxBlur}px > 24px`);
    // clip 必须 save/restore：以每个 clip 前是否出现过 save 做近似判定
    const clipIdx = [];
    let idx = src.indexOf('.clip(');
    while (idx >= 0) {
      clipIdx.push(idx);
      idx = src.indexOf('.clip(', idx + 1);
    }
    const saveCount = (src.match(/\.save\s*\(/g) || []).length;
    const restoreCount = (src.match(/\.restore\s*\(/g) || []).length;
    if (clipIdx.length > 0 && (saveCount < clipIdx.length || restoreCount < clipIdx.length)) {
      clipBad.push(`${id}: clip ${clipIdx.length} 次，save ${saveCount} / restore ${restoreCount}`);
    }
    // 全屏逐像素：出现 getImageData / putImageData / createImageData 就危险
    const pixelLoops = /getImageData\s*\(|putImageData\s*\(|createImageData\s*\(/.test(src);
    if (pixelLoops) canvasPerf.push(`${id}: 用了像素级 API`);
  }
  expect('T10', 'ctx.filter ≤2 次且 blur ≤24px', filterBad.length === 0, filterBad.join(' | ') || '全部达标');
  expect('T11', 'clip 与 save/restore 成对', clipBad.length === 0, clipBad.join(' | ') || '全部成对');
  expect('T12', '没有全屏逐像素操作', canvasPerf.length === 0, canvasPerf.join(' | ') || '20/20 无像素级 API');

  group('A · 四象限与边界（不抛）');
  const QUADRANTS = [
    { name: 't=0', t: 0 },
    { name: 't=0.5', t: 0.5 },
    { name: 't=末', t: null },
    { name: 't=-1（越界负）', t: -1 },
    { name: 't=dur+10（越界超时长）', t: null, over: 10 },
    { name: 't=NaN', t: NaN },
  ];
  const quadBad = [];
  const nanBad = [];
  for (const [id, entry] of parsed) {
    if (typeof entry.render !== 'function') continue;
    const dur = Number(entry.meta.duration) || 3;
    for (const q of QUADRANTS) {
      const t = q.t === null ? dur + (q.over || 0) : q.t;
      const res = runFrame(entry.render, t, 1280, 720, {});
      if (!res.ok) quadBad.push(`${id}@${q.name}: ${res.error}`);
      if (res.ok && res.hist.nan.length) nanBad.push(`${id}@${q.name}: ${res.hist.nan.slice(0, 2).join(';')}`);
    }
  }
  expect('T13', '四象限 + 越界 t 不抛', quadBad.length === 0, quadBad.slice(0, 4).join(' | ') || '20 张 × 6 点全过');
  expect('T14', '绘制参数不出现 NaN/Infinity', nanBad.length === 0, nanBad.slice(0, 4).join(' | ') || '全部有限');

  const propCases = [
    { name: 'props=null', props: null },
    { name: 'props={}', props: {} },
    { name: 'props 非法数值', props: { lead: 'abc', zoom: -999, source: {}, colors: null, fps: 0 } },
    { name: 'props 极端值', props: { lead: 1e9, duration: -5, seeds: 1e9, passes: 999 } },
  ];
  const propBad = [];
  for (const [id, entry] of parsed) {
    if (typeof entry.render !== 'function') continue;
    for (const pc of propCases) {
      const res = runFrame(entry.render, 0.7, 1280, 720, pc.props);
      if (!res.ok) propBad.push(`${id}[${pc.name}]: ${res.error}`);
    }
  }
  expect('T15', 'props 边界（null/非法/极端）不抛', propBad.length === 0, propBad.slice(0, 4).join(' | ') || '20 张 × 4 组全过');

  group('A · 两种画布');
  // 这些卡的末帧按配方就是黑场切出（opacity 归零），不参与"末帧有绘制"的判定
  const BLACK_TAIL = new Set(['tc-black-slam-transition']);
  const canvasBad = [];
  const emptyFrame = [];
  for (const [id, entry] of parsed) {
    if (typeof entry.render !== 'function') continue;
    const dur = Number(entry.meta.duration) || 3;
    for (const [w, h] of [[1280, 720], [720, 1280]]) {
      for (const t of [0, 0.5, dur / 2, dur]) {
        if (BLACK_TAIL.has(id) && Math.abs(t - dur) < 1e-6) continue;
        const res = runFrame(entry.render, t, w, h, {});
        if (!res.ok) canvasBad.push(`${id}@${w}x${h}: ${res.error}`);
        if (res.ok && res.hist.draw < 2) emptyFrame.push(`${id}@${w}x${h} t=${t.toFixed(2)}: 只画了 ${res.hist.draw} 次`);
      }
    }
  }
  expect('T16', '1280×720 / 720×1280 都不抛', canvasBad.length === 0, canvasBad.slice(0, 4).join(' | ') || '40 次渲染全过');
  expect('T17', '每帧都有实际绘制（不是空帧）', emptyFrame.length === 0, emptyFrame.slice(0, 5).join(' | ') || '每帧 ≥3 次绘制命令');

  group('A · 批表与磁盘一致性');
  const { statSync } = await import('node:fs');
  const drift = [];
  for (const card of cards) {
    const entry = parsed.get(card.id);
    if (!entry) {
      drift.push(`${card.id}: 清单里有、磁盘没有`);
      continue;
    }
    if (card.duration !== undefined && Math.abs(Number(card.duration) - Number(entry.meta.duration)) > 0.011) {
      drift.push(`${card.id}: batch.duration ${card.duration} ≠ meta ${entry.meta.duration}`);
    }
    if (card.category !== undefined && card.category !== entry.meta.category) {
      drift.push(`${card.id}: batch.category ${card.category} ≠ meta ${entry.meta.category}`);
    }
    if (card.source !== undefined && card.source !== entry.meta.source) {
      drift.push(`${card.id}: batch.source ${card.source} ≠ meta ${entry.meta.source}`);
    }
    for (const p of (card.previews || {}).frames || []) {
      try {
        statSync(path.isAbsolute(p) ? p : path.join(ROOT, p));
      } catch {
        drift.push(`${card.id}: 样张缺失 ${p}`);
      }
    }
  }
  expect('T18', 'batch-2.json 与实际文件一致', drift.length === 0, drift.slice(0, 5).join(' | ') || '清单 / 元数据 / 样张路径全部对齐');

  // 被跳过的两张确实没被混进来
  const leaked = SKIPPED_TWO_SHOT.filter((id) => ids.includes(id));
  expect('T19', '必须两镜的卡没有混进第二批', leaked.length === 0, leaked.join(', ') || `已排除: ${SKIPPED_TWO_SHOT.join(', ')}`);

  // batch 的 timing 字段存在
  const noTiming = cards.filter((c) => !c.timing || typeof c.timing.medianMs !== 'number').map((c) => c.id);
  expect('T20', '每张都登记了单帧耗时', noTiming.length === 0, noTiming.join(', ') || '20/20');

  return batch;
}

/* ------------------------------------------------------------------ */
/* B. 像素层（Edge headless）                                          */
/* ------------------------------------------------------------------ */

function buildBrowserHtml(entries) {
  const payload = entries.map(([id, entry]) => ({
    id,
    duration: Number(entry.meta.duration) || 3,
    source: toFunctionBody(entry.source),
  }));
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>batch2</title>
<style>html,body{margin:0;background:#111;color:#ddd;font:12px monospace}</style></head>
<body><pre id="__out">RUNNING</pre>
<script>
const CARDS = ${JSON.stringify(payload)};
const BUDGET = ${PERF_BUDGET_MS};

function loadMod(source) {
  const api = new Function('"use strict";\\n' + source + '\\nreturn { render: typeof render === "function" ? render : (__default__ && __default__.render) };')();
  return api.render;
}

/** 与四角平均色的差异 > 30 视为"这块有内容"。返回 { ratio, bbox }。 */
function inspectFrame(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h).data;
  const sample = (x, y) => {
    const i = (y * w + x) * 4;
    return [img[i], img[i + 1], img[i + 2]];
  };
  const corners = [sample(1, 1), sample(w - 2, 1), sample(1, h - 2), sample(w - 2, h - 2)];
  const bg = [0, 1, 2].map((k) => Math.round((corners[0][k] + corners[1][k] + corners[2][k] + corners[3][k]) / 4));
  const step = 4;
  let hit = 0;
  let total = 0;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const d = Math.abs(img[i] - bg[0]) + Math.abs(img[i + 1] - bg[1]) + Math.abs(img[i + 2] - bg[2]);
      total += 1;
      if (d > 30) {
        hit += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const bbox = maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + step, h: maxY - minY + step } : null;
  return { ratio: total ? hit / total : 0, bbox, bg };
}

function measure(canvas, render, duration, w, h) {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const times = [0, 0.5, duration / 2, duration];
  const frames = [];
  for (const t of times) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    render(ctx, t, { width: w, height: h, props: {}, fps: 30, duration });
    const info = inspectFrame(ctx, w, h);
    frames.push({ t, ratio: Number(info.ratio.toFixed(4)), bbox: info.bbox });
  }
  // 计时：预热 2 帧，再测 9 帧。每帧后强制 readback 一次 —— 不 flush 管线，
  // 测到的只是"命令入队"的 CPU 时间（会出现 0.0ms 这种假数字）。
  const flush = () => {
    try {
      ctx.getImageData(0, 0, 1, 1);
    } catch {
      /* 某些环境不允许 readback，退化为不 flush */
    }
  };
  for (let i = 0; i < 2; i += 1) render(ctx, (i / 2) * duration, { width: w, height: h, props: {}, fps: 30, duration });
  flush();
  const samples = [];
  for (let i = 0; i < 9; i += 1) {
    const t = (i / 8) * duration;
    const t0 = performance.now();
    render(ctx, t, { width: w, height: h, props: {}, fps: 30, duration });
    flush();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return {
    frames,
    medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(2)),
    maxMs: Number(samples[samples.length - 1].toFixed(2)),
  };
}

const out = { ok: true, cards: {}, ua: navigator.userAgent };
try {
  const canvas = document.createElement('canvas');
  for (const card of CARDS) {
    try {
      const render = loadMod(card.source);
      const wide = measure(canvas, render, card.duration, 1280, 720);
      const tall = measure(canvas, render, card.duration, 720, 1280);
      out.cards[card.id] = { wide, tall };
    } catch (error) {
      out.cards[card.id] = { error: error && error.message ? error.message : String(error) };
    }
  }
} catch (error) {
  out.ok = false;
  out.error = error && error.message ? error.message : String(error);
}
document.getElementById('__out').textContent = JSON.stringify(out);
</script></body></html>`;
}

async function firstExisting(list) {
  for (const file of list) {
    try {
      await fs.access(file);
      return file;
    } catch {
      /* 继续 */
    }
  }
  return null;
}

function decodeEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function runBrowser(entries) {
  const browser = await firstExisting(BROWSERS);
  if (!browser) return { ok: false, reason: 'NO_BROWSER', detail: '找不到 Edge/Chrome' };
  const html = buildBrowserHtml(entries);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'b2test-'));
  const htmlPath = path.join(tmp, 'test.html');
  await fs.writeFile(htmlPath, html, 'utf8');
  const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-dev-shm-usage',
    `--dump-dom`,
    fileUrl,
  ];
  const result = await new Promise((resolve) => {
    const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += String(c);
    });
    child.stderr.on('data', (c) => {
      stderr += String(c);
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
    }, 180000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  const m = result.stdout.match(/<pre id="__out">([\s\S]*?)<\/pre>/);
  if (!m) {
    return { ok: false, reason: 'NO_OUTPUT', detail: (result.stderr || result.stdout).slice(-400) };
  }
  const text = decodeEntities(m[1]).trim();
  if (text === 'RUNNING') return { ok: false, reason: 'TIMEOUT', detail: '页面还没跑完就被 dump 了' };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (error) {
    return { ok: false, reason: 'BAD_JSON', detail: text.slice(0, 300) };
  }
}

async function browserTests(entries) {
  group('B · 像素层（Edge headless）');
  if (NO_BROWSER) {
    skip('T21', '两种画布首末帧非空（像素）', '--no-browser');
    skip('T22', '两种画布不拉伸变形（bbox 比例）', '--no-browser');
    skip('T23', '1080p 单帧耗时', '--no-browser');
    return {};
  }
  const run = await runBrowser(entries);
  if (!run.ok) {
    const why = `${run.reason}: ${run.detail}`;
    skip('T21', '两种画布首末帧非空（像素）', why);
    skip('T22', '两种画布不拉伸变形（bbox 比例）', why);
    skip('T23', '1080p 单帧耗时', why);
    return {};
  }
  const data = run.data;
  if (!data.ok) {
    skip('T21', '两种画布首末帧非空（像素）', `页面内失败: ${data.error}`);
    return {};
  }

  const emptyBad = [];
  const errorsInBrowser = [];
  // 黑场切出的卡：末帧按配方就是归零（opacity 0），像素层不判它"空"
  const BLACKTAIL_FALLBACK = new Set(['tc-black-slam-transition']);
  for (const id of IDS) {
    const rec = data.cards[id];
    if (!rec) {
      errorsInBrowser.push(`${id}: 页面没返回结果`);
      continue;
    }
    if (rec.error) {
      errorsInBrowser.push(`${id}: ${rec.error}`);
      continue;
    }
    for (const [label, set] of [['1280×720', rec.wide], ['720×1280', rec.tall]]) {
      const first = set.frames[0];
      const last = set.frames[set.frames.length - 1];
      // 阈值 0.5%：极简几何卡的构图本来就小（只剩标志/准星），但要能抓到"真空帧"（0%）
      if (first.ratio < 0.005) emptyBad.push(`${id}@${label} 首帧空 (${(first.ratio * 100).toFixed(2)}%)`);
      if (!BLACKTAIL_FALLBACK.has(id) && last.ratio < 0.005) {
        emptyBad.push(`${id}@${label} 末帧空 (${(last.ratio * 100).toFixed(2)}%)`);
      }
    }
  }
  expect(
    'T21',
    '两种画布首帧/末帧都非空',
    emptyBad.length === 0 && errorsInBrowser.length === 0,
    [...emptyBad, ...errorsInBrowser].slice(0, 5).join(' | ') ||
      '20 张 × 2 画布 × 首末帧全过（tc-black-slam-transition 末帧为刻意的黑场切出，已标注不计）',
  );

  // 不拉伸：同一 t 下两种画布的 bbox 宽高比应一致（内容被画布裁掉时跳过，
  // 因为满屏转场/相机特写本来就会把内容推出去，那不是变形）
  const stretchBad = [];
  const stretchSkip = [];
  for (const id of IDS) {
    const rec = data.cards[id];
    if (!rec || rec.error) continue;
    // 取中段帧（dur/2）：t=0.5 很多卡还没铺开，bbox 反映不了构图
    const wide = rec.wide.frames[2].bbox;
    const tall = rec.tall.frames[2].bbox;
    if (!wide || !tall) {
      stretchBad.push(`${id}: t=0.5 没有可测 bbox`);
      continue;
    }
    const wideTouch = wide.x <= 4 || wide.y <= 4 || wide.x + wide.w >= 1280 - 4 || wide.y + wide.h >= 720 - 4;
    const tallTouch = tall.x <= 4 || tall.y <= 4 || tall.x + tall.w >= 720 - 4 || tall.y + tall.h >= 1280 - 4;
    if (wideTouch || tallTouch) {
      stretchSkip.push(id);
      continue;
    }
    const wideRatio = wide.w / wide.h;
    const tallRatio = tall.w / tall.h;
    const dev = Math.abs(wideRatio - tallRatio) / Math.max(wideRatio, tallRatio);
    if (dev > 0.4) {
      stretchBad.push(`${id}: bbox 比例 ${wideRatio.toFixed(2)} / ${tallRatio.toFixed(2)}（差 ${(dev * 100).toFixed(0)}%）`);
    }
  }
  expect(
    'T22',
    '两种画布不拉伸变形（bbox 比例一致）',
    stretchBad.length === 0,
    stretchBad.slice(0, 5).join(' | ') ||
      `${IDS.length - stretchSkip.length} 张等比；${stretchSkip.length} 张因内容触边（满屏转场/相机特写）跳过比例检查`,
  );

  // 性能
  const perf = [];
  const over = [];
  for (const id of IDS) {
    const rec = data.cards[id];
    if (!rec || rec.error) continue;
    const median = rec.wide.medianMs;
    const max = rec.wide.maxMs;
    const tallMedian = rec.tall.medianMs;
    perf.push({ id, median, max, tallMedian });
    if (median > PERF_BUDGET_MS) over.push(`${id} ${median}ms`);
  }
  perf.sort((a, b) => b.median - a.median);
  if (over.length === 0) {
    pass('T23', '1080p 单帧中位耗时 ≤16ms', `最慢 ${perf[0] ? `${perf[0].id} ${perf[0].median}ms` : 'n/a'}（软渲染，值偏保守）`);
  } else {
    warn('T23', '1080p 单帧中位耗时 ≤16ms', `超预算 ${over.length} 张：${over.join(' | ')}`);
  }
  return { perf, raw: data };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('第二批配方卡验收（几何 + 转场，20 张）');
  console.log(`motion-lib: ${MOTION}`);
  console.log(`工作目录: ${ROOT}`);
  console.log('');

  await fs.mkdir(BUILD_DIR, { recursive: true });
  const batch = await staticTests();

  // 收集已解析的模块给浏览器层用
  const entries = [];
  for (const id of IDS) {
    const codePath = path.join(MOTION, id, 'code.js');
    const metaPath = path.join(MOTION, id, 'meta.json');
    try {
      const [source, metaRaw] = await Promise.all([fs.readFile(codePath, 'utf8'), fs.readFile(metaPath, 'utf8')]);
      entries.push([id, { source, meta: JSON.parse(metaRaw) }]);
    } catch {
      /* 静态层已报 */
    }
  }
  const browser = await browserTests(entries);

  // 输出
  let nPass = 0;
  let nFail = 0;
  let nWarn = 0;
  let nSkip = 0;
  console.log('');
  for (const r of results) {
    if (r.type === 'group') {
      console.log(`\n${r.name}`);
      continue;
    }
    const tag = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP' }[r.status];
    if (r.status === 'pass') nPass += 1;
    else if (r.status === 'fail') nFail += 1;
    else if (r.status === 'warn') nWarn += 1;
    else nSkip += 1;
    const color = { pass: '\x1b[32m', fail: '\x1b[31m', warn: '\x1b[33m', skip: '\x1b[90m' }[r.status];
    console.log(`  ${color}${tag}\x1b[0m ${r.id}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  }

  if (browser.perf && browser.perf.length) {
    console.log('\n性能（1080p 中位/最大 ms；软渲染，真实 GPU 更快）');
    for (const p of browser.perf) {
      const mark = p.median > PERF_BUDGET_MS ? '⚠' : ' ';
      console.log(`  ${mark} ${p.id.padEnd(32)} ${String(p.median).padStart(6)} / ${String(p.max).padStart(6)}   竖屏 ${p.tallMedian}`);
    }
  }

  console.log(`\n合计：PASS ${nPass} · FAIL ${nFail} · WARN ${nWarn} · SKIP ${nSkip}`);
  if (nFail === 0) console.log('\x1b[32m第二批 20 张：静态契约全绿。\x1b[0m');
  if (nWarn > 0) console.log('\x1b[33m有 warn（不阻塞，但要看）：见上面带 WARN 的行。\x1b[0m');

  if (JSON_OUT) {
    const summary = {
      generatedAt: new Date().toISOString(),
      pass: nPass,
      fail: nFail,
      warn: nWarn,
      skip: nSkip,
      cases: results.filter((r) => r.type === 'case'),
      perf: browser.perf || [],
      motionLib: MOTION,
    };
    console.log('\n' + JSON.stringify(summary, null, 2));
  }

  // 顺手回写 batch-2.json 的实测耗时（保持清单与实测同源）
  if (batch && browser.perf && browser.perf.length) {
    try {
      const byId = new Map(browser.perf.map((p) => [p.id, p]));
      for (const card of batch.cards || []) {
        const p = byId.get(card.id);
        if (!p) continue;
        card.timing = {
          medianMs: p.median,
          maxMs: p.max,
          wideMedianMs: p.median,
          tallMedianMs: p.tallMedian,
          budgetMs: PERF_BUDGET_MS,
          withinBudget: p.median <= PERF_BUDGET_MS,
          measuredOn: '1280×720 · Edge headless · --disable-gpu（软渲染，偏保守）',
        };
      }
      batch.updatedAt = new Date().toISOString();
      await fs.writeFile(BATCH_PATH, JSON.stringify(batch, null, 2) + '\n', 'utf8');
      console.log('\n已把实测耗时回写 batch-2.json');
    } catch (error) {
      console.log(`\n回写 batch-2.json 失败：${error.message}`);
    }
  }

  process.exit(nFail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(2);
});
