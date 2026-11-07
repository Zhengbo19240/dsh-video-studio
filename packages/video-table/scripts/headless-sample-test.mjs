/**
 * 无头采样 / 探路 / contact sheet / 成片回填 —— 验收测试。
 *
 *   node scripts/headless-sample-test.mjs
 *
 * 需要本机有 Chromium 系浏览器（Chrome 或 Edge）才会跑真实渲帧；
 * 没有的话相关用例标 skipped 并写明原因，绝不假装通过。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useTempBindings } from './_bindings-guard.mjs';
import { ProjectStore } from '../src/store.mjs';
import { SampleBroker } from '../src/samples.mjs';
import { videoTools, normalizeStripArgs } from '../src/tools.mjs';
import { detectHeadless, engineVersion, renderFramesHeadless } from '../src/headless.mjs';
import { pngMad, decodePng } from '../src/headless-png.mjs';
import { isLosslessJson, scanLossy, sanitizeJson, errorJson } from '../src/json-safe.mjs';

const cleanupBindings = useTempBindings('headless-sample');
const SESSION = 's-headless';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-hs-'));

let pass = 0;
let fail = 0;
let skip = 0;
function ok(name, extra) {
  pass += 1;
  console.log('  ok   ' + name + (extra ? '  :: ' + extra : ''));
}
function bad(name, e) {
  fail += 1;
  console.log('  FAIL ' + name + ' :: ' + (e && e.message ? e.message : e));
}
function skipped(name, why) {
  skip += 1;
  console.log('  SKIP ' + name + ' :: ' + why);
}
async function step(name, fn, timeoutMs = 180000) {
  try {
    const value = await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('步骤超时 ' + timeoutMs + 'ms')), timeoutMs)),
    ]);
    ok(name);
    return value;
  } catch (e) {
    if (e && e.skip) {
      skipped(name, e.skip);
      return null;
    }
    bad(name, e);
    return null;
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** 深相等的极简实现：只用于「JSON 往返后结构不变」这类纯数据断言。 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

/**
 * 工具返回体必须过「无损 JSON」这一关：
 *   1) 深扫没有 undefined / NaN / Infinity / function / symbol / bigint / 环；
 *   2) JSON 往返后深等（键不丢、值不变成别的东西）；
 *   3) 清洗后的副本还必须与原件等价（清洗不该改变可表达的字段）。
 */
function assertLossless(label, value) {
  const lossy = scanLossy(value);
  assert(lossy.length === 0, `${label} 不是无损 JSON：${JSON.stringify(lossy.slice(0, 5))}`);
  const round = JSON.parse(JSON.stringify(value));
  assert(deepEqual(round, value), `${label} JSON 往返后结构变了`);
  assert(deepEqual(sanitizeJson(value), round), `${label} sanitizeJson 与往返结果不一致`);
}

function maxChannel(decoded) {
  let max = 0;
  for (let i = 0; i < decoded.data.length; i += 4) {
    max = Math.max(max, decoded.data[i], decoded.data[i + 1], decoded.data[i + 2]);
  }
  return max;
}

function meanChannel(decoded) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < decoded.data.length; i += 4) {
    sum += (decoded.data[i] + decoded.data[i + 1] + decoded.data[i + 2]) / 3;
    n += 1;
  }
  return n ? sum / n : 0;
}

const store = new ProjectStore();
const samples = new SampleBroker();
const tools = Object.fromEntries(videoTools({ store, samples }).map((t) => [t.name, t]));
const call = (name, args) => tools[name].execute(args, { agent: { id: SESSION } });

// ---------------------------------------------------------------- 工程夹具 ----
const doc = await store.open(root, SESSION);
const projectId = doc.projectId;

