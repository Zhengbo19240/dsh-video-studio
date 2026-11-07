/**
 * 文字转语音（TTS）：工作台里唯一一个「凭空造声音」的零件。
 *
 * 三条硬规矩，和 ASR 那一层一致：
 *   1. provider 是抽象的：本文件只认 listVoices / synthesize / probe 三个方法，
 *      `DSH_TTS_PROVIDER` 选名字，换 CosyVoice / 云端 API 时不用改调用方。
 *   2. 依赖缺失不是「未知错误」，是结果：probe() 返回 ready:false + 中文 reasons，
 *      每条都写清缺什么、装到哪、用什么命令修。
 *   3. 落盘先 .part 再 rename：中途失败不会留下半截 mp3，也不会把旧文件覆盖成坏的。
 *
 * 首发 provider 是 edge（微软在线、免费、无 API key）。实现走本机 Python 的
 * edge-tts 包（~/.dsh/video-deps\py，可用 DSH_TTS_PYTHON 换解释器）。
 * 之所以不在 Node 里直接连 WebSocket：本机实测裸握手被 speech.platform.bing.com
 * 回 403（缺浏览器指纹/鉴权头），而 edge-tts 7.3.1 走它自己的鉴权方式稳定可用。
 * 这条是实测结论，不是猜的；将来要换纯 Node 实现，注册一个新 provider 即可。
 *
 * 时长**只信 ffprobe**：路径从 asr-deps 的 asrPaths() 推，不写死盘符。
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DomainError } from './domain.mjs';
import { runProcess, stderrTail } from './asr.mjs';
import { asrPaths } from './asr-deps.mjs';

/** 一次合成的字数上限：edge-tts 单请求的合理区间，也防止有人把整篇稿子丢进来 */
export const MAX_TEXT_CHARS = 2000;
/** 默认 provider */
export const DEFAULT_PROVIDER = 'edge';
/** 默认音色 */
export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
/** 合成超时：一段 2000 字的口播在线合成通常 10–30 秒 */
export const SYNTH_TIMEOUT_MS = 120 * 1000;
/** 探测超时（导入包 + 网络握手） */
export const PROBE_TIMEOUT_MS = 10 * 1000;
/** ffprobe 读时长超时 */
export const FFPROBE_TIMEOUT_MS = 20 * 1000;

/** 中文常用音色：至少 6 个，带性别与风格，面板和 agent 共用这一份。 */
const VOICES = [
  {
    id: 'zh-CN-XiaoxiaoNeural',
    name: '晓晓',
    gender: 'female',
    locale: 'zh-CN',
    style: '温柔 · 通用',
    description: '默认音色。叙述、口播、知识类短视频都稳。',
  },
  {
    id: 'zh-CN-XiaoyiNeural',
    name: '晓伊',
    gender: 'female',
    locale: 'zh-CN',
    style: '活泼 · 年轻',
    description: '语速偏快、语气轻快，适合种草、Vlog 旁白。',
  },
  {
    id: 'zh-CN-YunxiNeural',
    name: '云希',
    gender: 'male',
    locale: 'zh-CN',
    style: '阳光 · 青年',
    description: '年轻男声，适合产品介绍、日常口播。',
  },
  {
    id: 'zh-CN-YunjianNeural',
    name: '云健',
    gender: 'male',
    locale: 'zh-CN',
    style: '浑厚 · 解说',
    description: '低沉有力，适合纪录片、赛事、悬念解说。',
  },
  {
    id: 'zh-CN-YunyangNeural',
    name: '云扬',
    gender: 'male',
    locale: 'zh-CN',
    style: '新闻 · 播报',
    description: '标准播报腔，适合资讯、时政、正式口播。',
  },
  {
    id: 'zh-CN-YunxiaNeural',
    name: '云夏',
    gender: 'male',
    locale: 'zh-CN',
    style: '少年 · 童声',
    description: '偏少年音，适合动画、科普里的角色对白。',
  },
  {
    id: 'zh-CN-liaoning-XiaobeiNeural',
    name: '晓北',
    gender: 'female',
    locale: 'zh-CN-liaoning',
    style: '东北话 · 亲切',
    description: '东北方言，适合生活类、搞笑类内容。',
  },
  {
    id: 'zh-CN-shaanxi-XiaoniNeural',
    name: '晓妮',
    gender: 'female',
    locale: 'zh-CN-shaanxi',
    style: '陕西话 · 爽利',
    description: '陕西方言，适合地域特色内容。',
  },
  {
    id: 'zh-TW-HsiaoChenNeural',
    name: '曉臻',
    gender: 'female',
    locale: 'zh-TW',
    style: '台湾腔 · 温和',
    description: '台湾普通话，适合面向台湾受众的内容。',
  },
  {
    id: 'zh-HK-HiuMaanNeural',
    name: '曉曼',
    gender: 'female',
    locale: 'zh-HK',
    style: '粤语 · 沉稳',
    description: '粤语音色，适合粤语口播。',
  },
];

