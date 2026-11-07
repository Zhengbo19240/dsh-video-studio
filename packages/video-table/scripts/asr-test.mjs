/**
 * 语音转字幕（ASR）测试。
 *
 *   node scripts/asr-test.mjs
 *
 * 不装依赖、不下载模型、不碰 GPU：
 *   - detectAsr 的三/四种情形用临时目录 + 注入 runner 模拟（Windows 下没法凭空造一个
 *     真 .exe，所以「有没有这个文件」用真实文件系统判断，「跑起来输出什么」用 runner 注入）；
 *   - extractAudio / transcribeWithFasterWhisper 的进程行为用 node 起 stub 脚本，
 *     走真实的 spawn / stdout / stderr / 退出码路径；
 *   - 落时间线用真实 ProjectStore，断言片段数与时间码。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.mjs';
import { asrRoot, asrPaths, detectAsr } from '../src/asr-deps.mjs';
import {
  AsrError,
  extractAudio,
  formatSrt,
  runProcess,
  segmentsToClipOps,
  srtStamp,
  transcribeWithFasterWhisper,
} from '../src/asr.mjs';
import { applySegmentsToTimeline, asrTools, transcribeAsset } from '../src/asr-tools.mjs';

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('asr');

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
  if (actual !== expected) throw new Error(`${label || '值'}不符：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
};
const ok = (value, label) => {
  if (!value) throw new Error((label || '断言') + '不成立');
};

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-asr-'));
const nodeExe = process.execPath;

/** 造一个假的依赖根：只控文件在不在，进程输出由 runner 给 */
async function fakeRoot(name, { ffmpeg = false, python = false, models = false } = {}) {
  const root = path.join(tmpRoot, name);
  await fs.mkdir(root, { recursive: true });
  const p = asrPaths(root);
  if (ffmpeg) {
    await fs.mkdir(p.ffmpegDir, { recursive: true });
    await fs.writeFile(p.ffmpeg, 'stub', 'utf8');
  }
  if (python) {
    await fs.mkdir(path.dirname(p.python), { recursive: true });
    await fs.writeFile(p.python, 'stub', 'utf8');
  }
  if (models) await fs.mkdir(p.models, { recursive: true });
  return root;
}

/** 注入式 runner：按命令返回固定的 stdout / 抛固定错误 */
function fakeRunner(handlers) {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    const handler = handlers(command, args);
    if (typeof handler === 'function') return handler(command, args);
    throw new AsrError('NOT_FOUND', '找不到可执行文件：' + command);
  };
  runner.calls = calls;
  return runner;
}

const FFMPEG_VERSION = 'ffmpeg version 8.1-stub Copyright (c) 2000-2026 the FFmpeg developers';
const probeJson = (cuda) => JSON.stringify({ fw: '1.1.0', ct: '4.4.0', cuda });
const isPythonProbe = (command, args) => String(command).endsWith('python.exe') && args[0] === '-c';

console.log('asr');

await t('asrRoot 尊重 DSH_ASR_ROOT', () => {
  const old = process.env.DSH_ASR_ROOT;
  process.env.DSH_ASR_ROOT = 'Z:\\somewhere\\asr';
  try {
    eq(asrRoot(), 'Z:\\somewhere\\asr');
  } finally {
    if (old == null) delete process.env.DSH_ASR_ROOT;
    else process.env.DSH_ASR_ROOT = old;
  }
});

await t('detectAsr：全缺 → ready:false 且 reasons 说清缺什么', async () => {
  const root = await fakeRoot('none');
  const got = await detectAsr({ root });
  eq(got.ready, false);
  eq(got.ffmpeg.ok, false);
  eq(got.python.ok, false);
  eq(got.whisper.ok, false);
  eq(got.whisper.backend, null);
  eq(got.reasons.length >= 2, true, 'reasons 条数');
  ok(got.reasons.some((r) => r.includes('缺少 ffmpeg')), 'reasons 提到 ffmpeg');
  ok(got.reasons.some((r) => r.includes('缺少 Python')), 'reasons 提到 Python');
  ok(got.reasons.every((r) => typeof r === 'string' && r.length > 8), 'reasons 都是可读中文');
});

