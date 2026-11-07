/**
 * 主题变量的守门测试。
 *
 *   node scripts/theme-tokens-test.mjs
 *
 * 它守四件事：
 *   A. theme.js 的每个值都是 `var(--token, 回退值)`，回退值必须是合法颜色
 *      —— 离屏渲染（导出 / 缩略图 / headless）里没有 DSH 的 CSS 变量，
 *      回退值没了就会拿到空字符串；
 *   B. 用到的 token 名必须真的存在于 DSH 的 ui-theme 包里（不许猜）；
 *   C. main.js / panels.js / timeline.js 里不再出现已经映射过的硬编码色，
 *      但画布 / 时间线的产品色必须还在（不许误删）；
 *   D. 一个语义只对应一个 token（不能出现「边框有五种近似色」）。
 *
 * TOKENS 是 2026-11 从
 *   app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js
 * 里静态扫出来的别名清单（浅色在 body{}，深色在 body[data-ds-dark-theme]{}，
 * 各 119 个）。DSH 升级后这份清单若变了，这里会先红。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { T } from '../src/client/theme.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

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

/* ------------------------------------------------------------------ 事实 --- */

/** ui-theme 里真实存在的 `--dsw-alias-*`（去掉前缀，便于拼装）。 */
const ALIASES = new Set([
  'bg-base', 'bg-document-preview', 'bg-document-selection', 'bg-layer-1', 'bg-layer-2',
  'bg-layer-3', 'bg-mask-1', 'bg-mask-2', 'bg-mask-3', 'bg-mask-drop', 'bg-mask-photo',
  'bg-module-platform', 'bg-multi-select', 'bg-overlay', 'bg-skeleton',
  'border-inverted', 'border-inverted2', 'border-l1', 'border-l2', 'border-l2-darkmode-thin',
  'border-l3', 'border-l4',
  'brand-primary', 'brand-primary-invert', 'brand-primary-new-colorprimary-new-color', 'brand-text',
  'button-contrast-fill', 'button-elevated-fill', 'button-floating-fill', 'button-floating-hover',
  'button-ghost-active-border', 'button-ghost-active-fill', 'button-ghost-active-hover',
  'button-info-fill', 'button-info-hover', 'button-primary-dimmed', 'button-primary-fill',
  'button-primary-hover', 'button-tool-bar-fill', 'button-tool-bar-fill-invisible',
  'button-tool-bar-hover',
  'code-diff-added', 'code-diff-deleted',
  'file-diff-added-bg', 'file-diff-added-gutter', 'file-diff-added-marker',
  'file-diff-deleted-bg', 'file-diff-deleted-gutter', 'file-diff-deleted-marker',
  'illustration-background', 'illustration-backing', 'illustration-detail', 'illustration-inset',
  'illustration-shadow', 'illustration-surface',
  'interactive-bg-active', 'interactive-bg-hover', 'interactive-bg-hover-accent',
  'interactive-bg-hover-danger', 'interactive-bg-hover-solid',
  'label-caption', 'label-deep-diving', 'label-deep-diving-shimmer', 'label-dimmed',
  'label-document-preview', 'label-primary', 'label-primary-bluish', 'label-primary-dimmed',
  'label-primary-foreground', 'label-primary-inverted', 'label-secondary', 'label-shimmer',
  'label-tertiary', 'link',
  'markdown-citation', 'markdown-code-block', 'markdown-code-block-banner',
  'markdown-code-segment-selected', 'markdown-code-segment-unselected', 'markdown-inline-code',
  'markdown-placeholder', 'markdown-tag',
  'menu-group-header-fill', 'menu-icon',
  'scrollbar-bg-l1', 'scrollbar-bg-l2', 'scrollbar-hover-l1', 'scrollbar-hover-l2',
  'state-business-primary', 'state-business-tertiary', 'state-done-primary',
  'state-error-primary', 'state-error-secondary', 'state-idle-primary',
  'state-success-primary', 'state-success-secondary', 'state-success-tertiary',
  'state-warn-label', 'state-warn-primary', 'state-warn-secondary', 'state-warn-tertiary',
  'switch-thumb', 'toast-bg', 'toast-label', 'tooltip-bg', 'tooltip-key-bg',
  'turn-trigger-bg', 'turn-trigger-bg-hover',
  // settings.css 里另外两条（在 body{} 之外单独声明）
  'settings-card-fill', 'settings-card-stroke',
  // onboarding 相关（dark 块里单独声明）
  'onboarding-card-fill', 'onboarding-secondary-fill', 'onboarding-checkbox-border',
]);

