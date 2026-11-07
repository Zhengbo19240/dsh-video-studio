/**
 * 声学标签（tools/analyze-sounds.mjs + src/sound-index.mjs + video_sound_search 过滤）测试。
 *
 *   node scripts/sound-tags-test.mjs
 *
 * 原则：**不 mock 测量**。每个样本都用本机 ffmpeg 现场合成，分析器真的跑一遍
 * （ffprobe + ffmpeg aspectralstats + PCM 包络/过零/自相关），再断言数值与分类。
 * 检索同样走真实的 scanLocal + 真实索引文件。
 *
 * 需要：本机 ffmpeg/ffprobe（默认 ~/.dsh/video-deps\ffmpeg\bin，可用
 * DSH_ASR_ROOT / DSH_FFMPEG_PATH / DSH_FFPROBE_PATH 改）。缺了会明确报出来，不是假绿。
 */

import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { searchSounds } from '../src/sound-tools.mjs';
import {
  MEASURED_CAVEAT,
  loadSoundIndex,
  indexKeyOf,
  filterByMeasured,
  pickMeasuredFilters,
  measuredSummary,
} from '../src/sound-index.mjs';
import { resolveTools, classifyShape, classifyNoisiness, guessMaterial } from '../tools/analyze-sounds.mjs';

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

// ------------------------------------------------------------- 临时音效库 ---

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const ANALYZER = path.join(PROJECT, 'tools', 'analyze-sounds.mjs');

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sound-tags-'));
const libRoot = path.join(sandbox, 'lib');
const packDir = path.join(libRoot, 'synth');
const indexFile = path.join(sandbox, 'sound-index.json');

process.env.DSH_SOUND_LIB = libRoot;
process.env.DSH_SOUND_INDEX = indexFile;
delete process.env.DSH_SOUND_SOURCES;

/** 每个合成样本：名字 → lavfi 源 */
const SAMPLES = {
  'silence.wav': 'anullsrc=r=44100:cl=mono:d=0.1',
  'sine1k.wav': 'sine=frequency=1000:duration=1',
  'noise.wav': 'anoisesrc=d=0.1:c=white:a=0.8',
  'low100.wav': 'sine=frequency=100:duration=0.5',
  'high8k.wav': 'sine=frequency=8000:duration=0.5',
  'decay.wav': 'aevalsrc=0.8*exp(-1.1513*t)*sin(2*PI*300*t):d=2.5',
  'click.wav': 'sine=frequency=1200:duration=0.02',
  'midnoise.wav': 'anoisesrc=d=0.3:c=white:a=0.7',
};

const tools = resolveTools();

function ffmpegAvailable() {
  const r = spawnSync(tools.ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

async function makeSamples() {
  await fs.mkdir(packDir, { recursive: true });
  for (const [name, source] of Object.entries(SAMPLES)) {
    const out = path.join(packDir, name);
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', source];
    // 中频段噪声走一遍带通，落在 800..3000Hz（用来覆盖「塑料倾向」那一支）
    if (name === 'midnoise.wav') args.push('-af', 'highpass=f=800,lowpass=f=3000');
    args.push('-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', out);
    const r = spawnSync(tools.ffmpeg, args, { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error('合成 ' + name + ' 失败：' + (r.stderr || '').slice(-300));
  }
  // 损坏样本：扩展名合法、内容不是音频
  await fs.writeFile(path.join(packDir, 'broken.wav'), Buffer.from('this is definitely not a wav file'.repeat(20)));
}

/** 跑分析器 CLI（真实子进程，真实 env） */
function runAnalyzer(extraArgs = []) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [ANALYZER, '--quiet', '--json', ...extraArgs], {
      cwd: PROJECT,
      windowsHide: true,
      env: { ...process.env, DSH_SOUND_LIB: libRoot, DSH_SOUND_INDEX: indexFile },
    });
    const out = [];
    const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('分析器退出码 ' + code + '：' + Buffer.concat(err).toString('utf8').slice(-400)));
        return;
      }
      const lines = Buffer.concat(out).toString('utf8').trim().split(/\r?\n/).filter(Boolean);
      try {
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch (e) {
        reject(new Error('分析器没有输出 JSON：' + lines.slice(-2).join(' | ')));
      }
    });
  });
}

