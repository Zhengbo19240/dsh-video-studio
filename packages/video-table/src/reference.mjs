/**
 * 解析完成后的备份动作。
 *
 * 设计（2026-11 定稿）：
 *   原片继续留在时间线，作为编辑对象；备份只做两件事 ——
 *     1. 把原片复制到 <工程根>/reference/，防止原片被改坏；
 *     2. 把 asset.previewPath 指向备份，让预览解码走备份而不是原片。
 *   不剥离片段、不建骨架、不改 status —— 那些会动到用户的编辑内容。
 *
 * buildSkeletonOps 保留为工具函数（将来「按镜头表生成新工程」会用到），
 * 但 applyReference 不再调用它。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DomainError } from './domain.mjs';
import { resolveAssetPath } from './media.mjs';

/** 备份目录：<工程根>/reference/。和 assets/ 平级，不参与素材扫描。 */
export const REFERENCE_DIR = 'reference';

const round3 = (n) => Math.round(n * 1000) / 1000;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertAssetId(assetId) {
  if (typeof assetId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(assetId)) {
    throw new DomainError('INVALID_ARG', `素材 id 不合法（只接受字母数字 _ -）：${String(assetId)}`);
  }
}

function assertRoot(root) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new DomainError('INVALID_ARG', '缺少工程目录 root');
  }
}

/**
 * 把原片复制到 <root>/reference/<assetId><ext>，返回工程内相对路径（posix 分隔符）。
 *
 * - 已存在且非空：直接复用，不重复占盘（reused: true）。
 * - 目标路径必须过 resolveAssetPath：assetId 被拼进路径，任何 `..` 都逃不出去。
 * - 源文件不在或不是普通文件时抛 NOT_FOUND / INVALID_ARG，不做静默回退。
 */
export async function backupOriginal(root, assetAbsPath, assetId) {
  assertRoot(root);
  assertAssetId(assetId);
  if (typeof assetAbsPath !== 'string' || assetAbsPath === '') {
    throw new DomainError('INVALID_ARG', '缺少原片绝对路径 assetAbsPath');
  }

  const src = path.resolve(assetAbsPath);
  let stat;
  try {
    stat = await fsp.stat(src);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      throw new DomainError('NOT_FOUND', `原片不在了：${src}`);
    }
    throw new DomainError('IO_FAILED', `读取原片失败：${(e && e.message) || e}`);
  }
  if (!stat.isFile()) throw new DomainError('INVALID_ARG', `不是普通文件：${src}`);

  const ext = path.extname(src).toLowerCase();
  const relPath = `${REFERENCE_DIR}/${assetId}${ext}`;

  // 目录先建出来；resolveAssetPath 对新目录也会做词法 + 真实路径两层校验
  const dirAbs = await resolveAssetPath(root, REFERENCE_DIR);
  await fsp.mkdir(dirAbs, { recursive: true });
  const target = await resolveAssetPath(root, relPath);

  try {
    const existing = await fsp.stat(target);
    if (existing.isFile() && existing.size > 0) {
      return { relPath, abs: target, size: existing.size, reused: true };
    }
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw new DomainError('IO_FAILED', `检查备份失败：${(e && e.message) || e}`);
  }

  // 先写临时文件再 rename：中途失败不会留下半截备份让下次误判「已存在」
  const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fsp.copyFile(src, tmp);
    await fsp.rename(tmp, target);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (e instanceof DomainError) throw e;
    throw new DomainError('IO_FAILED', `备份原片失败：${(e && e.message) || e}`, { src, target });
  }

  const size = (await fsp.stat(target)).size;
  return { relPath, abs: target, size, reused: false };
}

/**
 * 把镜头表规整成连续的 [start, end)：补上片头/镜头之间的缝、把尾巴拉到总时长，
 * 保证骨架首尾与原件一致。返回 [{index, start, end, duration}]，index 从 1 开始。
 */
