#!/usr/bin/env node
/**
 * 给本地音效库补**可测量的**声学标签。
 *
 *   node tools/analyze-sounds.mjs [--force] [--root <目录>] [--out <文件>]
 *                                 [--concurrency 4] [--json] [--quiet]
 *
 * 它测什么、怎么测（每一项都是物理量，不是听感判断）：
 *   durationMs   ffprobe 的 format.duration（读不到就用解码后的采样数兜底）
 *   attackMs     RMS 包络：从首次越过峰值 5% 到最响点的时间
 *   decayMs      最响点到「跌回峰值 -20dB」的时间（没跌到就截到文件尾，decayComplete=false）
 *   shape        由 decayMs 判：<150 短促 / 150..500 中 / >500 拖尾
 *   centroidHz   ffmpeg aspectralstats 的频谱质心，只统计比最响帧低 40dB 以内的帧，取算术均值
 *   brightness   centroidHz：<800 暗 / 800..2500 中 / >2500 亮
 *   noisiness    频谱平坦度为主、过零率为辅：平坦度 ≥0.30 噪声性 / ≤0.08 乐音性 / 其余混合
 *   pitchiness   4 倍降采样后做归一化自相关，峰值 >0.55 记「有音高」，同时记 f0Hz
 *   materialGuess 上面几项的经验组合（见 docs/sound-tags.md）
 *
 * 输出 ~/.dsh/sound-index.json：
 *   { generatedAt, analyzer:'ffmpeg+自算', caveat, version, items:{ "<根名>/<packId>/<相对路径>": {...} }, errors }
 *
 * 幂等：条目按 `size:mtimeMs` 指纹比对，没变就跳过（--force 重算）。
 * 单文件失败不中断：错误写进 errors[]，其它文件照常。
 *
 * ★ 这个脚本产出的是一组测量值和一句「不是听感结论」的说明。它不判断「好不好听」，
 *   也不该被当成「这个声音听起来像金属」的结论 —— materialGuess 的命名就是这个意思。
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { scanLocal } from '../src/sound-lib.mjs';
import {
  ANALYZER_NAME,
  MEASURED_CAVEAT,
  SHAPE_VALUES,
  BRIGHTNESS_VALUES,
  SOUND_INDEX_VERSION,
  indexKeyOf,
  soundIndexFile,
} from '../src/sound-index.mjs';

// ---------------------------------------------------------------- 常量 ---

export const SAMPLE_RATE = 44100;
/** 包络 hop：2ms。attack/decay 的分辨率就是这个数，短于它的差异不该被当真 */
export const ENVELOPE_HOP_MS = 2;
/** 包络窗：6ms。比 hop 大，避免方波式的锯齿包络 */
export const ENVELOPE_WIN_MS = 6;
/** 包络平滑窗：50ms。低频（<100Hz）周期比包络窗还长，不平滑会把引擎/低频轰鸣测成「短促」 */
export const SMOOTH_MS = 50;
/** 短于这个时长，decay 不可靠，标 tooShort */
export const TOO_SHORT_MS = 40;
/** 只分析前 180 秒；更长的文件标 truncated（整文件解码会把内存吃满） */
export const MAX_DECODE_SECONDS = 180;

/** 形状阈值（毫秒） */
export const SHAPE_THRESHOLDS = { 短促: 150, 拖尾: 500 };
/** 亮度阈值（Hz） */
export const BRIGHTNESS_THRESHOLDS = { 暗: 800, 亮: 2500 };
/** 噪声性阈值（频谱平坦度，0..1） */
export const FLATNESS_THRESHOLDS = { 噪声性: 0.3, 乐音性: 0.08 };
/** 有音高阈值（归一化自相关峰值） */
export const PITCH_THRESHOLD = 0.55;
/** 帧能量门限：比最响帧低超过 40dB 的帧不参与质心/平坦度均值 */
export const FRAME_GATE_DB = 40;

// ---------------------------------------------------------------- 进程 ---

/** 找 ffmpeg/ffprobe：显式路径 → Video依赖 → PATH */
export function resolveTools() {
  const exe = (name) => (process.platform === 'win32' ? name + '.exe' : name);
  const root = process.env.DSH_ASR_ROOT || '~\\.dsh\\video-deps';
  const bin = path.join(root, 'ffmpeg', 'bin');
  return {
    ffmpeg: process.env.DSH_FFMPEG_PATH || path.join(bin, exe('ffmpeg')),
    ffprobe: process.env.DSH_FFPROBE_PATH || path.join(bin, exe('ffprobe')),
  };
}

