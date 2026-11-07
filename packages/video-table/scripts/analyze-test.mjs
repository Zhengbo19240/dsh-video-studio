/**
 * 视频解析模块测试。
 *
 *   node scripts/analyze-test.mjs
 *
 * 分三层：
 *   1. 纯函数：ffprobe JSON 解析、showinfo 的 pts_time、切点合成、统计聚合
 *   2. 注入进程：analyzeVideo 的完整流程、并发上限、坏文件
 *   3. 真机：真跑一次 exec 超时；真造一段带两次硬切的视频，跑出 ≥3 个镜头
 *
 * 第 3 层依赖 ~/.dsh/video-deps\ffmpeg（路径走 asrPaths()，不另写一份）。
 * 没有 ffmpeg 的机器上那一层会跳过并打印原因，其余照常。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { asrPaths } from '../src/asr-deps.mjs';
import { ProjectStore } from '../src/store.mjs';
import { registerVideoRoutes } from '../src/routes.mjs';
import { runAnalysis } from '../src/analyze-tools.mjs';
import {
  analyzeVideo,
  analysisPath,
  composeShots,
  createLimiter,
  detectShots,
  exec,
  extractFrame,
  ffprobeJson,
  frameStats,
  framesDirFor,
  paceFor,
  parseDurationStamp,
  parseFfprobe,
  parseShowinfoPts,
  readAnalysis,
  summarize,
  writeAnalysis,
} from '../src/analyze.mjs';

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('analyze');

let pass = 0;
let fail = 0;
let skip = 0;

async function step(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + ((e && e.stack) || e));
  }
}

function skipStep(name, why) {
  skip += 1;
  console.log('  skip ' + name + ' :: ' + why);
}

function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label || '值'} 不对：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function near(actual, expected, epsilon, label) {
  if (!(Math.abs(Number(actual) - expected) <= epsilon)) {
    throw new Error(`${label || '数值'} 偏离：期望 ${expected}±${epsilon}，实际 ${actual}`);
  }
}

function ok(value, label) {
  if (!value) throw new Error((label || '断言') + ' 不成立');
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-analyze-'));

// ---------------------------------------------------------------- 素材样例 ---

const FFPROBE_JSON = JSON.stringify({
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      avg_frame_rate: '30000/1001',
      r_frame_rate: '30000/1001',
      duration: '6.000000',
      disposition: { attached_pic: 0 },
    },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '6.020000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
});

// 真实 stderr 片段（本机 ffmpeg 跑 select/showinfo 时抓下来的，连列宽都照抄）
const REAL_SHOWINFO = [
  '[Parsed_showinfo_1 @ 00000163591ee1c0] n:   0 pts:  25600 pts_time:2      duration:    512 duration_time:0.04    fmt:yuv420p cl:left sar:1/1 s:320x240 i:P iskey:0 type:B',
  '[Parsed_showinfo_1 @ 00000163591ee1c0] n:   1 pts:  51200 pts_time:4      duration:    512 duration_time:0.04    fmt:yuv420p cl:left sar:1/1 s:320x240 i:P iskey:1 type:I',
  'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'cut.mp4\':',
  '  Duration: 00:00:06.00, start: 0.000000, bitrate: 22 kb/s',
].join('\n');

// ------------------------------------------------------------- 注入式进程 ---

/**
 * 假的进程实现：按参数认出 ffprobe / 场景检测 / 取色 / 取灰度 / 导帧，
 * 并记录同时在跑的进程数（用来验证并发上限）。
 */
