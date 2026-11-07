/**
 * 从直链 URL 导入一条音效到本地声音库。
 *
 * 规则：
 *   - 只接受 http/https（file://、ftp://、data: 一律拒绝——这里不做本地文件搬运）；
 *   - 15 秒超时、50MB 上限；
 *   - 响应必须是 audio/*，或者 URL 路径带已知音频扩展名（有的 CDN 只给 octet-stream）；
 *   - 按域名归档：<root>/<域名>/<文件名>，重名加 -1、-2 …；
 *   - 先用临时文件写完再 rename，失败不留半截文件。
 *
 * 失败一律抛 DomainError（INVALID_ARG / DOWNLOAD_FAILED / IO_FAILED / OUTSIDE_LIB），
 * 消息用中文说清原因，不静默。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DomainError } from './domain.mjs';
import { AUDIO_EXTENSIONS, describeLocalFile, soundSourcesRoots } from './sound-lib.mjs';

const TIMEOUT_MS = 15000;
const MAX_BYTES = 50 * 1024 * 1024;
const AUDIO_EXT = new Set(AUDIO_EXTENSIONS);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-video-workbench/0.1';

/** content-type → 扩展名；只列明确的音频类型，判不出来就报错，不硬猜 */
const MIME_EXT = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/vnd.wave': '.wav',
  'audio/ogg': '.ogg',
  'audio/vorbis': '.ogg',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/m4a': '.m4a',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/aac': '.aac',
};

/**
 * 下载并归档一条音效，返回扫库同形状的条目。
 * rootName 省略时用第一个根；根名不存在时抛 INVALID_ARG 并列出可用根。
 */
export async function importSoundFromUrl(url, { rootName } = {}) {
  const source = parseHttpUrl(url);
  const root = await pickRoot(rootName);

  const fetched = await downloadAudio(source);
  const domain = domainDirOf(source);
  const dir = path.join(root.path, domain);
  ensureInside(root.path, dir);

  await fs.mkdir(dir, { recursive: true });
  const name = await pickFreeName(dir, desiredFilename(source, fetched.ext));
  const abs = path.join(dir, name);

  const tmp = abs + '.tmp-' + process.pid + '-' + Date.now().toString(36);
  try {
    await fs.writeFile(tmp, fetched.bytes, { flag: 'wx' });
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw new DomainError('IO_FAILED', `写入音效失败：${e.message}`);
  }

  return describeLocalFile({ rootName: root.name, rootPath: root.path, packId: domain, abs, relPath: name });
}

// ------------------------------------------------------------------ 校验 ---

/** 只认 http/https；其余协议带人话拒绝 */
function parseHttpUrl(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) throw new DomainError('INVALID_ARG', '缺少音效直链 url');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new DomainError('INVALID_ARG', '不是合法的链接：' + text);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DomainError('INVALID_ARG', `只支持 http/https 直链，收到 ${url.protocol}//（本地文件请先放到声音库目录）`);
  }
  return url;
}

async function pickRoot(rootName) {
  const roots = await soundSourcesRoots();
  if (rootName != null && String(rootName).trim() !== '') {
    const want = String(rootName).trim();
    const hit = roots.find((r) => r.name === want);
    if (!hit) {
      throw new DomainError('INVALID_ARG', `没有这个声音库根目录：${want}（可用：${roots.map((r) => r.name).join('、')}）`);
    }
    return hit;
  }
  if (!roots.length) throw new DomainError('NO_ROOT', '没有配置任何声音库根目录');
  return roots[0];
}

// ------------------------------------------------------------------ 下载 ---

/**
 * 下载音频字节。超时用 AbortController 覆盖“连接 + 读 body”全程；
 * 上限同时看声明长度和实际累计字节。
 */
