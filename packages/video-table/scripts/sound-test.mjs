/**
 * 声音库（宿主侧）测试：本地扫描 / sidecar / 搜索 / 路径守卫 / Freesound 无 key /
 * 工具与 RPC 契约 / wav-flac-m4a-mp3-ogg 时长解析。
 *
 *   node scripts/sound-test.mjs
 *
 * 不联网：Freesound 只验证「无 key 抛 NO_API_KEY」这一条。
 */

import { EventEmitter } from 'node:events';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.mjs';
import { registerVideoRoutes } from '../src/routes.mjs';
import {
  scanLocal,
  searchLocal,
  resolveLocalPath,
  soundRoot,
  readDuration,
  readFlacDuration,
  readM4aDuration,
  readMp3Duration,
  readOggDuration,
  soundSourcesRoots,
  soundSourcesFile,
  loadSoundSources,
  ensureDefaultSoundSources,
} from '../src/sound-lib.mjs';
import { parseKenneyPacks, installKenneyPack, downloadKenneyPack, extractZip } from '../src/sound-kenney.mjs';
import { importSoundFromUrl } from '../src/sound-import.mjs';
import {
  freesoundEnabled,
  searchFreesound,
  rememberEntries,
  normalizeFreesoundSort,
  blendScores,
  rankByBlend,
  durationFit,
  FREESOUND_SORT_MODES,
} from '../src/sound-freesound.mjs';
import { soundTools, soundSources, soundPreview, searchSounds } from '../src/sound-tools.mjs';
import { soundErrorText, soundEmptyReason, SOUND_EMPTY_LOCAL_TEXT } from '../src/client/panels.js';

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('sound');

// --------------------------------------------------------------- 断言框架 ---

let pass = 0;
let fail = 0;

async function step(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + ((e && e.message) || e));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function expectCode(fn, code) {
  try {
    await fn();
  } catch (e) {
    if (e && e.code !== code) throw new Error('期望 ' + code + '，实际 ' + (e && e.code) + '（' + (e && e.message) + '）');
    return e;
  }
  throw new Error('应当抛 ' + code + '，但没有抛');
}

// ------------------------------------------------------------- 临时声音库 ---

const libRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-sound-lib-'));
process.env.DSH_SOUND_LIB = libRoot;
delete process.env.FREESOUND_API_KEY;

const packDir = path.join(libRoot, 'kenney-ui');
await fs.mkdir(path.join(packDir, 'sub'), { recursive: true });

/** 造一个只有头部、dataSize 声明为 seconds 秒的 wav（PCM 8kHz 16bit 单声道） */
function makeWav(seconds) {
  const sampleRate = 8000;
  const channels = 1;
  const bits = 16;
  const blockAlign = (channels * bits) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = Math.round(byteRate * seconds);
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

await fs.writeFile(path.join(packDir, 'impact.wav'), makeWav(2));
await fs.writeFile(
  path.join(packDir, 'impact.wav.json'),
  JSON.stringify({ title: '重击', tags: ['hit', 'impact', '打击'], category: 'impact', license: 'CC0', attribution: 'Kenney' }),
);
await fs.writeFile(path.join(packDir, 'click.mp3'), Buffer.from([0x49, 0x44, 0x33, 0x03]));
await fs.writeFile(
  path.join(packDir, 'click.mp3.json'),
  JSON.stringify({ title: 'Click UI', tags: ['click', 'ui'], license: 'CC0' }),
);
await fs.writeFile(path.join(packDir, 'sub', 'loop.ogg'), Buffer.from('OggS-fake'));
await fs.writeFile(path.join(packDir, '.hidden.wav'), makeWav(1));
await fs.writeFile(path.join(packDir, 'notes.txt'), '这不是音频');
await fs.writeFile(path.join(libRoot, 'root-file.wav'), makeWav(1)); // 不在 pack 目录里，不收

// --------------------------------------------------------------- 测试数据 ---

const store1 = new ProjectStore();
const root1 = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-sound-proj-'));
const doc1 = await store1.open(root1, 's1');

const tools = soundTools({ store: store1 });
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

// ---------------------------------------------------------------- 本地库 ----

console.log('本地声音库');

await step('① 扫描：只收音频扩展名，隐藏文件/非音频/根目录散文件都不收', async () => {
  assert(tools.length === 6, '应注册 6 个工具（原 3 + kenney + import + fetch）');
  const entries = await scanLocal();
  assert(entries.length === 3, '条目数应为 3，实际 ' + entries.length);
  assert(entries.every((e) => e.provider === 'local'), 'provider 应为 local');
  assert(!entries.some((e) => e.providerId.includes('.hidden')), '隐藏文件不应入库');
  assert(!entries.some((e) => e.providerId.endsWith('.txt')), '非音频不应入库');
  assert(!entries.some((e) => e.providerId.startsWith('root-file')), '根目录散文件不应入库（没有 pack 目录）');
  assert(soundRoot() === libRoot, 'soundRoot 应读取 DSH_SOUND_LIB');
});

await step('② wav 从 RIFF 头算出时长，其它格式返回 null', async () => {
  const entries = await scanLocal();
  const impact = entries.find((e) => e.providerId === 'kenney-ui/impact.wav');
  const click = entries.find((e) => e.providerId === 'kenney-ui/click.mp3');
  const loop = entries.find((e) => e.providerId === 'kenney-ui/sub/loop.ogg');
  assert(impact && impact.duration === 2, 'impact.wav 时长应为 2，实际 ' + (impact && impact.duration));
  assert(impact.durationExact === true, 'wav 时长应标记为精确');
  assert(click && click.duration === null, 'mp3 时长应为 null');
  assert(click.durationExact === null, '未知时长应标记 durationExact=null');
  assert(loop && loop.duration === null, 'ogg 时长应为 null');
  assert(loop.durationExact === null, 'ogg 未知时长应标记 durationExact=null');
  assert(impact.pageUrl === null, '本地条目 pageUrl 应为 null');
});

await step('③ sidecar 覆盖标题、标签、分类、授权、署名', async () => {
  const entries = await scanLocal();
  const impact = entries.find((e) => e.providerId === 'kenney-ui/impact.wav');
  const click = entries.find((e) => e.providerId === 'kenney-ui/click.mp3');
  assert(impact.title === '重击', 'title 应来自 sidecar，实际 ' + impact.title);
  assert(impact.tags.includes('打击'), 'tags 应包含中文标签');
  assert(impact.category === 'impact', 'category 应来自 sidecar');
  assert(impact.license === 'CC0', 'license 应来自 sidecar');
  assert(impact.attribution === 'Kenney', 'attribution 应来自 sidecar');
  assert(click.category === 'kenney-ui', '没有 category 时回落到 packId');
  assert(click.tags.length === 2, 'click 应有 2 个标签');
});

await step('④ 搜索：按标签、文件名，大小写不敏感', async () => {
  assert((await searchLocal('打击')).length === 1, '中文标签应能搜到');
  assert((await searchLocal('CLICK')).length === 1, '大小写不敏感');
  assert((await searchLocal('loop')).length === 1, '文件名应能搜到');
  assert((await searchLocal('impact hit')).length === 1, '多词按 AND 匹配');
  assert((await searchLocal('不存在的词')).length === 0, '无匹配应返回空数组');
  assert((await searchLocal('')).length === 3, '空查询应列出全部');
});

await step('⑤ id 稳定：同一目录两次扫描得到同一批 id', async () => {
  const a = await scanLocal();
  const b = await scanLocal();
  assert(
    a.map((e) => e.id).join(',') === b.map((e) => e.id).join(','),
    '两次扫描 id 不一致',
  );
  assert(a.every((e) => /^[0-9a-f]{12}$/.test(e.id)), 'id 应为 12 位十六进制');
});

await step('⑥ resolveLocalPath 把 id 还原成库内绝对路径', async () => {
  const impact = (await scanLocal()).find((e) => e.providerId === 'kenney-ui/impact.wav');
  const abs = await resolveLocalPath(impact.id);
  assert(path.isAbsolute(abs), '应返回绝对路径');
  assert(abs.toLowerCase().startsWith(libRoot.toLowerCase()), '路径应在声音库内');
  assert(abs.endsWith('impact.wav'), '路径应指向 impact.wav');
  await fs.access(abs);
});

await step('⑦ 越界 id 被拒：OUTSIDE_LIB', async () => {
  await expectCode(() => resolveLocalPath('local:kenney-ui/../../outside.wav'), 'OUTSIDE_LIB');
  await expectCode(() => resolveLocalPath('local:../../outside.wav'), 'OUTSIDE_LIB');
  await expectCode(() => resolveLocalPath('local:C:/Windows/win.ini'), 'OUTSIDE_LIB');
});

// ---------------------------------------------------------------- 在线源 ----

console.log('Freesound 在线源');

await step('⑧ 无 key：freesoundEnabled=false，搜索抛 NO_API_KEY（不是空数组）', async () => {
  assert(freesoundEnabled() === false, '没有 key 时应为 false');
  await expectCode(() => searchFreesound('dog'), 'NO_API_KEY');
});

// ------------------------------------------------------------------ 工具 ----

console.log('声音工具');

await step('⑨ video_sound_search：本地优先，在线失败只进 warnings', async () => {
  const v = await byName.video_sound_search.execute({ query: '', source: 'all' }, { agent: { id: 's1' } });
  assert(v.count === 3, '应返回 3 条本地结果，实际 ' + v.count);
  assert(Array.isArray(v.entries) && v.entries.length === 3, 'entries 应为数组');
  assert(Array.isArray(v.warnings) && v.warnings.length === 1, '应有 1 条 warning');
  assert(v.warnings[0].code === 'NO_API_KEY', 'warning code 应为 NO_API_KEY');
  assert(v.warnings[0].source === 'freesound', 'warning 应标明来源');
});

await step('⑩ video_sound_search：显式 source=freesound 时如实抛错', async () => {
  await expectCode(
    () => byName.video_sound_search.execute({ query: 'dog', source: 'freesound' }, { agent: { id: 's1' } }),
    'NO_API_KEY',
  );
});

// -------------------------------------------------------- Freesound 排序 ----
//
// 全部离线：只把 fetch 换成桩，验证「向 Freesound 要了什么」和「本地怎么重排」。

console.log('Freesound 排序');

/** 造一条 Freesound 原始记录（未归一化的形状） */
function rawFs(id, { name, duration = 1, downloads = 0, rating = 0, ratings = 0 } = {}) {
  return {
    id,
    name: name || 'sound ' + id,
    previews: { 'preview-hq-mp3': 'https://example.com/' + id + '.mp3' },
    duration,
    tags: ['whoosh'],
    num_downloads: downloads,
    avg_rating: rating,
    num_ratings: ratings,
    license: 'CC0',
    username: 'tester',
    url: 'https://freesound.org/s/' + id + '/',
  };
}

/** 临时装 key + fetch 桩；restore() 必须放 finally —— 后面的用例还指望「没有 key」 */
function stubFreesound(results) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'FREESOUND_API_KEY');
  const oldKey = process.env.FREESOUND_API_KEY;
  process.env.FREESOUND_API_KEY = 'test-key';
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ results }) };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
      if (hadKey) process.env.FREESOUND_API_KEY = oldKey;
      else delete process.env.FREESOUND_API_KEY;
    },
  };
}

