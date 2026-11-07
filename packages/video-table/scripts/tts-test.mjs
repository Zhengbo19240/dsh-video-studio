/**
 * 文字转语音（TTS）测试。
 *
 *   node scripts/tts-test.mjs
 *
 * 不依赖真实网络：所有合成都走注入的假 provider；
 *   - provider 抽象与切换用 registerProvider + DSH_TTS_PROVIDER 验证；
 *   - probe 的「缺 python / 缺 edge-tts / 缺 ffprobe / 断网」用临时目录 + 注入 runner /
 *     network 模拟，不碰真实依赖；
 *   - 自动铺轨用真实 ProjectStore，断言 a1 起点、audioRole、字幕时序。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.mjs';
import { asrPaths } from '../src/asr-deps.mjs';
import {
  MAX_TEXT_CHARS,
  TtsError,
  currentProviderName,
  findFreeStart,
  listVoices,
  planSubtitleSegments,
  probe,
  probeDuration,
  listProviders,
  registerProvider,
  resetProviders,
  speak,
  splitScript,
  synthesize,
  ttsTools,
  unregisterProvider,
} from '../src/tts.mjs';

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('tts');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + ((e && e.message) || e));
  }
}
const eq = (actual, expected, label) => {
  if (actual !== expected) {
    throw new Error(`${label || '值'}不符：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
};
const ok = (value, label) => {
  if (!value) throw new Error((label || '断言') + '不成立');
};
const near = (actual, expected, tolerance, label) => {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label || '数值'}偏差过大：期望 ≈${expected}（±${tolerance}），实际 ${actual}`);
  }
};

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-tts-'));
let envBackup = null;

function setProviderEnv(name) {
  if (envBackup == null) envBackup = process.env.DSH_TTS_PROVIDER;
  if (name == null) delete process.env.DSH_TTS_PROVIDER;
  else process.env.DSH_TTS_PROVIDER = name;
}
function restoreProviderEnv() {
  if (envBackup == null) delete process.env.DSH_TTS_PROVIDER;
  else process.env.DSH_TTS_PROVIDER = envBackup;
  envBackup = null;
}

/** 造一个假的依赖根：只控文件在不在，进程输出由 runner 给 */
async function fakeRoot(name, { ffprobe = false, python = false } = {}) {
  const root = path.join(tmpRoot, name);
  const p = asrPaths(root);
  await fs.mkdir(root, { recursive: true });
  if (ffprobe) {
    await fs.mkdir(p.ffmpegDir, { recursive: true });
    await fs.writeFile(path.join(p.ffmpegDir, 'ffprobe.exe'), 'stub', 'utf8');
  }
  if (python) {
    await fs.mkdir(path.dirname(p.python), { recursive: true });
    await fs.writeFile(p.python, 'stub', 'utf8');
  }
  return root;
}

/** 注入式 runner：python 探测返回 JSON，ffprobe 返回固定时长 */
function fakeRunner({ pythonJson, pythonError, ffprobeOut = '6.720000\n' } = {}) {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    const base = path.basename(String(command)).toLowerCase();
    if (base.startsWith('python')) {
      if (pythonError) throw pythonError;
      return { stdout: String(pythonJson || '') + '\n', stderr: '', code: 0 };
    }
    if (base.startsWith('ffprobe')) return { stdout: ffprobeOut, stderr: '', code: 0 };
    throw new Error('unexpected command: ' + command);
  };
  runner.calls = calls;
  return runner;
}

/** 假 provider：写一小段假字节，可指定时长 / 失败 / 调用记录 */
function makeFakeProvider({ durationMs = 6000, fail = null, bytes = 'ID3-fake-audio' } = {}) {
  const calls = [];
  const provider = {
    label: '测试用假 provider',
    requiresNetwork: false,
    async synthesize(opts) {
      calls.push(opts);
      if (fail) throw fail;
      await fs.writeFile(opts.outPath, Buffer.from(bytes, 'utf8'));
      return durationMs == null ? {} : { durationMs };
    },
    calls,
  };
  return provider;
}

const networkOk = async () => ({ ok: true });
const networkDown = async () => ({ ok: false, error: 'getaddrinfo ENOTFOUND speech.platform.bing.com' });
const PYTHON_JSON = JSON.stringify({ edgeTts: '7.3.1', python: '3.11.9' });