async function downloadAudio(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    let res;
    try {
      res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, accept: 'audio/*,*/*;q=0.5' },
      });
    } catch (e) {
      if (isAbort(e)) throw new DomainError('DOWNLOAD_FAILED', '下载超时（15 秒），已中止');
      throw new DomainError('DOWNLOAD_FAILED', `下载失败：${errText(e)}`);
    }

    if (!res.ok) throw new DomainError('DOWNLOAD_FAILED', `下载失败：HTTP ${res.status}`);

    const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      throw new DomainError('DOWNLOAD_FAILED', '音频超过 50MB 上限');
    }

    const ext = pickExtension(url, contentType);

    const bytes = await readBody(res, controller);
    return { bytes, contentType, ext };
  } finally {
    clearTimeout(timer);
  }
}

/** 扩展名优先取 URL 后缀；没有就按 content-type；两者都不认就明确报错 */
function pickExtension(url, contentType) {
  let urlName = '';
  try {
    urlName = decodeURIComponent(path.posix.basename(url.pathname));
  } catch {
    urlName = path.posix.basename(url.pathname);
  }
  const urlExt = path.extname(urlName).toLowerCase();
  if (AUDIO_EXT.has(urlExt)) return urlExt;

  const mimeExt = MIME_EXT[contentType];
  if (mimeExt) return mimeExt;

  if (!contentType.startsWith('audio/')) {
    throw new DomainError('DOWNLOAD_FAILED', `不是音频响应（content-type: ${contentType || '空'}），URL 也没有音频扩展名`);
  }
  throw new DomainError('DOWNLOAD_FAILED', `无法从 content-type 判断音频格式：${contentType}`);
}

/** 流式读 body，累计超过 50MB 立即中止 */
async function readBody(res, controller) {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;

  try {
    if (!reader) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new DomainError('DOWNLOAD_FAILED', '音频超过 50MB 上限');
      if (!buf.length) throw new DomainError('DOWNLOAD_FAILED', '下载到的音频是空文件');
      return buf;
    }

    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* 取消失败不影响报错 */
        }
        controller.abort();
        throw new DomainError('DOWNLOAD_FAILED', '音频超过 50MB 上限');
      }
      chunks.push(Buffer.from(value));
    }
    if (!total) throw new DomainError('DOWNLOAD_FAILED', '下载到的音频是空文件');
    return Buffer.concat(chunks, total);
  } catch (e) {
    if (e instanceof DomainError) throw e;
    if (isAbort(e)) throw new DomainError('DOWNLOAD_FAILED', '下载超时（15 秒），已中止');
    throw new DomainError('DOWNLOAD_FAILED', `下载失败：${errText(e)}`);
  }
}

// ------------------------------------------------------------------ 命名 ---

/** 域名目录名：只留字母数字和 . - _，IPv6 的方括号/冒号一并压成 _ */
function domainDirOf(url) {
  let host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/[^a-z0-9.-]+/g, '_');
  host = host.replace(/^[.-]+|[.-]+$/g, '');
  if (!host) host = 'unknown-host';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(host)) host = '_' + host;
  return host.slice(0, 80);
}

/** 目标文件名：URL 最后一段 + 判定出的扩展名，清掉非法字符，限制长度 */
function desiredFilename(url, ext) {
  let base = '';
  try {
    base = decodeURIComponent(path.posix.basename(url.pathname));
  } catch {
    base = path.posix.basename(url.pathname);
  }

  base = base
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();

  if (!base || base === '.' || base === '..') base = 'sound-' + Date.now().toString(36);

  let stem = base;
  const curExt = path.extname(base).toLowerCase();
  if (curExt) stem = base.slice(0, -curExt.length);
  if (!stem) stem = 'sound';

  stem = Array.from(stem).slice(0, 100).join('');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = '_' + stem;
  return stem + ext;
}

/** 找不冲突的文件名：重名依次加 -1、-2 … */
async function pickFreeName(dir, filename) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = filename;
  for (let i = 1; await exists(path.join(dir, candidate)); i += 1) {
    candidate = stem + '-' + i + ext;
  }
  return candidate;
}

// --------------------------------------------------------------- 内部工具 ---

function ensureInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return;
  throw new DomainError('OUTSIDE_LIB', `路径越出声音库目录：${target}`);
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function isAbort(e) {
  return !!e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
}

function errText(e) {
  return e && e.message ? e.message : String(e);
}
