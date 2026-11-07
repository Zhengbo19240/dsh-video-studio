/**
 * 预览播放循环的回归测试（dsh-video-table / 代码图层）。
 *
 * 背景：用户反复报「预览一顿一顿」。审查怀疑两处（见 docs/playback-loop.md）：
 *   1) tickLayers 用墙钟 `now - lastAt < 16/40ms` 跳帧；
 *   2) renderCode fire-and-forget，渲染排队、后发的旧帧盖掉新帧。
 *
 * 这个文件**不依赖浏览器**：用一个虚拟时钟 + 假 rAF + 假渲染器，把播放循环
 * 按真实链路跑一遍，然后对「呈现的 t 序列」下断言。
 *
 * 真实链路（src/client/main.js 的 paint）：
 *   rAF → registry.tickLayers(layers, playing)（不 await）
 *      → renderCode(...) → layer.render(t)（worker 里渲染；主线程串行链）
 *      → 渲染完成 → 画到图层画布 → 合成器下一次 drawFrame 读它
 *
 * 所以「呈现」= 每一帧 rAF 时画布上的内容。指标都由这个序列推出来。
 */

import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = pathToFileURL(path.join(HERE, '..', 'src', 'client', 'code-registry.js')).href;

const { createCodeRegistry, PRESENTED_FPS_WINDOW_MS } = await import(REGISTRY);

// -------------------------------------------------------------- 断言工具 ----

let pass = 0;
let fail = 0;

async function checkAsync(name, fn) {
  try {
    await Promise.resolve().then(fn);
    pass += 1;
    console.log('  ok   ' + name);
  } catch (error) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + (error && error.message));
    if (process.env.DSH_TEST_STACK) console.log(error && error.stack);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const EPS = 1e-6;
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// -------------------------------------------------------------- 虚拟时钟 ----

/**
 * 虚拟时间：所有 wait（渲染耗时、取帧耗时）都排在这条时间线上。
 * drain() 抽干微任务 —— 必须用真 setTimeout(0)，因为 promise 链要跨宏任务才干净。
 */
function createClock() {
  const clock = { now: 0, timers: [], seq: 0 };
  const realSetTimeout = setTimeout;

  clock.after = (ms, fn) => {
    const entry = { at: clock.now + Math.max(0, Number(ms) || 0), fn, seq: clock.seq++ };
    clock.timers.push(entry);
    clock.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    return entry;
  };

  clock.drain = () => new Promise((resolve) => realSetTimeout(resolve, 0));

  clock.runUntil = async (target) => {
    for (;;) {
      if (!clock.timers.length || clock.timers[0].at > target) break;
      const entry = clock.timers.shift();
      clock.now = entry.at;
      entry.fn();
      await clock.drain();
    }
    if (target > clock.now) clock.now = target;
    // 没有定时器时也要把微任务抽干：ensure() 之类的纯 promise 链就靠这一步落地。
    await clock.drain();
  };

  clock.reset = (base) => {
    clock.now = Number(base) || 0;
    clock.timers = [];
    clock.seq = 0;
  };

  return clock;
}

/**
 * 等待一个「需要虚拟时间前进才会完成」的注册表 promise。
 * 直接 await 会死锁：渲染靠 clock.after 排期，而没人推动时间。
 */
async function settle(clock, promise, options = {}) {
  const stepMs = Number(options.stepMs) > 0 ? Number(options.stepMs) : 5;
  const limitMs = Number(options.limitMs) > 0 ? Number(options.limitMs) : 10000;
  let done = false;
  let failure = null;
  promise.then(
    () => {
      done = true;
    },
    (error) => {
      done = true;
      failure = error;
    },
  );
  let elapsed = 0;
  while (!done && elapsed < limitMs) {
    await clock.runUntil(clock.now + stepMs);
    await clock.drain();
    elapsed += stepMs;
  }
  if (!done) throw new Error('等待超时：被等的 promise 没有完成');
  if (failure) throw failure;
  return promise;
}

// -------------------------------------------------------------- 假渲染器 ----

/**
 * 与 code-layer.js 的 renderChain 同构：render() 串行排队，完成时才改画布。
 * 这样「队列积压」和「完成顺序」都是真的，不是测试里假设出来的。
 */