/** 跑一个进程，收集 stdout（Buffer）与 stderr（字符串）。永不因为退出码抛错。 */
function runProcess(bin, args, { cwd, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    const out = [];
    const err = [];
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经退出了 */
        }
        reject(new Error('进程超时（' + timeoutMs + 'ms）：' + bin));
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

/** 只留 stderr 最后一行有用的信息 */
function tailLine(text, max = 200) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.length ? lines[lines.length - 1] : '';
  return line.length > max ? line.slice(0, max) + '…' : line;
}

/** ffprobe 读时长（秒）。失败返回 null，不猜。 */
async function probeDuration(ffprobe, file) {
  const r = await runProcess(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { timeoutMs: 20000 },
  );
  if (r.code !== 0) return null;
  const text = r.stdout.toString('utf8').trim();
  const n = Number.parseFloat(text);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ------------------------------------------------------------ 元数据解析 ---

/**
 * 解析 aspectralstats/astats 每帧打印的键值块。
 *
 * ffmpeg 的输出长这样：
 *   frame:12   pts:12288  pts_time:0.278639
 *   lavfi.aspectralstats.1.centroid=1012.6
 *   lavfi.aspectralstats.1.flatness=0.00371
 *   lavfi.astats.1.RMS_level=-21.05
 *
 * 只认三件事：pts_time、centroid、flatness、RMS_level。其它键一律忽略（版本差异不炸）。
 */
export function parseFrameMeta(text) {
  const frames = [];
  let cur = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('frame:')) {
      const m = /pts_time:([-+0-9.eE]+)/.exec(line);
      cur = { ptsTime: m ? Number.parseFloat(m[1]) : null, centroid: null, flatness: null, rmsDb: null };
      frames.push(cur);
      continue;
    }
    if (!cur) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key.endsWith('.centroid')) cur.centroid = numberOrNull(value);
    else if (key.endsWith('.flatness')) cur.flatness = numberOrNull(value);
    else if (key.endsWith('.RMS_level')) cur.rmsDb = numberOrNull(value); // "-inf" → null
  }
  return frames;
}

function numberOrNull(value) {
  const n = Number.parseFloat(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- 解码 ---

/**
 * 解码成 44.1k 单声道 f32le，同一条命令里让 ffmpeg 打印频谱统计。
 *
 * 一次 ffmpeg 干两件事（PCM 走 stdout、统计写临时文件），因为 753 个文件 × 2 个进程
 * 的启动开销比听起来大。metadata 的文件名是**相对路径**，进程 cwd 指向本次运行的临时目录 ——
 * 绝对路径里的 `C:` 和反斜杠会被 filtergraph 当语法吃掉（踩过，别改回去）。
 */
async function decodeFile(file, { ffmpeg, tmpDir, metaName }) {
  const filter =
    'aspectralstats=measure=centroid+flatness,' +
    'astats=metadata=1:reset=1,' +
    'ametadata=mode=print:file=' + metaName;
  const args = [
    '-hide_banner',
    '-nostats',
    '-v',
    'error',
    '-i',
    file,
    '-map',
    '0:a:0',
    '-vn',
    '-af',
    filter,
    '-t',
    String(MAX_DECODE_SECONDS),
    '-ac',
    '1',
    '-ar',
    String(SAMPLE_RATE),
    '-f',
    'f32le',
    '-',
  ];
  const r = await runProcess(ffmpeg, args, { cwd: tmpDir, timeoutMs: 120000 });
  if (r.code !== 0) {
    throw new Error('ffmpeg 解码失败（退出码 ' + r.code + '）：' + (tailLine(r.stderr) || '无输出'));
  }
  let metaText = '';
  try {
    metaText = await fs.readFile(path.join(tmpDir, metaName), 'utf8');
  } catch {
    metaText = ''; // 元数据没写出来不是致命错：time-domain 那几项还能算
  }
  const raw = r.stdout;
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  return { pcm: new Float32Array(ab), frames: parseFrameMeta(metaText) };
}

// ------------------------------------------------------------ 时域测量 ---

/** 6ms 窗、2ms hop 的 RMS 包络 */
export function rmsEnvelope(pcm, sampleRate = SAMPLE_RATE) {
  const win = Math.max(1, Math.round((ENVELOPE_WIN_MS / 1000) * sampleRate));
  const hop = Math.max(1, Math.round((ENVELOPE_HOP_MS / 1000) * sampleRate));
  const count = pcm.length >= win ? Math.floor((pcm.length - win) / hop) + 1 : 0;
  const env = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const start = k * hop;
    let sum = 0;
    for (let i = 0; i < win; i++) {
      const v = pcm[start + i];
      sum += v * v;
    }
    env[k] = Math.sqrt(sum / win);
  }
  return { env, hopMs: (hop / sampleRate) * 1000 };
}

/**
 * 把包络按功率（平方）做滑动平均再开方。
 *
 * 为什么必须做：6ms 的窗覆盖不了低频周期（78Hz 的引擎声一个周期 12.8ms），
 * 逐帧 RMS 会跟着基频一起起伏，包络在两次脉冲之间掉到接近 0 —— 于是「5 秒的
 * 引擎循环」被测成 decay=30ms 的「短促」。平滑之后剩下的是真正的能量走向。
 * 平滑窗 50ms：小于它的一击（<40ms）本来就被标成 tooShort，不影响判定。
 */
export function smoothEnvelope(env, hopMs, smoothMs = SMOOTH_MS) {
  const n = env.length;
  const out = new Float32Array(n);
  if (!n) return out;
  const half = Math.max(0, Math.round(smoothMs / hopMs / 2));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i] * env[i];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    const power = (prefix[hi] - prefix[lo]) / (hi - lo);
    out[i] = Math.sqrt(power);
  }
  return out;
}

