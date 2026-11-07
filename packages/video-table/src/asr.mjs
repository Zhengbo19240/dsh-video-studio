/**
 * 语音转字幕（ASR）的进程边界。
 *
 * 这一层只管三件事，且全部失败都收敛成带 code 的错误，绝不抛「未知错误」：
 *   1. 起子进程（超时 / 取消 / stderr 收尾）
 *   2. ffmpeg 抽 16k 单声道 wav
 *   3. 用随包的 asr_worker.py 调 faster-whisper，把 stdout 的 JSON 解析成 segments
 *
 * 时间与错误约定：
 *   - 探测类调用 10 秒上限（由 asr-deps.mjs 传），抽音轨 10 分钟，转写 30 分钟。
 *   - 任何子进程错误都带上 stderr 的尾部 2KB，用户能直接看出是模型、显存还是文件的问题。
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 探测超时（asr-deps 用） */
export const PROBE_TIMEOUT_MS = 10 * 1000;
/** 抽音轨超时 */
export const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;
/** 转写超时（长视频也就这个量级；到点就杀，不让它挂住会话） */
export const TRANSCRIBE_TIMEOUT_MS = 30 * 60 * 1000;
/** 错误信息里保留的 stderr 尾巴 */
export const STDERR_TAIL_BYTES = 2048;

export const DEFAULT_LANGUAGE = 'zh';
export const DEFAULT_INITIAL_PROMPT = '以下是普通话口播，可能夹杂英文术语。';
export const DEFAULT_MODEL = 'medium';
export const SUPPORTED_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3'];

/** 带 code 的 ASR 错误。UI 与工具都靠 code 决定说什么，不靠猜 message。 */
export class AsrError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AsrError';
    this.code = code || 'ASR_FAILED';
    if (details) this.details = details;
  }
}

/** 只留尾巴，避免把几 MB 的 ffmpeg 日志塞进错误信息。 */
export function stderrTail(text, maxBytes = STDERR_TAIL_BYTES) {
  const value = String(text == null ? '' : text);
  if (!value) return '';
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= maxBytes) return value;
  // 从字节中间切会把最后一个多字节字符截断，宁可丢一个替换符
  return buf.subarray(buf.length - maxBytes).toString('utf8');
}

function baseName(command) {
  try {
    return path.basename(String(command));
  } catch {
    return String(command);
  }
}

function launchError(command, cause) {
  const code = cause && cause.code === 'ENOENT' ? 'NOT_FOUND' : 'SPAWN_FAILED';
  const why = cause && cause.code === 'ENOENT' ? '找不到可执行文件' : '启动进程失败';
  return new AsrError(code, `${why}：${command}`, {
    command: String(command),
    cause: (cause && cause.message) || String(cause),
  });
}

function timeoutError(command, timeoutMs) {
  return new AsrError('ETIMEDOUT', `执行超时（${Math.round(timeoutMs / 1000)} 秒）：${baseName(command)}`, {
    command: String(command),
    timeoutMs,
  });
}

/**
 * 起一个子进程并收结果。这是本文件唯一的进程出口，所以超时 / 取消 / stderr 尾巴
 * 只在这一个地方实现，上层不用各写一份。
 *
 * 返回 { stdout, stderr, code }；失败抛 AsrError（带 details.stderrTail）。
 *
 * options:
 *   timeoutMs   超时（默认 10 秒；探测用这个值）
 *   signal      AbortSignal，取消即杀进程
 *   env         追加/覆盖环境变量
 *   onStderrLine 逐行回调（进度行靠它）
 *   stdinText   要写进 stdin 的内容；不传则立刻关闭 stdin
 *   run         进程实现（默认 spawn；测试可注入，见 scripts/asr-test.mjs）
 */
