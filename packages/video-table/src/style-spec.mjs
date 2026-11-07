/**
 * S1「风格确认」：一份风格说明 → 4 个镜头 + 四张关键帧 + 8 秒样片。
 *
 * 这个文件里没有网络、没有模型、没有宿主 API。host 用它校验 spec、铺临时预览工程；
 * client 用同一份绘制函数画关键帧、导样片。两边是同一段代码，所以「面板上看到的」
 * 和「导出的」不可能画歪 —— 这是 S1 唯一要保证的事。
 *
 * 另外两件「凭肉眼看不出来」的事也在这里收口：
 *  - 节拍音（bpmFromRhythm / buildClickTrack）：让「节奏」这个维度能从耳朵里验，
 *    而不是只写在摘要里。纯 PCM，不依赖 Web Audio。
 *  - 对齐检查（alignmentForSpec，实现在 style-align.mjs）：四镜的左边界、基线、
 *    字号层级、强调条比例、圆角/描边、安全区都量成数值，画面「粗糙」才说得清。
 *
 * 四条不变量：
 *  - 纯函数：同一个 (spec, t) 永远画出同一帧，可任意 seek（导出逐帧调用就靠这条）。
 *  - 只依赖 2D canvas API：不 import node:fs / node:path，client 才能 bundle 它。
 *  - 颜色只在 buildStyleShots 里解析一次，落到每个 layer 的 color 字段上：
 *    样片里「哪些层跟着主色走」是数据，不是散落在绘制代码里的 if。
 *  - 预览工程只落在 <projectRoot>/.dsh-video/style-preview/ 下，路径由
 *    previewLayout() 给，测试据此断言它不碰用户工程。
 */

import { applyOps, createProject, DomainError } from './domain.mjs';
// 依赖方向只有这一条：style-spec → style-align。检查器不反过来 import 版式，
// 否则「被检查的东西」和「检查的东西」会一起漂。
import { checkAlignment, estimateTextWidth, measureLayout } from './style-align.mjs';

export const STYLE_VERSION = 'style/v1';

/** 样片固定 8 秒：4 个镜头 × 2 秒。改这个常量要同时改 SHOT_KINDS 的长度。 */
export const PREVIEW_SECONDS = 8;

/** 设计稿尺寸：层里的坐标是分数，但强调条要按「标题有多宽」算长度，得有一把尺子。 */
export const DESIGN_WIDTH = 1280;
export const DESIGN_HEIGHT = 720;

/**
 * 四镜共用的一套版式栅格（分数，按 720p 设计稿）。
 *
 * 四张卡的眉标/标题/副标题都从这里取 y —— 这是「基线一致」既能被检查、
 * 也能被真正修好的前提：想对齐就改这里，不是挨个镜头调魔数。
 */
export const GRID = {
  eyebrowY: 0.13,
  ruleY: 0.215,
  titleY: 0.3,
  closingRuleY: 0.52,
  subtitleY: 0.64,
  badgeY: 0.78,
  dataRuleY: 0.395,
  barYs: [0.5, 0.61, 0.72],
  dataNoteY: 0.86,
  captionScrimY: 0.46,
  captionScrimH: 0.38,
  captionRuleY: 0.555,
  captionLineY: 0.6,
  captionTagY: 0.78,
};

/** 强调条长度 = 所属标题宽度 × 这个比例（检查器的合法区间是 0.2–0.6）。 */
export const EMPHASIS_RATIO = 0.34;

/**
 * 节奏 → BPM 的三档。节奏越短 BPM 越高；样片里的拍点用它，正式时间线也用它。
 * 2 秒/镜 = 120 BPM（每镜正好 4 拍），3 秒/镜 = 90，更慢的镜 = 60。
 */
export const BPM_TIERS = [
  { bpm: 120, maxSeconds: 2 },
  { bpm: 90, maxSeconds: 3 },
  { bpm: 60, maxSeconds: Infinity },
];

/**
 * 节拍音规格：短促脉冲，强拍 880Hz / 弱拍 440Hz，60ms 衰减，峰值 -18dBFS。
 * 这不是音乐，是节拍器：听的是「一拍多长」，不是「好不好听」。
 */
export const CLICK_SPEC = {
  sampleRate: 48000,
  strongHz: 880,
  weakHz: 440,
  clickMs: 60,
  peakDbfs: -18,
  weakDbfs: -22,
  beatsPerBar: 4,
};

/** 四种典型镜头（顺序即时间线顺序）。 */
export const SHOT_KINDS = ['opening', 'data', 'caption', 'closing'];

export const SHOT_LABELS = {
  opening: '开场卡',
  data: '数据卡',
  caption: '字幕卡',
  closing: '收尾卡',
};

/** 动效密度枚举：只认这三个，别的一律拒。 */
export const DENSITIES = ['low', 'med', 'high'];

export const DENSITY_LABELS = { low: '低', med: '中', high: '高' };

