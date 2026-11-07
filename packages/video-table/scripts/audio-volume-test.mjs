/**
 * 音量控制的测试：模型层 → 命令层 → 混音/导出 → 只读报告，四段各测一遍。
 *
 *   node scripts/audio-volume-test.mjs [--verbose]
 *
 * 关键取舍（写在测试里，免得以后被「优化」掉）：
 *   - 混音与导出的增益曲线由 src/audio-mix.mjs 的 clipGainPoints 统一给出（线性），
 *     浏览器侧 src/client/audio.js 只是把它铺到 GainNode 上。所以这里的断言
 *     既覆盖纯数学，也覆盖「引擎真的接上了」。
 *   - 导出峰值不做静默截断：>0.99 时整体乘一个常数增益压下来，并把压了多少写进结果。
 *     测试里同时验证「压了」和「入参没被改」。
 *   - video_audio_mix 的峰值只认两种来源：WAV 解码（真实样本）与 ffmpeg volumedetect；
 *     拿不到就 unknown，不填数字。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProject, applyOps, AUDIO_VOLUME_MAX } from '../src/domain.mjs';
import { scanLocal } from '../src/sound-lib.mjs';
import {
  clipGainPoints,
  clipGainAt,
  clipGainEnvelope,
  decodeWavMono,
  effectiveClipPeak,
  applyPeakHeadroom,
  measurePeak,
  EXPORT_PEAK_CEILING,
} from '../src/audio-mix.mjs';
import { prepareAudio } from '../src/client/exporter.js';
import { ProjectStore } from '../src/store.mjs';
import { videoTools } from '../src/tools.mjs';
import { parseVolumedetect } from '../src/audio-mix-tool.mjs';
import { insertSound } from '../src/sound-tools.mjs';
import { isLosslessJson } from '../src/json-safe.mjs';

const VERBOSE = process.argv.includes('--verbose');
let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') throw new Error('异步用例请用 await checkAsync');
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + (e && e.message));
  }
}

async function checkAsync(name, fn) {
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

function near(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

function throwsCode(fn, codePart, messagePart) {
  try {
    fn();
  } catch (e) {
    const text = String((e && e.message) || '');
    assert(e && e.code === codePart, `错误码应为 ${codePart}，实际 ${e && e.code}（${text}）`);
    if (messagePart) assert(text.includes(messagePart), `错误信息应包含「${messagePart}」，实际：${text}`);
    return e;
  }
  throw new Error('应当抛错，但没有抛');
}

/** 16-bit PCM 单声道 WAV，样本 = sin(2πft) × amp。 */
function makeWav({ rate = 8000, seconds = 4, amp = 0.5, freq = 440 } = {}) {
  const frames = Math.round(seconds * rate);
  const dataSize = frames * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  const w = (2 * Math.PI * freq) / rate;
  for (let i = 0; i < frames; i += 1) {
    const v = Math.sin(i * w) * amp;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  return buf;
}

function sine(amp, seconds, freq = 440, rate = 8000) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freq) / rate;
  for (let i = 0; i < n; i += 1) out[i] = Math.sin(i * w) * amp;
  return out;
}

const BASE = createProject({ sessionId: 's', root: 'D:/tmp/audio-volume' });
const ASSET_OPS = [
  { type: 'asset.add', assetId: 'ast', relPath: 'assets/x.wav', name: 'x.wav' },
  {
    type: 'clip.insert',
    clipId: 'a',
    trackId: 'a1',
    clipType: 'media',
    assetId: 'ast',
    start: 0,
    duration: 4,
  },
];
const DOC = applyOps(BASE, ASSET_OPS).doc;

// ============================================================ 模型 / 命令层 ====

console.log('片段模型与命令层');

check('① clip.setAudio 改 volume：diff 显示旧值 1 → 新值 0.4', () => {
  const r = applyOps(DOC, [{ type: 'clip.setAudio', clipId: 'a', volume: 0.4 }]);
  assert(r.doc.clips[0].volume === 0.4, 'clips[0].volume 应为 0.4');
  const mod = r.diff.modified.find((m) => m.kind === 'clip' && m.id === 'a');
  assert(mod && mod.fields.volume, 'diff 必须带上 volume 字段');
  assert(mod.fields.volume.before === 1, '旧值应解释为默认 1，实际 ' + JSON.stringify(mod.fields.volume));
  assert(mod.fields.volume.after === 0.4, '新值应为 0.4');
});

