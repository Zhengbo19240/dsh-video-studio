/**
 * 声音库的 agent 工具 + 宿主侧共用逻辑。
 *
 * 工具与 RPC 走同一份实现：
 *   searchSounds()  —— 本地优先，在线追加；在线失败只进 warnings，不让整个搜索失败
 *   insertSound()   —— importBytes 落盘 → asset.add → clip.insert → 淡入淡出，一次事务
 *   soundPreview()  —— 本地与在线都返回可直接播放的 URL（本地走宿主的 /api/video/sound）
 *
 * 工具结果保持小而稳定：id、revision、人话摘要，不传媒体字节。
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DomainError, normalizeAudioPatch } from './domain.mjs';
import { sanitizeJson } from './json-safe.mjs';
import { importBytes, resolveAssetPath } from './media.mjs';
import {
  soundRoot,
  soundSourcesRoots,
  scanLocal,
  searchLocal,
  resolveLocalPath,
  findLocalEntry,
  readDuration,
} from './sound-lib.mjs';
import {
  MEASURED_CAVEAT,
  SHAPE_VALUES,
  BRIGHTNESS_VALUES,
  MATERIAL_VALUES,
  loadSoundIndex,
  pickMeasuredFilters,
  hasMeasuredFilters,
  filterByMeasured,
  decorateMeasured,
} from './sound-index.mjs';
import { listKenneyPacks, installKenneyPack } from './sound-kenney.mjs';
import { importSoundFromUrl } from './sound-import.mjs';
import {
  freesoundEnabled,
  searchFreesound,
  downloadFreesoundPreview,
  getCachedEntry,
  normalizeFreesoundSort,
} from './sound-freesound.mjs';

/** 时长未知时的兜底片段长度（秒） */
const DEFAULT_DURATION = 3;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const FADE_IN = 0.05;
const FADE_OUT = 0.15;
/** 降级最多换几次词（不含原查询本身） */
const MAX_DEGRADE_ATTEMPTS = 3;
/** 取文件落点：统一放工程根的 assets/sfx/，与时间线素材分开，找得着 */
const SFX_DIR = 'assets/sfx';

/**
 * 音乐类素材的识别词。只看素材库自带的分类 / 标签 / 标题（不看用户的重命名），
 * 命中就写 audioRole:'music' —— 它会被 a1 上的人声 ducking 压下去。
 * 判断不出来返回 null：保持未标注，播放与导出按 sfx 处理，不参与 ducking。
 */
const MUSIC_HINT = /(^|[^a-z])(music|musical|jingle|jingles|theme|soundtrack|ost|bpm|loop|ambient)([^a-z]|$)/i;

function inferAudioRole(entry) {
  if (!entry || typeof entry !== 'object') return null;
  // 只看素材库自己的元数据：category / 包名 / 标题 / 标签。
  // 刻意不看 entry.id 和 entry.root —— 用户把库根目录叫成 “music” 不该让整库都变 music。
  const parts = [entry.category, entry.packId, entry.title, entry.providerId];
  if (Array.isArray(entry.tags)) parts.push(...entry.tags);
  const hay = parts.filter((v) => typeof v === 'string' && v).join(' ');
  return hay && MUSIC_HINT.test(hay) ? 'music' : null;
}

const textBlocks = (value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
];

/**
 * 注册一个工具。
 *
 * ★ 所有 video_sound_* 的返回值都要过 sanitizeJson：工具层的「lossless JSON」闸门
 * 会因为一个 undefined 键拒收整条结果，而调用方只会看到「音效库不可用」。
 * 把它放在这里，是不指望每个 execute 自己记得。
 */
function define(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: { schema: { type: 'object' }, render: (_args, value) => textBlocks(value) },
    execute: async (args, exec) => sanitizeJson(await execute(args, exec)),
  };
}

function sessionOf(exec) {
  const id = exec && exec.agent && exec.agent.id;
  if (!id) throw new DomainError('NO_SESSION', '该工具只能在一个会话里调用');
  return id;
}

// ------------------------------------------------------------------ 搜索 ---

/**
 * 校验声学过滤参数。拼错的值直接抛 INVALID_ARG —— 静默返回空结果比报错更难查。
 * material 只在入参里叫 material，落到测量值上永远是 materialGuess。
 */
function validateMeasuredFilters({ shape, brightness, material }) {
  if (shape != null && shape !== '' && !SHAPE_VALUES.includes(shape)) {
    throw new DomainError('INVALID_ARG', `shape 只能是 ${SHAPE_VALUES.join(' / ')}`);
  }
  if (brightness != null && brightness !== '' && !BRIGHTNESS_VALUES.includes(brightness)) {
    throw new DomainError('INVALID_ARG', `brightness 只能是 ${BRIGHTNESS_VALUES.join(' / ')}`);
  }
  // materialGuess 实测系统性反号（impactMetal_* 被判成木质、人声 113/142 被判成金属），
  // 拿它当筛选条件会筛错——比不给还坏。所以先停用过滤，只保留 measured.materialGuess 作为排序提示。
  // 恢复的前提：用资源包名（impactWood/impactMetal/impactPlank）当弱标签重新标定阈值。
  if (material != null && material !== '') {
    throw new DomainError(
      'INVALID_ARG',
      'material 过滤已停用：实测该维度系统性反号（金属撞击被判成木质、人声被判成金属），' +
        '用它筛选会筛错。要找某种质感请用 query + shape + brightness 组合，' +
        '并把返回里的 measured.materialGuess 当排序提示、实际音色仍需试听确认。',
    );
  }
}

