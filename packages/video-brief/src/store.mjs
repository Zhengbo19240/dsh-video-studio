/**
 * `.dsh-video/` 下四个 JSON 的存储层：brief.json / state.json / style.json / script.json。
 *
 * 关键设计（三份文件共用同一套，不另写）：
 * 1. **注入 fs**——默认用 node:fs/promises，测试传内存实现；
 * 2. **原子写**——先写 `*.tmp` 再 rename，任何时刻读到的都是完整 JSON；
 * 3. **串行化**——同一个 store 实例上的 update 走一条 promise 链，
 *    read-modify-write 不会互相覆盖（并发 confirm / 并发 advance 不丢数据）；
 * 4. **坏文件降级**——JSON 解析失败时备份成 `*.bak`，返回空值而不是抛错。
 *
 * brief / state 在通用 store 外各包一层适配器，保持原来的 `{brief}` / `{state}` 形状；
 * style / script 直接用通用 store（读出来是 `{style}` / `{script}`）。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { emptyBrief, normalizeBrief } from './brief.mjs';
import { emptyStageState, normalizeStageState } from './stage.mjs';
import { normalizeScript } from './script.mjs';
import { normalizeStyle } from './style.mjs';

/** 工程元数据目录名（与 dsh-video-workbench 一致）。 */
export const META_DIR = '.dsh-video';

/** 简报文件名。 */
export const BRIEF_FILE = 'brief.json';

/** 阶段状态文件名。 */
export const STATE_FILE = 'state.json';

/** 风格产物文件名。 */
export const STYLE_FILE = 'style.json';

/** 视频脚本文件名。 */
export const SCRIPT_FILE = 'script.json';

/** 默认文件系统（与注入接口同名同签名）。 */
export const defaultFs = {
  readFile: (file, encoding) => fsp.readFile(file, encoding),
  writeFile: (file, data, encoding) => fsp.writeFile(file, data, encoding),
  mkdir: (dir, options) => fsp.mkdir(dir, options),
  rename: (from, to) => fsp.rename(from, to),
  copyFile: (from, to) => fsp.copyFile(from, to),
  stat: (file) => fsp.stat(file),
};

/** 工程元数据目录。 */
export function metaDir(projectRoot) {
  return path.join(projectRoot, META_DIR);
}

/** 简报文件路径。 */
export function briefPath(projectRoot) {
  return path.join(metaDir(projectRoot), BRIEF_FILE);
}

/** 阶段状态文件路径。 */
export function statePath(projectRoot) {
  return path.join(metaDir(projectRoot), STATE_FILE);
}

/** 风格产物文件路径。 */
export function stylePath(projectRoot) {
  return path.join(metaDir(projectRoot), STYLE_FILE);
}

/** 视频脚本文件路径。 */
export function scriptPath(projectRoot) {
  return path.join(metaDir(projectRoot), SCRIPT_FILE);
}

/** 解析成绝对路径；空值返回 null。 */
function resolveRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') return null;
  return path.resolve(projectRoot.trim());
}

/**
 * 通用 JSON store。
 *
 * @param {{
 *   projectRoot: string,
 *   fileName: string,
 *   empty: (ctx:{now:number}) => any,
 *   normalize?: (raw:any, ctx:{now:number}) => any,
 *   fs?: object,
 *   now?: () => number,
 * }} options
 */
export function createJsonStore(options = {}) {
  const root = resolveRoot(options.projectRoot);
  if (!root) throw new Error('createJsonStore 需要 projectRoot');
  if (typeof options.fileName !== 'string' || options.fileName.trim() === '') {
    throw new Error('createJsonStore 需要 fileName');
  }
  const fs = options.fs ?? defaultFs;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const empty = typeof options.empty === 'function' ? options.empty : () => null;
  const normalize = typeof options.normalize === 'function' ? options.normalize : (raw) => raw;
  const dir = metaDir(root);
  const file = path.join(dir, options.fileName);

  // 同一个实例上的写操作排队，避免 read-modify-write 互相踩。
  let chain = Promise.resolve();
  let tmpSeq = 0;

  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 原子写：临时文件 + rename。 */
  async function writeFileAtomic(value) {
    await fs.mkdir(dir, { recursive: true });
    tmpSeq += 1;
    const tmp = `${file}.${process.pid}.${now()}.${tmpSeq}.tmp`;
    const payload = `${JSON.stringify(value, null, 2)}\n`;
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, file);
    return file;
  }

  /** 备份坏文件（失败不抛：备份只是止损，不该把读取也拖垮）。 */
  async function backupCorrupt() {
    const bak = `${file}.bak`;
    try {
      await fs.copyFile(file, bak);
      return bak;
    } catch {
      return null;
    }
  }

  function emptyValue() {
    return empty({ now: now() });
  }

  /**
   * 读。文件不存在 → empty；JSON 坏了 → 备份后 empty。
   * @returns {Promise<{value:any, exists:boolean, corrupt:boolean, invalid:boolean,
   *   backup:string|null, file:string, root:string}>}
   */
  async function read() {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      return { value: emptyValue(), exists: false, corrupt: false, invalid: false, backup: null, file, root };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const backup = await backupCorrupt();
      return { value: emptyValue(), exists: true, corrupt: true, invalid: false, backup, file, root };
    }
    const value = normalize(parsed, { now: now() });
    return {
      value,
      exists: true,
      corrupt: false,
      invalid: value === null || value === undefined,
      backup: null,
      file,
      root,
    };
  }

  /** 覆盖写（调用方保证是完整对象；normalize 之后落盘）。 */
  async function write(value) {
    const safe = normalize(value, { now: now() });
    if (safe === null || safe === undefined) throw new Error(`${options.fileName} 归一化后为空，拒绝写入`);
    await writeFileAtomic(safe);
    return { value: safe, file, written: true };
  }

  /**
   * 串行的 read-modify-write。
   * mutator 收到当前值，返回 `{ value }`；返回 `{ skip: true }` 表示不写盘。
   */
  async function update(mutator) {
    return enqueue(async () => {
      const current = await read();
      const result = await mutator(current.value, current);
      if (!result || result.skip === true || result.value === undefined || result.value === null) {
        return { ...(result ?? {}), written: false, value: current.value, file };
      }
      const safe = normalize(result.value, { now: now() });
      if (safe === null || safe === undefined) {
        throw new Error(`${options.fileName} 归一化后为空，拒绝写入`);
      }
      await writeFileAtomic(safe);
      return { ...result, value: safe, written: true, file };
    });
  }

  /** 工程元数据目录是否存在（判断"这是不是一个视频工程"）。 */
  async function hasMetaDir() {
    try {
      await fs.stat(dir);
      return true;
    } catch {
      return false;
    }
  }

  return { root, dir, file, fileName: options.fileName, read, write, update, hasMetaDir };
}

