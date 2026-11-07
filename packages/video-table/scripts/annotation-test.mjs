/**
 * 标注测试：镜头定位、人类可读格式、两个入口的区间形状、导出文本、非法范围。
 *
 *   node scripts/annotation-test.mjs
 *
 * 纯函数部分不依赖磁盘；RPC 部分起一个临时工程，验证 annotations.export
 * 与面板「全部提交」用的是同一段文本。
 */

import { useTempBindings } from './_bindings-guard.mjs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createProject, applyOps } from '../src/domain.mjs';
import { ProjectStore } from '../src/store.mjs';
import { registerVideoRoutes } from '../src/routes.mjs';
import {
  ANNOTATION_INTENTS,
  annotationOp,
  enrichAnnotation,
  exportAnnotations,
  formatAnnotation,
  frameRange,
  normalizeRange,
  spanRange,
} from '../src/annotations.mjs';

const cleanupBindings = useTempBindings('annotation');

let pass = 0;
let fail = 0;
async function step(name, fn) {
  try {
    await fn();
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

const ANALYSIS = {
  ok: true,
  meta: { duration: 20 },
  shots: [
    { index: 1, start: 0, end: 10, duration: 10 },
    { index: 2, start: 10, end: 20, duration: 10 },
  ],
};

await step('enrichAnnotation 有 analysis：补镜头号 / 起点 / 镜内偏移', () => {
  const got = enrichAnnotation({ start: 12.4, end: 13.9 }, ANALYSIS);
  assert(got.shot === 2, 'shot=' + got.shot);
  assert(got.shotStart === 10, 'shotStart=' + got.shotStart);
  assert(got.shotEnd === 20, 'shotEnd=' + got.shotEnd);
  assert(Math.abs(got.shotOffset - 2.4) < 1e-9, 'shotOffset=' + got.shotOffset);
  assert(got.start === 12.4 && got.end === 13.9, '秒被改了');
});

await step('没有 analysis 时只返回秒，不带任何镜头字段', () => {
  const got = enrichAnnotation({ start: 12.4, end: 13.9 }, null);
  assert(got.start === 12.4 && got.end === 13.9, '秒不对');
  assert(!('shot' in got) && !('shotStart' in got), '不该有镜头字段: ' + JSON.stringify(got));
});

await step('正好落在切点上算后一个镜头', () => {
  const got = enrichAnnotation({ start: 10, end: 10 }, ANALYSIS);
  assert(got.shot === 2, 'cut 点归属=' + got.shot);
  assert(got.shotOffset === 0, 'offset=' + got.shotOffset);
});

await step('超出镜头表范围（片尾之后 / 片头之前）只给秒', () => {
  const after = enrichAnnotation({ start: 20, end: 21 }, ANALYSIS);
  assert(!('shot' in after), '片尾之后不该有镜头号: ' + JSON.stringify(after));
  const beyond = enrichAnnotation({ start: 25, end: 26 }, ANALYSIS);
  assert(!('shot' in beyond), '超出之后不该有镜头号');
});

await step('formatAnnotation：第 7 镜式 / 区间式 / 当前帧式', () => {
  const shot = formatAnnotation({ start: 12.4, end: 13.9, shot: 7, shotStart: 12.1, shotOffset: 0.3, shotEnd: 20 });
  assert(shot === '第 7 镜 · 12.40s（镜内 +0.30s）', '镜头式=' + shot);
  const span = formatAnnotation({ start: 12.4, end: 13.9 });
  assert(span === '12.40s → 13.90s', '区间式=' + span);
  const frame = formatAnnotation({ start: 12.4, end: 12.4 });
  assert(frame === '12.40s（当前帧）', '当前帧式=' + frame);
});

await step('双入口：帧标记是零长度，A→B 是区间，反向被拒', () => {
  const frame = frameRange(12.4);
  assert(frame.start === 12.4 && frame.end === 12.4, '帧 range=' + JSON.stringify(frame));
  const span = spanRange(12.4, 13.9);
  assert(span.start === 12.4 && span.end === 13.9, '区间 range=' + JSON.stringify(span));
  let err = null;
  try {
    spanRange(13.9, 12.4);
  } catch (e) {
    err = e;
  }
  assert(err && err.code === 'INVALID_ARG', '反向区间应抛 INVALID_ARG');
  assert(/B 必须不小于 A/.test(err.message), '消息=' + err.message);
});

await step('annotationOp：默认 intent=change，未知 intent 被拒，帧标记合法', () => {
  const op = annotationOp({ annotationId: 'an_1', range: frameRange(3), expected: '这里换镜头' });
  assert(op.type === 'annotation.add' && op.intent === 'change', '默认 intent=' + op.intent);
  assert(op.range.start === 3 && op.range.end === 3, '帧 range 不对');
  let err = null;
  try {
    annotationOp({ annotationId: 'an_2', range: frameRange(3), intent: 'nope' });
  } catch (e) {
    err = e;
  }
  assert(err && err.code === 'INVALID_ARG', '未知 intent 应被拒');
  assert(ANNOTATION_INTENTS.length === 4, 'intent 选项数=' + ANNOTATION_INTENTS.length);
});

await step('exportAnnotations：位置 + 类型 + 批注，按时间排序', () => {
  const list = [
    { id: 'an_b', range: { start: 12.4, end: 13.9 }, intent: 'issue', expected: '这里太吵' },
    { id: 'an_a', range: { start: 2.5, end: 2.5 }, intent: 'note', expected: '第一处\n第二行' },
  ];
  const text = exportAnnotations(list, ANALYSIS);
  assert(/【标注清单】共 2 条/.test(text), '标题不对:\n' + text);
  assert(/第 1 镜 · 2\.50s（镜内 \+2\.50s）/.test(text), '第 1 镜位置不对:\n' + text);
  assert(/第 2 镜 · 12\.40s（镜内 \+2\.40s）/.test(text), '第 2 镜位置不对:\n' + text);
  assert(/类型 issue/.test(text), '缺少类型');
  assert(/批注：这里太吵/.test(text), '缺少批注');
  assert(/批注：第一处\n   第二行/.test(text), '多行批注没缩进:\n' + text);
  assert(text.indexOf('2.50s') < text.indexOf('12.40s'), '没有按时间排序');
});

await step('exportAnnotations：没有标注 / 没有镜头表时的措辞', () => {
  const empty = exportAnnotations([], null);
  assert(/共 0 条/.test(empty) && /还没有任何标注/.test(empty), '空清单文案不对:\n' + empty);
  assert(/未解析/.test(empty), '应说明未解析:\n' + empty);
});

await step('domain.annotation.add：start===end 合法，end<start 被拒', () => {
  const base = createProject({ sessionId: 's1', root: 'C:\\tmp\\vw-ann' });
  const frame = applyOps(base, [
    { type: 'annotation.add', annotationId: 'an_1', range: { start: 1, end: 1 }, intent: 'change', expected: 'x' },
  ]);
  assert(frame.doc.annotations.length === 1, '帧标记没落库');
  assert(frame.doc.annotations[0].range.start === 1 && frame.doc.annotations[0].range.end === 1, 'range 被改了');
  let err = null;
  try {
    applyOps(base, [{ type: 'annotation.add', annotationId: 'an_2', range: { start: 2, end: 1 } }]);
  } catch (e) {
    err = e;
  }
  assert(err && err.code === 'INVALID_ARG', '反向区间应被拒');
});

await step('normalizeRange：负数钳到 0，end 缺省等于 start', () => {
  const got = normalizeRange({ start: -3, end: -1 });
  assert(got.start === 0 && got.end === 0, '钳制不对: ' + JSON.stringify(got));
  const half = normalizeRange({ start: 4 });
  assert(half.start === 4 && half.end === 4, '缺省 end 不对: ' + JSON.stringify(half));
});

// ---------------------------------------------------------------- RPC 侧 ---

const routes = [];
const ctx = { webServer: { register: (r) => (routes.push(r), () => {}) }, get: () => undefined };
const store = new ProjectStore();
registerVideoRoutes(ctx, store, () => {});

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-ann-'));
const SESSION = 'session-ann';
const doc = await store.open(root, SESSION);
const projectId = doc.projectId;
await fs.writeFile(path.join(root, 'analysis.json'), JSON.stringify(ANALYSIS, null, 2), 'utf8');

function fakeReq(body) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/api/video/rpc';
  req.headers = {};
  setTimeout(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  }, 0);
  return req;
}
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    write(c) { this.body += c; },
    end(c) { if (c) this.body += c; this.done = true; },
  };
}
async function call(method, params) {
  const res = fakeRes();
  await routes.find((r) => r.path === '/api/video/rpc').handler(fakeReq({ method, params }), res);
  const payload = JSON.parse(res.body);
  if (!payload.ok) throw Object.assign(new Error(payload.error.message), { code: payload.error.code });
  return payload.value;
}

