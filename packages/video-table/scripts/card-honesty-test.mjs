#!/usr/bin/env node
/**
 * 卡库诚实性验收（2026-11-06）。
 *
 *   node scripts/card-honesty-test.mjs
 *
 * 判据不是「谁写了多少注释」，而是「卡片名字承诺的事，实现里到底有没有」：
 *   1. 9 张被复核的卡，每张都得有 verdict 或 limitations（二选一，不能都没有）；
 *   2. 「修好」的卡必须有**行为断言**接住：环上张数按素材自适应、键帽形状不再 8 循环、
 *      翻面有真透视与页厚、文字遮罩真的建出来了、关注卡不再抄具体平台；
 *   3. 「降级」的卡标题/描述必须改成它能做到的事，limitations 必须具体（不写「效果略差」）；
 *   4. 「标废」的卡要能被列表过滤：verdict 透出 + 过滤器真的能把 not-supported 剔掉；
 *   5. 所有卡 render 仍可解析，t 取 0 / 负数 / 超时长 / NaN 都不抛；
 *   6. 4 张受保护卡的 code.js + meta.json 校验和一个字节都不能变（硬断言）。
 *
 * 卡片的 code.js 用真 ESM 动态 import 加载（不是 new Function 兜底），
 * 这样导出的纯函数（ringPlan / glyphPlan / projectX / maskInfo）可以直接测。
 */

import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listEntries, motionRoot } from '../src/motion-lib.mjs';

const ROOT = motionRoot();

/** 本轮被复核的 9 张卡（清单来自各批 agent 的 honesty 自评）。 */
const CANDIDATES = [
  'sc-letterspace-materialize',
  'tc-behind-text-title',
  'sc-text-as-mask',
  'tc-douyin-follow-card',
  'sc-orbit-ring-title-open',
  'sc-icon-field-colorize',
  'sc-integration-hub-map',
  'sc-graze-face-tour',
  'sc-steep-tilt-glide',
];

/**
 * 绝对不许碰的 4 张（另一路在优化性能）：校验和基线。
 *
 * 基线取「本路收工时刻」的快照 —— 注意 tc-bed-echo-blur 在这段时间里正被另一路改写
 * （16:34:26 → 16:35:13 → 16:36:00 连续三个不同哈希），所以这里记的是它当时的版本，
 * 不是审计开始前的版本。本路一个字都没写过这 4 张；如果它们以后又变了，这条断言会红，
 * 那是真的有人动了文件：
 *   - 想确认是不是另一路在优化：看 mtime 与 `git log`（卡在 ~/.dsh/motion-lib，不在本仓库）；
 *   - 确认是正当改动后刷新基线：`HONESTY_PROTECTED_BASELINE=1 node scripts/card-honesty-test.mjs --refresh`。
 */
const PROTECTED = {
  // 快照时刻：性能优化那一轮收工 + bed-echo 的 document 降级 bug 修完之后。
  // 这些卡在该轮是「允许被改」的，所以基线跟最终态；不是放松守卫。
  'sc-transition-travel': { code: '09c82d391a325160e032bb7b345098666ebc1b25c86257b68be735bb36aa6c67', meta: 'da67943b9878bd4d8021e6288376e4dae758c74a6fdb6ba2f4d1eb8a4aa4e5ea' },
  'tc-bed-echo-blur': { code: '849db68528e16d33fae5da6beeaf931ad95b2590d9f4106842a6633853c308ac', meta: 'a50d411e4ff467ecf1471c948f16ca43341856fd3aa8b4e5dabadc6c8be5cbd5' },
  'sc-crash-zoom-punch': { code: 'aff33986efe79ce2510f8100dd3400a143fc90d4c88099f4cebd1fd78f182177', meta: '695b7cddb7344c189d1ecb542f50c74062391c79b40541f9e86e06175c8d4caa' },
  'sc-page-waterfall-wall': { code: '99223055cc191376302e95a94d57634c1cc416f02f050c17b9c49f9162794f94', meta: '27422bf524145bb52f52b68db09673e403a7036ae29c98d287c5b0d02f350341' },
};

