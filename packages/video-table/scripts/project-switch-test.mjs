/**
 * 工程改名 / 换绑的断言（store.rename、store.rebind）与 RPC 接线。
 *
 *   node scripts/project-switch-test.mjs
 *
 * 不可违背的前提在这里被逐条钉住：
 *  - 绑定表仍是「一个会话 ↔ 一个工程」（`{ sessionId: projectId }` 的语义），不是数组；
 *  - assertSession 仍然拦跨会话访问；
 *  - rebind 在额度满时整体失败，绑定一个字节都不改。
 */

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-switch-'));
const BINDINGS = path.join(tmp, 'bindings.json');
const REGISTRY = path.join(tmp, 'video-enabled.json');
process.env.DSH_VIDEO_BINDINGS = BINDINGS;
process.env.DSH_VIDEO_ENABLED = REGISTRY;

const { ProjectStore } = await import('../src/store.mjs');
const { registerVideoRoutes } = await import('../src/routes.mjs');
const registry = await import('../src/enabled-registry.mjs');

let pass = 0;
let fail = 0;
async function step(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + e.message);
  }
}

async function resetRegistry() {
  await fs.rm(REGISTRY, { force: true });
  await fs.rm(REGISTRY + '.bak', { force: true });
}
async function resetBindings() {
  await fs.rm(BINDINGS, { force: true });
}

const S = 'session-switch-abc';
const rootA = await fs.mkdtemp(path.join(tmp, 'projA-'));
const rootB = await fs.mkdtemp(path.join(tmp, 'projB-'));

// 同一个会话在一次进程里打开两个目录 —— 这就是「切换」能列出来的东西
const store = new ProjectStore();
const docA = await store.open(rootA, S);
const docB = await store.open(rootB, S);
if (docA.projectId === docB.projectId) throw new Error('测试装置坏了：两个工程同一个 id');

// ---------------------------------------------------------------- rename ----

await step('rename 落盘并反映到 summarize（project.json 里也是新名字）', async () => {
  const summary = await store.rename(docA.projectId, S, '改名后的工程');
  if (summary.title !== '改名后的工程') throw new Error('summary.title=' + summary.title);
  if (summary.root !== path.resolve(rootA)) throw new Error('summary 缺 root: ' + summary.root);
  const file = path.join(rootA, '.dsh-video', 'project.json');
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  if (disk.title !== '改名后的工程') throw new Error('磁盘上还是: ' + disk.title);
  if (disk.revision !== summary.revision) throw new Error('改名不该推进 revision');
});

await step('rename 拒绝空标题与纯空格', async () => {
  for (const bad of ['', '   ', null, undefined]) {
    try {
      await store.rename(docA.projectId, S, bad);
      throw new Error('应当拒绝: ' + JSON.stringify(bad));
    } catch (e) {
      if (e.code !== 'INVALID_ARG') throw e;
    }
  }
});

await step('rename 长度上限 60（60 通过、61 拒绝）', async () => {
  const sixty = '字'.repeat(60);
  const ok = await store.rename(docA.projectId, S, sixty);
  if (ok.title !== sixty) throw new Error('60 字被拒了');
  try {
    await store.rename(docA.projectId, S, '字'.repeat(61));
    throw new Error('61 字应当被拒');
  } catch (e) {
    if (e.code !== 'INVALID_ARG') throw e;
  }
  const disk = JSON.parse(await fs.readFile(path.join(rootA, '.dsh-video', 'project.json'), 'utf8'));
  if (disk.title !== sixty) throw new Error('超长标题落盘了');
});

await step('rename 跨会话被拒（BOUND_TO_OTHER_SESSION）', async () => {
  try {
    await store.rename(docA.projectId, 'someone-else', '偷改');
    throw new Error('应当被拒');
  } catch (e) {
    if (e.code !== 'BOUND_TO_OTHER_SESSION') throw e;
  }
});

// ---------------------------------------------------------------- rebind ----

await step('rebind 成功换绑：绑定表指向新工程，旧工程不再占额度', async () => {
  await resetRegistry();
  // 先把会话切到 A 并让它处于启用状态 —— 模拟「正在用 A」
  await store.rebind(S, docA.projectId);
  const before = (await registry.listEnabled()).map((x) => x.projectId);
  if (!before.includes(docA.projectId) || before.length !== 1) throw new Error('测试装置坏了：A 没启用');

  const result = await store.rebind(S, docB.projectId);
  if (result.previous !== docA.projectId) throw new Error('previous=' + result.previous);
  if (result.doc.projectId !== docB.projectId) throw new Error('没返回新工程摘要');

  const map = JSON.parse(await fs.readFile(BINDINGS, 'utf8'));
  if (map[S].projectId !== docB.projectId) throw new Error('绑定表没换: ' + JSON.stringify(map[S]));
  const ids = (await registry.listEnabled()).map((x) => x.projectId);
  if (ids.includes(docA.projectId)) throw new Error('旧工程还在 enabled 里');
  if (!ids.includes(docB.projectId)) throw new Error('新工程没被启用');
});

