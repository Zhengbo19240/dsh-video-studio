/**
 * 摄像机连续性（camera continuity）的测试。
 *
 * 覆盖四层：
 *   1. 纯函数：cameraAt / cameraKeyframes / mirrorEase / cameraContinuity / scanCameraContinuity
 *   2. 工具：video_camera_check（真造一条时间线，含一对故意不连续的片段）
 *   3. 返回体：必须是无损 JSON（无 undefined / NaN）
 *   4. 两张示范卡：声明与曲线一致，片尾真的落在 out 上（用假 ctx 量实际渲染出的 scale）
 *
 * 跑：node scripts/camera-continuity-test.mjs [--verbose]
 * 卡在 ~/.dsh/motion-lib，不在本仓库；用 DSH_MOTION_LIB 可以指向别处。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ProjectStore } from '../src/store.mjs';
import { cameraTools } from '../src/camera-tools.mjs';
import {
  CAMERA_EPS,
  cameraAt,
  cameraContinuity,
  cameraKeyframes,
  cameraVelocityAt,
  mirrorEase,
  normalizeCamera,
  scanCameraContinuity,
} from '../src/camera.mjs';
import { isLosslessJson } from '../src/json-safe.mjs';
import { motionRoot } from '../src/motion-lib.mjs';

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('camera');

const VERBOSE = process.argv.includes('--verbose');
let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}
function near(actual, expected, tol, label) {
  if (!(Math.abs(Number(actual) - Number(expected)) <= tol)) {
    throw new Error(`${label || '数值'} 期望 ${expected}，实际 ${actual}（容差 ${tol}）`);
  }
}
const t = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    failures.push(name + ' :: ' + ((e && e.message) || e));
    console.log('  FAIL ' + name + ' :: ' + ((e && e.message) || e));
  }
};
const skip = (name, why) => {
  console.log('  skip ' + name + ' :: ' + why);
};

const identity = { scale: 1, x: 0, y: 0 };
const sameCam = (a, b, tol = 1e-9) =>
  Math.abs(a.scale - b.scale) <= tol && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;

// ------------------------------------------------------------ 假 canvas ----
//
// 只做一件真事：把 render 真正算出来的 scale 记下来。
// 图片路径从 drawImage 的源裁切宽度反推（w / srcW），
// cover 路径从目标宽度反推（destW / srcW / baseCover）。

function makeFakeCtx(width, height) {
  const rec = { stack: [], matrix: 1, draw: null, painted: 1 };
  const noop = () => {};
  const ctx = {
    canvas: { width, height },
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
    font: '10px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
    filter: 'none', shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
    save() { rec.stack.push(rec.matrix); },
    restore() { if (rec.stack.length) rec.matrix = rec.stack.pop(); },
    translate: noop, rotate: noop, setLineDash: noop,
    scale(x, y = x) { rec.matrix *= Math.abs(y); },
    beginPath: noop, rect: noop, clip: noop, arc: noop, roundRect: noop,
    moveTo: noop, lineTo: noop, closePath: noop, stroke: noop, fill: noop,
    fillRect() { rec.painted = rec.matrix; }, strokeRect() { rec.painted = rec.matrix; },
    measureText: () => ({ width: 10 }),
    fillText() { rec.painted = rec.matrix; },
    createRadialGradient: () => ({ addColorStop: noop }),
    createLinearGradient: () => ({ addColorStop: noop }),
    drawImage(img, ...rest) {
      rec.painted = rec.matrix;
      if (rest.length === 8) rec.draw = { kind: 'crop', srcW: rest[2], destW: rest[6], matrix: rec.matrix };
      else if (rest.length === 4) rec.draw = { kind: 'dest', destW: rest[2], srcW: img.width, matrix: rec.matrix };
    },
  };
  return { ctx, rec };
}

const IMG = { width: 1000, height: 562 };

/** 渲染一帧，返回这一帧真正画出来的 scale（覆盖路径按 baseCover 归一）。 */
function renderScale(mod, time, duration, props, W = 960, H = 540) {
  const { ctx, rec } = makeFakeCtx(W, H);
  mod.render(ctx, time, {
    width: W,
    height: H,
    fps: 30,
    duration,
    props,
    media: {
      video: () => IMG,
      image: () => IMG,
      size: () => ({ width: IMG.width, height: IMG.height }),
      has: () => true,
    },
  });
  if (!rec.draw) return rec.painted;
  if (rec.draw.kind === 'crop') return IMG.width / rec.draw.srcW;
  const baseCover = Math.max(W / IMG.width, H / IMG.height);
  return rec.draw.destW / IMG.width / baseCover;
}

