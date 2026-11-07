/**
 * 导出帧率测试：工程帧率与导出帧率解耦。
 *
 *   node scripts/export-fps-test.mjs
 *
 * 覆盖：
 *  - 30fps 工程按 60fps 导出：帧数、每帧 t 的步长、重复帧像素一致（不黑帧）；
 *  - 24 / 25 / 30 / 50 / 60 各档的帧数与时长（容差 1 帧）；
 *  - 非法帧率（0 / -1 / 121）在开编码器之前拒绝；
 *  - 音频时长不随帧率变化，音画总时长偏差 < 1 帧；
 *  - exports[] 记录 fps 与 sourceFps（非法值不写记录）；
 *  - 编码器回退链：计划 H.264 但本机只有 HEVC → 用 HEVC 并给信息；全部不可用 → NO_ENCODER；
 *  - 返回值可无损 JSON 化。
 *
 * 桩只存在于本文件，不改动源码。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ExportError,
  MAX_EXPORT_FPS,
  exportTimeline,
  planExport,
  prepareAudio,
} from '../src/client/exporter.js';
import { chooseExportPlan, describePlan } from '../src/client/codec-caps.mjs';
import { ProjectStore } from '../src/store.mjs';

let pass = 0;
let fail = 0;

async function check(name, fn) {
  try {
    await fn();
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

function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) < eps;
}

// ------------------------------------------------------------------- 桩 ----

class FakeEncodedVideoChunk {
  constructor({ type, timestamp, duration, byteLength = 128 }) {
    this.type = type;
    this.timestamp = timestamp;
    this.duration = duration;
    this.byteLength = byteLength;
  }
  copyTo(dest) {
    const view = new Uint8Array(dest.buffer || dest, dest.byteOffset || 0, dest.byteLength || dest.length);
    for (let i = 0; i < view.length; i += 1) view[i] = (i * 31 + 7) & 0xff;
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
  static supported = new Set();
  static instances = [];
  // 模拟「把 framerate 当硬约束」的编码器：提示 > 该值就返回 unsupported。
  static rejectFramerateAbove = 0;

  static async isConfigSupported(config) {
    if (FakeVideoEncoder.rejectFramerateAbove && config.framerate > FakeVideoEncoder.rejectFramerateAbove) {
      return { supported: false, config };
    }
    return { supported: FakeVideoEncoder.supported.has(config.codec), config };
  }

  constructor({ output, error } = {}) {
    this.output = output;
    this.errorCallback = error;
    this.config = null;
    this.encodeCount = 0;
    this.closed = false;
    this.samples = [];
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
    this.samples.push({
      timestamp: frame.timestamp,
      duration: frame.duration,
      // 画布里写进去的「源帧编号」：60fps 输出相邻两帧应指向同一个 30fps 源帧
      pixel: frame.source ? frame.source.pixel : null,
      keyFrame: options.keyFrame === true,
    });
    const chunk = new FakeEncodedVideoChunk({
      type: options.keyFrame ? 'key' : 'delta',
      timestamp: frame.timestamp,
      duration: frame.duration,
    });
    const decoderConfig = {
      codec: this.config.codec,
      codedWidth: this.config.width,
      codedHeight: this.config.height,
    };
    if (this.config.codec.startsWith('hvc1') || this.config.codec.startsWith('hev1')) {
      decoderConfig.description = new Uint8Array([0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0x00, 0x00]).buffer;
    } else if (this.config.codec.startsWith('avc1')) {
      decoderConfig.description = new Uint8Array([
        0x01, 0x42, 0xc0, 0x1f, 0xff, 0xe0, 0x00, 0x0a, 0x67, 0x42, 0xc0, 0x1f,
      ]).buffer;
    }
    this.output(chunk, { decoderConfig });
  }

  flush() {
    return Promise.resolve();
  }

  close() {
    this.closed = true;
  }
}

/** prepareAudio 只用到 isConfigSupported；不会真的编码。 */
class FakeAudioEncoder {
  static async isConfigSupported(config) {
    return { supported: true, config };
  }
}

class FakeAudioData {}

class FakeCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.pixel = null;
  }
  getContext(type) {
    if (type !== '2d') return null;
    return { canvas: this };
  }
}

function installStubs(supported = ['avc1.42001f']) {
  FakeVideoEncoder.supported = new Set(supported);
  FakeVideoEncoder.instances = [];
  FakeVideoEncoder.rejectFramerateAbove = 0;
  globalThis.VideoEncoder = FakeVideoEncoder;
  globalThis.VideoFrame = FakeVideoFrame;
  globalThis.EncodedVideoChunk = FakeEncodedVideoChunk;
  globalThis.AudioEncoder = FakeAudioEncoder;
  globalThis.AudioData = FakeAudioData;
  globalThis.OffscreenCanvas = FakeCanvas;
}

