/**
 * Workbench page + composer entry.
 *
 * The page is a view over one Host document: it reads through the bridge,
 * dispatches commands, and paints the current frame. The agent edits the same
 * document through tools, so both sides land on one timeline and one undo stack.
 */

import React from 'react';
import {
  state,
  subscribe,
  setState,
  rpc,
  refresh,
  openProject,
  dispatch,
  reportError,
  toast,
  mediaUrl,
  fmtTime,
  deleteProject,
  syncAssetsFromDisk,
  loadEnabled,
  loadMyProjects,
  enableProject,
  disableProject,
  renameProject,
  rebindProject,
} from './bridge.js';
import { Timeline } from './timeline.js';
import { T } from './theme.js';
import {
  MediaBin,
  Inspector,
  ProgressOverlay,
  MotionLibrary,
  SoundLibrary,
  TemplateBar,
  SelectionPanel,
  mergeSessionProjects,
} from './panels.js';
import * as player from './player.js';
import { prepareFonts } from './frame-render.js';
import { createSampler } from './sampler.js';
import { createAudioEngine } from './audio.js';
import { probe } from './probe.js';
import { chooseExportPlan, describePlan, probeEncoders } from './codec-caps.mjs';
import { createCodeRegistry } from './code-registry.js';
import { prefetchThumb, clearThumbs } from './thumbs.js';
import { prefetchWaveform, clearWaveforms } from './waveform.js';
import { parseSrt, clipsToSrt } from '../srt.mjs';
import {
  ANNOTATION_INTENTS,
  INTENT_LABELS,
  annotationOp,
  formatAnnotation,
  frameRange,
  spanRange,
} from '../annotations.mjs';
// 素材 kind 的唯一判据：音频只能进 a1，视频/图片才走 v1 / v2。
import { insertPolicy, isAudioAsset, isVideoAsset, resolveInsertTrack } from '../media-kind.mjs';

// 见 panels.js 同名注释：原生下拉在浅色系统主题下会把 option 画成白底。
const OPTION_STYLE = { background: T.bg, color: T.text };

/**
 * 编码探测的等待上限（毫秒）。
 * 打开表单要快：正常机器上 isConfigSupported × 6 是几十毫秒；超过这个数说明
 * 驱动/GPU 卡住了，再等下去只是让表单转圈。超时后如实告诉用户「导出时再定」。
 */
const CAPS_TIMEOUT_MS = 1200;

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

const PANEL_ID = 'video-workbench';

function beacon(stage, detail) {
  try {
    fetch('/api/video/beacon', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage, detail: detail == null ? '' : String(detail) }),
    }).catch(() => {});
  } catch {
    /* 留痕失败无所谓 */
  }
}
const DOCK_ID = 'video-workbench';

function useStore() {
  const [, force] = React.useReducer((n) => n + 1, 0);
  React.useEffect(() => subscribe(force), []);
  return state;
}

const btn = (label, onClick, extra) =>
  h(
    'button',
    {
      type: 'button',
      onClick,
      style: Object.assign(
        {
          padding: '4px 10px',
          borderRadius: 6,
          border: `1px solid ${T.border}`,
          background: T.panel,
          color: T.text,
          fontSize: 12,
          cursor: 'pointer',
        },
        extra || {},
      ),
    },
    label,
  );

// ------------------------------------------------------------------ player ---

/**
 * 写剪贴板：优先 navigator.clipboard；webview 没给权限时退回 execCommand。
 * 返回 true / false，调用方据此决定 toast 文案 —— 不假装复制成功。
 */
async function copyText(text) {
  const value = String(text == null ? '' : text);
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 权限被拒：继续走兜底 */
  }
  try {
    if (!document || !document.body) return false;
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    area.style.top = '0';
    document.body.appendChild(area);
    area.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    document.body.removeChild(area);
    return !!ok;
  } catch {
    return false;
  }
}

/**
 * 面板高度：`height:100%` 在「父级是 auto」时会退化成 auto（宿主 slot 就是这样），
 * 于是内容按自身高度把整页撑长。这里再按视口算一个确定值，两者都写。
 * 纯函数在 player.fitPanelHeight，测试断言数字。
 */
function useFillHeight(ref) {
  const [height, setHeight] = React.useState(0);
  React.useEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const parent = el.parentElement;
      const next = player.fitPanelHeight({
        viewportHeight: typeof window !== 'undefined' ? window.innerHeight : 0,
        top: rect.top,
        parentHeight: parent ? parent.clientHeight : 0,
        min: player.WORKBENCH_LAYOUT.minPanelHeight,
      });
      setHeight((cur) => (Math.abs(cur - next) < 2 ? cur : next));
    };
    measure();
    if (typeof window === 'undefined') return undefined;
    window.addEventListener('resize', measure);
    let ro = null;
    if (typeof ResizeObserver !== 'undefined' && ref.current && ref.current.parentElement) {
      ro = new ResizeObserver(() => requestAnimationFrame(measure));
      ro.observe(ref.current.parentElement);
    }
    return () => {
      window.removeEventListener('resize', measure);
      if (ro) ro.disconnect();
    };
  }, [ref]);
  return height;
}

/**
 * 预览画布。时间轴由 player.createPlaybackEngine 独占：
 * 这里只提供「画一帧」的实现和回调，不再自己开 rAF 循环。
 *
 * 旧实现的三个坑（正是用户报的三个现象）：
 *   - rAF 每帧都无条件续约，暂停只是「不画」，循环还在跑；
 *   - 暂停时 drawImage 在 seeked 之前就执行，画出来是黑的；
 *   - 依赖里带着每次渲染都新建的 onTime，effect 被反复拆建。
 */
