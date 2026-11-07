/**
 * 混音纪律的纯函数层：人声回避（ducking）+ 响度归一。
 *
 * 这里只有数学：不读文件、不碰 DOM、不依赖 WebAudio，可以直接在 Node 里逐条跑。
 * 浏览器侧（src/client/audio.js）负责把返回的包络铺到 GainNode 上；预览与导出
 * 共用同一条调度路径，所以两边听到的增益曲线一致。
 *
 * 一个刻意的近似：integratedLoudnessApprox 不是 EBU R128。
 * 它不做 K 加权、不做真峰值、不做 5 段门限，只用「400ms 块 + 绝对/相对门限 + RMS」。
 * 结论只在一件事上可信：**相同时长素材之间的相对响度差**，不能拿去和标准表对表。
 *
 * 术语（避免下游误读）：
 *   voiceSegments / musicSegments 都是时间线上的 [{ start, end }]，单位秒。
 *   duck 包络是「乘性增益」：1 = 不动，0.251 ≈ -12 dB。
 */

/** ducking 默认参数：最低压到 -12 dB，80ms 进入、250ms 退出（避免抽气声）。 */
export const DUCK_DEFAULTS = Object.freeze({ maxDuckDb: -12, attack: 0.08, release: 0.25 });

/** 响度归一的默认目标：RMS 0.1（约 -20 dBFS），增益夹在 0.25..4（±12 dB 以内）。 */
export const NORMALIZE_DEFAULTS = Object.freeze({ targetRms: 0.1, minGain: 0.25, maxGain: 4 });

/** 分贝 → 线性增益。非有限值按 0 dB 处理。 */
export function dbToGain(db) {
  const n = Number(db);
  if (!Number.isFinite(n)) return 1;
  return Math.pow(10, n / 20);
}

/** 线性增益 → 分贝；0 或负数返回 -Infinity。 */
export function gainToDb(gain) {
  const n = Number(gain);
  if (!(n > 0)) return -Infinity;
  return 20 * Math.log10(n);
}

/**
 * 计算 ducking 增益包络。
 *
 * 语义：
 *   - 只有 voice 与 music 重叠的区间才降增益；
 *   - 每个重叠区间的起点做 attack 斜坡（1 → duck），终点做 release 斜坡（duck → 1）；
 *   - 没有 voice、没有 music、或者两者不重叠 → 全 1（调用方可以据此跳过任何处理）；
 *   - attack + release 超过区间长度时按比例压缩，短促重叠也有完整的进出。
 *
 * 返回 Float32Array，长度 = round(duration × sampleRate)；duration ≤ 0 返回空数组。
 * 注意：调用方若把 sampleRate 设成 48000，10 分钟成片会产生 2880 万个采样点（115MB）。
 * 包络只用于「控制速率」调度时，建议传 50 这类控制速率，而不是音频采样率。
 *
 * @param {object} opts
 * @param {number} opts.duration 时间线总长（秒）
 * @param {number} [opts.sampleRate=48000] 包络采样率（Hz）
 * @param {Array<{start:number,end:number}>} [opts.voiceSegments]
 * @param {Array<{start:number,end:number}>} [opts.musicSegments]
 * @param {number} [opts.maxDuckDb=-12] 最大衰减（dB，必须 ≤ 0；> 0 会被夹到 0）
 * @param {number} [opts.attack=0.08] 进入斜坡（秒）
 * @param {number} [opts.release=0.25] 退出斜坡（秒）
 * @returns {Float32Array}
 */
export function computeDuckEnvelope({
  duration,
  sampleRate = 48000,
  voiceSegments = [],
  musicSegments = [],
  maxDuckDb = DUCK_DEFAULTS.maxDuckDb,
  attack = DUCK_DEFAULTS.attack,
  release = DUCK_DEFAULTS.release,
} = {}) {
  const dur = Number(duration);
  const rate = Number(sampleRate);
  if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(rate) || rate <= 0) return new Float32Array(0);

  const n = Math.max(1, Math.round(dur * rate));
  const out = new Float32Array(n);
  out.fill(1);

  const duckDb = clamp(Number.isFinite(Number(maxDuckDb)) ? Number(maxDuckDb) : DUCK_DEFAULTS.maxDuckDb, -60, 0);
  const duck = dbToGain(duckDb);
  if (duck >= 1) return out; // 没有衰减量：直接全 1

  const attackS = Math.max(0, Number.isFinite(Number(attack)) ? Number(attack) : DUCK_DEFAULTS.attack);
  const releaseS = Math.max(0, Number.isFinite(Number(release)) ? Number(release) : DUCK_DEFAULTS.release);

  const windows = duckWindows(voiceSegments, musicSegments, dur);
  if (!windows.length) return out;

  for (const w of windows) {
    const segLen = w.end - w.start;
    if (!(segLen > 0)) continue;

    // 区间太短时按比例压缩 attack / release，保证「进得去也出得来」
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
      let v;
      if (i < iA) {
        // attack：1 → duck，线性
        const p = at > 1e-12 ? clamp((t - w.start) / at, 0, 1) : 1;
        v = 1 + (duck - 1) * p;
      } else if (i < iR) {
        v = duck;
      } else {
        // release：duck → 1，线性
        const p = rel > 1e-12 ? clamp((t - relStart) / rel, 0, 1) : 1;
        v = duck + (1 - duck) * p;
      }
      // 多个区间挨得近时取更低的增益：宁可多压一点，也不要抽气
      if (v < out[i]) out[i] = v;
    }
  }

  return out;
}

