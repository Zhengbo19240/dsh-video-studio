/**
 * 无头渲染：面板没开的时候，agent 仍然能看见自己的片子。
 *
 * 设计原则只有一条：**不能有第二套画法**。
 * 所以这里不实现任何绘制逻辑 —— 它起一个只活一次的小 http 服务，把
 * src/client/standalone-render.js 页面（它 import 的正是面板用的
 * frame-render.js / player.js / code-registry.js）丢进 Chromium 跑一遍，
 * 页面把 PNG 交回来，宿主落盘。
 *
 * 后端优先级（与产品要求一致，也会写进 video_probe 的返回）：
 *   1) @napi-rs/canvas —— 装了就用它做「拼图 + PNG 处理」这类 Node 侧工作；
 *      注意：视频解码与代码图层 Worker 仍然需要真实浏览器，所以**渲帧**这一步
 *      在两种后端下都是同一个浏览器页面（这是保证像素一致的唯一办法）。
 *   2) Chrome / Edge headless —— 本机默认路径，可用 DSH_VIDEO_HEADLESS_BROWSER 覆盖。
 *   3) 都没有 → HEADLESS_UNAVAILABLE，并把安装提示带回去。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from './domain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, '..');
const SRC_ROOT = path.resolve(PLUGIN_ROOT, 'src');

/** 引擎版本：读插件自己的 package.json，读不到就报 unknown（不猜）。 */
export function engineVersion() {
  try {
    const raw = fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8');
    return String(JSON.parse(raw).version || 'unknown');
  } catch {
    return 'unknown';
  }
}

const BROWSER_CANDIDATES = [
  {
    name: 'chrome',
    paths: [
      process.env.DSH_VIDEO_HEADLESS_BROWSER,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ],
  },
  {
    name: 'edge',
    paths: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/usr/bin/microsoft-edge',
    ],
  },
];

