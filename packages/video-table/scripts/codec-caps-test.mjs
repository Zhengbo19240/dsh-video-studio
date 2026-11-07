/**
 * 编码能力探测 + 导出组合决策的测试（纯 Node，不需要浏览器）。
 *
 *   node scripts/codec-caps-test.mjs
 *
 * 覆盖三件事：
 *  1. probeEncoders 只说真话：能编的就 true，探测抛错就 false，绝不把异常抛给上层；
 *  2. chooseExportPlan 的组合优先级：H.264+AAC → HEVC+AAC（本机）→ WebM VP9/AV1+Opus
 *     → 无音轨 → NO_ENCODER；
 *  3. exporter 真的按计划配置编码器（HEVC 用 hvc1.*，无音轨时不碰 AudioEncoder），
 *     且原有 planExport 参数与返回值形状不变。
 */

import {
  AUDIO_CANDIDATES,
  VIDEO_CANDIDATES,
  chooseExportPlan,
  describePlan,
  probeEncoders,
} from '../src/client/codec-caps.mjs';
import { ExportError, exportTimeline, planExport } from '../src/client/exporter.js';

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

// ------------------------------------------------------------ 能力表构造 ----

/**
 * 直接拼一份 probeEncoders 形状的能力表。
 * @param {object} video 例如 { h264: true, hevc: true }
 * @param {object} audio 例如 { aac: true }
 */
function capsOf(video = {}, audio = {}) {
  const out = { video: {}, audio: {} };
  for (const family of Object.keys(VIDEO_CANDIDATES)) {
    out.video[family] = video[family]
      ? { supported: true, codec: VIDEO_CANDIDATES[family][0] }
      : { supported: false, reason: '测试里标成不支持' };
  }
  for (const family of Object.keys(AUDIO_CANDIDATES)) {
    out.audio[family] = audio[family]
      ? { supported: true, codec: AUDIO_CANDIDATES[family] }
      : { supported: false, reason: '测试里标成不支持' };
  }
  return out;
}

// 本机情形：H.264 编码器缺失，HEVC ✓、VP9 ✓、AV1 ✓、AAC ✓、Opus ✓
const THIS_MACHINE = capsOf({ hevc: true, vp9: true, av1: true }, { aac: true, opus: true });

// ------------------------------------------------------------ 探测用的桩 ----

class ProbeVideoEncoder {
  static supported = new Set();
  static throwOn = new Set();
  static calls = [];

  static async isConfigSupported(config) {
    ProbeVideoEncoder.calls.push(config.codec);
    if (ProbeVideoEncoder.throwOn.has(config.codec)) throw new Error('NotSupportedError: ' + config.codec);
    return { supported: ProbeVideoEncoder.supported.has(config.codec), config };
  }
}

class ProbeAudioEncoder {
  static supported = new Set();
  static throwOn = new Set();

  static async isConfigSupported(config) {
    if (ProbeAudioEncoder.throwOn.has(config.codec)) throw new Error('NotSupportedError: ' + config.codec);
    return { supported: ProbeAudioEncoder.supported.has(config.codec), config };
  }
}

function installProbe({ video = [], audio = [], throwVideo = [], throwAudio = [] } = {}) {
  ProbeVideoEncoder.supported = new Set(video);
  ProbeVideoEncoder.throwOn = new Set(throwVideo);
  ProbeVideoEncoder.calls = [];
  ProbeAudioEncoder.supported = new Set(audio);
  ProbeAudioEncoder.throwOn = new Set(throwAudio);
}

// --------------------------------------------------------------- 探测测试 ----

console.log('编码能力探测');

