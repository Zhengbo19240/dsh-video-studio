/**
 * Sample broker: the agent asks for frames, the open workbench renders them.
 *
 * The Host cannot decode video (no ffmpeg), the Client cannot be called
 * directly. So a tool creates a request, the open panel polls for pending
 * requests, renders the frames from the live timeline, and posts back JPEGs.
 * The tool then returns file paths the agent can open with read_image.
 *
 * 面板没开时不再是死路：video_sample 会退到无头渲染（src/headless.mjs）。
 * 这里加的是「面板还活着吗」的判据 —— 面板每 700ms 轮询一次 sample.pending，
 * 所以「最近一次轮询在 5 秒内」就等于「面板开着」。agent 先探路再决定流程，
 * 不用靠报错文案猜。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const LIVE_WINDOW_MS = 5000;

export class SampleBroker {
  constructor() {
    this.pending = new Map(); // requestId -> {projectId, times, maxDim, resolve, reject, timer}
    this.samplesDir = '.dsh-video/samples';
    // projectId -> 最近一次面板轮询的时间戳
    this.lastPoll = new Map();
    // 面板最近一次轮询（任何工程）的时间
    this.lastAnyPollAt = 0;
  }

  /** 路由在 sample.pending 里调：记下「面板还活着」。 */
  touchPoll(projectId) {
    this.lastAnyPollAt = Date.now();
    if (projectId) this.lastPoll.set(String(projectId), this.lastAnyPollAt);
  }

  /** 面板是否开着（按工程；不给 projectId 时看任意工程）。 */
  isLive(projectId, windowMs = LIVE_WINDOW_MS) {
    const at = projectId ? this.lastPoll.get(String(projectId)) || 0 : this.lastAnyPollAt;
    return at > 0 && Date.now() - at <= (Number(windowMs) > 0 ? Number(windowMs) : LIVE_WINDOW_MS);
  }

  /** 探路用的状态快照（给 video_probe）。 */
  status(projectId) {
    const anyAt = this.lastAnyPollAt;
    const at = projectId ? this.lastPoll.get(String(projectId)) || 0 : anyAt;
    return {
      live: this.isLive(projectId),
      lastPollAt: at || null,
      lastAnyPollAt: anyAt || null,
      pending: this.pending.size,
    };
  }

  request(projectId, times, maxDim, { timeoutMs = 6000 } = {}) {
    const requestId = 'sp_' + Math.random().toString(36).slice(2, 10);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          Object.assign(new Error('工作台没有响应采样请求（面板是否打开？）'), {
            code: 'WORKBENCH_OFFLINE',
            details: { requestId },
          }),
        );
      }, timeoutMs);
      this.pending.set(requestId, { projectId, times, maxDim, resolve, reject, timer, createdAt: Date.now() });
    });
  }

  list(projectId) {
    const out = [];
    for (const [requestId, r] of this.pending) {
      if (projectId && r.projectId !== projectId) continue;
      out.push({ requestId, projectId: r.projectId, times: r.times, maxDim: r.maxDim });
    }
    return out;
  }

  async fulfill(projectId, root, requestId, files) {
    const r = this.pending.get(requestId);
    if (!r) return { ok: false, reason: '请求已过期' };
    this.pending.delete(requestId);
    clearTimeout(r.timer);
    const dir = path.join(root, '.dsh-video', 'samples');
    await fs.mkdir(dir, { recursive: true });
    const written = [];
    for (const f of files || []) {
      const b64 = String(f.dataUrl || '').split(',')[1];
      if (!b64) continue;
      const name = `s_${Date.now().toString(36)}_${Math.round((f.time || 0) * 1000)}.jpg`;
      const abs = path.join(dir, name);
      await fs.writeFile(abs, Buffer.from(b64, 'base64'));
      written.push({ time: f.time, path: abs, bytes: Buffer.from(b64, 'base64').length });
    }
    const value = { requestId, samples: written };
    r.resolve(value);
    return { ok: true, value };
  }
}
