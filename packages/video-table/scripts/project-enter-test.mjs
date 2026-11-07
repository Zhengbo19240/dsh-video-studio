/**
 * 工程卡片「进不去 / 停用后消失」的真实回归（真 store + 临时目录 + 真 RPC）。
 *
 *   node scripts/project-enter-test.mjs
 *
 * 用户连撞三次的两个死锁：
 *
 *   bug 1 —— 启用与打开互为前提。
 *     project.enable 第一行 store.get(projectId)，工程没在本进程打开就抛 REF_NOT_FOUND；
 *     而客户端又是「先 enable 再 open」。对一个已登记但没打开的工程，启用必然失败，
 *     打开又永远排在它后面 —— 点不动。
 *     修法：enable 收可选 dir，没打开就先 store.open（校验 BOUND_TO_OTHER_SESSION）
 *     再启用；不带 dir 时给一条「请带上 dir 重试」的可读错误。
 *
 *   bug 2 —— 停用后卡片直接消失。
 *     project.list 只回 store.projectsForSession（内存里已打开的）。停用放掉内存后
 *     列表变空，卡片消失，用户再也找不到自己的工程。
 *     修法：projectCards 把「已打开 + 全局登记表里本会话的 + 绑定表里本会话的」
 *     三处并起来，按 projectId 去重，逐张标 open / enabled / missing。
 *
 * 这里不测函数，只测「用户真的点得到」的那条链路。
 */

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-enter-'));
const BINDINGS = path.join(tmp, 'bindings.json');
const REGISTRY = path.join(tmp, 'video-enabled.json');
process.env.DSH_VIDEO_BINDINGS = BINDINGS;
process.env.DSH_VIDEO_ENABLED = REGISTRY;

const { ProjectStore } = await import('../src/store.mjs');
const { registerVideoRoutes } = await import('../src/routes.mjs');
const registry = await import('../src/enabled-registry.mjs');

const S = 'session-enter-main';
const OTHER = 'session-enter-other';

let pass = 0;
const failures = [];
async function step(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    failures.push(name + ': ' + (e && e.message));
    console.log('  FAIL ' + name + ' — ' + (e && e.message));
  }
}

// ------------------------------------------------------------------ 装置 ----

/** 全新一套路由 + store，模拟一次「进程重启」。 */
function harness(store) {
  const routes = [];
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    get: () => undefined,
  };
  registerVideoRoutes(ctx, store, () => {});
  const rpcRoute = routes.find((r) => r.path === '/api/video/rpc');
  return async function call(method, params) {
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = '/api/video/rpc';
    setTimeout(() => {
      req.emit('data', Buffer.from(JSON.stringify({ method, params })));
      req.emit('end');
    }, 0);
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(k, v) {
        this.headers[k] = v;
      },
      write(c) {
        this.body += c;
      },
      end(c) {
        if (c) this.body += c;
      },
    };
    await rpcRoute.handler(req, res);
    const payload = JSON.parse(res.body);
    if (!payload.ok) {
      const err = new Error(payload.error.message);
      err.code = payload.error.code;
      throw err;
    }
    return payload.value;
  };
}

async function resetAll() {
  await fs.rm(REGISTRY, { force: true });
  await fs.rm(REGISTRY + '.bak', { force: true });
  await fs.rm(BINDINGS, { force: true });
}

async function expectError(fn, code) {
  try {
    await fn();
  } catch (e) {
    if (e.code !== code) throw new Error('期望 ' + code + '，实际 ' + e.code + '：' + e.message);
    return e;
  }
  throw new Error('期望抛 ' + code + '，实际成功返回');
}

const rootA = await fs.mkdtemp(path.join(tmp, 'projA-'));
const rootB = await fs.mkdtemp(path.join(tmp, 'projB-'));
const rootC = await fs.mkdtemp(path.join(tmp, 'projC-'));

// ------------------------------------------------- 1. 不带 dir 的可读错误 ----
//
// 旧实现这里只抛「工程未打开: vp_xxx」，调用方看不出该怎么自救。

await resetAll();
const seedStore = new ProjectStore();
const callSeed = harness(seedStore);
const seedDoc = (await callSeed('project.open', { dir: rootA, sessionId: S })).doc;
// 「重启」：新 store 里一个工程都没有，但磁盘上有工程文件与绑定
const restarted = new ProjectStore();
const callRestarted = harness(restarted);

