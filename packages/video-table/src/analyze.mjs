/**
 * 视频解析：镜头切点、代表帧、主色与亮度、节奏统计。
 *
 * 三条设计约束（都是刻意的，别「优化」掉）：
 *
 *   1. 只做「被要求时」才跑。导入素材、打开工程都不会调用这里的任何函数，
 *      唯一入口是 tool `video_analyze` 和 RPC `analyze.run`（都由用户点按钮触发）。
 *   2. 纯函数与进程调用分离。stderr 解析、切点合成、统计聚合都是纯函数，
 *      可以拿真实 ffmpeg 输出文本单测；进程出口只有 exec() 一个，测试可注入。
 *   3. 失败说人话。坏文件 / 没有视频流 / ffmpeg 崩了，都带着 stderr 尾巴回来，
 *      不吞成「未知错误」，也不用 null 冒充成功。
 *
 * 进程上限：抽帧阶段最多同时 3 个 ffmpeg（MAX_CONCURRENT_FFMPEG），
 * 3 分钟以上的片子也不至于把机器打满。
 */

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { stderrTail } from './asr.mjs';

/** 结果文件名（工程根目录下） */
export const ANALYSIS_FILE = 'analysis.json';
/** 代表帧子目录（相对工程根目录） */
export const FRAMES_SUBDIR = 'analysis/frames';
/** 场景切分阈值：ffmpeg 的 scene 分数，0.3 是口播/剪辑片的常用值 */
export const DEFAULT_THRESHOLD = 0.3;
/** 镜头数上限：超过就把最短的镜头合并回去，保证首尾仍然覆盖整片 */
export const DEFAULT_MAX_SHOTS = 200;
/** 同时运行的 ffmpeg 进程数上限 */
export const MAX_CONCURRENT_FFMPEG = 3;
/** 结果结构版本：以后字段变了靠它判断兼容 */
export const ANALYSIS_VERSION = 1;

export const PROBE_TIMEOUT_MS = 20 * 1000;
export const DETECT_TIMEOUT_MS = 120 * 1000;
export const FRAME_TIMEOUT_MS = 20 * 1000;
/** stderr 最多留这么多字节：切点可能很多，但也不该无上限 */
const MAX_STDERR = 8 * 1024 * 1024;

// ------------------------------------------------------------------ 错误 ---

export class AnalyzeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AnalyzeError';
    this.code = code || 'ANALYZE_FAILED';
    if (details) this.details = details;
  }
}

function baseName(command) {
  try {
    return path.basename(String(command));
  } catch {
    return String(command);
  }
}

function wrapError(e, prefix) {
  if (e instanceof AnalyzeError) return e;
  const tail = (e && e.details && e.details.stderrTail) || '';
  return new AnalyzeError('ANALYZE_FAILED', `${prefix}：${(e && e.message) || e}`, { stderrTail: tail });
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function round1(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value == null) return Buffer.alloc(0);
  return Buffer.from(String(value), 'utf8');
}

function toText(value) {
  return toBuffer(value).toString('utf8');
}

// ------------------------------------------------------------ 进程出口 ---

/**
 * 唯一的生产进程出口。返回 { stdout: Buffer, stderr: string, code: 0 }。
 * 失败抛 AnalyzeError，details.stderrTail 里是 ffmpeg/ffprobe 的原话。
 *
 * options:
 *   timeoutMs  超时（kill 后 reject ETIMEDOUT）
 *   signal     AbortSignal，取消即杀进程
 *   run        进程实现，测试注入用（生产路径永远不传）
 */
