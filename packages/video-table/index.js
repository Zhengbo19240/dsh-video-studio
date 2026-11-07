/**
 * Host half of dsh-video-workbench.
 *
 * 关键约束：这个插件的任何失败都不能让 DSH 的 web boot 崩掉。
 * DSH 把「未激活的 entry」当作致命错误，所以这里的每一步都自己兜底：
 * 注册失败只记日志，不向上抛。
 */

import { ProjectStore } from './src/store.mjs';
import { registerVideoRoutes } from './src/routes.mjs';
import { videoTools } from './src/tools.mjs';
import { motionTools } from './src/motion-tools.mjs';
import { cameraTools } from './src/camera-tools.mjs';
import { storyboardTools } from './src/storyboard-tools.mjs';
import { soundTools } from './src/sound-tools.mjs';
import { asrTools } from './src/asr-tools.mjs';
import { analyzeTools } from './src/analyze-tools.mjs';
import { ttsTools } from './src/tts.mjs';
import { ensureDefaultSoundSources } from './src/sound-lib.mjs';
import { SampleBroker } from './src/samples.mjs';

export const name = 'dsh-video-workbench';
export const inject = ['tools', 'webServer'];

export function apply(ctx) {
  if (process.env.DSH_VIDEO_WORKBENCH_DISABLE === '1') return;
  try {
    applyInner(ctx);
  } catch (e) {
    try {
      console.error('[video-workbench] activation failed:', (e && e.message) || e);
    } catch {
      /* 连日志都写不了就算了 */
    }
  }
}

function applyInner(ctx) {
  const store = new ProjectStore();
  const samples = new SampleBroker();
  const log = (message) => {
    try {
      const logger = ctx.logger || (ctx.get && ctx.get('logger'));
      if (logger && typeof logger.info === 'function') logger.info('[video-workbench] ' + message);
      else console.log('[video-workbench] ' + message);
    } catch {
      /* ignore */
    }
  };

  // 声音库首次启动兜底：没有配置且本机有 ~/.dsh/sound-library 时，建出 kenney 目录与配置文件。
  // 写失败只记一行 warning，绝不让 activation 崩掉。
  ctx.effect(() => {
    let alive = true;
    ensureDefaultSoundSources()
      .then((result) => {
        if (!alive) return;
        if (result && result.created) log('sound sources: 已创建 ' + result.file);
        else if (result && result.warning) log('sound sources: ' + result.warning);
      })
      .catch((e) => {
        if (alive) log('sound sources init skipped: ' + ((e && e.message) || e));
      });
    return () => {
      alive = false;
    };
  });

  // 路由：重复注册（HMR / 双实例）会被 webServer 拒绝，只记日志
  ctx.effect(() => {
    try {
      const dispose = registerVideoRoutes(ctx, store, log, samples);
      log('routes registered');
      return typeof dispose === 'function' ? dispose : () => {};
    } catch (e) {
      log('routes registration skipped: ' + ((e && e.message) || e));
      return () => {};
    }
  });

  // 工具：逐个注册，单个失败不影响其余，也绝不向外抛
  ctx.effect(() => {
    const disposers = [];
    let definitions = [];
    try {
      definitions = [
        ...videoTools({ store, samples }),
        ...motionTools({ store }),
        ...cameraTools({ store }),
        ...storyboardTools({ store }),
        ...soundTools({ store }),
        ...asrTools({ store }),
        // 配音：只在用户明确要求时合成；probe 只读，不联网合成
        ...ttsTools({ store }),
        // 视频解析：只在用户要求时跑，导入路径上没有任何自动调用
        ...analyzeTools({ store }),
      ];
    } catch (e) {
      log('tool list failed: ' + ((e && e.message) || e));
      return () => {};
    }
    for (const definition of definitions) {
      try {
        disposers.push(ctx.tools.register(definition));
      } catch (e) {
        log('tool skipped (' + definition.name + '): ' + ((e && e.message) || e));
      }
    }
    log('tools registered: ' + disposers.length + '/' + definitions.length);
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
    };
  });
}
