/**
 * 多步撤销栈测试（内存栈 + 三个 RPC）。
 *
 *   node scripts/undo-stack-test.mjs
 *
 * 覆盖：
 *  - 连续 3 步后逐次撤销（revision 回落、栈长度递减、summary 对得上）；
 *  - redo 恢复刚撤的那一步，再 undo 又回来（两个栈互相搬运）；
 *  - 空栈时撤销 / 重做的错误码；
 *  - 新操作提交后 redo 栈清空；
 *  - 上限 50 条截断（第 51 步挤掉最老的一步，撤销到不了截断点之前）；
 *  - 跨会话拒绝（undoLast / redoLast / listUndo 都走 assertSession）；
 *  - 老接口 edit.undo 仍可用，且能接上 redo；
 *  - 非栈顶事务不能按 id 撤销（REVISION_CONFLICT）；
 *  - RPC：edit.undoLast / edit.redo / edit.history 三个方法 + 错误码透传。
 */

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.mjs';
import { registerVideoRoutes } from '../src/routes.mjs';

let pass = 0;
let fail = 0;
async function step(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + (e && e.message));
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
async function expectError(fn, code, label) {
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert(err, (label || '') + ' 应当抛错');
  assert(err.code === code, (label || '') + ' code=' + err.code + '（期望 ' + code + '）');
  return err;
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-undo-'));
const BINDINGS = path.join(tmp, 'bindings.json');
process.env.DSH_VIDEO_BINDINGS = BINDINGS;

const SESSION = 'session-undo';
const OTHER = 'session-someone-else';

// 路线注册（给 RPC 那几个 step 用）
const routes = [];
const ctx = {
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
  get() {
    return undefined;
  },
};
const store = new ProjectStore();
registerVideoRoutes(ctx, store, () => {});
const rpcRoute = () => routes.find((r) => r.path === '/api/video/rpc');

function fakeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  setTimeout(() => {
    if (body) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  }, 0);
  return req;
}
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
    },
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers || {});
    },
  };
}
async function rpc(method, params) {
  const res = fakeRes();
  await rpcRoute().handler(fakeReq('POST', '/api/video/rpc', { method, params }), res);
  return { status: res.statusCode, payload: JSON.parse(res.body) };
}

/** 一次事务：插一条文字片段。start 用序号保证每步确实不同。 */
async function commit(projectId, sessionId, i, label) {
  const p = store.preview(
    projectId,
    sessionId,
    undefined,
    [
      {
        type: 'clip.insert',
        clipId: 'c' + i,
        trackId: 't1',
        clipType: 'text',
        start: i,
        duration: 1,
        text: label || 'step' + i,
      },
    ],
    label || '第 ' + i + ' 步',
  );
  return store.applyPreview(p.previewId, sessionId);
}

const root = path.join(tmp, 'proj');
await fs.mkdir(root, { recursive: true });
const doc = await store.open(root, SESSION);
const projectId = doc.projectId;

console.log('多步撤销栈');

await step('① 新工程：两个栈都是空的，revision=0', async () => {
  assert(doc.revision === 0, 'revision=' + doc.revision);
  assert(store.listUndo(projectId, SESSION).length === 0, 'undo 栈不是空');
  assert(store.listRedo(projectId, SESSION).length === 0, 'redo 栈不是空');
});

let tx1 = null;
let tx2 = null;
let tx3 = null;

await step('② 连续 3 步：每步 +1 revision，栈顶是最近一步', async () => {
  const a = await commit(projectId, SESSION, 0, '第一步');
  const b = await commit(projectId, SESSION, 1, '第二步');
  const c = await commit(projectId, SESSION, 2, '第三步');
  tx1 = a.transactionId;
  tx2 = b.transactionId;
  tx3 = c.transactionId;
  assert(c.revision === 3, 'revision=' + c.revision);
  const list = store.listUndo(projectId, SESSION);
  assert(list.length === 3, 'undo 长度=' + list.length);
  assert(list[0].transactionId === tx3, '栈顶不是第三步');
  assert(list[2].transactionId === tx1, '栈底不是第一步');
  assert(list[0].summary === '第三步', 'summary=' + list[0].summary);
  assert(Object.keys(list[0]).sort().join(',') === 'at,summary,transactionId', 'listUndo 字段=' + Object.keys(list[0]));
});

