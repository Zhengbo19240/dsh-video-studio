/**
 * 摄像机连续性的 agent 工具（只读）。
 *
 * 只做一个动作：`video_camera_check` —— 扫时间线上首尾相接的片段，
 * 逐对比「上一镜的出口机位」和「下一镜的入口机位」。
 *
 * 为什么是只读的：
 *   - 它不改时间线、不拿写租约、不落盘；
 *   - 不通过时**不阻止播放**，只把可读警告放进返回体（warnings）。
 *
 * 机位从哪来（优先级从高到低）：
 *   1. 片段自己的 `props.camera`（{in:{scale,x,y}, out:{...}}）—— 一次性的覆盖；
 *   2. 卡片 code.js 里的 `export const camera = { in, out }`（可写成函数，入参 props）；
 *   3. 卡片 meta.json 里的 `camera` 字段（宿主没执行代码时的兜底）；
 *   4. 都没有 → 恒等机位（1/0/0），老卡不受影响。
 *
 * 边界帧怎么取（“复用取边界帧”的机位版）：
 *   卡片若导出了 `cameraAt(t, duration, props)`，就**真的按卡片的曲线采样**首帧 / 末帧；
 *   没有导出时退回声明的 in / out。两条路都不需要浏览器 —— 机位是声明与纯函数，
 *   不是像素；transition host 的 composed frame 解决的是「相邻两镜长什么样」，
 *   这里解决的是「相邻两镜的机位接不接得上」，同一套「按时间取邻镜」的边界语义。
 *
 * 卡片代码在哪：优先工程里的快照 `<root>/code/<layerId>/index.js`（那才是真正在渲染的），
 * 没有时退回 `~/.dsh/motion-lib/<entryId>/code.js`。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { motionRoot } from './motion-lib.mjs';
import {
  CAMERA_EPS,
  cameraKeyframes,
  normalizeCamera,
  normalizeCameraSpec,
  scanCameraContinuity,
} from './camera.mjs';
import { sanitizeJson } from './json-safe.mjs';

const textBlocks = (value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
];

function define(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: { schema: { type: 'object' }, render: (_args, value) => textBlocks(value) },
    execute,
  };
}

/** 模块缓存：文件 + mtime 变了就重新 import（避免读到热修前的旧代码）。 */
const moduleCache = new Map();

async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

/**
 * 载入一个卡片的模块。返回 { mod, file } 或 null。
 * 读不到 / 语法坏 / 顶层抛错都只返回 null —— 一张坏卡不该让整次检查失败。
 */
async function loadCardModule(root, clip) {
  const entryId = String((clip.provenance && clip.provenance.assetId) || '').replace(/^motion-/, '');
  const layerId = String(clip.layerId || '').replace(/^motion-/, '');
  const candidates = [];
  if (root && clip.layerId) candidates.push(path.join(root, 'code', String(clip.layerId), 'index.js'));
  if (entryId) candidates.push(path.join(motionRoot(), entryId, 'code.js'));
  else if (layerId) candidates.push(path.join(motionRoot(), layerId, 'code.js'));

  for (const file of candidates) {
    const stat = await statOrNull(file);
    if (!stat || !stat.isFile()) continue;
    const key = file + '@' + stat.mtimeMs;
    if (moduleCache.has(key)) return moduleCache.get(key);
    try {
      const mod = await import(pathToFileURL(file).href + '?v=' + stat.mtimeMs);
      const hit = { mod, file, entryId: entryId || layerId || null };
      moduleCache.set(key, hit);
      return hit;
    } catch {
      // 语法错 / 顶层异常：当成「没有 camera 声明」，继续找下一份
    }
  }
  return null;
}

/** meta.json 的 camera 兜底（宿主不执行卡片代码时的最后一条路）。 */
async function metaCamera(entryId) {
  if (!entryId) return null;
  try {
    const raw = await fs.readFile(path.join(motionRoot(), entryId, 'meta.json'), 'utf8');
    const meta = JSON.parse(raw);
    return meta && meta.camera ? meta.camera : null;
  } catch {
    return null;
  }
}

/** 卡片声明的 camera（对象或 (props) => 对象）。 */
function cameraDeclared(mod, props) {
  if (!mod) return null;
  const declared = mod.camera;
  if (!declared) return null;
  if (typeof declared === 'function') {
    try {
      return declared(props) || null;
    } catch {
      return null;
    }
  }
  return declared;
}

/**
 * 取一个片段的边界机位。
 * @returns {{ value:{scale,x,y}, declared:{scale,x,y}, sampled:boolean, source:string }}
 */
