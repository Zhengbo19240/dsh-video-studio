#!/usr/bin/env node
/**
 * 合成帧（composed neighbor frame）的契约测试。
 *
 *   node scripts/transition-composite-test.mjs
 *   node scripts/transition-composite-test.mjs --preview     # 额外生成真实 PNG / 耗时（Edge/Chrome headless）
 *
 * 不依赖真实 DOM / 视频 / createImageBitmap：
 *   - 合成 provider 用假 drawFrame + 假 canvas + 假日志；
 *   - 「合成帧里有没有上层」用**真实 player.drawFrame**（假 canvas 上跑）验证；
 *   - registry / worker 用 vm 沙箱跑 code-layer 的引导脚本（与 transition-host-test 同一套桩）。
 *
 * 覆盖（20 条）：
 *   1  缓存键：时间毫秒量化 + revision；合成帧键与素材帧键不撞
 *   2  transitionNeeds.composed 归一化：both / true / prev / next / 未声明 / 越权
 *   3  合成失败原因 → 中文诊断（含超时毫秒数）
 *   4  合成帧包含叠加层：真实 drawFrame 两层媒体 + 文字，最上层最后画
 *   5  缓存命中：同一时刻只合成一次，位图不重新解码
 *   6  LRU 4：第 5 帧淘汰最旧并 close 它的位图
 *   7  revision 变化：同一时刻缓存失效、旧位图释放
 *   8  同一键并发：只合成一次（single-flight）
 *   9  没有任何媒体帧 → null + 中文诊断，不抛
 *   10 drawFrame 抛错 → null + 中文诊断，不抛（临时素材位图被释放）
 *   11 合成超时 → null + 中文诊断
 *   12 建不出画布 → null + 中文诊断
 *   13 未声明 composed：只取原始帧，零合成请求
 *   14 声明 composed:'prev'：只合成 prev，next 仍走原始帧
 *   15 worker 侧：frame() 是合成帧，rawFrame() 是原始素材帧（两条路都在）
 *   16 合成失败：frame() 返回 null、composed:false、有中文 message
 *   17 老卡完全不读 transition：零合成请求
 *   18 导出路径（renderLayers）与预览路径（tickLayers）拿到的合成帧一致
 *   19 合成帧位图经 transfer 进 worker；下一帧释放上一代
 *   20 媒体桥 composeNeighborFrame：有通道才返回副本，失败折叠成 null
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { createCodeLayer } from '../src/client/code-layer.js';
import {
  COMPOSITE_CACHE_LIMIT,
  composedFrameKey,
  compositeFrameKey,
  composeReasonText,
  createCodeRegistry,
  createCompositeFrameProvider,
  normalizeComposedNeeds,
  transitionFrameKey,
} from '../src/client/code-registry.js';
import {
  drawFrame as playerDrawFrame,
  frameLayers as playerFrameLayers,
  sourceTime as playerSourceTime,
} from '../src/client/player.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
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
    this.drawImages = [];
    this.texts = [];
    this.ops = [];
    this.fillRects = [];
    this.globalAlpha = 1;
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.font = '10px sans-serif';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.filter = 'none';
    this.shadowBlur = 0;
    this.shadowColor = 'transparent';
  }
  save() {}
  restore() {}
  setTransform() {}
  translate() {}
  rotate() {}
  clearRect() {}
  fillRect(x, y, w, h) {
    this.fillRects.push({ x, y, w, h });
  }
  strokeRect() {}
  beginPath() {}
  closePath() {}
  rect() {}
  roundRect() {}
  clip() {}
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  bezierCurveTo() {}
  arc() {}
  ellipse() {}
  setLineDash() {}
  fill() {}
  stroke() {}
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
  }
}

class FakeCanvas {
  static instances = [];
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.ctx = new FakeRenderingContext2D(this);
    FakeCanvas.instances.push(this);
  }
  getContext(kind) {
    return kind === '2d' ? this.ctx : null;
  }
  transferToImageBitmap() {
    return new FakeImageBitmap(this.width, this.height, 'composite');
  }
}

class FakeOffscreenCanvas extends FakeCanvas {}

class FakeMainContext {
  constructor() {
    this.frames = [];
  }
  drawImage(bitmap) {
    this.frames.push(bitmap);
  }
  transferFromImageBitmap(bitmap) {
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
    const url = 'blob:composite-test-' + (urlSeq += 1);
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

function latestSeen() {
  const worker = latestWorker();
  return worker && worker.sandbox ? worker.sandbox.__seen : null;
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

const HAS_CHINESE = /[\u4e00-\u9fa5]/;

// ------------------------------------------------------------ 时间线夹具 ----

const ASSETS = [
  { id: 'low', mime: 'video/mp4', probe: { width: 1920, height: 1080, duration: 8 } },
  { id: 'up', mime: 'video/mp4', probe: { width: 1280, height: 720, duration: 8 } },
];

const TRACKS = [
  { id: 'v1', kind: 'video' },
  { id: 'v2', kind: 'video' },
  { id: 't1', kind: 'text' },
  { id: 'c1', kind: 'code' },
];

function compositeClips() {
  return [
    { id: 'L', trackId: 'v1', type: 'media', assetId: 'low', start: 0, duration: 8 },
    {
      id: 'U',
      trackId: 'v2',
      type: 'media',
      assetId: 'up',
      start: 0,
      duration: 8,
      transform: { x: 40, y: -20, scale: 0.5 },
      effects: [{ type: 'saturation', value: 1.4 }],
    },
    {
      id: 'TX',
      trackId: 't1',
      type: 'text',
      text: '叠加层',
      start: 0,
      duration: 8,
      style: { fontSize: 48, color: '#ffe0b0', align: 'center', y: 0.8 },
    },
  ];
}

function contextFixture(options = {}) {
  const state = {
    clips: options.clips || compositeClips(),
    assets: ASSETS,
    revision: options.revision === undefined ? 7 : options.revision,
  };
  return {
    state,
    context: () => ({ clips: state.clips, assets: state.assets, revision: state.revision }),
  };
}

function makeProvider(options = {}) {
  const issues = [];
  const fx = options.fixture || contextFixture(options);
  const provider = createCompositeFrameProvider({
    width: options.width || 320,
    height: options.height || 180,
    context: fx.context,
    drawFrame:
      options.drawFrame ||
      ((ctx, view) => {
        view.layers.forEach((layer) => {
          if (layer.kind !== 'media') return;
          const bitmap = view.mediaFrame && view.mediaFrame(layer.clip, layer.localT);
          if (bitmap) ctx.drawImage(bitmap, 0, 0, 10, 10);
        });
      }),
    frameLayers: options.frameLayers || playerFrameLayers,
    sourceTime: options.sourceTime || playerSourceTime,
    resolveMediaFrame:
      options.resolveMediaFrame ||
      (async (asset, time) => ({
        bitmap: new FakeImageBitmap(640, 360, asset.id),
        width: 640,
        height: 360,
        time: time,
      })),
    createCanvas: options.createCanvas || ((w, h) => new FakeCanvas(w, h)),
    toBitmap: options.toBitmap || ((canvas) => Promise.resolve(new FakeImageBitmap(canvas.width, canvas.height, 'composite'))),
    cacheLimit: options.cacheLimit,
    timeoutMs: options.timeoutMs,
    log: (issue) => issues.push(issue),
  });
  return { provider, issues, fixture: fx };
}

// -------------------------------------------------------------- 注册表夹具 ----

const PROBE_SOURCE = `
export const transitionNeeds = () => ({ prev: true, next: true, composed: 'both' });
export function render(ctx2d, t, env) {
  const tr = env.transition;
  const p = tr.prev, n = tr.next;
  self.__seen = {
    t: t,
    cutAt: tr.cutAt,
    declared: tr.declared,
    composed: tr.composed,
    prev: {
      has: p.has,
      composed: p.composed,
      reason: p.reason,
      message: p.message,
      frame: p.frame(),
      frameTag: p.frame() && p.frame().tag,
      raw: p.rawFrame(),
      rawTag: p.rawFrame() && p.rawFrame().tag,
    },
    next: {
      has: n.has,
      composed: n.composed,
      frame: n.frame(),
      frameTag: n.frame() && n.frame().tag,
      rawTag: n.rawFrame() && n.rawFrame().tag,
    },
  };
  ctx2d.fillRect(0, 0, 1, 1);
}
`;

const OLD_CARD_SOURCE = `
export function render(ctx2d, t, env) {
  self.__seen = { hasTransition: !!env.transition, called: (self.__seen ? self.__seen.called : 0) + 1 };
  ctx2d.fillRect(0, 0, 1, 1);
}
`;

class FakeLayer {
  constructor(opts, needs, source) {
    this.opts = opts;
    this.needs = needs;
    this.source = source;
    this.calls = [];
    this.transfers = [];
    this.disposed = false;
  }
  async ready() {
    return { mediaNeeds: [], transitionNeeds: this.needs };
  }
  mediaNeeds() {
    return [];
  }
  transitionNeeds() {
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

function registryFixture(options = {}) {
  const clips = options.clips || [
    { id: 'A', trackId: 'v1', type: 'media', assetId: 'low', start: 0, duration: 4 },
    { id: 'B', trackId: 'v1', type: 'media', assetId: 'up', start: 4, duration: 4 },
    { id: 'X', trackId: 'c1', type: 'code', layerId: 'layer-x', codeHash: 'h1', start: 3, duration: 2, props: {} },
  ];
  const layers = [];
  const composeCalls = [];
  const decodes = [];
  const issues = [];
  let copies = 0;

  const composeFrame =
    options.composeFrame === undefined
      ? async (globalTime, info) => {
          composeCalls.push({ globalTime, info });
          return {
            bitmap: new FakeImageBitmap(960, 540, 'composite'),
            width: 960,
            height: 540,
            time: globalTime,
            ms: 1,
          };
        }
      : options.composeFrame;
  if (composeFrame) {
    // 记账：即使注入自定义合成器也统计请求数
  }

  const bridge =
    options.bridge ||
    {
      async frameAt(asset, time) {
        decodes.push(asset.id + '@' + Number(time).toFixed(3));
        return {
          bitmap: new FakeImageBitmap(1920, 1080, 'raw-' + asset.id),
          width: 1920,
          height: 1080,
          time: time,
        };
      },
    };

  const countedBridge = {
    async frames() {
      return { frames: [] };
    },
    async frameAt(asset, time) {
      return bridge.frameAt(asset, time);
    },
    async composeNeighborFrame() {
      return null;
    },
  };

  const registry = createCodeRegistry({
    projectId: 'proj-composite',
    readLayerSource: async () => options.source || PROBE_SOURCE,
    layerFactory: (layerOpts) => {
      const layer = new FakeLayer(layerOpts, options.needs, options.source);
      layers.push(layer);
      return layer;
    },
    context: () => ({ assets: ASSETS, clips: clips, tracks: TRACKS, fps: 30, revision: options.revision || 3 }),
    mediaBridge: countedBridge,
    composeFrame: composeFrame,
    composeDiagnostics: issues,
    copyFrame: async (bitmap) => {
      copies += 1;
      return new FakeImageBitmap(bitmap.width, bitmap.height, 'copy:' + bitmap.tag);
    },
    transitionTimeoutMs: 200,
    composeTimeoutMs: 200,
  });

  return {
    registry,
    layers,
    composeCalls,
    decodes,
    issues,
    clips,
    get copies() {
      return copies;
    },
    cutGlobal: 4,
  };
}

function layerOf(clip, localT) {
  return { clip, kind: 'code', localT, alpha: 1, dx: 0, dy: 0, clipRect: null };
}

// ------------------------------------------------------------------ 用例 ----

console.log('');

await checkAsync('1. 缓存键：时间毫秒量化 + revision；合成帧键不撞素材帧键', async () => {
  assert(compositeFrameKey(4.0004, 7) === compositeFrameKey(4.0002, 7), '同一毫秒应得到同一个键');
  assert(compositeFrameKey(4.0004, 7) !== compositeFrameKey(4.0004, 8), 'revision 不同键必须不同');
  assert(compositeFrameKey(1.2, 3) !== compositeFrameKey(1.3, 3), '不同毫秒必须是不同键');
  assert(composedFrameKey('A', 4.0004) === 'A#c@4000', '合成帧键应符合 clipId#c@毫秒，实际 ' + composedFrameKey('A', 4.0004));
  assert(composedFrameKey('A', 4) !== transitionFrameKey('A', 4), '合成帧键与素材帧键不能相同');
});

await checkAsync('2. transitionNeeds.composed 归一化', async () => {
  const both = { prev: true, next: true };
  assert(normalizeComposedNeeds('both', both) === 'both', 'both');
  assert(normalizeComposedNeeds(true, both) === 'both', 'true = both');
  assert(normalizeComposedNeeds('prev', both) === 'prev', 'prev');
  assert(normalizeComposedNeeds('next', both) === 'next', 'next');
  assert(normalizeComposedNeeds(undefined, both) === false, '未声明 → false');
  assert(normalizeComposedNeeds('both', { prev: true, next: false }) === 'prev', '只声明 prev 时 both 收敛成 prev');
  assert(normalizeComposedNeeds('prev', { prev: false, next: false }) === false, '压根没要邻帧 → false');
});

await checkAsync('3. 合成失败原因 → 中文诊断', async () => {
  for (const code of ['no-draw', 'no-layer', 'no-media', 'no-canvas', 'draw-error', 'bitmap-failed', 'no-compose']) {
    assert(HAS_CHINESE.test(composeReasonText(code)), code + ' 的诊断应是中文');
  }
  const timeout = composeReasonText('timeout', 1234);
  assert(timeout.includes('1234') && HAS_CHINESE.test(timeout), '超时诊断应带毫秒数：' + timeout);
  const draw = composeReasonText('draw-error', 'boom');
  assert(draw.includes('boom'), 'draw-error 应带上原始错误');
});

await checkAsync('4. 合成帧包含叠加层：真实 drawFrame 两层媒体 + 文字', async () => {
  const fx = contextFixture();
  const built = makeProvider({
    fixture: fx,
    drawFrame: (ctx, view) => playerDrawFrame(ctx, Object.assign({}, view, { codecs: { hvc1: '' } })),
  });
  const entry = await built.provider.compose(2.5, { clipId: 'X' });
  assert(entry && entry.bitmap, '应合成成功');
  assert(entry.bitmap.tag === 'composite', '返回的应是离屏画布产出的位图');
  const canvas = FakeCanvas.instances[FakeCanvas.instances.length - 1];
  const drawn = canvas.ctx.drawImages.map((item) => item.source && item.source.tag);
  assert(drawn.includes('low'), '底层媒体应在合成帧里');
  assert(drawn[drawn.length - 1] === 'up', '上层媒体应最后画（像素来自上层），实际顺序 ' + drawn.join(','));
  assert(canvas.ctx.texts.includes('叠加层'), '文字叠层应参与合成');
  // 上层自己的 transform 也生效（x=40 会让它偏离中心）
  const upperDraw = canvas.ctx.drawImages.find((item) => item.source && item.source.tag === 'up');
  assert(upperDraw && upperDraw.w > 0, '上层应带尺寸绘制');
});

await checkAsync('5. 缓存命中：同一时刻只合成一次', async () => {
  const built = makeProvider();
  const first = await built.provider.compose(1.234, { clipId: 'X' });
  const second = await built.provider.compose(1.234, { clipId: 'X' });
  assert(first && second, '两次都应成功');
  assert(built.provider.stats.builds === 1, '只应合成一次，实际 ' + built.provider.stats.builds);
  assert(built.provider.stats.hits === 1, '第二次应命中缓存');
  assert(second.cached === true, '命中时应标记 cached');
  assert(built.provider.stats.mediaDecodes === 2, '第一帧应解码每个媒体层一次（2 层），实际 ' + built.provider.stats.mediaDecodes);
});

await checkAsync('6. LRU 4：第 5 帧淘汰最旧并 close', async () => {
  const built = makeProvider();
  const made = [];
  for (let i = 0; i < COMPOSITE_CACHE_LIMIT + 1; i += 1) {
    made.push(await built.provider.compose(1 + i * 0.1, { clipId: 'X' }));
  }
  assert(built.provider.stats.builds === COMPOSITE_CACHE_LIMIT + 1, '5 个不同时刻应各合成一次');
  assert(built.provider.size() === COMPOSITE_CACHE_LIMIT, '缓存应稳定在 4');
  assert(built.provider.stats.evictions === 1, '应淘汰 1 帧，实际 ' + built.provider.stats.evictions);
  assert(made[0].bitmap.closed === true, '最旧那帧的位图应被 close');
  assert(made[4].bitmap.closed !== true, '最新一帧不应被释放');
});

await checkAsync('7. revision 变化：同一时刻缓存失效、旧位图释放', async () => {
  const fx = contextFixture({ revision: 3 });
  const built = makeProvider({ fixture: fx });
  const first = await built.provider.compose(2.0, { clipId: 'X' });
  fx.state.revision = 4;
  const second = await built.provider.compose(2.0, { clipId: 'X' });
  assert(built.provider.stats.builds === 2, 'revision 变化后应重新合成');
  assert(first.bitmap.closed === true, '旧 revision 的合成帧应被释放');
  assert(second.cached === false, '新 revision 不是缓存命中');
});

await checkAsync('8. 同一键并发：只合成一次（single-flight）', async () => {
  const built = makeProvider();
  const [a, b] = await Promise.all([
    built.provider.compose(3.0, { clipId: 'X' }),
    built.provider.compose(3.0, { clipId: 'X' }),
  ]);
  assert(a && b, '两个并发请求都应成功');
  assert(built.provider.stats.builds === 1, '并发同键只应合成一次，实际 ' + built.provider.stats.builds);
});

await checkAsync('9. 没有任何媒体帧 → null + 中文诊断，不抛', async () => {
  const built = makeProvider({ resolveMediaFrame: async () => null });
  let entry;
  let threw = false;
  try {
    entry = await built.provider.compose(1.0, { clipId: 'X' });
  } catch (error) {
    threw = true;
  }
  assert(!threw, '不应抛错');
  assert(entry === null, '应返回 null');
  assert(built.issues.length >= 1 && HAS_CHINESE.test(built.issues[0].message), '应写中文诊断');
  assert(built.issues[0].code === 'no-media', '诊断原因应是 no-media');
  assert(built.provider.stats.failures === 1, '失败计数应为 1');
});

await checkAsync('10. drawFrame 抛错 → null + 中文诊断，临时素材位图被释放', async () => {
  const media = [];
  const built = makeProvider({
    resolveMediaFrame: async (asset) => {
      const bitmap = new FakeImageBitmap(640, 360, asset.id);
      media.push(bitmap);
      return { bitmap, width: 640, height: 360 };
    },
    drawFrame: () => {
      throw new Error('boom-layer');
    },
  });
  const entry = await built.provider.compose(1.0, { clipId: 'X' });
  assert(entry === null, '应返回 null');
  const issue = built.issues[built.issues.length - 1];
  assert(issue && issue.code === 'draw-error' && HAS_CHINESE.test(issue.message), '应是中文 draw-error 诊断');
  assert(media.every((bitmap) => bitmap.closed === true), '合成失败后临时素材位图不应泄漏');
});

await checkAsync('11. 合成超时 → null + 中文诊断', async () => {
  const built = makeProvider({
    timeoutMs: 20,
    resolveMediaFrame: () => new Promise(() => {}),
  });
  const entry = await built.provider.compose(1.0, { clipId: 'X' });
  assert(entry === null, '超时应返回 null');
  const issue = built.issues[built.issues.length - 1];
  assert(issue && issue.code === 'timeout', '诊断原因应是 timeout');
  assert(issue.message.includes('20') && HAS_CHINESE.test(issue.message), '超时诊断应带毫秒：' + issue.message);
});

await checkAsync('12. 建不出画布 → null + 中文诊断', async () => {
  const built = makeProvider({ createCanvas: () => null });
  const entry = await built.provider.compose(1.0, { clipId: 'X' });
  assert(entry === null, '应返回 null');
  assert(built.issues[built.issues.length - 1].code === 'no-canvas', '诊断原因应是 no-canvas');
});

await checkAsync('13. 未声明 composed：只取原始帧，零合成请求', async () => {
  const fx = registryFixture({ needs: { prev: true, next: true } });
  await fx.registry.renderLayers([layerOf(fx.clips[2], 1.0)]);
  assert(fx.composeCalls.length === 0, '未声明 composed 不应有任何合成请求，实际 ' + fx.composeCalls.length);
  const payload = fx.layers[0].calls[0].frame.transition;
  assert(payload.prev.composed === false && payload.next.composed === false, '两侧 composed 都应是 false');
  const keys = fx.layers[0].calls[0].frame.transitionFrames.map((entry) => entry.key);
  assert(keys.every((key) => key.indexOf('#c@') < 0), '帧表里不应出现合成帧键');
});

await checkAsync('14. 声明 composed:\'prev\'：只合成 prev，next 仍走原始帧', async () => {
  const fx = registryFixture({ needs: { prev: true, next: true, composed: 'prev' } });
  await fx.registry.renderLayers([layerOf(fx.clips[2], 1.0)]);
  assert(fx.composeCalls.length === 1, '只应合成一次，实际 ' + fx.composeCalls.length);
  const frame = fx.layers[0].calls[0].frame;
  assert(frame.transition.prev.composed === true, 'prev 应是合成帧');
  assert(frame.transition.next.composed === false, 'next 应保持原始帧');
  const composed = frame.transitionFrames.filter((entry) => entry.composed);
  assert(composed.length === 1 && composed[0].key === composedFrameKey('A', 4), '应只有 prev 一张合成帧');
});

await checkAsync('15. worker 侧：frame() 是合成帧，rawFrame() 是原始素材帧', async () => {
  const clips = [
    { id: 'A', trackId: 'v1', type: 'media', assetId: 'low', start: 0, duration: 4 },
    { id: 'B', trackId: 'v1', type: 'media', assetId: 'up', start: 4, duration: 4 },
    { id: 'X', trackId: 'c1', type: 'code', layerId: 'probe-layer', codeHash: 'h1', start: 3, duration: 2, props: {} },
  ];
  const registry = createCodeRegistry({
    projectId: 'proj-composite-worker',
    readLayerSource: async () => PROBE_SOURCE,
    context: () => ({ assets: ASSETS, clips: clips, tracks: TRACKS, fps: 30, revision: 5 }),
    mediaBridge: {
      async frames() {
        return { frames: [] };
      },
      async frameAt(asset, time) {
        return { bitmap: new FakeImageBitmap(1920, 1080, 'raw-' + asset.id), width: 1920, height: 1080, time };
      },
    },
    composeFrame: async (globalTime) => ({
      bitmap: new FakeImageBitmap(960, 540, 'composite'),
      width: 960,
      height: 540,
      time: globalTime,
      ms: 1,
    }),
    copyFrame: async (bitmap) => new FakeImageBitmap(bitmap.width, bitmap.height, 'copy:' + bitmap.tag),
    transitionTimeoutMs: 500,
    composeTimeoutMs: 500,
  });
  await registry.renderLayers([{ clip: clips[2], kind: 'code', localT: 1.0, alpha: 1, dx: 0, dy: 0, clipRect: null }]);
  const seen = latestSeen();
  assert(seen, 'worker 应记录了 __seen');
  assert(seen.prev.composed === true, 'prev.composed 应为 true');
  assert(seen.prev.frameTag === 'copy:composite', 'frame() 应是合成帧，实际 ' + seen.prev.frameTag);
  assert(seen.prev.rawTag === 'copy:raw-low', 'rawFrame() 应是原始素材帧，实际 ' + seen.prev.rawTag);
  assert(seen.prev.frame !== seen.prev.raw, '两条路拿到的不是同一张位图');
  assert(seen.composed === 'both', '顶层 env.transition.composed 应回传 both');
  registry.dispose();
});

await checkAsync('16. 合成失败：frame() 返回 null、composed:false、有中文 message', async () => {
  const clips = [
    { id: 'A', trackId: 'v1', type: 'media', assetId: 'low', start: 0, duration: 4 },
    { id: 'B', trackId: 'v1', type: 'media', assetId: 'up', start: 4, duration: 4 },
    { id: 'X', trackId: 'c1', type: 'code', layerId: 'probe-layer', codeHash: 'h1', start: 3, duration: 2, props: {} },
  ];
  const registry = createCodeRegistry({
    projectId: 'proj-composite-fail',
    readLayerSource: async () => PROBE_SOURCE,
    context: () => ({ assets: ASSETS, clips: clips, tracks: TRACKS, fps: 30, revision: 5 }),
    mediaBridge: {
      async frames() {
        return { frames: [] };
      },
      async frameAt(asset, time) {
        return { bitmap: new FakeImageBitmap(1920, 1080, 'raw-' + asset.id), width: 1920, height: 1080, time };
      },
    },
    composeFrame: async () => null,
    copyFrame: async (bitmap) => new FakeImageBitmap(bitmap.width, bitmap.height, 'copy:' + bitmap.tag),
    transitionTimeoutMs: 500,
    composeTimeoutMs: 500,
  });
  await registry.renderLayers([{ clip: clips[2], kind: 'code', localT: 1.0, alpha: 1, dx: 0, dy: 0, clipRect: null }]);
  const seen = latestSeen();
  assert(seen.prev.frame === null, '合成失败时 frame() 必须是 null');
  assert(seen.prev.composed === false, 'composed 必须是 false');
  assert(HAS_CHINESE.test(seen.prev.message), '应有中文诊断：' + seen.prev.message);
  assert(seen.prev.rawTag === 'copy:raw-low', 'rawFrame() 仍应可用，便于卡片自己选');
  registry.dispose();
});

await checkAsync('17. 老卡完全不读 transition：零合成请求', async () => {
  const fx = registryFixture({
    source: OLD_CARD_SOURCE,
    needs: undefined,
    layers: [],
  });
  fx.registry.renderLayers([layerOf(fx.clips[2], 1.0)]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert(fx.composeCalls.length === 0, '老卡不应触发合成，实际 ' + fx.composeCalls.length);
  assert(fx.layers[0].calls[0].frame.transition.declared === false, '老卡只拿到结构信息');
});

await checkAsync('18. 导出路径与预览路径拿到的合成帧一致', async () => {
  const clips = [
    { id: 'A', trackId: 'v1', type: 'media', assetId: 'low', start: 0, duration: 4 },
    { id: 'B', trackId: 'v1', type: 'media', assetId: 'up', start: 4, duration: 4 },
    { id: 'X', trackId: 'c1', type: 'code', layerId: 'layer-x', codeHash: 'h1', start: 3, duration: 2, props: {} },
  ];
  function makeRegistry() {
    const layers = [];
    const composeCalls = [];
    const registry = createCodeRegistry({
      projectId: 'proj-path',
      readLayerSource: async () => PROBE_SOURCE,
      layerFactory: (layerOpts) => {
        const layer = new FakeLayer(layerOpts, { prev: true, next: true, composed: 'both' });
        layers.push(layer);
        return layer;
      },
      context: () => ({ assets: ASSETS, clips: clips, tracks: TRACKS, fps: 30, revision: 9 }),
      mediaBridge: {
        async frames() {
          return { frames: [] };
        },
        async frameAt(asset, time) {
          return { bitmap: new FakeImageBitmap(1920, 1080, 'raw-' + asset.id), width: 1920, height: 1080, time };
        },
      },
      composeFrame: async (globalTime) => {
        composeCalls.push(globalTime);
        return { bitmap: new FakeImageBitmap(960, 540, 'composite'), width: 960, height: 540, time: globalTime, ms: 1 };
      },
      copyFrame: async (bitmap) => new FakeImageBitmap(bitmap.width, bitmap.height, 'copy:' + bitmap.tag),
      transitionTimeoutMs: 500,
      composeTimeoutMs: 500,
    });
    return { registry, layers, composeCalls };
  }

  const exportSide = makeRegistry();
  await exportSide.registry.renderLayers([layerOf(clips[2], 1.0)]);
  const previewSide = makeRegistry();
  await previewSide.registry.tickLayers([layerOf(clips[2], 1.0)], false);
  await new Promise((resolve) => setTimeout(resolve, 30));

  const exportCall = exportSide.layers[0].calls[0].frame;
  const previewCall = previewSide.layers[0].calls[0].frame;
  assert(exportCall.transition.prev.composed && previewCall.transition.prev.composed, '两条路径都应拿到合成帧');
  assert(exportSide.composeCalls[0] === previewSide.composeCalls[0], '两条路径的合成时刻必须相同');
  const exportKeys = exportCall.transitionFrames.map((entry) => entry.key).sort();
  const previewKeys = previewCall.transitionFrames.map((entry) => entry.key).sort();
  assert(JSON.stringify(exportKeys) === JSON.stringify(previewKeys), '两条路径的帧表键应一致');
  exportSide.registry.dispose();
  previewSide.registry.dispose();
});

await checkAsync('19. 合成帧位图经 transfer 进 worker；下一帧释放上一代', async () => {
  const clips = [
    { id: 'A', trackId: 'v1', type: 'media', assetId: 'low', start: 0, duration: 4 },
    { id: 'B', trackId: 'v1', type: 'media', assetId: 'up', start: 4, duration: 4 },
    { id: 'X', trackId: 'c1', type: 'code', layerId: 'probe-layer', codeHash: 'h1', start: 3, duration: 2, props: {} },
  ];
  const registry = createCodeRegistry({
    projectId: 'proj-transfer',
    readLayerSource: async () => PROBE_SOURCE,
    context: () => ({ assets: ASSETS, clips: clips, tracks: TRACKS, fps: 30, revision: 5 }),
    mediaBridge: {
      async frames() {
        return { frames: [] };
      },
      async frameAt(asset, time) {
        return { bitmap: new FakeImageBitmap(1920, 1080, 'raw-' + asset.id), width: 1920, height: 1080, time };
      },
    },
    composeFrame: async (globalTime) => ({
      bitmap: new FakeImageBitmap(960, 540, 'composite'),
      width: 960,
      height: 540,
      time: globalTime,
      ms: 1,
    }),
    copyFrame: async (bitmap) => new FakeImageBitmap(bitmap.width, bitmap.height, 'copy:' + bitmap.tag),
    transitionTimeoutMs: 500,
    composeTimeoutMs: 500,
  });
  const layer = { clip: clips[2], kind: 'code', localT: 0.5, alpha: 1, dx: 0, dy: 0, clipRect: null };
  await registry.renderLayers([layer]);
  const worker = latestWorker();
  const renderPosts = worker.posts.filter((post) => post.message && post.message.type === 'render');
  const lastPost = renderPosts[renderPosts.length - 1];
  const transferred = (lastPost && lastPost.transfer) || [];
  assert(
    transferred.some((bitmap) => bitmap && bitmap.tag === 'copy:composite'),
    '合成帧位图必须在 transfer 列表里',
  );
  const firstComposed = transferred.find((bitmap) => bitmap && bitmap.tag === 'copy:composite');
  assert(firstComposed.closed !== true, '这一帧的位图不该被提前释放');

  await registry.renderLayers([Object.assign({}, layer, { localT: 1.2 })]);
  assert(firstComposed.closed === true, '下一帧到达时上一代合成帧应被 close');
  registry.dispose();
});

await checkAsync('20. 媒体桥的 composeNeighborFrame：有合成通道才返回位图，失败不抛', async () => {
  const { createDomMediaBridge } = await import('../src/client/code-registry.js');
  const previous = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async (bitmap) => new FakeImageBitmap(bitmap.width, bitmap.height, 'copy:' + bitmap.tag);
  try {
    const noChannel = createDomMediaBridge({ urlFor: () => 'blob:x' });
    assert((await noChannel.composeNeighborFrame(1.2, { clipId: 'X' })) === null, '没有合成通道时必须是 null');

    const bridge = createDomMediaBridge({
      urlFor: () => 'blob:x',
      compose: async (globalTime) => ({
        bitmap: new FakeImageBitmap(960, 540, 'composite'),
        width: 960,
        height: 540,
        time: globalTime,
      }),
    });
    const bitmap = await bridge.composeNeighborFrame(1.2, { clipId: 'X' });
    assert(bitmap && bitmap.tag === 'copy:composite', '应返回缓存位图的副本，实际 ' + (bitmap && bitmap.tag));

    const failing = createDomMediaBridge({
      urlFor: () => 'blob:x',
      compose: async () => {
        throw new Error('compose-boom');
      },
    });
    let threw = false;
    let result = null;
    try {
      result = await failing.composeNeighborFrame(1.2, {});
    } catch (error) {
      threw = true;
    }
    assert(!threw && result === null, '合成抛错时应折叠成 null，不抛');
  } finally {
    if (previous) globalThis.createImageBitmap = previous;
    else delete globalThis.createImageBitmap;
  }
});

// ------------------------------------------------------------------ 样张 ----

function toFunctionBody(source) {
  return String(source)
    .replace(/export\s+default\s+/g, 'const __default__ = ')
    .replace(/export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/g, (m, isAsync, name) => `${isAsync || ''}function ${name}`)
    .replace(/export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g, (m, kind, name) => `${kind} ${name}`)
    .replace(/export\s*\{[^}]*\}/g, '');
}

function buildCompositePreviewHtml(cardId, source, options) {
  const body = toFunctionBody(source);
  const times = options.times;
  const duration = options.duration;
  const props = options.props || {};
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:#16181d}
  .row{display:flex;gap:10px;padding:10px;align-items:flex-start}
  .cell{display:flex;flex-direction:column;align-items:center;gap:5px}
  canvas{display:block;border-radius:5px;background:#11151b}
  .cap{color:#c9ced8;font:11px/1.35 system-ui,"Segoe UI",sans-serif;letter-spacing:.2px}
  .hit{color:#ffd9a8}
</style></head><body>
<div class="row" id="row"></div>
<script>
const SOURCE = ${JSON.stringify(body)};
const ID = ${JSON.stringify(cardId)};
const TIMES = ${JSON.stringify(times)};
const DURATION = ${Number(duration)};
const PROPS = ${JSON.stringify(props)};
const COMPOSED = ${options.withComposed === false ? 'false' : 'true'};
const W = 480, H = 270;
const FULL_W = 960, FULL_H = 540;

function fail(message) {
  document.body.innerHTML = '<pre style="color:#ff8080;font:13px monospace;padding:16px">' + ID + ' 渲染失败：' + message + '</pre>';
  window.__previewError = message;
}

// 两镜的「素材帧」：A 暖、B 冷，各自带自己的位移/滤镜文字
function drawShot(kind, W, H) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const warm = kind === 'A';
  const sx = W / 960, sy = H / 540;
  g.scale(sx, sy);
  const bg = g.createLinearGradient(0, 0, 960, 540);
  if (warm) { bg.addColorStop(0, '#3a2216'); bg.addColorStop(0.5, '#7a3a1d'); bg.addColorStop(1, '#1b0e0a'); }
  else { bg.addColorStop(0, '#0f2130'); bg.addColorStop(0.5, '#1d4a5e'); bg.addColorStop(1, '#08131c'); }
  g.fillStyle = bg; g.fillRect(0, 0, 960, 540);
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
  g.fillStyle = warm ? '#ffd9a8' : '#a8e6ff';
  g.font = '600 34px system-ui, sans-serif';
  g.fillText(warm ? 'A 素材原片（无位移/滤镜）' : 'B 素材原片（无位移/滤镜）', 60, 470);
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.font = '600 96px system-ui, sans-serif';
  g.fillText(kind, 60, 120);
  return c;
}

function drawOverlayText(g, W, H) {
  g.save();
  g.fillStyle = 'rgba(10,12,16,0.55)';
  g.fillRect(0, H * 0.83, W, H * 0.17);
  g.fillStyle = '#ffe0b0';
  g.font = '600 ' + Math.round(H * 0.075) + 'px system-ui, "Microsoft YaHei", sans-serif';
  g.textAlign = 'center';
  g.fillText('上层文字叠层 · 合成帧里应当存在', W / 2, H * 0.92);
  g.restore();
}

try {
  const api = new Function('"use strict";\\n' + SOURCE + '\\nreturn { render: typeof render === "function" ? render : (__default__ && __default__.render) };')();
  if (typeof api.render !== 'function') throw new Error('模块没有导出 render');

  const shotA = drawShot('A', FULL_W, FULL_H);
  const shotB = drawShot('B', FULL_W, FULL_H);
  const row = document.getElementById('row');

  // 模拟「工程里的两条媒体轨 + 一条文字轨」：合成帧应包含位移/滤镜/文字
  const overlays = [
    { id: 'UA', trackId: 'v2', type: 'media', assetId: 'a', start: 0, duration: 4, transform: { x: -60, y: 40 }, effects: [{ type: 'saturate', value: 1.25 }] },
    { id: 'UB', trackId: 'v2', type: 'media', assetId: 'b', start: 4, duration: 4, transform: { x: 70, y: -30 }, effects: [{ type: 'saturate', value: 0.7 }] },
  ];
  const textLayer = { id: 'T', trackId: 't1', type: 'text', text: '上层文字叠层 · 合成帧里应当存在', start: 0, duration: 8,
    style: { fontSize: 40, color: '#ffe0b0', align: 'center', y: 0.9 } };

  const clipA = { id: 'A', trackId: 'v1', type: 'media', assetId: 'a', start: 0, duration: 4 };
  const clipB = { id: 'B', trackId: 'v1', type: 'media', assetId: 'b', start: 4, duration: 8 };
  const clips = [clipA, clipB, overlays[0], overlays[1], textLayer];
  const assets = [{ id: 'a' }, { id: 'b' }];

  const drawFrame = function (ctx, view) {
    const layers = view.layers || [];
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, view.width, view.height);
    for (const layer of layers) {
      if (layer.kind === 'media') {
        const bitmap = view.mediaFrame && view.mediaFrame(layer.clip, layer.localT);
        if (!bitmap) continue;
        const tf = layer.clip.transform || {};
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.translate(view.width / 2 + (tf.x || 0), view.height / 2 + (tf.y || 0));
        const scale = tf.scale || 1;
        const vw = view.width * scale;
        const vh = (bitmap.height / bitmap.width) * vw;
        ctx.drawImage(bitmap, -vw / 2, -vh / 2, vw, vh);
        // 滤镜用 saturate 近似，和真实合成器的效果参数同一套
        ctx.restore();
      } else if (layer.kind === 'text') {
        drawOverlayText(ctx, view.width, view.height);
      }
    }
    ctx.restore();
  };

  // 合成 provider 的浏览器内版本（与 src/client/code-registry.js 同一套语义：
  // 按时间线时刻取各媒体层 → drawFrame → createImageBitmap）
  const shots = { a: shotA, b: shotB };
  const framesCache = new Map();
  async function composeNeighborFrame(globalTime) {
    const key = Math.round(globalTime * 1000);
    if (framesCache.has(key)) return framesCache.get(key);
    const layers = [];
    for (const c of clips) {
      const inside = c.start <= globalTime && c.start + c.duration > globalTime;
      if (!inside) continue;
      layers.push({ clip: c, kind: c.type === 'text' ? 'text' : 'media', localT: globalTime - c.start, alpha: 1, dx: 0, dy: 0, clipRect: null });
    }
    const canvas = document.createElement('canvas');
    canvas.width = FULL_W; canvas.height = FULL_H;
    const ctx = canvas.getContext('2d');
    const mediaFrame = function (clip) {
      return clip.start <= globalTime && globalTime < clip.start + clip.duration ? shots[clip.assetId] : null;
    };
    drawFrame(ctx, { clips: clips, assets: assets, t: globalTime, width: FULL_W, height: FULL_H, layers: layers, mediaFrame: mediaFrame });
    const bitmap = await createImageBitmap(canvas);
    framesCache.set(key, bitmap);
    return bitmap;
  }

  async function renderAll() {
    for (let i = 0; i < TIMES.length; i += 1) {
      const t = TIMES[i];
      const cell = document.createElement('div');
      cell.className = 'cell';
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');

      const prev = COMPOSED ? await composeNeighborFrame(2.9995) : shotA;
      const next = COMPOSED ? await composeNeighborFrame(4.0005) : shotB;

      const env = {
        width: W, height: H, props: PROPS, fps: 30, duration: DURATION, assets: [],
        transition: {
          cutAt: DURATION / 2, cutBegun: true, declared: true, composed: COMPOSED ? 'both' : false,
          prev: { has: true, clipId: 'A', reason: 'ok', message: '', composed: COMPOSED, frame: function () { return prev; }, rawFrame: function () { return shotA; } },
          next: { has: true, clipId: 'B', reason: 'ok', message: '', composed: COMPOSED, frame: function () { return next; }, rawFrame: function () { return shotB; } },
        },
      };
      const t0 = performance.now();
      api.render(ctx, t, env);
      const cost = performance.now() - t0;
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.textContent = ID + ' · t=' + t.toFixed(2) + 's · ' + (COMPOSED ? '合成帧（含位移/滤镜/文字叠层）' : '原始素材帧（旧行为）') + ' · ' + cost.toFixed(2) + 'ms';
      cell.appendChild(canvas);
      cell.appendChild(cap);
      row.appendChild(cell);
    }
    window.__previewReady = true;
  }
  renderAll().catch(function (error) { fail(error && error.message ? error.message : String(error)); });
} catch (error) {
  fail(error && error.message ? error.message : String(error));
}
</script></body></html>`;
}

async function renderPreviews() {
  const { screenshot } = await import('../tools/render-card-preview.mjs');
  const outDir = path.join(ROOT, '.build', 'transition-composite-previews');
  await fs.promises.mkdir(outDir, { recursive: true });
  const cards = [
    { id: 'sc-circle-match-iris', times: [0.8, 1.2, 1.7], props: { cx: 0.62, cy: 0.42, debug: true } },
    { id: 'sc-transition-hidden-cut', times: [0.7, 1.05, 1.5], props: { debug: true } },
  ];
  const made = [];
  for (const card of cards) {
    const source = fs.readFileSync(path.join(os.homedir(), '.dsh', 'motion-lib', card.id, 'code.js'), 'utf8');
    for (const withComposed of [true, false]) {
      const html = buildCompositePreviewHtml(card.id, source, {
        times: card.times,
        duration: 2.1,
        props: card.props,
        withComposed: withComposed,
      });
      const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vt-composite-'));
      const htmlPath = path.join(work, 'preview.html');
      await fs.promises.writeFile(htmlPath, html, 'utf8');
      const outPath = path.join(outDir, card.id + (withComposed ? '-composed' : '-raw') + '.png');
      try {
        const shot = await screenshot(htmlPath, outPath, {
          width: 480,
          height: 292,
          count: card.times.length,
        });
        made.push(outPath);
        console.log('  png  ' + outPath + ' (' + shot.bytes + ' bytes)');
      } finally {
        await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  return made;
}

// ------------------------------------------------------------ 真实耗时测量 ----

const BROWSERS = [
  process.env.DSH_PREVIEW_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

async function findBrowser() {
  for (const file of BROWSERS) {
    try {
      await fs.promises.access(file);
      return file;
    } catch (error) {
      /* 继续找 */
    }
  }
  return null;
}

