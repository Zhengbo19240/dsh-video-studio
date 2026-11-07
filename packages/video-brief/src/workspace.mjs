/**
 * 解析"当前会话的工程根目录"。
 *
 * 顺序与 grill-first 保持一致（它已经在本机验证过可用）：
 *   1. `DSH_VIDEO_BRIEF_WORKSPACE` 环境变量；
 *   2. `agent.session.header.cwd`；
 *   3. `sandboxPolicy.resolve({ session })`；
 *   4. `process.cwd()`。
 */

import path from 'node:path';

/** 从 agent 上取会话 cwd。 */
function sessionCwd(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : '';
}

/** @returns {string} 绝对路径 */
export function resolveWorkspaceRoot(ctx, agent) {
  const explicit = process.env.DSH_VIDEO_BRIEF_WORKSPACE;
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit.trim());
  const cwd = sessionCwd(agent);
  if (cwd !== '') return path.resolve(cwd);
  const policy = ctx && typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : null;
  if (policy && typeof policy.resolve === 'function') {
    try {
      const resolved = policy.resolve(agent?.session ? { session: agent.session } : {});
      const root = resolved?.workspaceRoot;
      if (typeof root === 'string' && root.trim() !== '') return path.resolve(root);
    } catch {
      /* 策略服务挂了就退到 process.cwd() */
    }
  }
  return path.resolve(process.cwd());
}
