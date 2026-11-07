/**
 * Code-layer storage: one folder per layer under <root>/code/<layerId>/.
 *
 * The document only stores layerId + codeHash; the source lives on disk so the
 * agent can read it back, diff it and regenerate it like any other file.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DomainError } from './domain.mjs';

const SAFE = /^[a-zA-Z0-9_-]{1,64}$/;

function assertLayerId(layerId) {
  if (!SAFE.test(String(layerId || ''))) {
    throw new DomainError('INVALID_ARG', 'layerId 只允许字母数字下划线和短横线: ' + layerId);
  }
}

export function codeDir(root, layerId) {
  assertLayerId(layerId);
  const dir = path.join(path.resolve(root), 'code', layerId);
  const rel = path.relative(path.resolve(root), dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new DomainError('OUTSIDE_PROJECT', '代码目录越界');
  return dir;
}

export async function writeCode(root, layerId, source) {
  if (typeof source !== 'string' || !source.trim()) throw new DomainError('INVALID_ARG', '源码不能为空');
  if (source.length > 512 * 1024) throw new DomainError('INVALID_ARG', '源码过大（>512KB）');
  const dir = codeDir(root, layerId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'index.js');
  const tmp = file + '.tmp-' + process.pid;
  await fs.writeFile(tmp, source, 'utf8');
  await fs.rename(tmp, file);
  return { layerId, codeHash: 'sha256:' + createHash('sha256').update(source).digest('hex') };
}

export async function readCode(root, layerId) {
  const file = path.join(codeDir(root, layerId), 'index.js');
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new DomainError('NOT_FOUND', '代码图层不存在: ' + layerId);
    throw e;
  }
}

export async function listCodeLayers(root) {
  const dir = path.join(path.resolve(root), 'code');
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
