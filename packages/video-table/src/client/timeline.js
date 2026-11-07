/**
 * Timeline view.
 *
 * Follows the CapCut mental model: a ruler on top, one row per track, clips as
 * rounded bars you drag to move and drag at the edges to trim. Every finished
 * gesture becomes ONE command batch, so undo is one step per gesture.
 *
 * The component never mutates the document; it reports intent upward.
 */

import React from 'react';
import { timeToPx, pxToTime, fmtTime } from './bridge.js';
import { SCRUB_INTERVAL_MS } from './player.js';
import { thumbFor } from './thumbs.js';
import { waveformFor } from './waveform.js';
import { T } from './theme.js';
import { INTENT_LABELS } from '../annotations.mjs';

const h = React.createElement;

const ROW_H = 30;
const TRACK_HEAD_W = 96;
const RULER_H = 22;
/**
 * 标注轨：固定高度、只在界面里存在，不参与合成（导出 / 头less 渲染都看不到它）。
 * 高度固定 56px：一行最多 3 个小胶囊（15px 一行 + 上下留白），再多就叠在同一行，
 * 由右侧「标注」页兜底列出 —— 时间线不会因为标注多而把下面的轨道挤走。
 */
const ANNOT_TRACK_H = 56;
const ANNOT_LANE_TOP = 6;
const ANNOT_LANE_H = 15;
const ANNOT_FLAG_W = 11;
const ANNOT_MAX_LANES = 3;
const SNAP = 0.05;

const TRACK_DOT = { video: '#4f8cff', code: '#8a63ff', audio: '#37c98b', text: '#e0a336' };

const TYPE_COLOR = {
  media: '#2f6feb',
  text: '#b06a00',
  code: '#6a3fbf',
};

// ---------------------------------------------------------------- 标注轨 ----
//
// 下面这一组是纯函数：不读 React、不碰 DOM，测试脚本可以直接喂数据断言。
// 时间线只负责把结果画出来；「哪条标在哪、多宽、有没有超出片长、有没有倒挂」
// 全部由 layout 一次算清，UI 里不再出现第二套判断。

/** 四种 intent 的颜色。全部取自 theme.js 的语义 token，不另造色值。 */
export function annotationIntentColor(intent) {
  if (intent === 'issue') return T.danger; // state-error-primary
  if (intent === 'question') return T.warn; // state-warn-primary
  if (intent === 'note') return T.textFaint; // label-tertiary
  return T.accent; // state-business-primary
}

/** 标注的状态：缺字段按 open 处理（老工程 / agent 写入时不带 status）。 */
export function annotationStatus(annotation) {
  return (annotation && annotation.status) || 'open';
}

export function isAnnotationOpen(annotation) {
  return annotationStatus(annotation) === 'open';
}

/** 状态的中文短标签：列表里的徽标用这一份，别处不再各写一套。 */
export const ANNOTATION_STATUS_LABELS = { open: '未处理', applied: '已处理', rejected: '已忽略' };

export function annotationStatusLabel(status) {
  return ANNOTATION_STATUS_LABELS[status] || String(status || '未处理');
}

