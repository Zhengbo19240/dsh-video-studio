/**
 * Sampler: serves the agent's request for frames.
 *
 * The agent cannot see the timeline, and the Host cannot decode. So the panel
 * polls for pending sample requests, renders the requested instants with the
 * same compositor the preview uses, and posts JPEGs back. The tool then hands
 * the agent file paths it can open with read_image.
 *
 * 渲染本体在 frame-render.js —— 无头渲染（src/client/standalone-render.js）用的是
 * 同一份。这样「面板开着采样」和「面板没开采样」拿到的是同一张图，只是编码不同。
 */

import { state, rpc } from './bridge.js';
import { renderTimelineFrame } from './frame-render.js';

export function createSampler({ getCode } = {}) {
  let timer = null;
  let busy = false;

  async function tick() {
    if (!state.projectId || !state.doc || busy) return;
    busy = true;
    try {
      const res = await rpc('sample.pending', { projectId: state.projectId });
      const requests = (res && res.requests) || [];
      for (const req of requests) {
        const files = [];
        for (const t of req.times) {
          const code = getCode && getCode();
          const frame = await renderTimelineFrame({
            clips: state.clips,
            // 与预览/导出同一份图层清单：转场与变速都体现在这里
            assets: state.assets,
            t,
            maxDim: req.maxDim || 640,
            code: code ? { renderLayers: (l) => code.renderLayers(l), canvasFor: (c) => code.canvasFor(c) } : null,
          });
          files.push({ time: t, dataUrl: frame.canvas.toDataURL('image/jpeg', 0.82) });
        }
        await rpc('sample.fulfill', {
          projectId: state.projectId,
          sessionId: state.sessionId,
          requestId: req.requestId,
          files,
        });
      }
    } catch (e) {
      // 采样失败不打扰用户；下一轮再试
      console.warn('[video-workbench] sample tick failed', e && e.message);
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, 700);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