/**
 * 包络 → attack/decay/峰值位置。
 *
 * 峰值/衰减走**平滑包络**（50ms，见 smoothEnvelope），起音走**细包络**（6ms）：
 * 衰减是能量的宏观走向，起音是几十毫秒内的事，两个尺度不能混用。
 *
 * 三个时刻都用「门限」而不是「argmax 那一个点」来定位 —— 稳态信号（纯音、噪声）
 * 的逐帧 RMS 会抖 1%~4%，argmax 落在哪纯粹看相位，用它当峰值会算出几百毫秒的假值：
 *   峰值位置 peakIdx = 平滑包络首次达到最大值 99% 的帧
 *   attackMs        = 细包络首次达到平滑峰值 95% 的帧 − 首次达到 5% 的帧
 *   decayMs         = 峰值位置 → 平滑包络首次跌回最大值 10%（-20dB）的帧
 *
 * 整段都没跌到 10% 就截到文件尾，decayComplete=false —— 稳态持续音会落到这一类，
 * 此时 decayMs 只是「至少有这么久」，不是真衰减。
 */
export function envelopeShape(fine, smooth, hopMs) {
  const n = smooth.length;
  if (!n) return { peak: 0, peakMs: 0, attackMs: 0, decayMs: 0, decayComplete: false, silent: true };

  let peak = 0;
  for (let i = 0; i < n; i++) if (smooth[i] > peak) peak = smooth[i];

  const silent = !(peak > 1e-4); // 约 -80dBFS：低于它的整段当成数字静音
  if (silent) {
    return { peak, peakMs: 0, attackMs: 0, decayMs: 0, decayComplete: false, silent: true };
  }

  const near = peak * 0.99;
  let peakIdx = 0;
  for (let i = 0; i < n; i++) {
    if (smooth[i] >= near) {
      peakIdx = i;
      break;
    }
  }

  const onsetThr = peak * 0.05;
  let onsetIdx = 0;
  for (let i = 0; i <= peakIdx && i < fine.length; i++) {
    if (fine[i] >= onsetThr) {
      onsetIdx = i;
      break;
    }
  }

  const t95Thr = peak * 0.95;
  let t95 = peakIdx;
  for (let i = onsetIdx; i <= peakIdx && i < fine.length; i++) {
    if (fine[i] >= t95Thr) {
      t95 = i;
      break;
    }
  }

  const decayThr = peak * 0.1;
  let decayIdx = -1;
  for (let i = peakIdx; i < n; i++) {
    if (smooth[i] <= decayThr) {
      decayIdx = i;
      break;
    }
  }
  const decayComplete = decayIdx >= 0;
  if (!decayComplete) decayIdx = n - 1;

  return {
    peak,
    peakMs: peakIdx * hopMs,
    attackMs: Math.max(0, (t95 - onsetIdx) * hopMs),
    decayMs: Math.max(0, (decayIdx - peakIdx) * hopMs),
    decayComplete,
    silent: false,
  };
}

