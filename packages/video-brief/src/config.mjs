/**
 * 配置归一化。不依赖 schemastery：插件装进任何 profile 都不会因为缺 peer 依赖而挂。
 *
 * `cordis.patch.yml` 里的 config 是**整份替换**（Cordis 的语义），
 * 所以这里把每个字段都做默认值与边界校验；`slots` 走 normalizeSlots 的"按 id 打补丁"。
 */

import { DEFAULT_MAX_QUESTIONS, DEFAULT_MAX_ROUNDS } from './brief.mjs';
import { GATE_MODES } from './gate.mjs';
import { normalizeSlots } from './slots.mjs';

/** 默认配置。 */
export function defaultConfig() {
  return {
    enabled: true,
    gate: 'warn',
    maxRounds: DEFAULT_MAX_ROUNDS,
    maxQuestions: DEFAULT_MAX_QUESTIONS,
    slots: normalizeSlots([]),
    memoryEnabled: true,
    promptSection: true,
  };
}

/** 整数夹取。 */
function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

/**
 * @param {unknown} raw apply(ctx, rawConfig) 的第二个参数
 */
export function normalizeConfig(raw) {
  const base = defaultConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const gate = typeof raw.gate === 'string' && GATE_MODES.includes(raw.gate) ? raw.gate : base.gate;
  return {
    enabled: raw.enabled !== false,
    gate,
    maxRounds: clampInt(raw.maxRounds, base.maxRounds, 1, 20),
    maxQuestions: clampInt(raw.maxQuestions, base.maxQuestions, 1, 10),
    slots: normalizeSlots(raw.slots),
    memoryEnabled: raw.memoryEnabled !== false,
    promptSection: raw.promptSection !== false,
  };
}