function makeStub(options = {}) {
  const { pts = [2, 4], duration = 6, delayMs = 5, failOn = null } = options;
  const stats = { calls: 0, active: 0, maxActive: 0, byKind: {} };

  const run = async (command, args) => {
    const joined = args.join(' ');
    let kind = 'other';
    if (joined.includes('-print_format')) kind = 'ffprobe';
    else if (joined.includes('-f null')) kind = 'detect';
    else if (joined.includes('rgb24')) kind = 'rgb';
    else if (joined.includes('gray')) kind = 'gray';
    else if (/\.jpg"?$/.test(joined)) kind = 'frame';

    stats.calls += 1;
    stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
    stats.active += 1;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    try {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (failOn && failOn === kind) {
        const error = new Error('stub 故意失败：' + kind);
        error.code = 'PROCESS_FAILED';
        error.details = { stderrTail: 'stub stderr tail' };
        throw error;
      }
      if (kind === 'ffprobe') return { stdout: Buffer.from(FFPROBE_JSON), stderr: '', code: 0 };
      if (kind === 'detect') {
        const lines = pts.map(
          (t, i) =>
            `[Parsed_showinfo_1 @ 0000] n:   ${i} pts:  ${t * 25600} pts_time:${t} duration:    512 duration_time:0.04    fmt:yuv420p s:320x240`,
        );
        const stderr = ['Input #0, mov,mp4:', `  Duration: 00:00:0${duration}.00, start: 0.000000`, ...lines].join('\n');
        return { stdout: Buffer.alloc(0), stderr, code: 0 };
      }
      if (kind === 'rgb') return { stdout: Buffer.from([10, 20, 30]), stderr: '', code: 0 };
      if (kind === 'gray') return { stdout: Buffer.from([90]), stderr: '', code: 0 };
      if (kind === 'frame') return { stdout: Buffer.alloc(0), stderr: '', code: 0 };
      return { stdout: Buffer.alloc(0), stderr: '', code: 0 };
    } finally {
      stats.active -= 1;
    }
  };

  return { run, stats };
}

console.log('视频解析测试');

// ------------------------------------------------------------ 1. 元信息 ---

await step('ffprobe 输出解析：时长/尺寸/帧率/编码/有无音轨', () => {
  const meta = parseFfprobe(JSON.parse(FFPROBE_JSON));
  ok(meta, 'meta 应该解析出来');
  eq(meta.duration, 6, 'duration');
  eq(meta.width, 1920, 'width');
  eq(meta.height, 1080, 'height');
  near(meta.fps, 29.97, 0.01, 'fps');
  eq(meta.codec, 'h264', 'codec');
  eq(meta.hasAudio, true, 'hasAudio');
});

await step('ffprobe 输出解析：纯音频 / 封面图不算视频流', () => {
  const audioOnly = parseFfprobe({ streams: [{ codec_type: 'audio', codec_name: 'aac' }], format: { duration: '3' } });
  eq(audioOnly, null, '只有音轨时应返回 null');
  const coverOnly = parseFfprobe({
    streams: [{ codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 }, width: 100, height: 100 }],
    format: { duration: '3' },
  });
  eq(coverOnly, null, '只有封面图时应返回 null');
});

// -------------------------------------------------------- 2. showinfo 解析 ---

await step('showinfo 的 pts_time 提取（真实 stderr 样例）', () => {
  const pts = parseShowinfoPts(REAL_SHOWINFO);
  eq(pts.length, 2, '切点个数');
  eq(pts[0], 2, '第一个切点');
  eq(pts[1], 4, '第二个切点');
  const duration = parseDurationStamp(REAL_SHOWINFO);
  eq(duration, 6, '从 Duration: 行读总时长');
});

await step('showinfo 提取要忽略坏行与非切点行', () => {
  const text = [
    'Duration: 00:00:10.00, start: 0.000000',
    'frame=   12 fps=0.0 q=0.0 size=N/A time=00:00:00.48 bitrate=N/A',
    '[Parsed_showinfo_1 @ x] n:   0 pts:  10240 pts_time:0.4  duration:512',
    '[Parsed_showinfo_1 @ x] n:   1 pts:  51200 pts_time:N/A duration:512',
    '[Parsed_showinfo_1 @ x] n:   2 pts:  76800 pts_time:3.0 duration:512',
  ].join('\n');
  const pts = parseShowinfoPts(text);
  eq(pts.length, 2, '只保留两个有效 pts_time');
  eq(pts[0], 0.4, '第一个');
  eq(pts[1], 3, '第二个');
});

// ------------------------------------------------------------ 3. 切点合成 ---

await step('切点合成：补上首尾，切口落在 2s / 4s', () => {
  const shots = composeShots([2, 4], 6);
  eq(shots.length, 3, '镜头数');
  eq(shots[0].start, 0, '首镜从 0 开始');
  eq(shots[0].end, 2, '首镜在 2 结束');
  eq(shots[2].end, 6, '末镜补到总时长');
  eq(shots[2].duration, 2, '末镜时长');
});

