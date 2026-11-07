/**
 * 开工阶段面板测试：`brief.state` 的只读投影 + 客户端面板接线。
 *
 *   node scripts/stage-panel-test.mjs
 *
 * 覆盖四类东西：
 * 1. **容错**——三份元数据全缺 / 坏 JSON / 结构不对，都回 200 + 能画的快照；
 * 2. **判定**——filled 与插件同义（空串、纯空白不算；{skipped:true} 与「无参考」算）；
 *    stage 以 state.json 为准，缺失才推断；state 领先事实要标 consistency；
 * 3. **只读**——调一次 RPC 之后 .dsh-video/ 里一个字节都不该变（不自愈、不建 .bak）；
 * 4. **客户端**——client.js 含 StagePanel / brief.state，client-load-test 通过。
 *
 * 测试用临时工程目录 + 临时绑定表（_bindings-guard），不碰真实工程。
 */

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { ProjectStore } from '../src/store.mjs';
import { registerVideoRoutes } from '../src/routes.mjs';

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('stage-panel');

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

const store = new ProjectStore();
registerVideoRoutes(ctx, store, () => {});

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
      this.done = true;
    },
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers || {});
    },
  };
}

const rpcRoute = () => routes.find((r) => r.path === '/api/video/rpc');

/** 打一次 RPC，**原样**返回 status + payload（不因失败就抛）。 */
async function callRaw(method, params) {
  const res = fakeRes();
  const req = fakeReq('POST', '/api/video/rpc', { method, params });
  await rpcRoute().handler(req, res);
  let payload = null;
  try {
    payload = JSON.parse(res.body);
  } catch {
    payload = null;
  }
  return { status: res.statusCode, payload };
}

/** 打一次 RPC，必须是 200 + ok:true，返回 value。 */
async function call(method, params) {
  const out = await callRaw(method, params);
  if (out.status !== 200 || !out.payload || out.payload.ok !== true) {
    throw new Error(`${method}: status=${out.status} body=${JSON.stringify(out.payload).slice(0, 200)}`);
  }
  return out.payload.value;
}

let pass = 0;
let fail = 0;
async function step(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + e.message);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-stage-panel-'));
const metaDir = path.join(root, '.dsh-video');
const SESSION = 'session-stage-panel';

async function writeMeta(name, content) {
  await fs.mkdir(metaDir, { recursive: true });
  await fs.writeFile(
    path.join(metaDir, name),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n',
    'utf8',
  );
}

async function removeMeta(name) {
  await fs.rm(path.join(metaDir, name), { force: true });
}

async function wipeMeta() {
  await fs.rm(metaDir, { recursive: true, force: true });
}

/** 十项全满但各自的答案不同；用来测「已填」的原样。 */
function fullBrief(overrides = {}) {
  return {
    version: 1,
    topic: '开工阶段面板',
    round: 2,
    slots: {
      goal: '看完能自己开一个工程',
      platform: 'B站 16:9',
      duration: '45 秒',
      audience: '会剪片但没时间写分镜的人',
      tone: '克制、专业',
      pace: '2.5 秒一个镜头',
      deliverable: 'MP4 1080p30',
      visual: '图文 + 实拍混剪',
      reference: { kind: 'references', count: 3, paths: ['refs/a.png', 'refs/b.png', 'refs/c.png'] },
      taboo: '不出现真人正脸',
      ...overrides,
    },
  };
}

const FULL_SPEC = {
  tone: '克制、专业，不喊口号',
  palette: ['#0B0B0F', '#7C5CFF'],
  font: '思源黑体 Medium',
  density: 'med',
  pace: 2.5,
};

let projectId = null;

await step('建一个临时工程（后续 RPC 都打它）', async () => {
  const v = await call('project.open', { dir: root, sessionId: SESSION });
  projectId = v.doc.projectId;
  assert(projectId, 'no projectId');
});

// ---------------------------------------------------------------- 1. 三缺 ----

await step('三份元数据全缺 → idle + inferred，且不抛（HTTP 200）', async () => {
  await wipeMeta();
  const out = await callRaw('brief.state', { projectId, sessionId: SESSION });
  assert(out.status === 200, 'status=' + out.status);
  assert(out.payload && out.payload.ok === true, 'ok!=true');
  const v = out.payload.value;
  assert(v.stage === 'idle', 'stage=' + v.stage);
  assert(v.stageSource === 'inferred', 'stageSource=' + v.stageSource);
  assert(v.briefReady === false, 'briefReady 应是 false');
  assert(v.filled === 0 && v.total === 10, `filled/total=${v.filled}/${v.total}`);
  assert(v.slots.length === 10, 'slots=' + v.slots.length);
  assert(v.style === null, 'style 应是 null');
  assert(Array.isArray(v.blocked) && v.blocked.length > 0, 'blocked 应列出被拦住的类别');
  assert(typeof v.nextStep === 'string' && v.nextStep.length > 0, 'nextStep 为空');
  assert(v.warnings.length >= 1, '三缺至少要有一条 warning');
});

