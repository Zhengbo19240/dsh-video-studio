/**
 * 代码图层：把 agent 写的 render(ctx2d, t, ctx) 放到 Worker 里跑。
 *
 * 约定（画面必须是 t 的纯函数）：
 *   export function setup(props, env) {}      // 可选，props 变化时重新执行
 *   export function render(ctx2d, t, env) {}  // 必须，t 单位秒；任意 seek 结果一致
 *   export const media = (props) => [ids]     // 可选，声明要用的素材（见 docs/code-layer-media.md）
 *   export const transitionNeeds = (props) => ({prev:true, next:true})  // 可选，声明要邻帧
 *
 * env（第三个参数）：
 *   { width, height, props, t, fps, duration, assets, media, transition }
 *   media 是媒体句柄：has(id) / video(id) / image(id) / size(id) / kind(id) / time(id)。
 *   Worker 里没有 DOM，video(id) 返回的是**宿主已经 seek 到当前合成时间**的 ImageBitmap，
 *   可以直接 ctx2d.drawImage —— 语义等同「该视频在这一刻的画面」，不是 HTMLVideoElement。
 *
 *   transition 是转场上下文（见 docs/transition-host.md）：
 *     { cutAt, declared, prev:{has, clipId, reason, message, frame(t?)}, next:{...} }
 *   只有模块导出了 transitionNeeds 并声明需要的侧，宿主才会真的解码邻帧；
 *   没声明时结构信息仍在，但 frame() 永远返回 null。老卡片完全不受影响。
 *
 * 主线程只拿到一个普通 HTMLCanvasElement，导出/播放器可以直接把它当帧源：
 *
 *   const layer = createCodeLayer({ layerId, moduleSource, props, width, height });
 *   await layer.ready();
 *   await layer.render(t, { media: [{ id, kind, bitmap, width, height, time }] }); // 返回后 canvas() 里已经是 t 这一帧
 *   const frameCanvas = layer.canvas();    // 交给 VideoFrame / drawImage
 *   layer.dispose();
 *
 * 渲染在 Worker + OffscreenCanvas 里完成，图像以 ImageBitmap 传回主线程。
 * 主线程不做 eval/new Function；worker 内 ESM 加载失败时才退到 new Function。
 */

const DEFAULT_RENDER_TIMEOUT_MS = 5000;
const DEFAULT_SETUP_TIMEOUT_MS = 30000;

/** 结构化的图层错误；用 code 区分原因（RENDER_TIMEOUT / EVAL_BLOCKED / ...）。 */
export class CodeLayerError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'CodeLayerError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Worker 内的引导脚本。用 function.toString() 注入，避免手写字符串转义；
 * 必须完全自包含（不引用本模块其它变量）。
 */