const CARD_CODE = `export function render(ctx, t, env) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 8; i += 1) {
    ctx.fillStyle = i % 2 ? '#7c5cff' : '#22c55e';
    ctx.fillRect((i * w) / 8, 0, w / 8, h * 0.12);
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 56px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('T ' + t.toFixed(2), w / 2, h / 2);
}`;
const setup = await call('video_setup', { dir: root, files: [] });
const codeWrite = await call('video_code_write', {
  projectId,
  layerId: 'card',
  source: CARD_CODE,
  start: 0,
  duration: 8,
});
const preview = await call('video_edit_preview', {
  projectId,
  baseRevision: codeWrite.revision,
  summary: '测试卡：文字 + 代码图层',
  ops: [
    {
      type: 'clip.insert',
      clipId: 'c_text',
      trackId: 'v1',
      clipType: 'text',
      start: 0,
      duration: 8,
      text: '无头渲染验收',
    },
  ],
});
await call('video_edit_apply', { previewId: preview.previewId });

const headless = detectHeadless();

// ------------------------------------------------------------------- 探路 ----
console.log('\n[probe]');
await step('probe：面板没开时 workbenchOpen=false 且字段齐全', async () => {
  const value = await call('video_probe', { projectId });
  assert(value.workbenchOpen === false, 'workbenchOpen 应为 false');
  assert(typeof value.engineVersion === 'string' && value.engineVersion.length > 0, '缺 engineVersion');
  assert(typeof value.headlessAvailable === 'boolean', '缺 headlessAvailable');
  assert(value.project && value.project.projectId === projectId, '缺 project.projectId');
  assert(value.project.root === root, 'project.root 不对');
  assert(value.enabledQuota && value.enabledQuota.max === 2, 'enabledQuota 不对');
});

await step('probe：面板心跳后 workbenchOpen=true', async () => {
  samples.touchPoll(projectId);
  const value = await call('video_probe', { projectId });
  assert(value.workbenchOpen === true, '面板心跳后应为 true');
  assert(value.sampleBroker.lastPollAt > 0, '缺 lastPollAt');
});

await step('probe：没有工程时 project=null，不抛错', async () => {
  samples.lastPoll.clear();
  samples.lastAnyPollAt = 0;
  const value = await tools.video_probe.execute({}, { agent: { id: 's-empty' } });
  assert(value.project === null, 'project 应为 null');
  assert(value.workbenchOpen === false, 'workbenchOpen 应为 false');
});

// --------------------------------------------------------------- 采样降级 ----
console.log('\n[sample]');
let headlessFramePath = null;
await step('sample：面板没开 → via=headless，PNG 落盘且尺寸正确', async () => {
  if (!headless.available) throw Object.assign(new Error('SKIP'), { skip: '本机没有 Chromium 系浏览器' });
  const value = await call('video_sample', { projectId, times: [1.5], maxDim: 480 });
  assertLossless('video_sample(headless)', value);
  assert(value.via === 'headless', 'via 应为 headless，实际 ' + value.via);
  assert(value.samples.length === 1, '应返回 1 帧');
  const file = value.samples[0].path;
  const stat = await fs.stat(file);
  assert(stat.size > 1000, 'PNG 太小，疑似空图');
  assert(file.endsWith('.png'), '无头路径应落 PNG');
  const decoded = decodePng(await fs.readFile(file));
  assert(decoded.width === 480 && decoded.height === 270, `尺寸应为 480x270，实际 ${decoded.width}x${decoded.height}`);
  headlessFramePath = file;
});

await step('sample：面板开着 → via=panel（面板回传 JPEG）', async () => {
  samples.touchPoll(projectId);
  const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const timer = setInterval(() => {
    const pending = samples.list(projectId);
    for (const req of pending) samples.fulfill(projectId, root, req.requestId, req.times.map((t) => ({ time: t, dataUrl: jpeg })));
  }, 20);
  try {
    const value = await call('video_sample', { projectId, times: [0.5] });
    assertLossless('video_sample(panel)', value);
    assert(value.via === 'panel', 'via 应为 panel，实际 ' + value.via);
    assert(value.samples.length === 1 && value.samples[0].path.endsWith('.jpg'), '面板路径应回 JPEG');
  } finally {
    clearInterval(timer);
    // 清掉心跳，后续用例回到「面板没开」
    samples.lastPoll.clear();
    samples.lastAnyPollAt = 0;
  }
});

