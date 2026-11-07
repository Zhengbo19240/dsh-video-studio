/**
 * 时间线导出：把调用方逐帧画好的画布编码成可下载的视频文件。
 *
 * 只依赖 WebCodecs（VideoEncoder / AudioEncoder / VideoFrame / AudioData）、2D canvas 和两个 muxer 库。
 * 不读回像素、不产生临时 DOM、不持有全局状态；同一个函数可被并发调用。
 *
 * 导出组合由 codec-caps.mjs 的能力探测决定：MP4 / H.264 + AAC → MP4 / HEVC + AAC
 * → WebM / VP9 或 AV1 + Opus → 无音轨；连视频编码器都没有时才抛 NO_ENCODER。
 * 表单在打开时就探一次能力并把结论写给用户看，所以「导出到 90% 才发现编码器缺失」
 * 不会再发生；这里只负责照着同一份计划配置编码器与封装器。
 * 传入 audioBuffer 时顺带封装音轨（MP4=AAC-LC，WebM=Opus）；音频环节的问题一律降级为无音轨。
 *
 * 关于「混音纪律」的边界（别把逻辑放错地方）：
 *   ducking 与响度归一是**逐片段的**，必须在还能看到 voice/music 分段时做，
 *   也就是 src/client/audio.js 的 scheduleSegment / mixdown —— 预览与导出共用它，
 *   所以「预览听到的」等于「导出的」。
 *   这里拿到的 audioBuffer 已经是混好的立体声，音乐与人声不可再分离，
 *   在导出端做逐片段增益只会把预览和成片拉开差距，因此这里不做。
 *   导出端只做一件相关的事：报告整轨的近似响度（audioLufs），方便 agent 核对纪律是否生效。
 */

import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer';
import { integratedLoudnessApprox, EXPORT_PEAK_CEILING } from '../audio-mix.mjs';
import { VIDEO_CANDIDATES, chooseExportPlan } from './codec-caps.mjs';

// 导出帧率的合法上限。时间线是纯时间驱动的，导出可以独立选帧率；
// 120 是实用上限（再高只会让编码器排队，不会多出信息）。
export const MAX_EXPORT_FPS = 120;

