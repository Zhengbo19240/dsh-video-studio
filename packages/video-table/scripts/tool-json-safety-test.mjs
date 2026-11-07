// 回归：工具返回值必须是「无损 JSON」。
// 背景：video_sound_search 曾把 measuredCaveat 写成 `条件 ? 字符串 : undefined`。
// JSON.stringify 会丢掉 undefined 键 → 往返后结构不同 → 工具层把整个结果判成
// 「value is not lossless JSON」拒收。症状是：本地搜索正常，Freesound 搜索必然报错。
// 这条测试用桩 fetch 走完整的 freesound 分支，不需要真 API。
import assert from 'node:assert/strict';
import { searchSounds } from '../src/sound-tools.mjs';

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    failures.push(name + ': ' + (e && e.message));
    console.log('  FAIL ' + name + ' — ' + (e && e.message));
  }
}

/** 递归找 undefined / NaN / Infinity / function —— 这些都会让 JSON 往返失真 */
function scanBadValues(value, pathStr = 'result', out = []) {
  if (value === undefined) out.push({ path: pathStr, kind: 'undefined' });
  else if (typeof value === 'number' && !Number.isFinite(value)) out.push({ path: pathStr, kind: String(value) });
  else if (typeof value === 'function') out.push({ path: pathStr, kind: 'function' });
  else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      const v = value[k];
      if (v === undefined) out.push({ path: pathStr + '.' + k, kind: 'undefined' });
      else scanBadValues(v, pathStr + '.' + k, out);
    }
  }
  return out;
}

/** 深比较：JSON 往返后必须与原始结构等价 */
function assertLossless(result, label) {
  const bad = scanBadValues(result);
  assert.equal(bad.length, 0, label + ' 含非法值: ' + bad.map((b) => b.path + '(' + b.kind + ')').join(', '));
  const roundTrip = JSON.parse(JSON.stringify(result));
  assert.deepEqual(roundTrip, result, label + ' JSON 往返后结构不一致');
}

// ---- 桩 fetch：模拟 Freesound 搜索响应（含缺评分/缺下载量的条目）----
const realFetch = globalThis.fetch;
const stubPayload = {
  count: 3,
  results: [
    {
      id: 101,
      name: 'switch click hard',
      duration: 0.18,
      tags: ['ui', 'switch'],
      license: 'http://creativecommons.org/publicdomain/zero/1.0/',
      username: 'someone',
      url: 'https://freesound.org/s/101/',
      previews: { 'preview-hq-mp3': 'https://cdn.freesound.org/previews/101.mp3' },
      num_downloads: 120,
      avg_rating: 4.5,
      num_ratings: 8,
    },
    {
      // 故意缺评分与下载量：blend 归一化会走到「无区分度」分支
      id: 102,
      name: 'click soft',
      duration: 0.09,
      tags: [],
      previews: {},
    },
    {
      // 故意缺 duration：duration 归一化要走兜底
      id: 103,
      name: 'toggle',
      tags: ['toggle'],
      num_downloads: 3,
      avg_rating: 3,
      num_ratings: 1,
      previews: { 'preview-lq-mp3': 'https://cdn.freesound.org/previews/103.mp3' },
    },
  ],
};

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/apiv2/search/text/')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => stubPayload,
      text: async () => JSON.stringify(stubPayload),
    };
  }
  return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
};

process.env.FREESOUND_API_KEY = process.env.FREESOUND_API_KEY || 'stub-key-for-test';

try {
  await check('freesound 搜索（只有在线源）返回值是无损 JSON', async () => {
    const res = await searchSounds({ query: 'switch click', source: 'freesound', limit: 3 });
    assertLossless(res, 'freesound 结果');
    assert.ok(res.count >= 1, '桩数据应当至少命中 1 条');
    // 没有测量数据时，顶层不该出现 measuredCaveat 这个键
    assert.ok(!('measuredCaveat' in res), '在线结果不该带 measuredCaveat 键（无测量数据）');
  });

  await check('freesound 结果条目里没有 undefined 值', async () => {
    const res = await searchSounds({ query: 'click', source: 'freesound', limit: 3 });
    for (const e of res.entries) {
      assertLossless(e, 'freesound 条目 ' + e.id);
      for (const key of ['duration', 'previewUrl', 'license']) {
        // 允许 null，但不允许 undefined（键存在值却 undefined 会被 JSON 丢掉）
        assert.ok(!(key in e) || e[key] !== undefined, '条目 ' + e.id + ' 的 ' + key + ' 是 undefined');
      }
    }
  });

  await check('source=all（本地 + 在线混排）仍是无损 JSON', async () => {
    const res = await searchSounds({ query: 'click', source: 'all', limit: 4 });
    assertLossless(res, 'all 结果');
  });

  await check('freesound + 测量过滤（本地专用）：带 warning 且仍无损', async () => {
    const res = await searchSounds({ query: 'click', source: 'freesound', shape: '短促', limit: 2 });
    assertLossless(res, 'freesound+filter 结果');
    assert.ok(Array.isArray(res.warnings) && res.warnings.some((w) => w.code === 'MEASURED_LOCAL_ONLY'));
  });

  await check('在线源不可用时不吞掉本地结果、且警告可序列化', async () => {
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    const res = await searchSounds({ query: 'click', source: 'all', limit: 3 });
    assertLossless(res, '在线失败时的结果');
    assert.ok(res.warnings.some((w) => w.source === 'freesound'), '应当有一条 freesound 警告');
    for (const w of res.warnings) assert.equal(typeof w.message, 'string', '警告文案必须是字符串');
  });
} finally {
  globalThis.fetch = realFetch;
}

console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
