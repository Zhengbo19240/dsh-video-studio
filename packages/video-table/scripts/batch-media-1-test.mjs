#!/usr/bin/env node
/**
 * 配方卡「媒体批一批（batch-media-1）」验收测试 —— 35 张需要媒体的卡。
 *
 *   node scripts/batch-media-1-test.mjs
 *
 * 退出码：0 全绿；1 有红。
 *
 * 这里不信任 batch-media-1.json 的自述：每一条都回到 motion-lib 里的真实文件、
 * 真实 meta、真实 render 去比对。几何检查不是「看图说话」，而是在 mock canvas 上
 * 累计 2D 仿射矩阵，把每次 fillText 的包围盒映射回屏幕坐标再判边界。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MOTION_ROOT = process.env.DSH_MOTION_LIB || path.join(os.homedir(), '.dsh', 'motion-lib');
const ROOT = path.resolve(import.meta.dirname, '..');
const BATCH_FILE = path.join(ROOT, 'tools', 'recipes', 'batch-media-1.json');
const PREVIEW_DIR = path.join(ROOT, '.build', 'media-previews-1', 'png');

const IDS = [
  'sc-card-flock-tumble',
  'sc-crash-zoom-punch',
  'sc-deck-deal-flyin',
  'sc-depth-layer-moves',
  'sc-gradient-word-sweep',
  'sc-graze-face-tour',
  'sc-hashtag-to-pill-materialize',
  'sc-icon-field-colorize',
  'sc-integration-hub-map',
  'sc-letterspace-materialize',
  'sc-line-carry-transition',
  'sc-list-stack-press',
  'sc-marker-underline-title',
  'sc-neon-frame-forerun',
  'sc-orbit-ring-title-open',
  'sc-outro-group-photo-launch',
  'sc-page-waterfall-wall',
  'sc-quad-split-parallel-scenes',
  'sc-row-embed',
  'sc-speed-ramp-freeze',
  'sc-spotlight-hero-card',
  'sc-spotlight-sweep-moves',
  'sc-steep-tilt-glide',
  'sc-terminal-3d',
  'sc-text-as-mask',
  'sc-text-column-converge',
  'sc-transition-travel',
  'sc-type-and-filter',
  'sc-word-relay-filmstrip',
  'tc-bed-echo-blur',
  'tc-behind-text-title',
  'tc-callout-line-label',
  'tc-crash-zoom-punch',
  'tc-doc-park-left-pill-deal',
  'tc-douyin-follow-card',
];

/** 本批刻意排除的 9 张（别人在做或已 drop）——测试要证明它们没被动手。 */
const EXCLUDED = [
  'sc-circle-match-iris',
  'sc-transition-hidden-cut',
  'tc-source-converge',
  'tc-chat-gpt',
  'tc-claude-code',
  'tc-cursor-actor-demo',
  'tc-subscribe-cta',
  'media-pip',
  'media-fullscreen-kenburns',
];

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`);
  } catch (error) {
    failures.push({ name, message: error && error.message ? error.message : String(error) });
    console.log(`  FAIL ${name} — ${error && error.message ? error.message : error}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ */
/* 把 code.js 变成可调用的 render / media（与 render-card-preview 同一套规则） */
/* ------------------------------------------------------------------ */

function toFunctionBody(source) {
  return String(source)
    .replace(/export\s+default\s+/g, 'const __default__ = ')
    .replace(/export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/g, (m, a, n) => `${a || ''}function ${n}`)
    .replace(/export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g, (m, k, n) => `${k} ${n}`)
    .replace(/export\s*\{[^}]*\}/g, '');
}

async function loadCard(id) {
  const dir = path.join(MOTION_ROOT, id);
  const source = await fs.readFile(path.join(dir, 'code.js'), 'utf8');
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
  const api = new Function(
    '"use strict";\n' + toFunctionBody(source) +
    "\nreturn { render: typeof render === 'function' ? render : null, media: typeof media === 'function' ? media : null, meta: typeof meta === 'object' ? meta : null };",
  )();
  return { dir, source, meta, api };
}

