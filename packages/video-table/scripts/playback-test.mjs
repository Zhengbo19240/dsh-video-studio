/**
 * 预览播放的回归测试（不依赖真实 DOM）。
 *
 *   node scripts/playback-test.mjs
 *
 * 为什么要有这个文件：用户报的两个核心现象（暂停后黑屏 / 暂停不住）都不是
 * 「某个函数算错了」，而是时间源、硬件（<video>）和画布三者的时序问题。
 * 真浏览器里复现一次要几十秒，这里用可注入的 now/raf/schedule + 假 video，
 * 把时序钉死成断言。
 *
 * 覆盖：
 *   1. 布局常量（根容器高度链、预览 flex-basis:0、时间线 240、面板独立滚动）
 *   2. 暂停：rAF 真的停、所有 video 收到 pause()、Playhead 1 秒不变、定格画一帧
 *   3. seek：未完成不画也不清屏；完成才画，且画的是目标时间
 *   4. 漂移重试与中文诊断（seek 超时 / 素材未就绪）
 *   5. 跨片段只 seek 可见元素、池不超上限、音频与视频目标一致
 *   6. 拖动节流：拖动中降级不黑屏，松手后必须准确
 */

import * as player from '../src/client/player.js';

// ------------------------------------------------------------ 假浏览器 ----

const created = [];
const listenersOf = new WeakMap();

function fakeVideo() {
  const v = {
    src: '',
    preload: '',
    muted: false,
    playsInline: false,
    crossOrigin: '',
    paused: true,
    readyState: 0,
    videoWidth: 0,
    videoHeight: 0,
    duration: 8,
    seeking: false,
    networkState: 1,
    error: null,
    plays: 0,
    pauses: 0,
    seeks: [],
    hasFrameCallback: false,
  };
  let current = 0;
  Object.defineProperty(v, 'currentTime', {
    configurable: true,
    get() {
      return current;
    },
    set(value) {
      const n = Number(value) || 0;
      current = n;
      v.seeks.push(n);
      v.seeking = true; // 真实浏览器：设完 currentTime 后 seeked 之前都是 seeking
    },
  });
  v.load = () => {};
  v.play = () => {
    v.plays += 1;
    v.paused = false;
    return Promise.resolve();
  };
  v.pause = () => {
    v.pauses += 1;
    v.paused = true;
  };
  v.getAttribute = (name) => (name === 'src' ? v.src : null);
  v.setAttribute = () => {};
  v.removeAttribute = (name) => {
    if (name === 'src') v.src = '';
  };
  v.addEventListener = (type, fn) => {
    let map = listenersOf.get(v);
    if (!map) {
      map = new Map();
      listenersOf.set(v, map);
    }
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(fn);
  };
  v.removeEventListener = (type, fn) => {
    const map = listenersOf.get(v);
    if (map && map.has(type)) map.get(type).delete(fn);
  };
  v.requestVideoFrameCallback = v.hasFrameCallback
    ? (fn) => {
        setTimeout(() => fn(0, {}), 0);
        return 1;
      }
    : undefined;
  /** 测试专用：把当前 seek 标成完成并派发 seeked。 */
  v.finishSeek = (snapTo) => {
    if (snapTo != null) current = Number(snapTo);
    v.seeking = false;
    const map = listenersOf.get(v);
    if (map && map.has('seeked')) {
      for (const fn of [...map.get('seeked')]) fn({ type: 'seeked' });
    }
  };
  v.dispatch = (type) => {
    const map = listenersOf.get(v);
    if (map && map.has(type)) for (const fn of [...map.get(type)]) fn({ type });
  };
  return v;
}

globalThis.document = {
  createElement(tag) {
    if (tag === 'video') {
      const v = fakeVideo();
      created.push(v);
      return v;
    }
    return {};
  },
};

// ------------------------------------------------------------ 假 canvas ---

