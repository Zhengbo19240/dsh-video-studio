/* built by scripts/build-client.mjs — do not edit by hand */
window.__ModuleLoader__.load({
  id: 'dsh-video-workbench',
  factory(require) {
    try {
      const module = { exports: {} };
      const exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/audio-mix.mjs
function dbToGain(db) {
  const n = Number(db);
  if (!Number.isFinite(n)) return 1;
  return Math.pow(10, n / 20);
}
function computeDuckEnvelope({
  duration,
  sampleRate = 48e3,
  voiceSegments = [],
  musicSegments = [],
  maxDuckDb = DUCK_DEFAULTS.maxDuckDb,
  attack = DUCK_DEFAULTS.attack,
  release = DUCK_DEFAULTS.release
} = {}) {
  const dur = Number(duration);
  const rate = Number(sampleRate);
  if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(rate) || rate <= 0) return new Float32Array(0);
  const n = Math.max(1, Math.round(dur * rate));
  const out = new Float32Array(n);
  out.fill(1);
  const duckDb = clamp(Number.isFinite(Number(maxDuckDb)) ? Number(maxDuckDb) : DUCK_DEFAULTS.maxDuckDb, -60, 0);
  const duck = dbToGain(duckDb);
  if (duck >= 1) return out;
  const attackS = Math.max(0, Number.isFinite(Number(attack)) ? Number(attack) : DUCK_DEFAULTS.attack);
  const releaseS = Math.max(0, Number.isFinite(Number(release)) ? Number(release) : DUCK_DEFAULTS.release);
  const windows = duckWindows(voiceSegments, musicSegments, dur);
  if (!windows.length) return out;
  for (const w of windows) {
    const segLen = w.end - w.start;
    if (!(segLen > 0)) continue;
    let at = Math.min(attackS, segLen);
    let rel = Math.min(releaseS, segLen);
    if (at + rel > segLen) {
      const k = segLen / (at + rel);
      at *= k;
      rel *= k;
    }
    const i0 = clampInt(Math.floor(w.start * rate), 0, n - 1);
    const i1 = clampInt(Math.ceil(w.end * rate), i0, n);
    const iA = clampInt(Math.round((w.start + at) * rate), i0, i1);
    const iR = clampInt(Math.round((w.end - rel) * rate), iA, i1);
    const relStart = w.end - rel;
    for (let i = i0; i < i1; i += 1) {
      const t = i / rate;
      let v2;
      if (i < iA) {
        const p = at > 1e-12 ? clamp((t - w.start) / at, 0, 1) : 1;
        v2 = 1 + (duck - 1) * p;
      } else if (i < iR) {
        v2 = duck;
      } else {
        const p = rel > 1e-12 ? clamp((t - relStart) / rel, 0, 1) : 1;
        v2 = duck + (1 - duck) * p;
      }
      if (v2 < out[i]) out[i] = v2;
    }
  }
  return out;
}
function duckWindows(voiceSegments, musicSegments, duration) {
  const voice = cleanSegments(voiceSegments, duration);
  const music = cleanSegments(musicSegments, duration);
  if (!voice.length || !music.length) return [];
  const hits = [];
  for (const v2 of voice) {
    for (const m of music) {
      const start = Math.max(v2.start, m.start);
      const end = Math.min(v2.end, m.end);
      if (end > start) hits.push({ start, end });
    }
  }
  if (!hits.length) return [];
  hits.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const h4 of hits) {
    const last2 = merged[merged.length - 1];
    if (last2 && h4.start <= last2.end + 1e-3) last2.end = Math.max(last2.end, h4.end);
    else merged.push({ start: h4.start, end: h4.end });
  }
  return merged;
}
function cleanSegments(list, duration) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const start = Math.max(0, Math.min(duration, Number(item.start)));
    const end = Math.max(0, Math.min(duration, Number(item.end)));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end > start) out.push({ start, end });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
function rmsNormalizeGain(samples, targetRms = NORMALIZE_DEFAULTS.targetRms, { minGain = NORMALIZE_DEFAULTS.minGain, maxGain = NORMALIZE_DEFAULTS.maxGain } = {}) {
  const rms = rootMeanSquare(samples);
  if (!(rms > 1e-9)) return 1;
  const target = Number.isFinite(Number(targetRms)) && Number(targetRms) > 0 ? Number(targetRms) : NORMALIZE_DEFAULTS.targetRms;
  const lo = Number.isFinite(Number(minGain)) && Number(minGain) > 0 ? Number(minGain) : NORMALIZE_DEFAULTS.minGain;
  const hi = Number.isFinite(Number(maxGain)) && Number(maxGain) > 0 ? Number(maxGain) : NORMALIZE_DEFAULTS.maxGain;
  const gain = target / rms;
  if (!Number.isFinite(gain)) return 1;
  return clamp(gain, Math.min(lo, hi), Math.max(lo, hi));
}
function rootMeanSquare(samples) {
  const acc = { sumSq: 0, count: 0 };
  accumulateSquare(samples, acc);
  if (!(acc.count > 0)) return 0;
  return Math.sqrt(acc.sumSq / acc.count);
}
function accumulateSquare(input, acc) {
  if (!input || typeof input.length !== "number") return;
  if (typeof input[0] === "number") {
    for (let i = 0; i < input.length; i += 1) {
      const v2 = input[i];
      if (Number.isFinite(v2)) acc.sumSq += v2 * v2;
      acc.count += 1;
    }
    return;
  }
  for (let i = 0; i < input.length; i += 1) accumulateSquare(input[i], acc);
}
function integratedLoudnessApprox(samples, sampleRate) {
  const rate = Number(sampleRate);
  if (!Number.isFinite(rate) || rate <= 0) return -Infinity;
  const mono = toMono(samples);
  if (!mono || mono.length === 0) return -Infinity;
  const block = Math.max(1, Math.round(0.4 * rate));
  const hop = Math.max(1, Math.round(0.1 * rate));
  const blocks = [];
  if (mono.length < block) {
    const ms = meanSquare(mono, 0, mono.length);
    if (ms > 0) blocks.push(ms);
  } else {
    for (let start = 0; start + block <= mono.length; start += hop) {
      blocks.push(meanSquare(mono, start, start + block));
    }
  }
  if (!blocks.length) return -Infinity;
  const absGate = meanSquareFromLufs(-70);
  let kept = blocks.filter((ms) => ms > absGate);
  if (!kept.length) return -Infinity;
  let mean = average(kept);
  const relGate = mean / 10;
  const above = kept.filter((ms) => ms >= relGate);
  if (above.length) kept = above;
  mean = average(kept);
  if (!(mean > 0)) return -Infinity;
  return -0.691 + 10 * Math.log10(mean);
}
function meanSquareFromLufs(lufs) {
  return Math.pow(10, (lufs + 0.691) / 10);
}
function toMono(samples) {
  if (!samples || typeof samples.length !== "number") return null;
  if (typeof samples[0] === "number") {
    const out2 = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const v2 = samples[i];
      out2[i] = Number.isFinite(v2) ? v2 : 0;
    }
    return out2;
  }
  const channels = [];
  for (const ch of samples) if (ch && typeof ch.length === "number") channels.push(ch);
  if (!channels.length) return null;
  let len = Infinity;
  for (const ch of channels) len = Math.min(len, ch.length);
  if (!(len > 0) || !Number.isFinite(len)) return null;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
    let sum = 0;
    for (const ch of channels) {
      const v2 = ch[i];
      sum += Number.isFinite(v2) ? v2 : 0;
    }
    out[i] = sum / channels.length;
  }
  return out;
}
function meanSquare(arr, start, end) {
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += arr[i] * arr[i];
  return sum / Math.max(1, end - start);
}
function average(list) {
  if (!list.length) return 0;
  let sum = 0;
  for (const v2 of list) sum += v2;
  return sum / list.length;
}
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function clipGainPoints(duration, opts = {}) {
  const dur = Number(duration);
  if (!Number.isFinite(dur) || dur <= 0) return [{ t: 0, v: 0 }];
  const o = opts && typeof opts === "object" ? opts : {};
  if (o.muted === true) return [{ t: 0, v: 0 }];
  const vol = clampNumber(o.volume, AUDIO_VOLUME_MIN, AUDIO_VOLUME_MAX, CLIP_AUDIO_DEFAULTS.volume);
  let fadeIn = clampNumber(o.fadeIn, 0, dur, 0);
  let fadeOut = clampNumber(o.fadeOut, 0, dur, 0);
  if (fadeIn + fadeOut > dur) {
    const k = dur / (fadeIn + fadeOut);
    fadeIn *= k;
    fadeOut *= k;
  }
  const pts = [];
  if (fadeIn > 0) pts.push({ t: 0, v: 0 }, { t: fadeIn, v: vol });
  else pts.push({ t: 0, v: vol });
  if (fadeOut > 0) {
    const t = dur - fadeOut;
    if (t > pts[pts.length - 1].t) pts.push({ t, v: vol });
    pts.push({ t: dur, v: 0 });
  }
  return pts;
}
function gainAtPoints(points, t) {
  if (!Array.isArray(points) || points.length === 0) return 0;
  const x = Number.isFinite(Number(t)) ? Number(t) : 0;
  if (x <= points[0].t) return points[0].v;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (x <= b.t) {
      if (b.t - a.t <= 1e-9) return b.v;
      return a.v + (b.v - a.v) * (x - a.t) / (b.t - a.t);
    }
  }
  return points[points.length - 1].v;
}
function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
var DUCK_DEFAULTS, NORMALIZE_DEFAULTS, CLIP_AUDIO_DEFAULTS, AUDIO_VOLUME_MIN, AUDIO_VOLUME_MAX, EXPORT_PEAK_CEILING;
var init_audio_mix = __esm({
  "src/audio-mix.mjs"() {
    DUCK_DEFAULTS = Object.freeze({ maxDuckDb: -12, attack: 0.08, release: 0.25 });
    NORMALIZE_DEFAULTS = Object.freeze({ targetRms: 0.1, minGain: 0.25, maxGain: 4 });
    CLIP_AUDIO_DEFAULTS = Object.freeze({ volume: 1, fadeIn: 0, fadeOut: 0, muted: false });
    AUDIO_VOLUME_MIN = 0;
    AUDIO_VOLUME_MAX = 2;
    EXPORT_PEAK_CEILING = 0.99;
  }
});

// src/client/codec-caps.mjs
var codec_caps_exports = {};
__export(codec_caps_exports, {
  AUDIO_CANDIDATES: () => AUDIO_CANDIDATES,
  AUDIO_LABELS: () => AUDIO_LABELS,
  CONTAINER_LABELS: () => CONTAINER_LABELS,
  CodecError: () => CodecError,
  PROBE_SHAPE: () => PROBE_SHAPE,
  VIDEO_CANDIDATES: () => VIDEO_CANDIDATES,
  VIDEO_LABELS: () => VIDEO_LABELS,
  chooseExportPlan: () => chooseExportPlan,
  describePlan: () => describePlan,
  probeEncoders: () => probeEncoders
});
async function probeEncoders(options = {}) {
  const videoEncoder = options.VideoEncoder !== void 0 ? options.VideoEncoder : globalThis.VideoEncoder;
  const audioEncoder = options.AudioEncoder !== void 0 ? options.AudioEncoder : globalThis.AudioEncoder;
  const shape = {
    width: positiveNumber(options.width, PROBE_SHAPE.width),
    height: positiveNumber(options.height, PROBE_SHAPE.height),
    framerate: positiveNumber(options.framerate, PROBE_SHAPE.framerate),
    bitrate: positiveNumber(options.bitrate, PROBE_SHAPE.bitrate)
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
  if (!encoder) return { supported: false, reason: "\u6D4F\u89C8\u5668\u6CA1\u6709 VideoEncoder" };
  if (typeof encoder.isConfigSupported !== "function") {
    return { supported: false, reason: "VideoEncoder \u6CA1\u6709 isConfigSupported" };
  }
  let thrown = null;
  for (const codec of codecs) {
    try {
      const result = await encoder.isConfigSupported({
        codec,
        width: shape.width,
        height: shape.height,
        bitrate: shape.bitrate,
        framerate: shape.framerate
      });
      if (result && result.supported === true) return { supported: true, codec };
    } catch (err) {
      thrown = err;
    }
  }
  if (thrown) return { supported: false, reason: "isConfigSupported \u629B\u9519\uFF1A" + errorText(thrown) };
  return { supported: false, reason: `isConfigSupported(${codecs.join(" / ")}) \u90FD\u8FD4\u56DE supported: false` };
}
async function probeAudioFamily(encoder, family) {
  const codec = AUDIO_CANDIDATES[family];
  if (!encoder) return { supported: false, reason: "\u6D4F\u89C8\u5668\u6CA1\u6709 AudioEncoder" };
  if (typeof encoder.isConfigSupported !== "function") {
    return { supported: false, reason: "AudioEncoder \u6CA1\u6709 isConfigSupported" };
  }
  try {
    const result = await encoder.isConfigSupported({ codec, ...PROBE_AUDIO });
    if (result && result.supported === true) return { supported: true, codec };
  } catch (err) {
    return { supported: false, reason: "isConfigSupported \u629B\u9519\uFF1A" + errorText(err) };
  }
  return { supported: false, reason: `isConfigSupported(${codec}) \u8FD4\u56DE supported: false` };
}
function chooseExportPlan(caps) {
  if (hasVideo(caps, "h264") && hasAudio(caps, "aac")) {
    return makePlan(caps, { container: "mp4", video: "h264", audio: "aac", reason: "\u9996\u9009\u7EC4\u5408\uFF1AH.264 \u4E0E AAC \u90FD\u652F\u6301" });
  }
  if (hasVideo(caps, "hevc") && hasAudio(caps, "aac")) {
    return makePlan(caps, { container: "mp4", video: "hevc", audio: "aac", reason: "\u672C\u673A\u4E0D\u652F\u6301 H.264\uFF0C\u5DF2\u81EA\u52A8\u6539\u7528 HEVC" });
  }
  for (const video of ["vp9", "av1"]) {
    if (hasVideo(caps, video) && hasAudio(caps, "opus")) {
      const missing = [];
      if (!hasVideo(caps, "h264")) missing.push("H.264");
      if (!hasVideo(caps, "hevc")) missing.push("HEVC");
      if (!hasAudio(caps, "aac")) missing.push("AAC");
      const reason = missing.length ? `\u672C\u673A\u7F3A\u5C11 ${joinCn(missing)}\uFF0CMP4 \u7EC4\u5408\u4E0D\u6210\u7ACB` : "MP4 \u7EC4\u5408\u4E0D\u53EF\u7528\uFF0C\u6539\u7528 WebM";
      return makePlan(caps, { container: "webm", video, audio: "opus", reason });
    }
  }
  const videoOnly = [
    ["mp4", "h264"],
    ["mp4", "hevc"],
    ["webm", "vp9"],
    ["webm", "av1"]
  ].find(([, family]) => hasVideo(caps, family));
  if (videoOnly) {
    return makePlan(caps, {
      container: videoOnly[0],
      video: videoOnly[1],
      audio: null,
      reason: audioGap(videoOnly[0], caps)
    });
  }
  throw new CodecError(
    "NO_ENCODER",
    "\u5F53\u524D\u6D4F\u89C8\u5668\u6CA1\u6709\u53EF\u7528\u7684\u89C6\u9891\u7F16\u7801\u5668\uFF1AH.264 / HEVC / VP9 / AV1 \u5168\u90E8\u4E0D\u53EF\u7528\uFF0C\u65E0\u6CD5\u5BFC\u51FA\u89C6\u9891\u3002\u8BF7\u786E\u8BA4\u6D4F\u89C8\u5668\u7248\u672C\u652F\u6301 WebCodecs\uFF0C\u6216\u5728\u652F\u6301\u786C\u4EF6\u7F16\u7801\u7684\u673A\u5668\u4E0A\u91CD\u8BD5\u3002",
    { video: caps && caps.video || null }
  );
}
function describePlan(plan) {
  if (!plan || !plan.container) return "\u5C06\u5BFC\u51FA\uFF1A\u672A\u77E5\u683C\u5F0F";
  const parts = [
    CONTAINER_LABELS[plan.container] || String(plan.container),
    VIDEO_LABELS[plan.videoCodec] || String(plan.videoCodec),
    plan.audioCodec ? AUDIO_LABELS[plan.audioCodec] || String(plan.audioCodec) : "\u65E0\u97F3\u8F68"
  ];
  const reason = typeof plan.reason === "string" ? plan.reason.trim() : "";
  return "\u5C06\u5BFC\u51FA\uFF1A" + parts.join(" / ") + (reason ? "\uFF08" + reason + "\uFF09" : "");
}
function makePlan(caps, { container, video, audio, reason }) {
  return {
    container,
    videoCodec: video,
    codec: codecStringOf(caps, video),
    audioCodec: audio,
    reason
  };
}
function codecStringOf(caps, family) {
  const entry = caps && caps.video ? caps.video[family] : null;
  if (entry && typeof entry.codec === "string" && entry.codec) return entry.codec;
  return VIDEO_CANDIDATES[family][0];
}
function hasVideo(caps, family) {
  return !!(caps && caps.video && caps.video[family] && caps.video[family].supported === true);
}
function hasAudio(caps, family) {
  return !!(caps && caps.audio && caps.audio[family] && caps.audio[family].supported === true);
}
function joinCn(items) {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return items[0] + " \u4E0E " + items[1];
  return items.slice(0, -1).join("\u3001") + " \u4E0E " + items[items.length - 1];
}
function audioGap(container, caps) {
  const aac = hasAudio(caps, "aac");
  const opus = hasAudio(caps, "opus");
  if (!aac && !opus) return "AAC \u4E0E Opus \u90FD\u4E0D\u53EF\u7528\uFF0C\u5C06\u5BFC\u51FA\u65E0\u97F3\u8F68\u89C6\u9891";
  if (container === "mp4" && !aac) return "AAC \u4E0D\u53EF\u7528\uFF0COpus \u88C5\u4E0D\u8FDB MP4\uFF0C\u5C06\u5BFC\u51FA\u65E0\u97F3\u8F68\u89C6\u9891";
  if (container === "webm" && !opus) return "Opus \u4E0D\u53EF\u7528\uFF0CAAC \u88C5\u4E0D\u8FDB WebM\uFF0C\u5C06\u5BFC\u51FA\u65E0\u97F3\u8F68\u89C6\u9891";
  return "\u6CA1\u6709\u80FD\u914D\u4E0A\u7684\u97F3\u8F68\u7F16\u7801\u5668\uFF0C\u5C06\u5BFC\u51FA\u65E0\u97F3\u8F68\u89C6\u9891";
}
function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function errorText(err) {
  return err && (err.message || err.name) || String(err);
}
var VIDEO_CANDIDATES, AUDIO_CANDIDATES, VIDEO_LABELS, AUDIO_LABELS, CONTAINER_LABELS, PROBE_SHAPE, PROBE_AUDIO, CodecError;
var init_codec_caps = __esm({
  "src/client/codec-caps.mjs"() {
    VIDEO_CANDIDATES = {
      h264: ["avc1.42001f"],
      // hvc1 优先：mp4-muxer 的 HEVC 采样项写的是 hvc1，先用实测通过的那个更稳
      hevc: ["hvc1.1.6.L93.B0", "hev1.1.6.L93.B0"],
      vp9: ["vp09.00.10.08"],
      av1: ["av01.0.08M.08"]
    };
    AUDIO_CANDIDATES = {
      aac: "mp4a.40.2",
      // AAC-LC
      opus: "opus"
    };
    VIDEO_LABELS = { h264: "H.264", hevc: "HEVC", vp9: "VP9", av1: "AV1" };
    AUDIO_LABELS = { aac: "AAC", opus: "Opus" };
    CONTAINER_LABELS = { mp4: "MP4", webm: "WebM" };
    PROBE_SHAPE = { width: 1920, height: 1080, framerate: 30, bitrate: 8e6 };
    PROBE_AUDIO = { sampleRate: 48e3, numberOfChannels: 2, bitrate: 128e3 };
    CodecError = class extends Error {
      constructor(code, message, details) {
        super(message);
        this.name = "CodecError";
        this.code = code;
        if (details !== void 0) this.details = details;
      }
    };
  }
});

// node_modules/mp4-muxer/build/mp4-muxer.mjs
var __accessCheck, __privateGet, __privateAdd, __privateSet, __privateWrapper, __privateMethod, bytes, view, u8, u16, i16, u24, u32, i32, u64, fixed_8_8, fixed_16_16, fixed_2_30, ascii, last, lastPresentedSample, intoTimescale, rotationMatrix, IDENTITY_MATRIX, matrixToBytes, deepClone, isU32, box, fullBox, ftyp, mdat, free, moov, mvhd, trak, tkhd, mdia, mdhd, hdlr, minf, vmhd, smhd, dinf, dref, url, stbl, stsd, videoSampleDescription, COLOR_PRIMARIES_MAP, TRANSFER_CHARACTERISTICS_MAP, MATRIX_COEFFICIENTS_MAP, colr, avcC, hvcC, vpcC, av1C, soundSampleDescription, esds, dOps, stts, stss, stsc, stsz, stco, ctts, mvex, trex, moof, mfhd, fragmentSampleFlags, traf, tfhd, tfdt, trun, mfra, tfra, mfro, VIDEO_CODEC_TO_BOX_NAME, VIDEO_CODEC_TO_CONFIGURATION_BOX, AUDIO_CODEC_TO_BOX_NAME, AUDIO_CODEC_TO_CONFIGURATION_BOX, Target, ArrayBufferTarget, StreamTarget, FileSystemWritableFileStreamTarget, _helper, _helperView, Writer, _target, _buffer, _bytes, _maxPos, _ensureSize, ensureSize_fn, ArrayBufferTargetWriter, DEFAULT_CHUNK_SIZE, MAX_CHUNKS_AT_ONCE, _target2, _sections, _chunked, _chunkSize, _chunks, _writeDataIntoChunks, writeDataIntoChunks_fn, _insertSectionIntoChunk, insertSectionIntoChunk_fn, _createChunk, createChunk_fn, _flushChunks, flushChunks_fn, StreamTargetWriter, FileSystemWritableFileStreamTargetWriter, GLOBAL_TIMESCALE, SUPPORTED_VIDEO_CODECS, SUPPORTED_AUDIO_CODECS, TIMESTAMP_OFFSET, FIRST_TIMESTAMP_BEHAVIORS, _options, _writer, _ftypSize, _mdat, _videoTrack, _audioTrack, _creationTime, _finalizedChunks, _nextFragmentNumber, _videoSampleQueue, _audioSampleQueue, _finalized, _validateOptions, validateOptions_fn, _writeHeader, writeHeader_fn, _computeMoovSizeUpperBound, computeMoovSizeUpperBound_fn, _prepareTracks, prepareTracks_fn, _generateMpeg4AudioSpecificConfig, generateMpeg4AudioSpecificConfig_fn, _createSampleForTrack, createSampleForTrack_fn, _addSampleToTrack, addSampleToTrack_fn, _validateTimestamp, validateTimestamp_fn, _finalizeCurrentChunk, finalizeCurrentChunk_fn, _finalizeFragment, finalizeFragment_fn, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn, _ensureNotFinalized, ensureNotFinalized_fn, Muxer;
var init_mp4_muxer = __esm({
  "node_modules/mp4-muxer/build/mp4-muxer.mjs"() {
    __accessCheck = (obj, member, msg) => {
      if (!member.has(obj))
        throw TypeError("Cannot " + msg);
    };
    __privateGet = (obj, member, getter) => {
      __accessCheck(obj, member, "read from private field");
      return getter ? getter.call(obj) : member.get(obj);
    };
    __privateAdd = (obj, member, value) => {
      if (member.has(obj))
        throw TypeError("Cannot add the same private member more than once");
      member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
    };
    __privateSet = (obj, member, value, setter) => {
      __accessCheck(obj, member, "write to private field");
      setter ? setter.call(obj, value) : member.set(obj, value);
      return value;
    };
    __privateWrapper = (obj, member, setter, getter) => ({
      set _(value) {
        __privateSet(obj, member, value, setter);
      },
      get _() {
        return __privateGet(obj, member, getter);
      }
    });
    __privateMethod = (obj, member, method) => {
      __accessCheck(obj, member, "access private method");
      return method;
    };
    bytes = new Uint8Array(8);
    view = new DataView(bytes.buffer);
    u8 = (value) => {
      return [(value % 256 + 256) % 256];
    };
    u16 = (value) => {
      view.setUint16(0, value, false);
      return [bytes[0], bytes[1]];
    };
    i16 = (value) => {
      view.setInt16(0, value, false);
      return [bytes[0], bytes[1]];
    };
    u24 = (value) => {
      view.setUint32(0, value, false);
      return [bytes[1], bytes[2], bytes[3]];
    };
    u32 = (value) => {
      view.setUint32(0, value, false);
      return [bytes[0], bytes[1], bytes[2], bytes[3]];
    };
    i32 = (value) => {
      view.setInt32(0, value, false);
      return [bytes[0], bytes[1], bytes[2], bytes[3]];
    };
    u64 = (value) => {
      view.setUint32(0, Math.floor(value / 2 ** 32), false);
      view.setUint32(4, value, false);
      return [bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7]];
    };
    fixed_8_8 = (value) => {
      view.setInt16(0, 2 ** 8 * value, false);
      return [bytes[0], bytes[1]];
    };
    fixed_16_16 = (value) => {
      view.setInt32(0, 2 ** 16 * value, false);
      return [bytes[0], bytes[1], bytes[2], bytes[3]];
    };
    fixed_2_30 = (value) => {
      view.setInt32(0, 2 ** 30 * value, false);
      return [bytes[0], bytes[1], bytes[2], bytes[3]];
    };
    ascii = (text, nullTerminated = false) => {
      let bytes2 = Array(text.length).fill(null).map((_, i) => text.charCodeAt(i));
      if (nullTerminated)
        bytes2.push(0);
      return bytes2;
    };
    last = (arr) => {
      return arr && arr[arr.length - 1];
    };
    lastPresentedSample = (samples) => {
      let result = void 0;
      for (let sample of samples) {
        if (!result || sample.presentationTimestamp > result.presentationTimestamp) {
          result = sample;
        }
      }
      return result;
    };
    intoTimescale = (timeInSeconds, timescale, round2 = true) => {
      let value = timeInSeconds * timescale;
      return round2 ? Math.round(value) : value;
    };
    rotationMatrix = (rotationInDegrees) => {
      let theta = rotationInDegrees * (Math.PI / 180);
      let cosTheta = Math.cos(theta);
      let sinTheta = Math.sin(theta);
      return [
        cosTheta,
        sinTheta,
        0,
        -sinTheta,
        cosTheta,
        0,
        0,
        0,
        1
      ];
    };
    IDENTITY_MATRIX = rotationMatrix(0);
    matrixToBytes = (matrix) => {
      return [
        fixed_16_16(matrix[0]),
        fixed_16_16(matrix[1]),
        fixed_2_30(matrix[2]),
        fixed_16_16(matrix[3]),
        fixed_16_16(matrix[4]),
        fixed_2_30(matrix[5]),
        fixed_16_16(matrix[6]),
        fixed_16_16(matrix[7]),
        fixed_2_30(matrix[8])
      ];
    };
    deepClone = (x) => {
      if (!x)
        return x;
      if (typeof x !== "object")
        return x;
      if (Array.isArray(x))
        return x.map(deepClone);
      return Object.fromEntries(Object.entries(x).map(([key, value]) => [key, deepClone(value)]));
    };
    isU32 = (value) => {
      return value >= 0 && value < 2 ** 32;
    };
    box = (type, contents, children) => ({
      type,
      contents: contents && new Uint8Array(contents.flat(10)),
      children
    });
    fullBox = (type, version, flags, contents, children) => box(
      type,
      [u8(version), u24(flags), contents ?? []],
      children
    );
    ftyp = (details) => {
      let minorVersion = 512;
      if (details.fragmented)
        return box("ftyp", [
          ascii("iso5"),
          // Major brand
          u32(minorVersion),
          // Minor version
          // Compatible brands
          ascii("iso5"),
          ascii("iso6"),
          ascii("mp41")
        ]);
      return box("ftyp", [
        ascii("isom"),
        // Major brand
        u32(minorVersion),
        // Minor version
        // Compatible brands
        ascii("isom"),
        details.holdsAvc ? ascii("avc1") : [],
        ascii("mp41")
      ]);
    };
    mdat = (reserveLargeSize) => ({ type: "mdat", largeSize: reserveLargeSize });
    free = (size) => ({ type: "free", size });
    moov = (tracks, creationTime, fragmented = false) => box("moov", null, [
      mvhd(creationTime, tracks),
      ...tracks.map((x) => trak(x, creationTime)),
      fragmented ? mvex(tracks) : null
    ]);
    mvhd = (creationTime, tracks) => {
      let duration = intoTimescale(Math.max(
        0,
        ...tracks.filter((x) => x.samples.length > 0).map((x) => {
          const lastSample = lastPresentedSample(x.samples);
          return lastSample.presentationTimestamp + lastSample.duration;
        })
      ), GLOBAL_TIMESCALE);
      let nextTrackId = Math.max(...tracks.map((x) => x.id)) + 1;
      let needsU64 = !isU32(creationTime) || !isU32(duration);
      let u32OrU64 = needsU64 ? u64 : u32;
      return fullBox("mvhd", +needsU64, 0, [
        u32OrU64(creationTime),
        // Creation time
        u32OrU64(creationTime),
        // Modification time
        u32(GLOBAL_TIMESCALE),
        // Timescale
        u32OrU64(duration),
        // Duration
        fixed_16_16(1),
        // Preferred rate
        fixed_8_8(1),
        // Preferred volume
        Array(10).fill(0),
        // Reserved
        matrixToBytes(IDENTITY_MATRIX),
        // Matrix
        Array(24).fill(0),
        // Pre-defined
        u32(nextTrackId)
        // Next track ID
      ]);
    };
    trak = (track2, creationTime) => box("trak", null, [
      tkhd(track2, creationTime),
      mdia(track2, creationTime)
    ]);
    tkhd = (track2, creationTime) => {
      let lastSample = lastPresentedSample(track2.samples);
      let durationInGlobalTimescale = intoTimescale(
        lastSample ? lastSample.presentationTimestamp + lastSample.duration : 0,
        GLOBAL_TIMESCALE
      );
      let needsU64 = !isU32(creationTime) || !isU32(durationInGlobalTimescale);
      let u32OrU64 = needsU64 ? u64 : u32;
      let matrix;
      if (track2.info.type === "video") {
        matrix = typeof track2.info.rotation === "number" ? rotationMatrix(track2.info.rotation) : track2.info.rotation;
      } else {
        matrix = IDENTITY_MATRIX;
      }
      return fullBox("tkhd", +needsU64, 3, [
        u32OrU64(creationTime),
        // Creation time
        u32OrU64(creationTime),
        // Modification time
        u32(track2.id),
        // Track ID
        u32(0),
        // Reserved
        u32OrU64(durationInGlobalTimescale),
        // Duration
        Array(8).fill(0),
        // Reserved
        u16(0),
        // Layer
        u16(0),
        // Alternate group
        fixed_8_8(track2.info.type === "audio" ? 1 : 0),
        // Volume
        u16(0),
        // Reserved
        matrixToBytes(matrix),
        // Matrix
        fixed_16_16(track2.info.type === "video" ? track2.info.width : 0),
        // Track width
        fixed_16_16(track2.info.type === "video" ? track2.info.height : 0)
        // Track height
      ]);
    };
    mdia = (track2, creationTime) => box("mdia", null, [
      mdhd(track2, creationTime),
      hdlr(track2.info.type === "video" ? "vide" : "soun"),
      minf(track2)
    ]);
    mdhd = (track2, creationTime) => {
      let lastSample = lastPresentedSample(track2.samples);
      let localDuration = intoTimescale(
        lastSample ? lastSample.presentationTimestamp + lastSample.duration : 0,
        track2.timescale
      );
      let needsU64 = !isU32(creationTime) || !isU32(localDuration);
      let u32OrU64 = needsU64 ? u64 : u32;
      return fullBox("mdhd", +needsU64, 0, [
        u32OrU64(creationTime),
        // Creation time
        u32OrU64(creationTime),
        // Modification time
        u32(track2.timescale),
        // Timescale
        u32OrU64(localDuration),
        // Duration
        u16(21956),
        // Language ("und", undetermined)
        u16(0)
        // Quality
      ]);
    };
    hdlr = (componentSubtype) => fullBox("hdlr", 0, 0, [
      ascii("mhlr"),
      // Component type
      ascii(componentSubtype),
      // Component subtype
      u32(0),
      // Component manufacturer
      u32(0),
      // Component flags
      u32(0),
      // Component flags mask
      ascii("mp4-muxer-hdlr", true)
      // Component name
    ]);
    minf = (track2) => box("minf", null, [
      track2.info.type === "video" ? vmhd() : smhd(),
      dinf(),
      stbl(track2)
    ]);
    vmhd = () => fullBox("vmhd", 0, 1, [
      u16(0),
      // Graphics mode
      u16(0),
      // Opcolor R
      u16(0),
      // Opcolor G
      u16(0)
      // Opcolor B
    ]);
    smhd = () => fullBox("smhd", 0, 0, [
      u16(0),
      // Balance
      u16(0)
      // Reserved
    ]);
    dinf = () => box("dinf", null, [
      dref()
    ]);
    dref = () => fullBox("dref", 0, 0, [
      u32(1)
      // Entry count
    ], [
      url()
    ]);
    url = () => fullBox("url ", 0, 1);
    stbl = (track2) => {
      const needsCtts = track2.compositionTimeOffsetTable.length > 1 || track2.compositionTimeOffsetTable.some((x) => x.sampleCompositionTimeOffset !== 0);
      return box("stbl", null, [
        stsd(track2),
        stts(track2),
        stss(track2),
        stsc(track2),
        stsz(track2),
        stco(track2),
        needsCtts ? ctts(track2) : null
      ]);
    };
    stsd = (track2) => fullBox("stsd", 0, 0, [
      u32(1)
      // Entry count
    ], [
      track2.info.type === "video" ? videoSampleDescription(
        VIDEO_CODEC_TO_BOX_NAME[track2.info.codec],
        track2
      ) : soundSampleDescription(
        AUDIO_CODEC_TO_BOX_NAME[track2.info.codec],
        track2
      )
    ]);
    videoSampleDescription = (compressionType, track2) => box(compressionType, [
      Array(6).fill(0),
      // Reserved
      u16(1),
      // Data reference index
      u16(0),
      // Pre-defined
      u16(0),
      // Reserved
      Array(12).fill(0),
      // Pre-defined
      u16(track2.info.width),
      // Width
      u16(track2.info.height),
      // Height
      u32(4718592),
      // Horizontal resolution
      u32(4718592),
      // Vertical resolution
      u32(0),
      // Reserved
      u16(1),
      // Frame count
      Array(32).fill(0),
      // Compressor name
      u16(24),
      // Depth
      i16(65535)
      // Pre-defined
    ], [
      VIDEO_CODEC_TO_CONFIGURATION_BOX[track2.info.codec](track2),
      track2.info.decoderConfig.colorSpace ? colr(track2) : null
    ]);
    COLOR_PRIMARIES_MAP = {
      "bt709": 1,
      // ITU-R BT.709
      "bt470bg": 5,
      // ITU-R BT.470BG
      "smpte170m": 6
      // ITU-R BT.601 525 - SMPTE 170M
    };
    TRANSFER_CHARACTERISTICS_MAP = {
      "bt709": 1,
      // ITU-R BT.709
      "smpte170m": 6,
      // SMPTE 170M
      "iec61966-2-1": 13
      // IEC 61966-2-1
    };
    MATRIX_COEFFICIENTS_MAP = {
      "rgb": 0,
      // Identity
      "bt709": 1,
      // ITU-R BT.709
      "bt470bg": 5,
      // ITU-R BT.470BG
      "smpte170m": 6
      // SMPTE 170M
    };
    colr = (track2) => box("colr", [
      ascii("nclx"),
      // Colour type
      u16(COLOR_PRIMARIES_MAP[track2.info.decoderConfig.colorSpace.primaries]),
      // Colour primaries
      u16(TRANSFER_CHARACTERISTICS_MAP[track2.info.decoderConfig.colorSpace.transfer]),
      // Transfer characteristics
      u16(MATRIX_COEFFICIENTS_MAP[track2.info.decoderConfig.colorSpace.matrix]),
      // Matrix coefficients
      u8((track2.info.decoderConfig.colorSpace.fullRange ? 1 : 0) << 7)
      // Full range flag
    ]);
    avcC = (track2) => track2.info.decoderConfig && box("avcC", [
      // For AVC, description is an AVCDecoderConfigurationRecord, so nothing else to do here
      ...new Uint8Array(track2.info.decoderConfig.description)
    ]);
    hvcC = (track2) => track2.info.decoderConfig && box("hvcC", [
      // For HEVC, description is a HEVCDecoderConfigurationRecord, so nothing else to do here
      ...new Uint8Array(track2.info.decoderConfig.description)
    ]);
    vpcC = (track2) => {
      if (!track2.info.decoderConfig) {
        return null;
      }
      let decoderConfig = track2.info.decoderConfig;
      if (!decoderConfig.colorSpace) {
        throw new Error(`'colorSpace' is required in the decoder config for VP9.`);
      }
      let parts = decoderConfig.codec.split(".");
      let profile = Number(parts[1]);
      let level = Number(parts[2]);
      let bitDepth = Number(parts[3]);
      let chromaSubsampling = 0;
      let thirdByte = (bitDepth << 4) + (chromaSubsampling << 1) + Number(decoderConfig.colorSpace.fullRange);
      let colourPrimaries = 2;
      let transferCharacteristics = 2;
      let matrixCoefficients = 2;
      return fullBox("vpcC", 1, 0, [
        u8(profile),
        // Profile
        u8(level),
        // Level
        u8(thirdByte),
        // Bit depth, chroma subsampling, full range
        u8(colourPrimaries),
        // Colour primaries
        u8(transferCharacteristics),
        // Transfer characteristics
        u8(matrixCoefficients),
        // Matrix coefficients
        u16(0)
        // Codec initialization data size
      ]);
    };
    av1C = () => {
      let marker = 1;
      let version = 1;
      let firstByte = (marker << 7) + version;
      return box("av1C", [
        firstByte,
        0,
        0,
        0
      ]);
    };
    soundSampleDescription = (compressionType, track2) => box(compressionType, [
      Array(6).fill(0),
      // Reserved
      u16(1),
      // Data reference index
      u16(0),
      // Version
      u16(0),
      // Revision level
      u32(0),
      // Vendor
      u16(track2.info.numberOfChannels),
      // Number of channels
      u16(16),
      // Sample size (bits)
      u16(0),
      // Compression ID
      u16(0),
      // Packet size
      fixed_16_16(track2.info.sampleRate)
      // Sample rate
    ], [
      AUDIO_CODEC_TO_CONFIGURATION_BOX[track2.info.codec](track2)
    ]);
    esds = (track2) => {
      let description = new Uint8Array(track2.info.decoderConfig.description);
      return fullBox("esds", 0, 0, [
        // https://stackoverflow.com/a/54803118
        u32(58753152),
        // TAG(3) = Object Descriptor ([2])
        u8(32 + description.byteLength),
        // length of this OD (which includes the next 2 tags)
        u16(1),
        // ES_ID = 1
        u8(0),
        // flags etc = 0
        u32(75530368),
        // TAG(4) = ES Descriptor ([2]) embedded in above OD
        u8(18 + description.byteLength),
        // length of this ESD
        u8(64),
        // MPEG-4 Audio
        u8(21),
        // stream type(6bits)=5 audio, flags(2bits)=1
        u24(0),
        // 24bit buffer size
        u32(130071),
        // max bitrate
        u32(130071),
        // avg bitrate
        u32(92307584),
        // TAG(5) = ASC ([2],[3]) embedded in above OD
        u8(description.byteLength),
        // length
        ...description,
        u32(109084800),
        // TAG(6)
        u8(1),
        // length
        u8(2)
        // data
      ]);
    };
    dOps = (track2) => {
      let preskip = 3840;
      let gain = 0;
      const description = track2.info.decoderConfig?.description;
      if (description) {
        if (description.byteLength < 18) {
          throw new TypeError("Invalid decoder description provided for Opus; must be at least 18 bytes long.");
        }
        const view2 = ArrayBuffer.isView(description) ? new DataView(description.buffer, description.byteOffset, description.byteLength) : new DataView(description);
        preskip = view2.getUint16(10, true);
        gain = view2.getInt16(14, true);
      }
      return box("dOps", [
        u8(0),
        // Version
        u8(track2.info.numberOfChannels),
        // OutputChannelCount
        u16(preskip),
        u32(track2.info.sampleRate),
        // InputSampleRate
        fixed_8_8(gain),
        // OutputGain
        u8(0)
        // ChannelMappingFamily
      ]);
    };
    stts = (track2) => {
      return fullBox("stts", 0, 0, [
        u32(track2.timeToSampleTable.length),
        // Number of entries
        track2.timeToSampleTable.map((x) => [
          // Time-to-sample table
          u32(x.sampleCount),
          // Sample count
          u32(x.sampleDelta)
          // Sample duration
        ])
      ]);
    };
    stss = (track2) => {
      if (track2.samples.every((x) => x.type === "key"))
        return null;
      let keySamples = [...track2.samples.entries()].filter(([, sample]) => sample.type === "key");
      return fullBox("stss", 0, 0, [
        u32(keySamples.length),
        // Number of entries
        keySamples.map(([index]) => u32(index + 1))
        // Sync sample table
      ]);
    };
    stsc = (track2) => {
      return fullBox("stsc", 0, 0, [
        u32(track2.compactlyCodedChunkTable.length),
        // Number of entries
        track2.compactlyCodedChunkTable.map((x) => [
          // Sample-to-chunk table
          u32(x.firstChunk),
          // First chunk
          u32(x.samplesPerChunk),
          // Samples per chunk
          u32(1)
          // Sample description index
        ])
      ]);
    };
    stsz = (track2) => fullBox("stsz", 0, 0, [
      u32(0),
      // Sample size (0 means non-constant size)
      u32(track2.samples.length),
      // Number of entries
      track2.samples.map((x) => u32(x.size))
      // Sample size table
    ]);
    stco = (track2) => {
      if (track2.finalizedChunks.length > 0 && last(track2.finalizedChunks).offset >= 2 ** 32) {
        return fullBox("co64", 0, 0, [
          u32(track2.finalizedChunks.length),
          // Number of entries
          track2.finalizedChunks.map((x) => u64(x.offset))
          // Chunk offset table
        ]);
      }
      return fullBox("stco", 0, 0, [
        u32(track2.finalizedChunks.length),
        // Number of entries
        track2.finalizedChunks.map((x) => u32(x.offset))
        // Chunk offset table
      ]);
    };
    ctts = (track2) => {
      return fullBox("ctts", 0, 0, [
        u32(track2.compositionTimeOffsetTable.length),
        // Number of entries
        track2.compositionTimeOffsetTable.map((x) => [
          // Time-to-sample table
          u32(x.sampleCount),
          // Sample count
          u32(x.sampleCompositionTimeOffset)
          // Sample offset
        ])
      ]);
    };
    mvex = (tracks) => {
      return box("mvex", null, tracks.map(trex));
    };
    trex = (track2) => {
      return fullBox("trex", 0, 0, [
        u32(track2.id),
        // Track ID
        u32(1),
        // Default sample description index
        u32(0),
        // Default sample duration
        u32(0),
        // Default sample size
        u32(0)
        // Default sample flags
      ]);
    };
    moof = (sequenceNumber, tracks) => {
      return box("moof", null, [
        mfhd(sequenceNumber),
        ...tracks.map(traf)
      ]);
    };
    mfhd = (sequenceNumber) => {
      return fullBox("mfhd", 0, 0, [
        u32(sequenceNumber)
        // Sequence number
      ]);
    };
    fragmentSampleFlags = (sample) => {
      let byte1 = 0;
      let byte2 = 0;
      let byte3 = 0;
      let byte4 = 0;
      let sampleIsDifferenceSample = sample.type === "delta";
      byte2 |= +sampleIsDifferenceSample;
      if (sampleIsDifferenceSample) {
        byte1 |= 1;
      } else {
        byte1 |= 2;
      }
      return byte1 << 24 | byte2 << 16 | byte3 << 8 | byte4;
    };
    traf = (track2) => {
      return box("traf", null, [
        tfhd(track2),
        tfdt(track2),
        trun(track2)
      ]);
    };
    tfhd = (track2) => {
      let tfFlags = 0;
      tfFlags |= 8;
      tfFlags |= 16;
      tfFlags |= 32;
      tfFlags |= 131072;
      let referenceSample = track2.currentChunk.samples[1] ?? track2.currentChunk.samples[0];
      let referenceSampleInfo = {
        duration: referenceSample.timescaleUnitsToNextSample,
        size: referenceSample.size,
        flags: fragmentSampleFlags(referenceSample)
      };
      return fullBox("tfhd", 0, tfFlags, [
        u32(track2.id),
        // Track ID
        u32(referenceSampleInfo.duration),
        // Default sample duration
        u32(referenceSampleInfo.size),
        // Default sample size
        u32(referenceSampleInfo.flags)
        // Default sample flags
      ]);
    };
    tfdt = (track2) => {
      return fullBox("tfdt", 1, 0, [
        u64(intoTimescale(track2.currentChunk.startTimestamp, track2.timescale))
        // Base Media Decode Time
      ]);
    };
    trun = (track2) => {
      let allSampleDurations = track2.currentChunk.samples.map((x) => x.timescaleUnitsToNextSample);
      let allSampleSizes = track2.currentChunk.samples.map((x) => x.size);
      let allSampleFlags = track2.currentChunk.samples.map(fragmentSampleFlags);
      let allSampleCompositionTimeOffsets = track2.currentChunk.samples.map((x) => intoTimescale(x.presentationTimestamp - x.decodeTimestamp, track2.timescale));
      let uniqueSampleDurations = new Set(allSampleDurations);
      let uniqueSampleSizes = new Set(allSampleSizes);
      let uniqueSampleFlags = new Set(allSampleFlags);
      let uniqueSampleCompositionTimeOffsets = new Set(allSampleCompositionTimeOffsets);
      let firstSampleFlagsPresent = uniqueSampleFlags.size === 2 && allSampleFlags[0] !== allSampleFlags[1];
      let sampleDurationPresent = uniqueSampleDurations.size > 1;
      let sampleSizePresent = uniqueSampleSizes.size > 1;
      let sampleFlagsPresent = !firstSampleFlagsPresent && uniqueSampleFlags.size > 1;
      let sampleCompositionTimeOffsetsPresent = uniqueSampleCompositionTimeOffsets.size > 1 || [...uniqueSampleCompositionTimeOffsets].some((x) => x !== 0);
      let flags = 0;
      flags |= 1;
      flags |= 4 * +firstSampleFlagsPresent;
      flags |= 256 * +sampleDurationPresent;
      flags |= 512 * +sampleSizePresent;
      flags |= 1024 * +sampleFlagsPresent;
      flags |= 2048 * +sampleCompositionTimeOffsetsPresent;
      return fullBox("trun", 1, flags, [
        u32(track2.currentChunk.samples.length),
        // Sample count
        u32(track2.currentChunk.offset - track2.currentChunk.moofOffset || 0),
        // Data offset
        firstSampleFlagsPresent ? u32(allSampleFlags[0]) : [],
        track2.currentChunk.samples.map((_, i) => [
          sampleDurationPresent ? u32(allSampleDurations[i]) : [],
          // Sample duration
          sampleSizePresent ? u32(allSampleSizes[i]) : [],
          // Sample size
          sampleFlagsPresent ? u32(allSampleFlags[i]) : [],
          // Sample flags
          // Sample composition time offsets
          sampleCompositionTimeOffsetsPresent ? i32(allSampleCompositionTimeOffsets[i]) : []
        ])
      ]);
    };
    mfra = (tracks) => {
      return box("mfra", null, [
        ...tracks.map(tfra),
        mfro()
      ]);
    };
    tfra = (track2, trackIndex) => {
      let version = 1;
      return fullBox("tfra", version, 0, [
        u32(track2.id),
        // Track ID
        u32(63),
        // This specifies that traf number, trun number and sample number are 32-bit ints
        u32(track2.finalizedChunks.length),
        // Number of entries
        track2.finalizedChunks.map((chunk) => [
          u64(intoTimescale(chunk.startTimestamp, track2.timescale)),
          // Time
          u64(chunk.moofOffset),
          // moof offset
          u32(trackIndex + 1),
          // traf number
          u32(1),
          // trun number
          u32(1)
          // Sample number
        ])
      ]);
    };
    mfro = () => {
      return fullBox("mfro", 0, 0, [
        // This value needs to be overwritten manually from the outside, where the actual size of the enclosing mfra box
        // is known
        u32(0)
        // Size
      ]);
    };
    VIDEO_CODEC_TO_BOX_NAME = {
      "avc": "avc1",
      "hevc": "hvc1",
      "vp9": "vp09",
      "av1": "av01"
    };
    VIDEO_CODEC_TO_CONFIGURATION_BOX = {
      "avc": avcC,
      "hevc": hvcC,
      "vp9": vpcC,
      "av1": av1C
    };
    AUDIO_CODEC_TO_BOX_NAME = {
      "aac": "mp4a",
      "opus": "Opus"
    };
    AUDIO_CODEC_TO_CONFIGURATION_BOX = {
      "aac": esds,
      "opus": dOps
    };
    Target = class {
    };
    ArrayBufferTarget = class extends Target {
      constructor() {
        super(...arguments);
        this.buffer = null;
      }
    };
    StreamTarget = class extends Target {
      constructor(options) {
        super();
        this.options = options;
        if (typeof options !== "object") {
          throw new TypeError("StreamTarget requires an options object to be passed to its constructor.");
        }
        if (options.onData) {
          if (typeof options.onData !== "function") {
            throw new TypeError("options.onData, when provided, must be a function.");
          }
          if (options.onData.length < 2) {
            throw new TypeError(
              "options.onData, when provided, must be a function that takes in at least two arguments (data and position). Ignoring the position argument, which specifies the byte offset at which the data is to be written, can lead to broken outputs."
            );
          }
        }
        if (options.chunked !== void 0 && typeof options.chunked !== "boolean") {
          throw new TypeError("options.chunked, when provided, must be a boolean.");
        }
        if (options.chunkSize !== void 0 && (!Number.isInteger(options.chunkSize) || options.chunkSize < 1024)) {
          throw new TypeError("options.chunkSize, when provided, must be an integer and not smaller than 1024.");
        }
      }
    };
    FileSystemWritableFileStreamTarget = class extends Target {
      constructor(stream, options) {
        super();
        this.stream = stream;
        this.options = options;
        if (!(stream instanceof FileSystemWritableFileStream)) {
          throw new TypeError("FileSystemWritableFileStreamTarget requires a FileSystemWritableFileStream instance.");
        }
        if (options !== void 0 && typeof options !== "object") {
          throw new TypeError("FileSystemWritableFileStreamTarget's options, when provided, must be an object.");
        }
        if (options) {
          if (options.chunkSize !== void 0 && (!Number.isInteger(options.chunkSize) || options.chunkSize <= 0)) {
            throw new TypeError("options.chunkSize, when provided, must be a positive integer");
          }
        }
      }
    };
    Writer = class {
      constructor() {
        this.pos = 0;
        __privateAdd(this, _helper, new Uint8Array(8));
        __privateAdd(this, _helperView, new DataView(__privateGet(this, _helper).buffer));
        this.offsets = /* @__PURE__ */ new WeakMap();
      }
      /** Sets the current position for future writes to a new one. */
      seek(newPos) {
        this.pos = newPos;
      }
      writeU32(value) {
        __privateGet(this, _helperView).setUint32(0, value, false);
        this.write(__privateGet(this, _helper).subarray(0, 4));
      }
      writeU64(value) {
        __privateGet(this, _helperView).setUint32(0, Math.floor(value / 2 ** 32), false);
        __privateGet(this, _helperView).setUint32(4, value, false);
        this.write(__privateGet(this, _helper).subarray(0, 8));
      }
      writeAscii(text) {
        for (let i = 0; i < text.length; i++) {
          __privateGet(this, _helperView).setUint8(i % 8, text.charCodeAt(i));
          if (i % 8 === 7)
            this.write(__privateGet(this, _helper));
        }
        if (text.length % 8 !== 0) {
          this.write(__privateGet(this, _helper).subarray(0, text.length % 8));
        }
      }
      writeBox(box2) {
        this.offsets.set(box2, this.pos);
        if (box2.contents && !box2.children) {
          this.writeBoxHeader(box2, box2.size ?? box2.contents.byteLength + 8);
          this.write(box2.contents);
        } else {
          let startPos = this.pos;
          this.writeBoxHeader(box2, 0);
          if (box2.contents)
            this.write(box2.contents);
          if (box2.children) {
            for (let child of box2.children)
              if (child)
                this.writeBox(child);
          }
          let endPos = this.pos;
          let size = box2.size ?? endPos - startPos;
          this.seek(startPos);
          this.writeBoxHeader(box2, size);
          this.seek(endPos);
        }
      }
      writeBoxHeader(box2, size) {
        this.writeU32(box2.largeSize ? 1 : size);
        this.writeAscii(box2.type);
        if (box2.largeSize)
          this.writeU64(size);
      }
      measureBoxHeader(box2) {
        return 8 + (box2.largeSize ? 8 : 0);
      }
      patchBox(box2) {
        let endPos = this.pos;
        this.seek(this.offsets.get(box2));
        this.writeBox(box2);
        this.seek(endPos);
      }
      measureBox(box2) {
        if (box2.contents && !box2.children) {
          let headerSize = this.measureBoxHeader(box2);
          return headerSize + box2.contents.byteLength;
        } else {
          let result = this.measureBoxHeader(box2);
          if (box2.contents)
            result += box2.contents.byteLength;
          if (box2.children) {
            for (let child of box2.children)
              if (child)
                result += this.measureBox(child);
          }
          return result;
        }
      }
    };
    _helper = /* @__PURE__ */ new WeakMap();
    _helperView = /* @__PURE__ */ new WeakMap();
    ArrayBufferTargetWriter = class extends Writer {
      constructor(target) {
        super();
        __privateAdd(this, _ensureSize);
        __privateAdd(this, _target, void 0);
        __privateAdd(this, _buffer, new ArrayBuffer(2 ** 16));
        __privateAdd(this, _bytes, new Uint8Array(__privateGet(this, _buffer)));
        __privateAdd(this, _maxPos, 0);
        __privateSet(this, _target, target);
      }
      write(data) {
        __privateMethod(this, _ensureSize, ensureSize_fn).call(this, this.pos + data.byteLength);
        __privateGet(this, _bytes).set(data, this.pos);
        this.pos += data.byteLength;
        __privateSet(this, _maxPos, Math.max(__privateGet(this, _maxPos), this.pos));
      }
      finalize() {
        __privateMethod(this, _ensureSize, ensureSize_fn).call(this, this.pos);
        __privateGet(this, _target).buffer = __privateGet(this, _buffer).slice(0, Math.max(__privateGet(this, _maxPos), this.pos));
      }
    };
    _target = /* @__PURE__ */ new WeakMap();
    _buffer = /* @__PURE__ */ new WeakMap();
    _bytes = /* @__PURE__ */ new WeakMap();
    _maxPos = /* @__PURE__ */ new WeakMap();
    _ensureSize = /* @__PURE__ */ new WeakSet();
    ensureSize_fn = function(size) {
      let newLength = __privateGet(this, _buffer).byteLength;
      while (newLength < size)
        newLength *= 2;
      if (newLength === __privateGet(this, _buffer).byteLength)
        return;
      let newBuffer = new ArrayBuffer(newLength);
      let newBytes = new Uint8Array(newBuffer);
      newBytes.set(__privateGet(this, _bytes), 0);
      __privateSet(this, _buffer, newBuffer);
      __privateSet(this, _bytes, newBytes);
    };
    DEFAULT_CHUNK_SIZE = 2 ** 24;
    MAX_CHUNKS_AT_ONCE = 2;
    StreamTargetWriter = class extends Writer {
      constructor(target) {
        super();
        __privateAdd(this, _writeDataIntoChunks);
        __privateAdd(this, _insertSectionIntoChunk);
        __privateAdd(this, _createChunk);
        __privateAdd(this, _flushChunks);
        __privateAdd(this, _target2, void 0);
        __privateAdd(this, _sections, []);
        __privateAdd(this, _chunked, void 0);
        __privateAdd(this, _chunkSize, void 0);
        __privateAdd(this, _chunks, []);
        __privateSet(this, _target2, target);
        __privateSet(this, _chunked, target.options?.chunked ?? false);
        __privateSet(this, _chunkSize, target.options?.chunkSize ?? DEFAULT_CHUNK_SIZE);
      }
      write(data) {
        __privateGet(this, _sections).push({
          data: data.slice(),
          start: this.pos
        });
        this.pos += data.byteLength;
      }
      flush() {
        if (__privateGet(this, _sections).length === 0)
          return;
        let chunks = [];
        let sorted = [...__privateGet(this, _sections)].sort((a, b) => a.start - b.start);
        chunks.push({
          start: sorted[0].start,
          size: sorted[0].data.byteLength
        });
        for (let i = 1; i < sorted.length; i++) {
          let lastChunk = chunks[chunks.length - 1];
          let section = sorted[i];
          if (section.start <= lastChunk.start + lastChunk.size) {
            lastChunk.size = Math.max(lastChunk.size, section.start + section.data.byteLength - lastChunk.start);
          } else {
            chunks.push({
              start: section.start,
              size: section.data.byteLength
            });
          }
        }
        for (let chunk of chunks) {
          chunk.data = new Uint8Array(chunk.size);
          for (let section of __privateGet(this, _sections)) {
            if (chunk.start <= section.start && section.start < chunk.start + chunk.size) {
              chunk.data.set(section.data, section.start - chunk.start);
            }
          }
          if (__privateGet(this, _chunked)) {
            __privateMethod(this, _writeDataIntoChunks, writeDataIntoChunks_fn).call(this, chunk.data, chunk.start);
            __privateMethod(this, _flushChunks, flushChunks_fn).call(this);
          } else {
            __privateGet(this, _target2).options.onData?.(chunk.data, chunk.start);
          }
        }
        __privateGet(this, _sections).length = 0;
      }
      finalize() {
        if (__privateGet(this, _chunked)) {
          __privateMethod(this, _flushChunks, flushChunks_fn).call(this, true);
        }
      }
    };
    _target2 = /* @__PURE__ */ new WeakMap();
    _sections = /* @__PURE__ */ new WeakMap();
    _chunked = /* @__PURE__ */ new WeakMap();
    _chunkSize = /* @__PURE__ */ new WeakMap();
    _chunks = /* @__PURE__ */ new WeakMap();
    _writeDataIntoChunks = /* @__PURE__ */ new WeakSet();
    writeDataIntoChunks_fn = function(data, position) {
      let chunkIndex = __privateGet(this, _chunks).findIndex((x) => x.start <= position && position < x.start + __privateGet(this, _chunkSize));
      if (chunkIndex === -1)
        chunkIndex = __privateMethod(this, _createChunk, createChunk_fn).call(this, position);
      let chunk = __privateGet(this, _chunks)[chunkIndex];
      let relativePosition = position - chunk.start;
      let toWrite = data.subarray(0, Math.min(__privateGet(this, _chunkSize) - relativePosition, data.byteLength));
      chunk.data.set(toWrite, relativePosition);
      let section = {
        start: relativePosition,
        end: relativePosition + toWrite.byteLength
      };
      __privateMethod(this, _insertSectionIntoChunk, insertSectionIntoChunk_fn).call(this, chunk, section);
      if (chunk.written[0].start === 0 && chunk.written[0].end === __privateGet(this, _chunkSize)) {
        chunk.shouldFlush = true;
      }
      if (__privateGet(this, _chunks).length > MAX_CHUNKS_AT_ONCE) {
        for (let i = 0; i < __privateGet(this, _chunks).length - 1; i++) {
          __privateGet(this, _chunks)[i].shouldFlush = true;
        }
        __privateMethod(this, _flushChunks, flushChunks_fn).call(this);
      }
      if (toWrite.byteLength < data.byteLength) {
        __privateMethod(this, _writeDataIntoChunks, writeDataIntoChunks_fn).call(this, data.subarray(toWrite.byteLength), position + toWrite.byteLength);
      }
    };
    _insertSectionIntoChunk = /* @__PURE__ */ new WeakSet();
    insertSectionIntoChunk_fn = function(chunk, section) {
      let low = 0;
      let high = chunk.written.length - 1;
      let index = -1;
      while (low <= high) {
        let mid = Math.floor(low + (high - low + 1) / 2);
        if (chunk.written[mid].start <= section.start) {
          low = mid + 1;
          index = mid;
        } else {
          high = mid - 1;
        }
      }
      chunk.written.splice(index + 1, 0, section);
      if (index === -1 || chunk.written[index].end < section.start)
        index++;
      while (index < chunk.written.length - 1 && chunk.written[index].end >= chunk.written[index + 1].start) {
        chunk.written[index].end = Math.max(chunk.written[index].end, chunk.written[index + 1].end);
        chunk.written.splice(index + 1, 1);
      }
    };
    _createChunk = /* @__PURE__ */ new WeakSet();
    createChunk_fn = function(includesPosition) {
      let start = Math.floor(includesPosition / __privateGet(this, _chunkSize)) * __privateGet(this, _chunkSize);
      let chunk = {
        start,
        data: new Uint8Array(__privateGet(this, _chunkSize)),
        written: [],
        shouldFlush: false
      };
      __privateGet(this, _chunks).push(chunk);
      __privateGet(this, _chunks).sort((a, b) => a.start - b.start);
      return __privateGet(this, _chunks).indexOf(chunk);
    };
    _flushChunks = /* @__PURE__ */ new WeakSet();
    flushChunks_fn = function(force = false) {
      for (let i = 0; i < __privateGet(this, _chunks).length; i++) {
        let chunk = __privateGet(this, _chunks)[i];
        if (!chunk.shouldFlush && !force)
          continue;
        for (let section of chunk.written) {
          __privateGet(this, _target2).options.onData?.(
            chunk.data.subarray(section.start, section.end),
            chunk.start + section.start
          );
        }
        __privateGet(this, _chunks).splice(i--, 1);
      }
    };
    FileSystemWritableFileStreamTargetWriter = class extends StreamTargetWriter {
      constructor(target) {
        super(new StreamTarget({
          onData: (data, position) => target.stream.write({
            type: "write",
            data,
            position
          }),
          chunked: true,
          chunkSize: target.options?.chunkSize
        }));
      }
    };
    GLOBAL_TIMESCALE = 1e3;
    SUPPORTED_VIDEO_CODECS = ["avc", "hevc", "vp9", "av1"];
    SUPPORTED_AUDIO_CODECS = ["aac", "opus"];
    TIMESTAMP_OFFSET = 2082844800;
    FIRST_TIMESTAMP_BEHAVIORS = ["strict", "offset", "cross-track-offset"];
    Muxer = class {
      constructor(options) {
        __privateAdd(this, _validateOptions);
        __privateAdd(this, _writeHeader);
        __privateAdd(this, _computeMoovSizeUpperBound);
        __privateAdd(this, _prepareTracks);
        __privateAdd(this, _generateMpeg4AudioSpecificConfig);
        __privateAdd(this, _createSampleForTrack);
        __privateAdd(this, _addSampleToTrack);
        __privateAdd(this, _validateTimestamp);
        __privateAdd(this, _finalizeCurrentChunk);
        __privateAdd(this, _finalizeFragment);
        __privateAdd(this, _maybeFlushStreamingTargetWriter);
        __privateAdd(this, _ensureNotFinalized);
        __privateAdd(this, _options, void 0);
        __privateAdd(this, _writer, void 0);
        __privateAdd(this, _ftypSize, void 0);
        __privateAdd(this, _mdat, void 0);
        __privateAdd(this, _videoTrack, null);
        __privateAdd(this, _audioTrack, null);
        __privateAdd(this, _creationTime, Math.floor(Date.now() / 1e3) + TIMESTAMP_OFFSET);
        __privateAdd(this, _finalizedChunks, []);
        __privateAdd(this, _nextFragmentNumber, 1);
        __privateAdd(this, _videoSampleQueue, []);
        __privateAdd(this, _audioSampleQueue, []);
        __privateAdd(this, _finalized, false);
        __privateMethod(this, _validateOptions, validateOptions_fn).call(this, options);
        options.video = deepClone(options.video);
        options.audio = deepClone(options.audio);
        options.fastStart = deepClone(options.fastStart);
        this.target = options.target;
        __privateSet(this, _options, {
          firstTimestampBehavior: "strict",
          ...options
        });
        if (options.target instanceof ArrayBufferTarget) {
          __privateSet(this, _writer, new ArrayBufferTargetWriter(options.target));
        } else if (options.target instanceof StreamTarget) {
          __privateSet(this, _writer, new StreamTargetWriter(options.target));
        } else if (options.target instanceof FileSystemWritableFileStreamTarget) {
          __privateSet(this, _writer, new FileSystemWritableFileStreamTargetWriter(options.target));
        } else {
          throw new Error(`Invalid target: ${options.target}`);
        }
        __privateMethod(this, _prepareTracks, prepareTracks_fn).call(this);
        __privateMethod(this, _writeHeader, writeHeader_fn).call(this);
      }
      addVideoChunk(sample, meta, timestamp, compositionTimeOffset) {
        if (!(sample instanceof EncodedVideoChunk)) {
          throw new TypeError("addVideoChunk's first argument (sample) must be of type EncodedVideoChunk.");
        }
        if (meta && typeof meta !== "object") {
          throw new TypeError("addVideoChunk's second argument (meta), when provided, must be an object.");
        }
        if (timestamp !== void 0 && (!Number.isFinite(timestamp) || timestamp < 0)) {
          throw new TypeError(
            "addVideoChunk's third argument (timestamp), when provided, must be a non-negative real number."
          );
        }
        if (compositionTimeOffset !== void 0 && !Number.isFinite(compositionTimeOffset)) {
          throw new TypeError(
            "addVideoChunk's fourth argument (compositionTimeOffset), when provided, must be a real number."
          );
        }
        let data = new Uint8Array(sample.byteLength);
        sample.copyTo(data);
        this.addVideoChunkRaw(
          data,
          sample.type,
          timestamp ?? sample.timestamp,
          sample.duration,
          meta,
          compositionTimeOffset
        );
      }
      addVideoChunkRaw(data, type, timestamp, duration, meta, compositionTimeOffset) {
        if (!(data instanceof Uint8Array)) {
          throw new TypeError("addVideoChunkRaw's first argument (data) must be an instance of Uint8Array.");
        }
        if (type !== "key" && type !== "delta") {
          throw new TypeError("addVideoChunkRaw's second argument (type) must be either 'key' or 'delta'.");
        }
        if (!Number.isFinite(timestamp) || timestamp < 0) {
          throw new TypeError("addVideoChunkRaw's third argument (timestamp) must be a non-negative real number.");
        }
        if (!Number.isFinite(duration) || duration < 0) {
          throw new TypeError("addVideoChunkRaw's fourth argument (duration) must be a non-negative real number.");
        }
        if (meta && typeof meta !== "object") {
          throw new TypeError("addVideoChunkRaw's fifth argument (meta), when provided, must be an object.");
        }
        if (compositionTimeOffset !== void 0 && !Number.isFinite(compositionTimeOffset)) {
          throw new TypeError(
            "addVideoChunkRaw's sixth argument (compositionTimeOffset), when provided, must be a real number."
          );
        }
        __privateMethod(this, _ensureNotFinalized, ensureNotFinalized_fn).call(this);
        if (!__privateGet(this, _options).video)
          throw new Error("No video track declared.");
        if (typeof __privateGet(this, _options).fastStart === "object" && __privateGet(this, _videoTrack).samples.length === __privateGet(this, _options).fastStart.expectedVideoChunks) {
          throw new Error(`Cannot add more video chunks than specified in 'fastStart' (${__privateGet(this, _options).fastStart.expectedVideoChunks}).`);
        }
        let videoSample = __privateMethod(this, _createSampleForTrack, createSampleForTrack_fn).call(this, __privateGet(this, _videoTrack), data, type, timestamp, duration, meta, compositionTimeOffset);
        if (__privateGet(this, _options).fastStart === "fragmented" && __privateGet(this, _audioTrack)) {
          while (__privateGet(this, _audioSampleQueue).length > 0 && __privateGet(this, _audioSampleQueue)[0].decodeTimestamp <= videoSample.decodeTimestamp) {
            let audioSample = __privateGet(this, _audioSampleQueue).shift();
            __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _audioTrack), audioSample);
          }
          if (videoSample.decodeTimestamp <= __privateGet(this, _audioTrack).lastDecodeTimestamp) {
            __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _videoTrack), videoSample);
          } else {
            __privateGet(this, _videoSampleQueue).push(videoSample);
          }
        } else {
          __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _videoTrack), videoSample);
        }
      }
      addAudioChunk(sample, meta, timestamp) {
        if (!(sample instanceof EncodedAudioChunk)) {
          throw new TypeError("addAudioChunk's first argument (sample) must be of type EncodedAudioChunk.");
        }
        if (meta && typeof meta !== "object") {
          throw new TypeError("addAudioChunk's second argument (meta), when provided, must be an object.");
        }
        if (timestamp !== void 0 && (!Number.isFinite(timestamp) || timestamp < 0)) {
          throw new TypeError(
            "addAudioChunk's third argument (timestamp), when provided, must be a non-negative real number."
          );
        }
        let data = new Uint8Array(sample.byteLength);
        sample.copyTo(data);
        this.addAudioChunkRaw(data, sample.type, timestamp ?? sample.timestamp, sample.duration, meta);
      }
      addAudioChunkRaw(data, type, timestamp, duration, meta) {
        if (!(data instanceof Uint8Array)) {
          throw new TypeError("addAudioChunkRaw's first argument (data) must be an instance of Uint8Array.");
        }
        if (type !== "key" && type !== "delta") {
          throw new TypeError("addAudioChunkRaw's second argument (type) must be either 'key' or 'delta'.");
        }
        if (!Number.isFinite(timestamp) || timestamp < 0) {
          throw new TypeError("addAudioChunkRaw's third argument (timestamp) must be a non-negative real number.");
        }
        if (!Number.isFinite(duration) || duration < 0) {
          throw new TypeError("addAudioChunkRaw's fourth argument (duration) must be a non-negative real number.");
        }
        if (meta && typeof meta !== "object") {
          throw new TypeError("addAudioChunkRaw's fifth argument (meta), when provided, must be an object.");
        }
        __privateMethod(this, _ensureNotFinalized, ensureNotFinalized_fn).call(this);
        if (!__privateGet(this, _options).audio)
          throw new Error("No audio track declared.");
        if (typeof __privateGet(this, _options).fastStart === "object" && __privateGet(this, _audioTrack).samples.length === __privateGet(this, _options).fastStart.expectedAudioChunks) {
          throw new Error(`Cannot add more audio chunks than specified in 'fastStart' (${__privateGet(this, _options).fastStart.expectedAudioChunks}).`);
        }
        let audioSample = __privateMethod(this, _createSampleForTrack, createSampleForTrack_fn).call(this, __privateGet(this, _audioTrack), data, type, timestamp, duration, meta);
        if (__privateGet(this, _options).fastStart === "fragmented" && __privateGet(this, _videoTrack)) {
          while (__privateGet(this, _videoSampleQueue).length > 0 && __privateGet(this, _videoSampleQueue)[0].decodeTimestamp <= audioSample.decodeTimestamp) {
            let videoSample = __privateGet(this, _videoSampleQueue).shift();
            __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _videoTrack), videoSample);
          }
          if (audioSample.decodeTimestamp <= __privateGet(this, _videoTrack).lastDecodeTimestamp) {
            __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _audioTrack), audioSample);
          } else {
            __privateGet(this, _audioSampleQueue).push(audioSample);
          }
        } else {
          __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _audioTrack), audioSample);
        }
      }
      /** Finalizes the file, making it ready for use. Must be called after all video and audio chunks have been added. */
      finalize() {
        if (__privateGet(this, _finalized)) {
          throw new Error("Cannot finalize a muxer more than once.");
        }
        if (__privateGet(this, _options).fastStart === "fragmented") {
          for (let videoSample of __privateGet(this, _videoSampleQueue))
            __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _videoTrack), videoSample);
          for (let audioSample of __privateGet(this, _audioSampleQueue))
            __privateMethod(this, _addSampleToTrack, addSampleToTrack_fn).call(this, __privateGet(this, _audioTrack), audioSample);
          __privateMethod(this, _finalizeFragment, finalizeFragment_fn).call(this, false);
        } else {
          if (__privateGet(this, _videoTrack))
            __privateMethod(this, _finalizeCurrentChunk, finalizeCurrentChunk_fn).call(this, __privateGet(this, _videoTrack));
          if (__privateGet(this, _audioTrack))
            __privateMethod(this, _finalizeCurrentChunk, finalizeCurrentChunk_fn).call(this, __privateGet(this, _audioTrack));
        }
        let tracks = [__privateGet(this, _videoTrack), __privateGet(this, _audioTrack)].filter(Boolean);
        if (__privateGet(this, _options).fastStart === "in-memory") {
          let mdatSize;
          for (let i = 0; i < 2; i++) {
            let movieBox2 = moov(tracks, __privateGet(this, _creationTime));
            let movieBoxSize = __privateGet(this, _writer).measureBox(movieBox2);
            mdatSize = __privateGet(this, _writer).measureBox(__privateGet(this, _mdat));
            let currentChunkPos = __privateGet(this, _writer).pos + movieBoxSize + mdatSize;
            for (let chunk of __privateGet(this, _finalizedChunks)) {
              chunk.offset = currentChunkPos;
              for (let { data } of chunk.samples) {
                currentChunkPos += data.byteLength;
                mdatSize += data.byteLength;
              }
            }
            if (currentChunkPos < 2 ** 32)
              break;
            if (mdatSize >= 2 ** 32)
              __privateGet(this, _mdat).largeSize = true;
          }
          let movieBox = moov(tracks, __privateGet(this, _creationTime));
          __privateGet(this, _writer).writeBox(movieBox);
          __privateGet(this, _mdat).size = mdatSize;
          __privateGet(this, _writer).writeBox(__privateGet(this, _mdat));
          for (let chunk of __privateGet(this, _finalizedChunks)) {
            for (let sample of chunk.samples) {
              __privateGet(this, _writer).write(sample.data);
              sample.data = null;
            }
          }
        } else if (__privateGet(this, _options).fastStart === "fragmented") {
          let startPos = __privateGet(this, _writer).pos;
          let mfraBox = mfra(tracks);
          __privateGet(this, _writer).writeBox(mfraBox);
          let mfraBoxSize = __privateGet(this, _writer).pos - startPos;
          __privateGet(this, _writer).seek(__privateGet(this, _writer).pos - 4);
          __privateGet(this, _writer).writeU32(mfraBoxSize);
        } else {
          let mdatPos = __privateGet(this, _writer).offsets.get(__privateGet(this, _mdat));
          let mdatSize = __privateGet(this, _writer).pos - mdatPos;
          __privateGet(this, _mdat).size = mdatSize;
          __privateGet(this, _mdat).largeSize = mdatSize >= 2 ** 32;
          __privateGet(this, _writer).patchBox(__privateGet(this, _mdat));
          let movieBox = moov(tracks, __privateGet(this, _creationTime));
          if (typeof __privateGet(this, _options).fastStart === "object") {
            __privateGet(this, _writer).seek(__privateGet(this, _ftypSize));
            __privateGet(this, _writer).writeBox(movieBox);
            let remainingBytes = mdatPos - __privateGet(this, _writer).pos;
            __privateGet(this, _writer).writeBox(free(remainingBytes));
          } else {
            __privateGet(this, _writer).writeBox(movieBox);
          }
        }
        __privateMethod(this, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn).call(this);
        __privateGet(this, _writer).finalize();
        __privateSet(this, _finalized, true);
      }
    };
    _options = /* @__PURE__ */ new WeakMap();
    _writer = /* @__PURE__ */ new WeakMap();
    _ftypSize = /* @__PURE__ */ new WeakMap();
    _mdat = /* @__PURE__ */ new WeakMap();
    _videoTrack = /* @__PURE__ */ new WeakMap();
    _audioTrack = /* @__PURE__ */ new WeakMap();
    _creationTime = /* @__PURE__ */ new WeakMap();
    _finalizedChunks = /* @__PURE__ */ new WeakMap();
    _nextFragmentNumber = /* @__PURE__ */ new WeakMap();
    _videoSampleQueue = /* @__PURE__ */ new WeakMap();
    _audioSampleQueue = /* @__PURE__ */ new WeakMap();
    _finalized = /* @__PURE__ */ new WeakMap();
    _validateOptions = /* @__PURE__ */ new WeakSet();
    validateOptions_fn = function(options) {
      if (typeof options !== "object") {
        throw new TypeError("The muxer requires an options object to be passed to its constructor.");
      }
      if (!(options.target instanceof Target)) {
        throw new TypeError("The target must be provided and an instance of Target.");
      }
      if (options.video) {
        if (!SUPPORTED_VIDEO_CODECS.includes(options.video.codec)) {
          throw new TypeError(`Unsupported video codec: ${options.video.codec}`);
        }
        if (!Number.isInteger(options.video.width) || options.video.width <= 0) {
          throw new TypeError(`Invalid video width: ${options.video.width}. Must be a positive integer.`);
        }
        if (!Number.isInteger(options.video.height) || options.video.height <= 0) {
          throw new TypeError(`Invalid video height: ${options.video.height}. Must be a positive integer.`);
        }
        const videoRotation = options.video.rotation;
        if (typeof videoRotation === "number" && ![0, 90, 180, 270].includes(videoRotation)) {
          throw new TypeError(`Invalid video rotation: ${videoRotation}. Has to be 0, 90, 180 or 270.`);
        } else if (Array.isArray(videoRotation) && (videoRotation.length !== 9 || videoRotation.some((value) => typeof value !== "number"))) {
          throw new TypeError(`Invalid video transformation matrix: ${videoRotation.join()}`);
        }
        if (options.video.frameRate !== void 0 && (!Number.isInteger(options.video.frameRate) || options.video.frameRate <= 0)) {
          throw new TypeError(
            `Invalid video frame rate: ${options.video.frameRate}. Must be a positive integer.`
          );
        }
      }
      if (options.audio) {
        if (!SUPPORTED_AUDIO_CODECS.includes(options.audio.codec)) {
          throw new TypeError(`Unsupported audio codec: ${options.audio.codec}`);
        }
        if (!Number.isInteger(options.audio.numberOfChannels) || options.audio.numberOfChannels <= 0) {
          throw new TypeError(
            `Invalid number of audio channels: ${options.audio.numberOfChannels}. Must be a positive integer.`
          );
        }
        if (!Number.isInteger(options.audio.sampleRate) || options.audio.sampleRate <= 0) {
          throw new TypeError(
            `Invalid audio sample rate: ${options.audio.sampleRate}. Must be a positive integer.`
          );
        }
      }
      if (options.firstTimestampBehavior && !FIRST_TIMESTAMP_BEHAVIORS.includes(options.firstTimestampBehavior)) {
        throw new TypeError(`Invalid first timestamp behavior: ${options.firstTimestampBehavior}`);
      }
      if (typeof options.fastStart === "object") {
        if (options.video) {
          if (options.fastStart.expectedVideoChunks === void 0) {
            throw new TypeError(`'fastStart' is an object but is missing property 'expectedVideoChunks'.`);
          } else if (!Number.isInteger(options.fastStart.expectedVideoChunks) || options.fastStart.expectedVideoChunks < 0) {
            throw new TypeError(`'expectedVideoChunks' must be a non-negative integer.`);
          }
        }
        if (options.audio) {
          if (options.fastStart.expectedAudioChunks === void 0) {
            throw new TypeError(`'fastStart' is an object but is missing property 'expectedAudioChunks'.`);
          } else if (!Number.isInteger(options.fastStart.expectedAudioChunks) || options.fastStart.expectedAudioChunks < 0) {
            throw new TypeError(`'expectedAudioChunks' must be a non-negative integer.`);
          }
        }
      } else if (![false, "in-memory", "fragmented"].includes(options.fastStart)) {
        throw new TypeError(`'fastStart' option must be false, 'in-memory', 'fragmented' or an object.`);
      }
      if (options.minFragmentDuration !== void 0 && (!Number.isFinite(options.minFragmentDuration) || options.minFragmentDuration < 0)) {
        throw new TypeError(`'minFragmentDuration' must be a non-negative number.`);
      }
    };
    _writeHeader = /* @__PURE__ */ new WeakSet();
    writeHeader_fn = function() {
      __privateGet(this, _writer).writeBox(ftyp({
        holdsAvc: __privateGet(this, _options).video?.codec === "avc",
        fragmented: __privateGet(this, _options).fastStart === "fragmented"
      }));
      __privateSet(this, _ftypSize, __privateGet(this, _writer).pos);
      if (__privateGet(this, _options).fastStart === "in-memory") {
        __privateSet(this, _mdat, mdat(false));
      } else if (__privateGet(this, _options).fastStart === "fragmented") {
      } else {
        if (typeof __privateGet(this, _options).fastStart === "object") {
          let moovSizeUpperBound = __privateMethod(this, _computeMoovSizeUpperBound, computeMoovSizeUpperBound_fn).call(this);
          __privateGet(this, _writer).seek(__privateGet(this, _writer).pos + moovSizeUpperBound);
        }
        __privateSet(this, _mdat, mdat(true));
        __privateGet(this, _writer).writeBox(__privateGet(this, _mdat));
      }
      __privateMethod(this, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn).call(this);
    };
    _computeMoovSizeUpperBound = /* @__PURE__ */ new WeakSet();
    computeMoovSizeUpperBound_fn = function() {
      if (typeof __privateGet(this, _options).fastStart !== "object")
        return;
      let upperBound = 0;
      let sampleCounts = [
        __privateGet(this, _options).fastStart.expectedVideoChunks,
        __privateGet(this, _options).fastStart.expectedAudioChunks
      ];
      for (let n of sampleCounts) {
        if (!n)
          continue;
        upperBound += (4 + 4) * Math.ceil(2 / 3 * n);
        upperBound += 4 * n;
        upperBound += (4 + 4 + 4) * Math.ceil(2 / 3 * n);
        upperBound += 4 * n;
        upperBound += 8 * n;
      }
      upperBound += 4096;
      return upperBound;
    };
    _prepareTracks = /* @__PURE__ */ new WeakSet();
    prepareTracks_fn = function() {
      if (__privateGet(this, _options).video) {
        __privateSet(this, _videoTrack, {
          id: 1,
          info: {
            type: "video",
            codec: __privateGet(this, _options).video.codec,
            width: __privateGet(this, _options).video.width,
            height: __privateGet(this, _options).video.height,
            rotation: __privateGet(this, _options).video.rotation ?? 0,
            decoderConfig: null
          },
          // The fallback contains many common frame rates as factors
          timescale: __privateGet(this, _options).video.frameRate ?? 57600,
          samples: [],
          finalizedChunks: [],
          currentChunk: null,
          firstDecodeTimestamp: void 0,
          lastDecodeTimestamp: -1,
          timeToSampleTable: [],
          compositionTimeOffsetTable: [],
          lastTimescaleUnits: null,
          lastSample: null,
          compactlyCodedChunkTable: []
        });
      }
      if (__privateGet(this, _options).audio) {
        __privateSet(this, _audioTrack, {
          id: __privateGet(this, _options).video ? 2 : 1,
          info: {
            type: "audio",
            codec: __privateGet(this, _options).audio.codec,
            numberOfChannels: __privateGet(this, _options).audio.numberOfChannels,
            sampleRate: __privateGet(this, _options).audio.sampleRate,
            decoderConfig: null
          },
          timescale: __privateGet(this, _options).audio.sampleRate,
          samples: [],
          finalizedChunks: [],
          currentChunk: null,
          firstDecodeTimestamp: void 0,
          lastDecodeTimestamp: -1,
          timeToSampleTable: [],
          compositionTimeOffsetTable: [],
          lastTimescaleUnits: null,
          lastSample: null,
          compactlyCodedChunkTable: []
        });
        if (__privateGet(this, _options).audio.codec === "aac") {
          let guessedCodecPrivate = __privateMethod(this, _generateMpeg4AudioSpecificConfig, generateMpeg4AudioSpecificConfig_fn).call(
            this,
            2,
            // Object type for AAC-LC, since it's the most common
            __privateGet(this, _options).audio.sampleRate,
            __privateGet(this, _options).audio.numberOfChannels
          );
          __privateGet(this, _audioTrack).info.decoderConfig = {
            codec: __privateGet(this, _options).audio.codec,
            description: guessedCodecPrivate,
            numberOfChannels: __privateGet(this, _options).audio.numberOfChannels,
            sampleRate: __privateGet(this, _options).audio.sampleRate
          };
        }
      }
    };
    _generateMpeg4AudioSpecificConfig = /* @__PURE__ */ new WeakSet();
    generateMpeg4AudioSpecificConfig_fn = function(objectType, sampleRate, numberOfChannels) {
      let frequencyIndices = [96e3, 88200, 64e3, 48e3, 44100, 32e3, 24e3, 22050, 16e3, 12e3, 11025, 8e3, 7350];
      let frequencyIndex = frequencyIndices.indexOf(sampleRate);
      let channelConfig = numberOfChannels;
      let configBits = "";
      configBits += objectType.toString(2).padStart(5, "0");
      configBits += frequencyIndex.toString(2).padStart(4, "0");
      if (frequencyIndex === 15)
        configBits += sampleRate.toString(2).padStart(24, "0");
      configBits += channelConfig.toString(2).padStart(4, "0");
      let paddingLength = Math.ceil(configBits.length / 8) * 8;
      configBits = configBits.padEnd(paddingLength, "0");
      let configBytes = new Uint8Array(configBits.length / 8);
      for (let i = 0; i < configBits.length; i += 8) {
        configBytes[i / 8] = parseInt(configBits.slice(i, i + 8), 2);
      }
      return configBytes;
    };
    _createSampleForTrack = /* @__PURE__ */ new WeakSet();
    createSampleForTrack_fn = function(track2, data, type, timestamp, duration, meta, compositionTimeOffset) {
      let presentationTimestampInSeconds = timestamp / 1e6;
      let decodeTimestampInSeconds = (timestamp - (compositionTimeOffset ?? 0)) / 1e6;
      let durationInSeconds = duration / 1e6;
      let adjusted = __privateMethod(this, _validateTimestamp, validateTimestamp_fn).call(this, presentationTimestampInSeconds, decodeTimestampInSeconds, track2);
      presentationTimestampInSeconds = adjusted.presentationTimestamp;
      decodeTimestampInSeconds = adjusted.decodeTimestamp;
      if (meta?.decoderConfig) {
        if (track2.info.decoderConfig === null) {
          track2.info.decoderConfig = meta.decoderConfig;
        } else {
          Object.assign(track2.info.decoderConfig, meta.decoderConfig);
        }
      }
      let sample = {
        presentationTimestamp: presentationTimestampInSeconds,
        decodeTimestamp: decodeTimestampInSeconds,
        duration: durationInSeconds,
        data,
        size: data.byteLength,
        type,
        // Will be refined once the next sample comes in
        timescaleUnitsToNextSample: intoTimescale(durationInSeconds, track2.timescale)
      };
      return sample;
    };
    _addSampleToTrack = /* @__PURE__ */ new WeakSet();
    addSampleToTrack_fn = function(track2, sample) {
      if (__privateGet(this, _options).fastStart !== "fragmented") {
        track2.samples.push(sample);
      }
      const sampleCompositionTimeOffset = intoTimescale(sample.presentationTimestamp - sample.decodeTimestamp, track2.timescale);
      if (track2.lastTimescaleUnits !== null) {
        let timescaleUnits = intoTimescale(sample.decodeTimestamp, track2.timescale, false);
        let delta = Math.round(timescaleUnits - track2.lastTimescaleUnits);
        track2.lastTimescaleUnits += delta;
        track2.lastSample.timescaleUnitsToNextSample = delta;
        if (__privateGet(this, _options).fastStart !== "fragmented") {
          let lastTableEntry = last(track2.timeToSampleTable);
          if (lastTableEntry.sampleCount === 1) {
            lastTableEntry.sampleDelta = delta;
            lastTableEntry.sampleCount++;
          } else if (lastTableEntry.sampleDelta === delta) {
            lastTableEntry.sampleCount++;
          } else {
            lastTableEntry.sampleCount--;
            track2.timeToSampleTable.push({
              sampleCount: 2,
              sampleDelta: delta
            });
          }
          const lastCompositionTimeOffsetTableEntry = last(track2.compositionTimeOffsetTable);
          if (lastCompositionTimeOffsetTableEntry.sampleCompositionTimeOffset === sampleCompositionTimeOffset) {
            lastCompositionTimeOffsetTableEntry.sampleCount++;
          } else {
            track2.compositionTimeOffsetTable.push({
              sampleCount: 1,
              sampleCompositionTimeOffset
            });
          }
        }
      } else {
        track2.lastTimescaleUnits = 0;
        if (__privateGet(this, _options).fastStart !== "fragmented") {
          track2.timeToSampleTable.push({
            sampleCount: 1,
            sampleDelta: intoTimescale(sample.duration, track2.timescale)
          });
          track2.compositionTimeOffsetTable.push({
            sampleCount: 1,
            sampleCompositionTimeOffset
          });
        }
      }
      track2.lastSample = sample;
      let beginNewChunk = false;
      if (!track2.currentChunk) {
        beginNewChunk = true;
      } else {
        let currentChunkDuration = sample.presentationTimestamp - track2.currentChunk.startTimestamp;
        if (__privateGet(this, _options).fastStart === "fragmented") {
          let mostImportantTrack = __privateGet(this, _videoTrack) ?? __privateGet(this, _audioTrack);
          const chunkDuration = __privateGet(this, _options).minFragmentDuration ?? 1;
          if (track2 === mostImportantTrack && sample.type === "key" && currentChunkDuration >= chunkDuration) {
            beginNewChunk = true;
            __privateMethod(this, _finalizeFragment, finalizeFragment_fn).call(this);
          }
        } else {
          beginNewChunk = currentChunkDuration >= 0.5;
        }
      }
      if (beginNewChunk) {
        if (track2.currentChunk) {
          __privateMethod(this, _finalizeCurrentChunk, finalizeCurrentChunk_fn).call(this, track2);
        }
        track2.currentChunk = {
          startTimestamp: sample.presentationTimestamp,
          samples: []
        };
      }
      track2.currentChunk.samples.push(sample);
    };
    _validateTimestamp = /* @__PURE__ */ new WeakSet();
    validateTimestamp_fn = function(presentationTimestamp, decodeTimestamp, track2) {
      const strictTimestampBehavior = __privateGet(this, _options).firstTimestampBehavior === "strict";
      const noLastDecodeTimestamp = track2.lastDecodeTimestamp === -1;
      const timestampNonZero = decodeTimestamp !== 0;
      if (strictTimestampBehavior && noLastDecodeTimestamp && timestampNonZero) {
        throw new Error(
          `The first chunk for your media track must have a timestamp of 0 (received DTS=${decodeTimestamp}).Non-zero first timestamps are often caused by directly piping frames or audio data from a MediaStreamTrack into the encoder. Their timestamps are typically relative to the age of thedocument, which is probably what you want.

If you want to offset all timestamps of a track such that the first one is zero, set firstTimestampBehavior: 'offset' in the options.
`
        );
      } else if (__privateGet(this, _options).firstTimestampBehavior === "offset" || __privateGet(this, _options).firstTimestampBehavior === "cross-track-offset") {
        if (track2.firstDecodeTimestamp === void 0) {
          track2.firstDecodeTimestamp = decodeTimestamp;
        }
        let baseDecodeTimestamp;
        if (__privateGet(this, _options).firstTimestampBehavior === "offset") {
          baseDecodeTimestamp = track2.firstDecodeTimestamp;
        } else {
          baseDecodeTimestamp = Math.min(
            __privateGet(this, _videoTrack)?.firstDecodeTimestamp ?? Infinity,
            __privateGet(this, _audioTrack)?.firstDecodeTimestamp ?? Infinity
          );
        }
        decodeTimestamp -= baseDecodeTimestamp;
        presentationTimestamp -= baseDecodeTimestamp;
      }
      if (decodeTimestamp < track2.lastDecodeTimestamp) {
        throw new Error(
          `Timestamps must be monotonically increasing (DTS went from ${track2.lastDecodeTimestamp * 1e6} to ${decodeTimestamp * 1e6}).`
        );
      }
      track2.lastDecodeTimestamp = decodeTimestamp;
      return { presentationTimestamp, decodeTimestamp };
    };
    _finalizeCurrentChunk = /* @__PURE__ */ new WeakSet();
    finalizeCurrentChunk_fn = function(track2) {
      if (__privateGet(this, _options).fastStart === "fragmented") {
        throw new Error("Can't finalize individual chunks if 'fastStart' is set to 'fragmented'.");
      }
      if (!track2.currentChunk)
        return;
      track2.finalizedChunks.push(track2.currentChunk);
      __privateGet(this, _finalizedChunks).push(track2.currentChunk);
      if (track2.compactlyCodedChunkTable.length === 0 || last(track2.compactlyCodedChunkTable).samplesPerChunk !== track2.currentChunk.samples.length) {
        track2.compactlyCodedChunkTable.push({
          firstChunk: track2.finalizedChunks.length,
          // 1-indexed
          samplesPerChunk: track2.currentChunk.samples.length
        });
      }
      if (__privateGet(this, _options).fastStart === "in-memory") {
        track2.currentChunk.offset = 0;
        return;
      }
      track2.currentChunk.offset = __privateGet(this, _writer).pos;
      for (let sample of track2.currentChunk.samples) {
        __privateGet(this, _writer).write(sample.data);
        sample.data = null;
      }
      __privateMethod(this, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn).call(this);
    };
    _finalizeFragment = /* @__PURE__ */ new WeakSet();
    finalizeFragment_fn = function(flushStreamingWriter = true) {
      if (__privateGet(this, _options).fastStart !== "fragmented") {
        throw new Error("Can't finalize a fragment unless 'fastStart' is set to 'fragmented'.");
      }
      let tracks = [__privateGet(this, _videoTrack), __privateGet(this, _audioTrack)].filter((track2) => track2 && track2.currentChunk);
      if (tracks.length === 0)
        return;
      let fragmentNumber = __privateWrapper(this, _nextFragmentNumber)._++;
      if (fragmentNumber === 1) {
        let movieBox = moov(tracks, __privateGet(this, _creationTime), true);
        __privateGet(this, _writer).writeBox(movieBox);
      }
      let moofOffset = __privateGet(this, _writer).pos;
      let moofBox = moof(fragmentNumber, tracks);
      __privateGet(this, _writer).writeBox(moofBox);
      {
        let mdatBox = mdat(false);
        let totalTrackSampleSize = 0;
        for (let track2 of tracks) {
          for (let sample of track2.currentChunk.samples) {
            totalTrackSampleSize += sample.size;
          }
        }
        let mdatSize = __privateGet(this, _writer).measureBox(mdatBox) + totalTrackSampleSize;
        if (mdatSize >= 2 ** 32) {
          mdatBox.largeSize = true;
          mdatSize = __privateGet(this, _writer).measureBox(mdatBox) + totalTrackSampleSize;
        }
        mdatBox.size = mdatSize;
        __privateGet(this, _writer).writeBox(mdatBox);
      }
      for (let track2 of tracks) {
        track2.currentChunk.offset = __privateGet(this, _writer).pos;
        track2.currentChunk.moofOffset = moofOffset;
        for (let sample of track2.currentChunk.samples) {
          __privateGet(this, _writer).write(sample.data);
          sample.data = null;
        }
      }
      let endPos = __privateGet(this, _writer).pos;
      __privateGet(this, _writer).seek(__privateGet(this, _writer).offsets.get(moofBox));
      let newMoofBox = moof(fragmentNumber, tracks);
      __privateGet(this, _writer).writeBox(newMoofBox);
      __privateGet(this, _writer).seek(endPos);
      for (let track2 of tracks) {
        track2.finalizedChunks.push(track2.currentChunk);
        __privateGet(this, _finalizedChunks).push(track2.currentChunk);
        track2.currentChunk = null;
      }
      if (flushStreamingWriter) {
        __privateMethod(this, _maybeFlushStreamingTargetWriter, maybeFlushStreamingTargetWriter_fn).call(this);
      }
    };
    _maybeFlushStreamingTargetWriter = /* @__PURE__ */ new WeakSet();
    maybeFlushStreamingTargetWriter_fn = function() {
      if (__privateGet(this, _writer) instanceof StreamTargetWriter) {
        __privateGet(this, _writer).flush();
      }
    };
    _ensureNotFinalized = /* @__PURE__ */ new WeakSet();
    ensureNotFinalized_fn = function() {
      if (__privateGet(this, _finalized)) {
        throw new Error("Cannot add new video or audio chunks after the file has been finalized.");
      }
    };
  }
});

// node_modules/webm-muxer/build/webm-muxer.mjs
var __accessCheck2, __privateGet2, __privateAdd2, __privateSet2, __privateMethod2, EBMLFloat32, EBMLFloat64, measureUnsignedInt, measureEBMLVarInt, readBits, writeBits, Target2, ArrayBufferTarget2, StreamTarget2, FileSystemWritableFileStreamTarget2, _helper2, _helperView2, _writeByte, writeByte_fn, _writeFloat32, writeFloat32_fn, _writeFloat64, writeFloat64_fn, _writeUnsignedInt, writeUnsignedInt_fn, _writeString, writeString_fn, Writer2, _target3, _buffer2, _bytes2, _ensureSize2, ensureSize_fn2, ArrayBufferTargetWriter2, _trackingWrites, _trackedWrites, _trackedStart, _trackedEnd, BaseStreamTargetWriter, DEFAULT_CHUNK_SIZE2, MAX_CHUNKS_AT_ONCE2, _sections2, _lastFlushEnd, _ensureMonotonicity, _chunked2, _chunkSize2, _chunks2, _writeDataIntoChunks2, writeDataIntoChunks_fn2, _insertSectionIntoChunk2, insertSectionIntoChunk_fn2, _createChunk2, createChunk_fn2, _flushChunks2, flushChunks_fn2, StreamTargetWriter2, FileSystemWritableFileStreamTargetWriter2, VIDEO_TRACK_NUMBER, AUDIO_TRACK_NUMBER, SUBTITLE_TRACK_NUMBER, VIDEO_TRACK_TYPE, AUDIO_TRACK_TYPE, SUBTITLE_TRACK_TYPE, MAX_CHUNK_LENGTH_MS, CODEC_PRIVATE_MAX_SIZE, APP_NAME, SEGMENT_SIZE_BYTES, CLUSTER_SIZE_BYTES, FIRST_TIMESTAMP_BEHAVIORS2, _options2, _writer2, _segment, _segmentInfo, _seekHead, _tracksElement, _segmentDuration, _colourElement, _videoCodecPrivate, _audioCodecPrivate, _subtitleCodecPrivate, _cues, _currentCluster, _currentClusterTimestamp, _duration, _videoChunkQueue, _audioChunkQueue, _subtitleChunkQueue, _firstVideoTimestamp, _firstAudioTimestamp, _lastVideoTimestamp, _lastAudioTimestamp, _lastSubtitleTimestamp, _colorSpace, _finalized2, _validateOptions2, validateOptions_fn2, _createFileHeader, createFileHeader_fn, _writeEBMLHeader, writeEBMLHeader_fn, _createCodecPrivatePlaceholders, createCodecPrivatePlaceholders_fn, _createColourElement, createColourElement_fn, _createSeekHead, createSeekHead_fn, _createSegmentInfo, createSegmentInfo_fn, _createTracks, createTracks_fn, _createSegment, createSegment_fn, _createCues, createCues_fn, _maybeFlushStreamingTargetWriter2, maybeFlushStreamingTargetWriter_fn2, _segmentDataOffset, segmentDataOffset_get, _writeVideoDecoderConfig, writeVideoDecoderConfig_fn, _fixVP9ColorSpace, fixVP9ColorSpace_fn, _writeSubtitleChunks, writeSubtitleChunks_fn, _createInternalChunk, createInternalChunk_fn, _validateTimestamp2, validateTimestamp_fn2, _writeBlock, writeBlock_fn, _createCodecPrivateElement, createCodecPrivateElement_fn, _writeCodecPrivate, writeCodecPrivate_fn, _createNewCluster, createNewCluster_fn, _finalizeCurrentCluster, finalizeCurrentCluster_fn, _ensureNotFinalized2, ensureNotFinalized_fn2, Muxer2, timestampRegex, textEncoder, _options22, _config, _preambleSeen, _preambleBytes, _preambleEmitted, _parseTimestamp, parseTimestamp_fn, _formatTimestamp, formatTimestamp_fn;
var init_webm_muxer = __esm({
  "node_modules/webm-muxer/build/webm-muxer.mjs"() {
    __accessCheck2 = (obj, member, msg) => {
      if (!member.has(obj))
        throw TypeError("Cannot " + msg);
    };
    __privateGet2 = (obj, member, getter) => {
      __accessCheck2(obj, member, "read from private field");
      return getter ? getter.call(obj) : member.get(obj);
    };
    __privateAdd2 = (obj, member, value) => {
      if (member.has(obj))
        throw TypeError("Cannot add the same private member more than once");
      member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
    };
    __privateSet2 = (obj, member, value, setter) => {
      __accessCheck2(obj, member, "write to private field");
      setter ? setter.call(obj, value) : member.set(obj, value);
      return value;
    };
    __privateMethod2 = (obj, member, method) => {
      __accessCheck2(obj, member, "access private method");
      return method;
    };
    EBMLFloat32 = class {
      constructor(value) {
        this.value = value;
      }
    };
    EBMLFloat64 = class {
      constructor(value) {
        this.value = value;
      }
    };
    measureUnsignedInt = (value) => {
      if (value < 1 << 8) {
        return 1;
      } else if (value < 1 << 16) {
        return 2;
      } else if (value < 1 << 24) {
        return 3;
      } else if (value < 2 ** 32) {
        return 4;
      } else if (value < 2 ** 40) {
        return 5;
      } else {
        return 6;
      }
    };
    measureEBMLVarInt = (value) => {
      if (value < (1 << 7) - 1) {
        return 1;
      } else if (value < (1 << 14) - 1) {
        return 2;
      } else if (value < (1 << 21) - 1) {
        return 3;
      } else if (value < (1 << 28) - 1) {
        return 4;
      } else if (value < 2 ** 35 - 1) {
        return 5;
      } else if (value < 2 ** 42 - 1) {
        return 6;
      } else {
        throw new Error("EBML VINT size not supported " + value);
      }
    };
    readBits = (bytes2, start, end) => {
      let result = 0;
      for (let i = start; i < end; i++) {
        let byteIndex = Math.floor(i / 8);
        let byte = bytes2[byteIndex];
        let bitIndex = 7 - (i & 7);
        let bit = (byte & 1 << bitIndex) >> bitIndex;
        result <<= 1;
        result |= bit;
      }
      return result;
    };
    writeBits = (bytes2, start, end, value) => {
      for (let i = start; i < end; i++) {
        let byteIndex = Math.floor(i / 8);
        let byte = bytes2[byteIndex];
        let bitIndex = 7 - (i & 7);
        byte &= ~(1 << bitIndex);
        byte |= (value & 1 << end - i - 1) >> end - i - 1 << bitIndex;
        bytes2[byteIndex] = byte;
      }
    };
    Target2 = class {
    };
    ArrayBufferTarget2 = class extends Target2 {
      constructor() {
        super(...arguments);
        this.buffer = null;
      }
    };
    StreamTarget2 = class extends Target2 {
      constructor(options) {
        super();
        this.options = options;
        if (typeof options !== "object") {
          throw new TypeError("StreamTarget requires an options object to be passed to its constructor.");
        }
        if (options.onData) {
          if (typeof options.onData !== "function") {
            throw new TypeError("options.onData, when provided, must be a function.");
          }
          if (options.onData.length < 2) {
            throw new TypeError(
              "options.onData, when provided, must be a function that takes in at least two arguments (data and position). Ignoring the position argument, which specifies the byte offset at which the data is to be written, can lead to broken outputs."
            );
          }
        }
        if (options.onHeader && typeof options.onHeader !== "function") {
          throw new TypeError("options.onHeader, when provided, must be a function.");
        }
        if (options.onCluster && typeof options.onCluster !== "function") {
          throw new TypeError("options.onCluster, when provided, must be a function.");
        }
        if (options.chunked !== void 0 && typeof options.chunked !== "boolean") {
          throw new TypeError("options.chunked, when provided, must be a boolean.");
        }
        if (options.chunkSize !== void 0 && (!Number.isInteger(options.chunkSize) || options.chunkSize < 1024)) {
          throw new TypeError("options.chunkSize, when provided, must be an integer and not smaller than 1024.");
        }
      }
    };
    FileSystemWritableFileStreamTarget2 = class extends Target2 {
      constructor(stream, options) {
        super();
        this.stream = stream;
        this.options = options;
        if (!(stream instanceof FileSystemWritableFileStream)) {
          throw new TypeError("FileSystemWritableFileStreamTarget requires a FileSystemWritableFileStream instance.");
        }
        if (options !== void 0 && typeof options !== "object") {
          throw new TypeError("FileSystemWritableFileStreamTarget's options, when provided, must be an object.");
        }
        if (options) {
          if (options.chunkSize !== void 0 && (!Number.isInteger(options.chunkSize) || options.chunkSize <= 0)) {
            throw new TypeError("options.chunkSize, when provided, must be a positive integer");
          }
        }
      }
    };
    Writer2 = class {
      constructor() {
        __privateAdd2(this, _writeByte);
        __privateAdd2(this, _writeFloat32);
        __privateAdd2(this, _writeFloat64);
        __privateAdd2(this, _writeUnsignedInt);
        __privateAdd2(this, _writeString);
        this.pos = 0;
        __privateAdd2(this, _helper2, new Uint8Array(8));
        __privateAdd2(this, _helperView2, new DataView(__privateGet2(this, _helper2).buffer));
        this.offsets = /* @__PURE__ */ new WeakMap();
        this.dataOffsets = /* @__PURE__ */ new WeakMap();
      }
      seek(newPos) {
        this.pos = newPos;
      }
      writeEBMLVarInt(value, width = measureEBMLVarInt(value)) {
        let pos = 0;
        switch (width) {
          case 1:
            __privateGet2(this, _helperView2).setUint8(pos++, 1 << 7 | value);
            break;
          case 2:
            __privateGet2(this, _helperView2).setUint8(pos++, 1 << 6 | value >> 8);
            __privateGet2(this, _helperView2).setUint8(pos++, value);
            break;
          case 3:
            __privateGet2(this, _helperView2).setUint8(pos++, 1 << 5 | value >> 16);
            __privateGet2(this, _helperView2).setUint8(pos++, value >> 8);
            __privateGet2(this, _helperView2).setUint8(pos++, value);
            break;
          case 4:
            __privateGet2(this, _helperView2).setUint8(pos++, 1 << 4 | value >> 24);
            __privateGet2(this, _helperView2).setUint8(pos++, value >> 16);
            __privateGet2(this, _helperView2).setUint8(pos++, value >> 8);
            __privateGet2(this, _helperView2).setUint8(pos++, value);
            break;
          case 5:
            __privateGet2(this, _helperView2).setUint8(pos++, 1 << 3 | value / 2 ** 32 & 7);
            __privateGet2(this, _helperView2).setUint8(pos++, value >> 24);
            __privateGet2(this, _helperView2).setUint8(pos++, value >> 16);
            __privateGet2(this, _helperView2).setUint8(pos++, value >> 8);
            __privateGet2(this, _helperView2).setUint8(pos++, value);
            break;
          case 6:
            __privateGet2(this, _helperView2).setUint8(pos++, 1 << 2 | value / 2 ** 40 & 3);
            __privateGet2(this, _helperView2).setUint8(pos++, value / 2 ** 32 | 0);
            __privateGet2(this, _helperView2).setUint8(pos++, value >> 24);
            __privateGet2(this, _helperView2).setUint8(pos++, value >> 16);
            __privateGet2(this, _helperView2).setUint8(pos++, value >> 8);
            __privateGet2(this, _helperView2).setUint8(pos++, value);
            break;
          default:
            throw new Error("Bad EBML VINT size " + width);
        }
        this.write(__privateGet2(this, _helper2).subarray(0, pos));
      }
      writeEBML(data) {
        if (data === null)
          return;
        if (data instanceof Uint8Array) {
          this.write(data);
        } else if (Array.isArray(data)) {
          for (let elem of data) {
            this.writeEBML(elem);
          }
        } else {
          this.offsets.set(data, this.pos);
          __privateMethod2(this, _writeUnsignedInt, writeUnsignedInt_fn).call(this, data.id);
          if (Array.isArray(data.data)) {
            let sizePos = this.pos;
            let sizeSize = data.size === -1 ? 1 : data.size ?? 4;
            if (data.size === -1) {
              __privateMethod2(this, _writeByte, writeByte_fn).call(this, 255);
            } else {
              this.seek(this.pos + sizeSize);
            }
            let startPos = this.pos;
            this.dataOffsets.set(data, startPos);
            this.writeEBML(data.data);
            if (data.size !== -1) {
              let size = this.pos - startPos;
              let endPos = this.pos;
              this.seek(sizePos);
              this.writeEBMLVarInt(size, sizeSize);
              this.seek(endPos);
            }
          } else if (typeof data.data === "number") {
            let size = data.size ?? measureUnsignedInt(data.data);
            this.writeEBMLVarInt(size);
            __privateMethod2(this, _writeUnsignedInt, writeUnsignedInt_fn).call(this, data.data, size);
          } else if (typeof data.data === "string") {
            this.writeEBMLVarInt(data.data.length);
            __privateMethod2(this, _writeString, writeString_fn).call(this, data.data);
          } else if (data.data instanceof Uint8Array) {
            this.writeEBMLVarInt(data.data.byteLength, data.size);
            this.write(data.data);
          } else if (data.data instanceof EBMLFloat32) {
            this.writeEBMLVarInt(4);
            __privateMethod2(this, _writeFloat32, writeFloat32_fn).call(this, data.data.value);
          } else if (data.data instanceof EBMLFloat64) {
            this.writeEBMLVarInt(8);
            __privateMethod2(this, _writeFloat64, writeFloat64_fn).call(this, data.data.value);
          }
        }
      }
    };
    _helper2 = /* @__PURE__ */ new WeakMap();
    _helperView2 = /* @__PURE__ */ new WeakMap();
    _writeByte = /* @__PURE__ */ new WeakSet();
    writeByte_fn = function(value) {
      __privateGet2(this, _helperView2).setUint8(0, value);
      this.write(__privateGet2(this, _helper2).subarray(0, 1));
    };
    _writeFloat32 = /* @__PURE__ */ new WeakSet();
    writeFloat32_fn = function(value) {
      __privateGet2(this, _helperView2).setFloat32(0, value, false);
      this.write(__privateGet2(this, _helper2).subarray(0, 4));
    };
    _writeFloat64 = /* @__PURE__ */ new WeakSet();
    writeFloat64_fn = function(value) {
      __privateGet2(this, _helperView2).setFloat64(0, value, false);
      this.write(__privateGet2(this, _helper2));
    };
    _writeUnsignedInt = /* @__PURE__ */ new WeakSet();
    writeUnsignedInt_fn = function(value, width = measureUnsignedInt(value)) {
      let pos = 0;
      switch (width) {
        case 6:
          __privateGet2(this, _helperView2).setUint8(pos++, value / 2 ** 40 | 0);
        case 5:
          __privateGet2(this, _helperView2).setUint8(pos++, value / 2 ** 32 | 0);
        case 4:
          __privateGet2(this, _helperView2).setUint8(pos++, value >> 24);
        case 3:
          __privateGet2(this, _helperView2).setUint8(pos++, value >> 16);
        case 2:
          __privateGet2(this, _helperView2).setUint8(pos++, value >> 8);
        case 1:
          __privateGet2(this, _helperView2).setUint8(pos++, value);
          break;
        default:
          throw new Error("Bad UINT size " + width);
      }
      this.write(__privateGet2(this, _helper2).subarray(0, pos));
    };
    _writeString = /* @__PURE__ */ new WeakSet();
    writeString_fn = function(str) {
      this.write(new Uint8Array(str.split("").map((x) => x.charCodeAt(0))));
    };
    ArrayBufferTargetWriter2 = class extends Writer2 {
      constructor(target) {
        super();
        __privateAdd2(this, _ensureSize2);
        __privateAdd2(this, _target3, void 0);
        __privateAdd2(this, _buffer2, new ArrayBuffer(2 ** 16));
        __privateAdd2(this, _bytes2, new Uint8Array(__privateGet2(this, _buffer2)));
        __privateSet2(this, _target3, target);
      }
      write(data) {
        __privateMethod2(this, _ensureSize2, ensureSize_fn2).call(this, this.pos + data.byteLength);
        __privateGet2(this, _bytes2).set(data, this.pos);
        this.pos += data.byteLength;
      }
      finalize() {
        __privateMethod2(this, _ensureSize2, ensureSize_fn2).call(this, this.pos);
        __privateGet2(this, _target3).buffer = __privateGet2(this, _buffer2).slice(0, this.pos);
      }
    };
    _target3 = /* @__PURE__ */ new WeakMap();
    _buffer2 = /* @__PURE__ */ new WeakMap();
    _bytes2 = /* @__PURE__ */ new WeakMap();
    _ensureSize2 = /* @__PURE__ */ new WeakSet();
    ensureSize_fn2 = function(size) {
      let newLength = __privateGet2(this, _buffer2).byteLength;
      while (newLength < size)
        newLength *= 2;
      if (newLength === __privateGet2(this, _buffer2).byteLength)
        return;
      let newBuffer = new ArrayBuffer(newLength);
      let newBytes = new Uint8Array(newBuffer);
      newBytes.set(__privateGet2(this, _bytes2), 0);
      __privateSet2(this, _buffer2, newBuffer);
      __privateSet2(this, _bytes2, newBytes);
    };
    BaseStreamTargetWriter = class extends Writer2 {
      constructor(target) {
        super();
        this.target = target;
        __privateAdd2(this, _trackingWrites, false);
        __privateAdd2(this, _trackedWrites, void 0);
        __privateAdd2(this, _trackedStart, void 0);
        __privateAdd2(this, _trackedEnd, void 0);
      }
      write(data) {
        if (!__privateGet2(this, _trackingWrites))
          return;
        let pos = this.pos;
        if (pos < __privateGet2(this, _trackedStart)) {
          if (pos + data.byteLength <= __privateGet2(this, _trackedStart))
            return;
          data = data.subarray(__privateGet2(this, _trackedStart) - pos);
          pos = 0;
        }
        let neededSize = pos + data.byteLength - __privateGet2(this, _trackedStart);
        let newLength = __privateGet2(this, _trackedWrites).byteLength;
        while (newLength < neededSize)
          newLength *= 2;
        if (newLength !== __privateGet2(this, _trackedWrites).byteLength) {
          let copy = new Uint8Array(newLength);
          copy.set(__privateGet2(this, _trackedWrites), 0);
          __privateSet2(this, _trackedWrites, copy);
        }
        __privateGet2(this, _trackedWrites).set(data, pos - __privateGet2(this, _trackedStart));
        __privateSet2(this, _trackedEnd, Math.max(__privateGet2(this, _trackedEnd), pos + data.byteLength));
      }
      startTrackingWrites() {
        __privateSet2(this, _trackingWrites, true);
        __privateSet2(this, _trackedWrites, new Uint8Array(2 ** 10));
        __privateSet2(this, _trackedStart, this.pos);
        __privateSet2(this, _trackedEnd, this.pos);
      }
      getTrackedWrites() {
        if (!__privateGet2(this, _trackingWrites)) {
          throw new Error("Can't get tracked writes since nothing was tracked.");
        }
        let slice = __privateGet2(this, _trackedWrites).subarray(0, __privateGet2(this, _trackedEnd) - __privateGet2(this, _trackedStart));
        let result = {
          data: slice,
          start: __privateGet2(this, _trackedStart),
          end: __privateGet2(this, _trackedEnd)
        };
        __privateSet2(this, _trackedWrites, void 0);
        __privateSet2(this, _trackingWrites, false);
        return result;
      }
    };
    _trackingWrites = /* @__PURE__ */ new WeakMap();
    _trackedWrites = /* @__PURE__ */ new WeakMap();
    _trackedStart = /* @__PURE__ */ new WeakMap();
    _trackedEnd = /* @__PURE__ */ new WeakMap();
    DEFAULT_CHUNK_SIZE2 = 2 ** 24;
    MAX_CHUNKS_AT_ONCE2 = 2;
    StreamTargetWriter2 = class extends BaseStreamTargetWriter {
      constructor(target, ensureMonotonicity) {
        super(target);
        __privateAdd2(this, _writeDataIntoChunks2);
        __privateAdd2(this, _insertSectionIntoChunk2);
        __privateAdd2(this, _createChunk2);
        __privateAdd2(this, _flushChunks2);
        __privateAdd2(this, _sections2, []);
        __privateAdd2(this, _lastFlushEnd, 0);
        __privateAdd2(this, _ensureMonotonicity, void 0);
        __privateAdd2(this, _chunked2, void 0);
        __privateAdd2(this, _chunkSize2, void 0);
        __privateAdd2(this, _chunks2, []);
        __privateSet2(this, _ensureMonotonicity, ensureMonotonicity);
        __privateSet2(this, _chunked2, target.options?.chunked ?? false);
        __privateSet2(this, _chunkSize2, target.options?.chunkSize ?? DEFAULT_CHUNK_SIZE2);
      }
      write(data) {
        super.write(data);
        __privateGet2(this, _sections2).push({
          data: data.slice(),
          start: this.pos
        });
        this.pos += data.byteLength;
      }
      flush() {
        if (__privateGet2(this, _sections2).length === 0)
          return;
        let chunks = [];
        let sorted = [...__privateGet2(this, _sections2)].sort((a, b) => a.start - b.start);
        chunks.push({
          start: sorted[0].start,
          size: sorted[0].data.byteLength
        });
        for (let i = 1; i < sorted.length; i++) {
          let lastChunk = chunks[chunks.length - 1];
          let section = sorted[i];
          if (section.start <= lastChunk.start + lastChunk.size) {
            lastChunk.size = Math.max(lastChunk.size, section.start + section.data.byteLength - lastChunk.start);
          } else {
            chunks.push({
              start: section.start,
              size: section.data.byteLength
            });
          }
        }
        for (let chunk of chunks) {
          chunk.data = new Uint8Array(chunk.size);
          for (let section of __privateGet2(this, _sections2)) {
            if (chunk.start <= section.start && section.start < chunk.start + chunk.size) {
              chunk.data.set(section.data, section.start - chunk.start);
            }
          }
          if (__privateGet2(this, _chunked2)) {
            __privateMethod2(this, _writeDataIntoChunks2, writeDataIntoChunks_fn2).call(this, chunk.data, chunk.start);
            __privateMethod2(this, _flushChunks2, flushChunks_fn2).call(this);
          } else {
            if (__privateGet2(this, _ensureMonotonicity) && chunk.start < __privateGet2(this, _lastFlushEnd)) {
              throw new Error("Internal error: Monotonicity violation.");
            }
            this.target.options.onData?.(chunk.data, chunk.start);
            __privateSet2(this, _lastFlushEnd, chunk.start + chunk.data.byteLength);
          }
        }
        __privateGet2(this, _sections2).length = 0;
      }
      finalize() {
        if (__privateGet2(this, _chunked2)) {
          __privateMethod2(this, _flushChunks2, flushChunks_fn2).call(this, true);
        }
      }
    };
    _sections2 = /* @__PURE__ */ new WeakMap();
    _lastFlushEnd = /* @__PURE__ */ new WeakMap();
    _ensureMonotonicity = /* @__PURE__ */ new WeakMap();
    _chunked2 = /* @__PURE__ */ new WeakMap();
    _chunkSize2 = /* @__PURE__ */ new WeakMap();
    _chunks2 = /* @__PURE__ */ new WeakMap();
    _writeDataIntoChunks2 = /* @__PURE__ */ new WeakSet();
    writeDataIntoChunks_fn2 = function(data, position) {
      let chunkIndex = __privateGet2(this, _chunks2).findIndex((x) => x.start <= position && position < x.start + __privateGet2(this, _chunkSize2));
      if (chunkIndex === -1)
        chunkIndex = __privateMethod2(this, _createChunk2, createChunk_fn2).call(this, position);
      let chunk = __privateGet2(this, _chunks2)[chunkIndex];
      let relativePosition = position - chunk.start;
      let toWrite = data.subarray(0, Math.min(__privateGet2(this, _chunkSize2) - relativePosition, data.byteLength));
      chunk.data.set(toWrite, relativePosition);
      let section = {
        start: relativePosition,
        end: relativePosition + toWrite.byteLength
      };
      __privateMethod2(this, _insertSectionIntoChunk2, insertSectionIntoChunk_fn2).call(this, chunk, section);
      if (chunk.written[0].start === 0 && chunk.written[0].end === __privateGet2(this, _chunkSize2)) {
        chunk.shouldFlush = true;
      }
      if (__privateGet2(this, _chunks2).length > MAX_CHUNKS_AT_ONCE2) {
        for (let i = 0; i < __privateGet2(this, _chunks2).length - 1; i++) {
          __privateGet2(this, _chunks2)[i].shouldFlush = true;
        }
        __privateMethod2(this, _flushChunks2, flushChunks_fn2).call(this);
      }
      if (toWrite.byteLength < data.byteLength) {
        __privateMethod2(this, _writeDataIntoChunks2, writeDataIntoChunks_fn2).call(this, data.subarray(toWrite.byteLength), position + toWrite.byteLength);
      }
    };
    _insertSectionIntoChunk2 = /* @__PURE__ */ new WeakSet();
    insertSectionIntoChunk_fn2 = function(chunk, section) {
      let low = 0;
      let high = chunk.written.length - 1;
      let index = -1;
      while (low <= high) {
        let mid = Math.floor(low + (high - low + 1) / 2);
        if (chunk.written[mid].start <= section.start) {
          low = mid + 1;
          index = mid;
        } else {
          high = mid - 1;
        }
      }
      chunk.written.splice(index + 1, 0, section);
      if (index === -1 || chunk.written[index].end < section.start)
        index++;
      while (index < chunk.written.length - 1 && chunk.written[index].end >= chunk.written[index + 1].start) {
        chunk.written[index].end = Math.max(chunk.written[index].end, chunk.written[index + 1].end);
        chunk.written.splice(index + 1, 1);
      }
    };
    _createChunk2 = /* @__PURE__ */ new WeakSet();
    createChunk_fn2 = function(includesPosition) {
      let start = Math.floor(includesPosition / __privateGet2(this, _chunkSize2)) * __privateGet2(this, _chunkSize2);
      let chunk = {
        start,
        data: new Uint8Array(__privateGet2(this, _chunkSize2)),
        written: [],
        shouldFlush: false
      };
      __privateGet2(this, _chunks2).push(chunk);
      __privateGet2(this, _chunks2).sort((a, b) => a.start - b.start);
      return __privateGet2(this, _chunks2).indexOf(chunk);
    };
    _flushChunks2 = /* @__PURE__ */ new WeakSet();
    flushChunks_fn2 = function(force = false) {
      for (let i = 0; i < __privateGet2(this, _chunks2).length; i++) {
        let chunk = __privateGet2(this, _chunks2)[i];
        if (!chunk.shouldFlush && !force)
          continue;
        for (let section of chunk.written) {
          if (__privateGet2(this, _ensureMonotonicity) && chunk.start + section.start < __privateGet2(this, _lastFlushEnd)) {
            throw new Error("Internal error: Monotonicity violation.");
          }
          this.target.options.onData?.(
            chunk.data.subarray(section.start, section.end),
            chunk.start + section.start
          );
          __privateSet2(this, _lastFlushEnd, chunk.start + section.end);
        }
        __privateGet2(this, _chunks2).splice(i--, 1);
      }
    };
    FileSystemWritableFileStreamTargetWriter2 = class extends StreamTargetWriter2 {
      constructor(target, ensureMonotonicity) {
        super(new StreamTarget2({
          onData: (data, position) => target.stream.write({
            type: "write",
            data,
            position
          }),
          chunked: true,
          chunkSize: target.options?.chunkSize
        }), ensureMonotonicity);
      }
    };
    VIDEO_TRACK_NUMBER = 1;
    AUDIO_TRACK_NUMBER = 2;
    SUBTITLE_TRACK_NUMBER = 3;
    VIDEO_TRACK_TYPE = 1;
    AUDIO_TRACK_TYPE = 2;
    SUBTITLE_TRACK_TYPE = 17;
    MAX_CHUNK_LENGTH_MS = 2 ** 15;
    CODEC_PRIVATE_MAX_SIZE = 2 ** 13;
    APP_NAME = "https://github.com/Vanilagy/webm-muxer";
    SEGMENT_SIZE_BYTES = 6;
    CLUSTER_SIZE_BYTES = 5;
    FIRST_TIMESTAMP_BEHAVIORS2 = ["strict", "offset", "permissive"];
    Muxer2 = class {
      constructor(options) {
        __privateAdd2(this, _validateOptions2);
        __privateAdd2(this, _createFileHeader);
        __privateAdd2(this, _writeEBMLHeader);
        __privateAdd2(this, _createCodecPrivatePlaceholders);
        __privateAdd2(this, _createColourElement);
        __privateAdd2(this, _createSeekHead);
        __privateAdd2(this, _createSegmentInfo);
        __privateAdd2(this, _createTracks);
        __privateAdd2(this, _createSegment);
        __privateAdd2(this, _createCues);
        __privateAdd2(this, _maybeFlushStreamingTargetWriter2);
        __privateAdd2(this, _segmentDataOffset);
        __privateAdd2(this, _writeVideoDecoderConfig);
        __privateAdd2(this, _fixVP9ColorSpace);
        __privateAdd2(this, _writeSubtitleChunks);
        __privateAdd2(this, _createInternalChunk);
        __privateAdd2(this, _validateTimestamp2);
        __privateAdd2(this, _writeBlock);
        __privateAdd2(this, _createCodecPrivateElement);
        __privateAdd2(this, _writeCodecPrivate);
        __privateAdd2(this, _createNewCluster);
        __privateAdd2(this, _finalizeCurrentCluster);
        __privateAdd2(this, _ensureNotFinalized2);
        __privateAdd2(this, _options2, void 0);
        __privateAdd2(this, _writer2, void 0);
        __privateAdd2(this, _segment, void 0);
        __privateAdd2(this, _segmentInfo, void 0);
        __privateAdd2(this, _seekHead, void 0);
        __privateAdd2(this, _tracksElement, void 0);
        __privateAdd2(this, _segmentDuration, void 0);
        __privateAdd2(this, _colourElement, void 0);
        __privateAdd2(this, _videoCodecPrivate, void 0);
        __privateAdd2(this, _audioCodecPrivate, void 0);
        __privateAdd2(this, _subtitleCodecPrivate, void 0);
        __privateAdd2(this, _cues, void 0);
        __privateAdd2(this, _currentCluster, void 0);
        __privateAdd2(this, _currentClusterTimestamp, void 0);
        __privateAdd2(this, _duration, 0);
        __privateAdd2(this, _videoChunkQueue, []);
        __privateAdd2(this, _audioChunkQueue, []);
        __privateAdd2(this, _subtitleChunkQueue, []);
        __privateAdd2(this, _firstVideoTimestamp, void 0);
        __privateAdd2(this, _firstAudioTimestamp, void 0);
        __privateAdd2(this, _lastVideoTimestamp, -1);
        __privateAdd2(this, _lastAudioTimestamp, -1);
        __privateAdd2(this, _lastSubtitleTimestamp, -1);
        __privateAdd2(this, _colorSpace, void 0);
        __privateAdd2(this, _finalized2, false);
        __privateMethod2(this, _validateOptions2, validateOptions_fn2).call(this, options);
        __privateSet2(this, _options2, {
          type: "webm",
          firstTimestampBehavior: "strict",
          ...options
        });
        this.target = options.target;
        let ensureMonotonicity = !!__privateGet2(this, _options2).streaming;
        if (options.target instanceof ArrayBufferTarget2) {
          __privateSet2(this, _writer2, new ArrayBufferTargetWriter2(options.target));
        } else if (options.target instanceof StreamTarget2) {
          __privateSet2(this, _writer2, new StreamTargetWriter2(options.target, ensureMonotonicity));
        } else if (options.target instanceof FileSystemWritableFileStreamTarget2) {
          __privateSet2(this, _writer2, new FileSystemWritableFileStreamTargetWriter2(options.target, ensureMonotonicity));
        } else {
          throw new Error(`Invalid target: ${options.target}`);
        }
        __privateMethod2(this, _createFileHeader, createFileHeader_fn).call(this);
      }
      addVideoChunk(chunk, meta, timestamp) {
        if (!(chunk instanceof EncodedVideoChunk)) {
          throw new TypeError("addVideoChunk's first argument (chunk) must be of type EncodedVideoChunk.");
        }
        if (meta && typeof meta !== "object") {
          throw new TypeError("addVideoChunk's second argument (meta), when provided, must be an object.");
        }
        if (timestamp !== void 0 && (!Number.isFinite(timestamp) || timestamp < 0)) {
          throw new TypeError(
            "addVideoChunk's third argument (timestamp), when provided, must be a non-negative real number."
          );
        }
        let data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.addVideoChunkRaw(data, chunk.type, timestamp ?? chunk.timestamp, meta);
      }
      addVideoChunkRaw(data, type, timestamp, meta) {
        if (!(data instanceof Uint8Array)) {
          throw new TypeError("addVideoChunkRaw's first argument (data) must be an instance of Uint8Array.");
        }
        if (type !== "key" && type !== "delta") {
          throw new TypeError("addVideoChunkRaw's second argument (type) must be either 'key' or 'delta'.");
        }
        if (!Number.isFinite(timestamp) || timestamp < 0) {
          throw new TypeError("addVideoChunkRaw's third argument (timestamp) must be a non-negative real number.");
        }
        if (meta && typeof meta !== "object") {
          throw new TypeError("addVideoChunkRaw's fourth argument (meta), when provided, must be an object.");
        }
        __privateMethod2(this, _ensureNotFinalized2, ensureNotFinalized_fn2).call(this);
        if (!__privateGet2(this, _options2).video)
          throw new Error("No video track declared.");
        if (__privateGet2(this, _firstVideoTimestamp) === void 0)
          __privateSet2(this, _firstVideoTimestamp, timestamp);
        if (meta)
          __privateMethod2(this, _writeVideoDecoderConfig, writeVideoDecoderConfig_fn).call(this, meta);
        let videoChunk = __privateMethod2(this, _createInternalChunk, createInternalChunk_fn).call(this, data, type, timestamp, VIDEO_TRACK_NUMBER);
        if (__privateGet2(this, _options2).video.codec === "V_VP9")
          __privateMethod2(this, _fixVP9ColorSpace, fixVP9ColorSpace_fn).call(this, videoChunk);
        __privateSet2(this, _lastVideoTimestamp, videoChunk.timestamp);
        while (__privateGet2(this, _audioChunkQueue).length > 0 && __privateGet2(this, _audioChunkQueue)[0].timestamp <= videoChunk.timestamp) {
          let audioChunk = __privateGet2(this, _audioChunkQueue).shift();
          __privateMethod2(this, _writeBlock, writeBlock_fn).call(this, audioChunk, false);
        }
        if (!__privateGet2(this, _options2).audio || videoChunk.timestamp <= __privateGet2(this, _lastAudioTimestamp)) {
          __privateMethod2(this, _writeBlock, writeBlock_fn).call(this, videoChunk, true);
        } else {
          __privateGet2(this, _videoChunkQueue).push(videoChunk);
        }
        __privateMethod2(this, _writeSubtitleChunks, writeSubtitleChunks_fn).call(this);
        __privateMethod2(this, _maybeFlushStreamingTargetWriter2, maybeFlushStreamingTargetWriter_fn2).call(this);
      }
      addAudioChunk(chunk, meta, timestamp) {
        if (!(chunk instanceof EncodedAudioChunk)) {
          throw new TypeError("addAudioChunk's first argument (chunk) must be of type EncodedAudioChunk.");
        }
        if (meta && typeof meta !== "object") {
          throw new TypeError("addAudioChunk's second argument (meta), when provided, must be an object.");
        }
        if (timestamp !== void 0 && (!Number.isFinite(timestamp) || timestamp < 0)) {
          throw new TypeError(
            "addAudioChunk's third argument (timestamp), when provided, must be a non-negative real number."
          );
        }
        let data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.addAudioChunkRaw(data, chunk.type, timestamp ?? chunk.timestamp, meta);
      }
      addAudioChunkRaw(data, type, timestamp, meta) {
        if (!(data instanceof Uint8Array)) {
          throw new TypeError("addAudioChunkRaw's first argument (data) must be an instance of Uint8Array.");
        }
        if (type !== "key" && type !== "delta") {
          throw new TypeError("addAudioChunkRaw's second argument (type) must be either 'key' or 'delta'.");
        }
        if (!Number.isFinite(timestamp) || timestamp < 0) {
          throw new TypeError("addAudioChunkRaw's third argument (timestamp) must be a non-negative real number.");
        }
        if (meta && typeof meta !== "object") {
          throw new TypeError("addAudioChunkRaw's fourth argument (meta), when provided, must be an object.");
        }
        __privateMethod2(this, _ensureNotFinalized2, ensureNotFinalized_fn2).call(this);
        if (!__privateGet2(this, _options2).audio)
          throw new Error("No audio track declared.");
        if (__privateGet2(this, _firstAudioTimestamp) === void 0)
          __privateSet2(this, _firstAudioTimestamp, timestamp);
        if (meta?.decoderConfig) {
          if (__privateGet2(this, _options2).streaming) {
            __privateSet2(this, _audioCodecPrivate, __privateMethod2(this, _createCodecPrivateElement, createCodecPrivateElement_fn).call(this, meta.decoderConfig.description));
          } else {
            __privateMethod2(this, _writeCodecPrivate, writeCodecPrivate_fn).call(this, __privateGet2(this, _audioCodecPrivate), meta.decoderConfig.description);
          }
        }
        let audioChunk = __privateMethod2(this, _createInternalChunk, createInternalChunk_fn).call(this, data, type, timestamp, AUDIO_TRACK_NUMBER);
        __privateSet2(this, _lastAudioTimestamp, audioChunk.timestamp);
        while (__privateGet2(this, _videoChunkQueue).length > 0 && __privateGet2(this, _videoChunkQueue)[0].timestamp <= audioChunk.timestamp) {
          let videoChunk = __privateGet2(this, _videoChunkQueue).shift();
          __privateMethod2(this, _writeBlock, writeBlock_fn).call(this, videoChunk, true);
        }
        if (!__privateGet2(this, _options2).video || audioChunk.timestamp <= __privateGet2(this, _lastVideoTimestamp)) {
          __privateMethod2(this, _writeBlock, writeBlock_fn).call(this, audioChunk, !__privateGet2(this, _options2).video);
        } else {
          __privateGet2(this, _audioChunkQueue).push(audioChunk);
        }
        __privateMethod2(this, _writeSubtitleChunks, writeSubtitleChunks_fn).call(this);
        __privateMethod2(this, _maybeFlushStreamingTargetWriter2, maybeFlushStreamingTargetWriter_fn2).call(this);
      }
      addSubtitleChunk(chunk, meta, timestamp) {
        if (typeof chunk !== "object" || !chunk) {
          throw new TypeError("addSubtitleChunk's first argument (chunk) must be an object.");
        } else {
          if (!(chunk.body instanceof Uint8Array)) {
            throw new TypeError("body must be an instance of Uint8Array.");
          }
          if (!Number.isFinite(chunk.timestamp) || chunk.timestamp < 0) {
            throw new TypeError("timestamp must be a non-negative real number.");
          }
          if (!Number.isFinite(chunk.duration) || chunk.duration < 0) {
            throw new TypeError("duration must be a non-negative real number.");
          }
          if (chunk.additions && !(chunk.additions instanceof Uint8Array)) {
            throw new TypeError("additions, when present, must be an instance of Uint8Array.");
          }
        }
        if (typeof meta !== "object") {
          throw new TypeError("addSubtitleChunk's second argument (meta) must be an object.");
        }
        __privateMethod2(this, _ensureNotFinalized2, ensureNotFinalized_fn2).call(this);
        if (!__privateGet2(this, _options2).subtitles)
          throw new Error("No subtitle track declared.");
        if (meta?.decoderConfig) {
          if (__privateGet2(this, _options2).streaming) {
            __privateSet2(this, _subtitleCodecPrivate, __privateMethod2(this, _createCodecPrivateElement, createCodecPrivateElement_fn).call(this, meta.decoderConfig.description));
          } else {
            __privateMethod2(this, _writeCodecPrivate, writeCodecPrivate_fn).call(this, __privateGet2(this, _subtitleCodecPrivate), meta.decoderConfig.description);
          }
        }
        let subtitleChunk = __privateMethod2(this, _createInternalChunk, createInternalChunk_fn).call(this, chunk.body, "key", timestamp ?? chunk.timestamp, SUBTITLE_TRACK_NUMBER, chunk.duration, chunk.additions);
        __privateSet2(this, _lastSubtitleTimestamp, subtitleChunk.timestamp);
        __privateGet2(this, _subtitleChunkQueue).push(subtitleChunk);
        __privateMethod2(this, _writeSubtitleChunks, writeSubtitleChunks_fn).call(this);
        __privateMethod2(this, _maybeFlushStreamingTargetWriter2, maybeFlushStreamingTargetWriter_fn2).call(this);
      }
      finalize() {
        if (__privateGet2(this, _finalized2)) {
          throw new Error("Cannot finalize a muxer more than once.");
        }
        while (__privateGet2(this, _videoChunkQueue).length > 0)
          __privateMethod2(this, _writeBlock, writeBlock_fn).call(this, __privateGet2(this, _videoChunkQueue).shift(), true);
        while (__privateGet2(this, _audioChunkQueue).length > 0)
          __privateMethod2(this, _writeBlock, writeBlock_fn).call(this, __privateGet2(this, _audioChunkQueue).shift(), true);
        while (__privateGet2(this, _subtitleChunkQueue).length > 0 && __privateGet2(this, _subtitleChunkQueue)[0].timestamp <= __privateGet2(this, _duration)) {
          __privateMethod2(this, _writeBlock, writeBlock_fn).call(this, __privateGet2(this, _subtitleChunkQueue).shift(), false);
        }
        if (__privateGet2(this, _currentCluster)) {
          __privateMethod2(this, _finalizeCurrentCluster, finalizeCurrentCluster_fn).call(this);
        }
        __privateGet2(this, _writer2).writeEBML(__privateGet2(this, _cues));
        if (!__privateGet2(this, _options2).streaming) {
          let endPos = __privateGet2(this, _writer2).pos;
          let segmentSize = __privateGet2(this, _writer2).pos - __privateGet2(this, _segmentDataOffset, segmentDataOffset_get);
          __privateGet2(this, _writer2).seek(__privateGet2(this, _writer2).offsets.get(__privateGet2(this, _segment)) + 4);
          __privateGet2(this, _writer2).writeEBMLVarInt(segmentSize, SEGMENT_SIZE_BYTES);
          __privateGet2(this, _segmentDuration).data = new EBMLFloat64(__privateGet2(this, _duration));
          __privateGet2(this, _writer2).seek(__privateGet2(this, _writer2).offsets.get(__privateGet2(this, _segmentDuration)));
          __privateGet2(this, _writer2).writeEBML(__privateGet2(this, _segmentDuration));
          __privateGet2(this, _seekHead).data[0].data[1].data = __privateGet2(this, _writer2).offsets.get(__privateGet2(this, _cues)) - __privateGet2(this, _segmentDataOffset, segmentDataOffset_get);
          __privateGet2(this, _seekHead).data[1].data[1].data = __privateGet2(this, _writer2).offsets.get(__privateGet2(this, _segmentInfo)) - __privateGet2(this, _segmentDataOffset, segmentDataOffset_get);
          __privateGet2(this, _seekHead).data[2].data[1].data = __privateGet2(this, _writer2).offsets.get(__privateGet2(this, _tracksElement)) - __privateGet2(this, _segmentDataOffset, segmentDataOffset_get);
          __privateGet2(this, _writer2).seek(__privateGet2(this, _writer2).offsets.get(__privateGet2(this, _seekHead)));
          __privateGet2(this, _writer2).writeEBML(__privateGet2(this, _seekHead));
          __privateGet2(this, _writer2).seek(endPos);
        }
        __privateMethod2(this, _maybeFlushStreamingTargetWriter2, maybeFlushStreamingTargetWriter_fn2).call(this);
        __privateGet2(this, _writer2).finalize();
        __privateSet2(this, _finalized2, true);
      }
    };
    _options2 = /* @__PURE__ */ new WeakMap();
    _writer2 = /* @__PURE__ */ new WeakMap();
    _segment = /* @__PURE__ */ new WeakMap();
    _segmentInfo = /* @__PURE__ */ new WeakMap();
    _seekHead = /* @__PURE__ */ new WeakMap();
    _tracksElement = /* @__PURE__ */ new WeakMap();
    _segmentDuration = /* @__PURE__ */ new WeakMap();
    _colourElement = /* @__PURE__ */ new WeakMap();
    _videoCodecPrivate = /* @__PURE__ */ new WeakMap();
    _audioCodecPrivate = /* @__PURE__ */ new WeakMap();
    _subtitleCodecPrivate = /* @__PURE__ */ new WeakMap();
    _cues = /* @__PURE__ */ new WeakMap();
    _currentCluster = /* @__PURE__ */ new WeakMap();
    _currentClusterTimestamp = /* @__PURE__ */ new WeakMap();
    _duration = /* @__PURE__ */ new WeakMap();
    _videoChunkQueue = /* @__PURE__ */ new WeakMap();
    _audioChunkQueue = /* @__PURE__ */ new WeakMap();
    _subtitleChunkQueue = /* @__PURE__ */ new WeakMap();
    _firstVideoTimestamp = /* @__PURE__ */ new WeakMap();
    _firstAudioTimestamp = /* @__PURE__ */ new WeakMap();
    _lastVideoTimestamp = /* @__PURE__ */ new WeakMap();
    _lastAudioTimestamp = /* @__PURE__ */ new WeakMap();
    _lastSubtitleTimestamp = /* @__PURE__ */ new WeakMap();
    _colorSpace = /* @__PURE__ */ new WeakMap();
    _finalized2 = /* @__PURE__ */ new WeakMap();
    _validateOptions2 = /* @__PURE__ */ new WeakSet();
    validateOptions_fn2 = function(options) {
      if (typeof options !== "object") {
        throw new TypeError("The muxer requires an options object to be passed to its constructor.");
      }
      if (!(options.target instanceof Target2)) {
        throw new TypeError("The target must be provided and an instance of Target.");
      }
      if (options.video) {
        if (typeof options.video.codec !== "string") {
          throw new TypeError(`Invalid video codec: ${options.video.codec}. Must be a string.`);
        }
        if (!Number.isInteger(options.video.width) || options.video.width <= 0) {
          throw new TypeError(`Invalid video width: ${options.video.width}. Must be a positive integer.`);
        }
        if (!Number.isInteger(options.video.height) || options.video.height <= 0) {
          throw new TypeError(`Invalid video height: ${options.video.height}. Must be a positive integer.`);
        }
        if (options.video.frameRate !== void 0) {
          if (!Number.isFinite(options.video.frameRate) || options.video.frameRate <= 0) {
            throw new TypeError(
              `Invalid video frame rate: ${options.video.frameRate}. Must be a positive number.`
            );
          }
        }
        if (options.video.alpha !== void 0 && typeof options.video.alpha !== "boolean") {
          throw new TypeError(`Invalid video alpha: ${options.video.alpha}. Must be a boolean.`);
        }
      }
      if (options.audio) {
        if (typeof options.audio.codec !== "string") {
          throw new TypeError(`Invalid audio codec: ${options.audio.codec}. Must be a string.`);
        }
        if (!Number.isInteger(options.audio.numberOfChannels) || options.audio.numberOfChannels <= 0) {
          throw new TypeError(
            `Invalid number of audio channels: ${options.audio.numberOfChannels}. Must be a positive integer.`
          );
        }
        if (!Number.isInteger(options.audio.sampleRate) || options.audio.sampleRate <= 0) {
          throw new TypeError(
            `Invalid audio sample rate: ${options.audio.sampleRate}. Must be a positive integer.`
          );
        }
        if (options.audio.bitDepth !== void 0) {
          if (!Number.isInteger(options.audio.bitDepth) || options.audio.bitDepth <= 0) {
            throw new TypeError(
              `Invalid audio bit depth: ${options.audio.bitDepth}. Must be a positive integer.`
            );
          }
        }
      }
      if (options.subtitles) {
        if (typeof options.subtitles.codec !== "string") {
          throw new TypeError(`Invalid subtitles codec: ${options.subtitles.codec}. Must be a string.`);
        }
      }
      if (options.type !== void 0 && !["webm", "matroska"].includes(options.type)) {
        throw new TypeError(`Invalid type: ${options.type}. Must be 'webm' or 'matroska'.`);
      }
      if (options.firstTimestampBehavior && !FIRST_TIMESTAMP_BEHAVIORS2.includes(options.firstTimestampBehavior)) {
        throw new TypeError(`Invalid first timestamp behavior: ${options.firstTimestampBehavior}`);
      }
      if (options.streaming !== void 0 && typeof options.streaming !== "boolean") {
        throw new TypeError(`Invalid streaming option: ${options.streaming}. Must be a boolean.`);
      }
    };
    _createFileHeader = /* @__PURE__ */ new WeakSet();
    createFileHeader_fn = function() {
      if (__privateGet2(this, _writer2) instanceof BaseStreamTargetWriter && __privateGet2(this, _writer2).target.options.onHeader) {
        __privateGet2(this, _writer2).startTrackingWrites();
      }
      __privateMethod2(this, _writeEBMLHeader, writeEBMLHeader_fn).call(this);
      if (!__privateGet2(this, _options2).streaming) {
        __privateMethod2(this, _createSeekHead, createSeekHead_fn).call(this);
      }
      __privateMethod2(this, _createSegmentInfo, createSegmentInfo_fn).call(this);
      __privateMethod2(this, _createCodecPrivatePlaceholders, createCodecPrivatePlaceholders_fn).call(this);
      __privateMethod2(this, _createColourElement, createColourElement_fn).call(this);
      if (!__privateGet2(this, _options2).streaming) {
        __privateMethod2(this, _createTracks, createTracks_fn).call(this);
        __privateMethod2(this, _createSegment, createSegment_fn).call(this);
      } else {
      }
      __privateMethod2(this, _createCues, createCues_fn).call(this);
      __privateMethod2(this, _maybeFlushStreamingTargetWriter2, maybeFlushStreamingTargetWriter_fn2).call(this);
    };
    _writeEBMLHeader = /* @__PURE__ */ new WeakSet();
    writeEBMLHeader_fn = function() {
      let ebmlHeader = { id: 440786851, data: [
        { id: 17030, data: 1 },
        { id: 17143, data: 1 },
        { id: 17138, data: 4 },
        { id: 17139, data: 8 },
        { id: 17026, data: __privateGet2(this, _options2).type ?? "webm" },
        { id: 17031, data: 2 },
        { id: 17029, data: 2 }
      ] };
      __privateGet2(this, _writer2).writeEBML(ebmlHeader);
    };
    _createCodecPrivatePlaceholders = /* @__PURE__ */ new WeakSet();
    createCodecPrivatePlaceholders_fn = function() {
      __privateSet2(this, _videoCodecPrivate, { id: 236, size: 4, data: new Uint8Array(CODEC_PRIVATE_MAX_SIZE) });
      __privateSet2(this, _audioCodecPrivate, { id: 236, size: 4, data: new Uint8Array(CODEC_PRIVATE_MAX_SIZE) });
      __privateSet2(this, _subtitleCodecPrivate, { id: 236, size: 4, data: new Uint8Array(CODEC_PRIVATE_MAX_SIZE) });
    };
    _createColourElement = /* @__PURE__ */ new WeakSet();
    createColourElement_fn = function() {
      __privateSet2(this, _colourElement, { id: 21936, data: [
        { id: 21937, data: 2 },
        { id: 21946, data: 2 },
        { id: 21947, data: 2 },
        { id: 21945, data: 0 }
      ] });
    };
    _createSeekHead = /* @__PURE__ */ new WeakSet();
    createSeekHead_fn = function() {
      const kaxCues = new Uint8Array([28, 83, 187, 107]);
      const kaxInfo = new Uint8Array([21, 73, 169, 102]);
      const kaxTracks = new Uint8Array([22, 84, 174, 107]);
      let seekHead = { id: 290298740, data: [
        { id: 19899, data: [
          { id: 21419, data: kaxCues },
          { id: 21420, size: 5, data: 0 }
        ] },
        { id: 19899, data: [
          { id: 21419, data: kaxInfo },
          { id: 21420, size: 5, data: 0 }
        ] },
        { id: 19899, data: [
          { id: 21419, data: kaxTracks },
          { id: 21420, size: 5, data: 0 }
        ] }
      ] };
      __privateSet2(this, _seekHead, seekHead);
    };
    _createSegmentInfo = /* @__PURE__ */ new WeakSet();
    createSegmentInfo_fn = function() {
      let segmentDuration = { id: 17545, data: new EBMLFloat64(0) };
      __privateSet2(this, _segmentDuration, segmentDuration);
      let segmentInfo = { id: 357149030, data: [
        { id: 2807729, data: 1e6 },
        { id: 19840, data: APP_NAME },
        { id: 22337, data: APP_NAME },
        !__privateGet2(this, _options2).streaming ? segmentDuration : null
      ] };
      __privateSet2(this, _segmentInfo, segmentInfo);
    };
    _createTracks = /* @__PURE__ */ new WeakSet();
    createTracks_fn = function() {
      let tracksElement = { id: 374648427, data: [] };
      __privateSet2(this, _tracksElement, tracksElement);
      if (__privateGet2(this, _options2).video) {
        tracksElement.data.push({ id: 174, data: [
          { id: 215, data: VIDEO_TRACK_NUMBER },
          { id: 29637, data: VIDEO_TRACK_NUMBER },
          { id: 131, data: VIDEO_TRACK_TYPE },
          { id: 134, data: __privateGet2(this, _options2).video.codec },
          __privateGet2(this, _videoCodecPrivate),
          __privateGet2(this, _options2).video.frameRate ? { id: 2352003, data: 1e9 / __privateGet2(this, _options2).video.frameRate } : null,
          { id: 224, data: [
            { id: 176, data: __privateGet2(this, _options2).video.width },
            { id: 186, data: __privateGet2(this, _options2).video.height },
            __privateGet2(this, _options2).video.alpha ? { id: 21440, data: 1 } : null,
            __privateGet2(this, _colourElement)
          ] }
        ] });
      }
      if (__privateGet2(this, _options2).audio) {
        __privateSet2(this, _audioCodecPrivate, __privateGet2(this, _options2).streaming ? __privateGet2(this, _audioCodecPrivate) || null : { id: 236, size: 4, data: new Uint8Array(CODEC_PRIVATE_MAX_SIZE) });
        tracksElement.data.push({ id: 174, data: [
          { id: 215, data: AUDIO_TRACK_NUMBER },
          { id: 29637, data: AUDIO_TRACK_NUMBER },
          { id: 131, data: AUDIO_TRACK_TYPE },
          { id: 134, data: __privateGet2(this, _options2).audio.codec },
          __privateGet2(this, _audioCodecPrivate),
          { id: 225, data: [
            { id: 181, data: new EBMLFloat32(__privateGet2(this, _options2).audio.sampleRate) },
            { id: 159, data: __privateGet2(this, _options2).audio.numberOfChannels },
            __privateGet2(this, _options2).audio.bitDepth ? { id: 25188, data: __privateGet2(this, _options2).audio.bitDepth } : null
          ] }
        ] });
      }
      if (__privateGet2(this, _options2).subtitles) {
        tracksElement.data.push({ id: 174, data: [
          { id: 215, data: SUBTITLE_TRACK_NUMBER },
          { id: 29637, data: SUBTITLE_TRACK_NUMBER },
          { id: 131, data: SUBTITLE_TRACK_TYPE },
          { id: 134, data: __privateGet2(this, _options2).subtitles.codec },
          __privateGet2(this, _subtitleCodecPrivate)
        ] });
      }
    };
    _createSegment = /* @__PURE__ */ new WeakSet();
    createSegment_fn = function() {
      let segment = {
        id: 408125543,
        size: __privateGet2(this, _options2).streaming ? -1 : SEGMENT_SIZE_BYTES,
        data: [
          !__privateGet2(this, _options2).streaming ? __privateGet2(this, _seekHead) : null,
          __privateGet2(this, _segmentInfo),
          __privateGet2(this, _tracksElement)
        ]
      };
      __privateSet2(this, _segment, segment);
      __privateGet2(this, _writer2).writeEBML(segment);
      if (__privateGet2(this, _writer2) instanceof BaseStreamTargetWriter && __privateGet2(this, _writer2).target.options.onHeader) {
        let { data, start } = __privateGet2(this, _writer2).getTrackedWrites();
        __privateGet2(this, _writer2).target.options.onHeader(data, start);
      }
    };
    _createCues = /* @__PURE__ */ new WeakSet();
    createCues_fn = function() {
      __privateSet2(this, _cues, { id: 475249515, data: [] });
    };
    _maybeFlushStreamingTargetWriter2 = /* @__PURE__ */ new WeakSet();
    maybeFlushStreamingTargetWriter_fn2 = function() {
      if (__privateGet2(this, _writer2) instanceof StreamTargetWriter2) {
        __privateGet2(this, _writer2).flush();
      }
    };
    _segmentDataOffset = /* @__PURE__ */ new WeakSet();
    segmentDataOffset_get = function() {
      return __privateGet2(this, _writer2).dataOffsets.get(__privateGet2(this, _segment));
    };
    _writeVideoDecoderConfig = /* @__PURE__ */ new WeakSet();
    writeVideoDecoderConfig_fn = function(meta) {
      if (!meta.decoderConfig)
        return;
      if (meta.decoderConfig.colorSpace) {
        let colorSpace = meta.decoderConfig.colorSpace;
        __privateSet2(this, _colorSpace, colorSpace);
        __privateGet2(this, _colourElement).data = [
          { id: 21937, data: {
            "rgb": 1,
            "bt709": 1,
            "bt470bg": 5,
            "smpte170m": 6
          }[colorSpace.matrix] },
          { id: 21946, data: {
            "bt709": 1,
            "smpte170m": 6,
            "iec61966-2-1": 13
          }[colorSpace.transfer] },
          { id: 21947, data: {
            "bt709": 1,
            "bt470bg": 5,
            "smpte170m": 6
          }[colorSpace.primaries] },
          { id: 21945, data: [1, 2][Number(colorSpace.fullRange)] }
        ];
        if (!__privateGet2(this, _options2).streaming) {
          let endPos = __privateGet2(this, _writer2).pos;
          __privateGet2(this, _writer2).seek(__privateGet2(this, _writer2).offsets.get(__privateGet2(this, _colourElement)));
          __privateGet2(this, _writer2).writeEBML(__privateGet2(this, _colourElement));
          __privateGet2(this, _writer2).seek(endPos);
        }
      }
      if (meta.decoderConfig.description) {
        if (__privateGet2(this, _options2).streaming) {
          __privateSet2(this, _videoCodecPrivate, __privateMethod2(this, _createCodecPrivateElement, createCodecPrivateElement_fn).call(this, meta.decoderConfig.description));
        } else {
          __privateMethod2(this, _writeCodecPrivate, writeCodecPrivate_fn).call(this, __privateGet2(this, _videoCodecPrivate), meta.decoderConfig.description);
        }
      }
    };
    _fixVP9ColorSpace = /* @__PURE__ */ new WeakSet();
    fixVP9ColorSpace_fn = function(chunk) {
      if (chunk.type !== "key")
        return;
      if (!__privateGet2(this, _colorSpace))
        return;
      let i = 0;
      if (readBits(chunk.data, 0, 2) !== 2)
        return;
      i += 2;
      let profile = (readBits(chunk.data, i + 1, i + 2) << 1) + readBits(chunk.data, i + 0, i + 1);
      i += 2;
      if (profile === 3)
        i++;
      let showExistingFrame = readBits(chunk.data, i + 0, i + 1);
      i++;
      if (showExistingFrame)
        return;
      let frameType = readBits(chunk.data, i + 0, i + 1);
      i++;
      if (frameType !== 0)
        return;
      i += 2;
      let syncCode = readBits(chunk.data, i + 0, i + 24);
      i += 24;
      if (syncCode !== 4817730)
        return;
      if (profile >= 2)
        i++;
      let colorSpaceID = {
        "rgb": 7,
        "bt709": 2,
        "bt470bg": 1,
        "smpte170m": 3
      }[__privateGet2(this, _colorSpace).matrix];
      writeBits(chunk.data, i + 0, i + 3, colorSpaceID);
    };
    _writeSubtitleChunks = /* @__PURE__ */ new WeakSet();
    writeSubtitleChunks_fn = function() {
      let lastWrittenMediaTimestamp = Math.min(
        __privateGet2(this, _options2).video ? __privateGet2(this, _lastVideoTimestamp) : Infinity,
        __privateGet2(this, _options2).audio ? __privateGet2(this, _lastAudioTimestamp) : Infinity
      );
      let queue2 = __privateGet2(this, _subtitleChunkQueue);
      while (queue2.length > 0 && queue2[0].timestamp <= lastWrittenMediaTimestamp) {
        __privateMethod2(this, _writeBlock, writeBlock_fn).call(this, queue2.shift(), !__privateGet2(this, _options2).video && !__privateGet2(this, _options2).audio);
      }
    };
    _createInternalChunk = /* @__PURE__ */ new WeakSet();
    createInternalChunk_fn = function(data, type, timestamp, trackNumber, duration, additions) {
      let adjustedTimestamp = __privateMethod2(this, _validateTimestamp2, validateTimestamp_fn2).call(this, timestamp, trackNumber);
      let internalChunk = {
        data,
        additions,
        type,
        timestamp: adjustedTimestamp,
        duration,
        trackNumber
      };
      return internalChunk;
    };
    _validateTimestamp2 = /* @__PURE__ */ new WeakSet();
    validateTimestamp_fn2 = function(timestamp, trackNumber) {
      let lastTimestamp = trackNumber === VIDEO_TRACK_NUMBER ? __privateGet2(this, _lastVideoTimestamp) : trackNumber === AUDIO_TRACK_NUMBER ? __privateGet2(this, _lastAudioTimestamp) : __privateGet2(this, _lastSubtitleTimestamp);
      if (trackNumber !== SUBTITLE_TRACK_NUMBER) {
        let firstTimestamp = trackNumber === VIDEO_TRACK_NUMBER ? __privateGet2(this, _firstVideoTimestamp) : __privateGet2(this, _firstAudioTimestamp);
        if (__privateGet2(this, _options2).firstTimestampBehavior === "strict" && lastTimestamp === -1 && timestamp !== 0) {
          throw new Error(
            `The first chunk for your media track must have a timestamp of 0 (received ${timestamp}). Non-zero first timestamps are often caused by directly piping frames or audio data from a MediaStreamTrack into the encoder. Their timestamps are typically relative to the age of the document, which is probably what you want.

If you want to offset all timestamps of a track such that the first one is zero, set firstTimestampBehavior: 'offset' in the options.
If you want to allow non-zero first timestamps, set firstTimestampBehavior: 'permissive'.
`
          );
        } else if (__privateGet2(this, _options2).firstTimestampBehavior === "offset") {
          timestamp -= firstTimestamp;
        }
      }
      if (timestamp < lastTimestamp) {
        throw new Error(
          `Timestamps must be monotonically increasing (went from ${lastTimestamp} to ${timestamp}).`
        );
      }
      if (timestamp < 0) {
        throw new Error(`Timestamps must be non-negative (received ${timestamp}).`);
      }
      return timestamp;
    };
    _writeBlock = /* @__PURE__ */ new WeakSet();
    writeBlock_fn = function(chunk, canCreateNewCluster) {
      if (__privateGet2(this, _options2).streaming && !__privateGet2(this, _tracksElement)) {
        __privateMethod2(this, _createTracks, createTracks_fn).call(this);
        __privateMethod2(this, _createSegment, createSegment_fn).call(this);
      }
      let msTimestamp = Math.floor(chunk.timestamp / 1e3);
      let relativeTimestamp = msTimestamp - __privateGet2(this, _currentClusterTimestamp);
      let shouldCreateNewClusterFromKeyFrame = canCreateNewCluster && chunk.type === "key" && relativeTimestamp >= 1e3;
      let clusterWouldBeTooLong = relativeTimestamp >= MAX_CHUNK_LENGTH_MS;
      if (!__privateGet2(this, _currentCluster) || shouldCreateNewClusterFromKeyFrame || clusterWouldBeTooLong) {
        __privateMethod2(this, _createNewCluster, createNewCluster_fn).call(this, msTimestamp);
        relativeTimestamp = 0;
      }
      if (relativeTimestamp < 0) {
        return;
      }
      let prelude = new Uint8Array(4);
      let view2 = new DataView(prelude.buffer);
      view2.setUint8(0, 128 | chunk.trackNumber);
      view2.setInt16(1, relativeTimestamp, false);
      if (chunk.duration === void 0 && !chunk.additions) {
        view2.setUint8(3, Number(chunk.type === "key") << 7);
        let simpleBlock = { id: 163, data: [
          prelude,
          chunk.data
        ] };
        __privateGet2(this, _writer2).writeEBML(simpleBlock);
      } else {
        let msDuration = Math.floor(chunk.duration / 1e3);
        let blockGroup = { id: 160, data: [
          { id: 161, data: [
            prelude,
            chunk.data
          ] },
          chunk.duration !== void 0 ? { id: 155, data: msDuration } : null,
          chunk.additions ? { id: 30113, data: chunk.additions } : null
        ] };
        __privateGet2(this, _writer2).writeEBML(blockGroup);
      }
      __privateSet2(this, _duration, Math.max(__privateGet2(this, _duration), msTimestamp));
    };
    _createCodecPrivateElement = /* @__PURE__ */ new WeakSet();
    createCodecPrivateElement_fn = function(data) {
      return { id: 25506, size: 4, data: new Uint8Array(data) };
    };
    _writeCodecPrivate = /* @__PURE__ */ new WeakSet();
    writeCodecPrivate_fn = function(element, data) {
      let endPos = __privateGet2(this, _writer2).pos;
      __privateGet2(this, _writer2).seek(__privateGet2(this, _writer2).offsets.get(element));
      let codecPrivateElementSize = 2 + 4 + data.byteLength;
      let voidDataSize = CODEC_PRIVATE_MAX_SIZE - codecPrivateElementSize;
      if (voidDataSize < 0) {
        let newByteLength = data.byteLength + voidDataSize;
        if (data instanceof ArrayBuffer) {
          data = data.slice(0, newByteLength);
        } else {
          data = data.buffer.slice(0, newByteLength);
        }
        voidDataSize = 0;
      }
      element = [
        __privateMethod2(this, _createCodecPrivateElement, createCodecPrivateElement_fn).call(this, data),
        { id: 236, size: 4, data: new Uint8Array(voidDataSize) }
      ];
      __privateGet2(this, _writer2).writeEBML(element);
      __privateGet2(this, _writer2).seek(endPos);
    };
    _createNewCluster = /* @__PURE__ */ new WeakSet();
    createNewCluster_fn = function(timestamp) {
      if (__privateGet2(this, _currentCluster)) {
        __privateMethod2(this, _finalizeCurrentCluster, finalizeCurrentCluster_fn).call(this);
      }
      if (__privateGet2(this, _writer2) instanceof BaseStreamTargetWriter && __privateGet2(this, _writer2).target.options.onCluster) {
        __privateGet2(this, _writer2).startTrackingWrites();
      }
      __privateSet2(this, _currentCluster, {
        id: 524531317,
        size: __privateGet2(this, _options2).streaming ? -1 : CLUSTER_SIZE_BYTES,
        data: [
          { id: 231, data: timestamp }
        ]
      });
      __privateGet2(this, _writer2).writeEBML(__privateGet2(this, _currentCluster));
      __privateSet2(this, _currentClusterTimestamp, timestamp);
      let clusterOffsetFromSegment = __privateGet2(this, _writer2).offsets.get(__privateGet2(this, _currentCluster)) - __privateGet2(this, _segmentDataOffset, segmentDataOffset_get);
      __privateGet2(this, _cues).data.push({ id: 187, data: [
        { id: 179, data: timestamp },
        __privateGet2(this, _options2).video ? { id: 183, data: [
          { id: 247, data: VIDEO_TRACK_NUMBER },
          { id: 241, data: clusterOffsetFromSegment }
        ] } : null,
        __privateGet2(this, _options2).audio ? { id: 183, data: [
          { id: 247, data: AUDIO_TRACK_NUMBER },
          { id: 241, data: clusterOffsetFromSegment }
        ] } : null
      ] });
    };
    _finalizeCurrentCluster = /* @__PURE__ */ new WeakSet();
    finalizeCurrentCluster_fn = function() {
      if (!__privateGet2(this, _options2).streaming) {
        let clusterSize = __privateGet2(this, _writer2).pos - __privateGet2(this, _writer2).dataOffsets.get(__privateGet2(this, _currentCluster));
        let endPos = __privateGet2(this, _writer2).pos;
        __privateGet2(this, _writer2).seek(__privateGet2(this, _writer2).offsets.get(__privateGet2(this, _currentCluster)) + 4);
        __privateGet2(this, _writer2).writeEBMLVarInt(clusterSize, CLUSTER_SIZE_BYTES);
        __privateGet2(this, _writer2).seek(endPos);
      }
      if (__privateGet2(this, _writer2) instanceof BaseStreamTargetWriter && __privateGet2(this, _writer2).target.options.onCluster) {
        let { data, start } = __privateGet2(this, _writer2).getTrackedWrites();
        __privateGet2(this, _writer2).target.options.onCluster(data, start, __privateGet2(this, _currentClusterTimestamp));
      }
    };
    _ensureNotFinalized2 = /* @__PURE__ */ new WeakSet();
    ensureNotFinalized_fn2 = function() {
      if (__privateGet2(this, _finalized2)) {
        throw new Error("Cannot add new video or audio chunks after the file has been finalized.");
      }
    };
    timestampRegex = /(?:(\d{2}):)?(\d{2}):(\d{2}).(\d{3})/;
    textEncoder = new TextEncoder();
    _options22 = /* @__PURE__ */ new WeakMap();
    _config = /* @__PURE__ */ new WeakMap();
    _preambleSeen = /* @__PURE__ */ new WeakMap();
    _preambleBytes = /* @__PURE__ */ new WeakMap();
    _preambleEmitted = /* @__PURE__ */ new WeakMap();
    _parseTimestamp = /* @__PURE__ */ new WeakSet();
    parseTimestamp_fn = function(string) {
      let match = timestampRegex.exec(string);
      if (!match)
        throw new Error("Expected match.");
      return 60 * 60 * 1e3 * Number(match[1] || "0") + 60 * 1e3 * Number(match[2]) + 1e3 * Number(match[3]) + Number(match[4]);
    };
    _formatTimestamp = /* @__PURE__ */ new WeakSet();
    formatTimestamp_fn = function(timestamp) {
      let hours = Math.floor(timestamp / (60 * 60 * 1e3));
      let minutes = Math.floor(timestamp % (60 * 60 * 1e3) / (60 * 1e3));
      let seconds = Math.floor(timestamp % (60 * 1e3) / 1e3);
      let milliseconds = timestamp % 1e3;
      return hours.toString().padStart(2, "0") + ":" + minutes.toString().padStart(2, "0") + ":" + seconds.toString().padStart(2, "0") + "." + milliseconds.toString().padStart(3, "0");
    };
  }
});

// src/client/exporter.js
var exporter_exports = {};
__export(exporter_exports, {
  ExportError: () => ExportError,
  MAX_BITRATE_KBPS: () => MAX_BITRATE_KBPS,
  MAX_EXPORT_FPS: () => MAX_EXPORT_FPS,
  MIN_BITRATE_KBPS: () => MIN_BITRATE_KBPS,
  exportTimeline: () => exportTimeline,
  planExport: () => planExport,
  prepareAudio: () => prepareAudio
});
async function exportTimeline(opts = {}) {
  const startedAt = Date.now();
  const { drawFrame: drawFrame2, title, onProgress, signal } = opts;
  const audioBuffer = opts.audioBuffer;
  if (typeof drawFrame2 !== "function") throw new ExportError("INVALID_ARG", "drawFrame \u5FC5\u987B\u662F\u51FD\u6570");
  const plan = planExport(opts);
  const { width, height, fps, totalFrames, range } = plan;
  if (signal && signal.aborted) throw new ExportError("ABORTED", "\u5BFC\u51FA\u5DF2\u53D6\u6D88");
  emit(onProgress, "setup", 0, "\u68C0\u6D4B\u7F16\u7801\u5668");
  const { picked, fallback } = await resolveEncoder(plan, width, height, plan.bitrate);
  const audioCodec = picked.audioCodec !== void 0 ? picked.audioCodec : picked.container === "mp4" ? "aac" : "opus";
  let audioPlan = null;
  let audioWarning = null;
  if (audioBuffer !== void 0 && audioBuffer !== null) {
    if (audioCodec) {
      try {
        const prepared = await prepareAudio(audioBuffer, audioCodec, plan);
        audioPlan = prepared.plan;
        audioWarning = prepared.warning || audioWarning;
      } catch {
        audioPlan = null;
        audioWarning = "INVALID_AUDIO_BUFFER";
      }
    } else {
      audioWarning = "NO_AUDIO_CODEC";
    }
  }
  const canvas = createCanvas(width, height);
  const ctx2 = canvas.getContext("2d", { alpha: false });
  if (!ctx2) throw new ExportError("NO_CANVAS", "\u5F53\u524D\u73AF\u5883\u65E0\u6CD5\u521B\u5EFA 2D \u753B\u5E03");
  let muxer = null;
  let muxTarget = null;
  let videoEncoder = null;
  let audioEncoder = null;
  let videoError = null;
  let audioError = null;
  let muxError = null;
  let audioBytes = 0;
  let firstVideoChunk = true;
  const pendingAudio = [];
  let audioCursor = 0;
  const drainAudio = (limitUs) => {
    while (audioCursor < pendingAudio.length) {
      const item = pendingAudio[audioCursor];
      if (limitUs !== void 0 && item.chunk.timestamp > limitUs) break;
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
  const handleOutput = (chunk, meta) => {
    if (isAudioChunk(chunk)) {
      pendingAudio.push({ chunk, meta });
      return;
    }
    if (firstVideoChunk) {
      firstVideoChunk = false;
      if (picked.container === "mp4" && isHevcCodec(picked.codec) && !hasCodecDescription(meta)) {
        muxError = new ExportError(
          "ENCODER_INCOMPLETE",
          "\u8FD9\u53F0\u673A\u5668\u7684 HEVC \u7F16\u7801\u5668\u6CA1\u6709\u7ED9\u51FA hvcC \u89E3\u7801\u914D\u7F6E\uFF0CMP4 \u5C01\u88C5\u5668\u8981\u5230\u6536\u5C3E\u65F6\u624D\u4F1A\u53D1\u73B0\uFF0C\u88C5\u4E0D\u51FA\u6765\u3002\u6362\u4E00\u53F0\u652F\u6301\u5B8C\u6574 WebCodecs HEVC \u7F16\u7801\u7684\u673A\u5668\uFF0C\u6216\u6539\u7528 WebM\uFF08VP9 / AV1\uFF09\u3002"
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
    if (audioPlan) {
      try {
        audioEncoder = new AudioEncoder({
          output: handleOutput,
          error: (err) => {
            audioError = audioError || err;
          }
        });
        audioEncoder.configure(audioPlan.config);
      } catch {
        closeQuietly(audioEncoder);
        audioEncoder = null;
        audioPlan = null;
        audioWarning = "NO_AUDIO_ENCODER";
      }
    }
    const created = createMuxer(picked, width, height, fps, audioPlan);
    muxer = created.muxer;
    muxTarget = created.target;
    const audioChunks = audioPlan ? audioPlan.totalChunks : 0;
    const totalUnits = totalFrames + audioChunks;
    videoEncoder = new VideoEncoder({
      output: handleOutput,
      error: (err) => {
        videoError = videoError || err;
      }
    });
    videoEncoder.configure(picked.config);
    if (audioPlan) {
      try {
        emit(onProgress, "audio", 0, "\u7F16\u7801\u97F3\u8F68");
        const { chunkFrames, frames } = audioPlan;
        for (let offset = 0, index = 0; offset < frames; offset += chunkFrames, index += 1) {
          if (audioError) break;
          throwIfAborted(signal, videoEncoder, audioEncoder);
          const count = Math.min(chunkFrames, frames - offset);
          const audioData = new AudioData({
            format: "f32-planar",
            sampleRate: AUDIO_SAMPLE_RATE,
            numberOfFrames: count,
            numberOfChannels: AUDIO_CHANNELS,
            timestamp: Math.round(offset / AUDIO_SAMPLE_RATE * 1e6),
            data: readPlanarBlock(audioPlan, offset, count)
          });
          try {
            audioEncoder.encode(audioData);
          } finally {
            audioData.close();
          }
          emit(onProgress, "audio", (index + 1) / totalUnits);
          while (audioEncoder.encodeQueueSize > MAX_AUDIO_QUEUE) {
            throwIfAborted(signal, videoEncoder, audioEncoder);
            if (audioError) break;
            await sleep(QUEUE_POLL_MS);
          }
        }
        await audioEncoder.flush();
      } catch (err) {
        if (err && err.code === "ABORTED") throw err;
        audioError = audioError || err;
      }
      closeQuietly(audioEncoder);
      audioEncoder = null;
      if (audioError && !audioWarning) audioWarning = "AUDIO_ENCODE_FAILED";
    }
    const keyInterval = Math.max(1, Math.round(fps * KEYFRAME_SECONDS));
    const frameDuration = Math.max(1, Math.round(1e6 / fps));
    for (let i = 0; i < totalFrames; i += 1) {
      throwIfAborted(signal, videoEncoder, audioEncoder);
      if (videoError) throw videoError;
      if (muxError) throw muxError;
      const t = range.start + i / fps;
      await drawFrame2(ctx2, t, width, height);
      throwIfAborted(signal, videoEncoder, audioEncoder);
      drainAudio(Math.round(i * 1e6 / fps));
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(i * 1e6 / fps),
        duration: frameDuration
      });
      try {
        videoEncoder.encode(frame, { keyFrame: i % keyInterval === 0 });
      } finally {
        frame.close();
      }
      emit(onProgress, "encode", (audioChunks + i) / totalUnits);
      while (videoEncoder.encodeQueueSize > MAX_QUEUE) {
        throwIfAborted(signal, videoEncoder, audioEncoder);
        if (videoError) throw videoError;
        await sleep(QUEUE_POLL_MS);
      }
    }
    emit(onProgress, "finalize", 1, "\u5199\u5165\u5BB9\u5668");
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
  if (!buffer || buffer.byteLength === 0) throw new ExportError("ENCODE_FAILED", "\u5C01\u88C5\u5668\u6CA1\u6709\u4EA7\u51FA\u6570\u636E");
  const blob = new Blob([buffer], { type: MIME[picked.container] });
  const fileName = buildFileName(title, picked.container);
  emit(onProgress, "done", 1, "\u5BFC\u51FA\u5B8C\u6210");
  const result = {
    blob,
    fileName,
    container: picked.container,
    codec: picked.codec,
    // 实际用的编码家族（h264 / hevc / vp9 / av1）—— codec 是 WebCodecs 字串，
    // 这个字段给「事后确认到底用了哪个编码器」用。
    videoCodec: picked.videoCodec || "",
    fps: plan.fps,
    sourceFps: plan.projectFps,
    duration: plan.duration,
    frames: totalFrames,
    ms: Date.now() - startedAt
  };
  if (fallback) result.encoderFallback = fallback;
  if (audioPlan) {
    result.audioBytes = audioBytes;
    result.audioCodec = audioPlan.name;
    if (Number.isFinite(audioPlan.peak)) {
      result.audioPeak = Math.round(audioPlan.peak * 1e3) / 1e3;
    }
    if (audioPlan.trimmed) {
      result.audioPeakAfterTrim = Math.round(audioPlan.peakAfterTrim * 1e3) / 1e3;
      result.audioTrimDb = Math.round(20 * Math.log10(audioPlan.trimGain) * 10) / 10;
    }
    if (audioPlan.lufs != null && Number.isFinite(audioPlan.lufs)) {
      result.audioLufs = Math.round(audioPlan.lufs * 10) / 10;
    }
  } else if (plan.output) {
    result.audioCodec = null;
  }
  if (audioWarning) result.audioWarning = audioWarning;
  return result;
}
async function prepareAudio(audioBuffer, audioCodec, plan) {
  const target = AUDIO_TARGETS[audioCodec];
  if (!target || !isAudioBufferLike(audioBuffer)) return { plan: null, warning: "INVALID_AUDIO_BUFFER" };
  if (!hasAudioEncoder()) return { plan: null, warning: "NO_AUDIO_ENCODER" };
  const config = {
    codec: target.codec,
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfChannels: AUDIO_CHANNELS,
    bitrate: AUDIO_BITRATE
  };
  if (!await isAudioConfigSupported(config)) return { plan: null, warning: "NO_AUDIO_ENCODER" };
  const srcRate = audioBuffer.sampleRate;
  const srcChannels = Math.min(AUDIO_CHANNELS, audioBuffer.numberOfChannels);
  let source = [];
  for (let ch = 0; ch < AUDIO_CHANNELS; ch += 1) {
    source.push(audioBuffer.getChannelData(Math.min(ch, srcChannels - 1)));
  }
  const offset = Math.round(Math.max(0, plan.range.start) * AUDIO_SAMPLE_RATE);
  const available = Math.max(0, audioBuffer.duration - plan.range.start);
  const byDuration = Math.round(Math.min(available, plan.duration) * AUDIO_SAMPLE_RATE);
  const byLength = Math.round(audioBuffer.length * AUDIO_SAMPLE_RATE / srcRate) - offset;
  const frames = Math.max(0, Math.min(byDuration, byLength));
  if (!(frames > 0)) return { plan: null, warning: "INVALID_AUDIO_BUFFER" };
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
      trimGain
    },
    warning: trimmed ? "AUDIO_PEAK_TRIMMED" : null
  };
}
function peakOfRange(channels, srcRate, offset48k, frames48k) {
  const start = Math.round(offset48k * srcRate / AUDIO_SAMPLE_RATE);
  const count = Math.max(1, Math.round(frames48k * srcRate / AUDIO_SAMPLE_RATE));
  let peak = 0;
  for (const channel of channels) {
    const end = Math.min(channel.length, start + count);
    for (let i = Math.max(0, start); i < end; i += 1) {
      const v2 = channel[i];
      if (!Number.isFinite(v2)) continue;
      const a = v2 < 0 ? -v2 : v2;
      if (a > peak) peak = a;
    }
  }
  return peak;
}
function hasAudioEncoder() {
  return typeof AudioEncoder === "function" && typeof AudioData === "function" && typeof AudioEncoder.isConfigSupported === "function";
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
  return !!value && typeof value === "object" && typeof value.getChannelData === "function" && Number.isFinite(value.sampleRate) && value.sampleRate > 0 && Number.isFinite(value.length) && value.length > 0 && Number.isFinite(value.duration) && value.duration > 0 && Number.isInteger(value.numberOfChannels) && value.numberOfChannels >= 1;
}
function isAudioChunk(chunk) {
  return typeof EncodedAudioChunk === "function" && chunk instanceof EncodedAudioChunk;
}
function readPlanarBlock(plan, blockOffset, frames) {
  const { source, srcRate } = plan;
  const start = (plan.offset || 0) + blockOffset;
  const out = new Float32Array(frames * AUDIO_CHANNELS);
  for (let ch = 0; ch < AUDIO_CHANNELS; ch += 1) {
    const src = source[ch];
    const base = ch * frames;
    if (srcRate === AUDIO_SAMPLE_RATE) {
      const end = Math.min(start + frames, src.length);
      out.set(src.subarray(start, end), base);
      continue;
    }
    const step = srcRate / AUDIO_SAMPLE_RATE;
    const last2 = src.length - 1;
    for (let i = 0; i < frames; i += 1) {
      const pos = (start + i) * step;
      const i0 = Math.min(last2, Math.floor(pos));
      const i1 = Math.min(last2, i0 + 1);
      const frac = Math.min(1, Math.max(0, pos - i0));
      out[base + i] = src[i0] + (src[i1] - src[i0]) * frac;
    }
  }
  return out;
}
function encoderChoices(output) {
  const list = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (choice) => {
    let choiceNormalized;
    try {
      choiceNormalized = normalizeChoice(choice);
    } catch {
      return;
    }
    const key = choiceNormalized.container + "|" + choiceNormalized.codec + "|" + String(choiceNormalized.audioCodec);
    if (seen.has(key)) return;
    seen.add(key);
    list.push(choiceNormalized);
  };
  if (output) add(output);
  const keepSilent = !!(output && output.audioCodec === null);
  for (const family of FALLBACK_CHOICES) {
    add({
      container: family.container,
      videoCodec: family.videoCodec,
      codec: (VIDEO_CANDIDATES[family.videoCodec] || [])[0],
      audioCodec: keepSilent ? null : family.audioCodec,
      reason: ""
    });
  }
  for (const family of FALLBACK_CHOICES) {
    add({
      container: family.container,
      videoCodec: family.videoCodec,
      codec: (VIDEO_CANDIDATES[family.videoCodec] || [])[0],
      audioCodec: null,
      reason: "\u97F3\u8F68\u7F16\u7801\u4E0D\u53EF\u7528\uFF0C\u5BFC\u51FA\u65E0\u97F3\u8F68\u89C6\u9891"
    });
  }
  return list;
}
function codecLabel(choice) {
  const container = String(choice.container || "").toUpperCase();
  const codec = choice.codec || (VIDEO_CANDIDATES[choice.videoCodec] || [])[0] || "";
  return container + " / " + codec;
}
function sameEncoder(a, b) {
  return !!a && !!b && a.container === b.container && a.codec === b.codec;
}
async function resolveEncoder(plan, width, height, bitrate) {
  const choices = encoderChoices(plan.output);
  const tried = [];
  for (const choice of choices) {
    const picked = await confirmChoice(choice, width, height, plan.fps, bitrate);
    if (picked) {
      const fallback = plan.output && !sameEncoder(plan.output, picked) ? {
        from: { container: plan.output.container, codec: plan.output.codec },
        to: { container: picked.container, codec: picked.codec },
        note: "\u8BA1\u5212\u91CC\u7684 " + codecLabel(plan.output) + " \u5728\u8FD9\u53F0\u673A\u5668\u4E0A\u5B9E\u6D4B\u4E0D\u53EF\u7528\uFF0C\u5DF2\u6539\u7528 " + codecLabel(picked) + "\uFF1B\u8FD9\u4E0D\u662F\u9519\u8BEF\uFF0C\u662F\u7F16\u7801\u5668\u56DE\u9000\u3002"
      } : null;
      return { picked, fallback, tried };
    }
    tried.push(codecLabel(choice));
  }
  throw new ExportError(
    "NO_ENCODER",
    "\u8FD9\u53F0\u673A\u5668\u6CA1\u6709\u53EF\u7528\u7684\u89C6\u9891\u7F16\u7801\u5668\uFF1A" + tried.join(" / ") + " \u90FD\u5B9E\u6D4B\u4E0D\u53EF\u7528\u3002\u53EA\u6709 H.264 / HEVC / VP9 / AV1 \u5168\u90E8\u8D70\u4E0D\u901A\u65F6\u624D\u662F\u8FD9\u4E2A\u9519\u8BEF\uFF1B\u8BF7\u6362\u4E00\u4E2A\u652F\u6301 WebCodecs \u7684\u6D4F\u89C8\u5668\uFF0C\u6216\u5728\u6709\u786C\u4EF6\u7F16\u7801\u7684\u673A\u5668\u4E0A\u91CD\u8BD5\u3002",
    { tried }
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
async function confirmChoice(output, width, height, fps, bitrate) {
  if (output.container === "webm" && !WEBM_AVAILABLE) return null;
  if (typeof VideoEncoder !== "function" || typeof VideoFrame !== "function") return null;
  if (typeof VideoEncoder.isConfigSupported !== "function") return null;
  if (!Number.isFinite(bitrate) || bitrate <= 0) bitrate = estimateBitrate(width, height, fps);
  const base = { codec: output.codec, width, height, bitrate };
  let config = { ...base, framerate: fps };
  if (!await isSupported(config)) {
    config = { ...base };
    if (!await isSupported(config)) return null;
  }
  return {
    container: output.container,
    videoCodec: output.videoCodec,
    codec: output.codec,
    muxerCodec: output.muxerVideoCodec,
    audioCodec: output.audioCodec,
    config
  };
}
function estimateBitrate(width, height, fps) {
  const raw = width * height * fps * 0.12;
  return Math.round(Math.min(16e6, Math.max(8e5, raw)));
}
function isHevcCodec(codec) {
  const text = String(codec || "");
  return text.startsWith("hvc1") || text.startsWith("hev1");
}
function hasCodecDescription(meta) {
  const description = meta && meta.decoderConfig ? meta.decoderConfig.description : void 0;
  return !!(description && description.byteLength > 0);
}
function createMuxer(picked, width, height, fps, audioPlan) {
  const frameRate = Math.max(1, Math.round(fps));
  const target = picked.container === "mp4" ? new ArrayBufferTarget() : new ArrayBufferTarget2();
  const video = { codec: picked.muxerCodec, width, height, frameRate };
  const audio = audioPlan ? { codec: audioPlan.muxerCodec, numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE } : null;
  const muxer = picked.container === "mp4" ? new Muxer({ target, video, ...audio ? { audio } : {}, fastStart: "in-memory" }) : new Muxer2({ target, video, ...audio ? { audio } : {} });
  return { muxer, target };
}
function createCanvas(width, height) {
  if (typeof OffscreenCanvas === "function") {
    try {
      return new OffscreenCanvas(width, height);
    } catch {
    }
  }
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new ExportError("NO_CANVAS", "\u5F53\u524D\u73AF\u5883\u65E2\u6CA1\u6709 OffscreenCanvas \u4E5F\u6CA1\u6709 document");
}
function planExport(opts = {}) {
  const timeline = Number(opts.duration);
  if (!Number.isFinite(timeline) || timeline <= 0) throw new ExportError("INVALID_ARG", "duration \u5FC5\u987B\u662F\u6B63\u6570");
  const fps = normalizeFps(opts.fps);
  const projectFps = normalizeProjectFps(opts.projectFps, fps);
  const width = normalizeDimension(opts.width, "\u5BBD\u5EA6");
  const height = normalizeDimension(opts.height, "\u9AD8\u5EA6");
  const bitrateKbps = normalizeBitrate(opts.bitrateKbps);
  const bitrate = bitrateKbps == null ? estimateBitrate(width, height, fps) : Math.round(bitrateKbps * 1e3);
  const range = normalizeRange2(opts.range, timeline);
  const duration = range.end - range.start;
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const sampleStep = +(projectFps / fps).toFixed(6);
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
    output
  };
}
function resolveOutput(opts = {}) {
  const requested = opts.plan;
  if (requested !== void 0 && requested !== null) return normalizeChoice(requested);
  const caps = opts.caps;
  if (caps !== void 0 && caps !== null) {
    let choice;
    try {
      choice = chooseExportPlan(caps);
    } catch (err) {
      throw asExportError(err, "NO_ENCODER");
    }
    return normalizeChoice(choice);
  }
  return null;
}
function normalizeChoice(choice) {
  if (!choice || typeof choice !== "object") {
    throw new ExportError("INVALID_ARG", "\u5BFC\u51FA\u8BA1\u5212\u5FC5\u987B\u662F\u5BF9\u8C61");
  }
  const container = choice.container;
  if (container !== "mp4" && container !== "webm") {
    throw new ExportError("INVALID_ARG", "\u5BFC\u51FA\u5BB9\u5668\u53EA\u80FD\u662F mp4 \u6216 webm\uFF0C\u6536\u5230 " + String(container));
  }
  const videoCodec = choice.videoCodec;
  const muxerCodecs = MUXER_VIDEO_CODECS[container];
  if (!muxerCodecs || !Object.prototype.hasOwnProperty.call(muxerCodecs, videoCodec)) {
    throw new ExportError("INVALID_ARG", `${container} \u5BB9\u5668\u88C5\u4E0D\u4E86 ${String(videoCodec)} \u89C6\u9891\u7F16\u7801`);
  }
  const audioCodec = choice.audioCodec === void 0 ? null : choice.audioCodec;
  if (!CONTAINER_AUDIO[container].includes(audioCodec)) {
    const allowed = CONTAINER_AUDIO[container].filter(Boolean).map((name) => name.toUpperCase()).join(" / ");
    throw new ExportError("INVALID_ARG", `${container} \u5BB9\u5668\u7684\u97F3\u8F68\u53EA\u80FD\u662F ${allowed} \u6216\u65E0\u97F3\u8F68`);
  }
  if (container === "webm" && !WEBM_AVAILABLE) {
    throw new ExportError(
      "CONTAINER_UNSUPPORTED",
      "WebM \u5206\u652F\u9700\u8981 webm-muxer \u4F9D\u8D56\uFF0C\u5F53\u524D\u6784\u5EFA\u91CC\u6CA1\u6709\uFF1A\u5BFC\u4E0D\u4E86 WebM\u3002\u8981\u5BFC\u51FA MP4 \u9700\u8981 H.264 \u6216 HEVC \u7F16\u7801\u5668 + AAC \u97F3\u8F68\uFF1B\u8981\u7528 VP9 / AV1 + Opus\uFF0C\u5F97\u628A webm-muxer \u88C5\u56DE\u6765\u3002"
    );
  }
  const codec = typeof choice.codec === "string" && choice.codec ? choice.codec : (VIDEO_CANDIDATES[videoCodec] || [])[0];
  if (!codec) throw new ExportError("INVALID_ARG", `\u6CA1\u6709 ${videoCodec} \u7684 codec \u5B57\u4E32`);
  return {
    container,
    videoCodec,
    codec,
    audioCodec,
    muxerVideoCodec: muxerCodecs[videoCodec],
    reason: typeof choice.reason === "string" ? choice.reason : ""
  };
}
function asExportError(err, fallbackCode) {
  if (err instanceof ExportError) return err;
  const code = err && err.code ? err.code : fallbackCode;
  return new ExportError(code, err && err.message || "\u5BFC\u51FA\u7EC4\u5408\u4E0D\u53EF\u7528", err && err.details);
}
function normalizeDimension(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new ExportError("INVALID_ARG", label + " \u5FC5\u987B\u662F\u6B63\u6570");
  if (n > MAX_DIMENSION) throw new ExportError("INVALID_ARG", label + ` \u4E0D\u80FD\u8D85\u8FC7 ${MAX_DIMENSION}`);
  return evenUp(n);
}
function normalizeBitrate(value) {
  if (value === void 0 || value === null || value === "") return null;
  const kbps = Number(value);
  if (!Number.isFinite(kbps)) throw new ExportError("INVALID_ARG", "\u7801\u7387\u5FC5\u987B\u662F\u6570\u5B57");
  if (kbps < MIN_BITRATE_KBPS || kbps > MAX_BITRATE_KBPS) {
    throw new ExportError("INVALID_ARG", `\u7801\u7387\u9700\u5728 ${MIN_BITRATE_KBPS}\u2013${MAX_BITRATE_KBPS} kbps \u4E4B\u95F4`, {
      bitrateKbps: kbps
    });
  }
  return kbps;
}
function normalizeProjectFps(value, fallback) {
  if (value === void 0 || value === null) return fallback;
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps <= 0) throw new ExportError("INVALID_ARG", "projectFps \u5FC5\u987B\u662F\u6B63\u6570");
  return fps;
}
function normalizeRange2(range, timeline) {
  if (range === void 0 || range === null) return { start: 0, end: timeline };
  if (typeof range !== "object") throw new ExportError("INVALID_ARG", "range \u5FC5\u987B\u662F {start, end}");
  const start = range.start === void 0 || range.start === null ? 0 : Number(range.start);
  const rawEnd = range.end === void 0 || range.end === null ? timeline : Number(range.end);
  if (!Number.isFinite(start) || !Number.isFinite(rawEnd)) {
    throw new ExportError("INVALID_ARG", "\u5BFC\u51FA\u8303\u56F4\u7684\u8D77\u6B62\u5FC5\u987B\u662F\u6570\u5B57");
  }
  if (start < 0) throw new ExportError("INVALID_ARG", "\u5BFC\u51FA\u8303\u56F4\u7684\u8D77\u70B9\u4E0D\u80FD\u662F\u8D1F\u6570");
  if (start >= timeline) {
    throw new ExportError("INVALID_ARG", "\u5BFC\u51FA\u8303\u56F4\u7684\u8D77\u70B9\u5DF2\u7ECF\u8D85\u51FA\u5DE5\u7A0B\u65F6\u957F", { start, timeline });
  }
  if (rawEnd <= start) {
    throw new ExportError("INVALID_ARG", "\u5BFC\u51FA\u8303\u56F4\u7684\u7ED3\u675F\u65F6\u95F4\u5FC5\u987B\u5927\u4E8E\u5F00\u59CB\u65F6\u95F4", { range: { start, end: rawEnd } });
  }
  const end = Math.min(rawEnd, timeline);
  return { start, end };
}
function normalizeFps(value) {
  const fps = value === void 0 ? 30 : Number(value);
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new ExportError("INVALID_ARG", "fps \u5FC5\u987B\u662F\u5927\u4E8E 0 \u7684\u6570\u5B57\uFF0C\u6536\u5230 " + String(value));
  }
  if (fps > MAX_EXPORT_FPS) {
    throw new ExportError("INVALID_ARG", `fps \u4E0D\u80FD\u8D85\u8FC7 ${MAX_EXPORT_FPS}\uFF0C\u6536\u5230 ${fps}`);
  }
  return fps;
}
function evenUp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const rounded = Math.max(2, Math.round(n));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}
function throwIfAborted(signal, ...encoders) {
  if (!signal || signal.aborted !== true) return;
  for (const encoder of encoders) closeQuietly(encoder);
  throw new ExportError("ABORTED", "\u5BFC\u51FA\u5DF2\u53D6\u6D88");
}
function closeQuietly(encoder) {
  if (!encoder) return;
  try {
    encoder.close();
  } catch {
  }
}
function normalizeError(err) {
  if (err && err.code) return err;
  const wrapped = new ExportError("ENCODE_FAILED", err && err.message || "\u5BFC\u51FA\u5931\u8D25");
  wrapped.cause = err;
  return wrapped;
}
function emit(onProgress, phase, ratio, message) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress(message === void 0 ? { phase, ratio } : { phase, ratio, message });
  } catch {
  }
}
function buildFileName(title, container) {
  return `${safeTitle(title)}-${stamp(/* @__PURE__ */ new Date())}.${container}`;
}
function safeTitle(raw) {
  const text = String(raw === void 0 || raw === null ? "" : raw).replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, "-").replace(/\s+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60).replace(/[-.]+$/g, "");
  return text || "video";
}
function stamp(date) {
  const pad2 = (n, width = 2) => String(n).padStart(width, "0");
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var MAX_EXPORT_FPS, FALLBACK_CHOICES, MUXER_VIDEO_CODECS, CONTAINER_AUDIO, WEBM_AVAILABLE, AUDIO_TARGETS, MIME, MAX_QUEUE, QUEUE_POLL_MS, KEYFRAME_SECONDS, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS, AUDIO_BITRATE, MAX_AUDIO_QUEUE, MIN_BITRATE_KBPS, MAX_BITRATE_KBPS, MAX_DIMENSION, ExportError;
var init_exporter = __esm({
  "src/client/exporter.js"() {
    init_mp4_muxer();
    init_webm_muxer();
    init_audio_mix();
    init_codec_caps();
    MAX_EXPORT_FPS = 120;
    FALLBACK_CHOICES = [
      { container: "mp4", videoCodec: "h264", audioCodec: "aac" },
      { container: "mp4", videoCodec: "hevc", audioCodec: "aac" },
      { container: "webm", videoCodec: "vp9", audioCodec: "opus" },
      { container: "webm", videoCodec: "av1", audioCodec: "opus" }
    ];
    MUXER_VIDEO_CODECS = {
      mp4: { h264: "avc", hevc: "hevc", vp9: "vp9", av1: "av1" },
      webm: { vp9: "V_VP9", av1: "V_AV1" }
    };
    CONTAINER_AUDIO = { mp4: ["aac", null], webm: ["opus", null] };
    WEBM_AVAILABLE = typeof Muxer2 === "function" && typeof ArrayBufferTarget2 === "function";
    AUDIO_TARGETS = {
      aac: { codec: "mp4a.40.2", name: "aac", muxerCodec: "aac", chunkFrames: 1024 },
      // AAC-LC
      opus: { codec: "opus", name: "opus", muxerCodec: "A_OPUS", chunkFrames: 960 }
      // 20ms @ 48k
    };
    MIME = { mp4: "video/mp4", webm: "video/webm" };
    MAX_QUEUE = 8;
    QUEUE_POLL_MS = 4;
    KEYFRAME_SECONDS = 2;
    AUDIO_SAMPLE_RATE = 48e3;
    AUDIO_CHANNELS = 2;
    AUDIO_BITRATE = 128e3;
    MAX_AUDIO_QUEUE = 16;
    MIN_BITRATE_KBPS = 100;
    MAX_BITRATE_KBPS = 5e4;
    MAX_DIMENSION = 8192;
    ExportError = class extends Error {
      constructor(code, message, details) {
        super(message);
        this.name = "ExportError";
        this.code = code;
        if (details !== void 0) this.details = details;
      }
    };
  }
});

// src/client/main.js
var main_exports = {};
__export(main_exports, {
  DockEntry: () => DockEntry,
  Workbench: () => Workbench,
  default: () => main_default
});
module.exports = __toCommonJS(main_exports);
var import_react3 = __toESM(require("react"), 1);

// src/client/bridge.js
async function rpc(method, params) {
  const res = await fetch("/api/video/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params: params || {} })
  });
  let payload;
  try {
    payload = await res.json();
  } catch {
    throw Object.assign(new Error("\u670D\u52A1\u8FD4\u56DE\u4E86\u975E JSON \u54CD\u5E94"), { code: "BAD_RESPONSE" });
  }
  if (!payload || payload.ok !== true) {
    const err = new Error(payload && payload.error && payload.error.message || "\u8C03\u7528\u5931\u8D25");
    err.code = payload && payload.error && payload.error.code;
    err.details = payload && payload.error && payload.error.details;
    throw err;
  }
  return payload.value;
}
var listeners = /* @__PURE__ */ new Set();
var state = {
  sessionId: null,
  projectId: null,
  doc: null,
  clips: [],
  assets: [],
  // 项目启用制：enabled 是全局登记表（跨会话共享额度），mine 是本会话的工程，
  // active 表示「工作台此刻真的挂载了」—— 启动时它是 false，绝不自动挂载。
  enabled: [],
  max: 2,
  mine: [],
  active: null,
  selection: null,
  // { kind: 'clip' | 'annotation', id }
  playhead: 0,
  playing: false,
  zoom: 70,
  // px per second
  busy: null,
  // { label, ratio } | null
  error: null,
  toast: null,
  history: []
};
function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setState(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) fn();
}
var toastTimer = null;
function toast(message, tone) {
  setState({ toast: { message, tone: tone || "info" } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setState({ toast: null }), 4e3);
}
var CODE_HINT = {
  REVISION_CONFLICT: "\u6570\u636E\u5DF2\u66F4\u65B0\uFF0C\u6B63\u5728\u5237\u65B0\uFF0C\u8BF7\u518D\u8BD5\u4E00\u6B21",
  REF_NOT_FOUND: "\u76EE\u6807\u4E0D\u5B58\u5728\uFF08\u53EF\u80FD\u5DF2\u88AB\u5220\u9664\uFF09",
  BOUND_TO_OTHER_SESSION: "\u8FD9\u4E2A\u5DE5\u7A0B\u7ED1\u5B9A\u5728\u53E6\u4E00\u4E2A\u4F1A\u8BDD\u4E0A",
  OUTSIDE_PROJECT: "\u8DEF\u5F84\u8D8A\u51FA\u5DE5\u7A0B\u76EE\u5F55\uFF0C\u5DF2\u62D2\u7EDD",
  INVALID_OP: "\u8FD9\u4E2A\u64CD\u4F5C\u5728\u5F53\u524D\u72B6\u6001\u4E0B\u4E0D\u5408\u6CD5",
  INVALID_ARG: "\u53C2\u6570\u4E0D\u5408\u6CD5",
  WORKBENCH_OFFLINE: "\u5DE5\u4F5C\u53F0\u6CA1\u6709\u6253\u5F00\uFF0C\u91C7\u6837\u8BF7\u6C42\u5931\u8D25",
  NO_ENCODER: "\u6D4F\u89C8\u5668\u6CA1\u6709\u53EF\u7528\u7684\u89C6\u9891\u7F16\u7801\u5668",
  PAYLOAD_TOO_LARGE: "\u6587\u4EF6\u592A\u5927"
};
function reportError(e, fallback) {
  const message = e && e.message || fallback || "\u672A\u77E5\u9519\u8BEF";
  setState({ error: e && e.code ? `${e.code} \xB7 ${message}` : message });
  const friendly = e && e.code && CODE_HINT[e.code] || message;
  toast(friendly, "warn");
  if (e && e.code === "REVISION_CONFLICT") refresh().catch(() => {
  });
  console.error("[video-workbench]", e);
}
async function openProject(dir) {
  const value = await rpc("project.open", { dir, sessionId: state.sessionId });
  setState({ projectId: value.doc.projectId, doc: value.doc });
  await refresh();
  return value.doc;
}
async function loadEnabled() {
  const value = await rpc("project.enabled.list", {});
  setState({ enabled: value && value.enabled || [], max: value && value.max || 2 });
  return value;
}
async function loadMyProjects(sessionId) {
  const sid = sessionId || state.sessionId;
  if (!sid) return [];
  const value = await rpc("project.list", { sessionId: sid });
  const list = value && value.projects || [];
  setState({ mine: list });
  return list;
}
async function enableProject(projectId, root) {
  const value = await rpc("project.enable", {
    projectId,
    dir: root || void 0,
    sessionId: state.sessionId
  });
  setState({ enabled: value && value.enabled || [], max: value && value.max || 2 });
  return value;
}
async function disableProject(projectId) {
  const value = await rpc("project.disable", { projectId });
  setState({ enabled: value && value.enabled || [], max: value && value.max || 2 });
  return value;
}
async function renameProject(projectId, sessionId, title) {
  const value = await rpc("project.rename", {
    projectId,
    sessionId: sessionId || state.sessionId,
    title
  });
  return value && value.doc;
}
async function rebindProject(projectId, sessionId) {
  const value = await rpc("session.rebind", {
    sessionId: sessionId || state.sessionId,
    projectId
  });
  return value;
}
async function deleteProject(deleteFiles) {
  const doc = state.doc;
  if (!doc) return null;
  const value = await rpc("project.delete", {
    projectId: doc.projectId,
    sessionId: state.sessionId,
    deleteFiles: !!deleteFiles
  });
  setState({ projectId: null, doc: null, clips: [], assets: [], selection: null, playhead: 0 });
  return value;
}
async function refresh() {
  if (!state.projectId) return;
  const value = await rpc("project.timeline", { projectId: state.projectId });
  const order = new Map((value.doc.tracks || []).map((tr, i) => [tr.id, i]));
  const sorted = (value.clips.clips || []).slice().sort((a, b) => {
    const d = (order.get(a.trackId) ?? 99) - (order.get(b.trackId) ?? 99);
    return d !== 0 ? d : a.start - b.start;
  });
  const rawDoc = value.doc || {};
  let annotations;
  if (Array.isArray(rawDoc.annotations)) annotations = rawDoc.annotations;
  else if (Array.isArray(value.annotations)) annotations = value.annotations;
  else if (state.doc && Array.isArray(state.doc.annotations)) annotations = state.doc.annotations;
  else annotations = [];
  if (!Array.isArray(rawDoc.annotations) && !Array.isArray(value.annotations)) {
    console.warn("[video-workbench] project.timeline \u6CA1\u5E26 annotations\uFF0C\u6682\u7528\u4E0A\u4E00\u4EFD\uFF1B\u5BBF\u4E3B\u4E0E\u5BA2\u6237\u7AEF\u7248\u672C\u53EF\u80FD\u4E0D\u4E00\u81F4");
  }
  setState({
    doc: { ...rawDoc, annotations },
    clips: sorted,
    assets: value.assets || state.assets,
    error: null
  });
}
async function dispatch(ops, summary) {
  const doc = state.doc;
  if (!doc) throw new Error("\u5DE5\u7A0B\u672A\u6253\u5F00");
  const p = await rpc("edit.preview", {
    projectId: doc.projectId,
    sessionId: state.sessionId,
    baseRevision: doc.revision,
    summary: summary || "",
    ops
  });
  const applied = await rpc("edit.apply", { previewId: p.previewId, sessionId: state.sessionId });
  await refresh();
  return applied;
}
async function ttsSpeak(text, options = {}) {
  const value = await rpc("tts.speak", {
    projectId: state.projectId,
    sessionId: state.sessionId,
    text,
    ...options
  });
  await refresh();
  return value;
}
function mediaUrl(assetId, options = {}) {
  const base = `/api/video/media?projectId=${encodeURIComponent(state.projectId)}&assetId=${encodeURIComponent(assetId)}`;
  return options.preview ? base + "&variant=preview" : base;
}
function styleFileUrl(relPath, stamp3) {
  return styleFileUrlFor(state.projectId, relPath, stamp3);
}
function styleFileUrlFor(projectId, relPath, stamp3) {
  const base = "/api/video/style-file?projectId=" + encodeURIComponent(projectId == null ? state.projectId : projectId) + "&relPath=" + encodeURIComponent(relPath);
  return stamp3 ? base + "&v=" + encodeURIComponent(stamp3) : base;
}
function uploadStyleAsset(blob, options = {}) {
  const params = new URLSearchParams({
    projectId: String(state.projectId || ""),
    sessionId: String(state.sessionId || ""),
    kind: options.kind === "video" ? "video" : "frame"
  });
  if (params.get("kind") === "frame") {
    params.set("index", String(options.index == null ? 0 : options.index));
    params.set("shotKind", String(options.shotKind || ""));
  } else if (options.container) {
    params.set("container", options.container === "webm" ? "webm" : "mp4");
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/video/style-upload?" + params.toString(), true);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.onload = () => {
      let payload = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        return reject(Object.assign(new Error("\u4E0A\u4F20\u54CD\u5E94\u65E0\u6CD5\u89E3\u6790"), { code: "BAD_RESPONSE" }));
      }
      if (xhr.status >= 400 || !payload || !payload.ok) {
        const err = payload && payload.error ? payload.error : { code: "UPLOAD_FAILED", message: "\u4E0A\u4F20\u5931\u8D25" };
        return reject(Object.assign(new Error(err.message), err));
      }
      resolve(payload.value);
    };
    xhr.onerror = () => reject(Object.assign(new Error("\u7F51\u7EDC\u9519\u8BEF\uFF0C\u6837\u7247\u4E0A\u4F20\u4E2D\u65AD"), { code: "NETWORK" }));
    xhr.send(blob);
  });
}
async function scanAssets() {
  const value = await rpc("asset.scan", { projectId: state.projectId });
  return value.files;
}
function uploadFile(file, onProgress) {
  const url2 = "/api/video/import?projectId=" + encodeURIComponent(state.projectId) + "&sessionId=" + encodeURIComponent(state.sessionId) + "&name=" + encodeURIComponent(file.name);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url2, true);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.min(0.99, e.loaded / e.total));
    };
    xhr.onload = () => {
      let payload = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        return reject(Object.assign(new Error("\u5BFC\u5165\u54CD\u5E94\u65E0\u6CD5\u89E3\u6790"), { code: "BAD_RESPONSE" }));
      }
      if (xhr.status >= 400 || !payload || !payload.ok) {
        const err = payload && payload.error ? payload.error : { code: "IMPORT_FAILED", message: "\u5BFC\u5165\u5931\u8D25" };
        return reject(Object.assign(new Error(err.message), err));
      }
      if (onProgress) onProgress(1);
      resolve(payload.value.asset);
    };
    xhr.onerror = () => reject(Object.assign(new Error("\u7F51\u7EDC\u9519\u8BEF\uFF0C\u5BFC\u5165\u4E2D\u65AD"), { code: "NETWORK" }));
    xhr.send(file);
  });
}
async function syncAssetsFromDisk() {
  const value = await rpc("asset.scan", { projectId: state.projectId });
  const have = new Set((state.doc ? state.doc.assets : []).map((a) => a.path));
  const missing = (value.files || []).filter((f) => !have.has(f.relPath));
  if (!missing.length) return 0;
  const ops = missing.map((f) => ({
    type: "asset.add",
    assetId: "asset_" + Math.random().toString(36).slice(2, 10),
    relPath: f.relPath,
    name: f.name,
    size: f.size,
    hash: null,
    mime: f.mime
  }));
  await dispatch(ops, "\u767B\u8BB0\u5DF2\u6709\u7D20\u6750");
  return missing.length;
}
function pxToTime(px) {
  return Math.max(0, px / state.zoom);
}
function fmtTime(t) {
  const s = Math.max(0, t || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

// src/client/timeline.js
var import_react = __toESM(require("react"), 1);

// src/domain.mjs
init_audio_mix();
var DomainError = class extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
};
var FINITE = (n) => typeof n === "number" && Number.isFinite(n);
var round = (n) => Math.round(n * 1e3) / 1e3;
var ANNOTATION_INTENTS = ["change", "issue", "question", "note"];
var AUDIO_ROLES = /* @__PURE__ */ new Set(["voice", "music", "sfx"]);
var AUDIO_DEFAULTS = Object.freeze({ volume: 1, fadeIn: 0, fadeOut: 0, muted: false });
var AUDIO_PROP_FIELDS = Object.freeze(["volume", "muted", "fadeIn", "fadeOut"]);
function isValidBezier(b) {
  return Array.isArray(b) && b.length === 4 && b.every((n) => FINITE(n) && n >= 0 && n <= 1);
}
function assertBezier(b) {
  if (!Array.isArray(b) || b.length !== 4) {
    throw new DomainError("INVALID_OP", "bezier \u5FC5\u987B\u662F [x1, y1, x2, y2] \u56DB\u4E2A\u6570\u5B57");
  }
  for (let i = 0; i < 4; i += 1) {
    const n = b[i];
    if (!FINITE(n)) {
      throw new DomainError("INVALID_OP", `bezier \u7B2C ${i + 1} \u4E2A\u5206\u91CF\u5FC5\u987B\u662F\u6570\u5B57\uFF0C\u6536\u5230 ${JSON.stringify(n)}`);
    }
    if (n < 0 || n > 1) {
      throw new DomainError("INVALID_OP", `bezier \u7B2C ${i + 1} \u4E2A\u5206\u91CF\u5FC5\u987B\u5728 0..1 \u4E4B\u95F4\uFF0C\u6536\u5230 ${n}`);
    }
  }
  return b.map(round);
}
function bezierCoord(t, p1, p2) {
  const mt = 1 - t;
  return 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t;
}
function bezierSlope(t, p1, p2) {
  const mt = 1 - t;
  return 3 * mt * mt * p1 + 6 * mt * t * (p2 - p1) + 3 * t * t * (1 - p2);
}
function bezierEase(x1, y1, x2, y2, k) {
  const p = [x1, y1, x2, y2].map(Number);
  if (!p.every((n) => Number.isFinite(n))) {
    throw new DomainError("INVALID_OP", "bezierEase \u7684\u63A7\u5236\u70B9\u5FC5\u987B\u662F\u6570\u5B57");
  }
  const kk = FINITE(k) ? k : 0;
  if (kk <= 0) return 0;
  if (kk >= 1) return 1;
  let t = kk;
  for (let i = 0; i < 8; i += 1) {
    const err = bezierCoord(t, p[0], p[2]) - kk;
    if (Math.abs(err) < 1e-6) return bezierCoord(t, p[1], p[3]);
    const d = bezierSlope(t, p[0], p[2]);
    if (Math.abs(d) < 1e-6) break;
    const next = t - err / d;
    if (!(next >= 0 && next <= 1)) break;
    t = next;
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i += 1) {
    t = (lo + hi) / 2;
    if (bezierCoord(t, p[0], p[2]) < kk) lo = t;
    else hi = t;
  }
  return bezierCoord(t, p[1], p[3]);
}
var TEXT_FONT_FAMILIES = ["system-ui", "Microsoft YaHei", "SimHei", "serif", "monospace"];
var TEXT_FONT_WEIGHTS = [400, 600, 700, 900];
var TEXT_ALIGNS = ["left", "center", "right"];
var TEXT_SIZE_MIN = 12;
var TEXT_SIZE_MAX = 200;
var TEXT_LINE_HEIGHT_MIN = 1;
var TEXT_LINE_HEIGHT_MAX = 3;
var TEXT_STYLE_FIELDS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "color",
  "stroke",
  "shadow",
  "align",
  "lineHeight",
  // 旧字段，保留兼容：y 是位置，bold 是「粗细」的布尔写法
  "y",
  "bold"
];
var TEXT_INTERNAL_FIELDS = ["skeleton", "skeletonOf", "shotIndex"];
var HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
var LEGACY_COLOR = /^#[0-9a-fA-F]{3,8}$/;
function isValidHexColor(v2) {
  return typeof v2 === "string" && HEX_COLOR.test(v2);
}
function assertHexColor(name, v2) {
  if (!isValidHexColor(v2)) {
    throw new DomainError("INVALID_ARG", `${name} \u5FC5\u987B\u662F #rrggbb \u516D\u4F4D\u5341\u516D\u8FDB\u5236\u989C\u8272\uFF0C\u6536\u5230 ${JSON.stringify(v2)}`);
  }
  return v2;
}
function clamp2(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function normalizeStroke(stroke) {
  if (stroke == null) return null;
  if (typeof stroke === "string") {
    return LEGACY_COLOR.test(stroke) ? { color: stroke, width: 2 } : null;
  }
  if (typeof stroke !== "object" || Array.isArray(stroke)) return null;
  return {
    color: isValidHexColor(stroke.color) ? stroke.color : "#000000",
    width: Math.round(clamp2(FINITE(stroke.width) ? stroke.width : 2, 0, 20) * 100) / 100
  };
}
function normalizeShadow(shadow) {
  if (shadow == null || typeof shadow !== "object" || Array.isArray(shadow)) return null;
  return {
    color: isValidHexColor(shadow.color) ? shadow.color : "#000000",
    blur: Math.round(clamp2(FINITE(shadow.blur) ? shadow.blur : 0, 0, 50) * 100) / 100,
    x: Math.round(clamp2(FINITE(shadow.x) ? shadow.x : 0, -50, 50) * 100) / 100,
    y: Math.round(clamp2(FINITE(shadow.y) ? shadow.y : 0, -50, 50) * 100) / 100
  };
}
function normalizeTextStyle(style) {
  const s = style && typeof style === "object" && !Array.isArray(style) ? style : {};
  const rawSize = FINITE(s.fontSize) ? s.fontSize : FINITE(s.size) ? s.size : 32;
  let weight = TEXT_FONT_WEIGHTS.includes(s.fontWeight) ? s.fontWeight : null;
  if (weight == null) weight = s.bold ? 700 : 400;
  const rawLine = FINITE(s.lineHeight) ? s.lineHeight : 1.2;
  return {
    fontFamily: TEXT_FONT_FAMILIES.includes(s.fontFamily) ? s.fontFamily : "system-ui",
    fontSize: Math.round(clamp2(rawSize, TEXT_SIZE_MIN, TEXT_SIZE_MAX)),
    fontWeight: weight,
    color: isValidHexColor(s.color) ? s.color : "#ffffff",
    stroke: normalizeStroke(s.stroke),
    shadow: normalizeShadow(s.shadow),
    align: TEXT_ALIGNS.includes(s.align) ? s.align : "center",
    lineHeight: Math.round(clamp2(rawLine, TEXT_LINE_HEIGHT_MIN, TEXT_LINE_HEIGHT_MAX) * 100) / 100,
    y: Math.round(clamp2(FINITE(s.y) ? s.y : 0.82, 0, 1) * 100) / 100
  };
}
function validateStrokeValue(v2) {
  if (typeof v2 !== "object" || Array.isArray(v2)) {
    throw new DomainError("INVALID_ARG", "stroke \u5FC5\u987B\u662F {color, width} \u6216 null");
  }
  for (const k of Object.keys(v2)) {
    if (k !== "color" && k !== "width") {
      throw new DomainError("INVALID_ARG", `\u63CF\u8FB9\u53EA\u652F\u6301 {color, width}\uFF0C\u4E0D\u8BA4\u8BC6\u5B57\u6BB5 ${k}`);
    }
  }
  const color = v2.color === void 0 ? "#000000" : assertHexColor("\u63CF\u8FB9\u989C\u8272", v2.color);
  const width = v2.width === void 0 ? 2 : v2.width;
  if (!FINITE(width) || width < 0 || width > 20) {
    throw new DomainError("INVALID_ARG", "\u63CF\u8FB9\u5BBD\u5EA6\u5FC5\u987B\u5728 0..20 \u4E4B\u95F4\uFF0C\u6536\u5230 " + JSON.stringify(width));
  }
  return { color, width: Math.round(width * 100) / 100 };
}
function validateShadowValue(v2) {
  if (typeof v2 !== "object" || Array.isArray(v2)) {
    throw new DomainError("INVALID_ARG", "shadow \u5FC5\u987B\u662F {color, blur, x, y} \u6216 null");
  }
  for (const k of Object.keys(v2)) {
    if (!["color", "blur", "x", "y"].includes(k)) {
      throw new DomainError("INVALID_ARG", `\u9634\u5F71\u53EA\u652F\u6301 {color, blur, x, y}\uFF0C\u4E0D\u8BA4\u8BC6\u5B57\u6BB5 ${k}`);
    }
  }
  const color = v2.color === void 0 ? "#000000" : assertHexColor("\u9634\u5F71\u989C\u8272", v2.color);
  const blur = v2.blur === void 0 ? 8 : v2.blur;
  const x = v2.x === void 0 ? 0 : v2.x;
  const y = v2.y === void 0 ? 0 : v2.y;
  if (!FINITE(blur) || blur < 0 || blur > 50) {
    throw new DomainError("INVALID_ARG", "\u9634\u5F71\u6A21\u7CCA\u534A\u5F84\u5FC5\u987B\u5728 0..50 \u4E4B\u95F4\uFF0C\u6536\u5230 " + JSON.stringify(blur));
  }
  for (const [name, n] of [["x", x], ["y", y]]) {
    if (!FINITE(n) || n < -50 || n > 50) {
      throw new DomainError("INVALID_ARG", `\u9634\u5F71\u504F\u79FB ${name} \u5FC5\u987B\u5728 -50..50 \u4E4B\u95F4\uFF0C\u6536\u5230 ${JSON.stringify(n)}`);
    }
  }
  return {
    color,
    blur: Math.round(blur * 100) / 100,
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100
  };
}
function mergeTextStyle(base, patch) {
  if (patch == null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new DomainError("INVALID_ARG", "style \u5FC5\u987B\u662F\u4E00\u4E2A\u5BF9\u8C61\uFF08\u5B57\u6BB5\u89C1 TEXT_STYLE_FIELDS\uFF09");
  }
  const next = Object.assign({}, base || {});
  for (const [k, v2] of Object.entries(patch)) {
    switch (k) {
      case "fontFamily":
        if (!TEXT_FONT_FAMILIES.includes(v2)) {
          throw new DomainError(
            "INVALID_ARG",
            `fontFamily \u53EA\u652F\u6301 ${TEXT_FONT_FAMILIES.join(" / ")}\uFF0C\u6536\u5230 ${JSON.stringify(v2)}`
          );
        }
        next.fontFamily = v2;
        break;
      case "fontSize":
        if (!FINITE(v2) || v2 < TEXT_SIZE_MIN || v2 > TEXT_SIZE_MAX) {
          throw new DomainError(
            "INVALID_ARG",
            `fontSize \u5FC5\u987B\u5728 ${TEXT_SIZE_MIN}..${TEXT_SIZE_MAX} \u4E4B\u95F4\uFF0C\u6536\u5230 ${JSON.stringify(v2)}`
          );
        }
        next.fontSize = Math.round(v2);
        break;
      case "fontWeight":
        if (!TEXT_FONT_WEIGHTS.includes(v2)) {
          throw new DomainError("INVALID_ARG", `fontWeight \u53EA\u652F\u6301 400 / 600 / 700 / 900\uFF0C\u6536\u5230 ${JSON.stringify(v2)}`);
        }
        next.fontWeight = v2;
        delete next.bold;
        break;
      case "bold":
        next.bold = !!v2;
        break;
      case "color":
        next.color = assertHexColor("color", v2);
        break;
      case "stroke":
        if (v2 === null) delete next.stroke;
        else next.stroke = validateStrokeValue(v2);
        break;
      case "shadow":
        if (v2 === null) delete next.shadow;
        else next.shadow = validateShadowValue(v2);
        break;
      case "align":
        if (!TEXT_ALIGNS.includes(v2)) {
          throw new DomainError("INVALID_ARG", `align \u53EA\u652F\u6301 left / center / right\uFF0C\u6536\u5230 ${JSON.stringify(v2)}`);
        }
        next.align = v2;
        break;
      case "lineHeight":
        if (!FINITE(v2) || v2 < TEXT_LINE_HEIGHT_MIN || v2 > TEXT_LINE_HEIGHT_MAX) {
          throw new DomainError(
            "INVALID_ARG",
            `lineHeight \u5FC5\u987B\u5728 ${TEXT_LINE_HEIGHT_MIN}..${TEXT_LINE_HEIGHT_MAX} \u4E4B\u95F4\uFF0C\u6536\u5230 ${JSON.stringify(v2)}`
          );
        }
        next.lineHeight = Math.round(v2 * 100) / 100;
        break;
      case "y":
        if (!FINITE(v2) || v2 < 0 || v2 > 1) {
          throw new DomainError("INVALID_ARG", "y \u5FC5\u987B\u5728 0..1 \u4E4B\u95F4\uFF0C\u6536\u5230 " + JSON.stringify(v2));
        }
        next.y = round(v2);
        break;
      default:
        throw new DomainError(
          "INVALID_ARG",
          `\u4E0D\u652F\u6301\u7684\u6587\u5B57\u6837\u5F0F\u5B57\u6BB5: ${k}\uFF08\u53EF\u7528\uFF1A${TEXT_STYLE_FIELDS.join(", ")}\uFF09`
        );
    }
  }
  return next;
}
function assertTextStyleShape(style) {
  if (style == null) return {};
  if (typeof style !== "object" || Array.isArray(style)) {
    throw new DomainError("INVALID_ARG", "style \u5FC5\u987B\u662F\u4E00\u4E2A\u5BF9\u8C61");
  }
  const patch = {};
  const internal = {};
  for (const [k, v2] of Object.entries(style)) {
    if (TEXT_INTERNAL_FIELDS.includes(k)) {
      internal[k] = v2;
      continue;
    }
    if (!TEXT_STYLE_FIELDS.includes(k)) {
      throw new DomainError(
        "INVALID_ARG",
        `\u4E0D\u652F\u6301\u7684\u6587\u5B57\u6837\u5F0F\u5B57\u6BB5: ${k}\uFF08\u53EF\u7528\uFF1A${TEXT_STYLE_FIELDS.join(", ")}\uFF09`
      );
    }
    patch[k] = v2;
  }
  return Object.assign(mergeTextStyle({}, patch), internal);
}
function track(doc, trackId) {
  const t = doc.tracks.find((x) => x.id === trackId);
  if (!t) throw new DomainError("REF_NOT_FOUND", `\u8F68\u9053\u4E0D\u5B58\u5728: ${trackId}`);
  return t;
}
function clip(doc, clipId) {
  const c = doc.clips.find((x) => x.id === clipId);
  if (!c) throw new DomainError("REF_NOT_FOUND", `\u7247\u6BB5\u4E0D\u5B58\u5728: ${clipId}`);
  return c;
}
function isAudioClip(doc, c) {
  if (!doc || !c) return false;
  const t = doc.tracks.find((x) => x.id === c.trackId);
  return !!(t && t.kind === "audio");
}
function assertAudioClip(doc, c, opName) {
  const t = doc.tracks.find((x) => x.id === c.trackId);
  if (!t) throw new DomainError("REF_NOT_FOUND", `\u8F68\u9053\u4E0D\u5B58\u5728: ${c.trackId}`);
  if (t.kind !== "audio") {
    throw new DomainError(
      "INVALID_OP",
      `${opName} \u53EA\u80FD\u7528\u4E8E\u97F3\u9891\u8F68\u4E0A\u7684\u7247\u6BB5\uFF1A${c.id} \u5728\u8F68\u9053 ${t.id}\uFF08\u7C7B\u578B ${t.kind}\uFF09\uFF0C\u97F3\u91CF/\u6DE1\u5165\u6DE1\u51FA/\u9759\u97F3\u5BF9\u5B83\u6CA1\u6709\u610F\u4E49`,
      { clipId: c.id, trackId: t.id, trackKind: t.kind }
    );
  }
  return t;
}
function normalizeAudioPatch(op, duration, opName = "clip.setAudio") {
  const patch = {};
  if (!op || typeof op !== "object") {
    throw new DomainError("INVALID_ARG", `${opName} \u9700\u8981 volume / muted / fadeIn / fadeOut \u81F3\u5C11\u4E00\u4E2A\u5B57\u6BB5`);
  }
  if (op.volume !== void 0 && op.volume !== null) {
    if (typeof op.volume !== "number" || !FINITE(op.volume)) {
      throw new DomainError("INVALID_ARG", `volume \u5FC5\u987B\u662F\u6570\u5B57\uFF080..${AUDIO_VOLUME_MAX}\uFF09\uFF0C\u6536\u5230 ${JSON.stringify(op.volume)}`);
    }
    if (op.volume < AUDIO_VOLUME_MIN || op.volume > AUDIO_VOLUME_MAX) {
      throw new DomainError(
        "INVALID_ARG",
        `volume \u5FC5\u987B\u5728 ${AUDIO_VOLUME_MIN}..${AUDIO_VOLUME_MAX} \u4E4B\u95F4\uFF0C\u6536\u5230 ${op.volume}\uFF08\u4E0D\u81EA\u52A8\u5939\u7D27\uFF1A\u8BF7\u81EA\u5DF1\u51B3\u5B9A\u8981\u7528\u591A\u5C11\uFF09`
      );
    }
    patch.volume = round(op.volume);
  }
  if (op.muted !== void 0 && op.muted !== null) {
    if (typeof op.muted !== "boolean") {
      throw new DomainError("INVALID_ARG", `muted \u5FC5\u987B\u662F\u5E03\u5C14\u503C\uFF0C\u6536\u5230 ${JSON.stringify(op.muted)}`);
    }
    patch.muted = op.muted;
  }
  for (const key of ["fadeIn", "fadeOut"]) {
    if (op[key] === void 0 || op[key] === null) continue;
    const v2 = op[key];
    if (typeof v2 !== "number" || !FINITE(v2)) {
      throw new DomainError("INVALID_ARG", `${key} \u5FC5\u987B\u662F\u6570\u5B57\uFF08\u79D2\uFF0C\u22650\uFF09\uFF0C\u6536\u5230 ${JSON.stringify(v2)}`);
    }
    if (v2 < 0) throw new DomainError("INVALID_ARG", `${key} \u4E0D\u80FD\u4E3A\u8D1F\uFF0C\u6536\u5230 ${v2}`);
    patch[key] = round(v2);
  }
  const fadeIn = patch.fadeIn !== void 0 ? patch.fadeIn : 0;
  const fadeOut = patch.fadeOut !== void 0 ? patch.fadeOut : 0;
  if (fadeIn + fadeOut > duration + 1e-9) {
    throw new DomainError(
      "INVALID_OP",
      `\u6DE1\u5165 + \u6DE1\u51FA\uFF08${round(fadeIn + fadeOut)}s\uFF09\u4E0D\u80FD\u8D85\u8FC7\u7247\u6BB5\u65F6\u957F\uFF08${round(duration)}s\uFF09`,
      { fadeIn, fadeOut, duration }
    );
  }
  return patch;
}
function audioFieldsForInsert(doc, trackObj, op, duration) {
  if (!trackObj || trackObj.kind !== "audio") return {};
  const patch = normalizeAudioPatch(op, duration, "clip.insert");
  const out = { volume: patch.volume !== void 0 ? patch.volume : AUDIO_DEFAULTS.volume };
  if (patch.muted !== void 0) out.muted = patch.muted;
  if (patch.fadeIn !== void 0 && patch.fadeIn > 0) out.fadeIn = patch.fadeIn;
  if (patch.fadeOut !== void 0 && patch.fadeOut > 0) out.fadeOut = patch.fadeOut;
  return out;
}
function clampClipFades(c) {
  if (!(c.duration > 0)) return;
  const fadeIn = typeof c.fadeIn === "number" && Number.isFinite(c.fadeIn) ? Math.max(0, c.fadeIn) : 0;
  const fadeOut = typeof c.fadeOut === "number" && Number.isFinite(c.fadeOut) ? Math.max(0, c.fadeOut) : 0;
  if (fadeIn === 0 && fadeOut === 0) return;
  if (fadeIn + fadeOut <= c.duration) return;
  const k = c.duration / (fadeIn + fadeOut);
  c.fadeIn = round(fadeIn * k);
  c.fadeOut = round(fadeOut * k);
}
function ensureClipIdFree(doc, clipId) {
  if (!clipId || typeof clipId !== "string") throw new DomainError("INVALID_ARG", "clipId \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32");
  if (doc.clips.some((c) => c.id === clipId)) throw new DomainError("INVALID_ARG", `\u7247\u6BB5 id \u5DF2\u5B58\u5728: ${clipId}`);
}
function assertClipShape(doc, c) {
  if (!FINITE(c.start) || c.start < 0) throw new DomainError("INVALID_OP", `\u7247\u6BB5 start \u975E\u6CD5: ${c.id}`);
  if (!FINITE(c.duration) || c.duration <= 0) throw new DomainError("INVALID_OP", `\u7247\u6BB5 duration \u975E\u6CD5: ${c.id}`);
  if (c.type === "media" && !doc.assets.some((a) => a.id === c.assetId)) {
    throw new DomainError("REF_NOT_FOUND", `\u7D20\u6750\u4E0D\u5B58\u5728: ${c.assetId}`);
  }
}
var TRANSITION_TYPES = ["crossfade", "push", "wipe"];
var TRANSITION_MIN = 0.1;
var TRANSITION_MAX = 2;
function sameTrackOrder(doc, c) {
  return doc.clips.filter((x) => x.trackId === c.trackId).sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));
}
function adjacentClips(doc, c) {
  const list = sameTrackOrder(doc, c);
  const i = list.findIndex((x) => x.id === c.id);
  if (i < 0) return { prev: null, next: null };
  const prev = i > 0 ? list[i - 1] : null;
  const next = i < list.length - 1 ? list[i + 1] : null;
  const touchingPrev = prev && Math.abs(prev.start + prev.duration - c.start) < 1e-3 ? prev : null;
  const touchingNext = next && Math.abs(c.start + c.duration - next.start) < 1e-3 ? next : null;
  return { prev: touchingPrev, next: touchingNext };
}
function transitionLimit(doc, c, side) {
  const { prev, next } = adjacentClips(doc, c);
  let limit = Math.min(TRANSITION_MAX, c.duration / 2);
  if (side === "in" && prev) limit = Math.min(limit, prev.duration / 2);
  if (side === "out" && next) limit = Math.min(limit, next.duration / 2);
  return limit;
}
function speedAt(clip2, u) {
  const keys = Array.isArray(clip2 && clip2.speedKeyframes) ? clip2.speedKeyframes : null;
  if (!keys || keys.length === 0) return FINITE(clip2 && clip2.speed) ? clip2.speed : 1;
  if (keys.length === 1) return keys[0].speed;
  const x = Math.max(0, Math.min(1, u));
  if (x <= keys[0].t) return keys[0].speed;
  const last2 = keys[keys.length - 1];
  if (x >= last2.t) return last2.speed;
  for (let i = 1; i < keys.length; i += 1) {
    const a = keys[i - 1];
    const b = keys[i];
    if (x <= b.t) {
      const span = b.t - a.t;
      if (span <= 0) return b.speed;
      return a.speed + (b.speed - a.speed) * ((x - a.t) / span);
    }
  }
  return last2.speed;
}
function averageSpeedOf(clip2) {
  const keys = Array.isArray(clip2 && clip2.speedKeyframes) ? clip2.speedKeyframes : null;
  if (!keys || keys.length === 0) return FINITE(clip2 && clip2.speed) ? clip2.speed : 1;
  let area = 0;
  let prevU = 0;
  let prevS = keys[0].speed;
  for (const k of keys) {
    area += (prevS + k.speed) / 2 * Math.max(0, k.t - prevU);
    prevU = k.t;
    prevS = k.speed;
  }
  area += prevS * Math.max(0, 1 - prevU);
  return area;
}
function integrateSpeed(clip2, u) {
  const x = Math.max(0, Math.min(1, u));
  const keys = Array.isArray(clip2 && clip2.speedKeyframes) ? clip2.speedKeyframes : null;
  if (!keys || keys.length === 0) return x * (FINITE(clip2 && clip2.speed) ? clip2.speed : 1);
  let area = 0;
  let prevU = 0;
  let prevS = keys[0].speed;
  for (const k of keys) {
    if (k.t >= x) {
      area += (prevS + speedAt(clip2, x)) / 2 * Math.max(0, x - prevU);
      return area;
    }
    area += (prevS + k.speed) / 2 * Math.max(0, k.t - prevU);
    prevU = k.t;
    prevS = k.speed;
  }
  area += prevS * Math.max(0, x - prevU);
  return area;
}
function sourceOffsetOf(clip2, localT) {
  const dur = Math.max(1e-6, clip2.duration);
  const u = localT / dur;
  if (u < 0) return localT * speedAt(clip2, 0);
  if (u > 1) {
    const total = dur * averageSpeedOf(clip2);
    return total + (localT - dur) * speedAt(clip2, 1);
  }
  return dur * integrateSpeed(clip2, u);
}
var OPS = {
  "track.add"(doc, op) {
    if (!op.kind) throw new DomainError("INVALID_ARG", "track.add \u9700\u8981 kind");
    const id = op.trackId || "tr_" + Math.random().toString(36).slice(2, 7);
    if (doc.tracks.some((t) => t.id === id)) throw new DomainError("INVALID_ARG", `\u8F68\u9053 id \u5DF2\u5B58\u5728: ${id}`);
    doc.tracks.push({ id, kind: op.kind, name: op.name || op.kind, clips: [], muted: false, locked: false });
    return { kind: "track", id };
  },
  "clip.insert"(doc, op) {
    ensureClipIdFree(doc, op.clipId);
    const t = track(doc, op.trackId);
    if (t.locked) throw new DomainError("INVALID_OP", `\u8F68\u9053\u5DF2\u9501\u5B9A: ${t.id}`);
    const clipType = op.clipType;
    if (!clipType) throw new DomainError("INVALID_ARG", "clip.insert \u9700\u8981 clipType\uFF08media|text|code\uFF09");
    const c = {
      id: op.clipId,
      trackId: t.id,
      type: clipType,
      start: round(op.start ?? 0),
      duration: round(op.duration ?? 1)
    };
    if (clipType === "media") {
      c.assetId = op.assetId;
      c.sourceIn = round(op.sourceIn ?? 0);
      c.speed = op.speed ?? 1;
      c.transform = Object.assign({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, op.transform || {});
      c.effects = op.effects || [];
      if (op.transitionOut) c.transitionOut = op.transitionOut;
    } else if (clipType === "code") {
      c.layerId = op.layerId || op.clipId;
      c.codeHash = op.codeHash || null;
      c.props = op.props || {};
      c.contentDuration = op.contentDuration ?? op.duration;
    } else if (clipType === "text") {
      c.text = op.text || "";
      c.style = assertTextStyleShape(op.style);
    }
    if (op.provenance && typeof op.provenance === "object") {
      c.provenance = {
        libraryId: op.provenance.libraryId || null,
        assetId: op.provenance.assetId || null,
        hash: op.provenance.hash || null,
        license: op.provenance.license || null,
        attribution: op.provenance.attribution || null,
        source: op.provenance.source || null,
        provider: op.provenance.provider || null
      };
    }
    Object.assign(c, audioFieldsForInsert(doc, t, op, c.duration));
    assertClipShape(doc, c);
    doc.clips.push(c);
    t.clips.push(c.id);
    return { kind: "clip", id: c.id };
  },
  "clip.move"(doc, op) {
    const c = clip(doc, op.clipId);
    if (track(doc, c.trackId).locked) throw new DomainError("INVALID_OP", "\u8F68\u9053\u5DF2\u9501\u5B9A: " + c.trackId);
    if (op.trackId && op.trackId !== c.trackId) {
      const from = track(doc, c.trackId);
      const to = track(doc, op.trackId);
      if (to.locked) throw new DomainError("INVALID_OP", `\u8F68\u9053\u5DF2\u9501\u5B9A: ${to.id}`);
      from.clips = from.clips.filter((x) => x !== c.id);
      to.clips.push(c.id);
      c.trackId = to.id;
    }
    if (op.start != null) c.start = round(op.start);
    assertClipShape(doc, c);
    return { kind: "clip", id: c.id };
  },
  "clip.trim"(doc, op) {
    const c = clip(doc, op.clipId);
    if (track(doc, c.trackId).locked) throw new DomainError("INVALID_OP", "\u8F68\u9053\u5DF2\u9501\u5B9A: " + c.trackId);
    if (op.start != null) c.start = round(op.start);
    if (op.duration != null) c.duration = round(op.duration);
    if (op.sourceIn != null && c.type === "media") c.sourceIn = round(op.sourceIn);
    clampClipFades(c);
    assertClipShape(doc, c);
    return { kind: "clip", id: c.id };
  },
  /**
   * 片段音量（只有音频轨上的片段）。
   *
   * { type:'clip.setAudio', clipId, volume?, muted?, fadeIn?, fadeOut? }
   *
   * volume 0..2（越界拒绝，不夹紧）；fadeIn/fadeOut ≥0 且之和 ≤ 片段时长。
   * 至少给一个字段；diff 由 applyOps 统一生成（旧值 → 新值）。
   */
  "clip.setAudio"(doc, op) {
    const c = clip(doc, op.clipId);
    assertAudioClip(doc, c, "clip.setAudio");
    if (track(doc, c.trackId).locked) throw new DomainError("INVALID_OP", "\u8F68\u9053\u5DF2\u9501\u5B9A: " + c.trackId);
    const patch = normalizeAudioPatch(op, c.duration, "clip.setAudio");
    if (Object.keys(patch).length === 0) {
      throw new DomainError("INVALID_ARG", "clip.setAudio \u81F3\u5C11\u9700\u8981\u4E00\u4E2A\u5B57\u6BB5\uFF1Avolume / muted / fadeIn / fadeOut");
    }
    Object.assign(c, patch);
    return { kind: "clip", id: c.id };
  },
  /**
   * clip.update：clip.setAudio 的兼容别名（用户按名字试过它，报「未知命令」很伤）。
   *
   * 只接受 {clipId, volume?, muted?, fadeIn?, fadeOut?}。出现任何其它字段（start / text /
   * style / opacity …）一律明确拒绝，不做半套映射 —— 免得调用方以为通用的「更新片段」被支持了。
   */
  "clip.update"(doc, op) {
    const allowed = /* @__PURE__ */ new Set(["type", "clipId", ...AUDIO_PROP_FIELDS]);
    const extra = Object.keys(op || {}).filter((k) => !allowed.has(k));
    if (extra.length) {
      throw new DomainError(
        "INVALID_ARG",
        `clip.update \u53EA\u652F\u6301\u97F3\u89C6\u9891\u7247\u6BB5\u7684 volume/muted/fadeIn/fadeOut\uFF1B\u4E0D\u652F\u6301\u7684\u5B57\u6BB5: ${extra.join(", ")}`,
        { unsupported: extra, supported: [...AUDIO_PROP_FIELDS] }
      );
    }
    const c = clip(doc, op.clipId);
    assertAudioClip(doc, c, "clip.update");
    if (track(doc, c.trackId).locked) throw new DomainError("INVALID_OP", "\u8F68\u9053\u5DF2\u9501\u5B9A: " + c.trackId);
    const patch = normalizeAudioPatch(op, c.duration, "clip.update");
    if (Object.keys(patch).length === 0) {
      throw new DomainError("INVALID_ARG", "clip.update \u81F3\u5C11\u9700\u8981\u4E00\u4E2A\u5B57\u6BB5\uFF1Avolume / muted / fadeIn / fadeOut");
    }
    Object.assign(c, patch);
    return { kind: "clip", id: c.id };
  },
  "clip.split"(doc, op) {
    const c = clip(doc, op.clipId);
    const at = op.at;
    if (!FINITE(at) || at <= 0 || at >= c.duration) {
      throw new DomainError("INVALID_OP", `split \u4F4D\u7F6E\u8D8A\u754C: ${at}`, { duration: c.duration });
    }
    const rightId = op.rightClipId || c.id + "_b";
    ensureClipIdFree(doc, rightId);
    const right = JSON.parse(JSON.stringify(c));
    right.id = rightId;
    right.start = round(c.start + at);
    right.duration = round(c.duration - at);
    if (c.type === "media") right.sourceIn = round((c.sourceIn || 0) + at * (c.speed || 1));
    c.duration = round(at);
    if (isAudioClip(doc, c)) {
      c.fadeOut = 0;
      right.fadeIn = 0;
      clampClipFades(c);
      clampClipFades(right);
    }
    doc.clips.push(right);
    const t = track(doc, c.trackId);
    t.clips.push(rightId);
    return [{ kind: "clip", id: c.id }, { kind: "clip", id: rightId }];
  },
  "clip.delete"(doc, op) {
    const c = clip(doc, op.clipId);
    if (track(doc, c.trackId).locked) throw new DomainError("INVALID_OP", "\u8F68\u9053\u5DF2\u9501\u5B9A: " + c.trackId);
    doc.clips = doc.clips.filter((x) => x.id !== c.id);
    const t = track(doc, c.trackId);
    t.clips = t.clips.filter((x) => x !== c.id);
    doc.annotations.forEach((a) => {
      if (a.target && a.target.clipId === c.id) a.outdated = true;
    });
    return { kind: "clip", id: c.id };
  },
  "clip.set_keyframe"(doc, op) {
    const c = clip(doc, op.clipId);
    const allowed = /* @__PURE__ */ new Set(["x", "y", "scale", "rotation", "opacity"]);
    if (!allowed.has(op.property)) throw new DomainError("INVALID_ARG", "\u4E0D\u652F\u6301\u7684\u5C5E\u6027: " + op.property);
    if (!FINITE(op.t) || op.t < 0 || op.t > c.duration) {
      throw new DomainError("INVALID_OP", "\u5173\u952E\u5E27\u65F6\u95F4\u5FC5\u987B\u5728 0..\u7247\u6BB5\u65F6\u957F \u4E4B\u95F4");
    }
    if (!FINITE(op.value)) throw new DomainError("INVALID_ARG", "\u5173\u952E\u5E27\u503C\u5FC5\u987B\u662F\u6570\u5B57");
    const list = Array.isArray(c.keyframes) ? c.keyframes.slice() : [];
    const at = list.findIndex((k) => k.property === op.property && Math.abs(k.t - op.t) < 1e-3);
    const eases = /* @__PURE__ */ new Set(["linear", "easeIn", "easeOut", "easeInOut"]);
    if (op.ease !== void 0 && !eases.has(op.ease)) {
      throw new DomainError("INVALID_ARG", "\u4E0D\u652F\u6301\u7684\u7F13\u52A8: " + op.ease);
    }
    const entry = { property: op.property, t: round(op.t), value: round(op.value) };
    if (op.ease) entry.ease = op.ease;
    if (op.bezier !== void 0 && op.bezier !== null) entry.bezier = assertBezier(op.bezier);
    if (at >= 0) list[at] = entry;
    else list.push(entry);
    list.sort((a, b) => a.property < b.property ? -1 : a.property > b.property ? 1 : a.t - b.t);
    c.keyframes = list;
    return { kind: "clip", id: c.id };
  },
  "clip.remove_keyframe"(doc, op) {
    const c = clip(doc, op.clipId);
    const list = (c.keyframes || []).filter(
      (k) => !(k.property === op.property && (op.t == null || Math.abs(k.t - op.t) < 1e-3))
    );
    c.keyframes = list;
    return { kind: "clip", id: c.id };
  },
  "track.set_muted"(doc, op) {
    const t = track(doc, op.trackId);
    t.muted = !!op.muted;
    return { kind: "track", id: t.id };
  },
  "track.set_locked"(doc, op) {
    const t = track(doc, op.trackId);
    t.locked = !!op.locked;
    return { kind: "track", id: t.id };
  },
  "clip.set_mask"(doc, op) {
    const c = clip(doc, op.clipId);
    if (c.type !== "media" && c.type !== "code") {
      throw new DomainError("INVALID_OP", "\u53EA\u6709\u89C6\u89C9\u7247\u6BB5\u6709\u8499\u7248");
    }
    const m = op.mask;
    if (m == null || m.shape === "none") {
      delete c.mask;
      return { kind: "clip", id: c.id };
    }
    if (!["rect", "circle"].includes(m.shape)) {
      throw new DomainError("INVALID_ARG", "\u8499\u7248\u5F62\u72B6\u53EA\u652F\u6301 rect / circle");
    }
    for (const k of ["x", "y", "w", "h"]) {
      if (!FINITE(m[k]) || m[k] < 0 || m[k] > 1) {
        throw new DomainError("INVALID_ARG", "\u8499\u7248 " + k + " \u5FC5\u987B\u5728 0..1");
      }
    }
    if (m.w === 0 || m.h === 0) throw new DomainError("INVALID_ARG", "\u8499\u7248\u5BBD\u9AD8\u4E0D\u80FD\u4E3A 0");
    c.mask = { shape: m.shape, x: round(m.x), y: round(m.y), w: round(m.w), h: round(m.h) };
    return { kind: "clip", id: c.id };
  },
  "clip.set_text"(doc, op) {
    const c = clip(doc, op.clipId);
    if (c.type !== "text") throw new DomainError("INVALID_OP", "\u53EA\u6709\u6587\u5B57\u7247\u6BB5\u6709\u6587\u5B57\u5185\u5BB9");
    if (typeof op.text !== "string") throw new DomainError("INVALID_ARG", "text \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
    if (op.text.length > 2e3) throw new DomainError("INVALID_ARG", "\u6587\u5B57\u8FC7\u957F\uFF08>2000\uFF09");
    c.text = op.text;
    return { kind: "clip", id: c.id };
  },
  "clip.set_text_style"(doc, op) {
    const c = clip(doc, op.clipId);
    if (c.type !== "text") throw new DomainError("INVALID_OP", "\u53EA\u6709\u6587\u5B57\u7247\u6BB5\u6709\u6587\u5B57\u6837\u5F0F");
    c.style = mergeTextStyle(c.style || {}, op.style);
    return { kind: "clip", id: c.id };
  },
  "clip.set_effect"(doc, op) {
    const c = clip(doc, op.clipId);
    const allowed = /* @__PURE__ */ new Set(["brightness", "contrast", "saturate", "blur", "grayscale", "temperature", "tint", "vignette"]);
    if (!allowed.has(op.effect)) throw new DomainError("INVALID_ARG", "\u4E0D\u652F\u6301\u7684\u6548\u679C: " + op.effect);
    const list = Array.isArray(c.effects) ? c.effects.filter((e) => e.type !== op.effect) : [];
    if (op.value != null) {
      if (!FINITE(op.value)) throw new DomainError("INVALID_ARG", "\u6548\u679C\u503C\u5FC5\u987B\u662F\u6570\u5B57");
      if ((op.effect === "temperature" || op.effect === "tint") && (op.value < -1 || op.value > 1)) {
        throw new DomainError("INVALID_ARG", op.effect + " \u5FC5\u987B\u5728 -1..1");
      }
      if (op.effect === "vignette" && (op.value < 0 || op.value > 1)) {
        throw new DomainError("INVALID_ARG", "vignette \u5FC5\u987B\u5728 0..1");
      }
      list.push({ type: op.effect, value: round(op.value) });
    }
    c.effects = list;
    return { kind: "clip", id: c.id };
  },
  "clip.set_transition"(doc, op) {
    const c = clip(doc, op.clipId);
    if (c.type !== "media" && c.type !== "text" && c.type !== "code") {
      throw new DomainError("INVALID_OP", "\u8BE5\u7247\u6BB5\u7C7B\u578B\u4E0D\u652F\u6301\u8F6C\u573A: " + c.type);
    }
    if (op.transitionIn !== void 0 || op.transitionOut !== void 0) {
      for (const key of ["transitionIn", "transitionOut"]) {
        const v2 = op[key];
        if (v2 === void 0) continue;
        if (v2 !== null && (!FINITE(v2) || v2 < 0 || v2 > Math.min(3, c.duration))) {
          throw new DomainError("INVALID_OP", key + " \u5FC5\u987B\u5728 0..min(3, \u7247\u6BB5\u65F6\u957F) \u4E4B\u95F4");
        }
        if (v2 === null) delete c[key];
        else c[key] = round(v2);
      }
      return { kind: "clip", id: c.id };
    }
    if (op.in === void 0 && op.out === void 0) {
      throw new DomainError("INVALID_ARG", "clip.set_transition \u9700\u8981 in \u6216 out\uFF08{type, duration}\uFF0C\u6216 null \u6E05\u9664\uFF09");
    }
    const next = Object.assign({}, c.transition || {});
    for (const side of ["in", "out"]) {
      if (op[side] === void 0) continue;
      const raw = op[side];
      if (raw === null) {
        delete next[side];
        continue;
      }
      if (typeof raw !== "object") {
        throw new DomainError("INVALID_ARG", `\u8F6C\u573A ${side} \u5FC5\u987B\u662F {type, duration} \u6216 null`);
      }
      const type = raw.type;
      if (!TRANSITION_TYPES.includes(type)) {
        throw new DomainError(
          "INVALID_OP",
          `\u4E0D\u652F\u6301\u7684\u8F6C\u573A\u7C7B\u578B: ${type}\uFF08\u53EA\u652F\u6301 ${TRANSITION_TYPES.join(" | ")}\uFF09`
        );
      }
      if (!FINITE(raw.duration)) {
        throw new DomainError("INVALID_OP", `\u8F6C\u573A ${side} \u7684 duration \u5FC5\u987B\u662F\u6709\u9650\u6570\u5B57`);
      }
      if (raw.duration < TRANSITION_MIN || raw.duration > TRANSITION_MAX) {
        throw new DomainError(
          "INVALID_OP",
          `\u8F6C\u573A\u65F6\u957F\u5FC5\u987B\u5728 ${TRANSITION_MIN}..${TRANSITION_MAX} \u79D2\u4E4B\u95F4\uFF0C\u6536\u5230 ${raw.duration}`
        );
      }
      const limit = transitionLimit(doc, c, side);
      if (limit < TRANSITION_MIN - 1e-9) {
        throw new DomainError(
          "INVALID_OP",
          `${side === "in" ? "\u524D\u4E00\u7247\u6BB5" : "\u540E\u4E00\u7247\u6BB5"}\u592A\u77ED\uFF0C\u653E\u4E0D\u4E0B\u6700\u77ED\u7684\u8F6C\u573A\uFF08\u9700\u8981\u81F3\u5C11 ${TRANSITION_MIN * 2} \u79D2\uFF09`
        );
      }
      const duration = round(Math.min(raw.duration, limit));
      next[side] = { type, duration };
    }
    c.transition = next;
    return { kind: "clip", id: c.id };
  },
  "clip.set_speed"(doc, op) {
    const c = clip(doc, op.clipId);
    if (c.type !== "media" && c.type !== "code" && c.type !== "text") {
      throw new DomainError("INVALID_OP", `\u8BE5\u7247\u6BB5\u7C7B\u578B\u4E0D\u652F\u6301\u53D8\u901F: ${c.type}`);
    }
    if (track(doc, c.trackId).locked) throw new DomainError("INVALID_OP", "\u8F68\u9053\u5DF2\u9501\u5B9A: " + c.trackId);
    const speed = op.speed;
    if (!FINITE(speed) || speed < 0.25 || speed > 4) {
      throw new DomainError("INVALID_OP", `\u901F\u5EA6\u5FC5\u987B\u5728 0.25..4 \u4E4B\u95F4\uFF0C\u6536\u5230 ${speed}`);
    }
    let keys = null;
    if (op.keyframes !== void 0 && op.keyframes !== null) {
      if (!Array.isArray(op.keyframes) || op.keyframes.length === 0) {
        throw new DomainError("INVALID_OP", "keyframes \u5FC5\u987B\u662F\u975E\u7A7A\u6570\u7EC4\uFF08\u5F62\u5982 [{t, speed}]\uFF09");
      }
      keys = op.keyframes.map((k, i) => {
        if (!k || typeof k !== "object" || !FINITE(k.t) || !FINITE(k.speed)) {
          throw new DomainError("INVALID_OP", `\u7B2C ${i + 1} \u4E2A\u53D8\u901F\u5173\u952E\u5E27\u9700\u8981 {t, speed} \u4E24\u4E2A\u6570\u5B57`);
        }
        if (k.t < 0 || k.t > 1) {
          throw new DomainError("INVALID_OP", `\u7B2C ${i + 1} \u4E2A\u53D8\u901F\u5173\u952E\u5E27\u7684 t \u5FC5\u987B\u5728 0..1\uFF08\u7247\u6BB5\u5185\u5F52\u4E00\u5316\u65F6\u95F4\uFF09`);
        }
        if (k.speed < 0.25 || k.speed > 4) {
          throw new DomainError("INVALID_OP", `\u7B2C ${i + 1} \u4E2A\u53D8\u901F\u5173\u952E\u5E27\u7684\u901F\u5EA6\u8D8A\u754C\uFF080.25..4\uFF09\uFF1A${k.speed}`);
        }
        return { t: round(k.t), speed: round(k.speed) };
      }).sort((a, b) => a.t - b.t);
      for (let i = 1; i < keys.length; i += 1) {
        if (Math.abs(keys[i].t - keys[i - 1].t) < 1e-6) {
          throw new DomainError("INVALID_OP", "\u53D8\u901F\u5173\u952E\u5E27\u7684 t \u4E0D\u80FD\u91CD\u590D");
        }
      }
    }
    const span = c.duration * averageSpeedOf(c);
    const avg = keys ? averageSpeedOf({ speed, speedKeyframes: keys }) : speed;
    if (!(avg > 0)) throw new DomainError("INVALID_OP", "\u5E73\u5747\u901F\u5EA6\u5FC5\u987B\u5927\u4E8E 0");
    const duration = round(span / avg);
    if (!(duration > 0)) throw new DomainError("INVALID_OP", "\u53D8\u901F\u540E\u7247\u6BB5\u7684\u65F6\u957F\u4E3A 0\uFF0C\u62D2\u7EDD");
    const oldEnd = c.start + c.duration;
    const delta = round(duration - c.duration);
    c.speed = round(speed);
    if (keys) c.speedKeyframes = keys;
    else delete c.speedKeyframes;
    c.duration = duration;
    c.sourceSpan = round(span);
    if (Math.abs(delta) > 1e-9) {
      for (const other of doc.clips) {
        if (other.id === c.id || other.trackId !== c.trackId) continue;
        if (other.start >= oldEnd - 1e-6) other.start = round(other.start + delta);
      }
    }
    return { kind: "clip", id: c.id };
  },
  "clip.set_transform"(doc, op) {
    const c = clip(doc, op.clipId);
    if (c.type !== "media" && c.type !== "text" && c.type !== "code") {
      throw new DomainError("INVALID_OP", `\u8BE5\u7247\u6BB5\u7C7B\u578B\u65E0 transform: ${c.type}`);
    }
    c.transform = Object.assign({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, c.transform, op.transform);
    return { kind: "clip", id: c.id };
  },
  "clip.set_property"(doc, op) {
    const c = clip(doc, op.clipId);
    const allow = /* @__PURE__ */ new Set(["volume", "fadeIn", "fadeOut", "muted", "speed", "audioRole", "style"]);
    if (!allow.has(op.property)) throw new DomainError("INVALID_ARG", `\u4E0D\u652F\u6301\u7684\u5C5E\u6027: ${op.property}`);
    if (op.property === "style") {
      if (c.type !== "text") throw new DomainError("INVALID_OP", "\u53EA\u6709\u6587\u5B57\u7247\u6BB5\u6709\u6587\u5B57\u6837\u5F0F");
      c.style = mergeTextStyle(c.style || {}, op.value);
      return { kind: "clip", id: c.id };
    }
    if (op.property === "audioRole") {
      if (op.value === null || op.value === void 0 || op.value === "") {
        delete c.audioRole;
        return { kind: "clip", id: c.id };
      }
      if (!AUDIO_ROLES.has(op.value)) {
        throw new DomainError("INVALID_ARG", "audioRole \u53EA\u80FD\u662F voice / music / sfx");
      }
      c.audioRole = op.value;
      return { kind: "clip", id: c.id };
    }
    if (AUDIO_PROP_FIELDS.includes(op.property)) {
      assertAudioClip(doc, c, "clip.set_property");
      const patch = normalizeAudioPatch({ [op.property]: op.value }, c.duration, "clip.set_property");
      Object.assign(c, patch);
      return { kind: "clip", id: c.id };
    }
    if (!FINITE(op.value)) throw new DomainError("INVALID_ARG", "value \u5FC5\u987B\u662F\u6709\u9650\u6570\u5B57");
    c[op.property] = op.value;
    return { kind: "clip", id: c.id };
  },
  "code_layer.set_code"(doc, op) {
    const c = clip(doc, op.clipId);
    if (c.type !== "code") throw new DomainError("INVALID_OP", "\u4E0D\u662F\u4EE3\u7801\u56FE\u5C42");
    if (op.codeHash) c.codeHash = op.codeHash;
    return { kind: "clip", id: c.id };
  },
  "code_layer.set_props"(doc, op) {
    const c = clip(doc, op.clipId);
    if (c.type !== "code") throw new DomainError("INVALID_OP", "\u4E0D\u662F\u4EE3\u7801\u56FE\u5C42");
    c.props = Object.assign({}, c.props, op.props || {});
    if (op.codeHash) c.codeHash = op.codeHash;
    return { kind: "clip", id: c.id };
  },
  "project.set_ratio"(doc, op) {
    const allowed = /* @__PURE__ */ new Set(["16:9", "9:16", "1:1", "4:5"]);
    if (!allowed.has(op.ratio)) throw new DomainError("INVALID_ARG", `\u4E0D\u652F\u6301\u7684\u753B\u5E45: ${op.ratio}`);
    doc.ratio = op.ratio;
    return { kind: "project", id: doc.projectId };
  },
  "asset.add"(doc, op) {
    if (!op.assetId) throw new DomainError("INVALID_ARG", "asset.add \u9700\u8981 assetId");
    if (doc.assets.some((a2) => a2.id === op.assetId)) {
      throw new DomainError("INVALID_ARG", "\u7D20\u6750 id \u5DF2\u5B58\u5728: " + op.assetId);
    }
    const a = {
      id: op.assetId,
      path: op.relPath || op.path,
      name: op.name || op.relPath || op.path,
      size: op.size || 0,
      hash: op.hash || null,
      mime: op.mime || "application/octet-stream",
      probe: op.probe || null,
      analysis: null
    };
    doc.assets.push(a);
    return { kind: "asset", id: a.id };
  },
  "asset.setProbe"(doc, op) {
    const a = doc.assets.find((x) => x.id === op.assetId);
    if (!a) throw new DomainError("REF_NOT_FOUND", "\u7D20\u6750\u4E0D\u5B58\u5728: " + op.assetId);
    a.probe = Object.assign({}, a.probe, op.probe || {});
    return { kind: "asset", id: a.id };
  },
  /**
   * 预览解码走备份副本：值必须是 reference/ 下的相对路径，或 null 清空。
   *
   * 原片不动：它仍在 assets/、仍是时间线上的编辑对象；这里只告诉预览「去读哪一份」，
   * 所以撤销这一步不丢任何字节（复制字节在事务外，由 reference.apply 负责）。
   */
  "asset.setPreviewPath"(doc, op) {
    const a = doc.assets.find((x) => x.id === op.assetId);
    if (!a) throw new DomainError("REF_NOT_FOUND", "\u7D20\u6750\u4E0D\u5B58\u5728: " + op.assetId);
    const raw = op.previewPath == null || op.previewPath === "" ? null : String(op.previewPath);
    if (raw !== null && !/^reference\/[A-Za-z0-9._-]+$/.test(raw)) {
      throw new DomainError("INVALID_ARG", "previewPath \u5FC5\u987B\u6307\u5411 reference/ \u4E0B\u7684\u6587\u4EF6\uFF1A" + raw);
    }
    if (raw === null) delete a.previewPath;
    else a.previewPath = raw;
    return { kind: "asset", id: a.id };
  },
  /**
   * 素材状态：null/'' 是普通素材，'reference' 是「已降级、只读参考」。
   */
  "asset.setStatus"(doc, op) {
    const a = doc.assets.find((x) => x.id === op.assetId);
    if (!a) throw new DomainError("REF_NOT_FOUND", "\u7D20\u6750\u4E0D\u5B58\u5728: " + op.assetId);
    const raw = op.status;
    if (raw == null || raw === "") {
      delete a.status;
      return { kind: "asset", id: a.id };
    }
    if (typeof raw !== "string") throw new DomainError("INVALID_ARG", "status \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6216 null");
    const status = raw.trim();
    if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(status)) {
      throw new DomainError("INVALID_ARG", "status \u53EA\u63A5\u53D7\u5B57\u6BCD\u5F00\u5934\u7684\u77ED\u6807\u8BC6: " + raw);
    }
    a.status = status;
    return { kind: "asset", id: a.id };
  },
  "asset.remove"(doc, op) {
    const a = doc.assets.find((x) => x.id === op.assetId);
    if (!a) throw new DomainError("REF_NOT_FOUND", "\u7D20\u6750\u4E0D\u5B58\u5728: " + op.assetId);
    if (doc.clips.some((c) => c.assetId === a.id)) {
      throw new DomainError("INVALID_OP", "\u7D20\u6750\u4ECD\u88AB\u7247\u6BB5\u5F15\u7528\uFF0C\u5148\u5220\u9664\u7247\u6BB5", { assetId: a.id });
    }
    doc.assets = doc.assets.filter((x) => x.id !== a.id);
    return { kind: "asset", id: a.id };
  },
  "annotation.add"(doc, op) {
    if (!op.annotationId) throw new DomainError("INVALID_ARG", "annotationId \u5FC5\u586B");
    if (doc.annotations.some((a2) => a2.id === op.annotationId)) {
      throw new DomainError("INVALID_ARG", `\u6807\u6CE8 id \u5DF2\u5B58\u5728: ${op.annotationId}`);
    }
    const r = op.range || {};
    if (!FINITE(r.start) || !FINITE(r.end) || r.start < 0 || r.end < r.start) {
      throw new DomainError("INVALID_ARG", "range \u5FC5\u987B\u6EE1\u8DB3 0 <= start <= end\uFF08end < start \u662F\u975E\u6CD5\u533A\u95F4\uFF09");
    }
    const intent = op.intent == null || op.intent === "" ? "change" : String(op.intent);
    if (!ANNOTATION_INTENTS.includes(intent)) {
      throw new DomainError("INVALID_ARG", `\u4E0D\u652F\u6301\u7684\u6807\u6CE8\u7C7B\u578B\uFF1A${intent}\uFF08\u53EA\u652F\u6301 ${ANNOTATION_INTENTS.join(" / ")}\uFF09`);
    }
    const target = op.target && typeof op.target === "object" ? op.target : null;
    if (target && target.clipId != null && target.clipId !== "") {
      if (typeof target.clipId !== "string" || !doc.clips.some((c) => c.id === target.clipId)) {
        throw new DomainError("REF_NOT_FOUND", `\u6807\u6CE8\u6307\u5411\u7684\u7247\u6BB5\u4E0D\u5B58\u5728: ${String(target.clipId)}`, {
          clipId: target.clipId
        });
      }
    }
    const a = {
      id: op.annotationId,
      range: { start: round(r.start), end: round(r.end) },
      target,
      intent,
      expected: typeof op.expected === "string" ? op.expected : String(op.expected == null ? "" : op.expected),
      status: "open",
      author: op.author || "user",
      outdated: false,
      createdAt: Date.now()
    };
    doc.annotations.push(a);
    return { kind: "annotation", id: a.id };
  },
  "annotation.update"(doc, op) {
    const a = doc.annotations.find((x) => x.id === op.annotationId);
    if (!a) throw new DomainError("REF_NOT_FOUND", `\u6807\u6CE8\u4E0D\u5B58\u5728: ${op.annotationId}`);
    for (const k of ["range", "target", "intent", "expected", "status"]) {
      if (op[k] !== void 0) a[k] = op[k];
    }
    return { kind: "annotation", id: a.id };
  },
  "annotation.delete"(doc, op) {
    const a = doc.annotations.find((x) => x.id === op.annotationId);
    if (!a) throw new DomainError("REF_NOT_FOUND", `\u6807\u6CE8\u4E0D\u5B58\u5728: ${op.annotationId}`);
    doc.annotations = doc.annotations.filter((x) => x.id !== a.id);
    return { kind: "annotation", id: a.id };
  }
};
var OP_NAMES = Object.keys(OPS);

// src/media-kind.mjs
var KIND = Object.freeze({
  VIDEO: "video",
  AUDIO: "audio",
  IMAGE: "image",
  UNKNOWN: "unknown"
});
var AUDIO_EXT = /* @__PURE__ */ new Set([
  "mp3",
  "wav",
  "ogg",
  "oga",
  "m4a",
  "aac",
  "flac",
  "opus",
  "wma",
  "aif",
  "aiff",
  "caf",
  "weba"
]);
var VIDEO_EXT = /* @__PURE__ */ new Set([
  "mp4",
  "m4v",
  "mov",
  "webm",
  "mkv",
  "avi",
  "mpeg",
  "mpg",
  "ts",
  "flv",
  "wmv",
  "ogv",
  "3gp"
]);
var IMAGE_EXT = /* @__PURE__ */ new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif", "heic"]);
function extensionOf(asset) {
  const value = String(asset && (asset.path || asset.name) || "");
  const m = /\.([a-z0-9]+)$/i.exec(value);
  return m ? m[1].toLowerCase() : "";
}
function probeKind(probe2) {
  if (!probe2 || typeof probe2 !== "object") return null;
  const explicit = String(probe2.kind || "").toLowerCase();
  if (explicit === KIND.VIDEO || explicit === KIND.AUDIO || explicit === KIND.IMAGE) return explicit;
  if (probe2.hasVideoStream === true) return KIND.VIDEO;
  if (probe2.hasVideoStream === false && probe2.hasAudioStream === true) return KIND.AUDIO;
  return null;
}
function assetKind(asset) {
  if (!asset) return KIND.UNKNOWN;
  const fromProbe = probeKind(asset.probe);
  if (fromProbe) return fromProbe;
  const mime = String(asset.mime || "").toLowerCase();
  if (mime.startsWith("video/")) return KIND.VIDEO;
  if (mime.startsWith("audio/")) return KIND.AUDIO;
  if (mime.startsWith("image/")) return KIND.IMAGE;
  const ext = extensionOf(asset);
  if (VIDEO_EXT.has(ext)) return KIND.VIDEO;
  if (AUDIO_EXT.has(ext)) return KIND.AUDIO;
  if (IMAGE_EXT.has(ext)) return KIND.IMAGE;
  return KIND.UNKNOWN;
}
function isVideoAsset(asset) {
  return assetKind(asset) === KIND.VIDEO;
}
function isAudioAsset(asset) {
  return assetKind(asset) === KIND.AUDIO;
}
function kindLabel(kind) {
  if (kind === KIND.VIDEO) return "\u89C6\u9891";
  if (kind === KIND.AUDIO) return "\u97F3\u9891";
  if (kind === KIND.IMAGE) return "\u56FE\u7247";
  return "\u672A\u77E5";
}
function audioTrackId(doc) {
  const tracks = (doc && doc.tracks || []).filter((t) => t && t.kind === "audio");
  if (!tracks.length) return null;
  return tracks.some((t) => t.id === "a1") ? "a1" : tracks[0].id;
}
function insertPolicy(asset) {
  const kind = assetKind(asset);
  if (kind === KIND.AUDIO) {
    return {
      kind,
      buttons: ["audio"],
      trackKind: "audio",
      label: "\u52A0\u5165\u97F3\u9891\u8F68\uFF08a1\uFF09",
      participatesInPicture: false
    };
  }
  if (kind === KIND.VIDEO || kind === KIND.IMAGE) {
    return {
      kind,
      buttons: ["main", "pip"],
      trackKind: "video",
      label: "\u52A0\u5165\u4E3B\u8F68",
      participatesInPicture: true
    };
  }
  return { kind, buttons: [], trackKind: null, label: null, participatesInPicture: false };
}
function resolveInsertTrack(doc, asset) {
  const policy = insertPolicy(asset);
  if (policy.trackKind === "audio") {
    const id = audioTrackId(doc);
    return Object.assign({}, policy, { trackId: id || "a1", createTrack: !id, createKind: "audio" });
  }
  if (policy.trackKind === "video") {
    return Object.assign({}, policy, { trackId: "v1", createTrack: false, createKind: null });
  }
  return Object.assign({}, policy, { trackId: null, createTrack: false, createKind: null });
}

// src/client/player.js
var WORKBENCH_LAYOUT = Object.freeze({
  timelineHeight: 240,
  mediaBinWidth: 220,
  inspectorWidth: 260,
  minPanelHeight: 240,
  minPreviewHeight: 180
});
function fitPanelHeight(options = {}) {
  const viewport = Number(options.viewportHeight) > 0 ? Number(options.viewportHeight) : 0;
  const top = Math.max(0, Number(options.top) || 0);
  const min = Math.max(0, Number(options.min == null ? WORKBENCH_LAYOUT.minPanelHeight : options.min) || 0);
  const space = Math.max(min, viewport - top);
  const parent = Number(options.parentHeight) > 0 ? Number(options.parentHeight) : space;
  return Math.max(min, Math.floor(Math.min(parent, space)));
}
function layoutStyles(extra = {}) {
  const L = WORKBENCH_LAYOUT;
  return {
    root: {
      display: "flex",
      flexDirection: "column",
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: "auto",
      height: extra.height || "100%",
      maxHeight: extra.maxHeight || "100%",
      minHeight: 0,
      overflow: "hidden",
      position: "relative"
    },
    row: { flexGrow: 1, flexShrink: 1, flexBasis: 0, display: "flex", minHeight: 0, overflow: "hidden" },
    mediaBin: {
      width: L.mediaBinWidth,
      flexGrow: 0,
      flexShrink: 0,
      minHeight: 0,
      overflowY: "auto",
      overflowX: "hidden",
      overscrollBehavior: "contain"
    },
    main: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      display: "flex",
      flexDirection: "column",
      minWidth: 0,
      minHeight: 0,
      overflow: "hidden"
    },
    preview: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minHeight: 0,
      overflow: "hidden",
      background: "#000",
      position: "relative",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    },
    timeline: {
      height: L.timelineHeight,
      flexGrow: 0,
      flexShrink: 0,
      flexBasis: L.timelineHeight,
      minHeight: 0,
      overflowY: "auto",
      overflowX: "hidden",
      overscrollBehavior: "contain"
    },
    inspector: {
      width: L.inspectorWidth,
      flexGrow: 0,
      flexShrink: 0,
      minHeight: 0,
      overflowY: "auto",
      overflowX: "hidden",
      overscrollBehavior: "contain"
    }
  };
}
var DRIFT_TOLERANCE = 0.25;
var SEEK_EPS = 0.04;
var SEEK_TIMEOUT_MS = 1200;
var MAX_SEEK_RETRIES = 3;
var SCRUB_INTERVAL_MS = 60;
function clampTime(t, duration) {
  const n = Number(t);
  const v2 = Number.isFinite(n) ? n : 0;
  const d = Number(duration);
  const max = Number.isFinite(d) && d > 0 ? d : Infinity;
  return Math.max(0, Math.min(v2, max));
}
var pool = /* @__PURE__ */ new Map();
var POOL_LIMIT = 8;
var lastUsed = /* @__PURE__ */ new Map();
var useTick = 0;
function touch(assetId) {
  useTick += 1;
  lastUsed.set(assetId, useTick);
}
var mediaGeneration = 0;
var mediaReadyListeners = /* @__PURE__ */ new Set();
function onMediaReady(fn) {
  if (typeof fn !== "function") return () => {
  };
  mediaReadyListeners.add(fn);
  return () => mediaReadyListeners.delete(fn);
}
function bumpMediaGeneration() {
  mediaGeneration += 1;
  for (const fn of mediaReadyListeners) {
    try {
      fn(mediaGeneration);
    } catch {
    }
  }
}
var MEDIA_EVENTS = ["loadedmetadata", "loadeddata", "canplay", "canplaythrough", "error", "emptied", "stalled", "suspend"];
function videoFor(assetId, url2, options = {}) {
  let v2 = pool.get(assetId);
  if (v2 && options.force) {
    releaseAsset(assetId);
    v2 = null;
  }
  if (!v2) {
    v2 = document.createElement("video");
    v2.preload = "auto";
    v2.muted = true;
    v2.playsInline = true;
    v2.crossOrigin = "anonymous";
    v2.src = url2;
    v2.load();
    if (typeof v2.addEventListener === "function") {
      for (const ev of MEDIA_EVENTS) v2.addEventListener(ev, bumpMediaGeneration);
    }
    pool.set(assetId, v2);
    touch(assetId);
    return v2;
  }
  if (url2 && v2.getAttribute && v2.getAttribute("src") !== url2) {
    v2.src = url2;
    v2.load();
  }
  touch(assetId);
  return v2;
}
function ensureVideos(assets, urlFor, options = {}) {
  let created = 0;
  for (const a of assets || []) {
    if (!a || !a.id) continue;
    if (!isVideoAsset(a)) continue;
    if (pool.has(a.id) && !options.force) continue;
    videoFor(a.id, urlFor(a.id), { force: !!options.force });
    created += 1;
  }
  const keep = /* @__PURE__ */ new Set();
  for (const id of options.keep || []) if (id) keep.add(id);
  trimPool(keep);
  return created;
}
function trimPool(keep) {
  let released = 0;
  while (pool.size > POOL_LIMIT) {
    let victim = null;
    let oldest = Infinity;
    for (const id of pool.keys()) {
      if (keep.has(id)) continue;
      const tick = lastUsed.get(id) || 0;
      if (tick < oldest) {
        oldest = tick;
        victim = id;
      }
    }
    if (!victim) break;
    releaseAsset(victim);
    released += 1;
  }
  return released;
}
function releaseAsset(assetId) {
  const v2 = pool.get(assetId);
  if (v2) {
    v2.pause();
    v2.removeAttribute("src");
    v2.load();
    pool.delete(assetId);
  }
  lastUsed.delete(assetId);
}
function clearPool() {
  for (const id of [...pool.keys()]) releaseAsset(id);
  lastUsed.clear();
}
function videoState(assetId) {
  return pool.get(assetId) || null;
}
var MEDIA_ERRORS = {
  1: { name: "MEDIA_ERR_ABORTED", text: "\u52A0\u8F7D\u88AB\u4E2D\u65AD\uFF08\u53EF\u80FD\u662F\u5207\u6362\u5DE5\u7A0B\u6216\u6682\u505C\uFF09" },
  2: { name: "MEDIA_ERR_NETWORK", text: "\u7F51\u7EDC\u4E2D\u65AD\uFF0C\u7D20\u6750\u6CA1\u4E0B\u5B8C" },
  3: { name: "MEDIA_ERR_DECODE", text: "\u6570\u636E\u5230\u4E86\u4F46\u89E3\u4E0D\u51FA\u6765\uFF0C\u6587\u4EF6\u53EF\u80FD\u635F\u574F\u6216\u7F16\u7801\u4E0D\u53D7\u652F\u6301" },
  4: { name: "MEDIA_ERR_SRC_NOT_SUPPORTED", text: "\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u8FD9\u4E2A\u7F16\u7801\u6216\u5BB9\u5668" }
};
var H264_TRANSCODE = "ffmpeg -i \u8F93\u5165.mp4 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart \u8F93\u51FA.mp4";
function codecSupport(doc) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d || typeof d.createElement !== "function") return { hvc1: "", h264: "" };
  try {
    const el = d.createElement("video");
    const can = typeof el.canPlayType === "function" ? el.canPlayType.bind(el) : null;
    if (!can) return { hvc1: "", h264: "" };
    return {
      hvc1: can('video/mp4; codecs="hvc1.1.6.L93.B0"') || "",
      h264: can('video/mp4; codecs="avc1.640028"') || ""
    };
  } catch {
    return { hvc1: "", h264: "" };
  }
}
function mediaDiagnostic(asset, v2, options = {}) {
  const hvc1 = options.hvc1 == null ? "" : String(options.hvc1);
  const assetId = asset && asset.id || options.assetId || "?";
  if (!asset) {
    return {
      code: "no-asset",
      title: "\u7D20\u6750\u6CA1\u51C6\u5907\u597D\uFF08\u5DE5\u7A0B\u91CC\u6CA1\u6709\u8FD9\u4E2A asset\uFF09",
      detail: "\u7247\u6BB5\u6307\u5411 " + assetId + "\uFF0C\u4F46\u7D20\u6750\u8868\u91CC\u6CA1\u6709\u5B83\u3002",
      hint: "\u91CD\u65B0\u5BFC\u5165\u8FD9\u4E2A\u6587\u4EF6\uFF0C\u6216\u5220\u6389\u7247\u6BB5\u91CD\u63D2\u3002",
      blocker: true
    };
  }
  if (isAudioAsset(asset)) {
    return {
      code: "audio-asset",
      title: "\u97F3\u9891\u7D20\u6750\u4E0D\u53C2\u4E0E\u753B\u9762",
      detail: assetId + " \u662F\u97F3\u9891\uFF08" + (asset.mime || "\u672A\u77E5\u7C7B\u578B") + "\uFF09\uFF0C\u6CA1\u6709\u89C6\u9891\u6D41\uFF0C\u4E0D\u8BE5\u653E\u5728\u89C6\u9891\u8F68\u4E0A\u3002",
      hint: "\u628A\u5B83\u79FB\u5230\u97F3\u9891\u8F68\uFF08a1\uFF09\u5C31\u80FD\u6B63\u5E38\u64AD\u653E\uFF1B\u753B\u9762\u5408\u6210\u4F1A\u76F4\u63A5\u8DF3\u8FC7\u5B83\uFF0C\u4E0D\u518D\u7B49\u9996\u5E27\u3002",
      blocker: false
    };
  }
  if (!v2) {
    return {
      code: "no-element",
      title: "\u7D20\u6750\u6CA1\u51C6\u5907\u597D\uFF08pool \u91CC\u6CA1\u6709\uFF09",
      detail: assetId + " \u8FD8\u6CA1\u6709 <video> \u5143\u7D20 \u2014\u2014 \u8FD9\u5E27\u4E0D\u662F\u300C\u5728\u89E3\u7801\u300D\uFF0C\u662F\u6839\u672C\u6CA1\u5F00\u59CB\u52A0\u8F7D\u3002",
      hint: "\u70B9\u300C\u91CD\u65B0\u52A0\u8F7D\u300D\u6216\u6309 R \u91CD\u5EFA\u5143\u7D20\u3002",
      blocker: true
    };
  }
  const err = v2.error;
  if (err && v2.readyState < 2) {
    const info = MEDIA_ERRORS[err.code] || { name: "MEDIA_ERR_UNKNOWN(" + err.code + ")", text: "\u672A\u77E5\u9519\u8BEF" };
    const codecIssue = err.code === 3 || err.code === 4;
    let hint;
    if (codecIssue && !hvc1) {
      hint = "\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u8FD9\u4E2A\u7F16\u7801\uFF0C\u53EF\u80FD\u662F HEVC/H.265\uFF08\u672C\u673A hvc1 \u63A2\u6D4B\uFF1A\u4E0D\u652F\u6301\uFF09\u3002\u7528 ffmpeg \u8F6C\u6210 H.264 \u518D\u5BFC\u5165\uFF1A" + H264_TRANSCODE;
    } else if (codecIssue) {
      hint = "\u672C\u673A\u6D4F\u89C8\u5668\u81EA\u79F0\u652F\u6301 HEVC\uFF0C\u8FD9\u4E2A\u6587\u4EF6\u4ECD\u88AB\u62D2\uFF1A\u53EF\u80FD\u662F 10bit / ProRes / \u6587\u4EF6\u635F\u574F\u3002\u68C0\u67E5\u540E\u8F6C H.264\uFF1A" + H264_TRANSCODE;
    } else {
      hint = "\u6587\u4EF6\u53EF\u80FD\u4E0D\u5B8C\u6574\u6216\u88AB\u5360\u7528\uFF1A\u5148\u786E\u8BA4\u5B83\u80FD\u7528\u64AD\u653E\u5668\u6253\u5F00\uFF0C\u518D\u70B9\u300C\u91CD\u65B0\u52A0\u8F7D\u300D\u3002";
    }
    return {
      code: "error",
      title: "\u89E3\u7801\u5931\u8D25\uFF1A" + err.code + " " + info.name,
      detail: info.text + (err.message ? "\u3000" + err.message : "") + "\uFF08readyState=" + v2.readyState + "\uFF0CnetworkState=" + v2.networkState + "\uFF09",
      hint,
      blocker: true
    };
  }
  if (v2.readyState < 1) {
    const noSource = v2.networkState === 3;
    return {
      code: "loading",
      title: "\u8F7D\u5165\u4E2D\u2026",
      detail: "readyState=" + v2.readyState + "\uFF0CnetworkState=" + v2.networkState + (noSource ? "\uFF08NETWORK_NO_SOURCE\uFF1A\u6D4F\u89C8\u5668\u5224\u5B9A\u6CA1\u6709\u53EF\u7528\u6E90\uFF09" : ""),
      hint: noSource ? "networkState=3 \u57FA\u672C\u7B49\u4E8E\u300C\u62FF\u4E0D\u5230\u80FD\u64AD\u7684\u6E90\u300D\uFF1A\u68C0\u67E5\u6587\u4EF6\u662F\u5426\u5B58\u5728\u3001\u8DEF\u7531\u662F\u5426 404/403\uFF0C\u6216\u7F16\u7801\u662F\u5426\u4E0D\u53D7\u652F\u6301\u3002" : "\u9996\u6B21\u5BFC\u5165\u4F1A\u7B49\u51E0\u79D2\u3002\u4E00\u76F4\u505C\u5728\u8FD9\u91CC\u5C31\u70B9\u300C\u91CD\u65B0\u52A0\u8F7D\u300D\u3002",
      blocker: false
    };
  }
  if (v2.readyState < 2) {
    return {
      code: "metadata",
      title: "\u8F7D\u5165\u4E2D\u2026\uFF08\u5DF2\u62FF\u5230\u5143\u6570\u636E\uFF0C\u7B49\u9996\u5E27\uFF09",
      detail: "readyState=" + v2.readyState + "\uFF0CnetworkState=" + v2.networkState,
      hint: "\u5143\u6570\u636E\u5DF2\u7ECF\u89E3\u51FA\u6765\u4E86\uFF0C\u8BF4\u660E\u5BB9\u5668\u548C\u7F16\u7801\u80FD\u8BA4\uFF1B\u7B49\u9996\u5E27\u6216\u70B9\u300C\u91CD\u65B0\u52A0\u8F7D\u300D\u3002",
      blocker: false
    };
  }
  if (!(v2.videoWidth > 0)) {
    return {
      code: "no-frame",
      title: "\u62FF\u5230\u4E86\u6570\u636E\u4F46\u89E3\u4E0D\u51FA\u753B\u9762",
      detail: "readyState=" + v2.readyState + "\uFF0C\u4F46 videoWidth=" + v2.videoWidth + "\uFF08\u5BB9\u5668\u80FD\u8BA4\uFF0C\u89C6\u9891\u8F68\u53EF\u80FD\u4E3A\u7A7A\u6216\u635F\u574F\uFF09",
      hint: "\u7528 ffprobe \u770B\u6709\u6CA1\u6709\u89C6\u9891\u6D41\uFF1B\u6CA1\u6709\u5C31\u91CD\u65B0\u5BFC\u51FA\uFF0C\u6709\u7684\u5C31\u8F6C H.264\uFF1A" + H264_TRANSCODE,
      blocker: true
    };
  }
  return { code: "ready", title: "", detail: "", hint: "", blocker: false };
}
var clamp01 = (n) => Math.max(0, Math.min(1, n));
function ease(k, kind, bezier) {
  if (isValidBezier(bezier)) return bezierEase(bezier[0], bezier[1], bezier[2], bezier[3], k);
  if (kind === "easeIn") return k * k;
  if (kind === "easeOut") return 1 - (1 - k) * (1 - k);
  if (kind === "easeInOut") return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
  return k;
}
function evaluateTransform(clip2, localT) {
  const base = Object.assign({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, clip2.transform || {});
  const keys = clip2.keyframes || [];
  if (!keys.length) return base;
  const out = Object.assign({}, base);
  const props = new Set(keys.map((k) => k.property));
  for (const prop of props) {
    const track2 = keys.filter((k) => k.property === prop).sort((a, b) => a.t - b.t);
    if (!track2.length) continue;
    if (localT <= track2[0].t) {
      out[prop] = track2[0].value;
      continue;
    }
    if (localT >= track2[track2.length - 1].t) {
      out[prop] = track2[track2.length - 1].value;
      continue;
    }
    for (let i = 1; i < track2.length; i += 1) {
      const a = track2[i - 1];
      const b = track2[i];
      if (localT <= b.t) {
        const span = b.t - a.t;
        const raw = span <= 0 ? 0 : (localT - a.t) / span;
        const k = ease(raw, b.ease || a.ease || "linear", b.bezier || a.bezier || null);
        out[prop] = a.value + (b.value - a.value) * k;
        break;
      }
    }
  }
  return out;
}
function filterFor(clip2) {
  const map = { brightness: "", contrast: "", saturate: "", blur: "", grayscale: "", temperature: "", tint: "" };
  for (const e of clip2.effects || []) {
    if (e.type === "brightness") map.brightness = "brightness(" + e.value + ")";
    else if (e.type === "contrast") map.contrast = "contrast(" + e.value + ")";
    else if (e.type === "saturate") map.saturate = "saturate(" + e.value + ")";
    else if (e.type === "grayscale") map.grayscale = e.value > 0 ? "grayscale(" + Math.min(1, e.value) + ")" : "";
    else if (e.type === "blur") map.blur = e.value > 0 ? "blur(" + e.value + "px)" : "";
    else if (e.type === "temperature") {
      if (e.value > 0) map.temperature = "sepia(" + (0.25 * e.value).toFixed(3) + ") saturate(" + (1 + 0.12 * e.value).toFixed(3) + ")";
      else if (e.value < 0) map.temperature = "hue-rotate(" + Math.round(-18 * e.value) + "deg) saturate(" + (1 + 0.06 * e.value).toFixed(3) + ")";
    } else if (e.type === "tint") {
      if (Math.abs(e.value) > 1e-3) map.tint = "hue-rotate(" + Math.round(28 * e.value) + "deg)";
    }
  }
  const out = [map.brightness, map.contrast, map.saturate, map.grayscale, map.temperature, map.tint, map.blur].filter(Boolean).join(" ");
  return out || "none";
}
function sourceTime(clip2, localT) {
  return (clip2.sourceIn || 0) + sourceOffsetOf(clip2, localT);
}
function transitionAt(clips, t) {
  const byTrack = /* @__PURE__ */ new Map();
  for (const c of clips || []) {
    if (!c || !c.trackId) continue;
    if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []);
    byTrack.get(c.trackId).push(c);
  }
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i += 1) {
      const a = list[i - 1];
      const b = list[i];
      if (Math.abs(a.start + a.duration - b.start) > 1e-3) continue;
      const inc = b.transition && b.transition.in;
      const outg = a.transition && a.transition.out;
      if (inc && inc.duration > 0 && t >= b.start - 1e-6 && t < b.start + inc.duration) {
        return {
          a,
          b,
          side: "in",
          type: inc.type,
          progress: clamp01((t - b.start) / inc.duration),
          start: b.start,
          duration: inc.duration
        };
      }
      if (outg && outg.duration > 0) {
        const from = a.start + a.duration - outg.duration;
        if (t >= from - 1e-6 && t < a.start + a.duration) {
          return {
            a,
            b,
            side: "out",
            type: outg.type,
            progress: clamp01((t - from) / outg.duration),
            start: from,
            duration: outg.duration
          };
        }
      }
    }
  }
  return null;
}
function mixTransition({ type, progress, a, b } = {}) {
  const p = clamp01(Number.isFinite(progress) ? progress : 0);
  if (!TRANSITION_TYPES.includes(type)) {
    throw new Error("\u4E0D\u652F\u6301\u7684\u8F6C\u573A\u7C7B\u578B: " + type);
  }
  const out = { type, progress: p, alphaA: 1, alphaB: 1, dxA: 0, dxB: 0, clipA: null, clipB: null };
  if (type === "crossfade") {
    out.alphaA = 1 - p;
    out.alphaB = p;
    return out;
  }
  if (type === "push") {
    const side = b && b.transition && b.transition.in ? "in" : a && a.transition && a.transition.out ? "out" : "in";
    if (side === "in") {
      out.dxA = p;
      out.dxB = -(1 - p);
    } else {
      out.dxA = -p;
      out.dxB = 1 - p;
    }
    return out;
  }
  out.clipB = { x: 0, y: 0, w: p, h: 1 };
  return out;
}
function legacyFade(clip2, localT) {
  const left = clip2.duration - localT;
  const fin = clip2.transitionIn ? Math.min(1, Math.max(0, localT / clip2.transitionIn)) : 1;
  const fout = clip2.transitionOut ? Math.min(1, Math.max(0, left / clip2.transitionOut)) : 1;
  return Math.max(0, Math.min(fin, fout));
}
function frameLayers(clips, t) {
  const tr = transitionAt(clips, t);
  const buckets = { media: [], text: [], code: [] };
  const push = (clip2, localT, spec) => {
    const kind = clip2.type === "media" ? "media" : clip2.type === "text" ? "text" : clip2.type === "code" ? "code" : null;
    if (!kind) return;
    buckets[kind].push({
      clip: clip2,
      kind,
      localT,
      alpha: spec && spec.alpha != null ? spec.alpha : 1,
      dx: spec && spec.dx || 0,
      dy: spec && spec.dy || 0,
      clipRect: spec && spec.rect || null,
      transition: spec && spec.transition ? true : false
    });
  };
  for (const c of clips || []) {
    const inside = c.start <= t && c.start + c.duration > t;
    const inTransition = tr && (tr.a.id === c.id || tr.b.id === c.id);
    if (!inside && !inTransition) continue;
    if (inTransition) continue;
    push(c, t - c.start, { alpha: legacyFade(c, t - c.start) });
  }
  if (tr) {
    const spec = mixTransition({ type: tr.type, progress: tr.progress, a: tr.a, b: tr.b });
    push(tr.a, t - tr.a.start, {
      alpha: spec.alphaA * legacyFade(tr.a, t - tr.a.start),
      dx: spec.dxA,
      rect: spec.clipA,
      transition: true
    });
    push(tr.b, t - tr.b.start, {
      alpha: spec.alphaB * legacyFade(tr.b, t - tr.b.start),
      dx: spec.dxB,
      rect: spec.clipB,
      transition: true
    });
  }
  return buckets.media.concat(buckets.text, buckets.code);
}
function rectPath(ctx2, rect, width, height) {
  ctx2.beginPath();
  ctx2.rect(rect.x * width, rect.y * height, rect.w * width, rect.h * height);
  ctx2.clip();
}
function paintMediaSource(ctx2, source, sourceWidth, sourceHeight, options) {
  const clip2 = options.clip;
  const layer = options.layer;
  const tf = options.tf || {};
  const width = options.width;
  const height = options.height;
  const srcW = Number(sourceWidth) > 0 ? Number(sourceWidth) : width;
  const srcH = Number(sourceHeight) > 0 ? Number(sourceHeight) : height;
  const hasMask = clip2.mask && clip2.mask.shape && clip2.mask.shape !== "none";
  const rect = hasMask ? {
    x: clip2.mask.x - clip2.mask.w / 2,
    y: clip2.mask.y - clip2.mask.h / 2,
    w: clip2.mask.w,
    h: clip2.mask.h
  } : null;
  ctx2.save();
  if (layer.clipRect) rectPath(ctx2, layer.clipRect, width, height);
  if (rect) {
    ctx2.save();
    ctx2.beginPath();
    if (clip2.mask.shape === "circle") {
      ctx2.ellipse(
        clip2.mask.x * width,
        clip2.mask.y * height,
        clip2.mask.w * width / 2,
        clip2.mask.h * height / 2,
        0,
        0,
        Math.PI * 2
      );
    } else {
      ctx2.rect(rect.x * width, rect.y * height, rect.w * width, rect.h * height);
    }
    ctx2.clip();
  }
  ctx2.globalAlpha = options.alpha;
  ctx2.translate(width / 2 + (tf.x || 0) + layer.dx * width, height / 2 + (tf.y || 0) + layer.dy * height);
  ctx2.rotate((tf.rotation || 0) * Math.PI / 180);
  const scale = tf.scale || 1;
  const vw = width * scale;
  const vh = srcH / srcW * vw;
  ctx2.filter = filterFor(clip2);
  ctx2.drawImage(source, -vw / 2, -vh / 2, vw, vh);
  ctx2.filter = "none";
  if (rect) ctx2.restore();
  ctx2.restore();
}
var FONT_STACKS = {
  "system-ui": 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  "Microsoft YaHei": '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif',
  SimHei: 'SimHei, "Heiti SC", "Microsoft YaHei", sans-serif',
  serif: 'Georgia, "Songti SC", SimSun, serif',
  monospace: 'ui-monospace, Consolas, "Cascadia Mono", monospace'
};
function fontStack(family) {
  return FONT_STACKS[family] || FONT_STACKS["system-ui"];
}
function drawFrame(ctx2, view2) {
  const { clips, assets, t, width, height } = view2;
  const layers = view2.layers || frameLayers(clips, t);
  ctx2.save();
  ctx2.fillStyle = "#000";
  ctx2.fillRect(0, 0, width, height);
  const byId = new Map((assets || []).map((a) => [a.id, a]));
  const hvc1 = (view2.codecs || codecSupport()).hvc1;
  const pending4 = [];
  for (const layer of layers) {
    if (layer.kind !== "media") continue;
    const c = layer.clip;
    const tf = evaluateTransform(c, layer.localT);
    const alpha = (tf.opacity == null ? 1 : tf.opacity) * layer.alpha;
    if (alpha <= 1e-3) continue;
    const asset = byId.get(c.assetId);
    if (asset && isAudioAsset(asset)) continue;
    const composedSource = typeof view2.mediaFrame === "function" && asset ? view2.mediaFrame(c, layer.localT) : null;
    if (composedSource) {
      paintMediaSource(ctx2, composedSource, composedSource.width || width, composedSource.height || height, {
        clip: c,
        layer,
        tf,
        alpha,
        width,
        height
      });
      continue;
    }
    const v2 = asset ? pool.get(asset.id) : null;
    if (!asset || !v2 || v2.readyState < 2 || !(v2.videoWidth > 0)) {
      const d = mediaDiagnostic(asset, v2, { hvc1, assetId: c.assetId });
      if (d.code !== "ready") pending4.push(Object.assign({ assetId: c.assetId, clipId: c.id }, d));
      continue;
    }
    try {
      paintMediaSource(ctx2, v2, v2.videoWidth, v2.videoHeight, {
        clip: c,
        layer,
        tf,
        alpha,
        width,
        height
      });
    } catch {
    }
  }
  const actives = layers.filter((l) => l.kind === "media" || l.kind === "text" || l.kind === "code").map((l) => l.clip);
  const vig = actives.find((c) => (c.effects || []).some((e) => e.type === "vignette" && e.value > 0));
  if (vig) {
    const strength = (vig.effects.find((e) => e.type === "vignette") || {}).value || 0;
    const g = ctx2.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.25, width / 2, height / 2, Math.max(width, height) * 0.72);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0," + Math.min(0.9, strength).toFixed(2) + ")");
    ctx2.save();
    ctx2.fillStyle = g;
    ctx2.fillRect(0, 0, width, height);
    ctx2.restore();
  }
  for (const layer of layers) {
    if (layer.kind !== "text") continue;
    const c = layer.clip;
    const tf = evaluateTransform(c, layer.localT);
    const alpha = (tf.opacity == null ? 1 : tf.opacity) * layer.alpha;
    if (alpha <= 1e-3) continue;
    ctx2.save();
    if (layer.clipRect) rectPath(ctx2, layer.clipRect, width, height);
    ctx2.globalAlpha = alpha;
    const style = normalizeTextStyle(c.style || {});
    const size = style.fontSize;
    ctx2.font = `${style.fontWeight} ${size}px ${fontStack(style.fontFamily)}`;
    ctx2.textAlign = style.align;
    ctx2.textBaseline = "middle";
    const margin = Math.round(width * 0.05);
    const anchorX = style.align === "left" ? margin : style.align === "right" ? width - margin : width / 2;
    const cx = anchorX + (tf.x || 0) + layer.dx * width;
    const cy = height * style.y + (tf.y || 0) + layer.dy * height;
    const lineGap = size * style.lineHeight;
    const lines = String(c.text || "").split("\n");
    const firstY = cy - (lines.length - 1) * lineGap / 2;
    ctx2.fillStyle = style.color;
    if (style.stroke) {
      ctx2.lineWidth = style.stroke.width;
      ctx2.strokeStyle = style.stroke.color;
      ctx2.lineJoin = "round";
      ctx2.miterLimit = 2;
    }
    if (style.shadow) {
      ctx2.shadowColor = style.shadow.color;
      ctx2.shadowBlur = style.shadow.blur;
      ctx2.shadowOffsetX = style.shadow.x;
      ctx2.shadowOffsetY = style.shadow.y;
    }
    for (let i = 0; i < lines.length; i += 1) {
      const y = firstY + i * lineGap;
      if (style.stroke && style.stroke.width > 0) ctx2.strokeText(lines[i], cx, y);
      ctx2.fillText(lines[i], cx, y);
    }
    ctx2.restore();
  }
  if (typeof view2.codeCanvas === "function") {
    for (const layer of layers) {
      if (layer.kind !== "code") continue;
      const canvas = view2.codeCanvas(layer.clip);
      if (!canvas) continue;
      const tf = evaluateTransform(layer.clip, layer.localT);
      const alpha = (tf.opacity == null ? 1 : tf.opacity) * layer.alpha;
      if (alpha <= 1e-3) continue;
      ctx2.save();
      if (layer.clipRect) rectPath(ctx2, layer.clipRect, width, height);
      ctx2.globalAlpha = alpha;
      ctx2.translate(layer.dx * width, layer.dy * height);
      try {
        ctx2.drawImage(canvas, 0, 0, width, height);
      } catch {
      }
      ctx2.restore();
    }
  }
  if (typeof view2.onMediaState === "function") {
    try {
      view2.onMediaState(pending4);
    } catch {
    }
  }
  ctx2.restore();
}
function pauseVideo(v2) {
  try {
    if (!v2.paused) v2.pause();
  } catch {
  }
}
function playVideo(v2) {
  try {
    const p = v2.play();
    if (p && typeof p.catch === "function") p.catch(() => {
    });
  } catch {
  }
}
function setVideoTime(v2, t) {
  try {
    v2.currentTime = t;
  } catch {
  }
}
function syncMedia(view2, options = {}) {
  const playing = !!options.playing;
  const driftTolerance = Number.isFinite(options.driftTolerance) ? options.driftTolerance : DRIFT_TOLERANCE;
  const seekEps = Number.isFinite(options.seekEps) ? options.seekEps : SEEK_EPS;
  const { clips, assets, t } = view2;
  const byId = new Map((assets || []).map((a) => [a.id, a]));
  const tr = transitionAt(clips, t);
  let buffering = 0;
  const seeks = [];
  const active = /* @__PURE__ */ new Set();
  for (const c of clips || []) {
    if (c.type !== "media") continue;
    const asset = byId.get(c.assetId);
    if (!asset) continue;
    if (isAudioAsset(asset)) continue;
    const v2 = pool.get(asset.id);
    if (!v2) continue;
    const inside = c.start <= t && c.start + c.duration > t;
    const partner = !!(tr && (tr.a.id === c.id || tr.b.id === c.id));
    if (!inside && !partner) {
      pauseVideo(v2);
      continue;
    }
    active.add(asset.id);
    const want = sourceTime(c, t - c.start);
    if (playing) {
      if (v2.readyState < 2) {
        buffering += 1;
        seeks.push({ assetId: asset.id, clipId: c.id, want, reason: "not-ready", playing: true });
        continue;
      }
      if (v2.paused) playVideo(v2);
      if (v2.seeking) {
        seeks.push({ assetId: asset.id, clipId: c.id, want, reason: "seeking" });
      } else if (Math.abs(v2.currentTime - want) > driftTolerance) {
        setVideoTime(v2, want);
        seeks.push({ assetId: asset.id, clipId: c.id, want, reason: "drift", corrected: true });
      }
      continue;
    }
    pauseVideo(v2);
    if (v2.readyState < 2) {
      buffering += 1;
      seeks.push({ assetId: asset.id, clipId: c.id, want, reason: "not-ready" });
      continue;
    }
    if (v2.seeking) {
      seeks.push({ assetId: asset.id, clipId: c.id, want, reason: "seeking" });
      continue;
    }
    if (Math.abs(v2.currentTime - want) > seekEps) {
      setVideoTime(v2, want);
      seeks.push({ assetId: asset.id, clipId: c.id, want, reason: "seek" });
    }
  }
  for (const [id, v2] of pool) {
    if (!active.has(id)) pauseVideo(v2);
  }
  return { buffering, seeks, active: [...active] };
}
function syncVideos(view2, opts = {}) {
  return syncMedia(view2, opts).buffering;
}
function pauseAllVideos() {
  for (const v2 of pool.values()) pauseVideo(v2);
}
function frameMediaReadiness(view2) {
  const t = view2.t;
  const layers = view2.layers || frameLayers(view2.clips, t);
  const byId = new Map((view2.assets || []).map((a) => [a.id, a]));
  const hvc1 = (view2.codecs || codecSupport()).hvc1;
  const pending4 = [];
  for (const layer of layers) {
    if (layer.kind !== "media") continue;
    const c = layer.clip;
    const tf = evaluateTransform(c, layer.localT);
    const alpha = (tf.opacity == null ? 1 : tf.opacity) * layer.alpha;
    if (alpha <= 1e-3) continue;
    const asset = byId.get(c.assetId);
    if (asset && isAudioAsset(asset)) continue;
    const v2 = asset ? pool.get(asset.id) : null;
    const want = sourceTime(c, layer.localT);
    if (!asset || !v2) {
      const d = mediaDiagnostic(asset, v2, { hvc1, assetId: c.assetId });
      pending4.push(Object.assign({ assetId: c.assetId, clipId: c.id, want, reason: d.code }, d));
      continue;
    }
    if (v2.readyState < 2 || !(v2.videoWidth > 0)) {
      const d = mediaDiagnostic(asset, v2, { hvc1, assetId: c.assetId });
      pending4.push(
        Object.assign({ assetId: c.assetId, clipId: c.id, want, reason: "not-ready", drift: 0 }, d)
      );
      continue;
    }
    if (v2.seeking) {
      pending4.push({
        code: "seek-pending",
        title: "\u8FD9\u4E00\u5E27\u8FD8\u5728\u5B9A\u4F4D\uFF08seek \u672A\u5B8C\u6210\uFF09",
        detail: "\u7D20\u6750 " + c.assetId + " \u76EE\u6807 " + want.toFixed(2) + "s\uFF0C\u8FD8\u505C\u5728 " + Number(v2.currentTime || 0).toFixed(2) + "s",
        hint: "\u753B\u9762\u4FDD\u6301\u4E0A\u4E00\u5E27\uFF0C\u4E0D\u9ED1\u5C4F\u3002",
        blocker: false,
        assetId: c.assetId,
        clipId: c.id,
        want,
        reason: "seeking",
        drift: Math.abs(Number(v2.currentTime || 0) - want)
      });
      continue;
    }
    const drift = Math.abs(Number(v2.currentTime || 0) - want);
    if (drift > DRIFT_TOLERANCE) {
      pending4.push({
        code: "seek-drift",
        title: "\u8FD9\u4E00\u5E27\u5BF9\u4E0D\u4E0A\uFF08\u65F6\u95F4\u6F02\u79FB\uFF09",
        detail: "\u7D20\u6750 " + c.assetId + " \u76EE\u6807 " + want.toFixed(2) + "s\uFF0C\u5F53\u524D " + Number(v2.currentTime || 0).toFixed(2) + "s\uFF0C\u504F\u5DEE " + drift.toFixed(2) + "s",
        hint: "\u4F1A\u91CD\u8BD5 seek\uFF1B\u753B\u9762\u4FDD\u6301\u4E0A\u4E00\u5E27\u3002",
        blocker: false,
        assetId: c.assetId,
        clipId: c.id,
        want,
        reason: "drift",
        drift
      });
    }
  }
  return { ready: pending4.length === 0, pending: pending4 };
}
function paintPreviewFrame(ctx2, view2) {
  const readiness = frameMediaReadiness(view2);
  if (typeof view2.onMediaState === "function") {
    try {
      view2.onMediaState(readiness.pending);
    } catch {
    }
  }
  if (!readiness.ready) return { painted: false, pending: readiness.pending };
  const inner = Object.assign({}, view2);
  delete inner.onMediaState;
  drawFrame(ctx2, inner);
  return { painted: true, pending: [] };
}
function createPlaybackEngine(options = {}) {
  const opts = options || {};
  const getView = typeof opts.getView === "function" ? opts.getView : () => ({ clips: [], assets: [], duration: 0 });
  const draw2 = typeof opts.draw === "function" ? opts.draw : () => {
  };
  const onTick = typeof opts.onTick === "function" ? opts.onTick : () => {
  };
  const onEnd = typeof opts.onEnd === "function" ? opts.onEnd : () => {
  };
  const onDiagnostic = typeof opts.onDiagnostic === "function" ? opts.onDiagnostic : () => {
  };
  const getAudio = typeof opts.getAudio === "function" ? opts.getAudio : () => opts.audio || null;
  const now = typeof opts.now === "function" ? opts.now : () => typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  const raf = typeof opts.raf === "function" ? opts.raf : (cb) => requestAnimationFrame(cb);
  const caf = typeof opts.caf === "function" ? opts.caf : (id) => cancelAnimationFrame(id);
  const schedule2 = typeof opts.schedule === "function" ? opts.schedule : (fn, ms) => setTimeout(fn, ms);
  const unschedule = typeof opts.unschedule === "function" ? opts.unschedule : (id) => clearTimeout(id);
  const driftTolerance = Number.isFinite(opts.driftTolerance) ? opts.driftTolerance : DRIFT_TOLERANCE;
  const seekEps = Number.isFinite(opts.seekEps) ? opts.seekEps : SEEK_EPS;
  const seekTimeoutMs = Number.isFinite(opts.seekTimeoutMs) ? opts.seekTimeoutMs : SEEK_TIMEOUT_MS;
  const maxSeekRetries = Number.isFinite(opts.maxSeekRetries) ? opts.maxSeekRetries : MAX_SEEK_RETRIES;
  const scrubIntervalMs = Number.isFinite(opts.scrubIntervalMs) ? opts.scrubIntervalMs : SCRUB_INTERVAL_MS;
  let playing = false;
  let t = 0;
  let lastTick = 0;
  let hasTick = false;
  let frameId = 0;
  let retryTimer = 0;
  let settleSeq = 0;
  let retries = 0;
  let lastScrubAt = -Infinity;
  let disposed = false;
  let diagnostics = [];
  let waitCleanup = null;
  const stats = { frames: 0, paints: 0, holds: 0, retries: 0, plays: 0, pauses: 0 };
  const durationOf = () => {
    const v2 = getView() || {};
    const d = Number(v2.duration);
    return Number.isFinite(d) && d > 0 ? d : 0;
  };
  const viewAt = (time) => Object.assign({}, getView() || {}, { t: time });
  function emitDiagnostics(list) {
    diagnostics = Array.isArray(list) ? list : [];
    try {
      onDiagnostic(diagnostics);
    } catch {
    }
  }
  function cancelFrame() {
    if (frameId) {
      caf(frameId);
      frameId = 0;
    }
  }
  function cancelWait() {
    if (waitCleanup) {
      try {
        waitCleanup();
      } catch {
      }
      waitCleanup = null;
    }
    if (retryTimer) {
      unschedule(retryTimer);
      retryTimer = 0;
    }
  }
  function audioCall(name, arg) {
    const audio = getAudio();
    if (audio && typeof audio[name] === "function") {
      try {
        audio[name](arg);
      } catch {
      }
    }
  }
  function tick(stamp3) {
    frameId = 0;
    if (disposed || !playing) return;
    const duration = durationOf();
    const dt = hasTick ? Math.max(0, (stamp3 - lastTick) / 1e3) : 0;
    hasTick = true;
    lastTick = stamp3;
    t = clampTime(t + dt, duration);
    stats.frames += 1;
    syncMedia(viewAt(t), { playing: true, driftTolerance, seekEps });
    onTick(t);
    draw2(t, { playing: true });
    stats.paints += 1;
    if (duration > 0 && t >= duration - 1e-6) {
      const end = t;
      pause();
      onEnd(end);
      return;
    }
    frameId = raf(tick);
  }
  function play(fromT) {
    if (disposed) return;
    const start = clampTime(fromT == null ? t : fromT, durationOf());
    t = start;
    if (playing) {
      onTick(t);
      return;
    }
    cancelWait();
    retries = 0;
    playing = true;
    stats.plays += 1;
    lastTick = now();
    hasTick = true;
    syncMedia(viewAt(t), { playing: true, driftTolerance, seekEps });
    audioCall("play", t);
    onTick(t);
    draw2(t, { playing: true });
    stats.paints += 1;
    if (!frameId) frameId = raf(tick);
  }
  function pause() {
    if (disposed) return;
    const wasPlaying = playing;
    playing = false;
    stats.pauses += 1;
    cancelFrame();
    cancelWait();
    retries = 0;
    pauseAllVideos();
    syncMedia(viewAt(t), { playing: false, driftTolerance, seekEps });
    audioCall("pause");
    onTick(t);
    settle(t, wasPlaying ? "pause" : "idle");
  }
  function settle(target, reason) {
    const seq = ++settleSeq;
    cancelWait();
    retries = 0;
    const attempt = () => {
      if (disposed || seq !== settleSeq || playing) return;
      const view2 = viewAt(target);
      const readiness = frameMediaReadiness(view2);
      if (readiness.ready) {
        emitDiagnostics([]);
        draw2(target, { playing: false, reason, settled: true });
        stats.paints += 1;
        return;
      }
      if (retries < maxSeekRetries) {
        retries += 1;
        stats.retries += 1;
        syncMedia(viewAt(target), { playing: false, driftTolerance, seekEps });
        waitForReady(readiness.pending, attempt, Math.max(120, Math.round(seekTimeoutMs / Math.max(1, maxSeekRetries))));
        return;
      }
      const pending4 = readiness.pending;
      const seekish = pending4.some((p) => p.reason === "seeking" || p.reason === "drift" || p.reason === "seek");
      const first = pending4[0] || {};
      emitDiagnostics([
        {
          code: seekish ? "seek-timeout" : "media-not-ready",
          title: seekish ? "\u8FD9\u4E00\u5E27\u6CA1\u89E3\u51FA\u6765\uFF08seek \u8D85\u65F6\uFF09" : "\u7D20\u6750\u672A\u5C31\u7EEA",
          detail: seekish ? "seek \u8D85\u65F6 " + (seekTimeoutMs / 1e3).toFixed(1) + "s\uFF0C\u5DF2\u91CD\u8BD5 " + maxSeekRetries + " \u6B21\uFF1B\u64AD\u653E\u5934 " + Number(target).toFixed(2) + "s\uFF0C\u7D20\u6750\u505C\u5728 " + Number(first.want || 0).toFixed(2) + "s \u9644\u8FD1" : "\u64AD\u653E\u5934 " + Number(target).toFixed(2) + "s\uFF0C\u7D20\u6750\u8FD8\u6CA1\u89E3\u51FA\u753B\u9762\uFF08readyState < 2\uFF09",
          hint: "\u753B\u9762\u4FDD\u7559\u4E0A\u4E00\u5E27\uFF0C\u4E0D\u4F1A\u9ED1\u5C4F\u3002\u53EF\u4EE5\u70B9\u300C\u91CD\u65B0\u52A0\u8F7D\u300D\u6216\u6309 R \u91CD\u5EFA\u5143\u7D20\u3002",
          blocker: false,
          assetId: first.assetId,
          clipId: first.clipId,
          phase: reason
        }
      ]);
      stats.holds += 1;
    };
    attempt();
  }
  function waitForReady(pending4, done, waitMs) {
    const videos = [];
    for (const p of pending4) {
      const v2 = p.assetId ? pool.get(p.assetId) : null;
      if (v2 && videos.indexOf(v2) < 0) videos.push(v2);
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const v2 of videos) {
        if (typeof v2.removeEventListener === "function") v2.removeEventListener("seeked", onSeeked);
      }
      waitCleanup = null;
      if (retryTimer) {
        unschedule(retryTimer);
        retryTimer = 0;
      }
      done();
    };
    const onSeeked = () => {
      if (videos.every((v2) => !v2.seeking)) finish();
    };
    for (const v2 of videos) {
      if (typeof v2.addEventListener === "function") v2.addEventListener("seeked", onSeeked);
      if (typeof v2.requestVideoFrameCallback === "function") {
        try {
          v2.requestVideoFrameCallback(() => finish());
        } catch {
        }
      }
    }
    waitCleanup = () => {
      for (const v2 of videos) {
        if (typeof v2.removeEventListener === "function") v2.removeEventListener("seeked", onSeeked);
      }
    };
    retryTimer = schedule2(finish, waitMs);
  }
  function seek(to, seekOptions = {}) {
    if (disposed) return;
    const target = clampTime(to, durationOf());
    t = target;
    lastTick = now();
    settleSeq += 1;
    cancelWait();
    retries = 0;
    audioCall("seek", target);
    if (playing) {
      audioCall("play", target);
      syncMedia(viewAt(target), { playing: true, driftTolerance, seekEps });
      onTick(target);
      draw2(target, { playing: true, scrub: !!seekOptions.scrub });
      stats.paints += 1;
      return;
    }
    syncMedia(viewAt(target), { playing: false, driftTolerance, seekEps });
    onTick(target);
    if (seekOptions.scrub) {
      const at = now();
      if (seekOptions.force || at - lastScrubAt >= scrubIntervalMs) {
        lastScrubAt = at;
        const readiness = frameMediaReadiness(viewAt(target));
        if (readiness.ready) {
          emitDiagnostics([]);
          draw2(target, { playing: false, scrub: true });
          stats.paints += 1;
        } else {
          stats.holds += 1;
        }
      }
      return;
    }
    settle(target, "seek");
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    playing = false;
    settleSeq += 1;
    cancelFrame();
    cancelWait();
    pauseAllVideos();
    audioCall("pause");
  }
  return {
    play,
    pause,
    seek,
    dispose,
    /** 媒体就绪状态变了（loadeddata / 重新加载）时叫一次：暂停态下重新定格。 */
    refresh() {
      if (disposed) return;
      if (playing) syncMedia(viewAt(t), { playing: true, driftTolerance, seekEps });
      else settle(t, "refresh");
    },
    isPlaying: () => playing,
    playhead: () => t,
    setPlayhead(value) {
      t = clampTime(value, durationOf());
    },
    diagnostics: () => diagnostics.slice(),
    stats: () => Object.assign({}, stats),
    /** 测试/诊断用：当前挂着的 rAF id（0 表示循环已停）。 */
    pendingFrame: () => frameId
  };
}

// src/client/thumbs.js
var cache = /* @__PURE__ */ new Map();
var pending = /* @__PURE__ */ new Set();
function thumbFor(assetId, sourceTime2) {
  const key = assetId + "@" + Math.round(sourceTime2 * 2) / 2;
  return cache.get(key) || null;
}
function prefetchThumb(assetId, url2, sourceTime2) {
  const key = assetId + "@" + Math.round(sourceTime2 * 2) / 2;
  if (cache.has(key) || pending.has(key)) return Promise.resolve(cache.get(key) || null);
  pending.add(key);
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      pending.delete(key);
      if (value) cache.set(key, value);
      try {
        video.removeAttribute("src");
        video.load();
      } catch {
      }
      resolve(value || null);
    };
    const timer = setTimeout(() => finish(null), 6e3);
    video.addEventListener("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    video.addEventListener("loadeddata", () => {
      try {
        video.currentTime = Math.max(0, Math.min(sourceTime2, (video.duration || 1) - 0.05));
      } catch {
      }
    });
    video.addEventListener("seeked", () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 36;
        const ctx2 = canvas.getContext("2d");
        ctx2.drawImage(video, 0, 0, 64, 36);
        clearTimeout(timer);
        finish(canvas.toDataURL("image/jpeg", 0.5));
      } catch {
        clearTimeout(timer);
        finish(null);
      }
    });
    video.src = url2;
  });
}
function clearThumbs() {
  cache.clear();
  pending.clear();
}

// src/client/waveform.js
var cache2 = /* @__PURE__ */ new Map();
var pending2 = /* @__PURE__ */ new Set();
var audioCtx = null;
function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function waveformFor(assetId) {
  return cache2.get(assetId) || null;
}
function draw(peaks) {
  const w = 256;
  const h4 = 32;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h4;
  const g = canvas.getContext("2d");
  g.fillStyle = "rgba(255,255,255,0.06)";
  g.fillRect(0, 0, w, h4);
  g.strokeStyle = "rgba(160,230,200,0.85)";
  g.beginPath();
  const step = w / peaks.length;
  for (let i = 0; i < peaks.length; i += 1) {
    const v2 = Math.max(0.02, peaks[i]);
    const y = h4 / 2 * (1 - v2);
    g.moveTo(i * step, h4 / 2 - (h4 / 2 - y));
    g.lineTo(i * step, h4 / 2 + (h4 / 2 - y));
  }
  g.stroke();
  return canvas.toDataURL("image/png");
}
function prefetchWaveform(assetId, url2, buckets = 128) {
  if (cache2.has(assetId)) return Promise.resolve(cache2.get(assetId));
  if (pending2.has(assetId)) return Promise.resolve(null);
  pending2.add(assetId);
  return fetch(url2).then((r) => r.arrayBuffer()).then((buf) => ctx().decodeAudioData(buf)).then((audio) => {
    const data = audio.getChannelData(0);
    const size = Math.max(16, Math.floor(data.length / buckets));
    const peaks = new Float32Array(buckets);
    for (let b = 0; b < buckets; b += 1) {
      let max = 0;
      const start = b * size;
      const end = Math.min(data.length, start + size);
      for (let i = start; i < end; i += 1) {
        const v2 = Math.abs(data[i]);
        if (v2 > max) max = v2;
      }
      peaks[b] = max;
    }
    const png = draw(peaks);
    cache2.set(assetId, png);
    pending2.delete(assetId);
    return png;
  }).catch(() => {
    pending2.delete(assetId);
    return null;
  });
}
function clearWaveforms() {
  cache2.clear();
  pending2.clear();
}

// src/client/theme.js
var v = (token, fallback) => `var(--${token}, ${fallback})`;
var T = {
  // ---- 面 ---------------------------------------------------------------
  /** 整页底色（bg-base：浅 #fff / 深 #151517） */
  bg: v("dsw-alias-bg-base", "#151517"),
  /** 面板 / 弹层底色（bg-layer-2：浅 #fff / 深 #2c2c2e） */
  panel: v("dsw-alias-bg-layer-2", "#2c2c2e"),
  /** 再抬一层的面：对话框、下拉（bg-layer-3：浅 #fff / 深 #353638） */
  panelAlt: v("dsw-alias-bg-layer-3", "#353638"),
  /** 遮罩 / 衬底（bg-mask-1） */
  mask: v("dsw-alias-bg-mask-1", "rgba(0,0,0,.5)"),
  // ---- 字 ---------------------------------------------------------------
  /** 主文字（label-primary） */
  text: v("dsw-alias-label-primary", "#f9fafb"),
  /** 次文字：说明、单位、轨道名（label-secondary） */
  textDim: v("dsw-alias-label-secondary", "#cfd3d6"),
  /** 三级文字：占位、计数（label-tertiary） */
  textFaint: v("dsw-alias-label-tertiary", "#adb2b8"),
  // ---- 线 ---------------------------------------------------------------
  /** 所有 1px 边框 / 分隔线（border-l2） */
  border: v("dsw-alias-border-l2", "rgba(255,255,255,.12)"),
  /** 更淡的分隔线：行与行之间（border-l1） */
  borderFaint: v("dsw-alias-border-l1", "rgba(255,255,255,.06)"),
  /** 需要被看见的边框：悬停、虚线提示（border-l4） */
  borderStrong: v("dsw-alias-border-l4", "rgba(255,255,255,.2)"),
  // ---- 色 ---------------------------------------------------------------
  /** 强调（state-business-primary：浅 #4176e6 / 深 #7aaaff） */
  accent: v("dsw-alias-state-business-primary", "#7aaaff"),
  /** 强调的底色（state-business-tertiary） */
  accentDim: v("dsw-alias-state-business-tertiary", "rgba(122,170,255,.2)"),
  /** 危险（state-error-primary） */
  danger: v("dsw-alias-state-error-primary", "#f25a5a"),
  /** 危险的底色（interactive-bg-hover-danger） */
  dangerDim: v("dsw-alias-interactive-bg-hover-danger", "rgba(242,90,90,.15)"),
  /** 成功（state-success-secondary） */
  ok: v("dsw-alias-state-success-secondary", "#4ed17e"),
  /** 提醒（state-warn-primary） */
  warn: v("dsw-alias-state-warn-primary", "#f59e0b"),
  /** 提醒的底色（state-warn-tertiary） */
  warnDim: v("dsw-alias-state-warn-tertiary", "rgba(245,158,11,.16)"),
  // ---- 填充 -------------------------------------------------------------
  /** 轻填充：输入框、条带（interactive-bg-hover） */
  fill: v("dsw-alias-interactive-bg-hover", "rgba(255,255,255,.07)"),
  /** 重一点的填充：选中行、芯片（interactive-bg-active） */
  fillStrong: v("dsw-alias-interactive-bg-active", "rgba(255,255,255,.11)"),
  // ---- 主按钮 -----------------------------------------------------------
  /** 主按钮底（button-primary-fill：浅 #0f1115 / 深 #f9fafb） */
  primary: v("dsw-alias-button-primary-fill", "#f9fafb"),
  /** 主按钮文字（label-primary-foreground：浅 #fff / 深 #0f1115） */
  onPrimary: v("dsw-alias-label-primary-foreground", "#0f1115"),
  // ---- 形状 / 字号 ------------------------------------------------------
  /** 圆角：面板、对话框（radius-md = 12px） */
  radius: v("dsw-radius-md", "12px"),
  /** 小圆角：按钮、输入框（radius-sm = 8px） */
  radiusSm: v("dsw-radius-sm", "8px"),
  /** 大圆角：面板外框（radius-lg = 16px） */
  radiusLg: v("dsw-radius-lg", "16px"),
  /** 间距没有 alias token（查过 asar：ui-theme 只导出颜色/圆角/字号/阴影），
   *  所以这里给一个数字，调用处当 gap 用。 */
  gap: 8,
  /** 正文族（--dsh-font-family-text 由宿主 boot 脚本写在 body 上） */
  font: v("dsh-font-family-text", "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif"),
  /** 阴影（--dsw-shadow-lv2 是整套 box-shadow 值，不是颜色） */
  shadow: v("dsw-shadow-lv2", "0 10px 30px rgba(0,0,0,.45)")
};

// src/annotations.mjs
var EPS = 1e-6;
var round3 = (n) => Math.round(n * 1e3) / 1e3;
function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
var ANNOTATION_INTENTS2 = ["change", "issue", "question", "note"];
var INTENT_LABELS = {
  change: "\u8981\u6539",
  issue: "\u95EE\u9898",
  question: "\u7591\u95EE",
  note: "\u5907\u6CE8"
};
function normalizeRange(range) {
  const raw = range || {};
  const start = round3(Math.max(0, toNumber(raw.start)));
  const end = round3(Math.max(0, toNumber(raw.end, start)));
  if (end < start) {
    throw new DomainError("INVALID_ARG", `\u6807\u6CE8\u533A\u95F4\u975E\u6CD5\uFF1Aend(${end}) \u5C0F\u4E8E start(${start})`);
  }
  return { start, end };
}
function frameRange(t) {
  const at = round3(Math.max(0, toNumber(t)));
  return { start: at, end: at };
}
function spanRange(from, to) {
  const a = round3(Math.max(0, toNumber(from)));
  const b = round3(Math.max(0, toNumber(to)));
  if (b < a) {
    throw new DomainError("INVALID_ARG", `B \u5FC5\u987B\u4E0D\u5C0F\u4E8E A\uFF1AA=${a}s\uFF0CB=${b}s`);
  }
  return { start: a, end: b };
}
function shotsOf(analysis) {
  const raw = analysis && Array.isArray(analysis.shots) ? analysis.shots : null;
  if (!raw || !raw.length) return [];
  const list = raw.map((shot, i) => {
    const start = toNumber(shot && shot.start);
    const end = toNumber(shot && shot.end, start);
    const index = Number.isFinite(Number(shot && shot.index)) && Number(shot.index) > 0 ? Number(shot.index) : i + 1;
    return { index, start: round3(start), end: round3(Math.max(start, end)) };
  }).filter((shot) => shot.end >= shot.start).sort((a, b) => a.start - b.start || a.index - b.index);
  return list;
}
function shotAt(shots, t) {
  if (!shots.length) return null;
  const first = shots[0];
  const last2 = shots[shots.length - 1];
  if (t < first.start - EPS) return null;
  if (t >= last2.end) return null;
  for (const shot of shots) {
    if (t < shot.end - EPS) return shot;
  }
  return last2;
}
function enrichAnnotation(range, analysis) {
  const r = normalizeRange(range);
  const base = { start: r.start, end: r.end };
  const shots = shotsOf(analysis);
  const hit = shotAt(shots, r.start);
  if (!hit) return base;
  return {
    ...base,
    shot: hit.index,
    shotStart: round3(hit.start),
    shotOffset: round3(r.start - hit.start),
    shotEnd: round3(hit.end)
  };
}
function formatAnnotation(entry) {
  const e = entry || {};
  const start = round3(Math.max(0, toNumber(e.start)));
  const end = round3(Math.max(start, toNumber(e.end, start)));
  const time = (n) => `${n.toFixed(2)}s`;
  if (Number.isFinite(Number(e.shot)) && Number(e.shot) > 0) {
    const offset = round3(toNumber(e.shotOffset));
    const sign = offset >= 0 ? "+" : "-";
    return `\u7B2C ${Number(e.shot)} \u955C \xB7 ${time(start)}\uFF08\u955C\u5185 ${sign}${Math.abs(offset).toFixed(2)}s\uFF09`;
  }
  if (Math.abs(end - start) < 1e-9) return `${time(start)}\uFF08\u5F53\u524D\u5E27\uFF09`;
  return `${time(start)} \u2192 ${time(end)}`;
}
function annotationOp({ annotationId, range, intent, expected, target } = {}) {
  if (!annotationId || typeof annotationId !== "string") {
    throw new DomainError("INVALID_ARG", "annotationId \u5FC5\u586B");
  }
  if (!range || typeof range !== "object" || Array.isArray(range)) {
    throw new DomainError("INVALID_ARG", "range \u5FC5\u586B\uFF1A\u6807\u8BB0\u5F53\u524D\u5E27\u4F20 { start, end }\uFF08\u4E24\u8005\u76F8\u540C\uFF09\uFF0C\u533A\u95F4\u4F20 A\u2192B");
  }
  const r = normalizeRange(range);
  const kind = intent == null || intent === "" ? "change" : String(intent);
  if (!ANNOTATION_INTENTS2.includes(kind)) {
    throw new DomainError("INVALID_ARG", `\u4E0D\u652F\u6301\u7684\u6807\u6CE8\u7C7B\u578B\uFF1A${kind}\uFF08\u53EA\u652F\u6301 ${ANNOTATION_INTENTS2.join(" / ")}\uFF09`);
  }
  const op = {
    type: "annotation.add",
    annotationId,
    range: r,
    intent: kind,
    expected: typeof expected === "string" ? expected : String(expected == null ? "" : expected)
  };
  if (target && typeof target === "object") op.target = target;
  return op;
}

// src/client/timeline.js
var h = import_react.default.createElement;
var ROW_H = 30;
var TRACK_HEAD_W = 96;
var RULER_H = 22;
var ANNOT_TRACK_H = 56;
var ANNOT_LANE_TOP = 6;
var ANNOT_LANE_H = 15;
var ANNOT_FLAG_W = 11;
var ANNOT_MAX_LANES = 3;
var SNAP = 0.05;
var TRACK_DOT = { video: "#4f8cff", code: "#8a63ff", audio: "#37c98b", text: "#e0a336" };
var TYPE_COLOR = {
  media: "#2f6feb",
  text: "#b06a00",
  code: "#6a3fbf"
};
function annotationIntentColor(intent) {
  if (intent === "issue") return T.danger;
  if (intent === "question") return T.warn;
  if (intent === "note") return T.textFaint;
  return T.accent;
}
function annotationStatus(annotation) {
  return annotation && annotation.status || "open";
}
function isAnnotationOpen(annotation) {
  return annotationStatus(annotation) === "open";
}
var ANNOTATION_STATUS_LABELS = { open: "\u672A\u5904\u7406", applied: "\u5DF2\u5904\u7406", rejected: "\u5DF2\u5FFD\u7565" };
function annotationStatusLabel(status) {
  return ANNOTATION_STATUS_LABELS[status] || String(status || "\u672A\u5904\u7406");
}
function annotationRangeOf(annotation) {
  const range = annotation && annotation.range;
  if (!range || typeof range !== "object") return null;
  const start = Number(range.start);
  const end = Number(range.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}
function annotationSummary(annotation, max = 40) {
  const a = annotation || {};
  const label = INTENT_LABELS[a.intent] || String(a.intent || "change");
  const text = String(a.expected == null ? "" : a.expected).replace(/\s+/g, " ").trim();
  if (!text) return `${label} \xB7 \uFF08\u65E0\u6587\u5B57\uFF09`;
  const chars = Array.from(text);
  return `${label} \xB7 ${chars.length > max ? chars.slice(0, max).join("") + "\u2026" : text}`;
}
function annotationDataMissing(doc, annotations) {
  const expected = Number(doc && doc.annotationCount) || 0;
  const got = Array.isArray(annotations) ? annotations.length : 0;
  return got === 0 && expected > 0;
}
function annotationCounts(annotations) {
  const list = Array.isArray(annotations) ? annotations : [];
  let total = 0;
  let open = 0;
  let unplaced = 0;
  let invalid = 0;
  for (const a of list) {
    total += 1;
    if (isAnnotationOpen(a)) open += 1;
    const range = annotationRangeOf(a);
    if (!range) unplaced += 1;
    else if (range.end < range.start) invalid += 1;
  }
  return { total, open, handled: total - open, unplaced, invalid };
}
function annotationActive(annotation, playhead) {
  const range = annotationRangeOf(annotation);
  if (!range) return false;
  const t = Number(playhead);
  if (!Number.isFinite(t)) return false;
  const lo = Math.min(range.start, range.end);
  const hi = Math.max(range.start, range.end);
  if (hi - lo < 1e-9) return Math.abs(t - lo) <= 0.2;
  return t >= lo - 1e-6 && t <= hi + 1e-6;
}
function annotationTrackLayout(annotations, options = {}) {
  const list = Array.isArray(annotations) ? annotations : [];
  const zoom = Number(options.zoom) > 0 ? Number(options.zoom) : 40;
  const rawDuration = Number(options.duration);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
  const playhead = Number(options.playhead);
  const selectedId = options.selectedId || null;
  const px = (t) => Math.round(t * zoom);
  const items = [];
  const unplaced = [];
  list.forEach((annotation, index) => {
    const id = annotation && (annotation.id || annotation.annotationId) || "anon_" + index;
    const range = annotationRangeOf(annotation);
    if (!range) {
      unplaced.push({
        id,
        index,
        annotation,
        reason: "missing-range",
        reasonText: "\u7F3A\u5C11 range\uFF08start/end\uFF09\uFF0C\u65E0\u6CD5\u5B9A\u4F4D"
      });
      return;
    }
    const inverted = range.end < range.start;
    const lo = Math.min(range.start, range.end);
    const hi = Math.max(range.start, range.end);
    const clampStart = lo < 0;
    const clampEnd = duration > 0 && hi > duration;
    const t0 = Math.max(0, duration > 0 ? Math.min(lo, duration) : lo);
    const t1 = Math.max(t0, duration > 0 ? Math.min(hi, duration) : hi);
    const isPoint = inverted || hi - lo < 1e-9 || t1 - t0 < 1e-9;
    const kind = isPoint ? "flag" : "span";
    const width = kind === "flag" ? ANNOT_FLAG_W : Math.max(4, px(t1 - t0));
    const x = kind === "flag" ? Math.max(0, px(t0) - Math.floor(ANNOT_FLAG_W / 2)) : px(t0);
    const color = inverted ? T.danger : annotationIntentColor(annotation && annotation.intent);
    const summary = annotationSummary(annotation);
    const feet = [];
    if (clampStart) feet.push("\u8D77\u70B9\u5728 0 \u4E4B\u524D\uFF0C\u5DF2\u8D34\u5230\u7247\u5934");
    if (clampEnd) feet.push("\u7EC8\u70B9\u8D85\u51FA\u7247\u957F\uFF0C\u5DF2\u8D34\u5230\u7247\u5C3E");
    if (inverted) feet.push("\u533A\u95F4\u5012\u6302\uFF08start > end\uFF09\uFF0C\u53EF\u4FEE\u6210\u70B9\u6807\u6CE8");
    items.push({
      id,
      index,
      annotation,
      kind,
      x,
      width,
      lane: 0,
      t0,
      t1,
      timeStart: range.start,
      timeEnd: range.end,
      anchorTime: lo,
      inverted,
      invalid: inverted,
      clampStart,
      clampEnd,
      truncated: clampStart || clampEnd,
      dashed: clampStart || clampEnd,
      outOfBounds: { start: clampStart, end: clampEnd },
      intent: annotation && annotation.intent || "change",
      status: annotationStatus(annotation),
      color,
      summary,
      label: feet.length ? `${summary} \xB7 ${feet.join("\uFF1B")}` : summary,
      selected: id === selectedId,
      active: annotationActive(annotation, playhead)
    });
  });
  items.sort((a, b) => a.t0 - b.t0 || a.index - b.index);
  const laneEnds = [];
  for (const item of items) {
    let lane = 0;
    while (lane < laneEnds.length && item.x < laneEnds[lane] + 2) lane += 1;
    if (lane >= laneEnds.length) laneEnds.push(0);
    laneEnds[lane] = item.x + item.width;
    item.lane = lane;
    item.crowded = lane >= ANNOT_MAX_LANES;
  }
  return {
    items,
    unplaced,
    lanes: laneEnds.length,
    counts: annotationCounts(list),
    activeIds: items.filter((item) => item.active).map((item) => item.id)
  };
}
var TRANSITION_CYCLE = ["crossfade", "push", "wipe"];
var TRANSITION_LABEL = { crossfade: "\u53E0\u5316", push: "\u63A8\u79FB", wipe: "\u906E\u7F69\u64E6\u9664" };
var TRANSITION_DEFAULT = 0.4;
function nextTransitionType(current) {
  const i = TRANSITION_CYCLE.indexOf(current);
  return TRANSITION_CYCLE[(i + 1) % TRANSITION_CYCLE.length];
}
function transitionOp(clip2, side) {
  const cur = clip2.transition && clip2.transition[side] || null;
  return [
    {
      type: "clip.set_transition",
      clipId: clip2.id,
      [side]: { type: nextTransitionType(cur && cur.type), duration: cur && cur.duration || TRANSITION_DEFAULT }
    }
  ];
}
function markerStyle(side) {
  return {
    position: "absolute",
    top: -1,
    [side]: 2,
    width: 0,
    height: 0,
    borderLeft: "5px solid transparent",
    borderRight: "5px solid transparent",
    borderTop: "7px solid #ffd166",
    cursor: "pointer",
    zIndex: 3,
    filter: "drop-shadow(0 0 2px rgba(0,0,0,.7))"
  };
}
function snapToClips(t, clips, ignoreId) {
  let best = Math.round(t / SNAP) * SNAP;
  let bestD = 0.08;
  for (const c of clips) {
    if (c.id === ignoreId) continue;
    for (const edge of [c.start, c.start + c.duration]) {
      const d = Math.abs(edge - t);
      if (d < bestD) {
        bestD = d;
        best = edge;
      }
    }
  }
  return Math.max(0, Math.round(best * 1e3) / 1e3);
}
function Timeline(props) {
  const { doc, clips, annotations, playhead, zoom, selection, onSeek, onSelect, onOps, assets, flash } = props;
  const assetName = new Map((assets || []).map((a) => [a.id, a.name]));
  const [drag, setDrag] = import_react.default.useState(null);
  const [view2, setView] = import_react.default.useState({ left: 0, width: 1200 });
  const [hoverAnnot, setHoverAnnot] = import_react.default.useState(null);
  const sync = import_react.default.useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setView({ left: el.scrollLeft, width: el.clientWidth || 1200 });
  }, []);
  import_react.default.useEffect(() => {
    sync();
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return void 0;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sync]);
  const scroller = import_react.default.useRef(null);
  const duration = Math.max(doc ? doc.duration : 0, 10);
  const width = Math.max(duration + 6, 20) * zoom;
  const selectedAnnotationId = selection && selection.kind === "annotation" ? selection.id : null;
  const annotLayout = annotationTrackLayout(annotations, {
    zoom,
    duration,
    playhead,
    selectedId: selectedAnnotationId
  });
  const expectedAnnotationCount = Number(doc && doc.annotationCount) || 0;
  const annotationMissing = annotationDataMissing(doc, annotations);
  const hoveredAnnot = hoverAnnot ? annotLayout.items.find((item) => item.id === hoverAnnot) || null : null;
  const px = (t) => Math.round(t * zoom);
  function timeAtEvent(e) {
    const el = scroller.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left + el.scrollLeft;
    return pxToTime(x);
  }
  const seekRef = import_react.default.useRef(onSeek);
  seekRef.current = onSeek;
  const scrubRef = import_react.default.useRef(null);
  const clampSeek = import_react.default.useCallback(
    (t) => Math.max(0, Math.min(duration, t)),
    [duration]
  );
  const scrubTo = import_react.default.useCallback(
    (e, opts) => {
      const fn = seekRef.current;
      if (typeof fn !== "function") return;
      fn(clampSeek(timeAtEvent(e)), opts);
    },
    [clampSeek]
  );
  import_react.default.useEffect(() => {
    const onMove = (e) => {
      const state2 = scrubRef.current;
      if (!state2) return;
      const at = Date.now();
      if (at - state2.last < SCRUB_INTERVAL_MS) return;
      state2.last = at;
      scrubTo(e, { scrub: true });
    };
    const onUp = (e) => {
      if (!scrubRef.current) return;
      scrubRef.current = null;
      scrubTo(e, { scrub: false, force: true });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [scrubTo]);
  import_react.default.useEffect(() => {
    if (!drag) return void 0;
    const onMove = (e) => {
      const dt = pxToTime(e.clientX) - pxToTime(drag.clientX0);
      setDrag((d) => d ? { ...d, dt } : d);
    };
    const onUp = () => {
      const d = drag;
      setDrag(null);
      if (!d || Math.abs(d.dt) < 0.02) return;
      if (d.mode === "move") {
        const start = snapToClips(d.start0 + d.dt, clips, d.id);
        onOps([{ type: "clip.move", clipId: d.id, start }], "\u79FB\u52A8\u7247\u6BB5");
      } else if (d.mode === "l") {
        const left = d.start0 + d.dt;
        const clamped = Math.min(Math.max(0, left), d.start0 + d.dur0 - 0.1);
        const delta = clamped - d.start0;
        const ops = [{ type: "clip.trim", clipId: d.id, start: +clamped.toFixed(3), duration: +(d.dur0 - delta).toFixed(3) }];
        if (d.srcIn != null) ops[0].sourceIn = +(d.srcIn + delta * (d.speed || 1)).toFixed(3);
        onOps(ops, "\u88C1\u526A\u7247\u6BB5");
      } else {
        const dur = Math.max(0.1, d.dur0 + d.dt);
        onOps([{ type: "clip.trim", clipId: d.id, duration: +dur.toFixed(3) }], "\u88C1\u526A\u7247\u6BB5");
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, clips, onOps]);
  function beginDrag(e, clip2, mode) {
    e.stopPropagation();
    e.preventDefault();
    onSelect({ kind: "clip", id: clip2.id });
    setDrag({
      id: clip2.id,
      mode,
      clientX0: e.clientX,
      start0: clip2.start,
      dur0: clip2.duration,
      srcIn: clip2.type === "media" ? clip2.sourceIn || 0 : null,
      speed: clip2.speed || 1,
      dt: 0
    });
  }
  const ticks = [];
  const tickStep = zoom > 90 ? 0.5 : zoom > 40 ? 1 : 2;
  for (let t = 0; t <= duration + 1; t += tickStep) {
    ticks.push(
      h(
        "div",
        {
          key: "t" + t,
          style: {
            position: "absolute",
            left: px(t),
            top: 0,
            height: RULER_H,
            borderLeft: `1px solid ${T.border}`,
            paddingLeft: 4,
            fontSize: 10,
            opacity: 0.55,
            pointerEvents: "none",
            whiteSpace: "nowrap"
          }
        },
        t % 1 === 0 ? `${t}s` : ""
      )
    );
  }
  const rows = (doc ? doc.tracks : []).map((track2, index) => {
    const t0 = Math.max(0, view2.left / zoom - 2);
    const t1 = (view2.left + view2.width) / zoom + 2;
    const rowClips = clips.filter(
      (c) => c.trackId === track2.id && c.start + c.duration >= t0 && c.start <= t1
    );
    return h(
      "div",
      {
        key: track2.id,
        style: {
          position: "relative",
          height: ROW_H,
          background: index % 2 ? `color-mix(in srgb, ${T.fill} 40%, transparent)` : "transparent",
          borderTop: index === 0 ? "none" : `1px solid ${T.borderFaint}`
        }
      },
      rowClips.map((c) => {
        const isDrag = drag && drag.id === c.id;
        const start = isDrag && drag.mode === "move" ? Math.max(0, c.start + drag.dt) : c.start;
        let width0 = c.duration;
        let start2 = start;
        if (isDrag && drag.mode === "l") {
          const left = Math.min(Math.max(0, c.start + drag.dt), c.start + c.duration - 0.1);
          width0 = c.start + c.duration - left;
          start2 = left;
        } else if (isDrag && drag.mode === "r") {
          width0 = Math.max(0.1, c.duration + drag.dt);
        }
        const selected = selection && selection.kind === "clip" && selection.id === c.id;
        const flashing = !!(flash && flash.ids && flash.ids.has(c.id));
        return h(
          "div",
          {
            key: c.id,
            onPointerDown: (e) => beginDrag(e, c, "move"),
            title: `${c.id} \xB7 ${c.type}`,
            style: {
              position: "absolute",
              left: px(start2),
              width: Math.max(6, px(width0)),
              top: 3,
              height: ROW_H - 6,
              borderRadius: 6,
              background: TYPE_COLOR[c.type] || "#445",
              backgroundImage: (() => {
                if (c.trackId === "a1") {
                  const w = waveformFor(c.assetId);
                  return w ? "url(" + w + ")" : "none";
                }
                const t = c.type === "media" ? thumbFor(c.assetId, (c.sourceIn || 0) + 0.2) : null;
                return t ? "url(" + t + ")" : "none";
              })(),
              backgroundSize: "auto 100%",
              backgroundRepeat: "repeat-x",
              backgroundBlendMode: "overlay",
              opacity: 0.85,
              outline: selected ? "2px solid #ffd166" : `1px solid ${T.border}`,
              boxShadow: selected ? "0 0 0 4px rgba(255,209,102,.16)" : flashing ? "0 0 0 3px rgba(90,170,255,.45)" : "none",
              overflow: "hidden",
              cursor: "grab",
              display: "flex",
              alignItems: "center",
              paddingLeft: 8,
              fontSize: 11,
              color: "#fff",
              userSelect: "none"
            }
          },
          h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.type === "text" ? c.text || "\u6587\u5B57" : c.type === "code" ? "\u4EE3\u7801 \xB7 " + (c.layerId || c.id) : assetName.get(c.assetId) || c.id),
          c.keyframes && c.keyframes.length ? h(
            "div",
            { style: { position: "absolute", left: 0, right: 0, bottom: 2, height: 5, pointerEvents: "none" } },
            c.keyframes.map(
              (k, i) => h("div", {
                key: i,
                title: (k.property || "") + " @" + k.t + "s",
                style: {
                  position: "absolute",
                  left: Math.min(96, k.t / Math.max(0.1, c.duration) * 100) + "%",
                  width: 5,
                  height: 5,
                  background: "#ffd166",
                  transform: "rotate(45deg)"
                }
              })
            )
          ) : null,
          c.effects && c.effects.length ? h("div", {
            title: "\u5DF2\u6709\u6548\u679C",
            style: {
              position: "absolute",
              right: 4,
              top: 3,
              width: 6,
              height: 6,
              borderRadius: 3,
              background: "#7ee0b0",
              pointerEvents: "none"
            }
          }) : null,
          h("div", {
            onPointerDown: (e) => beginDrag(e, c, "l"),
            style: { position: "absolute", left: 0, top: 0, width: 6, height: "100%", cursor: "ew-resize" }
          }),
          h("div", {
            onPointerDown: (e) => beginDrag(e, c, "r"),
            style: { position: "absolute", right: 0, top: 0, width: 6, height: "100%", cursor: "ew-resize" }
          }),
          // 转场标记：左侧三角 = 入向，右侧三角 = 出向，点一下循环切换类型
          c.transition && c.transition.in ? h("div", {
            title: `\u5165\u5411\u8F6C\u573A\uFF1A${TRANSITION_LABEL[c.transition.in.type] || c.transition.in.type} ${c.transition.in.duration}s\uFF08\u70B9\u51FB\u5207\u6362\uFF09`,
            onPointerDown: (e) => e.stopPropagation(),
            onClick: (e) => {
              e.stopPropagation();
              onOps(transitionOp(c, "in"), "\u5207\u6362\u8F6C\u573A");
            },
            style: markerStyle("left")
          }) : null,
          c.transition && c.transition.out ? h("div", {
            title: `\u51FA\u5411\u8F6C\u573A\uFF1A${TRANSITION_LABEL[c.transition.out.type] || c.transition.out.type} ${c.transition.out.duration}s\uFF08\u70B9\u51FB\u5207\u6362\uFF09`,
            onPointerDown: (e) => e.stopPropagation(),
            onClick: (e) => {
              e.stopPropagation();
              onOps(transitionOp(c, "out"), "\u5207\u6362\u8F6C\u573A");
            },
            style: markerStyle("right")
          }) : null,
          c.speed && Math.abs(c.speed - 1) > 1e-3 ? h("div", {
            title: `${c.speed}\xD7 \u53D8\u901F\uFF08\u65F6\u95F4\u7EBF\u65F6\u957F ${c.duration}s\uFF09`,
            style: {
              position: "absolute",
              right: 6,
              bottom: 2,
              fontSize: 9,
              lineHeight: "11px",
              padding: "0 3px",
              borderRadius: 3,
              background: "rgba(255,209,102,.85)",
              color: "#2a1c00",
              pointerEvents: "none"
            }
          }, "\xD7" + c.speed) : null
        );
      })
    );
  });
  const annotBars = annotLayout.items.map((item) => {
    const color = item.color;
    const top = ANNOT_LANE_TOP + Math.min(item.lane, ANNOT_MAX_LANES - 1) * ANNOT_LANE_H;
    const baseStyle = {
      position: "absolute",
      left: item.x,
      top,
      height: ANNOT_LANE_H - 3,
      borderRadius: 4,
      cursor: "pointer",
      background: `color-mix(in srgb, ${color} 24%, transparent)`,
      outline: item.selected ? `2px solid ${color}` : item.invalid ? `1px dashed ${T.danger}` : `1px solid ${color}`,
      outlineOffset: item.selected ? 1 : 0,
      boxShadow: item.active ? `0 0 0 2px color-mix(in srgb, ${color} 60%, transparent)` : "none",
      opacity: item.status === "open" ? 1 : 0.55,
      zIndex: item.selected ? 4 : item.active ? 3 : 1
    };
    const common = {
      key: item.id,
      title: item.label,
      onPointerEnter: () => setHoverAnnot(item.id),
      onPointerLeave: () => setHoverAnnot((cur) => cur === item.id ? null : cur),
      onClick: (e) => {
        e.stopPropagation();
        onSelect({ kind: "annotation", id: item.id });
        if (typeof onSeek === "function") onSeek(clampSeek(item.anchorTime), { force: true });
      }
    };
    if (item.kind === "flag") {
      return h(
        "div",
        { ...common, style: { ...baseStyle, width: ANNOT_FLAG_W } },
        h("i", {
          style: { position: "absolute", left: 0, top: 0, bottom: 0, width: 2, borderRadius: 1, background: color }
        }),
        h("i", {
          style: {
            position: "absolute",
            left: 2,
            top: 2,
            width: ANNOT_FLAG_W - 4,
            height: ANNOT_LANE_H - 7,
            background: color,
            clipPath: "polygon(0 0, 100% 50%, 0 100%)"
          }
        })
      );
    }
    return h(
      "div",
      {
        ...common,
        style: {
          ...baseStyle,
          width: item.width,
          display: "flex",
          alignItems: "center",
          padding: "0 4px",
          overflow: "hidden"
        }
      },
      h(
        "span",
        {
          style: {
            fontSize: 9,
            lineHeight: "11px",
            color: T.text,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis"
          }
        },
        item.width > 48 ? item.summary : ""
      ),
      // 超出片长的边界：贴边 + 虚线，提醒「这里不是真实终点」
      item.clampEnd ? h("i", {
        style: {
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: 2,
          borderLeft: `2px dashed ${T.warn}`
        }
      }) : null,
      item.clampStart ? h("i", {
        style: {
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 2,
          borderLeft: `2px dashed ${T.warn}`
        }
      }) : null
    );
  });
  const annotTip = hoveredAnnot ? h(
    "div",
    {
      style: {
        position: "absolute",
        left: Math.max(0, Math.min(hoveredAnnot.x, Math.max(0, width - 300))),
        top: RULER_H + ANNOT_TRACK_H + 2,
        width: 280,
        padding: "6px 8px",
        borderRadius: 6,
        background: T.panel,
        border: `1px solid ${T.borderStrong}`,
        color: T.text,
        fontSize: 10,
        lineHeight: "14px",
        boxShadow: T.shadow,
        zIndex: 8,
        pointerEvents: "none"
      }
    },
    hoveredAnnot.label
  ) : null;
  return h(
    "div",
    { style: { display: "flex", height: "100%", minHeight: 0 } },
    // track headers
    h(
      "div",
      {
        style: {
          width: TRACK_HEAD_W,
          flex: "0 0 auto",
          borderRight: `1px solid ${T.border}`,
          paddingTop: RULER_H,
          background: T.fill
        }
      },
      // 标注轨的表头：位置在尺子下面、所有轨道之上，固定 56px
      h(
        "div",
        {
          key: "@annotations",
          title: annotLayout.counts.unplaced > 0 ? `${annotLayout.counts.unplaced} \u6761\u6807\u6CE8\u7F3A\u5C11 range\uFF0C\u53BB\u53F3\u4FA7\u300C\u6807\u6CE8\u300D\u9875\u5904\u7406` : "\u6807\u6CE8\u8F68\uFF1A\u70B9\u80F6\u56CA\u8DF3\u5230\u8BE5\u5904\uFF1B\u53F3\u4FA7\u300C\u6807\u6CE8\u300D\u9875\u53EF\u7F16\u8F91 / \u5220\u9664",
          style: {
            height: ANNOT_TRACK_H,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 2,
            padding: "0 8px",
            fontSize: 10,
            color: T.textDim,
            background: T.fill,
            borderBottom: `1px solid ${T.borderFaint}`
          }
        },
        h(
          "span",
          { style: { display: "flex", alignItems: "center", gap: 5, fontWeight: 600 } },
          h("i", { style: { width: 6, height: 6, borderRadius: 3, background: T.accent } }),
          "\u6807\u6CE8\u8F68",
          h("span", { style: { opacity: 0.6, fontWeight: 400 } }, String(annotLayout.counts.total))
        ),
        h("span", { style: { opacity: 0.6 } }, "\u672A\u5904\u7406 " + annotLayout.counts.open),
        annotLayout.counts.unplaced ? h("span", { style: { color: T.warn } }, "\u65E0\u6CD5\u5B9A\u4F4D " + annotLayout.counts.unplaced) : null
      ),
      (doc ? doc.tracks : []).map(
        (t) => h(
          "div",
          {
            key: t.id,
            onDoubleClick: () => onOps([{ type: "track.set_muted", trackId: t.id, muted: !t.muted }], t.muted ? "\u53D6\u6D88\u9759\u97F3" : "\u9759\u97F3\u8F68\u9053"),
            style: {
              height: ROW_H,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 8px",
              fontSize: 11,
              color: T.textDim,
              borderTop: `1px solid ${T.borderFaint}`
            }
          },
          h(
            "span",
            { style: { display: "inline-flex", alignItems: "center", gap: 6, overflow: "hidden" } },
            h("i", {
              style: {
                width: 6,
                height: 6,
                borderRadius: 3,
                background: TRACK_DOT[t.kind] || "#666",
                display: "inline-block",
                opacity: t.muted ? 0.3 : 1
              }
            }),
            h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, t.name || t.kind)
          ),
          h("span", { style: { opacity: 0.6, cursor: "pointer" }, title: "\u53CC\u51FB\u8F68\u9053\u540D\u5207\u6362\u9759\u97F3" }, t.locked ? "\u{1F512}" : t.muted ? "\u{1F507}" : t.kind === "audio" ? "\u{1F50A}" : "")
        )
      )
    ),
    // scrollable canvas
    h(
      "div",
      {
        ref: scroller,
        onScroll: sync,
        // 滚轮默认竖着滚整页；时间线要的是横向找时间。竖向滚轮改成横向滚动。
        onWheel: (e) => {
          const el = scroller.current;
          if (!el) return;
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            el.scrollLeft = Math.max(0, el.scrollLeft + e.deltaY);
          }
        },
        style: { flex: 1, overflowX: "auto", overflowY: "hidden", position: "relative" }
      },
      h(
        "div",
        { style: { position: "relative", width, height: "100%" } },
        // ruler (click to seek)
        h(
          "div",
          {
            onPointerDown: (e) => {
              if (e.button != null && e.button !== 0) return;
              scrubRef.current = { last: 0 };
              scrubTo(e, { scrub: true, force: true });
            },
            style: {
              position: "sticky",
              top: 0,
              height: RULER_H,
              cursor: "ew-resize",
              borderBottom: `1px solid ${T.border}`,
              background: T.bg,
              zIndex: 3
            }
          },
          ticks
        ),
        // 标注轨：专用、固定高度、不参与合成。所有胶囊 / 小旗都在这一条里。
        h(
          "div",
          {
            style: {
              position: "relative",
              height: ANNOT_TRACK_H,
              background: T.fill,
              borderBottom: `1px solid ${T.borderFaint}`
            }
          },
          annotLayout.counts.total === 0 ? h(
            "div",
            {
              style: {
                position: "absolute",
                left: 8,
                top: ANNOT_LANE_TOP,
                fontSize: 10,
                // 工程里明明有标注、界面却一条没拿到：把矛盾写在轨道上，
                // 不要用「还没有标注」把数据丢失伪装成空工程（曾经就是这样）。
                color: annotationMissing ? T.warn : T.textFaint,
                pointerEvents: "none"
              }
            },
            annotationMissing ? `\u5DE5\u7A0B\u91CC\u6709 ${expectedAnnotationCount} \u6761\u6807\u6CE8\uFF0C\u4F46\u754C\u9762\u6CA1\u62FF\u5230\u6570\u636E\uFF08\u5237\u65B0\u5931\u8D25\uFF09\xB7 \u70B9\u9876\u680F\u5237\u65B0\u6216\u91CD\u5F00\u5DE5\u7A0B` : "\u8FD8\u6CA1\u6709\u6807\u6CE8 \xB7 \u64AD\u653E\u65F6\u70B9 + \u6807\u6CE8 \u6DFB\u52A0"
          ) : null,
          annotBars
        ),
        // tracks
        h("div", { style: { position: "relative" } }, rows),
        annotTip,
        // playhead
        h("div", {
          style: {
            position: "absolute",
            left: px(playhead) - 1,
            top: 0,
            bottom: 0,
            width: 2,
            background: "#ff5f56",
            pointerEvents: "none",
            zIndex: 4,
            boxShadow: "0 0 6px rgba(255,95,86,.55)"
          }
        })
      )
    )
  );
}

// src/client/panels.js
var import_react2 = __toESM(require("react"), 1);

// src/style-align.mjs
var ALIGN_LIMITS = {
  /** 四镜主内容左边界的一致性容差（px） */
  marginTolerance: 4,
  /** 标题/副标题基线的一致性容差（px） */
  baselineTolerance: 3,
  /** 字号层级相邻两级之比必须在 [1.4, 1.8] */
  typeRatio: [1.4, 1.8],
  /** 强调条长度 / 所属标题宽度必须在 [0.2, 0.6] */
  emphasisRatio: [0.2, 0.6],
  /** 安全区：四周留 5% */
  safeMargin: 0.05
};
var BASELINE_ROLES = ["eyebrow", "title", "subtitle"];
var TYPE_TIERS = ["heading", "subtitle", "body", "note"];
var BOX_LABELS = {
  // 字号四级的键名（type-scale 直接拿它拼消息）
  heading: "\u6807\u9898",
  // 层上的角色名
  eyebrow: "\u7709\u6807",
  title: "\u6807\u9898",
  subtitle: "\u526F\u6807\u9898",
  body: "\u6B63\u6587",
  note: "\u6CE8\u91CA",
  emphasis: "\u5F3A\u8C03\u6761",
  badge: "\u5FBD\u6807",
  bar: "\u8BFB\u6570\u6761",
  label: "\u8BFB\u6570\u6807\u7B7E"
};
var CJK = /[\u1100-\u11FF\u2E80-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;
var round32 = (v2) => Math.round(Number(v2) * 1e3) / 1e3;
function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function estimateTextWidth(text, sizePx) {
  const size = Math.max(1, finite(sizePx, 16));
  let widest = 0;
  for (const line of String(text === void 0 || text === null ? "" : text).split("\n")) {
    let em = 0;
    for (const ch of line) {
      let w;
      if (CJK.test(ch)) w = 1;
      else if (ch === " ") w = 0.28;
      else if (/[0-9]/.test(ch)) w = 0.56;
      else if (/[A-Z]/.test(ch)) w = 0.66;
      else if (/[a-z]/.test(ch)) w = 0.52;
      else if (/[.,:;!?'"|·、，。/]/.test(ch)) w = 0.34;
      else w = 0.52;
      em += w;
    }
    widest = Math.max(widest, em);
  }
  return widest * size;
}
function countTextLines(text) {
  return String(text === void 0 || text === null ? "" : text).split("\n").length;
}
function median(values) {
  const list = values.filter((v2) => Number.isFinite(v2)).slice().sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}
function measureShot(shot, width, height, scale) {
  const theme = shot && shot.theme || {};
  const layers = Array.isArray(shot && shot.layers) ? shot.layers : [];
  const boxes = [];
  let contentLeft = Infinity;
  for (const layer of layers) {
    if (!layer || layer.type === "backdrop" || layer.type === "grid") continue;
    const x = finite(layer.x, 0.1) * width;
    const y = finite(layer.y, 0.5) * height;
    if (layer.type === "text") {
      const size = Math.max(1, finite(layer.size, 28) * scale);
      const lineHeight = size * finite(layer.lineHeight, 1.2);
      const lines = countTextLines(layer.text);
      const w = estimateTextWidth(layer.text, size);
      const h4 = (lines - 1) * lineHeight + size;
      const align = layer.align || "left";
      const left = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
      boxes.push({
        type: "text",
        role: layer.role || "body",
        text: layer.text,
        left,
        top: y,
        right: left + w,
        bottom: y + h4,
        width: w,
        height: h4,
        size,
        designSize: finite(layer.size, 28),
        baseline: y
      });
      contentLeft = Math.min(contentLeft, left);
      continue;
    }
    if (layer.type === "rule") {
      const h4 = Math.max(1, finite(layer.h, 6) * scale);
      const w = Math.max(2, finite(layer.w, 0.1) * width);
      boxes.push({ type: "rule", role: "emphasis", left: x, top: y, right: x + w, bottom: y + h4, width: w, height: h4 });
      contentLeft = Math.min(contentLeft, x);
      continue;
    }
    if (layer.type === "bar") {
      const h4 = Math.max(1, finite(layer.h, 14) * scale);
      const w = Math.max(2, finite(layer.w, 0.6) * width);
      boxes.push({ type: "bar", role: "bar", left: x, top: y, right: x + w, bottom: y + h4, width: w, height: h4 });
      contentLeft = Math.min(contentLeft, x);
      const labelSize = Math.max(1, finite(layer.labelSize, 15) * scale);
      const label = String(layer.label === void 0 ? "" : layer.label);
      boxes.push({
        type: "text",
        role: "label",
        text: label,
        left: x,
        top: y - 8 * scale - labelSize,
        right: x + estimateTextWidth(label, labelSize),
        bottom: y - 8 * scale,
        width: estimateTextWidth(label, labelSize),
        height: labelSize,
        size: labelSize,
        designSize: finite(layer.labelSize, 15),
        baseline: y - 8 * scale - labelSize
      });
      continue;
    }
    if (layer.type === "badge") {
      const size = Math.max(1, finite(layer.size, 15) * scale);
      const pad2 = 12 * scale;
      const text = String(layer.text === void 0 ? "" : layer.text);
      const w = Math.min(width * 0.8, Array.from(text).length * size * 0.62 + pad2 * 2);
      const h4 = size * 2;
      boxes.push({ type: "badge", role: "badge", text, left: x, top: y, right: x + w, bottom: y + h4, width: w, height: h4 });
      contentLeft = Math.min(contentLeft, x);
    }
  }
  const roles = {};
  for (const box2 of boxes) {
    if (box2.type === "text" && box2.role && box2.role !== "label" && !roles[box2.role]) roles[box2.role] = box2;
  }
  const emphasisBox = boxes.find((box2) => box2.type === "rule") || null;
  const reference = (roles.title && roles.title.width ? roles.title : null) || (roles.subtitle && roles.subtitle.width ? roles.subtitle : null) || (roles.body && roles.body.width ? roles.body : null);
  return {
    index: Number.isInteger(shot && shot.index) ? shot.index : 0,
    kind: shot && shot.kind || "unknown",
    label: shot && shot.label || shot && shot.kind || "unknown",
    contentLeft: Number.isFinite(contentLeft) ? contentLeft : null,
    radius: Number.isFinite(Number(theme.radius)) ? Number(theme.radius) : null,
    strokeWidth: Number.isFinite(Number(theme.strokeWidth)) ? Number(theme.strokeWidth) : null,
    padding: Number.isFinite(Number(theme.padding)) ? Number(theme.padding) : null,
    roles,
    boxes,
    textSizes: boxes.filter((box2) => box2.type === "text").map((box2) => ({ role: box2.role, size: box2.designSize, text: box2.text })),
    emphasis: emphasisBox ? {
      width: emphasisBox.width,
      reference: reference ? { role: reference.role, width: reference.width } : null,
      ratio: reference && reference.width ? emphasisBox.width / reference.width : null
    } : null
  };
}
function measureLayout(shots, options = {}) {
  const width = Math.max(2, Math.round(finite(options.width, 1280)));
  const height = Math.max(2, Math.round(finite(options.height, 720)));
  const scale = height / 720;
  const spec = options.spec || null;
  const font = spec && spec.font || {};
  const measured = (Array.isArray(shots) ? shots : []).map((shot) => measureShot(shot, width, height, scale));
  const margin = median(measured.map((shot) => shot.contentLeft));
  const typeScale = {
    heading: finite(font.heading, 0) || maxDesignSize(measured),
    subtitle: finite(font.subtitle, 0) || 0,
    body: finite(font.body, 0) || 0,
    note: finite(font.note, 0) || minDesignSize(measured)
  };
  return {
    width,
    height,
    scale,
    margin,
    typeScale,
    safe: {
      left: width * ALIGN_LIMITS.safeMargin,
      right: width * (1 - ALIGN_LIMITS.safeMargin),
      top: height * ALIGN_LIMITS.safeMargin,
      bottom: height * (1 - ALIGN_LIMITS.safeMargin)
    },
    shots: measured
  };
}
function maxDesignSize(shots) {
  let max = 0;
  for (const shot of shots) for (const item of shot.textSizes) max = Math.max(max, item.size);
  return max || 1;
}
function minDesignSize(shots) {
  let min = Infinity;
  for (const shot of shots) for (const item of shot.textSizes) min = Math.min(min, item.size);
  return Number.isFinite(min) ? min : 1;
}
function makeIssue(severity, code, message, shotKind, expected, actual, delta, extra) {
  return Object.assign(
    {
      severity,
      code,
      message,
      shotKind: shotKind || null,
      expected: round32(expected),
      actual: round32(actual),
      delta: round32(delta)
    },
    extra || {}
  );
}
function checkAlignment(layout) {
  const issues = [];
  const shots = Array.isArray(layout && layout.shots) ? layout.shots : [];
  const width = finite(layout && layout.width, 1280);
  const height = finite(layout && layout.height, 720);
  const margin = layout && Number.isFinite(layout.margin) ? layout.margin : median(shots.map((s) => s.contentLeft));
  const tol = ALIGN_LIMITS;
  const checks = [];
  const record = (key, label) => {
    const before = issues.length;
    return () => {
      const count = issues.length - before;
      checks.push({ key, label, passed: count === 0, issues: count });
    };
  };
  const doneMargin = record("margin", "\u5DE6\u8FB9\u8DDD");
  if (Number.isFinite(margin) && shots.length > 1) {
    for (const shot of shots) {
      if (!Number.isFinite(shot.contentLeft)) continue;
      const delta = shot.contentLeft - margin;
      if (Math.abs(delta) > tol.marginTolerance) {
        issues.push(
          makeIssue(
            "error",
            "margin-consistent",
            `${shot.label}\uFF1A\u5DE6\u8FB9\u8DDD ${round32(shot.contentLeft)}px\uFF0C\u5176\u4F59 ${round32(margin)}px\uFF0C\u5DEE ${round32(Math.abs(delta))}px`,
            shot.kind,
            margin,
            shot.contentLeft,
            delta
          )
        );
      }
    }
  }
  doneMargin();
  const doneBaseline = record("baseline", "\u57FA\u7EBF");
  for (const role of BASELINE_ROLES) {
    const have = shots.filter((shot) => shot.roles && shot.roles[role]);
    if (have.length < 2) continue;
    const expected = median(have.map((shot) => shot.roles[role].baseline));
    for (const shot of have) {
      const actual = shot.roles[role].baseline;
      const delta = actual - expected;
      if (Math.abs(delta) > tol.baselineTolerance) {
        issues.push(
          makeIssue(
            "error",
            "baseline-consistent",
            `${shot.label}\uFF1A${BOX_LABELS[role]}\u57FA\u7EBF ${round32(actual)}px\uFF0C\u5176\u4F59 ${round32(expected)}px\uFF0C\u5DEE ${round32(Math.abs(delta))}px`,
            shot.kind,
            expected,
            actual,
            delta,
            { role }
          )
        );
      }
    }
  }
  doneBaseline();
  const doneScale = record("typeScale", "\u5B57\u53F7\u5C42\u7EA7");
  const scale = layout && layout.typeScale || {};
  for (let i = 0; i < TYPE_TIERS.length - 1; i += 1) {
    const upper = TYPE_TIERS[i];
    const lower = TYPE_TIERS[i + 1];
    const a = finite(scale[upper], 0);
    const b = finite(scale[lower], 0);
    if (!(a > 0) || !(b > 0)) continue;
    const ratio = a / b;
    if (ratio < tol.typeRatio[0]) {
      issues.push(
        makeIssue(
          "error",
          "type-scale",
          `${BOX_LABELS[upper]} ${a}px / ${BOX_LABELS[lower]} ${b}px = ${round32(ratio)}\uFF0C\u5C0F\u4E8E ${tol.typeRatio[0]}`,
          null,
          tol.typeRatio[0],
          ratio,
          ratio - tol.typeRatio[0],
          { pair: [upper, lower] }
        )
      );
    } else if (ratio > tol.typeRatio[1]) {
      issues.push(
        makeIssue(
          "error",
          "type-scale",
          `${BOX_LABELS[upper]} ${a}px / ${BOX_LABELS[lower]} ${b}px = ${round32(ratio)}\uFF0C\u5927\u4E8E ${tol.typeRatio[1]}`,
          null,
          tol.typeRatio[1],
          ratio,
          ratio - tol.typeRatio[1],
          { pair: [upper, lower] }
        )
      );
    }
  }
  const known = new Set(TYPE_TIERS.map((tier) => finite(scale[tier], 0)).filter((v2) => v2 > 0));
  for (const shot of shots) {
    if (!known.size) break;
    const tiers = [...known];
    for (const item of shot.textSizes || []) {
      if (!item.size) continue;
      const nearest = tiers.reduce((best, v2) => Math.abs(v2 - item.size) < Math.abs(best - item.size) ? v2 : best, tiers[0]);
      if (Math.abs(nearest - item.size) > 0.5) {
        issues.push(
          makeIssue(
            "warn",
            "font-tier-drift",
            `${shot.label}\uFF1A${BOX_LABELS[item.role] || item.role} ${item.size}px \u4E0D\u5728\u56DB\u7EA7\u5B57\u53F7\u91CC\uFF08\u6700\u8FD1 ${nearest}px\uFF09`,
            shot.kind,
            nearest,
            item.size,
            item.size - nearest,
            { role: item.role }
          )
        );
      }
    }
  }
  doneScale();
  const doneEmphasis = record("emphasis", "\u5F3A\u8C03\u6761\u6BD4\u4F8B");
  for (const shot of shots) {
    const emphasis = shot.emphasis;
    if (!emphasis) continue;
    if (!emphasis.reference || !(emphasis.ratio > 0)) {
      issues.push(
        makeIssue(
          "warn",
          "emphasis-ratio",
          `${shot.label}\uFF1A\u5F3A\u8C03\u6761 ${round32(emphasis.width)}px \u627E\u4E0D\u5230\u53EF\u6BD4\u7684\u6807\u9898\u5BBD\u5EA6`,
          shot.kind,
          tol.emphasisRatio[0],
          0,
          -tol.emphasisRatio[0]
        )
      );
      continue;
    }
    const ratio = emphasis.ratio;
    if (ratio < tol.emphasisRatio[0]) {
      issues.push(
        makeIssue(
          "error",
          "emphasis-ratio",
          `${shot.label}\uFF1A\u5F3A\u8C03\u6761 ${round32(emphasis.width)}px / \u6807\u9898 ${round32(emphasis.reference.width)}px = ${round32(ratio)}\uFF0C\u5C0F\u4E8E ${tol.emphasisRatio[0]}`,
          shot.kind,
          tol.emphasisRatio[0],
          ratio,
          ratio - tol.emphasisRatio[0],
          { reference: emphasis.reference.role }
        )
      );
    } else if (ratio > tol.emphasisRatio[1]) {
      issues.push(
        makeIssue(
          "error",
          "emphasis-ratio",
          `${shot.label}\uFF1A\u5F3A\u8C03\u6761 ${round32(emphasis.width)}px / \u6807\u9898 ${round32(emphasis.reference.width)}px = ${round32(ratio)}\uFF0C\u5927\u4E8E ${tol.emphasisRatio[1]}`,
          shot.kind,
          tol.emphasisRatio[1],
          ratio,
          ratio - tol.emphasisRatio[1],
          { reference: emphasis.reference.role }
        )
      );
    }
  }
  doneEmphasis();
  const doneCorners = record("corners", "\u5706\u89D2\u4E0E\u63CF\u8FB9");
  for (const [key, code, label] of [
    ["radius", "radius-consistent", "\u5706\u89D2"],
    ["strokeWidth", "stroke-consistent", "\u63CF\u8FB9"]
  ]) {
    const have = shots.filter((shot) => Number.isFinite(shot[key]));
    if (have.length < 2) continue;
    const expected = median(have.map((shot) => shot[key]));
    for (const shot of have) {
      const delta = shot[key] - expected;
      if (Math.abs(delta) > 0.01) {
        issues.push(
          makeIssue(
            "error",
            code,
            `${shot.label}\uFF1A${label} ${round32(shot[key])}px\uFF0C\u5176\u4F59 ${round32(expected)}px\uFF0C\u5DEE ${round32(Math.abs(delta))}px`,
            shot.kind,
            expected,
            shot[key],
            delta
          )
        );
      }
    }
  }
  doneCorners();
  const doneSafe = record("safeArea", "\u5B89\u5168\u533A");
  const safe = {
    left: width * tol.safeMargin,
    right: width * (1 - tol.safeMargin),
    top: height * tol.safeMargin,
    bottom: height * (1 - tol.safeMargin)
  };
  for (const shot of shots) {
    for (const box2 of shot.boxes || []) {
      const what = `${BOX_LABELS[box2.role] || box2.role}${box2.text ? "\u300C" + String(box2.text).replace(/\n/g, " ") + "\u300D" : ""}`;
      if (box2.left < safe.left) {
        issues.push(
          makeIssue(
            "error",
            "safe-area",
            `${shot.label}\uFF1A${what}\u5DE6\u8FB9\u754C ${round32(box2.left)}px\uFF0C\u8D8A\u8FC7\u5B89\u5168\u533A ${round32(safe.left)}px`,
            shot.kind,
            safe.left,
            box2.left,
            box2.left - safe.left,
            { edge: "left", role: box2.role }
          )
        );
      }
      if (box2.right > safe.right) {
        issues.push(
          makeIssue(
            "error",
            "safe-area",
            `${shot.label}\uFF1A${what}\u53F3\u8FB9\u754C ${round32(box2.right)}px\uFF0C\u8D8A\u8FC7\u5B89\u5168\u533A ${round32(safe.right)}px`,
            shot.kind,
            safe.right,
            box2.right,
            box2.right - safe.right,
            { edge: "right", role: box2.role }
          )
        );
      }
      if (box2.top < safe.top) {
        issues.push(
          makeIssue(
            "error",
            "safe-area",
            `${shot.label}\uFF1A${what}\u4E0A\u8FB9\u754C ${round32(box2.top)}px\uFF0C\u8D8A\u8FC7\u5B89\u5168\u533A ${round32(safe.top)}px`,
            shot.kind,
            safe.top,
            box2.top,
            box2.top - safe.top,
            { edge: "top", role: box2.role }
          )
        );
      }
      if (box2.bottom > safe.bottom) {
        issues.push(
          makeIssue(
            "error",
            "safe-area",
            `${shot.label}\uFF1A${what}\u4E0B\u8FB9\u754C ${round32(box2.bottom)}px\uFF0C\u8D8A\u8FC7\u5B89\u5168\u533A ${round32(safe.bottom)}px`,
            shot.kind,
            safe.bottom,
            box2.bottom,
            box2.bottom - safe.bottom,
            { edge: "bottom", role: box2.role }
          )
        );
      }
    }
  }
  doneSafe();
  const failed = checks.filter((check) => !check.passed).length;
  return {
    ok: issues.every((item) => item.severity !== "error"),
    issues,
    checks,
    summary: { total: checks.length, passed: checks.length - failed, failed, errors: issues.filter((i) => i.severity === "error").length, warnings: issues.filter((i) => i.severity === "warn").length }
  };
}

// src/style-spec.mjs
var STYLE_VERSION = "style/v1";
var PREVIEW_SECONDS = 8;
var DESIGN_WIDTH = 1280;
var DESIGN_HEIGHT = 720;
var GRID = {
  eyebrowY: 0.13,
  ruleY: 0.215,
  titleY: 0.3,
  closingRuleY: 0.52,
  subtitleY: 0.64,
  badgeY: 0.78,
  dataRuleY: 0.395,
  barYs: [0.5, 0.61, 0.72],
  dataNoteY: 0.86,
  captionScrimY: 0.46,
  captionScrimH: 0.38,
  captionRuleY: 0.555,
  captionLineY: 0.6,
  captionTagY: 0.78
};
var EMPHASIS_RATIO = 0.34;
var BPM_TIERS = [
  { bpm: 120, maxSeconds: 2 },
  { bpm: 90, maxSeconds: 3 },
  { bpm: 60, maxSeconds: Infinity }
];
var CLICK_SPEC = {
  sampleRate: 48e3,
  strongHz: 880,
  weakHz: 440,
  clickMs: 60,
  peakDbfs: -18,
  weakDbfs: -22,
  beatsPerBar: 4
};
var SHOT_KINDS = ["opening", "data", "caption", "closing"];
var SHOT_LABELS = {
  opening: "\u5F00\u573A\u5361",
  data: "\u6570\u636E\u5361",
  caption: "\u5B57\u5E55\u5361",
  closing: "\u6536\u5C3E\u5361"
};
var DENSITIES = ["low", "med", "high"];
var DENSITY_LABELS = { low: "\u4F4E", med: "\u4E2D", high: "\u9AD8" };
var FONT_CHOICES = [
  { id: "sans", label: "\u65E0\u886C\u7EBF", family: '"Inter", "Noto Sans SC", system-ui, sans-serif' },
  { id: "serif", label: "\u886C\u7EBF", family: '"Noto Serif SC", "Source Han Serif SC", Georgia, serif' },
  { id: "mono", label: "\u7B49\u5BBD", family: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace' }
];
var LIMITS = {
  heading: [24, 200],
  subtitle: [16, 160],
  body: [12, 120],
  note: [9, 80],
  shotSeconds: [0.5, 10],
  transitionSeconds: [0, 1.5],
  radius: [0, 80],
  padding: [0, 240],
  stroke: [0, 12]
};
var COLOR_KEYS = [
  ["accent", "\u4E3B\u8272"],
  ["secondary", "\u8F85\u8272"],
  ["background", "\u5E95\u8272"]
];
var HEX = /^#[0-9a-fA-F]{6}$/;
var round33 = (v2) => Math.round(v2 * 1e3) / 1e3;
function textColorFor(background) {
  const h4 = HEX.test(String(background || "")) ? String(background).slice(1) : "0F1115";
  const r = parseInt(h4.slice(0, 2), 16);
  const g = parseInt(h4.slice(2, 4), 16);
  const b = parseInt(h4.slice(4, 6), 16);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.62 ? "#12161C" : "#F5F7FA";
}
function defaultStyleSpec() {
  return {
    version: STYLE_VERSION,
    tone: "\u51B7\u9759 \xB7 \u4E13\u4E1A",
    palette: { accent: "#4FD1C5", secondary: "#8B9BB4", background: "#0F1115" },
    // 四级字号：64 / 40 / 26 / 17，相邻比 1.60 / 1.54 / 1.53，都落在 1.4–1.8 里
    font: { family: FONT_CHOICES[0].family, heading: 64, subtitle: 40, body: 26, note: 17 },
    motionDensity: "med",
    rhythm: { shotSeconds: 2, transitionSeconds: 0.4 },
    radius: 14,
    // 96px ≈ 7.5%：比 5% 安全区宽一点，四镜的左边界都从这条线开始
    padding: 96,
    stroke: 1.5,
    grid: true
  };
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function checkNumber(reasons, value, label, key) {
  const [min, max] = LIMITS[key];
  if (value === void 0) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    reasons.push(`${label}\u5FC5\u987B\u662F\u6570\u5B57\uFF1A\u6536\u5230 ${JSON.stringify(value)}`);
    return null;
  }
  if (n < min || n > max) {
    reasons.push(`${label}\u5FC5\u987B\u5728 ${min}\u2013${max} \u4E4B\u95F4\uFF1A\u6536\u5230 ${n}`);
    return null;
  }
  return n;
}
function validateStyleSpec(spec) {
  const reasons = [];
  const warnings = [];
  const base = defaultStyleSpec();
  const out = clone(base);
  if (spec === void 0 || spec === null) {
    warnings.push("\u6CA1\u6709\u4F20 spec\uFF0C\u5DF2\u4F7F\u7528\u9ED8\u8BA4\u98CE\u683C");
    return { ok: true, reasons, warnings, spec: out };
  }
  if (!isPlainObject(spec)) {
    reasons.push(`spec \u5FC5\u987B\u662F\u5BF9\u8C61\uFF1A\u6536\u5230 ${Array.isArray(spec) ? "\u6570\u7EC4" : typeof spec}`);
    return { ok: false, reasons, warnings, spec: base };
  }
  if (Object.keys(spec).length === 0) {
    warnings.push("spec \u4E3A\u7A7A\u5BF9\u8C61\uFF0C\u5DF2\u4F7F\u7528\u9ED8\u8BA4\u98CE\u683C");
    return { ok: true, reasons, warnings, spec: out };
  }
  if (spec.tone === void 0) {
    warnings.push(`\u7F3A\u5C11 tone\uFF0C\u5DF2\u7528\u9ED8\u8BA4\u8C03\u6027\u300C${base.tone}\u300D`);
  } else if (typeof spec.tone !== "string" || !spec.tone.trim()) {
    reasons.push("\u8C03\u6027\uFF08tone\uFF09\u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32");
  } else if (Array.from(spec.tone.trim()).length > 60) {
    reasons.push("\u8C03\u6027\uFF08tone\uFF09\u6700\u957F 60 \u4E2A\u5B57");
  } else {
    out.tone = spec.tone.trim();
  }
  const palette = isPlainObject(spec.palette) ? spec.palette : null;
  if (spec.palette !== void 0 && !palette) reasons.push("\u914D\u8272\uFF08palette\uFF09\u5FC5\u987B\u662F\u5BF9\u8C61");
  for (const [key, label] of COLOR_KEYS) {
    const raw = palette ? palette[key] : void 0;
    if (raw === void 0) {
      warnings.push(`\u7F3A\u5C11\u914D\u8272 ${key}\uFF0C\u5DF2\u7528\u9ED8\u8BA4${label} ${base.palette[key]}`);
      continue;
    }
    if (typeof raw !== "string" || !HEX.test(raw)) {
      reasons.push(`${label}\uFF08palette.${key}\uFF09\u5FC5\u987B\u662F #rrggbb \u5F62\u5F0F\u7684\u5341\u516D\u8FDB\u5236\u989C\u8272\uFF1A\u6536\u5230 ${JSON.stringify(raw)}`);
      continue;
    }
    out.palette[key] = raw.toUpperCase();
  }
  if (palette) {
    for (const key of Object.keys(palette)) {
      if (!COLOR_KEYS.some(([k]) => k === key)) {
        warnings.push(`\u914D\u8272\u91CC\u4E0D\u8BA4\u8BC6\u7684\u5B57\u6BB5 palette.${key}\uFF0C\u5DF2\u5FFD\u7565`);
      }
    }
  }
  const font = isPlainObject(spec.font) ? spec.font : null;
  if (spec.font !== void 0 && !font) reasons.push("\u5B57\u4F53\uFF08font\uFF09\u5FC5\u987B\u662F\u5BF9\u8C61");
  if (font) {
    if (font.family === void 0) {
      warnings.push("\u7F3A\u5C11\u5B57\u4F53\u65CF font.family\uFF0C\u5DF2\u7528\u9ED8\u8BA4\u65E0\u886C\u7EBF");
    } else if (typeof font.family !== "string" || !font.family.trim()) {
      reasons.push("\u5B57\u4F53\u65CF\uFF08font.family\uFF09\u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32");
    } else {
      out.font.family = font.family.trim();
    }
    for (const [key, label] of [
      ["heading", "\u6807\u9898\u5B57\u53F7"],
      ["subtitle", "\u526F\u6807\u9898\u5B57\u53F7"],
      ["body", "\u6B63\u6587\u5B57\u53F7"],
      ["note", "\u6CE8\u91CA\u5B57\u53F7"]
    ]) {
      if (font[key] === void 0) {
        warnings.push(`\u7F3A\u5C11 ${label}\uFF08font.${key}\uFF09\uFF0C\u5DF2\u7528\u9ED8\u8BA4 ${base.font[key]}px`);
        continue;
      }
      const n = checkNumber(reasons, font[key], `${label}\uFF08font.${key}\uFF09`, key);
      if (n !== null) out.font[key] = n;
    }
  }
  if (spec.motionDensity === void 0) {
    warnings.push(`\u7F3A\u5C11\u52A8\u6548\u5BC6\u5EA6 motionDensity\uFF0C\u5DF2\u7528\u9ED8\u8BA4\u300C${DENSITY_LABELS[base.motionDensity]}\u300D`);
  } else if (!DENSITIES.includes(spec.motionDensity)) {
    reasons.push(
      `\u52A8\u6548\u5BC6\u5EA6\uFF08motionDensity\uFF09\u53EA\u80FD\u662F ${DENSITIES.join(" / ")}\uFF1A\u6536\u5230 ${JSON.stringify(spec.motionDensity)}`
    );
  } else {
    out.motionDensity = spec.motionDensity;
  }
  const rhythm = isPlainObject(spec.rhythm) ? spec.rhythm : null;
  if (spec.rhythm !== void 0 && !rhythm) reasons.push("\u8282\u594F\uFF08rhythm\uFF09\u5FC5\u987B\u662F\u5BF9\u8C61");
  if (rhythm) {
    for (const [key, label] of [
      ["shotSeconds", "\u6BCF\u955C\u79D2\u6570\uFF08rhythm.shotSeconds\uFF09"],
      ["transitionSeconds", "\u8F6C\u573A\u79D2\u6570\uFF08rhythm.transitionSeconds\uFF09"]
    ]) {
      if (rhythm[key] === void 0) {
        warnings.push(`\u7F3A\u5C11 ${label}\uFF0C\u5DF2\u7528\u9ED8\u8BA4 ${base.rhythm[key]} \u79D2`);
        continue;
      }
      const n = checkNumber(reasons, rhythm[key], label, key);
      if (n !== null) out.rhythm[key] = n;
    }
    if (out.rhythm.transitionSeconds > out.rhythm.shotSeconds / 2) {
      reasons.push(
        `\u8F6C\u573A\uFF08${out.rhythm.transitionSeconds} \u79D2\uFF09\u4E0D\u80FD\u8D85\u8FC7\u6BCF\u955C\uFF08${out.rhythm.shotSeconds} \u79D2\uFF09\u7684\u4E00\u534A`
      );
    }
  }
  if (spec.radius === void 0) {
    warnings.push(`\u7F3A\u5C11\u5706\u89D2 radius\uFF0C\u5DF2\u7528\u9ED8\u8BA4 ${base.radius}px`);
  } else {
    const n = checkNumber(reasons, spec.radius, "\u5706\u89D2\uFF08radius\uFF09", "radius");
    if (n !== null) out.radius = n;
  }
  if (spec.padding === void 0) {
    warnings.push(`\u7F3A\u5C11\u7559\u767D padding\uFF0C\u5DF2\u7528\u9ED8\u8BA4 ${base.padding}px`);
  } else {
    const n = checkNumber(reasons, spec.padding, "\u7559\u767D\uFF08padding\uFF09", "padding");
    if (n !== null) out.padding = n;
  }
  if (spec.stroke === void 0) {
    warnings.push(`\u7F3A\u5C11\u63CF\u8FB9\u5BBD\u5EA6 stroke\uFF0C\u5DF2\u7528\u9ED8\u8BA4 ${base.stroke}px`);
  } else {
    const n = checkNumber(reasons, spec.stroke, "\u63CF\u8FB9\u5BBD\u5EA6\uFF08stroke\uFF09", "stroke");
    if (n !== null) out.stroke = n;
  }
  if (spec.grid === void 0) {
    warnings.push("\u7F3A\u5C11\u7F51\u683C\u5F00\u5173 grid\uFF0C\u5DF2\u9ED8\u8BA4\u5F00\u542F");
  } else if (typeof spec.grid !== "boolean") {
    reasons.push("\u7F51\u683C\u5F00\u5173\uFF08grid\uFF09\u5FC5\u987B\u662F true / false");
  } else {
    out.grid = spec.grid;
  }
  if (Object.keys(spec).some((k) => !(k in base))) {
    const extra = Object.keys(spec).filter((k) => !(k in base));
    warnings.push(`spec \u91CC\u4E0D\u8BA4\u8BC6\u7684\u5B57\u6BB5\u5DF2\u5FFD\u7565\uFF1A${extra.join(", ")}`);
  }
  return { ok: reasons.length === 0, reasons, warnings, spec: out };
}
function bpmFromRhythm(rhythmSec) {
  const seconds = Number(rhythmSec);
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : PREVIEW_SECONDS / SHOT_KINDS.length;
  const tier = BPM_TIERS.find((item) => safe <= item.maxSeconds) || BPM_TIERS[BPM_TIERS.length - 1];
  return { bpm: tier.bpm, intervalMs: 6e4 / tier.bpm, shotSeconds: safe };
}
var DB_TO_AMP = (db) => Math.pow(10, Number(db) / 20);
function buildClickTrack(shots, options = {}) {
  const list = (Array.isArray(shots) ? shots : []).filter(Boolean);
  const sampleRate = Math.max(8e3, Math.round(Number(options.sampleRate) || CLICK_SPEC.sampleRate));
  const bpm = Number(options.bpm) > 0 ? Number(options.bpm) : bpmFromRhythm(PREVIEW_SECONDS / SHOT_KINDS.length).bpm;
  let duration = 0;
  for (const shot of list) {
    const end = Number(shot.end);
    const start = Number(shot.start) || 0;
    const span = Number(shot.duration) || 0;
    duration = Math.max(duration, Number.isFinite(end) && end > 0 ? end : start + span);
  }
  if (!(duration > 0)) duration = PREVIEW_SECONDS;
  const length = Math.max(1, Math.round(duration * sampleRate));
  const interval = 60 / bpm;
  const raw = [];
  for (let i = 0; i * interval < duration - 1e-9; i += 1) {
    raw.push({ at: i * interval, strong: i % CLICK_SPEC.beatsPerBar === 0, source: "grid" });
  }
  for (const shot of list) {
    const at = Number(shot.start);
    if (Number.isFinite(at) && at >= 0 && at < duration) raw.push({ at, strong: true, source: "cut" });
  }
  raw.sort((a, b) => a.at - b.at);
  const beats = [];
  for (const beat of raw) {
    const last2 = beats[beats.length - 1];
    if (last2 && beat.at - last2.at < 0.04) {
      if (beat.strong) last2.strong = true;
      if (beat.source === "cut") last2.source = "cut";
      continue;
    }
    beats.push({ at: beat.at, strong: beat.strong, source: beat.source });
  }
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const clickSamples = Math.max(8, Math.round(CLICK_SPEC.clickMs / 1e3 * sampleRate));
  const attackSamples = Math.max(1, Math.round(15e-4 * sampleRate));
  const scratch = new Float32Array(clickSamples);
  for (const beat of beats) {
    const offset = Math.round(beat.at * sampleRate);
    if (offset >= length) continue;
    const peak = DB_TO_AMP(beat.strong ? CLICK_SPEC.peakDbfs : CLICK_SPEC.weakDbfs);
    const freq = beat.strong ? CLICK_SPEC.strongHz : CLICK_SPEC.weakHz;
    const omega = 2 * Math.PI * freq / sampleRate;
    let maxAbs = 0;
    for (let i = 0; i < clickSamples; i += 1) {
      const attack = i < attackSamples ? i / attackSamples : 1;
      const decay = Math.exp(-6.9 * (i / (clickSamples - 1)));
      const value = Math.sin(omega * i) * attack * decay;
      scratch[i] = value;
      if (Math.abs(value) > maxAbs) maxAbs = Math.abs(value);
    }
    const gain = maxAbs > 0 ? peak / maxAbs : 0;
    for (let i = 0; i < clickSamples; i += 1) {
      const index = offset + i;
      if (index >= length) break;
      const value = scratch[i] * gain;
      left[index] += value;
      right[index] += value;
    }
  }
  let peakAmp = 0;
  for (let i = 0; i < length; i += 1) {
    if (left[i] > 1) left[i] = 1;
    else if (left[i] < -1) left[i] = -1;
    if (right[i] > 1) right[i] = 1;
    else if (right[i] < -1) right[i] = -1;
    peakAmp = Math.max(peakAmp, Math.abs(left[i]), Math.abs(right[i]));
  }
  return {
    sampleRate,
    numberOfChannels: 2,
    length,
    duration: length / sampleRate,
    bpm,
    intervalMs: 6e4 / bpm,
    beatsPerBar: CLICK_SPEC.beatsPerBar,
    clickMs: CLICK_SPEC.clickMs,
    strongHz: CLICK_SPEC.strongHz,
    weakHz: CLICK_SPEC.weakHz,
    peakDbfs: CLICK_SPEC.peakDbfs,
    peak: peakAmp,
    beats: beats.map((beat) => ({
      at: Math.round(beat.at * 1e3) / 1e3,
      strong: !!beat.strong,
      freq: beat.strong ? CLICK_SPEC.strongHz : CLICK_SPEC.weakHz,
      source: beat.source
    })),
    channels: [left, right],
    getChannelData(channel) {
      const index = Math.max(0, Math.min(1, Math.floor(Number(channel) || 0)));
      return this.channels[index];
    }
  };
}
function clickTrackToWav(track2) {
  const sampleRate = Math.max(8e3, Math.round(Number(track2 && track2.sampleRate) || CLICK_SPEC.sampleRate));
  const channels = Math.max(1, Math.min(2, Math.round(Number(track2 && track2.numberOfChannels) || 1)));
  const length = Math.max(0, Math.round(Number(track2 && track2.length) || 0));
  const dataBytes = length * channels * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view2 = new DataView(buffer);
  const writeText = (offset2, text) => {
    for (let i = 0; i < text.length; i += 1) view2.setUint8(offset2 + i, text.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view2.setUint32(4, 36 + dataBytes, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view2.setUint32(16, 16, true);
  view2.setUint16(20, 1, true);
  view2.setUint16(22, channels, true);
  view2.setUint32(24, sampleRate, true);
  view2.setUint32(28, sampleRate * channels * 2, true);
  view2.setUint16(32, channels * 2, true);
  view2.setUint16(34, 16, true);
  writeText(36, "data");
  view2.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < length; i += 1) {
    for (let ch = 0; ch < channels; ch += 1) {
      const data = track2 && typeof track2.getChannelData === "function" ? track2.getChannelData(ch) : null;
      const sample = data ? data[i] || 0 : 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      view2.setInt16(offset, clamped < 0 ? clamped * 32768 : clamped * 32767, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}
function shotContent(spec) {
  const { accent, secondary } = spec.palette;
  const text = textColorFor(spec.palette.background);
  return [
    {
      kind: "opening",
      text: {
        eyebrow: "STYLE / S1",
        title: "\u628A\u590D\u6742\u7684\u4E8B\u60C5\n\u8BB2\u6E05\u695A",
        subtitle: "\u56DB\u5F20\u5361 + 8 \u79D2\u6837\u7247\uFF0C\u5148\u786E\u8BA4\u98CE\u683C\uFF0C\u518D\u94FA\u6574\u7247",
        badge: "\u6837\u7247 01"
      },
      eyebrow: "\u98CE\u683C\u786E\u8BA4 \xB7 \u5F00\u573A",
      accent,
      secondary,
      textColor: text
    },
    {
      kind: "data",
      text: {
        eyebrow: "DATA / 02",
        title: "\u4E09\u4E2A\u6570\u5B57",
        bars: [
          { label: "\u4FE1\u606F\u5BC6\u5EA6", value: 0.82, role: "accent" },
          { label: "\u8282\u594F\u5F3A\u5EA6", value: 0.61, role: "secondary" },
          { label: "\u89C6\u89C9\u7559\u767D", value: 0.74, role: "secondary" }
        ],
        note: "\u793A\u4F8B\u6570\u636E \xB7 \u53EA\u7528\u6765\u5C55\u793A\u8BFB\u6570\u5C42\u7684\u753B\u6CD5"
      },
      eyebrow: "\u6570\u636E\u5361 \xB7 \u8BFB\u6570",
      accent,
      secondary,
      textColor: text
    },
    {
      kind: "caption",
      text: {
        eyebrow: "SUB / 03",
        line: "\u8FD9\u4E00\u884C\u5B57\u5E55\u8BF4\u660E\u4E00\u4EF6\u4E8B\uFF1A\n\u8BDD\u53EF\u4EE5\u5C11\u8BF4\uFF0C\u4F46\u8981\u8BF4\u6E05\u695A\u3002",
        tag: "\u5B57\u5E55\u5361 \xB7 \u9605\u8BFB\u8282\u594F"
      },
      eyebrow: "\u5B57\u5E55\u5361 \xB7 \u53E3\u64AD",
      accent,
      secondary,
      textColor: text
    },
    {
      kind: "closing",
      text: {
        eyebrow: "END / 04",
        title: "\u98CE\u683C\u786E\u8BA4",
        subtitle: "\u786E\u8BA4\u540E\u6309\u8FD9\u5957\u98CE\u683C\u94FA\u6EE1\u6574\u7247",
        badge: "END"
      },
      eyebrow: "\u6536\u5C3E\u5361 \xB7 \u843D\u7248",
      accent,
      secondary,
      textColor: text
    }
  ];
}
function layersFor(item, spec) {
  const { kind, text, accent, secondary } = item;
  const textColor = item.textColor;
  const ROLE_TO_SIZE = { eyebrow: "note", title: "heading", subtitle: "subtitle", body: "body", note: "note" };
  const mx = Math.max(0, Number(spec.padding) || 0) / DESIGN_WIDTH;
  const rule = (y, titleText, sizeKey) => {
    const widthPx = Math.max(
      DESIGN_WIDTH * 0.04,
      Math.min(DESIGN_WIDTH * 0.4, estimateTextWidth(titleText, spec.font[sizeKey]) * EMPHASIS_RATIO)
    );
    return {
      type: "rule",
      role: "emphasis",
      color: accent,
      x: mx,
      y,
      w: widthPx / DESIGN_WIDTH,
      h: 6,
      radius: 3
    };
  };
  const textLayer = (role, value, y, options) => {
    const opts = options || {};
    return {
      type: "text",
      role,
      color: opts.color || textColor,
      text: value,
      // 四镜一律左对齐：居中的卡量不出可比的左边界，也就补不上「对齐」这件事
      x: mx,
      y,
      size: spec.font[opts.sizeKey || ROLE_TO_SIZE[role]],
      weight: opts.weight || 400,
      align: "left",
      lineHeight: opts.lineHeight || 1.2
    };
  };
  const badge = (value, y) => ({
    type: "badge",
    role: "badge",
    color: accent,
    text: value,
    x: mx,
    y,
    size: spec.font.note
  });
  if (kind === "opening") {
    return [
      { type: "backdrop", role: "background", color: spec.palette.background },
      { type: "grid", role: "secondary", color: secondary },
      textLayer("eyebrow", text.eyebrow, GRID.eyebrowY, { color: accent, weight: 600 }),
      rule(GRID.ruleY, text.title, "heading"),
      textLayer("title", text.title, GRID.titleY, { weight: 700, lineHeight: 1.16 }),
      textLayer("subtitle", text.subtitle, GRID.subtitleY, { color: secondary, lineHeight: 1.3 }),
      badge(text.badge, GRID.badgeY)
    ];
  }
  if (kind === "data") {
    const bars = text.bars || [];
    const layers = [
      { type: "backdrop", role: "background", color: spec.palette.background },
      { type: "grid", role: "secondary", color: secondary },
      textLayer("eyebrow", text.eyebrow, GRID.eyebrowY, { color: accent, weight: 600 }),
      textLayer("title", text.title, GRID.titleY, { weight: 700, lineHeight: 1.16 }),
      rule(GRID.dataRuleY, text.title, "heading")
    ];
    bars.forEach((bar, index) => {
      layers.push({
        type: "bar",
        role: "bar",
        color: bar.role === "accent" ? accent : secondary,
        x: mx,
        y: GRID.barYs[index] === void 0 ? GRID.barYs[GRID.barYs.length - 1] + (index - 2) * 0.12 : GRID.barYs[index],
        w: 0.72,
        h: 14,
        // 圆角走 token：改 spec.radius，四条读数条一起变
        radius: spec.radius,
        value: bar.value,
        label: bar.label,
        labelSize: spec.font.note
      });
    });
    layers.push(textLayer("note", text.note, GRID.dataNoteY, { color: secondary }));
    return layers;
  }
  if (kind === "caption") {
    return [
      { type: "backdrop", role: "background", color: spec.palette.background },
      { type: "grid", role: "secondary", color: secondary },
      textLayer("eyebrow", text.eyebrow, GRID.eyebrowY, { color: accent, weight: 600 }),
      { type: "scrim", role: "background", color: "#000000", alpha: 0.42, y: GRID.captionScrimY, h: GRID.captionScrimH },
      rule(GRID.captionRuleY, text.line, "body"),
      textLayer("body", text.line, GRID.captionLineY, { weight: 500, lineHeight: 1.35 }),
      textLayer("note", text.tag, GRID.captionTagY, { color: secondary })
    ];
  }
  return [
    { type: "backdrop", role: "background", color: spec.palette.background },
    { type: "grid", role: "secondary", color: secondary },
    textLayer("eyebrow", text.eyebrow, GRID.eyebrowY, { color: accent, weight: 600 }),
    textLayer("title", text.title, GRID.titleY, { weight: 700, lineHeight: 1.16 }),
    rule(GRID.closingRuleY, text.title, "heading"),
    textLayer("subtitle", text.subtitle, GRID.subtitleY, { color: secondary, lineHeight: 1.3 }),
    badge(text.badge, GRID.badgeY)
  ];
}
function shotMotion(spec) {
  const density = spec.motionDensity;
  return {
    enter: "fade-up",
    exit: "none",
    density,
    // 进入动效的总时长（秒）与每层之间的错峰，都由密度决定
    enterSeconds: density === "high" ? 0.32 : density === "low" ? 0.72 : 0.5,
    staggerSeconds: density === "high" ? 0.05 : density === "low" ? 0.15 : 0.09,
    travelPx: density === "high" ? 42 : density === "low" ? 12 : 26,
    leadSeconds: 0.14,
    easing: "easeOutCubic"
  };
}
function buildStyleShots(spec, options) {
  const checked = validateStyleSpec(spec);
  if (!checked.ok) {
    throw new DomainError("INVALID_ARG", "\u98CE\u683C spec \u4E0D\u5408\u6CD5\uFF1A" + checked.reasons.join("\uFF1B"));
  }
  const normalized = checked.spec;
  const shotSeconds = normalized.rhythm.shotSeconds;
  const transitionSeconds = Math.min(normalized.rhythm.transitionSeconds, shotSeconds / 2);
  const trackId = options && options.trackId || "v1";
  const content = shotContent(normalized);
  const motion = shotMotion(normalized);
  return content.map((item, index) => {
    const start = round33(index * shotSeconds);
    const end = round33(start + shotSeconds);
    const duration = round33(end - start);
    const layerId = `style-${item.kind}`;
    const clipId = `style_${item.kind}`;
    const shot = {
      index,
      id: shotId(item.kind),
      kind: item.kind,
      label: SHOT_LABELS[item.kind],
      eyebrow: item.eyebrow,
      start,
      duration,
      end,
      // 关键帧取这一镜的 72% 处：进入动效已经走完，内容是全的
      keyframeAt: round33(start + duration * 0.72),
      theme: {
        accent: normalized.palette.accent,
        secondary: normalized.palette.secondary,
        background: normalized.palette.background,
        text: item.textColor,
        family: normalized.font.family,
        radius: normalized.radius,
        strokeWidth: normalized.stroke,
        padding: normalized.padding,
        grid: normalized.grid,
        motionDensity: normalized.motionDensity
      },
      layers: layersFor(item, normalized),
      motion: clone(motion),
      transitionOut: index < content.length - 1 ? { type: "crossfade", duration: round33(transitionSeconds) } : null,
      content: clone(item.text),
      layerId,
      clipId
    };
    shot.ops = [
      {
        type: "clip.insert",
        clipId,
        trackId,
        clipType: "code",
        layerId,
        start,
        duration,
        contentDuration: duration,
        props: { styleShot: shot.id, styleVersion: STYLE_VERSION }
      }
    ];
    return shot;
  });
}
function shotId(kind) {
  return "style-" + kind;
}
function previewLayout() {
  const relDir = ".dsh-video/style-preview";
  return {
    relDir,
    relDoc: relDir + "/project.json",
    relStyle: relDir + "/style.json",
    relCodeDir: relDir + "/code",
    relFramesDir: relDir + "/frames",
    relVideo: relDir + "/preview-8s.mp4",
    relVideoWebm: relDir + "/preview-8s.webm",
    /**
     * 独立的节拍音轨：只有在混不进样片（浏览器没有 AudioEncoder / AAC）时才落盘。
     * 它和样片长度一样，面板用它配「播放节拍」按钮。
     */
    relClick: relDir + "/preview-8s-click.wav",
    /**
     * 样片路径按容器给：容器由导出端的编码能力决定（没有 H.264 编码器就是 WebM），
     * 文件名必须说实话，不能把 WebM 字节写成 .mp4。
     */
    videoRelPath(container) {
      return container === "webm" ? relDir + "/preview-8s.webm" : relDir + "/preview-8s.mp4";
    },
    /** 第 index 张关键帧的工程内相对路径 */
    frameRelPath(index, kind) {
      const n = String(index + 1).padStart(2, "0");
      return `${relDir}/frames/${n}-${kind}.png`;
    },
    /** 第 index 张关键帧在预览目录里的相对路径（面板/接口用这个） */
    frameFileName(index, kind) {
      const n = String(index + 1).padStart(2, "0");
      return `${n}-${kind}.png`;
    }
  };
}
function paintShotLayers(ctx2, shot, view2) {
  const W = Math.max(2, Math.round(view2 && view2.width || 1280));
  const H = Math.max(2, Math.round(view2 && view2.height || 720));
  const t = Number(view2 && view2.t) || 0;
  const baseAlpha = view2 && view2.alpha === void 0 ? 1 : Math.max(0, Math.min(1, Number(view2 && view2.alpha)));
  const theme = shot && shot.theme || {};
  const motion = shot && shot.motion || {};
  const scale = H / 720;
  const family = theme.family || "sans-serif";
  const accent = theme.accent || "#4FD1C5";
  const secondary = theme.secondary || "#8B9BB4";
  const textColor = theme.text || "#F5F7FA";
  const density = theme.motionDensity === "low" || theme.motionDensity === "high" ? theme.motionDensity : "med";
  const enterSeconds = Number(motion.enterSeconds) || (density === "high" ? 0.32 : density === "low" ? 0.72 : 0.5);
  const stagger = Number(motion.staggerSeconds) || (density === "high" ? 0.05 : density === "low" ? 0.15 : 0.09);
  const travel = (Number(motion.travelPx) || 26) * scale;
  const lead = Number(motion.leadSeconds) || 0;
  const clamp012 = (v2) => v2 < 0 ? 0 : v2 > 1 ? 1 : v2;
  const easeOut = (v2) => 1 - Math.pow(1 - v2, 3);
  const hexToRgba = (hex, alpha) => {
    const h4 = /^#[0-9a-fA-F]{6}$/.test(String(hex || "")) ? String(hex).slice(1) : "FFFFFF";
    const r = parseInt(h4.slice(0, 2), 16);
    const g = parseInt(h4.slice(2, 4), 16);
    const b = parseInt(h4.slice(4, 6), 16);
    const a = Math.max(0, Math.min(1, Number(alpha)));
    return "rgba(" + r + ", " + g + ", " + b + ", " + a + ")";
  };
  const roundedPath = (x, y, w, h4, r) => {
    const rr = Math.max(0, Math.min(Number(r) || 0, Math.min(w, h4) / 2));
    ctx2.beginPath();
    ctx2.moveTo(x + rr, y);
    ctx2.lineTo(x + w - rr, y);
    ctx2.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx2.lineTo(x + w, y + h4 - rr);
    ctx2.quadraticCurveTo(x + w, y + h4, x + w - rr, y + h4);
    ctx2.lineTo(x + rr, y + h4);
    ctx2.quadraticCurveTo(x, y + h4, x, y + h4 - rr);
    ctx2.lineTo(x, y + rr);
    ctx2.quadraticCurveTo(x, y, x + rr, y);
    ctx2.closePath();
  };
  ctx2.save();
  ctx2.globalAlpha = baseAlpha;
  ctx2.fillStyle = theme.background || "#0F1115";
  ctx2.fillRect(0, 0, W, H);
  if (theme.grid) {
    ctx2.strokeStyle = hexToRgba(secondary, 0.1);
    ctx2.lineWidth = Math.max(1, scale);
    const step = 80 * scale;
    ctx2.beginPath();
    for (let x = step; x < W; x += step) {
      ctx2.moveTo(x, 0);
      ctx2.lineTo(x, H);
    }
    for (let y = step; y < H; y += step) {
      ctx2.moveTo(0, y);
      ctx2.lineTo(W, y);
    }
    ctx2.stroke();
  }
  ctx2.fillStyle = hexToRgba(accent, 0.06);
  ctx2.fillRect(0, 0, W, 6 * scale);
  ctx2.restore();
  const layers = Array.isArray(shot && shot.layers) ? shot.layers : [];
  let order = 0;
  for (const layer of layers) {
    if (!layer || layer.type === "backdrop" || layer.type === "grid") continue;
    order += 1;
    const p = clamp012((t + lead - (order - 1) * stagger) / enterSeconds);
    const a = easeOut(p);
    const dy = (1 - a) * travel;
    ctx2.save();
    ctx2.globalAlpha = baseAlpha * a * (layer.opacity === void 0 ? 1 : Number(layer.opacity));
    if (layer.type === "text") {
      const size = Math.max(1, (Number(layer.size) || 28) * scale);
      ctx2.fillStyle = layer.color || textColor;
      ctx2.font = (layer.weight || 400) + " " + size + "px " + family;
      ctx2.textAlign = layer.align || "left";
      ctx2.textBaseline = "top";
      const lines = String(layer.text === void 0 || layer.text === null ? "" : layer.text).split("\n");
      const lineHeight = size * (Number(layer.lineHeight) || 1.2);
      const x = (layer.x === void 0 ? 0.1 : Number(layer.x)) * W;
      const y = (layer.y === void 0 ? 0.2 : Number(layer.y)) * H + dy;
      for (let i = 0; i < lines.length; i += 1) {
        ctx2.fillText(lines[i], x, y + i * lineHeight);
      }
    } else if (layer.type === "rule") {
      const h4 = Math.max(1, (Number(layer.h) || 5) * scale);
      const w = Math.max(2, Number(layer.w || 0.1) * W * (0.2 + 0.8 * a));
      const x = Number(layer.x || 0) * W;
      const y = Number(layer.y || 0) * H + dy;
      ctx2.fillStyle = layer.color || accent;
      roundedPath(x, y, w, h4, Number(layer.radius === void 0 ? h4 / 2 : layer.radius) * scale);
      ctx2.fill();
    } else if (layer.type === "bar") {
      const x = Number(layer.x || 0.1) * W;
      const y = Number(layer.y || 0.5) * H + dy;
      const w = Number(layer.w || 0.6) * W;
      const h4 = Math.max(4, (Number(layer.h) || 14) * scale);
      const r = Number(layer.radius === void 0 ? h4 / 2 : layer.radius) * scale;
      ctx2.fillStyle = hexToRgba(textColor, 0.1);
      roundedPath(x, y, w, h4, r);
      ctx2.fill();
      const value = clamp012(Number(layer.value) || 0) * a;
      if (value > 1e-3) {
        ctx2.fillStyle = layer.color || accent;
        roundedPath(x, y, Math.max(h4, w * value), h4, r);
        ctx2.fill();
      }
      const labelSize = Math.max(1, (Number(layer.labelSize) || 15) * scale);
      ctx2.font = "500 " + labelSize + "px " + family;
      ctx2.textBaseline = "bottom";
      ctx2.textAlign = "left";
      ctx2.fillStyle = textColor;
      ctx2.fillText(String(layer.label === void 0 ? "" : layer.label), x, y - 8 * scale);
      ctx2.textAlign = "right";
      ctx2.fillStyle = layer.color || accent;
      ctx2.fillText(Math.round((Number(layer.value) || 0) * 100) + "%", x + w, y - 8 * scale);
    } else if (layer.type === "badge") {
      const size = Math.max(1, (Number(layer.size) || 15) * scale);
      const pad2 = 12 * scale;
      const text = String(layer.text === void 0 ? "" : layer.text);
      const bw = Math.min(W * 0.8, text.length * size * 0.62 + pad2 * 2);
      const bh = size * 2;
      const x = Number(layer.x || 0.1) * W;
      const y = Number(layer.y || 0.7) * H + dy;
      const strokeW = Math.max(0, Number(theme.strokeWidth === void 0 ? 1.5 : theme.strokeWidth)) * scale;
      const corner = Number(theme.radius === void 0 ? 8 : theme.radius) * scale;
      ctx2.fillStyle = hexToRgba(layer.color || accent, 0.12);
      ctx2.strokeStyle = layer.color || accent;
      roundedPath(x, y, bw, bh, corner);
      ctx2.fill();
      if (strokeW > 0) {
        ctx2.lineWidth = Math.max(0.5, strokeW);
        ctx2.stroke();
      }
      ctx2.fillStyle = layer.color || accent;
      ctx2.font = "600 " + size + "px " + family;
      ctx2.textAlign = "left";
      ctx2.textBaseline = "middle";
      ctx2.fillText(text, x + pad2, y + bh / 2);
    } else if (layer.type === "scrim") {
      ctx2.fillStyle = hexToRgba(layer.color || "#000000", layer.alpha === void 0 ? 0.45 : Number(layer.alpha));
      ctx2.fillRect(0, Number(layer.y || 0.5) * H, W, Number(layer.h || 0.3) * H);
    }
    ctx2.restore();
  }
}
function drawStyleFrame(ctx2, view2) {
  const shots = Array.isArray(view2 && view2.shots) ? view2.shots : [];
  const spec = view2 && view2.spec || defaultStyleSpec();
  const W = Math.max(2, Math.round(view2 && view2.width || 1280));
  const H = Math.max(2, Math.round(view2 && view2.height || 720));
  const t = Math.max(0, Number(view2 && view2.t) || 0);
  ctx2.save();
  ctx2.fillStyle = spec.palette.background;
  ctx2.fillRect(0, 0, W, H);
  ctx2.restore();
  if (!shots.length) return;
  const shotSeconds = Math.max(0.1, Number(spec.rhythm.shotSeconds) || shots[0].duration || 2);
  const transition = Math.max(
    0,
    Math.min(Number(spec.rhythm.transitionSeconds) || 0, shotSeconds / 2)
  );
  const index = Math.min(shots.length - 1, Math.max(0, Math.floor(t / shotSeconds)));
  const shot = shots[index];
  const local = Math.max(0, t - shot.start);
  const easeInOut = (v2) => v2 < 0.5 ? 4 * v2 * v2 * v2 : 1 - Math.pow(-2 * v2 + 2, 3) / 2;
  if (index > 0 && transition > 0 && local < transition) {
    const prev = shots[index - 1];
    paintShotLayers(ctx2, prev, {
      width: W,
      height: H,
      t: shotSeconds + local,
      alpha: 1
    });
    paintShotLayers(ctx2, shot, {
      width: W,
      height: H,
      t: local,
      alpha: easeInOut(local / transition)
    });
    return;
  }
  paintShotLayers(ctx2, shot, { width: W, height: H, t: local, alpha: 1 });
}
function specToSummary(spec) {
  const checked = validateStyleSpec(spec);
  const s = checked.spec;
  const fontLabel = (FONT_CHOICES.find((f) => f.family === s.font.family) || {}).label || "\u81EA\u5B9A\u4E49";
  const beat = bpmFromRhythm(s.rhythm.shotSeconds);
  const lines = [
    `\u8C03\u6027\uFF1A${s.tone}`,
    `\u914D\u8272\uFF1A\u4E3B\u8272 ${s.palette.accent} \xB7 \u8F85\u8272 ${s.palette.secondary} \xB7 \u5E95\u8272 ${s.palette.background}`,
    `\u5B57\u4F53\uFF1A${fontLabel}\uFF08${s.font.family}\uFF09\xB7 \u6807\u9898 ${s.font.heading}px / \u526F\u6807\u9898 ${s.font.subtitle}px / \u6B63\u6587 ${s.font.body}px / \u6CE8\u91CA ${s.font.note}px`,
    `\u52A8\u6548\uFF1A${DENSITY_LABELS[s.motionDensity]}\u5BC6\u5EA6 \xB7 \u8282\u594F ${s.rhythm.shotSeconds} \u79D2/\u955C\uFF08${beat.bpm} BPM\uFF09\xB7 \u8F6C\u573A ${s.rhythm.transitionSeconds} \u79D2 \xB7 \u5706\u89D2 ${s.radius}px \xB7 \u63CF\u8FB9 ${s.stroke}px \xB7 \u7559\u767D ${s.padding}px \xB7 \u7F51\u683C ${s.grid ? "\u5F00" : "\u5173"}`
  ];
  return lines.join("\n");
}
function alignmentForSpec(spec, options) {
  const normalized = validateStyleSpec(spec).spec;
  const shots = buildStyleShots(normalized);
  const layout = measureLayout(shots, {
    spec: normalized,
    width: options && options.width || DESIGN_WIDTH,
    height: options && options.height || DESIGN_HEIGHT
  });
  return checkAlignment(layout);
}

// src/client/motion-thumb.js
var DEFAULT_TIMEOUT_MS = 3e3;
var MAX_PARALLEL = 3;
var cache3 = /* @__PURE__ */ new Map();
var pending3 = /* @__PURE__ */ new Map();
var queue = [];
var activeCount = 0;
function thumbCacheKey(id, width, height, t) {
  return `${String(id)}@${Number(t).toFixed(3)}@${Math.round(width)}x${Math.round(height)}`;
}
function stripComments(source) {
  return String(source).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n\r]*/g, "$1");
}
function hasRenderExport(sourceCode) {
  const body = stripComments(sourceCode);
  return /export\s+(?:async\s+)?function\s+render\s*\(/.test(body) || /export\s+(?:const|let|var)\s+render\s*=/.test(body) || /export\s*\{[^}]*\brender\b[^}]*\}/.test(body) || /export\s+default\s+(?:async\s+)?function\s+render\s*\(/.test(body) || /export\s+default\s*\{[\s\S]*?\brender\s*:/.test(body);
}
function assertRenderSource(sourceCode) {
  if (typeof sourceCode !== "string" || !sourceCode.trim()) {
    throw new Error("\u52A8\u6548\u6E90\u7801\u4E3A\u7A7A\uFF0C\u65E0\u6CD5\u751F\u6210\u7F29\u7565\u56FE");
  }
  if (!hasRenderExport(sourceCode)) {
    throw new Error("\u52A8\u6548\u6E90\u7801\u6CA1\u6709\u5BFC\u51FA render(ctx, t, env) \u51FD\u6570\uFF0C\u65E0\u6CD5\u751F\u6210\u7F29\u7565\u56FE");
  }
}
function hashSource(source) {
  let hash = 2166136261;
  const text = String(source);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
function workerBootstrap() {
  "use strict";
  function errorText2(error) {
    if (error && error.message) return String(error.message);
    return String(error);
  }
  function compileByFunction(source) {
    const exported = [];
    let body = String(source);
    body = body.replace(/export\s+default\s+/g, "const __default__ = ");
    body = body.replace(/export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/g, function(match, isAsync, name) {
      exported.push({ exported: name, local: name });
      return (isAsync || "") + "function " + name;
    });
    body = body.replace(/export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g, function(match, kind, name) {
      exported.push({ exported: name, local: name });
      return kind + " " + name;
    });
    body = body.replace(/export\s*\{([^}]*)\}/g, function(match, inner) {
      String(inner).split(",").forEach(function(part) {
        const piece = part.trim();
        if (!piece) return;
        const bits = piece.split(/\s+as\s+/);
        const local = bits[0].trim();
        const name = (bits[1] || bits[0]).trim();
        exported.push({ exported: name, local });
      });
      return "";
    });
    const fields = exported.map(function(item) {
      return JSON.stringify(item.exported) + ": " + item.local;
    });
    fields.push('__default__: typeof __default__ === "undefined" ? undefined : __default__');
    const factory = new Function("self", '"use strict";\n' + body + "\nreturn {" + fields.join(",") + "};");
    return factory(self);
  }
  async function loadModule(source) {
    let url2 = null;
    try {
      const blob = new Blob([String(source)], { type: "text/javascript" });
      url2 = URL.createObjectURL(blob);
      let namespace;
      try {
        namespace = await import(url2);
      } catch (importError) {
        namespace = compileByFunction(source);
      }
      let render = namespace && namespace.render;
      if (!render && namespace && namespace.default && namespace.default.render) {
        render = namespace.default.render;
      }
      if (typeof render !== "function") {
        const error = new Error("\u52A8\u6548\u6E90\u7801\u5FC5\u987B\u5BFC\u51FA render(ctx, t, env) \u51FD\u6570");
        error.code = "NO_RENDER";
        throw error;
      }
      return render;
    } finally {
      if (url2) {
        try {
          URL.revokeObjectURL(url2);
        } catch (error) {
        }
      }
    }
  }
  function blobToDataUrl(blob) {
    return new Promise(function(resolve, reject) {
      const reader = new FileReader();
      reader.onload = function() {
        resolve(String(reader.result || ""));
      };
      reader.onerror = function() {
        reject(reader.error || new Error("\u7F29\u7565\u56FE\u8F6C dataURL \u5931\u8D25"));
      };
      reader.readAsDataURL(blob);
    });
  }
  self.onmessage = async function(event) {
    const message = event && event.data || {};
    if (message.type !== "render") return;
    const width = Math.max(1, Math.round(Number(message.width) || 1));
    const height = Math.max(1, Math.round(Number(message.height) || 1));
    const time = Number(message.t);
    try {
      if (!Number.isFinite(time)) throw new Error("\u7F29\u7565\u56FE\u65F6\u95F4 t \u5FC5\u987B\u662F\u6570\u5B57");
      if (typeof OffscreenCanvas !== "function") throw new Error("\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301 OffscreenCanvas");
      const canvas = new OffscreenCanvas(width, height);
      const draw2 = canvas.getContext("2d");
      if (!draw2) throw new Error("OffscreenCanvas \u65E0\u6CD5\u521B\u5EFA 2d \u4E0A\u4E0B\u6587");
      const render = await loadModule(message.source);
      const props = message.props && typeof message.props === "object" ? message.props : {};
      const env = {
        width,
        height,
        props,
        t: time
      };
      draw2.save();
      draw2.setTransform(1, 0, 0, 1, 0, 0);
      draw2.clearRect(0, 0, width, height);
      try {
        await render(draw2, time, env);
      } finally {
        draw2.restore();
      }
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const dataUrl = await blobToDataUrl(blob);
      if (!dataUrl) throw new Error("\u7F29\u7565\u56FE\u662F\u7A7A\u7684");
      self.postMessage({ type: "result", id: message.id, dataUrl });
    } catch (error) {
      self.postMessage({
        type: "error",
        id: message.id,
        code: error && error.code || "THUMB_FAILED",
        message: errorText2(error)
      });
    }
  };
}
var WORKER_SOURCE = "(" + workerBootstrap.toString() + ")();";
function schedule(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}
function pump() {
  while (activeCount < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    activeCount += 1;
    Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => {
      activeCount -= 1;
      pump();
    });
  }
}
function renderWithWorker(sourceCode, width, height, t, timeoutMs) {
  return new Promise((resolve, reject) => {
    let blobUrl = null;
    let worker = null;
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (worker) {
        try {
          worker.terminate();
        } catch (error) {
        }
        worker = null;
      }
      if (blobUrl) {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch (error) {
        }
        blobUrl = null;
      }
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    try {
      if (typeof Worker !== "function") throw new Error("\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301 Worker");
      if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
        throw new Error("\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301 Blob URL");
      }
      const blob = new Blob([WORKER_SOURCE], { type: "text/javascript" });
      blobUrl = URL.createObjectURL(blob);
      worker = new Worker(blobUrl);
    } catch (error) {
      finish(new Error("\u7F29\u7565\u56FE Worker \u521B\u5EFA\u5931\u8D25\uFF1A" + (error && error.message ? error.message : error)));
      return;
    }
    timer = setTimeout(() => {
      finish(new Error(`\u7F29\u7565\u56FE\u6E32\u67D3\u8D85\u65F6\uFF08${Math.round(timeoutMs / 1e3)} \u79D2\uFF09`));
    }, timeoutMs);
    worker.onmessage = (event) => {
      const message = event && event.data || {};
      if (message.type === "result" && message.dataUrl) {
        finish(null, String(message.dataUrl));
        return;
      }
      if (message.type === "error") {
        finish(new Error("\u7F29\u7565\u56FE\u6E32\u67D3\u5931\u8D25\uFF1A" + (message.message || message.code || "\u672A\u77E5\u9519\u8BEF")));
      }
    };
    worker.onerror = (event) => {
      const detail = event && event.message ? event.message : "Worker \u5185\u90E8\u9519\u8BEF";
      finish(new Error("\u7F29\u7565\u56FE\u6E32\u67D3\u5931\u8D25\uFF1A" + detail));
    };
    worker.onmessageerror = () => {
      finish(new Error("\u7F29\u7565\u56FE\u6E32\u67D3\u5931\u8D25\uFF1AWorker \u6D88\u606F\u65E0\u6CD5\u53CD\u5E8F\u5217\u5316"));
    };
    worker.postMessage({
      type: "render",
      source: sourceCode,
      width,
      height,
      t,
      props: {}
    });
  });
}
function renderThumb(sourceCode, width, height, t, ...rest) {
  const options = rest.length ? rest[0] : void 0;
  const opts = typeof options === "string" ? { id: options } : options || {};
  const w = Math.max(1, Math.round(Number(width) || 1));
  const h4 = Math.max(1, Math.round(Number(height) || 1));
  const time = Number(t);
  const id = opts.id ? String(opts.id) : "source:" + hashSource(sourceCode);
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const renderImpl = typeof opts.renderImpl === "function" ? opts.renderImpl : renderWithWorker;
  if (!Number.isFinite(time)) {
    return Promise.reject(new Error("\u7F29\u7565\u56FE\u65F6\u95F4 t \u5FC5\u987B\u662F\u6570\u5B57"));
  }
  try {
    assertRenderSource(sourceCode);
  } catch (error) {
    return Promise.reject(error);
  }
  const key = thumbCacheKey(id, w, h4, time);
  if (cache3.has(key)) return Promise.resolve(cache3.get(key));
  if (pending3.has(key)) return pending3.get(key);
  const task = schedule(() => renderImpl(sourceCode, w, h4, time, timeoutMs)).then((dataUrl) => {
    if (typeof dataUrl !== "string" || !dataUrl) throw new Error("\u7F29\u7565\u56FE\u6E32\u67D3\u7ED3\u679C\u4E0D\u662F dataURL");
    cache3.set(key, dataUrl);
    return dataUrl;
  }).finally(() => {
    pending3.delete(key);
  });
  pending3.set(key, task);
  return task;
}

// src/client/panels.js
var OPTION_STYLE = { background: T.bg, color: T.text };
function h2(type, props, ...children) {
  if (type !== "select") return import_react2.default.createElement(type, props, ...children);
  const flat = [];
  const push = (c) => {
    if (Array.isArray(c)) c.forEach(push);
    else if (c != null && c !== false) flat.push(c);
  };
  children.forEach(push);
  const kids = flat.map(
    (c) => c && c.type === "option" ? import_react2.default.createElement("option", {
      key: c.key,
      ...c.props,
      style: { ...OPTION_STYLE, ...c.props && c.props.style || {} }
    }) : c
  );
  return import_react2.default.createElement(
    "select",
    { ...props || {}, style: { colorScheme: "dark", ...props && props.style || {} } },
    ...kids
  );
}
var chip = (text, tone) => h2(
  "span",
  {
    style: {
      fontSize: 10,
      padding: "1px 6px",
      borderRadius: 4,
      color: T.textDim,
      background: tone === "warn" ? T.warnDim : T.fillStrong,
      border: `1px solid ${T.border}`,
      whiteSpace: "nowrap"
    }
  },
  text
);
function motionInitial(item) {
  const text = String(item && (item.title || item.id) || "?").trim();
  return text ? text.slice(0, 1) : "?";
}
function motionThumbBox(item, text, title, width, height, fontSize) {
  const boxWidth = width || 64;
  const boxHeight = height || 36;
  return h2(
    "div",
    {
      title: title || "",
      style: {
        width: boxWidth,
        height: boxHeight,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: boxWidth > 100 ? 6 : 4,
        border: `1px solid ${T.border}`,
        background: T.fill,
        color: T.textDim,
        fontSize: fontSize || (text && text.length > 1 ? 9 : 15),
        lineHeight: 1,
        overflow: "hidden",
        flex: "0 0 auto",
        userSelect: "none"
      }
    },
    text
  );
}
function MotionThumb({ item, onOpen }) {
  const code = item && (item.code || item.preview) || "";
  const [src, setSrc] = import_react2.default.useState("");
  const [failed, setFailed] = import_react2.default.useState(!code);
  import_react2.default.useEffect(() => {
    let alive = true;
    setSrc("");
    setFailed(!code);
    if (!code) {
      return () => {
        alive = false;
      };
    }
    renderThumb(code, 64, 36, 1, { id: item.id }).then((url2) => {
      if (alive) setSrc(url2);
    }).catch(() => {
      if (alive) setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [item.id, code]);
  let content;
  if (!code) content = motionThumbBox(item, "\u65E0\u9884\u89C8", "\u8BE5\u52A8\u6548\u6E90\u7801\u8D85\u8FC7 4KB\uFF0C\u5217\u8868\u4E0D\u63D0\u4F9B\u9884\u89C8");
  else if (failed) content = motionThumbBox(item, motionInitial(item), "\u7F29\u7565\u56FE\u6E32\u67D3\u5931\u8D25");
  else if (!src) content = motionThumbBox(item, "\u2026", "\u7F29\u7565\u56FE\u6E32\u67D3\u4E2D");
  else {
    content = h2("img", {
      src,
      alt: (item.title || item.id) + " \u7F29\u7565\u56FE",
      draggable: false,
      style: { width: 64, height: 36, display: "block", objectFit: "cover", borderRadius: 4 }
    });
  }
  return h2(
    "button",
    {
      type: "button",
      title: code ? "\u70B9\u51FB\u653E\u5927\u9884\u89C8" : "\u65E0\u9884\u89C8",
      onClick: () => {
        if (code) onOpen(item, code);
      },
      style: {
        padding: 0,
        margin: 0,
        width: 64,
        height: 36,
        flex: "0 0 auto",
        border: "none",
        borderRadius: 4,
        background: "transparent",
        cursor: code ? "zoom-in" : "default",
        overflow: "hidden"
      }
    },
    content
  );
}
function MotionPreview({ item, code, onClose }) {
  const W = 320;
  const H = 180;
  const FRAMES = 12;
  const FPS = 8;
  const SPAN = 3;
  const [frames, setFrames] = import_react2.default.useState([]);
  const [idx, setIdx] = import_react2.default.useState(0);
  const [failed, setFailed] = import_react2.default.useState(!code);
  import_react2.default.useEffect(() => {
    let alive = true;
    setFrames([]);
    setIdx(0);
    setFailed(!code);
    if (!code) return () => {
      alive = false;
    };
    (async () => {
      for (let k = 0; k < FRAMES; k += 1) {
        try {
          const t = k / FRAMES * SPAN;
          const url2 = await renderThumb(code, W, H, t, { id: item.id + "@" + k });
          if (!alive) return;
          setFrames((prev) => {
            const next = prev.slice();
            next[k] = url2;
            return next;
          });
        } catch {
          if (alive) setFailed(true);
          return;
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [item.id, code]);
  import_react2.default.useEffect(() => {
    if (frames.length < 2) return void 0;
    const timer = setInterval(() => setIdx((v2) => (v2 + 1) % frames.length), 1e3 / FPS);
    return () => clearInterval(timer);
  }, [frames.length]);
  const current = frames.length ? frames[idx % frames.length] : "";
  let frame;
  if (!code) frame = motionThumbBox(item, "\u65E0\u9884\u89C8", "\u8BE5\u52A8\u6548\u6E90\u7801\u8D85\u8FC7 4KB", W, H, 14);
  else if (failed && !frames.length) frame = motionThumbBox(item, motionInitial(item), "\u9884\u89C8\u6E32\u67D3\u5931\u8D25", W, H, 42);
  else if (!current) frame = motionThumbBox(item, "\u6E32\u67D3\u4E2D\u2026", "\u6B63\u5728\u6E32\u67D3\u9884\u89C8", W, H, 14);
  else {
    frame = h2("img", {
      src: current,
      alt: (item.title || item.id) + " \u9884\u89C8",
      draggable: false,
      style: { width: W, height: H, display: "block", objectFit: "cover", borderRadius: 6 }
    });
  }
  return h2(
    "div",
    {
      role: "button",
      tabIndex: 0,
      title: "\u70B9\u51FB\u5173\u95ED\u9884\u89C8",
      onClick: onClose,
      onKeyDown: (e) => {
        if (e.key === "Escape" || e.key === "Enter" || e.key === " ") onClose();
      },
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 1e3,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: T.mask,
        cursor: "zoom-out"
      }
    },
    h2(
      "div",
      {
        style: {
          width: 352,
          boxSizing: "border-box",
          padding: 12,
          borderRadius: 10,
          border: `1px solid ${T.border}`,
          background: T.panel,
          boxShadow: T.shadow
        }
      },
      h2(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
        h2("strong", { style: { flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, item.title || item.id),
        h2("span", { style: { fontSize: 10, opacity: 0.55 } }, frames.length > 1 ? "\u5FAA\u73AF\u64AD\u653E\u4E2D" : "\u70B9\u51FB\u5173\u95ED")
      ),
      h2(
        "div",
        {
          style: {
            width: W,
            height: H,
            borderRadius: 6,
            overflow: "hidden",
            background: T.fill,
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
          }
        },
        frame
      ),
      h2("div", { style: { marginTop: 8, fontSize: 10, opacity: 0.5, textAlign: "center" } }, "\u518D\u70B9\u4E00\u4E0B\u5173\u95ED\u9884\u89C8")
    )
  );
}
function MotionRow({ item, onOpen, onInsert, onDoc }) {
  const native = !!item.native;
  return h2(
    "div",
    {
      onClick: native ? void 0 : () => onDoc(item),
      title: native ? "" : "\u70B9\u51FB\u67E5\u770B\u8FD9\u6761 skill \u8BF4\u660E",
      style: {
        cursor: native ? "default" : "pointer",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 7px",
        borderRadius: 8,
        border: `1px solid ${T.border}`,
        background: native ? T.accentDim : T.fill
      }
    },
    native ? h2(MotionThumb, { item, onOpen }) : h2("div", { style: { width: 64, height: 36, flex: "0 0 auto" } }),
    h2(
      "div",
      { style: { flex: 1, minWidth: 0 } },
      h2("div", { style: { fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, item.title || item.id),
      h2("div", { style: { fontSize: 10, opacity: 0.45, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, native ? "\u539F\u751F \xB7 " + item.id : "\u4EC5\u8BF4\u660E \xB7 " + item.id)
    ),
    native ? h2("button", { type: "button", style: { ...btnStyle, padding: "2px 8px", flex: "0 0 auto" }, onClick: () => onInsert(item) }, "\u63D2\u5165") : h2("span", { style: { fontSize: 10, opacity: 0.4, flex: "0 0 auto" } }, "\u9700\u5916\u90E8\u6E32\u67D3")
  );
}
function MotionDoc({ item, onClose }) {
  const [text, setText] = import_react2.default.useState("");
  const [meta, setMeta] = import_react2.default.useState(null);
  const [failed, setFailed] = import_react2.default.useState(false);
  import_react2.default.useEffect(() => {
    let alive = true;
    setFailed(false);
    setText("");
    rpc("motion.doc", { entryId: item.id }).then((result) => {
      if (!alive) return;
      setText(result.doc || "");
      setMeta(result);
    }).catch(() => {
      if (alive) setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [item.id]);
  return h2(
    "div",
    {
      role: "button",
      tabIndex: 0,
      title: "\u70B9\u51FB\u5173\u95ED",
      onClick: onClose,
      onKeyDown: (e) => {
        if (e.key === "Escape" || e.key === "Enter" || e.key === " ") onClose();
      },
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 1e3,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: T.mask,
        cursor: "zoom-out"
      }
    },
    h2(
      "div",
      {
        style: {
          width: 460,
          maxWidth: "90vw",
          boxSizing: "border-box",
          padding: 12,
          borderRadius: 10,
          border: `1px solid ${T.border}`,
          background: T.panel,
          boxShadow: T.shadow
        }
      },
      h2(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
        h2("strong", { style: { flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, item.title || item.id),
        h2("span", { style: { fontSize: 10, opacity: 0.45 } }, "skill \u8BF4\u660E")
      ),
      h2("div", { style: { fontSize: 10, opacity: 0.5, marginBottom: 8, fontFamily: "ui-monospace, monospace" } }, item.id),
      failed ? h2("div", { style: { fontSize: 11, opacity: 0.6, padding: "18px 0" } }, "\u8BFB\u4E0D\u5230\u8FD9\u6761\u8BF4\u660E\uFF08\u6587\u4EF6\u53EF\u80FD\u5DF2\u88AB\u5220\u9664\uFF09\u3002") : h2(
        "div",
        {
          style: {
            maxHeight: 340,
            overflowY: "auto",
            whiteSpace: "pre-wrap",
            fontSize: 12,
            lineHeight: 1.65,
            padding: 10,
            borderRadius: 8,
            background: T.fill,
            border: `1px solid ${T.borderFaint}`
          }
        },
        text || "\u8BFB\u53D6\u4E2D\u2026"
      ),
      meta && meta.truncated ? h2("div", { style: { marginTop: 6, fontSize: 10, opacity: 0.45 } }, "\u53EA\u663E\u793A\u524D " + meta.doc.length + " \u5B57\uFF0C\u5168\u6587 " + meta.totalChars + " \u5B57\u3002") : null,
      h2("div", { style: { marginTop: 8, fontSize: 10, opacity: 0.5, textAlign: "center" } }, "\u8FD9\u662F agent \u7528\u7684\u540C\u4E00\u6761\u8BF4\u660E\uFF1B\u60F3\u8BA9\u5B83\u505A\u6210\u539F\u751F\u56FE\u5C42\uFF0C\u5728\u5BF9\u8BDD\u91CC\u8BF4\u300C\u628A <id> \u590D\u523B\u6210\u4EE3\u7801\u56FE\u5C42\u300D\u3002")
    )
  );
}
function MotionLibrary({ onInsertMotion }) {
  const [items, setItems] = import_react2.default.useState([]);
  const [q, setQ] = import_react2.default.useState("");
  const [open, setOpen] = import_react2.default.useState(false);
  const [preview, setPreview] = import_react2.default.useState(null);
  const [doc, setDoc] = import_react2.default.useState(null);
  const load = import_react2.default.useCallback(async () => {
    try {
      const result = await rpc("motion.list", { query: q });
      setItems(result.entries || []);
    } catch {
      setItems([]);
    }
  }, [q]);
  import_react2.default.useEffect(() => {
    if (open) load();
  }, [open, load]);
  const native = items.filter((x) => x.native);
  const docs = items.filter((x) => !x.native);
  return h2(
    "div",
    { style: { borderTop: `1px solid ${T.border}`, padding: "8px 10px" } },
    h2(
      "div",
      {
        style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" },
        onClick: () => {
          setPreview(null);
          setOpen((v2) => !v2);
        }
      },
      h2("strong", { style: { fontSize: 12, flex: 1 } }, "\u52A8\u6548\u5E93" + (open ? "\uFF08" + items.length + "\uFF09" : "")),
      h2("span", { style: { fontSize: 10, opacity: 0.45 } }, open ? native.length + " \u539F\u751F \xB7 " + docs.length + " \u8BF4\u660E" : ""),
      h2("span", { style: { fontSize: 11, opacity: 0.5 } }, open ? "\u6536\u8D77" : "\u5C55\u5F00")
    ),
    open ? h2(
      "div",
      { style: { marginTop: 8 } },
      h2("input", {
        type: "search",
        placeholder: "\u641C\u52A8\u6548\u2026",
        value: q,
        onChange: (e) => setQ(e.target.value),
        style: { ...numStyle, width: "100%", marginBottom: 8 }
      }),
      h2(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 6,
            maxHeight: 260,
            overflowY: "auto",
            overflowX: "hidden",
            paddingRight: 4
          }
        },
        native.length || docs.length ? [...native, ...docs].map(
          (item) => h2(MotionRow, {
            key: item.id,
            item,
            onOpen: (entry, code) => setPreview({ item: entry, code }),
            onInsert: onInsertMotion,
            onDoc: (entry) => setDoc(entry)
          })
        ) : h2("div", { style: { fontSize: 11, opacity: 0.5 } }, "\u6CA1\u6709\u5339\u914D\u7684\u6761\u76EE\u3002")
      ),
      h2(
        "div",
        { style: { marginTop: 6, fontSize: 10, opacity: 0.4 } },
        "\u539F\u751F\u53EF\u76F4\u63A5\u63D2\u5165\uFF1B\u8BF4\u660E\u7C7B\u9700\u8981\u5916\u90E8\u811A\u672C\u6E32\u67D3\u6210\u6587\u4EF6\u518D\u5BFC\u5165\u3002"
      )
    ) : null,
    preview ? h2(MotionPreview, { item: preview.item, code: preview.code, onClose: () => setPreview(null) }) : null,
    doc ? h2(MotionDoc, { item: doc, onClose: () => setDoc(null) }) : null
  );
}
var SOUND_SOURCE_LABEL = { local: "\u672C\u5730", freesound: "Freesound" };
function soundSourceLabel(provider) {
  return SOUND_SOURCE_LABEL[provider] || String(provider || "\u672A\u77E5");
}
function soundDurationText(duration, exact) {
  const n = Number(duration);
  if (!Number.isFinite(n) || n <= 0) return "\u65F6\u957F\u672A\u77E5";
  return (exact === false ? "\u2248" : "") + n.toFixed(1) + "s";
}
function soundPreviewPlan(entry, preview) {
  const kind = preview && preview.kind;
  const url2 = preview && preview.url;
  if (kind === "url" && url2) {
    return { playable: true, kind: "url", url: String(url2), title: "\u8BD5\u542C\u8FD9\u6761\u97F3\u6548" };
  }
  return { playable: false, kind: kind || "unknown", url: "", title: "\u8FD9\u6761\u97F3\u6548\u6682\u4E0D\u652F\u6301\u8BD5\u542C" };
}
var SOUND_ERROR_HINT = {
  NO_API_KEY: "\u672A\u914D\u7F6E FREESOUND_API_KEY\uFF1A\u5148\u5728\u7EC8\u7AEF setx \u518D\u91CD\u542F DSH",
  NETWORK: "\u8FDE\u4E0D\u4E0A freesound.org",
  DOWNLOAD_FAILED: "\u97F3\u6548\u4E0B\u8F7D\u5931\u8D25",
  NOT_FOUND: "\u58F0\u97F3\u5E93\u91CC\u6CA1\u6709\u8FD9\u4E2A\u6761\u76EE\uFF08\u5728\u7EBF\u6761\u76EE\u8981\u5148\u641C\u4E00\u6B21\uFF09",
  INVALID_ARG: "\u53C2\u6570\u4E0D\u5408\u6CD5"
};
var SOUND_ERROR_MAX = 120;
var SOUND_EMPTY_LOCAL_TEXT = "\u672C\u5730\u5E93\u91CC\u8FD8\u6CA1\u6709\u97F3\u6548\uFF1A\u53BB\u4E0B\u9762\u300C\u83B7\u53D6\u97F3\u6548\u5305\u300D\u4E0B\u8F7D\uFF0C\u6216\u7528\u4E0A\u9762\u7684\u94FE\u63A5\u5BFC\u5165\u3002";
function soundErrorText(e) {
  const code = e && e.code ? String(e.code) : "";
  const raw = String(e && e.message || "\u672A\u77E5\u9519\u8BEF").trim() || "\u672A\u77E5\u9519\u8BEF";
  const hint = code ? SOUND_ERROR_HINT[code] : "";
  if (hint) return code + " \xB7 " + hint;
  return raw.length > SOUND_ERROR_MAX ? raw.slice(0, SOUND_ERROR_MAX) + "\u2026" : raw;
}
function soundEmptyReason({ source, query, entries, maxDuration } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length) return "";
  if (source === "freesound") return "";
  if (String(query == null ? "" : query).trim()) return "";
  if (typeof maxDuration === "number" && Number.isFinite(maxDuration) && maxDuration > 0) return "";
  return SOUND_EMPTY_LOCAL_TEXT;
}
function SoundRow({ entry, previewing, previewUrl, note, inserting, onPreview, onInsert }) {
  const blocked = typeof note === "string" && note ? note : "";
  const credit = [entry.license, entry.attribution].filter(Boolean).join(" \xB7 ");
  const tags = Array.isArray(entry.tags) ? entry.tags.filter(Boolean) : [];
  return h2(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "5px 7px",
        borderRadius: 8,
        border: `1px solid ${T.border}`,
        background: T.fill
      }
    },
    h2(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
      h2(
        "span",
        {
          title: entry.title || entry.id,
          style: { flex: 1, minWidth: 0, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
        },
        entry.title || entry.id
      ),
      chip(soundSourceLabel(entry.provider))
    ),
    h2(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 10, opacity: 0.5, minWidth: 0 } },
      h2("span", { style: { flex: "0 0 auto" } }, soundDurationText(entry.duration, entry.durationExact)),
      tags.length ? h2(
        "span",
        {
          title: tags.join("\u3001"),
          style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
        },
        tags.slice(0, 3).join(" \xB7 ")
      ) : null
    ),
    credit ? h2(
      "div",
      {
        title: credit,
        style: { fontSize: 10, opacity: 0.38, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
      },
      credit
    ) : null,
    h2(
      "div",
      { style: { display: "flex", gap: 6 } },
      h2(
        "button",
        {
          type: "button",
          disabled: !!blocked,
          title: blocked || (previewing ? "\u6536\u8D77\u8BD5\u542C" : "\u8BD5\u542C\u8FD9\u6761\u97F3\u6548"),
          onClick: () => onPreview(entry),
          style: {
            ...btnStyle,
            padding: "2px 8px",
            opacity: blocked ? 0.4 : 1,
            cursor: blocked ? "not-allowed" : "pointer"
          }
        },
        previewing ? "\u6536\u8D77" : "\u8BD5\u542C"
      ),
      h2(
        "button",
        {
          type: "button",
          disabled: !!inserting,
          title: "\u63D2\u5165\u5230\u5F53\u524D\u64AD\u653E\u5934",
          onClick: () => onInsert(entry),
          style: { ...btnStyle, padding: "2px 8px", opacity: inserting ? 0.5 : 1 }
        },
        inserting ? "\u63D2\u5165\u4E2D\u2026" : "\u63D2\u5165"
      )
    ),
    previewUrl ? h2("audio", { controls: true, src: previewUrl, style: { width: "100%", height: 30 } }) : null
  );
}
function SoundLibrary({ projectId, sessionId, playhead, onInserted, defaultOpen, defaultSource }) {
  const [open, setOpen] = import_react2.default.useState(!!defaultOpen);
  const [q, setQ] = import_react2.default.useState("");
  const [source, setSource] = import_react2.default.useState(defaultSource || "all");
  const [sort, setSort] = import_react2.default.useState("blend");
  const [maxDuration, setMaxDuration] = import_react2.default.useState("");
  const [entries, setEntries] = import_react2.default.useState([]);
  const [warnings, setWarnings] = import_react2.default.useState([]);
  const [searched, setSearched] = import_react2.default.useState(false);
  const [loading, setLoading] = import_react2.default.useState(false);
  const [unavailable, setUnavailable] = import_react2.default.useState("");
  const [emptyHint, setEmptyHint] = import_react2.default.useState("");
  const [preview, setPreview] = import_react2.default.useState(null);
  const [notes, setNotes] = import_react2.default.useState({});
  const [inserting, setInserting] = import_react2.default.useState("");
  const [importUrl, setImportUrl] = import_react2.default.useState("");
  const [importing, setImporting] = import_react2.default.useState(false);
  const [kenneyOpen, setKenneyOpen] = import_react2.default.useState(false);
  const [kenneyPacks, setKenneyPacks] = import_react2.default.useState([]);
  const [kenneyReason, setKenneyReason] = import_react2.default.useState("");
  const [kenneyLoading, setKenneyLoading] = import_react2.default.useState(false);
  const [kenneyBusy, setKenneyBusy] = import_react2.default.useState("");
  const [kenneyMsg, setKenneyMsg] = import_react2.default.useState("");
  const [kenneyElapsed, setKenneyElapsed] = import_react2.default.useState(0);
  const [limit, setLimit] = import_react2.default.useState(20);
  const [total, setTotal] = import_react2.default.useState(0);
  const seq = import_react2.default.useRef(0);
  const search = import_react2.default.useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    const params = { source, sort, limit };
    const text = q.trim();
    if (text) params.query = text;
    const max = Number(maxDuration);
    if (maxDuration !== "" && Number.isFinite(max) && max > 0) params.maxDuration = max;
    try {
      const result = await rpc("sound.search", params);
      if (my !== seq.current) return;
      const list = Array.isArray(result && result.entries) ? result.entries : [];
      setEntries(list);
      setTotal(Number.isFinite(result && result.total) ? result.total : list.length);
      setWarnings(Array.isArray(result && result.warnings) ? result.warnings : []);
      setNotes({});
      setUnavailable("");
      setEmptyHint(
        soundEmptyReason({ source, query: text, entries: list, maxDuration: params.maxDuration })
      );
    } catch (e) {
      if (my !== seq.current) return;
      setEntries([]);
      setWarnings([]);
      setEmptyHint("");
      setUnavailable(soundErrorText(e));
      reportError(e, "\u97F3\u6548\u5E93\u64CD\u4F5C\u5931\u8D25");
    } finally {
      if (my === seq.current) {
        setLoading(false);
        setSearched(true);
      }
    }
  }, [q, source, sort, maxDuration, limit]);
  import_react2.default.useEffect(() => {
    setLimit(20);
  }, [q, source, sort, maxDuration]);
  import_react2.default.useEffect(() => {
    if (!open) return void 0;
    const timer = setTimeout(() => {
      search();
    }, 250);
    return () => clearTimeout(timer);
  }, [open, search]);
  async function previewEntry(entry) {
    if (notes && notes[entry.id]) return;
    if (preview && preview.entryId === entry.id) {
      setPreview(null);
      return;
    }
    try {
      const value = await rpc("sound.preview", { entryId: entry.id });
      const plan = soundPreviewPlan(entry, value);
      if (!plan.playable) {
        setPreview(null);
        setNotes((m) => ({ ...m, [entry.id]: plan.title }));
        toast(plan.title, "warn");
        return;
      }
      setPreview({ entryId: entry.id, url: plan.url });
    } catch (e) {
      setPreview(null);
      setNotes((m) => ({ ...m, [entry.id]: soundErrorText(e) }));
      reportError(e, "\u8BD5\u542C\u5931\u8D25");
    }
  }
  async function insertEntry(entry) {
    if (inserting) return;
    setInserting(entry.id);
    try {
      await rpc("sound.insert", {
        projectId,
        sessionId,
        entryId: entry.id,
        start: Number.isFinite(playhead) ? playhead : 0
      });
      await refresh();
      toast("\u5DF2\u63D2\u5165\u97F3\u6548\uFF1A" + (entry.title || entry.id));
      if (onInserted) onInserted(entry);
    } catch (e) {
      reportError(e, "\u97F3\u6548\u5E93\u64CD\u4F5C\u5931\u8D25");
    } finally {
      setInserting("");
    }
  }
  import_react2.default.useEffect(() => {
    if (!kenneyBusy) {
      setKenneyElapsed(0);
      return void 0;
    }
    const started = Date.now();
    setKenneyElapsed(0);
    const timer = setInterval(() => setKenneyElapsed(Math.round((Date.now() - started) / 1e3)), 1e3);
    return () => clearInterval(timer);
  }, [kenneyBusy]);
  async function importFromUrl() {
    const url2 = importUrl.trim();
    if (!url2 || importing) return;
    setImporting(true);
    try {
      const value = await rpc("sound.import", { url: url2 });
      const entry = value && value.entry ? value.entry : value;
      await refresh();
      toast("\u5DF2\u5BFC\u5165\u97F3\u6548\uFF1A" + (entry && (entry.title || entry.id) || url2));
      setImportUrl("");
      await search();
    } catch (e) {
      reportError(e, "\u5BFC\u5165\u97F3\u6548\u5931\u8D25");
    } finally {
      setImporting(false);
    }
  }
  async function loadKenney() {
    setKenneyLoading(true);
    try {
      const value = await rpc("sound.kenney.list", {});
      setKenneyPacks(Array.isArray(value && value.packs) ? value.packs : []);
      setKenneyReason(value && value.reason || "");
    } catch (e) {
      setKenneyPacks([]);
      setKenneyReason("\u8BFB\u53D6\u8D44\u6E90\u5305\u5217\u8868\u5931\u8D25\uFF1A" + soundErrorText(e));
    } finally {
      setKenneyLoading(false);
    }
  }
  async function toggleKenney() {
    const next = !kenneyOpen;
    setKenneyOpen(next);
    if (!next) return;
    setKenneyMsg("");
    await loadKenney();
  }
  async function installPack(pack) {
    if (kenneyBusy) return;
    setKenneyBusy(pack.url);
    setKenneyMsg("");
    try {
      const value = await rpc("sound.kenney.install", { packUrl: pack.url });
      if (value && value.installed) {
        setKenneyMsg(`\u5DF2\u5B89\u88C5\u300C${pack.title}\u300D\uFF1A${value.files} \u4E2A\u97F3\u9891\u6587\u4EF6 \u2192 ${value.root}`);
        toast("\u5DF2\u4E0B\u8F7D\u97F3\u6548\u5305\uFF1A" + pack.title);
        await Promise.all([search(), loadKenney()]);
      } else {
        const reason = value && value.reason || "\u4E0B\u8F7D\u5B8C\u6210\u4F46\u6CA1\u6709\u89E3\u538B\u6210\u529F";
        const zip = value && value.zipPath ? "\uFF08zip \u5DF2\u4FDD\u5B58\u5230 " + value.zipPath + "\uFF09" : "";
        setKenneyMsg("\u9700\u8981\u624B\u52A8\u89E3\u538B\uFF1A" + reason + zip);
        toast("\u97F3\u6548\u5305\u5DF2\u4E0B\u8F7D\uFF0C\u4F46\u9700\u8981\u624B\u52A8\u89E3\u538B", "warn");
      }
    } catch (e) {
      setKenneyMsg("\u4E0B\u8F7D\u5931\u8D25\uFF1A" + soundErrorText(e));
      reportError(e, "\u4E0B\u8F7D\u97F3\u6548\u5305\u5931\u8D25");
    } finally {
      setKenneyBusy("");
    }
  }
  const showSort = source === "freesound" || source === "all" && entries.some((e) => e && e.provider === "freesound");
  return h2(
    "div",
    { style: { borderTop: `1px solid ${T.border}`, padding: "8px 10px" } },
    h2(
      "div",
      {
        style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" },
        onClick: () => {
          setPreview(null);
          setOpen((v2) => !v2);
        }
      },
      h2("strong", { style: { fontSize: 12, flex: 1 } }, "\u97F3\u6548\u5E93" + (open && searched ? "\uFF08" + entries.length + "\uFF09" : "")),
      h2("span", { style: { fontSize: 10, opacity: 0.45 } }, open && warnings.length ? warnings.length + " \u6761\u63D0\u793A" : ""),
      h2("span", { style: { fontSize: 11, opacity: 0.5 } }, open ? "\u6536\u8D77" : "\u5C55\u5F00")
    ),
    open ? h2(
      "div",
      { style: { marginTop: 8, display: "flex", flexDirection: "column", gap: 6 } },
      // URL 导入：粘贴直链，宿主负责下载、校验与按域名归档
      h2(
        "div",
        { style: { display: "flex", gap: 6 } },
        h2("input", {
          type: "url",
          placeholder: "\u7C98\u8D34\u97F3\u6548\u76F4\u94FE\uFF08http/https\uFF09\u2026",
          value: importUrl,
          onChange: (e) => setImportUrl(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              importFromUrl();
            }
          },
          style: { ...numStyle, flex: 1, minWidth: 0 }
        }),
        h2(
          "button",
          {
            type: "button",
            disabled: importing,
            title: "\u4ECE\u76F4\u94FE\u4E0B\u8F7D\u4E00\u6761\u97F3\u6548\u5230\u672C\u5730\u58F0\u97F3\u5E93\uFF0815 \u79D2\u8D85\u65F6 / 50MB \u4E0A\u9650\uFF09",
            onClick: importFromUrl,
            style: { ...btnStyle, whiteSpace: "nowrap", opacity: importing ? 0.5 : 1 }
          },
          importing ? "\u5BFC\u5165\u4E2D\u2026" : "\u5BFC\u5165\u94FE\u63A5"
        )
      ),
      h2("input", {
        type: "search",
        placeholder: "\u641C\u97F3\u6548\u2026",
        value: q,
        onChange: (e) => setQ(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            search();
          }
        },
        style: { ...numStyle, width: "100%" }
      }),
      h2(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
        h2(
          "select",
          {
            value: source,
            onChange: (e) => setSource(e.target.value),
            title: "\u97F3\u6548\u6765\u6E90",
            style: { ...numStyle, width: 92, padding: "3px 4px" }
          },
          [
            ["all", "\u5168\u90E8"],
            ["local", "\u672C\u5730"],
            ["freesound", "Freesound"]
          ].map(([v2, label]) => h2("option", { key: v2, value: v2 }, label))
        ),
        // 排序只作用于 Freesound：纯本地或「全部但没带回在线结果」时不给这个入口
        showSort ? h2(
          "select",
          {
            value: sort,
            onChange: (e) => setSort(e.target.value),
            title: "Freesound \u6392\u5E8F\u65B9\u5F0F\uFF08\u4E0D\u5F71\u54CD\u672C\u5730\u7ED3\u679C\uFF09",
            style: { ...numStyle, width: 78, padding: "3px 4px" }
          },
          [
            ["blend", "\u7EFC\u5408"],
            ["rating", "\u8BC4\u5206"],
            ["downloads", "\u4E0B\u8F7D\u91CF"]
          ].map(([v2, label]) => h2("option", { key: v2, value: v2 }, label))
        ) : null,
        h2("input", {
          type: "number",
          min: 0,
          step: 0.5,
          placeholder: "\u6700\u957F\u65F6\u957F",
          title: "\u53EA\u663E\u793A\u4E0D\u8D85\u8FC7\u8FD9\u4E2A\u79D2\u6570\u7684\u97F3\u6548\uFF08\u7559\u7A7A\u4E0D\u9650\uFF09",
          value: maxDuration,
          onChange: (e) => setMaxDuration(e.target.value),
          style: { ...numStyle, width: 82 }
        }),
        h2("span", { style: { fontSize: 10, opacity: 0.4 } }, "\u79D2")
      ),
      warnings.length ? h2("div", { style: { fontSize: 10, opacity: 0.55, lineHeight: 1.5 } }, warnings.join("\uFF1B")) : null,
      unavailable ? h2("div", { style: { fontSize: 10, opacity: 0.6, lineHeight: 1.5 } }, unavailable) : null,
      h2(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 6,
            maxHeight: 260,
            overflowY: "auto",
            overflowX: "hidden",
            paddingRight: 4
          }
        },
        entries.length ? entries.map(
          (entry) => h2(SoundRow, {
            key: entry.id,
            entry,
            previewing: !!(preview && preview.entryId === entry.id && preview.url),
            previewUrl: preview && preview.entryId === entry.id ? preview.url || "" : "",
            note: notes && notes[entry.id] || "",
            inserting: inserting === entry.id,
            onPreview: previewEntry,
            onInsert: insertEntry
          })
        ) : h2(
          "div",
          { style: { fontSize: 11, opacity: 0.5, lineHeight: 1.5 } },
          loading || !searched ? "\u641C\u7D22\u4E2D\u2026" : unavailable ? "\u641C\u7D22\u5931\u8D25\uFF0C\u539F\u56E0\u89C1\u4E0A\u65B9\u3002" : emptyHint || "\u6CA1\u6709\u5339\u914D\u7684\u97F3\u6548\u3002"
        )
      ),
      total > entries.length ? h2(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8, paddingTop: 4 } },
        h2(
          "span",
          { style: { fontSize: 10, opacity: 0.5 } },
          `\u5171 ${total} \u6761\uFF0C\u663E\u793A\u524D ${entries.length} \u6761`
        ),
        h2(
          "button",
          {
            type: "button",
            onClick: () => setLimit((v2) => Math.min(200, v2 + 40)),
            style: { ...btnStyle, padding: "2px 8px", fontSize: 10 }
          },
          "\u52A0\u8F7D\u66F4\u591A"
        )
      ) : h2(
        "div",
        { style: { fontSize: 10, opacity: 0.4, paddingTop: 4 } },
        searched && entries.length ? `\u5171 ${total} \u6761\uFF0C\u5DF2\u5168\u90E8\u663E\u793A` : ""
      ),
      // 获取音效包：点开才请求清单，避免每次展开面板都打网络
      h2(
        "div",
        { style: { borderTop: `1px solid ${T.border}`, paddingTop: 6 } },
        h2(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }, onClick: toggleKenney },
          h2("strong", { style: { fontSize: 11, flex: 1 } }, "\u83B7\u53D6\u97F3\u6548\u5305"),
          h2("span", { style: { fontSize: 10, opacity: 0.45 } }, kenneyOpen ? "" : "kenney.nl \xB7 CC0"),
          h2("span", { style: { fontSize: 10, opacity: 0.5 } }, kenneyOpen ? "\u6536\u8D77" : "\u5C55\u5F00")
        ),
        kenneyOpen ? h2(
          "div",
          { style: { marginTop: 6, display: "flex", flexDirection: "column", gap: 4 } },
          kenneyLoading ? h2("div", { style: { fontSize: 10, opacity: 0.5 } }, "\u8BFB\u53D6\u8D44\u6E90\u5305\u5217\u8868\u2026") : kenneyPacks.length ? h2(
            "div",
            {
              style: {
                display: "flex",
                flexDirection: "column",
                gap: 4,
                maxHeight: 180,
                overflowY: "auto",
                overflowX: "hidden",
                paddingRight: 4
              }
            },
            kenneyPacks.map(
              (pack) => h2(
                "div",
                { key: pack.url, style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11 } },
                h2(
                  "span",
                  {
                    title: pack.title,
                    style: {
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap"
                    }
                  },
                  pack.title
                ),
                pack.installed ? h2(
                  "span",
                  {
                    title: "\u8BE5\u5305\u5DF2\u89E3\u538B\u5230\u672C\u5730\u5E93",
                    style: { fontSize: 10, opacity: 0.55, flex: "0 0 auto" }
                  },
                  `\u5DF2\u5B89\u88C5 ${pack.files || ""}`.trim()
                ) : null,
                h2(
                  "button",
                  {
                    type: "button",
                    disabled: !!kenneyBusy,
                    title: "\u4E0B\u8F7D\u5E76\u89E3\u538B\u5230\u58F0\u97F3\u5E93\u6839\u76EE\u5F55",
                    onClick: () => installPack(pack),
                    style: {
                      ...btnStyle,
                      padding: "2px 8px",
                      flex: "0 0 auto",
                      opacity: kenneyBusy && kenneyBusy !== pack.url ? 0.45 : 1
                    }
                  },
                  kenneyBusy === pack.url ? "\u4E0B\u8F7D\u4E2D\u2026" : "\u4E0B\u8F7D"
                )
              )
            )
          ) : h2(
            "div",
            { style: { fontSize: 10, opacity: 0.5, lineHeight: 1.5 } },
            kenneyReason || "\u6CA1\u6709\u53EF\u4E0B\u8F7D\u7684\u97F3\u6548\u5305\u3002"
          ),
          kenneyBusy ? h2(
            "div",
            { style: { fontSize: 10, opacity: 0.55 } },
            "\u6B63\u5728\u4E0B\u8F7D\u5E76\u89E3\u538B\u2026 " + kenneyElapsed + "s\uFF08\u5927\u5305\u53EF\u80FD\u9700\u8981\u51E0\u5341\u79D2\uFF09"
          ) : null,
          kenneyMsg ? h2("div", { style: { fontSize: 10, opacity: 0.55, lineHeight: 1.5 } }, kenneyMsg) : null
        ) : null
      ),
      h2(
        "div",
        { style: { fontSize: 10, opacity: 0.4, lineHeight: 1.5 } },
        "\u63D2\u5165\u5230\u5F53\u524D\u64AD\u653E\u5934\uFF1B\u70B9\u300C\u8BD5\u542C\u300D\u5C31\u5730\u64AD\u653E\uFF0C\u672C\u5730\u4E0E\u5728\u7EBF\u97F3\u6E90\u90FD\u652F\u6301\u3002"
      )
    ) : null
  );
}
function isVideoAsset2(asset) {
  return assetKind(asset) === KIND.VIDEO;
}
function isAudioAsset2(asset) {
  return assetKind(asset) === KIND.AUDIO;
}
function analysisFor(analysis, asset) {
  if (!analysis || analysis.ok !== true) return null;
  if (analysis.assetId && analysis.assetId === asset.id) return analysis;
  if (analysis.assetPath && analysis.assetPath === asset.path) return analysis;
  const file = analysis.meta && analysis.meta.file ? String(analysis.meta.file) : "";
  if (file && asset.name && file.split(/[\\/]/).pop() === asset.name) return analysis;
  return null;
}
function colorHex(color) {
  if (!color) return null;
  const hex = (v2) => Math.max(0, Math.min(255, Math.round(Number(v2) || 0))).toString(16).padStart(2, "0");
  return "#" + hex(color.r) + hex(color.g) + hex(color.b);
}
function analysisSummary(doc) {
  const stats = doc.stats || {};
  const palette = (stats.colorPalette || [])[0];
  const count = stats.shotCount || 0;
  const avg = Number(stats.avgShot || 0);
  const avgText = avg >= 10 ? avg.toFixed(0) : avg.toFixed(1);
  const paceText = doc.pace === "fast" ? "\u5FEB\u5207" : doc.pace === "slow" ? "\u6162\u5207" : "\u4E2D\u901F";
  return `${count} \u955C \xB7 \u5E73\u5747 ${avgText}s \xB7 ${paceText} \xB7 \u4E3B\u8272 ${palette && palette.hex ? palette.hex : "\u672A\u77E5"}`;
}
var shotGrid = {
  display: "grid",
  gridTemplateColumns: "26px 1fr 46px 16px",
  gap: 6,
  alignItems: "center",
  fontSize: 10,
  lineHeight: 1.7
};
function shotSwatch(color) {
  const hex = colorHex(color);
  return {
    width: 12,
    height: 12,
    borderRadius: 3,
    background: hex || "transparent",
    border: `1px solid ${T.border}`,
    display: "inline-block"
  };
}
var secText = (value) => Number(value || 0).toFixed(2);
function shotTableSummary(doc) {
  const stats = doc && doc.stats || {};
  const count = stats.shotCount || (doc && Array.isArray(doc.shots) ? doc.shots.length : 0);
  const avg = Number(stats.avgShot || 0);
  return `\u955C\u5934\u8868 \xB7 ${count} \u955C \xB7 \u5E73\u5747 ${avg.toFixed(2)}s`;
}
var assetCardStyle = {
  border: `1px solid ${T.border}`,
  borderRadius: 10,
  padding: "8px 10px",
  fontSize: 12,
  background: `linear-gradient(180deg, ${T.fill}, transparent)`
};
function MediaBin({ assets, onInsert, onInsertPip, onInsertAudio, onImported }) {
  const inputRef = import_react2.default.useRef(null);
  const [dragOver, setDragOver] = import_react2.default.useState(false);
  const [analysis, setAnalysis] = import_react2.default.useState(null);
  const [analysisError, setAnalysisError] = import_react2.default.useState(null);
  const [running, setRunning] = import_react2.default.useState(null);
  const [expandedId, setExpandedId] = import_react2.default.useState(null);
  const [probes, setProbes] = import_react2.default.useState({});
  const probeRef = import_react2.default.useRef(/* @__PURE__ */ new Set());
  const [pending4, setPending] = import_react2.default.useState(null);
  const [applying, setApplying] = import_react2.default.useState(null);
  const [viewAsset, setViewAsset] = import_react2.default.useState(null);
  const alive = import_react2.default.useRef(true);
  const tickRef = import_react2.default.useRef(null);
  import_react2.default.useEffect(
    () => () => {
      alive.current = false;
      if (tickRef.current) clearInterval(tickRef.current);
    },
    []
  );
  import_react2.default.useEffect(() => {
    if (!state.projectId) return void 0;
    let cancelled = false;
    (async () => {
      try {
        const value = await rpc("analyze.read", { projectId: state.projectId, sessionId: state.sessionId });
        if (!cancelled && value && value.ok === true) setAnalysis(value);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.projectId]);
  function stopTimer() {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    setRunning(null);
  }
  async function analyze(asset) {
    if (running) return;
    const startedAt = Date.now();
    setAnalysisError(null);
    setRunning({ assetId: asset.id, seconds: 0 });
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      if (!alive.current) return;
      setRunning((cur) => cur ? { ...cur, seconds: Math.round((Date.now() - startedAt) / 1e3) } : cur);
    }, 1e3);
    try {
      const value = await rpc("analyze.run", {
        projectId: state.projectId,
        sessionId: state.sessionId,
        assetPath: asset.path
      });
      if (!alive.current) return;
      setAnalysis(value);
      setExpandedId(null);
      toast(
        value.cached ? `\u5DF2\u89E3\u6790\u8FC7\uFF08\u6E90\u6587\u4EF6\u6CA1\u53D8\uFF09\uFF0C\u76F4\u63A5\u590D\u7528\uFF1A${value.stats && value.stats.shotCount || 0} \u955C` : `\u89E3\u6790\u5B8C\u6210\uFF1A${value.stats && value.stats.shotCount || 0} \u4E2A\u955C\u5934`
      );
    } catch (e) {
      if (!alive.current) return;
      setAnalysisError({ assetId: asset.id, message: e && e.message || "\u89E3\u6790\u5931\u8D25" });
      reportError(e, "\u89E3\u6790\u5931\u8D25");
    } finally {
      if (alive.current) stopTimer();
      else if (tickRef.current) clearInterval(tickRef.current);
    }
  }
  async function probeCodec(asset) {
    try {
      const url2 = "/api/video/probe?projectId=" + encodeURIComponent(state.projectId) + "&assetId=" + encodeURIComponent(asset.id);
      const res = await fetch(url2);
      const data = await res.json().catch(() => null);
      if (!alive.current) return;
      if (!data || data.ok !== true) {
        setProbes((prev) => ({
          ...prev,
          [asset.id]: {
            ok: false,
            // PROJECT_NOT_OPEN 是「工程未加载」的正常状态，不是错误，渲染时走灰色小字
            code: data && data.code || "",
            reason: data && data.reason || "\u63A2\u6D4B\u5931\u8D25"
          }
        }));
        return;
      }
      setProbes((prev) => ({ ...prev, [asset.id]: { ok: true, probe: data.probe || {}, advice: data.advice || null } }));
    } catch (e) {
      if (!alive.current) return;
      setProbes((prev) => ({ ...prev, [asset.id]: { ok: false, reason: e && e.message || "\u63A2\u6D4B\u5931\u8D25" } }));
    }
  }
  import_react2.default.useEffect(() => {
    if (!state.projectId) return;
    for (const a of assets || []) {
      if (!isVideoAsset2(a)) continue;
      if (!a.probe || a.probe.width > 0 || a.probe.codec) continue;
      if (probeRef.current.has(a.id)) continue;
      probeRef.current.add(a.id);
      probeCodec(a);
    }
  }, [assets, state.projectId]);
  async function applyRef(asset, kind) {
    if (applying) return;
    setApplying(asset.id);
    try {
      const value = await rpc("reference.apply", {
        projectId: state.projectId,
        sessionId: state.sessionId,
        assetId: asset.id,
        baseRevision: state.doc ? state.doc.revision : void 0
      });
      setPending(null);
      await refresh();
      toast(
        `\u5DF2\u5907\u4EFD\u539F\u7247\uFF1A${value.backedUpTo}${value.backupReused ? "\uFF08\u590D\u7528\u5DF2\u6709\u5907\u4EFD\uFF09" : ""} \xB7 \u9884\u89C8\u6539\u8D70\u5907\u4EFD`,
        "info"
      );
    } catch (e) {
      reportError(e, "\u5907\u4EFD\u539F\u7247\u5931\u8D25");
    } finally {
      if (alive.current) setApplying(null);
    }
  }
  function renderConfirm(asset, kind) {
    return h2(
      "div",
      {
        style: {
          marginTop: 6,
          padding: 8,
          borderRadius: 8,
          border: `1px solid ${T.warn}`,
          background: T.warnDim,
          fontSize: 11,
          lineHeight: 1.6
        }
      },
      h2(
        "div",
        null,
        kind === "rebuild" ? "\u4F1A\u6309\u5F53\u524D\u955C\u5934\u8868\u91CD\u5EFA\u9AA8\u67B6\uFF08\u65E7\u9AA8\u67B6\u5148\u5220\u540E\u63D2\uFF09\uFF1B\u539F\u7247\u5DF2\u5907\u4EFD\u8FC7\u5C31\u590D\u7528\uFF0C\u4E0D\u518D\u590D\u5236\u3002\u4E00\u6B21\u4E8B\u52A1\uFF0C\u53EF\u64A4\u9500\u3002" : "\u4F1A\u5148\u5907\u4EFD\u539F\u7247\u5230 reference/\uFF0C\u518D\u4ECE\u8F68\u9053\u4E0A\u79FB\u9664\u5B83\u7684\u7247\u6BB5\u3001\u6807\u8BB0\u4E3A\u53EA\u8BFB\u53C2\u8003\uFF0C\u5E76\u6309\u955C\u5934\u8868\u5EFA\u9AA8\u67B6\u3002\u4E00\u6B21\u4E8B\u52A1\uFF0C\u53EF\u64A4\u9500\u3002"
      ),
      h2(
        "div",
        { style: { display: "flex", gap: 6, marginTop: 6 } },
        h2(
          "button",
          {
            type: "button",
            disabled: applying === asset.id,
            style: { ...btnStyle, background: T.warnDim, borderColor: T.warn, color: T.warn },
            onClick: () => applyRef(asset, kind)
          },
          applying === asset.id ? "\u5904\u7406\u4E2D\u2026" : "\u786E\u8BA4"
        ),
        h2("button", { type: "button", style: btnStyle, onClick: () => setPending(null) }, "\u53D6\u6D88")
      )
    );
  }
  function renderProbeInfo(asset) {
    const info = probes[asset.id];
    if (!info) return null;
    if (info.ok === false) {
      const soft = info.code === "PROJECT_NOT_OPEN";
      return h2(
        "div",
        {
          style: {
            marginTop: 4,
            fontSize: 11,
            color: soft ? T.textDim : T.warn,
            opacity: soft ? 0.6 : 1,
            lineHeight: 1.5
          }
        },
        (soft ? "\u5DE5\u7A0B\u672A\u52A0\u8F7D\uFF0C\u6682\u65F6\u6CA1\u63A2\u6D4B\u7F16\u7801\uFF1A" : "\u7F16\u7801\u63A2\u6D4B\u5931\u8D25\uFF1A") + info.reason
      );
    }
    const probe2 = info.probe || {};
    const codec = probe2.codec || "?";
    const profile = probe2.profile || "?";
    const pix = probe2.pixFmt || probe2.pix_fmt || "?";
    return h2(
      "div",
      { style: { marginTop: 4, fontSize: 11, lineHeight: 1.6 } },
      h2("div", { style: { color: T.warn } }, `\u7F16\u7801 ${codec} \xB7 ${profile} \xB7 ${pix}`),
      info.advice ? h2(
        "div",
        { style: { marginTop: 2, color: T.danger } },
        h2("div", null, info.advice.text),
        h2(
          "code",
          {
            style: {
              display: "block",
              marginTop: 3,
              padding: "4px 6px",
              borderRadius: 5,
              background: T.fill,
              fontSize: 10.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all"
            }
          },
          info.advice.command
        )
      ) : null
    );
  }
  function renderShotTable(assetId, shots) {
    const rows = shots.slice(0, 20).map(
      (shot) => h2(
        "div",
        { key: "shot-" + shot.index, style: shotGrid },
        h2("span", { style: { opacity: 0.5 } }, String(shot.index)),
        h2("span", null, `${secText(shot.start)}\u2013${secText(shot.end)}`),
        h2("span", { style: { opacity: 0.7 } }, `${secText(shot.duration)}s`),
        h2("span", { title: colorHex(shot.color) || "\u65E0\u4EE3\u8868\u8272", style: shotSwatch(shot.color) })
      )
    );
    return h2(
      "div",
      { key: "shots-" + assetId, style: { marginTop: 4, borderTop: `1px dashed ${T.border}`, paddingTop: 4 } },
      h2(
        "div",
        { style: { ...shotGrid, opacity: 0.4 } },
        h2("span", null, "\u5E8F\u53F7"),
        h2("span", null, "\u8D77\u6B62"),
        h2("span", null, "\u65F6\u957F"),
        h2("span", null, "\u8272")
      ),
      rows,
      shots.length > 20 ? h2("div", { style: { fontSize: 10, opacity: 0.4, marginTop: 2 } }, `\u8FD8\u6709 ${shots.length - 20} \u6761\u672A\u663E\u793A`) : null
    );
  }
  function renderAnalysis(asset) {
    const own = analysisFor(analysis, asset);
    const err = analysisError && analysisError.assetId === asset.id ? analysisError.message : "";
    if (!own && !err) return null;
    const nodes = [];
    if (err) {
      nodes.push(
        h2(
          "div",
          { key: "err", style: { marginTop: 6, fontSize: 10, color: T.warn, lineHeight: 1.55, whiteSpace: "pre-wrap" } },
          "\u89E3\u6790\u5931\u8D25\uFF1A" + err
        )
      );
    }
    if (own) {
      nodes.push(
        h2("div", { key: "sum", style: { marginTop: 6, fontSize: 10, color: T.ok, lineHeight: 1.5 } }, analysisSummary(own))
      );
      if (own.hint) {
        nodes.push(h2("div", { key: "hint", style: { fontSize: 10, opacity: 0.45, lineHeight: 1.5 } }, own.hint));
      }
      const shots = Array.isArray(own.shots) ? own.shots : [];
      if (shots.length) {
        const open = expandedId === asset.id;
        nodes.push(
          h2(
            "div",
            {
              key: "toggle",
              onClick: () => setExpandedId(open ? null : asset.id),
              style: { marginTop: 4, fontSize: 10, opacity: 0.55, cursor: "pointer", userSelect: "none" }
            },
            open ? "\u6536\u8D77\u955C\u5934\u8868" : `\u5C55\u5F00\u955C\u5934\u8868\uFF08\u524D ${Math.min(20, shots.length)} \u6761\uFF09`
          )
        );
        if (open) nodes.push(renderShotTable(asset.id, shots));
      }
    }
    return h2("div", { key: "analysis", style: { marginTop: 2 } }, nodes);
  }
  async function handleFiles(files) {
    if (!files || !files.length) return;
    for (const file of files) {
      try {
        state.busy = { label: `\u5BFC\u5165 ${file.name}`, ratio: 0.3 };
        const asset = await uploadFile(file, () => {
        });
        toast(`\u5DF2\u5BFC\u5165 ${asset.name}`);
      } catch (e) {
        reportError(e, "\u5BFC\u5165\u5931\u8D25");
      } finally {
        state.busy = null;
      }
    }
    await onImported();
  }
  async function rescan() {
    try {
      await scanAssets();
      await onImported();
      toast("\u5DF2\u91CD\u65B0\u626B\u63CF assets \u76EE\u5F55");
    } catch (e) {
      reportError(e, "\u626B\u63CF\u5931\u8D25");
    }
  }
  const normalAssets = (assets || []).filter((a) => a.status !== "reference");
  const referenceAssets = (assets || []).filter((a) => a.status === "reference");
  function renderAssetCard(a) {
    const own = analysisFor(analysis, a);
    const showsTable = !!own;
    const pendingHere = pending4 && pending4.assetId === a.id;
    return h2(
      "div",
      { key: a.id, style: assetCardStyle },
      h2(
        "div",
        { style: { display: "flex", gap: 6, alignItems: "center" } },
        // 解析过以后卡片名字换成镜头表摘要，原始文件名退到 title 提示里
        h2(
          "span",
          { title: a.name, style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
          showsTable ? shotTableSummary(own) : a.name
        ),
        chip(kindLabel(assetKind(a)))
      ),
      h2(
        "div",
        { style: { opacity: 0.6, marginTop: 4, fontSize: 11 } },
        a.probe && a.probe.duration ? `${a.probe.duration.toFixed(2)}s \xB7 ${a.probe.width || "?"}\xD7${a.probe.height || "?"}` : "\u672A\u63A2\u6D4B"
      ),
      // 音频：说清它不进画面，只进 a1 —— 点下去的行为与这句提示必须一致。
      isAudioAsset2(a) ? h2(
        "div",
        { style: { marginTop: 4, fontSize: 11, color: T.ok, lineHeight: 1.5 } },
        "\u97F3\u9891\u7D20\u6750\uFF1A\u4E0D\u53C2\u4E0E\u753B\u9762\u5408\u6210\uFF0C\u53EA\u8FDB\u97F3\u9891\u8F68 a1\u3002"
      ) : null,
      // 有 probe 但解不出宽高 = 浏览器连元数据都没认出来，多半是编码不支持。
      // 这只是「警告」，不影响导入：素材还在，只是预览画不出来。
      isVideoAsset2(a) && a.probe && !(a.probe.width > 0) ? h2(
        "div",
        { style: { marginTop: 4, fontSize: 11, color: T.danger, lineHeight: 1.5 } },
        "\u7F16\u7801\u53EF\u80FD\u4E0D\u53D7\u652F\u6301\uFF1A\u6D4F\u89C8\u5668\u6CA1\u89E3\u51FA\u753B\u9762\u5C3A\u5BF8\uFF08HEVC/H.265\u300110bit\u3001ProRes \u5E38\u89C1\uFF09\u3002"
      ) : null,
      renderProbeInfo(a),
      h2(
        "div",
        { style: { marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" } },
        // 按 kind 分流：策略来自 media-kind.mjs 的 insertPolicy —— 音频只有
        // 「加入音频轨（a1）」一个入口。过去这里对音频也画「加入主轨 / 画中画」，
        // 点下去就把它插进视频轨，而预览池永远不会为音频建 <video>（videoWidth=0）
        // —— 画面永远解不出。
        insertPolicy(a).buttons.includes("audio") ? h2(
          "button",
          {
            type: "button",
            style: btnStyle,
            title: "\u97F3\u9891\u4E0D\u53C2\u4E0E\u753B\u9762\u5408\u6210\uFF1B\u63D2\u5165\u5230\u64AD\u653E\u5934\u5904\u7684 a1 \u97F3\u9891\u8F68",
            onClick: () => (onInsertAudio || onInsert)(a)
          },
          "\u52A0\u5165\u97F3\u9891\u8F68\uFF08a1\uFF09"
        ) : [
          h2("button", { key: "main", type: "button", style: btnStyle, onClick: () => onInsert(a) }, "\u52A0\u5165\u4E3B\u8F68"),
          h2("button", { key: "pip", type: "button", style: btnStyle, onClick: () => onInsertPip && onInsertPip(a) }, "\u753B\u4E2D\u753B")
        ],
        // 只有视频素材才给「解析」；点了才跑，导入时什么都不会发生
        isVideoAsset2(a) ? h2(
          "button",
          {
            type: "button",
            disabled: !!running,
            style: { ...btnStyle, opacity: running ? 0.5 : 1, cursor: running ? "progress" : "pointer" },
            title: "\u89E3\u6790\u955C\u5934\u5207\u70B9\u3001\u6BCF\u955C\u4EE3\u8868\u8272\u4E0E\u8282\u594F\uFF08\u624B\u52A8\u89E6\u53D1\uFF0C\u5BFC\u5165\u65F6\u4E0D\u4F1A\u81EA\u52A8\u8DD1\uFF09",
            onClick: () => analyze(a)
          },
          running && running.assetId === a.id ? `\u89E3\u6790\u4E2D\u2026 ${running.seconds} \u79D2` : showsTable ? "\u5DF2\u89E3\u6790" : "\u89E3\u6790"
        ) : null,
        // 解不出宽高且还没探测过编码 → 手动补一次（自动那条只跑一次）
        isVideoAsset2(a) && a.probe && !(a.probe.width > 0) && !probes[a.id] ? h2("button", { type: "button", style: btnStyle, title: "\u7528 ffprobe \u8BFB codec / profile / pix_fmt\uFF0C\u7ED9\u8F6C\u7801\u5EFA\u8BAE", onClick: () => probeCodec(a) }, "\u63A2\u6D4B\u7F16\u7801") : null,
        // 解析成功后才出现；点了才降级，绝不自动执行（用户要求手动）
        showsTable && isVideoAsset2(a) ? h2(
          "button",
          {
            type: "button",
            style: { ...btnStyle, color: T.warn, borderColor: T.warn },
            disabled: !!applying,
            title: "\u628A\u539F\u7247\u590D\u5236\u5230 reference/ \u5E76\u628A\u9884\u89C8\u6307\u5411\u5907\u4EFD\uFF1B\u539F\u7247\u4ECD\u7559\u5728\u8F68\u9053\u4E0A\u53EF\u7F16\u8F91\uFF08\u4E00\u6B21\u4E8B\u52A1\uFF0C\u53EF\u64A4\u9500\uFF09",
            onClick: () => setPending({ assetId: a.id, kind: "reference" })
          },
          "\u5907\u4EFD\u539F\u7247"
        ) : null
      ),
      pendingHere ? renderConfirm(a, "reference") : renderAnalysis(a)
    );
  }
  function renderReferenceCard(a) {
    const own = analysisFor(analysis, a);
    const pendingHere = pending4 && pending4.assetId === a.id;
    return h2(
      "div",
      {
        key: a.id,
        style: Object.assign({}, assetCardStyle, {
          borderColor: T.borderStrong,
          background: `linear-gradient(180deg, ${T.fill}, transparent)`
        })
      },
      h2(
        "div",
        { style: { display: "flex", gap: 6, alignItems: "center" } },
        h2(
          "span",
          { title: a.name, style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
          own ? shotTableSummary(own) : "\u53C2\u8003 \xB7 \u672A\u89E3\u6790"
        ),
        chip("\u53C2\u8003")
      ),
      h2("div", { style: { opacity: 0.5, marginTop: 4, fontSize: 11, lineHeight: 1.5 } }, a.name + "\uFF08\u53EA\u8BFB\uFF0C\u4E0D\u5728\u65F6\u95F4\u7EBF\u4E0A\uFF09"),
      h2(
        "div",
        { style: { marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" } },
        h2("button", { type: "button", style: btnStyle, onClick: () => setViewAsset(a) }, "\u67E5\u770B\u539F\u7247"),
        h2(
          "button",
          {
            type: "button",
            style: btnStyle,
            disabled: !!applying,
            title: "\u6309\u5F53\u524D\u955C\u5934\u8868\u91CD\u65B0\u94FA\u4E00\u904D\u9AA8\u67B6\uFF08\u65E7\u9AA8\u67B6\u5148\u5220\u540E\u63D2\uFF09",
            onClick: () => setPending({ assetId: a.id, kind: "rebuild" })
          },
          "\u6309\u955C\u5934\u8868\u91CD\u5EFA\u9AA8\u67B6"
        )
      ),
      pendingHere ? renderConfirm(a, "rebuild") : null
    );
  }
  const viewModal = viewAsset ? h2(
    "div",
    {
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: T.mask,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: 20
      }
    },
    h2(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: T.text } },
      h2("span", null, "\u53C2\u8003\u539F\u7247 \xB7 " + viewAsset.name),
      h2("button", { type: "button", style: btnStyle, onClick: () => setViewAsset(null) }, "\u5173\u95ED")
    ),
    h2("video", {
      controls: true,
      src: mediaUrl(viewAsset.id),
      style: { maxWidth: "92%", maxHeight: "76%", background: "#000", borderRadius: 8 }
    })
  ) : null;
  return h2(
    "div",
    { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, position: "relative" } },
    h2(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 10px",
          borderBottom: `1px solid ${T.border}`,
          fontSize: 12
        }
      },
      h2("strong", { style: { flex: 1 } }, "\u7D20\u6750"),
      h2("button", { type: "button", onClick: () => inputRef.current && inputRef.current.click(), style: btnStyle, title: "\u5BFC\u5165\u89C6\u9891 / \u97F3\u9891 / \u56FE\u7247\uFF08mp4 / mov / mkv / mp3 / wav / png\u2026\uFF09" }, "\u5BFC\u5165\u89C6\u9891"),
      h2("button", { type: "button", onClick: rescan, style: btnStyle, title: "\u91CD\u65B0\u626B\u63CF\u5DE5\u7A0B assets \u76EE\u5F55" }, "\u626B\u63CF"),
      h2("input", {
        ref: inputRef,
        type: "file",
        multiple: true,
        accept: "video/*,audio/*,image/*",
        style: { display: "none" },
        onChange: (e) => handleFiles(e.target.files)
      })
    ),
    h2(
      "div",
      {
        onDragOver: (e) => {
          e.preventDefault();
          setDragOver(true);
        },
        onDragLeave: () => setDragOver(false),
        onDrop: (e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        },
        style: {
          flex: 1,
          overflow: "auto",
          padding: 8,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          outline: dragOver ? `2px dashed ${T.accent}` : "none",
          outlineOffset: -6
        }
      },
      normalAssets.length === 0 && referenceAssets.length === 0 ? h2("div", { style: { fontSize: 12, opacity: 0.5, padding: 12, lineHeight: 1.6 } }, "\u8FD8\u6CA1\u6709\u7D20\u6750\u3002\u628A MP4 \u7B49\u89C6\u9891\u3001\u97F3\u9891\u3001\u56FE\u7247\u62D6\u5230\u8FD9\u91CC\uFF0C\u6216\u70B9\u300C\u5BFC\u5165\u89C6\u9891\u300D\u3002\u5B57\u5E55\u8BF7\u7528\u9876\u90E8\u300C\u5BFC\u5165\u5B57\u5E55(.srt)\u300D\u3002") : h2(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6 } },
        normalAssets.length === 0 ? h2("div", { style: { fontSize: 11, opacity: 0.5, padding: "2px 4px" } }, "\u7D20\u6750\u90FD\u964D\u7EA7\u6210\u53C2\u8003\u4E86\u3002") : null,
        normalAssets.map(renderAssetCard),
        referenceAssets.length ? h2(
          "div",
          { style: { marginTop: 4, paddingTop: 8, borderTop: `1px dashed ${T.border}` } },
          h2("div", { style: { fontSize: 11, opacity: 0.6, marginBottom: 6 } }, `\u53C2\u8003\uFF08\u53EA\u8BFB\uFF09\xB7 ${referenceAssets.length}`),
          h2("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, referenceAssets.map(renderReferenceCard))
        ) : null
      )
    ),
    viewModal
  );
}
var btnStyle = {
  padding: "3px 8px",
  borderRadius: 6,
  border: `1px solid ${T.border}`,
  background: T.panel,
  color: T.text,
  fontSize: 11,
  cursor: "pointer"
};
function keyframeCount(clip2) {
  return (clip2.keyframes || []).length;
}
function TemplateBar({ projectId, sessionId }) {
  const [open, setOpen] = import_react2.default.useState(false);
  const [templates, setTemplates] = import_react2.default.useState(null);
  const [applying, setApplying] = import_react2.default.useState(null);
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || templates) return;
    try {
      const value = await rpc("template.list", {});
      setTemplates(value.templates || []);
    } catch (e) {
      reportError(e, "\u8BFB\u53D6\u6A21\u677F\u5931\u8D25");
    }
  }
  async function apply(template) {
    if (applying) return;
    setApplying(template.id);
    try {
      await rpc("template.apply", {
        projectId,
        sessionId,
        templateId: template.id,
        baseRevision: state.doc ? state.doc.revision : void 0
      });
      await refresh();
      setOpen(false);
      toast("\u5DF2\u5957\u7528\u6A21\u677F\uFF1A" + template.name);
    } catch (e) {
      reportError(e, "\u5957\u7528\u6A21\u677F\u5931\u8D25");
    } finally {
      setApplying(null);
    }
  }
  return h2(
    "div",
    {
      style: {
        flex: "0 0 auto",
        padding: "6px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        borderBottom: `1px solid ${T.border}`,
        background: T.accentDim
      }
    },
    h2(
      "button",
      {
        type: "button",
        onClick: toggle,
        style: Object.assign({}, btnStyle, { alignSelf: "flex-start" }),
        title: "\u7AD6\u5C4F\u53E3\u64AD / \u4EA7\u54C1\u53D1\u5E03 / \u6570\u636E\u53D9\u4E8B / \u5B57\u5E55\u52A8\u753B"
      },
      open ? "\u5F53\u524D\u662F\u7A7A\u5DE5\u7A0B \xB7 \u6536\u8D77\u6A21\u677F" : "\u5F53\u524D\u662F\u7A7A\u5DE5\u7A0B \xB7 \u5957\u7528\u6A21\u677F"
    ),
    open ? h2(
      "div",
      { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
      templates ? templates.map(
        (t) => h2(
          "button",
          {
            key: t.id,
            type: "button",
            disabled: !!applying,
            onClick: () => apply(t),
            title: t.description,
            style: Object.assign({}, btnStyle, {
              textAlign: "left",
              lineHeight: 1.5,
              opacity: applying && applying !== t.id ? 0.45 : 1
            })
          },
          `${t.name} \xB7 ${t.ratio} \xB7 ${t.duration}s` + (applying === t.id ? " \xB7 \u5957\u7528\u4E2D\u2026" : "")
        )
      ) : h2("span", { style: { fontSize: 11, opacity: 0.6 } }, "\u8BFB\u53D6\u6A21\u677F\u4E2D\u2026")
    ) : null
  );
}
function keyframeValue(clip2, prop) {
  const track2 = (clip2.keyframes || []).filter((k) => k.property === prop).sort((a, b) => a.t - b.t);
  if (track2.length) return track2[track2.length - 1].value;
  if (prop === "scale") return clip2.transform && clip2.transform.scale || 1;
  if (prop === "opacity") return clip2.transform && clip2.transform.opacity != null ? clip2.transform.opacity : 1;
  return 0;
}
var EFFECT_LABEL = { brightness: "\u4EAE\u5EA6", contrast: "\u5BF9\u6BD4\u5EA6", saturate: "\u9971\u548C\u5EA6", blur: "\u6A21\u7CCA", temperature: "\u8272\u6E29", tint: "\u8272\u8C03", vignette: "\u6697\u89D2" };
function effectValue(clip2, type, fallback) {
  const found = (clip2.effects || []).find((e) => e.type === type);
  return found ? found.value : fallback;
}
function Field({ label, children }) {
  return h2(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 12 } },
    h2("span", { style: { width: 64, opacity: 0.65 } }, label),
    children
  );
}
var numStyle = {
  width: 78,
  padding: "3px 6px",
  borderRadius: 6,
  border: `1px solid ${T.border}`,
  background: T.bg,
  color: T.text,
  fontSize: 12
};
var sectionStyle = {
  marginTop: 12,
  paddingTop: 10,
  borderTop: `1px solid ${T.border}`
};
var FONT_OPTIONS = [
  ["system-ui", "\u7CFB\u7EDF\u9ED8\u8BA4"],
  ["Microsoft YaHei", "\u5FAE\u8F6F\u96C5\u9ED1"],
  ["SimHei", "\u9ED1\u4F53"],
  ["serif", "\u886C\u7EBF"],
  ["monospace", "\u7B49\u5BBD"]
];
var WEIGHT_OPTIONS = [
  [400, "\u5E38\u89C4"],
  [600, "\u534A\u7C97"],
  [700, "\u7C97"],
  [900, "\u7279\u7C97"]
];
var ALIGN_OPTIONS = [
  ["left", "\u5DE6"],
  ["center", "\u4E2D"],
  ["right", "\u53F3"]
];
var DEFAULT_BEZIER = [0.42, 0, 0.58, 1];
var EASE_OPTIONS = [
  ["linear", "\u7EBF\u6027"],
  ["easeIn", "\u7F13\u5165"],
  ["easeOut", "\u7F13\u51FA"],
  ["easeInOut", "\u7F13\u5165\u51FA"],
  ["custom", "\u81EA\u5B9A\u4E49"]
];
var PROP_LABEL = { scale: "\u7F29\u653E", opacity: "\u900F\u660E\u5EA6", x: "\u6C34\u5E73", y: "\u5782\u76F4", rotation: "\u65CB\u8F6C" };
function TextStyleSection({ clip: clip2, onOps }) {
  const style = normalizeTextStyle(clip2.style || {});
  const [strokeOn, setStrokeOn] = import_react2.default.useState(!!style.stroke);
  const [shadowOn, setShadowOn] = import_react2.default.useState(!!style.shadow);
  const stroke = style.stroke || { color: "#000000", width: 2 };
  const shadow = style.shadow || { color: "#000000", blur: 8, x: 0, y: 2 };
  const patch = (value, label) => onOps([{ type: "clip.set_property", clipId: clip2.id, property: "style", value }], label || "\u6539\u6587\u5B57\u6837\u5F0F");
  return h2(
    "div",
    { style: sectionStyle },
    h2(
      "div",
      { style: { fontWeight: 600, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 } },
      "\u6587\u5B57\u6837\u5F0F",
      h2("span", { style: { fontSize: 10, opacity: 0.45, fontWeight: 400 } }, "\u767D\u540D\u5355\u5B57\u4F53 \xB7 12..200 \u53F7")
    ),
    h2(
      Field,
      { label: "\u5B57\u4F53" },
      h2(
        "select",
        {
          value: style.fontFamily,
          style: { ...numStyle, width: 120 },
          onChange: (e) => patch({ fontFamily: e.target.value }, "\u6539\u5B57\u4F53")
        },
        FONT_OPTIONS.map(([v2, label]) => h2("option", { key: v2, value: v2 }, label))
      )
    ),
    h2(
      Field,
      { label: "\u5B57\u53F7" },
      h2("input", {
        type: "range",
        min: 12,
        max: 200,
        step: 1,
        value: style.fontSize,
        style: { flex: 1 },
        onChange: (e) => patch({ fontSize: +e.target.value }, "\u6539\u5B57\u53F7")
      }),
      h2("span", { style: { width: 34, textAlign: "right", opacity: 0.6, fontSize: 11 } }, String(style.fontSize))
    ),
    h2(
      Field,
      { label: "\u7C97\u7EC6" },
      h2(
        "select",
        {
          value: String(style.fontWeight),
          style: { ...numStyle, width: 90 },
          onChange: (e) => patch({ fontWeight: Number(e.target.value) }, "\u6539\u7C97\u7EC6")
        },
        WEIGHT_OPTIONS.map(([v2, label]) => h2("option", { key: v2, value: String(v2) }, label))
      )
    ),
    h2(
      Field,
      { label: "\u989C\u8272" },
      h2("input", {
        type: "color",
        value: style.color,
        onChange: (e) => patch({ color: e.target.value }, "\u6539\u989C\u8272")
      })
    ),
    h2(
      Field,
      { label: "\u5BF9\u9F50" },
      h2(
        "select",
        {
          value: style.align,
          style: { ...numStyle, width: 70 },
          onChange: (e) => patch({ align: e.target.value }, "\u6539\u5BF9\u9F50")
        },
        ALIGN_OPTIONS.map(([v2, label]) => h2("option", { key: v2, value: v2 }, label))
      )
    ),
    h2(
      Field,
      { label: "\u884C\u9AD8" },
      h2("input", {
        type: "range",
        min: 1,
        max: 3,
        step: 0.05,
        value: style.lineHeight,
        style: { flex: 1 },
        onChange: (e) => patch({ lineHeight: +e.target.value }, "\u6539\u884C\u9AD8")
      }),
      h2("span", { style: { width: 34, textAlign: "right", opacity: 0.6, fontSize: 11 } }, String(style.lineHeight))
    ),
    h2(
      Field,
      { label: "\u63CF\u8FB9" },
      h2("input", {
        type: "checkbox",
        checked: strokeOn,
        onChange: (e) => {
          const on = e.target.checked;
          setStrokeOn(on);
          patch({ stroke: on ? stroke : null }, on ? "\u5F00\u63CF\u8FB9" : "\u5173\u63CF\u8FB9");
        }
      })
    ),
    strokeOn ? h2(
      Field,
      { label: "\u63CF\u8FB9\u8272" },
      h2("input", {
        type: "color",
        value: stroke.color,
        onChange: (e) => patch({ stroke: { ...stroke, color: e.target.value } }, "\u6539\u63CF\u8FB9\u8272")
      })
    ) : null,
    strokeOn ? h2(
      Field,
      { label: "\u63CF\u8FB9\u5BBD" },
      h2("input", {
        type: "range",
        min: 0,
        max: 20,
        step: 0.5,
        value: stroke.width,
        style: { flex: 1 },
        onChange: (e) => patch({ stroke: { ...stroke, width: +e.target.value } }, "\u6539\u63CF\u8FB9\u5BBD")
      }),
      h2("span", { style: { width: 34, textAlign: "right", opacity: 0.6, fontSize: 11 } }, String(stroke.width))
    ) : null,
    h2(
      Field,
      { label: "\u9634\u5F71" },
      h2("input", {
        type: "checkbox",
        checked: shadowOn,
        onChange: (e) => {
          const on = e.target.checked;
          setShadowOn(on);
          patch({ shadow: on ? shadow : null }, on ? "\u5F00\u9634\u5F71" : "\u5173\u9634\u5F71");
        }
      })
    ),
    shadowOn ? h2(
      Field,
      { label: "\u9634\u5F71\u6A21\u7CCA" },
      h2("input", {
        type: "range",
        min: 0,
        max: 50,
        step: 1,
        value: shadow.blur,
        style: { flex: 1 },
        onChange: (e) => patch({ shadow: { ...shadow, blur: +e.target.value } }, "\u6539\u9634\u5F71\u6A21\u7CCA")
      }),
      h2("span", { style: { width: 34, textAlign: "right", opacity: 0.6, fontSize: 11 } }, String(shadow.blur))
    ) : null
  );
}
function KeyframeCurveRow({ clip: clip2, k, onOps }) {
  const bezier = Array.isArray(k.bezier) && k.bezier.length === 4 ? k.bezier : DEFAULT_BEZIER;
  const [custom, setCustom] = import_react2.default.useState(!!k.bezier);
  const [vals, setVals] = import_react2.default.useState(bezier.map(String));
  const [err, setErr] = import_react2.default.useState("");
  const name = PROP_LABEL[k.property] || k.property;
  const commit = (extra, label) => onOps(
    [
      {
        type: "clip.set_keyframe",
        clipId: clip2.id,
        property: k.property,
        t: k.t,
        value: k.value,
        ...k.ease && !extra.bezier ? { ease: k.ease } : {},
        ...extra
      }
    ],
    label
  );
  const onKind = (v2) => {
    if (v2 === "custom") {
      const nums = vals.map(Number);
      if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
        setErr("\u56DB\u4E2A\u5206\u91CF\u5FC5\u987B\u662F 0..1 \u7684\u6570\u5B57");
        return;
      }
      setErr("");
      setCustom(true);
      commit({ bezier: nums }, "\u6539\u5173\u952E\u5E27\u66F2\u7EBF");
      return;
    }
    setCustom(false);
    setErr("");
    onOps(
      [
        {
          type: "clip.set_keyframe",
          clipId: clip2.id,
          property: k.property,
          t: k.t,
          value: k.value,
          ease: v2
        }
      ],
      "\u6539\u5173\u952E\u5E27\u66F2\u7EBF"
    );
  };
  const onNum = (i, raw) => {
    const next = vals.slice();
    next[i] = raw;
    setVals(next);
    const nums = next.map(Number);
    if (next.some((s) => String(s).trim() === "") || nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
      setErr("\u56DB\u4E2A\u5206\u91CF\u5FC5\u987B\u662F 0..1 \u7684\u6570\u5B57");
      return;
    }
    setErr("");
    commit({ bezier: nums }, "\u6539\u5173\u952E\u5E27\u66F2\u7EBF");
  };
  return h2(
    "div",
    { style: { padding: "6px 0", borderTop: `1px dashed ${T.borderFaint}` } },
    h2(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 } },
      h2("span", { style: { flex: 1, fontSize: 11, opacity: 0.75 } }, `${name} \xB7 ${fmtTime(k.t)}`),
      h2(
        "select",
        {
          value: custom ? "custom" : k.ease || "linear",
          style: { ...numStyle, width: 84, padding: "2px 4px", fontSize: 11 },
          onChange: (e) => onKind(e.target.value)
        },
        EASE_OPTIONS.map(([v2, label]) => h2("option", { key: v2, value: v2 }, label))
      )
    ),
    custom ? h2(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 4 } },
      ["x1", "y1", "x2", "y2"].map(
        (label, i) => h2(
          "label",
          { key: label, style: { display: "flex", alignItems: "center", gap: 2, fontSize: 10, opacity: 0.6 } },
          label,
          h2("input", {
            type: "number",
            min: 0,
            max: 1,
            step: 0.01,
            value: vals[i],
            style: { ...numStyle, width: 52, padding: "2px 4px", fontSize: 11 },
            onChange: (e) => onNum(i, e.target.value)
          })
        )
      )
    ) : null,
    err ? h2("div", { style: { fontSize: 10, color: T.warn, marginTop: 2 } }, err) : null
  );
}
function AnnotationsPanel(props) {
  const { annotations, selection, playhead, duration, onSelect, onJump, onPatch, onDelete } = props || {};
  const list = Array.isArray(annotations) ? annotations : [];
  const selectedId = selection && selection.kind === "annotation" ? selection.id : null;
  const layout = annotationTrackLayout(list, { duration, zoom: 40, playhead, selectedId });
  const counts = layout.counts;
  const [editingId, setEditingId] = import_react2.default.useState(null);
  const [draft, setDraft] = import_react2.default.useState("");
  const [confirmId, setConfirmId] = import_react2.default.useState(null);
  const rowRefs = import_react2.default.useRef(/* @__PURE__ */ new Map());
  import_react2.default.useEffect(() => {
    if (!selectedId) return;
    const el = rowRefs.current.get(selectedId);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [selectedId]);
  const startEdit = (annotation) => {
    setEditingId(annotation.id);
    setDraft(String(annotation.expected == null ? "" : annotation.expected));
    setConfirmId(null);
  };
  const smallBtn = (label, onClick, tone) => h2(
    "button",
    {
      key: label,
      type: "button",
      onClick: (e) => {
        e.stopPropagation();
        onClick();
      },
      style: Object.assign({}, btnStyle, {
        padding: "1px 6px",
        fontSize: 10,
        color: tone === "danger" ? T.danger : tone === "accent" ? T.accent : T.textDim
      })
    },
    label
  );
  function renderRow(item, unplaced) {
    const a = item.annotation || { id: item.id };
    const id = item.id;
    const color = unplaced ? T.warn : annotationIntentColor(a.intent);
    const editing = editingId === id;
    const open = (a.status || "open") === "open";
    const text = String(a.expected == null ? "" : a.expected).trim();
    const rangeText = unplaced ? "\u2014" : Math.abs(Number(a.range.end) - Number(a.range.start)) < 1e-9 ? `${fmtTime(Number(a.range.start))}\uFF08\u5F53\u524D\u5E27\uFF09` : `${fmtTime(Number(a.range.start))} \u2192 ${fmtTime(Number(a.range.end))}`;
    return h2(
      "div",
      {
        key: id,
        ref: (el) => {
          if (el) rowRefs.current.set(id, el);
          else rowRefs.current.delete(id);
        },
        onClick: () => {
          if (!unplaced && typeof onJump === "function") onJump(a);
        },
        title: unplaced ? item.reasonText || "\u7F3A\u5C11 range" : annotationSummary(a) + " \xB7 \u70B9\u51FB\u8DF3\u5230\u8FD9\u4E00\u5904",
        style: {
          display: "flex",
          flexDirection: "column",
          gap: 4,
          padding: "7px 8px",
          borderBottom: `1px solid ${T.borderFaint}`,
          background: selectedId === id ? T.fillStrong : "transparent",
          outline: selectedId === id ? `1px solid ${T.accent}` : "none",
          outlineOffset: -1,
          cursor: unplaced ? "default" : "pointer"
        }
      },
      h2(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
        h2(
          "span",
          { style: { fontFamily: "ui-monospace, monospace", fontSize: 10, color: T.textDim } },
          rangeText
        ),
        h2(
          "span",
          { style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, color } },
          h2("i", { style: { width: 6, height: 6, borderRadius: 3, background: color } }),
          INTENT_LABELS[a.intent] || a.intent || "\u8981\u6539"
        ),
        h2(
          "span",
          {
            style: {
              fontSize: 10,
              color: open ? T.textDim : T.ok,
              border: `1px solid ${T.border}`,
              borderRadius: 4,
              padding: "0 4px"
            }
          },
          annotationStatusLabel(a.status)
        ),
        a.author ? h2("span", { style: { fontSize: 10, color: T.textFaint } }, a.author === "agent" ? "Agent" : "\u4F60") : null,
        unplaced ? h2("span", { style: { fontSize: 10, color: T.warn, fontFamily: "ui-monospace, monospace" } }, id) : null
      ),
      editing ? h2(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 4 } },
        h2("textarea", {
          value: draft,
          rows: 2,
          onClick: (e) => e.stopPropagation(),
          onChange: (e) => setDraft(e.target.value),
          style: Object.assign({}, numStyle, { width: "100%", resize: "vertical" })
        }),
        h2(
          "div",
          { style: { display: "flex", gap: 4 } },
          smallBtn(
            "\u4FDD\u5B58",
            () => {
              setEditingId(null);
              if (typeof onPatch === "function") onPatch(a, { expected: draft });
            },
            "accent"
          ),
          smallBtn("\u53D6\u6D88", () => setEditingId(null))
        )
      ) : h2(
        "div",
        { style: { fontSize: 11, color: text ? T.text : T.textFaint, whiteSpace: "pre-wrap", wordBreak: "break-word" } },
        text || "\uFF08\u65E0\u6587\u5B57\uFF09"
      ),
      item.inverted ? h2("div", { style: { fontSize: 10, color: T.danger } }, "\u533A\u95F4\u5012\u6302\uFF08start > end\uFF09\uFF1B\u53EF\u4E00\u952E\u4FEE\u6210\u70B9\u6807\u6CE8") : null,
      item.truncated ? h2("div", { style: { fontSize: 10, color: T.warn } }, "\u8D85\u51FA\u7247\u957F\uFF0C\u65F6\u95F4\u7EBF\u4E0A\u5DF2\u8D34\u8FB9\uFF08\u865A\u7EBF\uFF09") : null,
      unplaced ? h2("div", { style: { fontSize: 10, color: T.warn } }, item.reasonText || "\u7F3A\u5C11 range") : null,
      h2(
        "div",
        { style: { display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" } },
        unplaced ? null : smallBtn("\u8DF3\u8F6C", () => typeof onJump === "function" && onJump(a)),
        editing ? null : smallBtn("\u7F16\u8F91", () => startEdit(a), "accent"),
        smallBtn(open ? "\u6807\u8BB0\u5DF2\u5904\u7406" : "\u91CD\u65B0\u6253\u5F00", () => {
          if (typeof onPatch === "function") onPatch(a, { status: open ? "applied" : "open" });
        }),
        item.inverted ? smallBtn("\u4FEE\u6210\u70B9\u6807\u6CE8", () => {
          if (typeof onPatch === "function") onPatch(a, { range: { start: a.range.start, end: a.range.start } });
        }) : null,
        confirmId === id ? h2(
          "span",
          { style: { display: "inline-flex", gap: 4, alignItems: "center" } },
          h2("span", { style: { fontSize: 10, color: T.danger } }, "\u786E\u5B9A\u5220\u9664\uFF1F"),
          smallBtn(
            "\u5220\u9664",
            () => {
              setConfirmId(null);
              if (typeof onDelete === "function") onDelete(a);
            },
            "danger"
          ),
          smallBtn("\u53D6\u6D88", () => setConfirmId(null))
        ) : smallBtn("\u5220\u9664", () => setConfirmId(id), "danger")
      )
    );
  }
  const body = [
    h2(
      "div",
      {
        key: "head",
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          padding: "8px 10px",
          borderBottom: `1px solid ${T.border}`
        }
      },
      h2("span", { style: { fontWeight: 600, fontSize: 12 } }, "\u6807\u6CE8"),
      h2("span", { style: { fontSize: 10, color: T.textDim } }, `\u5171 ${counts.total} \u6761 / \u672A\u5904\u7406 ${counts.open} \u6761`),
      counts.unplaced ? h2("span", { style: { fontSize: 10, color: T.warn } }, `\xB7 \u65E0\u6CD5\u5B9A\u4F4D ${counts.unplaced}`) : null
    )
  ];
  if (!list.length) {
    body.push(
      h2(
        "div",
        { key: "empty", style: { padding: "18px 12px", fontSize: 11, color: T.textFaint, lineHeight: 1.8 } },
        "\u8FD8\u6CA1\u6709\u6807\u6CE8\uFF0C\u64AD\u653E\u65F6\u70B9 + \u6807\u6CE8 \u6DFB\u52A0\u3002"
      )
    );
  } else {
    layout.items.forEach((item) => body.push(renderRow(item, false)));
    if (layout.unplaced.length) {
      body.push(
        h2(
          "div",
          {
            key: "unplaced-head",
            style: { padding: "8px 10px 4px", fontSize: 10, color: T.warn, borderTop: `1px solid ${T.border}` }
          },
          "\u65E0\u6CD5\u5B9A\u4F4D\uFF08\u7F3A range\uFF0C\u4E0D\u5F71\u54CD\u5176\u5B83\u6807\u6CE8\u6E32\u67D3\uFF09"
        )
      );
      layout.unplaced.forEach((item) => body.push(renderRow(item, true)));
    }
  }
  return h2("div", { style: { paddingBottom: 12, fontSize: 12 } }, body);
}
function InspectorBody({ doc, selection, clips, annotations, playhead, onOps, onDelete, onSplit, onExport, onAnnotationUpdate, onAnnotationDelete, onDeleteProject, exportSettings, onExportSettings, analysis }) {
  const easeRef = import_react2.default.useRef("linear");
  const clip2 = selection && selection.kind === "clip" ? clips.find((c) => c.id === selection.id) : null;
  const annot = selection && selection.kind === "annotation" ? annotations.find((a) => a.id === selection.id) : null;
  const [confirmAnnotDelete, setConfirmAnnotDelete] = import_react2.default.useState(false);
  import_react2.default.useEffect(() => {
    setConfirmAnnotDelete(false);
  }, [annot && annot.id]);
  const clipTrack = clip2 && doc ? (doc.tracks || []).find((t) => t.id === clip2.trackId) : null;
  const isAudioClip2 = !!(clipTrack && clipTrack.kind === "audio");
  if (annot) {
    return h2(
      "div",
      { style: { padding: 12, fontSize: 12 } },
      h2("div", { style: { fontWeight: 600, marginBottom: 8 } }, "\u6807\u6CE8"),
      // 人类可读：「第 7 镜 · 12.40s（镜内 +0.30s）」；没解析过就只给秒
      h2(Field, { label: "\u4F4D\u7F6E" }, formatAnnotation(enrichAnnotation(annot.range, analysis))),
      h2(Field, { label: "\u7C7B\u578B" }, `${annot.intent || "change"}\uFF08${INTENT_LABELS[annot.intent] || "\u6539"}\uFF09`),
      h2(
        Field,
        { label: "\u8BF4\u660E" },
        h2("textarea", {
          defaultValue: annot.expected,
          rows: 3,
          style: { ...numStyle, width: "100%", resize: "vertical" },
          onBlur: (e) => onAnnotationUpdate(annot, { type: "annotation.update", annotationId: annot.id, expected: e.target.value })
        })
      ),
      h2(Field, { label: "\u72B6\u6001" }, annot.status),
      h2(
        "button",
        {
          type: "button",
          style: { ...btnStyle, marginTop: 8 },
          onClick: () => onAnnotationUpdate(annot, { type: "annotation.update", annotationId: annot.id, status: annot.status === "open" ? "applied" : "open" })
        },
        annot.status === "open" ? "\u6807\u8BB0\u4E3A\u5DF2\u5904\u7406" : "\u91CD\u65B0\u6253\u5F00"
      ),
      confirmAnnotDelete ? h2(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 8, flexWrap: "wrap" } },
        h2("span", { style: { fontSize: 10, color: T.danger } }, "\u786E\u5B9A\u5220\u9664\u8FD9\u6761\u6807\u6CE8\uFF1F"),
        h2(
          "button",
          {
            type: "button",
            style: Object.assign({}, btnStyle, { color: T.danger }),
            onClick: () => {
              setConfirmAnnotDelete(false);
              if (typeof onAnnotationDelete === "function") onAnnotationDelete(annot);
            }
          },
          "\u5220\u9664"
        ),
        h2(
          "button",
          { type: "button", style: btnStyle, onClick: () => setConfirmAnnotDelete(false) },
          "\u53D6\u6D88"
        )
      ) : h2(
        "button",
        {
          type: "button",
          style: Object.assign({}, btnStyle, { marginTop: 8, marginLeft: 6, color: T.danger }),
          onClick: () => setConfirmAnnotDelete(true)
        },
        "\u5220\u9664\u6807\u6CE8"
      )
    );
  }
  if (!clip2) {
    return h2(
      "div",
      { style: { padding: 12, fontSize: 12, lineHeight: 1.7 } },
      h2("div", { style: { fontWeight: 600, marginBottom: 8 } }, "\u5DE5\u7A0B"),
      doc ? h2(Field, { label: "\u7248\u672C" }, "r" + doc.revision) : null,
      doc ? h2(Field, { label: "\u65F6\u957F" }, doc.duration.toFixed(2) + "s") : null,
      doc ? h2(Field, { label: "\u753B\u5E45" }, doc.ratio) : null,
      doc && exportSettings ? h2(
        Field,
        { label: "\u5BFC\u51FA" },
        h2(
          "select",
          {
            value: exportSettings.width + "x" + exportSettings.height,
            onChange: (e) => {
              const [w, hh] = e.target.value.split("x").map(Number);
              onExportSettings({ width: w, height: hh });
            },
            style: { ...numStyle, width: 110 }
          },
          [["1280x720", "720p"], ["1920x1080", "1080p"], ["2560x1440", "1440p"], ["3840x2160", "4K"]].map(
            ([v2, label]) => h2("option", { key: v2, value: v2 }, label)
          )
        )
      ) : null,
      doc && exportSettings ? h2(
        Field,
        { label: "\u5E27\u7387" },
        h2(
          "select",
          {
            value: String(exportSettings.fps),
            onChange: (e) => onExportSettings({ fps: Number(e.target.value) }),
            style: { ...numStyle, width: 80 }
          },
          [24, 25, 30, 50, 60].map((f) => h2("option", { key: f, value: String(f) }, f + " fps"))
        )
      ) : null,
      h2("div", { style: { height: 12 } }),
      h2("button", { type: "button", style: { ...btnStyle, width: "100%", padding: "6px 8px" }, onClick: onExport }, "\u5BFC\u51FA MP4"),
      h2("div", { style: { height: 8 } }),
      h2(
        "button",
        { type: "button", style: { ...btnStyle, width: "100%", padding: "6px 8px", color: T.danger }, onClick: onDeleteProject },
        "\u5220\u9664\u5DE5\u7A0B"
      ),
      h2("div", { style: { opacity: 0.5, marginTop: 8, fontSize: 11 } }, "\u70B9\u65F6\u95F4\u7EBF\u4E0A\u7684\u7247\u6BB5\u6765\u7F16\u8F91\uFF1B\u62D6\u4E24\u7AEF\u88C1\u526A\uFF0C\u62D6\u4E2D\u95F4\u79FB\u52A8\u3002")
    );
  }
  const update = (property, value) => onOps([{ type: "clip.trim", clipId: clip2.id, [property]: value }], "\u4FEE\u6539\u7247\u6BB5");
  const updateProp = (property, value) => onOps([{ type: "clip.set_property", clipId: clip2.id, property, value }], "\u4FEE\u6539\u5C5E\u6027");
  return h2(
    "div",
    { style: { padding: 12, fontSize: 12, overflow: "auto" } },
    h2(
      "div",
      { style: { fontWeight: 600, marginBottom: 8, display: "flex", gap: 6 } },
      h2("span", null, "\u7247\u6BB5"),
      chip(clip2.type)
    ),
    h2("div", { style: { opacity: 0.55, fontSize: 11, marginBottom: 10, fontFamily: "ui-monospace, monospace" } }, clip2.id),
    h2(Field, { label: "\u5F00\u59CB" }, h2("input", { type: "number", step: 0.01, value: clip2.start, style: numStyle, onChange: (e) => update("start", +e.target.value) })),
    h2(Field, { label: "\u65F6\u957F" }, h2("input", { type: "number", step: 0.01, value: clip2.duration, style: numStyle, onChange: (e) => update("duration", +e.target.value) })),
    clip2.type === "media" ? h2(Field, { label: "\u6E90\u5165\u70B9" }, h2("input", { type: "number", step: 0.01, value: clip2.sourceIn || 0, style: numStyle, onChange: (e) => update("sourceIn", +e.target.value) })) : null,
    clip2.type === "media" ? h2(Field, { label: "\u4E0D\u900F\u660E\u5EA6" }, h2("input", { type: "number", step: 0.05, min: 0, max: 1, value: clip2.transform && clip2.transform.opacity || 1, style: numStyle, onChange: (e) => onOps([{ type: "clip.set_transform", clipId: clip2.id, transform: { opacity: +e.target.value } }], "\u4FEE\u6539\u4E0D\u900F\u660E\u5EA6") })) : null,
    isAudioClip2 ? h2(Field, { label: "\u97F3\u91CF(0\u20132)" }, h2("input", { type: "number", step: 0.1, min: 0, max: 2, value: clip2.volume == null ? 1 : clip2.volume, style: numStyle, onChange: (e) => updateProp("volume", +e.target.value) })) : null,
    clip2.type === "text" ? h2(
      "div",
      { style: { marginTop: 6 } },
      h2(Field, { label: "\u6587\u5B57" }, h2("input", {
        type: "text",
        defaultValue: clip2.text || "",
        style: { ...numStyle, width: "100%" },
        onBlur: (e) => onOps([{ type: "clip.set_text", clipId: clip2.id, text: e.target.value }], "\u4FEE\u6539\u6587\u5B57")
      })),
      h2(TextStyleSection, { key: clip2.id, clip: clip2, onOps }),
      h2(Field, { label: "\u4F4D\u7F6E" }, h2("input", {
        type: "range",
        min: 0.1,
        max: 0.95,
        step: 0.01,
        value: clip2.style && clip2.style.y != null ? clip2.style.y : 0.82,
        style: { flex: 1 },
        onChange: (e) => onOps([{ type: "clip.set_property", clipId: clip2.id, property: "style", value: { y: +e.target.value } }], "\u6539\u4F4D\u7F6E")
      })),
      h2(
        "button",
        {
          type: "button",
          style: { ...btnStyle, marginTop: 4 },
          onClick: () => {
            const style = normalizeTextStyle(clip2.style || {});
            const ops = (clips || []).filter((c) => c.type === "text" && c.id !== clip2.id).map((c) => ({ type: "clip.set_property", clipId: c.id, property: "style", value: style }));
            if (!ops.length) return;
            onOps(ops, "\u7EDF\u4E00\u6837\u5F0F\uFF08" + ops.length + " \u6761\u5B57\u5E55\uFF09");
          }
        },
        "\u628A\u5F53\u524D\u6837\u5F0F\u5E94\u7528\u5230\u6240\u6709\u5B57\u5E55"
      )
    ) : null,
    h2("div", { style: { height: 10 } }),
    h2("button", { type: "button", style: { ...btnStyle, marginRight: 6 }, onClick: () => onSplit(clip2) }, "\u5728\u64AD\u653E\u5934\u5206\u5272"),
    h2("button", { type: "button", style: { ...btnStyle, color: T.danger }, onClick: () => onDelete(clip2) }, "\u5220\u9664"),
    h2(
      "button",
      {
        type: "button",
        style: { ...btnStyle, marginLeft: 6 },
        title: "\u9996\u5C3E\u5404 0.3 \u79D2\u6DE1\u5165\u6DE1\u51FA",
        onClick: () => onOps([{ type: "clip.set_transition", clipId: clip2.id, transitionIn: 0.3, transitionOut: 0.3 }], "\u6DFB\u52A0\u6DE1\u5165\u6DE1\u51FA")
      },
      "\u6DE1\u5165\u6DE1\u51FA"
    ),
    h2(
      "button",
      {
        type: "button",
        style: { ...btnStyle, marginLeft: 6 },
        onClick: () => onOps([{ type: "clip.set_transition", clipId: clip2.id, transitionIn: null, transitionOut: null }], "\u6E05\u9664\u8F6C\u573A")
      },
      "\u6E05\u9664\u8F6C\u573A"
    ),
    isAudioClip2 ? h2(
      "div",
      { style: { marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}` } },
      h2("div", { style: { fontWeight: 600, marginBottom: 6 } }, "\u97F3\u9891"),
      h2(Field, { label: "\u9759\u97F3" }, h2("input", {
        type: "checkbox",
        checked: clip2.muted === true,
        onChange: (e) => updateProp("muted", e.target.checked)
      })),
      h2(Field, { label: "\u6DE1\u5165(\u79D2)" }, h2("input", {
        type: "number",
        step: 0.1,
        min: 0,
        max: Math.max(0, clip2.duration - (clip2.fadeOut || 0)),
        defaultValue: clip2.fadeIn || "",
        style: numStyle,
        onBlur: (e) => {
          const v2 = Math.max(0, Math.min(clip2.duration - (clip2.fadeOut || 0), Number(e.target.value) || 0));
          onOps([{ type: "clip.set_property", clipId: clip2.id, property: "fadeIn", value: v2 }], "\u6539\u6DE1\u5165");
        }
      })),
      h2(Field, { label: "\u6DE1\u51FA(\u79D2)" }, h2("input", {
        type: "number",
        step: 0.1,
        min: 0,
        max: Math.max(0, clip2.duration - (clip2.fadeIn || 0)),
        defaultValue: clip2.fadeOut || "",
        style: numStyle,
        onBlur: (e) => {
          const v2 = Math.max(0, Math.min(clip2.duration - (clip2.fadeIn || 0), Number(e.target.value) || 0));
          onOps([{ type: "clip.set_property", clipId: clip2.id, property: "fadeOut", value: v2 }], "\u6539\u6DE1\u51FA");
        }
      }))
    ) : null,
    clip2.type === "media" ? h2(
      "div",
      { style: { marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}` } },
      h2("div", { style: { fontWeight: 600, marginBottom: 6 } }, "\u8499\u7248"),
      h2(
        Field,
        { label: "\u5F62\u72B6" },
        h2(
          "select",
          {
            value: clip2.mask ? clip2.mask.shape : "none",
            style: { ...numStyle, width: 100 },
            onChange: (e) => {
              const shape = e.target.value;
              if (shape === "none") {
                onOps([{ type: "clip.set_mask", clipId: clip2.id, mask: { shape: "none" } }], "\u6E05\u9664\u8499\u7248");
              } else {
                onOps([{ type: "clip.set_mask", clipId: clip2.id, mask: { shape, x: 0.5, y: 0.5, w: 0.6, h: 0.6 } }], "\u8BBE\u7F6E\u8499\u7248");
              }
            }
          },
          [["none", "\u65E0"], ["rect", "\u77E9\u5F62"], ["circle", "\u5706\u5F62"]].map(([v2, l]) => h2("option", { key: v2, value: v2 }, l))
        )
      ),
      clip2.mask && clip2.mask.shape !== "none" ? ["x", "y", "w", "h"].map(
        (k) => h2(
          "div",
          { key: k, style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
          h2("span", { style: { width: 48, opacity: 0.65 } }, { x: "\u6C34\u5E73", y: "\u5782\u76F4", w: "\u5BBD", h: "\u9AD8" }[k]),
          h2("input", {
            type: "range",
            min: 0.05,
            max: 1,
            step: 0.01,
            value: clip2.mask[k],
            style: { flex: 1 },
            onChange: (e) => onOps([{ type: "clip.set_mask", clipId: clip2.id, mask: Object.assign({}, clip2.mask, { [k]: +e.target.value }) }], "\u8C03\u6574\u8499\u7248")
          })
        )
      ) : null
    ) : null,
    clip2.type === "media" || clip2.type === "code" ? h2(
      "div",
      { style: { marginTop: 14, paddingTop: 10, borderTop: `1px solid ${T.border}` } },
      h2("div", { style: { fontWeight: 600, marginBottom: 6 } }, "\u6548\u679C"),
      ["brightness", "contrast", "saturate", "temperature", "tint", "vignette", "blur"].map((type) => {
        const range = { blur: [0, 20, 0.5], vignette: [0, 1, 0.05], temperature: [-1, 1, 0.05], tint: [-1, 1, 0.05] }[type] || [0.2, 2, 0.05];
        const fallback = { blur: 0, vignette: 0, temperature: 0, tint: 0 }[type] ?? 1;
        const val = effectValue(clip2, type, fallback);
        return h2(
          "div",
          { key: type, style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
          h2("span", { style: { width: 48, opacity: 0.65 } }, EFFECT_LABEL[type]),
          h2("input", {
            type: "range",
            min: range[0],
            max: range[1],
            step: range[2],
            value: val,
            onChange: (e) => onOps(
              [{ type: "clip.set_effect", clipId: clip2.id, effect: type, value: +e.target.value }],
              "\u8C03\u6574\u6548\u679C"
            ),
            style: { flex: 1 }
          }),
          h2("span", { style: { width: 34, textAlign: "right", opacity: 0.6, fontSize: 11 } }, String(val))
        );
      })
    ) : null,
    clip2.type === "media" || clip2.type === "text" || clip2.type === "code" ? h2(
      "div",
      { style: { marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}` } },
      h2(
        "div",
        { style: { fontWeight: 600, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 } },
        "\u52A8\u753B",
        h2("span", { style: { fontSize: 10, opacity: 0.55, fontWeight: 400 } }, "\u5728\u64AD\u653E\u5934\u6253\u70B9\uFF08" + keyframeCount(clip2) + " \u4E2A\u5173\u952E\u5E27\uFF09")
      ),
      ["scale", "opacity"].map(
        (prop) => h2(
          "div",
          { key: prop, style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
          h2("span", { style: { width: 42, opacity: 0.65 } }, prop === "scale" ? "\u7F29\u653E" : "\u900F\u660E\u5EA6"),
          h2("input", {
            type: "range",
            min: prop === "scale" ? 0.1 : 0,
            max: prop === "scale" ? 3 : 1,
            step: 0.01,
            value: keyframeValue(clip2, prop),
            onChange: (e) => onOps(
              [
                {
                  type: "clip.set_keyframe",
                  clipId: clip2.id,
                  property: prop,
                  t: Math.max(0, Math.min(clip2.duration, +(playhead - clip2.start).toFixed(3))),
                  value: +e.target.value,
                  ease: easeRef.current
                }
              ],
              "\u6253\u5173\u952E\u5E27"
            ),
            style: { flex: 1 }
          }),
          h2("span", { style: { width: 34, textAlign: "right", opacity: 0.6, fontSize: 11 } }, String(keyframeValue(clip2, prop)))
        )
      ),
      h2(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
        h2("span", { style: { width: 42, opacity: 0.65 } }, "\u7F13\u52A8"),
        h2(
          "select",
          {
            defaultValue: "linear",
            onChange: (e) => {
              easeRef.current = e.target.value;
            },
            style: { ...numStyle, width: 110 }
          },
          [
            ["linear", "\u7EBF\u6027"],
            ["easeIn", "\u7F13\u5165"],
            ["easeOut", "\u7F13\u51FA"],
            ["easeInOut", "\u7F13\u5165\u7F13\u51FA"]
          ].map(([v2, label]) => h2("option", { key: v2, value: v2 }, label))
        ),
        h2("span", { style: { fontSize: 10, opacity: 0.45 } }, "\u4F5C\u7528\u4E8E\u4E4B\u540E\u6253\u7684\u5173\u952E\u5E27")
      ),
      h2(
        "div",
        { style: { marginTop: 4 } },
        h2("div", { style: { opacity: 0.6, fontSize: 11, marginBottom: 2 } }, "\u6BCF\u5E27\u66F2\u7EBF"),
        (clip2.keyframes || []).length ? (clip2.keyframes || []).slice().sort(
          (a, b) => a.property === b.property ? a.t - b.t : String(a.property).localeCompare(String(b.property))
        ).map(
          (k) => h2(KeyframeCurveRow, {
            key: k.property + ":" + k.t + ":" + (k.bezier ? k.bezier.join(",") : k.ease || "linear"),
            clip: clip2,
            k,
            onOps
          })
        ) : h2(
          "div",
          { style: { opacity: 0.4, fontSize: 10, padding: "2px 0 6px" } },
          "\u8FD8\u6CA1\u6709\u5173\u952E\u5E27\uFF1A\u5148\u62D6\u4E0A\u9762\u7684\u6ED1\u6761\u6253\u4E00\u5E27\uFF0C\u518D\u56DE\u6765\u6539\u5B83\u7684\u66F2\u7EBF"
        )
      ),
      h2(
        "button",
        {
          type: "button",
          style: btnStyle,
          onClick: () => onOps([{ type: "clip.remove_keyframe", clipId: clip2.id }], "\u6E05\u9664\u5173\u952E\u5E27")
        },
        "\u6E05\u9664\u5173\u952E\u5E27"
      )
    ) : null,
    clip2.type === "code" ? h2(
      "div",
      { style: { marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` } },
      h2("div", { style: { fontWeight: 600, marginBottom: 6 } }, "\u56FE\u5C42\u53C2\u6570\uFF08agent \u53EF\u6539\uFF0C\u4EBA\u4E5F\u53EF\u6539\uFF09"),
      h2("textarea", {
        key: clip2.id + ":" + JSON.stringify(clip2.props || {}),
        defaultValue: JSON.stringify(clip2.props || {}, null, 2),
        rows: 5,
        spellCheck: false,
        style: { ...numStyle, width: "100%", resize: "vertical", fontFamily: "ui-monospace, monospace" },
        onBlur: (e) => {
          try {
            const props = JSON.parse(e.target.value || "{}");
            onOps([{ type: "code_layer.set_props", clipId: clip2.id, props }], "\u4FEE\u6539\u56FE\u5C42\u53C2\u6570");
          } catch {
          }
        }
      })
    ) : null,
    clip2.type === "media" && clip2.provenance ? h2(
      "div",
      { style: { marginTop: 14, paddingTop: 10, borderTop: `1px solid ${T.border}`, fontSize: 11, opacity: 0.75, lineHeight: 1.6 } },
      h2("div", { style: { fontWeight: 600, marginBottom: 4 } }, "\u6765\u6E90"),
      h2("div", null, `\u5E93\uFF1A${clip2.provenance.libraryId || "local"}`),
      h2("div", null, `\u7D20\u6750\uFF1A${clip2.provenance.assetId || clip2.assetId || ""}`),
      clip2.provenance.hash ? h2("div", { style: { fontFamily: "ui-monospace, monospace", wordBreak: "break-all" } }, clip2.provenance.hash) : null
    ) : null
  );
}
function StoryboardPanel({ projectId, sessionId, defaultOpen }) {
  const [open, setOpen] = import_react2.default.useState(!!defaultOpen);
  const [data, setData] = import_react2.default.useState(null);
  const [loading, setLoading] = import_react2.default.useState(false);
  const [busy, setBusy] = import_react2.default.useState("");
  const [note, setNote] = import_react2.default.useState("");
  const load = import_react2.default.useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const value = await rpc("storyboard.read", { projectId, sessionId });
      setData(value);
      setNote(value && value.warning || "");
    } catch (e) {
      reportError(e, "\u8BFB\u53D6\u5206\u955C\u5931\u8D25");
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);
  import_react2.default.useEffect(() => {
    if (open) load();
  }, [open, load]);
  async function resplit() {
    if (busy) return;
    setBusy("save");
    try {
      const value = await rpc("storyboard.save", { projectId, sessionId });
      await refresh();
      await load();
      toast("\u5DF2\u91CD\u65B0\u62C6\u5206\uFF1A" + value.count + " \u955C");
    } catch (e) {
      reportError(e, "\u91CD\u65B0\u62C6\u5206\u5931\u8D25");
    } finally {
      setBusy("");
    }
  }
  async function apply() {
    if (busy) return;
    setBusy("apply");
    try {
      const value = await rpc("storyboard.apply", {
        projectId,
        sessionId,
        baseRevision: state.doc ? state.doc.revision : void 0
      });
      await refresh();
      await load();
      toast("\u5DF2\u843D\u5730 " + value.count + " \u955C\u5230\u65F6\u95F4\u7EBF");
    } catch (e) {
      reportError(e, "\u5E94\u7528\u5230\u65F6\u95F4\u7EBF\u5931\u8D25");
    } finally {
      setBusy("");
    }
  }
  const shots = data && data.doc && data.doc.shots || [];
  const line = (text) => h2("div", { style: { fontSize: 11, opacity: 0.55, lineHeight: 1.6 } }, text);
  return h2(
    "div",
    { style: { borderTop: `1px solid ${T.border}`, padding: "8px 10px" } },
    h2(
      "div",
      {
        style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" },
        onClick: () => setOpen((v2) => !v2)
      },
      h2("strong", { style: { fontSize: 12, flex: 1 } }, "\u5206\u955C" + (open && data ? "\uFF08" + shots.length + "\uFF09" : "")),
      h2("span", { style: { fontSize: 10, opacity: 0.45 } }, open && note ? "\u6709\u63D0\u793A" : ""),
      h2("span", { style: { fontSize: 11, opacity: 0.5 } }, open ? "\u6536\u8D77" : "\u5C55\u5F00")
    ),
    open ? h2(
      "div",
      { style: { marginTop: 8, display: "flex", flexDirection: "column", gap: 6 } },
      loading ? line("\u8BFB\u53D6\u5206\u955C\u4E2D\u2026") : !data ? line("\u5C55\u5F00\u540E\u8BFB\u53D6\u5DE5\u7A0B\u91CC\u7684 storyboard.json") : !shots.length ? line("\u8FD8\u6CA1\u6709\u5206\u955C\uFF1A\u70B9\u4E0B\u9762\u300C\u91CD\u65B0\u62C6\u5206\uFF08\u8BFB\u5F53\u524D\u5B57\u5E55\uFF09\u300D\u4ECE\u5DE5\u7A0B\u5B57\u5E55\u751F\u6210\u4E00\u4EFD") : h2(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 4,
            maxHeight: 200,
            overflowY: "auto",
            overscrollBehavior: "contain"
          }
        },
        shots.map(
          (shot) => h2(
            "div",
            {
              key: shot.index + ":" + shot.start,
              style: {
                padding: "4px 6px",
                borderRadius: 4,
                background: T.fill,
                border: `1px solid ${T.borderFaint}`
              }
            },
            h2(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11 } },
              h2("span", { style: { opacity: 0.55 } }, "#" + shot.index),
              h2("span", { style: { fontFamily: "ui-monospace, monospace", opacity: 0.75 } }, fmtTime(shot.start)),
              h2("span", { style: { opacity: 0.35 } }, "\u2192"),
              h2("span", { style: { fontFamily: "ui-monospace, monospace", opacity: 0.75 } }, fmtTime(shot.end)),
              shot.suggestedEffect && shot.suggestedEffect !== "none" ? chip(shot.suggestedEffect) : null,
              shot.clipId ? h2("span", { style: { marginLeft: "auto", fontSize: 10, opacity: 0.35 } }, "\u5DF2\u843D\u5730") : null
            ),
            h2(
              "div",
              {
                title: shot.text,
                style: {
                  fontSize: 11,
                  opacity: 0.8,
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap"
                }
              },
              shot.text
            )
          )
        )
      ),
      note ? h2("div", { style: { fontSize: 10, color: T.warn, lineHeight: 1.5 } }, note) : null,
      h2(
        "div",
        { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
        h2(
          "button",
          {
            type: "button",
            disabled: !!busy,
            title: "\u8BFB\u5F53\u524D\u5DE5\u7A0B\u7684\u5B57\u5E55\u8F68\uFF0C\u91CD\u65B0\u5207\u5206\u5E76\u5199\u56DE storyboard.json",
            onClick: resplit,
            style: { ...btnStyle, opacity: busy ? 0.5 : 1 }
          },
          busy === "save" ? "\u62C6\u5206\u4E2D\u2026" : "\u91CD\u65B0\u62C6\u5206\uFF08\u8BFB\u5F53\u524D\u5B57\u5E55\uFF09"
        ),
        h2(
          "button",
          {
            type: "button",
            disabled: !!busy,
            title: "\u6309\u5206\u955C\u94FA\u65F6\u95F4\u7EBF\uFF08\u4E00\u6B21\u4E8B\u52A1\uFF09\uFF1B\u5DE5\u7A0B\u91CC\u5DF2\u6709\u7247\u6BB5\u65F6\u4F1A\u62D2\u7EDD",
            onClick: apply,
            style: { ...btnStyle, opacity: busy ? 0.5 : 1 }
          },
          busy === "apply" ? "\u843D\u5730\u4E2D\u2026" : "\u5E94\u7528\u5230\u65F6\u95F4\u7EBF"
        )
      )
    ) : null
  );
}
function isTranscribable(asset) {
  const mime = String(asset && asset.mime || "");
  if (mime.startsWith("video/") || mime.startsWith("audio/")) return true;
  return /\.(mp4|mov|mkv|webm|avi|m4v|mp3|wav|m4a|flac|ogg)$/i.test(String(asset && asset.path || ""));
}
function AsrPanel({ projectId, sessionId, defaultOpen }) {
  const [open, setOpen] = import_react2.default.useState(defaultOpen == null ? true : !!defaultOpen);
  const [deps, setDeps] = import_react2.default.useState(null);
  const [busy, setBusy] = import_react2.default.useState(null);
  const [note, setNote] = import_react2.default.useState("");
  const [reasons, setReasons] = import_react2.default.useState([]);
  const alive = import_react2.default.useRef(true);
  const timer = import_react2.default.useRef(null);
  import_react2.default.useEffect(
    () => () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      if (state.busy && state.busy.kind === "asr") setState({ busy: null });
    },
    []
  );
  import_react2.default.useEffect(() => {
    if (!open) return void 0;
    let cancelled = false;
    (async () => {
      try {
        const value = await rpc("asr.status", {});
        if (!cancelled) setDeps(value);
      } catch (e) {
        if (!cancelled) setReasons([e && e.message || "\u4F9D\u8D56\u68C0\u6D4B\u5931\u8D25"]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);
  function pickAsset() {
    const selected = state.selection && state.selection.kind === "clip" ? (state.clips || []).find((c) => c.id === state.selection.id) : null;
    const assets = state.assets || [];
    const fromSelection = selected && selected.assetId ? assets.find((a) => a.id === selected.assetId) : null;
    if (fromSelection) return fromSelection;
    return assets.find(isTranscribable) || null;
  }
  function finish() {
    setBusy(null);
    if (state.busy && state.busy.kind === "asr") setState({ busy: null });
  }
  function poll(jobId) {
    return new Promise((resolve) => {
      const tick = async () => {
        if (!alive.current) return resolve();
        let value;
        try {
          value = await rpc("asr.progress", { jobId });
        } catch (e) {
          finish();
          reportError(e, "\u8BFB\u53D6\u8F6C\u5199\u8FDB\u5EA6\u5931\u8D25");
          return resolve();
        }
        const ratio = typeof value.ratio === "number" ? value.ratio : 0;
        const label = value.label || (value.status === "running" ? "\u8F6C\u5199\u4E2D\u2026" : "\u5904\u7406\u4E2D\u2026");
        setBusy({ label, ratio });
        setState({ busy: { label, ratio, kind: "asr" } });
        if (value.status === "running") {
          timer.current = setTimeout(tick, 800);
          return resolve();
        }
        finish();
        if (value.error) {
          setReasons([value.error.message || "\u8F6C\u5199\u5931\u8D25"]);
          toast(value.error.message || "\u8F6C\u5199\u5931\u8D25", "warn");
          return resolve();
        }
        const result = value.result || {};
        if (!result.ready) {
          setReasons(Array.isArray(result.reasons) ? result.reasons : ["\u4F9D\u8D56\u7F3A\u5931"]);
          toast("\u7F3A\u5C11\u8BED\u97F3\u8F6C\u5B57\u5E55\u4F9D\u8D56\uFF0C\u770B\u9762\u677F\u91CC\u7684\u539F\u56E0", "warn");
          return resolve();
        }
        const count = (result.segments || []).length;
        setNote(`\u5DF2\u751F\u6210 ${count} \u6761\u5B57\u5E55` + (result.applied ? `\uFF0C\u5199\u5165\u5B57\u5E55\u8F68 ${result.applied.count} \u6761` : ""));
        if (result.warnings && result.warnings.length) setReasons(result.warnings);
        refresh().catch(() => {
        });
        toast("\u5DF2\u751F\u6210\u5B57\u5E55\uFF1A" + count + " \u6761");
        return resolve();
      };
      tick();
    });
  }
  async function start() {
    if (busy) return;
    const asset = pickAsset();
    if (!asset) {
      toast("\u5DE5\u7A0B\u91CC\u8FD8\u6CA1\u6709\u53EF\u8F6C\u5199\u7684\u89C6\u9891/\u97F3\u9891\u7D20\u6750", "warn");
      return;
    }
    setReasons([]);
    setNote("");
    const first = { label: "\u51C6\u5907\u8F6C\u5199\u2026", ratio: 0 };
    setBusy(first);
    setState({ busy: { ...first, kind: "asr" } });
    try {
      const job = await rpc("asr.transcribe", {
        projectId,
        sessionId,
        assetId: asset.id,
        modelSize: "medium",
        language: "zh",
        applyToTimeline: true
      });
      await poll(job.jobId);
    } catch (e) {
      finish();
      reportError(e, "\u542F\u52A8\u8BED\u97F3\u8F6C\u5B57\u5E55\u5931\u8D25");
    }
  }
  const line = (text, tone) => h2("div", { style: { fontSize: 11, lineHeight: 1.6, opacity: 0.6, color: tone === "warn" ? T.warn : void 0 } }, text);
  const shownReasons = reasons.length ? reasons : deps && !deps.ready ? deps.reasons || [] : [];
  const ready = deps ? deps.ready === true : null;
  const backend = deps && deps.whisper ? deps.whisper.backend : null;
  const stateLine = ready == null ? "\u5C55\u5F00\u540E\u68C0\u6D4B\u4F9D\u8D56" : ready ? `\u4F9D\u8D56\u5C31\u7EEA \xB7 ${backend === "cuda" ? "GPU\uFF08CUDA\uFF09" : "CPU"}` : "\u4F9D\u8D56\u7F3A\u5931";
  return h2(
    "div",
    { style: { borderTop: `1px solid ${T.border}`, padding: "8px 10px" } },
    h2(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }, onClick: () => setOpen((v2) => !v2) },
      h2("strong", { style: { fontSize: 12, flex: 1 } }, "\u8BED\u97F3\u8F6C\u5B57\u5E55" + (ready === false ? "\uFF08\u672A\u5C31\u7EEA\uFF09" : "")),
      h2("span", { style: { fontSize: 10, opacity: 0.45 } }, open ? stateLine : ""),
      h2("span", { style: { fontSize: 11, opacity: 0.5 } }, open ? "\u6536\u8D77" : "\u5C55\u5F00")
    ),
    open ? h2(
      "div",
      { style: { marginTop: 8, display: "flex", flexDirection: "column", gap: 6 } },
      h2(
        "button",
        {
          type: "button",
          disabled: !!busy,
          title: "\u62BD\u97F3\u8F68 \u2192 faster-whisper\uFF08small\uFF09\u2192 \u76F4\u63A5\u5199\u5165\u5B57\u5E55\u8F68\uFF1B\u4E00\u6B21\u4E8B\u52A1\uFF0C\u53EF\u64A4\u9500",
          onClick: start,
          style: { ...btnStyle, alignSelf: "flex-start", opacity: busy ? 0.5 : 1 }
        },
        busy ? `${busy.label} ${Math.round((busy.ratio || 0) * 100)}%` : "\u751F\u6210\u5B57\u5E55"
      ),
      deps && deps.ready === false ? null : line("\u7528\u5F53\u524D\u9009\u4E2D\u7247\u6BB5\u5BF9\u5E94\u7684\u7D20\u6750\uFF1B\u6CA1\u6709\u9009\u4E2D\u5C31\u7528\u5DE5\u7A0B\u91CC\u7B2C\u4E00\u4E2A\u89C6\u9891\u7D20\u6750\u3002"),
      note ? h2("div", { style: { fontSize: 11, color: T.ok } }, note) : null,
      shownReasons.length ? h2(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11,
            color: T.warn,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap"
          }
        },
        shownReasons.map((text, index) => h2("div", { key: index }, String(text)))
      ) : null,
      deps && deps.warnings && deps.warnings.length && !shownReasons.length ? line(deps.warnings.join("\uFF1B"), "warn") : null
    ) : null
  );
}
function TtsPanel({ projectId, sessionId, defaultOpen }) {
  const [open, setOpen] = import_react2.default.useState(defaultOpen == null ? true : !!defaultOpen);
  const [deps, setDeps] = import_react2.default.useState(null);
  const [voices, setVoices] = import_react2.default.useState([]);
  const [voice, setVoice] = import_react2.default.useState("");
  const [rate, setRate] = import_react2.default.useState(0);
  const [text, setText] = import_react2.default.useState("");
  const [busy, setBusy] = import_react2.default.useState(false);
  const [note, setNote] = import_react2.default.useState("");
  const [reasons, setReasons] = import_react2.default.useState([]);
  const sourceRef = import_react2.default.useRef(null);
  const selectedTextClip = import_react2.default.useMemo(() => {
    const sel = state.selection;
    if (!sel || sel.kind !== "clip") return null;
    const clip2 = (state.clips || []).find((c) => c.id === sel.id);
    return clip2 && clip2.type === "text" ? clip2 : null;
  }, [state.selection, state.clips]);
  import_react2.default.useEffect(() => {
    if (!open) return void 0;
    let cancelled = false;
    (async () => {
      try {
        const value = await rpc("tts.probe", {});
        if (!cancelled) {
          setDeps(value);
          if (value && Array.isArray(value.voices) && value.voices.length) setVoices(value.voices);
        }
      } catch (e) {
        if (!cancelled) setReasons([e && e.message || "\u914D\u97F3\u4F9D\u8D56\u68C0\u6D4B\u5931\u8D25"]);
      }
      try {
        const value = await rpc("tts.voices", {});
        if (!cancelled && value && Array.isArray(value.voices) && value.voices.length) setVoices(value.voices);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);
  import_react2.default.useEffect(() => {
    if (!voice && voices.length) setVoice(voices[0].id);
  }, [voices, voice]);
  import_react2.default.useEffect(() => {
    const clip2 = selectedTextClip;
    if (!clip2) return;
    const key = clip2.id + "\0" + String(clip2.text || "");
    if (sourceRef.current === key) return;
    sourceRef.current = key;
    setText(String(clip2.text || ""));
  }, [selectedTextClip]);
  const chars = Array.from(String(text || "")).length;
  const shownReasons = reasons.length ? reasons : deps && !deps.ready ? deps.reasons || [] : [];
  const ready = deps ? deps.ready === true : null;
  const stateLine = ready == null ? "\u5C55\u5F00\u540E\u68C0\u6D4B\u4F9D\u8D56" : ready ? `\u5C31\u7EEA \xB7 ${deps.provider}` : "\u4F9D\u8D56\u7F3A\u5931";
  async function generate() {
    if (busy) return;
    const value = String(text || "").trim();
    if (!value) {
      toast("\u5148\u8F93\u5165\u8981\u914D\u97F3\u7684\u6587\u5B57\uFF08\u6216\u9009\u4E2D\u4E00\u6761\u6587\u5B57\u7247\u6BB5\uFF09", "warn");
      return;
    }
    if (chars > 2e3) {
      toast(`\u6587\u672C\u592A\u957F\uFF1A${chars} \u5B57\uFF0C\u4E0A\u9650 2000 \u5B57`, "warn");
      return;
    }
    setBusy(true);
    setReasons([]);
    setNote("");
    setState({ busy: { label: "\u5408\u6210\u914D\u97F3\u2026", ratio: 0.45, kind: "tts" } });
    try {
      const res = await ttsSpeak(value, { voice, rate, start: state.playhead });
      const seconds = ((res && res.durationMs ? res.durationMs : 0) / 1e3).toFixed(1);
      const count = res && res.subtitles ? res.subtitles.count : 0;
      setNote(`\u5DF2\u63D2\u5165 a1\uFF1A${seconds} \u79D2 \xB7 \u5B57\u5E55 ${count} \u6761${res && res.shifted ? "\uFF08\u64AD\u653E\u5934\u6709\u7247\u6BB5\uFF0C\u5DF2\u81EA\u52A8\u540E\u79FB\uFF09" : ""}`);
      toast(`\u914D\u97F3 ${seconds} \u79D2\uFF0C\u5DF2\u63D2\u5165 a1`, "info");
    } catch (e) {
      setReasons([e && e.message || "\u914D\u97F3\u5931\u8D25"]);
      reportError(e, "\u751F\u6210\u914D\u97F3\u5931\u8D25");
    } finally {
      setBusy(false);
      if (state.busy && state.busy.kind === "tts") setState({ busy: null });
    }
  }
  const line = (value, tone) => h2(
    "div",
    {
      style: {
        fontSize: 11,
        lineHeight: 1.6,
        opacity: 0.6,
        color: tone === "warn" ? T.warn : void 0
      }
    },
    value
  );
  return h2(
    "div",
    { style: { borderTop: `1px solid ${T.border}`, padding: "8px 10px" } },
    h2(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }, onClick: () => setOpen((v2) => !v2) },
      h2("strong", { style: { fontSize: 12, flex: 1 } }, "\u751F\u6210\u914D\u97F3" + (ready === false ? "\uFF08\u672A\u5C31\u7EEA\uFF09" : "")),
      h2("span", { style: { fontSize: 10, opacity: 0.45 } }, open ? stateLine : ""),
      h2("span", { style: { fontSize: 11, opacity: 0.5 } }, open ? "\u6536\u8D77" : "\u5C55\u5F00")
    ),
    open ? h2(
      "div",
      { style: { marginTop: 8, display: "flex", flexDirection: "column", gap: 6 } },
      h2("textarea", {
        value: text,
        rows: 4,
        maxLength: 2e3,
        placeholder: "\u8981\u914D\u97F3\u7684\u6587\u5B57\uFF1B\u9009\u4E2D\u4E00\u6761\u6587\u5B57\u7247\u6BB5\u4F1A\u81EA\u52A8\u5E26\u8FDB\u6765\u3002",
        onChange: (e) => setText(e.target.value),
        style: {
          width: "100%",
          boxSizing: "border-box",
          resize: "vertical",
          font: "inherit",
          fontSize: 12,
          lineHeight: 1.5,
          padding: "5px 7px",
          borderRadius: 6,
          color: T.text,
          background: T.fill,
          border: `1px solid ${T.border}`
        }
      }),
      h2(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, opacity: 0.6 } },
        h2("span", {}, `\u914D\u97F3\u6587\u672C ${chars}/2000 \u5B57`),
        selectedTextClip ? h2("span", {}, "\xB7 \u6765\u81EA\u9009\u4E2D\u7247\u6BB5") : h2("span", {}, "\xB7 \u76F4\u63A5\u8F93\u5165")
      ),
      h2(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 6 } },
        h2(
          "select",
          {
            value: voice,
            disabled: !voices.length,
            onChange: (e) => setVoice(e.target.value),
            style: {
              flex: 1,
              minWidth: 0,
              font: "inherit",
              fontSize: 11,
              padding: "3px 6px",
              borderRadius: 6,
              color: T.text,
              background: T.fill,
              border: `1px solid ${T.border}`
            }
          },
          voices.length ? voices.map(
            (v2) => h2(
              "option",
              { key: v2.id, value: v2.id },
              `${v2.name} \xB7 ${v2.gender === "male" ? "\u7537" : "\u5973"} \xB7 ${v2.style || v2.locale || ""}`
            )
          ) : h2("option", { value: "" }, "\u97F3\u8272\u5217\u8868\u672A\u52A0\u8F7D")
        )
      ),
      h2(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 11, opacity: 0.75 } },
        h2("span", { style: { width: 34 } }, "\u8BED\u901F"),
        h2("input", {
          type: "range",
          min: -20,
          max: 20,
          step: 5,
          value: rate,
          onChange: (e) => setRate(Number(e.target.value) || 0),
          style: { flex: 1, minWidth: 0 }
        }),
        h2("span", { style: { width: 40, textAlign: "right" } }, `${rate > 0 ? "+" : ""}${rate}%`)
      ),
      h2(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8 } },
        h2(
          "button",
          {
            type: "button",
            disabled: ready === false || busy || !chars,
            title: "\u5408\u6210\u540E\u81EA\u52A8\u63D2\u5165 a1\uFF0C\u5E76\u5728 t1 \u751F\u6210\u5BF9\u9F50\u5B57\u5E55\uFF1B\u4E00\u6B21\u4E8B\u52A1\uFF0C\u53EF\u64A4\u9500",
            onClick: generate,
            style: { ...btnStyle, opacity: ready === false || busy || !chars ? 0.5 : 1 }
          },
          busy ? "\u5408\u6210\u4E2D\u2026" : "\u751F\u6210\u914D\u97F3"
        ),
        h2("span", { style: { fontSize: 10, opacity: 0.45 } }, "\u8D77\u70B9 = \u64AD\u653E\u5934")
      ),
      ready === true ? line("\u7528\u5F53\u524D\u9009\u4E2D\u7684\u6587\u5B57\u7247\u6BB5\u4F5C\u4E3A\u9ED8\u8BA4\u6587\u672C\uFF1B\u751F\u6210\u540E\u81EA\u52A8\u63D2\u5165 a1 \u5E76\u751F\u6210\u5B57\u5E55\u3002") : null,
      note ? h2("div", { style: { fontSize: 11, color: T.ok } }, note) : null,
      shownReasons.length ? h2(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11,
            color: T.warn,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap"
          }
        },
        shownReasons.map((value, index) => h2("div", { key: index }, String(value)))
      ) : null
    ) : null
  );
}
function StylePanel({ projectId, sessionId, defaultOpen }) {
  const [open, setOpen] = import_react2.default.useState(defaultOpen == null ? true : !!defaultOpen);
  const [spec, setSpec] = import_react2.default.useState(null);
  const [summary, setSummary] = import_react2.default.useState("");
  const [reasons, setReasons] = import_react2.default.useState([]);
  const [warnings, setWarnings] = import_react2.default.useState([]);
  const [busy, setBusy] = import_react2.default.useState(null);
  const [note, setNote] = import_react2.default.useState("");
  const [frames, setFrames] = import_react2.default.useState([]);
  const [video, setVideo] = import_react2.default.useState(null);
  const [previewInfo, setPreviewInfo] = import_react2.default.useState(null);
  const [clickSpec, setClickSpec] = import_react2.default.useState(null);
  const [clickFallback, setClickFallback] = import_react2.default.useState(null);
  const [highlight, setHighlight] = import_react2.default.useState(null);
  const stampRef = import_react2.default.useRef(0);
  const videoRef = import_react2.default.useRef(null);
  const audioRef = import_react2.default.useRef(null);
  import_react2.default.useEffect(() => {
    if (!open) return void 0;
    let cancelled = false;
    (async () => {
      try {
        const value = await rpc("style.default", {});
        if (cancelled) return;
        setSpec(value.spec);
        setSummary(value.summary || specToSummary(value.spec));
      } catch (e) {
        if (!cancelled) setReasons([e && e.message || "\u8BFB\u53D6\u9ED8\u8BA4\u98CE\u683C\u5931\u8D25"]);
        return;
      }
      try {
        const existing = await rpc("style.result", { projectId, sessionId });
        if (cancelled || !existing) return;
        applyArtifacts(existing, "last");
        setSummary(existing.summary || summary);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, sessionId]);
  function applyArtifacts(value, stamp3) {
    const token = String(stamp3);
    stampRef.current = token;
    setFrames(
      (value.frameDetails || []).map((frame) => ({
        index: frame.index,
        kind: frame.kind,
        label: frame.label || SHOT_LABELS[frame.kind] || frame.kind,
        bytes: frame.bytes,
        relPath: frame.relPath,
        url: styleFileUrl(frame.relPath, token)
      }))
    );
    setVideo(
      value.video ? { relPath: value.video.relPath, bytes: value.video.bytes, url: styleFileUrl(value.video.relPath, token) } : null
    );
    setClickSpec(value.click || null);
    setClickFallback(
      value.clickPath ? { relPath: value.clickPath, url: styleFileUrl(value.clickPath, token) } : null
    );
  }
  async function uploadClickTrack(bytes2) {
    const params = new URLSearchParams({
      projectId: String(projectId || ""),
      sessionId: String(sessionId || ""),
      kind: "click"
    });
    const res = await fetch("/api/video/style-upload?" + params.toString(), {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes2
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload || !payload.ok) {
      throw new Error(payload && payload.error && payload.error.message || "\u8282\u62CD\u97F3\u8F68\u4E0A\u4F20\u5931\u8D25");
    }
    return payload.value;
  }
  function patchSpec(mutate) {
    const base = spec || {};
    const next = JSON.parse(JSON.stringify(base));
    mutate(next);
    setSpec(next);
    const checked = validateStyleSpec(next);
    setReasons(checked.ok ? [] : checked.reasons);
    setWarnings(checked.warnings || []);
    setSummary(specToSummary(next));
  }
  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      if (typeof canvas.toBlob === "function") {
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("\u753B\u5E03\u65E0\u6CD5\u5BFC\u51FA PNG")), "image/png");
        return;
      }
      try {
        const base64 = String(canvas.toDataURL("image/png")).split(",")[1] || "";
        const bin = typeof atob === "function" ? atob(base64) : "";
        const bytes2 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes2[i] = bin.charCodeAt(i);
        resolve(new Blob([bytes2], { type: "image/png" }));
      } catch (e) {
        reject(e);
      }
    });
  }
  async function renderKeyframe(shot, specValue, shots) {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx2 = canvas.getContext("2d", { alpha: false });
    if (!ctx2) throw new Error("\u5F53\u524D\u73AF\u5883\u65E0\u6CD5\u521B\u5EFA 2D \u753B\u5E03");
    drawStyleFrame(ctx2, { width: canvas.width, height: canvas.height, spec: specValue, shots, t: shot.keyframeAt });
    return canvasToPngBlob(canvas);
  }
  async function exportSample(specValue, shots, duration, bpm, onProgress) {
    const { probeEncoders: probeEncoders2, chooseExportPlan: chooseExportPlan2 } = await Promise.resolve().then(() => (init_codec_caps(), codec_caps_exports));
    const caps = await probeEncoders2();
    const plan = chooseExportPlan2(caps);
    const mod = await Promise.resolve().then(() => (init_exporter(), exporter_exports));
    const width = 1280;
    const height = 720;
    const fps = 30;
    const track2 = buildClickTrack(shots, { bpm });
    const result = await mod.exportTimeline({
      title: "style-preview",
      duration,
      projectFps: fps,
      fps,
      width,
      height,
      plan,
      range: { start: 0, end: duration },
      audioBuffer: track2,
      drawFrame: (ctx2, t, w, h4) => drawStyleFrame(ctx2, { width: w, height: h4, spec: specValue, shots, t }),
      onProgress
    });
    return {
      blob: result.blob,
      container: result.container || "mp4",
      audioBytes: result.audioBytes || 0,
      audioCodec: result.audioCodec || null,
      audioWarning: result.audioWarning || "",
      track: track2
    };
  }
  async function generate() {
    if (busy) return;
    const checked = validateStyleSpec(spec || {});
    setReasons(checked.ok ? [] : checked.reasons);
    setWarnings(checked.warnings || []);
    if (!checked.ok) {
      toast(`\u98CE\u683C\u6709 ${checked.reasons.length} \u5904\u95EE\u9898\uFF0C\u89C1\u9762\u677F\u4E0B\u65B9`, "warn");
      return;
    }
    setBusy({ label: "\u51C6\u5907\u9884\u89C8\u5DE5\u7A0B", ratio: 0.05 });
    setState({ busy: { label: "\u98CE\u683C\u6837\u7247 \xB7 \u51C6\u5907", ratio: 0.05, kind: "style" } });
    setNote("");
    setHighlight(null);
    let mp4Error = "";
    let audioError = "";
    let audioMuxed = false;
    let audioFallbackOk = false;
    try {
      const value = await rpc("style.preview", { projectId, sessionId, spec: checked.spec });
      const shots = value.shots || [];
      setPreviewInfo(value.preview || null);
      setClickSpec(value.click || null);
      const bpm = value.click && value.click.bpm || bpmFromRhythm(value.requestedShotSeconds).bpm;
      const stamp3 = Date.now();
      stampRef.current = String(stamp3);
      for (let i = 0; i < shots.length; i += 1) {
        const shot = shots[i];
        const ratio = 0.08 + i / Math.max(1, shots.length) * 0.22;
        setBusy({ label: `\u6E32\u67D3\u5173\u952E\u5E27 ${i + 1}/${shots.length}`, ratio });
        setState({ busy: { label: `\u98CE\u683C\u6837\u7247 \xB7 \u5173\u952E\u5E27 ${i + 1}/${shots.length}`, ratio, kind: "style" } });
        const blob = await renderKeyframe(shot, value.spec, shots);
        await uploadStyleAsset(blob, { kind: "frame", index: shot.index, shotKind: shot.kind });
      }
      setBusy({ label: "\u5408\u6210 8 \u79D2\u6837\u7247", ratio: 0.35 });
      try {
        const exported = await exportSample(value.spec, shots, value.duration, bpm, (p) => {
          const ratio = 0.35 + Math.max(0, Math.min(1, Number(p.ratio) || 0)) * 0.6;
          setBusy({ label: `\u6837\u7247 \xB7 ${p.phase || "\u7F16\u7801"}`, ratio });
          setState({ busy: { label: "\u98CE\u683C\u6837\u7247 \xB7 \u7F16\u7801", ratio, kind: "style" } });
        });
        await uploadStyleAsset(exported.blob, { kind: "video", container: exported.container });
        audioMuxed = (exported.audioBytes || 0) > 0;
        if (!audioMuxed) {
          try {
            await uploadClickTrack(clickTrackToWav(exported.track));
            audioFallbackOk = true;
          } catch (e) {
            audioError = e && e.message || "\u8282\u62CD\u97F3\u8F68\u4E0A\u4F20\u5931\u8D25";
          }
        }
      } catch (e) {
        mp4Error = e && e.message || "\u6837\u7247\u5BFC\u51FA\u5931\u8D25";
      }
      const result = await rpc("style.result", { projectId, sessionId });
      applyArtifacts(result, stamp3);
      setSummary(result.summary || summary);
      const framesOk = (result.frameDetails || []).length;
      let text;
      if (mp4Error) {
        text = `4 \u5F20\u5173\u952E\u5E27\u5DF2\u751F\u6210\uFF08${framesOk}/4\uFF09\uFF0C8 \u79D2\u6837\u7247\u6CA1\u5BFC\u51FA\u6765\uFF1A${mp4Error}`;
      } else if (audioMuxed) {
        text = `\u5DF2\u751F\u6210 ${framesOk} \u5F20\u5173\u952E\u5E27\u4E0E 8 \u79D2\u6837\u7247\uFF08720p \xB7 30fps\uFF0C\u97F3\u8F68\u542B\u8282\u62CD ${bpm} BPM\uFF09`;
      } else if (audioFallbackOk) {
        text = `\u5DF2\u751F\u6210 ${framesOk} \u5F20\u5173\u952E\u5E27\u4E0E 8 \u79D2\u6837\u7247\uFF08720p \xB7 30fps\uFF09\uFF1B\u8FD9\u53F0\u673A\u5668\u6DF7\u4E0D\u8FDB\u97F3\u8F68\uFF0C\u8282\u62CD\u5355\u72EC\u5B58\u6210 WAV \u2014\u2014 \u7528\u300C\u64AD\u653E\u8282\u62CD\u300D\u548C\u6837\u7247\u540C\u65F6\u64AD`;
      } else {
        text = `\u5DF2\u751F\u6210 ${framesOk} \u5F20\u5173\u952E\u5E27\u4E0E 8 \u79D2\u6837\u7247\uFF08720p \xB7 30fps\uFF09\uFF1B\u8282\u62CD\u65E2\u6CA1\u6DF7\u8FDB\u53BB\u4E5F\u6CA1\u5B58\u4E0B\u6765\uFF1A${audioError || "\u539F\u56E0\u672A\u77E5"}`;
      }
      setNote(text);
      toast(mp4Error ? "\u5173\u952E\u5E27\u5DF2\u751F\u6210\uFF0C\u6837\u7247\u5BFC\u51FA\u5931\u8D25" : "\u98CE\u683C\u6837\u7247\u5DF2\u751F\u6210", mp4Error ? "warn" : "info");
    } catch (e) {
      reportError(e, "\u751F\u6210\u98CE\u683C\u6837\u7247\u5931\u8D25");
    } finally {
      setBusy(null);
      if (state.busy && state.busy.kind === "style") setState({ busy: null });
    }
  }
  function playClickTogether() {
    const video2 = videoRef.current;
    const audio = audioRef.current;
    if (video2) {
      try {
        video2.currentTime = 0;
        const played = video2.play();
        if (played && played.catch) played.catch(() => {
        });
      } catch {
      }
    }
    if (audio) {
      try {
        audio.currentTime = 0;
        const played = audio.play();
        if (played && played.catch) played.catch(() => {
        });
      } catch {
      }
    }
  }
  const row = (label, control) => h2(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 11 } },
    h2("span", { style: { width: 52, flex: "0 0 auto", opacity: 0.6 } }, label),
    control
  );
  const selectStyle = {
    flex: 1,
    minWidth: 0,
    font: "inherit",
    fontSize: 11,
    padding: "3px 6px",
    borderRadius: 6,
    color: T.text,
    background: T.fill,
    border: `1px solid ${T.border}`
  };
  const palette = spec && spec.palette || { accent: "#4FD1C5" };
  const density = spec && spec.motionDensity || "med";
  const rhythm = spec && spec.rhythm || { shotSeconds: 2 };
  const family = spec && spec.font && spec.font.family || FONT_CHOICES[0].family;
  const alignment = import_react2.default.useMemo(() => {
    if (!spec) return null;
    const checkedNow = validateStyleSpec(spec);
    if (!checkedNow.ok) return null;
    try {
      return alignmentForSpec(checkedNow.spec);
    } catch {
      return null;
    }
  }, [spec]);
  const bpmInfo = bpmFromRhythm(rhythm.shotSeconds);
  const beatsPerShot = Math.round((Number(rhythm.shotSeconds) || 2) * bpmInfo.bpm / 60 * 10) / 10;
  const highlightKind = highlight || null;
  return h2(
    "div",
    { style: { borderTop: `1px solid ${T.border}`, padding: "8px 10px" } },
    h2(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }, onClick: () => setOpen((v2) => !v2) },
      h2("strong", { style: { fontSize: 12, flex: 1 } }, "\u98CE\u683C\u786E\u8BA4 \xB7 \u6837\u7247"),
      h2("span", { style: { fontSize: 10, opacity: 0.45 } }, open ? `${PREVIEW_SECONDS} \u79D2 \xB7 4 \u955C` : ""),
      h2("span", { style: { fontSize: 11, opacity: 0.5 } }, open ? "\u6536\u8D77" : "\u5C55\u5F00")
    ),
    open ? h2(
      "div",
      { style: { marginTop: 8, display: "flex", flexDirection: "column", gap: 6 } },
      h2(
        "div",
        {
          style: {
            fontSize: 11,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            padding: "6px 8px",
            borderRadius: 6,
            background: T.fill,
            border: `1px solid ${T.border}`,
            opacity: 0.85
          }
        },
        summary || "\u6B63\u5728\u8BFB\u53D6\u9ED8\u8BA4\u98CE\u683C\u2026"
      ),
      row(
        "\u4E3B\u8272",
        h2("input", {
          type: "color",
          value: String(palette.accent || "#4FD1C5"),
          onChange: (e) => patchSpec((next) => {
            next.palette = next.palette || {};
            next.palette.accent = String(e.target.value || "").toUpperCase();
          }),
          style: { width: 40, height: 22, padding: 0, border: "none", background: "transparent" }
        })
      ),
      row(
        "\u5B57\u4F53",
        h2(
          "select",
          {
            value: family,
            onChange: (e) => patchSpec((next) => {
              next.font = next.font || {};
              next.font.family = e.target.value;
            }),
            style: selectStyle
          },
          FONT_CHOICES.map((choice) => h2("option", { key: choice.id, value: choice.family }, choice.label))
        )
      ),
      row(
        "\u5BC6\u5EA6",
        h2(
          "select",
          {
            value: density,
            onChange: (e) => patchSpec((next) => {
              next.motionDensity = e.target.value;
            }),
            style: selectStyle
          },
          DENSITIES.map(
            (id) => h2("option", { key: id, value: id }, `${DENSITY_LABELS[id]}\uFF08${id}\uFF09`)
          )
        )
      ),
      row(
        "\u8282\u594F",
        h2(
          "select",
          {
            value: String(rhythm.shotSeconds),
            onChange: (e) => patchSpec((next) => {
              next.rhythm = next.rhythm || {};
              next.rhythm.shotSeconds = Number(e.target.value);
            }),
            style: selectStyle
          },
          [1, 1.5, 2, 2.5, 3].map((seconds) => h2("option", { key: seconds, value: String(seconds) }, `${seconds} \u79D2/\u955C`))
        )
      ),
      row(
        "\u8282\u62CD",
        h2(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 } },
          h2(
            "span",
            { style: { fontSize: 11 } },
            `${bpmInfo.bpm} BPM \xB7 \u6BCF\u955C ${beatsPerShot} \u62CD`
          ),
          h2(
            "span",
            { style: { fontSize: 10, opacity: 0.45, lineHeight: 1.4 } },
            "\u8282\u62CD\u4EC5\u7528\u4E8E\u786E\u8BA4\u8282\u594F\uFF0C\u4E0D\u8FDB\u5165\u6210\u7247\u3002"
          )
        )
      ),
      h2(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8 } },
        h2(
          "button",
          {
            type: "button",
            disabled: !!busy || !spec,
            title: "\u5728\u4E34\u65F6\u9884\u89C8\u5DE5\u7A0B\u91CC\u94FA 4 \u4E2A\u955C\u5934\uFF0C\u753B 4 \u5F20\u5173\u952E\u5E27\u5E76\u5BFC\u51FA 8 \u79D2\u6837\u7247",
            onClick: generate,
            style: { ...btnStyle, opacity: busy || !spec ? 0.5 : 1 }
          },
          busy ? busy.label : "\u751F\u6210\u6837\u7247"
        ),
        h2(
          "span",
          { style: { fontSize: 10, opacity: 0.45, flex: 1 } },
          `\u6837\u7247\u56FA\u5B9A ${PREVIEW_SECONDS} \u79D2\uFF084\xD72s\uFF09+ 720p/30fps\uFF1B\u8282\u594F\u53EA\u5F71\u54CD\u6B63\u5F0F\u65F6\u95F4\u7EBF`
        )
      ),
      busy ? h2(
        "div",
        { style: { height: 3, borderRadius: 2, background: T.fillStrong, overflow: "hidden" } },
        h2("div", {
          style: {
            height: "100%",
            width: `${Math.round((busy.ratio || 0) * 100)}%`,
            background: T.accent,
            transition: "width .2s linear"
          }
        })
      ) : null,
      frames.length ? h2(
        "div",
        { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 } },
        frames.map((frame) => {
          const on = highlightKind === frame.kind;
          return h2(
            "div",
            { key: frame.relPath, style: { display: "flex", flexDirection: "column", gap: 2 } },
            h2("img", {
              src: frame.url,
              alt: frame.label,
              onClick: () => setHighlight(on ? null : frame.kind),
              style: {
                width: "100%",
                display: "block",
                borderRadius: 6,
                cursor: "pointer",
                border: "1px solid " + (on ? T.warn : T.border),
                outline: on ? `2px solid ${T.warn}` : "none",
                background: "#000"
              }
            }),
            h2(
              "span",
              { style: { fontSize: 10, opacity: on ? 0.95 : 0.5 } },
              on ? frame.label + " \u2190 \u5BF9\u9F50\u68C0\u67E5\u547D\u4E2D" : frame.label
            )
          );
        })
      ) : null,
      alignment ? h2(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 3, marginTop: 2 } },
        h2(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11 } },
          h2("span", { style: { fontWeight: 600 } }, "\u5BF9\u9F50\u68C0\u67E5"),
          h2(
            "span",
            {
              style: {
                fontSize: 10,
                color: alignment.ok && alignment.issues.length === 0 ? T.ok : T.warn
              }
            },
            alignment.ok && alignment.issues.length === 0 ? `${alignment.summary.total} \u9879\u901A\u8FC7` : `${alignment.summary.failed}/${alignment.summary.total} \u9879\u6709\u95EE\u9898 \xB7 ${alignment.issues.length} \u6761`
          ),
          h2("span", { style: { flex: 1 } }),
          h2(
            "button",
            {
              type: "button",
              onClick: () => setHighlight(null),
              style: { ...btnStyle, padding: "1px 6px", fontSize: 10, opacity: highlightKind ? 1 : 0.4 }
            },
            "\u53D6\u6D88\u9AD8\u4EAE"
          )
        ),
        alignment.issues.length ? h2(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 3 } },
          alignment.issues.map(
            (issue, index) => h2(
              "button",
              {
                key: issue.code + "-" + index,
                type: "button",
                title: issue.shotKind ? "\u70B9\u4E00\u4E0B\u9AD8\u4EAE\u5BF9\u5E94\u5173\u952E\u5E27" : "\u8FD9\u662F\u5168\u5C40\u95EE\u9898\uFF08\u4E0E\u5177\u4F53\u955C\u5934\u65E0\u5173\uFF09",
                onClick: () => {
                  if (issue.shotKind) setHighlight(highlightKind === issue.shotKind ? null : issue.shotKind);
                },
                style: {
                  textAlign: "left",
                  font: "inherit",
                  fontSize: 10,
                  lineHeight: 1.5,
                  padding: "3px 6px",
                  borderRadius: 5,
                  cursor: issue.shotKind ? "pointer" : "default",
                  color: issue.severity === "error" ? T.danger : T.warn,
                  background: issue.shotKind && highlightKind === issue.shotKind ? T.fillStrong : T.fill,
                  border: "1px solid " + (issue.shotKind && highlightKind === issue.shotKind ? T.borderStrong : T.border)
                }
              },
              (issue.severity === "error" ? "\u2715 " : "! ") + issue.message
            )
          )
        ) : null
      ) : null,
      video ? h2(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 2 } },
        h2("video", {
          ref: videoRef,
          src: video.url,
          controls: true,
          loop: true,
          playsInline: true,
          style: {
            width: "100%",
            display: "block",
            borderRadius: 6,
            border: `1px solid ${T.border}`,
            background: "#000"
          }
        }),
        h2(
          "span",
          { style: { fontSize: 10, opacity: 0.5 } },
          `${PREVIEW_SECONDS} \u79D2\u6837\u7247 \xB7 ${Math.max(1, Math.round((video.bytes || 0) / 1024))} KB` + (clickSpec ? ` \xB7 \u8282\u62CD ${clickSpec.bpm} BPM` : "")
        ),
        h2(
          "span",
          { style: { fontSize: 10, opacity: 0.45, lineHeight: 1.5 } },
          clickSpec ? `\u8282\u62CD\u4EC5\u7528\u4E8E\u786E\u8BA4\u8282\u594F\uFF0C\u4E0D\u8FDB\u5165\u6210\u7247\uFF08${clickSpec.bpm} BPM \xB7 \u5F3A\u62CD ${clickSpec.strongHz}Hz / \u5F31\u62CD ${clickSpec.weakHz}Hz \xB7 \u5CF0\u503C ${clickSpec.peakDbfs}dBFS\uFF09\u3002` : "\u8282\u62CD\u4EC5\u7528\u4E8E\u786E\u8BA4\u8282\u594F\uFF0C\u4E0D\u8FDB\u5165\u6210\u7247\u3002"
        )
      ) : null,
      clickFallback ? h2(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 10, opacity: 0.7 } },
        h2(
          "button",
          { type: "button", style: { ...btnStyle, padding: "2px 8px" }, onClick: playClickTogether },
          "\u64AD\u653E\u8282\u62CD"
        ),
        h2("span", { style: { flex: 1, minWidth: 0 } }, "\u6837\u7247\u91CC\u6CA1\u6709\u97F3\u8F68\uFF0C\u8282\u62CD\u5728\u72EC\u7ACB\u7684 WAV \u91CC\uFF1B\u70B9\u5B83\u4E24\u4E2A\u4E00\u8D77\u4ECE\u5934\u64AD\u3002"),
        h2("audio", { ref: audioRef, src: clickFallback.url, preload: "auto", style: { display: "none" } })
      ) : null,
      previewInfo ? h2(
        "div",
        { style: { fontSize: 10, opacity: 0.45, lineHeight: 1.5 } },
        `\u9884\u89C8\u5DE5\u7A0B\uFF1A${previewInfo.relDir} \xB7 ${previewInfo.clipCount} \u4E2A\u955C\u5934 \xB7 ${previewInfo.duration} \u79D2`
      ) : null,
      note ? h2("div", { style: { fontSize: 11, color: mp4Color(note) } }, note) : null,
      reasons.length ? h2(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 3,
            fontSize: 11,
            color: T.danger,
            lineHeight: 1.5
          }
        },
        reasons.map((text, index) => h2("div", { key: index }, "\xB7 " + text))
      ) : null,
      warnings.length ? h2(
        "div",
        { style: { fontSize: 10, opacity: 0.5, lineHeight: 1.5 } },
        warnings.slice(0, 4).map((text, index) => h2("div", { key: index }, text))
      ) : null
    ) : null
  );
}
function mp4Color(text) {
  return /失败|没导出来/.test(String(text)) ? T.warn : T.ok;
}
var STAGE_ROWS = [
  { id: "idle", label: "\u672A\u5F00\u59CB" },
  { id: "clarify", label: "\u8865 brief" },
  { id: "style", label: "\u5B9A\u98CE\u683C" },
  { id: "locked", label: "\u9501\u98CE\u683C" },
  { id: "build", label: "\u751F\u4EA7" }
];
var STAGE_POLL_MS = 5e3;
var STYLE_PREVIEW_PREFIX = previewLayout().relDir + "/";
function stageStamp(value) {
  if (typeof value !== "string" || value.trim() === "") return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const pad2 = (n) => n < 10 ? "0" + n : String(n);
  return `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}
function stageReachedAt(history, stage) {
  let last2 = "";
  for (const entry of history || []) {
    if (entry && entry.stage === stage && entry.at) last2 = entry.at;
  }
  return last2;
}
function stageNote(text, tone) {
  return h2(
    "div",
    {
      style: {
        fontSize: 10,
        lineHeight: 1.55,
        opacity: tone ? 1 : 0.55,
        color: tone === "warn" ? T.warn : tone === "danger" ? T.danger : void 0,
        wordBreak: "break-word"
      }
    },
    text
  );
}
function StagePanel({ projectId, sessionId, defaultOpen }) {
  const [open, setOpen] = import_react2.default.useState(defaultOpen == null ? true : !!defaultOpen);
  const [data, setData] = import_react2.default.useState(null);
  const [failure, setFailure] = import_react2.default.useState("");
  const [expanded, setExpanded] = import_react2.default.useState(null);
  import_react2.default.useEffect(() => {
    if (!open || !projectId) return void 0;
    let cancelled = false;
    let timer = null;
    const hidden = () => typeof document !== "undefined" && document && document.visibilityState === "hidden";
    const stop = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const schedule2 = () => {
      if (cancelled) return;
      stop();
      timer = setTimeout(pull, STAGE_POLL_MS);
    };
    async function pull() {
      if (cancelled || hidden()) return;
      try {
        const value = await rpc("brief.state", { projectId, sessionId });
        if (cancelled) return;
        setData(value || null);
        setFailure("");
      } catch (e) {
        if (cancelled) return;
        setFailure(e && e.message || "\u8BFB\u53D6\u5F00\u5DE5\u9636\u6BB5\u5931\u8D25");
      }
      schedule2();
    }
    function onVisibility() {
      if (hidden()) {
        stop();
        return;
      }
      stop();
      pull();
    }
    setData(null);
    setFailure("");
    setExpanded(null);
    pull();
    if (typeof document !== "undefined" && document && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      cancelled = true;
      stop();
      if (typeof document !== "undefined" && document && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [open, projectId, sessionId]);
  if (!projectId) return null;
  const snapshot = data && typeof data === "object" ? data : {};
  const stage = typeof snapshot.stage === "string" ? snapshot.stage : "idle";
  const stageIndex = Math.max(0, STAGE_ROWS.findIndex((row) => row.id === stage));
  const slots = Array.isArray(snapshot.slots) ? snapshot.slots : [];
  const filledSlots = slots.filter((slot) => slot && slot.filled);
  const missingSlots = slots.filter((slot) => slot && !slot.filled);
  const history = Array.isArray(snapshot.history) ? snapshot.history : [];
  const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : [];
  const blocked = Array.isArray(snapshot.blocked) ? snapshot.blocked : [];
  const style = snapshot.style && typeof snapshot.style === "object" ? snapshot.style : null;
  const stylePreview = style && style.preview && typeof style.preview === "object" ? style.preview : {};
  const keyframes = Array.isArray(stylePreview.keyframes) ? stylePreview.keyframes : [];
  const clipPath = typeof stylePreview.clip === "string" ? stylePreview.clip : "";
  const since = stageStamp(snapshot.since);
  const readyCount = slots.length > 0 ? `${filledSlots.length}/${slots.length}` : snapshot.filled != null && snapshot.total != null ? `${snapshot.filled}/${snapshot.total}` : "";
  const header = h2(
    "div",
    {
      style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" },
      onClick: () => setOpen((v2) => !v2)
    },
    h2("strong", { style: { fontSize: 12, flex: 1 } }, "\u5F00\u5DE5\u9636\u6BB5"),
    readyCount ? chip(`brief ${readyCount}`) : null,
    snapshot.stageSource === "inferred" ? chip("\u6309\u4E8B\u5B9E\u63A8\u65AD", "warn") : null,
    snapshot.consistency === "state-ahead-of-facts" ? chip("\u72B6\u6001\u9886\u5148\u4E8B\u5B9E", "warn") : null,
    h2("span", { style: { fontSize: 11, opacity: 0.5 } }, open ? "\u6536\u8D77" : "\u5C55\u5F00")
  );
  if (!open) {
    return h2("div", { style: { borderTop: `1px solid ${T.border}`, padding: "8px 10px" } }, header);
  }
  if (!data && failure) {
    return h2(
      "div",
      { style: { borderTop: `1px solid ${T.border}`, padding: "8px 10px" } },
      header,
      h2("div", { style: { marginTop: 6 } }, stageNote("\u8BFB\u53D6\u5F00\u5DE5\u9636\u6BB5\u5931\u8D25\uFF1A" + failure, "danger"))
    );
  }
  if (!data) {
    return h2(
      "div",
      { style: { borderTop: `1px solid ${T.border}`, padding: "8px 10px" } },
      header,
      h2("div", { style: { marginTop: 6 } }, stageNote("\u8BFB\u53D6\u4E2D\u2026"))
    );
  }
  const stageRow = STAGE_ROWS[stageIndex];
  return h2(
    "div",
    { style: { borderTop: `1px solid ${T.border}`, padding: "8px 10px" } },
    header,
    // 五段进度条：已过 = 淡蓝，当前 = 亮蓝加高；悬停看每一段到达的时间。
    h2(
      "div",
      { style: { marginTop: 8, display: "flex", gap: 3, alignItems: "flex-end" } },
      STAGE_ROWS.map((row, index) => {
        const reached = index <= stageIndex;
        const current = index === stageIndex;
        const at = stageReachedAt(history, row.id);
        return h2("div", {
          key: row.id,
          title: `${row.label}\uFF08${row.id}\uFF09${at ? " \xB7 " + stageStamp(at) : " \xB7 \u8FD8\u6CA1\u5230"}`,
          style: {
            flex: 1,
            height: current ? 8 : 5,
            borderRadius: 3,
            background: current ? T.accent : reached ? T.accentDim : T.fillStrong,
            transition: "height .15s"
          }
        });
      })
    ),
    h2(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 10 } },
      h2("span", { style: { color: T.accent } }, stageRow.label),
      h2("span", { style: { opacity: 0.45 } }, stage),
      since ? h2("span", { style: { opacity: 0.45 } }, "\xB7 \u81EA " + since) : null,
      h2("span", { style: { flex: 1 } }),
      h2("span", { style: { opacity: 0.4 } }, "\u53EA\u8BFB \xB7 \u5199\u5165\u627E agent")
    ),
    // 10 个槽位小方格：亮 = 已填。
    slots.length ? h2(
      "div",
      { style: { marginTop: 8, display: "flex", gap: 3 } },
      slots.map(
        (slot) => h2("div", {
          key: slot.id,
          title: `${slot.title} \xB7 ${slot.filled ? "\u5DF2\u586B" : "\u672A\u586B"}`,
          style: {
            flex: 1,
            height: 10,
            borderRadius: 2,
            background: slot.filled ? T.ok : "transparent",
            border: slot.filled ? "1px solid transparent" : `1px dashed ${T.borderStrong}`,
            opacity: slot.filled ? 0.8 : 0.7
          }
        })
      )
    ) : null,
    missingSlots.length ? h2(
      "div",
      { style: { marginTop: 6, fontSize: 10, lineHeight: 1.5, color: T.warn } },
      "\u8FD8\u7F3A\uFF1A" + missingSlots.map((slot) => slot.title).join("\u3001")
    ) : h2("div", { style: { marginTop: 6, fontSize: 10, color: T.ok } }, "brief 10/10 \u5DF2\u9F50"),
    // 已填的槽位：点开看原文（缺的只列名字，没有原文可看）。
    filledSlots.length ? h2(
      "div",
      { style: { marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 } },
      filledSlots.map(
        (slot) => h2(
          "span",
          {
            key: slot.id,
            title: "\u70B9\u4E00\u4E0B\u770B\u539F\u6587",
            onClick: () => setExpanded((prev) => prev === slot.id ? null : slot.id),
            style: {
              fontSize: 10,
              padding: "1px 6px",
              borderRadius: 4,
              cursor: "pointer",
              color: expanded === slot.id ? T.text : T.textDim,
              background: expanded === slot.id ? T.fillStrong : T.fill,
              border: `1px solid ${T.border}`,
              whiteSpace: "nowrap"
            }
          },
          slot.title
        )
      )
    ) : null,
    expanded && slots.some((slot) => slot.id === expanded && slot.filled) ? h2(
      "div",
      {
        style: {
          marginTop: 5,
          padding: "5px 7px",
          fontSize: 11,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 140,
          overflowY: "auto",
          color: T.textDim,
          background: T.fill,
          border: `1px solid ${T.borderFaint}`,
          borderRadius: 6
        }
      },
      (slots.find((slot) => slot.id === expanded) || {}).value || ""
    ) : null,
    // 风格：未确认就只说明下一步；确认了给 spec 摘要 + 四宫格关键帧 + 8 秒样片。
    h2(
      "div",
      { style: { marginTop: 10, paddingTop: 8, borderTop: `1px solid ${T.borderFaint}` } },
      style ? h2(
        "div",
        null,
        h2(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 10 } },
          h2("span", { style: { color: T.ok } }, "\u98CE\u683C\u5DF2\u786E\u8BA4"),
          h2("span", { style: { opacity: 0.45 } }, stageStamp(style.confirmedAt))
        ),
        h2(
          "div",
          { style: { marginTop: 4, fontSize: 11, lineHeight: 1.6, color: T.textDim } },
          style.spec && style.spec.tone ? style.spec.tone : ""
        ),
        h2(
          "div",
          { style: { marginTop: 3, display: "flex", alignItems: "center", gap: 6, fontSize: 10, flexWrap: "wrap" } },
          h2("span", { style: { opacity: 0.45 } }, "\u5B57\u4F53"),
          h2("span", {}, style.spec && style.spec.font || "\u2014"),
          h2("span", { style: { opacity: 0.45 } }, "\u5BC6\u5EA6"),
          h2("span", {}, style.spec && style.spec.density || "\u2014"),
          h2("span", { style: { opacity: 0.45 } }, "\u8282\u594F"),
          h2("span", {}, style.spec && style.spec.pace ? `${style.spec.pace}s/\u955C` : "\u2014"),
          ...(style.spec && Array.isArray(style.spec.palette) ? style.spec.palette : []).slice(0, 12).map(
            (color, index) => h2("span", {
              key: "c" + index,
              title: color,
              style: {
                width: 10,
                height: 10,
                borderRadius: 2,
                background: color,
                border: `1px solid ${T.border}`
              }
            })
          )
        ),
        keyframes.length ? h2(
          "div",
          {
            style: {
              marginTop: 6,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 4
            }
          },
          keyframes.slice(0, 4).map(
            (relPath, index) => String(relPath).startsWith(STYLE_PREVIEW_PREFIX) ? h2("img", {
              key: "k" + index,
              src: styleFileUrlFor(projectId, relPath, style.confirmedAt || ""),
              alt: `\u5173\u952E\u5E27 ${index + 1}`,
              style: {
                width: "100%",
                height: 48,
                objectFit: "cover",
                borderRadius: 4,
                background: T.fillStrong,
                border: `1px solid ${T.border}`
              }
            }) : h2(
              "div",
              {
                key: "k" + index,
                title: relPath,
                style: {
                  height: 48,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 9,
                  opacity: 0.5,
                  borderRadius: 4,
                  background: T.fillStrong,
                  border: `1px dashed ${T.border}`
                }
              },
              "\u4E0D\u5728\u9884\u89C8\u76EE\u5F55"
            )
          )
        ) : null,
        keyframes.length && keyframes.some((relPath) => !String(relPath).startsWith(STYLE_PREVIEW_PREFIX)) ? stageNote("\u6709\u8DEF\u5F84\u4E0D\u5728 .dsh-video/style-preview/ \u4E0B\uFF0C\u9762\u677F\u8BFB\u4E0D\u5230\u90A3\u4E9B\u56FE\uFF08\u8D8A\u754C\u8DEF\u5F84\u5DF2\u5728 host \u4FA7\u8FC7\u6EE4\uFF09\u3002") : null,
        clipPath ? String(clipPath).startsWith(STYLE_PREVIEW_PREFIX) ? h2("video", {
          src: styleFileUrlFor(projectId, clipPath, style.confirmedAt || ""),
          controls: true,
          muted: true,
          playsInline: true,
          style: {
            width: "100%",
            marginTop: 6,
            borderRadius: 6,
            background: "#000",
            display: "block"
          }
        }) : stageNote("\u6837\u7247\u4E0D\u5728\u9884\u89C8\u76EE\u5F55\uFF0C\u9762\u677F\u8BFB\u4E0D\u5230\uFF1A" + clipPath) : stageNote("\u8FD9\u4E00\u7248\u6CA1\u6709 8 \u79D2\u6837\u7247\uFF08video_style_confirm \u7684 preview.clip \u4E3A\u7A7A\uFF09\u3002")
      ) : stageNote("\u98CE\u683C\u672A\u786E\u8BA4\uFF1A\u8BA9 agent \u8C03 video_style_confirm \u8BB0\u5F55 tone / palette / font / density / pace\u3002")
    ),
    // 底部：下一步 + 被拦住的类别。写操作一律指向 agent 工具。
    h2(
      "div",
      { style: { marginTop: 10, paddingTop: 8, borderTop: `1px solid ${T.borderFaint}` } },
      h2(
        "div",
        { style: { fontSize: 11, lineHeight: 1.6, color: T.text } },
        snapshot.nextStep || "\u6682\u65E0\u4E0B\u4E00\u6B65\u63D0\u793A"
      ),
      blocked.length ? h2(
        "div",
        { style: { marginTop: 4, fontSize: 10, lineHeight: 1.6, color: T.warn } },
        blocked.map((item, index) => h2("div", { key: index }, "\xB7 " + item))
      ) : null,
      warnings.length ? h2(
        "div",
        { style: { marginTop: 4 } },
        warnings.slice(0, 4).map((text, index) => h2("div", { key: index }, stageNote("\xB7 " + text)))
      ) : null,
      failure ? h2("div", { style: { marginTop: 4 } }, stageNote("\u8F6E\u8BE2\u5931\u8D25\uFF1A" + failure, "danger")) : null
    )
  );
}
function Inspector(props) {
  const annotations = Array.isArray(props.annotations) ? props.annotations : [];
  const selection = props.selection || null;
  const selectedAnnotationId = selection && selection.kind === "annotation" ? selection.id : null;
  const counts = annotationCounts(annotations);
  const [pane, setPane] = import_react2.default.useState("inspect");
  import_react2.default.useEffect(() => {
    if (selectedAnnotationId) setPane("annotations");
    else if (selection && selection.kind === "clip") setPane("inspect");
  }, [selectedAnnotationId, selection && selection.kind]);
  const tab = (key, label) => h2(
    "button",
    {
      key,
      type: "button",
      onClick: () => setPane(key),
      style: {
        flex: 1,
        padding: "6px 8px",
        border: "none",
        borderBottom: pane === key ? `2px solid ${T.accent}` : "2px solid transparent",
        background: pane === key ? T.panel : "transparent",
        color: pane === key ? T.text : T.textDim,
        fontSize: 11,
        cursor: "pointer"
      }
    },
    label
  );
  return h2(
    "div",
    { style: { minHeight: 0 } },
    h2(StagePanel, { projectId: state.projectId, sessionId: state.sessionId }),
    h2(
      "div",
      { style: { display: "flex", borderBottom: `1px solid ${T.border}`, background: T.fill } },
      tab("inspect", "\u5C5E\u6027"),
      tab("annotations", `\u6807\u6CE8 \xB7 ${counts.total}`)
    ),
    pane === "annotations" ? h2(AnnotationsPanel, {
      annotations,
      selection,
      playhead: props.playhead,
      duration: props.doc ? props.doc.duration : 0,
      onSelect: props.onAnnotationSelect,
      onJump: props.onAnnotationJump,
      onPatch: props.onAnnotationPatch,
      onDelete: props.onAnnotationDelete
    }) : h2(InspectorBody, props),
    h2(StylePanel, { projectId: state.projectId, sessionId: state.sessionId }),
    h2(TtsPanel, { projectId: state.projectId, sessionId: state.sessionId }),
    h2(AsrPanel, { projectId: state.projectId, sessionId: state.sessionId }),
    h2(StoryboardPanel, {
      projectId: state.projectId,
      sessionId: state.sessionId
    })
  );
}
function ProgressOverlay({ busy }) {
  if (!busy) return null;
  const ratio = Math.max(0, Math.min(1, busy.ratio || 0));
  return h2(
    "div",
    {
      style: {
        position: "absolute",
        inset: 0,
        background: T.mask,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 30
      }
    },
    h2(
      "div",
      {
        style: {
          width: 320,
          background: T.panel,
          border: `1px solid ${T.border}`,
          borderRadius: 10,
          padding: 16,
          fontSize: 12,
          color: T.text
        }
      },
      h2("div", { style: { marginBottom: 10 } }, busy.label || "\u5904\u7406\u4E2D\u2026"),
      h2(
        "div",
        { style: { height: 6, background: T.fillStrong, borderRadius: 3, overflow: "hidden" } },
        h2("div", { style: { width: `${ratio * 100}%`, height: "100%", background: T.accent, transition: "width .2s" } })
      ),
      h2("div", { style: { marginTop: 8, opacity: 0.6 } }, `${Math.round(ratio * 100)}%`),
      busy.detail ? h2("div", { style: { marginTop: 6, opacity: 0.5, fontSize: 11 } }, busy.detail) : null
    )
  );
}
function projectSummaryText(doc) {
  if (!doc) return "";
  const revision = doc.revision == null ? "r?" : "r" + doc.revision;
  const duration = typeof doc.duration === "number" ? doc.duration.toFixed(2) + "s" : "\u2014";
  const fps = doc.fps == null ? "?fps" : doc.fps + "fps";
  const ratio = doc.ratio || "\u2014";
  return `${revision} \xB7 ${duration} \xB7 ${fps} \xB7 ${ratio}`;
}
function shortSessionTag(sessionId) {
  const s = String(sessionId || "");
  if (!s) return "\u672A\u77E5\u4F1A\u8BDD";
  const tail = s.startsWith("session-") ? s.slice("session-".length) : s;
  if (!tail) return "\u672A\u77E5\u4F1A\u8BDD";
  return tail.length > 9 ? tail.slice(0, 5) + "\u2026" + tail.slice(-4) : tail;
}
function mergeSessionProjects(doc, projects, sessionId) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const p of [doc, ...projects || []]) {
    if (!p || !p.projectId || seen.has(p.projectId)) continue;
    if (sessionId && p.boundSessionId && p.boundSessionId !== sessionId) continue;
    seen.add(p.projectId);
    out.push(p);
  }
  return out;
}
function classifyEnabled({ sessionId, list, enabled }) {
  const all = Array.isArray(enabled) ? enabled : [];
  const mine = Array.isArray(list) ? list : [];
  const inList = (x) => mine.some((p) => p && p.projectId === x.projectId);
  const sameSession = (x) => !sessionId || !x.sessionId || x.sessionId === sessionId;
  const mineOnly = [];
  const others = [];
  for (const x of all) {
    if (!x || !x.projectId) continue;
    if (!sameSession(x)) others.push(x);
    else if (!inList(x)) mineOnly.push(x);
  }
  return { mineOnly, others };
}
var cardStyle = {
  border: `1px solid ${T.border}`,
  borderRadius: 10,
  padding: "10px 12px",
  background: T.fill
};
function SelectionPanel(props) {
  const {
    sessionId,
    projects,
    doc,
    enabled,
    max,
    busy,
    error,
    onNew,
    onEnter,
    onEnable,
    onDisable,
    onRename
  } = props || {};
  const [renamingId, setRenamingId] = import_react2.default.useState(null);
  const [renameValue, setRenameValue] = import_react2.default.useState("");
  const list = mergeSessionProjects(doc, projects, sessionId);
  const all = enabled || [];
  const limit = Math.max(1, Number(max) || 2);
  const used = all.filter((x) => x && x.origin === "panel").length;
  const agentOwned = all.filter((x) => x && x.origin !== "panel").length;
  const isOn = (id) => all.some((x) => x.projectId === id);
  const { mineOnly: mineEnabledOnly, others } = classifyEnabled({ sessionId, list, enabled: all });
  const call = (fn, ...args) => {
    if (typeof fn === "function") fn(...args);
  };
  function startRename(project) {
    setRenamingId(project.projectId);
    setRenameValue(project.title || "");
  }
  function commitRename(project) {
    const title = String(renameValue || "").trim();
    if (!title) return;
    setRenamingId(null);
    call(onRename, project.projectId, title);
  }
  const rowBtn = (label, onClick, extra) => h2(
    "button",
    {
      type: "button",
      onClick,
      style: Object.assign(
        {
          padding: "3px 10px",
          borderRadius: 6,
          border: `1px solid ${T.border}`,
          background: T.panel,
          color: T.text,
          fontSize: 11,
          cursor: "pointer"
        },
        extra || {}
      )
    },
    label
  );
  return h2(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        overflow: "auto",
        background: T.bg,
        color: T.text,
        fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif"
      }
    },
    // 顶栏：标题 + 已用 N/2
    h2(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          borderBottom: `1px solid ${T.border}`,
          minHeight: 48
        }
      },
      h2("strong", { style: { fontSize: 14, fontWeight: 600 } }, "\u89C6\u9891\u5DE5\u4F5C\u53F0"),
      h2(
        "span",
        {
          style: {
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 999,
            border: `1px solid ${T.border}`,
            background: used >= limit ? T.warnDim : T.accentDim,
            color: used >= limit ? T.warn : T.accent
          }
        },
        `\u5DF2\u7528 ${used}/${limit}`
      ),
      // agent 调用占的工程不占额度，单独说明 —— 否则用户看到列表里有 3 个却写着 1/2 会以为坏了
      agentOwned > 0 ? h2(
        "span",
        { style: { fontSize: 11, opacity: 0.5 } },
        "\u53E6\u6709 " + agentOwned + " \u4E2A\u7531 agent \u6253\u5F00\uFF08\u4E0D\u5360\u989D\u5EA6\uFF09"
      ) : null,
      h2("span", { style: { fontSize: 11, opacity: 0.55 } }, "\u5168\u5C40\u6700\u591A " + limit + " \u4E2A\u5DE5\u7A0B\u540C\u65F6\u5904\u4E8E\u542F\u7528\u72B6\u6001"),
      h2("div", { style: { flex: 1 } }),
      rowBtn("\u65B0\u5EFA\u5DE5\u7A0B", () => call(onNew))
    ),
    h2(
      "div",
      { style: { padding: 16, display: "flex", flexDirection: "column", gap: 14, maxWidth: 900, width: "100%", margin: "0 auto" } },
      busy ? h2("div", { style: { fontSize: 11, opacity: 0.6 } }, busy.label || "\u5904\u7406\u4E2D\u2026") : null,
      error ? h2("div", { style: { fontSize: 12, color: T.danger } }, error) : null,
      // 本会话的工程卡
      list.length === 0 ? h2(
        "div",
        { style: { padding: 24, textAlign: "center", fontSize: 12, opacity: 0.7, lineHeight: 1.8 } },
        "\u8FD9\u4E2A\u4F1A\u8BDD\u8FD8\u6CA1\u6709\u89C6\u9891\u5DE5\u7A0B\u3002",
        h2("div", null, "\u65B0\u5EFA\u4E00\u4E2A\uFF1A\u5DE5\u7A0B\u4F1A\u7ED1\u5B9A\u5230\u5F53\u524D\u4F1A\u8BDD\uFF0C\u4F46\u4E0D\u4F1A\u81EA\u52A8\u5360\u7528\u542F\u7528\u989D\u5EA6\u3002")
      ) : h2(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 10 } },
        h2("div", { style: { fontSize: 12, opacity: 0.6 } }, "\u672C\u4F1A\u8BDD\u7684\u5DE5\u7A0B"),
        list.map((p) => {
          const on = isOn(p.projectId);
          const renaming = renamingId === p.projectId;
          const isOpen = p.open !== false;
          const missing = p.missing === true;
          return h2(
            "div",
            { key: p.projectId, style: Object.assign({}, cardStyle, on ? { borderColor: T.accent } : null) },
            h2(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
              renaming ? h2("input", {
                autoFocus: true,
                value: renameValue,
                maxLength: 60,
                onChange: (e) => setRenameValue(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename(p);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setRenamingId(null);
                  }
                },
                style: {
                  flex: 1,
                  minWidth: 160,
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: `1px solid ${T.border}`,
                  background: T.fill,
                  color: T.text,
                  fontSize: 12,
                  fontFamily: "inherit"
                }
              }) : h2("strong", { style: { fontSize: 13 } }, p.title || "\u672A\u547D\u540D\u5DE5\u7A0B"),
              renaming ? rowBtn("\u786E\u8BA4", () => commitRename(p)) : rowBtn("\u91CD\u547D\u540D", () => startRename(p)),
              renaming ? rowBtn("\u53D6\u6D88", () => setRenamingId(null)) : null,
              h2("div", { style: { flex: 1 } }),
              // 停用之后卡片仍然在，只是角标变回「未启用」—— 这是这次修的重点：
              // 列表不只看内存，还看登记表与绑定表，所以它不会再凭空消失。
              chip(on ? "\u5DF2\u542F\u7528" : "\u672A\u542F\u7528", on ? "ok" : "warn"),
              missing ? chip("\u8DEF\u5F84\u4E0D\u5B58\u5728", "warn") : null
            ),
            h2(
              "div",
              { style: { fontSize: 11, opacity: 0.5, marginTop: 4, wordBreak: "break-all" } },
              p.root || "\uFF08\u8DEF\u5F84\u672A\u77E5\uFF09"
            ),
            isOpen ? h2("div", { style: { fontSize: 11, opacity: 0.7, marginTop: 2 } }, projectSummaryText(p)) : h2(
              "div",
              { style: { fontSize: 11, opacity: 0.55, marginTop: 2 } },
              missing ? "\u5DE5\u7A0B\u76EE\u5F55\u6216 project.json \u8BFB\u4E0D\u5230\uFF0C\u8FDB\u5165\u4F1A\u5931\u8D25\u3002\u8BF7\u786E\u8BA4\u76EE\u5F55\u662F\u5426\u88AB\u79FB\u52A8\u6216\u5220\u9664\u3002" : "\u8FD8\u6CA1\u52A0\u8F7D\uFF08\u505C\u7528\u6216\u91CD\u542F\u540E\u4F1A\u8FD9\u6837\uFF09\u3002\u70B9\u300C\u8FDB\u5165\u300D\u4F1A\u81EA\u52A8\u52A0\u8F7D\u5E76\u542F\u7528\u3002"
            ),
            h2(
              "div",
              { style: { display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" } },
              // 「启用」只对已打开的工程有意义：没打开的工程走「进入」，
              // 由 Host 用 dir 自愈打开再启用（一次点击完成，不再两个按钮互相等）。
              isOpen ? rowBtn("\u542F\u7528", () => call(onEnable, p), {
                opacity: on ? 0.45 : 1,
                borderColor: on ? void 0 : T.accent,
                color: on ? void 0 : T.accent
              }) : null,
              rowBtn("\u8FDB\u5165", () => call(onEnter, p), {
                background: missing ? T.fill : T.primary,
                border: `1px solid ${missing ? T.border : T.primary}`,
                color: missing ? T.textDim : T.onPrimary,
                fontWeight: 600,
                opacity: missing ? 0.55 : 1
              }),
              on ? rowBtn("\u505C\u6B62\u542F\u7528", () => call(onDisable, p), {
                color: T.danger,
                borderColor: T.danger
              }) : null
            )
          );
        })
      ),
      // 本会话启用、但没进 list 的工程（未绑定 / doc 是别的工程）：
      // 它占的是我自己的额度，所以必须给我按钮，不能贴成「其他会话」。
      mineEnabledOnly.length ? h2(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6 } },
        h2("div", { style: { fontSize: 12, opacity: 0.6 } }, "\u672C\u4F1A\u8BDD\u5DF2\u542F\u7528\u3001\u4F46\u8FD8\u6CA1\u7ED1\u5B9A\u5230\u5F53\u524D\u5DE5\u7A0B"),
        mineEnabledOnly.map(
          (x) => h2(
            "div",
            {
              key: x.projectId,
              style: { fontSize: 11, padding: "6px 10px", borderRadius: 8, background: T.fill, border: `1px solid ${T.border}` }
            },
            h2(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
              h2("span", { style: { opacity: 0.85 } }, x.title || x.projectId),
              h2("div", { style: { flex: 1 } }),
              rowBtn("\u8FDB\u5165", () => call(onEnter, x), {
                background: T.primary,
                border: `1px solid ${T.primary}`,
                color: T.onPrimary,
                fontWeight: 600
              }),
              rowBtn("\u505C\u6B62\u542F\u7528", () => call(onDisable, x), { color: T.danger, borderColor: T.danger })
            ),
            x.root ? h2("div", { style: { opacity: 0.4, marginTop: 2, wordBreak: "break-all" } }, x.root) : null
          )
        )
      ) : null,
      // 其他会话占着额度的工程：可以在这里直接停用（后端 disable 不校验会话），
      // 否则一旦占额度的是没有面板的 agent 会话，额度就再也放不出来了。
      others.length ? h2(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6 } },
        h2("div", { style: { fontSize: 12, opacity: 0.6 } }, "\u5176\u4ED6\u4F1A\u8BDD\u5DF2\u542F\u7528\u7684\u5DE5\u7A0B"),
        others.map(
          (x) => h2(
            "div",
            {
              key: x.projectId,
              style: { fontSize: 11, padding: "6px 10px", borderRadius: 8, background: T.fill, border: `1px dashed ${T.border}` }
            },
            h2(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
              h2("span", { style: { opacity: 0.85 } }, x.title || x.projectId),
              h2("span", { style: { opacity: 0.5 } }, "\u4F1A\u8BDD " + shortSessionTag(x.sessionId)),
              h2("div", { style: { flex: 1 } }),
              rowBtn("\u5728\u8FD9\u91CC\u505C\u7528", () => call(onDisable, x), { color: T.danger, borderColor: T.danger })
            ),
            x.root ? h2("div", { style: { opacity: 0.4, marginTop: 2, wordBreak: "break-all" } }, x.root) : null
          )
        ),
        h2(
          "div",
          { style: { fontSize: 11, opacity: 0.45, lineHeight: 1.6 } },
          "\u989D\u5EA6\u662F\u5168\u5C40\u7684\uFF08" + used + "/" + limit + "\uFF09\u3002\u5728\u8FD9\u91CC\u505C\u7528\u7B49\u4E8E\u66FF\u90A3\u4E2A\u4F1A\u8BDD\u91CA\u653E\u989D\u5EA6\uFF1B\u5982\u679C\u90A3\u4E2A\u4F1A\u8BDD\u6B63\u5728\u7528\u8FD9\u4E2A\u5DE5\u7A0B\uFF0C\u5B83\u7684\u9884\u89C8\u4F1A\u5931\u6548\u3002"
        )
      ) : null
    )
  );
}

// src/client/frame-render.js
var SAMPLE_WIDTH = 960;
var SAMPLE_HEIGHT = 540;
function sampleSize(maxDim) {
  const dim = Number(maxDim) > 0 ? Number(maxDim) : 640;
  const scale = Math.min(1, dim / SAMPLE_WIDTH);
  return {
    width: Math.max(2, Math.round(SAMPLE_WIDTH * scale)),
    height: Math.max(2, Math.round(SAMPLE_HEIGHT * scale))
  };
}
function waitSeeked(video, timeoutMs) {
  return new Promise((resolve) => {
    if (!video || video.readyState < 1) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    video.addEventListener("seeked", finish);
  });
}
async function seekTimeline(clips, assets, t) {
  try {
    syncVideos({ clips, assets, t }, { playing: false });
  } catch {
  }
  const waits = [];
  for (const a of assets || []) {
    const v2 = videoState(a.id);
    if (!v2 || v2.readyState < 1) continue;
    if (v2.seeking) waits.push(waitSeeked(v2, 700));
  }
  await Promise.all(waits);
  await new Promise((r) => setTimeout(r, 16));
}
async function renderTimelineFrame(input) {
  const clips = input.clips || [];
  const assets = input.assets || [];
  const t = Number(input.t) || 0;
  const { width, height } = sampleSize(input.maxDim);
  await seekTimeline(clips, assets, t);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx2 = canvas.getContext("2d", { alpha: false });
  const layers = frameLayers(clips, t);
  const code = input.code || null;
  if (code) {
    try {
      await code.renderLayers(layers);
    } catch {
    }
  }
  const mediaWarnings = [];
  drawFrame(ctx2, {
    clips,
    assets,
    t,
    width,
    height,
    layers,
    codeCanvas: code ? (clip2) => code.canvasFor(clip2) : null,
    onMediaState: (diagnostics) => {
      for (const item of diagnostics || []) mediaWarnings.push(item);
    }
  });
  return { canvas, ctx: ctx2, width, height, layers, mediaWarnings };
}

// src/client/sampler.js
function createSampler({ getCode } = {}) {
  let timer = null;
  let busy = false;
  async function tick() {
    if (!state.projectId || !state.doc || busy) return;
    busy = true;
    try {
      const res = await rpc("sample.pending", { projectId: state.projectId });
      const requests = res && res.requests || [];
      for (const req of requests) {
        const files = [];
        for (const t of req.times) {
          const code = getCode && getCode();
          const frame = await renderTimelineFrame({
            clips: state.clips,
            // 与预览/导出同一份图层清单：转场与变速都体现在这里
            assets: state.assets,
            t,
            maxDim: req.maxDim || 640,
            code: code ? { renderLayers: (l) => code.renderLayers(l), canvasFor: (c) => code.canvasFor(c) } : null
          });
          files.push({ time: t, dataUrl: frame.canvas.toDataURL("image/jpeg", 0.82) });
        }
        await rpc("sample.fulfill", {
          projectId: state.projectId,
          sessionId: state.sessionId,
          requestId: req.requestId,
          files
        });
      }
    } catch (e) {
      console.warn("[video-workbench] sample tick failed", e && e.message);
    } finally {
      busy = false;
    }
  }
  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, 700);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    }
  };
}

// src/client/audio.js
init_audio_mix();
var LOOKAHEAD = 0.05;
var DEFAULT_RATE = 48e3;
var MAX_VOLUME = AUDIO_VOLUME_MAX;
var MIN_SPEED = 0.1;
var MAX_SPEED = 8;
var DUCK_RATE = 50;
var DUCK_EPS = 1e-3;
function roleOf(value) {
  if (value === "voice" || value === "music" || value === "sfx") return value;
  return "sfx";
}
function createAudioEngine({ getSegments } = {}) {
  let ctx2 = null;
  let masterGain = null;
  let decodeCtx = null;
  let masterVolume = 1;
  let playing = false;
  let anchorCtx = 0;
  let anchorTimeline = 0;
  let pausedAt = 0;
  let playToken = 0;
  let disposed = false;
  const voices = [];
  const cache4 = /* @__PURE__ */ new Map();
  const warned = /* @__PURE__ */ new Set();
  const normCache = /* @__PURE__ */ new Map();
  async function play(fromT) {
    if (disposed) return;
    const startAt = clampTime2(fromT);
    const token = ++playToken;
    stopVoices();
    playing = false;
    pausedAt = startAt;
    anchorTimeline = startAt;
    anchorCtx = 0;
    const live = ensureContext();
    if (!live) return;
    try {
      if (live.state === "suspended" && typeof live.resume === "function") await live.resume();
    } catch {
    }
    if (token !== playToken || disposed) return;
    const all = collectSegments();
    const duck = buildDuckEnvelope(all);
    const segments = all.filter((s) => !s.muted && s.start + s.duration > startAt);
    const buffers = await Promise.all(segments.map((s) => decode(s.url)));
    if (token !== playToken || disposed) return;
    const base = live.currentTime + LOOKAHEAD;
    for (let i = 0; i < segments.length; i += 1) {
      const buffer = buffers[i];
      if (!buffer) continue;
      const voice = scheduleSegment(live, masterGain, segments[i], buffer, base, startAt, duck);
      if (voice) voices.push(voice);
    }
    playing = true;
    anchorCtx = base;
    anchorTimeline = startAt;
  }
  function pause() {
    const at = current();
    playToken += 1;
    stopVoices();
    playing = false;
    pausedAt = at;
  }
  function seek(t) {
    const at = clampTime2(t);
    pausedAt = at;
    if (disposed) return;
    if (playing) {
      void play(at).catch(() => {
      });
      return;
    }
    playToken += 1;
    stopVoices();
    playing = false;
  }
  function setVolume(v2) {
    const n = Number(v2);
    masterVolume = Number.isFinite(n) ? clamp3(n, 0, 1) : 1;
    if (!masterGain) return;
    const now = ctx2 ? ctx2.currentTime : 0;
    if (typeof masterGain.gain.cancelScheduledValues === "function") masterGain.gain.cancelScheduledValues(now);
    setValue(masterGain.gain, masterVolume, now);
  }
  function current() {
    if (!playing || !ctx2) return pausedAt;
    const t = anchorTimeline + (ctx2.currentTime - anchorCtx);
    return t > 0 ? t : 0;
  }
  async function mixdown(options = {}) {
    const all = collectSegments().filter((s) => !s.muted);
    const rate = normalizeRate(options.sampleRate);
    const dur = normalizeDuration(options.duration, all);
    const frames = Math.max(1, Math.round(dur * rate));
    const segs = all.filter((s) => s.start < dur);
    if (segs.length === 0) return silentBuffer(frames, rate);
    const Ctor = offlineCtor();
    if (typeof Ctor !== "function") {
      console.warn("[audio] \u6CA1\u6709 OfflineAudioContext\uFF0C\u6DF7\u97F3\u8FD4\u56DE\u9759\u97F3");
      return silentBuffer(frames, rate);
    }
    let offline;
    try {
      offline = new Ctor(2, frames, rate);
    } catch (err) {
      console.warn("[audio] OfflineAudioContext \u521B\u5EFA\u5931\u8D25\uFF0C\u6DF7\u97F3\u8FD4\u56DE\u9759\u97F3", err && err.message ? err.message : err);
      return silentBuffer(frames, rate);
    }
    let master = null;
    try {
      master = offline.createGain();
      setValue(master.gain, masterVolume, 0);
      master.connect(offline.destination);
    } catch {
      master = offline.destination;
    }
    const buffers = await Promise.all(segs.map((s) => decode(s.url)));
    const duck = buildDuckEnvelope(all);
    for (let i = 0; i < segs.length; i += 1) {
      if (!buffers[i]) continue;
      scheduleSegment(offline, master, segs[i], buffers[i], 0, 0, duck);
    }
    try {
      return await offline.startRendering();
    } catch (err) {
      console.warn("[audio] \u79BB\u7EBF\u6E32\u67D3\u5931\u8D25\uFF0C\u8FD4\u56DE\u9759\u97F3", err && err.message ? err.message : err);
      return silentBuffer(frames, rate);
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    playToken += 1;
    playing = false;
    stopVoices();
    cache4.clear();
    warned.clear();
    normCache.clear();
    if (masterGain) {
      try {
        masterGain.disconnect();
      } catch {
      }
      masterGain = null;
    }
    const closing = [ctx2, decodeCtx].filter(Boolean);
    ctx2 = null;
    decodeCtx = null;
    for (const item of closing) {
      if (typeof item.close !== "function") continue;
      try {
        const p = item.close();
        if (p && typeof p.catch === "function") p.catch(() => {
        });
      } catch {
      }
    }
  }
  return { play, pause, seek, setVolume, current, mixdown, dispose };
  function scheduleSegment(target, destination, seg, buffer, base, fromT, duck = null) {
    const clipStart = seg.start;
    const clipEnd = seg.start + seg.duration;
    if (clipEnd <= fromT) return null;
    const skip = Math.max(0, fromT - clipStart);
    const when = base + Math.max(0, clipStart - fromT);
    const offset = seg.sourceIn + skip * seg.speed;
    const bufferDur = buffer && Number.isFinite(buffer.duration) ? buffer.duration : Infinity;
    const span = Math.min((clipEnd - Math.max(clipStart, fromT)) * seg.speed, Math.max(0, bufferDur - offset));
    if (!(span > 0)) return null;
    const source = target.createBufferSource();
    source.buffer = buffer;
    if (source.playbackRate) setValue(source.playbackRate, seg.speed, when);
    const gain = target.createGain();
    applyEnvelope(gain.gain, seg, (localT) => base + (clipStart + localT - fromT), skip);
    const nodes = [gain];
    let tail = gain;
    source.connect(gain);
    const normGain = normalizationGain(seg, buffer);
    if (Math.abs(normGain - 1) > 1e-3) {
      const norm = target.createGain();
      setValue(norm.gain, normGain, when);
      tail.connect(norm);
      tail = norm;
      nodes.push(norm);
    }
    if (duck && seg.audioRole === "music" && duckActiveIn(duck, clipStart, clipEnd)) {
      const duckGain = target.createGain();
      scheduleDuck(duckGain.gain, duck, seg, base, fromT);
      tail.connect(duckGain);
      tail = duckGain;
      nodes.push(duckGain);
    }
    tail.connect(destination);
    try {
      source.start(when, offset, span);
    } catch (err) {
      console.warn("[audio] \u7247\u6BB5\u8C03\u5EA6\u5931\u8D25\uFF0C\u5DF2\u8DF3\u8FC7\uFF1A", seg.url, err && err.message ? err.message : err);
      return null;
    }
    return { source, gain, nodes };
  }
  function buildDuckEnvelope(segs) {
    const voice = [];
    const music = [];
    let end = 0;
    for (const s of segs) {
      if (s.muted) continue;
      const stop = s.start + s.duration;
      if (stop > end) end = stop;
      if (s.audioRole === "voice") voice.push({ start: s.start, end: stop });
      else if (s.audioRole === "music") music.push({ start: s.start, end: stop });
    }
    if (!voice.length || !music.length || !(end > 0)) return null;
    return computeDuckEnvelope({
      duration: end,
      sampleRate: DUCK_RATE,
      voiceSegments: voice,
      musicSegments: music,
      maxDuckDb: DUCK_DEFAULTS.maxDuckDb,
      attack: DUCK_DEFAULTS.attack,
      release: DUCK_DEFAULTS.release
    });
  }
  function duckActiveIn(env, start, end) {
    const rate = DUCK_RATE;
    const i0 = Math.max(0, Math.floor(start * rate));
    const i1 = Math.min(env.length, Math.ceil(end * rate));
    for (let i = i0; i < i1; i += 1) if (env[i] < 0.999) return true;
    return false;
  }
  function scheduleDuck(param, env, seg, base, fromT) {
    const rate = DUCK_RATE;
    const clipStart = seg.start;
    const clipEnd = seg.start + seg.duration;
    const from = Math.max(clipStart, fromT);
    const i0 = Math.max(0, Math.floor(from * rate));
    const i1 = Math.min(env.length, Math.ceil(clipEnd * rate));
    if (i1 <= i0) return;
    const timeOf = (i) => Math.max(0, base + (i / rate - fromT));
    setValue(param, env[i0], timeOf(i0));
    let last2 = env[i0];
    for (let i = i0 + 1; i < i1; i += 1) {
      const value = env[i];
      const at = timeOf(i);
      if (!(at > 0)) continue;
      const changing = Math.abs(value - last2) >= DUCK_EPS;
      const tailPoint = i === i1 - 1;
      if (!changing && !tailPoint) continue;
      if (typeof param.linearRampToValueAtTime === "function") param.linearRampToValueAtTime(value, at);
      else setValue(param, value, at);
      last2 = value;
    }
  }
  function normalizationGain(seg, buffer) {
    if (seg.audioRole !== "music" && seg.audioRole !== "sfx") return 1;
    const key = seg.url;
    const cached = normCache.get(key);
    if (cached !== void 0) return cached;
    const channels = channelDataOf(buffer);
    const gain = rmsNormalizeGain(channels, NORMALIZE_DEFAULTS.targetRms, {
      minGain: NORMALIZE_DEFAULTS.minGain,
      maxGain: NORMALIZE_DEFAULTS.maxGain
    });
    normCache.set(key, gain);
    return gain;
  }
  function channelDataOf(buffer) {
    if (!buffer || typeof buffer.getChannelData !== "function") return null;
    const count = Math.max(1, Number(buffer.numberOfChannels) || 1);
    const out = [];
    for (let ch = 0; ch < count; ch += 1) out.push(buffer.getChannelData(ch));
    return out;
  }
  function envelopePoints(seg) {
    return clipGainPoints(seg.duration, {
      volume: seg.volume,
      fadeIn: seg.fadeIn,
      fadeOut: seg.fadeOut,
      muted: seg.muted
    });
  }
  function applyEnvelope(param, seg, timeOf, skip) {
    const pts = envelopePoints(seg);
    const start = Math.max(0, skip);
    const startTime = timeOf(start);
    setValue(param, valueAt(pts, start), startTime);
    for (const point of pts) {
      if (point.t <= start + 1e-6) continue;
      const at = timeOf(point.t);
      if (!(at > startTime + 1e-6)) continue;
      if (typeof param.linearRampToValueAtTime === "function") param.linearRampToValueAtTime(point.v, at);
      else param.value = point.v;
    }
  }
  function valueAt(pts, t) {
    return gainAtPoints(pts, t);
  }
  function audioCtor() {
    return globalThis.AudioContext || globalThis.webkitAudioContext || null;
  }
  function offlineCtor() {
    return globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext || null;
  }
  function ensureContext() {
    if (disposed) return null;
    if (ctx2) return ctx2;
    const Ctor = audioCtor();
    if (typeof Ctor !== "function") {
      console.warn("[audio] \u5F53\u524D\u73AF\u5883\u6CA1\u6709 AudioContext\uFF0C\u64AD\u653E\u4FDD\u6301\u9759\u97F3");
      return null;
    }
    try {
      ctx2 = new Ctor();
      masterGain = ctx2.createGain();
      setValue(masterGain.gain, masterVolume, 0);
      masterGain.connect(ctx2.destination);
    } catch (err) {
      ctx2 = null;
      masterGain = null;
      console.warn("[audio] AudioContext \u521B\u5EFA\u5931\u8D25", err && err.message ? err.message : err);
      return null;
    }
    return ctx2;
  }
  function decodeContext() {
    if (ctx2) return ctx2;
    if (decodeCtx) return decodeCtx;
    const Ctor = offlineCtor();
    if (typeof Ctor !== "function") return null;
    try {
      decodeCtx = new Ctor(2, 1, 44100);
    } catch (err) {
      console.warn("[audio] \u65E0\u6CD5\u521B\u5EFA\u89E3\u7801\u4E0A\u4E0B\u6587", err && err.message ? err.message : err);
      return null;
    }
    return decodeCtx;
  }
  function stopVoices() {
    for (const voice of voices.splice(0)) {
      try {
        voice.source.stop();
      } catch {
      }
      try {
        voice.source.disconnect();
      } catch {
      }
      for (const node of voice.nodes && voice.nodes.length ? voice.nodes : [voice.gain]) {
        try {
          node.disconnect();
        } catch {
        }
      }
    }
  }
  function decode(url2) {
    let pending4 = cache4.get(url2);
    if (pending4) return pending4;
    pending4 = (async () => {
      const res = await fetch(url2);
      if (!res || res.ok === false) throw new Error("\u97F3\u9891\u8BF7\u6C42\u5931\u8D25");
      const data = await res.arrayBuffer();
      const base = decodeContext();
      if (!base) throw new Error("\u5F53\u524D\u73AF\u5883\u6CA1\u6709 WebAudio");
      return await base.decodeAudioData(data) || null;
    })().catch((err) => {
      cache4.delete(url2);
      if (!warned.has(url2)) {
        warned.add(url2);
        console.warn("[audio] \u89E3\u7801\u5931\u8D25\uFF0C\u5DF2\u8DF3\u8FC7\u8BE5\u7247\u6BB5\uFF1A", url2, err && err.message ? err.message : err);
      }
      return null;
    });
    cache4.set(url2, pending4);
    return pending4;
  }
  function collectSegments() {
    let raw;
    try {
      raw = typeof getSegments === "function" ? getSegments() : [];
    } catch (err) {
      console.warn("[audio] getSegments \u629B\u9519\uFF0C\u6309\u7A7A\u65F6\u95F4\u7EBF\u5904\u7406", err && err.message ? err.message : err);
      return [];
    }
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const list = [];
    for (let i = 0; i < raw.length; i += 1) {
      const seg = normalizeSegment(raw[i], i);
      if (seg) list.push(seg);
    }
    list.sort((a, b) => a.start - b.start || a.index - b.index);
    return list;
  }
  function normalizeSegment(item, index) {
    if (!item || typeof item !== "object") return null;
    const url2 = typeof item.url === "string" ? item.url : "";
    if (!url2) return null;
    const start = Number(item.start);
    const duration = Number(item.duration);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) return null;
    const speed = Number(item.speed);
    const volume = Number(item.volume);
    return {
      assetId: item.assetId,
      url: url2,
      start: Math.max(0, start),
      duration,
      sourceIn: Math.max(0, Number(item.sourceIn) || 0),
      speed: clamp3(Number.isFinite(speed) && speed > 0 ? speed : 1, MIN_SPEED, MAX_SPEED),
      volume: clamp3(Number.isFinite(volume) ? volume : 1, 0, MAX_VOLUME),
      fadeIn: Math.max(0, Number(item.fadeIn) || 0),
      fadeOut: Math.max(0, Number(item.fadeOut) || 0),
      muted: item.muted === true,
      // 未标注一律当 sfx：只有明确标成 music 的参与 ducking，只有 voice 能触发它
      audioRole: roleOf(item.audioRole),
      index
    };
  }
  function setValue(param, value, when) {
    if (!param) return;
    if (typeof param.setValueAtTime === "function") {
      try {
        param.setValueAtTime(value, when);
        return;
      } catch {
      }
    }
    param.value = value;
  }
  function normalizeRate(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_RATE;
    return Math.min(192e3, Math.max(3e3, Math.round(n)));
  }
  function normalizeDuration(value, segs) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
    let end = 0;
    for (const seg of segs) end = Math.max(end, seg.start + seg.duration);
    return end > 0 ? end : 0.1;
  }
  function silentBuffer(frames, rate) {
    const Ctor = globalThis.AudioBuffer;
    if (typeof Ctor === "function") {
      try {
        return new Ctor({ length: frames, numberOfChannels: 2, sampleRate: rate });
      } catch {
      }
    }
    const channels = [new Float32Array(frames), new Float32Array(frames)];
    return {
      length: frames,
      numberOfChannels: 2,
      sampleRate: rate,
      duration: frames / rate,
      getChannelData: (i) => channels[i] || channels[0]
    };
  }
}
function clamp3(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
function clampTime2(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// src/client/probe.js
async function probe() {
  const out = {
    secureContext: typeof isSecureContext === "boolean" ? isSecureContext : null,
    webgpu: !!navigator.gpu,
    videoDecoder: typeof VideoDecoder !== "undefined",
    videoEncoder: typeof VideoEncoder !== "undefined",
    audioEncoder: typeof AudioEncoder !== "undefined",
    h264: null,
    hevc: null,
    vp9: null,
    av1: null,
    aac: null,
    opus: null
  };
  async function tryVideo(codec, w = 1920, h4 = 1080) {
    if (typeof VideoEncoder === "undefined") return false;
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: w, height: h4, bitrate: 8e6, framerate: 30 });
      return !!r.supported;
    } catch {
      return false;
    }
  }
  async function tryAudio(codec) {
    if (typeof AudioEncoder === "undefined") return false;
    try {
      const r = await AudioEncoder.isConfigSupported({ codec, sampleRate: 48e3, numberOfChannels: 2, bitrate: 128e3 });
      return !!r.supported;
    } catch {
      return false;
    }
  }
  out.h264 = await tryVideo("avc1.42001f");
  out.hevc = await tryVideo("hvc1.1.6.L93.B0");
  out.vp9 = await tryVideo("vp09.00.10.08");
  out.av1 = await tryVideo("av01.0.04M.08");
  out.aac = await tryAudio("mp4a.40.2");
  out.opus = await tryAudio("opus");
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      out.gpuVendor = adapter && adapter.info ? adapter.info.vendor : null;
    }
  } catch {
  }
  return out;
}

// src/client/main.js
init_codec_caps();

// src/client/code-layer.js
var DEFAULT_RENDER_TIMEOUT_MS = 5e3;
var DEFAULT_SETUP_TIMEOUT_MS = 3e4;
var CodeLayerError = class extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = "CodeLayerError";
    this.code = code;
    if (details !== void 0) this.details = details;
  }
};
function workerBootstrap2() {
  "use strict";
  const state2 = {
    layerId: "",
    width: 1,
    height: 1,
    props: void 0,
    render: null,
    setup: null,
    clock: { t: 0 },
    ctx: null,
    // 时间与素材（宿主每帧带来；worker 里没有 DOM，媒体只能是已解码的帧位图）
    fps: 30,
    duration: 0,
    assets: [],
    mediaDescriptor: null,
    mediaNeeds: [],
    mediaFrames: /* @__PURE__ */ new Map(),
    media: null,
    // 转场上下文：结构来自宿主，帧位图按 key（clipId@源时间 / clipId#c@毫秒）传进来
    transitionDescriptor: null,
    transitionNeeds: { prev: false, next: false, composed: false },
    transitionFrames: /* @__PURE__ */ new Map(),
    transition: null
  };
  let canvas = null;
  let draw2 = null;
  let queue2 = Promise.resolve();
  function textOf(error) {
    return error && error.message ? String(error.message) : String(error);
  }
  function isEvalBlocked(error) {
    if (!error) return false;
    if (error.name === "EvalError") return true;
    return /unsafe-eval|Content Security Policy|CSP/i.test(textOf(error));
  }
  function frameOf(id) {
    try {
      if (id === null || id === void 0) return null;
      return state2.mediaFrames.get(String(id)) || null;
    } catch (error) {
      return null;
    }
  }
  function mediaSize(frame) {
    const width = Number(frame && frame.width);
    const height = Number(frame && frame.height);
    if (!(width > 0) || !(height > 0)) return null;
    return { width, height };
  }
  function makeMediaFacade() {
    return {
      has: function(id) {
        const frame = frameOf(id);
        return !!(frame && frame.bitmap);
      },
      video: function(id) {
        const frame = frameOf(id);
        return frame && frame.kind === "video" && frame.bitmap ? frame.bitmap : null;
      },
      image: function(id) {
        const frame = frameOf(id);
        return frame && frame.kind === "image" && frame.bitmap ? frame.bitmap : null;
      },
      size: function(id) {
        return mediaSize(frameOf(id));
      },
      // 扩展：卡片可以用它区分 kinds / 核对这一帧到底对齐到哪个时间。
      kind: function(id) {
        const frame = frameOf(id);
        return frame ? frame.kind : null;
      },
      time: function(id) {
        const frame = frameOf(id);
        return frame && frame.time != null ? Number(frame.time) : null;
      }
    };
  }
  function closeFrames(frames) {
    if (!frames) return;
    for (const frame of frames.values()) {
      const bitmap = frame && frame.bitmap;
      if (bitmap && typeof bitmap.close === "function") {
        try {
          bitmap.close();
        } catch (error) {
        }
      }
    }
  }
  function installMedia(list) {
    const previous = state2.mediaFrames;
    const next = /* @__PURE__ */ new Map();
    for (const entry of list || []) {
      if (!entry || entry.id === void 0 || entry.id === null) continue;
      if (!entry.bitmap) continue;
      next.set(String(entry.id), {
        kind: String(entry.kind || ""),
        bitmap: entry.bitmap,
        width: Number(entry.width) || 0,
        height: Number(entry.height) || 0,
        time: entry.time === void 0 || entry.time === null ? null : Number(entry.time)
      });
    }
    state2.mediaFrames = next;
    closeFrames(previous);
  }
  function roundTransitionTime(value) {
    const n = Number(value);
    return (Number.isFinite(n) ? Math.round(n * 1e3) / 1e3 : 0).toFixed(3);
  }
  function transitionFrameOf(clipId, time) {
    if (!clipId) return null;
    const key = String(clipId) + "@" + roundTransitionTime(time);
    const record = state2.transitionFrames.get(key) || null;
    return record && !record.composed ? record.bitmap : null;
  }
  function composedFrameOf(key) {
    if (!key) return null;
    const record = state2.transitionFrames.get(String(key)) || null;
    return record && record.composed ? record.bitmap : null;
  }
  function closeTransitionFrames(frames) {
    if (!frames) return;
    for (const record of frames.values()) {
      const bitmap = record && record.bitmap;
      if (bitmap && typeof bitmap.close === "function") {
        try {
          bitmap.close();
        } catch (error) {
        }
      }
    }
  }
  function installTransitionFrames(list) {
    const previous = state2.transitionFrames;
    const next = /* @__PURE__ */ new Map();
    for (const entry of list || []) {
      if (!entry || !entry.key || !entry.bitmap) continue;
      next.set(String(entry.key), { bitmap: entry.bitmap, composed: !!entry.composed });
    }
    state2.transitionFrames = next;
    closeTransitionFrames(previous);
  }
  function makeTransitionFacade(descriptor) {
    const raw = descriptor && typeof descriptor === "object" ? descriptor : {};
    const cutAt = Number(raw.cutAt);
    function sideOf(value) {
      const info = value && typeof value === "object" ? value : {};
      const clipId = info.clipId === void 0 || info.clipId === null ? null : String(info.clipId);
      const rawTime = Number(info.time);
      const composedKey = info.composedKey ? String(info.composedKey) : null;
      const composed = !!info.composed;
      const composedWanted = !!info.composedWanted || composed;
      return {
        has: !!info.has,
        clipId,
        reason: info.reason ? String(info.reason) : info.has ? "ok" : "none",
        message: info.message ? String(info.message) : "",
        // 这一侧拿到的是不是合成帧。合成失败时 false，frame() 返回 null。
        composed,
        /**
         * 合成帧优先（默认帧 = 宿主按切点时刻合成的那张）；
         * 显式传 t 时只认原始素材帧（合成帧只预取默认那一刻）。
         * 没声明 composed 的老路径仍然是「原始帧」，行为与旧版一致。
         */
        frame: function(t) {
          if (t === void 0 || t === null) {
            if (composedWanted) {
              return composedFrameOf(composedKey);
            }
            if (!Number.isFinite(rawTime)) return null;
            return transitionFrameOf(clipId, rawTime);
          }
          const time = Number(t);
          if (!Number.isFinite(time)) return null;
          return transitionFrameOf(clipId, time);
        },
        /** 原始素材帧（旧行为）：卡可以自己比较「合成 / 原始」两条路。 */
        rawFrame: function(t) {
          const time = t === void 0 || t === null ? rawTime : Number(t);
          if (!Number.isFinite(time)) return null;
          return transitionFrameOf(clipId, time);
        }
      };
    }
    return {
      cutAt: Number.isFinite(cutAt) ? cutAt : 0,
      declared: !!raw.declared,
      // 'both' / 'prev' / 'next' / false —— 模块声明要合成哪几侧。
      composed: raw.composed === void 0 || raw.composed === null ? false : raw.composed,
      prev: sideOf(raw.prev),
      next: sideOf(raw.next)
    };
  }
  function normalizeNeed(item) {
    if (item === null || item === void 0) return null;
    if (typeof item === "string" || typeof item === "number") {
      const id = String(item);
      return id ? { id } : null;
    }
    if (typeof item === "object" && item.id !== void 0 && item.id !== null) {
      const id = String(item.id);
      return id ? { id } : null;
    }
    return null;
  }
  async function collectMediaNeeds() {
    const descriptor = state2.mediaDescriptor;
    if (!descriptor) return [];
    let raw;
    try {
      raw = typeof descriptor === "function" ? await descriptor(state2.props, state2.ctx) : descriptor;
    } catch (error) {
      return [];
    }
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const item of list) {
      const need = normalizeNeed(item);
      if (!need || seen.has(need.id)) continue;
      seen.add(need.id);
      out.push(need);
    }
    return out;
  }
  function normalizeTransitionNeeds(raw) {
    const out = { prev: false, next: false, composed: false };
    const composedOf = (value) => {
      if (!value) return false;
      if (value === true) return "both";
      const s = String(value).toLowerCase();
      if (s === "both" || s === "all" || s === "true") return "both";
      if (s === "prev") return "prev";
      if (s === "next") return "next";
      return false;
    };
    if (raw === true) {
      out.prev = true;
      out.next = true;
      out.composed = false;
      return out;
    }
    if (!raw) return out;
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const s = String(item).toLowerCase();
        if (s === "prev" || s === "both" || s === "all") out.prev = true;
        if (s === "next" || s === "both" || s === "all") out.next = true;
      }
      return out;
    }
    if (typeof raw === "string") {
      const s = raw.toLowerCase();
      if (s === "prev" || s === "both" || s === "all") out.prev = true;
      if (s === "next" || s === "both" || s === "all") out.next = true;
      return out;
    }
    if (typeof raw === "object") {
      out.prev = !!raw.prev;
      out.next = !!raw.next;
      if (raw.all === true || raw.both === true) {
        out.prev = true;
        out.next = true;
      }
      const sides = out.prev && out.next ? "both" : out.prev ? "prev" : out.next ? "next" : false;
      if (sides) {
        const wanted = composedOf(raw.composed, sides);
        if (wanted === "both" && sides !== "both") out.composed = sides;
        else out.composed = wanted;
      }
    }
    return out;
  }
  async function collectTransitionNeeds() {
    const descriptor = state2.transitionDescriptor;
    if (!descriptor) return { prev: false, next: false, composed: false };
    let raw;
    try {
      raw = typeof descriptor === "function" ? await descriptor(state2.props, state2.ctx) : descriptor;
    } catch (error) {
      return { prev: false, next: false, composed: false };
    }
    return normalizeTransitionNeeds(raw);
  }
  function postError(id, error, fallback, phase) {
    self.postMessage({
      type: "error",
      id: id === void 0 ? null : id,
      code: isEvalBlocked(error) ? "EVAL_BLOCKED" : error && error.code || fallback,
      message: textOf(error),
      phase: phase || ""
    });
  }
  function installClock() {
    try {
      Date.now = function() {
        return state2.clock.t * 1e3;
      };
    } catch (error) {
    }
    if (self.performance && typeof self.performance === "object") {
      const now = function() {
        return state2.clock.t * 1e3;
      };
      try {
        Object.defineProperty(self.performance, "now", { configurable: true, value: now });
      } catch (error) {
        try {
          self.performance.now = now;
        } catch (error2) {
        }
      }
    }
    function impure(name) {
      const error = new Error("\u4EE3\u7801\u56FE\u5C42\u4E0D\u80FD\u7528 " + name + "\uFF1A\u753B\u9762\u5FC5\u987B\u662F\u65F6\u95F4 t \u7684\u7EAF\u51FD\u6570");
      error.code = "IMPURE_CLOCK";
      throw error;
    }
    self.setTimeout = function() {
      impure("setTimeout");
    };
    self.setInterval = function() {
      impure("setInterval");
    };
    self.setImmediate = function() {
      impure("setImmediate");
    };
    self.requestAnimationFrame = function() {
      impure("requestAnimationFrame");
    };
    self.requestIdleCallback = function() {
      impure("requestIdleCallback");
    };
    self.cancelAnimationFrame = function() {
    };
    self.cancelIdleCallback = function() {
    };
  }
  function compileByFunction(source) {
    const exported = [];
    let body = String(source);
    body = body.replace(/export\s+default\s+/g, "const __default__ = ");
    body = body.replace(/export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/g, function(match, isAsync, name) {
      exported.push({ exported: name, local: name });
      return (isAsync || "") + "function " + name;
    });
    body = body.replace(/export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g, function(match, kind, name) {
      exported.push({ exported: name, local: name });
      return kind + " " + name;
    });
    body = body.replace(/export\s*\{([^}]*)\}/g, function(match, inner) {
      String(inner).split(",").forEach(function(part) {
        const piece = part.trim();
        if (!piece) return;
        const bits = piece.split(/\s+as\s+/);
        const local = bits[0].trim();
        const name = (bits[1] || bits[0]).trim();
        exported.push({ exported: name, local });
      });
      return "";
    });
    const fields = exported.map(function(item) {
      return JSON.stringify(item.exported) + ": " + item.local;
    });
    fields.push('__default__: typeof __default__ === "undefined" ? undefined : __default__');
    const factory = new Function("self", '"use strict";\n' + body + "\nreturn {" + fields.join(",") + "};");
    return factory(self);
  }
  async function loadModule(source) {
    let url2 = null;
    try {
      const blob = new Blob([String(source)], { type: "text/javascript" });
      url2 = URL.createObjectURL(blob);
      let namespace = null;
      try {
        namespace = await import(url2);
      } catch (importError) {
        namespace = compileByFunction(source);
      }
      let render = namespace && namespace.render;
      let setup = namespace && namespace.setup;
      let mediaDescriptor = namespace && namespace.media;
      let transitionDescriptor = namespace && namespace.transitionNeeds;
      if (namespace && namespace.default) {
        if (!render) render = namespace.default.render;
        setup = setup || namespace.default.setup;
        mediaDescriptor = mediaDescriptor || namespace.default.media;
        transitionDescriptor = transitionDescriptor || namespace.default.transitionNeeds;
      }
      if (typeof render !== "function") {
        const error = new Error("\u6A21\u5757\u5FC5\u987B\u5BFC\u51FA render(ctx2d, t, ctx) \u51FD\u6570");
        error.code = "NO_RENDER";
        throw error;
      }
      if (setup !== void 0 && typeof setup !== "function") {
        const error = new Error("setup \u5FC5\u987B\u662F\u51FD\u6570");
        error.code = "INVALID_SETUP";
        throw error;
      }
      return {
        render,
        setup: setup || null,
        media: mediaDescriptor || null,
        transitionNeeds: transitionDescriptor === void 0 ? null : transitionDescriptor
      };
    } finally {
      if (url2) {
        try {
          URL.revokeObjectURL(url2);
        } catch (error) {
        }
      }
    }
  }
  async function runSetup() {
    state2.clock.t = 0;
    if (state2.ctx) state2.ctx.props = state2.props;
    if (typeof state2.setup === "function") {
      await state2.setup(state2.props, state2.ctx);
    }
    state2.mediaNeeds = await collectMediaNeeds();
    state2.transitionNeeds = await collectTransitionNeeds();
    return state2.mediaNeeds;
  }
  async function initLayer(message) {
    state2.layerId = String(message.layerId || "");
    state2.width = Math.max(1, Math.round(Number(message.width) || 1));
    state2.height = Math.max(1, Math.round(Number(message.height) || 1));
    state2.props = message.props;
    state2.fps = Number(message.fps) > 0 ? Number(message.fps) : 30;
    state2.duration = Number(message.duration) > 0 ? Number(message.duration) : 0;
    state2.assets = Array.isArray(message.assets) ? message.assets : [];
    canvas = new OffscreenCanvas(state2.width, state2.height);
    draw2 = canvas.getContext("2d");
    if (!draw2) {
      const error = new Error("OffscreenCanvas \u65E0\u6CD5\u521B\u5EFA 2d \u4E0A\u4E0B\u6587");
      error.code = "NO_CONTEXT";
      throw error;
    }
    installClock();
    state2.media = makeMediaFacade();
    state2.transition = makeTransitionFacade(null);
    state2.ctx = {
      layerId: state2.layerId,
      width: state2.width,
      height: state2.height,
      props: state2.props,
      fps: state2.fps,
      duration: state2.duration,
      assets: state2.assets,
      media: state2.media,
      transition: state2.transition,
      get t() {
        return state2.clock.t;
      }
    };
    const loaded = await loadModule(message.moduleSource);
    state2.render = loaded.render;
    state2.setup = loaded.setup;
    state2.mediaDescriptor = loaded.media;
    state2.transitionDescriptor = loaded.transitionNeeds;
    self.__layer = {
      layerId: state2.layerId,
      width: state2.width,
      height: state2.height,
      render: state2.render,
      setup: state2.setup,
      get props() {
        return state2.props;
      },
      get t() {
        return state2.clock.t;
      },
      get fps() {
        return state2.fps;
      },
      get duration() {
        return state2.duration;
      },
      get assets() {
        return state2.assets;
      },
      get media() {
        return state2.media;
      },
      get mediaNeeds() {
        return state2.mediaNeeds;
      },
      get transition() {
        return state2.transition;
      },
      get transitionNeeds() {
        return state2.transitionNeeds;
      }
    };
    await runSetup();
  }
  async function renderFrame(message) {
    if (typeof state2.render !== "function") {
      const error = new Error("\u56FE\u5C42\u8FD8\u6CA1\u6709\u53EF\u7528\u7684\u6E32\u67D3\u51FD\u6570");
      error.code = "NOT_READY";
      throw error;
    }
    const time = Number(message.t);
    state2.clock.t = Number.isFinite(time) ? time : 0;
    installMedia(message.media);
    installTransitionFrames(message.transitionFrames);
    state2.transition = makeTransitionFacade(message.transition);
    if (state2.ctx) state2.ctx.transition = state2.transition;
    if (message.fps !== void 0) {
      const fps = Number(message.fps);
      if (fps > 0) state2.fps = fps;
    }
    if (message.duration !== void 0) {
      const duration = Number(message.duration);
      state2.duration = duration > 0 ? duration : 0;
    }
    if (Array.isArray(message.assets)) state2.assets = message.assets;
    if (state2.ctx) {
      state2.ctx.fps = state2.fps;
      state2.ctx.duration = state2.duration;
      state2.ctx.assets = state2.assets;
    }
    draw2.save();
    draw2.setTransform(1, 0, 0, 1, 0, 0);
    draw2.clearRect(0, 0, state2.width, state2.height);
    draw2.restore();
    await state2.render(draw2, state2.clock.t, state2.ctx);
    const bitmap = canvas.transferToImageBitmap();
    self.postMessage({ type: "frame", id: message.id, bitmap, t: state2.clock.t }, [bitmap]);
  }
  function enqueue(task) {
    queue2 = queue2.then(task).catch(function() {
    });
  }
  self.onmessage = function(event) {
    const message = event && event.data || {};
    if (message.type === "init") {
      enqueue(async function() {
        try {
          await initLayer(message);
          self.postMessage({
            type: "ready",
            id: message.id,
            mediaNeeds: state2.mediaNeeds,
            transitionNeeds: state2.transitionNeeds
          });
        } catch (error) {
          postError(message.id, error, "SETUP_FAILED", "init");
        }
      });
      return;
    }
    if (message.type === "props") {
      enqueue(async function() {
        try {
          state2.props = message.props;
          if (state2.ctx) state2.ctx.props = message.props;
          await runSetup();
          self.postMessage({
            type: "ack",
            id: message.id,
            kind: "props",
            mediaNeeds: state2.mediaNeeds,
            transitionNeeds: state2.transitionNeeds
          });
        } catch (error) {
          postError(message.id, error, "SETUP_FAILED", "props");
        }
      });
      return;
    }
    if (message.type === "render") {
      enqueue(async function() {
        try {
          await renderFrame(message);
        } catch (error) {
          postError(message.id, error, "RENDER_FAILED", "render");
        }
      });
    }
  };
}
var WORKER_SOURCE2 = "(" + workerBootstrap2.toString() + ")();";
function createCodeLayer(options = {}) {
  const layerId = String(options.layerId || "code-layer");
  const width = Math.round(Number(options.width));
  const height = Math.round(Number(options.height));
  const moduleSource = options.moduleSource;
  if (typeof moduleSource !== "string") {
    throw new CodeLayerError("INVALID_ARG", "moduleSource \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
  }
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new CodeLayerError("INVALID_ARG", "width/height \u5FC5\u987B\u662F\u6B63\u6570");
  }
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    throw new CodeLayerError("NO_DOCUMENT", "\u4EE3\u7801\u56FE\u5C42\u9700\u8981\u4E3B\u7EBF\u7A0B document");
  }
  const renderTimeoutMs = Number(options.renderTimeoutMs) > 0 ? Number(options.renderTimeoutMs) : DEFAULT_RENDER_TIMEOUT_MS;
  const setupTimeoutMs = Number(options.setupTimeoutMs) > 0 ? Number(options.setupTimeoutMs) : DEFAULT_SETUP_TIMEOUT_MS;
  const canvasEl = document.createElement("canvas");
  canvasEl.width = width;
  canvasEl.height = height;
  let currentSource = moduleSource;
  let currentProps = options.props;
  let latestMediaNeeds = [];
  let latestTransitionNeeds = { prev: false, next: false, composed: false };
  let currentAssets = Array.isArray(options.assets) ? options.assets : [];
  let currentFps = Number(options.fps) > 0 ? Number(options.fps) : 30;
  let currentDuration = Number(options.duration) > 0 ? Number(options.duration) : 0;
  let disposed = false;
  let fatalError = null;
  let worker = null;
  let workerUrl = null;
  let initPromise = null;
  let nextMessageId = 1;
  let renderChain = Promise.resolve();
  let updateChain = Promise.resolve();
  const pending4 = /* @__PURE__ */ new Map();
  function take(id) {
    const entry = pending4.get(id);
    if (!entry) return null;
    pending4.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    return entry;
  }
  function failAll(error) {
    const entries = Array.from(pending4.values());
    pending4.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
  function request(message, options2) {
    const opts = options2 || {};
    return new Promise((resolve, reject) => {
      if (disposed) {
        reject(new CodeLayerError("DISPOSED", "\u56FE\u5C42\u5DF2\u9500\u6BC1"));
        return;
      }
      if (fatalError) {
        reject(fatalError);
        return;
      }
      if (!worker) {
        reject(new CodeLayerError("NOT_READY", "\u56FE\u5C42\u6CA1\u6709\u53EF\u7528\u7684 Worker"));
        return;
      }
      const activeWorker = worker;
      const id = nextMessageId++;
      const entry = { id, kind: opts.kind || "", resolve, reject, timer: null };
      if (opts.timeoutMs > 0) {
        entry.timer = setTimeout(function() {
          if (pending4.get(id) !== entry) return;
          pending4.delete(id);
          const message2 = opts.timeoutCode === "RENDER_TIMEOUT" ? "render \u8D85\u8FC7 " + opts.timeoutMs + "ms \u672A\u8FD4\u56DE" : "setup \u8D85\u8FC7 " + opts.timeoutMs + "ms \u672A\u5B8C\u6210";
          const error = new CodeLayerError(opts.timeoutCode, message2);
          reject(error);
          if (opts.disposeOnTimeout !== false) dispose();
        }, opts.timeoutMs);
      }
      pending4.set(id, entry);
      try {
        const payload = Object.assign({}, message, { id });
        if (opts.transfer && opts.transfer.length) activeWorker.postMessage(payload, opts.transfer);
        else activeWorker.postMessage(payload);
      } catch (error) {
        take(id);
        reject(new CodeLayerError("POST_FAILED", "\u5411 Worker \u53D1\u9001\u6D88\u606F\u5931\u8D25\uFF1A" + (error && error.message ? error.message : error)));
      }
    });
  }
  function paintBitmap(bitmap) {
    const context = canvasEl.getContext("2d");
    if (!context) throw new CodeLayerError("NO_CONTEXT", "\u4E3B\u7EBF\u7A0B\u753B\u5E03\u65E0\u6CD5\u521B\u5EFA 2d \u4E0A\u4E0B\u6587");
    if (typeof context.transferFromImageBitmap === "function") {
      context.transferFromImageBitmap(bitmap);
      return;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
  }
  function settleFrame(message) {
    const entry = take(message.id);
    if (!entry) {
      if (message.bitmap && typeof message.bitmap.close === "function") message.bitmap.close();
      return;
    }
    try {
      paintBitmap(message.bitmap);
      entry.resolve();
    } catch (error) {
      if (message.bitmap && typeof message.bitmap.close === "function") message.bitmap.close();
      entry.reject(error instanceof CodeLayerError ? error : new CodeLayerError("DRAW_FAILED", "\u4E3B\u7EBF\u7A0B\u7ED8\u5236\u4F4D\u56FE\u5931\u8D25\uFF1A" + (error && error.message ? error.message : error)));
    }
  }
  function onWorkerMessage(event) {
    const message = event && event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "frame") {
      settleFrame(message);
      return;
    }
    if (message.type === "ready" || message.type === "ack") {
      if (Array.isArray(message.mediaNeeds)) latestMediaNeeds = message.mediaNeeds;
      if (message.transitionNeeds && typeof message.transitionNeeds === "object") {
        latestTransitionNeeds = {
          prev: !!message.transitionNeeds.prev,
          next: !!message.transitionNeeds.next,
          composed: message.transitionNeeds.composed || false
        };
      }
      const entry = take(message.id);
      if (entry) entry.resolve({ mediaNeeds: latestMediaNeeds, transitionNeeds: latestTransitionNeeds });
      return;
    }
    if (message.type === "error") {
      const error = new CodeLayerError(
        message.code || "WORKER_ERROR",
        message.message || message.code || "Worker \u62A5\u9519",
        message.phase ? { phase: message.phase } : void 0
      );
      if (message.id === void 0 || message.id === null) {
        fatalError = error;
        failAll(error);
        return;
      }
      const entry = take(message.id);
      if (entry) entry.reject(error);
    }
  }
  function onWorkerError(event) {
    fatalError = new CodeLayerError("WORKER_ERROR", event && event.message || "Worker \u8FD0\u884C\u65F6\u9519\u8BEF");
    failAll(fatalError);
  }
  function onWorkerMessageError() {
    fatalError = new CodeLayerError("WORKER_MESSAGE_ERROR", "Worker \u6D88\u606F\u53CD\u5E8F\u5217\u5316\u5931\u8D25");
    failAll(fatalError);
  }
  function killWorker(code, message) {
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      try {
        worker.terminate();
      } catch (error) {
      }
      worker = null;
    }
    if (workerUrl) {
      try {
        URL.revokeObjectURL(workerUrl);
      } catch (error) {
      }
      workerUrl = null;
    }
    failAll(new CodeLayerError(code || "DISPOSED", message || "\u56FE\u5C42\u5DF2\u9500\u6BC1"));
  }
  function startInit() {
    fatalError = null;
    const blob = new Blob([WORKER_SOURCE2], { type: "text/javascript" });
    const url2 = URL.createObjectURL(blob);
    let activeWorker = null;
    try {
      activeWorker = new Worker(url2);
    } catch (error) {
      try {
        URL.revokeObjectURL(url2);
      } catch (error2) {
      }
      throw new CodeLayerError("WORKER_BLOCKED", "\u65E0\u6CD5\u521B\u5EFA Worker\uFF1A" + (error && error.message ? error.message : error));
    }
    worker = activeWorker;
    workerUrl = url2;
    worker.onmessage = onWorkerMessage;
    worker.onerror = onWorkerError;
    worker.onmessageerror = onWorkerMessageError;
    initPromise = request(
      {
        type: "init",
        layerId,
        moduleSource: currentSource,
        props: currentProps,
        width,
        height,
        assets: currentAssets,
        fps: currentFps,
        duration: currentDuration
      },
      { kind: "init", timeoutMs: setupTimeoutMs, timeoutCode: "SETUP_TIMEOUT" }
    ).then(function(value) {
      return value;
    });
    initPromise.catch(function() {
    });
  }
  function render(t, frame) {
    const time = Number(t);
    const ctx2 = frame && typeof frame === "object" ? frame : {};
    const media = Array.isArray(ctx2.media) ? ctx2.media : [];
    const transitionFrames = Array.isArray(ctx2.transitionFrames) ? ctx2.transitionFrames : [];
    const task = renderChain.then(async function() {
      if (disposed) throw new CodeLayerError("DISPOSED", "\u56FE\u5C42\u5DF2\u9500\u6BC1");
      if (fatalError) throw fatalError;
      if (!Number.isFinite(time)) throw new CodeLayerError("INVALID_ARG", "t \u5FC5\u987B\u662F\u6570\u5B57\uFF08\u79D2\uFF09");
      await initPromise;
      const transfer = [];
      const seen = /* @__PURE__ */ new Set();
      for (const entry of media) {
        if (entry && entry.bitmap && !seen.has(entry.bitmap)) {
          seen.add(entry.bitmap);
          transfer.push(entry.bitmap);
        }
      }
      for (const entry of transitionFrames) {
        if (entry && entry.key && entry.bitmap && !seen.has(entry.bitmap)) {
          seen.add(entry.bitmap);
          transfer.push(entry.bitmap);
        }
      }
      try {
        await request(
          {
            type: "render",
            t: time,
            media,
            assets: Array.isArray(ctx2.assets) ? ctx2.assets : currentAssets,
            fps: ctx2.fps === void 0 ? currentFps : ctx2.fps,
            duration: ctx2.duration === void 0 ? currentDuration : ctx2.duration,
            transition: ctx2.transition || null,
            transitionFrames
          },
          { kind: "render", timeoutMs: renderTimeoutMs, timeoutCode: "RENDER_TIMEOUT", transfer }
        );
      } catch (error) {
        for (const bitmap of transfer) {
          if (bitmap && typeof bitmap.close === "function") {
            try {
              bitmap.close();
            } catch (error2) {
            }
          }
        }
        throw error;
      }
    });
    renderChain = task.catch(function() {
    });
    return task;
  }
  function update(patch = {}) {
    if (patch === null || typeof patch !== "object") {
      return Promise.reject(new CodeLayerError("INVALID_ARG", "update \u9700\u8981\u4E00\u4E2A\u5BF9\u8C61"));
    }
    const hasSource = patch.moduleSource !== void 0;
    const hasProps = patch.props !== void 0;
    if (hasSource && typeof patch.moduleSource !== "string") {
      return Promise.reject(new CodeLayerError("INVALID_ARG", "moduleSource \u5FC5\u987B\u662F\u5B57\u7B26\u4E32"));
    }
    const task = updateChain.then(async function() {
      if (disposed) throw new CodeLayerError("DISPOSED", "\u56FE\u5C42\u5DF2\u9500\u6BC1");
      if (fatalError) throw fatalError;
      if (hasSource) {
        currentSource = patch.moduleSource;
        if (hasProps) currentProps = patch.props;
        killWorker("REBUILDING", "\u56FE\u5C42\u6B63\u5728\u91CD\u5EFA");
        startInit();
        await initPromise;
        return;
      }
      if (hasProps) {
        currentProps = patch.props;
        await initPromise;
        await request({ type: "props", props: currentProps }, { kind: "props", timeoutMs: setupTimeoutMs, timeoutCode: "SETUP_TIMEOUT" });
      }
    });
    updateChain = task.catch(function() {
    });
    return task;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    killWorker("DISPOSED", "\u56FE\u5C42\u5DF2\u9500\u6BC1");
    canvasEl.width = 0;
    canvasEl.height = 0;
  }
  startInit();
  return {
    render,
    canvas: function() {
      return disposed ? null : canvasEl;
    },
    props: function() {
      return currentProps;
    },
    /** 模块声明的媒体需求（[{id}]）；宿主据此准备帧。老卡片没有声明时是空数组。 */
    mediaNeeds: function() {
      return latestMediaNeeds.map(function(need) {
        return { id: need.id };
      });
    },
    /** 模块声明的邻帧需求（{prev,next}）；没声明时两侧都是 false。 */
    transitionNeeds: function() {
      return {
        prev: !!latestTransitionNeeds.prev,
        next: !!latestTransitionNeeds.next,
        composed: latestTransitionNeeds.composed || false
      };
    },
    update,
    dispose,
    ready: function() {
      return initPromise;
    }
  };
}

// src/client/code-registry.js
function assetKindOf(asset) {
  const mime = String(asset && asset.mime || "").toLowerCase();
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "other";
}
function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function assetSummary(assets) {
  const out = [];
  for (const asset of assets || []) {
    if (!asset || !asset.id) continue;
    const probe2 = asset.probe || {};
    out.push({
      id: asset.id,
      kind: assetKindOf(asset),
      width: positive(probe2.width),
      height: positive(probe2.height),
      duration: positive(probe2.duration)
    });
  }
  return out;
}
function mediaFrameTime(localT, duration) {
  const t = Number(localT);
  const safe = Number.isFinite(t) ? t : 0;
  const total = Number(duration);
  if (Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.min(safe, Math.max(0, total - 1e-3)));
  }
  return Math.max(0, safe);
}
var DEFAULT_MEDIA_TIMEOUT_MS = 2500;
function waitForEvent(target, events, timeoutMs, ready) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ok);
    };
    const onOk = () => finish(true);
    const onErr = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      for (const event of events) target.removeEventListener(event, onOk);
      target.removeEventListener("error", onErr);
    }
    for (const event of events) target.addEventListener(event, onOk, { once: true });
    target.addEventListener("error", onErr, { once: true });
    if (typeof ready === "function") {
      let already = false;
      try {
        already = !!ready();
      } catch (error) {
        already = false;
      }
      if (already) finish(true);
    }
  });
}
function createDomMediaBridge(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_MEDIA_TIMEOUT_MS;
  const urlFor = typeof options.urlFor === "function" ? options.urlFor : () => null;
  const compose = typeof options.compose === "function" ? options.compose : null;
  const videos = /* @__PURE__ */ new Map();
  const images = /* @__PURE__ */ new Map();
  const canCreate = () => typeof document !== "undefined" && typeof document.createElement === "function";
  function releaseVideo(assetId) {
    const entry = videos.get(assetId);
    if (!entry) return;
    try {
      entry.v.pause();
      entry.v.removeAttribute("src");
      entry.v.load();
    } catch (error) {
    }
    videos.delete(assetId);
  }
  function videoEntry(asset, url2) {
    const existing = videos.get(asset.id);
    if (existing && existing.url === url2) return existing;
    if (existing) releaseVideo(asset.id);
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    video.src = url2;
    video.load();
    const entry = { v: video, url: url2, failed: false };
    video.addEventListener("error", () => {
      entry.failed = true;
    });
    videos.set(asset.id, entry);
    return entry;
  }
  async function videoFrame(asset, localT, url2) {
    const entry = videoEntry(asset, url2);
    const video = entry.v;
    if (entry.failed || video.error) return null;
    if (video.readyState < 1) {
      const ready = await waitForEvent(video, ["loadedmetadata"], timeoutMs, () => video.readyState >= 1);
      if (!ready) return null;
    }
    if (video.readyState < 2) {
      const ready = await waitForEvent(video, ["loadeddata", "canplay"], timeoutMs, () => video.readyState >= 2);
      if (!ready) return null;
    }
    if (video.error || video.readyState < 2 || !(video.videoWidth > 0)) return null;
    const sourceDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : positive(asset.probe && asset.probe.duration) || 0;
    const want = mediaFrameTime(localT, sourceDuration);
    if (Math.abs(video.currentTime - want) > 1e-3) {
      if (!video.paused) video.pause();
      let seeked;
      try {
        video.currentTime = want;
        seeked = video.seeking ? waitForEvent(video, ["seeked"], timeoutMs, () => !video.seeking && Math.abs(video.currentTime - want) <= 1e-3) : Promise.resolve(Math.abs(video.currentTime - want) <= 1e-3);
      } catch (error) {
        return null;
      }
      const ok = await seeked;
      if (!ok) return null;
    }
    if (!(Math.abs(video.currentTime - want) <= 0.25)) return null;
    let bitmap;
    try {
      if (typeof createImageBitmap !== "function") return null;
      bitmap = await createImageBitmap(video);
    } catch (error) {
      return null;
    }
    return { bitmap, width: video.videoWidth, height: video.videoHeight, time: video.currentTime };
  }
  async function imageFrame(asset, url2) {
    let image = images.get(asset.id);
    if (image && image.__codeMediaUrl !== url2) {
      images.delete(asset.id);
      image = null;
    }
    if (!image) {
      image = document.createElement("img");
      image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.__codeMediaUrl = url2;
      const loaded = new Promise((resolve) => {
        image.onload = () => resolve(true);
        image.onerror = () => resolve(false);
      });
      image.src = url2;
      images.set(asset.id, image);
      const timer = new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs));
      const ok = await Promise.race([loaded, timer]);
      if (!ok || !(image.naturalWidth > 0)) {
        images.delete(asset.id);
        return null;
      }
    }
    if (!(image.naturalWidth > 0)) return null;
    try {
      const bitmap = await createImageBitmap(image);
      return { bitmap, width: image.naturalWidth, height: image.naturalHeight, time: null };
    } catch (error) {
      return null;
    }
  }
  return {
    /**
     * 合成取帧：按**时间线时间**把整帧合成成一张位图（含邻镜的 transform / 滤镜 /
     * 蒙版 / 上层的媒体与文字叠层），给转场卡当邻帧用。
     *
     * 失败（没有合成通道 / 合成出错 / 超时）返回 null，并把中文原因写进诊断；
     * **不抛**。返回的位图归调用方所有（可以 transfer / close），缓存里那一份不会被交出去。
     *
     * @param {number} globalTime 时间线时间（秒）
     * @param {{clipId?: string}} [info] 请求方片段 id（只用于诊断）
     * @returns {Promise<ImageBitmap|null>}
     */
    async composeNeighborFrame(globalTime, info) {
      if (!compose) return null;
      let entry = null;
      try {
        entry = await compose(globalTime, info || {});
      } catch (error) {
        entry = null;
      }
      if (!entry || !entry.bitmap) return null;
      try {
        if (typeof createImageBitmap !== "function") return null;
        return await createImageBitmap(entry.bitmap);
      } catch (error) {
        return null;
      }
    },
    /**
     * 按**源时间**（素材自己的时间轴，秒）取一帧。转场上下文取邻帧走这里：
     * 「前一镜最后一帧」= 源时间 duration-ε，「后一镜第一帧」= 源时间 0+ε。
     * 内部复用同一套 <video> 池与 seek 核对逻辑，所以失败语义与 media 通道一致：
     * 任何一步不满足就返回 null，不拿上一帧冒充。
     *
     * @param {object} asset 素材记录（需要 id / mime / probe）
     * @param {number} sourceTime 素材源时间（秒）
     * @returns {Promise<null | {bitmap, width, height, time}>}
     */
    async frameAt(asset, sourceTime2) {
      if (!canCreate() || typeof createImageBitmap !== "function") return null;
      if (!asset || !asset.id) return null;
      const kind = assetKindOf(asset);
      if (kind !== "video" && kind !== "image") return null;
      const url2 = urlFor(asset.id);
      if (!url2) return null;
      try {
        if (kind === "image") return await imageFrame(asset, url2);
        return await videoFrame(asset, sourceTime2, url2);
      } catch (error) {
        return null;
      }
    },
    /**
     * @param {Array<{id:string}>} needs 模块声明的媒体需求
     * @param {Map<string, object>} byId 素材表
     * @param {number} localT 片段局部时间
     * @returns {Promise<{frames: Array}>} 位图由调用方 transfer 给 worker
     */
    async frames(needs, byId, localT) {
      const frames = [];
      if (!canCreate() || typeof createImageBitmap !== "function") return { frames };
      for (const need of needs || []) {
        const asset = byId.get(need && need.id);
        if (!asset) continue;
        const kind = assetKindOf(asset);
        if (kind !== "video" && kind !== "image") continue;
        const url2 = urlFor(asset.id);
        if (!url2) continue;
        const frame = kind === "video" ? await videoFrame(asset, localT, url2) : await imageFrame(asset, url2);
        if (!frame || !frame.bitmap) continue;
        frames.push({
          id: asset.id,
          kind,
          bitmap: frame.bitmap,
          width: frame.width,
          height: frame.height,
          time: frame.time
        });
      }
      return { frames };
    },
    dispose() {
      for (const id of [...videos.keys()]) releaseVideo(id);
      for (const image of images.values()) {
        try {
          image.src = "";
        } catch (error) {
        }
      }
      images.clear();
    }
  };
}
var TRANSITION_CACHE_LIMIT = 8;
var TRANSITION_EPSILON = 5e-4;
var DEFAULT_TRANSITION_TIMEOUT_MS = 2500;
var REASON_TEXT = {
  none: "\u8FD9\u4E00\u4FA7\u6CA1\u6709\u76F8\u90BB\u7247\u6BB5",
  ok: "",
  "no-media": "\u76F8\u90BB\u7247\u6BB5\u4E0D\u662F\u5A92\u4F53\uFF08\u6587\u5B57\u5361 / \u7EAF\u8272\u5361 / \u4EE3\u7801\u5361\uFF09\uFF0C\u6CA1\u6709\u53EF\u53D6\u7684\u6E90\u5E27",
  "no-asset": "\u76F8\u90BB\u7247\u6BB5\u5F15\u7528\u7684\u7D20\u6750\u4E0D\u5728\u5DE5\u7A0B\u7D20\u6750\u8868\u91CC",
  "decode-failed": "\u53D6\u5E27\u5931\u8D25\uFF1Aseek \u8D85\u65F6\u3001\u843D\u70B9\u504F\u5DEE\u8FC7\u5927\u6216\u89E3\u7801\u5931\u8D25",
  timeout: "\u53D6\u5E27\u8D85\u65F6",
  "compose-failed": "\u5408\u6210\u90BB\u5E27\u5931\u8D25\uFF1A\u65E0\u6CD5\u6309\u8FD9\u4E00\u65F6\u523B\u5408\u6210\u753B\u9762\uFF08\u8BE6\u89C1\u5408\u6210\u8BCA\u65AD\uFF09",
  "compose-timeout": "\u5408\u6210\u90BB\u5E27\u8D85\u65F6",
  "copy-failed": "\u53D6\u5E27\u6210\u529F\u4F46\u65E0\u6CD5\u590D\u5236\u4F4D\u56FE\uFF08\u6D4F\u89C8\u5668\u4E0D\u652F\u6301 createImageBitmap(ImageBitmap)\uFF09",
  "no-bridge": "\u5F53\u524D\u73AF\u5883\u6CA1\u6709\u53EF\u7528\u7684\u5A92\u4F53\u6865\uFF08\u65E0\u6CD5\u89E3\u7801\uFF09"
};
function transitionReasonText(reason, detail) {
  const base = REASON_TEXT[reason];
  if (base === void 0) return detail ? String(detail) : "\u672A\u77E5\u539F\u56E0\uFF1A" + String(reason);
  if (reason === "timeout" && detail) return base + "\uFF08>" + Math.round(Number(detail)) + "ms\uFF09";
  return base;
}
function clipKindOf(clip2) {
  if (!clip2) return "";
  if (clip2.type === "media") return "video";
  if (clip2.type === "code") return "code";
  if (clip2.type === "text") return "text";
  if (clip2.type === "audio") return "audio";
  return "other";
}
function trackKindOf(trackId, tracks) {
  if (!trackId || !Array.isArray(tracks)) return "";
  const found = tracks.find((t) => t && t.id === trackId);
  return found && found.kind ? String(found.kind) : "";
}
var TRACK_ORDER = { video: 0, code: 1, text: 2, other: 3, audio: 9 };
function trackRank(kind, trackId, tracks) {
  const order = TRACK_ORDER[kind] === void 0 ? 3 : TRACK_ORDER[kind];
  const index = Array.isArray(tracks) ? tracks.findIndex((t) => t && t.id === trackId) : -1;
  return [order, index < 0 ? 99 : index];
}
function normalizeCutAt(value, duration) {
  const total = Number(duration);
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
  const raw = value === null || value === void 0 || value === "" ? NaN : Number(value);
  if (!Number.isFinite(raw)) return { cutAt: safeTotal / 2, supplied: false, clamped: false };
  const cutAt = Math.max(0, Math.min(safeTotal, raw));
  return { cutAt, supplied: true, clamped: cutAt !== raw };
}
function inferCutOffset(clip2, clips, tracks) {
  const start = Number(clip2 && clip2.start);
  const duration = Number(clip2 && clip2.duration);
  if (!Number.isFinite(start) || !(duration > 0)) return null;
  const mid = duration / 2;
  let best = null;
  const byTrack = /* @__PURE__ */ new Map();
  for (const other of clips || []) {
    if (!other || !other.id || other.id === clip2.id) continue;
    if (clipKindOf(other) !== "video") continue;
    if (other.trackId && clip2.trackId && other.trackId === clip2.trackId) continue;
    const trackId = String(other.trackId || "");
    if (!byTrack.has(trackId)) byTrack.set(trackId, []);
    byTrack.get(trackId).push(other);
  }
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const next = list[i];
      if (Math.abs(prev.start + prev.duration - next.start) > 1e-3) continue;
      const local = next.start - start;
      if (!(local > 1e-6 && local < duration - 1e-6)) continue;
      const score = Math.abs(local - mid);
      if (!best || score < best.score) best = { offset: local, score };
    }
  }
  return best ? best.offset : null;
}
function pickNeighborClip(clip2, clips, tracks, t) {
  const candidates = [];
  for (const other of clips || []) {
    if (!other || !other.id || !other.trackId) continue;
    if (other.id === clip2.id) continue;
    if (clip2.trackId && other.trackId === clip2.trackId) continue;
    const kind = trackKindOf(other.trackId, tracks) || clipKindOf(other);
    if (kind === "audio") continue;
    const start = Number(other.start);
    const duration = Number(other.duration);
    if (!Number.isFinite(start) || !(duration > 0)) continue;
    if (!(start <= t && t < start + duration)) continue;
    candidates.push({ clip: other, rank: trackRank(kind, other.trackId, tracks) });
  }
  if (!candidates.length) return { has: false, clip: null, reason: "none" };
  candidates.sort(
    (a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || String(a.clip.id).localeCompare(String(b.clip.id))
  );
  const best = candidates[0].clip;
  return { has: true, clip: best, reason: neighborFrameReason(best) };
}
function neighborFrameReason(clip2) {
  if (!clip2) return "none";
  const kind = clipKindOf(clip2);
  if (kind !== "video") return "no-media";
  if (!clip2.assetId) return "no-asset";
  return "ok";
}
function resolveTransitionContext(clip2, options = {}) {
  const clips = Array.isArray(options.clips) ? options.clips : [];
  const tracks = Array.isArray(options.tracks) ? options.tracks : [];
  const duration = Number(clip2 && clip2.duration) > 0 ? Number(clip2.duration) : 0;
  const fps = Number(options.fps) > 0 ? Number(options.fps) : 30;
  const props = clip2 && clip2.props || {};
  const supplied = props.cutAt !== void 0 && props.cutAt !== null ? props.cutAt : clip2 && clip2.cutAt;
  const normalized = normalizeCutAt(supplied, duration);
  let cutAt = normalized.cutAt;
  let source = normalized.supplied ? "props" : "middle";
  if (normalized.clamped) source = "clamped";
  if (!normalized.supplied) {
    const inferred = inferCutOffset(clip2, clips, tracks);
    if (inferred !== null) {
      cutAt = inferred;
      source = "cut";
    }
  }
  const start = Number(clip2 && clip2.start) || 0;
  const cutGlobal = start + cutAt;
  return {
    cutAt,
    cutGlobal,
    source,
    fps,
    prev: pickNeighborClip(clip2, clips, tracks, cutGlobal - TRANSITION_EPSILON),
    next: pickNeighborClip(clip2, clips, tracks, cutGlobal + TRANSITION_EPSILON)
  };
}
function neighborFrameTime(neighbor, side, fps) {
  const duration = Number(neighbor && neighbor.duration);
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const frame = 1 / (Number(fps) > 0 ? Number(fps) : 30);
  const localT = side === "next" ? Math.min(total, frame * 0.5) : Math.max(0, total - frame * 0.5);
  return Math.max(0, (Number(neighbor && neighbor.sourceIn) || 0) + sourceOffsetOf(neighbor || {}, localT));
}
function transitionFrameKey(clipId, time) {
  const n = Number(time);
  const safe = Number.isFinite(n) ? Math.round(n * 1e3) / 1e3 : 0;
  return String(clipId) + "@" + safe.toFixed(3);
}
function createTransitionFrameCache(options = {}) {
  const limit = Math.max(1, Math.round(Number(options.limit) > 0 ? Number(options.limit) : TRANSITION_CACHE_LIMIT));
  const onEvict = typeof options.onEvict === "function" ? options.onEvict : null;
  const map = /* @__PURE__ */ new Map();
  const inflight = /* @__PURE__ */ new Map();
  const stats = { hits: 0, misses: 0, decodes: 0, evictions: 0, failures: 0 };
  function evict(key) {
    const value = map.get(key);
    map.delete(key);
    stats.evictions += 1;
    if (onEvict) {
      try {
        onEvict(value, key);
      } catch (error) {
      }
    }
  }
  async function load(key, loader) {
    if (map.has(key)) {
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      stats.hits += 1;
      return value;
    }
    if (inflight.has(key)) return inflight.get(key);
    stats.misses += 1;
    const task = (async () => {
      let value = null;
      try {
        value = await loader();
      } catch (error) {
        value = null;
      }
      if (!value) {
        stats.failures += 1;
        return null;
      }
      stats.decodes += 1;
      while (map.size >= limit) evict(map.keys().next().value);
      map.set(key, value);
      return value;
    })();
    inflight.set(key, task);
    try {
      return await task;
    } finally {
      inflight.delete(key);
    }
  }
  return {
    load,
    has: (key) => map.has(key),
    size: () => map.size,
    keys: () => [...map.keys()],
    stats,
    clear() {
      for (const key of [...map.keys()]) evict(key);
      inflight.clear();
    }
  };
}
var COMPOSITE_CACHE_LIMIT = 4;
var DEFAULT_COMPOSE_TIMEOUT_MS = 4e3;
var COMPOSE_REASON_TEXT = {
  ok: "",
  "no-draw": "\u5F53\u524D\u73AF\u5883\u6CA1\u6709\u53EF\u7528\u7684\u5408\u6210\u5668\uFF08drawFrame\uFF09\uFF0C\u65E0\u6CD5\u5408\u6210\u90BB\u5E27",
  "no-layer": "\u8FD9\u4E00\u65F6\u523B\u65F6\u95F4\u7EBF\u4E0A\u6CA1\u6709\u4EFB\u4F55\u53EF\u5408\u6210\u7684\u56FE\u5C42",
  "no-media": "\u90BB\u955C\u6CA1\u6709\u53D6\u5230\u7D20\u6750\u5E27\uFF08\u7D20\u6750\u7F3A\u5931 / \u89E3\u7801\u5931\u8D25\uFF09\uFF0C\u65E0\u6CD5\u5408\u6210",
  "no-canvas": "\u65E0\u6CD5\u521B\u5EFA\u79BB\u5C4F\u753B\u5E03\uFF0C\u65E0\u6CD5\u5408\u6210\u90BB\u5E27",
  "draw-error": "\u5408\u6210\u65F6\u62A5\u9519\uFF1A\u67D0\u4E00\u56FE\u5C42\u7ED8\u5236\u5931\u8D25",
  timeout: "\u5408\u6210\u90BB\u5E27\u8D85\u65F6",
  "compose-timeout": "\u5408\u6210\u90BB\u5E27\u8D85\u65F6",
  "bitmap-failed": "\u5408\u6210\u5B8C\u6210\u4F46\u65E0\u6CD5\u8F6C\u6210\u4F4D\u56FE",
  "no-compose": "\u8FD9\u4E00\u5E27\u6CA1\u6709\u53EF\u7528\u7684\u5408\u6210\u901A\u9053"
};
function composeReasonText(reason, detail) {
  const base = COMPOSE_REASON_TEXT[reason];
  if (base === void 0) return detail ? String(detail) : "\u672A\u77E5\u5408\u6210\u5931\u8D25\u539F\u56E0\uFF1A" + String(reason);
  if ((reason === "timeout" || reason === "compose-timeout") && detail) {
    return base + "\uFF08>" + Math.round(Number(detail)) + "ms\uFF09";
  }
  if (reason === "draw-error" && detail) return base + "\uFF1A" + String(detail);
  return base;
}
function compositeFrameKey(globalTime, revision) {
  const n = Number(globalTime);
  const ms = Number.isFinite(n) ? Math.round(n * 1e3) : 0;
  const rev = Math.round(Number(revision) || 0);
  return "c" + ms + "ms@r" + rev;
}
function composedFrameKey(clipId, globalTime) {
  const n = Number(globalTime);
  const ms = Number.isFinite(n) ? Math.round(n * 1e3) : 0;
  return String(clipId) + "#c@" + ms;
}
function normalizeComposedNeeds(value, wanted) {
  const prev = !!(wanted && wanted.prev);
  const next = !!(wanted && wanted.next);
  if (!prev && !next) return false;
  let side = false;
  if (value === true) side = "both";
  else if (typeof value === "string") {
    const s = value.toLowerCase();
    if (s === "prev") side = "prev";
    else if (s === "next") side = "next";
    else if (s === "both" || s === "all" || s === "true") side = "both";
  }
  if (!side) return false;
  if (side === "both") {
    if (prev && next) return "both";
    return prev ? "prev" : "next";
  }
  if (side === "prev") return prev ? "prev" : next ? "next" : false;
  if (side === "next") return next ? "next" : prev ? "prev" : false;
  return false;
}
function defaultCompositeCanvas(width, height) {
  if (typeof OffscreenCanvas === "function") {
    try {
      return new OffscreenCanvas(width, height);
    } catch (error) {
    }
  }
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}
function defaultCompositeBitmap(canvas) {
  if (!canvas) return Promise.resolve(null);
  if (typeof canvas.transferToImageBitmap === "function") {
    return Promise.resolve(canvas.transferToImageBitmap());
  }
  if (typeof createImageBitmap === "function") return createImageBitmap(canvas);
  return Promise.resolve(null);
}
function createCompositeFrameProvider(options = {}) {
  const limit = Math.max(
    1,
    Math.round(Number(options.cacheLimit) > 0 ? Number(options.cacheLimit) : COMPOSITE_CACHE_LIMIT)
  );
  const width = Math.max(2, Math.round(Number(options.width) > 0 ? Number(options.width) : 960));
  const height = Math.max(2, Math.round(Number(options.height) > 0 ? Number(options.height) : 540));
  const drawFrame2 = typeof options.drawFrame === "function" ? options.drawFrame : null;
  const frameLayers2 = typeof options.frameLayers === "function" ? options.frameLayers : null;
  const sourceTime2 = typeof options.sourceTime === "function" ? options.sourceTime : null;
  const resolveMediaFrame = typeof options.resolveMediaFrame === "function" ? options.resolveMediaFrame : null;
  const context = typeof options.context === "function" ? options.context : () => ({});
  const createCanvas2 = typeof options.createCanvas === "function" ? options.createCanvas : defaultCompositeCanvas;
  const toBitmap = typeof options.toBitmap === "function" ? options.toBitmap : defaultCompositeBitmap;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const log = typeof options.log === "function" ? options.log : null;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_COMPOSE_TIMEOUT_MS;
  const map = /* @__PURE__ */ new Map();
  const inflight = /* @__PURE__ */ new Map();
  let lastRevision = null;
  const stats = {
    hits: 0,
    misses: 0,
    builds: 0,
    evictions: 0,
    failures: 0,
    mediaDecodes: 0,
    lastMs: 0,
    totalMs: 0,
    maxMs: 0
  };
  function closeBitmap(bitmap) {
    if (bitmap && typeof bitmap.close === "function") {
      try {
        bitmap.close();
      } catch (error) {
      }
    }
  }
  function note(code, detail, extra) {
    const message = composeReasonText(code, detail);
    const issue = Object.assign({ ok: false, code, message }, extra || {});
    if (log) {
      try {
        log(issue);
      } catch (error) {
      }
    }
    return issue;
  }
  function evictOldest() {
    const oldest = map.keys().next().value;
    if (oldest === void 0) return;
    const entry = map.get(oldest);
    map.delete(oldest);
    stats.evictions += 1;
    closeBitmap(entry && entry.bitmap);
  }
  function pruneRevision(revision) {
    if (lastRevision === null) {
      lastRevision = revision;
      return;
    }
    if (revision === lastRevision) return;
    lastRevision = revision;
    clear();
  }
  function safeContext() {
    try {
      return context() || {};
    } catch (error) {
      return {};
    }
  }
  function revisionOf(view2) {
    return Math.round(Number(view2 && view2.revision) || 0);
  }
  async function build(globalTime) {
    const started = now();
    const view2 = safeContext();
    if (!drawFrame2 || !frameLayers2 || !sourceTime2) {
      return note("no-draw", "", { globalTime });
    }
    const clips = Array.isArray(view2.clips) ? view2.clips : [];
    const assets = Array.isArray(view2.assets) ? view2.assets : [];
    const allLayers = frameLayers2(clips, globalTime) || [];
    const layers = allLayers.filter((layer) => layer && layer.kind !== "code");
    if (!layers.length) return note("no-layer", "", { globalTime });
    const byId = new Map(assets.filter((a) => a && a.id).map((a) => [a.id, a]));
    const media = /* @__PURE__ */ new Map();
    const owned = [];
    for (const layer of layers) {
      if (layer.kind !== "media") continue;
      const clip2 = layer.clip;
      if (!clip2 || !clip2.assetId || !resolveMediaFrame) continue;
      const asset = byId.get(clip2.assetId);
      if (!asset) continue;
      let frame = null;
      try {
        frame = await resolveMediaFrame(asset, sourceTime2(clip2, layer.localT), clip2);
      } catch (error) {
        frame = null;
      }
      if (!frame) continue;
      const bitmap2 = frame.bitmap || frame;
      if (!bitmap2) continue;
      media.set(clip2.id, bitmap2);
      owned.push(bitmap2);
      stats.mediaDecodes += 1;
    }
    if (!media.size) {
      return note("no-media", "", { globalTime });
    }
    const canvas = createCanvas2(width, height);
    if (!canvas || typeof canvas.getContext !== "function") {
      closeOwned(owned);
      return note("no-canvas", "", { globalTime });
    }
    const ctx2 = canvas.getContext("2d", { alpha: false });
    if (!ctx2) {
      closeOwned(owned);
      return note("no-canvas", "", { globalTime });
    }
    try {
      drawFrame2(ctx2, {
        clips,
        assets,
        t: globalTime,
        width,
        height,
        layers,
        mediaFrame: (clip2) => clip2 && media.get(clip2.id) || null
      });
    } catch (error) {
      closeOwned(owned);
      return note("draw-error", error && error.message, { globalTime });
    }
    closeOwned(owned);
    let bitmap = null;
    try {
      bitmap = await toBitmap(canvas);
    } catch (error) {
      bitmap = null;
    }
    if (!bitmap) return note("bitmap-failed", "", { globalTime });
    const ms = Math.max(0, now() - started);
    stats.builds += 1;
    stats.totalMs += ms;
    stats.lastMs = ms;
    stats.maxMs = Math.max(stats.maxMs, ms);
    return {
      ok: true,
      code: "ok",
      message: "",
      bitmap,
      width,
      height,
      time: globalTime,
      ms,
      cached: false
    };
  }
  function closeOwned(list) {
    for (const bitmap of list) closeBitmap(bitmap);
  }
  function raceTimeout(promise, ms) {
    if (!(ms > 0)) return promise.then((value) => ({ timedOut: false, value }));
    const TIMEOUT = { __timeout: true };
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), ms);
    });
    return Promise.race([promise, timeout]).then(
      (value) => {
        if (timer) clearTimeout(timer);
        return { timedOut: value === TIMEOUT, value: value === TIMEOUT ? null : value };
      },
      (error) => {
        if (timer) clearTimeout(timer);
        return { timedOut: false, value: null, error };
      }
    );
  }
  function clear() {
    for (const key of [...map.keys()]) {
      const entry = map.get(key);
      map.delete(key);
      closeBitmap(entry && entry.bitmap);
    }
    inflight.clear();
  }
  async function compose(globalTime, info) {
    const t = Number(globalTime);
    if (!Number.isFinite(t)) return null;
    const clipId = info && info.clipId ? String(info.clipId) : null;
    const view2 = safeContext();
    const revision = revisionOf(view2);
    pruneRevision(revision);
    const key = compositeFrameKey(t, revision);
    if (map.has(key)) {
      const entry = map.get(key);
      map.delete(key);
      map.set(key, entry);
      stats.hits += 1;
      return Object.assign({}, entry, { cached: true });
    }
    if (inflight.has(key)) return inflight.get(key);
    stats.misses += 1;
    const task = (async () => {
      const result = await raceTimeout(build(t), timeoutMs);
      if (result.timedOut) {
        stats.failures += 1;
        note("timeout", timeoutMs, { globalTime: t, clipId });
        return null;
      }
      const entry = result.value;
      if (!entry || !entry.ok || !entry.bitmap) {
        stats.failures += 1;
        return null;
      }
      while (map.size >= limit) evictOldest();
      map.set(key, entry);
      return Object.assign({}, entry, { cached: false });
    })();
    inflight.set(key, task);
    try {
      return await task;
    } finally {
      inflight.delete(key);
    }
  }
  return {
    compose,
    width,
    height,
    cacheLimit: limit,
    size: () => map.size,
    keys: () => [...map.keys()],
    stats,
    clear,
    dispose: clear
  };
}
var PRESENTED_FPS_WINDOW_MS = 1e3;
function timeKey(t) {
  return Math.round(Number(t) * 1e6);
}
function createCodeRegistry(opts = {}) {
  const projectId = opts.projectId;
  const onError = opts.onError;
  const records = /* @__PURE__ */ new Map();
  const layerFactory = typeof opts.layerFactory === "function" ? opts.layerFactory : createCodeLayer;
  let bridge = null;
  function defaultContext() {
    const doc = state.doc || {};
    const assets = (state.assets && state.assets.length ? state.assets : doc.assets) || [];
    return {
      assets,
      fps: Number(doc.fps) || 30,
      duration: Number(doc.duration) || 0,
      clips: state.clips || doc.clips || [],
      tracks: doc.tracks || [],
      // 合成帧缓存按它作废：revision 一变，旧帧对应的就是别的时间线了。
      revision: Math.round(Number(doc.revision) || 0),
      doc
    };
  }
  function readContext() {
    try {
      return (typeof opts.context === "function" ? opts.context() : defaultContext()) || { assets: [], fps: 30 };
    } catch (error) {
      return { assets: [], fps: 30 };
    }
  }
  function assetUrl(assetId) {
    if (typeof opts.urlFor === "function") return opts.urlFor(assetId);
    return "/api/video/media?projectId=" + encodeURIComponent(projectId) + "&assetId=" + encodeURIComponent(assetId) + "&variant=preview";
  }
  function getBridge() {
    if (bridge) return bridge;
    if (opts.mediaBridge === null) return null;
    if (opts.mediaBridge) {
      bridge = opts.mediaBridge;
      return bridge;
    }
    bridge = createDomMediaBridge({
      urlFor: assetUrl,
      timeoutMs: opts.mediaTimeoutMs,
      // 媒体桥的合成入口最终落到注册表的合成 provider（它知道时间线与 revision）。
      compose: (globalTime, info) => composeFrameAt(globalTime, info)
    });
    return bridge;
  }
  async function readLayerSource(layerId) {
    if (typeof opts.readLayerSource === "function") return opts.readLayerSource(layerId);
    const value = await rpc("code.read", { projectId, layerId });
    return value && value.source;
  }
  let summaryRef = null;
  let summary = [];
  let byId = /* @__PURE__ */ new Map();
  let clipsRef = null;
  function contextAssets(context) {
    const assets = context && context.assets || [];
    if (assets !== summaryRef) {
      summaryRef = assets;
      summary = assetSummary(assets);
      byId = new Map(assets.filter((a) => a && a.id).map((a) => [a.id, a]));
    }
    return { summary, byId };
  }
  function closeBitmap(bitmap) {
    if (bitmap && typeof bitmap.close === "function") {
      try {
        bitmap.close();
      } catch (error) {
      }
    }
  }
  const transitionCache = createTransitionFrameCache({
    limit: opts.transitionCacheLimit,
    onEvict: typeof opts.onTransitionFrameEvict === "function" ? opts.onTransitionFrameEvict : (entry) => closeBitmap(entry && entry.bitmap)
  });
  async function copyFrameForTransfer(bitmap) {
    if (typeof opts.copyFrame === "function") return opts.copyFrame(bitmap);
    if (typeof createImageBitmap !== "function") return null;
    return createImageBitmap(bitmap);
  }
  function withTimeout(promise, timeoutMs) {
    if (!(timeoutMs > 0)) return promise.then((value) => ({ value, timedOut: false }));
    const TIMEOUT = { __timeout: true };
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    });
    return Promise.race([promise, timeout]).then(
      (value) => {
        if (timer) clearTimeout(timer);
        return { value: value === TIMEOUT ? null : value, timedOut: value === TIMEOUT };
      },
      (error) => {
        if (timer) clearTimeout(timer);
        return { value: null, timedOut: false, error };
      }
    );
  }
  function bareSide(info) {
    return {
      has: !!(info && info.has),
      clipId: info && info.clip ? String(info.clip.id) : null,
      reason: info && info.reason ? String(info.reason) : "none",
      message: transitionReasonText(info && info.reason),
      time: null,
      // 这一侧拿到的是不是合成帧。合成失败时保持 false，frame() 返回 null（rawFrame 仍可用）。
      composed: false,
      // 这一侧**有没有要求**合成。合成失败时 composed=false 但 wanted=true，
      // worker 据此决定 frame() 返回 null 而不是退回原始帧。
      composedWanted: false,
      composedKey: null
    };
  }
  const composeDiagnostics = Array.isArray(opts.composeDiagnostics) ? opts.composeDiagnostics : null;
  let lastComposeDiagnostic = null;
  let composer = null;
  function recordComposeDiagnostic(issue) {
    if (!issue) return;
    const record = Object.assign({ at: Date.now() }, issue);
    lastComposeDiagnostic = record;
    if (composeDiagnostics) composeDiagnostics.push(record);
    if (typeof opts.onComposeDiagnostic === "function") {
      try {
        opts.onComposeDiagnostic(record);
      } catch (error) {
      }
    }
  }
  function getComposer() {
    if (composer) return composer;
    if (typeof opts.composeFrame === "function") {
      composer = { compose: (globalTime, info) => opts.composeFrame(globalTime, info), stats: null };
      return composer;
    }
    composer = createCompositeFrameProvider({
      width: opts.composeWidth,
      height: opts.composeHeight,
      context: () => {
        const current = readContext();
        return { clips: current.clips, assets: current.assets, revision: current.revision };
      },
      drawFrame: typeof opts.drawFrame === "function" ? opts.drawFrame : drawFrame,
      frameLayers: typeof opts.frameLayers === "function" ? opts.frameLayers : frameLayers,
      sourceTime: typeof opts.sourceTime === "function" ? opts.sourceTime : sourceTime,
      resolveMediaFrame: (asset, sourceTime2) => {
        const mediaBridge = getBridge();
        if (!mediaBridge || typeof mediaBridge.frameAt !== "function") return null;
        return mediaBridge.frameAt(asset, sourceTime2);
      },
      cacheLimit: opts.compositeCacheLimit,
      timeoutMs: opts.composeTimeoutMs,
      log: recordComposeDiagnostic
    });
    return composer;
  }
  async function composeFrameAt(globalTime, info) {
    try {
      return await getComposer().compose(globalTime, info || {});
    } catch (error) {
      return null;
    }
  }
  async function prepareSide(side, info, context, frames, globalTime, composedWanted) {
    const out = bareSide(info);
    out.composedWanted = !!composedWanted;
    if (!out.has || !info.clip) return out;
    if (out.reason !== "ok") return out;
    const neighbor = info.clip;
    const assets = contextAssets(context);
    const asset = assets.byId.get(neighbor.assetId);
    if (!asset) {
      out.reason = "no-asset";
      out.message = transitionReasonText("no-asset");
      return out;
    }
    const kind = assetKindOf(asset);
    if (kind !== "video" && kind !== "image") {
      out.reason = "no-media";
      out.message = transitionReasonText("no-media");
      return out;
    }
    const fps = Number(context.fps) > 0 ? Number(context.fps) : 30;
    const time = neighborFrameTime(neighbor, side, fps);
    out.time = time;
    const key = transitionFrameKey(neighbor.id, time);
    const timeoutMs = Number(opts.transitionTimeoutMs) > 0 ? Number(opts.transitionTimeoutMs) : DEFAULT_TRANSITION_TIMEOUT_MS;
    const prepared = await withTimeout(
      transitionCache.load(key, async () => {
        const mediaBridge = getBridge();
        if (!mediaBridge || typeof mediaBridge.frameAt !== "function") return null;
        try {
          return await mediaBridge.frameAt(asset, time);
        } catch (error) {
          return null;
        }
      }),
      timeoutMs
    );
    if (prepared.timedOut) {
      out.reason = "timeout";
      out.message = transitionReasonText("timeout", timeoutMs);
    } else if (!prepared.value || !prepared.value.bitmap) {
      out.reason = "decode-failed";
      out.message = transitionReasonText("decode-failed");
    } else {
      let bitmap = null;
      try {
        bitmap = await copyFrameForTransfer(prepared.value.bitmap);
      } catch (error) {
        bitmap = null;
      }
      if (!bitmap) {
        out.reason = "copy-failed";
        out.message = transitionReasonText("copy-failed");
      } else {
        out.reason = "ok";
        out.message = "";
        frames.push({
          key,
          bitmap,
          width: Number(prepared.value.width) || 0,
          height: Number(prepared.value.height) || 0,
          time,
          clipId: out.clipId,
          side,
          composed: false
        });
      }
    }
    if (!composedWanted) return out;
    const composeTimeoutMs = Number(opts.composeTimeoutMs) > 0 ? Number(opts.composeTimeoutMs) : DEFAULT_COMPOSE_TIMEOUT_MS;
    const composedKey = composedFrameKey(neighbor.id, globalTime);
    const composedPrepared = await withTimeout(
      composeFrameAt(globalTime, { clipId: out.clipId, revision: context.revision, side }),
      composeTimeoutMs
    );
    if (composedPrepared.timedOut) {
      out.reason = "compose-timeout";
      out.message = composeReasonText("compose-timeout", composeTimeoutMs);
      out.composed = false;
      return out;
    }
    const entry = composedPrepared.value;
    if (!entry || !entry.bitmap) {
      out.reason = "compose-failed";
      out.message = lastComposeDiagnostic && lastComposeDiagnostic.globalTime === globalTime && lastComposeDiagnostic.message || composeReasonText("compose-failed");
      out.composed = false;
      return out;
    }
    let composedBitmap = null;
    try {
      composedBitmap = await copyFrameForTransfer(entry.bitmap);
    } catch (error) {
      composedBitmap = null;
    }
    if (!composedBitmap) {
      out.reason = "copy-failed";
      out.message = transitionReasonText("copy-failed");
      out.composed = false;
      return out;
    }
    out.reason = "ok";
    out.message = "";
    out.composed = true;
    out.composedKey = composedKey;
    frames.push({
      key: composedKey,
      bitmap: composedBitmap,
      width: Number(entry.width) || 0,
      height: Number(entry.height) || 0,
      time: globalTime,
      clipId: out.clipId,
      side,
      composed: true
    });
    return out;
  }
  async function prepareTransition(clip2, context, rec) {
    if (context.clips !== clipsRef) {
      if (clipsRef !== null) transitionCache.clear();
      clipsRef = context.clips;
    }
    const plan = resolveTransitionContext(clip2, {
      clips: context.clips,
      tracks: context.tracks,
      fps: context.fps
    });
    const payload = {
      cutAt: plan.cutAt,
      cutGlobal: plan.cutGlobal,
      declared: false,
      composed: false,
      source: plan.source,
      prev: bareSide(plan.prev),
      next: bareSide(plan.next)
    };
    const frames = [];
    let needs = null;
    try {
      needs = typeof rec.layer.transitionNeeds === "function" ? rec.layer.transitionNeeds() : null;
    } catch (error) {
      needs = null;
    }
    const wanted = { prev: !!(needs && needs.prev), next: !!(needs && needs.next) };
    payload.declared = wanted.prev || wanted.next;
    if (!payload.declared) return { payload, frames };
    const composedFor = normalizeComposedNeeds(needs && needs.composed, wanted);
    payload.composed = composedFor;
    if (wanted.prev) {
      payload.prev = await prepareSide(
        "prev",
        plan.prev,
        context,
        frames,
        plan.cutGlobal,
        composedFor === "prev" || composedFor === "both"
      );
    }
    if (wanted.next) {
      payload.next = await prepareSide(
        "next",
        plan.next,
        context,
        frames,
        plan.cutGlobal,
        composedFor === "next" || composedFor === "both"
      );
    }
    return { payload, frames };
  }
  async function ensure(clip2) {
    const key = String(clip2.layerId) + ":" + String(clip2.codeHash || "");
    const existing = records.get(clip2.id);
    if (existing && existing.key === key) return existing;
    if (existing) {
      existing.layer.dispose();
      records.delete(clip2.id);
    }
    const [source, context] = [await readLayerSource(clip2.layerId), readContext()];
    const assets = contextAssets(context);
    const layer = layerFactory({
      layerId: clip2.layerId,
      moduleSource: source,
      props: clip2.props || {},
      width: 960,
      height: 540,
      assets: assets.summary,
      fps: Number(context.fps) > 0 ? Number(context.fps) : 30,
      duration: Number(clip2.duration) > 0 ? Number(clip2.duration) : 0
    });
    await layer.ready();
    const rec = {
      key,
      layer,
      // 最近一次「请求过」的 t（诊断用）
      lastT: -999,
      // 预览：最新想要的一帧 / 它属于哪一代 / 正在渲染的那一代
      wantT: null,
      wantKey: null,
      wantGen: 0,
      inflight: null,
      inflightT: null,
      inflightKey: null,
      // 画布上现在真的是哪一帧（只有它算「上屏」）
      doneT: null,
      doneKey: null,
      doneGen: 0
    };
    records.set(clip2.id, rec);
    return rec;
  }
  function active(clips, t) {
    return clips.filter((c) => c.type === "code" && t >= c.start && t < c.start + c.duration);
  }
  const presented = [];
  const previewStats = {
    requested: 0,
    renders: 0,
    presented: 0,
    staleDrops: 0,
    lateFrames: 0,
    coalesced: 0
  };
  const nowMs = typeof opts.now === "function" ? opts.now : () => typeof performance !== "undefined" && performance && typeof performance.now === "function" ? performance.now() : Date.now();
  function notePresented() {
    const stamp3 = nowMs();
    previewStats.presented += 1;
    presented.push(stamp3);
    const cut = stamp3 - PRESENTED_FPS_WINDOW_MS;
    while (presented.length && presented[0] < cut) presented.shift();
  }
  function presentedFps() {
    if (!presented.length) return 0;
    const now = nowMs();
    const span = Math.max(1, Math.min(PRESENTED_FPS_WINDOW_MS, now - presented[0]));
    return Math.round(presented.length / span * 1e3 * 10) / 10;
  }
  function playbackStats() {
    return {
      requested: previewStats.requested,
      renders: previewStats.renders,
      presented: previewStats.presented,
      droppedFrames: Math.max(0, previewStats.requested - previewStats.presented),
      staleDrops: previewStats.staleDrops,
      lateFrames: previewStats.lateFrames,
      coalesced: previewStats.coalesced,
      presentedFps: presentedFps(),
      windowMs: PRESENTED_FPS_WINDOW_MS,
      layers: records.size
    };
  }
  async function pumpPreview(rec, clip2) {
    for (; ; ) {
      const wantT = rec.wantT;
      if (wantT === null) return;
      const wantKey = rec.wantKey;
      const gen = rec.wantGen;
      rec.inflightT = wantT;
      rec.inflightKey = wantKey;
      previewStats.renders += 1;
      let ok = true;
      try {
        await renderCode(rec, clip2, wantT);
      } catch (error) {
        ok = false;
        if (onError) onError(error, clip2);
      }
      const superseded = gen !== rec.wantGen;
      const wantNow = rec.wantT;
      const wentBackwards = superseded && (wantNow === null || Number.isFinite(wantNow) && wantNow < wantT - 1e-9);
      if (wentBackwards) {
        previewStats.staleDrops += 1;
        if (wantNow === null) return;
        continue;
      }
      if (ok) {
        rec.doneT = wantT;
        rec.doneKey = wantKey;
        rec.doneGen = gen;
        if (superseded) previewStats.lateFrames += 1;
        notePresented();
      }
      if (!superseded) return;
    }
  }
  function startPreview(rec, clip2) {
    if (rec.inflight) return rec.inflight;
    const task = pumpPreview(rec, clip2);
    rec.inflight = task;
    const clear = () => {
      if (rec.inflight === task) {
        rec.inflight = null;
        rec.inflightT = null;
        rec.inflightKey = null;
      }
    };
    task.then(clear, clear);
    return task;
  }
  function requestPreview(rec, clip2, localT) {
    const want = Number(localT) || 0;
    const key = timeKey(want);
    if (rec.inflight) {
      if (rec.inflightKey === key) return "skipped";
      rec.wantT = want;
      rec.wantKey = key;
      rec.wantGen += 1;
      rec.lastT = want;
      previewStats.requested += 1;
      previewStats.coalesced += 1;
      return "coalesced";
    }
    if (rec.doneKey === key) return "skipped";
    rec.wantT = want;
    rec.wantKey = key;
    rec.wantGen += 1;
    rec.lastT = want;
    previewStats.requested += 1;
    startPreview(rec, clip2);
    return "started";
  }
  async function retirePreview(rec) {
    rec.wantT = null;
    rec.wantKey = null;
    rec.wantGen += 1;
    const task = rec.inflight;
    if (!task) return;
    try {
      await task;
    } catch (error) {
    }
  }
  async function renderCode(rec, clip2, localT) {
    const context = readContext();
    const assets = contextAssets(context);
    let media = [];
    const needs = typeof rec.layer.mediaNeeds === "function" ? rec.layer.mediaNeeds() : [];
    if (needs && needs.length) {
      const mediaBridge = getBridge();
      if (mediaBridge && typeof mediaBridge.frames === "function") {
        try {
          const prepared = await mediaBridge.frames(needs, assets.byId, localT);
          media = prepared && prepared.frames || [];
        } catch (error) {
          media = [];
        }
      }
    }
    let transition = null;
    try {
      transition = await prepareTransition(clip2, context, rec);
    } catch (error) {
      transition = {
        payload: {
          cutAt: 0,
          declared: false,
          prev: bareSide({ has: false, reason: "none" }),
          next: bareSide({ has: false, reason: "none" })
        },
        frames: []
      };
    }
    await rec.layer.render(localT, {
      media,
      assets: assets.summary,
      fps: Number(context.fps) > 0 ? Number(context.fps) : 30,
      duration: Number(clip2.duration) > 0 ? Number(clip2.duration) : 0,
      transition: transition.payload,
      transitionFrames: transition.frames
    });
  }
  async function tick(clips, t, playing) {
    void playing;
    for (const clip2 of active(clips, t)) {
      let rec;
      try {
        rec = await ensure(clip2);
      } catch (e) {
        onError && onError(e, clip2);
        continue;
      }
      requestPreview(rec, clip2, t - clip2.start);
    }
  }
  async function renderAt(clips, t) {
    for (const clip2 of active(clips, t)) {
      const rec = await ensure(clip2);
      await retirePreview(rec);
      await renderCode(rec, clip2, t - clip2.start);
      rec.doneT = t - clip2.start;
      rec.doneKey = timeKey(t - clip2.start);
      rec.doneGen = rec.wantGen;
    }
  }
  function canvasFor(clip2) {
    const rec = records.get(clip2.id);
    return rec && rec.layer ? rec.layer.canvas() : null;
  }
  async function renderLayers(layers) {
    for (const layer of layers || []) {
      if (!layer || layer.kind !== "code") continue;
      const rec = await ensure(layer.clip);
      await retirePreview(rec);
      await renderCode(rec, layer.clip, layer.localT);
      rec.doneT = layer.localT;
      rec.doneKey = timeKey(layer.localT);
      rec.doneGen = rec.wantGen;
    }
  }
  async function tickLayers(layers, playing) {
    void playing;
    for (const layer of layers || []) {
      if (!layer || layer.kind !== "code") continue;
      const clip2 = layer.clip;
      let rec;
      try {
        rec = await ensure(clip2);
      } catch (e) {
        onError && onError(e, clip2);
        continue;
      }
      requestPreview(rec, clip2, layer.localT);
    }
  }
  function draw2(ctx2, clips, t, w, h4) {
    for (const clip2 of active(clips, t)) {
      const canvas = canvasFor(clip2);
      if (!canvas) continue;
      try {
        ctx2.drawImage(canvas, 0, 0, w, h4);
      } catch {
      }
    }
  }
  function dispose() {
    for (const rec of records.values()) rec.layer.dispose();
    records.clear();
    transitionCache.clear();
    if (composer && typeof composer.dispose === "function") {
      try {
        composer.dispose();
      } catch (error) {
      }
    }
    composer = null;
    if (bridge && typeof bridge.dispose === "function") {
      try {
        bridge.dispose();
      } catch (error) {
      }
    }
    bridge = null;
  }
  const api = {
    tick,
    renderAt,
    draw: draw2,
    dispose,
    canvasFor,
    renderLayers,
    tickLayers,
    /** 播放循环指标（requested / renders / presented / droppedFrames / staleDrops / presentedFps）。 */
    playbackStats,
    /** 合成一帧邻镜画面（调试 / 采样 / 测试用）；失败返回 null。 */
    composeFrame: composeFrameAt,
    /** 合成 provider 的统计（hits / misses / builds / lastMs / maxMs…）；没启用时是 null。 */
    composeStats: () => composer && composer.stats || null,
    /** 最近的合成诊断（中文）；没有失败时为 null。 */
    lastComposeDiagnostic: () => lastComposeDiagnostic,
    transitionCache
  };
  try {
    if (typeof globalThis !== "undefined") globalThis.__dshPlaybackStats = playbackStats;
  } catch (error) {
  }
  return api;
}

// src/srt.mjs
function parseSrt(text) {
  const clean = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const blocks = clean.split(/\n{2,}/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    let idx = 0;
    if (/^\d+$/.test(lines[0].trim())) idx = 1;
    const timeLine = lines[idx];
    if (!timeLine || !timeLine.includes("-->")) continue;
    const m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(timeLine);
    if (!m) continue;
    const toSec = (h4, mi, s, ms) => Number(h4) * 3600 + Number(mi) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1e3;
    const start = toSec(m[1], m[2], m[3], m[4]);
    const end = toSec(m[5], m[6], m[7], m[8]);
    if (!(end > start)) continue;
    const body = lines.slice(idx + 1).join("\n").trim();
    if (!body) continue;
    out.push({ start: Math.round(start * 1e3) / 1e3, end: Math.round(end * 1e3) / 1e3, text: body });
  }
  return out;
}
function pad(n, len = 2) {
  return String(n).padStart(len, "0");
}
function stamp2(sec) {
  const total = Math.max(0, sec);
  const h4 = Math.floor(total / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1e3);
  return pad(h4) + ":" + pad(m) + ":" + pad(s) + "," + pad(ms, 3);
}
function toSrt(entries) {
  const list = (entries || []).filter((e) => e && Number.isFinite(e.start) && Number.isFinite(e.end) && e.end > e.start && e.text).sort((a, b) => a.start - b.start);
  return list.map((e, i) => `${i + 1}
${stamp2(e.start)} --> ${stamp2(e.end)}
${String(e.text).trim()}
`).join("\n");
}
function clipsToSrt(clips) {
  return toSrt(
    (clips || []).filter((c) => c.type === "text").map((c) => ({ start: c.start, end: c.start + c.duration, text: c.text || "" }))
  );
}

// src/client/main.js
var OPTION_STYLE2 = { background: T.bg, color: T.text };
function h3(type, props, ...children) {
  if (type !== "select") return import_react3.default.createElement(type, props, ...children);
  const flat = [];
  const push = (c) => {
    if (Array.isArray(c)) c.forEach(push);
    else if (c != null && c !== false) flat.push(c);
  };
  children.forEach(push);
  const kids = flat.map(
    (c) => c && c.type === "option" ? import_react3.default.createElement("option", {
      key: c.key,
      ...c.props,
      style: { ...OPTION_STYLE2, ...c.props && c.props.style || {} }
    }) : c
  );
  return import_react3.default.createElement(
    "select",
    { ...props || {}, style: { colorScheme: "dark", ...props && props.style || {} } },
    ...kids
  );
}
var PANEL_ID = "video-workbench";
function beacon(stage, detail) {
  try {
    fetch("/api/video/beacon", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage, detail: detail == null ? "" : String(detail) })
    }).catch(() => {
    });
  } catch {
  }
}
function useStore() {
  const [, force] = import_react3.default.useReducer((n) => n + 1, 0);
  import_react3.default.useEffect(() => subscribe(force), []);
  return state;
}
var btn = (label, onClick, extra) => h3(
  "button",
  {
    type: "button",
    onClick,
    style: Object.assign(
      {
        padding: "4px 10px",
        borderRadius: 6,
        border: `1px solid ${T.border}`,
        background: T.panel,
        color: T.text,
        fontSize: 12,
        cursor: "pointer"
      },
      extra || {}
    )
  },
  label
);
async function copyText(text) {
  const value = String(text == null ? "" : text);
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
  }
  try {
    if (!document || !document.body) return false;
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "readonly");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    area.style.top = "0";
    document.body.appendChild(area);
    area.select();
    const ok = typeof document.execCommand === "function" && document.execCommand("copy");
    document.body.removeChild(area);
    return !!ok;
  } catch {
    return false;
  }
}
function useFillHeight(ref) {
  const [height, setHeight] = import_react3.default.useState(0);
  import_react3.default.useEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const parent = el.parentElement;
      const next = fitPanelHeight({
        viewportHeight: typeof window !== "undefined" ? window.innerHeight : 0,
        top: rect.top,
        parentHeight: parent ? parent.clientHeight : 0,
        min: WORKBENCH_LAYOUT.minPanelHeight
      });
      setHeight((cur) => Math.abs(cur - next) < 2 ? cur : next);
    };
    measure();
    if (typeof window === "undefined") return void 0;
    window.addEventListener("resize", measure);
    let ro = null;
    if (typeof ResizeObserver !== "undefined" && ref.current && ref.current.parentElement) {
      ro = new ResizeObserver(() => requestAnimationFrame(measure));
      ro.observe(ref.current.parentElement);
    }
    return () => {
      window.removeEventListener("resize", measure);
      if (ro) ro.disconnect();
    };
  }, [ref]);
  return height;
}
function PlayerCanvas({ clips, assets, playing, playhead, code, engineRef, onTime, onMediaState, onDiagnostic, getAudio }) {
  const canvasRef = import_react3.default.useRef(null);
  const viewRef = import_react3.default.useRef({ clips, assets });
  viewRef.current = { clips, assets };
  const onTimeRef = import_react3.default.useRef(onTime);
  onTimeRef.current = onTime;
  const mediaStateRef = import_react3.default.useRef(onMediaState);
  mediaStateRef.current = onMediaState;
  const diagRef = import_react3.default.useRef(onDiagnostic);
  diagRef.current = onDiagnostic;
  const codeRef = import_react3.default.useRef(code);
  codeRef.current = code;
  const audioRef = import_react3.default.useRef(getAudio);
  audioRef.current = getAudio;
  import_react3.default.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return void 0;
    const ctx2 = canvas.getContext("2d", { alpha: false });
    const W = 960;
    const H = 540;
    canvas.width = W;
    canvas.height = H;
    ctx2.fillStyle = "#000";
    ctx2.fillRect(0, 0, W, H);
    let lastUi = 0;
    const paint = (t, meta) => {
      const view2 = viewRef.current;
      const layers = frameLayers(view2.clips, t);
      const registry = codeRef.current;
      if (registry) {
        try {
          registry.tickLayers(layers, !!(meta && meta.playing)).catch(() => {
          });
        } catch {
        }
      }
      paintPreviewFrame(ctx2, {
        clips: view2.clips,
        assets: view2.assets,
        t,
        width: W,
        height: H,
        layers,
        codeCanvas: registry ? (clip2) => registry.canvasFor(clip2) : null,
        onMediaState: (list) => {
          const fn = mediaStateRef.current;
          if (fn) fn(list);
        }
      });
    };
    const engine = createPlaybackEngine({
      getView: () => ({
        clips: viewRef.current.clips,
        assets: viewRef.current.assets,
        duration: state.doc ? state.doc.duration : 0
      }),
      draw: paint,
      onTick: (t) => {
        state.playhead = t;
        const stamp3 = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
        if (stamp3 - lastUi > 33) {
          lastUi = stamp3;
          onTimeRef.current(t);
        }
      },
      onEnd: () => setState({ playing: false, playhead: state.doc ? state.doc.duration : state.playhead }),
      onDiagnostic: (list) => {
        const fn = diagRef.current;
        if (fn) fn(list);
      },
      getAudio: () => audioRef.current ? audioRef.current() : null
    });
    if (engineRef) engineRef.current = engine;
    engine.setPlayhead(Number(playhead) || 0);
    if (state.playing) engine.play(state.playhead);
    else engine.refresh();
    const off = onMediaReady(() => {
      const e = engineRef && engineRef.current;
      if (e) e.refresh();
    });
    return () => {
      off();
      engine.dispose();
      if (engineRef) engineRef.current = null;
    };
  }, []);
  import_react3.default.useEffect(() => {
    const engine = engineRef && engineRef.current;
    if (!engine) return;
    if (playing && !engine.isPlaying()) engine.play(state.playhead);
    else if (!playing && engine.isPlaying()) engine.pause();
  }, [playing, engineRef]);
  return h3("canvas", {
    ref: canvasRef,
    style: {
      width: "100%",
      height: "100%",
      maxHeight: "100%",
      objectFit: "contain",
      background: "#000",
      display: "block"
    }
  });
}
function Workbench(props) {
  const s = useStore();
  const [undoInfo, setUndoInfo] = import_react3.default.useState({ undo: [], redo: [] });
  const [showLog, setShowLog] = import_react3.default.useState(false);
  const [exportSettings, setExportSettings] = import_react3.default.useState({ width: 1920, height: 1080, fps: 30 });
  const [exportOpen, setExportOpen] = import_react3.default.useState(false);
  const [exportForm, setExportForm] = import_react3.default.useState({
    resolution: "project",
    fps: "project",
    bitrate: "auto",
    range: "all"
  });
  const [caps, setCaps] = import_react3.default.useState(null);
  const [capsBusy, setCapsBusy] = import_react3.default.useState(false);
  const [capsError, setCapsError] = import_react3.default.useState(null);
  const [diag, setDiag] = import_react3.default.useState(null);
  const [textOpen, setTextOpen] = import_react3.default.useState(false);
  const [textValue, setTextValue] = import_react3.default.useState("");
  const [annot, setAnnot] = import_react3.default.useState(null);
  const [exported, setExported] = import_react3.default.useState(null);
  const [deleteAsk, setDeleteAsk] = import_react3.default.useState(false);
  const [renaming, setRenaming] = import_react3.default.useState(false);
  const [renameValue, setRenameValue] = import_react3.default.useState("");
  const [switchOpen, setSwitchOpen] = import_react3.default.useState(false);
  const [analysis, setAnalysis] = import_react3.default.useState(null);
  const [mediaIssue, setMediaIssue] = import_react3.default.useState(null);
  const mediaIssueRef = import_react3.default.useRef(null);
  mediaIssueRef.current = mediaIssue;
  const issueSigRef = import_react3.default.useRef("");
  const onMediaState = import_react3.default.useCallback((list) => {
    const visible = (list || []).filter((d) => d.code !== "seek-pending" && d.code !== "seek-drift");
    const sig = visible.map((d) => d.code + ":" + d.assetId).join("|");
    if (sig === issueSigRef.current) return;
    issueSigRef.current = sig;
    setMediaIssue(visible.length ? visible : null);
  }, []);
  const active = s.active !== false;
  const playbackRef = import_react3.default.useRef(null);
  const rootRef = import_react3.default.useRef(null);
  const panelHeight = useFillHeight(rootRef);
  const [seekDiag, setSeekDiag] = import_react3.default.useState([]);
  const [audioIssues, setAudioIssues] = import_react3.default.useState(null);
  const audioIssuesSigRef = import_react3.default.useRef("");
  const projectIdForIssues = s.projectId;
  const docRevisionForIssues = s.doc && s.doc.revision || 0;
  import_react3.default.useEffect(() => {
    if (!projectIdForIssues) {
      setAudioIssues(null);
      audioIssuesSigRef.current = "";
      return void 0;
    }
    let cancelled = false;
    (async () => {
      try {
        const value = await rpc("timeline.audioIssues", { projectId: projectIdForIssues });
        if (cancelled || !value) return;
        const sig = value.count ? value.count + ":" + (value.issues || []).map((i) => i.clipId).join(",") : "";
        if (sig === audioIssuesSigRef.current) return;
        audioIssuesSigRef.current = sig;
        setAudioIssues(value.count ? value : null);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectIdForIssues, docRevisionForIssues]);
  async function repairAudioTracks() {
    if (state.busy || !state.projectId) return;
    try {
      setState({ busy: { label: "\u79FB\u5230\u97F3\u9891\u8F68", ratio: 0.4 } });
      const value = await rpc("timeline.repairAudio", { projectId: state.projectId, sessionId: state.sessionId });
      audioIssuesSigRef.current = "";
      await refresh();
      if (value && value.count) setAudioIssues(value);
      else setAudioIssues(null);
      toast(value && value.moved ? `\u5DF2\u628A ${value.moved} \u4E2A\u97F3\u9891\u7247\u6BB5\u79FB\u5230\u97F3\u9891\u8F68` : "\u6CA1\u6709\u9700\u8981\u4FEE\u590D\u7684\u7247\u6BB5");
    } catch (e) {
      reportError(e, "\u4FEE\u590D\u97F3\u9891\u8F68\u5931\u8D25");
    } finally {
      setState({ busy: null });
    }
  }
  async function runDiag() {
    setState({ busy: { label: "\u68C0\u6D4B\u4E2D", ratio: 0.5 } });
    try {
      setDiag(await probe());
    } catch (e) {
      reportError(e, "\u68C0\u6D4B\u5931\u8D25");
    } finally {
      setState({ busy: null });
    }
  }
  const sessionId = props && props.sessionId || props && props.session && (props.session.id || props.session.sessionId);
  import_react3.default.useEffect(() => {
    if (sessionId && sessionId !== state.sessionId) {
      setState({
        sessionId,
        projectId: null,
        doc: null,
        clips: [],
        assets: [],
        active: false,
        enabled: [],
        mine: [],
        selection: null,
        playhead: 0,
        playing: false
      });
    }
  }, [sessionId]);
  async function createProject2() {
    if (state.busy) return;
    try {
      const ui = ctxRef.get("uiWorkspace");
      const parent = await ui.pickDirectory();
      if (!parent) return;
      const name = "\u89C6\u9891\u5DE5\u7A0B-" + (/* @__PURE__ */ new Date()).toISOString().slice(5, 10).replace("-", "") + "-" + Math.random().toString(36).slice(2, 5);
      const dir = await ui.createDirectory(parent, name).catch(() => parent);
      setState({ busy: { label: "\u65B0\u5EFA\u5DE5\u7A0B", ratio: 0.5 } });
      await openProject(dir);
      setState({ active: false });
      await loadMyProjects().catch(() => []);
      toast("\u5DE5\u7A0B\u5DF2\u521B\u5EFA\u5E76\u7ED1\u5B9A\u5F53\u524D\u4F1A\u8BDD");
    } catch (e) {
      reportError(e, "\u6253\u5F00\u5DE5\u7A0B\u5931\u8D25");
    } finally {
      setState({ busy: null });
    }
  }
  const doc = s.doc;
  const clips = s.clips || [];
  const assets = s.assets || [];
  function togglePlayback() {
    const engine = playbackRef.current;
    const current = state.doc;
    if (!current) return;
    const duration = Number(current.duration) || 0;
    if (state.playing) {
      if (engine) engine.pause();
      setState({ playing: false });
      return;
    }
    const from = duration > 0 && state.playhead >= duration - 1e-3 ? 0 : state.playhead;
    if (engine) engine.play(from);
    setState({ playing: true, playhead: from });
  }
  function seekTo(t, opts) {
    const engine = playbackRef.current;
    const duration = state.doc ? Number(state.doc.duration) || 0 : 0;
    const target = clampTime(t, duration);
    if (engine) engine.seek(target, opts || {});
    setState({ playhead: target });
  }
  const lastProjectRef = import_react3.default.useRef(state.projectId);
  import_react3.default.useEffect(() => {
    if (lastProjectRef.current === state.projectId) return;
    lastProjectRef.current = state.projectId;
    releaseHeavy();
  }, [state.projectId]);
  import_react3.default.useEffect(() => {
    if (!state.sessionId) return void 0;
    let alive = true;
    (async () => {
      try {
        await loadEnabled();
      } catch (e) {
        if (alive) reportError(e, "\u8BFB\u53D6\u542F\u7528\u5217\u8868\u5931\u8D25");
      }
      if (!alive) return;
      let list = [];
      try {
        list = await loadMyProjects();
      } catch {
        list = [];
      }
      if (!alive) return;
      let bound = null;
      try {
        const value = await rpc("project.restore", { sessionId: state.sessionId });
        bound = value && value.doc ? value.doc : null;
      } catch {
        bound = null;
      }
      if (!alive) return;
      setState({
        doc: bound,
        projectId: bound ? bound.projectId : null,
        clips: [],
        assets: [],
        selection: null,
        playhead: 0,
        active: false
      });
      try {
        await loadMyProjects();
      } catch {
      }
    })();
    return () => {
      alive = false;
    };
  }, [state.sessionId]);
  function releaseHeavy() {
    clearPool();
    clearThumbs();
    clearWaveforms();
    ensureSigRef.current = "";
  }
  async function enterProject(project) {
    if (!project || !project.projectId || state.busy) return;
    setState({ busy: { label: "\u8FDB\u5165\u5DE5\u7A0B", ratio: 0.25 } });
    try {
      const root = project.root || (state.doc && state.doc.projectId === project.projectId ? state.doc.root : "");
      if (!root) throw new Error("\u8FD9\u4E2A\u5DE5\u7A0B\u6CA1\u6709\u8BB0\u5F55\u78C1\u76D8\u8DEF\u5F84\uFF0C\u65E0\u6CD5\u6253\u5F00");
      await enableProject(project.projectId, root);
      setState({ busy: { label: "\u8FDB\u5165\u5DE5\u7A0B", ratio: 0.65 } });
      await openProject(root);
      setState({ active: true, playing: false, playhead: 0, selection: null });
      await loadMyProjects().catch(() => []);
      toast("\u5DF2\u8FDB\u5165 " + (state.doc ? state.doc.title : project.title || "\u5DE5\u7A0B"));
    } catch (e) {
      reportError(e, "\u8FDB\u5165\u5DE5\u7A0B\u5931\u8D25");
    } finally {
      setState({ busy: null });
    }
  }
  async function stopProject(project) {
    const target = project && project.projectId ? project.projectId : state.projectId;
    if (!target) {
      setState({ active: false });
      return;
    }
    try {
      await disableProject(target);
    } catch (e) {
      return reportError(e, "\u505C\u6B62\u542F\u7528\u5931\u8D25");
    }
    releaseHeavy();
    setState({ active: false, playing: false, playhead: 0, selection: null, flash: null, history: [] });
    await loadMyProjects().catch(() => []);
    toast("\u5DF2\u505C\u6B62\u542F\u7528\uFF0C\u989D\u5EA6\u5DF2\u91CA\u653E");
  }
  async function switchTo(project) {
    setSwitchOpen(false);
    if (!project || !project.projectId || project.projectId === state.projectId || state.busy) return;
    setState({ busy: { label: "\u5207\u6362\u5DE5\u7A0B", ratio: 0.3 } });
    try {
      if (!project.root) throw new Error("\u8FD9\u4E2A\u5DE5\u7A0B\u6CA1\u6709\u8BB0\u5F55\u78C1\u76D8\u8DEF\u5F84\uFF0C\u65E0\u6CD5\u6253\u5F00");
      if (project.open === false) await openProject(project.root);
      await rebindProject(project.projectId);
      releaseHeavy();
      setState({ projectId: null, doc: null, clips: [], assets: [], playing: false, playhead: 0, selection: null });
      await openProject(project.root);
      setState({ active: true });
      await loadMyProjects().catch(() => []);
      await loadEnabled().catch(() => null);
      toast("\u5DF2\u5207\u6362\u5230 " + (state.doc ? state.doc.title : project.title || "\u5DE5\u7A0B"));
    } catch (e) {
      reportError(e, "\u5207\u6362\u5DE5\u7A0B\u5931\u8D25");
    } finally {
      setState({ busy: null });
    }
  }
  async function renameTo(projectId, rawTitle) {
    const title = String(rawTitle == null ? "" : rawTitle).trim();
    if (!title) return toast("\u5DE5\u7A0B\u540D\u4E0D\u80FD\u4E3A\u7A7A", "warn");
    if (Array.from(title).length > 60) return toast("\u5DE5\u7A0B\u540D\u6700\u591A 60 \u4E2A\u5B57", "warn");
    try {
      const next = await renameProject(projectId, state.sessionId, title);
      setRenaming(false);
      setRenameValue("");
      if (projectId === state.projectId) await refresh();
      await loadMyProjects().catch(() => []);
      toast("\u5DF2\u91CD\u547D\u540D\u4E3A\u300C" + (next && next.title || title) + "\u300D");
    } catch (e) {
      reportError(e, "\u91CD\u547D\u540D\u5931\u8D25");
    }
  }
  async function commitRename() {
    return renameTo(state.projectId, renameValue);
  }
  import_react3.default.useEffect(() => {
    if (!state.projectId || !active) return void 0;
    const es = new EventSource("/api/video/events?projectId=" + encodeURIComponent(state.projectId));
    const onChange = (ev) => {
      refresh().catch(() => {
      });
      try {
        const data = JSON.parse(ev.data || "{}");
        if (data && data.type === "commit" && data.human) {
          const next = [{ at: data.at || Date.now(), human: data.human, origin: data.origin || "ui", revision: data.revision, transactionId: data.transactionId }].concat(state.history || []).slice(0, 20);
          setState({ history: next });
        }
      } catch {
      }
    };
    es.addEventListener("change", onChange);
    return () => {
      es.removeEventListener("change", onChange);
      es.close();
    };
  }, [state.projectId, active]);
  async function removeProject() {
    if (!doc) return;
    setDeleteAsk(true);
  }
  async function doRemoveProject(deleteFiles) {
    setDeleteAsk(false);
    try {
      await deleteProject(deleteFiles);
      toast("\u5DE5\u7A0B\u5DF2\u5220\u9664" + (deleteFiles ? "\uFF08\u542B\u6587\u4EF6\uFF09" : "\uFF08\u6587\u4EF6\u4FDD\u7559\uFF09"));
    } catch (e) {
      reportError(e, "\u5220\u9664\u5DE5\u7A0B\u5931\u8D25");
    }
  }
  const codeRef = import_react3.default.useRef(null);
  import_react3.default.useEffect(() => {
    if (!state.projectId || !active) return void 0;
    const registry = createCodeRegistry({
      projectId: state.projectId,
      onError: (e, clip2) => {
        if (state.toast && state.toast.message === e.message) return;
        setState({ toast: { message: "\u4EE3\u7801\u56FE\u5C42 " + clip2.layerId + "\uFF1A" + e.message, tone: "warn" } });
      }
    });
    codeRef.current = registry;
    return () => {
      registry.dispose();
      codeRef.current = null;
    };
  }, [state.projectId, active]);
  const audioRef = import_react3.default.useRef(null);
  import_react3.default.useEffect(() => {
    if (!state.projectId || !active) return void 0;
    if (!audioRef.current) {
      audioRef.current = createAudioEngine({
        getSegments: () => {
          const byId = new Map((state.assets || []).map((a) => [a.id, a]));
          const out = [];
          for (const c of state.clips || []) {
            if (c.type !== "media" && c.type !== "audio") continue;
            const tr = (state.doc && state.doc.tracks || []).find((t) => t.id === c.trackId);
            if (tr && tr.muted) continue;
            const a = byId.get(c.assetId);
            if (!a) continue;
            out.push({
              assetId: a.id,
              url: mediaUrl(a.id, { preview: true }),
              start: c.start,
              duration: c.duration,
              sourceIn: c.sourceIn || 0,
              speed: c.speed || 1,
              volume: c.volume == null ? 1 : c.volume,
              fadeIn: c.fadeIn,
              fadeOut: c.fadeOut,
              muted: !!c.muted,
              // 混音纪律要用的角色（voice/music/sfx）；未标注由引擎按 sfx 处理
              audioRole: c.audioRole
            });
          }
          return out;
        }
      });
    }
    return () => {
      if (audioRef.current) {
        audioRef.current.dispose();
        audioRef.current = null;
      }
    };
  }, [state.projectId, active]);
  import_react3.default.useEffect(() => {
    const sampler = createSampler({ getCode: () => codeRef.current });
    if (state.projectId && active) sampler.start();
    return () => sampler.stop();
  }, [state.projectId, active]);
  import_react3.default.useEffect(() => {
    if (!active) return void 0;
    const audioClips = (s.clips || []).filter((c) => c.trackId === "a1");
    if (audioClips.length) {
      let alive = true;
      (async () => {
        let added = 0;
        for (const c of audioClips) {
          const asset = (s.assets || []).find((a) => a.id === c.assetId);
          if (!asset) continue;
          const got = await prefetchWaveform(asset.id, mediaUrl(asset.id, { preview: true }));
          if (got) added += 1;
          if (!alive) return;
        }
        if (alive && added) setState({ thumbTick: Date.now() });
      })();
      return () => {
        alive = false;
      };
    }
    return void 0;
  }, [s.doc && s.doc.revision, s.assets.length, active]);
  import_react3.default.useEffect(() => {
    if (!active) return void 0;
    const media = (s.clips || []).filter((c) => c.type === "media");
    if (!media.length) return void 0;
    let alive = true;
    (async () => {
      let added = 0;
      for (const c of media) {
        const asset = (s.assets || []).find((a) => a.id === c.assetId);
        if (!asset || !asset.mime || !asset.mime.startsWith("video")) continue;
        const got = await prefetchThumb(asset.id, mediaUrl(asset.id, { preview: true }), (c.sourceIn || 0) + 0.2);
        if (got) added += 1;
        if (!alive) return;
      }
      if (alive && added) setState({ thumbTick: Date.now() });
    })();
    return () => {
      alive = false;
    };
  }, [s.doc && s.doc.revision, s.assets.length, active]);
  const probedRef = import_react3.default.useRef(/* @__PURE__ */ new Set());
  import_react3.default.useEffect(() => {
    if (!active) return;
    const pending4 = (s.assets || []).filter((a) => !a.probe && !probedRef.current.has(a.id));
    for (const a of pending4) {
      probedRef.current.add(a.id);
      probeAsset(a);
    }
  }, [s.assets, active]);
  const ensureSigRef = import_react3.default.useRef("");
  import_react3.default.useEffect(() => {
    if (!s.projectId || !active) return;
    const list = (s.assets || []).filter((a) => a.mime && String(a.mime).startsWith("video/"));
    if (!list.length) return;
    const sig = s.projectId + "|" + list.map((a) => a.id).join(",");
    if (sig === ensureSigRef.current) return;
    ensureSigRef.current = sig;
    const keep = new Set((s.clips || []).map((c) => c.assetId).filter(Boolean));
    const made = ensureVideos(list, (id) => mediaUrl(id, { preview: true }), { keep });
    if (made) setState({ mediaTick: Date.now() });
  }, [s.assets, s.doc && s.doc.revision, s.projectId, active, s.clips.length]);
  function retryMedia(assetId) {
    const ids = assetId ? [assetId] : (mediaIssueRef.current || []).map((d) => d.assetId);
    const uniq = [...new Set(ids)].filter(Boolean);
    if (!uniq.length) {
      toast("\u73B0\u5728\u6CA1\u6709\u9700\u8981\u91CD\u8F7D\u7684\u7D20\u6750", "warn");
      return;
    }
    for (const id of uniq) {
      try {
        videoFor(id, mediaUrl(id, { preview: true }), { force: true });
      } catch (e) {
        reportError(e, "\u91CD\u5EFA\u9884\u89C8\u5143\u7D20\u5931\u8D25");
      }
    }
    setState({ mediaTick: Date.now() });
    toast("\u5DF2\u91CD\u65B0\u52A0\u8F7D " + uniq.length + " \u4E2A\u7D20\u6750");
  }
  import_react3.default.useEffect(() => {
    if (!active) return void 0;
    const onKey = (e) => {
      const tag = e.target && e.target.tagName || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlayback();
      } else if (e.code === "Delete" || e.code === "Backspace") {
        if (state.selection && state.selection.kind === "clip") {
          void doOps([{ type: "clip.delete", clipId: state.selection.id }], "\u5220\u9664\u7247\u6BB5");
        }
      } else if (e.code === "KeyR" && !e.ctrlKey && !e.metaKey) {
        if (mediaIssueRef.current && mediaIssueRef.current.length) {
          e.preventDefault();
          retryMedia();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void redoLast();
        else void undoLast();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void redoLast();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.selection, active]);
  async function loadHistory() {
    if (!state.projectId) {
      setUndoInfo({ undo: [], redo: [] });
      return;
    }
    try {
      const value = await rpc("edit.history", { projectId: state.projectId, sessionId: state.sessionId });
      setUndoInfo({ undo: value && value.undo || [], redo: value && value.redo || [] });
    } catch {
      setUndoInfo({ undo: [], redo: [] });
    }
  }
  import_react3.default.useEffect(() => {
    if (!active) return void 0;
    void loadHistory();
    return void 0;
  }, [state.projectId, s.doc && s.doc.revision, active]);
  async function undoLast() {
    if (!state.projectId || state.busy) return;
    try {
      const r = await rpc("edit.undoLast", { projectId: state.projectId, sessionId: state.sessionId });
      await refresh();
      await loadHistory();
      toast("\u5DF2\u64A4\u9500\uFF1A" + (r.summary || "\u4E0A\u4E00\u6B65") + "\uFF08r" + r.revision + "\uFF09");
    } catch (e) {
      reportError(e, "\u64A4\u9500\u5931\u8D25");
      await loadHistory();
    }
  }
  async function redoLast() {
    if (!state.projectId || state.busy) return;
    try {
      const r = await rpc("edit.redo", { projectId: state.projectId, sessionId: state.sessionId });
      await refresh();
      await loadHistory();
      toast("\u5DF2\u91CD\u505A\uFF1A" + (r.summary || "\u8FD9\u4E00\u6B65") + "\uFF08r" + r.revision + "\uFF09");
    } catch (e) {
      reportError(e, "\u91CD\u505A\u5931\u8D25");
      await loadHistory();
    }
  }
  async function doOps(ops, summary) {
    try {
      const applied = await dispatch(ops, summary);
      if (applied && applied.diff) {
        const ids = [].concat(applied.diff.added || [], applied.diff.modified || []).filter((x) => x.kind === "clip").map((x) => x.id);
        if (ids.length) {
          setState({ flash: { ids: new Set(ids), until: Date.now() + 1500 } });
          setTimeout(() => setState({ flash: null }), 1600);
        }
      }
      toast(applied && applied.human ? applied.human : summary || "\u5DF2\u5E94\u7528");
      return { ok: true, applied };
    } catch (e) {
      reportError(e, "\u547D\u4EE4\u5931\u8D25");
      return { ok: false, error: e };
    }
  }
  import_react3.default.useEffect(() => {
    if (!state.projectId || !active) return void 0;
    let cancelled = false;
    rpc("analyze.read", { projectId: state.projectId, sessionId: state.sessionId }).then((value) => {
      if (!cancelled && value && value.ok === true) setAnalysis(value);
    }).catch(() => {
    });
    return () => {
      cancelled = true;
    };
  }, [state.projectId, s.doc && s.doc.revision, active]);
  function commitText() {
    const text = String(textValue || "").trim();
    if (!text) return toast("\u6587\u5B57\u4E0D\u80FD\u4E3A\u7A7A", "warn");
    const start = +state.playhead.toFixed(3);
    setTextOpen(false);
    setTextValue("");
    doOps(
      [
        {
          type: "clip.insert",
          clipId: "txt_" + Math.random().toString(36).slice(2, 8),
          trackId: "t1",
          clipType: "text",
          start,
          duration: 3,
          text
        }
      ],
      "\u6DFB\u52A0\u6587\u5B57"
    );
  }
  async function commitAnnotation() {
    if (!annot || !annot.range || state.busy) return;
    const expected = String(annot.value || "").trim();
    if (!expected) return toast("\u6279\u6CE8\u4E0D\u80FD\u4E3A\u7A7A", "warn");
    let op;
    try {
      op = annotationOp({
        annotationId: "an_" + Math.random().toString(36).slice(2, 8),
        range: annot.range,
        intent: annot.intent || "change",
        expected
      });
    } catch (e) {
      return toast(e && e.message || "\u6807\u6CE8\u53C2\u6570\u4E0D\u5408\u6CD5", "warn");
    }
    const result = await doOps([op], "\u65B0\u589E\u6807\u6CE8");
    if (result.ok) {
      setAnnot(null);
      return;
    }
    setAnnot({ ...annot, error: result.error && result.error.message || "\u65B0\u589E\u6807\u6CE8\u5931\u8D25" });
  }
  function selectAnnotation(id) {
    if (!id) return;
    setState({ selection: { kind: "annotation", id } });
  }
  function jumpAnnotation(annotation) {
    if (!annotation || !annotation.id) return;
    const range = annotation.range || {};
    const start = Number(range.start);
    const end = Number(range.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      toast("\u8FD9\u6761\u6807\u6CE8\u7F3A\u5C11\u4F4D\u7F6E\u4FE1\u606F\uFF0C\u6CA1\u6CD5\u8DF3\u8F6C", "warn");
      return;
    }
    const at = Math.min(start, end);
    const max = doc ? Number(doc.duration) || at : at;
    setState({ selection: { kind: "annotation", id: annotation.id } });
    seekTo(Math.max(0, Math.min(max, at)), { force: true });
  }
  async function patchAnnotation(annotation, patch) {
    if (!annotation || !annotation.id || !state.projectId) return;
    try {
      const value = await rpc("annotations.update", {
        projectId: state.projectId,
        sessionId: state.sessionId,
        annotationId: annotation.id,
        baseRevision: s.doc ? s.doc.revision : void 0,
        ...patch
      });
      await refresh();
      toast("\u5DF2\u66F4\u65B0\u6807\u6CE8\uFF08\u5269 " + value.remaining + " \u6761\uFF09");
    } catch (e) {
      reportError(e, "\u66F4\u65B0\u6807\u6CE8\u5931\u8D25");
      await refresh().catch(() => {
      });
    }
  }
  async function deleteAnnotation(annotation) {
    if (!annotation || !annotation.id || !state.projectId) return;
    try {
      const value = await rpc("annotations.remove", {
        projectId: state.projectId,
        sessionId: state.sessionId,
        annotationId: annotation.id,
        baseRevision: s.doc ? s.doc.revision : void 0
      });
      if (state.selection && state.selection.kind === "annotation" && state.selection.id === annotation.id) {
        setState({ selection: null });
      }
      await refresh();
      toast("\u5DF2\u5220\u9664\u6807\u6CE8 \xB7 \u8FD8\u5269 " + value.remaining + " \u6761");
    } catch (e) {
      reportError(e, "\u5220\u9664\u6807\u6CE8\u5931\u8D25");
      await refresh().catch(() => {
      });
    }
  }
  async function submitAnnotations() {
    if (!state.projectId) return toast("\u8FD8\u6CA1\u6709\u6253\u5F00\u5DE5\u7A0B", "warn");
    try {
      const value = await rpc("annotations.export", {
        projectId: state.projectId,
        sessionId: state.sessionId
      });
      setExported({ text: value.text || "", count: value.count || 0, items: value.annotations || [] });
      if (!value.count) return toast("\u8FD8\u6CA1\u6709\u6807\u6CE8", "warn");
      const copied = await copyText(value.text || "");
      toast(
        copied ? `\u5DF2\u590D\u5236 ${value.count} \u6761\u6807\u6CE8` : `\u5DF2\u6574\u7406 ${value.count} \u6761\u6807\u6CE8\uFF08\u526A\u8D34\u677F\u4E0D\u53EF\u7528\uFF0C\u8BF7\u624B\u52A8\u590D\u5236\uFF09`,
        copied ? "info" : "warn"
      );
    } catch (e) {
      reportError(e, "\u5BFC\u51FA\u6807\u6CE8\u5931\u8D25");
    }
  }
  async function probeAsset(asset) {
    const v2 = videoFor(asset.id, mediaUrl(asset.id, { preview: true }));
    await new Promise((resolve) => {
      if (v2.readyState >= 1) return resolve();
      const done = () => {
        v2.removeEventListener("loadedmetadata", done);
        v2.removeEventListener("error", done);
        resolve();
      };
      v2.addEventListener("loadedmetadata", done);
      v2.addEventListener("error", done);
      setTimeout(done, 8e3);
    });
    if (!v2.videoWidth) return;
    try {
      await rpc("asset.probe", {
        projectId: state.projectId,
        sessionId: state.sessionId,
        assetId: asset.id,
        probe: { duration: v2.duration || 0, width: v2.videoWidth, height: v2.videoHeight, fps: null }
      });
      await refresh();
    } catch (e) {
    }
  }
  function firstFreeStart(trackId, want, dur) {
    const spans = clips.filter((c) => c.trackId === trackId).map((c) => [c.start, c.start + c.duration]).sort((a, b) => a[0] - b[0]);
    let s2 = want;
    for (let pass = 0; pass < 4; pass += 1) {
      let moved = false;
      for (const [a, b] of spans) {
        if (s2 < b - 1e-6 && s2 + dur > a + 1e-6) {
          s2 = b;
          moved = true;
        }
      }
      if (!moved) break;
    }
    return Math.max(0, +s2.toFixed(3));
  }
  async function insertAsset(asset) {
    if (insertPolicy(asset).trackKind === "audio") return insertAudio(asset);
    const want = state.playhead || 0;
    const dur = Math.max(0.5, asset.probe && asset.probe.duration || 5);
    const start = firstFreeStart("v1", want, dur);
    await doOps(
      [
        {
          type: "clip.insert",
          clipId: "clip_" + Math.random().toString(36).slice(2, 8),
          trackId: "v1",
          clipType: "media",
          assetId: asset.id,
          start: +start.toFixed(3),
          duration: +dur.toFixed(3)
        }
      ],
      "\u63D2\u5165\u7D20\u6750"
    );
    if (doc && doc.duration < start + dur) {
    }
  }
  async function insertAudio(asset) {
    const want = state.playhead || 0;
    const dur = Math.max(0.5, asset.probe && asset.probe.duration || 5);
    const target = resolveInsertTrack(state.doc, asset);
    const targetTrack = target.trackId || "a1";
    const start = target.createTrack ? want : firstFreeStart(targetTrack, want, dur);
    const ops = [];
    if (target.createTrack) ops.push({ type: "track.add", trackId: targetTrack, kind: "audio", name: "\u97F3\u9891" });
    await doOps(
      ops.concat([
        {
          type: "clip.insert",
          clipId: "aud_" + Math.random().toString(36).slice(2, 8),
          trackId: targetTrack,
          clipType: "media",
          assetId: asset.id,
          start: +start.toFixed(3),
          duration: +dur.toFixed(3)
        }
      ]),
      "\u52A0\u5165\u97F3\u9891\u8F68"
    );
    toast("\u5DF2\u52A0\u5165\u97F3\u9891\u8F68 " + targetTrack);
  }
  const srtInputRef = import_react3.default.useRef(null);
  async function importSrtFile(file) {
    const text = await file.text();
    const entries = parseSrt(text);
    if (!entries.length) return toast("\u8FD9\u4E2A SRT \u91CC\u6CA1\u6709\u53EF\u7528\u5B57\u5E55", "warn");
    let n = 0;
    const ops = [];
    for (const e of entries) {
      n += 1;
      ops.push({
        type: "clip.insert",
        clipId: "srt_" + Date.now().toString(36) + "_" + n,
        trackId: "t1",
        clipType: "text",
        start: e.start,
        duration: Math.max(0.2, +(e.end - e.start).toFixed(3)),
        text: e.text
      });
    }
    await doOps(ops, "\u5BFC\u5165 SRT");
  }
  function exportSrt() {
    const srt = clipsToSrt(clips);
    if (!srt.trim()) return toast("\u6CA1\u6709\u5B57\u5E55\u53EF\u5BFC\u51FA", "warn");
    const blob = new Blob([srt], { type: "application/x-subrip;charset=utf-8" });
    const url2 = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url2;
    a.download = (doc.title || "captions") + ".srt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url2), 3e3);
    toast("\u5DF2\u5BFC\u51FA SRT");
  }
  async function insertPip(asset) {
    if (isAudioAsset(asset)) return insertAudio(asset);
    const want = state.playhead || 0;
    const dur = Math.max(0.5, asset.probe && asset.probe.duration || 5);
    const hasV2 = (state.doc && state.doc.tracks || []).some((t) => t.id === "v2");
    const start = hasV2 ? firstFreeStart("v2", want, dur) : want;
    const ops = [];
    if (!hasV2) ops.push({ type: "track.add", trackId: "v2", kind: "video", name: "\u753B\u4E2D\u753B" });
    await doOps(
      ops.concat([
        {
          type: "clip.insert",
          clipId: "pip_" + Math.random().toString(36).slice(2, 8),
          trackId: "v2",
          clipType: "media",
          assetId: asset.id,
          start: +start.toFixed(3),
          duration: +dur.toFixed(3),
          transform: { x: -260, y: -120, scale: 0.35, rotation: 0, opacity: 1 }
        }
      ]),
      "\u52A0\u5165\u753B\u4E2D\u753B"
    );
  }
  function projectPixels() {
    const ratio = String(doc && doc.ratio || "16:9");
    const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio);
    const rw = m ? Number(m[1]) : 16;
    const rh = m ? Number(m[2]) : 9;
    const shortSide = Math.min(rw, rh) || 9;
    const scale = 1080 / shortSide;
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    return { width: even(rw * scale), height: even(rh * scale) };
  }
  function paramsFromForm() {
    const total = Math.max(0.5, doc && doc.duration || 0);
    const project = projectPixels();
    const size = exportForm.resolution === "1080" ? { width: 1920, height: 1080 } : exportForm.resolution === "720" ? { width: 1280, height: 720 } : project;
    const projectFps = doc && doc.fps || 30;
    const fps = exportForm.fps === "project" ? projectFps : Number(exportForm.fps);
    if (!Number.isFinite(fps) || fps <= 0) {
      throw Object.assign(new Error("\u5BFC\u51FA\u5E27\u7387\u5FC5\u987B\u662F\u5927\u4E8E 0 \u7684\u6570\u5B57"), { code: "INVALID_ARG" });
    }
    if (fps > 120) {
      throw Object.assign(new Error("\u5BFC\u51FA\u5E27\u7387\u4E0D\u80FD\u8D85\u8FC7 120fps"), { code: "INVALID_ARG" });
    }
    const bitrateKbps = exportForm.bitrate === "4" ? 4e3 : exportForm.bitrate === "8" ? 8e3 : exportForm.bitrate === "16" ? 16e3 : null;
    let range = null;
    if (exportForm.range === "playhead") {
      const start = Math.min(Math.max(0, state.playhead || 0), total);
      if (total - start < 1 / fps) {
        throw Object.assign(new Error("\u64AD\u653E\u5934\u5DF2\u7ECF\u5230\u7247\u5C3E\uFF0C\u6CA1\u6709\u53EF\u5BFC\u51FA\u7684\u5185\u5BB9"), { code: "INVALID_ARG" });
      }
      range = { start: +start.toFixed(3), end: +total.toFixed(3) };
    }
    return { width: size.width, height: size.height, fps, projectFps, bitrateKbps, range, total };
  }
  async function loadCaps() {
    setCapsBusy(true);
    setCapsError(null);
    try {
      setCaps(await probeEncoders());
    } catch (e) {
      setCaps(null);
      setCapsError(e && e.message || "\u7F16\u7801\u80FD\u529B\u68C0\u6D4B\u5931\u8D25");
    } finally {
      setCapsBusy(false);
    }
  }
  function exportPreview() {
    if (capsBusy) return { text: "\u6B63\u5728\u68C0\u6D4B\u7F16\u7801\u80FD\u529B\u2026", tone: "muted", plan: null, blocked: false };
    if (capsError) {
      return {
        text: "\u7F16\u7801\u80FD\u529B\u68C0\u6D4B\u5931\u8D25\uFF1A" + capsError + "\uFF1B\u5BFC\u51FA\u65F6\u4F1A\u6309\u8FD0\u884C\u65F6\u63A2\u6D4B\u7ED3\u679C\u9009\u683C\u5F0F",
        tone: "warn",
        plan: null,
        blocked: false
      };
    }
    if (!caps) return { text: "\u6B63\u5728\u68C0\u6D4B\u7F16\u7801\u80FD\u529B\u2026", tone: "muted", plan: null, blocked: false };
    try {
      const plan = chooseExportPlan(caps);
      return { text: describePlan(plan), tone: plan.audioCodec ? "info" : "warn", plan, blocked: false };
    } catch (e) {
      return {
        text: e && e.message || "\u5F53\u524D\u73AF\u5883\u6CA1\u6709\u53EF\u7528\u7684\u89C6\u9891\u7F16\u7801\u5668",
        tone: "error",
        plan: null,
        blocked: true
      };
    }
  }
  function openExport() {
    if (!doc) return;
    setExportForm((prev) => {
      const projectFps = doc && doc.fps || 30;
      const chosen = Number(exportSettings.fps);
      const next = Number.isFinite(chosen) && chosen > 0 && chosen !== projectFps ? String(chosen) : "project";
      return prev.fps === next ? prev : { ...prev, fps: next };
    });
    setExportOpen(true);
    if (!capsBusy) void loadCaps();
  }
  function startExportFromForm() {
    const preview = exportPreview();
    if (preview.blocked) return toast(preview.text, "warn");
    if (capsBusy) return toast("\u6B63\u5728\u68C0\u6D4B\u7F16\u7801\u80FD\u529B\uFF0C\u7A0D\u7B49\u4E00\u4E0B", "warn");
    let params;
    try {
      params = paramsFromForm();
    } catch (e) {
      return toast(e && e.message || "\u5BFC\u51FA\u53C2\u6570\u4E0D\u5408\u6CD5", "warn");
    }
    if (preview.plan) params.plan = preview.plan;
    else if (caps) params.caps = caps;
    setExportOpen(false);
    void exportMp4(params);
  }
  async function exportMp4(params) {
    if (!doc) return;
    const p = params || {
      width: exportSettings.width,
      height: exportSettings.height,
      fps: exportSettings.fps,
      bitrateKbps: null,
      range: null,
      total: Math.max(0.5, doc.duration)
    };
    let mod;
    try {
      mod = await Promise.resolve().then(() => (init_exporter(), exporter_exports));
    } catch (e) {
      return reportError(e, "\u5BFC\u51FA\u6A21\u5757\u4E0D\u53EF\u7528");
    }
    setState({ busy: { label: "\u5BFC\u51FA\u4E2D", ratio: 0, detail: "\u6DF7\u97F3" } });
    let audioBuffer = null;
    if (audioRef.current) {
      try {
        audioBuffer = await audioRef.current.mixdown({
          duration: Math.max(0.5, p.total),
          sampleRate: 48e3
        });
      } catch {
        audioBuffer = null;
      }
    }
    setState({ busy: { label: "\u5BFC\u51FA\u4E2D", ratio: 0, detail: "\u7F16\u7801" } });
    try {
      const result = await mod.exportTimeline({
        title: doc.title,
        audioBuffer,
        plan: p.plan || void 0,
        caps: p.plan ? void 0 : p.caps || caps || void 0,
        duration: Math.max(0.5, p.total),
        projectFps: p.projectFps == null ? doc && doc.fps || p.fps : p.projectFps,
        fps: p.fps,
        width: p.width,
        height: p.height,
        bitrateKbps: p.bitrateKbps == null ? void 0 : p.bitrateKbps,
        range: p.range || void 0,
        drawFrame: async (c, t, w, hh) => {
          const layers = frameLayers(clips, t);
          if (codeRef.current) {
            try {
              await codeRef.current.renderLayers(layers);
            } catch (e) {
            }
          }
          drawFrame(c, {
            clips,
            assets,
            t,
            width: w,
            height: hh,
            layers,
            codeCanvas: codeRef.current ? (clip2) => codeRef.current.canvasFor(clip2) : null
          });
        },
        onProgress: (p2) => {
          const label = p2.phase === "audio" ? "\u6DF7\u97F3\u4E2D" : p2.phase === "encode" ? "\u7F16\u7801\u4E2D" : p2.phase === "finalize" ? "\u5C01\u88C5\u4E2D" : "\u51C6\u5907\u4E2D";
          setState({ busy: { label: "\u5BFC\u51FA \xB7 " + label, ratio: p2.ratio, detail: label } });
        }
      });
      const url2 = URL.createObjectURL(result.blob);
      const a = document.createElement("a");
      a.href = url2;
      a.download = result.fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url2), 5e3);
      let savedToProject = false;
      try {
        const query = "/api/video/export?projectId=" + encodeURIComponent(doc.projectId) + "&sessionId=" + encodeURIComponent(state && state.sessionId || "") + "&name=" + encodeURIComponent(result.fileName) + "&duration=" + encodeURIComponent(String(result.duration == null ? Math.max(0.5, p.total) : result.duration)) + "&fps=" + encodeURIComponent(String(result.fps == null ? p.fps : result.fps)) + "&sourceFps=" + encodeURIComponent(String(result.sourceFps == null ? p.projectFps : result.sourceFps));
        const res = await fetch(query, { method: "POST", body: result.blob });
        const payload = await res.json().catch(() => null);
        savedToProject = Boolean(payload && payload.ok);
      } catch (e) {
        savedToProject = false;
      }
      const fallbackNote = result.encoderFallback && result.encoderFallback.note ? "\uFF1B" + result.encoderFallback.note : "";
      toast(
        "\u5DF2\u5BFC\u51FA " + result.fileName + "\uFF08" + result.container + " \xB7 " + p.width + "\xD7" + p.height + " \xB7 " + (result.fps == null ? p.fps : result.fps) + "fps" + (result.sourceFps != null && result.sourceFps !== result.fps ? "\uFF08\u5DE5\u7A0B " + result.sourceFps + "fps\uFF09" : "") + (result.audioCodec ? " \xB7 " + result.audioCodec : " \xB7 \u65E0\u97F3\u8F68") + "\uFF09" + fallbackNote + (savedToProject ? "\uFF0C\u5DF2\u767B\u8BB0\u8FDB\u5DE5\u7A0B exports/" : "\uFF0C\u4F46\u6CA1\u80FD\u767B\u8BB0\u8FDB\u5DE5\u7A0B\uFF08\u7528 video_export_scan \u53EF\u53D1\u73B0\u5E76\u6536\u517B\uFF09")
      );
    } catch (e) {
      reportError(e, "\u5BFC\u51FA\u5931\u8D25");
    } finally {
      setState({ busy: null });
    }
  }
  const composerInput = {
    flex: 1,
    minWidth: 0,
    padding: "5px 8px",
    borderRadius: 6,
    border: `1px solid ${T.border}`,
    background: T.fill,
    color: T.text,
    fontSize: 12,
    fontFamily: "inherit"
  };
  const composerRow = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    borderBottom: `1px solid ${T.border}`,
    background: T.fill,
    fontSize: 12,
    flex: "0 0 auto"
  };
  const miniBtn = (label, onClick, extra) => btn(label, onClick, Object.assign({ fontSize: 11, padding: "3px 8px" }, extra || {}));
  const rangeText = (range) => !range ? "" : Math.abs(range.end - range.start) < 1e-9 ? `${fmtTime(range.start)}\uFF08\u5F53\u524D\u5E27\uFF09` : `${fmtTime(range.start)} \u2192 ${fmtTime(range.end)}`;
  const exportRow = (label, value, onChange, options) => h3(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
    h3("span", { style: { width: 48, flex: "0 0 auto", opacity: 0.7 } }, label),
    h3(
      "select",
      {
        value,
        onChange: (e) => onChange(e.target.value),
        style: Object.assign({}, composerInput, { flex: 1, minWidth: 0, padding: "4px 6px" })
      },
      options.map(([v2, text]) => h3("option", { key: v2, value: v2 }, text))
    )
  );
  function renderComposer() {
    if (textOpen) {
      return h3(
        "div",
        { style: composerRow },
        h3("span", { style: { opacity: 0.75, flex: "0 0 auto" } }, "\uFF0B\u6587\u5B57"),
        h3("input", {
          autoFocus: true,
          value: textValue,
          placeholder: "\u8F93\u5165\u5B57\u5E55\u6587\u5B57\uFF0C\u56DE\u8F66\u63D2\u5165 3 \u79D2",
          onChange: (e) => setTextValue(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitText();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setTextOpen(false);
              setTextValue("");
            }
          },
          style: composerInput
        }),
        miniBtn("\u786E\u8BA4", commitText),
        miniBtn("\u53D6\u6D88", () => {
          setTextOpen(false);
          setTextValue("");
        }),
        h3("span", { style: { opacity: 0.45, flex: "0 0 auto", fontSize: 11 } }, "\u4F4D\u7F6E " + fmtTime(state.playhead))
      );
    }
    if (!annot) return null;
    if (annot.step === "pick") {
      return h3(
        "div",
        { style: composerRow },
        h3("span", { style: { opacity: 0.75, flex: "0 0 auto" } }, "\uFF0B\u6807\u6CE8"),
        miniBtn("\u2460 \u6807\u8BB0\u5F53\u524D\u5E27", () => setAnnot({ step: "note", a: null, range: frameRange(state.playhead), intent: annot.intent || "change", value: annot.value || "" })),
        h3("span", { style: { opacity: 0.45 } }, "\u6216"),
        miniBtn("\u2461 \u4ECE A \u5230 B \u6807\u8BB0", () => setAnnot({ step: "span", a: +state.playhead.toFixed(3), range: null, intent: annot.intent || "change", value: annot.value || "" })),
        miniBtn("\u53D6\u6D88", () => setAnnot(null)),
        h3("span", { style: { opacity: 0.45, fontSize: 11 } }, "\u64AD\u653E\u5934 " + fmtTime(state.playhead))
      );
    }
    if (annot.step === "span") {
      return h3(
        "div",
        { style: composerRow },
        h3("span", { style: { opacity: 0.75 } }, "B \u2265 A"),
        h3("span", null, "A = " + fmtTime(annot.a)),
        miniBtn("\u5728\u64AD\u653E\u5934 " + fmtTime(state.playhead) + " \u8BB0 B", () => {
          if (state.playhead < annot.a - 1e-6) {
            return toast(`B \u5FC5\u987B\u4E0D\u5C0F\u4E8E A\uFF08A=${fmtTime(annot.a)}\uFF0CB=${fmtTime(state.playhead)}\uFF09`, "warn");
          }
          try {
            setAnnot({ ...annot, step: "note", range: spanRange(annot.a, state.playhead) });
          } catch (e) {
            toast(e && e.message || "\u533A\u95F4\u975E\u6CD5", "warn");
          }
        }),
        miniBtn("\u91CD\u8BB0 A", () => setAnnot({ ...annot, a: +state.playhead.toFixed(3) })),
        miniBtn("\u53D6\u6D88", () => setAnnot(null))
      );
    }
    return h3(
      "div",
      { style: Object.assign({}, composerRow, { alignItems: "flex-start", flexWrap: "wrap" }) },
      h3(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 4, flex: "0 0 132px" } },
        h3("span", { style: { fontSize: 11, opacity: 0.7 } }, rangeText(annot.range)),
        h3("select", {
          value: annot.intent || "change",
          onChange: (e) => setAnnot({ ...annot, intent: e.target.value, error: null }),
          style: Object.assign({}, composerInput, { flex: "0 0 auto", width: "100%" })
        }, ANNOTATION_INTENTS2.map((id) => h3("option", { key: id, value: id }, `${id}\uFF08${INTENT_LABELS[id]}\uFF09`)))
      ),
      h3("textarea", {
        autoFocus: true,
        rows: 2,
        value: annot.value || "",
        placeholder: "\u544A\u8BC9 agent \u8FD9\u91CC\u8981\u6539\u4EC0\u4E48\uFF08\u591A\u884C\u53EF\u4EE5\uFF0CCtrl+Enter \u63D0\u4EA4\uFF09",
        onChange: (e) => setAnnot({ ...annot, value: e.target.value, error: null }),
        onKeyDown: (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            commitAnnotation();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setAnnot(null);
          }
        },
        style: Object.assign({}, composerInput, { resize: "vertical", minHeight: 46, lineHeight: 1.5 })
      }),
      h3(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 4 } },
        miniBtn("\u786E\u8BA4", commitAnnotation),
        miniBtn("\u53D6\u6D88", () => setAnnot(null))
      ),
      // 失败必须写在提交处：草稿还在、红字还在，用户不用去别处找原因。
      annot.error ? h3(
        "div",
        { style: { flexBasis: "100%", marginTop: 4, fontSize: 11, color: T.danger, lineHeight: 1.5 } },
        "\u65B0\u589E\u6807\u6CE8\u5931\u8D25\uFF1A" + annot.error + "\uFF08\u8349\u7A3F\u5DF2\u4FDD\u7559\uFF0C\u6539\u5B8C\u518D\u786E\u8BA4\uFF09"
      ) : null
    );
  }
  const composerBar = doc ? renderComposer() : null;
  const myProjects = mergeSessionProjects(doc, s.mine, state.sessionId);
  const header = h3(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 14px",
        borderBottom: `1px solid ${T.border}`,
        minHeight: 48,
        background: `linear-gradient(180deg, ${T.fill}, transparent)`
      }
    },
    doc && renaming ? h3("input", {
      autoFocus: true,
      value: renameValue,
      maxLength: 60,
      onChange: (e) => setRenameValue(e.target.value),
      onKeyDown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitRename();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setRenaming(false);
          setRenameValue("");
        }
      },
      style: {
        padding: "4px 8px",
        borderRadius: 6,
        border: `1px solid ${T.accent}`,
        background: T.fill,
        color: T.text,
        fontSize: 13,
        fontWeight: 600,
        fontFamily: "inherit",
        minWidth: 180
      }
    }) : h3(
      "strong",
      {
        onClick: doc ? () => {
          setRenameValue(doc.title || "");
          setRenaming(true);
        } : void 0,
        title: doc ? "\u70B9\u51FB\u91CD\u547D\u540D" : void 0,
        style: {
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: 0.2,
          cursor: doc ? "pointer" : "default",
          borderBottom: doc ? `1px dashed ${T.borderStrong}` : "none"
        }
      },
      doc ? doc.title : "\u89C6\u9891\u5DE5\u4F5C\u53F0"
    ),
    doc && renaming ? btn("\u786E\u8BA4", commitRename, { fontSize: 11, padding: "3px 8px" }) : null,
    doc && renaming ? btn("\u53D6\u6D88", () => {
      setRenaming(false);
      setRenameValue("");
    }, { fontSize: 11, padding: "3px 8px" }) : null,
    doc ? h3("span", { style: { fontSize: 11, opacity: 0.6 } }, `r${doc.revision} \xB7 ${doc.duration.toFixed(2)}s \xB7 ${doc.fps}fps \xB7 ${doc.ratio}`) : null,
    h3("div", { style: { flex: 1 } }),
    state.error ? h3("span", { style: { fontSize: 11, color: T.danger } }, state.error) : null,
    doc ? btn(state.playing ? "\u6682\u505C" : "\u64AD\u653E", togglePlayback) : btn("\u65B0\u5EFA\u5DE5\u7A0B", createProject2),
    doc ? btn("\u5207\u6362", () => setSwitchOpen((v2) => !v2), switchOpen ? { borderColor: T.accent, color: T.accent } : null) : null,
    doc ? btn("\u505C\u6B62", () => stopProject(), { color: T.danger, borderColor: T.danger }) : null,
    btn("\u64A4\u9500", undoLast, undoInfo.undo.length ? { borderColor: T.warn, color: T.warn, background: T.warnDim } : { opacity: 0.5 }),
    btn("\u91CD\u505A", redoLast, undoInfo.redo.length ? { borderColor: T.accent, color: T.accent, background: T.accentDim } : { opacity: 0.5 }),
    btn("\uFF0B\u6587\u5B57", () => {
      setAnnot(null);
      setTextOpen((v2) => !v2);
    }, textOpen ? { borderColor: T.accent, color: T.accent } : null),
    btn("\uFF0B\u6807\u6CE8", () => {
      setTextOpen(false);
      setAnnot((cur) => cur ? null : { step: "pick", a: null, range: null, intent: "change", value: "" });
    }, annot ? { borderColor: T.accent, color: T.accent } : null),
    btn("\u5168\u90E8\u63D0\u4EA4", submitAnnotations),
    btn("\u5BFC\u5165\u5B57\u5E55(.srt)", () => srtInputRef.current && srtInputRef.current.click()),
    btn("\u5BFC\u51FA\u5B57\u5E55(.srt)", exportSrt),
    h3("input", {
      ref: srtInputRef,
      type: "file",
      accept: ".srt,text/plain",
      style: { display: "none" },
      onChange: (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) importSrtFile(f).catch((err) => reportError(err, "\u5BFC\u5165 SRT \u5931\u8D25"));
        e.target.value = "";
      }
    }),
    btn(showLog ? "\u6536\u8D77\u8BB0\u5F55" : "\u64CD\u4F5C\u8BB0\u5F55", () => setShowLog((v2) => !v2)),
    btn("\u8BCA\u65AD", runDiag),
    btn("\u5BFC\u51FA MP4", openExport, {
      background: T.primary,
      border: `1px solid ${T.primary}`,
      color: T.onPrimary,
      fontWeight: 600
    }),
    btn("\u56DE\u5230\u5BF9\u8BDD", () => ctxRef && ctxRef.layout.selectPanel(null))
  );
  if (!doc || !active) {
    return h3(
      "div",
      {
        ref: rootRef,
        style: Object.assign(
          {},
          layoutStyles({
            height: panelHeight ? panelHeight + "px" : "100%",
            maxHeight: panelHeight ? panelHeight + "px" : "100%"
          }).root,
          { background: T.bg }
        )
      },
      h3(SelectionPanel, {
        sessionId: state.sessionId,
        projects: s.mine,
        doc,
        enabled: s.enabled,
        max: s.max,
        busy: s.busy,
        error: state.error,
        onNew: createProject2,
        onEnter: (project) => enterProject(project),
        onEnable: async (project) => {
          try {
            await enableProject(project.projectId, project.root);
            await loadMyProjects().catch(() => []);
            toast("\u5DF2\u542F\u7528\u300C" + (project.title || project.projectId) + "\u300D");
          } catch (e) {
            reportError(e, "\u542F\u7528\u5931\u8D25");
          }
        },
        onDisable: (project) => stopProject(project),
        onRename: (projectId, title) => renameTo(projectId, title)
      }),
      h3(ProgressOverlay, { busy: s.busy }),
      s.toast ? h3("div", {
        style: {
          position: "absolute",
          bottom: 14,
          left: "50%",
          transform: "translateX(-50%)",
          padding: "6px 12px",
          borderRadius: 8,
          background: T.panel,
          border: `1px solid ${T.border}`,
          fontSize: 12,
          color: T.text
        }
      }, s.toast.message) : null
    );
  }
  const switchMenu = switchOpen && doc ? h3(
    "div",
    {
      style: {
        position: "absolute",
        top: 48,
        left: 180,
        width: 300,
        maxHeight: 280,
        overflow: "auto",
        zIndex: 28,
        padding: 8,
        borderRadius: 10,
        border: `1px solid ${T.border}`,
        background: T.panel,
        boxShadow: T.shadow,
        fontSize: 12
      }
    },
    h3("div", { style: { opacity: 0.55, marginBottom: 6 } }, "\u5207\u6362\u5230\u672C\u4F1A\u8BDD\u7684\u5DE5\u7A0B"),
    myProjects.map(
      (p) => h3(
        "div",
        {
          key: p.projectId,
          onClick: () => switchTo(p),
          style: {
            cursor: "pointer",
            padding: "6px 8px",
            borderRadius: 6,
            background: p.projectId === state.projectId ? T.accentDim : "transparent"
          }
        },
        h3("div", null, (p.title || "\u672A\u547D\u540D\u5DE5\u7A0B") + (p.projectId === state.projectId ? "\uFF08\u5F53\u524D\uFF09" : "")),
        h3("div", { style: { fontSize: 10, opacity: 0.45, wordBreak: "break-all" } }, p.root || "")
      )
    ),
    myProjects.length < 2 ? h3("div", { style: { fontSize: 11, opacity: 0.45, marginTop: 6, lineHeight: 1.6 } }, "\u672C\u4F1A\u8BDD\u53EA\u6709\u8FD9\u4E00\u4E2A\u5DE5\u7A0B\u3002\u65B0\u5EFA\u4E4B\u540E\u624D\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC\u3002") : null
  ) : null;
  const previewNotice = seekDiag && seekDiag[0] || mediaIssue && mediaIssue[0] || null;
  const previewNoticeIsMedia = !(seekDiag && seekDiag[0]) && !!(mediaIssue && mediaIssue[0]);
  return h3(
    "div",
    {
      ref: rootRef,
      style: Object.assign(
        {},
        layoutStyles({
          height: panelHeight ? panelHeight + "px" : "100%",
          maxHeight: panelHeight ? panelHeight + "px" : "100%"
        }).root,
        {
          background: T.bg,
          fontFamily: T.font
        }
      )
    },
    header,
    switchMenu,
    h3(
      "div",
      { style: Object.assign({}, layoutStyles().row) },
      h3(
        "div",
        { style: Object.assign({}, layoutStyles().mediaBin, { borderRight: `1px solid ${T.border}` }) },
        h3(MotionLibrary, {
          onInsertMotion: async (item) => {
            try {
              await rpc("motion.insert", {
                projectId: state.projectId,
                sessionId: state.sessionId,
                entryId: item.id,
                start: state.playhead || 0,
                duration: 3
              });
              await refresh();
              toast("\u5DF2\u63D2\u5165\u52A8\u6548\uFF1A" + (item.title || item.id));
            } catch (e) {
              reportError(e, "\u63D2\u5165\u52A8\u6548\u5931\u8D25");
            }
          }
        }),
        h3(SoundLibrary, {
          projectId: state.projectId,
          sessionId: state.sessionId,
          playhead: state.playhead
        }),
        h3(MediaBin, {
          assets,
          onInsert: (a) => insertAsset(a),
          onInsertPip: (a) => insertPip(a),
          onInsertAudio: (a) => insertAudio(a),
          onImported: async () => {
            const n = await syncAssetsFromDisk().catch(() => 0);
            await refresh();
            if (n) toast("\u5DF2\u767B\u8BB0 " + n + " \u4E2A\u5DF2\u6709\u7D20\u6750");
          }
        })
      ),
      h3(
        "div",
        { style: Object.assign({}, layoutStyles().main) },
        (doc.clipCount || 0) === 0 && clips.length === 0 ? h3(TemplateBar, { projectId: state.projectId, sessionId: state.sessionId }) : null,
        // 脏数据提示：音频被放在视频轨上（打开工程时就有；修复/撤销后自动消失）。
        // 只提示 + 一键修复，不阻塞预览 —— 渲染器本来就跳过音频。
        audioIssues && audioIssues.count ? h3(
          "div",
          {
            "data-testid": "audio-track-banner",
            style: {
              flex: "0 0 auto",
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "6px 10px",
              borderBottom: `1px solid ${T.warn}`,
              background: T.warnDim,
              color: T.warn,
              fontSize: 11,
              lineHeight: 1.55
            }
          },
          h3(
            "div",
            { style: { flex: 1, minWidth: 0 } },
            h3("div", { style: { fontWeight: 600 } }, `\u53D1\u73B0 ${audioIssues.count} \u4E2A\u97F3\u9891\u7D20\u6750\u5728\u89C6\u9891\u8F68\u4E0A`),
            h3("div", { style: { opacity: 0.8 } }, audioIssues.human),
            h3(
              "div",
              { style: { opacity: 0.6, wordBreak: "break-all" } },
              (audioIssues.issues || []).slice(0, 4).map((i) => `${i.assetName}\uFF08${i.trackName}\uFF09`).join("\u3001") + (audioIssues.count > 4 ? ` \u7B49 ${audioIssues.count} \u4E2A` : "")
            )
          ),
          h3(
            "div",
            { style: { flex: "0 0 auto" } },
            btn("\u4E00\u952E\u79FB\u5230\u97F3\u9891\u8F68", repairAudioTracks, { fontSize: 11, padding: "3px 8px" })
          )
        ) : null,
        h3(
          "div",
          { style: Object.assign({}, layoutStyles().preview) },
          h3(PlayerCanvas, {
            clips,
            assets,
            playing: s.playing,
            playhead: s.playhead,
            code: codeRef.current,
            engineRef: playbackRef,
            onTime: (t) => setState({ playhead: t }),
            onMediaState,
            onDiagnostic: (list) => setSeekDiag(list || []),
            getAudio: () => audioRef.current
          }),
          // 这一帧为什么没画出来 / 音频为什么不在画面里 —— 只画在 DOM overlay 上。
          // 合成画布（导出、无头采样）里一个提示字都不会出现。
          previewNotice ? h3(
            "div",
            {
              "data-testid": "preview-notice",
              style: {
                position: "absolute",
                left: 8,
                bottom: 8,
                maxWidth: "72%",
                padding: "4px 8px",
                borderRadius: 6,
                border: `1px solid ${previewNotice.blocker ? T.danger : T.warn}`,
                background: previewNotice.blocker ? T.dangerDim : T.warnDim,
                color: previewNotice.blocker ? T.danger : T.warn,
                fontSize: 11,
                lineHeight: 1.5,
                pointerEvents: previewNoticeIsMedia ? "auto" : "none"
              }
            },
            h3("div", { style: { fontWeight: 600 } }, previewNotice.title || "\u8FD9\u4E00\u5E27\u6CA1\u5C31\u7EEA"),
            previewNotice.detail ? h3("div", { style: { opacity: 0.75 } }, previewNotice.detail) : null,
            previewNotice.hint ? h3("div", { style: { opacity: 0.8 } }, previewNotice.hint) : null,
            previewNoticeIsMedia && previewNotice.code !== "audio-asset" ? h3(
              "div",
              { style: { marginTop: 4, display: "flex", alignItems: "center", gap: 6 } },
              mediaIssue.length > 1 ? h3("span", { style: { opacity: 0.55 } }, "+" + (mediaIssue.length - 1)) : null,
              btn("\u91CD\u65B0\u52A0\u8F7D", () => retryMedia(mediaIssue[0].assetId), { fontSize: 11, padding: "3px 8px" }),
              h3("span", { style: { opacity: 0.45 } }, "\u6216\u6309 R")
            ) : null
          ) : null
        ),
        composerBar,
        h3(
          "div",
          { style: Object.assign({}, layoutStyles().timeline, { borderTop: `1px solid ${T.border}`, display: "flex", flexDirection: "column" }) },
          h3(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", fontSize: 11, opacity: 0.7 } },
            h3("span", null, fmtTime(state.playhead)),
            h3("input", {
              type: "range",
              min: 0,
              max: Math.max(1, doc.duration),
              step: 0.01,
              value: state.playhead,
              // 拖动中降级（节流、不黑屏），松手时必须落到准确的一帧
              onChange: (e) => seekTo(+e.target.value, { scrub: true }),
              onPointerUp: (e) => seekTo(+e.target.value, { force: true }),
              onKeyUp: (e) => seekTo(+e.target.value, { force: true }),
              onBlur: (e) => seekTo(+e.target.value, { force: true }),
              style: { flex: 1 }
            }),
            h3("span", null, "\u7F29\u653E"),
            h3("input", {
              type: "range",
              min: 10,
              max: 200,
              value: state.zoom,
              onChange: (e) => setState({ zoom: +e.target.value }),
              style: { width: 90 }
            })
          ),
          h3(
            "div",
            { style: { flex: 1, minHeight: 0, paddingBottom: 6 } },
            h3(Timeline, {
              doc,
              clips,
              annotations: doc.annotations || [],
              playhead: state.playhead,
              zoom: state.zoom,
              selection: state.selection,
              flash: state.flash,
              assets,
              onSeek: seekTo,
              onSelect: (sel) => setState({ selection: sel }),
              onOps: (ops, summary) => doOps(ops, summary)
            })
          )
        )
      ),
      h3(
        "div",
        { style: Object.assign({}, layoutStyles().inspector, { borderLeft: `1px solid ${T.border}` }) },
        h3(Inspector, {
          doc,
          selection: state.selection,
          clips,
          annotations: doc.annotations || [],
          analysis,
          playhead: state.playhead,
          onOps: (ops, summary) => doOps(ops, summary),
          onSplit: (clip2) => {
            const at = +(state.playhead - clip2.start).toFixed(3);
            if (at <= 0 || at >= clip2.duration) return toast("\u64AD\u653E\u5934\u4E0D\u5728\u7247\u6BB5\u5185\u90E8", "warn");
            doOps([{ type: "clip.split", clipId: clip2.id, at, rightClipId: clip2.id + "_" + Math.random().toString(36).slice(2, 5) }], "\u5206\u5272\u7247\u6BB5");
          },
          onDelete: (clip2) => doOps([{ type: "clip.delete", clipId: clip2.id }], "\u5220\u9664\u7247\u6BB5"),
          onExport: openExport,
          exportSettings,
          onExportSettings: (patch) => setExportSettings(Object.assign({}, exportSettings, patch)),
          onDeleteProject: removeProject,
          // 标注四件事：选中 / 跳转 / 改造 / 删除。删除带二次确认（在面板里内联完成）。
          onAnnotationSelect: selectAnnotation,
          onAnnotationJump: jumpAnnotation,
          onAnnotationPatch: patchAnnotation,
          onAnnotationDelete: deleteAnnotation,
          onAnnotationUpdate: (a, op) => patchAnnotation(a, {
            expected: op.expected,
            intent: op.intent,
            range: op.range,
            status: op.status
          })
        })
      )
    ),
    showLog ? h3(
      "div",
      {
        style: {
          position: "absolute",
          top: 48,
          right: 12,
          width: 380,
          maxHeight: 320,
          overflow: "auto",
          zIndex: 25,
          padding: 10,
          borderRadius: 10,
          border: `1px solid ${T.border}`,
          background: T.panel,
          boxShadow: T.shadow,
          fontSize: 12
        }
      },
      h3("div", { style: { fontWeight: 600, marginBottom: 8 } }, "\u6700\u8FD1\u64CD\u4F5C\uFF08Agent \u4E0E\u4F60\u5171\u7528\u4E00\u6761\u8BB0\u5F55\uFF09"),
      (s.history || []).length === 0 ? h3("div", { style: { opacity: 0.55 } }, "\u8FD8\u6CA1\u6709\u64CD\u4F5C\u3002") : (s.history || []).map(
        (item, i) => h3(
          "div",
          {
            key: i,
            onClick: () => {
              const tx = item.transactionId;
              if (!tx) return;
              rpc("edit.undo", { projectId: state.projectId, sessionId: state.sessionId, transactionId: tx }).then((r) => {
                toast("\u5DF2\u64A4\u9500\uFF1A" + (r.summary || "\u8FD9\u4E00\u6B65") + "\uFF08r" + r.revision + "\uFF09");
                refresh();
              }).catch((e) => reportError(e, "\u64A4\u9500\u5931\u8D25"));
            },
            title: "\u70B9\u51FB\u64A4\u9500\u8FD9\u4E00\u6B65\uFF08\u53EA\u6709\u6700\u8FD1\u4E00\u6B65\u80FD\u64A4\u9500\uFF09",
            style: {
              cursor: "pointer",
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              padding: "5px 0",
              borderTop: i ? `1px solid ${T.borderFaint}` : "none"
            }
          },
          h3(
            "span",
            {
              style: {
                flex: "0 0 auto",
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 4,
                background: item.origin === "agent" ? T.accentDim : T.fill,
                color: item.origin === "agent" ? T.accent : T.textDim
              }
            },
            item.origin === "agent" ? "Agent" : "\u4F60"
          ),
          h3("span", { style: { lineHeight: 1.5, opacity: 0.85 } }, item.human)
        )
      )
    ) : null,
    diag ? h3(
      "div",
      {
        style: {
          position: "absolute",
          top: 48,
          left: 12,
          width: 260,
          zIndex: 26,
          padding: 10,
          borderRadius: 10,
          border: `1px solid ${T.border}`,
          background: T.panel,
          boxShadow: T.shadow,
          fontSize: 12,
          lineHeight: 1.7
        }
      },
      h3(
        "div",
        { style: { fontWeight: 600, marginBottom: 6, display: "flex" } },
        h3("span", { style: { flex: 1 } }, "\u80FD\u529B\u68C0\u6D4B"),
        h3("span", { style: { cursor: "pointer", opacity: 0.6 }, onClick: () => setDiag(null) }, "\u2715")
      ),
      [
        ["\u5B89\u5168\u4E0A\u4E0B\u6587", diag.secureContext],
        ["WebGPU", diag.webgpu],
        ["GPU", diag.gpuVendor],
        ["VideoDecoder", diag.videoDecoder],
        ["VideoEncoder", diag.videoEncoder],
        ["H.264 \u7F16\u7801", diag.h264],
        ["HEVC \u7F16\u7801", diag.hevc],
        ["VP9 \u7F16\u7801", diag.vp9],
        ["AV1 \u7F16\u7801", diag.av1],
        ["AAC \u7F16\u7801", diag.aac],
        ["Opus \u7F16\u7801", diag.opus]
      ].map(
        ([label, value]) => h3(
          "div",
          { key: label, style: { display: "flex", gap: 8 } },
          h3("span", { style: { width: 96, opacity: 0.65 } }, label),
          h3("span", null, value === true ? "\u2705" : value === false ? "\u274C" : String(value == null ? "\u2014" : value))
        )
      ),
      h3("div", { style: { marginTop: 8, fontSize: 11, opacity: 0.5 } }, "AAC \u274C \u65F6\u5BFC\u51FA\u4F1A\u9000 WebM \u6216\u65E0\u97F3\u8F68\u3002")
    ) : null,
    exported ? h3(
      "div",
      {
        style: {
          position: "absolute",
          top: 48,
          right: 12,
          width: 430,
          maxHeight: "60%",
          overflow: "auto",
          zIndex: 27,
          padding: 10,
          borderRadius: 10,
          border: `1px solid ${T.border}`,
          background: T.panel,
          boxShadow: T.shadow,
          fontSize: 12
        }
      },
      h3(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
        h3("strong", { style: { flex: 1 } }, "\u6807\u6CE8\u6E05\u5355 \xB7 " + exported.count + " \u6761"),
        h3("span", { style: { cursor: "pointer", opacity: 0.6 }, onClick: () => setExported(null) }, "\u2715")
      ),
      h3(
        "div",
        { style: { fontSize: 11, opacity: 0.55, marginBottom: 8, lineHeight: 1.6 } },
        "\u8FD9\u6BB5\u6587\u672C\u5DF2\u6309\u4F4D\u7F6E + \u7C7B\u578B + \u6279\u6CE8\u6574\u7406\u597D\uFF1B\u590D\u5236\u540E\u7C98\u7ED9 agent\u3002\u9762\u677F\u6CA1\u6709\u300C\u76F4\u63A5\u53D1\u8FDB\u5BF9\u8BDD\u300D\u7684\u63A5\u53E3\u3002"
      ),
      exported.items && exported.items.length ? h3(
        "div",
        { style: { marginBottom: 8 } },
        exported.items.map(
          (item, i) => h3(
            "div",
            { key: item.id || i, style: { padding: "3px 0", borderTop: i ? `1px solid ${T.borderFaint}` : "none" } },
            h3("span", { style: { opacity: 0.7 } }, formatAnnotation(item) + " \xB7 " + (item.intent || "change")),
            item.expected ? h3("div", { style: { opacity: 0.55, fontSize: 11, whiteSpace: "pre-wrap", lineHeight: 1.5 } }, item.expected) : null
          )
        )
      ) : null,
      h3("textarea", {
        readOnly: true,
        value: exported.text,
        rows: 12,
        style: Object.assign({}, composerInput, { width: "100%", resize: "vertical", fontFamily: "ui-monospace, monospace", lineHeight: 1.5 })
      }),
      h3(
        "div",
        { style: { display: "flex", gap: 6, marginTop: 8 } },
        miniBtn("\u518D\u590D\u5236\u4E00\u6B21", () => {
          copyText(exported.text).then((ok) => toast(ok ? "\u5DF2\u590D\u5236 " + exported.count + " \u6761\u6807\u6CE8" : "\u590D\u5236\u5931\u8D25\uFF1A\u526A\u8D34\u677F\u4E0D\u53EF\u7528", ok ? "info" : "warn"));
        }),
        miniBtn("\u5173\u95ED", () => setExported(null))
      )
    ) : null,
    deleteAsk && doc ? h3(
      "div",
      {
        style: {
          position: "absolute",
          inset: 0,
          zIndex: 40,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: T.mask
        }
      },
      h3(
        "div",
        {
          style: {
            width: 380,
            padding: 16,
            borderRadius: 12,
            border: `1px solid ${T.border}`,
            background: T.panel,
            boxShadow: T.shadow,
            fontSize: 12
          }
        },
        h3("div", { style: { fontWeight: 600, marginBottom: 8 } }, "\u5220\u9664\u5DE5\u7A0B\u300C" + doc.title + "\u300D\uFF1F"),
        h3(
          "div",
          { style: { opacity: 0.7, lineHeight: 1.6 } },
          "\u4F1A\u89E3\u9664\u8FD9\u4E2A\u4F1A\u8BDD\u4E0E\u5DE5\u7A0B\u7684\u7ED1\u5B9A\u3002\u78C1\u76D8\u4E0A\u7684\u6587\u4EF6\u8981\u4E00\u8D77\u5220\u5417\uFF1F\u5220\u4E86\u627E\u4E0D\u56DE\u6765\u3002"
        ),
        h3(
          "div",
          { style: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14, flexWrap: "wrap" } },
          miniBtn("\u53D6\u6D88", () => setDeleteAsk(false)),
          miniBtn("\u53EA\u89E3\u9664\u7ED1\u5B9A", () => doRemoveProject(false)),
          miniBtn("\u8FDE\u6587\u4EF6\u4E00\u8D77\u5220", () => doRemoveProject(true), { color: T.danger, borderColor: T.danger })
        )
      )
    ) : null,
    exportOpen && doc ? h3(
      "div",
      {
        style: {
          position: "absolute",
          top: 48,
          right: 12,
          width: 300,
          zIndex: 30,
          padding: 12,
          borderRadius: 10,
          border: `1px solid ${T.border}`,
          background: T.panel,
          boxShadow: T.shadow,
          fontSize: 12
        }
      },
      h3(
        "div",
        { style: { display: "flex", alignItems: "center", marginBottom: 8 } },
        h3("strong", { style: { flex: 1 } }, "\u5BFC\u51FA\u53C2\u6570"),
        h3("span", { style: { cursor: "pointer", opacity: 0.6 }, onClick: () => setExportOpen(false) }, "\u2715")
      ),
      // 真实格式预告：打开表单就开始探测，探测中不挡其他操作
      (() => {
        const preview = exportPreview();
        const color = preview.tone === "error" ? T.danger : preview.tone === "warn" ? T.warn : preview.tone === "info" ? T.accent : T.textDim;
        return h3(
          "div",
          {
            style: {
              marginBottom: 8,
              padding: "6px 8px",
              borderRadius: 6,
              fontSize: 11,
              lineHeight: 1.6,
              color,
              background: T.fill,
              border: `1px solid ${T.border}`
            }
          },
          preview.text
        );
      })(),
      exportRow("\u5206\u8FA8\u7387", exportForm.resolution, (v2) => setExportForm({ ...exportForm, resolution: v2 }), [
        ["project", "\u8DDF\u968F\u5DE5\u7A0B\uFF08" + projectPixels().width + "\xD7" + projectPixels().height + "\uFF09"],
        ["1080", "1080p\uFF081920\xD71080\uFF09"],
        ["720", "720p\uFF081280\xD7720\uFF09"]
      ]),
      (() => {
        const projectFps = doc && doc.fps || 30;
        return exportRow("\u5E27\u7387", exportForm.fps, (v2) => {
          setExportForm({ ...exportForm, fps: v2 });
          if (v2 !== "project") setExportSettings({ ...exportSettings, fps: Number(v2) });
        }, [
          ["project", "\u8DDF\u968F\u5DE5\u7A0B\uFF08" + projectFps + "fps\uFF09"],
          ["24", "24 fps"],
          ["25", "25 fps"],
          ["30", "30 fps"],
          ["50", "50 fps"],
          ["60", "60 fps"]
        ]);
      })(),
      (() => {
        const projectFps = doc && doc.fps || 30;
        const exportFps = exportForm.fps === "project" ? projectFps : Number(exportForm.fps);
        const hint = exportFps === projectFps ? "\u6309\u5DE5\u7A0B " + projectFps + "fps \u91C7\u6837\uFF1B\u6539\u5E27\u7387\u53EA\u6539\u91C7\u6837\u5BC6\u5EA6\uFF0C\u65F6\u957F\u4E0E\u97F3\u8F68\u4E0D\u53D8\u3002" : "\u5DE5\u7A0B " + projectFps + "fps\uFF0C\u6309 " + exportFps + "fps \u91C7\u6837" + (exportFps > projectFps ? "\uFF08\u91CD\u590D\u5E27\u662F\u6B63\u5E38\u7684\uFF0C\u4E0D\u4F1A\u9ED1\u5E27\uFF09" : "\uFF08\u6309\u65F6\u95F4\u62BD\u5E27\uFF09") + "\uFF1B\u97F3\u9891\u4ECD\u6309\u65F6\u95F4\u8F74\u6DF7\u97F3\uFF0C\u65F6\u957F\u4E0D\u53D8\u3002";
        return h3(
          "div",
          { style: { opacity: 0.45, fontSize: 11, lineHeight: 1.6, margin: "2px 0 10px" } },
          hint
        );
      })(),
      exportRow("\u7801\u7387", exportForm.bitrate, (v2) => setExportForm({ ...exportForm, bitrate: v2 }), [
        ["auto", "\u81EA\u52A8\uFF08\u6309\u753B\u9762\u4F30\u7B97\uFF09"],
        ["4", "4 Mbps"],
        ["8", "8 Mbps"],
        ["16", "16 Mbps"]
      ]),
      exportRow("\u8303\u56F4", exportForm.range, (v2) => setExportForm({ ...exportForm, range: v2 }), [
        ["all", "\u5168\u7247\uFF08" + (doc && doc.duration || 0).toFixed(2) + "s\uFF09"],
        ["playhead", "\u64AD\u653E\u5934\u5230\u7ED3\u5C3E\uFF08" + fmtTime(state.playhead || 0) + " \u8D77\uFF09"]
      ]),
      (() => {
        const preview = exportPreview();
        const disabled = preview.blocked === true || capsBusy;
        const onClick = preview.blocked ? () => toast(preview.text, "warn") : capsBusy ? () => toast("\u6B63\u5728\u68C0\u6D4B\u7F16\u7801\u80FD\u529B\uFF0C\u7A0D\u7B49\u4E00\u4E0B", "warn") : startExportFromForm;
        return h3(
          "div",
          { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
          miniBtn("\u53D6\u6D88", () => setExportOpen(false)),
          miniBtn(
            "\u5F00\u59CB\u5BFC\u51FA",
            onClick,
            Object.assign(
              {
                background: T.primary,
                borderColor: T.primary,
                color: T.onPrimary,
                fontWeight: 600
              },
              disabled ? { opacity: 0.45, cursor: "not-allowed" } : null
            )
          )
        );
      })()
    ) : null,
    h3(ProgressOverlay, { busy: s.busy }),
    s.toast ? h3("div", {
      style: {
        position: "absolute",
        bottom: 14,
        left: "50%",
        transform: "translateX(-50%)",
        padding: "6px 12px",
        borderRadius: 8,
        background: T.panel,
        border: `1px solid ${T.border}`,
        fontSize: 12,
        color: T.text
      }
    }, s.toast.message) : null
  );
}
var ctxRef = null;
function DockEntry(props) {
  const s = useStore();
  const sessionId = props.sessionId || props.session && (props.session.id || props.session.sessionId);
  import_react3.default.useEffect(() => {
    if (sessionId && sessionId !== state.sessionId) {
      setState({ sessionId, projectId: null, doc: null, clips: [], assets: [], active: false, enabled: [], mine: [] });
    }
  }, [sessionId]);
  async function open() {
    if (state.busy) return;
    if (ctxRef && ctxRef.layout) ctxRef.layout.selectPanel(PANEL_ID);
  }
  return h3(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", fontSize: 12, color: T.textDim } },
    h3(
      "button",
      {
        type: "button",
        onClick: open,
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          borderRadius: 999,
          border: `1px solid ${T.border}`,
          background: "transparent",
          color: "inherit",
          fontSize: 12,
          cursor: "pointer"
        }
      },
      h3("span", { "aria-hidden": true }, "\u{1F3AC}"),
      state.doc ? "\u8FDB\u5165\u89C6\u9891\u5DE5\u4F5C\u53F0" : "\u89C6\u9891\u5DE5\u4F5C\u53F0"
    ),
    state.doc ? h3("span", { style: { fontSize: 11, opacity: 0.7 } }, `${state.doc.title} \xB7 r${state.doc.revision}`) : null
  );
}
var main_default = {
  inject: ["slots"],
  apply(ctx2) {
    ctxRef = ctx2;
    beacon("apply-start");
    const safe = (label, fn) => {
      try {
        const dispose = fn();
        beacon("register-ok", label);
        return typeof dispose === "function" ? dispose : () => {
        };
      } catch (e) {
        beacon("register-failed", label + ": " + (e && e.message));
        return () => {
        };
      }
    };
    ctx2.effect(
      () => safe(
        "view",
        () => ctx2.slots.inject(
          "conversation.view",
          () => ctx2.slots.register(
            { name: "conversation.view", id: "video-workbench", order: 20, label: () => "\u89C6\u9891\u5DE5\u4F5C\u53F0" },
            Workbench
          )
        )
      )
    );
    return () => {
      ctxRef = null;
      clearPool();
      clearThumbs();
      clearWaveforms();
    };
  }
};

      return module.exports && module.exports.default ? module.exports.default : module.exports;
    } catch (e) {
      try {
        console.error('[video-workbench] bundle failed', e);
        fetch('/api/video/beacon', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage: 'factory-error', detail: String((e && e.message) || e) }),
        }).catch(function () {});
      } catch (_) {}
      return { inject: [], apply: function () {} };
    }
  },
});