/** 把 overlaps 换成「voice 与 music 的交集」并合并相邻/重叠区间。 */
function duckWindows(voiceSegments, musicSegments, duration) {
  const voice = cleanSegments(voiceSegments, duration);
  const music = cleanSegments(musicSegments, duration);
  if (!voice.length || !music.length) return [];

  const hits = [];
  for (const v of voice) {
    for (const m of music) {
      const start = Math.max(v.start, m.start);
      const end = Math.min(v.end, m.end);
      if (end > start) hits.push({ start, end });
    }
  }
  if (!hits.length) return [];

  hits.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    // 1ms 以内的缝隙不值得放出来，避免两个窗口之间出现一次多余的起伏
    if (last && h.start <= last.end + 0.001) last.end = Math.max(last.end, h.end);
    else merged.push({ start: h.start, end: h.end });
  }
  return merged;
}

function cleanSegments(list, duration) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const start = Math.max(0, Math.min(duration, Number(item.start)));
    const end = Math.max(0, Math.min(duration, Number(item.end)));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end > start) out.push({ start, end });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * 单个片段的 RMS 归一增益。
 *
 * 用整段素材的 RMS 与 targetRms 的比值做增益，夹在 [minGain, maxGain] 里，
 * 避免把一条底噪拉成主角、也避免把一条本来就响的 jingle 压没。
 * 静音（RMS≈0）直接返回 1：不给无信息的内容放大。
 *
 * samples 可以是 Float32Array / 普通数字数组，也可以是「声道数组的数组」。
 *
 * @param {Float32Array|number[]|Float32Array[]} samples
 * @param {number} [targetRms=0.1]
 * @param {{minGain?:number, maxGain?:number}} [opts]
 * @returns {number}
 */
export function rmsNormalizeGain(samples, targetRms = NORMALIZE_DEFAULTS.targetRms, { minGain = NORMALIZE_DEFAULTS.minGain, maxGain = NORMALIZE_DEFAULTS.maxGain } = {}) {
  const rms = rootMeanSquare(samples);
  if (!(rms > 1e-9)) return 1;
  const target = Number.isFinite(Number(targetRms)) && Number(targetRms) > 0 ? Number(targetRms) : NORMALIZE_DEFAULTS.targetRms;
  const lo = Number.isFinite(Number(minGain)) && Number(minGain) > 0 ? Number(minGain) : NORMALIZE_DEFAULTS.minGain;
  const hi = Number.isFinite(Number(maxGain)) && Number(maxGain) > 0 ? Number(maxGain) : NORMALIZE_DEFAULTS.maxGain;
  const gain = target / rms;
  if (!Number.isFinite(gain)) return 1;
  return clamp(gain, Math.min(lo, hi), Math.max(lo, hi));
}

/** 整段素材的 RMS（线性，0..1 量级）。空输入返回 0。 */
export function rootMeanSquare(samples) {
  const acc = { sumSq: 0, count: 0 };
  accumulateSquare(samples, acc);
  if (!(acc.count > 0)) return 0;
  return Math.sqrt(acc.sumSq / acc.count);
}

function accumulateSquare(input, acc) {
  if (!input || typeof input.length !== 'number') return;
  if (typeof input[0] === 'number') {
    for (let i = 0; i < input.length; i += 1) {
      const v = input[i];
      if (Number.isFinite(v)) acc.sumSq += v * v;
      acc.count += 1;
    }
    return;
  }
  for (let i = 0; i < input.length; i += 1) accumulateSquare(input[i], acc);
}

