// 回归：工作台「工程归属」判定。
//
// 背景 bug（用户实际撞到的死锁）：
//   面板把「其他会话的工程」算成 all.filter(x => !list.some(p => p.projectId === x.projectId))。
//   list 是按 boundSessionId 过滤的本会话工程；而 enabled 每条带的是 sessionId（谁启用的）。
//   于是「本会话启用、但没绑定到当前工程」的那条会掉进「其他会话」区——
//   只读、没有按钮，额度 2/2 被自己占满，进不去也停不掉。
import assert from 'node:assert/strict';
import { classifyEnabled, mergeSessionProjects } from '../src/client/panels.js';

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    failures.push(name + ': ' + (e && e.message));
    console.log('  FAIL ' + name + ' — ' + (e && e.message));
  }
}

const ME = 'session-aaaa1111';
const OTHER = 'session-bbbb2222';

check('本会话启用、但不在 list 里 → 归入 mineOnly（不是 others）', () => {
  const list = [{ projectId: 'p1', title: '当前工程' }];
  const enabled = [
    { projectId: 'p1', sessionId: ME, title: '当前工程' },
    { projectId: 'p2', sessionId: ME, title: '我另一个工程' },
  ];
  const { mineOnly, others } = classifyEnabled({ sessionId: ME, list, enabled });
  assert.deepEqual(mineOnly.map((x) => x.projectId), ['p2'], '自己启用的 p2 必须算我的');
  assert.deepEqual(others, [], '不该把 p2 贴成其他会话');
});

check('其他会话启用的 → 归入 others', () => {
  const list = [{ projectId: 'p1' }];
  const enabled = [
    { projectId: 'p1', sessionId: ME },
    { projectId: 'p9', sessionId: OTHER, title: '别人的' },
  ];
  const { mineOnly, others } = classifyEnabled({ sessionId: ME, list, enabled });
  assert.deepEqual(mineOnly, []);
  assert.deepEqual(others.map((x) => x.projectId), ['p9']);
});

check('已在 list 里的不重复出现在 mineOnly', () => {
  const list = [{ projectId: 'p1' }];
  const enabled = [{ projectId: 'p1', sessionId: ME }];
  const { mineOnly, others } = classifyEnabled({ sessionId: ME, list, enabled });
  assert.equal(mineOnly.length, 0);
  assert.equal(others.length, 0);
});

check('sessionId 缺失（旧记录）→ 不判成别人的，归 mineOnly', () => {
  const { mineOnly, others } = classifyEnabled({
    sessionId: ME,
    list: [],
    enabled: [{ projectId: 'legacy' }],
  });
  assert.deepEqual(mineOnly.map((x) => x.projectId), ['legacy']);
  assert.deepEqual(others, []);
});

check('没有 sessionId 上下文 → 全部算自己的（不误导为只读）', () => {
  const { mineOnly, others } = classifyEnabled({
    sessionId: '',
    list: [],
    enabled: [{ projectId: 'a', sessionId: OTHER }, { projectId: 'b', sessionId: ME }],
  });
  assert.equal(mineOnly.length, 2);
  assert.equal(others.length, 0);
});

check('脏数据不炸：缺 projectId / null 条目被丢掉', () => {
  const { mineOnly, others } = classifyEnabled({
    sessionId: ME,
    list: [null, { title: '没有 id' }],
    enabled: [null, { title: '没有 id' }, { projectId: 'ok', sessionId: ME }],
  });
  assert.deepEqual(mineOnly.map((x) => x.projectId), ['ok']);
  assert.deepEqual(others, []);
});

check('enabled 不是数组时不炸', () => {
  const r = classifyEnabled({ sessionId: ME, list: [], enabled: null });
  assert.deepEqual(r.mineOnly, []);
  assert.deepEqual(r.others, []);
});

check('mergeSessionProjects 仍然按 boundSessionId 过滤（未改动）', () => {
  const doc = { projectId: 'p1', boundSessionId: ME };
  const projects = [
    { projectId: 'p2', boundSessionId: ME },
    { projectId: 'p3', boundSessionId: OTHER },
    { projectId: 'p4' },
  ];
  const out = mergeSessionProjects(doc, projects, ME).map((p) => p.projectId);
  assert.deepEqual(out, ['p1', 'p2', 'p4'], '别人的 p3 不该进本会话列表');
});

console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
