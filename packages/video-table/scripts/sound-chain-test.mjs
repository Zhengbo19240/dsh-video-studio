/**
 * 音频链路（四条真实抱怨）回归测试：
 *   1) 多词 AND 搜索 0 结果 → 自动降级（degraded / degradedQuery / warnings）
 *   2) minDuration 时长下限（在线 filter、本地过滤、min > max 拒绝）+ loopable 提示
 *   3) video_sound_fetch：只拿文件不插时间线、不占租约、落 assets/sfx/
 *   4) 所有 video_sound_* 返回体都是 lossless JSON
 *
 *   node scripts/sound-chain-test.mjs
 *
 * 全部离线：Freesound 走桩 fetch，不依赖真 API / 真网络。
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.mjs';
import { soundTools, searchSounds } from '../src/sound-tools.mjs';
import { searchFreesound, rememberEntries } from '../src/sound-freesound.mjs';
import { scanLocal } from '../src/sound-lib.mjs';
import { sanitizeJson, scanLossy, errorJson } from '../src/json-safe.mjs';

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('sound-chain');

// --------------------------------------------------------------- 断言框架 ---

let pass = 0;
const failures = [];

async function step(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    failures.push(name + ': ' + (e && e.message));
    console.log('  FAIL ' + name + ' — ' + (e && e.message));
  }
}

async function expectCode(fn, code) {
  try {
    await fn();
  } catch (e) {
    if (e && e.code !== code) {
      throw new Error('期望 ' + code + '，实际 ' + (e && e.code) + '（' + (e && e.message) + '）');
    }
    return e;
  }
  throw new Error('应当抛 ' + code + '，但没有抛');
}

/** 递归找 undefined / NaN / Infinity / function —— 这些都会让 JSON 往返失真 */
function scanBad(value, pathStr = '$', out = []) {
  if (value === undefined) out.push(pathStr + ': undefined');
  else if (typeof value === 'number' && !Number.isFinite(value)) out.push(pathStr + ': ' + value);
  else if (typeof value === 'function') out.push(pathStr + ': function');
  else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      if (value[k] === undefined) out.push(pathStr + '.' + k + ': undefined');
      else scanBad(value[k], pathStr + '.' + k, out);
    }
  }
  return out;
}

/** 深扫 + JSON 往返等价：这就是工具层「lossless JSON」闸门的判据 */
function assertLossless(value, label) {
  const bad = scanBad(value);
  assert.equal(bad.length, 0, label + ' 含非法值: ' + bad.join(', '));
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, label + ' JSON 往返后结构不一致');
}

// ------------------------------------------------------------- 临时声音库 ---

const libRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-chain-lib-'));
const savedEnv = {
  DSH_SOUND_LIB: process.env.DSH_SOUND_LIB,
  DSH_SOUND_INDEX: process.env.DSH_SOUND_INDEX,
  FREESOUND_API_KEY: process.env.FREESOUND_API_KEY,
};
process.env.DSH_SOUND_LIB = libRoot;
// 指到一个不存在的索引：断言里不会被本机真实声学索引干扰
process.env.DSH_SOUND_INDEX = path.join(libRoot, 'no-such-index.json');
delete process.env.FREESOUND_API_KEY;

/** 造一个只有头部、dataSize 声明为 seconds 秒的 wav（PCM 8kHz 16bit 单声道） */
function makeWav(seconds, seed = 0) {
  const sampleRate = 8000;
  const dataSize = Math.round(sampleRate * 2 * seconds);
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  // seed 进文件尾：同长度但内容不同，用来测「同名不同内容 → 加后缀」
  if (seed) return Buffer.concat([buf, Buffer.from('seed-' + seed)]);
  return buf;
}