function PlayerCanvas({ clips, assets, playing, playhead, code, engineRef, onTime, onMediaState, onDiagnostic, getAudio }) {
  const canvasRef = React.useRef(null);
  const viewRef = React.useRef({ clips, assets });
  viewRef.current = { clips, assets };
  const onTimeRef = React.useRef(onTime);
  onTimeRef.current = onTime;
  const mediaStateRef = React.useRef(onMediaState);
  mediaStateRef.current = onMediaState;
  const diagRef = React.useRef(onDiagnostic);
  diagRef.current = onDiagnostic;
  const codeRef = React.useRef(code);
  codeRef.current = code;
  const audioRef = React.useRef(getAudio);
  audioRef.current = getAudio;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d', { alpha: false });
    const W = 960;
    const H = 540;
    canvas.width = W;
    canvas.height = H;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    let lastUi = 0;

    const paint = (t, meta) => {
      const view = viewRef.current;
      // 合成器统一算图层：转场、变速都在这份清单里；代码图层由 registry 提供画布
      const layers = player.frameLayers(view.clips, t);
      const registry = codeRef.current;
      if (registry) {
        try {
          registry.tickLayers(layers, !!(meta && meta.playing)).catch(() => {});
        } catch {
          /* 代码图层失败不影响画面 */
        }
      }
      // paintPreviewFrame 会再确认一次「这一帧的视频真的到了目标时间」：
      // 没到就一个像素都不动，保留上一帧（黑屏就是这么来的）。
      player.paintPreviewFrame(ctx, {
        clips: view.clips,
        assets: view.assets,
        t,
        width: W,
        height: H,
        layers,
        codeCanvas: registry ? (clip) => registry.canvasFor(clip) : null,
        onMediaState: (list) => {
          const fn = mediaStateRef.current;
          if (fn) fn(list);
        },
      });
    };

    const engine = player.createPlaybackEngine({
      getView: () => ({
        clips: viewRef.current.clips,
        assets: viewRef.current.assets,
        duration: state.doc ? state.doc.duration : 0,
      }),
      draw: paint,
      onTick: (t) => {
        // 播放头只有一个写入点：引擎。这里同步给 store（UI 读它）。
        state.playhead = t;
        const stamp = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
        if (stamp - lastUi > 33) {
          lastUi = stamp;
          onTimeRef.current(t);
        }
      },
      onEnd: () => setState({ playing: false, playhead: state.doc ? state.doc.duration : state.playhead }),
      onDiagnostic: (list) => {
        const fn = diagRef.current;
        if (fn) fn(list);
      },
      getAudio: () => (audioRef.current ? audioRef.current() : null),
    });

    if (engineRef) engineRef.current = engine;
    engine.setPlayhead(Number(playhead) || 0);
    if (state.playing) engine.play(state.playhead);
    else engine.refresh();

    // 字体闸门：预览不阻塞首帧（黑屏比 fallback 更糟），但字体就绪后立刻重画一帧，
    // 让用户看到的就是导出会得到的度量。导出侧在第 1 帧前 await 同一个函数。
    let dead = false;
    const previewTextLayers = () =>
      (viewRef.current.clips || [])
        .filter((c) => c && c.type === 'text')
        .map((c) => ({ kind: 'text', clip: c }));
    prepareFonts({ height: H, layers: previewTextLayers(), timeoutMs: 1200 })
      .catch(() => null)
      .then(() => {
        const e = engineRef && engineRef.current;
        if (!dead && e) e.refresh();
      });

    // 媒体就绪状态变了（loadeddata / canplay / 重新加载）→ 暂停时重新定格一帧。
    // 旧代码靠 mediaGeneration 进 key 触发重绘，但那只在循环还在跑时有效。
    const off = player.onMediaReady(() => {
      const e = engineRef && engineRef.current;
      if (e) e.refresh();
    });

    return () => {
      dead = true;
      off();
      engine.dispose();
      if (engineRef) engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // playing 是「意图」，引擎是「事实」：这里是唯一对账点（自动停、切工程也走它）。
  React.useEffect(() => {
    const engine = engineRef && engineRef.current;
    if (!engine) return;
    if (playing && !engine.isPlaying()) engine.play(state.playhead);
    else if (!playing && engine.isPlaying()) engine.pause();
  }, [playing, engineRef]);

  return h('canvas', {
    ref: canvasRef,
    style: {
      width: '100%',
      height: '100%',
      maxHeight: '100%',
      objectFit: 'contain',
      background: '#000',
      display: 'block',
    },
  });
}

// ---------------------------------------------------------------- page ------

function Workbench(props) {
  const s = useStore();
  // 撤销/重做栈（Host 侧内存，最多 50 步）。两个数组只用来决定按钮是否高亮，
  // 真正的判定在 store 里 —— 客户端不自己猜「哪一步还能撤」。
  const [undoInfo, setUndoInfo] = React.useState({ undo: [], redo: [] });
  const [showLog, setShowLog] = React.useState(false);
  const [exportSettings, setExportSettings] = React.useState({ width: 1920, height: 1080, fps: 30 });
  // 导出参数：面板内表单（webview 里 window.prompt 不可用），默认全部「跟随工程」
  const [exportOpen, setExportOpen] = React.useState(false);
  const [exportForm, setExportForm] = React.useState({
    resolution: 'project',
    fps: 'project',
    bitrate: 'auto',
    range: 'all',
  });
  // 编码能力：打开导出表单时异步探一次。这台机器没有 H.264 编码器，
  // 必须在不阻塞表单的前提下先说清「这次会得到什么格式」。
  const [caps, setCaps] = React.useState(null);
  const [capsBusy, setCapsBusy] = React.useState(false);
  const [capsError, setCapsError] = React.useState(null);
  // 探测超时 ≠ 探测失败：导出仍然可以走运行时协商，只是表单不再假装知道格式。
  const [capsTimedOut, setCapsTimedOut] = React.useState(false);
  const [diag, setDiag] = React.useState(null);
  // 面板内输入：webview 禁用了 window.prompt / alert / confirm，所以这三个动作
  // 全部改成「在面板里展开一行」。没有一个 window.* 对话框会再出现在这三处。
  const [textOpen, setTextOpen] = React.useState(false);
  const [textValue, setTextValue] = React.useState('');
  const [annot, setAnnot] = React.useState(null); // { step:'pick'|'span'|'note', a, range, intent, value }
  const [exported, setExported] = React.useState(null); // { text, count, items }
  const [deleteAsk, setDeleteAsk] = React.useState(false);
  // 顶栏改名/切换：webview 里 prompt/confirm 不可用，全部做成面板内输入与下拉
  const [renaming, setRenaming] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState('');
  const [switchOpen, setSwitchOpen] = React.useState(false);
  // 标注位置要显示成「第 7 镜 · 12.40s（镜内 +0.30s）」：整份镜头表在这里读一次
  const [analysis, setAnalysis] = React.useState(null);
  // 预览层这一帧没画出来的媒体图层（player 每帧算好，这里只在内容变了才 setState）
  const [mediaIssue, setMediaIssue] = React.useState(null);
  const mediaIssueRef = React.useRef(null);
  mediaIssueRef.current = mediaIssue;
  const issueSigRef = React.useRef('');
  const onMediaState = React.useCallback((list) => {
    // 「正在 seek / 时间漂移」是瞬态，属于预览角标的活，不该在下方拉一条诊断栏。
    const visible = (list || []).filter((d) => d.code !== 'seek-pending' && d.code !== 'seek-drift');
    const sig = visible.map((d) => d.code + ':' + d.assetId).join('|');
    if (sig === issueSigRef.current) return;
    issueSigRef.current = sig;
    setMediaIssue(visible.length ? visible : null);
  }, []);

  // active 是「工作台真的挂载了」：启动时它是 false（只显示选择面板），
  // 进入工程才变 true。没显式给过就按「有 doc」推断，兼容老的渲染路径与测试。
  const active = s.active !== false;

  // 预览的播放引擎：PlayerCanvas 挂载时建、卸载时销毁。播放/暂停/seek 都走它，
  // 不再由 rAF 循环和 store 各推一次 playhead。
  const playbackRef = React.useRef(null);
  // 面板高度：宿主 slot 没有高度，靠这个 ref 量出确定值（见 useFillHeight）。
  const rootRef = React.useRef(null);
  const panelHeight = useFillHeight(rootRef);
  // 这一帧为什么没画出来（seek 超时 / 素材未就绪）—— 显示在预览角标上
  const [seekDiag, setSeekDiag] = React.useState([]);

  // ---- 脏数据：音频素材被放在视频轨上 -------------------------------------
  // 打开工程时问一次 Host（判据在 media-kind.mjs，ffprobe 流类型优先）。
  // 只提示、不阻塞：渲染器本来就跳过音频，画面不会因为它整帧 hold。
  const [audioIssues, setAudioIssues] = React.useState(null);
  const audioIssuesSigRef = React.useRef('');
  const projectIdForIssues = s.projectId;
  const docRevisionForIssues = (s.doc && s.doc.revision) || 0;
  React.useEffect(() => {
    if (!projectIdForIssues) {
      setAudioIssues(null);
      audioIssuesSigRef.current = '';
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const value = await rpc('timeline.audioIssues', { projectId: projectIdForIssues });
        if (cancelled || !value) return;
        const sig = value.count ? value.count + ':' + (value.issues || []).map((i) => i.clipId).join(',') : '';
        if (sig === audioIssuesSigRef.current) return;
        audioIssuesSigRef.current = sig;
        setAudioIssues(value.count ? value : null);
      } catch {
        // 老工程 / 只读场景：不提示，也不打扰预览
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectIdForIssues, docRevisionForIssues]);

  /** 一键修复：把视频轨上的音频片段移到音频轨（一次事务，可撤销）。 */
  async function repairAudioTracks() {
    if (state.busy || !state.projectId) return;
    try {
      setState({ busy: { label: '移到音频轨', ratio: 0.4 } });
      const value = await rpc('timeline.repairAudio', { projectId: state.projectId, sessionId: state.sessionId });
      audioIssuesSigRef.current = '';
      await refresh();
      if (value && value.count) setAudioIssues(value);
      else setAudioIssues(null);
      toast(value && value.moved ? `已把 ${value.moved} 个音频片段移到音频轨` : '没有需要修复的片段');
    } catch (e) {
      reportError(e, '修复音频轨失败');
    } finally {
      setState({ busy: null });
    }
  }

  async function runDiag() {
    setState({ busy: { label: '检测中', ratio: 0.5 } });
    try {
      setDiag(await probe());
    } catch (e) {
      reportError(e, '检测失败');
    } finally {
      setState({ busy: null });
    }
  }
  const sessionId = (props && props.sessionId) || (props && props.session && (props.session.id || props.session.sessionId));

  React.useEffect(() => {
    if (sessionId && sessionId !== state.sessionId) {
      // 换会话 = 什么都没挂载：清干净，等 boot 重新拉绑定工程与启用列表
      setState({
        sessionId,
        projectId: null,
        doc: null,
        clips: [],
        assets: [],
        active: false,
        enabled: [],
        mine: [],
        selection: null,
        playhead: 0,
        playing: false,
      });
    }
  }, [sessionId]);

  async function createProject() {
    if (state.busy) return;
    try {
      const ui = ctxRef.get('uiWorkspace');
      const parent = await ui.pickDirectory();
      if (!parent) return;
      const name = '视频工程-' + new Date().toISOString().slice(5, 10).replace('-', '') + '-' + Math.random().toString(36).slice(2, 5);
      const dir = await ui.createDirectory(parent, name).catch(() => parent);
      setState({ busy: { label: '新建工程', ratio: 0.5 } });
      await openProject(dir);
      // 新建只负责绑定 + 出现在选择面板里，不自动启用、也不自动进入工作台
      setState({ active: false });
      await loadMyProjects().catch(() => []);
      toast('工程已创建并绑定当前会话');
    } catch (e) {
      reportError(e, '打开工程失败');
    } finally {
      setState({ busy: null });
    }
  }

  const doc = s.doc;
  const clips = s.clips || [];
  const assets = s.assets || [];

  /**
   * 播放 / 暂停：先动引擎（同步停），再同步 store（按钮文案）。
   *
   * 顺序很重要：点暂停的那一刻 rAF 就被 cancel、所有 <video> 立刻 pause()，
   * 不用等 React 渲染一轮。旧实现只改了 store 里的 playing，循环还在跑。
   */
  function togglePlayback() {
    const engine = playbackRef.current;
    const current = state.doc;
    if (!current) return;
    const duration = Number(current.duration) || 0;
    if (state.playing) {
      if (engine) engine.pause();
      setState({ playing: false });
      return;
    }
    const from = duration > 0 && state.playhead >= duration - 1e-3 ? 0 : state.playhead;
    if (engine) engine.play(from);
    setState({ playing: true, playhead: from });
  }

  /** seek 的唯一入口：视频、音频、store 的播放头一起到 t。 */
  function seekTo(t, opts) {
    const engine = playbackRef.current;
    const duration = state.doc ? Number(state.doc.duration) || 0 : 0;
    const target = player.clampTime(t, duration);
    if (engine) engine.seek(target, opts || {});
    setState({ playhead: target });
  }

  // 切工程（含切到 null）：立刻释放预览池、缩略图、波形。
  // 放在 ensureVideos 之前声明 —— 同一次提交里 React 按声明顺序跑 effect，
  // 先清再建，新旧工程的 <video> 不可能混在一个池子里。
  const lastProjectRef = React.useRef(state.projectId);
  React.useEffect(() => {
    if (lastProjectRef.current === state.projectId) return;
    lastProjectRef.current = state.projectId;
    releaseHeavy();
  }, [state.projectId]);

  // 启动：只拉「本会话绑定的工程 + 全局启用列表」，不挂工作台
  // （不建 SSE、不建 <video>、不跑探测）。重启后即使工程还在 enabled 里，
  // 也不会自动进入 —— 进入必须由用户在面板上点。
  React.useEffect(() => {
    if (!state.sessionId) return undefined;
    let alive = true;
    (async () => {
      try {
        await loadEnabled();
      } catch (e) {
        if (alive) reportError(e, '读取启用列表失败');
      }
      if (!alive) return;
      let list = [];
      try {
        list = await loadMyProjects();
      } catch {
        list = [];
      }
      if (!alive) return;
      let bound = null;
      try {
        const value = await rpc('project.restore', { sessionId: state.sessionId });
        bound = value && value.doc ? value.doc : null;
      } catch {
        bound = null;
      }
      if (!alive) return;
      setState({
        doc: bound,
        projectId: bound ? bound.projectId : null,
        clips: [],
        assets: [],
        selection: null,
        playhead: 0,
        active: false,
      });
      // restore 之后 store 里就多了这个工程，列表要重拉一次
      try {
        await loadMyProjects();
      } catch {
        /* 列表拉不到不是致命错误 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [state.sessionId]);

  function releaseHeavy() {
    player.clearPool();
    clearThumbs();
    clearWaveforms();
    // 池子清空之后必须让「预览池补齐」重跑一次：ensureSigRef 里记的是
    // 上一次建过的 asset 列表，不清掉的话同一工程重进时会被判成「已经建过」，
    // 于是永远不建元素 —— 画面就停在「正在解码…」。
    ensureSigRef.current = '';
  }

  /**
   * 进入：先 enable（带 dir，Host 会自愈打开）→ 再 openProject（把 doc 装进客户端状态）。
   *
   * 为什么是「先 enable 再 open」，而不是反过来：
   *  1. 额度检查必须排在任何副作用之前。先 open 会在额度已满时先把绑定表改到新工程上，
   *     然后 enable 抛 ENABLED_LIMIT —— 用户既没进去，绑定又已经被换掉了。
   *  2. enable 现在带 dir：工程没在本进程打开时，Host 会自己 store.open（并校验
   *     BOUND_TO_OTHER_SESSION）。「启用要先打开」的死锁因此在后端解开，客户端
   *     不再需要靠调用顺序自救。
   *  3. openProject 在 store 里是幂等的：工程已开就直接返回已有 doc，这一步只负责
   *     把 doc 灌进客户端状态 + refresh 时间线，不会重复加载、也不会重写绑定。
   */
  async function enterProject(project) {
    if (!project || !project.projectId || state.busy) return;
    setState({ busy: { label: '进入工程', ratio: 0.25 } });
    try {
      const root =
        project.root ||
        (state.doc && state.doc.projectId === project.projectId ? state.doc.root : '');
      if (!root) throw new Error('这个工程没有记录磁盘路径，无法打开');
      await enableProject(project.projectId, root); // 幂等；超限抛 ENABLED_LIMIT
      setState({ busy: { label: '进入工程', ratio: 0.65 } });
      await openProject(root); // 已打开则幂等；绑定 + 载入 + refresh
      setState({ active: true, playing: false, playhead: 0, selection: null });
      await loadMyProjects().catch(() => []);
      toast('已进入 ' + (state.doc ? state.doc.title : (project.title || '工程')));
    } catch (e) {
      reportError(e, '进入工程失败');
    } finally {
      setState({ busy: null });
    }
  }

  /** 停止启用：释放额度 + 清池 → 回选择面板。 */
  async function stopProject(project) {
    const target = project && project.projectId ? project.projectId : state.projectId;
    if (!target) {
      setState({ active: false });
      return;
    }
    try {
      await disableProject(target);
    } catch (e) {
      return reportError(e, '停止启用失败');
    }
    releaseHeavy();
    setState({ active: false, playing: false, playhead: 0, selection: null, flash: null, history: [] });
    await loadMyProjects().catch(() => []);
    toast('已停止启用，额度已释放');
  }

  /** 切换：session.rebind（Host 负责停旧/启新/换绑）→ 清池 → 打开新工程 → 挂载。 */
  async function switchTo(project) {
    setSwitchOpen(false);
    if (!project || !project.projectId || project.projectId === state.projectId || state.busy) return;
    setState({ busy: { label: '切换工程', ratio: 0.3 } });
    try {
      if (!project.root) throw new Error('这个工程没有记录磁盘路径，无法打开');
      // 没在本进程打开过的工程：rebind 的第一行 store.get 就会抛 REF_NOT_FOUND
      // （列表现在也会列出「已登记但未打开」的工程）。先 open 一次（幂等），再换绑。
      if (project.open === false) await openProject(project.root);
      await rebindProject(project.projectId); // 失败则整体失败，绑定不变
      releaseHeavy();
      setState({ projectId: null, doc: null, clips: [], assets: [], playing: false, playhead: 0, selection: null });
      await openProject(project.root);
      setState({ active: true });
      await loadMyProjects().catch(() => []);
      await loadEnabled().catch(() => null);
      toast('已切换到 ' + (state.doc ? state.doc.title : (project.title || '工程')));
    } catch (e) {
      reportError(e, '切换工程失败');
    } finally {
      setState({ busy: null });
    }
  }

  /** 顶栏/卡片共用的改名：校验空值与 60 字上限，成功后就地刷新。 */
  async function renameTo(projectId, rawTitle) {
    const title = String(rawTitle == null ? '' : rawTitle).trim();
    if (!title) return toast('工程名不能为空', 'warn');
    if (Array.from(title).length > 60) return toast('工程名最多 60 个字', 'warn');
    try {
      const next = await renameProject(projectId, state.sessionId, title);
      setRenaming(false);
      setRenameValue('');
      if (projectId === state.projectId) await refresh();
      await loadMyProjects().catch(() => []);
      toast('已重命名为「' + ((next && next.title) || title) + '」');
    } catch (e) {
      reportError(e, '重命名失败');
    }
  }

  async function commitRename() {
    return renameTo(state.projectId, renameValue);
  }

  React.useEffect(() => {
    if (!state.projectId || !active) return undefined;
    const es = new EventSource('/api/video/events?projectId=' + encodeURIComponent(state.projectId));
    const onChange = (ev) => {
      refresh().catch(() => {});
      try {
        const data = JSON.parse(ev.data || '{}');
        if (data && data.type === 'commit' && data.human) {
          const next = [{ at: data.at || Date.now(), human: data.human, origin: data.origin || 'ui', revision: data.revision, transactionId: data.transactionId }]
            .concat(state.history || [])
            .slice(0, 20);
          setState({ history: next });
        }
      } catch {
        /* SSE 不是 JSON 就忽略 */
      }
    };
    es.addEventListener('change', onChange);
    return () => {
      es.removeEventListener('change', onChange);
      es.close();
    };
  }, [state.projectId, active]);

  async function removeProject() {
    if (!doc) return;
    // 面板内确认：webview 里 window.confirm 直接返回 undefined，看起来像「点了没反应」
    setDeleteAsk(true);
  }

  async function doRemoveProject(deleteFiles) {
    setDeleteAsk(false);
    try {
      await deleteProject(deleteFiles);
      toast('工程已删除' + (deleteFiles ? '（含文件）' : '（文件保留）'));
    } catch (e) {
      reportError(e, '删除工程失败');
    }
  }

  const codeRef = React.useRef(null);
  React.useEffect(() => {
    if (!state.projectId || !active) return undefined;
    const registry = createCodeRegistry({
      projectId: state.projectId,
      onError: (e, clip) => {
        if (state.toast && state.toast.message === e.message) return;
        setState({ toast: { message: '代码图层 ' + clip.layerId + '：' + e.message, tone: 'warn' } });
      },
    });
    codeRef.current = registry;
    return () => {
      registry.dispose();
      codeRef.current = null;
    };
  }, [state.projectId, active]);

  const audioRef = React.useRef(null);
  React.useEffect(() => {
    // 只有挂载了工作台才建音频引擎（选择面板上不该有 AudioContext）
    if (!state.projectId || !active) return undefined;
    if (!audioRef.current) {
      audioRef.current = createAudioEngine({
        getSegments: () => {
          const byId = new Map((state.assets || []).map((a) => [a.id, a]));
          const out = [];
          for (const c of state.clips || []) {
            if (c.type !== 'media' && c.type !== 'audio') continue;
            const tr = ((state.doc && state.doc.tracks) || []).find((t) => t.id === c.trackId);
            if (tr && tr.muted) continue;
            const a = byId.get(c.assetId);
            if (!a) continue;
            out.push({
              assetId: a.id,
              url: mediaUrl(a.id, { preview: true }),
              start: c.start,
              duration: c.duration,
              sourceIn: c.sourceIn || 0,
              speed: c.speed || 1,
              volume: c.volume == null ? 1 : c.volume,
              fadeIn: c.fadeIn,
              fadeOut: c.fadeOut,
              muted: !!c.muted,
              // 混音纪律要用的角色（voice/music/sfx）；未标注由引擎按 sfx 处理
              audioRole: c.audioRole,
            });
          }
          return out;
        },
      });
    }
    return () => {
      if (audioRef.current) {
        audioRef.current.dispose();
        audioRef.current = null;
      }
    };
  }, [state.projectId, active]);

  // 音频跟着播放引擎走：engine.play/pause/seek 会直接调它。
  // 旧代码在这里单独对 s.playing 做一次 play/pause，结果画布和音频成了两个独立时间源,
  // 一个到了一个没到 —— 现在只有引擎一个开关。

  React.useEffect(() => {
    const sampler = createSampler({ getCode: () => codeRef.current });
    if (state.projectId && active) sampler.start();
    return () => sampler.stop();
  }, [state.projectId, active]);

  React.useEffect(() => {
    if (!active) return undefined;
    const audioClips = (s.clips || []).filter((c) => c.trackId === 'a1');
    if (audioClips.length) {
      let alive = true;
      (async () => {
        let added = 0;
        for (const c of audioClips) {
          const asset = (s.assets || []).find((a) => a.id === c.assetId);
          if (!asset) continue;
          const got = await prefetchWaveform(asset.id, mediaUrl(asset.id, { preview: true }));
          if (got) added += 1;
          if (!alive) return;
        }
        if (alive && added) setState({ thumbTick: Date.now() });
      })();
      return () => {
        alive = false;
      };
    }
    return undefined;
  }, [s.doc && s.doc.revision, s.assets.length, active]);

  React.useEffect(() => {
    if (!active) return undefined;
    const media = (s.clips || []).filter((c) => c.type === 'media');
    if (!media.length) return undefined;
    let alive = true;
    (async () => {
      let added = 0;
      for (const c of media) {
        const asset = (s.assets || []).find((a) => a.id === c.assetId);
        if (!asset || !asset.mime || !asset.mime.startsWith('video')) continue;
        const got = await prefetchThumb(asset.id, mediaUrl(asset.id, { preview: true }), (c.sourceIn || 0) + 0.2);
        if (got) added += 1;
        if (!alive) return;
      }
      if (alive && added) setState({ thumbTick: Date.now() });
    })();
    return () => {
      alive = false;
    };
  }, [s.doc && s.doc.revision, s.assets.length, active]);

  const probedRef = React.useRef(new Set());
  React.useEffect(() => {
    if (!active) return;
    const pending = (s.assets || []).filter((a) => !a.probe && !probedRef.current.has(a.id));
    for (const a of pending) {
      probedRef.current.add(a.id);
      probeAsset(a);
    }
  }, [s.assets, active]);

  // 预览池补齐：只要工程里有视频素材，就必须有一个 <video> 在池子里。
  // 以前这一步只发生在 probeAsset（且只对没有 probe 的素材跑），于是重开工程 / 刷新页面之后
  // 池子永远是空的 —— 那才是「正在解码…」永不消失的真正原因。
  // keep = 当前时间线引用的素材：LRU 淘汰时这些一个都不动。
  const ensureSigRef = React.useRef('');
  React.useEffect(() => {
    if (!s.projectId || !active) return;
    const list = (s.assets || []).filter((a) => a.mime && String(a.mime).startsWith('video/'));
    if (!list.length) return;
    const sig = s.projectId + '|' + list.map((a) => a.id).join(',');
    if (sig === ensureSigRef.current) return;
    ensureSigRef.current = sig;
    const keep = new Set((s.clips || []).map((c) => c.assetId).filter(Boolean));
    const made = player.ensureVideos(list, (id) => mediaUrl(id, { preview: true }), { keep });
    if (made) setState({ mediaTick: Date.now() });
  }, [s.assets, s.doc && s.doc.revision, s.projectId, active, s.clips.length]);

  /** 重建一个（或全部）预览元素：先 release 再 videoFor，等价于面板上的「重新加载」。 */
  function retryMedia(assetId) {
    const ids = assetId ? [assetId] : (mediaIssueRef.current || []).map((d) => d.assetId);
    const uniq = [...new Set(ids)].filter(Boolean);
    if (!uniq.length) {
      toast('现在没有需要重载的素材', 'warn');
      return;
    }
    for (const id of uniq) {
      try {
        player.videoFor(id, mediaUrl(id, { preview: true }), { force: true });
      } catch (e) {
        reportError(e, '重建预览元素失败');
      }
    }
    setState({ mediaTick: Date.now() });
    toast('已重新加载 ' + uniq.length + ' 个素材');
  }

  React.useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayback();
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        if (state.selection && state.selection.kind === 'clip') {
          void doOps([{ type: 'clip.delete', clipId: state.selection.id }], '删除片段');
        }
      } else if (e.code === 'KeyR' && !e.ctrlKey && !e.metaKey) {
        // R = 重建预览元素（重新加载）。只在真有素材画不出来时才拦截，免得抢走普通输入。
        if (mediaIssueRef.current && mediaIssueRef.current.length) {
          e.preventDefault();
          retryMedia();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        // Ctrl+Z 撤销 / Ctrl+Shift+Z 重做；Ctrl+Y 也认（Windows 习惯）
        e.preventDefault();
        if (e.shiftKey) void redoLast();
        else void undoLast();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        void redoLast();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.selection, active]);

  /** 撤销栈快照 → 按钮高亮。失败不打扰用户（工程可能刚被关掉）。 */
  async function loadHistory() {
    if (!state.projectId) {
      setUndoInfo({ undo: [], redo: [] });
      return;
    }
    try {
      const value = await rpc('edit.history', { projectId: state.projectId, sessionId: state.sessionId });
      setUndoInfo({ undo: (value && value.undo) || [], redo: (value && value.redo) || [] });
    } catch {
      setUndoInfo({ undo: [], redo: [] });
    }
  }

  // 每次 revision 变化（自己的操作、agent 的操作、撤销/重做）都重读一次栈。
  React.useEffect(() => {
    if (!active) return undefined;
    void loadHistory();
    return undefined;
  }, [state.projectId, s.doc && s.doc.revision, active]);

  /** 撤销最近一步：toast 里说清撤掉的是哪一步。 */
  async function undoLast() {
    if (!state.projectId || state.busy) return;
    try {
      const r = await rpc('edit.undoLast', { projectId: state.projectId, sessionId: state.sessionId });
      await refresh();
      await loadHistory();
      toast('已撤销：' + (r.summary || '上一步') + '（r' + r.revision + '）');
    } catch (e) {
      reportError(e, '撤销失败');
      await loadHistory();
    }
  }

  /** 重做刚被撤销的那一步。 */
  async function redoLast() {
    if (!state.projectId || state.busy) return;
    try {
      const r = await rpc('edit.redo', { projectId: state.projectId, sessionId: state.sessionId });
      await refresh();
      await loadHistory();
      toast('已重做：' + (r.summary || '这一步') + '（r' + r.revision + '）');
    } catch (e) {
      reportError(e, '重做失败');
      await loadHistory();
    }
  }

  /**
   * 一条命令的完整往返：preview → apply → refresh。
   *
   * 返回 `{ ok, applied }` / `{ ok:false, error }`，让调用方（比如标注草稿）
   * 知道成功与否，并且**失败不吞**：这里照旧 reportError（红色顶栏 + toast），
   * 同时把错误交回去，避免「先清空输入、再失败」这种看起来什么都没发生的状态。
   */
  async function doOps(ops, summary) {
    try {
      const applied = await dispatch(ops, summary);
      if (applied && applied.diff) {
        const ids = []
          .concat(applied.diff.added || [], applied.diff.modified || [])
          .filter((x) => x.kind === 'clip')
          .map((x) => x.id);
        if (ids.length) {
          setState({ flash: { ids: new Set(ids), until: Date.now() + 1500 } });
          setTimeout(() => setState({ flash: null }), 1600);
        }
      }
      toast(applied && applied.human ? applied.human : summary || '已应用');
      return { ok: true, applied };
    } catch (e) {
      reportError(e, '命令失败');
      return { ok: false, error: e };
    }
  }

  // 镜头表：给标注位置算「第几镜」。面板、清单、导出文本共用这一份。
  // 只在挂载后读：启动时不该为一张卡片去拉镜头表。
  React.useEffect(() => {
    if (!state.projectId || !active) return undefined;
    let cancelled = false;
    rpc('analyze.read', { projectId: state.projectId, sessionId: state.sessionId })
      .then((value) => {
        if (!cancelled && value && value.ok === true) setAnalysis(value);
      })
      .catch(() => {
        /* 没解析过不是错误，别打扰用户 */
      });
    return () => {
      cancelled = true;
    };
  }, [state.projectId, s.doc && s.doc.revision, active]);

  /** ＋文字：面板内输入 → 播放头处插入 3 秒文字片段。 */
  function commitText() {
    const text = String(textValue || '').trim();
    if (!text) return toast('文字不能为空', 'warn');
    const start = +state.playhead.toFixed(3);
    setTextOpen(false);
    setTextValue('');
    doOps(
      [
        {
          type: 'clip.insert',
          clipId: 'txt_' + Math.random().toString(36).slice(2, 8),
          trackId: 't1',
          clipType: 'text',
          start,
          duration: 3,
          text,
        },
      ],
      '添加文字',
    );
  }

  /**
   * ＋标注：帧标记或 A→B 区间，最后统一走 annotation.add。
   *
   * 先把命令发出去，**成功了才清空草稿**：
   * 以前的写法是「清空 → 再提交」，所以一旦 Host 拒绝（revision 过期 / 区间非法 /
   * 标注 id 撞车），用户看到的是「输入框没了、轨道上也没有胶囊」—— 点了没反应。
   * 现在失败时草稿原样留在面板上，错误原文红字写在同一行。
   */
  async function commitAnnotation() {
    if (!annot || !annot.range || state.busy) return;
    const expected = String(annot.value || '').trim();
    if (!expected) return toast('批注不能为空', 'warn');
    let op;
    try {
      op = annotationOp({
        annotationId: 'an_' + Math.random().toString(36).slice(2, 8),
        range: annot.range,
        intent: annot.intent || 'change',
        expected,
      });
    } catch (e) {
      return toast((e && e.message) || '标注参数不合法', 'warn');
    }
    const result = await doOps([op], '新增标注');
    if (result.ok) {
      setAnnot(null);
      return;
    }
    setAnnot({ ...annot, error: (result.error && result.error.message) || '新增标注失败' });
  }

  // ---- 标注：右侧「标注」页 / 时间线胶囊共用这几个回调 -------------------
  // 修改和删除都走 Host 的 annotations.update / annotations.remove：
  // 同一条事务链（写租约 → preview(baseRevision) → applyPreview 落盘 + 入撤销栈），
  // 不是客户端自己改 state，所以撤销栈和 revision 不会分叉。

  /** 只选中，不跳（列表的选中态同步用）。 */
  function selectAnnotation(id) {
    if (!id) return;
    setState({ selection: { kind: 'annotation', id } });
  }

  /** 选中 + 播放头跳到该条（倒挂时落到能看见的那一端）。 */
  function jumpAnnotation(annotation) {
    if (!annotation || !annotation.id) return;
    const range = annotation.range || {};
    const start = Number(range.start);
    const end = Number(range.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      toast('这条标注缺少位置信息，没法跳转', 'warn');
      return;
    }
    const at = Math.min(start, end);
    const max = doc ? Number(doc.duration) || at : at;
    setState({ selection: { kind: 'annotation', id: annotation.id } });
    seekTo(Math.max(0, Math.min(max, at)), { force: true });
  }

  async function patchAnnotation(annotation, patch) {
    if (!annotation || !annotation.id || !state.projectId) return;
    try {
      const value = await rpc('annotations.update', {
        projectId: state.projectId,
        sessionId: state.sessionId,
        annotationId: annotation.id,
        baseRevision: s.doc ? s.doc.revision : undefined,
        ...patch,
      });
      await refresh();
      toast('已更新标注（剩 ' + value.remaining + ' 条）');
    } catch (e) {
      reportError(e, '更新标注失败');
      await refresh().catch(() => {});
    }
  }

  async function deleteAnnotation(annotation) {
    if (!annotation || !annotation.id || !state.projectId) return;
    try {
      const value = await rpc('annotations.remove', {
        projectId: state.projectId,
        sessionId: state.sessionId,
        annotationId: annotation.id,
        baseRevision: s.doc ? s.doc.revision : undefined,
      });
      if (state.selection && state.selection.kind === 'annotation' && state.selection.id === annotation.id) {
        setState({ selection: null });
      }
      await refresh();
      toast('已删除标注 · 还剩 ' + value.remaining + ' 条');
    } catch (e) {
      reportError(e, '删除标注失败');
      await refresh().catch(() => {});
    }
  }

  /** 全部提交：把标注整理成一段文本，复制到剪贴板，并在面板里显示。 */
  async function submitAnnotations() {
    if (!state.projectId) return toast('还没有打开工程', 'warn');
    try {
      const value = await rpc('annotations.export', {
        projectId: state.projectId,
        sessionId: state.sessionId,
      });
      setExported({ text: value.text || '', count: value.count || 0, items: value.annotations || [] });
      if (!value.count) return toast('还没有标注', 'warn');
      const copied = await copyText(value.text || '');
      toast(
        copied ? `已复制 ${value.count} 条标注` : `已整理 ${value.count} 条标注（剪贴板不可用，请手动复制）`,
        copied ? 'info' : 'warn',
      );
    } catch (e) {
      reportError(e, '导出标注失败');
    }
  }

  async function probeAsset(asset) {    const v = player.videoFor(asset.id, mediaUrl(asset.id, { preview: true }));
    await new Promise((resolve) => {
      if (v.readyState >= 1) return resolve();
      const done = () => {
        v.removeEventListener('loadedmetadata', done);
        v.removeEventListener('error', done);
        resolve();
      };
      v.addEventListener('loadedmetadata', done);
      v.addEventListener('error', done);
      setTimeout(done, 8000);
    });
    if (!v.videoWidth) return;
    try {
      await rpc('asset.probe', {
        projectId: state.projectId,
        sessionId: state.sessionId,
        assetId: asset.id,
        probe: { duration: v.duration || 0, width: v.videoWidth, height: v.videoHeight, fps: null },
      });
      await refresh();
    } catch (e) {
      /* 探测失败不阻塞使用 */
    }
  }

  function firstFreeStart(trackId, want, dur) {
    const spans = clips
      .filter((c) => c.trackId === trackId)
      .map((c) => [c.start, c.start + c.duration])
      .sort((a, b) => a[0] - b[0]);
    let s = want;
    for (let pass = 0; pass < 4; pass += 1) {
      let moved = false;
      for (const [a, b] of spans) {
        if (s < b - 1e-6 && s + dur > a + 1e-6) {
          s = b;
          moved = true;
        }
      }
      if (!moved) break;
    }
    return Math.max(0, +s.toFixed(3));
  }

  async function insertAsset(asset) {
    // 视频轨只收视频/图片。音频走 insertAudio —— 这一道闸门是给
    // 「面板以外的入口」留的（快捷键、脚本、旧按钮），语义与按 kind 分流一致。
    if (insertPolicy(asset).trackKind === 'audio') return insertAudio(asset);
    const want = state.playhead || 0;
    const dur = Math.max(0.5, (asset.probe && asset.probe.duration) || 5);
    const start = firstFreeStart('v1', want, dur);
    await doOps(
      [
        {
          type: 'clip.insert',
          clipId: 'clip_' + Math.random().toString(36).slice(2, 8),
          trackId: 'v1',
          clipType: 'media',
          assetId: asset.id,
          start: +start.toFixed(3),
          duration: +dur.toFixed(3),
        },
      ],
      '插入素材',
    );
    if (doc && doc.duration < start + dur) {
      /* 时长由引擎重算，不需要手工维护 */
    }
  }

  /**
   * 音频素材只进音频轨（a1）。轨道不存在时先建一条，再按「不重叠」挑起点。
   *
   * 过去音频也会走 insertAsset，于是它被插进 v1：预览池不会为音频建 <video>
   * （videoWidth 永远是 0），就绪判定永远 pending，整帧被 hold 成黑屏 ——
   * 这就是「画面永远解不出」的那条回放。
   */
  async function insertAudio(asset) {
    const want = state.playhead || 0;
    const dur = Math.max(0.5, (asset.probe && asset.probe.duration) || 5);
    const target = resolveInsertTrack(state.doc, asset);
    const targetTrack = target.trackId || 'a1';
    const start = target.createTrack ? want : firstFreeStart(targetTrack, want, dur);
    const ops = [];
    if (target.createTrack) ops.push({ type: 'track.add', trackId: targetTrack, kind: 'audio', name: '音频' });
    await doOps(
      ops.concat([
        {
          type: 'clip.insert',
          clipId: 'aud_' + Math.random().toString(36).slice(2, 8),
          trackId: targetTrack,
          clipType: 'media',
          assetId: asset.id,
          start: +start.toFixed(3),
          duration: +dur.toFixed(3),
        },
      ]),
      '加入音频轨',
    );
    toast('已加入音频轨 ' + targetTrack);
  }

  const srtInputRef = React.useRef(null);

  async function importSrtFile(file) {
    const text = await file.text();
    const entries = parseSrt(text);
    if (!entries.length) return toast('这个 SRT 里没有可用字幕', 'warn');
    let n = 0;
    const ops = [];
    for (const e of entries) {
      n += 1;
      ops.push({
        type: 'clip.insert',
        clipId: 'srt_' + Date.now().toString(36) + '_' + n,
        trackId: 't1',
        clipType: 'text',
        start: e.start,
        duration: Math.max(0.2, +(e.end - e.start).toFixed(3)),
        text: e.text,
      });
    }
    await doOps(ops, '导入 SRT');
  }

  function exportSrt() {
    const srt = clipsToSrt(clips);
    if (!srt.trim()) return toast('没有字幕可导出', 'warn');
    const blob = new Blob([srt], { type: 'application/x-subrip;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (doc.title || 'captions') + '.srt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast('已导出 SRT');
  }

  async function insertPip(asset) {
    // 画中画也是视频轨入口：音频一律改走 a1，绝不进 v2。
    if (isAudioAsset(asset)) return insertAudio(asset);
    const want = state.playhead || 0;
    const dur = Math.max(0.5, (asset.probe && asset.probe.duration) || 5);
    const hasV2 = (state.doc && state.doc.tracks || []).some((t) => t.id === 'v2');
    const start = hasV2 ? firstFreeStart('v2', want, dur) : want;
    const ops = [];
    if (!hasV2) ops.push({ type: 'track.add', trackId: 'v2', kind: 'video', name: '画中画' });
    await doOps(
      ops.concat([
        {
          type: 'clip.insert',
          clipId: 'pip_' + Math.random().toString(36).slice(2, 8),
          trackId: 'v2',
          clipType: 'media',
          assetId: asset.id,
          start: +start.toFixed(3),
          duration: +dur.toFixed(3),
          transform: { x: -260, y: -120, scale: 0.35, rotation: 0, opacity: 1 },
        },
      ]),
      '加入画中画',
    );
  }

  // ---- 导出参数（面板内表单；webview 禁用 window.prompt，所以不用对话框）----

  /** 工程画幅（'16:9'）→ 像素；「跟随工程」时短边对齐 1080。 */
  function projectPixels() {
    const ratio = String((doc && doc.ratio) || '16:9');
    const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio);
    const rw = m ? Number(m[1]) : 16;
    const rh = m ? Number(m[2]) : 9;
    const shortSide = Math.min(rw, rh) || 9;
    const scale = 1080 / shortSide;
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    return { width: even(rw * scale), height: even(rh * scale) };
  }

  /** 表单 → 导出参数。非法组合在这里用中文拦下，不交给编码器变成「未知错误」。 */
  function paramsFromForm() {
    const total = Math.max(0.5, (doc && doc.duration) || 0);
    const project = projectPixels();
    const size =
      exportForm.resolution === '1080'
        ? { width: 1920, height: 1080 }
        : exportForm.resolution === '720'
          ? { width: 1280, height: 720 }
          : project;
    // 导出帧率独立于工程帧率：'project' 才跟随，其余按表单上的数字走。
    // 时间线是纯时间驱动的，采样密度只决定重复/抽掉多少帧，不改变时长与音频。
    const projectFps = (doc && doc.fps) || 30;
    const fps = exportForm.fps === 'project' ? projectFps : Number(exportForm.fps);
    if (!Number.isFinite(fps) || fps <= 0) {
      throw Object.assign(new Error('导出帧率必须是大于 0 的数字'), { code: 'INVALID_ARG' });
    }
    if (fps > 120) {
      throw Object.assign(new Error('导出帧率不能超过 120fps'), { code: 'INVALID_ARG' });
    }
    const bitrateKbps =
      exportForm.bitrate === '4' ? 4000 : exportForm.bitrate === '8' ? 8000 : exportForm.bitrate === '16' ? 16000 : null;
    let range = null;
    if (exportForm.range === 'playhead') {
      const start = Math.min(Math.max(0, state.playhead || 0), total);
      if (total - start < 1 / fps) {
        throw Object.assign(new Error('播放头已经到片尾，没有可导出的内容'), { code: 'INVALID_ARG' });
      }
      range = { start: +start.toFixed(3), end: +total.toFixed(3) };
    }
    return { width: size.width, height: size.height, fps, projectFps, bitrateKbps, range, total };
  }

  /**
   * 探测编码能力（异步、不阻塞表单）。失败不抛给用户，只记下来等导出时说明。
   *
   * 每次打开表单都重新探，但**必须有上限**：驱动/GPU 在忙的时候
   * isConfigSupported 可能挂很久，那会把「打开表单」变成「卡住」。
   * 超时就如实说「探测超时，导出时再定」，而不是让表单转圈。
   */
  async function loadCaps() {
    setCapsBusy(true);
    setCapsError(null);
    setCapsTimedOut(false);
    let timer = null;
    try {
      const capsOrTimeout = await Promise.race([
        probeEncoders().then((value) => ({ value })),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ timeout: true }), CAPS_TIMEOUT_MS);
        }),
      ]);
      if (capsOrTimeout.timeout) {
        setCaps(null);
        setCapsTimedOut(true);
      } else {
        setCaps(capsOrTimeout.value);
      }
    } catch (e) {
      setCaps(null);
      setCapsError((e && e.message) || '编码能力检测失败');
    } finally {
      if (timer) clearTimeout(timer);
      setCapsBusy(false);
    }
  }

  /** 表单当前选的分辨率 / 帧率（不抛错，只用于「将导出」那一行的参数显示）。 */
  function formPixels() {
    if (exportForm.resolution === '1080') return { width: 1920, height: 1080 };
    if (exportForm.resolution === '720') return { width: 1280, height: 720 };
    return projectPixels();
  }

  function formFps() {
    const projectFps = (doc && doc.fps) || 30;
    const fps = exportForm.fps === 'project' ? projectFps : Number(exportForm.fps);
    return Number.isFinite(fps) && fps > 0 ? fps : projectFps;
  }

  /**
   * 「将导出：1920×1080 · 30fps · MP4 / HEVC / AAC（本机不支持 H.264，已自动改用 HEVC）」
   *
   * 参数与编码器写在同一行，用户一眼能确认「我要的」和「本机真会用的」是不是一回事。
   * 编码器/容器/音频三样都来自 probeEncoders 的实测结论，绝不写死。
   */
  function formatPlanLine(plan) {
    const size = formPixels();
    const detail = describePlan(plan).replace(/^将导出：\s*/, '');
    return `将导出：${size.width}×${size.height} · ${formFps()}fps · ${detail}`;
  }

  /**
   * 表单顶部那一行：这次到底会导出什么格式。
   * blocked=true 时（NO_ENCODER）导出按钮必须禁用 —— 不要让用户等到 90% 才看见失败。
   */
  function exportPreview() {
    const size = formPixels();
    const params = `${size.width}×${size.height} · ${formFps()}fps`;
    if (capsBusy) return { text: `正在检测编码能力…（${params}）`, tone: 'muted', plan: null, blocked: false };
    if (capsTimedOut) {
      return {
        text: `将导出：${params} · 格式待定（探测超时，导出时再定）`,
        tone: 'warn',
        plan: null,
        blocked: false,
      };
    }
    if (capsError) {
      return {
        text: `编码能力检测失败：${capsError}；将导出 ${params}，格式在导出时再定`,
        tone: 'warn',
        plan: null,
        blocked: false,
      };
    }
    if (!caps) return { text: `正在检测编码能力…（${params}）`, tone: 'muted', plan: null, blocked: false };
    try {
      const plan = chooseExportPlan(caps);
      return { text: formatPlanLine(plan), tone: plan.audioCodec ? 'info' : 'warn', plan, blocked: false };
    } catch (e) {
      return {
        text:
          '这台机器没有可用编码器：H.264 / HEVC / VP9 / AV1 实测都不可用，导出会被拒绝。' +
          (e && e.message ? '（' + e.message + '）' : ''),
        tone: 'error',
        plan: null,
        blocked: true,
      };
    }
  }

  /** 顶栏/检查器都先开表单，再由表单的「开始导出」真正动手。 */
  function openExport() {
    if (!doc) return;
    // 检查器的帧率选择带进表单：用户在检查器里选了 60fps，打开表单时不能又悄悄回到「跟随工程」。
    // 等于工程帧率时仍显示「跟随工程」，语义更清楚。
    setExportForm((prev) => {
      const projectFps = (doc && doc.fps) || 30;
      const chosen = Number(exportSettings.fps);
      const next = Number.isFinite(chosen) && chosen > 0 && chosen !== projectFps ? String(chosen) : 'project';
      return prev.fps === next ? prev : { ...prev, fps: next };
    });
    setExportOpen(true);
    // 每次打开都重新探：显卡/标签页状态会变，用上一次的结论等于在猜
    if (!capsBusy) void loadCaps();
  }

  function startExportFromForm() {
    const preview = exportPreview();
    if (preview.blocked) return toast(preview.text, 'warn');
    if (capsBusy) return toast('正在检测编码能力，稍等一下', 'warn');
    let params;
    try {
      params = paramsFromForm();
    } catch (e) {
      return toast((e && e.message) || '导出参数不合法', 'warn');
    }
    // 把表单上写的那份格式承诺原样交给导出端：说到做到，导出端不再二次猜
    if (preview.plan) params.plan = preview.plan;
    else if (caps) params.caps = caps;
    setExportOpen(false);
    void exportMp4(params);
  }

  async function exportMp4(params) {
    if (!doc) return;
    // 参数缺省时退回检查器里的导出设置（整片、自动码率），保证老入口仍然能用
    const p =
      params || {
        width: exportSettings.width,
        height: exportSettings.height,
        fps: exportSettings.fps,
        bitrateKbps: null,
        range: null,
        total: Math.max(0.5, doc.duration),
      };
    let mod;
    try {
      mod = await import('./exporter.js');
    } catch (e) {
      return reportError(e, '导出模块不可用');
    }
    setState({ busy: { label: '导出中', ratio: 0, detail: '混音' } });
    let audioBuffer = null;
    if (audioRef.current) {
      try {
        // 混整条时间线；range 的裁剪交给 exporter（它知道采样偏移），这里不切
        audioBuffer = await audioRef.current.mixdown({
          duration: Math.max(0.5, p.total),
          sampleRate: 48000,
        });
      } catch {
        audioBuffer = null;
      }
    }
    setState({ busy: { label: '导出中', ratio: 0, detail: '编码' } });
    // 字体闸门：导出是逐帧跑完就封装，绝不能「前几帧用 fallback 字体」。
    // 与预览调同一个函数（player.ensureFontsReady），只是这里要等它结束。
    // 超时不阻断导出 —— 只把「这次可能用了替代字体」如实说出来。
    const exportTextLayers = (clips || [])
      .filter((c) => c && c.type === 'text')
      .map((c) => ({ kind: 'text', clip: c }));
    let fontsTimedOut = false;
    try {
      const fonts = await prepareFonts({ height: p.height, layers: exportTextLayers, timeoutMs: 2500 });
      fontsTimedOut = !!(fonts && fonts.timedOut);
    } catch {
      fontsTimedOut = false;
    }
    try {
      const result = await mod.exportTimeline({
        title: doc.title,
        audioBuffer,
        plan: p.plan || undefined,
        caps: p.plan ? undefined : p.caps || caps || undefined,
        duration: Math.max(0.5, p.total),
        projectFps: p.projectFps == null ? (doc && doc.fps) || p.fps : p.projectFps,
        fps: p.fps,
        width: p.width,
        height: p.height,
        bitrateKbps: p.bitrateKbps == null ? undefined : p.bitrateKbps,
        range: p.range || undefined,
        drawFrame: async (c, t, w, hh) => {
          // 导出和预览走同一份图层清单 + 同一个 drawFrame：转场与变速不可能不一致
          const layers = player.frameLayers(clips, t);
          if (codeRef.current) {
            try {
              await codeRef.current.renderLayers(layers);
            } catch (e) {
              /* 单帧失败不终止导出 */
            }
          }
          player.drawFrame(c, {
            clips,
            assets,
            t,
            width: w,
            height: hh,
            layers,
            codeCanvas: codeRef.current ? (clip) => codeRef.current.canvasFor(clip) : null,
          });
        },
        onProgress: (p2) => {
          const label = p2.phase === 'audio' ? '混音中' : p2.phase === 'encode' ? '编码中' : p2.phase === 'finalize' ? '封装中' : '准备中';
          setState({ busy: { label: '导出 · ' + label, ratio: p2.ratio, detail: label } });
        },
      });
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      // 成片回填：把字节也送进工程 exports/ 并登记进 project.exports[]。
      // 失败只提示、不影响用户已经拿到的那份文件 —— 但 agent 会在 video_export_scan
      // 里看到它并提示收养，不会再出现「片子在外面、工程在里面」。
      let savedToProject = false;
      try {
        // fps 与 sourceFps 一起回填：事后查 exports[] 就能确认「30fps 工程按 60fps 导出」。
        const query =
          '/api/video/export?projectId=' + encodeURIComponent(doc.projectId) +
          '&sessionId=' + encodeURIComponent((state && state.sessionId) || '') +
          '&name=' + encodeURIComponent(result.fileName) +
          '&duration=' + encodeURIComponent(String(result.duration == null ? Math.max(0.5, p.total) : result.duration)) +
          '&fps=' + encodeURIComponent(String(result.fps == null ? p.fps : result.fps)) +
          '&sourceFps=' + encodeURIComponent(String(result.sourceFps == null ? p.projectFps : result.sourceFps));
        const res = await fetch(query, { method: 'POST', body: result.blob });
        const payload = await res.json().catch(() => null);
        savedToProject = Boolean(payload && payload.ok);
      } catch (e) {
        savedToProject = false;
      }
      // 回退链换了编码器是信息，不是错误：照实说「计划什么、实际用了什么」。
      const fallbackNote = result.encoderFallback && result.encoderFallback.note
        ? '；' + result.encoderFallback.note
        : '';
      const fontNote = fontsTimedOut ? '；字体就绪超时，可能有镜头用了替代字体' : '';
      toast(
        '已导出 ' + result.fileName + '（' + result.container + ' · ' + p.width + '×' + p.height + ' · ' +
          (result.fps == null ? p.fps : result.fps) + 'fps' +
          (result.sourceFps != null && result.sourceFps !== result.fps ? '（工程 ' + result.sourceFps + 'fps）' : '') +
          (result.audioCodec ? ' · ' + result.audioCodec : ' · 无音轨') + '）' + fallbackNote + fontNote +
          (savedToProject ? '，已登记进工程 exports/' : '，但没能登记进工程（用 video_export_scan 可发现并收养）'),
      );
    } catch (e) {
      reportError(e, '导出失败');
    } finally {
      setState({ busy: null });
    }
  }

  // ---- 面板内输入行：＋文字 / ＋标注（替代被 webview 禁用的 window.prompt）----
  const composerInput = {
    flex: 1,
    minWidth: 0,
    padding: '5px 8px',
    borderRadius: 6,
    border: `1px solid ${T.border}`,
    background: T.fill,
    color: T.text,
    fontSize: 12,
    fontFamily: 'inherit',
  };
  const composerRow = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    borderBottom: `1px solid ${T.border}`,
    background: T.fill,
    fontSize: 12,
    flex: '0 0 auto',
  };
  const miniBtn = (label, onClick, extra) =>
    btn(label, onClick, Object.assign({ fontSize: 11, padding: '3px 8px' }, extra || {}));
  const rangeText = (range) =>
    !range
      ? ''
      : Math.abs(range.end - range.start) < 1e-9
        ? `${fmtTime(range.start)}（当前帧）`
        : `${fmtTime(range.start)} → ${fmtTime(range.end)}`;

  // 导出表单的一行：标签 + 下拉。webview 里没有 prompt，参数只能在面板里选。
  const exportRow = (label, value, onChange, options) =>
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
      h('span', { style: { width: 48, flex: '0 0 auto', opacity: 0.7 } }, label),
      h(
        'select',
        {
          value,
          onChange: (e) => onChange(e.target.value),
          style: Object.assign({}, composerInput, { flex: 1, minWidth: 0, padding: '4px 6px' }),
        },
        options.map(([v, text]) => h('option', { key: v, value: v }, text)),
      ),
    );

  function renderComposer() {
    if (textOpen) {
      return h('div', { style: composerRow },
        h('span', { style: { opacity: 0.75, flex: '0 0 auto' } }, '＋文字'),
        h('input', {
          autoFocus: true,
          value: textValue,
          placeholder: '输入字幕文字，回车插入 3 秒',
          onChange: (e) => setTextValue(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitText();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setTextOpen(false);
              setTextValue('');
            }
          },
          style: composerInput,
        }),
        miniBtn('确认', commitText),
        miniBtn('取消', () => { setTextOpen(false); setTextValue(''); }),
        h('span', { style: { opacity: 0.45, flex: '0 0 auto', fontSize: 11 } }, '位置 ' + fmtTime(state.playhead)),
      );
    }
    if (!annot) return null;
    if (annot.step === 'pick') {
      return h('div', { style: composerRow },
        h('span', { style: { opacity: 0.75, flex: '0 0 auto' } }, '＋标注'),
        miniBtn('① 标记当前帧', () =>
          setAnnot({ step: 'note', a: null, range: frameRange(state.playhead), intent: annot.intent || 'change', value: annot.value || '' })),
        h('span', { style: { opacity: 0.45 } }, '或'),
        miniBtn('② 从 A 到 B 标记', () =>
          setAnnot({ step: 'span', a: +state.playhead.toFixed(3), range: null, intent: annot.intent || 'change', value: annot.value || '' })),
        miniBtn('取消', () => setAnnot(null)),
        h('span', { style: { opacity: 0.45, fontSize: 11 } }, '播放头 ' + fmtTime(state.playhead)),
      );
    }
    if (annot.step === 'span') {
      return h('div', { style: composerRow },
        h('span', { style: { opacity: 0.75 } }, 'B ≥ A'),
        h('span', null, 'A = ' + fmtTime(annot.a)),
        miniBtn('在播放头 ' + fmtTime(state.playhead) + ' 记 B', () => {
          if (state.playhead < annot.a - 1e-6) {
            return toast(`B 必须不小于 A（A=${fmtTime(annot.a)}，B=${fmtTime(state.playhead)}）`, 'warn');
          }
          try {
            setAnnot({ ...annot, step: 'note', range: spanRange(annot.a, state.playhead) });
          } catch (e) {
            toast((e && e.message) || '区间非法', 'warn');
          }
        }),
        miniBtn('重记 A', () => setAnnot({ ...annot, a: +state.playhead.toFixed(3) })),
        miniBtn('取消', () => setAnnot(null)),
      );
    }
    return h('div', { style: Object.assign({}, composerRow, { alignItems: 'flex-start', flexWrap: 'wrap' }) },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '0 0 132px' } },
        h('span', { style: { fontSize: 11, opacity: 0.7 } }, rangeText(annot.range)),
        h('select', {
          value: annot.intent || 'change',
          onChange: (e) => setAnnot({ ...annot, intent: e.target.value, error: null }),
          style: Object.assign({}, composerInput, { flex: '0 0 auto', width: '100%' }),
        }, ANNOTATION_INTENTS.map((id) => h('option', { key: id, value: id }, `${id}（${INTENT_LABELS[id]}）`))),
      ),
      h('textarea', {
        autoFocus: true,
        rows: 2,
        value: annot.value || '',
        placeholder: '告诉 agent 这里要改什么（多行可以，Ctrl+Enter 提交）',
        onChange: (e) => setAnnot({ ...annot, value: e.target.value, error: null }),
        onKeyDown: (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            commitAnnotation();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setAnnot(null);
          }
        },
        style: Object.assign({}, composerInput, { resize: 'vertical', minHeight: 46, lineHeight: 1.5 }),
      }),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        miniBtn('确认', commitAnnotation),
        miniBtn('取消', () => setAnnot(null)),
      ),
      // 失败必须写在提交处：草稿还在、红字还在，用户不用去别处找原因。
      annot.error
        ? h('div', { style: { flexBasis: '100%', marginTop: 4, fontSize: 11, color: T.danger, lineHeight: 1.5 } },
            '新增标注失败：' + annot.error + '（草稿已保留，改完再确认）')
        : null,
    );
  }

  const composerBar = doc ? renderComposer() : null;

  const myProjects = mergeSessionProjects(doc, s.mine, state.sessionId);

  const header = h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 14px',
        borderBottom: `1px solid ${T.border}`,
        minHeight: 48,
        background: `linear-gradient(180deg, ${T.fill}, transparent)`,
      },
    },
    doc && renaming
      ? h('input', {
          autoFocus: true,
          value: renameValue,
          maxLength: 60,
          onChange: (e) => setRenameValue(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setRenaming(false);
              setRenameValue('');
            }
          },
          style: {
            padding: '4px 8px',
            borderRadius: 6,
            border: `1px solid ${T.accent}`,
            background: T.fill,
            color: T.text,
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'inherit',
            minWidth: 180,
          },
        })
      : h(
          'strong',
          {
            onClick: doc
              ? () => {
                  setRenameValue(doc.title || '');
                  setRenaming(true);
                }
              : undefined,
            title: doc ? '点击重命名' : undefined,
            style: {
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: 0.2,
              cursor: doc ? 'pointer' : 'default',
              borderBottom: doc ? `1px dashed ${T.borderStrong}` : 'none',
            },
          },
          doc ? doc.title : '视频工作台',
        ),
    doc && renaming ? btn('确认', commitRename, { fontSize: 11, padding: '3px 8px' }) : null,
    doc && renaming ? btn('取消', () => { setRenaming(false); setRenameValue(''); }, { fontSize: 11, padding: '3px 8px' }) : null,
    doc ? h('span', { style: { fontSize: 11, opacity: 0.6 } }, `r${doc.revision} · ${doc.duration.toFixed(2)}s · ${doc.fps}fps · ${doc.ratio}`) : null,
    h('div', { style: { flex: 1 } }),
    state.error ? h('span', { style: { fontSize: 11, color: T.danger } }, state.error) : null,
    doc ? btn(state.playing ? '暂停' : '播放', togglePlayback) : btn('新建工程', createProject),
    doc
      ? btn('切换', () => setSwitchOpen((v) => !v), switchOpen
          ? { borderColor: T.accent, color: T.accent }
          : null)
      : null,
    doc ? btn('停止', () => stopProject(), { color: T.danger, borderColor: T.danger }) : null,
    btn('撤销', undoLast, undoInfo.undo.length
      ? { borderColor: T.warn, color: T.warn, background: T.warnDim }
      : { opacity: 0.5 }),
    btn('重做', redoLast, undoInfo.redo.length
      ? { borderColor: T.accent, color: T.accent, background: T.accentDim }
      : { opacity: 0.5 }),
    btn('＋文字', () => {
      setAnnot(null);
      setTextOpen((v) => !v);
    }, textOpen ? { borderColor: T.accent, color: T.accent } : null),
    btn('＋标注', () => {
      setTextOpen(false);
      setAnnot((cur) => (cur ? null : { step: 'pick', a: null, range: null, intent: 'change', value: '' }));
    }, annot ? { borderColor: T.accent, color: T.accent } : null),
    btn('全部提交', submitAnnotations),
    btn('导入字幕(.srt)', () => srtInputRef.current && srtInputRef.current.click()),
    btn('导出字幕(.srt)', exportSrt),
    h('input', {
      ref: srtInputRef,
      type: 'file',
      accept: '.srt,text/plain',
      style: { display: 'none' },
      onChange: (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) importSrtFile(f).catch((err) => reportError(err, '导入 SRT 失败'));
        e.target.value = '';
      },
    }),
    btn(showLog ? '收起记录' : '操作记录', () => setShowLog((v) => !v)),
    btn('诊断', runDiag),
    btn('导出 MP4', openExport, {
      background: T.primary,
      border: `1px solid ${T.primary}`,
      color: T.onPrimary,
      fontWeight: 600,
    }),
    btn('回到对话', () => ctxRef && ctxRef.layout.selectPanel(null)),
  );

  // 没有 doc、或者还没「进入」：只给选择面板。
  // 重启后即使工程仍在 enabled 里，active 也是 false —— 绝不自动挂载。
  if (!doc || !active) {
    return h(
      'div',
      {
        ref: rootRef,
        style: Object.assign(
          {},
          player.layoutStyles({
            height: panelHeight ? panelHeight + 'px' : '100%',
            maxHeight: panelHeight ? panelHeight + 'px' : '100%',
          }).root,
          { background: T.bg },
        ),
      },
      h(SelectionPanel, {
        sessionId: state.sessionId,
        projects: s.mine,
        doc,
        enabled: s.enabled,
        max: s.max,
        busy: s.busy,
        error: state.error,
        onNew: createProject,
        onEnter: (project) => enterProject(project),
        onEnable: async (project) => {
          try {
            await enableProject(project.projectId, project.root);
            await loadMyProjects().catch(() => []);
            toast('已启用「' + (project.title || project.projectId) + '」');
          } catch (e) {
            reportError(e, '启用失败');
          }
        },
        onDisable: (project) => stopProject(project),
        onRename: (projectId, title) => renameTo(projectId, title),
      }),
      h(ProgressOverlay, { busy: s.busy }),
      s.toast
        ? h('div', {
            style: {
              position: 'absolute',
              bottom: 14,
              left: '50%',
              transform: 'translateX(-50%)',
              padding: '6px 12px',
              borderRadius: 8,
              background: T.panel,
              border: `1px solid ${T.border}`,
              fontSize: 12,
              color: T.text,
            },
          }, s.toast.message)
        : null,
    );
  }

  // 「切换」下拉：只列本会话的工程（绑定表本身仍是 1:1）。
  const switchMenu =
    switchOpen && doc
      ? h(
          'div',
          {
            style: {
              position: 'absolute',
              top: 48,
              left: 180,
              width: 300,
              maxHeight: 280,
              overflow: 'auto',
              zIndex: 28,
              padding: 8,
              borderRadius: 10,
              border: `1px solid ${T.border}`,
              background: T.panel,
              boxShadow: T.shadow,
              fontSize: 12,
            },
          },
          h('div', { style: { opacity: 0.55, marginBottom: 6 } }, '切换到本会话的工程'),
          myProjects.map((p) =>
            h(
              'div',
              {
                key: p.projectId,
                onClick: () => switchTo(p),
                style: {
                  cursor: 'pointer',
                  padding: '6px 8px',
                  borderRadius: 6,
                  background: p.projectId === state.projectId ? T.accentDim : 'transparent',
                },
              },
              h('div', null, (p.title || '未命名工程') + (p.projectId === state.projectId ? '（当前）' : '')),
              h('div', { style: { fontSize: 10, opacity: 0.45, wordBreak: 'break-all' } }, p.root || ''),
            ),
          ),
          myProjects.length < 2
            ? h('div', { style: { fontSize: 11, opacity: 0.45, marginTop: 6, lineHeight: 1.6 } }, '本会话只有这一个工程。新建之后才会出现在这里。')
            : null,
        )
      : null;

  // 预览角标只显示一条：seek 诊断优先，其次是媒体诊断（含「音频不该在视频轨」）。
  // 这段文字只存在于 DOM overlay —— 合成帧里没有它（无头采样/导出因此不再带字）。
  const previewNotice = (seekDiag && seekDiag[0]) || (mediaIssue && mediaIssue[0]) || null;
  const previewNoticeIsMedia = !(seekDiag && seekDiag[0]) && !!(mediaIssue && mediaIssue[0]);

  return h(
    'div',
    {
      ref: rootRef,
      style: Object.assign(
        {},
        player.layoutStyles({
          height: panelHeight ? panelHeight + 'px' : '100%',
          maxHeight: panelHeight ? panelHeight + 'px' : '100%',
        }).root,
        {
          background: T.bg,
          fontFamily: T.font,
        },
      ),
    },
    header,
    switchMenu,
    h(
      'div',
      { style: Object.assign({}, player.layoutStyles().row) },
      h('div', { style: Object.assign({}, player.layoutStyles().mediaBin, { borderRight: `1px solid ${T.border}` }) },
        h(MotionLibrary, {
          onInsertMotion: async (item) => {
            try {
              await rpc('motion.insert', {
                projectId: state.projectId,
                sessionId: state.sessionId,
                entryId: item.id,
                start: state.playhead || 0,
                duration: 3,
              });
              await refresh();
              toast('已插入动效：' + (item.title || item.id));
            } catch (e) {
              reportError(e, '插入动效失败');
            }
          },
        }),
        h(SoundLibrary, {
          projectId: state.projectId,
          sessionId: state.sessionId,
          playhead: state.playhead,
        }),
        h(MediaBin, {
          assets,
          onInsert: (a) => insertAsset(a),
          onInsertPip: (a) => insertPip(a),
          onInsertAudio: (a) => insertAudio(a),
          onImported: async () => {
            const n = await syncAssetsFromDisk().catch(() => 0);
            await refresh();
            if (n) toast('已登记 ' + n + ' 个已有素材');
          },
        })),
      h(
        'div',
        { style: Object.assign({}, player.layoutStyles().main) },
        (doc.clipCount || 0) === 0 && clips.length === 0 ? h(TemplateBar, { projectId: state.projectId, sessionId: state.sessionId }) : null,
        // 脏数据提示：音频被放在视频轨上（打开工程时就有；修复/撤销后自动消失）。
        // 只提示 + 一键修复，不阻塞预览 —— 渲染器本来就跳过音频。
        audioIssues && audioIssues.count
          ? h(
              'div',
              {
                'data-testid': 'audio-track-banner',
                style: {
                  flex: '0 0 auto',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '6px 10px',
                  borderBottom: `1px solid ${T.warn}`,
                  background: T.warnDim,
                  color: T.warn,
                  fontSize: 11,
                  lineHeight: 1.55,
                },
              },
              h(
                'div',
                { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontWeight: 600 } }, `发现 ${audioIssues.count} 个音频素材在视频轨上`),
                h('div', { style: { opacity: 0.8 } }, audioIssues.human),
                h(
                  'div',
                  { style: { opacity: 0.6, wordBreak: 'break-all' } },
                  (audioIssues.issues || [])
                    .slice(0, 4)
                    .map((i) => `${i.assetName}（${i.trackName}）`)
                    .join('、') + (audioIssues.count > 4 ? ` 等 ${audioIssues.count} 个` : ''),
                ),
              ),
              h(
                'div',
                { style: { flex: '0 0 auto' } },
                btn('一键移到音频轨', repairAudioTracks, { fontSize: 11, padding: '3px 8px' }),
              ),
            )
          : null,
        h('div', { style: Object.assign({}, player.layoutStyles().preview) },
          h(PlayerCanvas, {
            clips,
            assets,
            playing: s.playing,
            playhead: s.playhead,
            code: codeRef.current,
            engineRef: playbackRef,
            onTime: (t) => setState({ playhead: t }),
            onMediaState,
            onDiagnostic: (list) => setSeekDiag(list || []),
            getAudio: () => audioRef.current,
          }),
          // 这一帧为什么没画出来 / 音频为什么不在画面里 —— 只画在 DOM overlay 上。
          // 合成画布（导出、无头采样）里一个提示字都不会出现。
          previewNotice
            ? h(
                'div',
                {
                  'data-testid': 'preview-notice',
                  style: {
                    position: 'absolute',
                    left: 8,
                    bottom: 8,
                    maxWidth: '72%',
                    padding: '4px 8px',
                    borderRadius: 6,
                    border: `1px solid ${previewNotice.blocker ? T.danger : T.warn}`,
                    background: previewNotice.blocker ? T.dangerDim : T.warnDim,
                    color: previewNotice.blocker ? T.danger : T.warn,
                    fontSize: 11,
                    lineHeight: 1.5,
                    pointerEvents: previewNoticeIsMedia ? 'auto' : 'none',
                  },
                },
                h('div', { style: { fontWeight: 600 } }, previewNotice.title || '这一帧没就绪'),
                previewNotice.detail ? h('div', { style: { opacity: 0.75 } }, previewNotice.detail) : null,
                previewNotice.hint ? h('div', { style: { opacity: 0.8 } }, previewNotice.hint) : null,
                previewNoticeIsMedia && previewNotice.code !== 'audio-asset'
                  ? h(
                      'div',
                      { style: { marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 } },
                      mediaIssue.length > 1 ? h('span', { style: { opacity: 0.55 } }, '+' + (mediaIssue.length - 1)) : null,
                      btn('重新加载', () => retryMedia(mediaIssue[0].assetId), { fontSize: 11, padding: '3px 8px' }),
                      h('span', { style: { opacity: 0.45 } }, '或按 R'),
                    )
                  : null,
              )
            : null,
        ),
        composerBar,
        h('div', { style: Object.assign({}, player.layoutStyles().timeline, { borderTop: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column' }) },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', fontSize: 11, opacity: 0.7 } },
            h('span', null, fmtTime(state.playhead)),
            h('input', {
              type: 'range',
              min: 0,
              max: Math.max(1, doc.duration),
              step: 0.01,
              value: state.playhead,
              // 拖动中降级（节流、不黑屏），松手时必须落到准确的一帧
              onChange: (e) => seekTo(+e.target.value, { scrub: true }),
              onPointerUp: (e) => seekTo(+e.target.value, { force: true }),
              onKeyUp: (e) => seekTo(+e.target.value, { force: true }),
              onBlur: (e) => seekTo(+e.target.value, { force: true }),
              style: { flex: 1 },
            }),
            h('span', null, '缩放'),
            h('input', {
              type: 'range',
              min: 10,
              max: 200,
              value: state.zoom,
              onChange: (e) => setState({ zoom: +e.target.value }),
              style: { width: 90 },
            }),
          ),
          h('div', { style: { flex: 1, minHeight: 0, paddingBottom: 6 } },
            h(Timeline, {
              doc,
              clips,
              annotations: doc.annotations || [],
              playhead: state.playhead,
              zoom: state.zoom,
              selection: state.selection,
              flash: state.flash,
              assets,
              onSeek: seekTo,
              onSelect: (sel) => setState({ selection: sel }),
              onOps: (ops, summary) => doOps(ops, summary),
            }),
          ),
        ),
      ),
      h('div', { style: Object.assign({}, player.layoutStyles().inspector, { borderLeft: `1px solid ${T.border}` }) },
        h(Inspector, {
          doc,
          selection: state.selection,
          clips,
          annotations: doc.annotations || [],
          analysis,
          playhead: state.playhead,
          onOps: (ops, summary) => doOps(ops, summary),
          onSplit: (clip) => {
            const at = +(state.playhead - clip.start).toFixed(3);
            if (at <= 0 || at >= clip.duration) return toast('播放头不在片段内部', 'warn');
            doOps([{ type: 'clip.split', clipId: clip.id, at, rightClipId: clip.id + '_' + Math.random().toString(36).slice(2, 5) }], '分割片段');
          },
          onDelete: (clip) => doOps([{ type: 'clip.delete', clipId: clip.id }], '删除片段'),
          onExport: openExport,
          exportSettings,
          onExportSettings: (patch) => setExportSettings(Object.assign({}, exportSettings, patch)),
          onDeleteProject: removeProject,
          // 标注四件事：选中 / 跳转 / 改造 / 删除。删除带二次确认（在面板里内联完成）。
          onAnnotationSelect: selectAnnotation,
          onAnnotationJump: jumpAnnotation,
          onAnnotationPatch: patchAnnotation,
          onAnnotationDelete: deleteAnnotation,
          onAnnotationUpdate: (a, op) =>
            patchAnnotation(a, {
              expected: op.expected,
              intent: op.intent,
              range: op.range,
              status: op.status,
            }),
        })),
    ),
    showLog
      ? h(
          'div',
          {
            style: {
              position: 'absolute',
              top: 48,
              right: 12,
              width: 380,
              maxHeight: 320,
              overflow: 'auto',
              zIndex: 25,
              padding: 10,
              borderRadius: 10,
              border: `1px solid ${T.border}`,
              background: T.panel,
              boxShadow: T.shadow,
              fontSize: 12,
            },
          },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '最近操作（Agent 与你共用一条记录）'),
          (s.history || []).length === 0
            ? h('div', { style: { opacity: 0.55 } }, '还没有操作。')
            : (s.history || []).map((item, i) =>
                h(
                  'div',
                  {
                    key: i,
                    onClick: () => {
                      const tx = item.transactionId;
                      if (!tx) return;
                      rpc('edit.undo', { projectId: state.projectId, sessionId: state.sessionId, transactionId: tx })
                        .then((r) => { toast('已撤销：' + (r.summary || '这一步') + '（r' + r.revision + '）'); refresh(); })
                        .catch((e) => reportError(e, '撤销失败'));
                    },
                    title: '点击撤销这一步（只有最近一步能撤销）',
                    style: { cursor: 'pointer',
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                      padding: '5px 0',
                      borderTop: i ? `1px solid ${T.borderFaint}` : 'none',
                    },
                  },
                  h(
                    'span',
                    {
                      style: {
                        flex: '0 0 auto',
                        fontSize: 10,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: item.origin === 'agent' ? T.accentDim : T.fill,
                        color: item.origin === 'agent' ? T.accent : T.textDim,
                      },
                    },
                    item.origin === 'agent' ? 'Agent' : '你',
                  ),
                  h('span', { style: { lineHeight: 1.5, opacity: 0.85 } }, item.human),
                ),
              ),
        )
      : null,
    diag
      ? h(
          'div',
          {
            style: {
              position: 'absolute',
              top: 48,
              left: 12,
              width: 260,
              zIndex: 26,
              padding: 10,
              borderRadius: 10,
              border: `1px solid ${T.border}`,
              background: T.panel,
              boxShadow: T.shadow,
              fontSize: 12,
              lineHeight: 1.7,
            },
          },
          h('div', { style: { fontWeight: 600, marginBottom: 6, display: 'flex' } },
            h('span', { style: { flex: 1 } }, '能力检测'),
            h('span', { style: { cursor: 'pointer', opacity: 0.6 }, onClick: () => setDiag(null) }, '✕'),
          ),
          [
            ['安全上下文', diag.secureContext],
            ['WebGPU', diag.webgpu],
            ['GPU', diag.gpuVendor],
            ['VideoDecoder', diag.videoDecoder],
            ['VideoEncoder', diag.videoEncoder],
            ['H.264 编码', diag.h264],
            ['HEVC 编码', diag.hevc],
            ['VP9 编码', diag.vp9],
            ['AV1 编码', diag.av1],
            ['AAC 编码', diag.aac],
            ['Opus 编码', diag.opus],
          ].map(([label, value]) =>
            h(
              'div',
              { key: label, style: { display: 'flex', gap: 8 } },
              h('span', { style: { width: 96, opacity: 0.65 } }, label),
              h('span', null, value === true ? '✅' : value === false ? '❌' : String(value == null ? '—' : value)),
            ),
          ),
          h('div', { style: { marginTop: 8, fontSize: 11, opacity: 0.5 } }, 'AAC ❌ 时导出会退 WebM 或无音轨。'),
        )
      : null,
    exported
      ? h(
          'div',
          {
            style: {
              position: 'absolute',
              top: 48,
              right: 12,
              width: 430,
              maxHeight: '60%',
              overflow: 'auto',
              zIndex: 27,
              padding: 10,
              borderRadius: 10,
              border: `1px solid ${T.border}`,
              background: T.panel,
              boxShadow: T.shadow,
              fontSize: 12,
            },
          },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
            h('strong', { style: { flex: 1 } }, '标注清单 · ' + exported.count + ' 条'),
            h('span', { style: { cursor: 'pointer', opacity: 0.6 }, onClick: () => setExported(null) }, '✕'),
          ),
          h('div', { style: { fontSize: 11, opacity: 0.55, marginBottom: 8, lineHeight: 1.6 } },
            '这段文本已按位置 + 类型 + 批注整理好；复制后粘给 agent。面板没有「直接发进对话」的接口。'),
          exported.items && exported.items.length
            ? h('div', { style: { marginBottom: 8 } },
                exported.items.map((item, i) =>
                  h('div', { key: item.id || i, style: { padding: '3px 0', borderTop: i ? `1px solid ${T.borderFaint}` : 'none' } },
                    h('span', { style: { opacity: 0.7 } }, formatAnnotation(item) + ' · ' + (item.intent || 'change')),
                    item.expected
                      ? h('div', { style: { opacity: 0.55, fontSize: 11, whiteSpace: 'pre-wrap', lineHeight: 1.5 } }, item.expected)
                      : null,
                  ),
                ),
              )
            : null,
          h('textarea', {
            readOnly: true,
            value: exported.text,
            rows: 12,
            style: Object.assign({}, composerInput, { width: '100%', resize: 'vertical', fontFamily: 'ui-monospace, monospace', lineHeight: 1.5 }),
          }),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
            miniBtn('再复制一次', () => {
              copyText(exported.text).then((ok) => toast(ok ? '已复制 ' + exported.count + ' 条标注' : '复制失败：剪贴板不可用', ok ? 'info' : 'warn'));
            }),
            miniBtn('关闭', () => setExported(null)),
          ),
        )
      : null,
    deleteAsk && doc
      ? h(
          'div',
          {
            style: {
              position: 'absolute',
              inset: 0,
              zIndex: 40,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: T.mask,
            },
          },
          h(
            'div',
            {
              style: {
                width: 380,
                padding: 16,
                borderRadius: 12,
                border: `1px solid ${T.border}`,
                background: T.panel,
                boxShadow: T.shadow,
                fontSize: 12,
              },
            },
            h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '删除工程「' + doc.title + '」？'),
            h('div', { style: { opacity: 0.7, lineHeight: 1.6 } },
              '会解除这个会话与工程的绑定。磁盘上的文件要一起删吗？删了找不回来。'),
            h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14, flexWrap: 'wrap' } },
              miniBtn('取消', () => setDeleteAsk(false)),
              miniBtn('只解除绑定', () => doRemoveProject(false)),
              miniBtn('连文件一起删', () => doRemoveProject(true), { color: T.danger, borderColor: T.danger }),
            ),
          ),
        )
      : null,
    exportOpen && doc
      ? h(
          'div',
          {
            style: {
              position: 'absolute',
              top: 48,
              right: 12,
              width: 300,
              zIndex: 30,
              padding: 12,
              borderRadius: 10,
              border: `1px solid ${T.border}`,
              background: T.panel,
              boxShadow: T.shadow,
              fontSize: 12,
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', marginBottom: 8 } },
            h('strong', { style: { flex: 1 } }, '导出参数'),
            h('span', { style: { cursor: 'pointer', opacity: 0.6 }, onClick: () => setExportOpen(false) }, '✕'),
          ),
          // 真实格式预告：打开表单就开始探测，探测中不挡其他操作
          (() => {
            const preview = exportPreview();
            const color =
              preview.tone === 'error'
                ? T.danger
                : preview.tone === 'warn'
                  ? T.warn
                  : preview.tone === 'info'
                    ? T.accent
                    : T.textDim;
            return h(
              'div',
              {
                style: {
                  marginBottom: 8,
                  padding: '6px 8px',
                  borderRadius: 6,
                  fontSize: 11,
                  lineHeight: 1.6,
                  color,
                  background: T.fill,
                  border: `1px solid ${T.border}`,
                },
              },
              preview.text,
            );
          })(),
          exportRow('分辨率', exportForm.resolution, (v) => setExportForm({ ...exportForm, resolution: v }), [
            ['project', '跟随工程（' + projectPixels().width + '×' + projectPixels().height + '）'],
            ['1080', '1080p（1920×1080）'],
            ['720', '720p（1280×720）'],
          ]),
          (() => {
            const projectFps = (doc && doc.fps) || 30;
            return exportRow('帧率', exportForm.fps, (v) => {
              setExportForm({ ...exportForm, fps: v });
              // 检查器里的「帧率」与表单是同一件事：在表单里选 60，检查器也跟着变成 60，
              // 下次从检查器点「导出 MP4」不会再被重置回工程帧率。
              if (v !== 'project') setExportSettings({ ...exportSettings, fps: Number(v) });
            }, [
              ['project', '跟随工程（' + projectFps + 'fps）'],
              ['24', '24 fps'],
              ['25', '25 fps'],
              ['30', '30 fps'],
              ['50', '50 fps'],
              ['60', '60 fps'],
            ]);
          })(),
          (() => {
            const projectFps = (doc && doc.fps) || 30;
            const exportFps = exportForm.fps === 'project' ? projectFps : Number(exportForm.fps);
            const hint =
              exportFps === projectFps
                ? '按工程 ' + projectFps + 'fps 采样；改帧率只改采样密度，时长与音轨不变。'
                : '工程 ' + projectFps + 'fps，按 ' + exportFps + 'fps 采样' +
                  (exportFps > projectFps ? '（重复帧是正常的，不会黑帧）' : '（按时间抽帧）') +
                  '；音频仍按时间轴混音，时长不变。';
            return h(
              'div',
              { style: { opacity: 0.45, fontSize: 11, lineHeight: 1.6, margin: '2px 0 10px' } },
              hint,
            );
          })(),
          exportRow('码率', exportForm.bitrate, (v) => setExportForm({ ...exportForm, bitrate: v }), [
            ['auto', '自动（按画面估算）'],
            ['4', '4 Mbps'],
            ['8', '8 Mbps'],
            ['16', '16 Mbps'],
          ]),
          exportRow('范围', exportForm.range, (v) => setExportForm({ ...exportForm, range: v }), [
            ['all', '全片（' + ((doc && doc.duration) || 0).toFixed(2) + 's）'],
            ['playhead', '播放头到结尾（' + fmtTime(state.playhead || 0) + ' 起）'],
          ]),
          (() => {
            const preview = exportPreview();
            // NO_ENCODER（blocked）或还在探测：禁用按钮 —— 不让用户点进去再等失败
            const disabled = preview.blocked === true || capsBusy;
            const onClick = preview.blocked
              ? () => toast(preview.text, 'warn')
              : capsBusy
                ? () => toast('正在检测编码能力，稍等一下', 'warn')
                : startExportFromForm;
            return h(
              'div',
              { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
              miniBtn('取消', () => setExportOpen(false)),
              miniBtn(
                '开始导出',
                onClick,
                Object.assign(
                  {
                    background: T.primary,
                    borderColor: T.primary,
                    color: T.onPrimary,
                    fontWeight: 600,
                  },
                  disabled ? { opacity: 0.45, cursor: 'not-allowed' } : null,
                ),
              ),
            );
          })(),
        )
      : null,
    h(ProgressOverlay, { busy: s.busy }),
    s.toast
      ? h('div', {
          style: {
            position: 'absolute',
            bottom: 14,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '6px 12px',
            borderRadius: 8,
            background: T.panel,
            border: `1px solid ${T.border}`,
            fontSize: 12,
            color: T.text,
          },
        }, s.toast.message)
      : null,
  );
}

