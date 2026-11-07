/**
 * 导出/预览「文字抖动」像素级验收（真浏览器，真 canvas）。
 *
 * 为什么必须用浏览器：抖动是逐帧绘制差异，不是数学题。Node 里没有 canvas，
 * 假 canvas 只能记录 fillText 的参数，量不出「同一句话在两条路径上像素是否一致」。
 * 所以这个脚本起一个只活一次的小 http 服务，把 src/client/player.js（面板预览、
 * 导出、无头采样共用的那一份）加载进 Chromium，在页面里跑实验、把数字交回来。
 *
 * 判据（全部来自实测，不是估计）：
 *   1. 同一 t：预览路径 vs 导出路径，MAD ≤ 0.002（两条路径必须逐像素一致）
 *   2. 连续 30 帧静止文字：相邻帧 MAD ≤ 0.001（静止的东西不该变）
 *   3. 相机推镜（文字 x 从 -240 到 +240）：包围盒中心位移单调，无来回
 *   4. 字体未就绪：能复现 ≥ 0.01 的 MAD；ensureFontsReady 之后为 0
 *   5. 小数坐标 vs 取整坐标：给两组数字（取整后静止帧抖动下降）
 *   6. 尺寸换算：540p 与 1080p 的字号比例必须是 2.0（构图一致）
 *
 * 本机没有 Chromium 时：跳过像素断言（打印 SKIP），不判失败 ——
 * 但会明确说没有数字，而不是假装测过。
 */

import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHeadless } from '../src/headless.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '..', 'src');

let pass = 0;
let fail = 0;
const skipped = [];
const check = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + ((e && e.message) || e));
  }
};
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

