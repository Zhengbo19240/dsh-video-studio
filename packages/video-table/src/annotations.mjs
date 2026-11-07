/**
 * 标注的纯函数层：把「秒」翻译成「第几镜 / 镜内偏移」，以及把整份标注导出成
 * 一段能直接粘给 agent 的结构化文本。
 *
 * 约定（和 domain.mjs 的 annotation.add 保持一致）：
 *  - 区间是半开的 [start, end)；start === end 表示「标记当前帧」，不是非法区间。
 *  - 镜头号从 1 开始；正好落在切点上的时间算后一个镜头。
 *  - 没有 analysis（还没解析过）时只给秒，绝不装作知道镜头号。
 *  - 这个文件不读盘、不连网：analysis 由调用方读进来传给我们。
 */

import { DomainError } from './domain.mjs';

const EPS = 1e-6;
const round3 = (n) => Math.round(n * 1000) / 1000;

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 标注类型：面板里的四个选项，顺序就是下拉框的顺序。 */
export const ANNOTATION_INTENTS = ['change', 'issue', 'question', 'note'];

/** 给中文界面用的短标签；未知类型原样显示，不吞掉。 */
export const INTENT_LABELS = {
  change: '要改',
  issue: '问题',
  question: '疑问',
  note: '备注',
};

export function intentLabel(intent) {
  return INTENT_LABELS[intent] || String(intent || 'change');
}

/** 规整成 {start, end}，负数钳到 0；顺序反了会抛 INVALID_ARG。 */
export function normalizeRange(range) {
  const raw = range || {};
  const start = round3(Math.max(0, toNumber(raw.start)));
  const end = round3(Math.max(0, toNumber(raw.end, start)));
  if (end < start) {
    throw new DomainError('INVALID_ARG', `标注区间非法：end(${end}) 小于 start(${start})`);
  }
  return { start, end };
}

/**
 * 入口一：标记当前帧。零长度区间，start === end。
 * 面板只传一个播放头时间，别让调用方自己拼两个相同的数字。
 */
export function frameRange(t) {
  const at = round3(Math.max(0, toNumber(t)));
  return { start: at, end: at };
}

/**
 * 入口二：从 A 到 B。B 必须 >= A —— 反了就抛，由面板提示并保持当前状态，
 * 不替用户自作主张交换两端（交换会把「我点反了」变成一个悄悄生效的改动）。
 */
export function spanRange(from, to) {
  const a = round3(Math.max(0, toNumber(from)));
  const b = round3(Math.max(0, toNumber(to)));
  if (b < a) {
    throw new DomainError('INVALID_ARG', `B 必须不小于 A：A=${a}s，B=${b}s`);
  }
  return { start: a, end: b };
}

/** 镜头表：接受 analysis 本体，也接受 {ok:true, shots}；按 start 升序，号从 1 开始。 */
function shotsOf(analysis) {
  const raw = analysis && Array.isArray(analysis.shots) ? analysis.shots : null;
  if (!raw || !raw.length) return [];
  const list = raw
    .map((shot, i) => {
      const start = toNumber(shot && shot.start);
      const end = toNumber(shot && shot.end, start);
      const index = Number.isFinite(Number(shot && shot.index)) && Number(shot.index) > 0 ? Number(shot.index) : i + 1;
      return { index, start: round3(start), end: round3(Math.max(start, end)) };
    })
    .filter((shot) => shot.end >= shot.start)
    .sort((a, b) => a.start - b.start || a.index - b.index);
  return list;
}

/** 时间落在哪个镜头里：半开区间 [start, end)，正好落在切点上算后一镜。 */
function shotAt(shots, t) {
  if (!shots.length) return null;
  const first = shots[0];
  const last = shots[shots.length - 1];
  if (t < first.start - EPS) return null; // 片头之前：没有镜头
  if (t >= last.end) return null; // 片尾之后（含正好等于总长）：没有镜头
  for (const shot of shots) {
    if (t < shot.end - EPS) return shot;
  }
  return last;
}

/**
 * 给一段区间补上镜头坐标。
 *
 * 返回 { start, end } 或 { start, end, shot, shotStart, shotOffset, shotEnd }。
 * shotOffset = start - shotStart（正数；负数不会出现，因为片头之前不给镜头号）。
 */