async function put(rel, bytes, meta) {
  const abs = path.join(libRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  if (meta) await fs.writeFile(abs + '.json', JSON.stringify(meta));
}

await put('kenney/ui/impact.wav', makeWav(2), { title: '重击', tags: ['impact', 'hit'], license: 'CC0' });
await put('kenney/ui/short.wav', makeWav(0.2), { title: '短点击', tags: ['click', 'ui'], license: 'CC0' });
// 30 秒的环境/BGM：测 minDuration 时要能被挑出来
await put('kenney/music/ambient-bed.wav', makeWav(30), {
  title: 'Ambient Bed',
  tags: ['ambient', 'music'],
  license: 'CC0',
});
// 降级要用的「常见词」条目：只有 corporate
await put('kenney/corporate/corporate.wav', makeWav(5), {
  title: 'Corporate',
  tags: ['corporate'],
  license: 'CC0',
});
// 时长测不出来：4 字节 ID3 头，mp3 解析会返回 null
await put('kenney/ui/unknown.mp3', Buffer.from([0x49, 0x44, 0x33, 0x03]), { title: 'Unknown Len', tags: ['click'] });
// 和 impact 同名、内容不同的另一个 pack：测「重名加 -1」
await put('other/impact.wav', makeWav(3, 7), { title: '重击（另一份）', tags: ['impact'], license: 'CC0' });

const libEntries = await scanLocal();
const entryOf = (providerId) => libEntries.find((e) => e.providerId === providerId);

// ------------------------------------------------------------------ 工具 ---

const store = new ProjectStore();
const projRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-chain-proj-'));
const SESSION = 'session-sound-chain';
const doc = await store.open(projRoot, SESSION);
const projectId = doc.projectId;

const tools = soundTools({ store });
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const call = (name, args = {}) => byName[name].execute(args, { agent: { id: SESSION } });

// 让默认工程里没有任何租约，后面「fetch 不占租约」才说得清
for (const lease of store.listLeases(projectId)) store.releaseLease(projectId, lease.leaseId, SESSION);

// ---------------------------------------------------------------- 桩 fetch ---

const realFetch = globalThis.fetch;

/** 装桩：handler(url) 返回 Response 形状的对象；restore 必须放 finally */
function stubFetch(handler, { withKey = true } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'FREESOUND_API_KEY');
  const oldKey = process.env.FREESOUND_API_KEY;
  if (withKey) process.env.FREESOUND_API_KEY = 'stub-key';
  else if (!hadKey) delete process.env.FREESOUND_API_KEY;
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
      if (hadKey) process.env.FREESOUND_API_KEY = oldKey;
      else delete process.env.FREESOUND_API_KEY;
    },
  };
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => payload,
  };
}

function fsRecord(id, { name, duration = 5, tags = [], downloads = 100, rating = 4.5, ratings = 10 } = {}) {
  return {
    id,
    name: name || 'sound ' + id,
    previews: { 'preview-hq-mp3': 'https://cdn.example.test/' + id + '.mp3' },
    duration,
    tags,
    num_downloads: downloads,
    avg_rating: rating,
    num_ratings: ratings,
    license: 'http://creativecommons.org/publicdomain/zero/1.0/',
    username: 'tester',
    url: 'https://freesound.org/s/' + id + '/',
  };
}

/** 按 query 决定返回什么：降级测试要能看到「只有 corporate 有结果」 */
function searchByQuery(byQuery) {
  return (url) => {
    if (!url.includes('/apiv2/search/text/')) {
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), arrayBuffer: async () => Buffer.alloc(0) };
    }
    const q = new URL(url).searchParams.get('query');
    const results = byQuery[q] || [];
    return jsonResponse({ count: results.length, results });
  };
}

// =============================================================== 1 降级 ====

console.log('多词降级');

await step('① 工具注册：6 个工具，search 有 minDuration，fetch 没有 leaseId', async () => {
  assert.equal(tools.length, 6, '应注册 6 个工具，实际 ' + tools.length);
  assert.ok(byName.video_sound_fetch, '缺少 video_sound_fetch');
  const searchProps = byName.video_sound_search.parameters.properties;
  assert.ok('minDuration' in searchProps, 'video_sound_search 缺少 minDuration');
  assert.ok('maxDuration' in searchProps, 'maxDuration 应当还在');
  const fetchProps = byName.video_sound_fetch.parameters.properties;
  assert.ok(!('leaseId' in fetchProps), 'fetch 是纯文件操作，不该有 leaseId');
  assert.deepEqual(byName.video_sound_fetch.parameters.required, ['entryId']);
});