await check('① 返回结构完整：4 个视频 + 2 个音频键，每项 supported 都是布尔', async () => {
  installProbe({ video: ['avc1.42001f'], audio: ['mp4a.40.2'] });
  const caps = await probeEncoders({ VideoEncoder: ProbeVideoEncoder, AudioEncoder: ProbeAudioEncoder });

  assert(Object.keys(caps.video).sort().join(',') === 'av1,h264,hevc,vp9', 'video 键=' + Object.keys(caps.video));
  assert(Object.keys(caps.audio).sort().join(',') === 'aac,opus', 'audio 键=' + Object.keys(caps.audio));
  for (const family of ['h264', 'hevc', 'vp9', 'av1']) {
    assert(typeof caps.video[family].supported === 'boolean', family + '.supported 不是布尔');
  }
  for (const family of ['aac', 'opus']) {
    assert(typeof caps.audio[family].supported === 'boolean', family + '.supported 不是布尔');
  }
  assert(caps.video.h264.supported === true, 'h264 应为 true');
  assert(caps.video.h264.codec === 'avc1.42001f', 'h264.codec=' + caps.video.h264.codec);
  assert(caps.video.hevc.supported === false, 'hevc 应为 false');
  assert(typeof caps.video.hevc.reason === 'string' && caps.video.hevc.reason.length > 0, '不支持时应有 reason');
});

await check('② 只有 H.264：HEVC 的两种字串都被试过，且都没有成功', async () => {
  installProbe({ video: ['avc1.42001f'], audio: ['mp4a.40.2'] });
  const caps = await probeEncoders({ VideoEncoder: ProbeVideoEncoder, AudioEncoder: ProbeAudioEncoder });
  assert(caps.video.h264.supported === true, 'h264 应为 true');
  assert(caps.video.hevc.supported === false, 'hevc 应为 false');
  for (const codec of VIDEO_CANDIDATES.hevc) {
    assert(ProbeVideoEncoder.calls.includes(codec), '没有探测 ' + codec);
  }
});

await check('③ HEVC 优先 hvc1；hvc1 不过时用实测通过的 hev1', async () => {
  installProbe({ video: ['hev1.1.6.L93.B0'], audio: ['mp4a.40.2'] });
  const caps = await probeEncoders({ VideoEncoder: ProbeVideoEncoder, AudioEncoder: ProbeAudioEncoder });
  assert(caps.video.hevc.supported === true, 'hevc 应为 true');
  assert(caps.video.hevc.codec === 'hev1.1.6.L93.B0', 'codec=' + caps.video.hevc.codec);
  // 顺序：hvc1 先试，失败后才试 hev1
  const order = ProbeVideoEncoder.calls.filter((c) => VIDEO_CANDIDATES.hevc.includes(c));
  assert(order[0] === 'hvc1.1.6.L93.B0', '第一个试的不是 hvc1：' + order.join(','));
});

await check('④ isConfigSupported 抛错：当成不支持，绝不抛给上层', async () => {
  installProbe({
    video: [],
    audio: [],
    throwVideo: ['avc1.42001f', 'hvc1.1.6.L93.B0', 'vp09.00.10.08', 'av01.0.08M.08'],
    throwAudio: ['mp4a.40.2', 'opus'],
  });
  const caps = await probeEncoders({ VideoEncoder: ProbeVideoEncoder, AudioEncoder: ProbeAudioEncoder });
  for (const family of ['h264', 'hevc', 'vp9', 'av1']) {
    assert(caps.video[family].supported === false, family + ' 应被判为不支持');
    assert(/抛错/.test(caps.video[family].reason || ''), family + '.reason=' + caps.video[family].reason);
  }
  assert(caps.audio.aac.supported === false && caps.audio.opus.supported === false, '音频应全部不支持');
});

await check('⑤ 运行环境没有 VideoEncoder / AudioEncoder：全部不支持并说明原因', async () => {
  const caps = await probeEncoders({ VideoEncoder: undefined, AudioEncoder: undefined });
  for (const family of ['h264', 'hevc', 'vp9', 'av1']) {
    assert(caps.video[family].supported === false, family + ' 应为 false');
    assert(/VideoEncoder/.test(caps.video[family].reason || ''), family + '.reason=' + caps.video[family].reason);
  }
  for (const family of ['aac', 'opus']) {
    assert(caps.audio[family].supported === false, family + ' 应为 false');
    assert(/AudioEncoder/.test(caps.audio[family].reason || ''), family + '.reason=' + caps.audio[family].reason);
  }
});