/** 非 alias 的 DSH 变量族（圆角 / 字体 / 阴影）。 */
const OTHER_TOKENS = new Set([
  'dsw-radius-xs', 'dsw-radius-sm', 'dsw-radius-md', 'dsw-radius-lg', 'dsw-radius-xl',
  'dsw-radius-panel', 'dsw-shadow-lv1', 'dsw-shadow-lv2', 'dsw-shadow-lv3',
  'dsh-font-family-text', 'dsh-font-family-code', 'dsh-code-font-size', 'dsh-content-font-size',
]);

/** 颜色项：必须是 alias 变量 + 合法回退色。 */
const COLOR_KEYS = [
  'bg', 'panel', 'panelAlt', 'mask', 'text', 'textDim', 'textFaint', 'border', 'borderFaint',
  'borderStrong', 'accent', 'accentDim', 'danger', 'dangerDim', 'ok', 'warn', 'warnDim',
  'fill', 'fillStrong', 'primary', 'onPrimary',
];

/** 形状 / 排印项：变量族不同，但仍然必须是 var(+回退)。 */
const SHAPE_KEYS = ['radius', 'radiusSm', 'radiusLg', 'font', 'shadow'];

/** 曾经写死过、现在必须消失的字面量（按语义归并后的清单）。 */
const BANNED = [
  '#1e242c', // 面板底（写死在 OPTION_STYLE 里的那套深色）
  '#1b1b1b', // 面板底
  '#232323', // 弹层底
  '#262626', // 弹层底
  '#333', // 边框（5 种近似边框色之一）
  '#3a3a3a', // 边框
  '#ddd', // 主文字
  '#eee', // 主文字
  '#e6edf3', // 主文字
  '#aaa', // 次文字
  '#bbb', // 次文字
  '#9aa3ad', // 次文字
  'rgba(24,24,24,.97)', // 弹层底
  'rgba(24,24,24,.98)', // 弹层底
  'rgba(28,28,28,.98)', // 弹层底
  'rgba(20,20,20,.92)', // toast 底
  'rgba(255,255,255,.02)', // 轻填充
  'rgba(255,255,255,.03)', // 轻填充
  'rgba(255,255,255,.04)', // 轻填充
  'rgba(255,255,255,.06)', // 淡分隔线
  'rgba(255,255,255,.08)', // 边框
  'rgba(255,255,255,.1)', // 边框
  'rgba(255,255,255,.12)', // 边框
  'rgba(255,255,255,.14)', // 边框
  'rgba(255,255,255,.15)', // 边框
  'rgba(255,255,255,.18)', // 边框
  'rgba(120,140,160,.10)', // 中性填充
  'rgba(120,140,160,.16)', // 中性填充
  'rgba(120,140,160,.18)', // 中性填充
  'rgba(90,170,255,.55)', // 强调边框
  'rgba(240,180,41,.55)', // 提醒边框
  '#ffcf8a', // 提醒文字
  '#ffd479', // 提醒文字
  '#ffb3a0', // 危险文字
  '#ff9b8a', // 危险文字
  '#7ddc9a', // 成功文字
  '#9cc9ff', // 强调文字
  'linear-gradient(180deg,#3b82f6,#2563eb)', // 主按钮的蓝色渐变
  '#1d4ed8', // 主按钮描边
];

/** 画布 / 时间线的产品色：不许被主题化误删。 */
const PRODUCT = {
  'src/client/main.js': ['#000'],
  'src/client/panels.js': ['background: \'#000\'', '{ color: \'#000000\'' ],
  'src/client/timeline.js': [
    "'#4f8cff'", "'#8a63ff'", "'#37c98b'", "'#e0a336'", // 轨道点
    "'#2f6feb'", "'#b06a00'", "'#6a3fbf'", // 片段条（按类型）
    "'#ffd166'", // 选中描边 / 关键帧菱形 / 变速标
    "'#7ee0b0'", // 效果点
    "'#ff5f56'", // 播放头
    "'#2a1c00'", // 变速标文字
  ],
};

/** 三个外壳文件。 */
const FILES = ['src/client/main.js', 'src/client/panels.js', 'src/client/timeline.js'];

const isColor = (s) =>
  /^#[0-9a-f]{3}$/i.test(s) ||
  /^#[0-9a-f]{6}$/i.test(s) ||
  /^#[0-9a-f]{8}$/i.test(s) ||
  /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\)$/i.test(s) ||
  s === 'transparent';

