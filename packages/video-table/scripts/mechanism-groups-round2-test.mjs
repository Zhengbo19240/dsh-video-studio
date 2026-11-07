#!/usr/bin/env node
/**
 * 机制合并验收测试 · 第二轮（tools/recipes/mechanism-groups.json, round=2）。
 *
 * 跑法：node scripts/mechanism-groups-round2-test.mjs
 * 退出码：0 全绿；1 有红。
 *
 * 不信任分组表自述：
 *  - 每个 id 回磁盘核对 code.js / meta.json；
 *  - keep 的两种取值都在 mock canvas 上真跑，用调用序列差异证明「真的分叉了」；
 *  - notMerged 与 4 张受保护卡用 JSON 里记录的 sha256 对磁盘做校验和比对（一个字节都不许动）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const GROUPS_FILE = path.join(ROOT, 'tools', 'recipes', 'mechanism-groups.json');
const MOTION_ROOT = process.env.DSH_MOTION_LIB || path.join(os.homedir(), '.dsh', 'motion-lib');
const RECIPE_FILES = ['batch-1.json', 'batch-2.json', 'batch-media-1.json', 'batch-media-2.json'];
const PROTECTED = ['sc-transition-travel', 'tc-bed-echo-blur', 'sc-crash-zoom-punch', 'sc-page-waterfall-wall'];

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
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/* ------------------------------------------------------------------ */
/* code.js → 可调用 render（与第一轮测试同一套改写规则）                 */
/* ------------------------------------------------------------------ */

function toFunctionBody(source) {
  return String(source)
    .replace(/export\s+default\s+/g, 'const __default__ = ')
    .replace(/export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/g, (m, a, n) => `${a || ''}function ${n}`)
    .replace(/export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g, (m, k, n) => `${k} ${n}`)
    .replace(/export\s*\{[^}]*\}/g, '');
}

function loadCard(id) {
  const dir = path.join(MOTION_ROOT, id);
  const source = fs.readFileSync(path.join(dir, 'code.js'), 'utf8');
  const meta = readJson(path.join(dir, 'meta.json'));
  const api = new Function(
    '"use strict";\n' + toFunctionBody(source) + '\nreturn { render: typeof render === "function" ? render : null };',
  )();
  assert(typeof api.render === 'function', `${id} 没有导出 render`);
  return { dir, source, meta, render: api.render };
}

