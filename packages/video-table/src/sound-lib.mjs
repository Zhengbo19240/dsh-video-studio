/**
 * 声音素材库（本地）。
 *
 * 约定：
 *   <soundRoot>/<packId>/<文件名>            一个 pack 一个目录（Kenney 整包、手动下载的音效）
 *   <soundRoot>/<packId>/<文件名>.json       可选 sidecar：{title, tags, category, license, attribution, source}
 *
 * 错误语义与动效库一致：所有对外失败都抛 DomainError 并带明确的 code。
 * 路径守卫不走 media.mjs 的 resolveAssetPath（那是工程目录的 OUTSIDE_PROJECT），
 * 这里有自己的 OUTSIDE_LIB，但思路相同：词法检查 + realpath 检查两层。
 *
 * 时长：wav / flac / m4a / mp3 靠读文件头尾的固定偏移算出来（纯 Node，不加依赖，
 * 不整文件读进内存）；ogg（Vorbis / Opus）读尾部 256KB 找最后一个 Ogg 页的
 * granule position；aac 暂时返回 null，不调用 ffprobe。
 * 算不出来的格式如实给 null，由 UI 显示「时长未知」，不编数字。
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DomainError } from './domain.mjs';

/** 只收音频扩展名 */
export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'];
const AUDIO_EXT = new Set(AUDIO_EXTENSIONS);

/** 声音库默认根目录：环境变量优先，默认 ~/.dsh/sound-lib */
export function soundRoot() {
  return process.env.DSH_SOUND_LIB || path.join(os.homedir(), '.dsh', 'sound-lib');
}

// ------------------------------------------------------------ 多根目录配置 ---
//
// 配置优先级（高 → 低）：
//   1. DSH_SOUND_LIB 环境变量：设置时只用它，配置文件中其余根一律忽略；
//   2. ~/.dsh/sound-sources.json（DSH_SOUND_SOURCES 可覆盖，测试用）；
//   3. 默认 ~/.dsh/sound-lib。
//
// 配置格式：
//   { "roots": [ { "name": "kenney", "path": "~\\.dsh\\sound-library\\kenney" } ] }
// roots 也可以写成字符串数组（名字取目录名）。坏 JSON / 空 roots 一律回退默认根，
// 不抛错 —— 用户手改坏了配置时，插件仍然要能启动。

/** 默认的 D 盘声音库基点（首次启动时在这里建 kenney 子目录） */
export const DEFAULT_SOUND_BASE = '~\\.dsh\\sound-library';

/** 声音源配置文件路径（DSH_SOUND_SOURCES 可覆盖） */
export function soundSourcesFile() {
  return process.env.DSH_SOUND_SOURCES || path.join(os.homedir(), '.dsh', 'sound-sources.json');
}

/** 把配置里的 roots 规整成 [{name, path}]：容忍字符串项、缺 name、重名、相对路径 */
function normalizeRoots(data, baseDir) {
  const raw = data && Array.isArray(data.roots) ? data.roots : [];
  const out = [];
  const used = new Set();

  for (const item of raw) {
    let name = '';
    let p = '';
    if (typeof item === 'string') {
      p = item;
    } else if (item && typeof item === 'object') {
      name = typeof item.name === 'string' ? item.name.trim() : '';
      p = typeof item.path === 'string' ? item.path.trim() : '';
    }
    if (!p) continue;

    // 相对路径相对配置文件所在目录解析，避免受进程 cwd 影响
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(baseDir, p);
    let base = (name || path.basename(abs) || 'root-' + (out.length + 1))
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim();
    if (!base) base = 'root-' + (out.length + 1);

    let unique = base;
    for (let i = 2; used.has(unique); i += 1) unique = base + '-' + i;
    used.add(unique);
    out.push({ name: unique, path: abs });
  }
  return out;
}

/**
 * 读配置文件。返回 { roots, file, exists, warning }：
 * 文件不存在、读不动、JSON 坏掉、roots 为空都返回空 roots + 人话 warning，不抛。
 */
export async function loadSoundSources() {
  const file = soundSourcesFile();
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
      return { roots: [], file, exists: false, warning: null };
    }
    return { roots: [], file, exists: false, warning: '读取声音源配置失败（' + e.message + '），已回退默认根目录' };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { roots: [], file, exists: true, warning: '声音源配置不是合法 JSON，已回退默认根目录：' + file };
  }

  const roots = normalizeRoots(data, path.dirname(path.resolve(file)));
  if (!roots.length) {
    return { roots: [], file, exists: true, warning: '声音源配置里没有可用的 roots，已回退默认根目录：' + file };
  }
  return { roots, file, exists: true, warning: null };
}

/** 当前生效的声音库根目录数组（永远至少一个） */
export async function soundSourcesRoots() {
  const override = process.env.DSH_SOUND_LIB;
  if (typeof override === 'string' && override.trim()) {
    return [{ name: 'default', path: path.resolve(override.trim()) }];
  }
  const loaded = await loadSoundSources();
  if (loaded.roots.length) return loaded.roots;
  return [{ name: 'default', path: path.resolve(soundRoot()) }];
}

/**
 * 首次启动兜底：配置文件不存在、且本机有 ~/.dsh/sound-library 时，
 * 建出 ~/.dsh/sound-library\kenney 与 ~/.dsh/sound-sources.json。
 * 写失败不崩，回退默认根并带 warning（由调用方记日志）。
 *
 * baseDir / configFile 只给测试用，默认就是真实路径。
 */