await step('blend：1 个 5 星（样本 1）排到 4.9 星（样本 400）后面', async () => {
  const stub = stubFreesound([
    rawFs('1', { name: 'rare five', rating: 5, ratings: 1, downloads: 3 }),
    rawFs('2', { name: 'proven', rating: 4.9, ratings: 400, downloads: 30000 }),
    rawFs('3', { name: 'meh', rating: 4.5, ratings: 20, downloads: 100 }),
  ]);
  try {
    const got = await searchFreesound('whoosh', { sort: 'blend', limit: 10 });
    const order = got.map((e) => e.providerId).join(',');
    assert(order === '2,1,3', 'blend 顺序应为 2,1,3，实际 ' + order);
    const url = new URL(stub.calls[0]);
    assert(url.searchParams.get('sort') === 'rating_desc', 'blend 应先向 Freesound 要 rating_desc');
    assert(url.searchParams.get('page_size') === '20', 'blend 应取 2 倍样本（limit 10 → 20），实际 ' + url.searchParams.get('page_size'));
  } finally {
    stub.restore();
  }
});

await step('blend：时长匹配度 0.1 权重生效，贴上限的排前；没给 maxDuration 时固定 0.5', async () => {
  const entries = [
    { id: 'a', duration: 0.2, stats: { rating: 4.5, ratings: 10, downloads: 500 } },
    { id: 'b', duration: 0.95, stats: { rating: 4.5, ratings: 10, downloads: 500 } },
  ];
  const ranked = rankByBlend(entries, { maxDuration: 1 });
  assert(ranked.map((e) => e.id).join(',') === 'b,a', '贴上限的应排前，实际 ' + ranked.map((e) => e.id).join(','));
  assert(durationFit(2, 1) === 0, '超过 maxDuration 的匹配度应为 0');
  assert(durationFit(null, 1) === 0.5, '时长未知应为 0.5');
  assert(durationFit(0.4, null) === 0.5, '没给 maxDuration 应为固定 0.5');
  assert(durationFit(0.4, 0) === 0.5, 'maxDuration 非正应视作没给');
});

await step('blend 分数纯函数：0 除防住，同分序列稳定', async () => {
  // 三条一模一样（归一化区间为 0）→ 不能出现 NaN，顺序保持原样
  const flat = [
    { id: 'x', duration: 1, stats: { rating: 4, ratings: 10, downloads: 10 } },
    { id: 'y', duration: 1, stats: { rating: 4, ratings: 10, downloads: 10 } },
    { id: 'z', duration: 1, stats: { rating: 4, ratings: 10, downloads: 10 } },
  ];
  const scored = blendScores(flat);
  assert(scored.length === 3, '应返回 3 条分数');
  assert(scored.every((s) => Number.isFinite(s.score)), '分数不应出现 NaN/Infinity');
  assert(scored.map((s) => s.entry.id).join(',') === 'x,y,z', '同分应保持原顺序');
  assert(blendScores([]).length === 0, '空数组应返回空数组');
});

await step('sort=downloads / rating 直接透传，page_size 等于 limit', async () => {
  const stub = stubFreesound([rawFs('9', { rating: 4, ratings: 10, downloads: 10 })]);
  try {
    await searchFreesound('click', { sort: 'downloads', limit: 5 });
    await searchFreesound('click', { sort: 'rating', limit: 5 });
    const down = new URL(stub.calls[0]);
    const rate = new URL(stub.calls[1]);
    assert(down.searchParams.get('sort') === 'downloads_desc', 'downloads 应透传 downloads_desc');
    assert(down.searchParams.get('page_size') === '5', 'downloads 的 page_size 应等于 limit');
    assert(rate.searchParams.get('sort') === 'rating_desc', 'rating 应透传 rating_desc');
    assert(rate.searchParams.get('page_size') === '5', 'rating 的 page_size 应等于 limit');

    assert(normalizeFreesoundSort(undefined) === 'blend', '省略 sort 应默认 blend');
    assert(normalizeFreesoundSort('') === 'blend', '空串应默认 blend');
    assert(FREESOUND_SORT_MODES.join(',') === 'rating,downloads,blend', '排序模式应只有三种');
    await expectCode(() => searchFreesound('x', { sort: 'bogus' }), 'INVALID_ARG');
  } finally {
    stub.restore();
  }
});

await step('searchSounds 把 sort 透传给 Freesound（freesound 与 all 都一样）', async () => {
  const stub = stubFreesound([rawFs('11', { rating: 4.8, ratings: 50, downloads: 900 })]);
  try {
    const one = await searchSounds({ query: 'impact', source: 'freesound', sort: 'downloads', limit: 3 });
    assert(one.entries.length === 1, 'source=freesound 应返回 1 条');
    assert(new URL(stub.calls[0]).searchParams.get('sort') === 'downloads_desc', 'freesound 分支应透传 sort');

    await searchSounds({ query: 'impact', source: 'all', sort: 'rating', limit: 3 });
    assert(new URL(stub.calls[1]).searchParams.get('sort') === 'rating_desc', 'all 分支也应透传 sort');

    await expectCode(() => searchSounds({ source: 'local', sort: 'bogus' }), 'INVALID_ARG');
  } finally {
    stub.restore();
  }
});

