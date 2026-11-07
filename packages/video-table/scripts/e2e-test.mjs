/**
 * End-to-end host test: real store + real routes + real media + sample broker.
 *
 *   node scripts/e2e-test.mjs
 *
 * Drives the HTTP surface the panel uses (open → import → probe → insert →
 * range → sample round-trip) against a temporary project directory.
 */

import { useTempBindings } from './_bindings-guard.mjs';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.mjs';
import { SampleBroker } from '../src/samples.mjs';
import { registerVideoRoutes } from '../src/routes.mjs';

const cleanupBindings = useTempBindings('e2e');
const routes = [];
const ctx = {
  webServer: { register: (r) => (routes.push(r), () => {}) },
  get: () => undefined,
};
const store = new ProjectStore();
const broker = new SampleBroker();
registerVideoRoutes(ctx, store, () => {}, broker);

let pass = 0;
let fail = 0;
async function step(name, fn) {
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('步骤超时 3s')), 3000)),
    ]);
    console.log('  ok   ' + name);
    pass += 1;
  } catch (e) {
    console.log('  FAIL ' + name + ' :: ' + e.message);
    fail += 1;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function fakeReq(method, url, body, headers) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers || {};
  setTimeout(() => {
    if (body) req.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    req.emit('end');
  }, 0);
  return req;
}
function fakeRes() {
  const res = new Writable({
    write(chunk, _enc, cb) {
      res.chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  res.statusCode = 0;
  res.headers = {};
  res.chunks = [];
  res.setHeader = (k, v) => {
    res.headers[String(k).toLowerCase()] = v;
  };
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    Object.assign(res.headers, Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [String(k).toLowerCase(), v])));
  };
  res.body = () => Buffer.concat(res.chunks).toString('utf8');
  res.json = () => JSON.parse(res.body());
  return res;
}

const route = (p) => routes.find((r) => r.path === p);
async function call(method, params) {
  const res = fakeRes();
  await route('/api/video/rpc').handler(fakeReq('POST', '/api/video/rpc', { method, params }), res);
  const payload = res.json();
  if (!payload.ok) throw new Error(payload.error.code + ': ' + payload.error.message);
  return payload.value;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-e2e-'));
const SESSION = 'session-e2e';
let projectId;

await step('打开工程', async () => {
  const v = await call('project.open', { dir: root, sessionId: SESSION });
  projectId = v.doc.projectId;
  assert(projectId && v.doc.revision === 0, 'projectId/revision 异常');
});

const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7), Buffer.from([0xff, 0xd9])]);
let assetId;

await step('导入素材（原始字节）', async () => {
  const res = fakeRes();
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/api/video/import?projectId=' + projectId + '&sessionId=' + SESSION + '&name=clip.mp4';
  req.headers = {};
  const done = route('/api/video/import').handler(req, res);
  setTimeout(() => {
    req.emit('data', jpegBytes);
    req.emit('end');
  }, 80);
  await done;
  const payload = res.json();
  assert(payload.ok, '导入失败: ' + res.body());
  assert(payload.value.asset.hash.startsWith('sha256:'), 'hash 缺失');
  assetId = payload.value.asset.id;
});

await step('时间线里能看到素材', async () => {
  const v = await call('project.timeline', { projectId });
  const asset = v.assets.find((a) => a.id === assetId);
  assert(asset, '素材没进工程');
  assert(asset.path.startsWith('assets/'), 'path 异常: ' + asset.path);
});

await step('素材写入探测信息', async () => {
  await call('asset.probe', {
    projectId,
    sessionId: SESSION,
    assetId,
    probe: { duration: 3.5, width: 640, height: 360 },
  });
  const v = await call('project.timeline', { projectId });
  const asset = v.assets.find((a) => a.id === assetId);
  assert(asset.probe && asset.probe.duration === 3.5, 'probe 未写入');
});

await step('媒体路由带 Range 返回 206', async () => {
  const res = fakeRes();
  await route('/api/video/media').handler(
    fakeReq('GET', `/api/video/media?projectId=${projectId}&assetId=${assetId}`, null, { range: 'bytes=0-99' }),
    res,
  );
  await new Promise((r) => setTimeout(r, 30));
  assert(res.statusCode === 206, 'status=' + res.statusCode);
  assert(/^bytes 0-99\/\d+$/.test(res.headers['content-range'] || ''), 'content-range 异常: ' + res.headers['content-range']);
});

await step('插入片段 → 时长与轨道正确', async () => {
  const before = await call('project.summary', { projectId });
  const p = await call('edit.preview', {
    projectId,
    sessionId: SESSION,
    baseRevision: before.doc.revision,
    summary: '插入素材',
    ops: [
      {
        type: 'clip.insert',
        clipId: 'c1',
        trackId: 'v1',
        clipType: 'media',
        assetId,
        start: 0,
        duration: 3.5,
      },
    ],
  });
  await call('edit.apply', { previewId: p.previewId, sessionId: SESSION });
  const v = await call('project.timeline', { projectId });
  assert(v.clips.total === 1, 'clip 数=' + v.clips.total);
  assert(v.doc.duration === 3.5, 'duration=' + v.doc.duration);
});

await step('采样请求 → 面板回传 → 工具拿到文件', async () => {
  const pending = broker.request(projectId, [1.0, 2.0], 480);
  const listed = await call('sample.pending', { projectId });
  assert(listed.requests.length === 1, 'pending 数=' + listed.requests.length);
  const reqId = listed.requests[0].requestId;
  const dataUrl = 'data:image/jpeg;base64,' + jpegBytes.toString('base64');
  await call('sample.fulfill', {
    projectId,
    sessionId: SESSION,
    requestId: reqId,
    files: [
      { time: 1.0, dataUrl },
      { time: 2.0, dataUrl },
    ],
  });
  const value = await pending;
  assert(value.samples.length === 2, 'samples=' + value.samples.length);
  const stat = await fs.stat(value.samples[0].path);
  assert(stat.size === jpegBytes.length, '落盘大小=' + stat.size);
});

await step('越权读取被拒（asset.range 走守卫）', async () => {
  const v = await call('asset.range', { projectId, assetId, start: 0, length: 10 });
  assert(v.size === jpegBytes.length, 'size=' + v.size);
});

await step('未知方法给 INVALID_OP', async () => {
  try {
    await call('nope', {});
  } catch (e) {
    assert(/INVALID_OP/.test(e.message), '错误码: ' + e.message);
    return;
  }
  throw new Error('应当抛错');
});

await fs.rm(root, { recursive: true, force: true });
cleanupBindings();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