function fakeCtx() {
  const records = { fillRects: 0, draws: [], drawTimes: [], texts: [] };
  const noop = () => {};
  const ctx = {
    records,
    save: noop,
    restore: noop,
    beginPath: noop,
    rect: noop,
    ellipse: noop,
    clip: noop,
    translate: noop,
    rotate: noop,
    measureText: (t) => ({ width: String(t).length * 6 }),
    createRadialGradient: () => ({ addColorStop: noop }),
    strokeText: (t) => records.texts.push(t),
    fillText: (t) => records.texts.push(t),
    fillRect: () => {
      records.fillRects += 1;
    },
    drawImage: (img) => {
      records.draws.push(img);
      records.drawTimes.push(img && img.currentTime);
    },
  };
  for (const key of ['fillStyle', 'strokeStyle', 'font', 'textAlign', 'textBaseline', 'globalAlpha', 'filter', 'lineWidth', 'lineJoin', 'miterLimit', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY']) {
    Object.defineProperty(ctx, key, { get: () => null, set: () => {} });
  }
  return ctx;
}

// ------------------------------------------------------------- 假时钟 ----

let clock = 0;
let rafId = 0;
const rafQueue = new Map();
const timers = [];

function raf(cb) {
  rafId += 1;
  rafQueue.set(rafId, cb);
  return rafId;
}
function caf(id) {
  rafQueue.delete(id);
}
function schedule(fn, ms) {
  const entry = { fn, ms, cancelled: false };
  timers.push(entry);
  return entry;
}
function unschedule(entry) {
  if (entry) entry.cancelled = true;
}
/** 只跑一帧（先把这一帧取走，再执行；执行中新排的帧留到下一次）。 */
function frame(ms) {
  if (ms != null) clock = ms;
  const batch = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of batch) cb(clock);
  return batch.length;
}
/** 把当前挂着的超时回调全部跑掉（模拟「等了一会儿」）。 */
function runTimers() {
  const batch = timers.filter((t) => !t.cancelled);
  for (const t of batch) t.cancelled = true; // 只跑一次
  for (const t of batch) t.fn();
  return batch.length;
}
function pendingTimers() {
  return timers.filter((t) => !t.cancelled).length;
}

// ------------------------------------------------------------- 假音频 ----

function fakeAudio() {
  return {
    calls: [],
    play(t) {
      this.calls.push(['play', t]);
    },
    pause() {
      this.calls.push(['pause']);
    },
    seek(t) {
      this.calls.push(['seek', t]);
    },
    last(name) {
      const hit = [...this.calls].reverse().find((c) => c[0] === name);
      return hit ? hit[1] : undefined;
    },
  };
}

// ------------------------------------------------------------- 时间线 -----

const assets = [
  { id: 'a1', name: 'a.mp4', mime: 'video/mp4', path: 'assets/a.mp4' },
  { id: 'b1', name: 'b.mp4', mime: 'video/mp4', path: 'assets/b.mp4' },
];
const clips = [
  { id: 'c1', type: 'media', trackId: 'v1', assetId: 'a1', start: 0, duration: 4, sourceIn: 0, speed: 1 },
  { id: 'c2', type: 'media', trackId: 'v1', assetId: 'b1', start: 4, duration: 4, sourceIn: 2, speed: 1 },
];
const DURATION = 8;
const CODECS = { hvc1: '', h264: 'probably' };

const videoOf = (assetId) => {
  const v = [...created].reverse().find((x) => String(x.src).includes(assetId));
  return v || null;
};

function makeReady(assetId, currentTime) {
  const v = videoOf(assetId);
  v.readyState = 4;
  v.videoWidth = 640;
  v.videoHeight = 360;
  v.seeking = false;
  if (currentTime != null) {
    v.currentTime = currentTime;
    v.seeking = false;
  }
  return v;
}

function resetWorld() {
  player.clearPool();
  created.length = 0;
  rafQueue.clear();
  timers.length = 0;
  clock = 0;
}

function buildEngine(overrides = {}) {
  const ctx = fakeCtx();
  const audio = fakeAudio();
  const ticks = [];
  const diags = [];
  const view = { clips, assets, duration: DURATION, codecs: CODECS };
  const engine = player.createPlaybackEngine({
    getView: () => view,
    draw: (t) => {
      player.drawFrame(ctx, { clips, assets, t, width: 320, height: 180, codecs: CODECS });
    },
    onTick: (t) => ticks.push(t),
    onDiagnostic: (list) => {
      diags.length = 0;
      for (const d of list) diags.push(d);
    },
    getAudio: () => audio,
    now: () => clock,
    raf,
    caf,
    schedule,
    unschedule,
    ...overrides,
  });
  return { engine, ctx, audio, ticks, diags, view };
}

// -------------------------------------------------------------- 断言 ------

let pass = 0;
let fail = 0;
function step(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + (e && e.message ? e.message : e));
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}
function near(a, b, eps, message) {
  if (!(Math.abs(a - b) <= eps)) throw new Error((message || '数值不符') + '：' + a + ' vs ' + b);
}

// ============================================================ 布局 ======

