/**
 * 门禁：按**阶段矩阵**判定哪些工具要拦、拦不拦、怎么拦。
 *
 * 这一层是纯函数 + 一个挂事件的小函数，判定部分不读盘、不依赖 DSH 运行时。
 *
 * 和旧版的差别：旧版只看 brief 是否 10/10；现在看六阶段：
 *   idle / clarify → 只放行 brief 与只读工具
 *   script         → 再放行 script_draft / script_confirm（brief 满才过度量）
 *   style          → 再放行 style_confirm / style_read（脚本确认后才到得了）
 *   locked         → 再放行写类（video_* 写、工程内文件写入）
 *   build          → 再放行导出
 *
 * 脚本工具走门禁但不是按阶段放行：只要 facts.briefReady 为真就允许 draft / confirm，
 * 因为 stage 可能落后于事实（brief 刚满、state 还是 clarify）。brief 没满时 enforce 真拒。
 *
 * 三档策略保留：warn 只记日志、enforce 真拒、off 不挂钩子。默认 warn。
 *
 * 兼容：调用 decideGate 时**不传 stage** 会走旧版判定（只看 ready），
 * 这样 0.1.x 的调用方与旧测试不会因为升级而变红。
 */

import path from 'node:path';

import { REFERENCE_GAP_HINT } from './brief.mjs';
import { META_DIR } from './store.mjs';
import { STAGES, isStage } from './stage.mjs';

/** 视频写类工具（locked / build 才放行）。 */
export const VIDEO_WRITE_TOOLS = [
  'video_edit_apply',
  'video_code_write',
  'video_motion_insert',
  'video_sound_insert',
  'video_storyboard_apply',
  'video_caption_import',
];

/** 条件写：只有 applyToTimeline:true 才算改时间线。 */
export const CONDITIONAL_WRITE_TOOLS = ['video_transcribe'];

/** 文件类工具：只拦"视频工程里的、且不在 .dsh-video/ 下"的写入。 */
export const FILE_WRITE_TOOLS = ['write', 'edit'];

/** 脚本工具：brief 满了才放行（见 decideGate 的 kind === 'script'）。 */
export const SCRIPT_TOOLS = ['video_script_draft', 'video_script_confirm'];

/** 风格工具：script 阶段仍拒（脚本确认后才到 style），style 起放行。 */
export const STYLE_TOOLS = ['video_style_confirm', 'video_style_read'];

/** 阶段工具：永远放行（自己会校验）。 */
export const STAGE_TOOLS = ['video_stage_get', 'video_stage_advance'];

/** 简报工具：永远放行。 */
export const BRIEF_TOOLS = [
  'video_brief_start',
  'video_brief_confirm',
  'video_reference_register',
  'video_reference_skip',
];

/** 导出类：只有 build 放行（按前缀匹配 video_export*）。 */
export const EXPORT_TOOL_PREFIXES = ['video_export'];

/** 只读工具（显式白名单，纯粹为了文档化和防止将来误伤）。 */
export const READ_ONLY_TOOLS = [
  'video_script_read',
  'video_project_inspect',
  'video_analysis_read',
  'video_annotation_list',
  'video_timeline_inspect',
  'video_storyboard_read',
  'video_motion_list',
  'video_motion_read',
  'video_sound_search',
  'video_sound_sources',
  'video_sample',
  'read',
  'read_image',
  'grep',
  'glob',
];

const VIDEO_WRITE_SET = new Set(VIDEO_WRITE_TOOLS.map((n) => n.toLowerCase()));
const CONDITIONAL_SET = new Set(CONDITIONAL_WRITE_TOOLS.map((n) => n.toLowerCase()));
const FILE_WRITE_SET = new Set(FILE_WRITE_TOOLS.map((n) => n.toLowerCase()));
const READ_ONLY_SET = new Set(READ_ONLY_TOOLS.map((n) => n.toLowerCase()));
const SCRIPT_SET = new Set(SCRIPT_TOOLS.map((n) => n.toLowerCase()));
const STYLE_SET = new Set(STYLE_TOOLS.map((n) => n.toLowerCase()));
const STAGE_SET = new Set(STAGE_TOOLS.map((n) => n.toLowerCase()));
const BRIEF_SET = new Set(BRIEF_TOOLS.map((n) => n.toLowerCase()));

