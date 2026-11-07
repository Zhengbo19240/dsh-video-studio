#!/usr/bin/env node
/**
 * 把 motion-lib 里的一张卡渲染成真实 PNG 样张。
 *
 *   node tools/render-card-preview.mjs --id tc-bar-chart-growth
 *   node tools/render-card-preview.mjs --id tc-chart-grow --times 0,1,2 --width 640 --height 360
 *   node tools/render-card-preview.mjs --id count-up --out .build/preview-count-up.png
 *
 * 为什么不用 node canvas：本机 node_modules 里没有 `canvas`，也不许往产品目录装依赖。
 * 所以走本机已有的 Chromium（Edge / Chrome）的 headless 模式：页面里用真正的
 * Canvas2D 跑 code.js 的 render，`--screenshot` 截下来就是真图。
 *
 * 页面里每个时刻一个 canvas，横向拼成一张图；每一格下面写 t 和卡 id。
 * 退出码：0 出图成功；1 浏览器找不到 / 截图失败；2 卡不存在或渲染抛错。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BROWSERS = [
  process.env.DSH_PREVIEW_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

export function motionRoot() {
  return process.env.DSH_MOTION_LIB || path.join(os.homedir(), '.dsh', 'motion-lib');
}

async function firstExisting(list) {
  for (const file of list) {
    try {
      await fs.access(file);
      return file;
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

function argValue(name, fallback) {
  const at = process.argv.indexOf(name);
  if (at >= 0 && process.argv[at + 1]) return process.argv[at + 1];
  return fallback;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** 把 ESM 源码改写成 `new Function` 能吃的形式（与 code-layer 的兜底同一套规则）。 */
function toFunctionBody(source) {
  return String(source)
    .replace(/export\s+default\s+/g, 'const __default__ = ')
    .replace(/export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/g, (m, isAsync, name) => `${isAsync || ''}function ${name}`)
    .replace(/export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g, (m, kind, name) => `${kind} ${name}`)
    .replace(/export\s*\{[^}]*\}/g, '');
}

