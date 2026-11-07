/**
 * 标注持久化链路测试：从「点一下 ＋标注」到「时间线轨道上真的有胶囊」。
 *
 *   node scripts/annotation-persist-test.mjs
 *
 * 这个脚本是照着用户实测的那个 bug 写的：轨道头显示「标注轨 0 / 未处理 0」，
 * 空状态写着「还没有标注」，但磁盘上其实有数据。它逐层验证四件事：
 *
 *   1. annotationOp 的产出物能不能过 store.preview（ops 路径）；
 *   2. apply 之后 project.json 里到底有没有那条（range / intent / expected 原样）；
 *   3. 客户端 refresh 用的 project.timeline / project.open 返回的 doc，
 *      里不里带 annotations —— 这决定「没写进去」还是「写进去了没显示」；
 *   4. 两条入口（annotation.add ops 路径 / annotations.add RPC 路径）写入结构一致，
 *      失败路径都有可读错误，而且**不写盘**。
 *
 * 全部用真 store + 临时工程；不 mock 磁盘。
 */

import { useTempBindings } from './_bindings-guard.mjs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ProjectStore } from '../src/store.mjs';
import { registerVideoRoutes } from '../src/routes.mjs';
import { annotationOp, frameRange, spanRange, ANNOTATION_INTENTS } from '../src/annotations.mjs';
import { annotationCounts, annotationDataMissing, annotationTrackLayout } from '../src/client/timeline.js';