// ------------------------------------------------------------------- MAD ----
console.log('\n[mad]');
await step('MAD：同一实现两次渲染 → 0（确定性）', async () => {
  if (!headless.available) throw Object.assign(new Error('SKIP'), { skip: '本机没有浏览器' });
  const codeSources = { card: CARD_CODE };
  const a = await renderFramesHeadless({ root, doc: store.get(projectId).doc, times: [2], maxDim: 320, codeSources });
  const b = await renderFramesHeadless({ root, doc: store.get(projectId).doc, times: [2], maxDim: 320, codeSources });
  const mad = pngMad(await fs.readFile(a.frames[0].path), await fs.readFile(b.frames[0].path));
  console.log('    MAD(两次同实现) = ' + mad);
  assert(mad < 1e-9, '同一实现两次渲染应完全一致，MAD=' + mad);
});

await step('MAD：Chrome 与 Edge 两个内核同 t 的像素差 < 0.02', async () => {
  if (!headless.available) throw Object.assign(new Error('SKIP'), { skip: '本机没有浏览器' });
  if (!headless.backends.chrome || !headless.backends.edge) {
    throw Object.assign(new Error('SKIP'), { skip: '本机只有一种 Chromium（chrome=' + headless.backends.chrome + ', edge=' + headless.backends.edge + '），无法做跨内核对比' });
  }
  const chromePath = headless.paths.chrome;
  const edgePath = headless.paths.edge;
  const codeSources = { card: CARD_CODE };
  const a = await renderFramesHeadless({ root, doc: store.get(projectId).doc, times: [1.2], maxDim: 320, codeSources, browser: chromePath });
  const b = await renderFramesHeadless({ root, doc: store.get(projectId).doc, times: [1.2], maxDim: 320, codeSources, browser: edgePath });
  const mad = pngMad(await fs.readFile(a.frames[0].path), await fs.readFile(b.frames[0].path));
  console.log('    MAD(Chrome vs Edge) = ' + mad);
  assert(mad < 0.02, '跨内核 MAD 应 < 0.02，实际 ' + mad);
});

await step('MAD：面板编码（JPEG 0.82）与无头 PNG 的同帧差 < 0.02', async () => {
  if (!headless.available) throw Object.assign(new Error('SKIP'), { skip: '本机没有浏览器' });
  // 面板回 JPEG(0.82)、无头回 PNG，构图来自同一个 frame-render.js。
  // 这里让浏览器把同一张画布分别编码成 PNG 与 JPEG 再各自解码，量出编码差异的真实上界。
  const codeSources = { card: CARD_CODE };
  const rendered = await renderFramesHeadless({
    root,
    doc: store.get(projectId).doc,
    times: [1.2],
    maxDim: 480,
    codeSources,
    madProbe: true,
  });
  if (rendered.encodingMad == null) {
    throw Object.assign(new Error('SKIP'), { skip: '浏览器没有回传编码差测量值' });
  }
  console.log('    MAD(面板 JPEG 0.82 vs 无头 PNG) = ' + rendered.encodingMad);
  assert(rendered.encodingMad < 0.02, '编码差应 < 0.02，实际 ' + rendered.encodingMad);
});

// ------------------------------------------------------------------ strip ----
console.log('\n[strip]');
await step('strip：帧数 = 期望值，图宽 = tile × cellWidth（tile×tile 网格）', async () => {
  if (!headless.available) throw Object.assign(new Error('SKIP'), { skip: '本机没有浏览器' });
  const value = await call('video_strip', { projectId, start: 0, end: 3, fps: 1, tile: 2, cellWidth: 200, maxDim: 320 });
  assertLossless('video_strip', value);
  assert(value.frames === 4, `帧数应为 4，实际 ${value.frames}`);
  assert(value.times.length === 4, 'times 数量不对');
  assert(value.cols === 2 && value.rows === 2, `网格应为 2x2，实际 ${value.cols}x${value.rows}`);
  const decoded = decodePng(await fs.readFile(value.png));
  assert(decoded.width === 2 * 200, `图宽应为 400，实际 ${decoded.width}`);
  const cellH = Math.round((value.height / value.rows) * 1);
  assert(decoded.height === value.rows * cellH, '图高与行数不一致');
});

