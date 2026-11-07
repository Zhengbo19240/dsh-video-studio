/**
 * 简报的纯函数层：判定、合并、差异、摘要。
 *
 * 这一层不碰文件系统、不碰 DSH 上下文，输入对象出对象，所以能直接单测。
 * 存储（读盘/原子写/并发串行）在 store.mjs，门禁判定在 gate.mjs。
 */

import { DEFAULT_SLOTS, normalizeSlots, referenceIdSet, slotIdSet } from './slots.mjs';

/** brief.json 的格式版本。 */
export const BRIEF_VERSION = 1;

/** 参考素材槽位 id（值可以是路径清单，也可以是显式「无参考」，不是纯文本）。 */
export const REFERENCE_SLOT_ID = 'reference';

/** 显式「无参考」在摘要里的标注。 */
export const NO_REFERENCE_LABEL = '（用户确认无参考）';

/**
 * 参考素材缺失时的专门文案：先问有没有，再提醒图片优于文字，最后要求显式确认。
 * buildSummary 和门禁的 buildDenyReason 共用这一句，避免两处说法漂移。
 */
export const REFERENCE_GAP_HINT = '参考素材还没答：先问有没有参考图 / 样片（4–5 张最好，1 条样片也行）——图片胜过一万字描述，能锚定画风、构图和节奏；用户真没有时，必须显式回一句「无参考」，不许默认略过。';

/** 视为「显式无参考」的中文/英文说法（比较前会去掉空白和标点，转小写）。 */
const NO_REFERENCE_TEXTS = new Set([
  '无参考',
  '无参考图',
  '无参考片',
  '无参考素材',
  '没有参考',
  '没有参考图',
  '没有参考片',
  '没参考',
  '无需参考',
  '不需要参考',
  '不用参考',
  '不要参考',
  '无',
  '没有',
  '暂无',
  '无样片',
  '没有样片',
  'none',
  'noreference',
  'n/a',
]);

/** 一轮最多问几条（超出不列，宁可下一轮再问）。 */
export const DEFAULT_MAX_QUESTIONS = 3;

/** 默认轮数上限。注意：**轮数上限不绕过 10 个槽位**，只是提示别再挤。 */
export const DEFAULT_MAX_ROUNDS = 6;

/** 空简报。 */
export function emptyBrief(now = Date.now()) {
  const iso = new Date(now).toISOString();
  return {
    version: BRIEF_VERSION,
    topic: '',
    round: 0,
    createdAt: iso,
    updatedAt: iso,
    slots: {},
  };
}