await step('NO_API_KEY 错误码不变；面板错误映射给出人话并可测', async () => {
  assert(!process.env.FREESOUND_API_KEY, '前置：桩必须已还原成「没有 key」');
  const err = await expectCode(() => searchFreesound('dog', { sort: 'blend' }), 'NO_API_KEY');
  assert(err.message.includes('FREESOUND_API_KEY'), 'message 应说明缺哪个变量：' + err.message);

  const text = soundErrorText(err);
  assert(text.includes('NO_API_KEY'), '面板文案应带错误码：' + text);
  assert(text.includes('setx'), '面板文案应给出修复动作：' + text);
  assert(!text.includes('还没接上'), '不得再出现「宿主侧还没接上」的假话');
  assert(
    soundErrorText(Object.assign(new Error('boom'), { code: 'NETWORK' })).includes('freesound.org'),
    'NETWORK 应映射成「连不上 freesound.org」',
  );
  const long = soundErrorText(new Error('x'.repeat(300)));
  assert(long.length === 121 && long.endsWith('…'), '未知错误应截断到 120 字 + 省略号，实际 ' + long.length);

  assert(soundEmptyReason({ source: 'local', query: '', entries: [] }) === SOUND_EMPTY_LOCAL_TEXT, '本地空库应给引导');
  assert(soundEmptyReason({ source: 'local', query: 'door', entries: [] }) === '', '有关键词算没匹配，不算空库');
});

await step('⑪ video_sound_insert：本地条目落盘、插入 a1、provenance 与淡入淡出正确', async () => {
  const impact = (await scanLocal()).find((e) => e.providerId === 'kenney-ui/impact.wav');
  const v = await byName.video_sound_insert.execute(
    { entryId: impact.id, start: 0 },
    { agent: { id: 's1' } },
  );
  assert(typeof v.clipId === 'string' && v.clipId, '应返回 clipId');
  assert(typeof v.assetId === 'string' && v.assetId, '应返回 assetId');
  assert(v.revision === 1, 'revision 应为 1，实际 ' + v.revision);
  assert(typeof v.human === 'string' && v.human.length > 0, '应返回 human 摘要');

  const doc = store1.get(doc1.projectId).doc;
  assert(doc.clips.length === 1, '应插入 1 个片段');
  const clip = doc.clips[0];
  assert(clip.id === v.clipId, 'clipId 应与返回一致');
  assert(clip.trackId === 'a1', '应落在 a1 音频轨');
  assert(clip.type === 'media', '片段类型应为 media');
  assert(clip.duration === 2, '时长应取 wav 算出的 2 秒，实际 ' + clip.duration);
  assert(clip.fadeIn === 0.05, 'fadeIn 应为 0.05');
  assert(clip.fadeOut === 0.15, 'fadeOut 应为 0.15');
  assert(clip.provenance.libraryId === 'sound-lib', 'provenance.libraryId 应为 sound-lib');
  assert(clip.provenance.assetId === impact.id, 'provenance.assetId 应为声音库条目 id');
  assert(clip.provenance.license === 'CC0', 'provenance.license 应保留');

  const asset = doc.assets.find((a) => a.id === v.assetId);
  assert(asset && asset.name.endsWith('.wav'), '素材应登记且保留 .wav 扩展名');
  await fs.access(path.join(root1, asset.path)); // 文件真的在磁盘上
});

await step('⑫ a1 不存在时先自动建轨', async () => {
  const store2 = new ProjectStore();
  const root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-sound-proj2-'));
  const doc2 = await store2.open(root2, 's2');
  const rec = store2.get(doc2.projectId);
  rec.doc.tracks = rec.doc.tracks.filter((t) => t.id !== 'a1');
  assert(!rec.doc.tracks.some((t) => t.id === 'a1'), '前置：a1 应已移除');

  const tools2 = Object.fromEntries(soundTools({ store: store2 }).map((t) => [t.name, t]));
  const click = (await scanLocal()).find((e) => e.providerId === 'kenney-ui/click.mp3');
  const v = await tools2.video_sound_insert.execute({ entryId: click.id }, { agent: { id: 's2' } });
  const doc = store2.get(doc2.projectId).doc;
  const track = doc.tracks.find((t) => t.id === 'a1');
  assert(track && track.kind === 'audio', 'a1 应被自动建成音频轨');
  const clip = doc.clips.find((c) => c.id === v.clipId);
  assert(clip && clip.trackId === 'a1', '片段应落在新建的 a1 上');
  assert(clip.duration === 3, '时长未知时按 3 秒兜底，实际 ' + clip.duration);
  await fs.rm(root2, { recursive: true, force: true });
});

await step('⑬ video_sound_sources：返回本机状态', async () => {
  const v = await soundSources();
  assert(v.localRoot === libRoot, 'localRoot 应为 DSH_SOUND_LIB');
  assert(v.localCount === 3, 'localCount 应为 3，实际 ' + v.localCount);
  assert(v.freesound.enabled === false, 'freesound 应为关闭');
  assert(v.freesound.reason.includes('FREESOUND_API_KEY'), 'reason 应说明缺少 key');
});

// ------------------------------------------------------------------- RPC ----

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

const store3 = new ProjectStore();
registerVideoRoutes(ctx, store3, () => {});

function fakeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
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
    write(chunk) {
      this.body += chunk;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
      this.done = true;
    },
  };
}

async function call(method, params) {
  const res = fakeRes();
  const req = fakeReq('POST', '/api/video/rpc', { method, params });
  await routes.find((r) => r.path === '/api/video/rpc').handler(req, res);
  const payload = JSON.parse(res.body);
  if (!payload.ok) throw new Error(method + ': ' + payload.error.code + ' ' + payload.error.message);
  return payload.value;
}

console.log('RPC 契约');

const root3 = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-sound-rpc-'));
const RPC_SESSION = 'session-sound-rpc';
let projectId = null;

await step('⑭ sound.search 形状正确（count / entries / warnings）', async () => {
  const opened = await call('project.open', { dir: root3, sessionId: RPC_SESSION });
  projectId = opened.doc.projectId;

  const v = await call('sound.search', { query: 'click', source: 'local' });
  assert(v.count === 1, 'count 应为 1，实际 ' + v.count);
  assert(Array.isArray(v.warnings), 'warnings 应为数组');
  const e = v.entries[0];
  const fields = ['id', 'provider', 'providerId', 'title', 'file', 'duration', 'tags', 'category', 'license', 'attribution', 'pageUrl'];
  for (const f of fields) assert(f in e, '条目缺少字段 ' + f);
  assert(e.provider === 'local', 'provider 应为 local');
  assert(e.pageUrl === null, 'pageUrl 应为 null');
});

await step('⑭-2 sound.search RPC 与 video_sound_search 工具都把 sort 透传到 Freesound', async () => {
  const stub = stubFreesound([rawFs('21', { rating: 4.7, ratings: 80, downloads: 1200 })]);
  try {
    const viaRpc = await call('sound.search', {
      query: 'whoosh',
      source: 'freesound',
      sort: 'downloads',
      limit: 4,
    });
    assert(viaRpc.count === 1, 'RPC 应返回 1 条在线结果，实际 ' + viaRpc.count);
    const rpcUrl = new URL(stub.calls[0]);
    assert(rpcUrl.searchParams.get('sort') === 'downloads_desc', 'RPC 没透传 sort：' + rpcUrl.searchParams.get('sort'));
    assert(rpcUrl.searchParams.get('page_size') === '4', 'RPC 没透传 limit：' + rpcUrl.searchParams.get('page_size'));

    await byName.video_sound_search.execute(
      { query: 'riser', source: 'freesound', sort: 'rating', limit: 2 },
      { agent: { id: 's1' } },
    );
    const toolUrl = new URL(stub.calls[1]);
    assert(toolUrl.searchParams.get('sort') === 'rating_desc', '工具没透传 sort：' + toolUrl.searchParams.get('sort'));
    assert(toolUrl.searchParams.get('page_size') === '2', '工具没透传 limit：' + toolUrl.searchParams.get('page_size'));
  } finally {
    stub.restore();
  }
  assert(!process.env.FREESOUND_API_KEY, '桩必须还原成「没有 key」');
});

await step('⑮ sound.preview：本地分支返回可试听 URL（/api/video/sound?entryId=）', async () => {
  const list = await call('sound.search', { query: 'impact', source: 'local' });
  const id = list.entries[0].id;
  const v = await call('sound.preview', { entryId: id });
  assert(v.kind === 'url', 'kind 应为 url，实际 ' + v.kind);
  assert(v.url === '/api/video/sound?entryId=' + encodeURIComponent(id), 'url 不对：' + v.url);
  assert(v.url.startsWith('/api/video/sound?entryId='), 'url 应以试听路由开头：' + v.url);
  assert(!('path' in v), '本地预览不再回磁盘路径');
});