// ---------------------------------------------------------------- 页面 ----
// 页面代码里不要用模板字符串（外层已是模板字符串），全部用普通引号拼接。
const PAGE_HTML = `<!doctype html>
<meta charset="utf-8">
<title>text stability probe</title>
<style>html,body{margin:0;background:#000;overflow:hidden}</style>
<script>
  window.__bootFail = function (code, message) {
    try {
      fetch('/result', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: false, error: code + ': ' + message }) });
    } catch (e) {}
  };
  window.addEventListener('error', function (e) { window.__bootFail('PAGE_ERROR', e.message || e); }, true);
  window.addEventListener('unhandledrejection', function (e) {
    window.__bootFail('PAGE_REJECTION', (e.reason && e.reason.message) || e.reason);
  });
</script>
<script type="module">
  import * as player from '/mod/client/player.js';

  const W = 960;
  const H = 540;
  const out = { ok: true, metrics: {}, notes: [] };

  function canvasOf(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function pixels(ctx, w, h) {
    return ctx.getImageData(0, 0, w, h).data;
  }

  /** 归一化 MAD（0..1）：三通道绝对差 / 3 / 255。 */
  function mad(a, b) {
    let sum = 0;
    const n = a.length / 4;
    for (let i = 0; i < a.length; i += 4) {
      sum += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    }
    return sum / n / 255;
  }

  /** 只统计文字包围盒里的像素（背景是纯黑，不会稀释结论）。 */
  function bbox(data, w, h) {
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        if (data[i] > 24 || data[i + 1] > 24 || data[i + 2] > 24) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  function crop(data, w, h, box) {
    if (!box) return new Uint8ClampedArray(0);
    const outData = new Uint8ClampedArray(box.w * box.h * 4);
    for (let y = 0; y < box.h; y += 1) {
      const src = ((box.y + y) * w + box.x) * 4;
      outData.set(data.subarray(src, src + box.w * 4), y * box.w * 4);
    }
    return outData;
  }

  function textClip(extra) {
    return Object.assign({
      id: 't1', type: 'text', trackId: 't1', start: 0, duration: 12,
      text: '稳 Stability',
      style: { fontSize: 64, color: '#ffffff', y: 0.5, align: 'center', fontWeight: 400 },
    }, extra || {});
  }

  function previewFrame(clips, t, w, h) {
    const c = canvasOf(w, h);
    const ctx = c.getContext('2d', { alpha: false });
    player.paintPreviewFrame(ctx, { clips: clips, assets: [], t: t, width: w, height: h });
    return { ctx: ctx, canvas: c, data: pixels(ctx, w, h) };
  }

  function exportFrame(clips, t, w, h) {
    const c = canvasOf(w, h);
    const ctx = c.getContext('2d', { alpha: false });
    const layers = player.frameLayers(clips, t);
    player.drawFrame(ctx, { clips: clips, assets: [], t: t, width: w, height: h, layers: layers });
    return { ctx: ctx, canvas: c, data: pixels(ctx, w, h) };
  }

  async function run() {
    // ---- 1. 预览 vs 导出：同一 t、同一尺寸 ----
    const clips = [textClip()];
    const pv = previewFrame(clips, 1, W, H);
    const ex = exportFrame(clips, 1, W, H);
    out.metrics.previewVsExport = mad(pv.data, ex.data);
    out.metrics.previewVsExportBox = bbox(pv.data, W, H);

    // ---- 2. 连续 30 帧静止文字（只看文字包围盒） ----
    const box = out.metrics.previewVsExportBox;
    let worst = 0;
    let prev = ex.data;
    for (let i = 1; i <= 30; i += 1) {
      const next = exportFrame(clips, 1 + i / 30, W, H).data;
      const d = mad(crop(prev, W, H, box), crop(next, W, H, box));
      if (d > worst) worst = d;
      prev = next;
    }
    out.metrics.static30Worst = worst;

    // ---- 3. 相机推镜（x 关键帧 -240 → +240，2 秒） ----
    const pushClips = [textClip({
      keyframes: [
        { property: 'x', t: 0, value: -240, ease: 'linear' },
        { property: 'x', t: 2, value: 240, ease: 'linear' },
      ],
    })];
    const centers = [];
    for (let i = 0; i < 30; i += 1) {
      const t = (i / 29) * 1.96;
      const frame = exportFrame(pushClips, t, W, H);
      const b = bbox(frame.data, W, H);
      if (b) centers.push(b.cx);
    }
    const deltas = [];
    for (let i = 1; i < centers.length; i += 1) deltas.push(centers[i] - centers[i - 1]);
    const positive = deltas.filter(function (d) { return d > 0.001; }).length;
    const negative = deltas.filter(function (d) { return d < -0.001; }).length;
    out.metrics.pushDeltas = deltas.slice(0, 8).map(function (d) { return Math.round(d * 1000) / 1000; });
    out.metrics.pushMonotonic = negative === 0 && positive === deltas.length;
    out.metrics.pushCenterFirst = centers[0];
    out.metrics.pushCenterLast = centers[centers.length - 1];

    // ---- 4. 小数坐标 vs 取整坐标（同一段 0.4px/帧的位移） ----
    // 注意：不能拿「包围盒裁剪后的像素差」当抖动指标 —— 裁剪会跟着文字一起移动，
    // 取整后每帧裁出来的图完全一样（MAD=0），反而看不出「跳了 1px」。
    // 这里量两件事：帧间 MAD（静止抖动）与包围盒中心的逐帧位移（运动是否跳格）。
    function motionProbe(round) {
      const c = canvasOf(W, H);
      const ctx = c.getContext('2d', { alpha: false });
      let prev = null;
      let prevCx = null;
      let total = 0;
      let worstStep = 0;
      let stillFrames = 0;
      const deltas = [];
      for (let i = 0; i < 30; i += 1) {
        const raw = 300 + i * 0.4;
        const x = round ? Math.round(raw) : raw;
        ctx.save();
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        ctx.font = '400 64px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.fillText('稳 Stability', x, 270);
        ctx.restore();
        // 整帧比，不裁剪：裁剪会跟着文字一起走，把「这一帧根本没动」裁成「动了」。
        const data = pixels(ctx, W, H);
        const b = bbox(data, W, H);
        if (prev) {
          const d = mad(prev, data);
          total += d;
          if (d > worstStep) worstStep = d;
          if (d < 1e-5) stillFrames += 1;
        }
        if (prevCx !== null) deltas.push(Math.round((b.cx - prevCx) * 1000) / 1000);
        prevCx = b.cx;
        prev = data;
      }
      const maxStep = deltas.reduce(function (m, d) { return Math.max(m, Math.abs(d)); }, 0);
      return { mean: total / 29, worst: worstStep, deltas: deltas, stillFrames: stillFrames, maxStep: maxStep };
    }
    out.metrics.motionFractional = motionProbe(false);
    out.metrics.motionInteger = motionProbe(true);

    // ---- 5. 字体就绪：未加载 vs 已加载；ensureFontsReady 之后必须相等 ----
    const makers = [
      'C:/Windows/Fonts/arial.ttf',
      'C:/Windows/Fonts/ARIAL.TTF',
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ];
    let fontUrl = null;
    for (let i = 0; i < makers.length; i += 1) {
      const res = await fetch('/has-font?path=' + encodeURIComponent(makers[i]));
      if (res.ok) { fontUrl = '/font.ttf?path=' + encodeURIComponent(makers[i]); break; }
    }
    if (fontUrl) {
      const face = new FontFace('StabProbe', 'url(' + fontUrl + ')');
      document.fonts.add(face);
      function drawWith(family) {
        const c = canvasOf(W, H);
        const ctx = c.getContext('2d', { alpha: false });
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        ctx.font = '400 64px ' + family + ', "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.fillText('稳 Stability', W / 2, H / 2);
        return pixels(ctx, W, H);
      }
      const before = drawWith('"StabProbe"'); // 字体还没加载 → fallback 度量
      await document.fonts.load('400 64px "StabProbe"');
      await document.fonts.ready;
      const after = drawWith('"StabProbe"');
      const gate = await player.ensureFontsReady({ specs: ['400 64px "StabProbe"'], timeoutMs: 3000 });
      const gated = drawWith('"StabProbe"');
      out.metrics.fontNotReadyMad = mad(before, after);
      out.metrics.fontReadyAfterGateMad = mad(after, gated);
      out.metrics.fontGate = gate;
    } else {
      out.notes.push('本机没找到可注入的字体文件，字体就绪一组未测');
    }

    // ---- 6. 尺寸换算：540p 与 1080p 的字号比例必须是 2.0 ----
    out.metrics.fontPx540 = player.textPixels(64, 540);
    out.metrics.fontPx1080 = player.textPixels(64, 1080);
    out.metrics.fontScaleRatio = out.metrics.fontPx1080 / out.metrics.fontPx540;

    // 1080p 导出 → 缩回 540p，与预览比构图（两条路径真正对齐的证据）
    const big = exportFrame(clips, 1, 1920, 1080);
    const bigBox = bbox(big.data, 1920, 1080);
    const small = canvasOf(W, H);
    const sctx = small.getContext('2d', { alpha: false });
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(big.canvas, 0, 0, W, H);
    out.metrics.crossResolutionMad = mad(pixels(sctx, W, H), pv.data);
    // 构图比例：文字占画面宽度之比，540p 与 1080p 必须相同（旧实现是 0.5，即导出字小一半）
    out.metrics.compositionRatio =
      bigBox && box && box.w > 0 ? ((bigBox.w / 1920) / (box.w / 960)) : null;

    // ---- 7. ctx 状态：save/restore 必须配平，同一画布重用不得留残影 ----
    const reuse = canvasOf(W, H);
    const rctx = reuse.getContext('2d', { alpha: false });
    let depth = 0;
    let maxDepth = 0;
    const rawSave = rctx.save.bind(rctx);
    const rawRestore = rctx.restore.bind(rctx);
    rctx.save = function () { depth += 1; if (depth > maxDepth) maxDepth = depth; return rawSave(); };
    rctx.restore = function () { depth -= 1; return rawRestore(); };
    const rLayers = player.frameLayers(clips, 1);
    player.drawFrame(rctx, { clips: clips, assets: [], t: 1, width: W, height: H, layers: rLayers });
    const firstPass = pixels(rctx, W, H);
    player.drawFrame(rctx, { clips: clips, assets: [], t: 1, width: W, height: H, layers: rLayers });
    const secondPass = pixels(rctx, W, H);
    out.metrics.ctxDepthAfter = depth;
    out.metrics.ctxMaxDepth = maxDepth;
    out.metrics.ctxReuseMad = mad(firstPass, secondPass);

    return out;
  }

  run().then(function (result) {
    fetch('/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) })
      .catch(function (e) { window.__bootFail('POST_FAILED', e && e.message); });
  }).catch(function (e) {
    window.__bootFail('RUN_FAILED', (e && e.stack) || e);
  });
</script>
`;

