/**
 * Project store: the single authoritative copy of every open project, plus
 * transactions, undo and change notification.
 *
 * Rules this file enforces:
 *  - A project is identified by its projectId; one project = one bound session.
 *  - Every write goes through apply(), which either commits a whole command
 *    batch or leaves the previous revision untouched.
 *  - Every file touch is contained by assertInside(projectRoot, path); no path
 *    the caller supplies can escape the project directory.
 *  - Undo/redo walk a per-project stack of stored snapshots. The stack is
 *    memory-only (reload = empty), capped at UNDO_LIMIT entries, and a new
 *    commit always clears the redo half — standard undo behaviour.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createProject, applyOps, DomainError, normalizeExportFps } from './domain.mjs';
import { humanDiff } from './diff-text.mjs';
import { MAX_ENABLED, disable as registryDisable, enable as registryEnable, isEnabled, listEnabled } from './enabled-registry.mjs';
import {
  createLease,
  describeLease,
  findConflicts,
  parseScope,
  pruneExpired,
  requiredScope,
  scopeCovers,
  scopesOverlap,
  touchLease as touchLeaseRecord,
  validateWrite,
} from './lease.mjs';

const STATE_DIR = '.dsh-video';

/** 每个工程最多保留多少步可撤销历史（内存）。 */
const UNDO_LIMIT = 50;

/**
 * 标注意图 / 状态的白名单（和 annotations.mjs 的 ANNOTATION_INTENTS、
 * 面板下拉里的四色 / 三种状态保持一致）。放在 store 里是为了让删除 / 修改
 * 这两条**不经过 domain 直接改字段**的入口也守同一套校验。
 */
const ANNOTATION_INTENTS = ['change', 'issue', 'question', 'note'];
const ANNOTATION_STATUSES = ['open', 'applied', 'rejected'];

/** 会话 ↔ 工程目录 的绑定表：重启后据此自动恢复。 */
function bindingsPath() {
  return process.env.DSH_VIDEO_BINDINGS || path.join(homedir(), '.dsh', 'video-workbench-bindings.json');
}

/**
 * 读绑定值里的 projectId。
 *
 * 表是 **一个会话 ↔ 一个工程**（`{ sessionId: projectId }`），绝不改成数组。
 * 历史上有两种写法：早期是纯字符串 `"vp_xxx"`，现在是记录
 * `{ root, projectId, at }`（要带 root，否则重启后找不回工程目录）。
 * 两种都必须能读 —— 读到旧的字符串时只是「不知道目录」，不能把整张表判成坏文件。
 */
function boundProjectId(rec) {
  if (!rec) return null;
  if (typeof rec === 'string') return rec || null;
  if (typeof rec === 'object' && typeof rec.projectId === 'string') return rec.projectId || null;
  return null;
}

/** 把两种历史写法统一成记录对象；无法识别的条目直接丢掉。 */
function normalizeBindings(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [sessionId, rec] of Object.entries(raw)) {
    const projectId = boundProjectId(rec);
    if (!sessionId || !projectId) continue;
    out[sessionId] = {
      root: rec && typeof rec === 'object' && typeof rec.root === 'string' ? rec.root : '',
      projectId,
      at: rec && typeof rec === 'object' && Number.isFinite(rec.at) ? rec.at : 0,
    };
  }
  return out;
}

async function readBindings() {
  try {
    return normalizeBindings(JSON.parse(await fs.readFile(bindingsPath(), 'utf8')));
  } catch {
    return {};
  }
}

async function writeBindings(map) {
  const file = bindingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  await fs.writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
  await fs.rename(tmp, file);
}
const STATE_FILE = 'project.json';

/** 环境开关：置 1 时所有写路径都必须带租约（默认关，向后兼容）。 */
function leaseEnforcedByEnv() {
  return process.env.DSH_VIDEO_REQUIRE_LEASE === '1';
}

/**
 * 自动领取开关（默认开）。
 *
 * 设成 0 就回到旧行为：写操作没带 leaseId 时只校验会话归属，不领租约 ——
 * 也就是「并行安全靠自觉」的原样。测试与排障需要这个开关。
 */
function autoLeaseEnabled() {
  return process.env.DSH_VIDEO_AUTO_LEASE !== '0';
}

/** 「并行安全已关闭」的提示文案（旧行为下随每个写结果带出去）。 */
const AUTO_LEASE_OFF_WARNING =
  '并行安全已关闭（DSH_VIDEO_AUTO_LEASE=0）：这次写没有领取租约，只校验了会话归属。' +
  '同一工程的另一个 agent 可能同时改同一片段，后提交的会覆盖先提交的。';

/** 轨道类型；轨道不存在时看本批命令里有没有 `track.add` 声明它。 */
function trackKindOf(doc, trackId, declared) {
  const t = (doc.tracks || []).find((x) => x.id === trackId);
  if (t) return t.kind;
  if (declared && declared.has(String(trackId))) return declared.get(String(trackId));
  return null;
}

/**
 * 一批命令里的「声明」：新建的轨道（带 kind）与新建的片段（带轨道 / 类型）。
 *
 * 为什么需要它：`[track.add a1(audio), clip.insert a1, clip.set_property]`
 * 这条链在 doc 里还没有 a1 和那个片段。只看 doc 会把目标算成「整工程」，
 * 于是自动领取会领 `all`（或拿着 `audio` 去写 `all`）—— 范围判定就错了。
 */
function declsForOps(ops) {
  const declaredTracks = new Map();
  const pendingClips = new Map();
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== 'object') continue;
    if (op.type === 'track.add' && op.trackId) {
      declaredTracks.set(String(op.trackId), String(op.kind || 'video'));
    }
    if (op.type === 'clip.insert' && op.clipId) {
      pendingClips.set(String(op.clipId), {
        type: op.clipType === 'code' ? 'code' : 'media',
        trackId: op.trackId ? String(op.trackId) : '',
      });
    }
  }
  return { declaredTracks, pendingClips };
}

/**
 * 一条命令实际改写哪个「范围」。
 *
 * 判定规则（与 docs/lease.md 的表一致）：
 *   - clip.insert：代码片段 → code；音频轨 → audio；其余 → track:<id>
 *   - clip.* / code_layer.*：代码片段 → code；音频轨 → audio；其余 → clip:<所在轨>
 *   - track.set_*：那条轨道
 *   - project.* / annotation.* → 整工程
 *   - asset.* → 不单列（素材登记是插入动作的附带效果，跟着片段的范围走）
 *   - track.add → 不单列（只补一条空轨，真正占位的是随后的 clip.insert）
 */
function targetForOp(doc, op, decls) {
  const type = String((op && op.type) || '');
  if (!type) return { type: 'project' };
  if (type === 'project.set_ratio') return { type: 'project' };
  if (type === 'track.add') return null;
  if (type === 'track.set_muted' || type === 'track.set_locked') {
    return op.trackId ? { type: 'track', trackId: String(op.trackId) } : { type: 'project' };
  }
  if (type === 'clip.insert') {
    if (op.clipType === 'code') return { type: 'code' };
    const kind = trackKindOf(doc, op.trackId, decls && decls.declaredTracks);
    if (kind === 'audio') return { type: 'audio' };
    return op.trackId ? { type: 'track', trackId: String(op.trackId) } : { type: 'project' };
  }
  if (type.startsWith('clip.') || type.startsWith('code_layer.')) {
    let clip = (doc.clips || []).find((c) => c.id === op.clipId);
    // 同一批命令里刚插入、还没进 doc 的片段：按插入时的声明算范围
    if (!clip && decls && decls.pendingClips.has(String(op.clipId))) {
      const pending = decls.pendingClips.get(String(op.clipId));
      clip = { type: pending.type, trackId: pending.trackId };
    }
    if (!clip) return { type: 'project' };
    if (clip.type === 'code') return { type: 'code' };
    const kind = trackKindOf(doc, clip.trackId, decls && decls.declaredTracks);
    if (kind === 'audio') return { type: 'audio' };
    const target = clip.trackId ? { type: 'clip', trackId: String(clip.trackId) } : { type: 'project' };
    // 跨轨移动要同时覆盖源轨与目标轨，否则等于「只锁一半」
    if (type === 'clip.move' && op.trackId && op.trackId !== clip.trackId) {
      return [target, { type: 'track', trackId: String(op.trackId) }];
    }
    return target;
  }
  if (type.startsWith('asset.')) return null;
  return { type: 'project' };
}

