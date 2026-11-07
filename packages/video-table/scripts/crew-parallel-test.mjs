/**
 * 小队并行证明（真实 ProjectStore + 真实磁盘文件，不 mock）。
 *
 *   node scripts/crew-parallel-test.mjs
 *
 * 它要证明的不是「函数能跑」，而是 docs/team-crew.md 里那套派活方式成立：
 *
 *   1. 父会话 acquire 两份范围不重叠的租约（track:v1 / track:t1），交给两个 teammate；
 *   2. 两个 teammate 同时 preview → applyPreview，各改自己轨道，两笔都成功；
 *   3. revision 递增两次，两处改动都落进磁盘上的 .dsh-video/project.json，基线不丢；
 *   4. 第三人抢已占用的轨道 → LEASE_CONFLICT，文案里能看出被谁占着；
 *   5. 双方不 release 时租约仍可见，remainingMs 随时间递减；
 *   6. 注入过期时间后，C 能接手，A 的后续提交被拒 LEASE_EXPIRED；
 *   7. 直接调 store 低层原语（store.preview）时仍是旧的 sessionId 路径 —— 脚本会提示这一点；
 *      工具与 RPC 已经全部走 ensureWriteAccess 自动领取（见 scripts/auto-lease-test.mjs）。
 *   8. 附加：租约范围不重叠，也不等于 revision 不打架（全局 revision 是单点）。
 *
 * 第 7 条是刻意保留的「低层原语现状证明」：它绿说明的是 store.preview 没有替调用方领租约，
 * 而不是「工具层还能静默绕过」。
 */

import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.mjs';
import { registerVideoRoutes } from '../src/routes.mjs';
import { useTempBindings } from './_bindings-guard.mjs';

const cleanupBindings = useTempBindings('crew-parallel');

// 这个脚本证明的是「opt-in 模式」下的行为：强制模式会挡掉旧路径，第 10 步就测不到现状。
const savedRequireLease = process.env.DSH_VIDEO_REQUIRE_LEASE;
delete process.env.DSH_VIDEO_REQUIRE_LEASE;
function restoreEnv() {
  if (savedRequireLease === undefined) delete process.env.DSH_VIDEO_REQUIRE_LEASE;
  else process.env.DSH_VIDEO_REQUIRE_LEASE = savedRequireLease;
}

const SESSION_PARENT = 'session-crew-parent'; // 主 agent：拆活 + 发租约
const AGENT_A = 'session-crew-a'; // 素材员：主轨 v1
const AGENT_B = 'session-crew-b'; // 排版员：字幕 t1
const AGENT_C = 'session-crew-c'; // 后来的第三人：想抢 v1

let pass = 0;
let fail = 0;
const failures = [];

async function step(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    const reason = (e && e.message) || String(e);
    failures.push({ name, reason });
    console.log('  FAIL ' + name + ' :: ' + reason);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败（没给原因）');
}