/**
 * 搜索声音库。source='all' 时本地在前、在线在后，总条数不超过 limit。
 * 在线源失败（含没配 key）只写 warnings，不抛错；显式 source='freesound' 时如实抛。
 *
 * sort 只作用于 Freesound：blend（默认，评分 + 下载量 + 时长）/ rating / downloads。
 * 首轮就校验，避免一个拼错的 sort 被当成「在线失败」塞进 warnings。
 *
 * 时长：minDuration / maxDuration 同时存在时校验 min ≤ max；在线拼成
 * filter=duration:[min TO max]，本地按时长过滤。下限存在时时长未知的本地条目会被排除
 * （不能证明它够长），并给一条 DURATION_UNKNOWN 的 warning 说明排除了几条。
 *
 * ★ 多词查询 0 结果会自动降级（关键词是 AND 语义，这是真的会咬人的坑）：
 * 依次「去掉最不常见的词」→「取最长的词」→「取第一个词」，最多 3 次。
 * 命中时返回 degraded:true + degradedQuery；三次都空就如实返回 0 条 + degraded:false，
 * 不把「真的没有」伪装成「降级过还是没有」。
 *
 * 声学过滤（shape / brightness / material / maxDurationMs）只作用于本地库：Freesound
 * 的结果没有测量数据。本地条目命中时带 measured + measuredCaveat —— 那是测量值，
 * 不是听感结论，调用方必须把这句话连同结果一起给用户。
 */
export async function searchSounds({
  query,
  source = 'all',
  limit = DEFAULT_LIMIT,
  minDuration,
  maxDuration,
  sort,
  shape,
  brightness,
  material,
  maxDurationMs,
} = {}) {
  const src = source == null || source === '' ? 'all' : String(source);
  if (!['all', 'local', 'freesound'].includes(src)) {
    throw new DomainError('INVALID_ARG', 'source 只能是 all / local / freesound');
  }
  const sortMode = normalizeFreesoundSort(sort);
  validateMeasuredFilters({ shape, brightness, material });

  const size = clampInt(limit, 1, MAX_LIMIT);
  const win = durationWindow({ minDuration, maxDuration });
  const measuredFilters = pickMeasuredFilters({ shape, brightness, material, maxDurationMs });
  const useMeasured = hasMeasuredFilters(measuredFilters);
  const originalQuery = String(query == null ? '' : query).trim();
  const warnings = [];

  if (useMeasured && src === 'freesound') {
    warnings.push({
      source: 'freesound',
      code: 'MEASURED_LOCAL_ONLY',
      message: 'shape / brightness / material / maxDurationMs 只能过滤本地库条目，在线结果没有测量数据',
    });
  }

  /** 跑一次检索（一个查询词），返回本地/在线结果与告警；降级时会被调用多次。 */
  async function collectOnce(q) {
    const out = { local: [], localTotal: 0, remote: [], entries: [], hits: 0, onlineFailed: false, warnings: [] };

    if (src === 'all' || src === 'local') {
      const matched = await searchLocal(q);
      const kept = [];
      let unknown = 0;
      for (const entry of matched) {
        const verdict = durationVerdict(entry, win);
        if (verdict === 'out') continue;
        if (verdict === 'unknown') {
          unknown += 1; // 下限过滤时，时长未知不能算「够长」
          continue;
        }
        kept.push(entry);
      }
      if (unknown) {
        out.warnings.push({
          source: 'local',
          code: 'DURATION_UNKNOWN',
          message:
            unknown +
            ' 条本地条目测不出时长，已按 minDuration 排除（wav/flac/m4a/mp3/ogg 可读到时长，aac 目前读不出）',
        });
      }

      let index = null;
      if (useMeasured || kept.length) {
        index = await loadSoundIndex();
        if (index.warning) out.warnings.push({ source: 'local', code: 'INDEX_WARNING', message: index.warning });
      }

      if (useMeasured) {
        if (!index.exists) {
          // 没有索引 ≠ 没有匹配：如实说「还没测」而不是返回一个假空
          out.warnings.push({
            source: 'local',
            code: 'NO_MEASURED_INDEX',
            message:
              '本地还没有声学索引（' +
              index.file +
              '），按 shape / brightness / material 过滤时不会命中任何条目；先跑 node tools/analyze-sounds.mjs',
          });
          kept.length = 0;
        } else {
          kept.splice(0, kept.length, ...filterByMeasured(kept, measuredFilters, index).entries);
        }
      }

      out.localTotal = kept.length;
      out.local = kept.slice(0, size).map((e) => decorateMeasured(e, index));
    }

    if (src === 'all' || src === 'freesound') {
      try {
        out.remote = await searchFreesound(q, {
          limit: size,
          minDuration: win.min,
          maxDuration: win.max,
          sort: sortMode,
        });
      } catch (e) {
        if (src === 'freesound') throw e;
        out.onlineFailed = true;
        out.warnings.push({
          source: 'freesound',
          code: e && e.code ? e.code : 'INTERNAL',
          message: e && e.message ? e.message : String(e),
        });
      }
    }

    if (src === 'freesound') out.entries = out.remote.slice(0, size);
    else if (src === 'local') out.entries = out.local;
    else out.entries = out.local.concat(out.remote.slice(0, Math.max(0, size - out.local.length)));

    out.hits = out.localTotal + out.remote.length;
    return out;
  }

  let picked = await collectOnce(originalQuery);
  let degradedQuery = null;
  const tried = [];

  // 测量过滤下的 0 条是「过滤器」造成的，换词只会把「没测」和「没词」混成一件事；
  // 在线源自己出错（网络 / 没 key）也不是词的问题 —— 这两种情况都不降级。
  const canDegrade = !useMeasured && tokensOf(originalQuery).length > 1;
  if (canDegrade && picked.hits === 0 && !picked.onlineFailed) {
    for (const candidate of await degradeCandidates(originalQuery)) {
      tried.push(candidate);
      const next = await collectOnce(candidate);
      if (next.onlineFailed) break;
      if (next.hits > 0) {
        picked = next;
        degradedQuery = candidate;
        break;
      }
    }
    if (!degradedQuery && tried.length) {
      warnings.push({
        source: 'query',
        code: 'DEGRADE_EXHAUSTED',
        message:
          '原查询「' +
          originalQuery +
          '」无结果；依次试了「' +
          tried.join('」「') +
          '」也没有匹配。这是真的没有，不是工具坏了。',
      });
    }
  }

  warnings.push(...picked.warnings);
  if (degradedQuery) {
    warnings.push({
      source: 'query',
      code: 'QUERY_DEGRADED',
      message: '原查询「' + originalQuery + '」无结果，已降价为「' + degradedQuery + '」',
    });
  }

  // 注意：这里不能出现「值为 undefined 的键」。
  // JSON.stringify 会丢掉它，往返后结构就变了，工具层会把整个结果判成「非无损 JSON」拒收。
  // 只有真的需要时才把 measuredCaveat 放进去（上一次就是这里让 Freesound 搜索整条废掉）。
  // 现在额外过一遍 sanitizeJson 兜底，见文件顶部 define() 的说明。
  const needsCaveat = useMeasured || picked.entries.some((e) => e && e.measured);
  return sanitizeJson({
    count: picked.entries.length,
    total: picked.hits,
    entries: picked.entries,
    warnings,
    degraded: degradedQuery != null,
    degradedQuery,
    ...(needsCaveat ? { measuredCaveat: MEASURED_CAVEAT } : {}),
  });
}

