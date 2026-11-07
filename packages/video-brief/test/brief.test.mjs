/**
 * dsh-video-brief 自测。纯 Node，不需要 DSH 运行时：
 *   node test/brief.test.mjs
 *
 * 覆盖三层：判定（brief.mjs）、存储（store.mjs，注入内存 fs）、门禁（gate.mjs）。
 */

import assert from 'node:assert/strict';
import path from 'node:path';

import {
  buildSummary,
  compareBrief,
  driftReport,
  evaluateBrief,
  mergeAnswers,
  normalizeBrief,
  referenceStatus,
} from '../src/brief.mjs';
import { normalizeSlots, DEFAULT_SLOTS } from '../src/slots.mjs';
import {
  createBriefStore,
  createScriptStore,
  createStateStore,
  createStyleStore,
  briefPath,
  scriptPath,
  statePath,
  stylePath,
  META_DIR,
} from '../src/store.mjs';
import {
  VIDEO_WRITE_TOOLS,
  buildDenyReason,
  classifyPath,
  decideGate,
  registerGate,
} from '../src/gate.mjs';
import {
  STAGES,
  blockedFor,
  createStageService,
  emptyStageState,
  evaluateAdvance,
  factsStage,
  nextStepFor,
  normalizeStageState,
  reconcileStageState,
} from '../src/stage.mjs';
import {
  buildStyle,
  normalizeStyle,
  normalizeStylePreview,
  normalizeStyleSpec,
} from '../src/style.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { buildPromptText } from '../src/prompt.mjs';
import { pickRelatedPreferences, tokenize } from '../src/memory.mjs';
import { createVideoBriefTools } from '../src/tools.mjs';
import { apply } from '../index.js';

const ROOT = process.platform === 'win32' ? 'C:\\proj' : '/proj';

/* ------------------------------------------------------------------ */
/* 极简测试骨架（不引第三方）                                            */
/* ------------------------------------------------------------------ */

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

/* ------------------------------------------------------------------ */
/* 内存文件系统（与 store 注入接口同名同签名）                            */
/* ------------------------------------------------------------------ */

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

function newStore(initial = {}) {
  const mem = createMemoryFs(initial);
  const store = createBriefStore({ projectRoot: ROOT, fs: mem.fs, now: () => 1767225600000 });
  return { mem, store };
}

function briefWith(slots, extra = {}) {
  return {
    version: 1,
    topic: '',
    round: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    slots,
    ...extra,
  };
}

const ALL_ANSWERS = {
  goal: '让新用户看完知道怎么用，验收是 3 秒内说清痛点',
  audience: '刚装上 DSH 的程序员',
  platform: '视频号 9:16',
  duration: '30 秒',
  tone: '克制、专业，不喊口号',
  pace: '快，12 个镜头，卡点',
  visual: '屏幕录制 + 少量动效，深色背景',
  reference: '像 Fireship 那种节奏',
  deliverable: 'MP4 1080x1920 30fps，另附字幕 SRT',
  taboo: '不出现真实 API KEY，不用红色大字报',
};

const STYLE_SPEC = {
  tone: '克制、专业，不喊口号',
  palette: ['#0B0B0F', '#7C5CFF'],
  font: '思源黑体 Medium',
  density: 'med',
  pace: 2.5,
};

const STYLE_PREVIEW = {
  keyframes: ['preview/kf-1.png', 'preview/kf-2.png', 'preview/kf-3.png', 'preview/kf-4.png'],
  clip: 'preview/style-8s.mp4',
};

const NOW_TS = 1767225600000;

/* ------------------------------------------------------------------ */
/* 阶段机测试用的完整工程（brief + state + style 三件套）                 */
/* ------------------------------------------------------------------ */

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

function seedBrief(project, slots, extra = {}) {
  project.seed(briefPath(ROOT), briefWith(slots, extra));
}

function seedStyle(project, confirmed = true) {
  project.seed(stylePath(ROOT), {
    spec: STYLE_SPEC,
    confirmed,
    confirmedAt: '2026-01-01T00:00:00.000Z',
    confirmedBy: 'user',
  });
}

const SCRIPT_DOC = {
  version: 1,
  title: '30 秒讲清 DSH 视频流程',
  logline: '从问询到开工，一条片子怎么走完六阶段',
  shots: [
    { no: 1, time: { start: 0, duration: 3 }, visual: '黑底白字标题', narration: '做一条视频，先别急着开剪。', onScreenText: '先问清', transition: '硬切' },
    { no: 2, time: { start: 3, duration: 4 }, visual: '工作台录屏', narration: '十个槽位问完，再写脚本。', onScreenText: '10 项简报', transition: '叠化 0.3s' },
  ],
};

function seedScript(project, confirmed = true) {
  project.seed(scriptPath(ROOT), {
    ...SCRIPT_DOC,
    confirmed,
    confirmedAt: confirmed ? '2026-01-01T00:00:00.000Z' : null,
    draftCount: 1,
    revisedAt: '2026-01-01T00:00:00.000Z',
  });
}

/** 用真实工具把脚本写好并确认（brief 必须已满）。 */
async function prepareScript(project) {
  const drafted = await project.call('video_script_draft', { script: SCRIPT_DOC });
  assert.equal(drafted.ok, true, `draft 应成功：${JSON.stringify(drafted.problems)}`);
  const confirmed = await project.call('video_script_confirm', {});
  assert.equal(confirmed.ok, true, `confirm 应成功：${confirmed.error}`);
  return confirmed;
}

function seedState(project, stage, history = []) {
  project.seed(statePath(ROOT), {
    stage,
    since: '2026-01-01T00:00:00.000Z',
    history,
  });
}

function readStateFile(project) {
  return JSON.parse(project.mem.files.get(statePath(ROOT)));
}

/* ------------------------------------------------------------------ */
/* 判定                                                                */
/* ------------------------------------------------------------------ */

test('空 brief：needs-answers，missing 恰好 3 条且按优先级', () => {
  const ev = evaluateBrief({ brief: undefined, maxQuestions: 3, maxRounds: 6 });
  assert.equal(ev.verdict, 'needs-answers');
  assert.equal(ev.ready, false);
  assert.equal(ev.total, 10);
  assert.equal(ev.missing.length, 3);
  assert.deepEqual(ev.missing.map((item) => item.slot), ['goal', 'platform', 'duration']);
  for (const item of ev.missing) {
    assert.ok(item.question.length > 0, `${item.slot} 必须带问题`);
    assert.ok(item.why.length > 0, `${item.slot} 必须带 why`);
  }
});

test('填 5 个：missing 从剩下 5 个里取前 3（按优先级，不是按声明顺序）', () => {
  const ev = evaluateBrief({
    brief: briefWith({
      goal: 'a',
      platform: 'b',
      duration: 'c',
      audience: 'd',
      tone: 'e',
    }),
    maxQuestions: 3,
    maxRounds: 6,
  });
  assert.equal(ev.filledCount, 5);
  assert.equal(ev.missing.length, 3);
  // pace(60) → deliverable(70) → visual(80)：deliverable 排在 visual 前面才算真按优先级
  assert.deepEqual(ev.missing.map((item) => item.slot), ['pace', 'deliverable', 'visual']);
  assert.equal(ev.missingAll.length, 5);
});

test('填满 10 个：ready=true，verdict=ready', () => {
  const ev = evaluateBrief({ brief: briefWith({ ...ALL_ANSWERS }) });
  assert.equal(ev.ready, true);
  assert.equal(ev.verdict, 'ready');
  assert.equal(ev.filledCount, 10);
  assert.equal(ev.missing.length, 0);
});

