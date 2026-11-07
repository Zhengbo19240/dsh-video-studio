/**
 * Media layer: 素材目录、导入、路径守卫与 Range 读取。
 *
 * 约定：
 *  - 工程目录的唯一权威是 host 进程里的 root；本模块不碰 cache/exports 的内容。
 *  - 所有落在磁盘上的路径都必须先过 resolveAssetPath（唯一守卫），
 *    它同时做词法检查与 realpath 检查，挡住 `..`、绝对路径和符号链接逃逸。
 *  - 写入一律“先写 .tmp 再 rename”，不会留下半截文件，也不覆盖已有素材。
 *  - 只用 node 内置模块，不引第三方依赖。
 */

import { createHash } from 'node:crypto';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DomainError } from './domain.mjs';

/** 工程内固定目录 */
export const PROJECT_DIRS = ['assets', 'cache', 'exports'];

/** 文件名长度上限 */
const MAX_NAME = 120;

// --------------------------------------------------------------- 路径守卫 ---

/**
 * 把工程内相对路径解析成绝对路径；任何逃出 root 的路径都抛 OUTSIDE_PROJECT。
 * 这是唯一的路径守卫，其它导出函数都走它。
 */
export async function resolveAssetPath(root, relPath) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new DomainError('INVALID_ARG', '缺少工程目录 root');
  }
  if (typeof relPath !== 'string' || relPath === '') {
    throw new DomainError('INVALID_ARG', '缺少相对路径 relPath');
  }
  if (relPath.includes('\0')) throw new DomainError('INVALID_ARG', '路径包含非法字符');

  // 绝对路径（含 Windows 盘符写法）一律拒绝，只接受工程内相对路径
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) throw outside(relPath);

  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, relPath);

  // 第一层：词法检查，挡掉明显的 ..
  if (!isInside(absRoot, abs)) throw outside(relPath);

  // 第二层：真实路径检查，挡掉符号链接逃逸（目标可以还不存在，沿已存在的祖先看）
  const [realRoot, realAbs] = await Promise.all([realpathNearest(absRoot), realpathNearest(abs)]);
  if (!isInside(realRoot, realAbs)) throw outside(relPath);

  return abs;
}

function outside(target) {
  return new DomainError('OUTSIDE_PROJECT', `路径越出工程目录: ${target}`);
}

/** child 是否等于 parent 或位于其下（纯字符串判断，不含符号链接语义） */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 对最近的已存在祖先做 realpath，再接回尚不存在的尾部 */
async function realpathNearest(abs) {
  let cur = abs;
  let tail = [];
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail = [path.basename(cur), ...tail];
      cur = parent;
    }
  }
}

// --------------------------------------------------------------- 目录准备 ---

/** 建 root 以及 assets/ cache/ exports/，重复调用安全 */
export async function ensureAssetDirs(root) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new DomainError('INVALID_ARG', '缺少工程目录 root');
  }
  const absRoot = path.resolve(root);
  await fs.mkdir(absRoot, { recursive: true });

  const dirs = { root: absRoot };
  for (const name of PROJECT_DIRS) {
    const abs = await resolveAssetPath(absRoot, name);
    await fs.mkdir(abs, { recursive: true });
    dirs[name] = abs;
  }
  return dirs;
}

// ----------------------------------------------------------------- 素材扫描 ---

/** 列出 assets/ 下的普通文件（不递归、不跟随符号链接），按文件名排序 */
export async function scanAssets(root) {
  const dir = await resolveAssetPath(root, 'assets');

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new DomainError('IO_FAILED', `读取素材目录失败: ${e.message}`);
  }

  const list = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const st = await fs.stat(path.join(dir, ent.name));
    list.push({
      name: ent.name,
      relPath: 'assets/' + ent.name,
      size: st.size,
      mtimeMs: st.mtimeMs,
      mime: mimeFor(ent.name),
    });
  }

  list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return list;
}

// ------------------------------------------------------------------- 导入 ---

/** 直接写入字节，返回 {name, relPath, size, hash, mime} */
export async function importBytes(root, { name, bytes } = {}) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new DomainError('INVALID_ARG', '缺少素材文件名 name');
  }
  const buf = toBuffer(bytes);

  const assetsDir = await resolveAssetPath(root, 'assets');
  await fs.mkdir(assetsDir, { recursive: true });

  const chosen = await pickFreeName(assetsDir, safeFilename(name));
  const target = await resolveAssetPath(root, 'assets/' + chosen);
  await writeFileAtomic(target, buf);

  return {
    name: chosen,
    relPath: 'assets/' + chosen,
    size: buf.length,
    hash: 'sha256:' + createHash('sha256').update(buf).digest('hex'),
    mime: mimeFor(chosen),
  };
}