/**
 * 时长窗口：{ min, max }，非法值当没给，min > max 直接抛 INVALID_ARG。
 * 两个都给时先校验再查 —— 否则会向下游拼出一个必然为空的 duration 过滤器。
 */
function durationWindow({ minDuration, maxDuration } = {}) {
  const min = positiveSeconds(minDuration);
  const max = positiveSeconds(maxDuration);
  if (min != null && max != null && min > max) {
    throw new DomainError('INVALID_ARG', 'minDuration（' + min + ' 秒）不能大于 maxDuration（' + max + ' 秒）');
  }
  return { min, max };
}

/** 正数秒；其它（含 0 / NaN / 字符串 '12'）返回 null，不静默当成有值 */
function positiveSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * 单条本地条目的时长判定：
 *   in      —— 命中
 *   out     —— 明确超出窗口
 *   unknown —— 时长测不出来（只有 aac 等少数格式）；下限存在时由调用方排除并告警
 * 只给上限时，未知时长的条目放行（沿用旧语义：不能证明超限就不排除）。
 */
function durationVerdict(entry, win) {
  const raw = entry && entry.duration;
  const d = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  if (win.max != null && d != null && d > win.max) return 'out';
  if (win.min != null) {
    // 下限：拿一条 0.05 秒的点击声去凑 60 秒的 BGM，比空结果更糟
    if (d == null) return 'unknown';
    if (d < win.min) return 'out';
  }
  return 'in';
}

/** 查询词：按空白切分，空查询返回空数组（空查询没有可降级的东西） */
function tokensOf(q) {
  return String(q == null ? '' : q).trim().split(/\s+/).filter(Boolean);
}

/**
 * 降级候选词，最多 3 个，顺序固定：
 *   ① 去掉最不常见的词（用本地库的命中数当语料；没有语料时按「越长越罕见」近似）
 *   ② 取最长的词
 *   ③ 取第一个词
 * 与原查询重复、与前面候选重复的会被丢掉（不浪费一次网络请求）。
 */
async function degradeCandidates(q) {
  const tokens = tokensOf(q);
  if (tokens.length < 2) return [];

  const counts = await tokenHitCounts(tokens);
  const dropIndex = pickRarestIndex(tokens, counts);
  const original = tokens.join(' ');
  const out = [];
  const push = (candidate) => {
    const text = tokensOf(candidate).join(' ');
    if (!text || text === original || out.includes(text)) return;
    if (out.length >= MAX_DEGRADE_ATTEMPTS) return;
    out.push(text);
  };

  push(
    tokens
      .filter((_, i) => i !== dropIndex)
      .join(' '),
  );
  push(tokens[pickLongestIndex(tokens)]);
  push(tokens[0]);
  return out;
}

/** 每个词在本地库里命中多少条（拿它当「常见程度」的语料，只读、不联网） */
async function tokenHitCounts(tokens) {
  let haystack = [];
  try {
    const entries = await scanLocal();
    haystack = entries.map((e) =>
      [e.title, e.providerId, e.category, Array.isArray(e.tags) ? e.tags.join(' ') : '']
        .filter((v) => typeof v === 'string' && v)
        .join(' ')
        .toLowerCase(),
    );
  } catch {
    haystack = []; // 库读不动不该让搜索失败：按「没有语料」处理
  }
  return tokens.map((token) => {
    const needle = token.toLowerCase();
    return haystack.filter((h) => h.includes(needle)).length;
  });
}

/** 命中数最少的词（并列时取更长的，再并列取靠前的） */
function pickRarestIndex(tokens, counts) {
  let best = 0;
  for (let i = 1; i < tokens.length; i += 1) {
    const cur = counts[i] || 0;
    const bestCount = counts[best] || 0;
    if (cur < bestCount) {
      best = i;
      continue;
    }
    if (cur === bestCount && tokens[i].length > tokens[best].length) best = i;
  }
  return best;
}