function removeStubs() {
  delete globalThis.VideoEncoder;
  delete globalThis.VideoFrame;
  delete globalThis.EncodedVideoChunk;
  delete globalThis.AudioEncoder;
  delete globalThis.AudioData;
  delete globalThis.OffscreenCanvas;
}

function lastEncoder() {
  return FakeVideoEncoder.instances[FakeVideoEncoder.instances.length - 1];
}

function makeAudioBuffer({ sampleRate = 48000, duration = 2, numberOfChannels = 2 } = {}) {
  const length = Math.round(sampleRate * duration);
  const channels = [];
  for (let ch = 0; ch < numberOfChannels; ch += 1) {
    const data = new Float32Array(length);
    for (let i = 0; i < length; i += 1) data[i] = Math.sin((i * 2 * Math.PI * (220 + ch * 110)) / sampleRate) * 0.4;
    channels.push(data);
  }
  return {
    sampleRate,
    length,
    duration,
    numberOfChannels,
    getChannelData(ch) {
      return channels[ch];
    },
  };
}

/** 模拟「本机只有 HEVC + AAC」的能力表（用户那台机器的情形）。 */
function capsHevcOnly() {
  return {
    video: {
      h264: { supported: false, reason: '本机不支持 H.264 编码' },
      hevc: { supported: true, codec: 'hvc1.1.6.L93.B0' },
      vp9: { supported: false, reason: '测试里标成不支持' },
      av1: { supported: false, reason: '测试里标成不支持' },
    },
    audio: {
      aac: { supported: true, codec: 'mp4a.40.2' },
      opus: { supported: true, codec: 'opus' },
    },
  };
}

// ------------------------------------------------------------ 规划与采样 ----

console.log('导出帧率 · 规划');

await check('① 30fps 工程按 60fps 导出：帧数 = round(duration×60)，fps 与 sourceFps 分开', () => {
  const plan = planExport({ duration: 2.5, width: 1280, height: 720, fps: 60, projectFps: 30 });
  assert(plan.fps === 60, 'fps=' + plan.fps);
  assert(plan.sourceFps === 30, 'sourceFps=' + plan.sourceFps);
  assert(plan.projectFps === 30, 'projectFps=' + plan.projectFps);
  assert(plan.totalFrames === Math.round(2.5 * 60), 'frames=' + plan.totalFrames);
  assert(plan.totalFrames === 150, 'frames 应为 150，实际 ' + plan.totalFrames);
  assert(plan.sampleStep === 0.5, 'sampleStep=' + plan.sampleStep);
  assert(plan.muxer.frameRate === 60, 'muxer.frameRate=' + plan.muxer.frameRate);
});

await check('② 导出上限是 120fps：120 接受，121 / 0 / -1 拒绝且说明是中文', () => {
  const ok = planExport({ duration: 1, width: 64, height: 64, fps: MAX_EXPORT_FPS });
  assert(ok.fps === 120, 'fps=' + ok.fps);
  for (const bad of [121, 0, -1, 'abc']) {
    let err = null;
    try {
      planExport({ duration: 1, width: 64, height: 64, fps: bad });
    } catch (e) {
      err = e;
    }
    assert(err instanceof ExportError, 'fps=' + bad + ' 应当抛 ExportError');
    assert(err.code === 'INVALID_ARG', 'fps=' + bad + ' code=' + err.code);
    assert(/[\u4e00-\u9fa5]/.test(err.message), '错误信息不是中文：' + err.message);
  }
});

await check('③ 24 / 25 / 30 / 50 / 60 各档帧数与时长都在 1 帧误差内', () => {
  const duration = 1.6;
  for (const fps of [24, 25, 30, 50, 60]) {
    const plan = planExport({ duration, width: 640, height: 360, fps, projectFps: 30 });
    assert(plan.totalFrames === Math.round(duration * fps), fps + 'fps frames=' + plan.totalFrames);
    const encoded = plan.totalFrames / fps;
    assert(Math.abs(encoded - duration) <= 1 / fps + 1e-9, fps + 'fps 时长误差=' + (encoded - duration));
  }
});

