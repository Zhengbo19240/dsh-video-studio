/**
 * 音频引擎的结构性测试（Node 里没有 WebAudio）。
 *
 *   node scripts/audio-test.mjs
 *
 * 桩 AudioContext / OfflineAudioContext / GainNode / AudioBufferSourceNode，
 * 记录调度参数，覆盖：play 对齐（含中途起播）、倍速、淡入淡出、muted、
 * mixdown（空/非空）、解码失败不崩、重复 play 不叠音、dispose。
 *
 * 所有桩只存在于本文件，不改动源码。
 */

import { createAudioEngine } from '../src/client/audio.js';

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

// ------------------------------------------------------------------- 桩 ----

const registry = { contexts: [], offline: [], sources: [] };

class FakeAudioParam {
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
  cancelScheduledValues(t) {
    this.events.push({ type: 'cancel', t });
  }
}

class FakeGainNode {
  constructor() {
    this.gain = new FakeAudioParam(1);
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

class FakeAudioBuffer {
  constructor({ length, numberOfChannels = 2, sampleRate = 44100 }) {
    this.length = length;
    this.numberOfChannels = numberOfChannels;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(i) {
    return this._channels[i] || this._channels[0];
  }
}

class FakeBufferSourceNode {
  constructor(ctx) {
    this.ctx = ctx;
    this.buffer = null;
    this.playbackRate = new FakeAudioParam(1);
    this.connectedTo = [];
    this.started = null;
    this.stopped = false;
    registry.sources.push(this);
  }
  connect(node) {
    this.connectedTo.push(node);
    return node;
  }
  disconnect() {
    this.connectedTo = [];
  }
  start(when, offset, duration) {
    this.started = { when, offset, duration };
  }
  stop() {
    this.stopped = true;
  }
}

class FakeBaseContext {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.destination = { connect() {}, disconnect() {} };
    this.createdGains = [];
    this.createdSources = [];
  }
  createGain() {
    const gain = new FakeGainNode();
    this.createdGains.push(gain);
    return gain;
  }
  createBufferSource() {
    const src = new FakeBufferSourceNode(this);
    this.createdSources.push(src);
    return src;
  }
  // 字节数 8 = 坏音频：同步抛错，验证引擎不崩
  decodeAudioData(data) {
    if (data.byteLength === 8) throw new Error('mock 解码失败');
    const buffer = new FakeAudioBuffer({ length: 44100 * 30, numberOfChannels: 2, sampleRate: 44100 });
    buffer.tag = data.byteLength;
    return buffer;
  }
}

class FakeAudioContext extends FakeBaseContext {
  constructor() {
    super(48000);
    this.state = 'running';
    this.currentTime = 0;
    this.closed = false;
    this.resumeCalls = 0;
    registry.contexts.push(this);
  }
  async resume() {
    this.resumeCalls += 1;
    this.state = 'running';
  }
  async close() {
    this.closed = true;
    this.state = 'closed';
  }
}

class FakeOfflineAudioContext extends FakeBaseContext {
  constructor(channels, length, sampleRate) {
    super(sampleRate);
    this.channels = channels;
    this.length = length;
    this.state = 'suspended';
    registry.offline.push(this);
  }
  async startRendering() {
    const buffer = new FakeAudioBuffer({
      length: this.length,
      numberOfChannels: this.channels,
      sampleRate: this.sampleRate,
    });
    buffer.getChannelData(0)[0] = 0.25; // 渲染结果标记，用来区分静音兜底
    this.state = 'closed';
    return buffer;
  }
}

// url -> 返回字节数（8 触发解码失败）
const SIZES = { a: 101, b: 102, d: 103, e: 105, f: 104, bad: 8 };
const fetchLog = [];

globalThis.AudioContext = FakeAudioContext;
globalThis.OfflineAudioContext = FakeOfflineAudioContext;
globalThis.AudioBuffer = FakeAudioBuffer;
globalThis.fetch = async (url) => {
  fetchLog.push(url);
  const size = SIZES[url] === undefined ? 150 : SIZES[url];
  return { ok: true, arrayBuffer: async () => new ArrayBuffer(size) };
};

function sourcesSince(mark) {
  return registry.sources.slice(mark);
}

function byTag(list, tag) {
  return list.find((s) => s.buffer && s.buffer.tag === tag) || null;
}

function allZero(buffer) {
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i += 1) if (data[i] !== 0) return false;
  }
  return true;
}

// 常用素材：A 从 0 开始 10 秒（sourceIn 2），B 从 6 开始 4 秒、2 倍速
const SEG_A = { assetId: 'a', url: 'a', start: 0, duration: 10, sourceIn: 2, speed: 1, volume: 1 };
const SEG_B = { assetId: 'b', url: 'b', start: 6, duration: 4, sourceIn: 0, speed: 2, volume: 0.5 };