// 运行时回退链：计划里的编码器实测不可用时，按这个顺序继续试（可用者为准）。
// 表单的 chooseExportPlan 先挑一次；这里是在「开编码器」那一刻的最后一次实测，
// 两步用的是同一套家族，所以「表单说 HEVC、导出也说 HEVC」是同一句话。
const FALLBACK_CHOICES = [
  { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac' },
  { container: 'mp4', videoCodec: 'hevc', audioCodec: 'aac' },
  { container: 'webm', videoCodec: 'vp9', audioCodec: 'opus' },
  { container: 'webm', videoCodec: 'av1', audioCodec: 'opus' },
];

// 容器 → 能装的视频编码（家族名 → muxer 侧 codec 名）。
// mp4-muxer 认 avc/hevc/vp9/av1；webm-muxer 认 Matroska CodecID（V_VP9 / V_AV1）。
const MUXER_VIDEO_CODECS = {
  mp4: { h264: 'avc', hevc: 'hevc', vp9: 'vp9', av1: 'av1' },
  webm: { vp9: 'V_VP9', av1: 'V_AV1' },
};

// 容器能装的音轨：MP4 只有 AAC（或不要音轨），WebM 只有 Opus（或不要音轨）
const CONTAINER_AUDIO = { mp4: ['aac', null], webm: ['opus', null] };

// 真实的依赖检查：webm-muxer 不在时只允许 mp4 分支，绝不假装能导 WebM
const WEBM_AVAILABLE = typeof WebmMuxer === 'function' && typeof WebmTarget === 'function';

// 音轨：音轨编码 → WebCodecs codec / 对外的名字 / 封装器 codec / 每块的帧数
const AUDIO_TARGETS = {
  aac: { codec: 'mp4a.40.2', name: 'aac', muxerCodec: 'aac', chunkFrames: 1024 }, // AAC-LC
  opus: { codec: 'opus', name: 'opus', muxerCodec: 'A_OPUS', chunkFrames: 960 }, // 20ms @ 48k
};

const MIME = { mp4: 'video/mp4', webm: 'video/webm' };
const MAX_QUEUE = 8; // 编码队列上限（帧）
const QUEUE_POLL_MS = 4; // 背压轮询间隔
const KEYFRAME_SECONDS = 2; // 关键帧间隔

const AUDIO_SAMPLE_RATE = 48000; // 音轨固定 48k
const AUDIO_CHANNELS = 2;
const AUDIO_BITRATE = 128_000;
const MAX_AUDIO_QUEUE = 16; // 音频编码队列上限

// 导出参数的合法区间：超出一律 INVALID_ARG（中文提示），不让畸形值落进编码器
export const MIN_BITRATE_KBPS = 100;
export const MAX_BITRATE_KBPS = 50_000;
const MAX_DIMENSION = 8192;

/** 结构化的导出错误；用 code 区分原因。 */
export class ExportError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * 把时间线编码为视频文件。
 *
 * @param {object} opts
 * @param {(ctx: CanvasRenderingContext2D, t: number, w: number, h: number) => void|Promise<void>} opts.drawFrame
 *        在 t 秒处把一帧画到 2D canvas（由调用方负责素材解码与图层合成）；t 是时间线时间
 * @param {number} opts.duration 时间线总时长（秒）；给了 range 时它仍是全片时长
 * @param {number} [opts.fps=30] 导出帧率；与 projectFps 不同即按比例抽帧/补帧
 * @param {number} [opts.projectFps] 工程帧率（默认等于 fps），只用于计算抽帧比例
 * @param {number} opts.width 输出宽度（内部向上取偶）
 * @param {number} opts.height 输出高度（内部向上取偶）
 * @param {number} [opts.bitrateKbps] 视频码率（kbps）；不给则按像素×帧率估算
 * @param {{start:number, end:number}} [opts.range] 只导这段（时间线时间，秒）
 * @param {string} [opts.title] 文件名标题
 * @param {AudioBuffer} [opts.audioBuffer] 可选音轨；仅取前两声道，内部重采样到 48k
 * @param {{container:'mp4'|'webm', videoCodec:string, codec:string, audioCodec:'aac'|'opus'|null, reason?:string}} [opts.plan]
 *        已经探测并展示给用户的导出计划（优先于 caps）：导出端照它配置编码器与封装器
 * @param {object} [opts.caps] probeEncoders() 的结果；没给 plan 时据此现选一份计划
 * @param {(p: {phase: string, ratio: number, message?: string}) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{blob: Blob, fileName: string, container: 'mp4'|'webm', codec: string, frames: number, ms: number,
 *   audioBytes?: number, audioCodec?: 'aac'|'opus'|null, audioWarning?: string}>}
 */
export async function exportTimeline(opts = {}) {
  const startedAt = Date.now();
  const { drawFrame, title, onProgress, signal } = opts;
  const audioBuffer = opts.audioBuffer;

  if (typeof drawFrame !== 'function') throw new ExportError('INVALID_ARG', 'drawFrame 必须是函数');
  const plan = planExport(opts);
  const { width, height, fps, totalFrames, range } = plan;

  if (signal && signal.aborted) throw new ExportError('ABORTED', '导出已取消');
  emit(onProgress, 'setup', 0, '检测编码器');

  // 编码器在画第一帧之前定死：计划优先，但计划里的编码器若在这台机器上实测不可用，
  // 就沿 H.264 → HEVC → VP9/AV1 的回退链继续试，而不是把「计划过期」当成导出失败。
  // 只有整条链都不可用时才是 NO_ENCODER —— 那才是真的错误。
  const { picked, fallback } = await resolveEncoder(plan, width, height, plan.bitrate);

  // 音轨编码由计划决定；老路径按容器（mp4→AAC，webm→Opus）
  const audioCodec = picked.audioCodec !== undefined ? picked.audioCodec : picked.container === 'mp4' ? 'aac' : 'opus';

  // 音频先探测并准备数据；任何问题都降级为无音轨，不中断视频导出
  let audioPlan = null;
  let audioWarning = null;
  if (audioBuffer !== undefined && audioBuffer !== null) {
    if (audioCodec) {
      try {
        const prepared = await prepareAudio(audioBuffer, audioCodec, plan);
        audioPlan = prepared.plan;
        // 峰值被压时也要让调用方看见；其它警告优先（它们更接近「没有音轨」）
        audioWarning = prepared.warning || audioWarning;
      } catch {
        audioPlan = null;
        audioWarning = 'INVALID_AUDIO_BUFFER';
      }
    } else {
      // 计划里就是「无音轨」：不碰音频编码器，但把这件事明确写进结果
      audioWarning = 'NO_AUDIO_CODEC';
    }
  }

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new ExportError('NO_CANVAS', '当前环境无法创建 2D 画布');

  let muxer = null;
  let muxTarget = null;
  let videoEncoder = null;
  let audioEncoder = null;
  let videoError = null;
  let audioError = null;
  let muxError = null;
  let audioBytes = 0;
  // 第一块视频数据必须带 avcC / hvcC 描述，否则 mp4-muxer 要等到 finalize 才炸 ——
  // 那正是「导出到 90% 才发现装不出来」。这里在第一块就判定，立刻失败并说清原因。
  let firstVideoChunk = true;

  // 音频块先缓存，等视频帧推进到同一时间点再写（WebM 的块必须按时间交错，否则会丢块）
  const pendingAudio = [];
  let audioCursor = 0;

  const drainAudio = (limitUs) => {
    while (audioCursor < pendingAudio.length) {
      const item = pendingAudio[audioCursor];
      if (limitUs !== undefined && item.chunk.timestamp > limitUs) break;
      audioCursor += 1;
      try {
        muxer.addAudioChunk(item.chunk, item.meta);
        audioBytes += item.chunk.byteLength || 0;
      } catch (err) {
        audioError = audioError || err;
        break;
      }
    }
  };

  // 视频块和音频块走同一个 output 回调，按块类型分派
  const handleOutput = (chunk, meta) => {
    if (isAudioChunk(chunk)) {
      pendingAudio.push({ chunk, meta });
      return;
    }
    if (firstVideoChunk) {
      firstVideoChunk = false;
      if (picked.container === 'mp4' && isHevcCodec(picked.codec) && !hasCodecDescription(meta)) {
        muxError = new ExportError(
          'ENCODER_INCOMPLETE',
          '这台机器的 HEVC 编码器没有给出 hvcC 解码配置，MP4 封装器要到收尾时才会发现，装不出来。' +
            '换一台支持完整 WebCodecs HEVC 编码的机器，或改用 WebM（VP9 / AV1）。',
        );
        return;
      }
    }
    try {
      muxer.addVideoChunk(chunk, meta);
    } catch (err) {
      muxError = muxError || err;
    }
  };

  try {
    // 音频编码器在 muxer 之前建立：这一步失败时还没声明音轨，可以干净地降级
    if (audioPlan) {
      try {
        audioEncoder = new AudioEncoder({
          output: handleOutput,
          error: (err) => {
            audioError = audioError || err;
          },
        });
        audioEncoder.configure(audioPlan.config);
      } catch {
        closeQuietly(audioEncoder);
        audioEncoder = null;
        audioPlan = null;
        audioWarning = 'NO_AUDIO_ENCODER';
      }
    }

    const created = createMuxer(picked, width, height, fps, audioPlan);
    muxer = created.muxer;
    muxTarget = created.target;

    // 进度用全局工作量（音频块 + 视频帧）作分母，保证 ratio 单调不减
    const audioChunks = audioPlan ? audioPlan.totalChunks : 0;
    const totalUnits = totalFrames + audioChunks;

    videoEncoder = new VideoEncoder({
      output: handleOutput,
      error: (err) => {
        videoError = videoError || err;
      },
    });
    videoEncoder.configure(picked.config);

    if (audioPlan) {
      try {
        emit(onProgress, 'audio', 0, '编码音轨');
        const { chunkFrames, frames } = audioPlan;
        for (let offset = 0, index = 0; offset < frames; offset += chunkFrames, index += 1) {
          if (audioError) break;
          throwIfAborted(signal, videoEncoder, audioEncoder);

          const count = Math.min(chunkFrames, frames - offset);
          const audioData = new AudioData({
            format: 'f32-planar',
            sampleRate: AUDIO_SAMPLE_RATE,
            numberOfFrames: count,
            numberOfChannels: AUDIO_CHANNELS,
            timestamp: Math.round((offset / AUDIO_SAMPLE_RATE) * 1e6),
            data: readPlanarBlock(audioPlan, offset, count),
          });
          try {
            audioEncoder.encode(audioData);
          } finally {
            audioData.close();
          }

          emit(onProgress, 'audio', (index + 1) / totalUnits);

          while (audioEncoder.encodeQueueSize > MAX_AUDIO_QUEUE) {
            throwIfAborted(signal, videoEncoder, audioEncoder);
            if (audioError) break;
            await sleep(QUEUE_POLL_MS);
          }
        }

        // 先把音频编码器冲干净，拿到全部编码块，才能与视频帧按时间交错写入
        await audioEncoder.flush();
      } catch (err) {
        // 中止要照常上抛；其余音频问题只降级，不打断视频导出
        if (err && err.code === 'ABORTED') throw err;
        audioError = audioError || err;
      }
      closeQuietly(audioEncoder);
      audioEncoder = null;
      if (audioError && !audioWarning) audioWarning = 'AUDIO_ENCODE_FAILED';
    }

    const keyInterval = Math.max(1, Math.round(fps * KEYFRAME_SECONDS));
    const frameDuration = Math.max(1, Math.round(1e6 / fps));

    for (let i = 0; i < totalFrames; i += 1) {
      throwIfAborted(signal, videoEncoder, audioEncoder);
      if (videoError) throw videoError;
      if (muxError) throw muxError;

      // 每帧都必须重画，不做跳帧；t 是时间线时间，range 起点直接体现在这里，
      // 所以 fps 与工程不同时，抽出来的就是「按比例」的源帧（sampleStep = projectFps / fps）。
      const t = range.start + i / fps;
      await drawFrame(ctx, t, width, height);

      throwIfAborted(signal, videoEncoder, audioEncoder);

      // 先写入不晚于本帧的音频块，让两条轨在容器里按时间交错
      drainAudio(Math.round((i * 1e6) / fps));

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((i * 1e6) / fps),
        duration: frameDuration,
      });
      try {
        videoEncoder.encode(frame, { keyFrame: i % keyInterval === 0 });
      } finally {
        frame.close();
      }

      emit(onProgress, 'encode', (audioChunks + i) / totalUnits);

      // 背压：队列超过上限就让出主线程，避免堆几百帧内存
      while (videoEncoder.encodeQueueSize > MAX_QUEUE) {
        throwIfAborted(signal, videoEncoder, audioEncoder);
        if (videoError) throw videoError;
        await sleep(QUEUE_POLL_MS);
      }
    }

    emit(onProgress, 'finalize', 1, '写入容器');

    // 音轨已 flush/close；这里补写剩余音频块，再冲干净视频编码器，最后才 finalize 容器
    drainAudio();
    await videoEncoder.flush();
    if (videoError) throw videoError;
    if (muxError) throw muxError;

    closeQuietly(videoEncoder);
    videoEncoder = null;
    muxer.finalize();
  } catch (err) {
    closeQuietly(audioEncoder);
    audioEncoder = null;
    closeQuietly(videoEncoder);
    videoEncoder = null;
    throw normalizeError(err);
  }

  const buffer = muxTarget.buffer;
  if (!buffer || buffer.byteLength === 0) throw new ExportError('ENCODE_FAILED', '封装器没有产出数据');

  const blob = new Blob([buffer], { type: MIME[picked.container] });
  const fileName = buildFileName(title, picked.container);
  emit(onProgress, 'done', 1, '导出完成');

  const result = {
    blob,
    fileName,
    container: picked.container,
    codec: picked.codec,
    // 实际用的编码家族（h264 / hevc / vp9 / av1）—— codec 是 WebCodecs 字串，
    // 这个字段给「事后确认到底用了哪个编码器」用。
    videoCodec: picked.videoCodec || '',
    fps: plan.fps,
    sourceFps: plan.projectFps,
    duration: plan.duration,
    frames: totalFrames,
    ms: Date.now() - startedAt,
  };
  // 计划里的编码器在实测时没通过、回退链换了别的：这不是错误，是信息。
  if (fallback) result.encoderFallback = fallback;
  if (audioPlan) {
    result.audioBytes = audioBytes;
    result.audioCodec = audioPlan.name;
    // 峰值诊断：audioPeak 是「压之前」的实测值，方便 agent 判断原始混音是否过载。
    if (Number.isFinite(audioPlan.peak)) {
      result.audioPeak = Math.round(audioPlan.peak * 1000) / 1000;
    }
    if (audioPlan.trimmed) {
      result.audioPeakAfterTrim = Math.round(audioPlan.peakAfterTrim * 1000) / 1000;
      result.audioTrimDb = Math.round(20 * Math.log10(audioPlan.trimGain) * 10) / 10;
    }
    // 近似响度（非 EBU R128），保留 0.1；纯静音时不写这个字段
    if (audioPlan.lufs != null && Number.isFinite(audioPlan.lufs)) {
      result.audioLufs = Math.round(audioPlan.lufs * 10) / 10;
    }
  } else if (plan.output) {
    // 计划驱动时把「这条成片没有音轨」明确写出来；老路径保持原字段形状
    result.audioCodec = null;
  }
  if (audioWarning) result.audioWarning = audioWarning;
  return result;
}