await step('③ 逐次撤销：r3 → r2 → r1，summary 逐条对上', async () => {
  const u1 = await store.undoLast(projectId, SESSION);
  assert(u1.revision === 2, 'rev=' + u1.revision);
  assert(u1.summary === '第三步', 'summary=' + u1.summary);
  const u2 = await store.undoLast(projectId, SESSION);
  assert(u2.revision === 1, 'rev=' + u2.revision);
  assert(u2.summary === '第二步', 'summary=' + u2.summary);
  const u3 = await store.undoLast(projectId, SESSION);
  assert(u3.revision === 0, 'rev=' + u3.revision);
  assert(u3.summary === '第一步', 'summary=' + u3.summary);
  const entry = store.get(projectId);
  assert(entry.doc.clips.length === 0, '撤销后片段数=' + entry.doc.clips.length);
  assert(store.listUndo(projectId, SESSION).length === 0, 'undo 栈没清空');
  assert(store.listRedo(projectId, SESSION).length === 3, 'redo 长度=' + store.listRedo(projectId, SESSION).length);
});

await step('④ 空栈时撤销报 REF_NOT_FOUND；重做仍可用', async () => {
  await expectError(() => store.undoLast(projectId, SESSION), 'REF_NOT_FOUND', '空栈撤销');
  const r = await store.redoLast(projectId, SESSION);
  assert(r.revision === 1, 'redo 后 rev=' + r.revision);
  const u = await store.undoLast(projectId, SESSION);
  assert(u.revision === 0, '再撤销 rev=' + u.revision);
});

await step('⑤ redo 恢复：r0 → r1 → r2 → r3，片段重新长回来', async () => {
  const r1 = await store.redoLast(projectId, SESSION);
  assert(r1.revision === 1, 'rev=' + r1.revision);
  assert(r1.summary === '第一步', 'summary=' + r1.summary);
  const r2 = await store.redoLast(projectId, SESSION);
  assert(r2.revision === 2, 'rev=' + r2.revision);
  const r3 = await store.redoLast(projectId, SESSION);
  assert(r3.revision === 3, 'rev=' + r3.revision);
  assert(store.get(projectId).doc.clips.length === 3, '重做后片段数=' + store.get(projectId).doc.clips.length);
  assert(store.listRedo(projectId, SESSION).length === 0, 'redo 栈没清空');
});

await step('⑥ 撤销后 revision 回落，重做后回到原值', async () => {
  const before = store.get(projectId).doc.revision;
  const u = await store.undoLast(projectId, SESSION);
  assert(u.revision === before - 1, '撤销没回落：' + before + ' → ' + u.revision);
  const r = await store.redoLast(projectId, SESSION);
  assert(r.revision === before, '重做没回到：' + r.revision + '（期望 ' + before + '）');
});

await step('⑦ 新操作提交后 redo 栈清空', async () => {
  await store.undoLast(projectId, SESSION);
  assert(store.listRedo(projectId, SESSION).length === 1, '撤销后 redo 应为 1');
  await commit(projectId, SESSION, 9, '新的一步');
  assert(store.listRedo(projectId, SESSION).length === 0, '新操作后 redo 没清空');
  await expectError(() => store.redoLast(projectId, SESSION), 'REF_NOT_FOUND', '清空后重做');
});

await step('⑧ 老接口 edit.undo 仍可用，且能接上 redo', async () => {
  const list = store.listUndo(projectId, SESSION);
  const top = list[0].transactionId;
  const before = store.get(projectId).doc.revision;
  const u = await store.undo(projectId, SESSION, top);
  assert(u.revision === before - 1, 'rev=' + u.revision + '（期望 ' + (before - 1) + '）');
  assert(store.listRedo(projectId, SESSION).length === 1, '老接口撤销后没进 redo');
  await store.redoLast(projectId, SESSION);
});

await step('⑨ 非栈顶事务不能按 id 撤销（REVISION_CONFLICT）', async () => {
  // 当前 1/2/3/9 四步都在栈里；tx1 不是栈顶
  await expectError(() => store.undo(projectId, SESSION, tx1), 'REVISION_CONFLICT', '非栈顶撤销');
});

await step('⑩ 跨会话拒绝：undoLast / redoLast / listUndo 都校验归属', async () => {
  await store.undoLast(projectId, SESSION); // 造一个 redo 出来
  await expectError(() => store.undoLast(projectId, OTHER), 'BOUND_TO_OTHER_SESSION', '异会话撤销');
  await expectError(() => store.redoLast(projectId, OTHER), 'BOUND_TO_OTHER_SESSION', '异会话重做');
  await expectError(() => store.listUndo(projectId, OTHER), 'BOUND_TO_OTHER_SESSION', '异会话列举');
  assert(store.listUndo(projectId, SESSION).length > 0, '本会话列举被误伤');
});

