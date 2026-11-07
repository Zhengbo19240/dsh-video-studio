/**
 * 对齐检查器 + 节拍音 的测试。
 *
 *   node scripts/style-align-test.mjs
 *
 * 两段：
 *   A. 检查器 —— 六类问题各造一个反例，断言 code / severity / shotKind 与三 个数值
 *      （expected / actual / delta）齐全；再测容差边界（±3 / ±4 的临界值）；
 *   B. 节拍 —— bpmFromRhythm 三档、buildClickTrack 的长度/幅度/强弱拍频率、WAV 头。
 *
 * 反例一律从「默认 spec 量出来的真实布局」上面改一处，再跑检查器：
 * 这样反例的数值和真样片同量级，不会出现「为了测试编一份假数据」的情况。
 */

import {
  BPM_TIERS,
  CLICK_SPEC,
  EMPHASIS_RATIO,
  PREVIEW_SECONDS,
  alignmentForSpec,
  bpmFromRhythm,
  buildClickTrack,
  buildStyleShots,
  clickTrackToWav,
  defaultStyleSpec,
} from '../src/style-spec.mjs';
import { ALIGN_LIMITS, checkAlignment, estimateTextWidth, measureLayout } from '../src/style-align.mjs';

let pass = 0;
let fail = 0;

function step(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + (e && e.message));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

function near(a, b, tolerance, message) {
  assert(Math.abs(Number(a) - Number(b)) <= tolerance, `${message || '数值不接近'}：${a} vs ${b}（容差 ${tolerance}）`);
}

/** 默认 spec 量出来的真实布局，深拷贝一份给每个用例改。 */
function baseLayout(spec) {
  const s = spec || defaultStyleSpec();
  const shots = buildStyleShots(s);
  return JSON.parse(JSON.stringify(measureLayout(shots, { spec: s })));
}

function issuesOf(result, code) {
  return result.issues.filter((issue) => issue.code === code);
}

function assertIssueShape(issue, label) {
  assert(issue.severity === 'error' || issue.severity === 'warn', `${label}：severity 不对 (${issue.severity})`);
  assert(typeof issue.code === 'string' && issue.code.length > 0, `${label}：缺 code`);
  assert(typeof issue.message === 'string' && issue.message.length > 4, `${label}：消息太短`);
  for (const key of ['expected', 'actual', 'delta']) {
    assert(Number.isFinite(issue[key]), `${label}：${key} 不是数值 (${JSON.stringify(issue[key])})`);
  }
  assert('shotKind' in issue, `${label}：缺 shotKind 字段`);
}

console.log('A. 检查器 · 正常布局');

step('默认 spec 的版式六项全过（ok=true，没有 issue）', () => {
  const result = alignmentForSpec(defaultStyleSpec());
  assert(result.ok === true, '默认 spec 没过对齐检查：' + result.issues.map((i) => i.message).join('；'));
  assert(result.issues.length === 0, '默认 spec 有 issue：' + result.issues.map((i) => i.code).join(','));
  assert(result.summary.total === 6, '检查项数=' + result.summary.total);
  assert(result.summary.passed === 6 && result.summary.failed === 0, '统计不对：' + JSON.stringify(result.summary));
  for (const check of result.checks) assert(check.passed === true, `检查项 ${check.key} 没过`);
});

step('measureLayout 量出四镜同一左边界与同一基线', () => {
  const layout = baseLayout();
  assert(layout.shots.length === 4, '镜头数=' + layout.shots.length);
  const lefts = new Set(layout.shots.map((shot) => Math.round(shot.contentLeft * 100) / 100));
  assert(lefts.size === 1, '四条左边界不一致：' + [...lefts].join(','));
  const titleBaselines = layout.shots.filter((s) => s.roles.title).map((s) => Math.round(s.roles.title.baseline));
  assert(titleBaselines.length >= 3, '有标题基线的镜头太少：' + titleBaselines.length);
  assert(new Set(titleBaselines).size === 1, '标题基线不一致：' + titleBaselines.join(','));
  for (const shot of layout.shots) {
    assert(shot.emphasis, `${shot.kind} 没有强调条`);
    near(shot.emphasis.ratio, EMPHASIS_RATIO, 1e-6, `${shot.kind} 强调条比例不对`);
    assert(Number.isFinite(shot.radius) && Number.isFinite(shot.strokeWidth), `${shot.kind} 缺圆角/描边`);
  }
});

console.log('A. 检查器 · 六类反例');