class FakeLayer {
  static renderMs = 25;
  static needsMedia = false;

  constructor() {
    this.submitted = 0; // 提交进渲染链的次数（含仍在排队的）
    this.started = []; // 真正开始渲染的 t（按开始顺序）
    this.painted = null; // 画布上的内容
    this.paintLog = []; // 每次完成：{t, at}
    this.chain = Promise.resolve();
    this.disposed = false;
  }

  ready() {
    return Promise.resolve();
  }

  mediaNeeds() {
    return FakeLayer.needsMedia ? [{ id: 'A' }] : [];
  }

  transitionNeeds() {
    return null;
  }

  render(t) {
    this.submitted += 1;
    const task = this.chain.then(async () => {
      this.started.push(t);
      await new Promise((resolve) => FakeLayer.clock.after(FakeLayer.renderMs, resolve));
      this.painted = t;
      this.paintLog.push({ t, at: FakeLayer.clock.now });
    });
    this.chain = task.catch(() => {});
    return task;
  }

  canvas() {
    return this.painted === null ? null : { tag: this.painted };
  }

  dispose() {
    this.disposed = true;
  }
}

// -------------------------------------------------------------- 夹具 ----

const CODE_CLIP = {
  id: 'C',
  trackId: 'c1',
  type: 'code',
  layerId: 'layer-C',
  codeHash: 'h1',
  start: 0,
  duration: 60,
  props: {},
};

function layerOf(clip, localT) {
  return { clip, kind: 'code', localT, alpha: 1, dx: 0, dy: 0, clipRect: null };
}

/** 建一个只用假渲染器、没有媒体桥的注册表。 */
function makeRegistry(clock, options = {}) {
  const layers = [];
  const registry = createCodeRegistry({
    projectId: 'playback-loop-test',
    readLayerSource: async () => 'export function render(){}',
    layerFactory: () => {
      const layer = new FakeLayer();
      layers.push(layer);
      return layer;
    },
    context: () => ({
      assets: [],
      clips: [CODE_CLIP],
      tracks: [{ id: 'c1', kind: 'code' }],
      fps: 30,
      revision: 1,
    }),
    mediaBridge: options.prep
      ? {
          async frames(needs, byId, localT) {
            await new Promise((resolve) => clock.after(options.prep(localT), resolve));
            return { frames: [] };
          },
        }
      : null,
    now: () => clock.now,
  });
  return { registry, layers, layer: () => layers[0] };
}

/**
 * 跑一段「播放」：rAF 按 hz 触发，每次 tickLayers 之后记录画布内容。
 * 与 main.js 一样**不 await** tickLayers 返回的 promise。
 *
 * @returns {{samples, presented, outOfOrder, stats, layer, submitted, started}}
 */
async function play(clock, options = {}) {
  const hz = Number(options.hz) > 0 ? Number(options.hz) : 60;
  const seconds = Number(options.seconds) > 0 ? Number(options.seconds) : 3;
  const startAt = Number(options.startAt) || 0;
  const renderMs = options.renderMs == null ? 25 : Number(options.renderMs);

  clock.reset(options.clockBase || 0);
  const base = clock.now;
  FakeLayer.clock = clock;
  FakeLayer.renderMs = renderMs;
  FakeLayer.needsMedia = !!options.prep;

  const fx = makeRegistry(clock, options);
  const frameMs = 1000 / hz;
  const rafCount = Math.round(seconds * hz);
  const samples = [];
  let last = null;
  let outOfOrder = 0;
  let presented = 0;

  for (let i = 0; i < rafCount; i += 1) {
    const at = base + i * frameMs;
    await clock.runUntil(at);
    const t = startAt + i / hz;
    fx.registry.tickLayers([layerOf(CODE_CLIP, t)], true).catch(() => {});
    await clock.drain();
    const layer = fx.layer();
    const painted = layer ? layer.painted : null;
    const isPause = options.pauseAfter != null && i >= options.pauseAfter;
    samples.push({ i, ideal: t, painted });
    if (painted !== null) {
      presented += 1;
      if (last !== null && painted < last - EPS) outOfOrder += 1;
      last = painted;
    }
    if (isPause) break;
  }

  return {
    samples,
    presented,
    outOfOrder,
    last,
    stats: fx.registry.playbackStats(),
    registry: fx.registry,
    layer: fx.layer(),
    submitted: fx.layer() ? fx.layer().submitted : 0,
    started: fx.layer() ? fx.layer().started.length : 0,
    distinct: distinctOf(samples),
  };
}

