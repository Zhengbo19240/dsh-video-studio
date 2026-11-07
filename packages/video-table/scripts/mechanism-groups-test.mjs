#!/usr/bin/env node
/**
 * 机制合并验收测试（tools/recipes/mechanism-groups.json）。
 *
 * 跑法：node scripts/mechanism-groups-test.mjs
 * 退出码：0 全绿；1 有红。
 *
 * 不信任分组表自述：每个 id 都回磁盘核对 code.js/meta.json；keep 的两种取值
 * 都在 mock canvas 上真跑一遍 render，用调用序列差异断言「两种形态不是同一张画」。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const GROUPS_FILE = path.join(ROOT, 'tools', 'recipes', 'mechanism-groups.json');
const MOTION_ROOT = process.env.DSH_MOTION_LIB || path.join(os.homedir(), '.dsh', 'motion-lib');
const RECIPE_FILES = ['batch-1.json', 'batch-2.json', 'batch-media-1.json', 'batch-media-2.json'];

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

/* ------------------------------------------------------------------ */
/* code.js → 可调用 render（与 recipe 测试同一套改写规则）              */
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
  return { dir, source, meta, render: api.render };
}

/**
 * 记录型 mock canvas：只记「方法名 + 实参数值」。两种形态若走不同分支、
 * 或同一分支但参数不同（倍率/位置/透明度），序列就会不同。
 */
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
  const drawOps = [
    'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'arc', 'arcTo',
    'ellipse', 'rect', 'roundRect', 'fill', 'stroke', 'clip', 'fillRect', 'strokeRect', 'clearRect',
    'setLineDash', 'translate', 'scale', 'rotate', 'transform', 'setTransform', 'resetTransform',
    'fillText', 'strokeText', 'drawImage',
  ];
  for (const name of drawOps) {
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

const groupsDoc = readJson(GROUPS_FILE);
const groups = Array.isArray(groupsDoc.groups) ? groupsDoc.groups : [];
const allIds = [];
for (const f of RECIPE_FILES) {
  for (const c of readJson(path.join(ROOT, 'tools', 'recipes', f)).cards) allIds.push(c.id);
}
const allSet = new Set(allIds);

const seen = new Map();
for (const g of groups) {
  const local = new Set([...(g.members || []), g.keep, ...(g.merge || [])].filter(Boolean));
  for (const id of local) {
    if (!seen.has(id)) seen.set(id, []);
    seen.get(id).push(g.id);
  }
}

console.log('机制合并验收\n');

/* 1 */
await check('分组表存在且方法字段可核对', () => {
  assert(groupsDoc.method && /code\.js/.test(groupsDoc.method), 'method 必须写明「读 code.js 分组」');
  assert(groups.length >= 8, `分组数只有 ${groups.length}，低于验收下限 8`);
  return `${groups.length} 组 / ${groupsDoc.stats?.independentMechanisms} 个独立机制`;
});

/* 2 */
await check('每个 group 的 keep/merge/members 都真实存在于磁盘', () => {
  const missing = [];
  for (const g of groups) {
    for (const id of [...(g.members || []), g.keep, ...(g.merge || [])]) {
      if (!id) continue;
      for (const f of ['code.js', 'meta.json']) {
        if (!fs.existsSync(path.join(MOTION_ROOT, id, f))) missing.push(`${id}/${f}`);
      }
    }
  }
  assert(missing.length === 0, '缺文件：' + missing.join(', '));
  return `核对 ${seen.size} 个 id`;
});

/* 3 */
await check('分组表里没有 id 重复出现（跨组也不行）', () => {
  const dup = [...seen.entries()].filter(([, gs]) => gs.length > 1);
  assert(dup.length === 0, '重复：' + dup.map(([id, gs]) => `${id}@${gs.join('+')}`).join(', '));
  return `${seen.size} 个 id 各只出现一次`;
});

/* 4 */
await check('每个 group 的 keep 存在且没有被标 merged/duplicate', () => {
  for (const g of groups) {
    const meta = readJson(path.join(MOTION_ROOT, g.keep, 'meta.json'));
    assert(meta.verdict !== 'merged-into', `${g.keep} 被标了 merged-into`);
    assert(meta.verdict !== 'duplicate', `${g.keep} 被标了 duplicate`);
  }
  return '全部 keep 仍是一等卡';
});

/* 5 */
await check('每个 merge 卡 meta 带 verdict 与 mergedInto/duplicateOf', () => {
  for (const g of groups) {
    assert(g.merge.length > 0, `${g.id} 没有 merge 卡`);
    for (const id of g.merge) {
      const meta = readJson(path.join(MOTION_ROOT, id, 'meta.json'));
      assert(meta.verdict === 'merged-into' || meta.verdict === 'duplicate', `${id} 缺 verdict`);
      if (meta.verdict === 'merged-into') {
        assert(meta.mergedInto === g.keep, `${id}.mergedInto=${meta.mergedInto}，应为 ${g.keep}`);
      } else {
        assert(typeof meta.duplicateOf === 'string' && meta.duplicateOf.length > 0, `${id} 缺 duplicateOf`);
      }
      assert(fs.existsSync(path.join(MOTION_ROOT, id, 'code.js')), `${id}/code.js 不应被删除`);
    }
  }
  return `${groups.reduce((n, g) => n + g.merge.length, 0)} 张 merge 卡都有出处`;
});

/* 6 */
await check('keep 的 paramsSchema 真的新增了合并参数（枚举含两种形态）', () => {
  for (const g of groups) {
    if (g.mergeMethod === 'drop') continue;
    assert(g.param, `${g.id} 缺 param`);
    assert(Array.isArray(g.values) && g.values.length === 2, `${g.id} 的 values 应为两种形态`);
    const meta = readJson(path.join(MOTION_ROOT, g.keep, 'meta.json'));
    const prop = meta.paramsSchema?.properties?.[g.param];
    assert(prop, `${g.keep} 的 paramsSchema 缺 ${g.param}`);
    const allowed = prop.enum || [];
    for (const v of g.values) assert(allowed.includes(v), `${g.keep}.${g.param} 的 enum 缺 ${v}`);
    assert(prop.default === g.values[0], `${g.keep}.${g.param} 默认值应为 ${g.values[0]}`);
  }
  return `${groups.length} 个新参数都在 schema 里`;
});

/* 7 */
await check('keep 的 render 在两种取值下输出不同（mock ctx 调用序列）', () => {
  const details = [];
  for (const g of groups) {
    if (g.mergeMethod === 'drop') continue;
    const card = loadCard(g.keep);
    const duration = Number(card.meta.duration) || 6;
    const times = [0, 0.4, 0.9, 1.5, 2.4, 3.4, 4.6, 5.6].filter((t) => t <= duration + 0.5);
    const a = runSequence(card, { [g.param]: g.values[0] }, times, duration);
    const b = runSequence(card, { [g.param]: g.values[1] }, times, duration);
    assert(a !== b, `${g.keep} 在 ${g.param}=${g.values[0]} / ${g.values[1]} 下输出相同`);
    details.push(`${g.keep}:${g.param}`);
  }
  return details.join(', ');
});

/* 8 */
await check('两种形态都不抛（含 t=0 / 末帧 / 超时长）', () => {
  for (const g of groups) {
    if (g.mergeMethod === 'drop') continue;
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

/* 9 */
await check('默认值输出与不传该参数时一致（旧调用不被破坏）', () => {
  for (const g of groups) {
    if (g.mergeMethod === 'drop') continue;
    const card = loadCard(g.keep);
    const duration = Number(card.meta.duration) || 6;
    const times = [0, 0.7, 1.6, 2.8, 4.2];
    const implicit = runSequence(card, {}, times, duration);
    const explicit = runSequence(card, { [g.param]: g.values[0] }, times, duration);
    assert(implicit === explicit, `${g.keep} 传默认 ${g.param}=${g.values[0]} 与不传不等价`);
  }
  return '向后兼容';
});

/* 10 */
await check('同一 t 重放输出逐条一致（纯函数）', () => {
  for (const g of groups) {
    if (g.mergeMethod === 'drop') continue;
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

/* 11 */
await check('standalone 与 groups 无交集，且覆盖四批配方全集', () => {
  const standalone = Array.isArray(groupsDoc.standalone) ? groupsDoc.standalone : [];
  assert(standalone.length > 0, 'standalone 为空');
  const overlap = standalone.filter((id) => seen.has(id));
  assert(overlap.length === 0, 'standalone 与分组重叠：' + overlap.join(', '));
  const missing = allIds.filter((id) => !seen.has(id) && !standalone.includes(id));
  assert(missing.length === 0, '四批配方里有卡既不在组也不在 standalone：' + missing.join(', '));
  const extra = standalone.filter((id) => !allSet.has(id));
  assert(extra.length === 0, 'standalone 含四批之外的 id：' + extra.join(', '));
  return `${standalone.length} 张独立 + ${seen.size} 张入组 = ${allIds.length}`;
});

/* 12 */
await check('统计数字与分组表/磁盘一致', () => {
  const involved = seen.size;
  const merged = groups.reduce((n, g) => n + g.merge.length, 0);
  const independent = allIds.length - groups.reduce((n, g) => n + (g.members.length - 1), 0);
  const s = groupsDoc.stats || {};
  assert(s.groups === groups.length, `stats.groups=${s.groups} != ${groups.length}`);
  assert(s.involvedCards === involved, `stats.involvedCards=${s.involvedCards} != ${involved}`);
  assert(s.mergedCards === merged, `stats.mergedCards=${s.mergedCards} != ${merged}`);
  assert(s.independentMechanisms === independent, `stats.independentMechanisms=${s.independentMechanisms} != ${independent}`);
  assert(s.standaloneCards === groupsDoc.standalone.length, 'standaloneCards 与 standalone 数组不一致');
  return `合并前 ${allIds.length} → 合并后 ${independent}`;
});

/* 13 */
await check('每个 group 都有 keep/merge/reason/合并方式/证据', () => {
  for (const g of groups) {
    assert(g.keep && g.merge?.length, `${g.id} 缺 keep/merge`);
    assert(g.reason && g.reason.length >= 10, `${g.id} 的 reason 太短`);
    assert(g.mergeMethod, `${g.id} 缺 mergeMethod`);
    assert(g.param && g.values?.length === 2, `${g.id} 缺 param/values`);
    assert(g.confidence, `${g.id} 缺 confidence`);
  }
  return `${groups.length} 组字段齐全`;
});

/* 14 */
await check('每个 group 的 merge 卡都标注了「新调用请用 keep」', () => {
  for (const g of groups) {
    for (const id of g.merge) {
      const meta = readJson(path.join(MOTION_ROOT, id, 'meta.json'));
      assert(typeof meta.mergeNote === 'string' && meta.mergeNote.includes(g.keep), `${id} 的 mergeNote 没指向 ${g.keep}`);
    }
  }
  return '8 张卡都有指路说明';
});

/* ------------------------------------------------------------------ */
/* 汇总                                                                 */
/* ------------------------------------------------------------------ */

console.log(`\n通过 ${passed} 条，失败 ${failures.length} 条。`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f.name}: ${f.message}`);
  process.exitCode = 1;
} else {
  const s = groupsDoc.stats || {};
  console.log(
    `\n合并组数 ${s.groups}｜涉及卡 ${s.involvedCards}（并入 ${s.mergedCards}）｜独立机制 ${s.independentMechanisms}｜独立卡 ${s.standaloneCards}`,
  );
}