await step('⑪ history() 一次给全：revision / undo / redo / limit', async () => {
  const h = store.history(projectId, SESSION);
  assert(h.revision === store.get(projectId).doc.revision, 'revision=' + h.revision);
  assert(Array.isArray(h.undo) && Array.isArray(h.redo), 'undo/redo 不是数组');
  assert(h.limit === 50, 'limit=' + h.limit);
});

// --------------------------------------------------------------- 上限 50 ----

const rootCap = path.join(tmp, 'proj-cap');
await fs.mkdir(rootCap, { recursive: true });
const capDoc = await store.open(rootCap, SESSION);
const capId = capDoc.projectId;

await step('⑫ 上限 50：提交 55 步后栈只留 50 条', async () => {
  for (let i = 0; i < 55; i += 1) await commit(capId, SESSION, 100 + i, 'cap' + i);
  const list = store.listUndo(capId, SESSION);
  assert(list.length === 50, '栈长度=' + list.length);
  assert(list[0].summary === 'cap54', '栈顶=' + list[0].summary);
  assert(list[49].summary === 'cap5', '栈底=' + list[49].summary);
  assert(store.get(capId).doc.revision === 55, 'revision=' + store.get(capId).doc.revision);
});

await step('⑬ 截断后最多撤 50 步，第 51 次报 REF_NOT_FOUND', async () => {
  for (let i = 0; i < 50; i += 1) await store.undoLast(capId, SESSION);
  const entry = store.get(capId);
  assert(entry.doc.revision === 5, '撤到底后 revision=' + entry.doc.revision);
  await expectError(() => store.undoLast(capId, SESSION), 'REF_NOT_FOUND', '第 51 次撤销');
});

// ------------------------------------------------------------------- RPC ----

const rpcRoot = path.join(tmp, 'proj-rpc');
await fs.mkdir(rpcRoot, { recursive: true });
const rpcOpen = await rpc('project.open', { dir: rpcRoot, sessionId: SESSION });
const rpcId = rpcOpen.payload.value.doc.projectId;

async function rpcCommit(i, label) {
  const p = await rpc('edit.preview', {
    projectId: rpcId,
    sessionId: SESSION,
    ops: [
      { type: 'clip.insert', clipId: 'r' + i, trackId: 't1', clipType: 'text', start: i, duration: 1, text: label },
    ],
    summary: label,
  });
  return rpc('edit.apply', { previewId: p.payload.value.previewId, sessionId: SESSION });
}

await step('⑭ RPC edit.history 返回两个栈（新到旧）', async () => {
  await rpcCommit(0, 'RPC 一');
  await rpcCommit(1, 'RPC 二');
  const { status, payload } = await rpc('edit.history', { projectId: rpcId, sessionId: SESSION });
  assert(status === 200 && payload.ok === true, 'history 失败: ' + JSON.stringify(payload));
  assert(payload.value.undo.length === 2, 'undo=' + payload.value.undo.length);
  assert(payload.value.undo[0].summary === 'RPC 二', '栈顶=' + payload.value.undo[0].summary);
  assert(payload.value.redo.length === 0, 'redo 应为空');
});

await step('⑮ RPC edit.undoLast / edit.redo 往返', async () => {
  const u = await rpc('edit.undoLast', { projectId: rpcId, sessionId: SESSION });
  assert(u.payload.ok === true, 'undoLast 失败: ' + JSON.stringify(u.payload));
  assert(u.payload.value.revision === 1, 'rev=' + u.payload.value.revision);
  assert(u.payload.value.summary === 'RPC 二', 'summary=' + u.payload.value.summary);
  const r = await rpc('edit.redo', { projectId: rpcId, sessionId: SESSION });
  assert(r.payload.ok === true, 'redo 失败: ' + JSON.stringify(r.payload));
  assert(r.payload.value.revision === 2, 'rev=' + r.payload.value.revision);
});

await step('⑯ RPC 跨会话撤销 → HTTP 400 + BOUND_TO_OTHER_SESSION', async () => {
  const r = await rpc('edit.undoLast', { projectId: rpcId, sessionId: OTHER });
  assert(r.status === 400, 'status=' + r.status);
  assert(r.payload.ok === false, 'ok 不是 false');
  assert(r.payload.error.code === 'BOUND_TO_OTHER_SESSION', 'code=' + r.payload.error.code);
});

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
