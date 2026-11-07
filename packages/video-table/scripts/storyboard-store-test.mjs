/**
 * 分镜落盘与落地测试。
 *
 *   node scripts/storyboard-store-test.mjs
 *
 * 覆盖：空工程读默认、写后读回、坏 JSON 不崩、严格校验、apply 片段数、
 * clipId 回写、非空工程被拒、force 追加、动效缺失跳过、RPC 三个方法。
 */

import { useTempBindings } from './_bindings-guard.mjs';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultStoryboard,
  readStoryboard,
  writeStoryboard,
  storyboardPath,
} from '../src/storyboard-store.mjs';
import { storyboardTools } from '../src/storyboard-tools.mjs';
import { ProjectStore } from '../src/store.mjs';
import { registerVideoRoutes } from '../src/routes.mjs';

// 绑定表与动效库都放临时目录：不碰用户真实的 ~/.dsh / ~/.agents
const cleanupBindings = useTempBindings('storyboard-store');
const bindings = process.env.DSH_VIDEO_BINDINGS;

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-sbstore-'));
const motionRoot = path.join(tmpRoot, 'motion-lib');
const skillsRoot = path.join(tmpRoot, 'skills');
process.env.DSH_MOTION_LIB = motionRoot;
process.env.DSH_SKILLS_DIR = skillsRoot;

// 两首动效：一个原生（有 code.js），一个只有说明文档（needRender）
const CODE = 'export function render(ctx, t) { ctx.fillStyle = "#fff"; ctx.fillText("count", 40, 40); }\n';
for (const id of ['light-spotlight-render', 'count-up']) {
  await fs.mkdir(path.join(motionRoot, id), { recursive: true });
  await fs.writeFile(path.join(motionRoot, id, 'code.js'), CODE, 'utf8');
}
await fs.mkdir(path.join(motionRoot, 'claude-typer'), { recursive: true });
await fs.writeFile(path.join(motionRoot, 'claude-typer', 'SKILL.md'), '---\nname: claude-typer\n---\n说明\n', 'utf8');
await fs.mkdir(skillsRoot, { recursive: true });

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

async function mustThrow(fn, code, keyword) {
  let error = null;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  if (!error) throw new Error('应当抛错，但没有抛');
  if (code && error.code !== code) throw new Error(`错误码应为 ${code}，实际是 ${error.code}：${error.message}`);
  if (keyword && !String(error.message).includes(keyword)) {
    throw new Error(`错误信息应包含「${keyword}」，实际是：${error.message}`);
  }
  if (!/[\u4e00-\u9fff]/.test(String(error.message))) throw new Error('错误信息应该是中文：' + error.message);
  return error;
}

const SRT =
  '1\n00:00:00,000 --> 00:00:03,000\n先说结论。\n\n' +
  '2\n00:00:03,000 --> 00:00:06,000\n转化率是 87%。\n\n' +
  '3\n00:00:06,000 --> 00:00:09,000\n最后收个尾。\n';

// ---------------------------------------------------------------- 存储层 ----

console.log('storyboard-store');

await t('空工程读到的就是默认空文档，没有 warning', async () => {
  const root = await fs.mkdtemp(path.join(tmpRoot, 'empty-'));
  const read = await readStoryboard(root);
  must(read.exists === false, '不应认为文件存在');
  must(read.warning == null, '不该有 warning：' + read.warning);
  must(read.doc.version === 1, 'version 应为 1');
  must(Array.isArray(read.doc.shots) && read.doc.shots.length === 0, 'shots 应为空数组');
  must(read.doc.source === 'manual', '默认 source 应为 manual');
  must(read.doc.updatedAt == null, '从未落盘就没有更新时间');
});

