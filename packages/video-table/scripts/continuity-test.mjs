/**
 * 连续性检查器的测试。
 *
 * 分三层：
 *   ① 纯合成素材 —— 我**知道**正确答案：平滑位移是 smooth、单帧瞬移是 broken、
 *      亮度突变是 minor-jumps。工具判错就是工具的问题，不是素材的问题。
 *   ② 边界与错误 —— 阈值刚好超 / 刚好不超、空区间、fps 越界、帧数超限。
 *   ③ 真卡复测 —— 用 headless 渲真卡，断言「修掉的跳点不再出现」。
 *      本机没有 Chromium 时这一层打印 SKIP 而不是失败（它不是环境无关的）。
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeSeries,
  estimateShift,
  frameStats,
  judge,
  madOf,
  pairDiff,
  planTimes,
  quantile,
} from '../src/continuity.mjs';
import { detectHeadless } from '../src/headless.mjs';
import { readEntryCode } from '../src/motion-lib.mjs';
import { isLosslessJson, scanLossy } from '../src/json-safe.mjs';

let pass = 0;
let fail = 0;
let skip = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (error) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + (error && error.message));
  }
};
const skipIt = (name, why) => {
  skip += 1;
  console.log('  skip ' + name + ' :: ' + why);
};

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ------------------------------------------------------------- 合成素材 ----

const W = 320;
const H = 180;
const BG = [255, 255, 255];
const FG = [20, 20, 20];

function makeFrame(rects, fill = BG) {
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = 255;
  }
  for (const rect of rects || []) {
    const color = rect.color || FG;
    for (let y = rect.y; y < Math.min(H, rect.y + rect.h); y += 1) {
      for (let x = rect.x; x < Math.min(W, rect.x + rect.w); x += 1) {
        if (x < 0 || y < 0) continue;
        const at = (y * W + x) * 4;
        data[at] = color[0];
        data[at + 1] = color[1];
        data[at + 2] = color[2];
      }
    }
  }
  return { t: 0, width: W, height: H, data };
}

/** 一个 60×60 的方块，从 x0 开始每帧走 step px。 */
function slideSeries({ frames = 30, x0 = 100, step = 2, y = 60, jumpAt = -1, jumpBy = 0 }) {
  const out = [];
  for (let i = 0; i < frames; i += 1) {
    const extra = jumpAt >= 0 && i >= jumpAt ? jumpBy : 0;
    const frame = makeFrame([{ x: x0 + i * step + extra, y, w: 60, h: 60 }]);
    frame.t = Math.round((i / 30) * 10000) / 10000;
    out.push(frame);
  }
  return out;
}

// --------------------------------------------------------------- ① 三类 ----

await t('平滑位移 → verdict=smooth，jerk 为 0', async () => {
  const r = analyzeSeries(slideSeries({ step: 2 }));
  assert(r.verdict === 'smooth', 'verdict=' + r.verdict + ' jumps=' + JSON.stringify(r.jumps));
  assert(r.jumps.length === 0, 'jumps=' + r.jumps.length);
  assert(r.smoothness.velocityJerkP95 === 0, 'jerkP95=' + r.smoothness.velocityJerkP95);
});

await t('单帧瞬移 → verdict=broken，kind=layout', async () => {
  const r = analyzeSeries(slideSeries({ step: 2, jumpAt: 15, jumpBy: 40 }));
  assert(r.verdict === 'broken', 'verdict=' + r.verdict);
  assert(r.jumps.length >= 1, 'jumps=' + r.jumps.length);
  const hit = r.jumps[0];
  assert(hit.kind === 'layout', 'kind=' + hit.kind);
  assert(Math.abs(hit.t - 15 / 30) < 0.02, 't=' + hit.t);
  assert(hit.mad > 0.05, 'mad=' + hit.mad);
});

await t('亮度突变 → verdict=minor-jumps，kind=opacity', async () => {
  const frames = [];
  for (let i = 0; i < 20; i += 1) {
    const fill = i < 10 ? [32, 32, 32] : [240, 240, 240];
    frames.push(makeFrame([], fill));
  }
  const r = analyzeSeries(frames);
  assert(r.verdict === 'minor-jumps', 'verdict=' + r.verdict);
  assert(r.jumps.length === 1, 'jumps=' + r.jumps.length);
  assert(r.jumps[0].kind === 'opacity', 'kind=' + r.jumps[0].kind);
});

await t('camera 与 layout 的分界：整幅刚性平移 vs 局部重排', async () => {
  // 整幅铺满 + 面积不变 → 运镜
  const camera = judge(
    { mad: 0.32, shiftRatio: 0.12, lumaDelta: 0, contentRatio: 0.72, sizeChange: 0.01 },
    { spike: 0 },
  );
  assert(camera === 'camera', 'camera=' + camera);
  // 同一份位移，但内容稀薄、面积还在变 → 布局重排
  const layout = judge(
    { mad: 0.32, shiftRatio: 0.12, lumaDelta: 0, contentRatio: 0.2, sizeChange: 0.3 },
    { spike: 0 },
  );
  assert(layout === 'layout', 'layout=' + layout);
});

