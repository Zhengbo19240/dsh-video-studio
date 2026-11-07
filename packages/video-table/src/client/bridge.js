/**
 * Client bridge: the only place that talks to the Host.
 *
 * UI rules enforced here:
 *  - every mutation goes through dispatch() (preview → apply), never a direct write
 *  - reads are small; binary data goes through /api/video/media
 *  - a single shared store notifies components; no component owns project state
 */

export async function rpc(method, params) {
  const res = await fetch('/api/video/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params: params || {} }),
  });
  let payload;
  try {
    payload = await res.json();
  } catch {
    throw Object.assign(new Error('服务返回了非 JSON 响应'), { code: 'BAD_RESPONSE' });
  }
  if (!payload || payload.ok !== true) {
    const err = new Error((payload && payload.error && payload.error.message) || '调用失败');
    err.code = payload && payload.error && payload.error.code;
    err.details = payload && payload.error && payload.error.details;
    throw err;
  }
  return payload.value;
}

const listeners = new Set();

export const state = {
  sessionId: null,
  projectId: null,
  doc: null,
  clips: [],
  assets: [],
  // 项目启用制：enabled 是全局登记表（跨会话共享额度），mine 是本会话的工程，
  // active 表示「工作台此刻真的挂载了」—— 启动时它是 false，绝不自动挂载。
  enabled: [],
  max: 2,
  mine: [],
  active: null,
  selection: null, // { kind: 'clip' | 'annotation', id }
  playhead: 0,
  playing: false,
  zoom: 70, // px per second
  busy: null, // { label, ratio } | null
  error: null,
  toast: null,
  history: [],
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setState(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) fn();
}