// --------------------------------------------------------------- 决策测试 ----

console.log('导出组合决策');

await check('⑥ 只有 H.264 + AAC → MP4 / H.264 / AAC（首选）', () => {
  const plan = chooseExportPlan(capsOf({ h264: true }, { aac: true }));
  assert(plan.container === 'mp4', 'container=' + plan.container);
  assert(plan.videoCodec === 'h264', 'videoCodec=' + plan.videoCodec);
  assert(plan.codec === 'avc1.42001f', 'codec=' + plan.codec);
  assert(plan.audioCodec === 'aac', 'audioCodec=' + plan.audioCodec);
  assert(plan.reason.includes('首选'), 'reason=' + plan.reason);
});

await check('⑦ 本机情形（无 H.264、有 HEVC + AAC）→ MP4 / HEVC / AAC，reason 说明改用 HEVC', () => {
  const plan = chooseExportPlan(THIS_MACHINE);
  assert(plan.container === 'mp4', 'container=' + plan.container);
  assert(plan.videoCodec === 'hevc', 'videoCodec=' + plan.videoCodec);
  assert(plan.codec.startsWith('hvc1.'), 'HEVC 应该用 hvc1.*，实际=' + plan.codec);
  assert(plan.audioCodec === 'aac', 'audioCodec=' + plan.audioCodec);
  assert(plan.reason.includes('H.264') && plan.reason.includes('HEVC'), 'reason=' + plan.reason);
});

await check('⑧ 只有 VP9 + Opus → WebM / VP9 / Opus，reason 说清为什么不是 MP4', () => {
  const plan = chooseExportPlan(capsOf({ vp9: true }, { opus: true }));
  assert(plan.container === 'webm', 'container=' + plan.container);
  assert(plan.videoCodec === 'vp9', 'videoCodec=' + plan.videoCodec);
  assert(plan.codec === 'vp09.00.10.08', 'codec=' + plan.codec);
  assert(plan.audioCodec === 'opus', 'audioCodec=' + plan.audioCodec);
  assert(plan.reason.includes('H.264') && plan.reason.includes('AAC'), 'reason=' + plan.reason);
});

await check('⑨ 没有 VP9、有 AV1 + Opus → WebM / AV1 / Opus', () => {
  const plan = chooseExportPlan(capsOf({ av1: true }, { opus: true }));
  assert(plan.container === 'webm', 'container=' + plan.container);
  assert(plan.videoCodec === 'av1', 'videoCodec=' + plan.videoCodec);
  assert(plan.codec === 'av01.0.08M.08', 'codec=' + plan.codec);
});

await check('⑩ 全无视频编码 → 抛 NO_ENCODER，中文说明', () => {
  let err = null;
  try {
    chooseExportPlan(capsOf({}, { aac: true, opus: true }));
  } catch (e) {
    err = e;
  }
  assert(err, '应当抛错');
  assert(err.code === 'NO_ENCODER', 'code=' + (err && err.code));
  assert(/[\u4e00-\u9fa5]/.test(err.message), '不是中文说明：' + err.message);
  assert(/H\.264/.test(err.message) && /HEVC/.test(err.message), '说明里没列编码：' + err.message);
});

await check('⑪ 无音频但有视频 → 无音轨，reason 写明（h264 only）', () => {
  const plan = chooseExportPlan(capsOf({ h264: true }, {}));
  assert(plan.container === 'mp4', 'container=' + plan.container);
  assert(plan.videoCodec === 'h264', 'videoCodec=' + plan.videoCodec);
  assert(plan.audioCodec === null, 'audioCodec=' + plan.audioCodec);
  assert(plan.reason.includes('AAC') && plan.reason.includes('Opus'), 'reason=' + plan.reason);
  assert(plan.reason.includes('无音轨'), 'reason 没写无音轨：' + plan.reason);
});