await step('切点合成：单镜头视频也稳定返回 1 个镜头', () => {
  const shots = composeShots([], 6);
  eq(shots.length, 1, '镜头数');
  eq(shots[0].start, 0, 'start');
  eq(shots[0].end, 6, 'end');
  eq(composeShots([], 0).length, 0, '时长未知时不出镜头');
});

await step('切点合成：越界与重复切点被丢掉，不产生碎镜头', () => {
  const shots = composeShots([0.01, 0.02, 2, 2.03, 5.99, 7], 6);
  eq(shots.length, 2, '镜头数');
  eq(shots[0].end, 2, '保留 2s 那个切点');
  const tiny = composeShots([2, 2.02], 6);
  eq(tiny.length, 2, '相差 0.02s 的两个切点合成一个');
});

await step('切点合成：超过 maxShots 时合并最短镜头，整片覆盖不变', () => {
  const cuts = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const shots = composeShots(cuts, 10, { maxShots: 3 });
  eq(shots.length, 3, '镜头数被压到上限');
  eq(shots[0].start, 0, '仍然从 0 开始');
  eq(shots[shots.length - 1].end, 10, '仍然覆盖到结尾');
  const total = shots.reduce((sum, s) => sum + s.duration, 0);
  near(total, 10, 0.001, '总时长');
});