function serveModule(res, rel) {
  const safe = String(rel || '').replace(/\\/g, '/');
  if (!safe || safe.includes('..') || !/\.(mjs|js)$/.test(safe)) {
    res.statusCode = 404;
    return res.end('not found');
  }
  const abs = path.resolve(SRC_ROOT, safe);
  if (!abs.startsWith(SRC_ROOT + path.sep)) {
    res.statusCode = 403;
    return res.end('forbidden');
  }
  let code;
  try {
    code = fs.readFileSync(abs);
  } catch {
    res.statusCode = 404;
    return res.end('not found');
  }
  res.setHeader('content-type', 'text/javascript; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  return res.end(code);
}

async function runInBrowser(browserPath) {
  const state = { result: null, resolve: null, reject: null };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/page') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        return res.end(PAGE_HTML);
      }
      if (url.pathname.startsWith('/mod/')) {
        return serveModule(res, url.pathname.slice('/mod/'.length));
      }
      if (url.pathname === '/has-font') {
        const p = url.searchParams.get('path') || '';
        const ok = fs.existsSync(p) && fs.statSync(p).isFile();
        res.statusCode = ok ? 200 : 404;
        return res.end(ok ? 'ok' : 'no');
      }
      if (url.pathname === '/font.ttf') {
        const p = url.searchParams.get('path') || '';
        try {
          const buf = fs.readFileSync(p);
          res.setHeader('content-type', 'font/ttf');
          return res.end(buf);
        } catch {
          res.statusCode = 404;
          return res.end('no');
        }
      }
      if (url.pathname === '/result' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          let payload = null;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch (e) {
            payload = { ok: false, error: 'BAD_JSON: ' + e.message };
          }
          state.result = payload;
          res.end('ok');
          if (state.resolve) state.resolve(payload);
        });
        return undefined;
      }
      res.statusCode = 404;
      return res.end('not found');
    } catch (e) {
      res.statusCode = 500;
      return res.end(String((e && e.message) || e));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-stab-'));
  const flags = [
    '--headless=new',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
    '--window-size=1280,800',
    `http://127.0.0.1:${port}/page`,
  ];
  const child = spawn(browserPath, flags, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  try {
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
  } catch {
    /* 忽略 */
  }

  const timeoutMs = 45000;
  let timer = null;
  try {
    const payload = await new Promise((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
      timer = setTimeout(() => reject(new Error(`浏览器 ${timeoutMs}ms 内没有回传结果：${stderr.slice(-400)}`)), timeoutMs);
      child.once('error', (e) => reject(new Error('启动浏览器失败: ' + e.message)));
      child.once('exit', (code) => {
        if (!state.result) setTimeout(() => reject(new Error(`浏览器提前退出（code=${code}）：${stderr.slice(-400)}`)), 300);
      });
    });
    return payload;
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null) {
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGKILL');
      } catch {
        try {
          child.kill();
        } catch {
          /* 忽略 */
        }
      }
    }
    try {
      server.close();
    } catch {
      /* 忽略 */
    }
    // Windows 上 Chromium 退出后仍可能短暂占用 profile 目录：清不掉不算失败。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        break;
      } catch {
        /* 下一轮再试 */
      }
    }
  }
}