async function readIndexFile() {
  return JSON.parse(await fs.readFile(indexFile, 'utf8'));
}

function itemOf(index, name) {
  // key 是 <根名>/<packId>/<相对路径>；临时库用 DSH_SOUND_LIB，根名固定 default
  const suffix = '/synth/' + name;
  const hit = Object.entries(index.items).find(([key]) => key.endsWith(suffix));
  if (!hit) throw new Error('索引里没有 ' + name + '（现有：' + Object.keys(index.items).join(', ') + '）');
  return hit[1];
}

// ------------------------------------------------------------------ 开场 ---

console.log('声学标签测试');
console.log('  临时音效库：' + libRoot);
console.log('  ffmpeg：' + tools.ffmpeg);

if (!ffmpegAvailable()) {
  console.error('\n找不到可用的 ffmpeg：' + tools.ffmpeg);
  console.error('这个测试不 mock 测量，没有 ffmpeg 就没法跑。用 DSH_ASR_ROOT 或 DSH_FFMPEG_PATH 指过去。');
  process.exit(1);
}

await makeSamples();
const first = await runAnalyzer(['--force']);

// ---------------------------------------------------------------- 索引层 ---

await step('索引文件写出，顶层字段齐全（analyzer / caveat / version / items）', async () => {
  const index = await readIndexFile();
  assert(index.analyzer === 'ffmpeg+自算', 'analyzer 应为 ffmpeg+自算，实际 ' + index.analyzer);
  assert(typeof index.caveat === 'string' && index.caveat.trim().length > 10, 'caveat 必须存在且非空');
  assert(index.caveat.includes('听感'), 'caveat 必须写明「不是听感结论」');
  assert(index.version >= 1, 'version 缺失');
  assert(index.items && Object.keys(index.items).length === 8, 'items 应有 8 条，实际 ' + Object.keys(index.items || {}).length);
  assert(index.total === 9, 'total 应是扫到的 9 个文件（含 1 个坏的）');
  assert(first.failed === 1, '坏文件应记 1 条失败，实际 ' + first.failed);
});

await step('每条都带 materialGuess，且没有 material 字段（不许冒充事实）', async () => {
  const index = await readIndexFile();
  for (const [key, item] of Object.entries(index.items)) {
    assert(typeof item.materialGuess === 'string', key + ' 缺 materialGuess');
    assert(!('material' in item), key + ' 出现了 material 字段（字段名不许改成 material）');
    assert(['金属倾向', '木质倾向', '塑料倾向', '合成倾向', '不确定'].includes(item.materialGuess), key + ' 的 materialGuess 取值非法');
  }
});

await step('坏文件不中断：good 条目都在，错误里有 broken.wav', async () => {
  const index = await readIndexFile();
  assert(itemOf(index, 'sine1k.wav'), '好文件应当照常入库');
  assert(index.errors.length === 1, 'errors 应有 1 条，实际 ' + index.errors.length);
  assert(/broken\.wav/.test(index.errors[0].key || index.errors[0].file), '错误条目应当是 broken.wav：' + JSON.stringify(index.errors[0]));
});

// ---------------------------------------------------------------- 各维度 ---

await step('静音（全 0）：不崩，shape=短促，标 silent 或 tooShort', async () => {
  const item = itemOf(await readIndexFile(), 'silence.wav');
  assert(item.shape === '短促', 'shape 应为短促，实际 ' + item.shape);
  assert(item.silent === true || item.tooShort === true, '应标 silent:true 或 tooShort:true');
  assert(item.centroidHz === 0 || item.centroidHz < 50, '静音的质心应接近 0，实际 ' + item.centroidHz);
});