export async function ensureDefaultSoundSources({ baseDir = DEFAULT_SOUND_BASE, configFile } = {}) {
  if (process.env.DSH_SOUND_LIB) {
    return { created: false, reason: 'DSH_SOUND_LIB 已设置，跳过自动建库' };
  }
  const file = configFile || soundSourcesFile();
  if (await pathExists(file)) return { created: false, reason: '配置文件已存在', file };
  if (!(await isDirectory(baseDir))) return { created: false, reason: '本机没有目录 ' + baseDir };

  const kenneyDir = path.join(baseDir, 'kenney');
  try {
    await fs.mkdir(kenneyDir, { recursive: true });
    await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
    const content = JSON.stringify({ roots: [{ name: 'kenney', path: kenneyDir }] }, null, 2) + '\n';
    await fs.writeFile(file, content, 'utf8');
    return { created: true, file, roots: [{ name: 'kenney', path: kenneyDir }] };
  } catch (e) {
    const message = '创建声音源配置失败（' + e.message + '），本次使用默认根目录 ' + soundRoot();
    return { created: false, file, reason: message, warning: message };
  }
}

/**
 * 条目 id：sha1('local:<根名>/<packId>/<相对路径>') 的前 12 位。
 *
 * 根名进哈希是为了避免跨根同名文件撞 id；只要根名与目录结构不变，id 就稳定。
 * 根名省略时按 default 处理（保持与旧版单根库的语义接近）。
 */
export function localId(packId, relPath, rootName = 'default') {
  const key = 'local:' + (rootName || 'default') + '/' + packId + '/' + posix(relPath);
  return createHash('sha1').update(key, 'utf8').digest('hex').slice(0, 12);
}

// ------------------------------------------------------------------ 扫描 ---

/**
 * 扫描所有声音库根目录，返回条目数组。
 *
 * 每个根下仍是 `<根>/<packId>/<文件>` 的结构；条目带 root / rootPath 两个字段，
 * 用来把 id 还原回正确的根。根目录不存在时跳过（用户可能还没放素材），
 * 一个根出错不影响其它根。
 */
export async function scanLocal() {
  const roots = await soundSourcesRoots();
  const out = [];

  for (const root of roots) {
    let packs;
    try {
      packs = await fs.readdir(root.path, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue;
      throw new DomainError('IO_FAILED', `读取声音库失败（${root.name}: ${root.path}）: ${e.message}`);
    }

    const ctx = { rootName: root.name, rootPath: root.path };
    for (const pack of packs) {
      if (pack.name.startsWith('.')) continue;
      if (!pack.isDirectory()) continue;
      const packAbs = path.join(root.path, pack.name);
      await collectPack(packAbs, pack.name, packAbs, out, 0, ctx);
    }
  }

  const order = new Map(roots.map((r, i) => [r.name, i]));
  out.sort((a, b) => {
    const d = (order.get(a.root) ?? 99) - (order.get(b.root) ?? 99);
    return d !== 0 ? d : a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
  });
  return out;
}

/** 递归收集一个 pack 下的音频文件（深度上限防御异常目录结构） */
async function collectPack(dir, packId, packAbs, out, depth, ctx) {
  if (depth > 6) return;

  let items;
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw new DomainError('IO_FAILED', `读取声音目录失败: ${e.message}`);
  }

  for (const ent of items) {
    if (ent.name.startsWith('.')) continue; // 隐藏文件/目录
    const abs = path.join(dir, ent.name);

    if (ent.isDirectory()) {
      await collectPack(abs, packId, packAbs, out, depth + 1, ctx);
      continue;
    }
    if (!ent.isFile()) continue; // 符号链接等一律不跟随

    const ext = path.extname(ent.name).toLowerCase();
    if (!AUDIO_EXT.has(ext)) continue; // .json / .txt 之类在这里被排除

    const relPath = posix(path.relative(packAbs, abs));
    out.push(await describeLocalFile({ ...ctx, packId, abs, relPath }));
  }
}

/**
 * 把一个已存在的音频文件描述成条目。
 * 扫描与 URL 导入共用这一份，保证两边字段完全一致（id / 标题 / 时长 / sidecar）。
 */
export async function describeLocalFile({ rootName, rootPath, packId, abs, relPath }) {
  const ext = path.extname(abs).toLowerCase();
  const meta = await readSidecar(abs);
  const parsed = await readDuration(abs, ext);
  return {
    id: localId(packId, relPath, rootName),
    root: rootName,
    rootPath,
    provider: 'local',
    providerId: packId + '/' + posix(relPath),
    title: meta.title || path.basename(abs, path.extname(abs)),
    file: abs,
    duration: parsed ? parsed.duration : null,
    durationExact: parsed ? parsed.exact : null,
    // 本地库没有「可循环」这类元数据：如实给 null，不猜。
    // 在线条目由 sound-freesound 按 loop 标签给 true/false。
    loopable: null,
    tags: meta.tags,
    category: meta.category || packId,
    license: meta.license,
    attribution: meta.attribution,
    pageUrl: null,
  };
}

function emptyMeta() {
  return { title: null, tags: [], category: null, license: null, attribution: null };
}

