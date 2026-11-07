/**
 * 模板测试：工程模板的说明书、命令白名单、以及 template.apply 的事务行为。
 *
 *   node scripts/template-test.mjs
 *
 * 前半段直接跑纯函数（buildTemplate + applyOps），后半段用假 ctx 注册路由，
 * 走真实 JSON-RPC：open → template.apply → timeline / summary。
 */

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { applyOps, createProject, OP_NAMES } from '../src/domain.mjs';
import { ProjectStore } from '../src/store.mjs';
import { registerVideoRoutes } from '../src/routes.mjs';
import { buildTemplate, listTemplates } from '../src/templates.mjs';
import { TemplateBar } from '../src/client/panels.js';

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('template');

// ---------------------------------------------------------------- 断言工具 ---

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

function must(cond, message) {
  if (!cond) throw new Error(message);
}

// ------------------------------------------------------------ 纯函数部分 ----

const EXPECTED = [
  { id: 'portrait-talk', ratio: '9:16', duration: 30 },
  { id: 'product-launch', ratio: '16:9', duration: 15 },
  { id: 'data-story', ratio: '16:9', duration: 15 },
  { id: 'caption-motion', ratio: '9:16', duration: 12 },
];
const OPS_WHITELIST = ['clip.insert', 'track.add', 'project.set_ratio', 'code_layer.set_code', 'asset.add'];

const templates = listTemplates();

await step('listTemplates 返回四个模板且字段完整', () => {
  must(Array.isArray(templates) && templates.length === 4, '模板数量不是 4: ' + templates.length);
  for (const want of EXPECTED) {
    const t = templates.find((x) => x.id === want.id);
    must(t, '缺模板: ' + want.id);
    must(t.name && t.description, want.id + ' 缺 name/description');
    must(t.ratio === want.ratio, want.id + ' 画幅=' + t.ratio);
    must(t.duration === want.duration, want.id + ' 时长=' + t.duration);
    must(Array.isArray(t.tracks) && t.tracks.length > 0, want.id + ' 没有轨道说明');
    for (const tr of t.tracks) must(tr.id && tr.kind && tr.name, want.id + ' 轨道字段不全');
  }
});

await step('buildTemplate 四个模板都能出非空 ops，画幅与说明书一致', () => {
  for (const want of EXPECTED) {
    const built = buildTemplate(want.id, { width: 1080, height: 1920 });
    must(built && Array.isArray(built.ops), want.id + ' 没返回 ops');
    must(built.ops.length > 0, want.id + ' ops 为空');
    must(built.ratio === want.ratio, want.id + ' 返回画幅=' + built.ratio);
    // 第一条总是 project.set_ratio，后面全落在轨道上
    must(built.ops[0].type === 'project.set_ratio', want.id + ' 第一条不是 set_ratio');
  }
});

await step('ops 里每条命令的 type 都在白名单内，且都合法', () => {
  for (const want of EXPECTED) {
    const t = templates.find((x) => x.id === want.id);
    const trackIds = new Set(t.tracks.map((x) => x.id));
    const clipIds = new Set();
    for (const op of buildTemplate(want.id).ops) {
      must(OPS_WHITELIST.includes(op.type), want.id + ' 出现白名单外命令: ' + op.type);
      must(OP_NAMES.includes(op.type), want.id + ' 出现引擎未注册命令: ' + op.type);
      if (op.type === 'clip.insert') {
        must(trackIds.has(op.trackId), want.id + ' 落到未声明的轨道: ' + op.trackId);
        must(op.clipId && !clipIds.has(op.clipId), want.id + ' clipId 重复或为空');
        clipIds.add(op.clipId);
        must(typeof op.start === 'number' && op.start >= 0, want.id + ' start 非法');
        must(typeof op.duration === 'number' && op.duration > 0, want.id + ' duration 非法');
      }
    }
  }
});

await step('ops 在空工程上真实落地（applyOps 不报错，时长等于说明书）', () => {
  for (const want of EXPECTED) {
    const base = createProject({ sessionId: 'tpl-test', root: 'C:/tmp/tpl' });
    const { doc } = applyOps(base, buildTemplate(want.id).ops);
    must(doc.clips.length > 0, want.id + ' 没有落下片段');
    must(doc.ratio === want.ratio, want.id + ' 文档画幅=' + doc.ratio);
    must(doc.duration === want.duration, want.id + ' 文档时长=' + doc.duration);
    must(doc.revision === 1, want.id + ' revision=' + doc.revision);
  }
});

// ----------------------------------------------------------- JSON-RPC 部分 ---

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
  return {
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
    },
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers || {});
    },
  };
}

const rpcRoute = () => routes.find((r) => r.path === '/api/video/rpc');