/**
 * 过零率（每秒）。只在「活跃段」上统计：包络高于峰值 2% 的第一帧到最后一帧。
 * 整段统计会让一段 3 秒的 UI 点击被尾部静音稀释，数字看着像纯音。
 */
export function zeroCrossingRate(pcm, env, hopMs, sampleRate = SAMPLE_RATE) {
  if (!pcm.length || !env.length) return 0;
  let peak = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > peak) peak = env[i];
  if (!(peak > 1e-4)) return 0;

  const thr = peak * 0.02;
  let first = -1;
  let last = -1;
  for (let i = 0; i < env.length; i++) {
    if (env[i] >= thr) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return 0;

  const hop = Math.round((hopMs / 1000) * sampleRate);
  const from = first * hop;
  const to = Math.min(pcm.length, (last + 1) * hop + Math.round((ENVELOPE_WIN_MS / 1000) * sampleRate));
  if (to - from < 2) return 0;

  let crossings = 0;
  let prev = pcm[from];
  for (let i = from + 1; i < to; i++) {
    const v = pcm[i];
    if ((prev < 0 && v >= 0) || (prev >= 0 && v < 0)) crossings += 1;
    prev = v;
  }
  return (crossings / (to - from)) * sampleRate;
}

/**
 * 音高检测：4 倍降采样（44.1k → 11.025k）后做归一化自相关。
 *
 * 为什么降采样：直接在全采样率上扫 20..1000 个 lag，每个文件要多算 4 倍；
 * 而 2kHz 以上的基频对音效库没什么意义（短促 UI 声的基频大多在 200Hz~1.5kHz）。
 * 返回 { pitched, f0Hz, correlation }。
 */
export function detectPitch(pcm, span, sampleRate = SAMPLE_RATE) {
  const factor = 4;
  const sr = sampleRate / factor;
  const from = Math.max(0, Math.floor(span && span.from >= 0 ? span.from : 0));
  const to = Math.min(pcm.length, Math.floor(span && span.to > from ? span.to : pcm.length));
  const n = Math.floor((to - from) / factor);
  if (n < 128) return { pitched: false, f0Hz: null, correlation: 0 };

  const cap = Math.min(n, 2048);
  const x = new Float32Array(cap);
  for (let i = 0; i < cap; i++) {
    let s = 0;
    for (let j = 0; j < factor; j++) s += pcm[from + i * factor + j];
    x[i] = s / factor;
  }

  let mean = 0;
  for (let i = 0; i < cap; i++) mean += x[i];
  mean /= cap;
  let energy = 0;
  for (let i = 0; i < cap; i++) {
    x[i] -= mean;
    energy += x[i] * x[i];
  }
  if (!(energy > 1e-9)) return { pitched: false, f0Hz: null, correlation: 0 };

  const minLag = Math.max(2, Math.round(sr / 2000)); // 2kHz 上限
  const maxLag = Math.min(Math.round(sr / 45), Math.floor(cap / 2)); // 45Hz 下限
  if (maxLag <= minLag + 1) return { pitched: false, f0Hz: null, correlation: 0 };

  const r = new Float32Array(maxLag - minLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0;
    let den1 = 0;
    let den2 = 0;
    for (let i = 0; i + lag < cap; i++) {
      const a = x[i];
      const b = x[i + lag];
      num += a * b;
      den1 += a * a;
      den2 += b * b;
    }
    r[lag - minLag] = den1 > 0 && den2 > 0 ? num / Math.sqrt(den1 * den2) : 0;
  }

  // 先要出现一个低谷（r ≤ 0.5），再从低谷之后找峰。
  // 没有低谷说明自相关一路缓慢衰减 —— 那是「单调包络」（一击、一段指数衰减），
  // 不是周期信号。不加这道门，「指数衰减 2 秒」会被算出 1837Hz 的假基频。
  let valley = -1;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (r[lag - minLag] <= 0.5) {
      valley = lag;
      break;
    }
  }
  if (valley < 0) return { pitched: false, f0Hz: null, correlation: Math.round(r[0] * 1000) / 1000 };

  let best = 0;
  let bestLag = 0;
  for (let lag = valley; lag <= maxLag; lag++) {
    const c = r[lag - minLag];
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }

  // 倍频防御：自相关在整数倍周期上一样高，直接取最大会掉进低八度（甚至次谐波）的坑。
  // 取「第一个足够高（≥90% 最大值）且是局部极大」的 lag —— 基频优先于它的整数倍。
  if (best > PITCH_THRESHOLD) {
    for (let lag = valley; lag < bestLag; lag++) {
      const c = r[lag - minLag];
      if (c >= best * 0.9 && c >= r[lag - minLag - 1] && c >= r[lag - minLag + 1]) {
        best = c;
        bestLag = lag;
        break;
      }
    }
  }

  return {
    pitched: best > PITCH_THRESHOLD,
    f0Hz: bestLag > 0 ? Math.round((sr / bestLag) * 10) / 10 : null,
    correlation: Math.round(best * 1000) / 1000,
  };
}