await step('未打开且不带 dir → REF_NOT_FOUND，文案指向「带上 dir 重试」', async () => {
  const err = await expectError(
    () => callRestarted('project.enable', { projectId: seedDoc.projectId, sessionId: S }),
    'REF_NOT_FOUND',
  );
  if (!/dir/i.test(err.message)) throw new Error('错误文案没告诉调用方去带 dir：' + err.message);
});

// --------------------------------------------------- 2. 带 dir 的自愈打开 ----

await step('已登记但未打开 → project.enable 带 dir 成功，且真的把工程打开了', async () => {
  const value = await callRestarted('project.enable', {
    projectId: seedDoc.projectId,
    dir: rootA,
    sessionId: S,
  });
  if (value.opened !== true) throw new Error('返回里没标 opened:true');
  if (!value.enabled.some((x) => x.projectId === seedDoc.projectId)) throw new Error('登记表里没有它');
  // 真的在 store 里，后续 timeline / 编辑才可能工作
  const entry = restarted.get(seedDoc.projectId);
  if (entry.doc.boundSessionId !== S) throw new Error('打开时绑错了会话');
  if (value.doc.projectId !== seedDoc.projectId) throw new Error('返回的 doc 不是这个工程');
});

await step('自愈后再 enable（不带 dir）幂等：already:true，登记表不新增', async () => {
  const before = (await registry.listEnabled()).length;
  const value = await callRestarted('project.enable', { projectId: seedDoc.projectId, sessionId: S });
  if (value.already !== true) throw new Error('应当 already:true');
  if (value.enabled.length !== before) throw new Error('幂等失败，新增了一条');
  if (value.opened !== false) throw new Error('已经打开过，不该再标 opened');
});

await step('额度口径不变：面板启用记 origin:panel，root/title/sessionId 都来自 store', async () => {
  const rec = (await registry.listEnabled()).find((x) => x.projectId === seedDoc.projectId);
  if (!rec) throw new Error('登记表里没有它');
  if (rec.origin !== 'panel') throw new Error('origin=' + rec.origin);
  if (rec.root !== path.resolve(rootA)) throw new Error('root 不对: ' + rec.root);
  if (rec.sessionId !== S) throw new Error('sessionId 不对: ' + rec.sessionId);
  if (!rec.title) throw new Error('title 空');
});

// ------------------------------------- 3. list 要包含「已登记但未打开」 ----

await step('project.list 包含「已登记未打开」的工程，字段齐全且 open:false', async () => {
  // 第三个 store：它一个工程都没打开，但登记表里有 rootA 那个
  const fresh = new ProjectStore();
  const callFresh = harness(fresh);
  const { projects } = await callFresh('project.list', { sessionId: S });
  const card = projects.find((p) => p.projectId === seedDoc.projectId);
  if (!card) throw new Error('列表里没有它，卡片会消失');
  for (const key of ['projectId', 'root', 'title', 'enabled', 'open', 'missing']) {
    if (!(key in card)) throw new Error('卡片缺字段 ' + key + '：' + JSON.stringify(card));
  }
  if (card.open !== false) throw new Error('open 应为 false');
  if (card.enabled !== true) throw new Error('enabled 应为 true');
  if (card.missing !== false) throw new Error('目录存在，missing 应为 false');
  if (card.root !== path.resolve(rootA)) throw new Error('root 不对: ' + card.root);
  if (!card.title) throw new Error('title 没从 project.json 读出来');
});

await step('project.list 不带 sessionId → INVALID_ARG（不静默回空列表）', async () => {
  const fresh = new ProjectStore();
  const callFresh = harness(fresh);
  await expectError(() => callFresh('project.list', {}), 'INVALID_ARG');
});

// ------------------------------------------------ 4. 停用后卡片不消失 ----

await step('停用后 project.list 仍包含该工程（enabled:false），卡片不会消失', async () => {
  await callRestarted('project.disable', { projectId: seedDoc.projectId });
  const { projects } = await callRestarted('project.list', { sessionId: S });
  const card = projects.find((p) => p.projectId === seedDoc.projectId);
  if (!card) throw new Error('停用后卡片消失了');
  if (card.enabled !== false) throw new Error('停用后 enabled 应为 false');
  // 停用只释放额度，不关工程：这一张仍是 open:true，带 doc 摘要
  if (card.open !== true) throw new Error('停用不该把已打开的工程放掉');
});

await step('停用 + 重启（空 store）→ 仍能从 enabled 恢复出卡片', async () => {
  await registry.enable({ projectId: seedDoc.projectId, root: rootA, sessionId: S, title: seedDoc.title, origin: 'agent' });
  const fresh = new ProjectStore();
  const callFresh = harness(fresh);
  const { projects } = await callFresh('project.list', { sessionId: S });
  const card = projects.find((p) => p.projectId === seedDoc.projectId);
  if (!card) throw new Error('重启后卡片没了');
  if (card.open !== false) throw new Error('重启后不该是 open:true');
  await registry.disable(seedDoc.projectId);
});