test('轮数到顶也不自动放行：9/10 仍是 needs-answers', () => {
  const slots = { ...ALL_ANSWERS };
  delete slots.taboo;
  const ev = evaluateBrief({
    brief: briefWith(slots, { round: 6 }),
    maxRounds: 6,
  });
  assert.equal(ev.verdict, 'needs-answers');
  assert.equal(ev.ready, false);
  assert.equal(ev.roundsLeft, 0);
  assert.deepEqual(ev.missing.map((item) => item.slot), ['taboo']);
});

test('空字符串/纯空白视为未填', () => {
  const merged = mergeAnswers({
    brief: briefWith({}),
    answers: { goal: '   ', platform: '\n\t' },
  });
  assert.deepEqual(merged.changed, []);
  assert.equal(merged.ignored.length, 2);
  assert.ok(merged.stillMissing.includes('goal'));
  assert.ok(merged.stillMissing.includes('platform'));
  assert.equal(merged.ready, false);
});

test('compareBrief 能分出新增/修改/删除', () => {
  const diff = compareBrief(
    briefWith({ goal: '旧目标', platform: 'a' }),
    briefWith({ goal: '新目标', duration: '30s' }),
  );
  assert.deepEqual(diff.changed, [{ slot: 'goal', from: '旧目标', to: '新目标' }]);
  assert.deepEqual(diff.added, ['duration']);
  assert.deepEqual(diff.removed, ['platform']);
  assert.equal(diff.same, false);
});

test('drift：已有 brief 且 topic 变了 → 报差异并标记旧答案可能过期', () => {
  const brief = briefWith({ goal: 'a', platform: 'b' }, { topic: '产品宣传片' });
  const changed = driftReport({ brief, topic: '课程教学片' });
  assert.equal(changed.topic_changed, true);
  assert.equal(changed.topic_before, '产品宣传片');
  assert.equal(changed.topic_after, '课程教学片');
  assert.deepEqual(changed.may_be_stale, ['goal', 'platform']);

  const same = driftReport({ brief, topic: '产品宣传片' });
  assert.equal(same.topic_changed, false);
  assert.deepEqual(same.may_be_stale, []);
});

test('槽位覆盖：按 id 打补丁，priority 可改顺序，未提到的槽位保留', () => {
  const slots = normalizeSlots([
    { id: 'goal', question: '这次片子想让人记住哪一句？', priority: 999 },
    { id: 'reference', remove: true },
    { id: '不存在', question: 'x' },
  ]);
  assert.equal(slots.length, 9);
  assert.equal(slots[slots.length - 1].id, 'goal');
  assert.equal(slots[slots.length - 1].question, '这次片子想让人记住哪一句？');
  assert.ok(!slots.some((slot) => slot.id === 'reference'));
  const ev = evaluateBrief({ brief: undefined, slots, maxQuestions: 3 });
  assert.deepEqual(ev.missing.map((item) => item.slot), ['platform', 'duration', 'audience']);
});

test('buildSummary 列出所有已填槽位并点出还缺什么', () => {
  const summary = buildSummary({ brief: briefWith({ goal: '做一条 30 秒竖屏', platform: '抖音 9:16' }) });
  assert.ok(summary.includes('2/10'));
  assert.ok(summary.includes('目标与验收：做一条 30 秒竖屏'));
  assert.ok(summary.includes('平台与画幅：抖音 9:16'));
  assert.ok(summary.includes('还缺'));
});

/* ------------------------------------------------------------------ */
/* 存储                                                                */
/* ------------------------------------------------------------------ */

test('brief.json 损坏：降级为空并备份 .bak（原内容不丢）', async () => {
  const file = briefPath(ROOT);
  const broken = '{ 这不是 json';
  const { mem, store } = newStore({ [file]: broken });
  const read = await store.read();
  assert.equal(read.corrupt, true);
  assert.equal(read.exists, true);
  assert.ok(read.backup && read.backup.endsWith('.bak'), '必须备份成 .bak');
  assert.equal(mem.files.get(read.backup), broken);
  assert.equal(Object.keys(read.brief.slots).length, 0);
  assert.equal(evaluateBrief({ brief: read.brief }).verdict, 'needs-answers');
});

test('文件不存在：不报错，返回空 brief', async () => {
  const { store } = newStore();
  const read = await store.read();
  assert.equal(read.exists, false);
  assert.equal(read.corrupt, false);
  assert.deepEqual(read.brief.slots, {});
});

test('原子写：落盘后没有残留 .tmp', async () => {
  const { mem, store } = newStore();
  await store.update((prev) => ({
    brief: mergeAnswers({ brief: prev, answers: { goal: '写进去' } }).brief,
  }));
  const tmps = [...mem.files.keys()].filter((key) => key.endsWith('.tmp'));
  assert.deepEqual(tmps, []);
  assert.ok(mem.files.get(store.file).includes('写进去'));
});

test('并发写不丢数据：10 个 confirm 同时进来，10 个槽位全在', async () => {
  const { store } = newStore();
  const entries = Object.entries(ALL_ANSWERS);
  await Promise.all(entries.map(([slot, value]) => store.update((prev) => ({
    brief: mergeAnswers({ brief: prev, answers: { [slot]: value } }).brief,
  }))));
  const { brief } = await store.read();
  assert.equal(Object.keys(brief.slots).length, 10);
  for (const [slot, value] of entries) assert.equal(brief.slots[slot], value);
  assert.equal(evaluateBrief({ brief }).ready, true);
});

/* ------------------------------------------------------------------ */
/* 工具（真实定义 + 注入依赖，仍然不碰 DSH）                              */
/* ------------------------------------------------------------------ */