await step('纯正弦 1kHz 1 秒：有音高 + 乐音性 + 质心约 1kHz', async () => {
  const item = itemOf(await readIndexFile(), 'sine1k.wav');
  assert(item.pitchiness === '有音高', 'pitchiness 应为有音高，实际 ' + item.pitchiness);
  assert(item.noisiness === '乐音性', 'noisiness 应为乐音性，实际 ' + item.noisiness);
  assert(item.centroidHz > 800 && item.centroidHz < 1300, '质心应接近 1000Hz，实际 ' + item.centroidHz);
  assert(item.f0Hz > 900 && item.f0Hz < 1100, '基频应接近 1000Hz，实际 ' + item.f0Hz);
});

await step('白噪声 0.1 秒：shape=短促 + 噪声性', async () => {
  const item = itemOf(await readIndexFile(), 'noise.wav');
  assert(item.shape === '短促', 'shape 应为短促，实际 ' + item.shape);
  assert(item.noisiness === '噪声性', 'noisiness 应为噪声性，实际 ' + item.noisiness);
  assert(item.flatness > 0.5, '白噪声的频谱平坦度应 >0.5，实际 ' + item.flatness);
});

await step('低频正弦 100Hz → 亮度暗；高频 8kHz → 亮度亮', async () => {
  const index = await readIndexFile();
  const low = itemOf(index, 'low100.wav');
  const high = itemOf(index, 'high8k.wav');
  assert(low.brightness === '暗', '100Hz 应为暗，实际 ' + low.brightness + '（质心 ' + low.centroidHz + '）');
  assert(high.brightness === '亮', '8kHz 应为亮，实际 ' + high.brightness + '（质心 ' + high.centroidHz + '）');
  assert(high.centroidHz > low.centroidHz * 10, '8kHz 的质心应远高于 100Hz');
});

await step('指数衰减 2 秒 → shape=拖尾，decayMs 落在 1.5~2.5 秒', async () => {
  const item = itemOf(await readIndexFile(), 'decay.wav');
  assert(item.shape === '拖尾', 'shape 应为拖尾，实际 ' + item.shape + '（decay ' + item.decayMs + 'ms）');
  assert(item.decayMs > 1500 && item.decayMs < 2500, 'decayMs 应在 1500~2500ms，实际 ' + item.decayMs);
  assert(item.decayComplete === true, '这段衰减应当能测到 -20dB');
});

await step('分类器阈值（纯函数）与文档口径一致', async () => {
  assert(classifyShape(149, false) === '短促', '149ms 应为短促');
  assert(classifyShape(150, false) === '中', '150ms 应为中');
  assert(classifyShape(500, false) === '中', '500ms 应为中');
  assert(classifyShape(501, false) === '拖尾', '501ms 应为拖尾');
  assert(classifyShape(999, true) === '短促', 'tooShort 一律短促');
  assert(
    classifyShape(0, false, { decayComplete: false, durationMs: 5000, peakMs: 4990 }) === '拖尾',
    '持续音末尾出峰（从来跌不到 -20dB）应按拖尾，而不是从末尾算出的 0ms 短促',
  );
  assert(classifyNoisiness(0.9, 20000) === '噪声性', '平坦度 0.9 应为噪声性');
  assert(classifyNoisiness(0.001, 2000) === '乐音性', '平坦度 0.001 应为乐音性');
  assert(classifyNoisiness(0.15, 6000) === '混合', '平坦度 0.15 应为混合');
  assert(
    guessMaterial({ brightness: '亮', noisiness: '乐音性', pitchiness: '有音高', shape: '短促' }) === '金属倾向',
    '亮 + 非噪声 应为金属倾向',
  );
  assert(
    guessMaterial({ brightness: '亮', noisiness: '噪声性', pitchiness: '无音高', shape: '短促' }) === '不确定',
    '亮 + 噪声 不该硬塞进金属',
  );
});

// ---------------------------------------------------------------- 幂等 ---