await step('strip：给了 layerId 时回报该图层的覆盖区间', async () => {
  if (!headless.available) throw Object.assign(new Error('SKIP'), { skip: '本机没有浏览器' });
  const value = await call('video_strip', { projectId, layerId: 'card', start: 0, end: 2, fps: 2, tile: 2, cellWidth: 160, maxDim: 240 });
  assert(value.layer && value.layer.layerId === 'card', '缺 layer 回报');
  assert(value.layer.clipId === codeWrite.clipId, 'layer.clipId 应对上 code_write 的 clipId');
  assert(value.layer.range.end === 8, 'layer.range 不对: ' + JSON.stringify(value.layer.range));
  try {
    await call('video_strip', { projectId, layerId: 'nope', start: 0, end: 1 });
    throw new Error('不存在的 layerId 应该报错');
  } catch (e) {
    assert(e.code === 'REF_NOT_FOUND', '错误码应为 REF_NOT_FOUND，实际 ' + e.code);
  }
});

await step('strip：fps 超限被夹紧，并在 clamped 里如实说明', async () => {
  const plan = normalizeStripArgs({ start: 0, end: 2, fps: 120, tile: 4 }, { duration: 10 });
  assert(plan.fps === 30, 'fps 应夹到 30，实际 ' + plan.fps);
  assert(plan.clamped.some((c) => c.field === 'fps'), 'clamped 里应有 fps');
  const grid = normalizeStripArgs({ start: 0, end: 10, fps: 30, tile: 2 }, { duration: 10 });
  assert(grid.frames <= 4, 'tile=2 时最多 4 帧，实际 ' + grid.frames);
  assert(grid.clamped.some((c) => c.field === 'frames'), '帧数超限应写进 clamped');
  const wide = normalizeStripArgs({ start: 0, end: 100, fps: 30, tile: 8 }, { duration: 100 });
  assert(wide.frames <= 60, '总帧数上限 60，实际 ' + wide.frames);
});

// ---------------------------------------------------------------- lossless --
console.log('\n[lossless]');

await step('probe：返回体 lossless（深扫干净 + JSON 往返深等）', async () => {
  const value = await call('video_probe', { projectId });
  assertLossless('video_probe', value);
});

await step('错误分支也 lossless：sample 越界 / strip 缺参 / strip 图层不存在', async () => {
  const cases = [
    ['video_sample(times 为空)', () => call('video_sample', { projectId, times: [] })],
    ['video_strip(缺少 end)', () => call('video_strip', { projectId, start: 0 })],
    ['video_strip(layerId 不存在)', () => call('video_strip', { projectId, layerId: 'no-such-layer', start: 0, end: 1 })],
    ['video_sample(工程不存在)', () => call('video_sample', { projectId: 'vp_missing', times: [0] })],
  ];
  for (const [label, run] of cases) {
    let error = null;
    try {
      await run();
    } catch (e) {
      error = e;
    }
    assert(error, label + ' 应当报错');
    assert(typeof error.code === 'string' && error.code, label + ' 缺 code');
    assertLossless(label, errorJson(error));
  }
});

await step('sample 落盘路径不会把 undefined 字段带出去（warnings 显式为 null）', async () => {
  if (!headless.available) throw Object.assign(new Error('SKIP'), { skip: '本机没有 Chromium 系浏览器' });
  const value = await call('video_sample', { projectId, times: [1.2], maxDim: 320 });
  assert(Object.prototype.hasOwnProperty.call(value, 'warnings'), 'warnings 键不该被 JSON.stringify 静默吞掉');
  assert(value.warnings === null || Array.isArray(value.warnings), 'warnings 只能是 null 或数组，实际 ' + JSON.stringify(value.warnings));
  assert(scanLossy(value).length === 0, '仍有无损问题：' + JSON.stringify(scanLossy(value)));
});

// ---------------------------------------------------------------- 音频 ------
console.log('\n[audio]');