/** 读同名 sidecar；不存在或写坏了都当没有（不因为一条脏数据毁掉整个库） */
async function readSidecar(file) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file + '.json', 'utf8'));
  } catch {
    return emptyMeta();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyMeta();
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map((t) => String(t).trim()).filter(Boolean)
    : [];
  return {
    title: text(parsed.title),
    tags,
    category: text(parsed.category),
    license: text(parsed.license),
    attribution: text(parsed.attribution),
  };
}

// ------------------------------------------------------------------ 搜索 ---

/** 按标题 / 文件名 / 标签模糊匹配（大小写不敏感，多词按 AND） */
export async function searchLocal(query) {
  const entries = await scanLocal();
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return entries;
  const tokens = q.split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    const hay = (e.title + ' ' + e.providerId + ' ' + e.tags.join(' ')).toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

/** 按 id 找本地条目；不认识 `local:` 路径形式时返回 null */
export async function findLocalEntry(id) {
  const raw = String(id == null ? '' : id);
  if (!raw || /^local:/i.test(raw)) return null;
  const entries = await scanLocal();
  return entries.find((e) => e.id === raw) || null;
}

// -------------------------------------------------------------- 路径解析 ---

/**
 * 把条目 id 还原成绝对路径。
 *
 * 支持两种写法：
 *   - 12 位 sha1 id（scanLocal 产出的正式 id），扫库反查，用条目自己的 rootPath 解析；
 *   - `local:<packId>/<相对路径>`，依次在每个根里找，命中第一个存在的音频文件。
 *
 * 两种写法最后都要过同一道守卫：必须仍在某一个根内，越界抛 OUTSIDE_LIB。
 */
export async function resolveLocalPath(id) {
  const raw = String(id == null ? '' : id).trim();
  if (!raw) throw new DomainError('INVALID_ARG', '缺少条目 id');
  if (raw.includes('\0')) throw new DomainError('INVALID_ARG', '条目 id 含非法字符');

  const roots = await soundSourcesRoots();

  if (/^local:/i.test(raw)) {
    const rel = raw.slice('local:'.length).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel) throw new DomainError('INVALID_ARG', '条目 id 缺少路径');
    return resolveInAnyRoot(roots, rel, raw);
  }

  const hit = await findLocalEntry(raw);
  if (!hit) throw new DomainError('NOT_FOUND', `声音库里没有这个条目: ${raw}`);
  // 扫出来的路径也再过一遍守卫：库目录本身可能就是符号链接
  const rootPath = hit.rootPath || (roots[0] && roots[0].path) || soundRoot();
  const abs = await resolveInside(rootPath, hit.providerId);
  await assertAudioFile(abs, raw);
  return abs;
}

/** 在多个根里找同一个相对路径；全部越界 → OUTSIDE_LIB，全部不存在 → NOT_FOUND */
async function resolveInAnyRoot(roots, rel, raw) {
  let outside = null;
  let lexicalOk = false;

  for (const root of roots) {
    let abs;
    try {
      abs = await resolveInside(root.path, rel);
    } catch (e) {
      if (!outside) outside = e;
      continue;
    }
    lexicalOk = true;
    try {
      await assertAudioFile(abs, raw);
      return abs;
    } catch (e) {
      if (e.code === 'NOT_FOUND') continue; // 这个根里没有，换下一个
      throw e;
    }
  }

  if (outside && !lexicalOk) throw outside;
  throw new DomainError('NOT_FOUND', `声音文件不存在: ${raw}`);
}

/** 词法检查 + realpath 检查；任何逃出 root 的路径抛 OUTSIDE_LIB */
async function resolveInside(root, rel) {
  const absRoot = path.resolve(root);
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw outsideLib(rel);

  const abs = path.resolve(absRoot, rel);
  if (!isInside(absRoot, abs)) throw outsideLib(rel);

  const [realRoot, realAbs] = await Promise.all([realpathNearest(absRoot), realpathNearest(abs)]);
  if (!isInside(realRoot, realAbs)) throw outsideLib(rel);
  return abs;
}

function outsideLib(target) {
  return new DomainError('OUTSIDE_LIB', `路径越出声音库目录: ${target}`);
}

/** child 是否等于 parent 或位于其下 */
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

async function assertAudioFile(abs, id) {
  let st;
  try {
    st = await fs.stat(abs);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
      throw new DomainError('NOT_FOUND', `声音文件不存在: ${id}`);
    }
    throw new DomainError('IO_FAILED', `读取声音文件失败: ${e.message}`);
  }
  if (!st.isFile()) throw new DomainError('NOT_FOUND', `不是普通文件: ${id}`);
  if (!AUDIO_EXT.has(path.extname(abs).toLowerCase())) {
    throw new DomainError('NOT_FOUND', `不是音频文件: ${id}`);
  }
}

// ------------------------------------------------------------ wav 时长 ---

/**
 * 直接读 RIFF 头算 wav 时长：dataSize / byteRate。
 * 读不到或格式不认识就返回 null —— 调用方按「时长未知」处理，不编造数字。
 */