// ------------------------------------------------------------------ 音频轨 ----

/**
 * 探测并准备音轨数据。返回 { plan, warning }，plan 为 null 时按无音轨导出。
 * 这里只做纯读取、重采样与「峰值 headroom」，不碰编码器。
 *
 * plan 里带 range：音轨按导出区间裁剪（offset = range.start 对应的采样数），
 * 否则「导出一段」的成片里声音会比画面早 —— 唯一正确的做法是在这里对齐。
 *
 * 导出（供测试与上层核对）：峰值超过 EXPORT_PEAK_CEILING 时整体压到 ceiling 以内，
 * plan.trimmed / plan.peak / plan.peakAfterTrim 如实记录；warning 为 AUDIO_PEAK_TRIMMED。
 */
export async function prepareAudio(audioBuffer, audioCodec, plan) {
  const target = AUDIO_TARGETS[audioCodec];
  if (!target || !isAudioBufferLike(audioBuffer)) return { plan: null, warning: 'INVALID_AUDIO_BUFFER' };
  if (!hasAudioEncoder()) return { plan: null, warning: 'NO_AUDIO_ENCODER' };

  const config = {
    codec: target.codec,
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfChannels: AUDIO_CHANNELS,
    bitrate: AUDIO_BITRATE,
  };
  if (!(await isAudioConfigSupported(config))) return { plan: null, warning: 'NO_AUDIO_ENCODER' };

  // 单声道复制成双声道，多声道只取前两路
  const srcRate = audioBuffer.sampleRate;
  const srcChannels = Math.min(AUDIO_CHANNELS, audioBuffer.numberOfChannels);
  let source = [];
  for (let ch = 0; ch < AUDIO_CHANNELS; ch += 1) {
    source.push(audioBuffer.getChannelData(Math.min(ch, srcChannels - 1)));
  }

  // 只取导出区间：offset 是 range.start 对应的 48k 采样偏移
  const offset = Math.round(Math.max(0, plan.range.start) * AUDIO_SAMPLE_RATE);
  const available = Math.max(0, audioBuffer.duration - plan.range.start);
  const byDuration = Math.round(Math.min(available, plan.duration) * AUDIO_SAMPLE_RATE);
  const byLength = Math.round((audioBuffer.length * AUDIO_SAMPLE_RATE) / srcRate) - offset;
  const frames = Math.max(0, Math.min(byDuration, byLength));
  if (!(frames > 0)) return { plan: null, warning: 'INVALID_AUDIO_BUFFER' };

  // 防削波：量「导出区间」的峰值，超过 ceiling 就整体乘一个常数增益压下来。
  // 选「压」而不是「只提示」，理由写在 docs/audio-mix.md：
  // 编码器对 >1 的采样只能截断，截断是失真且用户看不到；整体压不改变任何相对平衡。
  const peak = peakOfRange(source, srcRate, offset, frames);
  let trimmed = false;
  let trimGain = 1;
  let peakAfterTrim = peak;
  if (peak > EXPORT_PEAK_CEILING) {
    trimGain = EXPORT_PEAK_CEILING / peak;
    source = source.map((channel) => {
      const out = new Float32Array(channel.length);
      for (let i = 0; i < channel.length; i += 1) out[i] = channel[i] * trimGain;
      return out;
    });
    trimmed = true;
    peakAfterTrim = peak * trimGain;
  }

  // 整轨近似响度（非 EBU R128）：只用于核对「混音后是否还在同一档」，
  // 不做二次增益 —— 预览与导出必须走同一条增益曲线，导出端再改一次就不一致了。
  // 注意：它算的是整条音轨，不随 range 裁剪（诊断值，不是成片响度）。
  const lufs = integratedLoudnessApprox(source, srcRate);

  return {
    plan: {
      name: target.name,
      muxerCodec: target.muxerCodec,
      chunkFrames: target.chunkFrames,
      config,
      source,
      srcRate,
      offset,
      frames,
      totalChunks: Math.ceil(frames / target.chunkFrames),
      lufs: Number.isFinite(lufs) ? lufs : null,
      // 峰值诊断：peak 是压之前的实测峰值，peakAfterTrim 是实际送进编码器的峰值
      peak,
      peakAfterTrim,
      trimmed,
      trimGain,
    },
    warning: trimmed ? 'AUDIO_PEAK_TRIMMED' : null,
  };
}