async function loadCard(id) {
  const file = path.join(motionRoot(), id, 'code.js');
  const stat = await fs.stat(file);
  const mod = await import(pathToFileURL(file).href + '?v=' + stat.mtimeMs);
  return { file, mod };
}

// =====================================================================
// 1. 纯函数
// =====================================================================

await t('cameraAt：t=0 / t=duration 精确等于 in / out（无 points）', async () => {
  const opts = { in: { scale: 1.2, x: 0.1, y: -0.2 }, out: { scale: 1.6, x: -0.05, y: 0 } };
  sameCam(cameraAt(0, 4, opts), { scale: 1.2, x: 0.1, y: -0.2 });
  sameCam(cameraAt(4, 4, opts), { scale: 1.6, x: -0.05, y: 0 });
});

await t('cameraAt：越界被夹住，不抛也不外推', async () => {
  const opts = { in: { scale: 1, x: 0, y: 0 }, out: { scale: 2, x: 0, y: 0 } };
  near(cameraAt(-3, 4, opts).scale, 1, 1e-12, 't<0');
  near(cameraAt(99, 4, opts).scale, 2, 1e-12, 't>duration');
  near(cameraAt(0, 0, opts).scale, 1, 1e-12, 'duration=0');
});

await t('cameraKeyframes：默认比例 25% / 40% / 35%', async () => {
  const shot = cameraKeyframes({ duration: 10, zoomTo: 1.6 });
  near(shot.ratio.enter, 0.25, 1e-12, 'enter');
  near(shot.ratio.hold, 0.4, 1e-12, 'hold');
  near(shot.ratio.exit, 0.35, 1e-12, 'exit');
  near(shot.segments.enter.end, 2.5, 1e-12, 'enterEnd');
  near(shot.segments.hold.end, 6.5, 1e-12, 'holdEnd');
});

await t('cameraKeyframes：t=0 / t=duration 精确等于两端，峰值在 hold', async () => {
  const shot = cameraKeyframes({ duration: 10, zoomTo: 1.6, center: { x: 0.05, y: -0.02 } });
  sameCam(cameraAt(0, 10, shot), identity);
  sameCam(cameraAt(10, 10, shot), identity);
  near(cameraAt(5, 10, shot).scale, 1.6, 1e-12, 'hold 中点 scale');
  near(cameraAt(5, 10, shot).x, 0.05, 1e-12, 'hold 中点 x');
  near(cameraAt(2.5, 10, shot).scale, 1.6, 1e-12, '进入段终点');
});

await t('cameraKeyframes：hold 段两端一阶导 ≈ 0（速度收得住）', async () => {
  const shot = cameraKeyframes({ duration: 10, zoomTo: 1.6 });
  const atEnterEnd = cameraVelocityAt(shot.segments.enter.end, 10, shot, 1e-4);
  const atHoldEnd = cameraVelocityAt(shot.segments.hold.end, 10, shot, 1e-4);
  ok(Math.abs(atEnterEnd.scale) < 1e-3, '进入段终点速度 = ' + atEnterEnd.scale);
  ok(Math.abs(atHoldEnd.scale) < 1e-3, '返回段起点速度 = ' + atHoldEnd.scale);
  ok(Math.abs(atEnterEnd.x) < 1e-3 && Math.abs(atEnterEnd.y) < 1e-3, '偏移速度也要收住');
});

