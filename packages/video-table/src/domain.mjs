/**
 * Domain layer: the project document, the command engine, and the diff.
 *
 * Pure functions only. No fs, no network, no React. Every command takes a
 * document and returns a NEW document plus a diff; nothing mutates in place,
 * so a failed transaction leaves the last revision untouched.
 *
 * Time is in seconds (finite, >= 0). Ids are caller-supplied stable strings.
 */

import { AUDIO_VOLUME_MIN, AUDIO_VOLUME_MAX } from './audio-mix.mjs';

export { AUDIO_VOLUME_MIN, AUDIO_VOLUME_MAX };

export class DomainError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

/**
 * 导出帧率的服务端校验（exports[] 记账用）。
 *
 * 时间线是纯时间驱动的，导出帧率与工程帧率可以不同；这里只守住基本区间：
 * 必须是正数、不超过 120。缺省（null / '' / undefined）表示老调用方没给，原样记 null。
 * 客户端 exporter 有同一套上限（MAX_EXPORT_FPS）；两边都写是有意的 ——
 * agent 可能绕过面板直接调 export.record。
 */
export const EXPORT_FPS_MAX = 120;

export function normalizeExportFps(value, label = 'fps') {
  if (value === undefined || value === null || value === '') return null;
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new DomainError('INVALID_ARG', `${label} 必须是大于 0 的数字`);
  }
  if (fps > EXPORT_FPS_MAX) {
    throw new DomainError('INVALID_ARG', `${label} 不能超过 ${EXPORT_FPS_MAX}`);
  }
  return fps === Math.trunc(fps) ? fps : Math.round(fps * 1000) / 1000;
}

const FINITE = (n) => typeof n === 'number' && Number.isFinite(n);
const round = (n) => Math.round(n * 1000) / 1000;

/**
 * 标注类型白名单。
 *
 * 和 annotations.mjs 的 ANNOTATION_INTENTS、store 的 ANNOTATION_INTENTS、
 * 面板下拉里的四个选项是同一套。这里再守一道的原因：ops 路径（edit.preview）
 * 可以被 agent / 脚本直接调用，不经过 annotationOp —— 白名单只写在客户端那一层
 * 就等于没写。annotations.mjs 反过来 import 了 domain，所以不能互相引用，
 * 只能各留一份；改列表时四处一起改（测试会盯着）。
 */
const ANNOTATION_INTENTS = ['change', 'issue', 'question', 'note'];

/**
 * 音频片段的角色：voice 触发 ducking，music 参与 ducking，sfx 两者都不。
 * 未标注的片段按 sfx 处理（保守：不让来源不明的音频意外触发回避）。
 */
export const AUDIO_ROLES = new Set(['voice', 'music', 'sfx']);

/**
 * 片段音频属性（只有音频轨上的片段才有语义）：
 *   volume   0..2，默认 1；> 1 是放大，允许但不鼓励（导出端有 headroom 保护）
 *   fadeIn   淡入秒数，默认 0；与 fadeOut 之和不得超过片段时长
 *   fadeOut  淡出秒数，默认 0
 *   muted    静音，默认 false
 *
 * 视频轨上的片段带这些字段也不报错（老工程 / 面板可能顺手写），但播放与导出都忽略它们。
 * 写入路径（clip.setAudio / clip.update / clip.set_property）在音频轨之外一律拒绝，
 * 免得「设了却没生效」。
 */
export const AUDIO_DEFAULTS = Object.freeze({ volume: 1, fadeIn: 0, fadeOut: 0, muted: false });
export const AUDIO_PROP_FIELDS = Object.freeze(['volume', 'muted', 'fadeIn', 'fadeOut']);

// ------------------------------------------------------------ 关键帧缓动 ----

/**
 * 贝塞尔缓动的四个控制点分量都必须落在 0..1。
 * y 超出 0..1 浏览器是允许的（会过冲），但那样缓动不再单调，关键帧动画会
 * 出现肉眼可见的回弹 —— 这里直接拒绝，不让它静默画错。
 */
export function isValidBezier(b) {
  return Array.isArray(b) && b.length === 4 && b.every((n) => FINITE(n) && n >= 0 && n <= 1);
}

function assertBezier(b) {
  if (!Array.isArray(b) || b.length !== 4) {
    throw new DomainError('INVALID_OP', 'bezier 必须是 [x1, y1, x2, y2] 四个数字');
  }
  for (let i = 0; i < 4; i += 1) {
    const n = b[i];
    if (!FINITE(n)) {
      throw new DomainError('INVALID_OP', `bezier 第 ${i + 1} 个分量必须是数字，收到 ${JSON.stringify(n)}`);
    }
    if (n < 0 || n > 1) {
      throw new DomainError('INVALID_OP', `bezier 第 ${i + 1} 个分量必须在 0..1 之间，收到 ${n}`);
    }
  }
  return b.map(round);
}

/** 三次贝塞尔在参数 t 处的 x 分量（P0=0, P3=1）。 */
function bezierCoord(t, p1, p2) {
  const mt = 1 - t;
  return 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t;
}

/** 三次贝塞尔在参数 t 处的导数。 */
function bezierSlope(t, p1, p2) {
  const mt = 1 - t;
  return 3 * mt * mt * p1 + 6 * mt * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

/**
 * 三次贝塞尔缓动：先解 x(t) = k，再取 y(t)。
 * 牛顿迭代最多 8 次；斜率太小或迭代跑出 [0,1] 时退化成二分（最多再 24 次）。
 * 纯函数：k 越界时夹住，端点严格返回 0 / 1。
 */
export function bezierEase(x1, y1, x2, y2, k) {
  const p = [x1, y1, x2, y2].map(Number);
  if (!p.every((n) => Number.isFinite(n))) {
    throw new DomainError('INVALID_OP', 'bezierEase 的控制点必须是数字');
  }
  const kk = FINITE(k) ? k : 0;
  if (kk <= 0) return 0;
  if (kk >= 1) return 1;
  let t = kk;
  for (let i = 0; i < 8; i += 1) {
    const err = bezierCoord(t, p[0], p[2]) - kk;
    if (Math.abs(err) < 1e-6) return bezierCoord(t, p[1], p[3]);
    const d = bezierSlope(t, p[0], p[2]);
    if (Math.abs(d) < 1e-6) break;
    const next = t - err / d;
    if (!(next >= 0 && next <= 1)) break;
    t = next;
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i += 1) {
    t = (lo + hi) / 2;
    if (bezierCoord(t, p[0], p[2]) < kk) lo = t;
    else hi = t;
  }
  return bezierCoord(t, p[1], p[3]);
}

// ------------------------------------------------------------- 文字样式 ----

/**
 * 文字样式白名单：命令引擎（写）和渲染器（读）共用这一份。
 * 白名单外的字段一律拒绝 —— 我们宁可让调用方立刻看到中文原因，
 * 也不要把一个「看起来设了、其实没生效」的字段静默存进工程文档。
 */
export const TEXT_FONT_FAMILIES = ['system-ui', 'Microsoft YaHei', 'SimHei', 'serif', 'monospace'];
export const TEXT_FONT_WEIGHTS = [400, 600, 700, 900];
export const TEXT_ALIGNS = ['left', 'center', 'right'];
export const TEXT_SIZE_MIN = 12;
export const TEXT_SIZE_MAX = 200;
export const TEXT_LINE_HEIGHT_MIN = 1;
export const TEXT_LINE_HEIGHT_MAX = 3;
export const TEXT_STYLE_FIELDS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'color',
  'stroke',
  'shadow',
  'align',
  'lineHeight',
  // 旧字段，保留兼容：y 是位置，bold 是「粗细」的布尔写法
  'y',
  'bold',
];

/** reference.mjs 的骨架标记：不是样式，但和样式一起存在 clip.style 里。 */
const TEXT_INTERNAL_FIELDS = ['skeleton', 'skeletonOf', 'shotIndex'];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const LEGACY_COLOR = /^#[0-9a-fA-F]{3,8}$/;