/** 从磁盘复制一个文件进来（流式哈希），返回形状同 importBytes */
export async function importFile(root, { sourcePath } = {}) {
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
    throw new DomainError('INVALID_ARG', '缺少源文件路径 sourcePath');
  }
  const src = path.resolve(sourcePath);

  let st;
  try {
    st = await fs.stat(src);
  } catch (e) {
    if (e.code === 'ENOENT') throw new DomainError('NOT_FOUND', `源文件不存在: ${sourcePath}`);
    throw new DomainError('IO_FAILED', `读取源文件失败: ${e.message}`);
  }
  if (!st.isFile()) throw new DomainError('INVALID_ARG', `不是普通文件: ${sourcePath}`);

  const assetsDir = await resolveAssetPath(root, 'assets');
  await fs.mkdir(assetsDir, { recursive: true });

  const chosen = await pickFreeName(assetsDir, safeFilename(path.basename(src)));
  const target = await resolveAssetPath(root, 'assets/' + chosen);
  const tmp = tmpName(target);

  const hasher = createHash('sha256');
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      hasher.update(chunk);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(createReadStream(src), tap, createWriteStream(tmp, { flags: 'wx' }));
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (e instanceof DomainError) throw e;
    throw new DomainError('IO_FAILED', `导入文件失败: ${e.message}`, { sourcePath, target });
  }

  const size = (await fs.stat(target)).size;
  return {
    name: chosen,
    relPath: 'assets/' + chosen,
    size,
    hash: 'sha256:' + hasher.digest('hex'),
    mime: mimeFor(chosen),
  };
}

// ------------------------------------------------------------------- 读取 ---

/**
 * 读文件的一段：start 负数/越界会被钳制到 [0, size]，length 超出剩余部分会被截断。
 * 返回 {bytes:Uint8Array, start, length, size}；文件不存在抛 NOT_FOUND。
 * 传 options.root 时先用 resolveAssetPath 再校验一次（防越权读）。
 */
export async function readRange(absolutePath, start, length, { root } = {}) {
  if (typeof absolutePath !== 'string' || absolutePath === '') {
    throw new DomainError('INVALID_ARG', '缺少文件路径 absolutePath');
  }

  let file = absolutePath;
  if (root != null) {
    const rel = path.relative(path.resolve(root), path.resolve(absolutePath));
    file = await resolveAssetPath(root, rel);
  }

  let st;
  try {
    st = await fs.stat(file);
  } catch (e) {
    if (e.code === 'ENOENT') throw new DomainError('NOT_FOUND', `文件不存在: ${absolutePath}`);
    throw new DomainError('IO_FAILED', `读取文件失败: ${e.message}`);
  }
  if (!st.isFile()) throw new DomainError('INVALID_ARG', `不是普通文件: ${absolutePath}`);

  const size = st.size;
  const from = clampInt(start, 0, size);
  const want = length == null ? size - from : clampInt(length, 0, size - from);

  let bytesRead = 0;
  const buf = Buffer.alloc(want);
  if (want > 0) {
    let fh;
    try {
      fh = await fs.open(file, 'r');
      ({ bytesRead } = await fh.read(buf, 0, want, from));
    } catch (e) {
      if (e.code === 'ENOENT') throw new DomainError('NOT_FOUND', `文件不存在: ${absolutePath}`);
      throw new DomainError('IO_FAILED', `读取文件失败: ${e.message}`);
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  return {
    bytes: new Uint8Array(buf.buffer, buf.byteOffset, bytesRead),
    start: from,
    length: bytesRead,
    size,
  };
}

// ------------------------------------------------------------------- 类型 ---

const MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

/** 按扩展名给出 MIME，未知返回 application/octet-stream */
export function mimeFor(name) {
  const ext = path.extname(String(name || '')).slice(1).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

// --------------------------------------------------------------- 内部工具 ---

/** 文件名清洗：只留最后一段，去控制字符与非法字符，限 120 字符 */
function safeFilename(raw) {
  const last = String(raw).split(/[\\/]/).filter(Boolean).pop() || 'file';
  let base = last
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!base) base = 'file';

  let { stem, ext } = splitName(base);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = '_' + stem;
  stem = truncateChars(stem, Math.max(1, MAX_NAME - ext.length)) || 'file';
  return stem + ext;
}

/** 拆出主名与扩展名（扩展名过长时视为无扩展名） */
function splitName(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || name.length - i > 20) return { stem: name, ext: '' };
  return { stem: name.slice(0, i), ext: name.slice(i) };
}

/** 按字符（码点）截断，避免切坏代理对 */
function truncateChars(s, max) {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('');
}

/** 找一个不冲突的名字：重名加 -1、-2 … 后缀 */
async function pickFreeName(dir, filename) {
  const { stem, ext } = splitName(filename);
  let candidate = filename;
  for (let i = 1; await exists(path.join(dir, candidate)); i += 1) {
    const room = Math.max(1, MAX_NAME - ext.length - 1 - String(i).length);
    candidate = `${truncateChars(stem, room)}-${i}${ext}`;
  }
  return candidate;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 先写 .tmp 再 rename，失败时清掉临时文件 */
async function writeFileAtomic(target, data) {
  const tmp = tmpName(target);
  try {
    await fs.writeFile(tmp, data, { flag: 'wx' });
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (e instanceof DomainError) throw e;
    throw new DomainError('IO_FAILED', `写入素材失败: ${e.message}`, { target });
  }
}

function tmpName(target) {
  return `${target}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 规整成 Buffer */
function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new DomainError('INVALID_ARG', 'bytes 必须是 Buffer / Uint8Array / ArrayBuffer');
}

/** 取整并钳制到 [lo, hi]；非有限数按 lo 处理 */
function clampInt(value, lo, hi) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return lo;
  return Math.min(Math.max(Math.trunc(value), lo), hi);
}
