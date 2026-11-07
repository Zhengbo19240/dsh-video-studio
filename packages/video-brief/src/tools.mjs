/**
 * 十一个工具：
 *   原有：video_brief_start / video_brief_confirm
 *   阶段：video_stage_get / video_stage_advance
 *   脚本：video_script_draft / video_script_read / video_script_confirm
 *   风格：video_style_confirm / video_style_read
 *   参考：video_reference_register / video_reference_skip
 *
 * 工具只做薄封装：取工程根 → 读/写 .dsh-video/*.json → 交给纯函数判定。
 * 所有工具自身也做事实校验（不只靠门禁），因为 warn 档门禁是放行的。
 */

import path from 'node:path';

import {
  buildSummary,
  driftReport,
  evaluateBrief,
  mergeAnswers,
  normalizeBrief,
  referenceStatus,
} from './brief.mjs';
import { slotIdSet } from './slots.mjs';
import { loadPreferences, pickRelatedPreferences } from './memory.mjs';
import { scriptSummary } from './script.mjs';
import { STAGES, blockedFor, isStage, nextStepFor } from './stage.mjs';
import { buildStyle } from './style.mjs';

/** 把对象包成"回灌给模型的文本块"。 */
function textOutput(schema) {
  return {
    schema,
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

/** 一句固定提示：别挤牙膏。 */
export const TRANSCRIPT_HINT = '把缺失项一次问完，别挤牙膏';

const START_PARAMETERS = {
  type: 'object',
  properties: {
    topic: {
      type: 'string',
      description: '这次视频的主题或一句话目标（可省略）。用于筛选全局偏好，以及 drift 模式下判断目标是否变了。',
    },
    mode: {
      type: 'string',
      enum: ['new', 'drift'],
      description: 'new=新任务（默认）；drift=目标/范围中途大改，重新判定并给出差异。',
    },
  },
  additionalProperties: false,
};

const START_OUTPUT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ready', 'needs-answers'] },
    ready: { type: 'boolean' },
    filled: { type: 'object', description: '已填槽位（slot → 值）' },
    missing: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slot: { type: 'string' },
          title: { type: 'string' },
          question: { type: 'string' },
          why: { type: 'string' },
          kind: { type: 'string', description: '槽位类型；reference 是 references（参考素材）' },
        },
      },
      description: '按优先级排序的缺失项，最多 3 条',
    },
    missing_total: { type: 'number' },
    filled_count: { type: 'number' },
    slots_total: { type: 'number' },
    round: { type: 'number' },
    maxRounds: { type: 'number' },
    memory_context: { type: 'array', items: { type: 'string' } },
    transcript_hint: { type: 'string' },
    mode: { type: 'string' },
    drift: { type: 'object', description: 'mode=drift 时的差异报告' },
    hint: { type: 'string' },
    brief_corrupt: { type: 'boolean' },
    brief_backup: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: true,
};

const CONFIRM_PARAMETERS = {
  type: 'object',
  properties: {
    answers: {
      type: 'object',
      description: '槽位答案：{ goal, audience, platform, duration, tone, pace, visual, reference, deliverable, taboo } 里任意几项。空串视为未填，未知槽位名整批拒绝。reference 可以给字符串、{ skipped: true, reason? }（显式无参考）或 { paths: [...] }（推荐用 video_reference_register）。',
      additionalProperties: {
        description: '字符串；参考素材还可以是 { skipped: true, reason? } 或 { paths: [...], note? }',
      },
    },
    topic: {
      type: 'string',
      description: '可选：本次视频主题，写进 brief.json 供 drift 比对。省略时沿用最近一次 video_brief_start 传的 topic。',
    },
  },
  required: ['answers'],
  additionalProperties: false,
};

const CONFIRM_OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    ready: { type: 'boolean' },
    stillMissing: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    changed: { type: 'array', items: { type: 'string' } },
    ignored: { type: 'array' },
    written: { type: 'boolean' },
    idempotent: { type: 'boolean' },
    round: { type: 'number' },
    maxRounds: { type: 'number' },
    roundsLeft: { type: 'number' },
    rejected: { type: 'array', items: { type: 'string' }, description: '非法槽位名（整批未写入）' },
    allowed: { type: 'array', items: { type: 'string' } },
    next_step: { type: 'string' },
    stage: { type: 'string', description: '本次写回后的阶段（部分答案 → clarify；满 10 项 → style）' },
    error: { type: 'string' },
  },
  additionalProperties: true,
};

const REFERENCE_REGISTER_PARAMETERS = {
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description: '参考图 / 样片的路径清单，必须是工程内的相对路径（例如 refs/style-1.png）。只登记路径与数量，不复制文件。',
    },
    note: { type: 'string', description: '可选备注：这批图是画风参考还是构图 / 节奏参考。' },
  },
  required: ['paths'],
  additionalProperties: false,
};