const VAR_RE = /^var\(--([a-z0-9-]+),\s*(.+)\)$/;

/* -------------------------------------------------------------------- A --- */

console.log('A. theme.js 的形状');

step('必需的语义键都在', () => {
  for (const key of ['bg', 'panel', 'text', 'textDim', 'border', 'accent', 'danger', 'ok', 'radius', 'gap', 'font']) {
    assert(key in T, `缺 ${key}`);
  }
});

step('颜色项全部是 var(--dsw-alias-…, 回退色) 形式', () => {
  for (const key of COLOR_KEYS) {
    const value = T[key];
    assert(typeof value === 'string', `${key} 不是字符串`);
    assert(value.startsWith('var(--dsw-alias-'), `${key} 没用 alias 变量：${value}`);
    const m = value.match(VAR_RE);
    assert(m, `${key} 不是 var(token, fallback) 形式：${value}`);
  }
});

step('每个回退色都合法（#rgb / #rrggbb / rgba() / 8 位 hex）', () => {
  for (const key of COLOR_KEYS) {
    const m = T[key].match(VAR_RE);
    const fallback = m[2].trim();
    assert(isColor(fallback), `${key} 的回退色不合法：${JSON.stringify(fallback)}`);
  }
});

step('形状 / 排印项用各自的变量族，且回退非空', () => {
  for (const key of SHAPE_KEYS) {
    const m = String(T[key]).match(VAR_RE);
    assert(m, `${key} 不是 var(token, fallback) 形式：${T[key]}`);
    assert(m[2].trim().length > 0, `${key} 没有回退值`);
  }
  for (const key of ['radius', 'radiusSm', 'radiusLg']) {
    assert(T[key].startsWith('var(--dsw-radius-'), `${key} 没用 --dsw-radius-*：${T[key]}`);
  }
  assert(T.font.startsWith('var(--dsh-font-family-'), 'font 没用 --dsh-font-family-*');
});

step('gap 是数字：DSH 没有间距 alias（查过 asar，别硬造一个 token）', () => {
  assert(typeof T.gap === 'number' && Number.isFinite(T.gap), 'gap 必须是数字');
  assert(T.gap > 0 && T.gap <= 32, 'gap 数值越界：' + T.gap);
});

/* -------------------------------------------------------------------- B --- */

console.log('\nB. token 名是真货，不是猜的');

step('theme.js 引用的每个 token 都在 ui-theme 的实测清单里', () => {
  for (const [key, value] of Object.entries(T)) {
    if (typeof value !== 'string' || !value.startsWith('var(')) continue;
    const name = value.slice(6, value.indexOf(',')).trim();
    const bare = name.replace(/^--/, '');
    const known = bare.startsWith('dsw-alias-')
      ? ALIASES.has(bare.slice('dsw-alias-'.length))
      : OTHER_TOKENS.has(bare);
    assert(known, `${key} 用了不存在的 token：--${bare}`);
  }
});

step('没有假 token：不存在 --dsw-alias-border / -bg / -text 这类名字', () => {
  const fake = ['--dsw-alias-border', '--dsw-alias-bg,', '--dsw-alias-text', '--dsw-alias-bg-elevated', '--dsw-alias-brand,'];
  for (const file of FILES) {
    const src = read(file);
    for (const name of fake) {
      assert(!src.includes(name), `${file} 里还有假 token ${name}`);
    }
  }
});

step('theme.js 自己也只用清单里的名字', () => {
  const src = read('src/client/theme.js');
  // 注释里会写 `var(--token, 回退值)` 这种示意，先剥掉注释再扫。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // theme.js 用 v('token', fallback) 组装，只有 helper 里出现字面 var(——
  // 所以两种写法都要收：helper 的 var(--..) 和 v('..') 的实参。
  const used = [
    ...[...code.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]),
    ...[...code.matchAll(/\bv\('([a-z0-9-]+)'/g)].map((m) => m[1]),
  ];
  assert(used.length >= 20, 'theme.js 里的 token 太少：' + used.length);
  for (const name of new Set(used)) {
    const known = name.startsWith('dsw-alias-')
      ? ALIASES.has(name.slice('dsw-alias-'.length))
      : OTHER_TOKENS.has(name);
    assert(known, 'theme.js 用了不存在的 token：--' + name);
  }
});

/* -------------------------------------------------------------------- C --- */

console.log('\nC. 源码里不再有已映射的硬编码色');