let toastTimer = null;
export function toast(message, tone) {
  setState({ toast: { message, tone: tone || 'info' } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setState({ toast: null }), 4000);
}

const CODE_HINT = {
  REVISION_CONFLICT: '数据已更新，正在刷新，请再试一次',
  REF_NOT_FOUND: '目标不存在（可能已被删除）',
  BOUND_TO_OTHER_SESSION: '这个工程绑定在另一个会话上',
  OUTSIDE_PROJECT: '路径越出工程目录，已拒绝',
  INVALID_OP: '这个操作在当前状态下不合法',
  INVALID_ARG: '参数不合法',
  WORKBENCH_OFFLINE: '工作台没有打开，采样请求失败',
  NO_ENCODER: '浏览器没有可用的视频编码器',
  PAYLOAD_TOO_LARGE: '文件太大',
};

export function reportError(e, fallback) {
  const message = (e && e.message) || fallback || '未知错误';
  setState({ error: e && e.code ? `${e.code} · ${message}` : message });
  const friendly = (e && e.code && CODE_HINT[e.code]) || message;
  toast(friendly, 'warn');
  if (e && e.code === 'REVISION_CONFLICT') refresh().catch(() => {});
  console.error('[video-workbench]', e);
}

// --------------------------------------------------------------- project ----

export async function openProject(dir) {
  const value = await rpc('project.open', { dir, sessionId: state.sessionId });
  setState({ projectId: value.doc.projectId, doc: value.doc });
  await refresh();
  return value.doc;
}

export async function restoreProject() {
  if (!state.sessionId) return null;
  const value = await rpc('project.restore', { sessionId: state.sessionId });
  if (!value || !value.doc) return null;
  setState({ projectId: value.doc.projectId, doc: value.doc });
  await refresh();
  return value.doc;
}

// ------------------------------------------------------- enabled / session ----
//
// 全局限额只有 2。这里的每个动作都只是 RPC 的薄包装：真正判额度、抛
// ENABLED_LIMIT 的是 Host 的 enabled-registry —— 客户端不自己算额度，也不兜底。

export function isProjectEnabled(projectId) {
  return (state.enabled || []).some((x) => x.projectId === projectId);
}

export function enabledBy(projectId) {
  return (state.enabled || []).find((x) => x.projectId === projectId) || null;
}

export async function loadEnabled() {
  const value = await rpc('project.enabled.list', {});
  setState({ enabled: (value && value.enabled) || [], max: (value && value.max) || 2 });
  return value;
}

/** 本会话的工程列表（切换菜单用）。sessionId 缺省取 state 里的。 */
export async function loadMyProjects(sessionId) {
  const sid = sessionId || state.sessionId;
  if (!sid) return [];
  const value = await rpc('project.list', { sessionId: sid });
  const list = (value && value.projects) || [];
  setState({ mine: list });
  return list;
}

/**
 * 启用：带上 root，Host 才能在工程没打开时自己 open 再启用。
 *
 * 为什么必须带 dir：旧实现只传 projectId，Host 第一行 store.get 就抛 REF_NOT_FOUND
 * （工程没在本进程打开），而客户端又是「先启用后打开」—— 两边互为前提，永远点不动。
 * sessionId 也要带：自愈打开需要「以谁的身份开」，由 store.open 校验 BOUND_TO_OTHER_SESSION。
 */
export async function enableProject(projectId, root) {
  const value = await rpc('project.enable', {
    projectId,
    dir: root || undefined,
    sessionId: state.sessionId,
  });
  setState({ enabled: (value && value.enabled) || [], max: (value && value.max) || 2 });
  return value;
}

export async function disableProject(projectId) {
  const value = await rpc('project.disable', { projectId });
  setState({ enabled: (value && value.enabled) || [], max: (value && value.max) || 2 });
  return value;
}

export async function renameProject(projectId, sessionId, title) {
  const value = await rpc('project.rename', {
    projectId,
    sessionId: sessionId || state.sessionId,
    title,
  });
  return value && value.doc;
}

/** 换绑：Host 侧负责「停旧 → 启新 → 写绑定」，失败时绑定不动。 */
export async function rebindProject(projectId, sessionId) {
  const value = await rpc('session.rebind', {
    sessionId: sessionId || state.sessionId,
    projectId,
  });
  return value;
}

export async function deleteProject(deleteFiles) {
  const doc = state.doc;
  if (!doc) return null;
  const value = await rpc('project.delete', {
    projectId: doc.projectId,
    sessionId: state.sessionId,
    deleteFiles: !!deleteFiles,
  });
  setState({ projectId: null, doc: null, clips: [], assets: [], selection: null, playhead: 0 });
  return value;
}

export async function refresh() {
  if (!state.projectId) return;
  const value = await rpc('project.timeline', { projectId: state.projectId });
  const order = new Map((value.doc.tracks || []).map((tr, i) => [tr.id, i]));
  const sorted = (value.clips.clips || []).slice().sort((a, b) => {
    const d = (order.get(a.trackId) ?? 99) - (order.get(b.trackId) ?? 99);
    return d !== 0 ? d : a.start - b.start;
  });
  /**
   * ★ 标注必须随 doc 一起进来。
   *
   * 时间线的标注轨（胶囊 / 「标注轨 N / 未处理 N」）和右侧「标注」页读的都是
   * `state.doc.annotations`，只有这一个来源。Host 曾经只回摘要（没有这个字段），
   * 于是每次写操作之后 refresh 都会把 annotations 覆盖成 undefined ——
   * 磁盘上有标注，界面却显示 0，用户以为「点了没反应」。
   *
   * 这里做两层：Host 没给（老版本 / 只有摘要）就退到响应里的 annotations，
   * 再没有就保留上一份；**只在字段整个缺失时兜底**，空数组一律当真（删除后要立刻消失）。
   * 静默吞掉不再可能：拿不到就保留已知数据，并在控制台留一条可追的警告。
   */
  const rawDoc = value.doc || {};
  let annotations;
  if (Array.isArray(rawDoc.annotations)) annotations = rawDoc.annotations;
  else if (Array.isArray(value.annotations)) annotations = value.annotations;
  else if (state.doc && Array.isArray(state.doc.annotations)) annotations = state.doc.annotations;
  else annotations = [];
  if (!Array.isArray(rawDoc.annotations) && !Array.isArray(value.annotations)) {
    console.warn('[video-workbench] project.timeline 没带 annotations，暂用上一份；宿主与客户端版本可能不一致');
  }
  setState({
    doc: { ...rawDoc, annotations },
    clips: sorted,
    assets: value.assets || state.assets,
    error: null,
  });
}

export async function dispatch(ops, summary) {
  const doc = state.doc;
  if (!doc) throw new Error('工程未打开');
  const p = await rpc('edit.preview', {
    projectId: doc.projectId,
    sessionId: state.sessionId,
    baseRevision: doc.revision,
    summary: summary || '',
    ops,
  });
  const applied = await rpc('edit.apply', { previewId: p.previewId, sessionId: state.sessionId });
  await refresh();
  return applied;
}

export async function undo(transactionId) {
  return rpc('edit.undo', { projectId: state.projectId, sessionId: state.sessionId, transactionId });
}

// ------------------------------------------------------------------- tts ----
//
// 配音：probe 只读探测（缺什么当场摆出来），voices 给下拉，speak 一次事务完成
// 「合成 → 登记素材 → a1 配音 + t1 字幕」。这里只是 RPC 的薄包装，判断都在 Host。

export async function ttsProbe() {
  return rpc('tts.probe', {});
}

export async function ttsVoices() {
  const value = await rpc('tts.voices', {});
  return {
    provider: (value && value.provider) || null,
    voices: (value && value.voices) || [],
  };
}

export async function ttsSpeak(text, options = {}) {
  const value = await rpc('tts.speak', {
    projectId: state.projectId,
    sessionId: state.sessionId,
    text,
    ...options,
  });
  await refresh();
  return value;
}

// ----------------------------------------------------------------- media ----

export function mediaUrl(assetId, options = {}) {
  const base = `/api/video/media?projectId=${encodeURIComponent(state.projectId)}&assetId=${encodeURIComponent(assetId)}`;
  // 预览请求备份副本；服务端没有 previewPath 时自动回落到原片
  return options.preview ? base + '&variant=preview' : base;
}

// ------------------------------------------------------------ 风格样片 S1 ----
//
// 关键帧 PNG 与 8 秒 MP4 都在预览目录里，走 /api/video/style-file 读；
// 写回走 /api/video/style-upload（原始字节，不经 RPC 的 1MB 请求体）。
// 路径一律是工程内相对路径，由 Host 算，客户端不自报。

/** 预览目录里一个文件的 URL；v 用来破缓存（同一路径会随 spec 变化被重写）。 */
export function styleFileUrl(relPath, stamp) {
  return styleFileUrlFor(state.projectId, relPath, stamp);
}

/** 同上，但显式指定工程 —— 只读面板从 props 拿 projectId，不依赖全局 state。 */
export function styleFileUrlFor(projectId, relPath, stamp) {
  const base =
    '/api/video/style-file?projectId=' + encodeURIComponent(projectId == null ? state.projectId : projectId) +
    '&relPath=' + encodeURIComponent(relPath);
  return stamp ? base + '&v=' + encodeURIComponent(stamp) : base;
}

/**
 * 把一帧 PNG 或 8 秒样片传回 Host。
 *
 * @param {Blob} blob
 * @param {{ kind: 'frame'|'video', index?: number, shotKind?: string }} options
 * @returns {Promise<{relPath: string, absPath: string, bytes: number}>}
 */
export function uploadStyleAsset(blob, options = {}) {
  const params = new URLSearchParams({
    projectId: String(state.projectId || ''),
    sessionId: String(state.sessionId || ''),
    kind: options.kind === 'video' ? 'video' : 'frame',
  });
  if (params.get('kind') === 'frame') {
    params.set('index', String(options.index == null ? 0 : options.index));
    params.set('shotKind', String(options.shotKind || ''));
  } else if (options.container) {
    // 导出的容器可能是 webm（这台机器没有 H.264 编码器），文件名要跟着容器走
    params.set('container', options.container === 'webm' ? 'webm' : 'mp4');
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/video/style-upload?' + params.toString(), true);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.onload = () => {
      let payload = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        return reject(Object.assign(new Error('上传响应无法解析'), { code: 'BAD_RESPONSE' }));
      }
      if (xhr.status >= 400 || !payload || !payload.ok) {
        const err = payload && payload.error ? payload.error : { code: 'UPLOAD_FAILED', message: '上传失败' };
        return reject(Object.assign(new Error(err.message), err));
      }
      resolve(payload.value);
    };
    xhr.onerror = () => reject(Object.assign(new Error('网络错误，样片上传中断'), { code: 'NETWORK' }));
    xhr.send(blob);
  });
}

