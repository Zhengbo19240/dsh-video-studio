/**
 * 自动领取租约测试（真实 ProjectStore + 真实工具 + 真实 RPC，不 mock）。
 *
 *   node scripts/auto-lease-test.mjs
 *
 * 它要证明的是「并行安全不再靠自觉」：
 *   1. 写类工具没传 leaseId → 自动按 target 领租约，返回体带 leaseId 与 lease
 *   2. 同一会话连续调用复用同一 leaseId（不重复 acquire）
 *   3. 不同 target（v1 / t1 / code / audio）领到不同 scope，可以同时持有
 *   4. 两个会话抢同一 scope → LEASE_CONFLICT，绝不降级放行
 *   5. teammate 用自己的会话 + projectId 自动领租约后能写（不再 BOUND_TO_OTHER_SESSION）
 *   6. DSH_VIDEO_AUTO_LEASE=0 → 回到旧行为（sessionId 放行），返回体带 warning
 *   7. AUTO=0 + REQUIRE=1 → LEASE_REQUIRED；AUTO=1 + REQUIRE=1 → 自动领取算有
 *   8. 越界（自动领 track:v1 却写 t1）→ LEASE_SCOPE
 *   9. 只读工具一律不领租约（store 里租约数量不变）
 *  10. 过期后续写自动重领；关掉自动领取则明确报 LEASE_EXPIRED
 *  11. 升范围只回收「自己的自动租约」，显式租约（lease.acquire / 父会话发的）一个都不碰
 *  12. RPC 写入（edit.preview / edit.apply / lease.ensure / storyboard.save）同样自动领取
 */

import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.mjs';
import { registerVideoRoutes } from '../src/routes.mjs';
import { videoTools } from '../src/tools.mjs';
import { motionTools } from '../src/motion-tools.mjs';
import { soundTools } from '../src/sound-tools.mjs';
import { storyboardTools } from '../src/storyboard-tools.mjs';
import { asrTools } from '../src/asr-tools.mjs';
import { analyzeTools } from '../src/analyze-tools.mjs';

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('auto-lease');

const SESSION = 'session-auto-lease'; // 工程绑定会话
const TEAMMATE = 'session-auto-team'; // 另一个会话语义（teammate）
const AUTO_ENV = 'DSH_VIDEO_AUTO_LEASE';
const REQUIRE_ENV = 'DSH_VIDEO_REQUIRE_LEASE';
const savedAuto = process.env[AUTO_ENV];
const savedRequire = process.env[REQUIRE_ENV];

function setAuto(on) {
  if (on) delete process.env[AUTO_ENV];
  else process.env[AUTO_ENV] = '0';
}
function setRequire(on) {
  if (on) process.env[REQUIRE_ENV] = '1';
  else delete process.env[REQUIRE_ENV];
}
setAuto(true); // 默认开
setRequire(false);

const SRT = '1\n00:00:00,000 --> 00:00:02,000\n第一句\n\n2\n00:00:02,000 --> 00:00:04,000\n第二句\n';

let pass = 0;
let fail = 0;
const failures = [];