await step('停用 + 重启 + 登记表也没有 → 仍能从绑定表恢复出卡片', async () => {
  await registry.disable(seedDoc.projectId);
  const fresh = new ProjectStore();
  const callFresh = harness(fresh);
  const { projects } = await callFresh('project.list', { sessionId: S });
  const card = projects.find((p) => p.projectId === seedDoc.projectId);
  if (!card) throw new Error('只靠绑定表也该列出这张卡片');
  if (card.open !== false) throw new Error('open 应为 false');
  if (card.enabled !== false) throw new Error('enabled 应为 false');
  if (card.root !== path.resolve(rootA)) throw new Error('绑定表里的 root 没带出来: ' + card.root);
  if (!card.title) throw new Error('标题应从 project.json 补出来');
});

// -------------------------------------------- 5. 跨会话 + 脏数据 + 去重 ----

await step('BOUND_TO_OTHER_SESSION：拿别人的 root 调 enable(dir) 必须被拒', async () => {
  const fresh = new ProjectStore();
  const callFresh = harness(fresh);
  await expectError(
    () => callFresh('project.enable', { projectId: seedDoc.projectId, dir: rootA, sessionId: OTHER }),
    'BOUND_TO_OTHER_SESSION',
  );
  // 被拒之后不许留下任何痕迹：登记表里不能多一条
  const ids = (await registry.listEnabled()).map((x) => x.projectId);
  if (ids.includes(seedDoc.projectId)) throw new Error('被拒却写进了登记表');
});

await step('脏数据：登记表里的 root 已不存在 → missing:true，且不抛错', async () => {
  await resetAll();
  const ghostRoot = path.join(tmp, 'gone-' + Date.now());
  await registry.enable({ projectId: 'vp_ghost_1', root: ghostRoot, sessionId: S, title: '幽灵工程', origin: 'panel' });
  const fresh = new ProjectStore();
  const callFresh = harness(fresh);
  const { projects } = await callFresh('project.list', { sessionId: S });
  const card = projects.find((p) => p.projectId === 'vp_ghost_1');
  if (!card) throw new Error('脏条目被整条丢掉了（应当列出来并标 missing）');
  if (card.missing !== true) throw new Error('missing 应为 true');
  if (card.open !== false) throw new Error('open 应为 false');
});

await step('去重：已打开的工程只出现一次，且带 doc 摘要（tracks / clipCount）', async () => {
  await resetAll();
  const fresh = new ProjectStore();
  const callFresh = harness(fresh);
  const opened = (await callFresh('project.open', { dir: rootB, sessionId: S })).doc;
  await callFresh('project.enable', { projectId: opened.projectId, dir: rootB, sessionId: S });
  // 同一个工程此刻同时存在于内存 / 登记表 / 绑定表三处
  const { projects } = await callFresh('project.list', { sessionId: S });
  const hits = projects.filter((p) => p.projectId === opened.projectId);
  if (hits.length !== 1) throw new Error('同一个工程出现了 ' + hits.length + ' 次');
  const card = hits[0];
  if (card.open !== true || card.enabled !== true) throw new Error('open/enabled 标志不对: ' + JSON.stringify(card));
  if (!Array.isArray(card.tracks)) throw new Error('已打开的卡片应带 doc 摘要（缺 tracks）');
  if (typeof card.clipCount !== 'number') throw new Error('已打开的卡片应带 clipCount');
});

// ------------------------------------------------------ 6. 额度口径回归 ----

