/**
 * 备份 + 预览走备份（2026-11 定稿设计）。
 *
 * 设计：解析完成后只做两件事 ——
 *   1. 原片复制到 <工程>/reference/（防改坏的保险）；
 *   2. asset.previewPath 指向备份，预览解码读备份。
 * 原片继续留在时间线上，仍是编辑对象；不剥离片段、不建骨架、不改 status。
 *
 *   node scripts/reference-test.mjs
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.mjs';
import { backupOriginal, buildSkeletonOps, normalizeShots, applyReference } from '../src/reference.mjs';

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('reference');

let pass = 0;
let fail = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log('  ok   ' + name);
    pass += 1;
  } catch (e) {
    console.log('  FAIL ' + name + ' :: ' + e.message);
    fail += 1;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function throwsCodeAsync(promise, code, label) {
  try {
    await promise;
  } catch (e) {
    if (e && e.code === code) return e;
    throw new Error(label + '：期望 ' + code + '，实际 ' + ((e && (e.code || e.message)) || e));
  }
  throw new Error(label + '：应当抛 ' + code);
}

const SESSION = 'session-ref';
const ANALYSIS = {
  ok: true,
  meta: { duration: 6, width: 640, height: 360 },
  shots: [
    { index: 1, start: 0, end: 2, duration: 2 },
    { index: 2, start: 2, end: 4.5, duration: 2.5 },
    { index: 3, start: 4.5, end: 6, duration: 1.5 },
  ],
  stats: { shotCount: 3, avgShot: 2 },
};
const MEDIA_BYTES = Buffer.from('fake-mp4-payload-'.repeat(300));

async function makeProject(tag) {
  const store = new ProjectStore();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `vw-ref-${tag}-`));
  const doc = await store.open(root, SESSION);
  const projectId = doc.projectId;
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'assets', 'clip.mp4'), MEDIA_BYTES);
  const apply = async (ops, summary) => {
    const p = store.preview(projectId, SESSION, undefined, ops, summary);
    return store.applyPreview(p.previewId, SESSION);
  };
  await apply(
    [
      {
        type: 'asset.add',
        assetId: 'asset_main',
        relPath: 'assets/clip.mp4',
        name: 'clip.mp4',
        size: MEDIA_BYTES.length,
        mime: 'video/mp4',
      },
      { type: 'clip.insert', clipId: 'c1', trackId: 'v1', clipType: 'media', assetId: 'asset_main', start: 0, duration: 6 },
    ],
    '导入素材并上轨',
  );
  return { store, root, projectId, apply };
}

const p1 = await makeProject('a');
const assetAbs = path.join(p1.root, 'assets', 'clip.mp4');

await step('backupOriginal 首次复制到 reference/ 且字节一致', async () => {
  const got = await backupOriginal(p1.root, assetAbs, 'asset_main');
  assert(got.relPath === 'reference/asset_main.mp4', 'relPath=' + got.relPath);
  assert(got.reused === false, '首次不应是复用');
  const stat = await fs.stat(path.join(p1.root, got.relPath));
  assert(stat.size === MEDIA_BYTES.length, '备份大小=' + stat.size);
});

await step('backupOriginal 第二次复用，不再重复复制', async () => {
  const before = (await fs.stat(path.join(p1.root, 'reference', 'asset_main.mp4'))).mtimeMs;
  const got = await backupOriginal(p1.root, assetAbs, 'asset_main');
  assert(got.reused === true, '应是复用');
  const after = (await fs.stat(path.join(p1.root, 'reference', 'asset_main.mp4'))).mtimeMs;
  assert(before === after, '复用不应改动文件');
});

await step('assetId 带 .. 被拒（路径越界）', async () => {
  await throwsCodeAsync(backupOriginal(p1.root, assetAbs, '../escape'), 'INVALID_ARG', '越界 assetId');
});

await step('原片不存在时报 NOT_FOUND', async () => {
  await throwsCodeAsync(backupOriginal(p1.root, path.join(p1.root, 'assets', 'nope.mp4'), 'asset_x'), 'NOT_FOUND', '缺原片');
});

let applied = null;
await step('applyReference：只备份并把 previewPath 指向备份', async () => {
  const res = await applyReference(p1.store, SESSION, { projectId: p1.projectId, assetId: 'asset_main' });
  applied = res;
  assert(res.backedUpTo === 'reference/asset_main.mp4', 'backedUpTo=' + res.backedUpTo);
  const doc = p1.store.get(p1.projectId).doc;
  const asset = doc.assets.find((a) => a.id === 'asset_main');
  assert(asset.previewPath === 'reference/asset_main.mp4', 'previewPath=' + asset.previewPath);
});

await step('applyReference：原片仍在时间线，片段数不变', async () => {
  const doc = p1.store.get(p1.projectId).doc;
  assert(doc.clips.length === 1, '片段数=' + doc.clips.length);
  assert(doc.clips[0].id === 'c1' && doc.clips[0].assetId === 'asset_main', '片段被改了');
});

await step('applyReference：asset.path 与 status 都没被改', async () => {
  const doc = p1.store.get(p1.projectId).doc;
  const asset = doc.assets.find((a) => a.id === 'asset_main');
  assert(asset.path === 'assets/clip.mp4', 'path=' + asset.path);
  assert(asset.status == null, 'status=' + asset.status);
});

await step('applyReference 走一次事务，可撤销回 previewPath 之前', async () => {
  assert(applied && applied.transactionId, 'applyReference 没回 transactionId');
  const undone = await p1.store.undo(p1.projectId, SESSION, applied.transactionId);
  assert(undone, '撤销失败');
  const after = p1.store.get(p1.projectId).doc;
  const asset = after.assets.find((a) => a.id === 'asset_main');
  assert(asset.previewPath == null, '撤销后 previewPath 应清空，实际=' + asset.previewPath);
});

await step('setPreviewPath 越界被拒', async () => {
  let code = null;
  try {
    const p = p1.store.preview(p1.projectId, SESSION, undefined, [
      { type: 'asset.setPreviewPath', assetId: 'asset_main', previewPath: '../escape.mp4' },
    ], '越界');
    await p1.store.applyPreview(p.previewId, SESSION);
  } catch (e) {
    code = e && e.code;
  }
  assert(code === 'INVALID_ARG' || code === 'INVALID_OP', '越界 previewPath 未被拒，code=' + code);
});

await step('buildSkeletonOps 仍可用（留给按镜头表生成新工程）', async () => {
  const ops = buildSkeletonOps(ANALYSIS, { trackId: 'v1', assetId: 'asset_main' });
  assert(ops.length === 3, 'ops=' + ops.length);
  assert(ops.every((o) => o.type === 'clip.insert' && o.clipType === 'text'), '命令形状不对');
  assert(ops[0].start === 0 && Math.abs(ops[2].start + ops[2].duration - 6) < 1e-6, '首尾不对齐');
});

await step('normalizeShots 补缝与补尾', async () => {
  const shots = normalizeShots({
    meta: { duration: 6 },
    shots: [
      { index: 1, start: 0, end: 2, duration: 2 },
      { index: 2, start: 2.5, end: 5, duration: 2.5 },
    ],
  });
  assert(shots.length === 2, 'shots=' + shots.length);
  assert(shots[0].end === 2.5, '缝隙没补上: ' + shots[0].end);
  assert(shots[1].end === 6, '尾巴没补齐: ' + shots[1].end);
});

await step('素材不存在时报 REF_NOT_FOUND', async () => {
  await throwsCodeAsync(
    applyReference(p1.store, SESSION, { projectId: p1.projectId, assetId: 'nope' }),
    'REF_NOT_FOUND',
    '缺素材',
  );
});

console.log(`\n备份/参考测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