/** 所有失败都带 code 与真实原因；绝不出现「未知错误」。 */
export class TtsError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'TtsError';
    this.code = code || 'TTS_FAILED';
    if (details) this.details = details;
  }
}

/** 给 UI / 工具的一行结论，措辞只在这里写一次。 */
export function describeTts(probeResult) {
  if (!probeResult) return '还没有检测配音依赖';
  if (probeResult.ready) {
    const py = probeResult.python;
    const version = py && py.edgeTts ? `edge-tts ${py.edgeTts}` : 'edge';
    return `配音就绪：${probeResult.provider}（${version}）· ${listVoices().length} 个中文音色`;
  }
  const count = (probeResult.reasons || []).length;
  return `配音还不能用：缺 ${count} 项（provider=${probeResult.provider}）`;
}

export function listVoices() {
  return VOICES.map((v) => ({ ...v }));
}

export function findVoice(id) {
  const key = String(id == null ? '' : id).trim();
  return VOICES.find((v) => v.id === key) || null;
}

// --------------------------------------------------------------- providers ---

const providers = new Map();

function normalizeProviderName(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

/** 当前 provider 名：环境变量优先，方便测试与将来切换。 */
export function currentProviderName() {
  const fromEnv = normalizeProviderName(process.env.DSH_TTS_PROVIDER);
  return fromEnv || DEFAULT_PROVIDER;
}

export function listProviders() {
  return [...providers.keys()];
}

/**
 * 注册一个 provider。实现只需 synth()；probe()/voices 可选。
 * 调用方（面板 / 工具）永远走 synthesize()/probe()，不直接拿 provider。
 */
export function registerProvider(name, impl) {
  const key = normalizeProviderName(name);
  if (!key) throw new TtsError('INVALID_ARG', 'provider 名字不能为空');
  if (!impl || typeof impl.synthesize !== 'function') {
    throw new TtsError('INVALID_ARG', `provider ${key} 缺少 synthesize() 实现`);
  }
  providers.set(key, { ...impl, name: key, label: impl.label || key });
  return key;
}

export function unregisterProvider(name) {
  return providers.delete(normalizeProviderName(name));
}

/** 仅供测试：清掉所有 provider，再把内置的注册回去。 */
export function resetProviders() {
  providers.clear();
  registerProvider('edge', edgeProvider);
}

export function pythonPath(root) {
  const fromEnv = process.env.DSH_TTS_PYTHON;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  return asrPaths(root).python;
}

export function ffprobePath(root) {
  const fromEnv = process.env.DSH_FFPROBE_PATH;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const paths = asrPaths(root);
  return path.join(paths.ffmpegDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function parseJsonLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* 继续往前找 */
    }
  }
  return null;
}

/** 从 stderr 里挑出最像原因的一行，别把整篇 traceback 塞给用户。 */
function keyLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return '';
  const tail = lines.slice(-12).reverse();
  const hit = tail.find((line) => /Error|error|异常|No module|not found|不能|失败|拒绝|Timeout|timed out/.test(line));
  return hit || lines[lines.length - 1];
}

function errorTail(error) {
  if (!error) return '';
  if (error.details && error.details.stderrTail) return stderrTail(error.details.stderrTail);
  return stderrTail(error.message || '');
}

/** 把「像网络问题」的 stderr 翻译成人话，并给出 NETWORK 码。 */
function looksLikeNetworkFailure(text) {
  return /Cannot connect|ClientConnectorError|ConnectionError|getaddrinfo|Name or service not known|Temporary failure in name resolution|ConnectTimeout|ReadTimeout|TimeoutError|timed out|网络|拒绝连接/i.test(
    String(text || ''),
  );
}

const EDGE_PROBE_CODE =
  "import json, edge_tts, sys; print(json.dumps({'edgeTts': getattr(edge_tts, '__version__', '?'), 'python': sys.version.split()[0]}))";

/**
 * 首发 provider：本机 Python 的 edge-tts。
 *
 * 为什么是 Python 而不是 Node WebSocket：见文件头注释（实测裸 WS 403）。
 * 换实现只需注册同名 provider，synthesize/probe 的调用方不用动。
 */
