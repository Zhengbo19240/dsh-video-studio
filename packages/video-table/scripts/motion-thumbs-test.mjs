#!/usr/bin/env node
/**
 * 动效缩略图批量脚本的测试。
 *
 *   node scripts/motion-thumbs-test.mjs
 *
 * 不碰真实动效库：在系统临时目录里搭一个 5 条卡的小库（3 张能渲、1 张 render 抛错、
 * 1 张 needRender），用 --root 指过去跑真浏览器，再逐条核对报告 / meta / PNG / 幂等。
 *
 * 覆盖：
 *   1. 每张 native 卡要么有 thumb 且文件存在，要么有 error
 *   2. thumb.png 的真实尺寸是 1440×270（读 PNG 头，不看文件名）
 *   3. meta.render.fingerprint 与 code.js 实际 mtime/size 一致
 *   4. 连跑两次，第二次全部跳过
 *   5. --force 会重出
 *   6. code.js 改了，指纹变了，会自动补图
 *   7. thumb.png 丢了，即使指纹没变也会补图
 *   8. needRender 卡 thumb:null 且 thumbReason 非空
 *   9. listEntries() 每条都有 thumb 字段（绝对路径或 null）
 *  10. video_motion_list 的返回里带 thumb，且不是 dataURL（不把图塞进 RPC）
 *  11. 失败的卡不会中断整批
 *  12. 取样时刻符合 0 / 50% / 末帧前 5%
 */

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  THUMB_HEIGHT,
  THUMB_WIDTH,
  THUMB_FRAMES,
  fingerprintOf,
  parsePngSize,
  timesForDuration,
} from '../tools/render-motion-thumbs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, '..', 'tools', 'render-motion-thumbs.mjs');

let pass = 0;
let fail = 0;

async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (error) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + (error && error.message ? error.message : error));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-thumbs-test-'));
const reportPath = path.join(root, 'report.json');
const skillsDir = path.join(root, 'no-skills');

const CARDS = {
  'alpha-move': {
    meta: { title: '移动方块', kind: 'motion', duration: 2 },
    code: `export const meta = { title: '移动方块', duration: 2 };
export function render(ctx, t, env) {
  ctx.fillStyle = '#101418';
  ctx.fillRect(0, 0, env.width, env.height);
  const p = Math.min(1, t / 2);
  ctx.fillStyle = '#ff4d4d';
  ctx.fillRect(p * env.width * 0.75, env.height * 0.3, env.width * 0.2, env.height * 0.4);
}`,
  },
  'beta-fade': {
    meta: { title: '渐隐圆', kind: 'motion', duration: 1.5 },
    code: `export const meta = { title: '渐隐圆', duration: 1.5 };
export function render(ctx, t, env) {
  ctx.fillStyle = '#0b0d12';
  ctx.fillRect(0, 0, env.width, env.height);
  const p = Math.min(1, t / 1.5);
  ctx.fillStyle = 'rgba(80,160,255,' + (1 - p * 0.7) + ')';
  ctx.beginPath();
  ctx.arc(env.width * (0.2 + p * 0.6), env.height / 2, env.height * 0.22, 0, Math.PI * 2);
  ctx.fill();
}`,
  },
  'gamma-static': {
    meta: { title: '静态十字', kind: 'motion', duration: 1 },
    code: `export const meta = { title: '静态十字', duration: 1 };
export function render(ctx, t, env) {
  ctx.fillStyle = '#141414';
  ctx.fillRect(0, 0, env.width, env.height);
  ctx.strokeStyle = '#e8e8e8';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(env.width / 2, 0);
  ctx.lineTo(env.width / 2, env.height);
  ctx.moveTo(0, env.height / 2);
  ctx.lineTo(env.width, env.height / 2);
  ctx.stroke();
}`,
  },
  'broken-throw': {
    meta: { title: '会抛错的卡', kind: 'motion', duration: 1 },
    code: `export function render(ctx, t, env) {
  throw new Error('boom');
}`,
  },
  'need-render-card': {
    meta: { title: '只有说明的卡', kind: 'motion', description: '需要外部渲染器' },
    code: null,
  },
};

function runCli(args) {
  const result = spawnSync(process.execPath, [TOOL, '--root', root, '--report', reportPath, '--concurrency', '2', ...args], {
    encoding: 'utf8',
    timeout: 240000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`CLI 退出码 ${result.status}：${(result.stderr || result.stdout || '').slice(-800)}`);
  }
  return result.stdout;
}

async function readReport() {
  return JSON.parse(await fs.readFile(reportPath, 'utf8'));
}

function entryOf(report, id) {
  const entry = report.entries.find((x) => x.id === id);
  assert(entry, '报告里没有条目 ' + id);
  return entry;
}