export function isValidHexColor(v) {
  return typeof v === 'string' && HEX_COLOR.test(v);
}

function assertHexColor(name, v) {
  if (!isValidHexColor(v)) {
    throw new DomainError('INVALID_ARG', `${name} 必须是 #rrggbb 六位十六进制颜色，收到 ${JSON.stringify(v)}`);
  }
  return v;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/** 描边归一化：null = 不描边；字符串视为旧版描边色（宽度给 2）。 */
export function normalizeStroke(stroke) {
  if (stroke == null) return null;
  if (typeof stroke === 'string') {
    return LEGACY_COLOR.test(stroke) ? { color: stroke, width: 2 } : null;
  }
  if (typeof stroke !== 'object' || Array.isArray(stroke)) return null;
  return {
    color: isValidHexColor(stroke.color) ? stroke.color : '#000000',
    width: Math.round(clamp(FINITE(stroke.width) ? stroke.width : 2, 0, 20) * 100) / 100,
  };
}

/** 阴影归一化：null = 无阴影，其余夹到合法范围。 */
export function normalizeShadow(shadow) {
  if (shadow == null || typeof shadow !== 'object' || Array.isArray(shadow)) return null;
  return {
    color: isValidHexColor(shadow.color) ? shadow.color : '#000000',
    blur: Math.round(clamp(FINITE(shadow.blur) ? shadow.blur : 0, 0, 50) * 100) / 100,
    x: Math.round(clamp(FINITE(shadow.x) ? shadow.x : 0, -50, 50) * 100) / 100,
    y: Math.round(clamp(FINITE(shadow.y) ? shadow.y : 0, -50, 50) * 100) / 100,
  };
}

/**
 * 读数用的归一化：把任意（包括旧工程里的）style 折成渲染器可以直接吃的形状。
 * 它永不抛错 —— 渲染到一半因为一个坏字段黑屏，比一个字段不生效更糟。
 */
export function normalizeTextStyle(style) {
  const s = style && typeof style === 'object' && !Array.isArray(style) ? style : {};
  const rawSize = FINITE(s.fontSize) ? s.fontSize : FINITE(s.size) ? s.size : 32;
  let weight = TEXT_FONT_WEIGHTS.includes(s.fontWeight) ? s.fontWeight : null;
  if (weight == null) weight = s.bold ? 700 : 400;
  const rawLine = FINITE(s.lineHeight) ? s.lineHeight : 1.2;
  return {
    fontFamily: TEXT_FONT_FAMILIES.includes(s.fontFamily) ? s.fontFamily : 'system-ui',
    fontSize: Math.round(clamp(rawSize, TEXT_SIZE_MIN, TEXT_SIZE_MAX)),
    fontWeight: weight,
    color: isValidHexColor(s.color) ? s.color : '#ffffff',
    stroke: normalizeStroke(s.stroke),
    shadow: normalizeShadow(s.shadow),
    align: TEXT_ALIGNS.includes(s.align) ? s.align : 'center',
    lineHeight: Math.round(clamp(rawLine, TEXT_LINE_HEIGHT_MIN, TEXT_LINE_HEIGHT_MAX) * 100) / 100,
    y: Math.round(clamp(FINITE(s.y) ? s.y : 0.82, 0, 1) * 100) / 100,
  };
}

function validateStrokeValue(v) {
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new DomainError('INVALID_ARG', 'stroke 必须是 {color, width} 或 null');
  }
  for (const k of Object.keys(v)) {
    if (k !== 'color' && k !== 'width') {
      throw new DomainError('INVALID_ARG', `描边只支持 {color, width}，不认识字段 ${k}`);
    }
  }
  const color = v.color === undefined ? '#000000' : assertHexColor('描边颜色', v.color);
  const width = v.width === undefined ? 2 : v.width;
  if (!FINITE(width) || width < 0 || width > 20) {
    throw new DomainError('INVALID_ARG', '描边宽度必须在 0..20 之间，收到 ' + JSON.stringify(width));
  }
  return { color, width: Math.round(width * 100) / 100 };
}

function validateShadowValue(v) {
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new DomainError('INVALID_ARG', 'shadow 必须是 {color, blur, x, y} 或 null');
  }
  for (const k of Object.keys(v)) {
    if (!['color', 'blur', 'x', 'y'].includes(k)) {
      throw new DomainError('INVALID_ARG', `阴影只支持 {color, blur, x, y}，不认识字段 ${k}`);
    }
  }
  const color = v.color === undefined ? '#000000' : assertHexColor('阴影颜色', v.color);
  const blur = v.blur === undefined ? 8 : v.blur;
  const x = v.x === undefined ? 0 : v.x;
  const y = v.y === undefined ? 0 : v.y;
  if (!FINITE(blur) || blur < 0 || blur > 50) {
    throw new DomainError('INVALID_ARG', '阴影模糊半径必须在 0..50 之间，收到 ' + JSON.stringify(blur));
  }
  for (const [name, n] of [['x', x], ['y', y]]) {
    if (!FINITE(n) || n < -50 || n > 50) {
      throw new DomainError('INVALID_ARG', `阴影偏移 ${name} 必须在 -50..50 之间，收到 ${JSON.stringify(n)}`);
    }
  }
  return {
    color,
    blur: Math.round(blur * 100) / 100,
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
  };
}

/**
 * 把一次样式补丁合并进 base：白名单外 / 越界一律抛 INVALID_ARG（中文原因）。
 * 只返回新对象，不改 base。
 */
export function mergeTextStyle(base, patch) {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new DomainError('INVALID_ARG', 'style 必须是一个对象（字段见 TEXT_STYLE_FIELDS）');
  }
  const next = Object.assign({}, base || {});
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case 'fontFamily':
        if (!TEXT_FONT_FAMILIES.includes(v)) {
          throw new DomainError(
            'INVALID_ARG',
            `fontFamily 只支持 ${TEXT_FONT_FAMILIES.join(' / ')}，收到 ${JSON.stringify(v)}`,
          );
        }
        next.fontFamily = v;
        break;
      case 'fontSize':
        if (!FINITE(v) || v < TEXT_SIZE_MIN || v > TEXT_SIZE_MAX) {
          throw new DomainError(
            'INVALID_ARG',
            `fontSize 必须在 ${TEXT_SIZE_MIN}..${TEXT_SIZE_MAX} 之间，收到 ${JSON.stringify(v)}`,
          );
        }
        next.fontSize = Math.round(v);
        break;
      case 'fontWeight':
        if (!TEXT_FONT_WEIGHTS.includes(v)) {
          throw new DomainError('INVALID_ARG', `fontWeight 只支持 400 / 600 / 700 / 900，收到 ${JSON.stringify(v)}`);
        }
        next.fontWeight = v;
        delete next.bold;
        break;
      case 'bold':
        next.bold = !!v;
        break;
      case 'color':
        next.color = assertHexColor('color', v);
        break;
      case 'stroke':
        if (v === null) delete next.stroke;
        else next.stroke = validateStrokeValue(v);
        break;
      case 'shadow':
        if (v === null) delete next.shadow;
        else next.shadow = validateShadowValue(v);
        break;
      case 'align':
        if (!TEXT_ALIGNS.includes(v)) {
          throw new DomainError('INVALID_ARG', `align 只支持 left / center / right，收到 ${JSON.stringify(v)}`);
        }
        next.align = v;
        break;
      case 'lineHeight':
        if (!FINITE(v) || v < TEXT_LINE_HEIGHT_MIN || v > TEXT_LINE_HEIGHT_MAX) {
          throw new DomainError(
            'INVALID_ARG',
            `lineHeight 必须在 ${TEXT_LINE_HEIGHT_MIN}..${TEXT_LINE_HEIGHT_MAX} 之间，收到 ${JSON.stringify(v)}`,
          );
        }
        next.lineHeight = Math.round(v * 100) / 100;
        break;
      case 'y':
        if (!FINITE(v) || v < 0 || v > 1) {
          throw new DomainError('INVALID_ARG', 'y 必须在 0..1 之间，收到 ' + JSON.stringify(v));
        }
        next.y = round(v);
        break;
      default:
        throw new DomainError(
          'INVALID_ARG',
          `不支持的文字样式字段: ${k}（可用：${TEXT_STYLE_FIELDS.join(', ')}）`,
        );
    }
  }
  return next;
}