const edgeProvider = {
  label: 'Edge 在线语音（edge-tts）',
  requiresNetwork: true,

  async probe({ root, runner, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    const py = pythonPath(root);
    const reasons = [];
    const python = { path: py, ok: false, edgeTts: null };
    if (!(await exists(py))) {
      reasons.push(
        `缺少 Python 解释器：没有找到 ${py}。用 "python -m venv ${asrPaths(root).pyDir}" 建环境，` +
          `再执行 "${py} -m pip install edge-tts"。`,
      );
      return { ok: false, backend: 'python', python, reasons };
    }
    try {
      const out = await runProcess(py, ['-c', EDGE_PROBE_CODE], { timeoutMs, run: runner });
      const info = parseJsonLine(out.stdout);
      if (!info || !info.edgeTts) {
        throw new TtsError('PROBE_FAILED', 'Python 跑起来了，但 import edge_tts 没有输出版本信息');
      }
      python.ok = true;
      python.edgeTts = String(info.edgeTts);
      python.version = info.python ? String(info.python) : null;
      return { ok: true, backend: 'python', python, reasons: [], version: python.edgeTts };
    } catch (e) {
      const tail = errorTail(e);
      const interpreterBroken = e && (e.code === 'NOT_FOUND' || e.code === 'SPAWN_FAILED');
      reasons.push(
        (interpreterBroken
          ? `Python 解释器跑不起来：${py}（${(e && e.message) || '启动失败'}）。`
          : `缺 edge-tts 包：${py} 能跑，但 import edge_tts 失败。`) +
          `执行 "${py} -m pip install edge-tts" 修好。` +
          (tail ? `\nPython 输出：${keyLine(tail)}` : ''),
      );
      return { ok: false, backend: 'python', python, reasons };
    }
  },

  async synthesize({ text, voice, rate, pitch, outPath, root, timeoutMs = SYNTH_TIMEOUT_MS, runner }) {
    const py = pythonPath(root);
    const args = [
      '-m',
      'edge_tts',
      '--text',
      text,
      '--voice',
      voice,
      `--rate=${formatPercent(rate)}`,
      `--pitch=${formatHz(pitch)}`,
      '--write-media',
      outPath,
    ];
    try {
      await runProcess(py, args, { timeoutMs, run: runner });
    } catch (e) {
      const tail = errorTail(e);
      const detail = keyLine(tail) || (e && e.message) || 'edge-tts 调用失败';
      const network = looksLikeNetworkFailure(tail + ' ' + ((e && e.message) || ''));
      const code = e && e.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : network ? 'NETWORK' : 'SYNTH_FAILED';
      throw new TtsError(
        code,
        (network
          ? `配音合成失败：连不上 edge-tts 服务（可能断网或代理拦截）。`
          : `配音合成失败：${detail}。`) +
          (tail ? `\n--- edge-tts 输出末尾 ---\n${stderrTail(tail)}` : ''),
        { command: py, stderrTail: tail, network },
      );
    }
    let size = 0;
    try {
      size = (await fs.stat(outPath)).size;
    } catch {
      size = 0;
    }
    if (!size) {
      throw new TtsError('AUDIO_EMPTY', `配音合成失败：edge-tts 退出了但没有生成音频文件（${outPath}）`);
    }
    return { bytes: size, backend: 'python' };
  },
};

resetProviders();

// ------------------------------------------------------------------ network ---

/**
 * 连通性探测：只做一次 TCP 握手，不做业务请求。
 * 注入 connect 是为了测试能在断网/通网的两种情形下断言 probe 的 reasons。
 */
export function checkNetwork({
  host = 'speech.platform.bing.com',
  port = 443,
  timeoutMs = 2500,
  connect,
} = {}) {
  if (typeof connect === 'function') return Promise.resolve(connect({ host, port, timeoutMs }));
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve({ ...value, ms: Date.now() - started, host, port });
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(Math.max(200, timeoutMs));
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, error: `连接 ${host}:${port} 超时（${timeoutMs} 毫秒）` }));
    socket.once('error', (e) => finish({ ok: false, error: `${host}:${port} 连不上：${(e && e.message) || e}` }));
  });
}

// -------------------------------------------------------------------- probe ---

/**
 * 探测结果：
 *   { ready, provider, backend, ffprobe, python, network, voices, reasons[], warnings[] }
 * ready 为 false 时 reasons 一定非空，且每条都能指路。
 *
 * options（全部可选，给测试注入用）：
 *   root     依赖根目录（默认 asrPaths 的 ~/.dsh/video-deps）
 *   runner   进程实现（默认 runProcess）
 *   network  连通性检查（返回 {ok, error}）
 *   timeoutMs
 */
