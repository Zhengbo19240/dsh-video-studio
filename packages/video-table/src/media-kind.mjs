/**
 * 素材类型（kind）的唯一权威 —— 「这个素材是视频、音频，还是图片」。
 *
 * 为什么要有这个模块：
 *   素材面板过去只按「有没有 mime」决定给不给按钮，于是音频素材也拿到了
 *   「加入主轨 / 画中画」。点下去以后时间线上多了一个 media 片段，而预览池里
 *   根本没有它的 <video>（音频天然 videoWidth=0），就绪判定永远不过，
 *   整帧被 hold，用户看到的就是「素材未就绪 / 播放头 12.64s，素材还没解出画面」。
 *   修法不是打补丁，而是让「kind」变成一处可判、可测的事实。
 *
 * 判定顺序（可靠度从高到低）：
 *   1) ffprobe 写进 asset.probe 的流类型：probe.kind / hasVideoStream / hasAudioStream
 *      —— 「有 video stream 才算视频」是这里唯一可靠的判据；
 *   2) mime（video/* / audio/* / image/*）；
 *   3) 扩展名（mime 缺失或 application/octet-stream 时兜底）。
 *
 * 本模块是纯函数、零依赖：client（浏览器/无头页）与 host（routes/tools/测试）共用。
 */

export const KIND = Object.freeze({
  VIDEO: 'video',
  AUDIO: 'audio',
  IMAGE: 'image',
  UNKNOWN: 'unknown',
});

const AUDIO_EXT = new Set([
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'wma', 'aif', 'aiff', 'caf', 'weba',
]);
const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mpeg', 'mpg', 'ts', 'flv', 'wmv', 'ogv', '3gp',
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif', 'heic']);