async function wavDuration(file) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
  } catch {
    return null;
  }

  try {
    const total = (await fh.stat()).size;
    const head = Buffer.alloc(12);
    const got = await fh.read(head, 0, 12, 0);
    if (got.bytesRead < 12) return null;

    const riff = head.toString('ascii', 0, 4);
    if (riff !== 'RIFF' && riff !== 'RF64') return null;
    if (head.toString('ascii', 8, 12) !== 'WAVE') return null;

    let offset = 12;
    let byteRate = 0;
    let dataSize = null;
    let rf64DataSize = null;
    let guard = 0;

    while (offset + 8 <= total && guard < 512) {
      guard += 1;
      const hdr = Buffer.alloc(8);
      const r = await fh.read(hdr, 0, 8, offset);
      if (r.bytesRead < 8) break;

      const id = hdr.toString('ascii', 0, 4);
      let chunkSize = hdr.readUInt32LE(4);
      offset += 8;

      if (id === 'ds64') {
        const b = Buffer.alloc(Math.min(chunkSize, 32));
        const ds = await fh.read(b, 0, b.length, offset);
        if (ds.bytesRead >= 16) rf64DataSize = Number(b.readBigUInt64LE(8));
      } else if (id === 'fmt ') {
        const b = Buffer.alloc(Math.min(chunkSize, 40));
        const fs = await fh.read(b, 0, b.length, offset);
        if (fs.bytesRead >= 12) byteRate = b.readUInt32LE(8);
      } else if (id === 'data') {
        dataSize = chunkSize;
        if (dataSize === 0xffffffff && rf64DataSize != null) dataSize = rf64DataSize;
        break;
      }

      // chunk 按偶数字节对齐
      offset += chunkSize + (chunkSize % 2);
    }

    if (!byteRate || dataSize == null || dataSize === 0xffffffff) return null;
    const duration = dataSize / byteRate;
    if (!Number.isFinite(duration) || duration < 0) return null;
    return Math.round(duration * 1000) / 1000;
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

// -------------------------------------------------- 多格式时长（纯头部） ---
//
// 原则：只用 Node 自带模块；只按固定偏移读几十个字节，绝不把整个文件读进内存。
// 解析不出来就返回 null，让上层显示「时长未知」，不编一个看起来合理的数。

/** 秒 → 毫秒取整（与 wavDuration 的精度一致） */
function roundSeconds(seconds) {
  return Math.round(seconds * 1000) / 1000;
}

/** 从 fh 的固定偏移读一段；读不满就返回实际读到的部分 */
async function readAt(fh, offset, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset);
  return bytesRead === length ? buf : buf.subarray(0, bytesRead);
}

// ------------------------------------------------------------------ flac ---

/**
 * flac 时长：total_samples / sample_rate，两者都在 STREAMINFO 里。
 *
 * 文件头是 "fLaC" 加一串 metadata block，每块头 4 字节：
 *   bit7 = 是否最后一块，bit6..0 = 块类型，随后 3 字节大端长度。
 * 规范要求第一块就是 STREAMINFO（类型 0，长度固定 34），所以只读 42 字节：
 *   ["fLaC"(4)][块头(4)][STREAMINFO(34)]
 * STREAMINFO 第 10 字节起是一个 64 位字段：
 *   sample_rate(20) / channels-1(3) / bits-1(5) / total_samples(36)。
 *
 * 已知不准确：total_samples 为 0 的流式 flac（边编码边写）时长不可知，这里返回
 * null 而不是 0；极少数工具会写错 total_samples，这里无从校验。
 */