/** 面板里能选的字体族。family 是完整的 CSS font-family 串，画的时候直接用。 */
export const FONT_CHOICES = [
  { id: 'sans', label: '无衬线', family: '"Inter", "Noto Sans SC", system-ui, sans-serif' },
  { id: 'serif', label: '衬线', family: '"Noto Serif SC", "Source Han Serif SC", Georgia, serif' },
  { id: 'mono', label: '等宽', family: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace' },
];

/**
 * 各项的合法区间。测试与面板都读这里，不在三处各写一遍数字。
 *
 * 字号是四级：标题 > 副标题 > 正文 > note。区间只约束单个值，不管先后 ——
 * 「比例是否合理」由 style-align 的检查器判定并给出数值，不在这里一拒了之。
 */
export const LIMITS = {
  heading: [24, 200],
  subtitle: [16, 160],
  body: [12, 120],
  note: [9, 80],
  shotSeconds: [0.5, 10],
  transitionSeconds: [0, 1.5],
  radius: [0, 80],
  padding: [0, 240],
  stroke: [0, 12],
};

const COLOR_KEYS = [
  ['accent', '主色'],
  ['secondary', '辅色'],
  ['background', '底色'],
];

const HEX = /^#[0-9a-fA-F]{6}$/;

const round3 = (v) => Math.round(v * 1000) / 1000;

/** 底色亮则用深字，底色暗则用亮字：换底色不会把字吃掉。 */
export function textColorFor(background) {
  const h = HEX.test(String(background || '')) ? String(background).slice(1) : '0F1115';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  // 感知亮度（ITU-R BT.601），够用来判「亮底还是暗底」
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.62 ? '#12161C' : '#F5F7FA';
}

/** 一套完整的默认风格：冷静、克制、留白足。 */
export function defaultStyleSpec() {
  return {
    version: STYLE_VERSION,
    tone: '冷静 · 专业',
    palette: { accent: '#4FD1C5', secondary: '#8B9BB4', background: '#0F1115' },
    // 四级字号：64 / 40 / 26 / 17，相邻比 1.60 / 1.54 / 1.53，都落在 1.4–1.8 里
    font: { family: FONT_CHOICES[0].family, heading: 64, subtitle: 40, body: 26, note: 17 },
    motionDensity: 'med',
    rhythm: { shotSeconds: 2, transitionSeconds: 0.4 },
    radius: 14,
    // 96px ≈ 7.5%：比 5% 安全区宽一点，四镜的左边界都从这条线开始
    padding: 96,
    stroke: 1.5,
    grid: true,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function checkNumber(reasons, value, label, key) {
  const [min, max] = LIMITS[key];
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    reasons.push(`${label}必须是数字：收到 ${JSON.stringify(value)}`);
    return null;
  }
  if (n < min || n > max) {
    reasons.push(`${label}必须在 ${min}–${max} 之间：收到 ${n}`);
    return null;
  }
  return n;
}

/**
 * 校验 + 归一化。
 *
 * 返回 { ok, reasons, warnings, spec }：
 *  - reasons 非空即 ok=false，一条都别放行（中文，指名哪个字段、期望什么）；
 *  - 缺字段不算错，补默认值并记一条 warnings —— 「降级」必须是看得见的降级。
 */
export function validateStyleSpec(spec) {
  const reasons = [];
  const warnings = [];
  const base = defaultStyleSpec();
  const out = clone(base);

  if (spec === undefined || spec === null) {
    warnings.push('没有传 spec，已使用默认风格');
    return { ok: true, reasons, warnings, spec: out };
  }
  if (!isPlainObject(spec)) {
    reasons.push(`spec 必须是对象：收到 ${Array.isArray(spec) ? '数组' : typeof spec}`);
    return { ok: false, reasons, warnings, spec: base };
  }
  if (Object.keys(spec).length === 0) {
    warnings.push('spec 为空对象，已使用默认风格');
    return { ok: true, reasons, warnings, spec: out };
  }

  // ---- 调性 ----
  if (spec.tone === undefined) {
    warnings.push(`缺少 tone，已用默认调性「${base.tone}」`);
  } else if (typeof spec.tone !== 'string' || !spec.tone.trim()) {
    reasons.push('调性（tone）必须是非空字符串');
  } else if (Array.from(spec.tone.trim()).length > 60) {
    reasons.push('调性（tone）最长 60 个字');
  } else {
    out.tone = spec.tone.trim();
  }

  // ---- 配色 ----
  const palette = isPlainObject(spec.palette) ? spec.palette : null;
  if (spec.palette !== undefined && !palette) reasons.push('配色（palette）必须是对象');
  for (const [key, label] of COLOR_KEYS) {
    const raw = palette ? palette[key] : undefined;
    if (raw === undefined) {
      warnings.push(`缺少配色 ${key}，已用默认${label} ${base.palette[key]}`);
      continue;
    }
    if (typeof raw !== 'string' || !HEX.test(raw)) {
      reasons.push(`${label}（palette.${key}）必须是 #rrggbb 形式的十六进制颜色：收到 ${JSON.stringify(raw)}`);
      continue;
    }
    out.palette[key] = raw.toUpperCase();
  }
  if (palette) {
    for (const key of Object.keys(palette)) {
      if (!COLOR_KEYS.some(([k]) => k === key)) {
        warnings.push(`配色里不认识的字段 palette.${key}，已忽略`);
      }
    }
  }

  // ---- 字体 ----
  const font = isPlainObject(spec.font) ? spec.font : null;
  if (spec.font !== undefined && !font) reasons.push('字体（font）必须是对象');
  if (font) {
    if (font.family === undefined) {
      warnings.push('缺少字体族 font.family，已用默认无衬线');
    } else if (typeof font.family !== 'string' || !font.family.trim()) {
      reasons.push('字体族（font.family）必须是非空字符串');
    } else {
      out.font.family = font.family.trim();
    }
    for (const [key, label] of [
      ['heading', '标题字号'],
      ['subtitle', '副标题字号'],
      ['body', '正文字号'],
      ['note', '注释字号'],
    ]) {
      if (font[key] === undefined) {
        warnings.push(`缺少 ${label}（font.${key}），已用默认 ${base.font[key]}px`);
        continue;
      }
      const n = checkNumber(reasons, font[key], `${label}（font.${key}）`, key);
      if (n !== null) out.font[key] = n;
    }
  }
  // 四级字号之间的先后与比例由 style-align 的检查器判定（带 expected/actual/delta），
  // validate 只负责「单值是否落在合法区间」—— 两边都拒绝同一件事，用户只会看到一半信息。

  // ---- 动效密度 ----
  if (spec.motionDensity === undefined) {
    warnings.push(`缺少动效密度 motionDensity，已用默认「${DENSITY_LABELS[base.motionDensity]}」`);
  } else if (!DENSITIES.includes(spec.motionDensity)) {
    reasons.push(
      `动效密度（motionDensity）只能是 ${DENSITIES.join(' / ')}：收到 ${JSON.stringify(spec.motionDensity)}`,
    );
  } else {
    out.motionDensity = spec.motionDensity;
  }

  // ---- 节奏 ----
  const rhythm = isPlainObject(spec.rhythm) ? spec.rhythm : null;
  if (spec.rhythm !== undefined && !rhythm) reasons.push('节奏（rhythm）必须是对象');
  if (rhythm) {
    for (const [key, label] of [
      ['shotSeconds', '每镜秒数（rhythm.shotSeconds）'],
      ['transitionSeconds', '转场秒数（rhythm.transitionSeconds）'],
    ]) {
      if (rhythm[key] === undefined) {
        warnings.push(`缺少 ${label}，已用默认 ${base.rhythm[key]} 秒`);
        continue;
      }
      const n = checkNumber(reasons, rhythm[key], label, key);
      if (n !== null) out.rhythm[key] = n;
    }
    if (out.rhythm.transitionSeconds > out.rhythm.shotSeconds / 2) {
      reasons.push(
        `转场（${out.rhythm.transitionSeconds} 秒）不能超过每镜（${out.rhythm.shotSeconds} 秒）的一半`,
      );
    }
  }

  // ---- 圆角 / 留白 / 网格 ----
  if (spec.radius === undefined) {
    warnings.push(`缺少圆角 radius，已用默认 ${base.radius}px`);
  } else {
    const n = checkNumber(reasons, spec.radius, '圆角（radius）', 'radius');
    if (n !== null) out.radius = n;
  }
  if (spec.padding === undefined) {
    warnings.push(`缺少留白 padding，已用默认 ${base.padding}px`);
  } else {
    const n = checkNumber(reasons, spec.padding, '留白（padding）', 'padding');
    if (n !== null) out.padding = n;
  }
  if (spec.stroke === undefined) {
    warnings.push(`缺少描边宽度 stroke，已用默认 ${base.stroke}px`);
  } else {
    const n = checkNumber(reasons, spec.stroke, '描边宽度（stroke）', 'stroke');
    if (n !== null) out.stroke = n;
  }
  if (spec.grid === undefined) {
    warnings.push('缺少网格开关 grid，已默认开启');
  } else if (typeof spec.grid !== 'boolean') {
    reasons.push('网格开关（grid）必须是 true / false');
  } else {
    out.grid = spec.grid;
  }

  if (Object.keys(spec).some((k) => !(k in base))) {
    const extra = Object.keys(spec).filter((k) => !(k in base));
    warnings.push(`spec 里不认识的字段已忽略：${extra.join(', ')}`);
  }

  return { ok: reasons.length === 0, reasons, warnings, spec: out };
}

/**
 * 预览用 spec：样片固定 4 镜 × 2 秒 = 8 秒，所以节奏被归一到 2 秒。
 *
 * 面板里的「节奏」是留给正式时间线的建议值，不改样片长度 —— 这件事必须写在
 * 返回值里（notes），不能让人以为改了节奏样片就变长。
 */
export function withPreviewRhythm(spec) {
  const normalized = validateStyleSpec(spec);
  if (!normalized.ok) {
    throw new DomainError('INVALID_ARG', '风格 spec 不合法：' + normalized.reasons.join('；'));
  }
  const shotSeconds = PREVIEW_SECONDS / SHOT_KINDS.length;
  const next = clone(normalized.spec);
  const requested = next.rhythm.shotSeconds;
  next.rhythm.shotSeconds = shotSeconds;
  if (next.rhythm.transitionSeconds > shotSeconds / 2) {
    next.rhythm.transitionSeconds = shotSeconds / 2;
  }
  return {
    spec: next,
    requestedShotSeconds: requested,
    notes: [
      `样片固定 ${PREVIEW_SECONDS} 秒：${SHOT_KINDS.length} 镜 × ${shotSeconds} 秒；` +
        `节奏设置（${requested} 秒/镜）作用于正式时间线，不改样片长度。`,
    ],
  };
}

/**
 * 节奏（秒/镜）→ BPM 三档。节奏越短 BPM 越高：一拍始终是「切点附近的时间单位」。
 *
 * 返回 {bpm, intervalMs, shotSeconds}。intervalMs 刻意不取整 —— 120 BPM 的一拍
 * 正好 500ms，四拍正好 2 秒，取整会让拍点和切点越走越偏。
 */
export function bpmFromRhythm(rhythmSec) {
  const seconds = Number(rhythmSec);
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : PREVIEW_SECONDS / SHOT_KINDS.length;
  const tier = BPM_TIERS.find((item) => safe <= item.maxSeconds) || BPM_TIERS[BPM_TIERS.length - 1];
  return { bpm: tier.bpm, intervalMs: 60000 / tier.bpm, shotSeconds: safe };
}

const DB_TO_AMP = (db) => Math.pow(10, Number(db) / 20);

/**
 * 节拍音轨：纯 Float32 PCM，不依赖 Web Audio、不依赖任何宿主 API。
 *
 * 拍点 = BPM 网格 ∪ 每个镜头的起点：
 *  - 网格让你听见「一拍多长」（节奏维度本身）；
 *  - 镜头起点再补一个强拍，让「切点落在第几拍」也听得见 —— 只放网格的话，
 *    节奏和画面脱节，等于又在「听一个跟片子无关的节拍器」。
 * 间隔小于 40ms 的重复拍点合并（保留强拍）。
 *
 * 返回对象是鸭子类型的 AudioBuffer（getChannelData），可以直接塞进导出管线，
 * 也可以在 node 里逐采样断言，不需要任何浏览器环境。
 */
export function buildClickTrack(shots, options = {}) {
  const list = (Array.isArray(shots) ? shots : []).filter(Boolean);
  const sampleRate = Math.max(8000, Math.round(Number(options.sampleRate) || CLICK_SPEC.sampleRate));
  const bpm = Number(options.bpm) > 0 ? Number(options.bpm) : bpmFromRhythm(PREVIEW_SECONDS / SHOT_KINDS.length).bpm;

  let duration = 0;
  for (const shot of list) {
    const end = Number(shot.end);
    const start = Number(shot.start) || 0;
    const span = Number(shot.duration) || 0;
    duration = Math.max(duration, Number.isFinite(end) && end > 0 ? end : start + span);
  }
  if (!(duration > 0)) duration = PREVIEW_SECONDS;

  const length = Math.max(1, Math.round(duration * sampleRate));
  const interval = 60 / bpm;
  const raw = [];

  for (let i = 0; i * interval < duration - 1e-9; i += 1) {
    raw.push({ at: i * interval, strong: i % CLICK_SPEC.beatsPerBar === 0, source: 'grid' });
  }
  for (const shot of list) {
    const at = Number(shot.start);
    if (Number.isFinite(at) && at >= 0 && at < duration) raw.push({ at, strong: true, source: 'cut' });
  }

  raw.sort((a, b) => a.at - b.at);
  const beats = [];
  for (const beat of raw) {
    const last = beats[beats.length - 1];
    if (last && beat.at - last.at < 0.04) {
      if (beat.strong) last.strong = true;
      if (beat.source === 'cut') last.source = 'cut';
      continue;
    }
    beats.push({ at: beat.at, strong: beat.strong, source: beat.source });
  }

  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const clickSamples = Math.max(8, Math.round((CLICK_SPEC.clickMs / 1000) * sampleRate));
  const attackSamples = Math.max(1, Math.round(0.0015 * sampleRate));
  const scratch = new Float32Array(clickSamples);

  for (const beat of beats) {
    const offset = Math.round(beat.at * sampleRate);
    if (offset >= length) continue;
    const peak = DB_TO_AMP(beat.strong ? CLICK_SPEC.peakDbfs : CLICK_SPEC.weakDbfs);
    const freq = beat.strong ? CLICK_SPEC.strongHz : CLICK_SPEC.weakHz;
    const omega = (2 * Math.PI * freq) / sampleRate;
    // 先算出这一拍的形状，再按「峰值正好落在 -18 / -22 dBFS」归一化：
    // 直接乘包络的话，实际峰值会随频率和起振时间漂，写进文档的 -18dB 就不作数了。
    let maxAbs = 0;
    for (let i = 0; i < clickSamples; i += 1) {
      const attack = i < attackSamples ? i / attackSamples : 1;
      // 60ms 内衰减到 -60dB：听感是「嗒」，不是「哔」
      const decay = Math.exp(-6.9 * (i / (clickSamples - 1)));
      const value = Math.sin(omega * i) * attack * decay;
      scratch[i] = value;
      if (Math.abs(value) > maxAbs) maxAbs = Math.abs(value);
    }
    const gain = maxAbs > 0 ? peak / maxAbs : 0;
    for (let i = 0; i < clickSamples; i += 1) {
      const index = offset + i;
      if (index >= length) break;
      const value = scratch[i] * gain;
      left[index] += value;
      right[index] += value;
    }
  }

  let peakAmp = 0;
  for (let i = 0; i < length; i += 1) {
    if (left[i] > 1) left[i] = 1;
    else if (left[i] < -1) left[i] = -1;
    if (right[i] > 1) right[i] = 1;
    else if (right[i] < -1) right[i] = -1;
    peakAmp = Math.max(peakAmp, Math.abs(left[i]), Math.abs(right[i]));
  }

  return {
    sampleRate,
    numberOfChannels: 2,
    length,
    duration: length / sampleRate,
    bpm,
    intervalMs: 60000 / bpm,
    beatsPerBar: CLICK_SPEC.beatsPerBar,
    clickMs: CLICK_SPEC.clickMs,
    strongHz: CLICK_SPEC.strongHz,
    weakHz: CLICK_SPEC.weakHz,
    peakDbfs: CLICK_SPEC.peakDbfs,
    peak: peakAmp,
    beats: beats.map((beat) => ({
      at: Math.round(beat.at * 1000) / 1000,
      strong: !!beat.strong,
      freq: beat.strong ? CLICK_SPEC.strongHz : CLICK_SPEC.weakHz,
      source: beat.source,
    })),
    channels: [left, right],
    getChannelData(channel) {
      const index = Math.max(0, Math.min(1, Math.floor(Number(channel) || 0)));
      return this.channels[index];
    },
  };
}

/** Float32 立体声 → 16bit PCM WAV。混不进 MP4 时的兜底：至少还能单独听。 */
export function clickTrackToWav(track) {
  const sampleRate = Math.max(8000, Math.round(Number(track && track.sampleRate) || CLICK_SPEC.sampleRate));
  const channels = Math.max(1, Math.min(2, Math.round(Number(track && track.numberOfChannels) || 1)));
  const length = Math.max(0, Math.round(Number(track && track.length) || 0));
  const dataBytes = length * channels * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM 头长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // 字节率
  view.setUint16(32, channels * 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  writeText(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < length; i += 1) {
    for (let ch = 0; ch < channels; ch += 1) {
      const data = track && typeof track.getChannelData === 'function' ? track.getChannelData(ch) : null;
      const sample = data ? data[i] || 0 : 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

/** 四张卡片的文案与内容层。文案是示例值，不代表用户的片子内容。 */
function shotContent(spec) {
  const { accent, secondary } = spec.palette;
  const text = textColorFor(spec.palette.background);
  return [
    {
      kind: 'opening',
      text: {
        eyebrow: 'STYLE / S1',
        title: '把复杂的事情\n讲清楚',
        subtitle: '四张卡 + 8 秒样片，先确认风格，再铺整片',
        badge: '样片 01',
      },
      eyebrow: '风格确认 · 开场',
      accent,
      secondary,
      textColor: text,
    },
    {
      kind: 'data',
      text: {
        eyebrow: 'DATA / 02',
        title: '三个数字',
        bars: [
          { label: '信息密度', value: 0.82, role: 'accent' },
          { label: '节奏强度', value: 0.61, role: 'secondary' },
          { label: '视觉留白', value: 0.74, role: 'secondary' },
        ],
        note: '示例数据 · 只用来展示读数层的画法',
      },
      eyebrow: '数据卡 · 读数',
      accent,
      secondary,
      textColor: text,
    },
    {
      kind: 'caption',
      text: {
        eyebrow: 'SUB / 03',
        line: '这一行字幕说明一件事：\n话可以少说，但要说清楚。',
        tag: '字幕卡 · 阅读节奏',
      },
      eyebrow: '字幕卡 · 口播',
      accent,
      secondary,
      textColor: text,
    },
    {
      kind: 'closing',
      text: {
        eyebrow: 'END / 04',
        title: '风格确认',
        subtitle: '确认后按这套风格铺满整片',
        badge: 'END',
      },
      eyebrow: '收尾卡 · 落版',
      accent,
      secondary,
      textColor: text,
    },
  ];
}

/**
 * 把一层镜头的内容展开成绘制层。
 *
 * 颜色在这一步定死（`color` 字段），所以「换主色会改哪些层」是看得见的数据：
 * 只给 accent 的层会跟着变，secondary / text 的层不动。
 *
 * 几何也在这 一步定死，而且只有一套来源：
 *  - 左右边线 = spec.padding（四镜共用，检查器量的就是它）；
 *  - 纵向位置 = GRID（四镜共用，标题基线一致靠它）；
 *  - 强调条长度 = 所属标题宽度 × EMPHASIS_RATIO（不是写死的百分比）。
 */
function layersFor(item, spec) {
  const { kind, text, accent, secondary } = item;
  const textColor = item.textColor;
  const ROLE_TO_SIZE = { eyebrow: 'note', title: 'heading', subtitle: 'subtitle', body: 'body', note: 'note' };
  // 主内容都从同一条左边线开始：spec.padding 是 px，层里存的是分数。
  const mx = Math.max(0, Number(spec.padding) || 0) / DESIGN_WIDTH;
  const rule = (y, titleText, sizeKey) => {
    const widthPx = Math.max(
      DESIGN_WIDTH * 0.04,
      Math.min(DESIGN_WIDTH * 0.4, estimateTextWidth(titleText, spec.font[sizeKey]) * EMPHASIS_RATIO),
    );
    return {
      type: 'rule',
      role: 'emphasis',
      color: accent,
      x: mx,
      y,
      w: widthPx / DESIGN_WIDTH,
      h: 6,
      radius: 3,
    };
  };
  const textLayer = (role, value, y, options) => {
    const opts = options || {};
    return {
      type: 'text',
      role,
      color: opts.color || textColor,
      text: value,
      // 四镜一律左对齐：居中的卡量不出可比的左边界，也就补不上「对齐」这件事
      x: mx,
      y,
      size: spec.font[opts.sizeKey || ROLE_TO_SIZE[role]],
      weight: opts.weight || 400,
      align: 'left',
      lineHeight: opts.lineHeight || 1.2,
    };
  };
  const badge = (value, y) => ({
    type: 'badge',
    role: 'badge',
    color: accent,
    text: value,
    x: mx,
    y,
    size: spec.font.note,
  });

  if (kind === 'opening') {
    return [
      { type: 'backdrop', role: 'background', color: spec.palette.background },
      { type: 'grid', role: 'secondary', color: secondary },
      textLayer('eyebrow', text.eyebrow, GRID.eyebrowY, { color: accent, weight: 600 }),
      rule(GRID.ruleY, text.title, 'heading'),
      textLayer('title', text.title, GRID.titleY, { weight: 700, lineHeight: 1.16 }),
      textLayer('subtitle', text.subtitle, GRID.subtitleY, { color: secondary, lineHeight: 1.3 }),
      badge(text.badge, GRID.badgeY),
    ];
  }

  if (kind === 'data') {
    const bars = text.bars || [];
    const layers = [
      { type: 'backdrop', role: 'background', color: spec.palette.background },
      { type: 'grid', role: 'secondary', color: secondary },
      textLayer('eyebrow', text.eyebrow, GRID.eyebrowY, { color: accent, weight: 600 }),
      textLayer('title', text.title, GRID.titleY, { weight: 700, lineHeight: 1.16 }),
      rule(GRID.dataRuleY, text.title, 'heading'),
    ];
    bars.forEach((bar, index) => {
      layers.push({
        type: 'bar',
        role: 'bar',
        color: bar.role === 'accent' ? accent : secondary,
        x: mx,
        y: GRID.barYs[index] === undefined ? GRID.barYs[GRID.barYs.length - 1] + (index - 2) * 0.12 : GRID.barYs[index],
        w: 0.72,
        h: 14,
        // 圆角走 token：改 spec.radius，四条读数条一起变
        radius: spec.radius,
        value: bar.value,
        label: bar.label,
        labelSize: spec.font.note,
      });
    });
    layers.push(textLayer('note', text.note, GRID.dataNoteY, { color: secondary }));
    return layers;
  }

  if (kind === 'caption') {
    return [
      { type: 'backdrop', role: 'background', color: spec.palette.background },
      { type: 'grid', role: 'secondary', color: secondary },
      textLayer('eyebrow', text.eyebrow, GRID.eyebrowY, { color: accent, weight: 600 }),
      { type: 'scrim', role: 'background', color: '#000000', alpha: 0.42, y: GRID.captionScrimY, h: GRID.captionScrimH },
      rule(GRID.captionRuleY, text.line, 'body'),
      textLayer('body', text.line, GRID.captionLineY, { weight: 500, lineHeight: 1.35 }),
      textLayer('note', text.tag, GRID.captionTagY, { color: secondary }),
    ];
  }

  // closing
  return [
    { type: 'backdrop', role: 'background', color: spec.palette.background },
    { type: 'grid', role: 'secondary', color: secondary },
    textLayer('eyebrow', text.eyebrow, GRID.eyebrowY, { color: accent, weight: 600 }),
    textLayer('title', text.title, GRID.titleY, { weight: 700, lineHeight: 1.16 }),
    rule(GRID.closingRuleY, text.title, 'heading'),
    textLayer('subtitle', text.subtitle, GRID.subtitleY, { color: secondary, lineHeight: 1.3 }),
    badge(text.badge, GRID.badgeY),
  ];
}

function shotMotion(spec) {
  const density = spec.motionDensity;
  return {
    enter: 'fade-up',
    exit: 'none',
    density,
    // 进入动效的总时长（秒）与每层之间的错峰，都由密度决定
    enterSeconds: density === 'high' ? 0.32 : density === 'low' ? 0.72 : 0.5,
    staggerSeconds: density === 'high' ? 0.05 : density === 'low' ? 0.15 : 0.09,
    travelPx: density === 'high' ? 42 : density === 'low' ? 12 : 26,
    leadSeconds: 0.14,
    easing: 'easeOutCubic',
  };
}

/**
 * spec → 4 个镜头定义。
 *
 * 每镜带：时间区间（start/duration/end）、内容层（layers）、动效（motion）、
 * 转场（transitionOut）以及可直接喂给 store.preview 的 clip.insert 命令（ops）。
 * 默认 spec 下总时长正好 8 秒，区间首尾相接、无缝。
 */
export function buildStyleShots(spec, options) {
  const checked = validateStyleSpec(spec);
  if (!checked.ok) {
    throw new DomainError('INVALID_ARG', '风格 spec 不合法：' + checked.reasons.join('；'));
  }
  const normalized = checked.spec;
  const shotSeconds = normalized.rhythm.shotSeconds;
  const transitionSeconds = Math.min(normalized.rhythm.transitionSeconds, shotSeconds / 2);
  const trackId = (options && options.trackId) || 'v1';
  const content = shotContent(normalized);
  const motion = shotMotion(normalized);

  return content.map((item, index) => {
    const start = round3(index * shotSeconds);
    const end = round3(start + shotSeconds);
    const duration = round3(end - start);
    const layerId = `style-${item.kind}`;
    const clipId = `style_${item.kind}`;
    const shot = {
      index,
      id: shotId(item.kind),
      kind: item.kind,
      label: SHOT_LABELS[item.kind],
      eyebrow: item.eyebrow,
      start,
      duration,
      end,
      // 关键帧取这一镜的 72% 处：进入动效已经走完，内容是全的
      keyframeAt: round3(start + duration * 0.72),
      theme: {
        accent: normalized.palette.accent,
        secondary: normalized.palette.secondary,
        background: normalized.palette.background,
        text: item.textColor,
        family: normalized.font.family,
        radius: normalized.radius,
        strokeWidth: normalized.stroke,
        padding: normalized.padding,
        grid: normalized.grid,
        motionDensity: normalized.motionDensity,
      },
      layers: layersFor(item, normalized),
      motion: clone(motion),
      transitionOut:
        index < content.length - 1 ? { type: 'crossfade', duration: round3(transitionSeconds) } : null,
      content: clone(item.text),
      layerId,
      clipId,
    };
    shot.ops = [
      {
        type: 'clip.insert',
        clipId,
        trackId,
        clipType: 'code',
        layerId,
        start,
        duration,
        contentDuration: duration,
        props: { styleShot: shot.id, styleVersion: STYLE_VERSION },
      },
    ];
    return shot;
  });
}

export function shotId(kind) {
  return 'style-' + kind;
}

/** 预览工程在工程目录里的位置。只给相对路径（POSIX 风格），落盘时由 host 拼接。 */
export function previewLayout() {
  const relDir = '.dsh-video/style-preview';
  return {
    relDir,
    relDoc: relDir + '/project.json',
    relStyle: relDir + '/style.json',
    relCodeDir: relDir + '/code',
    relFramesDir: relDir + '/frames',
    relVideo: relDir + '/preview-8s.mp4',
    relVideoWebm: relDir + '/preview-8s.webm',
    /**
     * 独立的节拍音轨：只有在混不进样片（浏览器没有 AudioEncoder / AAC）时才落盘。
     * 它和样片长度一样，面板用它配「播放节拍」按钮。
     */
    relClick: relDir + '/preview-8s-click.wav',
    /**
     * 样片路径按容器给：容器由导出端的编码能力决定（没有 H.264 编码器就是 WebM），
     * 文件名必须说实话，不能把 WebM 字节写成 .mp4。
     */
    videoRelPath(container) {
      return container === 'webm' ? relDir + '/preview-8s.webm' : relDir + '/preview-8s.mp4';
    },
    /** 第 index 张关键帧的工程内相对路径 */
    frameRelPath(index, kind) {
      const n = String(index + 1).padStart(2, '0');
      return `${relDir}/frames/${n}-${kind}.png`;
    },
    /** 第 index 张关键帧在预览目录里的相对路径（面板/接口用这个） */
    frameFileName(index, kind) {
      const n = String(index + 1).padStart(2, '0');
      return `${n}-${kind}.png`;
    },
  };
}

/** 稳定指纹：spec 一样就不必重画样片。纯字符串运算，不引 node:crypto。 */
export function styleFingerprint(spec) {
  const normalized = validateStyleSpec(spec).spec;
  const text = JSON.stringify(normalized);
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return 'fnv1a:' + hash.toString(16).padStart(8, '0');
}

/**
 * 生成代码图层源码：一个镜头一份，导出 render(ctx2d, t, env)。
 *
 * 函数体直接取自 paintShotLayers —— 和面板、导出用的是同一个绘制器，
 * 所以「打开预览工程看到的」和「面板里生成的样片」是同一张画。
 */
export function shotLayerSource(shot, spec) {
  const normalized = spec === undefined ? null : validateStyleSpec(spec).spec;
  const theme = normalized
    ? Object.assign({}, shot.theme, {
        accent: normalized.palette.accent,
        secondary: normalized.palette.secondary,
        background: normalized.palette.background,
        text: textColorFor(normalized.palette.background),
        family: normalized.font.family,
        grid: normalized.grid,
        motionDensity: normalized.motionDensity,
      })
    : shot.theme;
  const payload = clone(
    Object.assign({}, shot, {
      theme,
      ops: undefined,
      layers: Array.isArray(shot.layers) ? shot.layers : [],
    }),
  );
  delete payload.ops;
  const body = paintShotLayers.toString();
  return [
    '// 由 src/style-spec.mjs 从风格 spec 展开的代码图层，不要手改。',
    '// 契约：render(ctx2d, t, env)，t 是这一镜内的时间（秒）；必须是 t 的纯函数，可任意 seek。',
    `const SHOT = ${JSON.stringify(payload, null, 2)};`,
    'const paintShotLayers = ' + body + ';',
    'export function render(ctx2d, t, env) {',
    '  paintShotLayers(ctx2d, SHOT, { width: (env && env.width) || 1280, height: (env && env.height) || 720, t: t, alpha: 1 });',
    '}',
    '',
  ].join('\n');
}

/**
 * 唯一的绘制实现：把一个镜头画进任意 2D ctx。
 *
 * 这个函数会被 toString() 嵌进代码图层，所以：
 *  - 只用 ctx / shot / view 三个入参和 Math、String、Number；
 *  - 不引用模块级的任何东西（包括常量），需要的东西从 shot.theme 里取。
 */
function paintShotLayers(ctx, shot, view) {
  const W = Math.max(2, Math.round((view && view.width) || 1280));
  const H = Math.max(2, Math.round((view && view.height) || 720));
  const t = Number(view && view.t) || 0;
  const baseAlpha = view && view.alpha === undefined ? 1 : Math.max(0, Math.min(1, Number(view && view.alpha)));
  const theme = (shot && shot.theme) || {};
  const motion = (shot && shot.motion) || {};
  const scale = H / 720;
  const family = theme.family || 'sans-serif';
  const accent = theme.accent || '#4FD1C5';
  const secondary = theme.secondary || '#8B9BB4';
  const textColor = theme.text || '#F5F7FA';

  const density = theme.motionDensity === 'low' || theme.motionDensity === 'high' ? theme.motionDensity : 'med';
  const enterSeconds = Number(motion.enterSeconds) || (density === 'high' ? 0.32 : density === 'low' ? 0.72 : 0.5);
  const stagger = Number(motion.staggerSeconds) || (density === 'high' ? 0.05 : density === 'low' ? 0.15 : 0.09);
  const travel = (Number(motion.travelPx) || 26) * scale;
  const lead = Number(motion.leadSeconds) || 0;

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const easeOut = (v) => 1 - Math.pow(1 - v, 3);
  const hexToRgba = (hex, alpha) => {
    const h = /^#[0-9a-fA-F]{6}$/.test(String(hex || '')) ? String(hex).slice(1) : 'FFFFFF';
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = Math.max(0, Math.min(1, Number(alpha)));
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
  };
  const roundedPath = (x, y, w, h, r) => {
    const rr = Math.max(0, Math.min(Number(r) || 0, Math.min(w, h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  };

  // 底色 + 网格：这两层不参与逐层错峰，但有同样的整体透明度
  ctx.save();
  ctx.globalAlpha = baseAlpha;
  ctx.fillStyle = theme.background || '#0F1115';
  ctx.fillRect(0, 0, W, H);
  if (theme.grid) {
    ctx.strokeStyle = hexToRgba(secondary, 0.1);
    ctx.lineWidth = Math.max(1, scale);
    const step = 80 * scale;
    ctx.beginPath();
    for (let x = step; x < W; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    for (let y = step; y < H; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();
  }
  ctx.fillStyle = hexToRgba(accent, 0.06);
  ctx.fillRect(0, 0, W, 6 * scale);
  ctx.restore();

  const layers = Array.isArray(shot && shot.layers) ? shot.layers : [];
  let order = 0;
  for (const layer of layers) {
    if (!layer || layer.type === 'backdrop' || layer.type === 'grid') continue;
    order += 1;
    const p = clamp01((t + lead - (order - 1) * stagger) / enterSeconds);
    const a = easeOut(p);
    const dy = (1 - a) * travel;
    ctx.save();
    ctx.globalAlpha = baseAlpha * a * (layer.opacity === undefined ? 1 : Number(layer.opacity));
    if (layer.type === 'text') {
      const size = Math.max(1, (Number(layer.size) || 28) * scale);
      ctx.fillStyle = layer.color || textColor;
      ctx.font = (layer.weight || 400) + ' ' + size + 'px ' + family;
      ctx.textAlign = layer.align || 'left';
      ctx.textBaseline = 'top';
      const lines = String(layer.text === undefined || layer.text === null ? '' : layer.text).split('\n');
      const lineHeight = size * (Number(layer.lineHeight) || 1.2);
      const x = (layer.x === undefined ? 0.1 : Number(layer.x)) * W;
      const y = (layer.y === undefined ? 0.2 : Number(layer.y)) * H + dy;
      for (let i = 0; i < lines.length; i += 1) {
        ctx.fillText(lines[i], x, y + i * lineHeight);
      }
    } else if (layer.type === 'rule') {
      const h = Math.max(1, (Number(layer.h) || 5) * scale);
      const w = Math.max(2, Number(layer.w || 0.1) * W * (0.2 + 0.8 * a));
      const x = Number(layer.x || 0) * W;
      const y = Number(layer.y || 0) * H + dy;
      ctx.fillStyle = layer.color || accent;
      roundedPath(x, y, w, h, Number(layer.radius === undefined ? h / 2 : layer.radius) * scale);
      ctx.fill();
    } else if (layer.type === 'bar') {
      const x = Number(layer.x || 0.1) * W;
      const y = Number(layer.y || 0.5) * H + dy;
      const w = Number(layer.w || 0.6) * W;
      const h = Math.max(4, (Number(layer.h) || 14) * scale);
      const r = Number(layer.radius === undefined ? h / 2 : layer.radius) * scale;
      ctx.fillStyle = hexToRgba(textColor, 0.1);
      roundedPath(x, y, w, h, r);
      ctx.fill();
      const value = clamp01(Number(layer.value) || 0) * a;
      if (value > 0.001) {
        ctx.fillStyle = layer.color || accent;
        roundedPath(x, y, Math.max(h, w * value), h, r);
        ctx.fill();
      }
      const labelSize = Math.max(1, (Number(layer.labelSize) || 15) * scale);
      ctx.font = '500 ' + labelSize + 'px ' + family;
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'left';
      ctx.fillStyle = textColor;
      ctx.fillText(String(layer.label === undefined ? '' : layer.label), x, y - 8 * scale);
      ctx.textAlign = 'right';
      ctx.fillStyle = layer.color || accent;
      ctx.fillText(Math.round((Number(layer.value) || 0) * 100) + '%', x + w, y - 8 * scale);
    } else if (layer.type === 'badge') {
      const size = Math.max(1, (Number(layer.size) || 15) * scale);
      const pad = 12 * scale;
      const text = String(layer.text === undefined ? '' : layer.text);
      const bw = Math.min(W * 0.8, text.length * size * 0.62 + pad * 2);
      const bh = size * 2;
      const x = Number(layer.x || 0.1) * W;
      const y = Number(layer.y || 0.7) * H + dy;
      // 圆角与描边是 spec 的 token：四镜一致由检查器核对，这里只照做
      const strokeW = Math.max(0, Number(theme.strokeWidth === undefined ? 1.5 : theme.strokeWidth)) * scale;
      const corner = Number(theme.radius === undefined ? 8 : theme.radius) * scale;
      ctx.fillStyle = hexToRgba(layer.color || accent, 0.12);
      ctx.strokeStyle = layer.color || accent;
      roundedPath(x, y, bw, bh, corner);
      ctx.fill();
      if (strokeW > 0) {
        ctx.lineWidth = Math.max(0.5, strokeW);
        ctx.stroke();
      }
      ctx.fillStyle = layer.color || accent;
      ctx.font = '600 ' + size + 'px ' + family;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + pad, y + bh / 2);
    } else if (layer.type === 'scrim') {
      ctx.fillStyle = hexToRgba(layer.color || '#000000', layer.alpha === undefined ? 0.45 : Number(layer.alpha));
      ctx.fillRect(0, Number(layer.y || 0.5) * H, W, Number(layer.h || 0.3) * H);
    }
    ctx.restore();
  }
}

/**
 * 画整段样片的一帧（t 是时间线时间，0..8）。
 *
 * 镜头之间按 spec.rhythm.transitionSeconds 做交叉淡入：先画上一镜的延展帧，
 * 再把下一镜以 alpha=进度 叠上去。导出逐帧调用它，所以这里必须没有随机数、没有时间。
 */
export function drawStyleFrame(ctx, view) {
  const shots = Array.isArray(view && view.shots) ? view.shots : [];
  const spec = (view && view.spec) || defaultStyleSpec();
  const W = Math.max(2, Math.round((view && view.width) || 1280));
  const H = Math.max(2, Math.round((view && view.height) || 720));
  const t = Math.max(0, Number(view && view.t) || 0);

  ctx.save();
  ctx.fillStyle = spec.palette.background;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  if (!shots.length) return;

  const shotSeconds = Math.max(0.1, Number(spec.rhythm.shotSeconds) || shots[0].duration || 2);
  const transition = Math.max(
    0,
    Math.min(Number(spec.rhythm.transitionSeconds) || 0, shotSeconds / 2),
  );
  const index = Math.min(shots.length - 1, Math.max(0, Math.floor(t / shotSeconds)));
  const shot = shots[index];
  const local = Math.max(0, t - shot.start);

  const easeInOut = (v) => (v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2);

  if (index > 0 && transition > 0 && local < transition) {
    const prev = shots[index - 1];
    paintShotLayers(ctx, prev, {
      width: W,
      height: H,
      t: shotSeconds + local,
      alpha: 1,
    });
    paintShotLayers(ctx, shot, {
      width: W,
      height: H,
      t: local,
      alpha: easeInOut(local / transition),
    });
    return;
  }

  paintShotLayers(ctx, shot, { width: W, height: H, t: local, alpha: 1 });
}

/**
 * 人类可读的风格说明（面板顶部那一行用）。颜色与字体必须出现在里面 ——
 * 面板上改主色/字体，这里立刻能看见改了哪一项。
 */
export function specToSummary(spec) {
  const checked = validateStyleSpec(spec);
  const s = checked.spec;
  const fontLabel = (FONT_CHOICES.find((f) => f.family === s.font.family) || {}).label || '自定义';
  const beat = bpmFromRhythm(s.rhythm.shotSeconds);
  const lines = [
    `调性：${s.tone}`,
    `配色：主色 ${s.palette.accent} · 辅色 ${s.palette.secondary} · 底色 ${s.palette.background}`,
    `字体：${fontLabel}（${s.font.family}）· 标题 ${s.font.heading}px / 副标题 ${s.font.subtitle}px / 正文 ${s.font.body}px / 注释 ${s.font.note}px`,
    `动效：${DENSITY_LABELS[s.motionDensity]}密度 · 节奏 ${s.rhythm.shotSeconds} 秒/镜（${beat.bpm} BPM）· 转场 ${s.rhythm.transitionSeconds} 秒` +
      ` · 圆角 ${s.radius}px · 描边 ${s.stroke}px · 留白 ${s.padding}px · 网格 ${s.grid ? '开' : '关'}`,
  ];
  return lines.join('\n');
}

/** 节拍参数（写进 style.json，也回给面板）：只说清「这一版节拍是什么样」。 */
export function clickSpecFor(spec) {
  const normalized = validateStyleSpec(spec).spec;
  const beat = bpmFromRhythm(normalized.rhythm.shotSeconds);
  return {
    bpm: beat.bpm,
    intervalMs: beat.intervalMs,
    beatsPerBar: CLICK_SPEC.beatsPerBar,
    clickMs: CLICK_SPEC.clickMs,
    strongHz: CLICK_SPEC.strongHz,
    weakHz: CLICK_SPEC.weakHz,
    peakDbfs: CLICK_SPEC.peakDbfs,
    weakDbfs: CLICK_SPEC.weakDbfs,
  };
}

/**
 * 对齐检查：把四镜布局量出来再判定。面板、route、测试都调这一个函数，
 * 所以「面板上显示的 6 项通过」和「style.json 里的 alignment」不可能不一致。
 */
export function alignmentForSpec(spec, options) {
  const normalized = validateStyleSpec(spec).spec;
  const shots = buildStyleShots(normalized);
  const layout = measureLayout(shots, {
    spec: normalized,
    width: (options && options.width) || DESIGN_WIDTH,
    height: (options && options.height) || DESIGN_HEIGHT,
  });
  return checkAlignment(layout);
}

/**
 * 临时预览工程：把 4 个镜头铺进一份真实的工程文档。
 *
 * 只返回「要写哪些文件、写什么」，不碰磁盘 —— host 负责落盘，测试负责断言路径。
 * `doc.root` 指向预览目录，不是用户工程目录；`files` 里的每个 relPath 都在预览目录下。
 */
export function buildPreviewProject({ projectRoot, sessionId, spec, title } = {}) {
  if (!projectRoot) throw new DomainError('INVALID_ARG', 'buildPreviewProject 需要 projectRoot');
  if (!sessionId) throw new DomainError('INVALID_ARG', 'buildPreviewProject 需要 sessionId');
  const prepared = withPreviewRhythm(spec);
  const layout = previewLayout();
  const shots = buildStyleShots(prepared.spec, { trackId: 'v1' });

  // 用一个固定的工程 id：预览目录里的 project.json 不该每次换身份，否则对不上上一轮样片。
  // 它只活在预览目录里，不进 store、不进绑定表 —— 用户工程一个字节都不动。
  const base = createProject({
    sessionId,
    root: layout.relDir,
    ratio: '16:9',
    fps: 30,
    title: (title || '风格样片') + ' · ' + prepared.spec.tone,
  });
  base.projectId = 'vp_style_preview';
  const ops = shots.reduce((all, shot) => all.concat(shot.ops), []);
  // 走真实的命令语义：clip.insert 的形状、轨道是否存在、时长重算都由 domain 判，
  // 预览工程不是「手写的假数据」，是同一套命令铺出来的。
  const applied = applyOps(base, ops);

  const summary = specToSummary(prepared.spec);
  const fingerprint = styleFingerprint(prepared.spec);
  // 节拍按「请求的节奏」算 BPM（面板上那个下拉框的值），样片本身仍是 8 秒 4 镜。
  // 这样「把节奏改成 3 秒/镜」能立刻在耳朵里听出差别，而不是只有一行文字变了。
  const click = Object.assign(clickSpecFor({ ...prepared.spec, rhythm: { ...prepared.spec.rhythm, shotSeconds: prepared.requestedShotSeconds } }), {
    sampleRate: CLICK_SPEC.sampleRate,
  });
  const alignment = alignmentForSpec(prepared.spec);
  const files = shots.map((shot) => ({
    relPath: `${layout.relCodeDir}/${shot.layerId}/index.js`,
    content: shotLayerSource(shot, prepared.spec),
    kind: 'code',
    layerId: shot.layerId,
  }));
  files.push({
    relPath: layout.relDoc,
    content: JSON.stringify(applied.doc, null, 2) + '\n',
    kind: 'doc',
  });
  files.push({
    relPath: layout.relStyle,
    content:
      JSON.stringify(
        {
          format: 'dsh-video/style-preview/v1',
          fingerprint,
          summary,
          spec: prepared.spec,
          requestedShotSeconds: prepared.requestedShotSeconds,
          duration: PREVIEW_SECONDS,
          shots: shots.map((shot) => ({
            index: shot.index,
            kind: shot.kind,
            label: shot.label,
            start: shot.start,
            duration: shot.duration,
            end: shot.end,
            keyframeAt: shot.keyframeAt,
            layerId: shot.layerId,
            clipId: shot.clipId,
            motion: shot.motion,
            transitionOut: shot.transitionOut,
          })),
          frames: shots.map((shot) => layout.frameFileName(shot.index, shot.kind)),
          video: 'preview-8s.mp4',
          click,
          alignment,
          at: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
    kind: 'style',
  });

  return {
    spec: prepared.spec,
    requestedShotSeconds: prepared.requestedShotSeconds,
    summary,
    fingerprint,
    shots,
    doc: applied.doc,
    files,
    layout,
    duration: PREVIEW_SECONDS,
    click,
    alignment,
    notes: prepared.notes.concat([
      '节拍仅用于确认节奏，不进入成片；改「节奏」会同时改变节拍的速度。',
    ]),
  };
}