/** 一条值算不算"填了"：非空字符串（只有空白不算）。 */
export function isFilled(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** 去掉空白与常见标点，用来比较「无参考」的各种说法。 */
function flattenText(value) {
  return String(value)
    .replace(/\s+/g, '')
    .replace(/[。．，,、；;：:!！?？~～…·"'“”‘’()（）]/g, '')
    .toLowerCase();
}

/** 这句话是不是「显式无参考」（必须是完整说法，模糊的「随便」不算）。 */
export function isNoReferenceText(value) {
  return typeof value === 'string' && NO_REFERENCE_TEXTS.has(flattenText(value));
}

/**
 * 归一化参考素材的值。允许三种形态：
 * - 纯文本：`"像 Fireship 那种节奏"`（算 provided，count=1）
 * - 显式无参考：`"无参考"` 等同义字符串，或 `{ skipped: true, reason? }`
 * - 路径清单：`{ paths: [...], note? }`（由 video_reference_register 写入，不复制文件）
 *
 * 空串 / 空白 / 空对象 → `undefined`（= 没回答）。
 * @param {unknown} value
 * @returns {string|{skipped:true,reason?:string}|{kind:'references',paths:string[],count:number,note?:string,registeredAt?:string}|undefined}
 */
export function normalizeReferenceValue(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return undefined;
    // 同义说法统一压成结构化标记：后续判定只看 skipped，不用再回头猜字符串。
    if (isNoReferenceText(text)) return { skipped: true };
    return text;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (value.skipped === true) {
    const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
    return reason === '' ? { skipped: true } : { skipped: true, reason };
  }
  const paths = Array.isArray(value.paths)
    ? [...new Set(
      value.paths
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item !== ''),
    )]
    : [];
  const count = Number(value.count);
  const hasCount = Number.isFinite(count) && count > 0;
  if (paths.length === 0 && !hasCount) return undefined;
  const out = {
    kind: 'references',
    paths,
    count: paths.length > 0 ? paths.length : Math.floor(count),
  };
  const note = typeof value.note === 'string' ? value.note.trim() : '';
  if (note !== '') out.note = note;
  const registeredAt = typeof value.registeredAt === 'string' ? value.registeredAt.trim() : '';
  if (registeredAt !== '') out.registeredAt = registeredAt;
  return out;
}

/** 值算不算已填：字符串非空白；参考素材还可以是显式无参考或非空路径清单。 */
export function isSlotFilled(value) {
  if (typeof value === 'string') return value.trim() !== '';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.skipped === true) return true;
  const count = Number(value.count);
  if (Number.isFinite(count) && count > 0) return true;
  return Array.isArray(value.paths) && value.paths.length > 0;
}

/** 按槽位类型归一化一个值；非参考槽位仍然只收非空字符串。 */
function normalizeSlotValue(id, value, referenceIds) {
  const isReference = referenceIds instanceof Set && referenceIds.has(id);
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return undefined;
    return isReference ? normalizeReferenceValue(text) : text;
  }
  return isReference ? normalizeReferenceValue(value) : undefined;
}

/** 参考素材值的中文展示（摘要与返回给模型的文本共用）。 */
export function describeReferenceValue(value) {
  if (value && typeof value === 'object' && value.skipped === true) return NO_REFERENCE_LABEL;
  const paths = value && typeof value === 'object' && Array.isArray(value.paths) ? value.paths : [];
  const count = Number(value && typeof value === 'object' ? value.count : NaN);
  if (paths.length > 0) {
    const shown = paths.slice(0, 6).join('、');
    const more = paths.length > 6 ? ' 等' : '';
    const total = Number.isFinite(count) && count > paths.length ? `（共 ${count} 个）` : '';
    return `${paths.length} 个参考文件：${shown}${more}${total}`;
  }
  const total = Number.isFinite(count) && count > 0 ? count : 0;
  return `${total} 个参考文件（只登记了数量，没有路径）`;
}

/**
 * 参考素材的三种状态：
 * - `missing`：没填 / 空串 / 空白（仍然缺，brief 不算满）
 * - `explicit-none`：用户明确说了「无参考」（算已填，可以继续，但不是 ready 捷径）
 * - `provided`：给了路径清单或文字描述（count 是已知数量）
 * @param {unknown} brief
 * @param {Array} [slots]
 * @returns {{state:'provided'|'explicit-none'|'missing', count?: number}}
 */
export function referenceStatus(brief, slots) {
  const normalized = normalizeBrief(brief, { slots });
  const value = normalized.slots[REFERENCE_SLOT_ID];
  if (!isSlotFilled(value)) return { state: 'missing' };
  if (typeof value === 'string') return { state: 'provided', count: 1 };
  if (value.skipped === true) return { state: 'explicit-none' };
  const count = Number(value.count);
  if (Number.isFinite(count) && count > 0) return { state: 'provided', count };
  return { state: 'provided', count: Array.isArray(value.paths) ? value.paths.length : 0 };
}

/**
 * 把任意来源的数据补成合法简报。坏结构、数组、null 一律降级为空简报。
 * @param {unknown} raw
 * @param {{slots?: Array}} [options] 传了就只保留已知槽位 id。
 */