export function runProcess(command, args = [], options = {}) {
  if (typeof options.run === 'function') return options.run(command, args, options);
  const {
    timeoutMs = PROBE_TIMEOUT_MS,
    signal,
    cwd,
    env,
    onStderrLine,
    stdinText,
  } = options;

  return new Promise((resolve, reject) => {
    if (!command) {
      reject(new AsrError('NO_COMMAND', '没有给出可执行文件路径'));
      return;
    }
    if (signal && signal.aborted) {
      reject(new AsrError('ASR_ABORTED', '转写已取消：' + baseName(command)));
      return;
    }

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...(env || {}) },
      });
    } catch (e) {
      reject(launchError(command, e));
      return;
    }

    let settled = false;
    let stdout = '';
    let stderrAll = '';
    let stderrTailText = '';
    let lineBuffer = '';
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
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
        details: { ...(error.details || {}), stderrTail: stderrTailText },
      });
      settle(reject, withTail);
    };
    const onAbort = () => kill(new AsrError('ASR_ABORTED', '转写已取消：' + baseName(command), { command: String(command) }));

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => kill(timeoutError(command, timeoutMs)), Math.max(50, timeoutMs));

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      const text = chunk.toString('utf8');
      if (stdout.length < 64 * 1024 * 1024) stdout += text;
    });

    child.stderr.on('data', (chunk) => {
      if (settled) return;
      const text = chunk.toString('utf8');
      stderrAll = stderrTail(stderrAll + text, 64 * 1024);
      stderrTailText = stderrTail(stderrAll, STDERR_TAIL_BYTES);
      if (!onStderrLine) return;
      lineBuffer += text;
      let idx = lineBuffer.indexOf('\n');
      while (idx >= 0) {
        const line = lineBuffer.slice(0, idx).replace(/\r$/, '');
        lineBuffer = lineBuffer.slice(idx + 1);
        try {
          onStderrLine(line);
        } catch {
          /* 回调崩了不能拖垮进程读取 */
        }
        idx = lineBuffer.indexOf('\n');
      }
    });

    child.on('error', (e) => settle(reject, launchError(command, e)));

    child.on('close', (code, sig) => {
      if (settled) return;
      if (onStderrLine && lineBuffer.trim()) {
        try {
          onStderrLine(lineBuffer.trim());
        } catch {
          /* ignore */
        }
      }
      if (code !== 0) {
        const error = new AsrError('PROCESS_FAILED', `${baseName(command)} 退出码 ${code}${sig ? '（' + sig + '）' : ''}`, {
          command: String(command),
          exitCode: code,
          signal: sig || null,
          stderrTail: stderrTailText,
        });
        settle(reject, error);
        return;
      }
      settle(resolve, { stdout, stderr: stderrAll, code: 0 });
    });

    try {
      if (stdinText == null) child.stdin.end();
      else child.stdin.end(stdinText);
    } catch {
      /* stdin 可能已经关了 */
    }
  });
}

function withStderr(message, e) {
  const tail = (e && e.details && e.details.stderrTail) || stderrTail((e && e.message) || '');
  if (!tail) return message;
  return `${message}\n--- stderr 末尾（最多 ${STDERR_TAIL_BYTES} 字节）---\n${stderrTail(tail, STDERR_TAIL_BYTES)}`;
}

/**
 * 抽音轨：ffmpeg -y -i <in> -vn -ac 1 -ar 16000 -f wav <out>
 *
 * 参数顺序是刻意固定的：-y 覆盖旧文件，-vn 丢掉视频流，16k 单声道是 whisper 的输入要求。
 * 失败时把 ffmpeg 的 stderr 尾巴贴进错误信息 —— 那里面才有「文件损坏 / 没有音频流」的真相。
 */
export async function extractAudio(ffmpegPath, inputPath, outWavPath, options = {}) {
  if (!ffmpegPath) throw new AsrError('NO_FFMPEG', '没有可用的 ffmpeg 路径');
  if (!inputPath) throw new AsrError('INVALID_ARG', '缺少输入视频/音频路径');
  if (!outWavPath) throw new AsrError('INVALID_ARG', '缺少输出 wav 路径');

  const args = ['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', outWavPath];
  const timeoutMs = options.timeoutMs == null ? EXTRACT_TIMEOUT_MS : options.timeoutMs;

  try {
    await runProcess(ffmpegPath, args, { ...options, timeoutMs });
  } catch (e) {
    if (e && e.code === 'ETIMEDOUT') {
      throw new AsrError('ETIMEDOUT', withStderr(`抽音轨超时（${Math.round(timeoutMs / 60000)} 分钟）：${path.basename(String(inputPath))}`, e), e.details);
    }
    throw new AsrError(
      'EXTRACT_FAILED',
      withStderr(`抽音轨失败（${path.basename(String(inputPath))}）：${(e && e.message) || '未知错误'}`, e),
      { ...(e && e.details), cause: (e && e.message) || null, input: String(inputPath) },
    );
  }

  let size = 0;
  try {
    const stat = await fs.stat(outWavPath);
    size = stat.size;
  } catch {
    size = 0;
  }
  if (!size) {
    throw new AsrError('AUDIO_EMPTY', `抽音轨失败：没有生成有效的 wav（${path.basename(String(inputPath))}）`, {
      output: String(outWavPath),
    });
  }
  return { path: outWavPath, size };
}

