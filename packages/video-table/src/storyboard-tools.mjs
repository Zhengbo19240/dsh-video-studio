/**
 * 分镜相关的 agent 工具。
 *
 * 分三步走，对应三种成熟度：
 *   1. video_storyboard_from_srt —— 只分析：读字幕、给出镜头建议，不落盘。
 *   2. video_storyboard_save / read —— 把分镜写成工程里的 storyboard.json，
 *      从此它是资产：能重读、能被人改、能隔一个会话再接着用。
 *   3. video_storyboard_apply —— 把 storyboard.json 落地成时间线：
 *      一次事务，v1 上按镜铺占位，v2 上补动效，clipId 回写。
 *
 * 为什么占位片段用 text 而不是 code：
 *   - 分镜的每一镜本来就是一句文案，text 片段直接可见、可改、可导出；
 *     player 与导出的文本渲染不看轨道，放在 v1 上照样上屏。
 *   - code 占位要先造一份 JS 图层源码，落地那一刻屏幕上往往还是空的，
 *     用户看到的「占位」反而不可见；而且 v2 已经要放动效代码图层，
 *     v1 再叠一层 code 只会让时间线更难读懂。
 */

import { promises as fs } from 'node:fs';
import { DomainError } from './domain.mjs';
import { parseSrt } from './srt.mjs';
import { buildStoryboard, TEXT_LIMIT } from './storyboard.mjs';
import { readStoryboard, writeStoryboard } from './storyboard-store.mjs';
import { listEntries, readEntryCode } from './motion-lib.mjs';
import { writeCode, codeDir } from './code-store.mjs';

const MAX_SHOTS_HARD = 40;

const textBlocks = (value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
];

function define(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlocks(value),
    },
    execute,
  };
}

function sessionOf(args, exec) {
  // 优先用工具调用真实携带的会话身份；sessionId 参数只在宿主没给身份时兜底
  const id = (exec && exec.agent && exec.agent.id) || (args && args.sessionId);
  if (!id) throw new DomainError('NO_SESSION', '该工具只能在一个会话里调用');
  return id;
}

function projectFor(store, projectId, sessionId) {
  if (projectId) {
    const entry = store.get(projectId);
    store.assertSession(entry.doc, sessionId);
    return entry.doc;
  }
  const hit = [...store.projects.values()].find((p) => p.doc.boundSessionId === sessionId);
  if (!hit) {
    throw new DomainError(
      'REF_NOT_FOUND',
      '当前会话还没有打开工程：要么直接传 srt，要么先调用 video_project_open',
    );
  }
  return hit.doc;
}

/** 和 projectFor 一样，但要的是 entry（root、doc 都在里面）。 */
function entryFor(store, projectId, sessionId, leaseId) {
  if (leaseId) return store.get(store.writableProject(projectId, sessionId, leaseId).projectId);
  if (projectId) {
    const entry = store.get(projectId);
    store.assertSession(entry.doc, sessionId);
    return entry;
  }
  const hit = [...store.projects.values()].find((p) => p.doc.boundSessionId === sessionId);
  if (!hit) throw new DomainError('REF_NOT_FOUND', '当前会话还没有打开工程，先调用 video_project_open');
  return hit;
}