await step('统计聚合：平均/最短/最长/切点密度/主色/亮度方差', () => {
  const shots = [
    { index: 1, duration: 1, color: { r: 0, g: 0, b: 0 }, brightness: 10 },
    { index: 2, duration: 3, color: { r: 200, g: 100, b: 50 }, brightness: 30 },
  ];
  const stats = summarize(shots, 4);
  eq(stats.shotCount, 2, 'shotCount');
  eq(stats.avgShot, 2, 'avgShot');
  eq(stats.shortest, 1, 'shortest');
  eq(stats.longest, 3, 'longest');
  eq(stats.cutRate, 0.25, 'cutRate = 切点/秒');
  eq(stats.brightnessAvg, 20, 'brightnessAvg');
  eq(stats.brightnessVariance, 100, 'brightnessVariance');
  ok(stats.colorPalette.length >= 1, '应该有主色');
  ok(/^#[0-9a-f]{6}$/.test(stats.colorPalette[0].hex), '主色是 #rrggbb：' + stats.colorPalette[0].hex);
  eq(paceFor(0.4), 'fast', '0.4s/镜 → fast');
  eq(paceFor(2), 'medium', '2s/镜 → medium');
  eq(paceFor(8), 'slow', '8s/镜 → slow');
});

// -------------------------------------------------------------- 4. 进程层 ---

await step('frameStats 的 rgb 解析：3 字节 → {r,g,b}，1 字节 → brightness', async () => {
  const stub = makeStub();
  const value = await frameStats('ffmpeg.exe', 'x.mp4', 1.5, { run: stub.run });
  ok(value, 'frameStats 应返回对象');
  eq(value.r, 10, 'r');
  eq(value.g, 20, 'g');
  eq(value.b, 30, 'b');
  eq(value.brightness, 90, 'brightness');
});

await step('frameStats 进程失败返回 null（不抛）', async () => {
  const stub = makeStub({ failOn: 'rgb' });
  const value = await frameStats('ffmpeg.exe', 'bad.mp4', 1, { run: stub.run });
  eq(value, null, '坏文件时应是 null');
});

await step('extractFrame 进程失败返回 null（不抛）', async () => {
  const stub = makeStub({ failOn: 'frame' });
  const out = path.join(tmpRoot, 'frames', 'x.jpg');
  const value = await extractFrame('ffmpeg.exe', 'bad.mp4', 1, out, { run: stub.run });
  eq(value, null, '失败时应是 null');
});

await step('ffprobeJson：没有视频流时报 NO_VIDEO_STREAM', async () => {
  const run = async () => ({ stdout: Buffer.from(JSON.stringify({ streams: [{ codec_type: 'audio' }] })), stderr: '', code: 0 });
  let caught = null;
  try {
    await ffprobeJson('ffprobe.exe', 'a.mp3', { run });
  } catch (e) {
    caught = e;
  }
  ok(caught, '应该抛错');
  eq(caught.code, 'NO_VIDEO_STREAM', '错误码');
});

await step('detectShots：stub 的 pts_time → 三个镜头', async () => {
  const stub = makeStub();
  const shots = await detectShots('ffmpeg.exe', 'cut.mp4', { run: stub.run });
  eq(shots.length, 3, '镜头数');
  eq(stub.stats.byKind.detect, 1, '只跑一次场景检测');
});

// ------------------------------------------------------------ 5. 完整流程 ---

await step('analyzeVideo：stub 进程下的完整流程（含并发上限 3）', async () => {
  const stub = makeStub();
  const root = path.join(tmpRoot, 'proj-e2e');
  const result = await analyzeVideo({
    ffmpegPath: 'ffmpeg.exe',
    ffprobePath: 'ffprobe.exe',
    file: 'D:/fake/cut.mp4',
    framesDir: framesDirFor(root),
    root,
    run: stub.run,
  });

  ok(result.ok, '结果应成功：' + JSON.stringify(result.error || {}));
  eq(result.shots.length, 3, '镜头数');
  eq(result.stats.shotCount, 3, 'shotCount');
  eq(result.shots[0].index, 1, '序号从 1 开始');
  eq(result.shots[0].framePath, 'analysis/frames/shot-001.jpg', 'framePath 是工程内相对路径');
  eq(result.shots[0].color.r, 10, '代表色 r');
  eq(result.shots[0].brightness, 90, '亮度');
  eq(result.pace, 'medium', 'pace');
  ok(result.hint.includes('3 个镜头'), 'hint 要说人话：' + result.hint);
  eq(stub.stats.maxActive, 3, '同时最多 3 个 ffmpeg 进程');
  // 1 次 ffprobe + 1 次场景检测 + 每镜（取色 + 灰度 + 导帧）
  eq(stub.stats.calls, 2 + 3 * 3, '进程调用总数');

  const saved = await readAnalysis(root);
  ok(saved, '应该落盘了 analysis.json');
  eq(saved.stats.shotCount, 3, '落盘的镜头数');
  eq(saved.path, undefined, '落盘内容不重复写 path 字段');
});

await step('analyzeVideo：落盘是原子的，读回内容一致', async () => {
  const root = path.join(tmpRoot, 'proj-atomic');
  await fs.mkdir(root, { recursive: true });
  await writeAnalysis(root, { ok: true, shots: [{ index: 1 }], stats: { shotCount: 1 } });
  const first = await readAnalysis(root);
  eq(first.stats.shotCount, 1, '第一次读回');
  await writeAnalysis(root, { ok: true, shots: [], stats: { shotCount: 0 } });
  const second = await readAnalysis(root);
  eq(second.stats.shotCount, 0, '覆盖后读回');
  const leftovers = (await fs.readdir(root)).filter((n) => n.includes('.tmp-'));
  eq(leftovers.length, 0, '不应留下临时文件');
});

await step('analyzeVideo：坏文件返回 ok:false（真实错误不吞）', async () => {
  const stub = makeStub({ failOn: 'ffprobe' });
  const result = await analyzeVideo({
    ffmpegPath: 'ffmpeg.exe',
    ffprobePath: 'ffprobe.exe',
    file: 'D:/fake/broken.mp4',
    framesDir: framesDirFor(path.join(tmpRoot, 'proj-bad')),
    run: stub.run,
  });
  eq(result.ok, false, '应该是失败结果');
  ok(/ffprobe|stub/.test(result.error.message), '错误消息要带真实原因：' + result.error.message);
  eq(result.error.stderrTail, 'stub stderr tail', 'stderr 尾巴要带回来');
});

await step('readAnalysis：没有文件 / 坏 JSON 都返回 null 不抛', async () => {
  eq(await readAnalysis(path.join(tmpRoot, 'nope')), null, '目录不存在');
  const broken = path.join(tmpRoot, 'proj-broken');
  await fs.mkdir(broken, { recursive: true });
  await fs.writeFile(analysisPath(broken), '{ 这不是 JSON', 'utf8');
  eq(await readAnalysis(broken), null, '坏 JSON');
});

await step('createLimiter：并发不超过上限', async () => {
  const limit = createLimiter(2);
  let active = 0;
  let maxActive = 0;
  await Promise.all(
    [0, 1, 2, 3, 4, 5].map(() =>
      limit(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      }),
    ),
  );
  eq(maxActive, 2, '同时最多 2 个');
});