async function mustThrow(fn, code, needle) {
  try {
    await fn();
  } catch (e) {
    assert(e && e.code === code, `期望 ${code}，实际 ${e && e.code}（${e && e.message}）`);
    if (needle) assert(String(e.message).includes(needle), `错误文案里应含「${needle}」，实际：${e.message}`);
    return e;
  }
  throw new Error(`期望抛出 ${code}，实际成功了`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- RPC 壳 ----
// 用真实 routes 里的 /api/video/rpc，把父会话「发租约」这一步按文档里的 JSON 走一遍。
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
  if (!payload.ok) {
    const err = new Error(payload.error.message);
    err.code = payload.error.code;
    err.details = payload.error.details;
    throw err;
  }
  return payload.value;
}

// --------------------------------------------------------------- 准备工程 ----
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-crew-'));
const store = new ProjectStore();
let projectId = null;
let leaseA = null;
let leaseB = null;
let leaseC = null;
let baseRevision = 0;
const applied = {}; // { a, b }
let conflictMessage = '';

registerVideoRoutes(ctx, store, () => {});

console.log('小队并行证明：父会话发租约 / 两个 teammate 同时写不同轨道');
console.log('临时工程目录：' + root + '\n');

await step('准备：建真实工程，在 v1、t1 各铺一段基线片段', async () => {
  const doc = await store.open(root, SESSION_PARENT);
  projectId = doc.projectId;
  assert(projectId, '工程没有 projectId');
  const p = store.preview(
    projectId,
    SESSION_PARENT,
    undefined,
    [
      { type: 'asset.add', assetId: 'as_crew', relPath: 'assets/base.mp4', name: 'base.mp4', mime: 'video/mp4' },
      { type: 'clip.insert', clipId: 'v1_base', trackId: 'v1', clipType: 'media', assetId: 'as_crew', start: 0, duration: 4 },
      { type: 'clip.insert', clipId: 't1_base', trackId: 't1', clipType: 'text', start: 0, duration: 4, text: '基线字幕' },
    ],
    '铺基线：v1 视频 + t1 字幕',
  );
  const r = await store.applyPreview(p.previewId, SESSION_PARENT);
  assert(r.revision === 1, `铺完基线 revision 应为 1，实际 ${r.revision}`);
  const d = store.get(projectId).doc;
  const v1 = d.clips.find((c) => c.id === 'v1_base');
  const t1 = d.clips.find((c) => c.id === 't1_base');
  assert(v1 && v1.trackId === 'v1' && v1.type === 'media', 'v1 基线片段不在主轨上');
  assert(t1 && t1.trackId === 't1' && t1.type === 'text', 't1 基线片段不在字幕轨上');
  baseRevision = r.revision;
});

await step('父会话发租约：track:v1 给 A、track:t1 给 B（走真实 RPC，参数与文档一致）', async () => {
  const gotA = await rpc('lease.acquire', {
    projectId,
    sessionId: SESSION_PARENT,
    scope: 'track:v1',
    label: 'agentA / 主轨 v1',
  });
  const gotB = await rpc('lease.acquire', {
    projectId,
    sessionId: SESSION_PARENT,
    scope: 'track:t1',
    label: 'agentB / 字幕 t1',
  });
  leaseA = gotA.lease;
  leaseB = gotB.lease;
  assert(leaseA.scope === 'track:v1', 'A 的 scope 不对：' + leaseA.scope);
  assert(leaseB.scope === 'track:t1', 'B 的 scope 不对：' + leaseB.scope);
  assert(leaseA.leaseId !== leaseB.leaseId, '两份租约的 leaseId 撞了');
  assert(typeof leaseA.human === 'string' && leaseA.human.includes('track:v1'), 'lease.human 不可读：' + leaseA.human);
  assert(leaseA.remainingMs > 0 && leaseB.remainingMs > 0, 'remainingMs 应大于 0');
  console.log('  · 租约 A：' + leaseA.leaseId + ' ' + leaseA.human);
  console.log('  · 租约 B：' + leaseB.leaseId + ' ' + leaseB.human);
});

await step('交接必要性：teammate 用自己会话、不带 leaseId 写 → 被旧路径挡住', async () => {
  const e = await mustThrow(
    () =>
      store.preview(
        projectId,
        AGENT_A,
        undefined,
        [{ type: 'clip.trim', clipId: 'v1_base', start: 0.2 }],
        'A 不带租约',
      ),
    'BOUND_TO_OTHER_SESSION',
    '绑定在另一个会话上',
  );
  assert(e.code === 'BOUND_TO_OTHER_SESSION', '错误码应透传 BOUND_TO_OTHER_SESSION');
});

await step('并行：Promise.all 内 A 改 v1、B 改 t1，各自 preview → applyPreview 都成功', async () => {
  // 两个 teammate 各自「先读当前 revision，再 preview，再 apply」——这是规程里要求的写法。
  const task = async (agent, lease, ops, summary) => {
    const rev = store.get(projectId).doc.revision;
    const p = store.preview(projectId, agent, rev, ops, summary, 'agent', lease.leaseId);
    const r = await store.applyPreview(p.previewId, agent, lease.leaseId);
    return { ...r, fromRevision: rev };
  };

  const [a, b] = await Promise.all([
    task(
      AGENT_A,
      leaseA,
      [{ type: 'clip.trim', clipId: 'v1_base', start: 0.5, duration: 3.5 }],
      'A：主轨前移 0.5s',
    ),
    task(
      AGENT_B,
      leaseB,
      [{ type: 'clip.insert', clipId: 'b_t1_sub', trackId: 't1', clipType: 'text', start: 4, duration: 2, text: 'B 加的字幕' }],
      'B：字幕轨补一条',
    ),
  ]);

  assert(a && b, '并发两笔应都返回结果');
  applied.a = a;
  applied.b = b;
  const finalRev = store.get(projectId).doc.revision;
  assert(finalRev === baseRevision + 2, `revision 应递增两次（${baseRevision} → ${baseRevision + 2}），实际 ${finalRev}`);
  const revs = [a.revision, b.revision].sort((x, y) => x - y);
  assert(revs[0] === baseRevision + 1 && revs[1] === baseRevision + 2, `两笔提交的 revision 应为 +1/+2，实际 ${revs.join(' / ')}`);
  console.log(
    `  · A ${a.transactionId} @ r${a.revision} → track:v1 / B ${b.transactionId} @ r${b.revision} → track:t1（总 revision ${finalRev}）`,
  );
});

await step('落盘：两处改动都在磁盘 project.json 里，且没有数据丢失', async () => {
  const file = path.join(root, '.dsh-video', 'project.json');
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert(disk.revision === baseRevision + 2, `磁盘 revision 应为 ${baseRevision + 2}，实际 ${disk.revision}`);
  const v1 = disk.clips.find((c) => c.id === 'v1_base');
  assert(v1, '磁盘上没有 v1_base（基线丢了）');
  assert(Math.abs(v1.start - 0.5) < 1e-6 && Math.abs(v1.duration - 3.5) < 1e-6, `A 的 trim 没落盘：start=${v1.start} duration=${v1.duration}`);
  const sub = disk.clips.find((c) => c.id === 'b_t1_sub');
  assert(sub && sub.trackId === 't1' && sub.text === 'B 加的字幕', 'B 的字幕片段没落盘');
  assert(disk.clips.find((c) => c.id === 't1_base'), 't1 基线字幕丢了（数据丢失）');
  assert(disk.clips.length === 3, `磁盘上应有 3 个片段（2 基线 + 1 新），实际 ${disk.clips.length}`);
  assert(disk.assets.some((x) => x.id === 'as_crew'), '素材登记丢了');
});

await step('内存视图与磁盘一致（没有分叉）', async () => {
  const file = path.join(root, '.dsh-video', 'project.json');
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  const mem = store.get(projectId).doc;
  assert(mem.revision === disk.revision, `内存 r${mem.revision} ≠ 磁盘 r${disk.revision}`);
  const ids = (d) =>
    d.clips
      .map((c) => c.id)
      .sort()
      .join(',');
  assert(ids(mem) === ids(disk), `片段集合不一致：内存 ${ids(mem)} / 磁盘 ${ids(disk)}`);
});

await step('第三人抢 track:v1 → LEASE_CONFLICT，文案里能看出被谁占着', async () => {
  const e = await mustThrow(() => store.acquireLease(projectId, AGENT_C, 'track:v1'), 'LEASE_CONFLICT', '写租约冲突');
  conflictMessage = e.message;
  assert(Array.isArray(e.details && e.details.conflicts) && e.details.conflicts.length === 1, 'details.conflicts 应列出 1 个冲突方');
  const c = e.details.conflicts[0];
  assert(c.leaseId === leaseA.leaseId, '冲突方 leaseId 不是 A 的');
  assert(c.scope === 'track:v1', '冲突方 scope 不对：' + c.scope);
  assert(String(e.message).includes('agentA'), '冲突文案里看不出是 agentA 占着：' + e.message);
  assert(String(e.message).includes(leaseA.leaseId), '冲突文案里没有 A 的租约 id：' + e.message);
});

await step('不 release：listLeases 仍看到两条，remainingMs 随时间递减', async () => {
  const first = await rpc('lease.list', { projectId });
  assert(first.leases.length === 2, `A/B 都没 release，应看到 2 条租约，实际 ${first.leases.length}`);
  const a1 = first.leases.find((l) => l.leaseId === leaseA.leaseId);
  const b1 = first.leases.find((l) => l.leaseId === leaseB.leaseId);
  assert(a1 && b1, '列表里少了 A 或 B 的租约');
  assert(a1.remainingMs > 0, 'A 的 remainingMs 应大于 0');
  await sleep(160);
  const second = await rpc('lease.list', { projectId });
  const a2 = second.leases.find((l) => l.leaseId === leaseA.leaseId);
  const b2 = second.leases.find((l) => l.leaseId === leaseB.leaseId);
  assert(a2 && b2, '第二次列表里少了租约（不该被清掉）');
  assert(a2.remainingMs < a1.remainingMs, `A 的 remainingMs 没有递减：${a1.remainingMs} → ${a2.remainingMs}`);
  assert(b2.remainingMs < b1.remainingMs, `B 的 remainingMs 没有递减：${b1.remainingMs} → ${b2.remainingMs}`);
  console.log(`  · remainingMs A ${a1.remainingMs} → ${a2.remainingMs} / B ${b1.remainingMs} → ${b2.remainingMs}`);
});

await step('过期（注入时间）：A 的后续 apply 被拒 LEASE_EXPIRED，C 随后能接手 v1', async () => {
  const rev = store.get(projectId).doc.revision;
  const pending = store.preview(
    projectId,
    AGENT_A,
    rev,
    [{ type: 'clip.trim', clipId: 'v1_base', start: 1.0 }],
    'A 的第二笔（将过期）',
    'agent',
    leaseA.leaseId,
  );

  // 纯注入：不动任何状态，只把「现在」拨到租约到期之后，让服务端时钟判定过期。
  await mustThrow(
    () => store.assertLease(projectId, leaseA.leaseId, { type: 'track', trackId: 'v1' }, Date.now() + 11 * 60 * 1000),
    'LEASE_EXPIRED',
    '租约已过期',
  );

  // acquireLease 没有 now 参数，这里把 A 的租约记录到期时间直接拨到过去（注入时间）。
  const records = store.leases.get(String(projectId)) || [];
  const rec = records.find((l) => l && l.leaseId === leaseA.leaseId);
  assert(rec, '找不到 A 的租约记录，无法注入过期时间');
  rec.expiresAt = Date.now() - 1;

  await mustThrow(() => store.applyPreview(pending.previewId, AGENT_A, leaseA.leaseId), 'LEASE_EXPIRED', '租约已过期');

  const got = store.acquireLease(projectId, AGENT_C, 'track:v1', { label: 'agentC / 接手主轨' });
  leaseC = got.lease;
  assert(leaseC.scope === 'track:v1', 'C 拿到的 scope 不对：' + leaseC.scope);
  assert(leaseC.leaseId !== leaseA.leaseId, 'C 拿到的应是新租约');
  assert(!store.listLeases(projectId).some((l) => l.leaseId === leaseA.leaseId), 'A 的过期租约没被清掉');
  const view = (await rpc('lease.list', { projectId })).leases.find((l) => l.leaseId === leaseC.leaseId);
  assert(view && view.remainingMs > 0, 'C 的新租约没有 remainingMs');
  console.log('  · 过期后 C 拿到：' + leaseC.leaseId + '（' + view.human + '）');

  // 被清掉之后再写，错误码从「过期」变成「不存在」——两者要分清。
  await mustThrow(() => store.applyPreview(pending.previewId, AGENT_A, leaseA.leaseId), 'LEASE_NOT_FOUND', '租约不存在');
});

await step('重试策略：同一会话重复 acquire 同 scope 是幂等的（不新增、不续期）', async () => {
  const before = store.listLeases(projectId).length;
  const again = store.acquireLease(projectId, AGENT_C, 'track:v1');
  assert(again.lease.leaseId === leaseC.leaseId, `重复 acquire 应返回同一租约，实际 ${again.lease.leaseId}`);
  assert(store.listLeases(projectId).length === before, `重复 acquire 不该新增租约（${before} → ${store.listLeases(projectId).length}）`);
});

await step('范围边界：拿 track:v1 的租约去写 t1 → LEASE_SCOPE（teammate 不能越界）', async () => {
  const e = await mustThrow(
    () =>
      store.preview(
        projectId,
        AGENT_C,
        undefined,
        [{ type: 'clip.insert', clipId: 'c_cross', trackId: 't1', clipType: 'text', start: 8, duration: 1, text: '越界' }],
        'C 越界写 t1',
        'agent',
        leaseC.leaseId,
      ),
    'LEASE_SCOPE',
    '租约范围是 track:v1',
  );
  assert(e.details && e.details.target === 'track:t1', 'details.target 应显示本次目标 track:t1');
});

await step('旧路径（store 低层原语）：不带 leaseId、只用绑定会话仍能写', async () => {
  const before = store.get(projectId).doc.revision;
  const p = store.preview(
    projectId,
    SESSION_PARENT,
    before,
    [{ type: 'clip.insert', clipId: 'legacy_v2', trackId: 'v2', clipType: 'text', start: 0, duration: 1, text: '没带租约' }],
    '老路径写入',
  );
  const r = await store.applyPreview(p.previewId, SESSION_PARENT);
  assert(r.revision === before + 1, `老路径写入后 revision 应为 ${before + 1}，实际 ${r.revision}`);
  console.log('');
  console.log('  ⚠ 注意：上面这一步直接调的是 store.preview（低层原语），所以没带 leaseId 也能写。');
  console.log('  ⚠ 工具与 RPC 已经全部走 ensureWriteAccess，会自动领租约（见 auto-lease-test.mjs）；');
  console.log('  ⚠ 只有绕过工具层、直接调 store 的代码才会退化成老的 sessionId 行为。');
  console.log('');
});

await step('附加：租约范围不重叠，也不等于 revision 不打架（全局 revision 是单点）', async () => {
  // C 持 track:v1，父会话再拿 code；两者不冲突，但两笔提交仍共享同一个 revision 刻度。
  const codeLease = store.acquireLease(projectId, SESSION_PARENT, 'code', { label: '合成员 / 代码图层' }).lease;
  const rev = store.get(projectId).doc.revision;
  const p1 = store.preview(
    projectId,
    AGENT_C,
    rev,
    [{ type: 'clip.insert', clipId: 'serial_v1', trackId: 'v1', clipType: 'text', start: 5, duration: 1, text: '串行证词' }],
    'C 写 v1',
    'agent',
    leaseC.leaseId,
  );
  const p2 = store.preview(
    projectId,
    SESSION_PARENT,
    rev,
    [{ type: 'clip.insert', clipId: 'serial_c1', trackId: 'c1', clipType: 'code', start: 0, duration: 1, layerId: 'serial_layer' }],
    '父会话写 code',
    'agent',
    codeLease.leaseId,
  );
  const r1 = await store.applyPreview(p1.previewId, AGENT_C, leaseC.leaseId);
  assert(r1.revision === rev + 1, '第一笔提交应成功');
  await mustThrow(
    () => store.applyPreview(p2.previewId, SESSION_PARENT, codeLease.leaseId),
    'REVISION_CONFLICT',
    '预览基于旧版本',
  );
  console.log('  · 证据：两笔基于同一 baseRevision 的提交，第二笔被 REVISION_CONFLICT 挡住（范围不重叠也一样）');
  leaseC.__codeLease = codeLease; // 收尾时释放
});

await step('收尾：租约只能持有会话收回；全部释放后列表归零', async () => {
  assert(store.releaseLease(projectId, leaseC.leaseId, SESSION_PARENT).released === false, '父会话不该能收回 C 的租约');
  assert(store.releaseLease(projectId, leaseB.leaseId, SESSION_PARENT).released === true, '父会话应能收回自己发的 B 租约');
  assert(store.releaseLease(projectId, leaseC.__codeLease.leaseId, SESSION_PARENT).released === true, '父会话应能收回 code 租约');
  assert(store.releaseLease(projectId, leaseC.leaseId, AGENT_C).released === true, 'C 应能收回自己的租约');
  assert(store.listLeases(projectId).length === 0, '全部释放后租约列表应为空，实际 ' + store.listLeases(projectId).length);
});

await fs.rm(root, { recursive: true, force: true });
cleanupBindings();
restoreEnv();

console.log('\n冲突文案原文：');
console.log('  ' + conflictMessage);
console.log('\n提醒：opt-in 模式下，忘了传 leaseId 的写不会报错，只会悄悄绕过租约。');
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('失败明细：');
  for (const f of failures) console.log('  - ' + f.name + ' :: ' + f.reason);
}
process.exit(fail === 0 ? 0 : 1);