check('② volume 超范围拒绝（3 / -0.1），不静默夹紧', () => {
  throwsCode(() => applyOps(DOC, [{ type: 'clip.setAudio', clipId: 'a', volume: 3 }]), 'INVALID_ARG', '0..2');
  throwsCode(() => applyOps(DOC, [{ type: 'clip.setAudio', clipId: 'a', volume: -0.1 }]), 'INVALID_ARG', '0..2');
  throwsCode(() => applyOps(DOC, [{ type: 'clip.setAudio', clipId: 'a', volume: '0.5' }]), 'INVALID_ARG', '必须是数字');
  // 边界值合法
  assert(applyOps(DOC, [{ type: 'clip.setAudio', clipId: 'a', volume: 0 }]).doc.clips[0].volume === 0, '0 应合法');
  assert(
    applyOps(DOC, [{ type: 'clip.setAudio', clipId: 'a', volume: AUDIO_VOLUME_MAX }]).doc.clips[0].volume === 2,
    '2 应合法',
  );
});

check('③ 片段不存在 → REF_NOT_FOUND', () => {
  throwsCode(() => applyOps(DOC, [{ type: 'clip.setAudio', clipId: 'nope', volume: 0.5 }]), 'REF_NOT_FOUND', '片段不存在');
});

check('④ 非音频轨（v1）上的片段拒绝写音量，并说明轨道类型', () => {
  const withVideo = applyOps(DOC, [
    { type: 'clip.insert', clipId: 'v', trackId: 'v1', clipType: 'text', text: 'x', start: 0, duration: 2 },
  ]).doc;
  throwsCode(
    () => applyOps(withVideo, [{ type: 'clip.setAudio', clipId: 'v', volume: 0.5 }]),
    'INVALID_OP',
    '只能用于音频轨',
  );
});

check('⑤ 淡入 + 淡出 > 片段时长 → 拒绝', () => {
  throwsCode(
    () => applyOps(DOC, [{ type: 'clip.setAudio', clipId: 'a', fadeIn: 3, fadeOut: 2 }]),
    'INVALID_OP',
    '不能超过片段时长',
  );
  // 正好等于时长是合法的边界
  const ok = applyOps(DOC, [{ type: 'clip.setAudio', clipId: 'a', fadeIn: 2, fadeOut: 2 }]);
  assert(ok.doc.clips[0].fadeIn === 2 && ok.doc.clips[0].fadeOut === 2, '和等于时长应放行');
});

check('⑥ clip.update 是 clip.setAudio 的别名：volume / fadeIn / muted 都生效', () => {
  const r = applyOps(DOC, [{ type: 'clip.update', clipId: 'a', volume: 0.3, fadeIn: 0.2, muted: true }]);
  const c = r.doc.clips[0];
  assert(c.volume === 0.3 && c.fadeIn === 0.2 && c.muted === true, '字段应写入：' + JSON.stringify(c));
  const mod = r.diff.modified.find((m) => m.id === 'a');
  assert(mod.fields.volume && mod.fields.volume.after === 0.3, 'diff 应包含 volume');
  assert(mod.fields.muted && mod.fields.muted.after === true, 'diff 应包含 muted');
});

check('⑦ clip.update 用于非音频字段 → 明确报「只支持音视频片段…」', () => {
  throwsCode(
    () => applyOps(DOC, [{ type: 'clip.update', clipId: 'a', start: 2 }]),
    'INVALID_ARG',
    '只支持音视频片段的 volume/muted/fadeIn/fadeOut',
  );
  throwsCode(
    () => applyOps(DOC, [{ type: 'clip.update', clipId: 'a', style: { color: '#fff' } }]),
    'INVALID_ARG',
    '只支持音视频片段',
  );
});

check('⑧ clip.insert：音频轨默认 volume=1；视频轨带 volume 被忽略且不报错', () => {
  const audio = applyOps(BASE, ASSET_OPS).doc.clips[0];
  assert(audio.volume === 1, '音频轨新片段应写默认 volume=1');
  const video = applyOps(BASE, [
    { type: 'asset.add', assetId: 'ast', relPath: 'assets/x.wav', name: 'x.wav' },
    {
      type: 'clip.insert',
      clipId: 'v',
      trackId: 'v1',
      clipType: 'media',
      assetId: 'ast',
      start: 0,
      duration: 2,
      volume: 0.4,
      fadeIn: 0.1,
    },
  ]).doc.clips.find((c) => c.id === 'v');
  assert(video && video.volume === undefined, '视频轨不应写入 volume（忽略而不是报错）');
});

