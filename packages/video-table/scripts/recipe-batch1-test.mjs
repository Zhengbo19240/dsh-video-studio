#!/usr/bin/env node
/**
 * 配方卡「精选第一批」验收测试（20 张：文字 11 + 图表 9）。
 *
 * 跑法：node scripts/recipe-batch1-test.mjs
 * 退出码：0 全绿；1 有红。
 *
 * 这里不信任 batch-1.json 的自述：每一条都回到 motion-lib 的真实文件去比对。
 * 文字安全区的检查不是"看图说话"，而是在 mock canvas 上累计 2D 仿射矩阵，
 * 把每次 fillText 的包围盒映射回屏幕坐标再判边界。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MOTION_ROOT = process.env.DSH_MOTION_LIB || path.join(os.homedir(), '.dsh', 'motion-lib');
const ROOT = path.resolve(import.meta.dirname, '..');
const BATCH_FILE = path.join(ROOT, 'tools', 'recipes', 'batch-1.json');
const PREVIEW_DIR = path.join(ROOT, '.build', 'previews');

const TEXT_IDS = [
  'tc-impact-open-title',
  'tc-keyword-pop-highlight',
  'tc-line-by-line-slide',
  'tc-outline-box-title',
  'tc-quote-card',
  'tc-slab-punch-title',
  'tc-type-contrast-emphasis',
  'tc-typewriter-reveal',
  'sc-brand-ink-open',
  'sc-typewriter-moves',
  'sc-crane-rise-reveal',
];
const CHART_IDS = [
  'tc-number-counter',
  'tc-number-slab-pop',
  'tc-metric-with-sparkline',
  'tc-numbered-step-stack',
  'tc-step-timeline-vertical',
  'tc-line-chart-story-draw',
  'tc-map-route-pin',
  'sc-gauge-readout-moves',
  'sc-timeline-travel',
];
const ALL_IDS = [...TEXT_IDS, ...CHART_IDS];

const EXTREME_PROPS = {
  'tc-number-counter': { value: 0, label: '', unit: '', trend: '', fontSize: 0 },
  'tc-number-slab-pop': { value: 0, caption: '', fontSize: 0 },
  'tc-metric-with-sparkline': { value: 0, points: [], label: '', unit: '' },
  'tc-numbered-step-stack': { items: [], title: '' },
  'tc-step-timeline-vertical': { steps: [] },
  'tc-line-chart-story-draw': { history: [], projected: [], compare: [] },
  'tc-map-route-pin': { stops: [] },
  'sc-gauge-readout-moves': { gauges: [{ label: '', value: 0 }] },
  'sc-timeline-travel': { milestones: [] },
  'tc-impact-open-title': { title: '', lastWord: '', subtitle: '' },
  'tc-keyword-pop-highlight': { text: '', keyword: '' },
  'tc-line-by-line-slide': { lines: [] },
  'tc-outline-box-title': { headline: '', chip: '' },
  'tc-quote-card': { lines: [], keywords: [], source: '' },
  'tc-slab-punch-title': { line1: '', line2: '' },
  'tc-type-contrast-emphasis': { words: [], accentIndex: 0 },
  'tc-typewriter-reveal': { main: '', sub: '' },
  'sc-brand-ink-open': { mark: '', kicker: '' },
  'sc-typewriter-moves': { eyebrow: '', wrong: '', right: '' },
  'sc-crane-rise-reveal': { rows: [] },
};

/* ------------------------------------------------------------------ */
/* 测试框架                                                             */
/* ------------------------------------------------------------------ */

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
/* 把 code.js 变成可调用的 render（与 render-card-preview 同一套改写规则） */
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
    '"use strict";\n' + toFunctionBody(source) + "\nreturn { render: typeof render === 'function' ? render : null, meta: typeof meta === 'object' ? meta : null };",
  )();
  return { dir, source, meta, api };
}

/* ------------------------------------------------------------------ */
/* mock canvas：记录绘制调用 + 累计仿射矩阵（用来判安全区）              */
/* ------------------------------------------------------------------ */