/** 从工程文档里取出字幕片段，合成 cues。 */
function cuesFromProject(doc) {
  const clips = (doc.clips || []).filter(
    (c) => c && (c.type === 'text' || c.clipType === 'text' || c.trackId === 't1'),
  );
  const cues = [];
  for (const clip of clips) {
    const text = String(clip.text || '').trim();
    if (!text) continue;
    const start = Number(clip.start);
    const duration = Number(clip.duration);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) continue;
    cues.push({ start, end: start + duration, text });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/** 文本截到 TEXT_LIMIT 个字符，超出补省略号。 */
function clipText(value) {
  const s = String(value || '');
  const chars = Array.from(s);
  if (chars.length <= TEXT_LIMIT) return s;
  return chars.slice(0, TEXT_LIMIT).join('') + '…';
}

function clampShots(value) {
  const wanted = Number(value);
  if (!Number.isFinite(wanted)) return MAX_SHOTS_HARD;
  return Math.min(MAX_SHOTS_HARD, Math.max(1, Math.floor(wanted)));
}

/**
 * 算出 cues：优先用传进来的 SRT，否则读工程里的字幕轨。
 * 返回 { cues, source }，source 是 'srt' 或 'project'。
 */
function resolveCues(store, doc, args) {
  if (typeof args.srt === 'string' && args.srt.trim()) {
    const cues = parseSrt(args.srt);
    if (!cues.length) throw new DomainError('INVALID_ARG', 'SRT 里没有解析出任何字幕条目');
    return { cues, source: 'srt' };
  }
  const cues = cuesFromProject(doc);
  if (!cues.length) {
    throw new DomainError(
      'INVALID_ARG',
      '当前工程里没有带文字的字幕片段：可以直接传 srt，或先用 video_caption_import 导入',
    );
  }
  return { cues, source: 'project' };
}

function buildShots(cues, maxShots) {
  let board;
  try {
    board = buildStoryboard(cues, { maxShots });
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError('INVALID_ARG', (e && e.message) || '字幕无法切分成镜头');
  }
  return board;
}

// ------------------------------------------------------------------ 落盘 ----

/**
 * 生成分镜并写进 <root>/storyboard.json。
 * 已存在的 clipId 一律清空：重新拆分意味着旧的时间线对应关系作废。
 */
export async function saveStoryboard({ store, projectId, sessionId, srt, maxShots, leaseId }) {
  const entry = store.writeEntry(projectId, sessionId, leaseId);
  const guard = store.ensureWriteAccess({
    projectId: entry.doc.projectId,
    sessionId,
    leaseId,
    target: { type: 'project' },
    label: 'video_storyboard_save',
  });
  const resolvedLeaseId = guard.lease ? guard.lease.leaseId : null;
  let source = 'srt';
  let cues;
  if (typeof srt === 'string' && srt.trim()) {
    cues = parseSrt(srt);
    if (!cues.length) throw new DomainError('INVALID_ARG', 'SRT 里没有解析出任何字幕条目');
  } else {
    cues = cuesFromProject(entry.doc);
    if (!cues.length) {
      throw new DomainError(
        'INVALID_ARG',
        '当前工程里没有带文字的字幕片段：可以直接传 srt，或先用 video_caption_import 导入',
      );
    }
    source = 'project';
  }

  const board = buildShots(cues, clampShots(maxShots));
  const shots = board.shots.map((shot) => ({
    index: shot.index,
    start: shot.start,
    end: shot.end,
    text: shot.text,
    kind: shot.kind,
    suggestedEffect: shot.suggestedEffect,
    reason: shot.reason,
    clipId: null,
  }));

  const written = await writeStoryboard(entry.root, {
    version: 1,
    updatedAt: new Date().toISOString(),
    // 两种来源都是字幕：文档里的 source 只记「分镜从字幕来」，还是人手写的
    source: 'srt',
    shots,
  });

  return {
    saved: true,
    path: written.path,
    count: written.doc.shots.length,
    shots: written.doc.shots.map((shot) => ({ ...shot, text: clipText(shot.text) })),
    from: source,
    warnings: board.warnings.slice(),
    ...store.writeAccessInfo(guard),
    hint: '分镜已落盘：可以用 video_storyboard_apply 落地成时间线，或让用户在工作台右侧面板里改。',
  };
}

/** 读回 storyboard.json；文件不存在时返回默认空文档，不抛。 */
export async function readStoryboardDoc({ store, projectId, sessionId }) {
  const entry = entryFor(store, projectId, sessionId);
  const read = await readStoryboard(entry.root);
  return {
    path: read.path,
    exists: read.exists,
    count: read.doc.shots.length,
    doc: read.doc,
    warning: read.warning,
    hint: read.exists
      ? '这是工程里真正保存着的那一份分镜。'
      : '还没有保存过分镜：先用 video_storyboard_save 生成一份。',
  };
}

// ------------------------------------------------------------------ 落地 ----

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/** 同轨重叠检查：返回第一处冲突，没有则 null。 */
function findOverlap(doc, plans) {
  const byTrack = new Map();
  for (const c of doc.clips || []) {
    const list = byTrack.get(c.trackId) || [];
    list.push({ id: c.id, start: c.start, end: c.start + c.duration });
    byTrack.set(c.trackId, list);
  }
  for (const plan of plans) {
    const list = (byTrack.get(plan.trackId) || []).slice();
    for (const c of list) {
      if (plan.start < c.end - 1e-6 && c.start < plan.end - 1e-6) return { plan, clip: c };
    }
    list.push({ id: plan.clipId, start: plan.start, end: plan.end });
    byTrack.set(plan.trackId, list);
  }
  return null;
}

async function dirExists(p) {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 把 storyboard.json 落地成时间线。
 *
 * 一次事务：所有片段（v1 占位 + v2 动效）在同一个 preview 里提交。
 * 动效源码在 preview 之前写盘（clip 需要 codeHash），apply 失败时把本次新建的
 * 代码目录删掉，避免留下「时间线没变、磁盘多了文件」的半截状态。
 */
export async function applyStoryboard({ store, projectId, sessionId, options = {}, leaseId }) {
  const entry = store.writeEntry(projectId, sessionId, leaseId);
  const doc = entry.doc;
  const guard = store.ensureWriteAccess({
    projectId: doc.projectId,
    sessionId,
    leaseId,
    target: { type: 'project' },
    label: 'video_storyboard_apply',
  });
  const resolvedLeaseId = guard.lease ? guard.lease.leaseId : null;

  const read = await readStoryboard(entry.root);
  const board = read.doc;
  const warnings = [];
  if (read.warning) warnings.push(read.warning);

  if (!board.shots.length) {
    throw new DomainError(
      'INVALID_OP',
      'storyboard.json 里还没有镜头：先调用 video_storyboard_save 生成分镜，再应用',
    );
  }

  const force = !!options.force;
  if (doc.clips.length > 0 && !force) {
    throw new DomainError(
      'INVALID_OP',
      `工程里已经有 ${doc.clips.length} 个片段：请先清空或换新工程；确实要在此基础上追加，请传 force=true`,
    );
  }

  // 占位片段统一用 text：分镜的每一镜本身就是文案，text 立刻能看见、能改、能导出；
  // code 占位要另造一份 JS 源码，落地那一刻屏幕上反而常常是空的，而且 v2 的动效
  // 已经是 code 图层，v1 再叠一层只会让时间线更难读。
  const trackId = options.trackId || 'v1';
  const effectTrackId = options.effectTrackId || 'v2';
  const now = Date.now().toString(36);

  // ---- 1) 先排好每镜的占位片段 -------------------------------------------
  const plans = board.shots.map((shot, i) => ({
    index: shot.index,
    clipId: 'sb_' + shot.index + '_' + now + '_' + i,
    trackId,
    start: shot.start,
    end: shot.end,
    duration: Math.max(0.2, round3(shot.end - shot.start)),
    text: shot.text,
    shot,
  }));

  const overlap = findOverlap(doc, plans);
  if (overlap) {
    const a = overlap.plan;
    const b = overlap.clip;
    throw new DomainError(
      'INVALID_OP',
      `第 ${a.index} 镜要落在 ${round3(a.start)}–${round3(a.end)} 秒，但轨道 ${a.trackId} 上已经有片段 ${b.id}（${round3(b.start)}–${round3(b.end)} 秒）压在那里：请先清空或换新工程`,
    );
  }

  // ---- 2) 动效：复用 motion-lib 的读取逻辑 -------------------------------
  const effectPlans = [];
  const missing = [];
  const layerByEntry = new Map();
  const createdLayers = [];
  const hasEffects = board.shots.some((s) => s.suggestedEffect && s.suggestedEffect !== 'none');

  if (hasEffects) {
    const entries = await listEntries();
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const shot of board.shots) {
      const wanted = shot.suggestedEffect;
      if (!wanted || wanted === 'none') continue;
      const lib = byId.get(wanted);
      if (!lib) {
        missing.push({ index: shot.index, entryId: wanted, why: '动效库里没有这个条目' });
        warnings.push(`第 ${shot.index} 镜建议动效「${wanted}」，但动效库里没有这个条目，已跳过`);
        continue;
      }
      if (!lib.native) {
        missing.push({ index: shot.index, entryId: wanted, why: '条目只有说明文档、没有原生实现' });
        warnings.push(`第 ${shot.index} 镜建议动效「${wanted}」只能外部渲染后导入，未插入代码图层`);
        continue;
      }
      effectPlans.push({
        index: shot.index,
        entryId: wanted,
        layerId: 'motion-' + wanted,
        clipId: 'sbe_' + shot.index + '_' + now,
        start: shot.start,
        duration: Math.max(0.2, round3(shot.end - shot.start)),
      });
    }
    const effOverlap = findOverlap(
      doc,
      effectPlans.map((p) => ({ ...p, trackId: effectTrackId, end: p.start + p.duration })),
    );
    if (effOverlap) {
      throw new DomainError(
        'INVALID_OP',
        `第 ${effOverlap.plan.index} 镜的动效要落在轨道 ${effectTrackId} 的 ${round3(effOverlap.plan.start)} 秒，但那里已有片段 ${effOverlap.clip.id}：请先清空或换新工程`,
      );
    }
  }

  // ---- 3) 写动效源码（先记下哪些目录是这次新建的，失败要能删） ----------
  try {
    for (const plan of effectPlans) {
      if (layerByEntry.has(plan.entryId)) continue;
      const code = await readEntryCode(plan.entryId);
      if (!code) {
        missing.push({ index: plan.index, entryId: plan.entryId, why: '读不到源码' });
        warnings.push(`第 ${plan.index} 镜的动效「${plan.entryId}」读不到源码，已跳过`);
        continue;
      }
      const dir = codeDir(entry.root, plan.layerId);
      const existed = await dirExists(dir);
      const written = await writeCode(entry.root, plan.layerId, code);
      if (!existed) createdLayers.push(dir);
      layerByEntry.set(plan.entryId, written.codeHash || null);
    }
  } catch (e) {
    await cleanupLayers(createdLayers);
    throw e;
  }

  // ---- 4) 拼命令：轨道补齐 → v1 占位 → v2 动效 ---------------------------
  const ops = [];
  const needTracks = new Set([trackId]);
  if (effectPlans.length) needTracks.add(effectTrackId);
  for (const id of needTracks) {
    if (!doc.tracks.some((t) => t.id === id)) {
      ops.push({ type: 'track.add', trackId: id, kind: 'video', name: id === 'v2' ? '画中画' : id });
    }
  }

  for (const plan of plans) {
    ops.push({
      type: 'clip.insert',
      clipId: plan.clipId,
      trackId: plan.trackId,
      clipType: 'text',
      start: plan.start,
      duration: plan.duration,
      text: plan.text,
    });
  }

  for (const plan of effectPlans) {
    ops.push({
      type: 'clip.insert',
      clipId: plan.clipId,
      trackId: effectTrackId,
      clipType: 'code',
      layerId: plan.layerId,
      start: plan.start,
      duration: plan.duration,
      provenance: {
        libraryId: 'motion-lib',
        assetId: plan.entryId,
        hash: layerByEntry.get(plan.entryId) || null,
      },
    });
  }

  // ---- 5) 一次事务 -------------------------------------------------------
  let preview;
  try {
    preview = store.preview(
      doc.projectId,
      sessionId,
      options.baseRevision,
      ops,
      '应用分镜：' + board.shots.length + ' 镜',
      'agent',
      resolvedLeaseId,
    );
  } catch (e) {
    await cleanupLayers(createdLayers);
    throw e;
  }

  let applied;
  try {
    applied = await store.applyPreview(preview.previewId, sessionId, resolvedLeaseId);
  } catch (e) {
    await cleanupLayers(createdLayers);
    throw e;
  }

  // ---- 6) clipId 回写（写盘失败只记 warning，不回滚已提交的时间线） ------
  const nextDoc = {
    ...board,
    updatedAt: new Date().toISOString(),
    shots: board.shots.map((shot) => {
      const plan = plans.find((p) => p.index === shot.index);
      return { ...shot, clipId: plan ? plan.clipId : null };
    }),
  };
  let written = { path: read.path, doc: nextDoc };
  try {
    written = await writeStoryboard(entry.root, nextDoc);
  } catch (e) {
    warnings.push(`时间线已落地，但 clipId 回写 storyboard.json 失败：${(e && e.message) || e}`);
  }

  return {
    applied: true,
    count: board.shots.length,
    path: written.path,
    revision: applied.revision,
    transactionId: applied.transactionId,
    placeholder: 'text',
    effects: effectPlans.map((p) => ({
      shotIndex: p.index,
      entryId: p.entryId,
      layerId: p.layerId,
      clipId: p.clipId,
      start: p.start,
      duration: p.duration,
    })),
    skippedEffects: missing,
    clipIds: plans.map((p) => p.clipId),
    warnings,
    human: applied.human,
    ...store.writeAccessInfo(guard),
    hint: '分镜已落地：v1 是占位文字片段，v2 是对应动效。片段 id 已回写 storyboard.json；不满意可直接 undo 这次事务。',
  };
}

/** 回滚本次新建的代码目录；删不掉也不让 apply 的报错被盖住。 */
async function cleanupLayers(dirs) {
  for (const dir of dirs) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响主流程：时间线没动，多出来的文件下次覆盖即可 */
    }
  }
}