check('⑨ clip.split：左半去掉 fadeOut，右半去掉 fadeIn，两半仍合法', () => {
  const doc = applyOps(DOC, [{ type: 'clip.setAudio', clipId: 'a', fadeIn: 1, fadeOut: 1 }]).doc;
  const r = applyOps(doc, [{ type: 'clip.split', clipId: 'a', at: 1.5, rightClipId: 'a_b' }]);
  const left = r.doc.clips.find((c) => c.id === 'a');
  const right = r.doc.clips.find((c) => c.id === 'a_b');
  assert(left.fadeOut === 0, '左半不应保留跨切点的淡出，实际 ' + left.fadeOut);
  assert(right.fadeIn === 0, '右半不应保留跨切点的淡入，实际 ' + right.fadeIn);
  assert(left.fadeIn <= left.duration + 1e-9 && right.fadeOut <= right.duration + 1e-9, '两半的淡入淡出必须放得下');
});

// ================================================================== 包络数学 ====

console.log('\n音量包络（线性曲线）');

check('⑩ 线性淡入淡出：首 0、中段 1、尾 0', () => {
  const pts = clipGainPoints(4, { volume: 1, fadeIn: 1, fadeOut: 1 });
  assert(clipGainAt(0, 4, { volume: 1, fadeIn: 1, fadeOut: 1 }) === 0, 't=0 应为 0');
  assert(near(clipGainAt(0.5, 4, { volume: 1, fadeIn: 1, fadeOut: 1 }), 0.5), 't=0.5 应为 0.5（线性）');
  assert(near(clipGainAt(2, 4, { volume: 1, fadeIn: 1, fadeOut: 1 }), 1), '中段应为 1');
  assert(clipGainAt(4, 4, { volume: 1, fadeIn: 1, fadeOut: 1 }) === 0, '尾部应为 0');
  assert(pts.length >= 4, '断点至少 4 个');
});

check('⑪ 无淡入淡出时是常量 volume；muted 全 0', () => {
  const env = clipGainEnvelope(2, { volume: 0.5 }, 100);
  assert(env.length === 200, '包络长度应为 duration×rate');
  assert(env.every((v) => v === 0.5), '无 fade 时应恒为 0.5');
  const muted = clipGainEnvelope(2, { volume: 1, muted: true }, 100);
  assert(muted.every((v) => v === 0), 'muted 时应全 0');
});

check('⑫ 淡入淡出之和超过时长时按比例压缩，首尾仍是 0、中点仍是 volume', () => {
  const opts = { volume: 0.8, fadeIn: 2, fadeOut: 2 };
  assert(clipGainAt(0, 1, opts) === 0, '首应为 0');
  assert(near(clipGainAt(0.5, 1, opts), 0.8), '中点应回到 0.8，实际 ' + clipGainAt(0.5, 1, opts));
  assert(clipGainAt(1, 1, opts) === 0, '尾应为 0');
});

// ==================================================================== WAV 解码 ==

console.log('\nWAV 解码与有效峰值');

const wav = makeWav({ amp: 0.5 });
const decoded = decodeWavMono(wav);

check('⑬ decodeWavMono 解出单声道 PCM 峰值 ≈ 0.5', () => {
  assert(decoded, '应能解出 WAV');
  assert(decoded.sampleRate === 8000 && decoded.channels === 1, '采样率/声道数应为 8000/1');
  assert(near(decoded.frames, 32000), '帧数应为 32000，实际 ' + decoded.frames);
  const peak = measurePeak(decoded.samples);
  assert(near(peak, 0.5, 2e-3), '峰值应约 0.5（16bit 量化误差内），实际 ' + peak);
});

check('⑭ volume=0.5 的有效峰值约为原本的一半（容差 1e-6）', () => {
  const full = effectiveClipPeak(decoded.samples, decoded.sampleRate, { duration: 4, volume: 1 });
  const half = effectiveClipPeak(decoded.samples, decoded.sampleRate, { duration: 4, volume: 0.5 });
  assert(full.peak > 0, '完整音量应有峰值');
  assert(near(half.peak / full.peak, 0.5, 1e-6), '比值应约 0.5，实际 ' + half.peak / full.peak);
  assert(half.method === 'wav-pcm', 'method 应为 wav-pcm');
});

check('⑮ muted=0 / 窗口越界时如实标 unknown 或 0', () => {
  const muted = effectiveClipPeak(decoded.samples, decoded.sampleRate, { duration: 4, volume: 1, muted: true });
  assert(muted.peak === 0, 'muted 时峰值应为 0');
  const out = effectiveClipPeak(decoded.samples, decoded.sampleRate, { duration: 4, sourceIn: 100 });
  assert(out.peak === null, '窗口完全越界时应为 null（不编 0）');
  assert(typeof out.reason === 'string' && out.reason.length > 0, '必须给原因');
});