await check('④ range 裁剪 + 60fps：从 range.start 起按 1/60 采样', () => {
  const plan = planExport({
    duration: 3,
    width: 640,
    height: 360,
    fps: 60,
    projectFps: 30,
    range: { start: 1, end: 2 },
  });
  assert(plan.totalFrames === 60, 'frames=' + plan.totalFrames);
  assert(plan.range.start === 1 && plan.range.end === 2, 'range=' + JSON.stringify(plan.range));
});

// --------------------------------------------------------------- 管线 ----

console.log('导出帧率 · 管线');

await check('⑤ 管线按 t = i/60 逐帧渲染：单调递增、步长 1/60、总帧数正确', async () => {
  installStubs(['avc1.42001f']);
  try {
    const times = [];
    const result = await exportTimeline({
      drawFrame(ctx, t) {
        times.push(t);
      },
      duration: 2,
      fps: 60,
      projectFps: 30,
      width: 64,
      height: 64,
    });
    assert(result.frames === 120, 'frames=' + result.frames);
    assert(times.length === 120, 'drawFrame 次数=' + times.length);
    assert(approx(times[0], 0), '首帧 t=' + times[0]);
    assert(approx(times[59], 59 / 60), '第 60 帧 t=' + times[59]);
    assert(approx(times[119], 119 / 60), '末帧 t=' + times[119]);
    for (let i = 1; i < times.length; i += 1) {
      assert(times[i] > times[i - 1], 't 不是单调递增 @' + i);
      assert(approx(times[i] - times[i - 1], 1 / 60), '步长 @' + i + '=' + (times[i] - times[i - 1]));
    }
    assert(result.fps === 60, 'result.fps=' + result.fps);
    assert(result.sourceFps === 30, 'result.sourceFps=' + result.sourceFps);
  } finally {
    removeStubs();
  }
});

await check('⑥ 30fps 源在 60fps 输出下是重复帧：同一 t 的两帧像素一致，且没有黑帧', async () => {
  installStubs(['avc1.42001f']);
  try {
    await exportTimeline({
      drawFrame(ctx, t) {
        // 30fps 源：每 1/30 秒一帧，画面内容只由源帧编号决定
        const sourceIndex = Math.min(29, Math.floor(t * 30 + 1e-9));
        ctx.canvas.pixel = sourceIndex + 1; // 0 表示黑帧，这里永远 >= 1
      },
      duration: 1,
      fps: 60,
      projectFps: 30,
      width: 64,
      height: 64,
    });
    const samples = lastEncoder().samples;
    assert(samples.length === 60, 'samples=' + samples.length);
    assert(samples.every((s) => Number.isFinite(s.pixel) && s.pixel > 0), '出现黑帧 / 空帧');
    for (let i = 0; i < samples.length; i += 2) {
      assert(samples[i].pixel === samples[i + 1].pixel, '第 ' + i + ' 对重复帧像素不一致：' + samples[i].pixel + ' vs ' + samples[i + 1].pixel);
    }
    assert(samples[0].pixel === 1 && samples[2].pixel === 2, '源帧编号不是按 30fps 前进');
    assert(Math.max(...samples.map((s) => s.pixel)) === 30, '源帧没有覆盖到最后一帧');
  } finally {
    removeStubs();
  }
});

await check('⑦ 60fps 输出的帧时间戳与 duration 正确（microsecond）', async () => {
  installStubs(['avc1.42001f']);
  try {
    await exportTimeline({
      drawFrame() {},
      duration: 1,
      fps: 60,
      projectFps: 30,
      width: 64,
      height: 64,
    });
    const samples = lastEncoder().samples;
    assert(samples[1].timestamp === Math.round(1e6 / 60), '第 2 帧 timestamp=' + samples[1].timestamp);
    assert(samples[59].timestamp === Math.round((59 * 1e6) / 60), '末帧 timestamp=' + samples[59].timestamp);
    assert(samples.every((s) => s.duration === Math.round(1e6 / 60)), 'duration 不一致');
    assert(samples[0].keyFrame === true, '首帧不是关键帧');
  } finally {
    removeStubs();
  }
});

await check('⑧ 非法帧率在开编码器之前拒绝（不写盘、不碰 VideoEncoder）', async () => {
  installStubs(['avc1.42001f']);
  try {
    for (const bad of [0, -1, 121]) {
      let err = null;
      try {
        await exportTimeline({
          drawFrame() {},
          duration: 1,
          fps: bad,
          width: 64,
          height: 64,
        });
      } catch (e) {
        err = e;
      }
      assert(err && err.code === 'INVALID_ARG', 'fps=' + bad + ' code=' + (err && err.code));
    }
    assert(FakeVideoEncoder.instances.length === 0, '非法帧率下仍创建了编码器');
  } finally {
    removeStubs();
  }
});