/** 从 asset.path / asset.name 里取扩展名（小写，无点）。 */
export function extensionOf(asset) {
  const value = String((asset && (asset.path || asset.name)) || '');
  const m = /\.([a-z0-9]+)$/i.exec(value);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 只看 ffprobe 的流类型。返回 KIND 或 null（探不出来时不猜）。
 *
 * 约定：probe.hasVideoStream 是「有视频流」的权威布尔值；probe.kind 是宿主
 * 直接写下的结论。两者都缺时返回 null，交给 mime / 扩展名。
 */
export function probeKind(probe) {
  if (!probe || typeof probe !== 'object') return null;
  const explicit = String(probe.kind || '').toLowerCase();
  if (explicit === KIND.VIDEO || explicit === KIND.AUDIO || explicit === KIND.IMAGE) return explicit;
  if (probe.hasVideoStream === true) return KIND.VIDEO;
  // 明确「只有音频流」才算音频；只是「没有视频流」还可能是读失败，不能据此下结论
  if (probe.hasVideoStream === false && probe.hasAudioStream === true) return KIND.AUDIO;
  return null;
}

/** 一个素材的 kind。永远返回 KIND 里的值，不返回 undefined。 */
export function assetKind(asset) {
  if (!asset) return KIND.UNKNOWN;
  const fromProbe = probeKind(asset.probe);
  if (fromProbe) return fromProbe;

  const mime = String(asset.mime || '').toLowerCase();
  if (mime.startsWith('video/')) return KIND.VIDEO;
  if (mime.startsWith('audio/')) return KIND.AUDIO;
  if (mime.startsWith('image/')) return KIND.IMAGE;

  const ext = extensionOf(asset);
  if (VIDEO_EXT.has(ext)) return KIND.VIDEO;
  if (AUDIO_EXT.has(ext)) return KIND.AUDIO;
  if (IMAGE_EXT.has(ext)) return KIND.IMAGE;
  return KIND.UNKNOWN;
}

export function isVideoAsset(asset) {
  return assetKind(asset) === KIND.VIDEO;
}

export function isAudioAsset(asset) {
  return assetKind(asset) === KIND.AUDIO;
}

export function isImageAsset(asset) {
  return assetKind(asset) === KIND.IMAGE;
}

/** 面板 chip 与提示文案用的中文名。 */
export function kindLabel(kind) {
  if (kind === KIND.VIDEO) return '视频';
  if (kind === KIND.AUDIO) return '音频';
  if (kind === KIND.IMAGE) return '图片';
  return '未知';
}

/** 素材能不能进预览池（只有视频需要 <video> 元素）。 */
export function isPooledVideo(asset) {
  return isVideoAsset(asset);
}

// ---------------------------------------------------------------- 轨道 ------

export function trackById(doc, trackId) {
  return ((doc && doc.tracks) || []).find((t) => t && t.id === trackId) || null;
}

export function trackKind(doc, trackId) {
  const t = trackById(doc, trackId);
  return t && t.kind ? String(t.kind) : null;
}

/** 工程里的音频轨：优先 a1，其次第一条 kind=audio 的轨道；没有给 null。 */
export function audioTrackId(doc) {
  const tracks = ((doc && doc.tracks) || []).filter((t) => t && t.kind === 'audio');
  if (!tracks.length) return null;
  return tracks.some((t) => t.id === 'a1') ? 'a1' : tracks[0].id;
}

export function videoTrackIds(doc) {
  return ((doc && doc.tracks) || []).filter((t) => t && t.kind === 'video').map((t) => t.id);
}

/**
 * 脏数据扫描：音频素材被放在视频轨上的片段。
 *
 * 这是过去的真实现场（用户实测回放）：素材面板把 Swinging staff whoosh /
 * click_001.ogg 当视频插进了主轨，于是「画面永远解不出」。
 * 返回逐条可读记录，供「打开工程时提示 + 一键修复」使用。
 */
export function audioOnVideoTrackIssues(doc) {
  const clips = (doc && doc.clips) || [];
  const assets = new Map(((doc && doc.assets) || []).map((a) => [a && a.id, a]));
  const issues = [];
  for (const c of clips) {
    if (!c || c.type !== 'media') continue;
    const t = trackById(doc, c.trackId);
    if (!t || t.kind !== 'video') continue;
    const a = assets.get(c.assetId);
    if (!a || assetKind(a) !== KIND.AUDIO) continue;
    issues.push({
      clipId: c.id,
      assetId: c.assetId,
      assetName: a.name || a.path || c.assetId,
      trackId: t.id,
      trackName: t.name || t.id,
      start: Number(c.start) || 0,
      duration: Number(c.duration) || 0,
    });
  }
  return issues;
}

/** 给 RPC / 面板的一段结构化提示（count=0 时 human 为空串）。 */
export function describeAudioTrackIssues(doc) {
  const issues = audioOnVideoTrackIssues(doc);
  return {
    count: issues.length,
    issues,
    human: issues.length
      ? `发现 ${issues.length} 个音频素材被放在视频轨上：它们不参与画面合成，播放时会一直被「等首帧」挡住。` +
        '点「一键移到音频轨」即可修复（一次事务，可撤销）；修复前预览也不会再阻塞。'
      : '',
  };
}

// ---------------------------------------------------------------- 入口策略 ---

/**
 * 素材卡给哪些入口 —— 面板与测试共用的一份策略。
 *
 * 这是 bug 1 的正面定义：**音频只能拿到「音频轨」这一个入口**，视频/图片才
 * 有「加入主轨 / 画中画」。把「按钮」和「kind」写在一处，测试才能钉死
 * 「音频素材不出现在视频轨入口」这件事，而不是靠读 JSX 猜。
 *
 * @returns {{kind:string, buttons:string[], trackKind:string|null, label:string|null, participatesInPicture:boolean}}
 *   buttons ∈ 'main' | 'pip' | 'audio'
 */
export function insertPolicy(asset) {
  const kind = assetKind(asset);
  if (kind === KIND.AUDIO) {
    return {
      kind,
      buttons: ['audio'],
      trackKind: 'audio',
      label: '加入音频轨（a1）',
      participatesInPicture: false,
    };
  }
  if (kind === KIND.VIDEO || kind === KIND.IMAGE) {
    return {
      kind,
      buttons: ['main', 'pip'],
      trackKind: 'video',
      label: '加入主轨',
      participatesInPicture: true,
    };
  }
  return { kind, buttons: [], trackKind: null, label: null, participatesInPicture: false };
}

/**
 * 「点下去会落在哪条轨」：音频 → a1（没有就建），视频/图片 → v1。
 * 音频永远拿不到 v1/v2 —— 这是与 insertPolicy 配套的硬约束。
 */
export function resolveInsertTrack(doc, asset) {
  const policy = insertPolicy(asset);
  if (policy.trackKind === 'audio') {
    const id = audioTrackId(doc);
    return Object.assign({}, policy, { trackId: id || 'a1', createTrack: !id, createKind: 'audio' });
  }
  if (policy.trackKind === 'video') {
    return Object.assign({}, policy, { trackId: 'v1', createTrack: false, createKind: null });
  }
  return Object.assign({}, policy, { trackId: null, createTrack: false, createKind: null });
}

// ---------------------------------------------------------------- 修复 ------

/** 在给定占用区间里找一段能放下 duration 的起点（与前端 firstFreeStart 同一算法）。 */
export function firstFreeStart(spans, want, duration) {
  const dur = Number(duration) > 0 ? Number(duration) : 0.5;
  const list = (spans || [])
    .map((s) => [Number(s[0]) || 0, Number(s[1]) || 0])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let s = Math.max(0, Number(want) || 0);
  for (let pass = 0; pass < 8; pass += 1) {
    let moved = false;
    for (const [a, b] of list) {
      if (s < b - 1e-6 && s + dur > a + 1e-6) {
        s = b;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return Math.max(0, +s.toFixed(3));
}

/**
 * 脏数据的修复计划：把视频轨上的音频片段移到音频轨（必要时先建 a1）。
 *
 * 纯函数，只产出命令；真正落地由调用方走 store.preview/apply（可撤销）。
 * 目标轨上按「不重叠」原则挑起点，原有片段能不动就不动。
 */
export function planAudioRepair(doc) {
  const issues = audioOnVideoTrackIssues(doc);
  if (!issues.length) return { ops: [], moved: [], targetTrackId: audioTrackId(doc) };

  const ops = [];
  let targetTrackId = audioTrackId(doc);
  if (!targetTrackId) {
    targetTrackId = 'a1';
    ops.push({ type: 'track.add', trackId: 'a1', kind: 'audio', name: '音频' });
  }

  // 在副本上模拟占用，保证多个片段依次移动时不会互相压住
  const sim = ((doc && doc.clips) || []).map((c) => ({
    id: c.id,
    trackId: c.trackId,
    start: Number(c.start) || 0,
    duration: Number(c.duration) || 0,
  }));
  const moved = [];
  for (const issue of issues) {
    const dur = Number(issue.duration) > 0 ? Number(issue.duration) : 0.5;
    const spans = sim
      .filter((c) => c.trackId === targetTrackId && c.id !== issue.clipId)
      .map((c) => [c.start, c.start + c.duration]);
    const start = firstFreeStart(spans, issue.start, dur);
    ops.push({ type: 'clip.move', clipId: issue.clipId, trackId: targetTrackId, start });
    const cur = sim.find((c) => c.id === issue.clipId);
    if (cur) {
      cur.trackId = targetTrackId;
      cur.start = start;
    }
    moved.push({
      clipId: issue.clipId,
      assetId: issue.assetId,
      assetName: issue.assetName,
      from: issue.trackId,
      to: targetTrackId,
      start,
      duration: dur,
    });
  }
  return { ops, moved, targetTrackId };
}
