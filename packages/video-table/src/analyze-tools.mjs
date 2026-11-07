/**
 * 视频解析的工具与 RPC 共用实现。
 *
 * 关键约束：解析是「用户点了才跑」的动作，所以这里没有：
 *   - 导入素材时的自动触发（media.mjs 里一个字节都没动）
 *   - 后台任务队列（一次解析 60 秒封顶，同步返回就够）
 *   - 写工程文档（结果落在 analysis.json，不涨 revision，不参与 undo）
 *
 * 工具描述里写了「只在用户要求分析素材时调用」，那是给模型看的门牌，
 * 不是装饰：没有它，模型会在导入后自作主张跑一遍。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { DomainError } from './domain.mjs';
import { asrPaths } from './asr-deps.mjs';
import { resolveAssetPath as guardAssetPath } from './media.mjs';
import { analyzeVideo, readAnalysis, writeAnalysis, analysisPath, framesDirFor, ANALYSIS_FILE } from './analyze.mjs';

/** 一次解析的总时限：14 秒的片子正常 3 秒内回，超过这个值就报超时 */
export const ANALYZE_TOTAL_TIMEOUT_MS = 60 * 1000;
/** 代表帧宽度：够看清构图，又不至于把磁盘塞满 */
export const FRAME_WIDTH = 480;

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

/** 工程按会话绑定：给了 projectId 就校验归属，没给就找会话绑定的那个；带租约时不校验会话。 */
function projectOf(store, projectId, sessionId, leaseId) {
  if (leaseId) {
    const doc = store.writableProject(projectId, sessionId, leaseId);
    return store.get(doc.projectId);
  }
  if (projectId) {
    const entry = store.get(projectId);
    if (sessionId) store.assertSession(entry.doc, sessionId);
    return entry;
  }
  if (!sessionId) throw new DomainError('INVALID_ARG', '需要 projectId 或 sessionId');
  const hit = [...store.projects.values()].find((p) => p.doc.boundSessionId === sessionId);
  if (!hit) throw new DomainError('REF_NOT_FOUND', '当前会话还没有打开工程，先调用 video_project_open');
  return hit;
}

export function isVideoAsset(asset) {
  const mime = String((asset && asset.mime) || '');
  if (mime.startsWith('video/')) return true;
  if (mime.startsWith('audio/') || mime.startsWith('image/')) return false;
  return /\.(mp4|mov|mkv|webm|avi|m4v|mpeg|mpg|ts|flv|wmv)$/i.test(String((asset && (asset.path || asset.name)) || ''));
}

/**
 * 把工具/面板传来的 assetPath 变成磁盘上的绝对路径。
 *
 * 接受三种写法（按顺序尝试）：
 *   1. 素材 id（asset_xxx）
 *   2. 工程内相对路径 / 文件名（assets/a.mp4、a.mp4）
 *   3. 磁盘绝对路径（用户点名要分析工程外的一个文件）
 *
 * 都不中时抛 REF_NOT_FOUND，并把试过的写法写进消息里 —— 不静默回退到别的素材。
 */
export async function resolveAnalyzeTarget(entry, assetPath) {
  const doc = entry.doc;
  const root = doc.root;
  const assets = Array.isArray(doc.assets) ? doc.assets : [];
  const wanted = assetPath == null ? '' : String(assetPath).trim();

  if (!wanted) {
    const asset = assets.find(isVideoAsset);
    if (!asset) throw new DomainError('REF_NOT_FOUND', '工程里还没有视频素材，先导入一段视频再解析');
    return { asset, abs: await guardAssetPath(root, asset.path), relPath: asset.path };
  }

  const asset =
    assets.find((a) => a.id === wanted) ||
    assets.find((a) => a.path === wanted) ||
    assets.find((a) => a.name === wanted && isVideoAsset(a)) ||
    null;

  let abs = null;
  if (asset) abs = await guardAssetPath(root, asset.path);
  else if (path.isAbsolute(wanted)) abs = wanted;
  else {
    // 没登记过、但确实在 assets/ 里的文件也认
    try {
      abs = await guardAssetPath(root, wanted);
    } catch {
      abs = null;
    }
  }
  if (!abs) throw new DomainError('REF_NOT_FOUND', `工程里没有这个素材：${wanted}`);

  try {
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    throw new DomainError('REF_NOT_FOUND', `文件不在了：${abs}`);
  }

  return { asset, abs, relPath: asset ? asset.path : wanted };
}

/**
 * 跑一次解析并落盘。返回 analyzeVideo 的结构 + path + assetPath。
 * 失败抛 DomainError（消息里带 ffmpeg 的真实输出），让 RPC 与工具都如实显示。
 */