/** clip.insert 时校验样式：骨架标记放行，其余字段必须过白名单。 */
function assertTextStyleShape(style) {
  if (style == null) return {};
  if (typeof style !== 'object' || Array.isArray(style)) {
    throw new DomainError('INVALID_ARG', 'style 必须是一个对象');
  }
  const patch = {};
  const internal = {};
  for (const [k, v] of Object.entries(style)) {
    if (TEXT_INTERNAL_FIELDS.includes(k)) {
      internal[k] = v;
      continue;
    }
    if (!TEXT_STYLE_FIELDS.includes(k)) {
      throw new DomainError(
        'INVALID_ARG',
        `不支持的文字样式字段: ${k}（可用：${TEXT_STYLE_FIELDS.join(', ')}）`,
      );
    }
    patch[k] = v;
  }
  return Object.assign(mergeTextStyle({}, patch), internal);
}

export function createProject({ title = '未命名工程', sessionId, root, ratio = '16:9', fps = 30 } = {}) {
  if (!sessionId) throw new DomainError('INVALID_ARG', '缺少绑定会话 sessionId');
  if (!root) throw new DomainError('INVALID_ARG', '缺少工程目录 root');
  return {
    format: 'dsh-video/v1',
    revision: 0,
    projectId: 'vp_' + Math.random().toString(36).slice(2, 10),
    title,
    boundSessionId: sessionId,
    root,
    ratio,
    fps,
    duration: 0,
    render: { tier: null, exportProfile: 'speed' },
    tracks: [
      { id: 'v1', kind: 'video', name: '主轨', clips: [], muted: false, locked: false },
      { id: 'v2', kind: 'video', name: '画中画', clips: [], muted: false, locked: false },
      { id: 'c1', kind: 'code', name: '代码图层', clips: [], muted: false, locked: false },
      { id: 'a1', kind: 'audio', name: '音频', clips: [], muted: false, locked: false },
      { id: 't1', kind: 'text', name: '字幕', clips: [], muted: false, locked: false },
    ],
    clips: [],
    assets: [],
    annotations: [],
    exports: [],
  };
}

// --------------------------------------------------------------- helpers ----

function track(doc, trackId) {
  const t = doc.tracks.find((x) => x.id === trackId);
  if (!t) throw new DomainError('REF_NOT_FOUND', `轨道不存在: ${trackId}`);
  return t;
}

function clip(doc, clipId) {
  const c = doc.clips.find((x) => x.id === clipId);
  if (!c) throw new DomainError('REF_NOT_FOUND', `片段不存在: ${clipId}`);
  return c;
}

/** 片段所在轨道是不是音频轨（只有它们才认 volume / fade / muted）。 */
export function isAudioClip(doc, c) {
  if (!doc || !c) return false;
  const t = doc.tracks.find((x) => x.id === c.trackId);
  return !!(t && t.kind === 'audio');
}

function assertAudioClip(doc, c, opName) {
  const t = doc.tracks.find((x) => x.id === c.trackId);
  if (!t) throw new DomainError('REF_NOT_FOUND', `轨道不存在: ${c.trackId}`);
  if (t.kind !== 'audio') {
    throw new DomainError(
      'INVALID_OP',
      `${opName} 只能用于音频轨上的片段：${c.id} 在轨道 ${t.id}（类型 ${t.kind}），音量/淡入淡出/静音对它没有意义`,
      { clipId: c.id, trackId: t.id, trackKind: t.kind },
    );
  }
  return t;
}

/**
 * 校验并归一化一组音频属性，返回只包含显式给出的字段的补丁（值已 round）。
 * 不给的字段不出现，调用方据此判断「有没有改动」。
 *
 * 严格在这里：volume 越界直接报错，不夹紧 —— 调用方写 3 是意图不明，
 * 静默变成 2 会让「为什么还是太响」变得无解。
 */
export function normalizeAudioPatch(op, duration, opName = 'clip.setAudio') {
  const patch = {};
  if (!op || typeof op !== 'object') {
    throw new DomainError('INVALID_ARG', `${opName} 需要 volume / muted / fadeIn / fadeOut 至少一个字段`);
  }

  if (op.volume !== undefined && op.volume !== null) {
    if (typeof op.volume !== 'number' || !FINITE(op.volume)) {
      throw new DomainError('INVALID_ARG', `volume 必须是数字（0..${AUDIO_VOLUME_MAX}），收到 ${JSON.stringify(op.volume)}`);
    }
    if (op.volume < AUDIO_VOLUME_MIN || op.volume > AUDIO_VOLUME_MAX) {
      throw new DomainError(
        'INVALID_ARG',
        `volume 必须在 ${AUDIO_VOLUME_MIN}..${AUDIO_VOLUME_MAX} 之间，收到 ${op.volume}（不自动夹紧：请自己决定要用多少）`,
      );
    }
    patch.volume = round(op.volume);
  }

  if (op.muted !== undefined && op.muted !== null) {
    if (typeof op.muted !== 'boolean') {
      throw new DomainError('INVALID_ARG', `muted 必须是布尔值，收到 ${JSON.stringify(op.muted)}`);
    }
    patch.muted = op.muted;
  }

  for (const key of ['fadeIn', 'fadeOut']) {
    if (op[key] === undefined || op[key] === null) continue;
    const v = op[key];
    if (typeof v !== 'number' || !FINITE(v)) {
      throw new DomainError('INVALID_ARG', `${key} 必须是数字（秒，≥0），收到 ${JSON.stringify(v)}`);
    }
    if (v < 0) throw new DomainError('INVALID_ARG', `${key} 不能为负，收到 ${v}`);
    patch[key] = round(v);
  }

  const fadeIn = patch.fadeIn !== undefined ? patch.fadeIn : 0;
  const fadeOut = patch.fadeOut !== undefined ? patch.fadeOut : 0;
  if (fadeIn + fadeOut > duration + 1e-9) {
    throw new DomainError(
      'INVALID_OP',
      `淡入 + 淡出（${round(fadeIn + fadeOut)}s）不能超过片段时长（${round(duration)}s）`,
      { fadeIn, fadeOut, duration },
    );
  }

  return patch;
}

/** 音频片段的实际属性：缺字段时按默认值解释，显式 null 也按默认值。 */
export function audioPropsOf(c) {
  const c2 = c && typeof c === 'object' ? c : {};
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    volume: Math.min(AUDIO_VOLUME_MAX, Math.max(AUDIO_VOLUME_MIN, num(c2.volume, AUDIO_DEFAULTS.volume))),
    fadeIn: Math.max(0, num(c2.fadeIn, AUDIO_DEFAULTS.fadeIn)),
    fadeOut: Math.max(0, num(c2.fadeOut, AUDIO_DEFAULTS.fadeOut)),
    muted: c2.muted === true,
  };
}

/**
 * 音频片段在插入时的音频属性：音频轨默认写 volume=1，其余字段只在显式给出时写。
 * 视频轨一律忽略（不报错）—— 这是「模型层宽容、命令层严格」的分界。
 */
function audioFieldsForInsert(doc, trackObj, op, duration) {
  if (!trackObj || trackObj.kind !== 'audio') return {};
  const patch = normalizeAudioPatch(op, duration, 'clip.insert');
  const out = { volume: patch.volume !== undefined ? patch.volume : AUDIO_DEFAULTS.volume };
  if (patch.muted !== undefined) out.muted = patch.muted;
  if (patch.fadeIn !== undefined && patch.fadeIn > 0) out.fadeIn = patch.fadeIn;
  if (patch.fadeOut !== undefined && patch.fadeOut > 0) out.fadeOut = patch.fadeOut;
  return out;
}