step('左边距反例：数据卡右移 6px → margin-consistent，数值齐全', () => {
  const layout = baseLayout();
  layout.shots[1].contentLeft += 6;
  const result = checkAlignment(layout);
  const issues = issuesOf(result, 'margin-consistent');
  assert(result.ok === false, '左边距不一致却说 ok=true');
  assert(issues.length === 1, 'issue 数=' + issues.length);
  const issue = issues[0];
  assertIssueShape(issue, 'margin');
  assert(issue.severity === 'error', 'severity=' + issue.severity);
  assert(issue.shotKind === 'data', 'shotKind=' + issue.shotKind);
  near(issue.expected, 96, 0.01, 'expected 应为设计左边距');
  near(issue.actual, 102, 0.01, 'actual 应为 102');
  near(issue.delta, 6, 0.01, 'delta 应为 +6');
  assert(/数据卡/.test(issue.message) && /6px/.test(issue.message), '消息没说清是谁差多少：' + issue.message);
});

step('基线反例：收尾卡标题下移 9px → baseline-consistent', () => {
  const layout = baseLayout();
  layout.shots[3].roles.title.baseline += 9;
  const result = checkAlignment(layout);
  const issues = issuesOf(result, 'baseline-consistent');
  assert(issues.length === 1, 'issue 数=' + issues.length);
  const issue = issues[0];
  assertIssueShape(issue, 'baseline');
  assert(issue.shotKind === 'closing', 'shotKind=' + issue.shotKind);
  near(issue.expected, 216, 0.5, 'expected 应为标题基线 216');
  near(issue.actual, 225, 0.5, 'actual 应为 225');
  near(issue.delta, 9, 0.5, 'delta 应为 +9');
});

step('字号层级反例：标题/副标题 = 1.88 → type-scale', () => {
  const spec = defaultStyleSpec();
  spec.font = { ...spec.font, heading: 94, subtitle: 50, body: 30, note: 20 };
  const result = alignmentForSpec(spec);
  const issues = issuesOf(result, 'type-scale');
  assert(result.ok === false, '层级失衡却说 ok=true');
  assert(issues.length === 1, 'issue 数=' + issues.length);
  const issue = issues[0];
  assertIssueShape(issue, 'type-scale');
  assert(issue.severity === 'error', 'severity=' + issue.severity);
  near(issue.expected, 1.8, 0.001, 'expected 应为上限 1.8');
  near(issue.actual, 1.88, 0.001, 'actual 应为 1.88');
  near(issue.delta, 0.08, 0.001, 'delta 应为 +0.08');
  assert(/标题/.test(issue.message) && /副标题/.test(issue.message), '消息没说清哪两级：' + issue.message);
});

step('强调条反例：比例 0.75 → emphasis-ratio', () => {
  const layout = baseLayout();
  layout.shots[0].emphasis.ratio = 0.75;
  const result = checkAlignment(layout);
  const issues = issuesOf(result, 'emphasis-ratio');
  assert(issues.length === 1, 'issue 数=' + issues.length);
  const issue = issues[0];
  assertIssueShape(issue, 'emphasis');
  assert(issue.shotKind === 'opening', 'shotKind=' + issue.shotKind);
  near(issue.expected, 0.6, 0.001, 'expected 应为 0.6');
  near(issue.actual, 0.75, 0.001, 'actual 应为 0.75');
  near(issue.delta, 0.15, 0.001, 'delta 应为 +0.15');
});

step('圆角反例：数据卡圆角 8px（其余 14）→ radius-consistent', () => {
  const layout = baseLayout();
  layout.shots[1].radius = 8;
  const result = checkAlignment(layout);
  const issues = issuesOf(result, 'radius-consistent');
  assert(issues.length === 1, 'issue 数=' + issues.length);
  const issue = issues[0];
  assertIssueShape(issue, 'radius');
  assert(issue.shotKind === 'data', 'shotKind=' + issue.shotKind);
  near(issue.expected, 14, 0.001, 'expected 应为 14');
  near(issue.actual, 8, 0.001, 'actual 应为 8');
  near(issue.delta, -6, 0.001, 'delta 应为 -6');
});

step('描边反例：字幕卡描边 3px（其余 1.5）→ stroke-consistent', () => {
  const layout = baseLayout();
  layout.shots[2].strokeWidth = 3;
  const result = checkAlignment(layout);
  const issues = issuesOf(result, 'stroke-consistent');
  assert(issues.length === 1, 'issue 数=' + issues.length);
  const issue = issues[0];
  assertIssueShape(issue, 'stroke');
  assert(issue.shotKind === 'caption', 'shotKind=' + issue.shotKind);
  near(issue.expected, 1.5, 0.001, 'expected 应为 1.5');
  near(issue.actual, 3, 0.001, 'actual 应为 3');
  near(issue.delta, 1.5, 0.001, 'delta 应为 +1.5');
});

