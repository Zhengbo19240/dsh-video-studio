/**
 * HTTP routes for the workbench: JSON-RPC, SSE change stream, media bytes with
 * HTTP Range, and asset import.
 *
 * Every route authenticates through ctx.connection.admit() — the same gate the
 * shipped routes use. Media bytes never travel through a tool result.
 */

import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { DomainError, normalizeExportFps } from './domain.mjs';
import { describeLease } from './lease.mjs';
import { listEntries, readEntryCode, readEntryDoc } from './motion-lib.mjs';
import { checkProjectCamera } from './camera-tools.mjs';
import { writeCode } from './code-store.mjs';
import { importBytes, mimeFor, resolveAssetPath, readRange, scanAssets, ensureAssetDirs } from './media.mjs';
// 素材 kind 的唯一判据与「音频被放在视频轨」的脏数据扫描/修复计划（纯函数）。
import { describeAudioTrackIssues, planAudioRepair } from './media-kind.mjs';
import { readCode, listCodeLayers } from './code-store.mjs';
import { buildTemplate, getTemplate, listTemplates, templateCode } from './templates.mjs';
import { searchSounds, insertSound, soundPreview } from './sound-tools.mjs';
import { resolveLocalPath, soundSourcesRoots } from './sound-lib.mjs';
import { listKenneyPacks, installKenneyPack, packSlugFromUrl } from './sound-kenney.mjs';
import { importSoundFromUrl } from './sound-import.mjs';
import { saveStoryboard, readStoryboardDoc, applyStoryboard } from './storyboard-tools.mjs';
import { detectAsr, asrRoot, asrPaths } from './asr-deps.mjs';
import { startAsrJob, getAsrJob } from './asr-tools.mjs';
import { currentProviderName, listVoices, probe as ttsProbe, speak as ttsSpeak } from './tts.mjs';
import { runAnalysis, readAnalysisFor } from './analyze-tools.mjs';
import { exec as execProcess, readAnalysis } from './analyze.mjs';
import { annotationOp, enrichAnnotation, exportAnnotations } from './annotations.mjs';
import { applyReference } from './reference.mjs';
import {
  DENSITIES,
  DENSITY_LABELS,
  FONT_CHOICES,
  LIMITS,
  PREVIEW_SECONDS,
  SHOT_KINDS,
  SHOT_LABELS,
  alignmentForSpec,
  buildPreviewProject,
  clickSpecFor,
  defaultStyleSpec,
  previewLayout,
  specToSummary,
} from './style-spec.mjs';
import {
  MAX_ENABLED,
  disable as disableEnabled,
  enable as enableProject,
  listEnabled,
  updateTitle as updateEnabledTitle,
} from './enabled-registry.mjs';

const MAX_BODY = 1024 * 1024;
const MAX_UPLOAD = 512 * 1024 * 1024;
/** 风格样片上传上限：8 秒 720p 的 MP4 远小于这个数，留足余量。 */
const MAX_STYLE_UPLOAD = 64 * 1024 * 1024;

/** ffprobe 的只读探测参数：列出所有流的类型与编码头信息，输出 JSON。 */
const PROBE_ENTRIES = 'stream=codec_type,codec_name,profile,pix_fmt,width,height';

/**
 * 跑一次 ffprobe 读编码信息 + **流类型**。**永不抛错**：成功给 {ok:true, probe}，
 * 失败给 {ok:false, reason}（reason 里带 ffprobe 的原话尾巴，方便对账）。
 *
 * 为什么不再 `-select_streams v:0`：只挑视频流就永远答不出「这是不是音频」。
 * 现在把全部流拿出来，写 `hasVideoStream` / `hasAudioStream` / `kind` 进 probe ——
 * kind 从此有 ffprobe 背书，不再依赖扩展名猜（「有 video stream 才算视频」）。
 */