function workerBootstrap() {
  'use strict';

  const state = {
    layerId: '',
    width: 1,
    height: 1,
    props: undefined,
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
    mediaFrames: new Map(),
    media: null,
    // 转场上下文：结构来自宿主，帧位图按 key（clipId@源时间 / clipId#c@毫秒）传进来
    transitionDescriptor: null,
    transitionNeeds: { prev: false, next: false, composed: false },
    transitionFrames: new Map(),
    transition: null,
  };

  let canvas = null;
  let draw = null;
  let queue = Promise.resolve();

  function textOf(error) {
    return error && error.message ? String(error.message) : String(error);
  }

  function isEvalBlocked(error) {
    if (!error) return false;
    if (error.name === 'EvalError') return true;
    return /unsafe-eval|Content Security Policy|CSP/i.test(textOf(error));
  }

  // ---------------------------------------------------------- 媒体句柄 ----
  //
  // Worker 里没有 document，也就没有 HTMLVideoElement；宿主（主线程）把
  // **已经 seek 到当前合成时间**的帧解码成 ImageBitmap 传进来（transferable）。
  // 所以 video(id) 返回的是「这一帧的位图」，不是元素 —— 它同样能直接喂给
  // ctx2d.drawImage，语义上就是「该视频在当前时刻的画面」。

  function frameOf(id) {
    try {
      if (id === null || id === undefined) return null;
      return state.mediaFrames.get(String(id)) || null;
    } catch (error) {
      return null;
    }
  }

  function mediaSize(frame) {
    const width = Number(frame && frame.width);
    const height = Number(frame && frame.height);
    if (!(width > 0) || !(height > 0)) return null;
    return { width: width, height: height };
  }

  function makeMediaFacade() {
    return {
      has: function (id) {
        const frame = frameOf(id);
        return !!(frame && frame.bitmap);
      },
      video: function (id) {
        const frame = frameOf(id);
        return frame && frame.kind === 'video' && frame.bitmap ? frame.bitmap : null;
      },
      image: function (id) {
        const frame = frameOf(id);
        return frame && frame.kind === 'image' && frame.bitmap ? frame.bitmap : null;
      },
      size: function (id) {
        return mediaSize(frameOf(id));
      },
      // 扩展：卡片可以用它区分 kinds / 核对这一帧到底对齐到哪个时间。
      kind: function (id) {
        const frame = frameOf(id);
        return frame ? frame.kind : null;
      },
      time: function (id) {
        const frame = frameOf(id);
        return frame && frame.time != null ? Number(frame.time) : null;
      },
    };
  }

  function closeFrames(frames) {
    if (!frames) return;
    for (const frame of frames.values()) {
      const bitmap = frame && frame.bitmap;
      if (bitmap && typeof bitmap.close === 'function') {
        try {
          bitmap.close();
        } catch (error) {
          // 已经释放过就算了
        }
      }
    }
  }

  function installMedia(list) {
    const previous = state.mediaFrames;
    const next = new Map();
    for (const entry of list || []) {
      if (!entry || entry.id === undefined || entry.id === null) continue;
      if (!entry.bitmap) continue;
      next.set(String(entry.id), {
        kind: String(entry.kind || ''),
        bitmap: entry.bitmap,
        width: Number(entry.width) || 0,
        height: Number(entry.height) || 0,
        time: entry.time === undefined || entry.time === null ? null : Number(entry.time),
      });
    }
    state.mediaFrames = next;
    // 上一帧的位图此刻已经画完；只留「当前这一代」，避免 GPU 内存越攒越多。
    closeFrames(previous);
  }

  // ---------------------------------------------------------- 转场上下文 ----
  //
  // env.transition 是「结构 + 帧表」的组合：结构（切点位置、有没有邻居）
  // 由宿主每帧算；帧位图按 key（clipId@源时间）随 render 消息 transfer 进来。
  // frame(t) 只能返回**这一帧已经送到 worker 的**那一张 —— 没预取到就返回 null，
  // 绝不在这里发起异步解码（render 必须是同步的 t 的纯函数）。

  function roundTransitionTime(value) {
    const n = Number(value);
    return (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0).toFixed(3);
  }

  /** 原始素材帧：键是 clipId@源时间。只有 composed=false 的记录算「原始帧」。 */
  function transitionFrameOf(clipId, time) {
    if (!clipId) return null;
    const key = String(clipId) + '@' + roundTransitionTime(time);
    const record = state.transitionFrames.get(key) || null;
    return record && !record.composed ? record.bitmap : null;
  }

  /** 合成帧：宿主按「clipId#c@毫秒」送进来，一帧只有这一张。 */
  function composedFrameOf(key) {
    if (!key) return null;
    const record = state.transitionFrames.get(String(key)) || null;
    return record && record.composed ? record.bitmap : null;
  }

  function closeTransitionFrames(frames) {
    if (!frames) return;
    for (const record of frames.values()) {
      const bitmap = record && record.bitmap;
      if (bitmap && typeof bitmap.close === 'function') {
        try {
          bitmap.close();
        } catch (error) {
          // 已经释放过就算了
        }
      }
    }
  }

  function installTransitionFrames(list) {
    const previous = state.transitionFrames;
    const next = new Map();
    for (const entry of list || []) {
      if (!entry || !entry.key || !entry.bitmap) continue;
      next.set(String(entry.key), { bitmap: entry.bitmap, composed: !!entry.composed });
    }
    state.transitionFrames = next;
    closeTransitionFrames(previous);
  }

  function makeTransitionFacade(descriptor) {
    const raw = descriptor && typeof descriptor === 'object' ? descriptor : {};
    const cutAt = Number(raw.cutAt);
    function sideOf(value) {
      const info = value && typeof value === 'object' ? value : {};
      const clipId = info.clipId === undefined || info.clipId === null ? null : String(info.clipId);
      const rawTime = Number(info.time);
      const composedKey = info.composedKey ? String(info.composedKey) : null;
      const composed = !!info.composed;
      // 这一侧是否**要求**合成；失败时 composed=false 但 wanted=true → frame() 返回 null。
      const composedWanted = !!info.composedWanted || composed;
      return {
        has: !!info.has,
        clipId: clipId,
        reason: info.reason ? String(info.reason) : info.has ? 'ok' : 'none',
        message: info.message ? String(info.message) : '',
        // 这一侧拿到的是不是合成帧。合成失败时 false，frame() 返回 null。
        composed: composed,
        /**
         * 合成帧优先（默认帧 = 宿主按切点时刻合成的那张）；
         * 显式传 t 时只认原始素材帧（合成帧只预取默认那一刻）。
         * 没声明 composed 的老路径仍然是「原始帧」，行为与旧版一致。
         */
        frame: function (t) {
          if (t === undefined || t === null) {
            if (composedWanted) {
              // 要求了合成：只认合成帧；没拿到就 null，不拿原始帧冒充。
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
        rawFrame: function (t) {
          const time = t === undefined || t === null ? rawTime : Number(t);
          if (!Number.isFinite(time)) return null;
          return transitionFrameOf(clipId, time);
        },
      };
    }
    return {
      cutAt: Number.isFinite(cutAt) ? cutAt : 0,
      declared: !!raw.declared,
      // 'both' / 'prev' / 'next' / false —— 模块声明要合成哪几侧。
      composed: raw.composed === undefined || raw.composed === null ? false : raw.composed,
      prev: sideOf(raw.prev),
      next: sideOf(raw.next),
    };
  }

  function normalizeNeed(item) {
    if (item === null || item === undefined) return null;
    if (typeof item === 'string' || typeof item === 'number') {
      const id = String(item);
      return id ? { id: id } : null;
    }
    if (typeof item === 'object' && item.id !== undefined && item.id !== null) {
      const id = String(item.id);
      return id ? { id: id } : null;
    }
    return null;
  }

  async function collectMediaNeeds() {
    const descriptor = state.mediaDescriptor;
    if (!descriptor) return [];
    let raw;
    try {
      raw = typeof descriptor === 'function' ? await descriptor(state.props, state.ctx) : descriptor;
    } catch (error) {
      // 声明写坏了不该让老卡片整帧黑掉：当作「没有媒体需求」。
      return [];
    }
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const need = normalizeNeed(item);
      if (!need || seen.has(need.id)) continue;
      seen.add(need.id);
      out.push(need);
    }
    return out;
  }

  /**
   * 模块可声明要哪几侧邻帧，以及要不要合成帧：
   *   true / ['prev','next'] / {prev:true} / {prev:true,next:true,composed:'both'}
   * `composed` 缺省 false —— 老卡只拿原始素材帧，一次合成都不做。
   */
  function normalizeTransitionNeeds(raw) {
    const out = { prev: false, next: false, composed: false };
    const composedOf = (value) => {
      if (!value) return false;
      if (value === true) return 'both';
      const s = String(value).toLowerCase();
      if (s === 'both' || s === 'all' || s === 'true') return 'both';
      if (s === 'prev') return 'prev';
      if (s === 'next') return 'next';
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
        if (s === 'prev' || s === 'both' || s === 'all') out.prev = true;
        if (s === 'next' || s === 'both' || s === 'all') out.next = true;
      }
      return out;
    }
    if (typeof raw === 'string') {
      const s = raw.toLowerCase();
      if (s === 'prev' || s === 'both' || s === 'all') out.prev = true;
      if (s === 'next' || s === 'both' || s === 'all') out.next = true;
      return out;
    }
    if (typeof raw === 'object') {
      out.prev = !!raw.prev;
      out.next = !!raw.next;
      if (raw.all === true || raw.both === true) {
        out.prev = true;
        out.next = true;
      }
      const sides = out.prev && out.next ? 'both' : out.prev ? 'prev' : out.next ? 'next' : false;
      if (sides) {
        const wanted = composedOf(raw.composed, sides);
        if (wanted === 'both' && sides !== 'both') out.composed = sides;
        else out.composed = wanted;
      }
    }
    return out;
  }

  async function collectTransitionNeeds() {
    const descriptor = state.transitionDescriptor;
    if (!descriptor) return { prev: false, next: false, composed: false };
    let raw;
    try {
      raw = typeof descriptor === 'function' ? await descriptor(state.props, state.ctx) : descriptor;
    } catch (error) {
      // 声明写坏了按「不要邻帧」处理，绝不让整帧黑掉。
      return { prev: false, next: false, composed: false };
    }
    return normalizeTransitionNeeds(raw);
  }

  function postError(id, error, fallback, phase) {
    self.postMessage({
      type: 'error',
      id: id === undefined ? null : id,
      code: isEvalBlocked(error) ? 'EVAL_BLOCKED' : (error && error.code) || fallback,
      message: textOf(error),
      phase: phase || '',
    });
  }

  // 虚拟时钟：所有时间都来自 t，定时器一律拒绝
  function installClock() {
    try {
      Date.now = function () {
        return state.clock.t * 1000;
      };
    } catch (error) {
      // 某些环境 Date.now 不可写，忽略
    }

    if (self.performance && typeof self.performance === 'object') {
      const now = function () {
        return state.clock.t * 1000;
      };
      try {
        Object.defineProperty(self.performance, 'now', { configurable: true, value: now });
      } catch (error) {
        try {
          self.performance.now = now;
        } catch (error2) {
          // 改不动就算了
        }
      }
    }

    function impure(name) {
      const error = new Error('代码图层不能用 ' + name + '：画面必须是时间 t 的纯函数');
      error.code = 'IMPURE_CLOCK';
      throw error;
    }

    self.setTimeout = function () {
      impure('setTimeout');
    };
    self.setInterval = function () {
      impure('setInterval');
    };
    self.setImmediate = function () {
      impure('setImmediate');
    };
    self.requestAnimationFrame = function () {
      impure('requestAnimationFrame');
    };
    self.requestIdleCallback = function () {
      impure('requestIdleCallback');
    };
    self.cancelAnimationFrame = function () {};
    self.cancelIdleCallback = function () {};
  }

  // ESM 加载失败时的兜底：把 export 语法改写成普通声明
  function compileByFunction(source) {
    const exported = [];
    let body = String(source);

    body = body.replace(/export\s+default\s+/g, 'const __default__ = ');
    body = body.replace(/export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/g, function (match, isAsync, name) {
      exported.push({ exported: name, local: name });
      return (isAsync || '') + 'function ' + name;
    });
    body = body.replace(/export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g, function (match, kind, name) {
      exported.push({ exported: name, local: name });
      return kind + ' ' + name;
    });
    body = body.replace(/export\s*\{([^}]*)\}/g, function (match, inner) {
      String(inner)
        .split(',')
        .forEach(function (part) {
          const piece = part.trim();
          if (!piece) return;
          const bits = piece.split(/\s+as\s+/);
          const local = bits[0].trim();
          const name = (bits[1] || bits[0]).trim();
          exported.push({ exported: name, local: local });
        });
      return '';
    });

    const fields = exported.map(function (item) {
      return JSON.stringify(item.exported) + ': ' + item.local;
    });
    fields.push('__default__: typeof __default__ === "undefined" ? undefined : __default__');

    const factory = new Function('self', '"use strict";\n' + body + '\nreturn {' + fields.join(',') + '};');
    return factory(self);
  }

  // 先试 ESM（blob URL 动态 import），失败再退到 new Function
  async function loadModule(source) {
    let url = null;
    try {
      const blob = new Blob([String(source)], { type: 'text/javascript' });
      url = URL.createObjectURL(blob);

      let namespace = null;
      try {
        namespace = await import(url);
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

      if (typeof render !== 'function') {
        const error = new Error('模块必须导出 render(ctx2d, t, ctx) 函数');
        error.code = 'NO_RENDER';
        throw error;
      }
      if (setup !== undefined && typeof setup !== 'function') {
        const error = new Error('setup 必须是函数');
        error.code = 'INVALID_SETUP';
        throw error;
      }

      return {
        render: render,
        setup: setup || null,
        media: mediaDescriptor || null,
        transitionNeeds: transitionDescriptor === undefined ? null : transitionDescriptor,
      };
    } finally {
      if (url) {
        try {
          URL.revokeObjectURL(url);
        } catch (error) {
          // 忽略
        }
      }
    }
  }

  async function runSetup() {
    state.clock.t = 0;
    if (state.ctx) state.ctx.props = state.props;
    if (typeof state.setup === 'function') {
      await state.setup(state.props, state.ctx);
    }
    // 媒体需求在 setup 之后求值：模块常把产物放进闭包变量，声明函数要能看见它们。
    state.mediaNeeds = await collectMediaNeeds();
    state.transitionNeeds = await collectTransitionNeeds();
    return state.mediaNeeds;
  }

  async function initLayer(message) {
    state.layerId = String(message.layerId || '');
    state.width = Math.max(1, Math.round(Number(message.width) || 1));
    state.height = Math.max(1, Math.round(Number(message.height) || 1));
    state.props = message.props;
    state.fps = Number(message.fps) > 0 ? Number(message.fps) : 30;
    state.duration = Number(message.duration) > 0 ? Number(message.duration) : 0;
    state.assets = Array.isArray(message.assets) ? message.assets : [];

    canvas = new OffscreenCanvas(state.width, state.height);
    draw = canvas.getContext('2d');
    if (!draw) {
      const error = new Error('OffscreenCanvas 无法创建 2d 上下文');
      error.code = 'NO_CONTEXT';
      throw error;
    }

    installClock();

    state.media = makeMediaFacade();
    state.transition = makeTransitionFacade(null);

    state.ctx = {
      layerId: state.layerId,
      width: state.width,
      height: state.height,
      props: state.props,
      fps: state.fps,
      duration: state.duration,
      assets: state.assets,
      media: state.media,
      transition: state.transition,
      get t() {
        return state.clock.t;
      },
    };

    const loaded = await loadModule(message.moduleSource);
    state.render = loaded.render;
    state.setup = loaded.setup;
    state.mediaDescriptor = loaded.media;
    state.transitionDescriptor = loaded.transitionNeeds;

    // 按约定把渲染函数注册到 self.__layer（调试/探针用）
    self.__layer = {
      layerId: state.layerId,
      width: state.width,
      height: state.height,
      render: state.render,
      setup: state.setup,
      get props() {
        return state.props;
      },
      get t() {
        return state.clock.t;
      },
      get fps() {
        return state.fps;
      },
      get duration() {
        return state.duration;
      },
      get assets() {
        return state.assets;
      },
      get media() {
        return state.media;
      },
      get mediaNeeds() {
        return state.mediaNeeds;
      },
      get transition() {
        return state.transition;
      },
      get transitionNeeds() {
        return state.transitionNeeds;
      },
    };

    await runSetup();
  }

  async function renderFrame(message) {
    if (typeof state.render !== 'function') {
      const error = new Error('图层还没有可用的渲染函数');
      error.code = 'NOT_READY';
      throw error;
    }

    const time = Number(message.t);
    state.clock.t = Number.isFinite(time) ? time : 0;

    // 宿主每帧带来（重新 seek 过的）媒体帧；没有就清空，绝不残留上一帧。
    installMedia(message.media);
    // 邻帧同理：这一帧没有就清空，上一代的位图立即释放。
    installTransitionFrames(message.transitionFrames);
    state.transition = makeTransitionFacade(message.transition);
    if (state.ctx) state.ctx.transition = state.transition;

    if (message.fps !== undefined) {
      const fps = Number(message.fps);
      if (fps > 0) state.fps = fps;
    }
    if (message.duration !== undefined) {
      const duration = Number(message.duration);
      state.duration = duration > 0 ? duration : 0;
    }
    if (Array.isArray(message.assets)) state.assets = message.assets;

    if (state.ctx) {
      state.ctx.fps = state.fps;
      state.ctx.duration = state.duration;
      state.ctx.assets = state.assets;
    }

    // 每帧都从空白开始：结果只依赖 t，不依赖上一帧
    draw.save();
    draw.setTransform(1, 0, 0, 1, 0, 0);
    draw.clearRect(0, 0, state.width, state.height);
    draw.restore();

    await state.render(draw, state.clock.t, state.ctx);

    const bitmap = canvas.transferToImageBitmap();
    self.postMessage({ type: 'frame', id: message.id, bitmap: bitmap, t: state.clock.t }, [bitmap]);
  }

  function enqueue(task) {
    queue = queue.then(task).catch(function () {
      // 任务内部已经 post 过错误，这里只保证队列不断
    });
  }

  self.onmessage = function (event) {
    const message = (event && event.data) || {};

    if (message.type === 'init') {
      enqueue(async function () {
        try {
          await initLayer(message);
          self.postMessage({
            type: 'ready',
            id: message.id,
            mediaNeeds: state.mediaNeeds,
            transitionNeeds: state.transitionNeeds,
          });
        } catch (error) {
          postError(message.id, error, 'SETUP_FAILED', 'init');
        }
      });
      return;
    }

    if (message.type === 'props') {
      enqueue(async function () {
        try {
          state.props = message.props;
          if (state.ctx) state.ctx.props = message.props;
          await runSetup();
          self.postMessage({
            type: 'ack',
            id: message.id,
            kind: 'props',
            mediaNeeds: state.mediaNeeds,
            transitionNeeds: state.transitionNeeds,
          });
        } catch (error) {
          postError(message.id, error, 'SETUP_FAILED', 'props');
        }
      });
      return;
    }

    if (message.type === 'render') {
      enqueue(async function () {
        try {
          await renderFrame(message);
        } catch (error) {
          postError(message.id, error, 'RENDER_FAILED', 'render');
        }
      });
    }
  };
}

const WORKER_SOURCE = '(' + workerBootstrap.toString() + ')();';

/**
 * 创建一个代码图层。
 *
 * @param {object} options
 * @param {string} options.layerId
 * @param {string} options.moduleSource  ESM 源码（setup / render）
 * @param {unknown} [options.props]
 * @param {number} options.width
 * @param {number} options.height
 * @param {Array} [options.assets]    本工程素材浅清单（env.assets）
 * @param {number} [options.fps=30]
 * @param {number} [options.duration] 片段时长（env.duration）
 * @param {number} [options.renderTimeoutMs=5000]  单帧超时（测试可调小）
 * @param {number} [options.setupTimeoutMs=30000]  setup 超时（测试可调小）
 * @returns {{render: (t:number)=>Promise<void>, canvas: ()=>HTMLCanvasElement|null,
 *            props: ()=>unknown, update: (patch:{moduleSource?:string, props?:unknown})=>Promise<void>,
 *            dispose: ()=>void, ready: ()=>Promise<void>}}
 */
export function createCodeLayer(options = {}) {
  const layerId = String(options.layerId || 'code-layer');
  const width = Math.round(Number(options.width));
  const height = Math.round(Number(options.height));
  const moduleSource = options.moduleSource;

  if (typeof moduleSource !== 'string') {
    throw new CodeLayerError('INVALID_ARG', 'moduleSource 必须是字符串');
  }
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new CodeLayerError('INVALID_ARG', 'width/height 必须是正数');
  }
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new CodeLayerError('NO_DOCUMENT', '代码图层需要主线程 document');
  }

  const renderTimeoutMs = Number(options.renderTimeoutMs) > 0 ? Number(options.renderTimeoutMs) : DEFAULT_RENDER_TIMEOUT_MS;
  const setupTimeoutMs = Number(options.setupTimeoutMs) > 0 ? Number(options.setupTimeoutMs) : DEFAULT_SETUP_TIMEOUT_MS;

  const canvasEl = document.createElement('canvas');
  canvasEl.width = width;
  canvasEl.height = height;

  let currentSource = moduleSource;
  let currentProps = options.props;
  // 宿主（主线程）从这里读到模块声明的媒体需求，再去准备帧。
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

  const pending = new Map();

  function take(id) {
    const entry = pending.get(id);
    if (!entry) return null;
    pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    return entry;
  }

  function failAll(error) {
    const entries = Array.from(pending.values());
    pending.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  function request(message, options2) {
    const opts = options2 || {};
    return new Promise((resolve, reject) => {
      if (disposed) {
        reject(new CodeLayerError('DISPOSED', '图层已销毁'));
        return;
      }
      if (fatalError) {
        reject(fatalError);
        return;
      }
      if (!worker) {
        reject(new CodeLayerError('NOT_READY', '图层没有可用的 Worker'));
        return;
      }

      const activeWorker = worker;
      const id = nextMessageId++;
      const entry = { id: id, kind: opts.kind || '', resolve: resolve, reject: reject, timer: null };

      if (opts.timeoutMs > 0) {
        entry.timer = setTimeout(function () {
          if (pending.get(id) !== entry) return;
          pending.delete(id);
          const message2 =
            opts.timeoutCode === 'RENDER_TIMEOUT'
              ? 'render 超过 ' + opts.timeoutMs + 'ms 未返回'
              : 'setup 超过 ' + opts.timeoutMs + 'ms 未完成';
          const error = new CodeLayerError(opts.timeoutCode, message2);
          reject(error);
          // 卡死的图层不能留着继续吃帧
          if (opts.disposeOnTimeout !== false) dispose();
        }, opts.timeoutMs);
      }

      pending.set(id, entry);
      try {
        const payload = Object.assign({}, message, { id: id });
        if (opts.transfer && opts.transfer.length) activeWorker.postMessage(payload, opts.transfer);
        else activeWorker.postMessage(payload);
      } catch (error) {
        take(id);
        reject(new CodeLayerError('POST_FAILED', '向 Worker 发送消息失败：' + (error && error.message ? error.message : error)));
      }
    });
  }

  function paintBitmap(bitmap) {
    const context = canvasEl.getContext('2d');
    if (!context) throw new CodeLayerError('NO_CONTEXT', '主线程画布无法创建 2d 上下文');
    if (typeof context.transferFromImageBitmap === 'function') {
      context.transferFromImageBitmap(bitmap);
      return;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }

  function settleFrame(message) {
    const entry = take(message.id);
    if (!entry) {
      if (message.bitmap && typeof message.bitmap.close === 'function') message.bitmap.close();
      return;
    }
    try {
      paintBitmap(message.bitmap);
      entry.resolve();
    } catch (error) {
      if (message.bitmap && typeof message.bitmap.close === 'function') message.bitmap.close();
      entry.reject(error instanceof CodeLayerError ? error : new CodeLayerError('DRAW_FAILED', '主线程绘制位图失败：' + (error && error.message ? error.message : error)));
    }
  }

  function onWorkerMessage(event) {
    const message = event && event.data;
    if (!message || typeof message !== 'object') return;

    if (message.type === 'frame') {
      settleFrame(message);
      return;
    }
    if (message.type === 'ready' || message.type === 'ack') {
      if (Array.isArray(message.mediaNeeds)) latestMediaNeeds = message.mediaNeeds;
      if (message.transitionNeeds && typeof message.transitionNeeds === 'object') {
        latestTransitionNeeds = {
          prev: !!message.transitionNeeds.prev,
          next: !!message.transitionNeeds.next,
          composed: message.transitionNeeds.composed || false,
        };
      }
      const entry = take(message.id);
      if (entry) entry.resolve({ mediaNeeds: latestMediaNeeds, transitionNeeds: latestTransitionNeeds });
      return;
    }
    if (message.type === 'error') {
      const error = new CodeLayerError(
        message.code || 'WORKER_ERROR',
        message.message || message.code || 'Worker 报错',
        message.phase ? { phase: message.phase } : undefined,
      );
      if (message.id === undefined || message.id === null) {
        fatalError = error;
        failAll(error);
        return;
      }
      const entry = take(message.id);
      if (entry) entry.reject(error);
    }
  }

  function onWorkerError(event) {
    fatalError = new CodeLayerError('WORKER_ERROR', (event && event.message) || 'Worker 运行时错误');
    failAll(fatalError);
  }

  function onWorkerMessageError() {
    fatalError = new CodeLayerError('WORKER_MESSAGE_ERROR', 'Worker 消息反序列化失败');
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
        // 忽略
      }
      worker = null;
    }
    if (workerUrl) {
      try {
        URL.revokeObjectURL(workerUrl);
      } catch (error) {
        // 忽略
      }
      workerUrl = null;
    }
    failAll(new CodeLayerError(code || 'DISPOSED', message || '图层已销毁'));
  }

  function startInit() {
    fatalError = null;

    const blob = new Blob([WORKER_SOURCE], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    let activeWorker = null;
    try {
      activeWorker = new Worker(url);
    } catch (error) {
      try {
        URL.revokeObjectURL(url);
      } catch (error2) {
        // 忽略
      }
      throw new CodeLayerError('WORKER_BLOCKED', '无法创建 Worker：' + (error && error.message ? error.message : error));
    }

    worker = activeWorker;
    workerUrl = url;
    worker.onmessage = onWorkerMessage;
    worker.onerror = onWorkerError;
    worker.onmessageerror = onWorkerMessageError;

    initPromise = request(
      {
        type: 'init',
        layerId: layerId,
        moduleSource: currentSource,
        props: currentProps,
        width: width,
        height: height,
        assets: currentAssets,
        fps: currentFps,
        duration: currentDuration,
      },
      { kind: 'init', timeoutMs: setupTimeoutMs, timeoutCode: 'SETUP_TIMEOUT' },
    ).then(function (value) {
      return value;
    });
    // 没人 await ready() 时也不要产生未处理拒绝
    initPromise.catch(function () {});
  }

  /**
   * 渲染一帧。
   *
   * @param {number} t 图层局部时间（秒）
   * @param {object} [frame] 可选的这一帧上下文：
   *   media   —— [{ id, kind:'video'|'image', bitmap, width, height, time }]，位图会 transfer 给 worker
   *   assets  —— 本工程素材浅清单（见 docs/code-layer-media.md）
   *   fps / duration —— 时间信息
   */
  function render(t, frame) {
    const time = Number(t);
    const ctx = frame && typeof frame === 'object' ? frame : {};
    const media = Array.isArray(ctx.media) ? ctx.media : [];
    const transitionFrames = Array.isArray(ctx.transitionFrames) ? ctx.transitionFrames : [];

    const task = renderChain.then(async function () {
      if (disposed) throw new CodeLayerError('DISPOSED', '图层已销毁');
      if (fatalError) throw fatalError;
      if (!Number.isFinite(time)) throw new CodeLayerError('INVALID_ARG', 't 必须是数字（秒）');
      await initPromise;

      const transfer = [];
      const seen = new Set();
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
            type: 'render',
            t: time,
            media: media,
            assets: Array.isArray(ctx.assets) ? ctx.assets : currentAssets,
            fps: ctx.fps === undefined ? currentFps : ctx.fps,
            duration: ctx.duration === undefined ? currentDuration : ctx.duration,
            transition: ctx.transition || null,
            transitionFrames: transitionFrames,
          },
          { kind: 'render', timeoutMs: renderTimeoutMs, timeoutCode: 'RENDER_TIMEOUT', transfer: transfer },
        );
      } catch (error) {
        // 没送出去的位图要自己释放，否则每次都漏一帧
        for (const bitmap of transfer) {
          if (bitmap && typeof bitmap.close === 'function') {
            try {
              bitmap.close();
            } catch (error2) {
              /* 忽略 */
            }
          }
        }
        throw error;
      }
    });
    renderChain = task.catch(function () {});
    return task;
  }

  function update(patch = {}) {
    if (patch === null || typeof patch !== 'object') {
      return Promise.reject(new CodeLayerError('INVALID_ARG', 'update 需要一个对象'));
    }
    const hasSource = patch.moduleSource !== undefined;
    const hasProps = patch.props !== undefined;

    if (hasSource && typeof patch.moduleSource !== 'string') {
      return Promise.reject(new CodeLayerError('INVALID_ARG', 'moduleSource 必须是字符串'));
    }

    const task = updateChain.then(async function () {
      if (disposed) throw new CodeLayerError('DISPOSED', '图层已销毁');
      if (fatalError) throw fatalError;

      if (hasSource) {
        // 整层重建：换源码意味着旧模块的闭包全部作废
        currentSource = patch.moduleSource;
        if (hasProps) currentProps = patch.props;
        killWorker('REBUILDING', '图层正在重建');
        startInit();
        await initPromise;
        return;
      }

      if (hasProps) {
        currentProps = patch.props;
        await initPromise;
        await request({ type: 'props', props: currentProps }, { kind: 'props', timeoutMs: setupTimeoutMs, timeoutCode: 'SETUP_TIMEOUT' });
      }
    });
    updateChain = task.catch(function () {});
    return task;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    killWorker('DISPOSED', '图层已销毁');
    canvasEl.width = 0;
    canvasEl.height = 0;
  }

  startInit();

  return {
    render: render,
    canvas: function () {
      return disposed ? null : canvasEl;
    },
    props: function () {
      return currentProps;
    },
    /** 模块声明的媒体需求（[{id}]）；宿主据此准备帧。老卡片没有声明时是空数组。 */
    mediaNeeds: function () {
      return latestMediaNeeds.map(function (need) {
        return { id: need.id };
      });
    },
    /** 模块声明的邻帧需求（{prev,next}）；没声明时两侧都是 false。 */
    transitionNeeds: function () {
      return {
        prev: !!latestTransitionNeeds.prev,
        next: !!latestTransitionNeeds.next,
        composed: latestTransitionNeeds.composed || false,
      };
    },
    update: update,
    dispose: dispose,
    ready: function () {
      return initPromise;
    },
  };
}