check('⑯ applyPeakHeadroom：1.6 → 0.99，入参不被修改', () => {
  const a = sine(1, 0.2, 50, 8000);
  const src = [a, a];
  const r = applyPeakHeadroom(src);
  assert(r.trimmed === true, '应判定为需要压');
  assert(near(r.peak, 1, 1e-9), '原始峰值应为 1（正弦幅度 1）');
  assert(r.peakAfterTrim <= EXPORT_PEAK_CEILING + 1e-9, '压后应 ≤ ceiling');
  assert(r.gain > 0 && r.gain < 1, '增益应小于 1');
  const boosted = [Float32Array.from(a, (v) => v * 1.6), Float32Array.from(a, (v) => v * 1.6)];
  const r2 = applyPeakHeadroom(boosted);
  assert(near(r2.peakAfterTrim, EXPORT_PEAK_CEILING, 1e-5), '压后峰值应约等于 0.99，实际 ' + r2.peakAfterTrim);
  assert(src[0][0] === a[0], '原数组必须保持原样');
});

// ================================================================ 混音引擎 ====
//
// 下面这段是一个「会真的出声音」的最小 WebAudio 桩：createGain / createBufferSource /
// setValueAtTime / linearRamp / startRendering 都按规范语义实现，render 时逐采样
// 把「源样本 × 链上每个 GainNode 的自动化值」加起来。只用测试数据，不改源码。

class FakeParam {
  constructor(value = 1) {
    this.value = value;
    this.events = [];
  }
  setValueAtTime(v, t) {
    this.value = v;
    this.events.push({ type: 'set', v, t });
    this.events.sort((a, b) => a.t - b.t);
  }
  linearRampToValueAtTime(v, t) {
    this.events.push({ type: 'ramp', v, t });
    this.events.sort((a, b) => a.t - b.t);
  }
  cancelScheduledValues() {}
  valueAt(t) {
    if (!this.events.length) return this.value;
    const first = this.events[0];
    if (t < first.t) return first.type === 'set' ? first.v : this.value;
    let prev = first;
    for (let i = 1; i < this.events.length; i += 1) {
      const cur = this.events[i];
      if (t < cur.t) {
        if (cur.type === 'set') return prev.v;
        if (cur.t - prev.t <= 1e-12) return cur.v;
        return prev.v + ((cur.v - prev.v) * (t - prev.t)) / (cur.t - prev.t);
      }
      prev = cur;
    }
    return prev.v;
  }
}

class FakeGain {
  constructor() {
    this.gain = new FakeParam(1);
    this.connectedTo = [];
    this.isGain = true;
  }
  connect(node) {
    this.connectedTo.push(node);
    return node;
  }
  disconnect() {
    this.connectedTo = [];
  }
}

class FakeSource {
  constructor() {
    this.playbackRate = new FakeParam(1);
    this.connectedTo = [];
    this.started = null;
  }
  connect(node) {
    this.connectedTo.push(node);
    return node;
  }
  disconnect() {
    this.connectedTo = [];
  }
  start(when, offset, span) {
    this.started = { when, offset, span: span == null ? null : span };
  }
  stop() {}
}

class FakeBuffer {
  constructor({ length, numberOfChannels = 2, sampleRate = 8000, amp = 0.5, freq = 440 }) {
    this.length = length;
    this.numberOfChannels = numberOfChannels;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    const w = (2 * Math.PI * freq) / sampleRate;
    this._channels = [];
    for (let ch = 0; ch < numberOfChannels; ch += 1) {
      const data = new Float32Array(length);
      for (let i = 0; i < length; i += 1) data[i] = Math.sin(i * w) * amp;
      this._channels.push(data);
    }
  }
  getChannelData(i) {
    return this._channels[i] || this._channels[0];
  }
}

const ampByUrl = new Map();