const cleanupBindings = useTempBindings('annotation-persist');

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
function eq(actual, expected, what) {
  assert(actual === expected, `${what}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- 夹具 ------

const routes = [];
const ctx = { webServer: { register: (r) => (routes.push(r), () => {}) }, get: () => undefined };
const store = new ProjectStore();
registerVideoRoutes(ctx, store, () => {});
const rpcRoute = routes.find((r) => r.path === '/api/video/rpc');

function fakeReq(body) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/api/video/rpc';
  req.headers = {};
  setTimeout(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  }, 0);
  return req;
}
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    write(c) { this.body += c; },
    end(c) { if (c) this.body += c; this.done = true; },
  };
}
/** 成功时返回 value；失败时抛带 code 的 Error（消息就是界面会看到的那句）。 */
async function call(method, params) {
  const res = fakeRes();
  await rpcRoute.handler(fakeReq({ method, params }), res);
  const payload = JSON.parse(res.body);
  if (!payload.ok) throw Object.assign(new Error(payload.error.message), { code: payload.error.code });
  return payload.value;
}

async function readDiskDoc(root) {
  const file = path.join(root, '.dsh-video', 'project.json');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function freshProject(tag) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `vw-annp-${tag}-`));
  const sessionId = `session-annp-${tag}`;
  const doc = await store.open(root, sessionId);
  return { root, sessionId, projectId: doc.projectId };
}

/** 走 ops 路径（面板 commitAnnotation → doOps → dispatch 的同一串）。 */
async function applyThroughOps(project, op) {
  const entry = store.get(project.projectId);
  const p = store.preview(project.projectId, project.sessionId, entry.doc.revision, [op], '新增标注', 'ui');
  const applied = await store.applyPreview(p.previewId, project.sessionId);
  return { preview: p, applied };
}

/** 走 RPC 路径（annotations.add）。 */
function addThroughRpc(project, params) {
  return call('annotations.add', {
    projectId: project.projectId,
    sessionId: project.sessionId,
    ...params,
  });
}

/** 模拟客户端 refresh：dispatch 成功之后 bridge.refresh() 打的正是这两个接口之一。 */
async function clientDocAfterRefresh(project) {
  const value = await call('project.timeline', { projectId: project.projectId });
  return value.doc;
}

/**
 * 模拟客户端从 state.doc 取标注：
 *   main.js 里两处都是 `annotations: doc.annotations || []`。
 */
function annotationsClientWouldShow(doc) {
  return (doc && doc.annotations) || [];
}

// ------------------------------------------------------------ 场景 A ------
// 面板那条路：annotationOp → preview → apply → 磁盘 → 客户端

const A = await freshProject('a');

await step('1. annotationOp 产出物能过 store.preview（不抛、有 previewId、diff 认得出这条）', async () => {
  const entry = store.get(A.projectId);
  const op = annotationOp({
    annotationId: 'an_ops_1',
    range: spanRange(2.5, 4),
    intent: 'change',
    expected: '这里换成空镜',
  });
  const p = store.preview(A.projectId, A.sessionId, entry.doc.revision, [op], '新增标注', 'ui');
  assert(p && typeof p.previewId === 'string' && p.previewId, 'preview 没有返回 previewId');
  const added = (p.diff && p.diff.added) || [];
  const hit = added.find((x) => x.kind === 'annotation' && x.id === 'an_ops_1');
  assert(hit, 'diff.added 里没有这条标注: ' + JSON.stringify(added));
  // preview 不落盘：磁盘上此刻还没有
  const disk = await readDiskDoc(A.root);
  eq((disk.annotations || []).length, 0, 'preview 阶段不应写盘（磁盘标注数）');
});

let opsApplied = null;
await step('2. apply 之后从磁盘读回，range / intent / expected 原样存在', async () => {
  const op = annotationOp({
    annotationId: 'an_ops_1',
    range: spanRange(2.5, 4),
    intent: 'change',
    expected: '这里换成空镜',
  });
  const { applied } = await applyThroughOps(A, op);
  opsApplied = applied;
  assert(applied && typeof applied.transactionId === 'string', 'apply 没返回 transactionId');
  const disk = await readDiskDoc(A.root);
  const saved = (disk.annotations || []).find((a) => a.id === 'an_ops_1');
  assert(saved, '磁盘上找不到 an_ops_1；annotations=' + JSON.stringify(disk.annotations));
  eq(saved.range.start, 2.5, '磁盘 range.start');
  eq(saved.range.end, 4, '磁盘 range.end');
  eq(saved.intent, 'change', '磁盘 intent');
  eq(saved.expected, '这里换成空镜', '磁盘 expected');
  eq(saved.status, 'open', '磁盘 status');
});

await step('3. annotations.list 加一条返回 1 条，再加一条返回 2 条', async () => {
  const one = await call('annotations.list', { projectId: A.projectId });
  eq((one.annotations || []).length, 1, '第一条之后 list 条数');

  const op2 = annotationOp({ annotationId: 'an_ops_2', range: frameRange(12.4), intent: 'question', expected: '这里是不是该切？' });
  await applyThroughOps(A, op2);

  const two = await call('annotations.list', { projectId: A.projectId });
  eq((two.annotations || []).length, 2, '第二条之后 list 条数');
});

await step('4. 客户端 refresh 拿到的 doc 里带 annotations，且与磁盘逐字段一致', async () => {
  const doc = await clientDocAfterRefresh(A);
  assert(doc, 'project.timeline 没返回 doc');
  const list = annotationsClientWouldShow(doc);
  eq(list.length, 2, '客户端 refresh 后能看到的标注数（doc.annotations）');
  const disk = await readDiskDoc(A.root);
  const ids = list.map((a) => a.id).sort();
  const diskIds = (disk.annotations || []).map((a) => a.id).sort();
  assert(JSON.stringify(ids) === JSON.stringify(diskIds), `客户端看到的 id=${JSON.stringify(ids)} 与磁盘 ${JSON.stringify(diskIds)} 不一致`);
  for (const a of list) {
    const d = disk.annotations.find((x) => x.id === a.id);
    assert(d, '磁盘上没有 ' + a.id);
    eq(JSON.stringify(a.range), JSON.stringify(d.range), a.id + ' range');
    eq(a.intent, d.intent, a.id + ' intent');
    eq(a.expected, d.expected, a.id + ' expected');
  }
});

await step('5. 时间线轨道头：counts.total=2 / open=2（轨道与右侧列表同源）', async () => {
  const doc = await clientDocAfterRefresh(A);
  const annotations = annotationsClientWouldShow(doc);
  const counts = annotationCounts(annotations);
  eq(counts.total, 2, '轨道头「标注轨 N」的 N');
  eq(counts.open, 2, '轨道头「未处理 N」的 N');
  const layout = annotationTrackLayout(annotations, { zoom: 70, duration: 20, playhead: 0, selectedId: null });
  eq(layout.items.filter((i) => i.placed !== false).length, 2, '能落在轨道上的胶囊数');
});

await step('6. refresh 的 doc 与 annotations.list 同源（客户端没有第二份快照）', async () => {
  const doc = await clientDocAfterRefresh(A);
  const listed = await call('annotations.list', { projectId: A.projectId });
  eq(
    JSON.stringify(annotationsClientWouldShow(doc).map((a) => a.id).sort()),
    JSON.stringify((listed.annotations || []).map((a) => a.id).sort()),
    'project.timeline 与 annotations.list 的 id 集合',
  );
});

await step('7. 新建的空工程第一次加标注不崩，且立刻能读到', async () => {
  const empty = await freshProject('empty');
  const op = annotationOp({ annotationId: 'an_empty_1', range: frameRange(0), intent: 'note', expected: '开场就这一帧' });
  const { applied } = await applyThroughOps(empty, op);
  assert(applied, '空工程 apply 失败');
  const doc = await clientDocAfterRefresh(empty);
  eq(annotationsClientWouldShow(doc).length, 1, '空工程加完后客户端看到的条数');
  const disk = await readDiskDoc(empty.root);
  eq((disk.annotations || []).length, 1, '空工程磁盘条数');
  await fs.rm(empty.root, { recursive: true, force: true });
});

await step('8. 零长度 range（标记当前帧）不会被过滤掉，start===end 原样保留', async () => {
  const p = await freshProject('frame');
  const op = annotationOp({ annotationId: 'an_frame', range: frameRange(3), intent: 'issue', expected: '这一帧有问题' });
  eq(op.range.start, 3, 'op.range.start');
  eq(op.range.end, 3, 'op.range.end');
  await applyThroughOps(p, op);
  const disk = await readDiskDoc(p.root);
  const saved = (disk.annotations || []).find((a) => a.id === 'an_frame');
  assert(saved, '零长度标注没落盘');
  eq(saved.range.start, 3, '磁盘零长度 start');
  eq(saved.range.end, 3, '磁盘零长度 end');
  const doc = await clientDocAfterRefresh(p);
  eq(annotationsClientWouldShow(doc).length, 1, '零长度标注在客户端仍可见');
  await fs.rm(p.root, { recursive: true, force: true });
});

// ------------------------------------------------------------ 场景 B ------
// RPC 那条路：annotations.add，必须和 ops 路径写入同样的结构

const B = await freshProject('b');

await step('9. annotations.add（RPC）加得进去，返回 annotationId 且落盘', async () => {
  const value = await addThroughRpc(B, {
    annotationId: 'an_rpc_1',
    range: { start: 1, end: 2 },
    intent: 'issue',
    expected: 'RPC 这条',
  });
  eq(value.annotationId, 'an_rpc_1', 'RPC 返回的 annotationId');
  assert(typeof value.revision === 'number', 'RPC 没返回 revision');
  const disk = await readDiskDoc(B.root);
  const saved = (disk.annotations || []).find((a) => a.id === 'an_rpc_1');
  assert(saved, 'RPC 加完磁盘上没有');
  eq(saved.intent, 'issue', 'RPC 写入 intent');
  eq(saved.expected, 'RPC 这条', 'RPC 写入 expected');
});

await step('10. 两条入口写入结构一致（字段集合 + 默认值）', async () => {
  const op = annotationOp({ annotationId: 'an_ops_b', range: spanRange(3, 5), intent: 'change', expected: 'ops 这条' });
  await applyThroughOps(B, op);
  const disk = await readDiskDoc(B.root);
  const viaOps = disk.annotations.find((a) => a.id === 'an_ops_b');
  const viaRpc = disk.annotations.find((a) => a.id === 'an_rpc_1');
  assert(viaOps && viaRpc, '两条入口没有都落盘');
  const keys = (o) => Object.keys(o).sort().join(',');
  eq(keys(viaOps), keys(viaRpc), '两条入口写入的字段集合');
  for (const k of ['status', 'author', 'outdated', 'target']) {
    eq(JSON.stringify(viaOps[k]), JSON.stringify(viaRpc[k]), '默认值 ' + k);
  }
  eq(viaOps.status, 'open', '默认 status');
  eq(viaOps.author, 'user', '默认 author');
});

await step('11. RPC 侧的区间也按同一套规则归一（负数钳 0、字符串数字可接受）', async () => {
  const value = await addThroughRpc(B, {
    annotationId: 'an_rpc_norm',
    range: { start: '-3', end: '0' },
    intent: 'note',
    expected: '区间归一',
  });
  assert(value, 'RPC 归一用例失败');
  const disk = await readDiskDoc(B.root);
  const saved = disk.annotations.find((a) => a.id === 'an_rpc_norm');
  assert(saved, '归一那条没落盘');
  eq(saved.range.start, 0, '负数钳到 0');
  eq(saved.range.end, 0, 'end 也在 0');
});

// ------------------------------------------------------------ 场景 C ------
// 失败路径：有可读错误，且不写盘

const C = await freshProject('fail');

/** 断言一次失败调用：抛了、code 对、消息非空，且磁盘与 revision 都没动。 */
async function expectFailure(fn, code, messageHint) {
  const before = await readDiskDoc(C.root);
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert(err, '本该失败，却成功了');
  eq(err.code, code, '错误码');
  assert(err.message && err.message.length > 4, '错误消息太短，界面会显示得很空: ' + JSON.stringify(err.message));
  if (messageHint) assert(messageHint.test(err.message), `错误消息不可读: ${err.message}`);
  const after = await readDiskDoc(C.root);
  eq((after.annotations || []).length, (before.annotations || []).length, '失败后磁盘标注数（不该写盘）');
  eq(after.revision, before.revision, '失败后磁盘 revision（不该写盘）');
  return err;
}

await step('12. 非法 intent：两条入口都拒，且都不写盘', async () => {
  // ops 路径：annotationOp 当场就拒
  let local = null;
  try {
    annotationOp({ annotationId: 'an_bad', range: frameRange(1), intent: 'nope', expected: 'x' });
  } catch (e) {
    local = e;
  }
  assert(local && local.code === 'INVALID_ARG', 'annotationOp 没有拒绝非法 intent');
  assert(/不支持的标注类型/.test(local.message), 'annotationOp 消息不可读: ' + local.message);

  await expectFailure(
    () => addThroughRpc(C, { annotationId: 'an_bad', range: { start: 1, end: 1 }, intent: 'nope', expected: 'x' }),
    'INVALID_ARG',
    /不支持的标注类型/,
  );
  const disk = await readDiskDoc(C.root);
  assert(!(disk.annotations || []).some((a) => a.id === 'an_bad'), '非法 intent 竟然写进了磁盘');
  eq(ANNOTATION_INTENTS.length, 4, 'intent 白名单长度');
});

await step('13. 缺 range：拒，且不写盘', async () => {
  await expectFailure(
    () => addThroughRpc(C, { annotationId: 'an_norange', intent: 'change', expected: '没有范围' }),
    'INVALID_ARG',
    /range|区间/,
  );
});

await step('14. range 倒挂（end < start）：拒，且不写盘', async () => {
  await expectFailure(
    () => addThroughRpc(C, { annotationId: 'an_inv', range: { start: 5, end: 2 }, intent: 'change', expected: '反了' }),
    'INVALID_ARG',
    /区间|start/,
  );
});

await step('15. target.clipId 指向不存在的片段：可读 REF_NOT_FOUND，且不写盘', async () => {
  await expectFailure(
    () =>
      addThroughRpc(C, {
        annotationId: 'an_ghostclip',
        range: { start: 1, end: 1 },
        intent: 'change',
        expected: '指着一个不存在的片段',
        target: { clipId: 'clip_does_not_exist' },
      }),
    'REF_NOT_FOUND',
    /片段|clip/i,
  );
  const disk = await readDiskDoc(C.root);
  assert(!(disk.annotations || []).some((a) => a.id === 'an_ghostclip'), '悬空 clipId 竟然写进了磁盘');
});

await step('16. target.clipId 存在时正常写入（上面的校验不能把合法的也拒了）', async () => {
  const project = C;
  const op = { type: 'clip.insert', clipId: 'clip_ok', trackId: 'v1', clipType: 'text', start: 0, duration: 2, text: 'x' };
  const entry = store.get(project.projectId);
  const p = store.preview(project.projectId, project.sessionId, entry.doc.revision, [op], '插入片段', 'ui');
  await store.applyPreview(p.previewId, project.sessionId);

  await addThroughRpc(project, {
    annotationId: 'an_withclip',
    range: { start: 0.5, end: 1.5 },
    intent: 'issue',
    expected: '这个片段要换',
    target: { clipId: 'clip_ok' },
  });
  const disk = await readDiskDoc(project.root);
  const saved = (disk.annotations || []).find((a) => a.id === 'an_withclip');
  assert(saved, '合法 clipId 的标注没落盘');
  eq(saved.target && saved.target.clipId, 'clip_ok', 'target.clipId 原样保存');
});

await step('17. 重复 annotationId：拒，且不写盘（不会悄悄改掉旧的那条）', async () => {
  await expectFailure(
    () => addThroughRpc(C, { annotationId: 'an_withclip', range: { start: 0, end: 0 }, intent: 'note', expected: '重复 id' }),
    'INVALID_ARG',
    /已存在/,
  );
});

// ------------------------------------------------------------ 场景 D ------
// 撤销 / 重做：标注也在同一条事务链上，不该被吞

const D = await freshProject('undo');

await step('18. apply 之后能撤销：undo 后 list 0，redo 后回到 1', async () => {
  const op = annotationOp({ annotationId: 'an_undo_1', range: frameRange(2), intent: 'change', expected: '撤销测试' });
  await applyThroughOps(D, op);
  eq((await call('annotations.list', { projectId: D.projectId })).annotations.length, 1, 'apply 后条数');

  const undid = await call('edit.undoLast', { projectId: D.projectId, sessionId: D.sessionId });
  assert(undid, 'undoLast 没返回');
  eq((await call('annotations.list', { projectId: D.projectId })).annotations.length, 0, 'undo 后条数');
  const diskAfterUndo = await readDiskDoc(D.root);
  eq((diskAfterUndo.annotations || []).length, 0, 'undo 后磁盘条数');

  await call('edit.redo', { projectId: D.projectId, sessionId: D.sessionId });
  eq((await call('annotations.list', { projectId: D.projectId })).annotations.length, 1, 'redo 后条数');
  const doc = await clientDocAfterRefresh(D);
  eq(annotationsClientWouldShow(doc).length, 1, 'redo 后客户端看到的条数');
  await fs.rm(D.root, { recursive: true, force: true });
});

await step('19. project.open / project.restore 返回的 doc 也带 annotations（首屏就画得出）', async () => {
  const value = await call('project.open', {
    dir: A.root,
    sessionId: A.sessionId,
  });
  const list = annotationsClientWouldShow(value.doc);
  eq(list.length, 2, 'project.open 的 doc.annotations 条数');
  const restored = await call('project.restore', { sessionId: A.sessionId });
  assert(restored && restored.doc, 'restore 没返回 doc');
  eq(annotationsClientWouldShow(restored.doc).length, 2, 'project.restore 的 doc.annotations 条数');
});

await step('20. project.summary 的 annotationCount / openAnnotations 与真实数据一致', async () => {
  const value = await call('project.summary', { projectId: A.projectId });
  eq(value.doc.annotationCount, 2, 'summary.annotationCount');
  eq(value.doc.openAnnotations, 2, 'summary.openAnnotations');
});

await step('21. 轨道报警器：工程里有标注、界面却一条没拿到时必须看得见', async () => {
  const doc = await clientDocAfterRefresh(A);
  eq(annotationDataMissing(doc, []), true, '丢掉 annotations 时应当报警');
  eq(annotationDataMissing(doc, annotationsClientWouldShow(doc)), false, '数据完整时不应报警');
  eq(annotationDataMissing({ annotationCount: 0 }, []), false, '空工程不该报警（否则又是另一种误报）');
  eq(annotationDataMissing(null, null), false, '没有 doc 也不崩');
});

await fs.rm(A.root, { recursive: true, force: true });
await fs.rm(B.root, { recursive: true, force: true });
await fs.rm(C.root, { recursive: true, force: true });
cleanupBindings();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
