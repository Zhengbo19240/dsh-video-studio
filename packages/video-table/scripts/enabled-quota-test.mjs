// 额度语义回归：只有「面板启用」计数，agent 调用不占额度。
//
// 背景（用户实际撞到的死锁）：
//   agent 会话跑 video_setup 会把工程写进 ~/.dsh/video-enabled.json，
//   而 agent 会话没有面板入口 —— 占了 2/2 就再也放不掉，人在面板里进不去也停不了。
// 修法：每条记录带 origin；只有 origin==='panel' 计入 MAX_ENABLED。
//   历史记录没有 origin → 按 'agent' 解释（此前能让额度满的只有 agent 侧路径）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpFile = path.join(os.tmpdir(), 'dsh-enabled-quota-' + process.pid + '.json');
process.env.DSH_VIDEO_ENABLED = tmpFile;

const reg = await import('../src/enabled-registry.mjs');

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    failures.push(name + ': ' + (e && e.message));
    console.log('  FAIL ' + name + ' — ' + (e && e.message));
  }
}

function reset(doc) {
  fs.writeFileSync(tmpFile, JSON.stringify(doc || { enabled: [] }), 'utf8');
}

try {
  await check('entryCounts 只认 panel', async () => {
    assert.equal(reg.entryCounts({ origin: 'panel' }), true);
    assert.equal(reg.entryCounts({ origin: 'agent' }), false);
    assert.equal(reg.entryCounts({}), false, '没有 origin 的历史记录不算额度');
    assert.equal(reg.entryCounts(null), false);
  });

  await check('agent 启用不占额度：连续 5 个都能进', async () => {
    reset();
    for (let i = 1; i <= 5; i += 1) {
      await reg.enable({ projectId: 'agent-' + i, root: 'D:/x' + i, sessionId: 's1', title: 'a' + i });
    }
    const list = await reg.listEnabled();
    assert.equal(list.length, 5);
    assert.ok(list.every((x) => x.origin === 'agent'), 'agent 启用应标记 origin:agent');
    assert.equal(list.filter(reg.entryCounts).length, 0, '一条都不该占额度');
  });

  await check('面板启用占额度：第 3 个被拒 ENABLED_LIMIT', async () => {
    reset({ enabled: [
      { projectId: 'agent-1', origin: 'agent', sessionId: 's1', title: 'a1' },
      { projectId: 'agent-2', origin: 'agent', sessionId: 's1', title: 'a2' },
      { projectId: 'agent-3', origin: 'agent', sessionId: 's1', title: 'a3' },
    ] });
    await reg.enable({ projectId: 'p1', sessionId: 's1', title: '面板1', origin: 'panel' });
    await reg.enable({ projectId: 'p2', sessionId: 's1', title: '面板2', origin: 'panel' });
    let err = null;
    try {
      await reg.enable({ projectId: 'p3', sessionId: 's1', title: '面板3', origin: 'panel' });
    } catch (e) {
      err = e;
    }
    assert.ok(err, '第 3 个面板启用必须被拒');
    assert.equal(err.code, 'ENABLED_LIMIT');
    assert.ok(/已有 2 个工程/.test(err.message), '错误文案要说清被谁占着：' + err.message);
  });

  await check('agent 启用永远不会被额度挡住（即使面板已满）', async () => {
    reset({ enabled: [
      { projectId: 'p1', origin: 'panel', sessionId: 's1', title: '面板1' },
      { projectId: 'p2', origin: 'panel', sessionId: 's1', title: '面板2' },
    ] });
    const r = await reg.enable({ projectId: 'agent-9', sessionId: 's2', title: 'agent 工程' });
    assert.equal(r.already, false);
    const list = await reg.listEnabled();
    assert.ok(list.some((x) => x.projectId === 'agent-9'), 'agent 工程应当能进');
  });

  await check('历史记录没有 origin → 不占额度（老账失效）', async () => {
    reset({ enabled: [
      { projectId: 'legacy-1', sessionId: 's1', title: '老账1' },
      { projectId: 'legacy-2', sessionId: 's1', title: '老账2' },
    ] });
    // 这两条都没 origin，按 agent 解释；面板应当还能再启两个
    await reg.enable({ projectId: 'p1', sessionId: 's1', title: '面板1', origin: 'panel' });
    await reg.enable({ projectId: 'p2', sessionId: 's1', title: '面板2', origin: 'panel' });
    const list = await reg.listEnabled();
    assert.equal(list.filter(reg.entryCounts).length, 2);
  });

  await check('停用按 projectId 生效（不校验会话，面板可从任意会话腾位置）', async () => {
    reset({ enabled: [
      { projectId: 'x1', origin: 'agent', sessionId: 'other-session', title: '别人的' },
    ] });
    const r = await reg.disable('x1');
    assert.equal(r.removed, true);
    assert.equal((await reg.listEnabled()).length, 0);
  });

  await check('重复启用幂等，不新增条目', async () => {
    reset();
    await reg.enable({ projectId: 'dup', sessionId: 's1', title: 'x', origin: 'panel' });
    const r2 = await reg.enable({ projectId: 'dup', sessionId: 's1', title: 'x', origin: 'panel' });
    assert.equal(r2.already, true);
    assert.equal((await reg.listEnabled()).length, 1);
  });
} finally {
  try {
    fs.unlinkSync(tmpFile);
  } catch {
    /* 清不掉也不影响 */
  }
  delete process.env.DSH_VIDEO_ENABLED;
}

console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
