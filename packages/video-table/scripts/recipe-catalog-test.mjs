/**
 * 配方卡目录 + 转换器的测试。
 *
 *   node scripts/recipe-catalog-test.mjs
 *
 * 覆盖：
 *   1 仓库缺失时降级（不抛）                 2 direct 判定
 *   3 blur 判定（含 filter: `blur(...)`）    4 混合模式判定
 *   5 three.js 判定 → skip                   6 clip-path 判定
 *   7 必需媒体 → rewrite                     8 可选媒体不升级档位（回归）
 *   9 tsx CONFIG 解析                        10 时长解析
 *   11 转换产物可 new Function 解析并导出 render
 *   12 render 在 t=0 / 半程 / 终帧都不抛
 *   13 meta 的 source/license/author 齐全
 *   14 已存在同 id 时不覆盖（不静默丢改动）
 *   15 --force 时先备份再写
 *   16 code.js 顶部保留来源与许可
 *   17 真实 catalog.json 的自洽性
 *   18 真实 motion-lib 里 5 张标定卡的集成检查
 *
 * 不写用户的真实 motion-lib（除第 18 条只读检查）。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadCatalog,
  classifyFeasibility,
  requiredMediaFromInputs,
  parseTsxConfig,
  toSeconds,
  parseFrontmatter,
} from '../tools/recipes/catalog.mjs';
import { convertCard, buildCode } from '../tools/convert.mjs';

let pass = 0;
let fail = 0;
const ok = (name) => {
  pass += 1;
  console.log('  ok   ' + name);
};
const bad = (name, error) => {
  fail += 1;
  console.log('  FAIL ' + name + ' :: ' + (error && error.message ? error.message : error));
};
const check = (name, condition, detail) => {
  if (condition) ok(name);
  else bad(name, new Error(detail == null ? '条件不成立' : String(detail)));
};

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-recipe-'));

// ------------------------------------------------------------ 假 ctx ----
function fakeCtx() {
  const calls = [];
  const target = {
    calls,
    measureText(text) {
      calls.push(['measureText', [text]]);
      return { width: String(text).length * 12 };
    },
  };
  return new Proxy(target, {
    get(obj, key) {
      if (key in obj) return obj[key];
      // 未知方法一律记录后返回 undefined；属性读取给 null
      return (...args) => {
        calls.push([key, args]);
        return undefined;
      };
    },
    set(obj, key, value) {
      obj[key] = value;
      return true;
    },
  });
}

function loadModule(source) {
  const body = String(source)
    .replace(/export\s+default\s+/g, 'const __default__ = ')
    .replace(/export\s+(async\s+)?function\s+/g, (m, isAsync) => `${isAsync || ''}function `)
    .replace(/export\s+(const|let|var)\s+/g, '$1 ')
    .replace(/export\s*\{[^}]*\}/g, '');
  return new Function(
    '"use strict";\n' +
      body +
      '\nreturn { render: typeof render === "function" ? render : null, meta: typeof meta !== "undefined" ? meta : null };',
  )();
}

function makeCard(over = {}) {
  return {
    id: 'tc-test-card',
    slug: 'test-card',
    source: 'talkcraft',
    sourcePath: 'references/cards/test-card.md',
    license: 'PolyForm-Noncommercial-1.0.0',
    licenseNote: '非商用免费',
    author: 'Vincentwei1021',
    sourceRepo: 'https://github.com/Vincentwei1021/video-talkcraft',
    title: '测试卡',
    intent: '测试用',
    kind: '文字',
    category: '字幕花字',
    tags: ['字幕花字', 'P0'],
    priority: 'P0',
    mediaNeeded: null,
    durationHint: 2,
    paramsSchema: {
      type: 'object',
      properties: { dur: { type: 'number', default: 0.7 }, text: { type: 'string', default: '你好' } },
      required: [],
    },
    propsInputs: [],
    feasibility: 'direct',
    reason: '测试',
    signals: [],
    hasReferenceCode: true,
    ...over,
  };
}

// 1) 仓库缺失降级
try {
  const catalog = await loadCatalog({
    talkcraftDir: path.join(work, 'missing-talkcraft'),
    shotcraftDir: path.join(work, 'missing-shotcraft'),
  });
  check(
    '缺仓库时不抛，降级为 found=false / 0 卡',
    catalog.sources.talkcraft.found === false &&
      catalog.sources.shotcraft.found === false &&
      catalog.stats.total === 0,
    JSON.stringify({ t: catalog.sources.talkcraft.found, s: catalog.sources.shotcraft.found, n: catalog.stats.total }),
  );
} catch (error) {
  bad('缺仓库时不抛，降级为 found=false / 0 卡', error);
}

// 2) direct
{
  const verdict = classifyFeasibility({
    corpus: 'transform: translateX(26px); opacity: 0; transition: cubic-bezier(.2,.8,.6,.85)',
  });
  check('只用位移/透明度/缓动 → direct', verdict.feasibility === 'direct', verdict.reason);
}

// 3) blur（两种写法）
{
  const a = classifyFeasibility({ corpus: 'filter: blur(8px)' });
  const b = classifyFeasibility({ corpus: 'filter: `blur(${((1 - p) * blur).toFixed(2)}px)`' });
  check(
    'blur（含模板字符串写法）→ rewrite',
    a.feasibility === 'rewrite' && b.feasibility === 'rewrite',
    `${a.feasibility}/${b.feasibility}`,
  );
}

// 4) 混合模式
{
  const verdict = classifyFeasibility({ corpus: 'mix-blend-mode: screen' });
  check('mix-blend-mode → rewrite', verdict.feasibility === 'rewrite' && /混合模式/.test(verdict.reason), verdict.reason);
}

// 5) three.js
{
  const verdict = classifyFeasibility({ corpus: "import { Canvas } from 'three';\nconst cam = new PerspectiveCamera()" });
  check('three.js / 3D 相机 → skip', verdict.feasibility === 'skip', verdict.reason);
}

// 6) clip-path
{
  const verdict = classifyFeasibility({ corpus: 'clip-path: inset(0 100% 0 0)' });
  check('clip-path → rewrite', verdict.feasibility === 'rewrite' && /clip-path/.test(verdict.reason), verdict.reason);
}

// 7) 必需媒体
{
  const verdict = classifyFeasibility({ corpus: 'OffthreadVideo src={hostSrc}', requiredMedia: 'video' });
  check(
    '必需视频 → rewrite 且 mediaNeeded 标记',
    verdict.feasibility === 'rewrite' && Array.isArray(verdict.mediaNeeded) && verdict.mediaNeeded[0] === 'video',
    JSON.stringify(verdict),
  );
}

// 8) 可选媒体不升级档位（回归：以前会把「人(可选)」判成必需视频）
{
  const media = requiredMediaFromInputs('文, 人(可选)', 'OffthreadVideo Loop hostSrc');
  check('「人(可选)」不算必需媒体', media === null, String(media));
}

// 9) tsx CONFIG
{
  const config = parseTsxConfig('const CONFIG = { a: 0.3, b: 2, name: "x", c: 1.5 };');
  check(
    '解析 tsx 的 CONFIG 默认值',
    config.a === 0.3 && config.b === 2 && config.name === 'x' && config.c === 1.5,
    JSON.stringify(config),
  );
}

// 10) 时长
{
  const a = toSeconds('约 3.8s（114f@30fps）');
  const b = toSeconds('共约 2.43s');
  check('时长解析（含帧数换算）', a === 3.8 && b === 2.43, `${a}/${b}`);
}

// 11-13) 转换产物
const libRoot = path.join(work, 'motion-lib');
let generated = '';
{
  const card = makeCard();
  const result = await convertCard(card, { motionRoot: libRoot });
  check('转换 direct 卡写出 code.js + meta.json', result.ok === true, JSON.stringify(result));
  generated = await fs.readFile(path.join(libRoot, 'tc-test-card', 'code.js'), 'utf8');
  const meta = JSON.parse(await fs.readFile(path.join(libRoot, 'tc-test-card', 'meta.json'), 'utf8'));
  let module = null;
  try {
    module = loadModule(generated);
  } catch (error) {
    bad('code.js 可被 new Function 解析', error);
  }
  check('code.js 可被 new Function 解析且导出 render', module && typeof module.render === 'function');
  check(
    'meta 的 source/license/author/sourcePath 齐全',
    meta.source === 'talkcraft' &&
      meta.license === 'PolyForm-Noncommercial-1.0.0' &&
      meta.author === 'Vincentwei1021' &&
      meta.sourcePath === 'references/cards/test-card.md',
    JSON.stringify(meta),
  );
  check(
    'code.js 顶部保留来源与许可',
    /配方来源：talkcraft \/ references\/cards\/test-card\.md/.test(generated) &&
      /PolyForm[- ]Noncommercial/.test(generated) &&
      /Vincentwei1021/.test(generated),
    '头部注释缺失',
  );

  // 12) 三个时刻都不抛
  if (module && typeof module.render === 'function') {
    const duration = Number(module.meta && module.meta.duration) || 2;
    let threw = null;
    for (const t of [0, duration / 2, duration]) {
      try {
        module.render(fakeCtx(), t, { width: 960, height: 540, props: {}, fps: 30, duration });
      } catch (error) {
        threw = `t=${t}: ${error.message}`;
        break;
      }
    }
    check('render 在 t=0 / duration/2 / duration 都不抛', threw === null, threw || '');

    // 纯函数：同一 t 两次调用画出的调用序列一致
    const a = fakeCtx();
    const b = fakeCtx();
    module.render(a, duration / 3, { width: 960, height: 540, props: {}, fps: 30, duration });
    module.render(b, duration / 3, { width: 960, height: 540, props: {}, fps: 30, duration });
    check(
      'render 对同一个 t 是纯函数（调用序列一致）',
      JSON.stringify(a.calls.map((c) => c[0])) === JSON.stringify(b.calls.map((c) => c[0])) &&
        a.calls.length > 3,
      `${a.calls.length} vs ${b.calls.length}`,
    );
  }
}

// 14) 已存在不覆盖
{
  const card = makeCard({ id: 'tc-keep-me' });
  const first = await convertCard(card, { motionRoot: libRoot });
  const codePath = path.join(libRoot, 'tc-keep-me', 'code.js');
  await fs.writeFile(codePath, '// 用户手改过的内容\n', 'utf8');
  const second = await convertCard(card, { motionRoot: libRoot });
  const after = await fs.readFile(codePath, 'utf8');
  check(
    '同 id 已存在时跳过且不覆盖用户改动',
    first.ok === true && second.ok === false && second.skipped === true && after.includes('用户手改过的内容'),
    JSON.stringify(second),
  );
}

// 15) force 备份
{
  const card = makeCard({ id: 'tc-keep-me' });
  const forced = await convertCard(card, { motionRoot: libRoot, force: true });
  const codePath = path.join(libRoot, 'tc-keep-me', 'code.js');
  const after = await fs.readFile(codePath, 'utf8');
  check(
    '--force 覆盖前备份旧文件',
    forced.ok === true &&
      typeof forced.backup === 'string' &&
      (await fs.readFile(forced.backup, 'utf8')).includes('用户手改过的内容') &&
      !after.includes('用户手改过的内容'),
    JSON.stringify(forced),
  );
}

// 17) 真实 catalog.json 自洽
{
  const repo = path.resolve(import.meta.dirname, '..');
  const catalogPath = path.join(repo, 'tools', 'recipes', 'catalog.json');
  try {
    const raw = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
    const counted = { direct: 0, rewrite: 0, skip: 0 };
    for (const card of raw.cards) counted[card.feasibility] += 1;
    const sum = counted.direct + counted.rewrite + counted.skip;
    check(
      'catalog.json 的 stats 与 cards 实际计数一致',
      raw.stats.total === raw.cards.length &&
        raw.stats.byFeasibility.direct === counted.direct &&
        raw.stats.byFeasibility.rewrite === counted.rewrite &&
        raw.stats.byFeasibility.skip === counted.skip &&
        sum === raw.stats.total,
      JSON.stringify({ stats: raw.stats.byFeasibility, counted, total: raw.stats.total, cards: raw.cards.length }),
    );
  } catch (error) {
    bad('catalog.json 的 stats 与 cards 实际计数一致', error);
  }
}

// 18) 真实 motion-lib 的 5 张标定卡（只读）
{
  const ids = [
    'tc-bar-chart-growth',
    'tc-chart-grow',
    'tc-per-character-rise',
    'tc-chevron-lower-third',
    'sc-radial-wave',
  ];
  const root = process.env.DSH_MOTION_LIB || path.join(os.homedir(), '.dsh', 'motion-lib');
  const missing = [];
  const badMeta = [];
  const notCalibrated = [];
  for (const id of ids) {
    try {
      const source = await fs.readFile(path.join(root, id, 'code.js'), 'utf8');
      const meta = JSON.parse(await fs.readFile(path.join(root, id, 'meta.json'), 'utf8'));
      const module = loadModule(source);
      if (typeof module.render !== 'function') missing.push(id + ':no-render');
      if (!meta.source || !meta.license || !meta.author) badMeta.push(id);
      if (meta.autoConverted !== false || meta.humanCalibrated !== true) notCalibrated.push(id);
    } catch (error) {
      missing.push(id + ':' + error.message);
    }
  }
  check('5 张标定卡在 motion-lib 里且可解析', missing.length === 0, missing.join(', '));
  check('5 张标定卡的 meta 带 source/license/author', badMeta.length === 0, badMeta.join(', '));
  check(
    '5 张标定卡标记为已人工标定（不是 autoConverted 骨架）',
    notCalibrated.length === 0,
    notCalibrated.join(', '),
  );
}

// 16 单独补一条：buildCode 的许可段落（构造 shotcraft 卡）
{
  const code = buildCode(makeCard({ source: 'shotcraft', license: 'Apache-2.0', sourcePath: 'references/shots/x.md', id: 'sc-x' }));
  check(
    'shotcraft 卡的 code.js 写明 Apache-2.0 与来源路径',
    /Apache-2\.0/.test(code) && /references\/shots\/x\.md/.test(code) && /Vincentwei1021/.test(code),
    '许可注释缺失',
  );
}

await fs.rm(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
