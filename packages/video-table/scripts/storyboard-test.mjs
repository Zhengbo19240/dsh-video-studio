/**
 * 分镜切分测试。
 *
 *   node scripts/storyboard-test.mjs
 *
 * 覆盖：基础切分、短句合并、长句切分、首尾标签、数字/连接词命中、
 * 总时长守恒、maxShots 截断、非法输入、工具层的 SRT 与工程两条路径。
 */

import { useTempBindings } from './_bindings-guard.mjs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStoryboard, EFFECT_CHOICES } from '../src/storyboard.mjs';
import { storyboardTools } from '../src/storyboard-tools.mjs';
import { ProjectStore } from '../src/store.mjs';

// 绑定表写到临时文件，别碰用户真实的 ~/.dsh
const cleanupBindings = useTempBindings('storyboard');
const bindings = process.env.DSH_VIDEO_BINDINGS;

let pass = 0;
let fail = 0;

async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + (e && e.message));
  }
}

function must(cond, message) {
  if (!cond) throw new Error(message);
}

function near(a, b, tolerance = 0.001) {
  return Math.abs(a - b) <= tolerance;
}

function throwsChinese(fn, keyword) {
  let error = null;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  if (!error) throw new Error('应当抛错，但没有抛');
  if (!(error instanceof Error)) throw new Error('抛出的不是 Error');
  if (keyword && !String(error.message).includes(keyword)) {
    throw new Error(`错误信息应包含「${keyword}」，实际是：${error.message}`);
  }
  if (!/[\u4e00-\u9fff]/.test(String(error.message))) {
    throw new Error('错误信息应该是中文：' + error.message);
  }
  return error;
}

const threeCues = [
  { start: 0, end: 3, text: '先说结论。' },
  { start: 3, end: 6, text: '这里有一个背景。' },
  { start: 6, end: 9, text: '最后收个尾。' },
];

// ------------------------------------------------------------------ 纯函数 ----

console.log('buildStoryboard');

await t('基础切分：三条 3 秒字幕切成三镜', () => {
  const board = buildStoryboard(threeCues);
  must(board.shots.length === 3, '镜数应为 3，实际 ' + board.shots.length);
  must(board.shots[1].text === '这里有一个背景。', '第二镜文本不对：' + board.shots[1].text);
  must(near(board.shots[0].start, 0) && near(board.shots[2].end, 9), '起止时间不对');
});

await t('短句合并：两条 0.9 秒的半句合成一镜', () => {
  const board = buildStoryboard([
    { start: 0, end: 0.9, text: '如果只看' },
    { start: 0.9, end: 1.8, text: '表面现象' },
  ]);
  must(board.shots.length === 1, '应合成 1 镜，实际 ' + board.shots.length);
  must(board.shots[0].text === '如果只看表面现象', '合并后的文本不对：' + board.shots[0].text);
  must(near(board.shots[0].duration, 1.8), '合并后时长应为 1.8，实际 ' + board.shots[0].duration);
});

await t('长句切分：一条 12 秒切成 2–3 镜，且每镜不超 6 秒', () => {
  const long = [
    {
      start: 0,
      end: 12,
      text: '这个结论看上去很简单，但真正落地的时候会遇到很多细节问题，比如时间怎么分配，团队怎么分工，以及验收标准到底由谁来定。',
    },
  ];
  const board = buildStoryboard(long);
  must(board.shots.length >= 2 && board.shots.length <= 3, '镜数应在 2–3，实际 ' + board.shots.length);
  for (const shot of board.shots) {
    must(shot.duration <= 6.001, '有一镜超过 6 秒：' + shot.duration);
    must(shot.duration >= 1.999, '有一镜短于 2 秒：' + shot.duration);
  }
});

await t('首镜 hook、末镜 outro，中间按文本给 point', () => {
  const board = buildStoryboard(threeCues);
  must(board.shots[0].kind === 'hook', '首镜应为 hook，实际 ' + board.shots[0].kind);
  must(board.shots[2].kind === 'outro', '末镜应为 outro，实际 ' + board.shots[2].kind);
  must(board.shots[1].kind === 'point', '中间镜应为 point，实际 ' + board.shots[1].kind);
});

await t('数字命中 evidence，并建议 count-up', () => {
  const board = buildStoryboard([
    { start: 0, end: 3, text: '先看一个数字。' },
    { start: 3, end: 6, text: '转化率是 87%。' },
    { start: 6, end: 9, text: '最后收个尾。' },
  ]);
  must(board.shots[1].kind === 'evidence', '含数字的镜应为 evidence，实际 ' + board.shots[1].kind);
  must(board.shots[1].suggestedEffect === 'count-up', '数字镜建议动效应为 count-up');
});

await t('连接词命中 transition', () => {
  const board = buildStoryboard([
    { start: 0, end: 3, text: '先说结论。' },
    { start: 3, end: 6, text: '所以我们换个角度看。' },
    { start: 6, end: 9, text: '最后收个尾。' },
  ]);
  must(board.shots[1].kind === 'transition', '含「所以」的镜应为 transition，实际 ' + board.shots[1].kind);
  must(board.shots[1].suggestedEffect === 'scanline-glint', '转场镜建议动效应为 scanline-glint');
});