await check('⑫ 有 Opus 但没有 VP9/AV1（H.264 only）→ 仍出 MP4，无音轨且说明 Opus 装不进 MP4', () => {
  const plan = chooseExportPlan(capsOf({ h264: true }, { opus: true }));
  assert(plan.container === 'mp4', 'container=' + plan.container);
  assert(plan.audioCodec === null, 'audioCodec=' + plan.audioCodec);
  assert(plan.reason.includes('Opus') && plan.reason.includes('MP4'), 'reason=' + plan.reason);
});

await check('⑬ describePlan 文案：本机情形逐字给出「MP4 / HEVC / AAC + 改用 HEVC」', () => {
  const line = describePlan(chooseExportPlan(THIS_MACHINE));
  assert(line === '将导出：MP4 / HEVC / AAC（本机不支持 H.264，已自动改用 HEVC）', 'line=' + line);
  const webm = describePlan(chooseExportPlan(capsOf({ vp9: true }, { opus: true })));
  assert(webm.startsWith('将导出：WebM / VP9 / Opus'), 'webm line=' + webm);
});

// ------------------------------------------------------- planExport 兼容 ----

console.log('导出计划接口');

await check('⑭ planExport 原有参数一个不改，且 output 与传入 plan 一致', () => {
  const plan = chooseExportPlan(THIS_MACHINE);
  const out = planExport({ duration: 3, fps: 30, width: 1920, height: 1080, bitrateKbps: 8000, plan });
  assert(out.width === 1920 && out.height === 1080, '尺寸=' + out.width + 'x' + out.height);
  assert(out.fps === 30, 'fps=' + out.fps);
  assert(out.projectFps === 30, 'projectFps=' + out.projectFps);
  assert(out.bitrate === 8_000_000 && out.bitrateKbps === 8000, '码率=' + out.bitrate);
  assert(out.range.start === 0 && out.range.end === 3, 'range=' + JSON.stringify(out.range));
  assert(out.duration === 3 && out.totalFrames === 90, 'frames=' + out.totalFrames);
  assert(out.sampleStep === 1, 'sampleStep=' + out.sampleStep);
  assert(out.muxer.frameRate === 30 && out.muxer.bitrate === 8_000_000, 'muxer=' + JSON.stringify(out.muxer));
  assert(out.output.container === 'mp4', 'output.container=' + out.output.container);
  assert(out.output.videoCodec === 'hevc', 'output.videoCodec=' + out.output.videoCodec);
  assert(out.output.muxerVideoCodec === 'hevc', 'output.muxerVideoCodec=' + out.output.muxerVideoCodec);
  assert(out.output.audioCodec === 'aac', 'output.audioCodec=' + out.output.audioCodec);
});

await check('⑮ planExport 只给 caps 时自动选 HEVC；都不给时 output=null（老行为不变）', () => {
  const withCaps = planExport({ duration: 1, fps: 30, width: 640, height: 360, caps: THIS_MACHINE });
  assert(withCaps.output && withCaps.output.codec.startsWith('hvc1.'), 'output=' + JSON.stringify(withCaps.output));
  const legacy = planExport({ duration: 1, fps: 30, width: 640, height: 360 });
  assert(legacy.output === null, 'legacy.output=' + legacy.output);
});