console.log('tts');

// --------------------------------------------------------------- provider ---

await t('provider 默认是 edge，DSH_TTS_PROVIDER 能切换', () => {
  setProviderEnv(null);
  eq(currentProviderName(), 'edge');
  setProviderEnv('cosyvoice');
  eq(currentProviderName(), 'cosyvoice');
  restoreProviderEnv();
  ok(listProviders().includes('edge'), '内置 edge 已注册');
});

await t('registerProvider 校验实现；注册后 listProviders 能看到', () => {
  let threw = false;
  try {
    registerProvider('bad', {});
  } catch (e) {
    threw = true;
    eq(e instanceof TtsError, true, '是 TtsError');
    ok(e.message.includes('synthesize'), 'message 指出缺 synthesize');
  }
  ok(threw, '缺 synthesize 应当被拒');

  const fake = makeFakeProvider();
  registerProvider('fake-check', fake);
  ok(listProviders().includes('fake-check'), '已注册');
  unregisterProvider('fake-check');
  ok(!listProviders().includes('fake-check'), '已移除');
});

await t('音色列表：≥6 条中文音色，字段齐全且包含晓晓', () => {
  const voices = listVoices();
  ok(voices.length >= 6, '至少 6 条');
  for (const v of voices) {
    ok(typeof v.id === 'string' && v.id.endsWith('Neural'), 'id 形如 xxxNeural: ' + v.id);
    ok(v.gender === 'male' || v.gender === 'female', '有性别标签: ' + v.id);
    ok(typeof v.style === 'string' && v.style.length > 0, '有风格标签: ' + v.id);
  }
  ok(voices.some((v) => v.id === 'zh-CN-XiaoxiaoNeural'), '含晓晓');
  ok(voices.some((v) => v.gender === 'male'), '含男声');
});

// ------------------------------------------------------------------ probe ---

await t('probe：缺 Python 与 ffprobe → ready:false，reasons 是中文且指路', async () => {
  setProviderEnv(null);
  const root = await fakeRoot('probe-none');
  const got = await probe({ root, network: networkOk, runner: fakeRunner({}) });
  eq(got.ready, false);
  eq(got.provider, 'edge');
  eq(got.ffprobe.ok, false);
  ok(got.reasons.some((r) => r.includes('缺少 ffprobe')), 'reasons 提到 ffprobe');
  ok(got.reasons.some((r) => r.includes('缺少 Python')), 'reasons 提到 Python');
  ok(
    got.reasons.every((r) => typeof r === 'string' && /[\u4e00-\u9fa5]/.test(r)),
    'reasons 都是中文',
  );
});

await t('probe：有 python 但 import edge_tts 失败 → reasons 给出 pip 命令', async () => {
  const root = await fakeRoot('probe-no-pkg', { python: true, ffprobe: true });
  const got = await probe({
    root,
    network: networkOk,
    runner: fakeRunner({
      pythonError: Object.assign(new Error('ModuleNotFoundError: No module named edge_tts'), { code: 'PROCESS_FAILED' }),
    }),
  });
  eq(got.ready, false);
  ok(got.reasons.some((r) => r.includes('edge-tts')), 'reasons 提到 edge-tts');
  ok(got.reasons.some((r) => r.includes('pip install edge-tts')), 'reasons 给出安装命令');
});

await t('probe：断网 → reasons 明确说连不上（不是未知错误）', async () => {
  const root = await fakeRoot('probe-offline', { python: true, ffprobe: true });
  const got = await probe({ root, network: networkDown, runner: fakeRunner({ pythonJson: PYTHON_JSON }) });
  eq(got.ready, false);
  eq(got.network.ok, false);
  ok(got.reasons.some((r) => r.includes('连不上')), 'reasons 提到连不上');
  ok(got.reasons.every((r) => !r.includes('未知错误')), '没有「未知错误」');
});

await t('probe：依赖与网络都齐 → ready:true，带 python 版本与音色数', async () => {
  const root = await fakeRoot('probe-ready', { python: true, ffprobe: true });
  const got = await probe({ root, network: networkOk, runner: fakeRunner({ pythonJson: PYTHON_JSON }) });
  eq(got.ready, true);
  eq(got.python.edgeTts, '7.3.1');
  eq(got.voiceCount, listVoices().length);
  eq(got.reasons.length, 0);
  ok(got.human.includes('配音就绪'), 'human 是一行中文结论');
});