await step('⑯ sound.preview：在线分支返回 {kind:url,url}', async () => {
  rememberEntries([
    {
      id: 'freesound:999',
      provider: 'freesound',
      providerId: '999',
      title: 'Dog Bark',
      previewUrl: 'https://example.com/dog.mp3',
      duration: 1.5,
      tags: [],
      license: 'CC0',
      attribution: 'by tester',
      pageUrl: 'https://freesound.org/s/999/',
    },
  ]);
  const v = await call('sound.preview', { entryId: 'freesound:999' });
  assert(v.kind === 'url' && v.url === 'https://example.com/dog.mp3', '应返回预览 URL');
});

await step('⑰ sound.insert 走 preview+apply，返回 revision/human/clipId/assetId', async () => {
  const list = await call('sound.search', { query: 'impact', source: 'local' });
  const v = await call('sound.insert', {
    projectId,
    sessionId: RPC_SESSION,
    entryId: list.entries[0].id,
    start: 0,
  });
  assert(
    ['revision', 'human', 'clipId', 'assetId'].every((k) => k in v),
    '返回字段应包含 revision/human/clipId/assetId',
  );
  assert(v.revision === 1, 'revision 应为 1，实际 ' + v.revision);
  const doc = store3.get(projectId).doc;
  assert(doc.clips.some((c) => c.id === v.clipId), '片段应已落地');
  assert(doc.assets.some((a) => a.id === v.assetId), '素材应已登记');
});

await step('⑱ sound.search（all）无 key 时仍返回本地结果并带 warning', async () => {
  const v = await call('sound.search', { query: '', source: 'all' });
  assert(v.count === 3, '本地应有 3 条，实际 ' + v.count);
  assert(v.warnings.some((w) => w.code === 'NO_API_KEY'), '应带 NO_API_KEY warning');
});

await step('⑲ 越界 id 仍被拒（resolveLocalPath / sound.preview）', async () => {
  // 不带 local: 前缀的路径先查库，库里没有 → NOT_FOUND
  await expectCode(() => resolveLocalPath('../../etc/passwd'), 'NOT_FOUND');
  // 带 local: 前缀会真正解析路径，越界 → OUTSIDE_LIB
  await expectCode(() => resolveLocalPath('local:../../etc/passwd'), 'OUTSIDE_LIB');
  await expectCode(() => soundPreview({ entryId: 'local:../../../etc/passwd' }), 'OUTSIDE_LIB');
  await expectCode(() => soundPreview({ entryId: 'local:C:/Windows/win.ini' }), 'OUTSIDE_LIB');
  await expectCode(() => soundPreview({ entryId: '' }), 'INVALID_ARG');
});

await step('⑳ GET /api/video/sound：越界 / 不存在的 entryId 回 404 JSON', async () => {
  const route = routes.find((r) => r.path === '/api/video/sound');
  assert(route && route.kind === 'prefix', '缺少 /api/video/sound 路由');
  for (const entryId of ['local:../../etc/passwd', '../../etc/passwd', 'no-such-entry']) {
    const res = fakeRes();
    const req = fakeReq('GET', '/api/video/sound?entryId=' + encodeURIComponent(entryId));
    await route.handler(req, res);
    assert(res.statusCode === 404, entryId + ' 应回 404，实际 ' + res.statusCode);
    const payload = JSON.parse(res.body);
    assert(payload.ok === false && payload.error && payload.error.code, entryId + ' 应回 JSON 错误体');
  }
});



// -------------------------------------------------------- 时长解析（新增） ---
//
// 全部用 Node 现场拼最小的合法二进制，不下载、不依赖任何外部素材。

console.log('时长解析');

const durDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-sound-dur-'));
const durFile = (name) => path.join(durDir, name);

/** 最小 flac：只有 "fLaC" + 一个 STREAMINFO 块（类型 0，34 字节），其余字段留 0 */
function makeFlac({ sampleRate = 44100, totalSamples = 88200 } = {}) {
  const buf = Buffer.alloc(42); // 4 字节标记 + 4 字节块头 + 34 字节 STREAMINFO
  buf.write('fLaC', 0, 'latin1');
  buf[4] = 0x80; // bit7 = 最后一块，低 7 位 = 类型 0（STREAMINFO）
  buf.writeUIntBE(34, 5, 3);

  const si = 8;
  const bpsMinus1 = 15; // 16 bit
  const ts = BigInt(totalSamples);
  buf[si + 10] = (sampleRate >> 12) & 0xff; // sample_rate 20 bit
  buf[si + 11] = (sampleRate >> 4) & 0xff;
  buf[si + 12] = ((sampleRate & 0x0f) << 4) | (1 << 1) | ((bpsMinus1 >> 4) & 0x01); // 2 声道
  buf[si + 13] = ((bpsMinus1 & 0x0f) << 4) | Number((ts >> 32n) & 0x0fn); // total_samples 36 bit
  buf.writeUInt32BE(Number(ts & 0xffffffffn), si + 14);
  return buf;
}

/** 拼一个 MP4 盒子 */
function box(type, payload) {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(b.length, 0);
  b.write(type, 4, 'latin1');
  payload.copy(b, 8);
  return b;
}

/** mvhd：版本 0 是 32 位 duration，版本 1 是 64 位 */
function makeMvhd({ version = 0, timescale = 1000, duration = 2500 } = {}) {
  const payload = Buffer.alloc(version === 1 ? 112 : 100);
  payload[0] = version;
  if (version === 1) {
    payload.writeUInt32BE(timescale, 20);
    payload.writeBigUInt64BE(BigInt(duration), 24);
  } else {
    payload.writeUInt32BE(timescale, 12);
    payload.writeUInt32BE(duration, 16);
  }
  return box('mvhd', payload);
}

/** 最小 m4a：ftyp + [可选的大 free 盒 / 若干小 free 盒] + moov(mvhd) */
function makeM4a({ version = 0, timescale = 1000, duration = 2500, freeBytes = 0, freeCount = 0 } = {}) {
  const parts = [box('ftyp', Buffer.from('M4A isom', 'latin1'))];
  if (freeBytes > 0) parts.push(box('free', Buffer.alloc(freeBytes)));
  for (let i = 0; i < freeCount; i++) parts.push(box('free', Buffer.alloc(0)));
  parts.push(box('moov', makeMvhd({ version, timescale, duration })));
  return Buffer.concat(parts);
}

/** MPEG1 Layer III 帧头（44.1kHz，默认 128kbps 立体声） */
function mp3FrameHeader({ bitrateIndex = 9, sampleRateIndex = 0, channelMode = 0 } = {}) {
  return Buffer.from([0xff, 0xfb, (bitrateIndex << 4) | (sampleRateIndex << 2), channelMode << 6]);
}

/** ID3v2.3 头 + 100 字节空负载（syncsafe 声明长度） */
function makeId3(size = 100) {
  const id3 = Buffer.alloc(10);
  id3.write('ID3', 0, 'latin1');
  id3[3] = 3; // 版本 2.3
  id3[6] = (size >> 21) & 0x7f;
  id3[7] = (size >> 14) & 0x7f;
  id3[8] = (size >> 7) & 0x7f;
  id3[9] = size & 0x7f;
  return Buffer.concat([id3, Buffer.alloc(size)]);
}

/** CBR mp3：ID3 + 若干完全相同的 128kbps 帧 */
function makeCbrMp3({ frames = 100 } = {}) {
  const frameLen = Math.floor((144 * 128000) / 44100); // 417
  const frame = Buffer.alloc(frameLen);
  mp3FrameHeader().copy(frame, 0);
  const parts = [makeId3(100)];
  for (let i = 0; i < frames; i++) parts.push(frame);
  return Buffer.concat(parts);
}

/** 带 Xing 头的单帧 mp3：时长只由 Xing 里的帧数决定 */
function makeXingMp3({ frames = 100 } = {}) {
  const sideInfo = 32; // MPEG1 立体声
  const head = Buffer.alloc(4 + sideInfo + 12);
  mp3FrameHeader().copy(head, 0);
  head.write('Xing', 4 + sideInfo, 'latin1');
  head.writeUInt32BE(1, 4 + sideInfo + 4); // flags：有 frames 字段
  head.writeUInt32BE(frames, 4 + sideInfo + 8);
  const frame = Buffer.alloc(Math.floor((144 * 128000) / 44100)); // 417，正好一帧
  head.copy(frame, 0);
  return frame;
}