step('三个文件都不再出现被禁的色值（逐条断言）', () => {
  const sources = Object.fromEntries(FILES.map((f) => [f, read(f)]));
  for (const literal of BANNED) {
    for (const file of FILES) {
      assert(
        !sources[file].includes(literal),
        `${file} 里还留着已映射的硬编码色 ${literal}`,
      );
    }
  }
});

step('1px 边框不再直接写颜色（全部走 T.*）', () => {
  for (const file of FILES) {
    const src = read(file);
    const direct = src.match(/border[A-Za-z]*:\s*'1px (solid|dashed) #/g) || [];
    assert(direct.length === 0, `${file} 里还有直接写颜色的边框：${direct[0]}`);
  }
});

step('三个文件都从 theme.js 取 T', () => {
  for (const file of FILES) {
    assert(read(file).includes("from './theme.js'"), file + ' 没 import theme.js');
    assert(/import\s*\{\s*T\s*\}\s*from\s*'\.\/theme\.js'/.test(read(file)), file + ' 没 import { T }');
  }
});

step('画布 / 时间线的产品色都还在（没被误删）', () => {
  for (const [file, needles] of Object.entries(PRODUCT)) {
    const src = read(file);
    for (const needle of needles) {
      assert(src.includes(needle), `${file} 丢了产品色 ${needle}`);
    }
  }
});

step('画布绘制代码没被主题化（ctx.fillStyle 仍是纯黑）', () => {
  const src = read('src/client/main.js');
  assert(src.includes("ctx.fillStyle = '#000'"), '预览画布的黑底被改掉了');
  assert(src.includes("background: '#000'"), '画布元素的底色被改掉了');
});

/* -------------------------------------------------------------------- D --- */

console.log('\nD. 一个语义一个 token');

/** 从属性名的冒号处往后取「这一个属性的值」，按括号深度与引号切，不看行。 */
function propValue(src, from) {
  const start = src.indexOf(':', from) + 1;
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) return src.slice(start, i);
      depth--;
    } else if (c === ',' && depth === 0) return src.slice(start, i);
    else if (c === '\n' && depth === 0 && /^\s*[A-Za-z_$][\w$]*\s*:/.test(src.slice(i + 1))) {
      return src.slice(start, i);
    }
  }
  return src.slice(start);
}

step('T 里没有两个键共用一个 token（否则等于没统一）', () => {
  const seen = new Map();
  for (const [key, value] of Object.entries(T)) {
    if (typeof value !== 'string' || !value.startsWith('var(')) continue;
    const name = value.slice(6, value.indexOf(',')).trim();
    assert(!seen.has(name), `${key} 和 ${seen.get(name)} 共用了 ${name}`);
    seen.set(name, key);
  }
});

step('T.border 只定义一次，且定义在 theme.js 里', () => {
  const src = read('src/client/theme.js');
  const hits = src.match(/dsw-alias-border-l2/g) || [];
  assert(hits.length === 1, `border-l2 在 theme.js 里出现 ${hits.length} 次`);
  assert(/border:\s*v\('dsw-alias-border-l2'/.test(src), 'T.border 定义变了，检查语义');
});

step('三个外壳文件里，所有边框都直接引用 T（不再各写各的）', () => {
  for (const file of FILES) {
    const src = read(file);
    const re = /border(?:Color|Top|Right|Bottom|Left)?:/g;
    let m;
    let total = 0;
    let bad = '';
    while ((m = re.exec(src))) {
      total += 1;
      const value = propValue(src, m.index);
      // 允许：T.* 变量；'none'；以及时间线转场三角这种产品色（允许清单里的白/黄）。
      const allowed = /T\.(border|borderFaint|borderStrong|accent|warn|danger|primary|onPrimary|bg|mask)/.test(value) ||
        /'none'/.test(value) ||
        /transparent/.test(value) ||
        /#ffd166/.test(value);
      if (!allowed) bad = value.replace(/\s+/g, ' ').trim().slice(0, 90);
    }
    assert(total >= 3, `${file} 的边框属性太少（${total}），检查文件是否改坏了`);
    assert(!bad, `${file} 有边框没走 T：${bad}`);
  }
});

step('构建产物 client.js 里带上了新 token（说明确实重建过）', () => {
  const bundle = read('client.js');
  for (const token of ['dsw-alias-bg-base', 'dsw-alias-border-l2', 'dsw-alias-label-primary', 'dsw-radius-md']) {
    assert(bundle.includes(token), 'client.js 里没有 ' + token + '（忘了 node scripts/build-client.mjs？）');
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