/** 生成离屏页面：每个 time 一个 canvas，同步渲染，页面 load 即完成。 */
export function buildHtml(options) {
  const { id, source, times, width, height, meta } = options;
  const duration = Number(meta && meta.duration) > 0 ? Number(meta.duration) : times[times.length - 1] || 1;
  const safeTimes = times.map((t) => Math.max(0, Math.min(Number(t) || 0, duration)));
  const body = toFunctionBody(source);

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<style>
  html,body { margin:0; padding:0; background:#16181d; }
  .row { display:flex; gap:12px; padding:12px; }
  .cell { display:flex; flex-direction:column; align-items:center; gap:6px; }
  canvas { display:block; background:#1b1e24; border-radius:6px; }
  .cap { color:#c9ced8; font:12px/1.4 system-ui, "Segoe UI", sans-serif; letter-spacing:.3px; }
</style></head>
<body>
<div class="row" id="row"></div>
<script>
const SOURCE = ${JSON.stringify(body)};
const ID = ${JSON.stringify(id)};
const TIMES = ${JSON.stringify(safeTimes)};
const W = ${Number(width)}, H = ${Number(height)};
const DURATION = ${JSON.stringify(duration)};

function fail(message) {
  document.body.innerHTML = '<pre style="color:#ff8080;font:13px monospace;padding:16px">' +
    ID + ' 渲染失败：' + message + '</pre>';
  window.__previewError = message;
}

try {
  const api = new Function('"use strict";\\n' + SOURCE + '\\nreturn { render: typeof render === "function" ? render : (__default__ && __default__.render), meta: typeof meta === "object" ? meta : (__default__ && __default__.meta) };')();
  if (typeof api.render !== 'function') throw new Error('模块没有导出 render');

  const row = document.getElementById('row');
  for (const t of TIMES) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    // 不预填背景：画布保持透明，露出页面深色底。
    // 卡若需要白底（图表卡），必须在 render 里自己 fillRect —— 与真实图层一致。
    api.render(ctx, t, { width: W, height: H, props: {}, fps: 30, duration: DURATION });
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = ID + ' · t=' + t + 's / ' + DURATION + 's';
    cell.appendChild(canvas);
    cell.appendChild(cap);
    row.appendChild(cell);
  }
  window.__previewReady = true;
} catch (error) {
  fail(error && error.message ? error.message : String(error));
}
</script>
</body></html>`;
}

/** 用 headless 浏览器截图；返回输出路径。 */
export async function screenshot(htmlPath, outPath, options = {}) {
  const browser = options.browser || (await firstExisting(BROWSERS));
  if (!browser) {
    const error = new Error('找不到 Chromium 浏览器（Edge/Chrome），无法出真实 PNG');
    error.code = 'NO_BROWSER';
    throw error;
  }
  const width = Math.round(options.width || 480);
  const height = Math.round(options.height || 320);
  const count = Math.max(1, Number(options.count) || 1);
  const viewportW = count * (width + 12) + 12;
  const viewportH = height + 12 * 2 + 26;
  const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--virtual-time-budget=4000',
    `--window-size=${viewportW},${viewportH}`,
    `--screenshot=${outPath}`,
    fileUrl,
  ];
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const result = await new Promise((resolve) => {
    const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
    }, 30000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: stderr + '\n' + error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
  const stat = await fs.stat(outPath).catch(() => null);
  if (!stat || stat.size === 0) {
    const error = new Error(`headless 截图失败（exit ${result.code}）：${result.stderr.trim().split('\n').slice(-3).join(' | ')}`);
    error.code = 'SCREENSHOT_FAILED';
    throw error;
  }
  return { browser, outPath, bytes: stat.size };
}

/** 读一张卡（code.js + meta.json），出样张。 */
export async function renderCardPreview(options = {}) {
  const id = String(options.id || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('非法条目 id');
  const root = options.motionRoot || motionRoot();
  const dir = path.join(root, id);
  const source = await fs.readFile(path.join(dir, 'code.js'), 'utf8');
  let meta = {};
  try {
    meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    meta = {};
  }
  const width = Number(options.width) || 480;
  const height = Number(options.height) || Math.round((width * 9) / 16);
  const duration = Number(options.duration) || Number(meta.duration) || 3;
  const times = Array.isArray(options.times) && options.times.length
    ? options.times
    : [0, duration / 2, duration];
  const html = buildHtml({ id, source, times, width, height, meta: { duration } });
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-preview-'));
  const htmlPath = path.join(work, 'preview.html');
  await fs.writeFile(htmlPath, html, 'utf8');
  const outPath = path.resolve(options.out || path.join(process.cwd(), '.build', `preview-${id}.png`));
  try {
    const shot = await screenshot(htmlPath, outPath, { width, height, count: times.length, browser: options.browser });
    return { id, times, outPath, bytes: shot.bytes, browser: shot.browser };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const id = argValue('--id');
  if (!id) {
    console.error('用法：node tools/render-card-preview.mjs --id <motion-lib id> [--times 0,1,2] [--width 480] [--out x.png]');
    process.exit(2);
  }
  const timesArg = argValue('--times');
  const times = timesArg ? timesArg.split(',').map(Number) : undefined;
  const result = await renderCardPreview({
    id,
    times,
    width: Number(argValue('--width', 480)),
    height: Number(argValue('--height', 0)) || undefined,
    out: argValue('--out'),
    browser: argValue('--browser'),
  });
  console.log(`${result.id} → ${result.outPath} (${result.bytes} bytes, t=${result.times.join('/')})`);
  console.log(`browser: ${result.browser}`);
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((error) => {
    console.error(error && error.code ? `${error.code}: ${error.message}` : error && error.stack ? error.stack : error);
    process.exit(error && error.code === 'NO_BROWSER' ? 1 : 2);
  });
}