// ------------------------------------------------------------------ dock ----

let ctxRef = null;

function DockEntry(props) {
  const s = useStore();
  const sessionId = props.sessionId || (props.session && (props.session.id || props.session.sessionId));
  React.useEffect(() => {
    if (sessionId && sessionId !== state.sessionId) {
      setState({ sessionId, projectId: null, doc: null, clips: [], assets: [], active: false, enabled: [], mine: [] });
    }
  }, [sessionId]);

  async function open() {
    // 入口只负责把面板打开：进入 / 新建都在面板里做，
    // 不再「点一下就去选目录」，也不再自动挂载上一次的工程。
    if (state.busy) return;
    if (ctxRef && ctxRef.layout) ctxRef.layout.selectPanel(PANEL_ID);
  }

  return h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', fontSize: 12, color: T.textDim } },
    h(
      'button',
      {
        type: 'button',
        onClick: open,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          borderRadius: 999,
          border: `1px solid ${T.border}`,
          background: 'transparent',
          color: 'inherit',
          fontSize: 12,
          cursor: 'pointer',
        },
      },
      h('span', { 'aria-hidden': true }, '🎬'),
      state.doc ? '进入视频工作台' : '视频工作台',
    ),
    state.doc ? h('span', { style: { fontSize: 11, opacity: 0.7 } }, `${state.doc.title} · r${state.doc.revision}`) : null,
  );
}

export { Workbench, DockEntry };

export default {
  inject: ['slots'],
  apply(ctx) {
    ctxRef = ctx;
    beacon('apply-start');
    const safe = (label, fn) => {
      try {
        const dispose = fn();
        beacon('register-ok', label);
        return typeof dispose === 'function' ? dispose : () => {};
      } catch (e) {
        beacon('register-failed', label + ': ' + (e && e.message));
        return () => {};
      }
    };
    // 槽位必须先用 slots.inject 声明依赖，注册要发生在它的回调里。
    // 直接 register 会报：slot "conversation.view" is not declared。
    ctx.effect(() =>
      safe('view', () =>
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            { name: 'conversation.view', id: 'video-workbench', order: 20, label: () => '视频工作台' },
            Workbench,
          ),
        ),
      ),
    );
    return () => {
      ctxRef = null;
      player.clearPool();
      clearThumbs();
      clearWaveforms();
    };
  },
};