await t('写进去之后能原样读回（含 index 重排与时间取整）', async () => {
  const root = await fs.mkdtemp(path.join(tmpRoot, 'roundtrip-'));
  const doc = {
    version: 1,
    updatedAt: null,
    source: 'srt',
    shots: [
      { index: 9, start: 3, end: 6.0004, text: '第二段', kind: 'point', suggestedEffect: 'none', reason: 'r2', clipId: null },
      { index: 9, start: 0, end: 3, text: '第一段', kind: 'hook', suggestedEffect: 'count-up', reason: 'r1', clipId: 'c0' },
    ],
  };
  const written = await writeStoryboard(root, doc);
  must(written.path === path.join(root, 'storyboard.json'), '路径不对：' + written.path);
  must(typeof written.doc.updatedAt === 'string' && written.doc.updatedAt.includes('T'), '写盘应补 ISO 时间');
  const read = await readStoryboard(root);
  must(read.exists === true && read.warning == null, '应正常读回');
  must(read.doc.shots.length === 2, '镜头数应为 2');
  must(read.doc.shots[0].text === '第一段', '应按时间排序，首镜是第一段');
  must(read.doc.shots[0].index === 1 && read.doc.shots[1].index === 2, 'index 应按时间重排');
  must(read.doc.shots[1].end === 6, 'end 应取整到 3 位小数');
  must(read.doc.shots[0].clipId === 'c0', 'clipId 应保留');
});

await t('坏 JSON 不崩：返回默认文档 + warning', async () => {
  const root = await fs.mkdtemp(path.join(tmpRoot, 'broken-'));
  await fs.writeFile(path.join(root, 'storyboard.json'), '{ 这不是 JSON', 'utf8');
  const read = await readStoryboard(root);
  must(read.doc.shots.length === 0, '坏文件应退化成空分镜');
  must(typeof read.warning === 'string' && read.warning.includes('JSON'), 'warning 应说明是 JSON 问题：' + read.warning);
});

await t('写入严格校验：时间倒挂抛中文 INVALID_ARG', async () => {
  const root = await fs.mkdtemp(path.join(tmpRoot, 'strict-'));
  await mustThrow(
    () => writeStoryboard(root, { version: 1, source: 'manual', shots: [{ start: 5, end: 3, text: '反的' }] }),
    'INVALID_ARG',
    'end',
  );
});

await t('空 root 与越界路径都被挡掉', async () => {
  await mustThrow(() => storyboardPath(''), 'INVALID_ARG', 'root');
});

// ------------------------------------------------------------ 工具与落地 ----

console.log('storyboardTools');

const SESSION = 'session-sb-store';
const store = new ProjectStore();
const root = await fs.mkdtemp(path.join(tmpRoot, 'project-'));
const doc = await store.open(root, SESSION);
const tools = Object.fromEntries(storyboardTools({ store }).map((tool) => [tool.name, tool]));
const exec = { agent: { id: SESSION } };

async function readDoc() {
  return (await readStoryboard(root)).doc;
}

await t('save：生成分镜并写盘，返回 path/count/shots', async () => {
  const out = await tools.video_storyboard_save.execute({ srt: SRT }, exec);
  must(out.saved === true, 'saved 应为 true');
  must(out.count === 3, '应切出 3 镜，实际 ' + out.count);
  must(out.path === path.join(root, 'storyboard.json'), 'path 不对：' + out.path);
  must(out.shots.every((s) => s.clipId === null), '新保存的分镜 clipId 应为 null');
  const onDisk = await readDoc();
  must(onDisk.shots.length === 3, '磁盘上应有 3 镜');
  must(onDisk.source === 'srt', 'source 应为 srt');
  const kinds = onDisk.shots.map((s) => s.kind).join(',');
  must(kinds === 'hook,evidence,outro', '镜头类型不对：' + kinds);
});

await t('read：读回的就是落盘的那一份', async () => {
  const out = await tools.video_storyboard_read.execute({}, exec);
  must(out.exists === true, '文件应存在');
  must(out.count === 3, 'count 应为 3');
  must(out.doc.shots[1].suggestedEffect === 'count-up', '数字镜应建议 count-up');
  must(out.warning == null, '不该有 warning');
});

