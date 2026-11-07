/**
 * Kenney 音效包：列出 → 下载 → 解压。
 *
 * 零 npm 依赖：
 *   - 列表：抓 https://kenney.nl/assets/category:Audio，解析 `<h2><a href="/assets/<slug>">标题</a></h2>`；
 *     页面结构变了就退回资源主页，再不行返回空数组 + 人话原因（不抛）。
 *   - 下载：kenney.nl 现在不直接暴露 zip，要两步：
 *       1) 资源页里读 data-download-id（读不到就用 "assets/<slug>" 的十六进制兜底）；
 *       2) GET https://kenney.nl/download-link/<id> 拿签名 zip 地址。
 *   - 解压：优先系统自带 `tar -xf`（Windows 10+ 的 bsdtar 支持 zip）；
 *     没有 tar 或失败时退回 PowerShell `Expand-Archive`；
 *     两者都失败就把 zip 留在根目录旁边，明确报告「已下载但需手动解压」。
 *
 * 安全：解压目标必须落在某个已配置的声音库根目录内（OUTSIDE_LIB）；
 * 解压前先读 zip 中央目录，发现绝对路径或 `..` 就拒绝解压。
 *
 * 超时 5 分钟、zip 上限 500MB；所有失败都抛带中文原因的 DomainError。
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DomainError } from './domain.mjs';
import { AUDIO_EXTENSIONS, soundSourcesRoots } from './sound-lib.mjs';

const SITE = 'https://kenney.nl';
const AUDIO_LIST_URL = SITE + '/assets/category:Audio';
const ASSETS_URL = SITE + '/assets';
const PAGE_TIMEOUT_MS = 15 * 1000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ZIP_BYTES = 500 * 1024 * 1024;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) dsh-video-workbench/0.1';

const AUDIO_EXT = new Set(AUDIO_EXTENSIONS);

// ------------------------------------------------------------------ 列表 ---

/**
 * 从一段 HTML 里解析资源包。纯函数，测试直接喂固定 HTML。
 * 返回 { packs: [{id,title,url,license,category}], reason }。
 */