await step('RPC annotations.add 接受帧标记，annotations.export 文本与面板一致', async () => {
  await call('annotations.add', {
    projectId,
    sessionId: SESSION,
    annotationId: 'an_r1',
    range: frameRange(12.4),
    intent: 'question',
    expected: '这里是不是该切？',
  });
  await call('annotations.add', {
    projectId,
    sessionId: SESSION,
    annotationId: 'an_r2',
    range: spanRange(2.5, 4),
    intent: 'change',
    expected: '换掉',
  });
  const value = await call('annotations.export', { projectId, sessionId: SESSION });
  assert(value.count === 2, 'count=' + value.count);
  const analysisDoc = JSON.parse(await fs.readFile(path.join(root, 'analysis.json'), 'utf8'));
  const expected = exportAnnotations(store.get(projectId).doc.annotations, analysisDoc);
  assert(value.text === expected, 'RPC 文本与纯函数不一致');
  assert(/第 2 镜 · 12\.40s（镜内 \+2\.40s）/.test(value.text), 'RPC 文本缺镜头位置:\n' + value.text);
  const item = value.annotations.find((a) => a.id === 'an_r1');
  assert(item && item.shot === 2 && item.shotOffset === 2.4, 'annotations 没有 enriched: ' + JSON.stringify(item));
});

await step('RPC annotations.export：没有标注时 count=0 且文本可用', async () => {
  const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-ann-empty-'));
  const emptyDoc = await store.open(emptyRoot, 'session-ann-empty');
  const value = await call('annotations.export', { projectId: emptyDoc.projectId, sessionId: 'session-ann-empty' });
  assert(value.count === 0, 'count=' + value.count);
  assert(/还没有任何标注/.test(value.text), '文本=' + value.text);
  assert(Array.isArray(value.annotations) && value.annotations.length === 0, 'annotations 应为空数组');
  await fs.rm(emptyRoot, { recursive: true, force: true });
});

await fs.rm(root, { recursive: true, force: true });
cleanupBindings();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