async function runVideoProbe(assetAbsPath) {
  const paths = asrPaths();
  const ffprobe =
    process.env.DSH_FFPROBE_PATH ||
    path.join(paths.ffmpegDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const args = ['-v', 'error', '-show_entries', PROBE_ENTRIES, '-of', 'json', assetAbsPath];
  try {
    const out = await execProcess(ffprobe, args, { timeoutMs: 10000 });
    const text = Buffer.isBuffer(out.stdout) ? out.stdout.toString('utf8') : String(out.stdout || '');
    let parsed;
    try {
      parsed = JSON.parse(text || '{}');
    } catch {
      return { ok: false, reason: 'ffprobe 的输出不是合法 JSON：' + text.slice(0, 200) };
    }
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    if (!streams.length) return { ok: false, reason: '这个文件里没有任何流（或 ffprobe 读不到）' };
    const video = streams.find((s) => s && s.codec_type === 'video') || null;
    const audio = streams.find((s) => s && s.codec_type === 'audio') || null;
    if (!video) {
      // 纯音频：这是「事实」而不是「探测失败」。带着流类型回去，面板据此把
      // 卡片/入口按音频处理，不再让人点「加入主轨」。
      const probe = {
        kind: 'audio',
        hasVideoStream: false,
        hasAudioStream: Boolean(audio),
        codec: (audio && audio.codec_name) || null,
      };
      return { ok: true, probe, reason: '这个文件里没有视频流（是音频素材）' };
    }
    return {
      ok: true,
      probe: {
        kind: 'video',
        hasVideoStream: true,
        hasAudioStream: Boolean(audio),
        codec: video.codec_name || null,
        profile: video.profile || null,
        pixFmt: video.pix_fmt || null,
        pix_fmt: video.pix_fmt || null,
        width: Number(video.width) || null,
        height: Number(video.height) || null,
      },
    };
  } catch (e) {
    const tail = (e && e.details && e.details.stderrTail) || (e && e.message) || '未知错误';
    return { ok: false, reason: `ffprobe 跑不起来：${tail}` };
  }
}

/**
 * 给「浏览器解不出来」的编码配一句建议 + 一条能直接用的转码命令。
 * 只对 HEVC / 10bit / 12bit 这类典型问题给命令，别的一律 null（不乱猜）。
 */
function probeAdvice(probe) {
  const codec = String((probe && probe.codec) || '').toLowerCase();
  const profile = String((probe && probe.profile) || '').toLowerCase();
  const pix = String((probe && (probe.pixFmt || probe.pix_fmt)) || '').toLowerCase();
  const hevc = codec === 'hevc' || codec === 'h265';
  const tenBit = /10|12/.test(pix) || /10|12/.test(profile);
  if (!hevc && !tenBit) return null;
  const why = hevc ? 'HEVC/H.265' : '10/12bit 像素格式';
  return {
    why,
    text:
      `浏览器多半解不了这个编码（${why}，profile=${probe.profile || '?'}，pix_fmt=${pix || '?'}）。` +
      '先转成 H.264 8bit 再导入：',
    command:
      'ffmpeg -i "输入.mp4" -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 20 -c:a aac -b:a 192k "输出-h264.mp4"',
  };
}

async function admitted(ctx, req) {
  const connection = ctx.get('connection');
  if (!connection || typeof connection.admit !== 'function') return { ok: true, peer: null, via: 'no-connection' };
  try {
    const peer = await connection.admit(req);
    return peer ? { ok: true, peer, via: 'peer' } : { ok: false };
  } catch (e) {
    // 凭据缺失/失效时仍允许同源页面请求（面板与路由同源）；跨站请求一律拒绝。
    const sameOrigin = req.headers && req.headers['sec-fetch-site'] === 'same-origin';
    if (sameOrigin) return { ok: true, peer: null, via: 'same-origin' };
    return { ok: false };
  }
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new DomainError('PAYLOAD_TOO_LARGE', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function fail(res, e) {
  const status = e instanceof DomainError ? 400 : 500;
  json(res, status, { ok: false, error: { code: e.code || 'INTERNAL', message: e.message, details: e.details || null } });
}

/**
 * 读一个文件并回 200 / 206（支持单段 Range）。
 *
 * 与 /api/video/media 里那段逻辑一致：关键帧是 PNG，样片是 MP4，<video> 会拿
 * Range 来拖进度条，所以这条不能只回整段。
 */
async function sendFile(req, res, abs, mime) {
  const stat = await fsp.stat(abs);
  const range = req.headers && req.headers.range;
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('content-type', mime || 'application/octet-stream');
  res.setHeader('cache-control', 'no-store');

  if (!range) {
    res.statusCode = 200;
    res.setHeader('content-length', String(stat.size));
    if (req.method === 'HEAD') return res.end();
    createReadStream(abs).pipe(res);
    return;
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!m) throw new DomainError('INVALID_ARG', '不支持的 Range: ' + range);
  const start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
    res.statusCode = 416;
    res.setHeader('content-range', `bytes */${stat.size}`);
    return res.end();
  }
  end = Math.min(end, stat.size - 1);
  res.statusCode = 206;
  res.setHeader('content-range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('content-length', String(end - start + 1));
  if (req.method === 'HEAD') return res.end();
  createReadStream(abs, { start, end }).pipe(res);
}

// ------------------------------------------------------------ 风格样片 S1 ----
//
// 预览工程落在 <projectRoot>/.dsh-video/style-preview/，和用户工程共用同一个
// 工程目录树，但从不进 store、不进绑定表、不占启用额度 —— 关掉面板它也还在磁盘上，
// 删掉用户工程会一起删（那是同一个目录），这是刻意的：预览本来是临时产物。

/** 预览目录里的相对路径 → 绝对路径，并保证它没跑出工程目录。 */
function stylePreviewAbs(root, relPath) {
  if (typeof relPath !== 'string' || !relPath) {
    throw new DomainError('INVALID_ARG', '风格预览缺少相对路径');
  }
  if (relPath.includes('\0')) throw new DomainError('INVALID_ARG', '路径包含非法字符');
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, relPath);
  const relative = path.relative(absRoot, abs);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new DomainError('OUTSIDE_PROJECT', '风格预览路径越出工程目录: ' + relPath);
  }
  return abs;
}

/** 预览目录（绝对路径）。 */
function stylePreviewDir(root) {
  return stylePreviewAbs(root, previewLayout().relDir);
}

/** 读上一轮的 style.json；没有或读不动都回 null（不终止预览）。 */
async function readStyleMeta(root) {
  try {
    const file = stylePreviewAbs(root, previewLayout().relStyle);
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 落盘：每个文件先写 .tmp 再 rename，不留半截文件。 */
async function writeStyleFiles(root, files) {
  const dir = stylePreviewDir(root);
  await fsp.mkdir(dir, { recursive: true });
  for (const file of files || []) {
    const abs = stylePreviewAbs(root, file.relPath);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = abs + '.tmp-' + process.pid;
    await fsp.writeFile(tmp, file.content, 'utf8');
    await fsp.rename(tmp, abs);
  }
  return dir;
}

/** spec 变了就把旧图删掉：宁可空着，也不给人看上一套风格的「样片」。 */
async function clearStyleArtifacts(root) {
  await fsp.rm(stylePreviewAbs(root, previewLayout().relFramesDir), { recursive: true, force: true });
  for (const rel of [previewLayout().relVideo, previewLayout().relVideoWebm, previewLayout().relClick]) {
    await fsp.rm(stylePreviewAbs(root, rel), { force: true });
  }
}

/** 数一遍预览目录里现在有什么：4 张 PNG、1 段 MP4、上一轮的 style.json。 */
async function scanStyleArtifacts(root) {
  const layout = previewLayout();
  const meta = await readStyleMeta(root);
  const frames = [];
  for (const shot of (meta && Array.isArray(meta.shots) ? meta.shots : [])) {
    const relPath = `${layout.relDir}/frames/${layout.frameFileName(shot.index, shot.kind)}`;
    let absPath;
    try {
      absPath = stylePreviewAbs(root, relPath);
    } catch {
      continue;
    }
    try {
      const stat = await fsp.stat(absPath);
      frames.push({
        index: shot.index,
        kind: shot.kind,
        label: SHOT_LABELS[shot.kind] || shot.kind,
        keyframeAt: shot.keyframeAt,
        relPath,
        absPath,
        bytes: stat.size,
      });
    } catch {
      /* 这一张还没渲染 */
    }
  }
  let video = null;
  for (const rel of [layout.relVideo, layout.relVideoWebm]) {
    try {
      const absPath = stylePreviewAbs(root, rel);
      const stat = await fsp.stat(absPath);
      video = { relPath: rel, absPath, bytes: stat.size };
      break;
    } catch {
      /* 这个容器没有样片 */
    }
  }
  // 节拍音轨只在上传过之后才存在（混进样片的场景不落这个文件）
  let clickAudio = null;
  try {
    const absPath = stylePreviewAbs(root, layout.relClick);
    const stat = await fsp.stat(absPath);
    clickAudio = { relPath: layout.relClick, absPath, bytes: stat.size };
  } catch {
    /* 没有独立节拍轨 */
  }
  return { frames, video, clickAudio, meta, layout };
}

/** 预览接口的统一返回形状：帧与样片的路径一律是工程内相对路径。 */
function styleArtifactsPayload(root, artifacts) {
  const { frames, video, clickAudio, meta, layout } = artifacts;
  return {
    frames: frames.map((frame) => frame.relPath),
    frameDetails: frames,
    previewPath: video ? video.relPath : null,
    video,
    clickPath: clickAudio ? clickAudio.relPath : null,
    clickAudio,
    // 节拍参数与对齐检查是样片的「数据面」：面板照着它显示，测试照着它断言
    click: (meta && meta.click) || null,
    alignment: (meta && meta.alignment) || null,
    dir: path.resolve(root, layout.relDir),
    timelineReady: true,
  };
}

// ------------------------------------------------------------ 开工阶段面板 ----
//
// 只读投影：把 dsh-video-brief 插件在 `<工程根>/.dsh-video/` 维护的三个 JSON
// （state.json / brief.json / style.json）读成一块面板能直接画出来的快照。
//
// 三条硬规则，改这段之前先读一遍：
// 1. **绝不写盘**。面板不推进阶段、不确认风格、不补 brief —— 那些都由 agent
//    调插件的 6 个工具（video_stage_get / video_brief_confirm / …）完成。
//    这里连 state.json 的自愈都不做：读一次就改文件，等于「看」也在写。
// 2. **绝不 500**。文件缺失 / 坏 JSON / 结构不对 → 对应字段 null + 一条 warning，
//    面板能画多少画多少。
// 3. **判定与插件一致**。空串 / 纯空白 = 没填；reference 槽位的 `{skipped:true}`
//    或「无参考」这类显式说法 = 已填。不一致会造成「面板说满了、插件说没满」。
//    对齐的依据是 dsh-video-brief/src/{slots,brief,stage}.mjs。

/** 插件元数据目录（与 dsh-video-brief 的 META_DIR 一致）。 */
const BRIEF_META_DIR = '.dsh-video';

/** 阶段顺序即合法前进方向（与插件 STAGES 一致）。 */
const STAGE_SEQUENCE = ['idle', 'clarify', 'style', 'locked', 'build'];

/**
 * 10 个槽位（id 是稳定契约，顺序即优先级）。
 * 这里是插件 DEFAULT_SLOTS 的只读副本：面板只需要 id / title / 是否参考类，
 * 提问文案与 why 属于 agent 侧，不往客户端搬。
 */
const BRIEF_SLOTS = [
  { id: 'goal', title: '目标与验收' },
  { id: 'platform', title: '平台与画幅' },
  { id: 'duration', title: '时长' },
  { id: 'audience', title: '受众' },
  { id: 'tone', title: '调性' },
  { id: 'pace', title: '节奏' },
  { id: 'deliverable', title: '交付形态' },
  { id: 'visual', title: '画面偏好' },
  { id: 'reference', title: '参考素材', kind: 'references' },
  { id: 'taboo', title: '禁忌' },
];

/** 阶段下标；非法 -1。 */
function stageRank(stage) {
  return STAGE_SEQUENCE.indexOf(stage);
}

/** `.dsh-video/<fileName>` 的绝对路径；跑出元数据目录一律拒绝。 */
function briefMetaAbs(root, fileName) {
  const metaDir = path.resolve(String(root || ''), BRIEF_META_DIR);
  const abs = path.resolve(metaDir, fileName);
  const relative = path.relative(metaDir, abs);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new DomainError('OUTSIDE_PROJECT', '元数据文件越出 .dsh-video 目录: ' + fileName);
  }
  return abs;
}

/**
 * 读一个 JSON，永不抛。
 * @returns {Promise<{value:any, exists:boolean, corrupt:boolean, error?:string}>}
 */
async function readJsonSoft(file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { value: null, exists: false, corrupt: false };
    return { value: null, exists: true, corrupt: true, error: (e && e.message) || '读不动' };
  }
  try {
    return { value: JSON.parse(text), exists: true, corrupt: false };
  } catch {
    return { value: null, exists: true, corrupt: true };
  }
}

/** 一行值算不算「填了」—— 与插件 isSlotFilled 同义（空串 / 纯空白 = 没填）。 */
function slotFilled(value) {
  if (typeof value === 'string') {
    // 参考素材：任何非空文本都算填了 —— 「无参考」这类显式说法本来就是要记下来的答案
    // （插件缺的只是「空着不说」，不是「说了没有」）。
    return value.trim() !== '';
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.skipped === true) return true;
  const count = Number(value.count);
  if (Number.isFinite(count) && count > 0) return true;
  return Array.isArray(value.paths) && value.paths.length > 0;
}

/** 槽位值的可读原文（参考素材折叠成一句话，其余原样）。 */
function slotText(value, kind) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  if (value.skipped === true) {
    const reason = typeof value.reason === 'string' && value.reason.trim() !== '' ? `（${value.reason.trim()}）` : '';
    return `无参考${reason}`;
  }
  const paths = Array.isArray(value.paths) ? value.paths.filter((x) => typeof x === 'string') : [];
  if (paths.length > 0) {
    const shown = paths.slice(0, 6).join('、');
    const more = paths.length > 6 ? ' 等' : '';
    return `${paths.length} 个参考文件：${shown}${more}`;
  }
  const count = Number(value.count);
  return `${Number.isFinite(count) && count > 0 ? count : 0} 个参考文件（只登记了数量）`;
}

/** 事实允许的最高阶段（build 是动作不是事实，不在这里推）。 */
function factsCeiling(facts) {
  if (facts.briefReady === true && facts.styleConfirmed === true) return 'locked';
  if (facts.briefReady === true || facts.styleConfirmed === true) return 'style';
  if (Number(facts.briefFilled) > 0) return 'clarify';
  return 'idle';
}

/** 预览路径过滤：只放行相对工程根、不带 ..、不带盘符 / scheme 的路径。 */
function safePreviewPath(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.length > 400) return null;
  if (/[\u0000-\u001f]/.test(text)) return null;
  if (/^[a-zA-Z]:[\\/]/.test(text)) return null;
  if (text.startsWith('/') || text.startsWith('\\')) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return null;
  if (text.split(/[\\/]+/).includes('..')) return null;
  return text;
}

/** style.json → 面板用的风格视图；未确认 / 规格不合法一律 null。 */
function buildStyleView(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.confirmed !== true) return null;
  const spec = raw.spec;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const tone = typeof spec.tone === 'string' ? spec.tone.trim() : '';
  const font = typeof spec.font === 'string' ? spec.font.trim() : '';
  const density = typeof spec.density === 'string' ? spec.density.trim().toLowerCase() : '';
  const pace = Number(spec.pace);
  const palette = Array.isArray(spec.palette)
    ? spec.palette.filter((c) => typeof c === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c.trim()))
    : [];
  if (tone === '' || font === '' || !['low', 'med', 'high'].includes(density)) return null;
  if (!Number.isFinite(pace) || pace <= 0 || pace > 60) return null;
  if (palette.length === 0) return null;

  const previewRaw = raw.preview && typeof raw.preview === 'object' && !Array.isArray(raw.preview) ? raw.preview : {};
  const rawFrames = Array.isArray(previewRaw.keyframes) ? previewRaw.keyframes : [];
  const keyframes = [];
  for (const item of rawFrames.slice(0, 12)) {
    const safe = safePreviewPath(item);
    if (safe) keyframes.push(safe);
  }
  return {
    style: {
      confirmed: true,
      spec: { tone, palette: palette.map((c) => c.trim()), font, density, pace },
      preview: { keyframes: keyframes.slice(0, 4), clip: safePreviewPath(previewRaw.clip) },
      confirmedAt: typeof raw.confirmedAt === 'string' && raw.confirmedAt.trim() !== '' ? raw.confirmedAt : null,
    },
    filtered: rawFrames.length - keyframes.length,
  };
}