export function normalizeBrief(raw, options = {}) {
  const base = emptyBrief();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const allowed = options.slots ? slotIdSet(options.slots) : null;
  const referenceIds = referenceIdSet(options.slots);
  const source = raw.slots && typeof raw.slots === 'object' && !Array.isArray(raw.slots) ? raw.slots : {};
  const slots = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowed && !allowed.has(key)) continue;
    const normalized = normalizeSlotValue(key, value, referenceIds);
    if (normalized === undefined) continue;
    slots[key] = normalized;
  }
  const round = Number(raw.round);
  return {
    version: BRIEF_VERSION,
    topic: typeof raw.topic === 'string' ? raw.topic.trim() : '',
    round: Number.isFinite(round) && round > 0 ? Math.floor(round) : 0,
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt !== '' ? raw.createdAt : base.createdAt,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt !== '' ? raw.updatedAt : base.updatedAt,
    slots,
  };
}

/**
 * 判定当前简报状态。这就是 `video_brief_start` 的核心。
 * @param {{brief?: unknown, slots?: Array, maxQuestions?: number, maxRounds?: number}} input
 */
export function evaluateBrief(input = {}) {
  const slots = normalizeSlots(input.slots);
  const brief = normalizeBrief(input.brief, { slots });
  const maxQuestions = Math.max(1, Number(input.maxQuestions) || DEFAULT_MAX_QUESTIONS);
  const maxRounds = Math.max(1, Number(input.maxRounds) || DEFAULT_MAX_ROUNDS);

  const filled = {};
  const missingAll = [];
  for (const slot of slots) {
    const value = brief.slots[slot.id];
    if (isSlotFilled(value)) {
      filled[slot.id] = value;
    } else {
      missingAll.push({
        slot: slot.id,
        title: slot.title,
        // 参考素材有固定提问（askText）；其余槽位用 question。
        question: slot.askText ?? slot.question,
        why: slot.why,
        ...(slot.kind ? { kind: slot.kind } : {}),
      });
    }
  }
  const total = slots.length;
  const filledCount = Object.keys(filled).length;
  // 硬规则：只有全部槽位填满才 ready，轮数到了也不放水。
  const ready = total > 0 && filledCount === total;

  return {
    verdict: ready ? 'ready' : 'needs-answers',
    ready,
    filled,
    missing: missingAll.slice(0, maxQuestions),
    missingAll,
    filledCount,
    total,
    round: brief.round,
    maxRounds,
    roundsLeft: Math.max(0, maxRounds - brief.round),
  };
}

/**
 * 校验并合并答案。
 *
 * 规则：
 * - 键不在槽位表里 → `unknown`（调用方整批拒绝，不写盘）；
 * - 值是空串/空白/非字符串 → `ignored`（当作没填，不写盘）；
 * - 值合法 → 覆盖旧值，记进 `changed`（同值覆盖不算 changed）。
 *
 * @param {{brief?: unknown, answers?: object, slots?: Array, now?: number}} input
 */
export function mergeAnswers(input = {}) {
  const slots = normalizeSlots(input.slots);
  const ids = slotIdSet(slots);
  const referenceIds = referenceIdSet(slots);
  const prev = normalizeBrief(input.brief, { slots });
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const answers = input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers)
    ? input.answers
    : {};

  const changed = [];
  const ignored = [];
  const unknown = [];
  const nextSlots = { ...prev.slots };

  for (const [key, value] of Object.entries(answers)) {
    if (!ids.has(key)) {
      unknown.push(key);
      continue;
    }
    const normalized = normalizeSlotValue(key, value, referenceIds);
    if (normalized === undefined) {
      // 空串 / 空白 / 参考素材的空对象：都算没回答，不写盘。
      ignored.push({ slot: key, reason: typeof value === 'string' ? 'empty' : 'unsupported' });
      continue;
    }
    if (JSON.stringify(nextSlots[key]) === JSON.stringify(normalized)) continue;
    nextSlots[key] = normalized;
    changed.push(key);
  }

  const wrote = changed.length > 0;
  const brief = {
    ...prev,
    slots: nextSlots,
    round: prev.round + (wrote ? 1 : 0),
    updatedAt: wrote ? new Date(now).toISOString() : prev.updatedAt,
  };

  const verdict = evaluateBrief({ brief, slots, maxQuestions: 9999, maxRounds: input.maxRounds });
  return {
    brief,
    changed,
    ignored,
    unknown,
    ready: verdict.ready,
    stillMissing: verdict.missingAll.map((item) => item.slot),
    missingFull: verdict.missingAll,
    filledCount: verdict.filledCount,
    total: verdict.total,
  };
}