/** 导出区间内的峰值（按源采样率取窗口；双声道取绝对值最大）。 */
function peakOfRange(channels, srcRate, offset48k, frames48k) {
  const start = Math.round((offset48k * srcRate) / AUDIO_SAMPLE_RATE);
  const count = Math.max(1, Math.round((frames48k * srcRate) / AUDIO_SAMPLE_RATE));
  let peak = 0;
  for (const channel of channels) {
    const end = Math.min(channel.length, start + count);
    for (let i = Math.max(0, start); i < end; i += 1) {
      const v = channel[i];
      if (!Number.isFinite(v)) continue;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
  }
  return peak;
}

function hasAudioEncoder() {
  return (
    typeof AudioEncoder === 'function' &&
    typeof AudioData === 'function' &&
    typeof AudioEncoder.isConfigSupported === 'function'
  );
}

async function isAudioConfigSupported(config) {
  try {
    const result = await AudioEncoder.isConfigSupported(config);
    return !!(result && result.supported);
  } catch {
    return false;
  }
}

function isAudioBufferLike(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof value.getChannelData === 'function' &&
    Number.isFinite(value.sampleRate) &&
    value.sampleRate > 0 &&
    Number.isFinite(value.length) &&
    value.length > 0 &&
    Number.isFinite(value.duration) &&
    value.duration > 0 &&
    Number.isInteger(value.numberOfChannels) &&
    value.numberOfChannels >= 1
  );
}