async function readMeta(id) {
  return JSON.parse(await fs.readFile(path.join(root, id, 'meta.json'), 'utf8'));
}

// —— 搭测试库 ——
for (const [id, card] of Object.entries(CARDS)) {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(card.meta, null, 2) + '\n', 'utf8');
  if (card.code) await fs.writeFile(path.join(dir, 'code.js'), card.code, 'utf8');
  if (id === 'need-render-card') {
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: need-render-card\ndescription: 需要外部渲染器\n---\n\n没有原生的 code.js，只能跑外部脚本。\n', 'utf8');
  }
}

const times = timesForDuration(2);
let firstReport = null;
let secondReport = null;

await t('第一遍全量：能渲的 3 张出图，抛错 1 张进失败清单，needRender 1 张', async () => {
  runCli([]);
  firstReport = await readReport();
  assert(firstReport.summary.total === 5, 'total 应为 5，实际 ' + firstReport.summary.total);
  assert(firstReport.summary.rendered === 3, 'rendered 应为 3，实际 ' + firstReport.summary.rendered);
  assert(firstReport.summary.failed === 1, 'failed 应为 1，实际 ' + firstReport.summary.failed);
  assert(firstReport.summary.needRender === 1, 'needRender 应为 1，实际 ' + firstReport.summary.needRender);
});

await t('每张 native 卡要么有 thumb 且文件存在，要么有 error', async () => {
  for (const id of ['alpha-move', 'beta-fade', 'gamma-static']) {
    const entry = entryOf(firstReport, id);
    assert(entry.thumb, id + ' 没有 thumb');
    await fs.access(entry.thumb);
    assert(!entry.error, id + ' 不该有 error');
  }
  const broken = entryOf(firstReport, 'broken-throw');
  assert(broken.error && /boom/.test(broken.error), '抛错卡没有记录 error：' + JSON.stringify(broken));
});

await t('thumb.png 的真实尺寸是 1440×270（解析 PNG 头）', async () => {
  for (const id of ['alpha-move', 'beta-fade', 'gamma-static']) {
    const buffer = await fs.readFile(path.join(root, id, 'thumb.png'));
    const size = parsePngSize(buffer);
    assert(size, id + ' 的 thumb.png 不是合法 PNG');
    assert(size.width === THUMB_WIDTH * THUMB_FRAMES, id + ' 宽=' + size.width);
    assert(size.height === THUMB_HEIGHT, id + ' 高=' + size.height);
  }
});

await t('meta 里 render.fingerprint 与 code.js 实际 mtime/size 一致', async () => {
  for (const id of ['alpha-move', 'beta-fade', 'gamma-static']) {
    const meta = await readMeta(id);
    const actual = await fingerprintOf(path.join(root, id, 'code.js'));
    assert(meta.thumb === 'thumb.png', id + ' meta.thumb 应为 thumb.png');
    assert(meta.render && meta.render.fingerprint === actual, id + ' fingerprint 不一致');
    assert(meta.render.width === THUMB_WIDTH && meta.render.height === THUMB_HEIGHT && meta.render.frames === THUMB_FRAMES, id + ' render 尺寸字段不对');
    assert(!Number.isNaN(Date.parse(meta.thumbAt)), id + ' thumbAt 不是 ISO 时间');
  }
});

await t('取样时刻是 0 / 50% / 末帧前 5%', () => {
  assert(times.length === 3, '不是 3 个时刻');
  assert(times[0] === 0, '第一帧不是 0');
  assert(Math.abs(times[1] - 1) < 1e-9, '第二帧不是 1s（2s 的一半）：' + times[1]);
  assert(Math.abs(times[2] - 1.9) < 1e-9, '第三帧不是 1.9s（末帧前 5%）：' + times[2]);
  const entry = entryOf(firstReport, 'alpha-move');
  assert(entry.times[0] === 0 && ifClose(entry.times[1], 1) && ifClose(entry.times[2], 1.9), '报告里的 times 不对：' + JSON.stringify(entry.times));
});

function ifClose(a, b) {
  return Math.abs(Number(a) - b) < 1e-6;
}

await t('幂等：连跑第二次，3 张全部跳过', async () => {
  runCli([]);
  secondReport = await readReport();
  assert(secondReport.summary.skipped === 3, 'skipped 应为 3，实际 ' + secondReport.summary.skipped);
  assert(secondReport.summary.rendered === 0, '第二次不该重出，rendered=' + secondReport.summary.rendered);
});

await t('--force 会重出全部 native 卡', async () => {
  runCli(['--force']);
  const forced = await readReport();
  assert(forced.summary.rendered === 3, '--force 后 rendered 应为 3，实际 ' + forced.summary.rendered);
  assert(forced.summary.skipped === 0, '--force 后不该有 skipped，实际 ' + forced.summary.skipped);
});