// --------------------------------------------------------------- ② 边界 ----

await t('judge 阈值边界：刚好到阈是跳，差一点点不是', async () => {
  const threshold = 0.035;
  const at = judge({ mad: threshold, shiftRatio: 0, lumaDelta: 0 }, { threshold, spike: 0 });
  const below = judge({ mad: threshold - 1e-9, shiftRatio: 0, lumaDelta: 0 }, { threshold, spike: 0 });
  assert(at === 'other', '刚好到阈应为 other，实际 ' + at);
  assert(below === null, '差一点点应为 null，实际 ' + below);
});

await t('judge 只挪 bbox、画面几乎没变 → 不算跳（防抗锯齿误报）', async () => {
  const kind = judge({ mad: 0.0005, shiftRatio: 0.3, lumaDelta: 0 }, { spike: 0 });
  assert(kind === null, 'kind=' + kind);
});

await t('judge 相对门槛：同样是 mad，离群才算跳', async () => {
  const baseline = { madBaseline: 0.03, shiftBaseline: 0 };
  const same = judge({ mad: 0.04, shiftRatio: 0, lumaDelta: 0 }, { ...baseline, spike: 2.5 });
  const spike = judge({ mad: 0.09, shiftRatio: 0, lumaDelta: 0 }, { ...baseline, spike: 2.5 });
  assert(same === null, '和邻居一样大不该算跳，实际 ' + same);
  assert(spike === 'other', '3 倍于邻居应算跳，实际 ' + spike);
});

await t('bbox 位移：合成图左移 10% 被识别为 10%', async () => {
  const a = makeFrame([{ x: 160, y: 60, w: 60, h: 60 }]);
  const b = makeFrame([{ x: 128, y: 60, w: 60, h: 60 }]);
  const sa = frameStats(a);
  const sb = frameStats(b);
  assert(sa.bbox.x === 160 && sb.bbox.x === 128, 'bbox=' + JSON.stringify([sa.bbox, sb.bbox]));
  const diff = pairDiff(
    { image: a, ...sa },
    { image: b, ...sb },
  );
  assert(Math.abs(diff.bboxShiftRatio - 0.1) < 0.001, 'bboxShiftRatio=' + diff.bboxShiftRatio);
  assert(diff.bboxShift > 30 && diff.bboxShift < 34, 'bboxShift=' + diff.bboxShift);
});

await t('剖面互相关：整体右移 12px 应还原 dx=12', async () => {
  const a = makeFrame([{ x: 100, y: 60, w: 40, h: 40 }]);
  const b = makeFrame([{ x: 112, y: 60, w: 40, h: 40 }]);
  const shift = estimateShift(frameStats(a), frameStats(b));
  assert(shift.dx === 12, 'dx=' + shift.dx);
  assert(shift.dy === 0, 'dy=' + shift.dy);
});

await t('静止画面：stationaryRatio=1、jitter=0、smooth', async () => {
  const frames = [];
  for (let i = 0; i < 10; i += 1) frames.push(makeFrame([{ x: 100, y: 60, w: 60, h: 60 }]));
  const r = analyzeSeries(frames);
  assert(r.verdict === 'smooth', 'verdict=' + r.verdict);
  assert(r.smoothness.stationaryRatio === 1, 'stationary=' + r.smoothness.stationaryRatio);
  assert(r.smoothness.jitterCount === 0, 'jitter=' + r.smoothness.jitterCount);
});

await t('来回抖动：jitterCount 数得出来', async () => {
  const positions = [100, 106, 100, 106, 100, 106, 100];
  const frames = positions.map((x) => makeFrame([{ x, y: 60, w: 60, h: 60 }]));
  const r = analyzeSeries(frames);
  assert(r.smoothness.jitterCount >= 5, 'jitter=' + r.smoothness.jitterCount);
  assert(r.smoothness.jitterRatio > 0.5, 'ratio=' + r.smoothness.jitterRatio);
});

await t('帧数不足：1 帧要报可读错误', async () => {
  try {
    analyzeSeries([makeFrame([])]);
    throw new Error('应当拒绝');
  } catch (error) {
    if (error.code !== 'INVALID_ARG') throw error;
    assert(/至少需要 2 帧/.test(error.message), 'message=' + error.message);
  }
});

await t('空区间（start === end）要报可读错误', async () => {
  try {
    planTimes({ start: 1, end: 1, fps: 30 });
    throw new Error('应当拒绝');
  } catch (error) {
    if (error.code !== 'INVALID_ARG') throw error;
    assert(/end\(1\) 必须大于 start\(1\)/.test(error.message), 'message=' + error.message);
  }
});

await t('start > end 要报可读错误', async () => {
  try {
    planTimes({ start: 3, end: 1, fps: 30 });
    throw new Error('应当拒绝');
  } catch (error) {
    if (error.code !== 'INVALID_ARG') throw error;
  }
});