/**
 * 近似的整体响度（LUFS 量级）。
 *
 * 做法：400ms 块、100ms 跳步 → 每块 RMS → 绝对门限（-70 LUFS 量级）→
 * 相对门限（低于均值 10 dB 的块丢掉）→ 剩下的块取均值 → -0.691 + 10·log10(meanSquare)。
 * 这个 -0.691 是 EBU 的偏移量，但没有 K 加权，所以数值不等于标准 LUFS。
 *
 * 只保证一件事：**同长度素材之间的相对差是对的**（0dB 正弦比半幅正弦高约 6dB）。
 * 纯静音返回 -Infinity。
 *
 * @param {Float32Array|number[]|Float32Array[]} samples
 * @param {number} sampleRate
 * @returns {number} LUFS 量级的近似值
 */
export function integratedLoudnessApprox(samples, sampleRate) {
  const rate = Number(sampleRate);
  if (!Number.isFinite(rate) || rate <= 0) return -Infinity;

  const mono = toMono(samples);
  if (!mono || mono.length === 0) return -Infinity;

  const block = Math.max(1, Math.round(0.4 * rate));
  const hop = Math.max(1, Math.round(0.1 * rate));
  const blocks = [];
  if (mono.length < block) {
    // 短于 400ms：整段当一个块，不因为素材短就返回「没有响度」
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
  const relGate = mean / 10; // -10 dB
  const above = kept.filter((ms) => ms >= relGate);
  if (above.length) kept = above;
  mean = average(kept);
  if (!(mean > 0)) return -Infinity;

  return -0.691 + 10 * Math.log10(mean);
}

function meanSquareFromLufs(lufs) {
  return Math.pow(10, (lufs + 0.691) / 10);
}

/** 多声道取平均后合成单声道视图；单声道直接返回。 */
function toMono(samples) {
  if (!samples || typeof samples.length !== 'number') return null;
  if (typeof samples[0] === 'number') {
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const v = samples[i];
      out[i] = Number.isFinite(v) ? v : 0;
    }
    return out;
  }
  const channels = [];
  for (const ch of samples) if (ch && typeof ch.length === 'number') channels.push(ch);
  if (!channels.length) return null;
  let len = Infinity;
  for (const ch of channels) len = Math.min(len, ch.length);
  if (!(len > 0) || !Number.isFinite(len)) return null;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
    let sum = 0;
    for (const ch of channels) {
      const v = ch[i];
      sum += Number.isFinite(v) ? v : 0;
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
  for (const v of list) sum += v;
  return sum / list.length;
}

// ------------------------------------------------------- 片段增益 / 包络 ----
//
// 这一节是「片段音量」的唯一权威实现。客户端（src/client/audio.js）用它生成
// GainNode 的自动化点，测试与 video_audio_mix 用它算有效峰值 —— 两边必须是同一条曲线，
// 否则「预览听着小、导出却大」这类问题永远说不清。
//
// 曲线选择：线性（linear）。fadeIn/fadeOut 在各自时长内从 0 线性升/降到 volume，
// 中段保持 volume。选线性而不是等功率，是因为它和 WebAudio 的 linearRampToValueAtTime
// 逐点一致，导出可以直接复用同一条实现；等功率适合交叉淡化，不适合单片段淡入淡出。

/** 片段音频属性的默认值。文档里缺字段时按这一份解释，不猜别的东西。 */
export const CLIP_AUDIO_DEFAULTS = Object.freeze({ volume: 1, fadeIn: 0, fadeOut: 0, muted: false });

/** volume 的合法区间（含端点）。域层与客户端共用，避免「模型允许 4、命令层只允许 2」。 */
export const AUDIO_VOLUME_MIN = 0;
export const AUDIO_VOLUME_MAX = 2;

/** 导出端的峰值上限：留 1% headroom，避免 AAC/Opus 编码前的整数化与重采样过冲。 */
export const EXPORT_PEAK_CEILING = 0.99;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 片段局部增益断点：[{t, v}]，t 是片段内秒数，v 是线性增益。
 *
 * 规则：
 *   - volume 缺省 1，fadeIn/fadeOut 缺省 0；
 *   - 两段淡入淡出加起来超过片段时长时按比例压缩（短片段也有完整的进出，不互相吃掉）；
 *   - 没有淡入淡出时只有单点 [{0, volume}]，调用方可以直接当常量增益。
 *
 * @param {number} duration 片段时长（秒）
 * @param {{volume?:number, fadeIn?:number, fadeOut?:number, muted?:boolean}} [opts]
 * @returns {Array<{t:number, v:number}>}
 */
export function clipGainPoints(duration, opts = {}) {
  const dur = Number(duration);
  if (!Number.isFinite(dur) || dur <= 0) return [{ t: 0, v: 0 }];
  const o = opts && typeof opts === 'object' ? opts : {};
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

/** 在断点上线性插值取增益；t 越界时夹到首/尾。 */
export function gainAtPoints(points, t) {
  if (!Array.isArray(points) || points.length === 0) return 0;
  const x = Number.isFinite(Number(t)) ? Number(t) : 0;
  if (x <= points[0].t) return points[0].v;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (x <= b.t) {
      if (b.t - a.t <= 1e-9) return b.v;
      return a.v + ((b.v - a.v) * (x - a.t)) / (b.t - a.t);
    }
  }
  return points[points.length - 1].v;
}

/** 片段内 t 秒处的增益（封装断点计算，单点快路径）。 */
export function clipGainAt(localT, duration, opts = {}) {
  return gainAtPoints(clipGainPoints(duration, opts), localT);
}

/** 按采样率把片段增益铺成 Float32Array（长度 = round(duration×sampleRate)）。 */
export function clipGainEnvelope(duration, opts = {}, sampleRate = 48000) {
  const dur = Number(duration);
  const rate = Number(sampleRate);
  if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(rate) || rate <= 0) return new Float32Array(0);
  const n = Math.max(1, Math.round(dur * rate));
  const points = clipGainPoints(dur, opts);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = gainAtPoints(points, i / rate);
  return out;
}

