/**
 * 标注轨测试：几何 / 脏数据 / 排序 / 计数 / 高亮 / 删除与修改的事务链。
 *
 *   node scripts/annotation-track-test.mjs
 *
 * 前半段是纯函数（可注入数据，不碰浏览器、不碰磁盘）；
 * 后半段起一个临时工程，验证 RPC 的 annotations.remove / annotations.update
 * 真的走写租约 + revision，并且删除会落盘、可撤销。
 */

import { useTempBindings } from './_bindings-guard.mjs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ProjectStore } from '../src/store.mjs';
import { registerVideoRoutes } from '../src/routes.mjs';
import { videoTools } from '../src/tools.mjs';
import { T } from '../src/client/theme.js';
import {
  ANNOTATION_STATUS_LABELS,
  annotationActive,
  annotationAnchor,
  annotationCounts,
  annotationIntentColor,
  annotationStatusLabel,
  annotationSummary,
  annotationTrackLayout,
} from '../src/client/timeline.js';

const cleanupBindings = useTempBindings('annotation-track');

let pass = 0;
let fail = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log('  ok   ' + name);
    pass += 1;
  } catch (e) {
    console.log('  FAIL ' + name + ' :: ' + (e && e.message));
    fail += 1;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const ann = (id, start, end, extra = {}) => ({
  id,
  range: { start, end },
  intent: 'change',
  expected: id,
  status: 'open',
  ...extra,
});

// ------------------------------------------------------------ 纯函数：几何 ---

console.log('A. 时间 → 像素');

await step('区间：起点 / 终点映射到像素，宽度随区间', () => {
  const got = annotationTrackLayout([ann('a', 2, 5)], { zoom: 40, duration: 20 });
  const item = got.items[0];
  assert(item.kind === 'span', 'kind=' + item.kind);
  assert(item.x === 80, 'x=' + item.x);
  assert(item.width === 120, 'width=' + item.width);
  assert(got.items.length === 1, 'items=' + got.items.length);
});

await step('零区间（点标注）画成固定宽度小旗', () => {
  const got = annotationTrackLayout([ann('a', 3, 3)], { zoom: 40, duration: 20 });
  const item = got.items[0];
  assert(item.kind === 'flag', 'kind=' + item.kind);
  assert(item.width === 11, '小旗宽度应固定 11，实际 ' + item.width);
  assert(item.x === 115, '小旗应以 3s 为中心（120 - 5），实际 ' + item.x);
});

await step('超出片长（右）：夹到边界并打虚线标记', () => {
  const got = annotationTrackLayout([ann('a', 8, 15)], { zoom: 40, duration: 10 });
  const item = got.items[0];
  assert(item.t0 === 8 && item.t1 === 10, 't0/t1=' + item.t0 + '/' + item.t1);
  assert(item.x === 320 && item.width === 80, 'x/width=' + item.x + '/' + item.width);
  assert(item.clampEnd === true && item.outOfBounds.end === true, '没有标记右越界');
  assert(item.dashed === true, '越界应打虚线');
  assert(item.label.includes('超出片长'), '悬停文案没说明越界：' + item.label);
});

await step('超出片长（左）：贴到 0 且保留标记', () => {
  const got = annotationTrackLayout([ann('a', -3, 2)], { zoom: 40, duration: 10 });
  const item = got.items[0];
  assert(item.t0 === 0 && item.t1 === 2, 't0/t1=' + item.t0 + '/' + item.t1);
  assert(item.x === 0 && item.width === 80, 'x/width=' + item.x + '/' + item.width);
  assert(item.clampStart === true && item.dashed === true, '没有标记左越界');
});

await step('倒挂区间：不倒挂渲染，降级成红色小旗并可修', () => {
  const got = annotationTrackLayout([ann('a', 4, 1)], { zoom: 40, duration: 10 });
  const item = got.items[0];
  assert(item.inverted === true && item.invalid === true, '没有识别倒挂');
  assert(item.kind === 'flag', '倒挂应降级成小旗，实际 ' + item.kind);
  assert(item.width >= 0, '宽度不能为负：' + item.width);
  assert(item.color === T.danger, '倒挂应标红');
  assert(item.label.includes('倒挂'), '悬停文案应提示可修：' + item.label);
});

await step('缺 range 的脏数据进「无法定位」组，其余照常渲染', () => {
  const got = annotationTrackLayout([{ id: 'broken', intent: 'issue', expected: '没有区间' }, ann('ok', 2, 4)], {
    zoom: 40,
    duration: 10,
  });
  assert(got.items.length === 1 && got.items[0].id === 'ok', '可定位的应照常渲染');
  assert(got.unplaced.length === 1 && got.unplaced[0].id === 'broken', '脏数据没进无法定位组');
  assert(got.unplaced[0].reason === 'missing-range', 'reason=' + got.unplaced[0].reason);
  assert(/缺少 range/.test(got.unplaced[0].reasonText), 'reasonText=' + got.unplaced[0].reasonText);
});

await step('区间不是数字也进无法定位组，不抛错', () => {
  const got = annotationTrackLayout([{ id: 'bad', range: { start: 'x', end: 2 } }], { zoom: 40, duration: 10 });
  assert(got.items.length === 0 && got.unplaced.length === 1, '非数字区间应进无法定位');
});

console.log('\nB. 排序 / 泳道 / 计数 / 高亮');

await step('按时间升序；同一时间保持输入顺序（稳定）', () => {
  const got = annotationTrackLayout([ann('c', 5, 6), ann('a', 1, 2), ann('b', 1, 2)], {
    zoom: 40,
    duration: 10,
  });
  assert(got.items.map((x) => x.id).join(',') === 'a,b,c', '顺序=' + got.items.map((x) => x.id).join(','));
});

await step('同一时刻多条垂直错开，不互相覆盖', () => {
  const got = annotationTrackLayout([ann('a', 2, 4), ann('b', 2, 4), ann('c', 2, 4)], {
    zoom: 40,
    duration: 10,
  });
  const lanes = got.items.map((x) => x.lane);
  assert(new Set(lanes).size === 3, '三条同一时刻应占三条泳道：' + lanes.join(','));
  assert(got.lanes >= 3, 'lanes=' + got.lanes);
});

await step('部分重叠的区间也错开', () => {
  const got = annotationTrackLayout([ann('a', 1, 5), ann('b', 3, 6)], { zoom: 40, duration: 10 });
  assert(got.items[0].lane !== got.items[1].lane, '重叠区间压在同一条泳道');
});

await step('计数：总数 / 未处理 / 无法定位 / 倒挂', () => {
  const got = annotationCounts([
    ann('a', 1, 2),
    ann('b', 2, 3, { status: 'applied' }),
    ann('c', 3, 4, { status: 'rejected' }),
    { id: 'd', expected: '缺 range' },
    ann('e', 6, 5),
  ]);
  assert(got.total === 5, 'total=' + got.total);
  assert(got.open === 3, 'open=' + got.open);
  assert(got.handled === 2, 'handled=' + got.handled);
  assert(got.unplaced === 1, 'unplaced=' + got.unplaced);
  assert(got.invalid === 1, 'invalid=' + got.invalid);
});

await step('播放头进入区间 → 高亮；离开 → 不亮', () => {
  const list = [ann('a', 2, 5)];
  const inside = annotationTrackLayout(list, { zoom: 40, duration: 10, playhead: 2.5 });
  assert(inside.items[0].active === true, '区间内应高亮');
  assert(inside.activeIds.join(',') === 'a', 'activeIds=' + inside.activeIds.join(','));
  const outside = annotationTrackLayout(list, { zoom: 40, duration: 10, playhead: 6 });
  assert(outside.items[0].active === false, '区间外不该高亮');
  assert(annotationActive(list[0], 5) === true, '终点也应算在区间里（闭区间提示）');
});

await step('点标注：播放头落在 0.2s 窗口内才算高亮', () => {
  const flag = ann('a', 3, 3);
  assert(annotationActive(flag, 3.1) === true, '0.1s 内应高亮');
  assert(annotationActive(flag, 3.5) === false, '0.5s 外不该高亮');
  assert(annotationAnchor(flag) === 3, '跳转应落到 3s');
});

await step('摘要：intent 标签 + 文案前 40 字，换行折成空格', () => {
  const long = '一'.repeat(60);
  const summary = annotationSummary({ intent: 'issue', expected: long });
  assert(summary.startsWith('问题 · '), '缺 intent 标签：' + summary);
  const shown = Array.from(summary.slice(summary.indexOf(' · ') + 3));
  assert(shown.length === 41, '截断应为 40 字 + 省略号，实际 ' + shown.length);
  assert(shown[40] === '…', '结尾应是省略号');
  const folded = annotationSummary({ intent: 'note', expected: '第一行\n第二行' });
  assert(folded === '备注 · 第一行 第二行', '换行没折平：' + folded);
});

await step('四种 intent 的颜色全部来自 theme.js 的语义 token', () => {
  assert(annotationIntentColor('change') === T.accent, 'change ≠ T.accent');
  assert(annotationIntentColor('issue') === T.danger, 'issue ≠ T.danger');
  assert(annotationIntentColor('question') === T.warn, 'question ≠ T.warn');
  assert(annotationIntentColor('note') === T.textFaint, 'note ≠ T.textFaint');
  const colors = ['change', 'issue', 'question', 'note'].map(annotationIntentColor);
  assert(new Set(colors).size === 4, '四种颜色不应重复');
  assert(annotationStatusLabel('applied') === ANNOTATION_STATUS_LABELS.applied, '状态标签不一致');
});

await step('空列表不崩：items / unplaced / counts 全空', () => {
  const got = annotationTrackLayout([], { zoom: 40, duration: 10 });
  assert(Array.isArray(got.items) && got.items.length === 0, 'items 应为空');
  assert(Array.isArray(got.unplaced) && got.unplaced.length === 0, 'unplaced 应为空');
  assert(got.counts.total === 0 && got.counts.open === 0, '计数应为 0');
  const nulls = annotationTrackLayout(null, {});
  assert(nulls.items.length === 0, 'null 输入也应返回空布局');
});

// ------------------------------------------------------------ 事务 / RPC ---

console.log('\nC. 删除 / 修改：租约 + revision + 落盘');

const routes = [];
const ctx = { webServer: { register: (r) => (routes.push(r), () => {}) }, get: () => undefined };
const store = new ProjectStore();
registerVideoRoutes(ctx, store, () => {});

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-ann-track-'));
const SESSION = 'session-ann-track';
const doc = await store.open(root, SESSION);
const projectId = doc.projectId;

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
    setHeader(k, v) {
      this.headers[k] = v;
    },
    write(c) {
      this.body += c;
    },
    end(c) {
      if (c) this.body += c;
      this.done = true;
    },
  };
}
async function call(method, params) {
  const res = fakeRes();
  await routes.find((r) => r.path === '/api/video/rpc').handler(fakeReq({ method, params }), res);
  const payload = JSON.parse(res.body);
  if (!payload.ok) throw Object.assign(new Error(payload.error.message), { code: payload.error.code });
  return payload.value;
}
async function expectError(fn, code, contains) {
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert(err, '应当报错但没有');
  assert(err.code === code, `错误码应为 ${code}，实际 ${err.code}：${err.message}`);
  if (contains) assert(err.message.includes(contains), '错误文案应包含「' + contains + '」：' + err.message);
  return err;
}
const persisted = async () =>
  JSON.parse(await fs.readFile(path.join(root, '.dsh-video', 'project.json'), 'utf8'));