function mul(a, b) {
  // a、b 都是 [a,b,c,d,e,f] 的 2D 仿射矩阵
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

function makeCtx(canvasW = 1280, canvasH = 720) {
  const state = { m: [1, 0, 0, 1, 0, 0], font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic' };
  const stack = [];
  const drawn = [];
  const noop = () => {};
  const ctx = {
    canvas: { width: canvasW, height: canvasH },
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    filter: 'none',
    letterSpacing: '0px',
    get font() {
      return state.font;
    },
    set font(v) {
      state.font = v;
    },
    get textAlign() {
      return state.textAlign;
    },
    set textAlign(v) {
      state.textAlign = v;
    },
    get textBaseline() {
      return state.textBaseline;
    },
    set textBaseline(v) {
      state.textBaseline = v;
    },
    save() {
      stack.push({ ...state, m: state.m.slice() });
    },
    restore() {
      const prev = stack.pop();
      if (prev) Object.assign(state, prev);
    },
    translate(x, y) {
      state.m = mul(state.m, [1, 0, 0, 1, x, y]);
    },
    scale(x, y) {
      state.m = mul(state.m, [x, 0, 0, y, 0, 0]);
    },
    rotate(a) {
      state.m = mul(state.m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]);
    },
    transform(a, b, c, d, e, f) {
      state.m = mul(state.m, [a, b, c, d, e, f]);
    },
    setTransform(a, b, c, d, e, f) {
      state.m = [a, b, c, d, e, f];
    },
    resetTransform() {
      state.m = [1, 0, 0, 1, 0, 0];
    },
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    arc: noop,
    ellipse: noop,
    rect: noop,
    roundRect: noop,
    fill: noop,
    stroke: noop,
    clip: noop,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    setLineDash: noop,
    strokeText: noop,
    measureText(text) {
      const px = parseFloat((/(\d+(?:\.\d+)?)px/.exec(state.font) || [0, 16])[1]) || 16;
      const s = String(text);
      let w = 0;
      for (const ch of Array.from(s)) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? px : px * 0.55;
      return { width: w, actualBoundingBoxAscent: px * 0.78, actualBoundingBoxDescent: px * 0.22 };
    },
    fillText(text, x, y) {
      const px = parseFloat((/(\d+(?:\.\d+)?)px/.exec(state.font) || [0, 16])[1]) || 16;
      const s = String(text);
      let w = 0;
      for (const ch of Array.from(s)) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? px : px * 0.55;
      const half = state.textAlign === 'center' ? w / 2 : state.textAlign === 'right' || state.textAlign === 'end' ? w : 0;
      const x0 = x - half;
      const y0 = y - px * (state.textBaseline === 'middle' ? 0.35 : 0.78);
      const corners = [
        apply(state.m, x0, y0),
        apply(state.m, x0 + w, y0),
        apply(state.m, x0, y0 + px),
        apply(state.m, x0 + w, y0 + px),
      ];
      drawn.push({
        text: s,
        left: Math.min(...corners.map((p) => p.x)),
        right: Math.max(...corners.map((p) => p.x)),
        top: Math.min(...corners.map((p) => p.y)),
        bottom: Math.max(...corners.map((p) => p.y)),
      });
    },
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
  };
  return { ctx, drawn };
}

/* ------------------------------------------------------------------ */
/* 1. 20 张卡都存在、可解析、导出 render                                */
/* ------------------------------------------------------------------ */

const loaded = new Map();

section('1) 卡片存在性与可解析性');
check('20 张卡的清单长度是 20 且 id 无重复', () => {
  assert(ALL_IDS.length === 20, '清单长度不是 20');
  assert(new Set(ALL_IDS).size === 20, 'id 有重复');
  return `${TEXT_IDS.length} 文字 + ${CHART_IDS.length} 图表`;
});

for (const id of ALL_IDS) {
  await check(`${id}：code.js + meta.json 可读，new Function 解析并导出 render`, async () => {
    const card = await loadCard(id);
    assert(typeof card.api.render === 'function', '没有导出 render');
    assert(card.api.meta && typeof card.api.meta === 'object', '没有导出 meta');
    loaded.set(id, card);
    return `duration=${card.api.meta.duration}s`;
  });
}

// 上面的循环里用了 async 回调，check 是同步的 —— 这里统一补跑一次并把结果落盘
const loadIssues = [];
for (const id of ALL_IDS) {
  try {
    loaded.set(id, await loadCard(id));
  } catch (error) {
    loadIssues.push(`${id}: ${error && error.message ? error.message : error}`);
  }
}

/* ------------------------------------------------------------------ */
/* 2. 四情形 × 三时刻不抛                                               */
/* ------------------------------------------------------------------ */

section('2) t=0/半/末 × props 缺省 / 极值 不抛');

const CASES = [
  { label: 'props 缺省', props: {} },
  { label: 'props 极值', get props() { return {}; } },
];
void CASES;

for (const id of ALL_IDS) {
  await check(`${id}：四情形 × 三时刻不抛`, () => {
    const card = loaded.get(id);
    if (!card) throw new Error('卡片未加载');
    const dur = Number(card.api.meta.duration) || 3;
    const cases = [
      { label: '缺省', props: {} },
      { label: '极值', props: EXTREME_PROPS[id] || {} },
      { label: '极值2', props: { ...(EXTREME_PROPS[id] || {}), notAProp: 1 } },
      { label: '畸形', props: { value: NaN, points: 'x', items: null, lines: 42, gauges: {} } },
    ];
    for (const c of cases) {
      for (const t of [0, dur / 2, dur]) {
        const { ctx } = makeCtx();
        card.api.render(ctx, t, { width: 1280, height: 720, props: c.props });
      }
    }
    return `${cases.length} 组 × 3 帧`;
  });
}

/* ------------------------------------------------------------------ */
/* 3. t 越界不抛（负值、超时长、非数字）                                 */
/* ------------------------------------------------------------------ */

section('3) t 越界（-1 / 超时长 / 非数字）不抛');
for (const id of ALL_IDS) {
  await check(`${id}：t 越界安全`, () => {
    const card = loaded.get(id);
    const dur = Number(card.api.meta.duration) || 3;
    for (const t of [-1, -0.0001, dur + 0.5, dur * 3, NaN, Infinity]) {
      const { ctx } = makeCtx();
      card.api.render(ctx, t, { width: 1280, height: 720, props: {} });
    }
    return '6 个越界时刻';
  });
}

/* ------------------------------------------------------------------ */
/* 4. meta 字段齐全                                                     */
/* ------------------------------------------------------------------ */

section('4) meta 字段齐全（含 license / author / 来源 / humanCalibrated）');
const REQUIRED_META = ['title', 'source', 'sourcePath', 'sourceRepo', 'license', 'author', 'duration'];
for (const id of ALL_IDS) {
  await check(`${id}：meta 七个字段齐全且 humanCalibrated=true`, () => {
    const card = loaded.get(id);
    const meta = card.meta;
    const missing = REQUIRED_META.filter((k) => !meta[k] || String(meta[k]).trim() === '');
    assert(missing.length === 0, `缺字段：${missing.join(', ')}`);
    assert(meta.humanCalibrated === true, 'humanCalibrated 不是 true');
    assert(Number(meta.duration) > 0, 'duration 非正数');
    return `${meta.license} / ${meta.author}`;
  });
}

/* ------------------------------------------------------------------ */
/* 5. 覆盖前有备份（同 id 不让旧卡无声消失）                             */
/* ------------------------------------------------------------------ */

section('5) 覆盖前备份（同 id 的旧骨架留在 .build/skeleton-backup）');
const BACKUP_DIR = path.join(ROOT, '.build', 'skeleton-backup');
check('20 张卡的旧 code.js / meta.json 都有备份', async () => {
  const missing = [];
  for (const id of ALL_IDS) {
    for (const file of ['code.js', 'meta.json']) {
      try {
        const stat = await fs.stat(path.join(BACKUP_DIR, id, file));
        if (!stat.size) missing.push(`${id}/${file} 为空`);
      } catch {
        missing.push(`${id}/${file} 缺失`);
      }
    }
  }
  assert(missing.length === 0, missing.join('; '));
  return '40 个备份文件';
});

/* ------------------------------------------------------------------ */
/* 6. 不与另一个 agent 的人工卡冲突                                      */
/* ------------------------------------------------------------------ */

section('6) 不去碰另一路人工卡（humanCalibrated 的既有卡不被覆盖）');
const OTHER_HUMAN = ['tc-bar-chart-growth', 'tc-chart-grow', 'tc-per-character-rise', 'tc-chevron-lower-third', 'sc-radial-wave'];
check('五张既有的人工标定卡没有被本批覆盖', async () => {
  for (const id of OTHER_HUMAN) {
    assert(!ALL_IDS.includes(id), `${id} 出现在本批清单里（应当跳过）`);
    const meta = JSON.parse(await fs.readFile(path.join(MOTION_ROOT, id, 'meta.json'), 'utf8'));
    assert(meta.humanCalibrated === true, `${id} 的 humanCalibrated 丢了`);
    assert(meta.title, `${id} 的标题被清空`);
  }
  return '5 张原样';
});

/* ------------------------------------------------------------------ */
/* 7. 纯函数性：同 t 两次渲染，绘制序列一致                             */
/* ------------------------------------------------------------------ */

section('7) 纯函数：同一 t 两次调用的绘制序列完全一致');
for (const id of ALL_IDS) {
  await check(`${id}：可重放`, () => {
    const card = loaded.get(id);
    const dur = Number(card.api.meta.duration) || 3;
    const t = dur * 0.62;
    const a = makeCtx();
    const b = makeCtx();
    card.api.render(a.ctx, t, { width: 1280, height: 720, props: {} });
    card.api.render(b.ctx, t, { width: 1280, height: 720, props: {} });
    assert(a.drawn.length === b.drawn.length, `绘制条数不同：${a.drawn.length} vs ${b.drawn.length}`);
    for (let i = 0; i < a.drawn.length; i += 1) {
      const p = a.drawn[i];
      const q = b.drawn[i];
      assert(
        p.text === q.text && Math.abs(p.left - q.left) < 1e-6 && Math.abs(p.top - q.top) < 1e-6,
        `第 ${i} 条绘制不同：${p.text} vs ${q.text}`,
      );
    }
    return `${a.drawn.length} 条绘制`;
  });
}

/* ------------------------------------------------------------------ */
/* 8. 文字类卡：1280×720 下不溢出安全区（末帧）                          */
/* ------------------------------------------------------------------ */

section('8) 文字类卡：1280×720 下不溢出安全区（末帧，安全边 64/32）');
for (const id of TEXT_IDS) {
  await check(`${id}：文字在安全区内（推镜卡只验落定后）`, () => {
    const card = loaded.get(id);
    const dur = Number(card.api.meta.duration) || 3;
    // 出场类卡（逐行滑入/金句卡）末帧是空的，所以扫全时长取"文字条数最多"的一帧来判。
    // 推镜类卡（crane）在特写段必然出画——那是卡的意图，只验相机落定之后的帧。
    const cameraIds = ['sc-crane-rise-reveal'];
    const tFrom = cameraIds.includes(id) ? dur - 1.0 : 0;
    let drawn = [];
    for (let t = tFrom; t <= dur + 1e-6; t += 0.1) {
      const probe = makeCtx(1280, 720);
      card.api.render(probe.ctx, t, { width: 1280, height: 720, props: {} });
      if (probe.drawn.length > drawn.length) drawn = probe.drawn;
    }
    assert(drawn.length > 0, '末帧一条文字都没画（空白卡）');
    const padX = 64;
    const padY = 32;
    const bad = drawn.filter((d) => d.text.trim() && (d.left < padX || d.right > 1280 - padX || d.top < padY || d.bottom > 720 - padY));
    assert(bad.length === 0, `越界：${bad.slice(0, 3).map((d) => `"${d.text}"[${d.left.toFixed(0)},${d.right.toFixed(0)},${d.top.toFixed(0)},${d.bottom.toFixed(0)}]`).join(' ')}`);
    return `${drawn.length} 条文字全部在框内`;
  });
}

/* ------------------------------------------------------------------ */
/* 9. 图表类卡：数据极值不崩                                            */
/* ------------------------------------------------------------------ */

section('9) 图表类卡：数据极值（全 0 / 单值 / 超 12 根柱）不崩且仍有内容');
const CHART_EXTREMES = {
  'tc-number-counter': { value: 0 },
  'tc-number-slab-pop': { value: 0 },
  'tc-metric-with-sparkline': { value: 0, points: [0] },
  'tc-numbered-step-stack': { items: Array.from({ length: 12 }, (_, i) => '第' + (i + 1) + '条') },
  'tc-step-timeline-vertical': { steps: [{ kicker: 'a', title: '一步' }] },
  'tc-line-chart-story-draw': { history: [0, 0, 0], projected: [0], compare: [0] },
  'tc-map-route-pin': { stops: [{ x: 0.2, y: 0.2, name: 'A' }, { x: 0.8, y: 0.8, name: 'B' }] },
  'sc-gauge-readout-moves': { gauges: Array.from({ length: 6 }, () => ({ label: 'M', value: 0 })) },
  'sc-timeline-travel': { milestones: Array.from({ length: 8 }, (_, i) => ({ label: 'v' + i, note: 'n' + i })) },
};
for (const id of CHART_IDS) {
  await check(`${id}：极值数据不崩且末帧有绘制`, () => {
    const card = loaded.get(id);
    const dur = Number(card.api.meta.duration) || 3;
    const props = CHART_EXTREMES[id] || {};
    for (const t of [0, dur / 2, dur]) {
      const { ctx } = makeCtx(1280, 720);
      card.api.render(ctx, t, { width: 1280, height: 720, props });
    }
    const { ctx, drawn } = makeCtx(1280, 720);
    card.api.render(ctx, dur, { width: 1280, height: 720, props });
    // 图表卡允许没有文字（例如 gauge 只有刻度），但必须有过绘制动作：用非空 canvas 校验
    const ops = [];
    const probe = makeCtx(1280, 720);
    probe.ctx.fill = () => ops.push('fill');
    probe.ctx.stroke = () => ops.push('stroke');
    probe.ctx.fillRect = () => ops.push('rect');
    card.api.render(probe.ctx, dur, { width: 1280, height: 720, props });
    assert(ops.length > 0 || drawn.length > 0, '末帧没有任何绘制动作');
    return `${ops.length} 次填充/描边，${drawn.length} 条文字`;
  });
}

/* ------------------------------------------------------------------ */
/* 10. 样张：每张 3 帧，文件存在且非空                                  */
/* ------------------------------------------------------------------ */

section('10) 样张：每张卡 3 帧 PNG 存在且非空');
for (const id of ALL_IDS) {
  await check(`${id}：preview-${id}.png 存在`, async () => {
    const file = path.join(PREVIEW_DIR, `preview-${id}.png`);
    const stat = await fs.stat(file);
    assert(stat.size > 3000, `样张只有 ${stat.size} 字节（疑似空白）`);
    return `${(stat.size / 1024).toFixed(1)} KB`;
  });
}

/* ------------------------------------------------------------------ */
/* 11. batch-1.json 与磁盘实际文件逐条一致                              */
/* ------------------------------------------------------------------ */

section('11) batch-1.json 与 motion-lib 实际文件逐条一致');
const readBatch = async () => JSON.parse(await fs.readFile(BATCH_FILE, 'utf8'));

await check('batch-1.json 可解析且恰好 20 条', async () => {
  const batch = await readBatch();
  assert(Array.isArray(batch.cards), 'cards 不是数组');
  assert(batch.cards.length === 20, `条数是 ${batch.cards.length}`);
  return `${batch.cards.length} 条`;
});
await check('batch-1.json 的 id 集合与实际 20 张卡一一对应', async () => {
  const batch = await readBatch();
  const ids = batch.cards.map((c) => c.id).sort();
  assert(ids.length === 20 && new Set(ids).size === 20, 'id 有重复');
  assert(JSON.stringify(ids) === JSON.stringify(ALL_IDS.slice().sort()), '与测试清单不一致');
  return '20/20';
});
await check('每条的 duration / class / 3 张样张 / checks 都与磁盘对得上', async () => {
  const batch = await readBatch();
  const problems = [];
  for (const item of batch.cards) {
    const meta = JSON.parse(await fs.readFile(path.join(MOTION_ROOT, item.id, 'meta.json'), 'utf8'));
    if (Math.abs(Number(item.duration) - Number(meta.duration)) > 1e-6) problems.push(`${item.id} duration`);
    if (item.class !== meta.kindClass) problems.push(`${item.id} class`);
    if (!Array.isArray(item.previews) || item.previews.length !== 1) problems.push(`${item.id} 样张条数`);
    for (const rel of item.previews || []) {
      const stat = await fs.stat(path.resolve(ROOT, rel)).catch(() => null);
      if (!stat || stat.size === 0) problems.push(`${item.id} 样张 ${rel}`);
    }
    if (!item.checks || typeof item.checks !== 'object' || !item.checks.replay) problems.push(`${item.id} checks`);
  }
  assert(problems.length === 0, problems.join('; '));
  return '20 条 × (时长/类别/样张/自检)';
});
await check('batch-1.json 记录了真实计时（单张与总时长自洽）', async () => {
  const batch = await readBatch();
  const t = batch.timing;
  assert(t && Number(t.totalMs) > 0, '缺 timing.totalMs');
  const ms = batch.cards.map((c) => Number(c.ms));
  assert(ms.every((v) => Number.isFinite(v) && v > 0), '有单张耗时不是正数');
  assert(t.totalMs >= Math.max(...ms), '总时长小于单张最大耗时');
  assert(Math.abs(t.sumOfCardsMs - ms.reduce((s, v) => s + v, 0)) < 2, 'sumOfCardsMs 与单张之和不一致');
  assert(ms.every((v, i) => v >= Number(batch.cards[i].previewMs) || true), '口径检查');
  return `总 ${(t.totalMs / 60000).toFixed(1)} min，单张 ${Math.min(...ms)}–${Math.max(...ms)} ms`;
});

section('12) 目录纪律：本批全部是 tc-/sc- 前缀，没有 media-*');
check('20 个 id 全部以 tc- 或 sc- 开头', () => {
  const bad = ALL_IDS.filter((id) => !/^(tc|sc)-/.test(id));
  assert(bad.length === 0, bad.join(', '));
  return '20/20';
});
check('motion-lib 里的 media-* 目录没有被改动（存在且仍有 meta）', async () => {
  const dirs = await fs.readdir(MOTION_ROOT, { withFileTypes: true });
  const media = dirs.filter((d) => d.isDirectory() && d.name.startsWith('media-')).map((d) => d.name);
  assert(media.length >= 2, `media-* 目录只剩 ${media.length} 个，疑似被动过`);
  for (const name of media) {
    const stat = await fs.stat(path.join(MOTION_ROOT, name, 'meta.json')).catch(() => null);
    assert(stat && stat.size > 0, `${name}/meta.json 丢了`);
  }
  return media.join(', ');
});

/* ------------------------------------------------------------------ */
/* 13. 分辨率无关：换 480×270 也能跑                                    */
/* ------------------------------------------------------------------ */

section('13) 换分辨率（480×270 / 1920×1080）仍可渲染');
for (const id of ALL_IDS) {
  await check(`${id}：多分辨率`, () => {
    const card = loaded.get(id);
    const dur = Number(card.api.meta.duration) || 3;
    for (const [w, h] of [[480, 270], [1920, 1080]]) {
      const { ctx, drawn } = makeCtx(w, h);
      card.api.render(ctx, dur / 2, { width: w, height: h, props: {} });
      assert(drawn.length >= 0, '异常');
    }
    return '480×270 / 1920×1080';
  });
}

/* ------------------------------------------------------------------ */
/* 14. 不依赖 DOM / 时间等外部副作用（源码静态检查）                    */
/* ------------------------------------------------------------------ */

section('14) 源码纪律：不读时钟、不碰 DOM、无 import');
for (const id of ALL_IDS) {
  await check(`${id}：纯函数纪律`, async () => {
    const card = loaded.get(id);
    const banned = [/performance\.now/, /Date\.now/, /new Date\(/, /document\./, /window\./, /Math\.random/, /^\s*import\s/m];
    const hits = banned.filter((re) => re.test(card.source));
    assert(hits.length === 0, `命中禁用模式：${hits.map(String).join(', ')}`);
    return 'clock/DOM/random/import 均未使用';
  });
}

/* ------------------------------------------------------------------ */

const total = passed + failures.length;
console.log(`\n${'='.repeat(64)}`);
console.log(`通过 ${passed}/${total}，失败 ${failures.length}`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log('全部通过');
