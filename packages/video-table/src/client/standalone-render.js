/**
 * 无头渲染页（standalone）：在**没有工作台面板**的情况下，用与面板完全相同的
 * 渲染核（frame-render.js → player.js + code-registry.js）渲帧，然后把 PNG
 * 交回宿主进程。
 *
 * 它由 src/headless.mjs 临时起的 127.0.0.1 http 服务托管：
 *   GET  /job?token=..      取任务（工程文档、代码图层源码、时间点）
 *   GET  /media?token&asset  取素材字节（支持 Range，<video> seek 需要）
 *   POST /result?token      交回 {frames:[{time,dataUrl,width,height}], strip?, errors}
 *
 * 这个页面不写盘、不改工程：它只负责画，落盘与登记都在宿主侧。
 */

import * as player from './player.js';
import { createCodeRegistry } from './code-registry.js';
import { ensureTimelineMedia, renderTimelineFrame } from './frame-render.js';

const params = new URLSearchParams(location.search);
const token = params.get('token') || '';

// 页面级兜底：任何在模块求值阶段就炸掉的错误也必须回传，否则宿主只能等到超时
// （那正是报告里「agent 靠报错文案猜」的老毛病）。
function reportBootError(code, message) {
  try {
    fetch('/result?token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: false, frames: [], strip: null, errors: [{ code, message }] }),
    });
  } catch {
    /* 交不回去就只能等宿主超时 */
  }
}
window.addEventListener('error', (event) => {
  reportBootError('PAGE_ERROR', String((event && event.message) || event));
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event && event.reason;
  reportBootError('PAGE_REJECTION', String((reason && reason.message) || reason));
});

async function getJob() {
  const res = await fetch('/job?token=' + encodeURIComponent(token), { cache: 'no-store' });
  if (!res.ok) throw new Error('取任务失败: HTTP ' + res.status);
  return res.json();
}

function postResult(payload) {
  return fetch('/result?token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function mediaUrl(assetId) {
  return '/media?token=' + encodeURIComponent(token) + '&assetId=' + encodeURIComponent(assetId);
}

async function imageDataOf(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * 「面板 vs 无头」的像素差（MAD，0..1）。
 *
 * 两条路径共用 frame-render.js，所以构图不可能不同；剩下的唯一差异是编码：
 * 面板回 JPEG(0.82)，无头回 PNG。这里就在同一张画布上把两种编码各解一遍，
 * 量出这个差异的真实大小 —— 数字比「应该一样」这句话可信。
 */
async function measureEncodingMad(canvas) {
  const png = canvas.toDataURL('image/png');
  const jpeg = canvas.toDataURL('image/jpeg', 0.82);
  const [a, b] = await Promise.all([imageDataOf(png), imageDataOf(jpeg)]);
  if (a.width !== b.width || a.height !== b.height) return null;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    sum += Math.abs(a.data[i] - b.data[i]);
    sum += Math.abs(a.data[i + 1] - b.data[i + 1]);
    sum += Math.abs(a.data[i + 2] - b.data[i + 2]);
    count += 3;
  }
  return count ? sum / count / 255 : null;
}

/** 把若干帧拼成一张 contact sheet（列 = tile，行按帧数取整）。 */function composeStrip(frames, tile, cellWidth) {
  const cols = Math.max(1, Math.min(8, Math.round(tile) || 4));
  const rows = Math.max(1, Math.ceil(frames.length / cols));
  const first = frames[0];
  const cellHeight = Math.max(2, Math.round((first.height / Math.max(1, first.width)) * cellWidth));
  const canvas = document.createElement('canvas');
  canvas.width = cols * cellWidth;
  canvas.height = rows * cellHeight;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  frames.forEach((frame, index) => {
    const cx = (index % cols) * cellWidth;
    const cy = Math.floor(index / cols) * cellHeight;
    ctx.drawImage(frame.canvas, cx, cy, cellWidth, cellHeight);
    // 角标：每一格左上角标出它在时间线上的秒数，看节奏时不用再去对数
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(cx, cy, 46, 16);
    ctx.fillStyle = '#fff';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(Number(frame.time).toFixed(2) + 's', cx + 4, cy + 8);
  });
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, cols, rows, cellWidth, cellHeight };
}

