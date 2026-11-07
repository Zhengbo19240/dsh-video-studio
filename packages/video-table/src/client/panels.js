/**
 * Side panels: the media bin (left) and the inspector (right).
 *
 * Both are dumb views: they report intent upward and read from the shared
 * state. Import is the only place that talks to the Host directly, because it
 * carries bytes.
 */

import React from 'react';
import {
  fmtTime,
  state,
  setState,
  uploadFile,
  uploadStyleAsset,
  scanAssets,
  reportError,
  toast,
  rpc,
  refresh,
  mediaUrl,
  ttsSpeak,
  styleFileUrl,
  styleFileUrlFor,
} from './bridge.js';
import { enrichAnnotation, formatAnnotation, INTENT_LABELS } from '../annotations.mjs';
// 标注轨的几何 / 计数与清单共用同一套纯函数：时间线怎么排，右侧列表就怎么排。
import {
  annotationCounts,
  annotationIntentColor,
  annotationStatusLabel,
  annotationSummary,
  annotationTrackLayout,
} from './timeline.js';
// 素材 kind 的唯一判据（ffprobe 流类型 > mime > 扩展名）：面板按钮与轨道入口都按它分流。
import { KIND, assetKind, insertPolicy, kindLabel } from '../media-kind.mjs';
import { normalizeTextStyle } from '../domain.mjs';
import {
  DENSITIES,
  DENSITY_LABELS,
  FONT_CHOICES,
  PREVIEW_SECONDS,
  SHOT_LABELS,
  alignmentForSpec,
  bpmFromRhythm,
  buildClickTrack,
  clickTrackToWav,
  drawStyleFrame,
  specToSummary,
  validateStyleSpec,
  previewLayout,
} from '../style-spec.mjs';
import { renderThumb } from './motion-thumb.js';
import { T } from './theme.js';

// 统一包一层：给 <select> 及其 <option> 上暗色。
// 原因：原生下拉弹层用的是系统配色，我们的 select 是深底浅字，
// 选项没显式背景色时会被系统画成白底 → 浅字压白底，等于看不见。
// 用 colorScheme:'dark' 让弹层走暗色，再给每个 option 兜一层背景。
const OPTION_STYLE = { background: T.bg, color: T.text };

function h(type, props, ...children) {
  if (type !== 'select') return React.createElement(type, props, ...children);
  const flat = [];
  const push = (c) => {
    if (Array.isArray(c)) c.forEach(push);
    else if (c != null && c !== false) flat.push(c);
  };
  children.forEach(push);
  const kids = flat.map((c) =>
    c && c.type === 'option'
      ? React.createElement('option', {
          key: c.key,
          ...c.props,
          style: { ...OPTION_STYLE, ...((c.props && c.props.style) || {}) },
        })
      : c,
  );
  return React.createElement(
    'select',
    { ...(props || {}), style: { colorScheme: 'dark', ...((props && props.style) || {}) } },
    ...kids,
  );
}

const chip = (text, tone) =>
  h(
    'span',
    {
      style: {
        fontSize: 10,
        padding: '1px 6px',
        borderRadius: 4,
        color: T.textDim,
        background: tone === 'warn' ? T.warnDim : T.fillStrong,
        border: `1px solid ${T.border}`,
        whiteSpace: 'nowrap',
      },
    },
    text,
  );

function motionInitial(item) {
  const text = String((item && (item.title || item.id)) || '?').trim();
  return text ? text.slice(0, 1) : '?';
}

/** 缩略图占位：灰色方块，失败时用条目名首字兜底。 */
function motionThumbBox(item, text, title, width, height, fontSize) {
  const boxWidth = width || 64;
  const boxHeight = height || 36;
  return h(
    'div',
    {
      title: title || '',
      style: {
        width: boxWidth,
        height: boxHeight,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: boxWidth > 100 ? 6 : 4,
        border: `1px solid ${T.border}`,
        background: T.fill,
        color: T.textDim,
        fontSize: fontSize || (text && text.length > 1 ? 9 : 15),
        lineHeight: 1,
        overflow: 'hidden',
        flex: '0 0 auto',
        userSelect: 'none',
      },
    },
    text,
  );
}

/** 一条动效的 64×36 缩略图；失败只降级，不抛错、不白屏。 */
function MotionThumb({ item, onOpen }) {
  const code = (item && (item.code || item.preview)) || '';
  const [src, setSrc] = React.useState('');
  const [failed, setFailed] = React.useState(!code);

  React.useEffect(() => {
    let alive = true;
    setSrc('');
    setFailed(!code);
    if (!code) {
      return () => {
        alive = false;
      };
    }
    renderThumb(code, 64, 36, 1, { id: item.id })
      .then((url) => {
        if (alive) setSrc(url);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [item.id, code]);

  let content;
  if (!code) content = motionThumbBox(item, '无预览', '该动效源码超过 4KB，列表不提供预览');
  else if (failed) content = motionThumbBox(item, motionInitial(item), '缩略图渲染失败');
  else if (!src) content = motionThumbBox(item, '…', '缩略图渲染中');
  else {
    content = h('img', {
      src,
      alt: (item.title || item.id) + ' 缩略图',
      draggable: false,
      style: { width: 64, height: 36, display: 'block', objectFit: 'cover', borderRadius: 4 },
    });
  }

  return h(
    'button',
    {
      type: 'button',
      title: code ? '点击放大预览' : '无预览',
      onClick: () => {
        if (code) onOpen(item, code);
      },
      style: {
        padding: 0,
        margin: 0,
        width: 64,
        height: 36,
        flex: '0 0 auto',
        border: 'none',
        borderRadius: 4,
        background: 'transparent',
        cursor: code ? 'zoom-in' : 'default',
        overflow: 'hidden',
      },
    },
    content,
  );
}

/** 点击缩略图后的预览弹层：按帧序列循环播放，再点任意处关闭。 */
function MotionPreview({ item, code, onClose }) {
  const W = 320;
  const H = 180;
  const FRAMES = 12;
  const FPS = 8;
  const SPAN = 3; // 预览固定播 3 秒，覆盖大多数动效的主节奏
  const [frames, setFrames] = React.useState([]);
  const [idx, setIdx] = React.useState(0);
  const [failed, setFailed] = React.useState(!code);

  React.useEffect(() => {
    let alive = true;
    setFrames([]);
    setIdx(0);
    setFailed(!code);
    if (!code) return () => { alive = false; };
    (async () => {
      for (let k = 0; k < FRAMES; k += 1) {
        try {
          const t = (k / FRAMES) * SPAN;
          // 首帧先上屏，后面逐帧补，避免空等
          const url = await renderThumb(code, W, H, t, { id: item.id + '@' + k });
          if (!alive) return;
          setFrames((prev) => {
            const next = prev.slice();
            next[k] = url;
            return next;
          });
        } catch {
          if (alive) setFailed(true);
          return;
        }
      }
    })();
    return () => { alive = false; };
  }, [item.id, code]);

  React.useEffect(() => {
    if (frames.length < 2) return undefined;
    const timer = setInterval(() => setIdx((v) => (v + 1) % frames.length), 1000 / FPS);
    return () => clearInterval(timer);
  }, [frames.length]);

  const current = frames.length ? frames[idx % frames.length] : '';

  let frame;
  if (!code) frame = motionThumbBox(item, '无预览', '该动效源码超过 4KB', W, H, 14);
  else if (failed && !frames.length) frame = motionThumbBox(item, motionInitial(item), '预览渲染失败', W, H, 42);
  else if (!current) frame = motionThumbBox(item, '渲染中…', '正在渲染预览', W, H, 14);
  else {
    frame = h('img', {
      src: current,
      alt: (item.title || item.id) + ' 预览',
      draggable: false,
      style: { width: W, height: H, display: 'block', objectFit: 'cover', borderRadius: 6 },
    });
  }

  return h(
    'div',
    {
      role: 'button',
      tabIndex: 0,
      title: '点击关闭预览',
      onClick: onClose,
      onKeyDown: (e) => {
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') onClose();
      },
      style: {
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: T.mask,
        cursor: 'zoom-out',
      },
    },
    h(
      'div',
      {
        style: {
          width: 352,
          boxSizing: 'border-box',
          padding: 12,
          borderRadius: 10,
          border: `1px solid ${T.border}`,
          background: T.panel,
          boxShadow: T.shadow,
        },
      },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
        h('strong', { style: { flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title || item.id),
        h('span', { style: { fontSize: 10, opacity: 0.55 } }, frames.length > 1 ? '循环播放中' : '点击关闭'),
      ),
      h(
        'div',
        {
          style: {
            width: W,
            height: H,
            borderRadius: 6,
            overflow: 'hidden',
            background: T.fill,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          },
        },
        frame,
      ),
      h('div', { style: { marginTop: 8, fontSize: 10, opacity: 0.5, textAlign: 'center' } }, '再点一下关闭预览'),
    ),
  );
}

/** 一条动效的列表行；说明类条目点击看文档，不可插入。 */
function MotionRow({ item, onOpen, onInsert, onDoc }) {
  const native = !!item.native;
  return h(
    'div',
    {
      onClick: native ? undefined : () => onDoc(item),
      title: native ? '' : '点击查看这条 skill 说明',
      style: {
        cursor: native ? 'default' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 7px',
        borderRadius: 8,
        border: `1px solid ${T.border}`,
        background: native ? T.accentDim : T.fill,
      },
    },
    native
      ? h(MotionThumb, { item, onOpen })
      : h('div', { style: { width: 64, height: 36, flex: '0 0 auto' } }),
    h(
      'div',
      { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title || item.id),
      h('div', { style: { fontSize: 10, opacity: 0.45, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, native ? '原生 · ' + item.id : '仅说明 · ' + item.id),
    ),
    native
      ? h('button', { type: 'button', style: { ...btnStyle, padding: '2px 8px', flex: '0 0 auto' }, onClick: () => onInsert(item) }, '插入')
      : h('span', { style: { fontSize: 10, opacity: 0.4, flex: '0 0 auto' } }, '需外部渲染'),
  );
}

/** 说明类条目的文档弹层：显示 SKILL.md 正文，点击任意处关闭。 */
function MotionDoc({ item, onClose }) {
  const [text, setText] = React.useState('');
  const [meta, setMeta] = React.useState(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    setFailed(false);
    setText('');
    rpc('motion.doc', { entryId: item.id })
      .then((result) => {
        if (!alive) return;
        setText(result.doc || '');
        setMeta(result);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [item.id]);

  return h(
    'div',
    {
      role: 'button',
      tabIndex: 0,
      title: '点击关闭',
      onClick: onClose,
      onKeyDown: (e) => {
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') onClose();
      },
      style: {
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: T.mask,
        cursor: 'zoom-out',
      },
    },
    h(
      'div',
      {
        style: {
          width: 460,
          maxWidth: '90vw',
          boxSizing: 'border-box',
          padding: 12,
          borderRadius: 10,
          border: `1px solid ${T.border}`,
          background: T.panel,
          boxShadow: T.shadow,
        },
      },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
        h('strong', { style: { flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title || item.id),
        h('span', { style: { fontSize: 10, opacity: 0.45 } }, 'skill 说明'),
      ),
      h('div', { style: { fontSize: 10, opacity: 0.5, marginBottom: 8, fontFamily: 'ui-monospace, monospace' } }, item.id),
      failed
        ? h('div', { style: { fontSize: 11, opacity: 0.6, padding: '18px 0' } }, '读不到这条说明（文件可能已被删除）。')
        : h(
            'div',
            {
              style: {
                maxHeight: 340,
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                fontSize: 12,
                lineHeight: 1.65,
                padding: 10,
                borderRadius: 8,
                background: T.fill,
                border: `1px solid ${T.borderFaint}`,
              },
            },
            text || '读取中…',
          ),
      meta && meta.truncated
        ? h('div', { style: { marginTop: 6, fontSize: 10, opacity: 0.45 } }, '只显示前 ' + meta.doc.length + ' 字，全文 ' + meta.totalChars + ' 字。')
        : null,
      h('div', { style: { marginTop: 8, fontSize: 10, opacity: 0.5, textAlign: 'center' } }, '这是 agent 用的同一条说明；想让它做成原生图层，在对话里说「把 <id> 复刻成代码图层」。'),
    ),
  );
}

export function MotionLibrary({ onInsertMotion }) {
  const [items, setItems] = React.useState([]);
  const [q, setQ] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [preview, setPreview] = React.useState(null);
  const [doc, setDoc] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      const result = await rpc('motion.list', { query: q });
      setItems(result.entries || []);
    } catch {
      setItems([]);
    }
  }, [q]);

  React.useEffect(() => {
    if (open) load();
  }, [open, load]);

  const native = items.filter((x) => x.native);
  const docs = items.filter((x) => !x.native);

  return h(
    'div',
    { style: { borderTop: `1px solid ${T.border}`, padding: '8px 10px' } },
    h(
      'div',
      {
        style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
        onClick: () => {
          setPreview(null);
          setOpen((v) => !v);
        },
      },
      h('strong', { style: { fontSize: 12, flex: 1 } }, '动效库' + (open ? '（' + items.length + '）' : '')),
      h('span', { style: { fontSize: 10, opacity: 0.45 } }, open ? native.length + ' 原生 · ' + docs.length + ' 说明' : ''),
      h('span', { style: { fontSize: 11, opacity: 0.5 } }, open ? '收起' : '展开'),
    ),
    open
      ? h(
          'div',
          { style: { marginTop: 8 } },
          h('input', {
            type: 'search',
            placeholder: '搜动效…',
            value: q,
            onChange: (e) => setQ(e.target.value),
            style: { ...numStyle, width: '100%', marginBottom: 8 },
          }),
          h(
            'div',
            {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                maxHeight: 260,
                overflowY: 'auto',
                overflowX: 'hidden',
                paddingRight: 4,
              },
            },
            native.length || docs.length
              ? [...native, ...docs].map((item) =>
                  h(MotionRow, {
                    key: item.id,
                    item,
                    onOpen: (entry, code) => setPreview({ item: entry, code }),
                    onInsert: onInsertMotion,
                    onDoc: (entry) => setDoc(entry),
                  }),
                )
              : h('div', { style: { fontSize: 11, opacity: 0.5 } }, '没有匹配的条目。'),
          ),
          h(
            'div',
            { style: { marginTop: 6, fontSize: 10, opacity: 0.4 } },
            '原生可直接插入；说明类需要外部脚本渲染成文件再导入。',
          ),
        )
      : null,
    preview ? h(MotionPreview, { item: preview.item, code: preview.code, onClose: () => setPreview(null) }) : null,
    doc ? h(MotionDoc, { item: doc, onClose: () => setDoc(null) }) : null,
  );
}

// ------------------------------------------------------------------ 音效库 ----
//
// 宿主侧契约（固定，不许改字段名）：
//   sound.search  { query?, source?, limit?, maxDuration? }
//                 → { count, entries: [{ id, provider, title, duration, tags,
//                     license, attribution, pageUrl, previewUrl? }], warnings? }
//   sound.insert  { projectId, sessionId, entryId, start, trackId?, baseRevision? }
//                 → { revision, human, clipId, assetId }
//   sound.preview { entryId } → { kind:'url', url }
//                 local 的 url 指回 /api/video/sound（宿主流式路由），freesound 给外链。
//   sound.import  { url, rootName? } → { entry }            从直链导入到本地库
//   sound.kenney.list {} → { packs: [{ id, title, url }], reason }
//   sound.kenney.install { packUrl, rootName? }
//                 → { installed, files, root, manual, zipPath, reason }
//
// 两种来源走同一条路：拿到 url 才内联展开 <audio>，拿不到就禁用并说明原因。绝不拼假地址。

const SOUND_SOURCE_LABEL = { local: '本地', freesound: 'Freesound' };

/** 来源标签：本地 / Freesound，未知来源原样透出。 */
export function soundSourceLabel(provider) {
  return SOUND_SOURCE_LABEL[provider] || String(provider || '未知');
}

/**
 * 时长文案：`1.8s`；缺字段或非正数一律 `时长未知`。
 * durationExact === false（宿主侧按字节估算的）前面加 `≈`，不把估算说成精确值。
 */
export function soundDurationText(duration, exact) {
  const n = Number(duration);
  if (!Number.isFinite(n) || n <= 0) return '时长未知';
  return (exact === false ? '≈' : '') + n.toFixed(1) + 's';
}

/**
 * 把 sound.preview 的返回翻译成「能不能播、播什么」。
 *
 * 纯函数，UI 与测试共用。只认结果里有没有 url，不看 provider ——
 * 本地与在线现在都返回 { kind:'url', url }。entry 仅为调用方签名保留。
 */
export function soundPreviewPlan(entry, preview) {
  const kind = preview && preview.kind;
  const url = preview && preview.url;
  if (kind === 'url' && url) {
    return { playable: true, kind: 'url', url: String(url), title: '试听这条音效' };
  }
  return { playable: false, kind: kind || 'unknown', url: '', title: '这条音效暂不支持试听' };
}

/**
 * 错误码 → 人话。只覆盖「原样透出会把人引错方向」的几个码；
 * 其余一律显示原始 message（截断），不编。
 */
const SOUND_ERROR_HINT = {
  NO_API_KEY: '未配置 FREESOUND_API_KEY：先在终端 setx 再重启 DSH',
  NETWORK: '连不上 freesound.org',
  DOWNLOAD_FAILED: '音效下载失败',
  NOT_FOUND: '声音库里没有这个条目（在线条目要先搜一次）',
  INVALID_ARG: '参数不合法',
};

/** 兜底文案上限：太长会把面板撑坏 */
const SOUND_ERROR_MAX = 120;

/** 本地库为空（不是错误）时的引导文案 */
export const SOUND_EMPTY_LOCAL_TEXT =
  '本地库里还没有音效：去下面「获取音效包」下载，或用上面的链接导入。';

/**
 * 把一次 RPC 错误翻译成面板上的一句话。纯函数，UI 与测试共用。
 *
 * 有映射的错误码显示「码 · 人话」；没有映射就显示原始 message，截断到 120 字。
 * 绝不再返回「宿主侧还没接上」之类的推测 —— 真正的原因只有错误码和 message 说得清。
 */
export function soundErrorText(e) {
  const code = e && e.code ? String(e.code) : '';
  const raw = String((e && e.message) || '未知错误').trim() || '未知错误';
  const hint = code ? SOUND_ERROR_HINT[code] : '';
  if (hint) return code + ' · ' + hint;
  return raw.length > SOUND_ERROR_MAX ? raw.slice(0, SOUND_ERROR_MAX) + '…' : raw;
}

/**
 * 搜完了但 0 条：是「本地库本来就空」还是「这个词没匹配」？
 *
 * 只有「只看本地或全部」、没填关键词、也没设时长筛选的空结果才算本地库为空；
 * 有关键词是没匹配，设了 maxDuration 是筛掉了，都不该弹本地库的引导。
 * 纯函数，方便测试。
 */
export function soundEmptyReason({ source, query, entries, maxDuration } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length) return '';
  if (source === 'freesound') return '';
  if (String(query == null ? '' : query).trim()) return '';
  if (typeof maxDuration === 'number' && Number.isFinite(maxDuration) && maxDuration > 0) return '';
  return SOUND_EMPTY_LOCAL_TEXT;
}

/** 一条音效结果；试听按钮只在「确认拿不到 url」时禁用，并把这个原因写进 title。 */
function SoundRow({ entry, previewing, previewUrl, note, inserting, onPreview, onInsert }) {
  // note 是试听失败后落下的说明；有它这一行就保持禁用，不再重复请求
  const blocked = typeof note === 'string' && note ? note : '';
  const credit = [entry.license, entry.attribution].filter(Boolean).join(' · ');
  const tags = Array.isArray(entry.tags) ? entry.tags.filter(Boolean) : [];

  return h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '5px 7px',
        borderRadius: 8,
        border: `1px solid ${T.border}`,
        background: T.fill,
      },
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
      h(
        'span',
        {
          title: entry.title || entry.id,
          style: { flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        },
        entry.title || entry.id,
      ),
      chip(soundSourceLabel(entry.provider)),
    ),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, opacity: 0.5, minWidth: 0 } },
      h('span', { style: { flex: '0 0 auto' } }, soundDurationText(entry.duration, entry.durationExact)),
      tags.length
        ? h(
            'span',
            {
              title: tags.join('、'),
              style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            },
            tags.slice(0, 3).join(' · '),
          )
        : null,
    ),
    credit
      ? h(
          'div',
          {
            title: credit,
            style: { fontSize: 10, opacity: 0.38, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          },
          credit,
        )
      : null,
    h(
      'div',
      { style: { display: 'flex', gap: 6 } },
      h(
        'button',
        {
          type: 'button',
          disabled: !!blocked,
          title: blocked || (previewing ? '收起试听' : '试听这条音效'),
          onClick: () => onPreview(entry),
          style: {
            ...btnStyle,
            padding: '2px 8px',
            opacity: blocked ? 0.4 : 1,
            cursor: blocked ? 'not-allowed' : 'pointer',
          },
        },
        previewing ? '收起' : '试听',
      ),
      h(
        'button',
        {
          type: 'button',
          disabled: !!inserting,
          title: '插入到当前播放头',
          onClick: () => onInsert(entry),
          style: { ...btnStyle, padding: '2px 8px', opacity: inserting ? 0.5 : 1 },
        },
        inserting ? '插入中…' : '插入',
      ),
    ),
    previewUrl ? h('audio', { controls: true, src: previewUrl, style: { width: '100%', height: 30 } }) : null,
  );
}