function distinctOf(samples) {
  const out = [];
  let last = null;
  for (const sample of samples) {
    const value = sample.painted;
    if (value === null) continue;
    if (last === null || Math.abs(value - last) > EPS) out.push(value);
    last = value;
  }
  return out;
}

/** 呈现序列的「滞后」：每个 rAF 时刻，画布 t 与播放头 t 的差。 */
function analyzeLag(samples) {
  let sum = 0;
  let n = 0;
  let max = 0;
  for (const sample of samples) {
    if (sample.painted === null) continue;
    const lag = sample.ideal - sample.painted;
    if (lag >= 0) {
      sum += lag;
      n += 1;
      if (lag > max) max = lag;
    }
  }
  return { mad: n ? sum / n : 0, max, n };
}

function monotonic(values) {
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] < values[i - 1] - EPS) return false;
  }
  return true;
}

// ------------------------------------------------------------------ 用例 ----

console.log('\n播放循环（假 rAF + 假渲染器）');

await checkAsync('1. 60Hz / 25ms 渲染 3 秒：呈现的 t 严格单调递增', async () => {
  const r = await play(createClock(), { hz: 60, seconds: 3, renderMs: 25 });
  assert(r.distinct.length > 60, '3 秒内至少该呈现 60 帧，实际 ' + r.distinct.length);
  assert(monotonic(r.distinct), '呈现序列必须单调递增');
  assert(r.outOfOrder === 0, '乱序次数必须是 0，实际 ' + r.outOfOrder);
  assert(r.stats.staleDrops === 0, '正常向前播放不该有过期帧，实际 ' + r.stats.staleDrops);
  r.registry.dispose();
});

await checkAsync('2. 不积压：提交进渲染链的帧不会越堆越多', async () => {
  const r = await play(createClock(), { hz: 60, seconds: 3, renderMs: 25 });
  // 3 秒 / 25ms = 120 次渲染；旧实现会提交 180 次（每个 rAF 一次）并积压 60。
  assert(r.submitted <= 130, '3 秒最多该提交 ~120 帧，实际 ' + r.submitted);
  assert(r.submitted === r.started, '渲染链里不该有排队的帧（提交 ' + r.submitted + ' / 开始 ' + r.started + '）');
  r.registry.dispose();
});

await checkAsync('3. 渲染慢于帧率：降帧但不乱序、滞后有上界', async () => {
  const r = await play(createClock(), { hz: 60, seconds: 3, renderMs: 25 });
  const fps = r.distinct.length / 3;
  assert(fps < 60, '25ms 渲染追不上 60Hz，呈现帧率必须低于 60，实际 ' + fps.toFixed(1));
  assert(fps > 30, '不该慢到 30fps 以下，实际 ' + fps.toFixed(1));
  const lag = analyzeLag(r.samples);
  assert(lag.mad < 0.1, '平均滞后应 < 0.1s，实际 ' + lag.mad.toFixed(3));
  assert(lag.max < 0.2, '最大滞后应 < 0.2s，实际 ' + lag.max.toFixed(3));
  r.registry.dispose();
});

await checkAsync('4. 60ms 重卡：滞后仍被压在「一帧渲染时间」量级', async () => {
  const r = await play(createClock(), { hz: 60, seconds: 3, renderMs: 60 });
  const lag = analyzeLag(r.samples);
  // 旧实现同参数：末帧滞后 2.17s、MAD 1.12s（见 docs/playback-loop.md）
  assert(lag.mad < 0.2, 'MAD 应 < 0.2s，实际 ' + lag.mad.toFixed(3));
  assert(r.outOfOrder === 0, '重卡下也不能乱序');
  assert(r.submitted === r.started, '重卡下不许积压');
  r.registry.dispose();
});

