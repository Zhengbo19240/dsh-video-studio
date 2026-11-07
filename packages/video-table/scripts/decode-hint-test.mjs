/**
 * 解码提示回归测试：同一句「正在解码…」曾经盖住四种完全不同的真相。
 *
 *   node scripts/decode-hint-test.mjs
 *
 * 起因（真实缺陷）：用户导入 1365×720 / 14.77s 的 H.264 MP4，
 * 预览区永远停在「正在解码…（首次导入会有几秒等待）」。
 * 实测根因是预览池里根本没有 <video> 元素 —— 不是解码慢，是没开始加载。
 *
 * ★ 2026-11 修订：这些「为什么没画面」的中文诊断**不再画进合成画布**，
 *   改由 onMediaState / mediaDiagnostic 交给面板的 DOM overlay。理由：
 *   画进画布后，导出与无头采样会在 PNG 里带上这行字（agent 看到的不是画面）。
 *   所以本测试仍钉四种互不相同的真相，但断言改为「诊断通道」+「画布上零文字」。
 *
 * 不联网、不碰工程：用假 ctx / 假 video 元素，纯逻辑。
 */

import * as player from '../src/client/player.js';

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

/** 记录 fillText / drawImage 的假 2D 上下文 */
function fakeCtx() {
  const noop = () => {};
  const ctx = {
    painted: [],
    drawn: [],
    save: noop,
    restore: noop,
    beginPath: noop,
    rect: noop,
    clip: noop,
    ellipse: noop,
    translate: noop,
    rotate: noop,
    fillRect: noop,
    strokeText: noop,
    measureText: (t) => ({ width: String(t).length * 6 }),
    createRadialGradient: () => ({ addColorStop: noop }),
    fillText: (text) => ctx.painted.push(String(text)),
    drawImage: (img) => ctx.drawn.push(img),
    set fillStyle(_v) {},
    set strokeStyle(_v) {},
    set font(_v) {},
    set textAlign(_v) {},
    set textBaseline(_v) {},
    set globalAlpha(_v) {},
    set filter(_v) {},
    set lineWidth(_v) {},
  };
  return ctx;
}

/** 假 <video>：只实现 player 会读的那几个字段 */
function fakeVideo(over) {
  return Object.assign(
    {
      readyState: 0,
      networkState: 1,
      videoWidth: 0,
      videoHeight: 0,
      error: null,
      duration: 0,
      currentTime: 0,
      paused: true,
      seeking: false,
      currentSrc: '',
      src: '',
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
    },
    over || {},
  );
}

const asset = {
  id: 'asset_test',
  mime: 'video/mp4',
  name: 'clip.mp4',
  probe: { duration: 14.772333, width: 1356, height: 720, fps: null },
};
const assets = [asset];
const clips = [{ id: 'clip_test', trackId: 'v1', type: 'media', assetId: asset.id, start: 0, duration: 14.772 }];
const view = (extra) => Object.assign({ clips, assets, t: 1, width: 960, height: 540 }, extra || {});

/** 跑一帧，返回 {ctx, diags}：diags 就是面板 overlay 拿到的诊断列表。 */
function paint(input) {
  const ctx = fakeCtx();
  const diags = [];
  player.drawFrame(ctx, Object.assign({}, input, { onMediaState: (list) => diags.push(...(list || [])) }));
  return { ctx, diags };
}

// 假 document：player.videoFor 需要 createElement
let created = [];
globalThis.document = {
  createElement(tag) {
    const el = tag === 'video' ? fakeVideo() : {};
    created.push(el);
    return el;
  },
};

// ---------------------------------------------------------------- 1. 池子空 --
player.clearPool();
{
  const { ctx, diags } = paint(view());
  ok('池子空：诊断里说「pool 里没有」，不是「正在解码」', diags.some((d) => d.title.includes('pool 里没有')), JSON.stringify(diags));
  ok('池子空：不再出现笼统的「正在解码…首次导入」', !diags.some((d) => d.detail.includes('首次导入会有几秒等待')));
  ok('池子空：诊断里说明「根本没开始加载」', diags.some((d) => d.detail.includes('根本没开始加载')));
  ok('池子空：画布上没有任何文字（诊断不进合成帧）', ctx.painted.length === 0, JSON.stringify(ctx.painted));
  ok('池子空：画布上没有任何 drawImage', ctx.drawn.length === 0);

  const list = player.mediaDiagnostics(view());
  ok('mediaDiagnostics 报 no-element', list.length === 1 && list[0].code === 'no-element', JSON.stringify(list));
  ok('no-element 是 blocker', list[0].blocker === true);
  ok('no-element 给出「重新加载」的动作', /重新加载|按 R/.test(list[0].hint), list[0].hint);
}