// --------------------------------------------------------------- 音频 ----

console.log('导出帧率 · 音频对齐');

await check('⑨ 音频时长不随导出帧率变化：24fps 与 60fps 的采样帧数完全相同', async () => {
  installStubs(['avc1.42001f']);
  try {
    const buffer = makeAudioBuffer({ duration: 2 });
    const at24 = await prepareAudio(buffer, 'aac', planExport({ duration: 2, width: 640, height: 360, fps: 24, projectFps: 30 }));
    const at60 = await prepareAudio(buffer, 'aac', planExport({ duration: 2, width: 640, height: 360, fps: 60, projectFps: 30 }));
    assert(at24.plan && at60.plan, '音频计划为空');
    assert(at24.plan.frames === at60.plan.frames, '24fps=' + at24.plan.frames + ' 60fps=' + at60.plan.frames);
    assert(at24.plan.frames === 2 * 48000, '音频帧数=' + at24.plan.frames);
  } finally {
    removeStubs();
  }
});

await check('⑩ 音画总时长偏差 < 1 帧（24 / 30 / 60fps 都成立）', async () => {
  installStubs(['avc1.42001f']);
  try {
    const duration = 2;
    const buffer = makeAudioBuffer({ duration });
    for (const fps of [24, 30, 60]) {
      const plan = planExport({ duration, width: 640, height: 360, fps, projectFps: 30 });
      const { plan: audioPlan } = await prepareAudio(buffer, 'aac', plan);
      const videoSeconds = plan.totalFrames / fps;
      const audioSeconds = audioPlan.frames / 48000;
      assert(Math.abs(videoSeconds - audioSeconds) < 1 / fps, fps + 'fps 音画偏差=' + Math.abs(videoSeconds - audioSeconds));
    }
  } finally {
    removeStubs();
  }
});

// ------------------------------------------------------------ exports[] ----

console.log('导出帧率 · exports[] 记账');