class FakeOfflineContext {
  constructor(channels, length, sampleRate) {
    this.channels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.destination = { connect() {}, disconnect() {}, isDestination: true };
    this.gains = [];
    this.sources = [];
  }
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  decodeAudioData(data) {
    const amp = ampByUrl.has(data && data.url) ? ampByUrl.get(data.url) : 0.5;
    return new FakeBuffer({ length: Math.round(4 * 8000), numberOfChannels: 2, sampleRate: 8000, amp });
  }
  async startRendering() {
    const out = [];
    for (let ch = 0; ch < 2; ch += 1) out.push(new Float32Array(this.length));
    for (const source of this.sources) {
      if (!source.started) continue;
      const buf = source.buffer;
      if (!buf) continue;
      const rate = this.sampleRate;
      const srcRate = buf.sampleRate;
      const speed = source.playbackRate.valueAt(source.started.when);
      const chain = collectChain(source);
      const startIndex = Math.round(source.started.when * rate);
      const span = source.started.span == null ? buf.duration : source.started.span;
      const count = Math.min(this.length - startIndex, Math.round(span * rate));
      for (let i = 0; i < count; i += 1) {
        const t = (startIndex + i) / rate;
        const srcIndex = Math.round(source.started.offset * srcRate + i * (srcRate / rate) * speed);
        if (srcIndex < 0 || srcIndex >= buf.length) continue;
        let gain = 1;
        for (const node of chain) gain *= node.gain.valueAt(t);
        for (let ch = 0; ch < 2; ch += 1) {
          const sample = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1))[srcIndex];
          out[ch][startIndex + i] += sample * gain;
        }
      }
    }
    return {
      length: this.length,
      numberOfChannels: 2,
      sampleRate: this.sampleRate,
      duration: this.length / this.sampleRate,
      getChannelData: (i) => out[i] || out[0],
    };
  }
}

/** 从 source 顺着 connect 链走到 destination，收集所有 GainNode。 */
function collectChain(source) {
  const chain = [];
  let node = source.connectedTo[0];
  const guard = new Set();
  while (node && !guard.has(node)) {
    guard.add(node);
    if (node.isGain) chain.push(node);
    if (node.isDestination) break;
    node = node.connectedTo && node.connectedTo[0];
  }
  return chain;
}

globalThis.OfflineAudioContext = FakeOfflineContext;
globalThis.fetch = async (url) => ({
  ok: true,
  arrayBuffer: async () => {
    const buf = new ArrayBuffer(64);
    buf.url = url;
    return buf;
  },
});

const { createAudioEngine } = await import('../src/client/audio.js');

function seg(overrides) {
  return {
    assetId: 'a',
    url: 'voice-src',
    start: 0,
    duration: 4,
    sourceIn: 0,
    speed: 1,
    volume: 1,
    audioRole: 'voice', // voice 不参与响度归一，链上只剩片段增益节点，便于断言
    ...overrides,
  };
}

async function renderMix(overrides) {
  const engine = createAudioEngine({ getSegments: () => [seg(overrides)] });
  const buffer = await engine.mixdown({ duration: 4, sampleRate: 8000 });
  engine.dispose();
  return buffer;
}

console.log('\n混音引擎（WebAudio 桩，逐采样渲染）');

await checkAsync('⑰ volume=0.5 的混音采样峰值 ≈ volume=1 的一半（容差 1e-6）', async () => {
  ampByUrl.set('voice-src', 0.5);
  const full = await renderMix({ volume: 1 });
  const half = await renderMix({ volume: 0.5 });
  const pFull = measurePeak(full.getChannelData(0));
  const pHalf = measurePeak(half.getChannelData(0));
  assert(pFull > 0.4, 'volume=1 时应有明显峰值，实际 ' + pFull);
  assert(near(pHalf / pFull, 0.5, 1e-6), '比值应约 0.5，实际 ' + pHalf / pFull);
});

await checkAsync('⑱ fadeIn/fadeOut 包络：首采样 0、中段与无淡入时相同、尾采样趋近 0', async () => {
  const plain = await renderMix({ volume: 1 });
  const faded = await renderMix({ volume: 1, fadeIn: 1, fadeOut: 1 });
  const a = plain.getChannelData(0);
  const b = faded.getChannelData(0);
  assert(b[0] === 0, '首采样应为 0，实际 ' + b[0]);
  const midIndex = Math.round(2 * 8000);
  assert(near(b[midIndex], a[midIndex], 1e-6), '中段增益应为 1（与无淡入时同值）');
  const last = Math.abs(b[b.length - 1]);
  assert(last < 1e-3, '尾采样应趋近 0，实际 ' + last);
  // 淡入段中间的增益应更小（1/4 处 = 0.25）
  const quarter = Math.round(0.25 * 8000);
  assert(Math.abs(b[quarter]) < Math.abs(a[quarter]) + 1e-9, '淡入段应被压低');
});

await checkAsync('⑲ muted=true 的片段在混音里是静音', async () => {
  const buffer = await renderMix({ volume: 1, muted: true });
  assert(measurePeak(buffer.getChannelData(0)) === 0, '静音片段不应产出任何样本');
});

