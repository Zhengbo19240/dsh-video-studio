/**
 * 动效缩略图：把动效库里的 ESM 源码放到一次性 Worker + OffscreenCanvas 里，
 * 渲染一帧后转成 dataURL。
 *
 * 这里刻意不复用 code-layer.js：
 *   - 代码图层要长时间活着、按播放头反复 seek；
 *   - 缩略图只渲染一帧，渲染完立刻回收 Worker，生命周期完全不同。
 *
 * 约定与代码图层一致：源码必须导出 render(ctx, t, env)，画面是 t 的纯函数。
 * 任何失败都只影响这一张缩略图，不会把列表带崩。
 */

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_PARALLEL = 3;

/** 成功渲染过的缩略图；键里带尺寸，避免 64×36 与 320×180 互相覆盖。 */
const cache = new Map();
/** 正在渲染的 Promise，同一张图被多个组件同时请求时只跑一次。 */
const pending = new Map();
/** 简单并发闸门：列表里十几条一起挂载时，不要把 CPU 一次打满。 */
const queue = [];
let activeCount = 0;

/** 生成缓存键：同一个条目 id + 时间 t + 尺寸只渲染一次。 */
export function thumbCacheKey(id, width, height, t) {
  return `${String(id)}@${Number(t).toFixed(3)}@${Math.round(width)}x${Math.round(height)}`;
}

/** 取已经渲染好的缩略图；没有就返回 null。 */
export function getCachedThumb(id, width, height, t) {
  return cache.get(thumbCacheKey(id, width, height, t)) || null;
}

/** 清空缩略图缓存（测试或切换工程时用）。 */
export function clearThumbCache() {
  cache.clear();
  pending.clear();
  queue.length = 0;
}

/** 去掉行注释和块注释，避免把注释里的“export function render”当真。 */
function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n\r]*/g, '$1');
}

/**
 * 静态检查源码里有没有 render 导出。
 * 这里只做“有没有”的粗筛；真正的函数类型由 Worker 里加载模块后再确认。
 */
export function hasRenderExport(sourceCode) {
  const body = stripComments(sourceCode);
  return (
    /export\s+(?:async\s+)?function\s+render\s*\(/.test(body) ||
    /export\s+(?:const|let|var)\s+render\s*=/.test(body) ||
    /export\s*\{[^}]*\brender\b[^}]*\}/.test(body) ||
    /export\s+default\s+(?:async\s+)?function\s+render\s*\(/.test(body) ||
    /export\s+default\s*\{[\s\S]*?\brender\s*:/.test(body)
  );
}

/** 没有 render 导出时抛出带中文 message 的 Error。 */
export function assertRenderSource(sourceCode) {
  if (typeof sourceCode !== 'string' || !sourceCode.trim()) {
    throw new Error('动效源码为空，无法生成缩略图');
  }
  if (!hasRenderExport(sourceCode)) {
    throw new Error('动效源码没有导出 render(ctx, t, env) 函数，无法生成缩略图');
  }
}

/** 仅用于测试的稳定 id；正式调用会传 item.id。 */
function hashSource(source) {
  let hash = 2166136261;
  const text = String(source);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Worker 内的引导脚本。
 * 用 function.toString() 注入，必须完全自包含，不能引用本模块其它变量。
 */
function workerBootstrap() {
  'use strict';

  function errorText(error) {
    if (error && error.message) return String(error.message);
    return String(error);
  }

  // ESM 动态 import 被 CSP 拦下时的兜底：把 export 语法改写成普通声明。
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

  async function loadModule(source) {
    let url = null;
    try {
      const blob = new Blob([String(source)], { type: 'text/javascript' });
      url = URL.createObjectURL(blob);

      let namespace;
      try {
        namespace = await import(url);
      } catch (importError) {
        namespace = compileByFunction(source);
      }

      let render = namespace && namespace.render;
      if (!render && namespace && namespace.default && namespace.default.render) {
        render = namespace.default.render;
      }
      if (typeof render !== 'function') {
        const error = new Error('动效源码必须导出 render(ctx, t, env) 函数');
        error.code = 'NO_RENDER';
        throw error;
      }
      return render;
    } finally {
      if (url) {
        try {
          URL.revokeObjectURL(url);
        } catch (error) {
          /* 忽略 */
        }
      }
    }
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result || ''));
      };
      reader.onerror = function () {
        reject(reader.error || new Error('缩略图转 dataURL 失败'));
      };
      reader.readAsDataURL(blob);
    });
  }

  self.onmessage = async function (event) {
    const message = (event && event.data) || {};
    if (message.type !== 'render') return;

    const width = Math.max(1, Math.round(Number(message.width) || 1));
    const height = Math.max(1, Math.round(Number(message.height) || 1));
    const time = Number(message.t);

    try {
      if (!Number.isFinite(time)) throw new Error('缩略图时间 t 必须是数字');
      if (typeof OffscreenCanvas !== 'function') throw new Error('当前环境不支持 OffscreenCanvas');

      const canvas = new OffscreenCanvas(width, height);
      const draw = canvas.getContext('2d');
      if (!draw) throw new Error('OffscreenCanvas 无法创建 2d 上下文');

      const render = await loadModule(message.source);

      const props = message.props && typeof message.props === 'object' ? message.props : {};
      const env = {
        width: width,
        height: height,
        props: props,
        t: time,
      };

      draw.save();
      draw.setTransform(1, 0, 0, 1, 0, 0);
      draw.clearRect(0, 0, width, height);
      try {
        await render(draw, time, env);
      } finally {
        draw.restore();
      }

      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const dataUrl = await blobToDataUrl(blob);
      if (!dataUrl) throw new Error('缩略图是空的');
      self.postMessage({ type: 'result', id: message.id, dataUrl: dataUrl });
    } catch (error) {
      self.postMessage({
        type: 'error',
        id: message.id,
        code: (error && error.code) || 'THUMB_FAILED',
        message: errorText(error),
      });
    }
  };
}

