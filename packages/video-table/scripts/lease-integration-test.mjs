/**
 * 写租约集成测试（真实 ProjectStore + 真实 src/lease.mjs）。
 *
 *   node scripts/lease-integration-test.mjs
 *
 * 覆盖的是「多 agent 并行写同一个工程」这条主链路，不 mock 判定：
 *   - 不同 scope 可并存；同 scope 冲突且列出冲突方
 *   - 同会话重复 acquire 幂等；all 与一切冲突
 *   - 过期后重新 acquire；assertLease 越界 → LEASE_SCOPE
 *   - 两个不同轨道各 applyPreview 一次都成功且 revision +2
 *   - 同轨道并发：一个成功、另一个在 acquire 就被 LEASE_CONFLICT 挡住
 *   - delete 后租约清空；不传 leaseId 的老路径仍可用
 */

import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.mjs';
import { registerVideoRoutes } from '../src/routes.mjs';

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('lease-integration');

const SESSION_A = 'session-lease-a';
const SESSION_B = 'session-lease-b';

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

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

async function mustThrow(fn, code, needle) {
  try {
    await fn();
  } catch (e) {
    assert(e.code === code, `期望 ${code}，实际 ${e.code}（${e.message}）`);
    if (needle) assert(String(e.message).includes(needle), `错误文案里没有「${needle}」：${e.message}`);
    return e;
  }
  throw new Error(`期望抛 ${code}，实际成功`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 和 route-test 一样的最小 RPC 壳：验证 lease.* 与 edit.preview 的 leaseId 透传。
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
    write(chunk) {
      this.body += chunk;
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
  const route = routes.find((r) => r.path === '/api/video/rpc');
  if (!route) throw new Error('RPC 路由没注册');
  const res = fakeRes();
  await route.handler(fakeReq('POST', '/api/video/rpc', { method, params }), res);
  const payload = JSON.parse(res.body);
  if (!payload.ok) throw Object.assign(new Error(payload.error.message), { code: payload.error.code });
  return payload.value;
}

const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-lease-a-'));
const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-lease-b-'));

const store = new ProjectStore();
let projectId = null;
let projectB = null;

let conflictMessage = '';

// 真实 store 建好之后再注册 RPC 路由（路由闭包会抓这个实例）。
registerVideoRoutes(ctx, store, () => {});

await step('准备：打开两个真实工程', async () => {
  const docA = await store.open(dirA, SESSION_A);
  projectId = docA.projectId;
  const docB = await store.open(dirB, SESSION_A);
  projectB = docB.projectId;
  assert(projectId && projectB, '工程没打开');
  assert(store.listLeases(projectId).length === 0, '新工程不该有租约');
});

let L1 = null;
await step('acquire track:v1 → 租约字段完整、remainingMs > 0', async () => {
  const got = store.acquireLease(projectId, SESSION_A, 'track:v1', { label: '主轨剪辑' });
  L1 = got.lease;
  assert(L1.leaseId && String(L1.leaseId).startsWith('lease_'), 'leaseId 形状不对');
  assert(L1.scope === 'track:v1', 'scope=' + L1.scope);
  assert(L1.sessionId === SESSION_A, 'sessionId 丢了');
  assert(L1.label === '主轨剪辑', 'label 丢了');
  assert(L1.expiresAt > Date.now(), 'expiresAt 应该在将来');
  assert(store.listLeases(projectId).length === 1, '租约列表应为 1');
});

await step('同 sessionId 重复 acquire 同 scope → 幂等（同 leaseId、列表不增）', async () => {
  const again = store.acquireLease(projectId, SESSION_A, 'track:v1');
  assert(again.lease.leaseId === L1.leaseId, '幂等失败：' + again.lease.leaseId);
  assert(store.listLeases(projectId).length === 1, '幂等却新增了租约');
});

let L2 = null;
await step('不同 scope 并行：再拿 track:v2 成功，两条租约并存', async () => {
  L2 = store.acquireLease(projectId, SESSION_A, 'track:v2').lease;
  assert(L2.leaseId !== L1.leaseId, 'leaseId 撞了');
  assert(store.listLeases(projectId).length === 2, '应有 2 条租约');
});

await step('同 scope 冲突（另一个会话）→ LEASE_CONFLICT，details.conflicts 列出冲突方', async () => {
  const e = await mustThrow(
    () => store.acquireLease(projectId, SESSION_B, 'track:v1'),
    'LEASE_CONFLICT',
    '写租约冲突',
  );
  conflictMessage = e.message;
  assert(Array.isArray(e.details.conflicts) && e.details.conflicts.length === 1, 'conflicts 应为 1 条');
  assert(e.details.conflicts[0].leaseId === L1.leaseId, '冲突方 leaseId 不对');
  assert(String(e.message).includes(L1.leaseId.slice(0, 6)) || String(e.message).includes('剩'), '文案里没有冲突方信息');
});

await step("acquire 'all' 与一切冲突（列出 2 个冲突方）", async () => {
  const e = await mustThrow(() => store.acquireLease(projectId, SESSION_B, 'all'), 'LEASE_CONFLICT');
  assert(e.details.conflicts.length === 2, 'all 应与两条租约都冲突，实际 ' + e.details.conflicts.length);
});

let Lcode = null;
let Laudio = null;
await step('code 与 audio 各自独占、且不与 track 冲突', async () => {
  Lcode = store.acquireLease(projectId, SESSION_A, 'code', { label: '代码图层' }).lease;
  Laudio = store.acquireLease(projectId, SESSION_A, 'audio', { label: '配音/音效' }).lease;
  assert(Lcode.scope === 'code' && Laudio.scope === 'audio', 'scope 不对');
  assert(store.listLeases(projectId).length === 4, '应有 4 条租约');
});

await step('assertLease：track:v1 租约覆盖 clip/track:v1', async () => {
  const lease = store.assertLease(projectId, L1.leaseId, { type: 'clip', trackId: 'v1' });
  assert(lease.leaseId === L1.leaseId, '返回的租约不对');
  store.assertLease(projectId, L1.leaseId, { type: 'track', trackId: 'v1' });
});

await step('assertLease 越界（track:v1 租约去写 v2）→ LEASE_SCOPE（code 透传）', async () => {
  await mustThrow(
    () => store.assertLease(projectId, L1.leaseId, { type: 'track', trackId: 'v2' }),
    'LEASE_SCOPE',
    '租约范围是 track:v1',
  );
});

await step('code 租约只覆盖 code，不覆盖整工程', async () => {
  store.assertLease(projectId, Lcode.leaseId, { type: 'code' });
  await mustThrow(
    () => store.assertLease(projectId, Lcode.leaseId, { type: 'project' }),
    'LEASE_SCOPE',
  );
});

let Lp2 = null;
await step('跨工程使用租约 → LEASE_PROJECT_MISMATCH', async () => {
  Lp2 = store.acquireLease(projectB, SESSION_A, 'all').lease;
  await mustThrow(
    () => store.assertLease(projectId, Lp2.leaseId, { type: 'code' }),
    'LEASE_PROJECT_MISMATCH',
    '租约不属于该工程',
  );
});

let L3 = null;
await step('过期租约：assertLease → LEASE_EXPIRED，listLeases 清掉它', async () => {
  L3 = store.acquireLease(projectId, SESSION_A, 'track:v3', { ttlMs: 20 }).lease;
  await sleep(60);
  await mustThrow(() => store.assertLease(projectId, L3.leaseId, { type: 'track', trackId: 'v3' }), 'LEASE_EXPIRED');
  const list = store.listLeases(projectId);
  assert(!list.some((l) => l.leaseId === L3.leaseId), '过期租约没被清掉');
  assert(list.length === 4, '清掉过期后应剩 4 条，实际 ' + list.length);
});

await step('过期后重新 acquire 同一 scope 成功（新 leaseId）', async () => {
  const fresh = store.acquireLease(projectId, SESSION_A, 'track:v3').lease;
  assert(fresh.leaseId !== L3.leaseId, '重新 acquire 应该拿到新租约');
  assert(store.listLeases(projectId).length === 5, '应为 5 条');
});

await step('touch 续租返回该租约；不存在的租约 touch 返回 null', async () => {
  const touched = store.touchLease(projectId, L1.leaseId);
  assert(touched && touched.leaseId === L1.leaseId, 'touch 没返回租约');
  assert(store.touchLease(projectId, 'lease_nope') === null, '不存在的租约应返回 null');
});

await step('release：第一次 true，第二次 false；释放后写入 → LEASE_NOT_FOUND', async () => {
  assert(store.releaseLease(projectId, L1.leaseId, SESSION_A).released === true, '第一次释放应为 true');
  assert(store.releaseLease(projectId, L1.leaseId, SESSION_A).released === false, '第二次释放应为 false');
  await mustThrow(
    () => store.assertLease(projectId, L1.leaseId, { type: 'clip', trackId: 'v1' }),
    'LEASE_NOT_FOUND',
    '租约不存在或已被释放',
  );
  // 别人的租约不能被别人释放
  assert(store.releaseLease(projectId, L2.leaseId, SESSION_B).released === false, '别人不该能释放');
  assert(store.listLeases(projectId).some((l) => l.leaseId === L2.leaseId), 'L2 被误删');
});

await step('preview 带错 scope 的 leaseId → LEASE_SCOPE', async () => {
  await mustThrow(
    () =>
      store.preview(
        projectId,
        undefined,
        undefined,
        [{ type: 'clip.insert', clipId: 'scope_bad', trackId: 'v1', clipType: 'text', start: 0, duration: 1, text: 'x' }],
        '越界预览',
        'agent',
        L2.leaseId,
      ),
    'LEASE_SCOPE',
  );
});

await step('不传 leaseId 的老路径仍可用（sessionId 校验）revision +1', async () => {
  const before = store.get(projectId).doc.revision;
  const p = store.preview(
    projectId,
    SESSION_A,
    before,
    [{ type: 'clip.insert', clipId: 'legacy_1', trackId: 't1', clipType: 'text', start: 0, duration: 1, text: '旧路径' }],
    '旧路径写入',
  );
  const applied = await store.applyPreview(p.previewId, SESSION_A);
  assert(applied.revision === before + 1, `revision 应为 ${before + 1}，实际 ${applied.revision}`);
});

await step('并发：两个不同轨道各 applyPreview 一次都成功，revision +2', async () => {
  // L2 = track:v2；重新拿一条 track:v1（L1 已释放）
  const lv1 = store.acquireLease(projectId, SESSION_A, 'track:v1', { label: '并行A' }).lease;
  const base = store.get(projectId).doc.revision;

  const task = async (lease, trackId, clipId, text) => {
    // 每个 agent 自己读当前 revision，然后 preview → apply（与真实调用顺序一致）
    const rev = store.get(projectId).doc.revision;
    const p = store.preview(
      projectId,
      undefined,
      rev,
      [{ type: 'clip.insert', clipId, trackId, clipType: 'text', start: 0, duration: 1.5, text }],
      '并行写 ' + trackId,
      'agent',
      lease.leaseId,
    );
    return store.applyPreview(p.previewId, undefined, lease.leaseId);
  };

  const [a, b] = await Promise.all([
    task(lv1, 'v1', 'parallel_v1', 'A 写主轨'),
    task(L2, 'v2', 'parallel_v2', 'B 写画中画'),
  ]);

  assert(a && b, '两个任务都应成功');
  const after = store.get(projectId).doc.revision;
  assert(after === base + 2, `revision 应 +2（${base} → ${base + 2}），实际 ${after}`);
  const doc = store.get(projectId).doc;
  assert(doc.clips.some((c) => c.id === 'parallel_v1'), 'v1 片段没落地');
  assert(doc.clips.some((c) => c.id === 'parallel_v2'), 'v2 片段没落地');
  console.log(
    `  · 并发结果：v1 ${a.transactionId} @ r${a.revision} / v2 ${b.transactionId} @ r${b.revision}（总 revision ${after}）`,
  );
});

await step('同轨道并发：一个成功，另一个在 acquire 就被 LEASE_CONFLICT 挡住', async () => {
  // 此刻 track:v1 仍被上面那条并行租约占用
  const e = await mustThrow(() => store.acquireLease(projectId, SESSION_B, 'track:v1'), 'LEASE_CONFLICT');
  assert(e.details.conflicts.length >= 1, '冲突方没列出');
  // 持租约的一方照常可以提交
  const lease = store.listLeases(projectId).find((l) => l.scope === 'track:v1');
  const rev = store.get(projectId).doc.revision;
  const p = store.preview(
    projectId,
    undefined,
    rev,
    [{ type: 'clip.trim', clipId: 'parallel_v1', start: 0.2 }],
    '同轨继续写',
    'agent',
    lease.leaseId,
  );
  const applied = await store.applyPreview(p.previewId, undefined, lease.leaseId);
  assert(applied.revision === rev + 1, '持租约方应能继续提交');
});

await step('delete 后租约清空（projectIdForLease 也为 null）', async () => {
  store.releaseLease(projectB, Lp2.leaseId, SESSION_A);
  const again = store.acquireLease(projectB, SESSION_A, 'all').lease;
  await store.delete(projectB, SESSION_A, false);
  assert(store.listLeases(projectB).length === 0, 'delete 后仍能列出租约');
  assert(store.projectIdForLease(again.leaseId) === null, 'delete 后 leaseId 仍指向旧工程');
});

await step('RPC lease.list / touch / acquire / release 全链路', async () => {
  const listed = await rpc('lease.list', { projectId });
  assert(listed.leases.length >= 3, 'RPC 列表条数不对：' + listed.leases.length);
  const one = listed.leases.find((l) => l.scope === 'track:v2');
  assert(one && one.remainingMs > 0 && typeof one.human === 'string', 'lease.list 字段不完整');
  const touched = await rpc('lease.touch', { projectId, leaseId: one.leaseId });
  assert(touched.lease && touched.lease.leaseId === one.leaseId, 'lease.touch 失败');

  const got = await rpc('lease.acquire', {
    projectId,
    sessionId: SESSION_A,
    scope: 'track:t1',
    label: 'RPC 字幕',
  });
  assert(got.lease.scope === 'track:t1' && got.conflicts.length === 0, 'lease.acquire 失败');
  const rel = await rpc('lease.release', { projectId, leaseId: got.lease.leaseId, sessionId: SESSION_A });
  assert(rel.released === true, 'lease.release 失败');
});

await step('RPC edit.preview + edit.apply 带 leaseId（跨会话写入）', async () => {
  const lease = store.acquireLease(projectId, SESSION_A, 'track:t1', { label: 'RPC 写入' }).lease;
  const rev = store.get(projectId).doc.revision;
  const p = await rpc('edit.preview', {
    projectId,
    sessionId: SESSION_B, // 故意用另一个会话：租约才是能力，sessionId 不参与
    leaseId: lease.leaseId,
    baseRevision: rev,
    ops: [{ type: 'clip.insert', clipId: 'rpc_lease_clip', trackId: 't1', clipType: 'text', start: 5, duration: 1, text: 'RPC' }],
  });
  assert(p.previewId, 'RPC 预览失败');
  const applied = await rpc('edit.apply', { previewId: p.previewId, leaseId: lease.leaseId });
  assert(applied.revision === rev + 1, 'RPC 应用后 revision 不对');

  // 错误 scope 走 HTTP 400 + LEASE_SCOPE
  const wrong = await rpc('edit.preview', {
    projectId,
    leaseId: Lcode.leaseId,
    ops: [{ type: 'clip.insert', clipId: 'rpc_bad', trackId: 'v1', clipType: 'text', start: 0, duration: 1, text: 'x' }],
  }).then(
    () => null,
    (e) => e,
  );
  assert(wrong && wrong.code === 'LEASE_SCOPE', 'RPC 错 scope 没被拒：' + (wrong && wrong.code));
});

await fs.rm(dirA, { recursive: true, force: true });
await fs.rm(dirB, { recursive: true, force: true });
cleanupBindings();

console.log('\n冲突文案原文：');
console.log('  ' + conflictMessage);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