/**
 * 调随包的 asr_worker.py（faster-whisper）。
 *
 * 约定（与 src/asr_worker.py 一一对应）：
 *   stderr  PROGRESS d/t        按 30 秒窗口的进度
 *   stderr  ERROR <message>     致命错误，随后非零退出
 *   stdout  一行 JSON           { language, duration, segments:[{start,end,text}] }
 *
 * 超时 / 取消 / 非零退出都走 AsrError，不返回半截结果。
 */
export async function transcribeWithFasterWhisper({
  pythonPath,
  modelSize = DEFAULT_MODEL,
  audioPath,
  language = DEFAULT_LANGUAGE,
  device = 'cpu',
  modelsDir,
  initialPrompt = DEFAULT_INITIAL_PROMPT,
  workerPath,
  timeoutMs = TRANSCRIBE_TIMEOUT_MS,
  signal,
  onProgress,
} = {}) {
  if (!pythonPath) throw new AsrError('NO_PYTHON', '没有可用的 Python 解释器路径');
  if (!audioPath) throw new AsrError('INVALID_ARG', '缺少音频文件路径');

  const worker = workerPath || path.join(import.meta.dirname, 'asr_worker.py');
  const backend = device === 'cuda' ? 'cuda' : 'cpu';
  const args = [
    worker,
    '--audio',
    audioPath,
    '--model',
    String(modelSize || DEFAULT_MODEL),
    '--language',
    String(language || DEFAULT_LANGUAGE),
    '--device',
    backend,
  ];
  if (modelsDir) args.push('--models-dir', modelsDir);
  if (initialPrompt) args.push('--initial-prompt', initialPrompt);

  const env = {};
  if (modelsDir) {
    env.HF_HOME = modelsDir;
    env.HUGGINGFACE_HUB_CACHE = path.join(modelsDir, 'hub');
    env.HF_HUB_CACHE = path.join(modelsDir, 'hub');
  }

  let lastErrorLine = '';
  const emitProgress = (line) => {
    const text = String(line || '').trim();
    if (!text) return;
    const err = /^ERROR\s+(.*)$/.exec(text);
    if (err) lastErrorLine = err[1].trim();
    const progress = /^PROGRESS\s+(\d+)\s*\/\s*(\d+)$/.exec(text);
    if (progress && typeof onProgress === 'function') {
      const done = Number(progress[1]);
      const total = Math.max(1, Number(progress[2]));
      try {
        onProgress({
          phase: 'transcribe',
          done: Math.min(done, total),
          total,
          ratio: Math.max(0, Math.min(1, done / total)),
        });
      } catch {
        /* 进度回调不能影响转写 */
      }
    }
  };

  let result;
  try {
    result = await runProcess(pythonPath, args, {
      timeoutMs,
      signal,
      env,
      onStderrLine: emitProgress,
    });
  } catch (e) {
    const code = e && e.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : e && e.code === 'ASR_ABORTED' ? 'ASR_ABORTED' : 'ASR_FAILED';
    const detail = lastErrorLine || (e && e.details && e.details.stderrTail) || (e && e.message) || '未知错误';
    const head =
      e && e.code === 'ETIMEDOUT'
        ? `转写超时（${Math.round(timeoutMs / 60000)} 分钟）`
        : e && e.code === 'ASR_ABORTED'
          ? '转写已取消'
          : '转写失败';
    throw new AsrError(code, withStderr(`${head}：${detail}`, e), { ...(e && e.details), worker: String(worker) });
  }

  const raw = String(result.stdout || '').trim();
  let parsed = null;
  if (raw) {
    // 允许脚本在 JSON 前后打无关行，取最后一行能解析的 JSON
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        parsed = JSON.parse(lines[i]);
        break;
      } catch {
        parsed = null;
      }
    }
    if (!parsed) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new AsrError('ASR_BAD_OUTPUT', withStderr('转写脚本没有输出可解析的 JSON（可能是模型下载失败或显存不足）', { details: { stderrTail: result.stderr } }), {
      stdout: raw.slice(0, 500),
    });
  }
  if (!Array.isArray(parsed.segments)) {
    throw new AsrError('ASR_BAD_OUTPUT', '转写脚本输出的 JSON 缺少 segments 数组', { stdout: raw.slice(0, 500) });
  }

  const segments = parsed.segments
    .filter((s) => s && Number.isFinite(Number(s.start)) && Number.isFinite(Number(s.end)))
    .map((s) => ({
      start: round3(Math.max(0, Number(s.start))),
      end: round3(Math.max(0, Number(s.end))),
      text: String(s.text == null ? '' : s.text).trim(),
    }))
    .filter((s) => s.text && s.end > s.start)
    .sort((a, b) => a.start - b.start);

  return {
    language: parsed.language || language || DEFAULT_LANGUAGE,
    duration: Number(parsed.duration) || segments.reduce((max, s) => Math.max(max, s.end), 0),
    segments,
    device: parsed.device || backend,
    model: parsed.model || modelSize || DEFAULT_MODEL,
  };
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function pad(value, len = 2) {
  return String(value).padStart(len, '0');
}

