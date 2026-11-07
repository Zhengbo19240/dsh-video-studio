/**
 * 项目写租约（lease）—— 让多个子 agent 能在同一个视频工程上并行工作。
 *
 * 背景（2026-11-05 定的设计）：
 *   以前写操作只校验 sessionId，意味着「谁拿到父会话 id 谁就能写」——既不安全也不支持并行。
 *   现在改成：写操作必须持有一份租约，租约按「范围」划分，不同范围可以同时存在。
 *
 * 范围语法（scope）：
 *   'all'              整工程（排他，与任何其他租约冲突）
 *   'track:<trackId>'  单条轨道（同一轨道串行，不同轨道可并行）
 *   'code'             代码图层（与 track 不冲突，因为代码图层不占轨道位）
 *   'audio'            音频轨（a1/a2 等）
 *
 * 原则：
 *   - 租约只在本进程内存里（重启即失效，这是有意的：重启后不该有幽灵写权限）
 *   - 过期按服务端时钟，不信任客户端时间
 *   - 冲突判定是纯函数，可测，不含 I/O
 */

/** 默认租约时长：10 分钟无心跳即失效。长任务靠 touch 续租。 */
export const DEFAULT_LEASE_MS = 10 * 60 * 1000;
/** 心跳节流：同一租约 5 秒内重复 touch 只更新一次时间，减少写放大。 */
export const TOUCH_THROTTLE_MS = 5000;

let counter = 0;