step('布局：根容器高度确定（100% + min-height:0 + overflow:hidden）', () => {
  const L = player.layoutStyles();
  assert(L.root.height === '100%', 'root.height=' + L.root.height);
  assert(L.root.minHeight === 0, 'root.minHeight=' + L.root.minHeight);
  assert(L.root.overflow === 'hidden', 'root.overflow=' + L.root.overflow);
  assert(L.root.maxHeight === '100%', 'root.maxHeight=' + L.root.maxHeight);
});

step('布局：预览区可压缩（flex-grow:1 / flex-basis:0 / min-height:0 / overflow:hidden）', () => {
  const L = player.layoutStyles();
  assert(L.preview.flexGrow === 1, 'flexGrow=' + L.preview.flexGrow);
  assert(L.preview.flexBasis === 0, 'flexBasis=' + L.preview.flexBasis);
  assert(L.preview.minHeight === 0, 'minHeight=' + L.preview.minHeight);
  assert(L.preview.overflow === 'hidden', 'overflow=' + L.preview.overflow);
});

step('布局：时间线固定 240px 且不参与伸缩', () => {
  const L = player.layoutStyles();
  assert(player.WORKBENCH_LAYOUT.timelineHeight === 240, 'timelineHeight=' + player.WORKBENCH_LAYOUT.timelineHeight);
  assert(L.timeline.height === 240, 'height=' + L.timeline.height);
  assert(L.timeline.flexBasis === 240, 'flexBasis=' + L.timeline.flexBasis);
  assert(L.timeline.flexGrow === 0 && L.timeline.flexShrink === 0, '时间线不允许被压缩或拉长');
});

step('布局：左右两栏各自滚动，边界不漏给页面', () => {
  const L = player.layoutStyles();
  for (const key of ['mediaBin', 'inspector']) {
    assert(L[key].overflowY === 'auto', key + '.overflowY=' + L[key].overflowY);
    assert(L[key].overscrollBehavior === 'contain', key + '.overscrollBehavior=' + L[key].overscrollBehavior);
    assert(L[key].minHeight === 0, key + '.minHeight=' + L[key].minHeight);
  }
  assert(L.mediaBin.width === 220, 'mediaBin.width=' + L.mediaBin.width);
  assert(L.inspector.width === 260, 'inspector.width=' + L.inspector.width);
});

step('布局：fitPanelHeight 在「父级无高度」时用视口兜底', () => {
  assert(player.fitPanelHeight({ viewportHeight: 900, top: 60 }) === 840, '900-60 应为 840');
  assert(player.fitPanelHeight({ viewportHeight: 900, top: 60, parentHeight: 500 }) === 500, '父级更小时取父级');
  assert(player.fitPanelHeight({ viewportHeight: 200, top: 60 }) === player.WORKBENCH_LAYOUT.minPanelHeight, '很小窗口取下限');
});

// ============================================================ 暂停 ======

step('暂停后 1 秒内 playhead 不变（旧帧回调被触发也拒绝推进）', () => {
  resetWorld();
  const { engine } = buildEngine();
  player.ensureVideos(assets, (id) => '/media/' + id);
  makeReady('a1', 0);
  engine.play(0);
  frame(100); // 0.1s
  frame(200); // 0.2s
  const stale = [...rafQueue.values()];
  engine.pause();
  const at = engine.playhead();
  clock += 1000;
  for (const cb of stale) cb(clock); // 模拟「已经排上队的旧回调还是跑了」
  near(engine.playhead(), at, 1e-9, '暂停后 playhead 被推进了');
  assert(at > 0.15, '暂停前应当已经播了一会儿，at=' + at);
});

step('playing true→false：rAF 被 cancel，且没有挂起帧', () => {
  resetWorld();
  const { engine } = buildEngine();
  player.ensureVideos(assets, (id) => '/media/' + id);
  makeReady('a1', 0);
  engine.play(0);
  assert(engine.pendingFrame() !== 0, '播放时应挂着 rAF');
  const idBefore = engine.pendingFrame();
  assert(rafQueue.has(idBefore), 'rAF id 应在队列里');
  engine.pause();
  assert(!rafQueue.has(idBefore), '暂停必须 cancelAnimationFrame');
  assert(engine.pendingFrame() === 0, '暂停后不应再挂帧');
});

