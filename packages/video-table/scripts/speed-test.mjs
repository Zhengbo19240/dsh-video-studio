/**
 * 变速测试：时长换算、关键帧积分、越界拒绝、同轨后续位移、源时间映射。
 *
 *   node scripts/speed-test.mjs
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.mjs';
import { sourceTime } from '../src/client/player.js';
import { averageSpeedOf, integrateSpeed } from '../src/domain.mjs';

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('speed');

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
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-sp-'));
const store = new ProjectStore();
const doc = await store.open(root, 's1');
const apply = async (ops) => {
  const p = store.preview(doc.projectId, 's1', undefined, ops);
  return store.applyPreview(p.previewId, 's1');
};
const clipsNow = () => store.get(doc.projectId).doc.clips;
const find = (id) => clipsNow().find((c) => c.id === id);

await t('恒定速度：4 秒 → 2 倍速变 2 秒；0.5 倍变 8 秒', async () => {
  await apply([{ type: 'clip.insert', clipId: 's1', trackId: 'c1', clipType: 'code', start: 0, duration: 4, layerId: 'ly1' }]);
  await apply([{ type: 'clip.set_speed', clipId: 's1', speed: 2 }]);
  if (!near(find('s1').duration, 2)) throw new Error('2× 后时长=' + find('s1').duration);
  await apply([{ type: 'clip.set_speed', clipId: 's1', speed: 0.5 }]);
  if (!near(find('s1').duration, 8)) throw new Error('0.5× 后时长=' + find('s1').duration);
  // 变回原速应回到原时长（源跨度被记住，不会叠加）
  await apply([{ type: 'clip.set_speed', clipId: 's1', speed: 1 }]);
  if (!near(find('s1').duration, 4)) throw new Error('回到 1× 后时长=' + find('s1').duration);
});

await t('keyframes 梯形积分：1×→3×，平均 2×，时长减半', async () => {
  await apply([
    { type: 'clip.insert', clipId: 'k1', trackId: 'v2', clipType: 'media', assetId: 'a1', start: 0, duration: 4 },
  ]).catch(async (e) => {
    if (e.code !== 'REF_NOT_FOUND') throw e;
    await apply([{ type: 'clip.insert', clipId: 'k1', trackId: 'v2', clipType: 'code', start: 0, duration: 4, layerId: 'ly2' }]);
  });
  await apply([
    {
      type: 'clip.set_speed',
      clipId: 'k1',
      speed: 2,
      keyframes: [
        { t: 0, speed: 1 },
        { t: 1, speed: 3 },
      ],
    },
  ]);
  if (!near(averageSpeedOf(find('k1')), 2, 1e-6)) throw new Error('平均速度=' + averageSpeedOf(find('k1')));
  if (!near(find('k1').duration, 2)) throw new Error('积分后时长=' + find('k1').duration);
  // 积分本身：∫₀^0.5 (1 + 4u) du = 0.5 + 0.5 = 1.0（关键帧 1×→3× 对应斜率 2，见 domain 的插值）
  if (!near(integrateSpeed(find('k1'), 0.5), 0.75, 1e-6)) throw new Error('半程积分=' + integrateSpeed(find('k1'), 0.5));
});

await t('越界被拒：speed 0.1 / 5、关键帧速度 5、t=1.2', async () => {
  const cases = [
    { type: 'clip.set_speed', clipId: 's1', speed: 0.1 },
    { type: 'clip.set_speed', clipId: 's1', speed: 5 },
    { type: 'clip.set_speed', clipId: 's1', speed: 1, keyframes: [{ t: 0, speed: 5 }] },
    { type: 'clip.set_speed', clipId: 's1', speed: 1, keyframes: [{ t: 1.2, speed: 2 }] },
  ];
  for (const op of cases) {
    try {
      await apply([op]);
      throw new Error('应拒绝: ' + JSON.stringify(op));
    } catch (e) {
      if (e.code !== 'INVALID_OP') throw e;
    }
  }
  if (!near(find('s1').duration, 4)) throw new Error('被拒后时长不应变: ' + find('s1').duration);
});

await t('同轨后续片段跟着位移，其它轨不动', async () => {
  await apply([
    { type: 'clip.insert', clipId: 'r1', trackId: 'v1', clipType: 'text', start: 0, duration: 4, text: 'a' },
    { type: 'clip.insert', clipId: 'r2', trackId: 'v1', clipType: 'text', start: 4, duration: 2, text: 'b' },
    { type: 'clip.insert', clipId: 'r3', trackId: 't1', clipType: 'text', start: 4, duration: 2, text: 'c' },
  ]);
  await apply([{ type: 'clip.set_speed', clipId: 'r1', speed: 2 }]);
  if (!near(find('r1').duration, 2)) throw new Error('r1 时长=' + find('r1').duration);
  if (!near(find('r2').start, 2)) throw new Error('r2 起点=' + find('r2').start);
  if (!near(find('r3').start, 4)) throw new Error('其它轨的片段被误移：' + find('r3').start);
  // 变慢也会把后续推出去
  await apply([{ type: 'clip.set_speed', clipId: 'r1', speed: 0.5 }]);
  if (!near(find('r1').duration, 8)) throw new Error('慢放后 r1=' + find('r1').duration);
  if (!near(find('r2').start, 8)) throw new Error('慢放后 r2 起点=' + find('r2').start);
});

await t('源时间映射：0 / 中间 / 末尾（恒定速度）', async () => {
  const clip = { type: 'code', start: 0, duration: 2, speed: 2, sourceIn: 0 };
  if (!near(sourceTime(clip, 0), 0, 1e-6)) throw new Error('t0=' + sourceTime(clip, 0));
  if (!near(sourceTime(clip, 1), 2, 1e-6)) throw new Error('t1=' + sourceTime(clip, 1));
  if (!near(sourceTime(clip, 2), 4, 1e-6)) throw new Error('t2=' + sourceTime(clip, 2));
  // sourceIn 偏移
  const withIn = { type: 'code', start: 0, duration: 2, speed: 2, sourceIn: 10 };
  if (!near(sourceTime(withIn, 1), 12, 1e-6)) throw new Error('sourceIn 没算: ' + sourceTime(withIn, 1));
  // 转场延长帧：越过片段末尾继续按末速外推
  if (!near(sourceTime(clip, 2.5), 5, 1e-6)) throw new Error('延长帧=' + sourceTime(clip, 2.5));
});

await t('源时间映射：keyframes 曲线积分在 0 / 0.5 / 1 边界', async () => {
  const clip = {
    type: 'code',
    start: 0,
    duration: 1,
    speed: 2,
    sourceIn: 0,
    speedKeyframes: [
      { t: 0, speed: 1 },
      { t: 1, speed: 3 },
    ],
  };
  // ∫₀^u (1+2u) du = u + u²；duration=1 → 源时间 = 0.5 + 0.25 = 0.75 在 u=0.5
  if (!near(sourceTime(clip, 0), 0, 1e-6)) throw new Error('u0=' + sourceTime(clip, 0));
  if (!near(sourceTime(clip, 0.5), 0.75, 1e-6)) throw new Error('u0.5=' + sourceTime(clip, 0.5));
  if (!near(sourceTime(clip, 1), 2, 1e-6)) throw new Error('u1=' + sourceTime(clip, 1));
});

await t('非法 keyframes（空数组 / 重复 t）被拒', async () => {
  for (const keyframes of [[], [{ t: 0.2, speed: 2 }, { t: 0.2, speed: 3 }]]) {
    try {
      await apply([{ type: 'clip.set_speed', clipId: 's1', speed: 2, keyframes }]);
      throw new Error('应拒绝 keyframes=' + JSON.stringify(keyframes));
    } catch (e) {
      if (e.code !== 'INVALID_OP') throw e;
    }
  }
});

await t('project.summary 能读出变速', async () => {
  const sum = store.summarize(store.get(doc.projectId).doc);
  if (!Array.isArray(sum.speeds) || !sum.speeds.length) throw new Error('summary 里读不到变速');
  const hit = sum.speeds.find((s) => s.clipId === 'k1');
  if (!hit) throw new Error('k1 不在 speeds 里');
  if (!near(hit.duration, 2)) throw new Error('摘要里的时长=' + hit.duration);
  if (!hit.keyframes.length) throw new Error('摘要里没有关键帧');
});

await fs.rm(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