await t('detectAsr：只有 ffmpeg → 版本取自首行，Python 仍被判缺', async () => {
  const root = await fakeRoot('only-ffmpeg', { ffmpeg: true });
  const runner = fakeRunner((command) =>
    String(command).endsWith('ffmpeg.exe') ? () => ({ stdout: FFMPEG_VERSION + '\n', stderr: '', code: 0 }) : null,
  );
  const got = await detectAsr({ root, runner });
  eq(got.ready, false);
  eq(got.ffmpeg.ok, true);
  eq(got.ffmpeg.version, FFMPEG_VERSION);
  eq(got.python.ok, false);
  ok(got.reasons.some((r) => r.includes('缺少 Python')), '只报 Python 缺失');
  ok(!got.reasons.some((r) => r.includes('缺少 ffmpeg')), '不该报 ffmpeg 缺失');
});

await t('detectAsr：全有（有 GPU）→ ready:true，backend=cuda，reasons 为空', async () => {
  const root = await fakeRoot('all-cuda', { ffmpeg: true, python: true, models: true });
  const runner = fakeRunner((command, args) => {
    if (String(command).endsWith('ffmpeg.exe')) return () => ({ stdout: FFMPEG_VERSION + '\n', stderr: '', code: 0 });
    if (isPythonProbe(command, args)) return () => ({ stdout: probeJson(1) + '\n', stderr: '', code: 0 });
    return null;
  });
  const got = await detectAsr({ root, runner });
  eq(got.ready, true);
  eq(got.ffmpeg.ok, true);
  eq(got.python.ok, true);
  eq(got.whisper.ok, true);
  eq(got.whisper.backend, 'cuda');
  eq(got.whisper.version, '1.1.0');
  eq(got.reasons.length, 0, 'reasons');
});

await t('detectAsr：全有但没有 GPU → backend=cpu 并给出警告', async () => {
  const root = await fakeRoot('all-cpu', { ffmpeg: true, python: true, models: true });
  const runner = fakeRunner((command, args) => {
    if (String(command).endsWith('ffmpeg.exe')) return () => ({ stdout: FFMPEG_VERSION + '\n', stderr: '', code: 0 });
    if (isPythonProbe(command, args)) return () => ({ stdout: probeJson(0) + '\n', stderr: '', code: 0 });
    return null;
  });
  const got = await detectAsr({ root, runner });
  eq(got.ready, true);
  eq(got.whisper.backend, 'cpu');
  ok(got.warnings.some((w) => w.includes('CUDA')), 'warnings 提到 CUDA');
});

await t('detectAsr：解释器在但缺包 → python.ok 仍为 true，原因指向 pip 包', async () => {
  const root = await fakeRoot('missing-pkgs', { ffmpeg: true, python: true });
  const runner = fakeRunner((command, args) => {
    if (String(command).endsWith('ffmpeg.exe')) return () => ({ stdout: FFMPEG_VERSION + '\n', stderr: '', code: 0 });
    if (isPythonProbe(command, args)) {
      return () =>
        Promise.reject(
          new AsrError('PROCESS_FAILED', 'python.exe 退出码 1', {
            stderrTail: 'ModuleNotFoundError: No module named faster_whisper',
          }),
        );
    }
    return () => ({ stdout: '', stderr: 'Python 3.11.9', code: 0 });
  });
  const got = await detectAsr({ root, runner });
  eq(got.ready, false);
  eq(got.python.ok, true, 'python.ok');
  eq(got.whisper.ok, false);
  eq(got.ffmpeg.ok, true);
  ok(got.reasons.some((r) => r.includes('faster-whisper')), '原因提到 faster-whisper');
});

await t('formatSrt：标准时码 HH:MM:SS,mmm', () => {
  const srt = formatSrt([
    { start: 0, end: 1.5, text: '第一句' },
    { start: 2, end: 3.25, text: '第二句' },
  ]);
  eq(
    srt,
    '1\n00:00:00,000 --> 00:00:01,500\n第一句\n\n2\n00:00:02,000 --> 00:00:03,250\n第二句\n',
    'SRT 文本',
  );
  eq(srtStamp(61.5), '00:01:01,500');
});