export async function readFlacDuration(file) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
  } catch {
    return null;
  }

  try {
    if ((await fh.stat()).size < 42) return null;
    const head = await readAt(fh, 0, 42);
    if (head.length < 42) return null;
    if (head.toString('latin1', 0, 4) !== 'fLaC') return null;

    const type = head[4] & 0x7f;
    const blockLen = head.readUIntBE(5, 3);
    if (type !== 0 || blockLen < 34) return null;

    const si = 8; // STREAMINFO 起点
    const sampleRate = (head[si + 10] << 12) | (head[si + 11] << 4) | (head[si + 12] >> 4);
    // 36 bit 的 total_samples：高 4 位在 byte13 的低半字节，其余 32 位大端
    const totalSamples = (head[si + 13] & 0x0f) * 4294967296 + head.readUInt32BE(si + 14);

    if (sampleRate <= 0) return null; // 规范要求 > 0，为 0 说明文件坏了
    if (totalSamples <= 0) return null; // 流式 flac 会写 0：时长不可知，不猜
    return roundSeconds(totalSamples / sampleRate);
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

// ------------------------------------------------------------- m4a / mp4 ---

const MAX_BOXES = 64; // 坏文件防御：任何一层最多走 64 个盒子就放弃

/**
 * 读一个 box 头。size 有 3 种写法：
 *   - 普通 32 位长度（含头 8 字节）
 *   - 1：后面再跟 8 字节 largesize（占 16 字节头）
 *   - 0：一直延伸到文件尾（流式写出的文件常见）
 */
async function readBoxHeader(fh, offset, limit) {
  if (offset + 8 > limit) return null;
  const head = await readAt(fh, offset, 16);
  if (head.length < 8) return null;

  let size = head.readUInt32BE(0);
  const type = head.toString('latin1', 4, 8);
  let headerSize = 8;
  if (size === 1) {
    if (head.length < 16) return null;
    size = head.readUInt32BE(8) * 4294967296 + head.readUInt32BE(12);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset;
  }

  if (!type.trim() || size < headerSize || offset + size > limit) return null;
  return { type, size, headerSize };
}

/**
 * m4a/mp4 时长：moov → mvhd 里的 timescale 与 duration。
 *
 * moov 不一定在文件开头（ftyp / free / mdat 都可能排在前面），所以顺着
 * top-level 盒子的长度链走，最多 MAX_BOXES 个。mvhd 的版本 0 用 32 位
 * duration，版本 1 用 64 位。
 *
 * 已知不准确：分片 mp4（moof/mfra）的 mvhd duration 常写成 0，真实时长在
 * mvex/mehd 或各分片里，这里返回 null 而不是 0；mvhd 写 0xFFFFFFFF（「未知」）
 * 也返回 null。
 */
export async function readM4aDuration(file) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
  } catch {
    return null;
  }

  try {
    const fileSize = (await fh.stat()).size;
    if (fileSize < 16) return null;

    // 1) 顶层找 moov
    let moov = null;
    let off = 0;
    for (let i = 0; i < MAX_BOXES && off + 8 <= fileSize; i++) {
      const box = await readBoxHeader(fh, off, fileSize);
      if (!box) return null;
      if (box.type === 'moov') {
        moov = { start: off + box.headerSize, end: off + box.size };
        break;
      }
      off += box.size;
    }
    if (!moov) return null;

    // 2) moov 里找 mvhd（mvhd 是 moov 的直接子盒）
    let mvhd = null;
    off = moov.start;
    for (let i = 0; i < MAX_BOXES && off + 8 <= moov.end; i++) {
      const box = await readBoxHeader(fh, off, moov.end);
      if (!box) return null;
      if (box.type === 'mvhd') {
        mvhd = { start: off + box.headerSize };
        break;
      }
      off += box.size;
    }
    if (!mvhd) return null;

    // 3) mvhd 负载：version/flags(4)，creation/modification，timescale，duration
    const p = await readAt(fh, mvhd.start, 32);
    if (p.length < 20) return null;
    const version = p[0];

    let timescale;
    let duration;
    if (version === 1) {
      if (p.length < 32) return null;
      timescale = p.readUInt32BE(20);
      duration = Number(p.readBigUInt64BE(24));
    } else if (version === 0) {
      timescale = p.readUInt32BE(12);
      duration = p.readUInt32BE(16);
      if (duration === 0xffffffff) return null; // 规范里的「未知」
    } else {
      return null;
    }

    if (timescale <= 0 || duration <= 0) return null;
    return roundSeconds(duration / timescale);
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

// ------------------------------------------------------------------- mp3 ---
//
// 参考 ISO/IEC 11172-3 / 13818-3 的帧头布局。表按 layer 位索引：
//   layer 位 1 = Layer III、2 = Layer II、3 = Layer I（0 是保留值）。

const MPEG_SAMPLE_RATES = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

const MPEG_BITRATES_V1 = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // Layer III
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], // Layer II
  3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // Layer I
};

/** MPEG2 / MPEG2.5 的比特率表（两者相同） */
const MPEG_BITRATES_V2 = {
  1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // Layer III
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // Layer II
  3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], // Layer I
};

const MP3_SCAN_CHUNK = 4096;
const MP3_SCAN_LIMIT = 512 * 1024; // 帧头前最多容忍 512KB 垃圾，再往后不认
const MP3_PROBE_FRAMES = 12; // 判 CBR/VBR 时最多连看 12 帧

/** 解析 buf[i..i+3] 处的 MPEG 帧头；不是合法帧头返回 null */
function parseMpegFrame(buf, i) {
  if (i + 4 > buf.length) return null;
  const b0 = buf[i];
  const b1 = buf[i + 1];
  const b2 = buf[i + 2];
  const b3 = buf[i + 3];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null; // 11 位同步字

  const versionBits = (b1 >> 3) & 0x3;
  const layerBits = (b1 >> 1) & 0x3;
  if (versionBits === 1 || layerBits === 0) return null; // 保留值

  const bitrateIndex = b2 >> 4;
  const sampleRateIndex = (b2 >> 2) & 0x3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null; // 自由格式/坏值

  const isV1 = versionBits === 3;
  const bitrate = (isV1 ? MPEG_BITRATES_V1 : MPEG_BITRATES_V2)[layerBits][bitrateIndex] * 1000;
  const sampleRate = MPEG_SAMPLE_RATES[versionBits][sampleRateIndex];
  if (!bitrate || !sampleRate) return null;

  const padding = (b2 >> 1) & 1;
  const isMono = ((b3 >> 6) & 0x3) === 3;

  // 每帧采样数：Layer I 恒 384；Layer II 恒 1152；Layer III 看 MPEG 版本
  let samplesPerFrame;
  if (layerBits === 3) samplesPerFrame = 384;
  else if (layerBits === 2) samplesPerFrame = 1152;
  else samplesPerFrame = isV1 ? 1152 : 576;

  // 帧长（字节）；Layer III 的 MPEG2/2.5 用 72 而不是 144
  let frameLength;
  if (layerBits === 3) frameLength = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
  else if (layerBits === 1 && !isV1) frameLength = Math.floor((72 * bitrate) / sampleRate) + padding;
  else frameLength = Math.floor((144 * bitrate) / sampleRate) + padding;
  if (!Number.isFinite(frameLength) || frameLength <= 4) return null;

  // Xing/Info 头在帧头 + 4 字节 + 边信息之后；只有 Layer III 有边信息
  let sideInfo = 0;
  if (layerBits === 1) sideInfo = isV1 ? (isMono ? 17 : 32) : isMono ? 9 : 17;

  return { bitrate, sampleRate, samplesPerFrame, frameLength, sideInfo, layerBits };
}