step('暂停：池子里所有 <video> 都收到 pause()（含 readyState<2 的那个）', () => {
  resetWorld();
  const { engine } = buildEngine();
  player.ensureVideos(assets, (id) => '/media/' + id);
  const va = makeReady('a1', 0);
  const vb = videoOf('b1');
  vb.readyState = 1; // 正在缓冲：旧代码在这里 continue，根本没 pause
  va.pause = () => {
    va.pauses += 1;
    va.paused = true;
  };
  va.paused = false;
  vb.paused = false;
  engine.pause();
  assert(va.pauses >= 1, '可见 video 没被 pause');
  assert(vb.pauses >= 1, 'readyState<2 的 video 也必须 pause（这就是「暂停不住」）');
  assert(vb.paused === true, 'vb.paused 还是 false');
});

step('暂停时定格画一帧（drawImage 至少 1 次）', () => {
  resetWorld();
  const { engine, ctx } = buildEngine();
  player.ensureVideos(assets, (id) => '/media/' + id);
  makeReady('a1', 1.0);
  engine.play(1.0);
  frame(1000);
  const before = ctx.records.draws.length;
  engine.setPlayhead(1.0);
  makeReady('a1', 1.0);
  engine.pause();
  assert(ctx.records.draws.length > before, '暂停后没有画任何一帧 drawn=' + ctx.records.draws.length);
  near(ctx.records.drawTimes[ctx.records.drawTimes.length - 1], 1.0, 0.05, '暂停定格的不是当前时间');
});

step('暂停时音频也 pause（音画同一个开关）', () => {
  resetWorld();
  const { engine, audio } = buildEngine();
  player.ensureVideos(assets, (id) => '/media/' + id);
  makeReady('a1', 0);
  engine.play(0);
  engine.pause();
  assert(audio.calls.some((c) => c[0] === 'pause'), '音频没收到 pause：' + JSON.stringify(audio.calls));
});

// ============================================================ seek ======

step('seek 未完成（readyState=1）时不 drawImage，也不清屏', () => {
  resetWorld();
  const { engine, ctx } = buildEngine();
  player.ensureVideos(assets, (id) => '/media/' + id);
  const v = videoOf('a1');
  v.readyState = 1; // 只有元数据，没有帧
  v.videoWidth = 640;
  v.videoHeight = 360;
  engine.seek(2.5);
  assert(ctx.records.draws.length === 0, '没就绪却 drawImage 了');
  assert(ctx.records.fillRects === 0, '没就绪却清屏了（会黑屏）');
});

step('seek 完成（readyState=4 + seeked）后画的帧对应目标时间', () => {
  resetWorld();
  const { engine, ctx } = buildEngine();
  player.ensureVideos(assets, (id) => '/media/' + id);
  makeReady('a1', 0);
  engine.seek(2.5);
  assert(ctx.records.draws.length === 0, 'seeked 之前不该画');
  const v = videoOf('a1');
  assert(v.seeking === true, '设了 currentTime 应当进入 seeking');
  near(v.currentTime, 2.5, 1e-6, '没把目标时间写给 video');
  v.finishSeek(); // 浏览器：seeked 到了
  assert(ctx.records.draws.length === 1, 'seeked 之后应当画一帧，实际 ' + ctx.records.draws.length);
  near(ctx.records.drawTimes[0], 2.5, 0.01, '画出来的不是目标时间');
});

step('跨片段 seek：只 seek 可见的 video，另一段保持暂停', () => {
  resetWorld();
  const { engine } = buildEngine();
  player.ensureVideos(assets, (id) => '/media/' + id);
  makeReady('a1', 0);
  makeReady('b1', 0);
  const va = videoOf('a1');
  const vb = videoOf('b1');
  const seeksBefore = va.seeks.length;
  engine.seek(5.5); // 落在 c2（sourceIn=2）→ 源时间 3.5
  assert(va.seeks.length === seeksBefore, '不可见的 a1 不该被 seek');
  near(vb.currentTime, 3.5, 1e-6, 'b1 应定位到 3.5s（sourceIn 2 + 1.5）');
  assert(va.paused === true, '不可见的 a1 应该停着');
});

step('音频与视频 seek 到同一个目标时间', () => {
  resetWorld();
  const { engine, audio } = buildEngine();
  player.ensureVideos(assets, (id) => '/media/' + id);
  makeReady('a1', 0);
  makeReady('b1', 0);
  engine.seek(5.6);
  near(audio.last('seek'), 5.6, 1e-9, '音频 seek 目标不对');
  near(videoOf('b1').currentTime, 3.6, 1e-6, '视频目标时间不对');
  assert(engine.playhead() === 5.6, 'playhead 没跟上');
});