export async function probe(options = {}) {
  const root = options.root; // undefined 时 asrPaths 用默认值
  const reasons = [];
  const warnings = [];
  const providerName = normalizeProviderName(options.provider) || currentProviderName();

  // ---- 1) ffprobe：时长的唯一依据 ----
  const ffprobe = { path: ffprobePath(root), ok: false };
  if (!(await exists(ffprobe.path))) {
    reasons.push(
      `缺少 ffprobe：没有找到 ${ffprobe.path}。配音必须用它读时长，` +
        `把 ffmpeg 静态构建解压到 ${asrPaths(root).ffmpegDir}，或用 DSH_ASR_ROOT 指向装好的依赖根目录。`,
    );
  } else {
    ffprobe.ok = true;
  }

  // ---- 2) provider ----
  const impl = providers.get(providerName);
  let providerOk = false;
  let backend = providerName;
  let python = { path: pythonPath(root), ok: false, edgeTts: null };
  let voiceCount = VOICES.length;
  if (!impl) {
    reasons.push(
      `没有这个配音 provider：${providerName}。已注册：${listProviders().join(' / ') || '（无）'}；` +
        `用环境变量 DSH_TTS_PROVIDER 切到可用的那个。`,
    );
  } else {
    if (impl.requiresNetwork) {
      const netResult = await checkNetwork({
        host: options.networkHost,
        timeoutMs: options.networkTimeoutMs,
        connect: options.network,
      });
      const net = { ok: netResult.ok === true, error: netResult.error || null };
      if (!net.ok) {
        reasons.push(
          `连不上配音服务（${net.error || '网络不可用'}）。edge-tts 是在线合成：断网、代理拦截或公司网络限制都会失败；` +
            `恢复网络后重试，或换一个本地 TTS provider（DSH_TTS_PROVIDER）。`,
        );
      }
      options = Object.assign({}, options, { _network: net });
    }
    let detail = null;
    if (typeof impl.probe === 'function') {
      detail = await impl.probe({
        root,
        runner: options.runner,
        timeoutMs: options.timeoutMs || PROBE_TIMEOUT_MS,
      });
      if (detail && Array.isArray(detail.reasons)) reasons.push(...detail.reasons);
      if (detail && Array.isArray(detail.warnings)) warnings.push(...detail.warnings);
      if (detail && detail.python) python = detail.python;
      if (detail && detail.backend) backend = detail.backend;
      if (detail && Array.isArray(detail.voices)) voiceCount = detail.voices.length;
    }
    providerOk = detail ? detail.ok === true : true;
  }

  const network = (options._network || null) && {
    ok: options._network.ok,
    error: options._network.error,
  };
  const ready = providerOk && ffprobe.ok && (!impl || !impl.requiresNetwork || (network && network.ok));

  return {
    ready,
    provider: providerName,
    backend,
    providerLabel: impl ? impl.label : null,
    ffprobe,
    python,
    network,
    voiceCount,
    voices: listVoices(),
    reasons,
    warnings,
    human: describeTts({ ready, provider: providerName, python, reasons }),
    hint: ready
      ? '可以合成：synthesize(text, { voice, rate, pitch, projectRoot }) 或 video_tts_speak。'
      : '依赖缺失时不要重试合成：先按 reasons 里的路径与命令装好，再调一次 video_tts_status。',
  };
}

// ------------------------------------------------------------------- voices ---

function prepareText(value) {
  const raw = typeof value === 'string' ? value : value == null ? '' : String(value);
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text) {
    throw new TtsError('INVALID_ARG', '文本为空：先给出要配音的内容（面板里选中文字片段或直接输入）。');
  }
  const chars = Array.from(text).length;
  if (chars > MAX_TEXT_CHARS) {
    throw new TtsError('INVALID_ARG', `文本太长：${chars} 字，上限 ${MAX_TEXT_CHARS} 字。请拆成多段分别生成。`, {
      chars,
      max: MAX_TEXT_CHARS,
    });
  }
  return text;
}

function normalizeVoice(value) {
  const id = String(value == null ? '' : value).trim();
  if (!id) return DEFAULT_VOICE;
  const known = findVoice(id);
  if (known) return known.id;
  // 允许未来新增的音色：只要像微软的 voice 名就放行，不要让用户被白名单卡死
  if (!/^[A-Za-z]{2,3}-[A-Za-z0-9-]+$/.test(id) || id.length > 64) {
    throw new TtsError('INVALID_ARG', `音色名不合法：${id}。应该是 zh-CN-XiaoxiaoNeural 这种格式。`);
  }
  return id;
}