/** worker 渲染路径的 16:9 画框；也测一次竖屏，确认外壳不炸。 */
const FRAMES = [
  { width: 1280, height: 720 },
  { width: 720, height: 1280 },
];

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

function sha256File(file) {
  return crypto.createHash('sha256').update(crypto.createHash('sha256').update('').digest('hex') + '').digest('hex');
}

async function fileSha(file) {
  const buf = await fs.readFile(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 最小 Canvas2D 替身：记录 drawImage / fillText 调用，getImageData 可选返回不透明像素。 */
function mockCtx(options = {}) {
  const calls = { drawImage: 0, fillText: 0, clip: 0 };
  const noop = () => {};
  const target = {
    measureText: (text) => ({ width: String(text).length * 8 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    getImageData: (x, y, w, h) => {
      const n = Math.max(1, Math.round(w) * Math.round(h) * 4);
      return { data: new Uint8ClampedArray(n).fill(options.opaque ? 255 : 0) };
    },
    drawImage: () => {
      calls.drawImage += 1;
    },
    fillText: () => {
      calls.fillText += 1;
    },
    clip: () => {
      calls.clip += 1;
    },
  };
  const methods = [
    'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo',
    'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'fill', 'stroke', 'fillRect', 'clearRect', 'strokeRect',
    'strokeText', 'translate', 'scale', 'rotate', 'transform', 'setTransform', 'putImageData', 'setLineDash',
    'getTransform',
  ];
  for (const m of methods) target[m] = noop;
  target.canvas = { width: 1280, height: 720 };
  const proxy = new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (prop === 'canvas') return { width: 1280, height: 720 };
      return undefined;
    },
    set() {
      return true;
    },
  });
  return { ctx: proxy, calls };
}

/** 假的素材（画布替身）：只要求 width/height 与可被 drawImage 接受。 */
function fakeAsset(w = 640, h = 360) {
  return { width: w, height: h };
}

function makeEnv(frame, extra = {}) {
  return {
    width: frame.width,
    height: frame.height,
    props: {},
    fps: 30,
    duration: 3,
    media: { video: () => null, image: () => null },
    ...extra,
  };
}

/** 用真 ESM 加载一张卡；cacheBust 让同一张卡可以拿到多个独立实例。 */
async function loadCard(id, cacheBust = '') {
  const file = path.join(ROOT, id, 'code.js');
  const url = pathToFileURL(file).href + (cacheBust ? '?v=' + cacheBust : '');
  return import(url);
}

async function readMeta(id) {
  return JSON.parse(await fs.readFile(path.join(ROOT, id, 'meta.json'), 'utf8'));
}

async function readCode(id) {
  return fs.readFile(path.join(ROOT, id, 'code.js'), 'utf8');
}

async function main() {
  if (process.argv.includes('--refresh-protected')) {
    // 刷新基线用：只打印，不写文件（本测试不回写仓库）。
    console.log('把下面四段贴回 CANDIDATES 上面的 PROTECTED：');
    for (const id of Object.keys(PROTECTED)) {
      const code = await fileSha(path.join(ROOT, id, 'code.js'));
      const meta = await fileSha(path.join(ROOT, id, 'meta.json'));
      console.log("  '" + id + "': { code: '" + code + "', meta: '" + meta + "' },");
    }
    return;
  }
  const metas = new Map();
  for (const id of CANDIDATES) {
    metas.set(id, await readMeta(id));
  }

  await check('9 张候选卡都在库里且 meta 可解析', () => {
    for (const id of CANDIDATES) {
      const meta = metas.get(id);
      assert(meta && typeof meta === 'object', `${id} 缺 meta.json`);
    }
    return `${CANDIDATES.length} 张`;
  });

  await check('每张卡都有 verdict 或 limitations（二选一，不能都没有）', () => {
    const bare = [];
    for (const id of CANDIDATES) {
      const meta = metas.get(id);
      const hasVerdict = typeof meta.verdict === 'string' && meta.verdict.length > 0;
      const hasLimits = Array.isArray(meta.limitations) && meta.limitations.length > 0;
      if (!hasVerdict && !hasLimits) bare.push(id);
    }
    assert(bare.length === 0, `既没 verdict 也没 limitations：${bare.join(', ')}`);
    return '全部有交代';
  });

  await check('verdict 值域合法（fixed / approximate / not-supported / unreviewed）', () => {
    const legal = new Set(['fixed', 'approximate', 'not-supported', 'unreviewed']);
    for (const id of CANDIDATES) {
      const v = metas.get(id).verdict;
      assert(legal.has(v), `${id} verdict=${v}`);
    }
    return '全部合法';
  });

  await check('「修好」的至少有 4 张（修不动的不许硬说是修好）', () => {
    const fixed = CANDIDATES.filter((id) => metas.get(id).verdict === 'fixed');
    assert(fixed.length >= 4, `只有 ${fixed.length} 张标 fixed`);
    return fixed.join(', ');
  });

  await check('「降级」的卡 limitations 具体（≥3 条、每条 ≥12 字、不许「效果略差」）', () => {
    const generic = ['效果略差', '略有差异', '有点区别', '不太像', '手感一般'];
    const degraded = CANDIDATES.filter((id) => metas.get(id).verdict === 'approximate');
    assert(degraded.length > 0, '一张降级卡都没有，这条断言失去意义');
    for (const id of degraded) {
      const meta = metas.get(id);
      assert(Array.isArray(meta.limitations), `${id} 缺 limitations`);
      assert(meta.limitations.length >= 3, `${id} limitations 只有 ${meta.limitations.length} 条`);
      for (const text of meta.limitations) {
        assert(typeof text === 'string' && text.trim().length >= 12, `${id} 有一条 limitations 太短：${text}`);
        for (const g of generic) assert(!text.includes(g), `${id} 写了空话「${g}」`);
      }
    }
    return `${degraded.length} 张：${degraded.join(', ')}`;
  });

  await check('「降级」的卡标题/描述改成它真实能做到的事（出现「近似/剪影」等限定）', () => {
    for (const id of CANDIDATES.filter((x) => metas.get(x).verdict === 'approximate')) {
      const meta = metas.get(id);
      const blob = String(meta.title || '') + String(meta.description || '');
      assert(/近似|剪影|描边/.test(blob), `${id} 标题和描述都不带限定词，还在用旧名字`);
    }
    return '标题已如实收窄';
  });

  await check('标废机制：verdict 透出到条目列表，且可被过滤掉', async () => {
    // 真库里本轮 0 张标废；用一份临时 fixture 证明「not-supported → 列表可见 → 过滤后消失」这条路是通的。
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'honesty-lib-'));
    const fixture = path.join(tmp, 'zz-honesty-fixture');
    await fs.mkdir(fixture, { recursive: true });
    await fs.writeFile(
      path.join(fixture, 'meta.json'),
      JSON.stringify({ title: '标废样例', verdict: 'not-supported', verdictReason: '做不到它名字承诺的效果（测试夹具）' }),
      'utf8',
    );
    await fs.writeFile(path.join(fixture, 'code.js'), 'export function render() {}\n', 'utf8');
    const before = process.env.DSH_MOTION_LIB;
    process.env.DSH_MOTION_LIB = tmp;
    try {
      const entries = await listEntries();
      const one = entries.find((e) => e.id === 'zz-honesty-fixture');
      assert(one, '临时库里的标废卡没被列出来');
      assert(one.verdict === 'not-supported', `verdict 没透出（拿到 ${one.verdict}）`);
      const visible = entries.filter((e) => e.verdict !== 'not-supported');
      assert(!visible.some((e) => e.id === 'zz-honesty-fixture'), '过滤后标废卡还在列表里');
    } finally {
      if (before === undefined) delete process.env.DSH_MOTION_LIB;
      else process.env.DSH_MOTION_LIB = before;
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
    const real = await listEntries();
    for (const id of CANDIDATES) {
      const entry = real.find((e) => e.id === id);
      assert(entry, `真库里找不到 ${id}`);
      assert(entry.verdict === metas.get(id).verdict, `${id} 列表里的 verdict 与 meta 不一致`);
      if (metas.get(id).verdict === 'approximate') {
        assert(Array.isArray(entry.limitations) && entry.limitations.length > 0, `${id} 列表里没带 limitations`);
      }
    }
    return '真实 0 张标废；透出与过滤机制已验证';
  });

  // ---------- 修好的卡：行为断言 ----------

  await check('轨道环：环上张数按素材数自适应（0/1/3/8 条）', async () => {
    const card = await loadCard('sc-orbit-ring-title-open');
    assert(typeof card.ringPlan === 'function', '没导出 ringPlan');
    const zero = card.ringPlan(0);
    assert(zero.slots === 8 && zero.mediaCount === 0 && zero.placeholders === 8, `0 素材时 ${JSON.stringify(zero)}`);
    const one = card.ringPlan(1);
    assert(one.slots === 4, `1 条素材时环上应是 4 张，实际 ${one.slots}`);
    assert(one.mediaCount === 1 && one.placeholders === 3, `1 条素材应以 1 张素材卡 + 3 张占位卡组成，实际 ${JSON.stringify(one)}`);
    const three = card.ringPlan(3);
    assert(three.slots === 4 && three.mediaCount === 3 && three.placeholders === 1, `3 条素材时 ${JSON.stringify(three)}`);
    const eight = card.ringPlan(8);
    assert(eight.slots === 8 && eight.placeholders === 0, `8 条素材时 ${JSON.stringify(eight)}`);
    return '0→8占位 / 1→4(1+3) / 3→4(3+1) / 8→8';
  });

  await check('轨道环：只有 1 条素材时不再把同一张图铺 8 次（drawImage 只调 1 次）', async () => {
    const card = await loadCard('sc-orbit-ring-title-open');
    const { ctx, calls } = mockCtx();
    const asset = fakeAsset();
    const env = makeEnv(FRAMES[0], {
      props: { assetId: 'a1' },
      duration: card.meta.duration,
      media: { video: (id) => (id === 'a1' ? asset : null), image: (id) => (id === 'a1' ? asset : null) },
    });
    card.render(ctx, 2.4, env);
    assert(calls.drawImage === 1, `1 条素材却画了 ${calls.drawImage} 次图（旧版是 8 次）`);
    return 'drawImage×1';
  });

  await check('轨道环：素材 1 条时占位卡互不相同（不再读成同一张图）', async () => {
    const card = await loadCard('sc-orbit-ring-title-open');
    const plan = card.ringPlan(1);
    const variants = plan.cards.filter((c) => c.kind === 'placeholder').map((c) => c.variant);
    assert(variants.length === 3, `占位卡数量 ${variants.length}`);
    assert(new Set(variants).size === variants.length, `占位卡有重复：${variants.join(',')}`);
    return variants.join(',');
  });

  await check('图标场：170 个键帽不再是 8 种形状循环（≥50 种组合、单组合 ≤5 次）', async () => {
    const card = await loadCard('sc-icon-field-colorize');
    assert(typeof card.glyphPlan === 'function', '没导出 glyphPlan');
    const plan = card.glyphPlan();
    assert(plan.count === 170, `键帽数 ${plan.count}`);
    const sig = new Map();
    for (let i = 0; i < plan.count; i += 1) {
      const key = plan.kinds[i] + ':' + plan.variants[i];
      sig.set(key, (sig.get(key) || 0) + 1);
    }
    assert(sig.size >= 50, `只有 ${sig.size} 种字形组合`);
    const maxRepeat = Math.max(...sig.values());
    assert(maxRepeat <= 5, `有一种组合出现 ${maxRepeat} 次，还是能看出循环`);
    assert(new Set(plan.kinds).size >= 12, `字形种类只有 ${new Set(plan.kinds).size} 种`);
    // 相邻键位不许同形（否则整行读起来像一条重复的带）
    let adjacentSame = 0;
    for (let i = 1; i < plan.count; i += 1) {
      if (plan.kinds[i] === plan.kinds[i - 1] && plan.variants[i] === plan.variants[i - 1]) adjacentSame += 1;
    }
    assert(adjacentSame === 0, `有 ${adjacentSame} 对相邻键帽同形同修饰`);
    return `${sig.size} 种组合，单组合最多 ${maxRepeat} 次`;
  });

  await check('集成枢纽图：翻面有真透视（近缘比远缘宽，宽度随角度收缩）', async () => {
    const card = await loadCard('sc-integration-hub-map');
    assert(typeof card.projectX === 'function', '没导出 projectX');
    const half = 300;
    const d = 600;
    const near = Math.abs(card.projectX(half, Math.PI / 4, d));
    const far = Math.abs(card.projectX(-half, Math.PI / 4, d));
    assert(near > far * 1.15, `45° 时近缘 ${near.toFixed(1)} 没比远缘 ${far.toFixed(1)} 明显宽（还是仿射）`);
    let last = Infinity;
    for (const deg of [0, 15, 30, 45, 60, 75, 89]) {
      const width = Math.abs(card.projectX(half, (deg * Math.PI) / 180, d) - card.projectX(-half, (deg * Math.PI) / 180, d));
      assert(width <= last + 1e-6, `${deg}° 时页宽 ${width.toFixed(1)} 反而变宽了`);
      last = width;
    }
    return `45° 近/远 = ${(near / far).toFixed(2)}`;
  });

  await check('集成枢纽图：侧棱厚度在 90° 最宽、0°/180° 归零', async () => {
    const card = await loadCard('sc-integration-hub-map');
    assert(typeof card.edgeWidth === 'function', '没导出 edgeWidth');
    const t = 16;
    assert(card.edgeWidth(0, t) === 0, '0° 时不该有侧棱');
    assert(Math.abs(card.edgeWidth(Math.PI, t)) < 1e-9, '180° 时不该有侧棱');
    assert(Math.abs(card.edgeWidth(Math.PI / 2, t) - t) < 1e-9, '90° 时侧棱应等于页厚');
    return '0 / 90=t / 180=0';
  });

  await check('文字当遮罩：有离屏表面时真的建出遮罩（opaque>0，mode=offscreen）', async () => {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'OffscreenCanvas');
    const before = globalThis.OffscreenCanvas;
    globalThis.OffscreenCanvas = class {
      constructor(w, h) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        return mockCtx({ opaque: true }).ctx;
      }
    };
    try {
      const card = await loadCard('sc-text-as-mask', 'offscreen');
      const { ctx } = mockCtx();
      card.render(ctx, 1.6, makeEnv(FRAMES[0], { props: { assetId: 'a1' }, duration: 3.4, media: { image: () => fakeAsset(), video: () => null } }));
      const info = card.maskInfo();
      assert(info.mode === 'offscreen', `maskInfo.mode=${info.mode}`);
      assert(info.opaque > 0, `遮罩像素为 ${info.opaque}（旧版就是 0，等于没有遮罩）`);
      assert(info.built > 0, '一次都没建遮罩');
    } finally {
      if (had) globalThis.OffscreenCanvas = before;
      else delete globalThis.OffscreenCanvas;
    }
    return 'offscreen 遮罩有像素';
  });

  await check('文字当遮罩：既无 OffscreenCanvas 又无 document 时降级但不抛', async () => {
    const hadOff = Object.prototype.hasOwnProperty.call(globalThis, 'OffscreenCanvas');
    const beforeOff = globalThis.OffscreenCanvas;
    const hadDoc = Object.prototype.hasOwnProperty.call(globalThis, 'document');
    const beforeDoc = globalThis.document;
    delete globalThis.OffscreenCanvas;
    delete globalThis.document;
    try {
      const card = await loadCard('sc-text-as-mask', 'no-canvas');
      const { ctx } = mockCtx({ opaque: false });
      card.render(ctx, 2.0, makeEnv(FRAMES[0], { duration: 3.4 }));
      const info = card.maskInfo();
      assert(info.mode === 'none', `无离屏表面时应是 none，实际 ${info.mode}`);
    } finally {
      if (hadOff) globalThis.OffscreenCanvas = beforeOff;
      else delete globalThis.OffscreenCanvas;
      if (hadDoc) globalThis.document = beforeDoc;
      else delete globalThis.document;
    }
    return 'none 降级不抛';
  });

  await check('关注卡：不再抄具体平台（画面/文案里没有平台标识与品牌色）', async () => {
    const code = await readCode('tc-douyin-follow-card');
    const meta = metas.get('tc-douyin-follow-card');
    // 只查「会进画面的东西」：源码 + 标题 + 描述 + limitations。
    // sourcePath / sourceRepo / 条目 id 是出处与历史键，改它等于伪造出处或断引用，留着。
    const blob = code + String(meta.title || '') + String(meta.description || '') + (meta.limitations || []).join('\n');
    const banned = ['抖音', 'Douyin', '#EB455B', '#1E9FFF', '#161823', '#9299A4', 'dy_avatar'];
    for (const word of banned) assert(!blob.includes(word), `画面/文案里还残留平台痕迹：${word}`);
    // 允许出现来源卡的文件名（douyin-follow-card.md）——那是出处，不是画面皮。
    assert(!/douyin/i.test(String(meta.title || '') + String(meta.description || '')), '标题/描述还在按平台名自称');
    assert(/关注/.test(String(meta.title)), `标题应说明它是「关注」卡，实际「${meta.title}」`);
    assert(code.includes('已关注') && code.includes('发私信'), '两态与副位文案不见了（动作结构被改坏）');
    return '中性画面（出处字段除外）';
  });

  // ---------- 通用：可解析 + t 越界 ----------

  await check('9 张卡 render 可解析，t=0 / 负数 / 超时长 / NaN 都不抛（16:9 与竖屏）', async () => {
    for (const id of CANDIDATES) {
      const card = await loadCard(id, 'render-' + id);
      assert(typeof card.render === 'function', `${id} 没导出 render`);
      const duration = Number(metas.get(id).duration) || 3;
      for (const frame of FRAMES) {
        const { ctx } = mockCtx();
        const env = makeEnv(frame, { duration, props: { assetId: 'a1' }, media: { video: () => fakeAsset(), image: () => fakeAsset() } });
        for (const t of [0, -3, duration * 2.5, NaN]) {
          card.render(ctx, t, env);
        }
      }
    }
    return `${CANDIDATES.length} 张 × 4 个 t × 2 种画框`;
  });

  await check('9 张卡 media(props) 都返回数组（没有就空数组）', async () => {
    for (const id of CANDIDATES) {
      const card = await loadCard(id, 'media-' + id);
      assert(typeof card.media === 'function', `${id} 没导出 media`);
      const none = card.media({});
      assert(Array.isArray(none) && none.length === 0, `${id} 无素材时应是空数组，拿到 ${JSON.stringify(none)}`);
      const one = card.media({ assetId: 'a1' });
      assert(Array.isArray(one) && one.length === 1 && one[0] === 'a1', `${id} 有素材时没返回 ['a1']`);
    }
    return 'media 契约稳定';
  });

  // ---------- 受保护卡 ----------

  await check('4 张受保护卡的 code.js + meta.json 校验和未变（一个字节都没动）', async () => {
    const drift = [];
    for (const [id, expected] of Object.entries(PROTECTED)) {
      const code = await fileSha(path.join(ROOT, id, 'code.js'));
      const meta = await fileSha(path.join(ROOT, id, 'meta.json'));
      if (code !== expected.code) drift.push(`${id}/code.js（现 ${code.slice(0, 8)}… 基线 ${expected.code.slice(0, 8)}…）`);
      if (meta !== expected.meta) drift.push(`${id}/meta.json（现 ${meta.slice(0, 8)}… 基线 ${expected.meta.slice(0, 8)}…）`);
    }
    assert(
      drift.length === 0,
      '受保护卡被改动了：' + drift.join('；') + '。本路没有写过它们 —— 先确认是不是另一路在优化性能，再刷新基线。',
    );
    return Object.keys(PROTECTED).length + ' 张未变';
  });

  await check('4 张受保护卡仍在列表里且 native 可用', async () => {
    const entries = await listEntries();
    for (const id of Object.keys(PROTECTED)) {
      const entry = entries.find((e) => e.id === id);
      assert(entry, `列表里找不到 ${id}`);
      assert(entry.native === true && entry.needRender === false, `${id} 不再是 native`);
    }
    return '仍在库里';
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

void sha256File;



