/**
 * 六阶段状态机：idle → clarify → script → style → locked → build。
 *
 * 这一层分两半：
 * 1. **纯函数**（normalize / factsStage / reconcile / evaluateAdvance / nextStep / blocked）——
 *    不读盘，能直接单测；
 * 2. **服务**（createStageService）—— 把 brief/script/style/state 四个 store 和事实判定缝在一起，
 *    供工具与门禁调用。
 *
 * 为什么 stage 既要存、又要按事实校正：
 * - 前五个阶段（idle/clarify/script/style/locked）可以由 brief + script + style 的事实推出来；
 * - build 推不出来（"开始生产"是一个动作，不是文件状态），所以必须落盘；
 * - 存下来的 stage 一旦**领先于事实**（例如 brief 只剩 9 项但 state 说 locked），
 *   读的时候回落到事实允许的最高阶段，并写进 history —— 这就是自愈。
 * 详细规则见 README「状态与事实的一致性」。
 *
 * 历史工程兼容：已有 style.json（甚至 state=locked/build）但没有 script.json 的工程，
 * 阶段**不会被收回**；只在 video_stage_get 里标 scriptMissing 并提示先补脚本。
 */

import { evaluateBrief } from './brief.mjs';
import { buildScriptConfirmation, buildScriptDraft, scriptSummary } from './script.mjs';

/** 阶段顺序即合法前进方向。script 是 0.3.0 新增的环节，排在 style 之前。 */
export const STAGES = ['idle', 'clarify', 'script', 'style', 'locked', 'build'];

/** 给中文文案用的阶段说明。 */
export const STAGE_LABELS = {
  idle: 'idle（还没开始）',
  clarify: 'clarify（补 brief）',
  script: 'script（写脚本）',
  style: 'style（定风格）',
  locked: 'locked（可改时间线）',
  build: 'build（生产 / 导出）',
};

/** 阶段名是否合法。 */
export function isStage(value) {
  return typeof value === 'string' && STAGES.includes(value);
}

/** 阶段下标；非法一律 -1。 */
export function stageIndex(value) {
  return STAGES.indexOf(value);
}

/** 毫秒 → ISO；非法值用 current。 */
function iso(now) {
  const value = Number.isFinite(now) ? now : Date.now();
  return new Date(value).toISOString();
}

/** 空状态：idle，无历史。 */
export function emptyStageState(now = Date.now()) {
  return { stage: 'idle', since: iso(now), history: [] };
}

/**
 * 把任意来源的数据补成合法 state。
 * 坏结构 → idle；未知阶段 → idle；history 里的坏条目直接丢掉。
 */
export function normalizeStageState(raw, now = Date.now()) {
  const base = emptyStageState(now);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const stage = isStage(raw.stage) ? raw.stage : 'idle';
  const since = typeof raw.since === 'string' && raw.since.trim() !== '' ? raw.since : base.since;
  const history = [];
  if (Array.isArray(raw.history)) {
    for (const entry of raw.history) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      if (!isStage(entry.stage)) continue;
      const at = typeof entry.at === 'string' && entry.at.trim() !== '' ? entry.at : since;
      const item = { stage: entry.stage, at, by: entry.by === 'user' ? 'user' : 'tool' };
      if (entry.forced === true) item.forced = true;
      if (entry.jump === true) item.jump = true;
      if (typeof entry.reason === 'string' && entry.reason !== '') item.reason = entry.reason;
      if (isStage(entry.from)) item.from = entry.from;
      history.push(item);
    }
  }
  return { stage, since, history };
}

/**
 * 事实允许的最高阶段（build 不算：build 是动作，不是事实）。
 *
 * 规则（与 README 一致）：
 * - brief 10/10 且风格已确认 → locked（**不要求 scriptConfirmed**：历史工程兼容，
 *   已经有 style.json 的老工程不能被 script 缺失收回 locked/build）
 * - brief 10/10 且脚本已确认 → style
 * - brief 10/10 或脚本草稿已存在 → script
 * - 风格已确认（brief 后来退项）→ style
 * - brief 有 1..9 项 → clarify
 * - 其余 → idle
 *
 * `styleConfirmed` 单独成立时仍然给 style：风格一旦被用户确认过，
 * 就不因为 brief 后来退项而作废；但这时只能停在 style 补 brief，不能进 locked。
 */