await checkAsync('5. 取帧抖动（后发先至）不会让旧帧盖新帧', async () => {
  // 渲染很便宜，但读帧耗时忽大忽小 —— 旧实现里正是这个让「后发的新帧」先到、
  // 「先发的旧帧」后到，画布被打回过去。
  const clock = createClock();
  const r = await play(clock, {
    hz: 60,
    seconds: 3,
    renderMs: 3,
    prep: (t) => (Math.round(t * 60) % 3 === 0 ? 45 : 1),
  });
  assert(r.outOfOrder === 0, '抖动的取帧耗时不等于可以乱序，实际乱序 ' + r.outOfOrder);
  assert(monotonic(r.distinct), '呈现序列必须单调');
  r.registry.dispose();
});

await checkAsync('6. 跳帧不等于停滞：呈现帧率 = 渲染能力，不是墙钟节流', async () => {
  const a = await play(createClock(), { hz: 60, seconds: 3, renderMs: 25 });
  const b = await play(createClock(), { hz: 120, seconds: 3, renderMs: 25 });
  assert(
    Math.abs(a.distinct.length - b.distinct.length) <= 2,
    '60Hz 与 120Hz 下呈现帧数应该一致（都由渲染能力决定），实际 ' +
      a.distinct.length +
      ' vs ' +
      b.distinct.length,
  );
  a.registry.dispose();
  b.registry.dispose();
});

await checkAsync('7. rAF 120Hz：请求照收，但不被 16ms 墙钟门砍掉', async () => {
  const r = await play(createClock(), { hz: 120, seconds: 3, renderMs: 0 });
  // 旧实现：120Hz 下 now-lastAt=8 < 16，每个 rAF 都被跳过一半 → 提交 ~180 次。
  // 新实现：每次 rAF 都请求（requested = 360），渲染能力决定实际渲多少。
  assert(r.stats.requested >= 355, '120Hz 3 秒应收到 ~360 个请求，实际 ' + r.stats.requested);
  assert(r.submitted >= 350, '渲染跟得上时不该被跳帧，实际提交 ' + r.submitted);
  assert(r.outOfOrder === 0, '不允许乱序');
  r.registry.dispose();
});

await checkAsync('8. rAF 30Hz：呈现帧率贴着 30fps', async () => {
  const r = await play(createClock(), { hz: 30, seconds: 3, renderMs: 25 });
  const fps = r.distinct.length / 3;
  assert(fps >= 28 && fps <= 30.5, '30Hz 下每帧都该呈现，实际 ' + fps.toFixed(1));
  assert(r.outOfOrder === 0, '不允许乱序');
  r.registry.dispose();
});

await checkAsync('9. 调度不看墙钟：把虚拟时钟整体平移，渲染次数不变', async () => {
  const a = await play(createClock(), { hz: 60, seconds: 2, renderMs: 25 });
  // 时钟基准随便挪 —— 旧实现会因此改变跳帧行为。
  const b = await play(createClock(), { hz: 60, seconds: 2, renderMs: 25, clockBase: 1e9 });
  assert(a.submitted === b.submitted, '时钟基准不该影响渲染次数：' + a.submitted + ' vs ' + b.submitted);
  a.registry.dispose();
  b.registry.dispose();
});

await checkAsync('10. 暂停（同一 t 重复 tick）不再渲染', async () => {
  const clock = createClock();
  FakeLayer.clock = clock;
  FakeLayer.renderMs = 1;
  FakeLayer.needsMedia = false;
  const fx = makeRegistry(clock);
  await clock.runUntil(0);
  fx.registry.tickLayers([layerOf(CODE_CLIP, 1.5)], false);
  await clock.runUntil(clock.now + 5);
  const afterFirst = fx.layer().submitted;
  for (let i = 0; i < 10; i += 1) {
    fx.registry.tickLayers([layerOf(CODE_CLIP, 1.5)], false);
    await clock.runUntil(clock.now + 5);
  }
  assert(fx.layer().submitted === afterFirst, '暂停在同一帧时不该重复渲染');
  const stats = fx.registry.playbackStats();
  assert(stats.presented === 1, '只该呈现 1 帧，实际 ' + stats.presented);
  fx.registry.dispose();
});