/** 片段被裁短后重新收敛淡入淡出：超过新时长的部分按比例压到放得下。 */
function clampClipFades(c) {
  if (!(c.duration > 0)) return;
  const fadeIn = typeof c.fadeIn === 'number' && Number.isFinite(c.fadeIn) ? Math.max(0, c.fadeIn) : 0;
  const fadeOut = typeof c.fadeOut === 'number' && Number.isFinite(c.fadeOut) ? Math.max(0, c.fadeOut) : 0;
  if (fadeIn === 0 && fadeOut === 0) return;
  if (fadeIn + fadeOut <= c.duration) return;
  const k = c.duration / (fadeIn + fadeOut);
  c.fadeIn = round(fadeIn * k);
  c.fadeOut = round(fadeOut * k);
}

function ensureClipIdFree(doc, clipId) {
  if (!clipId || typeof clipId !== 'string') throw new DomainError('INVALID_ARG', 'clipId 必须是非空字符串');
  if (doc.clips.some((c) => c.id === clipId)) throw new DomainError('INVALID_ARG', `片段 id 已存在: ${clipId}`);
}

function recomputeDuration(doc) {
  let end = 0;
  for (const c of doc.clips) end = Math.max(end, c.start + c.duration);
  doc.duration = round(end);
}

/** Same-track overlap check, half-open [start, start+duration). */
function assertNoOverlap(doc) {
  for (const t of doc.tracks) {
    const items = doc.clips
      .filter((c) => c.trackId === t.id)
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < items.length; i += 1) {
      const prev = items[i - 1];
      const cur = items[i];
      if (cur.start < prev.start + prev.duration - 1e-6) {
        throw new DomainError('INVALID_OP', `轨道 ${t.id} 上片段重叠: ${prev.id} / ${cur.id}`, {
          trackId: t.id,
          a: prev.id,
          b: cur.id,
        });
      }
    }
  }
}

function assertClipShape(doc, c) {
  if (!FINITE(c.start) || c.start < 0) throw new DomainError('INVALID_OP', `片段 start 非法: ${c.id}`);
  if (!FINITE(c.duration) || c.duration <= 0) throw new DomainError('INVALID_OP', `片段 duration 非法: ${c.id}`);
  if (c.type === 'media' && !doc.assets.some((a) => a.id === c.assetId)) {
    throw new DomainError('REF_NOT_FOUND', `素材不存在: ${c.assetId}`);
  }
}

// ------------------------------------------------------------- transitions ---

/** 合成器支持的转场类型。改这里之前先确认 player.js 的 mixTransition 认识它。 */
export const TRANSITION_TYPES = ['crossfade', 'push', 'wipe'];
export const TRANSITION_MIN = 0.1;
export const TRANSITION_MAX = 2;

/** 同轨按 start 排序（时间线顺序），用于找相邻片段。 */
function sameTrackOrder(doc, c) {
  return doc.clips
    .filter((x) => x.trackId === c.trackId)
    .sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));
}

/**
 * 转场只能和「同轨、首尾相接」的邻居发生。
 * 返回 { prev, next }：只有真正贴住的邻居才算，中间有缝就不算。
 */
export function adjacentClips(doc, c) {
  const list = sameTrackOrder(doc, c);
  const i = list.findIndex((x) => x.id === c.id);
  if (i < 0) return { prev: null, next: null };
  const prev = i > 0 ? list[i - 1] : null;
  const next = i < list.length - 1 ? list[i + 1] : null;
  const touchingPrev = prev && Math.abs(prev.start + prev.duration - c.start) < 1e-3 ? prev : null;
  const touchingNext = next && Math.abs(c.start + c.duration - next.start) < 1e-3 ? next : null;
  return { prev: touchingPrev, next: touchingNext };
}

/** 转场时长的上限：自身与相邻片段各自的一半，再夹到 2 秒。 */
function transitionLimit(doc, c, side) {
  const { prev, next } = adjacentClips(doc, c);
  let limit = Math.min(TRANSITION_MAX, c.duration / 2);
  if (side === 'in' && prev) limit = Math.min(limit, prev.duration / 2);
  if (side === 'out' && next) limit = Math.min(limit, next.duration / 2);
  return limit;
}

// ------------------------------------------------------------------ speed ---

/** 片段的瞬时速度：有 speedKeyframes 时按线性插值，否则回落到 clip.speed。 */
export function speedAt(clip, u) {
  const keys = Array.isArray(clip && clip.speedKeyframes) ? clip.speedKeyframes : null;
  if (!keys || keys.length === 0) return FINITE(clip && clip.speed) ? clip.speed : 1;
  if (keys.length === 1) return keys[0].speed;
  const x = Math.max(0, Math.min(1, u));
  if (x <= keys[0].t) return keys[0].speed;
  const last = keys[keys.length - 1];
  if (x >= last.t) return last.speed;
  for (let i = 1; i < keys.length; i += 1) {
    const a = keys[i - 1];
    const b = keys[i];
    if (x <= b.t) {
      const span = b.t - a.t;
      if (span <= 0) return b.speed;
      return a.speed + (b.speed - a.speed) * ((x - a.t) / span);
    }
  }
  return last.speed;
}

/** 平均速度 = 速度曲线在归一化时间 [0,1] 上的梯形积分。 */
export function averageSpeedOf(clip) {
  const keys = Array.isArray(clip && clip.speedKeyframes) ? clip.speedKeyframes : null;
  if (!keys || keys.length === 0) return FINITE(clip && clip.speed) ? clip.speed : 1;
  let area = 0;
  let prevU = 0;
  let prevS = keys[0].speed;
  for (const k of keys) {
    area += ((prevS + k.speed) / 2) * Math.max(0, k.t - prevU);
    prevU = k.t;
    prevS = k.speed;
  }
  area += prevS * Math.max(0, 1 - prevU);
  return area;
}

/** 速度曲线从 0 积到 u 的定积分（供源时间映射用）。 */
export function integrateSpeed(clip, u) {
  const x = Math.max(0, Math.min(1, u));
  const keys = Array.isArray(clip && clip.speedKeyframes) ? clip.speedKeyframes : null;
  if (!keys || keys.length === 0) return x * (FINITE(clip && clip.speed) ? clip.speed : 1);
  let area = 0;
  let prevU = 0;
  let prevS = keys[0].speed;
  for (const k of keys) {
    if (k.t >= x) {
      area += ((prevS + speedAt(clip, x)) / 2) * Math.max(0, x - prevU);
      return area;
    }
    area += ((prevS + k.speed) / 2) * Math.max(0, k.t - prevU);
    prevU = k.t;
    prevS = k.speed;
  }
  area += prevS * Math.max(0, x - prevU);
  return area;
}

/**
 * 时间线局部时间 → 源时间偏移（不含 sourceIn）。
 * 恒速时就是 localT * speed；关键帧时按曲线积分。
 * 允许 localT 越出 [0, duration]：转场要画相邻片段的「延长帧」。
 */
export function sourceOffsetOf(clip, localT) {
  const dur = Math.max(1e-6, clip.duration);
  const u = localT / dur;
  if (u < 0) return localT * speedAt(clip, 0);
  if (u > 1) {
    const total = dur * averageSpeedOf(clip);
    return total + (localT - dur) * speedAt(clip, 1);
  }
  return dur * integrateSpeed(clip, u);
}

// ------------------------------------------------------------- operations ---