function makeTools(store) {
  const config = { ...normalizeConfig(undefined), memoryEnabled: false };
  const tools = createVideoBriefTools({
    config: () => config,
    storeFor: () => store,
    workspaceRoot: () => ROOT,
    memoryPath: () => path.join(ROOT, 'no-global.json'),
    log: () => {},
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return {
    start: (args = {}) => byName.video_brief_start.execute(args, { agent: { id: 'a1' } }),
    confirm: (args) => byName.video_brief_confirm.execute(args, { agent: { id: 'a1' } }),
    register: (args) => byName.video_reference_register.execute(args, { agent: { id: 'a1' } }),
    skip: (args = {}) => byName.video_reference_skip.execute(args, { agent: { id: 'a1' } }),
    byName,
  };
}

test('confirm 幂等：同样的答案再 confirm 一次，不写盘、changed 为空', async () => {
  const { mem, store } = newStore();
  const { confirm } = makeTools(store);
  const first = await confirm({ answers: ALL_ANSWERS });
  assert.equal(first.ok, true);
  assert.equal(first.ready, true);
  assert.equal(first.written, true);
  const snapshot = mem.files.get(store.file);

  const second = await confirm({ answers: ALL_ANSWERS });
  assert.equal(second.ready, true);
  assert.equal(second.written, false);
  assert.equal(second.idempotent, true);
  assert.deepEqual(second.changed, []);
  assert.equal(mem.files.get(store.file), snapshot, '幂等调用不能改动文件内容');
});

test('非法槽位名：整批拒绝且不写盘，allowed 里给出合法清单', async () => {
  const { mem, store } = newStore();
  const { confirm } = makeTools(store);
  const result = await confirm({ answers: { goal: '合法', nastly: '非法' } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unknown-slot');
  assert.deepEqual(result.rejected, ['nastly']);
  assert.ok(result.allowed.includes('goal'));
  assert.ok(result.allowed.includes('taboo'));
  assert.equal(result.written, false);
  assert.equal(mem.files.has(store.file), false, '被拒绝的调用不得创建 brief.json');
});

test('confirm 部分填写：写部分、ready=false、stillMissing 是剩下的槽位', async () => {
  const { store } = newStore();
  const { confirm } = makeTools(store);
  const result = await confirm({
    answers: { goal: '目标', platform: '平台', duration: '30s' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.ready, false);
  assert.equal(result.written, true);
  assert.deepEqual(result.stillMissing, ['audience', 'tone', 'pace', 'deliverable', 'visual', 'reference', 'taboo']);
  assert.ok(result.next_step.includes('还缺'));
});

test('start：空 brief 返回 missing 3 条 + 轮数 + 提示语', async () => {
  const { store } = newStore();
  const { start } = makeTools(store);
  const result = await start({ topic: '30 秒竖屏宣传片' });
  assert.equal(result.verdict, 'needs-answers');
  assert.equal(result.missing.length, 3);
  assert.equal(result.round, 0);
  assert.equal(result.maxRounds, 6);
  assert.equal(result.transcript_hint, '把缺失项一次问完，别挤牙膏');
  assert.deepEqual(result.memory_context, []);
  assert.equal(result.mode, 'new');
  assert.equal(result.drift, undefined);
});

test('start(mode:drift)：已有 brief 时返回差异', async () => {
  const { mem, store } = newStore();
  mem.files.set(store.file, JSON.stringify(briefWith({ goal: 'a', platform: 'b' }, { topic: '产品宣传片' })));
  const { start } = makeTools(store);
  const result = await start({ topic: '课程教学片', mode: 'drift' });
  assert.equal(result.mode, 'drift');
  assert.equal(result.drift.topic_changed, true);
  assert.deepEqual(result.drift.may_be_stale, ['goal', 'platform']);
});

/* ------------------------------------------------------------------ */
/* 参考素材：固定提问 + 显式「无参考」                                   */
/* ------------------------------------------------------------------ */

const REFERENCE_SLOT = DEFAULT_SLOTS.find((slot) => slot.id === 'reference');
const NINE_ANSWERS = { ...ALL_ANSWERS };
delete NINE_ANSWERS.reference;

test('参考素材未填：missing 里仍在，且 question 用固定提问', () => {
  const ev = evaluateBrief({ brief: briefWith({ goal: '目标' }), maxQuestions: 9999 });
  const ref = ev.missingAll.find((item) => item.slot === 'reference');
  assert.ok(ref, '未填时 reference 必须出现在 missing 里');
  assert.equal(ref.question, REFERENCE_SLOT.askText);
  assert.ok(ref.question.includes('4–5 张'));
  assert.ok(ref.question.includes('一张图胜过一万字描述'));
  assert.equal(ref.kind, 'references');
  assert.equal(ref.why, REFERENCE_SLOT.why);
});

test('参考素材空串 / 纯空白：仍算未回答，不进 filled', () => {
  for (const value of ['', '   ', '\n\t']) {
    const ev = evaluateBrief({ brief: briefWith({ goal: '目标', reference: value }), maxQuestions: 9999 });
    assert.ok(ev.missingAll.some((item) => item.slot === 'reference'), `${JSON.stringify(value)} 不该算填`);
    assert.equal(ev.filled.reference, undefined);
    assert.equal(referenceStatus(briefWith({ reference: value })).state, 'missing');
  }
  const merged = mergeAnswers({ brief: briefWith({}), answers: { reference: '  \n ' } });
  assert.deepEqual(merged.changed, []);
  assert.ok(merged.stillMissing.includes('reference'));
  assert.equal(merged.ready, false);
});

test('字符串「无参考」：算已填，summary 标注（用户确认无参考）', () => {
  const brief = briefWith({ ...NINE_ANSWERS, reference: '无参考' });
  const ev = evaluateBrief({ brief });
  assert.equal(ev.ready, true);
  assert.ok(ev.filled.reference, '显式无参考要计入已填');
  assert.equal(referenceStatus(brief).state, 'explicit-none');
  const summary = buildSummary({ brief });
  assert.ok(summary.includes('（用户确认无参考）'), summary);
  assert.ok(summary.includes('10/10'));
});

test('{skipped:true, reason} 也是显式无参考，原因原样保留', () => {
  const brief = briefWith({ reference: { skipped: true, reason: '没找到合适的' } });
  assert.equal(referenceStatus(brief).state, 'explicit-none');
  assert.deepEqual(normalizeBrief(brief).slots.reference, { skipped: true, reason: '没找到合适的' });
  assert.ok(evaluateBrief({ brief }).filled.reference);
  // 空对象 / skipped:false 都不算回答
  assert.equal(referenceStatus(briefWith({ reference: {} })).state, 'missing');
  assert.equal(referenceStatus(briefWith({ reference: { skipped: false } })).state, 'missing');
});

test('referenceStatus 三态：missing / explicit-none / provided', () => {
  assert.deepEqual(referenceStatus(briefWith({})), { state: 'missing' });
  assert.deepEqual(referenceStatus(briefWith({ reference: '   ' })), { state: 'missing' });
  assert.deepEqual(referenceStatus(briefWith({ reference: { skipped: true } })), { state: 'explicit-none' });
  assert.deepEqual(referenceStatus(briefWith({ reference: '像 Fireship 那种节奏' })), { state: 'provided', count: 1 });
  assert.deepEqual(
    referenceStatus(briefWith({ reference: { paths: ['refs/a.png', 'refs/b.png'], count: 2 } })),
    { state: 'provided', count: 2 },
  );
});

test('video_reference_register：登记 4 条路径 → count=4，brief 里 reference 已填', async () => {
  const { mem, store } = newStore();
  const { register } = makeTools(store);
  const paths = ['refs/a.png', 'refs/b.png', 'refs/c.jpg', 'refs/d.webp'];
  const result = await register({ paths, note: '画风参考' });
  assert.equal(result.ok, true);
  assert.equal(result.count, 4);
  assert.deepEqual(result.paths, paths);
  assert.equal(result.state, 'provided');
  assert.equal(result.written, true);
  assert.equal(result.ready, false, '只有参考一项答了，不能 ready');

  const { brief } = await store.read();
  assert.equal(brief.slots.reference.count, 4);
  assert.equal(brief.slots.reference.note, '画风参考');
  assert.deepEqual(brief.slots.reference.paths, paths);
  assert.equal(referenceStatus(brief).count, 4);
  // 只登记路径与数量，不复制文件：内存里除了 brief.json 没有别的文件
  assert.deepEqual([...mem.files.keys()], [store.file]);
  assert.ok(result.summary.includes('4 个参考文件'));
});

test('video_reference_skip：state=explicit-none，重复调用幂等', async () => {
  const { store } = newStore();
  const { skip } = makeTools(store);
  const result = await skip({ reason: '没找到合适的' });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'explicit-none');
  assert.deepEqual(result.reference, { state: 'explicit-none' });
  assert.equal(result.written, true);
  assert.ok(result.summary.includes('（用户确认无参考）'));

  const again = await skip({ reason: '没找到合适的' });
  assert.equal(again.state, 'explicit-none');
  assert.equal(again.written, false);
  assert.equal(again.idempotent, true);
});

test('其它 9 项齐：显式无参考 → ready；参考未回答 → 不 ready', () => {
  const explicit = evaluateBrief({ brief: briefWith({ ...NINE_ANSWERS, reference: { skipped: true } }) });
  assert.equal(explicit.ready, true);
  assert.equal(explicit.verdict, 'ready');

  const unanswered = evaluateBrief({ brief: briefWith(NINE_ANSWERS) });
  assert.equal(unanswered.ready, false);
  assert.ok(unanswered.missingAll.some((item) => item.slot === 'reference'));
});

test('register 拒绝越界与绝对路径：整批不写盘；混合时只写合法项', async () => {
  const { mem, store } = newStore();
  const { register } = makeTools(store);
  const bad = await register({ paths: ['../secret.png', 'C:\\Windows\\a.png', '/etc/passwd', 'refs/../../x.png'] });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'path-not-allowed');
  assert.equal(bad.count, 0);
  assert.ok(bad.rejected.includes('../secret.png'));
  assert.ok(bad.rejected.includes('C:\\Windows\\a.png'));
  assert.equal(mem.files.has(store.file), false, '整批非法不得创建 brief.json');

  const mixed = await register({ paths: ['../bad.png', 'refs/good.png'] });
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.paths, ['refs/good.png']);
  assert.deepEqual(mixed.rejected, ['../bad.png']);
});

test('并发 register 不丢数据：两个调用各 2 条 → 合并成 4 条', async () => {
  const { store } = newStore();
  const { register } = makeTools(store);
  await Promise.all([
    register({ paths: ['refs/a.png', 'refs/b.png'] }),
    register({ paths: ['refs/c.png', 'refs/d.png'] }),
  ]);
  const { brief } = await store.read();
  assert.equal(brief.slots.reference.count, 4);
  assert.deepEqual([...brief.slots.reference.paths].sort(), ['refs/a.png', 'refs/b.png', 'refs/c.png', 'refs/d.png']);
  assert.equal(referenceStatus(brief).state, 'provided');
});

test('缺参考的文案：summary 与 denyReason 都提醒「图片」优于文字', () => {
  const summary = buildSummary({ brief: briefWith({ goal: '目标' }) });
  assert.ok(summary.includes('图片'), summary);
  assert.ok(summary.includes('无参考'));
  const reason = buildDenyReason({
    toolName: 'video_edit_apply',
    missing: [{ slot: 'reference', title: '参考素材' }],
  });
  assert.ok(reason.includes('图片'), reason);
  assert.ok(reason.includes('无参考'));
});

test('start：reference 缺失时 missing 里的 question 是固定提问', async () => {
  const { store } = newStore();
  const tools = makeTools(store);
  await tools.confirm({ answers: NINE_ANSWERS });
  const result = await tools.start({});
  const ref = result.missing.find((item) => item.slot === 'reference');
  assert.ok(ref, '9 项齐时 missing 里应只剩 reference');
  assert.equal(ref.question, REFERENCE_SLOT.askText);
  assert.equal(result.verdict, 'needs-answers');
});

/* ------------------------------------------------------------------ */
/* 门禁                                                                */
/* ------------------------------------------------------------------ */

test('门禁 warn：放行并记一条日志', async () => {
  const handlers = new Map();
  const logs = [];
  const ctx = { on: (event, handler) => handlers.set(event, handler) };
  registerGate(ctx, {
    mode: 'warn',
    readState: async () => ({ ready: false, missing: [{ slot: 'goal', title: '目标与验收' }], projectRoot: ROOT, cwd: ROOT, hasProject: true }),
    log: (message) => logs.push(message),
  });
  const handler = handlers.get('tools/pre-execute');
  assert.ok(handler, 'warn 档必须注册 pre-execute 钩子');
  const outcome = await handler({ name: 'video_edit_apply', args: {} }, () => 'NEXT');
  assert.equal(outcome, 'NEXT');
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('warn'));
});

test('门禁 enforce：拒绝并给中文原因，指向 video_brief_start', async () => {
  const handlers = new Map();
  const ctx = { on: (event, handler) => handlers.set(event, handler) };
  registerGate(ctx, {
    mode: 'enforce',
    readState: async () => ({
      ready: false,
      missing: [{ slot: 'goal', title: '目标与验收' }, { slot: 'platform', title: '平台与画幅' }],
      projectRoot: ROOT,
      cwd: ROOT,
      hasProject: true,
    }),
    log: () => {},
  });
  const outcome = await handlers.get('tools/pre-execute')({ name: 'video_edit_apply', args: {} }, () => 'NEXT');
  assert.equal(outcome.kind, 'deny');
  assert.ok(outcome.reason.includes('video_brief_start'));
  assert.ok(outcome.reason.includes('目标与验收'));
  assert.ok(/[\u4e00-\u9fff]/.test(outcome.reason), '拒绝原因必须是中文');
});

test('门禁 off：完全不拦、连钩子都不挂', async () => {
  const handlers = new Map();
  const logs = [];
  const ctx = { on: (event, handler) => handlers.set(event, handler) };
  registerGate(ctx, {
    mode: 'off',
    readState: async () => {
      throw new Error('off 档不该读盘');
    },
    log: (message) => logs.push(message),
  });
  assert.equal(handlers.size, 0);
  assert.ok(logs[0].includes('off'));
  assert.equal(decideGate({ mode: 'off', toolName: 'video_edit_apply', ready: false }).action, 'allow');
});

test('未 ready + 所有写类视频工具 → 拒绝', () => {
  for (const toolName of VIDEO_WRITE_TOOLS) {
    const decision = decideGate({ mode: 'enforce', toolName, ready: false, missing: [{ title: '目标与验收' }] });
    assert.equal(decision.action, 'deny', `${toolName} 应该被拒绝`);
    assert.equal(decision.code, 'brief-not-ready');
  }
});

test('未 ready + 读类视频工具 → 放行', () => {
  for (const toolName of ['video_project_inspect', 'video_analysis_read', 'video_annotation_list']) {
    const decision = decideGate({ mode: 'enforce', toolName, ready: false, missing: [] });
    assert.equal(decision.action, 'allow', `${toolName} 必须放行`);
  }
});

test('video_transcribe 只有 applyToTimeline:true 才拦', () => {
  const denied = decideGate({ mode: 'enforce', toolName: 'video_transcribe', args: { applyToTimeline: true }, ready: false });
  assert.equal(denied.action, 'deny');
  const allowed = decideGate({ mode: 'enforce', toolName: 'video_transcribe', args: { applyToTimeline: false }, ready: false });
  assert.equal(allowed.action, 'allow');
  const implicit = decideGate({ mode: 'enforce', toolName: 'video_transcribe', args: {}, ready: false });
  assert.equal(implicit.action, 'allow');
});

test('write/edit：.dsh-video 内放行、工程内拒绝、工程外放行', () => {
  const meta = path.join(ROOT, META_DIR, 'brief.json');
  const project = path.join(ROOT, 'assets', 'intro.mp4');
  const outside = path.join(path.dirname(ROOT), 'other', 'notes.md');
  assert.equal(classifyPath({ filePath: meta, projectRoot: ROOT }), 'meta');
  assert.equal(classifyPath({ filePath: project, projectRoot: ROOT }), 'project');
  assert.equal(classifyPath({ filePath: outside, projectRoot: ROOT }), 'outside');

  const base = { mode: 'enforce', ready: false, projectRoot: ROOT, cwd: ROOT, hasProject: true };
  assert.equal(decideGate({ ...base, toolName: 'write', args: { file_path: meta } }).action, 'allow');
  assert.equal(decideGate({ ...base, toolName: 'write', args: { file_path: project } }).action, 'deny');
  assert.equal(decideGate({ ...base, toolName: 'edit', args: { file_path: outside } }).action, 'allow');
  // 不是视频工程（没有 .dsh-video/）就不该管文件写入
  assert.equal(decideGate({ ...base, toolName: 'write', args: { file_path: project }, hasProject: false }).action, 'allow');
});

test('brief ready 时门禁全放行', () => {
  assert.equal(decideGate({ mode: 'enforce', toolName: 'video_edit_apply', ready: true }).action, 'allow');
});

test('buildDenyReason 说清缺几项、缺什么、下一步做什么', () => {
  const reason = buildDenyReason({
    toolName: 'video_edit_apply',
    missing: [{ title: '目标与验收' }, { title: '时长' }],
  });
  assert.ok(reason.includes('video_edit_apply'));
  assert.ok(reason.includes('还缺 2 项'));
  assert.ok(reason.includes('目标与验收'));
  assert.ok(reason.includes('video_brief_confirm'));
});

/* ------------------------------------------------------------------ */
/* 提示段与偏好筛选                                                     */
/* ------------------------------------------------------------------ */

test('提示段在 720 字以内，且写清了工序、并发与交付物', () => {
  const text = buildPromptText();
  assert.ok(text.includes('video_brief_start'));
  assert.ok(text.includes('≤3 条'));
  assert.ok(text.includes('video_edit_apply'));
  assert.ok(text.replace(/\s+/g, '').length <= 720);
  // 工序必须串行：画面 → 音效 → 配乐 → 统稿（否则画面一动音效全废）
  assert.ok(text.includes('工序串行'));
  assert.ok(text.includes('音效'));
  assert.ok(text.includes('配乐'));
  assert.ok(text.includes('统稿'));
  // 并发只能按模块，不能按时长均分
  assert.ok(text.includes('按模块'));
});

test('偏好筛选：命中主题的排前，不命中就不硬塞', () => {
  const prefs = [
    { text: '交付文档只要 PDF 和 Word', tags: [], updated: 3 },
    { text: '视频交付优先竖屏 9:16，字幕要烧进画面', tags: ['视频'], updated: 2 },
    { text: '注释一律用中文', tags: [], updated: 1 },
  ];
  const hits = pickRelatedPreferences(prefs, '做一条竖屏视频');
  assert.ok(hits[0].includes('竖屏'));
  const miss = pickRelatedPreferences(prefs, '重构数据库连接池');
  assert.deepEqual(miss, []);
  assert.ok(tokenize('竖屏视频').includes('竖屏'));
  // 没有主题时给最近更新的 3 条
  assert.equal(pickRelatedPreferences(prefs, '').length, 3);
});

test('配置默认值：gate=warn、maxRounds=6、10 个槽位', () => {
  const config = normalizeConfig(undefined);
  assert.equal(config.gate, 'warn');
  assert.equal(config.maxRounds, 6);
  assert.equal(config.slots.length, 10);
  assert.deepEqual(config.slots.map((slot) => slot.id), DEFAULT_SLOTS.map((slot) => slot.id));
  assert.equal(normalizeConfig({ gate: '乱写', maxRounds: 99 }).gate, 'warn');
  assert.equal(normalizeConfig({ gate: '乱写', maxRounds: 99 }).maxRounds, 20);
});

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/** 假 Cordis context：只要 apply 用到的四个成员。 */
function fakeCtx() {
  const tools = [];
  const handlers = new Map();
  const sections = [];
  const logger = { info() {}, warn() {}, error() {} };
  const ctx = {
    logger,
    get(name) {
      if (name === 'tools') {
        return { register: (definition) => { tools.push(definition); return () => {}; } };
      }
      if (name === 'systemPrompt') {
        return { section: (options) => { sections.push(options); return () => {}; } };
      }
      return null;
    },
    effect(fn) {
      fn();
      return () => {};
    },
    inject(_names, callback) {
      callback({
        systemPrompt: { section: (options) => { sections.push(options); return () => {}; } },
        logger,
        effect(fn) {
          fn();
          return () => {};
        },
      });
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  return { ctx, tools, handlers, sections };
}

test('apply() 能装配：11 个工具 + pre-execute 钩子 + 一条提示段（order 650）', () => {
  const { ctx, tools, handlers, sections } = fakeCtx();
  apply(ctx, { gate: 'enforce', maxRounds: 8 });
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      'video_brief_confirm',
      'video_brief_start',
      'video_reference_register',
      'video_reference_skip',
      'video_script_confirm',
      'video_script_draft',
      'video_script_read',
      'video_stage_advance',
      'video_stage_get',
      'video_style_confirm',
      'video_style_read',
    ],
  );
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function');
    assert.ok(tool.parameters && tool.parameters.type === 'object');
  }
  assert.ok(handlers.has('tools/pre-execute'));
  assert.equal(sections.length, 1);
  assert.equal(sections[0].order, 650);
  assert.ok(sections[0].text.includes('video_brief_start'));
  assert.ok(sections[0].text.includes('video_stage_get'));
});

/* ------------------------------------------------------------------ */
/* 阶段机：纯函数                                                       */
/* ------------------------------------------------------------------ */

test('阶段顺序固定为 idle→clarify→script→style→locked→build', () => {
  assert.deepEqual(STAGES, ['idle', 'clarify', 'script', 'style', 'locked', 'build']);
});

test('normalizeStageState：坏结构降级 idle，未知阶段与坏 history 丢弃', () => {
  const state = normalizeStageState({
    stage: 'wat',
    since: 42,
    history: [
      { stage: 'locked', at: '2026-01-01T00:00:00.000Z', by: 'user', forced: true },
      { stage: '不存在的阶段' },
      null,
      'x',
    ],
  }, NOW_TS);
  assert.equal(state.stage, 'idle');
  assert.equal(state.since, new Date(NOW_TS).toISOString());
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].stage, 'locked');
  assert.equal(state.history[0].by, 'user');
  assert.equal(state.history[0].forced, true);
  assert.equal(normalizeStageState(null, NOW_TS).stage, 'idle');
  assert.deepEqual(normalizeStageState(null, NOW_TS).history, []);
});