/** 下一步该干什么（中文一句话，指向 agent 工具，不是面板按钮）。 */
function stageNextStep(stage, facts, ceiling, ahead) {
  const filled = Number(facts.briefFilled) || 0;
  const total = Number(facts.briefTotal) || 10;
  const missing = Number(facts.missingCount) || 0;
  // 状态领先于事实：插件读一次会自愈，面板只提示，不替它改文件。
  if (ahead) {
    return `状态领先于事实（state 说 ${stage}，brief / 风格只允许 ${ceiling}）：让 agent 调 video_stage_get，插件会按事实回落。`;
  }
  if (stageRank(ceiling) > stageRank(stage)) {
    const jump = stageRank(ceiling) - stageRank(stage) > 1;
    return `状态落后于事实（事实允许 ${ceiling}）：让 agent 调 video_stage_advance {to:"${ceiling}"${jump ? ', force:true' : ''}} 追上。`;
  }
  if (stage === 'idle') {
    if (filled > 0) return `brief 已有 ${filled} 项，但 stage 还是 idle：让 agent 调 video_stage_advance {to:"clarify"}。`;
    return '还没开始：让 agent 调 video_brief_start 拿缺失清单，再用 video_brief_confirm 写回答案。';
  }
  if (stage === 'clarify') {
    return `还缺 ${missing} 项：让 agent 调 video_brief_confirm 一次补齐（一轮 ≤3 条）；满 ${total}/${total} 自动进 style。`;
  }
  if (stage === 'style') {
    if (facts.briefReady !== true) {
      return `风格已确认，但 brief 只有 ${filled}/${total}：让 agent 先补齐 brief，再 video_stage_advance 回到 locked。`;
    }
    return 'brief 已齐：让 agent 调 video_style_confirm 确认 tone / palette / font / density / pace（可附预览产物），阶段自动进 locked。';
  }
  if (stage === 'locked') {
    return '可以改时间线了；第一次写操作会自动进入 build。要导出先让 agent 调 video_stage_advance {to:"build"}。';
  }
  return '生产阶段：写类与导出都放行。收工前核对交付物、分辨率与禁忌。';
}

/** 当前阶段被拦住的类别（面板只显示，不提供解锁入口）。 */
function stageBlocked(stage, facts, ceiling, ahead) {
  if (ahead) {
    return [`阶段领先于事实（事实只允许 ${ceiling}）：先让 agent 调 video_stage_get 自愈`];
  }
  if (stageRank(ceiling) > stageRank(stage)) {
    const jump = stageRank(ceiling) - stageRank(stage) > 1;
    return [`阶段落后于事实（事实允许 ${ceiling}）：先 video_stage_advance {to:"${ceiling}"${jump ? ', force:true' : ''}}`];
  }
  if (stage === 'idle' || stage === 'clarify') {
    return ['video_style_confirm / video_style_read（先补完 brief）', '写类工具（先补完 brief）', '导出（先补完 brief）'];
  }
  if (stage === 'style') return ['写类工具（先确认风格）', '导出（先确认风格）'];
  if (stage === 'locked') return ['导出（先进入 build）'];
  return [];
}

/**
 * 读一次开工阶段快照。**只读**：不建目录、不写文件、不自愈。
 * @param {string} root 工程根
 */
async function readBriefState(root) {
  const warnings = [];
  try {
    // ---- brief.json ----
    const briefRead = await readJsonSoft(briefMetaAbs(root, 'brief.json'));
    if (!briefRead.exists) warnings.push('没找到 .dsh-video/brief.json（还没调过 video_brief_start）');
    else if (briefRead.corrupt) warnings.push('.dsh-video/brief.json 不是合法 JSON，已按「一个都没填」处理');

    const briefRaw = briefRead.value && typeof briefRead.value === 'object' && !Array.isArray(briefRead.value)
      ? briefRead.value
      : {};
    const slotValues = briefRaw.slots && typeof briefRaw.slots === 'object' && !Array.isArray(briefRaw.slots)
      ? briefRaw.slots
      : {};

    const slots = BRIEF_SLOTS.map((slot) => {
      const value = slotValues[slot.id];
      const filled = slotFilled(value);
      const out = { id: slot.id, title: slot.title, filled };
      if (slot.kind) out.kind = slot.kind;
      if (filled) {
        const text = slotText(value, slot.kind);
        out.value = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
      }
      return out;
    });
    const filled = slots.filter((s) => s.filled).length;
    const total = slots.length;

    // ---- style.json ----
    const styleRead = await readJsonSoft(briefMetaAbs(root, 'style.json'));
    let style = null;
    if (!styleRead.exists) warnings.push('没找到 .dsh-video/style.json（风格还没确认）');
    else if (styleRead.corrupt) warnings.push('.dsh-video/style.json 不是合法 JSON，已按「未确认」处理');
    const styleView = styleRead.corrupt ? null : buildStyleView(styleRead.value);
    if (!styleRead.corrupt && styleRead.exists) {
      if (!styleView) warnings.push('.dsh-video/style.json 存在但未确认或 spec 不合法，面板按「未确认」显示');
      else if (styleView.filtered > 0) {
        warnings.push(`style.preview.keyframes 有 ${styleView.filtered} 条路径越界或不合法，已过滤`);
      }
    }
    style = styleView ? styleView.style : null;
    const styleConfirmed = Boolean(style);

    const facts = {
      briefReady: total > 0 && filled === total,
      briefFilled: filled,
      briefTotal: total,
      missingCount: total - filled,
      styleConfirmed,
    };
    const ceiling = factsCeiling(facts);

    // ---- state.json ----
    const stateRead = await readJsonSoft(briefMetaAbs(root, 'state.json'));
    let stage = null;
    let since = null;
    let history = [];
    let stageSource = 'inferred';
    if (!stateRead.exists) {
      warnings.push('没找到 .dsh-video/state.json，stage 按 brief / 风格推断');
    } else if (stateRead.corrupt) {
      warnings.push('.dsh-video/state.json 不是合法 JSON，stage 按 brief / 风格推断');
    } else if (stateRead.value && typeof stateRead.value === 'object' && !Array.isArray(stateRead.value)) {
      const raw = stateRead.value;
      if (STAGE_SEQUENCE.includes(raw.stage)) {
        stage = raw.stage;
        stageSource = 'state';
        since = typeof raw.since === 'string' && raw.since.trim() !== '' ? raw.since : null;
        const rawHistory = Array.isArray(raw.history) ? raw.history : [];
        for (const entry of rawHistory) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
          if (!STAGE_SEQUENCE.includes(entry.stage)) continue;
          const item = {
            stage: entry.stage,
            at: typeof entry.at === 'string' && entry.at.trim() !== '' ? entry.at : null,
            by: entry.by === 'user' ? 'user' : 'tool',
          };
          if (entry.forced === true) item.forced = true;
          if (entry.jump === true) item.jump = true;
          if (typeof entry.reason === 'string' && entry.reason !== '') item.reason = entry.reason;
          history.push(item);
        }
        if (history.length > 40) history = history.slice(-40);
      } else {
        warnings.push(`state.json 里的 stage=${JSON.stringify(raw.stage)} 不是合法阶段，按事实推断`);
      }
    } else {
      warnings.push('state.json 结构不是对象，stage 按 brief / 风格推断');
    }
    if (!stage) {
      stage = ceiling;
      since = null;
    }

    // 状态领先于事实：state 说得更远，但 brief / 风格不够 —— 插件读一次会自愈，
    // 面板只做标记，不替它改文件。
    let consistency;
    const ahead = stage === 'build'
      ? !(facts.briefReady === true && styleConfirmed === true)
      : stageRank(stage) > stageRank(ceiling);
    if (ahead) {
      consistency = 'state-ahead-of-facts';
      warnings.push(`state.json 领先于事实：它说 ${stage}，但 brief / 风格只允许 ${ceiling} —— 让 agent 调 video_stage_get 会按事实自愈`);
    }

    return {
      stage,
      since,
      stageSource,
      briefReady: facts.briefReady,
      filled,
      total,
      slots,
      style,
      nextStep: stageNextStep(stage, facts, ceiling, Boolean(consistency)),
      blocked: stageBlocked(stage, facts, ceiling, Boolean(consistency)),
      history,
      warnings,
      ...(consistency ? { consistency } : {}),
    };
  } catch (e) {
    // 兜底：连元数据目录都定位不到也回一个能画的空快照，不让面板白屏。
    return {
      stage: 'idle',
      since: null,
      stageSource: 'inferred',
      briefReady: false,
      filled: 0,
      total: BRIEF_SLOTS.length,
      slots: BRIEF_SLOTS.map((slot) => ({
        id: slot.id,
        title: slot.title,
        filled: false,
        ...(slot.kind ? { kind: slot.kind } : {}),
      })),
      style: null,
      nextStep: '读取开工阶段失败：让 agent 调 video_stage_get 看真实阶段。',
      blocked: [],
      history: [],
      warnings: [...warnings, '读取 .dsh-video/ 失败：' + ((e && e.message) || e)],
    };
  }
}

