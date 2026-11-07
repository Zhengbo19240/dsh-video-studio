/**
 * Host half of dsh-video-brief.
 *
 * 它做三件事：十一个工具（brief 两个 / 参考素材两个 / 阶段两个 / 脚本三个 / 风格两个）、
 * 一个按六阶段矩阵判定的 `tools/pre-execute` 门禁、一段系统提示。
 *
 * 硬约束（抄自 dsh-video-workbench 的教训）：任何一步失败都不能让 DSH boot 崩掉。
 * 这里每一步各自兜底，注册失败只写日志，绝不向上抛。
 */

import path from 'node:path';

import { normalizeConfig } from './src/config.mjs';
import { evaluateBrief } from './src/brief.mjs';
import { createBriefStore, createScriptStore, createStateStore, createStyleStore } from './src/store.mjs';
import { registerGate } from './src/gate.mjs';
import { createStageService } from './src/stage.mjs';
import { resolveWorkspaceRoot } from './src/workspace.mjs';
import { globalMemoryPath } from './src/memory.mjs';
import { SECTION_NAME, SECTION_ORDER, buildPromptText } from './src/prompt.mjs';
import { createVideoBriefTools } from './src/tools.mjs';

/** 插件名。 */
export const name = 'dsh-video-brief';

/** 硬依赖：没有工具服务就不装配。 */
export const inject = ['tools'];

/** 环境变量总开关（排查用，不需要改配置）。 */
const DISABLE_ENV = 'DSH_VIDEO_BRIEF_DISABLE';

/** 解析工程根目录时用的 cwd（门禁里判断相对路径）。 */
function workspaceCwd(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.trim() !== '' ? path.resolve(cwd.trim()) : process.cwd();
}

/**
 * 插件装配入口。
 * @param {object} ctx Cordis 上下文
 * @param {unknown} rawConfig 来自 cordis.patch.yml 的 config
 */
export function apply(ctx, rawConfig) {
  if (process.env[DISABLE_ENV] === '1') {
    safeLog(ctx, `${DISABLE_ENV}=1，插件不激活`, 'info');
    return;
  }
  let config;
  try {
    config = normalizeConfig(rawConfig);
  } catch (error) {
    safeLog(ctx, `配置归一化失败，用默认值：${(error && error.message) || error}`, 'warn');
    config = normalizeConfig(undefined);
  }
  if (config.enabled === false) {
    safeLog(ctx, 'enabled=false，工具/门禁/提示段都不装配', 'info');
    return;
  }
  try {
    applyInner(ctx, config);
  } catch (error) {
    safeLog(ctx, `activation failed: ${(error && error.message) || error}`, 'error');
  }
}

/** 写日志：优先宿主 logger，其次 console；自身绝不抛错。 */
function safeLog(ctx, message, level = 'info') {
  const text = `[video-brief] ${message}`;
  try {
    const logger = (ctx && ctx.logger) || (ctx && typeof ctx.get === 'function' ? ctx.get('logger') : null);
    if (logger && typeof logger[level] === 'function') logger[level](text);
    else if (logger && typeof logger.info === 'function') logger.info(text);
    else console.log(text);
  } catch {
    /* 连日志都写不了就算了 */
  }
}

function applyInner(ctx, config) {
  const log = (message, level) => safeLog(ctx, message, level);

  // 同一个工程根共用一套 store（brief / state / script / style），才能共享写队列：
  // 并发 confirm、并发 advance、读时自愈都不会互相覆盖。
  const projects = new Map();
  const projectFor = (root) => {
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    let project = projects.get(key);
    if (!project) {
      project = {
        brief: createBriefStore({ projectRoot: root }),
        state: createStateStore({ projectRoot: root }),
        script: createScriptStore({ projectRoot: root }),
        style: createStyleStore({ projectRoot: root }),
      };
      projects.set(key, project);
    }
    return project;
  };
  const storeFor = (root) => projectFor(root).brief;
  const stateStoreFor = (root) => projectFor(root).state;
  const scriptStoreFor = (root) => projectFor(root).script;
  const styleStoreFor = (root) => projectFor(root).style;
  const workspaceRoot = (agent) => resolveWorkspaceRoot(ctx, agent);
  const readConfig = () => config;

  const stageService = createStageService({
    storeFor,
    stateStoreFor,
    scriptStoreFor,
    styleStoreFor,
    config: readConfig,
    now: () => Date.now(),
    log,
  });

  // 工具：逐个注册，单个失败不影响其他。
  ctx.effect(() => {
    const tools = ctx.get('tools');
    if (!tools || typeof tools.register !== 'function') {
      log('tools 服务不可用，工具未注册', 'warn');
      return () => {};
    }
    const disposers = [];
    let definitions = [];
    try {
      definitions = createVideoBriefTools({
        config: readConfig,
        storeFor,
        stateStoreFor,
        scriptStoreFor,
        styleStoreFor,
        stage: stageService,
        workspaceRoot,
        memoryPath: () => globalMemoryPath(),
        now: () => Date.now(),
        log,
      });
    } catch (error) {
      log(`工具定义构造失败：${(error && error.message) || error}`, 'warn');
      return () => {};
    }
    for (const definition of definitions) {
      try {
        disposers.push(tools.register(definition));
      } catch (error) {
        log(`工具跳过（${definition.name}）：${(error && error.message) || error}`, 'warn');
      }
    }
    log(`工具已注册 ${disposers.length}/${definitions.length}`);
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
    };
  }, 'dsh-video-brief: tools');

  // 门禁：读 brief/script/style/state → 阶段矩阵 → deny / warn / allow；locked 首次写操作自动 build。
  ctx.effect(() => {
    const readState = async (agent) => {
      const root = workspaceRoot(agent);
      const snap = await stageService.snapshot(root);
      const missing = snap.facts.missing.map((slot, index) => ({
        slot,
        title: snap.facts.missingTitles[index] ?? slot,
      }));
      return {
        stage: snap.state.stage,
        briefReady: snap.facts.briefReady,
        scriptConfirmed: snap.facts.scriptConfirmed,
        styleConfirmed: snap.facts.styleConfirmed,
        ready: snap.facts.briefReady,
        missing,
        projectRoot: root,
        cwd: workspaceCwd(agent),
        hasProject: snap.facts.hasProject,
      };
    };
    const onFirstWrite = async (root) => {
      if (typeof root !== 'string' || root.trim() === '') return;
      await stageService.autoBuild(root);
    };
    return registerGate(ctx, { mode: config.gate, readState, onFirstWrite, log });
  }, 'dsh-video-brief: gate');

  // 提示段：宿主这里的 section 只吃静态 text，所以写成阶段规则表，具体阶段由 video_stage_get 取。
  if (config.promptSection !== false) {
    try {
      ctx.inject(['systemPrompt'], (scoped) => {
        const systemPrompt = scoped.systemPrompt;
        if (!systemPrompt || typeof systemPrompt.section !== 'function') {
          scoped.logger?.warn?.('[video-brief] systemPrompt 服务不可用，提示段未注入');
          return;
        }
        scoped.effect(() => systemPrompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          interpolate: false,
          text: buildPromptText(),
        }), 'dsh-video-brief: prompt section');
      });
    } catch (error) {
      safeLog(ctx, `提示段注入失败：${(error && error.message) || error}`, 'warn');
    }
  }

  log(`已装配（gate=${config.gate}，maxRounds=${config.maxRounds}，stages=idle/clarify/script/style/locked/build）`, 'info');
}