export function factsStage(facts = {}) {
  if (facts.briefReady === true && facts.styleConfirmed === true) return 'locked';
  if (facts.briefReady === true && facts.scriptConfirmed === true) return 'style';
  if (facts.briefReady === true || facts.scriptReady === true) return 'script';
  if (facts.styleConfirmed === true) return 'style';
  if (Number(facts.briefFilled) > 0) return 'clarify';
  return 'idle';
}

/** 回落并记 history。 */
function heal(state, to, now) {
  if (to === state.stage) return { state, healed: false, ceiling: to };
  const at = iso(now);
  const next = {
    stage: to,
    since: at,
    history: [
      ...state.history,
      { stage: to, at, by: 'tool', reason: 'self-heal', from: state.stage },
    ],
  };
  return { state: next, healed: true, from: state.stage, ceiling: to };
}

/**
 * 自愈：stage 只能落后于事实，不能领先于事实。
 * - build 需要 brief 10/10 + 风格已确认，否则回落；
 * - 其余阶段超过事实允许的上限就回落到上限。
 *
 * 落后（例如 state 还是 idle 但 brief 已经满了）不在这里自动补 ——
 * 那应该由 brief_confirm / style_confirm / stage_advance 明确推进。
 *
 * @returns {{state: object, healed: boolean, from?: string, ceiling: string}}
 */
export function reconcileStageState(raw, facts = {}, now = Date.now()) {
  const state = normalizeStageState(raw, now);
  const ceiling = factsStage(facts);
  if (state.stage === 'build') {
    if (facts.briefReady === true && facts.styleConfirmed === true) {
      return { state, healed: false, ceiling };
    }
    return heal(state, ceiling, now);
  }
  if (stageIndex(state.stage) > stageIndex(ceiling)) return heal(state, ceiling, now);
  return { state, healed: false, ceiling };
}

/**
 * 前进判定的纯函数。
 *
 * - 合法阶段名；
 * - 只能前进（同阶段 = no-op）；
 * - 跳级必须 force:true；
 * - 目标阶段的事实前提必须成立（force 不能越过事实）。
 *
 * @returns {{ok:boolean, code?:string, error?:string, from?:string, to?:string,
 *   jump?:boolean, forced?:boolean, noop?:boolean}}
 */
