/**
 * 媒体层测试：不依赖 DSH host，直接在临时目录里跑。
 *
 *   node scripts/media-test.mjs
 *
 * 覆盖：建目录 → 同名两次导入不覆盖 → 扫描 → Range 读取（含钳制）→
 * 路径守卫（../、绝对路径、符号链接逃逸）→ MIME → 磁盘导入 → 文件名清洗。
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureAssetDirs,
  importBytes,
  importFile,
  mimeFor,
  readRange,
  resolveAssetPath,
  scanAssets,
} from '../src/media.mjs';

let pass = 0;
let fail = 0;

async function step(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function rejects(promise, code, label) {
  try {
    await promise;
  } catch (e) {
    assert(e.code === code, `${label}: 期望 ${code}，实际 ${e.code || e.name}`);
    return e;
  }
  throw new Error(`${label}: 没有抛错`);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-media-'));
const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-media-out-'));
const CONTENT_A = Buffer.from('0123456789abcdef');
const CONTENT_B = Buffer.from('fedcba9876543210');

// 目录创建 ---------------------------------------------------------------
await step('ensureAssetDirs 建 assets/cache/exports', async () => {
  const dirs = await ensureAssetDirs(root);
  for (const k of ['assets', 'cache', 'exports']) {
    const st = await fs.stat(dirs[k]);
    assert(st.isDirectory(), k + ' 不是目录');
    assert(path.relative(path.resolve(root), dirs[k]).split(path.sep)[0] === k, k + ' 不在 root 下');
  }
});

// 字节导入 ---------------------------------------------------------------
let first = null;
await step('importBytes 写入 a.mp4 并返回 sha256', async () => {
  first = await importBytes(root, { name: 'a.mp4', bytes: CONTENT_A });
  assert(first.name === 'a.mp4', 'name=' + first.name);
  assert(first.relPath === 'assets/a.mp4', 'relPath=' + first.relPath);
  assert(first.size === CONTENT_A.length, 'size=' + first.size);
  assert(first.hash === 'sha256:' + createHash('sha256').update(CONTENT_A).digest('hex'), 'hash 不对');
  assert(first.mime === 'video/mp4', 'mime=' + first.mime);
  const disk = await fs.readFile(path.join(root, 'assets', 'a.mp4'));
  assert(disk.equals(CONTENT_A), '落盘内容不对');
});

let second = null;
await step('importBytes 同名第二次不覆盖，加 -1 后缀', async () => {
  second = await importBytes(root, { name: 'a.mp4', bytes: CONTENT_B });
  assert(second.name === 'a-1.mp4', 'name=' + second.name);
  assert(second.relPath === 'assets/a-1.mp4', 'relPath=' + second.relPath);
  assert(second.hash !== first.hash, '两次 hash 不应相同');
  const disk = await fs.readFile(path.join(root, 'assets', 'a.mp4'));
  assert(disk.equals(CONTENT_A), '原文件被覆盖了');
  const disk2 = await fs.readFile(path.join(root, 'assets', 'a-1.mp4'));
  assert(disk2.equals(CONTENT_B), '第二个文件内容不对');
});

// 扫描 -------------------------------------------------------------------
await step('scanAssets 列出两个文件并按文件名排序', async () => {
  const list = await scanAssets(root);
  assert(list.length === 2, 'length=' + list.length);
  assert(list[0].name === 'a-1.mp4', '排序不对: ' + list.map((x) => x.name).join(','));
  assert(list[1].name === 'a.mp4', '排序不对: ' + list.map((x) => x.name).join(','));
  for (const item of list) {
    assert(item.relPath === 'assets/' + item.name, 'relPath=' + item.relPath);
    assert(item.mime === 'video/mp4', 'mime=' + item.mime);
    assert(typeof item.mtimeMs === 'number' && item.mtimeMs > 0, 'mtimeMs=' + item.mtimeMs);
  }
  assert(list[1].size === CONTENT_A.length, 'size=' + list[1].size);
});

await step('scanAssets 目录不存在返回 []', async () => {
  const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-media-empty-'));
  const list = await scanAssets(emptyRoot);
  assert(Array.isArray(list) && list.length === 0, '期望空数组');
  await fs.rm(emptyRoot, { recursive: true, force: true });
});

// Range 读取 -------------------------------------------------------------
await step('readRange 从 0 读 4 字节', async () => {
  const abs = await resolveAssetPath(root, 'assets/a.mp4');
  const r = await readRange(abs, 0, 4);
  assert(Buffer.from(r.bytes).toString() === '0123', 'bytes=' + Buffer.from(r.bytes).toString());
  assert(r.start === 0 && r.length === 4 && r.size === CONTENT_A.length, 'shape 不对');
  assert(r.bytes instanceof Uint8Array, 'bytes 不是 Uint8Array');
});

await step('readRange 越界 start 钳制为空、负数 start 钳制为 0', async () => {
  const abs = await resolveAssetPath(root, 'assets/a.mp4');
  const over = await readRange(abs, 999, 8);
  assert(over.start === CONTENT_A.length, 'start=' + over.start);
  assert(over.length === 0 && over.bytes.length === 0, '越界应读空');

  const neg = await readRange(abs, -5, 4);
  assert(neg.start === 0 && neg.length === 4, 'start=' + neg.start + ' length=' + neg.length);
  assert(Buffer.from(neg.bytes).toString() === '0123', '负数 start 内容不对');

  const long = await readRange(abs, 14, 100);
  assert(long.start === 14 && long.length === 2, 'start=' + long.start + ' length=' + long.length);
  assert(Buffer.from(long.bytes).toString() === 'ef', '尾部内容不对');
});

await step('readRange 文件不存在抛 NOT_FOUND', async () => {
  const missing = path.join(root, 'assets', 'nope.mp4');
  await rejects(readRange(missing, 0, 4), 'NOT_FOUND', 'readRange');
});

// 路径守卫 ---------------------------------------------------------------
await step('resolveAssetPath 返回 root 内绝对路径', async () => {
  const abs = await resolveAssetPath(root, 'assets/a.mp4');
  assert(path.isAbsolute(abs), '不是绝对路径');
  assert(abs === path.resolve(root, 'assets', 'a.mp4'), 'abs=' + abs);
});

await step('resolveAssetPath 拒绝 ../evil', async () => {
  await rejects(resolveAssetPath(root, '../evil.mp4'), 'OUTSIDE_PROJECT', '../evil.mp4');
  await rejects(resolveAssetPath(root, 'assets/../../evil.mp4'), 'OUTSIDE_PROJECT', 'assets/../../evil.mp4');
});

await step('resolveAssetPath 拒绝绝对路径', async () => {
  await rejects(resolveAssetPath(root, path.join(root, 'assets', 'a.mp4')), 'OUTSIDE_PROJECT', '绝对路径');
  await rejects(resolveAssetPath(root, 'C:\\Windows\\system.ini'), 'OUTSIDE_PROJECT', '盘符路径');
});

await step('resolveAssetPath 拒绝符号链接逃逸', async () => {
  const linkDir = path.join(root, 'assets', 'link-out');
  try {
    await fs.symlink(outside, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      console.log('       (跳过：当前账户不允许建符号链接)');
      return;
    }
    throw e;
  }
  await rejects(resolveAssetPath(root, 'assets/link-out/x.mp4'), 'OUTSIDE_PROJECT', '符号链接逃逸');
});

await step('readRange 带 root 参数时同样受守卫', async () => {
  const absOutside = path.join(outside, 'secret.mp4');
  await fs.writeFile(absOutside, Buffer.from('secret'));
  await rejects(readRange(absOutside, 0, 3, { root }), 'OUTSIDE_PROJECT', 'readRange 越权');
});

// MIME -------------------------------------------------------------------
await step('mimeFor 常见扩展名', async () => {
  const cases = {
    'a.mp4': 'video/mp4',
    'a.MP4': 'video/mp4',
    'a.webm': 'video/webm',
    'a.mov': 'video/quicktime',
    'a.m4v': 'video/mp4',
    'a.mp3': 'audio/mpeg',
    'a.wav': 'audio/wav',
    'a.aac': 'audio/aac',
    'a.png': 'image/png',
    'a.jpg': 'image/jpeg',
    'a.gif': 'image/gif',
    'a.svg': 'image/svg+xml',
    'a.webp': 'image/webp',
    'a.unknownext': 'application/octet-stream',
  };
  for (const [name, want] of Object.entries(cases)) {
    assert(mimeFor(name) === want, name + ' -> ' + mimeFor(name) + '，期望 ' + want);
  }
});

// 磁盘导入 ---------------------------------------------------------------
await step('importFile 流式复制并给出同样的 sha256', async () => {
  const src = path.join(outside, 'from-disk.mp4');
  const payload = Buffer.concat([CONTENT_A, CONTENT_B, Buffer.from('source')]);
  await fs.writeFile(src, payload);

  const imported = await importFile(root, { sourcePath: src });
  assert(imported.name === 'from-disk.mp4', 'name=' + imported.name);
  assert(imported.relPath === 'assets/from-disk.mp4', 'relPath=' + imported.relPath);
  assert(imported.size === payload.length, 'size=' + imported.size);
  assert(
    imported.hash === 'sha256:' + createHash('sha256').update(payload).digest('hex'),
    'hash=' + imported.hash,
  );
  assert(imported.mime === 'video/mp4', 'mime=' + imported.mime);
  const disk = await fs.readFile(path.join(root, 'assets', imported.name));
  assert(disk.equals(payload), '复制内容不一致');
});

await step('importFile 缺源文件抛 NOT_FOUND', async () => {
  await rejects(importFile(root, { sourcePath: path.join(outside, 'no-such.mp4') }), 'NOT_FOUND', 'importFile');
});

// 文件名清洗 -------------------------------------------------------------
await step('文件名清洗：去路径与控制字符、限长 120', async () => {
  const evil = await importBytes(root, { name: '../../evil\u0001.mp4', bytes: CONTENT_A });
  assert(evil.name === 'evil.mp4', 'name=' + evil.name);
  assert(evil.relPath === 'assets/evil.mp4', 'relPath=' + evil.relPath);
  assert((await fs.stat(path.join(root, 'assets', 'evil.mp4'))).isFile(), '清洗后的文件不存在');

  const long = await importBytes(root, { name: 'x'.repeat(200) + '.mp4', bytes: CONTENT_B });
  assert(long.name.length <= 120, 'length=' + long.name.length);
  assert(long.name.endsWith('.mp4'), '扩展名丢了: ' + long.name.slice(-10));
});

const dirs = await ensureAssetDirs(root);
await step('重复 ensureAssetDirs 安全', async () => {
  assert(dirs.assets === path.join(path.resolve(root), 'assets'), 'assets 路径=' + dirs.assets);
});

// 清理 -------------------------------------------------------------------
await fs.rm(root, { recursive: true, force: true });
await fs.rm(outside, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