await step('rebind 到自己的新工程时，新工程已在 enabled 里就不再重复加', async () => {
  const before = (await registry.listEnabled()).length;
  await store.rebind(S, docB.projectId); // 同一个目标，幂等
  const after = (await registry.listEnabled()).length;
  if (after !== before) throw new Error('重复加了一条');
});

await step('rebind 在额度满时失败，绑定不变', async () => {
  await resetRegistry();
  // 绑定指回 A，然后把 A 停用 —— 这样「旧绑定」不占额度，失败场景才干净
  await store.rebind(S, docA.projectId);
  await registry.disable(docA.projectId);
  // 两个别人的会话把额度占满（必须显式 origin:'panel'：新语义下不传 origin 的
  // enable 是 agent 启用，不占额度，这条失败场景就构造不出来了）
  await registry.enable({ projectId: 'vp_other1', root: 'D:/o1', sessionId: 'session-other-1', title: '别人的1', origin: 'panel' });
  await registry.enable({ projectId: 'vp_other2', root: 'D:/o2', sessionId: 'session-other-2', title: '别人的2', origin: 'panel' });
  const full = (await registry.listEnabled()).map((x) => x.projectId).sort();
  if (full.length !== 2 || full.includes(docA.projectId)) throw new Error('额度没按预期占满: ' + full.join(','));

  const bindingBefore = JSON.parse(await fs.readFile(BINDINGS, 'utf8'))[S].projectId;
  if (bindingBefore !== docA.projectId) throw new Error('测试装置坏了：绑定不在 A 上');

  let code = null;
  try {
    await store.rebind(S, docB.projectId); // 目标未启用，额度已满
  } catch (e) {
    code = e.code;
  }
  if (code !== 'ENABLED_LIMIT') throw new Error('code=' + code);
  const bindingAfter = JSON.parse(await fs.readFile(BINDINGS, 'utf8'))[S].projectId;
  if (bindingAfter !== bindingBefore) throw new Error('失败时动了绑定: ' + bindingBefore + ' → ' + bindingAfter);
  const ids = (await registry.listEnabled()).map((x) => x.projectId);
  if (ids.includes(docB.projectId)) throw new Error('失败时还是把新工程加进去了');
});

await step('绑定表仍是 1:1：一个会话只有一个条目，且不是数组', async () => {
  const map = JSON.parse(await fs.readFile(BINDINGS, 'utf8'));
  const rec = map[S];
  if (Array.isArray(rec)) throw new Error('绑定被改成了数组');
  if (!rec || typeof rec.projectId !== 'string') throw new Error('绑定记录形如: ' + JSON.stringify(rec));
  const owners = Object.entries(map).filter(([, v]) => v && v.projectId === rec.projectId);
  if (owners.length !== 1) throw new Error('同一个工程被多个会话绑定: ' + owners.length);
});

await step('旧格式绑定（值是纯字符串）读取正常，不让整张表变成坏文件', async () => {
  await resetBindings();
  await fs.writeFile(BINDINGS, JSON.stringify({ 'session-legacy': 'vp_legacy' }), 'utf8');
  const fresh = new ProjectStore();
  const info = await fresh.bindingOf('session-legacy');
  if (!info || info.projectId !== 'vp_legacy') throw new Error('读不到旧条目: ' + JSON.stringify(info));
  const restored = await fresh.restore('session-legacy'); // 没有目录信息 → null，但不许抛
  if (restored !== null) throw new Error('旧条目不该能直接恢复出工程');
  // 旧条目旁边还能正常写新条目
  const freshRoot = await fs.mkdtemp(path.join(tmp, 'legacy-new-'));
  await fresh.open(freshRoot, 'session-new');
  const map = JSON.parse(await fs.readFile(BINDINGS, 'utf8'));
  if (map['session-legacy'].projectId !== 'vp_legacy') throw new Error('旧条目被写坏了');
  if (!map['session-new'] || !map['session-new'].projectId) throw new Error('新条目没写进去');
});

await step('assertSession 仍然拦非法会话（读写都拦）', async () => {
  try {
    store.get(docA.projectId);
    store.assertSession(store.get(docA.projectId).doc, 'intruder');
    throw new Error('应当被拒');
  } catch (e) {
    if (e.code !== 'BOUND_TO_OTHER_SESSION') throw e;
  }
  try {
    await store.rename(docA.projectId, 'intruder', 'x');
    throw new Error('应当被拒');
  } catch (e) {
    if (e.code !== 'BOUND_TO_OTHER_SESSION') throw e;
  }
});