/** 需要读状态才判定的类别。 */
export const GATED_KINDS = new Set(['video-write', 'script', 'style', 'export', 'file-write']);

/** 门禁档位。 */
export const GATE_MODES = ['off', 'warn', 'enforce'];

/** 从工具参数里尽量捞出目标文件路径。 */
export function extractPath(args) {
  if (!args || typeof args !== 'object') return '';
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/**
 * 目标路径相对工程落在哪：
 * - `meta`    .dsh-video/ 里面（简报、工程文档本身）→ 放行
 * - `project` 工程目录里、但不在 .dsh-video/ → 视频产物，按阶段拦
 * - `outside` 工程目录之外 → 与本次视频无关，放行
 * - `unknown` 拿不到路径 → 放行（宁可漏拦，不可乱拦）
 * @param {{filePath?: string, projectRoot?: string, cwd?: string}} input
 */
export function classifyPath(input = {}) {
  const raw = extractPath({ file_path: input.filePath });
  const root = typeof input.projectRoot === 'string' && input.projectRoot.trim() !== ''
    ? path.resolve(input.projectRoot.trim())
    : '';
  if (raw === '' || root === '') return 'unknown';
  const base = typeof input.cwd === 'string' && input.cwd.trim() !== '' ? path.resolve(input.cwd.trim()) : root;
  const target = path.resolve(base, raw);
  const meta = path.join(root, META_DIR);
  const lower = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const t = lower(target);
  const m = lower(meta);
  const r = lower(root);
  if (t === m || t.startsWith(m + path.sep)) return 'meta';
  if (t === r || t.startsWith(r + path.sep)) return 'project';
  return 'outside';
}

/** 这个工具名属于哪一类（不看阶段）。 */
export function classifyTool(toolName, args) {
  const name = typeof toolName === 'string' ? toolName.trim().toLowerCase() : '';
  if (name === '') return { hit: false, kind: 'unknown' };
  if (BRIEF_SET.has(name)) return { hit: false, kind: 'brief' };
  if (STAGE_SET.has(name)) return { hit: false, kind: 'stage' };
  if (STYLE_SET.has(name)) return { hit: false, kind: 'style' };
  if (SCRIPT_SET.has(name)) return { hit: true, kind: 'script' };
  if (READ_ONLY_SET.has(name)) return { hit: false, kind: 'read-only' };
  if (VIDEO_WRITE_SET.has(name)) return { hit: true, kind: 'video-write' };
  if (CONDITIONAL_SET.has(name)) {
    const apply = args && typeof args === 'object' ? args.applyToTimeline : undefined;
    return { hit: apply === true, kind: apply === true ? 'video-write' : 'read-only' };
  }
  if (EXPORT_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) return { hit: false, kind: 'export' };
  if (FILE_WRITE_SET.has(name)) return { hit: 'file', kind: 'file-write' };
  return { hit: false, kind: 'other' };
}

/** 旧版拒绝文案（brief 未 ready）。保留给兼容路径。 */
export function buildDenyReason(input = {}) {
  const tool = typeof input.toolName === 'string' && input.toolName !== '' ? input.toolName : '这个工具';
  const missing = Array.isArray(input.missing) ? input.missing : [];
  const titles = missing.map((item) => (typeof item === 'string' ? item : item.title)).filter(Boolean);
  const head = `${tool} 被门禁拦下了：这个视频工程的需求还没问清`;
  const detail = titles.length > 0
    ? `。还缺 ${missing.length} 项：${titles.slice(0, 6).join('、')}${missing.length > 6 ? ' 等' : ''}`
    : '';
  const next = '。下一步：先调用 video_brief_start 拿缺失清单，用 ask_user_question 一次问完（每轮 ≤3 条），'
    + '再调用 video_brief_confirm 把答案写回 .dsh-video/brief.json；10 项齐了才会放行。';
  // 缺参考素材时给专门文案：先问有无，再提醒图片优于文字，最后要显式确认。
  const referenceGap = missing.some((item) => item && typeof item === 'object' && item.slot === 'reference');
  return head + detail + next + (referenceGap ? REFERENCE_GAP_HINT : '');
}

/** 旧版 warn 文案。 */
export function buildWarnReason(input = {}) {
  const tool = typeof input.toolName === 'string' && input.toolName !== '' ? input.toolName : '这个工具';
  return `需求尚未 ready（warn 档，只记日志不拦截）：${tool}。先 video_brief_start → video_brief_confirm。`;
}

/** 阶段中文名。 */
function stageText(stage) {
  return isStage(stage) ? stage : 'idle';
}

/**
 * 阶段拒绝文案：说清现在在哪、为什么拦、下一步做什么。
 */
export function buildStageDenyReason(input = {}) {
  const tool = typeof input.toolName === 'string' && input.toolName !== '' ? input.toolName : '这个工具';
  const stage = stageText(input.stage);
  const missing = Array.isArray(input.missing) ? input.missing : [];
  const titles = missing.map((item) => (typeof item === 'string' ? item : item.title)).filter(Boolean);
  const kind = input.kind ?? '';

  if (kind === 'script') {
    return `${tool} 被阶段门禁拦下了：brief 还没满，不能写脚本。`
      + '下一步：video_brief_start 拿缺失清单 → 用 ask_user_question 一次问完（每轮 ≤3 条）→ video_brief_confirm 写回；10 项齐了进 script，再 video_script_draft。';
  }
  if (stage === 'idle' || stage === 'clarify') {
    const detail = titles.length > 0
      ? `还缺 ${missing.length} 项：${titles.slice(0, 6).join('、')}${missing.length > 6 ? ' 等' : ''}。`
      : 'brief 还没问。';
    return `${tool} 被阶段门禁拦下了：当前 ${stage}。${detail}`
      + '下一步：video_brief_start 拿缺失清单 → 用 ask_user_question 一次问完（每轮 ≤3 条）→ video_brief_confirm 写回；10 项齐了自动进 script。';
  }
  if (stage === 'script') {
    if (kind === 'style') {
      return `${tool} 被阶段门禁拦下了：当前 script——brief 已齐，但脚本还没确认。`
        + '下一步：video_script_draft 写分镜脚本 → 逐条给用户看 → 用户明确同意后 video_script_confirm；脚本确认后才进 style，才允许渲染样片 / 定风格。';
    }
    if (kind === 'video-write' || kind === 'file-write') {
      return `${tool} 被阶段门禁拦下了：当前 script——脚本还没确认。`
        + '下一步：video_script_draft 写分镜脚本 → 用户明确同意后 video_script_confirm → video_style_confirm 定风格；之后才改写时间线。';
    }
    return `${tool} 被阶段门禁拦下了：当前 script 不放行这个操作。先 video_stage_get 看阶段。`;
  }
  if (stage === 'style') {
    if (kind === 'style') {
      return `${tool} 被阶段门禁拦下了：当前 style，但 brief 还没满。先把 10 项补齐，再确认风格。`;
    }
    return `${tool} 被阶段门禁拦下了：当前 style——brief 已齐，但风格还没确认。`
      + '下一步：video_style_confirm 记录 tone / palette / font / density / pace（可附预览产物）；确认后自动进 locked，写类工具才放行。';
  }
  if (stage === 'locked') {
    if (kind === 'export') {
      return `${tool} 被阶段门禁拦下了：当前 locked，导出被锁在 build 之后。`
        + '下一步：video_stage_advance {to:"build"}；或者先改一版时间线——第一次写操作会自动进入 build。';
    }
    return `${tool} 被阶段门禁拦下了：当前 locked 不放行这个操作。先 video_stage_get 看阶段。`;
  }
  return `${tool} 被阶段门禁拦下了：当前 ${stage} 不放行这个操作。先 video_stage_get 看阶段。`;
}

/** 阶段 warn 文案。 */
export function buildStageWarnReason(input = {}) {
  const tool = typeof input.toolName === 'string' && input.toolName !== '' ? input.toolName : '这个工具';
  const stage = stageText(input.stage);
  return `[warn 档] 当前阶段 ${stage}，本应拦下 ${tool}（只记日志，不拦截）。`
    + '按阶段矩阵：idle/clarify 只补 brief，script 先写脚本并让用户确认，style 再确认风格，locked 才改写时间线，build 才导出。';
}

/** 旧版判定（只看 brief 是否 ready）。 */
function decideLegacyGate(input) {
  if (input.ready === true) return { action: 'allow', code: 'brief-ready' };

  const { hit, kind } = classifyTool(input.toolName, input.args);
  let matched = hit === true;
  if (hit === 'file') {
    // 只有"确实是视频工程"时才管文件写入，否则会误伤同工作区里的普通开发任务。
    matched = input.hasProject === true
      && classifyPath({ filePath: extractPath(input.args), projectRoot: input.projectRoot, cwd: input.cwd }) === 'project';
  }
  if (!matched) return { action: 'allow', code: 'not-gated', kind };

  const reason = buildDenyReason({ toolName: input.toolName, missing: input.missing ?? [] });
  if (input.mode === 'warn') {
    return { action: 'warn', code: 'brief-not-ready', kind, reason: buildWarnReason({ toolName: input.toolName }) };
  }
  return { action: 'deny', code: 'brief-not-ready', kind, reason };
}

/**
 * 阶段矩阵核心判定（纯函数，可单测）。
 *
 * @param {{
 *   mode?: 'off'|'warn'|'enforce',
 *   stage?: 'idle'|'clarify'|'style'|'locked'|'build',
 *   toolName?: string,
 *   args?: object,
 *   ready?: boolean,          // 兼容旧调用
 *   briefReady?: boolean,
 *   styleConfirmed?: boolean,
 *   missing?: Array,
 *   projectRoot?: string,
 *   cwd?: string,
 *   hasProject?: boolean,
 * }} input
 * @returns {{action:'allow'|'deny'|'warn', code?:string, reason?:string, kind?:string, stage?:string}}
 */
export function decideGate(input = {}) {
  const mode = GATE_MODES.includes(input.mode) ? input.mode : 'warn';
  if (mode === 'off') return { action: 'allow', code: 'gate-off' };
  if (!isStage(input.stage)) return decideLegacyGate({ ...input, mode });

  const stage = input.stage;
  const { kind } = classifyTool(input.toolName, input.args);
  let pathClass = null;
  if (kind === 'file-write') {
    // 不是视频工程 / 路径不在工程内 → 与视频无关，完全不碰。
    if (input.hasProject !== true) return { action: 'allow', code: 'not-gated', kind, stage };
    pathClass = classifyPath({ filePath: extractPath(input.args), projectRoot: input.projectRoot, cwd: input.cwd });
    if (pathClass === 'meta') return { action: 'allow', code: 'meta-write', kind, stage };
    if (pathClass !== 'project') return { action: 'allow', code: 'outside-project', kind, stage };
  }

  let allowed;
  let code;
  if (kind === 'script') {
    // 脚本工具不看阶段，只看 brief：state 可能落后于事实（brief 已满、state 还在 clarify）。
    allowed = input.briefReady === true;
    code = 'brief-not-ready';
  } else if (kind === 'video-write' || kind === 'file-write') {
    allowed = stage === 'locked' || stage === 'build';
    code = stage === 'script' ? 'script-not-confirmed' : (stage === 'style' ? 'style-not-confirmed' : 'brief-not-ready');
  } else if (kind === 'style') {
    allowed = stage === 'style' || stage === 'locked' || stage === 'build';
    code = stage === 'script' ? 'script-not-confirmed' : 'brief-not-ready';
  } else if (kind === 'export') {
    allowed = stage === 'build';
    code = stage === 'locked' ? 'not-building' : 'stage-blocked';
  } else {
    allowed = true;
    code = 'not-gated';
  }

  if (allowed) return { action: 'allow', code, kind, stage };
  if (mode === 'warn') {
    return {
      action: 'warn',
      code,
      kind,
      stage,
      reason: buildStageWarnReason({ toolName: input.toolName, stage }),
    };
  }
  return {
    action: 'deny',
    code,
    kind,
    stage,
    reason: buildStageDenyReason({ toolName: input.toolName, stage, missing: input.missing ?? [], kind }),
  };
}

/** 这次放行的操作算不算"第一次写操作"（用于 locked → build）。 */
function isFirstWriteKind(kind, input) {
  if (kind === 'video-write') return true;
  if (kind !== 'file-write' || input.hasProject !== true) return false;
  return classifyPath({
    filePath: extractPath(input.args),
    projectRoot: input.projectRoot,
    cwd: input.cwd,
  }) === 'project';
}

/**
 * 把门禁挂到宿主事件上。
 *
 * `readState(agent)` 由入口注入，返回
 * `{ stage, briefReady, styleConfirmed, missing, projectRoot, cwd, hasProject }`；
 * 也兼容旧形状 `{ ready, ... }`。
 * 读盘失败一律放行 —— 门禁自己坏掉不该让用户干不了活。
 *
 * @param {object} ctx Cordis 上下文
 * @param {{
 *   mode: string,
 *   readState: (agent:any)=>Promise<object>,
 *   onFirstWrite?: (projectRoot:string)=>Promise<void>|void,
 *   log: (msg:string, level?:string)=>void,
 * }} options
 */
export function registerGate(ctx, options) {
  const mode = GATE_MODES.includes(options.mode) ? options.mode : 'warn';
  if (mode === 'off') {
    options.log('gate=off：门禁完全不拦，也不读 brief/state/style', 'info');
    return () => {};
  }
  const handler = async (exec, next) => {
    try {
      const toolName = exec?.name ?? '';
      const info = classifyTool(toolName, exec?.args);
      if (!GATED_KINDS.has(info.kind)) return next();

      const state = await options.readState(exec?.agent);
      const decision = decideGate({
        mode,
        stage: state?.stage,
        toolName,
        args: exec?.args,
        ready: state?.ready === true,
        briefReady: state?.briefReady === true,
        styleConfirmed: state?.styleConfirmed === true,
        missing: state?.missing ?? [],
        projectRoot: state?.projectRoot ?? '',
        cwd: state?.cwd ?? '',
        hasProject: state?.hasProject === true,
      });

      if (decision.action === 'warn') {
        options.log(decision.reason ?? buildStageWarnReason({ toolName, stage: state?.stage }), 'warn');
        return next();
      }
      if (decision.action === 'deny') {
        options.log(`拦截 ${toolName}（阶段 ${state?.stage ?? '?'}，${decision.code ?? ''}）`, 'info');
        return {
          kind: 'deny',
          reason: decision.reason ?? buildStageDenyReason({ toolName, stage: state?.stage, kind: info.kind }),
        };
      }

      // locked 阶段第一次被放行的写操作 → 自动进 build（只做一次；失败不拦）。
      if (state?.stage === 'locked' && typeof options.onFirstWrite === 'function' && isFirstWriteKind(info.kind, {
        args: exec?.args,
        projectRoot: state?.projectRoot ?? '',
        cwd: state?.cwd ?? '',
        hasProject: state?.hasProject === true,
      })) {
        try {
          await options.onFirstWrite(state?.projectRoot ?? '');
        } catch (error) {
          options.log(`自动进入 build 失败（放行）：${(error && error.message) || error}`, 'warn');
        }
      }
      return next();
    } catch (error) {
      options.log(`门禁判定异常，放行：${(error && error.message) || error}`, 'warn');
      return next();
    }
  };
  ctx.on('tools/pre-execute', handler);
  return () => {};
}

/**
 * 阶段矩阵（给 README / 测试 / 提示段共用的一张静态表）。
 * 注意 `script` 类工具的真实门槛是 briefReady，不是阶段——见 decideGate。
 */
export const STAGE_MATRIX = {
  stages: STAGES,
  allow: {
    idle: ['brief', 'stage', 'read-only', 'other'],
    clarify: ['brief', 'stage', 'read-only', 'other'],
    script: ['brief', 'stage', 'script', 'read-only', 'other'],
    style: ['brief', 'stage', 'script', 'style', 'read-only', 'other'],
    locked: ['brief', 'stage', 'script', 'style', 'video-write', 'file-write', 'read-only', 'other'],
    build: ['brief', 'stage', 'script', 'style', 'video-write', 'file-write', 'export', 'read-only', 'other'],
  },
};