await t('formatSrt：毫秒进位（1.9996s → 00:00:02,000）', () => {
  eq(srtStamp(1.9996), '00:00:02,000');
  eq(srtStamp(59.9996), '00:01:00,000');
  eq(srtStamp(3599.9996), '01:00:00,000');
  eq(srtStamp(0.0014), '00:00:00,001');
  eq(srtStamp(-1), '00:00:00,000', '负数归零');
});

await t('formatSrt：空文本与反向区间被丢弃', () => {
  const srt = formatSrt([
    { start: 5, end: 1, text: '反向' },
    { start: 0, end: 1, text: '   ' },
    { start: 1, end: 2, text: '留下' },
  ]);
  eq(srt, '1\n00:00:01,000 --> 00:00:02,000\n留下\n');
});

await t('segmentsToClipOps：片段数、轨道、时间码与最小时长', () => {
  const ops = segmentsToClipOps(
    [
      { start: 2.2, end: 4.0, text: '乙' },
      { start: 0.5, end: 2.0, text: ' 甲 ' },
      { start: 5.0, end: 5.05, text: '丙' },
      { start: 9, end: 8, text: '坏' },
    ],
    { idSeed: 'seed' },
  );
  eq(ops.length, 3, '片段数');
  eq(ops[0].start, 0.5);
  eq(ops[0].duration, 1.5);
  eq(ops[0].text, '甲');
  eq(ops[0].clipType, 'text');
  eq(ops[0].trackId, 't1');
  eq(ops[0].type, 'clip.insert');
  eq(ops[2].duration, 0.2, '不足 0.2 秒补到下限');
  eq(ops[0].clipId, 'asr_seed_1');
  ok(ops[0].clipId !== ops[1].clipId, 'clipId 唯一');
});

await t('runProcess：超时被杀且错误可读', async () => {
  const started = Date.now();
  try {
    await runProcess(nodeExe, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 300 });
    throw new Error('应当超时');
  } catch (e) {
    eq(e.code, 'ETIMEDOUT');
    ok(/超时/.test(e.message), '错误信息说超时：' + e.message);
  }
  ok(Date.now() - started < 4000, '不该等满 5 秒');
});

await t('runProcess：错误信息带 stderr 尾巴且截到 2KB', async () => {
  try {
    await runProcess(
      nodeExe,
      ['-e', 'process.stderr.write("A".repeat(5000) + "\\n最后一行: 无法打开输入文件\\n"); process.exit(1)'],
      { timeoutMs: 10000 },
    );
    throw new Error('应当失败');
  } catch (e) {
    eq(e.code, 'PROCESS_FAILED');
    const tail = (e.details && e.details.stderrTail) || '';
    ok(tail.includes('无法打开输入文件'), 'stderr 尾巴含最后一行');
    ok(Buffer.byteLength(tail, 'utf8') <= 2048, '尾巴不超过 2KB：' + Buffer.byteLength(tail, 'utf8'));
  }
});

