/**
 * 分镜表：把一串字幕条目切分成镜头。
 *
 * 纯函数，不读磁盘、不碰工程、不调模型。输入 cues 的形状与 src/srt.mjs 的
 * parseSrt 一致：{ start, end, text }，时间单位是秒。
 *
 * 切分规则（启发式，刻意保持可解释）：
 *  1. 相邻字幕里，前一条不足 1.2 秒且没有句末标点（半句）时，与后一条合并；
 *  2. 超过 6 秒的字幕都按句内标点（，。；：）切，切点在标点之后；单条超过 8 秒的
 *     必然落进这一条路径，通常切成两三镜；
 *  3. 每镜目标 2–6 秒：超过上限继续切，不足下限且与邻居贴得够近就合并；
 *  4. 首镜 hook，末镜 outro，中间按文本判断 evidence / transition / point。
 *
 * 边界约定：切分只移动镜内边界，不拉伸时间轴。实在满足不了 2–6 秒的镜头
 * 会保留原时长并写进 warnings，而不是硬凑——时间轴对不上声音，比时长不齐更糟。
 */

const SHORT_CUE = 1.2; // 短于这个秒数且没有句末标点，算半句
const GAP = 0.35; // 两条字幕之间空档小于这个值，才算“贴在一起”
const TEXT_LIMIT = 60; // 工具层截断文本用，这里保留全文

const SENTENCE_END = /[。！？!?…]\s*$/;
const INNER_PUNCT = /[，,。；;：:]/;
const NUMERIC_RE = /\d|[零一二三四五六七八九十百千万]+(?:%|％|成|倍|万|亿)/;
const CONNECTOR_RE = /所以|因此|但是|不过|接下来|然后|另外|同时|于是|总之|然而|也就是说|换句话说/;

const DEFAULT_OPTIONS = { minDuration: 2, maxDuration: 6, maxShots: 40 };

