/**
 * 工程模板：给「新建工程」一组可以直接开工的骨架。
 *
 * 模板只描述命令，不描述文档。buildTemplate 返回一串命令，由
 * store.preview / store.applyPreview 在同一个事务里落地 —— 模板永远不会
 * 绕过命令引擎，也不会自己伪造时间线上的字段。
 *
 * 两条约定：
 *  - 空工程由 createProject 创建，自带 v1/v2/c1/a1/t1 五条轨道。模板不再
 *    track.add（重复 id 会被命令引擎拒绝），只往对应轨道上放占位片段；
 *    「预置了哪些轨道」通过 listTemplates().tracks 对外说明。
 *  - 时长由片段的 start + duration 体现，不写 project.duration。
 *
 * 文案一律中文占位，不写死任何客户内容。
 */

import { DomainError } from './domain.mjs';

const WHITE = '#ffffff';

// 代码图层（data-story 的 count-up 占位）源码。写盘由 routes 负责，
// 与 motion.insert 的做法一致：先把源码落到 code/<layerId>/index.js，
// 再用 clip.insert 把图层挂到时间线上。约定见 src/client/code-layer.js：
// render(ctx2d, t, ctx) 必须是 t 的纯函数，任意 seek 结果一致。
const COUNTUP_SOURCE = `/**
 * 数据叙事模板的占位代码图层。
 * render(ctx2d, t, ctx) 必须是 t 的纯函数：同一个 t 画出来永远一样。
 * 把这段换成你的图表 / 数据就能直接接上时间线。
 */
export function render(ctx, t, env) {
  const props = env.props || {};
  const total = Math.max(0.5, Number(props.duration) || 12);
  const k = Math.max(0, Math.min(1, t / total));
  const from = Number(props.from == null ? 0 : props.from);
  const to = Number(props.to == null ? 100 : props.to);
  const value = Math.round(from + (to - from) * k);
  const w = env.width;
  const h = env.height;

  ctx.clearRect(0, 0, w, h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = props.color || '#ffffff';
  ctx.font = '600 ' + Math.round(h * 0.18) + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillText(String(value) + (props.unit || ''), w / 2, h * 0.44);

  ctx.fillStyle = 'rgba(255,255,255,.78)';
  ctx.font = '400 ' + Math.round(h * 0.055) + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillText(props.label || '核心指标', w / 2, h * 0.62);

  ctx.fillStyle = 'rgba(255,255,255,.42)';
  ctx.font = '400 ' + Math.round(h * 0.034) + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillText(props.note || '占位图层：换成你的数据可视化', w / 2, h * 0.86);
}
`;

/**
 * 四个模板。clips 是声明式的：type=text 放文字占位，type=code 挂代码图层。
 * duration 字段对外说明这条骨架的总时长，实际时长由片段撑出来。
 */
const TEMPLATES = [
  {
    id: 'portrait-talk',
    name: '竖屏口播',
    description: '9:16 竖屏：主轨放人，字幕轨一行一句。',
    ratio: '9:16',
    duration: 30,
    tracks: [
      { id: 'v1', kind: 'video', name: '主轨' },
      { id: 't1', kind: 'text', name: '字幕' },
    ],
    clips: [
      { key: 'main', trackId: 'v1', type: 'text', start: 0, duration: 30, text: '在这里放竖屏主画面', style: { fontSize: 40, y: 0.5, color: WHITE } },
      { key: 'line1', trackId: 't1', type: 'text', start: 0, duration: 3, text: '在这里写第一句话' },
      { key: 'line2', trackId: 't1', type: 'text', start: 3, duration: 3, text: '第二句话' },
    ],
  },
  {
    id: 'product-launch',
    name: '产品发布',
    description: '16:9 横屏：主画面 + 画中画 + 卖点字幕。',
    ratio: '16:9',
    duration: 15,
    tracks: [
      { id: 'v1', kind: 'video', name: '主轨' },
      { id: 'v2', kind: 'video', name: '画中画' },
      { id: 't1', kind: 'text', name: '字幕' },
    ],
    clips: [
      { key: 'main', trackId: 'v1', type: 'text', start: 0, duration: 15, text: '在这里放产品主画面', style: { fontSize: 40, y: 0.5, color: WHITE } },
      { key: 'pip', trackId: 'v2', type: 'text', start: 1, duration: 6, text: '在这里放画中画：演示 / Logo', style: { fontSize: 26, y: 0.5 } },
      { key: 'line1', trackId: 't1', type: 'text', start: 0, duration: 3.5, text: '一句话卖点' },
      { key: 'line2', trackId: 't1', type: 'text', start: 4, duration: 3, text: '再来一句卖点' },
    ],
  },
  {
    id: 'data-story',
    name: '数据叙事',
    description: '16:9 横屏：画面 + 字幕 + count-up 代码图层占位。',
    ratio: '16:9',
    duration: 15,
    tracks: [
      { id: 'v1', kind: 'video', name: '主轨' },
      { id: 'c1', kind: 'code', name: '代码图层' },
      { id: 't1', kind: 'text', name: '字幕' },
    ],
    clips: [
      { key: 'main', trackId: 'v1', type: 'text', start: 0, duration: 15, text: '在这里放数据背景画面', style: { fontSize: 36, y: 0.72, color: WHITE } },
      { key: 'line1', trackId: 't1', type: 'text', start: 0, duration: 3, text: '核心数字是——' },
      {
        key: 'countup',
        trackId: 'c1',
        type: 'code',
        start: 0,
        duration: 12,
        layerId: 'tpl-data-countup',
        props: { from: 0, to: 100, unit: '', label: '核心指标', duration: 12 },
      },
    ],
  },
  {
    id: 'caption-motion',
    name: '字幕动画',
    description: '9:16 竖屏：背景 + 每 3 秒一条字幕，做打字 / 逐条入场的起步。',
    ratio: '9:16',
    duration: 12,
    tracks: [
      { id: 'v1', kind: 'video', name: '主轨' },
      { id: 't1', kind: 'text', name: '字幕' },
    ],
    clips: [
      { key: 'main', trackId: 'v1', type: 'text', start: 0, duration: 12, text: '在这里放背景画面', style: { fontSize: 40, y: 0.5, color: WHITE } },
      { key: 'line1', trackId: 't1', type: 'text', start: 0, duration: 3, text: '字幕第一条' },
      { key: 'line2', trackId: 't1', type: 'text', start: 3, duration: 3, text: '字幕第二条' },
      { key: 'line3', trackId: 't1', type: 'text', start: 6, duration: 3, text: '字幕第三条' },
      { key: 'line4', trackId: 't1', type: 'text', start: 9, duration: 3, text: '字幕第四条' },
    ],
  },
];