// ------------------------------------------------------------------ 测试 ----

console.log('音频引擎');

await checkAsync('① play(0) 的 offset/when 正确；中途起播按 fromT 偏移', async () => {
  const engine = createAudioEngine({ getSegments: () => [SEG_A, SEG_B] });
  const mark = registry.sources.length;
  await engine.play(0);

  const list = sourcesSince(mark);
  const a = byTag(list, 101);
  const b = byTag(list, 102);
  assert(a && b, '两个片段都应被调度');
  const base = Math.min(a.started.when, b.started.when);
  assert(near(a.started.when, base), 'A 从 fromT 处起播');
  assert(near(a.started.offset, 2), 'A 的 offset 应等于 sourceIn（实际 ' + a.started.offset + '）');
  assert(near(a.started.duration, 10), 'A 的 duration 应为剩余源内秒');
  assert(near(b.started.when - base, 6), 'B 应晚 6 秒调度（实际 ' + (b.started.when - base) + '）');
  assert(near(b.started.offset, 0), 'B 的 offset 应为 0');
  assert(near(b.started.duration, 8), 'B 的 duration 应为 4×2 倍速的源内秒');

  const mark2 = registry.sources.length;
  await engine.play(3); // fromT 落在 A 中间
  const list2 = sourcesSince(mark2);
  const a2 = byTag(list2, 101);
  const b2 = byTag(list2, 102);
  const base2 = Math.min(a2.started.when, b2.started.when);
  assert(near(a2.started.when, base2), 'A 已开始，应立即从 fromT 起播');
  assert(near(a2.started.offset, 5), 'A 的 offset 应为 sourceIn + 3（实际 ' + a2.started.offset + '）');
  assert(near(a2.started.duration, 7), 'A 剩余 7 秒');
  assert(near(b2.started.when - base2, 3), 'B 应晚 3 秒（已过 fromT=3）');
  assert(near(b2.started.offset, 0));

  assert(a.stopped && b.stopped, '再次 play 前必须停掉旧 source，避免叠音');
  const fetches = fetchLog.filter((u) => u === 'a').length;
  assert(fetches === 1, '同一 url 的解码结果应被缓存（实际请求 ' + fetches + ' 次）');
});

await checkAsync('①b 已结束的片段不调度', async () => {
  const engine = createAudioEngine({
    getSegments: () => [{ url: 'e', start: 0, duration: 2, sourceIn: 0, speed: 1 }],
  });
  const mark = registry.sources.length;
  await engine.play(3);
  assert(sourcesSince(mark).length === 0, 'fromT 已越过片段结尾时不应调度');
});

await checkAsync('② speed≠1 时设置 playbackRate', async () => {
  const engine = createAudioEngine({ getSegments: () => [SEG_A, SEG_B] });
  const mark = registry.sources.length;
  await engine.play(0);
  const list = sourcesSince(mark);
  const a = byTag(list, 101);
  const b = byTag(list, 102);
  assert(near(a.playbackRate.value, 1), '默认倍速为 1');
  assert(near(b.playbackRate.value, 2), 'speed=2 应写入 playbackRate（实际 ' + b.playbackRate.value + '）');
});

await checkAsync('③ fadeIn/fadeOut 产生 linearRamp', async () => {
  const seg = [{ url: 'f', start: 0, duration: 4, sourceIn: 0, speed: 1, volume: 0.8, fadeIn: 1, fadeOut: 1 }];
  const engine = createAudioEngine({ getSegments: () => seg });
  const mark = registry.sources.length;
  await engine.play(0);
  const f = byTag(sourcesSince(mark), 104);
  assert(f, '带淡入淡出的片段应被调度');
  const gain = f.connectedTo[0];
  assert(gain && gain.gain, '片段音量应经过 GainNode');
  const ramps = gain.gain.events.filter((e) => e.type === 'ramp');
  const first = gain.gain.events[0];
  assert(first && first.type === 'set' && near(first.v, 0), '应从 0 起淡入');
  assert(ramps.length >= 2, '至少应有淡入、淡出两个 ramp（实际 ' + ramps.length + '）');
  assert(near(ramps[0].v, 0.8) && near(ramps[0].t - f.started.when, 1), '淡入在 1 秒到满音量');
  const last = ramps[ramps.length - 1];
  assert(near(last.v, 0) && near(last.t - f.started.when, 4), '淡出在结尾归零');

  // 中途起播：增益从插值处接入
  const mark2 = registry.sources.length;
  await engine.play(0.5);
  const f2 = byTag(sourcesSince(mark2), 104);
  const entry = f2.connectedTo[0].gain.events[0];
  assert(entry && entry.type === 'set' && near(entry.v, 0.4), '中途起播增益应接在 0.4（实际 ' + (entry && entry.v) + '）');
});