/**
 * 两份简报的差异（按槽位维度）。
 * @param {unknown} prev
 * @param {unknown} next
 */
export function compareBrief(prev, next) {
  const before = normalizeBrief(prev);
  const after = normalizeBrief(next);
  const keys = new Set([...Object.keys(before.slots), ...Object.keys(after.slots)]);
  const added = [];
  const changed = [];
  const removed = [];
  const unchanged = [];
  for (const key of keys) {
    const from = before.slots[key];
    const to = after.slots[key];
    if (from === undefined && to !== undefined) added.push(key);
    else if (from !== undefined && to === undefined) removed.push(key);
    else if (from !== to) changed.push({ slot: key, from, to });
    else if (from !== undefined) unchanged.push(key);
  }
  const same = added.length === 0 && changed.length === 0 && removed.length === 0;
  return { added, changed, removed, unchanged, same };
}

/**
 * drift 模式的差异报告：目标换了，旧答案要不要复核。
 *
 * 判定很朴素但可靠：brief 里记的目标和这次传进来的 topic 不一致时，
 * 已填的槽位全部标成"可能过期"——因为目标是所有答案的前提。
 * @param {{brief?: unknown, topic?: string, slots?: Array}} input
 */
export function driftReport(input = {}) {
  const slots = normalizeSlots(input.slots);
  const brief = normalizeBrief(input.brief, { slots });
  const before = brief.topic;
  const after = typeof input.topic === 'string' ? input.topic.trim() : '';
  const topicChanged = before !== '' && after !== '' && before !== after;
  return {
    topic_before: before,
    topic_after: after,
    topic_changed: topicChanged,
    may_be_stale: topicChanged ? Object.keys(brief.slots) : [],
    filled_count: Object.keys(brief.slots).length,
  };
}

/**
 * 给模型和用户看的中文摘要。
 * @param {{brief?: unknown, slots?: Array, ready?: boolean}} input
 */
export function buildSummary(input = {}) {
  const slots = normalizeSlots(input.slots);
  const brief = normalizeBrief(input.brief, { slots });
  const verdict = evaluateBrief({ brief, slots, maxQuestions: 9999, maxRounds: 9999 });
  const lines = [];
  lines.push(`视频简报：已确认 ${verdict.filledCount}/${verdict.total}${verdict.ready ? '（ready，可以开工）' : '（还不能开工）'}`);
  for (const slot of slots) {
    const value = brief.slots[slot.id];
    if (!isSlotFilled(value)) continue;
    const text = slot.kind === 'references' ? describeReferenceValue(value) : String(value);
    lines.push(`- ${slot.title}：${text}`);
  }
  if (!verdict.ready) {
    const missingTitles = verdict.missingAll.map((item) => item.title).join('、');
    lines.push(`- 还缺（按优先级）：${missingTitles}`);
    // 缺参考素材时给专门文案：先问有无，再提醒图片优于文字，最后要显式确认。
    if (verdict.missingAll.some((item) => item.slot === REFERENCE_SLOT_ID)) {
      lines.push(`- ${REFERENCE_GAP_HINT}`);
    }
  }
  return lines.join('\n');
}