/** VBR mp3：前 6 帧 128kbps、后 6 帧 160kbps，没有 Xing */
function makeVbrMp3() {
  const parts = [];
  for (const spec of [
    { bitrateIndex: 9, bitrate: 128000, frames: 6 },
    { bitrateIndex: 11, bitrate: 160000, frames: 6 },
  ]) {
    const frameLen = Math.floor((144 * spec.bitrate) / 44100);
    for (let i = 0; i < spec.frames; i++) {
      const frame = Buffer.alloc(frameLen);
      mp3FrameHeader({ bitrateIndex: spec.bitrateIndex }).copy(frame, 0);
      parts.push(frame);
    }
  }
  return Buffer.concat(parts);
}

await step('㉑ flac：STREAMINFO 的 total_samples / sample_rate = 2 秒', async () => {
  const f = durFile('two-seconds.flac');
  await fs.writeFile(f, makeFlac({ sampleRate: 44100, totalSamples: 88200 }));
  assert((await readFlacDuration(f)) === 2, 'readFlacDuration 应为 2 秒');
  const d = await readDuration(f, '.flac');
  assert(d && d.duration === 2 && d.exact === true, 'readDuration 应给出精确的 2 秒');
  const d2 = await readDuration(f, 'FLAC'); // 不带点、大写也要认
  assert(d2 && d2.duration === 2, '扩展名大小写/无点应能归一');
});

await step('㉒ flac 坏数据：sample_rate=0 / 截断 → null', async () => {
  const zeroRate = durFile('zero-rate.flac');
  await fs.writeFile(zeroRate, makeFlac({ sampleRate: 0, totalSamples: 88200 }));
  assert((await readFlacDuration(zeroRate)) === null, '采样率 0 应返回 null');

  const truncated = durFile('truncated.flac');
  await fs.writeFile(truncated, Buffer.from('fLaC\x80\x00\x00\x22\x00\x00', 'latin1'));
  assert((await readFlacDuration(truncated)) === null, '截断的 flac 应返回 null');
});

await step('㉓ m4a：ftyp + moov(mvhd) = 2.5 秒，moov 不在开头也能顺着盒子链找到', async () => {
  const f = durFile('moov-late.m4a');
  await fs.writeFile(f, makeM4a({ freeBytes: 4096 })); // moov 前面压一个大 free 盒
  assert((await readM4aDuration(f)) === 2.5, 'readM4aDuration 应为 2.5 秒');
  const d = await readDuration(f, '.m4a');
  assert(d && d.duration === 2.5 && d.exact === true, 'readDuration 应给出精确的 2.5 秒');
});

await step('㉔ m4a：mvhd 版本 1 的 64 位 duration；超过 64 个 box 就放弃', async () => {
  const v1 = durFile('v1.m4a');
  await fs.writeFile(v1, makeM4a({ version: 1, timescale: 1000, duration: 2500 }));
  assert((await readM4aDuration(v1)) === 2.5, '版本 1 应能读出 2.5 秒');

  const many = durFile('many-boxes.m4a');
  await fs.writeFile(many, makeM4a({ freeCount: 70 })); // moov 排在第 71 个盒子里
  assert((await readM4aDuration(many)) === null, '超过 64 个 box 应停止扫描并返回 null');
});

await step('㉕ mp3 CBR：无 Xing 时按字节数估算，并标记为估算', async () => {
  const f = durFile('cbr.mp3');
  await fs.writeFile(f, makeCbrMp3({ frames: 100 }));
  const r = await readMp3Duration(f);
  assert(r && r.exact === false, 'CBR 估算应标记 exact=false');
  assert(r.duration > 2.4 && r.duration < 2.8, '估算应落在 2.4~2.8 秒，实际 ' + (r && r.duration));
  const d = await readDuration(f, 'mp3');
  assert(d && d.duration === r.duration && d.exact === false, 'readDuration 应原样透出估算标记');
});

await step('㉖ mp3 + Xing：按帧数给出精确时长', async () => {
  const f = durFile('xing.mp3');
  await fs.writeFile(f, makeXingMp3({ frames: 100 }));
  const r = await readMp3Duration(f);
  assert(r && r.exact === true, '有 Xing 应标记 exact=true');
  // 100 帧 × 1152 采样 / 44100 = 2.61224…，取 3 位小数
  assert(r.duration === 2.612, '100 帧应约等于 2.612 秒，实际 ' + (r && r.duration));
});

await step('㉗ mp3 VBR 无 Xing：宁返回 null，不给偏得离谱的估算', async () => {
  const f = durFile('vbr-no-xing.mp3');
  await fs.writeFile(f, makeVbrMp3());
  assert((await readMp3Duration(f)) === null, 'VBR 无 Xing 应返回 null');
  assert((await readDuration(f, '.mp3')) === null, 'readDuration 也应返回 null');
});

await step('㉘ 坏文件：随机字节 / 空文件 / 不存在的路径 → null 且不抛异常', async () => {
  const junk = durFile('junk.bin');
  const random = Buffer.alloc(4096);
  let x = 12345;
  for (let i = 0; i < random.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff; // 确定性伪随机，便于复现
    random[i] = (x >> 16) & 0xff;
  }
  await fs.writeFile(junk, random);

  const empty = durFile('empty.mp3');
  await fs.writeFile(empty, Buffer.alloc(0));

  const cases = [
    ['随机字节', junk],
    ['空文件', empty],
    ['不存在的文件', durFile('nope.flac')],
  ];
  for (const [name, file] of cases) {
    for (const [label, fn] of [
      ['flac', readFlacDuration],
      ['m4a', readM4aDuration],
      ['mp3', readMp3Duration],
    ]) {
      const v = await fn(file);
      assert(v === null, name + ' → ' + label + ' 应返回 null，实际 ' + JSON.stringify(v));
    }
  }
});

await step('㉙ readDuration 按扩展名分派：非 ogg 内容 / aac / 未知扩展名 → null', async () => {
  const f = durFile('one-second.wav');
  await fs.writeFile(f, makeWav(1));
  const wav = await readDuration(f, '.wav');
  assert(wav && wav.duration === 1 && wav.exact === true, 'wav 分派应得到精确的 1 秒');
  assert((await readDuration(f, '.ogg')) === null, 'wav 内容冒充 ogg 时应返回 null');
  assert((await readDuration(f, '.aac')) === null, '.aac（ADTS）未支持，应返回 null');
  assert((await readDuration(f, '.xyz')) === null, '未知扩展名应返回 null');
  assert((await readDuration(f, '')) === null, '空扩展名应返回 null');
});

// -------------------------------------------------------- ogg 时长（新增） ---
//
// 用 Node 现场拼最小合法 Ogg 页，不下载、不用 ffmpeg。页头 27 字节，段表每字节
// 0..255，负载长度 = 段表各字节之和；CRC 留 0（解析刻意不校验 CRC，与真实文件行为一致）。

/** 拼一个 Ogg 页；payload 长度必须与 segments 之和一致 */
function oggPage({ headerType = 0, granule = 0, serial = 0x1234, seq = 0, segments, payload }) {
  const segTable = Buffer.from(segments);
  const hdr = Buffer.alloc(27 + segTable.length);
  hdr.write('OggS', 0, 'latin1');
  hdr[4] = 0; // version
  hdr[5] = headerType;
  hdr.writeBigInt64LE(BigInt(granule), 6);
  hdr.writeUInt32LE(serial, 14);
  hdr.writeUInt32LE(seq, 18);
  hdr.writeUInt32LE(0, 22); // CRC 不校验，留 0
  hdr[26] = segTable.length;
  segTable.copy(hdr, 27);
  return Buffer.concat([hdr, payload]);
}

/** Vorbis 标识头（30 字节）：类型 1 + "vorbis" + 版本 + 声道 + 采样率 + 三个比特率 + 块大小 + framing */
function vorbisIdent({ sampleRate = 44100, channels = 1 } = {}) {
  const b = Buffer.alloc(30);
  b[0] = 1;
  b.write('vorbis', 1, 'latin1');
  b.writeUInt32LE(0, 7); // vorbis_version
  b[11] = channels;
  b.writeUInt32LE(sampleRate, 12);
  b.writeUInt32LE(0, 16); // bitrate_maximum
  b.writeUInt32LE(128000, 20); // bitrate_nominal
  b.writeUInt32LE(0, 24); // bitrate_minimum
  b[28] = 0xb8; // blocksize
  b[29] = 1; // framing
  return b;
}

/** Opus 标识头（19 字节） */
function opusHead({ preSkip = 312, channels = 2 } = {}) {
  const b = Buffer.alloc(19);
  b.write('OpusHead', 0, 'latin1');
  b[8] = 1; // version
  b[9] = channels;
  b.writeUInt16LE(preSkip, 10);
  b.writeUInt32LE(48000, 12); // input sample rate（只作提示，不参与换算）
  b.writeInt16LE(0, 16); // output gain
  b[18] = 0; // mapping family
  return b;
}