step('漂移 > 0.25s 触发重试，重试用尽给中文诊断', () => {
  resetWorld();
  const { engine, diags, ctx } = buildEngine();
  player.ensureVideos(assets, (id) => '/media/' + id);
  const v = videoOf('a1');
  v.readyState = 4;
  v.videoWidth = 640;
  v.videoHeight = 360;
  v.currentTime = 0;
  v.seeking = false;
  // 让这个 video「怎么 seek 都回不到目标」：模拟解码器卡住
  let stuck = 0;
  Object.defineProperty(v, 'currentTime', {
    configurable: true,
    get: () => stuck,
    set: () => {
      v.seeks.push(0);
      v.seeking = false; // 立刻结束，但位置永远不对
    },
  });
  const before = v.seeks.length;
  engine.seek(2.0);
  for (let i = 0; i < player.MAX_SEEK_RETRIES + 1; i += 1) {
    if (pendingTimers()) runTimers();
  }
  assert(v.seeks.length > before, '应当发生过 seek');
  assert(diags.length === 1, '应当给出 1 条诊断，实际 ' + diags.length);
  assert(diags[0].code === 'seek-timeout', '诊断 code=' + diags[0].code);
  assert(diags[0].detail.includes('seek 超时'), '诊断里要有「seek 超时」：' + diags[0].detail);
  assert(diags[0].detail.includes('已重试'), '诊断里要说重试次数：' + diags[0].detail);
  assert(ctx.records.fillRects === 0, '超时也不能清屏（黑屏就是这里来的）');
});

step('素材根本没加载（readyState=0）给「素材未就绪」而不是黑屏', () => {
  resetWorld();
  const { engine, diags, ctx } = buildEngine();
  player.ensureVideos(assets, (id) => '/media/' + id);
  const v = videoOf('a1');
  v.readyState = 0;
  v.videoWidth = 0;
  engine.seek(1.2);
  for (let i = 0; i < player.MAX_SEEK_RETRIES + 1; i += 1) {
    if (pendingTimers()) runTimers();
  }
  assert(diags.length === 1, '应当有诊断');
  assert(diags[0].code === 'media-not-ready', 'code=' + diags[0].code);
  assert(diags[0].title.includes('素材未就绪'), '标题=' + diags[0].title);
  assert(ctx.records.draws.length === 0 && ctx.records.fillRects === 0, '不应该画黑帧');
});

step('拖动中（scrub）未就绪只是不画；松手后必须画准', () => {
  resetWorld();
  const { engine, ctx } = buildEngine();
  player.ensureVideos(assets, (id) => '/media/' + id);
  const v = videoOf('a1');
  v.readyState = 1;
  v.videoWidth = 640;
  v.videoHeight = 360;
  engine.seek(1.0, { scrub: true, force: true });
  engine.seek(1.4, { scrub: true });
  assert(ctx.records.draws.length === 0, '拖动中没帧就不该画（但也不该清屏）');
  assert(ctx.records.fillRects === 0, '拖动中不许可清屏');
  // 松手：媒体就绪了，必须落一帧准的
  v.readyState = 4;
  v.currentTime = 1.4;
  v.seeking = false;
  engine.seek(1.4, { scrub: false, force: true });
  assert(ctx.records.draws.length === 1, '松手后应当画一帧');
  near(ctx.records.drawTimes[0], 1.4, 0.05, '松手后画的不是目标帧');
});

// ============================================================ 推进 ======

step('播放时 playhead 由一个时间源按 dt 前进', () => {
  resetWorld();
  const { engine, ticks } = buildEngine();
  player.ensureVideos(assets, (id) => '/media/' + id);
  makeReady('a1', 0);
  engine.play(0);
  frame(100);
  near(engine.playhead(), 0.1, 1e-6, '第一帧 dt 应为 0.1');
  frame(300);
  near(engine.playhead(), 0.3, 1e-6, '第二帧累计应为 0.3');
  assert(ticks.length >= 2, 'onTick 没有按帧回调');
});

step('暂停后再播放不跳变（dt 不累积）', () => {
  resetWorld();
  const { engine } = buildEngine();
  player.ensureVideos(assets, (id) => '/media/' + id);
  makeReady('a1', 0);
  engine.play(0);
  frame(500);
  frame(1000);
  frame(1500);
  frame(2000);
  near(engine.playhead(), 2.0, 1e-6, '应当播到 2.0');
  engine.pause();
  clock += 5000; // 暂停 5 秒
  engine.play();
  frame(clock + 16);
  near(engine.playhead(), 2.016, 0.001, '暂停后恢复不该把 5 秒算进去');
});

