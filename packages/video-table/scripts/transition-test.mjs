/**
 * 转场测试：混合参数是纯函数，直接算，不需要 canvas / 浏览器。
 *
 *   node scripts/transition-test.mjs
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.mjs';
import { mixTransition, transitionAt, frameLayers } from '../src/client/player.js';
import { TRANSITION_TYPES } from '../src/domain.mjs';

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('transition');

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + (e && e.message));
  }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-tr-'));
const store = new ProjectStore();
const doc = await store.open(root, 's1');
const apply = async (ops) => {
  const p = store.preview(doc.projectId, 's1', undefined, ops);
  return store.applyPreview(p.previewId, 's1');
};
const clipsNow = () => store.get(doc.projectId).doc.clips;

await t('crossfade：0 / 0.5 / 1 的透明度', async () => {
  const z = mixTransition({ type: 'crossfade', progress: 0 });
  const h = mixTransition({ type: 'crossfade', progress: 0.5 });
  const o = mixTransition({ type: 'crossfade', progress: 1 });
  if (!near(z.alphaA, 1) || !near(z.alphaB, 0)) throw new Error('p0=' + JSON.stringify(z));
  if (!near(h.alphaA, 0.5) || !near(h.alphaB, 0.5)) throw new Error('p5=' + JSON.stringify(h));
  if (!near(o.alphaA, 0) || !near(o.alphaB, 1)) throw new Error('p1=' + JSON.stringify(o));
  if (h.dxA !== 0 || h.dxB !== 0) throw new Error('叠化不该有位移');
});

await t('push（入向，默认从左推入）：0 / 0.5 / 1 的位移', async () => {
  const a = { id: 'A', start: 0, duration: 2 };
  const b = { id: 'B', start: 2, duration: 2, transition: { in: { type: 'push', duration: 0.5 } } };
  const p0 = mixTransition({ type: 'push', progress: 0, a, b });
  const p5 = mixTransition({ type: 'push', progress: 0.5, a, b });
  const p1 = mixTransition({ type: 'push', progress: 1, a, b });
  if (!near(p0.dxB, -1) || !near(p0.dxA, 0)) throw new Error('p0=' + JSON.stringify(p0));
  if (!near(p5.dxA, 0.5) || !near(p5.dxB, -0.5)) throw new Error('p5=' + JSON.stringify(p5));
  if (!near(p1.dxA, 1) || !near(p1.dxB, 0)) throw new Error('p1=' + JSON.stringify(p1));
});

await t('push（出向）：旧画面向左推出、新画面从右补上', async () => {
  const a = { id: 'A', start: 0, duration: 2, transition: { out: { type: 'push', duration: 0.5 } } };
  const b = { id: 'B', start: 2, duration: 2 };
  const p5 = mixTransition({ type: 'push', progress: 0.5, a, b });
  if (!near(p5.dxA, -0.5) || !near(p5.dxB, 0.5)) throw new Error('p5=' + JSON.stringify(p5));
});

await t('wipe：0 / 0.5 / 1 的裁剪宽度（从左到右）', async () => {
  const p0 = mixTransition({ type: 'wipe', progress: 0 });
  const p5 = mixTransition({ type: 'wipe', progress: 0.5 });
  const p1 = mixTransition({ type: 'wipe', progress: 1 });
  if (!near(p0.clipB.w, 0)) throw new Error('p0=' + JSON.stringify(p0));
  if (!near(p5.clipB.w, 0.5) || !near(p5.clipB.x, 0)) throw new Error('p5=' + JSON.stringify(p5));
  if (!near(p1.clipB.w, 1)) throw new Error('p1=' + JSON.stringify(p1));
  if (p5.clipB.h !== 1) throw new Error('裁剪高度应为整帧');
});

await t('非法类型被拒（纯函数 + 命令两条路）', async () => {
  for (const type of ['slide', 'dissolve', '', null]) {
    let thrown = 0;
    try {
      mixTransition({ type, progress: 0.5 });
    } catch {
      thrown += 1;
    }
    if (!thrown) throw new Error('mixTransition 应拒绝 ' + type);
  }
  await apply([{ type: 'clip.insert', clipId: 'bad1', trackId: 'v1', clipType: 'text', start: 0, duration: 3, text: 'x' }]);
  try {
    await apply([{ type: 'clip.set_transition', clipId: 'bad1', in: { type: 'slide', duration: 0.4 } }]);
    throw new Error('命令应拒绝非法类型');
  } catch (e) {
    if (e.code !== 'INVALID_OP') throw e;
    if (!/转场类型/.test(e.message)) throw new Error('错误说明不含中文提示: ' + e.message);
  }
  if (TRANSITION_TYPES.join() !== 'crossfade,push,wipe') throw new Error('白名单被改了');
});

await t('时长超限/越界被拒（0.05、3 秒）', async () => {
  await apply([{ type: 'clip.insert', clipId: 'bad2', trackId: 't1', clipType: 'text', start: 0, duration: 3, text: 'y' }]);
  for (const duration of [0.05, 3]) {
    try {
      await apply([{ type: 'clip.set_transition', clipId: 'bad2', in: { type: 'crossfade', duration } }]);
      throw new Error('应拒绝 duration=' + duration);
    } catch (e) {
      if (e.code !== 'INVALID_OP') throw e;
    }
  }
});

await t('相邻片段小于 1/2 时压到上限，并存进 clip.transition', async () => {
  await apply([
    { type: 'clip.insert', clipId: 'adj1', trackId: 'c1', clipType: 'code', start: 0, duration: 2, layerId: 'ly1' },
    { type: 'clip.insert', clipId: 'adj2', trackId: 'c1', clipType: 'code', start: 2, duration: 2, layerId: 'ly2' },
  ]);
  // 2 秒的 in 会压到 min(自身/2, 邻居/2) = 1
  await apply([{ type: 'clip.set_transition', clipId: 'adj2', in: { type: 'wipe', duration: 2 } }]);
  const got = clipsNow().find((c) => c.id === 'adj2');
  if (!got.transition || !got.transition.in) throw new Error('没有写入 clip.transition');
  if (got.transition.in.type !== 'wipe') throw new Error('类型丢了');
  if (!near(got.transition.in.duration, 1)) throw new Error('未按 1/2 上限压缩：' + got.transition.in.duration);
  // 代码片段同样能吃 out 向转场
  await apply([{ type: 'clip.set_transition', clipId: 'adj1', out: { type: 'crossfade', duration: 0.5 } }]);
  const first = clipsNow().find((c) => c.id === 'adj1');
  if (!first.transition || !first.transition.out) throw new Error('代码片段没吃 out 转场');
});

await t('只有同轨相邻才有转场窗口；跨轨不做', async () => {
  const a = { id: 'A', trackId: 'v1', start: 0, duration: 2 };
  const b = { id: 'B', trackId: 'v1', start: 2, duration: 2, transition: { in: { type: 'crossfade', duration: 0.5 } } };
  const hit = transitionAt([a, b], 2.25);
  if (!hit || hit.b.id !== 'B' || !near(hit.progress, 0.5)) throw new Error('窗口算错: ' + JSON.stringify(hit));
  if (transitionAt([a, b], 3)) throw new Error('窗口外不应命中');
  // 中间有缝：不算相邻
  const gapB = { ...b, start: 2.5 };
  if (transitionAt([a, gapB], 2.6)) throw new Error('有缝也触发了转场');
  // 跨轨：v2 上只有一个片段，即使写了 in 也没有可混合的前一片段
  const solo = {
    id: 'C',
    trackId: 'v2',
    start: 0,
    duration: 2,
    transition: { in: { type: 'push', duration: 0.5 } },
  };
  if (transitionAt([solo], 0.25)) throw new Error('跨轨/无邻居不应转场');
});

await t('frameLayers 在交界处给出两层，且透明度按进度', async () => {
  const a = {
    id: 'A',
    trackId: 'v1',
    type: 'media',
    assetId: 'a1',
    start: 0,
    duration: 2,
  };
  const b = {
    id: 'B',
    trackId: 'v1',
    type: 'media',
    assetId: 'a2',
    start: 2,
    duration: 2,
    transition: { in: { type: 'crossfade', duration: 0.5 } },
  };
  const atStart = frameLayers([a, b], 2);
  const mid = frameLayers([a, b], 2.25);
  const later = frameLayers([a, b], 3);
  if (atStart.length !== 2) throw new Error('交界处应有 2 层，实际 ' + atStart.length);
  if (!near(atStart[0].alpha, 1) || !near(atStart[1].alpha, 0)) throw new Error('p0=' + JSON.stringify(atStart.map((l) => l.alpha)));
  if (!near(mid[0].alpha, 0.5) || !near(mid[1].alpha, 0.5)) throw new Error('p5=' + JSON.stringify(mid.map((l) => l.alpha)));
  if (later.length !== 1) throw new Error('窗口结束后应只剩 1 层');
  // 前一片段被「延长」绘制：localT 越过了它自己的时长
  if (!(mid[0].localT > 2)) throw new Error('前一片段没被延长: ' + mid[0].localT);
});

await t('project.summary 能读出转场', async () => {
  const sum = store.summarize(store.get(doc.projectId).doc);
  if (!Array.isArray(sum.transitions)) throw new Error('summary 没有 transitions');
  if (!sum.transitions.length) throw new Error('summary 里读不到任何转场');
  const one = sum.transitions.find((tr) => tr.in || tr.out);
  if (!one || !one.clipId) throw new Error('条目形状不对: ' + JSON.stringify(sum.transitions));
  const side = one.in || one.out;
  if (!side.type || !(side.duration > 0)) throw new Error('摘要里的转场参数不完整: ' + JSON.stringify(side));
});

await fs.rm(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