const OPS = {
  'track.add'(doc, op) {
    if (!op.kind) throw new DomainError('INVALID_ARG', 'track.add 需要 kind');
    const id = op.trackId || 'tr_' + Math.random().toString(36).slice(2, 7);
    if (doc.tracks.some((t) => t.id === id)) throw new DomainError('INVALID_ARG', `轨道 id 已存在: ${id}`);
    doc.tracks.push({ id, kind: op.kind, name: op.name || op.kind, clips: [], muted: false, locked: false });
    return { kind: 'track', id };
  },

  'clip.insert'(doc, op) {
    ensureClipIdFree(doc, op.clipId);
    const t = track(doc, op.trackId);
    if (t.locked) throw new DomainError('INVALID_OP', `轨道已锁定: ${t.id}`);
    const clipType = op.clipType;
    if (!clipType) throw new DomainError('INVALID_ARG', 'clip.insert 需要 clipType（media|text|code）');
    const c = {
      id: op.clipId,
      trackId: t.id,
      type: clipType,
      start: round(op.start ?? 0),
      duration: round(op.duration ?? 1),
    };
    if (clipType === 'media') {
      c.assetId = op.assetId;
      c.sourceIn = round(op.sourceIn ?? 0);
      c.speed = op.speed ?? 1;
      c.transform = Object.assign({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, op.transform || {});
      c.effects = op.effects || [];
      if (op.transitionOut) c.transitionOut = op.transitionOut;
    } else if (clipType === 'code') {
      c.layerId = op.layerId || op.clipId;
      c.codeHash = op.codeHash || null;
      c.props = op.props || {};
      c.contentDuration = op.contentDuration ?? op.duration;
    } else if (clipType === 'text') {
      c.text = op.text || '';
      c.style = assertTextStyleShape(op.style);
    }
    if (op.provenance && typeof op.provenance === 'object') {
      c.provenance = {
        libraryId: op.provenance.libraryId || null,
        assetId: op.provenance.assetId || null,
        hash: op.provenance.hash || null,
        license: op.provenance.license || null,
        attribution: op.provenance.attribution || null,
        source: op.provenance.source || null,
        provider: op.provenance.provider || null,
      };
    }
    // 音频轨：写入音量/淡入淡出/静音，并补上默认 volume=1。
    // 视频轨上这些字段被忽略（不报错）—— 模型层宽容，写入命令层才严格。
    Object.assign(c, audioFieldsForInsert(doc, t, op, c.duration));
    assertClipShape(doc, c);
    doc.clips.push(c);
    t.clips.push(c.id);
    return { kind: 'clip', id: c.id };
  },

  'clip.move'(doc, op) {
    const c = clip(doc, op.clipId);
    if (track(doc, c.trackId).locked) throw new DomainError('INVALID_OP', '轨道已锁定: ' + c.trackId);
    if (op.trackId && op.trackId !== c.trackId) {
      const from = track(doc, c.trackId);
      const to = track(doc, op.trackId);
      if (to.locked) throw new DomainError('INVALID_OP', `轨道已锁定: ${to.id}`);
      from.clips = from.clips.filter((x) => x !== c.id);
      to.clips.push(c.id);
      c.trackId = to.id;
    }
    if (op.start != null) c.start = round(op.start);
    assertClipShape(doc, c);
    return { kind: 'clip', id: c.id };
  },

  'clip.trim'(doc, op) {
    const c = clip(doc, op.clipId);
    if (track(doc, c.trackId).locked) throw new DomainError('INVALID_OP', '轨道已锁定: ' + c.trackId);
    if (op.start != null) c.start = round(op.start);
    if (op.duration != null) c.duration = round(op.duration);
    if (op.sourceIn != null && c.type === 'media') c.sourceIn = round(op.sourceIn);
    clampClipFades(c); // 裁短后淡入淡出必须仍然放得下
    assertClipShape(doc, c);
    return { kind: 'clip', id: c.id };
  },

  /**
   * 片段音量（只有音频轨上的片段）。
   *
   * { type:'clip.setAudio', clipId, volume?, muted?, fadeIn?, fadeOut? }
   *
   * volume 0..2（越界拒绝，不夹紧）；fadeIn/fadeOut ≥0 且之和 ≤ 片段时长。
   * 至少给一个字段；diff 由 applyOps 统一生成（旧值 → 新值）。
   */
  'clip.setAudio'(doc, op) {
    const c = clip(doc, op.clipId);
    assertAudioClip(doc, c, 'clip.setAudio');
    if (track(doc, c.trackId).locked) throw new DomainError('INVALID_OP', '轨道已锁定: ' + c.trackId);
    const patch = normalizeAudioPatch(op, c.duration, 'clip.setAudio');
    if (Object.keys(patch).length === 0) {
      throw new DomainError('INVALID_ARG', 'clip.setAudio 至少需要一个字段：volume / muted / fadeIn / fadeOut');
    }
    Object.assign(c, patch);
    return { kind: 'clip', id: c.id };
  },

  /**
   * clip.update：clip.setAudio 的兼容别名（用户按名字试过它，报「未知命令」很伤）。
   *
   * 只接受 {clipId, volume?, muted?, fadeIn?, fadeOut?}。出现任何其它字段（start / text /
   * style / opacity …）一律明确拒绝，不做半套映射 —— 免得调用方以为通用的「更新片段」被支持了。
   */
  'clip.update'(doc, op) {
    const allowed = new Set(['type', 'clipId', ...AUDIO_PROP_FIELDS]);
    const extra = Object.keys(op || {}).filter((k) => !allowed.has(k));
    if (extra.length) {
      throw new DomainError(
        'INVALID_ARG',
        `clip.update 只支持音视频片段的 volume/muted/fadeIn/fadeOut；不支持的字段: ${extra.join(', ')}`,
        { unsupported: extra, supported: [...AUDIO_PROP_FIELDS] },
      );
    }
    const c = clip(doc, op.clipId);
    assertAudioClip(doc, c, 'clip.update');
    if (track(doc, c.trackId).locked) throw new DomainError('INVALID_OP', '轨道已锁定: ' + c.trackId);
    const patch = normalizeAudioPatch(op, c.duration, 'clip.update');
    if (Object.keys(patch).length === 0) {
      throw new DomainError('INVALID_ARG', 'clip.update 至少需要一个字段：volume / muted / fadeIn / fadeOut');
    }
    Object.assign(c, patch);
    return { kind: 'clip', id: c.id };
  },

  'clip.split'(doc, op) {
    const c = clip(doc, op.clipId);
    const at = op.at; // seconds from clip start
    if (!FINITE(at) || at <= 0 || at >= c.duration) {
      throw new DomainError('INVALID_OP', `split 位置越界: ${at}`, { duration: c.duration });
    }
    const rightId = op.rightClipId || c.id + '_b';
    ensureClipIdFree(doc, rightId);
    const right = JSON.parse(JSON.stringify(c));
    right.id = rightId;
    right.start = round(c.start + at);
    right.duration = round(c.duration - at);
    if (c.type === 'media') right.sourceIn = round((c.sourceIn || 0) + at * (c.speed || 1));
    c.duration = round(at);
    // 切开后两半都不该保留「跨切点」的淡入淡出：左半的淡出、右半的淡入都归零，
    // 否则切点会凭空多出一次音量骤降。剩下的那一段按新时长收敛。
    if (isAudioClip(doc, c)) {
      c.fadeOut = 0;
      right.fadeIn = 0;
      clampClipFades(c);
      clampClipFades(right);
    }
    doc.clips.push(right);
    const t = track(doc, c.trackId);
    t.clips.push(rightId);
    return [{ kind: 'clip', id: c.id }, { kind: 'clip', id: rightId }];
  },

  'clip.delete'(doc, op) {
    const c = clip(doc, op.clipId);
    if (track(doc, c.trackId).locked) throw new DomainError('INVALID_OP', '轨道已锁定: ' + c.trackId);
    doc.clips = doc.clips.filter((x) => x.id !== c.id);
    const t = track(doc, c.trackId);
    t.clips = t.clips.filter((x) => x !== c.id);
    doc.annotations.forEach((a) => {
      if (a.target && a.target.clipId === c.id) a.outdated = true;
    });
    return { kind: 'clip', id: c.id };
  },

  'clip.set_keyframe'(doc, op) {
    const c = clip(doc, op.clipId);
    const allowed = new Set(['x', 'y', 'scale', 'rotation', 'opacity']);
    if (!allowed.has(op.property)) throw new DomainError('INVALID_ARG', '不支持的属性: ' + op.property);
    if (!FINITE(op.t) || op.t < 0 || op.t > c.duration) {
      throw new DomainError('INVALID_OP', '关键帧时间必须在 0..片段时长 之间');
    }
    if (!FINITE(op.value)) throw new DomainError('INVALID_ARG', '关键帧值必须是数字');
    const list = Array.isArray(c.keyframes) ? c.keyframes.slice() : [];
    const at = list.findIndex((k) => k.property === op.property && Math.abs(k.t - op.t) < 0.001);
    const eases = new Set(['linear', 'easeIn', 'easeOut', 'easeInOut']);
    if (op.ease !== undefined && !eases.has(op.ease)) {
      throw new DomainError('INVALID_ARG', '不支持的缓动: ' + op.ease);
    }
    const entry = { property: op.property, t: round(op.t), value: round(op.value) };
    if (op.ease) entry.ease = op.ease;
    // 贝塞尔优先于 kind：播放器先看 bezier，再看 ease。
    if (op.bezier !== undefined && op.bezier !== null) entry.bezier = assertBezier(op.bezier);
    if (at >= 0) list[at] = entry;
    else list.push(entry);
    list.sort((a, b) => (a.property < b.property ? -1 : a.property > b.property ? 1 : a.t - b.t));
    c.keyframes = list;
    return { kind: 'clip', id: c.id };
  },

  'clip.remove_keyframe'(doc, op) {
    const c = clip(doc, op.clipId);
    const list = (c.keyframes || []).filter(
      (k) => !(k.property === op.property && (op.t == null || Math.abs(k.t - op.t) < 0.001)),
    );
    c.keyframes = list;
    return { kind: 'clip', id: c.id };
  },

  'track.set_muted'(doc, op) {
    const t = track(doc, op.trackId);
    t.muted = !!op.muted;
    return { kind: 'track', id: t.id };
  },

  'track.set_locked'(doc, op) {
    const t = track(doc, op.trackId);
    t.locked = !!op.locked;
    return { kind: 'track', id: t.id };
  },

  'clip.set_mask'(doc, op) {
    const c = clip(doc, op.clipId);
    if (c.type !== 'media' && c.type !== 'code') {
      throw new DomainError('INVALID_OP', '只有视觉片段有蒙版');
    }
    const m = op.mask;
    if (m == null || m.shape === 'none') {
      delete c.mask;
      return { kind: 'clip', id: c.id };
    }
    if (!['rect', 'circle'].includes(m.shape)) {
      throw new DomainError('INVALID_ARG', '蒙版形状只支持 rect / circle');
    }
    for (const k of ['x', 'y', 'w', 'h']) {
      if (!FINITE(m[k]) || m[k] < 0 || m[k] > 1) {
        throw new DomainError('INVALID_ARG', '蒙版 ' + k + ' 必须在 0..1');
      }
    }
    if (m.w === 0 || m.h === 0) throw new DomainError('INVALID_ARG', '蒙版宽高不能为 0');
    c.mask = { shape: m.shape, x: round(m.x), y: round(m.y), w: round(m.w), h: round(m.h) };
    return { kind: 'clip', id: c.id };
  },

  'clip.set_text'(doc, op) {
    const c = clip(doc, op.clipId);
    if (c.type !== 'text') throw new DomainError('INVALID_OP', '只有文字片段有文字内容');
    if (typeof op.text !== 'string') throw new DomainError('INVALID_ARG', 'text 必须是字符串');
    if (op.text.length > 2000) throw new DomainError('INVALID_ARG', '文字过长（>2000）');
    c.text = op.text;
    return { kind: 'clip', id: c.id };
  },

  'clip.set_text_style'(doc, op) {
    const c = clip(doc, op.clipId);
    if (c.type !== 'text') throw new DomainError('INVALID_OP', '只有文字片段有文字样式');
    // 与 clip.set_property {property:'style'} 共用同一套白名单校验。
    c.style = mergeTextStyle(c.style || {}, op.style);
    return { kind: 'clip', id: c.id };
  },

  'clip.set_effect'(doc, op) {
    const c = clip(doc, op.clipId);
    const allowed = new Set(['brightness', 'contrast', 'saturate', 'blur', 'grayscale', 'temperature', 'tint', 'vignette']);
    if (!allowed.has(op.effect)) throw new DomainError('INVALID_ARG', '不支持的效果: ' + op.effect);
    const list = Array.isArray(c.effects) ? c.effects.filter((e) => e.type !== op.effect) : [];
    if (op.value != null) {
      if (!FINITE(op.value)) throw new DomainError('INVALID_ARG', '效果值必须是数字');
      if ((op.effect === 'temperature' || op.effect === 'tint') && (op.value < -1 || op.value > 1)) {
        throw new DomainError('INVALID_ARG', op.effect + ' 必须在 -1..1');
      }
      if (op.effect === 'vignette' && (op.value < 0 || op.value > 1)) {
        throw new DomainError('INVALID_ARG', 'vignette 必须在 0..1');
      }
      list.push({ type: op.effect, value: round(op.value) });
    }
    c.effects = list;
    return { kind: 'clip', id: c.id };
  },

  'clip.set_transition'(doc, op) {
    const c = clip(doc, op.clipId);
    if (c.type !== 'media' && c.type !== 'text' && c.type !== 'code') {
      throw new DomainError('INVALID_OP', '该片段类型不支持转场: ' + c.type);
    }

    // 旧写法（淡入淡出秒数）：面板还在用，保留，不要把行为改掉
    if (op.transitionIn !== undefined || op.transitionOut !== undefined) {
      for (const key of ['transitionIn', 'transitionOut']) {
        const v = op[key];
        if (v === undefined) continue;
        if (v !== null && (!FINITE(v) || v < 0 || v > Math.min(3, c.duration))) {
          throw new DomainError('INVALID_OP', key + ' 必须在 0..min(3, 片段时长) 之间');
        }
        if (v === null) delete c[key];
        else c[key] = round(v);
      }
      return { kind: 'clip', id: c.id };
    }

    if (op.in === undefined && op.out === undefined) {
      throw new DomainError('INVALID_ARG', 'clip.set_transition 需要 in 或 out（{type, duration}，或 null 清除）');
    }

    const next = Object.assign({}, c.transition || {});
    for (const side of ['in', 'out']) {
      if (op[side] === undefined) continue;
      const raw = op[side];
      if (raw === null) {
        delete next[side];
        continue;
      }
      if (typeof raw !== 'object') {
        throw new DomainError('INVALID_ARG', `转场 ${side} 必须是 {type, duration} 或 null`);
      }
      const type = raw.type;
      if (!TRANSITION_TYPES.includes(type)) {
        throw new DomainError(
          'INVALID_OP',
          `不支持的转场类型: ${type}（只支持 ${TRANSITION_TYPES.join(' | ')}）`,
        );
      }
      if (!FINITE(raw.duration)) {
        throw new DomainError('INVALID_OP', `转场 ${side} 的 duration 必须是有限数字`);
      }
      if (raw.duration < TRANSITION_MIN || raw.duration > TRANSITION_MAX) {
        throw new DomainError(
          'INVALID_OP',
          `转场时长必须在 ${TRANSITION_MIN}..${TRANSITION_MAX} 秒之间，收到 ${raw.duration}`,
        );
      }
      const limit = transitionLimit(doc, c, side);
      if (limit < TRANSITION_MIN - 1e-9) {
        throw new DomainError(
          'INVALID_OP',
          `${side === 'in' ? '前一片段' : '后一片段'}太短，放不下最短的转场（需要至少 ${TRANSITION_MIN * 2} 秒）`,
        );
      }
      // 不超过相邻片段时长的一半：超了就压到上限，而不是拒绝
      const duration = round(Math.min(raw.duration, limit));
      next[side] = { type, duration };
    }
    c.transition = next;
    return { kind: 'clip', id: c.id };
  },

  'clip.set_speed'(doc, op) {
    const c = clip(doc, op.clipId);
    if (c.type !== 'media' && c.type !== 'code' && c.type !== 'text') {
      throw new DomainError('INVALID_OP', `该片段类型不支持变速: ${c.type}`);
    }
    if (track(doc, c.trackId).locked) throw new DomainError('INVALID_OP', '轨道已锁定: ' + c.trackId);

    const speed = op.speed;
    if (!FINITE(speed) || speed < 0.25 || speed > 4) {
      throw new DomainError('INVALID_OP', `速度必须在 0.25..4 之间，收到 ${speed}`);
    }

    let keys = null;
    if (op.keyframes !== undefined && op.keyframes !== null) {
      if (!Array.isArray(op.keyframes) || op.keyframes.length === 0) {
        throw new DomainError('INVALID_OP', 'keyframes 必须是非空数组（形如 [{t, speed}]）');
      }
      keys = op.keyframes
        .map((k, i) => {
          if (!k || typeof k !== 'object' || !FINITE(k.t) || !FINITE(k.speed)) {
            throw new DomainError('INVALID_OP', `第 ${i + 1} 个变速关键帧需要 {t, speed} 两个数字`);
          }
          if (k.t < 0 || k.t > 1) {
            throw new DomainError('INVALID_OP', `第 ${i + 1} 个变速关键帧的 t 必须在 0..1（片段内归一化时间）`);
          }
          if (k.speed < 0.25 || k.speed > 4) {
            throw new DomainError('INVALID_OP', `第 ${i + 1} 个变速关键帧的速度越界（0.25..4）：${k.speed}`);
          }
          return { t: round(k.t), speed: round(k.speed) };
        })
        .sort((a, b) => a.t - b.t);
      for (let i = 1; i < keys.length; i += 1) {
        if (Math.abs(keys[i].t - keys[i - 1].t) < 1e-6) {
          throw new DomainError('INVALID_OP', '变速关键帧的 t 不能重复');
        }
      }
    }

    // 源跨度：当前时长 × 当前平均速度（第一次变速时就是原始时长）
    const span = c.duration * averageSpeedOf(c);
    const avg = keys ? averageSpeedOf({ speed, speedKeyframes: keys }) : speed;
    if (!(avg > 0)) throw new DomainError('INVALID_OP', '平均速度必须大于 0');
    const duration = round(span / avg);
    if (!(duration > 0)) throw new DomainError('INVALID_OP', '变速后片段的时长为 0，拒绝');

    const oldEnd = c.start + c.duration;
    const delta = round(duration - c.duration);
    c.speed = round(speed);
    if (keys) c.speedKeyframes = keys;
    else delete c.speedKeyframes;
    c.duration = duration;
    c.sourceSpan = round(span);

    // 只移动同轨后续片段；其它轨不碰
    if (Math.abs(delta) > 1e-9) {
      for (const other of doc.clips) {
        if (other.id === c.id || other.trackId !== c.trackId) continue;
        if (other.start >= oldEnd - 1e-6) other.start = round(other.start + delta);
      }
    }
    return { kind: 'clip', id: c.id };
  },

  'clip.set_transform'(doc, op) {
    const c = clip(doc, op.clipId);
    if (c.type !== 'media' && c.type !== 'text' && c.type !== 'code') {
      throw new DomainError('INVALID_OP', `该片段类型无 transform: ${c.type}`);
    }
    c.transform = Object.assign({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, c.transform, op.transform);
    return { kind: 'clip', id: c.id };
  },

  'clip.set_property'(doc, op) {
    const c = clip(doc, op.clipId);
    const allow = new Set(['volume', 'fadeIn', 'fadeOut', 'muted', 'speed', 'audioRole', 'style']);
    if (!allow.has(op.property)) throw new DomainError('INVALID_ARG', `不支持的属性: ${op.property}`);
    // 文字样式走这里：value 是样式补丁对象，字段白名单见 TEXT_STYLE_FIELDS。
    if (op.property === 'style') {
      if (c.type !== 'text') throw new DomainError('INVALID_OP', '只有文字片段有文字样式');
      c.style = mergeTextStyle(c.style || {}, op.value);
      return { kind: 'clip', id: c.id };
    }
    // audioRole 是这里唯一的字符串属性：voice 触发 ducking，music 参与，sfx 不参与
    if (op.property === 'audioRole') {
      if (op.value === null || op.value === undefined || op.value === '') {
        delete c.audioRole; // 清空 = 回到未标注（按 sfx 处理）
        return { kind: 'clip', id: c.id };
      }
      if (!AUDIO_ROLES.has(op.value)) {
        throw new DomainError('INVALID_ARG', 'audioRole 只能是 voice / music / sfx');
      }
      c.audioRole = op.value;
      return { kind: 'clip', id: c.id };
    }
    // 音量 / 淡入淡出 / 静音：与 clip.setAudio 共用同一套校验，不许一条路严格一条路松。
    if (AUDIO_PROP_FIELDS.includes(op.property)) {
      assertAudioClip(doc, c, 'clip.set_property');
      const patch = normalizeAudioPatch({ [op.property]: op.value }, c.duration, 'clip.set_property');
      Object.assign(c, patch);
      return { kind: 'clip', id: c.id };
    }
    if (!FINITE(op.value)) throw new DomainError('INVALID_ARG', 'value 必须是有限数字');
    c[op.property] = op.value;
    return { kind: 'clip', id: c.id };
  },

  'code_layer.set_code'(doc, op) {
    const c = clip(doc, op.clipId);
    if (c.type !== 'code') throw new DomainError('INVALID_OP', '不是代码图层');
    if (op.codeHash) c.codeHash = op.codeHash;
    return { kind: 'clip', id: c.id };
  },

  'code_layer.set_props'(doc, op) {
    const c = clip(doc, op.clipId);
    if (c.type !== 'code') throw new DomainError('INVALID_OP', '不是代码图层');
    c.props = Object.assign({}, c.props, op.props || {});
    if (op.codeHash) c.codeHash = op.codeHash;
    return { kind: 'clip', id: c.id };
  },

  'project.set_ratio'(doc, op) {
    const allowed = new Set(['16:9', '9:16', '1:1', '4:5']);
    if (!allowed.has(op.ratio)) throw new DomainError('INVALID_ARG', `不支持的画幅: ${op.ratio}`);
    doc.ratio = op.ratio;
    return { kind: 'project', id: doc.projectId };
  },

  'asset.add'(doc, op) {
    if (!op.assetId) throw new DomainError('INVALID_ARG', 'asset.add 需要 assetId');
    if (doc.assets.some((a) => a.id === op.assetId)) {
      throw new DomainError('INVALID_ARG', '素材 id 已存在: ' + op.assetId);
    }
    const a = {
      id: op.assetId,
      path: op.relPath || op.path,
      name: op.name || op.relPath || op.path,
      size: op.size || 0,
      hash: op.hash || null,
      mime: op.mime || 'application/octet-stream',
      probe: op.probe || null,
      analysis: null,
    };
    doc.assets.push(a);
    return { kind: 'asset', id: a.id };
  },

  'asset.setProbe'(doc, op) {
    const a = doc.assets.find((x) => x.id === op.assetId);
    if (!a) throw new DomainError('REF_NOT_FOUND', '素材不存在: ' + op.assetId);
    a.probe = Object.assign({}, a.probe, op.probe || {});
    return { kind: 'asset', id: a.id };
  },

  /**
   * 预览解码走备份副本：值必须是 reference/ 下的相对路径，或 null 清空。
   *
   * 原片不动：它仍在 assets/、仍是时间线上的编辑对象；这里只告诉预览「去读哪一份」，
   * 所以撤销这一步不丢任何字节（复制字节在事务外，由 reference.apply 负责）。
   */
  'asset.setPreviewPath'(doc, op) {
    const a = doc.assets.find((x) => x.id === op.assetId);
    if (!a) throw new DomainError('REF_NOT_FOUND', '素材不存在: ' + op.assetId);
    const raw = op.previewPath == null || op.previewPath === '' ? null : String(op.previewPath);
    if (raw !== null && !/^reference\/[A-Za-z0-9._-]+$/.test(raw)) {
      throw new DomainError('INVALID_ARG', 'previewPath 必须指向 reference/ 下的文件：' + raw);
    }
    if (raw === null) delete a.previewPath;
    else a.previewPath = raw;
    return { kind: 'asset', id: a.id };
  },

  /**
   * 素材状态：null/'' 是普通素材，'reference' 是「已降级、只读参考」。
   */

  'asset.setStatus'(doc, op) {
    const a = doc.assets.find((x) => x.id === op.assetId);
    if (!a) throw new DomainError('REF_NOT_FOUND', '素材不存在: ' + op.assetId);
    const raw = op.status;
    if (raw == null || raw === '') {
      delete a.status;
      return { kind: 'asset', id: a.id };
    }
    if (typeof raw !== 'string') throw new DomainError('INVALID_ARG', 'status 必须是字符串或 null');
    const status = raw.trim();
    if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(status)) {
      throw new DomainError('INVALID_ARG', 'status 只接受字母开头的短标识: ' + raw);
    }
    a.status = status;
    return { kind: 'asset', id: a.id };
  },

  'asset.remove'(doc, op) {
    const a = doc.assets.find((x) => x.id === op.assetId);
    if (!a) throw new DomainError('REF_NOT_FOUND', '素材不存在: ' + op.assetId);
    if (doc.clips.some((c) => c.assetId === a.id)) {
      throw new DomainError('INVALID_OP', '素材仍被片段引用，先删除片段', { assetId: a.id });
    }
    doc.assets = doc.assets.filter((x) => x.id !== a.id);
    return { kind: 'asset', id: a.id };
  },
  'annotation.add'(doc, op) {
    if (!op.annotationId) throw new DomainError('INVALID_ARG', 'annotationId 必填');
    if (doc.annotations.some((a) => a.id === op.annotationId)) {
      throw new DomainError('INVALID_ARG', `标注 id 已存在: ${op.annotationId}`);
    }
    const r = op.range || {};
    // start === end 是「标记当前帧」：零长度区间仍然是一个合法位置，不能拒。
    if (!FINITE(r.start) || !FINITE(r.end) || r.start < 0 || r.end < r.start) {
      throw new DomainError('INVALID_ARG', 'range 必须满足 0 <= start <= end（end < start 是非法区间）');
    }
    // intent 白名单：ops 路径也守，不只靠客户端那一层。
    const intent = op.intent == null || op.intent === '' ? 'change' : String(op.intent);
    if (!ANNOTATION_INTENTS.includes(intent)) {
      throw new DomainError('INVALID_ARG', `不支持的标注类型：${intent}（只支持 ${ANNOTATION_INTENTS.join(' / ')}）`);
    }
    // target.clipId 指向不存在的片段 → 明确拒绝。
    // 否则删除片段时那段「会把标注标记 outdated」的逻辑永远等不到一个真片段，
    // 标注会静静地挂在一段早已不存在的素材上。
    const target = op.target && typeof op.target === 'object' ? op.target : null;
    if (target && target.clipId != null && target.clipId !== '') {
      if (typeof target.clipId !== 'string' || !doc.clips.some((c) => c.id === target.clipId)) {
        throw new DomainError('REF_NOT_FOUND', `标注指向的片段不存在: ${String(target.clipId)}`, {
          clipId: target.clipId,
        });
      }
    }
    const a = {
      id: op.annotationId,
      range: { start: round(r.start), end: round(r.end) },
      target,
      intent,
      expected: typeof op.expected === 'string' ? op.expected : String(op.expected == null ? '' : op.expected),
      status: 'open',
      author: op.author || 'user',
      outdated: false,
      createdAt: Date.now(),
    };
    doc.annotations.push(a);
    return { kind: 'annotation', id: a.id };
  },

  'annotation.update'(doc, op) {
    const a = doc.annotations.find((x) => x.id === op.annotationId);
    if (!a) throw new DomainError('REF_NOT_FOUND', `标注不存在: ${op.annotationId}`);
    for (const k of ['range', 'target', 'intent', 'expected', 'status']) {
      if (op[k] !== undefined) a[k] = op[k];
    }
    return { kind: 'annotation', id: a.id };
  },

  'annotation.delete'(doc, op) {
    const a = doc.annotations.find((x) => x.id === op.annotationId);
    if (!a) throw new DomainError('REF_NOT_FOUND', `标注不存在: ${op.annotationId}`);
    doc.annotations = doc.annotations.filter((x) => x.id !== a.id);
    return { kind: 'annotation', id: a.id };
  },
};

export const OP_NAMES = Object.keys(OPS);

/**
 * Apply a command list atomically to a cloned document.
 * Returns { doc, diff } or throws DomainError (caller keeps the old doc).
 */
export function applyOps(baseDoc, ops, { maxOps = 500 } = {}) {
  if (!Array.isArray(ops) || ops.length === 0) throw new DomainError('INVALID_ARG', 'ops 不能为空');
  if (ops.length > maxOps) throw new DomainError('INVALID_ARG', `一次最多 ${maxOps} 条命令`);
  const doc = JSON.parse(JSON.stringify(baseDoc));
  const touched = new Map();
  const results = [];

  for (const op of ops) {
    const fn = OPS[op.type];
    if (!fn) throw new DomainError('INVALID_OP', `未知命令: ${op.type}`, { supported: OP_NAMES });
    let r;
    try {
      r = fn(doc, op);
    } catch (e) {
      if (e instanceof DomainError) {
        e.message = `[${op.type}] ${e.message}`;
        throw e;
      }
      throw e;
    }
    results.push(r);
    for (const item of Array.isArray(r) ? r : [r]) {
      if (item && item.kind && item.id) touched.set(item.kind + ':' + item.id, item);
    }
  }

  assertNoOverlap(doc);
  recomputeDuration(doc);
  doc.revision = baseDoc.revision + 1;

  return { doc, diff: buildDiff(baseDoc, doc, touched), results };
}

function indexById(list) {
  const m = new Map();
  for (const x of list) m.set(x.id, x);
  return m;
}

export function buildDiff(before, after, touched) {
  const kinds = [
    ['clip', 'clips'],
    ['track', 'tracks'],
    ['annotation', 'annotations'],
    ['asset', 'assets'],
  ];
  const diff = { revision: after.revision, added: [], removed: [], modified: [], summary: '' };
  for (const [kind, key] of kinds) {
    const a = indexById(before[key]);
    const b = indexById(after[key]);
    for (const [id, val] of b) if (!a.has(id)) diff.added.push({ kind, id, value: val });
    for (const [id] of a) if (!b.has(id)) diff.removed.push({ kind, id });
    for (const [id, val] of b) {
      const old = a.get(id);
      if (!old) continue;
      const fields = {};
      for (const f of Object.keys(val)) {
        // 音频属性的「旧值」按默认值解释：老工程里没有 volume 字段 = 1，
        // 这样 diff 才能显示 1 → 0.5，而不是 missing → 0.5。
        const isAudio = kind === 'clip' && AUDIO_PROP_FIELDS.includes(f);
        const before = isAudio && old[f] === undefined ? audioPropsOf(old)[f] : old[f];
        if (JSON.stringify(before) !== JSON.stringify(val[f])) {
          fields[f] = { before, after: val[f] };
        }
      }
      if (Object.keys(fields).length) diff.modified.push({ kind, id, fields });
    }
  }
  const parts = [];
  if (diff.added.length) parts.push(`+${diff.added.length}`);
  if (diff.removed.length) parts.push(`-${diff.removed.length}`);
  if (diff.modified.length) parts.push(`~${diff.modified.length}`);
  diff.summary = parts.length ? `r${before.revision}→r${after.revision} ${parts.join(' ')}` : `r${after.revision} 无变化`;
  return diff;
}