export function evaluateAdvance(input = {}) {
  const from = isStage(input.from) ? input.from : 'idle';
  const to = input.to;
  if (!isStage(to)) {
    return {
      ok: false,
      code: 'bad-stage',
      error: `阶段名不合法：${JSON.stringify(to)}。只能是 ${STAGES.join(' / ')} 之一。`,
    };
  }
  if (to === from) return { ok: true, noop: true, from, to, jump: false, forced: false };
  const delta = stageIndex(to) - stageIndex(from);
  if (delta < 0) {
    return {
      ok: false,
      code: 'backwards',
      error: `阶段只能前进：当前是 ${from}，不能退回 ${to}。如果事实退化了，读一次 video_stage_get 会按 brief / 风格自愈。`,
    };
  }
  const jump = delta > 1;
  if (jump && input.force !== true) {
    const skipped = STAGES.slice(stageIndex(from) + 1, stageIndex(to));
    return {
      ok: false,
      code: 'needs-force',
      error: `从 ${from} 直接到 ${to} 会跳过 ${skipped.join(' / ')}；确认要跳级请传 force:true（history 里会标记 forced）。`,
    };
  }

  const facts = input.facts ?? {};
  if (to === 'clarify' && !(Number(facts.briefFilled) > 0)) {
    return {
      ok: false,
      code: 'brief-empty',
      error: '还不能进入 clarify：brief 里还没有任何答案。先 video_brief_start 拿缺失清单，再用 video_brief_confirm 写回。',
    };
  }
  if ((to === 'script' || to === 'style' || to === 'locked' || to === 'build') && facts.briefReady !== true) {
    const missing = Array.isArray(facts.missing) ? facts.missing.length : Number(facts.missingCount) || 0;
    const titles = Array.isArray(facts.missingTitles) ? facts.missingTitles.slice(0, 4).join('、') : '';
    return {
      ok: false,
      code: 'brief-not-ready',
      error: `还不能进入 ${to}：brief 还缺 ${missing} 项${titles ? `（${titles} 等）` : ''}。10 个槽位缺一不可，先补齐。`,
    };
  }
  if ((to === 'locked' || to === 'build') && facts.styleConfirmed !== true) {
    return {
      ok: false,
      code: 'style-not-confirmed',
      error: `还不能进入 ${to}：风格还没确认。先调用 video_style_confirm 记录 tone / palette / font / density / pace（可附预览产物）。`,
    };
  }
  if ((to === 'style' || to === 'locked' || to === 'build') && facts.scriptConfirmed !== true) {
    return {
      ok: false,
      code: 'script-not-confirmed',
      error: `还不能进入 ${to}：视频脚本还没确认。先写脚本并让用户确认——用 video_script_draft 写分镜脚本（时间 / 画面 / 旁白 / 屏上文字 / 转场），逐条给用户看，等用户明确说「可以 / 确认 / 没问题」后再 video_script_confirm；没确认不许渲染样片、也不许跳级（force 也越不过这一步）。`,
    };
  }
  return { ok: true, from, to, jump, forced: jump && input.force === true };
}

/** 当前阶段下一步该干什么（中文，一句话）。 */
export function nextStepFor(stage, facts = {}) {
  const current = isStage(stage) ? stage : 'idle';
  const filled = Number(facts.briefFilled) || 0;
  const total = Number(facts.briefTotal) || 10;
  const missing = Array.isArray(facts.missing) ? facts.missing.length : 0;
  // 落后于事实时，先追上（不自动补，是为了让 history 里每一步都有出处）。
  const ceiling = factsStage(facts);
  if (stageIndex(ceiling) > stageIndex(current)) {
    const jump = stageIndex(ceiling) - stageIndex(current) > 1;
    return `状态落后于事实（事实允许 ${ceiling}）：调用 video_stage_advance {to:"${ceiling}"${jump ? ', force:true' : ''}} 追上。`;
  }
  if (current === 'idle') {
    if (filled > 0) return `状态落后于事实：brief 已有 ${filled} 项，调用 video_stage_advance {to:"clarify"} 追上。`;
    return '先调用 video_brief_start 拿缺失清单，再用 video_brief_confirm 写回答案；10 项齐了自动进 script（写脚本）。';
  }
  if (current === 'clarify') {
    return `还缺 ${missing} 项：用 video_brief_confirm 一次补齐（一轮 ≤3 条）；满 ${total}/${total} 自动进 script。`;
  }
  if (current === 'script') {
    if (facts.briefReady !== true) {
      return `brief 还没齐（${filled}/${total}）：先补齐 brief，再写脚本。`;
    }
    if (facts.scriptReady !== true) {
      return 'brief 已齐 → 该写视频脚本了：用 video_script_draft 写分镜脚本（每镜：时间 / 画面 / 旁白或屏上文字 / 转场），写完逐条给用户看。';
    }
    if (facts.scriptConfirmed !== true) {
      const draft = Number(facts.scriptDraftCount) || 1;
      return `脚本草稿已就绪（第 ${draft} 稿）：逐条给用户看，等用户明确说「可以 / 确认 / 没问题」后调用 video_script_confirm；没确认不许渲染样片、不许开工。`;
    }
    return '脚本已确认：可以渲染 4 张关键帧 + 8 秒风格样片，再请用户定风格；用 video_style_confirm 记录 tone / palette / font / density / pace。';
  }
  if (current === 'style') {
    if (facts.briefReady !== true) {
      return `风格已确认，但 brief 只有 ${filled}/${total}；先补齐 brief，再调用 video_stage_advance 回到 locked。`;
    }
    if (facts.scriptConfirmed !== true) {
      return '历史工程缺少已确认的脚本：先 video_script_draft 补一份分镜脚本，逐条给用户看，video_script_confirm 后再 video_style_confirm 定风格。';
    }
    return 'brief 与脚本都已齐：渲染 4 张关键帧 + 8 秒风格样片，再用 video_style_confirm 确认 tone / palette / font / density / pace（可附预览产物），阶段自动进 locked。';
  }
  if (current === 'locked') {
    if (facts.scriptMissing === true) {
      return '历史工程没有 script.json：先用 video_script_draft 补一份分镜脚本并 video_script_confirm；当前 locked 状态不会被收回，补完再动时间线。';
    }
    if (facts.scriptReady === true && facts.scriptConfirmed !== true) {
      return '脚本有未确认的改动：先逐条给用户看，video_script_confirm 重新确认；确认前不要按新脚本继续推进时间线。';
    }
    return '可以改时间线了；第一次写操作会自动进入 build。要导出先调用 video_stage_advance {to:"build"}。';
  }
  if (facts.scriptMissing === true) {
    return '生产阶段，但历史工程没有 script.json：建议先 video_script_draft → video_script_confirm 补一份脚本；build 状态保持不变。';
  }
  if (facts.scriptReady === true && facts.scriptConfirmed !== true) {
    return '生产阶段，但脚本有未确认的改动：先 video_script_confirm 重新确认，再按新脚本出片。';
  }
  return '生产阶段：写类与导出都放行。收工前核对交付物、分辨率与禁忌。';
}

