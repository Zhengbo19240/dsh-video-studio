/**
 * ASR 依赖探测：ffmpeg / Python venv / faster-whisper 与 GPU 后端。
 *
 * 设计要点（这个文件唯一的职责就是「说实话，不抛错」）：
 *   - 三个部件各自独立检测，谁缺了只写进 reasons，绝不让整个工具调用炸掉。
 *   - 每条 reason 都必须能指路：缺什么、装到哪个目录、用什么命令修。
 *   - 探测本身有 10 秒上限；装到一半的机器上跑 video_asr_status 也只会慢 10 秒，不会挂住。
 *   - 设备路径来自 DSH_ASR_ROOT 或默认的 ~\\.dsh\\video-deps，不做任何隐藏回退 ——
 *     用户看得见「我用的是哪个根目录」。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROBE_TIMEOUT_MS, runProcess, stderrTail } from './asr.mjs';

/** 依赖根目录的默认值 */
export const DEFAULT_ASR_ROOT = '~\\.dsh\\video-deps';

/** 依赖根目录：环境变量优先，方便换盘或换机器 */
export function asrRoot() {
  const fromEnv = process.env.DSH_ASR_ROOT;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv);
  return DEFAULT_ASR_ROOT;
}

/** 依赖布局：一段话说明这棵目录树长什么样，省得每个调用点各拼一次路径 */
export function asrPaths(root = asrRoot()) {
  const base = String(root || DEFAULT_ASR_ROOT);
  return {
    root: base,
    ffmpeg: path.join(base, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    ffmpegDir: path.join(base, 'ffmpeg', 'bin'),
    python: path.join(base, 'py', 'Scripts', 'python.exe'),
    pyDir: path.join(base, 'py'),
    models: path.join(base, 'models'),
    tmp: path.join(base, 'tmp'),
  };
}

// 一行式探针：只用单引号，避免 Windows 命令行引号转义踩坑。
// 输出的 JSON 会被 asr-deps 按最后一行解析。
const PROBE_CODE =
  "import json,faster_whisper as fw,ctranslate2 as ct;" +
  "print(json.dumps({'fw':getattr(fw,'__version__','?'),'ct':getattr(ct,'__version__','?'),'cuda':int(ct.get_cuda_device_count())}))";

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function firstLine(text) {
  const line = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return line || '';
}

/** 从一段 stderr 里挑出最像「原因」的一行，别把整篇 traceback 塞给用户 */
function keyLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return '';
  const tail = lines.slice(-12);
  const hit = tail.reverse().find((l) => /Error|error|异常|No module|not found|不能|失败|拒绝/.test(l));
  return hit || lines[lines.length - 1];
}

/** 解析探针输出：取最后一行能当 JSON 解析的（有些库会先往 stdout 打提示） */
function parseProbeJson(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* 继续往前找 */
    }
  }
  return null;
}

/** 错误详情里的 stderr 尾巴（runProcess 的 AsrError 会带 details.stderrTail） */
function tailOf(error) {
  if (!error) return '';
  if (error.details && error.details.stderrTail) return stderrTail(error.details.stderrTail);
  return stderrTail(error.message || '');
}

/**
 * 探测结果：
 *   {
 *     ready: bool,
 *     root, modelsDir,
 *     ffmpeg: { path, ok, version? },
 *     python: { path, ok, fasterWhisper?, ctranslate2? },
 *     whisper: { ok, version?, backend: 'cuda' | 'cpu' | null },
 *     reasons: [中文，说清缺什么、装到哪],
 *     warnings: [不阻断但要知道的事，比如「只有 CPU」],
 *   }
 *
 * options.runner 是进程实现（默认 runProcess）。注入它只为让测试能在没有真实
 * ffmpeg / venv 的 Windows 上跑三种情形 —— 生产路径上永远不传。
 */