test('factsStage：brief/脚本/风格事实决定阶段上限（build 不由事实推导）', () => {
  assert.equal(factsStage({}), 'idle');
  assert.equal(factsStage({ briefFilled: 3 }), 'clarify');
  assert.equal(factsStage({ briefFilled: 9, briefReady: false }), 'clarify');
  assert.equal(factsStage({ briefReady: true }), 'script');
  assert.equal(factsStage({ briefReady: true, scriptReady: true }), 'script');
  assert.equal(factsStage({ briefReady: true, scriptConfirmed: true }), 'style');
  assert.equal(factsStage({ styleConfirmed: true, briefFilled: 9 }), 'style');
  // 历史工程：style 已确认但没脚本 → 仍允许 locked（不收回），build 也不由事实推导
  assert.equal(factsStage({ briefReady: true, styleConfirmed: true }), 'locked');
  assert.equal(factsStage({ briefReady: true, styleConfirmed: true, scriptMissing: true }), 'locked');
});

test('reconcile：brief 只有 9 项但 state=locked → 回落到 style 并记 history', () => {
  const facts = { briefFilled: 9, briefReady: false, styleConfirmed: true };
  const before = { stage: 'locked', since: '2026-01-01T00:00:00.000Z', history: [{ stage: 'locked', at: '2026-01-01T00:00:00.000Z', by: 'tool' }] };
  const result = reconcileStageState(before, facts, NOW_TS);
  assert.equal(result.healed, true);
  assert.equal(result.from, 'locked');
  assert.equal(result.state.stage, 'style');
  assert.equal(result.state.history.length, 2);
  assert.equal(result.state.history.at(-1).reason, 'self-heal');
  assert.equal(result.state.history.at(-1).from, 'locked');
  assert.equal(result.state.history.at(-1).stage, 'style');
});