await t('fps 越界要报可读错误（不是崩溃）', async () => {
  for (const fps of [0, 0.5, 61, 240]) {
    try {
      planTimes({ start: 0, end: 1, fps });
      throw new Error('应当拒绝 fps=' + fps);
    } catch (error) {
      if (error.code !== 'INVALID_ARG') throw error;
      assert(/fps 必须在/.test(error.message), 'fps=' + fps + ' message=' + error.message);
    }
  }
});

await t('帧数超上限要报可读错误并给出建议', async () => {
  try {
    planTimes({ start: 0, end: 30, fps: 60 });
    throw new Error('应当拒绝');
  } catch (error) {
    if (error.code !== 'INVALID_ARG') throw error;
    assert(/一次最多采 240 帧/.test(error.message), 'message=' + error.message);
  }
});

await t('负数 start 要报可读错误', async () => {
  try {
    planTimes({ start: -1, end: 2, fps: 30 });
    throw new Error('应当拒绝');
  } catch (error) {
    if (error.code !== 'INVALID_ARG') throw error;
    assert(/start 不能为负/.test(error.message), 'message=' + error.message);
  }
});

await t('planTimes：3 秒 @30fps = 90 帧，末帧 < end', async () => {
  const plan = planTimes({ start: 0, end: 3, fps: 30 });
  assert(plan.count === 90, 'count=' + plan.count);
  assert(plan.times[0] === 0, 'first=' + plan.times[0]);
  assert(plan.times[89] < 3, 'last=' + plan.times[89]);
});

// ------------------------------------------------------------ ③ 返回值 ----

await t('返回值是无损 JSON（没有 undefined / NaN）', async () => {
  const r = analyzeSeries(slideSeries({ step: 2, jumpAt: 15, jumpBy: 40 }));
  const lossy = scanLossy(r);
  assert(lossy.length === 0, 'lossy=' + JSON.stringify(lossy.slice(0, 3)));
  assert(isLosslessJson(r), 'isLosslessJson=false');
  const round = JSON.parse(JSON.stringify(r));
  assert(JSON.stringify(round) === JSON.stringify(r), '往返后结构变了');
});

await t('quantile / madOf 不吃空输入', async () => {
  assert(quantile([], 0.95) === 0, 'quantile([])=' + quantile([], 0.95));
  assert(quantile([1, 2, 3, 4], 0.5) === 2.5, 'median=' + quantile([1, 2, 3, 4], 0.5));
  const a = makeFrame([]);
  const b = makeFrame([], [0, 0, 0]);
  const mad = madOf(a, b);
  assert(Math.abs(mad - 1) < 1e-9, 'mad=' + mad);
});

// --------------------------------------------------------- ④ 真卡复测 ----

const headless = detectHeadless();
// 体检过的那 6 张卡：修后应当只有 tc-number-counter 还有 jump（计数器换字，不是布局跳）
const cardsToProbe = [
  'sc-timeline-travel',
  'tc-number-counter',
  'tc-line-by-line-slide',
  'sc-transition-travel',
  'tc-bar-chart-growth',
  'tc-lower-third-bar',
];

if (!headless.available) {
  skipIt('真卡复测（修掉的跳点不再出现）', '本机没有 Chromium 系浏览器，HEADLESS_UNAVAILABLE');
} else {
  const { measureContinuity } = await import('../src/continuity.mjs');
  const results = new Map();
  for (const card of cardsToProbe) {
    const exists = await readEntryCode(card);
    if (!exists) {
      skipIt('真卡 ' + card, '动效库里没有这张卡');
      continue;
    }
    try {
      results.set(card, await measureContinuity({ layerId: card, start: 0, end: 3, fps: 30, maxDim: 320 }));
    } catch (error) {
      skipIt('真卡 ' + card, error.code + ' ' + error.message);
    }
  }

  await t('修后 sc-transition-travel 在 0–3s 内没有跳点', async () => {
    const r = results.get('sc-transition-travel');
    assert(r, '没有拿到结果（可能被跳过）');
    assert(r.jumps.length === 0, 'jumps=' + JSON.stringify(r.jumps.map((j) => [j.t, j.kind, j.mad])));
    assert(r.verdict === 'smooth', 'verdict=' + r.verdict);
  });

  await t('修后 sc-transition-travel 的 2.5333s 不再是亮度跳变', async () => {
    const r = results.get('sc-transition-travel');
    assert(r, '没有拿到结果');
    const hit = r.jumps.find((j) => Math.abs(j.t - 2.5333) < 0.05);
    assert(!hit, '2.5333s 仍有跳点: ' + JSON.stringify(hit));
  });

  await t('6 张真卡里至少 4 张在 0–3s 内 jumps=0', async () => {
    assert(results.size >= 4, '只拿到 ' + results.size + ' 张卡的结果');
    const dirty = [...results.entries()].filter(([, r]) => r.jumps.length > 0).map(([id]) => id);
    const clean = results.size - dirty.length;
    assert(clean >= 4, '只有 ' + clean + ' 张干净；不干净的：' + dirty.join(','));
  });

  await t('真卡结果也是无损 JSON', async () => {
    for (const r of results.values()) {
      const lossy = scanLossy(r);
      assert(lossy.length === 0, 'lossy=' + JSON.stringify(lossy.slice(0, 3)));
    }
  });
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