await t('probe：未知 provider → ready:false 且列出已注册', async () => {
  setProviderEnv('nope');
  try {
    const got = await probe({ root: await fakeRoot('probe-unknown'), network: networkOk });
    eq(got.ready, false);
    ok(got.reasons.some((r) => r.includes('没有这个配音 provider')), 'reasons 说明 provider 不存在');
    ok(got.reasons.some((r) => r.includes('edge')), 'reasons 列出可用 provider');
  } finally {
    restoreProviderEnv();
  }
});

// ------------------------------------------------------------- synthesize ---

await t('synthesize：空文本被拒（INVALID_ARG，中文）', async () => {
  const root = await fs.mkdtemp(path.join(tmpRoot, 'empty-text-'));
  let error = null;
  try {
    await synthesize('   \n  ', { projectRoot: root, provider: 'fake' });
  } catch (e) {
    error = e;
  }
  ok(error instanceof TtsError, '抛 TtsError');
  eq(error.code, 'INVALID_ARG');
  ok(error.message.includes('文本为空'), 'message 说清是空文本');
});

await t(`synthesize：超过 ${MAX_TEXT_CHARS} 字被拒，并报出实际字数`, async () => {
  const root = await fs.mkdtemp(path.join(tmpRoot, 'long-text-'));
  registerProvider('fake', makeFakeProvider());
  let error = null;
  try {
    await synthesize('啊'.repeat(MAX_TEXT_CHARS + 1), { projectRoot: root, provider: 'fake' });
  } catch (e) {
    error = e;
  }
  ok(error instanceof TtsError, '抛 TtsError');
  eq(error.code, 'INVALID_ARG');
  ok(error.message.includes(String(MAX_TEXT_CHARS + 1)), '报出实际字数');
  ok(error.message.includes(String(MAX_TEXT_CHARS)), '报出上限');
});

await t('synthesize：未知 provider → UNKNOWN_PROVIDER，不吞错', async () => {
  const root = await fs.mkdtemp(path.join(tmpRoot, 'unknown-provider-'));
  let error = null;
  try {
    await synthesize('你好', { projectRoot: root, provider: 'no-such-provider' });
  } catch (e) {
    error = e;
  }
  ok(error instanceof TtsError, '抛 TtsError');
  eq(error.code, 'UNKNOWN_PROVIDER');
  ok(error.message.includes('no-such-provider'), 'message 带上收到的名字');
});

await t('synthesize：provider 抛普通 Error → SYNTH_FAILED，带真实原因', async () => {
  const root = await fs.mkdtemp(path.join(tmpRoot, 'fail-'));
  registerProvider('fake-fail', makeFakeProvider({ fail: new Error('网络断了：ECONNRESET') }));
  let error = null;
  try {
    await synthesize('你好', { projectRoot: root, provider: 'fake-fail' });
  } catch (e) {
    error = e;
  }
  ok(error instanceof TtsError, '抛 TtsError');
  eq(error.code, 'SYNTH_FAILED');
  ok(error.message.includes('ECONNRESET'), 'message 保留真实原因');
  ok(!error.message.includes('未知错误'), '没有「未知错误」');
  // 失败不留半截文件
  const assets = await fs.readdir(path.join(root, 'assets'));
  eq(assets.length, 0, 'assets 里没有残留文件');
});

await t('断网：edge provider 的连接失败被译成 NETWORK + 中文原因', async () => {
  const root = await fs.mkdtemp(path.join(tmpRoot, 'offline-synth-'));
  const runner = async () => {
    throw Object.assign(new Error('edge_tts 退出码 1'), {
      code: 'PROCESS_FAILED',
      details: {
        stderrTail:
          'aiohttp.ClientConnectorError: Cannot connect to host speech.platform.bing.com:443 ssl:default [Connect call failed]',
      },
    });
  };
  let error = null;
  try {
    await synthesize('断网测试', { projectRoot: root, provider: 'edge', runner });
  } catch (e) {
    error = e;
  }
  ok(error instanceof TtsError, '抛 TtsError');
  eq(error.code, 'NETWORK');
  ok(error.message.includes('连不上'), 'message 说清是连不上');
  ok(error.message.includes('speech.platform.bing.com') || error.message.includes('Cannot connect'), '保留底层原因');
  const assets = await fs.readdir(path.join(root, 'assets')).catch(() => []);
  eq(assets.length, 0, '断网失败不留半截文件');
});