// ------------------------------------------------------------ 2. 坏 JSON ----

await step('brief.json 坏了 → 字段降级 + warning，RPC 仍 200', async () => {
  await wipeMeta();
  await writeMeta('brief.json', '{ 这不是 JSON');
  const out = await callRaw('brief.state', { projectId, sessionId: SESSION });
  assert(out.status === 200, 'status=' + out.status);
  const v = out.payload.value;
  assert(v.filled === 0, '坏 brief 应算 0 项');
  assert(
    v.warnings.some((w) => w.includes('brief.json')),
    '缺少 brief.json 的 warning：' + JSON.stringify(v.warnings),
  );
});

await step('state.json 坏了 → stage 推断 + warning（其余字段照常可用）', async () => {
  await wipeMeta();
  await writeMeta('brief.json', fullBrief());
  await writeMeta('style.json', 'not json at all');
  const v = await call('brief.state', { projectId, sessionId: SESSION });
  assert(v.stageSource === 'inferred', 'stageSource=' + v.stageSource);
  assert(v.stage === 'style', 'brief 满 + 风格未确认应推断为 style，实际 ' + v.stage);
  assert(v.filled === 10 && v.briefReady === true, `filled=${v.filled}`);
  assert(
    v.warnings.some((w) => w.includes('state.json')) && v.warnings.some((w) => w.includes('style.json')),
    'warning 没覆盖两份坏文件：' + JSON.stringify(v.warnings),
  );
});

await step('state.json 结构不是对象 → 不抛，按事实推断', async () => {
  await wipeMeta();
  await writeMeta('brief.json', fullBrief());
  await writeMeta('state.json', '[1,2,3]');
  const v = await call('brief.state', { projectId, sessionId: SESSION });
  assert(v.stageSource === 'inferred', 'stageSource=' + v.stageSource);
  assert(v.stage === 'style', 'stage=' + v.stage);
});

// ------------------------------------------------------------ 3. filled ----

await step('filled 判定：空白算未填，{skipped:true} 与「无参考」算已填', async () => {
  await wipeMeta();
  await writeMeta(
    'brief.json',
    {
      version: 1,
      slots: {
        goal: '   ',
        platform: '\n\t ',
        duration: '30 秒',
        audience: '',
        tone: '克制',
        pace: '快',
        deliverable: 'MP4',
        visual: '图文',
        reference: { skipped: true, reason: '没找到合适的' },
        taboo: '无参考',
      },
    },
  );
  const v = await call('brief.state', { projectId, sessionId: SESSION });
  const filled = Object.fromEntries(v.slots.map((s) => [s.id, s.filled]));
  assert(filled.goal === false, '纯空白的 goal 应算未填');
  assert(filled.platform === false, '空白字符的 platform 应算未填');
  assert(filled.audience === false, '空串的 audience 应算未填');
  assert(filled.reference === true, '{skipped:true} 的 reference 应算已填');
  assert(filled.taboo === true, '「无参考」的文本应算已填（非空文本就是答案）');
  assert(v.filled === 7, 'filled 应为 7，实际 ' + v.filled);
  assert(v.briefReady === false, '8/10 不该 ready');
});

await step('「无参考」这类显式答案在面板上显示成一句话', async () => {
  await wipeMeta();
  await writeMeta('brief.json', { version: 1, slots: { reference: '无所谓' } });
  let v = await call('brief.state', { projectId, sessionId: SESSION });
  assert(v.slots.find((s) => s.id === 'reference').filled === true, 'reference 未填');
  await writeMeta('brief.json', { version: 1, slots: { reference: { skipped: true } } });
  v = await call('brief.state', { projectId, sessionId: SESSION });
  const slot = v.slots.find((s) => s.id === 'reference');
  assert(slot.value === '无参考', 'reference 应显示「无参考」，实际 ' + JSON.stringify(slot.value));
});

// -------------------------------------------------- 4. state 为准 / 领先 ----

await step('state.json 存在时以它为准（stageSource=state，since 透出）', async () => {
  await wipeMeta();
  await writeMeta('brief.json', fullBrief());
  await writeMeta('style.json', {
    confirmed: true,
    spec: FULL_SPEC,
    confirmedAt: '2026-11-06T07:00:00.000Z',
    preview: { keyframes: [], clip: null },
  });
  await writeMeta('state.json', {
    stage: 'build',
    since: '2026-11-06T07:05:00.000Z',
    history: [{ stage: 'build', at: '2026-11-06T07:05:00.000Z', by: 'tool' }],
  });
  const v = await call('brief.state', { projectId, sessionId: SESSION });
  assert(v.stage === 'build', 'stage=' + v.stage);
  assert(v.stageSource === 'state', 'stageSource=' + v.stageSource);
  assert(v.since === '2026-11-06T07:05:00.000Z', 'since=' + v.since);
  assert(v.consistency === undefined, '事实齐了不该有 consistency');
});