export function exec(command, args = [], options = {}) {
  const { timeoutMs = PROBE_TIMEOUT_MS, signal } = options;
  return new Promise((resolve, reject) => {
    if (!command) {
      reject(new AnalyzeError('NO_COMMAND', '没有给出可执行文件路径'));
      return;
    }
    if (signal && signal.aborted) {
      reject(new AnalyzeError('ANALYZE_ABORTED', '解析已取消：' + baseName(command)));
      return;
    }

    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(
        new AnalyzeError(
          e && e.code === 'ENOENT' ? 'NOT_FOUND' : 'SPAWN_FAILED',
          `${e && e.code === 'ENOENT' ? '找不到可执行文件' : '启动进程失败'}：${command}`,
          { cause: String((e && e.message) || e) },
        ),
      );
      return;
    }

    const chunkOut = [];
    let stderrAll = '';
    let timer = null;
    let settled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const kill = (error) => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经死了 */
      }
      const withTail = Object.assign(error, {
        details: { ...(error.details || {}), stderrTail: stderrTail(stderrAll) },
      });
      settle(reject, withTail);
    };
    const onAbort = () =>
      kill(new AnalyzeError('ANALYZE_ABORTED', '解析已取消：' + baseName(command), { command: String(command) }));

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(
      () =>
        kill(
          new AnalyzeError('ETIMEDOUT', `执行超时（${Math.round(timeoutMs / 1000)} 秒）：${baseName(command)}`, {
            command: String(command),
            timeoutMs,
          }),
        ),
      Math.max(50, timeoutMs),
    );

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      chunkOut.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      if (settled) return;
      stderrAll = stderrTail(stderrAll + chunk.toString('utf8'), MAX_STDERR);
    });

    child.on('error', (e) =>
      settle(
        reject,
        new AnalyzeError('SPAWN_FAILED', `启动进程失败：${command}（${(e && e.message) || e}）`, {
          command: String(command),
        }),
      ),
    );

    child.on('close', (code, sig) => {
      if (settled) return;
      if (code !== 0) {
        settle(
          reject,
          new AnalyzeError('PROCESS_FAILED', `${baseName(command)} 退出码 ${code}${sig ? '（' + sig + '）' : ''}`, {
            command: String(command),
            exitCode: code,
            signal: sig || null,
            stderrTail: stderrTail(stderrAll),
          }),
        );
        return;
      }
      settle(resolve, { stdout: Buffer.concat(chunkOut), stderr: stderrAll, code: 0 });
    });
  });
}

/** 并发闸门：同时最多 limit 个任务，其余排队。 */
export function createLimiter(limit) {
  const max = Math.max(1, Number(limit) || 1);
  let active = 0;
  const queue = [];
  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };
  return (task) =>
    new Promise((resolve, reject) => {
      const start = () => {
        active += 1;
        Promise.resolve()
          .then(task)
          .then(
            (value) => {
              release();
              resolve(value);
            },
            (error) => {
              release();
              reject(error);
            },
          );
      };
      if (active < max) start();
      else queue.push(start);
    });
}

// ------------------------------------------------------------ 纯函数解析 ---

/** 把 "30000/1001" 这类帧率字符串变成数字；坏值返回 null。 */
export function parseFrameRate(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(text);
  if (m) {
    const num = Number(m[1]);
    const den = Number(m[2]);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0) return null;
    return round3(num / den);
  }
  const direct = Number(text);
  return Number.isFinite(direct) && direct > 0 ? round3(direct) : null;
}

/**
 * ffprobe 的 JSON → { duration, width, height, fps, codec, hasAudio }。
 * 没有视频流返回 null（调用方据此报「这不是视频」）。
 * 封面图（disposition.attached_pic）不算视频流。
 */