/** 当前阶段被拦住的类别（给 video_stage_get 的 blocked 字段）。 */
export function blockedFor(stage, facts = {}) {
  const current = isStage(stage) ? stage : 'idle';
  const ceiling = factsStage(facts);
  if (stageIndex(ceiling) > stageIndex(current)) {
    const jump = stageIndex(ceiling) - stageIndex(current) > 1;
    return [`阶段落后于事实（事实允许 ${ceiling}）：先 video_stage_advance {to:"${ceiling}"${jump ? ', force:true' : ''}}`];
  }
  if (current === 'idle' || current === 'clarify') {
    return ['video_style_confirm / video_style_read（先补完 brief）', '写类工具（先补完 brief）', '导出（先补完 brief）'];
  }
  if (current === 'script') {
    return [
      'video_style_confirm / video_style_read（先写脚本并让用户确认）',
      '渲染风格样片 / 关键帧（脚本没确认不许渲染）',
      '写类工具（先确认脚本与风格）',
      '导出（先确认脚本与风格）',
    ];
  }
  if (current === 'style') {
    return ['写类工具（先确认风格）', '导出（先确认风格）'];
  }
  if (current === 'locked') return ['导出（先进入 build）'];
  return [];
}

/** 把阶段事实压成一句话（日志 / 拒绝文案共用）。 */
export function describeFacts(facts = {}) {
  const filled = Number(facts.briefFilled) || 0;
  const total = Number(facts.briefTotal) || 10;
  const script = facts.scriptConfirmed === true
    ? '脚本已确认'
    : (facts.scriptReady === true ? '脚本未确认' : '脚本未写');
  return `brief ${filled}/${total}，${script}${facts.styleConfirmed === true ? '，风格已确认' : '，风格未确认'}`;
}

/* ------------------------------------------------------------------ */
/* 服务：工具与门禁共用                                                  */
/* ------------------------------------------------------------------ */

/**
 * @param {{
 *   storeFor: (root:string)=>object,
 *   stateStoreFor: (root:string)=>object,
 *   styleStoreFor: (root:string)=>object,
 *   scriptStoreFor: (root:string)=>object,
 *   config: () => object,
 *   now?: () => number,
 *   log?: (message:string, level?:string)=>void,
 * }} deps
 */
