/**
 * 全局「已启用视频项目」登记表。
 *
 * 为什么是全局而不是按会话：一个会话只绑定一个项目，但视频工作台是重型资源
 * （每个 <video> 元素 30-80MB），所以整个 DSH 实例同时最多只允许 MAX_ENABLED
 * 个项目处于「已启用」。第三个会话想启用时，必须先去别的会话停用一个。
 *
 * 语义区分：
 *   enabled —— 许可（持久化，重启后仍在，但重启不会自动加载）
 *   active  —— 此刻真的挂载了工作台（只在内存里，由客户端状态表达）
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DomainError } from './domain.mjs';

/** 全局上限：跨会话共享这个额度。 */
export const MAX_ENABLED = 2;

/** 登记表路径：测试用 DSH_VIDEO_ENABLED 覆盖。 */
export function registryPath() {
  return process.env.DSH_VIDEO_ENABLED || path.join(os.homedir(), '.dsh', 'video-enabled.json');
}

/**
 * 会话标识：去掉 `session-` 前缀后取「前 5 + … + 末 4」。
 *
 * 会话 id 形如 `session-<uuid>`，只取前 8 位会恒等于 `session-`，
 * 拒绝文案里点不出到底是谁占了额度。短 id 原样显示。
 */
function shortSession(sessionId) {
  const s = String(sessionId || '');
  if (!s) return '未知会话';
  const tail = s.startsWith('session-') ? s.slice('session-'.length) : s;
  if (!tail) return '未知会话';
  return tail.length > 9 ? tail.slice(0, 5) + '…' + tail.slice(-4) : tail;
}

/** 读登记表：坏文件降级成空表，并把坏文件改名留档，绝不因为一个坏 JSON 卡死启动。 */
export async function readRegistry() {
  const file = registryPath();
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { enabled: [] };
    return { enabled: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed && parsed.enabled) ? parsed.enabled : [];
    return {
      enabled: list
        .filter((x) => x && typeof x.projectId === 'string')
        .map((x) => ({
          projectId: x.projectId,
          root: typeof x.root === 'string' ? x.root : '',
          sessionId: typeof x.sessionId === 'string' ? x.sessionId : '',
          title: typeof x.title === 'string' ? x.title : '',
          // 必须原样带出来：这个 map 是白名单，漏掉 origin 会让刚写进去的
          // 'panel' 在下一次 readRegistry 时被抹掉 —— 额度因此永远读到 0，
          // 面板启用可以无限加（2026-11-06 回归里实际发生过）。
          // 历史记录没有 origin：按 'agent' 解释（不占额度），老账立即失效。
          origin: x.origin === 'panel' ? 'panel' : 'agent',
          since: typeof x.since === 'string' ? x.since : '',
        })),
    };
  } catch {
    try {
      await fs.rename(file, file + '.bak');
    } catch {
      /* 留档失败也不影响继续用空表 */
    }
    return { enabled: [] };
  }
}

async function writeRegistry(doc) {
  const file = registryPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/**
 * 写操作串行队列。
 *
 * 为什么需要：额度是跨会话的，两个会话可能几乎同时点「启用」。读-改-写之间
 * 有 await（readFile/writeFile），不串行时两边都会读到「还剩一个空位」，
 * 然后后写的一方覆盖前一方 —— 看起来只丢了一条，其实是额度被击穿。
 */
let writeChain = Promise.resolve();

function serialize(task) {
  const run = writeChain.then(task, task);
  // 队列本身必须永远处于 resolved 状态，否则一次失败会把后面的操作全卡住
  writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

export async function listEnabled() {
  const doc = await readRegistry();
  return doc.enabled;
}

export async function isEnabled(projectId) {
  const list = await listEnabled();
  return list.some((x) => x.projectId === projectId);
}

/**
 * 额度只统计「面板启用」的工程。
 *
 * 为什么：agent 会话（video_setup / rebind）也会把工程写进 enabled，但 agent 会话
 * 没有面板入口 —— 占了就放不掉，实测会把人锁死在 2/2（自己在面板里进不去也停不了）。
 * 所以每条记录带 origin：
 *   'panel' —— 用户在工作台里点「启用」，计入额度
 *   'agent' —— agent 调用自动启用，不计入额度（进程内照样能打开、读写）
 * 历史记录没有 origin：此前能让额度满的只有 agent 侧路径，因此按 'agent' 解释，
 * 老账立刻失效（不删数据，只改计数口径）。
 */
export function entryCounts(entry) {
  return !!entry && entry.origin === 'panel';
}

async function enableInner({ projectId, root, sessionId, title, origin } = {}) {
  if (!projectId) throw new DomainError('INVALID_ARG', '启用项目需要 projectId');
  const doc = await readRegistry();
  const existing = doc.enabled.find((x) => x.projectId === projectId);
  if (existing) return { enabled: doc.enabled, added: null, already: true };

  const kind = origin === 'panel' ? 'panel' : 'agent';

  // 只有面板启用才占额度；agent 启用不占（它没有面板入口，占了也放不掉）
  if (kind === 'panel') {
    const counted = doc.enabled.filter(entryCounts);
    if (counted.length >= MAX_ENABLED) {
      const owners = counted
        .map((x) => `${x.title || x.projectId}（会话 ${shortSession(x.sessionId)}）`)
        .join('、');
      throw new DomainError(
        'ENABLED_LIMIT',
        `已有 ${MAX_ENABLED} 个工程被工作台启用（${owners}）。请先停用其中一个，再启用新项目。`,
        { enabled: doc.enabled },
      );
    }
  }

  const entry = {
    projectId,
    root: root || '',
    sessionId: sessionId || '',
    title: title || '',
    origin: kind,
    since: new Date().toISOString(),
  };
  doc.enabled.push(entry);
  await writeRegistry(doc);
  return { enabled: doc.enabled, added: entry, already: false };
}

/**
 * 启用一个项目。已启用则幂等返回。
 * 超过 MAX_ENABLED 抛 ENABLED_LIMIT，文案点名「去哪个会话停用哪一个」。
 */
export async function enable(input) {
  return serialize(() => enableInner(input));
}

async function disableInner(projectId) {
  if (!projectId) throw new DomainError('INVALID_ARG', '停用项目需要 projectId');
  const doc = await readRegistry();
  const before = doc.enabled.length;
  doc.enabled = doc.enabled.filter((x) => x.projectId !== projectId);
  const removed = before !== doc.enabled.length;
  if (removed) await writeRegistry(doc);
  return { enabled: doc.enabled, removed };
}

/** 停用一个项目；返回停用后的列表与是否真的删掉了。 */
export async function disable(projectId) {
  return serialize(() => disableInner(projectId));
}

/**
 * 改登记表里的显示名（额度不变）。
 *
 * 为什么要有：被拒文案里点名的是「谁占了额度」，工程改名后登记表若不跟着改，
 * 别的会话看到的占用者会一直是旧名字。项目没启用时返回 false，不写盘。
 */
export async function updateTitle(projectId, title) {
  return serialize(async () => {
    if (!projectId) return false;
    const doc = await readRegistry();
    const rec = doc.enabled.find((x) => x.projectId === projectId);
    if (!rec) return false;
    const next = String(title || '');
    if (rec.title === next) return false;
    rec.title = next;
    await writeRegistry(doc);
    return true;
  });
}