/**
 * brief.json 适配器：保持 `{ brief }` 形状。
 * @param {{projectRoot:string, fs?:object, now?:()=>number}} options
 */
export function createBriefStore(options = {}) {
  const json = createJsonStore({
    ...options,
    fileName: BRIEF_FILE,
    empty: (ctx) => emptyBrief(ctx.now),
    normalize: (raw) => normalizeBrief(raw),
  });

  async function read() {
    const result = await json.read();
    return {
      brief: result.value,
      exists: result.exists,
      corrupt: result.corrupt,
      backup: result.backup,
      file: result.file,
      root: result.root,
    };
  }

  async function write(brief) {
    const result = await json.write(brief);
    return { brief: result.value, file: result.file, written: true };
  }

  async function update(mutator) {
    const result = await json.update(async (brief, current) => {
      const out = await mutator(brief, current);
      if (!out || out.skip === true || !out.brief) return { ...(out ?? {}), skip: true };
      return { ...out, value: out.brief };
    });
    return { ...result, brief: result.value, file: result.file };
  }

  return {
    root: json.root,
    dir: json.dir,
    file: json.file,
    read,
    write,
    update,
    hasMetaDir: json.hasMetaDir,
  };
}

/**
 * state.json 适配器：保持 `{ state }` 形状。
 * @param {{projectRoot:string, fs?:object, now?:()=>number}} options
 */
export function createStateStore(options = {}) {
  const json = createJsonStore({
    ...options,
    fileName: STATE_FILE,
    empty: (ctx) => emptyStageState(ctx.now),
    normalize: (raw, ctx) => normalizeStageState(raw, ctx.now),
  });

  async function read() {
    const result = await json.read();
    return {
      state: result.value,
      exists: result.exists,
      corrupt: result.corrupt,
      backup: result.backup,
      file: result.file,
      root: result.root,
    };
  }

  async function write(state) {
    const result = await json.write(state);
    return { state: result.value, file: result.file, written: true };
  }

  async function update(mutator) {
    const result = await json.update(async (state, current) => {
      const out = await mutator(state, current);
      if (!out || out.skip === true || !out.state) return { ...(out ?? {}), skip: true };
      return { ...out, value: out.state };
    });
    return { ...result, state: result.value, file: result.file };
  }

  return {
    root: json.root,
    dir: json.dir,
    file: json.file,
    read,
    write,
    update,
    hasMetaDir: json.hasMetaDir,
  };
}

/**
 * style.json：直接暴露通用 store，读出来是 `{ style }`（未确认 / 不合法 → null）。
 * @param {{projectRoot:string, fs?:object, now?:()=>number}} options
 */
export function createStyleStore(options = {}) {
  const json = createJsonStore({
    ...options,
    fileName: STYLE_FILE,
    empty: () => null,
    normalize: (raw, ctx) => normalizeStyle(raw, { now: ctx.now }),
  });

  async function read() {
    const result = await json.read();
    return {
      style: result.value,
      exists: result.exists,
      corrupt: result.corrupt,
      invalid: result.invalid,
      backup: result.backup,
      file: result.file,
      root: result.root,
    };
  }

  async function write(style) {
    const result = await json.write(style);
    return { style: result.value, file: result.file, written: true };
  }

  return {
    root: json.root,
    dir: json.dir,
    file: json.file,
    read,
    write,
    hasMetaDir: json.hasMetaDir,
  };
}

/**
 * script.json：暴露 `{ script }` 形状（未写 / 坏结构 / 校验失败 → null）。
 * @param {{projectRoot:string, fs?:object, now?:()=>number}} options
 */
export function createScriptStore(options = {}) {
  const json = createJsonStore({
    ...options,
    fileName: SCRIPT_FILE,
    empty: () => null,
    normalize: (raw, ctx) => normalizeScript(raw, { now: ctx.now }),
  });

  async function read() {
    const result = await json.read();
    return {
      script: result.value,
      exists: result.exists,
      corrupt: result.corrupt,
      invalid: result.invalid,
      backup: result.backup,
      file: result.file,
      root: result.root,
    };
  }

  async function write(script) {
    const result = await json.write(script);
    return { script: result.value, file: result.file, written: true };
  }

  async function update(mutator) {
    const result = await json.update(async (script, current) => {
      const out = await mutator(script, current);
      if (!out || out.skip === true || out.script === undefined || out.script === null) {
        return { ...(out ?? {}), skip: true };
      }
      return { ...out, value: out.script };
    });
    return { ...result, script: result.value, file: result.file };
  }

  return {
    root: json.root,
    dir: json.dir,
    file: json.file,
    read,
    write,
    update,
    hasMetaDir: json.hasMetaDir,
  };
}
