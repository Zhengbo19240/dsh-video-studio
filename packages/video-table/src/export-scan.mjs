/**
 * 成片扫描与收养：把「绕过工作台出的片」重新纳回工程账本。
 *
 * 报告里的因果关系是：看不见 → 自己渲 → 片子不在工程里 → 声音也进不去。
 * 前面几条把「看不见」堵上了；这里堵最后一环：只要片子还在工程目录里，
 * 无论它是不是工作台导出的，都能被扫描发现、被收养登记。
 *
 * 约定：
 *   - 扫描只读：只列文件、读大小与（有 ffprobe 时的）时长，不改工程。
 *   - 收养只改工程文档里的 exports[]，**不复制、不移动文件**。
 *   - 路径一律存相对工程根的 posix 路径，换机器不散架。
 */

import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from './analyze.mjs';
import { asrPaths } from './asr-deps.mjs';
import { DomainError } from './domain.mjs';

export const EXPORT_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm'];

/** 工程里的「成片」目录（约定，不是硬限制：子目录里的也算）。 */
const EXPORT_DIRS = ['exports', 'output', 'dist'];

function shouldSkipDir(name) {
  return name === 'node_modules' || name === '.git' || name === 'assets' || name === 'code';
}

function toPosix(rel) {
  return rel.split(path.sep).join('/');
}

/**
 * 找 ffprobe：环境变量 → ASR 依赖目录 → PATH。
 * 找不到不是错误：时长就留 null，慢慢补。
 */
export function findFfprobe() {
  const explicit = process.env.DSH_FFPROBE_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  try {
    const guess = path.join(asrPaths().ffmpegDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(guess)) return guess;
  } catch {
    /* asr-deps 算不出来就算了 */
  }
  return null;
}

/** ffprobe 读时长；失败一律 null（不猜）。 */
export async function probeDuration(abs, ffprobePath) {
  if (!ffprobePath) return { duration: null, probe: null, reason: 'NO_FFPROBE' };
  try {
    const out = await exec(
      ffprobePath,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration:stream=width,height,codec_name', '-of', 'json', abs],
      { timeoutMs: 8000 },
    );
    const text = typeof out === 'string' ? out : (out && out.stdout) || '';
    const parsed = JSON.parse(text);
    const duration = Number(parsed && parsed.format && parsed.format.duration);
    const stream = (parsed.streams && parsed.streams[0]) || {};
    return {
      duration: Number.isFinite(duration) && duration > 0 ? duration : null,
      probe: {
        width: Number(stream.width) || null,
        height: Number(stream.height) || null,
        codec: stream.codec_name || null,
      },
      reason: null,
    };
  } catch (e) {
    return { duration: null, probe: null, reason: (e && (e.code || e.message)) || 'PROBE_FAILED' };
  }
}

/**
 * 扫描工程目录下所有 mp4/mov（含子目录），标出哪些没在 doc.exports[] 里。
 *
 * @param {string} root
 * @param {object} doc  工程文档（只看 exports[]）
 * @returns {{ root, scanned, registered, unmanaged:Array, files:Array }}
 */
export async function scanExports(root, doc, options = {}) {
  const base = path.resolve(root);
  const registered = new Set(
    (doc && Array.isArray(doc.exports) ? doc.exports : [])
      .map((e) => (e && e.path ? toPosix(String(e.path)).replace(/^\.\//, '') : null))
      .filter(Boolean),
  );
  const found = [];

  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.dsh-video' || shouldSkipDir(entry.name)) continue;
        await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!EXPORT_EXTENSIONS.includes(ext)) continue;
      found.push(abs);
    }
  }
  await walk(base, 0);

  const files = [];
  for (const abs of found) {
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      continue;
    }
    const rel = toPosix(path.relative(base, abs));
    const known = registered.has(rel);
    const item = { path: rel, abs, size: stat.size, at: stat.mtime.toISOString(), managed: known };
    if (!known) {
      item.unmanaged = true;
      const found2 = await probeDuration(abs, options.ffprobePath === undefined ? findFfprobe() : options.ffprobePath);
      item.duration = found2.duration;
      item.probe = found2.probe;
      if (found2.reason) item.probeReason = found2.reason;
    }
    files.push(item);
  }
  files.sort((a, b) => String(a.path).localeCompare(String(b.path)));

  const registeredMissing = [];
  for (const rel of registered) {
    const abs = path.resolve(base, rel);
    if (!fs.existsSync(abs)) registeredMissing.push(rel);
  }

  return {
    root: base,
    scanDirs: EXPORT_DIRS,
    scanned: files.length,
    registered: files.filter((f) => f.managed).length,
    unmanaged: files.filter((f) => f.unmanaged),
    missingFiles: registeredMissing,
    files,
  };
}

/**
 * 收养：把一个已存在的文件登记进 exports[]。不复制文件。
 * 给了不在工程内的绝对路径就直接拒绝（工程账本只记工程里的东西）。
 */
export async function adoptExport(store, doc, input) {
  const base = path.resolve(doc.root);
  const abs = path.isAbsolute(String(input.path || '')) ? path.resolve(input.path) : path.resolve(base, String(input.path || ''));
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new DomainError('OUTSIDE_PROJECT', '只能收养工程目录里的文件: ' + input.path);
  }
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    throw new DomainError('NOT_FOUND', '文件不存在: ' + abs);
  }
  if (!stat.isFile()) throw new DomainError('INVALID_ARG', '不是文件: ' + abs);
  if (!EXPORT_EXTENSIONS.includes(path.extname(abs).toLowerCase())) {
    throw new DomainError('INVALID_ARG', `不是可识别的成片格式（只认 ${EXPORT_EXTENSIONS.join(' / ')}）: ${path.basename(abs)}`);
  }
  const probe = await probeDuration(abs, input.ffprobePath === undefined ? findFfprobe() : input.ffprobePath);
  const recorded = await store.recordExport(doc.projectId, {
    path: toPosix(rel),
    duration: input.duration != null ? Number(input.duration) : probe.duration,
    size: stat.size,
    at: stat.mtime.toISOString(),
    source: input.source || 'adopted',
  }, { actor: 'agent' });
  return {
    ...recorded,
    created: recorded.created,
    duration: recorded.export.duration,
    probe: probe.probe,
    probeReason: probe.reason,
    copied: false,
  };
}