// ------------------------------------------------------------ 频域汇总 ---

/**
 * 质心与平坦度的帧均值。
 *
 * 只统计能量在「最响帧 -40dB」以内的帧：一段 3 秒的点击后面跟 2.8 秒静音，
 * 不门限的话质心会被静音帧（ffmpeg 给 0）硬拉到接近 0，测出来的就不叫质心了。
 */
export function frameStats(frames) {
  const usable = (frames || []).filter(
    (f) => f && Number.isFinite(f.centroid) && Number.isFinite(f.flatness) && f.centroid > 0,
  );
  if (!usable.length) return { centroidHz: 0, flatness: 0, frames: 0, gate: 0 };

  let maxDb = -Infinity;
  for (const f of usable) if (Number.isFinite(f.rmsDb) && f.rmsDb > maxDb) maxDb = f.rmsDb;

  // 没有 RMS 元数据（老版本 ffmpeg 或 astats 没跑起来）时不做门限，如实降级
  const gated = Number.isFinite(maxDb)
    ? usable.filter((f) => Number.isFinite(f.rmsDb) && f.rmsDb >= maxDb - FRAME_GATE_DB)
    : usable;
  const pool = gated.length ? gated : usable;

  let sumC = 0;
  let sumF = 0;
  for (const f of pool) {
    sumC += f.centroid;
    sumF += Math.min(1, Math.max(0, f.flatness));
  }
  return {
    centroidHz: sumC / pool.length,
    flatness: sumF / pool.length,
    frames: pool.length,
    gate: Number.isFinite(maxDb) ? maxDb : null,
  };
}

// ------------------------------------------------------------ 分类判定 ---

/**
 * 形状三分类。
 *
 * 一个必须单独处理的退化情形：峰值落在文件最后 100ms、而且整段都没跌到 -20dB。
 * 那多半是一段持续音（引擎、环境底噪）在结尾顶出一个尖峰 —— 从它算 decay 会得到 0ms，
 * 于是 5 秒的引擎循环被贴上「短促」。这种样本按整体时长判：1 秒以上记「拖尾」。
 */
export function classifyShape(decayMs, tooShort, { decayComplete = true, durationMs = 0, peakMs = 0 } = {}) {
  if (tooShort) return '短促';
  if (!decayComplete && durationMs >= 1000 && durationMs - peakMs < 150) return '拖尾';
  if (decayMs < SHAPE_THRESHOLDS.短促) return '短促';
  if (decayMs > SHAPE_THRESHOLDS.拖尾) return '拖尾';
  return '中';
}

export function classifyBrightness(centroidHz) {
  if (!(centroidHz > 0)) return '暗';
  if (centroidHz < BRIGHTNESS_THRESHOLDS.暗) return '暗';
  if (centroidHz > BRIGHTNESS_THRESHOLDS.亮) return '亮';
  return '中';
}

/**
 * 噪声性：平坦度是主判据（它对「能量在频带上铺得多平」敏感，对基频高低不敏感），
 * 过零率只在两端做兜底 —— 8kHz 纯音的过零率也很高（0.36 次/采样），单看过零会把纯音判成噪声。
 */
export function classifyNoisiness(flatness, zcrPerSec, sampleRate = SAMPLE_RATE) {
  const zcr = sampleRate > 0 ? zcrPerSec / sampleRate : 0;
  if (flatness >= FLATNESS_THRESHOLDS.噪声性) return '噪声性';
  if (flatness <= FLATNESS_THRESHOLDS.乐音性) {
    return zcr >= 0.42 ? '噪声性' : '乐音性'; // 平坦度算不出但有近白噪声的过零率
  }
  if (zcr >= 0.42 && flatness >= 0.2) return '噪声性';
  return '混合';
}