test('reconcile：build 需要 locked 事实；事实不够就回落，事实够就保留', () => {
  const lockedFacts = { briefReady: true, styleConfirmed: true, briefFilled: 10 };
  const build = { stage: 'build', since: '2026-01-01T00:00:00.000Z', history: [] };
  assert.equal(reconcileStageState(build, lockedFacts, NOW_TS).state.stage, 'build');

  const notReady = { briefReady: false, styleConfirmed: true, briefFilled: 9 };
  const healed = reconcileStageState(build, notReady, NOW_TS);
  assert.equal(healed.healed, true);
  assert.equal(healed.state.stage, 'style');

  // brief 满、脚本没确认、风格也没确认 → 上限是 script（新链路：先写脚本）
  const noStyle = { briefReady: true, styleConfirmed: false, scriptConfirmed: false, briefFilled: 10 };
  assert.equal(reconcileStageState(build, noStyle, NOW_TS).state.stage, 'script');
  assert.equal(reconcileStageState(build, { ...noStyle, scriptConfirmed: true }, NOW_TS).state.stage, 'style');

  // 落后于事实不算矛盾：不自动往前推。
  const lagging = reconcileStageState({ stage: 'clarify', since: '2026-01-01T00:00:00.000Z', history: [] }, lockedFacts, NOW_TS);
  assert.equal(lagging.healed, false);
  assert.equal(lagging.state.stage, 'clarify');
});