// ------------------------------------------------------------------ 工具 ----

export function storyboardTools({ store }) {
  return [
    define(
      'video_storyboard_from_srt',
      '把 SRT 字幕拆成分镜表。只做分析：不修改工程、不产生事务、不动时间线。可以直接传 SRT 文本，也可以读取当前会话工程里的字幕轨。返回每个镜头的起止时间、文本、类型（hook/point/evidence/transition/outro）、建议动效与理由。要保存成工程资产用 video_storyboard_save。',
      {
        type: 'object',
        properties: {
          srt: { type: 'string', description: 'SRT 全文；省略则读取当前会话工程里的字幕片段' },
          projectId: { type: 'string', description: '工程 id；省略则用当前会话绑定的工程' },
          sessionId: { type: 'string', description: '会话 id；省略则用调用工具的会话' },
          maxShots: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_SHOTS_HARD,
            description: '最多输出几个镜头，默认 40',
          },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        const sessionId = sessionOf(args, exec);
        let cues = null;
        let source = 'srt';

        if (typeof args.srt === 'string' && args.srt.trim()) {
          cues = parseSrt(args.srt);
          if (!cues.length) throw new DomainError('INVALID_ARG', 'SRT 里没有解析出任何字幕条目');
        } else {
          source = 'project';
          const doc = projectFor(store, args.projectId, sessionId);
          cues = cuesFromProject(doc);
          if (!cues.length) {
            throw new DomainError(
              'INVALID_ARG',
              '当前工程里没有带文字的字幕片段：可以直接传 srt，或先用 video_caption_import 导入',
            );
          }
        }

        const board = buildShots(cues, clampShots(args.maxShots));
        const shots = board.shots.map((shot) => ({
          index: shot.index,
          start: shot.start,
          end: shot.end,
          duration: shot.duration,
          text: clipText(shot.text),
          kind: shot.kind,
          suggestedEffect: shot.suggestedEffect,
          reason: shot.reason,
        }));

        return {
          count: shots.length,
          total: board.total,
          shots,
          warnings: board.warnings.slice(),
          source,
          hint: '分镜只是建议：确认后用 video_edit_preview 新建文字/代码片段，才会真正改工程；要存成工程资产用 video_storyboard_save。',
        };
      },
    ),

    define(
      'video_storyboard_save',
      '把分镜写进工程：生成镜头并保存到 <工程目录>/storyboard.json。什么时候用：分镜定下来、要跨会话保留或要让人在工作台里编辑时。会覆盖旧文件并清空旧的 clipId 对应关系；之后用 video_storyboard_apply 落地成时间线。',
      {
        type: 'object',
        properties: {
          srt: { type: 'string', description: 'SRT 全文；省略则读取当前会话工程里的字幕片段' },
          projectId: { type: 'string', description: '工程 id；省略则用当前会话绑定的工程' },
          sessionId: { type: 'string', description: '会话 id；省略则用调用工具的会话' },
          leaseId: { type: 'string', description: '写租约 id（storyboard.json 属于整工程，需要 all 租约）' },
          maxShots: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_SHOTS_HARD,
            description: '最多切几个镜头，默认 40',
          },
        },
        additionalProperties: false,
      },
      async (args, exec) =>
        saveStoryboard({
          store,
          projectId: args.projectId,
          sessionId: sessionOf(args, exec),
          srt: args.srt,
          maxShots: args.maxShots,
          leaseId: args.leaseId,
        }),
    ),

    define(
      'video_storyboard_read',
      '读回工程里保存的分镜（storyboard.json）。什么时候用：接着上一轮的活儿继续干、或要确认镜头与时间线片段的对应关系时。文件不存在时返回默认空文档而不是报错。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '工程 id；省略则用当前会话绑定的工程' },
          sessionId: { type: 'string', description: '会话 id；省略则用调用工具的会话' },
        },
        additionalProperties: false,
      },
      async (args, exec) =>
        readStoryboardDoc({ store, projectId: args.projectId, sessionId: sessionOf(args, exec) }),
    ),

    define(
      'video_storyboard_apply',
      '把保存的分镜落地成时间线（一次事务，可 undo）：按每镜的起止时间在主轨上铺占位片段，v2 上补对应动效代码图层，并把片段 id 回写 storyboard.json。什么时候用：分镜已经确认、要开始按镜头剪的时候。工程里已有片段时默认拒绝，确需追加传 options.force=true。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '工程 id；省略则用当前会话绑定的工程' },
          sessionId: { type: 'string', description: '会话 id；省略则用调用工具的会话' },
          leaseId: { type: 'string', description: '写租约 id（分镜落地会写多条轨道，需要 all 租约）' },
          options: {
            type: 'object',
            description: 'force=true 允许在已有时间线上追加（不重叠才行）；trackId 默认 v1；effectTrackId 默认 v2',
            properties: {
              force: { type: 'boolean' },
              trackId: { type: 'string' },
              effectTrackId: { type: 'string' },
              baseRevision: { type: 'integer' },
            },
          },
        },
        additionalProperties: false,
      },
      async (args, exec) =>
        applyStoryboard({
          store,
          projectId: args.projectId,
          sessionId: sessionOf(args, exec),
          options: args.options || {},
          leaseId: args.leaseId,
        }),
    ),
  ];
}