function isAudioChunk(chunk) {
  return typeof EncodedAudioChunk === 'function' && chunk instanceof EncodedAudioChunk;
}

/** 取一块立体声 planar f32 数据；源不是 48k 时做线性插值。offset 是导出区间的采样起点。 */
function readPlanarBlock(plan, blockOffset, frames) {
  const { source, srcRate } = plan;
  const start = (plan.offset || 0) + blockOffset;
  const out = new Float32Array(frames * AUDIO_CHANNELS);
  for (let ch = 0; ch < AUDIO_CHANNELS; ch += 1) {
    const src = source[ch];
    const base = ch * frames;
    if (srcRate === AUDIO_SAMPLE_RATE) {
      // 同采样率直接拷贝；末尾不足的部分由 Float32Array 默认的 0 填充
      const end = Math.min(start + frames, src.length);
      out.set(src.subarray(start, end), base);
      continue;
    }
    const step = srcRate / AUDIO_SAMPLE_RATE;
    const last = src.length - 1;
    for (let i = 0; i < frames; i += 1) {
      const pos = (start + i) * step;
      const i0 = Math.min(last, Math.floor(pos));
      const i1 = Math.min(last, i0 + 1);
      const frac = Math.min(1, Math.max(0, pos - i0));
      out[base + i] = src[i0] + (src[i1] - src[i0]) * frac;
    }
  }
  return out;
}

// ------------------------------------------------------------------ 编码器 ----

/**
 * 编码器回退链（纯参数整理，不碰编码器）。
 *
 * 计划里的那份排第一；之后按 H.264 → HEVC → VP9 → AV1 继续，
 * 最后再试一轮「无音轨」—— 视频能出来比整片失败好。
 * WebM 依赖缺失 / 容器装不下这类配置错误在这里直接跳过，不打断整条链。
 */
function encoderChoices(output) {
  const list = [];
  const seen = new Set();
  const add = (choice) => {
    let choiceNormalized;
    try {
      choiceNormalized = normalizeChoice(choice);
    } catch {
      return; // 这个容器/编码组合在此构建里不成立，跳到下一个
    }
    const key = choiceNormalized.container + '|' + choiceNormalized.codec + '|' + String(choiceNormalized.audioCodec);
    if (seen.has(key)) return;
    seen.add(key);
    list.push(choiceNormalized);
  };

  if (output) add(output);
  // 计划明确说「无音轨」时，回退也保持无音轨：不让一次回退偷偷改变用户看到的承诺
  const keepSilent = !!(output && output.audioCodec === null);
  for (const family of FALLBACK_CHOICES) {
    add({
      container: family.container,
      videoCodec: family.videoCodec,
      codec: (VIDEO_CANDIDATES[family.videoCodec] || [])[0],
      audioCodec: keepSilent ? null : family.audioCodec,
      reason: '',
    });
  }
  for (const family of FALLBACK_CHOICES) {
    add({
      container: family.container,
      videoCodec: family.videoCodec,
      codec: (VIDEO_CANDIDATES[family.videoCodec] || [])[0],
      audioCodec: null,
      reason: '音轨编码不可用，导出无音轨视频',
    });
  }
  return list;
}