export function parseFfprobe(probe) {
  const value = typeof probe === 'string' ? safeJson(probe) : probe;
  if (!value || typeof value !== 'object') return null;
  const streams = Array.isArray(value.streams) ? value.streams : [];
  const video = streams.find(
    (s) => s && s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic),
  );
  if (!video) return null;
  const format = value.format && typeof value.format === 'object' ? value.format : {};

  const durationCandidates = [video.duration, format.duration];
  let duration = 0;
  for (const candidate of durationCandidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) {
      duration = n;
      break;
    }
  }

  const fps = parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate) || null;
  return {
    duration: round3(duration),
    width: Number(video.width) > 0 ? Number(video.width) : null,
    height: Number(video.height) > 0 ? Number(video.height) : null,
    fps,
    codec: video.codec_name ? String(video.codec_name) : null,
    hasAudio: streams.some((s) => s && s.codec_type === 'audio'),
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 从 showinfo 的 stderr 里抠出所有 pts_time。
 *
 * 真实输出长这样（Windows 上是一行一条）：
 *   [Parsed_showinfo_1 @ 00000163591ee1c0] n:   0 pts:  25600 pts_time:2  duration: ... 
 * 只看 pts_time，别的字段一律忽略 —— 不同版本 ffmpeg 的列宽不一样。
 */
export function parseShowinfoPts(text) {
  const out = [];
  const source = String(text == null ? '' : text);
  const re = /pts_time:\s*(-?\d+(?:\.\d+)?)/g;
  let m = re.exec(source);
  while (m) {
    const value = Number(m[1]);
    if (Number.isFinite(value) && value >= 0) out.push(round3(value));
    m = re.exec(source);
  }
  return out;
}

/** 从 ffmpeg 的输入信息里读总时长（没有 ffprobe 结果时的兜底）。 */
export function parseDurationStamp(text) {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(String(text == null ? '' : text));
  if (!m) return null;
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(seconds) && seconds > 0 ? round3(seconds) : null;
}

/**
 * 切点 + 总时长 → 镜头表 [{ start, end, duration }]。
 *
 * 规则：
 *   - 补上首尾（0 和 duration），所以单镜头视频也稳定返回 1 个镜头
 *   - 丢掉过于靠近首尾、或彼此相距不到 minShot 的切点（同一次剪辑常被检出两帧）
 *   - 镜头数超过 maxShots 时，反复合并「两侧最短」的那个边界，整片覆盖不变
 */
export function composeShots(cuts, duration, options = {}) {
  const maxShots = Math.max(1, Number(options.maxShots) || DEFAULT_MAX_SHOTS);
  const minShot = Number(options.minShot) > 0 ? Number(options.minShot) : 0.05;
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 0) return [];

  const sorted = (Array.isArray(cuts) ? cuts : [])
    .map((c) => Number(c))
    .filter((v) => Number.isFinite(v) && v > minShot && v < total - minShot)
    .sort((a, b) => a - b);

  const unique = [];
  for (const value of sorted) {
    if (unique.length && value - unique[unique.length - 1] < minShot) continue;
    unique.push(value);
  }

  let bounds = [0, ...unique, total];
  while (bounds.length - 1 > maxShots) {
    // 找「合并后损失最小」的内部边界：它左右两侧中较短的那一段最短
    let bestIndex = 1;
    let bestLen = Infinity;
    for (let i = 1; i < bounds.length - 1; i += 1) {
      const len = Math.min(bounds[i] - bounds[i - 1], bounds[i + 1] - bounds[i]);
      if (len < bestLen) {
        bestLen = len;
        bestIndex = i;
      }
    }
    bounds.splice(bestIndex, 1);
  }

  const shots = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const start = round3(bounds[i]);
    const end = round3(bounds[i + 1]);
    const d = round3(end - start);
    if (d <= 0) continue;
    shots.push({ start, end, duration: d });
  }
  return shots;
}

/** 节奏：按平均镜头长度分档（切得越碎越快）。 */
export function paceFor(avgShot) {
  const avg = Number(avgShot);
  if (!Number.isFinite(avg) || avg <= 0) return 'medium';
  if (avg <= 1.5) return 'fast';
  if (avg >= 4) return 'slow';
  return 'medium';
}

// ------------------------------------------------------------ 进程封装 ---