async function boundaryCamera(root, clip, side) {
  const props = (clip && clip.props) || {};
  const modInfo = clip && clip.type === 'code' ? await loadCardModule(root, clip) : null;
  const mod = modInfo ? modInfo.mod : null;

  // 1) 片段级覆盖
  let spec = null;
  let source = 'identity';
  if (props.camera) {
    spec = normalizeCameraSpec(props.camera);
    source = 'props';
  } else {
    const declared = cameraDeclared(mod, props);
    if (declared) {
      spec = normalizeCameraSpec(declared);
      source = 'card';
    } else {
      const meta = await metaCamera(modInfo && modInfo.entryId);
      if (meta) {
        spec = normalizeCameraSpec(meta);
        source = 'meta';
      }
    }
  }

  if (!spec) {
    return { value: { ...normalizeCamera(null) }, declared: normalizeCamera(null), sampled: false, source };
  }

  const declared = spec[side];
  const duration = Math.max(0, Number(clip.duration) || 0);
  if (mod && typeof mod.cameraAt === 'function') {
    try {
      const t = side === 'in' ? 0 : duration;
      const sampled = normalizeCamera(mod.cameraAt(t, duration, props));
      return { value: sampled, declared, sampled: true, source };
    } catch {
      // 曲线自己坏了：退回声明值，不让检查崩
    }
  }
  return { value: declared, declared, sampled: false, source };
}

function round6(v) {
  return Math.round(Number(v) * 1e6) / 1e6;
}

function sameCamera(a, b, eps) {
  return (
    Math.abs(Number(a.scale) - Number(b.scale)) <= eps &&
    Math.abs(Number(a.x) - Number(b.x)) <= eps &&
    Math.abs(Number(a.y) - Number(b.y)) <= eps
  );
}

/**
 * 扫一个工程的机位连续性。工具层与测试共用这一条路径。
 */
export async function checkProjectCamera({ store, projectId, trackId, eps = CAMERA_EPS }) {
  const entry = store.get(projectId);
  const doc = entry.doc;
  const tol = Number.isFinite(Number(eps)) ? Math.max(0, Number(eps)) : CAMERA_EPS;
  const tracks = (doc.tracks || []).filter((t) => t && (t.kind === 'video' || t.kind === 'code'));
  const wanted = trackId ? tracks.filter((t) => t.id === trackId) : tracks;
  if (trackId && wanted.length === 0) {
    return {
      projectId,
      trackId,
      eps: tol,
      pairs: [],
      broken: 0,
      total: 0,
      tracks: [],
      declarations: [],
      warnings: [`轨道 ${trackId} 不存在，或者不是视频 / 代码轨（这两类才有全画幅机位）`],
      hint: '时间线轨道 id 见 video_project_inspect 的 tracks',
    };
  }

  const pairs = [];
  const warnings = [];
  const declarations = [];
  const trackSummaries = [];

  for (const track of wanted) {
    const clips = (doc.clips || [])
      .filter((c) => c && c.trackId === track.id)
      .sort((a, b) => Number(a.start) - Number(b.start));

    // 每个片段的边界机位只取一次（卡片 import 有缓存，重复取也很轻）
    const boundaries = new Map();
    for (const clip of clips) {
      const out = await boundaryCamera(entry.root, clip, 'out');
      const inSide = await boundaryCamera(entry.root, clip, 'in');
      boundaries.set(clip.id, { out, in: inSide });

      // 声明 vs 曲线：卡片自证「片尾真的落在 out 上」
      for (const side of ['in', 'out']) {
        const b = boundaries.get(clip.id)[side];
        if (!b.sampled) continue;
        if (!sameCamera(b.value, b.declared, tol)) {
          declarations.push({
            clipId: clip.id,
            entryId: (clip.provenance && clip.provenance.assetId) || clip.layerId || null,
            side,
            declared: { scale: round6(b.declared.scale), x: round6(b.declared.x), y: round6(b.declared.y) },
            sampled: { scale: round6(b.value.scale), x: round6(b.value.x), y: round6(b.value.y) },
          });
          warnings.push(
            `片段 ${clip.id}（${(clip.provenance && clip.provenance.assetId) || clip.layerId || '?'}）的 ` +
              `${side} 声明与 cameraAt 不一致：声明 scale=${round6(b.declared.scale)}，` +
              `采样 scale=${round6(b.value.scale)} —— 声明说了谎，检查结果不可全信。`,
          );
        }
      }
    }

    const scanned = scanCameraContinuity(clips, {
      trackId: track.id,
      eps: tol,
      resolve: (clip, side) => (boundaries.get(clip.id) || {})[side]?.value || normalizeCamera(null),
    });

    const enriched = scanned.pairs.map((pair) => ({
      ...pair,
      prevEntryId:
        (clips.find((c) => c.id === pair.prevClipId)?.provenance || {}).assetId || null,
      nextEntryId:
        (clips.find((c) => c.id === pair.nextClipId)?.provenance || {}).assetId || null,
    }));
    pairs.push(...enriched);
    warnings.push(...scanned.warnings.filter((w) => !warnings.includes(w)));
    trackSummaries.push({ trackId: track.id, clips: clips.length, pairs: scanned.total, broken: scanned.broken });
  }

  const broken = pairs.filter((p) => !p.ok).length;
  const hint =
    pairs.length === 0
      ? '这条时间线上没有「首尾相接的全画幅片段」，没有边界要检查。'
      : broken === 0
        ? '所有边界机位都接上了：切点两帧的 scale / 偏移一致，不会「卡一下 + 位置变了」。'
        : 'broken 里的每一条都对应一次跳变：让上一镜片尾回到 1.0（或回到它声明的 out），' +
          '或者把下一镜的 in 声明成上一镜的 out。不阻止播放。';

  return {
    projectId,
    trackId: trackId || null,
    eps: tol,
    tracks: trackSummaries,
    pairs,
    broken,
    total: pairs.length,
    declarations,
    warnings,
    hint,
  };
}