/**
 * 从 from 开始找第一个 MPEG 帧头。
 *
 * 只认「后面还接得上」的帧：随机数据里能凑出同步字的概率并不低，
 * 单看 4 个字节会产生大量假帧。所以候选帧之后必须能再解析出一个帧头，
 * 或者它正好填满文件剩下的字节。帧头前最多容忍 512KB 垃圾（有些编码器会塞填充）。
 */
async function findFirstMpegFrame(fh, from, fileSize) {
  let carry = Buffer.alloc(0);
  let off = from;
  while (off < fileSize && off - from < MP3_SCAN_LIMIT) {
    const want = Math.min(MP3_SCAN_CHUNK, fileSize - off);
    const chunk = await readAt(fh, off, want);
    if (chunk.length < 4) return null;
    const scan = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const base = off - carry.length;

    for (let i = 0; i + 4 <= scan.length; i++) {
      const frame = parseMpegFrame(scan, i);
      if (!frame) continue;
      const frameStart = base + i;
      if (frameStart < from) continue;
      if (await frameChainOk(fh, frameStart, frame, fileSize)) return { frameStart, frame };
      i += 3; // 这个候选不成立，跳过它的 4 字节，避免逐字节重复验链
    }

    carry = scan.subarray(scan.length - 3);
    off += want;
  }
  return null;
}

/** 候选帧之后要么还有一帧，要么这帧正好结束文件 */
async function frameChainOk(fh, frameStart, frame, fileSize) {
  const next = frameStart + frame.frameLength;
  if (next + 4 <= fileSize) {
    const head = await readAt(fh, next, 4);
    return head.length === 4 && parseMpegFrame(head, 0) != null;
  }
  return Math.abs(next - fileSize) <= 1;
}

/**
 * 顺着帧长链看前几帧的比特率是否一致。一致才算 CBR，可用总字节估算；
 * 出现不一致（VBR）就无法用字节数算，返回 false，调用方返回 null。
 */
async function looksCbr(fh, frameStart, fileSize, firstFrame) {
  let cur = frameStart;
  for (let i = 0; i < MP3_PROBE_FRAMES; i++) {
    if (cur + 4 > fileSize) return true; // 走到文件尾都没发现变化
    const head = await readAt(fh, cur, 4);
    const frame = head.length === 4 ? parseMpegFrame(head, 0) : null;
    if (!frame) return false; // 帧链接不上，不能确认是 CBR
    if (frame.bitrate !== firstFrame.bitrate) return false;
    cur += frame.frameLength;
  }
  return true;
}

/** ID3v2 的 size 是 syncsafe 编码：每字节只用低 7 位 */
function syncsafe(buf, off) {
  return (
    ((buf[off] & 0x7f) << 21) |
    ((buf[off + 1] & 0x7f) << 14) |
    ((buf[off + 2] & 0x7f) << 7) |
    (buf[off + 3] & 0x7f)
  );
}

/**
 * mp3 时长。返回 { duration, exact } 或 null。
 *
 * 这是唯一需要「说明自己是不是估算」的解析器，所以返回值比 flac/m4a 多一层，
 * 由 readDuration 归一成条目里的 duration / durationExact：
 *   exact: true  —— 有 Xing/Info 头：帧数 × 每帧采样数 / 采样率
 *   exact: false —— 无 Xing 且比特率一致：按 (文件字节 - 帧头前字节) * 8 / bitrate 估算
 * 无 Xing 又检出比特率不一致（VBR）时返回 null：宁可显示「时长未知」，
 * 也不给一个按首帧比特率算出来的、可能差出几倍的数。
 *
 * 已知不准确：CBR 估算把文件里的 ID3v1（末尾 128 字节）也算进音频字节，会
 * 高估约 0.008 秒（128kbps 下），可忽略；首帧带 Xing 但帧数为 0 的文件会退回估算。
 */