await t('apply：一次事务落地，v1 片段数与镜头数一致', async () => {
  const out = await tools.video_storyboard_apply.execute({}, exec);
  must(out.applied === true, 'applied 应为 true');
  must(out.count === 3, 'count 应为 3');
  const fresh = store.get(doc.projectId).doc;
  const v1 = fresh.clips.filter((c) => c.trackId === 'v1');
  const v2 = fresh.clips.filter((c) => c.trackId === 'v2');
  must(v1.length === 3, 'v1 应有 3 个占位片段，实际 ' + v1.length);
  must(v1.every((c) => c.type === 'text'), '占位片段应是 text');
  must(v1[0].text === '先说结论。', '首镜文字不对：' + v1[0].text);
  must(v2.length === 2, 'v2 应有 2 个动效图层，实际 ' + v2.length);
  must(v2.every((c) => c.type === 'code'), 'v2 应是 code 片段');
  const layerFiles = await fs.readdir(path.join(root, 'code'));
  must(layerFiles.includes('motion-count-up'), '应为 count-up 写一份代码图层');
  must(out.revision === fresh.revision, '返回的 revision 应是最新版本');
});

await t('apply：clipId 回写到 storyboard.json，且都指向真实片段', async () => {
  const board = await readDoc();
  const fresh = store.get(doc.projectId).doc;
  const ids = new Set(fresh.clips.map((c) => c.id));
  for (const shot of board.shots) {
    must(typeof shot.clipId === 'string' && shot.clipId, `第 ${shot.index} 镜没有回写 clipId`);
    must(ids.has(shot.clipId), `第 ${shot.index} 镜的 clipId ${shot.clipId} 在时间线上不存在`);
  }
});

await t('非空工程再次 apply 被拒（INVALID_OP，提示先清空或换新工程）', async () => {
  await mustThrow(() => tools.video_storyboard_apply.execute({}, exec), 'INVALID_OP', '请先清空或换新工程');
  const fresh = store.get(doc.projectId).doc;
  must(fresh.clips.length === 5, '被拒时不应改动时间线，实际片段数 ' + fresh.clips.length);
});

// force 需要一个「已有片段但不重叠」的工程
await t('force=true 在已有时间线上追加', async () => {
  const forceRoot = await fs.mkdtemp(path.join(tmpRoot, 'force-'));
  const forceSession = 'session-sb-force';
  const forceStore = new ProjectStore();
  const forceDoc = await forceStore.open(forceRoot, forceSession);
  const forceTools = Object.fromEntries(storyboardTools({ store: forceStore }).map((tool) => [tool.name, tool]));
  const forceExec = { agent: { id: forceSession } };

  // 先放一个 10–11 秒的片段：和分镜的 0–9 秒不重叠
  const p = forceStore.preview(forceDoc.projectId, forceSession, undefined, [
    { type: 'clip.insert', clipId: 'keep1', trackId: 'v1', clipType: 'text', start: 10, duration: 1, text: '原有的' },
  ]);
  await forceStore.applyPreview(p.previewId, forceSession);

  await forceTools.video_storyboard_save.execute({ srt: SRT }, forceExec);
  await mustThrow(() => forceTools.video_storyboard_apply.execute({}, forceExec), 'INVALID_OP', 'force=true');
  const out = await forceTools.video_storyboard_apply.execute({ options: { force: true } }, forceExec);
  must(out.applied === true, 'force 应允许追加');
  const fresh = forceStore.get(forceDoc.projectId).doc;
  const v1 = fresh.clips.filter((c) => c.trackId === 'v1');
  must(v1.length === 4, 'v1 应是 1 个原有 + 3 个占位，实际 ' + v1.length);
  must(v1.some((c) => c.id === 'keep1'), '原有片段不应被删');
});