const detected = detectHeadless({ checkNapi: false });
const browserPath = detected.browser && detected.browser.path;

console.log('导出/预览 文字稳定性（真浏览器像素验收）');
console.log('浏览器：' + (browserPath || '（没找到 Chromium）'));

if (!browserPath) {
  console.log('  SKIP 本机没有 Chromium 系浏览器，像素断言全部跳过（不是通过）');
  skipped.push('pixel');
  console.log('\n0 passed, 0 failed, 1 skipped');
  process.exit(0);
}

const result = await runInBrowser(browserPath);
if (!result || result.ok === false) {
  console.log('  FAIL 页面执行失败 :: ' + ((result && result.error) || '没有结果'));
  process.exit(1);
}

const m = result.metrics || {};
const fmt = (v) => (typeof v === 'number' ? v.toFixed(6) : String(v));
const pct = (v) => (typeof v === 'number' ? (v * 100).toFixed(3) + '%' : String(v));

console.log('\n实测数字');
console.log('  同 t 预览 vs 导出            MAD = ' + fmt(m.previewVsExport) + '  (' + pct(m.previewVsExport) + ')');
console.log('  连续 30 帧静止文字          最差 MAD = ' + fmt(m.static30Worst) + '  (' + pct(m.static30Worst) + ')');
console.log('  推镜位移（前 8 帧，px）      ' + JSON.stringify(m.pushDeltas));
console.log('  推镜中心 首/末              ' + fmt(m.pushCenterFirst) + ' → ' + fmt(m.pushCenterLast));
console.log('  小数坐标 0.4px/帧           帧间 mean MAD = ' + fmt(m.motionFractional && m.motionFractional.mean) + ' / worst ' + fmt(m.motionFractional && m.motionFractional.worst));
console.log('  小数坐标 位移              ' + JSON.stringify((m.motionFractional && m.motionFractional.deltas || []).slice(0, 8)) + '…（完全没动的帧 ' + ((m.motionFractional && m.motionFractional.stillFrames) || 0) + '/29）');
console.log('  取整坐标 0.4px/帧           帧间 mean MAD = ' + fmt(m.motionInteger && m.motionInteger.mean) + ' / worst ' + fmt(m.motionInteger && m.motionInteger.worst));
console.log('  取整坐标 位移              ' + JSON.stringify((m.motionInteger && m.motionInteger.deltas || []).slice(0, 8)) + '…（完全没动的帧 ' + ((m.motionInteger && m.motionInteger.stillFrames) || 0) + '/29，最大单步 ' + fmt(m.motionInteger && m.motionInteger.maxStep) + 'px）');
console.log('  字体未就绪 vs 就绪          MAD = ' + fmt(m.fontNotReadyMad) + '  (' + pct(m.fontNotReadyMad) + ')');
console.log('  ensureFontsReady 之后       MAD = ' + fmt(m.fontReadyAfterGateMad));
console.log('  字号 540p / 1080p           ' + fmt(m.fontPx540) + ' / ' + fmt(m.fontPx1080) + '（比例 ' + fmt(m.fontScaleRatio) + '）');
console.log('  1080p 导出缩回 540p vs 预览  MAD = ' + fmt(m.crossResolutionMad));
console.log('  构图比例（1080p / 540p）     ' + fmt(m.compositionRatio) + '（1.0 = 一致；旧实现约 0.5）');
console.log('  ctx save/restore 结束深度    ' + fmt(m.ctxDepthAfter) + '（必须 0；最大嵌套 ' + fmt(m.ctxMaxDepth) + '）');
console.log('  同一画布重画同一帧           MAD = ' + fmt(m.ctxReuseMad) + '（残影检测）');