export function parseKenneyPacks(html) {
  const text = String(html == null ? '' : html);
  const found = new Map();

  // 主解析：卡片标题就是 <h2><a href="…/assets/<slug>">标题</a></h2>
  const byHeading = /<h2[^>]*>\s*<a[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>\s*<\/h2>/gi;
  for (const match of text.matchAll(byHeading)) {
    const pack = normalizeAssetLink(match[1], match[2]);
    if (pack) found.set(pack.url, pack);
  }

  // 兜底：页面结构变了、没有 h2 时，抓所有 /assets/<slug> 链接，标题用 slug
  if (!found.size) {
    const anyAnchor = /<a[^>]*href=['"]([^'"]*\/assets\/[^'"]+)['"][^>]*>/gi;
    for (const match of text.matchAll(anyAnchor)) {
      const pack = normalizeAssetLink(match[1], '');
      if (pack) found.set(pack.url, pack);
    }
  }

  const packs = [...found.values()];
  if (!packs.length) {
    return { packs: [], reason: '没有从页面里解析到任何资源包链接（页面结构可能变了）' };
  }
  return { packs, reason: null };
}

/**
 * 抓 kenney.nl 的音频分类页并解析；解析不到时退回资源主页。
 * 任何网络/结构问题都不抛，返回 { packs: [], reason }。
 */
export async function listKenneyPacks() {
  const attempts = [
    { url: AUDIO_LIST_URL, label: '音频分类页', fallback: false },
    { url: ASSETS_URL, label: '资源主页', fallback: true },
  ];
  const reasons = [];

  for (const attempt of attempts) {
    let res;
    try {
      res = await fetchWithTimeout(attempt.url, PAGE_TIMEOUT_MS);
    } catch (e) {
      reasons.push(`${attempt.label}请求失败：${errText(e)}`);
      continue;
    }
    if (!res.ok) {
      reasons.push(`${attempt.label}返回 HTTP ${res.status}`);
      continue;
    }

    let html;
    try {
      html = await res.text();
    } catch (e) {
      reasons.push(`${attempt.label}读取失败：${errText(e)}`);
      continue;
    }

    const parsed = parseKenneyPacks(html);
    if (parsed.packs.length) {
      return {
        packs: parsed.packs,
        reason: attempt.fallback ? '音频分类页没解析到资源包，已退回资源主页（清单可能包含非音频包）' : null,
      };
    }
    reasons.push(`${attempt.label}：${parsed.reason || '没有音频包'}`);
  }

  return { packs: [], reason: reasons.join('；') || '没有从 kenney.nl 获取到任何资源包' };
}

// ------------------------------------------------------------------ 安装 ---

/**
 * 安装一个 Kenney 包到 rootName 指定的根（省略则第一个根）。
 * 返回 { installed, files, root, rootName, packName, manual, zipPath, reason }。
 */
export async function installKenneyPack({ packUrl, rootName } = {}, onProgress) {
  const raw = String(packUrl == null ? '' : packUrl).trim();
  if (!raw) throw new DomainError('INVALID_ARG', '缺少 packUrl');
  if (!isKenneyUrl(raw)) {
    throw new DomainError('INVALID_ARG', '只支持 kenney.nl 的资源页或下载链接：' + raw);
  }

  const root = await pickRoot(rootName);
  const packName = packSlugFromUrl(raw);
  const targetDir = path.join(root.path, packName);
  const result = await downloadKenneyPack(raw, targetDir, onProgress);
  return { ...result, packName };
}

/**
 * 下载并解压一个 Kenney 包到 targetDir。
 *
 * targetDir 必须是某个已配置根的子孙目录（防止把 zip 解到库外）。
 * onProgress 会收到 {phase:'resolve'|'download'|'extract'|'done', received, total, ratio}。
 */
export async function downloadKenneyPack(packUrl, targetDir, onProgress) {
  const raw = String(packUrl == null ? '' : packUrl).trim();
  if (!raw) throw new DomainError('INVALID_ARG', '缺少 packUrl');
  if (!isKenneyUrl(raw)) {
    throw new DomainError('INVALID_ARG', '只支持 kenney.nl 的资源页或下载链接：' + raw);
  }
  if (typeof targetDir !== 'string' || !targetDir.trim()) {
    throw new DomainError('INVALID_ARG', '缺少解压目标目录 targetDir');
  }

  const roots = await soundSourcesRoots();
  const target = path.resolve(targetDir);
  const root = roots.find((r) => isInsidePath(path.resolve(r.path), target));
  if (!root) {
    throw new DomainError('OUTSIDE_LIB', `解压目标必须在已配置的声音库根目录内：${targetDir}`);
  }

  const report = (event) => {
    try {
      if (typeof onProgress === 'function') onProgress(event);
    } catch {
      /* 进度回调失败不影响下载 */
    }
  };

  report({ phase: 'resolve' });
  const packName = packSlugFromUrl(raw);
  const { zipUrl } = await resolveZipUrl(raw);

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-kenney-'));
  const zipPath = path.join(tmpRoot, 'pack.zip');

  try {
    report({ phase: 'download', received: 0, total: null, ratio: null });
    const bytes = await downloadToFile(zipUrl, zipPath, (received, total) => {
      report({ phase: 'download', received, total, ratio: total ? received / total : null });
    });

    report({ phase: 'extract' });
    const staging = path.join(tmpRoot, 'unzip');
    await fs.mkdir(staging, { recursive: true });

    const extracted = await extractZip(zipPath, staging);
    if (!extracted.ok) {
      // 解压失败：把 zip 留在根目录旁边，让用户手动解压，不静默吞掉
      await fs.mkdir(root.path, { recursive: true });
      const keepPath = path.join(root.path, packName + '.zip');
      try {
        await fs.copyFile(zipPath, keepPath);
      } catch {
        /* 复制失败时下面仍然会报告原因，只是 zip 不在了 */
      }
      report({ phase: 'done', installed: false });
      return {
        installed: false,
        files: 0,
        root: root.path,
        rootName: root.name,
        manual: true,
        zipPath: keepPath,
        reason: extracted.reason,
        bytes,
      };
    }

    await moveInto(staging, target);
    const files = await countAudioFiles(target);
    report({ phase: 'done', installed: true, files });
    return {
      installed: true,
      files,
      root: root.path,
      rootName: root.name,
      manual: false,
      zipPath: null,
      reason: files ? null : '解压完成，但没有在包里找到音频文件',
      bytes,
    };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// -------------------------------------------------------------- 下载地址 ---

/**
 * 资源页 → 签名 zip 地址。
 * 已经是 .zip 直链时原样返回。
 */
async function resolveZipUrl(packUrl) {
  const pageUrl = new URL(packUrl);
  if (/\.zip$/i.test(pageUrl.pathname)) return { zipUrl: pageUrl.toString() };

  let res;
  try {
    res = await fetchWithTimeout(pageUrl.toString(), PAGE_TIMEOUT_MS, { referer: ASSETS_URL });
  } catch (e) {
    throw new DomainError('DOWNLOAD_FAILED', `打开资源页失败：${errText(e)}`);
  }
  if (!res.ok) throw new DomainError('DOWNLOAD_FAILED', `打开资源页失败：HTTP ${res.status}`);

  let html;
  try {
    html = await res.text();
  } catch (e) {
    throw new DomainError('DOWNLOAD_FAILED', `读取资源页失败：${errText(e)}`);
  }

  const idMatch = /data-download-id=['"]([0-9a-f]{8,})['"]/i.exec(html);
  let downloadId = idMatch ? idMatch[1] : '';
  if (!downloadId) {
    // 兜底：data-download-id 就是 "assets/<slug>" 的十六进制
    const slug = /\/assets\/([^/?#]+)\/?$/.exec(pageUrl.pathname);
    if (slug) downloadId = Buffer.from('assets/' + slug[1], 'utf8').toString('hex');
  }
  if (!downloadId) {
    throw new DomainError('DOWNLOAD_FAILED', '资源页里没有下载标识（data-download-id），页面结构可能变了');
  }

  const linkUrl = SITE + '/download-link/' + encodeURIComponent(downloadId);
  let linkRes;
  try {
    linkRes = await fetchWithTimeout(linkUrl, PAGE_TIMEOUT_MS, {
      referer: pageUrl.toString(),
      accept: 'application/json, text/plain, */*',
    });
  } catch (e) {
    throw new DomainError('DOWNLOAD_FAILED', `获取下载链接失败：${errText(e)}`);
  }
  if (!linkRes.ok) throw new DomainError('DOWNLOAD_FAILED', `获取下载链接失败：HTTP ${linkRes.status}`);

  let data;
  try {
    data = await linkRes.json();
  } catch {
    throw new DomainError('DOWNLOAD_FAILED', '获取下载链接的响应不是合法 JSON');
  }

  const zipUrl = data && typeof data.url === 'string' ? data.url.trim() : '';
  if (!zipUrl) {
    throw new DomainError('DOWNLOAD_FAILED', 'kenney.nl 没有返回下载地址（可能需要先在浏览器里打开一次资源页）');
  }
  return { zipUrl };
}

/** 流式下载到文件，边下边报进度；超时 / 超限都明确报错 */
async function downloadToFile(url, dest, onProgress) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    let res;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, accept: 'application/zip,application/octet-stream,*/*' },
      });
    } catch (e) {
      if (isAbort(e)) throw new DomainError('DOWNLOAD_FAILED', '下载超时（5 分钟），已中止');
      throw new DomainError('DOWNLOAD_FAILED', `下载失败：${errText(e)}`);
    }
    if (!res.ok) throw new DomainError('DOWNLOAD_FAILED', `下载失败：HTTP ${res.status}`);

    const total = Number(res.headers.get('content-length')) || 0;
    if (total > MAX_ZIP_BYTES) throw new DomainError('DOWNLOAD_FAILED', '音效包超过 500MB 上限');

    const out = createWriteStream(dest, { flags: 'wx' });
    let received = 0;
    let lastReport = 0;

    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        if (received > MAX_ZIP_BYTES) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          controller.abort();
          throw new DomainError('DOWNLOAD_FAILED', '音效包超过 500MB 上限');
        }
        if (!out.write(Buffer.from(value))) await once(out, 'drain');
        if (received - lastReport > 256 * 1024) {
          lastReport = received;
          onProgress(received, total || null);
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    } finally {
      out.destroy();
    }

    if (!received) throw new DomainError('DOWNLOAD_FAILED', '下载到的音效包是空文件');
    onProgress(received, total || received);
    return received;
  } catch (e) {
    if (e instanceof DomainError) throw e;
    if (isAbort(e)) throw new DomainError('DOWNLOAD_FAILED', '下载超时（5 分钟），已中止');
    throw new DomainError('DOWNLOAD_FAILED', `下载失败：${errText(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ 解压 ---

/**
 * 解压到 destDir；默认 tar 优先，失败退回 Expand-Archive。
 * options.prefer='powershell' 只给验证用（可以单独验证备用解压路径）。
 * 两条路都失败时返回 {ok:false, reason}，调用方保留 zip 并报告需手动解压。
 */
export async function extractZip(zipFile, destDir, { prefer = 'auto' } = {}) {
  // 先读 zip 中央目录做路径守卫；读不出来（zip64 等）就交给解压器，不因此拒绝
  const names = await listZipEntryNames(zipFile).catch(() => null);
  if (names && names.some(isUnsafeZipName)) {
    return { ok: false, reason: '压缩包里含有绝对路径或 .. 路径，已拒绝解压' };
  }

  let tarReason = '按需跳过 tar';
  if (prefer !== 'powershell') {
    const tar = await runCommand('tar', ['-xf', zipFile, '-C', destDir], 120000);
    if (tar.ok) return { ok: true };
    tarReason =
      tar.code === 'ENOENT' ? '系统没有 tar 命令' : `tar 解压失败（${short(tar.detail) || '退出码 ' + tar.code}）`;
  }

  const ps = await runPowerShellExpandArchive(zipFile, destDir);
  if (ps.ok) return { ok: true };

  const psReason =
    ps.code === 'ENOENT'
      ? '找不到 PowerShell'
      : `Expand-Archive 无法解压（${short(ps.detail) || '退出码 ' + ps.code}）`;
  return { ok: false, reason: `${tarReason}；${psReason}；已下载但需手动解压` };
}

/** 用系统 PowerShell 解压（-EncodedCommand 避免引号转义问题） */
async function runPowerShellExpandArchive(zipFile, destDir) {
  const script =
    "$ProgressPreference = 'SilentlyContinue'; try { Expand-Archive -LiteralPath '" +
    psQuote(zipFile) +
    "' -DestinationPath '" +
    psQuote(destDir) +
    "' -Force -ErrorAction Stop; exit 0 } catch { [Console]::Error.WriteLine('DSH_ERR: ' + $_.Exception.Message); exit 1 }";
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];

  for (const exe of ['powershell.exe', 'pwsh.exe', 'pwsh']) {
    let result = await runCommand(exe, args, 180000);
    if (result.ok) return result;
    if (result.code === 'ENOENT' || result.code === 'SPAWN') continue; // 换下一个可执行文件
    // PowerShell 模块加载会往 stdout 打一堆东西；只取我们自己的错误行
    if (result.detail) {
      const marker = result.detail.indexOf('DSH_ERR:');
      if (marker >= 0) result = { ...result, detail: result.detail.slice(marker + 'DSH_ERR:'.length).trim() };
    }
    return result;
  }
  return { ok: false, code: 'ENOENT', detail: '找不到 PowerShell' };
}

/** 起一个子进程并等它结束；ENOENT 单独标出来，方便换成备选方案 */
function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, code: 'ENOENT', detail: errText(e) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        if (stdout.length < 4000) stdout += chunk.toString('utf8');
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 4000) stderr += chunk.toString('utf8');
      });
    }
    child.on('error', (e) => finish({ ok: false, code: e.code || 'SPAWN', detail: errText(e) }));
    child.on('close', (code) => finish({ ok: code === 0, code, detail: stderr.trim() || stdout.trim() }));
  });
}

/**
 * 读 zip 中央目录里的条目名（不解压）。zip64 / 读不出来时返回 null。
 * 目的只有一个：解压前发现 `..` 与绝对路径。
 */
async function listZipEntryNames(file) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
  } catch {
    return null;
  }

  try {
    const size = (await fh.stat()).size;
    if (size < 22) return null;

    const tailLen = Math.min(size, 65557); // EOCD 注释最长 65535 字节
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;

    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (!count || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null; // zip64 不解析
    if (cdSize > 8 * 1024 * 1024 || cdOffset + cdSize > size) return null;

    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);

    const names = [];
    let offset = 0;
    for (let i = 0; i < count && offset + 46 <= cd.length; i += 1) {
      if (cd.readUInt32LE(offset) !== 0x02014b50) return names.length ? names : null;
      const nameLen = cd.readUInt16LE(offset + 28);
      const extraLen = cd.readUInt16LE(offset + 30);
      const commentLen = cd.readUInt16LE(offset + 32);
      const start = offset + 46;
      if (start + nameLen > cd.length) break;
      names.push(cd.toString('utf8', start, start + nameLen));
      offset = start + nameLen + extraLen + commentLen;
    }
    return names;
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** zip 条目名是否危险（绝对路径 / 盘符 / ..） */
function isUnsafeZipName(name) {
  const normalized = String(name).replace(/\\/g, '/');
  if (!normalized) return true;
  if (normalized.startsWith('/')) return true;
  if (/^[a-zA-Z]:/.test(normalized)) return true;
  return normalized.split('/').some((segment) => segment === '..');
}

// ------------------------------------------------------------------ 落盘 ---

/**
 * 把 staging 里的内容搬到 target：
 * 很多 Kenney 包外面还套一层目录，如果 staging 里只有一个目录，就直接搬它的内容。
 */
async function moveInto(staging, target) {
  let source = staging;
  const entries = await fs.readdir(staging, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    source = path.join(staging, entries[0].name);
  }

  await fs.mkdir(target, { recursive: true });
  const items = await fs.readdir(source, { withFileTypes: true });
  for (const item of items) {
    await fs.cp(path.join(source, item.name), path.join(target, item.name), { recursive: true, force: true });
  }
}

/** 数一数解压后有多少个音频文件（深度上限 8） */
async function countAudioFiles(dir, depth = 0) {
  if (depth > 8) return 0;
  let items;
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let count = 0;
  for (const item of items) {
    if (item.name.startsWith('.')) continue;
    if (item.isDirectory()) count += await countAudioFiles(path.join(dir, item.name), depth + 1);
    else if (item.isFile() && AUDIO_EXT.has(path.extname(item.name).toLowerCase())) count += 1;
  }
  return count;
}

// ------------------------------------------------------------------ 工具 ---

/** 是否是 kenney.nl 的 http(s) 地址 */
export function isKenneyUrl(raw) {
  let url;
  try {
    url = new URL(String(raw == null ? '' : raw).trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return /(^|\.)kenney\.nl$/i.test(url.hostname);
}

/** 从资源页 / zip 地址推一个安全的包目录名 */
export function packSlugFromUrl(raw) {
  const url = new URL(String(raw == null ? '' : raw).trim());
  const fromPath = /\/assets\/([^/?#]+)/.exec(url.pathname);
  if (fromPath && /^[a-z0-9._-]+$/i.test(fromPath[1])) return sanitizeSlug(fromPath[1]);

  let base = '';
  try {
    base = decodeURIComponent(path.posix.basename(url.pathname));
  } catch {
    base = path.posix.basename(url.pathname);
  }
  base = base.replace(/\.zip$/i, '').replace(/^kenney[_-]?/i, '');
  return sanitizeSlug(base);
}

function sanitizeSlug(value) {
  const cleaned = String(value)
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  return cleaned || 'kenney-pack';
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

// --------------------------------------------------------------- 内部工具 ---

function normalizeAssetLink(href, innerHtml) {
  let url;
  try {
    url = new URL(decodeEntities(href), SITE);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!/(^|\.)kenney\.nl$/i.test(url.hostname)) return null;

  const match = /\/assets\/([^/?#]+)\/?$/.exec(url.pathname);
  if (!match) return null;

  const slug = match[1];
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) return null;
  // category:Audio / tag:xxx / series:xxx 这类是分类入口，不是资源包
  if (/^(category|tag|series)[:._-]/i.test(slug)) return null;
  if (/^(page|search|upcoming)$/i.test(slug)) return null;

  return {
    id: slug,
    title: plainText(innerHtml) || slug,
    url: SITE + '/assets/' + slug,
    license: 'CC0',
    category: 'audio',
  };
}

function plainText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

async function fetchWithTimeout(url, timeoutMs, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, ...extraHeaders },
    });
  } finally {
    clearTimeout(timer);
  }
}

function isInsidePath(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function psQuote(p) {
  return String(p).replace(/'/g, "''");
}

function short(text) {
  const value = String(text || '').trim();
  return value.length > 300 ? value.slice(0, 300) + '…' : value;
}

function isAbort(e) {
  return !!e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
}

function errText(e) {
  return e && e.message ? e.message : String(e);
}