export async function scanAssets() {
  const value = await rpc('asset.scan', { projectId: state.projectId });
  return value.files;
}

export function uploadFile(file, onProgress) {
  const url =
    '/api/video/import?projectId=' + encodeURIComponent(state.projectId) +
    '&sessionId=' + encodeURIComponent(state.sessionId) +
    '&name=' + encodeURIComponent(file.name);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.min(0.99, e.loaded / e.total));
    };
    xhr.onload = () => {
      let payload = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        return reject(Object.assign(new Error('导入响应无法解析'), { code: 'BAD_RESPONSE' }));
      }
      if (xhr.status >= 400 || !payload || !payload.ok) {
        const err = payload && payload.error ? payload.error : { code: 'IMPORT_FAILED', message: '导入失败' };
        return reject(Object.assign(new Error(err.message), err));
      }
      if (onProgress) onProgress(1);
      resolve(payload.value.asset);
    };
    xhr.onerror = () => reject(Object.assign(new Error('网络错误，导入中断'), { code: 'NETWORK' }));
    xhr.send(file);
  });
}

export async function syncAssetsFromDisk() {
  const value = await rpc('asset.scan', { projectId: state.projectId });
  const have = new Set((state.doc ? state.doc.assets : []).map((a) => a.path));
  const missing = (value.files || []).filter((f) => !have.has(f.relPath));
  if (!missing.length) return 0;
  const ops = missing.map((f) => ({
    type: 'asset.add',
    assetId: 'asset_' + Math.random().toString(36).slice(2, 10),
    relPath: f.relPath,
    name: f.name,
    size: f.size,
    hash: null,
    mime: f.mime,
  }));
  await dispatch(ops, '登记已有素材');
  return missing.length;
}

export function timeToPx(t) {
  return Math.round(t * state.zoom);
}

export function pxToTime(px) {
  return Math.max(0, px / state.zoom);
}

export function fmtTime(t) {
  const s = Math.max(0, t || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
}
