#!/usr/bin/env node
/**
 * 生成一个自包含的测速页：真实浏览器里跑「媒体卡单帧耗时」。
 *
 *   node tools/perf-probe.mjs                 # 写 .build/perf-probe.html
 *   node tools/perf-probe.mjs --out D:/x.html
 *   node tools/perf-probe.mjs --root D:/tmp/motion-lib
 *
 * 为什么要有这个页面：headless 里的数字取决于这台机器给不给 GPU 进程，
 * 而产品真实运行在 DSH 的 WebView（Chromium，有 GPU）里。与其相信别人的
 * 测量口径，不如让你在自己浏览器里点一下 —— 页面顶部会大字打出
 * glRenderer 和它判定出来的环境（gpu / software）。
 *
 * 口径（与 .build/perf/measure.mjs 完全一致，两边共用这一份代码）：
 *   - 画布 1920×1080，ctx 用 getContext('2d', { alpha: false })，与 exporter 一致
 *   - 每张卡：预热 5 帧 → 实测 60 帧，t 均匀铺满 duration（覆盖所有动画阶段）
 *   - 每帧后 getImageData(0,0,1,1) 强制同步，否则测到的是命令入队时间
 *   - 报告 p50 / p95 / max；预算 16ms
 *   - 有素材路径：env.media 提供一张 1600×900 的真位图，props.assetId 指向它
 *
 * 页面自包含：35 份 code.js 全部内联，不联网、不依赖 DSH。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_OUT = path.join(ROOT, '.build', 'perf-probe.html');

export const BUDGET_MS = 16;
export const MEDIA_TAG = 'batch-media-1';
export const MEDIA_ID = 'perf-probe-media';
export const MEDIA_WIDTH = 1600;
export const MEDIA_HEIGHT = 900;
export const FRAME_WIDTH = 1920;
export const FRAME_HEIGHT = 1080;
export const WARM_FRAMES = 5;
export const MEASURE_FRAMES = 60;

export function motionRoot() {
  return process.env.DSH_MOTION_LIB || path.join(os.homedir(), '.dsh', 'motion-lib');
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

/** 把 ESM 源码改写成 `new Function` 能吃的形式（与 render-motion-thumbs 同一套规则）。 */
export function toFunctionBody(source) {
  return String(source)
    .replace(/export\s+default\s+/g, 'const __default__ = ')
    .replace(/export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/g, (m, isAsync, name) => `${isAsync || ''}function ${name}`)
    .replace(/export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g, (m, kind, name) => `${kind} ${name}`)
    .replace(/export\s*\{[^}]*\}/g, '');
}

function durationOf(meta, source) {
  const fromMeta = Number(meta && meta.duration);
  if (fromMeta > 0) return fromMeta;
  const m = /duration\s*:\s*([\d.]+)/.exec(String(source));
  return m ? Number(m[1]) : 3;
}

/**
 * 收集这一批的媒体卡：meta.json 的 tags 里带 batch-media-1。
 * 顺带把 source 读进来，页面里全部内联。
 */
export async function collectCards({ root = motionRoot() } = {}) {
  let dirents = [];
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch {
    throw new Error('动效库目录读不到：' + root);
  }
  const cards = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const id = dirent.name;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) continue;
    const dir = path.join(root, id);
    const meta = await readJson(path.join(dir, 'meta.json'));
    if (!meta || !Array.isArray(meta.tags) || !meta.tags.includes(MEDIA_TAG)) continue;
    const codePath = path.join(dir, 'code.js');
    if (!(await exists(codePath))) continue;
    const source = await fs.readFile(codePath, 'utf8');
    cards.push({
      id,
      title: String(meta.title || id),
      duration: durationOf(meta, source),
      kindClass: String(meta.kindClass || ''),
      source: toFunctionBody(source),
    });
  }
  cards.sort((a, b) => a.id.localeCompare(b.id));
  return cards;
}

