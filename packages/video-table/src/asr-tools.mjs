/**
 * 语音转字幕的「业务层」：探测 → 抽音轨 → 转写 → SRT → 可选落时间线。
 *
 * 三条硬规矩：
 *   1. 依赖不全不是异常，是结果：返回 { ready:false, reasons:[中文] }，让 agent 和面板
 *      都能把「缺什么、装到哪」原样念给用户听。
 *   2. 落时间线只走一次事务（store.preview → applyPreview），和手动编辑同一条命令链，
 *      所以能撤销、能 diff。
 *   3. 长任务走 job（asr.transcribe 立刻返回 jobId，asr.progress 轮询），
 *      这样 30 分钟的转写不会把 HTTP 请求吊死。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DomainError } from './domain.mjs';
import { resolveAssetPath } from './media.mjs';
import { asrPaths, asrRoot, detectAsr, describeAsr } from './asr-deps.mjs';
import {
  DEFAULT_LANGUAGE,
  DEFAULT_MODEL,
  SUPPORTED_MODELS,
  extractAudio,
  formatSrt,
  segmentsToClipOps,
  transcribeWithFasterWhisper,
} from './asr.mjs';

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

function maybeSessionOf(exec) {
  try {
    return sessionOf(exec);
  } catch {
    return null;
  }
}

function projectFor(store, projectId, sessionId) {
  if (projectId) {
    const entry = store.get(projectId);
    store.assertSession(entry.doc, sessionId);
    return entry.doc;
  }
  const hit = [...store.projects.values()].find((p) => p.doc.boundSessionId === sessionId);
  if (!hit) throw new DomainError('REF_NOT_FOUND', '当前会话还没有打开工程，先调用 video_project_open');
  return hit.doc;
}

/** 只接受这五个名字；写错模型名会让 faster-whisper 去找一个不存在的仓库，报错很难懂 */
export function normalizeModelSize(value) {
  if (value == null || value === '') return DEFAULT_MODEL;
  const name = String(value).trim();
  if (!SUPPORTED_MODELS.includes(name)) {
    throw new DomainError('INVALID_ARG', `modelSize 只支持 ${SUPPORTED_MODELS.join(' / ')}，收到 ${name}`);
  }
  return name;
}

async function assertReadableFile(target, label) {
  let stat = null;
  try {
    stat = await fs.stat(target);
  } catch (e) {
    const code = e && e.code === 'ENOENT' ? 'REF_NOT_FOUND' : 'INVALID_ARG';
    throw new DomainError(code, `${label}不存在或读不到：${target}`);
  }
  if (!stat.isFile()) throw new DomainError('INVALID_ARG', `${label}不是文件：${target}`);
  return stat;
}

/**
 * 把「素材」解析成磁盘上的绝对路径。
 *
 * assetPath 三种写法都收：工程素材 id、工程内相对路径、磁盘绝对路径。
 * 绝对路径不经过 resolveAssetPath（那是给工程内相对路径用的守卫），改为直接 stat。
 */
export async function resolveAsrInput({ entry, assetPath, assetId }) {
  const doc = entry ? entry.doc : null;
  let abs = '';

  if (assetId) {
    const asset = ((doc && doc.assets) || []).find((a) => a.id === assetId);
    if (!asset) throw new DomainError('REF_NOT_FOUND', '工程里没有这个素材：' + assetId);
    abs = await resolveAssetPath(doc.root, asset.path);
  } else if (assetPath) {
    const asId = ((doc && doc.assets) || []).find((a) => a.id === assetPath);
    if (asId) {
      abs = await resolveAssetPath(doc.root, asId.path);
    } else if (path.isAbsolute(assetPath)) {
      abs = assetPath;
    } else if (doc) {
      abs = await resolveAssetPath(doc.root, assetPath);
    } else {
      throw new DomainError('INVALID_ARG', 'assetPath 需要是绝对路径，或者给出工程内素材 id');
    }
  } else {
    throw new DomainError('INVALID_ARG', '需要 assetPath（绝对路径或工程素材 id）或 assetId');
  }

  await assertReadableFile(abs, '素材');
  return { absolutePath: abs };
}

/** 临时 wav：优先用依赖目录下的 tmp（安装脚本已经建好），没有就落到系统临时目录 */
async function tempWavPath(root) {
  const preferred = path.join(root, 'tmp');
  try {
    const stat = await fs.stat(preferred);
    if (stat.isDirectory()) {
      return path.join(preferred, `asr-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.wav`);
    }
  } catch {
    /* 落到系统临时目录 */
  }
  return path.join(os.tmpdir(), `dsh-asr-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.wav`);
}