/**
 * 音效库面板：折叠范式与 MotionLibrary 一致。
 *
 * 结果区固定 260px 内部滚动 —— 不随条目数把整页撑高（之前修过的 bug）。
 *
 * defaultOpen / defaultSource 只给渲染测试用（SSR 不会跑 effect，也点不动下拉），
 * 默认分别是 false / 'all'。
 */
export function SoundLibrary({ projectId, sessionId, playhead, onInserted, defaultOpen, defaultSource }) {
  const [open, setOpen] = React.useState(!!defaultOpen);
  const [q, setQ] = React.useState('');
  const [source, setSource] = React.useState(defaultSource || 'all');
  const [sort, setSort] = React.useState('blend');
  const [maxDuration, setMaxDuration] = React.useState('');
  const [entries, setEntries] = React.useState([]);
  const [warnings, setWarnings] = React.useState([]);
  const [searched, setSearched] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [unavailable, setUnavailable] = React.useState('');
  // 0 条结果时补一句「为什么是 0 条」（本地库为空 / 没匹配），与错误文案分开存
  const [emptyHint, setEmptyHint] = React.useState('');
  const [preview, setPreview] = React.useState(null); // { entryId, url }
  // 试听失败过的条目：entryId → 说明文案；有它按钮保持禁用，不再重复请求
  const [notes, setNotes] = React.useState({});
  const [inserting, setInserting] = React.useState('');

  // URL 导入
  const [importUrl, setImportUrl] = React.useState('');
  const [importing, setImporting] = React.useState(false);

  // Kenney 音效包：列表与下载状态都放局部，别污染全局 state
  const [kenneyOpen, setKenneyOpen] = React.useState(false);
  const [kenneyPacks, setKenneyPacks] = React.useState([]);
  const [kenneyReason, setKenneyReason] = React.useState('');
  const [kenneyLoading, setKenneyLoading] = React.useState(false);
  const [kenneyBusy, setKenneyBusy] = React.useState('');
  const [kenneyMsg, setKenneyMsg] = React.useState('');
  const [kenneyElapsed, setKenneyElapsed] = React.useState(0);

  // 每页条数与「匹配总数」：默认只拉 20 条，库里 700+ 时要能继续加载
  const [limit, setLimit] = React.useState(20);
  const [total, setTotal] = React.useState(0);

  // 竞态保护：只有最后一次请求的结果能落到 UI 上
  const seq = React.useRef(0);

  const search = React.useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    const params = { source, sort, limit };
    const text = q.trim();
    if (text) params.query = text;
    const max = Number(maxDuration);
    if (maxDuration !== '' && Number.isFinite(max) && max > 0) params.maxDuration = max;
    try {
      const result = await rpc('sound.search', params);
      if (my !== seq.current) return;
      const list = Array.isArray(result && result.entries) ? result.entries : [];
      setEntries(list);
      setTotal(Number.isFinite(result && result.total) ? result.total : list.length);
      setWarnings(Array.isArray(result && result.warnings) ? result.warnings : []);
      setNotes({});
      // 0 条不是错误时也要说清是哪种 0 条：库里空着，还是这个词没匹配
      setUnavailable('');
      setEmptyHint(
        soundEmptyReason({ source, query: text, entries: list, maxDuration: params.maxDuration }),
      );
    } catch (e) {
      if (my !== seq.current) return;
      setEntries([]);
      setWarnings([]);
      setEmptyHint('');
      // 真实原因只有错误码和 message 说得清，不许再拿「宿主侧没接上」糊弄。
      // reportError 原样透出同一个错误（toast 与这里说的是同一件事，不打架）。
      setUnavailable(soundErrorText(e));
      reportError(e, '音效库操作失败');
    } finally {
      if (my === seq.current) {
        setLoading(false);
        setSearched(true);
      }
    }
  }, [q, source, sort, maxDuration, limit]);

  // 换关键词/来源/时长时回到第一页，避免「上一次加载更多」的状态串到新查询
  React.useEffect(() => {
    setLimit(20);
  }, [q, source, sort, maxDuration]);

  // 展开/输入/改筛选后 250ms 防抖；回车立即搜
  React.useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => {
      search();
    }, 250);
    return () => clearTimeout(timer);
  }, [open, search]);

  async function previewEntry(entry) {
    // 已知拿不到 url 的条目：按钮保持禁用，点也不发请求
    if (notes && notes[entry.id]) return;
    if (preview && preview.entryId === entry.id) {
      setPreview(null);
      return;
    }
    try {
      const value = await rpc('sound.preview', { entryId: entry.id });
      const plan = soundPreviewPlan(entry, value);
      if (!plan.playable) {
        setPreview(null);
        setNotes((m) => ({ ...m, [entry.id]: plan.title }));
        toast(plan.title, 'warn');
        return;
      }
      setPreview({ entryId: entry.id, url: plan.url });
    } catch (e) {
      setPreview(null);
      // 试听失败也说实话：禁用原因就是这次错误，而不是一句笼统的「不支持」
      setNotes((m) => ({ ...m, [entry.id]: soundErrorText(e) }));
      reportError(e, '试听失败');
    }
  }

  async function insertEntry(entry) {
    if (inserting) return;
    setInserting(entry.id);
    try {
      await rpc('sound.insert', {
        projectId,
        sessionId,
        entryId: entry.id,
        start: Number.isFinite(playhead) ? playhead : 0,
      });
      await refresh();
      toast('已插入音效：' + (entry.title || entry.id));
      if (onInserted) onInserted(entry);
    } catch (e) {
      reportError(e, '音效库操作失败');
    } finally {
      setInserting('');
    }
  }

  // 下载中显示已用秒数：宿主是一次 RPC，拿不到真实进度，就老实显示等待时长
  React.useEffect(() => {
    if (!kenneyBusy) {
      setKenneyElapsed(0);
      return undefined;
    }
    const started = Date.now();
    setKenneyElapsed(0);
    const timer = setInterval(() => setKenneyElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [kenneyBusy]);

  /** 从直链导入：成功后刷新工程 + 重新搜索，让新条目立刻出现在列表里 */
  async function importFromUrl() {
    const url = importUrl.trim();
    if (!url || importing) return;
    setImporting(true);
    try {
      const value = await rpc('sound.import', { url });
      const entry = value && value.entry ? value.entry : value;
      await refresh();
      toast('已导入音效：' + ((entry && (entry.title || entry.id)) || url));
      setImportUrl('');
      await search();
    } catch (e) {
      reportError(e, '导入音效失败');
    } finally {
      setImporting(false);
    }
  }

  /** 展开「获取音效包」时按需拉一次清单，之后复用 */
  /** 拉一次资源包清单（带已安装标记）；展开和安装完成都会用到 */
  async function loadKenney() {
    setKenneyLoading(true);
    try {
      const value = await rpc('sound.kenney.list', {});
      setKenneyPacks(Array.isArray(value && value.packs) ? value.packs : []);
      setKenneyReason((value && value.reason) || '');
    } catch (e) {
      setKenneyPacks([]);
      setKenneyReason('读取资源包列表失败：' + soundErrorText(e));
    } finally {
      setKenneyLoading(false);
    }
  }

  async function toggleKenney() {
    const next = !kenneyOpen;
    setKenneyOpen(next);
    if (!next) return;
    setKenneyMsg('');
    await loadKenney();
  }

  /** 下载并解压一个 Kenney 包；失败与「需手动解压」都写清楚 */
  async function installPack(pack) {
    if (kenneyBusy) return;
    setKenneyBusy(pack.url);
    setKenneyMsg('');
    try {
      const value = await rpc('sound.kenney.install', { packUrl: pack.url });
      if (value && value.installed) {
        setKenneyMsg(`已安装「${pack.title}」：${value.files} 个音频文件 → ${value.root}`);
        toast('已下载音效包：' + pack.title);
        await Promise.all([search(), loadKenney()]);
      } else {
        const reason = (value && value.reason) || '下载完成但没有解压成功';
        const zip = value && value.zipPath ? '（zip 已保存到 ' + value.zipPath + '）' : '';
        setKenneyMsg('需要手动解压：' + reason + zip);
        toast('音效包已下载，但需要手动解压', 'warn');
      }
    } catch (e) {
      setKenneyMsg('下载失败：' + soundErrorText(e));
      reportError(e, '下载音效包失败');
    } finally {
      setKenneyBusy('');
    }
  }

  // 排序只作用于 Freesound：「全部」且这次真带回了在线结果时才显示它
  const showSort =
    source === 'freesound' || (source === 'all' && entries.some((e) => e && e.provider === 'freesound'));

  return h(
    'div',
    { style: { borderTop: `1px solid ${T.border}`, padding: '8px 10px' } },
    h(
      'div',
      {
        style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
        onClick: () => {
          setPreview(null);
          setOpen((v) => !v);
        },
      },
      h('strong', { style: { fontSize: 12, flex: 1 } }, '音效库' + (open && searched ? '（' + entries.length + '）' : '')),
      h('span', { style: { fontSize: 10, opacity: 0.45 } }, open && warnings.length ? warnings.length + ' 条提示' : ''),
      h('span', { style: { fontSize: 11, opacity: 0.5 } }, open ? '收起' : '展开'),
    ),
    open
      ? h(
          'div',
          { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
          // URL 导入：粘贴直链，宿主负责下载、校验与按域名归档
          h(
            'div',
            { style: { display: 'flex', gap: 6 } },
            h('input', {
              type: 'url',
              placeholder: '粘贴音效直链（http/https）…',
              value: importUrl,
              onChange: (e) => setImportUrl(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  importFromUrl();
                }
              },
              style: { ...numStyle, flex: 1, minWidth: 0 },
            }),
            h(
              'button',
              {
                type: 'button',
                disabled: importing,
                title: '从直链下载一条音效到本地声音库（15 秒超时 / 50MB 上限）',
                onClick: importFromUrl,
                style: { ...btnStyle, whiteSpace: 'nowrap', opacity: importing ? 0.5 : 1 },
              },
              importing ? '导入中…' : '导入链接',
            ),
          ),
          h('input', {
            type: 'search',
            placeholder: '搜音效…',
            value: q,
            onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                search();
              }
            },
            style: { ...numStyle, width: '100%' },
          }),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            h(
              'select',
              {
                value: source,
                onChange: (e) => setSource(e.target.value),
                title: '音效来源',
                style: { ...numStyle, width: 92, padding: '3px 4px' },
              },
              [
                ['all', '全部'],
                ['local', '本地'],
                ['freesound', 'Freesound'],
              ].map(([v, label]) => h('option', { key: v, value: v }, label)),
            ),
            // 排序只作用于 Freesound：纯本地或「全部但没带回在线结果」时不给这个入口
            showSort
              ? h(
                  'select',
                  {
                    value: sort,
                    onChange: (e) => setSort(e.target.value),
                    title: 'Freesound 排序方式（不影响本地结果）',
                    style: { ...numStyle, width: 78, padding: '3px 4px' },
                  },
                  [
                    ['blend', '综合'],
                    ['rating', '评分'],
                    ['downloads', '下载量'],
                  ].map(([v, label]) => h('option', { key: v, value: v }, label)),
                )
              : null,
            h('input', {
              type: 'number',
              min: 0,
              step: 0.5,
              placeholder: '最长时长',
              title: '只显示不超过这个秒数的音效（留空不限）',
              value: maxDuration,
              onChange: (e) => setMaxDuration(e.target.value),
              style: { ...numStyle, width: 82 },
            }),
            h('span', { style: { fontSize: 10, opacity: 0.4 } }, '秒'),
          ),
          warnings.length ? h('div', { style: { fontSize: 10, opacity: 0.55, lineHeight: 1.5 } }, warnings.join('；')) : null,
          unavailable ? h('div', { style: { fontSize: 10, opacity: 0.6, lineHeight: 1.5 } }, unavailable) : null,
          h(
            'div',
            {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                maxHeight: 260,
                overflowY: 'auto',
                overflowX: 'hidden',
                paddingRight: 4,
              },
            },
            entries.length
              ? entries.map((entry) =>
                  h(SoundRow, {
                    key: entry.id,
                    entry,
                    previewing: !!(preview && preview.entryId === entry.id && preview.url),
                    previewUrl: preview && preview.entryId === entry.id ? preview.url || '' : '',
                    note: (notes && notes[entry.id]) || '',
                    inserting: inserting === entry.id,
                    onPreview: previewEntry,
                    onInsert: insertEntry,
                  }),
                )
              : h(
                  'div',
                  { style: { fontSize: 11, opacity: 0.5, lineHeight: 1.5 } },
                  loading || !searched
                    ? '搜索中…'
                    : unavailable
                      ? '搜索失败，原因见上方。'
                      : emptyHint || '没有匹配的音效。',
                ),
          ),
          total > entries.length
            ? h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4 } },
                h(
                  'span',
                  { style: { fontSize: 10, opacity: 0.5 } },
                  `共 ${total} 条，显示前 ${entries.length} 条`,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => setLimit((v) => Math.min(200, v + 40)),
                    style: { ...btnStyle, padding: '2px 8px', fontSize: 10 },
                  },
                  '加载更多',
                ),
              )
            : h(
                'div',
                { style: { fontSize: 10, opacity: 0.4, paddingTop: 4 } },
                searched && entries.length ? `共 ${total} 条，已全部显示` : '',
              ),
          // 获取音效包：点开才请求清单，避免每次展开面板都打网络
          h(
            'div',
            { style: { borderTop: `1px solid ${T.border}`, paddingTop: 6 } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }, onClick: toggleKenney },
              h('strong', { style: { fontSize: 11, flex: 1 } }, '获取音效包'),
              h('span', { style: { fontSize: 10, opacity: 0.45 } }, kenneyOpen ? '' : 'kenney.nl · CC0'),
              h('span', { style: { fontSize: 10, opacity: 0.5 } }, kenneyOpen ? '收起' : '展开'),
            ),
            kenneyOpen
              ? h(
                  'div',
                  { style: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 } },
                  kenneyLoading
                    ? h('div', { style: { fontSize: 10, opacity: 0.5 } }, '读取资源包列表…')
                    : kenneyPacks.length
                      ? h(
                          'div',
                          {
                            style: {
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 4,
                              maxHeight: 180,
                              overflowY: 'auto',
                              overflowX: 'hidden',
                              paddingRight: 4,
                            },
                          },
                          kenneyPacks.map((pack) =>
                            h(
                              'div',
                              { key: pack.url, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 } },
                              h(
                                'span',
                                {
                                  title: pack.title,
                                  style: {
                                    flex: 1,
                                    minWidth: 0,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  },
                                },
                                pack.title,
                              ),
                              pack.installed
                                ? h(
                                    'span',
                                    {
                                      title: '该包已解压到本地库',
                                      style: { fontSize: 10, opacity: 0.55, flex: '0 0 auto' },
                                    },
                                    `已安装 ${pack.files || ''}`.trim(),
                                  )
                                : null,
                              h(
                                'button',
                                {
                                  type: 'button',
                                  disabled: !!kenneyBusy,
                                  title: '下载并解压到声音库根目录',
                                  onClick: () => installPack(pack),
                                  style: {
                                    ...btnStyle,
                                    padding: '2px 8px',
                                    flex: '0 0 auto',
                                    opacity: kenneyBusy && kenneyBusy !== pack.url ? 0.45 : 1,
                                  },
                                },
                                kenneyBusy === pack.url ? '下载中…' : '下载',
                              ),
                            ),
                          ),
                        )
                      : h(
                          'div',
                          { style: { fontSize: 10, opacity: 0.5, lineHeight: 1.5 } },
                          kenneyReason || '没有可下载的音效包。',
                        ),
                  kenneyBusy
                    ? h(
                        'div',
                        { style: { fontSize: 10, opacity: 0.55 } },
                        '正在下载并解压… ' + kenneyElapsed + 's（大包可能需要几十秒）',
                      )
                    : null,
                  kenneyMsg ? h('div', { style: { fontSize: 10, opacity: 0.55, lineHeight: 1.5 } }, kenneyMsg) : null,
                )
              : null,
          ),
          h(
            'div',
            { style: { fontSize: 10, opacity: 0.4, lineHeight: 1.5 } },
            '插入到当前播放头；点「试听」就地播放，本地与在线音源都支持。',
          ),
        )
      : null,
  );
}

/**
 * 视频判定统一走 media-kind.mjs（ffprobe 流类型 > mime > 扩展名）。
 *
 * 这里保留本地同名函数只是为了不动所有调用点；判据不再各写一份 —— 过去
 * 「面板按 mime 给按钮、播放器按 mime 建元素」两处独立判断，音频就是这样
 * 混进视频入口的。
 */
function isVideoAsset(asset) {
  return assetKind(asset) === KIND.VIDEO;
}

/** 音频素材：只能进音频轨（a1），不参与画面合成。 */
function isAudioAsset(asset) {
  return assetKind(asset) === KIND.AUDIO;
}

/** 这份解析结果是不是某个素材的：id → 相对路径 → 文件名，三级比对 */
function analysisFor(analysis, asset) {
  if (!analysis || analysis.ok !== true) return null;
  if (analysis.assetId && analysis.assetId === asset.id) return analysis;
  if (analysis.assetPath && analysis.assetPath === asset.path) return analysis;
  const file = analysis.meta && analysis.meta.file ? String(analysis.meta.file) : '';
  if (file && asset.name && file.split(/[\\/]/).pop() === asset.name) return analysis;
  return null;
}

function colorHex(color) {
  if (!color) return null;
  const hex = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0))).toString(16).padStart(2, '0');
  return '#' + hex(color.r) + hex(color.g) + hex(color.b);
}

/** 一行摘要：`37 镜 · 平均 0.4s · 快切 · 主色 #1d2b3a` */
function analysisSummary(doc) {
  const stats = doc.stats || {};
  const palette = (stats.colorPalette || [])[0];
  const count = stats.shotCount || 0;
  const avg = Number(stats.avgShot || 0);
  const avgText = avg >= 10 ? avg.toFixed(0) : avg.toFixed(1);
  const paceText = doc.pace === 'fast' ? '快切' : doc.pace === 'slow' ? '慢切' : '中速';
  return `${count} 镜 · 平均 ${avgText}s · ${paceText} · 主色 ${palette && palette.hex ? palette.hex : '未知'}`;
}

const shotGrid = {
  display: 'grid',
  gridTemplateColumns: '26px 1fr 46px 16px',
  gap: 6,
  alignItems: 'center',
  fontSize: 10,
  lineHeight: 1.7,
};

function shotSwatch(color) {
  const hex = colorHex(color);
  return {
    width: 12,
    height: 12,
    borderRadius: 3,
    background: hex || 'transparent',
    border: `1px solid ${T.border}`,
    display: 'inline-block',
  };
}

const secText = (value) => Number(value || 0).toFixed(2);

/** 参考卡上的一行：`镜头表 · 37 镜 · 平均 0.40s` */
function shotTableSummary(doc) {
  const stats = (doc && doc.stats) || {};
  const count = stats.shotCount || (doc && Array.isArray(doc.shots) ? doc.shots.length : 0);
  const avg = Number(stats.avgShot || 0);
  return `镜头表 · ${count} 镜 · 平均 ${avg.toFixed(2)}s`;
}

const assetCardStyle = {
  border: `1px solid ${T.border}`,
  borderRadius: 10,
  padding: '8px 10px',
  fontSize: 12,
  background: `linear-gradient(180deg, ${T.fill}, transparent)`,
};