await step('state 领先事实（brief 9 项却 locked）→ consistency 标记 + warning', async () => {
  await wipeMeta();
  const brief = fullBrief();
  brief.slots.taboo = '   ';
  await writeMeta('brief.json', brief);
  await writeMeta('state.json', {
    stage: 'locked',
    since: '2026-11-06T07:00:00.000Z',
    history: [{ stage: 'locked', at: '2026-11-06T07:00:00.000Z', by: 'tool' }],
  });
  const v = await call('brief.state', { projectId, sessionId: SESSION });
  assert(v.consistency === 'state-ahead-of-facts', 'consistency=' + v.consistency);
  assert(v.stage === 'locked', 'stage 仍以 state 为准，实际 ' + v.stage);
  assert(v.briefReady === false, '9/10 不该 ready');
  assert(
    v.warnings.some((w) => w.includes('领先')),
    '缺少领先于事实的 warning：' + JSON.stringify(v.warnings),
  );
  assert(
    v.nextStep.includes('video_stage_get'),
    'nextStep 应指向 video_stage_get 自愈：' + v.nextStep,
  );
});

await step('stage 缺失但 brief 满 + 风格未确认 → inferred=style', async () => {
  await wipeMeta();
  await writeMeta('brief.json', fullBrief());
  const v = await call('brief.state', { projectId, sessionId: SESSION });
  assert(v.stage === 'style', 'stage=' + v.stage);
  assert(v.stageSource === 'inferred', 'stageSource=' + v.stageSource);
  assert(v.briefReady === true, 'briefReady 应为 true');
  assert(
    v.nextStep.includes('video_style_confirm'),
    'nextStep 应让 agent 确认风格：' + v.nextStep,
  );
});

await step('非法 stage 名 → 不抛，按事实推断并给 warning', async () => {
  await wipeMeta();
  await writeMeta('brief.json', { version: 1, slots: { goal: '随便' } });
  await writeMeta('state.json', { stage: 'drafting', since: 'x', history: [] });
  const v = await call('brief.state', { projectId, sessionId: SESSION });
  assert(v.stageSource === 'inferred', 'stageSource=' + v.stageSource);
  assert(v.stage === 'clarify', 'stage=' + v.stage);
});

await step('history 里坏条目被丢掉，好条目保留（面板悬停用）', async () => {
  await wipeMeta();
  await writeMeta('state.json', {
    stage: 'clarify',
    since: '2026-11-06T06:00:00.000Z',
    history: [
      { stage: 'idle', at: '2026-11-06T05:00:00.000Z', by: 'tool' },
      { stage: 'not-a-stage', at: '2026-11-06T05:30:00.000Z' },
      null,
      'garbage',
      { stage: 'clarify', at: '2026-11-06T06:00:00.000Z', by: 'user' },
    ],
  });
  const v = await call('brief.state', { projectId, sessionId: SESSION });
  assert(v.history.length === 2, 'history=' + JSON.stringify(v.history));
  assert(v.history[0].stage === 'idle' && v.history[1].stage === 'clarify', 'history 顺序不对');
  assert(v.history[1].by === 'user', 'by 丢了');
});

// -------------------------------------------------------------- 5. style ----

await step('style.json 透出 spec / 关键帧 / 样片 / confirmedAt', async () => {
  await wipeMeta();
  await writeMeta('brief.json', fullBrief());
  await writeMeta('style.json', {
    confirmed: true,
    spec: FULL_SPEC,
    confirmedAt: '2026-11-06T07:00:00.000Z',
    preview: {
      keyframes: ['.dsh-video/style-preview/frames/1-hook.png', '.dsh-video/style-preview/frames/2-point.png'],
      clip: '.dsh-video/style-preview/preview-8s.mp4',
    },
  });
  const v = await call('brief.state', { projectId, sessionId: SESSION });
  assert(v.style && v.style.confirmed === true, 'style 没透出');
  assert(v.style.spec.tone === FULL_SPEC.tone, 'tone=' + v.style.spec.tone);
  assert(v.style.spec.pace === 2.5, 'pace=' + v.style.spec.pace);
  assert(v.style.preview.keyframes.length === 2, 'keyframes=' + v.style.preview.keyframes.length);
  assert(v.style.preview.clip === '.dsh-video/style-preview/preview-8s.mp4', 'clip=' + v.style.preview.clip);
  assert(v.style.confirmedAt === '2026-11-06T07:00:00.000Z', 'confirmedAt=' + v.style.confirmedAt);
  assert(v.stage === 'locked', 'brief 满 + 风格确认应推断 locked，实际 ' + v.stage);
});