// ------------------------------------------------------- 2. 补齐池子（修复） --
{
  const made = player.ensureVideos(assets, (id) => '/api/video/media?assetId=' + id);
  ok('ensureVideos 为视频素材建了元素', made === 1, 'made=' + made);
  ok('ensureVideos 之后池子里有元素', !!player.videoState(asset.id));
  const again = player.ensureVideos(assets, (id) => '/api/video/media?assetId=' + id);
  ok('ensureVideos 幂等，不会重复建', again === 0, 'again=' + again);

  const { ctx, diags } = paint(view());
  ok('刚建出来的元素（readyState=0）报「载入中…」', diags.some((d) => d.title.includes('载入中')), JSON.stringify(diags));
  ok('载入中带 networkState', diags.some((d) => d.detail.includes('networkState')));
  ok('载入中不再是「正在解码」', !diags.some((d) => d.detail.includes('正在解码')));
  ok('载入中也不往画布写字', ctx.painted.length === 0, JSON.stringify(ctx.painted));
}

// ------------------------------------------------------------ 3. 正常 H.264 --
{
  const v = player.videoState(asset.id);
  v.readyState = 4;
  v.videoWidth = 1356;
  v.videoHeight = 720;
  v.duration = 14.772333;
  const { ctx, diags } = paint(view());
  ok('readyState=4：drawImage 一次', ctx.drawn.length === 1, 'drawn=' + ctx.drawn.length);
  ok('readyState=4：画布上一句提示都没有', ctx.painted.length === 0, JSON.stringify(ctx.painted));
  ok('readyState=4：没有任何诊断', diags.length === 0, JSON.stringify(diags));
  ok('readyState=4：mediaDiagnostics 为空', player.mediaDiagnostics(view()).length === 0);

  const before = player.mediaGenerationValue();
  v.readyState = 3;
  player.videoState(asset.id).readyState = 4;
  ok('mediaGeneration 是稳定计数器（不回落）', player.mediaGenerationValue() >= before);
}

// --------------------------------------------------- 4. 元数据到了但没首帧 --
{
  const v = player.videoState(asset.id);
  v.readyState = 1;
  v.videoWidth = 0;
  const { ctx, diags } = paint(view());
  ok('readyState=1：说「已拿到元数据，等首帧」', diags.some((d) => d.title.includes('已拿到元数据')), JSON.stringify(diags));
  ok('readyState=1：画布仍然零文字', ctx.painted.length === 0);
  const d = player.mediaDiagnostic(asset, v);
  ok('readyState=1 诊断是 metadata', d.code === 'metadata', d.code);
}

// ---------------------------------------------- 5. 解码失败：HEVC 不可用 -----
{
  const v = player.videoState(asset.id);
  v.readyState = 0;
  v.networkState = 3;
  v.videoWidth = 0;
  v.error = { code: 4, message: 'DEMUXER_ERROR_NO_SUPPORTED_STREAMS' };
  const { ctx, diags } = paint(view({ codecs: { hvc1: '', h264: 'probably' } }));
  const text = diags.map((d) => [d.title, d.detail, d.hint].filter(Boolean).join(' / ')).join(' / ');
  ok('error=4：标题写「解码失败：4 MEDIA_ERR_SRC_NOT_SUPPORTED」', text.includes('解码失败：4') && text.includes('MEDIA_ERR_SRC_NOT_SUPPORTED'), text);
  ok('error=4：中文解释里点名 HEVC/H.265', text.includes('HEVC'), text);
  ok('error=4：给的是可执行的 ffmpeg 命令', text.includes('ffmpeg -i'), text);
  ok('error=4：带上 error.message', text.includes('DEMUXER_ERROR_NO_SUPPORTED_STREAMS'), text);
  ok('error=4：画布不承担文案', ctx.painted.length === 0);

  const d = player.mediaDiagnostic(asset, v, { hvc1: '' });
  ok('HEVC 不支持时给出转 H.264 的提示', d.code === 'error' && d.hint.includes('hvc1 探测：不支持'), d.hint);
  const d2 = player.mediaDiagnostic(asset, v, { hvc1: 'probably' });
  ok('本机自称支持 HEVC 时改口说 10bit/ProRes/损坏', d2.hint.includes('10bit') || d2.hint.includes('ProRes'), d2.hint);
}