await check('⑯ 非法组合被拦下：MP4 装 Opus 报 INVALID_ARG；WebM 计划可接受（webm-muxer 存在）', () => {
  let err = null;
  try {
    planExport({ duration: 1, fps: 30, width: 640, height: 360, plan: { container: 'mp4', videoCodec: 'h264', codec: 'avc1.42001f', audioCodec: 'opus', reason: '' } });
  } catch (e) {
    err = e;
  }
  assert(err instanceof ExportError, '不是 ExportError：' + (err && err.name));
  assert(err.code === 'INVALID_ARG', 'code=' + (err && err.code));
  assert(/Opus|音轨/.test(err.message), 'message=' + err.message);

  const webm = planExport({
    duration: 1,
    fps: 30,
    width: 640,
    height: 360,
    plan: { container: 'webm', videoCodec: 'vp9', codec: 'vp09.00.10.08', audioCodec: 'opus', reason: '测试' },
  });
  assert(webm.output.container === 'webm' && webm.output.muxerVideoCodec === 'V_VP9', 'webm output=' + JSON.stringify(webm.output));
});

// ----------------------------------------------------- 导出管线按计划执行 ----

class FakeChunk {
  constructor({ type, timestamp, duration, byteLength = 128 }) {
    this.type = type;
    this.timestamp = timestamp;
    this.duration = duration;
    this.byteLength = byteLength;
  }
  copyTo(dest) {
    const view = new Uint8Array(dest.buffer || dest, dest.byteOffset || 0, dest.byteLength || dest.length);
    for (let i = 0; i < view.length; i += 1) view[i] = (i * 29 + 3) & 0xff;
  }
}