async function rawCall(method, params) {
  const res = fakeRes();
  const req = fakeReq('POST', '/api/video/rpc', { method, params });
  await rpcRoute().handler(req, res);
  return { status: res.statusCode, payload: JSON.parse(res.body) };
}

async function call(method, params) {
  const { payload } = await rawCall(method, params);
  if (!payload.ok) throw new Error(`${method}: ${payload.error.code} ${payload.error.message}`);
  return payload.value;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-tpl-'));
const root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-tpl2-'));
const root3 = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-tpl3-'));
const SESSION = 'session-template';
let projectId = null;
let revision = null;

await step('RPC template.list 返回四个模板', async () => {
  const opened = await call('project.open', { dir: root, sessionId: SESSION });
  projectId = opened.doc.projectId;
  revision = opened.doc.revision;
  const value = await call('template.list', {});
  must(value.templates.length === 4, '模板数量=' + value.templates.length);
});

await step('RPC template.apply 在空工程上成功，片段数 > 0 且 revision 递增', async () => {
  const applied = await call('template.apply', {
    projectId,
    sessionId: SESSION,
    templateId: 'portrait-talk',
    baseRevision: revision,
  });
  must(applied && applied.transactionId, '没有返回事务 id');
  must(applied.revision === revision + 1, 'revision=' + applied.revision);
  must(applied.diff && applied.diff.added.length > 0, 'diff 里没有新增');
  revision = applied.revision;
  const timeline = await call('project.timeline', { projectId });
  must(timeline.clips.total > 0, '时间线上没有片段');
  must(timeline.doc.ratio === '9:16', '画幅没跟着模板走: ' + timeline.doc.ratio);
  must(timeline.doc.duration === 30, '时长=' + timeline.doc.duration);
});

await step('RPC project.summary 在套用后可读', async () => {
  const value = await call('project.summary', { projectId });
  must(value.doc && value.doc.revision === revision, 'summary revision 不对');
  must(value.doc.clipCount > 0, 'summary clipCount=' + value.doc.clipCount);
  must(Array.isArray(value.doc.tracks) && value.doc.tracks.length === 5, 'summary 轨道数不对');
});

await step('RPC 非空工程再套模板被拒（INVALID_OP · 只能套用到空工程）', async () => {
  const { status, payload } = await rawCall('template.apply', {
    projectId,
    sessionId: SESSION,
    templateId: 'product-launch',
    baseRevision: revision,
  });
  must(payload.ok === false, '非空工程竟然套用成功');
  must(payload.error.code === 'INVALID_OP', '错误码=' + payload.error.code);
  must(payload.error.message.includes('只能套用到空工程'), '提示语=' + payload.error.message);
  must(status === 400, 'HTTP 状态=' + status);
});

await step('RPC 不存在的模板 id → REF_NOT_FOUND', async () => {
  const opened = await call('project.open', { dir: root2, sessionId: SESSION });
  const { status, payload } = await rawCall('template.apply', {
    projectId: opened.doc.projectId,
    sessionId: SESSION,
    templateId: 'no-such-template',
  });
  must(payload.ok === false, '不存在的模板竟然成功');
  must(payload.error.code === 'REF_NOT_FOUND', '错误码=' + payload.error.code);
  must(status === 400, 'HTTP 状态=' + status);
});

await step('RPC data-story 的代码图层源码落到工程目录（图层可加载）', async () => {
  const opened = await call('project.open', { dir: root3, sessionId: SESSION });
  const projectId3 = opened.doc.projectId;
  const applied = await call('template.apply', {
    projectId: projectId3,
    sessionId: SESSION,
    templateId: 'data-story',
    baseRevision: opened.doc.revision,
  });
  must(applied.revision === opened.doc.revision + 1, 'revision 没递增');
  const file = path.join(root3, 'code', 'tpl-data-countup', 'index.js');
  const source = await fs.readFile(file, 'utf8');
  must(source.includes('export function render'), '代码图层源码里没有 render 导出');
  const timeline = await call('project.timeline', { projectId: projectId3 });
  const codeClip = timeline.clips.clips.find((c) => c.type === 'code');
  must(codeClip && codeClip.layerId === 'tpl-data-countup', '时间线上没有 count-up 占位代码图层');
  must(codeClip.props && codeClip.props.to === 100, '代码图层 props 不完整');
});

await step('空工程提示条能渲染出「当前是空工程 · 套用模板」', () => {
  const html = renderToString(React.createElement(TemplateBar, { projectId: 'vp_x', sessionId: SESSION }));
  must(html.includes('当前是空工程 · 套用模板'), '提示条文案缺失');
});

await fs.rm(root, { recursive: true, force: true });
await fs.rm(root2, { recursive: true, force: true });
await fs.rm(root3, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