export async function detectAsr({ root = asrRoot(), timeoutMs = PROBE_TIMEOUT_MS, runner } = {}) {
  const paths = asrPaths(root);
  const run = typeof runner === 'function' ? runner : undefined;
  const reasons = [];
  const warnings = [];

  // ---- 1) ffmpeg --------------------------------------------------------
  const ffmpeg = { path: paths.ffmpeg, ok: false };
  if (!(await exists(paths.ffmpeg))) {
    ffmpeg.reason = 'missing-file';
    reasons.push(
      `缺少 ffmpeg：没有找到 ${paths.ffmpeg}。把静态构建解压到 ${paths.ffmpegDir}，` +
        `或用环境变量 DSH_ASR_ROOT 指向装好的依赖根目录。`,
    );
  } else {
    try {
      const out = await runProcess(paths.ffmpeg, ['-version'], { timeoutMs, run });
      const line = firstLine(out.stdout) || firstLine(out.stderr);
      if (!line) {
        ffmpeg.reason = 'no-output';
        reasons.push(`ffmpeg 没有输出可识别的版本信息：${paths.ffmpeg} 可能是坏文件或被拦截。`);
      } else {
        ffmpeg.ok = true;
        ffmpeg.version = line;
      }
    } catch (e) {
      ffmpeg.reason = (e && e.code) || 'failed';
      const tail = tailOf(e);
      reasons.push(
        `ffmpeg 跑不起来：${(e && e.message) || '未知错误'}。` +
          `重新解压静态构建到 ${paths.ffmpegDir}。` +
          (tail ? `\nffmpeg 输出：${keyLine(tail)}` : ''),
      );
    }
  }

  // ---- 2) Python venv + faster-whisper ----------------------------------
  const python = { path: paths.python, ok: false };
  const whisper = { ok: false, backend: null };

  if (!(await exists(paths.python))) {
    python.reason = 'missing-file';
    reasons.push(
      `缺少 Python 环境：没有找到 ${paths.python}。用 "python -m venv ${paths.pyDir}" 建虚拟环境，` +
        `再执行 "${paths.python} -m pip install faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12"。`,
    );
  } else {
    let probeOut = null;
    let probeError = null;
    try {
      probeOut = await runProcess(paths.python, ['-c', PROBE_CODE], { timeoutMs, run });
    } catch (e) {
      probeError = e;
    }
    const info = probeOut ? parseProbeJson(probeOut.stdout) : null;

    if (info && info.fw) {
      python.ok = true;
      python.fasterWhisper = String(info.fw);
      if (info.ct) python.ctranslate2 = String(info.ct);
      whisper.ok = true;
      whisper.version = String(info.fw);
      const devices = Number(info.cuda) || 0;
      whisper.backend = devices > 0 ? 'cuda' : 'cpu';
      whisper.cudaDevices = devices;
      if (devices <= 0) {
        warnings.push('没有可用的 CUDA 设备：faster-whisper 会用 CPU（int8），速度约为 GPU 的十分之一。');
      }
    } else {
      // 解释器在、但包装不上 —— 这两件事要分开说，否则用户会去重装 Python
      let interpreterOk = false;
      try {
        const v = await runProcess(paths.python, ['--version'], { timeoutMs, run });
        interpreterOk = v.code === 0;
      } catch {
        interpreterOk = false;
      }
      python.ok = interpreterOk;
      python.reason = interpreterOk ? 'missing-packages' : 'broken-venv';
      const tail = tailOf(probeError);
      const why = probeError ? (probeError.message || '') : '没有输出可解析的版本信息';
      reasons.push(
        (interpreterOk
          ? `Python 能跑，但缺 faster-whisper/ctranslate2：${paths.python}。`
          : `Python 虚拟环境有问题：${paths.python} 跑不起来。`) +
          `执行 "${paths.python} -m pip install faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12" 修好。` +
          (tail ? `\nPython 输出：${keyLine(tail)}` : `\n原因：${why}`),
      );
    }
  }

  // ---- 3) 模型缓存目录：缺了不阻断（首次运行会自动下载），但要说一声 ----
  let modelsDirOk = await exists(paths.models);
  if (!modelsDirOk) {
    warnings.push(`模型缓存目录还不存在：${paths.models}。首次转写会从 HuggingFace 下载权重（需要网络）。`);
    modelsDirOk = false;
  }

  const ready = ffmpeg.ok && python.ok && whisper.ok;
  return {
    ready,
    root: paths.root,
    modelsDir: paths.models,
    modelsDirOk,
    ffmpeg,
    python,
    whisper,
    reasons,
    warnings,
  };
}

/**
 * 给人看的一行结论：工具结果和面板都用它，避免两处措辞不一致。
 */
export function describeAsr(detected) {
  if (!detected) return '还没有检测语音转字幕依赖';
  if (detected.ready) {
    const backend = detected.whisper && detected.whisper.backend === 'cuda' ? 'GPU（CUDA）' : 'CPU';
    return `语音转字幕就绪：ffmpeg + faster-whisper，后端 ${backend}`;
  }
  const count = (detected.reasons || []).length;
  return `语音转字幕还不能用：缺 ${count} 项（ffmpeg=${detected.ffmpeg && detected.ffmpeg.ok ? 'ok' : '缺'}，` +
    `python=${detected.python && detected.python.ok ? 'ok' : '缺'}，` +
    `whisper=${detected.whisper && detected.whisper.ok ? 'ok' : '缺'}）`;
}
