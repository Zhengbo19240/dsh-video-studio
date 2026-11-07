/**
 * 测试隔离：把「会话↔工程绑定表」与「启用登记表」指到本进程私有的临时文件。
 *
 * 为什么必须有：这两个文件是**跨会话的真实状态**
 *   ~/.dsh/video-workbench-bindings.json
 *   ~/.dsh/video-enabled.json
 * 测试如果直接往里写，会留下 session-test / s1 这类垃圾条目，还会让下一次
 * 测试读到上一次的残留（额度被占、工程被绑定到别的会话），结果时绿时红。
 *
 * 用法（任何会调用 ProjectStore.open / restore / rebind / delete，或
 * 启用登记表的测试，都要在第一次调用之前接上）：
 *
 *   import { useTempBindings } from './_bindings-guard.mjs';
 *   const cleanupBindings = useTempBindings('smoke');
 *   ...
 *   cleanupBindings();   // 可选：进程退出时也会自动清
 *
 * 文件名固定为 os.tmpdir()/vw-bind-<name>-<pid>.json
 *                os.tmpdir()/vw-enabled-<name>-<pid>.json
 * cleanup 会删掉这两个文件（含写盘时的 .tmp-<pid> 中间文件）并还原环境变量。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_BINDINGS = 'DSH_VIDEO_BINDINGS';
const ENV_ENABLED = 'DSH_VIDEO_ENABLED';

/** 名字只用来区分文件，避免测试之间互相覆盖。 */
function safeTag(name) {
  const tag = String(name == null ? '' : name)
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return tag || 'test';
}

/**
 * 把两个路径环境变量指向本进程的临时文件。
 *
 * @param {string} name 测试名，用于文件名区分
 * @returns {() => void} cleanup：删临时文件并还原环境变量（幂等）
 */
export function useTempBindings(name) {
  const tag = safeTag(name);
  const files = {
    [ENV_BINDINGS]: path.join(os.tmpdir(), `vw-bind-${tag}-${process.pid}.json`),
    [ENV_ENABLED]: path.join(os.tmpdir(), `vw-enabled-${tag}-${process.pid}.json`),
  };
  const before = {
    [ENV_BINDINGS]: process.env[ENV_BINDINGS],
    [ENV_ENABLED]: process.env[ENV_ENABLED],
  };

  process.env[ENV_BINDINGS] = files[ENV_BINDINGS];
  process.env[ENV_ENABLED] = files[ENV_ENABLED];

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;

    for (const file of Object.values(files)) {
      // writeBindings / writeRegistry 都是「写临时文件再 rename」，两处都清
      for (const target of [file, file + '.tmp-' + process.pid]) {
        try {
          fs.rmSync(target, { force: true });
        } catch {
          /* 删不掉也不该让测试失败 */
        }
      }
    }

    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  // 测试里大量 process.exit()，靠 exit 钩子兜底清理，避免漏删
  process.once('exit', cleanup);
  return cleanup;
}
