#!/usr/bin/env node
/**
 * 下载 Kenney 的 CC0 音效包，解压到本地声音库。
 *
 *   node packages/sound-library/scripts/download-sounds.mjs
 *   node packages/sound-library/scripts/download-sounds.mjs --list
 *   node packages/sound-library/scripts/download-sounds.mjs --pack ui-audio
 *   node packages/sound-library/scripts/download-sounds.mjs --force
 *
 * 落点：<DSH_SOUND_LIB 或 ~/.dsh/sound-library>/kenney/<pack>/…
 * 这个布局与同目录 index.json 里的相对路径一一对应 —— 下完直接用现成索引，
 * 不需要再跑分析器。
 *
 * 音效包来自 kenney.nl，CC0 1.0（公共领域）。脚本只做下载与解压，不改音频。
 */

import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SITE = 'https://kenney.nl';
const USER_AGENT =
  'Mozilla/5.0 (compatible; dsh-video-suite-sound-library/0.1; +https://github.com/)';
const PAGE_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ZIP_BYTES = 500 * 1024 * 1024;

const HERE = import.meta.dirname;
const INDEX_FILE = path.join(HERE, '..', 'index.json');

function say(message) {
  process.stdout.write(message + '\n');
}

function fail(message) {
  process.stderr.write(message + '\n');
  process.exitCode = 1;
}

/** 声音库根目录：与插件默认值保持一致 */
function libraryRoot() {
  const fromEnv = process.env.DSH_SOUND_LIB;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.dsh', 'sound-library');
}

async function fetchWithTimeout(url, { timeoutMs = PAGE_TIMEOUT_MS, headers = {}, accept } = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': USER_AGENT,
      referer: SITE + '/assets',
      ...(accept ? { accept } : {}),
      ...headers,
    },
  });
  return res;
}

/** 资源页 → 签名 zip 地址（kenney.nl 的下载是两步：页面 id → /download-link/<id>） */
async function resolveZipUrl(packId) {
  const pageUrl = SITE + '/assets/' + encodeURIComponent(packId);
  const res = await fetchWithTimeout(pageUrl);
  if (!res.ok) throw new Error('打开资源页失败：HTTP ' + res.status + '（' + pageUrl + '）');
  const html = await res.text();

  const match = /data-download-id=['"]([0-9a-f]{8,})['"]/i.exec(html);
  const downloadId = match ? match[1] : Buffer.from('assets/' + packId, 'utf8').toString('hex');

  const linkRes = await fetchWithTimeout(SITE + '/download-link/' + encodeURIComponent(downloadId), {
    accept: 'application/json, text/plain, */*',
    headers: { referer: pageUrl },
  });
  if (!linkRes.ok) throw new Error('获取下载链接失败：HTTP ' + linkRes.status);
  const data = await linkRes.json().catch(() => null);
  const zipUrl = data && typeof data.url === 'string' ? data.url.trim() : '';
  if (!zipUrl) throw new Error('kenney.nl 没有返回下载地址（页面结构可能变了）');
  return zipUrl;
}

async function download(zipUrl, dest) {
  const res = await fetchWithTimeout(zipUrl, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    accept: 'application/zip,application/octet-stream,*/*',
  });
  if (!res.ok) throw new Error('下载失败：HTTP ' + res.status);
  const total = Number(res.headers.get('content-length') || 0);
  if (total > MAX_ZIP_BYTES) throw new Error('音效包超过 500MB 上限');

  const out = createWriteStream(dest);
  let received = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_ZIP_BYTES) body.destroy(new Error('音效包超过 500MB 上限'));
    if (total) {
      const pct = Math.floor((received / total) * 100);
      if (pct % 20 === 0) process.stdout.write('\r  下载中 ' + pct + '%   ');
    }
  });
  await pipeline(body, out);
  process.stdout.write('\r  下载完成 ' + (received / 1024 / 1024).toFixed(1) + ' MB\n');
}

function run(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, code: -1, stderr: String(e && e.message) });
      return;
    }
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.stdout.resume();
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stderr: String(e && e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stderr });
    });
  });
}

/** 拒绝绝对路径 / 盘符 / 上级目录的 zip 条目 */
function unsafeName(name) {
  return /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(name) || name.split(/[\\/]/).includes('..');
}

