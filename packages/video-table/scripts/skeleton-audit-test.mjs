#!/usr/bin/env node
/**
 * 骨架审计的验收测试（2026-11-06）。
 *
 *   node scripts/skeleton-audit-test.mjs
 *
 * 判据不是"审计文件怎么写"，而是"磁盘上是不是真的这样"：
 *   - 审计清单必须逐条对得上磁盘上的自动骨架（双向比对，不靠自述）；
 *   - fix 的卡必须真的标定过（humanCalibrated + fixedAt + autoConverted:false）；
 *   - drop 的卡必须在 meta 里留下 verdict:'drop'，且目录没被删；
 *   - 人工标定卡的 meta.json + code.js 校验和必须与审计前一致（一个字节都没动）；
 *   - 抽样的卡必须真的能解析、三个时刻都不抛；
 *   - 修过的卡必须有样张，且首帧不是末帧的复制（证明"首帧有内容"不是靠一张空白图蒙混）。
 *
 * 抽样里的 3 个时刻用 mock 的 Canvas2D context 直接调 render()：
 * 目的是"可解析 + 不抛"，不是出图；出图由 .build/audit-shoot.mjs 负责。
 */

import { promises as fs, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(os.homedir(), '.dsh', 'motion-lib');
const AUDIT_PATH = path.join(process.cwd(), 'tools', 'recipes', 'skeleton-audit.json');
const FRAME_DIR = path.join(process.cwd(), '.build', 'audit', 'final');
const FORBIDDEN = ['tc-lower-third-bar', 'sc-timeline-travel', 'sc-gauge-readout-moves'];

const results = [];
let failed = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail: detail == null ? '' : String(detail) });
  } catch (error) {
    failed += 1;
    results.push({ ok: false, name, detail: error && error.message ? error.message : String(error) });
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function fileSha(file) {
  const buf = await fs.readFile(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 最小 Canvas2D 替身：只保证 render 不会因为缺 API 而抛。 */
function mockCtx() {
  const noop = () => {};
  const target = {
    measureText: (text) => ({ width: String(text).length * 8 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  const methods = [
    'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo',
    'arc', 'arcTo', 'rect', 'roundRect', 'fill', 'stroke', 'clip', 'fillRect', 'clearRect', 'strokeRect',
    'fillText', 'strokeText', 'translate', 'scale', 'rotate', 'transform', 'setTransform', 'drawImage',
    'putImageData', 'setLineDash',
  ];
  for (const m of methods) target[m] = noop;
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (prop === 'canvas') return { width: 960, height: 540 };
      return undefined;
    },
    set() {
      return true;
    },
  });
}

function toFunctionBody(source) {
  return String(source)
    .replace(/export\s+default\s+/g, 'const __default__ = ')
    .replace(/export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/g, (m, isAsync, name) => `${isAsync || ''}function ${name}`)
    .replace(/export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g, (m, kind, name) => `${kind} ${name}`)
    .replace(/export\s*\{[^}]*\}/g, '');
}

/** 纯 Node 里跑一次 render：解析失败 / 运行抛错都会被抓住。 */
function renderAt(source, t, duration) {
  const body = toFunctionBody(source);
  const factory = new Function(
    '"use strict";\n' + body + '\nreturn { render: typeof render === "function" ? render : (__default__ && __default__.render) };',
  );
  const api = factory();
  if (typeof api.render !== 'function') throw new Error('模块没有导出 render');
  api.render(mockCtx(), t, { width: 960, height: 540, props: {}, fps: 30, duration });
}

async function main() {
  const audit = JSON.parse(await fs.readFile(AUDIT_PATH, 'utf8'));
  const entries = Array.isArray(audit.entries) ? audit.entries : [];
  const byId = new Map(entries.map((e) => [e.id, e]));

  const dirs = (await fs.readdir(ROOT, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  const metas = new Map();
  for (const id of dirs) {
    try {
      metas.set(id, JSON.parse(await fs.readFile(path.join(ROOT, id, 'meta.json'), 'utf8')));
    } catch {
      /* 没有 meta 的目录不算卡 */
    }
  }

  await check('审计文件存在且可解析', () => {
    assert(audit && Array.isArray(audit.entries), '缺少 entries 数组');
    return `${entries.length} 条`;
  });

  await check('条目数与磁盘上的自动骨架数一致（逐条双向比对）', () => {
    const universe = [...metas.entries()]
      .filter(([, meta]) => meta.autoConverted === true || meta.auditVerdict === 'fix')
      .map(([id]) => id)
      .sort();
    assert(universe.length === entries.length, `磁盘 ${universe.length} 张 ≠ 清单 ${entries.length} 条`);
    const missing = universe.filter((id) => !byId.has(id));
    const extra = entries.map((e) => e.id).filter((id) => !universe.includes(id));
    assert(missing.length === 0, `磁盘上有但清单没有：${missing.join(', ')}`);
    assert(extra.length === 0, `清单里有但磁盘上没有：${extra.join(', ')}`);
    return `${universe.length} 张逐条对上`;
  });

  await check('counts 与条目一致', () => {
    const counted = { keep: 0, fix: 0, drop: 0 };
    for (const e of entries) counted[e.verdict] = (counted[e.verdict] || 0) + 1;
    assert(audit.counts.total === entries.length, 'counts.total 不符');
    for (const key of ['keep', 'fix', 'drop']) assert(audit.counts[key] === counted[key], `counts.${key} 应为 ${counted[key]}`);
    return `keep ${counted.keep} / fix ${counted.fix} / drop ${counted.drop}`;
  });

  await check('每条 verdict 合法且 id 不重复', () => {
    const ids = new Set();
    for (const e of entries) {
      assert(['keep', 'fix', 'drop'].includes(e.verdict), `${e.id} verdict=${e.verdict}`);
      assert(!ids.has(e.id), `${e.id} 重复出现`);
      ids.add(e.id);
    }
    return `${ids.size} 个唯一 id`;
  });

  await check('每条都写清了问题（≥2 条具体描述）', () => {
    for (const e of entries) {
      assert(Array.isArray(e.problems) && e.problems.length >= 2, `${e.id} problems 少于 2 条`);
      for (const p of e.problems) assert(typeof p === 'string' && p.length >= 8, `${e.id} 有问题描述太短`);
    }
    return '全部带具体问题';
  });

  await check('fix 的卡都标了 fixed:true（或写明放弃理由）', () => {
    const fixes = entries.filter((x) => x.verdict === 'fix');
    for (const e of fixes) assert(e.fixed === true || (typeof e.note === 'string' && e.note.length > 10), `${e.id} 没修也没说明`);
    return `${fixes.length} 张`;
  });

  await check('fix 的卡在磁盘上是人工标定状态', () => {
    const fixed = entries.filter((e) => e.verdict === 'fix' && e.fixed);
    for (const e of fixed) {
      const meta = metas.get(e.id);
      assert(meta, `${e.id} 不存在`);
      assert(meta.humanCalibrated === true, `${e.id} 缺 humanCalibrated`);
      assert(typeof meta.fixedAt === 'string' && meta.fixedAt.length > 10, `${e.id} 缺 fixedAt`);
      assert(meta.autoConverted === false, `${e.id} autoConverted 仍为 true`);
    }
    return `${fixed.length} 张已标定`;
  });

  await check('drop 的卡在 meta 里有 verdict:drop 且目录还在', () => {
    const drops = entries.filter((x) => x.verdict === 'drop');
    for (const e of drops) {
      const meta = metas.get(e.id);
      assert(meta, `${e.id} 目录被删了（不允许删）`);
      assert(meta.verdict === 'drop', `${e.id} 缺 verdict:'drop'`);
      assert(typeof meta.verdictReason === 'string' && meta.verdictReason.length > 10, `${e.id} 缺 drop 原因`);
    }
    return `${drops.length} 张已标掉`;
  });

  await check('keep 的卡没有被误标 drop', () => {
    const keeps = entries.filter((x) => x.verdict === 'keep');
    for (const e of keeps) {
      const meta = metas.get(e.id);
      assert(meta && meta.verdict !== 'drop', `${e.id} 被判 keep 却标了 drop`);
    }
    return `${keeps.length} 张 keep`;
  });

  await check('人工标定卡基线存在且不少于 45 张', () => {
    const baseline = audit.humanChecksums || {};
    const ids = Object.keys(baseline);
    assert(ids.length >= 45, `基线只有 ${ids.length} 张，少于 45`);
    for (const id of ids) assert(baseline[id].length === 64, `${id} 校验和不是 sha256`);
    return `${ids.length} 张基线`;
  });

  await check('人工标定卡 meta.json + code.js 校验和未变（一个字节都没动）', () => {
    const baseline = audit.humanChecksums || {};
    for (const [id, expected] of Object.entries(baseline)) {
      let metaText;
      let codeText;
      try {
        metaText = readFileSync(path.join(ROOT, id, 'meta.json'), 'utf8');
        codeText = readFileSync(path.join(ROOT, id, 'code.js'), 'utf8');
      } catch {
        throw new Error(`${id} 的文件不见了`);
      }
      const actual = crypto.createHash('sha256').update(sha256(metaText)).update(sha256(codeText)).digest('hex');
      assert(actual === expected, `${id} 内容变了（审计前 ${expected.slice(0, 8)}… ≠ 现在 ${actual.slice(0, 8)}…）`);
      const meta = JSON.parse(metaText);
      assert(meta.humanCalibrated === true, `${id} 不再是人工标定卡`);
      assert(meta.calibrationMinutes !== undefined || meta.calibrationNote !== undefined || meta.reviewedAt !== undefined, `${id} 连标定字段都没了`);
    }
    return '全部未变';
  });

  await check('抽样卡 render 可解析且 t=0/半/末 不抛', async () => {
    const keeps = entries.filter((e) => e.verdict === 'keep');
    const fixes = entries.filter((e) => e.verdict === 'fix' && e.fixed);
    // 本轮审计的结论是"没有一张够格 keep"；不足 5 张时用修好的卡补足，保证抽样仍然是 5 张真卡
    const sample = [...keeps, ...fixes].slice(0, 5);
    assert(sample.length >= 5, `抽样只有 ${sample.length} 张`);
    for (const e of sample) {
      const source = await fs.readFile(path.join(ROOT, e.id, 'code.js'), 'utf8');
      const duration = Number(metas.get(e.id).duration) || 3;
      for (const t of [0, duration / 2, duration]) renderAt(source, t, duration);
    }
    return sample.map((e) => e.id).join(', ');
  });

  await check('修过的卡有样张，且首帧不是末帧的复制', async () => {
    const fixed = entries.filter((e) => e.verdict === 'fix' && e.fixed);
    for (const e of fixed) {
      const dir = path.join(FRAME_DIR, e.id);
      let files;
      try {
        files = (await fs.readdir(dir)).filter((f) => f.endsWith('.png')).sort();
      } catch {
        throw new Error(`${e.id} 没有样张目录 ${dir}`);
      }
      assert(files.length >= 3, `${e.id} 样张不足 3 帧`);
      const first = await fileSha(path.join(dir, files[0]));
      const others = await Promise.all(files.slice(1).map((f) => fileSha(path.join(dir, f))));
      assert(others.every((h) => h !== first), `${e.id} 首帧与其它帧完全相同（首帧可能是空白）`);
      const stat = await fs.stat(path.join(dir, files[0]));
      assert(stat.size > 2000, `${e.id} 首帧文件过小（${stat.size}B），像是空图`);
    }
    return `${fixed.length} 张有样张`;
  });

  await check('正在被别的 agent 修改的 3 张卡没被我标掉', () => {
    for (const id of FORBIDDEN) {
      const meta = metas.get(id);
      if (!meta) continue;
      assert(meta.verdict !== 'drop', `${id} 被标成 drop 了（禁改）`);
    }
    return '未被改动';
  });

  await check('fix 的卡 paramsSchema 与新实现对应（不再残留骨架参数）', () => {
    for (const e of entries.filter((x) => x.verdict === 'fix' && x.fixed)) {
      const props = metas.get(e.id).paramsSchema && metas.get(e.id).paramsSchema.properties;
      assert(props && Object.keys(props).length > 0, `${e.id} 缺 paramsSchema`);
      assert(!('hostSrc' in props), `${e.id} paramsSchema 里还有骨架时代的 hostSrc`);
    }
    return '参数表已更新';
  });

  await check('drop 的卡 code.js 仍是原骨架（没有假装修过）', async () => {
    for (const e of entries.filter((x) => x.verdict === 'drop')) {
      const source = await fs.readFile(path.join(ROOT, e.id, 'code.js'), 'utf8');
      assert(source.includes('自动转换骨架'), `${e.id} 的 code.js 已经不是骨架了，和 verdict:drop 不符`);
    }
    return '骨架原样保留';
  });

  const pass = results.filter((r) => r.ok).length;
  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name}${r.detail ? `  ·  ${r.detail}` : ''}`);
  }
  console.log(`\n${pass}/${results.length} 通过${failed ? `，${failed} 条失败` : ''}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