await step('未确认 / spec 不合法的 style.json → style=null + warning', async () => {
  await wipeMeta();
  await writeMeta('brief.json', fullBrief());
  await writeMeta('style.json', { confirmed: false, spec: FULL_SPEC });
  const v = await call('brief.state', { projectId, sessionId: SESSION });
  assert(v.style === null, '未确认的 style 应回 null');
  assert(
    v.warnings.some((w) => w.includes('style.json')),
    '缺少 style 未确认的 warning',
  );
});

// --------------------------------------------------------- 6. 路径越界 ----

await step('preview 路径越界 / 绝对路径 / 盘符 → 被过滤 + warning', async () => {
  await wipeMeta();
  await writeMeta('brief.json', fullBrief());
  await writeMeta('style.json', {
    confirmed: true,
    spec: FULL_SPEC,
    confirmedAt: '2026-11-06T07:00:00.000Z',
    preview: {
      keyframes: [
        '../../etc/passwd',
        '/abs/kf.png',
        '~\\kf.png',
        'https://example.com/kf.png',
        '.dsh-video/style-preview/frames/1-hook.png',
        'preview/kf-2.png',
      ],
      clip: '../../outside.mp4',
    },
  });
  const v = await call('brief.state', { projectId, sessionId: SESSION });
  const frames = v.style.preview.keyframes;
  assert(frames.length === 2, 'keyframes=' + JSON.stringify(frames));
  assert(
    frames.every((p) => !p.includes('..') && !path.isAbsolute(p)),
    '过滤后仍有越界路径：' + JSON.stringify(frames),
  );
  assert(frames[0] === '.dsh-video/style-preview/frames/1-hook.png', '合法路径被误删');
  assert(v.style.preview.clip === null, '越界 clip 应被过滤成 null，实际 ' + v.style.preview.clip);
  assert(
    v.warnings.some((w) => w.includes('过滤')),
    '缺少路径被过滤的 warning：' + JSON.stringify(v.warnings),
  );
});

// ------------------------------------------------------------- 7. 只读 ----

await step('只读：调一次 RPC 后 .dsh-video/ 里的文件一个字节都没变', async () => {
  await wipeMeta();
  await writeMeta('brief.json', fullBrief());
  await writeMeta('state.json', { stage: 'idle', since: '2026-11-06T06:00:00.000Z', history: [] });
  const before = {};
  for (const name of await fs.readdir(metaDir)) {
    before[name] = await fs.readFile(path.join(metaDir, name), 'utf8');
  }
  await call('brief.state', { projectId, sessionId: SESSION });
  const after = {};
  for (const name of await fs.readdir(metaDir)) {
    after[name] = await fs.readFile(path.join(metaDir, name), 'utf8');
  }
  assert(
    JSON.stringify(Object.keys(before).sort()) === JSON.stringify(Object.keys(after).sort()),
    '文件列表变了（可能写了 .bak 或新文件）：' + JSON.stringify(Object.keys(after)),
  );
  for (const name of Object.keys(before)) {
    assert(before[name] === after[name], name + ' 内容被改了（面板不该自愈写盘）');
  }
});

await step('未知 projectId → 400 REF_NOT_FOUND（不是 500）', async () => {
  const out = await callRaw('brief.state', { projectId: 'no-such-project', sessionId: SESSION });
  assert(out.status === 400, 'status=' + out.status);
  assert(out.payload && out.payload.ok === false, 'ok 应为 false');
  assert(out.payload.error.code === 'REF_NOT_FOUND', 'code=' + out.payload.error.code);
});

// ------------------------------------------------------------ 8. 客户端 ----

await step('client.js 含 StagePanel 与 brief.state（面板真的进了 bundle）', async () => {
  const code = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert(code.includes('StagePanel'), 'bundle 里没有 StagePanel');
  assert(code.includes('brief.state'), 'bundle 里没有 brief.state 调用');
  // esbuild 默认把中文转成 \uXXXX（大写十六进制），所以标题两种形态都认。
  const titleOk = code.includes('开工阶段') || code.includes('\\u5F00\\u5DE5\\u9636\\u6BB5');
  assert(titleOk, 'bundle 里没有面板标题');
});

await step('client-load-test 通过（模块能装进 __ModuleLoader__）', async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = execFileSync(process.execPath, ['scripts/client-load-test.mjs'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  assert(out.includes('client load test passed'), 'client-load 输出异常：' + out.slice(0, 200));
});

await fs.rm(root, { recursive: true, force: true });
cleanupBindings();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