await call('annotations.add', {
  projectId,
  sessionId: SESSION,
  annotationId: 'an_1',
  range: { start: 1, end: 2 },
  intent: 'change',
  expected: '换掉这段',
});
await call('annotations.add', {
  projectId,
  sessionId: SESSION,
  annotationId: 'an_2',
  range: { start: 5, end: 5 },
  intent: 'question',
  expected: '这里是不是该切？',
});
await call('annotations.add', {
  projectId,
  sessionId: SESSION,
  annotationId: 'an_3',
  range: { start: 8, end: 9 },
  intent: 'note',
  expected: '备注',
});

await step('工具清单里有 video_annotation_remove / video_annotation_update', () => {
  const defs = videoTools({ store, samples: {} });
  const byName = new Map(defs.map((d) => [d.name, d]));
  const remove = byName.get('video_annotation_remove');
  const update = byName.get('video_annotation_update');
  assert(remove, '缺 video_annotation_remove');
  assert(update, '缺 video_annotation_update');
  assert(remove.parameters.required.includes('annotationId'), 'remove 的 annotationId 不是必填');
  assert(update.parameters.properties.status.enum.includes('rejected'), 'update 的状态枚举缺 rejected');
});

await step('annotations.update 改文案与状态（落盘）', async () => {
  const value = await call('annotations.update', {
    projectId,
    sessionId: SESSION,
    annotationId: 'an_1',
    expected: '换成 B-roll',
    status: 'applied',
  });
  assert(value.annotation && value.annotation.expected === '换成 B-roll', '文案没改：' + JSON.stringify(value.annotation));
  assert(value.annotation.status === 'applied', '状态没改：' + value.annotation.status);
  assert(value.remaining === 3, 'remaining=' + value.remaining);
  const disk = await persisted();
  const hit = disk.annotations.find((a) => a.id === 'an_1');
  assert(hit.expected === '换成 B-roll' && hit.status === 'applied', '没有落盘');
});

