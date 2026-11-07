/**
 * 编码能力探测 + 导出组合决策（纯函数，可注入）。
 *
 * 为什么单独一层：这台机器（Intel GPU + Chrome）**没有 H.264 编码器**，
 * HEVC / VP9 / AV1 / AAC / Opus 都有。以前导出只在运行时按「H.264 → VP9」的
 * 硬编码顺序试，用户点的是「导出 MP4」，最后拿到 WebM；更糟的是有些路径要等到
 * 开始写帧才发现选不出编码器，进度条走到 90% 才失败。
 *
 * 现在把「这台机器能编什么」（probeEncoders）和「因此该导出什么」（chooseExportPlan）
 * 拆成两个纯函数：表单打开时先探一次，把结论原样告诉用户
 *（「将导出：MP4 / HEVC / AAC（本机不支持 H.264，已自动改用 HEVC）」）；
 * 导出端照着同一份结论配置编码器与封装器，不再二次猜。
 *
 * 这一层不碰 DOM、不碰 canvas、不 import 任何 muxer —— Node 里可以直接测。
 */

/** 每一族视频编码的 WebCodecs codec 字串，顺序即探测顺序（HEVC 优先 hvc1）。 */
export const VIDEO_CANDIDATES = {
  h264: ['avc1.42001f'],
  // hvc1 优先：mp4-muxer 的 HEVC 采样项写的是 hvc1，先用实测通过的那个更稳
  hevc: ['hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0'],
  vp9: ['vp09.00.10.08'],
  av1: ['av01.0.08M.08'],
};

/** 音频编码的 WebCodecs codec 字串。 */
export const AUDIO_CANDIDATES = {
  aac: 'mp4a.40.2', // AAC-LC
  opus: 'opus',
};

