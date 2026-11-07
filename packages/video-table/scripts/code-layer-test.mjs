/**
 * 代码图层的结构性测试（Node 没有 Worker / OffscreenCanvas）。
 *
 *   node scripts/code-layer-test.mjs
 *
 * 覆盖：创建与 ready、render 回传 ImageBitmap、props 重新 setup、
 * moduleSource 整层重建、dispose、worker 报错带 code、render/setup 超时、
 * 虚拟时钟、transferFromImageBitmap 路径。
 *
 * Worker / OffscreenCanvas / ImageBitmap / HTMLCanvasElement / URL 的桩都只存在本文件内。
 */

import vm from 'node:vm';
import { createCodeLayer, CodeLayerError } from '../src/client/code-layer.js';

// ------------------------------------------------------------------ 桩 ----

class FakeImageBitmap {
  constructor(width, height) {
    this.width = width;
    this.height = height;
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
  }
  save() {}
  restore() {}
  setTransform() {}
  clearRect() {
    this.cleared += 1;
  }
  fillRect() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  arc() {}
  fill() {}
  stroke() {}
  fillText() {}
  drawImage() {}
}

class FakeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.ctx = new FakeRenderingContext2D(this);
  }
  getContext(kind) {
    return kind === '2d' ? this.ctx : null;
  }
  transferToImageBitmap() {
    return new FakeImageBitmap(this.width, this.height);
  }
}

class FakeMainContext {
  constructor(canvas, useTransfer) {
    this.canvas = canvas;
    this.frames = [];
    this.transfers = [];
    if (useTransfer) {
      this.transferFromImageBitmap = (bitmap) => {
        this.transfers.push(bitmap);
      };
    }
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
    this.ctx = new FakeMainContext(this, Boolean(globalThis.__useTransferFromBitmap));
  }
  getContext(kind) {
    return kind === '2d' ? this.ctx : null;
  }
}

const blobUrls = new Map();
const revokedUrls = [];
let urlSeq = 0;

