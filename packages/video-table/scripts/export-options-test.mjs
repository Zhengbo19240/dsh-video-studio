/**
 * 导出参数测试：分辨率换算 / fps 抽帧比例 / range 裁剪 / 码率 / 非法参数。
 *
 *   node scripts/export-options-test.mjs
 *
 * 前半段只测纯函数 planExport（不碰编码器），后半段用假编码器跑一遍管线，
 * 确认计划真的落到了 encoder 配置和每帧的 t 上。桩只存在于本文件。
 */

import { ExportError, MAX_BITRATE_KBPS, MIN_BITRATE_KBPS, exportTimeline, planExport } from '../src/client/exporter.js';

let pass = 0;
let fail = 0;

async function check(name, fn) {
  try {
    await Promise.resolve().then(fn);
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + (e && e.message));
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function expectError(fn, label) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert(err, (label || '') + ' 应当抛错');
  assert(err instanceof ExportError, (label || '') + ' 不是 ExportError：' + (err && err.name));
  assert(err.code === 'INVALID_ARG', (label || '') + ' code=' + err.code);
  assert(/[\u4e00-\u9fa5]/.test(err.message), '错误信息不是中文：' + err.message);
  return err;
}

// ------------------------------------------------------------------- 桩 ----

class FakeChunk {
  constructor({ type, timestamp, duration, byteLength = 128 }) {
    this.type = type;
    this.timestamp = timestamp;
    this.duration = duration;
    this.byteLength = byteLength;
  }
  copyTo(dest) {
    const view = new Uint8Array(dest.buffer || dest, dest.byteOffset || 0, dest.byteLength || dest.length);
    for (let i = 0; i < view.length; i += 1) view[i] = (i * 31 + 5) & 0xff;
  }
}

class FakeVideoFrame {
  constructor(source, init = {}) {
    this.source = source;
    this.timestamp = init.timestamp;
    this.duration = init.duration;
    this.closed = false;
  }
  close() {
    this.closed = true;
  }
}

class FakeVideoEncoder {
  static supported = new Set(['avc1.42001f']);
  static instances = [];
  static async isConfigSupported(config) {
    return { supported: FakeVideoEncoder.supported.has(config.codec), config };
  }
  constructor({ output, error } = {}) {
    this.output = output;
    this.errorCallback = error;
    this.config = null;
    this.encodeCount = 0;
    this.closed = false;
    FakeVideoEncoder.instances.push(this);
  }
  get encodeQueueSize() {
    return 0;
  }
  configure(config) {
    this.config = { ...config };
  }
  encode(frame, options = {}) {
    this.encodeCount += 1;
    const type = options.keyFrame ? 'key' : 'delta';
    this.output(new FakeChunk({ type, timestamp: frame.timestamp, duration: frame.duration }), {
      decoderConfig: {
        codec: this.config.codec,
        codedWidth: this.config.width,
        codedHeight: this.config.height,
      },
    });
  }
  flush() {
    return Promise.resolve();
  }
  close() {
    this.closed = true;
  }
}

class FakeCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return { canvas: this };
  }
}

function installStubs() {
  FakeVideoEncoder.instances = [];
  globalThis.VideoEncoder = FakeVideoEncoder;
  globalThis.VideoFrame = FakeVideoFrame;
  globalThis.EncodedVideoChunk = FakeChunk;
  globalThis.OffscreenCanvas = FakeCanvas;
}
function removeStubs() {
  delete globalThis.VideoEncoder;
  delete globalThis.VideoFrame;
  delete globalThis.EncodedVideoChunk;
  delete globalThis.OffscreenCanvas;
}
function lastEncoder() {
  return FakeVideoEncoder.instances[FakeVideoEncoder.instances.length - 1];
}
function approx(a, b) {
  return Math.abs(a - b) < 1e-6;
}

// --------------------------------------------------------------- 纯函数 ----

console.log('导出参数 · 规划');

await check('① 默认值：跟随工程 1080p/30fps，整片，自动码率', () => {
  const plan = planExport({ duration: 3, width: 1920, height: 1080, fps: 30 });
  assert(plan.width === 1920 && plan.height === 1080, plan.width + 'x' + plan.height);
  assert(plan.fps === 30, 'fps=' + plan.fps);
  assert(plan.totalFrames === 90, 'frames=' + plan.totalFrames);
  assert(plan.range.start === 0 && plan.range.end === 3, 'range=' + JSON.stringify(plan.range));
  assert(plan.duration === 3, 'duration=' + plan.duration);
  assert(plan.sampleStep === 1, 'sampleStep=' + plan.sampleStep);
  assert(plan.bitrateKbps === null, 'bitrateKbps=' + plan.bitrateKbps);
  assert(plan.bitrate > 0, 'bitrate=' + plan.bitrate);
  assert(plan.muxer.frameRate === 30, 'muxer.frameRate=' + plan.muxer.frameRate);
});