step('播放中 seek 重置基准，不产生跳变', () => {
  resetWorld();
  const { engine } = buildEngine();
  player.ensureVideos(assets, (id) => '/media/' + id);
  makeReady('a1', 0);
  engine.play(0);
  frame(500);
  engine.seek(3.0);
  frame(560);
  near(engine.playhead(), 3.06, 0.001, 'seek 后应按新基准推进');
  assert(engine.isPlaying(), 'seek 不应该停掉播放');
});

step('到片尾自动暂停，playhead 停在长度上', () => {
  resetWorld();
  const ticks = [];
  const { engine } = buildEngine({
    getView: () => ({ clips, assets, duration: 0.2, codecs: CODECS }),
  });
  player.ensureVideos(assets, (id) => '/media/' + id);
  makeReady('a1', 0);
  engine.play(0);
  frame(150);
  frame(400); // 超过 0.2
  near(engine.playhead(), 0.2, 1e-6, 'playhead 应停在片尾');
  assert(!engine.isPlaying(), '到片尾应自动暂停');
  assert(engine.pendingFrame() === 0, '到片尾不应再挂帧');
});

step('dispose 之后不再挂帧、不再播放', () => {
  resetWorld();
  const { engine } = buildEngine();
  player.ensureVideos(assets, (id) => '/media/' + id);
  makeReady('a1', 0);
  engine.play(0);
  engine.dispose();
  assert(engine.pendingFrame() === 0, 'dispose 后不应挂帧');
  assert(rafQueue.size === 0, 'rAF 队列应为空');
  assert(!engine.isPlaying(), 'dispose 后 isPlaying 应为 false');
});

// ============================================================ 池 ========

step('预览池不超上限（12 个素材仍只建 8 个 video）', () => {
  resetWorld();
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: 'x' + i,
    name: 'x' + i + '.mp4',
    mime: 'video/mp4',
    path: 'assets/x' + i + '.mp4',
  }));
  const made = player.ensureVideos(many, (id) => '/media/' + id);
  assert(made === 12, '第一次应该都建（12），实际 ' + made);
  assert(player.poolSize() <= player.POOL_LIMIT, '池子超限：' + player.poolSize());
  assert(player.POOL_LIMIT === 8, '上限应为 8');
});

// ============================================================ 合成 ======

step('paintPreviewFrame：就绪才画；没就绪一个像素都不动', () => {
  resetWorld();
  player.ensureVideos(assets, (id) => '/media/' + id);
  const v = videoOf('a1');
  v.readyState = 1;
  v.videoWidth = 640;
  v.videoHeight = 360;
  const ctx1 = fakeCtx();
  const pending = player.paintPreviewFrame(ctx1, { clips, assets, t: 1, width: 320, height: 180, codecs: CODECS });
  assert(pending.painted === false, '没就绪却报告已画');
  assert(pending.pending.length === 1, '应当报告 1 条 pending');
  assert(ctx1.records.fillRects === 0 && ctx1.records.draws.length === 0, '没就绪时不允许动画布');

  v.readyState = 4;
  v.currentTime = 1;
  v.seeking = false;
  const ctx2 = fakeCtx();
  const ok = player.paintPreviewFrame(ctx2, { clips, assets, t: 1, width: 320, height: 180, codecs: CODECS });
  assert(ok.painted === true, '就绪了却没画');
  assert(ctx2.records.draws.length === 1, 'drawImage 次数=' + ctx2.records.draws.length);
  near(ctx2.records.drawTimes[0], 1, 0.001, '画的位置不对');
});

step('回归：drawFrame 不把诊断写到画布上，改由 onMediaState 交给 overlay', () => {
  resetWorld();
  player.ensureVideos(assets, (id) => '/media/' + id);
  const v = videoOf('a1');
  v.readyState = 0;
  const ctx = fakeCtx();
  const diags = [];
  player.drawFrame(ctx, {
    clips,
    assets,
    t: 1,
    width: 320,
    height: 180,
    codecs: CODECS,
    onMediaState: (list) => diags.push(...(list || [])),
  });
  assert(ctx.records.texts.length === 0, '画布上不该有诊断文字：' + JSON.stringify(ctx.records.texts));
  assert(diags.some((d) => String(d.title).includes('载入中')), '应当通过 onMediaState 报中文诊断：' + JSON.stringify(diags));
  assert(ctx.records.draws.length === 0, '没就绪不该画帧');
});

// -------------------------------------------------------------- 收尾 ------

player.clearPool();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