export function cameraTools({ store }) {
  return [
    define(
      'video_camera_check',
      '只读：扫描时间线上首尾相接的片段，逐对比较上一镜出口与下一镜入口的「相机机位」（scale / x / y），找出会在边界跳一下的镜头。机位来自卡片 code.js 的 export const camera = { in, out }（或片段的 props.camera）；卡片还导出了 cameraAt 时会按曲线采样首尾帧。不通过不阻止播放，只给 warnings。用户说「放大之后没有缓缓返回 / 同一画面接下一镜会卡一下 / 位置变了」时先用它定位。',
      {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '工程 id；省略则用当前会话绑定的工程' },
          trackId: { type: 'string', description: '只扫这一条轨道（默认扫所有视频 / 代码轨）' },
          eps: { type: 'number', description: '相邻两帧允许的最大机位差，默认 0.001' },
        },
        required: [],
        additionalProperties: false,
      },
      async (args, exec) => {
        let projectId = args.projectId || null;
        if (!projectId && store && store.projects) {
          const sessionId = exec && exec.agent && exec.agent.id;
          const hit = [...store.projects.values()].find((p) => p.doc.boundSessionId === sessionId);
          if (hit) projectId = hit.doc.projectId;
        }
        if (!projectId) {
          return sanitizeJson({
            projectId: null,
            trackId: args.trackId || null,
            tracks: [],
            pairs: [],
            broken: 0,
            total: 0,
            declarations: [],
            warnings: ['当前会话没有绑定工程：先打开一个工程（video_project_open），或用 projectId 指定。'],
            hint: '没有工程就没有时间线可扫；这不是错误。',
          });
        }
        try {
          return sanitizeJson(
            await checkProjectCamera({ store, projectId, trackId: args.trackId || null, eps: args.eps }),
          );
        } catch (e) {
          if (e && e.code === 'REF_NOT_FOUND') throw e;
          return sanitizeJson({
            projectId,
            trackId: args.trackId || null,
            tracks: [],
            pairs: [],
            broken: 0,
            total: 0,
            declarations: [],
            warnings: [`机位检查没跑完：${(e && e.message) || e}`],
            hint: '时间线本身没受影响；可以只扫单条轨道（trackId）再试。',
          });
        }
      },
    ),

    define(
      'video_camera_keyframes',
      '只读：生成「进入 → 停留 → 返回」三段运镜的标准关键帧（默认 25% / 40% / 35%），并顺带报出两端速度。给卡片作者对齐曲线用；不写任何文件。',
      {
        type: 'object',
        properties: {
          duration: { type: 'number', description: '图层时长（秒）' },
          zoomTo: { type: 'number', description: '进入段的放大倍数，默认 1.6' },
          center: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            description: '停留时的画幅偏移（比例，0.1 = 画宽的 10%）',
          },
          enter: { type: 'number', description: '进入段比例，默认 0.25' },
          hold: { type: 'number', description: '停留段比例，默认 0.4' },
          exit: { type: 'number', description: '返回段比例，默认 0.35' },
        },
        required: ['duration'],
        additionalProperties: false,
      },
      async (args) => {
        const built = cameraKeyframes({
          duration: args.duration,
          zoomTo: args.zoomTo,
          center: args.center,
          enter: args.enter,
          hold: args.hold,
          exit: args.exit,
        });
        return sanitizeJson(built);
      },
    ),
  ];
}