await t('synthesize：成功 → 返回 durationMs / audioPath / chars，文件真的落盘', async () => {
  const root = await fs.mkdtemp(path.join(tmpRoot, 'ok-'));
  const fake = makeFakeProvider({ durationMs: 6720 });
  registerProvider('fake', fake);
  const got = await synthesize('你好，这是一段配音测试。', { projectRoot: root, provider: 'fake', voice: 'zh-CN-YunxiNeural' });
  eq(got.ok, true);
  eq(got.provider, 'fake');
  eq(got.voice, 'zh-CN-YunxiNeural');
  eq(got.durationMs, 6720);
  eq(got.chars, Array.from('你好，这是一段配音测试。').length);
  ok(/^assets\/tts-[0-9a-f]{12}\.mp3$/.test(got.audioPath), '相对路径形如 assets/tts-<hash>.mp3: ' + got.audioPath);
  const stat = await fs.stat(path.join(root, got.audioPath));
  ok(stat.size > 0, '文件存在且非空');
  eq(fake.calls.length, 1, 'provider 被调用一次');
});

await t('synthesize：同文本第二次命中缓存，不再调用 provider', async () => {
  const root = await fs.mkdtemp(path.join(tmpRoot, 'cached-'));
  const depRoot = await fakeRoot('dep-cached', { ffprobe: true, python: true });
  const runner = fakeRunner({ ffprobeOut: '3.000000\n' });
  const fake = makeFakeProvider({ durationMs: 3000 });
  registerProvider('fake', fake);
  const first = await synthesize('缓存测试', { projectRoot: root, provider: 'fake', root: depRoot, runner });
  const second = await synthesize('缓存测试', { projectRoot: root, provider: 'fake', root: depRoot, runner });
  eq(first.audioPath, second.audioPath);
  eq(second.cached, true);
  eq(fake.calls.length, 1, '缓存命中时 provider 只被调用一次');
});

await t('synthesize：provider 不给时长 → 用 ffprobe（注入 runner）读 durationMs', async () => {
  const root = await fs.mkdtemp(path.join(tmpRoot, 'ffprobe-duration-'));
  const depRoot = await fakeRoot('dep-duration', { ffprobe: true, python: true });
  const fake = makeFakeProvider({ durationMs: null });
  registerProvider('fake', fake);
  const runner = fakeRunner({ ffprobeOut: '3.250000\n' });
  const got = await synthesize('读时长', { projectRoot: root, provider: 'fake', root: depRoot, runner });
  eq(got.durationMs, 3250);
  ok(
    runner.calls.some((c) => path.basename(String(c.command)).toLowerCase().startsWith('ffprobe')),
    '确实调用了 ffprobe',
  );
});

await t('synthesize：没有 ffprobe → NO_FFPROBE，且不留下孤儿音频', async () => {
  const root = await fs.mkdtemp(path.join(tmpRoot, 'no-ffprobe-'));
  const depRoot = await fakeRoot('dep-nofp', { python: true });
  registerProvider('fake', makeFakeProvider({ durationMs: null }));
  let error = null;
  try {
    await synthesize('没有 ffprobe', { projectRoot: root, provider: 'fake', root: depRoot });
  } catch (e) {
    error = e;
  }
  ok(error instanceof TtsError, '抛 TtsError');
  eq(error.code, 'NO_FFPROBE');
  ok(error.message.includes('ffprobe'), 'message 提到 ffprobe');
  const assets = await fs.readdir(path.join(root, 'assets'));
  eq(assets.length, 0, '没有留下孤儿音频');
});

await t('probeDuration：ffprobe 输出非法 → FFPROBE_FAILED，带原话', async () => {
  const depRoot = await fakeRoot('dep-badfp', { ffprobe: true });
  const runner = fakeRunner({ ffprobeOut: 'N/A\n' });
  let error = null;
  try {
    await probeDuration('C:\\no-such.mp3', { root: depRoot, runner });
  } catch (e) {
    error = e;
  }
  ok(error instanceof TtsError, '抛 TtsError');
  eq(error.code, 'FFPROBE_FAILED');
  ok(error.message.includes('N/A'), 'message 保留 ffprobe 原话');
});