/**
 * 峰值：接受扁平数组（单声道）或声道数组的数组。空输入返回 0。
 * 只看绝对值，不区分声道；NaN 当 0 处理（不能被一个坏采样放大成 Infinity）。
 */
export function measurePeak(samples) {
  let peak = 0;
  const walk = (input) => {
    if (!input || typeof input.length !== 'number') return;
    if (typeof input[0] === 'number') {
      for (let i = 0; i < input.length; i += 1) {
        const v = Number(input[i]);
        if (!Number.isFinite(v)) continue;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      return;
    }
    for (let i = 0; i < input.length; i += 1) walk(input[i]);
  };
  walk(samples);
  return peak;
}

/**
 * 导出前留 headroom：整轨峰值超过 ceiling 时，按同一个线性增益整体压到 ceiling 以内。
 *
 * 为什么选「整体压」而不是「只提示、不处理」：
 *   1. 编码器（AAC/Opus）对 >1 的采样只能截断，截断就是失真，且发生在用户看不到的阶段；
 *   2. 整体压是一个常数增益，不改变任何相对平衡（配乐/口播/音效的比例仍然对），
 *      而提示不解决问题 —— 用户导出后才发现爆音已经来不及；
 *   3. 压了多少会写进返回值（audioTrimDb / audioPeakAfterTrim），不静默。
 *
 * 不改入参：需要压时返回新的 Float32Array 副本；不需要压时原样返回同一个引用。
 *
 * @param {Float32Array[]|number[]} channels 声道数组的数组，或扁平单声道数组
 * @param {number} [ceiling=EXPORT_PEAK_CEILING]
 * @returns {{channels:any, peak:number, gain:number, trimmed:boolean, peakAfterTrim:number}}
 */
export function applyPeakHeadroom(channels, ceiling = EXPORT_PEAK_CEILING) {
  const limit = clampNumber(ceiling, 0.05, 1, EXPORT_PEAK_CEILING);
  const peak = measurePeak(channels);
  if (!(peak > limit)) return { channels, peak, gain: 1, trimmed: false, peakAfterTrim: peak };
  const gain = limit / peak;
  const scaleChannel = (arr) => {
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i += 1) {
      const v = Number(arr[i]);
      out[i] = Number.isFinite(v) ? v * gain : 0;
    }
    return out;
  };
  const scaled = Array.isArray(channels) && channels.length && typeof channels[0] === 'object'
    ? channels.map(scaleChannel)
    : scaleChannel(channels);
  return { channels: scaled, peak, gain, trimmed: true, peakAfterTrim: peak * gain };
}

/**
 * 一个 WAV 文件的单声道样本（只读 PCM / float32，不猜压缩格式）。
 *
 * 用途：video_audio_mix 的峰值估计。用纯 JS 解，是因为它必须能在没有 ffmpeg 的机器上
 * 给出确定答案；不认识的格式返回 null，由调用方标 unknown 并说明原因。
 *
 * @param {ArrayBuffer|Uint8Array|Buffer} bytes
 * @returns {{samples:Float32Array, sampleRate:number, channels:number, bitsPerSample:number, frames:number, duration:number}|null}
 */