await t('动效条目缺失时跳过并记 warning，其余镜头照常落地', async () => {
  const missRoot = await fs.mkdtemp(path.join(tmpRoot, 'missing-'));
  const missSession = 'session-sb-missing';
  const missStore = new ProjectStore();
  const missDoc = await missStore.open(missRoot, missSession);
  const missTools = Object.fromEntries(storyboardTools({ store: missStore }).map((tool) => [tool.name, tool]));

  // 手工写一份分镜：第二镜要一个库里没有的动效，第三镜要一个只有文档的动效
  await writeStoryboard(missRoot, {
    version: 1,
    source: 'manual',
    shots: [
      { start: 0, end: 3, text: '开场', kind: 'hook', suggestedEffect: 'scanline-glint', reason: '' },
      { start: 3, end: 6, text: '中段', kind: 'point', suggestedEffect: 'claude-typer', reason: '' },
      { start: 6, end: 9, text: '收尾', kind: 'outro', suggestedEffect: 'none', reason: '' },
    ],
  });

  const out = await missTools.video_storyboard_apply.execute({}, { agent: { id: missSession } });
  must(out.applied === true, 'applied 应为 true');
  must(out.effects.length === 0, '一个动效都不该插');
  must(out.skippedEffects.length === 2, '应跳过 2 个动效，实际 ' + out.skippedEffects.length);
  must(out.warnings.some((w) => w.includes('scanline-glint')), 'warning 应点名缺失的动效');
  must(out.warnings.some((w) => w.includes('claude-typer')), 'warning 应点名只能外部渲染的动效');
  const fresh = missStore.get(missDoc.projectId).doc;
  must(fresh.clips.filter((c) => c.trackId === 'v1').length === 3, 'v1 仍应有 3 个占位片段');
  must(fresh.clips.filter((c) => c.trackId === 'v2').length === 0, '缺动效时 v2 不应有片段');
});

// ------------------------------------------------------------------ RPC ----

console.log('RPC');

const routes = [];
const rpcCtx = {
  webServer: { register: (route) => { routes.push(route); return () => {}; } },
  get: () => undefined,
};
const rpcStore = new ProjectStore();
registerVideoRoutes(rpcCtx, rpcStore, () => {});
const rpcRoute = routes.find((r) => r.path === '/api/video/rpc');

function fakeReq(body) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/api/video/rpc';
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
    end(chunk) { if (chunk) this.body += chunk; this.done = true; },
  };
}

async function call(method, params) {
  const res = fakeRes();
  await rpcRoute.handler(fakeReq({ method, params }), res);
  const payload = JSON.parse(res.body);
  if (!payload.ok) throw new Error(`${method}: ${payload.error.code} ${payload.error.message}`);
  return payload.value;
}

const rpcRoot = await fs.mkdtemp(path.join(tmpRoot, 'rpc-'));
const RPC_SESSION = 'session-sb-rpc';
let rpcProjectId = null;

await t('RPC project.open 后 storyboard.save / read / apply 三个方法都通', async () => {
  const opened = await call('project.open', { dir: rpcRoot, sessionId: RPC_SESSION });
  rpcProjectId = opened.doc.projectId;

  const saved = await call('storyboard.save', { projectId: rpcProjectId, sessionId: RPC_SESSION, srt: SRT });
  must(saved.saved === true && saved.count === 3, 'save 结果不对：' + JSON.stringify(saved).slice(0, 120));

  const read = await call('storyboard.read', { projectId: rpcProjectId, sessionId: RPC_SESSION });
  must(read.count === 3 && read.exists === true, 'read 结果不对');

  const applied = await call('storyboard.apply', {
    projectId: rpcProjectId,
    sessionId: RPC_SESSION,
    baseRevision: opened.doc.revision,
  });
  must(applied.applied === true, 'apply 结果不对');
  must(applied.count === 3, 'apply 应落地 3 镜');
});

await t('RPC storyboard.read 缺 sessionId 时报中文 INVALID_ARG', async () => {
  const res = fakeRes();
  await rpcRoute.handler(fakeReq({ method: 'storyboard.read', params: { projectId: rpcProjectId } }), res);
  const payload = JSON.parse(res.body);
  must(payload.ok === false, '应失败');
  must(payload.error.code === 'INVALID_ARG', '错误码应为 INVALID_ARG，实际 ' + payload.error.code);
  must(/[\u4e00-\u9fff]/.test(payload.error.message), '错误信息应为中文');
});

await fs.rm(tmpRoot, { recursive: true, force: true });
cleanupBindings();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