await check('② 分辨率换算：奇数向上取偶，1080p/720p 原样', () => {
  const odd = planExport({ duration: 1, width: 101, height: 99, fps: 30 });
  assert(odd.width === 102 && odd.height === 100, odd.width + 'x' + odd.height);
  const p1080 = planExport({ duration: 1, width: 1920, height: 1080, fps: 30 });
  assert(p1080.width === 1920 && p1080.height === 1080, '1080p 被改了');
  const p720 = planExport({ duration: 1, width: 1280, height: 720, fps: 30 });
  assert(p720.width === 1280 && p720.height === 720, '720p 被改了');
});

await check('③ fps 抽帧：工程 30 → 导出 15，比例 2，帧数减半', () => {
  const plan = planExport({ duration: 3, width: 1280, height: 720, fps: 15, projectFps: 30 });
  assert(plan.sampleStep === 2, 'sampleStep=' + plan.sampleStep);
  assert(plan.totalFrames === 45, 'frames=' + plan.totalFrames);
});

await check('④ fps 补帧：工程 25 → 导出 50，比例 0.5，帧数翻倍', () => {
  const plan = planExport({ duration: 3, width: 1280, height: 720, fps: 50, projectFps: 25 });
  assert(plan.sampleStep === 0.5, 'sampleStep=' + plan.sampleStep);
  assert(plan.totalFrames === 150, 'frames=' + plan.totalFrames);
});

await check('⑤ range 裁剪：只算区间内的帧数', () => {
  const plan = planExport({ duration: 10, width: 1280, height: 720, fps: 10, range: { start: 1.5, end: 3.5 } });
  assert(plan.duration === 2, 'duration=' + plan.duration);
  assert(plan.totalFrames === 20, 'frames=' + plan.totalFrames);
  assert(plan.range.start === 1.5 && plan.range.end === 3.5, 'range=' + JSON.stringify(plan.range));
});

await check('⑥ range 的 end 超过片长时截到片长', () => {
  const plan = planExport({ duration: 4, width: 1280, height: 720, fps: 5, range: { start: 1, end: 99 } });
  assert(plan.range.end === 4, 'end=' + plan.range.end);
  assert(plan.totalFrames === 15, 'frames=' + plan.totalFrames);
});

await check('⑦ 非法 range：反向 / 负起点 / 起点越界都报中文 INVALID_ARG', () => {
  const reversed = expectError(
    () => planExport({ duration: 5, width: 1280, height: 720, fps: 30, range: { start: 3, end: 2 } }),
    '反向 range',
  );
  assert(reversed.message.includes('结束时间必须大于开始时间'), 'message=' + reversed.message);
  expectError(() => planExport({ duration: 5, width: 1280, height: 720, fps: 30, range: { start: -1, end: 2 } }), '负起点');
  expectError(() => planExport({ duration: 5, width: 1280, height: 720, fps: 30, range: { start: 5, end: 6 } }), '起点越界');
  expectError(() => planExport({ duration: 5, width: 1280, height: 720, fps: 30, range: { start: 0, end: 0 } }), '零长度');
});

await check('⑧ 码率越界（上下界）报 INVALID_ARG，合法值原样进计划', () => {
  expectError(() => planExport({ duration: 1, width: 640, height: 360, fps: 30, bitrateKbps: MIN_BITRATE_KBPS - 1 }), '过低');
  expectError(() => planExport({ duration: 1, width: 640, height: 360, fps: 30, bitrateKbps: MAX_BITRATE_KBPS + 1 }), '过高');
  expectError(() => planExport({ duration: 1, width: 640, height: 360, fps: 30, bitrateKbps: 'abc' }), '非数字');
  const plan = planExport({ duration: 1, width: 640, height: 360, fps: 30, bitrateKbps: 8000 });
  assert(plan.bitrateKbps === 8000, 'bitrateKbps=' + plan.bitrateKbps);
  assert(plan.bitrate === 8_000_000, 'bitrate=' + plan.bitrate);
  assert(plan.muxer.bitrate === 8_000_000, 'muxer.bitrate=' + plan.muxer.bitrate);
});

await check('⑨ 基础参数非法（duration / fps / 尺寸）仍是 INVALID_ARG', () => {
  expectError(() => planExport({ duration: 0, width: 640, height: 360 }), 'duration=0');
  expectError(() => planExport({ duration: 1, width: 640, height: 360, fps: 0 }), 'fps=0');
  expectError(() => planExport({ duration: 1, width: 0, height: 360 }), 'width=0');
  expectError(() => planExport({ duration: 1, width: 640, height: 360, fps: 300 }), 'fps 过大');
});

// --------------------------------------------------------------- 管线 ----

console.log('导出参数 · 管线');

await check('⑩ 码率落到编码器配置（VideoEncoder.configure.bitrate）', async () => {
  installStubs();
  try {
    const result = await exportTimeline({
      drawFrame() {},
      duration: 1,
      fps: 10,
      width: 64,
      height: 64,
      bitrateKbps: 4000,
    });
    const cfg = lastEncoder().config;
    assert(cfg.bitrate === 4_000_000, 'encoder.bitrate=' + cfg.bitrate);
    assert(cfg.framerate === 10, 'encoder.framerate=' + cfg.framerate);
    assert(cfg.width === 64 && cfg.height === 64, '尺寸=' + cfg.width + 'x' + cfg.height);
    assert(result.frames === 10, 'frames=' + result.frames);
    const keys = Object.keys(result).sort().join(',');
    assert(
      keys === 'blob,codec,container,duration,fileName,fps,frames,ms,sourceFps,videoCodec',
      '返回字段被改了：' + keys,
    );
  } finally {
    removeStubs();
  }
});