export async function readMp3Duration(file) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
  } catch {
    return null;
  }

  try {
    const fileSize = (await fh.stat()).size;
    if (fileSize < 4) return null;

    // 1) ID3v2：跳过它自己声明的长度（10 字节头 + 负载 + 可选 footer）
    let start = 0;
    const id3 = await readAt(fh, 0, 10);
    if (id3.length >= 3 && id3.toString('latin1', 0, 3) === 'ID3') {
      if (id3.length < 10) return null; // ID3 头本身被截断
      const flags = id3[5];
      start = 10 + syncsafe(id3, 6) + ((flags & 0x10) !== 0 ? 10 : 0);
      if (start >= fileSize) return null;
    }

    // 2) 找第一个帧头（帧头前可能有垃圾/填充）
    const found = await findFirstMpegFrame(fh, start, fileSize);
    if (!found) return null;
    const { frameStart, frame } = found;

    // 3) 优先 Xing/Info：帧数 × 每帧采样数 / 采样率
    if (frame.layerBits === 1) {
      const xing = await readAt(fh, frameStart + 4 + frame.sideInfo, 16);
      if (xing.length >= 12) {
        const tag = xing.toString('latin1', 0, 4);
        if (tag === 'Xing' || tag === 'Info') {
          const flags = xing.readUInt32BE(4);
          if (flags & 1) {
            const frames = xing.readUInt32BE(8);
            if (frames > 0) {
              const duration = roundSeconds((frames * frame.samplesPerFrame) / frame.sampleRate);
              if (duration > 0) return { duration, exact: true };
            }
          }
        }
      }
    }

    // 4) 无 Xing：先确认是 CBR，再按字节数估算
    if (!(await looksCbr(fh, frameStart, fileSize, frame))) return null;
    const duration = roundSeconds(((fileSize - frameStart) * 8) / frame.bitrate);
    if (!(duration > 0)) return null;
    return { duration, exact: false };
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

// ------------------------------------------------------------------- ogg ---
//
// Vorbis / Opus 的时长都不在文件头，而在「最后一个 Ogg 页」的 granule position 里：
//   Vorbis: granule = 该页结束时累计的 PCM 采样数，除以标识头里的采样率得秒；
//   Opus:   granule 恒以 48kHz 为单位（与文件头里写的输入采样率无关），除以 48000。
//
// Ogg 页头 27 字节：
//   0..3   "OggS"
//   4      version（必须 0）
//   5      header_type（0x01 continued / 0x02 BOS / 0x04 EOS）
//   6..13  granule position（有符号 64 位小端；-1 表示该页无有效 granule）
//   14..17 serial，18..21 sequence，22..25 CRC，26 段表长度
//   27..   段表（每字节 0..255），负载长度 = 段表各字节之和
//
// 只能从文件尾往回找页，所以这里限死「最多读尾部 256KB、每块 64KB 倒退」：
// 753 个文件的整库扫描不能因为 ogg 变成逐字节读全文。超出上限就放弃、返回未知。
//
// 刻意不校验 CRC（只读不写；整页 CRC 要读完整页，成本高），但必须校验
// magic / version / 段表长度与 27+段表+负载 不越界，否则随机字节里凑出的
// "OggS" 会被当成页。

const OGG_TAIL_CHUNK = 64 * 1024;
const OGG_TAIL_LIMIT = 256 * 1024;
const OGG_HEADER_MAX = 27 + 255; // 页头 + 段表上限
const OGG_MAX_CANDIDATES = 64; // 一次扫描里最多校验多少个 "OggS" 候选（坏文件防御）
const OPUS_CLOCK_RATE = 48000;

const OGG_CAPTURE = Buffer.from('OggS', 'latin1');
const VORBIS_IDENT = Buffer.from('\x01vorbis', 'latin1');
const OPUS_HEAD = Buffer.from('OpusHead', 'latin1');

/**
 * 校验并读一个 Ogg 页的头部（不读负载）。
 *
 * 返回 { headerType, granule: BigInt, totalLength } 或 null。
 * granule 原样返回（可能是 -1n），由调用方决定跳过还是采用。
 */
async function readOggPageHeader(fh, fileSize, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset + 27 > fileSize) return null;
  const buf = await readAt(fh, offset, OGG_HEADER_MAX);
  if (buf.length < 27) return null;

  if (!buf.subarray(0, 4).equals(OGG_CAPTURE)) return null;
  if (buf[4] !== 0) return null; // 版本只认 0

  const headerType = buf[5];
  const granule = buf.readBigInt64LE(6);
  const segments = buf[26];
  if (27 + segments > buf.length || 27 + segments > fileSize - offset) return null;

  let payloadLen = 0;
  for (let i = 0; i < segments; i++) payloadLen += buf[27 + i];
  const totalLength = 27 + segments + payloadLen;
  // 整页必须落在文件内；否则这是被截断的页，或者根本不是页
  if (totalLength > fileSize - offset) return null;

  return { headerType, granule, totalLength };
}

/**
 * 从第一页的负载里认编码：Vorbis 标识头 `\x01vorbis` 或 `OpusHead`。
 * 返回 { codec, sampleRate } 或 null。
 */
async function readOggCodec(fh) {
  const head = await readAt(fh, 0, 4096);
  if (head.length < 27) return null;
  if (!head.subarray(0, 4).equals(OGG_CAPTURE) || head[4] !== 0) return null;

  const segments = head[26];
  const payloadStart = 27 + segments;
  if (payloadStart > head.length) return null;

  let payloadLen = 0;
  for (let i = 0; i < segments; i++) payloadLen += head[27 + i];
  const payload = head.subarray(payloadStart, Math.min(payloadStart + payloadLen, head.length));
  if (!payload.length) return null;

  // Vorbis 标识头（30 字节）：类型(1) + "vorbis"(6) + 版本(4) + 声道(1) + 采样率(4)…
  const vorbisAt = payload.indexOf(VORBIS_IDENT);
  if (vorbisAt >= 0) {
    if (payload.length < vorbisAt + 16) return null;
    const rate = payload.readUInt32LE(vorbisAt + 12);
    if (!(rate > 0)) return null;
    return { codec: 'vorbis', sampleRate: rate };
  }

  // Opus 标识头（19 字节）："OpusHead" + 版本(1) + 声道(1) + pre-skip(2)…
  const opusAt = payload.indexOf(OPUS_HEAD);
  if (opusAt >= 0) {
    // Opus 的输出时钟恒为 48kHz；头部 input sample rate 只是原始采样率提示，不参与换算。
    // 这里不扣 pre-skip：典型 pre-skip 是 312 ~ 3840 个采样（约 7~80ms），
    // 对「显示一个时长」来说误差可接受；扣掉反而和播放器常见的显示口径不一致。
    return { codec: 'opus', sampleRate: OPUS_CLOCK_RATE };
  }

  return null;
}

