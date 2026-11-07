/**
 * 混音纪律的测试：ducking 包络 + 响度归一 + 两条纯函数的边界。
 *
 *   node scripts/audio-mix-test.mjs
 *
 * 前半段全是纯函数（src/audio-mix.mjs，Node 里直接跑）；
 * 后半段用最小的 WebAudio 桩验证 src/client/audio.js 真的把包络接上了 ——
 * 光有数学不够，得证明「标了 music 的片段会被压、没标的不会」。
 *
 * 所有桩只存在于本文件，不改动源码。
 */

import {
  computeDuckEnvelope,
  rmsNormalizeGain,
  integratedLoudnessApprox,
  rootMeanSquare,
  dbToGain,
  gainToDb,
  DUCK_DEFAULTS,
} from '../src/audio-mix.mjs';

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

function near(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

function allOnes(env) {
  for (let i = 0; i < env.length; i += 1) if (env[i] !== 1) return false;
  return true;
}

/** 采样一段正弦：amp 是峰值，rate 默认 48k。 */
function sine(amp, seconds, freq = 440, rate = 48000) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freq) / rate;
  for (let i = 0; i < n; i += 1) out[i] = Math.sin(i * w) * amp;
  return out;
}

const DUCK_12 = dbToGain(-12); // 0.251188…

// ============================================================ 纯函数部分 ====

console.log('混音纯函数');

check('① 没有 voice 时包络全 1（music 再多也不动）', () => {
  const env = computeDuckEnvelope({
    duration: 4,
    sampleRate: 100,
    voiceSegments: [],
    musicSegments: [{ start: 0, end: 4 }],
  });
  assert(env.length === 400, '长度应为 duration×sampleRate，实际 ' + env.length);
  assert(allOnes(env), '没有 voice 时不允许出现任何衰减');
});

check('② voice 与 music 的重叠区间被压到 -12dB，区间外仍为 1', () => {
  const env = computeDuckEnvelope({
    duration: 4,
    sampleRate: 100,
    voiceSegments: [{ start: 1, end: 2 }],
    musicSegments: [{ start: 0, end: 4 }],
  });
  assert(near(env[50], 1), '0.5s 处不该被压');
  assert(near(env[150], DUCK_12, 1e-6), '1.5s 处应到 -12dB，实际 ' + env[150]);
  assert(near(env[350], 1), '3.5s 处应恢复 1');
  // 边界外一格
  assert(env[99] > env[108], 'voice 起点前应高于压下去的区间');
});

check('③ attack 单调下降、release 单调回升（不抽气）', () => {
  const rate = 1000;
  const env = computeDuckEnvelope({
    duration: 3,
    sampleRate: rate,
    voiceSegments: [{ start: 1, end: 2 }],
    musicSegments: [{ start: 0, end: 3 }],
    attack: 0.08,
    release: 0.25,
  });
  const attack0 = 1000;
  const attack1 = Math.round((1 + 0.08) * rate);
  for (let i = attack0 + 1; i <= attack1; i += 1) {
    assert(env[i] <= env[i - 1] + 1e-9, 'attack 段必须单调不增 @' + i);
  }
  assert(env[attack0] === 1, 'attack 起点应为 1');
  assert(near(env[attack1], DUCK_12, 1e-6), 'attack 终点应到 duck 电平');

  const relStart = Math.round((2 - 0.25) * rate);
  const relEnd = 2 * rate;
  for (let i = relStart + 1; i < relEnd; i += 1) {
    assert(env[i] >= env[i - 1] - 1e-9, 'release 段必须单调不减 @' + i);
  }
  assert(near(env[relStart], DUCK_12, 1e-6), 'release 起点仍是 duck 电平');
  assert(env[relEnd] === 1, 'release 结束后回到 1');
});

check('④ maxDuckDb 生效：-6dB 时中间值是 0.501', () => {
  const env = computeDuckEnvelope({
    duration: 2,
    sampleRate: 100,
    voiceSegments: [{ start: 0.5, end: 1.5 }],
    musicSegments: [{ start: 0, end: 2 }],
    maxDuckDb: -6,
  });
  assert(near(env[100], dbToGain(-6), 1e-6), '-6dB 应换算成 0.5012，实际 ' + env[100]);
  // 正的 maxDuckDb 会被夹成 0dB（只降不升）
  const flat = computeDuckEnvelope({
    duration: 2,
    sampleRate: 100,
    voiceSegments: [{ start: 0.5, end: 1.5 }],
    musicSegments: [{ start: 0, end: 2 }],
    maxDuckDb: 6,
  });
  assert(allOnes(flat), 'maxDuckDb > 0 必须被夹到 0dB，不能变成放大');
});