await checkAsync('11. seek 回退：在飞的「未来帧」绝不盖上屏', async () => {
  const clock = createClock();
  const options = { hz: 60, seconds: 2, renderMs: 120 };
  FakeLayer.clock = clock;
  FakeLayer.renderMs = options.renderMs;
  FakeLayer.needsMedia = false;
  const fx = makeRegistry(clock);
  const layer = () => fx.layer();

  // 往前播 0.2s：渲染要 120ms，所以此刻一定有一帧在飞。
  for (let i = 0; i < 12; i += 1) {
    await clock.runUntil(i * (1000 / 60));
    fx.registry.tickLayers([layerOf(CODE_CLIP, i / 60)], true);
    await clock.drain();
  }
  const beforeSeek = layer().painted;
  assert(beforeSeek !== null, 'seek 之前应该已经有一帧画出来了');

  // 播放头拖回 0.02s。
  const seekT = 0.02;
  fx.registry.tickLayers([layerOf(CODE_CLIP, seekT)], true);
  await clock.drain();

  // 让在飞的那一帧完成。
  await clock.runUntil(clock.now + 200);
  const stats = fx.registry.playbackStats();
  assert(stats.staleDrops >= 1, 'seek 回退时必须丢弃在飞的旧结果，实际 ' + stats.staleDrops);

  // 再往前推几帧，把 settle 走完。
  for (let i = 0; i < 20; i += 1) {
    await clock.runUntil(clock.now + 1000 / 60);
    fx.registry.tickLayers([layerOf(CODE_CLIP, seekT + i / 60)], true);
    await clock.drain();
  }
  const painted = layer().painted;
  assert(painted <= seekT + 0.4, 'seek 之后画布必须落在新位置附近，实际 ' + painted);
  fx.registry.dispose();
});

await checkAsync('12. 暂停后 seek：画布直接落在目标帧，不残留请求', async () => {
  const clock = createClock();
  FakeLayer.clock = clock;
  FakeLayer.renderMs = 10;
  FakeLayer.needsMedia = false;
  const fx = makeRegistry(clock);
  const layer = () => fx.layer();

  for (let i = 0; i < 30; i += 1) {
    await clock.runUntil(i * (1000 / 60));
    fx.registry.tickLayers([layerOf(CODE_CLIP, i / 60)], true);
    await clock.drain();
  }
  // 暂停：引擎不再 tick。这里只做一次严格的渲染（导出 / settle 走的路）。
  fx.registry.tickLayers([layerOf(CODE_CLIP, 42)], false);
  await clock.drain();
  await settle(clock, fx.registry.renderAt([CODE_CLIP], 42));
  assert(near(layer().painted, 42, 1e-6), '渲染完的目标帧必须是 42s，实际 ' + layer().painted);

  // 在飞的那帧不能再把画布拉回去。
  await clock.runUntil(clock.now + 500);
  assert(near(layer().painted, 42, 1e-6), '暂停后不该有残留请求改写画布，实际 ' + layer().painted);
  fx.registry.dispose();
});

await checkAsync('13. 单次 tickLayers 最多提交一帧', async () => {
  const clock = createClock();
  FakeLayer.clock = clock;
  FakeLayer.renderMs = 25;
  FakeLayer.needsMedia = false;
  const fx = makeRegistry(clock);
  await clock.runUntil(0);
  fx.registry.tickLayers([layerOf(CODE_CLIP, 0.5)], true);
  await clock.drain();
  const first = fx.layer().submitted;
  assert(first === 1, '第一次 tick 应只提交 1 帧，实际 ' + first);
  // 在飞期间连续 tick 十次：只更新「想要的 t」，不能再往链里塞帧。
  for (let i = 0; i < 10; i += 1) {
    fx.registry.tickLayers([layerOf(CODE_CLIP, 0.5 + i / 60)], true);
    await clock.drain();
  }
  assert(fx.layer().submitted === 1, '在飞期间不该再提交，实际 ' + fx.layer().submitted);
  const stats = fx.registry.playbackStats();
  assert(stats.coalesced >= 9, '被合并的请求应被记账，实际 ' + stats.coalesced);
  fx.registry.dispose();
});