function makeCtx() {
  const log = [];
  const fmt = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(5) : String(v);
    if (typeof v === 'string') return v.length > 40 ? v.slice(0, 40) : v;
    if (v && typeof v === 'object') return '[obj]';
    return String(v);
  };
  const ctx = {
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    filter: 'none',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetY: 0,
    canvas: { width: 960, height: 540 },
    measureText: (s) => ({ width: String(s).length * 8, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  const stack = [];
  for (const name of [
    'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'arc', 'arcTo',
    'ellipse', 'rect', 'roundRect', 'fill', 'stroke', 'clip', 'fillRect', 'strokeRect', 'clearRect',
    'setLineDash', 'translate', 'scale', 'rotate', 'transform', 'setTransform', 'resetTransform',
    'fillText', 'strokeText', 'drawImage',
  ]) {
    ctx[name] = (...args) => log.push(name + '(' + args.map(fmt).join(',') + ')');
  }
  ctx.save = () => { stack.push({ ...ctx }); log.push('save()'); };
  ctx.restore = () => { const prev = stack.pop(); if (prev) Object.assign(ctx, prev); log.push('restore()'); };
  return { ctx, log };
}

function runSequence(card, props, times, duration) {
  const { ctx, log } = makeCtx();
  for (const t of times) {
    card.render(ctx, t, { width: 960, height: 540, duration, props });
  }
  return log.join('\n');
}

/* ------------------------------------------------------------------ */
/* 读分组表与配方全集                                                   */
/* ------------------------------------------------------------------ */

const doc = readJson(GROUPS_FILE);
const groups = Array.isArray(doc.groups) ? doc.groups : [];
const round2 = groups.filter((g) => g.round === 2);
const allIds = [];
for (const f of RECIPE_FILES) {
  for (const c of readJson(path.join(ROOT, 'tools', 'recipes', f)).cards) allIds.push(c.id);
}

const seen = new Map();
for (const g of groups) {
  const local = new Set([...(g.members || []), g.keep, ...(g.merge || [])].filter(Boolean));
  for (const id of local) {
    if (!seen.has(id)) seen.set(id, []);
    seen.get(id).push(g.id);
  }
}

console.log('机制合并验收 · 第二轮\n');

/* 1 */
await check('分组表已是第二版（round=2，8 个新组）', () => {
  assert(doc.round === 2, `round=${doc.round}，应为 2`);
  assert(round2.length === 8, `round:2 组只有 ${round2.length} 个`);
  assert(/code\.js/.test(String(doc.method)), 'method 必须写明「读 code.js 分组」');
  assert(doc.similarityMetric && doc.similarityMetric.threshold === 0.7, '判据阈值应写死为 0.7');
  return `${groups.length} 组（其中新 ${round2.length} 组）`;
});

/* 2 */
await check('新组每个 id 都在磁盘上（code.js + meta.json）', () => {
  const missing = [];
  for (const g of round2) {
    for (const id of [...(g.members || []), g.keep, ...(g.merge || [])].filter(Boolean)) {
      for (const f of ['code.js', 'meta.json']) {
        if (!fs.existsSync(path.join(MOTION_ROOT, id, f))) missing.push(`${id}/${f}`);
      }
    }
  }
  assert(missing.length === 0, '缺文件：' + missing.join(', '));
  return `${new Set(round2.flatMap((g) => g.members)).size} 张卡核对通过`;
});

/* 3 */
await check('新组 keep 未被标 merged/duplicate', () => {
  for (const g of round2) {
    const meta = readJson(path.join(MOTION_ROOT, g.keep, 'meta.json'));
    assert(meta.verdict !== 'merged-into', `${g.keep} 被标了 merged-into`);
    assert(meta.verdict !== 'duplicate', `${g.keep} 被标了 duplicate`);
  }
  return '8 张 keep 仍是一等卡';
});

/* 4 */
await check('merge 卡 meta 有 verdict + mergedInto + 指向 keep 的 mergeNote', () => {
  let n = 0;
  for (const g of round2) {
    for (const id of g.merge) {
      const meta = readJson(path.join(MOTION_ROOT, id, 'meta.json'));
      assert(meta.verdict === 'merged-into', `${id} 的 verdict=${meta.verdict}`);
      assert(meta.mergedInto === g.keep, `${id}.mergedInto=${meta.mergedInto}，应为 ${g.keep}`);
      assert(typeof meta.mergeNote === 'string' && meta.mergeNote.includes(g.keep), `${id} 的 mergeNote 没指向 ${g.keep}`);
      assert(fs.existsSync(path.join(MOTION_ROOT, id, 'code.js')), `${id}/code.js 不应被删除`);
      n += 1;
    }
  }
  return `${n} 张 merge 卡都有出处且文件保留`;
});

/* 5 */
await check('keep 的 paramsSchema 真有新枚举（两种取值，默认第一种）', () => {
  for (const g of round2) {
    assert(/^props\./.test(String(g.mergeMethod)), `${g.id} 的 mergeMethod 应是 props.*`);
    assert(Array.isArray(g.values) && g.values.length === 2, `${g.id} 的 values 应为两种形态`);
    const meta = readJson(path.join(MOTION_ROOT, g.keep, 'meta.json'));
    const prop = meta.paramsSchema && meta.paramsSchema.properties && meta.paramsSchema.properties[g.param];
    assert(prop, `${g.keep}.paramsSchema 缺 ${g.param}`);
    const allowed = prop.enum || [];
    for (const v of g.values) assert(allowed.includes(v), `${g.keep}.${g.param} 的 enum 缺 ${v}`);
    assert(prop.default === g.values[0], `${g.keep}.${g.param} 默认值应为 ${g.values[0]}`);
    assert(Array.isArray(meta.mergedVariants) && meta.mergedVariants.includes(g.merge[0]), `${g.keep} 的 mergedVariants 缺 ${g.merge[0]}`);
  }
  return '8 个新参数都在 schema 里';
});

/* 6 */
await check('keep 的 render 在两种取值下调用序列不同（真的分叉）', () => {
  const details = [];
  for (const g of round2) {
    const card = loadCard(g.keep);
    const duration = Number(card.meta.duration) || 6;
    const times = [0, 0.4, 0.9, 1.5, 2.4, 3.4, 4.6].filter((t) => t <= duration + 0.5);
    const a = runSequence(card, { [g.param]: g.values[0] }, times, duration);
    const b = runSequence(card, { [g.param]: g.values[1] }, times, duration);
    assert(a.length > 0 && b.length > 0, `${g.keep} 没有画出任何东西`);
    assert(a !== b, `${g.keep} 在 ${g.param}=${g.values[0]} / ${g.values[1]} 下输出相同`);
    details.push(`${g.keep}:${g.param}`);
  }
  return details.length + ' 组分叉';
});

/* 7 */
await check('两种取值 × 极端 t 都不抛', () => {
  for (const g of round2) {
    const card = loadCard(g.keep);
    const duration = Number(card.meta.duration) || 6;
    for (const v of g.values) {
      for (const t of [-1, 0, duration / 2, duration, duration + 2, NaN, Infinity]) {
        const { ctx } = makeCtx();
        card.render(ctx, t, { width: 960, height: 540, duration, props: { [g.param]: v } });
      }
    }
  }
  return '8 组 × 2 形态 × 7 个 t 全部不抛';
});

/* 8 */
await check('默认值与不传该参数等价（旧调用不被破坏）', () => {
  for (const g of round2) {
    const card = loadCard(g.keep);
    const duration = Number(card.meta.duration) || 6;
    const times = [0, 0.5, 1.2, 2.0, 3.1, 4.2];
    const implicit = runSequence(card, {}, times, duration);
    const explicit = runSequence(card, { [g.param]: g.values[0] }, times, duration);
    assert(implicit === explicit, `${g.keep} 传默认 ${g.param}=${g.values[0]} 与不传不等价`);
  }
  return '向后兼容';
});

/* 9 */
await check('同一 t 重放逐条一致（纯函数）', () => {
  for (const g of round2) {
    const card = loadCard(g.keep);
    const duration = Number(card.meta.duration) || 6;
    for (const v of g.values) {
      const once = runSequence(card, { [g.param]: v }, [1.7], duration);
      const twice = runSequence(card, { [g.param]: v }, [1.7], duration);
      assert(once === twice, `${g.keep}(${v}) 同 t 重放不一致`);
    }
  }
  return '8 组 × 2 形态';
});

/* 10 */
await check('notMerged 里的卡一个都没被改（sha256 对磁盘）', () => {
  assert(Array.isArray(doc.notMerged) && doc.notMerged.length >= 10, `notMerged 只有 ${doc.notMerged && doc.notMerged.length} 条`);
  const bad = [];
  let checked = 0;
  for (const nm of doc.notMerged) {
    for (const [id, hashes] of Object.entries(nm.checksums || {})) {
      for (const kind of ['meta', 'code']) {
        const file = path.join(MOTION_ROOT, id, kind === 'meta' ? 'meta.json' : 'code.js');
        if (!fs.existsSync(file)) { bad.push(`${id}/${kind} 不存在`); continue; }
        if (sha256(file) !== hashes[kind]) bad.push(`${id}/${kind} 校验和变了`);
        checked += 1;
      }
    }
  }
  assert(bad.length === 0, bad.join(', '));
  return `${doc.notMerged.length} 条 / ${checked} 个文件校验和一致`;
});

/* 11 */
await check('4 张受保护卡 meta 与 code.js 校验和不变', () => {
  const prot = new Map((doc.protected || []).map((p) => [p.id, p]));
  for (const id of PROTECTED) {
    const rec = prot.get(id);
    assert(rec, `${id} 不在 protected 列表里`);
    for (const kind of ['meta', 'code']) {
      const file = path.join(MOTION_ROOT, id, kind === 'meta' ? 'meta.json' : 'code.js');
      assert(fs.existsSync(file), `${file} 不存在`);
      assert(sha256(file) === rec.checksums[kind], `${id}/${kind} 校验和变了（受保护卡被改动）`);
    }
  }
  return `${PROTECTED.length} 张卡逐字节未动`;
});

/* 12 */
await check('统计自洽（机器可读字段与磁盘/数组一致）', () => {
  const involved = seen.size;
  const merged = groups.reduce((n, g) => n + g.merge.length, 0);
  const independent = allIds.length - groups.reduce((n, g) => n + (g.members.length - 1), 0);
  const s = doc.stats || {};
  assert(s.groups === groups.length, `stats.groups=${s.groups} != ${groups.length}`);
  assert(s.involvedCards === involved, `stats.involvedCards=${s.involvedCards} != ${involved}`);
  assert(s.mergedCards === merged, `stats.mergedCards=${s.mergedCards} != ${merged}`);
  assert(s.independentMechanisms === independent, `stats.independentMechanisms=${s.independentMechanisms} != ${independent}`);
  assert(s.standaloneCards === doc.standalone.length, 'standaloneCards 与 standalone 数组不一致');
  assert(s.independentMechanisms === 93, `本轮独立机制应为 93，实为 ${s.independentMechanisms}`);
  assert(s.round1.independentMechanisms === 101, 'round1 独立机制应为 101');
  assert(s.round2.independentMechanisms === 93, 'round2 独立机制应为 93');
  assert(s.round2.mergedCards === 8 && s.round2.groups === 8, 'round2 应新增 8 组 / 8 张 merge');
  return `101 → ${s.independentMechanisms}（groups ${groups.length} / involved ${involved} / merged ${merged}）`;
});

/* 13 */
await check('standalone 与 groups 无交集，且覆盖四批配方全集', () => {
  const standalone = Array.isArray(doc.standalone) ? doc.standalone : [];
  assert(standalone.length > 0, 'standalone 为空');
  const overlap = standalone.filter((id) => seen.has(id));
  assert(overlap.length === 0, 'standalone 与分组重叠：' + overlap.join(', '));
  const missing = allIds.filter((id) => !seen.has(id) && !standalone.includes(id));
  assert(missing.length === 0, '四批里有卡既不在组也不在 standalone：' + missing.join(', '));
  const extra = standalone.filter((id) => !allIds.includes(id));
  assert(extra.length === 0, 'standalone 含四批之外的 id：' + extra.join(', '));
  return `${standalone.length} 张独立 + ${seen.size} 张入组 = ${allIds.length}`;
});

/* 14 */
await check('新组都写明了同构度、主体节拍与「皮相差异」', () => {
  for (const g of round2) {
    assert(g.similarity, `${g.id} 缺 similarity`);
    assert(g.similarity.beatsShared >= 0.7, `${g.id} 同构度 ${g.similarity.beatsShared} < 0.70`);
    assert(Array.isArray(g.similarity.beats) && g.similarity.beats.length >= 3, `${g.id} 的主体节拍少于 3 条`);
    assert(Array.isArray(g.similarity.deviations) && g.similarity.deviations.length >= 1, `${g.id} 没写清差别在哪`);
    assert(typeof g.similarity.opSequenceLcs === 'number', `${g.id} 缺 draw-op 代理指标`);
    assert(g.reason && g.reason.length >= 20, `${g.id} 的 reason 太短`);
    assert(g.evidence && g.evidence.length >= 10, `${g.id} 缺 evidence`);
    assert(g.confidence, `${g.id} 缺 confidence`);
    assert(Array.isArray(g.titles) && g.titles.length === 2, `${g.id} 缺 titles`);
    assert(seen.get(g.keep).length === 1, `${g.keep} 出现在多个组`);
  }
  return '8 组字段齐全';
});

/* 15 */
await check('第一轮 8 组原样保留，keep 未被本轮改动语义', () => {
  const r1 = groups.filter((g) => !g.round);
  assert(r1.length === 8, `第一轮组数=${r1.length}`);
  for (const g of r1) {
    const meta = readJson(path.join(MOTION_ROOT, g.keep, 'meta.json'));
    const prop = meta.paramsSchema && meta.paramsSchema.properties && meta.paramsSchema.properties[g.param];
    assert(prop && prop.enum && prop.enum.includes(g.values[1]), `第一轮 ${g.keep}.${g.param} 被破坏`);
    for (const id of g.merge) {
      const m = readJson(path.join(MOTION_ROOT, id, 'meta.json'));
      assert(m.verdict === 'merged-into' && m.mergedInto === g.keep, `${id} 的第一轮标记被破坏`);
    }
  }
  return '8 组 keep/merge 标记完整';
});

/* 16 */
await check('本轮涉及的 keep 都有 mergedRound=2 且 code.js 未被删', () => {
  for (const g of round2) {
    const meta = readJson(path.join(MOTION_ROOT, g.keep, 'meta.json'));
    assert(meta.mergedRound === 2, `${g.keep} 缺 mergedRound=2`);
    assert(fs.existsSync(path.join(MOTION_ROOT, g.keep, 'code.js')), `${g.keep}/code.js 不在`);
  }
  return '8 张 keep 文件齐全';
});

/* ------------------------------------------------------------------ */
/* 汇总                                                                 */
/* ------------------------------------------------------------------ */

console.log(`\n通过 ${passed} 条，失败 ${failures.length} 条。`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f.name}: ${f.message}`);
  process.exitCode = 1;
} else {
  const s = doc.stats || {};
  console.log(
    `\n第二轮：新并 ${s.round2.groups} 组 / ${s.round2.involvedCards} 张｜独立机制 ${s.round1.independentMechanisms} → ${s.independentMechanisms}｜notMerged ${doc.notMerged.length} 条`,
  );
}