await check('⑪ exports[] 记录 fps 与 sourceFps（30fps 工程按 60fps 导出）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-export-fps-'));
  try {
    const store = new ProjectStore();
    const doc = await store.open(dir, 'session-export-fps');
    await store.recordExport(doc.projectId, {
      path: 'exports/r34-60fps.mp4',
      duration: 134.35,
      size: 12345,
      fps: 60,
      sourceFps: 30,
      source: 'workbench',
    });
    const list = store.exportList(store.get(doc.projectId).doc);
    assert(list.length === 1, 'exports 条数=' + list.length);
    assert(list[0].fps === 60, 'fps=' + list[0].fps);
    assert(list[0].sourceFps === 30, 'sourceFps=' + list[0].sourceFps);
    assert(list[0].duration === 134.35, 'duration=' + list[0].duration);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

await check('⑫ 非法 fps 拒绝写入 exports[]，且不改变已有记录', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-export-fps-bad-'));
  try {
    const store = new ProjectStore();
    const doc = await store.open(dir, 'session-export-fps-bad');
    await store.recordExport(doc.projectId, { path: 'exports/a.mp4', duration: 1, size: 1, fps: 30, sourceFps: 30 });
    for (const bad of [0, -1, 121]) {
      let err = null;
      try {
        await store.recordExport(doc.projectId, { path: 'exports/b.mp4', duration: 1, size: 1, fps: bad, sourceFps: 30 });
      } catch (e) {
        err = e;
      }
      assert(err && err.code === 'INVALID_ARG', 'fps=' + bad + ' code=' + (err && err.code));
    }
    const list = store.exportList(store.get(doc.projectId).doc);
    assert(list.length === 1, '非法 fps 仍写了记录：' + list.length);
    assert(list[0].path === 'exports/a.mp4', '已有记录被改：' + list[0].path);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------- 编码器 ----

console.log('导出帧率 · 编码器回退');

await check('⑬ 计划 H.264 但本机只有 HEVC → 自动改用 HEVC，并在结果里写清实际编码器', async () => {
  installStubs(['hvc1.1.6.L93.B0']);
  try {
    const plan = {
      container: 'mp4',
      videoCodec: 'h264',
      codec: 'avc1.42001f',
      audioCodec: 'aac',
      reason: '测试：计划首选 H.264',
    };
    const result = await exportTimeline({
      drawFrame() {},
      duration: 0.5,
      fps: 60,
      projectFps: 30,
      width: 64,
      height: 64,
      plan,
    });
    assert(result.container === 'mp4', 'container=' + result.container);
    assert(result.codec === 'hvc1.1.6.L93.B0', 'codec=' + result.codec);
    assert(result.videoCodec === 'hevc', 'videoCodec=' + result.videoCodec);
    assert(result.encoderFallback, '没有记录回退信息');
    assert(result.encoderFallback.from.codec === 'avc1.42001f', 'from=' + JSON.stringify(result.encoderFallback.from));
    assert(result.encoderFallback.to.codec === 'hvc1.1.6.L93.B0', 'to=' + JSON.stringify(result.encoderFallback.to));
    assert(/已改用/.test(result.encoderFallback.note), 'note=' + result.encoderFallback.note);
    assert(result.frames === 30, 'frames=' + result.frames);
    assert(result.fps === 60 && result.sourceFps === 30, 'fps/sourceFps=' + result.fps + '/' + result.sourceFps);
  } finally {
    removeStubs();
  }
});

await check('⑭ 全部编码器不可用才报 NO_ENCODER：中文、可读、画第一帧之前就失败', async () => {
  installStubs([]);
  try {
    let draws = 0;
    let err = null;
    try {
      await exportTimeline({
        drawFrame() {
          draws += 1;
        },
        duration: 1,
        fps: 60,
        projectFps: 30,
        width: 64,
        height: 64,
        plan: chooseExportPlan(capsHevcOnly()),
      });
    } catch (e) {
      err = e;
    }
    assert(err, '应当抛错');
    assert(err.code === 'NO_ENCODER', 'code=' + err.code);
    assert(/[\u4e00-\u9fa5]/.test(err.message), '错误信息不是中文：' + err.message);
    assert(err.message.includes('没有可用的视频编码器'), 'message=' + err.message);
    assert(draws === 0, '失败前已经画了 ' + draws + ' 帧');
    assert(FakeVideoEncoder.instances.length === 0, '不该创建编码器');
  } finally {
    removeStubs();
  }
});

await check('⑮ 本机只有 HEVC 时，表单计划本身给出的文案是「改用 HEVC」的信息，不是错误', () => {
  const plan = chooseExportPlan(capsHevcOnly());
  const text = describePlan(plan);
  assert(plan.videoCodec === 'hevc', 'videoCodec=' + plan.videoCodec);
  assert(/HEVC/.test(text), 'text=' + text);
  assert(/已自动改用 HEVC/.test(text), 'text=' + text);
});

// --------------------------------------------------------------- 返回值 ----

await check('⑯ 返回值可无损 JSON 化：fps / sourceFps / 回退信息都能原样读回', async () => {
  installStubs(['hvc1.1.6.L93.B0']);
  try {
    const result = await exportTimeline({
      drawFrame() {},
      duration: 0.2,
      fps: 60,
      projectFps: 30,
      width: 64,
      height: 64,
      plan: { container: 'mp4', videoCodec: 'h264', codec: 'avc1.42001f', audioCodec: 'aac', reason: '' },
    });
    const plain = { ...result };
    delete plain.blob;
    const round = JSON.parse(JSON.stringify(plain));
    assert(round.fps === 60, 'round.fps=' + round.fps);
    assert(round.sourceFps === 30, 'round.sourceFps=' + round.sourceFps);
    assert(round.duration === 0.2, 'round.duration=' + round.duration);
    assert(round.frames === 12, 'round.frames=' + round.frames);
    assert(round.encoderFallback && typeof round.encoderFallback.note === 'string', '回退信息不可 JSON 化');
    assert(Object.values(round).every((v) => v !== undefined), '返回值里有 undefined');
  } finally {
    removeStubs();
  }
});

await check('⑰ 编码器把 framerate 当硬约束（>30 全拒）时，去掉提示仍能按 60fps 导出', async () => {
  installStubs(['avc1.42001f']);
  FakeVideoEncoder.rejectFramerateAbove = 30;
  try {
    const result = await exportTimeline({
      drawFrame() {},
      duration: 1,
      fps: 60,
      projectFps: 30,
      width: 64,
      height: 64,
    });
    assert(result.frames === 60, 'frames=' + result.frames);
    assert(result.fps === 60, 'fps=' + result.fps);
    const encoder = lastEncoder();
    assert(encoder && encoder.config.codec === 'avc1.42001f', '没有回退到无 framerate 提示的配置');
    assert(encoder.config.framerate === undefined, '重试时不应再带 framerate：' + encoder.config.framerate);
    assert(encoder.encodeCount === 60, 'encode=' + encoder.encodeCount);
  } finally {
    removeStubs();
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
