#!/usr/bin/env node
/**
 * 第三轮配方卡缺口（补三张）的验收测试。
 *
 *   node scripts/recipe-gaps-test.mjs
 *   node scripts/recipe-gaps-test.mjs --json      # 末尾多打一份机器可读摘要
 *
 * 覆盖：
 *   A. 三张卡都在、可 new Function 解析、导出 render、meta 契约完整
 *   B. tc-lower-third-bar：四组 props 边界（缺省 / 空串 / 超长姓名 / 超长副标题）
 *      在 1280×720 与 720×1280 下不抛、不溢出 5% 安全区；入场前 / 出场后是空帧
 *   C. sc-timeline-travel：末帧刻度位置是数值断言（frameOf 与 render 共用同一份算术）
 *   D. sc-gauge-readout-moves：mode 缺省=ignite、mode:'roll' 末帧读数=props 目标值、
 *      roll 节奏在 0.6–0.9s、两种模式 t 越界不抛
 *   E. 不覆盖别人已标定的卡（humanCalibrated 与 calibrationMinutes 仍在）
 *
 * 退出码：0 全绿；1 有 fail。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MOTION = process.env.DSH_MOTION_LIB || path.join(os.homedir(), '.dsh', 'motion-lib');
const JSON_OUT = process.argv.includes('--json');

const LOWER = 'tc-lower-third-bar';
const TIMELINE = 'sc-timeline-travel';
const GAUGE = 'sc-gauge-readout-moves';
const CARDS = [LOWER, TIMELINE, GAUGE];

let pass = 0;
let fail = 0;
const results = [];

function ok(name, detail) {
  pass += 1;
  results.push({ status: 'pass', name, detail });
  console.log('  ok   ' + name + (detail ? '  · ' + detail : ''));
}

function bad(name, detail) {
  fail += 1;
  results.push({ status: 'fail', name, detail });
  console.log('  FAIL ' + name + ' :: ' + (detail == null ? '' : detail));
}

function check(name, condition, detail) {
  if (condition) ok(name, detail);
  else bad(name, detail);
  return !!condition;
}

/* ------------------------------------------------------------------ */
/* 加载与假 ctx                                                        */
/* ------------------------------------------------------------------ */

/** 与 tools/render-card-preview.mjs 同一套 ESM→Function 改写规则。 */
function toFunctionBody(source) {
  return String(source)
    .replace(/export\s+default\s+/g, 'const __default__ = ')
    .replace(/export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/g, (m, isAsync, name) => `${isAsync || ''}function ${name}`)
    .replace(/export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g, (m, kind, name) => `${kind} ${name}`)
    .replace(/export\s*\{[^}]*\}/g, '');
}

/**
 * 载入一张卡；除 render/meta 外，把几张卡各自导出的「探针函数」也一并交出来
 * （探针与 render 共用同一份算术，测试断言的是 render 真正用的那条路径）。
 */
function loadModule(id, source) {
  const body = toFunctionBody(source);
  const api = new Function(
    '"use strict";\n' +
      body +
      '\nreturn {' +
      '\n  render: typeof render === "function" ? render : null,' +
      '\n  meta: typeof meta === "object" ? meta : null,' +
      '\n  frameOf: typeof frameOf === "function" ? frameOf : null,' +
      '\n  activeMode: typeof activeMode === "function" ? activeMode : null,' +
      '\n  tapeValueAt: typeof tapeValueAt === "function" ? tapeValueAt : null,' +
      '\n  probeLayout: typeof probeLayout === "function" ? probeLayout : null,' +
      '\n};',
  )();
  api.id = id;
  return api;
}

function fontSizeOf(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(font || ''));
  return m ? Number(m[1]) : 10;
}

/**
 * 会记账的假 2D context。
 * measureText 跟着当前 font 的字号走 —— 卡的「缩字号 + 省略号」逻辑才能在 Node 里跑出真结果。
 * save/restore 不还原状态（测试不依赖 alpha 栈），但每次 fillText 都记下当时的 font / 对齐 / 基线。
 */