await step('非法状态拒绝，且不写盘', async () => {
  const before = (await persisted()).annotations.find((a) => a.id === 'an_2').status;
  await expectError(
    () =>
      call('annotations.update', {
        projectId,
        sessionId: SESSION,
        annotationId: 'an_2',
        status: 'done',
      }),
    'INVALID_ARG',
    '不支持的状态',
  );
  const after = (await persisted()).annotations.find((a) => a.id === 'an_2').status;
  assert(before === after, '非法状态不应改动 doc');
});

await step('删除走 revision：过期 baseRevision 被 REVISION_CONFLICT 拒绝', async () => {
  const beforeCount = (await persisted()).annotations.length;
  const err = await expectError(
    () =>
      store.removeAnnotation(projectId, SESSION, 'an_1', { baseRevision: 0 }),
    'REVISION_CONFLICT',
  );
  assert(/revision|版本|改写/i.test(err.message) || err.details, '冲突文案不清晰：' + err.message);
  assert((await persisted()).annotations.length === beforeCount, '冲突时不应写盘');
});

await step('annotations.remove 真删：返回被删条目 + 剩余数量 + 落盘', async () => {
  const value = await call('annotations.remove', {
    projectId,
    sessionId: SESSION,
    annotationId: 'an_1',
  });
  assert(value.removed && value.removed.id === 'an_1', '没返回被删条目');
  assert(value.removed.expected === '换成 B-roll', '被删条目不完整：' + JSON.stringify(value.removed));
  assert(value.remaining === 2, 'remaining=' + value.remaining);
  assert(typeof value.revision === 'number', '没有返回 revision');
  const disk = await persisted();
  assert(disk.annotations.length === 2, '磁盘上还有 ' + disk.annotations.length + ' 条');
  assert(!disk.annotations.some((a) => a.id === 'an_1'), '被删的还在磁盘上');
});