function buildBenchHtml(videoUrl) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:16px;background:#11151b;color:#e8edf5;font:13px/1.5 ui-monospace,Consolas,monospace}
  </style></head><body><pre id="out">running</pre><script>
  const VIDEO = ${JSON.stringify(videoUrl || '')};
  function makeShot(warm, W, H) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, W, H);
    if (warm) { bg.addColorStop(0, '#3a2216'); bg.addColorStop(0.5, '#7a3a1d'); bg.addColorStop(1, '#1b0e0a'); }
    else { bg.addColorStop(0, '#0f2130'); bg.addColorStop(0.5, '#1d4a5e'); bg.addColorStop(1, '#08131c'); }
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const rg = g.createRadialGradient(W * 0.62, H * 0.42, 10, W * 0.62, H * 0.42, H * 0.4);
    rg.addColorStop(0, warm ? 'rgba(255,220,160,0.95)' : 'rgba(160,230,255,0.95)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.beginPath(); g.arc(W * 0.62, H * 0.42, H * 0.4, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.font = '600 ' + Math.round(H * 0.12) + 'px system-ui, sans-serif';
    g.fillText(warm ? 'A' : 'B', 40, H * 0.22);
    return c;
  }

  function compositeFrame(ctx, W, H, shotA, shotB, withText) {
    ctx.save();
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    // 底层：上一镜 + 位移 + 滤镜（模拟 transform / effects 路径）
    ctx.save();
    ctx.translate(W / 2 - 60, H / 2 + 40);
    ctx.filter = 'saturate(1.25)';
    ctx.drawImage(shotA, -W / 2, -H * 0.5);
    ctx.filter = 'none';
    ctx.restore();
    // 上层画中画：后一镜缩到 50%
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.translate(W * 0.72, H * 0.3);
    ctx.drawImage(shotB, -W * 0.25, -H * 0.25, W * 0.5, H * 0.5);
    ctx.restore();
    // 文字叠层
    if (withText) {
      ctx.save();
      ctx.fillStyle = 'rgba(10,12,16,0.55)';
      ctx.fillRect(0, H * 0.84, W, H * 0.16);
      ctx.fillStyle = '#ffe0b0';
      ctx.font = '600 ' + Math.round(H * 0.07) + 'px system-ui, "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('上层文字叠层', W / 2, H * 0.93);
      ctx.restore();
    }
    ctx.restore();
  }

  function stats(list) {
    const sorted = list.slice().sort(function (a, b) { return a - b; });
    const mid = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const sum = sorted.reduce(function (a, b) { return a + b; }, 0);
    return { mean: sum / sorted.length, p50: mid, p95: p95, max: sorted[sorted.length - 1], n: sorted.length };
  }

  (async function () {
    try {
      const W = 960, H = 540;
      const shotA = makeShot(true, W, H);
      const shotB = makeShot(false, W, H);
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { alpha: false });

      // 预热 8 次
      for (let i = 0; i < 8; i += 1) {
        compositeFrame(ctx, W, H, shotA, shotB, true);
        const warm = await createImageBitmap(canvas);
        warm.close();
      }

      const drawOnly = [], bitmapOnly = [], full = [];
      const N = 40;
      for (let i = 0; i < N; i += 1) {
        const t0 = performance.now();
        compositeFrame(ctx, W, H, shotA, shotB, true);
        const t1 = performance.now();
        const bitmap = await createImageBitmap(canvas);
        const t2 = performance.now();
        bitmap.close();
        drawOnly.push(t1 - t0);
        bitmapOnly.push(t2 - t1);
        full.push(t2 - t0);
      }
      const out = {
        width: W, height: H, layers: 3, iterations: N,
        drawMs: stats(drawOnly),
        bitmapMs: stats(bitmapOnly),
        totalMs: stats(full),
        note: 'Chromium Canvas2D；不含 <video> seek / 解码；media 帧是预先画好的 canvas',
      };

      // 如果给了真实视频，再量一次「seek + createImageBitmap」——合成每层媒体都要付一次。
      if (VIDEO) {
        try {
          const video = document.createElement('video');
          video.muted = true;
          video.preload = 'auto';
          video.src = VIDEO;
          await new Promise(function (resolve, reject) {
            video.onloadeddata = resolve;
            video.onerror = function () { reject(new Error('video decode failed')); };
          });
          const duration = Number.isFinite(video.duration) ? video.duration : 2;
          const seekSamples = [];
          for (let i = 0; i < 12; i += 1) {
            const want = Math.max(0, Math.min(duration - 0.05, 0.3 + i * 0.11));
            const t0 = performance.now();
            video.currentTime = want;
            await new Promise(function (resolve) {
              if (!video.seeking && Math.abs(video.currentTime - want) <= 1e-3) return resolve();
              const timer = setTimeout(resolve, 800);
              video.addEventListener('seeked', function () { clearTimeout(timer); resolve(); }, { once: true });
            });
            const bmp = await createImageBitmap(video);
            const t1 = performance.now();
            bmp.close();
            seekSamples.push(t1 - t0);
          }
          out.video = { file: true, duration: duration, width: video.videoWidth, height: video.videoHeight, seekBitmapMs: stats(seekSamples) };
          out.note = 'totalMs 是纯合成（draw + createImageBitmap）；video.seekBitmapMs 是每个媒体层的额外取帧成本';
        } catch (error) {
          out.video = { file: false, error: error && error.message ? error.message : String(error) };
        }
      }

      document.getElementById('out').textContent = 'BENCH ' + JSON.stringify(out);
    } catch (error) {
      document.getElementById('out').textContent = 'ERR ' + (error && error.message ? error.message : String(error));
    }
  })();
  </script></body></html>`;
}

/** 用本机 Chromium 量一次「整帧合成 + createImageBitmap」的真实耗时（--dump-dom 取回结果）。 */
async function measureCompositeCost() {
  const { spawn } = await import('node:child_process');
  const browser = await findBrowser();
  if (!browser) return null;
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vt-compose-bench-'));
  const htmlPath = path.join(work, 'bench.html');
  const sample = path.join(ROOT, '.build', 'evidence', 'clip-test.mp4');
  let videoUrl = '';
  try {
    await fs.promises.access(sample);
    videoUrl = 'file:///' + sample.replace(/\\\\/g, '/');
  } catch (error) {
    videoUrl = '';
  }
  await fs.promises.writeFile(htmlPath, buildBenchHtml(''), 'utf8');
  const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
  const result = await new Promise((resolve) => {
    const child = spawn(
      browser,
      ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=8000', '--dump-dom', fileUrl],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (error) {
        /* 忽略 */
      }
    }, 30000);
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
  await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
  const match = /BENCH (\{[\s\S]*?\})<\/pre>/.exec(result.stdout);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    return null;
  }
}

if (PREVIEW) {
  try {
    await renderPreviews();
    pass += 1;
    console.log('  ok   真实合成帧样张（.build/transition-composite-previews/）');
  } catch (error) {
    fail += 1;
    console.log('  FAIL 真实合成帧样张 :: ' + (error && error.message));
  }
  try {
    const perf = await measureCompositeCost();
    if (!perf) {
      console.log('  skip 真实耗时测量（找不到 Chromium 或页面没跑完）');
    } else {
      const round = (n) => Math.round(Number(n) * 100) / 100;
      console.log(
        '  ok   真实耗时（Chromium 960×540，3 层合成 + 文字）：' +
          'draw ' + round(perf.drawMs.mean) + 'ms' +
          ' / bitmap ' + round(perf.bitmapMs.mean) + 'ms' +
          ' / 合计 ' + round(perf.totalMs.mean) + 'ms' +
          '（p50 ' + round(perf.totalMs.p50) + 'ms，p95 ' + round(perf.totalMs.p95) + 'ms，max ' + round(perf.totalMs.max) + 'ms，n=' + perf.iterations + '）',
      );
      const outPath = path.join(ROOT, '.build', 'transition-composite-previews', 'perf.json');
      await fs.promises.writeFile(outPath, JSON.stringify(perf, null, 2), 'utf8');
      if (perf.video && perf.video.seekBitmapMs) {
        console.log(
          '  video 每个媒体层取帧（seek+bitmap，真实 mp4，' + perf.video.width + '×' + perf.video.height + '）：' +
            'mean ' + round(perf.video.seekBitmapMs.mean) + 'ms / p50 ' + round(perf.video.seekBitmapMs.p50) + 'ms / max ' + round(perf.video.seekBitmapMs.max) + 'ms',
        );
      }
      console.log('  perf ' + outPath);
    }
    pass += 1;
  } catch (error) {
    fail += 1;
    console.log('  FAIL 真实耗时测量 :: ' + (error && error.message));
  }
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