export function createStageService(deps) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  /** 读事实：brief 判定 + 脚本是否已写/已确认 + 风格是否确认 + 这是不是视频工程。 */
  async function readFacts(root) {
    const config = deps.config();
    const briefStore = deps.storeFor(root);
    const read = await briefStore.read();
    const evaluation = evaluateBrief({
      brief: read.brief,
      slots: config.slots,
      maxQuestions: 9999,
      maxRounds: config.maxRounds,
    });
    const styleRead = await deps.styleStoreFor(root).read();
    const style = styleRead.style ?? null;
    const scriptRead = await deps.scriptStoreFor(root).read();
    const script = scriptRead.script ?? null;
    const scriptReady = Boolean(script && Array.isArray(script.shots) && script.shots.length > 0);
    const scriptConfirmed = Boolean(script && script.confirmed === true);
    return {
      briefReady: evaluation.ready,
      briefFilled: evaluation.filledCount,
      briefTotal: evaluation.total,
      missing: evaluation.missingAll.map((item) => item.slot),
      missingTitles: evaluation.missingAll.map((item) => item.title),
      script,
      scriptReady,
      scriptConfirmed,
      scriptDraftCount: script ? Number(script.draftCount) || 0 : 0,
      scriptMissing: !scriptRead.exists,
      scriptCorrupt: scriptRead.corrupt,
      styleConfirmed: Boolean(style && style.confirmed === true),
      style,
      hasProject: await briefStore.hasMetaDir(),
      briefCorrupt: read.corrupt,
      briefBackup: read.backup,
    };
  }

  /** 读阶段并自愈；只有确实是视频工程时才落盘 state.json。 */
  async function snapshot(root) {
    const facts = await readFacts(root);
    const store = deps.stateStoreFor(root);
    const current = await store.read();
    const reconciled = reconcileStageState(current.state, facts, now());
    let state = reconciled.state;
    if (facts.hasProject) {
      try {
        const result = await store.update((prev) => {
          const again = reconcileStageState(prev, facts, now());
          // 坏文件已经备份过：这里把 state.json 重建为 idle，避免每次读都再备份一遍。
          if (!again.healed && current.exists && !current.corrupt) return { skip: true, state: prev };
          return { state: again.state };
        });
        state = result.state ?? state;
      } catch (error) {
        log(`state.json 自愈写盘失败（忽略）：${(error && error.message) || error}`, 'warn');
      }
    }
    return { facts, state, healed: reconciled.healed, from: reconciled.from };
  }

  /** 在串行队列里再判一次，避免并发下覆盖。 */
  async function mutateState(root, facts, decider) {
    const store = deps.stateStoreFor(root);
    return store.update((prev) => {
      const state = reconcileStageState(prev, facts, now()).state;
      const result = decider(state);
      if (!result) return { skip: true, state };
      return result;
    });
  }

  /**
   * 手动推进。跳级要 force，倒退拒绝，事实不够也拒绝。
   */
  async function advance(root, options = {}) {
    const to = options.to;
    const force = options.force === true;
    const by = options.by === 'user' ? 'user' : 'tool';
    const snap = await snapshot(root);
    const first = evaluateAdvance({ from: snap.state.stage, to, force, facts: snap.facts });
    if (!first.ok) {
      return {
        ok: false,
        code: first.code,
        error: first.error,
        from: snap.state.stage,
        stage: snap.state.stage,
        history: snap.state.history,
        nextStep: nextStepFor(snap.state.stage, snap.facts),
      };
    }
    if (first.noop) {
      return {
        ok: true,
        changed: false,
        from: snap.state.stage,
        to,
        stage: snap.state.stage,
        forced: false,
        jump: false,
        history: snap.state.history,
        nextStep: nextStepFor(snap.state.stage, snap.facts),
      };
    }

    let final = snap.state;
    let verdict = first;
    try {
      const result = await mutateState(root, snap.facts, (state) => {
        const again = evaluateAdvance({ from: state.stage, to, force, facts: snap.facts });
        if (!again.ok || again.noop) {
          return { skip: true, state, verdict: again };
        }
        const at = iso(now());
        const entry = { stage: again.to, at, by };
        if (again.forced) entry.forced = true;
        if (again.jump) entry.jump = true;
        return {
          state: { stage: again.to, since: at, history: [...state.history, entry] },
          verdict: again,
        };
      });
      final = result.state ?? final;
      verdict = result.verdict ?? verdict;
    } catch (error) {
      return {
        ok: false,
        code: 'write-failed',
        error: `写 state.json 失败：${(error && error.message) || error}`,
        from: snap.state.stage,
        stage: snap.state.stage,
        history: snap.state.history,
      };
    }

    if (verdict && verdict.ok === false) {
      return {
        ok: false,
        code: verdict.code,
        error: verdict.error,
        from: snap.state.stage,
        stage: final.stage,
        history: final.history,
        nextStep: nextStepFor(final.stage, snap.facts),
      };
    }
    return {
      ok: true,
      changed: final.stage !== snap.state.stage,
      from: snap.state.stage,
      to: final.stage,
      stage: final.stage,
      forced: Boolean(verdict && verdict.forced),
      jump: Boolean(verdict && verdict.jump),
      history: final.history,
      nextStep: nextStepFor(final.stage, snap.facts),
    };
  }

  /** brief_confirm 成功后自动推进：idle → clarify，brief 齐 → script（脚本/风格已确认则更高）。 */
  async function bumpAfterBrief(root) {
    const snap = await snapshot(root);
    const facts = snap.facts;
    const target = factsStage(facts);
    if (!target || target === 'idle' || stageIndex(snap.state.stage) >= stageIndex(target)) return snap.state;
    try {
      const result = await mutateState(root, facts, (state) => {
        if (stageIndex(state.stage) >= stageIndex(target)) return { skip: true, state };
        const at = iso(now());
        return {
          state: {
            stage: target,
            since: at,
            history: [...state.history, { stage: target, at, by: 'tool', reason: 'brief-ready' }],
          },
        };
      });
      return result.state ?? snap.state;
    } catch (error) {
      log(`brief 后推进阶段失败（忽略）：${(error && error.message) || error}`, 'warn');
      return snap.state;
    }
  }

  /** script_confirm 成功后自动进 style（风格已确认则到 locked）。 */
  async function bumpAfterScript(root) {
    const snap = await snapshot(root);
    const facts = snap.facts;
    if (!(facts.briefReady === true && facts.scriptConfirmed === true)) return snap.state;
    const target = facts.styleConfirmed === true ? 'locked' : 'style';
    if (stageIndex(snap.state.stage) >= stageIndex(target)) return snap.state;
    try {
      const result = await mutateState(root, facts, (state) => {
        if (stageIndex(state.stage) >= stageIndex(target)) return { skip: true, state };
        const at = iso(now());
        return {
          state: {
            stage: target,
            since: at,
            history: [...state.history, { stage: target, at, by: 'tool', reason: 'script-confirmed' }],
          },
        };
      });
      return result.state ?? snap.state;
    } catch (error) {
      log(`脚本确认后推进阶段失败（忽略）：${(error && error.message) || error}`, 'warn');
      return snap.state;
    }
  }

  /** style_confirm 成功后自动进 locked。 */
  async function bumpAfterStyle(root) {
    const snap = await snapshot(root);
    const facts = snap.facts;
    if (!(facts.briefReady === true && facts.styleConfirmed === true)) return snap.state;
    if (stageIndex(snap.state.stage) >= stageIndex('locked')) return snap.state;
    try {
      const result = await mutateState(root, facts, (state) => {
        if (stageIndex(state.stage) >= stageIndex('locked')) return { skip: true, state };
        const at = iso(now());
        return {
          state: {
            stage: 'locked',
            since: at,
            history: [...state.history, { stage: 'locked', at, by: 'tool', reason: 'style-confirmed' }],
          },
        };
      });
      return result.state ?? snap.state;
    } catch (error) {
      log(`风格确认后推进阶段失败（忽略）：${(error && error.message) || error}`, 'warn');
      return snap.state;
    }
  }

  /** 门禁放行了 locked 阶段的第一次写操作 → build。 */
  async function autoBuild(root) {
    const snap = await snapshot(root);
    if (snap.state.stage !== 'locked') return snap.state;
    if (!(snap.facts.briefReady === true && snap.facts.styleConfirmed === true)) return snap.state;
    try {
      const result = await mutateState(root, snap.facts, (state) => {
        if (state.stage !== 'locked') return { skip: true, state };
        const at = iso(now());
        return {
          state: {
            stage: 'build',
            since: at,
            history: [...state.history, { stage: 'build', at, by: 'tool', reason: 'first-write' }],
          },
        };
      });
      return result.state ?? snap.state;
    } catch (error) {
      log(`自动进入 build 失败（忽略）：${(error && error.message) || error}`, 'warn');
      return snap.state;
    }
  }

  /** 读 style.json（原样，不做确认门槛）。 */
  async function readStyle(root) {
    return deps.styleStoreFor(root).read();
  }

  /**
   * 写 style.json 并进 locked。调用方应已校验 spec；brief 未满或脚本未确认时拒绝。
   */
  async function confirmStyle(root, style) {
    const facts = await readFacts(root);
    if (facts.briefReady !== true) {
      return {
        ok: false,
        code: 'brief-not-ready',
        error: `还不能确认风格：brief 只有 ${facts.briefFilled}/${facts.briefTotal}，还缺 ${facts.missing.length} 项。先把 10 项补齐。`,
        facts,
      };
    }
    if (facts.scriptConfirmed !== true) {
      return {
        ok: false,
        code: 'script-not-confirmed',
        error: '还不能确认风格：视频脚本还没确认。先 video_script_draft 写分镜脚本 → 逐条给用户看 → 用户明确同意后 video_script_confirm；脚本没确认不许渲染样片，也不许定风格。',
        facts,
      };
    }
    // 如果阶段还落后在 idle/clarify（例如手改过 brief），先按事实推到 script/style，再写风格。
    await bumpAfterBrief(root);
    const written = await deps.styleStoreFor(root).write(style);
    const state = await bumpAfterStyle(root);
    const finalFacts = { ...facts, styleConfirmed: true, style: written.style ?? style };
    return {
      ok: true,
      style: written.style ?? style,
      stage: state.stage,
      history: state.history,
      nextStep: nextStepFor(state.stage, finalFacts),
    };
  }

  /** 读 script.json（原样，不做确认门槛）。 */
  async function readScript(root) {
    return deps.scriptStoreFor(root).read();
  }

  /**
   * 写脚本草稿。brief 未满拒绝；校验失败**不写盘**；
   * 内容没变 → 幂等（draftCount 不累加、confirmed 不清）；内容变了 → draftCount+1、confirmed 重置 false。
   */
  async function saveScriptDraft(root, rawScript) {
    const facts = await readFacts(root);
    if (facts.briefReady !== true) {
      return {
        ok: false,
        code: 'brief-not-ready',
        error: `还不能写脚本：brief 只有 ${facts.briefFilled}/${facts.briefTotal}，还缺 ${facts.missing.length} 项。先把 10 项补齐，brief 满了才进 script。`,
        problems: [],
        written: false,
        nextStep: nextStepFor('clarify', facts),
      };
    }

    const store = deps.scriptStoreFor(root);
    const current = await store.read();
    const built = buildScriptDraft(rawScript, { prev: current.script, now: now() });
    if (!built.ok) {
      return {
        ok: false,
        code: 'invalid-script',
        error: `脚本没写盘：校验发现 ${built.problems.length} 个问题，逐条改完再调用 video_script_draft。`,
        problems: built.problems,
        summary: built.summary,
        written: false,
      };
    }

    let written = built.script;
    let wrote = false;
    if (!built.idempotent) {
      try {
        const result = await store.update((prev) => {
          const again = buildScriptDraft(rawScript, { prev, now: now() });
          if (!again.ok) return { skip: true };
          if (again.idempotent) return { skip: true, script: again.script };
          return { script: again.script };
        });
        written = result.script ?? built.script;
        wrote = result.written === true;
      } catch (error) {
        return {
          ok: false,
          code: 'write-failed',
          error: `写 script.json 失败：${(error && error.message) || error}`,
          written: false,
        };
      }
    }

    const state = await bumpAfterBrief(root);
    const finalFacts = await readFacts(root);
    return {
      ok: true,
      written: wrote,
      ...(wrote ? {} : { idempotent: true }),
      script: written,
      summary: scriptSummary(written),
      problems: [],
      draftCount: written?.draftCount ?? 0,
      confirmed: written?.confirmed === true,
      stage: state.stage,
      nextStep: nextStepFor(state.stage, finalFacts),
    };
  }

  /**
   * 确认脚本（agent 转述用户明确同意后调用）：confirmed=true 落盘，并把阶段推进到 style。
   * 脚本不存在 / brief 未满时拒绝；已确认时幂等（不重复写盘）。
   */
  async function confirmScript(root, options = {}) {
    const facts = await readFacts(root);
    if (facts.briefReady !== true) {
      return {
        ok: false,
        code: 'brief-not-ready',
        error: `还不能确认脚本：brief 只有 ${facts.briefFilled}/${facts.briefTotal}，还缺 ${facts.missing.length} 项。先把 10 项补齐。`,
        written: false,
      };
    }
    if (facts.scriptReady !== true) {
      return {
        ok: false,
        code: 'script-missing',
        error: '还没有脚本草稿：先 video_script_draft 写分镜脚本（时间 / 画面 / 旁白 / 屏上文字 / 转场），逐条给用户看，用户明确同意后再调用 video_script_confirm。',
        written: false,
        nextStep: nextStepFor('script', facts),
      };
    }
    if (facts.scriptConfirmed === true) {
      const state = await bumpAfterScript(root);
      const finalFacts = await readFacts(root);
      return {
        ok: true,
        written: false,
        idempotent: true,
        script: facts.script,
        confirmed: true,
        confirmedAt: facts.script?.confirmedAt ?? null,
        stage: state.stage,
        history: state.history,
        nextStep: nextStepFor(state.stage, finalFacts),
      };
    }

    let written = facts.script;
    let wrote = false;
    try {
      const result = await deps.scriptStoreFor(root).update((prev) => {
        const next = buildScriptConfirmation(prev, { now: now(), note: options.note });
        if (!next) return { skip: true };
        if (prev && prev.confirmed === true) return { skip: true, script: next };
        return { script: next };
      });
      written = result.script ?? written;
      wrote = result.written === true;
    } catch (error) {
      return {
        ok: false,
        code: 'write-failed',
        error: `写 script.json 失败：${(error && error.message) || error}`,
        written: false,
      };
    }

    const state = await bumpAfterScript(root);
    const finalFacts = await readFacts(root);
    return {
      ok: true,
      written: wrote,
      ...(wrote ? {} : { idempotent: true }),
      script: written,
      confirmed: written?.confirmed === true,
      confirmedAt: written?.confirmedAt ?? null,
      stage: state.stage,
      history: state.history,
      nextStep: nextStepFor(state.stage, finalFacts),
    };
  }

  return {
    readFacts,
    snapshot,
    advance,
    bumpAfterBrief,
    bumpAfterScript,
    bumpAfterStyle,
    autoBuild,
    readStyle,
    confirmStyle,
    readScript,
    saveScriptDraft,
    confirmScript,
  };
}