/** 画布尺寸：调用方没给就按画幅推一个默认值（代码图层用得到）。 */
function canvasSize(template, options) {
  const fallback = template.ratio === '9:16' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
  const w = Number(options && options.width);
  const h = Number(options && options.height);
  return {
    width: Number.isFinite(w) && w > 0 ? Math.round(w) : fallback.width,
    height: Number.isFinite(h) && h > 0 ? Math.round(h) : fallback.height,
  };
}

/** 一条片段对应的命令。clipId 稳定可读，方便测试与排错。 */
function clipOp(template, clip, index, options) {
  const clipId = 'tpl_' + template.id + '_' + (clip.key || 'c' + (index + 1));
  if (clip.type === 'code') {
    const size = canvasSize(template, options);
    return {
      type: 'clip.insert',
      clipId,
      trackId: clip.trackId,
      clipType: 'code',
      layerId: clip.layerId || clipId,
      start: clip.start,
      duration: clip.duration,
      props: Object.assign({ width: size.width, height: size.height }, clip.props || {}),
    };
  }
  return {
    type: 'clip.insert',
    clipId,
    trackId: clip.trackId,
    clipType: 'text',
    start: clip.start,
    duration: clip.duration,
    text: clip.text || '',
    // 字幕默认贴着画面底部，主画面占位居中；样式只影响预览观感。
    style: clip.style || { fontSize: 30, y: 0.82, color: WHITE },
  };
}

/** 单个模板的说明信息（不含命令）；找不到返回 null。 */
export function getTemplate(templateId) {
  const found = TEMPLATES.find((t) => t.id === templateId);
  if (!found) return null;
  return {
    id: found.id,
    name: found.name,
    description: found.description,
    ratio: found.ratio,
    tracks: found.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name })),
    duration: found.duration,
  };
}

/** 四个模板的说明书。 */
export function listTemplates() {
  return TEMPLATES.map((t) => getTemplate(t.id));
}

/**
 * 把模板编译成一串命令。
 * 返回 { ratio, ops }：ops 只能落在 clip.insert / track.add / project.set_ratio /
 * code_layer.set_code / asset.add 这几类合法命令里。
 */
export function buildTemplate(templateId, options = {}) {
  const template = TEMPLATES.find((t) => t.id === templateId);
  if (!template) throw new DomainError('REF_NOT_FOUND', '模板不存在: ' + templateId);
  const ops = [{ type: 'project.set_ratio', ratio: template.ratio }];
  template.clips.forEach((clip, index) => {
    ops.push(clipOp(template, clip, index, options));
  });
  return { ratio: template.ratio, ops };
}

/**
 * 模板附带的代码图层源码（目前只有 data-story 有）。
 * 返回 { layerId, source } 或 null；写盘由调用方负责，文档只记 layerId。
 */
export function templateCode(templateId) {
  if (templateId !== 'data-story') return null;
  return { layerId: 'tpl-data-countup', source: COUNTUP_SOURCE };
}