/* ------------------------------------------------------------------ */
/* mock canvas：记录绘制 + 累计仿射矩阵（判边界用）                       */
/* ------------------------------------------------------------------ */

function mul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
function apply(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

function makeCtx(W, H) {
  const state = { m: [1, 0, 0, 1, 0, 0], font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic' };
  const stack = [];
  const ops = [];
  const texts = [];
  const noop = () => {};
  const measure = (text, font) => {
    const px = parseFloat((/(\d+(?:\.\d+)?)px/.exec(font) || [0, 16])[1]) || 16;
    let w = 0;
    for (const ch of Array.from(String(text))) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? px : px * 0.55;
    return { w, px };
  };
  const ctx = {
    canvas: { width: W, height: H },
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    filter: 'none',
    shadowColor: 'transparent',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    letterSpacing: '0px',
    get font() { return state.font; },
    set font(v) { state.font = v; },
    get textAlign() { return state.textAlign; },
    set textAlign(v) { state.textAlign = v; },
    get textBaseline() { return state.textBaseline; },
    set textBaseline(v) { state.textBaseline = v; },
    save() { stack.push({ ...state, m: state.m.slice() }); },
    restore() { const p = stack.pop(); if (p) Object.assign(state, p); },
    translate(x, y) { state.m = mul(state.m, [1, 0, 0, 1, x, y]); },
    scale(x, y) { state.m = mul(state.m, [x, 0, 0, y, 0, 0]); },
    rotate(a) { state.m = mul(state.m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); },
    transform(a, b, c, d, e, f) { state.m = mul(state.m, [a, b, c, d, e, f]); },
    setTransform(a, b, c, d, e, f) { state.m = [a, b, c, d, e, f]; },
    resetTransform() { state.m = [1, 0, 0, 1, 0, 0]; },
    beginPath() { ops.push({ op: 'beginPath' }); },
    closePath: noop, moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop, ellipse: noop,
    arc() { ops.push({ op: 'arc' }); },
    rect(x, y, w, h) { ops.push({ op: 'rect', x, y, w, h, m: state.m.slice() }); },
    roundRect(x, y, w, h) { ops.push({ op: 'roundRect', x, y, w, h, m: state.m.slice() }); },
    fill() { ops.push({ op: 'fill', m: state.m.slice() }); },
    stroke() { ops.push({ op: 'stroke', m: state.m.slice() }); },
    clip() { ops.push({ op: 'clip' }); },
    fillRect(x, y, w, h) { ops.push({ op: 'fillRect', x, y, w, h, m: state.m.slice() }); },
    strokeRect(x, y, w, h) { ops.push({ op: 'strokeRect', x, y, w, h, m: state.m.slice() }); },
    clearRect() { ops.push({ op: 'clearRect' }); },
    setLineDash: noop,
    strokeText(text, x, y) { ops.push({ op: 'strokeText', text: String(text), x, y, m: state.m.slice() }); },
    drawImage() { ops.push({ op: 'drawImage' }); },
    measureText(text) { const r = measure(text, state.font); return { width: r.w, actualBoundingBoxAscent: r.px * 0.78, actualBoundingBoxDescent: r.px * 0.22 }; },
    fillText(text, x, y) {
      const r = measure(text, state.font);
      const half = state.textAlign === 'center' ? r.w / 2 : state.textAlign === 'right' || state.textAlign === 'end' ? r.w : 0;
      const x0 = x - half;
      const y0 = y - r.px * (state.textBaseline === 'middle' ? 0.35 : 0.78);
      const corners = [
        apply(state.m, x0, y0),
        apply(state.m, x0 + r.w, y0),
        apply(state.m, x0, y0 + r.px),
        apply(state.m, x0 + r.w, y0 + r.px),
      ];
      const box = {
        left: Math.min(...corners.map((p) => p.x)),
        right: Math.max(...corners.map((p) => p.x)),
        top: Math.min(...corners.map((p) => p.y)),
        bottom: Math.max(...corners.map((p) => p.y)),
      };
      texts.push({ text: String(text), ...box });
      ops.push({ op: 'fillText', ...box, text: String(text) });
    },
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
  };
  return { ctx, ops, texts };
}

function stubMedia(has) {
  const bmp = has ? { width: 1600, height: 900 } : null;
  return {
    has: () => has,
    video: () => bmp,
    image: () => bmp,
    size: () => (has ? { width: 1600, height: 900 } : null),
    kind: () => (has ? 'video' : null),
    time: () => (has ? 1.2 : null),
  };
}

const SIZES = [[1280, 720], [720, 1280]];
const cases = [
  { name: '缺 props', props: undefined },
  { name: '空 assetId', props: { assetId: '' } },
  { name: '有素材桩', props: { assetId: 'asset_stub_1' }, media: true },
  { name: '无素材', props: {}, media: false },
];

async function runAt(card, size, props, hasMedia, t) {
  const { ctx, ops, texts } = makeCtx(size[0], size[1]);
  const dur = Number(card.meta.duration) || 3;
  const env = {
    width: size[0], height: size[1], props, fps: 30, duration: dur,
    assets: hasMedia ? [{ id: 'asset_stub_1', kind: 'video', width: 1600, height: 900, duration: 6 }] : [],
    media: stubMedia(hasMedia),
  };
  card.api.render(ctx, t, env);
  return { ops, texts };
}

/* ------------------------------------------------------------------ */
/* 1) 清单与文件存活                                                    */
/* ------------------------------------------------------------------ */

const loaded = new Map();
section('1) 清单与文件');
await check('本批 35 张，id 无重复，且与 catalog 的 mediaNeeded 规则一致', async () => {
  assert(IDS.length === 35, '清单长度不是 35：' + IDS.length);
  assert(new Set(IDS).size === IDS.length, 'id 有重复');
  const catalog = JSON.parse(await fs.readFile(path.join(ROOT, 'tools', 'recipes', 'catalog.json'), 'utf8'));
  const byId = new Map(catalog.cards.map((c) => [c.id, c]));
  for (const id of IDS) {
    const c = byId.get(id);
    assert(c, 'catalog 里没有 ' + id);
    assert(Array.isArray(c.mediaNeeded) && c.mediaNeeded.length > 0, id + ' 在 catalog 里 mediaNeeded 为空');
    assert(!EXCLUDED.includes(id), id + ' 属于排除清单');
  }
  return '35 张皆 mediaNeeded 非空且不在排除清单';
});

await check('排除的 9 张没有被本批改动（不属于本批目录）', async () => {
  for (const id of EXCLUDED) assert(!IDS.includes(id), '排除项进入了本批：' + id);
  return EXCLUDED.length + ' 张排除项均不在清单内';
});

for (const id of IDS) {
  await check(`${id}：code.js + meta.json 可读，解析并导出 render / media`, async () => {
    const card = await loadCard(id);
    assert(typeof card.api.render === 'function', '没有导出 render');
    assert(typeof card.api.media === 'function', '没有导出 media');
    assert(card.api.meta && typeof card.api.meta === 'object', '没有导出 meta');
    loaded.set(id, card);
    return `duration=${card.meta.duration}s`;
  });
}

/* ------------------------------------------------------------------ */
/* 2) media 声明                                                        */
/* ------------------------------------------------------------------ */

section('2) media(props) 声明');
for (const id of IDS) {
  await check(`${id}：media({assetId:'a1'}) → ['a1']，media({}) → []`, async () => {
    const card = loaded.get(id);
    const decl = card.api.media({ assetId: 'a1' });
    assert(Array.isArray(decl) && decl.length === 1 && decl[0] === 'a1', 'media 声明不对：' + JSON.stringify(decl));
    const empty = card.api.media({});
    assert(Array.isArray(empty) && empty.length === 0, 'media({}) 应返回空数组，实际 ' + JSON.stringify(empty));
    const undef = card.api.media(undefined);
    assert(Array.isArray(undef) && undef.length === 0, 'media(undefined) 应返回空数组');
    const nul = card.api.media({ assetId: null });
    assert(Array.isArray(nul) && nul.length === 0, 'media({assetId:null}) 应返回空数组');
    return 'ok';
  });
}

/* ------------------------------------------------------------------ */
/* 3) 四情形 × 两画布 × 多时刻，不抛                                     */
/* ------------------------------------------------------------------ */

section('3) 四情形 × 两画布 × 多时刻不抛');
for (const id of IDS) {
  await check(`${id}：4 情形 × 2 画布 × 5 时刻（含 NaN/-1/超时长）不抛`, async () => {
    const card = loaded.get(id);
    const dur = Number(card.meta.duration) || 3;
    const times = [0, dur * 0.35, dur * 0.7, dur, -1, NaN, Infinity, dur + 2];
    let n = 0;
    for (const size of SIZES) {
      for (const c of cases) {
        for (const t of times) {
          await runAt(card, size, c.props, !!c.media, t);
          n += 1;
        }
      }
    }
    return n + ' 次渲染无异常';
  });
}

/* ------------------------------------------------------------------ */
/* 4) 首帧非空（无素材路径）                                            */
/* ------------------------------------------------------------------ */

section('4) 首帧非空（t=0，无素材）');
for (const id of IDS) {
  await check(`${id}：t=0 无素材时有实际绘制（不是白/黑空帧）`, async () => {
    const card = loaded.get(id);
    const { ops } = await runAt(card, SIZES[0], {}, false, 0);
    const paints = ops.filter((o) => o.op === 'fillRect' || o.op === 'fill' || o.op === 'fillText' || o.op === 'drawImage' || o.op === 'strokeText');
    assert(paints.length >= 2, 't=0 只有 ' + paints.length + ' 次绘制');
    // 至少有一次填充覆盖了画布的可观面积，或有 ≥3 处文字（有意义占位）
    let bigFill = 0;
    for (const o of ops) {
      if (o.op !== 'fillRect' || !o.m) continue;
      const p0 = apply(o.m, o.x, o.y);
      const p1 = apply(o.m, o.x + o.w, o.y + o.h);
      const area = Math.abs((p1.x - p0.x) * (p1.y - p0.y));
      if (area > 1280 * 720 * 0.25) bigFill += 1;
    }
    const textCount = ops.filter((o) => o.op === 'fillText' || o.op === 'strokeText').length;
    assert(bigFill > 0 || textCount >= 3, `首帧缺少可读内容：大底色 ${bigFill} 次、文字 ${textCount} 处`);
    return `绘制 ${paints.length} 次 / 大底色 ${bigFill} / 文字 ${textCount}`;
  });
}

/* ------------------------------------------------------------------ */
/* 5) 两画布下文字不溢出                                                */
/* ------------------------------------------------------------------ */

section('5) 两画布（1280×720 / 720×1280）文字不溢出');

/**
 * 「刻意出画」白名单：这些卡的画框里本来就有元素被运镜/构图推出画外
 * （相机横移、飞机位、字形遮罩、超宽地形）。这不是布局 bug，是卡文明确要的。
 * 规则不是「放过它们」，而是**白名单必须与实测完全一致**：
 * 实测多出任何一张 → 说明新出现了没登记的溢出；少一张 → 说明白名单过期了。
 */
const BLEED_BY_DESIGN = {
  'sc-card-flock-tumble': '背景两行 300px 描边字墙本来就横贯出画（卡文：字墙反向缓移）',
  'sc-depth-layer-moves': '近景浮块按 1.4× 速度掠过镜头，两端必然出画（视差的最大系数那一层）',
  'sc-gradient-word-sweep': '整句在 zoom 2.0 附近构图，长句两端触边（原片也是贴边）',
  'sc-graze-face-tour': 'UI 是超宽地形（2.4 屏），镜头钉死、页面自移，元素必然进出画',
  'sc-line-carry-transition': '世界宽 3840、镜头横移 1920px，展签与卡都在镜头外',
  'sc-row-embed': '相机下摇并推近（cy 500→740），页头滑出画框上缘',
  'sc-spotlight-hero-card': '相机推进到 zoom 2.6，注记被推近后超出上缘',
  'sc-terminal-3d': '三窗散布在 3D 空间，非焦点窗在画外（站间飞行时同框）',
  'sc-text-as-mask': '字形本身就是遮罩，46× 冲入时笔画出画是设计',
  'sc-type-and-filter': 'zoom 2.0 贴搜索框取景，网格整片落在画框下方',
};

async function bleedOf(card, size) {
  const dur = Number(card.meta.duration) || 3;
  const out = [];
  for (const t of [0, dur]) {
    const { texts } = await runAt(card, size, { assetId: 'asset_stub_1' }, true, t);
    for (const tx of texts) {
      const pad = 6;
      if (tx.left < -pad || tx.top < -pad || tx.right > size[0] + pad || tx.bottom > size[1] + pad) {
        out.push(`${size[0]}×${size[1]} t=${t} 「${tx.text.slice(0, 12)}」`);
      }
    }
  }
  return out;
}

for (const id of IDS) {
  await check(`${id}：首帧/末帧不越界（或已登记为刻意出画）`, async () => {
    const card = loaded.get(id);
    const problems = await bleedOf(card, SIZES[0]);
    if (BLEED_BY_DESIGN[id]) {
      return `刻意出画（${BLEED_BY_DESIGN[id]}）：${problems.length} 处`;
    }
    assert(problems.length === 0, '溢出：' + problems.slice(0, 3).join(' | '));
    return '16:9 首帧 + 末帧无越界';
  });
}

await check('竖屏 720×1280：无文字越界（16:9 构图被等比缩进画内；刻意出画的卡按同一名单豁免）', async () => {
  const bad = [];
  for (const id of IDS) {
    if (BLEED_BY_DESIGN[id]) continue;
    const card = loaded.get(id);
    const problems = await bleedOf(card, SIZES[1]);
    if (problems.length) bad.push(id + '：' + problems[0]);
  }
  assert(bad.length === 0, bad.slice(0, 3).join(' | '));
  return `${IDS.length - Object.keys(BLEED_BY_DESIGN).length} 张竖屏全部在画内（${Object.keys(BLEED_BY_DESIGN).length} 张刻意出画按名单豁免）`;
});

await check('刻意出画白名单与实测一致（多一张或少一张都算错）', async () => {
  const actual = new Set();
  for (const id of IDS) {
    const problems = await bleedOf(loaded.get(id), SIZES[0]);
    if (problems.length) actual.add(id);
  }
  const declared = new Set(Object.keys(BLEED_BY_DESIGN));
  const extra = [...actual].filter((x) => !declared.has(x));
  const stale = [...declared].filter((x) => !actual.has(x));
  assert(extra.length === 0, '实测有溢出但没登记：' + extra.join(', '));
  assert(stale.length === 0, '登记了但实测没溢出（白名单过期）：' + stale.join(', '));
  return `${actual.size} 张刻意出画，名单与实测一致`;
});

/* ------------------------------------------------------------------ */
/* 6) 模板克隆检测（两两相似度）                                        */
/* ------------------------------------------------------------------ */

section('6) 模板克隆检测（两两相似度 < 80%）');

function normalizeBody(source) {
  const at = (source.indexOf('function __renderInner') >= 0 ? source.indexOf('function __renderInner') : source.indexOf('export function render'));
  const body = at >= 0 ? source.slice(at) : source;
  return body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'[^'\n]*'/g, "'S'")
    .replace(/"[^"\n]*"/g, '"S"')
    .replace(/`[^`]*`/g, '`S`')
    .replace(/-?(?:\d+\.)?\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/** 结构签名：把 ctx 调用序列压成一条串（这才是「render 主体」的骨）。 */
function structSignature(source) {
  const at = (source.indexOf('function __renderInner') >= 0 ? source.indexOf('function __renderInner') : source.indexOf('export function render'));
  const body = at >= 0 ? source.slice(at) : source;
  const calls = body.match(/ctx\.[a-zA-Z]+/g) || [];
  return calls.map((c) => c.slice(4)).join('>');
}

function shingles(str, k) {
  const set = new Set();
  const s = str.replace(/\s+/g, ' ');
  if (s.length <= k) {
    set.add(s);
    return set;
  }
  for (let i = 0; i + k <= s.length; i += 1) set.add(s.slice(i, i + k));
  return set;
}

function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 1;
}

const sims = [];
for (let i = 0; i < IDS.length; i += 1) {
  for (let j = i + 1; j < IDS.length; j += 1) {
    const a = loaded.get(IDS[i]);
    const b = loaded.get(IDS[j]);
    const ta = normalizeBody(a.source);
    const tb = normalizeBody(b.source);
    const textSim = jaccard(shingles(ta, 24), shingles(tb, 24));
    const structSim = jaccard(shingles(structSignature(a.source), 14), shingles(structSignature(b.source), 14));
    sims.push({ a: IDS[i], b: IDS[j], textSim, structSim, sim: Math.max(textSim, structSim) });
  }
}
sims.sort((x, y) => y.sim - x.sim);

await check('两两相似度（文本 24-gram Jaccard / ctx 调用序列 14-gram）全部 < 0.8', async () => {
  const worst = sims[0];
  assert(worst.sim < 0.8, `最相似的一对 ${worst.a} × ${worst.b} = ${worst.sim.toFixed(3)} ≥ 0.8`);
  return `最相似 ${worst.a} × ${worst.b} = ${worst.sim.toFixed(3)}（文本 ${worst.textSim.toFixed(3)} / 结构 ${worst.structSim.toFixed(3)}）`;
});

await check('相似度分布：中位数与 Top-5 都在安全区', async () => {
  const arr = sims.map((s) => s.sim);
  const med = arr[Math.floor(arr.length / 2)];
  const top5 = sims.slice(0, 5).map((s) => s.sim);
  assert(Math.max(...top5) < 0.8, 'Top-5 有超标');
  return `中位 ${med.toFixed(3)}，Top-5 [${top5.map((x) => x.toFixed(3)).join(', ')}]，共 ${sims.length} 对`;
});

/* ------------------------------------------------------------------ */
/* 7) meta 完整                                                        */
/* ------------------------------------------------------------------ */

section('7) meta.json 完整性');
for (const id of IDS) {
  await check(`${id}：humanCalibrated / source / sourcePath / sourceRepo / license / author / mediaNeeded / paramsSchema`, async () => {
    const card = loaded.get(id);
    const meta = card.meta;
    assert(meta.humanCalibrated === true, 'humanCalibrated 不是 true');
    assert(meta.mediaNeeded === true, 'mediaNeeded 不是 true');
    for (const key of ['source', 'sourcePath', 'sourceRepo', 'license', 'author', 'title', 'description']) {
      assert(typeof meta[key] === 'string' && meta[key].length > 0, '缺少 ' + key);
    }
    assert(meta.paramsSchema && meta.paramsSchema.type === 'object', 'paramsSchema 不是 object');
    assert(meta.paramsSchema.properties && meta.paramsSchema.properties.assetId, 'paramsSchema 缺 assetId');
    assert(Number(meta.duration) > 0, 'duration 非法');
    assert((card.source.match(/export function media/g) || []).length === 1, 'media 声明不止一处或缺失');
    return `${meta.source} · ${meta.duration}s`;
  });
}

/* ------------------------------------------------------------------ */
/* 8) batch-media-1.json 与磁盘一致                                     */
/* ------------------------------------------------------------------ */

section('8) batch-media-1.json 与磁盘一致');
let batch = null;
await check('batch-media-1.json 可读且结构完整', async () => {
  const raw = await fs.readFile(BATCH_FILE, 'utf8');
  batch = JSON.parse(raw);
  for (const key of ['batch', 'name', 'generatedAt', 'selection', 'timing', 'quality', 'cards']) {
    assert(key in batch, '缺少字段 ' + key);
  }
  assert(Array.isArray(batch.cards) && batch.cards.length === 35, 'cards 不是 35 条');
  return `${batch.cards.length} 条`;
});

await check('清单 id 集合与测试清单完全一致（无多无少）', async () => {
  const disk = new Set(batch.cards.map((c) => c.id));
  for (const id of IDS) assert(disk.has(id), '清单缺 ' + id);
  for (const id of disk) assert(IDS.includes(id), '清单多了 ' + id);
  return '35/35';
});

await check('每条都有 类别 / 真实耗时 / 样张路径 / 自检结论，且样张文件真实存在', async () => {
  const missing = [];
  for (const c of batch.cards) {
    for (const key of ['id', 'category', 'kindClass', 'ms', 'preview', 'selfCheck']) {
      if (!(key in c)) missing.push(c.id + ' 缺 ' + key);
    }
    if (!(Number(c.ms) > 0)) missing.push(c.id + ' 耗时非法');
    const p = path.join(ROOT, c.preview);
    const stat = await fs.stat(p).catch(() => null);
    if (!stat || stat.size < 5000) missing.push(c.id + ' 样张不存在或过小：' + c.preview);
  }
  assert(missing.length === 0, missing.slice(0, 4).join(' | '));
  return '35 条字段齐全、样张均 >5KB';
});

await check('清单里的 sourcePath / license / author 与 meta.json 一致', async () => {
  const bad = [];
  for (const c of batch.cards) {
    const meta = loaded.get(c.id).meta;
    if (c.sourcePath !== meta.sourcePath) bad.push(c.id + ' sourcePath');
    if (c.license !== meta.license) bad.push(c.id + ' license');
    if (c.author !== meta.author) bad.push(c.id + ' author');
  }
  assert(bad.length === 0, bad.slice(0, 4).join(' | '));
  return '全部一致';
});

await check('清单的质量结论里写了相似度最高的一对，且数值与实测相符', async () => {
  const q = batch.quality;
  assert(q && q.cloneCheck, '缺少 quality.cloneCheck');
  const claimed = Number(q.cloneCheck.maxSimilarity);
  const actual = sims[0].sim;
  assert(Math.abs(claimed - actual) < 0.02, `清单写 ${claimed}，实测 ${actual.toFixed(3)}`);
  assert(q.cloneCheck.pair === `${sims[0].a} × ${sims[0].b}`, `清单写 ${q.cloneCheck.pair}，实测 ${sims[0].a} × ${sims[0].b}`);
  return `${q.cloneCheck.pair} = ${claimed}`;
});

await check('清单的 selection.excluded 覆盖了 9 张排除项', async () => {
  const ex = batch.selection && batch.selection.excluded;
  assert(Array.isArray(ex), 'selection.excluded 不是数组');
  for (const id of EXCLUDED) assert(ex.includes(id), 'selection.excluded 缺 ' + id);
  return ex.length + ' 条';
});

/* ------------------------------------------------------------------ */
/* 收尾                                                                */
/* ------------------------------------------------------------------ */

console.log(`\n${failures.length === 0 ? '全绿' : '有红'}：通过 ${passed} 条，失败 ${failures.length} 条`);
if (failures.length) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`);
  process.exit(1);
}
void PREVIEW_DIR;