export async function runAnalysis({
  store,
  projectId,
  sessionId,
  assetPath,
  maxShots,
  force = false,
  totalTimeoutMs = ANALYZE_TOTAL_TIMEOUT_MS,
  leaseId,
  run, // 仅测试注入：RPC 与工具都不会传
}) {
  const entry = store.writeEntry(projectId, sessionId, leaseId);
  // analysis.json 是工程资产：写它算整工程范围的写操作。
  // 带会话 / 租约就走统一闸门（没传 leaseId 时自动领 all 租约，冲突抛 LEASE_CONFLICT）；
  // 旧的面板调用可能只给 projectId、不给 sessionId —— 那种调用保持原样（无法证明身份，不领租约）。
  let guard = null;
  if (leaseId || sessionId) {
    guard = store.ensureWriteAccess({
      projectId: entry.doc.projectId,
      sessionId,
      leaseId,
      target: { type: 'project' },
      label: 'video_analyze',
    });
  }
  const target = await resolveAnalyzeTarget(entry, assetPath);

  // 只解析一次：源文件（大小 + mtime）没变且已有结果，就不再跑第二遍。
  // 要重跑必须显式 force，避免误触把几分钟的抽帧白跑一遍。
  let fingerprint = null;
  try {
    const stat = await fsp.stat(target.abs);
    fingerprint = { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
  } catch {
    fingerprint = null;
  }
  if (!force && fingerprint) {
    let existing = null;
    try {
      existing = await readAnalysis(entry.doc.root);
    } catch {
      existing = null;
    }
    if (
      existing &&
      existing.ok === true &&
      existing.source &&
      existing.source.size === fingerprint.size &&
      existing.source.mtimeMs === fingerprint.mtimeMs
    ) {
      return { ...existing, cached: true, assetPath: target.relPath || null };
    }
  }

  const ffmpegPath = process.env.DSH_FFMPEG_PATH || asrPaths().ffmpeg;
  const ffprobePath =
    process.env.DSH_FFPROBE_PATH || path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1000, Number(totalTimeoutMs) || ANALYZE_TOTAL_TIMEOUT_MS));

  let result;
  try {
    result = await analyzeVideo({
      ffmpegPath,
      ffprobePath,
      file: target.abs,
      framesDir: framesDirFor(entry.doc.root),
      root: entry.doc.root,
      maxShots: maxShots || undefined,
      width: FRAME_WIDTH,
      signal: controller.signal,
      run,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!result || result.ok !== true) {
    const error = (result && result.error) || {};
    if (timedOut) {
      throw new DomainError(
        'ANALYZE_TIMEOUT',
        `解析超时（${Math.round(totalTimeouts(totalTimeoutMs) / 1000)} 秒还没跑完）：${path.basename(target.abs)}`,
        { stderrTail: error.stderrTail || '' },
      );
    }
    throw new DomainError(error.code || 'ANALYZE_FAILED', error.message || '解析失败', {
      stderrTail: error.stderrTail || '',
    });
  }

  const withSource = fingerprint ? { ...result, source: fingerprint } : result;
  try {
    await writeAnalysis(entry.doc.root, withSource);
  } catch {
    /* 指纹写失败不影响本次结果；下次会重算一遍，不是错误 */
  }

  return {
    ...withSource,
    assetPath: target.relPath || null,
    assetId: target.asset ? target.asset.id : null,
    path: result.path || analysisPath(entry.doc.root),
    ...(guard ? store.writeAccessInfo(guard) : {}),
  };
}

function totalTimeouts(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : ANALYZE_TOTAL_TIMEOUT_MS;
}

/** 读回上次结果；没有就回 { ok:false, reason }，不抛。 */
export async function readAnalysisFor({ store, projectId, sessionId }) {
  const entry = projectOf(store, projectId, sessionId);
  const doc = await readAnalysis(entry.doc.root);
  if (!doc) return { ok: false, reason: '还没解析过', path: analysisPath(entry.doc.root) };
  return { ...doc, ok: true, path: analysisPath(entry.doc.root) };
}

// ------------------------------------------------------------------ 工具 ---

export function analyzeTools({ store }) {
  return [
    define(
      'video_analyze',
      '解析一段视频素材：镜头切点、每镜代表帧、主色与亮度、节奏统计（用于复刻别人的剪辑风格）。' +
        '只在用户明确要求分析素材 / 复刻风格时调用；导入视频时绝对不要自动调用，解析很贵（要跑几十个 ffmpeg 进程）。' +
        '结果会写到工程根目录的 analysis.json，重复调用会覆盖。',
      {
        type: 'object',
        properties: {
          assetPath: {
            type: 'string',
            description: '要解析的素材：素材 id、工程内相对路径（assets/a.mp4）或磁盘绝对路径；省略则用工程里第一个视频素材',
          },
          projectId: { type: 'string', description: '省略则用当前会话绑定的工程' },
          sessionId: { type: 'string', description: '一般不用传：工具会从调用上下文取会话' },
          leaseId: { type: 'string', description: '写租约 id（analysis.json 属于整工程，需要 all 租约）' },
          maxShots: { type: 'integer', minimum: 1, maximum: 1000, description: '镜头数上限，默认 200；超过就把最短的镜头合并' },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        const result = await runAnalysis({
          store,
          force: args.force === true,
          projectId: args.projectId,
          sessionId: args.sessionId || sessionOf(exec),
          assetPath: args.assetPath,
          maxShots: args.maxShots,
          leaseId: args.leaseId,
        });
        return result;
      },
    ),

    define(
      'video_analysis_read',
      `读回上一次 video_analyze 的结果（工程根目录的 ${ANALYSIS_FILE}）。还没解析过就返回 ok:false。`,
      {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '省略则用当前会话绑定的工程' },
          sessionId: { type: 'string', description: '一般不用传' },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        const value = await readAnalysisFor({
          store,
          projectId: args.projectId,
          sessionId: args.sessionId || sessionOf(exec),
        });
        return value.ok ? value : { ok: false, reason: value.reason };
      },
    ),
  ];
}
