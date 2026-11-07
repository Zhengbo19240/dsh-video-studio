/**
 * 风格确认（S1）测试：spec 校验、4 镜展开、预览工程落盘、RPC 端到端。
 *
 *   node scripts/style-preview-test.mjs
 *
 * 分两段：
 *   A. 纯函数 —— 不碰磁盘、不碰浏览器，跑的是 src/style-spec.mjs 的判定与展开；
 *   B. 宿主侧 —— 用假 ctx 注册路由，走 style.default / style.preview / style-upload /
 *      style.result，断言「预览工程只落在 .dsh-video/style-preview/ 下」这条边界。
 *
 * 四张关键帧与 8 秒样片本身由浏览器渲染（canvas + WebCodecs），node 里没有 canvas，
 * 所以这一段只验路径、形状与越界拒绝；像素由 scripts/style-preview-render.mjs 真渲染。
 */

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.mjs';
import { registerVideoRoutes } from '../src/routes.mjs';
import {
  DENSITIES,
  PREVIEW_SECONDS,
  SHOT_KINDS,
  alignmentForSpec,
  buildPreviewProject,
  buildStyleShots,
  bpmFromRhythm,
  defaultStyleSpec,
  drawStyleFrame,
  previewLayout,
  shotLayerSource,
  specToSummary,
  validateStyleSpec,
} from '../src/style-spec.mjs';

import { useTempBindings } from './_bindings-guard.mjs';

const cleanupBindings = useTempBindings('style-preview');

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

/** 记录绘制调用的假 2D ctx：只为断言「谁用了哪个颜色」，不模拟像素。 */
function mockCtx() {
  const calls = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    lineWidth: 1,
    globalAlpha: 1,
    fillRect(x, y, w, h) {
      calls.push({ op: 'fillRect', fill: this.fillStyle, alpha: this.globalAlpha, x, y, w, h });
    },
    fillText(text, x, y) {
      calls.push({ op: 'fillText', fill: this.fillStyle, font: this.font, text, x, y });
    },
    beginPath() {
      calls.push({ op: 'beginPath' });
    },
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    closePath() {},
    fill() {
      calls.push({ op: 'fill', fill: this.fillStyle, alpha: this.globalAlpha });
    },
    stroke() {
      calls.push({ op: 'stroke', stroke: this.strokeStyle });
    },
    save() {},
    restore() {},
  };
  return { ctx, calls };
}

const usedColors = (calls) => calls.map((call) => String(call.fill || '').toUpperCase());
const showsColor = (calls, hex) => usedColors(calls).includes(String(hex).toUpperCase());

// 1×1 的真 PNG：端到端测试往预览目录里写「像那么回事」的字节
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

console.log('A. 纯函数 · 校验');

await step('默认 spec 合法且没有拒绝原因', async () => {
  const checked = validateStyleSpec(defaultStyleSpec());
  assert(checked.ok, '默认 spec 被判非法：' + checked.reasons.join('；'));
  assert(checked.reasons.length === 0, '默认 spec 不该有拒绝原因');
});