async function run() {
  const errors = [];
  const job = await getJob();

  const clips = Array.isArray(job.clips) ? job.clips : (job.doc && job.doc.clips) || [];
  const assets = Array.isArray(job.assets) ? job.assets : (job.doc && job.doc.assets) || [];
  const sources = job.codeSources || {};

  // 视频素材补进池：与面板用的是同一个模块级池
  ensureTimelineMedia(assets, mediaUrl);

  let registry = null;
  if (clips.some((c) => c && c.type === 'code')) {
    registry = createCodeRegistry({
      projectId: job.projectId,
      onError: (error, clip) => errors.push({ clipId: clip && clip.id, code: (error && error.code) || 'CODE_LAYER', message: String((error && error.message) || error) }),
      context: () => ({
        assets,
        fps: Number(job.doc && job.doc.fps) || 30,
        duration: Number(job.doc && job.doc.duration) || 0,
        clips,
        tracks: (job.doc && job.doc.tracks) || [],
        revision: Number(job.doc && job.doc.revision) || 0,
        doc: job.doc || {},
      }),
      urlFor: mediaUrl,
      // 源码随任务下发：无头页没有会话，不能走 code.read
      readLayerSource: async (layerId) => {
        const source = sources[layerId];
        if (typeof source !== 'string') throw Object.assign(new Error('缺少图层源码: ' + layerId), { code: 'CODE_SOURCE_MISSING' });
        return source;
      },
    });
  }

  const frames = [];
  for (const t of job.times || []) {
    try {
      const frame = await renderTimelineFrame({
        clips,
        assets,
        t,
        maxDim: job.maxDim || 640,
        code: registry,
      });
      frames.push({
        time: Number(t),
        width: frame.width,
        height: frame.height,
        canvas: frame.canvas,
        dataUrl: frame.canvas.toDataURL('image/png'),
      });
    } catch (error) {
      errors.push({ time: Number(t), code: (error && error.code) || 'RENDER_FAILED', message: String((error && error.message) || error) });
    }
  }

  let strip = null;
  if (job.strip && frames.length) {
    try {
      strip = composeStrip(frames, job.strip.tile, job.strip.cellWidth > 0 ? job.strip.cellWidth : 320);
    } catch (error) {
      errors.push({ code: 'STRIP_FAILED', message: String((error && error.message) || error) });
    }
  }

  // 「面板 vs 无头」的编码差：同一张画布，JPEG(面板) 与 PNG(无头) 解码后的像素差
  let encodingMad = null;
  if (job.madProbe && frames.length) {
    try {
      encodingMad = await measureEncodingMad(frames[0].canvas);
    } catch (error) {
      errors.push({ code: 'MAD_FAILED', message: String((error && error.message) || error) });
    }
  }

  if (registry && typeof registry.dispose === 'function') {
    try {
      registry.dispose();
    } catch {
      /* 释放失败不影响结果 */
    }
  }
  try {
    player.pauseAllVideos();
  } catch {
    /* 忽略 */
  }

  await postResult({
    ok: frames.length > 0,
    frames: frames.map((f) => ({ time: f.time, width: f.width, height: f.height, dataUrl: f.dataUrl })),
    strip,
    encodingMad,
    errors,
    engine: {
      width: frames[0] ? frames[0].width : 0,
      height: frames[0] ? frames[0].height : 0,
      clipCount: clips.length,
      codeLayers: new Set(clips.filter((c) => c.type === 'code').map((c) => c.layerId)).size,
    },
  });
}

run().catch(async (error) => {
  try {
    await postResult({
      ok: false,
      frames: [],
      strip: null,
      errors: [{ code: (error && error.code) || 'PAGE_FAILED', message: String((error && error.message) || error) }],
    });
  } catch {
    /* 连结果都交不回去就只能等宿主超时 */
  }
});