await step('exec：超时会杀掉进程并报 ETIMEDOUT', async () => {
  let caught = null;
  const started = Date.now();
  try {
    await exec(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 300 });
  } catch (e) {
    caught = e;
  }
  ok(caught, '应该抛超时');
  eq(caught.code, 'ETIMEDOUT', '错误码');
  ok(Date.now() - started < 5000, '不能真的等 10 秒');
});

// ------------------------------------------------------------- 6. 防回归 ---

await step('导入路径上没有自动解析（media.mjs 不碰 analyze）', async () => {
  const media = await fs.readFile(path.resolve(import.meta.dirname, '../src/media.mjs'), 'utf8');
  ok(!/analyze/i.test(media), 'media.mjs 里不应出现 analyze：导入时不能自动解析');
});

// ------------------------------------------------------------- 7. 真机跑 ---

const paths = asrPaths();
const ffmpegPath = paths.ffmpeg;
const ffprobePath = path.join(paths.ffmpegDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');

let hasFfmpeg = false;
try {
  await fs.access(ffmpegPath);
  await fs.access(ffprobePath);
  hasFfmpeg = true;
} catch {
  hasFfmpeg = false;
}

if (!hasFfmpeg) {
  skipStep('真实视频端到端（≥3 镜头）', '没找到 ' + ffmpegPath);
} else {
  const video = path.join(tmpRoot, 'cut.mp4');
  console.log('  … 造测试视频：testsrc + 纯红 + smptebars，各 2 秒，中间两次硬切');
  await exec(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=25',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=320x240:rate=25',
      '-f',
      'lavfi',
      '-i',
      'smptebars=size=320x240:rate=25',
      '-filter_complex',
      '[0:v]trim=0:2,setpts=PTS-STARTPTS[a];[1:v]trim=0:2,setpts=PTS-STARTPTS[b];[2:v]trim=0:2,setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1:a=0[out]',
      '-map',
      '[out]',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-t',
      '6',
      video,
    ],
    { timeoutMs: 60 * 1000 },
  );

  await step('真实视频端到端：6 秒 3 镜，主色与节奏算得出来', async () => {
    const root = path.join(tmpRoot, 'proj-real');
    const started = Date.now();
    const result = await analyzeVideo({
      ffmpegPath,
      ffprobePath,
      file: video,
      framesDir: framesDirFor(root),
      root,
    });
    const elapsed = Date.now() - started;
    ok(result.ok, '真实解析应成功：' + JSON.stringify(result.error || {}));
    ok(result.meta.duration >= 5.9 && result.meta.duration <= 6.1, '时长应约 6 秒：' + result.meta.duration);
    ok(result.shots.length >= 3, '应检出 ≥3 个镜头，实际 ' + result.shots.length);
    eq(result.meta.width, 320, 'width');
    eq(result.meta.height, 240, 'height');
    ok(result.stats.colorPalette.length >= 1, '应有主色');
    const frames = (await fs.readdir(framesDirFor(root))).filter((n) => n.endsWith('.jpg'));
    eq(frames.length, result.shots.length, '每镜一张代表帧');
    const saved = await readAnalysis(root);
    ok(saved && saved.stats.shotCount === result.shots.length, '重启后能读回同一份结果');
    console.log(
      `       → ${result.stats.shotCount} 镜 · 平均 ${result.stats.avgShot}s · ` +
        `最短 ${result.stats.shortest}s / 最长 ${result.stats.longest}s · ` +
        `切点密度 ${result.stats.cutRate}/s · 主色 ${result.stats.colorPalette[0].hex} · ` +
        `亮度 ${result.stats.brightnessAvg} · 耗时 ${elapsed}ms`,
    );
    console.log('       → ' + result.hint);
  });

  await step('RPC analyze.run / analyze.read 端到端（真 ffmpeg）', async () => {
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
    ok(rpcRoute, 'RPC 路由应该注册上了');

    async function call(method, params) {
      const req = new EventEmitter();
      req.method = 'POST';
      req.url = '/api/video/rpc';
      setTimeout(() => {
        req.emit('data', Buffer.from(JSON.stringify({ method, params })));
        req.emit('end');
      }, 0);
      const res = {
        statusCode: 0,
        headers: {},
        setHeader() {},
        end(chunk) {
          this.body = chunk;
          this.done = true;
        },
      };
      await rpcRoute.handler(req, res);
      const payload = JSON.parse(res.body);
      if (!payload.ok) throw new Error(`${method}: ${payload.error.code} ${payload.error.message}`);
      return payload.value;
    }

    const projectRoot = path.join(tmpRoot, 'proj-rpc');
    const opened = await call('project.open', { dir: projectRoot, sessionId: 'session-analyze' });
    await fs.mkdir(path.join(projectRoot, 'assets'), { recursive: true });
    await fs.copyFile(video, path.join(projectRoot, 'assets', 'cut.mp4'));

    const value = await call('analyze.run', {
      projectId: opened.doc.projectId,
      sessionId: 'session-analyze',
      assetPath: 'assets/cut.mp4',
    });
    ok(value.ok, 'RPC 解析应成功：' + JSON.stringify(value.error || {}));
    ok(value.shots.length >= 3, 'RPC 也应有 ≥3 镜头，实际 ' + value.shots.length);
    ok(String(value.path).endsWith('analysis.json'), 'path 应指向 analysis.json：' + value.path);
    eq(value.assetPath, 'assets/cut.mp4', 'assetPath 回显');

    const read = await call('analyze.read', { projectId: opened.doc.projectId, sessionId: 'session-analyze' });
    ok(read.ok === true, '重启后 analyze.read 应读回');
    eq(read.stats.shotCount, value.shots.length, '读回的镜头数');

    // 没解析过的工程：ok:false + 中文原因，不抛
    const fresh = await call('project.open', { dir: path.join(tmpRoot, 'proj-empty'), sessionId: 'session-empty' });
    const none = await call('analyze.read', { projectId: fresh.doc.projectId, sessionId: 'session-empty' });
    eq(none.ok, false, '没解析过应为 ok:false');
    eq(none.reason, '还没解析过', '原因文案');
  });

  await step('runAnalysis：超过总时限 → ANALYZE_TIMEOUT（不会吊死请求）', async () => {
    const store = new ProjectStore();
    const doc = await store.open(path.join(tmpRoot, 'proj-timeout'), 'session-timeout');
    await fs.mkdir(path.join(doc.root, 'assets'), { recursive: true });
    await fs.copyFile(video, path.join(doc.root, 'assets', 'cut.mp4'));

    // 注入一个只听 abort 的假进程：总时限一到就必须 reject，而不是永远等
    const hangingRun = (command, args, options) =>
      new Promise((resolve, reject) => {
        const { signal } = options || {};
        if (!signal) return; // 永远不会 settle
        signal.addEventListener('abort', () => {
          const error = new Error('stub 被取消');
          error.code = 'ANALYZE_ABORTED';
          reject(error);
        });
      });

    const started = Date.now();
    let caught = null;
    try {
      await runAnalysis({
        store,
        projectId: doc.projectId,
        sessionId: 'session-timeout',
        assetPath: 'assets/cut.mp4',
        totalTimeoutMs: 1200,
        run: hangingRun,
      });
    } catch (e) {
      caught = e;
    }
    ok(caught, '应抛超时错误');
    eq(caught.code, 'ANALYZE_TIMEOUT', '错误码');
    ok(/超时/.test(caught.message), '消息要说超时：' + caught.message);
    ok(Date.now() - started < 8000, '不能一直等下去');
  });

  await step('工具定义：说明里写明「只在用户要求时调用」，参数带 assetPath', async () => {
    const { analyzeTools } = await import('../src/analyze-tools.mjs');
    const tools = analyzeTools({ store: new ProjectStore() });
    const names = tools.map((t) => t.name);
    ok(names.includes('video_analyze'), '要有 video_analyze');
    ok(names.includes('video_analysis_read'), '要有 video_analysis_read');
    const def = tools.find((t) => t.name === 'video_analyze');
    ok(/只在用户明确要求/.test(def.description), '描述要限定调用时机');
    ok(/不要自动调用/.test(def.description), '描述要禁止自动跑');
    eq(def.parameters.properties.assetPath.type, 'string', 'assetPath 类型');
    ok(def.parameters.properties.maxShots, '要能传 maxShots');
  });
}

await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