/** 生成租约 id：可读、可排序、不依赖随机数质量（进程内即可）。 */
function nextLeaseId() {
  counter += 1;
  return `lease_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/**
 * 解析 scope，非法输入抛错（中文原因）。
 * @returns {{kind:'all'|'track'|'code'|'audio', trackId?:string, raw:string}}
 */
export function parseScope(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '' || s === 'all') return { kind: 'all', raw: 'all' };
  if (s === 'code') return { kind: 'code', raw: 'code' };
  if (s === 'audio') return { kind: 'audio', raw: 'audio' };
  const m = /^track:([A-Za-z0-9_-]+)$/.exec(s);
  if (m) return { kind: 'track', trackId: m[1], raw: 'track:' + m[1] };
  throw new Error('无效的写范围：' + s + '（可用 all / track:<id> / code / audio）');
}

/**
 * 目标描述 → 需要什么 scope。
 * @param {{type:'clip'|'track'|'code'|'audio'|'project', trackId?:string}} target
 */
export function requiredScope(target) {
  if (!target || typeof target !== 'object') return { kind: 'all', raw: 'all' };
  if (target.type === 'project') return { kind: 'all', raw: 'all' };
  if (target.type === 'code') return { kind: 'code', raw: 'code' };
  if (target.type === 'audio') return { kind: 'audio', raw: 'audio' };
  if ((target.type === 'clip' || target.type === 'track') && target.trackId) {
    const id = String(target.trackId);
    if (/^[A-Za-z0-9_-]+$/.test(id)) return { kind: 'track', trackId: id, raw: 'track:' + id };
    return { kind: 'all', raw: 'all' };
  }
  return { kind: 'all', raw: 'all' };
}

/**
 * 两个 scope 是否重叠（重叠即冲突）。
 * 'all' 与任何东西都冲突；track 与 track 不同则并存；code / audio 各自独占但不与 track 冲突。
 */
export function scopesOverlap(a, b) {
  const x = parseScope(a);
  const y = parseScope(b);
  if (x.kind === 'all' || y.kind === 'all') return true;
  if (x.kind !== y.kind) return false;
  if (x.kind === 'track') return x.trackId === y.trackId;
  return true; // code vs code、audio vs audio：同类独占
}

/** 租约是否过期（用给定的 now，测试可注入）。 */
export function isExpired(lease, now = Date.now()) {
  if (!lease || typeof lease.expiresAt !== 'number') return true;
  return lease.expiresAt <= now;
}

/**
 * 新建租约。
 * @param {{projectId:string, sessionId:string, scope?:string, ttlMs?:number, label?:string}} opts
 */
export function createLease(opts = {}) {
  const { projectId, sessionId, scope = 'all', ttlMs = DEFAULT_LEASE_MS, label } = opts;
  if (!projectId) throw new Error('创建租约需要 projectId');
  const parsed = parseScope(scope);
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_LEASE_MS;
  const now = Date.now();
  return {
    leaseId: nextLeaseId(),
    projectId: String(projectId),
    sessionId: String(sessionId || ''),
    scope: parsed.raw,
    label: label ? String(label) : '',
    acquiredAt: now,
    expiresAt: now + ttl,
    lastTouchAt: now,
    ttlMs: ttl,
  };
}

/** 续租：返回新对象，不改原对象。 */
export function touchLease(lease, now = Date.now(), ttlMs) {
  if (!lease) return lease;
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : lease.ttlMs || DEFAULT_LEASE_MS;
  if (now - (lease.lastTouchAt || 0) < TOUCH_THROTTLE_MS) return lease;
  return { ...lease, lastTouchAt: now, expiresAt: now + ttl, ttlMs: ttl };
}

/** 该租约与现有租约列表是否有冲突（忽略自身、忽略过期的）。 */
export function findConflicts(leases, candidate, now = Date.now()) {
  const list = Array.isArray(leases) ? leases : [];
  return list.filter(
    (l) =>
      l &&
      l.leaseId !== candidate.leaseId &&
      l.projectId === candidate.projectId &&
      !isExpired(l, now) &&
      scopesOverlap(l.scope, candidate.scope),
  );
}

/**
 * 校验一次写操作。
 * @param {{leases:Array, leaseId:string, projectId:string, target:object, now?:number}} input
 * @returns {{ok:boolean, reason?:string, code?:string, conflicts?:Array}}
 */
export function validateWrite({ leases, leaseId, projectId, target, now = Date.now() } = {}) {
  const list = Array.isArray(leases) ? leases : [];
  const need = requiredScope(target);

  if (!leaseId) {
    return {
      ok: false,
      code: 'LEASE_REQUIRED',
      reason: `写操作需要写租约（本次目标需要 ${need.raw}）。先调用 lease.acquire 取得租约。`,
    };
  }

  const lease = list.find((l) => l && l.leaseId === leaseId);
  if (!lease) {
    return { ok: false, code: 'LEASE_NOT_FOUND', reason: `租约不存在或已被释放：${leaseId}` };
  }
  if (lease.projectId !== String(projectId)) {
    return { ok: false, code: 'LEASE_PROJECT_MISMATCH', reason: '租约不属于该工程' };
  }
  if (isExpired(lease, now)) {
    return { ok: false, code: 'LEASE_EXPIRED', reason: '租约已过期（10 分钟无心跳），请重新获取' };
  }
  if (!scopeCovers(lease.scope, need)) {
    return {
      ok: false,
      code: 'LEASE_SCOPE',
      reason: `租约范围是 ${lease.scope}，但本次要写 ${need.raw}。请申请对应范围的租约。`,
    };
  }
  return { ok: true, scope: need.raw, lease };
}

/** 租约范围是否覆盖所需范围。 */
export function scopeCovers(leaseScope, need) {
  const have = parseScope(leaseScope);
  const want = need && need.kind ? need : parseScope(need);
  if (have.kind === 'all') return true;
  if (want.kind === 'all') return false; // 只有 all 覆盖 all
  if (have.kind !== want.kind) return false;
  if (have.kind === 'track') return have.trackId === want.trackId;
  return true;
}

/** 清掉过期租约，返回 {kept, dropped}。 */
export function pruneExpired(leases, now = Date.now()) {
  const list = Array.isArray(leases) ? leases : [];
  const kept = [];
  const dropped = [];
  for (const l of list) {
    if (isExpired(l, now)) dropped.push(l);
    else kept.push(l);
  }
  return { kept, dropped };
}

/** 给人看的摘要（面板/错误文案用）。 */
export function describeLease(lease) {
  if (!lease) return '无租约';
  const scope = lease.scope === 'all' ? '整工程' : lease.scope;
  const left = Math.max(0, Math.round((lease.expiresAt - Date.now()) / 1000));
  return `${scope}（剩 ${left}s，会话 ${String(lease.sessionId || '').slice(0, 8) || '未知'}）`;
}