export const VIDEO_LABELS = { h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1' };
export const AUDIO_LABELS = { aac: 'AAC', opus: 'Opus' };
export const CONTAINER_LABELS = { mp4: 'MP4', webm: 'WebM' };

/** 探测用的配置形状；分辨率/帧率只影响 isConfigSupported 的答案，不影响编码器存在性。 */
export const PROBE_SHAPE = { width: 1920, height: 1080, framerate: 30, bitrate: 8_000_000 };
const PROBE_AUDIO = { sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 };

/** 探测/决策层自己的错误；带上 code，交给 exporter 转成 ExportError。 */
export class CodecError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CodecError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * 探测当前环境能编哪些格式。任何一次 isConfigSupported 失败/抛错都只当作
 * 「这一项不支持」，绝不把异常抛给上层 —— 探测失败不是导出失败。
 *
 * @param {object} [options]
 * @param {typeof VideoEncoder} [options.VideoEncoder] 注入用（测试/特殊运行时）
 * @param {typeof AudioEncoder} [options.AudioEncoder]
 * @param {number} [options.width] 探测用宽度
 * @param {number} [options.height]
 * @param {number} [options.framerate]
 * @param {number} [options.bitrate]
 * @returns {Promise<{video: {h264: ProbeEntry, hevc: ProbeEntry, vp9: ProbeEntry, av1: ProbeEntry},
 *   audio: {aac: ProbeEntry, opus: ProbeEntry}}>}
 *   ProbeEntry = {supported: boolean, reason?: string, codec?: string}（codec 为实测通过的字串）
 */
export async function probeEncoders(options = {}) {
  const videoEncoder = options.VideoEncoder !== undefined ? options.VideoEncoder : globalThis.VideoEncoder;
  const audioEncoder = options.AudioEncoder !== undefined ? options.AudioEncoder : globalThis.AudioEncoder;
  const shape = {
    width: positiveNumber(options.width, PROBE_SHAPE.width),
    height: positiveNumber(options.height, PROBE_SHAPE.height),
    framerate: positiveNumber(options.framerate, PROBE_SHAPE.framerate),
    bitrate: positiveNumber(options.bitrate, PROBE_SHAPE.bitrate),
  };

  const video = {};
  for (const family of Object.keys(VIDEO_CANDIDATES)) {
    video[family] = await probeVideoFamily(videoEncoder, family, shape);
  }
  const audio = {};
  for (const family of Object.keys(AUDIO_CANDIDATES)) {
    audio[family] = await probeAudioFamily(audioEncoder, family);
  }
  return { video, audio };
}

async function probeVideoFamily(encoder, family, shape) {
  const codecs = VIDEO_CANDIDATES[family];
  if (!encoder) return { supported: false, reason: '浏览器没有 VideoEncoder' };
  if (typeof encoder.isConfigSupported !== 'function') {
    return { supported: false, reason: 'VideoEncoder 没有 isConfigSupported' };
  }
  let thrown = null;
  for (const codec of codecs) {
    try {
      const result = await encoder.isConfigSupported({
        codec,
        width: shape.width,
        height: shape.height,
        bitrate: shape.bitrate,
        framerate: shape.framerate,
      });
      if (result && result.supported === true) return { supported: true, codec };
    } catch (err) {
      thrown = err;
    }
  }
  if (thrown) return { supported: false, reason: 'isConfigSupported 抛错：' + errorText(thrown) };
  return { supported: false, reason: `isConfigSupported(${codecs.join(' / ')}) 都返回 supported: false` };
}

async function probeAudioFamily(encoder, family) {
  const codec = AUDIO_CANDIDATES[family];
  if (!encoder) return { supported: false, reason: '浏览器没有 AudioEncoder' };
  if (typeof encoder.isConfigSupported !== 'function') {
    return { supported: false, reason: 'AudioEncoder 没有 isConfigSupported' };
  }
  try {
    const result = await encoder.isConfigSupported({ codec, ...PROBE_AUDIO });
    if (result && result.supported === true) return { supported: true, codec };
  } catch (err) {
    return { supported: false, reason: 'isConfigSupported 抛错：' + errorText(err) };
  }
  return { supported: false, reason: `isConfigSupported(${codec}) 返回 supported: false` };
}

/**
 * 按能力挑导出组合（纯函数、无 DOM）。
 *
 * 优先级：
 *   1. MP4 / H.264 + AAC（首选）
 *   2. MP4 / HEVC + AAC（本机走这条：没有 H.264 编码器）
 *   3. WebM / VP9 或 AV1 + Opus
 *   4. 有视频、没有能配得上的音轨 → 无音轨导出（reason 写明原因）
 *   5. 连视频编码器都没有 → 抛 NO_ENCODER（中文说明）
 *
 * @param {{video?: object, audio?: object}} caps probeEncoders 的结果
 * @returns {{container: 'mp4'|'webm', videoCodec: string, codec: string,
 *   audioCodec: 'aac'|'opus'|null, reason: string}}
 * @throws {CodecError} code=NO_ENCODER
 */
export function chooseExportPlan(caps) {
  if (hasVideo(caps, 'h264') && hasAudio(caps, 'aac')) {
    return makePlan(caps, { container: 'mp4', video: 'h264', audio: 'aac', reason: '首选组合：H.264 与 AAC 都支持' });
  }
  if (hasVideo(caps, 'hevc') && hasAudio(caps, 'aac')) {
    return makePlan(caps, { container: 'mp4', video: 'hevc', audio: 'aac', reason: '本机不支持 H.264，已自动改用 HEVC' });
  }
  for (const video of ['vp9', 'av1']) {
    if (hasVideo(caps, video) && hasAudio(caps, 'opus')) {
      const missing = [];
      if (!hasVideo(caps, 'h264')) missing.push('H.264');
      if (!hasVideo(caps, 'hevc')) missing.push('HEVC');
      if (!hasAudio(caps, 'aac')) missing.push('AAC');
      const reason = missing.length
        ? `本机缺少 ${joinCn(missing)}，MP4 组合不成立`
        : 'MP4 组合不可用，改用 WebM';
      return makePlan(caps, { container: 'webm', video, audio: 'opus', reason });
    }
  }

  // 视频有、音轨配不上：宁可落地一个无声视频，也不假装能带声音
  const videoOnly = [
    ['mp4', 'h264'],
    ['mp4', 'hevc'],
    ['webm', 'vp9'],
    ['webm', 'av1'],
  ].find(([, family]) => hasVideo(caps, family));
  if (videoOnly) {
    return makePlan(caps, {
      container: videoOnly[0],
      video: videoOnly[1],
      audio: null,
      reason: audioGap(videoOnly[0], caps),
    });
  }

  throw new CodecError(
    'NO_ENCODER',
    '当前浏览器没有可用的视频编码器：H.264 / HEVC / VP9 / AV1 全部不可用，无法导出视频。' +
      '请确认浏览器版本支持 WebCodecs，或在支持硬件编码的机器上重试。',
    { video: (caps && caps.video) || null },
  );
}

/**
 * 把组合翻译成给用户看的一行真实格式预告。
 * 例：将导出：MP4 / HEVC / AAC（本机不支持 H.264，已自动改用 HEVC）
 */
export function describePlan(plan) {
  if (!plan || !plan.container) return '将导出：未知格式';
  const parts = [
    CONTAINER_LABELS[plan.container] || String(plan.container),
    VIDEO_LABELS[plan.videoCodec] || String(plan.videoCodec),
    plan.audioCodec ? AUDIO_LABELS[plan.audioCodec] || String(plan.audioCodec) : '无音轨',
  ];
  const reason = typeof plan.reason === 'string' ? plan.reason.trim() : '';
  return '将导出：' + parts.join(' / ') + (reason ? '（' + reason + '）' : '');
}

// ------------------------------------------------------------------ 内部 ----

function makePlan(caps, { container, video, audio, reason }) {
  return {
    container,
    videoCodec: video,
    codec: codecStringOf(caps, video),
    audioCodec: audio,
    reason,
  };
}

function codecStringOf(caps, family) {
  const entry = caps && caps.video ? caps.video[family] : null;
  if (entry && typeof entry.codec === 'string' && entry.codec) return entry.codec;
  return VIDEO_CANDIDATES[family][0];
}

function hasVideo(caps, family) {
  return !!(caps && caps.video && caps.video[family] && caps.video[family].supported === true);
}

function hasAudio(caps, family) {
  return !!(caps && caps.audio && caps.audio[family] && caps.audio[family].supported === true);
}

/** 「A、B 与 C」：中文的并列收尾。 */
function joinCn(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return items[0] + ' 与 ' + items[1];
  return items.slice(0, -1).join('、') + ' 与 ' + items[items.length - 1];
}

function audioGap(container, caps) {
  const aac = hasAudio(caps, 'aac');
  const opus = hasAudio(caps, 'opus');
  if (!aac && !opus) return 'AAC 与 Opus 都不可用，将导出无音轨视频';
  if (container === 'mp4' && !aac) return 'AAC 不可用，Opus 装不进 MP4，将导出无音轨视频';
  if (container === 'webm' && !opus) return 'Opus 不可用，AAC 装不进 WebM，将导出无音轨视频';
  return '没有能配上的音轨编码器，将导出无音轨视频';
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function errorText(err) {
  return (err && (err.message || err.name)) || String(err);
}