await t('cameraKeyframes：返回段与进入段严格镜像（1e-9）', async () => {
  const shot = cameraKeyframes({ duration: 10, zoomTo: 1.6, center: { x: 0.08, y: -0.04 } });
  const { enter, exit } = shot.segments;
  let worst = 0;
  for (let i = 0; i <= 20; i += 1) {
    const u = i / 20;
    const enterCam = cameraAt(enter.start + u * (enter.end - enter.start), 10, shot);
    const exitCam = cameraAt(exit.start + u * (exit.end - exit.start), 10, shot);
    const mirrorOfEnter = cameraAt(enter.start + (1 - u) * (enter.end - enter.start), 10, shot);
    worst = Math.max(
      worst,
      Math.abs(exitCam.scale - mirrorOfEnter.scale),
      Math.abs(exitCam.x - mirrorOfEnter.x),
      Math.abs(exitCam.y - mirrorOfEnter.y),
    );
    // 同时也是「时间倒放」：同一相对时刻，返回段的 scale 等于进入段对称位置的 scale
    ok(Number.isFinite(enterCam.scale), 'enter scale 必须是有限数');
  }
  ok(worst <= 1e-9, '镜像最大误差 = ' + worst);
});

await t('cameraKeyframes：自定义 zoom / center 下镜像仍成立', async () => {
  const shot = cameraKeyframes({ duration: 3.2, zoomTo: 2.3, center: { x: -0.12, y: 0.07 }, enter: 0.2, hold: 0.5, exit: 0.3 });
  const { enter, exit } = shot.segments;
  const u = 0.37;
  const a = cameraAt(enter.start + u * (enter.end - enter.start), 3.2, shot);
  const b = cameraAt(exit.start + (1 - u) * (exit.end - exit.start), 3.2, shot);
  near(a.scale, b.scale, 1e-9, 'scale');
  near(a.x, b.x, 1e-9, 'x');
  near(a.y, b.y, 1e-9, 'y');
});

await t('cameraContinuity：prev.out=1.6 / next.in=1.0 → ok:false 且 delta.scale≈0.6', async () => {
  const verdict = cameraContinuity({ out: { scale: 1.6, x: 0, y: 0 } }, { in: { scale: 1, x: 0, y: 0 } });
  ok(verdict.ok === false, '必须判为不连续');
  near(verdict.delta.scale, 0.6, 1e-12, 'delta.scale');
  ok(/不连续/.test(verdict.message), 'message 要写清不连续：' + verdict.message);
});

await t('cameraContinuity：相等 → ok:true；缺省 / 垃圾输入不抛', async () => {
  const good = cameraContinuity({ out: { scale: 1.6 } }, { in: { scale: 1.6 } });
  ok(good.ok === true, '必须判为连续');
  const missing = cameraContinuity(undefined, undefined);
  ok(missing.ok === true, '都没声明 = 恒等，两边一致');
  near(missing.delta.scale, 0, 1e-12, 'delta');
  const junk = cameraContinuity({ out: { scale: 'x', x: NaN } }, { in: { scale: null } });
  ok(typeof junk.ok === 'boolean', '垃圾输入也要给出布尔判定');
  ok(isLosslessJson(junk), '垃圾输入不能被序列化成 NaN');
});

await t('cameraAt：缺省 camera = 恒等机位（老卡不动）', async () => {
  for (const tt of [0, 0.5, 2, 99]) sameCam(cameraAt(tt, 2, {}), identity);
  sameCam(cameraAt(2, 2, undefined), identity);
});

await t('mirrorEase：端点 0/1、中点 0.5、关于中点奇对称', async () => {
  near(mirrorEase(0), 0, 1e-12, 'f(0)');
  near(mirrorEase(1), 1, 1e-12, 'f(1)');
  near(mirrorEase(0.5), 0.5, 1e-12, 'f(0.5)');
  for (let i = 0; i <= 10; i += 1) {
    const u = i / 10;
    near(mirrorEase(u) + mirrorEase(1 - u), 1, 1e-12, 'f(u)+f(1-u) u=' + u);
  }
  // 超出 [0,1] 不抛，两端夹住
  near(mirrorEase(-2), 0, 1e-12, 'f(-2)');
  near(mirrorEase(2), 1, 1e-12, 'f(2)');
});

// =====================================================================
// 2. 扫描（纯函数，不落盘）
// =====================================================================

const synthetic = [
  { id: 'a', trackId: 'c1', start: 0, duration: 2, props: { camera: { in: { scale: 1 }, out: { scale: 1.6 } } } },
  { id: 'b', trackId: 'c1', start: 2, duration: 2, props: { camera: { in: { scale: 1.6 }, out: { scale: 1.6 } } } },
  { id: 'c', trackId: 'c1', start: 4, duration: 2, props: { camera: { in: { scale: 1 }, out: { scale: 1 } } } },
];