export function registerVideoRoutes(ctx, store, log, samples) {
  const disposers = [];

  // POST /api/video/rpc  { method, params }
  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/video/rpc',
      async handler(req, res) {
        const gate = await admitted(ctx, req);
        if (!gate.ok) return json(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: '需要 DSH 会话凭据' } });
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } });
        let payload;
        try {
          payload = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8') || '{}');
        } catch (e) {
          return fail(res, e instanceof DomainError ? e : new DomainError('INVALID_ARG', '请求体不是合法 JSON'));
        }
        try {
          const value = await dispatch(ctx, store, samples, payload.method, payload.params || {});
          json(res, 200, { ok: true, value });
        } catch (e) {
          log?.('rpc failed: ' + payload.method + ' :: ' + e.message);
          fail(res, e);
        }
      },
    }),
  );

  // POST /api/video/beacon  { stage, detail } —— 客户端启动留痕（不鉴权，只写一行文本）
  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/video/beacon',
      async handler(req, res) {
        try {
          const raw = await readBody(req, 64 * 1024);
          const body = JSON.parse(raw.toString('utf8') || '{}');
          const line =
            new Date().toISOString() + '  ' + String(body.stage || '?') + '  ' + String(body.detail || '') + '\n';
          const fs = await import('node:fs/promises');
          const os = await import('node:os');
          const pathMod = await import('node:path');
          const dir = pathMod.join(os.homedir(), '.dsh');
          await fs.mkdir(dir, { recursive: true });
          await fs.appendFile(pathMod.join(dir, 'video-workbench-client.log'), line, 'utf8');
        } catch {
          /* 留痕失败不影响任何功能 */
        }
        json(res, 200, { ok: true });
      },
    }),
  );

  // GET /api/video/events?projectId=...  (SSE)
  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/video/events',
      async handler(req, res) {
        const gate = await admitted(ctx, req);
        if (!gate.ok) {
          res.statusCode = 403;
          res.end('unauthorized');
          return;
        }
        const url = new URL(req.url, 'http://127.0.0.1');
        const projectId = url.searchParams.get('projectId') || '';
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send('hello', { projectId, at: Date.now() });
        const off = store.onChange((event) => {
          if (projectId && event.projectId !== projectId) return;
          send('change', event);
        });
        const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
        const close = () => {
          clearInterval(keepAlive);
          off();
          try {
            res.end();
          } catch {
            /* closed */
          }
        };
        req.on('close', close);
        req.on('error', close);
      },
    }),
  );

  // POST /api/video/import?projectId=..&sessionId=..&name=..  (raw bytes)
  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/video/import',
      async handler(req, res) {
        const gate = await admitted(ctx, req);
        if (!gate.ok) return json(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: '需要 DSH 会话凭据' } });
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } });
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const projectId = url.searchParams.get('projectId');
          const sessionId = url.searchParams.get('sessionId');
          const leaseId = url.searchParams.get('leaseId');
          const name = url.searchParams.get('name') || 'upload.bin';
          const entry = writeEntry(store, projectId, sessionId, leaseId);
          // 素材登记属于整工程范围：面板上传前由这里自动领租约，冲突如实报 LEASE_CONFLICT
          const guard = store.ensureWriteAccess({
            projectId: entry.doc.projectId,
            sessionId,
            leaseId,
            target: { type: 'project' },
            label: 'asset.import',
          });
          const resolvedLeaseId = guard.lease ? guard.lease.leaseId : null;
          await ensureAssetDirs(entry.doc.root);
          const bytes = await readBody(req, MAX_UPLOAD);
          if (!bytes.length) throw new DomainError('INVALID_ARG', '空文件');
          const imported = await importBytes(entry.doc.root, { name, bytes });
          const assetId = 'asset_' + Math.random().toString(36).slice(2, 10);
          const p = store.preview(projectId, sessionId, undefined, [
            {
              type: 'asset.add',
              assetId,
              relPath: imported.relPath,
              name: imported.name,
              size: imported.size,
              hash: imported.hash,
              mime: imported.mime,
            },
          ], '导入素材', 'ui', resolvedLeaseId);
          await store.applyPreview(p.previewId, sessionId, resolvedLeaseId);
          json(res, 200, { ok: true, value: { asset: { id: assetId, ...imported }, ...store.writeAccessInfo(guard) } });
        } catch (e) {
          fail(res, e);
        }
      },
    }),
  );

  // POST /api/video/export?projectId=..&sessionId=..&name=..&duration=..  (raw bytes)
  //
  // 成片回填：面板导出成功 → 把字节送给这里 → 落到 <root>/exports/<name> 并登记
  // 进 project.exports[]。报告里的「交付物与工程分家」就断在这条线上。
  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/video/export',
      async handler(req, res) {
        const gate = await admitted(ctx, req);
        if (!gate.ok) return json(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: '需要 DSH 会话凭据' } });
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } });
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const projectId = url.searchParams.get('projectId');
          const sessionId = url.searchParams.get('sessionId');
          const leaseId = url.searchParams.get('leaseId');
          const duration = Number(url.searchParams.get('duration'));
          // 导出帧率与工程帧率可以不同；非法值在写盘之前拦下，不留下半条记录或孤儿文件。
          const fps = normalizeExportFps(url.searchParams.get('fps'), 'fps');
          const sourceFps = normalizeExportFps(url.searchParams.get('sourceFps'), 'sourceFps');
          const rawName = path.basename(String(url.searchParams.get('name') || 'export.mp4'));
          const name = rawName.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(-120) || 'export.mp4';
          const entry = writeEntry(store, projectId, sessionId, leaseId);
          const guard = store.ensureWriteAccess({
            projectId: entry.doc.projectId,
            sessionId,
            leaseId,
            target: { type: 'project' },
            label: 'export.save',
          });
          const bytes = await readBody(req, MAX_UPLOAD);
          if (!bytes.length) throw new DomainError('INVALID_ARG', '空文件');
          const dir = path.join(entry.doc.root, 'exports');
          await fsp.mkdir(dir, { recursive: true });
          const abs = path.join(dir, name);
          store.assertInside(entry.doc.root, abs);
          await fsp.writeFile(abs, bytes);
          const rel = path.relative(entry.doc.root, abs).split(path.sep).join('/');
          const recorded = await store.recordExport(
            entry.doc.projectId,
            {
              path: rel,
              duration: Number.isFinite(duration) && duration > 0 ? duration : null,
              size: bytes.length,
              source: 'workbench',
              fps,
              sourceFps,
            },
            { actor: 'panel' },
          );
          json(res, 200, {
            ok: true,
            value: {
              projectId: entry.doc.projectId,
              root: entry.doc.root,
              path: abs,
              relPath: rel,
              size: bytes.length,
              revision: recorded.revision,
              ...store.writeAccessInfo(guard),
            },
          });
        } catch (e) {
          fail(res, e);
        }
      },
    }),
  );

  // GET/HEAD /api/video/media?projectId=..&assetId=..  (206 Range)
  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/video/media',
      async handler(req, res) {
        const gate = await admitted(ctx, req);
        if (!gate.ok) return json(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: '需要 DSH 会话凭据' } });
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const projectId = url.searchParams.get('projectId');
          const assetId = url.searchParams.get('assetId');
          // variant=preview：预览解码走备份副本；没有备份就回落到原片
          const variant = url.searchParams.get('variant');
          const entry = store.get(projectId);
          const asset = entry.doc.assets.find((a) => a.id === assetId);
          if (!asset) throw new DomainError('REF_NOT_FOUND', '素材不存在: ' + assetId);
          const mediaPath = variant === 'preview' && asset.previewPath ? asset.previewPath : asset.path;
          const abs = await resolveAssetPath(entry.doc.root, mediaPath);
          const stat = await fsp.stat(abs);
          const mime = asset.mime || mimeFor(asset.path);
          const range = req.headers.range;
          res.setHeader('accept-ranges', 'bytes');
          res.setHeader('content-type', mime);
          res.setHeader('cache-control', 'no-store');

          if (!range) {
            res.statusCode = 200;
            res.setHeader('content-length', String(stat.size));
            if (req.method === 'HEAD') return res.end();
            createReadStream(abs).pipe(res);
            return;
          }
          const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
          if (!m) throw new DomainError('INVALID_ARG', '不支持的 Range: ' + range);
          const start = m[1] ? parseInt(m[1], 10) : 0;
          let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
          if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
            res.statusCode = 416;
            res.setHeader('content-range', `bytes */${stat.size}`);
            return res.end();
          }
          end = Math.min(end, stat.size - 1);
          res.statusCode = 206;
          res.setHeader('content-range', `bytes ${start}-${end}/${stat.size}`);
          res.setHeader('content-length', String(end - start + 1));
          if (req.method === 'HEAD') return res.end();
          createReadStream(abs, { start, end }).pipe(res);
        } catch (e) {
          if (e && e.code === 'REF_NOT_FOUND') return json(res, 404, { ok: false, error: { code: e.code, message: e.message } });
          fail(res, e);
        }
      },
    }),
  );

  // GET/HEAD /api/video/sound?entryId=..  —— 本地音效试听（单段 Range → 206）
  //
  // 写法照 /api/video/media：同一道 admit gate、同一套 Range 解析与错误应答。
  // 路径只走 resolveLocalPath（词法 + realpath 双层越界守卫），路由里不拼任何路径。
  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/video/sound',
      async handler(req, res) {
        const gate = await admitted(ctx, req);
        if (!gate.ok) return json(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: '需要 DSH 会话凭据' } });
        // 只读路由：只接受 GET/HEAD，其余方法明确回 405（media 那条没写这个方法判断）
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return json(res, 405, { ok: false, error: { code: 'METHOD', message: 'GET/HEAD only' } });
        }
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const entryId = url.searchParams.get('entryId');
          const abs = await resolveLocalPath(entryId);
          let stat;
          try {
            stat = await fsp.stat(abs);
          } catch (e) {
            if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
              throw new DomainError('NOT_FOUND', '声音文件不存在: ' + abs);
            }
            throw e;
          }
          const range = req.headers.range;
          res.setHeader('accept-ranges', 'bytes');
          res.setHeader('content-type', mimeFor(abs));
          res.setHeader('cache-control', 'no-store');

          if (!range) {
            res.statusCode = 200;
            res.setHeader('content-length', String(stat.size));
            if (req.method === 'HEAD') return res.end();
            createReadStream(abs).pipe(res);
            return;
          }
          const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
          if (!m) throw new DomainError('INVALID_ARG', '不支持的 Range: ' + range);
          const start = m[1] ? parseInt(m[1], 10) : 0;
          let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
          if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
            res.statusCode = 416;
            res.setHeader('content-range', `bytes */${stat.size}`);
            return res.end();
          }
          end = Math.min(end, stat.size - 1);
          res.statusCode = 206;
          res.setHeader('content-range', `bytes ${start}-${end}/${stat.size}`);
          res.setHeader('content-length', String(end - start + 1));
          if (req.method === 'HEAD') return res.end();
          createReadStream(abs, { start, end }).pipe(res);
        } catch (e) {
          // 越界与找不到一律 404：不泄露声音库之外是否存在该文件
          if (e && (e.code === 'OUTSIDE_LIB' || e.code === 'NOT_FOUND')) {
            return json(res, 404, { ok: false, error: { code: e.code, message: e.message } });
          }
          fail(res, e);
        }
      },
    }),
  );

  // GET /api/video/probe?projectId=..&assetId=..
  //
  // 只读探测：跑 ffprobe 读编码头，再把结果合并进 asset.probe（走 asset.setProbe 落盘），
  // 下次打开工程直接命中缓存。失败一律 200 + {ok:false, reason}，绝不抛错 ——
  // 探测失败只该让卡片多一行建议，不该把面板打红。
  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/video/probe',
      async handler(req, res) {
        const gate = await admitted(ctx, req);
        if (!gate.ok) return json(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: '需要 DSH 会话凭据' } });
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return json(res, 405, { ok: false, error: { code: 'METHOD', message: 'GET only' } });
        }
        const url = new URL(req.url, 'http://127.0.0.1');
        const projectId = url.searchParams.get('projectId');
        const assetId = url.searchParams.get('assetId');

        let entry;
        try {
          entry = store.get(projectId);
        } catch (e) {
          // 探测是尽力而为的只读操作：工程还没打开不该让客户端画一条红字报错。
          // 回 200 + ok:false，卡片最多多一行「未探测」，不会把面板打红。
          return json(res, 200, { ok: false, code: 'PROJECT_NOT_OPEN', reason: '工程未打开: ' + projectId });
        }
        const asset = entry.doc.assets.find((a) => a.id === assetId);
        if (!asset) {
          return json(res, 404, { ok: false, error: { code: 'REF_NOT_FOUND', message: '素材不存在: ' + assetId } });
        }

        // 已有 codec：直接回缓存，不重复跑进程
        if (asset.probe && asset.probe.codec) {
          return json(res, 200, {
            ok: true,
            cached: true,
            assetId,
            probe: asset.probe,
            advice: probeAdvice(asset.probe),
          });
        }

        let abs;
        try {
          abs = await resolveAssetPath(entry.doc.root, asset.path);
        } catch (e) {
          return json(res, 200, { ok: false, assetId, reason: (e && e.message) || '路径越出工程目录' });
        }

        const result = await runVideoProbe(abs);
        if (!result.ok) return json(res, 200, { ok: false, assetId, reason: result.reason });

        // 合并：已有 duration 等字段全部保留，只补 codec/profile/pix_fmt 与宽高
        const next = Object.assign({}, asset.probe || {});
        for (const [key, value] of Object.entries(result.probe)) {
          if (value != null) next[key] = value;
        }

        let persisted = false;
        try {
          const sessionId = entry.doc.boundSessionId;
          // 探测缓存也是工程数据：按整工程范围自动领租约；领不到就只回内存结果，不影响面板
          const guard = store.ensureWriteAccess({
            projectId,
            sessionId,
            target: { type: 'project' },
            label: 'asset.probe',
          });
          const leaseId = guard.lease ? guard.lease.leaseId : null;
          const p = store.preview(
            projectId,
            sessionId,
            undefined,
            [{ type: 'asset.setProbe', assetId, probe: next }],
            '写入编码探测',
            'ui',
            leaseId,
          );
          await store.applyPreview(p.previewId, sessionId, leaseId);
          persisted = true;
        } catch (e) {
          log?.('probe persist skipped: ' + ((e && e.message) || e));
        }

        return json(res, 200, { ok: true, cached: false, assetId, probe: next, advice: probeAdvice(next), persisted });
      },
    }),
  );

  // GET/HEAD /api/video/style-file?projectId=..&relPath=..  —— 预览目录里的字节
  //
  // 只允许读预览目录（.dsh-video/style-preview/）下的文件：关键帧 PNG 与 8 秒 MP4 都走这里，
  // 面板的 <img> / <video> 直接用它。写法和 /api/video/media 一样：同一道 admit gate、同一套 Range。
  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/video/style-file',
      async handler(req, res) {
        const gate = await admitted(ctx, req);
        if (!gate.ok) return json(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: '需要 DSH 会话凭据' } });
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return json(res, 405, { ok: false, error: { code: 'METHOD', message: 'GET/HEAD only' } });
        }
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const projectId = url.searchParams.get('projectId');
          const relPath = url.searchParams.get('relPath');
          const entry = store.get(projectId);
          const layout = previewLayout();
          if (typeof relPath !== 'string' || !relPath.startsWith(layout.relDir + '/')) {
            throw new DomainError('INVALID_ARG', '只允许读预览目录里的文件');
          }
          const abs = stylePreviewAbs(entry.root, relPath);
          await sendFile(req, res, abs, mimeFor(abs));
        } catch (e) {
          if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'ERR_INVALID_ARG_TYPE')) {
            return json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '预览文件不存在' } });
          }
          fail(res, e);
        }
      },
    }),
  );

  // POST /api/video/style-upload?projectId=..&sessionId=..&kind=frame|video&index=&shotKind=
  //
  // 四张关键帧和 8 秒样片都是二进制：RPC 的 1MB 请求体会把它们卡死，所以走和
  // /api/video/import 同一条「原始字节」路线。文件名由 host 算（客户端只报 index+kind），
  // 客户端拿不到任意写盘能力。
  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/video/style-upload',
      async handler(req, res) {
        const gate = await admitted(ctx, req);
        if (!gate.ok) return json(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: '需要 DSH 会话凭据' } });
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } });
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const projectId = url.searchParams.get('projectId');
          const sessionId = url.searchParams.get('sessionId');
          const kind = url.searchParams.get('kind') || 'frame';
          const entry = store.get(projectId);
          store.assertSession(entry.doc, sessionId);
          const layout = previewLayout();
          let relPath;
          if (kind === 'video') {
            // 容器由导出端决定：没有 H.264 编码器就是 WebM，扩展名必须跟着走
            const container = url.searchParams.get('container') === 'webm' ? 'webm' : 'mp4';
            relPath = layout.videoRelPath(container);
          } else if (kind === 'frame') {
            const index = Number(url.searchParams.get('index'));
            const shotKind = String(url.searchParams.get('shotKind') || '');
            if (!Number.isInteger(index) || index < 0 || index >= SHOT_KINDS.length) {
              throw new DomainError('INVALID_ARG', `关键帧的 index 必须是 0–${SHOT_KINDS.length - 1}：收到 ${url.searchParams.get('index')}`);
            }
            if (!SHOT_KINDS.includes(shotKind)) {
              throw new DomainError('INVALID_ARG', '关键帧的 shotKind 不认识：' + shotKind);
            }
            relPath = `${layout.relDir}/frames/${layout.frameFileName(index, shotKind)}`;
          } else if (kind === 'click') {
            // 兜底：浏览器没有音频编码器时，样片里混不进节拍，就单独存一条 WAV
            relPath = layout.relClick;
          } else {
            throw new DomainError('INVALID_ARG', 'kind 只能是 frame / video / click');
          }
          const bytes = await readBody(req, MAX_STYLE_UPLOAD);
          if (!bytes.length) throw new DomainError('INVALID_ARG', '空文件');
          const abs = stylePreviewAbs(entry.root, relPath);
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          const tmp = abs + '.tmp-' + process.pid;
          await fsp.writeFile(tmp, bytes);
          await fsp.rename(tmp, abs);
          json(res, 200, { ok: true, value: { kind, relPath, absPath: abs, bytes: bytes.length } });
        } catch (e) {
          fail(res, e);
        }
      },
    }),
  );

  return () => disposers.forEach((d) => d());
}