export function classifyPitchiness(pitched) {
  return pitched ? '有音高' : '无音高';
}

/**
 * 材质倾向：**经验映射，不是结论**。四类按下面的顺序判，先命中先返回。
 *
 *   1. 亮 + 不是噪声性            → 金属倾向（高频泛音 + 有明确谱线，敲金属的典型特征）
 *   2. 中 + 噪声性                → 塑料倾向（中频 + 宽带噪声，摩擦/塑料壳的典型特征）
 *   3. 中 + 短促                  → 木质倾向（中频 + 收得快，木头敲击的典型特征）
 *   4. 有音高 + 乐音性 + 非短促    → 合成倾向（稳态谐波 + 收得慢，合成器 pad / 持续音）
 *   5. 其余                       → 不确定
 *
 * 顺序本身是一种取舍：一个「亮 + 噪声性」的样本会落到 5（不确定），
 * 而不是硬塞进「金属」—— 宽频噪声的材质信息本来就不可靠。
 */
export function guessMaterial({ brightness, noisiness, pitchiness, shape }) {
  if (brightness === '亮' && noisiness !== '噪声性') return '金属倾向';
  if (brightness === '中' && noisiness === '噪声性') return '塑料倾向';
  if (brightness === '中' && shape === '短促') return '木质倾向';
  if (noisiness === '乐音性' && pitchiness === '有音高' && shape !== '短促') return '合成倾向';
  return '不确定';
}

// ---------------------------------------------------------------- 单文件 ---

/**
 * 测一个文件。返回索引条目（不含 key）。
 * 失败抛 Error —— 调用方决定记进 errors 还是重试。
 */
export async function analyzeFile(abs, { ffmpeg, ffprobe, tmpDir, metaName } = {}) {
  const tools = resolveTools();
  const useFfmpeg = ffmpeg || tools.ffmpeg;
  const useFfprobe = ffprobe || tools.ffprobe;
  const runDir = tmpDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sound-')));
  const meta = metaName || 'meta-' + Math.random().toString(36).slice(2, 10) + '.txt';
  const cleanupDir = !tmpDir;

  const stat = await fs.stat(abs);
  const probed = await probeDuration(useFfprobe, abs); // null 表示读不出来，不猜

  let decoded;
  try {
    decoded = await decodeFile(abs, { ffmpeg: useFfmpeg, tmpDir: runDir, metaName: meta });
  } finally {
    if (cleanupDir) {
      // 尽量把临时目录带走；带不走也不影响结果
      await fs.rm(path.join(runDir, meta), { force: true }).catch(() => {});
      await fs.rmdir(runDir).catch(() => {});
    }
  }

  const pcm = decoded.pcm;
  const decodedMs = (pcm.length / SAMPLE_RATE) * 1000;
  const durationMs = probed != null ? Math.round(probed * 1000) : Math.round(decodedMs);
  const truncated = probed != null && probed * 1000 > decodedMs + 50;

  const { env, hopMs } = rmsEnvelope(pcm);
  const smooth = smoothEnvelope(env, hopMs);
  const shape = envelopeShape(env, smooth, hopMs);
  const zcrPerSec = zeroCrossingRate(pcm, env, hopMs);
  const stats = frameStats(decoded.frames);
  const tooShort = durationMs < TOO_SHORT_MS;
  const silent = shape.silent;

  // 音高只在活跃段上算：整段带静音会把自相关稀释掉
  const span = activeSpan(env, hopMs, pcm.length);
  const pitch = silent ? { pitched: false, f0Hz: null, correlation: 0 } : detectPitch(pcm, span);

  const noisiness = silent ? '混合' : classifyNoisiness(stats.flatness, zcrPerSec);
  const brightness = classifyBrightness(stats.centroidHz);
  const pitchiness = classifyPitchiness(pitch.pitched);
  const shapeLabel = silent
    ? '短促'
    : classifyShape(shape.decayMs, tooShort, {
        decayComplete: shape.decayComplete,
        durationMs,
        peakMs: shape.peakMs,
      });

  const materialGuess = guessMaterial({
    brightness,
    noisiness,
    pitchiness,
    shape: shapeLabel,
  });

  return {
    durationMs,
    attackMs: round1(shape.attackMs),
    decayMs: round1(shape.decayMs),
    shape: shapeLabel,
    centroidHz: Math.round(stats.centroidHz),
    brightness,
    noisiness,
    pitchiness,
    materialGuess,
    // 下面这些是「为什么是这个结论」的中间量，给排查用；对外返回时会被裁掉
    zcrPerSec: Math.round(zcrPerSec),
    flatness: Math.round(stats.flatness * 10000) / 10000,
    f0Hz: pitch.f0Hz,
    autocorr: pitch.correlation,
    peakDbfs: shape.peak > 0 ? Math.round(20 * Math.log10(shape.peak) * 10) / 10 : null,
    frameCount: stats.frames,
    silent,
    tooShort,
    decayComplete: shape.decayComplete,
    truncated,
  };
}