export function normalizeShots(analysis) {
  const raw = analysis && Array.isArray(analysis.shots) ? analysis.shots : null;
  if (!raw || !raw.length) {
    throw new DomainError('INVALID_OP', '没有镜头表：先解析再降级');
  }
  const list = raw
    .map((shot, i) => {
      const start = Number(shot && shot.start);
      const end = Number(shot && shot.end);
      const given = Number(shot && shot.index);
      return {
        index: Number.isFinite(given) && given > 0 ? Math.round(given) : i + 1,
        start: round3(Math.max(0, Number.isFinite(start) ? start : 0)),
        end: round3(Math.max(0, Number.isFinite(end) ? end : 0)),
      };
    })
    .sort((a, b) => a.start - b.start || a.index - b.index);

  const total = Number(analysis && analysis.meta && analysis.meta.duration);
  const tail = Number.isFinite(total) && total > 0 ? round3(total) : list[list.length - 1].end;

  // 片头补齐：第一个镜头从 0 开始（原片解析出来本来就是 0，这里只是兜底）
  list[0].start = 0;
  // 镜间缝隙：把前一个镜头的结尾拉长到下一个镜头的起点（重叠的不动，保持原样）
  for (let i = 1; i < list.length; i += 1) {
    if (list[i].start > list[i - 1].end) list[i - 1].end = list[i].start;
  }
  // 片尾补齐：最后一个镜头拉到总时长
  list[list.length - 1].end = Math.max(list[list.length - 1].end, tail);
  // 起点早于 0 的已经钳过；结尾超过总时长的再钳一次
  for (const shot of list) shot.end = Math.min(shot.end, Math.max(shot.start, tail));

  const shots = [];
  for (const shot of list) {
    const duration = round3(shot.end - shot.start);
    if (duration <= 0.001) continue; // 零长度镜头没法建片段，跳过（不制造非法命令）
    shots.push({ index: shot.index, start: shot.start, end: shot.end, duration });
  }
  if (!shots.length) throw new DomainError('INVALID_OP', '镜头表里没有可用的时长：先重新解析');
  return shots;
}

/** 骨架片段的标记：重跑时靠它认出上一轮的骨架，先删后插。 */
export function isSkeletonClip(clip, assetId) {
  if (!clip || clip.type !== 'text' || !clip.style || clip.style.skeleton !== true) return false;
  if (assetId == null) return true;
  const of = clip.style.skeletonOf;
  return of == null || of === assetId;
}

/**
 * 镜头表 → clip.insert 命令数组。每镜一个文字占位，文字就是「第 N 镜」。
 *
 * 总时长与原件一致：normalizeShots 已经把首尾和缝隙补齐，所以最后一个片段的
 * end 一定等于 analysis.meta.duration。
 */
export function buildSkeletonOps(analysis, { trackId = 'v1', assetId = null } = {}) {
  if (typeof trackId !== 'string' || trackId === '') {
    throw new DomainError('INVALID_ARG', 'trackId 必须是非空字符串');
  }
  const shots = normalizeShots(analysis);
  const token = randomBytes(4).toString('hex');
  const markerAsset = assetId || (analysis && analysis.assetId) || null;

  return shots.map((shot) =>
    ({
      type: 'clip.insert',
      clipId: `sk_${token}_${String(shot.index).padStart(3, '0')}`,
      trackId,
      clipType: 'text',
      start: shot.start,
      duration: shot.duration,
      text: `第 ${shot.index} 镜`,
      style: { skeleton: true, skeletonOf: markerAsset, shotIndex: shot.index },
    }),
  );
}

/**
 * 一次事务完成「备份 + 剥离 + 降级 + 骨架」。
 *
 * 顺序是刻意的：
 *   1) 备份（事务外）—— 失败了直接抛，时间线一个字节都没动；
 *   2) 删掉主轨上引用该素材的片段（以及上一轮留下的骨架）；
 *   3) asset.setStatus 'reference'；
 *   4) 按镜头表插骨架。
 *
 * 返回 { revision, transactionId, backedUpTo, removedClips, removedClipIds,
 *        skeletonClips, skeletonClipIds, shotCount }。
 */
export async function applyReference(store, sessionId, { projectId, assetId, baseRevision } = {}) {
  if (!store || typeof store.get !== 'function') throw new DomainError('INVALID_ARG', '缺少 store');
  if (!projectId) throw new DomainError('INVALID_ARG', 'reference.apply 需要 projectId');
  if (!sessionId) throw new DomainError('INVALID_ARG', 'reference.apply 需要 sessionId');
  if (!assetId) throw new DomainError('INVALID_ARG', 'reference.apply 需要 assetId');

  const entry = store.get(projectId);
  store.assertSession(entry.doc, sessionId);
  const doc = entry.doc;
  const asset = doc.assets.find((a) => a.id === assetId);
  if (!asset) throw new DomainError('REF_NOT_FOUND', `素材不存在：${assetId}`);

  // 1) 备份：纯磁盘操作，事务外；失败即中止，不留状态
  const srcAbs = await resolveAssetPath(doc.root, asset.path);
  const backup = await backupOriginal(doc.root, srcAbs, assetId);

  // 2) 只改一个字段：预览解码走备份，原片继续留在时间线上下，供编辑
  const preview = store.preview(
    projectId,
    sessionId,
    baseRevision,
    [{ type: 'asset.setPreviewPath', assetId, previewPath: backup.relPath }],
    `备份原片：${asset.name || assetId}`,
  );
  const applied = await store.applyPreview(preview.previewId, sessionId);

  return {
    revision: applied.revision,
    transactionId: applied.transactionId,
    backedUpTo: backup.relPath,
    backupReused: backup.reused,
    backupSize: backup.size,
    assetId,
  };
}
