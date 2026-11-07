/**
 * dsh-video-brief 0.3.0「视频脚本」环节自测。纯 Node，不需要 DSH 运行时：
 *   node test/script-stage-test.mjs
 *
 * 覆盖：
 * - 阶段机 idle → clarify → script → style → locked → build 的进入条件；
 * - script.json 的结构化校验（时长、重叠、断档、缺画面、空镜）；
 * - draft 的「校验失败不写盘 / 同内容幂等 / 改动重置 confirmed」；
 * - confirm 的门槛与阶段推进；
 * - video_stage_get 的 scriptReady / scriptConfirmed / scriptDraftCount / scriptMissing；
 * - 历史工程（有 style.json、没有 script.json）不降级；
 * - 三个脚本工具走门禁。
 */

import assert from 'node:assert/strict';
import path from 'node:path';

import { normalizeConfig } from '../src/config.mjs';
import { registerGate, decideGate } from '../src/gate.mjs';
import { buildScriptDraft, normalizeScript, scriptSummary, validateScript } from '../src/script.mjs';
import { STAGES, createStageService } from '../src/stage.mjs';
import {
  briefPath,
  createBriefStore,
  createScriptStore,
  createStateStore,
  createStyleStore,
  scriptPath,
  statePath,
  stylePath,
} from '../src/store.mjs';
import { createVideoBriefTools } from '../src/tools.mjs';

const ROOT = process.platform === 'win32' ? 'C:\\proj' : '/proj';
const NOW_TS = 1767225600000;

/* ------------------------------------------------------------------ */
/* 极简测试骨架 + 内存文件系统                                           */
/* ------------------------------------------------------------------ */

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

function createMemoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  const fs = {
    async readFile(file) {
      if (!files.has(file)) {
        const error = new Error(`ENOENT: ${file}`);
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(file);
    },
    async writeFile(file, data) {
      files.set(file, String(data));
    },
    async mkdir(dir) {
      dirs.add(dir);
    },
    async rename(from, to) {
      if (!files.has(from)) throw new Error(`ENOENT rename: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async copyFile(from, to) {
      if (!files.has(from)) throw new Error(`ENOENT copy: ${from}`);
      files.set(to, files.get(from));
    },
    async stat(file) {
      if (files.has(file) || dirs.has(file)) return { isFile: () => files.has(file) };
      throw new Error(`ENOENT stat: ${file}`);
    },
  };
  return { fs, files, dirs };
}

const ALL_ANSWERS = {
  goal: '让新用户看完知道怎么用',
  audience: '刚装上 DSH 的程序员',
  platform: '视频号 9:16',
  duration: '30 秒',
  tone: '克制、专业',
  pace: '快，12 个镜头，卡点',
  visual: '屏幕录制 + 少量动效',
  reference: '无参考',
  deliverable: 'MP4 1080x1920 30fps',
  taboo: '不出现真实 API KEY',
};

const STYLE_SPEC = {
  tone: '克制、专业，不喊口号',
  palette: ['#0B0B0F', '#7C5CFF'],
  font: '思源黑体 Medium',
  density: 'med',
  pace: 2.5,
};

const SCRIPT_DOC = {
  title: '30 秒讲清 DSH 视频流程',
  logline: '从问询到开工，一条片子怎么走完六阶段',
  shots: [
    { no: 1, time: { start: 0, duration: 3 }, visual: '黑底白字标题', narration: '做一条视频，先别急着开剪。', onScreenText: '先问清', transition: '硬切' },
    { no: 2, time: { start: 3, duration: 4 }, visual: '工作台录屏', narration: '十个槽位问完，再写脚本。', onScreenText: '10 项简报', transition: '叠化 0.3s' },
  ],
};

function newProject(initial = {}) {
  const mem = createMemoryFs(initial);
  const now = () => NOW_TS;
  const stores = {
    brief: createBriefStore({ projectRoot: ROOT, fs: mem.fs, now }),
    state: createStateStore({ projectRoot: ROOT, fs: mem.fs, now }),
    script: createScriptStore({ projectRoot: ROOT, fs: mem.fs, now }),
    style: createStyleStore({ projectRoot: ROOT, fs: mem.fs, now }),
  };
  const config = { ...normalizeConfig(undefined), memoryEnabled: false };
  const stage = createStageService({
    storeFor: () => stores.brief,
    stateStoreFor: () => stores.state,
    scriptStoreFor: () => stores.script,
    styleStoreFor: () => stores.style,
    config: () => config,
    now,
    log: () => {},
  });
  const tools = createVideoBriefTools({
    config: () => config,
    storeFor: () => stores.brief,
    stateStoreFor: () => stores.state,
    scriptStoreFor: () => stores.script,
    styleStoreFor: () => stores.style,
    stage,
    workspaceRoot: () => ROOT,
    memoryPath: () => path.join(ROOT, 'no-global.json'),
    now,
    log: () => {},
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const call = (name, args = {}) => {
    const tool = byName[name];
    if (!tool) throw new Error(`没有工具 ${name}`);
    return tool.execute(args, { agent: { id: 'a1' } });
  };
  const seed = (file, value) => {
    mem.dirs.add(path.dirname(file));
    mem.files.set(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  return { mem, stores, config, stage, tools, byName, call, seed };
}

function seedBrief(project, slots = ALL_ANSWERS) {
  project.seed(briefPath(ROOT), {
    version: 1,
    topic: '',
    round: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    slots,
  });
}

function seedScript(project, confirmed = true, extra = {}) {
  project.seed(scriptPath(ROOT), {
    version: 1,
    ...SCRIPT_DOC,
    confirmed,
    confirmedAt: confirmed ? '2026-01-01T00:00:00.000Z' : null,
    draftCount: 1,
    revisedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  });
}

function seedStyle(project) {
  project.seed(stylePath(ROOT), {
    spec: STYLE_SPEC,
    confirmed: true,
    confirmedAt: '2026-01-01T00:00:00.000Z',
    confirmedBy: 'user',
  });
}

function seedState(project, stage) {
  project.seed(statePath(ROOT), {
    stage,
    since: '2026-01-01T00:00:00.000Z',
    history: [{ stage, at: '2026-01-01T00:00:00.000Z', by: 'tool' }],
  });
}

function readState(project) {
  return JSON.parse(project.mem.files.get(statePath(ROOT)));
}

function readScriptFile(project) {
  const raw = project.mem.files.get(scriptPath(ROOT));
  return raw === undefined ? null : JSON.parse(raw);
}

/* ------------------------------------------------------------------ */
/* 1. 纯校验                                                           */
/* ------------------------------------------------------------------ */

test('validateScript：合法脚本 → ok，总时长按镜头累计', () => {
  const result = validateScript(SCRIPT_DOC);
  assert.equal(result.ok, true);
  assert.equal(result.problems.length, 0);
  assert.equal(result.shots.length, 2);
  assert.equal(result.totalDuration, 7);
  assert.equal(scriptSummary(normalizeScript({ ...SCRIPT_DOC, confirmed: true })).shotCount, 2);
});

test('validateScript：时长为 0 / 负数 → 逐镜报 time.duration', () => {
  const zero = validateScript({
    shots: [
      { no: 1, time: { start: 0, duration: 0 }, visual: '画面', narration: '旁白' },
      { no: 2, time: { start: 0, duration: -2 }, visual: '画面', narration: '旁白' },
    ],
  });
  assert.equal(zero.ok, false);
  const durationProblems = zero.problems.filter((item) => item.field === 'time.duration');
  assert.equal(durationProblems.length, 2);
  assert.deepEqual(durationProblems.map((item) => item.shot), [1, 2]);
  assert.ok(durationProblems.every((item) => item.message.includes('大于 0')));
});

test('validateScript：时间重叠 → time.start 报重叠', () => {
  const result = validateScript({
    shots: [
      { no: 1, time: { start: 0, duration: 5 }, visual: 'A', onScreenText: 'A' },
      { no: 2, time: { start: 3, duration: 2 }, visual: 'B', onScreenText: 'B' },
    ],
  });
  assert.equal(result.ok, false);
  const problem = result.problems.find((item) => item.field === 'time.start');
  assert.ok(problem);
  assert.equal(problem.shot, 2);
  assert.ok(problem.message.includes('重叠'));
});

test('validateScript：时间断档 → time.start 报断档', () => {
  const result = validateScript({
    shots: [
      { no: 1, time: { start: 0, duration: 5 }, visual: 'A', onScreenText: 'A' },
      { no: 2, time: { start: 6, duration: 2 }, visual: 'B', onScreenText: 'B' },
    ],
  });
  assert.equal(result.ok, false);
  const problem = result.problems.find((item) => item.field === 'time.start');
  assert.ok(problem.message.includes('断档'));
});

test('validateScript：缺 visual 被逐镜报出', () => {
  const result = validateScript({
    shots: [{ no: 1, time: { start: 0, duration: 3 }, visual: '   ', narration: '旁白' }],
  });
  assert.equal(result.ok, false);
  const problem = result.problems.find((item) => item.field === 'visual');
  assert.ok(problem);
  assert.equal(problem.shot, 1);
  assert.ok(problem.message.includes('缺画面'));
});

test('validateScript：narration 与 onScreenText 都缺 = 空镜', () => {
  const result = validateScript({
    shots: [{ no: 1, time: { start: 0, duration: 3 }, visual: '只有画面' }],
  });
  assert.equal(result.ok, false);
  const problem = result.problems.find((item) => item.field === 'narration');
  assert.ok(problem);
  assert.ok(problem.message.includes('空镜'));
});

test('validateScript：多镜多问题一次列全，问题带镜号', () => {
  const result = validateScript({
    shots: [
      { no: 1, time: { start: 0, duration: 0 }, visual: '', narration: '' },
      { no: 2, time: { start: 1, duration: 2 }, visual: 'B', onScreenText: 'B' },
    ],
  });
  assert.equal(result.ok, false);
  const shots = new Set(result.problems.map((item) => item.shot));
  assert.ok(shots.has(1));
  assert.ok(result.problems.some((item) => item.field === 'time.duration'));
  assert.ok(result.problems.some((item) => item.field === 'visual'));
  assert.ok(result.problems.some((item) => item.field === 'narration'));
});

test('buildScriptDraft：同内容幂等，改内容 draftCount 累加且 confirmed 重置', () => {
  const first = buildScriptDraft(SCRIPT_DOC, { now: NOW_TS });
  assert.equal(first.ok, true);
  assert.equal(first.script.draftCount, 1);
  assert.equal(first.script.confirmed, false);

  const confirmed = { ...first.script, confirmed: true, confirmedAt: '2026-01-01T00:00:00.000Z' };
  const again = buildScriptDraft(SCRIPT_DOC, { prev: confirmed, now: NOW_TS });
  assert.equal(again.idempotent, true);
  assert.equal(again.script.confirmed, true);
  assert.equal(again.script.draftCount, 1);

  const changed = buildScriptDraft(
    { ...SCRIPT_DOC, shots: [{ ...SCRIPT_DOC.shots[0] }, { ...SCRIPT_DOC.shots[1], visual: '换了个画面' }] },
    { prev: confirmed, now: NOW_TS },
  );
  assert.equal(changed.idempotent, false);
  assert.equal(changed.script.draftCount, 2);
  assert.equal(changed.script.confirmed, false);
  assert.equal(changed.script.confirmedAt, null);
});

/* ------------------------------------------------------------------ */
/* 2. 阶段机：进入条件                                                 */
/* ------------------------------------------------------------------ */

test('阶段链固定为 idle→clarify→script→style→locked→build', () => {
  assert.deepEqual(STAGES, ['idle', 'clarify', 'script', 'style', 'locked', 'build']);
});

test('brief 未满：进不了 script，draft 被拒且不写盘', async () => {
  const project = newProject();
  await project.call('video_brief_confirm', { answers: { goal: '只答一项' } });
  const scriptStage = await project.call('video_stage_advance', { to: 'script' });
  assert.equal(scriptStage.ok, false);
  assert.equal(scriptStage.code, 'brief-not-ready');

  const draft = await project.call('video_script_draft', { script: SCRIPT_DOC });
  assert.equal(draft.ok, false);
  assert.equal(draft.code, 'brief-not-ready');
  assert.equal(project.mem.files.has(scriptPath(ROOT)), false);
});

test('brief 满：自动进 script；advance to style 被拒且文案提到脚本', async () => {
  const project = newProject();
  const brief = await project.call('video_brief_confirm', { answers: ALL_ANSWERS });
  assert.equal(brief.stage, 'script');
  assert.equal(readState(project).stage, 'script');

  const toStyle = await project.call('video_stage_advance', { to: 'style' });
  assert.equal(toStyle.ok, false);
  assert.equal(toStyle.code, 'script-not-confirmed');
  assert.ok(toStyle.error.includes('脚本'));
  assert.equal(readState(project).stage, 'script', '被拒绝时不得改 state');
});

test('force:true 也越不过「脚本未确认」', async () => {
  const project = newProject();
  seedBrief(project);
  seedState(project, 'script');
  const forced = await project.call('video_stage_advance', { to: 'style', force: true });
  assert.equal(forced.ok, false);
  assert.equal(forced.code, 'script-not-confirmed');
  assert.ok(forced.error.includes('脚本'));
  assert.equal(readState(project).stage, 'script');
});

/* ------------------------------------------------------------------ */
/* 3. draft 工具                                                       */
/* ------------------------------------------------------------------ */

test('video_script_draft：写坏脚本不写盘，problems 逐条返回', async () => {
  const project = newProject();
  await project.call('video_brief_confirm', { answers: ALL_ANSWERS });
  const bad = {
    ...SCRIPT_DOC,
    shots: [
      { no: 1, time: { start: 0, duration: 0 }, visual: '', narration: '' },
      { no: 2, time: { start: 0, duration: 2 }, visual: 'B', onScreenText: 'B' },
    ],
  };
  const result = await project.call('video_script_draft', { script: bad });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-script');
  assert.ok(result.problems.length >= 3);
  assert.equal(result.written, false);
  assert.equal(project.mem.files.has(scriptPath(ROOT)), false, '校验失败不得创建 script.json');
});

test('video_script_draft：合法脚本写盘、draftCount=1、confirmed=false', async () => {
  const project = newProject();
  await project.call('video_brief_confirm', { answers: ALL_ANSWERS });
  const result = await project.call('video_script_draft', { script: SCRIPT_DOC });
  assert.equal(result.ok, true);
  assert.equal(result.written, true);
  assert.equal(result.confirmed, false);
  assert.equal(result.draftCount, 1);
  assert.equal(result.summary.shotCount, 2);
  assert.equal(result.summary.totalDuration, 7);
  assert.equal(result.stage, 'script');

  const saved = readScriptFile(project);
  assert.equal(saved.confirmed, false);
  assert.equal(saved.draftCount, 1);
  assert.equal(saved.shots.length, 2);
  assert.equal(saved.shots[1].time.start, 3);
});

test('video_script_draft：同一脚本重复调用不累加 draftCount', async () => {
  const project = newProject();
  await project.call('video_brief_confirm', { answers: ALL_ANSWERS });
  await project.call('video_script_draft', { script: SCRIPT_DOC });
  const fileAfterFirst = project.mem.files.get(scriptPath(ROOT));

  const second = await project.call('video_script_draft', { script: SCRIPT_DOC });
  assert.equal(second.ok, true);
  assert.equal(second.written, false);
  assert.equal(second.idempotent, true);
  assert.equal(second.draftCount, 1);
  assert.equal(project.mem.files.get(scriptPath(ROOT)), fileAfterFirst, '幂等调用不得改动文件');
});

test('video_script_draft：改动后 draftCount 累加、confirmed 自动重置 false', async () => {
  const project = newProject();
  await project.call('video_brief_confirm', { answers: ALL_ANSWERS });
  await project.call('video_script_draft', { script: SCRIPT_DOC });
  await project.call('video_script_confirm', { note: '用户说可以' });
  assert.equal(readScriptFile(project).confirmed, true);

  const revised = {
    ...SCRIPT_DOC,
    shots: [SCRIPT_DOC.shots[0], { ...SCRIPT_DOC.shots[1], visual: '换成了一个新画面' }],
  };
  const result = await project.call('video_script_draft', { script: revised });
  assert.equal(result.ok, true);
  assert.equal(result.draftCount, 2);
  assert.equal(result.confirmed, false);
  const saved = readScriptFile(project);
  assert.equal(saved.confirmed, false);
  assert.equal(saved.confirmedAt, null);
  assert.equal(saved.draftCount, 2);
  assert.ok(saved.revisedAt);
});

/* ------------------------------------------------------------------ */
/* 4. read / confirm                                                   */
/* ------------------------------------------------------------------ */

test('video_script_read：文件缺失返回 {script:null, confirmed:false}，不抛', async () => {
  const project = newProject();
  const result = await project.call('video_script_read');
  assert.equal(result.script, null);
  assert.equal(result.confirmed, false);
  assert.equal(result.exists, false);
  assert.equal(result.scriptMissing, true);
  assert.equal(result.draftCount, 0);
});

test('video_script_read：写盘后可读回内容 / confirmedAt / draftCount', async () => {
  const project = newProject();
  await project.call('video_brief_confirm', { answers: ALL_ANSWERS });
  await project.call('video_script_draft', { script: SCRIPT_DOC });
  const confirmed = await project.call('video_script_confirm', { note: '用户明确确认' });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.confirmed, true);

  const read = await project.call('video_script_read');
  assert.equal(read.confirmed, true);
  assert.equal(read.confirmedAt, new Date(NOW_TS).toISOString());
  assert.equal(read.draftCount, 1);
  assert.equal(read.script.shots.length, 2);
  assert.equal(read.stage, 'style');
  assert.equal(read.nextStep.includes('video_style_confirm'), true);
});

test('video_script_confirm：没有脚本草稿时拒绝 script-missing', async () => {
  const project = newProject();
  await project.call('video_brief_confirm', { answers: ALL_ANSWERS });
  const result = await project.call('video_script_confirm', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'script-missing');
  assert.equal(result.written, false);
  assert.equal(readState(project).stage, 'script');
});

test('video_script_confirm：确认后 confirmed=true、confirmedAt 落盘、阶段进 style', async () => {
  const project = newProject();
  await project.call('video_brief_confirm', { answers: ALL_ANSWERS });
  await project.call('video_script_draft', { script: SCRIPT_DOC });
  const result = await project.call('video_script_confirm', { note: '用户说没问题' });
  assert.equal(result.ok, true);
  assert.equal(result.written, true);
  assert.equal(result.stage, 'style');
  assert.equal(result.confirmed, true);

  const saved = readScriptFile(project);
  assert.equal(saved.confirmed, true);
  assert.equal(saved.confirmedAt, new Date(NOW_TS).toISOString());
  assert.equal(saved.note, '用户说没问题');
  assert.equal(readState(project).stage, 'style');
  assert.ok(readState(project).history.some((entry) => entry.reason === 'script-confirmed'));
});

test('video_script_confirm：重复确认幂等，不重复写盘', async () => {
  const project = newProject();
  await project.call('video_brief_confirm', { answers: ALL_ANSWERS });
  await project.call('video_script_draft', { script: SCRIPT_DOC });
  await project.call('video_script_confirm', {});
  const snapshot = project.mem.files.get(scriptPath(ROOT));

  const again = await project.call('video_script_confirm', {});
  assert.equal(again.ok, true);
  assert.equal(again.written, false);
  assert.equal(again.idempotent, true);
  assert.equal(project.mem.files.get(scriptPath(ROOT)), snapshot);
});

test('确认后的脚本能被 advance 接住：script → style 放行', async () => {
  const project = newProject();
  seedBrief(project);
  seedScript(project, true);
  seedState(project, 'script');
  const result = await project.call('video_stage_advance', { to: 'style' });
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'style');
  assert.equal(result.forced, false);
});

/* ------------------------------------------------------------------ */
/* 5. stage_get 与历史工程兼容                                          */
/* ------------------------------------------------------------------ */

test('video_stage_get：新增 scriptReady / scriptConfirmed / scriptDraftCount / nextStep', async () => {
  const project = newProject();
  await project.call('video_brief_confirm', { answers: ALL_ANSWERS });

  const empty = await project.call('video_stage_get');
  assert.equal(empty.stage, 'script');
  assert.equal(empty.scriptReady, false);
  assert.equal(empty.scriptConfirmed, false);
  assert.equal(empty.scriptDraftCount, 0);
  assert.equal(empty.scriptMissing, true);
  assert.ok(empty.nextStep.includes('video_script_draft'));

  await project.call('video_script_draft', { script: SCRIPT_DOC });
  const drafted = await project.call('video_stage_get');
  assert.equal(drafted.scriptReady, true);
  assert.equal(drafted.scriptConfirmed, false);
  assert.equal(drafted.scriptDraftCount, 1);
  assert.equal(drafted.script.shotCount, 2);
  assert.equal(drafted.script.totalDuration, 7);
  assert.ok(drafted.nextStep.includes('video_script_confirm'));
  assert.ok(drafted.blocked.some((item) => item.includes('脚本')));

  await project.call('video_script_confirm', {});
  const confirmed = await project.call('video_stage_get');
  assert.equal(confirmed.stage, 'style');
  assert.equal(confirmed.scriptConfirmed, true);
  assert.ok(confirmed.nextStep.includes('video_style_confirm'));
});

test('历史工程：有 style.json、state=locked、没有 script.json → 不降级，标 scriptMissing 并提示补脚本', async () => {
  const project = newProject();
  seedBrief(project);
  seedStyle(project);
  seedState(project, 'locked');

  const view = await project.call('video_stage_get');
  assert.equal(view.stage, 'locked', '已有的 locked 不能被 script 缺失收回');
  assert.equal(view.healed, false);
  assert.equal(view.scriptMissing, true);
  assert.equal(view.scriptReady, false);
  assert.equal(view.scriptConfirmed, false);
  assert.equal(view.scriptDraftCount, 0);
  assert.ok(view.nextStep.includes('补'));
  assert.ok(view.nextStep.includes('video_script_draft'));
  assert.equal(readState(project).stage, 'locked');
});

test('历史工程：state=build 且没有 script.json → build 保持不变', async () => {
  const project = newProject();
  seedBrief(project);
  seedStyle(project);
  seedState(project, 'build');

  const view = await project.call('video_stage_get');
  assert.equal(view.stage, 'build');
  assert.equal(view.scriptMissing, true);
  assert.ok(view.nextStep.includes('补'));
  assert.equal(readState(project).stage, 'build');
});

/* ------------------------------------------------------------------ */
/* 6. 门禁                                                             */
/* ------------------------------------------------------------------ */

test('门禁：enforce 未完成 brief 调 video_script_draft 被拒', () => {
  const denied = decideGate({
    mode: 'enforce',
    stage: 'clarify',
    toolName: 'video_script_draft',
    briefReady: false,
    missing: [{ slot: 'goal', title: '目标与验收' }],
  });
  assert.equal(denied.action, 'deny');
  assert.equal(denied.code, 'brief-not-ready');
  assert.ok(denied.reason.includes('脚本'));

  const allowed = decideGate({ mode: 'enforce', stage: 'script', toolName: 'video_script_draft', briefReady: true });
  assert.equal(allowed.action, 'allow');

  const warned = decideGate({ mode: 'warn', stage: 'clarify', toolName: 'video_script_draft', briefReady: false });
  assert.equal(warned.action, 'warn');
});

test('门禁：script 阶段 style 工具与写类工具被拒（先确认脚本）', () => {
  const style = decideGate({ mode: 'enforce', stage: 'script', toolName: 'video_style_confirm', briefReady: true });
  assert.equal(style.action, 'deny');
  assert.equal(style.code, 'script-not-confirmed');
  assert.ok(style.reason.includes('脚本'));

  const write = decideGate({ mode: 'enforce', stage: 'script', toolName: 'video_edit_apply', briefReady: true });
  assert.equal(write.action, 'deny');
  assert.equal(write.code, 'script-not-confirmed');
});

test('门禁钩子：三个脚本工具都走 pre-execute（read 放行、draft/confirm 按 brief 拦）', async () => {
  const handlers = new Map();
  const ctx = { on: (event, handler) => handlers.set(event, handler) };
  registerGate(ctx, {
    mode: 'enforce',
    readState: async () => ({
      stage: 'clarify',
      briefReady: false,
      scriptConfirmed: false,
      styleConfirmed: false,
      missing: [{ slot: 'goal', title: '目标与验收' }],
      projectRoot: ROOT,
      cwd: ROOT,
      hasProject: true,
    }),
    log: () => {},
  });
  const handler = handlers.get('tools/pre-execute');

  const draft = await handler({ name: 'video_script_draft', args: {} }, () => 'NEXT');
  assert.equal(draft.kind, 'deny');
  assert.ok(draft.reason.includes('脚本'));

  const confirm = await handler({ name: 'video_script_confirm', args: {} }, () => 'NEXT');
  assert.equal(confirm.kind, 'deny');

  const read = await handler({ name: 'video_script_read', args: {} }, () => 'NEXT');
  assert.equal(read, 'NEXT', '只读工具不拦');
});

/* ------------------------------------------------------------------ */
/* 跑                                                                  */
/* ------------------------------------------------------------------ */

const results = [];
let cursor = 0;
for (const item of cases) {
  cursor += 1;
  try {
    await item.fn();
    results.push({ ok: true });
    console.log(`✓ ${String(cursor).padStart(2, '0')} ${item.name}`);
  } catch (error) {
    results.push({ ok: false });
    console.log(`✗ ${String(cursor).padStart(2, '0')} ${item.name}`);
    console.log(`   ${(error && error.stack) || error}`);
  }
}

const passed = results.filter((item) => item.ok).length;
const failed = results.length - passed;
console.log(`\n${passed}/${results.length} 通过，${failed} 失败`);
if (failed > 0) process.exitCode = 1;