async function step(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    const reason = (e && e.message) || String(e);
    failures.push({ name, reason });
    console.log('  FAIL ' + name + ' :: ' + reason);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

async function mustThrow(fn, code, needle) {
  try {
    await fn();
  } catch (e) {
    assert(e && e.code === code, `期望 ${code}，实际 ${e && e.code}（${e && e.message}）`);
    if (needle) assert(String(e.message).includes(needle), `错误文案里没有「${needle}」：${e.message}`);
    return e;
  }
  throw new Error(`期望抛 ${code}，实际成功`);
}

// ---------------------------------------------------------------- RPC 壳 ----

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

async function rpc(method, params) {
  const route = routes.find((r) => r.path === '/api/video/rpc');
  if (!route) throw new Error('RPC 路由没注册');
  const res = fakeRes();
  await route.handler(fakeReq('POST', '/api/video/rpc', { method, params }), res);
  const payload = JSON.parse(res.body);
  if (!payload.ok) {
    const err = new Error(payload.error.message);
    err.code = payload.error.code;
    err.details = payload.error.details;
    throw err;
  }
  return payload.value;
}

// ------------------------------------------------------------------ 准备 ----

const store = new ProjectStore();
registerVideoRoutes(ctx, store, () => {});

const tools = new Map(
  [
    ...videoTools({ store, samples: null }),
    ...motionTools({ store }),
    ...soundTools({ store }),
    ...storyboardTools({ store }),
    ...asrTools({ store }),
    ...analyzeTools({ store }),
  ].map((tool) => [tool.name, tool]),
);

async function callAs(sessionId, name, args) {
  const tool = tools.get(name);
  if (!tool) throw new Error('没有这个工具: ' + name);
  return tool.execute(args, { agent: { id: sessionId } });
}

const mkdirs = {};
for (const key of ['main', 'par', 'off', 'probe', 'explicit', 'story', 'asr', 'ensure']) {
  mkdirs[key] = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-auto-' + key + '-'));
}
const ids = {};

function leasesOf(projectId) {
  return store.listLeases(projectId);
}

function scopesOf(projectId) {
  return leasesOf(projectId)
    .map((l) => l.scope)
    .sort();
}

/** 把某条租约的到期时间拨到过去（注入过期，不动其它状态）。 */
function expireLease(projectId, leaseId) {
  const records = store.leases.get(String(projectId)) || [];
  const rec = records.find((l) => l && l.leaseId === leaseId);
  if (!rec) throw new Error('找不到租约记录：' + leaseId);
  rec.expiresAt = Date.now() - 1;
  return rec;
}

let firstLeaseView = null;
let conflictMessage = '';
let parallelRevisionLog = '';

console.log('自动领取租约：写操作没传 leaseId 时，谁来领、领到什么范围、冲突怎么办\n');

await step('① 准备：打开工程，初始没有任何租约', async () => {
  const doc = await store.open(mkdirs.main, SESSION);
  ids.main = doc.projectId;
  assert(leasesOf(ids.main).length === 0, '新工程不该有租约');
});

await step('② 没传 leaseId → 自动领取 track:v1，返回体带 leaseId 与 lease', async () => {
  const v = await callAs(SESSION, 'video_edit_preview', {
    projectId: ids.main,
    ops: [{ type: 'clip.insert', clipId: 'auto_v1_a', trackId: 'v1', clipType: 'text', start: 0, duration: 1, text: 'A' }],
    summary: '自动领取第一笔',
  });
  assert(v.leaseId && String(v.leaseId).startsWith('lease_'), '返回体没有 leaseId：' + JSON.stringify(v).slice(0, 200));
  assert(v.leaseScope === 'track:v1', 'leaseScope 应为 track:v1，实际 ' + v.leaseScope);
  assert(v.leaseAcquired === true, '第一笔应该 acquired=true');
  assert(v.lease && typeof v.lease.human === 'string' && v.lease.human.includes('track:v1'), 'lease.human 不可读');
  assert(leasesOf(ids.main).length === 1, '应自动领到 1 条租约，实际 ' + leasesOf(ids.main).length);
  firstLeaseView = { leaseId: v.leaseId, leaseScope: v.leaseScope, leaseAcquired: v.leaseAcquired, lease: v.lease };
  console.log('  · 第一笔自动租约：' + JSON.stringify(firstLeaseView.lease));
});

await step('③ 同一 target 第二笔 → 复用同一 leaseId，不重复 acquire', async () => {
  const before = leasesOf(ids.main).length;
  const v = await callAs(SESSION, 'video_edit_preview', {
    projectId: ids.main,
    ops: [{ type: 'clip.insert', clipId: 'auto_v1_b', trackId: 'v1', clipType: 'text', start: 2, duration: 1, text: 'B' }],
    summary: '复用第一笔的租约',
  });
  assert(v.leaseId === firstLeaseView.leaseId, `应复用 ${firstLeaseView.leaseId}，实际 ${v.leaseId}`);
  assert(v.leaseAcquired === false, '第二笔不该再 acquire');
  assert(leasesOf(ids.main).length === before, '复用却新增了租约');
});

await step('④ video_edit_apply 不传 leaseId → 按预览记下的范围复用同一租约并落盘', async () => {
  const rev = store.get(ids.main).doc.revision;
  const p = await callAs(SESSION, 'video_edit_preview', {
    projectId: ids.main,
    ops: [{ type: 'clip.insert', clipId: 'auto_v1_c', trackId: 'v1', clipType: 'text', start: 4, duration: 1, text: 'C' }],
  });
  const applied = await callAs(SESSION, 'video_edit_apply', { previewId: p.previewId });
  assert(applied.revision === rev + 1, `revision 应 ${rev + 1}，实际 ${applied.revision}`);
  assert(applied.leaseId === p.leaseId, 'apply 应复用预览时的租约');
});

await step('⑤ 不同 target（v1 / t1）自动领到不同 scope，两条租约并存', async () => {
  const t1 = await callAs(SESSION, 'video_caption_import', { projectId: ids.main, content: SRT });
  assert(t1.imported === 2, 'imported=' + t1.imported);
  assert(t1.leaseScope === 'track:t1', 'leaseScope 应为 track:t1，实际 ' + t1.leaseScope);
  assert(t1.leaseAcquired === true, 't1 租约应是新领的');
  const scopes = scopesOf(ids.main);
  assert(scopes.includes('track:v1') && scopes.includes('track:t1'), '两条 scope 应并存：' + scopes.join(','));
  assert(t1.leaseId !== firstLeaseView.leaseId, 'v1 / t1 不该是同一份租约');
});

await step('⑥ 并行：t1 与 code 两笔同时自动领取，各自写入成功（revision +2）', async () => {
  const doc = await store.open(mkdirs.par, SESSION);
  ids.par = doc.projectId;
  const base = store.get(ids.par).doc.revision;
  const [caption, code] = await Promise.all([
    callAs(SESSION, 'video_caption_import', { projectId: ids.par, content: SRT }),
    callAs(SESSION, 'video_code_write', {
      projectId: ids.par,
      layerId: 'auto-par-layer',
      source: 'export function render() {}',
    }),
  ]);
  assert(caption.imported === 2 && code.revision >= 1, '两笔都应成功');
  const after = store.get(ids.par).doc.revision;
  assert(after === base + 2, `revision 应 +2（${base} → ${base + 2}），实际 ${after}`);
  const scopes = scopesOf(ids.par);
  assert(scopes.includes('track:t1') && scopes.includes('code'), 'scope 应为 t1 + code：' + scopes.join(','));
  parallelRevisionLog = `t1 ${caption.leaseId} @ r${caption.revision} / code ${code.leaseId} @ r${code.revision}（总 revision ${after}）`;
  console.log('  · 并行结果：' + parallelRevisionLog);
});

await step('⑦ 同一 scope 的两个会话语义 → 第二个 LEASE_CONFLICT，不降级放行', async () => {
  const revBefore = store.get(ids.main).doc.revision;
  const e = await mustThrow(
    () =>
      callAs(TEAMMATE, 'video_edit_preview', {
        projectId: ids.main,
        ops: [{ type: 'clip.insert', clipId: 'team_v1', trackId: 'v1', clipType: 'text', start: 6, duration: 1, text: '抢' }],
      }),
    'LEASE_CONFLICT',
    '写租约冲突',
  );
  conflictMessage = e.message;
  assert(!leasesOf(ids.main).some((l) => l.sessionId === TEAMMATE), 'teammate 不该拿到租约');
  assert(store.get(ids.main).doc.revision === revBefore, '冲突时不该有提交');
  console.log('  · 冲突文案：' + conflictMessage);
});

await step('⑧ teammate 用自己的会话 + projectId，换不冲突的 scope 自动领到租约后可写', async () => {
  const v = await callAs(TEAMMATE, 'video_edit_preview', {
    projectId: ids.main,
    ops: [{ type: 'clip.insert', clipId: 'team_v2', trackId: 'v2', clipType: 'text', start: 0, duration: 1, text: '队友' }],
  });
  assert(v.leaseScope === 'track:v2', 'leaseScope 应为 track:v2，实际 ' + v.leaseScope);
  assert(v.leaseAcquired === true, 'teammate 应自动领到新租约');
  const mine = leasesOf(ids.main).find((l) => l.leaseId === v.leaseId);
  assert(mine && mine.sessionId === TEAMMATE, '租约应属于 teammate 的会话');
  const applied = await callAs(TEAMMATE, 'video_edit_apply', { previewId: v.previewId });
  assert(applied.revision >= 1, 'teammate 写入应成功');
});

await step('⑨ DSH_VIDEO_AUTO_LEASE=0 → 回到旧行为（sessionId 放行），返回体带 warning', async () => {
  const doc = await store.open(mkdirs.off, SESSION);
  ids.off = doc.projectId;
  setAuto(false);
  try {
    const v = await callAs(SESSION, 'video_edit_preview', {
      projectId: ids.off,
      ops: [{ type: 'clip.insert', clipId: 'legacy_v1', trackId: 'v1', clipType: 'text', start: 0, duration: 1, text: '旧' }],
    });
    assert(v.leaseId === null, '关掉自动领取后不该有 leaseId，实际 ' + v.leaseId);
    assert(String(v.warning || '').includes('并行安全已关闭'), '缺少 warning：' + JSON.stringify(v.warning));
    assert(leasesOf(ids.off).length === 0, '关掉自动领取后不该有新租约');
    const applied = await callAs(SESSION, 'video_edit_apply', { previewId: v.previewId });
    assert(applied.revision === 1, '旧路径应能写入，revision=' + applied.revision);
  } finally {
    setAuto(true);
  }
});

await step('⑩ AUTO=0 + REQUIRE=1 → 无租约被拒 LEASE_REQUIRED', async () => {
  setAuto(false);
  setRequire(true);
  try {
    await mustThrow(
      () =>
        callAs(SESSION, 'video_edit_preview', {
          projectId: ids.off,
          ops: [{ type: 'clip.insert', clipId: 'legacy_v1_b', trackId: 'v1', clipType: 'text', start: 2, duration: 1, text: '拒' }],
        }),
      'LEASE_REQUIRED',
      '自动领取',
    );
  } finally {
    setRequire(false);
    setAuto(true);
  }
});

await step('⑪ AUTO=1 + REQUIRE=1 → 自动领取算「有租约」，写操作放行', async () => {
  setRequire(true);
  try {
    const v = await callAs(SESSION, 'video_edit_preview', {
      projectId: ids.off,
      ops: [{ type: 'clip.insert', clipId: 'strict_v1', trackId: 'v1', clipType: 'text', start: 4, duration: 1, text: '严' }],
    });
    assert(v.leaseId, '严格模式 + 自动领取应拿到租约');
    assert(v.leaseScope === 'track:v1', 'leaseScope=' + v.leaseScope);
  } finally {
    setRequire(false);
  }
});

await step('⑫ 越界：自动领到 track:v1，却拿它写 t1 → LEASE_SCOPE', async () => {
  const list = leasesOf(ids.off);
  const v1Lease = list.find((l) => l.scope === 'track:v1');
  assert(v1Lease, '应已持有 track:v1 租约');
  const e = await mustThrow(
    () =>
      callAs(SESSION, 'video_edit_preview', {
        projectId: ids.off,
        leaseId: v1Lease.leaseId,
        ops: [{ type: 'clip.insert', clipId: 'cross_t1', trackId: 't1', clipType: 'text', start: 6, duration: 1, text: '越界' }],
      }),
    'LEASE_SCOPE',
    '租约范围是 track:v1',
  );
  assert(e.details && e.details.target === 'track:t1', 'details.target 应为 track:t1');
});

await step('⑬ 过期后续写：带旧 leaseId 自动重领（新 leaseId、leaseRenewed）', async () => {
  const v1Lease = leasesOf(ids.off).find((l) => l.scope === 'track:v1');
  assert(v1Lease, '应已持有 track:v1 租约');
  expireLease(ids.off, v1Lease.leaseId);
  const v = await callAs(SESSION, 'video_edit_preview', {
    projectId: ids.off,
    leaseId: v1Lease.leaseId,
    ops: [{ type: 'clip.insert', clipId: 'renew_v1', trackId: 'v1', clipType: 'text', start: 8, duration: 1, text: '重领' }],
  });
  assert(v.leaseRenewed === true, '应标记 leaseRenewed');
  assert(v.leaseId && v.leaseId !== v1Lease.leaseId, '重领应拿到新 leaseId');
  assert(v.leaseScope === 'track:v1', '重领的 scope 应保持 track:v1');
});

await step('⑭ 过期 + AUTO=0 → 不重领，明确报 LEASE_EXPIRED', async () => {
  const v1Lease = leasesOf(ids.off).find((l) => l.scope === 'track:v1');
  expireLease(ids.off, v1Lease.leaseId);
  setAuto(false);
  try {
    await mustThrow(
      () =>
        callAs(SESSION, 'video_edit_preview', {
          projectId: ids.off,
          leaseId: v1Lease.leaseId,
          ops: [{ type: 'clip.insert', clipId: 'expired_v1', trackId: 'v1', clipType: 'text', start: 10, duration: 1, text: '过期' }],
        }),
      'LEASE_EXPIRED',
      '租约已过期',
    );
  } finally {
    setAuto(true);
  }
});

await step('⑮ 升范围只回收自己的自动租约：audio → code → all', async () => {
  const doc = await store.open(mkdirs.probe, SESSION);
  ids.probe = doc.projectId;

  // audio：声音库没有这条 → 过闸门后才是 NOT_FOUND
  await mustThrow(
    () => callAs(SESSION, 'video_sound_insert', { projectId: ids.probe, entryId: 'no-such-sound' }),
    'NOT_FOUND',
  );
  assert(leasesOf(ids.probe).some((l) => l.scope === 'audio'), '应自动领到 audio 租约');

  // code：动效不存在 → 过闸门后才是 MOTION_NOT_NATIVE
  await mustThrow(
    () => callAs(SESSION, 'video_motion_insert', { projectId: ids.probe, entryId: 'no-such-motion' }),
    'MOTION_NOT_NATIVE',
  );
  assert(leasesOf(ids.probe).some((l) => l.scope === 'code'), '应自动领到 code 租约');

  // all：analysis.json 是整工程 → 升范围时必须回收自己那两条自动租约
  const oldIds = leasesOf(ids.probe).map((l) => l.leaseId);
  await mustThrow(
    () => callAs(SESSION, 'video_analyze', { projectId: ids.probe, assetPath: 'C:\\no-such-video.mp4' }),
    'REF_NOT_FOUND',
  );
  const remaining = leasesOf(ids.probe);
  assert(remaining.length === 1 && remaining[0].scope === 'all', '升级后应只剩一条 all 租约：' + scopesOf(ids.probe).join(','));
  assert(remaining[0].auto === true, '租约应标记为自动租约');
  assert(oldIds.every((id) => id !== remaining[0].leaseId), '旧自动租约应被回收');
});

await step('⑯ 显式租约不会被自动回收：挡住整工程写入 → LEASE_CONFLICT，且原租约还在', async () => {
  const doc = await store.open(mkdirs.explicit, SESSION);
  ids.explicit = doc.projectId;
  const explicit = store.acquireLease(ids.explicit, SESSION, 'track:t1', { label: '父会话发下来的' }).lease;

  const v = await callAs(SESSION, 'video_edit_preview', {
    projectId: ids.explicit,
    ops: [{ type: 'clip.insert', clipId: 'exp_v1', trackId: 'v1', clipType: 'text', start: 0, duration: 1, text: 'x' }],
  });
  assert(v.leaseScope === 'track:v1', 'v1 自动租约应拿到');

  const before = leasesOf(ids.explicit).map((l) => l.leaseId).sort();
  await mustThrow(
    () =>
      callAs(SESSION, 'video_annotation_add', {
        projectId: ids.explicit,
        annotationId: 'exp_ann',
        range: { start: 0, end: 1 },
        expected: '这里改一下',
      }),
    'LEASE_CONFLICT',
  );
  const after = leasesOf(ids.explicit);
  assert(after.some((l) => l.leaseId === explicit.leaseId), '显式租约被自动回收了');
  assert(!after.some((l) => l.scope === 'all'), '失败时不该留下 all 租约');
  assert(
    after.map((l) => l.leaseId).sort().join(',') === before.join(','),
    '冲突失败不该改动任何租约（半截状态）',
  );
});

await step('⑰ storyboard.save / apply 自动领整工程租约，第二笔复用', async () => {
  const doc = await store.open(mkdirs.story, SESSION);
  ids.story = doc.projectId;
  const saved = await callAs(SESSION, 'video_storyboard_save', { projectId: ids.story, srt: SRT });
  assert(saved.saved === true && saved.count >= 1, '分镜没保存');
  assert(saved.leaseScope === 'all' && saved.leaseAcquired === true, 'storyboard.save 应自动领 all');
  const applied = await callAs(SESSION, 'video_storyboard_apply', { projectId: ids.story });
  assert(applied.applied === true, '分镜没落地');
  assert(applied.leaseId === saved.leaseId, 'apply 应复用 save 的租约');
  assert(applied.leaseAcquired === false, 'apply 不该重复领取');
});

await step('⑱ video_transcribe(applyToTimeline) 闸门在转写之前：自动领 track:t1', async () => {
  const doc = await store.open(mkdirs.asr, SESSION);
  ids.asr = doc.projectId;
  try {
    await callAs(SESSION, 'video_transcribe', {
      projectId: ids.asr,
      assetPath: 'C:\\no-such-audio.mp4',
      applyToTimeline: true,
    });
  } catch {
    /* 依赖 / 素材错误都可以，只要不是租约错误 */
  }
  const t1 = leasesOf(ids.asr).find((l) => l.scope === 'track:t1');
  assert(t1, '应已自动领到 track:t1 租约：' + scopesOf(ids.asr).join(','));
  assert(t1.sessionId === SESSION, '租约应属于调用会话');
});

await step('⑲ 只读工具一律不领租约（store 里租约数量不变）', async () => {
  const before = leasesOf(ids.probe).length;
  const reads = [
    ['video_project_inspect', { projectId: ids.probe }],
    ['video_timeline_inspect', { projectId: ids.probe }],
    ['video_annotation_list', { projectId: ids.probe }],
    ['video_motion_list', {}],
    ['video_sound_search', { query: '', source: 'local' }],
    ['video_analysis_read', { projectId: ids.probe }],
  ];
  for (const [name, args] of reads) {
    await callAs(SESSION, name, args);
    const props = tools.get(name).parameters.properties || {};
    assert(!('leaseId' in props), name + ' 是只读工具，不该有 leaseId 参数');
  }
  assert(leasesOf(ids.probe).length === before, '只读工具竟然领了租约');
});

await step('⑳ RPC 写入同样自动领取：edit.preview 领、edit.apply 复用', async () => {
  const doc = await store.open(mkdirs.ensure, SESSION);
  ids.ensure = doc.projectId;
  const rev = store.get(ids.ensure).doc.revision;
  const p = await rpc('edit.preview', {
    projectId: ids.ensure,
    sessionId: SESSION,
    baseRevision: rev,
    ops: [{ type: 'clip.insert', clipId: 'rpc_auto_v1', trackId: 'v1', clipType: 'text', start: 0, duration: 1, text: 'RPC' }],
  });
  assert(p.leaseId && p.leaseAcquired === true, 'RPC edit.preview 应自动领取租约');
  const applied = await rpc('edit.apply', { previewId: p.previewId, sessionId: SESSION });
  assert(applied.revision === rev + 1, 'RPC 应用后 revision 不对');
  assert(applied.leaseId === p.leaseId, 'RPC edit.apply 应复用同一租约');
});

await step('㉑ RPC lease.ensure：幂等，且能按 scope 领不同的租约', async () => {
  const first = await rpc('lease.ensure', { projectId: ids.ensure, sessionId: SESSION, scope: 'code' });
  assert(first.acquired === true && first.lease.scope === 'code', 'lease.ensure 应领到 code');
  const again = await rpc('lease.ensure', { projectId: ids.ensure, sessionId: SESSION, scope: 'code' });
  assert(again.acquired === false && again.lease.leaseId === first.lease.leaseId, 'lease.ensure 应幂等');
  const other = await rpc('lease.ensure', { projectId: ids.ensure, sessionId: SESSION, scope: 'audio' });
  assert(other.acquired === true && other.lease.scope === 'audio', 'lease.ensure 应能再领 audio');
});

// ---------------------------------------------------------------- 收尾 ----

for (const dir of Object.values(mkdirs)) {
  await fs.rm(dir, { recursive: true, force: true });
}
if (savedAuto === undefined) delete process.env[AUTO_ENV];
else process.env[AUTO_ENV] = savedAuto;
if (savedRequire === undefined) delete process.env[REQUIRE_ENV];
else process.env[REQUIRE_ENV] = savedRequire;
cleanupBindings();

console.log('\n真实输出：');
console.log('  自动领取样例：' + JSON.stringify(firstLeaseView, null, 2).split('\n').join('\n  '));
console.log('  冲突文案：' + conflictMessage);
console.log('  并行两笔：' + parallelRevisionLog);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('失败明细：');
  for (const f of failures) console.log('  - ' + f.name + ' :: ' + f.reason);
}
process.exit(fail === 0 ? 0 : 1);