async function extract(zipFile, destDir) {
  await fs.mkdir(destDir, { recursive: true });

  const list = await listZip(zipFile);
  if (list && list.some(unsafeName)) throw new Error('压缩包里有越界路径，拒绝解压');

  const out = await run('tar', ['-xf', zipFile, '-C', destDir]);
  if (out.ok) return;

  if (process.platform === 'win32') {
    const ps =
      'Expand-Archive -LiteralPath ' +
      psQuote(zipFile) +
      ' -DestinationPath ' +
      psQuote(destDir) +
      ' -Force';
    const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], 300000);
    if (out.ok) return;
    throw new Error('解压失败：' + (out.stderr || 'tar 与 Expand-Archive 都不可用'));
  }
  throw new Error('解压失败：系统里没有可用的 tar');
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function listZip(zipFile) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('tar', ['-tf', zipFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.split(/\r?\n/).filter(Boolean) : null));
  });
}

async function existingFiles(dir) {
  let count = 0;
  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(path.join(current, entry.name));
      else count += 1;
    }
  }
  await walk(dir);
  return count;
}

async function writeSourcesIfMissing(root) {
  const file = path.join(os.homedir(), '.dsh', 'sound-sources.json');
  try {
    await fs.access(file);
    return file;
  } catch {
    /* 不存在就写 */
  }
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const body = JSON.stringify({ roots: [{ name: 'kenney', path: path.join(root, 'kenney') }] }, null, 2) + '\n';
    await fs.writeFile(file, body, 'utf8');
    return file;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const listOnly = args.includes('--list');
  const dryRun = args.includes('--dry-run');
  const packArg = args.includes('--pack') ? args[args.indexOf('--pack') + 1] : null;

  const index = JSON.parse(await fs.readFile(INDEX_FILE, 'utf8'));
  const expected = new Map();
  for (const key of Object.keys(index.items || {})) {
    const parts = key.split('/');
    // key 的形状是 <root>/<pack>/<相对路径>，root 恒为 kenney
    if (parts.length < 3) continue;
    const pack = parts[1];
    if (!pack) continue;
    expected.set(pack, (expected.get(pack) || 0) + 1);
  }
  const packs = [...expected.keys()].sort();

  if (listOnly) {
    say('索引里的音效包（CC0，来自 kenney.nl）：');
    for (const pack of packs) say('  ' + pack.padEnd(26) + expected.get(pack) + ' 个文件');
    say('\n总文件数：' + [...expected.values()].reduce((a, b) => a + b, 0));
    return;
  }

  const root = libraryRoot();
  const kenneyDir = path.join(root, 'kenney');
  say('声音库：' + kenneyDir);

  const targets = packArg ? [packArg] : packs;
  const unknown = targets.filter((p) => !expected.has(p));
  if (unknown.length) {
    fail('索引里没有这些包：' + unknown.join(', ') + '\n可用的包见 --list');
    return;
  }

  if (!dryRun) {
    await fs.mkdir(kenneyDir, { recursive: true });
    const sources = await writeSourcesIfMissing(root);
    say(sources ? '声音源配置：' + sources : '声音源配置没写成（不影响下载，插件启动时会再试一次）');
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sound-'));
  let ok = 0;
  let skipped = 0;
  const failed = [];

  for (const pack of targets) {
    const dest = path.join(kenneyDir, pack);
    const already = await existingFiles(dest);
    if (!force && already >= expected.get(pack)) {
      say('  跳过 ' + pack + '（已有 ' + already + ' 个文件）');
      skipped += 1;
      continue;
    }
    if (dryRun) {
      say('  会下载 ' + pack + '（索引期望 ' + expected.get(pack) + ' 个文件）');
      continue;
    }

    const zipFile = path.join(tmp, pack + '.zip');
    try {
      process.stdout.write('  ' + pack + ' …\n');
      const zipUrl = await resolveZipUrl(pack);
      await download(zipUrl, zipFile);
      await fs.rm(dest, { recursive: true, force: true });
      await extract(zipFile, dest);
      const got = await existingFiles(dest);
      if (got === 0) throw new Error('解压后没有文件');
      say('  完成 ' + pack + '：' + got + ' 个文件' + (got < expected.get(pack) ? '（索引记录 ' + expected.get(pack) + '）' : ''));
      ok += 1;
    } catch (e) {
      failed.push(pack + '：' + (e && e.message ? e.message : String(e)));
      say('  失败 ' + pack + '：' + (e && e.message ? e.message : String(e)));
    } finally {
      await fs.rm(zipFile, { force: true }).catch(() => {});
    }
  }

  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});

  say('');
  say('完成 ' + ok + ' 个，跳过 ' + skipped + ' 个，失败 ' + failed.length + ' 个。');
  if (failed.length) {
    for (const line of failed) fail('  - ' + line);
    fail('失败的包可以稍后重跑；索引里属于这些包的条目在文件补齐前不会命中。');
  } else if (ok > 0) {
    say('索引已在位：不用再跑分析器，直接调用 video_sound_search 即可。');
  }
}

main().catch((e) => {
  fail('下载器崩了：' + (e && e.stack ? e.stack : String(e)));
});