await checkAsync('④ muted 片段不调度', async () => {
  const seg = [
    SEG_A,
    { assetId: 'd', url: 'd', start: 0, duration: 2, sourceIn: 0, speed: 1, muted: true },
  ];
  const engine = createAudioEngine({ getSegments: () => seg });
  const mark = registry.sources.length;
  await engine.play(0);
  const list = sourcesSince(mark);
  assert(byTag(list, 101), '非静音片段照常调度');
  assert(!byTag(list, 103), 'muted 片段不应被调度');
});

await checkAsync('⑤ mixdown：无片段返回静音 buffer', async () => {
  const engine = createAudioEngine({ getSegments: () => [] });
  const before = registry.offline.length;
  const buf = await engine.mixdown({ duration: 1, sampleRate: 8000 });
  assert(buf && buf.length === 8000, '静音 buffer 长度应为 duration×sampleRate');
  assert(buf.numberOfChannels === 2, '应为立体声');
  assert(near(buf.duration, 1), '时长应为 1 秒');
  assert(allZero(buf), '无片段时应全零');
  assert(registry.offline.length === before, '无片段时不应创建 OfflineAudioContext');
});

await checkAsync('⑤b mixdown：有片段时用 OfflineAudioContext 重放', async () => {
  const engine = createAudioEngine({ getSegments: () => [SEG_A, SEG_B] });
  const mark = registry.offline.length;
  const buf = await engine.mixdown({ duration: 12, sampleRate: 8000 });
  const offline = registry.offline.slice(mark).find((c) => c.length === 12 * 8000);
  assert(offline, '应创建 OfflineAudioContext(2, duration×sampleRate, sampleRate)');
  assert(offline.channels === 2 && offline.sampleRate === 8000, '声道数与采样率应一致');
  assert(buf && near(buf.getChannelData(0)[0], 0.25), '应返回离线渲染结果而不是静音兜底');
  const a = byTag(offline.createdSources, 101);
  const b = byTag(offline.createdSources, 102);
  assert(a && b, '片段应在离线上下文中被调度');
  assert(near(a.started.when, 0) && near(a.started.offset, 2) && near(a.started.duration, 10), 'A 的离线调度参数');
  assert(near(b.started.when, 6) && near(b.started.offset, 0) && near(b.started.duration, 8), 'B 的离线调度参数');
});

await checkAsync('⑥ decodeAudioData 抛错时 play 不崩', async () => {
  const seg = [SEG_A, { url: 'bad', start: 0, duration: 5, sourceIn: 0, speed: 1 }];
  const engine = createAudioEngine({ getSegments: () => seg });
  const mark = registry.sources.length;
  const seen = [];
  const original = console.warn;
  console.warn = (...args) => seen.push(args.map(String).join(' '));
  try {
    await engine.play(0); // 不应抛
  } finally {
    console.warn = original;
  }
  const list = sourcesSince(mark);
  assert(byTag(list, 101), '好片段应照常播放');
  assert(!byTag(list, 8), '坏片段应被跳过');
  assert(seen.some((t) => t.includes('解码')), '解码失败应 console.warn');
});

await checkAsync('⑦ current / pause / seek 与 context 时钟对齐', async () => {
  const engine = createAudioEngine({ getSegments: () => [SEG_A] });
  const mark = registry.sources.length;
  await engine.play(0);
  const a = byTag(sourcesSince(mark), 101);
  const liveCtx = registry.contexts[registry.contexts.length - 1];
  const base = a.started.when; // 调度基准 = currentTime + 提前量
  liveCtx.currentTime = 2;
  assert(near(engine.current(), 2 - base), 'current 应跟随 AudioContext 时钟（实际 ' + engine.current() + '）');
  const frozen = engine.current();
  engine.pause();
  assert(near(engine.current(), frozen), 'pause 后时间冻结');
  engine.seek(10);
  assert(near(engine.current(), 10), 'seek 后停在目标时间');
  assert(a.stopped, 'pause 应停掉 source');
});

await checkAsync('⑧ dispose 关闭上下文并停止调度', async () => {
  const engine = createAudioEngine({ getSegments: () => [SEG_A] });
  const mark = registry.sources.length;
  await engine.play(0);
  const liveCtx = registry.contexts[registry.contexts.length - 1];
  engine.dispose();
  assert(liveCtx.closed === true, 'dispose 应关闭 AudioContext');
  const mark2 = registry.sources.length;
  await engine.play(0);
  assert(sourcesSince(mark2).length === 0, 'dispose 后不应再创建 source');
  assert(sourcesSince(mark).every((s) => s.stopped), 'dispose 应停止正在发声的 source');
});

// ------------------------------------------------------------------ 收尾 ----

if (fail > 0) {
  console.log('\n音频引擎测试：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(1);
}
console.log('\n音频引擎测试：' + pass + ' 通过 / ' + fail + ' 失败');