await step('幂等：第二次跑全部 skip，一条都不重算', async () => {
  const second = await runAnalyzer();
  assert(second.analyzed === 0, '第二次应当 0 条重算，实际 ' + second.analyzed);
  assert(second.skipped === 8, '第二次应当跳过 8 条，实际 ' + second.skipped);
  assert(second.failed === 1, '坏文件每次都会重试并再记一次失败');
});

await step('指纹变化（改 mtime）后只重算那一条', async () => {
  const target = path.join(packDir, 'sine1k.wav');
  const now = new Date(Date.now() + 5000);
  await fs.utimes(target, now, now);
  const third = await runAnalyzer();
  assert(third.analyzed === 1, 'mtime 改了应当只重算 1 条，实际 ' + third.analyzed);
  assert(third.skipped === 7, '其余 7 条应当仍然 skip，实际 ' + third.skipped);
});

// ---------------------------------------------------------------- 检索 ---

async function search(extra) {
  return searchSounds({ source: 'local', limit: 100, ...extra });
}

await step('检索按 shape 过滤：命中的每一条 measured.shape 都对得上', async () => {
  const res = await search({ shape: '拖尾' });
  assert(res.count > 0, '拖尾应当至少命中 1 条');
  for (const e of res.entries) {
    assert(e.measured, '命中条目必须带 measured：' + e.providerId);
    assert(e.measured.shape === '拖尾', '混进了非拖尾：' + e.providerId + ' ' + e.measured.shape);
  }
  assert(res.total === res.count || res.total >= res.count, 'total 应不小于返回条数');
});

await step('检索按 brightness 过滤：暗 / 亮 各命中对应样本', async () => {
  const dark = await search({ brightness: '暗' });
  const bright = await search({ brightness: '亮' });
  assert(dark.entries.some((e) => e.providerId.endsWith('low100.wav')), '暗 应当命中 100Hz');
  assert(bright.entries.some((e) => e.providerId.endsWith('high8k.wav')), '亮 应当命中 8kHz');
  for (const e of dark.entries) assert(e.measured.brightness === '暗', '暗 结果里混进了 ' + e.measured.brightness);
});

// materialGuess 实测系统性反号（impactMetal_* → 木质、人声 113/142 → 金属），
// 所以过滤被停用：任何 material 入参都必须拒绝，而不是筛出错的结果。
await step('material 过滤已停用：任何取值都拒绝，并说明原因与替代做法', async () => {
  let err = null;
  try {
    await search({ material: '合成倾向' });
  } catch (e) {
    err = e;
  }
  assert(err, 'material 过滤应当被拒绝');
  assert(err.code === 'INVALID_ARG', '应当是 INVALID_ARG，实际 ' + err.code);
  assert(/停用/.test(err.message), '错误文案要说清已停用：' + err.message);
  assert(/试听/.test(err.message) || /shape/.test(err.message), '错误文案要给替代做法：' + err.message);
});

await step('检索按 maxDurationMs 过滤：只留测量时长不超限的条目', async () => {
  const res = await search({ maxDurationMs: 200 });
  assert(res.count > 0, '200ms 以内应当有样本');
  for (const e of res.entries) {
    const ms = e.measured ? e.measured.decayMs : null; // 只是避免未使用告警
    assert(Number.isFinite(ms), 'measured.decayMs 应当是数值');
  }
  const index = await readIndexFile();
  for (const e of res.entries) {
    const item = index.items[indexKeyOf(e)];
    assert(item && item.durationMs <= 200, e.providerId + ' 的测量时长超过 200ms：' + (item && item.durationMs));
  }
});

await step('命中条目带 measured 五字段 + measuredCaveat，顶层也有 caveat', async () => {
  const res = await search({ shape: '短促' });
  assert(res.measuredCaveat === MEASURED_CAVEAT, '顶层 measuredCaveat 应等于约定的说明');
  assert(typeof res.measuredCaveat === 'string' && res.measuredCaveat.includes('试听'), '说明里要提醒试听');
  const withMeasured = res.entries.find((e) => e.measured);
  assert(withMeasured, '至少一条要带 measured');
  for (const key of ['shape', 'brightness', 'materialGuess', 'centroidHz', 'decayMs']) {
    assert(key in withMeasured.measured, 'measured 缺字段 ' + key);
  }
  assert(withMeasured.measuredCaveat === MEASURED_CAVEAT, '每条命中也必须带 measuredCaveat');
});