/** 最长的词（并列取靠前的） */
function pickLongestIndex(tokens) {
  let best = 0;
  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i].length > tokens[best].length) best = i;
  }
  return best;
}

// ------------------------------------------------------------------ 插入 ---

/**
 * 把一条声音插到音频轨（默认 a1），一次事务完成：
 *   track.add（轨道不存在时）→ asset.add → clip.insert → fadeIn / fadeOut
 *
 * projectId 省略时用 sessionId 绑定的工程；baseRevision 只给 RPC 用（过期就冲突）。
 */
export async function insertSound({
  store,
  sessionId,
  projectId,
  entryId,
  start,
  trackId = 'a1',
  volume,
  fadeIn,
  fadeOut,
  baseRevision,
  leaseId,
} = {}) {
  if (!store) throw new DomainError('INVALID_ARG', '缺少 store');
  if (!sessionId) throw new DomainError('NO_SESSION', '插入声音需要 sessionId');

  const project = store.writeEntry(projectId, sessionId, leaseId);
  const doc = project.doc;
  // 先过租约闸门再碰声音库 / 落盘：没有租约时不该先下载或写 assets。
  // 没传 leaseId 时这里会自动为本会话领 audio 租约（冲突抛 LEASE_CONFLICT）。
  const guard = store.ensureWriteAccess({
    projectId: doc.projectId,
    sessionId,
    leaseId,
    target: { type: 'audio' },
    label: 'video_sound_insert',
  });
  const resolvedLeaseId = guard.lease ? guard.lease.leaseId : null;
  // 先校验能独立校验的部分（volume / muted / 负数淡入淡出），避免为一个必然失败的请求
  // 先下载或复制几十 MB 音频。片段时长相关的和值校验在 duration 算出来之后再做一次。
  normalizeAudioPatch(
    {
      volume: volume === undefined || volume === null ? 1 : volume,
      fadeIn: fadeIn === undefined || fadeIn === null ? FADE_IN : fadeIn,
      fadeOut: fadeOut === undefined || fadeOut === null ? FADE_OUT : fadeOut,
    },
    Number.POSITIVE_INFINITY,
    'video_sound_insert',
  );
  const loaded = await loadSoundEntry(entryId);

  // 先落盘：importBytes 自己会挑不冲突的文件名，不会覆盖已有素材
  const imported = await importBytes(doc.root, { name: loaded.name, bytes: loaded.bytes });
  const assetId = 'asset_' + Math.random().toString(36).slice(2, 10);
  const clipId = 'snd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const tid = String(trackId || 'a1');

  const duration =
    typeof loaded.entry.duration === 'number' && Number.isFinite(loaded.entry.duration) && loaded.entry.duration > 0
      ? loaded.entry.duration
      : DEFAULT_DURATION;

  const fadeInValue = fadeIn === undefined || fadeIn === null ? FADE_IN : fadeIn;
  const fadeOutValue = fadeOut === undefined || fadeOut === null ? FADE_OUT : fadeOut;
  // 与 clip.setAudio 共用同一套校验：volume 0..2、fade 之和不超过片段时长。
  // 音效的默认淡入淡出（0.05 / 0.15）也在这里过一遍，短素材不会被写出非法值。
  const audioProps = normalizeAudioPatch(
    { volume: volume === undefined || volume === null ? 1 : volume, fadeIn: fadeInValue, fadeOut: fadeOutValue },
    duration,
    'video_sound_insert',
  );

  const ops = [];
  if (!doc.tracks.some((t) => t.id === tid)) {
    ops.push({ type: 'track.add', trackId: tid, kind: 'audio', name: tid === 'a1' ? '音频' : tid });
  }
  ops.push({
    type: 'asset.add',
    assetId,
    relPath: imported.relPath,
    name: imported.name,
    size: imported.size,
    hash: imported.hash,
    mime: imported.mime,
  });
  ops.push({
    type: 'clip.insert',
    clipId,
    trackId: tid,
    clipType: 'media',
    assetId,
    start: Math.max(0, Number(start) || 0),
    duration,
    // 音量 / 淡入淡出直接随 clip.insert 落进片段，省掉一次编辑事务
    ...audioProps,
    // 注意：domain 的 clip.insert 只保留 libraryId / assetId / hash / license 四项，
    // attribution 和 source 会在这里被丢掉（domain.mjs 不在本次改动范围内）。
    provenance: {
      libraryId: 'sound-lib',
      assetId: loaded.entry.id,
      license: loaded.entry.license || null,
      attribution: loaded.entry.attribution || null,
      source: loaded.provider,
    },
  });

  // 音乐类素材标 music（参与人声回避）；其余一律标 sfx，这样响度归一会生效。
  // 未标注的片段（例如导入视频自带声）不参与归一，避免把原有对白重新拉平。
  const audioRole = inferAudioRole(loaded.entry) || 'sfx';
  ops.push({ type: 'clip.set_property', clipId, property: 'audioRole', value: audioRole });

  let applied;
  try {
    const preview = store.preview(doc.projectId, sessionId, baseRevision, ops, '插入声音', 'agent', resolvedLeaseId);
    applied = await store.applyPreview(preview.previewId, sessionId, resolvedLeaseId);
  } catch (e) {
    // 事务失败时把刚写进 assets 的文件移除，避免留下孤儿文件
    await removeImported(doc.root, imported.relPath);
    throw e;
  }

  return {
    clipId,
    assetId,
    revision: applied.revision,
    volume: audioProps.volume,
    fadeIn: audioProps.fadeIn || 0,
    fadeOut: audioProps.fadeOut || 0,
    ...(audioRole ? { audioRole } : {}),
    human: applied.human,
    ...store.writeAccessInfo(guard),
  };
}

