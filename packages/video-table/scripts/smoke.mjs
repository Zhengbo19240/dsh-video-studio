/**
 * Domain smoke test: no DSH, no network. Proves the command engine, the
 * invariants, the diff and the store's transaction semantics before the plugin
 * is installed.
 *
 *   node scripts/smoke.mjs
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProject, applyOps, DomainError } from '../src/domain.mjs';
import { ProjectStore } from '../src/store.mjs';

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('smoke');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + (e && e.message));
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + (e && e.message));
  }
}

const SESSION = 'session-test';

function base() {
  const d = createProject({ title: 't', sessionId: SESSION, root: '/tmp/p' });
  d.assets.push({ id: 'a1' });
  return d;
}

console.log('domain');

check('createProject 有 5 条轨道（含画中画）与 revision 0', () => {
  const d = base();
  if (d.tracks.length !== 5) throw new Error('tracks=' + d.tracks.length);
  if (d.revision !== 0) throw new Error('revision=' + d.revision);
});

check('clip.insert 后 revision +1、时长重算', () => {
  const { doc } = applyOps(base(), [
    { type: 'clip.insert', clipId: 'c1', trackId: 'v1', clipType: 'media', assetId: 'a1', start: 0, duration: 4 },
  ]);
  if (doc.revision !== 1) throw new Error('revision=' + doc.revision);
  if (doc.duration !== 4) throw new Error('duration=' + doc.duration);
});

check('素材不存在时拒绝', () => {
  try {
    applyOps(base(), [{ type: 'clip.insert', clipId: 'c1', trackId: 'v1', clipType: 'media', assetId: 'nope', duration: 1 }]);
  } catch (e) {
    if (e.code !== 'REF_NOT_FOUND') throw new Error('code=' + e.code);
    return;
  }
  throw new Error('应当抛错');
});

check('同轨重叠被拒绝且原文档不变', () => {
  const d = base();
  const r = applyOps(d, [{ type: 'clip.insert', clipId: 'c1', trackId: 'v1', clipType: 'media', assetId: 'a1', start: 0, duration: 3 }]);
  const withOne = r.doc;
  try {
    applyOps(withOne, [{ type: 'clip.insert', clipId: 'c2', trackId: 'v1', clipType: 'media', assetId: 'a1', start: 2, duration: 3 }]);
  } catch (e) {
    if (e.code !== 'INVALID_OP') throw new Error('code=' + e.code);
    if (withOne.clips.length !== 1) throw new Error('原文档被改动');
    return;
  }
  throw new Error('应当抛错');
});

check('split 产生两段且源时间换算正确', () => {
  const { doc } = applyOps(base(), [
    { type: 'clip.insert', clipId: 'c1', trackId: 'v1', clipType: 'media', assetId: 'a1', start: 0, duration: 10, sourceIn: 100 },
  ]);
  const a = JSON.parse(JSON.stringify(doc));
  a.assets.push({ id: 'a1' });
  const { doc: after } = applyOps(a, [{ type: 'clip.split', clipId: 'c1', at: 4, rightClipId: 'c1b' }]);
  const left = after.clips.find((c) => c.id === 'c1');
  const right = after.clips.find((c) => c.id === 'c1b');
  if (left.duration !== 4) throw new Error('left=' + left.duration);
  if (right.start !== 4 || right.duration !== 6) throw new Error('right=' + right.start + '/' + right.duration);
  if (right.sourceIn !== 104) throw new Error('sourceIn=' + right.sourceIn);
});

check('未知命令给 INVALID_OP', () => {
  try {
    applyOps(base(), [{ type: 'nope' }]);
  } catch (e) {
    if (e.code !== 'INVALID_OP') throw new Error('code=' + e.code);
    return;
  }
  throw new Error('应当抛错');
});

check('标注 add 后 status=open，删除片段会把标注标记 outdated', () => {
  const d = base();
  d.assets.push({ id: 'a1' });
  const r1 = applyOps(d, [
    { type: 'clip.insert', clipId: 'c1', trackId: 'v1', clipType: 'media', assetId: 'a1', start: 0, duration: 5 },
  ]);
  const r2 = applyOps(r1.doc, [
    { type: 'annotation.add', annotationId: 'an1', range: { start: 1, end: 2 }, target: { clipId: 'c1' }, expected: '换音效' },
  ]);
  const an = r2.doc.annotations[0];
  if (an.status !== 'open') throw new Error('status=' + an.status);
  const r3 = applyOps(r2.doc, [{ type: 'clip.delete', clipId: 'c1' }]);
  if (r3.doc.annotations[0].outdated !== true) throw new Error('未标记 outdated');
});

check('diff 能说出加/删/改', () => {
  const d = base();
  const r = applyOps(d, [
    { type: 'clip.insert', clipId: 'c1', trackId: 'v1', clipType: 'text', start: 0, duration: 2, text: 'x' },
  ]);
  if (r.diff.added.length !== 1) throw new Error('added=' + r.diff.added.length);
  const r2 = applyOps(r.doc, [{ type: 'clip.trim', clipId: 'c1', duration: 3 }]);
  if (r2.diff.modified.length !== 1) throw new Error('modified=' + r2.diff.modified.length);
  const r3 = applyOps(r2.doc, [{ type: 'clip.delete', clipId: 'c1' }]);
  if (r3.diff.removed.length !== 1) throw new Error('removed=' + r3.diff.removed.length);
});

console.log('store');

async function freshRoot() { return fs.mkdtemp(path.join(os.tmpdir(), 'vw-smoke-')); }
let tmpRoot = await freshRoot();

await checkAsync('open 新目录会建 .dsh-video/project.json', async () => {
  const store = new ProjectStore();
  const doc = await store.open(tmpRoot, SESSION);
  if (doc.boundSessionId !== SESSION) throw new Error('未绑定');
  const file = path.join(tmpRoot, '.dsh-video', 'project.json');
  const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
  if (onDisk.projectId !== doc.projectId) throw new Error('落盘不一致');
});

tmpRoot = await freshRoot();
await checkAsync('preview 不改文档，apply 才改；apply 后 revision 前进', async () => {
  const store = new ProjectStore();
  const doc = await store.open(tmpRoot, SESSION);
  const before = doc.revision;
  const p = store.preview(doc.projectId, SESSION, doc.revision, [
    { type: 'clip.insert', clipId: 'c9', trackId: 't1', clipType: 'text', start: 0, duration: 2, text: 'hi' },
  ]);
  if (store.get(doc.projectId).doc.revision !== before) throw new Error('preview 误改文档');
  const applied = await store.applyPreview(p.previewId, SESSION);
  if (applied.revision !== before + 1) throw new Error('revision=' + applied.revision);
});

tmpRoot = await freshRoot();
await checkAsync('过期 baseRevision 被拒绝', async () => {
  const store = new ProjectStore();
  const doc = await store.open(tmpRoot, SESSION);
  try {
    store.preview(doc.projectId, SESSION, doc.revision - 1, [{ type: 'project.set_ratio', ratio: '9:16' }]);
  } catch (e) {
    if (e.code !== 'REVISION_CONFLICT') throw new Error('code=' + e.code);
    return;
  }
  throw new Error('应当抛错');
});

tmpRoot = await freshRoot();
await checkAsync('换会话打开同一工程被拒绝', async () => {
  const owner = new ProjectStore();
  await owner.open(tmpRoot, SESSION);
  const store = new ProjectStore();
  try {
    await store.open(tmpRoot, 'session-other');
  } catch (e) {
    if (e.code !== 'BOUND_TO_OTHER_SESSION') throw new Error('code=' + e.code);
    return;
  }
  throw new Error('应当抛错');
});

tmpRoot = await freshRoot();
await checkAsync('undo 能退回上一版；之后再有修改则拒绝单步回退', async () => {
  const store = new ProjectStore();
  const doc = await store.open(tmpRoot, SESSION);
  const p1 = store.preview(doc.projectId, SESSION, doc.revision, [
    { type: 'clip.insert', clipId: 'u1', trackId: 't1', clipType: 'text', start: 0, duration: 1, text: 'a' },
  ]);
  const t1 = await store.applyPreview(p1.previewId, SESSION);
  const p2 = store.preview(doc.projectId, SESSION, t1.revision, [
    { type: 'clip.insert', clipId: 'u2', trackId: 't1', clipType: 'text', start: 2, duration: 1, text: 'b' },
  ]);
  const t2 = await store.applyPreview(p2.previewId, SESSION);
  try {
    await store.undo(doc.projectId, SESSION, t1.transactionId);
    throw new Error('应当拒绝非最后一次事务的回退');
  } catch (e) {
    if (e.code !== 'REVISION_CONFLICT') throw e;
  }
  const back = await store.undo(doc.projectId, SESSION, t2.transactionId);
  if (back.revision !== t1.revision) throw new Error('回退版本不对');
});

await checkAsync('路径逃逸被拒绝', async () => {
  const store = new ProjectStore();
  try {
    store.assertInside(tmpRoot, path.join(tmpRoot, '..', 'evil.json'));
  } catch (e) {
    if (e.code !== 'OUTSIDE_PROJECT') throw new Error('code=' + e.code);
    return;
  }
  throw new Error('应当抛错');
});

await fs.rm(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