export function MediaBin({ assets, onInsert, onInsertPip, onInsertAudio, onImported }) {
  const inputRef = React.useRef(null);
  const [dragOver, setDragOver] = React.useState(false);
  // ---- 解析：只有用户点了「解析」才有动作，导入素材时这里一行都不跑 ----
  const [analysis, setAnalysis] = React.useState(null); // analyze.read / analyze.run 的结果
  const [analysisError, setAnalysisError] = React.useState(null); // { assetId, message }
  const [running, setRunning] = React.useState(null); // { assetId, seconds }
  const [expandedId, setExpandedId] = React.useState(null);
  // 编码探测：只有「浏览器解不出宽高」的素材才跑（只读路由 /api/video/probe）
  const [probes, setProbes] = React.useState({});
  const probeRef = React.useRef(new Set());
  // 降级 / 重建骨架都要在面板内确认，不用 window.confirm（webview 里它是哑的）
  const [pending, setPending] = React.useState(null); // { assetId, kind:'reference'|'rebuild' }
  const [applying, setApplying] = React.useState(null);
  const [viewAsset, setViewAsset] = React.useState(null); // 「查看原片」弹窗
  const alive = React.useRef(true);
  const tickRef = React.useRef(null);

  React.useEffect(
    () => () => {
      alive.current = false;
      if (tickRef.current) clearInterval(tickRef.current);
    },
    [],
  );

  // 打开面板就把上次结果读回来：重启后摘要还在，不用重新跑一遍
  React.useEffect(() => {
    if (!state.projectId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const value = await rpc('analyze.read', { projectId: state.projectId, sessionId: state.sessionId });
        if (!cancelled && value && value.ok === true) setAnalysis(value);
      } catch {
        // 读不到就是「还没解析过」，这不是错误，不打扰用户
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.projectId]);

  function stopTimer() {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    setRunning(null);
  }

  async function analyze(asset) {
    if (running) return;
    const startedAt = Date.now();
    setAnalysisError(null);
    setRunning({ assetId: asset.id, seconds: 0 });
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      if (!alive.current) return;
      setRunning((cur) => (cur ? { ...cur, seconds: Math.round((Date.now() - startedAt) / 1000) } : cur));
    }, 1000);
    try {
      const value = await rpc('analyze.run', {
        projectId: state.projectId,
        sessionId: state.sessionId,
        assetPath: asset.path,
      });
      if (!alive.current) return;
      setAnalysis(value);
      setExpandedId(null);
      toast(
        value.cached
          ? `已解析过（源文件没变），直接复用：${(value.stats && value.stats.shotCount) || 0} 镜`
          : `解析完成：${(value.stats && value.stats.shotCount) || 0} 个镜头`,
      );
    } catch (e) {
      if (!alive.current) return;
      // 真实错误原样显示（缺 ffmpeg / 坏文件 / 超时 的文案都是宿主给的）
      setAnalysisError({ assetId: asset.id, message: (e && e.message) || '解析失败' });
      reportError(e, '解析失败');
    } finally {
      if (alive.current) stopTimer();
      else if (tickRef.current) clearInterval(tickRef.current);
    }
  }

  /** 只读探测编码：失败只多一行提示，绝不打断导入 / 预览。 */
  async function probeCodec(asset) {
    try {
      const url =
        '/api/video/probe?projectId=' + encodeURIComponent(state.projectId) + '&assetId=' + encodeURIComponent(asset.id);
      const res = await fetch(url);
      const data = await res.json().catch(() => null);
      if (!alive.current) return;
      if (!data || data.ok !== true) {
        setProbes((prev) => ({
          ...prev,
          [asset.id]: {
            ok: false,
            // PROJECT_NOT_OPEN 是「工程未加载」的正常状态，不是错误，渲染时走灰色小字
            code: (data && data.code) || '',
            reason: (data && data.reason) || '探测失败',
          },
        }));
        return;
      }
      setProbes((prev) => ({ ...prev, [asset.id]: { ok: true, probe: data.probe || {}, advice: data.advice || null } }));
    } catch (e) {
      if (!alive.current) return;
      setProbes((prev) => ({ ...prev, [asset.id]: { ok: false, reason: (e && e.message) || '探测失败' } }));
    }
  }

  // 有 probe、但浏览器解不出宽高 → 自动跑一次编码探测（每个素材只跑一次）
  React.useEffect(() => {
    if (!state.projectId) return;
    for (const a of assets || []) {
      if (!isVideoAsset(a)) continue;
      if (!a.probe || a.probe.width > 0 || a.probe.codec) continue;
      if (probeRef.current.has(a.id)) continue;
      probeRef.current.add(a.id);
      probeCodec(a);
    }
  }, [assets, state.projectId]);

  /** 备份原片并把预览指向备份：一次 RPC、一次事务，失败原样报错。 */
  async function applyRef(asset, kind) {
    if (applying) return;
    setApplying(asset.id);
    try {
      const value = await rpc('reference.apply', {
        projectId: state.projectId,
        sessionId: state.sessionId,
        assetId: asset.id,
        baseRevision: state.doc ? state.doc.revision : undefined,
      });
      setPending(null);
      await refresh();
      toast(
        `已备份原片：${value.backedUpTo}${value.backupReused ? '（复用已有备份）' : ''} · 预览改走备份`,
        'info',
      );
    } catch (e) {
      reportError(e, '备份原片失败');
    } finally {
      if (alive.current) setApplying(null);
    }
  }

  function renderConfirm(asset, kind) {
    return h(
      'div',
      {
        style: {
          marginTop: 6,
          padding: 8,
          borderRadius: 8,
          border: `1px solid ${T.warn}`,
          background: T.warnDim,
          fontSize: 11,
          lineHeight: 1.6,
        },
      },
      h(
        'div',
        null,
        kind === 'rebuild'
          ? '会按当前镜头表重建骨架（旧骨架先删后插）；原片已备份过就复用，不再复制。一次事务，可撤销。'
          : '会先备份原片到 reference/，再从轨道上移除它的片段、标记为只读参考，并按镜头表建骨架。一次事务，可撤销。',
      ),
      h(
        'div',
        { style: { display: 'flex', gap: 6, marginTop: 6 } },
        h(
          'button',
          {
            type: 'button',
            disabled: applying === asset.id,
            style: { ...btnStyle, background: T.warnDim, borderColor: T.warn, color: T.warn },
            onClick: () => applyRef(asset, kind),
          },
          applying === asset.id ? '处理中…' : '确认',
        ),
        h('button', { type: 'button', style: btnStyle, onClick: () => setPending(null) }, '取消'),
      ),
    );
  }

  function renderProbeInfo(asset) {
    const info = probes[asset.id];
    if (!info) return null;
    if (info.ok === false) {
      // 「工程未打开」是 /api/video/probe 的正常应答（200 + code），不是错误 ——
      // 画成灰色小字，别把素材卡打成红色报错。
      const soft = info.code === 'PROJECT_NOT_OPEN';
      return h(
        'div',
        {
          style: {
            marginTop: 4,
            fontSize: 11,
            color: soft ? T.textDim : T.warn,
            opacity: soft ? 0.6 : 1,
            lineHeight: 1.5,
          },
        },
        (soft ? '工程未加载，暂时没探测编码：' : '编码探测失败：') + info.reason,
      );
    }
    const probe = info.probe || {};
    const codec = probe.codec || '?';
    const profile = probe.profile || '?';
    const pix = probe.pixFmt || probe.pix_fmt || '?';
    return h(
      'div',
      { style: { marginTop: 4, fontSize: 11, lineHeight: 1.6 } },
      h('div', { style: { color: T.warn } }, `编码 ${codec} · ${profile} · ${pix}`),
      info.advice
        ? h(
            'div',
            { style: { marginTop: 2, color: T.danger } },
            h('div', null, info.advice.text),
            h(
              'code',
              {
                style: {
                  display: 'block',
                  marginTop: 3,
                  padding: '4px 6px',
                  borderRadius: 5,
                  background: T.fill,
                  fontSize: 10.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                },
              },
              info.advice.command,
            ),
          )
        : null,
    );
  }

  function renderShotTable(assetId, shots) {
    const rows = shots.slice(0, 20).map((shot) =>
      h(
        'div',
        { key: 'shot-' + shot.index, style: shotGrid },
        h('span', { style: { opacity: 0.5 } }, String(shot.index)),
        h('span', null, `${secText(shot.start)}–${secText(shot.end)}`),
        h('span', { style: { opacity: 0.7 } }, `${secText(shot.duration)}s`),
        h('span', { title: colorHex(shot.color) || '无代表色', style: shotSwatch(shot.color) }),
      ),
    );
    return h(
      'div',
      { key: 'shots-' + assetId, style: { marginTop: 4, borderTop: `1px dashed ${T.border}`, paddingTop: 4 } },
      h(
        'div',
        { style: { ...shotGrid, opacity: 0.4 } },
        h('span', null, '序号'),
        h('span', null, '起止'),
        h('span', null, '时长'),
        h('span', null, '色'),
      ),
      rows,
      shots.length > 20 ? h('div', { style: { fontSize: 10, opacity: 0.4, marginTop: 2 } }, `还有 ${shots.length - 20} 条未显示`) : null,
    );
  }

  function renderAnalysis(asset) {
    const own = analysisFor(analysis, asset);
    const err = analysisError && analysisError.assetId === asset.id ? analysisError.message : '';
    if (!own && !err) return null;
    const nodes = [];
    if (err) {
      nodes.push(
        h(
          'div',
          { key: 'err', style: { marginTop: 6, fontSize: 10, color: T.warn, lineHeight: 1.55, whiteSpace: 'pre-wrap' } },
          '解析失败：' + err,
        ),
      );
    }
    if (own) {
      nodes.push(
        h('div', { key: 'sum', style: { marginTop: 6, fontSize: 10, color: T.ok, lineHeight: 1.5 } }, analysisSummary(own)),
      );
      if (own.hint) {
        nodes.push(h('div', { key: 'hint', style: { fontSize: 10, opacity: 0.45, lineHeight: 1.5 } }, own.hint));
      }
      const shots = Array.isArray(own.shots) ? own.shots : [];
      if (shots.length) {
        const open = expandedId === asset.id;
        nodes.push(
          h(
            'div',
            {
              key: 'toggle',
              onClick: () => setExpandedId(open ? null : asset.id),
              style: { marginTop: 4, fontSize: 10, opacity: 0.55, cursor: 'pointer', userSelect: 'none' },
            },
            open ? '收起镜头表' : `展开镜头表（前 ${Math.min(20, shots.length)} 条）`,
          ),
        );
        if (open) nodes.push(renderShotTable(asset.id, shots));
      }
    }
    return h('div', { key: 'analysis', style: { marginTop: 2 } }, nodes);
  }

  async function handleFiles(files) {
    if (!files || !files.length) return;
    for (const file of files) {
      try {
        state.busy = { label: `导入 ${file.name}`, ratio: 0.3 };
        const asset = await uploadFile(file, () => {});
        toast(`已导入 ${asset.name}`);
      } catch (e) {
        reportError(e, '导入失败');
      } finally {
        state.busy = null;
      }
    }
    await onImported();
  }

  async function rescan() {
    try {
      await scanAssets();
      await onImported();
      toast('已重新扫描 assets 目录');
    } catch (e) {
      reportError(e, '扫描失败');
    }
  }

  const normalAssets = (assets || []).filter((a) => a.status !== 'reference');
  const referenceAssets = (assets || []).filter((a) => a.status === 'reference');

  function renderAssetCard(a) {
    const own = analysisFor(analysis, a);
    const showsTable = !!own;
    const pendingHere = pending && pending.assetId === a.id;
    return h(
      'div',
      { key: a.id, style: assetCardStyle },
      h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
        // 解析过以后卡片名字换成镜头表摘要，原始文件名退到 title 提示里
        h('span', { title: a.name, style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          showsTable ? shotTableSummary(own) : a.name),
        chip(kindLabel(assetKind(a))),
      ),
      h('div', { style: { opacity: 0.6, marginTop: 4, fontSize: 11 } },
        a.probe && a.probe.duration ? `${a.probe.duration.toFixed(2)}s · ${a.probe.width || '?'}×${a.probe.height || '?'}` : '未探测'),
      // 音频：说清它不进画面，只进 a1 —— 点下去的行为与这句提示必须一致。
      isAudioAsset(a)
        ? h('div', { style: { marginTop: 4, fontSize: 11, color: T.ok, lineHeight: 1.5 } },
            '音频素材：不参与画面合成，只进音频轨 a1。')
        : null,
      // 有 probe 但解不出宽高 = 浏览器连元数据都没认出来，多半是编码不支持。
      // 这只是「警告」，不影响导入：素材还在，只是预览画不出来。
      isVideoAsset(a) && a.probe && !(a.probe.width > 0)
        ? h('div', { style: { marginTop: 4, fontSize: 11, color: T.danger, lineHeight: 1.5 } },
            '编码可能不受支持：浏览器没解出画面尺寸（HEVC/H.265、10bit、ProRes 常见）。')
        : null,
      renderProbeInfo(a),
      h(
        'div',
        { style: { marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' } },
        // 按 kind 分流：策略来自 media-kind.mjs 的 insertPolicy —— 音频只有
        // 「加入音频轨（a1）」一个入口。过去这里对音频也画「加入主轨 / 画中画」，
        // 点下去就把它插进视频轨，而预览池永远不会为音频建 <video>（videoWidth=0）
        // —— 画面永远解不出。
        insertPolicy(a).buttons.includes('audio')
          ? h(
              'button',
              {
                type: 'button',
                style: btnStyle,
                title: '音频不参与画面合成；插入到播放头处的 a1 音频轨',
                onClick: () => (onInsertAudio || onInsert)(a),
              },
              '加入音频轨（a1）',
            )
          : [
              h('button', { key: 'main', type: 'button', style: btnStyle, onClick: () => onInsert(a) }, '加入主轨'),
              h('button', { key: 'pip', type: 'button', style: btnStyle, onClick: () => onInsertPip && onInsertPip(a) }, '画中画'),
            ],
        // 只有视频素材才给「解析」；点了才跑，导入时什么都不会发生
        isVideoAsset(a)
          ? h(
              'button',
              {
                type: 'button',
                disabled: !!running,
                style: { ...btnStyle, opacity: running ? 0.5 : 1, cursor: running ? 'progress' : 'pointer' },
                title: '解析镜头切点、每镜代表色与节奏（手动触发，导入时不会自动跑）',
                onClick: () => analyze(a),
              },
              running && running.assetId === a.id
                ? `解析中… ${running.seconds} 秒`
                : showsTable
                  ? '已解析'
                  : '解析',
            )
          : null,
        // 解不出宽高且还没探测过编码 → 手动补一次（自动那条只跑一次）
        isVideoAsset(a) && a.probe && !(a.probe.width > 0) && !probes[a.id]
          ? h('button', { type: 'button', style: btnStyle, title: '用 ffprobe 读 codec / profile / pix_fmt，给转码建议', onClick: () => probeCodec(a) }, '探测编码')
          : null,
        // 解析成功后才出现；点了才降级，绝不自动执行（用户要求手动）
        showsTable && isVideoAsset(a)
          ? h(
              'button',
              {
                type: 'button',
                style: { ...btnStyle, color: T.warn, borderColor: T.warn },
                disabled: !!applying,
                title: '把原片复制到 reference/ 并把预览指向备份；原片仍留在轨道上可编辑（一次事务，可撤销）',
                onClick: () => setPending({ assetId: a.id, kind: 'reference' }),
              },
              '备份原片',
            )
          : null,
      ),
      pendingHere ? renderConfirm(a, 'reference') : renderAnalysis(a),
    );
  }

  function renderReferenceCard(a) {
    const own = analysisFor(analysis, a);
    const pendingHere = pending && pending.assetId === a.id;
    return h(
      'div',
      {
        key: a.id,
        style: Object.assign({}, assetCardStyle, {
          borderColor: T.borderStrong,
          background: `linear-gradient(180deg, ${T.fill}, transparent)`,
        }),
      },
      h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
        h('span', { title: a.name, style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          own ? shotTableSummary(own) : '参考 · 未解析'),
        chip('参考'),
      ),
      h('div', { style: { opacity: 0.5, marginTop: 4, fontSize: 11, lineHeight: 1.5 } }, a.name + '（只读，不在时间线上）'),
      h('div', { style: { marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' } },
        h('button', { type: 'button', style: btnStyle, onClick: () => setViewAsset(a) }, '查看原片'),
        h(
          'button',
          {
            type: 'button',
            style: btnStyle,
            disabled: !!applying,
            title: '按当前镜头表重新铺一遍骨架（旧骨架先删后插）',
            onClick: () => setPending({ assetId: a.id, kind: 'rebuild' }),
          },
          '按镜头表重建骨架',
        ),
      ),
      pendingHere ? renderConfirm(a, 'rebuild') : null,
    );
  }

  const viewModal = viewAsset
    ? h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            background: T.mask,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            padding: 20,
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: T.text } },
          h('span', null, '参考原片 · ' + viewAsset.name),
          h('button', { type: 'button', style: btnStyle, onClick: () => setViewAsset(null) }, '关闭'),
        ),
        h('video', {
          controls: true,
          src: mediaUrl(viewAsset.id),
          style: { maxWidth: '92%', maxHeight: '76%', background: '#000', borderRadius: 8 },
        }),
      )
    : null;

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' } },
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 10px',
          borderBottom: `1px solid ${T.border}`,
          fontSize: 12,
        },
      },
      h('strong', { style: { flex: 1 } }, '素材'),
      h('button', { type: 'button', onClick: () => inputRef.current && inputRef.current.click(), style: btnStyle, title: '导入视频 / 音频 / 图片（mp4 / mov / mkv / mp3 / wav / png…）' }, '导入视频'),
      h('button', { type: 'button', onClick: rescan, style: btnStyle, title: '重新扫描工程 assets 目录' }, '扫描'),
      h('input', {
        ref: inputRef,
        type: 'file',
        multiple: true,
        accept: 'video/*,audio/*,image/*',
        style: { display: 'none' },
        onChange: (e) => handleFiles(e.target.files),
      }),
    ),
    h(
      'div',
      {
        onDragOver: (e) => {
          e.preventDefault();
          setDragOver(true);
        },
        onDragLeave: () => setDragOver(false),
        onDrop: (e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        },
        style: {
          flex: 1,
          overflow: 'auto',
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          outline: dragOver ? `2px dashed ${T.accent}` : 'none',
          outlineOffset: -6,
        },
      },
      normalAssets.length === 0 && referenceAssets.length === 0
        ? h('div', { style: { fontSize: 12, opacity: 0.5, padding: 12, lineHeight: 1.6 } }, '还没有素材。把 MP4 等视频、音频、图片拖到这里，或点「导入视频」。字幕请用顶部「导入字幕(.srt)」。')
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            normalAssets.length === 0
              ? h('div', { style: { fontSize: 11, opacity: 0.5, padding: '2px 4px' } }, '素材都降级成参考了。')
              : null,
            normalAssets.map(renderAssetCard),
            referenceAssets.length
              ? h('div', { style: { marginTop: 4, paddingTop: 8, borderTop: `1px dashed ${T.border}` } },
                  h('div', { style: { fontSize: 11, opacity: 0.6, marginBottom: 6 } }, `参考（只读）· ${referenceAssets.length}`),
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, referenceAssets.map(renderReferenceCard)),
                )
              : null,
          ),
    ),
    viewModal,
  );
}

const btnStyle = {
  padding: '3px 8px',
  borderRadius: 6,
  border: `1px solid ${T.border}`,
  background: T.panel,
  color: T.text,
  fontSize: 11,
  cursor: 'pointer',
};

function keyframeCount(clip) {
  return (clip.keyframes || []).length;
}

/**
 * 空工程提示条：从模板起步。
 *
 * 只由 main.js 在「有工程且一个片段都没有」时渲染；套用成功后 refresh()
 * 会把片段数拉到 > 0，这条提示自然消失。
 */
export function TemplateBar({ projectId, sessionId }) {
  const [open, setOpen] = React.useState(false);
  const [templates, setTemplates] = React.useState(null);
  const [applying, setApplying] = React.useState(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || templates) return;
    try {
      const value = await rpc('template.list', {});
      setTemplates(value.templates || []);
    } catch (e) {
      reportError(e, '读取模板失败');
    }
  }

  async function apply(template) {
    if (applying) return;
    setApplying(template.id);
    try {
      await rpc('template.apply', {
        projectId,
        sessionId,
        templateId: template.id,
        baseRevision: state.doc ? state.doc.revision : undefined,
      });
      await refresh();
      setOpen(false);
      toast('已套用模板：' + template.name);
    } catch (e) {
      reportError(e, '套用模板失败');
    } finally {
      setApplying(null);
    }
  }

  return h(
    'div',
    {
      style: {
        flex: '0 0 auto',
        padding: '6px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        borderBottom: `1px solid ${T.border}`,
        background: T.accentDim,
      },
    },
    h(
      'button',
      {
        type: 'button',
        onClick: toggle,
        style: Object.assign({}, btnStyle, { alignSelf: 'flex-start' }),
        title: '竖屏口播 / 产品发布 / 数据叙事 / 字幕动画',
      },
      open ? '当前是空工程 · 收起模板' : '当前是空工程 · 套用模板',
    ),
    open
      ? h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
          templates
            ? templates.map((t) =>
                h(
                  'button',
                  {
                    key: t.id,
                    type: 'button',
                    disabled: !!applying,
                    onClick: () => apply(t),
                    title: t.description,
                    style: Object.assign({}, btnStyle, {
                      textAlign: 'left',
                      lineHeight: 1.5,
                      opacity: applying && applying !== t.id ? 0.45 : 1,
                    }),
                  },
                  `${t.name} · ${t.ratio} · ${t.duration}s` + (applying === t.id ? ' · 套用中…' : ''),
                ),
              )
            : h('span', { style: { fontSize: 11, opacity: 0.6 } }, '读取模板中…'),
        )
      : null,
  );
}

function keyframeValue(clip, prop) {
  const track = (clip.keyframes || []).filter((k) => k.property === prop).sort((a, b) => a.t - b.t);
  if (track.length) return track[track.length - 1].value;
  if (prop === 'scale') return (clip.transform && clip.transform.scale) || 1;
  if (prop === 'opacity') return clip.transform && clip.transform.opacity != null ? clip.transform.opacity : 1;
  return 0;
}

const EFFECT_LABEL = { brightness: '亮度', contrast: '对比度', saturate: '饱和度', blur: '模糊', temperature: '色温', tint: '色调', vignette: '暗角' };

function effectValue(clip, type, fallback) {
  const found = (clip.effects || []).find((e) => e.type === type);
  return found ? found.value : fallback;
}

function Field({ label, children }) {
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 12 } },
    h('span', { style: { width: 64, opacity: 0.65 } }, label),
    children,
  );
}

const numStyle = {
  width: 78,
  padding: '3px 6px',
  borderRadius: 6,
  border: `1px solid ${T.border}`,
  background: T.bg,
  color: T.text,
  fontSize: 12,
};

const sectionStyle = {
  marginTop: 12,
  paddingTop: 10,
  borderTop: `1px solid ${T.border}`,
};

const FONT_OPTIONS = [
  ['system-ui', '系统默认'],
  ['Microsoft YaHei', '微软雅黑'],
  ['SimHei', '黑体'],
  ['serif', '衬线'],
  ['monospace', '等宽'],
];
const WEIGHT_OPTIONS = [
  [400, '常规'],
  [600, '半粗'],
  [700, '粗'],
  [900, '特粗'],
];
const ALIGN_OPTIONS = [
  ['left', '左'],
  ['center', '中'],
  ['right', '右'],
];

const DEFAULT_BEZIER = [0.42, 0, 0.58, 1];
const EASE_OPTIONS = [
  ['linear', '线性'],
  ['easeIn', '缓入'],
  ['easeOut', '缓出'],
  ['easeInOut', '缓入出'],
  ['custom', '自定义'],
];
const PROP_LABEL = { scale: '缩放', opacity: '透明度', x: '水平', y: '垂直', rotation: '旋转' };