await step('② 多词 0 结果 → 降级命中 corporate，degraded 与 degradedQuery 正确', async () => {
  // 本地库里只有 corporate 与 ambient 命中；四词 AND 必然 0
  const v = await searchSounds({ query: 'minimal corporate ambient pulse', source: 'local' });
  assert.equal(v.degraded, true, '应当标记 degraded:true');
  assert.equal(v.degradedQuery, 'corporate', 'degradedQuery 应为 corporate，实际 ' + v.degradedQuery);
  assert.ok(v.count >= 1, '降级后应命中至少 1 条，实际 ' + v.count);
  assert.ok(
    v.entries.every((e) => /corporate/i.test(e.title + ' ' + e.providerId + ' ' + (e.tags || []).join(' '))),
    '命中的条目应当真的包含 corporate',
  );
  const warn = v.warnings.find((w) => w.code === 'QUERY_DEGRADED');
  assert.ok(warn, '缺少 QUERY_DEGRADED warning');
  assert.ok(warn.message.includes('原查询') && warn.message.includes('已降价为'), 'warning 文案应说清原查询与降价结果：' + warn.message);
  assert.ok(warn.message.includes('minimal corporate ambient pulse'), 'warning 应回显原查询');
  assertLossless(v, '降级结果');
});

await step('③ 原查询直接命中时不降级：degraded:false、degradedQuery:null', async () => {
  const v = await searchSounds({ query: 'corporate', source: 'local' });
  assert.equal(v.degraded, false, '不该降级');
  assert.equal(v.degradedQuery, null, 'degradedQuery 应为 null');
  assert.ok(!v.warnings.some((w) => w.code === 'QUERY_DEGRADED'), '不该有降级 warning');
  assertLossless(v, '直接命中结果');
});

await step('④ 三次降级都空 → 0 条、degraded:false，并明说「这是真的没有」', async () => {
  // qqq / zzzzzz / mmmmm：三个候选互不重复（去掉最长 → 取最长 → 取第一个），全都 0 命中
  const v = await searchSounds({ query: 'qqq zzzzzz mmmmm', source: 'local' });
  assert.equal(v.count, 0, '应当 0 条，实际 ' + v.count);
  assert.equal(v.degraded, false, '三次都空不该标 degraded:true');
  assert.equal(v.degradedQuery, null, 'degradedQuery 应为 null');
  assert.ok(!v.warnings.some((w) => w.code === 'QUERY_DEGRADED'), '不该出现降价成功的 warning');
  const exhausted = v.warnings.find((w) => w.code === 'DEGRADE_EXHAUSTED');
  assert.ok(exhausted, '缺少 DEGRADE_EXHAUSTED warning');
  const tried = exhausted.message.split('」「');
  assert.equal(tried.length, 3, '应尝试 3 个降价查询，实际 ' + tried.length + '：' + exhausted.message);
  assertLossless(v, '降级穷尽结果');
});

await step('⑤ 单查询词 / 空查询不降级（没有可去掉的词）', async () => {
  for (const query of ['corporate', 'nonexistentword']) {
    const v = await searchSounds({ query, source: 'local' });
    assert.equal(v.degraded, false, query + ' 不该降级');
    assert.equal(v.degradedQuery, null, query + ' 的 degradedQuery 应为 null');
  }
  const empty = await searchSounds({ query: '', source: 'local' });
  assert.equal(empty.degraded, false, '空查询不该降级');
});

await step('⑥ 在线分支也会降级（桩 fetch：只有 corporate 有结果）', async () => {
  const stub = stubFetch(
    searchByQuery({
      corporate: [fsRecord(201, { name: 'corporate pulse', duration: 40, tags: ['corporate'] })],
    }),
  );
  try {
    const v = await searchSounds({ query: 'minimal corporate ambient pulse', source: 'freesound', limit: 3 });
    assert.equal(v.degraded, true, '在线分支也应降级');
    assert.equal(v.degradedQuery, 'corporate', 'degradedQuery 应为 corporate');
    assert.equal(v.count, 1, '应命中 1 条，实际 ' + v.count);
    const queries = stub.calls.map((u) => new URL(u).searchParams.get('query'));
    assert.ok(queries.length >= 2, '应当发过不止一次搜索，实际 ' + queries.length);
    assert.equal(queries[queries.length - 1], 'corporate', '最后一次应是用 corporate 搜的');
    assertLossless(v, '在线降级结果');
  } finally {
    stub.restore();
  }
});