// ---------------------------------------------------------------- 页面 ----
//
// 驱动代码刻意避开反引号和 ${}，这样能整段塞进模板字符串而不出错。

const DRIVER = String.raw`
(function () {
  var W = __FRAME_W__, H = __FRAME_H__;
  var WARM = __WARM__, FRAMES = __FRAMES__;
  var MEDIA_W = __MEDIA_W__, MEDIA_H = __MEDIA_H__;
  var MEDIA_ID = __MEDIA_ID__;
  var BUDGET = __BUDGET__;
  var CARDS = window.__CARDS__;

  function now() { return performance.now(); }

  // 让主线程喘一口气：measure() 是同步的，不 yield 页面就是假死。
  function nextTick() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    var idx = Math.ceil(p * sorted.length) - 1;
    if (idx < 0) idx = 0;
    if (idx > sorted.length - 1) idx = sorted.length - 1;
    return sorted[idx];
  }

  function round2(x) { return Math.round(x * 100) / 100; }

  function summarize(samples) {
    var s = samples.slice().sort(function (a, b) { return a - b; });
    var max = s.length ? s[s.length - 1] : 0;
    return {
      n: s.length,
      p50: round2(percentile(s, 0.5)),
      p95: round2(percentile(s, 0.95)),
      max: round2(max),
      mean: round2(s.reduce(function (a, b) { return a + b; }, 0) / (s.length || 1))
    };
  }

  function glInfo() {
    var out = { renderer: null, vendor: null, versions: [], software: false, error: null };
    try {
      var c = document.createElement('canvas');
      c.width = 16; c.height = 16;
      var gl2 = c.getContext('webgl2');
      var gl = gl2 || c.getContext('webgl');
      if (!gl) { out.error = '拿不到 WebGL 上下文'; out.software = true; return out; }
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      out.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      out.vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      out.version = gl.getParameter(gl.VERSION);
      out.backend = gl2 ? 'webgl2' : 'webgl1';
      // SwiftShader / Basic Render Driver / llvmpipe 都是软光栅
      out.software = /swiftshader|software|basic render|llvmpipe|mesa offscreen/i.test(String(out.renderer || ''));
    } catch (e) {
      out.error = String(e && e.message || e);
      out.software = true;
    }
    return out;
  }

  // 一张 1600×900 的「有信息量」位图：渐变 + 色块 + 细网格 + 文字。
  // 之所以不用纯色，是因为纯色位图会让 drawImage 的成本失真。
  function paintMedia() {
    var c = document.createElement('canvas');
    c.width = MEDIA_W; c.height = MEDIA_H;
    var x = c.getContext('2d');
    var g = x.createLinearGradient(0, 0, MEDIA_W, MEDIA_H);
    g.addColorStop(0, '#1b2a4a');
    g.addColorStop(0.45, '#7b3f6b');
    g.addColorStop(1, '#e2a24a');
    x.fillStyle = g;
    x.fillRect(0, 0, MEDIA_W, MEDIA_H);
    for (var i = 0; i < 26; i++) {
      x.fillStyle = 'rgba(255,255,255,' + (0.03 + (i % 5) * 0.02).toFixed(3) + ')';
      var w = 40 + (i * 97) % 320;
      var h = 30 + (i * 61) % 240;
      x.fillRect((i * 173) % MEDIA_W, (i * 251) % MEDIA_H, w, h);
    }
    x.strokeStyle = 'rgba(255,255,255,0.08)';
    x.lineWidth = 1;
    for (var gx = 0; gx < MEDIA_W; gx += 80) { x.beginPath(); x.moveTo(gx, 0); x.lineTo(gx, MEDIA_H); x.stroke(); }
    for (var gy = 0; gy < MEDIA_H; gy += 80) { x.beginPath(); x.moveTo(0, gy); x.lineTo(MEDIA_W, gy); x.stroke(); }
    x.fillStyle = 'rgba(255,255,255,0.85)';
    x.font = '700 96px system-ui, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('PERF', MEDIA_W / 2, MEDIA_H / 2 - 40);
    x.font = '400 40px system-ui, sans-serif';
    x.fillText('1600 x 900', MEDIA_W / 2, MEDIA_H / 2 + 60);
    return c;
  }

  function makeFacade(bitmap) {
    var size = { width: MEDIA_W, height: MEDIA_H };
    return {
      has: function () { return true; },
      video: function () { return bitmap; },
      image: function () { return bitmap; },
      size: function () { return size; },
      kind: function () { return 'video'; },
      time: function () { return 0; }
    };
  }

  function loadCard(source) {
    var body = '"use strict";\n' + source +
      '\nreturn { render: typeof render === "function" ? render : (typeof __default__ !== "undefined" && __default__ && __default__.render) };';
    var api = new Function(body)();
    if (!api || typeof api.render !== 'function') throw new Error('模块没有导出 render(ctx, t, env)');
    return api;
  }

  // 一帧 = render + 强制同步。同步点用 getImageData(0,0,1,1)：
  // 画布是 GPU 加速的，读回会 flush 掉排队的光栅化；不读回就只测到命令入队。
  function measure(api, duration, withMedia, bitmap, syncMode) {
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return { error: '拿不到 2d 上下文' };
    var env = {
      width: W, height: H, fps: 30, duration: duration,
      props: withMedia ? { assetId: MEDIA_ID } : {},
      assets: [],
      media: withMedia ? makeFacade(bitmap) : null
    };
    var samples = [];
    var error = null;
    var i;
    // 预热：把字体、渐变、路径缓存都跑热，避免第一帧的编译开销混进 p50
    for (i = 0; i < WARM; i++) {
      var wt = duration * ((i + 0.5) / WARM);
      try { api.render(ctx, wt, env); } catch (e) { error = String(e && e.message || e); break; }
      if (syncMode !== 'none') ctx.getImageData(0, 0, 1, 1);
    }
    if (!error) {
      for (i = 0; i < FRAMES; i++) {
        var t = duration * ((i + 0.5) / FRAMES);
        var t0 = now();
        try { api.render(ctx, t, env); } catch (e) { error = String(e && e.message || e); break; }
        if (syncMode === 'none') {
          // 什么都不做：测到的是入队时间，用来验证同步点是否有效
        } else if (syncMode === 'full') {
          ctx.getImageData(0, 0, W, H);
        } else {
          ctx.getImageData(0, 0, 1, 1);
        }
        samples.push(now() - t0);
      }
    }
    return { samples: samples, error: error };
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  window.__runPerfProbe = async function (hook) {
    var gl = glInfo();
    var status = el('div', 'status', '准备中…');
    if (hook && hook.status) hook.status(status);
    var bitmap = null;
    if (window.createImageBitmap) {
      try { bitmap = await createImageBitmap(paintMedia()); } catch (e) { bitmap = null; }
    }
    if (!bitmap) bitmap = paintMedia();

    // 校准：什么都不画，只做同样的同步 —— 得到每帧的固定开销
    var blankApi = { render: function () {} };
    var blank = summarize(measure(blankApi, 1, false, bitmap, 'pixel').samples);

    var results = [];
    for (var idx = 0; idx < CARDS.length; idx++) {
      var card = CARDS[idx];
      // 先让页面重绘一次再开测：measure() 是同步的，一张卡 65 帧会让主线程卡住
      // （最重的那张约 4 秒）。不 yield 的话用户看到的是「页面死了两分钟」。
      if (hook && hook.progress) hook.progress(idx, CARDS.length, { id: card.id, title: card.title, pending: true });
      await nextTick();
      var row = { id: card.id, title: card.title, duration: card.duration };
      try {
        var api = loadCard(card.source);
        var plain = measure(api, card.duration, false, bitmap, 'pixel');
        await nextTick();
        var withM = measure(api, card.duration, true, bitmap, 'pixel');
        row.plain = plain.error ? { error: plain.error } : summarize(plain.samples);
        row.withMedia = withM.error ? { error: withM.error } : summarize(withM.samples);
        if (plain.error) row.error = plain.error;
      } catch (e) {
        row.error = String(e && e.message || e);
        row.plain = { error: row.error };
        row.withMedia = { error: row.error };
      }
      results.push(row);
      if (hook && hook.progress) hook.progress(idx + 1, CARDS.length, row);
    }

    // 同步点自检：拿实测最慢的那张，比较「不同步 / 1×1 读回 / 全画布读回」。
    // 如果 none 明显远小于 pixel，就说明 getImageData 确实把光栅化逼出来了；
    // 如果 pixel 与 full 接近，就说明 1×1 的读回没有偷懒只光栅一个像素。
    var syncCheck = null;
    var slowest = results.slice().sort(function (a, b) {
      return ((b.plain && b.plain.p50) || 0) - ((a.plain && a.plain.p50) || 0);
    })[0];
    if (slowest && slowest.plain && !slowest.plain.error) {
      if (hook && hook.progress) hook.progress(CARDS.length, CARDS.length, { id: '同步点自检（' + slowest.id + '）', pending: true });
      await nextTick();
      try {
        var slowCard = null;
        for (var k = 0; k < CARDS.length; k++) if (CARDS[k].id === slowest.id) slowCard = CARDS[k];
        var hApi = loadCard(slowCard.source);
        syncCheck = {
          cardId: slowCard.id,
          none: summarize(measure(hApi, slowCard.duration, false, bitmap, 'none').samples),
          pixel: summarize(measure(hApi, slowCard.duration, false, bitmap, 'pixel').samples),
          full: summarize(measure(hApi, slowCard.duration, false, bitmap, 'full').samples)
        };
      } catch (e) { syncCheck = { error: String(e && e.message || e) }; }
    }

    var payload = {
      generatedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      environment: gl.software ? 'software' : 'gpu',
      glRenderer: gl.renderer,
      glVendor: gl.vendor,
      glVersion: gl.version || null,
      glBackend: gl.backend || null,
      glError: gl.error,
      width: W, height: H,
      warmFrames: WARM, measureFrames: FRAMES,
      media: { width: MEDIA_W, height: MEDIA_H, id: MEDIA_ID },
      budgetMs: BUDGET,
      syncOverheadMs: blank.p50,
      syncCheck: syncCheck,
      perCard: results
    };
    window.__PERF_RESULT__ = payload;
    window.__PERF_DONE__ = true;
    return payload;
  };
})();
`;

