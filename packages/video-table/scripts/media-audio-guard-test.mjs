/**
 * 音频守卫回归测试 —— 「音频素材被当成视频素材」这一整条链。
 *
 *   node scripts/media-audio-guard-test.mjs
 *
 * 现场（用户实测回放）：素材面板把 Swinging staff whoosh / click_001.ogg /
 * click1.ogg / Future Ambient 全列成了带「加入主机 / 画中画」的卡片；点下去之后
 * 预览区永远停在「素材未就绪 / 播放头 12.64s，素材还没解出画面（readyState < 2）」。
 * 音频元素天然 videoWidth=0，就绪判定永远不过 → 整帧被 hold → 全黑；点「重新加载」
 * 和按 R 都没用，因为它根本不是视频。
 *
 * 本测试钉住四件事：
 *   1) kind 判定（ffprobe 流类型 > mime > 扩展名）与它的入口策略；
 *   2) 音频不建 <video>、不参与就绪判定、不参与合成，因此不会 hold 整帧；
 *   3) 音频插入只落在音频轨（a1），拿不到 v1/v2；
 *   4) 脏数据（音频在视频轨）可被扫描出来、可一键修复成合法时间线。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { useTempBindings } from './_bindings-guard.mjs';
import { ProjectStore } from '../src/store.mjs';
import { registerVideoRoutes } from '../src/routes.mjs';
import {
  KIND,
  assetKind,
  isAudioAsset,
  isVideoAsset,
  insertPolicy,
  resolveInsertTrack,
  audioOnVideoTrackIssues,
  describeAudioTrackIssues,
  planAudioRepair,
  firstFreeStart,
} from '../src/media-kind.mjs';
import * as player from '../src/client/player.js';

const cleanupBindings = useTempBindings('media-audio-guard');
let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  ok   ' + name);
  } else {
    fail += 1;
    console.log('  FAIL ' + name + (extra ? ' :: ' + extra : ''));
  }
}

// ------------------------------------------------------------ 假 DOM ------
function fakeVideo() {
  return {
    readyState: 0,
    networkState: 1,
    videoWidth: 0,
    videoHeight: 0,
    error: null,
    duration: 0,
    currentTime: 0,
    paused: true,
    seeking: false,
    src: '',
    currentSrc: '',
    load() {},
    play() {
      return Promise.resolve();
    },
    pause() {},
    addEventListener() {},
    removeEventListener() {},
    removeAttribute() {},
    getAttribute() {
      return null;
    },
  };
}
let created = [];
globalThis.document = {
  createElement(tag) {
    const el = tag === 'video' ? fakeVideo() : {};
    created.push(el);
    return el;
  },
};

function fakeCtx() {
  const noop = () => {};
  const ctx = {
    texts: [],
    draws: [],
    fillRects: 0,
    save: noop,
    restore: noop,
    beginPath: noop,
    rect: noop,
    clip: noop,
    ellipse: noop,
    translate: noop,
    rotate: noop,
    measureText: (t) => ({ width: String(t).length * 6 }),
    createRadialGradient: () => ({ addColorStop: noop }),
    strokeText: (t) => ctx.texts.push(String(t)),
    fillText: (t) => ctx.texts.push(String(t)),
    fillRect: () => {
      ctx.fillRects += 1;
    },
    drawImage: (img) => ctx.draws.push(img),
  };
  for (const key of [
    'fillStyle',
    'strokeStyle',
    'font',
    'textAlign',
    'textBaseline',
    'globalAlpha',
    'filter',
    'lineWidth',
  ]) {
    Object.defineProperty(ctx, key, { get: () => null, set: () => {} });
  }
  return ctx;
}

// ------------------------------------------------------------- kind -------
console.log('\n[kind]');
const AUDIO = { id: 'aud_1', mime: 'audio/mpeg', name: 'click_001.ogg', path: 'assets/click_001.ogg', probe: { duration: 0.42 } };
const VIDEO = { id: 'vid_1', mime: 'video/mp4', name: 'clip.mp4', path: 'assets/clip.mp4', probe: { duration: 3, width: 1280, height: 720 } };
const OCTET_MP3 = { id: 'aud_2', mime: 'application/octet-stream', name: 'Future Ambient 80bpm.mp3', path: 'assets/Future Ambient 80bpm.mp3' };
const OCTET_WAV = { id: 'aud_3', mime: 'application/octet-stream', name: 'Swinging staff whoosh.wav', path: 'assets/Swinging staff whoosh.wav' };

ok('mime=audio/* → audio', assetKind(AUDIO) === KIND.AUDIO, assetKind(AUDIO));
ok('mime=video/* → video', assetKind(VIDEO) === KIND.VIDEO, assetKind(VIDEO));
ok('mime 缺失时按扩展名认音频（.mp3）', assetKind(OCTET_MP3) === KIND.AUDIO, assetKind(OCTET_MP3));
ok('mime 缺失时按扩展名认音频（.wav）', assetKind(OCTET_WAV) === KIND.AUDIO, assetKind(OCTET_WAV));
ok(
  'ffprobe 说 hasVideoStream=false + hasAudioStream=true → audio（哪怕 mime 写着 video/mp4）',
  assetKind({ id: 'x', mime: 'video/mp4', name: 'mislabeled.mp4', probe: { hasVideoStream: false, hasAudioStream: true } }) === KIND.AUDIO,
);
ok(
  'ffprobe 说 hasVideoStream=true → video（优先于扩展名/ mime）',
  assetKind({ id: 'y', mime: 'audio/mpeg', name: 'actually-video.mp3', probe: { hasVideoStream: true } }) === KIND.VIDEO,
);
ok('isAudioAsset / isVideoAsset 与 assetKind 一致', isAudioAsset(AUDIO) && !isVideoAsset(AUDIO) && isVideoAsset(VIDEO));

// ------------------------------------------------------------ 入口策略 -----
console.log('\n[entry]');
ok(
  '音频卡只有「音频轨」入口，没有 加入主轨 / 画中画',
  JSON.stringify(insertPolicy(AUDIO).buttons) === '["audio"]' &&
    !insertPolicy(AUDIO).buttons.includes('main') &&
    !insertPolicy(AUDIO).buttons.includes('pip'),
  JSON.stringify(insertPolicy(AUDIO)),
);
ok(
  '视频卡保留 加入主轨 + 画中画',
  JSON.stringify(insertPolicy(VIDEO).buttons) === '["main","pip"]',
  JSON.stringify(insertPolicy(VIDEO)),
);
ok('音频不参与画面合成', insertPolicy(AUDIO).participatesInPicture === false);
ok('音频的按钮文案写明轨道', /音频轨/.test(insertPolicy(AUDIO).label), insertPolicy(AUDIO).label);

const docWithAudioTrack = { tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }], clips: [], assets: [], duration: 0 };
const docNoAudioTrack = { tracks: [{ id: 'v1', kind: 'video' }], clips: [], assets: [], duration: 0 };
const audioTarget = resolveInsertTrack(docWithAudioTrack, AUDIO);
ok('音频插入目标轨 = a1', audioTarget.trackId === 'a1' && audioTarget.createTrack === false, JSON.stringify(audioTarget));
const audioTarget2 = resolveInsertTrack(docNoAudioTrack, AUDIO);
ok(
  '没有音频轨时先建 a1（createKind=audio），绝不退到 v1',
  audioTarget2.trackId === 'a1' && audioTarget2.createTrack === true && audioTarget2.createKind === 'audio',
  JSON.stringify(audioTarget2),
);
ok('视频插入目标轨 = v1', resolveInsertTrack(docWithAudioTrack, VIDEO).trackId === 'v1');

// -------------------------------------------------- 播放器：不 hold 整帧 ---
console.log('\n[player]');
player.clearPool();
{
  const made = player.ensureVideos([AUDIO, VIDEO], (id) => '/media/' + id);
  ok('预览池只为视频建元素，音频建 0 个', made === 1 && !player.videoState(AUDIO.id) && !!player.videoState(VIDEO.id), 'made=' + made);
}
{
  const clips = [{ id: 'c_aud', trackId: 'v1', type: 'media', assetId: AUDIO.id, start: 0, duration: 0.42 }];
  const readiness = player.frameMediaReadiness({ clips, assets: [AUDIO], t: 0.2 });
  ok('就绪判定跳过音频：ready=true、pending 为空（不再 hold 整帧）', readiness.ready === true && readiness.pending.length === 0, JSON.stringify(readiness));
  const ctx = fakeCtx();
  const painted = player.paintPreviewFrame(ctx, { clips, assets: [AUDIO], t: 0.2, width: 320, height: 180 });
  ok('paintPreviewFrame 对「只有音频」的时间线照常出帧（painted=true）', painted.painted === true, JSON.stringify(painted));
  ok('这一帧不是黑的（fillRect 铺过底）且画布上没有诊断文字', ctx.fillRects >= 1 && ctx.texts.length === 0, JSON.stringify(ctx.texts));
}
{
  // 视频 + 音频同轨：画面由视频决定，音频既不影响 pending 也不进合成
  const v = player.videoState(VIDEO.id);
  v.readyState = 4;
  v.videoWidth = 1280;
  v.videoHeight = 720;
  v.currentTime = 1;
  v.seeking = false;
  const clips = [
    { id: 'c_aud', trackId: 'a1', type: 'media', assetId: AUDIO.id, start: 0, duration: 0.42 },
    { id: 'c_vid', trackId: 'v1', type: 'media', assetId: VIDEO.id, start: 0, duration: 3 },
  ];
  const readiness = player.frameMediaReadiness({ clips, assets: [AUDIO, VIDEO], t: 1 });
  ok('含音频的时间线：就绪判定只看视频（ready=true）', readiness.ready === true && readiness.pending.length === 0, JSON.stringify(readiness));
  const ctx = fakeCtx();
  player.drawFrame(ctx, { clips, assets: [AUDIO, VIDEO], t: 1, width: 320, height: 180, codecs: { hvc1: '' } });
  ok('含音频的时间线：合成帧里只有视频那一次 drawImage', ctx.draws.length === 1, 'draws=' + ctx.draws.length);
  ok('音频不会把诊断文字带进合成帧', ctx.texts.length === 0, JSON.stringify(ctx.texts));
}
{
  // 音频在视频轨（脏数据）也不能让整帧黑：合成跳过它，画中画上的视频照画
  const v = player.videoState(VIDEO.id);
  v.readyState = 4;
  v.videoWidth = 1280;
  v.videoHeight = 720;
  v.currentTime = 1;
  v.seeking = false;
  const clips = [
    { id: 'c_dirty', trackId: 'v1', type: 'media', assetId: AUDIO.id, start: 0, duration: 3 },
    { id: 'c_vid', trackId: 'v2', type: 'media', assetId: VIDEO.id, start: 0, duration: 3 },
  ];
  const readiness = player.frameMediaReadiness({ clips, assets: [AUDIO, VIDEO], t: 1 });
  ok('脏数据（音频在 v1）：就绪判定仍然 ready，预览不被阻塞', readiness.ready === true && readiness.pending.length === 0, JSON.stringify(readiness));
  const ctx = fakeCtx();
  player.drawFrame(ctx, { clips, assets: [AUDIO, VIDEO], t: 1, width: 320, height: 180, codecs: { hvc1: '' } });
  ok('脏数据（音频在 v1）：合成帧照常画出上面的视频', ctx.draws.length === 1, 'draws=' + ctx.draws.length);
}
{
  // 音频素材自己的诊断：说清原因与下一步，且不是 blocker
  const d = player.mediaDiagnostic(AUDIO, null);
  ok('音频有专属诊断 code=audio-asset 且 blocker=false', d.code === 'audio-asset' && d.blocker === false, d.code);
  ok('音频诊断指向音频轨', /音频轨/.test(d.hint), d.hint);
  const list = player.mediaDiagnostics({ clips: [{ id: 'c1', trackId: 'v1', type: 'media', assetId: AUDIO.id, start: 0, duration: 0.4 }], assets: [AUDIO], t: 0.1 });
  ok('mediaDiagnostics 会把「音频出现在画面层」报出来（面板据此提示）', list.length === 1 && list[0].code === 'audio-asset', JSON.stringify(list));
}
player.clearPool();

// ------------------------------------------------------------ 脏数据修复 ----
console.log('\n[repair]');
{
  const dirtyDoc = {
    tracks: [
      { id: 'v1', kind: 'video', name: '主轨' },
      { id: 'a1', kind: 'audio', name: '音频' },
    ],
    clips: [
      { id: 'a_sfx', trackId: 'v1', type: 'media', assetId: 'aud_1', start: 0, duration: 2 },
      { id: 'a_music', trackId: 'v1', type: 'media', assetId: 'aud_3', start: 0, duration: 2 },
    ],
    assets: [AUDIO, OCTET_WAV],
    duration: 2,
  };
  const issues = audioOnVideoTrackIssues(dirtyDoc);
  ok('脏数据扫描：找出视频轨上的两个音频片段', issues.length === 2, JSON.stringify(issues));
  ok('脏数据扫描：带上可读的素材名与轨道名', issues[0].assetName === 'click_001.ogg' && issues[0].trackName === '主轨', JSON.stringify(issues[0]));
  const summary = describeAudioTrackIssues(dirtyDoc);
  ok('提示文案说清「不阻塞预览」并给出一键修复', /一键|移到音频轨/.test(summary.human) && /不参与画面/.test(summary.human), summary.human);
  const plan = planAudioRepair(dirtyDoc);
  ok('修复计划含 clip.move，目标是 a1', plan.ops.length === 2 && plan.ops.every((o) => o.type === 'clip.move' && o.trackId === 'a1'), JSON.stringify(plan.ops));
  ok('两个片段不会互相压住（起点递增）', plan.ops[1].start >= plan.ops[0].start + 2 - 1e-6, JSON.stringify(plan.ops));
  ok('firstFreeStart 会跳过已被占用的区间', firstFreeStart([[0, 2]], 0, 1) === 2, String(firstFreeStart([[0, 2]], 0, 1)));
}

// -------------------------------------------- 一键修复走真事务（可撤销） ----
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-audio-guard-'));
  const store = new ProjectStore();
  const SESSION = 's-audio-guard';
  const doc = await store.open(root, SESSION);
  const pid = doc.projectId;

  // 造脏数据：音频素材 asset.add + clip.insert 到 v1（正是过去的 bug 路径）
  const dirt = store.preview(
    pid,
    SESSION,
    undefined,
    [
      { type: 'asset.add', assetId: 'aud_1', relPath: 'assets/click_001.ogg', name: 'click_001.ogg', mime: 'audio/mpeg', size: 10 },
      { type: 'clip.insert', clipId: 'a_sfx', trackId: 'v1', clipType: 'media', assetId: 'aud_1', start: 0, duration: 1.5 },
    ],
    '模拟旧版把音频插进视频轨',
  );
  await store.applyPreview(dirt.previewId, SESSION);

  const dirty = store.get(pid).doc;
  ok('脏工程确实能写出来（复现旧路径）', audioOnVideoTrackIssues(dirty).length === 1, JSON.stringify(audioOnVideoTrackIssues(dirty)));

  const plan = planAudioRepair(dirty);
  const p = store.preview(pid, SESSION, undefined, plan.ops, '音频素材移回音频轨');
  const applied = await store.applyPreview(p.previewId, SESSION);
  const repaired = store.get(pid).doc;
  const moved = repaired.clips.find((c) => c.id === 'a_sfx');
  ok('一键修复后片段落在 a1', moved && moved.trackId === 'a1', JSON.stringify(moved));
  ok('修复后不再有「音频在视频轨」', audioOnVideoTrackIssues(repaired).length === 0, JSON.stringify(audioOnVideoTrackIssues(repaired)));
  ok('a1 轨的 clips 索引里也有它', (repaired.tracks.find((t) => t.id === 'a1') || {}).clips.includes('a_sfx'));
  ok('修复是一次可撤销事务', typeof applied.revision === 'number' && applied.revision > 0, String(applied.revision));

  const undone = store.undoLast(pid, SESSION).catch((e) => e);
  const undoResult = await undone;
  if (undoResult && undoResult.code) {
    ok('撤销回到脏状态（undo 可用）', false, undoResult.code);
  } else {
    const back = store.get(pid).doc;
    ok('撤销回到脏状态（undo 可用）', audioOnVideoTrackIssues(back).length === 1, JSON.stringify(audioOnVideoTrackIssues(back)));
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

// ------------------------------------------ 面板那条路：RPC 提示 + 一键修复 ----
console.log('\n[rpc]');
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-audio-rpc-'));
  const SESSION = 's-audio-rpc';
  const routes = [];
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    get() {
      return undefined;
    },
  };
  const store = new ProjectStore();
  registerVideoRoutes(ctx, store, () => {});
  const rpcRoute = routes.find((r) => r.path === '/api/video/rpc');

  function fakeReq(method, url, body) {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    setTimeout(() => {
      if (body) req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    }, 0);
    return req;
  }
  function fakeRes() {
    return {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(k, v) {
        this.headers[k] = v;
      },
      end(chunk) {
        this.body += chunk || '';
      },
    };
  }
  async function rpc(method, params) {
    const res = fakeRes();
    await rpcRoute.handler(fakeReq('POST', '/api/video/rpc', { method, params }), res);
    return { status: res.statusCode, payload: JSON.parse(res.body) };
  }

  const doc = await store.open(root, SESSION);
  const pid = doc.projectId;
  const dirt = store.preview(
    pid,
    SESSION,
    undefined,
    [
      { type: 'asset.add', assetId: 'aud_rpc', relPath: 'assets/click1.ogg', name: 'click1.ogg', mime: 'audio/ogg', size: 8 },
      { type: 'clip.insert', clipId: 'a_rpc', trackId: 'v1', clipType: 'media', assetId: 'aud_rpc', start: 0, duration: 1 },
    ],
    '脏数据夹具',
  );
  await store.applyPreview(dirt.previewId, SESSION);

  const before = await rpc('timeline.audioIssues', { projectId: pid });
  ok('RPC timeline.audioIssues：打开工程就能读到可读提示', before.payload.ok === true && before.payload.value.count === 1, JSON.stringify(before.payload));
  ok('RPC 提示里带 human 文案（面板直接显示）', /移到音频轨/.test(before.payload.value.human), before.payload.value.human);

  const fixed = await rpc('timeline.repairAudio', { projectId: pid, sessionId: SESSION });
  ok('RPC timeline.repairAudio：一键修复成功', fixed.payload.ok === true && fixed.payload.value.moved === 1, JSON.stringify(fixed.payload));
  ok('RPC timeline.repairAudio：修复后不再报问题', fixed.payload.value.count === 0, JSON.stringify(fixed.payload.value));

  const after = await rpc('timeline.audioIssues', { projectId: pid });
  ok('RPC 复扫：视频轨上已经没有音频片段', after.payload.value.count === 0, JSON.stringify(after.payload.value));
  const moved = store.get(pid).doc.clips.find((c) => c.id === 'a_rpc');
  ok('RPC 修复真的落在 a1（不是只回了文案）', moved && moved.trackId === 'a1', JSON.stringify(moved));

  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

cleanupBindings();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