await t('code.js 改了会自动补图（其他卡仍跳过）', async () => {
  const codePath = path.join(root, 'alpha-move', 'code.js');
  const code = await fs.readFile(codePath, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fs.writeFile(codePath, code + '\n// touch\n', 'utf8');
  runCli([]);
  const report = await readReport();
  assert(report.summary.rendered === 1, '应只重出 1 张，实际 ' + report.summary.rendered);
  assert(entryOf(report, 'alpha-move').status === 'rendered', 'alpha-move 没有重出');
  assert(report.summary.skipped === 2, '其余 2 张应跳过，实际 ' + report.summary.skipped);
  const meta = await readMeta('alpha-move');
  assert(meta.render.fingerprint === (await fingerprintOf(codePath)), '重出后指纹没有更新');
});

await t('thumb.png 丢了会自动补回（指纹没变也补）', async () => {
  await fs.rm(path.join(root, 'beta-fade', 'thumb.png'));
  runCli([]);
  const report = await readReport();
  assert(report.summary.rendered === 1, '应补回 1 张，实际 ' + report.summary.rendered);
  assert(entryOf(report, 'beta-fade').status === 'rendered', 'beta-fade 没有补回');
  await fs.access(path.join(root, 'beta-fade', 'thumb.png'));
});

await t('needRender 卡 thumb:null 且 thumbReason 非空', async () => {
  const meta = await readMeta('need-render-card');
  assert(meta.thumb === null, 'needRender 卡 thumb 应为 null，实际 ' + JSON.stringify(meta.thumb));
  assert(typeof meta.thumbReason === 'string' && meta.thumbReason.trim(), 'needRender 卡缺 thumbReason');
  await fs.rm(path.join(root, 'need-render-card', 'thumb.png'), { force: true });
  const entry = entryOf(await readReport(), 'need-render-card');
  assert(entry.status === 'needRender', '报告状态不是 needRender：' + entry.status);
});

await t('listEntries() 每条都带 thumb 字段，resolved 的是绝对路径', async () => {
  process.env.DSH_MOTION_LIB = root;
  process.env.DSH_SKILLS_DIR = skillsDir;
  const { listEntries } = await import('../src/motion-lib.mjs');
  const entries = await listEntries();
  assert(entries.length === 5, 'listEntries 应返回 5 条，实际 ' + entries.length);
  for (const entry of entries) {
    assert(Object.prototype.hasOwnProperty.call(entry, 'thumb'), entry.id + ' 没有 thumb 字段');
    assert(Object.prototype.hasOwnProperty.call(entry, 'thumbReason'), entry.id + ' 没有 thumbReason 字段');
  }
  const alpha = entries.find((x) => x.id === 'alpha-move');
  assert(path.isAbsolute(alpha.thumb), 'thumb 不是绝对路径：' + alpha.thumb);
  assert(alpha.thumb.endsWith('thumb.png'), 'thumb 没指向 thumb.png：' + alpha.thumb);
  await fs.access(alpha.thumb);
  const need = entries.find((x) => x.id === 'need-render-card');
  assert(need.thumb === null, 'needRender 条目 thumb 应为 null');
  assert(need.thumbReason && need.thumbReason.trim(), 'needRender 条目缺 thumbReason');
});

await t('video_motion_list 返回里带 thumb，且只给路径不给图', async () => {
  process.env.DSH_MOTION_LIB = root;
  process.env.DSH_SKILLS_DIR = skillsDir;
  const { motionTools } = await import('../src/motion-tools.mjs');
  const tools = motionTools({ store: {} });
  const list = tools.find((x) => x.name === 'video_motion_list');
  const result = await list.execute({}, { agent: { id: 'test-session' } });
  assert(result.count === 5, 'video_motion_list count 应为 5');
  const alpha = result.entries.find((x) => x.id === 'alpha-move');
  assert(alpha.thumb && alpha.thumb.endsWith('thumb.png'), 'video_motion_list 没带 thumb 路径');
  assert(!String(alpha.thumb).startsWith('data:'), 'thumb 不该是 dataURL');
  const need = result.entries.find((x) => x.id === 'need-render-card');
  assert(need.thumb === null && need.thumbReason, 'needRender 条目的 thumb/thumbReason 不对');
});

await t('失败的卡不会中断整批，且报告 failures 有明细', async () => {
  assert(firstReport.failures.length === 1, 'failures 应有 1 条，实际 ' + firstReport.failures.length);
  assert(firstReport.failures[0].id === 'broken-throw', '失败条目 id 不对');
  assert(firstReport.summary.rendered === 3, '同批其他卡应照常出图，rendered=' + firstReport.summary.rendered);
  const last = await readReport();
  assert(last.failures.length === 1, '后续批次失败卡也应继续被记录');
});

await fs.rm(root, { recursive: true, force: true });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