/**
 * 把 segments 写成字幕轨片段（一次事务）。
 *
 * 与 video_caption_import 用的是同一套命令：clip.insert + clipType:'text' + t1。
 * 区别只在来源 —— 这里的时间码来自转写，不是解析 SRT。
 */
export async function applySegmentsToTimeline({
  store,
  projectId,
  sessionId,
  segments,
  baseRevision,
  trackId = 't1',
  summary,
  leaseId,
} = {}) {
  if (!projectId) throw new DomainError('INVALID_ARG', '写入时间线需要 projectId');
  if (!sessionId) throw new DomainError('INVALID_ARG', '写入时间线需要 sessionId');
  const ops = segmentsToClipOps(segments, {
    trackId,
    idSeed: Date.now().toString(36),
  });
  if (!ops.length) throw new DomainError('INVALID_ARG', '没有可写入的字幕片段（转写结果为空）');

  const entry = store.get(projectId);
  const guard = store.ensureWriteAccess({
    projectId,
    sessionId,
    leaseId,
    target: { type: 'track', trackId },
    label: 'video_transcribe',
  });
  const resolvedLeaseId = guard.lease ? guard.lease.leaseId : null;
  if (!entry.doc.tracks.some((t) => t.id === trackId)) {
    ops.unshift({ type: 'track.add', trackId, kind: 'text', name: '字幕' });
  }

  const label = summary || `语音转字幕：${ops.length} 条`;
  const preview = store.preview(projectId, sessionId, baseRevision, ops, label, 'asr', resolvedLeaseId);
  const applied = await store.applyPreview(preview.previewId, sessionId, resolvedLeaseId);

  return {
    count: ops.filter((op) => op.type === 'clip.insert').length,
    revision: applied.revision,
    transactionId: applied.transactionId,
    trackId,
    human: applied.human,
    ...store.writeAccessInfo(guard),
  };
}

/**
 * 转写主流程。可被工具（同步等待）和 RPC（后台 job）共用。
 *
 * options.detected 允许调用方复用一次已经做过的探测（面板先 video_asr_status 再转写），
 * 省掉重复起两个子进程。
 */