// --------------------------------------------------------------- splitter ---

await t('splitScript：按句末标点切，短句不拆', () => {
  const pieces = splitScript('第一句。第二句！第三句？');
  eq(pieces.length, 3);
  eq(pieces[0], '第一句。');
  eq(pieces[2], '第三句？');
});

await t('splitScript：超长句按逗号再切，每块不超过上限', () => {
  const long =
    '今天我们来聊一件很重要的事情，这件事关系到后面所有的步骤，' +
    '如果你跳过这一步，后面的结果都会对不上，所以一定要先看完。';
  const pieces = splitScript(long, { maxChars: 20 });
  ok(pieces.length >= 3, '至少切成 3 块，实际 ' + pieces.length);
  ok(pieces.every((p) => Array.from(p).length <= 22), '每块不超过上限（允许句末标点溢出 2 字）');
  eq(pieces.join(''), long, '拼回去等于原文');
});

await t('planSubtitleSegments：时长按字数分配，总和 ≈ 音频时长', () => {
  const items = planSubtitleSegments('第一句。第二句比较长一些。第三句。', 6.6);
  eq(items.length, 3);
  near(items[0].start, 0, 0.001, '第一条从 0 开始');
  const total = items.reduce((sum, s) => sum + s.duration, 0);
  near(total, 6.6, 0.002, '时长总和');
  const last = items[items.length - 1];
  near(last.start + last.duration, 6.6, 0.002, '最后一条结束于音频末尾');
  ok(items[1].duration > items[0].duration, '字多的那条更长');
});

await t('planSubtitleSegments：音频很短时自动合并，不产生 0 时长片段', () => {
  const items = planSubtitleSegments('一。二。三。四。五。六。', 1.0);
  ok(items.length >= 1 && items.length <= 4, '片段数被压到合理范围，实际 ' + items.length);
  ok(items.every((s) => s.duration >= 0.05), '每条都有正时长');
  near(
    items.reduce((sum, s) => sum + s.duration, 0),
    1.0,
    0.002,
    '总时长',
  );
});

// ------------------------------------------------------------------ speak ---

async function openProject(tag) {
  const root = await fs.mkdtemp(path.join(tmpRoot, 'proj-' + tag + '-'));
  const store = new ProjectStore();
  const doc = await store.open(root, 's-tts-' + tag);
  return { store, doc, root, sessionId: 's-tts-' + tag };
}

await t('speak：a1 起点 = 播放头，audioRole=voice，素材登记进 assets', async () => {
  setProviderEnv('fake');
  try {
    const p = await openProject('a1');
    registerProvider('fake', makeFakeProvider({ durationMs: 6000 }));
    const result = await speak({
      store: p.store,
      projectId: p.doc.projectId,
      sessionId: p.sessionId,
      text: '第一句。第二句。第三句。',
      voice: 'zh-CN-XiaoxiaoNeural',
      start: 2.5,
    });
    eq(result.ok, true);
    eq(result.start, 2.5, '起点就是播放头');

    const fresh = p.store.get(p.doc.projectId).doc;
    const audio = fresh.clips.filter((c) => c.trackId === 'a1');
    eq(audio.length, 1, 'a1 上一条配音');
    eq(audio[0].start, 2.5);
    eq(audio[0].duration, 6);
    eq(audio[0].audioRole, 'voice');
    eq(audio[0].type, 'media');
    ok(audio[0].assetId, '片段挂着 assetId');

    const asset = fresh.assets.find((a) => a.id === audio[0].assetId);
    ok(!!asset, '素材已登记');
    eq(asset.path, result.audioPath);
    eq(asset.mime, 'audio/mpeg');
    eq(asset.size > 0, true, '素材 size > 0');
    const stat = await fs.stat(path.join(p.root, asset.path));
    eq(stat.size, asset.size, '磁盘文件大小与登记一致');
    ok(fresh.tracks.some((tr) => tr.id === 'a1' && tr.kind === 'audio'), '自动建了 a1 音频轨');
  } finally {
    restoreProviderEnv();
  }
});