// =========================================================== 2 时长维度 ====

console.log('时长维度');

await step('⑦ min > max → INVALID_ARG（核心函数与工具两条路都拒）', async () => {
  const coreErr = await expectCode(
    () => searchSounds({ query: '', source: 'local', minDuration: 10, maxDuration: 3 }),
    'INVALID_ARG',
  );
  assert.ok(coreErr.message.includes('minDuration'), '错误应点名 minDuration：' + coreErr.message);
  await expectCode(() => call('video_sound_search', { query: '', source: 'local', minDuration: 10, maxDuration: 3 }), 'INVALID_ARG');

  // 直接调在线源也要拒（必须先有 key 才轮得到参数校验，所以这里临时装 key）
  const stub = stubFetch(searchByQuery({}));
  try {
    await expectCode(() => searchFreesound('music', { minDuration: 10, maxDuration: 3 }), 'INVALID_ARG');
  } finally {
    stub.restore();
  }

  // 相等是合法的（正好一条时长）
  const ok = await searchSounds({ query: '', source: 'local', minDuration: 5, maxDuration: 5 });
  assert.equal(ok.degraded, false, '相等区间应当被接受');
  assertLossless(errorJson(coreErr), 'min>max 错误体');
});

await step('⑧ 本地 minDuration：只留够长的；时长未知的排除并告警', async () => {
  const v = await searchSounds({ query: '', source: 'local', minDuration: 10 });
  assert.equal(v.count, 1, '只有 30 秒那条够长，实际 ' + v.count);
  assert.equal(v.entries[0].duration, 30, '应为 30 秒的环境音，实际 ' + v.entries[0].duration);
  assert.ok(!v.entries.some((e) => e.duration == null), '时长未知的条目不该被放进来');
  const warn = v.warnings.find((w) => w.code === 'DURATION_UNKNOWN');
  assert.ok(warn, '缺少 DURATION_UNKNOWN warning');
  assert.ok(/\d+ 条/.test(warn.message), 'warning 应说明排除了几条：' + warn.message);
  assertLossless(v, 'minDuration 本地结果');
});

await step('⑨ 本地 min + max 区间：两端都生效', async () => {
  const v = await searchSounds({ query: '', source: 'local', minDuration: 1, maxDuration: 5 });
  const durations = v.entries.map((e) => e.duration).sort((a, b) => a - b);
  assert.deepEqual(durations, [2, 3, 5], '应只剩 2/3/5 秒三条，实际 ' + JSON.stringify(durations));
  // 未知时长仍被排除（下限存在），所以不会有 null
  assert.ok(durations.every((d) => d != null), '区间过滤不该放进未知时长');
  assertLossless(v, '区间过滤结果');
});

await step('⑩ 在线时长：拼成 filter=duration:[min TO max] / [min TO *] / [0 TO max]', async () => {
  const stub = stubFetch(searchByQuery({ music: [fsRecord(301, { name: 'bed', duration: 90, tags: ['music'] })] }));
  try {
    await searchFreesound('music', { limit: 5, minDuration: 60, maxDuration: 120, sort: 'rating' });
    await searchFreesound('music', { limit: 5, minDuration: 30, sort: 'rating' });
    await searchFreesound('music', { limit: 5, maxDuration: 10, sort: 'rating' });
    await searchFreesound('music', { limit: 5, sort: 'rating' });

    const filters = stub.calls.map((u) => new URL(u).searchParams.get('filter'));
    assert.equal(filters[0], 'duration:[60 TO 120]', '上下限都给的拼法不对：' + filters[0]);
    assert.equal(filters[1], 'duration:[30 TO *]', '只给下限应写 *：' + filters[1]);
    assert.equal(filters[2], 'duration:[0 TO 10]', '只给上限应写 0：' + filters[2]);
    assert.equal(filters[3], null, '都不给时不该带 filter：' + filters[3]);
  } finally {
    stub.restore();
  }
});

