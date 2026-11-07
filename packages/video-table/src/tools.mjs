/**
 * Agent tools. These are plain DSH tool definitions (no MCP): the model calls
 * them, they call the same store the UI calls, so both paths commit through the
 * same command engine, the same invariants and the same undo stack.
 *
 * Every result is deliberately small: ids, revisions, diffs, counts. Media
 * bytes never travel through a tool result.
 */

import { DomainError } from './domain.mjs';
import { readCode, writeCode } from './code-store.mjs';
import { ensureAssetDirs, importFile } from './media.mjs';
import { parseSrt } from './srt.mjs';
import { detectHeadless, engineVersion, renderFramesHeadless } from './headless.mjs';
import { adoptExport, scanExports } from './export-scan.mjs';
import { audioMixReport } from './audio-mix-tool.mjs';
import { MAX_ENABLED, listEnabled } from './enabled-registry.mjs';
// 返回体必须先过清洗：工具层拒收「非无损 JSON」的返回值。
// sample / strip / probe 里 `warnings: ... ? list : undefined` 这种写法一旦出现，
// JSON.stringify 会把键静默丢掉 —— 调用方看到的结构和工具看到的不一样。
import { sanitizeJson } from './json-safe.mjs';
import path from 'node:path';

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

function sessionOf(exec) {
  const id = exec && exec.agent && exec.agent.id;
  if (!id) throw new DomainError('NO_SESSION', '该工具只能在一个会话里调用');
  return id;
}

function projectFor(store, projectId, sessionId, leaseId) {
  // 带租约时按租约找工程、且不校验会话（父会话把 leaseId 交给子 agent 的场景）
  if (leaseId) return store.writableProject(projectId, sessionId, leaseId);
  if (projectId) {
    const entry = store.get(projectId);
    store.assertSession(entry.doc, sessionId);
    return entry.doc;
  }
  const hit = [...store.projects.values()].find((p) => p.doc.boundSessionId === sessionId);
  if (!hit) throw new DomainError('REF_NOT_FOUND', '当前会话还没有打开工程，先调用 video_project_open');
  return hit.doc;
}

/** 本会话绑定的工程（没有就返回 null，不抛 —— probe 需要「没有」也是一个答案）。 */
function projectForSoft(store, projectId, sessionId) {
  try {
    return projectFor(store, projectId, sessionId);
  } catch {
    // 明确给了 projectId 但拿不到权限（别的会话 / 不存在）：一律 null，不泄露摘要
    return null;
  }
}

/** 代码图层源码：无头渲染页不能走 code.read（没有会话），必须随任务下发。 */
async function codeSourcesFor(doc) {
  const out = {};
  for (const clip of doc.clips || []) {
    if (!clip || clip.type !== 'code' || !clip.layerId) continue;
    if (Object.prototype.hasOwnProperty.call(out, clip.layerId)) continue;
    try {
      out[clip.layerId] = await readCode(doc.root, clip.layerId);
    } catch {
      /* 源码缺失：渲染页会记一条 CODE_SOURCE_MISSING，其它图层照常画 */
    }
  }
  return out;
}

/** 写类工具统一附带的落点（projectId + root + revision）。 */
function site(store, doc) {
  return store.writeSite(doc);
}