await t('speak：字幕落在 t1，起点接音频起点，总时长 = 音频时长', async () => {
  setProviderEnv('fake');
  try {
    const p = await openProject('subs');
    registerProvider('fake', makeFakeProvider({ durationMs: 6000 }));
    const result = await speak({
      store: p.store,
      projectId: p.doc.projectId,
      sessionId: p.sessionId,
      text: '第一句。第二句。第三句。',
      start: 1.0,
    });
    const fresh = p.store.get(p.doc.projectId).doc;
    const subs = fresh.clips.filter((c) => c.trackId === 't1').sort((a, b) => a.start - b.start);
    eq(subs.length, 3, '三条字幕');
    eq(subs[0].start, 1.0, '第一条从音频起点开始');
    eq(subs.every((c) => c.type === 'text'), true, '全是文字片段');
    const total = subs.reduce((sum, c) => sum + c.duration, 0);
    near(total, 6, 0.01, '字幕总时长');
    const last = subs[subs.length - 1];
    near(last.start + last.duration, 7, 0.01, '最后一条结束于音频末尾');
    eq(result.subtitles.count, 3);
    eq(subs.map((c) => c.text).join(''), '第一句。第二句。第三句。', '字幕拼回去等于原文');
    ok(fresh.tracks.some((tr) => tr.id === 't1' && tr.kind === 'text'), '自动建了 t1 字幕轨');
  } finally {
    restoreProviderEnv();
  }
});

await t('speak：长文本按标点切成多条，时长总和仍等于音频时长', async () => {
  setProviderEnv('fake');
  try {
    const p = await openProject('long');
    registerProvider('fake', makeFakeProvider({ durationMs: 9000 }));
    const text =
      '今天我们聊三件事：第一是选题，第二是脚本，第三是配音。' +
      '选题决定了这条片子有没有人看，脚本决定了看完的人会不会行动，' +
      '配音决定了观众愿不愿意听完。所以每一步都别省。';
    const result = await speak({ store: p.store, projectId: p.doc.projectId, sessionId: p.sessionId, text });
    const fresh = p.store.get(p.doc.projectId).doc;
    const subs = fresh.clips.filter((c) => c.trackId === 't1');
    ok(subs.length >= 3, '至少 3 条字幕，实际 ' + subs.length);
    near(
      subs.reduce((sum, c) => sum + c.duration, 0),
      9,
      0.01,
      '字幕总时长',
    );
    eq(result.chars, Array.from(text).length);
    ok(
      subs.every((c) => Array.from(c.text).length <= 40),
      '单条字幕不会长到一屏放不下',
    );
  } finally {
    restoreProviderEnv();
  }
});

await t('speak：播放头落在已有片段里 → 自动后移并标记 shifted', async () => {
  setProviderEnv('fake');
  try {
    const p = await openProject('shift');
    registerProvider('fake', makeFakeProvider({ durationMs: 4000 }));
    const first = await speak({
      store: p.store,
      projectId: p.doc.projectId,
      sessionId: p.sessionId,
      text: '第一段。',
      start: 0,
    });
    eq(first.shifted, false);
    const second = await speak({
      store: p.store,
      projectId: p.doc.projectId,
      sessionId: p.sessionId,
      text: '第二段。',
      start: 1,
    });
    eq(second.shifted, true, '被标记为后移');
    eq(second.requestedStart, 1);
    eq(second.start, 4, '挪到第一段结尾之后');
    const fresh = p.store.get(p.doc.projectId).doc;
    const audio = fresh.clips.filter((c) => c.trackId === 'a1').sort((a, b) => a.start - b.start);
    eq(audio.length, 2);
    eq(audio[1].start, 4);
  } finally {
    restoreProviderEnv();
  }
});

await t('speak：空文本在合成前就被拒，工程 revision 不动', async () => {
  setProviderEnv('fake');
  try {
    const p = await openProject('reject');
    const before = p.store.get(p.doc.projectId).doc.revision;
    let error = null;
    try {
      await speak({ store: p.store, projectId: p.doc.projectId, sessionId: p.sessionId, text: '   ' });
    } catch (e) {
      error = e;
    }
    ok(error instanceof TtsError, '抛 TtsError');
    eq(error.code, 'INVALID_ARG');
    const after = p.store.get(p.doc.projectId).doc;
    eq(after.revision, before, 'revision 没变');
    eq(after.clips.length, 0, '没有写入任何片段');
    const assets = await fs.readdir(path.join(p.root, 'assets')).catch(() => []);
    eq(assets.length, 0, '没有生成音频');
  } finally {
    restoreProviderEnv();
  }
});