function firstExisting(paths) {
  for (const candidate of paths || []) {
    if (!candidate) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/** 探测本机能不能无头渲帧。只读，不启动任何进程。 */
export function detectHeadless(options = {}) {
  let browser = null;
  for (const entry of BROWSER_CANDIDATES) {
    const found = firstExisting(entry.paths);
    if (found) {
      browser = { name: entry.name, path: found };
      break;
    }
  }
  let napi = false;
  if (options.checkNapi !== false) {
    try {
      // 只探「装没装」：真正的使用在 composeStripWithNapi 里，失败会回落
      const require = options.createRequire ? options.createRequire() : null;
      if (require) {
        require.resolve('@napi-rs/canvas');
        napi = true;
      } else {
        napi = fs.existsSync(path.join(PLUGIN_ROOT, 'node_modules', '@napi-rs', 'canvas', 'index.js'));
      }
    } catch {
      napi = false;
    }
  }
  return {
    available: Boolean(browser),
    browser,
    // 两个 Chromium 的绝对路径都带回去：测试要拿它们做跨内核像素对比
    paths: {
      chrome: firstExisting(BROWSER_CANDIDATES[0].paths),
      edge: firstExisting(BROWSER_CANDIDATES[1].paths),
    },
    backends: {
      napiCanvas: napi,
      chrome: Boolean(firstExisting(BROWSER_CANDIDATES[0].paths)),
      edge: Boolean(firstExisting(BROWSER_CANDIDATES[1].paths)),
    },
    hint: browser
      ? null
      : '装一个 Chromium 系浏览器（Chrome 或 Edge）即可无头渲帧；也可以用环境变量 DSH_VIDEO_HEADLESS_BROWSER 指向它的可执行文件。',
  };
}

// --------------------------------------------------------------- 素材服务 ----

function contentTypeFor(file) {
  const ext = path.extname(String(file)).toLowerCase();
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a') return 'audio/mp4';
  return 'application/octet-stream';
}

function readJsonBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function serveModule(key, res) {
  const rel = String(key || '').replace(/\\/g, '/');
  if (!rel || rel.includes('..') || !/\.(mjs|js)$/.test(rel)) {
    res.statusCode = 404;
    return res.end('not found');
  }
  const abs = path.resolve(SRC_ROOT, rel);
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

const PAGE_HTML = `<!doctype html>
<meta charset="utf-8">
<title>video-workbench headless render</title>
<style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block}</style>
<script>
  // 这段必须是经典脚本、且在模块之前：模块连加载都失败时（路径/语法/CSP），
  // 只有它能把这个失败交回宿主，而不是让宿主干等到超时。
  window.__bootFail = function (code, message) {
    try {
      var token = new URLSearchParams(location.search).get('token') || '';
      fetch('/result?token=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: false, frames: [], strip: null, errors: [{ code: code, message: String(message) }] })
      });
    } catch (e) { /* 交不回去就只能等超时 */ }
  };
  window.addEventListener('error', function (e) { window.__bootFail('PAGE_ERROR', e.message || e); }, true);
  window.addEventListener('unhandledrejection', function (e) { window.__bootFail('PAGE_REJECTION', (e.reason && e.reason.message) || e.reason); });
</script>
<script type="module" src="/mod/client/standalone-render.js" onerror="window.__bootFail('MODULE_LOAD_FAILED','standalone-render.js')"></script>
`;

/**
 * 把一帧帧 PNG 拼成 contact sheet（napi 后端）。
 * 只有 @napi-rs/canvas 装了才会被调用；失败一律抛出去让调用方回落。
 */
export async function composeStripWithNapi(frames, tile, cellWidth) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const cols = Math.max(1, Math.min(8, Math.round(tile) || 4));
  const rows = Math.max(1, Math.ceil(frames.length / cols));
  const first = frames[0];
  const cellHeight = Math.max(2, Math.round((first.height / Math.max(1, first.width)) * cellWidth));
  const canvas = createCanvas(cols * cellWidth, rows * cellHeight);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < frames.length; index += 1) {
    const image = await loadImage(Buffer.from(frames[index].buffer));
    const cx = (index % cols) * cellWidth;
    const cy = Math.floor(index / cols) * cellHeight;
    ctx.drawImage(image, cx, cy, cellWidth, cellHeight);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(cx, cy, 46, 16);
    ctx.fillStyle = '#fff';
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(Number(frames[index].time).toFixed(2) + 's', cx + 4, cy + 8);
  }
  return { buffer: canvas.toBuffer('image/png'), width: canvas.width, height: canvas.height, cols, rows, backend: 'napi' };
}

// ------------------------------------------------------------------ 任务 ----

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 用浏览器渲染一组时间点。
 *
 * @param {object} input
 *   root       工程目录（PNG 落到 <root>/.dsh-video/samples）
 *   doc        工程文档（要 clips/assets/fps/duration）
 *   clips      时间线片段（默认取 doc.clips）
 *   assets     素材清单（默认取 doc.assets）
 *   times      时间点数组（秒）
 *   maxDim     画布上限（默认 640）
 *   codeSources {layerId: source}，代码图层源码
 *   strip      {tile, cellWidth} 可选：顺便出一张 contact sheet
 *   timeoutMs  默认 60000
 *   browser    指定浏览器可执行文件（测试注入）
 * @returns {{frames, strip, via, backend, errors, sampleDir}}
 */
export async function renderFramesHeadless(input) {
  const root = path.resolve(input.root);
  const doc = input.doc || {};
  const clips = Array.isArray(input.clips) ? input.clips : doc.clips || [];
  const assets = Array.isArray(input.assets) ? input.assets : doc.assets || [];
  const times = (input.times || []).map(Number).filter((t) => Number.isFinite(t) && t >= 0);
  if (!times.length) throw new DomainError('INVALID_ARG', '没有可渲染的时间点');

  const detected = detectHeadless({ checkNapi: input.checkNapi !== false });
  const browserPath = input.browser || (detected.browser && detected.browser.path);
  if (!browserPath) {
    throw new DomainError('HEADLESS_UNAVAILABLE', '本机没有可用于无头渲帧的浏览器', {
      hint: detected.hint,
      backends: detected.backends,
    });
  }

  const sampleDir = path.join(root, '.dsh-video', 'samples');
  await fsp.mkdir(sampleDir, { recursive: true });

  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const job = {
    ok: true,
    projectId: doc.projectId || input.projectId || null,
    doc: {
      projectId: doc.projectId || null,
      revision: doc.revision || 0,
      fps: doc.fps || 30,
      duration: doc.duration || 0,
      tracks: doc.tracks || [],
    },
    clips,
    assets,
    codeSources: input.codeSources || {},
    times,
    maxDim: input.maxDim || 640,
    // 让页面顺便量一次「同一张画布 PNG vs JPEG(面板编码)」的像素差
    madProbe: Boolean(input.madProbe),
    // napi 能拼图时就不让页面拼：页面少做一件事，输出仍由同一张帧图拼出来
    strip: input.strip && !detected.backends.napiCanvas ? input.strip : null,
  };

  const assetLookup = new Map(assets.map((a) => [a.id, a]));
  const state = { result: null, resolve: null, reject: null };
  const debug = process.env.DSH_VIDEO_HEADLESS_DEBUG === '1';
  const trace = (line) => {
    if (debug) console.error('[headless] ' + line);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      trace(req.method + ' ' + url.pathname);
      res.on('finish', () => trace('  -> ' + res.statusCode + ' ' + url.pathname));
      // /page 与 /mod/* 不带 token：ES 模块的相对 import 会丢掉 query，而它们只是
      // 源码静态文件（服务只监听 127.0.0.1、端口随机、随任务关闭）。带数据的
      // /job、/media、/result 仍然一律校验 token。
      const needsToken = url.pathname === '/job' || url.pathname === '/media' || url.pathname === '/result';
      if (needsToken && url.searchParams.get('token') !== token) {
        res.statusCode = 403;
        return res.end('forbidden');
      }
      if (url.pathname === '/page') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        return res.end(PAGE_HTML);
      }
      if (url.pathname.startsWith('/mod/')) {
        return serveModule(decodeURIComponent(url.pathname.slice('/mod/'.length)), res);
      }
      if (url.pathname === '/job') {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        return res.end(JSON.stringify(job));
      }
      if (url.pathname === '/media') {
        const asset = assetLookup.get(url.searchParams.get('assetId'));
        if (!asset) {
          res.statusCode = 404;
          return res.end('no asset');
        }
        const rel = asset.path || asset.relPath;
        const abs = path.resolve(root, rel || '');
        if (!abs.startsWith(root + path.sep)) {
          res.statusCode = 403;
          return res.end('forbidden');
        }
        let stat;
        try {
          stat = await fsp.stat(abs);
        } catch {
          res.statusCode = 404;
          return res.end('missing');
        }
        const range = req.headers.range;
        res.setHeader('accept-ranges', 'bytes');
        res.setHeader('content-type', asset.mime || contentTypeFor(abs));
        res.setHeader('cache-control', 'no-store');
        if (!range) {
          res.statusCode = 200;
          res.setHeader('content-length', String(stat.size));
          return fs.createReadStream(abs).pipe(res);
        }
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
        if (!m) {
          res.statusCode = 416;
          return res.end();
        }
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = Math.min(m[2] ? parseInt(m[2], 10) : stat.size - 1, stat.size - 1);
        res.statusCode = 206;
        res.setHeader('content-range', `bytes ${start}-${end}/${stat.size}`);
        res.setHeader('content-length', String(end - start + 1));
        return fs.createReadStream(abs, { start, end }).pipe(res);
      }
      if (url.pathname === '/result' && req.method === 'POST') {
        const body = await readJsonBody(req);
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end('{"ok":true}');
        if (!state.result) {
          state.result = body;
          if (state.resolve) state.resolve(body);
        }
        return undefined;
      }
      res.statusCode = 404;
      return res.end('not found');
    } catch (error) {
      res.statusCode = 500;
      res.end(String((error && error.message) || error));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const pageUrl = `http://127.0.0.1:${port}/page?token=${encodeURIComponent(token)}`;

  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vw-headless-'));
  const flags = [
    '--headless=new',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profileDir}`,
    '--window-size=1280,800',
    pageUrl,
  ];
  const extra = String(process.env.DSH_VIDEO_HEADLESS_FLAGS || '').trim();
  if (extra) flags.unshift(...extra.split(/\s+/).filter(Boolean));
  if (process.env.DSH_VIDEO_HEADLESS_DEBUG === '1') flags.unshift('--enable-logging=stderr', '--v=0');

  const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : 60000;
  const child = spawn(browserPath, flags, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  try {
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
  } catch {
    /* 忽略 */
  }

  const waitResult = new Promise((resolve, reject) => {
    state.resolve = resolve;
    state.reject = reject;
    const timer = setTimeout(() => {
      reject(
        new DomainError('HEADLESS_TIMEOUT', `无头渲染 ${timeoutMs}ms 内没有回传结果`, {
          backend: browserPath,
          stderr: stderr.slice(-800),
        }),
      );
    }, timeoutMs);
    const finish = (fn) => (value) => {
      clearTimeout(timer);
      fn(value);
    };
    state.resolve = finish(resolve);
    state.reject = finish(reject);
    child.once('error', (error) => state.reject(new DomainError('HEADLESS_FAILED', `启动浏览器失败: ${error.message}`)));
    child.once('exit', (code) => {
      // 页面已经回传时正常退出不算失败
      if (!state.result) {
        setTimeout(() => {
          if (!state.result) {
            state.reject(
              new DomainError('HEADLESS_FAILED', `浏览器提前退出（code=${code}）且没有回传结果`, { stderr: stderr.slice(-800) }),
            );
          }
        }, 300);
      }
    });
  });

  let payload;
  try {
    payload = await waitResult;
  } finally {
    killTree(child);
    try {
      server.close();
    } catch {
      /* 忽略 */
    }
    fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }

  const stamp = Date.now().toString(36);
  const written = [];
  for (const frame of payload.frames || []) {
    const b64 = String(frame.dataUrl || '').split(',')[1];
    if (!b64) continue;
    const name = `h_${stamp}_${Math.round((frame.time || 0) * 1000)}.png`;
    const abs = path.join(sampleDir, name);
    const buffer = Buffer.from(b64, 'base64');
    await fsp.writeFile(abs, buffer);
    written.push({ time: frame.time, path: abs, width: frame.width, height: frame.height, bytes: buffer.length });
  }
  if (!written.length) {
    const first = (payload.errors || [])[0];
    throw new DomainError('HEADLESS_FAILED', '无头渲染没有产出任何帧', {
      errors: payload.errors || [],
      detail: first ? first.message : null,
    });
  }

  let strip = null;
  if (input.strip) {
    if (detected.backends.napiCanvas) {
      try {
        const buffers = await Promise.all(written.map((f) => fsp.readFile(f.path)));
        const composed = await composeStripWithNapi(
          buffers.map((buffer, index) => ({ buffer, time: written[index].time, width: written[index].width, height: written[index].height })),
          input.strip.tile,
          input.strip.cellWidth || 320,
        );
        const abs = path.join(sampleDir, `strip_napi_${stamp}.png`);
        await fsp.writeFile(abs, composed.buffer);
        strip = { path: abs, width: composed.width, height: composed.height, cols: composed.cols, rows: composed.rows, backend: 'napi' };
      } catch {
        strip = null; // 回落页面拼图
      }
    }
    if (!strip && payload.strip) {
      const b64 = String(payload.strip.dataUrl || '').split(',')[1];
      if (b64) {
        const abs = path.join(sampleDir, `strip_${stamp}.png`);
        await fsp.writeFile(abs, Buffer.from(b64, 'base64'));
        strip = {
          path: abs,
          width: payload.strip.width,
          height: payload.strip.height,
          cols: payload.strip.cols,
          rows: payload.strip.rows,
          backend: 'browser',
        };
      }
    }
    if (!strip && input.strip) {
      const errs = (payload.errors || []).filter((e) => e.code === 'STRIP_FAILED');
      if (errs.length) throw new DomainError('HEADLESS_FAILED', '拼 contact sheet 失败: ' + errs[0].message);
    }
  }

  return {
    frames: written,
    strip,
    encodingMad: typeof payload.encodingMad === 'number' ? payload.encodingMad : null,
    via: 'headless',
    backend: path.basename(browserPath),
    errors: payload.errors || [],
    sampleDir,
    engine: payload.engine || null,
  };
}