await checkAsync('14. 导出路径逐帧 await：帧序列与理想逐帧渲染完全一致', async () => {
  const clock = createClock();
  FakeLayer.clock = clock;
  FakeLayer.renderMs = 0;
  FakeLayer.needsMedia = false;
  const fx = makeRegistry(clock);
  const times = [0, 0.5, 1.25, 2, 2.999, 4.5];
  const painted = [];
  for (const t of times) {
    await settle(clock, fx.registry.renderAt([CODE_CLIP], t));
    painted.push(fx.layer().painted);
  }
  assert(painted.length === times.length, '每一帧都要画出来');
  for (let i = 0; i < times.length; i += 1) {
    assert(near(painted[i], times[i], 1e-6), '第 ' + i + ' 帧应是 ' + times[i] + '，实际 ' + painted[i]);
  }
  // 与「理想逐帧」对比：逐帧差为 0。
  const mad = times.reduce((sum, t, i) => sum + Math.abs(painted[i] - t), 0) / times.length;
  assert(mad === 0, '导出帧序列与理想逐帧的 MAD 必须是 0，实际 ' + mad);
  fx.registry.dispose();
});

await checkAsync('15. 预览与导出不抢画布：导出帧一定赢', async () => {
  const clock = createClock();
  FakeLayer.clock = clock;
  FakeLayer.renderMs = 80;
  FakeLayer.needsMedia = false;
  const fx = makeRegistry(clock);
  const layer = () => fx.layer();

  await clock.runUntil(0);
  fx.registry.tickLayers([layerOf(CODE_CLIP, 1.0)], true); // 慢渲染，在飞
  await clock.drain();
  const exportTimes = [7, 8, 9];
  for (const t of exportTimes) {
    await settle(clock, fx.registry.renderAt([CODE_CLIP], t));
    await clock.drain();
    assert(near(layer().painted, t, 1e-6), '导出第 ' + t + 's 帧时画布应是 ' + t + '，实际 ' + layer().painted);
  }
  // 让预览那帧完成：它也已经是过去式了，不能再改画布。
  await clock.runUntil(clock.now + 500);
  assert(near(layer().painted, 9, 1e-6), '预览的残留请求不该覆盖导出结果，实际 ' + layer().painted);
  fx.registry.dispose();
});

await checkAsync('16. playbackStats 指标齐全，并且挂在全局控制台上', async () => {
  const clock = createClock();
  const r = await play(clock, { hz: 60, seconds: 2, renderMs: 25 });
  const stats = r.stats;
  for (const key of ['requested', 'renders', 'presented', 'droppedFrames', 'staleDrops', 'lateFrames', 'coalesced', 'presentedFps', 'windowMs', 'layers']) {
    assert(typeof stats[key] === 'number', '指标 ' + key + ' 应该是数字');
  }
  assert(stats.presented > 0, 'presented 应大于 0');
  assert(stats.droppedFrames === stats.requested - stats.presented, 'droppedFrames = requested - presented');
  assert(stats.presentedFps >= 0, 'presentedFps 不该是负数');
  assert(stats.windowMs === PRESENTED_FPS_WINDOW_MS, '窗口常量应被导出');
  assert(typeof globalThis.__dshPlaybackStats === 'function', '应挂 __dshPlaybackStats() 供控制台回归');
  const fromGlobal = globalThis.__dshPlaybackStats();
  assert(fromGlobal && typeof fromGlobal.presented === 'number', '全局入口应返回同一份指标');
  r.registry.dispose();
});

await checkAsync('17. 媒体图层 + 取帧抖动：仍然单调、无过期帧', async () => {
  const r = await play(createClock(), {
    hz: 60,
    seconds: 3,
    renderMs: 8,
    prep: (t) => 2 + (Math.round(t * 30) % 5) * 9,
  });
  assert(r.outOfOrder === 0, '乱序必须为 0，实际 ' + r.outOfOrder);
  assert(r.stats.staleDrops === 0, '正常播放不该丢过期帧，实际 ' + r.stats.staleDrops);
  assert(monotonic(r.distinct), '呈现序列必须单调');
  r.registry.dispose();
});

await checkAsync('18. 时间只认播放头：低帧率下也不会「跳过头再回头」', async () => {
  // 25Hz 的 rAF：每一步 40ms，比 16ms 的旧门限大得多，但呈现必须仍然单调。
  const r = await play(createClock(), { hz: 25, seconds: 3, renderMs: 10 });
  assert(r.outOfOrder === 0, '低帧率下乱序必须为 0，实际 ' + r.outOfOrder);
  assert(monotonic(r.distinct), '呈现序列单调');
  r.registry.dispose();
});

// ------------------------------------------------------------------ 汇总 ----

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