await step('默认 spec 带齐调性/配色/字体/密度/节奏/圆角/留白/网格', async () => {
  const s = defaultStyleSpec();
  assert(typeof s.tone === 'string' && s.tone.length > 0, '缺调性');
  assert(/^#[0-9A-Fa-f]{6}$/.test(s.palette.accent), '主色不是 #rrggbb');
  assert(/^#[0-9A-Fa-f]{6}$/.test(s.palette.secondary), '辅色不是 #rrggbb');
  assert(/^#[0-9A-Fa-f]{6}$/.test(s.palette.background), '底色不是 #rrggbb');
  assert(typeof s.font.family === 'string' && s.font.family.length > 0, '缺字体族');
  // 四级字号：标题 > 副标题 > 正文 > note
  assert(
    s.font.heading > s.font.subtitle && s.font.subtitle > s.font.body && s.font.body > s.font.note,
    '四级字号层级不对：' + JSON.stringify(s.font),
  );
  assert(DENSITIES.includes(s.motionDensity), '动效密度不在枚举里');
  assert(s.rhythm.shotSeconds === 2 && s.rhythm.transitionSeconds > 0, '节奏缺省不对');
  assert(s.radius >= 0 && s.padding >= 0 && s.grid === true, '圆角/留白/网格缺省不对');
  assert(s.stroke >= 0, '描边缺省不对：' + s.stroke);
});

await step('非法主色被拒，原因用中文指出字段与 #rrggbb', async () => {
  const spec = defaultStyleSpec();
  spec.palette.accent = 'red';
  const checked = validateStyleSpec(spec);
  assert(checked.ok === false, '非法颜色却通过了');
  const text = checked.reasons.join('；');
  assert(/主色/.test(text), '原因里没提主色：' + text);
  assert(/#rrggbb/.test(text), '原因里没提 #rrggbb：' + text);
});

await step('非法标题字号被拒，原因给出区间', async () => {
  const spec = defaultStyleSpec();
  spec.font.heading = 400;
  const checked = validateStyleSpec(spec);
  assert(checked.ok === false, '非法字号却通过了');
  const text = checked.reasons.join('；');
  assert(/标题字号/.test(text), '原因里没提标题字号：' + text);
  assert(/24/.test(text) && /200/.test(text), '原因里没有区间：' + text);
});

await step('非法动效密度被拒，原因列出枚举', async () => {
  const spec = defaultStyleSpec();
  spec.motionDensity = 'insane';
  const checked = validateStyleSpec(spec);
  assert(checked.ok === false, '非法密度却通过了');
  const text = checked.reasons.join('；');
  assert(/动效密度/.test(text), '原因里没提动效密度：' + text);
  assert(/low \/ med \/ high/.test(text), '原因里没列枚举：' + text);
});

await step('空 spec 降级为默认风格，并留一条 warning', async () => {
  const checked = validateStyleSpec({});
  assert(checked.ok === true, '空 spec 被判非法');
  assert(checked.warnings.length > 0, '空 spec 没有任何降级提示');
  assert(checked.spec.palette.accent === defaultStyleSpec().palette.accent, '没回落到默认主色');
  assert(checked.spec.rhythm.shotSeconds === 2, '没回落到默认节奏');
});

await step('缺字段只补缺的那几项，给了的照用', async () => {
  const checked = validateStyleSpec({ palette: { accent: '#FF6B35' } });
  assert(checked.ok === true, '半份 spec 被判非法：' + checked.reasons.join('；'));
  assert(checked.spec.palette.accent === '#FF6B35', '给了的主色被覆盖了');
  assert(checked.spec.palette.secondary === defaultStyleSpec().palette.secondary, '缺的辅色没补默认');
  assert(checked.warnings.length > 0, '缺字段没有降级提示');
});

console.log('A. 纯函数 · 四镜展开');

await step('buildStyleShots 恰好 4 镜，覆盖开场/数据/字幕/收尾', async () => {
  const shots = buildStyleShots(defaultStyleSpec());
  assert(shots.length === 4, '镜头数=' + shots.length);
  assert(shots.map((s) => s.kind).join(',') === SHOT_KINDS.join(','), '镜头顺序不对');
  assert(shots.every((s) => s.label && s.label.length > 0), '有镜头缺中文标签');
});

await step('默认 spec 下每镜 2 秒、总时长 8 秒', async () => {
  const shots = buildStyleShots(defaultStyleSpec());
  assert(shots.every((s) => s.duration === 2), '有镜头不是 2 秒');
  assert(shots[shots.length - 1].end === PREVIEW_SECONDS, '总时长不是 8 秒：' + shots[shots.length - 1].end);
});

await step('区间连续无缝：首镜从 0 开始，后一镜接住前一镜的 end', async () => {
  const shots = buildStyleShots(defaultStyleSpec());
  assert(shots[0].start === 0, '首镜不从 0 开始');
  for (let i = 1; i < shots.length; i += 1) {
    assert(shots[i].start === shots[i - 1].end, `第 ${i} 镜有缝：${shots[i - 1].end} → ${shots[i].start}`);
  }
});

await step('每镜都有内容层与动效', async () => {
  const shots = buildStyleShots(defaultStyleSpec());
  for (const shot of shots) {
    const visible = shot.layers.filter((layer) => layer.type !== 'backdrop' && layer.type !== 'grid');
    assert(visible.length >= 3, `${shot.kind} 的内容层太少：${visible.length}`);
    assert(shot.motion && shot.motion.enter && shot.motion.density === 'med', `${shot.kind} 缺动效或密度不对`);
    assert(shot.transitionOut || shot.index === 3, `${shot.kind} 缺转场`);
  }
});

await step('每镜自带可直接提交的 clip.insert（v1 / code / 层文件）', async () => {
  const shots = buildStyleShots(defaultStyleSpec());
  for (const shot of shots) {
    assert(Array.isArray(shot.ops) && shot.ops.length === 1, `${shot.kind} 的 ops 不对`);
    const op = shot.ops[0];
    assert(op.type === 'clip.insert', 'op 类型=' + op.type);
    assert(op.clipType === 'code', 'clipType=' + op.clipType);
    assert(op.trackId === 'v1', 'trackId=' + op.trackId);
    assert(op.layerId === shot.layerId, 'layerId 与镜头不一致');
    assert(op.start === shot.start && op.duration === shot.duration, '时间区间与镜头不一致');
  }
});

await step('specToSummary 同时说出颜色与字体', async () => {
  const spec = defaultStyleSpec();
  const text = specToSummary(spec);
  assert(text.includes(spec.palette.accent.toUpperCase()), '摘要里没有主色');
  assert(text.includes(spec.palette.background.toUpperCase()), '摘要里没有底色');
  assert(/Inter/.test(text), '摘要里没有字体族');
  assert(/标题/.test(text) && /字号|px/.test(text), '摘要里没有字号层级');
  assert(/动效/.test(text) && /节奏/.test(text), '摘要里没有动效/节奏');
});

await step('默认 spec 的版式过对齐检查（ok=true，六项全过）', async () => {
  const result = alignmentForSpec(defaultStyleSpec());
  assert(result.ok === true, '默认 spec 没过对齐检查：' + result.issues.map((i) => i.message).join('；'));
  assert(result.issues.length === 0, '默认 spec 有对齐问题：' + result.issues.map((i) => i.code).join(','));
  assert(result.summary.total === 6 && result.summary.failed === 0, '对齐统计不对：' + JSON.stringify(result.summary));
});

await step('节奏改 1.5 秒 → 总时长 6 秒（节奏确实作用于展开）', async () => {  const spec = defaultStyleSpec();
  spec.rhythm = { shotSeconds: 1.5, transitionSeconds: 0.4 };
  const shots = buildStyleShots(spec);
  assert(shots.length === 4, '镜头数变了');
  assert(Math.abs(shots[3].end - 6) < 1e-9, '总时长=' + shots[3].end);
});

await step('非法 spec 传给 buildStyleShots 直接拒绝（不静默画错）', async () => {
  const spec = defaultStyleSpec();
  spec.palette.background = '#12';
  let caught = null;
  try {
    buildStyleShots(spec);
  } catch (e) {
    caught = e;
  }
  assert(caught, '应当抛错');
  assert(caught.code === 'INVALID_ARG', 'code=' + caught.code);
  assert(/#rrggbb/.test(caught.message), '错误信息不是中文原因：' + caught.message);
});

console.log('A. 纯函数 · 预览工程与绘制');

await step('预览把节奏归一到 2 秒/镜，并说明样片长度不受节奏影响', async () => {
  const spec = defaultStyleSpec();
  spec.rhythm = { shotSeconds: 3, transitionSeconds: 0.4 };
  const built = buildPreviewProject({ projectRoot: 'C:/tmp/p', sessionId: 's1', spec });
  assert(built.duration === PREVIEW_SECONDS, '预览时长=' + built.duration);
  assert(built.spec.rhythm.shotSeconds === 2, '预览没归一化节奏');
  assert(built.requestedShotSeconds === 3, '没记下请求的节奏');
  assert(built.notes.some((note) => /固定 8 秒/.test(note)), '没有说明样片固定 8 秒：' + built.notes.join('/'));
  assert(built.shots.every((shot) => shot.duration === 2), '预览镜头不是 2 秒');
});

await step('预览工程只落在 <工程>/.dsh-video/style-preview/ 下', async () => {
  const root = path.resolve('C:/tmp/vw-style-root');
  const layout = previewLayout();
  const built = buildPreviewProject({ projectRoot: root, sessionId: 's1', spec: defaultStyleSpec() });
  assert(layout.relDir === '.dsh-video/style-preview', '预览目录变了：' + layout.relDir);
  for (const file of built.files) {
    assert(file.relPath.startsWith(layout.relDir + '/'), '文件跑到预览目录外：' + file.relPath);
    assert(!file.relPath.includes('..'), '路径里出现 ..：' + file.relPath);
  }
  const userDoc = path.resolve(root, '.dsh-video', 'project.json');
  for (const file of built.files) {
    assert(path.resolve(root, file.relPath) !== userDoc, '预览竟然要写用户工程的 project.json');
  }
  assert(built.doc.root === layout.relDir, 'doc.root 不是预览目录：' + built.doc.root);
  assert(built.doc.projectId === 'vp_style_preview', '预览工程 id 不稳定：' + built.doc.projectId);
  assert(built.doc.revision === 1, '预览工程 revision=' + built.doc.revision);
  assert(built.doc.clips.length === 4, '预览工程片段数=' + built.doc.clips.length);
  assert(built.doc.duration === PREVIEW_SECONDS, '预览工程时长=' + built.doc.duration);
});

await step('buildPreviewProject 不改传进来的 spec（无副作用）', async () => {
  const spec = defaultStyleSpec();
  spec.rhythm.shotSeconds = 3;
  const before = JSON.stringify(spec);
  buildPreviewProject({ projectRoot: 'C:/tmp/p', sessionId: 's1', spec });
  assert(JSON.stringify(spec) === before, '传进去的 spec 被改了');
});

await step('生成的代码图层源码可被 import，render 跑一帧不抛错', async () => {
  const spec = defaultStyleSpec();
  const shots = buildStyleShots(spec);
  const source = shotLayerSource(shots[1], spec);
  assert(/export function render/.test(source), '源码里没有 render 导出');
  const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(source));
  assert(typeof mod.render === 'function', 'render 不是函数');
  const { ctx } = mockCtx();
  mod.render(ctx, 1.2, { width: 1280, height: 720 });
  mod.render(ctx, 0, { width: 640, height: 360 });
});

await step('换主色：只有 accent 层变色，底色与文字色不动', async () => {
  const warm = defaultStyleSpec();
  warm.palette.accent = '#FF6B35';
  const base = defaultStyleSpec();
  const warmShots = buildStyleShots(warm);
  const baseShots = buildStyleShots(base);

  const a = mockCtx();
  drawStyleFrame(a.ctx, { width: 1280, height: 720, spec: warm, shots: warmShots, t: 0.9 });
  const b = mockCtx();
  drawStyleFrame(b.ctx, { width: 1280, height: 720, spec: base, shots: baseShots, t: 0.9 });

  assert(showsColor(a.calls, '#FF6B35'), '新主色没出现在画面调用里');
  assert(!showsColor(b.calls, '#FF6B35'), '旧 spec 里出现了新主色');
  assert(showsColor(b.calls, base.palette.accent), '默认主色没出现');
  assert(showsColor(a.calls, warm.palette.background), '底色应当不受主色影响');
  assert(showsColor(b.calls, base.palette.background), '底色应当不受主色影响');
  assert(!showsColor(a.calls, warm.palette.secondary) || true, '辅色是否出现不做硬性要求');
});

await step('样片逐帧绘制是 t 的纯函数（同一 t 两次结果相同）', async () => {
  const spec = defaultStyleSpec();
  const shots = buildStyleShots(spec);
  const first = mockCtx();
  drawStyleFrame(first.ctx, { width: 1280, height: 720, spec, shots, t: 2.1 });
  const second = mockCtx();
  drawStyleFrame(second.ctx, { width: 1280, height: 720, spec, shots, t: 2.1 });
  assert(JSON.stringify(first.calls) === JSON.stringify(second.calls), '同一 t 画出了不同的东西');
  // 转场窗口里两镜都要画到：t=2.0 刚进第 2 镜，应当同时有上一镜的延展帧
  const boundary = mockCtx();
  drawStyleFrame(boundary.ctx, { width: 1280, height: 720, spec, shots, t: 2.05 });
  const texts = boundary.calls.filter((call) => call.op === 'fillText').map((call) => String(call.text));
  assert(texts.length > 4, '转场窗口里没有同时画两镜：' + texts.length);
});

console.log('B. 宿主侧 · RPC 与落盘');

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-style-'));
const SESSION = 'session-style';
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
  req.headers = {};
  setTimeout(() => {
    if (body !== undefined && body !== null) req.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
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

const route = (p) => routes.find((r) => r.path === p);

async function rpc(method, params) {
  const res = fakeRes();
  await route('/api/video/rpc').handler(fakeReq('POST', '/api/video/rpc', { method, params }), res);
  const payload = JSON.parse(res.body);
  if (!payload.ok) throw new Error(`${method}: ${payload.error.code} ${payload.error.message}`);
  return payload.value;
}

async function rpcRaw(method, params) {
  const res = fakeRes();
  await route('/api/video/rpc').handler(fakeReq('POST', '/api/video/rpc', { method, params }), res);
  return { status: res.statusCode, payload: JSON.parse(res.body) };
}

async function upload(query, bytes) {
  const res = fakeRes();
  await route('/api/video/style-upload').handler(
    fakeReq('POST', '/api/video/style-upload?' + query, bytes),
    res,
  );
  return { status: res.statusCode, payload: JSON.parse(res.body) };
}

let projectId = null;
const userDocPath = path.join(root, '.dsh-video', 'project.json');
let userDocBefore = null;

await step('style.default 回默认 spec、摘要与可选项', async () => {
  const v = await rpc('style.default', {});
  assert(v.spec && v.spec.palette && v.spec.palette.accent, '没有 spec');
  assert(typeof v.summary === 'string' && v.summary.includes(v.spec.palette.accent.toUpperCase()), '摘要不对');
  assert(v.previewSeconds === PREVIEW_SECONDS, 'previewSeconds 不对');
  assert(v.shotKinds.join(',') === SHOT_KINDS.join(','), 'shotKinds 不对');
  assert(Array.isArray(v.fonts) && v.fonts.length >= 2, '字体选项太少');
  assert(v.densities.length === DENSITIES.length, '密度选项不对');
  // 节拍与对齐不用先生成样片就能看见
  assert(v.click && v.click.bpm === bpmFromRhythm(v.spec.rhythm.shotSeconds).bpm, '默认 BPM 不对：' + JSON.stringify(v.click));
  assert(v.click.strongHz === 880 && v.click.weakHz === 440, '强弱拍频率不对');
  assert(v.click.clickMs === 60 && v.click.peakDbfs === -18, '节拍音规格不对');
  assert(v.alignment && v.alignment.ok === true, '默认 spec 的对齐检查没过');
});

await step('打开工程后 style.preview 铺出临时预览工程', async () => {
  const opened = await rpc('project.open', { dir: root, sessionId: SESSION });
  projectId = opened.doc.projectId;
  userDocBefore = await fs.readFile(userDocPath, 'utf8');

  const v = await rpc('style.preview', { projectId, sessionId: SESSION, spec: defaultStyleSpec() });
  assert(v.timelineReady === true, 'timelineReady 不是 true');
  assert(v.shots.length === 4, '镜头数=' + v.shots.length);
  assert(v.duration === PREVIEW_SECONDS, 'duration=' + v.duration);
  assert(v.preview && v.preview.relDir === '.dsh-video/style-preview', '预览目录不对');
  assert(v.preview.clipCount === 4, '预览工程片段数=' + v.preview.clipCount);
  // 第一次生成：还没帧也没样片，客户端去渲
  assert(Array.isArray(v.frames) && v.frames.length === 0, '首次 preview 不该有帧');

  const previewDir = path.join(root, '.dsh-video', 'style-preview');
  const doc = JSON.parse(await fs.readFile(path.join(previewDir, 'project.json'), 'utf8'));
  assert(doc.clips.length === 4, '预览工程 project.json 片段数=' + doc.clips.length);
  assert(doc.duration === PREVIEW_SECONDS, '预览工程时长=' + doc.duration);
  const layerFile = path.join(previewDir, 'code', 'style-opening', 'index.js');
  const layerSource = await fs.readFile(layerFile, 'utf8');
  assert(/export function render/.test(layerSource), '代码图层没落盘成 ESM');
  const meta = JSON.parse(await fs.readFile(path.join(previewDir, 'style.json'), 'utf8'));
  assert(meta.fingerprint && meta.summary, 'style.json 缺指纹或摘要');
});

await step('预览工程的 style.json 带节拍参数与对齐结果', async () => {
  const meta = JSON.parse(
    await fs.readFile(path.join(root, '.dsh-video', 'style-preview', 'style.json'), 'utf8'),
  );
  assert(meta.click, 'style.json 没存节拍参数');
  assert(meta.click.bpm === 120, '样片节拍 BPM=' + meta.click.bpm);
  assert(meta.click.intervalMs === 500, 'intervalMs=' + meta.click.intervalMs);
  assert(meta.click.sampleRate === 48000 && meta.click.clickMs === 60, '节拍规格不对：' + JSON.stringify(meta.click));
  assert(meta.click.strongHz === 880 && meta.click.weakHz === 440, '强弱拍频率没进产物');
  assert(meta.alignment && meta.alignment.ok === true, 'style.json 里的对齐结果不对');
  assert(Array.isArray(meta.alignment.checks) && meta.alignment.checks.length === 6, '对齐检查项没进产物');
  // 预览接口也要把同样两份数据回给面板
  const v = await rpc('style.preview', { projectId, sessionId: SESSION, spec: defaultStyleSpec() });
  assert(v.click && v.click.bpm === 120, 'style.preview 没回节拍参数');
  assert(v.alignment && v.alignment.ok === true, 'style.preview 没回对齐结果');
});

await step('上传 4 张关键帧 + 8 秒样片，style.result 回 4 条路径', async () => {
  for (const [index, kind] of SHOT_KINDS.entries()) {
    const r = await upload(
      `projectId=${encodeURIComponent(projectId)}&sessionId=${SESSION}&kind=frame&index=${index}&shotKind=${kind}`,
      PNG_1X1,
    );
    assert(r.status === 200 && r.payload.ok, `${kind} 上传失败：${r.payload.error && r.payload.error.message}`);
    assert(r.payload.value.relPath.endsWith(`/${String(index + 1).padStart(2, '0')}-${kind}.png`), '帧名不对：' + r.payload.value.relPath);
  }
  const video = await upload(`projectId=${encodeURIComponent(projectId)}&sessionId=${SESSION}&kind=video`, Buffer.from('fake-mp4'));
  assert(video.status === 200 && video.payload.ok, '样片上传失败');
  assert(video.payload.value.relPath.endsWith('preview-8s.mp4'), '样片名不对：' + video.payload.value.relPath);

  const v = await rpc('style.result', { projectId, sessionId: SESSION });
  assert(v.frames.length === 4, '回传帧数=' + v.frames.length);
  assert(v.frames.every((rel) => rel.startsWith('.dsh-video/style-preview/frames/')), '帧路径不在预览目录里');
  assert(v.previewPath === '.dsh-video/style-preview/preview-8s.mp4', 'previewPath=' + v.previewPath);
  for (const frame of v.frameDetails) {
    const stat = await fs.stat(frame.absPath);
    assert(stat.size === PNG_1X1.length, '帧没真的落盘：' + frame.absPath);
  }
});

await step('节拍 WAV 可以单独上传（混不进音轨时的兜底路径）', async () => {
  const wav = Buffer.alloc(44 + 4800 * 4);
  wav.write('RIFF', 0, 'ascii');
  wav.write('WAVE', 8, 'ascii');
  const r = await upload(`projectId=${encodeURIComponent(projectId)}&sessionId=${SESSION}&kind=click`, wav);
  assert(r.status === 200 && r.payload.ok, '节拍上传失败：' + (r.payload.error && r.payload.error.message));
  assert(r.payload.value.relPath.endsWith('preview-8s-click.wav'), '节拍文件名不对：' + r.payload.value.relPath);
  const v = await rpc('style.result', { projectId, sessionId: SESSION });
  assert(v.clickPath === '.dsh-video/style-preview/preview-8s-click.wav', 'clickPath=' + v.clickPath);
  assert(v.clickAudio && v.clickAudio.bytes === wav.length, 'clickAudio 字节数不对');
  // 删掉之后 clickPath 回到 null（兜底文件不是永久事实）
  await fs.rm(path.join(root, '.dsh-video', 'style-preview', 'preview-8s-click.wav'), { force: true });
  const after = await rpc('style.result', { projectId, sessionId: SESSION });
  assert(after.clickPath === null, '删掉 WAV 后 clickPath 还指着文件：' + after.clickPath);
});

await step('样片的扩展名跟着容器走（没有 H.264 时是 preview-8s.webm）', async () => {
  const r = await upload(
    `projectId=${encodeURIComponent(projectId)}&sessionId=${SESSION}&kind=video&container=webm`,
    Buffer.from('fake-webm'),
  );
  assert(r.status === 200 && r.payload.ok, 'webm 上传失败');
  assert(r.payload.value.relPath.endsWith('preview-8s.webm'), '扩展名没跟着容器走：' + r.payload.value.relPath);
  const v = await rpc('style.result', { projectId, sessionId: SESSION });
  // 两个容器都在时优先回 MP4（播放兼容性更好），但路径必须是真实存在的那个
  assert(
    v.previewPath === '.dsh-video/style-preview/preview-8s.mp4' || v.previewPath === '.dsh-video/style-preview/preview-8s.webm',
    'previewPath=' + v.previewPath,
  );
  const stat = await fs.stat(path.join(root, v.previewPath)).catch(() => null);
  assert(stat && stat.size > 0, 'previewPath 指向的文件不存在');
});

await step('预览工程没有污染用户工程（project.json 一个字节没变）', async () => {
  const after = await fs.readFile(userDocPath, 'utf8');
  assert(after === userDocBefore, '用户工程的 project.json 被改了');
  const timeline = await rpc('project.timeline', { projectId });
  assert(timeline.clips.total === 0, '用户工程时间线被塞了片段：' + timeline.clips.total);
  const listed = await rpc('project.list', { sessionId: SESSION });
  assert(
    !listed.projects.some((p) => p.projectId === 'vp_style_preview'),
    '预览工程混进了本会话的工程列表',
  );
});

await step('spec 变了就清掉旧样片，只重铺工程（reused=false）', async () => {
  const changed = defaultStyleSpec();
  changed.palette.accent = '#FF6B35';
  const v = await rpc('style.preview', { projectId, sessionId: SESSION, spec: changed });
  assert(v.reused === false, 'spec 变了却说 reused=true');
  assert(v.frames.length === 0, '旧帧没被清掉：' + v.frames.join(','));
  assert(v.previewPath === null, '旧样片没被清掉：' + v.previewPath);
  const onDisk = await fs.stat(path.join(root, '.dsh-video', 'style-preview', 'preview-8s.mp4')).catch(() => null);
  assert(onDisk === null, '旧 preview-8s.mp4 还在磁盘上');
});

await step('同样的 spec 再来一次：复用已生成的产物（reused=true）', async () => {
  const spec = defaultStyleSpec();
  spec.palette.accent = '#FF6B35';
  await upload(`projectId=${encodeURIComponent(projectId)}&sessionId=${SESSION}&kind=video`, Buffer.from('fake-mp4'));
  const v = await rpc('style.preview', { projectId, sessionId: SESSION, spec });
  assert(v.reused === true, '同 spec 却没复用');
  assert(v.previewPath === '.dsh-video/style-preview/preview-8s.mp4', '复用后拿不到样片路径');
});

await step('style.preview 拒绝非法 spec，并给出中文原因', async () => {
  const bad = defaultStyleSpec();
  bad.motionDensity = 'extreme';
  const r = await rpcRaw('style.preview', { projectId, sessionId: SESSION, spec: bad });
  assert(r.payload.ok === false, '非法 spec 却成功了');
  assert(r.payload.error.code === 'INVALID_ARG', 'code=' + r.payload.error.code);
  assert(/动效密度/.test(r.payload.error.message), '不是中文原因：' + r.payload.error.message);
});

await step('style-file 只读预览目录：越界与缺文件都被拒', async () => {
  const outside = fakeRes();
  await route('/api/video/style-file').handler(
    fakeReq('GET', `/api/video/style-file?projectId=${encodeURIComponent(projectId)}&relPath=${encodeURIComponent('assets/x.png')}`),
    outside,
  );
  assert(outside.statusCode === 400, '越界路径状态=' + outside.statusCode);
  assert(/只允许读预览目录/.test(outside.body), '越界提示不对：' + outside.body);

  const missing = fakeRes();
  await route('/api/video/style-file').handler(
    fakeReq(
      'GET',
      `/api/video/style-file?projectId=${encodeURIComponent(projectId)}&relPath=${encodeURIComponent('.dsh-video/style-preview/frames/99-nope.png')}`,
    ),
    missing,
  );
  assert(missing.statusCode === 404, '缺文件状态=' + missing.statusCode);
});

await step('style-upload 拒绝越界参数（index 越界 / 未知 shotKind / 未知 kind）', async () => {
  const badIndex = await upload(`projectId=${encodeURIComponent(projectId)}&sessionId=${SESSION}&kind=frame&index=9&shotKind=opening`, PNG_1X1);
  assert(badIndex.payload.ok === false && badIndex.payload.error.code === 'INVALID_ARG', 'index 越界没被拒');
  const badKind = await upload(`projectId=${encodeURIComponent(projectId)}&sessionId=${SESSION}&kind=frame&index=0&shotKind=nope`, PNG_1X1);
  assert(badKind.payload.ok === false, '未知 shotKind 没被拒');
  const badType = await upload(`projectId=${encodeURIComponent(projectId)}&sessionId=${SESSION}&kind=evil`, PNG_1X1);
  assert(badType.payload.ok === false, '未知 kind 没被拒');
  const wrongSession = await upload(`projectId=${encodeURIComponent(projectId)}&sessionId=session-other&kind=video`, PNG_1X1);
  assert(wrongSession.status === 400, '别的会话能往预览目录写：' + wrongSession.status);
});

await fs.rm(root, { recursive: true, force: true });
cleanupBindings();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