await step('再删同一条：可读的 REF_NOT_FOUND（幂等报错）', async () => {
  await expectError(
    () =>
      call('annotations.remove', {
        projectId,
        sessionId: SESSION,
        annotationId: 'an_1',
      }),
    'REF_NOT_FOUND',
    'an_1',
  );
  assert((await persisted()).annotations.length === 2, '重复删除不应改动 doc');
});

await step('删除可撤销：undoLast 把标注放回来', async () => {
  const value = await call('edit.undoLast', { projectId, sessionId: SESSION });
  assert(value.revision >= 1, '撤销没返回 revision');
  const disk = await persisted();
  assert(disk.annotations.some((a) => a.id === 'an_1'), '撤销后标注没回来');
});

await step('annotation.remove 单数别名同样可用', async () => {
  const value = await call('annotation.remove', {
    projectId,
    sessionId: SESSION,
    annotationId: 'an_3',
  });
  assert(value.removed.id === 'an_3', '别名没删对：' + JSON.stringify(value.removed));
  assert(value.remaining === 2, 'remaining=' + value.remaining);
});

await step('删除走租约：错 scope 的租约被 LEASE_SCOPE 拒绝', async () => {
  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-ann-lease-'));
  const OTHER = 'session-ann-lease';
  const other = await store.open(otherRoot, OTHER);
  const got = store.acquireLease(other.projectId, OTHER, 'track:v1');
  await expectError(
    () =>
      store.removeAnnotation(other.projectId, OTHER, 'whatever', {
        leaseId: got.lease.leaseId,
      }),
    'LEASE_SCOPE',
  );
  await fs.rm(otherRoot, { recursive: true, force: true });
});

await fs.rm(root, { recursive: true, force: true });
cleanupBindings();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