await t('时长合计与输入总时长误差小于 1 秒', () => {
  const cues = [0, 3, 6, 9, 12].map((start) => ({
    start,
    end: start + 3,
    text: '第 ' + (start / 3 + 1) + ' 段。',
  }));
  const inputTotal = cues.reduce((sum, c) => sum + (c.end - c.start), 0);
  const board = buildStoryboard(cues);
  must(near(board.total, inputTotal, 1), `分镜合计 ${board.total} 与输入 ${inputTotal} 差太多`);
  const shotTotal = board.shots.reduce((sum, s) => sum + s.duration, 0);
  must(near(shotTotal, inputTotal, 1), `各镜相加 ${shotTotal} 与输入 ${inputTotal} 差太多`);
});

await t('maxShots 截断并给出 warning', () => {
  const cues = Array.from({ length: 10 }, (_, i) => ({
    start: i * 3,
    end: i * 3 + 3,
    text: '第 ' + (i + 1) + ' 句。',
  }));
  const board = buildStoryboard(cues, { maxShots: 3 });
  must(board.shots.length === 3, '应截断到 3 镜，实际 ' + board.shots.length);
  must(board.warnings.some((w) => w.includes('上限')), 'warning 应提到上限：' + board.warnings.join(' / '));
  must(board.shots[2].kind === 'outro', '截断后最后一镜仍应是 outro');
});

await t('空输入抛中文错误', () => {
  throwsChinese(() => buildStoryboard([]), '没有字幕');
});

await t('时间倒挂抛中文错误', () => {
  throwsChinese(() => buildStoryboard([{ start: 5, end: 3, text: '反的' }]), '倒挂');
});

await t('建议动效都在白名单里，且每镜都有理由', () => {
  const board = buildStoryboard(threeCues);
  for (const shot of board.shots) {
    must(EFFECT_CHOICES.includes(shot.suggestedEffect), '未知动效：' + shot.suggestedEffect);
    must(typeof shot.reason === 'string' && shot.reason.length > 0, '第 ' + shot.index + ' 镜没有理由');
  }
});

// -------------------------------------------------------------------- 工具 ----

console.log('storyboardTools');

const SESSION = 'session-storyboard';
const store = new ProjectStore();
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-storyboard-'));
const doc = await store.open(root, SESSION);
const tool = storyboardTools({ store })[0];
const exec = { agent: { id: SESSION } };

await t('工具：直接传 SRT 能返回 count/total/shots', async () => {
  const srt =
    '1\n00:00:00,000 --> 00:00:03,000\n先说结论。\n\n' +
    '2\n00:00:03,000 --> 00:00:06,000\n这里有一个背景。\n\n' +
    '3\n00:00:06,000 --> 00:00:09,000\n最后收个尾。\n';
  const out = await tool.execute({ srt }, exec);
  must(out.count === 3, 'count 应为 3，实际 ' + out.count);
  must(near(out.total, 9), 'total 应为 9，实际 ' + out.total);
  must(out.shots.length === 3, 'shots 长度不对');
  must(out.shots[0].kind === 'hook', '首镜应为 hook');
  must(out.shots[2].kind === 'outro', '末镜应为 outro');
  must(out.shots[0].text.length <= 61, '文本应截断到 60 字以内');
});

await t('工具：从工程字幕轨读取，并按 start 排序', async () => {
  // 故意乱序插入，验证读取后会按时间排好
  const preview = store.preview(doc.projectId, SESSION, undefined, [
    { type: 'clip.insert', clipId: 'sb6', trackId: 't1', clipType: 'text', start: 6, duration: 3, text: '最后收个尾。' },
    { type: 'clip.insert', clipId: 'sb0', trackId: 't1', clipType: 'text', start: 0, duration: 3, text: '先说结论。' },
    { type: 'clip.insert', clipId: 'sb3', trackId: 't1', clipType: 'text', start: 3, duration: 3, text: '这里有一个背景。' },
  ], '测试字幕');
  await store.applyPreview(preview.previewId, SESSION);

  const out = await tool.execute({}, exec);
  must(out.count === 3, 'count 应为 3，实际 ' + out.count);
  must(out.shots[0].start === 0, '首镜应从 0 秒开始，实际 ' + out.shots[0].start);
  must(out.shots[0].text === '先说结论。', '排序不对，首镜文本：' + out.shots[0].text);
  must(out.source === 'project', 'source 应为 project');
});

await t('工具：工程里没有字幕、又没传 srt 时报错', async () => {
  const emptyStore = new ProjectStore();
  const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-storyboard-empty-'));
  await emptyStore.open(emptyRoot, 'session-empty');
  const emptyTool = storyboardTools({ store: emptyStore })[0];
  let error = null;
  try {
    await emptyTool.execute({}, { agent: { id: 'session-empty' } });
  } catch (e) {
    error = e;
  }
  must(error, '应当抛错');
  must(error.code === 'INVALID_ARG', '错误码应为 INVALID_ARG，实际 ' + error.code);
  must(/[\u4e00-\u9fff]/.test(error.message), '错误信息应为中文');
  await fs.rm(emptyRoot, { recursive: true, force: true });
});

await fs.rm(root, { recursive: true, force: true });
cleanupBindings();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