test('evaluateAdvance：idle→clarify→script→style→locked→build 逐级放行', () => {
  let facts = { briefFilled: 1, briefReady: false, styleConfirmed: false };
  let step = evaluateAdvance({ from: 'idle', to: 'clarify', facts });
  assert.equal(step.ok, true);
  assert.equal(step.jump, false);

  facts = { briefFilled: 10, briefReady: true, styleConfirmed: false };
  step = evaluateAdvance({ from: 'clarify', to: 'script', facts });
  assert.equal(step.ok, true);

  facts = { briefFilled: 10, briefReady: true, scriptConfirmed: true, styleConfirmed: false };
  step = evaluateAdvance({ from: 'script', to: 'style', facts });
  assert.equal(step.ok, true);

  facts = { briefFilled: 10, briefReady: true, scriptConfirmed: true, styleConfirmed: true };
  step = evaluateAdvance({ from: 'style', to: 'locked', facts });
  assert.equal(step.ok, true);
  step = evaluateAdvance({ from: 'locked', to: 'build', facts });
  assert.equal(step.ok, true);
  // 同阶段 = 幂等
  assert.equal(evaluateAdvance({ from: 'build', to: 'build', facts }).noop, true);
});

test('evaluateAdvance：跳级要 force，倒退一律拒绝且给中文原因', () => {
  const facts = { briefFilled: 10, briefReady: true, scriptConfirmed: true, styleConfirmed: true };
  const noForce = evaluateAdvance({ from: 'idle', to: 'locked', facts });
  assert.equal(noForce.ok, false);
  assert.equal(noForce.code, 'needs-force');
  assert.ok(noForce.error.includes('force:true'));

  const forced = evaluateAdvance({ from: 'idle', to: 'locked', force: true, facts });
  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);
  assert.equal(forced.jump, true);

  const back = evaluateAdvance({ from: 'build', to: 'style', facts });
  assert.equal(back.ok, false);
  assert.equal(back.code, 'backwards');
  assert.ok(/[\u4e00-\u9fff]/.test(back.error));

  const bad = evaluateAdvance({ from: 'idle', to: 'done', facts });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad-stage');
});

test('evaluateAdvance：force 也不能越过事实（brief 不满 / 风格没确认）', () => {
  const empty = evaluateAdvance({ from: 'idle', to: 'clarify', force: true, facts: { briefFilled: 0 } });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'brief-empty');

  const nine = evaluateAdvance({
    from: 'clarify',
    to: 'locked',
    force: true,
    facts: { briefFilled: 9, briefReady: false, styleConfirmed: true, missing: ['taboo'], missingTitles: ['禁忌'] },
  });
  assert.equal(nine.ok, false);
  assert.equal(nine.code, 'brief-not-ready');
  assert.ok(nine.error.includes('禁忌'));

  const noStyle = evaluateAdvance({
    from: 'style',
    to: 'build',
    force: true,
    facts: { briefFilled: 10, briefReady: true, scriptConfirmed: true, styleConfirmed: false },
  });
  assert.equal(noStyle.ok, false);
  assert.equal(noStyle.code, 'style-not-confirmed');

  // 脚本没确认也越不过去（force 同样不行）
  const noScript = evaluateAdvance({
    from: 'script',
    to: 'style',
    force: true,
    facts: { briefFilled: 10, briefReady: true, scriptConfirmed: false, styleConfirmed: false },
  });
  assert.equal(noScript.ok, false);
  assert.equal(noScript.code, 'script-not-confirmed');
  assert.ok(noScript.error.includes('脚本'));
});

test('nextStep / blocked 随阶段变化', () => {
  assert.ok(nextStepFor('idle', {}).includes('video_brief_start'));
  assert.ok(nextStepFor('clarify', { missing: ['a', 'b'], briefFilled: 8, briefTotal: 10 }).includes('还缺 2 项'));
  assert.ok(nextStepFor('style', { briefFilled: 10, briefReady: true, scriptConfirmed: true }).includes('video_style_confirm'));
  assert.ok(nextStepFor('locked', {}).includes('build'));
  assert.ok(nextStepFor('build', {}).includes('生产'));
  assert.ok(blockedFor('clarify').length >= 2);
  assert.ok(blockedFor('locked').some((item) => item.includes('导出')));
  assert.deepEqual(blockedFor('build'), []);
});

/* ------------------------------------------------------------------ */
/* 阶段机：工具与存储                                                   */
/* ------------------------------------------------------------------ */

test('video_stage_get：空工程返回 idle、blocked、空 history', async () => {
  const project = newProject();
  const result = await project.call('video_stage_get');
  assert.equal(result.stage, 'idle');
  assert.equal(result.briefReady, false);
  assert.equal(result.briefFilled, 0);
  assert.equal(result.styleConfirmed, false);
  assert.equal(result.style, null);
  assert.equal(result.history.length, 0);
  assert.ok(result.blocked.length >= 2);
  assert.ok(result.nextStep.includes('video_brief_start'));
  assert.equal(project.mem.files.has(statePath(ROOT)), false, '非视频工程不应凭空创建 .dsh-video/state.json');
});

test('brief_confirm 自动推进：部分答案 → clarify；满 10 项 → script', async () => {
  const project = newProject();
  const partial = await project.call('video_brief_confirm', { answers: { goal: '目标', platform: '平台' } });
  assert.equal(partial.ok, true);
  assert.equal(partial.ready, false);
  assert.equal(partial.stage, 'clarify');
  let state = readStateFile(project);
  assert.equal(state.stage, 'clarify');
  assert.equal(state.history.at(-1).reason, 'brief-ready');

  const rest = { ...ALL_ANSWERS };
  delete rest.goal;
  delete rest.platform;
  const full = await project.call('video_brief_confirm', { answers: rest });
  assert.equal(full.ready, true);
  assert.equal(full.stage, 'script');
  state = readStateFile(project);
  assert.equal(state.stage, 'script');
});

test('video_style_confirm：brief 未满时拒绝，且不写 style.json', async () => {
  const project = newProject();
  await project.call('video_brief_confirm', { answers: { goal: 'a', platform: 'b', duration: '30s' } });
  const result = await project.call('video_style_confirm', { spec: STYLE_SPEC });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'brief-not-ready');
  assert.ok(/[\u4e00-\u9fff]/.test(result.error));
  assert.equal(project.mem.files.has(stylePath(ROOT)), false);
});

test('video_style_confirm：写盘 confirmed=true、spec/preview 完整、阶段 → locked', async () => {
  const project = newProject();
  await project.call('video_brief_confirm', { answers: ALL_ANSWERS });
  await prepareScript(project);
  const result = await project.call('video_style_confirm', { spec: STYLE_SPEC, preview: STYLE_PREVIEW });
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'locked');

  const saved = JSON.parse(project.mem.files.get(stylePath(ROOT)));
  assert.equal(saved.confirmed, true);
  assert.equal(saved.confirmedBy, 'user');
  assert.equal(saved.confirmedAt, new Date(NOW_TS).toISOString());
  assert.deepEqual(saved.spec, STYLE_SPEC);
  assert.deepEqual(saved.preview, STYLE_PREVIEW);

  const state = readStateFile(project);
  assert.equal(state.stage, 'locked');
  assert.ok(state.history.some((entry) => entry.reason === 'style-confirmed'));

  const view = await project.call('video_stage_get');
  assert.equal(view.stage, 'locked');
  assert.equal(view.styleConfirmed, true);
  assert.equal(view.style.tone, STYLE_SPEC.tone);
  assert.equal(view.style.pace, 2.5);
});