await step('过滤值非法时报 INVALID_ARG，不静默返回空', async () => {
  await expectCode(() => search({ shape: '很短' }), 'INVALID_ARG');
  await expectCode(() => search({ brightness: '超亮' }), 'INVALID_ARG');
  await expectCode(() => search({ material: '金属' }), 'INVALID_ARG');
});

await step('没有索引时：不返回假结果，给 NO_MEASURED_INDEX 提示', async () => {
  const saved = process.env.DSH_SOUND_INDEX;
  process.env.DSH_SOUND_INDEX = path.join(sandbox, 'nope', 'missing-index.json');
  try {
    const res = await search({ shape: '短促' });
    assert(res.count === 0, '没有索引时按测量维度过滤应当 0 条，实际 ' + res.count);
    assert(
      res.warnings.some((w) => w.code === 'NO_MEASURED_INDEX'),
      '应当给 NO_MEASURED_INDEX 提示，实际 ' + JSON.stringify(res.warnings),
    );
  } finally {
    process.env.DSH_SOUND_INDEX = saved;
  }
});

await step('不用过滤时也带 measured（有测量数据就带），且不影响原有字段', async () => {
  const res = await search({ query: 'sine1k' });
  assert(res.count === 1, '按文件名应当命中 1 条，实际 ' + res.count);
  const e = res.entries[0];
  assert(typeof e.id === 'string' && e.id.length === 12, '原有 id 不能丢');
  assert(typeof e.duration === 'number', '原有 duration 不能丢');
  assert(e.measured && e.measured.centroidHz > 800, '有测量数据就该带 measured');
});

await step('索引读取：坏 JSON 只给 warning，不抛错', async () => {
  const saved = process.env.DSH_SOUND_INDEX;
  const bad = path.join(sandbox, 'bad-index.json');
  await fs.writeFile(bad, '{ this is not json');
  process.env.DSH_SOUND_INDEX = bad;
  try {
    const loaded = await loadSoundIndex();
    assert(loaded.exists === true, '文件存在时 exists 应为 true');
    assert(loaded.warning && loaded.warning.includes('JSON'), '应当有 JSON 坏掉的 warning');
    assert(Object.keys(loaded.items).length === 0, '坏文件应当给空 items');
  } finally {
    process.env.DSH_SOUND_INDEX = saved;
  }
});

await step('filterByMeasured / measuredSummary 的单条行为', async () => {
  const index = await readIndexFile();
  const items = Object.values(index.items);
  const one = items[0];
  const summary = measuredSummary(one);
  assert(Object.keys(summary).length === 5, 'measuredSummary 应当只给 5 个字段');
  const entry = { root: one.root, providerId: one.providerId };
  const filters = pickMeasuredFilters({ shape: one.shape });
  const kept = filterByMeasured([entry], filters, index);
  assert(kept.entries.length === 1, '同 shape 的条目应当命中');
  const missed = filterByMeasured([entry], pickMeasuredFilters({ shape: one.shape === '短促' ? '拖尾' : '短促' }), index);
  assert(missed.entries.length === 0, '不同 shape 的条目不该命中');
  const noData = filterByMeasured([{ root: 'x', providerId: 'y.wav' }], filters, index);
  assert(noData.entries.length === 0, '没有测量数据的条目不该被「放行」');
});

// ------------------------------------------------------------------ 收尾 ---

await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {});

console.log('\n通过 ' + pass + ' / ' + (pass + fail));
if (fail) {
  console.log('失败 ' + fail + ' 条');
  process.exitCode = 1;
}
console.log('（临时目录已清理：' + sandbox + '）');