/** 读一条声音的字节和落盘文件名：本地读文件，在线下载预览 */
async function loadSoundEntry(entryId) {
  const id = String(entryId == null ? '' : entryId).trim();
  if (!id) throw new DomainError('INVALID_ARG', '缺少条目 id entryId');

  if (/^freesound:/i.test(id)) {
    const cached = getCachedEntry(id);
    if (!cached) {
      throw new DomainError('NOT_FOUND', '缓存里没有这个在线条目，请先调用 video_sound_search 搜索一次');
    }
    const got = await downloadFreesoundPreview(cached);
    return {
      entry: cached,
      bytes: got.bytes,
      name: soundFilename(cached.title || 'freesound-' + cached.providerId, got.contentType),
      provider: 'freesound',
    };
  }

  const entry = await findLocalEntry(id);
  if (!entry) throw new DomainError('NOT_FOUND', '声音库里没有这个条目: ' + id);
  const abs = await resolveLocalPath(entry.id);

  let bytes;
  try {
    bytes = await fs.readFile(abs);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
      throw new DomainError('NOT_FOUND', '声音文件不存在: ' + abs);
    }
    throw new DomainError('IO_FAILED', '读取声音文件失败: ' + e.message);
  }
  return { entry, bytes, name: path.basename(abs), provider: 'local' };
}

// ---------------------------------------------------------------- 取文件 ---

/**
 * 把一条声音的音频复制/下载到工程根的 assets/sfx/，给「只想拿文件」的场景用。
 *
 * 这是整条链路里唯一不碰时间线的工具：
 *   - 不插片段、不改 doc：revision / clips / assets 前后完全一致
 *   - 不领租约：它只写文件，不写工程数据，所以不需要写权限
 *   - 本地条目直接复制；在线条目下载预览音频（必须先 search 过一次，否则缓存里没有）
 *
 * 落点与去重（assets/sfx/ 故意与时间线素材 assets/ 分开，人一眼能找到）：
 *   - 文件名用条目自己的名字；重名依次加 -1、-2……
 *   - 写之前先比「同大小 + sha256 前 8 位」：同一份内容复用已有文件，不堆副本
 *   - 失败一律是带 code 的 DomainError（下载失败 / 超限 / 本地条目不存在 / 写盘失败），
 *     不把原始异常直接甩给调用方
 */
export async function fetchSound({ store, sessionId, projectId, entryId } = {}) {
  if (!store) throw new DomainError('INVALID_ARG', '缺少 store');
  if (!sessionId) throw new DomainError('NO_SESSION', '取音效文件需要 sessionId');
  const id = String(entryId == null ? '' : entryId).trim();
  if (!id) throw new DomainError('INVALID_ARG', '缺少条目 id entryId');

  // 只解析工程、不领租约：这里只写文件，不动 doc，所以不需要写权限。
  // 显式传 projectId 时仍校验会话归属 —— 不领租约不等于谁都能往别人工程里写文件。
  const project = store.writeEntry(projectId, sessionId);
  if (projectId) store.assertSession(project.doc, sessionId);
  const root = project.doc.root;

  const loaded = await loadSoundEntry(id);

  const dirAbs = await resolveAssetPath(root, SFX_DIR);
  try {
    await fs.mkdir(dirAbs, { recursive: true });
  } catch (e) {
    throw new DomainError('IO_FAILED', '创建 ' + SFX_DIR + ' 失败: ' + e.message);
  }

  const bytes = loaded.bytes;
  const hash8 = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  const placed = await placeSfxFile(root, dirAbs, targetName(loaded.name), bytes, hash8);

  // 时长：条目自带优先（本地扫描/接口返回都算过），否则现场按文件头读一次
  let durationMs = null;
  const seconds = loaded.entry && loaded.entry.duration;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    durationMs = Math.round(seconds * 1000);
  } else {
    const absPath = await resolveAssetPath(root, placed.relPath);
    const parsed = await readDuration(absPath, path.extname(absPath));
    if (parsed && parsed.duration > 0) durationMs = Math.round(parsed.duration * 1000);
  }

  const abs = await resolveAssetPath(root, placed.relPath);
  return sanitizeJson({
    entryId: loaded.entry.id,
    localPath: abs,
    relPath: placed.relPath,
    name: placed.name,
    bytes: bytes.length,
    durationMs,
    source: loaded.provider,
    reused: placed.reused,
    human:
      '已取到 ' +
      placed.relPath +
      '（' +
      Math.max(1, Math.round(bytes.length / 1024)) +
      ' KB，' +
      (loaded.provider === 'local' ? '本地库' : 'Freesound') +
      (placed.reused ? '，复用已有文件' : '') +
      '）',
  });
}

/**
 * 把字节放进 assets/sfx/，返回 { name, relPath, reused }。
 * reused=true 表示目录里已有同大小同内容（sha256 前 8 位一致）的文件。
 */
async function placeSfxFile(root, dirAbs, name, bytes, hash8) {
  const existing = await readDirSafe(dirAbs);

  for (const file of existing) {
    const abs = path.join(dirAbs, file);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size !== bytes.length) continue;
    let hash;
    try {
      hash = createHash('sha256').update(await fs.readFile(abs)).digest('hex').slice(0, 8);
    } catch {
      continue;
    }
    if (hash === hash8) return { name: file, relPath: SFX_DIR + '/' + file, reused: true };
  }

  const { base, ext } = splitFilename(name);
  for (let i = 0; i < 1000; i += 1) {
    const candidate = i === 0 ? base + ext : base + '-' + i + ext;
    // 每个候选都过一遍工程路径守卫：文件名来自素材标题，不能假定它干净
    const abs = await resolveAssetPath(root, SFX_DIR + '/' + candidate);
    if (await fileExists(abs)) continue;
    await writeBytesAtomic(abs, bytes);
    return { name: candidate, relPath: SFX_DIR + '/' + candidate, reused: false };
  }
  throw new DomainError('IO_FAILED', 'assets/sfx 下同名文件过多，放弃写入: ' + name);
}

