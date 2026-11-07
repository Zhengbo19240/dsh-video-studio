/**
 * 时间线音频引擎（浏览器 / Chromium）。
 *
 * 在线播放按 AudioContext.currentTime 对齐；导出时用 OfflineAudioContext
 * 按同一套增益、倍速和淡入淡出重放。解码失败只丢一个片段 —— 导入坏音频
 * 不能打断整条播放链（黑屏/崩溃的防点）。
 *
 * 混音纪律（人声回避 + 响度归一）也在这里，而且只在这里：
 *   - 逐片段增益：volume / fadeIn / fadeOut，由 envelopePoints 生成；
 *   - 响度归一：按解码后素材的 RMS 算一个常量增益，夹在 0.25..4 之间；
 *   - ducking：拿整条时间线的 voice/music 段算一条包络，铺到每个 music 片段的
 *     独立 GainNode 上（控制速率 50Hz + linearRamp）。
 *
 * 预览与导出的差异（如实写在这里，不假装完全一致）：
 *   两者走同一个 scheduleSegment，增益断点按「时间」而不是「采样点」铺，
 *   所以 WebAudio 在设备采样率 / 离线 48k 下算出的曲线是同一条；
 *   差别只剩实时播放的重采样与首块解码延迟（< LOOKAHEAD），不存在算法级差异。
 *   一旦导出开始用 OfflineAudioContext 渲染，这条曲线就是逐采样的最终结果。
 */

import {
  computeDuckEnvelope,
  rmsNormalizeGain,
  clipGainPoints,
  gainAtPoints,
  AUDIO_VOLUME_MAX,
  DUCK_DEFAULTS,
  NORMALIZE_DEFAULTS,
} from '../audio-mix.mjs';

const LOOKAHEAD = 0.05; // 调度提前量（秒）
const DEFAULT_RATE = 48000;
const MAX_VOLUME = AUDIO_VOLUME_MAX; // 片段音量上限（与域层同一份常量：0..2）
const MIN_SPEED = 0.1;
const MAX_SPEED = 8;

// ducking 包络的控制速率：20ms 一格，足够表达 80ms 的 attack 斜坡，
// 又不会让一条 3 分钟的音乐产生几十万个自动化事件。
const DUCK_RATE = 50;
// 铺点时变化小于这个量的连续段合并成一个点（平坦区间只留首尾）
const DUCK_EPS = 1e-3;

/** 片段按角色分类；只有明确标成 music 的才参与回避，其余（含未标注）当 sfx。 */
function roleOf(value) {
  if (value === 'voice' || value === 'music' || value === 'sfx') return value;
  return 'sfx';
}

/**
 * @param {{ getSegments?: () => Array<object> }} opts
 * @returns {{
 *   play: (fromT?: number) => Promise<void>,
 *   pause: () => void,
 *   seek: (t: number) => void,
 *   setVolume: (v: number) => void,
 *   current: () => number,
 *   mixdown: (opts?: { duration?: number, sampleRate?: number }) => Promise<AudioBuffer>,
 *   dispose: () => void,
 * }}
 */