// ------------------------------------------------------------------ RPC ----

const routes = [];
const rpcStore = new ProjectStore();
const ctx = {
  webServer: { register: (route) => { routes.push(route); return () => {}; } },
  get: () => undefined,
};
registerVideoRoutes(ctx, rpcStore, () => {});

function fakeReq(body) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/api/video/rpc';
  setTimeout(() => {
    if (body) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  }, 0);
  return req;
}
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    write(c) { this.body += c; },
    end(c) { if (c) this.body += c; },
  };
  return res;
}
const rpcRoute = routes.find((r) => r.path === '/api/video/rpc');
async function call(method, params) {
  const res = fakeRes();
  await rpcRoute.handler(fakeReq({ method, params }), res);
  const payload = JSON.parse(res.body);
  if (!payload.ok) {
    const err = new Error(payload.error.message);
    err.code = payload.error.code;
    throw err;
  }
  return payload.value;
}

const rpcRoot = await fs.mkdtemp(path.join(tmp, 'rpc-'));
const RPC_SESSION = 'session-rpc-xyz';
let rpcDoc = null;

await step('RPC project.enabled.list 返回 { enabled, max: 2 }', async () => {
  await resetRegistry();
  const value = await call('project.enabled.list', {});
  if (!Array.isArray(value.enabled) || value.max !== 2 || value.enabled.length !== 0) {
    throw new Error(JSON.stringify(value));
  }
});

await step('RPC project.enable 从 store 取 root/title/sessionId（不接受客户端自报）', async () => {
  const opened = await call('project.open', { dir: rpcRoot, sessionId: RPC_SESSION });
  rpcDoc = opened.doc;
  const value = await call('project.enable', { projectId: rpcDoc.projectId });
  if (value.enabled.length !== 1 || value.max !== 2) throw new Error(JSON.stringify(value));
  const rec = value.enabled[0];
  if (rec.sessionId !== RPC_SESSION) throw new Error('sessionId 不是从 store 取的: ' + rec.sessionId);
  if (rec.root !== path.resolve(rpcRoot)) throw new Error('root 不对: ' + rec.root);
});

await step('RPC project.rename 改名 + 登记表里的显示名一起改', async () => {
  const value = await call('project.rename', { projectId: rpcDoc.projectId, sessionId: RPC_SESSION, title: 'RPC 改名' });
  if (value.doc.title !== 'RPC 改名') throw new Error('返回值不对: ' + JSON.stringify(value.doc.title));
  const enabled = await call('project.enabled.list', {});
  if (enabled.enabled[0].title !== 'RPC 改名') throw new Error('登记表还是旧名字: ' + enabled.enabled[0].title);
  try {
    await call('project.rename', { projectId: rpcDoc.projectId, sessionId: RPC_SESSION, title: '   ' });
    throw new Error('空名字应当被拒');
  } catch (e) {
    if (e.code !== 'INVALID_ARG') throw e;
  }
});

await step('RPC project.disable 释放额度；project.list 列本会话工程', async () => {
  const off = await call('project.disable', { projectId: rpcDoc.projectId });
  if (off.removed !== true || off.enabled.length !== 0) throw new Error(JSON.stringify(off));
  const mine = await call('project.list', { sessionId: RPC_SESSION });
  if (!mine.projects.some((p) => p.projectId === rpcDoc.projectId)) throw new Error('本会话列表里没有它');
});

await step('RPC session.rebind 换绑并启用目标工程', async () => {
  const root2 = await fs.mkdtemp(path.join(tmp, 'rpc2-'));
  const opened2 = await call('project.open', { dir: root2, sessionId: RPC_SESSION });
  const target = opened2.doc;
  // 绑定此刻指向 target（open 会写绑定）；换回第一个，再换过来，验证来回都对
  const back = await call('session.rebind', { sessionId: RPC_SESSION, projectId: rpcDoc.projectId });
  if (back.projectId !== rpcDoc.projectId) throw new Error('换回失败');
  const forth = await call('session.rebind', { sessionId: RPC_SESSION, projectId: target.projectId });
  if (forth.projectId !== target.projectId) throw new Error('换过去失败');
  if (forth.previous !== rpcDoc.projectId) throw new Error('previous=' + forth.previous);
  const map = JSON.parse(await fs.readFile(BINDINGS, 'utf8'));
  if (map[RPC_SESSION].projectId !== target.projectId) throw new Error('RPC 没写绑定表');
  const enabled = (await call('project.enabled.list', {})).enabled.map((x) => x.projectId);
  if (enabled.includes(rpcDoc.projectId)) throw new Error('旧工程没停用');
  if (!enabled.includes(target.projectId)) throw new Error('新工程没启用');
});

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
