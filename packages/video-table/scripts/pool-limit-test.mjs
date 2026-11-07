/**
 * 预览池 LRU 上限的断言（src/client/player.js 的 ensureVideos）。
 *
 *   node scripts/pool-limit-test.mjs
 *
 * 一个 <video> 元素真的会占 30–80MB。池子必须封顶，但「当前时间线引用的」
 * 一个都不能释放 —— 否则正在播的那一帧会突然变黑。这里用假 DOM 直接把
 * 这两条同时钉住。
 */

let created = 0;
function fakeVideo() {
  created += 1;
  return {
    src: '',
    preload: '',
    muted: false,
    playsInline: false,
    crossOrigin: '',
    paused: true,
    readyState: 0,
    videoWidth: 0,
    videoHeight: 0,
    error: null,
    loads: 0,
    listeners: {},
    load() {
      this.loads += 1;
    },
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    getAttribute(name) {
      return name === 'src' ? this.src : null;
    },
    removeAttribute(name) {
      if (name === 'src') this.src = '';
    },
    setAttribute() {},
    addEventListener(ev, fn) {
      (this.listeners[ev] = this.listeners[ev] || []).push(fn);
    },
    removeEventListener() {},
  };
}

globalThis.document = { createElement: () => fakeVideo() };

const player = await import('../src/client/player.js');
const { POOL_LIMIT, poolSize, poolIds, ensureVideos, videoState, clearPool } = player;

let pass = 0;
let fail = 0;
function step(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + e.message);
  }
}

const video = (id) => ({ id, mime: 'video/mp4', path: 'assets/' + id + '.mp4' });
const many = (n) => Array.from({ length: n }, (_, i) => video('a' + i));
const urlFor = (id) => '/api/video/media?assetId=' + id;

step('POOL_LIMIT 是 8', () => {
  if (POOL_LIMIT !== 8) throw new Error('POOL_LIMIT=' + POOL_LIMIT);
});

step('素材少于上限时全部建出来', () => {
  clearPool();
  const made = ensureVideos(many(3), urlFor);
  if (made !== 3) throw new Error('made=' + made);
  if (poolSize() !== 3) throw new Error('poolSize=' + poolSize());
});

step('ensureVideos 是幂等的（第二次 created=0，池子不变）', () => {
  const before = poolSize();
  const made = ensureVideos(many(3), urlFor);
  if (made !== 0) throw new Error('重复建了 ' + made + ' 个');
  if (poolSize() !== before) throw new Error('池子变了');
});

step('超过 8 个时淘汰最久未用（且没被时间线引用）的元素', () => {
  clearPool();
  const assets = many(10); // a0…a9，创建顺序 = LRU 顺序
  const made = ensureVideos(assets, urlFor, { keep: new Set(['a0']) });
  if (made !== 10) throw new Error('made=' + made);
  if (poolSize() !== 8) throw new Error('poolSize=' + poolSize());
  if (!videoState('a0')) throw new Error('被引用的 a0 被释放了');
  if (videoState('a1')) throw new Error('最久未用的 a1 没被释放');
  if (videoState('a2')) throw new Error('第二久未用的 a2 没被释放');
  for (let i = 3; i < 10; i += 1) {
    if (!videoState('a' + i)) throw new Error('较新的 a' + i + ' 被误杀');
  }
});

step('时间线正在用的元素不释放（keep 挡住老元素）', () => {
  clearPool();
  ensureVideos(many(10), urlFor, { keep: new Set(['a0', 'a1']) });
  if (!videoState('a0') || !videoState('a1')) throw new Error('在用元素被释放');
  if (videoState('a2') || videoState('a3')) throw new Error('该淘汰的没淘汰');
  if (poolSize() !== 8) throw new Error('poolSize=' + poolSize());
});

step('全部都在用：宁可暂时超限，也不黑屏', () => {
  clearPool();
  const keep = new Set(many(10).map((a) => a.id));
  ensureVideos(many(10), urlFor, { keep });
  if (poolSize() !== 10) throw new Error('poolSize=' + poolSize());
  for (const a of many(10)) if (!videoState(a.id)) throw new Error(a.id + ' 被释放了');
});

step('只有视频素材会建元素（音频/图片不建）', () => {
  clearPool();
  const made = ensureVideos(
    [
      { id: 'v1', mime: 'video/mp4' },
      { id: 's1', mime: 'audio/mpeg' },
      { id: 'i1', mime: 'image/png' },
      { id: 'n1' },
    ],
    urlFor,
  );
  if (made !== 1) throw new Error('made=' + made);
  if (!videoState('v1')) throw new Error('视频没建');
  if (videoState('s1') || videoState('i1')) throw new Error('非视频也建了元素');
});

step('切工程清池：clearPool 之后池子归零，旧元素取不到', () => {
  clearPool();
  ensureVideos(many(3), urlFor);
  clearPool();
  if (poolSize() !== 0) throw new Error('poolSize=' + poolSize());
  if (poolIds().length !== 0) throw new Error('还有 id: ' + poolIds().join(','));
  if (videoState('a0')) throw new Error('旧元素还在');
  // 清理之后重建的是新工程的元素
  const made = ensureVideos([video('b0'), video('b1')], urlFor);
  if (made !== 2) throw new Error('made=' + made);
  if (!videoState('b0') || videoState('a0')) throw new Error('新旧混在一起');
});

step('force 重建：指定素材重新创建，池子仍然封顶', () => {
  clearPool();
  ensureVideos(many(3), urlFor);
  const before = videoState('a0');
  const made = ensureVideos(many(3), urlFor, { force: true });
  if (made !== 3) throw new Error('force 没重建: ' + made);
  if (videoState('a0') === before) throw new Error('元素没被换掉');
  if (poolSize() !== 3) throw new Error('poolSize=' + poolSize());
});

clearPool();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