/** 「MP4 / hvc1.1.6.L93.B0」——给用户和错误信息看的编码器名字。 */
function codecLabel(choice) {
  const container = String(choice.container || '').toUpperCase();
  const codec = choice.codec || (VIDEO_CANDIDATES[choice.videoCodec] || [])[0] || '';
  return container + ' / ' + codec;
}

function sameEncoder(a, b) {
  return !!a && !!b && a.container === b.container && a.codec === b.codec;
}

/**
 * 定下这次导出真正用的编码器。
 *
 * 计划优先；计划里的编码器实测不可用时沿回退链继续，返回实际用上的那个，
 * 并把「从谁换到谁」作为信息（fallback）带回结果。只有整条链都不可用才抛 NO_ENCODER。
 */
async function resolveEncoder(plan, width, height, bitrate) {
  const choices = encoderChoices(plan.output);
  const tried = [];
  for (const choice of choices) {
    const picked = await confirmChoice(choice, width, height, plan.fps, bitrate);
    if (picked) {
      const fallback =
        plan.output && !sameEncoder(plan.output, picked)
          ? {
              from: { container: plan.output.container, codec: plan.output.codec },
              to: { container: picked.container, codec: picked.codec },
              note:
                '计划里的 ' + codecLabel(plan.output) + ' 在这台机器上实测不可用，' +
                '已改用 ' + codecLabel(picked) + '；这不是错误，是编码器回退。',
            }
          : null;
      return { picked, fallback, tried };
    }
    tried.push(codecLabel(choice));
  }

  throw new ExportError(
    'NO_ENCODER',
    '这台机器没有可用的视频编码器：' + tried.join(' / ') + ' 都实测不可用。' +
      '只有 H.264 / HEVC / VP9 / AV1 全部走不通时才是这个错误；请换一个支持 WebCodecs 的浏览器，' +
      '或在有硬件编码的机器上重试。',
    { tried },
  );
}

async function isSupported(config) {
  try {
    const result = await VideoEncoder.isConfigSupported(config);
    return !!(result && result.supported);
  } catch {
    return false;
  }
}

/**
 * 对候选做一次实测（防御性复检）：能力表可能是几分钟前的，显卡/标签页状态会变。
 * 返回 null 表示这一档不可用，由 resolveEncoder 继续试下一档。
 */
async function confirmChoice(output, width, height, fps, bitrate) {
  if (output.container === 'webm' && !WEBM_AVAILABLE) return null;
  if (typeof VideoEncoder !== 'function' || typeof VideoFrame !== 'function') return null;
  if (typeof VideoEncoder.isConfigSupported !== 'function') return null;
  if (!Number.isFinite(bitrate) || bitrate <= 0) bitrate = estimateBitrate(width, height, fps);

  const base = { codec: output.codec, width, height, bitrate };
  // framerate 在 WebCodecs 里只是提示，但个别实现会把它当硬约束（>30 直接拒绝）；
  // 而同一台机器其实能编 60fps。先带提示试，失败再不带提示试一次，
  // 不把「提示被拒」误判成「编码器不存在」。
  let config = { ...base, framerate: fps };
  if (!(await isSupported(config))) {
    config = { ...base };
    if (!(await isSupported(config))) return null;
  }
  return {
    container: output.container,
    videoCodec: output.videoCodec,
    codec: output.codec,
    muxerCodec: output.muxerVideoCodec,
    audioCodec: output.audioCodec,
    config,
  };
}

/** 码率按像素与帧率粗估，限制在 0.8–16 Mbps。 */
function estimateBitrate(width, height, fps) {
  const raw = width * height * fps * 0.12;
  return Math.round(Math.min(16_000_000, Math.max(800_000, raw)));
}

/**
 * MP4 里的 HEVC 需要第一块数据带 hvcC 解码配置。缺了的话 mp4-muxer 要等到
 * finalize 才炸 —— 那正是「导出到 90% 才发现装不出来」。这里提前判定。
 * （H.264 的 avcC 是浏览器一直都会给的老路径，不在这个新守卫范围内。）
 */
function isHevcCodec(codec) {
  const text = String(codec || '');
  return text.startsWith('hvc1') || text.startsWith('hev1');
}

function hasCodecDescription(meta) {
  const description = meta && meta.decoderConfig ? meta.decoderConfig.description : undefined;
  return !!(description && description.byteLength > 0);
}

/** 建封装器；mp4-muxer 的 frameRate 要求正整数。 */
function createMuxer(picked, width, height, fps, audioPlan) {
  const frameRate = Math.max(1, Math.round(fps));
  const target = picked.container === 'mp4' ? new Mp4Target() : new WebmTarget();
  const video = { codec: picked.muxerCodec, width, height, frameRate };
  // webm-muxer 的 codec 是 Matroska CodecID（A_OPUS），mp4-muxer 用 'aac'
  const audio = audioPlan
    ? { codec: audioPlan.muxerCodec, numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE }
    : null;
  const muxer =
    picked.container === 'mp4'
      ? new Mp4Muxer({ target, video, ...(audio ? { audio } : {}), fastStart: 'in-memory' })
      : new WebmMuxer({ target, video, ...(audio ? { audio } : {}) });
  return { muxer, target };
}