step('安全区反例：文字左边界 40px（安全区 64）→ safe-area', () => {
  const layout = baseLayout();
  layout.shots[0].boxes.push({
    type: 'text',
    role: 'body',
    text: '越界的一行',
    left: 40,
    top: 300,
    right: 300,
    bottom: 330,
    width: 260,
    height: 30,
  });
  const result = checkAlignment(layout);
  const issues = issuesOf(result, 'safe-area');
  assert(issues.length === 1, 'issue 数=' + issues.length);
  const issue = issues[0];
  assertIssueShape(issue, 'safe-area');
  assert(issue.shotKind === 'opening', 'shotKind=' + issue.shotKind);
  near(issue.expected, 64, 0.01, 'expected 应为 5% 安全区 64');
  near(issue.actual, 40, 0.01, 'actual 应为 40');
  near(issue.delta, -24, 0.01, 'delta 应为 -24');
  assert(/安全区/.test(issue.message), '消息里没提安全区：' + issue.message);
});

step('安全区反例：文字下边界越过 684px → safe-area(bottom)', () => {
  const layout = baseLayout();
  layout.shots[1].boxes.push({
    type: 'text',
    role: 'note',
    text: '压到底边',
    left: 96,
    top: 670,
    right: 300,
    bottom: 700,
    width: 204,
    height: 30,
  });
  const result = checkAlignment(layout);
  const issues = issuesOf(result, 'safe-area');
  assert(issues.length === 1, 'issue 数=' + issues.length);
  near(issues[0].expected, 684, 0.01, 'expected 应为 684');
  near(issues[0].actual, 700, 0.01, 'actual 应为 700');
  near(issues[0].delta, 16, 0.01, 'delta 应为 +16');
});

step('零散字号：层里出现 23px → font-tier-drift（warn，不阻断 ok）', () => {
  const layout = baseLayout();
  layout.shots[1].textSizes.push({ role: 'title', size: 23, text: '偏小的标题' });
  const result = checkAlignment(layout);
  const issues = issuesOf(result, 'font-tier-drift');
  assert(issues.length === 1, 'issue 数=' + issues.length);
  assertIssueShape(issues[0], 'font-tier-drift');
  assert(issues[0].severity === 'warn', 'severity=' + issues[0].severity);
  near(issues[0].actual, 23, 0.001, 'actual 应为 23');
  assert(issues[0].expected === 26, 'expected 应取最近的 26：' + issues[0].expected);
  near(issues[0].delta, -3, 0.001, 'delta 应为 -3');
  assert(result.ok === true, 'warn 不该把 ok 打成 false');
});

console.log('A. 检查器 · 容差边界');

step('左边距边界：差 4px 通过，4.5px 报错', () => {
  const ok = baseLayout();
  ok.shots[2].contentLeft = ok.margin + ALIGN_LIMITS.marginTolerance;
  assert(checkAlignment(ok).ok === true, '差 4px 应当通过');

  const bad = baseLayout();
  bad.shots[2].contentLeft = bad.margin + ALIGN_LIMITS.marginTolerance + 0.5;
  const result = checkAlignment(bad);
  assert(result.ok === false, '差 4.5px 应当报错');
  near(issuesOf(result, 'margin-consistent')[0].delta, 4.5, 0.01, 'delta 应为 4.5');
});

step('基线边界：差 3px 通过，3.5px 报错', () => {
  // 只动一镜才测得到容差：四镜一起动，中位数跟着动，差值永远是 0
  const single = baseLayout();
  single.shots[3].roles.title.baseline += ALIGN_LIMITS.baselineTolerance;
  assert(checkAlignment(single).ok === true, '差 3px 应当通过');

  const bad = baseLayout();
  bad.shots[3].roles.title.baseline += ALIGN_LIMITS.baselineTolerance + 0.5;
  const result = checkAlignment(bad);
  assert(result.ok === false, '差 3.5px 应当报错');
  near(issuesOf(result, 'baseline-consistent')[0].delta, 3.5, 0.01, 'delta 应为 3.5');
});

