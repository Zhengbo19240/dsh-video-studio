#!/usr/bin/env node
/**
 * 给动效库里的每一条 native 卡批量出缩略图。
 *
 *   node tools/render-motion-thumbs.mjs                 # 全量，幂等
 *   node tools/render-motion-thumbs.mjs --force         # 全部重出
 *   node tools/render-motion-thumbs.mjs --only count-up,tc-chart-grow
 *   node tools/render-motion-thumbs.mjs --root D:/tmp/motion-lib --report D:/tmp/report.json
 *
 * 一张缩略图 = 三个时刻（0 / 50% / 末帧前 5%）各渲染 480×270，横向拼成 1440×270。
 * 为什么不用 node canvas：本机没有 `canvas` 依赖。走本机 Edge / Chrome 的 headless
 * 模式，在页面里用真正的 Canvas2D 跑 code.js 的 render，再把 canvas.toDataURL()
 * 通过 --dump-dom 带回来 —— 这样输出尺寸由 canvas 决定，不受屏幕 DPI 影响。
 *
 * 幂等：meta.render.fingerprint = code.js 的 mtime + size。指纹没变且 thumb.png
 * 还在，就跳过；code.js 一改（mtime 变），下一次批量会自动补图。
 *
 * 单卡失败不中断整批：失败写进报告 entries[].error，并汇总到 failures。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const THUMB_WIDTH = 480;
export const THUMB_HEIGHT = 270;
export const THUMB_FRAMES = 3;
export const THUMB_FILE = 'thumb.png';
export const THUMB_REASON = '需要外部渲染器，暂无原生实现';
const COMPOSITE_BG = '#16181d';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPORT = path.join(HERE, 'recipes', 'motion-thumbs-report.json');

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

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

async function writeJson(file, value) {
  const tmp = file + '.tmp-' + process.pid;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
}

/** code.js 的指纹：mtime（毫秒取整）+ 字节数。改一个字就会变。 */
export async function fingerprintOf(codePath) {
  const stat = await fs.stat(codePath);
  return `${Math.round(stat.mtimeMs)}:${stat.size}`;
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

/** 三个取样时刻：开头 / 一半 / 末帧前 5%。 */
export function timesForDuration(duration) {
  const d = Number(duration) > 0 ? Number(duration) : 3;
  return [0, round3(d * 0.5), round3(d * 0.95)];
}

/** 从 8 字节签名 + IHDR 读 PNG 的真实尺寸，不信任文件名。 */
export function parsePngSize(buffer) {
  if (!buffer || buffer.length < 24) return null;
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 把 ESM 源码改写成 `new Function` 能吃的形式（与 render-card-preview 同一套规则）。 */
function toFunctionBody(source) {
  return String(source)
    .replace(/export\s+default\s+/g, 'const __default__ = ')
    .replace(/export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/g, (m, isAsync, name) => `${isAsync || ''}function ${name}`)
    .replace(/export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g, (m, kind, name) => `${kind} ${name}`)
    .replace(/export\s*\{[^}]*\}/g, '');
}

/** 生成离屏页面：三帧分别画在独立 canvas 上，再合成到 1440×270，并把 dataURL 写进 DOM。 */
export function buildThumbHtml({ id, source, times, duration }) {
  const body = toFunctionBody(source);
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:${COMPOSITE_BG};}</style></head>
<body>
<pre id="thumb-out"></pre><pre id="thumb-stats"></pre><pre id="thumb-error"></pre>
<script>
const SOURCE = ${JSON.stringify(body)};
const ID = ${JSON.stringify(id)};
const TIMES = ${JSON.stringify(times)};
const W = ${THUMB_WIDTH}, H = ${THUMB_HEIGHT}, N = ${THUMB_FRAMES};
const DURATION = ${JSON.stringify(duration)};

function renderAll() {
  const api = new Function('"use strict";\\n' + SOURCE + '\\nreturn { render: typeof render === "function" ? render : (__default__ && __default__.render) };')();
  if (typeof api.render !== 'function') throw new Error('模块没有导出 render(ctx, t, env)');

  const frames = [];
  for (let i = 0; i < TIMES.length; i += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    api.render(ctx, TIMES[i], { width: W, height: H, props: {}, fps: 30, duration: DURATION });
    frames.push(canvas);
  }
  if (frames.length !== N) throw new Error('渲染帧数 ' + frames.length + '，期望 ' + N);

  const out = document.createElement('canvas');
  out.width = W * N;
  out.height = H;
  const octx = out.getContext('2d');
  octx.fillStyle = '${COMPOSITE_BG}';
  octx.fillRect(0, 0, out.width, out.height);
  for (let i = 0; i < frames.length; i += 1) octx.drawImage(frames[i], i * W, 0);

  // —— 体检：帧间差异 + 每格亮度/标准差。只用于标记「废图」，不阻断出图。
  // 判据基于合成图（深色底），这样纯文字卡不会因为「字是白的」被误判成全白；
  // 真正的空白格标准差接近 0。
  function frameInfo(canvas) {
    const data = canvas.getContext('2d').getImageData(0, 0, W, H).data;
    let opaque = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 8) opaque += 1;
    return { data: data, opaque: opaque };
  }
  function diffStats(a, b) {
    const da = a.data, db = b.data;
    let changed = 0;
    let total = 0;
    let sum = 0;
    for (let i = 0; i < da.length; i += 28) {
      total += 1;
      const oa = da[i + 3] / 255, ob = db[i + 3] / 255;
      const la = 0.2126 * da[i] + 0.7152 * da[i + 1] + 0.0722 * da[i + 2];
      const lb = 0.2126 * db[i] + 0.7152 * db[i + 1] + 0.0722 * db[i + 2];
      const delta = Math.abs(la * oa - lb * ob);
      sum += delta;
      if (delta > 8 || Math.abs(da[i + 3] - db[i + 3]) > 24) changed += 1;
    }
    return { changed: total ? changed / total : 0, mad: total ? sum / total : 0 };
  }

  const infos = frames.map(frameInfo);
  const contentRatio = Math.max.apply(null, infos.map(function (x) { return x.opaque; }).concat([0])) / (W * H);
  const diffs = [diffStats(infos[0], infos[1]), diffStats(infos[1], infos[2]), diffStats(infos[0], infos[2])]
    .map(function (x) { return Math.round(x.changed * 10000) / 10000; });
  const mads = [diffStats(infos[0], infos[1]), diffStats(infos[1], infos[2]), diffStats(infos[0], infos[2])]
    .map(function (x) { return Math.round(x.mad * 100) / 100; });

  const luma = [];
  const std = [];
  for (let i = 0; i < N; i += 1) {
    const cell = octx.getImageData(i * W, 0, W, H).data;
    let sum = 0;
    let sum2 = 0;
    const count = W * H;
    for (let p = 0; p < cell.length; p += 4) {
      const l = 0.2126 * cell[p] + 0.7152 * cell[p + 1] + 0.0722 * cell[p + 2];
      sum += l;
      sum2 += l * l;
    }
    const mean = sum / count;
    luma.push(Math.round(mean * 10) / 10);
    std.push(Math.round(Math.sqrt(Math.max(0, sum2 / count - mean * mean)) * 10) / 10);
  }

  let reason = null;
  if (Math.max.apply(null, std) < 1.2) reason = '画面基本是纯色（全黑/全白，看不出内容）';
  else if (Math.max.apply(null, diffs) < 0.002 && Math.max.apply(null, mads) < 0.1) reason = '三帧几乎一样';

  document.getElementById('thumb-out').textContent = out.toDataURL('image/png');
  document.getElementById('thumb-stats').textContent = JSON.stringify({
    luma: luma,
    std: std,
    diff: diffs,
    mad: mads,
    content: Math.round(contentRatio * 10000) / 10000,
    suspicious: reason,
  });
}