await t('findFreeStart：空轨道用播放头，重叠时依次跳到片段末尾', () => {
  const doc = {
    clips: [
      { id: 'a', trackId: 'a1', start: 0, duration: 2 },
      { id: 'b', trackId: 'a1', start: 2, duration: 3 },
      { id: 'c', trackId: 't1', start: 10, duration: 1 },
    ],
  };
  eq(findFreeStart(doc, ['a1', 't1'], 4, 1), 5, '落在 a1 的 b 片段里 → 跳到 5');
  eq(findFreeStart(doc, ['a1', 't1'], 10.5, 0.2), 11, 't1 也参与避让');
  eq(findFreeStart(doc, ['a1', 't1'], 20, 1), 20, '空位原样返回');
});

// -------------------------------------------------------------------- RPC ---

await t('RPC：tts.probe / tts.voices / tts.speak 走通', async () => {
  const { EventEmitter } = await import('node:events');
  const { registerVideoRoutes } = await import('../src/routes.mjs');
  const root = await fs.mkdtemp(path.join(tmpRoot, 'rpc-proj-'));
  const store = new ProjectStore();
  const doc = await store.open(root, 's-tts-rpc');
  registerProvider('fake', makeFakeProvider({ durationMs: 5000 }));
  setProviderEnv('fake');
  try {
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
    registerVideoRoutes(ctx, store, () => {});
    const rpcRoute = routes.find((r) => r.path === '/api/video/rpc');
    ok(!!rpcRoute, 'RPC 路由已注册');

    const fakeRes = () => ({
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
    });
    const call = async (method, params) => {
      const req = new EventEmitter();
      req.method = 'POST';
      req.url = '/api/video/rpc';
      setTimeout(() => {
        req.emit('data', Buffer.from(JSON.stringify({ method, params })));
        req.emit('end');
      }, 0);
      const res = fakeRes();
      await rpcRoute.handler(req, res);
      const payload = JSON.parse(res.body);
      if (!payload.ok) throw new Error(method + ' 失败：' + JSON.stringify(payload.error));
      return payload.value;
    };

    const probeValue = await call('tts.probe', { root: await fakeRoot('rpc-dep', { python: true, ffprobe: true }) });
    eq(probeValue.provider, 'fake');
    eq(probeValue.ready, true);

    const voices = await call('tts.voices', {});
    ok(voices.voices.length >= 6, 'voices ≥ 6');
    eq(voices.count, voices.voices.length);

    const spoke = await call('tts.speak', {
      projectId: doc.projectId,
      sessionId: 's-tts-rpc',
      text: 'RPC 配音测试。',
      voice: 'zh-CN-XiaoxiaoNeural',
      start: 0,
    });
    eq(spoke.ok, true);
    eq(spoke.durationMs, 5000);
    const fresh = store.get(doc.projectId).doc;
    const audio = fresh.clips.filter((c) => c.trackId === 'a1');
    eq(audio.length, 1);
    eq(audio[0].audioRole, 'voice');
  } finally {
    restoreProviderEnv();
  }
});

// ------------------------------------------------------------------ tools ---

await t('工具定义：video_tts_status / video_tts_speak 形状正确', async () => {
  const tools = ttsTools({ store: new ProjectStore() });
  const names = tools.map((tool) => tool.name).sort();
  eq(names.join(','), 'video_tts_speak,video_tts_status');
  const speakTool = tools.find((tool) => tool.name === 'video_tts_speak');
  ok(speakTool.description.includes('只在用户明确要求'), '描述写清调用时机');
  eq(speakTool.parameters.required.join(','), 'text');
  ok(speakTool.parameters.properties.voice.enum.includes('zh-CN-XiaoxiaoNeural'), '音色枚举可用');
});

await t('本机真实 probe 不抛错（只断言形状，不联网合成）', async () => {
  const got = await probe({ network: networkOk });
  eq(typeof got.ready, 'boolean');
  ok(got.ffprobe && typeof got.ffprobe.path === 'string');
  ok(got.python && typeof got.python.path === 'string');
  ok(Array.isArray(got.reasons));
  ok(got.voices.length >= 6);
});

// --------------------------------------------------------------- teardown ---

resetProviders();
restoreProviderEnv();
await fs.rm(tmpRoot, { recursive: true, force: true });
cleanupBindings();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