// -------------------------------------------------------------------- 画布 ----

/** 优先 OffscreenCanvas；没有时退回 DOM canvas。 */
function createCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') {
    try {
      return new OffscreenCanvas(width, height);
    } catch {
      // 某些环境导出 OffscreenCanvas 却不可构造，继续兜底
    }
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new ExportError('NO_CANVAS', '当前环境既没有 OffscreenCanvas 也没有 document');
}

// ------------------------------------------------------------------ 小工具 ----

// ------------------------------------------------------------------ 规划 ----

/**
 * 把调用方的导出参数整理成一份明确的计划（纯函数，不碰编码器 / canvas）。
 *
 * 拆出来是为了可测：分辨率取偶、fps 抽帧比例、range 裁剪出来的帧数、
 * 码率越界，全在这一个函数里判定；exportTimeline 只是照着计划执行。
 */
export function planExport(opts = {}) {
  const timeline = Number(opts.duration);
  if (!Number.isFinite(timeline) || timeline <= 0) throw new ExportError('INVALID_ARG', 'duration 必须是正数');

  const fps = normalizeFps(opts.fps);
  const projectFps = normalizeProjectFps(opts.projectFps, fps);
  const width = normalizeDimension(opts.width, '宽度');
  const height = normalizeDimension(opts.height, '高度');
  const bitrateKbps = normalizeBitrate(opts.bitrateKbps);
  const bitrate = bitrateKbps == null ? estimateBitrate(width, height, fps) : Math.round(bitrateKbps * 1000);
  const range = normalizeRange(opts.range, timeline);
  const duration = range.end - range.start;
  const totalFrames = Math.max(1, Math.round(duration * fps));
  // 采样步长只用来向用户解释「30fps 工程按 60fps 采样 ≈ 每两个输出帧重复一个源帧」。
  // 真正的取帧时刻在 exportTimeline 里按 t = range.start + i / fps 算，
  // projectFps 不参与采样步长 —— 导出帧率是独立的。
  const sampleStep = +(projectFps / fps).toFixed(6);

  // 输出档位：给了 plan 就照 plan，给了 caps 就按能力挑；都没给则留空（运行时协商）
  const output = resolveOutput(opts);

  return {
    width,
    height,
    fps,
    projectFps,
    // sourceFps 与 projectFps 同义：导出结果与 exports[] 用这个名字写明「素材来自多少帧的工程」。
    sourceFps: projectFps,
    bitrate,
    bitrateKbps: bitrateKbps == null ? null : bitrateKbps,
    range,
    duration,
    totalFrames,
    sampleStep,
    // 封装参数回执：mp4-muxer / webm-muxer 本身不接收码率（码率经 VideoEncoder.configure 生效），
    // 把它记在同一份计划里，调用方与测试都能核对「这次导出到底按什么参数封装」。
    muxer: { width, height, frameRate: Math.max(1, Math.round(fps)), bitrate },
    // 容器 / 视频编码 / 音轨（或 null=无音轨）。null 表示没做能力探测，导出时按运行时协商。
    output,
  };
}

/**
 * 决定这次导出的容器与编码（纯函数，不碰编码器）。
 *
 * - 给了 opts.plan：直接用它（表单已经把 chooseExportPlan 的结论显示给用户了，必须说到做到）
 * - 给了 opts.caps：调 chooseExportPlan 现场挑一份
 * - 都没给：返回 null，exportTimeline 走运行时协商的老路径
 */
function resolveOutput(opts = {}) {
  const requested = opts.plan;
  if (requested !== undefined && requested !== null) return normalizeChoice(requested);

  const caps = opts.caps;
  if (caps !== undefined && caps !== null) {
    let choice;
    try {
      choice = chooseExportPlan(caps);
    } catch (err) {
      throw asExportError(err, 'NO_ENCODER');
    }
    return normalizeChoice(choice);
  }
  return null;
}

/** 校验并补全一份输出档位：容器装不下这个编码就直接报错，不留给 muxer 去崩。 */
function normalizeChoice(choice) {
  if (!choice || typeof choice !== 'object') {
    throw new ExportError('INVALID_ARG', '导出计划必须是对象');
  }
  const container = choice.container;
  if (container !== 'mp4' && container !== 'webm') {
    throw new ExportError('INVALID_ARG', '导出容器只能是 mp4 或 webm，收到 ' + String(container));
  }

  const videoCodec = choice.videoCodec;
  const muxerCodecs = MUXER_VIDEO_CODECS[container];
  if (!muxerCodecs || !Object.prototype.hasOwnProperty.call(muxerCodecs, videoCodec)) {
    throw new ExportError('INVALID_ARG', `${container} 容器装不了 ${String(videoCodec)} 视频编码`);
  }

  const audioCodec = choice.audioCodec === undefined ? null : choice.audioCodec;
  if (!CONTAINER_AUDIO[container].includes(audioCodec)) {
    const allowed = CONTAINER_AUDIO[container].filter(Boolean).map((name) => name.toUpperCase()).join(' / ');
    throw new ExportError('INVALID_ARG', `${container} 容器的音轨只能是 ${allowed} 或无音轨`);
  }

  if (container === 'webm' && !WEBM_AVAILABLE) {
    throw new ExportError(
      'CONTAINER_UNSUPPORTED',
      'WebM 分支需要 webm-muxer 依赖，当前构建里没有：导不了 WebM。' +
        '要导出 MP4 需要 H.264 或 HEVC 编码器 + AAC 音轨；要用 VP9 / AV1 + Opus，得把 webm-muxer 装回来。',
    );
  }

  const codec =
    typeof choice.codec === 'string' && choice.codec ? choice.codec : (VIDEO_CANDIDATES[videoCodec] || [])[0];
  if (!codec) throw new ExportError('INVALID_ARG', `没有 ${videoCodec} 的 codec 字串`);

  return {
    container,
    videoCodec,
    codec,
    audioCodec,
    muxerVideoCodec: muxerCodecs[videoCodec],
    reason: typeof choice.reason === 'string' ? choice.reason : '',
  };
}