const REFERENCE_SKIP_PARAMETERS = {
  type: 'object',
  properties: {
    reason: { type: 'string', description: '可选：用户为什么没有参考（例如「没找到合适的」「不想被参考限制」）。' },
  },
  additionalProperties: false,
};

const REFERENCE_OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    count: { type: 'number', description: '已登记的参考素材数量' },
    paths: { type: 'array', items: { type: 'string' }, description: '当前 brief 里的参考路径清单' },
    note: { type: 'string' },
    state: { type: 'string', enum: ['provided', 'explicit-none', 'missing'] },
    reference: { type: 'object', description: 'referenceStatus(brief) 的完整结果：{ state, count? }' },
    reason: { type: 'string' },
    written: { type: 'boolean' },
    idempotent: { type: 'boolean' },
    ready: { type: 'boolean' },
    stillMissing: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    stage: { type: 'string' },
    next_step: { type: 'string' },
    rejected: { type: 'array', items: { type: 'string' }, description: '被拒绝的路径（越界 / 绝对路径 / 空串）' },
    error: { type: 'string' },
    hint: { type: 'string' },
  },
  additionalProperties: true,
};

const STAGE_GET_OUTPUT = {
  type: 'object',
  properties: {
    stage: { type: 'string', enum: STAGES },
    since: { type: 'string' },
    briefReady: { type: 'boolean' },
    briefFilled: { type: 'number' },
    briefTotal: { type: 'number' },
    missing: { type: 'array', items: { type: 'string' } },
    missingTitles: { type: 'array', items: { type: 'string' } },
    scriptReady: { type: 'boolean', description: 'script.json 存在且结构合法（草稿就绪）' },
    scriptConfirmed: { type: 'boolean', description: 'script.json confirmed === true' },
    scriptDraftCount: { type: 'number', description: '脚本改过几稿' },
    scriptMissing: { type: 'boolean', description: '没有 script.json（历史工程为 true）' },
    script: { description: '脚本摘要（title / 镜头数 / 总时长 / 确认时间）；没有时为 null' },
    styleConfirmed: { type: 'boolean' },
    style: { description: '已确认的 style.json 摘要；未确认时为 null' },
    nextStep: { type: 'string' },
    blocked: { type: 'array', items: { type: 'string' } },
    history: { type: 'array' },
    healed: { type: 'boolean', description: '本次读取是否发生了「状态领先事实」的自愈回落' },
    error: { type: 'string' },
  },
  additionalProperties: true,
};

const STAGE_ADVANCE_PARAMETERS = {
  type: 'object',
  properties: {
    to: { type: 'string', enum: STAGES, description: '目标阶段。只能前进：idle → clarify → script → style → locked → build。' },
    force: { type: 'boolean', description: '跳级必须传 true；history 里会标记 forced。force 不能越过事实（brief 没满 / 脚本没确认 / 风格没确认照样拒绝）。' },
  },
  required: ['to'],
  additionalProperties: false,
};

const STAGE_ADVANCE_OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    changed: { type: 'boolean' },
    from: { type: 'string' },
    to: { type: 'string' },
    stage: { type: 'string' },
    forced: { type: 'boolean' },
    jump: { type: 'boolean' },
    history: { type: 'array' },
    nextStep: { type: 'string' },
    code: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: true,
};

const STYLE_CONFIRM_PARAMETERS = {
  type: 'object',
  properties: {
    spec: {
      type: 'object',
      description: '风格五件套，缺一不可。',
      properties: {
        tone: { type: 'string', description: '一句调性描述，例如「克制、专业，不喊口号」' },
        palette: { type: 'array', items: { type: 'string' }, description: '1..12 个十六进制颜色，例如 ["#0B0B0F", "#7C5CFF"]' },
        font: { type: 'string', description: '字体 / 字族，例如「思源黑体 Medium」' },
        density: { type: 'string', enum: ['low', 'med', 'high'], description: '画面信息密度' },
        pace: { type: 'number', description: '秒 / 镜头，>0 且 ≤60；例如 2.5' },
      },
      required: ['tone', 'palette', 'font', 'density', 'pace'],
      additionalProperties: false,
    },
    preview: {
      type: 'object',
      description: '可选：已生成的预览产物，只记录相对路径，不在这里渲染。',
      properties: {
        keyframes: { type: 'array', items: { type: 'string' }, description: '最多 4 张关键帧，相对工程根的路径' },
        clip: { type: 'string', description: '8 秒预览片，相对工程根的 .mp4 路径' },
      },
      additionalProperties: false,
    },
  },
  required: ['spec'],
  additionalProperties: false,
};