async function fileExists(file) {
  try {
    const { promises: fsp } = await import('node:fs');
    const stat = await fsp.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

const STRIP_MAX_FRAMES = 60;
const STRIP_MAX_TILE = 8;
const STRIP_MIN_TILE = 1;
const STRIP_MAX_FPS = 30;
const STRIP_MIN_FPS = 0.5;

/** 把 strip 的入参夹紧到可用范围，并把「夹了什么」如实带回去。 */
export function normalizeStripArgs(args, doc) {
  const clamped = [];
  const start = Math.max(0, Number(args.start) || 0);
  const docDuration = Number(doc && doc.duration) > 0 ? Number(doc.duration) : null;
  let end = Number(args.end);
  if (!Number.isFinite(end)) {
    throw new DomainError('INVALID_ARG', 'video_strip 需要 end（秒）');
  }
  if (docDuration != null && end > docDuration) {
    clamped.push({ field: 'end', from: end, to: docDuration, why: '超过工程时长' });
    end = docDuration;
  }
  if (end <= start) throw new DomainError('INVALID_ARG', `end(${end}) 必须大于 start(${start})`);

  let fps = Number(args.fps);
  if (!Number.isFinite(fps) || fps <= 0) fps = 6;
  if (fps > STRIP_MAX_FPS) {
    clamped.push({ field: 'fps', from: fps, to: STRIP_MAX_FPS, why: 'fps 上限' });
    fps = STRIP_MAX_FPS;
  }
  if (fps < STRIP_MIN_FPS) {
    clamped.push({ field: 'fps', from: fps, to: STRIP_MIN_FPS, why: 'fps 下限' });
    fps = STRIP_MIN_FPS;
  }

  let tile = Number(args.tile);
  if (!Number.isFinite(tile)) tile = 4;
  tile = Math.round(tile);
  if (tile > STRIP_MAX_TILE) {
    clamped.push({ field: 'tile', from: tile, to: STRIP_MAX_TILE, why: '网格上限' });
    tile = STRIP_MAX_TILE;
  }
  if (tile < STRIP_MIN_TILE) {
    clamped.push({ field: 'tile', from: tile, to: STRIP_MIN_TILE, why: '网格下限' });
    tile = STRIP_MIN_TILE;
  }

  const wanted = Math.max(1, Math.round((end - start) * fps) + 1);
  const maxByGrid = tile * tile;
  const count = Math.min(wanted, maxByGrid, STRIP_MAX_FRAMES);
  if (count < wanted) {
    clamped.push({ field: 'frames', from: wanted, to: count, why: count === maxByGrid ? '一格最多 tile×tile 帧' : '一次最多 60 帧' });
  }
  const step = count > 1 ? (end - start) / (count - 1) : 0;
  const times = [];
  for (let i = 0; i < count; i += 1) times.push(Math.round((start + step * i) * 1000) / 1000);

  return {
    start,
    end,
    fps,
    tile,
    cols: tile,
    rows: Math.max(1, Math.ceil(count / tile)),
    frames: count,
    times,
    clamped,
  };
}

export function videoTools({ store, samples }) {
  return [
    define(
      'video_project_open',
      '在当前会话里打开（或新建）一个视频工程。目录由用户在工作台里选择；这里只接受绝对路径。工程会绑定到调用它的会话，换会话打开会被拒绝。',
      {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '工程目录的绝对路径' },
        },
        required: ['dir'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const doc = await store.open(args.dir, sessionOf(exec));
        return store.summarize(doc);
      },
    ),

    define(
      'video_audio_mix',
      [
        '只读：列出每条音频片段的 clipId / 素材 / 起止 / 音量 / 静音 / 淡入淡出，并给出「有效峰值估计」，用来判断配乐是否盖住口播。',
        '',
        '峰值来源两条：WAV（PCM/float32）按片段源窗口 + 音量包络真实取样（peakMethod=wav-pcm，最准）；其它格式用 ffmpeg volumedetect 量整段素材再乘 volume（peakMethod=ffmpeg-volumedetect，不含淡入淡出/ducking/归一）。',
        '拿不到就返回 peakStatus=unknown 与 unknownReason，不编数字。effectivePeak 是「片段 × 音量」的估计，不是混音总线峰值；overlaps 里的 approxMarginDb 只表示量级（配乐比口播高多少 dB），不能当实测。',
        '',
        '这个工具不改工程、不占写租约。改音量请用 video_edit_preview 的 clip.setAudio（或 clip.update 别名）。',
      ].join('\n'),
      {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '省略则用当前会话绑定的工程' },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        const doc = projectFor(store, args.projectId, sessionOf(exec));
        return audioMixReport({ store, projectId: doc.projectId });
      },
    ),

    define(
      'video_project_inspect',
      '读取当前会话绑定的视频工程摘要：版本、时长、轨道、片段数、标注数。任何修改前先调用它拿 revision。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '省略则用当前会话绑定的工程' },
        },
        additionalProperties: false,
      },
      async (args, exec) => store.summarize(projectFor(store, args.projectId, sessionOf(exec))),
    ),

    define(
      'video_timeline_inspect',
      '分页读取时间线片段。返回稳定的片段 id、轨道、起止时间与来源信息；不会返回媒体字节。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          trackId: { type: 'string', description: '只看某条轨道' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        const doc = projectFor(store, args.projectId, sessionOf(exec));
        return {
          doc: store.summarize(doc),
          page: store.listClips(doc, args.trackId, args.offset || 0, args.limit || 50),
        };
      },
    ),

    define(
      'video_edit_preview',
      '把一组命令应用到一份临时副本上，返回语义 diff 和 previewId；时间线本身不变。确认无误后再调用 video_edit_apply。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          baseRevision: { type: 'integer', description: '必须与 inspect 拿到的一致，防止覆盖别人的修改' },
          summary: { type: 'string', description: '一句话说明这次改动' },
          leaseId: { type: 'string', description: '写租约 id（lease.acquire 取得）。省略则按会话归属走旧路径' },
          ops: {
            type: 'array',
            description: '命令数组，例如 [{type:"clip.trim",clipId:"c1",start:0,duration:3}]',
            items: { type: 'object' },
          },
        },
        required: ['ops'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const sessionId = sessionOf(exec);
        const entry = store.writeEntry(args.projectId, sessionId, args.leaseId);
        // 没传 leaseId 就按 ops 推导范围自动领取；冲突抛 LEASE_CONFLICT，不降级放行
        const guard = store.ensureWriteAccess({
          projectId: entry.doc.projectId,
          sessionId,
          leaseId: args.leaseId,
          ops: args.ops,
          label: 'video_edit_preview',
        });
        const leaseId = guard.lease ? guard.lease.leaseId : null;
        const value = store.preview(
          entry.doc.projectId,
          sessionId,
          args.baseRevision,
          args.ops,
          args.summary,
          'agent',
          leaseId,
        );
        // 落点三件套：并发多工程时，agent 必须能确认这次预览落在哪个工程上
        return { ...value, ...site(store, entry.doc), ...store.writeAccessInfo(guard) };
      },
    ),

    define(
      'video_edit_apply',
      '应用一个已审阅的 preview（只认 previewId），落地为一次可撤销事务。',
      {
        type: 'object',
        properties: {
          previewId: { type: 'string' },
          leaseId: { type: 'string', description: '写租约 id；省略则按预览记录的目标范围自动领取' },
        },
        required: ['previewId'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const sessionId = sessionOf(exec);
        // apply 只拿得到 previewId：范围要问预览记录（它存了 targets）
        const info = store.previewTargets(args.previewId);
        const guard = store.ensureWriteAccess({
          projectId: info.projectId,
          sessionId,
          leaseId: args.leaseId,
          target: info.targets,
          label: 'video_edit_apply',
        });
        const leaseId = guard.lease ? guard.lease.leaseId : null;
        const applied = await store.applyPreview(args.previewId, sessionId, leaseId);
        return { ...applied, ...site(store, store.get(info.projectId).doc), ...store.writeAccessInfo(guard) };
      },
    ),

    define(
      'video_edit_undo',
      '撤销一个事务；只有它是最后一次修改时才能撤销，否则返回 REVISION_CONFLICT。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          transactionId: { type: 'string' },
        },
        required: ['transactionId'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const sessionId = sessionOf(exec);
        const doc = projectFor(store, args.projectId, sessionId);
        return store.undo(doc.projectId, sessionId, args.transactionId);
      },
    ),

    define(
      'video_annotation_add',
      '在时间线的某个区间上留一条给后续编辑的说明（用户的"这里要改"或 agent 的观察）。标注是工程数据，会被持久化并参与 diff。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          annotationId: { type: 'string', description: '稳定 id，调用方分配' },
          leaseId: { type: 'string', description: '写租约 id（标注属于整工程范围，需要 all 租约）' },
          range: {
            type: 'object',
            properties: { start: { type: 'number' }, end: { type: 'number' } },
            required: ['start', 'end'],
          },
          intent: { type: 'string', enum: ['change', 'issue', 'question', 'note'] },
          expected: { type: 'string', description: '希望怎么改' },
          target: {
            type: 'object',
            description: '{clipId?, sourceTime?}',
            properties: { clipId: { type: 'string' }, sourceTime: { type: 'number' } },
          },
        },
        required: ['annotationId', 'range'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const sessionId = sessionOf(exec);
        const entry = store.writeEntry(args.projectId, sessionId, args.leaseId);
        const guard = store.ensureWriteAccess({
          projectId: entry.doc.projectId,
          sessionId,
          leaseId: args.leaseId,
          target: { type: 'project' },
          label: 'video_annotation_add',
        });
        const leaseId = guard.lease ? guard.lease.leaseId : null;
        const p = store.preview(
          entry.doc.projectId,
          sessionId,
          undefined,
          [
            {
              type: 'annotation.add',
              annotationId: args.annotationId,
              range: args.range,
              target: args.target,
              intent: args.intent,
              expected: args.expected,
              author: 'agent',
            },
          ],
          '新增标注',
          'agent',
          leaseId,
        );
        const applied = await store.applyPreview(p.previewId, sessionId, leaseId);
        return {
          annotationId: args.annotationId,
          ...applied,
          ...site(store, store.get(entry.doc.projectId).doc),
          ...store.writeAccessInfo(guard),
        };
      },
    ),

    /**
     * 删除标注。
     *
     * 删除也走事务：租约（annotation.* 需要整工程 all 租约）→ preview（baseRevision）
     * → applyPreview（落盘、入撤销栈、广播）。所以「删掉之后还能撤销」不是口号。
     * 返回被删的那一条（删前快照）与剩余数量；id 不存在时抛 REF_NOT_FOUND。
     */
    define(
      'video_annotation_remove',
      '删除一条标注（走写租约与 revision，删除可撤销）。返回被删条目与剩余数量；不存在时给可读错误。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          annotationId: { type: 'string', description: '要删除的标注 id' },
          leaseId: { type: 'string', description: '写租约 id（标注属于整工程范围，需要 all 租约）' },
          baseRevision: { type: 'number', description: '可选：调用方手上的 revision；过期会被 REVISION_CONFLICT 拒绝' },
        },
        required: ['annotationId'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const sessionId = sessionOf(exec);
        const entry = store.writeEntry(args.projectId, sessionId, args.leaseId);
        const value = await store.removeAnnotation(entry.doc.projectId, sessionId, args.annotationId, {
          leaseId: args.leaseId,
          baseRevision: args.baseRevision,
          origin: 'agent',
          label: 'video_annotation_remove',
        });
        return {
          annotationId: args.annotationId,
          removed: value.removed,
          remaining: value.remaining,
          total: value.remaining,
          revision: value.revision,
          transactionId: value.transactionId,
          diff: value.diff,
          human: value.human,
          leaseId: value.leaseId || null,
          leaseScope: value.leaseScope || null,
          leaseAcquired: Boolean(value.leaseAcquired),
          ...site(store, store.get(entry.doc.projectId).doc),
        };
      },
    ),

    /**
     * 修改标注：至少给 expected / intent / range / status 之一。
     * 非法状态与倒挂区间在这里被拒（不写进 doc）；同样走租约与 revision。
     */
    define(
      'video_annotation_update',
      '修改一条标注的文案 / 类型 / 区间 / 状态（open / applied / rejected）。走写租约与 revision，非法状态拒绝。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          annotationId: { type: 'string' },
          expected: { type: 'string', description: '新的说明文案' },
          intent: { type: 'string', enum: ['change', 'issue', 'question', 'note'] },
          range: {
            type: 'object',
            properties: { start: { type: 'number' }, end: { type: 'number' } },
            required: ['start', 'end'],
          },
          status: { type: 'string', enum: ['open', 'applied', 'rejected'] },
          leaseId: { type: 'string', description: '写租约 id（需要 all 租约）' },
          baseRevision: { type: 'number', description: '可选：调用方手上的 revision' },
        },
        required: ['annotationId'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const sessionId = sessionOf(exec);
        const entry = store.writeEntry(args.projectId, sessionId, args.leaseId);
        const value = await store.updateAnnotation(
          entry.doc.projectId,
          sessionId,
          args.annotationId,
          {
            expected: args.expected,
            intent: args.intent,
            range: args.range,
            status: args.status,
          },
          {
            leaseId: args.leaseId,
            baseRevision: args.baseRevision,
            origin: 'agent',
            label: 'video_annotation_update',
          },
        );
        return {
          annotationId: args.annotationId,
          annotation: value.annotation,
          remaining: value.remaining,
          revision: value.revision,
          transactionId: value.transactionId,
          diff: value.diff,
          human: value.human,
          leaseId: value.leaseId || null,
          leaseScope: value.leaseScope || null,
          leaseAcquired: Boolean(value.leaseAcquired),
          ...site(store, store.get(entry.doc.projectId).doc),
        };
      },
    ),

    define(
      'video_code_write',
      '写入一个代码图层：一段 JS 模块，导出 render(ctx2d, t, ctx)，必须是 t 的纯函数（可任意 seek、可重放）。写盘后由工作台实时渲染，用户能看见并能标注。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          layerId: { type: 'string', description: '稳定 id（字母数字_-）' },
          source: { type: 'string', description: 'ESM 源码，必须导出 render(ctx2d, t, ctx)' },
          clipId: { type: 'string', description: '更新已存在的代码片段；省略则新建' },
          leaseId: { type: 'string', description: '写租约 id（代码图层需要 code 租约）' },
          start: { type: 'number' },
          duration: { type: 'number' },
          props: { type: 'object' },
        },
        required: ['layerId', 'source'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const sessionId = sessionOf(exec);
        const entry = store.writeEntry(args.projectId, sessionId, args.leaseId);
        const doc = entry.doc;
        const guard = store.ensureWriteAccess({
          projectId: doc.projectId,
          sessionId,
          leaseId: args.leaseId,
          target: { type: 'code' },
          label: 'video_code_write',
        });
        const leaseId = guard.lease ? guard.lease.leaseId : null;
        const { codeHash } = await writeCode(doc.root, args.layerId, args.source);
        const existing = doc.clips.find(
          (c) => c.type === 'code' && (c.id === args.clipId || (!args.clipId && c.layerId === args.layerId)),
        );
        let applied;
        // 新建时真正落进时间线的 clipId：报告 5.1 说返回 null 但实际已插入，
        // 于是 agent 以为没插上、又写一次 —— 这里必须返回真的那个 id。
        let clipId = existing ? existing.id : args.clipId || null;
        if (existing) {
          const p = store.preview(
            doc.projectId,
            sessionId,
            undefined,
            [
              { type: 'code_layer.set_code', clipId: existing.id, codeHash },
              { type: 'code_layer.set_props', clipId: existing.id, props: args.props || {} },
            ],
            '更新代码图层',
            'agent',
            leaseId,
          );
          applied = await store.applyPreview(p.previewId, sessionId, leaseId);
        } else {
          clipId = args.clipId || 'code_' + Math.random().toString(36).slice(2, 8);
          const p = store.preview(
            doc.projectId,
            sessionId,
            undefined,
            [
              {
                type: 'clip.insert',
                clipId,
                trackId: 'c1',
                clipType: 'code',
                layerId: args.layerId,
                codeHash,
                props: args.props || {},
                start: args.start == null ? 0 : args.start,
                duration: args.duration == null ? 5 : args.duration,
              },
            ],
            '新建代码图层',
            'agent',
            leaseId,
          );
          applied = await store.applyPreview(p.previewId, sessionId, leaseId);
        }
        return {
          layerId: args.layerId,
          codeHash,
          clipId,
          trackId: 'c1',
          ...site(store, store.get(doc.projectId).doc),
          ...store.writeAccessInfo(guard),
          hint: '工作台打开时会实时渲染；用 video_edit_preview 调整 start/duration/props，用 video_project_inspect 查状态。',
        };
      },
    ),

    define(
      'video_setup',
      '一次把工程准备好：打开（或新建）工程目录，把磁盘上的视频/音频导入为素材，返回 assetId 列表。后续用 video_edit_preview 把它们插上时间线。',
      {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '工程目录绝对路径；不存在会自动创建 .dsh-video/project.json' },
          files: {
            type: 'array',
            description: '要导入的素材绝对路径（视频/音频/图片）',
            items: { type: 'string' },
          },
        },
        required: ['dir'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const sessionId = sessionOf(exec);
        // 幂等的判据是磁盘：目录里已经有 .dsh-video/project.json，就一定是复用。
        // 绝不在它旁边再建第二个工程 —— 报告里「我按 A 理解、实际写进 B」就是这么来的。
        const existedBefore = await fileExists(path.join(path.resolve(args.dir), '.dsh-video', 'project.json'));
        const doc = await store.open(args.dir, sessionId);
        const reused = existedBefore;
        const imported = [];
        if (Array.isArray(args.files) && args.files.length) {
          await ensureAssetDirs(doc.root);
          const ops = [];
          for (const sourcePath of args.files.slice(0, 40)) {
            try {
              const got = await importFile(doc.root, { sourcePath });
              const assetId = 'asset_' + Math.random().toString(36).slice(2, 10);
              ops.push({
                type: 'asset.add',
                assetId,
                relPath: got.relPath,
                name: got.name,
                size: got.size,
                hash: got.hash,
                mime: got.mime,
              });
              imported.push({ assetId, name: got.name, mime: got.mime });
            } catch (e) {
              imported.push({ name: sourcePath, error: e.code || 'IMPORT_FAILED' });
            }
          }
          if (ops.length) {
            const p = store.preview(doc.projectId, sessionId, undefined, ops, '导入素材');
            await store.applyPreview(p.previewId, sessionId);
          }
        }
        const fresh = store.get(doc.projectId).doc;
        return {
          projectId: doc.projectId,
          root: fresh.root,
          reused,
          revision: fresh.revision,
          assets: fresh.assets.map((a) => ({ id: a.id, name: a.name, mime: a.mime, probe: a.probe })),
          imported,
          hint: reused
            ? '这个目录里已经有一个工程，已复用它（没有新建）。'
            : '工作台打开时会自动探测时长/尺寸；之后用 video_edit_preview 插入片段（duration 用 probe.duration 或先问用户）。',
        };
      },
    ),

    define(
      'video_caption_import',
      '导入 SRT 字幕文本，转成字幕轨上的文字片段（一次事务，可撤销）。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          content: { type: 'string', description: 'SRT 全文' },
          leaseId: { type: 'string', description: '写租约 id（字幕轨需要 track:t1 租约）' },
        },
        required: ['content'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const sessionId = sessionOf(exec);
        const entry = store.writeEntry(args.projectId, sessionId, args.leaseId);
        const guard = store.ensureWriteAccess({
          projectId: entry.doc.projectId,
          sessionId,
          leaseId: args.leaseId,
          target: { type: 'track', trackId: 't1' },
          label: 'video_caption_import',
        });
        const leaseId = guard.lease ? guard.lease.leaseId : null;
        const entries = parseSrt(args.content);
        if (!entries.length) throw new DomainError('INVALID_ARG', '没有解析出任何字幕条目');
        if (entries.length > 500) throw new DomainError('INVALID_ARG', '一次最多 500 条字幕');
        const ops = entries.map((e, i) => ({
          type: 'clip.insert',
          clipId: 'srt_' + Date.now().toString(36) + '_' + i,
          trackId: 't1',
          clipType: 'text',
          start: e.start,
          duration: Math.max(0.2, Math.round((e.end - e.start) * 1000) / 1000),
          text: e.text,
        }));
        const p = store.preview(entry.doc.projectId, sessionId, undefined, ops, '导入 SRT', 'agent', leaseId);
        const applied = await store.applyPreview(p.previewId, sessionId, leaseId);
        return {
          imported: entries.length,
          revision: applied.revision,
          human: applied.human,
          ...site(store, store.get(entry.doc.projectId).doc),
          ...store.writeAccessInfo(guard),
        };
      },
    ),

    define(
      'video_probe',
      '探路：面板开没开、能不能无头渲帧、本会话绑的是哪个工程、全局启用额度用了多少。调视频工具之前先调它，别靠报错文案猜。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '省略则用当前会话绑定的工程（没有就是一个 null 字段，不报错）' },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        const sessionId = sessionOf(exec);
        const doc = projectForSoft(store, args.projectId, sessionId);
        const headless = detectHeadless();
        let enabled = [];
        try {
          enabled = await listEnabled();
        } catch {
          enabled = [];
        }
        const status = samples ? samples.status(doc ? doc.projectId : null) : { live: false, lastPollAt: null, pending: 0 };
        // 面板地址：DSH 的 Web 端口能拿到就拼出来，拿不到就如实 null（不猜）
        let panelUrl = null;
        try {
          const server = exec && exec.ctx && typeof exec.ctx.get === 'function' ? exec.ctx.get('webServer') : null;
          const port = server && (server.port || (server.address && server.address().port));
          if (port) panelUrl = `http://127.0.0.1:${port}`;
        } catch {
          panelUrl = null;
        }
        if (!panelUrl && process.env.DSH_WEB_URL) panelUrl = process.env.DSH_WEB_URL;
        const used = Array.isArray(enabled) ? enabled.filter((e) => e && (e.origin === 'panel' || e.origin == null)).length : 0;
        return sanitizeJson({
          workbenchOpen: Boolean(status.live),
          panelUrl,
          engineVersion: engineVersion(),
          headlessAvailable: Boolean(headless.available),
          headlessBackend: headless.browser ? headless.browser.name : null,
          headlessBackends: headless.backends,
          headlessHint: headless.hint,
          project: doc
            ? { projectId: doc.projectId, root: doc.root, title: doc.title, duration: doc.duration, revision: doc.revision }
            : null,
          enabledQuota: { used, max: MAX_ENABLED },
          sampleBroker: { lastPollAt: status.lastPollAt || null, pending: status.pending || 0 },
          hint: status.live
            ? '面板开着：video_sample 走面板渲染（via=panel）。'
            : headless.available
              ? '面板没开：video_sample 会自动走无头渲染（via=headless），结果与面板同一条渲染核。'
              : '面板没开且本机没有 Chromium 系浏览器：video_sample 会返回 HEADLESS_UNAVAILABLE。装上 Chrome/Edge，或用 DSH_VIDEO_HEADLESS_BROWSER 指过去。',
        });
      },
    ),

    define(
      'video_sample',
      '渲染时间线上的 1–4 个时刻并返回图片文件路径（用 read_image 打开）。面板开着走面板渲染（via=panel），面板没开自动走无头渲染（via=headless）—— 两条路用的是同一份渲染核。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          times: {
            type: 'array',
            description: '时间线秒，1–4 个，必须小于工程时长',
            items: { type: 'number' },
            minItems: 1,
            maxItems: 4,
          },
          maxDim: { type: 'integer', minimum: 256, maximum: 1024 },
        },
        required: ['times'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const sessionId = sessionOf(exec);
        const doc = projectFor(store, args.projectId, sessionId);
        const times = (args.times || []).filter((t) => Number.isFinite(t) && t >= 0).slice(0, 4);
        if (!times.length) throw new DomainError('INVALID_ARG', 'times 不能为空');
        if (doc.duration > 0 && times.some((t) => t >= doc.duration)) {
          throw new DomainError('INVALID_ARG', `times 必须小于工程时长 ${doc.duration}s`);
        }
        const maxDim = args.maxDim || 640;

        // 1) 面板活着 → 优先走面板（语义与历史行为一致）
        if (samples && samples.isLive(doc.projectId)) {
          try {
            const value = await samples.request(doc.projectId, times, maxDim, { timeoutMs: 5000 });
            return sanitizeJson({
              ...value,
              via: 'panel',
              projectId: doc.projectId,
              root: doc.root,
              hint: '用 read_image 打开每个 path 即可看到那一帧。',
            });
          } catch (e) {
            // 面板在轮询但没回帧（卡住/正在导出）：落到无头，而不是让 agent 干等
            if (e && e.code !== 'WORKBENCH_OFFLINE') throw e;
          }
        }

        // 2) 面板没开（或没响应）→ 无头降级，同一套 render()
        const codeSources = await codeSourcesFor(doc);
        const rendered = await renderFramesHeadless({
          root: doc.root,
          doc,
          clips: doc.clips,
          assets: doc.assets,
          times,
          maxDim,
          codeSources,
          timeoutMs: Number(process.env.DSH_VIDEO_HEADLESS_TIMEOUT_MS) || 60000,
        });
        return sanitizeJson({
          requestId: null,
          samples: rendered.frames.map((f) => ({ time: f.time, path: f.path, bytes: f.bytes })),
          via: 'headless',
          backend: rendered.backend,
          projectId: doc.projectId,
          root: doc.root,
          revision: doc.revision,
          width: rendered.engine ? rendered.engine.width : null,
          height: rendered.engine ? rendered.engine.height : null,
          warnings: rendered.errors.length ? rendered.errors : null,
          hint:
            rendered.errors.length
              ? '部分图层没画出来（见 warnings）；图片本身已落盘。用 read_image 打开每个 path。'
              : '用 read_image 打开每个 path 即可看到那一帧。',
        });
      },
    ),

    define(
      'video_strip',
      '一次出一张 contact sheet：把 [start, end] 按 fps 采样、拼成 tile 列的网格 PNG（一格最多 tile×tile 帧、总数 ≤60），用来判节奏（4 张静帧判不出「2.2 秒一镜会不会拖」）。走无头渲染，面板开没开都一样。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          layerId: {
            type: 'string',
            description: '可选：只关心某个代码图层。图仍然是整条时间线的合成（判节奏要看合成结果），这个参数只用来回报该图层的覆盖情况。',
          },
          start: { type: 'number', description: '起始秒' },
          end: { type: 'number', description: '结束秒（超过工程时长会被夹紧）' },
          fps: { type: 'number', description: '采样帧率，默认 6；超过 30 会被夹到 30' },
          tile: { type: 'integer', description: '网格列数，默认 4（范围 1–8）' },
          cellWidth: { type: 'integer', description: '每一格宽度像素，默认 320（160–960）' },
          maxDim: { type: 'integer', description: '每帧渲染上限，默认 640' },
        },
        required: ['start', 'end'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const sessionId = sessionOf(exec);
        const doc = projectFor(store, args.projectId, sessionId);
        let layerInfo = null;
        if (args.layerId) {
          const clip = (doc.clips || []).find((c) => c.type === 'code' && c.layerId === args.layerId);
          if (!clip) throw new DomainError('REF_NOT_FOUND', '代码图层不存在: ' + args.layerId);
          layerInfo = {
            layerId: args.layerId,
            clipId: clip.id,
            range: { start: clip.start, end: clip.start + clip.duration },
            note: '图是整条时间线的合成；这个字段只告诉你该图层覆盖哪一段。',
          };
        }
        const plan = normalizeStripArgs(args, doc);
        let cellWidth = Number(args.cellWidth);
        if (!Number.isFinite(cellWidth)) cellWidth = 320;
        cellWidth = Math.max(160, Math.min(960, Math.round(cellWidth)));
        const codeSources = await codeSourcesFor(doc);
        const rendered = await renderFramesHeadless({
          root: doc.root,
          doc,
          clips: doc.clips,
          assets: doc.assets,
          times: plan.times,
          maxDim: args.maxDim || 640,
          codeSources,
          strip: { tile: plan.tile, cellWidth },
          timeoutMs: Number(process.env.DSH_VIDEO_HEADLESS_TIMEOUT_MS) || 90000,
        });
        return sanitizeJson({
          png: rendered.strip ? rendered.strip.path : null,
          frames: rendered.frames.length,
          times: rendered.frames.map((f) => f.time),
          cols: rendered.strip ? rendered.strip.cols : plan.cols,
          rows: rendered.strip ? rendered.strip.rows : plan.rows,
          width: rendered.strip ? rendered.strip.width : null,
          height: rendered.strip ? rendered.strip.height : null,
          stripBackend: rendered.strip ? rendered.strip.backend : null,
          tile: plan.tile,
          fps: plan.fps,
          layer: layerInfo,
          range: { start: plan.start, end: plan.end },
          clamped: plan.clamped,
          via: 'headless',
          backend: rendered.backend,
          projectId: doc.projectId,
          root: doc.root,
          revision: doc.revision,
          warnings: rendered.errors.length ? rendered.errors : null,
          hint: '用 read_image 打开 png；每格左上角标了该帧在时间线上的秒数。',
        });
      },
    ),

    define(
      'video_export_scan',
      '扫描工程目录下的成片（mp4/mov/m4v/webm，含子目录），标出哪些没登记在 project.exports[] 里（unmanaged:true）。只读，不改工程。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        const doc = projectFor(store, args.projectId, sessionOf(exec));
        const scanned = await scanExports(doc.root, doc);
        return {
          projectId: doc.projectId,
          root: doc.root,
          revision: doc.revision,
          scanned: scanned.scanned,
          registered: scanned.registered,
          unmanagedCount: scanned.unmanaged.length,
          missingFiles: scanned.missingFiles,
          unmanaged: scanned.unmanaged.map((f) => ({
            path: f.path,
            size: f.size,
            duration: f.duration,
            at: f.at,
            unmanaged: true,
          })),
          registeredExports: store.exportList(doc),
          hint: scanned.unmanaged.length
            ? '这些文件不在工程账本里：用 video_export_adopt({path}) 登记（不复制文件）。'
            : '目录里没有未登记的成片。',
        };
      },
    ),

    define(
      'video_export_adopt',
      '把工程目录里一个已存在的成片登记进 project.exports[]（只登记 path+时长+大小，不复制、不移动文件）。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          path: { type: 'string', description: '工程内的相对路径，或工程目录内的绝对路径' },
          duration: { type: 'number', description: '已知时长则直接给，省掉一次 ffprobe' },
          leaseId: { type: 'string', description: '写租约 id（成片账本属于整工程）' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const sessionId = sessionOf(exec);
        const entry = store.writeEntry(args.projectId, sessionId, args.leaseId);
        const guard = store.ensureWriteAccess({
          projectId: entry.doc.projectId,
          sessionId,
          leaseId: args.leaseId,
          target: { type: 'project' },
          label: 'video_export_adopt',
        });
        const adopted = await adoptExport(store, entry.doc, { path: args.path, duration: args.duration });
        const fresh = store.get(entry.doc.projectId).doc;
        return {
          projectId: fresh.projectId,
          root: fresh.root,
          revision: fresh.revision,
          path: adopted.export.path,
          duration: adopted.duration,
          size: adopted.export.size,
          created: adopted.created,
          copied: false,
          probe: adopted.probe,
          probeReason: adopted.probeReason,
          exports: store.exportList(fresh),
          ...store.writeAccessInfo(guard),
        };
      },
    ),

    define(
      'video_annotation_list',
      '列出工程上的标注（可过滤未关闭的），用来读用户"哪里不满意、希望怎么改"。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          status: { type: 'string', enum: ['open', 'applied', 'rejected', 'all'] },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        const doc = projectFor(store, args.projectId, sessionOf(exec));
        const status = args.status || 'all';
        const items = doc.annotations.filter((a) => (status === 'all' ? true : a.status === status));
        return { total: items.length, annotations: items };
      },
    ),
  ];
}