/**
 * 秒 → SRT 时码 HH:MM:SS,mmm。
 *
 * 一律先取整到毫秒再拆时分秒：这样 1.9996 秒会进到 00:00:02,000，而不是
 * 00:00:01,1000（直接对小数取整会出的经典 bug）。
 */
export function srtStamp(seconds) {
  const raw = Number(seconds);
  let ms = Math.round((Number.isFinite(raw) ? Math.max(0, raw) : 0) * 1000);
  const millis = ms % 1000;
  ms = (ms - millis) / 1000;
  const sec = ms % 60;
  ms = (ms - sec) / 60;
  const min = ms % 60;
  const hour = Math.floor(ms / 60);
  return `${pad(hour)}:${pad(min)}:${pad(sec)},${pad(millis, 3)}`;
}

/** segments → 标准 SRT 文本（空文本、反向区间一律丢掉） */
export function formatSrt(segments) {
  const list = (segments || [])
    .filter(
      (s) =>
        s &&
        Number.isFinite(Number(s.start)) &&
        Number.isFinite(Number(s.end)) &&
        Number(s.end) > Number(s.start) &&
        String(s.text == null ? '' : s.text).trim(),
    )
    .slice()
    .sort((a, b) => Number(a.start) - Number(b.start));
  return list
    .map(
      (s, i) =>
        `${i + 1}\n${srtStamp(s.start)} --> ${srtStamp(s.end)}\n${String(s.text).trim()}\n`,
    )
    .join('\n');
}

/**
 * segments → 字幕轨的 clip.insert 命令（t1，clipType:'text'）。
 *
 * 这是「转写结果」和「时间线」之间唯一的转换点：纯函数、不碰 store，
 * 所以片段数、起点、时长都能单测，也能给 agent 和面板两边复用。
 */
export function segmentsToClipOps(segments, { trackId = 't1', startOffset = 0, idSeed } = {}) {
  const seed = idSeed || Date.now().toString(36);
  const offset = Number(startOffset) || 0;
  return (segments || [])
    .filter(
      (s) =>
        s &&
        Number.isFinite(Number(s.start)) &&
        Number.isFinite(Number(s.end)) &&
        Number(s.end) > Number(s.start) &&
        String(s.text == null ? '' : s.text).trim(),
    )
    .slice()
    .sort((a, b) => Number(a.start) - Number(b.start))
    .map((s, i) => ({
      type: 'clip.insert',
      clipId: `asr_${seed}_${i + 1}`,
      trackId,
      clipType: 'text',
      start: round3(Math.max(0, Number(s.start) + offset)),
      // 0.2 秒是 domain 里对片段时长的下限；短于此的碎片补到下限，免得整条命令被拒
      duration: Math.max(0.2, round3(Number(s.end) - Number(s.start))),
      text: String(s.text).trim(),
    }));
}