/** 一组命令涉及的写范围（去重、去掉不单列的动作）。 */
export function targetsForOps(doc, ops) {
  const out = [];
  const seen = new Set();
  const decls = declsForOps(ops);
  for (const op of Array.isArray(ops) ? ops : []) {
    const got = targetForOp(doc, op, decls);
    if (!got) continue;
    for (const t of Array.isArray(got) ? got : [got]) {
      const key = requiredScope(t).raw;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out.length ? out : [{ type: 'project' }];
}

export class ProjectStore {
  constructor() {
    // projectId -> { root, doc, undo: [record], redo: [record], leases: [lease] }
    // record = { transactionId, summary, at, before, after }
    this.projects = new Map();
    this.listeners = new Set();
    this.previews = new Map(); // previewId -> { projectId, baseRevision, doc, diff, targets, createdAt }
    // projectId -> lease[]（进程内存，不落盘：重启即失效是有意的）
    this.leases = new Map();
    // root -> Promise：同一工程的落盘串行化（并行提交时避免两个 tmp 文件互相覆盖）
    this.persistChain = new Map();
  }

  // ------------------------------------------------------------- events ----

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* a broken subscriber must not break a commit */
      }
    }
  }

  // -------------------------------------------------------------- paths ----

  assertInside(root, target) {
    const rel = path.relative(path.resolve(root), path.resolve(target));
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new DomainError('OUTSIDE_PROJECT', `路径越出工程目录: ${target}`);
    }
  }

  stateRoot(root) {
    const dir = path.join(path.resolve(root), STATE_DIR);
    this.assertInside(root, dir);
    return dir;
  }

  // --------------------------------------------------------------- open ----

  async open(root, sessionId) {
    if (!root || !sessionId) throw new DomainError('INVALID_ARG', 'open 需要 root 与 sessionId');
    const dir = this.stateRoot(root);
    const file = path.join(dir, STATE_FILE);
    this.assertInside(root, file);

    let doc = null;
    try {
      doc = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw new DomainError('IO_FAILED', `读取工程失败: ${e.message}`);
    }

    if (doc) {
      if (doc.boundSessionId !== sessionId) {
        throw new DomainError('BOUND_TO_OTHER_SESSION', '该工程绑定在另一个会话上', {
          boundSessionId: doc.boundSessionId,
          sessionId,
        });
      }
      if (this.projects.has(doc.projectId)) return this.projects.get(doc.projectId).doc;
    } else {
      doc = createProject({ sessionId, root: path.resolve(root) });
      await this.persist(doc);
    }

    const entry = { root: path.resolve(root), doc, undo: [], redo: [] };
    try {
      const map = await readBindings();
      map[doc.boundSessionId] = { root: path.resolve(root), projectId: doc.projectId, at: Date.now() };
      await writeBindings(map);
    } catch {
      /* 绑定表写不了不影响打开工程 */
    }
    this.projects.set(doc.projectId, entry);
    this.emit({ type: 'open', projectId: doc.projectId, revision: doc.revision });
    return doc;
  }

  /** 按会话找回上次打开的工程；目录或工程已不存在时返回 null。 */
  async restore(sessionId) {
    const map = await readBindings();
    const rec = map[sessionId];
    if (!rec || !rec.root) return null;
    try {
      const file = path.join(rec.root, STATE_DIR, STATE_FILE);
      const doc = JSON.parse(await fs.readFile(file, 'utf8'));
      if (doc.boundSessionId !== sessionId) return null;
      return await this.open(rec.root, sessionId);
    } catch {
      return null;
    }
  }

  /** 删除工程：从内存与绑定表移除；deleteFiles 时连同工程目录一起删。 */
  async delete(projectId, sessionId, deleteFiles) {
    const entry = this.get(projectId);
    this.assertSession(entry.doc, sessionId);
    const root = entry.root;
    this.projects.delete(projectId);
    // 工程没了，它的租约也必须立刻失效（否则同名 leaseId 会指向一个不存在的工程）
    this.leases.delete(String(projectId));
    try {
      const map = await readBindings();
      for (const [sid, rec] of Object.entries(map)) {
        if (rec && rec.projectId === projectId) delete map[sid];
      }
      await writeBindings(map);
    } catch {
      /* ignore */
    }
    this.emit({ type: 'delete', projectId, revision: entry.doc.revision });
    if (deleteFiles) {
      const target = path.resolve(root);
      if (path.dirname(target) === target) throw new DomainError('INVALID_ARG', '拒绝删除盘符根目录');
      await fs.rm(target, { recursive: true, force: true });
      return { deleted: true, filesDeleted: true, root };
    }
    return { deleted: true, filesDeleted: false, root };
  }

  get(projectId) {
    const p = this.projects.get(projectId);
    if (!p) throw new DomainError('REF_NOT_FOUND', `工程未打开: ${projectId}`);
    return p;
  }

  // ------------------------------------------------------------- leases ----
  //
  // 租约只活在本进程内存里：重启后一条都不剩（这是有意的 —— 重启不该留下幽灵写权限）。
  // 身份校验与能力校验分开：sessionId 是「谁的会话」，leaseId 是「谁此刻有权写哪个范围」。
  // 带 leaseId 的写路径不再校验 sessionId，父会话才能把租约交给子 agent 用。

  /** 该工程当前的租约（先清过期）。 */
  listLeases(projectId) {
    const key = String(projectId);
    const list = this.leases.get(key);
    if (!list || !list.length) return [];
    const { kept, dropped } = pruneExpired(list);
    if (dropped.length) {
      if (kept.length) this.leases.set(key, kept);
      else this.leases.delete(key);
    }
    return kept.slice();
  }

  /** 这个租约 id 属于哪个工程（子 agent 只拿到 leaseId、没拿到 projectId 时用它找）。 */
  projectIdForLease(leaseId) {
    if (!leaseId) return null;
    for (const [projectId, list] of this.leases.entries()) {
      if ((list || []).some((l) => l && l.leaseId === leaseId)) return projectId;
    }
    return null;
  }

  /**
   * 申请写租约。
   *
   * - 同一会话重复申请同一 scope：幂等，返回已有租约（不续期，续期走 touchLease）
   * - 与现有租约范围重叠：抛 LEASE_CONFLICT，details.conflicts 里列出冲突方
   * - 租约是能力而不是会话附属物：这里不校验 sessionId 是否等于工程绑定会话，
   *   否则子 agent 永远无法为自己申请租约（父会话仍可申请后把 leaseId 交下去）
   */
  acquireLease(projectId, sessionId, scope, opts = {}) {
    if (!projectId) throw new DomainError('INVALID_ARG', '获取写租约需要 projectId');
    if (!sessionId) throw new DomainError('INVALID_ARG', '获取写租约需要 sessionId');
    this.get(projectId); // 工程必须已经在本进程打开

    const wanted = scope == null || scope === '' ? opts.scope || 'all' : scope;
    let candidate;
    try {
      candidate = createLease({ projectId, sessionId, scope: wanted, ttlMs: opts.ttlMs, label: opts.label });
    } catch (e) {
      throw new DomainError('INVALID_ARG', (e && e.message) || '无效的写范围');
    }
    // 自动领取的租约打标记：后续同会话的自动写可以「升范围」时回收它们；
    // 显式申请的租约（lease.acquire / lease.ensure / 父会话发下来的）绝不自动回收。
    if (opts.auto === true) candidate.auto = true;

    const list = this.listLeases(projectId);
    const mine = list.find((l) => l.sessionId === String(sessionId) && l.scope === candidate.scope);
    if (mine) return { lease: mine, conflicts: [] };

    const conflicts = findConflicts(list, candidate);
    if (conflicts.length) {
      const who = conflicts
        .map(
          (l) =>
            `${l.scope}（${l.label || '未命名'}，会话 ${String(l.sessionId).slice(0, 8) || '未知'}，租约 ${l.leaseId}）`,
        )
        .join('、');
      throw new DomainError(
        'LEASE_CONFLICT',
        `写租约冲突：申请 ${candidate.scope}，但已持有的 ${who} 与它重叠。等对方 release，或换一个不冲突的范围（不同轨道 / code / audio）。`,
        {
          conflicts: conflicts.map((l) => ({
            leaseId: l.leaseId,
            scope: l.scope,
            label: l.label,
            sessionId: l.sessionId,
            expiresAt: l.expiresAt,
          })),
        },
      );
    }

    this.leases.set(String(projectId), [...list, candidate]);
    return { lease: candidate, conflicts: [] };
  }

  /** 释放租约；不存在或不属于该会话时返回 { released:false }（释放是幂等的）。 */
  releaseLease(projectId, leaseId, sessionId) {
    if (!leaseId) return { released: false };
    const key = String(projectId);
    const list = this.listLeases(projectId);
    const hit = list.find((l) => l && l.leaseId === leaseId);
    if (!hit) return { released: false };
    if (sessionId != null && hit.sessionId !== String(sessionId)) return { released: false };
    const kept = list.filter((l) => l.leaseId !== leaseId);
    if (kept.length) this.leases.set(key, kept);
    else this.leases.delete(key);
    return { released: true };
  }

  /** 续租；租约不存在或已过期返回 null。5 秒内重复 touch 不改变到期时间（见 lease.mjs）。 */
  touchLease(projectId, leaseId) {
    if (!leaseId) return null;
    const list = this.listLeases(projectId);
    const hit = list.find((l) => l && l.leaseId === leaseId);
    if (!hit) return null;
    const next = touchLeaseRecord(hit);
    this.leases.set(
      String(projectId),
      list.map((l) => (l.leaseId === leaseId ? next : l)),
    );
    return next;
  }

  /**
   * 校验「这份租约能不能写这个目标」。
   * 失败抛 DomainError，code 直接透传 lease.mjs 的判定（LEASE_NOT_FOUND / LEASE_EXPIRED /
   * LEASE_PROJECT_MISMATCH / LEASE_SCOPE / LEASE_REQUIRED）。
   */
  assertLease(projectId, leaseId, target, now = Date.now()) {
    const need = requiredScope(target || { type: 'project' });
    // 这里刻意不 prune：留着过期租约，才能把「过期」和「不存在」区分开
    // （validateWrite 会回 LEASE_EXPIRED；listLeases 才会把它们清掉）。
    let leases = this.leases.get(String(projectId)) || [];
    // 本工程里没有这条租约时，再去别的工程找一遍 —— 找到就交给 validateWrite
    // 判成 LEASE_PROJECT_MISMATCH（而不是笼统的 LEASE_NOT_FOUND）。
    if (leaseId && !leases.some((l) => l && l.leaseId === leaseId)) {
      for (const list of this.leases.values()) {
        const hit = (list || []).find((l) => l && l.leaseId === leaseId);
        if (hit) {
          leases = [...leases, hit];
          break;
        }
      }
    }
    const verdict = validateWrite({
      leases,
      leaseId,
      projectId,
      target,
      now,
    });
    if (!verdict.ok) {
      throw new DomainError(verdict.code, verdict.reason, {
        leaseId: leaseId || null,
        target: need.raw,
        conflicts: verdict.conflicts || null,
      });
    }
    return verdict.lease;
  }

  /**
   * 写路径统一闸门（工具层与内部写函数共用）。
   *
   * 优先级：
   *   1. 带 leaseId → 必须通过租约校验（此时不校验 sessionId，支持父→子交接）
   *   2. 没带 leaseId 且 DSH_VIDEO_REQUIRE_LEASE=1 → LEASE_REQUIRED
   *   3. 没带 leaseId 但有 sessionId → 旧路径 assertSession
   *   4. 都没有 → LEASE_REQUIRED
   */
  assertWriteAccess(projectId, { sessionId, leaseId, target } = {}) {
    const entry = this.get(projectId);
    const targets = Array.isArray(target) ? target : [target || { type: 'project' }];

    if (leaseId) {
      let lease = null;
      for (const t of targets) lease = this.assertLease(projectId, leaseId, t);
      return lease;
    }

    const need = requiredScope(targets[0]);
    if (leaseEnforcedByEnv()) {
      throw new DomainError(
        'LEASE_REQUIRED',
        `写操作需要写租约（本次目标需要 ${need.raw}）。先调用 lease.acquire 取得租约，或由父会话把 leaseId 传进来。`,
      );
    }
    if (sessionId) {
      this.assertSession(entry.doc, sessionId);
      return null;
    }
    throw new DomainError(
      'LEASE_REQUIRED',
      `写操作需要写租约（本次目标需要 ${need.raw}）。先调用 lease.acquire 取得租约。`,
    );
  }

  /**
   * 写路径统一入口（工具层与 RPC 共用）—— 并行安全不再靠调用方自觉。
   *
   * 行为矩阵（AUTO = DSH_VIDEO_AUTO_LEASE !== '0'，默认开；REQUIRE = DSH_VIDEO_REQUIRE_LEASE === '1'）：
   *
   *   | leaseId | AUTO | REQUIRE | 结果 |
   *   |---|---|---|---|
   *   | 有 | 任意 | 任意 | 照旧 assertLease；过期且 AUTO 时按原 scope 重领一条 |
   *   | 无 | 开 | 任意 | 按 target/ops 推出 scope，对本会话 acquire；成功即放行 |
   *   | 无 | 关 | 开 | LEASE_REQUIRED |
   *   | 无 | 关 | 关 | 旧 assertSession，返回里带 warning |
   *
   * 冲突（别人占着同一范围）一律抛 LEASE_CONFLICT，绝不降级放行。
   * 唯一会「动到自己」的情况：本会话已持有一条重叠但更窄的租约（如拿着 track:v1
   * 却要写整工程），这时先释放自己那条再领宽的 —— 否则单人流程会自己挡自己。
   * 别人的租约一个字节都不碰。
   *
   * @param {{projectId:string, sessionId?:string, leaseId?:string, target?:object|object[],
   *          ops?:object[], label?:string, scope?:string}} input
   * @returns {{lease:object|null, leases:object[], acquired:boolean, reused:boolean,
   *            renewed?:boolean, legacy?:boolean, warning?:string, superseded?:string[],
   *            scope:string, targets:object[], needed:string[]}}
   */
  ensureWriteAccess(input, extra) {
    // 两种调用姿势都支持：ensureWriteAccess({...}) 与 ensureWriteAccess(projectId, {...})
    const req =
      input && typeof input === 'object' && !Array.isArray(input)
        ? { ...input }
        : { ...(extra || {}), projectId: input };
    const entry = this.get(req.projectId);
    const projectId = entry.doc.projectId;
    const sessionId = req.sessionId == null || req.sessionId === '' ? '' : String(req.sessionId);
    const leaseId = req.leaseId == null || req.leaseId === '' ? '' : String(req.leaseId);

    // 目标：显式 target > 由 ops 推导 > 整工程
    const targets = this.writeTargets(entry.doc, req);
    const needs = [];
    const seen = new Set();
    for (const t of targets) {
      const need = requiredScope(t);
      if (seen.has(need.raw)) continue;
      seen.add(need.raw);
      needs.push(need);
    }
    const scopeLabel = needs.map((n) => n.raw).join('+');
    const base = { targets, needed: needs.map((n) => n.raw) };

    // 1) 显式租约：照旧校验，不自动领取（过期时允许按原 scope 重领）
    if (leaseId) {
      try {
        let lease = null;
        for (const t of targets) lease = this.assertLease(projectId, leaseId, t);
        return { ...base, lease, leases: lease ? [lease] : [], acquired: false, reused: true, scope: lease ? lease.scope : scopeLabel };
      } catch (e) {
        const stale = this.findLeaseAnywhere(leaseId);
        const renewable =
          e &&
          e.code === 'LEASE_EXPIRED' &&
          autoLeaseEnabled() &&
          stale &&
          needs.every((n) => scopeCovers(stale.scope, n));
        if (!renewable) throw e;
        // 原持有会话、原 scope 重领一条；期间被别人拿走就抛 LEASE_CONFLICT（不降级）
        const got = this.acquireLease(stale.projectId, stale.sessionId, stale.scope, {
          label: req.label || stale.label || undefined,
          auto: true,
        });
        for (const t of targets) this.assertLease(stale.projectId, got.lease.leaseId, t);
        return {
          ...base,
          lease: got.lease,
          leases: [got.lease],
          acquired: true,
          reused: false,
          renewed: true,
          staleLeaseId: leaseId,
          scope: got.lease.scope,
        };
      }
    }

    // 2) 关掉自动领取 → 回到旧行为（默认不开这条路）
    if (!autoLeaseEnabled()) {
      if (leaseEnforcedByEnv()) {
        throw new DomainError(
          'LEASE_REQUIRED',
          `写操作需要写租约（本次目标需要 ${scopeLabel}）。DSH_VIDEO_AUTO_LEASE=0 已关闭自动领取，` +
            '请先调用 lease.acquire，或由父会话把 leaseId 传进来。',
        );
      }
      if (sessionId) {
        this.assertSession(entry.doc, sessionId);
        return {
          ...base,
          lease: null,
          leases: [],
          acquired: false,
          reused: false,
          legacy: true,
          scope: scopeLabel,
          warning: AUTO_LEASE_OFF_WARNING,
        };
      }
      throw new DomainError(
        'LEASE_REQUIRED',
        `写操作需要写租约（本次目标需要 ${scopeLabel}），但这次调用既没有 leaseId 也没有 sessionId。` +
          '先调用 lease.acquire，或由父会话把 leaseId 传进来。',
      );
    }

    // 3) 自动领取
    if (!sessionId) {
      throw new DomainError(
        'LEASE_REQUIRED',
        `写操作需要写租约（本次目标需要 ${scopeLabel}），但这次调用既没有 leaseId 也没有 sessionId，无法自动领取。` +
          '请带 leaseId，或让调用方带上会话身份。',
      );
    }
    const collected = [];
    const superseded = [];
    let acquired = false;
    for (const need of needs) {
      const list = this.listLeases(projectId);
      // 本会话已持有能覆盖这条需求的租约 → 直接复用（连续调用不会重复 acquire）
      const have = list.find((l) => l && l.sessionId === sessionId && scopeCovers(l.scope, need));
      if (have) {
        collected.push(have);
        continue;
      }
      // 先做「不回收任何东西」的冲突预检：有别人的 / 显式的租约挡着，就照标准文案抛
      // LEASE_CONFLICT（此时一个字节都没动，失败不留半截状态）。
      const blockers = list.filter(
        (l) => l && scopesOverlap(l.scope, need.raw) && !(l.sessionId === sessionId && l.auto === true),
      );
      if (blockers.length) {
        this.acquireLease(projectId, sessionId, need.raw, {
          label: req.label ? String(req.label) : undefined,
          auto: true,
        });
      }
      // 只剩「自己挡自己」的自动租约 → 回收后再领；显式租约一个都不碰
      for (const own of list) {
        if (!own || own.sessionId !== sessionId || own.auto !== true) continue;
        if (!scopesOverlap(own.scope, need.raw)) continue;
        this.releaseLease(projectId, own.leaseId, sessionId);
        superseded.push(own.leaseId);
      }
      const got = this.acquireLease(projectId, sessionId, need.raw, {
        label: req.label ? String(req.label) : undefined,
        auto: true,
      });
      collected.push(got.lease);
      acquired = true;
    }

    // 防御：每条需求都必须被某条租约覆盖（正常路径下不会走到这里）
    for (const need of needs) {
      if (collected.some((l) => scopeCovers(l.scope, need))) continue;
      throw new DomainError('LEASE_SCOPE', `自动领取后仍没有覆盖 ${need.raw} 的租约`, {
        needed: needs.map((n) => n.raw),
        leases: collected.map((l) => ({ leaseId: l.leaseId, scope: l.scope })),
      });
    }

    return {
      ...base,
      lease: collected[0] || null,
      leases: collected,
      acquired,
      reused: !acquired,
      ...(superseded.length ? { superseded } : {}),
      scope: collected.length === 1 ? collected[0].scope : scopeLabel,
    };
  }

  /** 由 target / ops 推出写范围；都没有时按整工程算（保守）。 */
  writeTargets(doc, req) {
    const raw = req.target;
    if (Array.isArray(raw) && raw.length) return raw.slice();
    if (raw && typeof raw === 'object') return [raw];
    if (Array.isArray(req.ops) && req.ops.length) return targetsForOps(doc, req.ops);
    return [{ type: 'project' }];
  }

  /** 把 ensureWriteAccess 的结果压成返回体能带的几个字段（工具 / RPC 共用）。 */
  writeAccessInfo(guard) {
    if (!guard) return {};
    const lease = guard.lease;
    const info = {
      leaseId: lease ? lease.leaseId : null,
      lease: lease
        ? {
            leaseId: lease.leaseId,
            scope: lease.scope,
            label: lease.label || '',
            sessionId: lease.sessionId,
            expiresAt: lease.expiresAt,
            remainingMs: Math.max(0, lease.expiresAt - Date.now()),
            human: describeLease(lease),
          }
        : null,
      leaseScope: guard.scope || null,
      leaseAcquired: Boolean(guard.acquired),
    };
    if (guard.renewed) info.leaseRenewed = true;
    if (guard.superseded && guard.superseded.length) info.leaseSuperseded = guard.superseded;
    if (guard.warning) info.warning = guard.warning;
    return info;
  }

  /**
   * 写类操作的「落点」三件套：projectId / root / revision。
   *
   * 报告里第 2.1 条就是「我按 A 理解、实际写进 B」——preview 返回里没有落点，
   * 并发多工程时只能靠猜。所有写类工具的返回都必须同时带这三样。
   */
  writeSite(doc) {
    return {
      projectId: doc.projectId,
      root: doc.root,
      revision: doc.revision,
    };
  }

  /**
   * REVISION_CONFLICT 的诊断包。
   *
   * 原来只说「工程已被修改，请重新读取」—— agent 不知道是谁改的、改了什么，
   * 只能重取再试。现在带上最后一笔事务的 id 与来源，agent 才能决定重取还是放弃。
   */
  revisionDiagnostics(entry, baseRevision, label) {
    const top = entry.undo && entry.undo.length ? entry.undo[entry.undo.length - 1] : null;
    return {
      expected: baseRevision == null ? null : baseRevision,
      actual: entry.doc.revision,
      lastTransactionId: top ? top.transactionId : null,
      lastActor: top ? top.origin || 'unknown' : null,
      lastSummary: top ? top.summary || '' : '',
      hint: top
        ? `工程在 r${baseRevision == null ? '?' : baseRevision} 之后被改过一次（${top.transactionId} · ${top.origin || 'unknown'}${top.summary ? ' · ' + top.summary : ''}），现在是 r${entry.doc.revision}。重新 video_timeline_inspect 拿新 revision 再 preview。`
        : `工程现在是 r${entry.doc.revision}，你手上是 r${baseRevision == null ? '?' : baseRevision}。重新读一次再 preview。`,
      op: label || null,
    };
  }

  /**
   * 便利方法：为某个 scope 保证本会话持有租约（幂等）。
   * 面板 / 外部脚本在写之前先调它；已经覆盖就直接复用，不会新增第二条。
   */
  ensureLease(projectId, sessionId, scope, opts = {}) {
    if (!projectId) throw new DomainError('INVALID_ARG', 'lease.ensure 需要 projectId');
    if (!sessionId) throw new DomainError('INVALID_ARG', 'lease.ensure 需要 sessionId');
    this.get(projectId);
    const want = parseScope(scope == null || scope === '' ? 'all' : scope);
    const list = this.listLeases(projectId);
    const have = list.find((l) => l && l.sessionId === String(sessionId) && scopeCovers(l.scope, want));
    if (have) return { lease: have, acquired: false, reused: true };
    for (const own of list) {
      if (!own || own.sessionId !== String(sessionId) || own.auto !== true) continue;
      if (!scopesOverlap(own.scope, want.raw)) continue;
      this.releaseLease(projectId, own.leaseId, sessionId);
    }
    const got = this.acquireLease(projectId, String(sessionId), want.raw, {
      ttlMs: opts.ttlMs,
      label: opts.label,
    });
    return { lease: got.lease, acquired: true, reused: false };
  }

  /** 任意工程里找一条租约记录（含已过期的；用来分辨「过期」和「不存在」）。 */
  findLeaseAnywhere(leaseId) {
    if (!leaseId) return null;
    for (const list of this.leases.values()) {
      const hit = (list || []).find((l) => l && l.leaseId === leaseId);
      if (hit) return hit;
    }
    return null;
  }

  /** 预览记录里记住的写范围（apply 只拿得到 previewId，靠它校验租约）。 */
  previewTargets(previewId) {
    const p = this.previews.get(previewId);
    if (!p) throw new DomainError('REF_NOT_FOUND', `预览不存在或已过期: ${previewId}`);
    return {
      projectId: p.projectId,
      targets: Array.isArray(p.targets) && p.targets.length ? p.targets.slice() : [{ type: 'project' }],
      baseRevision: p.baseRevision,
    };
  }

  /**
   * 写工具 / RPC 解析工程：**不做会话校验**，鉴权一律交给 ensureWriteAccess。
   *
   * 顺序：projectId > leaseId（按租约反查工程）> 会话绑定的工程。
   * 这样 teammate 用自己的会话 + projectId 也能进来（后续自动领租约），
   * 而关掉自动领取时 ensureWriteAccess 会回落到 assertSession。
   */
  writeEntry(projectId, sessionId, leaseId) {
    if (projectId) return this.get(projectId);
    if (leaseId) {
      const pid = this.projectIdForLease(leaseId) || (this.findLeaseAnywhere(leaseId) || {}).projectId;
      if (!pid) throw new DomainError('LEASE_NOT_FOUND', `租约不存在或已被释放：${leaseId}`, { leaseId });
      return this.get(pid);
    }
    if (sessionId) {
      const hit = [...this.projects.values()].find((p) => p.doc.boundSessionId === String(sessionId));
      if (hit) return hit;
    }
    throw new DomainError('REF_NOT_FOUND', '当前会话还没有打开工程，先调用 video_project_open');
  }

  /**
   * 写工具解析工程。
   * 带 leaseId 时以租约找工程、且不校验会话（租约就是能力）；否则沿用旧的会话归属。
   */
  writableProject(projectId, sessionId, leaseId) {
    if (leaseId) {
      const pid = projectId || this.projectIdForLease(leaseId);
      if (!pid) throw new DomainError('LEASE_NOT_FOUND', `租约不存在或已被释放：${leaseId}`, { leaseId });
      return this.get(pid).doc;
    }
    if (projectId) {
      const entry = this.get(projectId);
      this.assertSession(entry.doc, sessionId);
      return entry.doc;
    }
    const hit = [...this.projects.values()].find((p) => p.doc.boundSessionId === sessionId);
    if (!hit) throw new DomainError('REF_NOT_FOUND', '当前会话还没有打开工程，先调用 video_project_open');
    return hit.doc;
  }

  // ----------------------------------------------------------- binding ----

  /** 这个会话此刻绑定的工程（只读，不改任何东西）。 */
  async bindingOf(sessionId) {
    const map = await readBindings();
    const rec = map[sessionId];
    if (!rec) return null;
    return { projectId: rec.projectId, root: rec.root || '' };
  }

  /**
   * 本进程里属于这个会话的工程。
   *
   * 「一个会话只绑一个工程」说的是绑定表；同一个会话在一次进程里打开过多个
   * 目录时，内存里会同时有几个 doc.boundSessionId === sessionId 的工程 ——
   * 它们就是「切换工程」能列出来的东西。重启后这里只会有一个（绑定表那一个），
   * 因为目录信息只记在绑定表的当前条目里。
   */
  projectsForSession(sessionId) {
    if (!sessionId) throw new DomainError('INVALID_ARG', '列出本会话工程需要 sessionId');
    const out = [];
    for (const entry of this.projects.values()) {
      if (!entry.doc || entry.doc.boundSessionId !== sessionId) continue;
      out.push(this.summarize(entry.doc));
    }
    out.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN'));
    return out;
  }

  /**
   * 从工程目录读「没打开也能显示」的最小卡片信息。
   *
   * 只用 root 去读 `.dsh-video/project.json`：读得到就拿真标题与真 projectId，
   * 读不到（目录没了 / 还没建）就标 missing —— 绝不抛，否则一个脏条目会把整张
   * 列表打成错误页，用户连自己能进的工程都看不见。
   */
  async cardFromRoot(root, base = {}) {
    const out = {
      projectId: base.projectId || '',
      title: base.title || '',
      root: root ? path.resolve(root) : '',
      open: false,
      enabled: !!base.enabled,
      missing: false,
    };
    if (!out.root) {
      out.missing = true;
      return out;
    }
    try {
      const file = path.join(out.root, STATE_DIR, STATE_FILE);
      const doc = JSON.parse(await fs.readFile(file, 'utf8'));
      if (doc && typeof doc.projectId === 'string' && doc.projectId) {
        if (!out.projectId) out.projectId = doc.projectId;
      }
      if (!out.title && doc && typeof doc.title === 'string') out.title = doc.title;
    } catch {
      out.missing = true;
    }
    return out;
  }

  /**
   * 本会话的工程卡片：三处取并集，按 projectId 去重。
   *
   * 为什么不能只用 projectsForSession：它只反映「本进程此刻打开了什么」。
   * 停用（或重启）之后工程从内存里消失，卡片也跟着消失 —— 用户再也找不到自己的
   * 工程。数据其实都还在磁盘上：
   *
   *   1. 内存 —— 已打开的工程，带 doc 摘要（最全，`open:true` 以它为准）；
   *   2. 全局登记表 ~/.dsh/video-enabled.json —— 已登记、但很可能没打开；
   *   3. 绑定表 —— 重启后连登记都没有时，也能靠它把工程找回来。
   *
   * 去重键是 projectId；已打开的那份优先（它有 revision / 轨道 / 片段数）。
   * `enabled` 表示「在全局登记表里」，`open` 表示「本进程已加载」，`missing`
   * 表示目录或工程文件读不到（这种卡片不该给「进入」，只该给「重新定位」的提示）。
   */
  async projectCards(sessionId) {
    if (!sessionId) throw new DomainError('INVALID_ARG', '列出本会话工程需要 sessionId');
    const cards = new Map();

    const enabledList = await listEnabled().catch(() => []);
    const enabledIds = new Set(enabledList.filter((x) => x && x.projectId).map((x) => x.projectId));

    for (const entry of this.projects.values()) {
      if (!entry.doc || entry.doc.boundSessionId !== sessionId) continue;
      const summary = this.summarize(entry.doc);
      cards.set(summary.projectId, Object.assign(summary, {
        projectId: summary.projectId,
        enabled: enabledIds.has(summary.projectId),
        open: true,
        missing: false,
      }));
    }

    // 已登记、但本进程没打开：这一条就是「停用 / 重启后卡片不该消失」的来源
    for (const rec of enabledList) {
      if (!rec || !rec.projectId) continue;
      if (rec.sessionId !== sessionId) continue;
      if (cards.has(rec.projectId)) continue;
      cards.set(rec.projectId, await this.cardFromRoot(rec.root, {
        projectId: rec.projectId,
        title: rec.title,
        enabled: true,
      }));
    }

    // 绑定表里那条：连登记表都没有（停用后重启）时，这是最后的线索
    const bound = await readBindings()
      .then((map) => map[sessionId])
      .catch(() => null);
    if (bound && bound.projectId && !cards.has(bound.projectId)) {
      cards.set(bound.projectId, await this.cardFromRoot(bound.root, {
        projectId: bound.projectId,
        enabled: enabledIds.has(bound.projectId),
      }));
    }

    const out = [...cards.values()];
    out.sort((a, b) => {
      if (!!a.open !== !!b.open) return a.open ? -1 : 1;
      return String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN');
    });
    return out;
  }

  /** 改名：只动标题，不碰时间线、不推进 revision；落盘后返回摘要。 */
  async rename(projectId, sessionId, title) {
    const entry = this.get(projectId);
    this.assertSession(entry.doc, sessionId);
    const next = String(title == null ? '' : title).trim();
    if (!next) throw new DomainError('INVALID_ARG', '工程名不能为空');
    if (Array.from(next).length > 60) throw new DomainError('INVALID_ARG', '工程名最长 60 个字');
    const changed = entry.doc.title !== next;
    entry.doc.title = next;
    await this.persist(entry.doc);
    if (changed) this.emit({ type: 'rename', projectId, revision: entry.doc.revision, title: next });
    return this.summarize(entry.doc);
  }

  /**
   * 换绑：把 sessionId 从「旧工程」改绑到 projectId。
   *
   * 顺序是有原因的：
   *   1. 旧工程若已启用、且占额的正是本会话，先停用 —— 先腾额度（否则自己占着
   *      两个位时换绑会被自己的项目挡住）；
   *   2. 新工程若未启用则启用；失败（额度满）就整体失败，绑定一个字节都不改；
   *   3. 最后才写绑定表。
   *
   * 新版工程必须已经属于本会话（doc.boundSessionId === sessionId）：绑定表是
   * 1:1，把别人的工程改绑过来会让两边的 assertSession 同时失效。
   */
  async rebind(sessionId, projectId) {
    if (!sessionId || !projectId) throw new DomainError('INVALID_ARG', 'rebind 需要 sessionId 与 projectId');
    const entry = this.get(projectId);
    this.assertSession(entry.doc, sessionId);
    const before = await readBindings();
    const oldId = before[sessionId] ? before[sessionId].projectId : null;

    // 1) 旧工程若由本会话启用，先释放它的额度
    let oldReleased = null;
    const enabledList = await listEnabled();
    const oldRec = oldId ? enabledList.find((x) => x.projectId === oldId) : null;
    if (oldRec && oldRec.sessionId === sessionId && oldId !== projectId) {
      await registryDisable(oldId);
      oldReleased = oldRec;
    }

    // 2) 新工程未启用则启用；失败时尽力把旧额度恢复回去，再原样抛错
    if (!(await isEnabled(projectId))) {
      try {
        await registryEnable({
          projectId,
          root: entry.root,
          sessionId,
          title: entry.doc.title,
          origin: 'panel',
        });
      } catch (e) {
        if (oldReleased) {
          try {
            await registryEnable({
              projectId: oldReleased.projectId,
              root: oldReleased.root,
              sessionId: oldReleased.sessionId,
              title: oldReleased.title,
              origin: 'panel',
            });
          } catch {
            /* 恢复失败也不该盖掉原始错误 */
          }
        }
        throw e;
      }
    }

    // 3) 写绑定（一个会话仍然只有一个工程；值仍是记录对象，不是数组）
    const map = await readBindings();
    map[sessionId] = { root: entry.root, projectId, at: Date.now() };
    await writeBindings(map);
    this.emit({ type: 'rebind', projectId, sessionId, previous: oldId || null });
    return { sessionId, projectId, previous: oldId || null, doc: this.summarize(entry.doc) };
  }

  /**
   * 落盘：同一工程串行写。
   *
   * 两个 agent 同时 applyPreview 时，都调用 persist；如果各写各的，两个临时文件会
   * 用同一个名字（都带 pid）互相覆盖，rename 还会 ENOENT。这里按 root 串一条链，
   * 保证「后提交的文档」一定是最后落盘的那一份，且每次 tmp 名唯一。
   */
  async persist(doc) {
    const key = String(doc.root);
    const previous = this.persistChain.get(key) || Promise.resolve();
    const write = previous.then(
      () => this.writeDocFile(doc),
      () => this.writeDocFile(doc),
    );
    const tail = write.then(
      () => {},
      () => {},
    );
    this.persistChain.set(key, tail);
    try {
      return await write;
    } finally {
      if (this.persistChain.get(key) === tail) this.persistChain.delete(key);
    }
  }

  async writeDocFile(doc) {
    const dir = this.stateRoot(doc.root);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, STATE_FILE);
    this.assertInside(doc.root, file);
    const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 10);
    await fs.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  // -------------------------------------------------------- transactions ----

  /**
   * 生成预览（不提交）。
   *
   * 鉴权有两种写法（向后兼容）：
   *   - 传了 leaseId：按 ops 推导出的写范围逐条校验租约，不再校验 sessionId
   *   - 没传 leaseId：走旧的 assertSession；若 DSH_VIDEO_REQUIRE_LEASE=1 则直接 LEASE_REQUIRED
   */
  preview(projectId, sessionId, baseRevision, ops, summary, origin, leaseId) {
    const entry = this.get(projectId);
    const targets = targetsForOps(entry.doc, ops);
    if (leaseId || leaseEnforcedByEnv()) {
      this.assertWriteAccess(projectId, { sessionId, leaseId, target: targets });
    } else {
      this.assertSession(entry.doc, sessionId);
    }
    if (baseRevision != null && baseRevision !== entry.doc.revision) {
      throw new DomainError('REVISION_CONFLICT', '工程已被修改，请重新读取', this.revisionDiagnostics(entry, baseRevision, 'video_edit_preview'));
    }
    const { doc, diff } = applyOps(entry.doc, ops);
    const human = humanDiff(entry.doc, doc, diff);
    const previewId = 'pv_' + Math.random().toString(36).slice(2, 10);
    this.previews.set(previewId, {
      projectId,
      baseRevision: entry.doc.revision,
      doc,
      diff,
      human,
      summary: summary || diff.summary,
      origin: origin || 'ui',
      // 目标范围随预览一起记住：applyPreview 只拿得到 previewId，必须靠它校验租约
      targets,
      createdAt: Date.now(),
    });
    return { previewId, diff, human, revision: entry.doc.revision };
  }

  async applyPreview(previewId, sessionId, leaseId) {
    const p = this.previews.get(previewId);
    if (!p) throw new DomainError('REF_NOT_FOUND', `预览不存在或已过期: ${previewId}`);
    const entry = this.get(p.projectId);
    const targets = Array.isArray(p.targets) && p.targets.length ? p.targets : [{ type: 'project' }];
    if (leaseId || leaseEnforcedByEnv()) {
      this.assertWriteAccess(p.projectId, { sessionId, leaseId, target: targets });
    } else {
      this.assertSession(entry.doc, sessionId);
    }
    if (entry.doc.revision !== p.baseRevision) {
      throw new DomainError('REVISION_CONFLICT', '预览基于旧版本，已作废', this.revisionDiagnostics(entry, p.baseRevision, 'video_edit_apply'));
    }
    const before = entry.doc;
    const after = p.doc;
    entry.doc = after;
    const transactionId = 'tx_' + Math.random().toString(36).slice(2, 10);
    // 新操作提交：入撤销栈，并把 redo 清空（标准行为 —— 分叉之后旧的「重做」不再成立）
    entry.undo.push({
      transactionId,
      summary: p.summary || (p.diff && p.diff.summary) || '',
      at: Date.now(),
      before,
      after,
      // origin 与 summary 一起记：REVISION_CONFLICT 时 agent 才知道「谁改的」
      origin: p.origin || 'ui',
    });
    if (entry.undo.length > UNDO_LIMIT) entry.undo.splice(0, entry.undo.length - UNDO_LIMIT);
    entry.redo.length = 0;
    this.previews.delete(previewId);
    await this.persist(after);
    this.emit({
      type: 'commit',
      projectId: p.projectId,
      revision: after.revision,
      transactionId,
      diff: p.diff,
      human: p.human,
      summary: p.summary,
      origin: p.origin,
      at: Date.now(),
    });
    return { transactionId, revision: after.revision, diff: p.diff, human: p.human };
  }

  /**
   * 撤销最近一步。
   *
   * 只认栈顶：doc.revision 必须正好等于栈顶 after 的 revision，
   * 否则说明有人绕过了事务栈改了文档 —— 宁可拒绝，也不猜该退回哪一版。
   */
  async undoLast(projectId, sessionId) {
    const entry = this.get(projectId);
    this.assertSession(entry.doc, sessionId);
    const rec = entry.undo[entry.undo.length - 1];
    if (!rec) throw new DomainError('REF_NOT_FOUND', '没有可撤销的操作');
    if (entry.doc.revision !== rec.after.revision) {
      throw new DomainError('REVISION_CONFLICT', '这一步之后还有别的修改，无法撤销', {
        current: entry.doc.revision,
        transaction: rec.after.revision,
      });
    }
    entry.doc = rec.before;
    entry.undo.pop();
    entry.redo.push(rec);
    if (entry.redo.length > UNDO_LIMIT) entry.redo.splice(0, entry.redo.length - UNDO_LIMIT);
    await this.persist(entry.doc);
    this.emit({
      type: 'undo',
      projectId,
      revision: entry.doc.revision,
      transactionId: rec.transactionId,
      summary: rec.summary,
    });
    return { revision: entry.doc.revision, transactionId: rec.transactionId, summary: rec.summary };
  }

  /** 重做刚被撤销的那一步（只有撤销过的才可重做）。 */
  async redoLast(projectId, sessionId) {
    const entry = this.get(projectId);
    this.assertSession(entry.doc, sessionId);
    const rec = entry.redo[entry.redo.length - 1];
    if (!rec) throw new DomainError('REF_NOT_FOUND', '没有可重做的操作');
    if (entry.doc.revision !== rec.before.revision) {
      throw new DomainError('REVISION_CONFLICT', '工程在撤销后又改过，这一步不能重做', {
        current: entry.doc.revision,
        transaction: rec.before.revision,
      });
    }
    entry.doc = rec.after;
    entry.redo.pop();
    entry.undo.push(rec);
    if (entry.undo.length > UNDO_LIMIT) entry.undo.splice(0, entry.undo.length - UNDO_LIMIT);
    await this.persist(entry.doc);
    this.emit({
      type: 'redo',
      projectId,
      revision: entry.doc.revision,
      transactionId: rec.transactionId,
      summary: rec.summary,
    });
    return { revision: entry.doc.revision, transactionId: rec.transactionId, summary: rec.summary };
  }

  /**
   * 可撤销历史（新到旧）—— 只给 UI 需要的三列，不把整份文档快照递出去。
   *
   * sessionId 可选：给了就校验归属；不给只做只读列举（供 agent 侧诊断）。
   */
  listUndo(projectId, sessionId) {
    const entry = this.get(projectId);
    if (sessionId != null) this.assertSession(entry.doc, sessionId);
    return entry.undo
      .slice()
      .reverse()
      .map((rec) => ({ transactionId: rec.transactionId, summary: rec.summary, at: rec.at }));
  }

  /** 可重做历史（新到旧）。 */
  listRedo(projectId, sessionId) {
    const entry = this.get(projectId);
    if (sessionId != null) this.assertSession(entry.doc, sessionId);
    return entry.redo
      .slice()
      .reverse()
      .map((rec) => ({ transactionId: rec.transactionId, summary: rec.summary, at: rec.at }));
  }

  /** 撤销 / 重做面板的数据源。 */
  history(projectId, sessionId) {
    const entry = this.get(projectId);
    return {
      projectId,
      revision: entry.doc.revision,
      undo: this.listUndo(projectId, sessionId),
      redo: this.listRedo(projectId, sessionId),
      limit: UNDO_LIMIT,
    };
  }

  /**
   * 按 transactionId 撤销（老接口，保留给「操作记录」面板和既有调用）。
   *
   * 因为 revision 只会单调前进，能通过校验的一定是栈顶 —— 非栈顶直接判冲突，
   * 免得把中间某步抽走后栈里留下对不上的快照。
   */
  async undo(projectId, sessionId, transactionId) {
    const entry = this.get(projectId);
    this.assertSession(entry.doc, sessionId);
    const idx = entry.undo.findIndex((u) => u.transactionId === transactionId);
    if (idx < 0) throw new DomainError('REF_NOT_FOUND', `事务不存在: ${transactionId}`);
    if (idx !== entry.undo.length - 1) {
      throw new DomainError('REVISION_CONFLICT', '该事务之后还有别的修改，无法单步回退', {
        current: entry.doc.revision,
        transaction: entry.undo[idx].after.revision,
      });
    }
    return this.undoLast(projectId, sessionId);
  }

  // -------------------------------------------------------- annotations ----

  /**
   * 删除一条标注。
   *
   * 走的不是「直接从 doc 里 splice」——那样会绕开租约、revision 与撤销栈。
   * 这里和面板上的任何编辑一样：ensureWriteAccess（租约）→ preview（baseRevision）
   * → applyPreview（落盘 + 入撤销栈），所以删除也能撤销、也会广播。
   *
   * 返回被删的那一条（删除后在 doc 里已经找不到，只能删前快照）与剩余数量；
   * 不存在时给可读的 REF_NOT_FOUND，而不是静默成功。
   */
  async removeAnnotation(projectId, sessionId, annotationId, opts = {}) {
    if (!annotationId || typeof annotationId !== 'string') {
      throw new DomainError('INVALID_ARG', 'annotationId 必填');
    }
    const entry = this.get(projectId);
    const guard = this.ensureWriteAccess({
      projectId: entry.doc.projectId,
      sessionId,
      leaseId: opts.leaseId,
      target: { type: 'project' },
      label: opts.label || 'annotation.remove',
    });
    const leaseId = guard.lease ? guard.lease.leaseId : null;
    const removed = (entry.doc.annotations || []).find((a) => a && a.id === annotationId);
    if (!removed) {
      throw new DomainError('REF_NOT_FOUND', `标注不存在: ${annotationId}`, {
        annotationId,
        total: (entry.doc.annotations || []).length,
      });
    }
    const p = this.preview(
      entry.doc.projectId,
      sessionId,
      opts.baseRevision == null ? entry.doc.revision : opts.baseRevision,
      [{ type: 'annotation.delete', annotationId }],
      '删除标注',
      opts.origin || 'ui',
      leaseId,
    );
    const applied = await this.applyPreview(p.previewId, sessionId, leaseId);
    const doc = this.get(entry.doc.projectId).doc;
    const remaining = (doc.annotations || []).length;
    return {
      annotationId,
      removed,
      remaining,
      total: remaining,
      ...applied,
      ...this.writeAccessInfo(guard),
    };
  }

  /**
   * 修改一条标注的文案 / 类型 / 区间 / 状态。
   *
   * 只接受白名单字段；status 只接受 open / applied / rejected（非法状态拒绝，
   * 免得面板里一个手滑就把标注从列表里「消失」）。区间同样要合法：
   * 0 <= start <= end —— 修倒挂标注时由调用方把 end 改成 start，而不是让
   * 一条 end < start 的脏数据继续留在库里。
   */
  async updateAnnotation(projectId, sessionId, annotationId, patch = {}, opts = {}) {
    if (!annotationId || typeof annotationId !== 'string') {
      throw new DomainError('INVALID_ARG', 'annotationId 必填');
    }
    const entry = this.get(projectId);
    const guard = this.ensureWriteAccess({
      projectId: entry.doc.projectId,
      sessionId,
      leaseId: opts.leaseId,
      target: { type: 'project' },
      label: opts.label || 'annotation.update',
    });
    const leaseId = guard.lease ? guard.lease.leaseId : null;
    const current = (entry.doc.annotations || []).find((a) => a && a.id === annotationId);
    if (!current) {
      throw new DomainError('REF_NOT_FOUND', `标注不存在: ${annotationId}`, { annotationId });
    }
    const op = { type: 'annotation.update', annotationId };
    let changed = 0;
    if (patch.expected !== undefined) {
      op.expected = String(patch.expected == null ? '' : patch.expected);
      changed += 1;
    }
    if (patch.intent !== undefined) {
      const intent = String(patch.intent);
      if (!ANNOTATION_INTENTS.includes(intent)) {
        throw new DomainError('INVALID_ARG', `不支持的标注类型：${intent}（只支持 ${ANNOTATION_INTENTS.join(' / ')}）`);
      }
      op.intent = intent;
      changed += 1;
    }
    if (patch.status !== undefined) {
      const status = String(patch.status);
      if (!ANNOTATION_STATUSES.includes(status)) {
        throw new DomainError('INVALID_ARG', `不支持的状态：${status}（只支持 ${ANNOTATION_STATUSES.join(' / ')}）`);
      }
      op.status = status;
      changed += 1;
    }
    if (patch.range !== undefined) {
      const raw = patch.range || {};
      const start = Number(raw.start);
      const end = Number(raw.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
        throw new DomainError('INVALID_ARG', 'range 必须满足 0 <= start <= end');
      }
      op.range = { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
      changed += 1;
    }
    if (!changed) {
      throw new DomainError('INVALID_ARG', '没有要修改的字段（expected / intent / range / status）');
    }
    const p = this.preview(
      entry.doc.projectId,
      sessionId,
      opts.baseRevision == null ? entry.doc.revision : opts.baseRevision,
      [op],
      '更新标注',
      opts.origin || 'ui',
      leaseId,
    );
    const applied = await this.applyPreview(p.previewId, sessionId, leaseId);
    const doc = this.get(entry.doc.projectId).doc;
    return {
      annotationId,
      annotation: (doc.annotations || []).find((a) => a && a.id === annotationId) || null,
      remaining: (doc.annotations || []).length,
      ...applied,
      ...this.writeAccessInfo(guard),
    };
  }

  assertSession(doc, sessionId) {
    if (sessionId !== doc.boundSessionId) {
      throw new DomainError('BOUND_TO_OTHER_SESSION', '工程绑定在另一个会话上', {
        boundSessionId: doc.boundSessionId,
        sessionId,
      });
    }
  }

  // ------------------------------------------------------------- readout ----

  summarize(doc) {
    return {
      projectId: doc.projectId,
      title: doc.title,
      // 客户端「选择面板」要显示工程路径，也要用它去 project.open —— 摘要里必须带 root
      root: doc.root,
      revision: doc.revision,
      boundSessionId: doc.boundSessionId,
      ratio: doc.ratio,
      fps: doc.fps,
      duration: doc.duration,
      tracks: doc.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, clips: t.clips.length })),
      clipCount: doc.clips.length,
      assetCount: doc.assets.length,
      annotationCount: doc.annotations.length,
      openAnnotations: doc.annotations.filter((a) => a.status === 'open').length,
      // 转场与变速也进摘要：agent 用 project.summary 就能确认改动落地了
      transitions: doc.clips
        .filter((c) => c.transition && (c.transition.in || c.transition.out))
        .map((c) => ({
          clipId: c.id,
          trackId: c.trackId,
          in: c.transition.in || null,
          out: c.transition.out || null,
        })),
      speeds: doc.clips
        .filter((c) => (c.speed != null && c.speed !== 1) || (c.speedKeyframes && c.speedKeyframes.length))
        .map((c) => ({
          clipId: c.id,
          trackId: c.trackId,
          speed: c.speed == null ? 1 : c.speed,
          duration: c.duration,
          keyframes: c.speedKeyframes || [],
        })),
      // 成片登记：导出产物必须留在工程里，否则「交付物与工程分家」
      exports: this.exportList(doc),
    };
  }

  /**
   * 给**编辑器客户端**的 doc 视图：摘要 + 完整的 annotations 数组。
   *
   * 为什么不能直接用 summarize：
   *   summarize 只给 annotationCount / openAnnotations 两个数字（agent 侧够用），
   *   而时间线的标注轨和右侧「标注」页读的是 `doc.annotations`。
   *   refresh() 拿到的 doc 一旦缺这个字段，UI 就会把「磁盘上有 3 条」显示成
   *   「标注轨 0 / 还没有标注」—— 用户点了 ＋标注，其实写进去了，界面却说没有。
   *   所以客户端的读路径（open / restore / timeline）统一走这一份视图。
   *
   * 只读：返回的是同一个 doc 的浅引用，调用方不得原地改。
   */
  clientDoc(doc) {
    return {
      ...this.summarize(doc),
      annotations: Array.isArray(doc.annotations) ? doc.annotations : [],
    };
  }

  // ------------------------------------------------------------- exports ----
  //
  // 报告里最后一句最狠：「片子在外面、声音在外面、工程在里面，三者对不上。」
  // 这里就是让片子回到工程里的那条线：导出成功登记一次，扫描能发现没登记的，
  // 收养把它们补进来。登记只存元数据（路径/时长/大小/时间/来源），不复制文件。

  exportList(doc) {
    return (doc && Array.isArray(doc.exports) ? doc.exports : []).map((e) => ({
      path: e.path,
      duration: e.duration == null ? null : e.duration,
      size: e.size == null ? null : e.size,
      at: e.at || null,
      source: e.source || 'workbench',
      // 导出帧率与工程帧率可以不同：两个都记下来，事后能确认「30fps 工程按 60fps 导出」。
      fps: e.fps == null ? null : e.fps,
      sourceFps: e.sourceFps == null ? null : e.sourceFps,
    }));
  }

  /** 相对路径归一：工程内一律存相对 root 的 posix 路径，换机器也不散架。 */
  normalizeExportPath(root, filePath) {
    const abs = path.resolve(root, String(filePath || ''));
    this.assertInside(root, abs);
    const rel = path.relative(path.resolve(root), abs).split(path.sep).join('/');
    return { abs, rel };
  }

  /**
   * 登记一条成片（幂等：同一 path 只保留一条，更新元数据）。
   * 走 persist + revision++，但**不进撤销栈** —— 导出不是时间线改动，
   * 撤销一步剪辑不该把成片记录一起撤掉。
   */
  async recordExport(projectId, entry, options = {}) {
    const e = this.get(projectId);
    const { rel, abs } = this.normalizeExportPath(e.doc.root, entry.path);
    // 先校验再动 doc：非法 fps 不能留下半条记录。
    const fps = normalizeExportFps(entry.fps, 'fps');
    const sourceFps = normalizeExportFps(entry.sourceFps, 'sourceFps');
    const list = Array.isArray(e.doc.exports) ? e.doc.exports.slice() : [];
    const item = {
      path: rel,
      duration: entry.duration == null ? null : Number(entry.duration),
      size: entry.size == null ? null : Number(entry.size),
      at: entry.at || new Date().toISOString(),
      source: entry.source || 'workbench',
      fps,
      sourceFps,
    };
    const index = list.findIndex((x) => x && x.path === rel);
    const created = index < 0;
    if (created) list.push(item);
    else list[index] = { ...list[index], ...item };
    e.doc.exports = list;
    e.doc.revision = Math.round(Number(e.doc.revision) || 0) + 1;
    await this.persist(e.doc);
    this.emit({ type: 'export', projectId, revision: e.doc.revision, path: rel, actor: options.actor || 'unknown' });
    return { created, export: item, path: abs, revision: e.doc.revision };
  }

  listClips(doc, trackId, offset = 0, limit = 50) {
    const all = doc.clips
      .filter((c) => (trackId ? c.trackId === trackId : true))
      .sort((a, b) => a.start - b.start);
    const page = all.slice(offset, offset + Math.min(limit, 100));
    return {
      total: all.length,
      offset,
      limit,
      nextOffset: offset + page.length < all.length ? offset + page.length : null,
      clips: page,
    };
  }
}