/** 一份「时间线上有音频素材」的夹具：audio 在 v1（脏数据）或 a1，都该被合成跳过。 */
function audioDoc(extraClips, extraAssets) {
  return {
    projectId: 'vp_audio_fixture',
    revision: 1,
    fps: 30,
    duration: 6,
    tracks: [
      { id: 'v1', kind: 'video', name: '主轨' },
      { id: 'a1', kind: 'audio', name: '音频' },
      { id: 't1', kind: 'text', name: '字幕' },
    ],
    clips: extraClips || [],
    assets: extraAssets || [],
  };
}
const AUDIO_ASSET = { id: 'aud_fix', path: 'assets/click_001.ogg', name: 'click_001.ogg', mime: 'audio/mpeg', probe: { duration: 6 } };
const TEXT_CLIP = { id: 'c_text_audio_test', trackId: 't1', type: 'text', start: 0, duration: 6, text: '画面协整帧' };
const audioRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-hs-audio-'));

await step('含音频的时间线：合成帧与「无音频版」像素完全一致（MAD=0），且不是黑的', async () => {
  if (!headless.available) throw Object.assign(new Error('SKIP'), { skip: '本机没有 Chromium 系浏览器' });
  const withAudio = await renderFramesHeadless({
    root: audioRoot,
    doc: audioDoc(
      [TEXT_CLIP, { id: 'c_aud_dirty', trackId: 'v1', type: 'media', assetId: AUDIO_ASSET.id, start: 0, duration: 6 }],
      [AUDIO_ASSET],
    ),
    times: [1.5],
    maxDim: 320,
  });
  const withoutAudio = await renderFramesHeadless({
    root: audioRoot,
    doc: audioDoc([TEXT_CLIP], [AUDIO_ASSET]),
    times: [1.5],
    maxDim: 320,
  });
  const a = await fs.readFile(withAudio.frames[0].path);
  const b = await fs.readFile(withoutAudio.frames[0].path);
  const mad = pngMad(a, b);
  console.log('    MAD(含音频 vs 无音频) = ' + mad);
  assert(mad < 1e-9, '音频不该改变任何像素，MAD=' + mad);
  const mean = meanChannel(decodePng(a));
  assert(mean > 1, '合成帧不该是黑的（mean=' + mean + '）');
});

await step('诊断文字不进入合成帧：只有音频的时间线，无头 PNG 是纯黑（没有一个字）', async () => {
  if (!headless.available) throw Object.assign(new Error('SKIP'), { skip: '本机没有 Chromium 系浏览器' });
  const rendered = await renderFramesHeadless({
    root: audioRoot,
    doc: audioDoc([{ id: 'c_aud_only', trackId: 'v1', type: 'media', assetId: AUDIO_ASSET.id, start: 0, duration: 6 }], [AUDIO_ASSET]),
    times: [1],
    maxDim: 320,
  });
  const png = await fs.readFile(rendered.frames[0].path);
  const decoded = decodePng(png);
  const max = maxChannel(decoded);
  console.log('    纯音频时间线的 PNG 最大通道值 = ' + max);
  assert(max < 8, '画布里出现了非黑像素（诊断文字曾被画进合成帧）：max=' + max);
  assert(decoded.width === 320, '尺寸不对：' + decoded.width);
});

await fs.rm(audioRoot, { recursive: true, force: true }).catch(() => {});

// ---------------------------------------------------------------- setup ----
console.log('\n[setup]');
await step('setup 幂等：同目录第二次调用 reused=true、projectId 不变、工程数不增', async () => {
  const before = store.projects.size;
  const again = await call('video_setup', { dir: root });
  assert(again.reused === true, '第二次应 reused=true');
  assert(again.projectId === projectId, `projectId 应不变：${again.projectId} vs ${projectId}`);
  assert(again.root === root, 'root 不对');
  assert(store.projects.size === before, `工程数不应增加：${store.projects.size} vs ${before}`);
});

// ----------------------------------------------------------- export scan ----
console.log('\n[export]');
await step('export_scan：发现目录里的 mp4 并标 unmanaged', async () => {
  await fs.mkdir(path.join(root, 'exports'), { recursive: true });
  await fs.writeFile(path.join(root, 'exports', 'final.mp4'), Buffer.alloc(2048, 7));
  const value = await call('video_export_scan', { projectId });
  assert(value.unmanagedCount >= 1, '应至少发现 1 个未登记成片');
  const hit = value.unmanaged.find((f) => f.path === 'exports/final.mp4');
  assert(hit && hit.unmanaged === true, 'final.mp4 应标 unmanaged');
});

