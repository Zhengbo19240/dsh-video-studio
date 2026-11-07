/**
 * 全局启用登记表（enabled-registry）的断言。
 *
 *   node scripts/enabled-registry-test.mjs
 *
 * 这一层是「全局最多 2 个工程同时已启用」的唯一权威：RPC 与客户端都只是它的
 * 调用方。所以这里断的是 Authority 本身：额度、幂等、释放、坏文件降级、
 * 原子写、环境变量覆盖，以及两个会话同时点启用时不能丢更新。
 *
 * ★ 2026-11-06 额度语义改了：MAX_ENABLED 只数「面板启用」（origin==='panel'），
 *   agent 调用（video_setup / 工具打开）永远不占额度；没有 origin 的历史记录
 *   按 'agent' 解释。所以本套件里凡是「要占额度 / 要触发 ENABLED_LIMIT」的
 *   enable 都必须显式传 origin:'panel' —— 旧断言用「不传 origin 就占额度」，
 *   在新语义下它们全都是 agent 启用，永远不该被拒。改的是断言，不是语义。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-enabled-'));
const REGISTRY = path.join(tmp, 'video-enabled.json');
process.env.DSH_VIDEO_ENABLED = REGISTRY;

const {
  MAX_ENABLED,
  registryPath,
  listEnabled,
  isEnabled,
  enable,
  disable,
  updateTitle,
} = await import('../src/enabled-registry.mjs');

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

async function reset() {
  await fs.rm(REGISTRY, { force: true });
  await fs.rm(REGISTRY + '.bak', { force: true });
}

const S1 = 'session-alpha-1111';
const S2 = 'session-beta-2222';

await step('MAX_ENABLED 是 2，且 DSH_VIDEO_ENABLED 覆盖生效', async () => {
  if (MAX_ENABLED !== 2) throw new Error('MAX_ENABLED=' + MAX_ENABLED);
  if (registryPath() !== REGISTRY) throw new Error('registryPath=' + registryPath());
});

await step('登记表不存在时是空表（不抛错）', async () => {
  const list = await listEnabled();
  if (!Array.isArray(list) || list.length !== 0) throw new Error(JSON.stringify(list));
});

await step('enable 写入完整条目（root / sessionId / title / origin / since）', async () => {
  await reset();
  // 面板启用：本套件后面要断言额度，所以从第一条起就是 origin:'panel'。
  const r = await enable({ projectId: 'vp_a', root: 'D:/proj/a', sessionId: S1, title: '工程A', origin: 'panel' });
  if (r.already !== false) throw new Error('already=' + r.already);
  const raw = JSON.parse(await fs.readFile(REGISTRY, 'utf8'));
  const rec = raw.enabled[0];
  if (rec.projectId !== 'vp_a' || rec.root !== 'D:/proj/a' || rec.sessionId !== S1 || rec.title !== '工程A') {
    throw new Error(JSON.stringify(rec));
  }
  if (rec.origin !== 'panel') throw new Error('origin 没落盘: ' + JSON.stringify(rec));
  if (!rec.since) throw new Error('缺 since');
});

await step('同一项目重复 enable 是幂等的（表里仍 1 条）', async () => {
  const r = await enable({ projectId: 'vp_a', root: 'D:/proj/a', sessionId: S1, title: '工程A' });
  if (r.already !== true) throw new Error('第二次不是 already');
  if (r.added !== null) throw new Error('第二次不该 added');
  const list = await listEnabled();
  if (list.length !== 1) throw new Error('length=' + list.length);
  if (!(await isEnabled('vp_a'))) throw new Error('isEnabled=false');
});

await step('第二个项目占满额度', async () => {
  // 新语义：额度只数面板启用，所以第二条也必须是 origin:'panel' 才算「占满」。
  await enable({ projectId: 'vp_b', root: 'D:/proj/b', sessionId: S2, title: '工程B', origin: 'panel' });
  const list = await listEnabled();
  if (list.length !== 2) throw new Error('没有占满');
  if (list.filter((x) => x.origin === 'panel').length !== 2) throw new Error('两条都该是 panel');
});

await step('第三个面板启用被拒，code=ENABLED_LIMIT', async () => {
  try {
    await enable({
      projectId: 'vp_c',
      root: 'D:/proj/c',
      sessionId: 'session-gamma',
      title: '工程C',
      origin: 'panel',
    });
    throw new Error('应当被拒');
  } catch (e) {
    if (e.code !== 'ENABLED_LIMIT') throw e;
    if (!Array.isArray(e.details && e.details.enabled) || e.details.enabled.length !== 2) {
      throw new Error('details.enabled 不对: ' + JSON.stringify(e.details));
    }
  }
  if (await isEnabled('vp_c')) throw new Error('被拒的项目仍然进了表');
});

await step('拒绝文案点名占用者与会话标识（前 5 + 末 4）', async () => {
  let message = '';
  try {
    await enable({
      projectId: 'vp_c',
      root: 'D:/proj/c',
      sessionId: 'session-gamma',
      title: '工程C',
      origin: 'panel',
    });
  } catch (e) {
    message = e.message;
  }
  // 文案随新语义改过：停用不再要求「去占用者的会话」，面板可以在任意会话腾位置，
  // 所以断言从「请先在其中之一的会话里停用」改成「请先停用其中一个」。
  if (!message.includes('已有 2 个工程被工作台启用')) throw new Error(message);
  if (!message.includes('工程A') || !message.includes('工程B')) throw new Error('没点名占用者: ' + message);
  // 会话标识：去掉 session- 前缀后「前 5 + … + 末 4」；短 id 原样
  if (!message.includes('alpha…1111') || !message.includes('beta-2222')) {
    throw new Error('没有会话标识: ' + message);
  }
  if (!message.includes('请先停用其中一个')) throw new Error('缺下一步: ' + message);
});

await step('disable 释放额度，第三个可以进来', async () => {
  const r = await disable('vp_a');
  if (r.removed !== true) throw new Error('removed=' + r.removed);
  if ((await listEnabled()).length !== 1) throw new Error('没释放');
  const ok = await enable({
    projectId: 'vp_c',
    root: 'D:/proj/c',
    sessionId: 'session-gamma',
    title: '工程C',
    origin: 'panel',
  });
  if (ok.already !== false) throw new Error('没有真的加进去');
  const ids = (await listEnabled()).map((x) => x.projectId).sort();
  if (ids.join(',') !== 'vp_b,vp_c') throw new Error(ids.join(','));
});

await step('disable 不存在的项目：removed=false 且不改坏文件', async () => {
  const before = await fs.readFile(REGISTRY, 'utf8');
  const r = await disable('vp_nope');
  if (r.removed !== false) throw new Error('removed=' + r.removed);
  const after = await fs.readFile(REGISTRY, 'utf8');
  if (before !== after) throw new Error('文件被无谓改写');
});

await step('坏 JSON 降级成空表并留 .bak', async () => {
  await fs.writeFile(REGISTRY, '{ this is not json', 'utf8');
  const list = await listEnabled();
  if (list.length !== 0) throw new Error('没有降级');
  const bak = await fs.readFile(REGISTRY + '.bak', 'utf8');
  if (bak !== '{ this is not json') throw new Error('备份内容不对: ' + bak);
  // 坏文件被移走之后，登记表还能继续用
  await enable({ projectId: 'vp_new', root: 'D:/proj/new', sessionId: S1, title: '新工程' });
  if (!(await isEnabled('vp_new'))) throw new Error('坏文件之后写不进去');
});

await step('原子写：不留 .tmp-*，文件始终是合法 JSON', async () => {
  await reset();
  await enable({ projectId: 'vp_x', root: 'D:/proj/x', sessionId: S1, title: 'X' });
  const names = await fs.readdir(tmp);
  const leftovers = names.filter((n) => n.includes('.tmp-'));
  if (leftovers.length) throw new Error('残留临时文件: ' + leftovers.join(','));
  JSON.parse(await fs.readFile(REGISTRY, 'utf8')); // 解析不了会抛
});

await step('两个会话并发启用：两条都进表（不丢更新）', async () => {
  await reset();
  const [a, b] = await Promise.all([
    enable({ projectId: 'vp_p', root: 'D:/p', sessionId: S1, title: 'P', origin: 'panel' }),
    enable({ projectId: 'vp_q', root: 'D:/q', sessionId: S2, title: 'Q', origin: 'panel' }),
  ]);
  if (a.already || b.already) throw new Error('不该 already');
  const ids = (await listEnabled()).map((x) => x.projectId).sort();
  if (ids.join(',') !== 'vp_p,vp_q') throw new Error('丢了一条: ' + ids.join(','));
});

await step('并发第 3 个面板启用仍然被拒（额度不会被并发击穿）', async () => {
  const results = await Promise.allSettled([
    enable({ projectId: 'vp_r', root: 'D:/r', sessionId: 'session-delta', title: 'R', origin: 'panel' }),
    enable({ projectId: 'vp_s', root: 'D:/s', sessionId: 'session-echo', title: 'S', origin: 'panel' }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  if (ok.length !== 0 || rejected.length !== 2) {
    throw new Error('并发时额度被击穿: ' + results.map((r) => r.status).join(','));
  }
  if ((await listEnabled()).length !== 2) throw new Error('表被撑大');
});

await step('updateTitle 只改显示名、不动额度；未启用返回 false', async () => {
  const changed = await updateTitle('vp_p', 'P 改名');
  if (changed !== true) throw new Error('没有改名');
  const list = await listEnabled();
  if (list.length !== 2) throw new Error('额度被改');
  if (list.find((x) => x.projectId === 'vp_p').title !== 'P 改名') throw new Error('名字没改');
  const noop = await updateTitle('vp_zzz', '不存在');
  if (noop !== false) throw new Error('未启用也返回了 true');
});

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
