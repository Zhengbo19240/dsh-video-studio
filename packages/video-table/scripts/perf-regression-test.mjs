#!/usr/bin/env node
/**
 * 媒体卡性能回归（四张超预算卡：sc-transition-travel / tc-bed-echo-blur /
 * sc-crash-zoom-punch / sc-page-waterfall-wall）。
 *
 *   node scripts/perf-regression-test.mjs
 *
 * 它查四件事：
 *   1) 卡片还能不能被加载、t 越界和无素材时会不会抛（离线跑，用桩 canvas）；
 *   2) 「预烘/预缩放缓存」的语义 —— 同源同尺寸第二次不再重建离屏位图
 *      （用桩 OffscreenCanvas 数分配次数，断言的是行为而不是别的地方的注释）；
 *   3) 视觉等价 —— 用 .build/perf/samples 里改前/改后的同 t 帧算 MAD，断言 < 0.01；
 *   4) 预算 —— tools/recipes/media-perf.json 里这四张的 p50 ≤ 16ms，
 *      或者明确标了 stillOverBudget 并给了原因。
 *
 * 这个脚本不跑浏览器：帧对照样张由 `node .build/perf/snapshot.mjs` 生成（改前 vs 改后）。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LIB = process.env.DSH_MOTION_LIB || path.join(os.homedir(), '.dsh', 'motion-lib');
const SAMPLES = path.join(ROOT, '.build', 'perf', 'samples');
const BUDGET = 16;
const CARDS = ['sc-transition-travel', 'tc-bed-echo-blur', 'sc-crash-zoom-punch', 'sc-page-waterfall-wall'];

let pass = 0;
const failures = [];
function ok(name, detail = '') {
  pass += 1;
  console.log(`  ok   ${name}${detail ? '  ·  ' + detail : ''}`);
}
function assert(name, cond, detail = '') {
  if (cond) ok(name, detail);
  else {
    failures.push(name + (detail ? '  ·  ' + detail : ''));
    console.log(`  FAIL ${name}${detail ? '  ·  ' + detail : ''}`);
  }
}

// ---------------------------------------------------------------- 桩 canvas ----

const DATA_PROPS = {
  filter: 'none',
  fillStyle: '#000',
  strokeStyle: '#000',
  globalAlpha: 1,
  globalCompositeOperation: 'source-over',
  font: '10px sans-serif',
  textAlign: 'start',
  textBaseline: 'alphabetic',
  lineWidth: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  shadowColor: 'transparent',
  shadowBlur: 0,
  shadowOffsetX: 0,
  shadowOffsetY: 0,
  imageSmoothingEnabled: true,
  imageSmoothingQuality: 'low',
};

function makeCtx() {
  const state = { ...DATA_PROPS };
  const noop = () => {};
  const api = {
    canvas: null,
    save() { api.saved.push({ ...state }); },
    restore() { const s = api.saved.pop(); if (s) Object.assign(state, s); },
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    putImageData: noop,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }),
    measureText: (t) => ({ width: String(t).length * 7 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    roundRect: noop,
    rect: noop,
    beginPath: noop,
    closePath: noop,
    clip: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    fillText: noop,
    strokeText: noop,
    drawImage: noop,
    save2: noop,
    translate: noop,
    scale: noop,
    rotate: noop,
    transform: noop,
    setTransform: noop,
    resetTransform: noop,
    setLineDash: noop,
    lineTo: noop,
    moveTo: noop,
    arc: noop,
    ellipse: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    saved: [],
  };
  return new Proxy(api, {
    get(target, prop) {
      if (prop in state) return state[prop];
      if (prop in target) return target[prop];
      // 未知方法一律当空实现（卡片里还有各种零碎调用）
      return typeof prop === 'symbol' ? undefined : noop;
    },
    set(target, prop, value) {
      state[prop] = value;
      return true;
    },
  });
}

let offscreenCreated = 0;
class StubOffscreenCanvas {
  constructor(w, h) {
    this.width = Math.max(1, Math.round(w || 1));
    this.height = Math.max(1, Math.round(h || 1));
    this._ctx = makeCtx();
    this._ctx.canvas = this;
    offscreenCreated += 1;
  }
  getContext() { return this._ctx; }
}

const ORIG = { OffscreenCanvas: globalThis.OffscreenCanvas, document: globalThis.document };
globalThis.OffscreenCanvas = StubOffscreenCanvas;
globalThis.document = {
  createElement: (tag) => (tag === 'canvas'
    ? Object.assign(new StubOffscreenCanvas(1, 1), { getContext: () => makeCtx() })
    : {}),
};

// ---------------------------------------------------------------- 加载卡片 ----

function toFunctionBody(source) {
  return String(source)
    .replace(/export\s+default\s+/g, 'const __default__ = ')
    .replace(/export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/g, (m, isAsync, name) => `${isAsync || ''}function ${name}`)
    .replace(/export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g, (m, kind, name) => `${kind} ${name}`)
    .replace(/export\s*\{[^}]*\}/g, '');
}

const sources = {};
async function loadCard(id) {
  const file = path.join(LIB, id, 'code.js');
  const source = await fs.readFile(file, 'utf8');
  sources[id] = source;
  const body = toFunctionBody(source) +
    '\nreturn { render: typeof render === "function" ? render : null, media: typeof media === "function" ? media : null };';
  return { api: new Function(body)(), source };
}

function makeMedia() {
  const bitmap = { width: 1600, height: 900, __stub: 'bitmap' };
  return {
    bitmap,
    facade: {
      has: () => true,
      video: () => bitmap,
      image: () => bitmap,
      size: () => ({ width: 1600, height: 900 }),
      kind: () => 'video',
      time: () => 0,
    },
  };
}

function envFor(width, height, duration, withMedia) {
  const media = makeMedia();
  return {
    width, height, fps: 30, duration,
    props: withMedia ? { assetId: 'stub-media' } : {},
    assets: [],
    media: withMedia ? media.facade : null,
    __bitmap: media.bitmap,
  };
}

function durationOf(source) {
  const m = /duration\s*:\s*([\d.]+)/.exec(source);
  return m ? Number(m[1]) : 3;
}

// ---------------------------------------------------------------- 断言 ----

async function main() {
  console.log('四张超预算卡的性能回归：\n');
  console.log('[1] 可加载 / 越界 / 无素材');

  const loaded = {};
  for (const id of CARDS) {
    const { api, source } = await loadCard(id);
    loaded[id] = { api, source, duration: durationOf(source) };
    assert(`${id} 能解析出 render`, typeof api.render === 'function');
  }

  for (const id of CARDS) {
    const { api, duration } = loaded[id];
    let threw = null;
    for (const t of [-5, 0, duration / 2, duration + 5, Number.NaN]) {
      const ctx = makeCtx();
      try {
        api.render(ctx, t, envFor(1920, 1080, duration, true));
      } catch (e) {
        threw = `t=${t}: ${e && e.message}`;
        break;
      }
    }
    assert(`${id} t 越界不抛`, !threw, threw || 't = -5 / 0 / 半程 / +5 / NaN');
  }

  for (const id of CARDS) {
    const { api, duration } = loaded[id];
    let threw = null;
    try {
      for (let i = 0; i < 3; i += 1) {
        api.render(makeCtx(), duration * ((i + 0.5) / 3), envFor(1920, 1080, duration, false));
      }
    } catch (e) {
      threw = e && e.message;
    }
    assert(`${id} 无素材不抛`, !threw, threw || 'env.media = null');
  }

  console.log('\n[2] 预缩放 / 预烘缓存：同源同尺寸不重建');

  // 瀑布墙：同一源、同一 t 渲两帧 —— 第二帧不该再新建离屏列条
  {
    const { api, duration } = loaded['sc-page-waterfall-wall'];
    const env = envFor(1920, 1080, duration, true);
    api.render(makeCtx(), duration * 0.5, env);           // 预热：可能需要建缓存
    const before = offscreenCreated;
    const ctx = makeCtx();
    api.render(ctx, duration * 0.5, env);
    assert('瀑布墙：同源同尺寸第二帧不重建列条', offscreenCreated === before,
      `离屏新建 ${offscreenCreated - before} 个`);

    const mid = offscreenCreated;
    for (let i = 0; i < 6; i += 1) api.render(makeCtx(), duration * (0.2 + i * 0.1), env);
    assert('瀑布墙：整镜不新建离屏（没有每帧分配）', offscreenCreated === mid,
      `离屏新建 ${offscreenCreated - mid} 个`);
  }

  // 底床模糊：连续 5 帧只建一次离屏层
  {
    const { api, duration } = loaded['tc-bed-echo-blur'];
    const env = envFor(1920, 1080, duration, true);
    api.render(makeCtx(), 1.0, env);
    const before = offscreenCreated;
    for (let i = 0; i < 5; i += 1) api.render(makeCtx(), 1.0 + i * 0.3, env);
    assert('模糊底床：连续 5 帧复用同一张离屏 canvas', offscreenCreated === before,
      `离屏新建 ${offscreenCreated - before} 个`);
  }

  // 盖板模糊：小图 + 模糊草稿纸都该复用
  {
    const { api, duration } = loaded['sc-transition-travel'];
    const env = envFor(1920, 1080, duration, true);
    // 先跑到模糊生效的帧（急推中段），把两张离屏都建出来
    api.render(makeCtx(), 2.55, env);
    const before = offscreenCreated;
    for (let i = 0; i < 4; i += 1) api.render(makeCtx(), 2.55 + i * 0.05, env);
    assert('旅行转场：盖板小图与模糊草稿纸不每帧新建', offscreenCreated === before,
      `离屏新建 ${offscreenCreated - before} 个`);
  }

  console.log('\n[3] 视觉等价：改前 / 改后同 t 帧的 MAD');

  const manifestFile = path.join(SAMPLES, 'manifest.json');
  let manifest = null;
  try {
    manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  } catch {
    manifest = null;
  }
  assert('存在改前/改后帧对照清单', Boolean(manifest),
    manifest ? path.relative(ROOT, manifestFile) : '先跑 node .build/perf/snapshot.mjs');

  if (manifest) {
    const diffs = manifest.diffs || [];
    const byCard = new Map();
    for (const d of diffs) {
      if (!byCard.has(d.id)) byCard.set(d.id, []);
      byCard.get(d.id).push(d);
    }
    for (const id of CARDS) {
      const rows = byCard.get(id) || [];
      const worst = rows.reduce((m, r) => Math.max(m, r.mad), 0);
      assert(`${id} 每对样张 MAD < 0.01`, rows.length > 0 && worst < 0.01,
        rows.length ? `最差 ${worst}` : '没有样张');
    }

    // 自己再算一遍：不采信 manifest 里的数，直接从落盘的 640×360 RGBA 算
    let worstSelf = 0;
    let pairs = 0;
    for (const d of diffs) {
      const tag = `${d.id}@${Number(d.t).toFixed(2)}`;
      const a = path.join(SAMPLES, 'vec', `${tag}-before.rgba`);
      const b = path.join(SAMPLES, 'vec', `${tag}-after.rgba`);
      let bufA;
      let bufB;
      try {
        bufA = await fs.readFile(a);
        bufB = await fs.readFile(b);
      } catch {
        continue;
      }
      if (bufA.length !== bufB.length) continue;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < bufA.length; i += 4) {
        for (let c = 0; c < 3; c += 1) {
          sum += Math.abs(bufA[i + c] - bufB[i + c]);
          n += 1;
        }
      }
      worstSelf = Math.max(worstSelf, sum / n / 255);
      pairs += 1;
    }
    assert('独立复算的 MAD 也 < 0.01（12 对样本）', pairs >= 12 && worstSelf < 0.01,
      `${pairs} 对，最差 ${worstSelf.toFixed(5)}`);
  }

  console.log('\n[4] 预算：media-perf.json');

  const perfFile = path.join(ROOT, 'tools', 'recipes', 'media-perf.json');
  const perf = JSON.parse(await fs.readFile(perfFile, 'utf8'));
  assert('media-perf.json 记了 optimizedAt', Boolean(perf.optimizedAt), String(perf.optimizedAt || ''));
  for (const id of CARDS) {
    const row = perf.perCard && perf.perCard[id];
    if (!row) {
      assert(`${id} 在 media-perf.json 里有条目`, false, '缺条目');
      continue;
    }
    const under = row.p50 <= BUDGET && row.withMedia.p50 <= BUDGET;
    if (under) {
      assert(`${id} p50 ≤ ${BUDGET}ms（无素材 / 有素材）`, true, `${row.p50} / ${row.withMedia.p50} ms`);
    } else {
      assert(`${id} 超预算被显式登记`, row.stillOverBudget === true && Boolean(row.stillOverBudgetReason),
        `${row.p50} / ${row.withMedia.p50} ms · ${row.stillOverBudgetReason || '没写原因'}`);
    }
  }

  // 指纹：四张卡的 codeFingerprint 必须与磁盘一致，防止改了卡忘了更新台账
  for (const id of CARDS) {
    const stat = await fs.stat(path.join(LIB, id, 'code.js'));
    const fp = `${Math.round(stat.mtimeMs)}:${stat.size}`;
    const row = perf.perCard && perf.perCard[id];
    assert(`${id} 台账指纹与磁盘一致`, Boolean(row) && row.codeFingerprint === fp,
      row ? `${row.codeFingerprint} vs ${fp}` : '缺条目');
  }

  console.log(`\n${failures.length ? '✗' : '✓'} ${pass} 条通过，${failures.length} 条失败`);
  if (failures.length) {
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.OffscreenCanvas = ORIG.OffscreenCanvas;
    globalThis.document = ORIG.document;
  });
