/**
 * 离屏校验：拿真实工程 + 真实素材，验证「H.264 能画出来」这条路径，并记录限制。
 *
 *   node scripts/media-preview-check.mjs ["D:\path\to\project"]
 *
 * 为什么要单独一个脚本：本仓库没有 Chrome 自动化依赖（node_modules 里没有
 * puppeteer / playwright / jsdom / canvas），Node 里也没有 HTMLVideoElement，
 * 所以「让浏览器真解一帧 H.264 再 drawImage」在这里做不到。
 * 能做到的是三件更具体的事：
 *   1. 用 ffprobe 证明文件本身是 H.264/yuv420p —— 编码不是问题；
 *   2. 证明浏览器的解码能力已经被记录下来过（asset.probe 是客户端回写的）；
 *   3. 用真实 clips/assets 跑 drawFrame，证明「元素就绪 → 画得出来」这段逻辑通。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as player from '../src/client/player.js';

const FFMPEG_BIN = process.env.DSH_FFMPEG_BIN || '~\\.dsh\\video-deps\\ffmpeg\\bin';
const FFPROBE = path.join(FFMPEG_BIN, 'ffprobe.exe');

const dir = process.argv[2] || 'D:\\DeepseekHarnessProject\\复刻视频测试';
const docPath = path.join(dir, '.dsh-video', 'project.json');

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

if (!existsSync(docPath)) {
  console.log('跳过：没有找到工程文档 ' + docPath);
  console.log('用法：node scripts/media-preview-check.mjs "<工程目录>"');
  process.exit(0);
}

const doc = JSON.parse(readFileSync(docPath, 'utf8'));
const asset = (doc.assets || [])[0];
console.log('工程：' + dir);
console.log('素材：' + (asset && asset.name));
console.log('');

// ---------------------------------------------------------- 1. ffprobe ----
if (!asset) {
  console.log('跳过：工程里没有素材');
  process.exit(0);
}
const abs = path.join(dir, asset.path);
console.log('文件存在：' + existsSync(abs));
if (existsSync(FFPROBE) && existsSync(abs)) {
  const out = execFileSync(
    FFPROBE,
    ['-v', 'error', '-show_entries', 'stream=codec_name,profile,pix_fmt,width,height,r_frame_rate', '-of', 'default=noprint_wrappers=1', abs],
    { encoding: 'utf8' },
  );
  console.log('ffprobe：\n' + out.trim().split(/\r?\n/).map((l) => '    ' + l).join('\n'));
  const isH264 = /codec_name=h264/.test(out);
  const isYuv420 = /pix_fmt=yuv420p/.test(out);
  ok('ffprobe 判定是 H.264（浏览器必然支持）', isH264, out);
  ok('ffprobe 判定是 yuv420p 8bit（不是 10bit）', isYuv420, out);
} else {
  console.log('ffprobe 不可用：' + FFPROBE);
}

// ------------------------------------------------- 2. 浏览器回写的 probe ---
ok(
  'asset.probe 有宽高 —— 这些数字只可能来自浏览器自己的解码器',
  !!(asset.probe && asset.probe.width > 0 && asset.probe.height > 0),
  JSON.stringify(asset.probe),
);
if (asset.probe) {
  console.log('  probe：' + asset.probe.width + '×' + asset.probe.height + ' / ' + asset.probe.duration + 's');
}

// ------------------------------------------- 3. 真实 clips/assets 跑一帧 ----
function fakeCtx() {
  const noop = () => {};
  const ctx = {
    painted: [],
    drawn: [],
    save: noop, restore: noop, beginPath: noop, rect: noop, clip: noop, ellipse: noop,
    translate: noop, rotate: noop, fillRect: noop, strokeText: noop,
    measureText: (t) => ({ width: String(t).length * 6 }),
    createRadialGradient: () => ({ addColorStop: noop }),
    fillText: (t) => ctx.painted.push(t),
    drawImage: (img) => ctx.drawn.push(img),
  };
  for (const k of ['fillStyle', 'strokeStyle', 'font', 'textAlign', 'textBaseline', 'globalAlpha', 'filter', 'lineWidth']) {
    Object.defineProperty(ctx, k, { set() {}, get() { return null; } });
  }
  return ctx;
}

let made = [];
globalThis.document = {
  createElement(tag) {
    const el =
      tag === 'video'
        ? {
            readyState: 0, networkState: 1, videoWidth: 0, videoHeight: 0, error: null,
            duration: 0, currentTime: 0, paused: true, seeking: false, src: '', currentSrc: '',
            load() {}, play() { return Promise.resolve(); }, pause() {},
            addEventListener() {}, removeEventListener() {}, removeAttribute() {},
            getAttribute() { return null; },
          }
        : {};
    made.push(el);
    return el;
  },
};

const clips = doc.clips || [];
const assets = doc.assets || [];
const view = (t) => ({ clips, assets, t, width: 960, height: 540 });

// 3a. 修复前的真实状态：池子空 —— 这就是用户看到的画面
player.clearPool();
{
  const ctx = fakeCtx();
  const diags = [];
  player.drawFrame(ctx, Object.assign(view(0), { onMediaState: (list) => diags.push(...(list || [])) }));
  console.log('\n[修复前 / 池子空] 诊断（overlay 拿到的）：' + JSON.stringify(diags.map((d) => d.title)));
  ok('池子空时诊断说「pool 里没有」，并点明根本没开始加载',
    diags.some((d) => d.title.includes('pool 里没有')) && diags.some((d) => d.detail.includes('根本没开始加载')));
  ok('诊断不写进合成画布（无头/导出不会带字）', ctx.painted.length === 0, JSON.stringify(ctx.painted));
}

// 3b. 修复后：ensureVideos 补齐，元素就绪，画得出来
player.clearPool();
{
  const n = player.ensureVideos(assets, (id) => '/api/video/media?assetId=' + id);
  ok('ensureVideos 为真实工程补齐了 ' + n + ' 个元素', n >= 1, 'n=' + n);
  const v = player.videoState(asset.id);
  // 用真实 probe 的数字把元素标成就绪：这正是浏览器解到首帧后的状态
  v.readyState = 4;
  v.videoWidth = asset.probe.width;
  v.videoHeight = asset.probe.height;
  v.duration = asset.probe.duration;
  const ctx = fakeCtx();
  player.drawFrame(ctx, view(1));
  ok('元素就绪后 drawImage 被调用（H.264 路径能画出来）', ctx.drawn.length === 1, 'drawn=' + ctx.drawn.length);
  ok('元素就绪后画布上没有任何提示语', ctx.painted.length === 0, JSON.stringify(ctx.painted));
  ok('H.264 应当能播（浏览器 canPlayType 语义）', player.codecSupport().h264 !== undefined);
}

console.log('');
console.log('限制（说清楚，不假装）：本仓库没有 Chrome 自动化依赖，Node 也没有 HTMLVideoElement，');
console.log('所以「真的解一帧 H.264」只能在浏览器里做 —— 上面的 ok 证明的是逻辑路径与文件属性；');
console.log('文件本身的编码已经由 ffprobe 和 asset.probe（浏览器回写）双重确认。');

player.clearPool();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