export function createAudioEngine({ getSegments } = {}) {
  let ctx = null; // 在线上下文，首次 play 时才创建
  let masterGain = null;
  let decodeCtx = null; // 无在线上下文时，专门用来解码
  let masterVolume = 1;
  let playing = false;
  let anchorCtx = 0; // 播放起点对应的 context 时间
  let anchorTimeline = 0; // 播放起点对应的时间线秒
  let pausedAt = 0;
  let playToken = 0; // 递增让在途的 play 失效，避免重复叠音
  let disposed = false;
  const voices = []; // 正在发声的 { source, gain }
  const cache = new Map(); // url -> Promise<AudioBuffer|null>
  const warned = new Set(); // 同一 url 只警告一次
  const normCache = new Map(); // url -> 响度归一增益（同一素材只算一次 RMS）

  // ---------------------------------------------------------------- 播放 ----

  /** 从时间线 fromT 开始播放；失败一律吞掉，不向上抛。 */
  async function play(fromT) {
    if (disposed) return;
    const startAt = clampTime(fromT);
    const token = ++playToken;
    stopVoices();
    playing = false;
    pausedAt = startAt;
    anchorTimeline = startAt;
    anchorCtx = 0;

    const live = ensureContext();
    if (!live) return;
    try {
      if (live.state === 'suspended' && typeof live.resume === 'function') await live.resume();
    } catch {
      // 自动播放策略拒绝时保持静音，不打断时间线
    }
    if (token !== playToken || disposed) return;

    // 包络按整条时间线算（含已播过的部分），再从 fromT 接入；
    // 只取 startAt 之后的片段去调度，避免把已经过去的片段重新排一遍。
    const all = collectSegments();
    const duck = buildDuckEnvelope(all);
    const segments = all.filter((s) => !s.muted && s.start + s.duration > startAt);
    const buffers = await Promise.all(segments.map((s) => decode(s.url)));
    if (token !== playToken || disposed) return;

    // 解码完成后才定基准，避免加载耗时把对齐拉偏
    const base = live.currentTime + LOOKAHEAD;
    for (let i = 0; i < segments.length; i += 1) {
      const buffer = buffers[i];
      if (!buffer) continue; // 解码失败的片段：静音跳过
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
    const at = clampTime(t);
    pausedAt = at;
    if (disposed) return;
    if (playing) {
      void play(at).catch(() => {});
      return;
    }
    playToken += 1; // 取消还在加载中的 play
    stopVoices();
    playing = false;
  }

  function setVolume(v) {
    const n = Number(v);
    masterVolume = Number.isFinite(n) ? clamp(n, 0, 1) : 1;
    if (!masterGain) return;
    const now = ctx ? ctx.currentTime : 0;
    if (typeof masterGain.gain.cancelScheduledValues === 'function') masterGain.gain.cancelScheduledValues(now);
    setValue(masterGain.gain, masterVolume, now);
  }

  function current() {
    if (!playing || !ctx) return pausedAt;
    const t = anchorTimeline + (ctx.currentTime - anchorCtx);
    return t > 0 ? t : 0;
  }

  // ---------------------------------------------------------------- 混音 ----

  /** 离线混音，供导出使用；任何异常都退化为静音 buffer。 */
  async function mixdown(options = {}) {
    const all = collectSegments().filter((s) => !s.muted);
    const rate = normalizeRate(options.sampleRate);
    const dur = normalizeDuration(options.duration, all);
    const frames = Math.max(1, Math.round(dur * rate));
    const segs = all.filter((s) => s.start < dur);
    if (segs.length === 0) return silentBuffer(frames, rate); // 没片段：直接静音

    const Ctor = offlineCtor();
    if (typeof Ctor !== 'function') {
      console.warn('[audio] 没有 OfflineAudioContext，混音返回静音');
      return silentBuffer(frames, rate);
    }
    let offline;
    try {
      offline = new Ctor(2, frames, rate);
    } catch (err) {
      console.warn('[audio] OfflineAudioContext 创建失败，混音返回静音', err && err.message ? err.message : err);
      return silentBuffer(frames, rate);
    }

    let master = null;
    try {
      master = offline.createGain();
      setValue(master.gain, masterVolume, 0);
      master.connect(offline.destination);
    } catch {
      master = offline.destination; // 退一步：直接接输出
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
      console.warn('[audio] 离线渲染失败，返回静音', err && err.message ? err.message : err);
      return silentBuffer(frames, rate);
    }
  }

  // ---------------------------------------------------------------- 生命周期 ----

  function dispose() {
    if (disposed) return;
    disposed = true;
    playToken += 1;
    playing = false;
    stopVoices();
    cache.clear();
    warned.clear();
    normCache.clear();
    if (masterGain) {
      try {
        masterGain.disconnect();
      } catch {
        // 已经断开
      }
      masterGain = null;
    }
    const closing = [ctx, decodeCtx].filter(Boolean);
    ctx = null;
    decodeCtx = null;
    for (const item of closing) {
      if (typeof item.close !== 'function') continue;
      try {
        const p = item.close();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {
        // 关闭失败不影响调用方
      }
    }
  }

  return { play, pause, seek, setVolume, current, mixdown, dispose };

  // ------------------------------------------------------------ 内部实现 ----

  /** 调度一个片段；offset/时长都按「源内秒」计算。duck 为整条时间线的包络（可为 null）。 */
  function scheduleSegment(target, destination, seg, buffer, base, fromT, duck = null) {
    const clipStart = seg.start;
    const clipEnd = seg.start + seg.duration;
    if (clipEnd <= fromT) return null;

    const skip = Math.max(0, fromT - clipStart); // 已过去的时间线秒
    const when = base + Math.max(0, clipStart - fromT);
    const offset = seg.sourceIn + skip * seg.speed; // 源内起点
    const bufferDur = buffer && Number.isFinite(buffer.duration) ? buffer.duration : Infinity;
    const span = Math.min((clipEnd - Math.max(clipStart, fromT)) * seg.speed, Math.max(0, bufferDur - offset));
    if (!(span > 0)) return null;

    const source = target.createBufferSource();
    source.buffer = buffer;
    if (source.playbackRate) setValue(source.playbackRate, seg.speed, when);

    const gain = target.createGain();
    applyEnvelope(gain.gain, seg, (localT) => base + (clipStart + localT - fromT), skip);

    // 串联的增益级：淡入淡出 → 响度归一 → ducking。
    // 每一级都是独立 GainNode，任何一级缺省时整条链不变，已有片段的行为不受影响。
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

    if (duck && seg.audioRole === 'music' && duckActiveIn(duck, clipStart, clipEnd)) {
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
      console.warn('[audio] 片段调度失败，已跳过：', seg.url, err && err.message ? err.message : err);
      return null;
    }
    return { source, gain, nodes };
  }

  /**
   * 整条时间线的 ducking 包络；没有 voice、没有 music、或两者不重叠时返回 null。
   * 包络按控制速率（DUCK_RATE）算，长度 = 时间线终点 × DUCK_RATE。
   */
  function buildDuckEnvelope(segs) {
    const voice = [];
    const music = [];
    let end = 0;
    for (const s of segs) {
      if (s.muted) continue;
      const stop = s.start + s.duration;
      if (stop > end) end = stop;
      if (s.audioRole === 'voice') voice.push({ start: s.start, end: stop });
      else if (s.audioRole === 'music') music.push({ start: s.start, end: stop });
    }
    if (!voice.length || !music.length || !(end > 0)) return null;
    return computeDuckEnvelope({
      duration: end,
      sampleRate: DUCK_RATE,
      voiceSegments: voice,
      musicSegments: music,
      maxDuckDb: DUCK_DEFAULTS.maxDuckDb,
      attack: DUCK_DEFAULTS.attack,
      release: DUCK_DEFAULTS.release,
    });
  }

  /** 片段区间内是否有任何一格被压过；没有就不必多接一个 GainNode。 */
  function duckActiveIn(env, start, end) {
    const rate = DUCK_RATE;
    const i0 = Math.max(0, Math.floor(start * rate));
    const i1 = Math.min(env.length, Math.ceil(end * rate));
    for (let i = i0; i < i1; i += 1) if (env[i] < 0.999) return true;
    return false;
  }

  /**
   * 把包络铺成 GainNode 的自动化点。timeOf 用「时间线秒 → 上下文时间」，
   * 预览（实时上下文）与导出（离线上下文）走同一条换算。
   * 平坦区间只写首尾两个点，避免几千个无效 setValueAtTime。
   */
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

    let last = env[i0];
    for (let i = i0 + 1; i < i1; i += 1) {
      const value = env[i];
      const at = timeOf(i);
      if (!(at > 0)) continue;
      const changing = Math.abs(value - last) >= DUCK_EPS;
      const tailPoint = i === i1 - 1;
      if (!changing && !tailPoint) continue;
      if (typeof param.linearRampToValueAtTime === 'function') param.linearRampToValueAtTime(value, at);
      else setValue(param, value, at);
      last = value;
    }
  }

  /**
   * 响度归一增益：按解码后素材的整段 RMS 算一次，按 url 缓存（同一素材复用）。
   * 只对明确标注为 music / sfx 的片段生效；voice 是参照，未标注的（例如导入视频自带声）一律不碰，
   * 避免把老工程里的人声素材重新拉平。
   */
  function normalizationGain(seg, buffer) {
    if (seg.audioRole !== 'music' && seg.audioRole !== 'sfx') return 1;
    const key = seg.url;
    const cached = normCache.get(key);
    if (cached !== undefined) return cached;
    const channels = channelDataOf(buffer);
    const gain = rmsNormalizeGain(channels, NORMALIZE_DEFAULTS.targetRms, {
      minGain: NORMALIZE_DEFAULTS.minGain,
      maxGain: NORMALIZE_DEFAULTS.maxGain,
    });
    normCache.set(key, gain);
    return gain;
  }

  function channelDataOf(buffer) {
    if (!buffer || typeof buffer.getChannelData !== 'function') return null;
    const count = Math.max(1, Number(buffer.numberOfChannels) || 1);
    const out = [];
    for (let ch = 0; ch < count; ch += 1) out.push(buffer.getChannelData(ch));
    return out;
  }

  /**
   * 片段局部增益断点：[{t, v}]。曲线定义在 src/audio-mix.mjs 的 clipGainPoints 里
   * （线性淡入淡出，重叠时按比例压缩）—— 这里不再保留第二份实现，
   * 否则「测试过的曲线」和「播放用的曲线」会悄悄分叉。
   */
  function envelopePoints(seg) {
    return clipGainPoints(seg.duration, {
      volume: seg.volume,
      fadeIn: seg.fadeIn,
      fadeOut: seg.fadeOut,
      muted: seg.muted,
    });
  }

  /** 在上下文时间里铺 setValue + linearRamp；从片段中途起播也能接上。 */
  function applyEnvelope(param, seg, timeOf, skip) {
    const pts = envelopePoints(seg);
    const start = Math.max(0, skip);
    const startTime = timeOf(start);
    setValue(param, valueAt(pts, start), startTime);
    for (const point of pts) {
      if (point.t <= start + 1e-6) continue;
      const at = timeOf(point.t);
      if (!(at > startTime + 1e-6)) continue;
      if (typeof param.linearRampToValueAtTime === 'function') param.linearRampToValueAtTime(point.v, at);
      else param.value = point.v;
    }
  }

  function valueAt(pts, t) {
    return gainAtPoints(pts, t);
  }

  // ---------------------------------------------------------------- 上下文 ----

  function audioCtor() {
    return globalThis.AudioContext || globalThis.webkitAudioContext || null;
  }

  function offlineCtor() {
    return globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext || null;
  }

  function ensureContext() {
    if (disposed) return null;
    if (ctx) return ctx;
    const Ctor = audioCtor();
    if (typeof Ctor !== 'function') {
      console.warn('[audio] 当前环境没有 AudioContext，播放保持静音');
      return null;
    }
    try {
      ctx = new Ctor();
      masterGain = ctx.createGain();
      setValue(masterGain.gain, masterVolume, 0);
      masterGain.connect(ctx.destination);
    } catch (err) {
      ctx = null;
      masterGain = null;
      console.warn('[audio] AudioContext 创建失败', err && err.message ? err.message : err);
      return null;
    }
    return ctx;
  }

  /** 解码用的上下文：优先在线上下文，否则临时开一个离线上下文。 */
  function decodeContext() {
    if (ctx) return ctx;
    if (decodeCtx) return decodeCtx;
    const Ctor = offlineCtor();
    if (typeof Ctor !== 'function') return null;
    try {
      decodeCtx = new Ctor(2, 1, 44100);
    } catch (err) {
      console.warn('[audio] 无法创建解码上下文', err && err.message ? err.message : err);
      return null;
    }
    return decodeCtx;
  }

  function stopVoices() {
    for (const voice of voices.splice(0)) {
      try {
        voice.source.stop();
      } catch {
        // 已结束或未启动
      }
      try {
        voice.source.disconnect();
      } catch {
        // 已断开
      }
      // 一条片段可能串了 2–3 个增益节点（淡入淡出 / 归一 / ducking），全部断开
      for (const node of voice.nodes && voice.nodes.length ? voice.nodes : [voice.gain]) {
        try {
          node.disconnect();
        } catch {
          // 已断开
        }
      }
    }
  }

  // ---------------------------------------------------------------- 解码 ----

  /** 按 url 缓存解码结果；失败返回 null 并警告一次。 */
  function decode(url) {
    let pending = cache.get(url);
    if (pending) return pending;
    pending = (async () => {
      const res = await fetch(url);
      if (!res || res.ok === false) throw new Error('音频请求失败');
      const data = await res.arrayBuffer();
      const base = decodeContext();
      if (!base) throw new Error('当前环境没有 WebAudio');
      return (await base.decodeAudioData(data)) || null;
    })().catch((err) => {
      cache.delete(url); // 允许下次重试
      if (!warned.has(url)) {
        warned.add(url);
        console.warn('[audio] 解码失败，已跳过该片段：', url, err && err.message ? err.message : err);
      }
      return null;
    });
    cache.set(url, pending);
    return pending;
  }

  // ---------------------------------------------------------------- 片段 ----

  function collectSegments() {
    let raw;
    try {
      raw = typeof getSegments === 'function' ? getSegments() : [];
    } catch (err) {
      console.warn('[audio] getSegments 抛错，按空时间线处理', err && err.message ? err.message : err);
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
    if (!item || typeof item !== 'object') return null;
    const url = typeof item.url === 'string' ? item.url : '';
    if (!url) return null;
    const start = Number(item.start);
    const duration = Number(item.duration);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) return null;
    const speed = Number(item.speed);
    const volume = Number(item.volume);
    return {
      assetId: item.assetId,
      url,
      start: Math.max(0, start),
      duration,
      sourceIn: Math.max(0, Number(item.sourceIn) || 0),
      speed: clamp(Number.isFinite(speed) && speed > 0 ? speed : 1, MIN_SPEED, MAX_SPEED),
      volume: clamp(Number.isFinite(volume) ? volume : 1, 0, MAX_VOLUME),
      fadeIn: Math.max(0, Number(item.fadeIn) || 0),
      fadeOut: Math.max(0, Number(item.fadeOut) || 0),
      muted: item.muted === true,
      // 未标注一律当 sfx：只有明确标成 music 的参与 ducking，只有 voice 能触发它
      audioRole: roleOf(item.audioRole),
      index,
    };
  }

  // ---------------------------------------------------------------- 小工具 ----

  function setValue(param, value, when) {
    if (!param) return;
    if (typeof param.setValueAtTime === 'function') {
      try {
        param.setValueAtTime(value, when);
        return;
      } catch {
        // 落到直接赋值
      }
    }
    param.value = value;
  }

  function normalizeRate(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_RATE;
    return Math.min(192000, Math.max(3000, Math.round(n)));
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
    if (typeof Ctor === 'function') {
      try {
        return new Ctor({ length: frames, numberOfChannels: 2, sampleRate: rate });
      } catch {
        // 落到鸭子对象
      }
    }
    const channels = [new Float32Array(frames), new Float32Array(frames)];
    return {
      length: frames,
      numberOfChannels: 2,
      sampleRate: rate,
      duration: frames / rate,
      getChannelData: (i) => channels[i] || channels[0],
    };
  }
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function clampTime(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