await step('export_adopt：登记进 exports[]，文件没被复制', async () => {
  const before = await fs.readdir(path.join(root, 'exports'));
  const value = await call('video_export_adopt', { projectId, path: 'exports/final.mp4' });
  assert(value.copied === false, 'copied 应为 false');
  assert(value.exports.some((e) => e.path === 'exports/final.mp4'), 'exports[] 里应有该文件');
  const after = await fs.readdir(path.join(root, 'exports'));
  assert(after.length === before.length, '文件数不应变化（不复制）');
  assert((await fs.stat(path.join(root, 'exports', 'final.mp4'))).size === 2048, '文件内容/大小变了');
  const rescan = await call('video_export_scan', { projectId });
  assert(!rescan.unmanaged.some((f) => f.path === 'exports/final.mp4'), '收养后不应再是 unmanaged');
});

await step('export_scan：拒绝收养工程外的文件', async () => {
  try {
    await call('video_export_adopt', { projectId, path: 'C:\\Windows\\notepad.exe' });
    throw new Error('应该被拒绝');
  } catch (e) {
    assert(e.code === 'OUTSIDE_PROJECT' || e.code === 'INVALID_ARG', '错误码应为 OUTSIDE_PROJECT，实际 ' + e.code);
  }
});

// ------------------------------------------------------------- 落点 & 冲突 ----
console.log('\n[contracts]');
await step('code_write 返回的 clipId 与 timeline_inspect 里的一致', async () => {
  assert(codeWrite.clipId && typeof codeWrite.clipId === 'string', 'code_write 必须返回真实 clipId');
  const timeline = await call('video_timeline_inspect', { projectId });
  assert(timeline.page.clips.some((c) => c.id === codeWrite.clipId), 'timeline 里找不到该 clipId');
  assert(codeWrite.projectId === projectId && codeWrite.root === root, 'code_write 缺 projectId/root');
});

await step('写类返回都带 projectId + root + revision', async () => {
  const p = await call('video_edit_preview', {
    projectId,
    summary: '探针',
    ops: [{ type: 'clip.set_text', clipId: 'c_text', text: '落点检查' }],
  });
  assert(p.projectId === projectId && p.root === root && typeof p.revision === 'number', 'preview 缺落点');
  const applied = await call('video_edit_apply', { previewId: p.previewId });
  assert(applied.projectId === projectId && applied.root === root, 'apply 缺落点');
});

await step('REVISION_CONFLICT 带 lastTransactionId / lastActor / hint', async () => {
  const stale = await call('video_edit_preview', {
    projectId,
    baseRevision: 0,
    summary: '用旧版本',
    ops: [{ type: 'clip.set_text', clipId: 'c_text', text: 'x' }],
  }).catch((e) => e);
  assert(stale && stale.code === 'REVISION_CONFLICT', '应抛 REVISION_CONFLICT，实际 ' + (stale && stale.code));
  const details = stale.details || {};
  assert(details.expected === 0, 'details.expected 应为 0');
  assert(typeof details.actual === 'number' && details.actual > 0, 'details.actual 缺失');
  assert(details.lastTransactionId, '缺 lastTransactionId');
  assert(details.lastActor, '缺 lastActor');
  assert(typeof details.hint === 'string' && details.hint.length > 10, '缺 hint');
});

await step('probe 的引擎版本来自 package.json', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert(engineVersion() === pkg.version, `引擎版本不一致：${engineVersion()} vs ${pkg.version}`);
});

// ---------------------------------------------------------------- 收尾 ----
// 夹具先 store.open 建过工程，所以第一次 video_setup 本来就该复用（不是新建）
if (setup) {
  assert(setup.reused === true, '已有 project.json 时首次 setup 也应 reused=true');
  assert(setup.projectId === projectId && setup.root === root, 'setup 的落点不对');
}
await fs.rm(root, { recursive: true, force: true }).catch(() => {});
cleanupBindings();

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