/** 最小 Vorbis 流：BOS 标识页 + 一个 EOS 页（granule 决定时长） */
function makeVorbisOgg({ sampleRate = 44100, seconds = 2, eosGranule = null, eosHeaderType = 0x04 } = {}) {
  const ident = oggPage({
    headerType: 0x02, // BOS
    granule: 0,
    seq: 0,
    segments: [30],
    payload: vorbisIdent({ sampleRate }),
  });
  const granule = eosGranule == null ? Math.round(seconds * sampleRate) : eosGranule;
  const tail = oggPage({
    headerType: eosHeaderType,
    granule,
    seq: 1,
    segments: [10],
    payload: Buffer.alloc(10),
  });
  return Buffer.concat([ident, tail]);
}

/** 最小 Opus 流：BOS 标识页 + EOS 页（granule 单位恒为 48kHz 采样数） */
function makeOpusOgg({ granule = 48000 } = {}) {
  const ident = oggPage({ headerType: 0x02, granule: 0, seq: 0, segments: [19], payload: opusHead() });
  const tail = oggPage({ headerType: 0x04, granule, seq: 1, segments: [8], payload: Buffer.alloc(8) });
  return Buffer.concat([ident, tail]);
}

/** 确定性伪随机字节（不引入依赖，便于复现） */
function pseudoRandom(size, seed = 12345) {
  const buf = Buffer.alloc(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = (x >> 16) & 0xff;
  }
  return buf;
}

console.log('ogg 时长');

await step('ogg-1 Vorbis：最后一个 EOS 页的 granule / 采样率 = 2 秒，且标记为精确', async () => {
  const f = durFile('two-seconds.ogg');
  await fs.writeFile(f, makeVorbisOgg({ sampleRate: 44100, seconds: 2 }));
  const r = await readOggDuration(f);
  assert(r && r.duration === 2, '应为 2 秒，实际 ' + JSON.stringify(r));
  assert(r.exact === true, 'EOS 页在文件尾时应标记 exact=true');
  const d = await readDuration(f, '.ogg');
  assert(d && d.duration === 2 && d.exact === true, 'readDuration 应原样透出 2 秒/精确');
  const d2 = await readDuration(f, 'OGG'); // 大写、不带点也要认
  assert(d2 && d2.duration === 2, '扩展名归一化失败');
});

await step('ogg-2 granule 为 -1 的 EOS 页：回退到上一个有效页，并标记为估算', async () => {
  const f = durFile('minus-one-granule.ogg');
  const ident = oggPage({ headerType: 0x02, granule: 0, seq: 0, segments: [30], payload: vorbisIdent({}) });
  const mid = oggPage({ headerType: 0, granule: 44100, seq: 1, segments: [10], payload: Buffer.alloc(10) });
  const eos = oggPage({ headerType: 0x04, granule: -1, seq: 2, segments: [10], payload: Buffer.alloc(10) });
  await fs.writeFile(f, Buffer.concat([ident, mid, eos]));

  const r = await readOggDuration(f);
  assert(r && r.duration === 1, '应回退到上一个有效 granule（1 秒），实际 ' + JSON.stringify(r));
  assert(r.exact === false, '回退得到的时长不是最终采样数，应标记 exact=false');
});

await step('ogg-3 截断文件（没有 EOS 页）：给出时长但 exact=false', async () => {
  const f = durFile('no-eos.ogg');
  const ident = oggPage({ headerType: 0x02, granule: 0, seq: 0, segments: [30], payload: vorbisIdent({}) });
  // 最后一个页没有 EOS 位，模拟录制/传输中途截断
  const last = oggPage({ headerType: 0, granule: 44100, seq: 1, segments: [10], payload: Buffer.alloc(10) });
  await fs.writeFile(f, Buffer.concat([ident, last]));

  const r = await readOggDuration(f);
  assert(r && r.duration === 1, '应算出 1 秒，实际 ' + JSON.stringify(r));
  assert(r.exact === false, '没有 EOS 页应标记为估算');

  const d = await readDuration(f, '.ogg');
  assert(d && d.duration === 1 && d.exact === false, 'readDuration 应透出估算标记');
});

await step('ogg-4 Opus：granule / 48000 = 1.0 秒（与头里的输入采样率无关）', async () => {
  const f = durFile('one-second.opus.ogg');
  await fs.writeFile(f, makeOpusOgg({ granule: 48000 }));
  const r = await readOggDuration(f);
  assert(r && r.duration === 1, '应为 1 秒，实际 ' + JSON.stringify(r));
  assert(r.exact === true, 'EOS 页应标记精确');

  // 同样是 EOS，granule 写成 96000 就是 2 秒：确认用 48k 时钟而不是别的数
  const f2 = durFile('two-seconds.opus.ogg');
  await fs.writeFile(f2, makeOpusOgg({ granule: 96000 }));
  const r2 = await readOggDuration(f2);
  assert(r2 && r2.duration === 2, 'granule=96000 应为 2 秒，实际 ' + JSON.stringify(r2));
});

await step('ogg-5 随机字节 / 空文件 / 非 ogg 内容 / 不存在的路径 → { duration:null, exact:null }', async () => {
  const junk = durFile('junk-ogg.bin');
  await fs.writeFile(junk, pseudoRandom(4096, 999));

  const empty = durFile('empty.ogg');
  await fs.writeFile(empty, Buffer.alloc(0));

  // 只坏了 version 或段表的「像 ogg」的文件也必须拒绝
  const badVersion = durFile('bad-version.ogg');
  const page = makeVorbisOgg({});
  page[4] = 1; // version 非 0
  await fs.writeFile(badVersion, page);

  const wavAsOgg = durFile('wav-as-ogg.ogg');
  await fs.writeFile(wavAsOgg, makeWav(1));

  for (const [name, file] of [
    ['随机字节', junk],
    ['空文件', empty],
    ['version 非 0', badVersion],
    ['wav 冒充 ogg', wavAsOgg],
    ['不存在的文件', durFile('nope.ogg')],
  ]) {
    const r = await readOggDuration(file);
    assert(r && r.duration === null && r.exact === null, name + ' 应返回 {null,null}，实际 ' + JSON.stringify(r));
    assert((await readDuration(file, '.ogg')) === null, name + ' → readDuration 应返回 null');
  }
});

await step('ogg-6 1MB 假 ogg（中间整段垃圾）：只读尾部也能算出时长，且 < 100ms', async () => {
  const f = durFile('big-garbage.ogg');
  const ident = oggPage({ headerType: 0x02, granule: 0, seq: 0, segments: [30], payload: vorbisIdent({}) });
  const garbage = pseudoRandom(1024 * 1024, 424242); // 中间 1MB 随机字节
  const eos = oggPage({ headerType: 0x04, granule: 88200, seq: 1, segments: [10], payload: Buffer.alloc(10) });
  await fs.writeFile(f, Buffer.concat([ident, garbage, eos]));

  const t0 = performance.now();
  const r = await readOggDuration(f);
  const ms = performance.now() - t0;
  assert(r && r.duration === 2 && r.exact === true, '应算出 2 秒/精确，实际 ' + JSON.stringify(r));
  assert(ms < 100, '1MB 文件不该整文件读，耗时 ' + ms.toFixed(1) + 'ms 超过 100ms');
});

await step('ogg-7 scanLocal 把 exact 透到 durationExact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-ogg-lib-'));
  await fs.mkdir(path.join(root, 'kenney-ogg', 'ui'), { recursive: true });
  await fs.writeFile(path.join(root, 'kenney-ogg', 'ui', 'two.ogg'), makeVorbisOgg({ seconds: 2 }));
  await fs.writeFile(path.join(root, 'kenney-ogg', 'ui', 'one.opus.ogg'), makeOpusOgg({ granule: 48000 }));

  const saved = process.env.DSH_SOUND_LIB;
  process.env.DSH_SOUND_LIB = root;
  try {
    const entries = await scanLocal();
    assert(entries.length === 2, '应扫出 2 条，实际 ' + entries.length);
    const two = entries.find((e) => e.providerId === 'kenney-ogg/ui/two.ogg');
    const one = entries.find((e) => e.providerId === 'kenney-ogg/ui/one.opus.ogg');
    assert(two.duration === 2 && two.durationExact === true, 'vorbis 条目时长/精确标记不对：' + JSON.stringify(two));
    assert(one.duration === 1 && one.durationExact === true, 'opus 条目时长/精确标记不对：' + JSON.stringify(one));
  } finally {
    if (saved === undefined) delete process.env.DSH_SOUND_LIB;
    else process.env.DSH_SOUND_LIB = saved;
    await fs.rm(root, { recursive: true, force: true });
  }
});