/**
 * 文字样式区：字段白名单在 domain.mergeTextStyle 里，这里只负责把改动送成
 * clip.set_property {property:'style', value:{…}} —— 校验失败会由命令引擎
 * 抛出中文原因，面板只显示，不自己判。
 */
function TextStyleSection({ clip, onOps }) {
  const style = normalizeTextStyle(clip.style || {});
  const [strokeOn, setStrokeOn] = React.useState(!!style.stroke);
  const [shadowOn, setShadowOn] = React.useState(!!style.shadow);
  const stroke = style.stroke || { color: '#000000', width: 2 };
  const shadow = style.shadow || { color: '#000000', blur: 8, x: 0, y: 2 };
  const patch = (value, label) =>
    onOps([{ type: 'clip.set_property', clipId: clip.id, property: 'style', value }], label || '改文字样式');

  return h(
    'div',
    { style: sectionStyle },
    h(
      'div',
      { style: { fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 } },
      '文字样式',
      h('span', { style: { fontSize: 10, opacity: 0.45, fontWeight: 400 } }, '白名单字体 · 12..200 号'),
    ),
    h(
      Field,
      { label: '字体' },
      h(
        'select',
        {
          value: style.fontFamily,
          style: { ...numStyle, width: 120 },
          onChange: (e) => patch({ fontFamily: e.target.value }, '改字体'),
        },
        FONT_OPTIONS.map(([v, label]) => h('option', { key: v, value: v }, label)),
      ),
    ),
    h(
      Field,
      { label: '字号' },
      h('input', {
        type: 'range',
        min: 12,
        max: 200,
        step: 1,
        value: style.fontSize,
        style: { flex: 1 },
        onChange: (e) => patch({ fontSize: +e.target.value }, '改字号'),
      }),
      h('span', { style: { width: 34, textAlign: 'right', opacity: 0.6, fontSize: 11 } }, String(style.fontSize)),
    ),
    h(
      Field,
      { label: '粗细' },
      h(
        'select',
        {
          value: String(style.fontWeight),
          style: { ...numStyle, width: 90 },
          onChange: (e) => patch({ fontWeight: Number(e.target.value) }, '改粗细'),
        },
        WEIGHT_OPTIONS.map(([v, label]) => h('option', { key: v, value: String(v) }, label)),
      ),
    ),
    h(
      Field,
      { label: '颜色' },
      h('input', {
        type: 'color',
        value: style.color,
        onChange: (e) => patch({ color: e.target.value }, '改颜色'),
      }),
    ),
    h(
      Field,
      { label: '对齐' },
      h(
        'select',
        {
          value: style.align,
          style: { ...numStyle, width: 70 },
          onChange: (e) => patch({ align: e.target.value }, '改对齐'),
        },
        ALIGN_OPTIONS.map(([v, label]) => h('option', { key: v, value: v }, label)),
      ),
    ),
    h(
      Field,
      { label: '行高' },
      h('input', {
        type: 'range',
        min: 1,
        max: 3,
        step: 0.05,
        value: style.lineHeight,
        style: { flex: 1 },
        onChange: (e) => patch({ lineHeight: +e.target.value }, '改行高'),
      }),
      h('span', { style: { width: 34, textAlign: 'right', opacity: 0.6, fontSize: 11 } }, String(style.lineHeight)),
    ),
    h(
      Field,
      { label: '描边' },
      h('input', {
        type: 'checkbox',
        checked: strokeOn,
        onChange: (e) => {
          const on = e.target.checked;
          setStrokeOn(on);
          patch({ stroke: on ? stroke : null }, on ? '开描边' : '关描边');
        },
      }),
    ),
    strokeOn
      ? h(
          Field,
          { label: '描边色' },
          h('input', {
            type: 'color',
            value: stroke.color,
            onChange: (e) => patch({ stroke: { ...stroke, color: e.target.value } }, '改描边色'),
          }),
        )
      : null,
    strokeOn
      ? h(
          Field,
          { label: '描边宽' },
          h('input', {
            type: 'range',
            min: 0,
            max: 20,
            step: 0.5,
            value: stroke.width,
            style: { flex: 1 },
            onChange: (e) => patch({ stroke: { ...stroke, width: +e.target.value } }, '改描边宽'),
          }),
          h('span', { style: { width: 34, textAlign: 'right', opacity: 0.6, fontSize: 11 } }, String(stroke.width)),
        )
      : null,
    h(
      Field,
      { label: '阴影' },
      h('input', {
        type: 'checkbox',
        checked: shadowOn,
        onChange: (e) => {
          const on = e.target.checked;
          setShadowOn(on);
          patch({ shadow: on ? shadow : null }, on ? '开阴影' : '关阴影');
        },
      }),
    ),
    shadowOn
      ? h(
          Field,
          { label: '阴影模糊' },
          h('input', {
            type: 'range',
            min: 0,
            max: 50,
            step: 1,
            value: shadow.blur,
            style: { flex: 1 },
            onChange: (e) => patch({ shadow: { ...shadow, blur: +e.target.value } }, '改阴影模糊'),
          }),
          h('span', { style: { width: 34, textAlign: 'right', opacity: 0.6, fontSize: 11 } }, String(shadow.blur)),
        )
      : null,
  );
}

/**
 * 一个关键帧一行曲线编辑器。
 * 下拉里选预设 → 送 ease；选「自定义」→ 送 bezier（四个 0..1 分量）。
 * 两种都是同一条 clip.set_keyframe（同属性同时间会覆盖），不另开后门。
 */
function KeyframeCurveRow({ clip, k, onOps }) {
  const bezier = Array.isArray(k.bezier) && k.bezier.length === 4 ? k.bezier : DEFAULT_BEZIER;
  const [custom, setCustom] = React.useState(!!k.bezier);
  const [vals, setVals] = React.useState(bezier.map(String));
  const [err, setErr] = React.useState('');
  const name = PROP_LABEL[k.property] || k.property;

  const commit = (extra, label) =>
    onOps(
      [
        {
          type: 'clip.set_keyframe',
          clipId: clip.id,
          property: k.property,
          t: k.t,
          value: k.value,
          ...(k.ease && !extra.bezier ? { ease: k.ease } : {}),
          ...extra,
        },
      ],
      label,
    );

  const onKind = (v) => {
    if (v === 'custom') {
      const nums = vals.map(Number);
      if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
        setErr('四个分量必须是 0..1 的数字');
        return;
      }
      setErr('');
      setCustom(true);
      commit({ bezier: nums }, '改关键帧曲线');
      return;
    }
    setCustom(false);
    setErr('');
    onOps(
      [
        {
          type: 'clip.set_keyframe',
          clipId: clip.id,
          property: k.property,
          t: k.t,
          value: k.value,
          ease: v,
        },
      ],
      '改关键帧曲线',
    );
  };

  const onNum = (i, raw) => {
    const next = vals.slice();
    next[i] = raw;
    setVals(next);
    const nums = next.map(Number);
    if (next.some((s) => String(s).trim() === '') || nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
      setErr('四个分量必须是 0..1 的数字');
      return;
    }
    setErr('');
    commit({ bezier: nums }, '改关键帧曲线');
  };

  return h(
    'div',
    { style: { padding: '6px 0', borderTop: `1px dashed ${T.borderFaint}` } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } },
      h('span', { style: { flex: 1, fontSize: 11, opacity: 0.75 } }, `${name} · ${fmtTime(k.t)}`),
      h(
        'select',
        {
          value: custom ? 'custom' : k.ease || 'linear',
          style: { ...numStyle, width: 84, padding: '2px 4px', fontSize: 11 },
          onChange: (e) => onKind(e.target.value),
        },
        EASE_OPTIONS.map(([v, label]) => h('option', { key: v, value: v }, label)),
      ),
    ),
    custom
      ? h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 4 } },
          ['x1', 'y1', 'x2', 'y2'].map((label, i) =>
            h(
              'label',
              { key: label, style: { display: 'flex', alignItems: 'center', gap: 2, fontSize: 10, opacity: 0.6 } },
              label,
              h('input', {
                type: 'number',
                min: 0,
                max: 1,
                step: 0.01,
                value: vals[i],
                style: { ...numStyle, width: 52, padding: '2px 4px', fontSize: 11 },
                onChange: (e) => onNum(i, e.target.value),
              }),
            ),
          ),
        )
      : null,
    err ? h('div', { style: { fontSize: 10, color: T.warn, marginTop: 2 } }, err) : null,
  );
}

/**
 * 右侧「标注」页：解决「标完不知道标了什么、也删不掉」。
 *
 * - 按时间排序列出全部标注：时间码 / intent 徽标 / 文案 / 状态 / 创建者；
 * - 每条都能跳转、编辑文案、标记已处理、删除（删除用行内二次确认，不用 window.confirm）；
 * - 顶部计数「共 N 条 / 未处理 M 条」，缺 range 的脏数据进「无法定位」分组，不阻塞其它行；
 * - 选中态与时间线双向同步：点行 → 时间线跳过去；时间线点胶囊 → 这里滚动到该行。
 */
export function AnnotationsPanel(props) {
  const { annotations, selection, playhead, duration, onSelect, onJump, onPatch, onDelete } = props || {};
  const list = Array.isArray(annotations) ? annotations : [];
  const selectedId = selection && selection.kind === 'annotation' ? selection.id : null;
  const layout = annotationTrackLayout(list, { duration, zoom: 40, playhead, selectedId });
  const counts = layout.counts;

  const [editingId, setEditingId] = React.useState(null);
  const [draft, setDraft] = React.useState('');
  const [confirmId, setConfirmId] = React.useState(null);
  const rowRefs = React.useRef(new Map());

  // 时间线选中某条 → 列表滚到它。块内滚动，不带着整页跳。
  React.useEffect(() => {
    if (!selectedId) return;
    const el = rowRefs.current.get(selectedId);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const startEdit = (annotation) => {
    setEditingId(annotation.id);
    setDraft(String(annotation.expected == null ? '' : annotation.expected));
    setConfirmId(null);
  };

  const smallBtn = (label, onClick, tone) =>
    h(
      'button',
      {
        key: label,
        type: 'button',
        onClick: (e) => {
          e.stopPropagation();
          onClick();
        },
        style: Object.assign({}, btnStyle, {
          padding: '1px 6px',
          fontSize: 10,
          color: tone === 'danger' ? T.danger : tone === 'accent' ? T.accent : T.textDim,
        }),
      },
      label,
    );

  function renderRow(item, unplaced) {
    const a = item.annotation || { id: item.id };
    const id = item.id;
    const color = unplaced ? T.warn : annotationIntentColor(a.intent);
    const editing = editingId === id;
    const open = (a.status || 'open') === 'open';
    const text = String(a.expected == null ? '' : a.expected).trim();
    const rangeText = unplaced
      ? '—'
      : Math.abs(Number(a.range.end) - Number(a.range.start)) < 1e-9
        ? `${fmtTime(Number(a.range.start))}（当前帧）`
        : `${fmtTime(Number(a.range.start))} → ${fmtTime(Number(a.range.end))}`;
    return h(
      'div',
      {
        key: id,
        ref: (el) => {
          if (el) rowRefs.current.set(id, el);
          else rowRefs.current.delete(id);
        },
        onClick: () => {
          if (!unplaced && typeof onJump === 'function') onJump(a);
        },
        title: unplaced ? item.reasonText || '缺少 range' : annotationSummary(a) + ' · 点击跳到这一处',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: '7px 8px',
          borderBottom: `1px solid ${T.borderFaint}`,
          background: selectedId === id ? T.fillStrong : 'transparent',
          outline: selectedId === id ? `1px solid ${T.accent}` : 'none',
          outlineOffset: -1,
          cursor: unplaced ? 'default' : 'pointer',
        },
      },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
        h(
          'span',
          { style: { fontFamily: 'ui-monospace, monospace', fontSize: 10, color: T.textDim } },
          rangeText,
        ),
        h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color } },
          h('i', { style: { width: 6, height: 6, borderRadius: 3, background: color } }),
          INTENT_LABELS[a.intent] || a.intent || '要改',
        ),
        h(
          'span',
          {
            style: {
              fontSize: 10,
              color: open ? T.textDim : T.ok,
              border: `1px solid ${T.border}`,
              borderRadius: 4,
              padding: '0 4px',
            },
          },
          annotationStatusLabel(a.status),
        ),
        a.author
          ? h('span', { style: { fontSize: 10, color: T.textFaint } }, a.author === 'agent' ? 'Agent' : '你')
          : null,
        unplaced
          ? h('span', { style: { fontSize: 10, color: T.warn, fontFamily: 'ui-monospace, monospace' } }, id)
          : null,
      ),
      editing
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('textarea', {
              value: draft,
              rows: 2,
              onClick: (e) => e.stopPropagation(),
              onChange: (e) => setDraft(e.target.value),
              style: Object.assign({}, numStyle, { width: '100%', resize: 'vertical' }),
            }),
            h(
              'div',
              { style: { display: 'flex', gap: 4 } },
              smallBtn(
                '保存',
                () => {
                  setEditingId(null);
                  if (typeof onPatch === 'function') onPatch(a, { expected: draft });
                },
                'accent',
              ),
              smallBtn('取消', () => setEditingId(null)),
            ),
          )
        : h(
            'div',
            { style: { fontSize: 11, color: text ? T.text : T.textFaint, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
            text || '（无文字）',
          ),
      item.inverted
        ? h('div', { style: { fontSize: 10, color: T.danger } }, '区间倒挂（start > end）；可一键修成点标注')
        : null,
      item.truncated
        ? h('div', { style: { fontSize: 10, color: T.warn } }, '超出片长，时间线上已贴边（虚线）')
        : null,
      unplaced ? h('div', { style: { fontSize: 10, color: T.warn } }, item.reasonText || '缺少 range') : null,
      h(
        'div',
        { style: { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' } },
        unplaced ? null : smallBtn('跳转', () => typeof onJump === 'function' && onJump(a)),
        editing ? null : smallBtn('编辑', () => startEdit(a), 'accent'),
        smallBtn(open ? '标记已处理' : '重新打开', () => {
          if (typeof onPatch === 'function') onPatch(a, { status: open ? 'applied' : 'open' });
        }),
        item.inverted
          ? smallBtn('修成点标注', () => {
              if (typeof onPatch === 'function') onPatch(a, { range: { start: a.range.start, end: a.range.start } });
            })
          : null,
        confirmId === id
          ? h(
              'span',
              { style: { display: 'inline-flex', gap: 4, alignItems: 'center' } },
              h('span', { style: { fontSize: 10, color: T.danger } }, '确定删除？'),
              smallBtn(
                '删除',
                () => {
                  setConfirmId(null);
                  if (typeof onDelete === 'function') onDelete(a);
                },
                'danger',
              ),
              smallBtn('取消', () => setConfirmId(null)),
            )
          : smallBtn('删除', () => setConfirmId(id), 'danger'),
      ),
    );
  }

  const body = [
    h(
      'div',
      {
        key: 'head',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          padding: '8px 10px',
          borderBottom: `1px solid ${T.border}`,
        },
      },
      h('span', { style: { fontWeight: 600, fontSize: 12 } }, '标注'),
      h('span', { style: { fontSize: 10, color: T.textDim } }, `共 ${counts.total} 条 / 未处理 ${counts.open} 条`),
      counts.unplaced
        ? h('span', { style: { fontSize: 10, color: T.warn } }, `· 无法定位 ${counts.unplaced}`)
        : null,
    ),
  ];

  if (!list.length) {
    body.push(
      h(
        'div',
        { key: 'empty', style: { padding: '18px 12px', fontSize: 11, color: T.textFaint, lineHeight: 1.8 } },
        '还没有标注，播放时点 + 标注 添加。',
      ),
    );
  } else {
    layout.items.forEach((item) => body.push(renderRow(item, false)));
    if (layout.unplaced.length) {
      body.push(
        h(
          'div',
          {
            key: 'unplaced-head',
            style: { padding: '8px 10px 4px', fontSize: 10, color: T.warn, borderTop: `1px solid ${T.border}` },
          },
          '无法定位（缺 range，不影响其它标注渲染）',
        ),
      );
      layout.unplaced.forEach((item) => body.push(renderRow(item, true)));
    }
  }

  return h('div', { style: { paddingBottom: 12, fontSize: 12 } }, body);
}