await t('runProcess：AbortSignal 取消', async () => {
  const ac = new AbortController();
  const pending = runProcess(nodeExe, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 20000, signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  try {
    await pending;
    throw new Error('应当被取消');
  } catch (e) {
    eq(e.code, 'ASR_ABORTED');
  }
});

await t('extractAudio：参数顺序正确，失败信息含 stderr 尾巴', async () => {
  let seen = null;
  const failing = async (command, args) => {
    seen = { command, args };
    throw new AsrError('PROCESS_FAILED', 'ffmpeg 退出码 1', { stderrTail: '最后一行: 无法打开输入文件' });
  };
  try {
    await extractAudio('ffmpeg.exe', 'in.mp4', 'out.wav', { run: failing });
    throw new Error('应当抛错');
  } catch (e) {
    eq(e.code, 'EXTRACT_FAILED');
    ok(e.message.includes('无法打开输入文件'), '错误信息含 stderr 尾巴：' + e.message);
  }
  eq(seen.args.join(' '), '-y -i in.mp4 -vn -ac 1 -ar 16000 -f wav out.wav');
});

await t('extractAudio：成功时返回 wav 路径与大小', async () => {
  const out = path.join(tmpRoot, 'ok.wav');
  const okRun = async (command, args) => {
    await fs.writeFile(args[args.length - 1], Buffer.from('RIFF-stub-WAVE'));
    return { stdout: '', stderr: '', code: 0 };
  };
  const got = await extractAudio('ffmpeg.exe', 'in.mp4', out, { run: okRun });
  eq(got.path, out);
  ok(got.size > 0, '产出文件非空');
});

/** 把 stub worker 写到临时目录：参数与 src/asr_worker.py 对齐，只去掉真模型 */
async function writeWorker(name, body) {
  const file = path.join(tmpRoot, name);
  await fs.writeFile(file, body, 'utf8');
  return file;
}

await t('transcribeWithFasterWhisper：解析 JSON、进度、env、参数', async () => {
  const worker = await writeWorker(
    'worker-ok.mjs',
    `const args = process.argv.slice(2);
const get = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
if (!process.env.HF_HOME) { process.stderr.write('ERROR HF_HOME 没有设置\\n'); process.exit(9); }
process.stderr.write('加载模型…\\n');
process.stderr.write('PROGRESS 1/3\\n');
process.stderr.write('PROGRESS 2/3\\n');
process.stderr.write('PROGRESS 3/3\\n');
const payload = {
  language: get('--language', 'zh'),
  duration: 61.5,
  device: get('--device', 'cpu'),
  segments: [
    { start: 0.24, end: 2.4, text: ' 第一句 ' },
    { start: 3, end: 5.5, text: '第二句' },
  ],
};
process.stdout.write(JSON.stringify(payload) + '\\n');
`,
  );
  const progress = [];
  const got = await transcribeWithFasterWhisper({
    pythonPath: nodeExe,
    workerPath: worker,
    audioPath: 'audio.wav',
    modelSize: 'small',
    language: 'zh',
    device: 'cuda',
    modelsDir: tmpRoot,
    onProgress: (p) => progress.push(p),
  });
  eq(got.segments.length, 2);
  eq(got.segments[0].text, '第一句', 'text 去掉首尾空白');
  eq(got.segments[0].start, 0.24);
  eq(got.duration, 61.5);
  eq(got.language, 'zh');
  eq(got.device, 'cuda');
  eq(progress.length, 3, '进度条数');
  eq(progress[2].done, 3);
  eq(progress[2].ratio, 1);
});

await t('transcribeWithFasterWhisper：ERROR 行的内容进错误信息', async () => {
  const worker = await writeWorker(
    'worker-error.mjs',
    `process.stderr.write('ERROR 模型加载失败: 权重下载失败\\n'); process.exit(3);\n`,
  );
  try {
    await transcribeWithFasterWhisper({ pythonPath: nodeExe, workerPath: worker, audioPath: 'a.wav' });
    throw new Error('应当失败');
  } catch (e) {
    eq(e.code, 'ASR_FAILED');
    ok(e.message.includes('模型加载失败'), 'message 带 ERROR 内容：' + e.message);
  }
});

await t('transcribeWithFasterWhisper：输出不是 JSON → ASR_BAD_OUTPUT', async () => {
  const worker = await writeWorker('worker-bad.mjs', `process.stdout.write('not json\\n');\n`);
  try {
    await transcribeWithFasterWhisper({ pythonPath: nodeExe, workerPath: worker, audioPath: 'a.wav' });
    throw new Error('应当失败');
  } catch (e) {
    eq(e.code, 'ASR_BAD_OUTPUT');
  }
});

await t('applySegmentsToTimeline：片段数与时间正确，一次事务', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-asr-proj-'));
  const store = new ProjectStore();
  const doc = await store.open(root, 's-asr');
  const segments = [
    { start: 0.5, end: 2.0, text: '甲' },
    { start: 2.2, end: 4.0, text: '乙' },
    { start: 5.0, end: 5.05, text: '丙' },
  ];
  const applied = await applySegmentsToTimeline({ store, projectId: doc.projectId, sessionId: 's-asr', segments });
  const fresh = store.get(doc.projectId).doc;
  const clips = fresh.clips.filter((c) => c.trackId === 't1').sort((a, b) => a.start - b.start);
  eq(clips.length, 3, '字幕片段数');
  eq(clips[0].start, 0.5);
  eq(clips[0].duration, 1.5);
  eq(clips[0].text, '甲');
  eq(clips[1].start, 2.2);
  eq(clips[2].duration, 0.2);
  eq(clips.every((c) => c.type === 'text'), true, '全是文字片段');
  eq(applied.count, 3);
  eq(applied.revision, doc.revision + 1, '只前进一个 revision');
  ok(!!applied.transactionId, '有可撤销事务 id');
  await fs.rm(root, { recursive: true, force: true });
});