export async function transcribeAsset({
  store,
  projectId,
  sessionId,
  assetPath,
  assetId,
  modelSize,
  language,
  applyToTimeline = false,
  baseRevision,
  leaseId,
  detected: preread,
  onProgress,
  signal,
} = {}) {
  const model = normalizeModelSize(modelSize);
  const lang = language == null || String(language).trim() === '' ? DEFAULT_LANGUAGE : String(language).trim();
  const root = asrRoot();
  const progress = (patch) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress(patch);
    } catch {
      /* 进度回调不能影响转写 */
    }
  };

  // applyToTimeline 才是写路径：先过租约闸门，不要等转写跑完才被拒。
  let entry = null;
  let guard = null;
  let resolvedLeaseId = leaseId || null;
  if (applyToTimeline) {
    if (!projectId) {
      throw new DomainError('INVALID_ARG', 'applyToTimeline=true 需要 projectId');
    }
    if (!sessionId && !leaseId) {
      throw new DomainError(
        'INVALID_ARG',
        'applyToTimeline=true 需要 sessionId（用来自动领取租约）或 leaseId',
      );
    }
    entry = store.get(projectId);
    guard = store.ensureWriteAccess({
      projectId,
      sessionId,
      leaseId,
      target: { type: 'track', trackId: 't1' },
      label: 'video_transcribe',
    });
    resolvedLeaseId = guard.lease ? guard.lease.leaseId : leaseId || null;
  } else if (projectId) {
    entry = store.get(projectId);
  }

  const detected = preread || (await detectAsr({ root }));
  if (!detected.ready) {
    return {
      ready: false,
      reasons: detected.reasons || ['语音转字幕依赖没有准备好'],
      warnings: detected.warnings || [],
      ffmpeg: detected.ffmpeg,
      python: detected.python,
      whisper: detected.whisper,
      root: detected.root || root,
      modelsDir: detected.modelsDir,
      human: describeAsr(detected),
      hint: '装好依赖后重试；三个部件的路径见 reasons 里的绝对路径。',
      // 依赖缺失时也把已经领到的租约回给调用方（applyToTimeline 时闸门在探测之前就过了）
      ...(guard ? store.writeAccessInfo(guard) : {}),
    };
  }

  if (applyToTimeline && (!projectId || (!sessionId && !leaseId))) {
    throw new DomainError('INVALID_ARG', 'applyToTimeline=true 需要 projectId 与 sessionId（或 leaseId）');
  }

  // 写路径已在上面过闸门；这里只给只读/不落时间线的调用补旧会话校验。
  if (entry && sessionId && !applyToTimeline) store.assertSession(entry.doc, sessionId);

  const input = await resolveAsrInput({ entry, assetPath, assetId });
  const paths = asrPaths(detected.root || root);
  const wavPath = await tempWavPath(detected.root || root);

  try {
    progress({ phase: 'extract', ratio: 0.02, label: '抽取音轨…' });
    await extractAudio(detected.ffmpeg.path, input.absolutePath, wavPath, { signal });

    const backend = detected.whisper && detected.whisper.backend === 'cuda' ? 'cuda' : 'cpu';
    progress({ phase: 'transcribe', ratio: 0.05, done: 0, total: 0, label: '加载模型…' });

    const out = await transcribeWithFasterWhisper({
      pythonPath: detected.python.path,
      modelSize: model,
      audioPath: wavPath,
      language: lang,
      device: backend,
      modelsDir: detected.modelsDir || paths.models,
      signal,
      onProgress: (p) =>
        progress({
          phase: 'transcribe',
          ratio: 0.05 + 0.9 * (p.ratio || 0),
          done: p.done || 0,
          total: p.total || 0,
          label: `转写中 ${p.done || 0}/${p.total || '?'}`,
        }),
    });

    const segments = out.segments || [];
    const srt = formatSrt(segments);
    const warnings = [...(detected.warnings || [])];
    if (!segments.length) warnings.push('没有识别出语音：素材可能是纯音乐、静音，或语言参数不对。');
    if (backend === 'cpu') warnings.push('当前用 CPU 转写，耗时大约是播放时长的 1–2 倍。');

    const result = {
      ready: true,
      srt,
      segments,
      language: out.language || lang,
      duration: out.duration || 0,
      model,
      backend: out.device || backend,
      warnings,
      asset: input.absolutePath,
      human: `转写完成：${segments.length} 条字幕，时长 ${(out.duration || 0).toFixed(1)} 秒，模型 ${model}（${out.device || backend}）`,
    };

    if (applyToTimeline) {
      progress({ phase: 'apply', ratio: 0.98, label: '写入字幕轨…' });
      result.applied = await applySegmentsToTimeline({
        store,
        projectId,
        sessionId,
        segments,
        baseRevision,
        leaseId: resolvedLeaseId,
      });
      // 自动领取的租约 id 一起回给调用方：连续调用可以复用它，不用再领
      if (guard) Object.assign(result, store.writeAccessInfo(guard));
    }

    progress({ phase: 'done', ratio: 1, label: '完成' });
    return result;
  } finally {
    await fs.rm(wavPath, { force: true }).catch(() => {});
  }
}

// ------------------------------------------------------------------ jobs ----

const JOBS = new Map();
let jobSeq = 0;
const JOB_TTL_MS = 60 * 60 * 1000;

/** 起一个后台转写任务；立刻返回 jobId，进度用 asr.progress 轮询 */
export function startAsrJob(params = {}) {
  jobSeq += 1;
  const id = 'asr_' + Date.now().toString(36) + '_' + jobSeq.toString(36);
  const job = {
    id,
    status: 'running',
    phase: 'detect',
    ratio: 0,
    done: 0,
    total: 0,
    label: '检测依赖…',
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
  };
  JOBS.set(id, job);

  const run = async () => {
    try {
      job.result = await transcribeAsset({
        ...params,
        onProgress: (patch) => {
          if (!patch) return;
          if (patch.phase) job.phase = patch.phase;
          if (typeof patch.ratio === 'number') job.ratio = Math.max(0, Math.min(1, patch.ratio));
          if (patch.done != null) job.done = patch.done;
          if (patch.total != null) job.total = patch.total;
          if (patch.label) job.label = patch.label;
        },
      });
      job.status = job.result && job.result.ready ? 'done' : 'not-ready';
      job.ratio = 1;
      job.label = job.result && job.result.ready ? '完成' : '依赖缺失';
    } catch (e) {
      job.status = 'error';
      job.ratio = 1;
      job.error = {
        code: (e && e.code) || 'ASR_FAILED',
        message: (e && e.message) || '转写失败',
        details: (e && e.details) || null,
      };
      job.label = '失败';
    } finally {
      job.finishedAt = Date.now();
    }
  };
  // 不 await：调用方拿 jobId 就走，进度靠轮询
  run();

  const gc = setTimeout(() => JOBS.delete(id), JOB_TTL_MS);
  if (gc && typeof gc.unref === 'function') gc.unref();

  return { jobId: id, status: 'running', startedAt: job.startedAt };
}

