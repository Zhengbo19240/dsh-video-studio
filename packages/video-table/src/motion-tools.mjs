/**
 * 动效库的 agent 工具。
 *
 * 三个动作：列、取代码、直接插入。
 * 有 code.js 的条目是「原生」：插入即得到一个代码图层，预览与导出同源。
 * 没有 code.js 的条目（例如只有 SKILL.md 的 vibe-motion 素材）会如实拒绝，
 * 而不是假装能渲染。
 */

import { DomainError } from './domain.mjs';
import { writeCode } from './code-store.mjs';
import { listEntries, readEntryCode, readEntryDoc } from './motion-lib.mjs';
import { measureContinuity } from './continuity.mjs';
import { sanitizeJson } from './json-safe.mjs';

const textBlocks = (value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
];

function define(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: { schema: { type: 'object' }, render: (_args, value) => textBlocks(value) },
    execute,
  };
}

function sessionOf(exec) {
  const id = exec && exec.agent && exec.agent.id;
  if (!id) throw new DomainError('NO_SESSION', '该工具只能在一个会话里调用');
  return id;
}

export function motionTools({ store }) {
  return [
    define(
      'video_motion_list',
      '列出动效库里的条目（默认从 ~/.dsh/motion-lib 扫描）。native=true 的条目能直接插入时间线；needRender=true 的只有说明文档，需要外部脚本产出文件。thumb 是缩略图绝对路径（3 帧拼接，1440×270），可以直接用 read_image 看；没有图时为 null，看 thumbReason。',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: '按 id/标题/描述/标签模糊过滤，可省略' },
        },
      },
      async (args) => {
        const entries = await listEntries(args && args.query);
        return {
          count: entries.length,
          entries: entries.map((e) => ({
            id: e.id,
            title: e.title,
            kind: e.kind,
            tags: e.tags,
            native: e.native,
            needRender: e.needRender,
            description: e.description,
            source: e.source,
            license: e.license,
            thumb: e.thumb || null,
            thumbReason: e.thumbReason || null,
          })),
        };
      },
    ),

    define(
      'video_motion_read',
      '读取一个动效条目的实现或说明。有原生实现时返回 code（导出 render(ctx, t, env)）；否则返回 SKILL.md 原文。',
      {
        type: 'object',
        properties: {
          entryId: { type: 'string', description: '条目 id（来自 video_motion_list）' },
        },
        required: ['entryId'],
      },
      async (args) => {
        const code = await readEntryCode(args.entryId);
        if (code) return { entryId: args.entryId, native: true, code };
        const doc = await readEntryDoc(args.entryId);
        if (doc) return { entryId: args.entryId, native: false, doc };
        throw new DomainError('REF_NOT_FOUND', '动效库里没有这个条目: ' + args.entryId);
      },
    ),

    define(
      'video_motion_insert',
      '把一个原生动效作为代码图层插入时间线（一次事务）。条目必须是 native；否则返回 MOTION_NOT_NATIVE 并提示改用外部渲染后导入。',
      {
        type: 'object',
        properties: {
          entryId: { type: 'string', description: '条目 id' },
          projectId: { type: 'string', description: '工程 id，省略时用当前会话绑定的工程' },
          leaseId: { type: 'string', description: '写租约 id（代码图层需要 code 租约）' },
          trackId: { type: 'string', description: '默认 v2（画中画轨），也可 v1' },
          start: { type: 'number', description: '起始秒，默认播放头位置（0）' },
          duration: { type: 'number', description: '默认 3 秒' },
        },
        required: ['entryId'],
      },
      async (args, exec) => {
        const sessionId = sessionOf(exec);
        const entry = store.writeEntry(args.projectId, sessionId, args.leaseId);
        const guard = store.ensureWriteAccess({
          projectId: entry.doc.projectId,
          sessionId,
          leaseId: args.leaseId,
          target: { type: 'code' },
          label: 'video_motion_insert',
        });
        const leaseId = guard.lease ? guard.lease.leaseId : null;

        const code = await readEntryCode(args.entryId);
        if (!code) {
          throw new DomainError('MOTION_NOT_NATIVE', '该动效没有原生实现，需要外部渲染成文件后导入');
        }

        const layerId = 'motion-' + args.entryId;
        const written = await writeCode(entry.root, layerId, code);

        const start = Math.max(0, Number(args.start) || 0);
        const duration = Math.max(0.2, Number(args.duration) || 3);
        const clipId = 'm_' + Date.now().toString(36);
        const trackId = args.trackId || 'v2';
        const ops = [];
        if (!entry.doc.tracks.some((t) => t.id === trackId)) {
          ops.push({ type: 'track.add', trackId, kind: 'video', name: trackId === 'v2' ? '画中画' : trackId });
        }
        ops.push({
          type: 'clip.insert',
          clipId,
          trackId,
          clipType: 'code',
          layerId: written.layerId || layerId,
          start,
          duration,
          provenance: {
            libraryId: 'motion-lib',
            assetId: args.entryId,
            hash: written.codeHash || null,
          },
        });
        const preview = store.preview(entry.doc.projectId, sessionId, undefined, ops, undefined, 'agent', leaseId);
        const applied = await store.applyPreview(preview.previewId, sessionId, leaseId);
        return {
          clipId,
          layerId: written.layerId || layerId,
          revision: applied.revision,
          human: preview.human,
          provenance: { libraryId: 'motion-lib', entryId: args.entryId },
          ...store.writeAccessInfo(guard),
        };
      },
    ),

    define(
      'video_continuity',
      '连续性检查器：按 fps 连续渲 N 帧，算相邻帧像素差与内容包围盒位移，找出「一卡一卡 / 跳变 / 运镜顿」的具体帧。用户说「画面一卡一卡、不丝滑、字跑到另一边去了」时先用它定位，不要靠看几张静帧猜。layerId 给的是动效库里的卡（如 sc-timeline-travel）时按卡片自己的时间轴采样，[start,end) 是卡片内的秒数；只给 projectId 时按工程时间线采样。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '工程 id；省略则用当前会话绑定的工程' },
          layerId: { type: 'string', description: '动效条目 id（如 tc-number-counter）或工程里的代码图层 id' },
          start: { type: 'number', description: '起始秒' },
          end: { type: 'number', description: '结束秒（不含）' },
          fps: { type: 'number', description: '采样帧率，默认 30（1–60）' },
          threshold: { type: 'number', description: '相邻帧 MAD 阈值，默认 0.035（见 src/continuity.mjs 的注释）' },
          maxDim: { type: 'integer', description: '每帧渲染上限，默认 480（160–1024）' },
        },
        required: ['start', 'end'],
        additionalProperties: false,
      },
      async (args, exec) => {
        let projectId = args.projectId || null;
        if (!projectId && store && store.projects) {
          const sessionId = exec && exec.agent && exec.agent.id;
          const hit = [...store.projects.values()].find((p) => p.doc.boundSessionId === sessionId);
          if (hit) projectId = hit.doc.projectId;
        }
        const result = await measureContinuity({
          store,
          projectId,
          layerId: args.layerId,
          start: args.start,
          end: args.end,
          fps: args.fps,
          threshold: args.threshold,
          maxDim: args.maxDim,
        });
        return sanitizeJson({
          ...result,
          hint:
            result.verdict === 'smooth'
              ? '相邻帧没有离群差：这张卡没有跳变。若观感仍「顿」，看 smoothness.velocityJerkP95（越大越顿）与 stationaryRatio（越大越像卡住）。'
              : 'jumps 里每条的 t 就是出问题的那一帧（时间轴秒数）；kind=layout 是内容整体瞬移，opacity 是亮度跳变，camera 是镜头位移突变。',
        });
      },
    ),
  ];
}