await t('transcribeAsset：依赖缺失 → ready:false + reasons，不抛错', async () => {
  const empty = await fakeRoot('empty-for-store');
  const old = process.env.DSH_ASR_ROOT;
  process.env.DSH_ASR_ROOT = empty;
  try {
    const store = new ProjectStore();
    const got = await transcribeAsset({ store, assetPath: 'C:\\no-such-file.mp4' });
    eq(got.ready, false);
    ok(Array.isArray(got.reasons) && got.reasons.length >= 2, 'reasons 非空');
    ok(got.reasons.some((r) => r.includes('DSH_ASR_ROOT') || r.includes('ffmpeg')), 'reasons 指路');
    eq(got.srt, undefined, '没装好就不该有 srt');
  } finally {
    if (old == null) delete process.env.DSH_ASR_ROOT;
    else process.env.DSH_ASR_ROOT = old;
  }
});

await t('工具定义：video_asr_status / video_transcribe 形状正确', async () => {
  const tools = asrTools({ store: new ProjectStore() });
  const names = tools.map((tool) => tool.name).sort();
  eq(names.join(','), 'video_asr_status,video_transcribe');
  const transcribe = tools.find((tool) => tool.name === 'video_transcribe');
  eq(transcribe.parameters.properties.modelSize.enum.join(','), 'small,medium,large-v3');
  eq(transcribe.parameters.properties.applyToTimeline.type, 'boolean');
  const status = tools.find((tool) => tool.name === 'video_asr_status');
  const value = await status.execute({}, { agent: { id: 's-asr' } });
  eq(typeof value.ready, 'boolean');
  ok(Array.isArray(value.reasons), 'reasons 是数组');
});

await t('RPC：asr.status / asr.transcribe / asr.progress 走通（依赖缺失也只是 not-ready）', async () => {
  const { EventEmitter } = await import('node:events');
  const { registerVideoRoutes } = await import('../src/routes.mjs');
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

  const empty = await fakeRoot('rpc-empty');
  const old = process.env.DSH_ASR_ROOT;
  process.env.DSH_ASR_ROOT = empty;
  try {
    const status = await call('asr.status', {});
    eq(typeof status.ready, 'boolean');

    const started = await call('asr.transcribe', {});
    ok(!!started.jobId, '返回 jobId');

    let job = null;
    for (let i = 0; i < 100; i += 1) {
      job = await call('asr.progress', { jobId: started.jobId });
      if (job.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    eq(job.status, 'not-ready');
    eq(job.result.ready, false);
    ok(Array.isArray(job.result.reasons) && job.result.reasons.length > 0, 'not-ready 带 reasons');
    eq(job.error, null);
  } finally {
    if (old == null) delete process.env.DSH_ASR_ROOT;
    else process.env.DSH_ASR_ROOT = old;
  }
});

await t('本机真实 detectAsr 不抛错（只断言形状）', async () => {
  const got = await detectAsr();
  eq(typeof got.ready, 'boolean');
  ok(got.ffmpeg && typeof got.ffmpeg.path === 'string');
  ok(got.python && typeof got.python.path === 'string');
  ok(got.whisper && typeof got.whisper.ok === 'boolean');
  ok(Array.isArray(got.reasons) && Array.isArray(got.warnings));
});

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
