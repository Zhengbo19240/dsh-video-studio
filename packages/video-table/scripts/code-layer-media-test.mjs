/**
 * 代码图层的媒体契约测试（Node 没有 Worker / OffscreenCanvas / createImageBitmap）。
 *
 *   node scripts/code-layer-media-test.mjs
 *
 * 覆盖：
 *   - env 新字段：fps / duration / assets / media
 *   - 素材缺失时 media.has/video/image/size 返回 false/null 且不抛
 *   - 老卡片（只读 props）在没有 media 时行为不变
 *   - assets 清单结构
 *   - 时间对齐（给定 localT，媒体帧时间落在期望帧区间）
 *   - 位图通过 transfer list 送进 worker；上一帧不残留
 *   - 模块 media 声明（含 props 变化）
 *   - 注册表：按 localT 准备帧、媒体桥失败降级、无需求不碰桥
 *   - 两张示例卡（media-pip / media-fullscreen-kenburns）三种情况都不抛
 *
 * Worker / OffscreenCanvas / ImageBitmap / URL 的桩只存在本文件内。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { createCodeLayer } from '../src/client/code-layer.js';
import {
  assetKindOf,
  assetSummary,
  createCodeRegistry,
  mediaFrameTime,
} from '../src/client/code-registry.js';

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

class FakeRenderingContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.cleared = 0;
    this.drawImages = [];
    this.texts = [];
    this.alphaAtDraw = [];
    this.globalAlpha = 1;
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.font = '10px sans-serif';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
  }
  save() {}
  restore() {}
  setTransform() {}
  translate() {}
  rotate() {}
  clearRect() {
    this.cleared += 1;
  }
  fillRect() {}
  strokeRect() {}
  beginPath() {}
  closePath() {}
  rect() {}
  roundRect() {}
  clip() {}
  moveTo() {}
  lineTo() {}
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
  drawImage(source, x, y, w, h) {
    this.drawImages.push({ source: source, x: x, y: y, w: w, h: h });
    this.alphaAtDraw.push(this.globalAlpha);
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
    const url = 'blob:code-media-test-' + (urlSeq += 1);
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
      console: console,
      performance: { now: () => 123456789 },
      Blob: Blob,
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
    this.posts.push({ message: message, transfer: transfer || [] });
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

// -------------------------------------------------------------- 测试模块 ----

const MEDIA_PROBE_SOURCE = `
export function render(ctx2d, t, env) {
  self.__seen = {
    t: t,
    ctxT: env.t,
    fps: env.fps,
    duration: env.duration,
    assets: env.assets,
    hasMedia: !!env.media,
    width: env.width,
    height: env.height,
  };
  self.__has = env.media.has('a1');
  self.__time = env.media.time('a1');
  self.__kind = env.media.kind('a1');
  self.__size = env.media.size('a1');
  self.__video = env.media.video('a1');
  self.__image = env.media.image('a1');
  self.__noThrow = [
    env.media.has(null),
    env.media.has(undefined),
    env.media.has(123),
    env.media.has(Symbol('x')),
    env.media.video('missing'),
    env.media.image('missing'),
    env.media.size('missing'),
    env.media.time('missing'),
  ];
}
`;

const NEEDS_SOURCE = `
export function media(props) {
  return props && props.assetId ? [props.assetId] : [];
}
export function render(ctx2d, t, env) {
  self.__has = env.media.has('a1');
}
`;

const BAD_NEEDS_SOURCE = `
export function media() {
  throw new Error('bad declaration');
}
export function render(ctx2d, t) {
  self.__badNeedsRendered = (self.__badNeedsRendered || 0) + 1;
}
`;

const OLD_CARD_SOURCE = `
export function setup(props) {
  self.__oldSetup = (self.__oldSetup || 0) + 1;
}
export function render(ctx2d, t, env) {
  self.__oldRendered = (self.__oldRendered || 0) + 1;
  self.__oldT = t;
  self.__oldProps = env.props;
  self.__oldHasMedia = !!env.media;
  self.__oldMediaEmpty = env.media.has('anything');
  ctx2d.fillRect(0, 0, env.width, env.height);
}
`;

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
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeLayer(source, overrides = {}) {
  return createCodeLayer({
    layerId: 'media-test-layer',
    moduleSource: source,
    props: { assetId: 'a1' },
    width: 960,
    height: 540,
    assets: [
      { id: 'a1', kind: 'video', width: 1920, height: 1080, duration: 12 },
      { id: 'img1', kind: 'image', width: 800, height: 600, duration: null },
    ],
    fps: 30,
    duration: 4,
    ...overrides,
  });
}

function frameEntry(id, kind, bitmap, time, width, height) {
  return {
    id: id,
    kind: kind,
    bitmap: bitmap,
    width: width || 1920,
    height: height || 1080,
    time: time === undefined ? null : time,
  };
}

// ------------------------------------------------------------------ 用例 ----

console.log('code-layer media');

await checkAsync('env：width/height/props/fps/duration/assets/media 齐全', async () => {
  const layer = makeLayer(MEDIA_PROBE_SOURCE);
  await layer.ready();
  await layer.render(1, { media: [], assets: [{ id: 'a1', kind: 'video', width: 2, height: 2, duration: 3 }], fps: 24, duration: 5 });

  const worker = latestWorker();
  const seen = worker.sandbox.__seen;
  assert(seen.width === 960 && seen.height === 540, 'width/height 不对');
  assert(seen.fps === 24, 'env.fps 应为整帧带来的 24，实际 ' + seen.fps);
  assert(seen.duration === 5, 'env.duration 应为 5，实际 ' + seen.duration);
  assert(Array.isArray(seen.assets) && seen.assets[0].id === 'a1', 'env.assets 应是数组');
  assert(seen.hasMedia === true, 'env.media 必须存在');
  assert(seen.t === 1 && seen.ctxT === 1, 't / env.t 不一致');
  layer.dispose();
});

await checkAsync('素材缺失：has/video/image/size/time 返回 false/null 且不抛', async () => {
  const layer = makeLayer(MEDIA_PROBE_SOURCE);
  await layer.ready();
  await layer.render(0.5, { media: [] });

  const worker = latestWorker();
  assert(worker.sandbox.__has === false, 'has 应为 false');
  assert(worker.sandbox.__time === null, 'time 应为 null');
  assert(worker.sandbox.__kind === null, 'kind 应为 null');
  assert(worker.sandbox.__size === null, 'size 应为 null');
  assert(worker.sandbox.__video === null, 'video 应为 null');
  assert(worker.sandbox.__image === null, 'image 应为 null');
  const results = worker.sandbox.__noThrow;
  assert(results.every((v) => v === false || v === null), '对 null/number/Symbol id 的访问必须返回 false/null：' + JSON.stringify(results));
  layer.dispose();
});

await checkAsync('老卡片（只读 props）在没有 media 时行为不变', async () => {
  const layer = makeLayer(OLD_CARD_SOURCE, { props: { n: 1 } });
  await layer.ready();
  await layer.render(2.5);

  const worker = latestWorker();
  assert(worker.sandbox.__oldSetup === 1, 'setup 应执行一次');
  assert(worker.sandbox.__oldRendered === 1, 'render 应执行一次');
  assert(worker.sandbox.__oldT === 2.5, '老卡片仍应收到 t');
  assert(worker.sandbox.__oldProps.n === 1, '老卡片仍应收到 props');
  assert(worker.sandbox.__oldHasMedia === true, 'env.media 存在但应为空表');
  assert(worker.sandbox.__oldMediaEmpty === false, '老卡片查询媒体应为 false');
  const ctx = latestContext();
  assert(ctx.cleared === 1, '每帧应先清空画布');
  layer.dispose();
});

await checkAsync('assets 清单：init 传入的浅信息原样到达 env', async () => {
  const assets = [
    { id: 'a1', kind: 'video', width: 1920, height: 1080, duration: 12.5 },
    { id: 'img1', kind: 'image', width: 800, height: 600, duration: null },
  ];
  const layer = makeLayer(MEDIA_PROBE_SOURCE, { assets: assets });
  await layer.ready();
  await layer.render(0, { assets: assets });

  const seen = latestWorker().sandbox.__seen;
  assert(seen.assets.length === 2, 'assets 应有两项');
  assert(seen.assets[0].kind === 'video' && seen.assets[1].kind === 'image', 'kind 不对');
  assert(seen.assets[0].duration === 12.5, 'duration 不对');
  assert(seen.assets[1].width === 800 && seen.assets[1].height === 600, '图片尺寸不对');
  layer.dispose();
});

await checkAsync('时间对齐：给定 t，媒体帧时间落在期望帧区间', async () => {
  const layer = makeLayer(MEDIA_PROBE_SOURCE);
  await layer.ready();

  const t = 1.234;
  const bitmap = new FakeImageBitmap(1920, 1080, 'video');
  await layer.render(t, { media: [frameEntry('a1', 'video', bitmap, 1.2333)] });

  const worker = latestWorker();
  const time = worker.sandbox.__time;
  const fps = 30;
  // 帧号用 round 比对（1.2333*30 的浮点误差不该让 37 掉成 36）
  assert(Math.round(time * fps) === Math.round(t * fps), '媒体帧应落在 t 所在帧：time=' + time + ' t=' + t);
  assert(Math.abs(time - t) < 1 / fps, '帧时间偏差应小于一帧');
  assert(worker.sandbox.__size.width === 1920 && worker.sandbox.__size.height === 1080, 'size 应来自帧元信息');
  assert(worker.sandbox.__video === bitmap, 'video() 应返回这一帧的位图');
  layer.dispose();
});

await checkAsync('位图通过 transfer list 传给 worker', async () => {
  const layer = makeLayer(MEDIA_PROBE_SOURCE);
  await layer.ready();
  const bitmap = new FakeImageBitmap(640, 360, 'video');
  await layer.render(0.2, { media: [frameEntry('a1', 'video', bitmap, 0.2)] });

  const posts = latestWorker().posts;
  const last = posts[posts.length - 1];
  assert(last.message.type === 'render', '最后一条应是 render');
  assert(last.transfer.length === 1 && last.transfer[0] === bitmap, 'transfer list 应包含帧位图');
  layer.dispose();
});

await checkAsync('上一帧不会残留：新的空媒体清单立即生效', async () => {
  const layer = makeLayer(NEEDS_SOURCE);
  await layer.ready();
  const bitmap = new FakeImageBitmap(640, 360, 'video');
  await layer.render(0.3, { media: [frameEntry('a1', 'video', bitmap, 0.3)] });
  assert(latestWorker().sandbox.__has === true, '第一帧应能拿到媒体');
  await layer.render(0.4, { media: [] });
  assert(latestWorker().sandbox.__has === false, '第二帧没有媒体时不得残留');
  assert(bitmap.closed === true, '上一代位图应被释放');
  layer.dispose();
});

await checkAsync('kind 过滤：image 素材不会被 video() 返回', async () => {
  const layer = makeLayer(MEDIA_PROBE_SOURCE);
  await layer.ready();
  const bitmap = new FakeImageBitmap(800, 600, 'image');
  await layer.render(0, { media: [frameEntry('a1', 'image', bitmap, null, 800, 600)] });

  const worker = latestWorker();
  assert(worker.sandbox.__kind === 'image', 'kind 应为 image');
  assert(worker.sandbox.__video === null, 'image 不该出现在 video()');
  assert(worker.sandbox.__image === bitmap, 'image() 应返回位图');
  layer.dispose();
});

await checkAsync('media 声明：ready 后上报需求，props 更新后跟着变', async () => {
  const layer = makeLayer(NEEDS_SOURCE, { props: { assetId: 'a1' } });
  await layer.ready();
  assert(JSON.stringify(layer.mediaNeeds()) === JSON.stringify([{ id: 'a1' }]), '应声明 a1');

  await layer.update({ props: {} });
  assert(layer.mediaNeeds().length === 0, 'props 去掉 assetId 后需求应为空');
  layer.dispose();
});

await checkAsync('media 声明写坏：不阻断渲染，按空需求处理', async () => {
  const layer = makeLayer(BAD_NEEDS_SOURCE);
  await layer.ready();
  assert(layer.mediaNeeds().length === 0, '声明抛错时应降级为空');
  await layer.render(0);
  assert(latestWorker().sandbox.__badNeedsRendered === 1, 'render 仍应执行');
  layer.dispose();
});

await checkAsync('纯函数：assetKindOf / assetSummary / mediaFrameTime', async () => {
  assert(assetKindOf({ mime: 'video/mp4' }) === 'video', 'video/mp4 应为 video');
  assert(assetKindOf({ mime: 'image/png' }) === 'image', 'image/png 应为 image');
  assert(assetKindOf({ mime: 'audio/mpeg' }) === 'audio', 'audio/mpeg 应为 audio');
  assert(assetKindOf({ mime: 'application/octet-stream' }) === 'other', '未知 mime 应为 other');

  const summary = assetSummary([
    { id: 'v1', mime: 'video/mp4', probe: { width: 1920, height: 1080, duration: 9.5 } },
    { id: 'i1', mime: 'image/jpeg', probe: { width: 800, height: 600 } },
    { id: 'bad', mime: 'video/mp4', probe: { width: 0, height: -2, duration: 0 } },
    { id: null, mime: 'video/mp4' },
  ]);
  assert(summary.length === 3, '应跳过没有 id 的素材');
  assert(summary[0].width === 1920 && summary[0].duration === 9.5, '视频探针信息不对');
  assert(summary[1].width === 800 && summary[1].duration === null, '图片 duration 应为 null');
  assert(summary[2].width === null && summary[2].height === null, '非法尺寸应为 null');

  assert(mediaFrameTime(-3, 10) === 0, '负时间应夹到 0');
  assert(mediaFrameTime(4.2, 10) === 4.2, '范围内原样返回');
  assert(mediaFrameTime(99, 10) === 9.999, '越界应夹到 duration 之前');
  assert(mediaFrameTime(3, null) === 3, '时长未知时只保证非负');
  assert(mediaFrameTime('NaN', 10) === 0, '非数字应回落到 0');
});

// ------------------------------------------------------------ 注册表用例 ----

class FakeLayer {
  constructor(opts) {
    this.opts = opts;
    this.calls = [];
    this.disposed = false;
    this.needList = opts.mediaNeeds || [{ id: 'a1' }];
  }
  async ready() {
    return { mediaNeeds: this.needList };
  }
  mediaNeeds() {
    return this.needList;
  }
  async render(t, frame) {
    this.calls.push({ t: t, frame: frame });
  }
  canvas() {
    return null;
  }
  dispose() {
    this.disposed = true;
  }
}

function registryFixture(extra = {}) {
  const layers = [];
  const bridgeCalls = [];
  const needList = extra.needList === undefined ? [{ id: 'a1' }] : extra.needList;
  const registry = createCodeRegistry({
    projectId: 'proj-1',
    readLayerSource: async () => NEEDS_SOURCE,
    layerFactory: (opts) => {
      const layer = new FakeLayer(Object.assign({ mediaNeeds: needList }, opts));
      layers.push(layer);
      return layer;
    },
    context: () => ({
      assets: [
        { id: 'a1', mime: 'video/mp4', probe: { width: 1920, height: 1080, duration: 12 } },
      ],
      fps: 24,
    }),
    mediaBridge: {
      async frames(needs, byId, localT) {
        bridgeCalls.push({ needs: needs, byId: byId, localT: localT });
        return {
          frames: needs.map((need) => ({
            id: need.id,
            kind: 'video',
            bitmap: new FakeImageBitmap(1920, 1080, 'video'),
            width: 1920,
            height: 1080,
            time: mediaFrameTime(localT, 12),
          })),
        };
      },
    },
    ...extra,
  });
  return { registry, layers, bridgeCalls };
}

const CODE_CLIP = {
  id: 'clip-code-1',
  type: 'code',
  layerId: 'layer-1',
  codeHash: 'hash-1',
  start: 1,
  duration: 5,
  props: { assetId: 'a1' },
};

await checkAsync('注册表：媒体按片段局部时间准备，assets/fps/duration 一起注入', async () => {
  const { registry, layers, bridgeCalls } = registryFixture();
  await registry.renderAt([CODE_CLIP], 2.234);

  assert(bridgeCalls.length === 1, '媒体桥应被调用一次');
  assert(Math.abs(bridgeCalls[0].localT - 1.234) < 1e-9, '桥收到的应是 localT=1.234，实际 ' + bridgeCalls[0].localT);
  assert(bridgeCalls[0].needs.length === 1 && bridgeCalls[0].needs[0].id === 'a1', '需求 id 不对');

  const call = layers[0].calls[0];
  assert(Math.abs(call.t - 1.234) < 1e-9, 'render 收到的 t 应为 localT');
  assert(call.frame.media.length === 1, '应注入一帧媒体');
  assert(Math.abs(call.frame.media[0].time - 1.234) < 1e-9, '媒体帧时间应与 localT 对齐');
  assert(call.frame.fps === 24, 'fps 应来自工程上下文');
  assert(call.frame.duration === 5, 'duration 应来自片段');
  assert(call.frame.assets[0].kind === 'video', 'assets 清单应随帧注入');
  registry.dispose();
  assert(layers[0].disposed === true, 'dispose 应释放图层');
});

await checkAsync('注册表：媒体桥失败时降级为空媒体，渲染照常进行', async () => {
  const { registry, layers } = registryFixture({
    mediaBridge: {
      async frames() {
        throw new Error('decode blew up');
      },
    },
  });
  await registry.renderAt([CODE_CLIP], 2);
  const call = layers[0].calls[0];
  assert(call.frame.media.length === 0, '失败的帧应被丢弃');
  assert(Math.abs(call.t - 1) < 1e-9, 'render 仍应执行');
  registry.dispose();
});

await checkAsync('注册表：模块没有媒体声明时完全不碰媒体桥', async () => {
  const { registry, layers, bridgeCalls } = registryFixture({ needList: [] });
  await registry.renderAt([CODE_CLIP], 1.5);
  assert(bridgeCalls.length === 0, '没有需求时不应解码');
  assert(layers[0].calls[0].frame.media.length === 0, '媒体应为空');
  registry.dispose();
});

// ------------------------------------------------------------ 示例卡用例 ----

const motionRoot = path.join(os.homedir(), '.dsh', 'motion-lib');

function readCard(id) {
  const file = path.join(motionRoot, id, 'code.js');
  return fs.readFileSync(file, 'utf8');
}

const PIP_SOURCE = readCard('media-pip');
const KENBURNS_SOURCE = readCard('media-fullscreen-kenburns');

async function renderCard(source, t, options) {
  const opts = options || {};
  const layer = createCodeLayer({
    layerId: 'card',
    moduleSource: source,
    props: opts.props === undefined ? { assetId: 'a1' } : opts.props,
    width: 960,
    height: 540,
    fps: 30,
    duration: 6,
    assets: [{ id: 'a1', kind: 'video', width: 1920, height: 1080, duration: 12 }],
  });
  await layer.ready();
  await layer.render(t, { media: opts.media || [], duration: 6, fps: 30 });
  const ctx = latestContext();
  const snapshot = {
    drawImages: ctx.drawImages.slice(),
    texts: ctx.texts.slice(),
    alphaAtDraw: ctx.alphaAtDraw.slice(),
    needs: layer.mediaNeeds(),
  };
  layer.dispose();
  return snapshot;
}

function videoBitmap() {
  return new FakeImageBitmap(1920, 1080, 'video');
}

await checkAsync('media-pip：有媒体时画出右下角小窗并淡入', async () => {
  const bitmap = videoBitmap();
  const out = await renderCard(PIP_SOURCE, 0.25, {
    media: [frameEntry('a1', 'video', bitmap, 0.25)],
  });
  assert(out.needs.length === 1 && out.needs[0].id === 'a1', '卡片应声明 assetId');
  assert(out.drawImages.length === 1, '应画一次媒体');
  const draw = out.drawImages[0];
  assert(draw.source === bitmap, '画的应是这一帧位图');
  assert(draw.x > 480 && draw.y > 270, '小窗应位于右下角：' + JSON.stringify({ x: draw.x, y: draw.y }));
  assert(out.alphaAtDraw[0] > 0.45 && out.alphaAtDraw[0] < 0.55, 't=0.25 时淡入应约 0.5，实际 ' + out.alphaAtDraw[0]);
  assert(out.texts.length === 0, '有媒体时不该画占位文字');
});

await checkAsync('media-pip：无媒体时画占位且不抛', async () => {
  const out = await renderCard(PIP_SOURCE, 0.25, { media: [] });
  assert(out.drawImages.length === 0, '没有媒体时不应 drawImage');
  assert(out.texts.indexOf('媒体占位') >= 0, '应画「媒体占位」');
  assert(out.texts.some((t) => t.indexOf('未就绪') >= 0), '应说明原因');
});

await checkAsync('media-pip：props.assetId 缺失时不抛并说明', async () => {
  const out = await renderCard(PIP_SOURCE, 0, { props: {}, media: [] });
  assert(out.needs.length === 0, '没有 assetId 时不应声明需求');
  assert(out.texts.indexOf('媒体占位') >= 0, '仍应画占位');
  assert(out.texts.some((t) => t.indexOf('assetId') >= 0), '应指出 assetId 未设置');
});

await checkAsync('kenburns：有媒体时铺满并按 1.0→1.08 放大', async () => {
  const bitmap = videoBitmap();
  const start = await renderCard(KENBURNS_SOURCE, 0, { media: [frameEntry('a1', 'video', bitmap, 0)] });
  const end = await renderCard(KENBURNS_SOURCE, 6, { media: [frameEntry('a1', 'video', bitmap, 6)] });

  assert(start.drawImages.length === 1 && end.drawImages.length === 1, '两帧都应画媒体');
  const w0 = start.drawImages[0].w;
  const w1 = end.drawImages[0].w;
  assert(Math.abs(w0 - 960) < 1, 't=0 时应正好铺满宽度（zoom=1.0），实际 ' + w0);
  assert(Math.abs(start.drawImages[0].x) < 0.5, 'zoom=1.0 且比例相同则不该横向裁切，实际 x=' + start.drawImages[0].x);
  assert(Math.abs(w1 / w0 - 1.08) < 0.01, '结束时放大应约 1.08 倍，实际 ' + (w1 / w0));
  assert(end.drawImages[0].x < 0, '放大后 cover 会裁掉两侧，x 应为负');
});

await checkAsync('kenburns：无媒体 / props 缺失都画占位且不抛', async () => {
  const noMedia = await renderCard(KENBURNS_SOURCE, 2, { media: [] });
  assert(noMedia.drawImages.length === 0, '无媒体不应 drawImage');
  assert(noMedia.texts.indexOf('媒体占位') >= 0, '应画占位文字');

  const noProps = await renderCard(KENBURNS_SOURCE, 2, { props: {}, media: [] });
  assert(noProps.texts.some((t) => t.indexOf('assetId') >= 0), '应指出 assetId 未设置');
});

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exitCode = 1;