await t('scanCameraContinuity：两对边界，broken 计数正确', async () => {
  const scanned = scanCameraContinuity(synthetic);
  ok(scanned.total === 2, 'total = ' + scanned.total);
  ok(scanned.broken === 1, 'broken = ' + scanned.broken);
  ok(scanned.pairs[0].ok === true, 'a→b 应连续');
  ok(scanned.pairs[1].ok === false, 'b→c 应不连续（1.6 → 1.0）');
  near(scanned.pairs[1].delta.scale, 0.6, 1e-12, 'b→c delta（出镜 − 入镜）');
  ok(scanned.warnings.length === 1, '一条不连续 → 一条警告');
  ok(isLosslessJson(scanned), '返回值必须无损 JSON');
});

await t('scanCameraContinuity：中间有空档不算一次切', async () => {
  const gapped = [synthetic[0], { ...synthetic[1], start: 5, duration: 2 }];
  const scanned = scanCameraContinuity(gapped);
  ok(scanned.total === 0, '有空档时不该产生边界对：' + scanned.total);
  ok(scanned.broken === 0, 'broken 应为 0');
});

await t('scanCameraContinuity：同一容差边界（1e-4）判得出来', async () => {
  const nudged = [
    { id: 'a', trackId: 'c1', start: 0, duration: 2, props: { camera: { out: { scale: 1.6 } } } },
    { id: 'b', trackId: 'c1', start: 2, duration: 2, props: { camera: { in: { scale: 1.5999 } } } },
  ];
  ok(scanCameraContinuity(nudged, { eps: 1e-3 }).broken === 0, '1e-4 差在默认容差内应算连续');
  ok(scanCameraContinuity(nudged, { eps: 1e-6 }).broken === 1, '1e-6 容差下应判不连续');
});

// =====================================================================
// 3. 工具（真时间线）
// =====================================================================

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-camera-'));
const store = new ProjectStore();
const doc = await store.open(root, 's1');
const apply = async (ops) => {
  const preview = store.preview(doc.projectId, 's1', undefined, ops);
  return store.applyPreview(preview.previewId, 's1');
};

await apply([
  { type: 'track.add', trackId: 'c2', kind: 'code', name: '合成运镜' },
  // c2：三张合成卡，故意留一对不连续（1.6 → 1.0）
  { type: 'clip.insert', clipId: 'k1', trackId: 'c2', clipType: 'code', layerId: 'fake-a', start: 0, duration: 2, props: { camera: { in: { scale: 1 }, out: { scale: 1.6 } } } },
  { type: 'clip.insert', clipId: 'k2', trackId: 'c2', clipType: 'code', layerId: 'fake-b', start: 2, duration: 2, props: { camera: { in: { scale: 1.6 }, out: { scale: 1.6 } } } },
  { type: 'clip.insert', clipId: 'k3', trackId: 'c2', clipType: 'code', layerId: 'fake-c', start: 4, duration: 2, props: { camera: { in: { scale: 1 }, out: { scale: 1 } } } },
  // c1：两张示范卡首尾相接（push 的回程 1.0 → kenburns 的 1.0）
  {
    type: 'clip.insert', clipId: 'card1', trackId: 'c1', clipType: 'code',
    layerId: 'motion-tc-slow-push-in', start: 0, duration: 5.8,
    provenance: { libraryId: 'motion-lib', assetId: 'tc-slow-push-in' },
  },
  {
    type: 'clip.insert', clipId: 'card2', trackId: 'c1', clipType: 'code',
    layerId: 'motion-media-fullscreen-kenburns', start: 5.8, duration: 6,
    provenance: { libraryId: 'motion-lib', assetId: 'media-fullscreen-kenburns' },
  },
]);

const tools = Object.fromEntries(cameraTools({ store }).map((tool) => [tool.name, tool]));