/** 分镜 RPC 需要会话身份：工程按会话绑定，没有它就判不了「这份工程归谁」。 */
function sessionRpc(params) {
  const id = params && params.sessionId;
  if (!id) throw new DomainError('INVALID_ARG', 'storyboard.* 需要 sessionId：工作台会带上当前会话');
  return String(id);
}

/**
 * 租约的对外形状（面板与 agent 都吃这一份）：
 * leaseId / scope / label / sessionId / expiresAt / remainingMs / human。
 * human 走 lease.mjs 的 describeLease，和冲突文案保持同一套措辞。
 */
function leaseView(lease) {
  if (!lease) return null;
  return {
    leaseId: lease.leaseId,
    scope: lease.scope,
    label: lease.label || '',
    sessionId: lease.sessionId,
    expiresAt: lease.expiresAt,
    remainingMs: Math.max(0, lease.expiresAt - Date.now()),
    human: describeLease(lease),
  };
}

/**
 * RPC 侧的写入口：解析工程但不在这里校验会话 —— 鉴权统一交给
 * store.ensureWriteAccess（带 leaseId 时按租约找工程；没带时按会话自动领取）。
 */
function writeEntry(store, projectId, sessionId, leaseId) {
  return store.writeEntry(projectId, sessionId, leaseId);
}