/** 允许的建议动效类型。分镜只给建议，不负责渲染。 */
export const EFFECT_CHOICES = [
  'count-up',
  'claude-typer',
  'light-spotlight-render',
  'scanline-glint',
  'ruler-progress-render',
  'none',
];

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function positiveNumber(value, fallback, label) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} 必须是正数`);
  return n;
}

/** 拼接两段文本：纯中文直接连，英文/数字之间补一个空格。 */
function joinText(left, right) {
  if (!left) return right;
  if (!right) return left;
  const ascii = /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
  return left + (ascii ? ' ' : '') + right;
}

// ---------------------------------------------------------------- 输入整理 ----

function normalizeCues(cues) {
  if (!Array.isArray(cues)) throw new Error('cues 必须是数组，形如 [{ start, end, text }]');
  if (!cues.length) throw new Error('没有字幕可以切分：cues 为空');

  const list = [];
  cues.forEach((cue, i) => {
    const label = `第 ${i + 1} 条字幕`;
    if (!cue || typeof cue !== 'object') throw new Error(`${label}不是对象`);
    const start = Number(cue.start);
    const end = Number(cue.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`${label}的起止时间不是数字`);
    if (start < 0) throw new Error(`${label}的开始时间是负数：${start}`);
    if (end <= start) throw new Error(`${label}时间倒挂：${start} → ${end}，结束时间必须晚于开始时间`);
    // 多行字幕压成一行，方便后续按字符比例切分和截断
    const text = String(cue.text == null ? '' : cue.text)
      .replace(/\s*\n\s*/g, ' ')
      .trim();
    if (!text) throw new Error(`${label}没有文本`);
    list.push({ start: round3(start), end: round3(end), text });
  });

  // 乱序输入按时间排好；排完之后再走一遍切分，负时长已经在上面挡掉了
  list.sort((a, b) => a.start - b.start);
  return list;
}

// ---------------------------------------------------------------- 合并短句 ----

function mergeShortHalfSentences(segs) {
  const out = [];
  for (const seg of segs) {
    const last = out[out.length - 1];
    if (last) {
      const tooShort = last.end - last.start < SHORT_CUE;
      const halfSentence = !SENTENCE_END.test(last.text);
      if (tooShort && halfSentence) {
        last.end = Math.max(last.end, seg.end);
        last.text = joinText(last.text, seg.text);
        continue;
      }
    }
    out.push({ start: seg.start, end: seg.end, text: seg.text });
  }
  return out;
}

// ---------------------------------------------------------------- 切分长句 ----

/** 找出所有可以切的字符位置（切在标点之后，末尾标点不算）。 */
function punctCuts(text) {
  const cuts = [];
  for (let i = 0; i < text.length - 1; i += 1) {
    if (INNER_PUNCT.test(text[i])) cuts.push(i + 1);
  }
  return cuts;
}

function sliceSegment(seg, charAt) {
  const len = seg.text.length;
  if (!len || charAt <= 0 || charAt >= len) return null;
  const ratio = charAt / len;
  const cut = round3(seg.start + (seg.end - seg.start) * ratio);
  const left = seg.text.slice(0, charAt).trim();
  const right = seg.text.slice(charAt).trim();
  if (!left || !right || cut <= seg.start || cut >= seg.end) return null;
  return [
    { start: seg.start, end: cut, text: left },
    { start: cut, end: seg.end, text: right },
  ];
}

/**
 * 把一段超长镜头切成两段。
 * 切点优先落在标点上，并保证两边的时长都不小于 minDuration；
 * 文本里没有合法标点时就按字符中点切。
 */
function splitOne(seg, maxDuration, minDuration) {
  const len = seg.text.length;
  const span = seg.end - seg.start;
  if (len < 4 || span <= maxDuration) return null;

  const ratioLo = minDuration / span;
  const ratioHi = 1 - ratioLo;
  const charLo = Math.ceil(len * ratioLo);
  const charHi = Math.floor(len * ratioHi);
  if (charLo > charHi) return null;

  const mid = len / 2;
  let best = null;
  for (const cut of punctCuts(seg.text)) {
    if (cut < charLo || cut > charHi) continue;
    if (best == null || Math.abs(cut - mid) < Math.abs(best - mid)) best = cut;
  }
  if (best == null) {
    const fallback = Math.floor(mid);
    if (fallback < charLo || fallback > charHi) return null;
    best = fallback;
  }
  return sliceSegment(seg, best);
}

function splitOverMax(segs, maxDuration, minDuration, warnings) {
  const out = [];
  const queue = segs.map((s) => ({ ...s }));
  let guard = 0;
  while (queue.length) {
    const seg = queue.shift();
    const span = seg.end - seg.start;
    if (span <= maxDuration + 1e-6) {
      out.push(seg);
      continue;
    }
    if (guard > 200) {
      out.push(seg);
      continue;
    }
    guard += 1;
    const parts = splitOne(seg, maxDuration, minDuration);
    if (!parts) {
      warnings.push(
        `有一段 ${round3(span)} 秒的字幕（从 ${round3(seg.start)} 秒开始）超过 ${maxDuration} 秒，但文本里找不到能切的位置，保留了原样`,
      );
      out.push(seg);
      continue;
    }
    queue.unshift(...parts);
  }
  return out;
}

// ---------------------------------------------------------------- 抬短镜头 ----

function absorbUnderMin(segs, minDuration, maxDuration, warnings) {
  const out = segs.map((s) => ({ ...s }));
  for (let i = 0; i < out.length && out.length > 1; i += 1) {
    const seg = out[i];
    const span = seg.end - seg.start;
    if (span >= minDuration - 1e-9) continue;
    const next = out[i + 1];
    const prev = out[i - 1];
    if (next && next.start - seg.end <= GAP && next.end - seg.start <= maxDuration + 1e-9) {
      seg.text = joinText(seg.text, next.text);
      seg.end = next.end;
      out.splice(i + 1, 1);
      i -= 1;
      continue;
    }
    if (prev && seg.start - prev.end <= GAP && seg.end - prev.start <= maxDuration + 1e-9) {
      prev.text = joinText(prev.text, seg.text);
      prev.end = seg.end;
      out.splice(i, 1);
      i -= 1;
      continue;
    }
    warnings.push(`有一镜只有 ${round3(span)} 秒，短于 ${minDuration} 秒，但前后没有贴得住的镜头，保留原时长`);
  }
  return out;
}

// ---------------------------------------------------------------- 标签判断 ----

function classifyKind(text, isFirst, isLast) {
  if (isFirst) return 'hook';
  if (isLast) return 'outro';
  if (NUMERIC_RE.test(text)) return 'evidence';
  if (CONNECTOR_RE.test(text)) return 'transition';
  return 'point';
}

function suggestEffect(shot, isFirst, isLast) {
  const { text, duration, kind } = shot;

  if (isFirst) return { effect: 'light-spotlight-render', reason: '开场用聚光灯扫字，先把注意力抓住' };
  if (isLast) return { effect: 'none', reason: '收尾宜静，留一个干净的画面结束' };
  if (duration < 1.5) return { effect: 'none', reason: '镜头不足 1.5 秒，动效来不及做完' };

  if (kind === 'evidence') {
    if (NUMERIC_RE.test(text)) {
      return { effect: 'count-up', reason: '数字用滚动计数出现，比静态字幕更有说服力' };
    }
    return { effect: 'claude-typer', reason: '引用类的证据逐字打出，观众来得及读完' };
  }
  if (kind === 'transition') {
    return { effect: 'scanline-glint', reason: '转场用扫描光划过，提示节奏要换了' };
  }
  if (text.length >= 20) {
    return { effect: 'claude-typer', reason: '长句逐字出现，观众跟得上节奏' };
  }
  if (duration >= 4) {
    return { effect: 'ruler-progress-render', reason: '较长的观点镜头用进度尺稳住节奏' };
  }
  return { effect: 'none', reason: '中短镜头保持画面干净，不抢文案' };
}

// ------------------------------------------------------------------ 主流程 ----

/**
 * 把字幕切成分镜。
 *
 * @param {Array<{start:number,end:number,text:string}>} cues
 * @param {{minDuration?:number,maxDuration?:number,maxShots?:number}} [options]
 * @returns {{shots:Array,total:number,warnings:string[]}}
 */
export function buildStoryboard(cues, options = {}) {
  const minDuration = positiveNumber(options.minDuration, DEFAULT_OPTIONS.minDuration, 'minDuration');
  const maxDuration = positiveNumber(options.maxDuration, DEFAULT_OPTIONS.maxDuration, 'maxDuration');
  if (maxDuration < minDuration) throw new Error('maxDuration 不能小于 minDuration');

  const rawMax = options.maxShots == null ? DEFAULT_OPTIONS.maxShots : Number(options.maxShots);
  if (!Number.isFinite(rawMax) || rawMax < 1) throw new Error('maxShots 必须是大于 0 的整数');
  const maxShots = Math.floor(rawMax);

  const warnings = [];
  const list = normalizeCues(cues);

  // 1) 半句合并 → 2) 按标点切长句 → 3) 压到上限时长 → 4) 抬到下限时长
  let segments = mergeShortHalfSentences(list);
  segments = segments.map((s) => ({ ...s }));
  segments = splitOverMax(segments, maxDuration, minDuration, warnings);
  segments = absorbUnderMin(segments, minDuration, maxDuration, warnings);

  // 先截断再贴标签，保证输出里的第一镜一定是 hook、最后一镜一定是 outro
  if (segments.length > maxShots) {
    const kept = segments.slice(0, maxShots);
    const dropped = segments.slice(maxShots);
    const droppedSeconds = dropped.reduce((sum, s) => sum + (s.end - s.start), 0);
    warnings.push(
      `分镜共 ${segments.length} 个，超过上限 ${maxShots}，只输出前 ${maxShots} 个（另有 ${dropped.length} 个、约 ${round3(droppedSeconds)} 秒未输出）`,
    );
    segments = kept;
  }

  const shots = segments.map((seg, i) => {
    const isFirst = i === 0;
    const isLast = i === segments.length - 1;
    const shot = {
      index: i + 1,
      start: round3(seg.start),
      end: round3(seg.end),
      duration: round3(seg.end - seg.start),
      text: seg.text,
      kind: classifyKind(seg.text, isFirst, isLast),
      suggestedEffect: 'none',
      reason: '',
    };
    const advice = suggestEffect(shot, isFirst, isLast);
    shot.suggestedEffect = advice.effect;
    shot.reason = advice.reason;
    return shot;
  });

  if (shots.length === 1) {
    warnings.push('只切出一镜，已按开场标成 hook；这一镜同时也是结尾，但没有标 outro');
  }

  const total = round3(shots.reduce((sum, s) => sum + s.duration, 0));
  return { shots, total, warnings };
}

export { TEXT_LIMIT };