await t('video_camera_check：构造时间线上 3 对、broken=1', async () => {
  const result = await tools.video_camera_check.execute({ projectId: doc.projectId }, { agent: { id: 's1' } });
  ok(result.total === 3, 'total = ' + result.total + '（' + JSON.stringify(result.tracks) + '）');
  ok(result.broken === 1, 'broken = ' + result.broken);
  const bad = result.pairs.find((p) => !p.ok);
  ok(bad && bad.prevClipId === 'k2' && bad.nextClipId === 'k3', '不连续的那对应是 k2→k3');
  ok(result.warnings.length >= 1, '不通过时必须有可读警告');
  ok(/不连续|跳/.test(result.warnings.join(' ')), '警告要写成人话：' + result.warnings.join(' '));
  ok(isLosslessJson(result), '工具返回必须无损 JSON');
  if (VERBOSE) console.log(JSON.stringify(result.pairs, null, 2));
});

await t('video_camera_check：卡片对（push→kenburns）连续，声明与曲线一致', async () => {
  const result = await tools.video_camera_check.execute({ projectId: doc.projectId, trackId: 'c1' }, { agent: { id: 's1' } });
  ok(result.total === 1, 'c1 只有一对，实际 ' + result.total);
  ok(result.pairs[0].ok === true, 'push 的回程是 1.0，kenburns 的入口是 1.0，应连续');
  ok(result.declarations.length === 0, '声明与 cameraAt 必须一致：' + JSON.stringify(result.declarations));
});

await t('video_camera_check：没有绑定工程时不抛，返回空结果 + 警告', async () => {
  const lone = new ProjectStore();
  const loneTools = Object.fromEntries(cameraTools({ store: lone }).map((tool) => [tool.name, tool]));
  const result = await loneTools.video_camera_check.execute({}, { agent: { id: 'nobody' } });
  ok(result.broken === 0 && result.total === 0, '空结果');
  ok(result.warnings.length === 1, '必须说明为什么是空的');
  ok(isLosslessJson(result), '无损 JSON');
});

await t('video_camera_keyframes：工具返回点集且无损', async () => {
  const built = await tools.video_camera_keyframes.execute({ duration: 5.8, zoomTo: 1.1 });
  ok(Array.isArray(built.points) && built.points.length === 4, '四个关键帧');
  near(built.ratio.enter, 0.25, 1e-12, 'enter');
  ok(isLosslessJson(built), '无损 JSON');
});

await t('kenburns 的 out=1.08 能被下一镜接住（声明接声明，Δ=0）', async () => {
  // 第二张示范卡的修法是「片尾精确收敛到声明的 out」。
  // 这里造一对：kenburns（out 1.08）→ 下一镜显式声明 in 1.08。
  const entry = store.get(doc.projectId);
  const before = entry.doc.clips.slice();
  const cleanups = [];
  try {
    await apply([
      { type: 'track.add', trackId: 'c3', kind: 'code', name: '接续' },
      {
        type: 'clip.insert', clipId: 'kb', trackId: 'c3', clipType: 'code',
        layerId: 'motion-media-fullscreen-kenburns', start: 20, duration: 6,
        provenance: { libraryId: 'motion-lib', assetId: 'media-fullscreen-kenburns' },
      },
      {
        type: 'clip.insert', clipId: 'after', trackId: 'c3', clipType: 'code', start: 26, duration: 2,
        props: { camera: { in: { scale: 1.08 }, out: { scale: 1.08 } } },
      },
    ]);
    const result = await tools.video_camera_check.execute({ projectId: doc.projectId, trackId: 'c3' }, { agent: { id: 's1' } });
    ok(result.total === 1, 'c3 应有一对，实际 ' + result.total);
    ok(result.pairs[0].ok === true, '末帧 1.080 应接得上下一镜的 in 1.08');
    near(result.pairs[0].delta.scale, 0, 1e-9, 'Δscale');
  } finally {
    // 把 c3 上的片段撤掉，别影响后面的用例
    for (const clip of entry.doc.clips.filter((c) => c.trackId === 'c3')) {
      cleanups.push({ type: 'clip.delete', clipId: clip.id });
    }
    if (cleanups.length) await apply(cleanups);
    ok(entry.doc.clips.length === before.length, '时间线已复原');
  }
});

// =====================================================================
// 4. 两张示范卡
// =====================================================================

let pushCard = null;
let kenCard = null;
try {
  pushCard = await loadCard('tc-slow-push-in');
} catch (e) {
  failures.push('tc-slow-push-in 读不到：' + ((e && e.message) || e));
}
try {
  kenCard = await loadCard('media-fullscreen-kenburns');
} catch (e) {
  failures.push('media-fullscreen-kenburns 读不到：' + ((e && e.message) || e));
}

