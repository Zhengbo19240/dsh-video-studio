/**
 * 帧渲染核：面板采样（sampler.js）与无头渲染（standalone-render.js）共用这一份。
 *
 * 为什么必须共用：
 *   报告里最痛的一条是「agent 看不见自己的片子」。如果无头路径自己再写一套
 *   画法，它看到的就不是面板（以及导出）看到的东西 —— 那等于给了 agent 一只
 *   偏色的眼睛。所以这里只做三件事：
 *     1) 把 <video> 池 seek 到目标时刻（playe.js 的同一个池）；
 *     2) 用 player.frameLayers 摊平图层（转场/变速/效果都在里面）；
 *     3) 用 player.drawFrame 画到画布上，代码图层走调用方给的 renderLayers/canvasFor。
 *   面板传 JPEG 编码，无头传 PNG —— 除了编码，像素来源完全同一条路径。
 */

import * as player from './player.js';

/** 采样画布的基准尺寸（与旧 sampler.js 保持一致，不要改：会改变历史采样图的构图）。 */
export const SAMPLE_WIDTH = 960;
export const SAMPLE_HEIGHT = 540;

/** maxDim → 画布尺寸。规则与旧实现一致：只缩不放，最小 2px。 */
export function sampleSize(maxDim) {
  const dim = Number(maxDim) > 0 ? Number(maxDim) : 640;
  const scale = Math.min(1, dim / SAMPLE_WIDTH);
  return {
    width: Math.max(2, Math.round(SAMPLE_WIDTH * scale)),
    height: Math.max(2, Math.round(SAMPLE_HEIGHT * scale)),
  };
}

/** 把工程里的视频素材补进 <video> 池（无头页与面板用的是同一个模块级池）。 */
export function ensureTimelineMedia(assets, urlFor) {
  try {
    player.ensureVideos(assets || [], typeof urlFor === 'function' ? urlFor : () => '', {});
  } catch {
    /* 建元素失败不该阻断渲染：drawFrame 会把画不出来的图层报进 onMediaState */
  }
}

function waitSeeked(video, timeoutMs) {
  return new Promise((resolve) => {
    if (!video || video.readyState < 1) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    video.addEventListener('seeked', finish);
  });
}

/**
 * 把时间线上的视频 seek 到 t，并等浏览器把这一帧交上来。
 * 没有视频素材时几乎零开销。
 */
export async function seekTimeline(clips, assets, t) {
  try {
    player.syncVideos({ clips, assets, t }, { playing: false });
  } catch {
    /* syncVideos 失败时按当前帧画，至少不会抛 */
  }
  const waits = [];
  for (const a of assets || []) {
    const v = player.videoState(a.id);
    if (!v || v.readyState < 1) continue;
    if (v.seeking) waits.push(waitSeeked(v, 700));
  }
  await Promise.all(waits);
  // 让浏览器把新帧交上来（只等一个宏任务，不固定 60ms：无头页越等越慢）
  await new Promise((r) => setTimeout(r, 16));
}

/**
 * 渲染一帧到一张新的画布上。
 *
 * @param {object} input {clips, assets, t, maxDim, code}
 *   code —— {renderLayers(layers), canvasFor(clip)}；与 code-registry.js 的返回同形。
 *           面板传注册表，无头页也传注册表（同一份），所以代码图层完全一致。
 * @returns {{canvas, ctx, width, height, layers, mediaWarnings}}
 */
export async function renderTimelineFrame(input) {
  const clips = input.clips || [];
  const assets = input.assets || [];
  const t = Number(input.t) || 0;
  const { width, height } = sampleSize(input.maxDim);

  await seekTimeline(clips, assets, t);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });

  const layers = player.frameLayers(clips, t);
  const code = input.code || null;
  if (code) {
    try {
      await code.renderLayers(layers);
    } catch {
      /* 代码图层失败不影响采样（与旧实现一致） */
    }
  }

  const mediaWarnings = [];
  player.drawFrame(ctx, {
    clips,
    assets,
    t,
    width,
    height,
    layers,
    codeCanvas: code ? (clip) => code.canvasFor(clip) : null,
    onMediaState: (diagnostics) => {
      for (const item of diagnostics || []) mediaWarnings.push(item);
    },
  });

  return { canvas, ctx, width, height, layers, mediaWarnings };
}

/** 渲染一帧并编码成 dataURL。面板用 JPEG（历史行为），无头用 PNG。 */
export async function renderTimelineFrameDataUrl(input) {
  const frame = await renderTimelineFrame(input);
  const mime = input.mime || 'image/png';
  const quality = input.quality == null ? 0.92 : input.quality;
  return {
    dataUrl: frame.canvas.toDataURL(mime, quality),
    width: frame.width,
    height: frame.height,
    layers: frame.layers.map((l) => ({ kind: l.kind, clipId: l.clip && l.clip.id, localT: l.localT })),
    mediaWarnings: frame.mediaWarnings,
  };
}