export function decodeWavMono(bytes) {
  if (!bytes || typeof bytes.byteLength !== 'number' || bytes.byteLength < 44) return null;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const ascii = (off, len) => {
    let s = '';
    for (let i = 0; i < len; i += 1) s += String.fromCharCode(view[off + i]);
    return s;
  };
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') return null;

  let pos = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;
  while (pos + 8 <= view.length) {
    const id = ascii(pos, 4);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ' && body + 16 <= view.length) {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bitsPerSample: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = Math.min(size, view.length - body);
      break;
    }
    pos = body + size + (size % 2); // RIFF 块按偶数字节对齐
  }
  if (!fmt || dataOffset < 0 || !(fmt.channels > 0) || !(fmt.sampleRate > 0)) return null;
  if (dataSize <= 0) return null;

  const { format, channels, sampleRate, bitsPerSample } = fmt;
  const isFloat = format === 3 && bitsPerSample === 32;
  const isPcm = format === 1 && [8, 16, 24, 32].includes(bitsPerSample);
  if (!isFloat && !isPcm) return null;

  const bytesPerSample = bitsPerSample / 8;
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(dataSize / frameBytes);
  if (!(frames > 0)) return null;

  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      const at = dataOffset + i * frameBytes + ch * bytesPerSample;
      let v = 0;
      if (isFloat) v = dv.getFloat32(at, true);
      else if (bitsPerSample === 8) v = (dv.getUint8(at) - 128) / 128;
      else if (bitsPerSample === 16) v = dv.getInt16(at, true) / 32768;
      else if (bitsPerSample === 24) {
        const b0 = dv.getUint8(at);
        const b1 = dv.getUint8(at + 1);
        const b2 = dv.getUint8(at + 2);
        let n = b0 | (b1 << 8) | (b2 << 16);
        if (n & 0x800000) n -= 0x1000000;
        v = n / 8388608;
      } else v = dv.getInt32(at, true) / 2147483648;
      sum += v;
    }
    samples[i] = sum / channels;
  }
  return { samples, sampleRate, channels, bitsPerSample, frames, duration: frames / sampleRate };
}

/**
 * 片段在时间线上的「有效峰值」：按源窗口取样本，再乘上片段增益包络取最大值。
 *
 * 这是估算，不是实测混音总线：ducking、响度归一、多条片段叠加都不在这里。
 * 返回值里的 method 说明数据来源；拿不到样本时返回 { peak:null, method:null, reason }。
 *
 * @param {Float32Array} sourceSamples 素材的单声道样本
 * @param {number} sourceRate 素材采样率
 * @param {object} clip 片段（duration/volume/fadeIn/fadeOut/muted/speed/sourceIn）
 * @returns {{peak:number|null, method:string|null, reason:string|null, sampledFrames:number}}
 */
export function effectiveClipPeak(sourceSamples, sourceRate, clip = {}) {
  const rate = Number(sourceRate);
  if (!sourceSamples || typeof sourceSamples.length !== 'number' || !(rate > 0)) {
    return { peak: null, method: null, reason: '素材样本不可用', sampledFrames: 0 };
  }
  const dur = Number(clip.duration);
  if (!(dur > 0)) return { peak: null, method: null, reason: '片段时长非法', sampledFrames: 0 };

  const speed = Number.isFinite(Number(clip.speed)) && Number(clip.speed) > 0 ? Number(clip.speed) : 1;
  const sourceIn = Number.isFinite(Number(clip.sourceIn)) ? Math.max(0, Number(clip.sourceIn)) : 0;
  const opts = {
    volume: clip.volume,
    fadeIn: clip.fadeIn,
    fadeOut: clip.fadeOut,
    muted: clip.muted,
  };
  const points = clipGainPoints(dur, opts);
  const n = Math.max(1, Math.round(dur * rate));
  let peak = 0;
  let sampled = 0;
  for (let i = 0; i < n; i += 1) {
    const localT = i / rate;
    const srcIndex = Math.round((sourceIn + localT * speed) * rate);
    if (srcIndex < 0 || srcIndex >= sourceSamples.length) continue;
    const v = Number(sourceSamples[srcIndex]);
    if (!Number.isFinite(v)) continue;
    sampled += 1;
    const g = gainAtPoints(points, localT);
    const a = Math.abs(v * g);
    if (a > peak) peak = a;
  }
  if (!sampled) {
    return { peak: null, method: null, reason: '片段窗口超出素材长度（sourceIn + 时长 × 速度 > 素材）', sampledFrames: 0 };
  }
  return { peak, method: 'wav-pcm', reason: null, sampledFrames: sampled };
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