function normalizePercent(value, label) {
  if (value == null || value === '') return 0;
  const text = String(value).trim().replace(/%$/, '');
  const num = Number(text);
  if (!Number.isFinite(num)) {
    throw new TtsError('INVALID_ARG', `${label}要是数字（例如 10 表示 +10%），收到 ${JSON.stringify(value)}。`);
  }
  if (num < -50 || num > 50) {
    throw new TtsError('INVALID_ARG', `${label}超出范围：${num}%，只支持 -50..+50。`);
  }
  return Math.round(num);
}

function formatPercent(value) {
  const num = Number(value) || 0;
  return `${num >= 0 ? '+' : ''}${num}%`;
}

function formatHz(value) {
  const num = Number(value) || 0;
  return `${num >= 0 ? '+' : ''}${num}Hz`;
}

// ----------------------------------------------------------------- duration ---

/** 用 ffprobe 读时长（毫秒）。失败一律 TtsError，带 ffprobe 原话。 */
export async function probeDuration(filePath, options = {}) {
  const ffprobe = ffprobePath(options.root);
  if (!(await exists(ffprobe))) {
    throw new TtsError(
      'NO_FFPROBE',
      `没有 ffprobe：${ffprobe}。它是读音频时长的唯一依据；` +
        `把 ffmpeg 静态构建解压到 ${asrPaths(options.root).ffmpegDir}，或用 DSH_ASR_ROOT / DSH_FFPROBE_PATH 指过去。`,
      { ffprobe },
    );
  }
  const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath];
  let out;
  try {
    out = await runProcess(ffprobe, args, {
      timeoutMs: options.timeoutMs || FFPROBE_TIMEOUT_MS,
      run: options.runner,
    });
  } catch (e) {
    const tail = errorTail(e);
    throw new TtsError('FFPROBE_FAILED', `ffprobe 读时长失败：${keyLine(tail) || (e && e.message) || '未知原因'}`, {
      ffprobe,
      file: filePath,
      stderrTail: tail,
    });
  }
  const raw = String(out.stdout || '').trim();
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new TtsError('FFPROBE_FAILED', `ffprobe 没给出有效时长（输出：${raw || '空'}）：${filePath}`, {
      ffprobe,
      file: filePath,
      stdout: raw.slice(0, 200),
    });
  }
  return Math.round(seconds * 1000);
}

// -------------------------------------------------------------- synthesize ---

/**
 * 合成一段配音并落进工程的 assets/。
 *
 *   synthesize(text, { voice, rate, pitch, projectRoot, assetDir, root, runner, provider })
 *   → { ok, audioPath, absPath, durationMs, voice, chars, provider, bytes, cached, rate, pitch }
 *
 * 返回的 audioPath 是**工程内相对路径**（assets/tts-<hash>.mp3），可以直接交给 asset.add。
 * 同一个（provider, voice, rate, pitch, text）会命中同一个 hash，已存在就不再联网。
 */
export async function synthesize(text, options = {}) {
  const prepared = prepareText(text);
  const voice = normalizeVoice(options.voice);
  const rate = normalizePercent(options.rate, '语速');
  const pitch = normalizePercent(options.pitch, '音调');
  const projectRoot = options.projectRoot ? path.resolve(String(options.projectRoot)) : '';
  if (!projectRoot) {
    throw new TtsError('INVALID_ARG', 'synthesize 需要 projectRoot：音频要落进工程目录（assets/）。');
  }
  const providerName = normalizeProviderName(options.provider) || currentProviderName();
  const impl = providers.get(providerName);
  if (!impl) {
    throw new TtsError(
      'UNKNOWN_PROVIDER',
      `没有这个配音 provider：${providerName}。已注册：${listProviders().join(' / ') || '（无）'}；用 DSH_TTS_PROVIDER 切换。`,
    );
  }

  const assetDir = String(options.assetDir || 'assets').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || 'assets';
  const chars = Array.from(prepared).length;
  const hash = createHash('sha1')
    .update([providerName, voice, formatPercent(rate), formatHz(pitch), prepared].join('|'), 'utf8')
    .digest('hex')
    .slice(0, 12);
  const fileName = `tts-${hash}.mp3`;
  const relPath = `${assetDir}/${fileName}`;
  const absDir = path.join(projectRoot, assetDir);
  await fs.mkdir(absDir, { recursive: true });
  const absPath = path.join(absDir, fileName);

  let bytes = 0;
  try {
    bytes = (await fs.stat(absPath)).size;
  } catch {
    bytes = 0;
  }
  let cached = bytes > 0;
  let durationMs = null;

  if (!cached) {
    const tmpPath = `${absPath}.${process.pid}.${Date.now().toString(36)}.part`;
    try {
      const result = await impl.synthesize({
        text: prepared,
        voice,
        rate,
        pitch,
        outPath: tmpPath,
        root: options.root,
        projectRoot,
        assetDir,
        timeoutMs: options.timeoutMs || SYNTH_TIMEOUT_MS,
        runner: options.runner,
      });
      let size = 0;
      try {
        size = (await fs.stat(tmpPath)).size;
      } catch {
        size = 0;
      }
      if (!size) {
        throw new TtsError('AUDIO_EMPTY', `合成失败：provider ${providerName} 没有产出音频（${tmpPath}）。`);
      }
      await fs.rename(tmpPath, absPath);
      bytes = size;
      if (result && Number.isFinite(Number(result.durationMs))) durationMs = Math.round(Number(result.durationMs));
    } catch (e) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw e instanceof TtsError
        ? e
        : new TtsError('SYNTH_FAILED', `合成失败：${(e && e.message) || 'provider 抛了未知错误'}`, {
            provider: providerName,
            cause: (e && e.message) || String(e),
          });
    }
  }

  if (durationMs == null) {
    try {
      durationMs = await probeDuration(absPath, { root: options.root, runner: options.runner });
    } catch (e) {
      // 时长读不出来就不能用：这次写进 assets 的文件也别留下
      if (!cached) await fs.rm(absPath, { force: true }).catch(() => {});
      throw e;
    }
  }
  if (!(durationMs > 0)) {
    throw new TtsError('AUDIO_EMPTY', `合成出来的音频时长是 0：${absPath}（provider ${providerName}）。`);
  }

  return {
    ok: true,
    provider: providerName,
    voice,
    rate,
    pitch,
    chars,
    audioPath: relPath,
    absPath,
    durationMs,
    bytes,
    cached,
  };
}