/** 从 "OggS" 候选里按偏移从大到小找：第一个「页合法且 granule 有效」的页 */
async function findLastOggGranule(fh, fileSize) {
  const floor = Math.max(0, fileSize - OGG_TAIL_LIMIT);
  let end = fileSize;
  let checked = 0;

  while (end > floor) {
    const start = Math.max(floor, end - OGG_TAIL_CHUNK);
    const buf = await readAt(fh, start, end - start);
    if (buf.length < 27) return null;

    // 块内从后往前扫；i <= buf.length-27 保证 magic 的 4 字节都在块里
    for (let i = buf.length - 27; i >= 0; i--) {
      if (buf[i] !== 0x4f) continue; // 'O'
      if (buf[i + 1] !== 0x67 || buf[i + 2] !== 0x67 || buf[i + 3] !== 0x53) continue; // "ggS"

      checked += 1;
      if (checked > OGG_MAX_CANDIDATES) return null;

      const page = await readOggPageHeader(fh, fileSize, start + i);
      if (!page) continue;
      if (page.granule < 0n) continue; // -1：该页没有有效 granule，继续往前找

      return { granule: page.granule, eos: (page.headerType & 0x04) !== 0 };
    }

    end = start;
  }
  return null;
}

/**
 * ogg（Vorbis / Opus）时长。永远返回 { duration, exact }：
 *   认得编码且找到有效 granule → { 秒数, exact }
 *   不是 ogg / 编码不认识 / 尾部 256KB 里找不到页 / 文件被截断到没有 granule → { null, null }
 *
 * exact 的判据是「算时长用的那一页带 EOS 位」：
 *   - 最后一个页就是 EOS 页 → 它记录的是整条流的最终采样数，精确；
 *   - 找不到 EOS（文件被截断）、或 EOS 页 granule 是 -1 而回退到上一个页 → 末尾可能
 *     还有没被计进去的采样，标记为估算（UI 显示 ≈）。
 *
 * 已知会算错的情况：
 *   1) 只认 Vorbis / Opus。Theora、Speex、FLAC-in-Ogg 等编码会返回 null，
 *      不是隐私丢数据，是「如实未知」。
 *   2) 多路复用的 ogg（一条流里既有音频又有视频，或多个 logical stream）：
 *      这里只按第一页认编码，尾页可能是别的流的页；chained ogg（多个 BOS/EOS 串接）
 *      的 granule 会从头重新计数，算出来可能只是最后一段的时长。目前不处理。
 *   3) 页头里写的是期望值，若编码器写错 granule（少数流式产物），时长跟着错。
 *   4) Opus 忽略 pre-skip，约高估几毫秒到几十毫秒。
 *   5) 尾页离文件尾超过 256KB（极端嵌入大段封面/ID3 之类）就放弃，返回未知。
 */
export async function readOggDuration(file) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
  } catch {
    return { duration: null, exact: null };
  }

  try {
    const fileSize = (await fh.stat()).size;
    if (fileSize < 27) return { duration: null, exact: null };

    const codec = await readOggCodec(fh);
    if (!codec) return { duration: null, exact: null };

    const last = await findLastOggGranule(fh, fileSize);
    if (!last || last.granule <= 0n) return { duration: null, exact: null };

    const duration = roundSeconds(Number(last.granule) / codec.sampleRate);
    if (!(duration > 0)) return { duration: null, exact: null };

    return { duration, exact: last.eos };
  } catch {
    return { duration: null, exact: null };
  } finally {
    await fh.close().catch(() => {});
  }
}

// -------------------------------------------------------------- 统一入口 ---

/** '.mp3' / 'mp3' / '.MP3' 统一成小写带点的形式 */
function normalizeExt(ext) {
  const s = String(ext == null ? '' : ext).trim().toLowerCase();
  if (!s) return '';
  return s.startsWith('.') ? s : '.' + s;
}

/**
 * 统一入口：按扩展名分派，返回 { duration, exact } 或 null。
 *
 *   duration: 秒（3 位小数）；null 表示算不出来
 *   exact:    true 精确 / false 估算 / null 未知
 */
export async function readDuration(file, ext) {
  switch (normalizeExt(ext)) {
    case '.wav': {
      const d = await wavDuration(file);
      return d == null ? null : { duration: d, exact: true };
    }
    case '.flac': {
      const d = await readFlacDuration(file);
      return d == null ? null : { duration: d, exact: true };
    }
    case '.m4a':
    case '.mp4': {
      const d = await readM4aDuration(file);
      return d == null ? null : { duration: d, exact: true };
    }
    case '.mp3': {
      const r = await readMp3Duration(file);
      return r && r.duration > 0 ? { duration: r.duration, exact: r.exact } : null;
    }
    case '.ogg': {
      // Vorbis / Opus：读尾部 256KB 找最后一个 Ogg 页的 granule。认不出编码或找不到
      // 有效页时 readOggDuration 会老实给 { null, null }，这里归一成 null。
      const r = await readOggDuration(file);
      return r && r.duration > 0 ? { duration: r.duration, exact: r.exact } : null;
    }
    default:
      // .aac 是 ADTS 裸流，要逐帧走才能得到采样数；未知扩展名同理，都不猜。
      return null;
  }
}

// --------------------------------------------------------------- 内部工具 ---

function posix(p) {
  return String(p).split(/[\\/]+/).join('/');
}

/** 路径是否存在（任何类型） */
async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 是否是目录 */
async function isDirectory(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