function InspectorBody({ doc, selection, clips, annotations, playhead, onOps, onDelete, onSplit, onExport, onAnnotationUpdate, onAnnotationDelete, onDeleteProject, exportSettings, onExportSettings, analysis }) {
  const easeRef = React.useRef('linear');
  const clip = selection && selection.kind === 'clip' ? clips.find((c) => c.id === selection.id) : null;
  const annot = selection && selection.kind === 'annotation' ? annotations.find((a) => a.id === selection.id) : null;
  // 属性页里也可能直接选中一条标注：删除同样要二次确认（内联，不用 window.confirm）
  const [confirmAnnotDelete, setConfirmAnnotDelete] = React.useState(false);
  React.useEffect(() => {
    setConfirmAnnotDelete(false);
  }, [annot && annot.id]);
  // 音量 / 淡入淡出 / 静音只对音频轨上的片段有意义；视频轨上的 clip.volume 会被命令层拒绝，
  // 所以这里也不要把输入框画出来（面板不该给出一个注定报错的入口）。
  const clipTrack = clip && doc ? (doc.tracks || []).find((t) => t.id === clip.trackId) : null;
  const isAudioClip = !!(clipTrack && clipTrack.kind === 'audio');

  if (annot) {
    return h(
      'div',
      { style: { padding: 12, fontSize: 12 } },
      h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '标注'),
      // 人类可读：「第 7 镜 · 12.40s（镜内 +0.30s）」；没解析过就只给秒
      h(Field, { label: '位置' }, formatAnnotation(enrichAnnotation(annot.range, analysis))),
      h(Field, { label: '类型' }, `${annot.intent || 'change'}（${INTENT_LABELS[annot.intent] || '改'}）`),
      h(
        Field,
        { label: '说明' },
        h('textarea', {
          defaultValue: annot.expected,
          rows: 3,
          style: { ...numStyle, width: '100%', resize: 'vertical' },
          onBlur: (e) =>
            onAnnotationUpdate(annot, { type: 'annotation.update', annotationId: annot.id, expected: e.target.value }),
        }),
      ),
      h(Field, { label: '状态' }, annot.status),
      h(
        'button',
        {
          type: 'button',
          style: { ...btnStyle, marginTop: 8 },
          onClick: () => onAnnotationUpdate(annot, { type: 'annotation.update', annotationId: annot.id, status: annot.status === 'open' ? 'applied' : 'open' }),
        },
        annot.status === 'open' ? '标记为已处理' : '重新打开',
      ),
      confirmAnnotDelete
        ? h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 10, color: T.danger } }, '确定删除这条标注？'),
            h(
              'button',
              {
                type: 'button',
                style: Object.assign({}, btnStyle, { color: T.danger }),
                onClick: () => {
                  setConfirmAnnotDelete(false);
                  if (typeof onAnnotationDelete === 'function') onAnnotationDelete(annot);
                },
              },
              '删除',
            ),
            h(
              'button',
              { type: 'button', style: btnStyle, onClick: () => setConfirmAnnotDelete(false) },
              '取消',
            ),
          )
        : h(
            'button',
            {
              type: 'button',
              style: Object.assign({}, btnStyle, { marginTop: 8, marginLeft: 6, color: T.danger }),
              onClick: () => setConfirmAnnotDelete(true),
            },
            '删除标注',
          ),
    );
  }

  if (!clip) {
    return h(
      'div',
      { style: { padding: 12, fontSize: 12, lineHeight: 1.7 } },
      h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '工程'),
      doc ? h(Field, { label: '版本' }, 'r' + doc.revision) : null,
      doc ? h(Field, { label: '时长' }, doc.duration.toFixed(2) + 's') : null,
      doc ? h(Field, { label: '画幅' }, doc.ratio) : null,
      doc && exportSettings
        ? h(
            Field,
            { label: '导出' },
            h(
              'select',
              {
                value: exportSettings.width + 'x' + exportSettings.height,
                onChange: (e) => {
                  const [w, hh] = e.target.value.split('x').map(Number);
                  onExportSettings({ width: w, height: hh });
                },
                style: { ...numStyle, width: 110 },
              },
              [['1280x720', '720p'], ['1920x1080', '1080p'], ['2560x1440', '1440p'], ['3840x2160', '4K']].map(([v, label]) =>
                h('option', { key: v, value: v }, label),
              ),
            ),
          )
        : null,
      doc && exportSettings
        ? h(
            Field,
            { label: '帧率' },
            h(
              'select',
              {
                value: String(exportSettings.fps),
                onChange: (e) => onExportSettings({ fps: Number(e.target.value) }),
                style: { ...numStyle, width: 80 },
              },
              [24, 25, 30, 50, 60].map((f) => h('option', { key: f, value: String(f) }, f + ' fps')),
            ),
          )
        : null,
      h('div', { style: { height: 12 } }),
      h('button', { type: 'button', style: { ...btnStyle, width: '100%', padding: '6px 8px' }, onClick: onExport }, '导出 MP4'),
      h('div', { style: { height: 8 } }),
      h(
        'button',
        { type: 'button', style: { ...btnStyle, width: '100%', padding: '6px 8px', color: T.danger }, onClick: onDeleteProject },
        '删除工程',
      ),
      h('div', { style: { opacity: 0.5, marginTop: 8, fontSize: 11 } }, '点时间线上的片段来编辑；拖两端裁剪，拖中间移动。'),
    );
  }

  const update = (property, value) => onOps([{ type: 'clip.trim', clipId: clip.id, [property]: value }], '修改片段');
  const updateProp = (property, value) => onOps([{ type: 'clip.set_property', clipId: clip.id, property, value }], '修改属性');

  return h(
    'div',
    { style: { padding: 12, fontSize: 12, overflow: 'auto' } },
    h('div', { style: { fontWeight: 600, marginBottom: 8, display: 'flex', gap: 6 } },
      h('span', null, '片段'),
      chip(clip.type),
    ),
    h('div', { style: { opacity: 0.55, fontSize: 11, marginBottom: 10, fontFamily: 'ui-monospace, monospace' } }, clip.id),
    h(Field, { label: '开始' }, h('input', { type: 'number', step: 0.01, value: clip.start, style: numStyle, onChange: (e) => update('start', +e.target.value) })),
    h(Field, { label: '时长' }, h('input', { type: 'number', step: 0.01, value: clip.duration, style: numStyle, onChange: (e) => update('duration', +e.target.value) })),
    clip.type === 'media'
      ? h(Field, { label: '源入点' }, h('input', { type: 'number', step: 0.01, value: clip.sourceIn || 0, style: numStyle, onChange: (e) => update('sourceIn', +e.target.value) }))
      : null,
    clip.type === 'media'
      ? h(Field, { label: '不透明度' }, h('input', { type: 'number', step: 0.05, min: 0, max: 1, value: (clip.transform && clip.transform.opacity) || 1, style: numStyle, onChange: (e) => onOps([{ type: 'clip.set_transform', clipId: clip.id, transform: { opacity: +e.target.value } }], '修改不透明度') }))
      : null,
    isAudioClip
      ? h(Field, { label: '音量(0–2)' }, h('input', { type: 'number', step: 0.1, min: 0, max: 2, value: clip.volume == null ? 1 : clip.volume, style: numStyle, onChange: (e) => updateProp('volume', +e.target.value) }))
      : null,
    clip.type === 'text'
      ? h(
          'div',
          { style: { marginTop: 6 } },
          h(Field, { label: '文字' }, h('input', {
            type: 'text',
            defaultValue: clip.text || '',
            style: { ...numStyle, width: '100%' },
            onBlur: (e) => onOps([{ type: 'clip.set_text', clipId: clip.id, text: e.target.value }], '修改文字'),
          })),
          h(TextStyleSection, { key: clip.id, clip, onOps }),
          h(Field, { label: '位置' }, h('input', {
            type: 'range', min: 0.1, max: 0.95, step: 0.01,
            value: clip.style && clip.style.y != null ? clip.style.y : 0.82,
            style: { flex: 1 },
            onChange: (e) => onOps([{ type: 'clip.set_property', clipId: clip.id, property: 'style', value: { y: +e.target.value } }], '改位置'),
          })),
          h(
            'button',
            {
              type: 'button',
              style: { ...btnStyle, marginTop: 4 },
              onClick: () => {
                // 只搬白名单字段：normalize 会滤掉 skeleton 之类的内部标记。
                const style = normalizeTextStyle(clip.style || {});
                const ops = (clips || [])
                  .filter((c) => c.type === 'text' && c.id !== clip.id)
                  .map((c) => ({ type: 'clip.set_property', clipId: c.id, property: 'style', value: style }));
                if (!ops.length) return;
                onOps(ops, '统一样式（' + ops.length + ' 条字幕）');
              },
            },
            '把当前样式应用到所有字幕',
          ),
        )
      : null,
    h('div', { style: { height: 10 } }),
    h('button', { type: 'button', style: { ...btnStyle, marginRight: 6 }, onClick: () => onSplit(clip) }, '在播放头分割'),
    h('button', { type: 'button', style: { ...btnStyle, color: T.danger }, onClick: () => onDelete(clip) }, '删除'),
    h(
      'button',
      {
        type: 'button',
        style: { ...btnStyle, marginLeft: 6 },
        title: '首尾各 0.3 秒淡入淡出',
        onClick: () =>
          onOps([{ type: 'clip.set_transition', clipId: clip.id, transitionIn: 0.3, transitionOut: 0.3 }], '添加淡入淡出'),
      },
      '淡入淡出',
    ),
    h(
      'button',
      {
        type: 'button',
        style: { ...btnStyle, marginLeft: 6 },
        onClick: () =>
          onOps([{ type: 'clip.set_transition', clipId: clip.id, transitionIn: null, transitionOut: null }], '清除转场'),
      },
      '清除转场',
    ),
    isAudioClip
      ? h(
          'div',
          { style: { marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}` } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '音频'),
          h(Field, { label: '静音' }, h('input', {
            type: 'checkbox',
            checked: clip.muted === true,
            onChange: (e) => updateProp('muted', e.target.checked),
          })),
          h(Field, { label: '淡入(秒)' }, h('input', {
            type: 'number', step: 0.1, min: 0, max: Math.max(0, clip.duration - (clip.fadeOut || 0)),
            defaultValue: clip.fadeIn || '',
            style: numStyle,
            onBlur: (e) => {
              // 面板只负责给出放得下的值；工具调用侧仍然严格校验（越界报错，不夹紧）
              const v = Math.max(0, Math.min(clip.duration - (clip.fadeOut || 0), Number(e.target.value) || 0));
              onOps([{ type: 'clip.set_property', clipId: clip.id, property: 'fadeIn', value: v }], '改淡入');
            },
          })),
          h(Field, { label: '淡出(秒)' }, h('input', {
            type: 'number', step: 0.1, min: 0, max: Math.max(0, clip.duration - (clip.fadeIn || 0)),
            defaultValue: clip.fadeOut || '',
            style: numStyle,
            onBlur: (e) => {
              const v = Math.max(0, Math.min(clip.duration - (clip.fadeIn || 0), Number(e.target.value) || 0));
              onOps([{ type: 'clip.set_property', clipId: clip.id, property: 'fadeOut', value: v }], '改淡出');
            },
          })),
        )
      : null,

    clip.type === 'media'
      ? h(
          'div',
          { style: { marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}` } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '蒙版'),
          h(
            Field,
            { label: '形状' },
            h(
              'select',
              {
                value: clip.mask ? clip.mask.shape : 'none',
                style: { ...numStyle, width: 100 },
                onChange: (e) => {
                  const shape = e.target.value;
                  if (shape === 'none') {
                    onOps([{ type: 'clip.set_mask', clipId: clip.id, mask: { shape: 'none' } }], '清除蒙版');
                  } else {
                    onOps([{ type: 'clip.set_mask', clipId: clip.id, mask: { shape, x: 0.5, y: 0.5, w: 0.6, h: 0.6 } }], '设置蒙版');
                  }
                },
              },
              [['none', '无'], ['rect', '矩形'], ['circle', '圆形']].map(([v, l]) => h('option', { key: v, value: v }, l)),
            ),
          ),
          clip.mask && clip.mask.shape !== 'none'
            ? ['x', 'y', 'w', 'h'].map((k) =>
                h(
                  'div',
                  { key: k, style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
                  h('span', { style: { width: 48, opacity: 0.65 } }, { x: '水平', y: '垂直', w: '宽', h: '高' }[k]),
                  h('input', {
                    type: 'range', min: 0.05, max: 1, step: 0.01,
                    value: clip.mask[k],
                    style: { flex: 1 },
                    onChange: (e) =>
                      onOps([{ type: 'clip.set_mask', clipId: clip.id, mask: Object.assign({}, clip.mask, { [k]: +e.target.value }) }], '调整蒙版'),
                  }),
                ),
              )
            : null,
        )
      : null,
    clip.type === 'media' || clip.type === 'code'
      ? h(
          'div',
          { style: { marginTop: 14, paddingTop: 10, borderTop: `1px solid ${T.border}` } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '效果'),
          ['brightness', 'contrast', 'saturate', 'temperature', 'tint', 'vignette', 'blur'].map((type) => {
            const range = { blur: [0, 20, 0.5], vignette: [0, 1, 0.05], temperature: [-1, 1, 0.05], tint: [-1, 1, 0.05] }[type] || [0.2, 2, 0.05];
            const fallback = { blur: 0, vignette: 0, temperature: 0, tint: 0 }[type] ?? 1;
            const val = effectValue(clip, type, fallback);
            return h(
              'div',
              { key: type, style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
              h('span', { style: { width: 48, opacity: 0.65 } }, EFFECT_LABEL[type]),
              h('input', {
                type: 'range',
                min: range[0],
                max: range[1],
                step: range[2],
                value: val,
                onChange: (e) =>
                  onOps(
                    [{ type: 'clip.set_effect', clipId: clip.id, effect: type, value: +e.target.value }],
                    '调整效果',
                  ),
                style: { flex: 1 },
              }),
              h('span', { style: { width: 34, textAlign: 'right', opacity: 0.6, fontSize: 11 } }, String(val)),
            );
          }),
        )
      : null,

    clip.type === 'media' || clip.type === 'text' || clip.type === 'code'
      ? h(
          'div',
          { style: { marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}` } },
          h(
            'div',
            { style: { fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 } },
            '动画',
            h('span', { style: { fontSize: 10, opacity: 0.55, fontWeight: 400 } }, '在播放头打点（' + keyframeCount(clip) + ' 个关键帧）'),
          ),
          ['scale', 'opacity'].map((prop) =>
            h(
              'div',
              { key: prop, style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
              h('span', { style: { width: 42, opacity: 0.65 } }, prop === 'scale' ? '缩放' : '透明度'),
              h('input', {
                type: 'range',
                min: prop === 'scale' ? 0.1 : 0,
                max: prop === 'scale' ? 3 : 1,
                step: 0.01,
                value: keyframeValue(clip, prop),
                onChange: (e) =>
                  onOps(
                    [
                      {
                        type: 'clip.set_keyframe',
                        clipId: clip.id,
                        property: prop,
                        t: Math.max(0, Math.min(clip.duration, +(playhead - clip.start).toFixed(3))),
                        value: +e.target.value,
                        ease: easeRef.current,
                      },
                    ],
                    '打关键帧',
                  ),
                style: { flex: 1 },
              }),
              h('span', { style: { width: 34, textAlign: 'right', opacity: 0.6, fontSize: 11 } }, String(keyframeValue(clip, prop))),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
            h('span', { style: { width: 42, opacity: 0.65 } }, '缓动'),
            h(
              'select',
              {
                defaultValue: 'linear',
                onChange: (e) => {
                  easeRef.current = e.target.value;
                },
                style: { ...numStyle, width: 110 },
              },
              [
                ['linear', '线性'],
                ['easeIn', '缓入'],
                ['easeOut', '缓出'],
                ['easeInOut', '缓入缓出'],
              ].map(([v, label]) => h('option', { key: v, value: v }, label)),
            ),
            h('span', { style: { fontSize: 10, opacity: 0.45 } }, '作用于之后打的关键帧'),
          ),
          h(
            'div',
            { style: { marginTop: 4 } },
            h('div', { style: { opacity: 0.6, fontSize: 11, marginBottom: 2 } }, '每帧曲线'),
            (clip.keyframes || []).length
              ? (clip.keyframes || [])
                  .slice()
                  .sort((a, b) =>
                    a.property === b.property ? a.t - b.t : String(a.property).localeCompare(String(b.property)),
                  )
                  .map((k) =>
                    h(KeyframeCurveRow, {
                      key: k.property + ':' + k.t + ':' + (k.bezier ? k.bezier.join(',') : k.ease || 'linear'),
                      clip,
                      k,
                      onOps,
                    }),
                  )
              : h(
                  'div',
                  { style: { opacity: 0.4, fontSize: 10, padding: '2px 0 6px' } },
                  '还没有关键帧：先拖上面的滑条打一帧，再回来改它的曲线',
                ),
          ),
          h(
            'button',
            {
              type: 'button',
              style: btnStyle,
              onClick: () => onOps([{ type: 'clip.remove_keyframe', clipId: clip.id }], '清除关键帧'),
            },
            '清除关键帧',
          ),
        )
      : null,

    clip.type === 'code'
      ? h(
          'div',
          { style: { marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '图层参数（agent 可改，人也可改）'),
          h('textarea', {
            key: clip.id + ':' + JSON.stringify(clip.props || {}),
            defaultValue: JSON.stringify(clip.props || {}, null, 2),
            rows: 5,
            spellCheck: false,
            style: { ...numStyle, width: '100%', resize: 'vertical', fontFamily: 'ui-monospace, monospace' },
            onBlur: (e) => {
              try {
                const props = JSON.parse(e.target.value || '{}');
                onOps([{ type: 'code_layer.set_props', clipId: clip.id, props }], '修改图层参数');
              } catch {
                /* 非法 JSON 不提交，保持原值 */
              }
            },
          }),
        )
      : null,

    clip.type === 'media' && clip.provenance
      ? h(
          'div',
          { style: { marginTop: 14, paddingTop: 10, borderTop: `1px solid ${T.border}`, fontSize: 11, opacity: 0.75, lineHeight: 1.6 } },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '来源'),
          h('div', null, `库：${clip.provenance.libraryId || 'local'}`),
          h('div', null, `素材：${clip.provenance.assetId || clip.assetId || ''}`),
          clip.provenance.hash ? h('div', { style: { fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' } }, clip.provenance.hash) : null,
        )
      : null,
  );
}

/**
 * 分镜面板：挂在右侧检查器下面的一块折叠区。
 *
 * 读的是工程里真正保存着的那一份 storyboard.json（storyboard.read），
 * 不是某次工具调用的返回值 —— 所以关掉工作台、换一个会话再打开，看到的还是它。
 *
 * 折叠范式与音效库一致；镜头列表固定高度内部滚动，不随镜头数把整页撑高。
 * defaultOpen 只给渲染测试用（SSR 不跑 effect，点不动按钮）。
 */
export function StoryboardPanel({ projectId, sessionId, defaultOpen }) {
  const [open, setOpen] = React.useState(!!defaultOpen);
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState('');
  const [note, setNote] = React.useState('');

  const load = React.useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const value = await rpc('storyboard.read', { projectId, sessionId });
      setData(value);
      setNote((value && value.warning) || '');
    } catch (e) {
      reportError(e, '读取分镜失败');
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);

  React.useEffect(() => {
    if (open) load();
  }, [open, load]);

  /** 重新拆分：读当前字幕轨，生成并写回 storyboard.json（会覆盖旧文件、清空旧 clipId） */
  async function resplit() {
    if (busy) return;
    setBusy('save');
    try {
      const value = await rpc('storyboard.save', { projectId, sessionId });
      await refresh();
      await load();
      toast('已重新拆分：' + value.count + ' 镜');
    } catch (e) {
      reportError(e, '重新拆分失败');
    } finally {
      setBusy('');
    }
  }

  /** 应用到时间线：一次事务；工程里已有片段会被拒，提示先清空 */
  async function apply() {
    if (busy) return;
    setBusy('apply');
    try {
      const value = await rpc('storyboard.apply', {
        projectId,
        sessionId,
        baseRevision: state.doc ? state.doc.revision : undefined,
      });
      await refresh();
      await load();
      toast('已落地 ' + value.count + ' 镜到时间线');
    } catch (e) {
      reportError(e, '应用到时间线失败');
    } finally {
      setBusy('');
    }
  }

  const shots = (data && data.doc && data.doc.shots) || [];
  const line = (text) => h('div', { style: { fontSize: 11, opacity: 0.55, lineHeight: 1.6 } }, text);

  return h(
    'div',
    { style: { borderTop: `1px solid ${T.border}`, padding: '8px 10px' } },
    h(
      'div',
      {
        style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
        onClick: () => setOpen((v) => !v),
      },
      h('strong', { style: { fontSize: 12, flex: 1 } }, '分镜' + (open && data ? '（' + shots.length + '）' : '')),
      h('span', { style: { fontSize: 10, opacity: 0.45 } }, open && note ? '有提示' : ''),
      h('span', { style: { fontSize: 11, opacity: 0.5 } }, open ? '收起' : '展开'),
    ),
    open
      ? h(
          'div',
          { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
          loading
            ? line('读取分镜中…')
            : !data
              ? line('展开后读取工程里的 storyboard.json')
              : !shots.length
                ? line('还没有分镜：点下面「重新拆分（读当前字幕）」从工程字幕生成一份')
                : h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        maxHeight: 200,
                        overflowY: 'auto',
                        overscrollBehavior: 'contain',
                      },
                    },
                    shots.map((shot) =>
                      h(
                        'div',
                        {
                          key: shot.index + ':' + shot.start,
                          style: {
                            padding: '4px 6px',
                            borderRadius: 4,
                            background: T.fill,
                            border: `1px solid ${T.borderFaint}`,
                          },
                        },
                        h(
                          'div',
                          { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 } },
                          h('span', { style: { opacity: 0.55 } }, '#' + shot.index),
                          h('span', { style: { fontFamily: 'ui-monospace, monospace', opacity: 0.75 } }, fmtTime(shot.start)),
                          h('span', { style: { opacity: 0.35 } }, '→'),
                          h('span', { style: { fontFamily: 'ui-monospace, monospace', opacity: 0.75 } }, fmtTime(shot.end)),
                          shot.suggestedEffect && shot.suggestedEffect !== 'none' ? chip(shot.suggestedEffect) : null,
                          shot.clipId ? h('span', { style: { marginLeft: 'auto', fontSize: 10, opacity: 0.35 } }, '已落地') : null,
                        ),
                        h(
                          'div',
                          {
                            title: shot.text,
                            style: {
                              fontSize: 11,
                              opacity: 0.8,
                              marginTop: 2,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            },
                          },
                          shot.text,
                        ),
                      ),
                    ),
                  ),
          note ? h('div', { style: { fontSize: 10, color: T.warn, lineHeight: 1.5 } }, note) : null,
          h(
            'div',
            { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            h(
              'button',
              {
                type: 'button',
                disabled: !!busy,
                title: '读当前工程的字幕轨，重新切分并写回 storyboard.json',
                onClick: resplit,
                style: { ...btnStyle, opacity: busy ? 0.5 : 1 },
              },
              busy === 'save' ? '拆分中…' : '重新拆分（读当前字幕）',
            ),
            h(
              'button',
              {
                type: 'button',
                disabled: !!busy,
                title: '按分镜铺时间线（一次事务）；工程里已有片段时会拒绝',
                onClick: apply,
                style: { ...btnStyle, opacity: busy ? 0.5 : 1 },
              },
              busy === 'apply' ? '落地中…' : '应用到时间线',
            ),
          ),
        )
      : null,
  );
}

function isTranscribable(asset) {
  const mime = String((asset && asset.mime) || '');
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return true;
  return /\.(mp4|mov|mkv|webm|avi|m4v|mp3|wav|m4a|flac|ogg)$/i.test(String((asset && asset.path) || ''));
}

/**
 * 语音转字幕：检查器里的一块折叠区。
 *
 * 只依赖两条宿主能力：asr.status（探路）和 asr.transcribe + asr.progress（后台任务）。
 * 依赖不全时把 reasons 原样列出来 —— 那是用户唯一能照着修的东西，不能吞。
 * 进度走全局 state.busy，主界面的进度浮层也就能看见同一份进度。
 */
export function AsrPanel({ projectId, sessionId, defaultOpen }) {
  // 默认展开：新功能要一眼看得见（分镜是先把工程打开才用得上，所以那边默认收起）
  const [open, setOpen] = React.useState(defaultOpen == null ? true : !!defaultOpen);
  const [deps, setDeps] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [note, setNote] = React.useState('');
  const [reasons, setReasons] = React.useState([]);
  const alive = React.useRef(true);
  const timer = React.useRef(null);

  React.useEffect(
    () => () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      if (state.busy && state.busy.kind === 'asr') setState({ busy: null });
    },
    [],
  );

  // 展开时探一次依赖：缺什么当场摆出来，不用等用户点按钮才看见
  React.useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const value = await rpc('asr.status', {});
        if (!cancelled) setDeps(value);
      } catch (e) {
        if (!cancelled) setReasons([(e && e.message) || '依赖检测失败']);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  /** 选中的片段对应的素材优先；否则退到工程里第一个视频/音频素材 */
  function pickAsset() {
    const selected =
      state.selection && state.selection.kind === 'clip'
        ? (state.clips || []).find((c) => c.id === state.selection.id)
        : null;
    const assets = state.assets || [];
    const fromSelection = selected && selected.assetId ? assets.find((a) => a.id === selected.assetId) : null;
    if (fromSelection) return fromSelection;
    return assets.find(isTranscribable) || null;
  }

  function finish() {
    setBusy(null);
    if (state.busy && state.busy.kind === 'asr') setState({ busy: null });
  }

  function poll(jobId) {
    return new Promise((resolve) => {
      const tick = async () => {
        if (!alive.current) return resolve();
        let value;
        try {
          value = await rpc('asr.progress', { jobId });
        } catch (e) {
          finish();
          reportError(e, '读取转写进度失败');
          return resolve();
        }
        const ratio = typeof value.ratio === 'number' ? value.ratio : 0;
        const label = value.label || (value.status === 'running' ? '转写中…' : '处理中…');
        setBusy({ label, ratio });
        setState({ busy: { label, ratio, kind: 'asr' } });
        if (value.status === 'running') {
          timer.current = setTimeout(tick, 800);
          return resolve();
        }
        finish();
        if (value.error) {
          setReasons([value.error.message || '转写失败']);
          toast(value.error.message || '转写失败', 'warn');
          return resolve();
        }
        const result = value.result || {};
        if (!result.ready) {
          // 原样显示：每一条都写着缺什么、装到哪
          setReasons(Array.isArray(result.reasons) ? result.reasons : ['依赖缺失']);
          toast('缺少语音转字幕依赖，看面板里的原因', 'warn');
          return resolve();
        }
        const count = (result.segments || []).length;
        setNote(`已生成 ${count} 条字幕` + (result.applied ? `，写入字幕轨 ${result.applied.count} 条` : ''));
        if (result.warnings && result.warnings.length) setReasons(result.warnings);
        refresh().catch(() => {});
        toast('已生成字幕：' + count + ' 条');
        return resolve();
      };
      tick();
    });
  }

  async function start() {
    if (busy) return;
    const asset = pickAsset();
    if (!asset) {
      toast('工程里还没有可转写的视频/音频素材', 'warn');
      return;
    }
    setReasons([]);
    setNote('');
    const first = { label: '准备转写…', ratio: 0 };
    setBusy(first);
    setState({ busy: { ...first, kind: 'asr' } });
    try {
      const job = await rpc('asr.transcribe', {
        projectId,
        sessionId,
        assetId: asset.id,
        modelSize: 'medium',
        language: 'zh',
        applyToTimeline: true,
      });
      await poll(job.jobId);
    } catch (e) {
      finish();
      reportError(e, '启动语音转字幕失败');
    }
  }

  const line = (text, tone) =>
    h('div', { style: { fontSize: 11, lineHeight: 1.6, opacity: 0.6, color: tone === 'warn' ? T.warn : undefined } }, text);
  const shownReasons = reasons.length ? reasons : deps && !deps.ready ? deps.reasons || [] : [];
  const ready = deps ? deps.ready === true : null;
  const backend = deps && deps.whisper ? deps.whisper.backend : null;
  const stateLine = ready == null ? '展开后检测依赖' : ready ? `依赖就绪 · ${backend === 'cuda' ? 'GPU（CUDA）' : 'CPU'}` : '依赖缺失';

  return h(
    'div',
    { style: { borderTop: `1px solid ${T.border}`, padding: '8px 10px' } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }, onClick: () => setOpen((v) => !v) },
      h('strong', { style: { fontSize: 12, flex: 1 } }, '语音转字幕' + (ready === false ? '（未就绪）' : '')),
      h('span', { style: { fontSize: 10, opacity: 0.45 } }, open ? stateLine : ''),
      h('span', { style: { fontSize: 11, opacity: 0.5 } }, open ? '收起' : '展开'),
    ),
    open
      ? h(
          'div',
          { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
          h(
            'button',
            {
              type: 'button',
              disabled: !!busy,
              title: '抽音轨 → faster-whisper（small）→ 直接写入字幕轨；一次事务，可撤销',
              onClick: start,
              style: { ...btnStyle, alignSelf: 'flex-start', opacity: busy ? 0.5 : 1 },
            },
            busy ? `${busy.label} ${Math.round((busy.ratio || 0) * 100)}%` : '生成字幕',
          ),
          deps && deps.ready === false ? null : line('用当前选中片段对应的素材；没有选中就用工程里第一个视频素材。'),
          note ? h('div', { style: { fontSize: 11, color: T.ok } }, note) : null,
          shownReasons.length
            ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    fontSize: 11,
                    color: T.warn,
                    lineHeight: 1.55,
                    whiteSpace: 'pre-wrap',
                  },
                },
                shownReasons.map((text, index) => h('div', { key: index }, String(text))),
              )
            : null,
          deps && deps.warnings && deps.warnings.length && !shownReasons.length
            ? line(deps.warnings.join('；'), 'warn')
            : null,
        )
      : null,
  );
}

/**
 * 文字转语音（配音）：检查器里的折叠区。
 *
 * 三条 UI 约定：
 *   - 不弹 window.prompt：文本、音色、语速全在面板里编辑；
 *   - 文本默认取选中的文字片段，可改；改完只影响这一次合成，不回写片段；
 *   - 生成成功后 a1 已由 Host 铺好，这里只负责把「几秒、几条字幕」说清楚。
 */
export function TtsPanel({ projectId, sessionId, defaultOpen }) {
  const [open, setOpen] = React.useState(defaultOpen == null ? true : !!defaultOpen);
  const [deps, setDeps] = React.useState(null);
  const [voices, setVoices] = React.useState([]);
  const [voice, setVoice] = React.useState('');
  const [rate, setRate] = React.useState(0);
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState('');
  const [reasons, setReasons] = React.useState([]);
  const sourceRef = React.useRef(null);

  const selectedTextClip = React.useMemo(() => {
    const sel = state.selection;
    if (!sel || sel.kind !== 'clip') return null;
    const clip = (state.clips || []).find((c) => c.id === sel.id);
    return clip && clip.type === 'text' ? clip : null;
  }, [state.selection, state.clips]);

  // 展开时探一次依赖：缺什么当场摆出来，不用等用户点按钮才看见
  React.useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const value = await rpc('tts.probe', {});
        if (!cancelled) {
          setDeps(value);
          if (value && Array.isArray(value.voices) && value.voices.length) setVoices(value.voices);
        }
      } catch (e) {
        if (!cancelled) setReasons([(e && e.message) || '配音依赖检测失败']);
      }
      try {
        const value = await rpc('tts.voices', {});
        if (!cancelled && value && Array.isArray(value.voices) && value.voices.length) setVoices(value.voices);
      } catch {
        /* 列表失败时沿用 probe 里的 voices */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  React.useEffect(() => {
    if (!voice && voices.length) setVoice(voices[0].id);
  }, [voices, voice]);

  // 选中的文字片段变了才覆盖输入框：用户正在改的文字不能被自己的 setState 打断
  React.useEffect(() => {
    const clip = selectedTextClip;
    if (!clip) return;
    const key = clip.id + '\u0000' + String(clip.text || '');
    if (sourceRef.current === key) return;
    sourceRef.current = key;
    setText(String(clip.text || ''));
  }, [selectedTextClip]);

  const chars = Array.from(String(text || '')).length;
  const shownReasons = reasons.length ? reasons : deps && !deps.ready ? deps.reasons || [] : [];
  const ready = deps ? deps.ready === true : null;
  const stateLine = ready == null ? '展开后检测依赖' : ready ? `就绪 · ${deps.provider}` : '依赖缺失';

  async function generate() {
    if (busy) return;
    const value = String(text || '').trim();
    if (!value) {
      toast('先输入要配音的文字（或选中一条文字片段）', 'warn');
      return;
    }
    if (chars > 2000) {
      toast(`文本太长：${chars} 字，上限 2000 字`, 'warn');
      return;
    }
    setBusy(true);
    setReasons([]);
    setNote('');
    setState({ busy: { label: '合成配音…', ratio: 0.45, kind: 'tts' } });
    try {
      const res = await ttsSpeak(value, { voice, rate, start: state.playhead });
      const seconds = ((res && res.durationMs ? res.durationMs : 0) / 1000).toFixed(1);
      const count = res && res.subtitles ? res.subtitles.count : 0;
      setNote(`已插入 a1：${seconds} 秒 · 字幕 ${count} 条${res && res.shifted ? '（播放头有片段，已自动后移）' : ''}`);
      toast(`配音 ${seconds} 秒，已插入 a1`, 'info');
    } catch (e) {
      setReasons([(e && e.message) || '配音失败']);
      reportError(e, '生成配音失败');
    } finally {
      setBusy(false);
      if (state.busy && state.busy.kind === 'tts') setState({ busy: null });
    }
  }

  const line = (value, tone) =>
    h(
      'div',
      {
        style: {
          fontSize: 11,
          lineHeight: 1.6,
          opacity: 0.6,
          color: tone === 'warn' ? T.warn : undefined,
        },
      },
      value,
    );

  return h(
    'div',
    { style: { borderTop: `1px solid ${T.border}`, padding: '8px 10px' } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }, onClick: () => setOpen((v) => !v) },
      h('strong', { style: { fontSize: 12, flex: 1 } }, '生成配音' + (ready === false ? '（未就绪）' : '')),
      h('span', { style: { fontSize: 10, opacity: 0.45 } }, open ? stateLine : ''),
      h('span', { style: { fontSize: 11, opacity: 0.5 } }, open ? '收起' : '展开'),
    ),
    open
      ? h(
          'div',
          { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
          h('textarea', {
            value: text,
            rows: 4,
            maxLength: 2000,
            placeholder: '要配音的文字；选中一条文字片段会自动带进来。',
            onChange: (e) => setText(e.target.value),
            style: {
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              font: 'inherit',
              fontSize: 12,
              lineHeight: 1.5,
              padding: '5px 7px',
              borderRadius: 6,
              color: T.text,
              background: T.fill,
              border: `1px solid ${T.border}`,
            },
          }),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, opacity: 0.6 } },
            h('span', {}, `配音文本 ${chars}/2000 字`),
            selectedTextClip ? h('span', {}, '· 来自选中片段') : h('span', {}, '· 直接输入'),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h(
              'select',
              {
                value: voice,
                disabled: !voices.length,
                onChange: (e) => setVoice(e.target.value),
                style: {
                  flex: 1,
                  minWidth: 0,
                  font: 'inherit',
                  fontSize: 11,
                  padding: '3px 6px',
                  borderRadius: 6,
                  color: T.text,
                  background: T.fill,
                  border: `1px solid ${T.border}`,
                },
              },
              voices.length
                ? voices.map((v) =>
                    h(
                      'option',
                      { key: v.id, value: v.id },
                      `${v.name} · ${v.gender === 'male' ? '男' : '女'} · ${v.style || v.locale || ''}`,
                    ),
                  )
                : h('option', { value: '' }, '音色列表未加载'),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, opacity: 0.75 } },
            h('span', { style: { width: 34 } }, '语速'),
            h('input', {
              type: 'range',
              min: -20,
              max: 20,
              step: 5,
              value: rate,
              onChange: (e) => setRate(Number(e.target.value) || 0),
              style: { flex: 1, minWidth: 0 },
            }),
            h('span', { style: { width: 40, textAlign: 'right' } }, `${rate > 0 ? '+' : ''}${rate}%`),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h(
              'button',
              {
                type: 'button',
                disabled: ready === false || busy || !chars,
                title: '合成后自动插入 a1，并在 t1 生成对齐字幕；一次事务，可撤销',
                onClick: generate,
                style: { ...btnStyle, opacity: ready === false || busy || !chars ? 0.5 : 1 },
              },
              busy ? '合成中…' : '生成配音',
            ),
            h('span', { style: { fontSize: 10, opacity: 0.45 } }, '起点 = 播放头'),
          ),
          ready === true ? line('用当前选中的文字片段作为默认文本；生成后自动插入 a1 并生成字幕。') : null,
          note ? h('div', { style: { fontSize: 11, color: T.ok } }, note) : null,
          shownReasons.length
            ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    fontSize: 11,
                    color: T.warn,
                    lineHeight: 1.55,
                    whiteSpace: 'pre-wrap',
                  },
                },
                shownReasons.map((value, index) => h('div', { key: index }, String(value))),
              )
            : null,
        )
      : null,
  );
}

/**
 * 风格确认（S1）：一份 spec → 4 张关键帧 + 8 秒样片，全程不接任何外部模型。
 *
 * 数据流（看清楚谁干什么）：
 *   1. style.preview  → Host 在 <工程>/.dsh-video/style-preview/ 铺好 4 个镜头的预览工程，
 *      同时回 alignment（对齐检查结果）与 click（节拍参数）
 *   2. 本组件用 drawStyleFrame 在本地 canvas 上画 4 张关键帧，PNG 传到 style-upload 落盘
 *   3. 同一份 drawStyleFrame 交给 exportTimeline 逐帧编码 8 秒样片（720p / 30fps），
 *      并把 buildClickTrack 生成的节拍轨当 audioBuffer 一起混进去（视频轨不变）；
 *      混不进去时退化为单独上传 preview-8s-click.wav + 「播放节拍」按钮
 *   4. style.result → 拿到 4 个 PNG 与样片的工程内相对路径，交给 <img> / <video>
 *
 * 面板上能改的只有四件事：主色、字体、动效密度、节奏。改完点「生成样片」，
 * 四张图和视频一起换 —— 因为画它们的是同一个函数。改「节奏」会同时改变 BPM，
 * 让「这一版节奏到底顺不顺」从耳朵里也能判断。
 */
export function StylePanel({ projectId, sessionId, defaultOpen }) {
  const [open, setOpen] = React.useState(defaultOpen == null ? true : !!defaultOpen);
  const [spec, setSpec] = React.useState(null);
  const [summary, setSummary] = React.useState('');
  const [reasons, setReasons] = React.useState([]);
  const [warnings, setWarnings] = React.useState([]);
  const [busy, setBusy] = React.useState(null);
  const [note, setNote] = React.useState('');
  const [frames, setFrames] = React.useState([]);
  const [video, setVideo] = React.useState(null);
  const [previewInfo, setPreviewInfo] = React.useState(null);
  // 节拍：click 是「这一版会怎么响」的参数，clickFallback 是混不进样片时单独那条 WAV
  const [clickSpec, setClickSpec] = React.useState(null);
  const [clickFallback, setClickFallback] = React.useState(null);
  // 对齐检查里被点中的那一镜（用来高亮对应关键帧）
  const [highlight, setHighlight] = React.useState(null);
  const stampRef = React.useRef(0);
  const videoRef = React.useRef(null);
  const audioRef = React.useRef(null);

  // 打开就取默认 spec；顺手看看预览目录里有没有上一轮画好的东西
  React.useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const value = await rpc('style.default', {});
        if (cancelled) return;
        setSpec(value.spec);
        setSummary(value.summary || specToSummary(value.spec));
      } catch (e) {
        if (!cancelled) setReasons([(e && e.message) || '读取默认风格失败']);
        return;
      }
      try {
        const existing = await rpc('style.result', { projectId, sessionId });
        if (cancelled || !existing) return;
        applyArtifacts(existing, 'last');
        setSummary(existing.summary || summary);
      } catch {
        /* 还没生成过样片：正常情况，不提示 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, sessionId]);

  function applyArtifacts(value, stamp) {
    const token = String(stamp);
    stampRef.current = token;
    setFrames(
      (value.frameDetails || []).map((frame) => ({
        index: frame.index,
        kind: frame.kind,
        label: frame.label || SHOT_LABELS[frame.kind] || frame.kind,
        bytes: frame.bytes,
        relPath: frame.relPath,
        url: styleFileUrl(frame.relPath, token),
      })),
    );
    setVideo(
      value.video
        ? { relPath: value.video.relPath, bytes: value.video.bytes, url: styleFileUrl(value.video.relPath, token) }
        : null,
    );
    setClickSpec(value.click || null);
    setClickFallback(
      value.clickPath
        ? { relPath: value.clickPath, url: styleFileUrl(value.clickPath, token) }
        : null,
    );
  }

  /**
   * 单独上传节拍 WAV（兜底路径）。
   *
   * 为什么不走 bridge.uploadStyleAsset：那个函数只认 frame / video 两种 kind，
   * 而它的白名单在另一个文件里（不在这次能改的范围）。这里直接打同一个接口，
   * 参数与它保持一致，鉴权走同一套同源 cookie。
   */
  async function uploadClickTrack(bytes) {
    const params = new URLSearchParams({
      projectId: String(projectId || ''),
      sessionId: String(sessionId || ''),
      kind: 'click',
    });
    const res = await fetch('/api/video/style-upload?' + params.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload || !payload.ok) {
      throw new Error((payload && payload.error && payload.error.message) || '节拍音轨上传失败');
    }
    return payload.value;
  }

  function patchSpec(mutate) {
    const base = spec || {};
    const next = JSON.parse(JSON.stringify(base));
    mutate(next);
    setSpec(next);
    const checked = validateStyleSpec(next);
    setReasons(checked.ok ? [] : checked.reasons);
    setWarnings(checked.warnings || []);
    setSummary(specToSummary(next));
  }

  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('画布无法导出 PNG'))), 'image/png');
        return;
      }
      try {
        const base64 = String(canvas.toDataURL('image/png')).split(',')[1] || '';
        const bin = typeof atob === 'function' ? atob(base64) : '';
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        resolve(new Blob([bytes], { type: 'image/png' }));
      } catch (e) {
        reject(e);
      }
    });
  }

  async function renderKeyframe(shot, specValue, shots) {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('当前环境无法创建 2D 画布');
    // 关键帧取这一镜 72% 处：进入动效已经走完，看到的是「这一镜真正要给人看的样子」
    drawStyleFrame(ctx, { width: canvas.width, height: canvas.height, spec: specValue, shots, t: shot.keyframeAt });
    return canvasToPngBlob(canvas);
  }

  async function exportSample(specValue, shots, duration, bpm, onProgress) {
    const { probeEncoders, chooseExportPlan } = await import('./codec-caps.mjs');
    const caps = await probeEncoders();
    const plan = chooseExportPlan(caps);
    const mod = await import('./exporter.js');
    const width = 1280;
    const height = 720;
    const fps = 30;
    // 节拍轨直接当 audioBuffer 喂给导出端：视频轨一个字不改（同一份 drawFrame、
    // 同一个 fps），只是多了一条 AAC/Opus 音轨。音轨编码失败时导出端会降级并回 audioWarning，
    // 不会把视频导坏 —— 那时再走「单独存 WAV + 播放节拍」的兜底。
    const track = buildClickTrack(shots, { bpm });
    const result = await mod.exportTimeline({
      title: 'style-preview',
      duration,
      projectFps: fps,
      fps,
      width,
      height,
      plan,
      range: { start: 0, end: duration },
      audioBuffer: track,
      drawFrame: (ctx, t, w, h) =>
        drawStyleFrame(ctx, { width: w, height: h, spec: specValue, shots, t }),
      onProgress,
    });
    return {
      blob: result.blob,
      container: result.container || 'mp4',
      audioBytes: result.audioBytes || 0,
      audioCodec: result.audioCodec || null,
      audioWarning: result.audioWarning || '',
      track,
    };
  }

  async function generate() {
    if (busy) return;
    const checked = validateStyleSpec(spec || {});
    setReasons(checked.ok ? [] : checked.reasons);
    setWarnings(checked.warnings || []);
    if (!checked.ok) {
      toast(`风格有 ${checked.reasons.length} 处问题，见面板下方`, 'warn');
      return;
    }
    setBusy({ label: '准备预览工程', ratio: 0.05 });
    setState({ busy: { label: '风格样片 · 准备', ratio: 0.05, kind: 'style' } });
    setNote('');
    setHighlight(null);
    let mp4Error = '';
    let audioError = '';
    let audioMuxed = false;
    let audioFallbackOk = false;
    try {
      const value = await rpc('style.preview', { projectId, sessionId, spec: checked.spec });
      const shots = value.shots || [];
      setPreviewInfo(value.preview || null);
      setClickSpec(value.click || null);
      // 节拍速度跟「你设的节奏」走（requestedShotSeconds），不是样片归一化后的 2 秒：
      // 改「节奏」下拉框，耳朵里要立刻听得出差别，否则这个维度等于没验。
      const bpm = (value.click && value.click.bpm) || bpmFromRhythm(value.requestedShotSeconds).bpm;
      const stamp = Date.now();
      stampRef.current = String(stamp);

      for (let i = 0; i < shots.length; i += 1) {
        const shot = shots[i];
        const ratio = 0.08 + (i / Math.max(1, shots.length)) * 0.22;
        setBusy({ label: `渲染关键帧 ${i + 1}/${shots.length}`, ratio });
        setState({ busy: { label: `风格样片 · 关键帧 ${i + 1}/${shots.length}`, ratio, kind: 'style' } });
        const blob = await renderKeyframe(shot, value.spec, shots);
        await uploadStyleAsset(blob, { kind: 'frame', index: shot.index, shotKind: shot.kind });
      }

      setBusy({ label: '合成 8 秒样片', ratio: 0.35 });
      try {
        const exported = await exportSample(value.spec, shots, value.duration, bpm, (p) => {
          const ratio = 0.35 + Math.max(0, Math.min(1, Number(p.ratio) || 0)) * 0.6;
          setBusy({ label: `样片 · ${p.phase || '编码'}`, ratio });
          setState({ busy: { label: '风格样片 · 编码', ratio, kind: 'style' } });
        });
        await uploadStyleAsset(exported.blob, { kind: 'video', container: exported.container });
        audioMuxed = (exported.audioBytes || 0) > 0;
        if (!audioMuxed) {
          // 音轨混不进样片时不能静默丢掉：单独存一条 WAV，面板上给「播放节拍」
          try {
            await uploadClickTrack(clickTrackToWav(exported.track));
            audioFallbackOk = true;
          } catch (e) {
            audioError = (e && e.message) || '节拍音轨上传失败';
          }
        }
      } catch (e) {
        mp4Error = (e && e.message) || '样片导出失败';
      }

      const result = await rpc('style.result', { projectId, sessionId });
      applyArtifacts(result, stamp);
      setSummary(result.summary || summary);
      const framesOk = (result.frameDetails || []).length;
      let text;
      if (mp4Error) {
        text = `4 张关键帧已生成（${framesOk}/4），8 秒样片没导出来：${mp4Error}`;
      } else if (audioMuxed) {
        text = `已生成 ${framesOk} 张关键帧与 8 秒样片（720p · 30fps，音轨含节拍 ${bpm} BPM）`;
      } else if (audioFallbackOk) {
        text = `已生成 ${framesOk} 张关键帧与 8 秒样片（720p · 30fps）；这台机器混不进音轨，节拍单独存成 WAV —— 用「播放节拍」和样片同时播`;
      } else {
        text = `已生成 ${framesOk} 张关键帧与 8 秒样片（720p · 30fps）；节拍既没混进去也没存下来：${audioError || '原因未知'}`;
      }
      setNote(text);
      toast(mp4Error ? '关键帧已生成，样片导出失败' : '风格样片已生成', mp4Error ? 'warn' : 'info');
    } catch (e) {
      reportError(e, '生成风格样片失败');
    } finally {
      setBusy(null);
      if (state.busy && state.busy.kind === 'style') setState({ busy: null });
    }
  }

  /** 点「播放节拍」：让样片与独立音轨都回到 0 再一起播（不追求帧级同步）。 */
  function playClickTogether() {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (video) {
      try {
        video.currentTime = 0;
        const played = video.play();
        if (played && played.catch) played.catch(() => {});
      } catch {
        /* 浏览器不给播就交给原生控件 */
      }
    }
    if (audio) {
      try {
        audio.currentTime = 0;
        const played = audio.play();
        if (played && played.catch) played.catch(() => {});
      } catch {
        /* 同上 */
      }
    }
  }

  const row = (label, control) =>
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 } },
      h('span', { style: { width: 52, flex: '0 0 auto', opacity: 0.6 } }, label),
      control,
    );

  const selectStyle = {
    flex: 1,
    minWidth: 0,
    font: 'inherit',
    fontSize: 11,
    padding: '3px 6px',
    borderRadius: 6,
    color: T.text,
    background: T.fill,
    border: `1px solid ${T.border}`,
  };

  const palette = (spec && spec.palette) || { accent: '#4FD1C5' };
  const density = (spec && spec.motionDensity) || 'med';
  const rhythm = (spec && spec.rhythm) || { shotSeconds: 2 };
  const family = (spec && spec.font && spec.font.family) || FONT_CHOICES[0].family;

  // 对齐检查：spec 一变就重算。纯函数、不碰 DOM，所以「面板上写的」和
  // 「style.json 里存的」都是同一段代码算出来的。
  const alignment = React.useMemo(() => {
    if (!spec) return null;
    const checkedNow = validateStyleSpec(spec);
    if (!checkedNow.ok) return null;
    try {
      return alignmentForSpec(checkedNow.spec);
    } catch {
      return null;
    }
  }, [spec]);

  const bpmInfo = bpmFromRhythm(rhythm.shotSeconds);
  const beatsPerShot = Math.round(((Number(rhythm.shotSeconds) || 2) * bpmInfo.bpm) / 60 * 10) / 10;
  const highlightKind = highlight || null;

  return h(
    'div',
    { style: { borderTop: `1px solid ${T.border}`, padding: '8px 10px' } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }, onClick: () => setOpen((v) => !v) },
      h('strong', { style: { fontSize: 12, flex: 1 } }, '风格确认 · 样片'),
      h('span', { style: { fontSize: 10, opacity: 0.45 } }, open ? `${PREVIEW_SECONDS} 秒 · 4 镜` : ''),
      h('span', { style: { fontSize: 11, opacity: 0.5 } }, open ? '收起' : '展开'),
    ),
    open
      ? h(
          'div',
          { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
          h(
            'div',
            {
              style: {
                fontSize: 11,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                padding: '6px 8px',
                borderRadius: 6,
                background: T.fill,
                border: `1px solid ${T.border}`,
                opacity: 0.85,
              },
            },
            summary || '正在读取默认风格…',
          ),
          row(
            '主色',
            h('input', {
              type: 'color',
              value: String(palette.accent || '#4FD1C5'),
              onChange: (e) => patchSpec((next) => {
                next.palette = next.palette || {};
                next.palette.accent = String(e.target.value || '').toUpperCase();
              }),
              style: { width: 40, height: 22, padding: 0, border: 'none', background: 'transparent' },
            }),
          ),
          row(
            '字体',
            h(
              'select',
              {
                value: family,
                onChange: (e) => patchSpec((next) => {
                  next.font = next.font || {};
                  next.font.family = e.target.value;
                }),
                style: selectStyle,
              },
              FONT_CHOICES.map((choice) => h('option', { key: choice.id, value: choice.family }, choice.label)),
            ),
          ),
          row(
            '密度',
            h(
              'select',
              {
                value: density,
                onChange: (e) => patchSpec((next) => {
                  next.motionDensity = e.target.value;
                }),
                style: selectStyle,
              },
              DENSITIES.map((id) =>
                h('option', { key: id, value: id }, `${DENSITY_LABELS[id]}（${id}）`),
              ),
            ),
          ),
          row(
            '节奏',
            h(
              'select',
              {
                value: String(rhythm.shotSeconds),
                onChange: (e) => patchSpec((next) => {
                  next.rhythm = next.rhythm || {};
                  next.rhythm.shotSeconds = Number(e.target.value);
                }),
                style: selectStyle,
              },
              [1, 1.5, 2, 2.5, 3].map((seconds) => h('option', { key: seconds, value: String(seconds) }, `${seconds} 秒/镜`)),
            ),
          ),
          row(
            '节拍',
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 } },
              h(
                'span',
                { style: { fontSize: 11 } },
                `${bpmInfo.bpm} BPM · 每镜 ${beatsPerShot} 拍`,
              ),
              h(
                'span',
                { style: { fontSize: 10, opacity: 0.45, lineHeight: 1.4 } },
                '节拍仅用于确认节奏，不进入成片。',
              ),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h(
              'button',
              {
                type: 'button',
                disabled: !!busy || !spec,
                title: '在临时预览工程里铺 4 个镜头，画 4 张关键帧并导出 8 秒样片',
                onClick: generate,
                style: { ...btnStyle, opacity: busy || !spec ? 0.5 : 1 },
              },
              busy ? busy.label : '生成样片',
            ),
            h(
              'span',
              { style: { fontSize: 10, opacity: 0.45, flex: 1 } },
              `样片固定 ${PREVIEW_SECONDS} 秒（4×2s）+ 720p/30fps；节奏只影响正式时间线`,
            ),
          ),
          busy
            ? h(
                'div',
                { style: { height: 3, borderRadius: 2, background: T.fillStrong, overflow: 'hidden' } },
                h('div', {
                  style: {
                    height: '100%',
                    width: `${Math.round((busy.ratio || 0) * 100)}%`,
                    background: T.accent,
                    transition: 'width .2s linear',
                  },
                }),
              )
            : null,
          frames.length
            ? h(
                'div',
                { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 } },
                frames.map((frame) => {
                  const on = highlightKind === frame.kind;
                  return h(
                    'div',
                    { key: frame.relPath, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                    h('img', {
                      src: frame.url,
                      alt: frame.label,
                      onClick: () => setHighlight(on ? null : frame.kind),
                      style: {
                        width: '100%',
                        display: 'block',
                        borderRadius: 6,
                        cursor: 'pointer',
                        border: '1px solid ' + (on ? T.warn : T.border),
                        outline: on ? `2px solid ${T.warn}` : 'none',
                        background: '#000',
                      },
                    }),
                    h(
                      'span',
                      { style: { fontSize: 10, opacity: on ? 0.95 : 0.5 } },
                      on ? frame.label + ' ← 对齐检查命中' : frame.label,
                    ),
                  );
                }),
              )
            : null,
          alignment
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2 } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 } },
                  h('span', { style: { fontWeight: 600 } }, '对齐检查'),
                  h(
                    'span',
                    {
                      style: {
                        fontSize: 10,
                        color: alignment.ok && alignment.issues.length === 0 ? T.ok : T.warn,
                      },
                    },
                    alignment.ok && alignment.issues.length === 0
                      ? `${alignment.summary.total} 项通过`
                      : `${alignment.summary.failed}/${alignment.summary.total} 项有问题 · ${alignment.issues.length} 条`,
                  ),
                  h('span', { style: { flex: 1 } }),
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => setHighlight(null),
                      style: { ...btnStyle, padding: '1px 6px', fontSize: 10, opacity: highlightKind ? 1 : 0.4 },
                    },
                    '取消高亮',
                  ),
                ),
                alignment.issues.length
                  ? h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                      alignment.issues.map((issue, index) =>
                        h(
                          'button',
                          {
                            key: issue.code + '-' + index,
                            type: 'button',
                            title: issue.shotKind ? '点一下高亮对应关键帧' : '这是全局问题（与具体镜头无关）',
                            onClick: () => {
                              if (issue.shotKind) setHighlight(highlightKind === issue.shotKind ? null : issue.shotKind);
                            },
                            style: {
                              textAlign: 'left',
                              font: 'inherit',
                              fontSize: 10,
                              lineHeight: 1.5,
                              padding: '3px 6px',
                              borderRadius: 5,
                              cursor: issue.shotKind ? 'pointer' : 'default',
                              color: issue.severity === 'error' ? T.danger : T.warn,
                              background:
                                issue.shotKind && highlightKind === issue.shotKind
                                  ? T.fillStrong
                                  : T.fill,
                              border:
                                '1px solid ' +
                                (issue.shotKind && highlightKind === issue.shotKind
                                  ? T.borderStrong
                                  : T.border),
                            },
                          },
                          (issue.severity === 'error' ? '✕ ' : '! ') + issue.message,
                        ),
                      ),
                    )
                  : null,
              )
            : null,
          video
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                h('video', {
                  ref: videoRef,
                  src: video.url,
                  controls: true,
                  loop: true,
                  playsInline: true,
                  style: {
                    width: '100%',
                    display: 'block',
                    borderRadius: 6,
                    border: `1px solid ${T.border}`,
                    background: '#000',
                  },
                }),
                h(
                  'span',
                  { style: { fontSize: 10, opacity: 0.5 } },
                  `${PREVIEW_SECONDS} 秒样片 · ${Math.max(1, Math.round((video.bytes || 0) / 1024))} KB` +
                    (clickSpec ? ` · 节拍 ${clickSpec.bpm} BPM` : ''),
                ),
                h(
                  'span',
                  { style: { fontSize: 10, opacity: 0.45, lineHeight: 1.5 } },
                  clickSpec
                    ? `节拍仅用于确认节奏，不进入成片（${clickSpec.bpm} BPM · 强拍 ${clickSpec.strongHz}Hz / 弱拍 ${clickSpec.weakHz}Hz · 峰值 ${clickSpec.peakDbfs}dBFS）。`
                    : '节拍仅用于确认节奏，不进入成片。',
                ),
              )
            : null,
          clickFallback
            ? h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, opacity: 0.7 } },
                h(
                  'button',
                  { type: 'button', style: { ...btnStyle, padding: '2px 8px' }, onClick: playClickTogether },
                  '播放节拍',
                ),
                h('span', { style: { flex: 1, minWidth: 0 } }, '样片里没有音轨，节拍在独立的 WAV 里；点它两个一起从头播。'),
                h('audio', { ref: audioRef, src: clickFallback.url, preload: 'auto', style: { display: 'none' } }),
              )
            : null,
          previewInfo
            ? h(
                'div',
                { style: { fontSize: 10, opacity: 0.45, lineHeight: 1.5 } },
                `预览工程：${previewInfo.relDir} · ${previewInfo.clipCount} 个镜头 · ${previewInfo.duration} 秒`,
              )
            : null,
          note ? h('div', { style: { fontSize: 11, color: mp4Color(note) } }, note) : null,
          reasons.length
            ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    fontSize: 11,
                    color: T.danger,
                    lineHeight: 1.5,
                  },
                },
                reasons.map((text, index) => h('div', { key: index }, '· ' + text)),
              )
            : null,
          warnings.length
            ? h(
                'div',
                { style: { fontSize: 10, opacity: 0.5, lineHeight: 1.5 } },
                warnings.slice(0, 4).map((text, index) => h('div', { key: index }, text)),
              )
            : null,
        )
      : null,
  );
}

/** 样片生成结果那一行：失败是警告色，成功是正常色。 */
function mp4Color(text) {
  return /失败|没导出来/.test(String(text)) ? T.warn : T.ok;
}

// ------------------------------------------------------- 开工阶段（只读）----
//
// 检查器最上面那一块：把 dsh-video-brief 插件在 <工程根>/.dsh-video/ 维护的
// state.json / brief.json / style.json 画出来。
//
// 这块面板**故意没有写操作**：推进阶段、补 brief、确认风格都由 agent 调插件的
// 工具（video_stage_get / video_brief_confirm / video_style_confirm …）完成。
// 界面上能点的只有「收起 / 展开」和「看某一条已填的原文」。
//
// 数据源是 RPC brief.state（src/routes.mjs 里的只读投影）：展开时拉一次，
// 之后每 5 秒轮询；页面不可见时暂停，收起 / 卸载 / 换工程都清定时器。

/** 五段阶段，顺序即进度条方向。 */
const STAGE_ROWS = [
  { id: 'idle', label: '未开始' },
  { id: 'clarify', label: '补 brief' },
  { id: 'style', label: '定风格' },
  { id: 'locked', label: '锁风格' },
  { id: 'build', label: '生产' },
];

/** 轮询间隔：五秒够看见 agent 推进阶段，又不至于把 host 打热。 */
const STAGE_POLL_MS = 5000;

/** 预览图 / 样片只能走 /api/video/style-file，而它只服务预览目录下的文件。 */
const STYLE_PREVIEW_PREFIX = previewLayout().relDir + '/';

/** ISO → 「11-06 14:32」；解析不了就原样返回（不编时间）。 */
function stageStamp(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 某个阶段最近一次到达的时间（history 从旧到新，取最后一条）。 */
function stageReachedAt(history, stage) {
  let last = '';
  for (const entry of history || []) {
    if (entry && entry.stage === stage && entry.at) last = entry.at;
  }
  return last;
}

/** 面板里的一行小字。 */
function stageNote(text, tone) {
  return h(
    'div',
    {
      style: {
        fontSize: 10,
        lineHeight: 1.55,
        opacity: tone ? 1 : 0.55,
        color: tone === 'warn' ? T.warn : tone === 'danger' ? T.danger : undefined,
        wordBreak: 'break-word',
      },
    },
    text,
  );
}

export function StagePanel({ projectId, sessionId, defaultOpen }) {
  const [open, setOpen] = React.useState(defaultOpen == null ? true : !!defaultOpen);
  const [data, setData] = React.useState(null);
  const [failure, setFailure] = React.useState('');
  const [expanded, setExpanded] = React.useState(null);

  // 展开就拉一次，之后 5 秒一轮。页面不可见时停表，回来立刻补一次。
  React.useEffect(() => {
    if (!open || !projectId) return undefined;
    let cancelled = false;
    let timer = null;
    const hidden = () =>
      typeof document !== 'undefined' && document && document.visibilityState === 'hidden';
    const stop = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const schedule = () => {
      if (cancelled) return;
      stop();
      timer = setTimeout(pull, STAGE_POLL_MS);
    };
    async function pull() {
      if (cancelled || hidden()) return;
      try {
        const value = await rpc('brief.state', { projectId, sessionId });
        if (cancelled) return;
        setData(value || null);
        setFailure('');
      } catch (e) {
        if (cancelled) return;
        setFailure((e && e.message) || '读取开工阶段失败');
      }
      schedule();
    }
    function onVisibility() {
      if (hidden()) {
        stop();
        return;
      }
      stop();
      pull();
    }
    setData(null);
    setFailure('');
    setExpanded(null);
    pull();
    if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      cancelled = true;
      stop();
      if (typeof document !== 'undefined' && document && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [open, projectId, sessionId]);

  // 没开工程不渲染：这块面板的存在前提是「有一个工程根」。
  if (!projectId) return null;

  const snapshot = data && typeof data === 'object' ? data : {};
  const stage = typeof snapshot.stage === 'string' ? snapshot.stage : 'idle';
  const stageIndex = Math.max(0, STAGE_ROWS.findIndex((row) => row.id === stage));
  const slots = Array.isArray(snapshot.slots) ? snapshot.slots : [];
  const filledSlots = slots.filter((slot) => slot && slot.filled);
  const missingSlots = slots.filter((slot) => slot && !slot.filled);
  const history = Array.isArray(snapshot.history) ? snapshot.history : [];
  const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : [];
  const blocked = Array.isArray(snapshot.blocked) ? snapshot.blocked : [];
  const style = snapshot.style && typeof snapshot.style === 'object' ? snapshot.style : null;
  const stylePreview = style && style.preview && typeof style.preview === 'object' ? style.preview : {};
  const keyframes = Array.isArray(stylePreview.keyframes) ? stylePreview.keyframes : [];
  const clipPath = typeof stylePreview.clip === 'string' ? stylePreview.clip : '';
  const since = stageStamp(snapshot.since);
  const readyCount = slots.length > 0
    ? `${filledSlots.length}/${slots.length}`
    : snapshot.filled != null && snapshot.total != null
      ? `${snapshot.filled}/${snapshot.total}`
      : '';

  const header = h(
    'div',
    {
      style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
      onClick: () => setOpen((v) => !v),
    },
    h('strong', { style: { fontSize: 12, flex: 1 } }, '开工阶段'),
    readyCount ? chip(`brief ${readyCount}`) : null,
    snapshot.stageSource === 'inferred' ? chip('按事实推断', 'warn') : null,
    snapshot.consistency === 'state-ahead-of-facts' ? chip('状态领先事实', 'warn') : null,
    h('span', { style: { fontSize: 11, opacity: 0.5 } }, open ? '收起' : '展开'),
  );

  if (!open) {
    return h('div', { style: { borderTop: `1px solid ${T.border}`, padding: '8px 10px' } }, header);
  }

  // 读取失败只占一行，不白屏。
  if (!data && failure) {
    return h(
      'div',
      { style: { borderTop: `1px solid ${T.border}`, padding: '8px 10px' } },
      header,
      h('div', { style: { marginTop: 6 } }, stageNote('读取开工阶段失败：' + failure, 'danger')),
    );
  }

  if (!data) {
    return h(
      'div',
      { style: { borderTop: `1px solid ${T.border}`, padding: '8px 10px' } },
      header,
      h('div', { style: { marginTop: 6 } }, stageNote('读取中…')),
    );
  }

  const stageRow = STAGE_ROWS[stageIndex];

  return h(
    'div',
    { style: { borderTop: `1px solid ${T.border}`, padding: '8px 10px' } },
    header,

    // 五段进度条：已过 = 淡蓝，当前 = 亮蓝加高；悬停看每一段到达的时间。
    h(
      'div',
      { style: { marginTop: 8, display: 'flex', gap: 3, alignItems: 'flex-end' } },
      STAGE_ROWS.map((row, index) => {
        const reached = index <= stageIndex;
        const current = index === stageIndex;
        const at = stageReachedAt(history, row.id);
        return h('div', {
          key: row.id,
          title: `${row.label}（${row.id}）${at ? ' · ' + stageStamp(at) : ' · 还没到'}`,
          style: {
            flex: 1,
            height: current ? 8 : 5,
            borderRadius: 3,
            background: current ? T.accent : reached ? T.accentDim : T.fillStrong,
            transition: 'height .15s',
          },
        });
      }),
    ),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 10 } },
      h('span', { style: { color: T.accent } }, stageRow.label),
      h('span', { style: { opacity: 0.45 } }, stage),
      since ? h('span', { style: { opacity: 0.45 } }, '· 自 ' + since) : null,
      h('span', { style: { flex: 1 } }),
      h('span', { style: { opacity: 0.4 } }, '只读 · 写入找 agent'),
    ),

    // 10 个槽位小方格：亮 = 已填。
    slots.length
      ? h(
          'div',
          { style: { marginTop: 8, display: 'flex', gap: 3 } },
          slots.map((slot) =>
            h('div', {
              key: slot.id,
              title: `${slot.title} · ${slot.filled ? '已填' : '未填'}`,
              style: {
                flex: 1,
                height: 10,
                borderRadius: 2,
                background: slot.filled ? T.ok : 'transparent',
                border: slot.filled ? '1px solid transparent' : `1px dashed ${T.borderStrong}`,
                opacity: slot.filled ? 0.8 : 0.7,
              },
            }),
          ),
        )
      : null,

    missingSlots.length
      ? h(
          'div',
          { style: { marginTop: 6, fontSize: 10, lineHeight: 1.5, color: T.warn } },
          '还缺：' + missingSlots.map((slot) => slot.title).join('、'),
        )
      : h('div', { style: { marginTop: 6, fontSize: 10, color: T.ok } }, 'brief 10/10 已齐'),

    // 已填的槽位：点开看原文（缺的只列名字，没有原文可看）。
    filledSlots.length
      ? h(
          'div',
          { style: { marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 } },
          filledSlots.map((slot) =>
            h(
              'span',
              {
                key: slot.id,
                title: '点一下看原文',
                onClick: () => setExpanded((prev) => (prev === slot.id ? null : slot.id)),
                style: {
                  fontSize: 10,
                  padding: '1px 6px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  color: expanded === slot.id ? T.text : T.textDim,
                  background: expanded === slot.id ? T.fillStrong : T.fill,
                  border: `1px solid ${T.border}`,
                  whiteSpace: 'nowrap',
                },
              },
              slot.title,
            ),
          ),
        )
      : null,
    expanded && slots.some((slot) => slot.id === expanded && slot.filled)
      ? h(
          'div',
          {
            style: {
              marginTop: 5,
              padding: '5px 7px',
              fontSize: 11,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 140,
              overflowY: 'auto',
              color: T.textDim,
              background: T.fill,
              border: `1px solid ${T.borderFaint}`,
              borderRadius: 6,
            },
          },
          (slots.find((slot) => slot.id === expanded) || {}).value || '',
        )
      : null,

    // 风格：未确认就只说明下一步；确认了给 spec 摘要 + 四宫格关键帧 + 8 秒样片。
    h(
      'div',
      { style: { marginTop: 10, paddingTop: 8, borderTop: `1px solid ${T.borderFaint}` } },
      style
        ? h(
            'div',
            null,
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 10 } },
              h('span', { style: { color: T.ok } }, '风格已确认'),
              h('span', { style: { opacity: 0.45 } }, stageStamp(style.confirmedAt)),
            ),
            h(
              'div',
              { style: { marginTop: 4, fontSize: 11, lineHeight: 1.6, color: T.textDim } },
              style.spec && style.spec.tone ? style.spec.tone : '',
            ),
            h(
              'div',
              { style: { marginTop: 3, display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, flexWrap: 'wrap' } },
              h('span', { style: { opacity: 0.45 } }, '字体'),
              h('span', {}, (style.spec && style.spec.font) || '—'),
              h('span', { style: { opacity: 0.45 } }, '密度'),
              h('span', {}, (style.spec && style.spec.density) || '—'),
              h('span', { style: { opacity: 0.45 } }, '节奏'),
              h('span', {}, style.spec && style.spec.pace ? `${style.spec.pace}s/镜` : '—'),
              ...((style.spec && Array.isArray(style.spec.palette) ? style.spec.palette : []).slice(0, 12).map(
                (color, index) =>
                  h('span', {
                    key: 'c' + index,
                    title: color,
                    style: {
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      background: color,
                      border: `1px solid ${T.border}`,
                    },
                  }),
              )),
            ),
            keyframes.length
              ? h(
                  'div',
                  {
                    style: {
                      marginTop: 6,
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: 4,
                    },
                  },
                  keyframes.slice(0, 4).map((relPath, index) =>
                    String(relPath).startsWith(STYLE_PREVIEW_PREFIX)
                      ? h('img', {
                          key: 'k' + index,
                          src: styleFileUrlFor(projectId, relPath, style.confirmedAt || ''),
                          alt: `关键帧 ${index + 1}`,
                          style: {
                            width: '100%',
                            height: 48,
                            objectFit: 'cover',
                            borderRadius: 4,
                            background: T.fillStrong,
                            border: `1px solid ${T.border}`,
                          },
                        })
                      : h(
                          'div',
                          {
                            key: 'k' + index,
                            title: relPath,
                            style: {
                              height: 48,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: 9,
                              opacity: 0.5,
                              borderRadius: 4,
                              background: T.fillStrong,
                              border: `1px dashed ${T.border}`,
                            },
                          },
                          '不在预览目录',
                        ),
                  ),
                )
              : null,
            keyframes.length && keyframes.some((relPath) => !String(relPath).startsWith(STYLE_PREVIEW_PREFIX))
              ? stageNote('有路径不在 .dsh-video/style-preview/ 下，面板读不到那些图（越界路径已在 host 侧过滤）。')
              : null,
            clipPath
              ? String(clipPath).startsWith(STYLE_PREVIEW_PREFIX)
                ? h('video', {
                    src: styleFileUrlFor(projectId, clipPath, style.confirmedAt || ''),
                    controls: true,
                    muted: true,
                    playsInline: true,
                    style: {
                      width: '100%',
                      marginTop: 6,
                      borderRadius: 6,
                      background: '#000',
                      display: 'block',
                    },
                  })
                : stageNote('样片不在预览目录，面板读不到：' + clipPath)
              : stageNote('这一版没有 8 秒样片（video_style_confirm 的 preview.clip 为空）。'),
          )
        : stageNote('风格未确认：让 agent 调 video_style_confirm 记录 tone / palette / font / density / pace。'),
    ),

    // 底部：下一步 + 被拦住的类别。写操作一律指向 agent 工具。
    h(
      'div',
      { style: { marginTop: 10, paddingTop: 8, borderTop: `1px solid ${T.borderFaint}` } },
      h(
        'div',
        { style: { fontSize: 11, lineHeight: 1.6, color: T.text } },
        snapshot.nextStep || '暂无下一步提示',
      ),
      blocked.length
        ? h(
            'div',
            { style: { marginTop: 4, fontSize: 10, lineHeight: 1.6, color: T.warn } },
            blocked.map((item, index) => h('div', { key: index }, '· ' + item)),
          )
        : null,
      warnings.length
        ? h(
            'div',
            { style: { marginTop: 4 } },
            warnings.slice(0, 4).map((text, index) => h('div', { key: index }, stageNote('· ' + text))),
          )
        : null,
      failure ? h('div', { style: { marginTop: 4 } }, stageNote('轮询失败：' + failure, 'danger')) : null,
    ),
  );
}

/**
 * 右侧检查器：原来的检查器内容 + 风格样片 + 配音 + 语音转字幕 + 底部的分镜折叠区。
 *
 * 包一层而不是在每个 return 分支里各挂一次：不管当前选中的是片段、标注还是
 * 什么都没选，它们都停在同一个位置，也不会跟检查器自己的滚动条抢高度。
 */
export function Inspector(props) {
  const annotations = Array.isArray(props.annotations) ? props.annotations : [];
  const selection = props.selection || null;
  const selectedAnnotationId = selection && selection.kind === 'annotation' ? selection.id : null;
  const counts = annotationCounts(annotations);
  // 「属性 / 标注」两页：默认属性页；点时间线上的胶囊会自动翻到标注页，
  // 反过来点片段则回到属性页 —— 选中态两边同一份，不做第二套状态。
  const [pane, setPane] = React.useState('inspect');
  React.useEffect(() => {
    if (selectedAnnotationId) setPane('annotations');
    else if (selection && selection.kind === 'clip') setPane('inspect');
  }, [selectedAnnotationId, selection && selection.kind]);

  const tab = (key, label) =>
    h(
      'button',
      {
        key,
        type: 'button',
        onClick: () => setPane(key),
        style: {
          flex: 1,
          padding: '6px 8px',
          border: 'none',
          borderBottom: pane === key ? `2px solid ${T.accent}` : '2px solid transparent',
          background: pane === key ? T.panel : 'transparent',
          color: pane === key ? T.text : T.textDim,
          fontSize: 11,
          cursor: 'pointer',
        },
      },
      label,
    );

  return h(
    'div',
    { style: { minHeight: 0 } },
    h(StagePanel, { projectId: state.projectId, sessionId: state.sessionId }),
    h(
      'div',
      { style: { display: 'flex', borderBottom: `1px solid ${T.border}`, background: T.fill } },
      tab('inspect', '属性'),
      tab('annotations', `标注 · ${counts.total}`),
    ),
    pane === 'annotations'
      ? h(AnnotationsPanel, {
          annotations,
          selection,
          playhead: props.playhead,
          duration: props.doc ? props.doc.duration : 0,
          onSelect: props.onAnnotationSelect,
          onJump: props.onAnnotationJump,
          onPatch: props.onAnnotationPatch,
          onDelete: props.onAnnotationDelete,
        })
      : h(InspectorBody, props),
    h(StylePanel, { projectId: state.projectId, sessionId: state.sessionId }),
    h(TtsPanel, { projectId: state.projectId, sessionId: state.sessionId }),
    h(AsrPanel, { projectId: state.projectId, sessionId: state.sessionId }),
    h(StoryboardPanel, {
      projectId: state.projectId,
      sessionId: state.sessionId,
    }),
  );
}

export function ProgressOverlay({ busy }) {
  if (!busy) return null;
  const ratio = Math.max(0, Math.min(1, busy.ratio || 0));
  return h(
    'div',
    {
      style: {
        position: 'absolute',
        inset: 0,
        background: T.mask,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 30,
      },
    },
    h(
      'div',
      {
        style: {
          width: 320,
          background: T.panel,
          border: `1px solid ${T.border}`,
          borderRadius: 10,
          padding: 16,
          fontSize: 12,
          color: T.text,
        },
      },
      h('div', { style: { marginBottom: 10 } }, busy.label || '处理中…'),
      h(
        'div',
        { style: { height: 6, background: T.fillStrong, borderRadius: 3, overflow: 'hidden' } },
        h('div', { style: { width: `${ratio * 100}%`, height: '100%', background: T.accent, transition: 'width .2s' } }),
      ),
      h('div', { style: { marginTop: 8, opacity: 0.6 } }, `${Math.round(ratio * 100)}%`),
      busy.detail ? h('div', { style: { marginTop: 6, opacity: 0.5, fontSize: 11 } }, busy.detail) : null,
    ),
  );
}

// ------------------------------------------------------------- 选择面板 ----
//
// 没有 active 工程时看到的那一屏。它只读：所有动作（启用 / 进入 / 停止 / 改名）
// 都通过 props 传上来的回调走，组件自己不发 RPC —— 这样 SSR 能直接渲染断言。
//
// 为什么要有这一屏：视频工作台是重型资源（一个 <video> 30–80MB），全局同时只允许
// MAX_ENABLED 个工程「已启用」。启动时把「本会话绑定的工程 + 全局启用列表」摆出来，
// 让用户看清额度被谁占着，再决定进哪一个。

/** 「r14 · 14.77s · 30fps · 16:9」—— 卡片上那一行摘要。 */
export function projectSummaryText(doc) {
  if (!doc) return '';
  const revision = doc.revision == null ? 'r?' : 'r' + doc.revision;
  const duration = typeof doc.duration === 'number' ? doc.duration.toFixed(2) + 's' : '—';
  const fps = doc.fps == null ? '?fps' : doc.fps + 'fps';
  const ratio = doc.ratio || '—';
  return `${revision} · ${duration} · ${fps} · ${ratio}`;
}

/**
 * 会话标识：用来解释额度被谁占着，不泄露整串 id。
 *
 * DSH 的会话 id 形如 `session-<uuid>`，前 8 位恒为 `session-` —— 只取前 8 位
 * 等于所有会话都显示成「session-」，区分不了。所以先去掉这个前缀，再取
 * 「前 5 + … + 末 4」；短 id（≤ 5+4 位）原样显示。
 */
export function shortSessionTag(sessionId) {
  const s = String(sessionId || '');
  if (!s) return '未知会话';
  const tail = s.startsWith('session-') ? s.slice('session-'.length) : s;
  if (!tail) return '未知会话';
  return tail.length > 9 ? tail.slice(0, 5) + '…' + tail.slice(-4) : tail;
}

/** 本会话工程：绑定工程 + store 里属于本会话的工程，按 projectId 去重。 */
export function mergeSessionProjects(doc, projects, sessionId) {
  const out = [];
  const seen = new Set();
  for (const p of [doc, ...(projects || [])]) {
    if (!p || !p.projectId || seen.has(p.projectId)) continue;
    if (sessionId && p.boundSessionId && p.boundSessionId !== sessionId) continue;
    seen.add(p.projectId);
    out.push(p);
  }
  return out;
}

/**
 * 把全局启用列表分成「我的」和「其他会话的」。
 *
 * ★ 归属判据是**启用这条记录的那个会话 id**（enabled[].sessionId），
 *   不是「在不在本会话工程列表里」。旧实现用 projectId 差集判断，会把
 *   本会话自己启用、但还没绑定到当前工程的那条，误贴成「其他会话」——
 *   用户在自己的会话里既进不去也停不掉，额度被锁死。
 *
 * 返回：
 *   mineEnabled  —— 我启用的、且已在本会话工程列表里（正常卡片入口）
 *   mineOnly     —— 我启用的、但列表里没有（仍算我的，必须给按钮）
 *   others       —— 真正属于其他会话的
 */
export function classifyEnabled({ sessionId, list, enabled }) {
  const all = Array.isArray(enabled) ? enabled : [];
  const mine = Array.isArray(list) ? list : [];
  const inList = (x) => mine.some((p) => p && p.projectId === x.projectId);
  const sameSession = (x) => !sessionId || !x.sessionId || x.sessionId === sessionId;
  const mineOnly = [];
  const others = [];
  for (const x of all) {
    if (!x || !x.projectId) continue;
    if (!sameSession(x)) others.push(x);
    else if (!inList(x)) mineOnly.push(x);
  }
  return { mineOnly, others };
}

const cardStyle = {
  border: `1px solid ${T.border}`,
  borderRadius: 10,
  padding: '10px 12px',
  background: T.fill,
};

export function SelectionPanel(props) {
  const {
    sessionId,
    projects,
    doc,
    enabled,
    max,
    busy,
    error,
    onNew,
    onEnter,
    onEnable,
    onDisable,
    onRename,
  } = props || {};
  const [renamingId, setRenamingId] = React.useState(null);
  const [renameValue, setRenameValue] = React.useState('');

  const list = mergeSessionProjects(doc, projects, sessionId);
  const all = enabled || [];
  const limit = Math.max(1, Number(max) || 2);
  // 额度只算面板启用的（origin==='panel'）；agent 调用占的条目不占额度，
  // 所以这里不能直接用 all.length —— 否则界面显示 2/2 而实际可用。
  const used = all.filter((x) => x && x.origin === 'panel').length;
  const agentOwned = all.filter((x) => x && x.origin !== 'panel').length;
  const isOn = (id) => all.some((x) => x.projectId === id);
  // 归属按「谁启用的这个工程」判（enabled 每条带的是 sessionId）。
  // 旧写法是 `all.filter(x => !list.some(p => p.projectId === x.projectId))`：
  // 只要工程没被收进 list（尚未绑定 / doc 恰好是另一个工程），它就会掉进「其他会话」，
  // 哪怕启用它的就是本会话 —— 于是本会话的工程被贴成别人的、还没有任何按钮，额度被锁死。
  // 归属判据见 classifyEnabled（按「谁启用的」判，不按 projectId 差集）
  const { mineOnly: mineEnabledOnly, others } = classifyEnabled({ sessionId, list, enabled: all });
  const call = (fn, ...args) => {
    if (typeof fn === 'function') fn(...args);
  };

  function startRename(project) {
    setRenamingId(project.projectId);
    setRenameValue(project.title || '');
  }

  function commitRename(project) {
    const title = String(renameValue || '').trim();
    if (!title) return;
    setRenamingId(null);
    call(onRename, project.projectId, title);
  }

  const rowBtn = (label, onClick, extra) =>
    h(
      'button',
      {
        type: 'button',
        onClick,
        style: Object.assign(
          {
            padding: '3px 10px',
            borderRadius: 6,
            border: `1px solid ${T.border}`,
            background: T.panel,
            color: T.text,
            fontSize: 11,
            cursor: 'pointer',
          },
          extra || {},
        ),
      },
      label,
    );

  return h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        overflow: 'auto',
        background: T.bg,
        color: T.text,
        fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
      },
    },
    // 顶栏：标题 + 已用 N/2
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          borderBottom: `1px solid ${T.border}`,
          minHeight: 48,
        },
      },
      h('strong', { style: { fontSize: 14, fontWeight: 600 } }, '视频工作台'),
      h(
        'span',
        {
          style: {
            fontSize: 11,
            padding: '2px 8px',
            borderRadius: 999,
            border: `1px solid ${T.border}`,
            background: used >= limit ? T.warnDim : T.accentDim,
            color: used >= limit ? T.warn : T.accent,
          },
        },
        `已用 ${used}/${limit}`,
      ),
      // agent 调用占的工程不占额度，单独说明 —— 否则用户看到列表里有 3 个却写着 1/2 会以为坏了
      agentOwned > 0
        ? h(
            'span',
            { style: { fontSize: 11, opacity: 0.5 } },
            '另有 ' + agentOwned + ' 个由 agent 打开（不占额度）',
          )
        : null,
      h('span', { style: { fontSize: 11, opacity: 0.55 } }, '全局最多 ' + limit + ' 个工程同时处于启用状态'),
      h('div', { style: { flex: 1 } }),
      rowBtn('新建工程', () => call(onNew)),
    ),
    h(
      'div',
      { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 900, width: '100%', margin: '0 auto' } },
      busy ? h('div', { style: { fontSize: 11, opacity: 0.6 } }, busy.label || '处理中…') : null,
      error ? h('div', { style: { fontSize: 12, color: T.danger } }, error) : null,

      // 本会话的工程卡
      list.length === 0
        ? h(
            'div',
            { style: { padding: 24, textAlign: 'center', fontSize: 12, opacity: 0.7, lineHeight: 1.8 } },
            '这个会话还没有视频工程。',
            h('div', null, '新建一个：工程会绑定到当前会话，但不会自动占用启用额度。'),
          )
        : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            h('div', { style: { fontSize: 12, opacity: 0.6 } }, '本会话的工程'),
            list.map((p) => {
              const on = isOn(p.projectId);
              const renaming = renamingId === p.projectId;
              // open 为 false = 已登记 / 已绑定，但本进程还没加载它（停用后、重启后都是这种）。
              // 老数据没有这个字段，按「已打开」解释，保持旧卡片行为。
              const isOpen = p.open !== false;
              const missing = p.missing === true;
              return h(
                'div',
                { key: p.projectId, style: Object.assign({}, cardStyle, on ? { borderColor: T.accent } : null) },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  renaming
                    ? h('input', {
                        autoFocus: true,
                        value: renameValue,
                        maxLength: 60,
                        onChange: (e) => setRenameValue(e.target.value),
                        onKeyDown: (e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitRename(p);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setRenamingId(null);
                          }
                        },
                        style: {
                          flex: 1,
                          minWidth: 160,
                          padding: '4px 8px',
                          borderRadius: 6,
                          border: `1px solid ${T.border}`,
                          background: T.fill,
                          color: T.text,
                          fontSize: 12,
                          fontFamily: 'inherit',
                        },
                      })
                    : h('strong', { style: { fontSize: 13 } }, p.title || '未命名工程'),
                  renaming
                    ? rowBtn('确认', () => commitRename(p))
                    : rowBtn('重命名', () => startRename(p)),
                  renaming ? rowBtn('取消', () => setRenamingId(null)) : null,
                  h('div', { style: { flex: 1 } }),
                  // 停用之后卡片仍然在，只是角标变回「未启用」—— 这是这次修的重点：
                  // 列表不只看内存，还看登记表与绑定表，所以它不会再凭空消失。
                  chip(on ? '已启用' : '未启用', on ? 'ok' : 'warn'),
                  missing ? chip('路径不存在', 'warn') : null,
                ),
                h(
                  'div',
                  { style: { fontSize: 11, opacity: 0.5, marginTop: 4, wordBreak: 'break-all' } },
                  p.root || '（路径未知）',
                ),
                isOpen
                  ? h('div', { style: { fontSize: 11, opacity: 0.7, marginTop: 2 } }, projectSummaryText(p))
                  : h(
                      'div',
                      { style: { fontSize: 11, opacity: 0.55, marginTop: 2 } },
                      missing
                        ? '工程目录或 project.json 读不到，进入会失败。请确认目录是否被移动或删除。'
                        : '还没加载（停用或重启后会这样）。点「进入」会自动加载并启用。',
                    ),
                h(
                  'div',
                  { style: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' } },
                  // 「启用」只对已打开的工程有意义：没打开的工程走「进入」，
                  // 由 Host 用 dir 自愈打开再启用（一次点击完成，不再两个按钮互相等）。
                  isOpen
                    ? rowBtn('启用', () => call(onEnable, p), {
                        opacity: on ? 0.45 : 1,
                        borderColor: on ? undefined : T.accent,
                        color: on ? undefined : T.accent,
                      })
                    : null,
                  rowBtn('进入', () => call(onEnter, p), {
                    background: missing ? T.fill : T.primary,
                    border: `1px solid ${missing ? T.border : T.primary}`,
                    color: missing ? T.textDim : T.onPrimary,
                    fontWeight: 600,
                    opacity: missing ? 0.55 : 1,
                  }),
                  on
                    ? rowBtn('停止启用', () => call(onDisable, p), {
                        color: T.danger,
                        borderColor: T.danger,
                      })
                    : null,
                ),
              );
            }),
          ),

      // 本会话启用、但没进 list 的工程（未绑定 / doc 是别的工程）：
      // 它占的是我自己的额度，所以必须给我按钮，不能贴成「其他会话」。
      mineEnabledOnly.length
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: { fontSize: 12, opacity: 0.6 } }, '本会话已启用、但还没绑定到当前工程'),
            mineEnabledOnly.map((x) =>
              h(
                'div',
                {
                  key: x.projectId,
                  style: { fontSize: 11, padding: '6px 10px', borderRadius: 8, background: T.fill, border: `1px solid ${T.border}` },
                },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  h('span', { style: { opacity: 0.85 } }, x.title || x.projectId),
                  h('div', { style: { flex: 1 } }),
                  rowBtn('进入', () => call(onEnter, x), {
                    background: T.primary,
                    border: `1px solid ${T.primary}`,
                    color: T.onPrimary,
                    fontWeight: 600,
                  }),
                  rowBtn('停止启用', () => call(onDisable, x), { color: T.danger, borderColor: T.danger }),
                ),
                x.root ? h('div', { style: { opacity: 0.4, marginTop: 2, wordBreak: 'break-all' } }, x.root) : null,
              ),
            ),
          )
        : null,

      // 其他会话占着额度的工程：可以在这里直接停用（后端 disable 不校验会话），
      // 否则一旦占额度的是没有面板的 agent 会话，额度就再也放不出来了。
      others.length
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: { fontSize: 12, opacity: 0.6 } }, '其他会话已启用的工程'),
            others.map((x) =>
              h(
                'div',
                {
                  key: x.projectId,
                  style: { fontSize: 11, padding: '6px 10px', borderRadius: 8, background: T.fill, border: `1px dashed ${T.border}` },
                },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  h('span', { style: { opacity: 0.85 } }, x.title || x.projectId),
                  h('span', { style: { opacity: 0.5 } }, '会话 ' + shortSessionTag(x.sessionId)),
                  h('div', { style: { flex: 1 } }),
                  rowBtn('在这里停用', () => call(onDisable, x), { color: T.danger, borderColor: T.danger }),
                ),
                x.root ? h('div', { style: { opacity: 0.4, marginTop: 2, wordBreak: 'break-all' } }, x.root) : null,
              ),
            ),
            h(
              'div',
              { style: { fontSize: 11, opacity: 0.45, lineHeight: 1.6 } },
              '额度是全局的（' + used + '/' + limit + '）。在这里停用等于替那个会话释放额度；如果那个会话正在用这个工程，它的预览会失效。',
            ),
          )
        : null,
    ),
  );
}
