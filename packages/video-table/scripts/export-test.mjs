/**
 * 导出管线的结构性测试（Node 里没有 WebCodecs / canvas）。
 *
 *   node scripts/export-test.mjs
 *
 * 覆盖：
 *  - 模块可 import、导出 exportTimeline；
 *  - 无 VideoEncoder 时抛 NO_ENCODER，而不是崩栈；
 *  - 用假的 VideoEncoder / VideoFrame / EncodedVideoChunk / OffscreenCanvas
 *    跑完整流程：帧数、每帧 drawFrame、关键帧、进度、文件名、返回值；
 *  - abort 中止（关闭编码器并抛 ABORTED）；
 *  - 背压（encodeQueueSize 超阈值时等待）；WebM 兜底路径；
 *  - 音轨：AudioEncoder 配置、切块数、flush 时序、无 audioBuffer 不碰音频、
 *    不支持时静默降级。
 *
 * 所有桩只存在于本文件，不改动源码。
 */

import { ExportError, exportTimeline } from '../src/client/exporter.js';
import { Muxer as Mp4Muxer } from 'mp4-muxer';
import { Muxer as WebmMuxer } from 'webm-muxer';

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + (e && e.message));
  }
}

async function checkAsync(name, fn) {
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

/** 跨桩记录调用顺序，用于断言 flush 早于 finalize。 */
const callOrder = [];
/** muxer 侧收到的块数（通过原型打点）。 */
const muxSpy = { audioChunks: 0, videoChunks: 0, finalize: false };

// ------------------------------------------------------------------- 桩 ----

/** 假的编码块：muxer 会 instanceof 检查，并调用 copyTo。 */
class FakeEncodedVideoChunk {
  constructor({ type, timestamp, duration, byteLength = 256 }) {
    this.type = type;
    this.timestamp = timestamp;
    this.duration = duration;
    this.byteLength = byteLength;
  }
  copyTo(dest) {
    const view = new Uint8Array(dest.buffer || dest, dest.byteOffset || 0, dest.byteLength || dest.length);
    for (let i = 0; i < view.length; i += 1) view[i] = (i * 37 + 11) & 0xff;
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
  static pendingDrain = 0;

  static async isConfigSupported(config) {
    return { supported: FakeVideoEncoder.supported.has(config.codec), config };
  }

  constructor({ output, error } = {}) {
    this.output = output;
    this.errorCallback = error;
    this.state = 'unconfigured';
    this.config = null;
    this.encodeCount = 0;
    this.keyCount = 0;
    this.flushCount = 0;
    this.frames = [];
    this.chunks = [];
    this.queueReads = 0;
    this.closed = false;
    FakeVideoEncoder.instances.push(this);
  }

  get encodeQueueSize() {
    this.queueReads += 1;
    if (FakeVideoEncoder.pendingDrain > 0) {
      FakeVideoEncoder.pendingDrain -= 1;
      return 9; // 模拟积压
    }
    return 0;
  }

  configure(config) {
    this.config = { ...config };
    this.state = 'configured';
  }

  encode(frame, options = {}) {
    if (this.state !== 'configured') throw new Error('encoder 未 configure');
    this.encodeCount += 1;
    this.frames.push(frame);
    const keyFrame = options.keyFrame === true;
    if (keyFrame) this.keyCount += 1;

    const type = keyFrame ? 'key' : 'delta';
    const chunk = new FakeEncodedVideoChunk({
      type,
      timestamp: frame.timestamp,
      duration: frame.duration,
    });
    this.chunks.push(chunk);

    const decoderConfig = {
      codec: this.config.codec,
      codedWidth: this.config.width,
      codedHeight: this.config.height,
    };
    if (this.config.codec.startsWith('avc1')) {
      // H.264 的 mp4-muxer 需要 avcC 描述
      decoderConfig.description = new Uint8Array([
        0x01, 0x42, 0xc0, 0x1f, 0xff, 0xe0, 0x00, 0x0a, 0x67, 0x42, 0xc0, 0x1f,
      ]).buffer;
    }
    this.output(chunk, { decoderConfig });
  }

  flush() {
    this.flushCount += 1;
    callOrder.push('video.flush');
    return Promise.resolve();
  }

  close() {
    if (this.state === 'closed') throw new Error('encoder 已关闭');
    this.state = 'closed';
    this.closed = true;
  }
}

// --------------------------------------------------------------- 音频桩 ----

class FakeEncodedAudioChunk {
  constructor({ type, timestamp, duration, byteLength = 128 }) {
    this.type = type;
    this.timestamp = timestamp;
    this.duration = duration;
    this.byteLength = byteLength;
  }
  copyTo(dest) {
    const view = new Uint8Array(dest.buffer || dest, dest.byteOffset || 0, dest.byteLength || dest.length);
    for (let i = 0; i < view.length; i += 1) view[i] = (i * 53 + 7) & 0xff;
  }
}

class FakeAudioData {
  static instances = [];

  constructor(init) {
    if (!init || init.format !== 'f32-planar') throw new Error('AudioData 需要 f32-planar');
    if (!(init.data instanceof Float32Array)) throw new Error('AudioData.data 不是 Float32Array');
    this.format = init.format;
    this.sampleRate = init.sampleRate;
    this.numberOfFrames = init.numberOfFrames;
    this.numberOfChannels = init.numberOfChannels;
    this.timestamp = init.timestamp;
    this.data = init.data;
    this.closed = false;
    FakeAudioData.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

class FakeAudioEncoder {
  static supportedCodecs = new Set();
  static instances = [];
  static supportChecks = 0;

  static async isConfigSupported(config) {
    FakeAudioEncoder.supportChecks += 1;
    return { supported: FakeAudioEncoder.supportedCodecs.has(config.codec), config };
  }

  constructor({ output, error } = {}) {
    this.output = output;
    this.errorCallback = error;
    this.state = 'unconfigured';
    this.config = null;
    this.configureCount = 0;
    this.encodeCount = 0;
    this.flushCount = 0;
    this.chunks = [];
    this.closed = false;
    FakeAudioEncoder.instances.push(this);
  }

  get encodeQueueSize() {
    return 0;
  }

  configure(config) {
    this.config = { ...config };
    this.configureCount += 1;
    this.state = 'configured';
  }

  encode(audioData) {
    if (this.state !== 'configured') throw new Error('audio encoder 未 configure');
    this.encodeCount += 1;
    const duration = Math.round((audioData.numberOfFrames / audioData.sampleRate) * 1e6);
    const chunk = new FakeEncodedAudioChunk({ type: 'key', timestamp: audioData.timestamp, duration });
    this.chunks.push(chunk);

    const decoderConfig = {
      codec: this.config.codec,
      sampleRate: this.config.sampleRate,
      numberOfChannels: this.config.numberOfChannels,
    };
    if (this.config.codec === 'mp4a.40.2') {
      // AAC-LC 的 AudioSpecificConfig（2 字节足够 mp4-muxer 写 esds）
      decoderConfig.description = new Uint8Array([0x11, 0x90]).buffer;
    } else {
      // OpusHead 至少 18 字节，webm-muxer 只做透传
      const head = new Uint8Array(19);
      head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);
      head[8] = 1;
      head[9] = this.config.numberOfChannels;
      decoderConfig.description = head.buffer;
    }
    this.output(chunk, { decoderConfig });
  }

  flush() {
    this.flushCount += 1;
    callOrder.push('audio.flush');
    return Promise.resolve();
  }

  close() {
    this.state = 'closed';
    this.closed = true;
  }
}

class FakeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }
  getContext(type, options) {
    if (type !== '2d') return null;
    const ctx = { canvas: this, options };
    for (const key of [
      'save', 'restore', 'clearRect', 'fillRect', 'strokeRect', 'fillText',
      'drawImage', 'beginPath', 'closePath', 'arc', 'fill', 'stroke',
      'translate', 'scale', 'rotate', 'setTransform', 'putImageData',
    ]) {
      ctx[key] = () => {};
    }
    return ctx;
  }
}

function installStubs({
  supported = [],
  pendingDrain = 0,
  audioSupported = ['mp4a.40.2', 'opus'],
} = {}) {
  FakeVideoEncoder.supported = new Set(supported);
  FakeVideoEncoder.instances = [];
  FakeVideoEncoder.pendingDrain = pendingDrain;
  FakeAudioEncoder.supportedCodecs = new Set(audioSupported);
  FakeAudioEncoder.instances = [];
  FakeAudioEncoder.supportChecks = 0;
  FakeAudioData.instances = [];
  callOrder.length = 0;
  globalThis.VideoEncoder = FakeVideoEncoder;
  globalThis.VideoFrame = FakeVideoFrame;
  globalThis.EncodedVideoChunk = FakeEncodedVideoChunk;
  globalThis.AudioEncoder = FakeAudioEncoder;
  globalThis.AudioData = FakeAudioData;
  globalThis.EncodedAudioChunk = FakeEncodedAudioChunk;
  globalThis.OffscreenCanvas = FakeOffscreenCanvas;
}

function removeStubs() {
  delete globalThis.VideoEncoder;
  delete globalThis.VideoFrame;
  delete globalThis.EncodedVideoChunk;
  delete globalThis.AudioEncoder;
  delete globalThis.AudioData;
  delete globalThis.EncodedAudioChunk;
  delete globalThis.OffscreenCanvas;
}

function lastEncoder() {
  return FakeVideoEncoder.instances[FakeVideoEncoder.instances.length - 1];
}

function lastAudioEncoder() {
  return FakeAudioEncoder.instances[FakeAudioEncoder.instances.length - 1];
}

/** 给两个 muxer 的原型打点；返回还原函数。 */
function installMuxerSpies() {
  muxSpy.audioChunks = 0;
  muxSpy.videoChunks = 0;
  muxSpy.finalize = false;
  const patches = [];
  for (const Mixin of [Mp4Muxer, WebmMuxer]) {
    for (const method of ['addAudioChunk', 'addVideoChunk', 'finalize']) {
      const original = Mixin.prototype[method];
      if (typeof original !== 'function') continue;
      Mixin.prototype[method] = function patched(...args) {
        if (method === 'addAudioChunk') muxSpy.audioChunks += 1;
        if (method === 'addVideoChunk') muxSpy.videoChunks += 1;
        if (method === 'finalize') {
          muxSpy.finalize = true;
          callOrder.push('muxer.finalize');
        }
        return original.apply(this, args);
      };
      patches.push({ Mixin, method, original });
    }
  }
  return () => {
    for (const p of patches) p.Mixin.prototype[p.method] = p.original;
  };
}

/** 假的 AudioBuffer（只实现导出器用到的那几个字段）。 */
function makeAudioBuffer({ sampleRate = 48000, duration = 1, numberOfChannels = 2 } = {}) {
  const length = Math.round(sampleRate * duration);
  const channels = [];
  for (let ch = 0; ch < numberOfChannels; ch += 1) {
    const data = new Float32Array(length);
    const freq = 220 + ch * 110;
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.sin((i * 2 * Math.PI * freq) / sampleRate) * 0.5;
    }
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

// --------------------------------------------------------------- 测试开始 ----

console.log('导出管线');

check('模块导出 exportTimeline 与 ExportError', () => {
  assert(typeof exportTimeline === 'function', 'exportTimeline 不是函数');
  assert(typeof ExportError === 'function', '缺少 ExportError');
  assert(new ExportError('X', 'x') instanceof Error, 'ExportError 不是 Error');
});

check('Node 环境确认没有 VideoEncoder', () => {
  assert(typeof globalThis.VideoEncoder === 'undefined', '测试前提不成立：环境里已有 VideoEncoder');
});

await checkAsync('没有 VideoEncoder 时抛 NO_ENCODER', async () => {
  let err = null;
  try {
    await exportTimeline({
      drawFrame() {},
      duration: 1,
      fps: 10,
      width: 64,
      height: 64,
    });
  } catch (e) {
    err = e;
  }
  assert(err, '应当抛错');
  assert(err.code === 'NO_ENCODER', 'code=' + err.code);
  assert(err.name === 'ExportError', 'name=' + err.name);
});

await checkAsync('参数非法时抛 INVALID_ARG', async () => {
  const cases = [
    { duration: 1, width: 64, height: 64 }, // 缺 drawFrame
    { drawFrame() {}, duration: 0, width: 64, height: 64 },
    { drawFrame() {}, duration: 1, fps: 0, width: 64, height: 64 },
    { drawFrame() {}, duration: 1, width: 0, height: 64 },
  ];
  for (const opts of cases) {
    let err = null;
    try {
      await exportTimeline(opts);
    } catch (e) {
      err = e;
    }
    assert(err && err.code === 'INVALID_ARG', 'code=' + (err && err.code));
  }
});

await checkAsync('MP4 路径：帧数/每帧 drawFrame/关键帧/进度/文件名/返回值', async () => {
  installStubs({ supported: ['avc1.42001f'] });
  try {
    const progress = [];
    const draws = [];
    const controller = new AbortController();

    const result = await exportTimeline({
      drawFrame(ctx, t, w, h) {
        draws.push({ t, w, h });
        ctx.fillRect(0, 0, w, h);
      },
      duration: 1.2,
      fps: 10,
      width: 101, // 向上取偶 → 102
      height: 99, // 向上取偶 → 100
      title: 'a/b:c *d',
      onProgress: (p) => progress.push(p),
      signal: controller.signal,
    });

    assert(result.frames === 12, 'frames=' + result.frames);
    assert(draws.length === 12, 'drawFrame 调用次数=' + draws.length);
    assert(draws[0].t === 0, '首帧 t=' + draws[0].t);
    assert(Math.abs(draws[11].t - 1.1) < 1e-9, '末帧 t=' + draws[11].t);
    assert(draws.every((d) => d.w === 102 && d.h === 100), '画布尺寸不是 102x100');

    const encoder = lastEncoder();
    assert(encoder.config.width === 102 && encoder.config.height === 100, '编码尺寸未取偶');
    assert(encoder.encodeCount === 12, 'encode 次数=' + encoder.encodeCount);
    assert(encoder.keyCount === 1, '关键帧数=' + encoder.keyCount);
    assert(encoder.frames.every((f) => f.closed === true), '有 VideoFrame 未 close');
    assert(encoder.closed === true, '正常结束后未 close 编码器');

    assert(result.container === 'mp4', 'container=' + result.container);
    assert(result.codec === 'avc1.42001f', 'codec=' + result.codec);
    assert(result.blob instanceof Blob, 'blob 不是 Blob');
    assert(result.blob.type === 'video/mp4', 'blob.type=' + result.blob.type);
    assert(result.blob.size > 0, 'blob 为空');
    assert(typeof result.ms === 'number' && result.ms >= 0, 'ms=' + result.ms);
    assert(
      /^a-b-c-d-\d{8}-\d{4}\.mp4$/.test(result.fileName),
      'fileName=' + result.fileName,
    );

    const keys = Object.keys(result).sort().join(',');
    assert(
      keys === 'blob,codec,container,duration,fileName,fps,frames,ms,sourceFps,videoCodec',
      '返回字段=' + keys,
    );

    assert(progress.length >= 3, '进度回调次数=' + progress.length);
    const encodeEvents = progress.filter((p) => p.phase === 'encode');
    assert(encodeEvents.length === 12, 'encode 进度次数=' + encodeEvents.length);
    encodeEvents.forEach((p, i) => {
      assert(Math.abs(p.ratio - i / 12) < 1e-9, 'ratio[' + i + ']=' + p.ratio);
    });
    const last = progress[progress.length - 1];
    assert(last.phase === 'done' && last.ratio === 1, '末次进度=' + JSON.stringify(last));
  } finally {
    removeStubs();
  }
});

await checkAsync('WebM 兜底：只支持 VP9 时用 webm 容器', async () => {
  installStubs({ supported: ['vp09.00.10.08'] });
  try {
    const result = await exportTimeline({
      drawFrame() {},
      duration: 0.5,
      fps: 10,
      width: 64,
      height: 64,
      title: '   ',
    });
    assert(result.container === 'webm', 'container=' + result.container);
    assert(result.codec === 'vp09.00.10.08', 'codec=' + result.codec);
    assert(result.blob.type === 'video/webm', 'blob.type=' + result.blob.type);
    assert(result.frames === 5, 'frames=' + result.frames);
    assert(/^video-\d{8}-\d{4}\.webm$/.test(result.fileName), 'fileName=' + result.fileName);
    assert(lastEncoder().encodeCount === 5, 'encode=' + lastEncoder().encodeCount);
  } finally {
    removeStubs();
  }
});

await checkAsync('abort 会关闭编码器并抛 ABORTED', async () => {
  installStubs({ supported: ['avc1.42001f'] });
  try {
    const controller = new AbortController();
    let draws = 0;
    let err = null;
    try {
      await exportTimeline({
        drawFrame() {
          draws += 1;
          if (draws === 3) controller.abort();
        },
        duration: 2,
        fps: 10,
        width: 64,
        height: 64,
        signal: controller.signal,
      });
    } catch (e) {
      err = e;
    }
    assert(err, '应当被中止');
    assert(err.code === 'ABORTED', 'code=' + (err && err.code));
    assert(draws === 3, '中止点 drawFrame 次数=' + draws);
    const encoder = lastEncoder();
    assert(encoder.closed === true, '中止后编码器未 close');
    assert(encoder.encodeCount === 2, '中止后 encode 次数=' + encoder.encodeCount);
  } finally {
    removeStubs();
  }
});

await checkAsync('背压：encodeQueueSize 超阈值会等待并最终完成', async () => {
  installStubs({ supported: ['avc1.42001f'], pendingDrain: 3 });
  try {
    const result = await exportTimeline({
      drawFrame() {},
      duration: 1,
      fps: 5,
      width: 64,
      height: 64,
    });
    assert(result.frames === 5, 'frames=' + result.frames);
    const encoder = lastEncoder();
    assert(encoder.encodeCount === 5, 'encode=' + encoder.encodeCount);
    assert(encoder.queueReads >= 4, '未触发背压轮询，queueReads=' + encoder.queueReads);
  } finally {
    removeStubs();
  }
});

// --------------------------------------------------------------- 音轨测试 ----

await checkAsync('音轨①：MP4 传 audioBuffer 时配置 AAC-LC 并按 1024 帧切块', async () => {
  installStubs({ supported: ['avc1.42001f'] });
  const restore = installMuxerSpies();
  try {
    const audioBuffer = makeAudioBuffer({ sampleRate: 48000, duration: 1 });
    const progress = [];
    const result = await exportTimeline({
      drawFrame() {},
      duration: 1,
      fps: 10,
      width: 64,
      height: 64,
      audioBuffer,
      onProgress: (p) => progress.push(p),
    });

    // 探测 + 配置
    assert(FakeAudioEncoder.supportChecks === 1, 'isConfigSupported 次数=' + FakeAudioEncoder.supportChecks);
    const enc = lastAudioEncoder();
    assert(enc, '没有创建 AudioEncoder');
    assert(enc.configureCount === 1, 'configure 次数=' + enc.configureCount);
    assert(enc.config.codec === 'mp4a.40.2', 'codec=' + enc.config.codec);
    assert(enc.config.sampleRate === 48000, 'sampleRate=' + enc.config.sampleRate);
    assert(enc.config.numberOfChannels === 2, 'channels=' + enc.config.numberOfChannels);

    // 切块：48000 / 1024 = 46.875 → 47 块
    assert(enc.encodeCount === 47, 'audio encode 次数=' + enc.encodeCount);
    assert(muxSpy.audioChunks === 47, 'muxer 收到音频块=' + muxSpy.audioChunks);
    assert(enc.flushCount === 1, 'audio flush 次数=' + enc.flushCount);

    // 第一块 AudioData 的构造参数
    const first = FakeAudioData.instances[0];
    assert(first.format === 'f32-planar', 'format=' + first.format);
    assert(first.sampleRate === 48000, 'sampleRate=' + first.sampleRate);
    assert(first.numberOfFrames === 1024, 'numberOfFrames=' + first.numberOfFrames);
    assert(first.numberOfChannels === 2, 'numberOfChannels=' + first.numberOfChannels);
    assert(first.timestamp === 0, '首块 timestamp=' + first.timestamp);
    assert(first.data.length === 1024 * 2, 'planar 数据长度=' + first.data.length);
    const lastAudioData = FakeAudioData.instances[FakeAudioData.instances.length - 1];
    assert(lastAudioData.numberOfFrames === 896, '末块帧数=' + lastAudioData.numberOfFrames);
    assert(
      lastAudioData.timestamp === Math.round(((46 * 1024) / 48000) * 1e6),
      '末块 timestamp=' + lastAudioData.timestamp,
    );
    assert(
      FakeAudioData.instances.every((d) => d.closed === true),
      '有 AudioData 未 close',
    );

    // 返回值
    assert(result.audioCodec === 'aac', 'audioCodec=' + result.audioCodec);
    assert(result.audioBytes > 0, 'audioBytes=' + result.audioBytes);
    assert(result.audioWarning === undefined, 'audioWarning=' + result.audioWarning);
    assert(result.blob.size > 0, 'blob 为空');

    // 进度：先 audio、后 encode，ratio 单调不减
    const phases = progress.map((p) => p.phase);
    const firstAudio = phases.indexOf('audio');
    const firstEncode = phases.indexOf('encode');
    assert(firstAudio >= 0, '没有 audio 进度');
    assert(firstEncode > firstAudio, '阶段顺序=' + phases.join(','));
    for (let i = 1; i < progress.length; i += 1) {
      assert(progress[i].ratio >= progress[i - 1].ratio, 'ratio 回退 @' + i);
    }
    assert(progress[progress.length - 1].phase === 'done', '末次进度不是 done');
  } finally {
    restore();
    removeStubs();
  }
});

await checkAsync('音轨②：WebM 传 audioBuffer 时配置 Opus 并按 960 帧切块', async () => {
  installStubs({ supported: ['vp09.00.10.08'] });
  const restore = installMuxerSpies();
  try {
    const result = await exportTimeline({
      drawFrame() {},
      duration: 1,
      fps: 10,
      width: 64,
      height: 64,
      audioBuffer: makeAudioBuffer({ sampleRate: 48000, duration: 1 }),
    });

    const enc = lastAudioEncoder();
    assert(enc, '没有创建 AudioEncoder');
    assert(enc.config.codec === 'opus', 'codec=' + enc.config.codec);
    assert(enc.encodeCount === 50, 'audio encode 次数=' + enc.encodeCount); // 48000 / 960
    assert(muxSpy.audioChunks === 50, 'muxer 收到音频块=' + muxSpy.audioChunks);
    assert(result.container === 'webm', 'container=' + result.container);
    assert(result.audioCodec === 'opus', 'audioCodec=' + result.audioCodec);
    assert(result.blob.size > 0, 'blob 为空');
  } finally {
    restore();
    removeStubs();
  }
});

await checkAsync('音轨③：源采样率 44100 时重采样到 48k', async () => {
  installStubs({ supported: ['avc1.42001f'] });
  const restore = installMuxerSpies();
  try {
    const result = await exportTimeline({
      drawFrame() {},
      duration: 0.5,
      fps: 10,
      width: 64,
      height: 64,
      audioBuffer: makeAudioBuffer({ sampleRate: 44100, duration: 0.5 }),
    });

    const enc = lastAudioEncoder();
    assert(enc.encodeCount === 24, 'audio encode 次数=' + enc.encodeCount); // ceil(24000/1024)
    const totalFrames = FakeAudioData.instances.reduce((sum, d) => sum + d.numberOfFrames, 0);
    assert(totalFrames === 24000, '重采样后总帧数=' + totalFrames);
    const first = FakeAudioData.instances[0];
    assert(first.sampleRate === 48000, 'sampleRate=' + first.sampleRate);
    // 44.1k 源做线性插值后应与 48k 解析信号高度接近
    const expected0 = Math.sin((2 * Math.PI * 220 * 1) / 48000) * 0.5;
    const expected1 = Math.sin((2 * Math.PI * 330 * 1) / 48000) * 0.5;
    assert(Math.abs(first.data[1] - expected0) < 0.01, '声道0 插值偏差=' + first.data[1]);
    assert(Math.abs(first.data[1024 + 1] - expected1) < 0.01, '声道1 插值偏差=' + first.data[1024 + 1]);
    assert(result.audioCodec === 'aac', 'audioCodec=' + result.audioCodec);
  } finally {
    restore();
    removeStubs();
  }
});

await checkAsync('音轨④：不传 audioBuffer 时完全不碰 AudioEncoder', async () => {
  installStubs({ supported: ['avc1.42001f'] });
  const restore = installMuxerSpies();
  try {
    const result = await exportTimeline({
      drawFrame() {},
      duration: 0.5,
      fps: 10,
      width: 64,
      height: 64,
    });
    assert(FakeAudioEncoder.instances.length === 0, '不该创建 AudioEncoder');
    assert(FakeAudioEncoder.supportChecks === 0, '不该探测 AudioEncoder');
    assert(muxSpy.audioChunks === 0, 'muxer 不该收到音频块');
    const keys = Object.keys(result).sort().join(',');
    assert(
      keys === 'blob,codec,container,duration,fileName,fps,frames,ms,sourceFps,videoCodec',
      '返回字段=' + keys,
    );
    assert(result.audioWarning === undefined, 'audioWarning=' + result.audioWarning);
  } finally {
    restore();
    removeStubs();
  }
});

await checkAsync('音轨⑤：isConfigSupported=false 时静默降级为无音轨', async () => {
  installStubs({ supported: ['avc1.42001f'], audioSupported: [] });
  const restore = installMuxerSpies();
  try {
    const progress = [];
    const result = await exportTimeline({
      drawFrame() {},
      duration: 0.5,
      fps: 10,
      width: 64,
      height: 64,
      audioBuffer: makeAudioBuffer({ sampleRate: 48000, duration: 0.5 }),
      onProgress: (p) => progress.push(p),
    });

    assert(FakeAudioEncoder.supportChecks === 1, '应当探测一次');
    assert(FakeAudioEncoder.instances.length === 0, '不支持时不该创建 AudioEncoder');
    assert(muxSpy.audioChunks === 0, '放弃音轨后不该写音频块');
    assert(result.audioWarning === 'NO_AUDIO_ENCODER', 'audioWarning=' + result.audioWarning);
    assert(result.audioCodec === undefined, '不该有 audioCodec');
    assert(result.audioBytes === undefined, '不该有 audioBytes');
    assert(result.blob.size > 0, '视频应当照常导出');
    assert(lastEncoder().encodeCount === 5, '视频帧数=' + lastEncoder().encodeCount);
    assert(!progress.some((p) => p.phase === 'audio'), '降级后不该有 audio 阶段');
  } finally {
    restore();
    removeStubs();
  }
});

await checkAsync('音轨⑥：两个编码器的 flush 都在 muxer.finalize 之前', async () => {
  installStubs({ supported: ['avc1.42001f'] });
  const restore = installMuxerSpies();
  try {
    await exportTimeline({
      drawFrame() {},
      duration: 0.5,
      fps: 10,
      width: 64,
      height: 64,
      audioBuffer: makeAudioBuffer({ sampleRate: 48000, duration: 0.5 }),
    });

    const audioFlush = callOrder.indexOf('audio.flush');
    const videoFlush = callOrder.indexOf('video.flush');
    const finalize = callOrder.indexOf('muxer.finalize');
    assert(audioFlush >= 0, '没有调用 audio flush：' + callOrder.join(','));
    assert(videoFlush >= 0, '没有调用 video flush：' + callOrder.join(','));
    assert(finalize >= 0, '没有调用 muxer.finalize：' + callOrder.join(','));
    assert(audioFlush < finalize, 'audio flush 晚于 finalize');
    assert(videoFlush < finalize, 'video flush 晚于 finalize');
    assert(muxSpy.finalize === true, 'muxer 没有 finalize');
    assert(lastAudioEncoder().flushCount === 1, 'audio flush 次数=' + lastAudioEncoder().flushCount);
    assert(lastEncoder().flushCount === 1, 'video flush 次数=' + lastEncoder().flushCount);
  } finally {
    restore();
    removeStubs();
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