/** 把 codec-caps 的 CodecError 换成统一的 ExportError（不改 message，不丢 code）。 */
function asExportError(err, fallbackCode) {
  if (err instanceof ExportError) return err;
  const code = err && err.code ? err.code : fallbackCode;
  return new ExportError(code, (err && err.message) || '导出组合不可用', err && err.details);
}

function normalizeDimension(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new ExportError('INVALID_ARG', label + ' 必须是正数');
  if (n > MAX_DIMENSION) throw new ExportError('INVALID_ARG', label + ` 不能超过 ${MAX_DIMENSION}`);
  return evenUp(n);
}

function normalizeBitrate(value) {
  if (value === undefined || value === null || value === '') return null; // 自动
  const kbps = Number(value);
  if (!Number.isFinite(kbps)) throw new ExportError('INVALID_ARG', '码率必须是数字');
  if (kbps < MIN_BITRATE_KBPS || kbps > MAX_BITRATE_KBPS) {
    throw new ExportError('INVALID_ARG', `码率需在 ${MIN_BITRATE_KBPS}–${MAX_BITRATE_KBPS} kbps 之间`, {
      bitrateKbps: kbps,
    });
  }
  return kbps;
}

function normalizeProjectFps(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps <= 0) throw new ExportError('INVALID_ARG', 'projectFps 必须是正数');
  return fps;
}

/**
 * 导出区间（时间线时间）。不给就整片；给了就只导这一段。
 * end 超过片长时截到片长（滑块的自然结果），start 越界则明确报错。
 */
function normalizeRange(range, timeline) {
  if (range === undefined || range === null) return { start: 0, end: timeline };
  if (typeof range !== 'object') throw new ExportError('INVALID_ARG', 'range 必须是 {start, end}');
  const start = range.start === undefined || range.start === null ? 0 : Number(range.start);
  const rawEnd = range.end === undefined || range.end === null ? timeline : Number(range.end);
  if (!Number.isFinite(start) || !Number.isFinite(rawEnd)) {
    throw new ExportError('INVALID_ARG', '导出范围的起止必须是数字');
  }
  if (start < 0) throw new ExportError('INVALID_ARG', '导出范围的起点不能是负数');
  if (start >= timeline) {
    throw new ExportError('INVALID_ARG', '导出范围的起点已经超出工程时长', { start, timeline });
  }
  if (rawEnd <= start) {
    throw new ExportError('INVALID_ARG', '导出范围的结束时间必须大于开始时间', { range: { start, end: rawEnd } });
  }
  const end = Math.min(rawEnd, timeline);
  return { start, end };
}

function normalizeFps(value) {
  const fps = value === undefined ? 30 : Number(value);
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new ExportError('INVALID_ARG', 'fps 必须是大于 0 的数字，收到 ' + String(value));
  }
  if (fps > MAX_EXPORT_FPS) {
    throw new ExportError('INVALID_ARG', `fps 不能超过 ${MAX_EXPORT_FPS}，收到 ${fps}`);
  }
  return fps;
}

/** 向上取偶；非法值返回 0，交给调用方报错。 */
function evenUp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const rounded = Math.max(2, Math.round(n));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function throwIfAborted(signal, ...encoders) {
  if (!signal || signal.aborted !== true) return;
  for (const encoder of encoders) closeQuietly(encoder);
  throw new ExportError('ABORTED', '导出已取消');
}

function closeQuietly(encoder) {
  if (!encoder) return;
  try {
    encoder.close();
  } catch {
    // 已关闭或不可关闭，忽略
  }
}

function normalizeError(err) {
  if (err && err.code) return err;
  const wrapped = new ExportError('ENCODE_FAILED', (err && err.message) || '导出失败');
  wrapped.cause = err;
  return wrapped;
}

function emit(onProgress, phase, ratio, message) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(message === undefined ? { phase, ratio } : { phase, ratio, message });
  } catch {
    // 进度回调不应打断导出
  }
}

/** 文件名：`<title>-<yyyyMMdd-hhmm>.<ext>`，标题做基本安全替换。 */
function buildFileName(title, container) {
  return `${safeTitle(title)}-${stamp(new Date())}.${container}`;
}

function safeTitle(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw)
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
    .replace(/[-.]+$/g, '');
  return text || 'video';
}

function stamp(date) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