/** 从标注里读区间；缺 range / 非数字一律算「无法定位」，不抛错。 */
function annotationRangeOf(annotation) {
  const range = annotation && annotation.range;
  if (!range || typeof range !== 'object') return null;
  const start = Number(range.start);
  const end = Number(range.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

/**
 * 悬停摘要：intent 标签 + 文案前 40 字。
 * 换行折成空格，空文案给「（无文字）」—— 悬停时永远看得见一条完整的话。
 */
export function annotationSummary(annotation, max = 40) {
  const a = annotation || {};
  const label = INTENT_LABELS[a.intent] || String(a.intent || 'change');
  const text = String(a.expected == null ? '' : a.expected).replace(/\s+/g, ' ').trim();
  if (!text) return `${label} · （无文字）`;
  const chars = Array.from(text);
  return `${label} · ${chars.length > max ? chars.slice(0, max).join('') + '…' : text}`;
}

/**
 * 摘要里的 annotationCount 与真正拿到的 annotations 对不对得上。
 *
 * 这是这一整类 bug 的报警器：数据明明在工程里，界面却一条都没拿到时，
 * 轨道上必须说「没拿到数据」，而不是安安静静显示「还没有标注」。
 * 只看「一条都没有」的情况 —— 部分缺失靠不上这个判据（也不该拿它当校验器）。
 */
export function annotationDataMissing(doc, annotations) {
  const expected = Number(doc && doc.annotationCount) || 0;
  const got = Array.isArray(annotations) ? annotations.length : 0;
  return got === 0 && expected > 0;
}

/** 计数：总数 / 未处理 / 无法定位 / 倒挂。空数组给全 0，不崩。 */
export function annotationCounts(annotations) {
  const list = Array.isArray(annotations) ? annotations : [];
  let total = 0;
  let open = 0;
  let unplaced = 0;
  let invalid = 0;
  for (const a of list) {
    total += 1;
    if (isAnnotationOpen(a)) open += 1;
    const range = annotationRangeOf(a);
    if (!range) unplaced += 1;
    else if (range.end < range.start) invalid += 1;
  }
  return { total, open, handled: total - open, unplaced, invalid };
}

/** 播放头是否落在标注区间里；点标注（零长度）给 0.2s 的可看见窗口。 */
export function annotationActive(annotation, playhead) {
  const range = annotationRangeOf(annotation);
  if (!range) return false;
  const t = Number(playhead);
  if (!Number.isFinite(t)) return false;
  const lo = Math.min(range.start, range.end);
  const hi = Math.max(range.start, range.end);
  if (hi - lo < 1e-9) return Math.abs(t - lo) <= 0.2;
  return t >= lo - 1e-6 && t <= hi + 1e-6;
}

/** 点击 / 跳转要落到的秒数：倒挂时落到能看见的那一端。 */
export function annotationAnchor(annotation) {
  const range = annotationRangeOf(annotation);
  if (!range) return null;
  return Math.min(range.start, range.end);
}

/**
 * 标注轨布局。
 *
 * 输入：annotations（可含脏数据）、{ zoom, duration, playhead, selectedId }
 * 输出：
 *   items    能定位的标注，按时间升序、带像素坐标 / 泳道 / 高亮 / 边界标记
 *   unplaced 缺 range（或数字非法）的脏数据，单独分组，不阻塞其余渲染
 *   counts   { total, open, handled, unplaced, invalid }
 *
 * 三件容易错的事在这里一次定死：
 *   1. 超出 [0, duration] 的部分被夹到边界，并且 clampStart / clampEnd = true，
 *      UI 据此画虚线 —— 「贴边但不消失」。
 *   2. start > end 不倒挂渲染：降级成一个红色小旗（invalid = true），宽度永远 >= 0。
 *   3. 同一时刻的多条按泳道错开（lane），互不覆盖。
 */
export function annotationTrackLayout(annotations, options = {}) {
  const list = Array.isArray(annotations) ? annotations : [];
  const zoom = Number(options.zoom) > 0 ? Number(options.zoom) : 40;
  const rawDuration = Number(options.duration);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
  const playhead = Number(options.playhead);
  const selectedId = options.selectedId || null;

  const px = (t) => Math.round(t * zoom);
  const items = [];
  const unplaced = [];

  list.forEach((annotation, index) => {
    const id = (annotation && (annotation.id || annotation.annotationId)) || 'anon_' + index;
    const range = annotationRangeOf(annotation);
    if (!range) {
      unplaced.push({
        id,
        index,
        annotation,
        reason: 'missing-range',
        reasonText: '缺少 range（start/end），无法定位',
      });
      return;
    }
    const inverted = range.end < range.start;
    const lo = Math.min(range.start, range.end);
    const hi = Math.max(range.start, range.end);
    const clampStart = lo < 0;
    const clampEnd = duration > 0 && hi > duration;
    const t0 = Math.max(0, duration > 0 ? Math.min(lo, duration) : lo);
    const t1 = Math.max(t0, duration > 0 ? Math.min(hi, duration) : hi);
    // 倒挂的区间不画成「反方向的条」：宽度只能 >= 0，所以降级成一面红小旗。
    const isPoint = inverted || hi - lo < 1e-9 || t1 - t0 < 1e-9;
    const kind = isPoint ? 'flag' : 'span';
    const width = kind === 'flag' ? ANNOT_FLAG_W : Math.max(4, px(t1 - t0));
    const x = kind === 'flag' ? Math.max(0, px(t0) - Math.floor(ANNOT_FLAG_W / 2)) : px(t0);
    const color = inverted ? T.danger : annotationIntentColor(annotation && annotation.intent);
    const summary = annotationSummary(annotation);
    const feet = [];
    if (clampStart) feet.push('起点在 0 之前，已贴到片头');
    if (clampEnd) feet.push('终点超出片长，已贴到片尾');
    if (inverted) feet.push('区间倒挂（start > end），可修成点标注');
    items.push({
      id,
      index,
      annotation,
      kind,
      x,
      width,
      lane: 0,
      t0,
      t1,
      timeStart: range.start,
      timeEnd: range.end,
      anchorTime: lo,
      inverted,
      invalid: inverted,
      clampStart,
      clampEnd,
      truncated: clampStart || clampEnd,
      dashed: clampStart || clampEnd,
      outOfBounds: { start: clampStart, end: clampEnd },
      intent: (annotation && annotation.intent) || 'change',
      status: annotationStatus(annotation),
      color,
      summary,
      label: feet.length ? `${summary} · ${feet.join('；')}` : summary,
      selected: id === selectedId,
      active: annotationActive(annotation, playhead),
    });
  });

  // 稳定排序：时间优先，同一时间保持输入顺序（index 是原始下标，不会漂）。
  items.sort((a, b) => a.t0 - b.t0 || a.index - b.index);

  // 泳道：同一条泳道里右边缘不能压到下一块；放不下就往下挪一行。
  const laneEnds = [];
  for (const item of items) {
    let lane = 0;
    while (lane < laneEnds.length && item.x < laneEnds[lane] + 2) lane += 1;
    if (lane >= laneEnds.length) laneEnds.push(0);
    laneEnds[lane] = item.x + item.width;
    item.lane = lane;
    item.crowded = lane >= ANNOT_MAX_LANES;
  }

  return {
    items,
    unplaced,
    lanes: laneEnds.length,
    counts: annotationCounts(list),
    activeIds: items.filter((item) => item.active).map((item) => item.id),
  };
}


// 交界处的转场三角：点一下按 crossfade → push → wipe 循环
const TRANSITION_CYCLE = ['crossfade', 'push', 'wipe'];
const TRANSITION_LABEL = { crossfade: '叠化', push: '推移', wipe: '遮罩擦除' };
const TRANSITION_DEFAULT = 0.4;

function nextTransitionType(current) {
  const i = TRANSITION_CYCLE.indexOf(current);
  return TRANSITION_CYCLE[(i + 1) % TRANSITION_CYCLE.length];
}

function transitionOp(clip, side) {
  const cur = (clip.transition && clip.transition[side]) || null;
  return [
    {
      type: 'clip.set_transition',
      clipId: clip.id,
      [side]: { type: nextTransitionType(cur && cur.type), duration: (cur && cur.duration) || TRANSITION_DEFAULT },
    },
  ];
}

function markerStyle(side) {
  return {
    position: 'absolute',
    top: -1,
    [side]: 2,
    width: 0,
    height: 0,
    borderLeft: '5px solid transparent',
    borderRight: '5px solid transparent',
    borderTop: '7px solid #ffd166',
    cursor: 'pointer',
    zIndex: 3,
    filter: 'drop-shadow(0 0 2px rgba(0,0,0,.7))',
  };
}

function snapToClips(t, clips, ignoreId) {
  let best = Math.round(t / SNAP) * SNAP;
  let bestD = 0.08;
  for (const c of clips) {
    if (c.id === ignoreId) continue;
    for (const edge of [c.start, c.start + c.duration]) {
      const d = Math.abs(edge - t);
      if (d < bestD) {
        bestD = d;
        best = edge;
      }
    }
  }
  return Math.max(0, Math.round(best * 1000) / 1000);
}

export function Timeline(props) {
  const { doc, clips, annotations, playhead, zoom, selection, onSeek, onSelect, onOps, assets, flash } = props;
  const assetName = new Map((assets || []).map((a) => [a.id, a.name]));
  const [drag, setDrag] = React.useState(null); // {id, mode:'move'|'l'|'r', t0, start0, dur0, dx}
  const [view, setView] = React.useState({ left: 0, width: 1200 });
  // 悬停中的标注 id：用来在轨道下方显示「intent + 文案前 40 字」的浮层
  const [hoverAnnot, setHoverAnnot] = React.useState(null);
  const sync = React.useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setView({ left: el.scrollLeft, width: el.clientWidth || 1200 });
  }, []);
  React.useEffect(() => {
    sync();
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sync]);
  const scroller = React.useRef(null);
  const duration = Math.max(doc ? doc.duration : 0, 10);
  const width = Math.max(duration + 6, 20) * zoom;

  // 标注轨的全部几何一次算清：纯函数、可注入数据，测试脚本直接喂这份 layout。
  const selectedAnnotationId = selection && selection.kind === 'annotation' ? selection.id : null;
  const annotLayout = annotationTrackLayout(annotations, {
    zoom,
    duration,
    playhead,
    selectedId: selectedAnnotationId,
  });
  // 摘要里的 annotationCount 与真正传进来的 annotations 必须同源。
  // 对不上时宁可把矛盾写在轨道上，也不要显示「还没有标注」把丢数据说成空工程。
  const expectedAnnotationCount = Number(doc && doc.annotationCount) || 0;
  const annotationMissing = annotationDataMissing(doc, annotations);
  const hoveredAnnot = hoverAnnot
    ? annotLayout.items.find((item) => item.id === hoverAnnot) || null
    : null;

  const px = (t) => Math.round(t * zoom);

  function timeAtEvent(e) {
    const el = scroller.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left + el.scrollLeft;
    return pxToTime(x);
  }

  // 拖动尺子：拖动中节流（降级，允许画不到但绝不黑屏），松手后必须落一帧准确的。
  const seekRef = React.useRef(onSeek);
  seekRef.current = onSeek;
  const scrubRef = React.useRef(null); // { last }
  const clampSeek = React.useCallback(
    (t) => Math.max(0, Math.min(duration, t)),
    [duration],
  );
  const scrubTo = React.useCallback(
    (e, opts) => {
      const fn = seekRef.current;
      if (typeof fn !== 'function') return;
      fn(clampSeek(timeAtEvent(e)), opts);
    },
    [clampSeek],
  );

  React.useEffect(() => {
    const onMove = (e) => {
      const state = scrubRef.current;
      if (!state) return;
      const at = Date.now();
      if (at - state.last < SCRUB_INTERVAL_MS) return;
      state.last = at;
      scrubTo(e, { scrub: true });
    };
    const onUp = (e) => {
      if (!scrubRef.current) return;
      scrubRef.current = null;
      scrubTo(e, { scrub: false, force: true });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [scrubTo]);

  React.useEffect(() => {
    if (!drag) return undefined;
    const onMove = (e) => {
      const dt = pxToTime(e.clientX) - pxToTime(drag.clientX0);
      setDrag((d) => (d ? { ...d, dt } : d));
    };
    const onUp = () => {
      const d = drag;
      setDrag(null);
      if (!d || Math.abs(d.dt) < 0.02) return;
      if (d.mode === 'move') {
        const start = snapToClips(d.start0 + d.dt, clips, d.id);
        onOps([{ type: 'clip.move', clipId: d.id, start }], '移动片段');
      } else if (d.mode === 'l') {
        const left = d.start0 + d.dt;
        const clamped = Math.min(Math.max(0, left), d.start0 + d.dur0 - 0.1);
        const delta = clamped - d.start0;
        const ops = [{ type: 'clip.trim', clipId: d.id, start: +clamped.toFixed(3), duration: +(d.dur0 - delta).toFixed(3) }];
        if (d.srcIn != null) ops[0].sourceIn = +(d.srcIn + delta * (d.speed || 1)).toFixed(3);
        onOps(ops, '裁剪片段');
      } else {
        const dur = Math.max(0.1, d.dur0 + d.dt);
        onOps([{ type: 'clip.trim', clipId: d.id, duration: +dur.toFixed(3) }], '裁剪片段');
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, clips, onOps]);

  function beginDrag(e, clip, mode) {
    e.stopPropagation();
    e.preventDefault();
    onSelect({ kind: 'clip', id: clip.id });
    setDrag({
      id: clip.id,
      mode,
      clientX0: e.clientX,
      start0: clip.start,
      dur0: clip.duration,
      srcIn: clip.type === 'media' ? clip.sourceIn || 0 : null,
      speed: clip.speed || 1,
      dt: 0,
    });
  }

  const ticks = [];
  const tickStep = zoom > 90 ? 0.5 : zoom > 40 ? 1 : 2;
  for (let t = 0; t <= duration + 1; t += tickStep) {
    ticks.push(
      h(
        'div',
        {
          key: 't' + t,
          style: {
            position: 'absolute',
            left: px(t),
            top: 0,
            height: RULER_H,
            borderLeft: `1px solid ${T.border}`,
            paddingLeft: 4,
            fontSize: 10,
            opacity: 0.55,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          },
        },
        t % 1 === 0 ? `${t}s` : '',
      ),
    );
  }

  const rows = (doc ? doc.tracks : []).map((track, index) => {
    const t0 = Math.max(0, view.left / zoom - 2);
    const t1 = (view.left + view.width) / zoom + 2;
    const rowClips = clips.filter(
      (c) => c.trackId === track.id && c.start + c.duration >= t0 && c.start <= t1,
    );
    return h(
      'div',
      {
        key: track.id,
        style: {
          position: 'relative',
          height: ROW_H,
          background: index % 2 ? `color-mix(in srgb, ${T.fill} 40%, transparent)` : 'transparent',
          borderTop: index === 0 ? 'none' : `1px solid ${T.borderFaint}`,
        },
      },
      rowClips.map((c) => {
        const isDrag = drag && drag.id === c.id;
        const start = isDrag && drag.mode === 'move' ? Math.max(0, c.start + drag.dt) : c.start;
        let width0 = c.duration;
        let start2 = start;
        if (isDrag && drag.mode === 'l') {
          const left = Math.min(Math.max(0, c.start + drag.dt), c.start + c.duration - 0.1);
          width0 = c.start + c.duration - left;
          start2 = left;
        } else if (isDrag && drag.mode === 'r') {
          width0 = Math.max(0.1, c.duration + drag.dt);
        }
        const selected = selection && selection.kind === 'clip' && selection.id === c.id;
        const flashing = !!(flash && flash.ids && flash.ids.has(c.id));
        return h(
          'div',
          {
            key: c.id,
            onPointerDown: (e) => beginDrag(e, c, 'move'),
            title: `${c.id} · ${c.type}`,
            style: {
              position: 'absolute',
              left: px(start2),
              width: Math.max(6, px(width0)),
              top: 3,
              height: ROW_H - 6,
              borderRadius: 6,
              background: TYPE_COLOR[c.type] || '#445',
              backgroundImage: (() => {
                if (c.trackId === 'a1') {
                  const w = waveformFor(c.assetId);
                  return w ? 'url(' + w + ')' : 'none';
                }
                const t = c.type === 'media' ? thumbFor(c.assetId, (c.sourceIn || 0) + 0.2) : null;
                return t ? 'url(' + t + ')' : 'none';
              })(),
              backgroundSize: 'auto 100%',
              backgroundRepeat: 'repeat-x',
              backgroundBlendMode: 'overlay',
              opacity: 0.85,
              outline: selected ? '2px solid #ffd166' : `1px solid ${T.border}`,
              boxShadow: selected ? '0 0 0 4px rgba(255,209,102,.16)' : flashing ? '0 0 0 3px rgba(90,170,255,.45)' : 'none',
              overflow: 'hidden',
              cursor: 'grab',
              display: 'flex',
              alignItems: 'center',
              paddingLeft: 8,
              fontSize: 11,
              color: '#fff',
              userSelect: 'none',
            },
          },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.type === 'text' ? c.text || '文字' : c.type === 'code' ? '代码 · ' + (c.layerId || c.id) : assetName.get(c.assetId) || c.id),
          c.keyframes && c.keyframes.length
            ? h(
                'div',
                { style: { position: 'absolute', left: 0, right: 0, bottom: 2, height: 5, pointerEvents: 'none' } },
                c.keyframes.map((k, i) =>
                  h('div', {
                    key: i,
                    title: (k.property || '') + ' @' + k.t + 's',
                    style: {
                      position: 'absolute',
                      left: Math.min(96, (k.t / Math.max(0.1, c.duration)) * 100) + '%',
                      width: 5,
                      height: 5,
                      background: '#ffd166',
                      transform: 'rotate(45deg)',
                    },
                  }),
                ),
              )
            : null,
          c.effects && c.effects.length
            ? h('div', {
                title: '已有效果',
                style: {
                  position: 'absolute',
                  right: 4,
                  top: 3,
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  background: '#7ee0b0',
                  pointerEvents: 'none',
                },
              })
            : null,
          h('div', {
            onPointerDown: (e) => beginDrag(e, c, 'l'),
            style: { position: 'absolute', left: 0, top: 0, width: 6, height: '100%', cursor: 'ew-resize' },
          }),
          h('div', {
            onPointerDown: (e) => beginDrag(e, c, 'r'),
            style: { position: 'absolute', right: 0, top: 0, width: 6, height: '100%', cursor: 'ew-resize' },
          }),
          // 转场标记：左侧三角 = 入向，右侧三角 = 出向，点一下循环切换类型
          c.transition && c.transition.in
            ? h('div', {
                title: `入向转场：${TRANSITION_LABEL[c.transition.in.type] || c.transition.in.type} ${c.transition.in.duration}s（点击切换）`,
                onPointerDown: (e) => e.stopPropagation(),
                onClick: (e) => {
                  e.stopPropagation();
                  onOps(transitionOp(c, 'in'), '切换转场');
                },
                style: markerStyle('left'),
              })
            : null,
          c.transition && c.transition.out
            ? h('div', {
                title: `出向转场：${TRANSITION_LABEL[c.transition.out.type] || c.transition.out.type} ${c.transition.out.duration}s（点击切换）`,
                onPointerDown: (e) => e.stopPropagation(),
                onClick: (e) => {
                  e.stopPropagation();
                  onOps(transitionOp(c, 'out'), '切换转场');
                },
                style: markerStyle('right'),
              })
            : null,
          c.speed && Math.abs(c.speed - 1) > 0.001
            ? h('div', {
                title: `${c.speed}× 变速（时间线时长 ${c.duration}s）`,
                style: {
                  position: 'absolute',
                  right: 6,
                  bottom: 2,
                  fontSize: 9,
                  lineHeight: '11px',
                  padding: '0 3px',
                  borderRadius: 3,
                  background: 'rgba(255,209,102,.85)',
                  color: '#2a1c00',
                  pointerEvents: 'none',
                },
              }, '×' + c.speed)
            : null,
        );
      }),
    );
  });

  // 每条标注画成一个胶囊（区间）或一面小旗（点标注）。
  // 颜色按 intent 从 theme.js 的语义 token 取；倒挂的强制红色虚线，超界的贴边。
  const annotBars = annotLayout.items.map((item) => {
    const color = item.color;
    const top = ANNOT_LANE_TOP + Math.min(item.lane, ANNOT_MAX_LANES - 1) * ANNOT_LANE_H;
    const baseStyle = {
      position: 'absolute',
      left: item.x,
      top,
      height: ANNOT_LANE_H - 3,
      borderRadius: 4,
      cursor: 'pointer',
      background: `color-mix(in srgb, ${color} 24%, transparent)`,
      outline: item.selected
        ? `2px solid ${color}`
        : item.invalid
          ? `1px dashed ${T.danger}`
          : `1px solid ${color}`,
      outlineOffset: item.selected ? 1 : 0,
      boxShadow: item.active ? `0 0 0 2px color-mix(in srgb, ${color} 60%, transparent)` : 'none',
      opacity: item.status === 'open' ? 1 : 0.55,
      zIndex: item.selected ? 4 : item.active ? 3 : 1,
    };
    const common = {
      key: item.id,
      title: item.label,
      onPointerEnter: () => setHoverAnnot(item.id),
      onPointerLeave: () => setHoverAnnot((cur) => (cur === item.id ? null : cur)),
      onClick: (e) => {
        e.stopPropagation();
        onSelect({ kind: 'annotation', id: item.id });
        // 点胶囊 = 选中 + 跳到该条（倒挂时落到能看见的那一端）
        if (typeof onSeek === 'function') onSeek(clampSeek(item.anchorTime), { force: true });
      },
    };
    if (item.kind === 'flag') {
      // 点标注：一根竖线 + 一面小三角旗，宽度固定。倒挂 / 超界也走这里，不会被拉成负宽。
      return h(
        'div',
        { ...common, style: { ...baseStyle, width: ANNOT_FLAG_W } },
        h('i', {
          style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 2, borderRadius: 1, background: color },
        }),
        h('i', {
          style: {
            position: 'absolute',
            left: 2,
            top: 2,
            width: ANNOT_FLAG_W - 4,
            height: ANNOT_LANE_H - 7,
            background: color,
            clipPath: 'polygon(0 0, 100% 50%, 0 100%)',
          },
        }),
      );
    }
    return h(
      'div',
      {
        ...common,
        style: {
          ...baseStyle,
          width: item.width,
          display: 'flex',
          alignItems: 'center',
          padding: '0 4px',
          overflow: 'hidden',
        },
      },
      h(
        'span',
        {
          style: {
            fontSize: 9,
            lineHeight: '11px',
            color: T.text,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          },
        },
        item.width > 48 ? item.summary : '',
      ),
      // 超出片长的边界：贴边 + 虚线，提醒「这里不是真实终点」
      item.clampEnd
        ? h('i', {
            style: {
              position: 'absolute',
              right: 0,
              top: 0,
              bottom: 0,
              width: 2,
              borderLeft: `2px dashed ${T.warn}`,
            },
          })
        : null,
      item.clampStart
        ? h('i', {
            style: {
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: 2,
              borderLeft: `2px dashed ${T.warn}`,
            },
          })
        : null,
    );
  });

  // 悬停摘要浮层：intent + 文案前 40 字（已经由 annotationSummary 截好）
  const annotTip = hoveredAnnot
    ? h(
        'div',
        {
          style: {
            position: 'absolute',
            left: Math.max(0, Math.min(hoveredAnnot.x, Math.max(0, width - 300))),
            top: RULER_H + ANNOT_TRACK_H + 2,
            width: 280,
            padding: '6px 8px',
            borderRadius: 6,
            background: T.panel,
            border: `1px solid ${T.borderStrong}`,
            color: T.text,
            fontSize: 10,
            lineHeight: '14px',
            boxShadow: T.shadow,
            zIndex: 8,
            pointerEvents: 'none',
          },
        },
        hoveredAnnot.label,
      )
    : null;


  return h(
    'div',
    { style: { display: 'flex', height: '100%', minHeight: 0 } },
    // track headers
    h(
      'div',
      {
        style: {
          width: TRACK_HEAD_W,
          flex: '0 0 auto',
          borderRight: `1px solid ${T.border}`,
          paddingTop: RULER_H,
          background: T.fill,
        },
      },
      // 标注轨的表头：位置在尺子下面、所有轨道之上，固定 56px
      h(
        'div',
        {
          key: '@annotations',
          title:
            annotLayout.counts.unplaced > 0
              ? `${annotLayout.counts.unplaced} 条标注缺少 range，去右侧「标注」页处理`
              : '标注轨：点胶囊跳到该处；右侧「标注」页可编辑 / 删除',
          style: {
            height: ANNOT_TRACK_H,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 2,
            padding: '0 8px',
            fontSize: 10,
            color: T.textDim,
            background: T.fill,
            borderBottom: `1px solid ${T.borderFaint}`,
          },
        },
        h(
          'span',
          { style: { display: 'flex', alignItems: 'center', gap: 5, fontWeight: 600 } },
          h('i', { style: { width: 6, height: 6, borderRadius: 3, background: T.accent } }),
          '标注轨',
          h('span', { style: { opacity: 0.6, fontWeight: 400 } }, String(annotLayout.counts.total)),
        ),
        h('span', { style: { opacity: 0.6 } }, '未处理 ' + annotLayout.counts.open),
        annotLayout.counts.unplaced
          ? h('span', { style: { color: T.warn } }, '无法定位 ' + annotLayout.counts.unplaced)
          : null,
      ),
      (doc ? doc.tracks : []).map((t) =>
        h(
          'div',
          {
            key: t.id,
            onDoubleClick: () => onOps([{ type: 'track.set_muted', trackId: t.id, muted: !t.muted }], t.muted ? '取消静音' : '静音轨道'),
            style: {
              height: ROW_H,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 8px',
              fontSize: 11,
              color: T.textDim,
              borderTop: `1px solid ${T.borderFaint}`,
            },
          },
          h(
            'span',
            { style: { display: 'inline-flex', alignItems: 'center', gap: 6, overflow: 'hidden' } },
            h('i', {
              style: {
                width: 6,
                height: 6,
                borderRadius: 3,
                background: TRACK_DOT[t.kind] || '#666',
                display: 'inline-block',
                opacity: t.muted ? 0.3 : 1,
              },
            }),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t.name || t.kind),
          ),
          h('span', { style: { opacity: 0.6, cursor: 'pointer' }, title: '双击轨道名切换静音' }, t.locked ? '🔒' : t.muted ? '🔇' : (t.kind === 'audio' ? '🔊' : '')),
        ),
      ),
    ),
    // scrollable canvas
    h(
      'div',
      {
        ref: scroller,
        onScroll: sync,
        // 滚轮默认竖着滚整页；时间线要的是横向找时间。竖向滚轮改成横向滚动。
        onWheel: (e) => {
          const el = scroller.current;
          if (!el) return;
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            el.scrollLeft = Math.max(0, el.scrollLeft + e.deltaY);
          }
        },
        style: { flex: 1, overflowX: 'auto', overflowY: 'hidden', position: 'relative' },
      },
      h(
        'div',
        { style: { position: 'relative', width, height: '100%' } },
        // ruler (click to seek)
        h(
          'div',
          {
            onPointerDown: (e) => {
              if (e.button != null && e.button !== 0) return;
              scrubRef.current = { last: 0 };
              scrubTo(e, { scrub: true, force: true });
            },
            style: {
              position: 'sticky',
              top: 0,
              height: RULER_H,
              cursor: 'ew-resize',
              borderBottom: `1px solid ${T.border}`,
              background: T.bg,
              zIndex: 3,
            },
          },
          ticks,
        ),
        // 标注轨：专用、固定高度、不参与合成。所有胶囊 / 小旗都在这一条里。
        h(
          'div',
          {
            style: {
              position: 'relative',
              height: ANNOT_TRACK_H,
              background: T.fill,
              borderBottom: `1px solid ${T.borderFaint}`,
            },
          },
          annotLayout.counts.total === 0
            ? h(
                'div',
                {
                  style: {
                    position: 'absolute',
                    left: 8,
                    top: ANNOT_LANE_TOP,
                    fontSize: 10,
                    // 工程里明明有标注、界面却一条没拿到：把矛盾写在轨道上，
                    // 不要用「还没有标注」把数据丢失伪装成空工程（曾经就是这样）。
                    color: annotationMissing ? T.warn : T.textFaint,
                    pointerEvents: 'none',
                  },
                },
                annotationMissing
                  ? `工程里有 ${expectedAnnotationCount} 条标注，但界面没拿到数据（刷新失败）· 点顶栏刷新或重开工程`
                  : '还没有标注 · 播放时点 + 标注 添加',
              )
            : null,
          annotBars,
        ),
        // tracks
        h('div', { style: { position: 'relative' } }, rows),
        annotTip,
        // playhead
        h('div', {
          style: {
            position: 'absolute',
            left: px(playhead) - 1,
            top: 0,
            bottom: 0,
            width: 2,
            background: '#ff5f56',
            pointerEvents: 'none',
            zIndex: 4,
            boxShadow: '0 0 6px rgba(255,95,86,.55)',
          },
        }),
      ),
    ),
  );
}