test('video_style_confirm：阶段落后（brief 已满、state=idle）时先按事实推进再锁', async () => {
  const project = newProject();
  seedBrief(project, ALL_ANSWERS);
  seedState(project, 'idle', []);
  await prepareScript(project);
  const result = await project.call('video_style_confirm', { spec: STYLE_SPEC });
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'locked');
  const state = readStateFile(project);
  assert.deepEqual(state.history.map((entry) => entry.reason), ['brief-ready', 'script-confirmed', 'style-confirmed']);
});

test('video_style_read：没有文件返回 null；未确认也返回 null；确认后可读回', async () => {
  const project = newProject();
  const empty = await project.call('video_style_read');
  assert.equal(empty.style, null);
  assert.equal(empty.exists, false);

  const unconfirmed = newProject();
  unconfirmed.seed(stylePath(ROOT), { spec: STYLE_SPEC, confirmed: false });
  const readUnconfirmed = await unconfirmed.call('video_style_read');
  assert.equal(readUnconfirmed.style, null);
  assert.equal(readUnconfirmed.exists, true);
  assert.equal(normalizeStyle({ spec: STYLE_SPEC, confirmed: false }), null);

  await project.call('video_brief_confirm', { answers: ALL_ANSWERS });
  await prepareScript(project);
  await project.call('video_style_confirm', { spec: STYLE_SPEC });
  const read = await project.call('video_style_read');
  assert.equal(read.style.spec.tone, STYLE_SPEC.tone);
  assert.equal(read.style.confirmed, true);
  assert.equal(read.stage, 'locked');
});