await step('额度：面板启用只算 origin:panel，agent 打开的不占名额', async () => {
  await resetAll();
  // 额度这条要用全新的目录：上面的 rootA/B/C 已经绑在主会话上，
  // 拿另一个会话去打开会被 BOUND_TO_OTHER_SESSION 挡住（那本身是另一条断言）。
  const q1 = await fs.mkdtemp(path.join(tmp, 'quota1-'));
  const q2 = await fs.mkdtemp(path.join(tmp, 'quota2-'));
  const q3 = await fs.mkdtemp(path.join(tmp, 'quota3-'));
  const q = new ProjectStore();
  const callQ = harness(q);
  const qa = (await callQ('project.open', { dir: q1, sessionId: 'session-quota' })).doc;
  const qb = (await callQ('project.open', { dir: q2, sessionId: 'session-quota' })).doc;
  const qc = (await callQ('project.open', { dir: q3, sessionId: 'session-quota' })).doc;

  // 两条 agent 记录（video_setup / rebind 那类自动启用）先塞进去
  await registry.enable({ projectId: 'vp_agent_1', root: 'D:/a1', sessionId: 'session-agent', title: 'agent1' });
  await registry.enable({ projectId: 'vp_agent_2', root: 'D:/a2', sessionId: 'session-agent', title: 'agent2' });

  await callQ('project.enable', { projectId: qa.projectId, dir: q1, sessionId: 'session-quota' });
  await callQ('project.enable', { projectId: qb.projectId, dir: q2, sessionId: 'session-quota' });
  const err = await expectError(
    () => callQ('project.enable', { projectId: qc.projectId, dir: q3, sessionId: 'session-quota' }),
    'ENABLED_LIMIT',
  );
  if (!/已有 2 个工程/.test(err.message)) throw new Error('额度文案没说清：' + err.message);

  const list = await registry.listEnabled();
  if (list.filter((x) => x.origin === 'panel').length !== 2) throw new Error('panel 计数不对');
  if (list.filter((x) => x.origin !== 'panel').length !== 2) throw new Error('agent 记录被算成额度了');
});

// ------------------------------------------------- 7. 已打开但未启用的工程 ----

await step('已打开 + 未启用 → 点「进入」（enable 不带 dir）后 enabled:true', async () => {
  await resetAll();
  const st = new ProjectStore();
  const call = harness(st);
  const doc = (await call('project.open', { dir: rootC, sessionId: S })).doc;
  const before = await call('project.list', { sessionId: S });
  const cardBefore = before.projects.find((p) => p.projectId === doc.projectId);
  if (!cardBefore || cardBefore.enabled !== false) throw new Error('前提不成立：应当已打开且未启用');
  const value = await call('project.enable', { projectId: doc.projectId, dir: rootC, sessionId: S });
  if (value.already !== false) throw new Error('第一次启用不该是 already');
  const after = await call('project.list', { sessionId: S });
  const cardAfter = after.projects.find((p) => p.projectId === doc.projectId);
  if (!cardAfter || cardAfter.enabled !== true) throw new Error('启用后 enabled 仍为 false');
  if (cardAfter.open !== true) throw new Error('启用后 open 应为 true');
});

// ------------------------------------------------------- 8. 少了 sessionId ----

await step('需要自愈但没给 sessionId → INVALID_ARG，文案点名 sessionId', async () => {
  await resetAll();
  const fresh = new ProjectStore();
  const call = harness(fresh);
  const err = await expectError(
    () => call('project.enable', { projectId: seedDoc.projectId, dir: rootA }),
    'INVALID_ARG',
  );
  if (!/sessionId/.test(err.message)) throw new Error('文案没点名 sessionId：' + err.message);
});

// ----------------------------------------------- 9. 登记表 id 与磁盘不一致 ----

await step('脏数据自愈：登记的 projectId 与磁盘不一致 → 启用真 id 并删掉幽灵条目', async () => {
  await resetAll();
  const staleRoot = rootB;
  // 先确认磁盘上这个目录的真实 projectId
  const probeStore = new ProjectStore();
  const probeCall = harness(probeStore);
  const real = (await probeCall('project.open', { dir: staleRoot, sessionId: S })).doc;
  // 再造一条指向同一目录、但 id 是旧值的登记
  await fs.writeFile(
    REGISTRY,
    JSON.stringify({
      enabled: [
        { projectId: 'vp_stale_0001', root: path.resolve(staleRoot), sessionId: S, title: '旧卡片', origin: 'panel', since: new Date().toISOString() },
      ],
    }),
    'utf8',
  );
  const fresh = new ProjectStore();
  const call = harness(fresh);
  const value = await call('project.enable', { projectId: 'vp_stale_0001', dir: staleRoot, sessionId: S });
  if (value.projectId !== real.projectId) throw new Error('启用的不是磁盘上的真 id：' + value.projectId);
  if (value.replaced !== 'vp_stale_0001') throw new Error('没报告被替换掉的幽灵条目');
  const ids = (await registry.listEnabled()).map((x) => x.projectId);
  if (ids.includes('vp_stale_0001')) throw new Error('幽灵条目还在，会永远留一张点不动的卡片');
  if (!ids.includes(real.projectId)) throw new Error('真 id 没进登记表');
});

// ------------------------------------------------------------------ 收尾 ----

await fs.rm(tmp, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