await checkAsync('⑳ volume>1（1.5）会被混音如实放大', async () => {
  const full = await renderMix({ volume: 1 });
  const loud = await renderMix({ volume: 1.5 });
  const ratio = measurePeak(loud.getChannelData(0)) / measurePeak(full.getChannelData(0));
  assert(near(ratio, 1.5, 1e-6), '比值应约 1.5，实际 ' + ratio);
});

// ================================================================== 导出端 ====

console.log('\n导出端（prepareAudio：峰值 / headroom）');

class FakeAudioEncoder {
  static async isConfigSupported(config) {
    return { supported: true, config };
  }
}
class FakeAudioData {}
globalThis.AudioEncoder = FakeAudioEncoder;
globalThis.AudioData = FakeAudioData;

const EXPORT_PLAN = { range: { start: 0 }, duration: 4 };

await checkAsync('㉑ 导出音轨：volume=1 vs 0.5 的峰值比 ≈ 0.5', async () => {
  ampByUrl.set('voice-src', 0.5);
  const full = await renderMix({ volume: 1 });
  const half = await renderMix({ volume: 0.5 });
  const pf = await prepareAudio(full, 'aac', EXPORT_PLAN);
  const ph = await prepareAudio(half, 'aac', EXPORT_PLAN);
  assert(pf.plan && ph.plan, '两条都应准备好');
  assert(pf.plan.trimmed === false, '0.5 峰值不需要压');
  assert(near(ph.plan.peak / pf.plan.peak, 0.5, 1e-6), '导出峰值比应约 0.5，实际 ' + ph.plan.peak / pf.plan.peak);
});

await checkAsync('㉒ 峰值 > 1 时整体压到 ceiling，并如实报告（不静默）', async () => {
  const loud = new FakeBuffer({ length: 4 * 8000, numberOfChannels: 2, sampleRate: 8000, amp: 1.4 });
  const before = measurePeak(loud.getChannelData(0));
  const prepared = await prepareAudio(loud, 'aac', EXPORT_PLAN);
  assert(prepared.plan, '应准备好');
  assert(near(prepared.plan.peak, before, 1e-9), 'peak 应是压之前的值，实际 ' + prepared.plan.peak);
  assert(prepared.plan.trimmed === true, '应标记 trimmed');
  assert(prepared.plan.peakAfterTrim <= EXPORT_PEAK_CEILING + 1e-9, '压后峰值应 ≤ ceiling');
  assert(prepared.warning === 'AUDIO_PEAK_TRIMMED', 'warning 应为 AUDIO_PEAK_TRIMMED，实际 ' + prepared.warning);
  assert(near(measurePeak(prepared.plan.source[0]), prepared.plan.peakAfterTrim, 1e-3), '送进编码器的样本峰值应与报告一致');
  assert(near(measurePeak(loud.getChannelData(0)), before, 1e-9), '调用方的 AudioBuffer 不应被修改');
});

await checkAsync('㉓ 峰值等于 1.0 不再额外压（ceiling 内）', async () => {
  const buf = new FakeBuffer({ length: 4 * 8000, numberOfChannels: 2, sampleRate: 8000, amp: 0.95 });
  const prepared = await prepareAudio(buf, 'aac', EXPORT_PLAN);
  assert(prepared.plan.trimmed === false, '0.95 不应被压');
  assert(prepared.warning === null, '不应有 warning');
});

// ============================================================ video_audio_mix ===

console.log('\nvideo_audio_mix（只读报告）');

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-audio-vol-'));
await fs.mkdir(path.join(tmpRoot, 'assets'), { recursive: true });
const wavBytes = makeWav({ amp: 0.5, seconds: 4 });
await fs.writeFile(path.join(tmpRoot, 'assets', 'beep.wav'), wavBytes);

const store = new ProjectStore();
const projectDoc = await store.open(tmpRoot, 's-tool');
const applyStore = async (ops) => {
  const preview = store.preview(projectDoc.projectId, 's-tool', undefined, ops);
  return store.applyPreview(preview.previewId, 's-tool');
};

const addAssetOp = {
  type: 'asset.add',
  assetId: 'ast_wav',
  relPath: 'assets/beep.wav',
  name: 'beep.wav',
  size: wavBytes.length,
};
await applyStore([
  addAssetOp,
  {
    type: 'asset.add',
    assetId: 'ast_missing',
    relPath: 'assets/missing.wav',
    name: 'missing.wav',
    size: 1234,
  },
  { type: 'track.add', trackId: 'a2', kind: 'audio', name: '音乐' },
]);