class URLStub {
  static createObjectURL(blob) {
    const url = 'blob:code-layer-test-' + (urlSeq += 1);
    blobUrls.set(url, blob);
    return url;
  }
  static revokeObjectURL(url) {
    revokedUrls.push(url);
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

  postMessage(message) {
    if (this.terminated) return;
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

// -------------------------------------------------------------- 测试模块 ----

const GOOD_SOURCE = `
export function setup(props, ctx) {
  self.__setupCount = (self.__setupCount || 0) + 1;
  self.__lastProps = props;
  self.__ctxSize = [ctx.width, ctx.height];
}

export function render(ctx2d, t, ctx) {
  self.__renderCount = (self.__renderCount || 0) + 1;
  self.__lastT = t;
  self.__ctxT = ctx.t;
  self.__clockNow = Date.now();
  self.__perfNow = performance.now();
  ctx2d.fillRect(0, 0, ctx.width, ctx.height);
}
`;

const SECOND_SOURCE = `
export function setup(props) {
  self.__secondSetup = (self.__secondSetup || 0) + 1;
}

export function render(ctx2d, t) {
  self.__secondT = t;
}
`;

const THROW_SOURCE = `
export function render() {
  throw new Error('boom');
}
`;

const HANG_SOURCE = `
export function render() {
  return new Promise(function () {});
}
`;

const HANG_SETUP_SOURCE = `
export function setup() {
  return new Promise(function () {});
}
export function render() {}
`;

const IMPURE_SOURCE = `
export function render() {
  setTimeout(function () {}, 0);
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

async function expectReject(promise, code, label) {
  try {
    await promise;
  } catch (error) {
    assert(error && typeof error === 'object', label + ' 应抛出结构化错误');
    assert(error.code === code, label + ' 的 code=' + error.code + '，期望 ' + code);
    return error;
  }
  throw new Error(label + ' 应该 reject，但成功返回了');
}

function makeLayer(overrides = {}) {
  return createCodeLayer({
    layerId: 'test-layer',
    moduleSource: GOOD_SOURCE,
    props: { n: 1 },
    width: 64,
    height: 36,
    ...overrides,
  });
}

// ------------------------------------------------------------------ 用例 ----

console.log('code-layer');

await checkAsync('创建：ready 后拿到 HTMLCanvasElement 且尺寸正确', async () => {
  const layer = makeLayer();
  await layer.ready();

  const canvas = layer.canvas();
  assert(canvas instanceof FakeCanvasElement, 'canvas() 应返回 HTMLCanvasElement 桩');
  assert(canvas.width === 64 && canvas.height === 36, 'canvas 尺寸不对');

  const worker = latestWorker();
  assert(worker.sandbox.__setupCount === 1, 'setup 应执行一次');
  assert(Array.isArray(worker.sandbox.__ctxSize), 'setup 应收到 ctx');
  assert(worker.sandbox.__ctxSize[0] === 64, 'ctx.width 不对');
  assert(typeof worker.sandbox.__layer.render === 'function', '渲染函数应注册到 self.__layer');
  assert(layer.props().n === 1, 'props() 应返回当前 props');

  layer.dispose();
});

await checkAsync('render：回传一张 ImageBitmap，时间来自 t', async () => {
  const layer = makeLayer();
  await layer.ready();
  const worker = latestWorker();

  await layer.render(1.5);

  const ctx = layer.canvas().ctx;
  assert(ctx.frames.length === 1, '应回传一张 bitmap');
  assert(ctx.frames[0] instanceof FakeImageBitmap, '回传的应是 ImageBitmap 桩');
  assert(ctx.frames[0].closed === true, 'drawImage 后应关闭 bitmap');

  assert(worker.sandbox.__lastT === 1.5, 'render 应收到 t');
  assert(worker.sandbox.__ctxT === 1.5, 'ctx.t 应与渲染时间一致');
  assert(worker.sandbox.__clockNow === 1500, 'Date.now() 应等于 t*1000');
  assert(worker.sandbox.__perfNow === 1500, 'performance.now() 应等于 t*1000');
  assert(worker.sandbox.__renderCount === 1, 'render 应执行一次');

  layer.dispose();
});

await checkAsync('props 更新：worker 不重建，只重新 setup', async () => {
  const layer = makeLayer();
  await layer.ready();
  const worker = latestWorker();

  await layer.update({ props: { n: 2 } });

  assert(latestWorker() === worker, 'props 更新不应重建 worker');
  assert(worker.sandbox.__setupCount === 2, 'props 更新应重新执行 setup');
  assert(worker.sandbox.__lastProps.n === 2, 'setup 应收到新 props');
  assert(layer.props().n === 2, 'props() 应更新');

  layer.dispose();
});

await checkAsync('moduleSource 更新：整层重建', async () => {
  const layer = makeLayer();
  await layer.ready();
  const first = latestWorker();
  const firstUrl = first.url;

  await layer.update({ moduleSource: SECOND_SOURCE });

  const second = latestWorker();
  assert(second !== first, '应创建新的 worker');
  assert(first.terminated === true, '旧 worker 应被终止');
  assert(revokedUrls.includes(firstUrl), '旧 bootstrap blob URL 应被 revoke');
  assert(second.sandbox.__secondSetup === 1, '新模块的 setup 应执行');

  await layer.render(0.25);
  assert(second.sandbox.__secondT === 0.25, '新 render 应生效');

  layer.dispose();
});

await checkAsync('dispose：终止 worker、释放 canvas、后续调用拒绝', async () => {
  const layer = makeLayer();
  await layer.ready();
  const worker = latestWorker();
  const url = worker.url;

  layer.dispose();

  assert(worker.terminated === true, 'worker 应被终止');
  assert(layer.canvas() === null, 'dispose 后 canvas() 应为 null');
  assert(revokedUrls.includes(url), 'bootstrap blob URL 应被 revoke');

  await expectReject(layer.render(0), 'DISPOSED', 'dispose 后 render');
  await expectReject(layer.update({ props: { n: 3 } }), 'DISPOSED', 'dispose 后 update');
});

await checkAsync('worker 抛错：render 拒绝并带 code', async () => {
  const layer = makeLayer({ moduleSource: THROW_SOURCE });
  await layer.ready();

  const error = await expectReject(layer.render(0), 'RENDER_FAILED', '模块抛错');
  assert(/boom/.test(error.message), '错误信息应包含原始错误');

  layer.dispose();
});

await checkAsync('render 超时：拒绝 RENDER_TIMEOUT 并 dispose', async () => {
  const layer = makeLayer({ moduleSource: HANG_SOURCE, renderTimeoutMs: 80 });
  await layer.ready();
  const worker = latestWorker();

  await expectReject(layer.render(0), 'RENDER_TIMEOUT', 'render 超时');

  assert(worker.terminated === true, '超时后应终止 worker');
  assert(layer.canvas() === null, '超时后应 dispose');
});

await checkAsync('setup 超时：拒绝 SETUP_TIMEOUT 并 dispose', async () => {
  const layer = makeLayer({ moduleSource: HANG_SETUP_SOURCE, setupTimeoutMs: 80 });
  const worker = latestWorker();

  await expectReject(layer.ready(), 'SETUP_TIMEOUT', 'setup 超时');

  assert(worker.terminated === true, 'setup 超时后应终止 worker');
});

await checkAsync('虚拟时钟：使用 setTimeout 报 IMPURE_CLOCK', async () => {
  const layer = makeLayer({ moduleSource: IMPURE_SOURCE });
  await layer.ready();

  const error = await expectReject(layer.render(0.5), 'IMPURE_CLOCK', '定时器污染');
  assert(/setTimeout/.test(error.message), '错误信息应指出 setTimeout');

  layer.dispose();
});

await checkAsync('transferFromImageBitmap 路径：直接转移位图', async () => {
  globalThis.__useTransferFromBitmap = true;
  const layer = makeLayer();

  try {
    await layer.ready();
    await layer.render(0);

    const ctx = layer.canvas().ctx;
    assert(ctx.transfers.length === 1, '应通过 transferFromImageBitmap 接收一帧');
    assert(ctx.transfers[0] instanceof FakeImageBitmap, '转移的应是 ImageBitmap 桩');
  } finally {
    globalThis.__useTransferFromBitmap = false;
    layer.dispose();
  }
});

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exitCode = 1;
