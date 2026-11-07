/**
 * 工具层租约测试（真实 ProjectStore + 真实工具定义）。
 *
 *   node scripts/lease-tools-test.mjs
 *
 * 验的是「每个写类工具的 target 判定对不对」：
 *   - 工具 → target 表：edit/code/caption/annotation/sound/motion/storyboard/analyze/transcribe
 *   - 有对应租约 → 通过；错 scope → LEASE_SCOPE；
 *   - 旧行为（DSH_VIDEO_AUTO_LEASE=0）：没租约 + 严格模式 → LEASE_REQUIRED
 *   - 只读工具在严格模式下不受影响，且参数里没有 leaseId
 *   - video_transcribe 只有 applyToTimeline:true 才需要租约
 *
 * ★ 2026-11-06 起默认会自动领取租约（见 scripts/auto-lease-test.mjs）。
 * 所以本文件里「没租约就该被拒」的断言一律显式把 DSH_VIDEO_AUTO_LEASE 设成 0 ——
 * 它们测的是旧行为（回退开关），不是默认行为。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.mjs';
import { videoTools } from '../src/tools.mjs';
import { motionTools } from '../src/motion-tools.mjs';
import { soundTools } from '../src/sound-tools.mjs';
import { storyboardTools } from '../src/storyboard-tools.mjs';
import { asrTools } from '../src/asr-tools.mjs';
import { analyzeTools } from '../src/analyze-tools.mjs';

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('lease-tools');

const SESSION = 'session-tools-lease';
const ENV = 'DSH_VIDEO_REQUIRE_LEASE';
const AUTO_ENV = 'DSH_VIDEO_AUTO_LEASE';

// 本文件断言的是「旧行为」：显式关掉自动领取，才不会把该被拒的调用放行
const savedAuto = process.env[AUTO_ENV];
setAuto(false);

let pass = 0;
let fail = 0;
async function step(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + (e && e.message));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

async function mustThrow(fn, code, needle) {
  try {
    await fn();
  } catch (e) {
    assert(e.code === code, `期望 ${code}，实际 ${e.code}（${e.message}）`);
    if (needle) assert(String(e.message).includes(needle), `错误文案里没有「${needle}」：${e.message}`);
    return e;
  }
  throw new Error(`期望抛 ${code}，实际成功`);
}

const dirMain = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-lt-main-'));
const dirStrict = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-lt-strict-'));

const store = new ProjectStore();
const exec = { agent: { id: SESSION } };

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

async function call(name, args) {
  const tool = tools.get(name);
  if (!tool) throw new Error('没有这个工具: ' + name);
  return tool.execute(args, exec);
}

function setStrict(on) {
  if (on) process.env[ENV] = '1';
  else delete process.env[ENV];
}

function setAuto(on) {
  if (on) delete process.env[AUTO_ENV];
  else process.env[AUTO_ENV] = '0';
}

let projectId = null;
let projectStrict = null;
let lv1 = null;
let lv2 = null;
let lt1 = null;
let lcode = null;
let laudio = null;
let lall2 = null;

const ERROR_CODES_NOT_LEASE = new Set(['NOT_FOUND', 'REF_NOT_FOUND', 'MOTION_NOT_NATIVE', 'INVALID_ARG', 'INVALID_OP']);

await step('准备：两个工程 + 五个互不冲突的租约', async () => {
  projectId = (await store.open(dirMain, SESSION)).projectId;
  projectStrict = (await store.open(dirStrict, SESSION)).projectId;
  lv1 = store.acquireLease(projectId, SESSION, 'track:v1', { label: '主轨' }).lease;
  lv2 = store.acquireLease(projectId, SESSION, 'track:v2', { label: '画中画' }).lease;
  lt1 = store.acquireLease(projectId, SESSION, 'track:t1', { label: '字幕' }).lease;
  lcode = store.acquireLease(projectId, SESSION, 'code', { label: '代码' }).lease;
  laudio = store.acquireLease(projectId, SESSION, 'audio', { label: '音频' }).lease;
  lall2 = store.acquireLease(projectStrict, SESSION, 'all', { label: '整工程' }).lease;
  assert(lv1 && lv2 && lt1 && lcode && laudio && lall2, '租约没拿全');
});

await step('target 表：video_edit_preview（clip.insert v1）用 track:v1 租约 → 通过', async () => {
  const v = await call('video_edit_preview', {
    projectId,
    leaseId: lv1.leaseId,
    ops: [{ type: 'clip.insert', clipId: 'p_v1', trackId: 'v1', clipType: 'text', start: 0, duration: 1, text: 'A' }],
    summary: '预览主轨',
  });
  assert(v.previewId, '没拿到 previewId');
  // 同一 preview 把租约一起带进 apply
  const applied = await call('video_edit_apply', { previewId: v.previewId, leaseId: lv1.leaseId });
  assert(applied.revision >= 1, 'apply 没推进 revision');
});

await step('target 表：同一 ops 用 code 租约 → LEASE_SCOPE（target 是 track:v1）', async () => {
  await mustThrow(
    () =>
      call('video_edit_preview', {
        projectId,
        leaseId: lcode.leaseId,
        ops: [{ type: 'clip.insert', clipId: 'p_v1_b', trackId: 'v1', clipType: 'text', start: 2, duration: 1, text: 'B' }],
      }),
    'LEASE_SCOPE',
    '租约范围是 code',
  );
});

await step('target 表：video_edit_preview 用别的工程的租约 → LEASE_PROJECT_MISMATCH', async () => {
  await mustThrow(
    () =>
      call('video_edit_preview', {
        projectId: projectId,
        leaseId: lall2.leaseId,
        ops: [{ type: 'clip.insert', clipId: 'p_v1_c', trackId: 'v1', clipType: 'text', start: 3, duration: 1, text: 'C' }],
      }),
    'LEASE_PROJECT_MISMATCH',
    '租约不属于该工程',
  );
});

await step('target 表：video_code_write 用 code 租约 → 通过（片段落在 c1）', async () => {
  const v = await call('video_code_write', {
    projectId,
    leaseId: lcode.leaseId,
    layerId: 'lease-layer',
    source: 'export function render() {}',
  });
  assert(v.revision >= 1, 'code.write 没推进 revision');
  assert(store.get(projectId).doc.clips.some((c) => c.type === 'code'), '代码片段没落地');
});

await step('target 表：video_code_write 用 track:v1 租约 → LEASE_SCOPE', async () => {
  await mustThrow(
    () =>
      call('video_code_write', {
        projectId,
        leaseId: lv1.leaseId,
        layerId: 'lease-layer-bad',
        source: 'export function render() {}',
      }),
    'LEASE_SCOPE',
  );
});

await step('target 表：video_caption_import 用 track:t1 租约 → 通过', async () => {
  const srt = '1\n00:00:00,000 --> 00:00:02,000\n你好\n\n2\n00:00:02,000 --> 00:00:04,000\n世界\n';
  const v = await call('video_caption_import', { projectId, leaseId: lt1.leaseId, content: srt });
  assert(v.imported === 2, 'imported=' + v.imported);
});

await step('target 表：video_caption_import 用 track:v2 租约 → LEASE_SCOPE', async () => {
  await mustThrow(
    () =>
      call('video_caption_import', {
        projectId,
        leaseId: lv2.leaseId,
        content: '1\n00:00:05,000 --> 00:00:06,000\n越界\n',
      }),
    'LEASE_SCOPE',
  );
});

await step('target 表：video_annotation_add 需要整工程租约（all）→ 通过', async () => {
  const v = await call('video_annotation_add', {
    projectId: projectStrict,
    leaseId: lall2.leaseId,
    annotationId: 'ann_lease_1',
    range: { start: 0, end: 1 },
    expected: '这里改一下',
  });
  assert(v.annotationId === 'ann_lease_1', '标注没写入');
});

await step('target 表：video_annotation_add 用 track:v1 租约 → LEASE_SCOPE', async () => {
  await mustThrow(
    () =>
      call('video_annotation_add', {
        projectId,
        leaseId: lv1.leaseId,
        annotationId: 'ann_lease_bad',
        range: { start: 0, end: 1 },
      }),
    'LEASE_SCOPE',
  );
});

await step('target 表：video_motion_insert 需要 code 租约（无租约 + 严格模式 → LEASE_REQUIRED）', async () => {
  setStrict(true);
  try {
    await mustThrow(
      () => call('video_motion_insert', { projectId, entryId: 'no-such-entry' }),
      'LEASE_REQUIRED',
      '先调用 lease.acquire',
    );
  } finally {
    setStrict(false);
  }
});

await step('target 表：video_motion_insert 带 code 租约 → 过闸门（随后才是 MOTION_NOT_NATIVE）', async () => {
  try {
    await call('video_motion_insert', { projectId, leaseId: lcode.leaseId, entryId: 'no-such-entry' });
    throw new Error('不存在的条目应报错');
  } catch (e) {
    assert(ERROR_CODES_NOT_LEASE.has(e.code), '期望过闸门后的错误，实际 ' + e.code + '：' + e.message);
  }
});

await step('target 表：video_sound_insert 无租约 + 严格模式 → LEASE_REQUIRED（audio）', async () => {
  setStrict(true);
  try {
    await mustThrow(
      () => call('video_sound_insert', { projectId, entryId: 'no-such-sound' }),
      'LEASE_REQUIRED',
      '先调用 lease.acquire',
    );
  } finally {
    setStrict(false);
  }
});

await step('target 表：video_sound_insert 带 audio 租约 → 过闸门（随后才是 NOT_FOUND）', async () => {
  await mustThrow(
    () => call('video_sound_insert', { projectId, leaseId: laudio.leaseId, entryId: 'no-such-sound' }),
    'NOT_FOUND',
    '声音库里没有',
  );
});

await step('target 表：video_storyboard_save 需要整工程租约（严格模式无租约 → LEASE_REQUIRED）', async () => {
  setStrict(true);
  try {
    await mustThrow(
      () => call('video_storyboard_save', { projectId, srt: '1\n00:00:00,000 --> 00:00:02,000\n分镜\n' }),
      'LEASE_REQUIRED',
    );
  } finally {
    setStrict(false);
  }
});

await step('target 表：video_storyboard_save 带 all 租约 → 真正写入 storyboard.json', async () => {
  const v = await call('video_storyboard_save', {
    projectId: projectStrict,
    leaseId: lall2.leaseId,
    srt: '1\n00:00:00,000 --> 00:00:02,000\n分镜\n',
  });
  assert(v.saved === true && v.count >= 1, '分镜没保存');
  const stat = await fs.stat(path.join(dirStrict, 'storyboard.json'));
  assert(stat.isFile(), 'storyboard.json 不在磁盘上');
});

await step('target 表：video_storyboard_apply 无租约 + 严格模式 → LEASE_REQUIRED', async () => {
  setStrict(true);
  try {
    await mustThrow(
      () => call('video_storyboard_apply', { projectId: projectStrict }),
      'LEASE_REQUIRED',
    );
  } finally {
    setStrict(false);
  }
});

await step('target 表：video_analyze 无租约 + 严格模式 → LEASE_REQUIRED（project）', async () => {
  setStrict(true);
  try {
    await mustThrow(
      () => call('video_analyze', { projectId, assetPath: 'C:\\no-such-video.mp4' }),
      'LEASE_REQUIRED',
      '先调用 lease.acquire',
    );
  } finally {
    setStrict(false);
  }
});

await step('target 表：video_analyze 带 all 租约 → 过闸门（随后才是素材不存在）', async () => {
  try {
    await call('video_analyze', { projectId: projectStrict, leaseId: lall2.leaseId, assetPath: 'C:\\no-such-video.mp4' });
    throw new Error('不存在的素材应报错');
  } catch (e) {
    assert(ERROR_CODES_NOT_LEASE.has(e.code), '期望过闸门后的错误，实际 ' + e.code + '：' + e.message);
  }
});

await step('video_transcribe：applyToTimeline:false + 严格模式 → 不要求租约', async () => {
  setStrict(true);
  try {
    let called = false;
    try {
      await call('video_transcribe', { projectId, assetPath: 'C:\\no-such-audio.mp4' });
      called = true;
    } catch (e) {
      assert(e.code !== 'LEASE_REQUIRED', 'applyToTimeline:false 不该要求租约：' + e.message);
      called = true;
    }
    assert(called, '工具没执行');
  } finally {
    setStrict(false);
  }
});

await step('video_transcribe：applyToTimeline:true + 严格模式 + 无租约 → LEASE_REQUIRED', async () => {
  setStrict(true);
  try {
    await mustThrow(
      () => call('video_transcribe', { projectId, assetPath: 'C:\\no-such-audio.mp4', applyToTimeline: true }),
      'LEASE_REQUIRED',
    );
  } finally {
    setStrict(false);
  }
});

await step('video_transcribe：applyToTimeline:true + track:t1 租约 → 过闸门（随后才是依赖/素材错误）', async () => {
  let reached = false;
  try {
    const v = await call('video_transcribe', {
      projectId,
      assetPath: 'C:\\no-such-audio.mp4',
      applyToTimeline: true,
      leaseId: lt1.leaseId,
    });
    // 依赖没装时返回 ready:false 也是一种「过闸门」的结果
    assert(v && typeof v.ready === 'boolean', '意外返回：' + JSON.stringify(v).slice(0, 160));
    reached = true;
  } catch (e) {
    assert(
      e.code !== 'LEASE_REQUIRED' && e.code !== 'LEASE_SCOPE' && e.code !== 'LEASE_NOT_FOUND',
      '没过闸门：' + e.code + ' ' + e.message,
    );
    reached = true;
  }
  assert(reached, '工具没执行');
});

await step('只读工具在严格模式下不受影响，且参数里没有 leaseId', async () => {
  setStrict(true);
  try {
    const reads = [
      ['video_project_inspect', { projectId }],
      ['video_timeline_inspect', { projectId }],
      ['video_annotation_list', { projectId }],
      ['video_motion_list', {}],
      ['video_sound_search', { query: '', source: 'local' }],
      ['video_storyboard_read', { projectId: projectStrict, sessionId: SESSION }],
      ['video_analysis_read', { projectId }],
    ];
    for (const [name, args] of reads) {
      await call(name, args); // 只要求不抛（analysis_read 会回 ok:false）
      const props = tools.get(name).parameters.properties || {};
      assert(!('leaseId' in props), name + ' 是只读工具，不该有 leaseId 参数');
    }
  } finally {
    setStrict(false);
  }
});

await step('老调用（无 leaseId、有 sessionId）在非严格模式下仍可用', async () => {
  const srt = '1\n00:00:06,000 --> 00:00:08,000\n旧调用\n';
  const v = await call('video_caption_import', { projectId, content: srt });
  assert(v.imported === 1, '老调用失败');
});

await step('严格模式 + 老调用（无 leaseId）→ LEASE_REQUIRED', async () => {
  setStrict(true);
  try {
    await mustThrow(
      () => call('video_caption_import', { projectId, content: '1\n00:00:09,000 --> 00:00:10,000\n拒绝\n' }),
      'LEASE_REQUIRED',
      '写操作需要写租约',
    );
  } finally {
    setStrict(false);
  }
});

await fs.rm(dirMain, { recursive: true, force: true });
await fs.rm(dirStrict, { recursive: true, force: true });
if (savedAuto === undefined) delete process.env[AUTO_ENV];
else process.env[AUTO_ENV] = savedAuto;
cleanupBindings();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