/** 包络 ≥ 峰值 2% 的第一帧到最后一帧，换算成采样点区间 */
function activeSpan(env, hopMs, sampleCount) {
  let peak = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > peak) peak = env[i];
  if (!(peak > 1e-4)) return { from: 0, to: sampleCount };
  const thr = peak * 0.02;
  let first = -1;
  let last = -1;
  for (let i = 0; i < env.length; i++) {
    if (env[i] >= thr) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return { from: 0, to: sampleCount };
  const hop = Math.round((hopMs / 1000) * SAMPLE_RATE);
  const win = Math.round((ENVELOPE_WIN_MS / 1000) * SAMPLE_RATE);
  return { from: first * hop, to: Math.min(sampleCount, last * hop + win) };
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

// ---------------------------------------------------------------- 整库 ---

/** size + mtime 指纹：只有这两个都变才算文件变了 */
export function fingerprintOf(stat) {
  return String(stat.size) + ':' + Math.round(stat.mtimeMs);
}

/** 读旧索引（只读 items，坏文件当空） */
async function readOldIndex(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return data && typeof data === 'object' && data.items && typeof data.items === 'object' ? data : null;
  } catch {
    return null;
  }
}

/**
 * 跑整库。
 *
 * 返回 { file, generatedAt, total, analyzed, skipped, failed, errors, stats }。
 * onProgress 每完成一个文件调一次（done, total, label, state）。
 */
export async function analyzeLibrary({
  force = false,
  out,
  concurrency = 4,
  onProgress = null,
  tools = null,
} = {}) {
  const file = out || soundIndexFile();
  const ff = tools || resolveTools();

  const entries = await scanLocal();
  const old = await readOldIndex(file);
  const oldItems = old && old.items ? old.items : {};

  const items = {};
  const errors = [];
  let analyzed = 0;
  let skipped = 0;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sound-index-'));
  let seq = 0;

  const tasks = entries.map((entry, i) => async () => {
    const key = indexKeyOf(entry);
    const label = key || entry.file;
    let stat;
    try {
      stat = await fs.stat(entry.file);
    } catch (e) {
      errors.push({ key: label, file: entry.file, code: e.code || 'STAT_FAILED', message: e.message });
      return;
    }
    const fp = fingerprintOf(stat);
    const prev = oldItems[key];
    if (!force && prev && prev.fingerprint === fp && typeof prev.shape === 'string') {
      items[key] = prev;
      skipped += 1;
      if (onProgress) onProgress(analyzed + skipped, entries.length, label, 'skip');
      return;
    }

    try {
      const measured = await analyzeFile(entry.file, {
        ffmpeg: ff.ffmpeg,
        ffprobe: ff.ffprobe,
        tmpDir,
        metaName: 'meta-' + (seq++).toString(36) + '.txt',
      });
      items[key] = {
        root: entry.root,
        providerId: entry.providerId,
        relPath: entry.providerId,
        file: entry.file,
        size: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
        fingerprint: fp,
        ...measured,
        analyzedAt: new Date().toISOString(),
      };
      analyzed += 1;
      if (onProgress) onProgress(analyzed + skipped, entries.length, label, 'ok');
    } catch (e) {
      errors.push({
        key: label,
        file: entry.file,
        code: (e && e.code) || 'ANALYZE_FAILED',
        message: (e && e.message) || String(e),
      });
      if (onProgress) onProgress(analyzed + skipped, entries.length, label, 'fail');
    }
  });

  await runPool(tasks, concurrency);
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  const generatedAt = new Date().toISOString();
  const doc = {
    generatedAt,
    analyzer: ANALYZER_NAME,
    caveat: MEASURED_CAVEAT,
    version: SOUND_INDEX_VERSION,
    file,
    total: entries.length,
    items,
    errors,
  };

  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);

  return {
    file,
    generatedAt,
    total: entries.length,
    analyzed,
    skipped,
    failed: errors.length,
    errors,
    stats: distribution(items),
  };
}