function buildDriver() {
  return DRIVER
    .replace('__FRAME_W__', String(FRAME_WIDTH))
    .replace('__FRAME_H__', String(FRAME_HEIGHT))
    .replace('__WARM__', String(WARM_FRAMES))
    .replace('__FRAMES__', String(MEASURE_FRAMES))
    .replace('__MEDIA_W__', String(MEDIA_WIDTH))
    .replace('__MEDIA_H__', String(MEDIA_HEIGHT))
    .replace(/__MEDIA_ID__/g, JSON.stringify(MEDIA_ID))
    .replace('__BUDGET__', String(BUDGET_MS));
}

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0b0d12; color: #e8ecf4;
  font: 14px/1.5 "Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif; }
header { padding: 20px 24px 14px; border-bottom: 1px solid #1d2230; position: sticky; top: 0;
  background: rgba(11,13,18,.97); backdrop-filter: blur(6px); z-index: 2; }
h1 { margin: 0 0 10px; font-size: 15px; font-weight: 600; color: #8b96ad; letter-spacing: .04em; }
#renderer { font-size: 22px; font-weight: 700; line-height: 1.25; word-break: break-all; }
#renderer.software { color: #ff8a5b; }
#renderer.gpu { color: #5ee0a0; }
.badges { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
.badge { padding: 3px 9px; border-radius: 999px; font-size: 12px; border: 1px solid #2a3145; background: #141926; }
.badge.gpu { border-color: #1e5f43; background: #0f2a1f; color: #7ce8b4; }
.badge.software { border-color: #6b3018; background: #2a140c; color: #ffa77f; }
.badge.warn { border-color: #6b5518; background: #2a2109; color: #ffd479; }
button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid #2f6dff;
  background: #1b4bd0; color: #fff; cursor: pointer; }
button:disabled { opacity: .45; cursor: default; }
main { padding: 16px 24px 60px; }
.status { margin: 0 0 12px; color: #8b96ad; font-variant-numeric: tabular-nums; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { padding: 6px 10px; text-align: right; border-bottom: 1px solid #171c28; white-space: nowrap; }
th { color: #7f8aa1; font-weight: 500; font-size: 12px; text-align: right; position: sticky; top: 0; }
th:first-child, td:first-child { text-align: left; }
td.title { color: #9aa6bd; text-align: left; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
tr.over td { color: #ff7a6b; }
tr.over { background: rgba(255, 90, 70, .06); }
tr.running { background: rgba(47, 109, 255, .10); }
tr.running td { color: #9fc0ff; }
td.p50 { font-weight: 700; }
.note { margin: 18px 0 0; color: #6f7b93; font-size: 12px; line-height: 1.7; }
.note code { background: #141926; padding: 1px 5px; border-radius: 4px; }
`;

/** 生成自包含页面。 */
export function buildProbeHtml({ cards, generatedAt = new Date().toISOString() }) {
  const payload = cards.map((c) => ({
    id: c.id, title: c.title, duration: c.duration, kindClass: c.kindClass || '', source: c.source,
  }));
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>媒体卡单帧耗时 · 自测探针</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>媒体卡单帧耗时（1920×1080，${cards.length} 张，预算 ${BUDGET_MS}ms）</h1>
  <div id="renderer">检测中…</div>
  <div class="badges" id="badges"></div>
  <div style="margin-top:12px"><button id="run">开始测速</button>
    <span class="status" id="status" style="margin-left:12px"></span></div>
</header>
<main>
  <table>
    <thead><tr>
      <th>#</th><th style="text-align:left">卡</th><th>时长 s</th>
      <th>p50 无素材</th><th>p50 有素材</th><th>p95</th><th>max</th><th>判定</th>
    </tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <p class="note">
    口径：画布 1920×1080，<code>alpha:false</code>（与 exporter 一致）；每张预热 ${WARM_FRAMES} 帧、实测 ${MEASURE_FRAMES} 帧，
    t 均匀铺满整段时长；每帧后 <code>getImageData(0,0,1,1)</code> 强制光栅同步。
    「有素材」= <code>env.media</code> 给一张 ${MEDIA_WIDTH}×${MEDIA_HEIGHT} 的真位图，
    <code>props.assetId</code> 指向它。
    判定用「无素材 p50 &gt; ${BUDGET_MS}ms」。
    整轮大约 2 分钟（35 张 × 65 帧 × 两条路径），期间页面会逐行出数，不会假死。
  </p>
  <p class="note" id="envline"></p>
</main>
<script>window.__CARDS__ = ${json};</script>
<script>${buildDriver()}</script>
<script>
(function () {
  var rowsEl = document.getElementById('rows');
  var statusEl = document.getElementById('status');
  var runBtn = document.getElementById('run');
  var rendererEl = document.getElementById('renderer');
  var badgesEl = document.getElementById('badges');
  var envlineEl = document.getElementById('envline');
  document.getElementById('envline').textContent = '页面生成于 ${generatedAt}';

  // 先打一发环境信息，不等测速 —— 用户一眼就能看见有没有 GPU
  (function () {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) { rendererEl.textContent = '拿不到 WebGL：无法判断光栅环境'; rendererEl.className = 'software'; return; }
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      var r = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      var soft = /swiftshader|software|basic render|llvmpipe|mesa offscreen/i.test(String(r));
      rendererEl.textContent = r;
      rendererEl.className = soft ? 'software' : 'gpu';
      badgesEl.innerHTML = '';
      var b1 = document.createElement('span');
      b1.className = 'badge ' + (soft ? 'software' : 'gpu');
      b1.textContent = soft ? '软件光栅（数字不代表产品性能）' : '硬件光栅（GPU）';
      badgesEl.appendChild(b1);
      if (soft) {
        var b2 = document.createElement('span');
        b2.className = 'badge warn';
        b2.textContent = '打开 chrome://gpu 看「Rasterization / 2D Canvas」是否为 Hardware accelerated';
        badgesEl.appendChild(b2);
      }
    } catch (e) {
      rendererEl.textContent = '探测失败：' + (e && e.message ? e.message : e);
      rendererEl.className = 'software';
    }
  })();

  var total = window.__CARDS__.length;
  for (var i = 0; i < total; i++) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + (i + 1) + '</td><td class="title"></td><td>' +
      window.__CARDS__[i].duration + '</td><td class="p50"></td><td class="p50"></td><td></td><td></td><td></td>';
    tr.children[1].textContent = window.__CARDS__[i].id;
    tr.children[1].title = window.__CARDS__[i].title;
    rowsEl.appendChild(tr);
  }

  var started = false;
  async function go() {
    if (started) return;
    started = true;
    runBtn.disabled = true;
    statusEl.textContent = '启动中…';
    var payload = await window.__runPerfProbe({
      status: function (node) { statusEl.textContent = node.textContent; },
      progress: function (done, all, row) {
        if (row && row.pending) {
          statusEl.textContent = '测速中 ' + (done + 1) + '/' + all + ' · ' + row.id;
          var pendingRow = rowsEl.children[done];
          if (pendingRow) {
            pendingRow.className = 'running';
            pendingRow.children[7].textContent = '测…';
          }
          return;
        }
        var tr = rowsEl.children[done - 1];
        if (!tr) return;
        var p = row.plain || {};
        var w = row.withMedia || {};
        var budget = 16;
        var over = (p.p50 || 0) > budget;
        tr.className = over ? 'over' : '';
        tr.children[3].textContent = p.error ? '× ' + p.error : (p.p50 + ' ms');
        tr.children[4].textContent = w.error ? '×' : (w.p50 + ' ms');
        tr.children[5].textContent = p.error ? '' : (p.p95 + ' ms');
        tr.children[6].textContent = p.error ? '' : (p.max + ' ms');
        tr.children[7].textContent = p.error ? '报错' : (over ? '超预算' : 'ok');
        statusEl.textContent = '测速中 ' + done + '/' + all + ' · ' + row.id;
      }
    });
    var over = payload.perCard.filter(function (r) {
      return r.plain && !r.plain.error && r.plain.p50 > payload.budgetMs;
    });
    statusEl.textContent = '完成：' + payload.perCard.length + ' 张，超预算 ' + over.length +
      ' 张 · 同步开销 ' + payload.syncOverheadMs + ' ms/帧 · 环境 ' + payload.environment;
    runBtn.textContent = '重新测';
    runBtn.disabled = false;
    started = false;
  }
  runBtn.addEventListener('click', go);
  if (location.hash === '#auto') go();
})();
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- CLI ----

function argValue(name, fallback) {
  const at = process.argv.indexOf(name);
  if (at >= 0 && process.argv[at + 1]) return process.argv[at + 1];
  return fallback;
}

async function main() {
  const root = path.resolve(argValue('--root', motionRoot()));
  const out = path.resolve(argValue('--out', DEFAULT_OUT));
  const cards = await collectCards({ root });
  if (!cards.length) throw new Error('没有找到带 ' + MEDIA_TAG + ' 标签的卡：' + root);
  const html = buildProbeHtml({ cards });
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, html, 'utf8');
  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
  console.log(`媒体卡 ${cards.length} 张 → ${out}（${kb} KB，自包含）`);
  console.log('双击打开，点「开始测速」；页面顶部会打出 glRenderer 与光栅环境。');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}