await check('⑪ range 落到每帧的 t：首帧从 range.start 起，帧数按区间算', async () => {
  installStubs();
  try {
    const times = [];
    const result = await exportTimeline({
      drawFrame(ctx, t) {
        times.push(t);
      },
      duration: 10,
      fps: 10,
      width: 64,
      height: 64,
      range: { start: 2, end: 3 },
    });
    assert(result.frames === 10, 'frames=' + result.frames);
    assert(times.length === 10, 'drawFrame 次数=' + times.length);
    assert(approx(times[0], 2), '首帧 t=' + times[0]);
    assert(approx(times[9], 2.9), '末帧 t=' + times[9]);
    assert(lastEncoder().encodeCount === 10, 'encode=' + lastEncoder().encodeCount);
  } finally {
    removeStubs();
  }
});

await check('⑫ fps 抽帧比例落到每帧 t：30fps 工程导 15fps，t 步长 1/15', async () => {
  installStubs();
  try {
    const times = [];
    const result = await exportTimeline({
      drawFrame(ctx, t) {
        times.push(t);
      },
      duration: 3,
      fps: 15,
      projectFps: 30,
      width: 64,
      height: 64,
    });
    assert(result.frames === 45, 'frames=' + result.frames);
    assert(approx(times[1] - times[0], 1 / 15), '步长=' + (times[1] - times[0]));
    assert(approx(times[44], 44 / 15), '末帧 t=' + times[44]);
  } finally {
    removeStubs();
  }
});

await check('⑬ 非法参数在开编码器之前就被拦下（不会碰 VideoEncoder）', async () => {
  installStubs();
  try {
    let err = null;
    try {
      await exportTimeline({
        drawFrame() {},
        duration: 5,
        fps: 30,
        width: 64,
        height: 64,
        range: { start: 4, end: 1 },
      });
    } catch (e) {
      err = e;
    }
    assert(err && err.code === 'INVALID_ARG', 'code=' + (err && err.code));
    assert(FakeVideoEncoder.instances.length === 0, '非法参数前就建了编码器');
  } finally {
    removeStubs();
  }
});

// ---- 导出表单：那一行「将导出」必须带分辨率/帧率，且探测有超时降级 ----
// 表单逻辑在 client.js 里（React 组件内），这里对*构建产物*做结构性断言：
// 符号在、顺序对，就说明用户打开表单看到的是这份逻辑，而不是旧结论。
const bundle = (await import('node:fs')).readFileSync(new URL('../client.js', import.meta.url), 'utf8');

await check('⑭ 表单那一行拼了分辨率与帧率（formatPlanLine ← formPixels/formFps）', async () => {
  assert(bundle.includes('formatPlanLine'), 'bundle 里没有 formatPlanLine');
  assert(bundle.includes('formPixels'), 'bundle 里没有 formPixels');
  assert(bundle.includes('formFps'), 'bundle 里没有 formFps');
  const iLine = bundle.indexOf('function formatPlanLine');
  assert(iLine > 0, '没有 formatPlanLine 定义');
  // esbuild 会把 × / · 转成 \xD7 / \xB7（ASCII 转义），所以断言要按转义后的形态找。
  const window = bundle.slice(iLine, iLine + 600);
  assert(window.includes('${size.width}\\xD7${size.height}'), '没有拼「宽×高」');
  assert(window.includes('${formFps()}fps'), '没有拼帧率');
  assert(window.includes('describePlan(plan)'), '没有拼编码组合（describePlan）');
});

await check('⑮ 探测超时是独立的降级态（不是失败、不阻塞导出）', async () => {
  assert(bundle.includes('CAPS_TIMEOUT_MS'), 'bundle 里没有 CAPS_TIMEOUT_MS');
  assert(bundle.includes('capsTimedOut'), 'bundle 里没有 capsTimedOut 状态');
  const iTimeout = bundle.indexOf('capsTimedOut');
  assert(iTimeout > 0 && bundle.indexOf('setCapsTimedOut(true)', iTimeout) > iTimeout, '超时分支没有落到 setCapsTimedOut');
});

await check('⑯ 导出前先过字体闸门，再调 exportTimeline', async () => {
  const iFonts = bundle.indexOf('await prepareFonts(');
  // 样片导出（style-preview）也调 exportTimeline，所以取**最后一次**才是主导出入口。
  const iExport = bundle.lastIndexOf('mod.exportTimeline(');
  assert(iFonts > 0, 'bundle 里没有 await prepareFonts(');
  assert(iExport > iFonts, '字体闸门不在主导出 exportTimeline 之前');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