/** 各维度的分布，给「跑完了看一眼」和测试用 */
export function distribution(items) {
  const counts = {};
  const bump = (dim, value) => {
    if (!counts[dim]) counts[dim] = {};
    counts[dim][value] = (counts[dim][value] || 0) + 1;
  };
  for (const item of Object.values(items || {})) {
    if (!item) continue;
    if (item.silent) {
      bump('shape', '静音');
      continue;
    }
    bump('shape', item.shape);
    bump('brightness', item.brightness);
    bump('noisiness', item.noisiness);
    bump('pitchiness', item.pitchiness);
    bump('materialGuess', item.materialGuess);
  }
  return counts;
}

/** 固定并发的任务池：不用第三方依赖，顺序不保证 */
async function runPool(tasks, concurrency) {
  const limit = Math.max(1, Math.min(16, Math.trunc(concurrency) || 1));
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      await tasks[i]();
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------- CLI ---

function parseArgs(argv) {
  const out = { force: false, root: null, out: null, concurrency: 4, json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') out.force = true;
    else if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--concurrency') out.concurrency = Number.parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('不认识的参数：' + a);
  }
  return out;
}

const HELP = [
  '用法：node tools/analyze-sounds.mjs [选项]',
  '',
  '  --force          忽略 size+mtime 指纹，全部重算',
  '  --root <目录>    只扫这个根目录（等同于临时设 DSH_SOUND_LIB）',
  '  --out <文件>     索引写到别处（默认 ~/.dsh/sound-index.json）',
  '  --concurrency N  同时跑几个 ffmpeg（默认 4）',
  '  --json           最后打印一行机器可读 JSON',
  '  --quiet          不打印进度',
].join('\n');

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.root) process.env.DSH_SOUND_LIB = path.resolve(args.root);
  if (args.out) process.env.DSH_SOUND_INDEX = path.resolve(args.out);

  const tools = resolveTools();
  for (const [name, bin] of Object.entries(tools)) {
    try {
      await fs.access(bin);
    } catch {
      console.error(
        '找不到 ' + name + '：' + bin + '\n' +
          '用 DSH_FFMPEG_PATH / DSH_FFPROBE_PATH 指定，或把 ffmpeg 静态构建放到 ' +
          (process.env.DSH_ASR_ROOT || '~\\.dsh\\video-deps') + '\\ffmpeg\\bin\\',
      );
      return 1;
    }
  }

  const started = Date.now();
  const result = await analyzeLibrary({
    force: args.force,
    out: args.out ? path.resolve(args.out) : null,
    concurrency: args.concurrency,
    onProgress: args.quiet
      ? null
      : (done, total, label, state) => {
          const mark = state === 'ok' ? '  ' : state === 'skip' ? '··' : '!!';
          process.stderr.write('\r' + mark + ' ' + done + '/' + total + '  ' + truncate(label, 60) + '   ');
        },
  });
  if (!args.quiet) process.stderr.write('\n');

  const ms = Date.now() - started;
  const summary = {
    file: result.file,
    total: result.total,
    analyzed: result.analyzed,
    skipped: result.skipped,
    failed: result.failed,
    elapsedMs: ms,
    stats: result.stats,
  };

  if (args.json) {
    console.log(JSON.stringify(summary));
  } else {
    console.log('索引：' + result.file);
    console.log(
      '共 ' + result.total + ' 个文件：重算 ' + result.analyzed + '，跳过 ' + result.skipped + '，失败 ' + result.failed,
    );
    console.log('耗时 ' + (ms / 1000).toFixed(1) + ' 秒');
    for (const [dim, map] of Object.entries(result.stats)) {
      const parts = Object.entries(map)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => k + ' ' + v);
      console.log('  ' + dim + '：' + parts.join(' / '));
    }
    if (result.errors.length) {
      console.log('失败明细（前 5 条）：');
      for (const e of result.errors.slice(0, 5)) console.log('  ' + e.key + ' :: ' + e.message);
    }
    console.log('说明：' + MEASURED_CAVEAT);
  }
  return 0;
}

function truncate(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error('分析失败：' + ((e && e.message) || e));
      process.exitCode = 1;
    });
}

export { SHAPE_VALUES, BRIGHTNESS_VALUES, SOUND_INDEX_VERSION, MEASURED_CAVEAT };