// 视频块与音频块必须是两个类：exporter 用 instanceof EncodedAudioChunk 分派
class FakeEncodedVideoChunk extends FakeChunk {}
class FakeEncodedAudioChunk extends FakeChunk {}

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
  static supportQueries = [];
  static omitDescription = false;

  static async isConfigSupported(config) {
    FakeVideoEncoder.supportQueries.push({ codec: config.codec, width: config.width, height: config.height });
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
    const chunk = new FakeEncodedVideoChunk({ type, timestamp: frame.timestamp, duration: frame.duration });
    const decoderConfig = {
      codec: this.config.codec,
      codedWidth: this.config.width,
      codedHeight: this.config.height,
    };
    // HEVC 的 mp4-muxer 需要 hvcC；H.264 需要 avcC
    if (!FakeVideoEncoder.omitDescription) {
      if (this.config.codec.startsWith('hvc1') || this.config.codec.startsWith('hev1')) {
        decoderConfig.description = new Uint8Array([0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0x00, 0x00]).buffer;
      } else if (this.config.codec.startsWith('avc1')) {
        decoderConfig.description = new Uint8Array([0x01, 0x42, 0xc0, 0x1f, 0xff, 0xe0, 0x00, 0x0a, 0x67]).buffer;
      }
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

class FakeAudioEncoder {
  static supported = new Set();
  static instances = [];
  static supportQueries = 0;

  static async isConfigSupported(config) {
    FakeAudioEncoder.supportQueries += 1;
    return { supported: FakeAudioEncoder.supported.has(config.codec), config };
  }

  constructor({ output, error } = {}) {
    this.output = output;
    this.errorCallback = error;
    this.config = null;
    this.encodeCount = 0;
    this.closed = false;
    FakeAudioEncoder.instances.push(this);
  }

  get encodeQueueSize() {
    return 0;
  }

  configure(config) {
    this.config = { ...config };
  }

  encode(audioData) {
    this.encodeCount += 1;
    const duration = Math.round((audioData.numberOfFrames / audioData.sampleRate) * 1e6);
    const chunk = new FakeEncodedAudioChunk({ type: 'key', timestamp: audioData.timestamp, duration });
    const decoderConfig = { codec: this.config.codec, sampleRate: this.config.sampleRate, numberOfChannels: this.config.numberOfChannels };
    if (this.config.codec === 'mp4a.40.2') decoderConfig.description = new Uint8Array([0x11, 0x90]).buffer;
    this.output(chunk, { decoderConfig });
  }

  flush() {
    return Promise.resolve();
  }

  close() {
    this.closed = true;
  }
}

class FakeAudioData {
  constructor(init) {
    Object.assign(this, init);
  }
  close() {}
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

function installStubs({ video = [], audio = [] } = {}) {
  FakeVideoEncoder.supported = new Set(video);
  FakeVideoEncoder.instances = [];
  FakeVideoEncoder.supportQueries = [];
  FakeVideoEncoder.omitDescription = false;
  FakeAudioEncoder.supported = new Set(audio);
  FakeAudioEncoder.instances = [];
  FakeAudioEncoder.supportQueries = 0;
  globalThis.VideoEncoder = FakeVideoEncoder;
  globalThis.VideoFrame = FakeVideoFrame;
  globalThis.EncodedVideoChunk = FakeEncodedVideoChunk;
  globalThis.EncodedAudioChunk = FakeEncodedAudioChunk;
  globalThis.AudioEncoder = FakeAudioEncoder;
  globalThis.AudioData = FakeAudioData;
  globalThis.OffscreenCanvas = FakeCanvas;
}

function removeStubs() {
  delete globalThis.VideoEncoder;
  delete globalThis.VideoFrame;
  delete globalThis.EncodedVideoChunk;
  delete globalThis.EncodedAudioChunk;
  delete globalThis.AudioEncoder;
  delete globalThis.AudioData;
  delete globalThis.OffscreenCanvas;
}

/** 只实现 exporter 用到字段的 AudioBuffer。 */
function makeAudioBuffer({ sampleRate = 48000, duration = 0.5, numberOfChannels = 2 } = {}) {
  const length = Math.round(sampleRate * duration);
  const channels = [];
  for (let ch = 0; ch < numberOfChannels; ch += 1) {
    channels.push(new Float32Array(length));
  }
  return {
    sampleRate,
    length,
    duration,
    numberOfChannels,
    getChannelData: (ch) => channels[ch],
  };
}

const HEVC_CODEC = 'hvc1.1.6.L93.B0';

console.log('导出管线按计划执行');

await check('⑰ plan=HEVC+AAC：编码器用 hvc1.*，容器 mp4，结果带 audioCodec=aac', async () => {
  installStubs({ video: [HEVC_CODEC], audio: ['mp4a.40.2'] });
  try {
    const plan = chooseExportPlan(THIS_MACHINE);
    const progress = [];
    const result = await exportTimeline({
      drawFrame() {},
      duration: 0.5,
      fps: 10,
      width: 64,
      height: 64,
      plan,
      audioBuffer: makeAudioBuffer({ duration: 0.5 }),
      onProgress: (p) => progress.push(p),
    });

    const encoder = FakeVideoEncoder.instances[FakeVideoEncoder.instances.length - 1];
    assert(encoder, '没有创建 VideoEncoder');
    assert(encoder.config.codec === HEVC_CODEC, 'encoder.codec=' + encoder.config.codec);
    assert(encoder.config.width === 64 && encoder.config.height === 64, '尺寸=' + encoder.config.width + 'x' + encoder.config.height);
    assert(FakeVideoEncoder.supportQueries.some((q) => q.codec === HEVC_CODEC), '没有按计划复检 HEVC');

    const audioEncoder = FakeAudioEncoder.instances[0];
    assert(audioEncoder && audioEncoder.config.codec === 'mp4a.40.2', 'AAC 没配上');

    assert(result.container === 'mp4', 'container=' + result.container);
    assert(result.codec === HEVC_CODEC, 'result.codec=' + result.codec);
    assert(result.audioCodec === 'aac', 'result.audioCodec=' + result.audioCodec);
    assert(result.blob.type === 'video/mp4', 'blob.type=' + result.blob.type);
    assert(result.blob.size > 0, 'blob 为空');
    assert(result.frames === 5, 'frames=' + result.frames);
    assert(progress[progress.length - 1].phase === 'done', '末次进度=' + JSON.stringify(progress[progress.length - 1]));
  } finally {
    removeStubs();
  }
});

await check('⑱ plan 为无音轨：完全不碰 AudioEncoder，结果 audioCodec=null', async () => {
  installStubs({ video: ['avc1.42001f'], audio: ['mp4a.40.2', 'opus'] });
  try {
    const plan = chooseExportPlan(capsOf({ h264: true }, {}));
    const progress = [];
    const result = await exportTimeline({
      drawFrame() {},
      duration: 0.5,
      fps: 10,
      width: 64,
      height: 64,
      plan,
      audioBuffer: makeAudioBuffer({ duration: 0.5 }),
      onProgress: (p) => progress.push(p),
    });

    assert(FakeAudioEncoder.instances.length === 0, '不该创建 AudioEncoder');
    assert(FakeAudioEncoder.supportQueries === 0, '不该探测 AudioEncoder');
    assert(!progress.some((p) => p.phase === 'audio'), '不该有 audio 阶段');
    assert(result.audioCodec === null, 'result.audioCodec=' + result.audioCodec);
    assert(result.audioWarning === 'NO_AUDIO_CODEC', 'audioWarning=' + result.audioWarning);
    assert(result.container === 'mp4', 'container=' + result.container);
    assert(!('audioBytes' in result), '不该有 audioBytes');
    assert(result.blob.size > 0, '视频应当照常导出');
  } finally {
    removeStubs();
  }
});

await check('⑲ 计划里的编码器实测不可用 → 画第一帧之前就抛 NO_ENCODER', async () => {
  installStubs({ video: [], audio: ['mp4a.40.2'] });
  try {
    let draws = 0;
    let err = null;
    try {
      await exportTimeline({
        drawFrame() {
          draws += 1;
        },
        duration: 1,
        fps: 10,
        width: 64,
        height: 64,
        plan: chooseExportPlan(THIS_MACHINE),
      });
    } catch (e) {
      err = e;
    }
    assert(err, '应当抛错');
    assert(err.code === 'NO_ENCODER', 'code=' + (err && err.code));
    assert(err.message.includes(HEVC_CODEC), '说明里没提具体编码：' + err.message);
    assert(draws === 0, '在失败前已经画了 ' + draws + ' 帧');
    assert(FakeVideoEncoder.instances.length === 0, '不该创建编码器');
  } finally {
    removeStubs();
  }
});

await check('⑳ 只给 caps（没有 plan）时也走 HEVC，返回结构与计划驱动一致', async () => {
  installStubs({ video: [HEVC_CODEC], audio: ['mp4a.40.2'] });
  try {
    const result = await exportTimeline({
      drawFrame() {},
      duration: 0.4,
      fps: 10,
      width: 64,
      height: 64,
      caps: THIS_MACHINE,
      audioBuffer: makeAudioBuffer({ duration: 0.4 }),
    });
    assert(result.container === 'mp4', 'container=' + result.container);
    assert(result.codec === HEVC_CODEC, 'codec=' + result.codec);
    assert(result.audioCodec === 'aac', 'audioCodec=' + result.audioCodec);
    assert(result.frames === 4, 'frames=' + result.frames);
  } finally {
    removeStubs();
  }
});

await check('㉑ HEVC 编码器不给 hvcC 描述 → 第一帧就失败（ENCODER_INCOMPLETE），不等到封装收尾', async () => {
  installStubs({ video: [HEVC_CODEC], audio: ['mp4a.40.2'] });
  FakeVideoEncoder.omitDescription = true;
  try {
    let draws = 0;
    let err = null;
    try {
      await exportTimeline({
        drawFrame() {
          draws += 1;
        },
        duration: 0.5,
        fps: 10,
        width: 64,
        height: 64,
        plan: chooseExportPlan(THIS_MACHINE),
      });
    } catch (e) {
      err = e;
    }
    assert(err, '应当抛错');
    assert(err.code === 'ENCODER_INCOMPLETE', 'code=' + (err && err.code));
    assert(err.message.includes('HEVC') && err.message.includes('hvcC'), 'message=' + (err && err.message));
    assert(draws === 1, '应当在第一帧后立刻失败，实际画了 ' + draws + ' 帧');
  } finally {
    removeStubs();
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
