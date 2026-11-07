/**
 * Human-readable diff: turns the machine diff into one Chinese sentence the
 * user (and the agent, echoing it back) can read without opening a JSON viewer.
 */

const TRACK_NAME = {
  v1: '主轨',
  c1: '代码图层',
  a1: '音频',
  t1: '字幕',
};

function clipLabel(clip, assets) {
  if (!clip) return '片段';
  if (clip.type === 'text') return '文字「' + String(clip.text || '').slice(0, 12) + '」';
  if (clip.type === 'code') return '代码图层 ' + (clip.layerId || clip.id);
  const asset = (assets || []).find((a) => a.id === clip.assetId);
  return asset ? '「' + asset.name + '」' : '素材片段';
}

function seconds(n) {
  return (Math.round(n * 100) / 100).toFixed(2) + 's';
}

const FIELD_LABEL = {
  duration: '时长',
  start: '起点',
  sourceIn: '源入点',
  text: '文案',
  props: '参数',
  codeHash: '代码',
  effects: '效果',
  keyframes: '关键帧',
  transform: '变换',
  volume: '音量',
  fadeIn: '淡入',
  fadeOut: '淡出',
  muted: '静音',
  status: '状态',
};

export function humanDiff(before, after, diff) {
  const parts = [];
  const afterClips = new Map((after.clips || []).map((c) => [c.id, c]));

  for (const item of diff.added || []) {
    if (item.kind === 'clip') {
      const c = item.value || afterClips.get(item.id);
      parts.push('新增 ' + clipLabel(c, after.assets) + '（' + (TRACK_NAME[c.trackId] || c.trackId) + '，' + seconds(c.start) + '–' + seconds(c.start + c.duration) + '）');
    } else if (item.kind === 'annotation') {
      parts.push('新增标注' + (item.value && item.value.expected ? '「' + String(item.value.expected).slice(0, 16) + '」' : ''));
    } else if (item.kind === 'asset') {
      parts.push('登记素材 ' + ((item.value && item.value.name) || item.id));
    } else if (item.kind === 'track') {
      parts.push('新增轨道');
    }
  }

  for (const item of diff.removed || []) {
    if (item.kind === 'clip') parts.push('删除片段 ' + item.id);
    else if (item.kind === 'annotation') parts.push('删除标注');
  }

  for (const item of diff.modified || []) {
    if (item.kind === 'clip') {
      const c = afterClips.get(item.id);
      const fields = Object.keys(item.fields || {});
      const names = fields.map((f) => FIELD_LABEL[f] || f).join('、');
      parts.push('修改 ' + clipLabel(c, after.assets) + ' 的' + names);
    } else if (item.kind === 'annotation') {
      parts.push('标注状态更新');
    }
  }

  if (!parts.length) return '没有可见变化';
  const head = 'r' + before.revision + ' → r' + after.revision;
  return head + '：' + parts.join('；');
}