const STYLE_CONFIRM_OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    style: { type: 'object' },
    stage: { type: 'string' },
    confirmedAt: { type: 'string' },
    history: { type: 'array' },
    nextStep: { type: 'string' },
    code: { type: 'string' },
    errors: { type: 'array', items: { type: 'string' } },
    error: { type: 'string' },
  },
  additionalProperties: true,
};

const STYLE_READ_OUTPUT = {
  type: 'object',
  properties: {
    style: { description: 'style.json 内容；不存在 / 未确认 / 不合法时为 null' },
    exists: { type: 'boolean' },
    corrupt: { type: 'boolean' },
    backup: { type: 'string' },
    stage: { type: 'string' },
    nextStep: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: true,
};

const SCRIPT_DRAFT_PARAMETERS = {
  type: 'object',
  properties: {
    projectId: {
      type: 'string',
      description: '可选：工程 id（保留字段，便于跨插件调用）；省略时用当前会话绑定的工程根。',
    },
    script: {
      type: 'object',
      description: '分镜脚本：{ title, logline, duration, shots:[{ no, time:{start,duration}, visual, narration, onScreenText, transition }] }。time 单位是秒，镜头必须首尾相接。',
      properties: {
        title: { type: 'string', description: '片子标题' },
        logline: { type: 'string', description: '一句话讲清这条片子' },
        duration: { type: 'number', description: '总时长（秒）；省略时按各镜 duration 求和' },
        shots: {
          type: 'array',
          description: '分镜列表，至少 1 镜；每镜的 time.start 必须等于上一镜的 start+duration（不重叠、不断档）',
          items: {
            type: 'object',
            properties: {
              no: { type: 'number', description: '镜号（从 1 开始）' },
              time: {
                type: 'object',
                properties: {
                  start: { type: 'number', description: '起点（秒，≥0）' },
                  duration: { type: 'number', description: '时长（秒，必须 >0）' },
                },
                required: ['start', 'duration'],
                additionalProperties: false,
              },
              visual: { type: 'string', description: '画面：这一镜看到什么' },
              narration: { type: 'string', description: '旁白 / 口播（可为空，但 onScreenText 不能也为空）' },
              onScreenText: { type: 'string', description: '屏上文字（可为空，但 narration 不能也为空）' },
              transition: { type: 'string', description: '转场，例如「硬切」「叠化 0.3s」' },
            },
            required: ['time', 'visual'],
            additionalProperties: true,
          },
        },
      },
      required: ['shots'],
      additionalProperties: true,
    },
  },
  required: ['script'],
  additionalProperties: false,
};

const SCRIPT_DRAFT_OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    written: { type: 'boolean' },
    idempotent: { type: 'boolean', description: '内容与上一稿相同，没有写盘、draftCount 未累加' },
    script: { description: '归一化后的脚本（校验通过时才有）' },
    summary: {
      type: 'object',
      properties: {
        shotCount: { type: 'number' },
        totalDuration: { type: 'number' },
        declaredDuration: { type: 'number' },
      },
    },
    problems: {
      type: 'array',
      description: '校验问题；非空时**没有写盘**',
      items: {
        type: 'object',
        properties: {
          shot: { type: 'number', description: '镜号（0 = 整份脚本）' },
          field: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
    draftCount: { type: 'number' },
    confirmed: { type: 'boolean' },
    stage: { type: 'string' },
    nextStep: { type: 'string' },
    code: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: true,
};

const SCRIPT_READ_OUTPUT = {
  type: 'object',
  properties: {
    script: { description: 'script.json 内容；不存在 / 损坏 / 校验失败时为 null' },
    confirmed: { type: 'boolean' },
    confirmedAt: { type: 'string', description: '上次确认时间；未确认时为 null' },
    exists: { type: 'boolean' },
    corrupt: { type: 'boolean' },
    invalid: { type: 'boolean' },
    backup: { type: 'string' },
    draftCount: { type: 'number' },
    shotCount: { type: 'number' },
    totalDuration: { type: 'number' },
    scriptMissing: { type: 'boolean' },
    stage: { type: 'string' },
    nextStep: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: true,
};

const SCRIPT_CONFIRM_PARAMETERS = {
  type: 'object',
  properties: {
    projectId: {
      type: 'string',
      description: '可选：工程 id（保留字段）；省略时用当前会话绑定的工程根。',
    },
    note: { type: 'string', description: '可选：用户确认时的原话或备注，写进 script.json 便于回看。' },
  },
  additionalProperties: false,
};

const SCRIPT_CONFIRM_OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    written: { type: 'boolean' },
    idempotent: { type: 'boolean' },
    script: { type: 'object' },
    confirmed: { type: 'boolean' },
    confirmedAt: { type: 'string' },
    stage: { type: 'string' },
    history: { type: 'array' },
    nextStep: { type: 'string' },
    code: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: true,
};

/** 把 agent 上的标识压成注册表键。 */
function agentKey(root, agent) {
  return `${root}::${agent?.id ?? agent?.session?.id ?? ''}`;
}

/**
 * 参考素材路径必须是工程内的相对路径：
 * 不接受绝对路径、盘符路径、UNC，也不接受用 `..` 跳出工程根。
 * 通过时统一成 `/` 分隔（落盘后跨平台可读）。
 * @returns {string|null} 归一化后的相对路径；不合法返回 null。
 */
function normalizeReferencePath(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  if (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('//')) return null;
  if (path.isAbsolute(text)) return null;
  const parts = text.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.includes('..')) return null;
  return parts.join('/');
}

/**
 * 创建工具定义。
 * @param {{
 *   config: () => object,
 *   storeFor: (root: string) => object,
 *   stateStoreFor: (root: string) => object,
 *   styleStoreFor: (root: string) => object,
 *   stage?: object,
 *   workspaceRoot: (agent: any) => string,
 *   memoryPath?: () => string,
 *   log?: (message: string, level?: string) => void,
 * }} deps
 */
export function createVideoBriefTools(deps) {
  const topics = new Map();
  const stageService = deps.stage;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

  const startTool = {
    name: 'video_brief_start',
    description:
      '视频任务开工前的简报判定（dsh-video-brief 插件）。读 <工程根>/.dsh-video/brief.json，返回 verdict=ready 就直接开工；返回 needs-answers 就把 missing 里的问题一次问完（≤3 条），再用 video_brief_confirm 写回答案。10 个槽位缺一不可。参考素材（reference）有固定提问，原样问用户；用户说没有参考时用 video_reference_skip 显式登记，不要默认略过。',
    parameters: START_PARAMETERS,
    output: textOutput(START_OUTPUT),
    isConcurrencySafe: () => true,
    async execute(rawArgs, exec) {
      const args = rawArgs ?? {};
      const config = deps.config();
      const root = deps.workspaceRoot(exec?.agent);
      const mode = args.mode === 'drift' ? 'drift' : 'new';
      const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
      const store = deps.storeFor(root);
      const read = await store.read();
      const evaluation = evaluateBrief({
        brief: read.brief,
        slots: config.slots,
        maxQuestions: config.maxQuestions,
        maxRounds: config.maxRounds,
      });

      const key = agentKey(root, exec?.agent);
      if (topic !== '') topics.set(key, topic);
      const effectiveTopic = topic !== '' ? topic : topics.get(key) ?? read.brief.topic;

      let memoryContext = [];
      if (config.memoryEnabled) {
        try {
          const preferences = await loadPreferences({ file: deps.memoryPath?.() });
          memoryContext = pickRelatedPreferences(preferences, effectiveTopic);
        } catch (error) {
          deps.log?.(`读取全局偏好失败（忽略）：${(error && error.message) || error}`, 'warn');
        }
      }

      const payload = {
        verdict: evaluation.verdict,
        ready: evaluation.ready,
        filled: evaluation.filled,
        missing: evaluation.missing,
        missing_total: evaluation.missingAll.length,
        filled_count: evaluation.filledCount,
        slots_total: evaluation.total,
        round: evaluation.round,
        maxRounds: evaluation.maxRounds,
        memory_context: memoryContext,
        transcript_hint: TRANSCRIPT_HINT,
        mode,
      };
      if (mode === 'drift') {
        payload.drift = driftReport({ brief: read.brief, topic: effectiveTopic, slots: config.slots });
      }
      if (read.corrupt) {
        payload.brief_corrupt = true;
        if (read.backup) payload.brief_backup = read.backup;
        payload.hint = 'brief.json 解析失败，已备份成 .bak 并按空简报继续；重新 confirm 一遍即可重建。';
      } else if (!evaluation.ready && evaluation.round >= evaluation.maxRounds) {
        payload.hint = `已经问满 ${evaluation.maxRounds} 轮：不要再挤，把剩下的 ${evaluation.missingAll.length} 项一次问完。注意轮数到顶也不会自动放行——10 个槽位缺一不可。`;
      }
      return payload;
    },
  };

  const confirmTool = {
    name: 'video_brief_confirm',
    description:
      '把用户回答过的槽位写进 <工程根>/.dsh-video/brief.json（dsh-video-brief 插件）。answers 里只放有答案的槽位；空串视为未填；未知槽位名整批拒绝且不写盘。全部 10 个槽位填满才返回 ready=true，并自动把阶段从 idle 推到 clarify（部分）或 style（满 10 项）。',
    parameters: CONFIRM_PARAMETERS,
    output: textOutput(CONFIRM_OUTPUT),
    isConcurrencySafe: () => false,
    async execute(rawArgs, exec) {
      const args = rawArgs ?? {};
      const config = deps.config();
      const root = deps.workspaceRoot(exec?.agent);
      const store = deps.storeFor(root);
      const answers = args.answers;
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
        return { ok: false, error: 'answers 必须是对象：{ slot: value, ... }' };
      }

      const current = await store.read();
      const ids = slotIdSet(config.slots);
      const rejected = Object.keys(answers).filter((key) => !ids.has(key));
      if (rejected.length > 0) {
        const preview = evaluateBrief({
          brief: current.brief,
          slots: config.slots,
          maxQuestions: 9999,
          maxRounds: config.maxRounds,
        });
        return {
          ok: false,
          error: 'unknown-slot',
          rejected,
          allowed: [...ids],
          ready: preview.ready,
          stillMissing: preview.missingAll.map((item) => item.slot),
          summary: buildSummary({ brief: current.brief, slots: config.slots }),
          written: false,
          next_step: `槽位名必须是这些之一：${[...ids].join(' / ')}。整批没有写盘，改对名字再调用一次。`,
        };
      }

      const key = agentKey(root, exec?.agent);
      const topicArg = typeof args.topic === 'string' ? args.topic.trim() : '';
      const topic = topicArg !== '' ? topicArg : topics.get(key) ?? '';

      const result = await store.update((prev) => {
        const merged = mergeAnswers({
          brief: prev,
          answers,
          slots: config.slots,
          maxRounds: config.maxRounds,
        });
        if (merged.unknown.length > 0) return { skip: true, merged, brief: prev };
        const nextTopic = topic !== '' ? topic : prev.topic;
        const next = { ...merged.brief, topic: nextTopic };
        if (merged.changed.length === 0 && nextTopic === prev.topic) {
          return { skip: true, merged, brief: prev, next };
        }
        return { brief: next, merged };
      });

      const merged = result.merged ?? mergeAnswers({ brief: current.brief, answers, slots: config.slots });
      const finalBrief = normalizeBrief(result.written ? result.brief : { ...merged.brief, topic: topic || merged.brief.topic }, { slots: config.slots });
      const evaluation = evaluateBrief({
        brief: finalBrief,
        slots: config.slots,
        maxQuestions: 9999,
        maxRounds: config.maxRounds,
      });

      const payload = {
        ok: true,
        ready: evaluation.ready,
        stillMissing: evaluation.missingAll.map((item) => item.slot),
        summary: buildSummary({ brief: finalBrief, slots: config.slots }),
        changed: merged.changed,
        ignored: merged.ignored,
        written: result.written === true,
        round: finalBrief.round,
        maxRounds: evaluation.maxRounds,
        roundsLeft: Math.max(0, evaluation.maxRounds - finalBrief.round),
      };
      if (!result.written) payload.idempotent = true;
      if (!evaluation.ready) {
        payload.next_step = `还缺 ${evaluation.missingAll.length} 项（${evaluation.missingAll.slice(0, 3).map((item) => item.title).join('、')}…）：一次问完再 confirm；不要为了凑数填"随便/都行"。`;
      }
      if (stageService) {
        try {
          const state = await stageService.bumpAfterBrief(root);
          payload.stage = state.stage;
        } catch (error) {
          deps.log?.(`brief 写回后推进阶段失败（忽略）：${(error && error.message) || error}`, 'warn');
        }
      }
      return payload;
    },
  };

  const referenceRegisterTool = {
    name: 'video_reference_register',
    description:
      '登记参考图 / 样片（dsh-video-brief 插件）。只把路径与数量写进 <工程根>/.dsh-video/brief.json，不复制文件、不读文件内容、不做图像分析。paths 必须是工程内的相对路径（绝对路径与 ../ 越界会被拒，整批有合法项时只写合法项）；重复路径自动去重，多次调用与已有清单合并。登记成功后 reference 槽位算已填，但其余 9 项齐了才 ready。',
    parameters: REFERENCE_REGISTER_PARAMETERS,
    output: textOutput(REFERENCE_OUTPUT),
    isConcurrencySafe: () => false,
    async execute(rawArgs, exec) {
      const args = rawArgs ?? {};
      const config = deps.config();
      const root = deps.workspaceRoot(exec?.agent);
      const store = deps.storeFor(root);
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      const rawPaths = Array.isArray(args.paths) ? args.paths : [];
      if (rawPaths.length === 0) {
        return {
          ok: false,
          error: 'empty-paths',
          count: 0,
          paths: [],
          hint: 'paths 至少给 1 条：参考图 / 样片的相对路径。',
        };
      }
      const rejected = [];
      const safe = [];
      for (const raw of rawPaths) {
        const normalized = normalizeReferencePath(raw);
        if (normalized === null) {
          rejected.push(typeof raw === 'string' ? raw : String(raw));
          continue;
        }
        if (!safe.includes(normalized)) safe.push(normalized);
      }
      if (safe.length === 0) {
        return {
          ok: false,
          error: 'path-not-allowed',
          count: 0,
          paths: [],
          rejected,
          hint: '参考路径必须是工程内的相对路径：不能是绝对路径 / 盘符路径，也不能用 .. 跳出工程根。整批没有写盘。',
        };
      }

      const result = await store.update((prev) => {
        const current = normalizeBrief(prev, { slots: config.slots });
        const existing = current.slots.reference;
        const existingPaths = existing && typeof existing === 'object' && Array.isArray(existing.paths)
          ? existing.paths
          : [];
        const mergedPaths = [...new Set([...existingPaths, ...safe])];
        const value = { kind: 'references', paths: mergedPaths };
        const keptNote = note !== ''
          ? note
          : (existing && typeof existing === 'object' && typeof existing.note === 'string' ? existing.note : '');
        if (keptNote !== '') value.note = keptNote;
        const merged = mergeAnswers({
          brief: current,
          answers: { reference: value },
          slots: config.slots,
          maxRounds: config.maxRounds,
        });
        if (merged.changed.length === 0) return { skip: true, brief: prev, merged };
        return { brief: merged.brief, merged };
      });

      const finalBrief = normalizeBrief(result.brief, { slots: config.slots });
      const status = referenceStatus(finalBrief, config.slots);
      const finalValue = finalBrief.slots.reference;
      const finalPaths = finalValue && typeof finalValue === 'object' && Array.isArray(finalValue.paths)
        ? finalValue.paths
        : [];
      const evaluation = evaluateBrief({
        brief: finalBrief,
        slots: config.slots,
        maxQuestions: 9999,
        maxRounds: config.maxRounds,
      });
      const payload = {
        ok: true,
        count: finalPaths.length,
        paths: finalPaths,
        state: status.state,
        reference: status,
        written: result.written === true,
        ready: evaluation.ready,
        stillMissing: evaluation.missingAll.map((item) => item.slot),
        summary: buildSummary({ brief: finalBrief, slots: config.slots }),
      };
      if (rejected.length > 0) payload.rejected = rejected;
      if (note !== '') payload.note = note;
      if (!result.written) payload.idempotent = true;
      if (!evaluation.ready) {
        payload.next_step = `还缺 ${evaluation.missingAll.length} 项（${evaluation.missingAll.slice(0, 3).map((item) => item.title).join('、')}…）：一次问完再 confirm；参考素材已经登记 ${finalPaths.length} 个。`;
      }
      if (stageService) {
        try {
          const state = await stageService.bumpAfterBrief(root);
          payload.stage = state.stage;
        } catch (error) {
          deps.log?.(`登记参考素材后推进阶段失败（忽略）：${(error && error.message) || error}`, 'warn');
        }
      }
      return payload;
    },
  };

  const referenceSkipTool = {
    name: 'video_reference_skip',
    description:
      '显式登记「无参考」（dsh-video-brief 插件）。只有用户明确说过没有参考图 / 样片时才调用，不要替用户默认跳过。写 <工程根>/.dsh-video/brief.json 的 reference 槽位（{ skipped: true, reason? }），算已填，摘要会标注「（用户确认无参考）」；但它不是 ready 捷径——其余 9 项仍要齐。',
    parameters: REFERENCE_SKIP_PARAMETERS,
    output: textOutput(REFERENCE_OUTPUT),
    isConcurrencySafe: () => false,
    async execute(rawArgs, exec) {
      const args = rawArgs ?? {};
      const config = deps.config();
      const root = deps.workspaceRoot(exec?.agent);
      const store = deps.storeFor(root);
      const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
      const value = reason === '' ? { skipped: true } : { skipped: true, reason };

      const result = await store.update((prev) => {
        const current = normalizeBrief(prev, { slots: config.slots });
        const merged = mergeAnswers({
          brief: current,
          answers: { reference: value },
          slots: config.slots,
          maxRounds: config.maxRounds,
        });
        if (merged.changed.length === 0) return { skip: true, brief: prev, merged };
        return { brief: merged.brief, merged };
      });

      const finalBrief = normalizeBrief(result.brief, { slots: config.slots });
      const status = referenceStatus(finalBrief, config.slots);
      const evaluation = evaluateBrief({
        brief: finalBrief,
        slots: config.slots,
        maxQuestions: 9999,
        maxRounds: config.maxRounds,
      });
      const payload = {
        ok: true,
        state: status.state,
        reference: status,
        written: result.written === true,
        ready: evaluation.ready,
        stillMissing: evaluation.missingAll.map((item) => item.slot),
        summary: buildSummary({ brief: finalBrief, slots: config.slots }),
      };
      if (reason !== '') payload.reason = reason;
      if (!result.written) payload.idempotent = true;
      if (status.state !== 'explicit-none') {
        payload.error = `参考素材没有登记成「无参考」（当前 ${status.state}），请重试或用 video_reference_register 登记路径。`;
      }
      if (!evaluation.ready) {
        payload.next_step = `「无参考」只是这一项答了，不能当 ready 捷径：还缺 ${evaluation.missingAll.length} 项（${evaluation.missingAll.slice(0, 3).map((item) => item.title).join('、')}…），继续问完再 confirm。`;
      }
      if (stageService) {
        try {
          const state = await stageService.bumpAfterBrief(root);
          payload.stage = state.stage;
        } catch (error) {
          deps.log?.(`登记无参考后推进阶段失败（忽略）：${(error && error.message) || error}`, 'warn');
        }
      }
      return payload;
    },
  };

  const stageGetTool = {
    name: 'video_stage_get',
    description:
      '读当前视频工程的阶段机状态（dsh-video-brief 插件）：stage / briefReady / scriptReady / scriptConfirmed / styleConfirmed / nextStep / blocked / history。任何阶段都可调用；读取时会按 brief、脚本与风格的事实自愈「阶段领先于事实」的矛盾。历史工程（有 style.json 但没 script.json）会返回 scriptMissing:true，阶段不会被收回，nextStep 提示先补脚本。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput(STAGE_GET_OUTPUT),
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      if (!stageService) return { error: '阶段服务未装配' };
      const root = deps.workspaceRoot(exec?.agent);
      const snap = await stageService.snapshot(root);
      const { facts, state } = snap;
      return {
        stage: state.stage,
        since: state.since,
        briefReady: facts.briefReady,
        briefFilled: facts.briefFilled,
        briefTotal: facts.briefTotal,
        missing: facts.missing,
        missingTitles: facts.missingTitles,
        scriptReady: facts.scriptReady,
        scriptConfirmed: facts.scriptConfirmed,
        scriptDraftCount: facts.scriptDraftCount,
        scriptMissing: facts.scriptMissing,
        script: scriptSummary(facts.script),
        styleConfirmed: facts.styleConfirmed,
        style: facts.style
          ? {
            tone: facts.style.spec?.tone,
            palette: facts.style.spec?.palette,
            font: facts.style.spec?.font,
            density: facts.style.spec?.density,
            pace: facts.style.spec?.pace,
            confirmedAt: facts.style.confirmedAt,
            confirmedBy: facts.style.confirmedBy,
          }
          : null,
        nextStep: nextStepFor(state.stage, facts),
        blocked: blockedFor(state.stage, facts),
        history: state.history,
        healed: snap.healed === true,
      };
    },
  };

  const stageAdvanceTool = {
    name: 'video_stage_advance',
    description:
      '推进视频工程阶段（dsh-video-brief 插件）。只能前进：idle → clarify → script → style → locked → build；跳级要 force:true 并在 history 标记 forced；倒退一律拒绝。事实不够（brief 没满 / 脚本没确认 / 风格没确认）时 force 也推不动。build 也可以由 locked 阶段第一次写操作自动进入。',
    parameters: STAGE_ADVANCE_PARAMETERS,
    output: textOutput(STAGE_ADVANCE_OUTPUT),
    isConcurrencySafe: () => false,
    async execute(rawArgs, exec) {
      if (!stageService) return { ok: false, error: '阶段服务未装配', stage: 'idle' };
      const args = rawArgs ?? {};
      if (!isStage(args.to)) {
        return {
          ok: false,
          code: 'bad-stage',
          error: `to 必须是 ${STAGES.join(' / ')} 之一。`,
          stage: 'idle',
        };
      }
      const root = deps.workspaceRoot(exec?.agent);
      const result = await stageService.advance(root, {
        to: args.to,
        force: args.force === true,
        by: 'tool',
      });
      return result;
    },
  };

  const styleReadTool = {
    name: 'video_style_read',
    description:
      '读 <工程根>/.dsh-video/style.json（dsh-video-brief 插件）。返回 style 对象；文件不存在、未确认或 spec 不合法时返回 null。只读，不渲染。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput(STYLE_READ_OUTPUT),
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      if (!stageService) return { style: null, exists: false, corrupt: false, error: '阶段服务未装配' };
      const root = deps.workspaceRoot(exec?.agent);
      const read = await stageService.readStyle(root);
      const snap = await stageService.snapshot(root);
      return {
        style: read.style ?? null,
        exists: read.exists,
        corrupt: read.corrupt,
        ...(read.backup ? { backup: read.backup } : {}),
        stage: snap.state.stage,
        nextStep: nextStepFor(snap.state.stage, snap.facts),
      };
    },
  };

  const styleConfirmTool = {
    name: 'video_style_confirm',
    description:
      '确认并写入视频风格（dsh-video-brief 插件）：spec 五件套（tone / palette / font / density / pace）缺一不可，preview 可选（4 张关键帧 + 8 秒 mp4 的相对路径）。写 <工程根>/.dsh-video/style.json，confirmed=true，阶段自动进 locked。不在这里渲染任何帧或视频。',
    parameters: STYLE_CONFIRM_PARAMETERS,
    output: textOutput(STYLE_CONFIRM_OUTPUT),
    isConcurrencySafe: () => false,
    async execute(rawArgs, exec) {
      if (!stageService) return { ok: false, error: '阶段服务未装配' };
      const args = rawArgs ?? {};
      const built = buildStyle({ spec: args.spec, preview: args.preview, now: now() });
      if (!built.ok) {
        return {
          ok: false,
          code: 'invalid-style',
          errors: built.errors,
          error: `风格没写盘：${built.errors.join('；')}`,
        };
      }
      const root = deps.workspaceRoot(exec?.agent);
      const result = await stageService.confirmStyle(root, built.style);
      return result;
    },
  };

  const scriptDraftTool = {
    name: 'video_script_draft',
    description:
      '写入 / 更新视频分镜脚本草稿（dsh-video-brief 插件），存 <工程根>/.dsh-video/script.json。script 必须是 { title, logline, duration, shots:[{ no, time:{start,duration}, visual, narration, onScreenText, transition }] }；shots 至少 1 镜，时间单位秒且必须首尾相接。返回结构化校验结果：时长为 0/负数、时间重叠/断档、缺 visual、narration 与 onScreenText 都缺（空镜）都会逐条报出，**校验失败不写盘**。改动会让 confirmed 重置为 false、draftCount 累加；内容没变的重复调用是幂等的。写完要把每一条逐条给用户看，等用户明确同意后再 video_script_confirm。brief 没满时拒绝。',
    parameters: SCRIPT_DRAFT_PARAMETERS,
    output: textOutput(SCRIPT_DRAFT_OUTPUT),
    isConcurrencySafe: () => false,
    async execute(rawArgs, exec) {
      if (!stageService) return { ok: false, error: '阶段服务未装配' };
      const args = rawArgs ?? {};
      const root = deps.workspaceRoot(exec?.agent);
      return stageService.saveScriptDraft(root, args.script);
    },
  };

  const scriptReadTool = {
    name: 'video_script_read',
    description:
      '读 <工程根>/.dsh-video/script.json（dsh-video-brief 插件）：脚本内容、是否已确认、上次确认时间、第几稿。文件不存在 / 损坏 / 校验失败时返回 { script:null, confirmed:false }，不抛错。只读。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput(SCRIPT_READ_OUTPUT),
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      if (!stageService) return { script: null, confirmed: false, exists: false, error: '阶段服务未装配' };
      const root = deps.workspaceRoot(exec?.agent);
      const read = await stageService.readScript(root);
      const snap = await stageService.snapshot(root);
      const script = read.script ?? null;
      const summary = scriptSummary(script);
      return {
        script,
        confirmed: Boolean(script && script.confirmed === true),
        confirmedAt: script?.confirmedAt ?? null,
        exists: read.exists,
        corrupt: read.corrupt,
        invalid: read.invalid,
        ...(read.backup ? { backup: read.backup } : {}),
        draftCount: script ? Number(script.draftCount) || 0 : 0,
        shotCount: summary?.shotCount ?? 0,
        totalDuration: summary?.totalDuration ?? 0,
        scriptMissing: !read.exists,
        stage: snap.state.stage,
        nextStep: nextStepFor(snap.state.stage, snap.facts),
      };
    },
  };

  const scriptConfirmTool = {
    name: 'video_script_confirm',
    description:
      '用户确认脚本（dsh-video-brief 插件）：把 <工程根>/.dsh-video/script.json 的 confirmed 写成 true 并记 confirmedAt，阶段自动从 script 推进到 style。只能在用户明确说「可以 / 确认 / 没问题」之后调用；agent 自己不能替用户点头。脚本草稿不存在 / brief 没满时拒绝；重复确认是幂等的。不渲染任何帧或视频。',
    parameters: SCRIPT_CONFIRM_PARAMETERS,
    output: textOutput(SCRIPT_CONFIRM_OUTPUT),
    isConcurrencySafe: () => false,
    async execute(rawArgs, exec) {
      if (!stageService) return { ok: false, error: '阶段服务未装配' };
      const args = rawArgs ?? {};
      const root = deps.workspaceRoot(exec?.agent);
      return stageService.confirmScript(root, { note: args.note });
    },
  };

  const definitions = [startTool, confirmTool, referenceRegisterTool, referenceSkipTool];
  if (stageService) {
    definitions.push(
      stageGetTool,
      stageAdvanceTool,
      scriptDraftTool,
      scriptReadTool,
      scriptConfirmTool,
      styleConfirmTool,
      styleReadTool,
    );
  }
  return definitions;
}