// ------------------------------------------------------ 6. 有数据没画面 ------
{
  const v = player.videoState(asset.id);
  v.error = null;
  v.readyState = 2;
  v.videoWidth = 0;
  const { ctx, diags } = paint(view());
  ok('readyState=2 但 videoWidth=0：说「拿到了数据但解不出画面」', diags.some((d) => d.title.includes('拿到了数据但解不出画面')), JSON.stringify(diags));
  ok('no-frame 场景画布也是零文字', ctx.painted.length === 0);
  const d = player.mediaDiagnostic(asset, v);
  ok('诊断 code 是 no-frame', d.code === 'no-frame', d.code);
}

// -------------------------------------------------------- 7. 重试（重建） ----
{
  const v1 = player.videoState(asset.id);
  const v2 = player.videoFor(asset.id, '/api/video/media?retry=1', { force: true });
  ok('force 重建出一个新元素', v2 && v2 !== v1);
  ok('重建后池子里是新元素', player.videoState(asset.id) === v2);
  v2.readyState = 4;
  v2.videoWidth = 1356;
  v2.videoHeight = 720;
  const { ctx } = paint(view());
  ok('重建 + 就绪之后能画出画面', ctx.drawn.length === 1);
}

// ------------------------------------------------ 8. 素材不在工程里 -------
{
  const { ctx, diags } = paint({
    clips: [{ id: 'c', trackId: 'v1', type: 'media', assetId: 'ghost', start: 0, duration: 5 }],
    assets: [],
    t: 1,
    width: 960,
    height: 540,
  });
  ok('asset 不在素材表：说「工程里没有这个 asset」', diags.some((d) => d.title.includes('工程里没有这个 asset')), JSON.stringify(diags));
  ok('asset 缺失画布也不画「解码中」', !ctx.painted.some((t) => t.includes('正在解码')));
}

// ---------------------------------------------------- 9. 音频不进视频合成 ----
{
  const audio = { id: 'aud_1', mime: 'audio/mpeg', name: 'click_001.ogg', path: 'assets/click_001.ogg', probe: { duration: 0.4 } };
  const audioAssetList = [audio];
  const audioClips = [{ id: 'c_audio', trackId: 'v1', type: 'media', assetId: audio.id, start: 0, duration: 0.4 }];
  const made = player.ensureVideos(audioAssetList, (id) => '/media/' + id);
  ok('音频素材不建 <video> 元素', made === 0 && !player.videoState(audio.id));
  const { ctx, diags } = paint({ clips: audioClips, assets: audioAssetList, t: 0.2, width: 320, height: 180 });
  ok('音频图层不进 pending（不成为 hold 的理由）', !diags.some((d) => d.code === 'no-element'), JSON.stringify(diags));
  ok('音频素材让画布保持干净（没有伪造的提示字）', ctx.painted.length === 0);
  const d = player.mediaDiagnostic(audio, null);
  ok('音频素材有专属诊断（audio-asset）', d.code === 'audio-asset' && d.blocker === false, d.code);
  ok('音频诊断指向音频轨', /音频轨/.test(d.hint), d.hint);
}

// ------------------------------------------------------- 10. 编码能力探测 -----
{
  const sup = player.codecSupport();
  ok('codecSupport 返回 hvc1/h264 结构', typeof sup.hvc1 === 'string' && typeof sup.h264 === 'string', JSON.stringify(sup));
  ok('codecSupport 在假 document 上不抛错', true);
}

player.clearPool();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