const music = await applyStore([
  {
    type: 'clip.insert',
    clipId: 'c_music',
    trackId: 'a1',
    clipType: 'media',
    assetId: 'ast_wav',
    start: 0,
    duration: 4,
    volume: 0.5,
  },
]);
await applyStore([{ type: 'clip.set_property', clipId: 'c_music', property: 'audioRole', value: 'music' }]);
await applyStore([{ type: 'clip.setAudio', clipId: 'c_music', volume: 0.5 }]);
const voice = await applyStore([
  {
    type: 'clip.insert',
    clipId: 'c_voice',
    trackId: 'a2',
    clipType: 'media',
    assetId: 'ast_wav',
    start: 1,
    duration: 2,
    volume: 1,
  },
]);
await applyStore([{ type: 'clip.setAudio', clipId: 'c_voice', fadeIn: 0.1, fadeOut: 0.1 }]);
await applyStore([{ type: 'clip.set_property', clipId: 'c_voice', property: 'audioRole', value: 'voice' }]);
await applyStore([
  {
    type: 'clip.insert',
    clipId: 'c_missing',
    trackId: 'a1',
    clipType: 'media',
    assetId: 'ast_missing',
    start: 10,
    duration: 1,
  },
]);

const tools = Object.fromEntries(videoTools({ store, samples: null }).map((t) => [t.name, t]));

await checkAsync('㉔ 工具在注册表里，且调用前后 revision 不变（只读）', async () => {
  assert(tools.video_audio_mix && typeof tools.video_audio_mix.execute === 'function', '应注册 video_audio_mix');
  const before = store.get(projectDoc.projectId).doc.revision;
  const result = await tools.video_audio_mix.execute({}, { agent: { id: 's-tool' } });
  const after = store.get(projectDoc.projectId).doc.revision;
  assert(before === after, `只读工具不应改 revision（${before} → ${after}）`);
  assert(result.projectId === projectDoc.projectId, 'projectId 应一致');
});

let report = null;
await checkAsync('㉕ 输出与时间线一致：三条音频片段、字段齐全、无 undefined/NaN', async () => {
  report = await tools.video_audio_mix.execute({}, { agent: { id: 's-tool' } });
  assert(isLosslessJson(report), '必须是无损 JSON');
  const ids = report.clips.map((c) => c.clipId);
  assert(ids.includes('c_music') && ids.includes('c_voice') && ids.includes('c_missing'), '应列出三条片段，实际 ' + ids);
  assert(report.clips.length === 3, '只应列音频轨上的片段，实际 ' + report.clips.length);
  const musicClip = report.clips.find((c) => c.clipId === 'c_music');
  assert(musicClip.volume === 0.5, 'volume 应与时间线一致，实际 ' + musicClip.volume);
  assert(musicClip.audioRole === 'music', 'audioRole 应透传');
  assert(musicClip.start === 0 && musicClip.duration === 4, 'start/duration 应一致');
  assert(report.audioTracks.some((t) => t.trackId === 'a1') && report.audioTracks.some((t) => t.trackId === 'a2'), '应列出两条音频轨');
});

await checkAsync('㉖ WAV 片段的 effectivePeak = 素材峰值 × volume（0.5 × 0.5 = 0.25）', async () => {
  const musicClip = report.clips.find((c) => c.clipId === 'c_music');
  assert(musicClip.peakStatus === 'measured', 'WAV 应能测出峰值');
  assert(musicClip.peakMethod === 'wav-pcm', '方法应为 wav-pcm，实际 ' + musicClip.peakMethod);
  assert(near(musicClip.sourcePeak, 0.5, 2e-3), '素材峰值应约 0.5，实际 ' + musicClip.sourcePeak);
  assert(near(musicClip.effectivePeak, 0.25, 2e-3), '有效峰值应约 0.25，实际 ' + musicClip.effectivePeak);
  assert(musicClip.unknownReason === null, '测到了就不该有 unknownReason');
});

await checkAsync('㉗ 配乐与口播重叠区间给出量级差（约 -6dB），并标明是估算', async () => {
  const overlap = report.overlaps.find((o) => o.musicClipId === 'c_music' && o.voiceClipId === 'c_voice');
  assert(overlap, '应识别出配乐与口播的重叠');
  assert(overlap.start === 1 && overlap.end === 3, '重叠区间应为 1..3，实际 ' + JSON.stringify(overlap));
  assert(near(overlap.approxMarginDb, -6, 0.2), '配乐低于口播约 6dB，实际 ' + overlap.approxMarginDb);
  assert(report.warnings.some((w) => w.code === 'ESTIMATE_NOT_BUS'), '必须声明这是估算、不是总线实测');
});