check('⑤ RMS 归一让两个不同响度的片段落到同一档', () => {
  const quiet = sine(0.05, 0.5);
  const loud = sine(0.2, 0.5);
  const gq = rmsNormalizeGain(quiet, 0.1);
  const gl = rmsNormalizeGain(loud, 0.1);
  assert(gq > 1 && gl < 1, '轻的要抬、响的要压（' + gq + ' / ' + gl + '）');
  const rq = rootMeanSquare(quiet) * gq;
  const rl = rootMeanSquare(loud) * gl;
  assert(near(rq, 0.1, 1e-6), '归一后 RMS 应为 0.1，实际 ' + rq);
  assert(near(rl, 0.1, 1e-6), '归一后 RMS 应为 0.1，实际 ' + rl);
  assert(near(rq, rl, 1e-6), '两条素材归一后应在同一响度');
});

check('⑥ 增益被 minGain / maxGain 夹住', () => {
  const tiny = sine(0.001, 0.2);
  const huge = sine(1, 0.2);
  assert(near(rmsNormalizeGain(tiny, 0.1), 4), '极轻的应夹到 maxGain=4');
  assert(near(rmsNormalizeGain(huge, 0.1), 0.25), '极响的应夹到 minGain=0.25');
  assert(near(rmsNormalizeGain(tiny, 0.1, { minGain: 0.5, maxGain: 2 }), 2), '自定义上限应生效');
});

check('⑦ LUFS 近似：0dB 正弦比半幅正弦高约 6dB', () => {
  const full = sine(1, 2);
  const half = sine(0.5, 2);
  const a = integratedLoudnessApprox(full, 48000);
  const b = integratedLoudnessApprox(half, 48000);
  assert(Number.isFinite(a) && Number.isFinite(b), '两条都应给出有限值');
  assert(near(a - b, 6.0206, 0.05), '差值应约 6dB，实际 ' + (a - b));
  // 数值本身不是标准 LUFS，只要求方向和量级正确
  assert(a > -6 && a < -2, '满幅正弦应在 -3.7 附近，实际 ' + a);
});

check('⑧ 空输入 / 全零输入不崩，且不放大', () => {
  assert(computeDuckEnvelope().length === 0, '无参数应返回空包络');
  assert(computeDuckEnvelope({ duration: 0, sampleRate: 48000 }).length === 0, '时长 0 应返回空包络');
  assert(computeDuckEnvelope({ duration: -3, sampleRate: 48000 }).length === 0, '负时长应返回空包络');
  assert(computeDuckEnvelope({ duration: 1, sampleRate: 0 }).length === 0, 'sampleRate 0 应返回空包络');
  assert(rmsNormalizeGain(null) === 1, 'null 应返回 1');
  assert(rmsNormalizeGain(new Float32Array(0)) === 1, '空数组应返回 1');
  assert(rmsNormalizeGain(new Float32Array(100)) === 1, '全零不放大');
  assert(rootMeanSquare(null) === 0, '空输入 RMS 应为 0');
  assert(integratedLoudnessApprox([], 48000) === -Infinity, '空输入响度应为 -Infinity');
  assert(integratedLoudnessApprox(new Float32Array(4800), 48000) === -Infinity, '静音没有响度');
  assert(integratedLoudnessApprox(sine(0.5, 1), 0) === -Infinity, '采样率非法应返回 -Infinity');
});

check('⑨ 包络长度与 sampleRate 匹配（含非整数时长）', () => {
  const cases = [
    [2, 50, 100],
    [2, 44100, 88200],
    [0.333, 100, 33],
    [1.5, 10, 15],
  ];
  for (const [duration, rate, expected] of cases) {
    const env = computeDuckEnvelope({ duration, sampleRate: rate });
    assert(env.length === expected, `${duration}s @ ${rate}Hz 应为 ${expected}，实际 ${env.length}`);
  }
});

check('⑩ 只有 music 或只有 voice 时都不做任何事', () => {
  const musicOnly = computeDuckEnvelope({
    duration: 3,
    sampleRate: 100,
    voiceSegments: [],
    musicSegments: [{ start: 0, end: 3 }],
  });
  assert(allOnes(musicOnly), '没有 voice 应全 1');
  const voiceOnly = computeDuckEnvelope({
    duration: 3,
    sampleRate: 100,
    voiceSegments: [{ start: 0, end: 3 }],
    musicSegments: [],
  });
  assert(allOnes(voiceOnly), '没有 music 应全 1');
  const apart = computeDuckEnvelope({
    duration: 4,
    sampleRate: 100,
    voiceSegments: [{ start: 0, end: 1 }],
    musicSegments: [{ start: 2, end: 4 }],
  });
  assert(allOnes(apart), '不重叠应全 1');
});