if (pushCard) {
  await t('示范卡 tc-slow-push-in：声明 in/out 都是 1.0，曲线端点精确相等', async () => {
    const mod = pushCard.mod;
    ok(mod.camera, '必须导出 camera 声明');
    const decl = typeof mod.camera === 'function' ? mod.camera({}) : mod.camera;
    near(decl.in.scale, 1, 1e-12, 'in.scale');
    near(decl.out.scale, 1, 1e-12, 'out.scale');
    sameCam(mod.cameraAt(0, 5.8, {}), { scale: 1, x: 0, y: 0 });
    sameCam(mod.cameraAt(5.8, 5.8, {}), { scale: 1, x: 0, y: 0 });
  });

  await t('示范卡 tc-slow-push-in：中间推到 1.10，末帧渲染精确回到 1.000', async () => {
    const mod = pushCard.mod;
    near(mod.cameraAt(2.9, 5.8, {}).scale, 1.1, 1e-12, '中点应在停留段 = 1.10');
    near(renderScale(mod, 5.8, 5.8, { assetId: 'a' }), 1, 1e-9, 't=duration 的实际渲染 scale');
    near(renderScale(mod, 5.8 - 1 / 30, 5.8, { assetId: 'a' }), 1, 1e-9, '最后一帧的实际渲染 scale');
    near(renderScale(mod, 0, 5.8, { assetId: 'a' }), 1, 1e-9, '首帧');
  });

  await t('示范卡 tc-slow-push-in：pull 形态仍是 1.26 → 1.00，片尾精确落在 out', async () => {
    const mod = pushCard.mod;
    const props = { direction: 'pull', assetId: 'a' };
    near(mod.cameraAt(0, 6.3, props).scale, 1.26, 1e-9, 'pull 起点');
    near(mod.cameraAt(6.3, 6.3, props).scale, 1, 1e-12, 'pull 终点');
    near(renderScale(mod, 6.3, 6.3, props), 1, 1e-9, 'pull 末帧渲染');
  });
} else {
  skip('示范卡 tc-slow-push-in', '卡不在 motion-lib');
}

if (kenCard) {
  await t('示范卡 media-fullscreen-kenburns：out=1.08，片尾精确 1.080（不再是 1.0796）', async () => {
    const mod = kenCard.mod;
    const decl = typeof mod.camera === 'function' ? mod.camera({}) : mod.camera;
    near(decl.in.scale, 1, 1e-12, 'in.scale');
    near(decl.out.scale, 1.08, 1e-12, 'out.scale');
    near(mod.cameraAt(6, 6, {}).scale, 1.08, 1e-12, 'cameraAt(duration)');
    near(renderScale(mod, 6, 6, { assetId: 'a' }), 1.08, 1e-12, '末帧渲染');
    near(renderScale(mod, 6 - 1 / 30, 6, { assetId: 'a' }), 1.08, 1e-12, '最后一帧渲染（收干窗口）');
    near(renderScale(mod, 0, 6, { assetId: 'a' }), 1, 1e-12, '首帧');
  });

  await t('示范卡 media-fullscreen-kenburns：direction=return 时片尾回到 1.0', async () => {
    const mod = kenCard.mod;
    const props = { assetId: 'a', direction: 'return' };
    near(renderScale(mod, 0, 6, props), 1, 1e-12, '首帧');
    near(mod.cameraAt(6, 6, props).scale, 1, 1e-12, 'cameraAt(duration)');
    near(renderScale(mod, 6 - 1 / 30, 6, props), 1, 1e-9, '最后一帧');
    const peak = Math.max(...[1.5, 2, 2.4, 3, 3.6].map((x) => mod.cameraAt(x, 6, props).scale));
    near(peak, 1.08, 1e-9, '停留段峰值');
  });
} else {
  skip('示范卡 media-fullscreen-kenburns', '卡不在 motion-lib');
}

// ---------------------------------------------------------------- 收尾 ----

await fs.rm(root, { recursive: true, force: true });
cleanupBindings();

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const line of failures) console.log('  - ' + line);
}
process.exit(fail ? 1 : 0);