try {
  renderAll();
} catch (error) {
  document.getElementById('thumb-error').textContent = (error && error.message) ? error.message : String(error);
}
</script>
</body></html>`;
}

async function firstExisting(list) {
  for (const file of list) {
    if (await exists(file)) return file;
  }
  return null;
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      done({ code: -1, stdout, stderr: stderr + '\n超时' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => done({ code: -1, stdout, stderr: stderr + '\n' + error.message }));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

/** 用 headless 浏览器跑页面，拿回三帧拼接后的 PNG Buffer。 */
export async function renderThumbPng({ id, source, times, duration, browser, workDir, timeoutMs = 30000 }) {
  const htmlPath = path.join(workDir, `thumb-${id}.html`);
  await fs.writeFile(htmlPath, buildThumbHtml({ id, source, times, duration }), 'utf8');
  const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
  const result = await runProcess(browser, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--virtual-time-budget=8000',
    '--dump-dom',
    fileUrl,
  ], timeoutMs);

  const errorMatch = /<pre id="thumb-error">([\s\S]*?)<\/pre>/.exec(result.stdout);
  const errorText = errorMatch ? decodeEntities(errorMatch[1]).trim() : '';
  if (errorText) throw new Error('render 抛错：' + errorText);

  const outMatch = /<pre id="thumb-out">(data:image\/png;base64,([A-Za-z0-9+/=]+))<\/pre>/.exec(result.stdout);
  if (!outMatch) {
    const tail = result.stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
    throw new Error(`没有拿到 PNG（exit ${result.code}）：${tail || 'dump-dom 输出里没有 dataURL'}`);
  }
  let stats = null;
  const statsMatch = /<pre id="thumb-stats">([\s\S]*?)<\/pre>/.exec(result.stdout);
  if (statsMatch) {
    try {
      stats = JSON.parse(decodeEntities(statsMatch[1]));
    } catch {
      stats = null;
    }
  }
  return { png: Buffer.from(outMatch[2], 'base64'), stats };
}

function durationFromSource(source) {
  const m = /duration\s*:\s*([\d.]+)/.exec(String(source));
  return m ? Number(m[1]) : 0;
}

async function atomicWrite(file, buffer) {
  const tmp = file + '.tmp-' + process.pid;
  await fs.writeFile(tmp, buffer);
  await fs.rename(tmp, file);
}

/** 处理一张卡。失败时抛错，由 runBatch 兜住。 */
async function processEntry(dir, options) {
  const id = path.basename(dir);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    throw new Error('目录名不是合法条目 id');
  }
  const metaPath = path.join(dir, 'meta.json');
  const codePath = path.join(dir, 'code.js');
  const thumbPath = path.join(dir, THUMB_FILE);
  const meta = await readJson(metaPath);
  const thumbStat = await statOrNull(thumbPath);

  if (!(await exists(codePath))) {
    const next = Object.assign({}, meta, { thumb: null, thumbReason: THUMB_REASON });
    await writeJson(metaPath, next);
    return { id, status: 'needRender', thumb: null, thumbReason: THUMB_REASON, fingerprint: null };
  }

  const fingerprint = await fingerprintOf(codePath);
  if (
    !options.force &&
    meta.thumb === THUMB_FILE &&
    meta.render &&
    meta.render.fingerprint === fingerprint &&
    thumbStat &&
    thumbStat.size > 0
  ) {
    return { id, status: 'skipped', thumb: thumbPath, fingerprint, thumbAt: meta.thumbAt || null };
  }

  const source = await fs.readFile(codePath, 'utf8');
  const duration = Number(meta.duration) > 0 ? Number(meta.duration) : durationFromSource(source) || 3;
  const times = timesForDuration(duration);
  const { png, stats } = await renderThumbPng({
    id,
    source,
    times,
    duration,
    browser: options.browser,
    workDir: options.workDir,
    timeoutMs: options.timeoutMs,
  });
  const size = parsePngSize(png);
  const expected = { width: THUMB_WIDTH * THUMB_FRAMES, height: THUMB_HEIGHT };
  if (!size || size.width !== expected.width || size.height !== expected.height) {
    throw new Error(`PNG 尺寸不对：${size ? size.width + '×' + size.height : '不是 PNG'}，期望 ${expected.width}×${expected.height}`);
  }

  await atomicWrite(thumbPath, png);
  const thumbAt = new Date().toISOString();
  const next = Object.assign({}, meta, {
    thumb: THUMB_FILE,
    thumbAt,
    render: {
      fingerprint,
      width: THUMB_WIDTH,
      height: THUMB_HEIGHT,
      frames: THUMB_FRAMES,
    },
  });
  await writeJson(metaPath, next);
  return {
    id,
    status: 'rendered',
    thumb: thumbPath,
    fingerprint,
    thumbAt,
    duration,
    times,
    stats,
    bytes: png.length,
  };
}

/** 并发池：浏览器进程比较重，默认 3 路。 */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 跑一批。options:
 *   root, force, only（id 数组）, concurrency, browser, timeoutMs, quiet
 * 返回报告对象（同时由 CLI 写盘）。
 */
export async function runBatch(options = {}) {
  const root = path.resolve(options.root || motionRoot());
  const force = Boolean(options.force);
  const only = Array.isArray(options.only) && options.only.length ? new Set(options.only) : null;
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency) || 3));
  const browser = options.browser || (await firstExisting(BROWSERS));
  if (!browser) {
    const error = new Error('找不到 Chromium 浏览器（Edge/Chrome），无法出真实 PNG');
    error.code = 'NO_BROWSER';
    throw error;
  }

  let dirents = [];
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch {
    throw new Error('动效库目录读不到：' + root);
  }
  const dirs = dirents.filter((d) => d.isDirectory()).map((d) => path.join(root, d.name)).sort();
  const targets = only ? dirs.filter((dir) => only.has(path.basename(dir))) : dirs;

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-thumbs-'));
  const startedAt = new Date().toISOString();
  const entries = [];

  try {
    const worker = async (dir) => {
      const id = path.basename(dir);
      try {
        const entry = await processEntry(dir, { force, browser, workDir, timeoutMs: options.timeoutMs });
        if (!options.quiet) {
          const extra = entry.status === 'rendered' ? `  ${entry.times.join('/')}s` : '';
          console.log(`  ok   ${id}  [${entry.status}]${extra}`);
        }
        return entry;
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        if (!options.quiet) console.log(`  FAIL ${id}  :: ${message}`);
        return { id, status: 'failed', thumb: null, error: message };
      }
    };
    const results = await pool(targets, concurrency, worker);
    entries.push(...results);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  const summary = {
    total: entries.length,
    rendered: entries.filter((e) => e.status === 'rendered').length,
    skipped: entries.filter((e) => e.status === 'skipped').length,
    needRender: entries.filter((e) => e.status === 'needRender').length,
    failed: entries.filter((e) => e.status === 'failed').length,
    suspicious: entries.filter((e) => e.stats && e.stats.suspicious).length,
  };
  const report = {
    generatedAt: new Date().toISOString(),
    startedAt,
    root,
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    frames: THUMB_FRAMES,
    thumbFile: THUMB_FILE,
    force,
    browser,
    summary,
    failures: entries.filter((e) => e.status === 'failed').map((e) => ({ id: e.id, error: e.error })),
    suspicious: entries
      .filter((e) => e.stats && e.stats.suspicious)
      .map((e) => ({ id: e.id, reason: e.stats.suspicious, diff: e.stats.diff, mad: e.stats.mad, luma: e.stats.luma, std: e.stats.std })),
    entries,
  };
  return report;
}

function argValue(name, fallback) {
  const at = process.argv.indexOf(name);
  if (at >= 0 && process.argv[at + 1]) return process.argv[at + 1];
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function main() {
  const root = argValue('--root', motionRoot());
  const reportPath = path.resolve(argValue('--report', DEFAULT_REPORT));
  const onlyArg = argValue('--only', '');
  const only = onlyArg ? onlyArg.split(',').map((x) => x.trim()).filter(Boolean) : null;
  const concurrency = Number(argValue('--concurrency', 3));

  console.log(`动效缩略图：${root}`);
  console.log(`每张 ${THUMB_WIDTH}×${THUMB_HEIGHT} × ${THUMB_FRAMES} = ${THUMB_WIDTH * THUMB_FRAMES}×${THUMB_HEIGHT}${hasFlag('--force') ? '（--force）' : ''}`);

  const report = await runBatch({
    root,
    force: hasFlag('--force'),
    only,
    concurrency,
    timeoutMs: Number(argValue('--timeout', 30000)),
  });

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  const s = report.summary;
  console.log(`\n完成：共 ${s.total} 条 | 出图 ${s.rendered} | 跳过 ${s.skipped} | 不可渲染 ${s.needRender} | 失败 ${s.failed} | 可疑 ${s.suspicious}`);
  if (s.failed) {
    console.log('失败清单：');
    for (const failure of report.failures) console.log(`  - ${failure.id}: ${failure.error}`);
  }
  if (s.suspicious) {
    console.log('可疑缩略图（纯色 / 三帧几乎一样）：');
    for (const item of report.suspicious) console.log(`  - ${item.id}: ${item.reason}`);
  }
  console.log('报告：' + reportPath);
  // 单卡失败已经写进报告，不算整批失败；只有读不到库、找不到浏览器这类致命错误才非零退出。
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((error) => {
    console.error(error && error.code ? `${error.code}: ${error.message}` : error && error.stack ? error.stack : error);
    process.exit(1);
  });
}