// --------------------------------------------------------------- outline ----

const PRIMARY_BREAK = '。！？!?…；;\n';
const SECONDARY_BREAK = '，,、：:';

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

/**
 * 按标点把文本切成语义块（纯函数）。
 *
 * 先按句末标点切；过长的句子再按句中逗号切；仍然超长就硬切。
 * 小于 4 字的碎片并进上一块 —— 字幕里「了。」这种块没有意义。
 */
export function splitScript(text, { maxChars = 24 } = {}) {
  const raw = String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return [];
  const limit = Math.max(6, Number(maxChars) || 24);

  const sentences = [];
  let buf = '';
  for (const ch of raw) {
    buf += ch;
    if (PRIMARY_BREAK.includes(ch)) {
      if (buf.trim()) sentences.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) sentences.push(buf.trim());

  const pieces = [];
  for (const sentence of sentences) {
    if (Array.from(sentence).length <= limit) {
      pieces.push(sentence);
      continue;
    }
    let cur = '';
    for (const ch of sentence) {
      cur += ch;
      const len = Array.from(cur).length;
      const softBreak = SECONDARY_BREAK.includes(ch) && len >= Math.max(6, Math.floor(limit * 0.6));
      if (softBreak || len >= limit) {
        if (cur.trim()) pieces.push(cur.trim());
        cur = '';
      }
    }
    if (cur.trim()) pieces.push(cur.trim());
  }

  const merged = [];
  for (const piece of pieces) {
    if (merged.length && Array.from(piece).length < 4) merged[merged.length - 1] += piece;
    else merged.push(piece);
  }
  return merged.filter(Boolean);
}

/**
 * 把文本分配成字幕片段：每条的时长按字符数占音频总时长的比例分，
 * 最后一条吃掉舍入误差，保证时长总和 ≈ 音频时长。
 *
 * durationSec 是音频时长；返回 [{ text, start, duration }]（相对音频起点）。
 */
export function planSubtitleSegments(text, durationSec, { maxChars = 24, minDuration = 0.25 } = {}) {
  const total = Math.max(0.2, Number(durationSec) || 0);
  let pieces = splitScript(text, { maxChars });
  if (!pieces.length) return [];

  // 音频太短时不能切太碎：每条至少 0.25 秒，超出就把相邻块合并
  const maxCount = Math.max(1, Math.floor(total / Math.max(0.05, minDuration)));
  if (pieces.length > maxCount) {
    const grouped = [];
    for (let i = 0; i < maxCount; i += 1) {
      const from = Math.floor((i * pieces.length) / maxCount);
      const to = Math.floor(((i + 1) * pieces.length) / maxCount);
      grouped.push(pieces.slice(from, to).join(''));
    }
    pieces = grouped;
  }

  const weights = pieces.map((piece) => Math.max(1, Array.from(piece).length));
  const weightSum = weights.reduce((sum, n) => sum + n, 0) || 1;
  const out = [];
  let offset = 0;
  let acc = 0;
  for (let i = 0; i < pieces.length; i += 1) {
    const isLast = i === pieces.length - 1;
    let duration = isLast ? round3(total - acc) : round3((total * weights[i]) / weightSum);
    if (!(duration > 0.01)) duration = 0.01;
    out.push({
      text: pieces[i],
      start: round3(offset),
      duration,
    });
    offset = round3(offset + duration);
    acc = round3(acc + duration);
  }
  // 极端舍入下最后一条可能被压成负数，重新摊一次
  const last = out[out.length - 1];
  if (last && last.duration <= 0) last.duration = 0.2;
  return out;
}

// ------------------------------------------------------------------- speak ---

function clipOverlaps(start, duration, clip) {
  return start < clip.start + clip.duration - 1e-6 && start + duration > clip.start + 1e-6;
}

/** 播放头处如果已有片段，往后推到空位；返回实际起点。 */
export function findFreeStart(doc, trackIds, desired, duration) {
  const tracks = new Set(trackIds);
  const list = (doc.clips || []).filter((c) => tracks.has(c.trackId));
  let start = Math.max(0, Number(desired) || 0);
  for (let guard = 0; guard < 200; guard += 1) {
    const hit = list.find((c) => clipOverlaps(start, duration, c));
    if (!hit) break;
    start = round3(hit.start + hit.duration);
  }
  return start;
}

function fileNameOf(relPath) {
  const parts = String(relPath || '').replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || relPath;
}

async function removeFileQuietly(projectRoot, relPath) {
  try {
    await fs.rm(path.join(projectRoot, String(relPath).replace(/\//g, path.sep)), { force: true });
  } catch {
    /* 清理失败不该盖住真正的错误 */
  }
}

/**
 * 完整流程：合成 → 登记素材 → a1 上放配音（audioRole:'voice'）→ t1 上铺对齐字幕。
 * 一次事务（preview → applyPreview），和手动编辑同一条命令链，所以可撤销。
 */
export async function speak({
  store,
  projectId,
  sessionId,
  text,
  voice,
  rate,
  pitch,
  start,
  provider,
  baseRevision,
  runner,
  root,
  durationMs,
} = {}) {
  if (!store) throw new TtsError('INVALID_ARG', 'speak 需要 store');
  if (!projectId) throw new TtsError('INVALID_ARG', 'speak 需要 projectId');
  if (!sessionId) throw new TtsError('NO_SESSION', '配音要写进某个工程：缺少 sessionId');

  const prepared = prepareText(text);
  const voiceName = normalizeVoice(voice);
  const entry = store.get(projectId);
  store.assertSession(entry.doc, sessionId);
  const doc = entry.doc;

  const synth = await synthesize(prepared, {
    voice: voiceName,
    rate,
    pitch,
    projectRoot: doc.root,
    assetDir: 'assets',
    provider,
    runner,
    root,
    durationMs,
  });

  const durationSec = Math.max(0.2, round3(synth.durationMs / 1000));
  const desired = Math.max(0, Number(start) || 0);
  const clipStart = findFreeStart(doc, ['a1', 't1'], desired, durationSec);
  const subtitles = planSubtitleSegments(prepared, durationSec);

  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const clipId = `tts_${stamp}`;
  const existingAsset = (doc.assets || []).find((a) => a.path === synth.audioPath);
  const assetId = existingAsset ? existingAsset.id : 'asset_' + Math.random().toString(36).slice(2, 10);

  const ops = [];
  if (!doc.tracks.some((t) => t.id === 'a1')) {
    ops.push({ type: 'track.add', trackId: 'a1', kind: 'audio', name: '音频' });
  }
  if (!doc.tracks.some((t) => t.id === 't1')) {
    ops.push({ type: 'track.add', trackId: 't1', kind: 'text', name: '字幕' });
  }
  if (!existingAsset) {
    ops.push({
      type: 'asset.add',
      assetId,
      relPath: synth.audioPath,
      name: fileNameOf(synth.audioPath),
      size: synth.bytes,
      hash: null,
      mime: 'audio/mpeg',
    });
  }
  ops.push({
    type: 'clip.insert',
    clipId,
    trackId: 'a1',
    clipType: 'media',
    assetId,
    start: clipStart,
    duration: durationSec,
    provenance: { libraryId: 'tts', source: synth.provider },
  });
  ops.push({ type: 'clip.set_property', clipId, property: 'audioRole', value: 'voice' });
  for (let i = 0; i < subtitles.length; i += 1) {
    ops.push({
      type: 'clip.insert',
      clipId: `tts_${stamp}_s${i + 1}`,
      trackId: 't1',
      clipType: 'text',
      start: round3(clipStart + subtitles[i].start),
      duration: subtitles[i].duration,
      text: subtitles[i].text,
    });
  }

  let applied;
  try {
    const preview = store.preview(projectId, sessionId, baseRevision, ops, `生成配音：${synth.chars} 字`);
    applied = await store.applyPreview(preview.previewId, sessionId);
  } catch (e) {
    if (!synth.cached) await removeFileQuietly(doc.root, synth.audioPath);
    if (e instanceof DomainError) throw e;
    throw new TtsError('APPLY_FAILED', `配音已经合成，但写进时间线失败：${(e && e.message) || '未知原因'}`, {
      cause: (e && e.message) || String(e),
    });
  }

  return {
    ok: true,
    provider: synth.provider,
    voice: voiceName,
    chars: synth.chars,
    audioPath: synth.audioPath,
    durationMs: synth.durationMs,
    assetId,
    clipId,
    start: clipStart,
    requestedStart: desired,
    shifted: clipStart > desired + 1e-6,
    subtitles: {
      count: subtitles.length,
      trackId: 't1',
      items: subtitles.map((s) => ({
        text: s.text,
        start: round3(clipStart + s.start),
        duration: s.duration,
      })),
    },
    revision: applied.revision,
    transactionId: applied.transactionId,
    human:
      `配音完成：${(synth.durationMs / 1000).toFixed(1)} 秒，${synth.voice}，${synth.chars} 字；` +
      `已插入 a1，字幕 ${subtitles.length} 条` +
      (clipStart > desired + 1e-6 ? `（播放头处已有片段，自动后移到 ${clipStart.toFixed(1)} 秒）` : '') +
      '。',
  };
}

// ------------------------------------------------------------------- tools ---

const textBlocks = (value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
];

function define(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlocks(value),
    },
    execute,
  };
}

function maybeSessionOf(exec) {
  try {
    const id = exec && exec.agent && exec.agent.id;
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

export function ttsTools({ store }) {
  return [
    define(
      'video_tts_status',
      '检查文字转语音（配音）的依赖：ffprobe / Python 与 edge-tts 包 / 网络。合成前先调它探路；' +
        'ready:false 时把 reasons 原样念给用户（每条都写着缺什么、怎么装）。',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => probe(),
    ),

    define(
      'video_tts_speak',
      '文字转语音：把一段文字合成为配音，自动放到音频轨 a1（audioRole=voice），' +
        '并在字幕轨 t1 生成按标点切分、与音频时长对齐的字幕。只在用户明确要求配音 / 旁白 / 口播时调用；' +
        '普通剪辑不要自动配音。文本上限 2000 字；失败会返回带真实原因的 code，不要谎报成功。',
      {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要配音的文字（上限 2000 字）' },
          voice: {
            type: 'string',
            description: '音色 id，默认 zh-CN-XiaoxiaoNeural（晓晓 · 女 · 温和）',
            enum: VOICES.map((v) => v.id),
          },
          rate: {
            type: 'integer',
            description: '语速百分比，-20..+20（默认 0）；超出 -50..+50 会被拒绝',
            minimum: -50,
            maximum: 50,
          },
          pitch: { type: 'integer', description: '音调偏移 Hz，-20..+20（默认 0）', minimum: -50, maximum: 50 },
          start: { type: 'number', description: '时间线起点（秒），默认 0；与已有片段冲突时自动后移' },
          projectId: { type: 'string', description: '省略则用当前会话绑定的工程' },
          sessionId: { type: 'string', description: '省略则用当前会话' },
          baseRevision: { type: 'integer', description: '写入前校验版本，防止覆盖别人的修改' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      async (args, exec) => {
        const sessionId = args.sessionId || maybeSessionOf(exec);
        let projectId = args.projectId || null;
        if (!projectId && sessionId) {
          const hit = [...store.projects.values()].find((p) => p.doc.boundSessionId === sessionId);
          if (hit) projectId = hit.doc.projectId;
        }
        if (!projectId) {
          throw new TtsError('REF_NOT_FOUND', '当前会话还没有打开工程，先调用 video_project_open');
        }
        return speak({
          store,
          projectId,
          sessionId,
          text: args.text,
          voice: args.voice,
          rate: args.rate,
          pitch: args.pitch,
          start: args.start,
          baseRevision: args.baseRevision,
        });
      },
    ),
  ];
}

// 防「导入即注册」的副作用被 HMR 丢掉：模块加载时确保内置 provider 在表里
if (!providers.has('edge')) registerProvider('edge', edgeProvider);