/** 查任务进度；结果只在跑完时给（避免每次轮询都拖着整份 SRT 走） */
export function getAsrJob(jobId) {
  const job = JOBS.get(jobId);
  if (!job) throw new DomainError('REF_NOT_FOUND', '转写任务不存在或已过期：' + jobId);
  return {
    jobId: job.id,
    status: job.status,
    phase: job.phase,
    ratio: job.ratio,
    done: job.done,
    total: job.total,
    label: job.label,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.status === 'running' ? null : job.result,
    error: job.error,
  };
}

/** 仅供测试 / 诊断：清空任务表 */
export function clearAsrJobs() {
  JOBS.clear();
}

// ----------------------------------------------------------------- tools ----

function notReadyPayload(detected) {
  return {
    ready: false,
    reasons: detected.reasons || [],
    warnings: detected.warnings || [],
    ffmpeg: detected.ffmpeg,
    python: detected.python,
    whisper: detected.whisper,
    root: detected.root,
    modelsDir: detected.modelsDir,
    human: describeAsr(detected),
    hint: '依赖缺失时不要重试转写：先按 reasons 里的路径装好 ffmpeg / Python venv / faster-whisper。',
  };
}

export function asrTools({ store }) {
  return [
    define(
      'video_asr_status',
      '检查语音转字幕的依赖：ffmpeg / Python venv / faster-whisper / GPU 后端。转写前先调它探路；返回 ready:false 时把 reasons 原样念给用户。',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        const detected = await detectAsr({ root: asrRoot() });
        return detected.ready ? detected : notReadyPayload(detected);
      },
    ),

    define(
      'video_transcribe',
      '把视频/音频转写成字幕：抽 16k 单声道音轨 → faster-whisper → SRT。' +
        '依赖不全时返回 ready:false + reasons（中文，指明缺什么、装到哪），不抛「未知错误」。' +
        'applyToTimeline=true 会把结果写成 t1 字幕轨上的文字片段（一次事务，可撤销）。',
      {
        type: 'object',
        properties: {
          assetPath: {
            type: 'string',
            description: '素材：工程内素材 id、工程内相对路径，或磁盘绝对路径',
          },
          assetId: { type: 'string', description: '工程内素材 id（与 assetPath 二选一）' },
          projectId: { type: 'string', description: '省略则用当前会话绑定的工程' },
          sessionId: { type: 'string', description: '省略则用当前会话' },
          modelSize: {
            type: 'string',
            enum: ['small', 'medium', 'large-v3'],
            description: '默认 medium（实测约 4.6× 实时，显存 2.6-3.6GB，口播/字幕推荐）。small 更快更省显存（约 5.2×、1.2-1.8GB），批量粗筛用；large-v3 最准但 8GB 显存与浏览器争用易 OOM，谨慎用',
          },
          language: { type: 'string', description: '默认 zh（普通话）' },
          applyToTimeline: { type: 'boolean', description: 'true = 直接写入字幕轨（此时需要 track:t1 写租约）' },
          baseRevision: { type: 'integer', description: '写入前校验版本，防止覆盖别人的修改' },
          leaseId: { type: 'string', description: '写租约 id；只有 applyToTimeline:true 时才需要' },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        const sessionId = args.sessionId || maybeSessionOf(exec);
        let projectId = args.projectId || null;
        if (!projectId && sessionId) {
          const hit = [...store.projects.values()].find((p) => p.doc.boundSessionId === sessionId);
          if (hit) projectId = hit.doc.projectId;
        }
        if (projectId && args.assetId && !args.assetPath) {
          const doc = projectFor(store, projectId, sessionId);
          if (!doc.assets.some((a) => a.id === args.assetId)) {
            throw new DomainError('REF_NOT_FOUND', '工程里没有这个素材：' + args.assetId);
          }
        }
        return transcribeAsset({
          store,
          projectId,
          sessionId,
          assetPath: args.assetPath,
          assetId: args.assetId,
          modelSize: args.modelSize,
          language: args.language,
          applyToTimeline: args.applyToTimeline === true,
          baseRevision: args.baseRevision,
          leaseId: args.leaseId,
        });
      },
    ),
  ];
}