await step('⑪ 在线时长通过 searchSounds 透传（source=all 也一样）', async () => {
  const stub = stubFetch(searchByQuery({ music: [fsRecord(302, { name: 'bed', duration: 90, tags: ['music'] })] }));
  try {
    const v = await searchSounds({ query: 'music', source: 'freesound', minDuration: 60, limit: 2 });
    assert.equal(v.count, 1, '应返回 1 条在线结果');
    const url = new URL(stub.calls[0]);
    assert.equal(url.searchParams.get('filter'), 'duration:[60 TO *]', 'searchSounds 没把 minDuration 透传到在线源');
    assertLossless(v, '在线时长结果');
  } finally {
    stub.restore();
  }
});

await step('⑫ loopable：在线有 loop 标签为 true、没有为 false；本地为 null', async () => {
  const stub = stubFetch(
    searchByQuery({
      loopme: [
        fsRecord(401, { name: 'loop bed', duration: 60, tags: ['loop', 'music'] }),
        fsRecord(402, { name: 'one shot', duration: 1, tags: ['impact'] }),
      ],
    }),
  );
  try {
    const v = await searchSounds({ query: 'loopme', source: 'freesound', limit: 5, sort: 'rating' });
    const byId = Object.fromEntries(v.entries.map((e) => [e.providerId, e]));
    assert.equal(byId['401'].loopable, true, '带 loop 标签应为 true');
    assert.equal(byId['402'].loopable, false, '没有 loop 标签应为 false（不代表不能循环）');
    assertLossless(v, '在线 loopable 结果');
  } finally {
    stub.restore();
  }

  const local = await searchSounds({ query: 'impact', source: 'local' });
  assert.ok(local.entries.length >= 1, '本地应有 impact');
  for (const e of local.entries) assert.equal(e.loopable, null, '本地判断不了，应为 null：' + e.id);
  assertLossless(local, '本地 loopable 结果');
});

// =========================================================== 3 取文件 ====

console.log('video_sound_fetch');

const sfxDir = path.join(projRoot, 'assets', 'sfx');

await step('⑬ 本地条目复制到 assets/sfx/，返回 localPath / bytes / durationMs / source', async () => {
  const local = entryOf('kenney/ui/impact.wav');
  const v = await call('video_sound_fetch', { entryId: local.id });
  assert.equal(v.relPath, 'assets/sfx/impact.wav', 'relPath 不对：' + v.relPath);
  assert.ok(path.isAbsolute(v.localPath), 'localPath 应是绝对路径：' + v.localPath);
  assert.equal(path.resolve(v.localPath), path.resolve(sfxDir, 'impact.wav'), 'localPath 落点不对：' + v.localPath);
  assert.equal(v.bytes, localSize(2), 'bytes 应等于源文件大小，实际 ' + v.bytes);
  assert.equal(v.durationMs, 2000, 'durationMs 应为 2000，实际 ' + v.durationMs);
  assert.equal(v.source, 'local', 'source 应为 local');
  assert.equal(v.reused, false, '首次写入不叫复用');

  const src = await fs.readFile(path.join(libRoot, 'kenney/ui/impact.wav'));
  const dst = await fs.readFile(v.localPath);
  assert.deepEqual(dst, src, '复制出来的字节应与库里一致');
  assertLossless(v, 'fetch 本地结果');
});

await step('⑭ 同一条再取一次：同大小同内容 → 复用，不堆副本', async () => {
  const local = entryOf('kenney/ui/impact.wav');
  const before = (await fs.readdir(sfxDir)).length;
  const v = await call('video_sound_fetch', { entryId: local.id });
  assert.equal(v.reused, true, '第二次应当复用');
  assert.equal(v.relPath, 'assets/sfx/impact.wav', '复用应指向同一个文件');
  assert.equal((await fs.readdir(sfxDir)).length, before, '不该多出文件');
  assertLossless(v, 'fetch 复用结果');
});