// 真实目录：只读扫一次，报条目数 / 时长命中率 / 耗时（目录不存在就跳过，不影响其它断言）
const REAL_OGG_DIR = '~\\.dsh\\sound-library\\kenney';
await step('ogg-8 真实目录扫描：报条目数 / 时长命中率 / 总耗时', async () => {
  let st;
  try {
    st = await fs.stat(REAL_OGG_DIR);
  } catch {
    console.log('       （跳过：本机没有 ' + REAL_OGG_DIR + '）');
    return;
  }
  assert(st.isDirectory(), REAL_OGG_DIR + ' 不是目录');

  const saved = process.env.DSH_SOUND_LIB;
  process.env.DSH_SOUND_LIB = REAL_OGG_DIR;
  try {
    const t0 = performance.now();
    const entries = await scanLocal();
    const ms = performance.now() - t0;
    const known = entries.filter((e) => e.duration != null);
    const exact = entries.filter((e) => e.durationExact === true);
    const ratio = entries.length ? Math.round((known.length / entries.length) * 100) : 0;
    console.log(
      '       ' +
        entries.length +
        ' 条 / 算出时长 ' +
        known.length +
        '（' +
        ratio +
        '%）/ 精确 ' +
        exact.length +
        ' / 耗时 ' +
        ms.toFixed(0) +
        'ms',
    );
    assert(entries.length > 0, '真实目录应扫出条目');
    // 753 个 ogg 是主路径：命中率低于一半就说明解析退化了
    assert(ratio >= 50, '真实目录时长命中率过低：' + ratio + '%');
  } finally {
    if (saved === undefined) delete process.env.DSH_SOUND_LIB;
    else process.env.DSH_SOUND_LIB = saved;
  }
});

// ------------------------------------------------------ 多根目录（新增） ---
//
// 这一段会临时改 DSH_SOUND_LIB / DSH_SOUND_SOURCES，结束时恢复成单根临时库，
// 不影响前面已有的断言。

console.log('多根目录');

const multiBase = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-sound-multi-'));
const rootA = path.join(multiBase, 'root-a');
const rootB = path.join(multiBase, 'root-b');
await fs.mkdir(path.join(rootA, 'shared'), { recursive: true });
await fs.mkdir(path.join(rootB, 'shared'), { recursive: true });
await fs.writeFile(path.join(rootA, 'shared', 'hit.wav'), makeWav(1));
await fs.writeFile(path.join(rootB, 'shared', 'hit.wav'), makeWav(2));

const multiConfig = path.join(multiBase, 'sound-sources.json');
await fs.writeFile(
  multiConfig,
  JSON.stringify({
    roots: [
      { name: 'alpha', path: rootA },
      { name: 'beta', path: rootB },
    ],
  }),
);

delete process.env.DSH_SOUND_LIB;
process.env.DSH_SOUND_SOURCES = multiConfig;

await step('㉚ 两个根都扫描，跨根同名文件 id 不冲突', async () => {
  const roots = await soundSourcesRoots();
  assert(roots.length === 2, '应有两个根，实际 ' + roots.length);
  assert(roots[0].name === 'alpha' && roots[1].name === 'beta', '根名或顺序不对');
  assert(soundSourcesFile() === multiConfig, 'DSH_SOUND_SOURCES 应覆盖配置文件路径');

  const entries = await scanLocal();
  assert(entries.length === 2, '两个根应扫出 2 条，实际 ' + entries.length);
  assert(entries.every((e) => e.providerId === 'shared/hit.wav'), 'providerId 应相同');
  assert(entries[0].id !== entries[1].id, '跨根同名文件 id 不应相同');
  assert(entries[0].root === 'alpha' && entries[1].root === 'beta', 'root 字段不对');
  assert(entries[0].duration === 1 && entries[1].duration === 2, '各自时长应独立');
});

await step('㉛ 同一相对路径在两个根解析到各自文件；local: 写法命中第一个根', async () => {
  const entries = await scanLocal();
  const a = await resolveLocalPath(entries[0].id);
  const b = await resolveLocalPath(entries[1].id);
  assert(path.resolve(a).startsWith(path.resolve(rootA)), 'alpha 条目应解析到 root-a：' + a);
  assert(path.resolve(b).startsWith(path.resolve(rootB)), 'beta 条目应解析到 root-b：' + b);

  const viaRaw = await resolveLocalPath('local:shared/hit.wav');
  assert(path.resolve(viaRaw).startsWith(path.resolve(rootA)), 'local: 写法应命中第一个根');
});

await step('㉜ 多根下越界仍抛 OUTSIDE_LIB', async () => {
  await expectCode(() => resolveLocalPath('local:../outside.wav'), 'OUTSIDE_LIB');
  await expectCode(() => resolveLocalPath('local:shared/../../outside.wav'), 'OUTSIDE_LIB');
  await expectCode(() => resolveLocalPath('local:D:/Windows/win.ini'), 'OUTSIDE_LIB');
});

await step('㉝ 配置坏掉 / roots 为空 → 回退默认根，并给出 warning', async () => {
  const broken = path.join(multiBase, 'broken.json');
  await fs.writeFile(broken, '{ 这不是 JSON');
  process.env.DSH_SOUND_SOURCES = broken;

  const roots = await soundSourcesRoots();
  assert(roots.length === 1 && roots[0].name === 'default', '坏配置应回退默认根：' + JSON.stringify(roots));
  assert(path.resolve(roots[0].path) === path.resolve(soundRoot()), '默认根路径不对');
  const loaded = await loadSoundSources();
  assert(loaded.warning && loaded.warning.includes('JSON'), '应给出坏 JSON 的 warning：' + loaded.warning);

  const empty = path.join(multiBase, 'empty.json');
  await fs.writeFile(empty, JSON.stringify({ roots: [] }));
  process.env.DSH_SOUND_SOURCES = empty;
  const fallback = await soundSourcesRoots();
  assert(fallback.length === 1 && fallback[0].name === 'default', '空 roots 应回退默认根');

  process.env.DSH_SOUND_SOURCES = multiConfig;
});

await step('㉞ 首次启动：有 D 盘库目录时自动建 kenney 与配置（可重复跑）', async () => {
  const fakeDrive = path.join(multiBase, 'fake-drive');
  const baseD = path.join(fakeDrive, '音效库');
  await fs.mkdir(baseD, { recursive: true });
  const cfg = path.join(multiBase, 'auto-config.json');

  const result = await ensureDefaultSoundSources({ baseDir: baseD, configFile: cfg });
  assert(result.created === true, '应创建配置：' + JSON.stringify(result));
  assert((await fs.stat(path.join(baseD, 'kenney'))).isDirectory(), '应建出 kenney 目录');

  const saved = JSON.parse(await fs.readFile(cfg, 'utf8'));
  assert(saved.roots.length === 1 && saved.roots[0].name === 'kenney', '配置 roots 不对');
  assert(
    path.resolve(saved.roots[0].path) === path.resolve(path.join(baseD, 'kenney')),
    '配置路径应指向 kenney 子目录',
  );

  const again = await ensureDefaultSoundSources({ baseDir: baseD, configFile: cfg });
  assert(again.created === false, '已有配置时不应重建');
});

await step('㉟ 自动建库写失败：不崩，回退默认并给 warning', async () => {
  const fakeDrive = path.join(multiBase, 'fake-drive-2');
  const baseD = path.join(fakeDrive, '音效库');
  await fs.mkdir(baseD, { recursive: true });
  const blocker = path.join(multiBase, 'blocked-file');
  await fs.writeFile(blocker, 'x'); // 拿文件当目录用，写配置一定失败

  const result = await ensureDefaultSoundSources({
    baseDir: baseD,
    configFile: path.join(blocker, 'sound-sources.json'),
  });
  assert(result.created === false, '写失败不应报 created');
  assert(typeof result.warning === 'string' && result.warning.length > 0, '应给 warning');
  assert(/回退|默认/.test(result.warning), 'warning 应说明回退默认根：' + result.warning);
});