check('⑪ 短重叠（短于 attack+release）按比例压缩，两端仍回到 1', () => {
  const env = computeDuckEnvelope({
    duration: 2,
    sampleRate: 1000,
    voiceSegments: [{ start: 0.5, end: 0.6 }], // 100ms，短于 80+250
    musicSegments: [{ start: 0, end: 2 }],
  });
  assert(env[499] === 1, '区间前应为 1');
  assert(env[600] === 1, '区间后应为 1');
  const min = Math.min(...env.subarray(500, 600));
  assert(near(min, DUCK_12, 0.02), '短区间最低点也应接近 -12dB，实际 ' + min);
});

check('⑫ 相邻 voice 区间合并，不在缝隙里弹回 1', () => {
  const env = computeDuckEnvelope({
    duration: 3,
    sampleRate: 100,
    voiceSegments: [
      { start: 0.5, end: 1.0 },
      { start: 1.0, end: 1.5 },
    ],
    musicSegments: [{ start: 0, end: 3 }],
  });
  assert(near(env[75], DUCK_12, 1e-6), '第一个区间内应被压');
  assert(near(env[100], DUCK_12, 1e-6), '接缝处（1.0s）不应回弹');
  assert(near(env[125], DUCK_12, 1e-6), '第二个区间的中段应保持被压');
  // 合并不是把两条曲线简单相加：整个 [0.5,1.5] 内不允许出现未压的采样
  for (let i = 80; i < 120; i += 1) assert(env[i] <= 0.9, '合并区间内不应回到 1 @' + i);
});

check('⑬ 多声道（声道数组）与单声道的 RMS / 响度一致', () => {
  const mono = sine(0.3, 0.5);
  const stereo = [mono, mono];
  assert(near(rootMeanSquare(stereo), rootMeanSquare(mono), 1e-9), '两声道同相时 RMS 应一致');
  assert(
    near(integratedLoudnessApprox(stereo, 48000), integratedLoudnessApprox(mono, 48000), 1e-4),
    '两声道同相时响度应一致',
  );
  const right = new Float32Array(mono.length).fill(0);
  assert(near(rootMeanSquare([mono, right]), rootMeanSquare(mono) / Math.SQRT2, 1e-3), '只响一边应低约 3dB');
});

check('⑭ 默认参数与常量自洽（-12dB / 80ms / 250ms）', () => {
  assert(near(dbToGain(-12), DUCK_12, 1e-9), 'dbToGain(-12) 应为 0.2512');
  assert(near(gainToDb(DUCK_12), -12, 1e-9), 'gainToDb 应回到 -12');
  assert(DUCK_DEFAULTS.maxDuckDb === -12 && DUCK_DEFAULTS.attack === 0.08 && DUCK_DEFAULTS.release === 0.25, '默认值应稳定');
});

// ============================================================ 引擎接线 ====

console.log('\n引擎接线（WebAudio 桩）');

class FakeParam {
  constructor(value) {
    this.value = value;
    this.events = [];
  }
  setValueAtTime(v, t) {
    this.value = v;
    this.events.push({ type: 'set', v, t });
  }
  linearRampToValueAtTime(v, t) {
    this.value = v;
    this.events.push({ type: 'ramp', v, t });
  }
  cancelScheduledValues() {}
}

class FakeGain {
  constructor() {
    this.gain = new FakeParam(1);
    this.connectedTo = [];
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
    this.started = { when, offset, span };
  }
  stop() {}
}