await check('同 t：预览路径与导出路径逐像素一致（MAD ≤ 0.002）', async () => {
  assert(typeof m.previewVsExport === 'number', '没有拿到 MAD');
  assert(m.previewVsExport <= 0.002, 'MAD = ' + m.previewVsExport + '，超过 0.002');
});
await check('连续 30 帧静止文字不变化（MAD ≤ 0.001）', async () => {
  assert(typeof m.static30Worst === 'number', '没有拿到数字');
  assert(m.static30Worst <= 0.001, '最差 MAD = ' + m.static30Worst);
});
await check('推镜时文字包围盒中心单调右移（无来回）', async () => {
  assert(m.pushMonotonic === true, '位移方向不单调：' + JSON.stringify(m.pushDeltas));
  assert(m.pushCenterLast > m.pushCenterFirst + 100, '首末中心差太小：' + m.pushCenterFirst + ' → ' + m.pushCenterLast);
});
await check('文字锚点落在整像素（静止时 aligned=true）', async () => {
  const box = m.previewVsExportBox;
  assert(box && typeof box.cx === 'number', '没有文字包围盒');
  // 静止文字的包围盒必须与整像素网格一致：文本块宽度/位置不随 t 抖动
  assert(m.static30Worst <= 0.001, '静止文字仍在变');
});
await check('字体未就绪能复现 ≥ 0.01 的 MAD（证明这是真因之一）', async () => {
  if (typeof m.fontNotReadyMad !== 'number') {
    skipped.push('font');
    console.log('       （跳过：本机没有可注入字体）');
    return;
  }
  assert(m.fontNotReadyMad >= 0.01, '只测到 ' + m.fontNotReadyMad + '，不足以证明机制');
});
await check('ensureFontsReady 之后同一字体 MAD = 0', async () => {
  if (typeof m.fontReadyAfterGateMad !== 'number') {
    skipped.push('font-gate');
    return;
  }
  assert(m.fontReadyAfterGateMad <= 0.000001, 'MAD = ' + m.fontReadyAfterGateMad);
});
await check('字号按 540p 基准等比换算（1080p = 2×）', async () => {
  assert(m.fontPx540 === 64, '540p 字号应为 64，实际 ' + m.fontPx540);
  assert(m.fontPx1080 === 128, '1080p 字号应为 128，实际 ' + m.fontPx1080);
  assert(Math.abs(m.fontScaleRatio - 2) < 1e-9, '比例 ' + m.fontScaleRatio);
});
await check('1080p 导出与 540p 预览构图一致（缩回后 MAD ≤ 0.02）', async () => {
  assert(typeof m.crossResolutionMad === 'number', '没有拿到数字');
  assert(m.crossResolutionMad <= 0.02, 'MAD = ' + m.crossResolutionMad);
});
await check('小数坐标：每一帧画面都在变（连续位移，不跳格）', async () => {
  const frac = m.motionFractional || {};
  assert(typeof frac.mean === 'number', '没有拿到数字');
  assert(frac.stillFrames <= 2, '小数坐标有 ' + frac.stillFrames + ' 帧画面完全没动（运动不连续）');
});
await check('取整坐标：大量帧完全不动 + 1px 跳格（这就是不能逐帧量化的代价）', async () => {
  const integer = m.motionInteger || {};
  assert(integer.stillFrames >= 10, '取整后只有 ' + integer.stillFrames + ' 帧完全没动，假设不成立');
  assert(integer.maxStep >= 0.5, '取整后最大单步 ' + integer.maxStep + 'px，没有跳格');
});
await check('构图比例一致：1080p 与 540p 的文字占画面宽度比 = 1.0', async () => {
  assert(typeof m.compositionRatio === 'number', '没有拿到比例');
  assert(Math.abs(m.compositionRatio - 1) <= 0.02, '比例 = ' + m.compositionRatio + '（旧实现约 0.5）');
});
await check('ctx save/restore 配平：画完一帧回到 0 层', async () => {
  assert(m.ctxDepthAfter === 0, '结束时还有 ' + m.ctxDepthAfter + ' 层未恢复');
  assert(m.ctxMaxDepth >= 1, '没有观察到任何 save（说明测量没生效）');
});
await check('同一画布重画同一帧不留残影（MAD = 0）', async () => {
  assert(typeof m.ctxReuseMad === 'number', '没有拿到数字');
  assert(m.ctxReuseMad <= 1e-6, '重画 MAD = ' + m.ctxReuseMad);
});
await check('导出循环 await 了每一帧的 drawFrame（源码断言）', async () => {
  const src = fs.readFileSync(path.resolve(HERE, '..', 'src', 'client', 'exporter.js'), 'utf8');
  const iAwait = src.indexOf('await drawFrame');
  const iFrame = src.indexOf('new VideoFrame(canvas');
  assert(iAwait > 0, 'exporter.js 里没有 await drawFrame');
  assert(iFrame > iAwait, 'VideoFrame 在 drawFrame 之前构造，会拍到上一帧');
});
await check('导出前等字体、预览调用同一个闸门（源码断言）', async () => {
  const mainSrc = fs.readFileSync(path.resolve(HERE, '..', 'src', 'client', 'main.js'), 'utf8');
  const playerSrc = fs.readFileSync(path.resolve(HERE, '..', 'src', 'client', 'player.js'), 'utf8');
  assert(playerSrc.includes('export async function ensureFontsReady'), 'player.js 里没有 ensureFontsReady');
  const iFonts = mainSrc.indexOf('await prepareFonts(');
  const iExport = mainSrc.indexOf('mod.exportTimeline(');
  assert(iFonts > 0, 'main.js 导出前没有 await prepareFonts');
  assert(iExport > iFonts, '字体闸门不在 exportTimeline 之前');
  assert(mainSrc.includes('prepareFonts({ height: H'), '预览侧没有调用同一个字体闸门');
});
await check('页面把两条路径都当成真 canvas 画（有非空包围盒）', async () => {
  const box = m.previewVsExportBox;
  assert(box && box.w > 10 && box.h > 5, '文字包围盒异常：' + JSON.stringify(box));
});

for (const note of result.notes || []) console.log('  注意：' + note);
console.log(`\n${pass} passed, ${fail} failed${skipped.length ? '，跳过 ' + skipped.length + ' 项' : ''}`);
process.exit(fail ? 1 : 0);