export function enrichAnnotation(range, analysis) {
  const r = normalizeRange(range);
  const base = { start: r.start, end: r.end };
  const shots = shotsOf(analysis);
  const hit = shotAt(shots, r.start);
  if (!hit) return base;
  return {
    ...base,
    shot: hit.index,
    shotStart: round3(hit.start),
    shotOffset: round3(r.start - hit.start),
    shotEnd: round3(hit.end),
  };
}

/**
 * 人类可读的位置：
 *   有镜头表 → `第 7 镜 · 12.40s（镜内 +0.30s）`
 *   没有镜头表 → `12.40s → 13.90s`，零长度区间写 `12.40s（当前帧）`
 */
export function formatAnnotation(entry) {
  const e = entry || {};
  const start = round3(Math.max(0, toNumber(e.start)));
  const end = round3(Math.max(start, toNumber(e.end, start)));
  const time = (n) => `${n.toFixed(2)}s`;
  if (Number.isFinite(Number(e.shot)) && Number(e.shot) > 0) {
    const offset = round3(toNumber(e.shotOffset));
    const sign = offset >= 0 ? '+' : '-';
    return `第 ${Number(e.shot)} 镜 · ${time(start)}（镜内 ${sign}${Math.abs(offset).toFixed(2)}s）`;
  }
  if (Math.abs(end - start) < 1e-9) return `${time(start)}（当前帧）`;
  return `${time(start)} → ${time(end)}`;
}

/** 一条标注完整的一行：位置 + 类型 + 批注。多行批注整体缩进，读起来还是一块。 */
export function formatAnnotationLine(annotation, index, { analysis } = {}) {
  const a = annotation || {};
  const entry = enrichAnnotation(a.range || { start: 0, end: 0 }, analysis);
  const at = formatAnnotation(entry);
  const intent = a.intent || 'change';
  const head = `${index == null ? '-' : index + 1}. ${at} · 类型 ${intent}${intentLabel(intent) === intent ? '' : '（' + intentLabel(intent) + '）'}`;
  const text = String(a.expected == null ? '' : a.expected).trim();
  const body = text ? text.replace(/\r?\n/g, '\n   ') : '（空）';
  return `${head}\n   批注：${body}`;
}

/**
 * 导出整份标注清单。
 *
 * 这是一段「给人确认、给 agent 对齐」的文本，不是某条私有协议：
 * 复制走剪贴板，面板里原样显示；没有「直接发进对话」的接口，也不假装有。
 */
export function exportAnnotations(annotations, analysis) {
  const list = Array.isArray(annotations) ? annotations : [];
  const lines = [
    `【标注清单】共 ${list.length} 条` + (shotsOf(analysis).length ? ` · 镜头表 ${shotsOf(analysis).length} 镜` : ' · 未解析，位置只有秒'),
  ];
  if (!list.length) {
    lines.push('（还没有任何标注）');
    return lines.join('\n');
  }
  const sorted = list
    .slice()
    .sort((a, b) => toNumber(a && a.range && a.range.start) - toNumber(b && b.range && b.range.start));
  sorted.forEach((a, i) => lines.push(formatAnnotationLine(a, i, { analysis })));
  return lines.join('\n');
}

/** 把一次标注提交整理成一条 annotation.add 命令（面板与 RPC 共用）。 */
export function annotationOp({ annotationId, range, intent, expected, target } = {}) {
  if (!annotationId || typeof annotationId !== 'string') {
    throw new DomainError('INVALID_ARG', 'annotationId 必填');
  }
  // range 一定要显式给：缺省成 {0,0} 等于在片头悄悄放一条标注。
  // 想标当前帧请传 frameRange(t) 的结果（start === end）。
  if (!range || typeof range !== 'object' || Array.isArray(range)) {
    throw new DomainError('INVALID_ARG', 'range 必填：标记当前帧传 { start, end }（两者相同），区间传 A→B');
  }
  const r = normalizeRange(range);
  const kind = intent == null || intent === '' ? 'change' : String(intent);
  if (!ANNOTATION_INTENTS.includes(kind)) {
    throw new DomainError('INVALID_ARG', `不支持的标注类型：${kind}（只支持 ${ANNOTATION_INTENTS.join(' / ')}）`);
  }
  const op = {
    type: 'annotation.add',
    annotationId,
    range: r,
    intent: kind,
    expected: typeof expected === 'string' ? expected : String(expected == null ? '' : expected),
  };
  if (target && typeof target === 'object') op.target = target;
  return op;
}