step('字号层级边界：1.4 与 1.8 恰好通过，1.88 报错', () => {
  const lower = defaultStyleSpec();
  lower.font = { ...lower.font, heading: 70, subtitle: 50, body: 30, note: 20 };
  assert(checkAlignment(baseLayout(lower)).ok === true, '1.4 应当通过');

  const upper = defaultStyleSpec();
  upper.font = { ...upper.font, heading: 90, subtitle: 50, body: 30, note: 20 };
  assert(checkAlignment(baseLayout(upper)).ok === true, '1.8 应当通过');

  const over = defaultStyleSpec();
  over.font = { ...over.font, heading: 94, subtitle: 50, body: 30, note: 20 };
  assert(checkAlignment(baseLayout(over)).ok === false, '1.88 应当报错');
});

step('强调条边界：0.2 与 0.6 恰好通过，0.61 报错', () => {
  for (const [ratio, shouldPass] of [[0.2, true], [0.6, true], [0.61, false]]) {
    const layout = baseLayout();
    layout.shots[0].emphasis.ratio = ratio;
    const result = checkAlignment(layout);
    assert(
      result.ok === shouldPass,
      `比例 ${ratio} 的 ok=${result.ok}，应为 ${shouldPass}`,
    );
  }
});

console.log('B. 节拍音');

step('bpmFromRhythm：60/90/120 三档，节奏越短 BPM 越高', () => {
  assert(bpmFromRhythm(1).bpm === 120, '1 秒/镜应为 120 BPM');
  assert(bpmFromRhythm(2).bpm === 120, '2 秒/镜应为 120 BPM');
  assert(bpmFromRhythm(2.5).bpm === 90, '2.5 秒/镜应为 90 BPM');
  assert(bpmFromRhythm(3).bpm === 90, '3 秒/镜应为 90 BPM');
  assert(bpmFromRhythm(8).bpm === 60, '8 秒/镜应为 60 BPM');
  const tiers = [1, 3, 8].map((s) => bpmFromRhythm(s).bpm);
  assert(tiers.join(',') === '120,90,60', '三档没有覆盖 60/90/120：' + tiers.join(','));
  assert(BPM_TIERS.length === 3, 'BPM_TIERS 不是三档');
});

step('bpmFromRhythm：intervalMs = 60000/bpm，且四拍对齐镜头长度', () => {
  const fast = bpmFromRhythm(2);
  near(fast.intervalMs, 500, 1e-9, '120 BPM 的一拍应为 500ms');
  near(fast.intervalMs * 4, 2000, 1e-9, '四拍应正好 2 秒（= 每镜时长）');
  const slow = bpmFromRhythm(8);
  near(slow.intervalMs, 1000, 1e-9, '60 BPM 的一拍应为 1000ms');
  // 非法输入回落到样片的默认节奏，而不是 NaN
  assert(bpmFromRhythm('x').bpm === 120, '非法输入没有回落：' + bpmFromRhythm('x').bpm);
  assert(bpmFromRhythm(0).bpm === 120, '0 没有回落：' + bpmFromRhythm(0).bpm);
});

step('buildClickTrack：长度 = 时长 × 采样率，立体声，可直接当 audioBuffer', () => {
  const shots = buildStyleShots(defaultStyleSpec());
  const track = buildClickTrack(shots, { bpm: 120 });
  const duration = shots[shots.length - 1].end;
  assert(duration === PREVIEW_SECONDS, '样片时长=' + duration);
  assert(track.length === Math.round(duration * 48000), `长度=${track.length}，应为 ${Math.round(duration * 48000)}`);
  assert(track.sampleRate === 48000, 'sampleRate=' + track.sampleRate);
  assert(track.numberOfChannels === 2, '声道数=' + track.numberOfChannels);
  near(track.duration, duration, 1 / 48000, 'duration 应等于素材时长');
  // 导出端的 isAudioBufferLike 要这几个字段
  assert(typeof track.getChannelData === 'function', '缺 getChannelData');
  assert(track.getChannelData(0) instanceof Float32Array, '左声道不是 Float32Array');
  assert(track.getChannelData(1).length === track.length, '右声道长度不对');
  // 换采样率也要跟着变
  const half = buildClickTrack(shots, { bpm: 120, sampleRate: 24000 });
  assert(half.length === Math.round(duration * 24000), '24k 采样长度=' + half.length);
});

step('buildClickTrack：峰值在 -18dBFS 附近（不刺耳），弱拍更低', () => {
  const shots = buildStyleShots(defaultStyleSpec());
  const track = buildClickTrack(shots, { bpm: 120 });
  const target = Math.pow(10, CLICK_SPEC.peakDbfs / 20);
  near(track.peak, target, 0.003, '峰值应贴近 -18dBFS');
  const strong = track.beats.find((beat) => beat.strong);
  const weak = track.beats.find((beat) => !beat.strong);
  assert(strong && weak, '没有同时出现强拍与弱拍');
  const peakAt = (at) => {
    const data = track.getChannelData(0);
    const start = Math.round(at * track.sampleRate);
    let max = 0;
    for (let i = start; i < Math.min(track.length, start + track.sampleRate * 0.07); i += 1) {
      max = Math.max(max, Math.abs(data[i]));
    }
    return max;
  };
  assert(peakAt(weak.at) < peakAt(strong.at), '弱拍不该和强拍一样响');
});