async function dispatch(ctx, store, samples, method, params) {
  switch (method) {
    case 'ping':
      return { pong: true, at: Date.now() };

    // 给客户端的 doc 一律走 clientDoc（摘要 + annotations）：
    // 只给摘要会让时间线标注轨永远显示 0 —— 数据在盘上，界面读不到。
    case 'project.open': {
      const doc = await store.open(params.dir, params.sessionId);
      return { doc: store.clientDoc(doc) };
    }

    case 'project.restore': {
      const doc = await store.restore(params.sessionId);
      return { doc: doc ? store.clientDoc(doc) : null };
    }

    case 'project.delete': {
      return store.delete(params.projectId, params.sessionId, !!params.deleteFiles);
    }

    // ------------------------------------------------- 项目启用制（全局 2）----
    //
    // enabled 是「许可」，持久化在 ~/.dsh/video-enabled.json，额度跨会话共享；
    // active 只是客户端「此刻挂载了工作台」的内存状态，这里不表达、也不落盘。
    // 重启后即使还在 enabled 里，客户端也不会自动挂载 —— 那由 B1 的启动流程保证。

    case 'project.enabled.list': {
      return { enabled: await listEnabled(), max: MAX_ENABLED };
    }

    // 启用：root / title / sessionId 仍然只认 store 里的那份，不接受客户端自报。
    //
    // ★ 死锁在这里被解开：旧实现第一行就 store.get(projectId)，工程只要没在本进程
    //   打开就抛 REF_NOT_FOUND；而客户端又是「先 enable 再 open」—— 于是「启用」
    //   永远失败、「打开」永远轮不到，用户点了三次都进不去。
    //   现在：打开过就直接启用；没打开且客户端给了 dir，就先按 dir 把它打开
    //   （store.open 内部校验 BOUND_TO_OTHER_SESSION），再启用。两者都不满足才报错，
    //   且错误文案直接告诉调用方「带上 dir 重试」。
    case 'project.enable': {
      const requestedId = params.projectId || '';
      let entry = null;
      let opened = false;
      try {
        entry = requestedId ? store.get(requestedId) : null;
      } catch (e) {
        if (e.code !== 'REF_NOT_FOUND') throw e;
        entry = null;
      }
      if (!entry) {
        if (!params.dir) {
          throw new DomainError(
            'REF_NOT_FOUND',
            `工程未打开，请带上 dir 重试: ${requestedId || '(缺少 projectId)'}`,
            { projectId: requestedId },
          );
        }
        if (!params.sessionId) {
          throw new DomainError('INVALID_ARG', '按 dir 自愈打开工程需要 sessionId');
        }
        const doc = await store.open(params.dir, params.sessionId);
        entry = store.get(doc.projectId);
        opened = true;
      }
      const result = await enableProject({
        projectId: entry.doc.projectId,
        root: entry.root,
        sessionId: entry.doc.boundSessionId,
        title: entry.doc.title,
        // 面板点「启用」才占全局额度；agent 侧自动启用不占（见 enabled-registry 的 entryCounts）
        origin: 'panel',
      });
      // 脏数据自愈：登记表里的 projectId 和磁盘上的对不上（工程被删了又重建），
      // 刚启用的是真 id，旧条目就是一张永远点不动的幽灵卡片 —— 顺手删掉。
      let replaced = null;
      if (requestedId && requestedId !== entry.doc.projectId) {
        const removed = await disableEnabled(requestedId).catch(() => null);
        if (removed && removed.removed) replaced = requestedId;
      }
      return {
        enabled: result.enabled,
        max: MAX_ENABLED,
        already: result.already,
        added: result.added,
        projectId: entry.doc.projectId,
        doc: store.summarize(entry.doc),
        opened,
        replaced,
      };
    }

    // 停用：按 projectId 释放额度；工程没在本进程打开也能停（重启后照样能腾位置）
    case 'project.disable': {
      const result = await disableEnabled(params.projectId);
      return { enabled: result.enabled, max: MAX_ENABLED, removed: result.removed };
    }

    // 改名：校验在 store.rename 里（非空、≤ 60 字），落盘后返回摘要
    case 'project.rename': {
      const doc = await store.rename(params.projectId, params.sessionId, params.title);
      // 登记表里也改：否则别的会话看到的「占用者」会一直是旧名字
      await updateEnabledTitle(doc.projectId, doc.title).catch(() => {});
      return { doc };
    }

    // 换绑：停旧 → 启新 → 写绑定；任一步失败都不改绑定（见 store.rebind）
    case 'session.rebind': {
      return store.rebind(params.sessionId, params.projectId);
    }

    // 本会话的工程（选择面板 / 切换菜单的数据源）。绑定表本身仍是一个会话一个工程。
    //
    // ★ 不能只回 store.projectsForSession：那只有「本进程此刻打开」的工程。
    //   停用会把它从内存里放掉，重启更是从来没有过 —— 列表一空，卡片就消失，
    //   用户再也找不到自己的工程。现在由 store.projectCards 把三处并起来：
    //   已打开（带 doc 摘要）+ 全局登记表里本会话的条目 + 绑定表里本会话那条，
    //   按 projectId 去重，并逐张标 open / enabled / missing。
    case 'project.list': {
      return { projects: await store.projectCards(params.sessionId) };
    }

    case 'motion.doc': {
      const raw = await readEntryDoc(params.entryId);
      if (!raw) throw new DomainError('REF_NOT_FOUND', '没有这个条目的说明文档: ' + params.entryId);
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
      const LIMIT = 4000;
      return {
        entryId: params.entryId,
        doc: body.slice(0, LIMIT),
        truncated: body.length > LIMIT,
        totalChars: body.length,
      };
    }

    case 'motion.list': {
      const entries = await listEntries(params.query);
      // 缩略图需要源码。列表里只带 4KB 以内的小文件，避免把 RPC 响应撑大；
      // 超限条目返回 null，由面板显示「无预览」。
      const MAX_PREVIEW_BYTES = 4 * 1024;
      const codes = await Promise.all(
        entries.map(async (e) => {
          if (!e.native) return null;
          const code = await readEntryCode(e.id);
          if (!code || Buffer.byteLength(code, 'utf8') > MAX_PREVIEW_BYTES) return null;
          return code;
        }),
      );
      return {
        count: entries.length,
        entries: entries.map((e, index) => {
          const code = codes[index] || null;
          return {
            id: e.id,
            title: e.title,
            kind: e.kind,
            description: e.description,
            tags: e.tags,
            native: e.native,
            needRender: e.needRender,
            license: e.license,
            // code 是给缩略图渲染用的源码；preview 是同一份数据的兼容别名。
            code,
            preview: code,
          };
        }),
      };
    }

    case 'motion.insert': {
      const entry = writeEntry(store, params.projectId, params.sessionId, params.leaseId);
      const guard = store.ensureWriteAccess({
        projectId: entry.doc.projectId,
        sessionId: params.sessionId,
        leaseId: params.leaseId,
        target: { type: 'code' },
        label: 'motion.insert',
      });
      const leaseId = guard.lease ? guard.lease.leaseId : null;
      const code = await readEntryCode(params.entryId);
      if (!code) throw new DomainError('MOTION_NOT_NATIVE', '该动效没有原生实现，需要外部渲染成文件后导入');
      const layerId = 'motion-' + params.entryId;
      const written = await writeCode(entry.root, layerId, code);
      const clipId = 'm_' + Math.random().toString(36).slice(2, 8);
      const start = Math.max(0, Number(params.start) || 0);
      const duration = Math.max(0.2, Number(params.duration) || 3);
      const trackId = params.trackId || 'v2';
      const ops = [];
      // 旧工程可能没有 v2（画中画）轨，插入前先补建，避免 REF_NOT_FOUND
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
        provenance: { libraryId: 'motion-lib', assetId: params.entryId, hash: written.codeHash || null },
      });
      const preview = store.preview(
        entry.doc.projectId,
        params.sessionId,
        params.baseRevision,
        ops,
        undefined,
        'ui',
        leaseId,
      );
      const applied = await store.applyPreview(preview.previewId, params.sessionId, leaseId);
      return { ...applied, ...store.writeAccessInfo(guard) };
    }

    // 声音库：本地目录 + 可选 Freesound。下面三个 RPC 的字段名是客户端契约，不要改。
    // sort 透传给 Freesound（blend / rating / downloads），本地结果不受影响。
    case 'sound.search': {
      return searchSounds({
        query: params.query,
        source: params.source,
        limit: params.limit,
        maxDuration: params.maxDuration,
        sort: params.sort,
      });
    }

    case 'sound.insert': {
      return insertSound({
        store,
        sessionId: params.sessionId,
        projectId: params.projectId,
        entryId: params.entryId,
        start: params.start,
        trackId: params.trackId,
        baseRevision: params.baseRevision,
        leaseId: params.leaseId,
      });
    }

    case 'sound.preview': {
      return soundPreview({ entryId: params.entryId });
    }

    // 从直链导入一条音效到本地声音库（15 秒超时 / 50MB 上限，按域名归档）
    case 'sound.import': {
      const entry = await importSoundFromUrl(params.url, { rootName: params.rootName });
      return { entry };
    }

    // Kenney 音效包：list 只读网页；install 会下载并解压到某个根目录
    case 'sound.kenney.list': {
      const list = await listKenneyPacks();
      let roots = [];
      try {
        roots = await soundSourcesRoots();
      } catch {
        roots = [];
      }
      const packs = await Promise.all(
        (list.packs || []).map(async (pack) => {
          let installed = false;
          let files = 0;
          try {
            const slug = packSlugFromUrl(pack.url);
            for (const root of roots) {
              const dir = path.join(root.path, slug);
              try {
                // Kenney 的包解压后音频常在子目录里（casino-audio/Audio/*.ogg），必须递归找
                const names = await fsp.readdir(dir, { recursive: true });
                const audio = names.filter((n) => /\.(ogg|wav|mp3|flac|m4a)$/i.test(String(n)));
                if (audio.length) {
                  installed = true;
                  files += audio.length;
                }
              } catch {
                /* 该根下没有这个包，继续看下一个根 */
              }
            }
          } catch {
            installed = false;
          }
          return { ...pack, installed, files };
        }),
      );
      return { ...list, packs };
    }

    case 'sound.kenney.install': {
      return installKenneyPack({ packUrl: params.packUrl, rootName: params.rootName });
    }

    // 模板清单：只回说明书，不回命令
    case 'template.list': {
      return { templates: listTemplates() };
    }

    // 分镜：storyboard.json 是工程资产，客户端与 agent 工具走同一份实现
    case 'storyboard.read': {
      return readStoryboardDoc({
        store,
        projectId: params.projectId,
        sessionId: sessionRpc(params),
      });
    }

    case 'storyboard.save': {
      return saveStoryboard({
        store,
        projectId: params.projectId,
        sessionId: sessionRpc(params),
        srt: params.srt,
        maxShots: params.maxShots,
        leaseId: params.leaseId,
      });
    }

    case 'storyboard.apply': {
      return applyStoryboard({
        store,
        projectId: params.projectId,
        sessionId: sessionRpc(params),
        leaseId: params.leaseId,
        options: {
          force: params.force === true,
          trackId: params.trackId,
          effectTrackId: params.effectTrackId,
          baseRevision: params.baseRevision,
        },
      });
    }

    // 语音转字幕：status 只读探测；transcribe 立刻返回 jobId，进度走 asr.progress。
    // 30 分钟的转写不能吊在一个 HTTP 请求上，所以这里刻意做成「起任务 + 轮询」。
    case 'asr.status': {
      return detectAsr({ root: asrRoot() });
    }

    case 'asr.transcribe': {
      // 鉴权在 transcribeAsset 里：写入时间线时走 ensureWriteAccess（自动领 track:t1），
      // 只转写不落时间线时按会话归属校验。这里不再提前 assertSession，
      // 否则 teammate 拿 projectId + 自己的会话永远进不来。
      return startAsrJob({
        store,
        projectId: params.projectId || null,
        sessionId: params.sessionId || null,
        assetPath: params.assetPath,
        assetId: params.assetId,
        modelSize: params.modelSize,
        language: params.language,
        applyToTimeline: params.applyToTimeline === true,
        baseRevision: params.baseRevision,
        leaseId: params.leaseId,
      });
    }

    case 'asr.progress': {
      return getAsrJob(params.jobId);
    }

    // 文字转语音：probe 只读探测（缺什么当场摆出来）；voices 给面板下拉；
    // speak 一次事务完成「合成 → 登记素材 → a1 配音 + t1 字幕」。
    case 'tts.probe': {
      return ttsProbe({
        root: params.root || undefined,
        provider: params.provider || undefined,
        networkTimeoutMs: params.networkTimeoutMs,
      });
    }

    case 'tts.voices': {
      return {
        provider: currentProviderName(),
        count: listVoices().length,
        voices: listVoices(),
      };
    }

    case 'tts.speak': {
      const entry = store.get(params.projectId);
      // 写身份固定在工程绑定会话：tts.mjs 冻结中，内部仍按会话绑定写。
      // 租约这一步走统一入口：没传 leaseId 就自动领 audio，冲突抛 LEASE_CONFLICT。
      const sessionId = entry.doc.boundSessionId;
      const guard = store.ensureWriteAccess({
        projectId: params.projectId,
        sessionId,
        leaseId: params.leaseId,
        target: { type: 'audio' },
        label: 'tts.speak',
      });
      const value = await ttsSpeak({
        store,
        projectId: params.projectId,
        sessionId,
        text: params.text,
        voice: params.voice,
        rate: params.rate,
        pitch: params.pitch,
        start: params.start,
        baseRevision: params.baseRevision,
        provider: params.provider,
      });
      return { ...value, ...store.writeAccessInfo(guard) };
    }

    // 视频解析：手动触发（面板上的「解析」按钮 / agent 明确要求）。
    // 同步返回：14 秒的片子正常 3 秒内回来，所以不做「起任务 + 轮询」那套。
    // 超过 60 秒由 runAnalysis 抛 ANALYZE_TIMEOUT，不会把请求吊死。
    case 'analyze.run': {
      return runAnalysis({
        force: params.force === true,
        store,
        projectId: params.projectId,
        sessionId: params.sessionId || null,
        assetPath: params.assetPath,
        maxShots: params.maxShots,
        leaseId: params.leaseId,
      });
    }

    case 'analyze.read': {
      return readAnalysisFor({
        store,
        projectId: params.projectId,
        sessionId: params.sessionId || null,
      });
    }

    // 套用模板：命令在同一次事务里提交（preview → applyPreview），
    // 只有空工程能套用；项目文档只记 layerId，代码源码落在工程目录里。
    case 'template.apply': {
      const entry = writeEntry(store, params.projectId, params.sessionId, params.leaseId);
      const template = getTemplate(params.templateId);
      if (!template) throw new DomainError('REF_NOT_FOUND', '模板不存在: ' + params.templateId);
      if (entry.doc.clips.length > 0) throw new DomainError('INVALID_OP', '只能套用到空工程');
      const built = buildTemplate(params.templateId, { width: params.width, height: params.height });
      const guard = store.ensureWriteAccess({
        projectId: entry.doc.projectId,
        sessionId: params.sessionId,
        leaseId: params.leaseId,
        ops: built.ops,
        label: 'template.apply',
      });
      const leaseId = guard.lease ? guard.lease.leaseId : null;
      const code = templateCode(params.templateId);
      if (code) await writeCode(entry.root, code.layerId, code.source);
      const preview = store.preview(
        entry.doc.projectId,
        params.sessionId,
        params.baseRevision,
        built.ops,
        '套用模板：' + template.name,
        'ui',
        leaseId,
      );
      const applied = await store.applyPreview(preview.previewId, params.sessionId, leaseId);
      return { ...applied, ...store.writeAccessInfo(guard) };
    }

    case 'project.summary': {
      const entry = store.get(params.projectId);
      return { doc: store.summarize(entry.doc) };
    }

    // 开工阶段快照（只读）：给右侧检查器顶上那块「开工阶段」面板。
    // 读的是 dsh-video-brief 插件维护的 .dsh-video/{state,brief,style}.json；
    // 插件没装 / 没开始时三份文件都不存在，这里回 idle + warnings，不报错。
    case 'brief.state': {
      const entry = store.get(params.projectId);
      return readBriefState(entry.root);
    }

    // ------------------------------------------------------- 风格确认 S1 ----
    //
    // 三步走：
    //   1) style.default → 默认 spec + 摘要 + 面板可选值（打开面板先画出来）
    //   2) style.preview → 铺临时预览工程，回 4 个镜头定义 + 预览目录里已有的产物
    //   3) style.result  → 客户端把 4 张 PNG / 8 秒 MP4 传完之后，回来收路径
    //
    // Host 不能解码、也画不了 canvas，所以帧和样片必须由客户端渲染，再经
    // /api/video/style-upload 落盘。这里只保证一件事：工程是真的、路径是真的、越界一律拒绝。

    case 'style.default': {
      const spec = defaultStyleSpec();
      return {
        spec,
        summary: specToSummary(spec),
        previewSeconds: PREVIEW_SECONDS,
        shotKinds: SHOT_KINDS,
        shotLabels: SHOT_LABELS,
        densities: DENSITIES.map((id) => ({ id, label: DENSITY_LABELS[id] })),
        fonts: FONT_CHOICES,
        limits: LIMITS,
        // 节拍与对齐都不需要先生成样片：打开面板就能看见「这一版会怎么响、哪里不齐」
        click: clickSpecFor(spec),
        alignment: alignmentForSpec(spec),
      };
    }

    case 'style.preview': {
      const entry = store.get(params.projectId);
      store.assertSession(entry.doc, params.sessionId);
      // 先读上一轮的指纹：spec 没变就复用已经渲好的 4 张图 + 8 秒样片，变了就删掉重来
      const previous = await readStyleMeta(entry.root);
      const built = buildPreviewProject({
        projectRoot: entry.root,
        sessionId: params.sessionId,
        spec: params.spec,
      });
      const changed = !previous || previous.fingerprint !== built.fingerprint;
      if (changed) await clearStyleArtifacts(entry.root);
      const dir = await writeStyleFiles(entry.root, built.files);
      const artifacts = await scanStyleArtifacts(entry.root);
      return {
        spec: built.spec,
        requestedShotSeconds: built.requestedShotSeconds,
        summary: built.summary,
        fingerprint: built.fingerprint,
        shots: built.shots,
        duration: built.duration,
        notes: built.notes,
        reused: !changed,
        preview: {
          projectId: built.doc.projectId,
          relDir: built.layout.relDir,
          dir,
          revision: built.doc.revision,
          clipCount: built.doc.clips.length,
          duration: built.doc.duration,
          fps: built.doc.fps,
          width: 1280,
          height: 720,
        },
        ...styleArtifactsPayload(entry.root, artifacts),
        // 这一次铺工程算出来的节拍与对齐（artifacts 里的来自上一轮 style.json，可能还没有）
        click: built.click,
        alignment: built.alignment,
      };
    }

    case 'style.result': {
      const entry = store.get(params.projectId);
      store.assertSession(entry.doc, params.sessionId);
      const artifacts = await scanStyleArtifacts(entry.root);
      if (!artifacts.meta) {
        throw new DomainError('NOT_FOUND', '还没有生成过风格样片：先调 style.preview 铺好预览工程');
      }
      return {
        spec: artifacts.meta.spec,
        summary: artifacts.meta.summary,
        fingerprint: artifacts.meta.fingerprint,
        duration: artifacts.meta.duration,
        shots: artifacts.meta.shots,
        notes: ['frames 是工程内相对路径；少的那几张说明客户端还没把 PNG 传上来。'],
        ...styleArtifactsPayload(entry.root, artifacts),
      };
    }

    case 'project.timeline': {
      const entry = store.get(params.projectId);
      return {
        // 这是客户端 refresh() 唯一的数据源：必须带 annotations，
        // 否则每次写操作之后 state.doc.annotations 都会变成空数组，
        // 时间线标注轨和右侧「标注」页会一起显示 0。
        doc: store.clientDoc(entry.doc),
        annotations: Array.isArray(entry.doc.annotations) ? entry.doc.annotations : [],
        clips: store.listClips(entry.doc, params.trackId, params.offset || 0, params.limit || 500),
        assets: entry.doc.assets,
      };
    }

    // 运镜连续性（只读）：和 agent 工具 video_camera_check 同一条路径。
    // 给预览 / 检查器一个能拿到 warnings 的入口；不写盘、不改时间线、不阻止播放。
    case 'camera.check': {
      const entry = store.get(params.projectId);
      return checkProjectCamera({
        store,
        projectId: entry.doc.projectId,
        trackId: params.trackId || null,
        eps: params.eps,
      });
    }

    // ------------------------------------------------------- 写租约 ----------
    //
    // 一次 acquire 只锁一个范围：all（整工程）/ track:<id> / code / audio。
    // 不同范围可并行持有；同一范围冲突时回 LEASE_CONFLICT 并列出冲突方。
    // 租约只在内存里，DSH 重启后全部失效（见 docs/lease.md）。

    case 'lease.acquire': {
      const result = store.acquireLease(params.projectId, params.sessionId, params.scope, {
        ttlMs: params.ttlMs,
        label: params.label,
      });
      return {
        lease: leaseView(result.lease),
        conflicts: (result.conflicts || []).map(leaseView),
      };
    }

    case 'lease.release':
      return store.releaseLease(params.projectId, params.leaseId, params.sessionId);

    case 'lease.touch': {
      const lease = store.touchLease(params.projectId, params.leaseId);
      return { lease: leaseView(lease) };
    }

    case 'lease.ensure': {
      // 便利方法：面板 / 外部脚本写之前调一次，拿到（或复用）本会话在某个 scope 上的租约。
      const result = store.ensureLease(params.projectId, params.sessionId, params.scope || 'all', {
        label: params.label,
        ttlMs: params.ttlMs,
      });
      return {
        lease: leaseView(result.lease),
        acquired: result.acquired,
        reused: result.reused,
      };
    }

    case 'lease.list':
      return { leases: store.listLeases(params.projectId).map(leaseView) };

    case 'edit.preview': {
      const entry = writeEntry(store, params.projectId, params.sessionId, params.leaseId);
      const guard = store.ensureWriteAccess({
        projectId: entry.doc.projectId,
        sessionId: params.sessionId,
        leaseId: params.leaseId,
        ops: params.ops,
        label: 'edit.preview',
      });
      const leaseId = guard.lease ? guard.lease.leaseId : null;
      const value = store.preview(
        entry.doc.projectId,
        params.sessionId,
        params.baseRevision,
        params.ops,
        params.summary,
        params.origin,
        leaseId,
      );
      return { ...value, ...store.writeAccessInfo(guard) };
    }

    case 'edit.apply': {
      const info = store.previewTargets(params.previewId);
      const guard = store.ensureWriteAccess({
        projectId: info.projectId,
        sessionId: params.sessionId,
        leaseId: params.leaseId,
        target: info.targets,
        label: 'edit.apply',
      });
      const leaseId = guard.lease ? guard.lease.leaseId : null;
      const applied = await store.applyPreview(params.previewId, params.sessionId, leaseId);
      return { ...applied, ...store.writeAccessInfo(guard) };
    }

    case 'edit.undo':
      return store.undo(params.projectId, params.sessionId, params.transactionId);

    // 多步撤销：undoLast 撤最近一步，redo 重做刚撤的一步，history 给 UI 取两个栈。
    // 都走 assertSession —— 工程是「一个工程绑一个会话」，别人的栈不许动。
    case 'edit.undoLast':
      return store.undoLast(params.projectId, params.sessionId);

    case 'edit.redo':
      return store.redoLast(params.projectId, params.sessionId);

    case 'edit.history':
      return store.history(params.projectId, params.sessionId);

    case 'annotations.list': {
      const entry = store.get(params.projectId);
      return { annotations: entry.doc.annotations };
    }

    case 'annotations.add': {
      const entry = writeEntry(store, params.projectId, params.sessionId, params.leaseId);
      const guard = store.ensureWriteAccess({
        projectId: entry.doc.projectId,
        sessionId: params.sessionId,
        leaseId: params.leaseId,
        target: { type: 'project' },
        label: 'annotations.add',
      });
      const leaseId = guard.lease ? guard.lease.leaseId : null;
      // ★ 和面板的「＋标注」走同一个构造函数：id / range 归一 / intent 白名单
      //   只有一份实现，两条入口写出来的结构才不会分叉。
      //   以前这里直接透传 params，于是非法 intent 能进库、range 也不归一。
      const op = annotationOp({
        annotationId: params.annotationId,
        range: params.range,
        intent: params.intent,
        expected: params.expected,
        target: params.target,
      });
      if (params.author) op.author = String(params.author);
      const p = store.preview(
        entry.doc.projectId,
        params.sessionId,
        params.baseRevision,
        [op],
        '新增标注',
        'ui',
        leaseId,
      );
      const applied = await store.applyPreview(p.previewId, params.sessionId, leaseId);
      const doc = store.get(entry.doc.projectId).doc;
      return {
        annotationId: params.annotationId,
        annotation: (doc.annotations || []).find((a) => a && a.id === params.annotationId) || null,
        annotations: doc.annotations || [],
        ...applied,
        ...store.writeAccessInfo(guard),
      };
    }

    // 删除一条标注：走和编辑命令同一条链（租约 → preview → applyPreview），
    // 不是「直接从 doc 里抹掉」。返回被删条目 + 剩余条数，删不掉时给可读错误。
    // 同时接受 annotation.remove / annotations.remove 两种叫法（老调用方只认单数前缀）。
    case 'annotations.remove':
    case 'annotation.remove': {
      const entry = writeEntry(store, params.projectId, params.sessionId, params.leaseId);
      const value = await store.removeAnnotation(entry.doc.projectId, params.sessionId, params.annotationId, {
        leaseId: params.leaseId,
        baseRevision: params.baseRevision,
        origin: 'ui',
        label: 'annotations.remove',
      });
      return { ...value, ...store.writeSite(store.get(entry.doc.projectId).doc) };
    }

    // 修改标注：只认白名单字段（expected / intent / range / status）。
    // 非法状态 / 倒挂区间在这里就被拒，不会写进 doc。
    case 'annotations.update':
    case 'annotation.update': {
      const entry = writeEntry(store, params.projectId, params.sessionId, params.leaseId);
      const value = await store.updateAnnotation(
        entry.doc.projectId,
        params.sessionId,
        params.annotationId,
        {
          expected: params.expected,
          intent: params.intent,
          range: params.range,
          status: params.status,
        },
        {
          leaseId: params.leaseId,
          baseRevision: params.baseRevision,
          origin: 'ui',
          label: 'annotations.update',
        },
      );
      return { ...value, ...store.writeSite(store.get(entry.doc.projectId).doc) };
    }

    // 标注导出：返回与面板「全部提交」完全同一段文本，agent 侧据此对齐。
    // 不写盘、不改 revision；没解析过就只给秒，不编镜头号。
    case 'annotations.export': {
      const entry = store.get(params.projectId);
      if (params.sessionId) store.assertSession(entry.doc, params.sessionId);
      const analysis = await readAnalysis(entry.doc.root);
      const annotations = Array.isArray(entry.doc.annotations) ? entry.doc.annotations : [];
      return {
        count: annotations.length,
        text: exportAnnotations(annotations, analysis),
        annotations: annotations.map((a) => ({
          ...enrichAnnotation(a.range || { start: 0, end: 0 }, analysis),
          id: a.id,
          intent: a.intent || 'change',
          expected: a.expected || '',
          status: a.status || 'open',
        })),
      };
    }

    // 解析完 → 备份原片 → 剥离 → 降级为只读参考 → 按镜头表建骨架。
    // 没有 analysis.json 就明确拒绝：不允许拿「没解析过的片子」建骨架。
    case 'reference.apply': {
      const analysis = await readAnalysisFor({
        store,
        projectId: params.projectId,
        sessionId: params.sessionId || null,
      });
      if (!analysis || analysis.ok !== true) {
        throw new DomainError('INVALID_OP', '先解析再降级');
      }
      return applyReference(store, params.sessionId, {
        projectId: params.projectId,
        assetId: params.assetId,
        analysis,
        baseRevision: params.baseRevision,
      });
    }

    // 扫描 assets 目录：返回磁盘上有什么，由调用方决定是否登记到工程
    case 'asset.scan': {
      const entry = store.get(params.projectId);
      await ensureAssetDirs(entry.doc.root);
      const files = await scanAssets(entry.doc.root);
      return { files, known: entry.doc.assets.map((a) => a.path) };
    }

    // 浏览器探测出的时长/尺寸写回工程
    case 'asset.probe': {
      const entry = writeEntry(store, params.projectId, params.sessionId, params.leaseId);
      const guard = store.ensureWriteAccess({
        projectId: entry.doc.projectId,
        sessionId: params.sessionId,
        leaseId: params.leaseId,
        target: { type: 'project' },
        label: 'asset.probe',
      });
      const leaseId = guard.lease ? guard.lease.leaseId : null;
      const p = store.preview(
        entry.doc.projectId,
        params.sessionId,
        undefined,
        [{ type: 'asset.setProbe', assetId: params.assetId, probe: params.probe }],
        '写入素材探测',
        'ui',
        leaseId,
      );
      const applied = await store.applyPreview(p.previewId, params.sessionId, leaseId);
      return { ...applied, ...store.writeAccessInfo(guard) };
    }

    // 仅供测试/诊断：直接读一小段字节（走同一守卫）
    case 'asset.range': {
      const entry = store.get(params.projectId);
      const asset = entry.doc.assets.find((a) => a.id === params.assetId);
      if (!asset) throw new DomainError('REF_NOT_FOUND', '素材不存在: ' + params.assetId);
      const abs = await resolveAssetPath(entry.doc.root, asset.path);
      const r = await readRange(abs, params.start || 0, params.length || 1024, { root: entry.doc.root });
      return { start: r.start, length: r.length, size: r.size };
    }

    // 脏数据扫描：音频素材被放在视频轨上的片段。
    // 打开工程时先问一次，面板据此给可读提示 —— **不阻塞预览**（渲染器会跳过音频）。
    case 'timeline.audioIssues': {
      const entry = store.get(params.projectId);
      return Object.assign({ projectId: entry.doc.projectId }, describeAudioTrackIssues(entry.doc));
    }

    // 一键修复：把这些片段移到音频轨（a1）。一次事务，可撤销。
    case 'timeline.repairAudio': {
      const entry = store.get(params.projectId);
      store.assertSession(entry.doc, params.sessionId);
      const plan = planAudioRepair(entry.doc);
      if (!plan.ops.length) {
        return Object.assign({ projectId: entry.doc.projectId, moved: 0, ops: 0 }, describeAudioTrackIssues(entry.doc));
      }
      const guard = store.ensureWriteAccess({
        projectId: entry.doc.projectId,
        sessionId: params.sessionId,
        target: { type: 'project' },
        label: 'timeline.repairAudio',
      });
      const leaseId = guard.lease ? guard.lease.leaseId : null;
      const p = store.preview(
        entry.doc.projectId,
        params.sessionId,
        undefined,
        plan.ops,
        '音频素材移回音频轨',
        'ui',
        leaseId,
      );
      const applied = await store.applyPreview(p.previewId, params.sessionId, leaseId);
      const doc = store.get(entry.doc.projectId).doc;
      return Object.assign(
        {
          projectId: entry.doc.projectId,
          moved: plan.moved.length,
          clips: plan.moved,
          ops: plan.ops.length,
          revision: applied.revision,
          human: applied.human,
        },
        describeAudioTrackIssues(doc),
      );
    }

    // 采样：agent 要帧，面板轮询并回传
    case 'sample.pending': {
      const entry = store.get(params.projectId);
      // 面板每 700ms 轮询一次 —— 这就是「面板开着」的心跳，video_probe 靠它判断
      samples?.touchPoll(entry.doc.projectId);
      return { requests: samples ? samples.list(entry.doc.projectId) : [] };
    }

    case 'sample.fulfill': {
      const entry = store.get(params.projectId);
      store.assertSession(entry.doc, params.sessionId);
      if (!samples) throw new DomainError('INVALID_OP', '采样服务未启用');
      samples.touchPoll(entry.doc.projectId);
      return samples.fulfill(entry.doc.projectId, entry.doc.root, params.requestId, params.files);
    }

    // 成片回填（面板侧）：只记元数据。真正的字节走 POST /api/video/export。
    case 'export.record': {
      const entry = store.get(params.projectId);
      store.assertSession(entry.doc, params.sessionId);
      const recorded = await store.recordExport(
        entry.doc.projectId,
        {
          path: params.path,
          duration: params.duration,
          size: params.size,
          source: params.source || 'workbench',
          fps: params.fps,
          sourceFps: params.sourceFps,
        },
        { actor: 'panel' },
      );
      return { ...recorded, exports: store.exportList(store.get(entry.doc.projectId).doc) };
    }

    case 'export.list': {
      const entry = store.get(params.projectId);
      return { projectId: entry.doc.projectId, exports: store.exportList(entry.doc) };
    }

    case 'code.read': {
      const entry = store.get(params.projectId);
      const source = await readCode(entry.doc.root, params.layerId);
      return { layerId: params.layerId, source };
    }

    case 'code.list': {
      const entry = store.get(params.projectId);
      return { layers: await listCodeLayers(entry.doc.root) };
    }

    default:
      throw new DomainError('INVALID_OP', `未知方法: ${method}`);
  }
}