test('style 校验：tone/palette/font/density/pace 不合法 → 中文错误且不写盘', async () => {
  const spec = normalizeStyleSpec({ tone: '', palette: ['red'], font: '', density: 'huge', pace: 0 });
  assert.equal(spec.ok, false);
  assert.ok(spec.errors.length >= 5);

  const project = newProject();
  await project.call('video_brief_confirm', { answers: ALL_ANSWERS });
  const result = await project.call('video_style_confirm', {
    spec: { tone: '', palette: ['red'], font: '', density: 'huge', pace: 0 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-style');
  assert.ok(result.errors.length >= 5);
  assert.equal(project.mem.files.has(stylePath(ROOT)), false);
});

test('style 预览：绝对路径与 .mp4 之外的 clip 被拒', async () => {
  const preview = normalizeStylePreview({ keyframes: ['C:\\tmp\\a.png'], clip: 'preview/a.mov' });
  assert.equal(preview.ok, false);
  assert.ok(preview.errors.some((item) => item.includes('相对路径')));
  assert.ok(preview.errors.some((item) => item.includes('.mp4')));
  assert.equal(normalizeStylePreview({ keyframes: ['a.png', 'b.png'] }).preview.keyframes.length, 2);

  const built = buildStyle({ spec: STYLE_SPEC, preview: { keyframes: [], clip: 'ok/8s.mp4' } });
  assert.equal(built.ok, true);
  assert.equal(built.style.preview.clip, 'ok/8s.mp4');

  const project = newProject();
  await project.call('video_brief_confirm', { answers: ALL_ANSWERS });
  const result = await project.call('video_style_confirm', {
    spec: STYLE_SPEC,
    preview: { keyframes: ['C:\\tmp\\a.png'], clip: 'preview/a.mov' },
  });
  assert.equal(result.ok, false);
  assert.equal(project.mem.files.has(stylePath(ROOT)), false);
});

test('state.json 损坏：降级 idle、留 .bak、重建 state.json', async () => {
  const project = newProject();
  seedBrief(project, { goal: 'a' });
  project.seed(statePath(ROOT), '{ 这不是 json');
  const result = await project.call('video_stage_get');
  assert.equal(result.stage, 'idle');
  const backup = project.mem.files.get(`${statePath(ROOT)}.bak`);
  assert.equal(backup, '{ 这不是 json');
  const rebuilt = JSON.parse(project.mem.files.get(statePath(ROOT)));
  assert.equal(rebuilt.stage, 'idle');
  assert.deepEqual(rebuilt.history, []);
});

test('状态与事实矛盾：state=locked 但 brief 只有 9 项 → stage_get 自愈回 style 并写 history', async () => {
  const project = newProject();
  const nine = { ...ALL_ANSWERS };
  delete nine.taboo;
  seedBrief(project, nine);
  seedStyle(project);
  seedState(project, 'locked', [{ stage: 'locked', at: '2026-01-01T00:00:00.000Z', by: 'tool' }]);

  const result = await project.call('video_stage_get');
  assert.equal(result.stage, 'style');
  assert.equal(result.healed, true);
  assert.equal(result.briefFilled, 9);
  assert.equal(result.styleConfirmed, true);

  const state = readStateFile(project);
  assert.equal(state.stage, 'style');
  const last = state.history.at(-1);
  assert.equal(last.reason, 'self-heal');
  assert.equal(last.from, 'locked');
  assert.equal(last.stage, 'style');
});

test('video_stage_advance：跳级要 force、成功标 forced/jump；倒退被拒', async () => {
  const project = newProject();
  seedBrief(project, ALL_ANSWERS);
  seedScript(project);
  seedStyle(project);
  seedState(project, 'style', []);

  const blocked = await project.call('video_stage_advance', { to: 'build' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'needs-force');

  const advanced = await project.call('video_stage_advance', { to: 'build', force: true });
  assert.equal(advanced.ok, true);
  assert.equal(advanced.stage, 'build');
  assert.equal(advanced.forced, true);
  assert.equal(advanced.jump, true);

  const state = readStateFile(project);
  assert.equal(state.stage, 'build');
  const entry = state.history.find((item) => item.stage === 'build');
  assert.equal(entry.forced, true);
  assert.equal(entry.jump, true);
  assert.equal(entry.by, 'tool');

  const back = await project.call('video_stage_advance', { to: 'style' });
  assert.equal(back.ok, false);
  assert.equal(back.code, 'backwards');
  assert.ok(back.error.includes('只能前进'));
});

test('video_stage_advance：brief 不满时 force 也进不了 locked', async () => {
  const project = newProject();
  const nine = { ...ALL_ANSWERS };
  delete nine.taboo;
  seedBrief(project, nine);
  seedState(project, 'clarify', []);
  const result = await project.call('video_stage_advance', { to: 'locked', force: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'brief-not-ready');
  assert.ok(result.error.includes('还缺 1 项'));
  assert.equal(readStateFile(project).stage, 'clarify', '被拒绝时不得改 state');
});

test('并发 advance 不丢 history（工具层与 store 层各测一次）', async () => {
  const project = newProject();
  seedBrief(project, ALL_ANSWERS);
  seedStyle(project);
  await project.stores.state.write(emptyStageState(NOW_TS));

  const results = await Promise.all(Array.from({ length: 8 }, () => project.call('video_stage_advance', { to: 'clarify' })));
  assert.ok(results.every((item) => item.ok === true));
  let state = readStateFile(project);
  assert.equal(state.stage, 'clarify');
  assert.equal(state.history.filter((entry) => entry.stage === 'clarify').length, 1);

  await Promise.all(Array.from({ length: 12 }, (_, index) => project.stores.state.update((current) => ({
    state: {
      ...current,
      history: [...current.history, { stage: 'clarify', at: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`, by: 'tool' }],
    },
  }))));
  state = await project.stores.state.read();
  assert.equal(state.state.history.length, 13);
});

/* ------------------------------------------------------------------ */
/* 阶段门禁矩阵                                                         */
/* ------------------------------------------------------------------ */

test('门禁矩阵：6 个阶段 × 6 类工具逐格断言', () => {
  const expectations = {
    'video_brief_start': ['allow', 'allow', 'allow', 'allow', 'allow', 'allow'],
    'video_timeline_inspect': ['allow', 'allow', 'allow', 'allow', 'allow', 'allow'],
    'video_script_draft': ['allow', 'allow', 'allow', 'allow', 'allow', 'allow'],
    'video_style_read': ['deny', 'deny', 'deny', 'allow', 'allow', 'allow'],
    'video_edit_apply': ['deny', 'deny', 'deny', 'deny', 'allow', 'allow'],
    'video_export': ['deny', 'deny', 'deny', 'deny', 'deny', 'allow'],
  };
  for (const [toolName, row] of Object.entries(expectations)) {
    STAGES.forEach((stage, index) => {
      const decision = decideGate({
        mode: 'enforce',
        stage,
        toolName,
        briefReady: true,
        missing: [{ slot: 'goal', title: '目标与验收' }],
        projectRoot: ROOT,
        cwd: ROOT,
        hasProject: true,
      });
      assert.equal(decision.action, row[index], `${stage} + ${toolName} 应为 ${row[index]}`);
    });
  }

  // 脚本工具的真正门槛是 briefReady：brief 没满时 enforce 真拒，warn 只记日志。
  const deniedDraft = decideGate({ mode: 'enforce', stage: 'clarify', toolName: 'video_script_draft', briefReady: false });
  assert.equal(deniedDraft.action, 'deny');
  assert.equal(deniedDraft.code, 'brief-not-ready');
  assert.ok(deniedDraft.reason.includes('脚本'));
  const warned = decideGate({ mode: 'warn', stage: 'clarify', toolName: 'video_script_draft', briefReady: false });
  assert.equal(warned.action, 'warn');
  // script_read 是只读，永远放行。
  assert.equal(decideGate({ mode: 'enforce', stage: 'idle', toolName: 'video_script_read', briefReady: false }).action, 'allow');

  // write / edit：工程内按阶段，.dsh-video/ 内永远放行，工程外不碰。
  const projectFile = path.join(ROOT, 'assets', 'intro.mp4');
  const metaFile = path.join(ROOT, META_DIR, 'notes.md');
  const outside = path.join(path.dirname(ROOT), 'other', 'notes.md');
  const writeRow = ['deny', 'deny', 'deny', 'deny', 'allow', 'allow'];
  STAGES.forEach((stage, index) => {
    const base = { mode: 'enforce', stage, toolName: 'write', projectRoot: ROOT, cwd: ROOT, hasProject: true };
    assert.equal(decideGate({ ...base, args: { file_path: projectFile } }).action, writeRow[index], `${stage} 工程内文件`);
    assert.equal(decideGate({ ...base, args: { file_path: metaFile } }).action, 'allow', `${stage} .dsh-video 内`);
    assert.equal(decideGate({ ...base, args: { file_path: outside } }).action, 'allow', `${stage} 工程外`);
  });

  // 不是视频工程：write/edit 完全不碰。
  assert.equal(decideGate({
    mode: 'enforce', stage: 'idle', toolName: 'write', args: { file_path: projectFile }, projectRoot: ROOT, cwd: ROOT, hasProject: false,
  }).action, 'allow');
});

test('门禁：style 阶段写类在 warn 档放行并记日志，enforce 档拒绝', async () => {
  const handlers = new Map();
  const logs = [];
  const ctx = { on: (event, handler) => handlers.set(event, handler) };
  registerGate(ctx, {
    mode: 'warn',
    readState: async () => ({ stage: 'style', briefReady: true, styleConfirmed: false, missing: [], projectRoot: ROOT, cwd: ROOT, hasProject: true }),
    log: (message) => logs.push(message),
  });
  const outcome = await handlers.get('tools/pre-execute')({ name: 'video_edit_apply', args: {} }, () => 'NEXT');
  assert.equal(outcome, 'NEXT');
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('warn 档'));

  const decision = decideGate({ mode: 'enforce', stage: 'style', toolName: 'video_edit_apply' });
  assert.equal(decision.action, 'deny');
  assert.equal(decision.code, 'style-not-confirmed');
  assert.ok(decision.reason.includes('video_style_confirm'));
});

test('门禁：locked 阶段导出被锁在 build 之后；build 放行', () => {
  const locked = decideGate({ mode: 'enforce', stage: 'locked', toolName: 'video_export_start' });
  assert.equal(locked.action, 'deny');
  assert.equal(locked.code, 'not-building');
  assert.ok(locked.reason.includes('video_stage_advance'));
  assert.ok(locked.reason.includes('build'));

  assert.equal(decideGate({ mode: 'enforce', stage: 'build', toolName: 'video_export_start' }).action, 'allow');
  assert.equal(decideGate({ mode: 'enforce', stage: 'locked', toolName: 'video_export' }).action, 'deny');
});

test('门禁：locked 阶段第一次写操作（工程内文件）自动进 build；.dsh-video 内不算', async () => {
  const project = newProject();
  seedBrief(project, ALL_ANSWERS);
  seedStyle(project);
  seedState(project, 'locked', []);

  const handlers = new Map();
  const ctx = { on: (event, handler) => handlers.set(event, handler) };
  registerGate(ctx, {
    mode: 'enforce',
    readState: async () => {
      const snap = await project.stage.snapshot(ROOT);
      return {
        stage: snap.state.stage,
        briefReady: snap.facts.briefReady,
        styleConfirmed: snap.facts.styleConfirmed,
        missing: [],
        projectRoot: ROOT,
        cwd: ROOT,
        hasProject: true,
      };
    },
    onFirstWrite: async (root) => project.stage.autoBuild(root),
    log: () => {},
  });
  const handler = handlers.get('tools/pre-execute');

  // 写 .dsh-video/ 内的工程文档不触发 build
  let outcome = await handler({ name: 'write', args: { file_path: path.join(ROOT, META_DIR, 'notes.md') } }, () => 'NEXT');
  assert.equal(outcome, 'NEXT');
  assert.equal(readStateFile(project).stage, 'locked');

  // 第一次写工程内文件 → 放行，并自动进 build
  outcome = await handler({ name: 'write', args: { file_path: path.join(ROOT, 'assets', 'intro.txt') } }, () => 'NEXT');
  assert.equal(outcome, 'NEXT');
  const state = readStateFile(project);
  assert.equal(state.stage, 'build');
  assert.equal(state.history.at(-1).reason, 'first-write');

  // 再写一次不会重复记 history
  await handler({ name: 'video_edit_apply', args: {} }, () => 'NEXT');
  assert.equal(readStateFile(project).history.filter((entry) => entry.reason === 'first-write').length, 1);
});

test('提示段：阶段规则表，≤720 字，覆盖六个阶段与关键工具', () => {
  const text = buildPromptText();
  assert.ok(text.includes('video_stage_get'));
  assert.ok(text.includes('idle/clarify'));
  assert.ok(text.includes('script'));
  assert.ok(text.includes('style'));
  assert.ok(text.includes('locked'));
  assert.ok(text.includes('build'));
  assert.ok(text.includes('video_script_draft'));
  assert.ok(text.includes('video_script_confirm'));
  assert.ok(text.includes('video_style_confirm'));
  assert.ok(text.replace(/\s+/g, '').length <= 720);
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
