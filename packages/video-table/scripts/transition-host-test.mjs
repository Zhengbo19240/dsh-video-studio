#!/usr/bin/env node
/**
 * 转场上下文（env.transition）的契约测试。
 *
 *   node scripts/transition-host-test.mjs
 *   node scripts/transition-host-test.mjs --preview     # 额外出真实 PNG 样张（Edge/Chrome headless）
 *
 * 不依赖真实 DOM / Worker / createImageBitmap：
 *   - Worker 用 vm 沙箱跑 code-layer.js 的引导脚本（与 code-layer-test.mjs 同一套桩）；
 *   - 媒体桥、素材表、时间线都是注入的假对象；
 *   - 「真实渲染样张」只在 --preview 时调本机 Chromium，默认跑测试不碰浏览器。
 *
 * 覆盖（20 条）：
 *   1  切点默认在片段中点，前后邻居是主轨上的两镜
 *   2  真切点推断：图层盖住 A|B 交界时 cutAt 落在交界处
 *   3  props.cutAt 优先；越界夹紧并标记
 *   4  首片段 prev.has=false，frame() 返回 null 且不抛
 *   5  末片段 next.has=false
 *   6  跨轨道：主轨(v1)优先于画中画(v2)
 *   7  相邻是纯色/代码卡：has=true 但 reason=no-media、frame()=null
 *   8  相邻素材缺失：reason=no-asset
 *   9  帧缓存命中：同一 (clipId, 源时间) 只解码一次
 *   10 LRU 淘汰：超过上限先丢最旧，并回调释放
 *   11 取帧超时：null + 中文诊断，不抛
 *   12 取帧抛错：null + 中文诊断
 *   13 老卡（不声明 transitionNeeds）：完全不调解码，env 里结构照给
 *   14 声明后：邻帧位图经 transfer 进 worker，frame() 拿到同一张
 *   15 同帧内多次 frame() 不重复解码（跨帧命中也只解码一次）
 *   16 声明写坏：按未声明处理，不阻断渲染
 *   17 cutAt=0 / =duration 的边界语义（一侧仍能取到相邻镜头）
 *   18 卡 sc-circle-match-iris：0/半/末不抛；切点后才画新画面；无邻帧降级
 *   19 卡 sc-transition-hidden-cut：两侧都参与；光带位置随时间单调；无邻帧降级
 *   20 旧帧清理：下一帧没有 transitionFrames 时上一代位图被 close
 *   21 纯函数：normalizeCutAt / neighborFrameTime / transitionFrameKey / reason 文案
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { createCodeLayer } from '../src/client/code-layer.js';
import {
  TRANSITION_CACHE_LIMIT,
  createCodeRegistry,
  createTransitionFrameCache,
  neighborFrameTime,
  normalizeCutAt,
  resolveTransitionContext,
  transitionFrameKey,
  transitionReasonText,
} from '../src/client/code-registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MOTION = process.env.DSH_MOTION_LIB || path.join(os.homedir(), '.dsh', 'motion-lib');
const PREVIEW = process.argv.includes('--preview');

// ------------------------------------------------------------------ 桩 ----

class FakeImageBitmap {
  constructor(width, height, tag) {
    this.width = width;
    this.height = height;
    this.tag = tag || '';
    this.closed = false;
  }
  close() {
    this.closed = true;
  }
}

function fakeGradient() {
  return { addColorStop() {} };
}

class FakeRenderingContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.cleared = 0;
    this.drawImages = [];
    this.texts = [];
    this.arcs = [];
    this.fillRects = [];
    this.ops = [];
    this.clips = 0;
    this.globalAlpha = 1;
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.font = '10px sans-serif';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.shadowBlur = 0;
    this.shadowColor = 'transparent';
  }
  save() {
    this.ops.push('save');
  }
  restore() {
    this.ops.push('restore');
  }
  setTransform() {}
  translate(x, y) {
    this.ops.push(['translate', x, y]);
  }
  rotate(a) {
    this.ops.push(['rotate', a]);
  }
  clearRect() {
    this.cleared += 1;
  }
  fillRect(x, y, w, h) {
    this.fillRects.push({ x, y, w, h, alpha: this.globalAlpha });
    this.ops.push(['fillRect', x, y, w, h]);
  }
  strokeRect() {}
  beginPath() {
    this.ops.push('beginPath');
  }
  closePath() {}
  rect() {}
  roundRect() {}
  clip() {
    this.clips += 1;
    this.ops.push('clip');
  }
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  bezierCurveTo() {}
  arc(x, y, r) {
    this.arcs.push(r);
    this.ops.push(['arc', r]);
  }
  ellipse() {}
  setLineDash() {}
  fill() {
    this.ops.push('fill');
  }
  stroke() {
    this.ops.push('stroke');
  }
  fillText(text) {
    this.texts.push(String(text));
  }
  strokeText(text) {
    this.texts.push(String(text));
  }
  measureText(text) {
    return { width: String(text).length * 8 };
  }
  createLinearGradient() {
    return fakeGradient();
  }
  createRadialGradient() {
    return fakeGradient();
  }
  drawImage(source, x, y, w, h) {
    this.drawImages.push({ source, x, y, w, h });
    this.ops.push(['drawImage', source && source.tag]);
  }
}

class FakeOffscreenCanvas {
  static instances = [];
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.ctx = new FakeRenderingContext2D(this);
    FakeOffscreenCanvas.instances.push(this);
  }
  getContext(kind) {
    return kind === '2d' ? this.ctx : null;
  }
  transferToImageBitmap() {
    return new FakeImageBitmap(this.width, this.height, 'frame');
  }
}

class FakeMainContext {
  constructor() {
    this.frames = [];
  }
  drawImage(bitmap) {
    this.frames.push(bitmap);
  }
}

class FakeCanvasElement {
  constructor() {
    this.tagName = 'CANVAS';
    this.width = 0;
    this.height = 0;
    this.ctx = new FakeMainContext();
  }
  getContext(kind) {
    return kind === '2d' ? this.ctx : null;
  }
}

const blobUrls = new Map();
let urlSeq = 0;

class URLStub {
  static createObjectURL(blob) {
    const url = 'blob:transition-test-' + (urlSeq += 1);
    blobUrls.set(url, blob);
    return url;
  }
  static revokeObjectURL(url) {
    blobUrls.delete(url);
  }
}

globalThis.URL = URLStub;
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error('测试桩只支持 canvas');
    return new FakeCanvasElement();
  },
};

class FakeWorker {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.messages = [];
    this.posts = [];
    this.sandbox = null;
    FakeWorker.instances.push(this);

    const blob = blobUrls.get(url);
    this.started = blob.text().then((source) => this.run(source));
  }

  run(source) {
    const sandbox = {
      console,
      performance: { now: () => 0 },
      Blob,
      URL: URLStub,
      OffscreenCanvas: FakeOffscreenCanvas,
    };
    sandbox.self = sandbox;
    sandbox.postMessage = (message) => {
      if (this.terminated) return;
      queueMicrotask(() => {
        if (this.terminated) return;
        if (typeof this.onmessage === 'function') this.onmessage({ data: message });
      });
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'code-layer-bootstrap.js' });
    this.sandbox = sandbox;
    this.flush();
  }

  postMessage(message, transfer) {
    if (this.terminated) return;
    this.posts.push({ message, transfer: transfer || [] });
    this.messages.push(message);
    this.flush();
  }

  flush() {
    if (!this.sandbox) return;
    while (this.messages.length) {
      const message = this.messages.shift();
      if (typeof this.sandbox.onmessage === 'function') this.sandbox.onmessage({ data: message });
    }
  }

  terminate() {
    this.terminated = true;
    this.messages.length = 0;
  }
}

globalThis.Worker = FakeWorker;

function latestWorker() {
  return FakeWorker.instances[FakeWorker.instances.length - 1];
}

function latestContext() {
  const canvas = FakeOffscreenCanvas.instances[FakeOffscreenCanvas.instances.length - 1];
  return canvas ? canvas.ctx : null;
}

// -------------------------------------------------------------- 断言工具 ----

let pass = 0;
let fail = 0;

async function checkAsync(name, fn) {
  try {
    await Promise.resolve().then(fn);
    pass += 1;
    console.log('  ok   ' + name);
  } catch (error) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + (error && error.message));
    if (process.env.DSH_TEST_STACK) console.log(error && error.stack);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function near(a, b, eps, message) {
  assert(Math.abs(Number(a) - Number(b)) <= (eps === undefined ? 1e-6 : eps), message + '（' + a + ' vs ' + b + '）');
}

const HAS_CHINESE = /[\u4e00-\u9fa5]/;

// ------------------------------------------------------------ 时间线夹具 ----

const TRACKS = [
  { id: 'v1', kind: 'video', name: '主轨' },
  { id: 'v2', kind: 'video', name: '画中画' },
  { id: 'c1', kind: 'code', name: '代码图层' },
  { id: 't1', kind: 'text', name: '字幕' },
];

const ASSETS = [
  { id: 'va', mime: 'video/mp4', probe: { width: 1920, height: 1080, duration: 4 } },
  { id: 'vb', mime: 'video/mp4', probe: { width: 1920, height: 1080, duration: 4 } },
  { id: 'vc', mime: 'video/mp4', probe: { width: 1920, height: 1080, duration: 4 } },
];

function baseClips() {
  return [
    { id: 'A', trackId: 'v1', type: 'media', assetId: 'va', start: 0, duration: 4 },
    { id: 'B', trackId: 'v1', type: 'media', assetId: 'vb', start: 4, duration: 4 },
    {
      id: 'X',
      trackId: 'c1',
      type: 'code',
      layerId: 'layer-x',
      codeHash: 'h1',
      start: 3,
      duration: 2,
      props: {},
    },
  ];
}

function clipX(extra) {
  return Object.assign(
    {
      id: 'X',
      trackId: 'c1',
      type: 'code',
      layerId: 'layer-x',
      codeHash: 'h1',
      start: 3,
      duration: 2,
      props: {},
    },
    extra || {},
  );
}

// ------------------------------------------------------------------ 用例 ----

// -------------------------------------------------------------- 注册表夹具 ----

const TRANSITION_PROBE_SOURCE = `
export const transitionNeeds = () => ({ prev: true, next: true });
export function render(ctx2d, t, env) {
  const tr = env.transition;
  let noThrow = true;
  let prevFrame = null;
  try { prevFrame = tr.prev.frame(); } catch (error) { noThrow = false; }
  self.__seen = {
    t: t,
    cutAt: tr.cutAt,
    declared: tr.declared,
    prevHas: tr.prev.has,
    nextHas: tr.next.has,
    prevReason: tr.prev.reason,
    nextReason: tr.next.reason,
    prevFrame: prevFrame,
    nextFrame: tr.next.frame(),
    noThrow: noThrow,
  };
  ctx2d.fillRect(0, 0, 1, 1);
}
`;

const MULTI_CALL_SOURCE = `
export const transitionNeeds = () => ({ prev: true, next: true });
export function render(ctx2d, t, env) {
  const first = env.transition.prev.frame();
  const same = first === env.transition.prev.frame() && first === env.transition.prev.frame();
  self.__seen = { calls: (self.__seen ? self.__seen.calls : 0) + 3, same: same };
}
`;

function payloadOf(plan) {
  return {
    cutAt: plan.cutAt,
    declared: true,
    prev: { has: plan.prev.has, clipId: plan.prev.clip ? plan.prev.clip.id : null, reason: plan.prev.reason, message: '', time: 3.99 },
    next: { has: plan.next.has, clipId: plan.next.clip ? plan.next.clip.id : null, reason: plan.next.reason, message: '', time: 0.01 },
  };
}

function makeHostLayer(source, needs) {
  const layer = createCodeLayer({
    layerId: 'transition-test',
    moduleSource: source,
    props: {},
    width: 960,
    height: 540,
    fps: 30,
    duration: 2,
  });
  if (needs) {
    // 等 ready 后在 worker 里已经跑过 setup；这里只用来驱动 render
  }
  return layer;
}

class FakeLayer {
  constructor(opts, needs, breakNeeds) {
    this.opts = opts;
    this.calls = [];
    this.transfers = [];
    this.disposed = false;
    this.needs = needs;
    this.breakNeeds = breakNeeds;
    this.needList = [];
  }
  async ready() {
    return { mediaNeeds: [], transitionNeeds: this.needs };
  }
  mediaNeeds() {
    return [];
  }
  transitionNeeds() {
    if (this.breakNeeds) throw new Error('bad transitionNeeds');
    return this.needs;
  }
  async render(t, frame) {
    this.calls.push({ t, frame });
    this.transfers.push((frame.transitionFrames || []).map((entry) => entry.bitmap));
  }
  canvas() {
    return null;
  }
  dispose() {
    this.disposed = true;
  }
}

function registryFixture(options) {
  const opts = options || {};
  const clips = opts.clips || baseClips();
  const layers = [];
  const decodes = [];
  let copies = 0;
  const bridge =
    opts.bridge ||
    {
      async frameAt(asset, time) {
        decodes.push(asset.id + '@' + Number(time).toFixed(3));
        return {
          bitmap: new FakeImageBitmap(1920, 1080, asset.id),
          width: 1920,
          height: 1080,
          time,
        };
      },
    };
  // 统一记账：即使注入了自定义桥也统计到 decodes
  const countedBridge = {
    async frames() {
      return { frames: [] };
    },
    async frameAt(asset, time) {
      if (bridge === opts.bridge) decodes.push(asset.id + '@' + Number(time).toFixed(3));
      return bridge.frameAt(asset, time);
    },
  };

  const registry = createCodeRegistry({
    projectId: 'proj-transition',
    readLayerSource: async () => TRANSITION_PROBE_SOURCE,
    layerFactory: (layerOpts) => {
      const layer = new FakeLayer(layerOpts, opts.needList, opts.breakNeeds);
      layers.push(layer);
      return layer;
    },
    context: () => ({ assets: ASSETS, clips, tracks: TRACKS, fps: 30 }),
    mediaBridge: countedBridge,
    copyFrame: async (bitmap) => {
      copies += 1;
      return new FakeImageBitmap(bitmap.width, bitmap.height, 'copy');
    },
    transitionTimeoutMs: opts.transitionTimeoutMs,
    transitionCacheLimit: opts.cacheLimit,
  });

  return {
    registry,
    layers,
    decodes,
    get copies() {
      return copies;
    },
    makeTransitionFrames(plan) {
      // 模拟注册表已经准备好的两帧（不经过注册表，供卡用例/清理用例使用）
      return [
        {
          key: transitionFrameKey(plan.prev.clip.id, 3.99),
          bitmap: new FakeImageBitmap(1920, 1080, 'prev'),
          width: 1920,
          height: 1080,
          time: 3.99,
        },
        {
          key: transitionFrameKey(plan.next.clip.id, 0.01),
          bitmap: new FakeImageBitmap(1920, 1080, 'next'),
          width: 1920,
          height: 1080,
          time: 0.01,
        },
      ];
    },
  };
}


console.log('transition host');

await checkAsync('1. 切点默认在片段中点，前后邻居取主轨两镜', async () => {
  const clips = baseClips();
  const plan = resolveTransitionContext(clips[2], { clips, tracks: TRACKS, fps: 30 });
  near(plan.cutAt, 1.0, 1e-6, '默认切点应是 duration/2');
  near(plan.cutGlobal, 4.0, 1e-6, '切点全局时间应在 A|B 交界');
  assert(plan.prev.has && plan.prev.clip.id === 'A', '前一镜应是 A');
  assert(plan.next.has && plan.next.clip.id === 'B', '后一镜应是 B');
});

await checkAsync('2. 真切点推断：图层盖住 A|B 交界时 cutAt 落在交界处（不是中点）', async () => {
  const clips = baseClips();
  // 图层从 2.5s 开始、时长 3s，中点是 1.5s；真切点(4s)在 1.5s 处 → 两者恰好重合，
  // 把图层改成 3.2..6.0：中点 1.4s，真切点(4s) 在 0.8s 处。
  clips[2] = clipX({ start: 3.2, duration: 2.8 });
  const plan = resolveTransitionContext(clips[2], { clips, tracks: TRACKS, fps: 30 });
  near(plan.cutAt, 0.8, 1e-6, '应推断出真切点的局部位置');
  assert(plan.source === 'cut', '来源应标记为 cut，实际 ' + plan.source);
  assert(plan.prev.clip.id === 'A' && plan.next.clip.id === 'B', '两侧仍应是 A/B');
});

await checkAsync('3. props.cutAt 优先于推断；越界夹紧并标记', async () => {
  const clips = baseClips();
  const wanted = resolveTransitionContext(clipX({ props: { cutAt: 0.5 } }), { clips, tracks: TRACKS, fps: 30 });
  near(wanted.cutAt, 0.5, 1e-6, 'props.cutAt 应生效');

  const low = resolveTransitionContext(clipX({ props: { cutAt: -3 } }), { clips, tracks: TRACKS, fps: 30 });
  near(low.cutAt, 0, 1e-6, '负 cutAt 应夹到 0');
  assert(low.source === 'clamped', '应标记 clamped');

  const high = resolveTransitionContext(clipX({ props: { cutAt: 99 } }), { clips, tracks: TRACKS, fps: 30 });
  near(high.cutAt, 2, 1e-6, '超大 cutAt 应夹到 duration');
  assert(high.source === 'clamped', '应标记 clamped');

  const norm = normalizeCutAt('abc', 2);
  near(norm.cutAt, 1, 1e-6, '非数字 cutAt 回落到中点');
  assert(norm.supplied === false, '非数字应标记「未提供」');
});

await checkAsync('4. 首片段：prev.has=false，frame() 返回 null 且不抛', async () => {
  const clips = baseClips();
  const first = clipX({ start: 0, duration: 2, props: { cutAt: 0 } });
  const plan = resolveTransitionContext(first, { clips, tracks: TRACKS, fps: 30 });
  assert(plan.prev.has === false, '时间线最前面没有前一镜');
  assert(plan.prev.reason === 'none', '原因应是 none');

  const layer = makeHostLayer(TRANSITION_PROBE_SOURCE, { prev: true, next: true });
  await layer.render(0, { transition: payloadOf(plan), transitionFrames: [] });
  const seen = latestWorker().sandbox.__seen;
  assert(seen.prevFrame === null && seen.prevHas === false, 'worker 侧 frame() 应为 null');
  assert(seen.noThrow === true, 'frame() 调用不该抛');
  layer.dispose();
});

await checkAsync('5. 末片段：next.has=false', async () => {
  const clips = baseClips();
  const last = clipX({ id: 'LAST', start: 8, duration: 2, props: { cutAt: 0 } });
  clips.push(last);
  const plan = resolveTransitionContext(last, { clips, tracks: TRACKS, fps: 30 });
  assert(plan.next.has === false, '时间线末尾没有后一镜');
  assert(plan.prev.has && plan.prev.clip.id === 'B', '前一镜应是 B，实际 ' + (plan.prev.clip && plan.prev.clip.id));
});

await checkAsync('6. 跨轨道：主轨(v1)优先于画中画(v2)', async () => {
  const clips = baseClips();
  clips.push({ id: 'PIP', trackId: 'v2', type: 'media', assetId: 'vc', start: 3, duration: 3 });
  const plan = resolveTransitionContext(clips[2], { clips, tracks: TRACKS, fps: 30 });
  assert(plan.prev.clip.id === 'A', '前一镜应仍取主轨 A，实际 ' + plan.prev.clip.id);
  assert(plan.next.clip.id === 'B', '后一镜应仍取主轨 B，实际 ' + plan.next.clip.id);
});

await checkAsync('7. 相邻是纯色/文字卡：has=true，但 reason=no-media、frame()=null', async () => {
  const clips = baseClips();
  clips[1] = { id: 'CB', trackId: 'v1', type: 'code', layerId: 'color-card', start: 4, duration: 4 };
  const plan = resolveTransitionContext(clips[2], { clips, tracks: TRACKS, fps: 30 });
  assert(plan.next.has === true, '结构上确实有相邻片段');
  assert(plan.next.reason === 'no-media', '纯色卡没有源帧，reason 应为 no-media');

  const layer = makeHostLayer(TRANSITION_PROBE_SOURCE, { prev: true, next: true });
  await layer.render(1, { transition: payloadOf(plan), transitionFrames: [] });
  const seen = latestWorker().sandbox.__seen;
  assert(
    seen.nextHas === true && seen.nextFrame === null,
    'frame() 应为 null 但 has 为 true：' + JSON.stringify({ has: seen.nextHas, frame: seen.nextFrame && seen.nextFrame.tag, reason: seen.nextReason }),
  );
  layer.dispose();
});

await checkAsync('8. 相邻素材缺失：reason=no-asset', async () => {
  const clips = baseClips();
  clips[0] = { id: 'A', trackId: 'v1', type: 'media', assetId: 'missing', start: 0, duration: 4 };
  const fixture = registryFixture({ clips, needList: { prev: true, next: true } });
  await fixture.registry.renderAt([clips[2]], 4.0);
  const payload = fixture.layers[0].calls[0].frame.transition;
  assert(payload.prev.has === true, '结构上应有前一镜');
  assert(payload.prev.reason === 'no-asset', 'reason 应为 no-asset，实际 ' + payload.prev.reason);
  assert(HAS_CHINESE.test(payload.prev.message), '诊断应是中文：' + payload.prev.message);
  fixture.registry.dispose();
});

await checkAsync('9. 缓存命中：同一 (clipId, 源时间) 只解码一次', async () => {
  const fixture = registryFixture({ needList: { prev: true, next: true } });
  const clips = baseClips();
  await fixture.registry.renderAt([clips[2]], 3.5);
  await fixture.registry.renderAt([clips[2]], 3.8);
  await fixture.registry.renderAt([clips[2]], 4.4);
  assert(fixture.decodes.length === 2, '三帧渲染应只解码两帧（prev/next 各一次），实际 ' + fixture.decodes.length + '：' + fixture.decodes.join(', '));
  assert(fixture.copies === 6, '每帧仍需各复制一次给 worker，实际 ' + fixture.copies);
  fixture.registry.dispose();
});

await checkAsync('10. LRU 淘汰：超过上限先丢最旧，并回调释放', async () => {
  const evicted = [];
  const cache = createTransitionFrameCache({
    limit: 3,
    onEvict: (entry) => evicted.push(entry.id),
  });
  for (let i = 0; i < 5; i += 1) {
    await cache.load('k' + i, async () => ({ id: i }));
  }
  assert(cache.size() === 3, '容量应保持在上限');
  assert(evicted.join(',') === '0,1', '应先淘汰最旧两帧，实际 ' + evicted.join(','));
  assert(cache.stats.decodes === 5 && cache.stats.evictions === 2, '统计不对：' + JSON.stringify(cache.stats));

  const hit = await cache.load('k4', async () => {
    throw new Error('命中时不该再解码');
  });
  assert(hit.id === 4, '应命中缓存');
  assert(cache.stats.hits === 1, '命中计数应为 1');
  assert(TRANSITION_CACHE_LIMIT === 8, '默认容量应是 8');
});

await checkAsync('11. 取帧超时：null + 中文诊断，不抛', async () => {
  const fixture = registryFixture({
    needList: { prev: true, next: true },
    bridge: {
      async frameAt() {
        return new Promise(() => {}); // 永不 resolve
      },
    },
    transitionTimeoutMs: 30,
  });
  const clips = baseClips();
  await fixture.registry.renderAt([clips[2]], 4.0);
  const payload = fixture.layers[0].calls[0].frame.transition;
  assert(payload.prev.reason === 'timeout', 'reason 应为 timeout，实际 ' + payload.prev.reason);
  assert(HAS_CHINESE.test(payload.prev.message) && payload.prev.message.indexOf('超时') >= 0, '诊断应写明超时：' + payload.prev.message);
  assert(fixture.layers[0].calls[0].frame.transitionFrames.length === 0, '超时不应塞一个假帧');
  fixture.registry.dispose();
});

await checkAsync('12. 取帧抛错：null + 中文诊断', async () => {
  const fixture = registryFixture({
    needList: { prev: true, next: true },
    bridge: {
      async frameAt() {
        throw new Error('boom');
      },
    },
  });
  const clips = baseClips();
  await fixture.registry.renderAt([clips[2]], 4.0);
  const payload = fixture.layers[0].calls[0].frame.transition;
  assert(payload.prev.reason === 'decode-failed', 'reason 应为 decode-failed');
  assert(HAS_CHINESE.test(payload.prev.message), '诊断应是中文');
  fixture.registry.dispose();
});

await checkAsync('13. 老卡（不声明 transitionNeeds）完全不调解码', async () => {
  const fixture = registryFixture({ needList: { prev: false, next: false } });
  const clips = baseClips();
  await fixture.registry.renderAt([clips[2]], 4.0);
  assert(fixture.decodes.length === 0, '不该有任何解码');
  const payload = fixture.layers[0].calls[0].frame.transition;
  assert(payload.declared === false, 'declared 应为 false');
  assert(payload.prev.has === true, '结构信息仍应给出（卡片可以自己判断）');
  assert(payload.prev.clipId === 'A', 'clipId 应给出');
  assert(fixture.layers[0].calls[0].frame.transitionFrames.length === 0, '不应有邻帧位图');
  fixture.registry.dispose();
});

await checkAsync('14. 声明后：邻帧位图经 transfer 进 worker，frame() 拿到同一张', async () => {
  const fixture = registryFixture({ needList: { prev: true, next: true } });
  const clips = baseClips();
  await fixture.registry.renderAt([clips[2]], 4.0);
  const call = fixture.layers[0].calls[0];
  assert(call.frame.transitionFrames.length === 2, '应准备两张邻帧，实际 ' + call.frame.transitionFrames.length);
  const transfer = fixture.layers[0].transfers[0];
  assert(transfer.length === 2, 'transfer list 应带两张位图，实际 ' + transfer.length);

  const layer = makeHostLayer(TRANSITION_PROBE_SOURCE, { prev: true, next: true });
  await layer.render(1, {
    transition: call.frame.transition,
    transitionFrames: call.frame.transitionFrames,
  });
  const seen = latestWorker().sandbox.__seen;
  assert(seen.prevFrame === call.frame.transitionFrames[0].bitmap, 'worker 拿到的应是同一张位图');
  assert(seen.nextFrame === call.frame.transitionFrames[1].bitmap, 'next 同理');
  assert(seen.declared === true && seen.cutAt === 1, 'env.transition.cutAt 应为 1');
  layer.dispose();
  fixture.registry.dispose();
});

await checkAsync('15. 同帧内多次 frame() 不重复解码；跨帧也命中缓存', async () => {
  const fixture = registryFixture({ needList: { prev: true, next: true } });
  const clips = baseClips();
  await fixture.registry.renderAt([clips[2]], 4.0);
  const call = fixture.layers[0].calls[0];
  const decodesAfterPrepare = fixture.decodes.length;
  assert(decodesAfterPrepare === 2, '第一帧应解码 prev/next 各一次，实际 ' + decodesAfterPrepare);

  const layer = makeHostLayer(MULTI_CALL_SOURCE, { prev: true, next: true });
  for (let i = 0; i < 3; i += 1) {
    await layer.render(1 + i * 0.1, {
      transition: call.frame.transition,
      transitionFrames: call.frame.transitionFrames,
    });
  }
  assert(fixture.decodes.length === decodesAfterPrepare, '重复 render 不应再解码，实际 ' + fixture.decodes.length);
  const seen = latestWorker().sandbox.__seen;
  assert(seen.calls === 9, '每帧内调 3 次 prev.frame()，3 帧共 9 次，实际 ' + seen.calls);
  assert(seen.same === true, '同一帧内多次 frame() 应返回同一张位图');
  layer.dispose();
  fixture.registry.dispose();
});

await checkAsync('16. 声明写坏：按未声明处理，不阻断渲染', async () => {
  const fixture = registryFixture({ needList: { prev: false, next: false }, breakNeeds: true });
  const clips = baseClips();
  await fixture.registry.renderAt([clips[2]], 4.0);
  assert(fixture.decodes.length === 0, '声明抛错后不应解码');
  assert(fixture.layers[0].calls.length === 1, 'render 仍应执行');
  fixture.registry.dispose();
});

await checkAsync('17. cutAt=0 / =duration：边界语义仍能取到相邻镜头', async () => {
  const clips = baseClips();
  const atZero = resolveTransitionContext(clipX({ props: { cutAt: 0 } }), { clips, tracks: TRACKS, fps: 30 });
  near(atZero.cutGlobal, 3, 1e-6, '切点应在图层起点');
  assert(atZero.prev.has && atZero.prev.clip.id === 'A', '起点之前仍是 A');
  assert(atZero.next.has && atZero.next.clip.id === 'A', '起点时正在播的也是 A（不跨切点）');

  const atEnd = resolveTransitionContext(clipX({ props: { cutAt: 2 } }), { clips, tracks: TRACKS, fps: 30 });
  near(atEnd.cutGlobal, 5, 1e-6, '切点应在图层终点');
  assert(atEnd.prev.has && atEnd.prev.clip.id === 'B', '终点之前是 B');
  assert(atEnd.next.has && atEnd.next.clip.id === 'B', '终点之后仍是 B');

  const cutAtOne = resolveTransitionContext(clipX({ props: { cutAt: 1 } }), { clips, tracks: TRACKS, fps: 30 });
  assert(cutAtOne.prev.clip.id === 'A' && cutAtOne.next.clip.id === 'B', '切点处应换镜');
});

await checkAsync('18. 卡 sc-circle-match-iris：三时刻不抛、切点后才画新画面、无邻帧降级', async () => {
  const card = loadCard('sc-circle-match-iris');
  assert(typeof card.render === 'function', '卡应导出 render');
  assert(card.transitionNeeds && card.transitionNeeds().prev === true, '卡应声明要邻帧');

  const prev = new FakeImageBitmap(1920, 1080, 'prev');
  const next = new FakeImageBitmap(1920, 1080, 'next');
  const withFrames = (t) => {
    const ctx = new FakeRenderingContext2D(new FakeOffscreenCanvas(960, 540));
    card.render(ctx, t, cardEnv({ prev, next, cutAt: 1.2 }));
    return ctx;
  };

  const t0 = withFrames(0);
  const mid = withFrames(1.25);
  const end = withFrames(2.4);
  assert(t0.drawImages.length >= 1 && t0.drawImages[0].source === prev, '切点前应画旧画面');
  assert(!t0.drawImages.some((d) => d.source === next), '切点前不该出现新画面');
  assert(mid.drawImages.some((d) => d.source === next), '切点后应画新画面');
  assert(end.drawImages.some((d) => d.source === next), '末帧应仍是新画面');

  const radiusAt = (t) => {
    const ctx = withFrames(t);
    return Math.max(0, ...ctx.arcs.filter((r) => Number.isFinite(r)));
  };
  assert(radiusAt(1.3) < radiusAt(1.8), '光圈半径应随时间变大：' + radiusAt(1.3) + ' → ' + radiusAt(1.8));

  // 无邻帧：只画底 + 光圈，不抛
  const degraded = new FakeRenderingContext2D(new FakeOffscreenCanvas(960, 540));
  card.render(degraded, 0.6, cardEnv({ prev: null, next: null, cutAt: 1.2 }));
  assert(degraded.drawImages.length === 0, '没有邻帧时不该 drawImage 任何帧');
  assert(degraded.fillRects.length >= 1, '应画程序化背景');
  assert(degraded.arcs.length >= 1, '降级也应有光圈');
});

await checkAsync('19. 卡 sc-transition-hidden-cut：两侧都参与、光带位置随时间单调、无邻帧降级', async () => {
  const card = loadCard('sc-transition-hidden-cut');
  assert(typeof card.render === 'function', '卡应导出 render');

  const prev = new FakeImageBitmap(1920, 1080, 'prev');
  const next = new FakeImageBitmap(1920, 1080, 'next');
  const at = (t) => {
    const ctx = new FakeRenderingContext2D(new FakeOffscreenCanvas(960, 540));
    card.render(ctx, t, cardEnv({ prev, next, cutAt: 1.2 }));
    return ctx;
  };

  const t0 = at(0);
  const tCut = at(1.2);
  const tEnd = at(2.4);
  assert(t0.drawImages.length >= 1 && t0.drawImages[0].source === prev, '开头应是旧画面');
  assert(!t0.drawImages.some((d) => d.source === next), '开头不该出现新画面');
  assert(tCut.drawImages.some((d) => d.source === prev) && tCut.drawImages.some((d) => d.source === next), '切点处两侧都应参与');
  assert(tEnd.drawImages.some((d) => d.source === next), '结尾应是新画面');

  // 光带（很宽的 fillRect）的 y 随时间单调增大
  const bandY = (ctx) => {
    const wide = ctx.fillRects.filter((r) => r.w > 960).sort((a, b) => b.w - a.w)[0];
    return wide ? wide.y : NaN;
  };
  const y0 = bandY(at(0.4));
  const y1 = bandY(at(1.2));
  const y2 = bandY(at(2.0));
  assert(y0 < y1 && y1 < y2, '光带应单调扫过：' + y0 + ' → ' + y1 + ' → ' + y2);

  // 同一 t 两次渲染命令完全一致（纯函数）
  const a = at(0.9);
  const b = at(0.9);
  assert(JSON.stringify(a.ops) === JSON.stringify(b.ops), '同一 t 应输出完全一致的命令');

  const degraded = new FakeRenderingContext2D(new FakeOffscreenCanvas(960, 540));
  card.render(degraded, 1.0, cardEnv({ prev: null, next: null, cutAt: 1.2 }));
  assert(degraded.drawImages.length === 0, '没有邻帧时不该画任何帧');
  assert(degraded.fillRects.length >= 1, '应画程序化背景');
});

await checkAsync('20. 旧帧清理：下一帧没有 transitionFrames 时上一代位图被 close', async () => {
  const layer = makeHostLayer(TRANSITION_PROBE_SOURCE, { prev: true, next: true });
  const bitmap = new FakeImageBitmap(1920, 1080, 'prev');
  const nextBitmap = new FakeImageBitmap(1920, 1080, 'next');
  const plan = resolveTransitionContext(clipX(), { clips: baseClips(), tracks: TRACKS, fps: 30 });
  await layer.render(1, {
    transition: payloadOf(plan),
    transitionFrames: [
      { key: transitionFrameKey('A', 3.99), bitmap },
      { key: transitionFrameKey('B', 0.01), bitmap: nextBitmap },
    ],
  });
  assert(bitmap.closed === false, '这一帧的位图不该提前关闭');
  await layer.render(1.1, { transition: payloadOf(plan), transitionFrames: [] });
  assert(bitmap.closed === true && nextBitmap.closed === true, '上一代邻帧位图应被释放');
  layer.dispose();
});

await checkAsync('21. 纯函数：normalizeCutAt / neighborFrameTime / transitionFrameKey / 中文诊断', async () => {
  near(normalizeCutAt(1, 4).cutAt, 1, 1e-6, '范围内原样');
  near(normalizeCutAt(null, 4).cutAt, 2, 1e-6, '缺省取中点');
  near(normalizeCutAt(9, 4).cutAt, 4, 1e-6, '越界夹紧');

  const prevTime = neighborFrameTime({ start: 0, duration: 4 }, 'prev', 30);
  near(prevTime, 4 - 0.5 / 30, 1e-6, 'prev 应取末帧（含半帧回退）');
  const nextTime = neighborFrameTime({ start: 4, duration: 4 }, 'next', 30);
  near(nextTime, 0.5 / 30, 1e-6, 'next 应取首帧');
  const sped = neighborFrameTime({ start: 0, duration: 2, sourceIn: 10, speed: 2 }, 'next', 30);
  near(sped, 10 + (0.5 / 30) * 2, 1e-6, '变速片段应按速度映射到源时间');

  assert(transitionFrameKey('A', 1.2345) === 'A@1.235', '帧键应量化到毫秒：' + transitionFrameKey('A', 1.2345));
  assert(transitionFrameKey('A', 1.23451) === transitionFrameKey('A', 1.2345), '同一毫秒应得到同一个键');

  for (const reason of ['none', 'no-media', 'no-asset', 'decode-failed', 'timeout', 'copy-failed']) {
    assert(HAS_CHINESE.test(transitionReasonText(reason)), reason + ' 应有中文诊断');
  }
});

// ------------------------------------------------------------------ 卡工具 ----

function toFunctionBody(source) {
  return String(source)
    .replace(/export\s+default\s+/g, 'const __default__ = ')
    .replace(/export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/g, (m, isAsync, name) => `${isAsync || ''}function ${name}`)
    .replace(/export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g, (m, kind, name) => `${kind} ${name}`)
    .replace(/export\s*\{[^}]*\}/g, '');
}

function loadCard(id) {
  const source = fs.readFileSync(path.join(MOTION, id, 'code.js'), 'utf8');
  const body = toFunctionBody(source);
  return new Function(
    '"use strict";\n' +
      body +
      '\nreturn {' +
      ' render: typeof render === "function" ? render : (typeof __default__ !== "undefined" && __default__ && __default__.render),' +
      ' transitionNeeds: typeof transitionNeeds === "function" ? transitionNeeds : null,' +
      ' meta: typeof meta === "object" ? meta : null };',
  )();
}

function cardEnv(options) {
  const prev = options.prev || null;
  const next = options.next || null;
  return {
    width: 960,
    height: 540,
    props: options.props || {},
    fps: 30,
    duration: options.duration || 2.4,
    assets: [],
    media: null,
    transition: {
      cutAt: options.cutAt === undefined ? 1.2 : options.cutAt,
      declared: true,
      prev: {
        has: !!prev,
        clipId: prev ? 'A' : null,
        reason: prev ? 'ok' : 'none',
        message: prev ? '' : '这一侧没有相邻片段',
        frame: () => prev,
      },
      next: {
        has: !!next,
        clipId: next ? 'B' : null,
        reason: next ? 'ok' : 'none',
        message: next ? '' : '这一侧没有相邻片段',
        frame: () => next,
      },
    },
  };
}

// ------------------------------------------------------------- 真实样张 ----

function shotCanvas(kind) {
  // 在浏览器里执行；返回绘制好的 canvas（既能 drawImage，也能被截图）
  return `(function () {
    const c = document.createElement('canvas');
    c.width = 960; c.height = 540;
    const g = c.getContext('2d');
    const warm = ${kind === 'A' ? 'true' : 'false'};
    const bg = g.createLinearGradient(0, 0, 960, 540);
    if (warm) {
      bg.addColorStop(0, '#3a2216'); bg.addColorStop(0.5, '#7a3a1d'); bg.addColorStop(1, '#1b0e0a');
    } else {
      bg.addColorStop(0, '#0f2130'); bg.addColorStop(0.5, '#1d4a5e'); bg.addColorStop(1, '#08131c');
    }
    g.fillStyle = bg; g.fillRect(0, 0, 960, 540);
    // 圆形元素：两镜同心（595, 227），这是「匹配剪辑」的锚点
    const cx = 0.62 * 960, cy = 0.42 * 540;
    const ring = g.createRadialGradient(cx, cy, 30, cx, cy, 190);
    ring.addColorStop(0, warm ? 'rgba(255,220,160,0.95)' : 'rgba(160,230,255,0.95)');
    ring.addColorStop(0.55, warm ? 'rgba(255,150,80,0.45)' : 'rgba(80,170,220,0.45)');
    ring.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = ring;
    g.beginPath(); g.arc(cx, cy, 190, 0, Math.PI * 2); g.fill();
    g.strokeStyle = warm ? 'rgba(255,235,210,0.9)' : 'rgba(220,245,255,0.9)';
    g.lineWidth = 6;
    g.beginPath(); g.arc(cx, cy, 120, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(cx, cy, 168, 0, Math.PI * 2); g.stroke();
    // 同位置的十字，验证两侧坐标一致
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx - 220, cy); g.lineTo(cx + 220, cy);
    g.moveTo(cx, cy - 220); g.lineTo(cx, cy + 220); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.font = '600 96px system-ui, sans-serif';
    g.fillText(${JSON.stringify(kind)}, 60, 120);
    g.font = '400 26px system-ui, sans-serif';
    g.fillText(warm ? '上一镜 A · 圆形元素 @ (0.62, 0.42)' : '下一镜 B · 同一个圆心', 60, 165);
    return c;
  })()`;
}

function buildPreviewHtml(cardId, source, times, withFrames, duration) {
  const body = toFunctionBody(source);
  const total = Number(duration) > 0 ? Number(duration) : Math.max(...times, 1);
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:#16181d}
  .row{display:flex;gap:12px;padding:12px}
  .cell{display:flex;flex-direction:column;align-items:center;gap:6px}
  canvas{display:block;border-radius:6px}
  .cap{color:#c9ced8;font:12px/1.4 system-ui,"Segoe UI",sans-serif}
</style></head><body>
<div class="row" id="row"></div>
<script>
const SOURCE = ${JSON.stringify(body)};
const ID = ${JSON.stringify(cardId)};
const TIMES = ${JSON.stringify(times)};
const WITH_FRAMES = ${withFrames ? 'true' : 'false'};
const DURATION = ${total};

function fail(message) {
  document.body.innerHTML = '<pre style="color:#ff8080;font:13px monospace;padding:16px">' + ID + ' 渲染失败：' + message + '</pre>';
}

try {
  const api = new Function('"use strict";\\n' + SOURCE + '\\nreturn { render: typeof render === "function" ? render : (__default__ && __default__.render) };')();
  if (typeof api.render !== 'function') throw new Error('模块没有导出 render');
  const A = ${shotCanvas('A')};
  const B = ${shotCanvas('B')};
  const row = document.getElementById('row');
  for (let i = 0; i < TIMES.length; i += 1) {
    const t = TIMES[i];
    const cell = document.createElement('div');
    cell.className = 'cell';
    const canvas = document.createElement('canvas');
    canvas.width = 480; canvas.height = 270;
    const ctx = canvas.getContext('2d');
    const env = {
      width: 480, height: 270, props: ${JSON.stringify({ cx: 0.62, cy: 0.42 })}, fps: 30, duration: DURATION,
      assets: [],
      transition: {
        cutAt: DURATION / 2, declared: true,
        prev: { has: WITH_FRAMES, clipId: WITH_FRAMES ? 'A' : null, reason: WITH_FRAMES ? 'ok' : 'none',
                message: WITH_FRAMES ? '' : '这一侧没有相邻片段', frame: function () { return WITH_FRAMES ? A : null; } },
        next: { has: WITH_FRAMES, clipId: WITH_FRAMES ? 'B' : null, reason: WITH_FRAMES ? 'ok' : 'none',
                message: WITH_FRAMES ? '' : '这一侧没有相邻片段', frame: function () { return WITH_FRAMES ? B : null; } }
      }
    };
    api.render(ctx, t, env);
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = ID + ' · t=' + t.toFixed(2) + 's' + (WITH_FRAMES ? ' · 有邻帧' : ' · 无邻帧（降级）');
    cell.appendChild(canvas);
    cell.appendChild(cap);
    row.appendChild(cell);
  }
  window.__previewReady = true;
} catch (error) {
  fail(error && error.message ? error.message : String(error));
}
</script></body></html>`;
}

async function renderPreviews() {
  const { screenshot } = await import('../tools/render-card-preview.mjs');
  const outDir = path.join(ROOT, '.build', 'transition-previews');
  await fs.promises.mkdir(outDir, { recursive: true });
  const cards = [
    { id: 'sc-circle-match-iris', times: [0, 0.9, 1.4, 1.9] },
    { id: 'sc-transition-hidden-cut', times: [0, 0.8, 1.05, 1.6] },
  ];
  const DURATION = 2.1;
  const made = [];
  for (const card of cards) {
    const id = card.id;
    const source = fs.readFileSync(path.join(MOTION, id, 'code.js'), 'utf8');
    for (const withFrames of [true, false]) {
      const times = card.times;
      const html = buildPreviewHtml(id, source, times, withFrames, DURATION);
      const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vt-preview-'));
      const htmlPath = path.join(work, 'preview.html');
      await fs.promises.writeFile(htmlPath, html, 'utf8');
      const outPath = path.join(outDir, id + (withFrames ? '-with' : '-degraded') + '.png');
      try {
        const shot = await screenshot(htmlPath, outPath, {
          width: 480,
          height: 270,
          count: times.length,
        });
        made.push({ file: outPath, bytes: shot.bytes, browser: shot.browser });
        console.log('  png  ' + outPath + ' (' + shot.bytes + ' bytes)');
      } finally {
        await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  return made;
}

// -------------------------------------------------------------------- 跑 ----

console.log('');

if (PREVIEW) {
  try {
    await renderPreviews();
    pass += 1;
    console.log('  ok   真实渲染样张（.build/transition-previews/）');
  } catch (error) {
    fail += 1;
    console.log('  FAIL 真实渲染样张 :: ' + (error && error.message));
  }
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exitCode = 1;