/** ffprobe → 元信息。读不了就抛 AnalyzeError（带 stderr 尾巴）。 */
export async function ffprobeJson(ffprobePath, file, options = {}) {
  const run = typeof options.run === 'function' ? options.run : exec;
  const args = ['-hide_banner', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', String(file)];
  let out;
  try {
    out = await run(ffprobePath, args, {
      timeoutMs: options.timeoutMs || PROBE_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch (e) {
    throw wrapError(e, 'ffprobe 读不了这个文件');
  }
  const text = toText(out && out.stdout);
  const parsed = safeJson(text);
  if (!parsed) {
    throw new AnalyzeError('BAD_PROBE', 'ffprobe 的输出不是 JSON，文件可能损坏或路径不对', {
      stderrTail: stderrTail(toText(out && out.stderr)),
    });
  }
  const meta = parseFfprobe(parsed);
  if (!meta) {
    throw new AnalyzeError('NO_VIDEO_STREAM', '这个文件里没有视频流：' + path.basename(String(file)), {
      stderrTail: stderrTail(toText(out && out.stderr)),
    });
  }
  return meta;
}

/**
 * 场景切分：跑一遍 select='gt(scene,阈值)' + showinfo，从 stderr 里收 pts_time。
 *
 * 返回 [{ start, end, duration }]；没有检出切点就是单个镜头。
 * duration 可以不给（会从 ffmpeg 的 Duration: 行兜底）。
 */
export async function detectShots(ffmpegPath, file, options = {}) {
  const run = typeof options.run === 'function' ? options.run : exec;
  const threshold = Number(options.threshold) > 0 ? Number(options.threshold) : DEFAULT_THRESHOLD;
  const maxShots = Math.max(1, Number(options.maxShots) || DEFAULT_MAX_SHOTS);
  const args = [
    '-hide_banner',
    '-nostdin',
    '-i',
    String(file),
    '-an',
    '-vf',
    `select='gt(scene,${threshold})',showinfo`,
    '-f',
    'null',
    '-',
  ];

  let out;
  try {
    out = await run(ffmpegPath, args, {
      timeoutMs: options.timeoutMs || DETECT_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch (e) {
    throw wrapError(e, '场景检测失败了');
  }

  const stderr = toText(out && out.stderr);
  const duration = Number(options.duration) > 0 ? Number(options.duration) : parseDurationStamp(stderr);
  if (!(duration > 0)) {
    // ffmpeg 正常退出却读不到时长：多半是容器没有 duration 头（流式文件）
    throw new AnalyzeError('NO_DURATION', '读不出这个视频的时长，无法确定镜头边界', {
      stderrTail: stderrTail(stderr),
    });
  }
  return composeShots(parseShowinfoPts(stderr), duration, { maxShots });
}

/** 取 1 个像素（rgb24）或 1 个灰度字节；进程失败返回 null，不抛。 */
async function readPixel(ffmpegPath, file, timeSec, vf, pixFmt, wantBytes, options) {
  const run = typeof options.run === 'function' ? options.run : exec;
  const args = [
    '-hide_banner',
    '-nostdin',
    '-ss',
    String(Math.max(0, Number(timeSec) || 0)),
    '-i',
    String(file),
    '-frames:v',
    '1',
    '-vf',
    vf,
    '-f',
    'rawvideo',
    '-pix_fmt',
    pixFmt,
    '-',
  ];
  let out;
  try {
    out = await run(ffmpegPath, args, {
      timeoutMs: options.timeoutMs || FRAME_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch {
    return null;
  }
  const bytes = toBuffer(out && out.stdout);
  return bytes.length >= wantBytes ? bytes.subarray(0, wantBytes) : null;
}

/**
 * 某一时刻的代表色与亮度。
 *
 * 两次调用：scale=1:1 rgb24 拿 3 字节 → 平均色；scale=1:1 format=gray 拿 1 字节 → 亮度。
 * 任何一个进程失败都只让那个字段为 null（整帧色失败则整体返回 null），绝不抛。
 */
export async function frameStats(ffmpegPath, file, timeSec, options = {}) {
  const rgb = await readPixel(ffmpegPath, file, timeSec, 'scale=1:1', 'rgb24', 3, options);
  if (!rgb) return null;
  const gray = await readPixel(ffmpegPath, file, timeSec, 'scale=1:1,format=gray', 'gray', 1, options);
  return {
    r: rgb[0],
    g: rgb[1],
    b: rgb[2],
    brightness: gray ? gray[0] : null,
  };
}

/**
 * 导出某一时刻的一帧 JPEG。成功返回写好的绝对路径，失败返回 null（不抛）。
 * 调用方负责给目录（analyzeVideo 会先建好 analysis/frames/）。
 */
export async function extractFrame(ffmpegPath, file, timeSec, outPath, options = {}) {
  const run = typeof options.run === 'function' ? options.run : exec;
  const width = Number(options.width) > 0 ? Math.round(Number(options.width)) : 480;
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-ss',
    String(Math.max(0, Number(timeSec) || 0)),
    '-i',
    String(file),
    '-frames:v',
    '1',
    '-vf',
    `scale=${width}:-2`,
    '-q:v',
    '4',
    String(outPath),
  ];
  try {
    await fsp.mkdir(path.dirname(String(outPath)), { recursive: true });
    const out = await run(ffmpegPath, args, {
      timeoutMs: options.timeoutMs || FRAME_TIMEOUT_MS,
      signal: options.signal,
    });
    // 退出码 0 就认为写好了；不额外 stat，测试注入的进程实现不会真的落盘
    if (out && out.code != null && out.code !== 0) return null;
    return String(outPath);
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- 统计聚合 ---

/** 主色：按 4bit/通道分桶，用镜头时长加权，取前 topN 个。 */
function colorPaletteOf(shots, topN = 5) {
  const buckets = new Map();
  let totalWeight = 0;
  for (const shot of shots) {
    const color = shot && shot.color;
    if (!color) continue;
    const weight = Number(shot.duration) > 0 ? Number(shot.duration) : 1;
    const key = ((color.r >> 4) & 0xf) * 256 + ((color.g >> 4) & 0xf) * 16 + ((color.b >> 4) & 0xf);
    const hit = buckets.get(key) || { r: 0, g: 0, b: 0, weight: 0 };
    hit.r += color.r * weight;
    hit.g += color.g * weight;
    hit.b += color.b * weight;
    hit.weight += weight;
    buckets.set(key, hit);
    totalWeight += weight;
  }
  if (!totalWeight) return [];
  return [...buckets.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, topN)
    .map((hit) => {
      const r = Math.round(hit.r / hit.weight);
      const g = Math.round(hit.g / hit.weight);
      const b = Math.round(hit.b / hit.weight);
      return { hex: hexOf(r, g, b), r, g, b, weight: round3(hit.weight / totalWeight) };
    });
}

export function hexOf(r, g, b) {
  const hex = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0))).toString(16).padStart(2, '0');
  return '#' + hex(r) + hex(g) + hex(b);
}

/** 节奏档位 → 中文（工具、面板、hint 共用一套说法） */
export function paceLabel(pace) {
  if (pace === 'fast') return '快切';
  if (pace === 'slow') return '慢切';
  return '中速';
}

function brightnessWord(avg) {
  if (!(avg > 0)) return '亮度未知';
  if (avg < 70) return '偏暗';
  if (avg > 175) return '偏亮';
  return '亮度适中';
}

/** 一句中文结论：镜头数、平均时长、节奏、主色、明暗。 */
export function buildHint(stats, pace) {
  const palette = (stats && stats.colorPalette) || [];
  const main = palette.length ? palette[0].hex : '未知';
  return (
    `${stats.shotCount} 个镜头，平均每镜 ${Number(stats.avgShot || 0).toFixed(2)}s，节奏${paceLabel(pace)}；` +
    `主色 ${main}，画面整体${brightnessWord(stats.brightnessAvg)}。`
  );
}

// -------------------------------------------------------------- 全流程 ---

/**
 * 解析一个视频。返回结构见 README / 需求：
 *   { ok, meta, shots, stats, pace, hint, path? }
 * 失败返回 { ok:false, error:{ code, message, stderrTail } } —— 不抛，让工具层决定怎么报。
 *
 * options:
 *   framesDir   代表帧目录（通常是 <root>/analysis/frames）
 *   root        给了就顺手原子写 analysis.json，并在结果里带 path
 *   maxShots / threshold / width
 *   run         进程实现（测试注入）
 *   signal      总取消信号（工具层用 60 秒超时）
 *   concurrency 同时最多几个 ffmpeg（默认 3）
 */
export async function analyzeVideo(options = {}) {
  const {
    ffmpegPath,
    ffprobePath,
    file,
    framesDir,
    root,
    maxShots = DEFAULT_MAX_SHOTS,
    threshold = DEFAULT_THRESHOLD,
    width = 480,
    signal,
    concurrency = MAX_CONCURRENT_FFMPEG,
  } = options;

  const startedAt = Date.now();
  try {
    if (!ffmpegPath) throw new AnalyzeError('NO_FFMPEG', '没有配置 ffmpeg 路径');
    if (!ffprobePath) throw new AnalyzeError('NO_FFPROBE', '没有配置 ffprobe 路径');
    if (!file) throw new AnalyzeError('INVALID_ARG', '没有给出要解析的视频文件');

    // 所有进程都走同一个闸门：抽帧阶段最多 3 个 ffmpeg 同时跑
    const rawRun = typeof options.run === 'function' ? options.run : exec;
    const limit = createLimiter(concurrency);
    const run = (command, args, runOptions) => limit(() => rawRun(command, args, runOptions));

    const meta = await ffprobeJson(ffprobePath, file, { run, signal, timeoutMs: options.probeTimeoutMs });

    const baseShots = await detectShots(ffmpegPath, file, {
      run,
      signal,
      threshold,
      maxShots,
      duration: meta.duration,
      timeoutMs: options.detectTimeoutMs,
    });

    const dir = path.resolve(String(framesDir || path.join(String(root || '.'), FRAMES_SUBDIR)));
    await fsp.mkdir(dir, { recursive: true });

    const shots = await Promise.all(
      baseShots.map(async (shot, index) => {
        const mid = shot.start + shot.duration / 2;
        const outPath = path.join(dir, `shot-${String(index + 1).padStart(3, '0')}.jpg`);
        const [stats, frame] = await Promise.all([
          frameStats(ffmpegPath, file, mid, { run, signal, timeoutMs: options.frameTimeoutMs }),
          extractFrame(ffmpegPath, file, mid, outPath, { run, signal, width, timeoutMs: options.frameTimeoutMs }),
        ]);
        return {
          index: index + 1,
          start: shot.start,
          end: shot.end,
          duration: shot.duration,
          framePath: frame ? relativeFramePath(dir, frame) : null,
          color: stats ? { r: stats.r, g: stats.g, b: stats.b } : null,
          brightness: stats ? stats.brightness : null,
        };
      }),
    );

    const stats = summarize(shots, meta.duration);
    const pace = paceFor(stats.avgShot);
    const hint = buildHint(stats, pace);

    const result = {
      ok: true,
      version: ANALYSIS_VERSION,
      analyzedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      meta: { ...meta, file: String(file) },
      shots,
      stats,
      pace,
      hint,
      framesDir: relativeUnderAnalysis(dir, dir),
    };

    if (root) {
      result.path = await writeAnalysis(root, result);
    }
    return result;
  } catch (e) {
    const error = e instanceof AnalyzeError ? e : wrapError(e, '解析失败');
    return {
      ok: false,
      error: {
        code: error.code || 'ANALYZE_FAILED',
        message: error.message,
        stderrTail: (error.details && error.details.stderrTail) || '',
      },
    };
  }
}

/** 汇总统计。纯函数，测试可以直接喂假镜头。 */
export function summarize(shots, duration) {
  const list = Array.isArray(shots) ? shots : [];
  const durations = list.map((s) => Number(s.duration) || 0).filter((d) => d > 0);
  const total = Number(duration) > 0 ? Number(duration) : durations.reduce((a, b) => a + b, 0);
  const sum = durations.reduce((a, b) => a + b, 0);
  const avgShot = durations.length ? round3(sum / durations.length) : 0;

  const brightnesses = list.map((s) => s.brightness).filter((b) => Number.isFinite(b));
  const bSum = brightnesses.reduce((a, b) => a + b, 0);
  const brightnessAvg = brightnesses.length ? round1(bSum / brightnesses.length) : null;
  const brightnessVariance = brightnesses.length
    ? round1(
        brightnesses.reduce((acc, b) => acc + (b - bSum / brightnesses.length) ** 2, 0) / brightnesses.length,
      )
    : null;

  return {
    shotCount: list.length,
    avgShot,
    shortest: durations.length ? round3(Math.min(...durations)) : 0,
    longest: durations.length ? round3(Math.max(...durations)) : 0,
    // cutRate = 每秒切点个数（shotCount - 1 个切点 / 总时长），越大越碎
    cutRate: total > 0 ? round3(Math.max(0, list.length - 1) / total) : 0,
    colorPalette: colorPaletteOf(list),
    brightnessAvg,
    brightnessVariance,
  };
}

/**
 * 工程内相对路径（posix 分隔符）。
 *
 * framesDir 约定是 <root>/analysis/frames —— 从它的父目录名能反推出工程根，
 * 于是 framePath 就能存成 "analysis/frames/shot-001.jpg" 这种可直接给人看的路径。
 * 目录不叫 analysis/frames 时（测试或临时目录）退回绝对路径，不猜。
 */
function relativeUnderAnalysis(framesDirAbs, absTarget) {
  const dir = path.resolve(String(framesDirAbs));
  const parent = path.dirname(dir);
  const target = path.resolve(String(absTarget));
  if (path.basename(parent) === 'analysis') {
    return path.relative(path.dirname(parent), target).split(path.sep).join('/');
  }
  return target.split(path.sep).join('/');
}

function relativeFramePath(framesDirAbs, absFile) {
  if (absFile == null) return null;
  return relativeUnderAnalysis(framesDirAbs, absFile);
}

// --------------------------------------------------------------- 落盘 ---

export function analysisPath(root) {
  return path.join(path.resolve(String(root)), ANALYSIS_FILE);
}

/** 原子写：先写临时文件再 rename，断电/崩溃都不会留下半个 JSON。 */
export async function writeAnalysis(root, value) {
  const target = analysisPath(root);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    await fsp.rename(tmp, target);
  } catch (e) {
    // Windows 上偶尔会遇到目标被占用：删掉再重命名一次，仍失败就把临时文件清掉
    try {
      await fsp.unlink(target);
      await fsp.rename(tmp, target);
    } catch {
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
  }
  return target;
}

/** 读回上次结果；文件不存在 / 坏了都返回 null，不抛。 */
export async function readAnalysis(root) {
  try {
    const text = await fsp.readFile(analysisPath(root), 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** frames 子目录的绝对路径。 */
export function framesDirFor(root) {
  return path.join(path.resolve(String(root)), 'analysis', 'frames');
}