await step('㊱ soundSources 返回 roots: [{name, path, count}]', async () => {
  const v = await soundSources();
  assert(Array.isArray(v.roots) && v.roots.length === 2, 'roots 应为 2 条');
  assert(v.roots[0].name === 'alpha' && v.roots[0].count === 1, 'alpha count 不对');
  assert(v.roots[1].name === 'beta' && v.roots[1].count === 1, 'beta count 不对');
  assert(path.resolve(v.roots[0].path) === path.resolve(rootA), 'alpha path 不对');
  assert(path.resolve(v.localRoot) === path.resolve(rootA), 'localRoot 应取第一个根');
  assert(v.localCount === 2, 'localCount 应为 2');
});

// 恢复成原来的单根临时库，后面的 Kenney / 导入测试沿用 libRoot
delete process.env.DSH_SOUND_SOURCES;
process.env.DSH_SOUND_LIB = libRoot;

// ------------------------------------------------------------ Kenney 解析 ---

console.log('Kenney 解析');

const SAMPLE_KENNEY_HTML = `
<div class='col-md-3'>
  <div class='asset'>
    <a href='https://kenney.nl/assets/ui-audio'><div class='cover'></div></a>
    <h2><a href='https://kenney.nl/assets/ui-audio'>UI &amp; Interface Audio</a></h2>
    <span class='bold text-muted'><a href='https://kenney.nl/assets/category:Audio'>Audio</a></span>
  </div>
</div>
<div class='col-md-3'>
  <div class='asset'>
    <h2><a href='/assets/impact-sounds'>Impact Sounds</a></h2>
  </div>
</div>
<a href='https://kenney.nl/assets/category:Audio'>Audio</a>
<a href='https://kenney.nl/assets/ui-audio'>重复链接</a>
`;

await step('㊲ 解析资源页：抓 h2 链接、去重、过滤分类入口', async () => {
  const parsed = parseKenneyPacks(SAMPLE_KENNEY_HTML);
  assert(parsed.packs.length === 2, '应解析出 2 个包，实际 ' + parsed.packs.length);

  const ui = parsed.packs.find((p) => p.id === 'ui-audio');
  assert(ui, '应解析出 ui-audio');
  assert(ui.title === 'UI & Interface Audio', '标题实体未解码：' + ui.title);
  assert(ui.url === 'https://kenney.nl/assets/ui-audio', 'URL 不对：' + ui.url);
  assert(parsed.packs.every((p) => p.license === 'CC0'), 'license 应为 CC0');
  assert(!parsed.packs.some((p) => p.id.includes('category')), '分类入口不应算资源包');
});

await step('㊳ 解析不到时返回空数组 + 原因，不抛', async () => {
  const parsed = parseKenneyPacks('<html><body><p>页面改版了</p></body></html>');
  assert(Array.isArray(parsed.packs) && parsed.packs.length === 0, '应为空数组');
  assert(typeof parsed.reason === 'string' && parsed.reason.length > 0, '应给原因');
});

await step('㊴ 非 kenney.nl 地址拒绝（不做任意 URL 下载器）', async () => {
  await expectCode(() => installKenneyPack({ packUrl: 'https://example.com/pack.zip' }), 'INVALID_ARG');
  await expectCode(
    () => downloadKenneyPack('https://example.com/pack.zip', path.join(libRoot, 'whatever')),
    'INVALID_ARG',
  );
});

await step('㊵ 坏 zip：解压失败但给出中文原因（已下载但需手动解压）', async () => {
  const badDir = path.join(multiBase, 'bad-zip');
  await fs.mkdir(badDir, { recursive: true });
  const badZip = path.join(badDir, 'bad.zip');
  await fs.writeFile(badZip, '这不是 zip');
  const dest = path.join(badDir, 'out');
  await fs.mkdir(dest, { recursive: true });

  const result = await extractZip(badZip, dest);
  assert(result.ok === false, '坏 zip 不应解压成功');
  assert(/手动解压/.test(result.reason || ''), '原因应说明需手动解压：' + result.reason);
  assert(/tar|PowerShell|Expand-Archive/.test(result.reason || ''), '原因应说明试过哪些解压器：' + result.reason);
});

// -------------------------------------------------------------- URL 导入 ---

console.log('URL 导入');

const wavBytes = makeWav(1);
const httpServer = http.createServer((req, res) => {
  if (req.url.startsWith('/beep.wav')) {
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(wavBytes.length) });
    res.end(wavBytes);
  } else if (req.url.startsWith('/page')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html>这不是音频</html>');
  } else if (req.url.startsWith('/big')) {
    // 声明长度就超限：宿主应在读 body 前拒绝，不用真的传 60MB
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(60 * 1024 * 1024) });
    res.end(wavBytes);
  } else {
    res.writeHead(404);
    res.end('no');
  }
});
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
const httpPort = httpServer.address().port;
const localUrl = (p) => 'http://127.0.0.1:' + httpPort + p;

await step('㊶ 协议校验：file:// / ftp:// / 非法串一律 INVALID_ARG', async () => {
  await expectCode(() => importSoundFromUrl('file:///C:/Windows/win.ini'), 'INVALID_ARG');
  await expectCode(() => importSoundFromUrl('ftp://example.com/a.mp3'), 'INVALID_ARG');
  await expectCode(() => importSoundFromUrl('not a url'), 'INVALID_ARG');
  await expectCode(() => importSoundFromUrl(''), 'INVALID_ARG');
});

await step('㊷ 非音频响应（text/html 且无音频后缀）拒绝并说明原因', async () => {
  const err = await expectCode(() => importSoundFromUrl(localUrl('/page')), 'DOWNLOAD_FAILED');
  assert(/不是音频|audio/.test(err.message), '错误消息应说明不是音频：' + err.message);
});

await step('㊸ 超过 50MB 上限拒绝（按声明长度即拦）', async () => {
  const err = await expectCode(() => importSoundFromUrl(localUrl('/big')), 'DOWNLOAD_FAILED');
  assert(err.message.includes('50MB'), '错误消息应提到 50MB：' + err.message);
});

await step('㊹ 成功导入：落到 <root>/<域名>/<文件名>，wav 时长 1 秒', async () => {
  const entry = await importSoundFromUrl(localUrl('/beep.wav'));
  assert(entry.provider === 'local', 'provider 应为 local');
  assert(entry.root === 'default', '应落在 default 根');
  assert(/^[0-9a-f]{12}$/.test(entry.id), 'id 应为 12 位十六进制');
  assert(entry.duration === 1 && entry.durationExact === true, '1 秒 wav 时长不对：' + entry.duration);
  assert(entry.providerId === '127.0.0.1/beep.wav', 'providerId 不对：' + entry.providerId);

  const expectAbs = path.join(libRoot, '127.0.0.1', 'beep.wav');
  assert(path.resolve(entry.file) === path.resolve(expectAbs), '归档路径不对：' + entry.file);
  await fs.access(expectAbs);
});

await step('㊺ 重名自动加 -1 后缀', async () => {
  const entry = await importSoundFromUrl(localUrl('/beep.wav'));
  assert(path.basename(entry.file) === 'beep-1.wav', '重名应加 -1，实际 ' + path.basename(entry.file));
  await fs.access(path.join(libRoot, '127.0.0.1', 'beep-1.wav'));
});

await step('㊻ sound.import RPC：返回 { entry }，scanLocal 能看到', async () => {
  const v = await call('sound.import', { url: localUrl('/beep.wav') });
  assert(v && v.entry && v.entry.id, '应返回 entry');
  assert(path.basename(v.entry.file) === 'beep-2.wav', '第三个同名应加 -2：' + v.entry.file);

  const entries = await scanLocal();
  assert(entries.some((e) => e.id === v.entry.id), 'scanLocal 应能看到导入的音效');
  assert(entries.some((e) => e.providerId === '127.0.0.1/beep-2.wav'), 'providerId 应正确');
});

await step('㊼ sound.kenney.install RPC：非 kenney 地址回结构化错误', async () => {
  const res = fakeRes();
  const req = fakeReq('POST', '/api/video/rpc', {
    method: 'sound.kenney.install',
    params: { packUrl: 'https://example.com/x.zip' },
  });
  await routes.find((r) => r.path === '/api/video/rpc').handler(req, res);
  const payload = JSON.parse(res.body);
  assert(payload.ok === false, '应返回 ok:false');
  assert(payload.error && payload.error.code === 'INVALID_ARG', 'code 应为 INVALID_ARG：' + payload.error.code);
});

await new Promise((resolve) => httpServer.close(resolve));
await fs.rm(multiBase, { recursive: true, force: true });

await fs.rm(durDir, { recursive: true, force: true });

await fs.rm(root1, { recursive: true, force: true });
await fs.rm(root3, { recursive: true, force: true });
await fs.rm(libRoot, { recursive: true, force: true });

console.log('\n声音库测试：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