/** 先写 .tmp 再 rename：中途失败不留半截文件，也不覆盖已有文件 */
async function writeBytesAtomic(abs, bytes) {
  const tmp = abs + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try {
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw new DomainError('IO_FAILED', '写入音效文件失败: ' + e.message);
  }
}

async function readDirSafe(dir) {
  try {
    return await fs.readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
    throw new DomainError('IO_FAILED', '读取 ' + SFX_DIR + ' 失败: ' + e.message);
  }
}

async function fileExists(abs) {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

/** 落盘用的文件名：去掉路径成分与 Windows 非法字符 */
function targetName(name) {
  const base = path.basename(String(name == null ? '' : name));
  const cleaned = base.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || 'sound.mp3';
}

function splitFilename(name) {
  const ext = path.extname(name);
  const base = (ext ? name.slice(0, -ext.length) : name).trim();
  return { base: base || 'sound', ext };
}

/** 在线预览只有 mp3/ogg/wav 几种，按 content-type 给扩展名 */
function extensionFor(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('ogg')) return '.ogg';
  if (ct.includes('wav')) return '.wav';
  if (ct.includes('flac')) return '.flac';
  if (ct.includes('mp4') || ct.includes('m4a') || ct.includes('aac')) return '.m4a';
  return '.mp3';
}

function soundFilename(title, contentType) {
  const base = String(title || 'sound').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80).trim() || 'sound';
  return base + extensionFor(contentType);
}

async function removeImported(root, relPath) {
  try {
    const abs = await resolveAssetPath(root, relPath);
    await fs.rm(abs, { force: true });
  } catch {
    /* 清理失败不影响主错误 */
  }
}

// ------------------------------------------------------------------ 预览 ---

/**
 * 预览：本地与在线都返回可播 URL。
 *
 * 本地条目仍先过 resolveLocalPath —— 越界或文件不在库里就抛错，不发出一个必然 404 的地址；
 * 校验通过后把 id 编码进只读试听路由，由路由负责 Range 与 Content-Type。
 */
export async function soundPreview({ entryId } = {}) {
  const id = String(entryId == null ? '' : entryId).trim();
  if (!id) throw new DomainError('INVALID_ARG', '缺少条目 id entryId');

  if (/^freesound:/i.test(id)) {
    const cached = getCachedEntry(id);
    if (!cached) {
      throw new DomainError('NOT_FOUND', '缓存里没有这个在线条目，请先调用 video_sound_search 搜索一次');
    }
    if (!cached.previewUrl) throw new DomainError('NOT_FOUND', '该条目没有预览音频');
    return { kind: 'url', url: cached.previewUrl };
  }

  await resolveLocalPath(id);
  return { kind: 'url', url: '/api/video/sound?entryId=' + encodeURIComponent(id) };
}

// ------------------------------------------------------------------ 状态 ---

/**
 * 本机声音库状态：每个根目录的条目数 + 在线源是否可用。
 *
 * localRoot 保留给旧界面/旧脚本：取第一个根；roots 是新的权威形状
 * [{ name, path, count }]，顺序与配置一致。
 */
export async function soundSources() {
  const roots = await soundSourcesRoots();
  const entries = await scanLocal();
  const counts = new Map(roots.map((r) => [r.name, 0]));
  for (const entry of entries) {
    counts.set(entry.root, (counts.get(entry.root) || 0) + 1);
  }

  const enabled = freesoundEnabled();
  return {
    localRoot: roots.length ? roots[0].path : soundRoot(),
    localCount: entries.length,
    roots: roots.map((r) => ({ name: r.name, path: r.path, count: counts.get(r.name) || 0 })),
    freesound: {
      enabled,
      reason: enabled ? '已配置 FREESOUND_API_KEY' : '未配置 FREESOUND_API_KEY',
    },
  };
}

// ------------------------------------------------------------------- 工具 ---