await step('⑮ 同名不同内容 → 加 -1 后缀，两份都在', async () => {
  const other = entryOf('other/impact.wav');
  assert.ok(other, '前置：另一个 pack 里的 impact.wav 应存在');
  const v = await call('video_sound_fetch', { entryId: other.id });
  assert.equal(v.relPath, 'assets/sfx/impact-1.wav', '重名应加 -1，实际 ' + v.relPath);
  assert.equal(v.reused, false, '内容不同不该复用');
  const files = (await fs.readdir(sfxDir)).sort();
  assert.deepEqual(files, ['impact-1.wav', 'impact.wav'], '目录里应有两份，实际 ' + JSON.stringify(files));
  assertLossless(v, 'fetch 重名结果');
});

await step('⑯ 在线条目下载预览音频并写盘（桩 fetch 返回字节流）', async () => {
  const bytes = Buffer.from('ID3-fake-mp3-' + 'x'.repeat(64));
  rememberEntries([
    {
      id: 'freesound:555',
      provider: 'freesound',
      providerId: '555',
      title: 'Loop Bed',
      previewUrl: 'https://cdn.example.test/555.mp3',
      duration: 12.5,
      tags: ['loop'],
      license: 'CC0',
      attribution: 'by tester',
      pageUrl: 'https://freesound.org/s/555/',
    },
  ]);

  const stub = stubFetch((url) => {
    if (url.includes('cdn.example.test')) {
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'audio/mpeg' : null) },
        arrayBuffer: async () => bytes,
      };
    }
    return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) };
  });
  try {
    const v = await call('video_sound_fetch', { entryId: 'freesound:555' });
    assert.equal(v.source, 'freesound', 'source 应为 freesound');
    assert.ok(v.relPath.startsWith('assets/sfx/'), 'relPath 应在 assets/sfx：' + v.relPath);
    assert.ok(v.relPath.endsWith('.mp3'), '在线条目标题应带 .mp3：' + v.relPath);
    assert.equal(v.bytes, bytes.length, 'bytes 应等于下载长度');
    assert.equal(v.durationMs, 12500, 'durationMs 应取条目时长 12.5s → 12500');
    const written = await fs.readFile(v.localPath);
    assert.deepEqual(written, bytes, '写盘字节应与下载内容一致');
    assertLossless(v, 'fetch 在线结果');
  } finally {
    stub.restore();
  }
});

await step('⑰ 下载失败 → 可读的 DOWNLOAD_FAILED（不甩原始异常）', async () => {
  rememberEntries([
    {
      id: 'freesound:666',
      provider: 'freesound',
      providerId: '666',
      title: 'Broken',
      previewUrl: 'https://cdn.example.test/666.mp3',
      duration: 1,
      tags: [],
      license: 'CC0',
      attribution: 'by tester',
      pageUrl: 'https://freesound.org/s/666/',
    },
  ]);
  const stub = stubFetch(() => {
    throw new Error('socket hang up');
  });
  try {
    const err = await expectCode(() => call('video_sound_fetch', { entryId: 'freesound:666' }), 'DOWNLOAD_FAILED');
    assert.ok(err.message.includes('下载'), '错误文案应说明下载失败：' + err.message);
    assert.ok(err.message.includes('socket hang up'), '应带上原始原因便于排错：' + err.message);
    assertLossless(errorJson(err), 'fetch 下载失败错误体');
  } finally {
    stub.restore();
  }
});

await step('⑱ 超过 20MB 上限 → DOWNLOAD_FAILED 且文案点名上限', async () => {
  rememberEntries([
    {
      id: 'freesound:777',
      provider: 'freesound',
      providerId: '777',
      title: 'Huge',
      previewUrl: 'https://cdn.example.test/777.mp3',
      duration: 1,
      tags: [],
      license: 'CC0',
      attribution: 'by tester',
      pageUrl: 'https://freesound.org/s/777/',
    },
  ]);
  const stub = stubFetch(() => ({
    ok: true,
    status: 200,
    headers: {
      get: (k) => {
        const key = String(k).toLowerCase();
        if (key === 'content-length') return String(30 * 1024 * 1024);
        if (key === 'content-type') return 'audio/mpeg';
        return null;
      },
    },
    arrayBuffer: async () => Buffer.alloc(0),
  }));
  try {
    const err = await expectCode(() => call('video_sound_fetch', { entryId: 'freesound:777' }), 'DOWNLOAD_FAILED');
    assert.ok(err.message.includes('上限'), '错误文案应说明超限：' + err.message);
    assertLossless(errorJson(err), 'fetch 超限错误体');
  } finally {
    stub.restore();
  }
});