class FakeBuffer {
  constructor({ length, numberOfChannels = 2, sampleRate = 48000, amp = Math.SQRT2 * 0.1 }) {
    this.length = length;
    this.numberOfChannels = numberOfChannels;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    const w = (2 * Math.PI * 440) / sampleRate;
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

const ampByUrl = { voice: Math.SQRT2 * 0.1, music: Math.SQRT2 * 0.1, quiet: 0.05, loud: 0.2 };
const contexts = [];

class FakeOfflineContext {
  constructor(channels, length, sampleRate) {
    this.channelsCount = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.destination = { connect() {}, disconnect() {} };
    this.gains = [];
    this.sources = [];
    contexts.push(this);
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
    const amp = ampByUrl[data && data.url] == null ? Math.SQRT2 * 0.1 : ampByUrl[data.url];
    return new FakeBuffer({ length: 48000 * 4, numberOfChannels: 2, sampleRate: 48000, amp });
  }
  async startRendering() {
    return new FakeBuffer({ length: this.length, numberOfChannels: 2, sampleRate: this.sampleRate, amp: 0 });
  }
}

globalThis.OfflineAudioContext = FakeOfflineContext;
globalThis.fetch = async (url) => ({
  ok: true,
  arrayBuffer: async () => {
    const buf = new ArrayBuffer(64);
    buf.url = url; // 桩里带出 url，用来决定振幅
    return buf;
  },
});

/** 找出「被压过」的增益节点：事件里出现过 < 0.9 的值 */
function duckGains(ctx) {
  return ctx.gains.filter((g) => g.gain.events.some((e) => e.v < 0.9));
}

const VOICE_SEG = {
  assetId: 'v',
  url: 'voice',
  start: 0,
  duration: 2,
  sourceIn: 0,
  speed: 1,
  volume: 1,
  audioRole: 'voice',
};
const MUSIC_SEG = {
  assetId: 'm',
  url: 'music',
  start: 0,
  duration: 4,
  sourceIn: 0,
  speed: 1,
  volume: 1,
  audioRole: 'music',
};

const { createAudioEngine } = await import('../src/client/audio.js');

await checkAsync('⑮ 标了 music 的片段在 voice 覆盖区间被压到 -12dB', async () => {
  const engine = createAudioEngine({ getSegments: () => [VOICE_SEG, MUSIC_SEG] });
  const before = contexts.length;
  await engine.mixdown({ duration: 4, sampleRate: 8000 });
  const ctx = contexts.slice(before).find((c) => c.length === 32000);
  assert(ctx, '应创建 4s × 8000 的离线上下文');
  const ducks = duckGains(ctx);
  assert(ducks.length === 1, '应当只有一个片段被压，实际 ' + ducks.length);
  const min = Math.min(...ducks[0].gain.events.map((e) => e.v));
  assert(near(min, DUCK_12, 1e-5), '被压到 -12dB（0.2512），实际 ' + min);
  engine.dispose();
});

await checkAsync('⑯ 未标角色的片段（按 sfx）不参与 ducking', async () => {
  const sfx = { ...MUSIC_SEG, url: 'music', audioRole: undefined };
  const engine = createAudioEngine({ getSegments: () => [VOICE_SEG, sfx] });
  const before = contexts.length;
  await engine.mixdown({ duration: 4, sampleRate: 8000 });
  const ctx = contexts.slice(before).find((c) => c.length === 32000);
  assert(ctx, '应创建离线上下文');
  assert(duckGains(ctx).length === 0, '未标 music 的片段不应被压');
  engine.dispose();
});

await checkAsync('⑰ 响度归一真的接上了：轻的抬、响的压，且只算一次', async () => {
  const quiet = { ...MUSIC_SEG, assetId: 'q', url: 'quiet', start: 0, duration: 1 };
  const loud = { ...MUSIC_SEG, assetId: 'l', url: 'loud', start: 1, duration: 1 };
  const engine = createAudioEngine({ getSegments: () => [quiet, loud] });
  const before = contexts.length;
  await engine.mixdown({ duration: 2, sampleRate: 8000 });
  const ctx = contexts.slice(before).find((c) => c.length === 16000);
  assert(ctx, '应创建离线上下文');

  const constants = ctx.gains
    .map((g) => g.gain.events)
    .filter((events) => events.length === 1 && events[0].type === 'set' && Math.abs(events[0].v - 1) > 1e-3)
    .map((events) => events[0].v)
    .sort((a, b) => a - b);
  assert(constants.length === 2, '两个片段各应有一个归一增益，实际 ' + constants.length);
  assert(near(constants[1], 0.1 / (0.05 / Math.SQRT2), 1e-3), '轻的应被抬到约 2.83，实际 ' + constants[1]);
  assert(near(constants[0], 0.1 / (0.2 / Math.SQRT2), 1e-3), '响的应被压到约 0.707，实际 ' + constants[0]);
  engine.dispose();
});

// ------------------------------------------------------------------ 收尾 ----

if (fail > 0) {
  console.log('\n混音测试：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(1);
}
console.log('\n混音测试：' + pass + ' 通过 / ' + fail + ' 失败');