export function soundTools({ store }) {
  return [
    define(
      'video_sound_search',
      [
        '搜索音效素材：本地声音库（Kenney 整包 / 手动下载 / URL 导入）+ Freesound 在线结果，返回 id、时长、标签、授权与试听地址。',
        '',
        '什么时候用 Freesound（source=freesound 或 all）：本地找不到合适素材，或需要真实质感时搜 whoosh（掠过）、click（按键）、impact（撞击）、riser（上升）、typing（打字）、ambience（环境）这类关键词。',
        '什么时候用本地（source=local）：UI 点击 / 按钮 / 开关这类短音效优先本地 —— Kenney 包更稳、CC0 无版权风险，也不依赖网络。',
        '',
        'sort 只作用于 Freesound：blend（默认，综合评分与下载量）/ rating（纯评分）/ downloads（纯下载量）。blend 会降权评分样本少于 3 条的条目，避免 1 个 5 星排第一。',
        'duration 单位是秒：本地只有 wav/flac/m4a/mp3/ogg 能给出，其余为 null。挑之前先看它贴不贴镜头时长。',
        '找 BGM 用 minDuration / maxDuration 卡时长区间（两者都给时 min 必须 ≤ max，否则 INVALID_ARG）。在线拼成 filter=duration:[min TO max]。',
        'minDuration 存在时，本地测不出时长的条目会被排除并给一条 DURATION_UNKNOWN warning —— 不能证明它够长就不冒充。',
        'loopable：在线条目按 Freesound 的 loop 标签给 true/false（false = 没打这个标签，不代表不能循环）；本地给 null（判断不了）。',
        '',
        '★ 多词是 AND 语义。多词查询 0 结果时会自动降级：依次「去掉最不常见的词」→「取最长的词」→「取第一个词」，最多 3 次。',
        '命中时返回 degraded:true 与 degradedQuery（实际用的词），warnings 里有一条 QUERY_DEGRADED 说明降价过程。',
        '三次都空就如实返回 0 条、degraded:false，并给 DEGRADE_EXHAUSTED —— 那是真的没有，不是工具坏了。',
        '在线失败（例如没配 FREESOUND_API_KEY）不会吞掉本地结果，而是写进 warnings；warnings[].code 就是原因（NO_API_KEY / NETWORK / …）。',
        '',
        '★ 声学过滤（只作用于本地库）：shape=短促/中/拖尾、brightness=暗/中/亮、material=金属倾向/木质倾向/塑料倾向/合成倾向、maxDurationMs。',
        '命中的本地条目会多一个 measured={ shape, brightness, materialGuess, centroidHz, decayMs } 和 measuredCaveat。',
        '这些是**声学测量值**（ffmpeg 频谱统计 + PCM 包络），不是听感结论：materialGuess 只表示「更像哪类材质的物理特征」，',
        '绝不能对用户说「这就是金属声」。必须把 measuredCaveat 一起转述，并让用户试听确认。',
        '没有 measurements 的条目不会因为「看着像」被放行 —— 过滤时它就是不命中。',
        '本地还没有 ~/.dsh/sound-index.json 时，声学过滤会返回空结果并给一条 NO_MEASURED_INDEX 的 warning，先跑 node tools/analyze-sounds.mjs。',
        '',
        '典型调用链：video_sound_search（source=all, sort=blend）→ 看 duration 是否贴合镜头 → video_sound_insert 插到 a1（自动淡入淡出）。',
        '只想拿文件、不进工程时间线（例如自己用 ffmpeg 拼片）→ 用 video_sound_fetch，别自己去 Invoke-WebRequest 下 mp3。',
      ].join('\n'),
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词；省略则列出本地全部（在线源需要关键词）' },
          source: { type: 'string', enum: ['all', 'local', 'freesound'], description: '默认 all' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: '总条数上限，默认 20' },
          minDuration: { type: 'number', description: '只要不短于这个时长（秒）的条目；找 BGM 时和 maxDuration 一起用' },
          maxDuration: { type: 'number', description: '只要不超过这个时长（秒）的条目，可省略' },
          sort: {
            type: 'string',
            enum: ['rating', 'downloads', 'blend'],
            description: 'Freesound 排序：blend 综合（默认）/ rating 评分 / downloads 下载量',
          },
          shape: {
            type: 'string',
            enum: ['短促', '中', '拖尾'],
            description: '按衰减形状过滤本地条目（声学测量：decay<150ms 短促 / 150-500 中 / >500 拖尾）',
          },
          brightness: {
            type: 'string',
            enum: ['暗', '中', '亮'],
            description: '按频谱质心过滤本地条目（<800Hz 暗 / 800-2500 中 / >2500 亮）',
          },
          material: {
            type: 'string',
            enum: ['金属倾向', '木质倾向', '塑料倾向', '合成倾向'],
            description: '已停用：实测 materialGuess 系统性反号（金属撞击被判成木质、人声被判成金属），拿它筛选会筛错。传任何值都会报 INVALID_ARG',
          },
          maxDurationMs: { type: 'number', description: '只要测量时长不超过这个毫秒数的本地条目' },
        },
        additionalProperties: false,
      },
      async (args) =>
        searchSounds({
          query: args.query,
          source: args.source,
          limit: args.limit,
          minDuration: args.minDuration,
          maxDuration: args.maxDuration,
          sort: args.sort,
          shape: args.shape,
          brightness: args.brightness,
          material: args.material,
          maxDurationMs: args.maxDurationMs,
        }),
    ),

    define(
      'video_sound_insert',
      [
        '把一条声音插到音频轨（默认 a1），一次事务完成：落盘到工程 assets、登记素材、插入片段、淡入 0.05 / 淡出 0.15。',
        '',
        '用法：先用 video_sound_search 拿到 entryId。local 条目读库里的文件；freesound 条目下载预览音频，必须先搜过一次（否则缓存里没有，会报 NOT_FOUND）。',
        '时长未知时按 3 秒兜底；返回 clipId / assetId / revision / volume / fadeIn / fadeOut，可用 video_timeline_inspect 核对片段时长。',
        '',
        '音量：volume 0..2，默认 1（写进新片段的 clip.volume，不再需要二次 clip.setAudio）。淡入淡出默认 0.05 / 0.15 秒，可用 fadeIn / fadeOut 覆盖；两者之和不能超过片段时长（超了直接报错，不静默夹紧）。',
        '配乐盖住口播时：先把这个工具的 volume 调到 0.3–0.5，或对已有片段用 video_edit_preview 的 clip.setAudio 改；再用 video_audio_mix 核对有效峰值。',
        '',
        '时长和镜头对不上时：本工具不做任何裁切，只按素材时长建片段。不要为了对齐去改素材 —— 要么把片段起点挪到该响的位置，要么提示用户，再考虑用 clip.trim 把片段裁短。',
        '禁止：不要用振荡器 / 合成器生成方波、正弦波来「造」音效凑数。那不是素材，听感也不对；找不到就换关键词、换来源，或让用户提供。',
      ].join('\n'),
      {
        type: 'object',
        properties: {
          entryId: { type: 'string', description: '条目 id（来自 video_sound_search）' },
          start: { type: 'number', description: '时间线起点（秒），默认 0' },
          trackId: { type: 'string', description: '默认 a1；轨道不存在时会自动建' },
          volume: { type: 'number', minimum: 0, maximum: 2, description: '片段音量 0..2，默认 1；配乐建议 0.3–0.5' },
          fadeIn: { type: 'number', minimum: 0, description: '淡入秒数，默认 0.05；与 fadeOut 之和不能超过片段时长' },
          fadeOut: { type: 'number', minimum: 0, description: '淡出秒数，默认 0.15；与 fadeIn 之和不能超过片段时长' },
          projectId: { type: 'string', description: '省略则用当前会话绑定的工程' },
          sessionId: { type: 'string', description: '省略则用当前工具调用的会话' },
          leaseId: { type: 'string', description: '写租约 id（音频轨需要 audio 租约）' },
        },
        required: ['entryId'],
        additionalProperties: false,
      },
      async (args, exec) =>
        insertSound({
          store,
          sessionId: args.sessionId || sessionOf(exec),
          projectId: args.projectId,
          entryId: args.entryId,
          start: args.start,
          trackId: args.trackId,
          volume: args.volume,
          fadeIn: args.fadeIn,
          fadeOut: args.fadeOut,
          leaseId: args.leaseId,
        }),
    ),

    define(
      'video_sound_fetch',
      [
        '把一条声音的音频文件取到工程根 assets/sfx/ 并返回本地路径 —— 给「只想拿文件、不进时间线」的场景用。',
        '',
        '和 video_sound_insert 的区别：本工具不插片段、不改工程文档（revision / clips / assets 都不变）、不占写租约，只落一个文件。',
        '什么时候用：你要自己用 ffmpeg 拼片、或在别处引用这条音频。',
        '禁止：别再自己 Invoke-WebRequest 下 mp3 绕开声音库 —— 那样文件在库里、片子在外面，成片和工作台就分家了。',
        '',
        '用法：先用 video_sound_search 拿到 entryId。本地条目直接复制；freesound 条目下载预览音频，必须先搜过一次（否则缓存里没有，会报 NOT_FOUND）。',
        '落点：<工程根>/assets/sfx/<原名>。重名依次加 -1、-2；目录里已有同大小同内容（sha256 前 8 位一致）的文件时直接复用（reused:true）。',
        '返回 { localPath, relPath, name, bytes, durationMs, source, reused }。',
      ].join('\n'),
      {
        type: 'object',
        properties: {
          entryId: { type: 'string', description: '条目 id（来自 video_sound_search）' },
          projectId: { type: 'string', description: '省略则用当前会话绑定的工程' },
          sessionId: { type: 'string', description: '省略则用当前工具调用的会话' },
        },
        required: ['entryId'],
        additionalProperties: false,
      },
      async (args, exec) =>
        fetchSound({
          store,
          sessionId: args.sessionId || sessionOf(exec),
          projectId: args.projectId,
          entryId: args.entryId,
        }),
    ),

    define(
      'video_sound_sources',
      [
        '返回本机声音库状态：每个根目录（name / path / count）与总条目数，以及 Freesound 在线源是否可用。',
        '',
        '排错第一步：搜索为空或 warnings 里有 NO_API_KEY 时先调它。freesound.enabled=false 说明 DSH 进程里没有 FREESOUND_API_KEY —— 终端 setx 之后必须重启 DSH 才会生效。',
        'localCount=0 说明本地库还没有音效：用 video_sound_kenney 装 Kenney 包，或用 video_sound_import 从直链导入。',
      ].join('\n'),
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async () => soundSources(),
    ),

    define(
      'video_sound_kenney',
      '从 kenney.nl 获取 CC0 音效包。action=list 列出音频分类里的资源包；action=install 下载并解压一个（需要 packUrl，可省略 rootName，默认第一个根目录）。解压优先用系统 tar，其次 PowerShell Expand-Archive；两者都失败时保留 zip 并明确说明需手动解压。下载超时 5 分钟、上限 500MB，解压目标必须在已配置的声音库根目录内。',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'install'], description: 'list=列清单；install=下载安装' },
          packUrl: { type: 'string', description: 'install 必填：来自 list 的资源页地址' },
          rootName: { type: 'string', description: 'install 可选：装到哪个根目录，省略用第一个' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async (args) => {
        if (args.action === 'install') {
          const result = await installKenneyPack({ packUrl: args.packUrl, rootName: args.rootName });
          return {
            ...result,
            message: result.installed
              ? `已安装 ${result.packName || ''}：${result.files} 个音频文件 → ${result.root}`
              : `已下载但需要手动解压：${result.reason}`,
          };
        }
        return listKenneyPacks();
      },
    ),

    define(
      'video_sound_import',
      '从 http/https 直链下载一条音效到本地声音库：15 秒超时、50MB 上限，只接受 audio/* 响应或 .mp3/.wav/.ogg/.m4a/.flac/.aac 后缀；按域名归档到 <root>/<域名>/<文件名>，重名自动加 -1。省略 rootName 时用第一个根目录。',
      {
        type: 'object',
        properties: {
          url: { type: 'string', description: '音效直链（http/https）' },
          rootName: { type: 'string', description: '装到哪个根目录，省略用第一个' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      async (args) => {
        const entry = await importSoundFromUrl(args.url, { rootName: args.rootName });
        return {
          entry,
          message: `已导入「${entry.title}」→ ${entry.root}/${entry.providerId}`,
        };
      },
    ),
  ];
}

function clampInt(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  return Math.min(Math.max(Math.trunc(n), lo), hi);
}