await step('⑲ 本地没有这个条目 → NOT_FOUND；空 entryId → INVALID_ARG', async () => {
  const notFound = await expectCode(() => call('video_sound_fetch', { entryId: 'deadbeefdead' }), 'NOT_FOUND');
  assert.ok(notFound.message.includes('没有这个条目'), '应说清是库里没有这条：' + notFound.message);
  const invalid = await expectCode(() => call('video_sound_fetch', { entryId: '' }), 'INVALID_ARG');
  assertLossless(errorJson(notFound), 'fetch NOT_FOUND 错误体');
  assertLossless(errorJson(invalid), 'fetch INVALID_ARG 错误体');
});

await step('⑳ fetch 不改时间线、不登记素材、不占租约', async () => {
  const fresh = new ProjectStore();
  const freshRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-chain-fetch-proj-'));
  const freshSession = 'session-sound-chain-fetch';
  const freshDoc = await fresh.open(freshRoot, freshSession);
  const freshTools = Object.fromEntries(soundTools({ store: fresh }).map((t) => [t.name, t]));
  const runFresh = (args) => freshTools.video_sound_fetch.execute(args, { agent: { id: freshSession } });

  const before = fresh.get(freshDoc.projectId).doc;
  const beforeState = JSON.stringify({
    revision: before.revision,
    clips: before.clips,
    assets: before.assets,
  });
  const leasesBefore = fresh.listLeases(freshDoc.projectId).length;
  assert.equal(leasesBefore, 0, '前置：新工程不该有租约');

  const local = entryOf('kenney/ui/impact.wav');
  await runFresh({ entryId: local.id });

  // 在线那条要下载预览音频：装桩，别真的出网
  const stub = stubFetch((url) => {
    if (url.includes('cdn.example.test')) {
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'audio/mpeg' : null) },
        arrayBuffer: async () => Buffer.from('ID3-online-bytes'),
      };
    }
    return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) };
  });
  try {
    await runFresh({ entryId: 'freesound:555' });
  } finally {
    stub.restore();
  }

  const after = fresh.get(freshDoc.projectId).doc;
  const afterState = JSON.stringify({
    revision: after.revision,
    clips: after.clips,
    assets: after.assets,
  });
  assert.equal(afterState, beforeState, 'fetch 改了时间线/素材——它只该落文件');
  assert.equal(after.revision, 0, 'revision 应保持 0，实际 ' + after.revision);
  assert.equal(fresh.listLeases(freshDoc.projectId).length, 0, 'fetch 不该领租约');
  const files = await fs.readdir(path.join(freshRoot, 'assets', 'sfx'));
  assert.ok(files.length >= 1, '文件应已落盘，实际 ' + JSON.stringify(files));
  await fs.rm(freshRoot, { recursive: true, force: true });
});

// =========================================================== 4 lossless ====

console.log('lossless JSON');