step('buildClickTrack：强拍 880Hz / 弱拍 440Hz（用零交叉数判频率）', () => {
  const shots = buildStyleShots(defaultStyleSpec());
  const track = buildClickTrack(shots, { bpm: 120 });
  const data = track.getChannelData(0);
  const crossings = (at, ms) => {
    const start = Math.round(at * track.sampleRate);
    const count = Math.round((ms / 1000) * track.sampleRate);
    let result = 0;
    for (let i = start + 1; i < Math.min(track.length, start + count); i += 1) {
      if ((data[i - 1] < 0) !== (data[i] < 0)) result += 1;
    }
    return result;
  };
  const strong = track.beats.find((beat) => beat.strong && beat.at > 0.1);
  const weak = track.beats.find((beat) => !beat.strong);
  assert(strong && weak, '没有强弱拍可比');
  const strongCross = crossings(strong.at, 20);
  const weakCross = crossings(weak.at, 20);
  assert(strongCross > weakCross * 1.5, `强弱拍频率没拉开：${strongCross} vs ${weakCross}`);
  assert(CLICK_SPEC.strongHz === 880 && CLICK_SPEC.weakHz === 440, '频率常量不是 880/440');
});

step('buildClickTrack：拍点 = BPM 网格 ∪ 镜头起点，每镜起点是强拍', () => {
  const shots = buildStyleShots(defaultStyleSpec());
  const track = buildClickTrack(shots, { bpm: 120 });
  assert(track.beats.length === 16, '8 秒 120BPM 应有 16 个拍点：' + track.beats.length);
  const starts = shots.map((shot) => shot.start);
  for (const start of starts) {
    const beat = track.beats.find((item) => Math.abs(item.at - start) < 1e-6);
    assert(beat, `镜头起点 ${start}s 没有拍点`);
    assert(beat.strong === true, `镜头起点 ${start}s 不是强拍`);
  }
  const gaps = [];
  for (let i = 1; i < track.beats.length; i += 1) gaps.push(track.beats[i].at - track.beats[i - 1].at);
  assert(gaps.every((gap) => Math.abs(gap - 0.5) < 1e-6), '拍点间隔不是 500ms：' + gaps.join(','));
  // 60 BPM：8 个网格拍点上，0/2/4/6 同时是镜头起点，合并后仍是 8 个拍点、4 个强拍
  const slow = buildClickTrack(shots, { bpm: 60 });
  assert(slow.beats.length === 8, '60BPM 的拍点数=' + slow.beats.length);
  assert(slow.beats.filter((beat) => beat.strong).length === 4, '60BPM 的强拍数=' + slow.beats.filter((b) => b.strong).length);
});

step('clickTrackToWav：RIFF/WAVE 头，16bit 立体声，字节数对得上', () => {
  const shots = buildStyleShots(defaultStyleSpec());
  const track = buildClickTrack(shots, { bpm: 120, sampleRate: 8000 });
  const wav = clickTrackToWav(track);
  const text = (offset, length) => String.fromCharCode.apply(null, Array.from(wav.slice(offset, offset + length)));
  assert(text(0, 4) === 'RIFF', '缺 RIFF');
  assert(text(8, 4) === 'WAVE', '缺 WAVE');
  assert(text(36, 4) === 'data', '缺 data');
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert(view.getUint16(22, true) === 2, '声道数不是 2');
  assert(view.getUint32(24, true) === 8000, '采样率不对');
  assert(view.getUint16(34, true) === 16, '位深不是 16');
  assert(wav.length === 44 + track.length * 2 * 2, `WAV 字节数=${wav.length}`);
  assert(view.getUint32(40, true) === track.length * 4, 'data 段长度不对');
});

step('estimateTextWidth：中文 1em、英文数字更窄，多行取最长', () => {
  near(estimateTextWidth('一二三', 10), 30, 1e-6, '三个汉字应约 30px');
  assert(estimateTextWidth('abc', 10) < estimateTextWidth('一二三', 10), '英文应比中文窄');
  near(estimateTextWidth('一\n一二三', 10), 30, 1e-6, '多行应取最长的一行');
  assert(estimateTextWidth('', 10) === 0, '空串宽度应为 0');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