const WORKER_SOURCE = '(' + workerBootstrap.toString() + ')();';

/** 排队执行，限制同时在跑的 Worker 数量。 */
function schedule(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task: task, resolve: resolve, reject: reject });
    pump();
  });
}

function pump() {
  while (activeCount < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    activeCount += 1;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        activeCount -= 1;
        pump();
      });
  }
}

/** 真正的渲染：起草 Worker，超时/出错都终止它。 */
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
          /* 忽略 */
        }
        worker = null;
      }
      if (blobUrl) {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch (error) {
          /* 忽略 */
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
      if (typeof Worker !== 'function') throw new Error('当前环境不支持 Worker');
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        throw new Error('当前环境不支持 Blob URL');
      }
      const blob = new Blob([WORKER_SOURCE], { type: 'text/javascript' });
      blobUrl = URL.createObjectURL(blob);
      worker = new Worker(blobUrl);
    } catch (error) {
      finish(new Error('缩略图 Worker 创建失败：' + (error && error.message ? error.message : error)));
      return;
    }

    timer = setTimeout(() => {
      finish(new Error(`缩略图渲染超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    worker.onmessage = (event) => {
      const message = (event && event.data) || {};
      if (message.type === 'result' && message.dataUrl) {
        finish(null, String(message.dataUrl));
        return;
      }
      if (message.type === 'error') {
        finish(new Error('缩略图渲染失败：' + (message.message || message.code || '未知错误')));
      }
    };
    worker.onerror = (event) => {
      const detail = event && event.message ? event.message : 'Worker 内部错误';
      finish(new Error('缩略图渲染失败：' + detail));
    };
    worker.onmessageerror = () => {
      finish(new Error('缩略图渲染失败：Worker 消息无法反序列化'));
    };

    worker.postMessage({
      type: 'render',
      source: sourceCode,
      width: width,
      height: height,
      t: t,
      props: {},
    });
  });
}

/**
 * 渲染一张动效缩略图。
 *
 * @param {string} sourceCode ESM 源码，必须导出 render(ctx, t, env)
 * @param {number} width
 * @param {number} height
 * @param {number} t 时间（秒）
 * @param {{ id?: string, timeoutMs?: number, renderImpl?: Function }} [options]
 *        id 用于缓存键；renderImpl 只给 Node 测试注入假渲染器。
 * @returns {Promise<string>} dataURL
 */
export function renderThumb(sourceCode, width, height, t, ...rest) {
  const options = rest.length ? rest[0] : undefined;
  const opts = typeof options === 'string' ? { id: options } : options || {};
  const w = Math.max(1, Math.round(Number(width) || 1));
  const h = Math.max(1, Math.round(Number(height) || 1));
  const time = Number(t);
  const id = opts.id ? String(opts.id) : 'source:' + hashSource(sourceCode);
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const renderImpl = typeof opts.renderImpl === 'function' ? opts.renderImpl : renderWithWorker;

  if (!Number.isFinite(time)) {
    return Promise.reject(new Error('缩略图时间 t 必须是数字'));
  }

  try {
    assertRenderSource(sourceCode);
  } catch (error) {
    return Promise.reject(error);
  }

  const key = thumbCacheKey(id, w, h, time);
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (pending.has(key)) return pending.get(key);

  const task = schedule(() => renderImpl(sourceCode, w, h, time, timeoutMs))
    .then((dataUrl) => {
      if (typeof dataUrl !== 'string' || !dataUrl) throw new Error('缩略图渲染结果不是 dataURL');
      cache.set(key, dataUrl);
      return dataUrl;
    })
    .finally(() => {
      pending.delete(key);
    });

  pending.set(key, task);
  return task;
}