function makeFakeCtx() {
  const state = { font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', globalAlpha: 1 };
  const calls = [];
  const extra = {
    canvas: { width: 0, height: 0 },
    measureText(text) {
      return { width: String(text).length * fontSizeOf(state.font) * 0.92 };
    },
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createConicGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }),
  };
  const ctx = new Proxy(extra, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop in state) return state[prop];
      return (...args) => {
        calls.push({
          op: prop,
          args: args.slice(),
          font: state.font,
          textAlign: state.textAlign,
          textBaseline: state.textBaseline,
        });
        return undefined;
      };
    },
    set(target, prop, value) {
      state[prop] = value;
      if (prop !== 'font') target[prop] = value;
      return true;
    },
    has(target, prop) {
      return prop in target || prop in state;
    },
  });
  return { ctx, calls };
}

/** 跑一帧，收集绘制调用；抛错就返回 error。 */
function runFrame(render, t, width, height, props) {
  const { ctx, calls } = makeFakeCtx();
  ctx.canvas.width = width;
  ctx.canvas.height = height;
  try {
    render(ctx, t, { width, height, props: props || {}, fps: 30, duration: 4.7 });
    return { ok: true, calls };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error), calls };
  }
}

/** 由一次 fillText 调用反推文字盒（以当前对齐/基线为准）。 */
function textBox(call) {
  const text = String(call.args[0]);
  const fs = fontSizeOf(call.font);
  const width = text.length * fs * 0.92;
  let x0 = Number(call.args[1]);
  if (call.textAlign === 'center') x0 -= width / 2;
  else if (call.textAlign === 'right' || call.textAlign === 'end') x0 -= width;
  const y = Number(call.args[2]);
  let y0;
  let y1;
  if (call.textBaseline === 'middle') {
    y0 = y - fs / 2;
    y1 = y + fs / 2;
  } else if (call.textBaseline === 'top' || call.textBaseline === 'hanging') {
    y0 = y;
    y1 = y + fs * 1.1;
  } else {
    y0 = y - fs * 0.88;
    y1 = y + fs * 0.22;
  }
  return { text, x0, x1: x0 + width, y0, y1, size: fs };
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ------------------------------------------------------------------ */
/* 读取卡片                                                            */
/* ------------------------------------------------------------------ */

async function readCards() {
  const out = new Map();
  for (const id of CARDS) {
    const dir = path.join(MOTION, id);
    const codePath = path.join(dir, 'code.js');
    const metaPath = path.join(dir, 'meta.json');
    try {
      const source = await fs.readFile(codePath, 'utf8');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      out.set(id, { source, meta, dir });
    } catch (error) {
      out.set(id, { error: error.message });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* A. 存在 / 可解析 / meta 契约                                        */
/* ------------------------------------------------------------------ */

async function testExistenceAndContract(cards) {
  console.log('\nA · 三张卡都在、可解析、契约完整');

  const missing = CARDS.filter((id) => cards.get(id).error);
  check(
    'T01 三张卡的 code.js + meta.json 都在',
    missing.length === 0,
    missing.length ? missing.map((id) => `${id}: ${cards.get(id).error}`).join(' | ') : CARDS.join(', '),
  );

  const parseErrors = [];
  const apis = new Map();
  for (const id of CARDS) {
    const entry = cards.get(id);
    if (entry.error) continue;
    try {
      const api = loadModule(id, entry.source);
      if (typeof api.render !== 'function') parseErrors.push(`${id}: 没有导出 render`);
      else apis.set(id, api);
    } catch (error) {
      parseErrors.push(`${id}: ${error.message}`);
    }
  }
  check('T02 三张卡 new Function 可解析且导出 render', parseErrors.length === 0, parseErrors.join(' | ') || '3/3');

  const metaProblems = [];
  for (const id of CARDS) {
    const entry = cards.get(id);
    if (entry.error) {
      metaProblems.push(`${id}: 无 meta`);
      continue;
    }
    const m = entry.meta;
    if (!m.source) metaProblems.push(`${id}: 缺 source`);
    if (!m.license) metaProblems.push(`${id}: 缺 license`);
    if (!m.author) metaProblems.push(`${id}: 缺 author`);
    if (m.humanCalibrated !== true) metaProblems.push(`${id}: humanCalibrated ≠ true`);
    if (m.autoConverted !== false) metaProblems.push(`${id}: autoConverted ≠ false`);
  }
  check('T03 三张卡 meta 的 source / license / author / humanCalibrated 齐全', metaProblems.length === 0, metaProblems.join(' | ') || '3/3');

  const newMeta = cards.get(LOWER).meta || {};
  check(
    'T04 新卡时长落在 4–5s，且五个参数都在 paramsSchema',
    Number(newMeta.duration) >= 4 && Number(newMeta.duration) <= 5 &&
      ['name', 'subtitle', 'accent', 'barWidth', 'inDuration'].every((k) => newMeta.paramsSchema && newMeta.paramsSchema.properties && newMeta.paramsSchema.properties[k]),
    `duration=${newMeta.duration}, params=${Object.keys((newMeta.paramsSchema && newMeta.paramsSchema.properties) || {}).join(',')}`,
  );

  return apis;
}

/* ------------------------------------------------------------------ */
/* B. tc-lower-third-bar                                               */
/* ------------------------------------------------------------------ */

function lowerThirdSafety(label, api, width, height, props, t) {
  const run = runFrame(api.render, t, width, height, props);
  if (!run.ok) {
    bad(label + ' 不抛', run.error);
    return;
  }
  const texts = run.calls.filter((c) => c.op === 'fillText');
  if (!texts.length) {
    bad(label + ' 有文字落版', '这一帧没有 fillText');
    return;
  }
  const sx = width * 0.05;
  const sy = height * 0.05;
  const sx1 = width * 0.95;
  const sy1 = height * 0.95;
  const outside = [];
  for (const call of texts) {
    const box = textBox(call);
    if (box.x0 < sx - 0.5 || box.x1 > sx1 + 0.5 || box.y0 < sy - 0.5 || box.y1 > sy1 + 0.5) {
      outside.push(`「${box.text.slice(0, 8)}」x ${box.x0.toFixed(1)}→${box.x1.toFixed(1)} y ${box.y0.toFixed(1)}→${box.y1.toFixed(1)}`);
    }
  }
  // 面板与竖条也要在安全区内
  for (const call of run.calls) {
    if (call.op !== 'roundRect') continue;
    const [x, y, w, h] = call.args.map(Number);
    if (![x, y, w, h].every(Number.isFinite)) {
      outside.push('roundRect 出现非有限值');
      continue;
    }
    if (x < sx - 0.5 || y < sy - 0.5 || x + w > sx1 + 0.5 || y + h > sy1 + 0.5) {
      outside.push(`roundRect ${x.toFixed(1)},${y.toFixed(1)} ${w.toFixed(1)}×${h.toFixed(1)} 越界`);
    }
  }
  check(label + ' 不溢出 5% 安全区', outside.length === 0, outside.slice(0, 3).join(' | ') || `${width}×${height} 全在框内`);
}

function testLowerThird(api) {
  console.log('\nB · tc-lower-third-bar（下三分之一）');
  if (!api) {
    bad('B 段跳过', '卡片没加载成功');
    return;
  }

  for (const [w, h] of [[1280, 720], [720, 1280]]) {
    const run = runFrame(api.render, 2.3, w, h, {});
    check(`T05 ${w}×${h} 缺省 props 不抛且有绘制`, run.ok && run.calls.length > 0, run.ok ? `${run.calls.length} 次绘制调用` : run.error);
  }
  const empty = runFrame(api.render, 2.3, 1280, 720, { name: '', subtitle: '' });
  check('T06 空串姓名 / 说明不抛', empty.ok, empty.ok ? 'ok' : empty.error);

  const longName = '欧阳' + '长'.repeat(80);
  const longSub = '职位'.repeat(40);
  lowerThirdSafety('T07 超长姓名（1280×720）', api, 1280, 720, { name: longName }, 2.3);
  lowerThirdSafety('T08 超长副标题（1280×720）', api, 1280, 720, { subtitle: longSub }, 2.3);
  lowerThirdSafety('T09 超长姓名 + 副标题（720×1280）', api, 720, 1280, { name: longName, subtitle: longSub }, 2.3);
  lowerThirdSafety('T10 缺省 props 安全区（720×1280）', api, 720, 1280, {}, 2.3);

  const before = runFrame(api.render, 0, 1280, 720, {});
  const after = runFrame(api.render, 4.6, 1280, 720, {});
  check(
    'T11 入场前（t=0）与出场后（t=duration）都是空帧',
    before.ok && after.ok && before.calls.length === 0 && after.calls.length === 0,
    `t0=${before.calls.length} 次, t末=${after.calls.length} 次`,
  );

  const wide = makeFakeCtx();
  const narrow = makeFakeCtx();
  const wideLayout = api.probeLayout({ width: 1280, height: 720, props: { barWidth: 20 } }, wide.ctx);
  const narrowLayout = api.probeLayout({ width: 1280, height: 720, props: { barWidth: 4 } }, narrow.ctx);
  check(
    'T12 barWidth 参数生效且被钳制（4 → 20 变宽）',
    wideLayout.barW > narrowLayout.barW && wideLayout.barW <= 24 * wideLayout.s + 1e-6,
    `barW 4→${narrowLayout.barW.toFixed(2)}, 20→${wideLayout.barW.toFixed(2)}`,
  );

  // inDuration 必须被钳在 0.12–1.2：传 99 时，t=0.3 的整块入场位移不能还停在「几乎没动」的位置
  // （整块平移是 ctx.translate，画在 fillText 的 x 上会看不见，所以直接量第一次 translate 的 x）
  const props99 = { name: '长'.repeat(20), inDuration: 99 };
  const entryRun = runFrame(api.render, 0.3, 1280, 720, props99);
  const settledRun = runFrame(api.render, 2.3, 1280, 720, props99);
  const entryLayout = api.probeLayout({ width: 1280, height: 720, props: props99 }, makeFakeCtx().ctx);
  const blockShift = (run) => {
    const hit = run.calls.find((c) => c.op === 'translate' && c.args.length === 2 && Number(c.args[1]) === 0);
    return hit ? Number(hit.args[0]) - entryLayout.left : Number.NaN;
  };
  const travel0 = entryLayout.panelW + 44 * entryLayout.s;
  const offset = blockShift(settledRun) - blockShift(entryRun);
  check(
    'T13 inDuration 被钳到 1.2 以内（t=0.3 已走过大半入场位移，而不是几乎没动）',
    entryRun.ok && settledRun.ok && Number.isFinite(offset) && offset > 0 && offset < travel0 * 0.8,
    `入场位移=${offset.toFixed(1)}px，满位移=${travel0.toFixed(1)}px`,
  );
}

/* ------------------------------------------------------------------ */
/* C. sc-timeline-travel                                               */
/* ------------------------------------------------------------------ */

function testTimeline(api) {
  console.log('\nC · sc-timeline-travel（末帧构图）');
  if (!api || typeof api.frameOf !== 'function') {
    bad('C 段跳过', '卡片没加载成功或缺 frameOf');
    return;
  }

  const f1280 = api.frameOf(5.0, { width: 1280, height: 720, props: {} });
  check(
    'T14 1280×720 末帧刻度在画面中心（|x-640| ≤ 0.5）',
    near(f1280.lastTickX, 640, 0.5),
    `lastTickX=${f1280.lastTickX.toFixed(2)} (旧版 358.4)`,
  );

  const f960 = api.frameOf(5.0, { width: 960, height: 540, props: {} });
  const leftMargin = f960.lastTickX;
  const rightMargin = 960 - f960.lastTickX;
  check(
    'T15 960×540 末帧左右留白相等（差 ≤ 1px）',
    near(leftMargin, rightMargin, 1),
    `left=${leftMargin.toFixed(1)}, right=${rightMargin.toFixed(1)}`,
  );

  check(
    'T16 末帧推近到 1.28 且急停段 push=1',
    near(f1280.scale, 1.28, 1e-6) && near(f1280.push, 1, 1e-6),
    `scale=${f1280.scale.toFixed(3)}, push=${f1280.push.toFixed(3)}`,
  );

  const f0 = api.frameOf(0, { width: 1280, height: 720, props: {} });
  check(
    'T17 前段没被改坏：t=0 相机未动（camX=0、pan=0、scale=1）',
    near(f0.camX, 0, 1e-9) && near(f0.pan, 0, 1e-9) && near(f0.scale, 1, 1e-9),
    `camX=${f0.camX.toFixed(2)}, pan=${f0.pan.toFixed(2)}, scale=${f0.scale}`,
  );

  // 末帧真的能画出来（不是只有算术）
  const run = runFrame(api.render, 5.0, 1280, 720, {});
  check('T18 末帧 render 不抛且仍有绘制', run.ok && run.calls.length > 0, run.ok ? `${run.calls.length} 次调用` : run.error);
}

/* ------------------------------------------------------------------ */
/* D. sc-gauge-readout-moves                                           */
/* ------------------------------------------------------------------ */

function textsOf(calls) {
  return calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]));
}

function testGauge(api) {
  console.log('\nD · sc-gauge-readout-moves（A 式 / B 式）');
  if (!api || typeof api.activeMode !== 'function') {
    bad('D 段跳过', '卡片没加载成功或缺 activeMode');
    return;
  }

  check(
    'T19 mode 缺省 = ignite，未知值也回落到 ignite',
    api.activeMode({}) === 'ignite' && api.activeMode({ mode: 'roll' }) === 'roll' && api.activeMode({ mode: 'bogus' }) === 'ignite',
    `{}→${api.activeMode({})}, roll→${api.activeMode({ mode: 'roll' })}, bogus→${api.activeMode({ mode: 'bogus' })}`,
  );

  const ignite = runFrame(api.render, 1.0, 960, 540, {});
  const igniteTexts = ignite.ok ? textsOf(ignite.calls) : [];
  check(
    'T20 默认调用走 A 式（t=1 出现 Running self-test…）',
    ignite.ok && igniteTexts.some((s) => s.includes('Running self-test')),
    ignite.ok ? igniteTexts.join(' / ') : ignite.error,
  );

  const roll = runFrame(api.render, 1.0, 960, 540, { mode: 'roll' });
  const rollTexts = roll.ok ? textsOf(roll.calls) : [];
  check(
    'T21 mode:roll 走 B 式（Tape rolling…，且不再出现自检文案）',
    roll.ok && rollTexts.some((s) => s.includes('Tape rolling')) && !rollTexts.some((s) => s.includes('Running self-test')),
    roll.ok ? rollTexts.join(' / ') : roll.error,
  );

  const props = { mode: 'roll', gauges: [{ label: 'A', value: 37, unit: '%' }, { label: 'B', value: 64, unit: '%' }, { label: 'C', value: 88, unit: '%' }] };
  const finalRun = runFrame(api.render, 4.7, 960, 540, props);
  const finalTexts = finalRun.ok ? textsOf(finalRun.calls) : [];
  const missing = ['37%', '64%', '88%'].filter((v) => !finalTexts.includes(v));
  check(
    'T22 roll 末帧读数与 props 目标值逐只一致',
    finalRun.ok && missing.length === 0,
    finalRun.ok ? (missing.length ? `缺 ${missing.join(',')}` : finalTexts.filter((s) => s.endsWith('%')).join(' / ')) : finalRun.error,
  );

  const at = 0.2;
  const vAt = (tt) => api.tapeValueAt(tt, at, 60);
  const v06 = vAt(at + 0.6);
  const v09 = vAt(at + 0.9);
  const vMidBounce = vAt(at + 0.72 + 0.11);
  const vDone = vAt(at + 1.2);
  check(
    'T23 滚带 0.6–0.9s 内落定，并有一次 +4 单位内的轻微回弹',
    v06 < 60 && v09 >= 60 && v09 <= 61 && vMidBounce > 60 && vMidBounce <= 64.01 && near(vDone, 60, 1e-9),
    `t+0.6=${v06.toFixed(2)}, t+0.9=${v09.toFixed(2)}, 回弹峰=${vMidBounce.toFixed(2)}, t+1.2=${vDone.toFixed(2)}`,
  );

  const outOfRange = [];
  for (const mode of ['ignite', 'roll']) {
    for (const t of [-5, 999, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const run2 = runFrame(api.render, t, 960, 540, mode === 'roll' ? { mode: 'roll' } : {});
      if (!run2.ok) outOfRange.push(`${mode} t=${String(t)}: ${run2.error}`);
    }
  }
  check('T24 两种模式 t 越界（-5/999/NaN/±Infinity）都不抛', outOfRange.length === 0, outOfRange.slice(0, 3).join(' | ') || '10/10');
}

/* ------------------------------------------------------------------ */
/* E. 别人的标定卡                                                     */
/* ------------------------------------------------------------------ */

async function testOthersUntouched() {
  console.log('\nE · 不覆盖别人已标定的卡');

  const refs = ['tc-bar-chart-growth', 'tc-chart-grow', 'tc-per-character-rise', 'tc-chevron-lower-third', 'sc-radial-wave'];
  const broken = [];
  for (const id of refs) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(MOTION, id, 'meta.json'), 'utf8'));
      if (meta.humanCalibrated !== true) broken.push(`${id}: humanCalibrated 丢了`);
      if (!(Number(meta.calibrationMinutes) > 0)) broken.push(`${id}: calibrationMinutes 丢了`);
    } catch (error) {
      broken.push(`${id}: ${error.message}`);
    }
  }
  check('T25 5 张参照标定卡的 humanCalibrated + calibrationMinutes 仍在', broken.length === 0, broken.join(' | ') || '5/5');

  let dirs = [];
  try {
    dirs = (await fs.readdir(MOTION, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (error) {
    bad('T26 calibrationMinutes 只出现在已标定卡上', error.message);
    return;
  }
  const inconsistent = [];
  let calibrated = 0;
  for (const id of dirs) {
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(path.join(MOTION, id, 'meta.json'), 'utf8'));
    } catch {
      continue;
    }
    if (meta.humanCalibrated === true) calibrated += 1;
    const hasMinutes = meta.calibrationMinutes != null;
    if (hasMinutes && meta.humanCalibrated !== true) inconsistent.push(`${id}: 有 calibrationMinutes 却不是 humanCalibrated`);
  }
  check(
    'T26 calibrationMinutes 只出现在已标定卡上，且标定卡至少还有 40 张',
    inconsistent.length === 0 && calibrated >= 40,
    inconsistent.join(' | ') || `humanCalibrated=${calibrated} 张`,
  );
}

/* ------------------------------------------------------------------ */

const cards = await readCards();
const apis = await testExistenceAndContract(cards);
testLowerThird(apis.get(LOWER));
testTimeline(apis.get(TIMELINE));
testGauge(apis.get(GAUGE));
await testOthersUntouched();

console.log(`\n${pass} passed, ${fail} failed`);

if (JSON_OUT) {
  console.log('\n' + JSON.stringify({ pass, fail, results }, null, 2));
}

process.exit(fail === 0 ? 0 : 1);