await checkAsync('㉘ 拿不到素材时标 unknown 并说明原因，不编数字', async () => {
  const missing = report.clips.find((c) => c.clipId === 'c_missing');
  assert(missing.peakStatus === 'unknown', '缺素材应为 unknown');
  assert(missing.sourcePeak === null && missing.effectivePeak === null, 'unknown 时不得给数字');
  assert(typeof missing.unknownReason === 'string' && missing.unknownReason.length > 0, '必须写原因');
  assert(report.warnings.some((w) => w.code === 'PEAK_UNKNOWN'), '应有一条 PEAK_UNKNOWN 警告');
});

check('㉙ parseVolumedetect 解析 max_volume（含 -inf）', () => {
  assert(near(parseVolumedetect('[Parsed_volumedetect_0 @ 1] max_volume: -6.0 dB'), 0.5011872336, 1e-9), '-6dB ≈ 0.501');
  assert(parseVolumedetect('max_volume: -inf dB') === 0, '-inf 应为 0');
  assert(parseVolumedetect('没有这一行') === null, '没有 max_volume 应返回 null');
});

// ====================================================== video_sound_insert ====

console.log('\nvideo_sound_insert 参数');

const libRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-audio-lib-'));
await fs.mkdir(path.join(libRoot, 'kenney-test', 'ui'), { recursive: true });
await fs.writeFile(path.join(libRoot, 'kenney-test', 'ui', 'beep.wav'), makeWav({ seconds: 2, amp: 0.6 }));
await fs.writeFile(
  path.join(libRoot, 'kenney-test', 'ui', 'beep.wav.json'),
  JSON.stringify({ title: 'Beep', tags: ['click'], category: 'ui', license: 'CC0' }),
);
const savedLib = process.env.DSH_SOUND_LIB;
process.env.DSH_SOUND_LIB = libRoot;
const libEntries = await scanLocal();
const beepEntry = libEntries.find((e) => e.providerId.endsWith('ui/beep.wav'));
assert(beepEntry, '临时声音库应扫描到 beep.wav，实际 ' + JSON.stringify(libEntries.map((e) => e.providerId)));

await checkAsync('㉚ video_sound_insert(volume:0.4) 写进去的片段 volume 就是 0.4', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-audio-proj2-'));
  const st = new ProjectStore();
  const doc = await st.open(root, 's-insert');
  const res = await insertSound({
    store: st,
    sessionId: 's-insert',
    projectId: doc.projectId,
    entryId: beepEntry.id,
    start: 0,
    volume: 0.4,
  });
  const clip = st.get(doc.projectId).doc.clips.find((c) => c.id === res.clipId);
  assert(clip, '应插入片段');
  assert(clip.volume === 0.4, 'volume 应为 0.4，实际 ' + clip.volume);
  assert(res.volume === 0.4, '返回值也应带 volume');
  assert(clip.fadeIn === 0.05 && clip.fadeOut === 0.15, '默认淡入淡出应保留，实际 ' + clip.fadeIn + '/' + clip.fadeOut);
});

await checkAsync('㉛ video_sound_insert 的 fade 超过时长时直接拒绝，不静默夹紧', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-audio-proj3-'));
  const st = new ProjectStore();
  const doc = await st.open(root, 's-insert2');
  let threw = null;
  try {
    await insertSound({
      store: st,
      sessionId: 's-insert2',
      projectId: doc.projectId,
      entryId: beepEntry.id,
      start: 0,
      fadeIn: 5,
      fadeOut: 5,
    });
  } catch (e) {
    threw = e;
  }
  assert(threw, '应抛错');
  assert(threw.code === 'INVALID_OP' || threw.code === 'INVALID_ARG', '错误码应为 INVALID_OP/INVALID_ARG，实际 ' + threw.code);
  assert(st.get(doc.projectId).doc.clips.length === 0, '失败事务不能留下片段');
});

if (savedLib === undefined) delete process.env.DSH_SOUND_LIB;
else process.env.DSH_SOUND_LIB = savedLib;

// ==================================================================== 收尾 ====

await fs.rm(tmpRoot, { recursive: true, force: true });
await fs.rm(libRoot, { recursive: true, force: true });

if (fail > 0) {
  console.log(`\n音量测试：${pass} 通过 / ${fail} 失败`);
  process.exit(1);
}
console.log(`\n音量测试：${pass} 通过 / ${fail} 失败`);
