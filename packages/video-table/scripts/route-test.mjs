/**
 * Route test: exercises the HTTP surface without the DSH host.
 *
 *   node scripts/route-test.mjs
 *
 * Registers the routes against a fake ctx (no connection service → the admit
 * gate is skipped), then drives the RPC handler with a fake request/response:
 * open → preview → apply → timeline → undo.
 */

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.mjs';
import { registerVideoRoutes } from '../src/routes.mjs';

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('route');

const routes = [];
const ctx = {
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
  get() {
    return undefined;
  },
};

const store = new ProjectStore();
registerVideoRoutes(ctx, store, () => {});

function fakeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  setTimeout(() => {
    if (body) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  }, 0);
  return req;
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v;
    },
    write(chunk) {
      this.body += chunk;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
      this.done = true;
    },
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers || {});
    },
  };
  return res;
}

const rpcRoute = () => routes.find((r) => r.path === '/api/video/rpc');
const eventsRoute = () => routes.find((r) => r.path === '/api/video/events');

async function call(method, params) {
  const res = fakeRes();
  const req = fakeReq('POST', '/api/video/rpc', { method, params });
  await rpcRoute().handler(req, res);
  const payload = JSON.parse(res.body);
  if (!payload.ok) throw new Error(`${method}: ${payload.error.code} ${payload.error.message}`);
  return payload.value;
}

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

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-route-'));
const SESSION = 'session-route';
let projectId = null;
let revision = null;

await step('ping', async () => {
  const v = await call('ping', {});
  if (v.pong !== true) throw new Error('pong missing');
});

await step('project.open 建工程并返回摘要', async () => {
  const v = await call('project.open', { dir: root, sessionId: SESSION });
  projectId = v.doc.projectId;
  revision = v.doc.revision;
  if (!projectId) throw new Error('no projectId');
  if (v.doc.boundSessionId !== SESSION) throw new Error('binding wrong');
});

await step('project.timeline 读空时间线', async () => {
  const v = await call('project.timeline', { projectId });
  if (v.clips.total !== 0) throw new Error('expected empty');
  if (v.doc.tracks.length !== 5) throw new Error('tracks=' + v.doc.tracks.length);
});

await step('edit.preview 不改文档', async () => {
  const v = await call('edit.preview', {
    projectId,
    sessionId: SESSION,
    baseRevision: revision,
    summary: '加文字',
    ops: [{ type: 'clip.insert', clipId: 'c1', trackId: 't1', clipType: 'text', start: 0, duration: 2, text: 'hi' }],
  });
  if (!v.previewId) throw new Error('no previewId');
  const after = await call('project.summary', { projectId });
  if (after.doc.revision !== revision) throw new Error('preview 改了文档');
  if (after.doc.clipCount !== 0) throw new Error('preview 落了片段');
});

await step('edit.apply 前进一个 revision', async () => {
  const p = await call('edit.preview', {
    projectId,
    sessionId: SESSION,
    baseRevision: revision,
    ops: [{ type: 'clip.insert', clipId: 'c1', trackId: 't1', clipType: 'text', start: 0, duration: 2, text: 'hi' }],
  });
  const a = await call('edit.apply', { previewId: p.previewId, sessionId: SESSION });
  if (a.revision !== revision + 1) throw new Error('revision=' + a.revision);
  revision = a.revision;
  globalThis.tx = a.transactionId;
  const t = await call('project.timeline', { projectId });
  if (t.clips.total !== 1) throw new Error('clip not applied');
});

await step('过期 baseRevision 被拒（HTTP 400 语义）', async () => {
  const res = fakeRes();
  const req = fakeReq('POST', '/api/video/rpc', {
    method: 'edit.preview',
    params: { projectId, sessionId: SESSION, baseRevision: revision - 1, ops: [{ type: 'project.set_ratio', ratio: '9:16' }] },
  });
  await rpcRoute().handler(req, res);
  const payload = JSON.parse(res.body);
  if (payload.ok !== false || payload.error.code !== 'REVISION_CONFLICT') {
    throw new Error('unexpected: ' + res.body.slice(0, 120));
  }
  if (res.statusCode !== 400) throw new Error('status=' + res.statusCode);
});

await step('edit.undo 回到上一版', async () => {
  const u = await call('edit.undo', { projectId, sessionId: SESSION, transactionId: globalThis.tx });
  if (u.revision !== revision - 1) throw new Error('revision=' + u.revision);
});

await step('JSON-RPC 拒绝非 POST', async () => {
  const res = fakeRes();
  const req = fakeReq('GET', '/api/video/rpc');
  await rpcRoute().handler(req, res);
  if (res.statusCode !== 405) throw new Error('status=' + res.statusCode);
});

await step('SSE 路由存在且是 prefix', async () => {
  const r = eventsRoute();
  if (!r) throw new Error('events route missing');
  if (r.kind !== 'prefix') throw new Error('kind=' + r.kind);
});

await fs.rm(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