await step('㉑ sanitizeJson：undefined 键删掉、NaN/Infinity 转 null、Date 转 ISO、环引用不抛', async () => {
  const circular = { name: 'a' };
  circular.self = circular;
  const dirty = {
    keep: 1,
    gone: undefined,
    nan: NaN,
    inf: Infinity,
    when: new Date('2026-11-06T00:00:00.000Z'),
    list: [1, undefined, NaN, () => {}],
    nested: { also: undefined, ok: 'yes' },
    circular,
  };
  const clean = sanitizeJson(dirty);
  assert.ok(!('gone' in clean), '值为 undefined 的键应被删掉');
  assert.ok(!('also' in clean.nested), '嵌套里的 undefined 键也该删掉');
  assert.equal(clean.nan, null, 'NaN 应转 null');
  assert.equal(clean.inf, null, 'Infinity 应转 null');
  assert.equal(clean.when, '2026-11-06T00:00:00.000Z', 'Date 应转 ISO 字符串');
  assert.deepEqual(clean.list, [1, null, null, null], '数组里的非法值应转 null（保长度）');
  assert.equal(clean.circular.self, '[Circular]', '环引用应替换成字符串而不是抛错');
  assertLossless(clean, '清洗结果');
  assert.deepEqual(scanLossy(dirty).length > 0, true, '未清洗前应当被扫出问题');
  assert.equal(scanLossy(clean).length, 0, '清洗后不该再有非无损值');
});

await step('㉒ 所有 video_sound_* 成功返回体都是 lossless（含降级/时长/在线/fetch）', async () => {
  const results = [];
  results.push(['sources', await call('video_sound_sources', {})]);
  results.push(['search 空查询', await call('video_sound_search', { query: '', source: 'local' })]);
  results.push(['search 降级', await call('video_sound_search', { query: 'minimal corporate ambient pulse', source: 'local' })]);
  results.push([
    'search 时长',
    await call('video_sound_search', { query: '', source: 'local', minDuration: 1, maxDuration: 5 }),
  ]);
  results.push(['fetch', await call('video_sound_fetch', { entryId: entryOf('kenney/ui/impact.wav').id })]);

  const stub = stubFetch(
    searchByQuery({
      loopme: [fsRecord(501, { name: 'loop bed', duration: 60, tags: ['loop', 'music'] })],
      minimal: [],
    }),
  );
  try {
    results.push(['search 在线', await call('video_sound_search', { query: 'loopme', source: 'freesound', limit: 3 })]);
  } finally {
    stub.restore();
  }

  for (const [label, value] of results) assertLossless(value, label);
});

await step('㉓ 各条错误分支的错误体也是 lossless（工具层同样能序列化）', async () => {
  const errors = [];
  errors.push(await expectCode(() => call('video_sound_search', { source: 'bogus' }), 'INVALID_ARG'));
  errors.push(
    await expectCode(() => call('video_sound_search', { query: '', source: 'local', minDuration: 9, maxDuration: 1 }), 'INVALID_ARG'),
  );
  errors.push(await expectCode(() => call('video_sound_search', { query: 'x', source: 'freesound' }), 'NO_API_KEY'));
  errors.push(await expectCode(() => call('video_sound_fetch', { entryId: '' }), 'INVALID_ARG'));
  errors.push(await expectCode(() => call('video_sound_fetch', { entryId: 'nope-nope' }), 'NOT_FOUND'));
  for (const err of errors) {
    assert.equal(typeof err.code, 'string', '错误应带 code');
    assert.equal(typeof err.message, 'string', '错误应带可读 message');
    assertLossless(errorJson(err), '错误体 ' + err.code);
  }
});

await step('㉔ 搜索返回的顶层键形状稳定：degraded / degradedQuery 永远存在', async () => {
  const v = await searchSounds({ query: 'corporate', source: 'local' });
  assert.ok('degraded' in v, '缺 degraded 键');
  assert.ok('degradedQuery' in v, '缺 degradedQuery 键');
  assert.equal(typeof v.degraded, 'boolean', 'degraded 应为布尔');
  assert.ok(v.degradedQuery === null || typeof v.degradedQuery === 'string', 'degradedQuery 应为 null 或字符串');
  assert.ok(Array.isArray(v.warnings), 'warnings 应为数组');
  for (const w of v.warnings) {
    assert.equal(typeof w.message, 'string', 'warning 必须有人话 message');
    assert.equal(typeof w.code, 'string', 'warning 应带 code');
  }
});

function localSize(seconds) {
  return makeWav(seconds).length;
}

// ------------------------------------------------------------------- 收尾 ---

console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
for (const f of failures) console.log('  - ' + f);

for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
globalThis.fetch = realFetch;
cleanupBindings();

if (failures.length) process.exitCode = 1;
