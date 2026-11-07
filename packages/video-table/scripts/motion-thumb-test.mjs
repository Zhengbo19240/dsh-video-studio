/**
 * 缩略图模块的 Node 测试：不启动真 Worker / 真 canvas，只验证两条硬约定——
 *   1. 源码没有 render 导出时必须 reject；
 *   2. 同一个 id + t 只渲染一次（缓存命中）。
 *
 *   node scripts/motion-thumb-test.mjs
 */

import {
  assertRenderSource,
  clearThumbCache,
  getCachedThumb,
  hasRenderExport,
  renderThumb,
  thumbCacheKey,
} from '../src/client/motion-thumb.js';

let pass = 0;
let fail = 0;

async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (error) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + (error && error.message ? error.message : error));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await t('识别 export function render', () => {
  assert(hasRenderExport('export const meta = {};\nexport function render(ctx, t, env) {}'), '漏识普通函数导出');
  assert(hasRenderExport('export async function render(ctx, t, env) {}'), '漏识 async 函数导出');
});

await t('识别 export const / export { render } 写法', () => {
  assert(hasRenderExport('export const render = (ctx, t, env) => {};'), '漏识 const 导出');
  assert(hasRenderExport('function draw(ctx, t, env) {}\nexport { draw as render };'), '漏识导出列表');
});

await t('注释里的 render 不算导出', () => {
  assert(!hasRenderExport('// export function render(ctx, t, env) {}\nexport const meta = {};'), '把注释当成了导出');
  assert(!hasRenderExport('/* export function render(ctx, t, env) {} */'), '把块注释当成了导出');
});

await t('没有 render 导出会 reject，且 message 可读', async () => {
  let error = null;
  try {
    await renderThumb('export const meta = { title: "无 render" };', 64, 36, 1, { id: 'no-render' });
  } catch (e) {
    error = e;
  }
  assert(error instanceof Error, '没有 reject 一个 Error');
  assert(/render/.test(error.message), '错误信息里没有提到 render：' + error.message);
});

await t('空源码会 reject', async () => {
  let error = null;
  try {
    await renderThumb('', 64, 36, 1, { id: 'empty' });
  } catch (e) {
    error = e;
  }
  assert(error instanceof Error, '空源码没有 reject');
});

await t('同一 id + t 只渲染一次，并命中缓存', async () => {
  clearThumbCache();
  let calls = 0;
  const source = 'export function render(ctx, t, env) { ctx.fillRect(0, 0, env.width, env.height); }';
  const fakeRender = async () => {
    calls += 1;
    return 'data:image/png;base64,TEST-THUMB';
  };

  const [first, second] = await Promise.all([
    renderThumb(source, 64, 36, 1, { id: 'cache-hit', renderImpl: fakeRender }),
    renderThumb(source, 64, 36, 1, { id: 'cache-hit', renderImpl: fakeRender }),
  ]);
  const third = await renderThumb(source, 64, 36, 1, { id: 'cache-hit', renderImpl: fakeRender });

  assert(calls === 1, '同一 id + t 渲染了 ' + calls + ' 次，应该只有 1 次');
  assert(first === second && second === third, '三次返回的 dataURL 不一致');
  assert(getCachedThumb('cache-hit', 64, 36, 1) === first, '缓存里没有这张图');
  assert(thumbCacheKey('cache-hit', 64, 36, 1).startsWith('cache-hit@1.000@64x36'), '缓存键格式不对');
});

await t('不同 id 会各自渲染一次', async () => {
  clearThumbCache();
  let calls = 0;
  const fakeRender = async () => {
    calls += 1;
    return 'data:image/png;base64,ID-' + calls;
  };
  const source = 'export function render(ctx, t, env) {}';
  await renderThumb(source, 64, 36, 1, { id: 'id-a', renderImpl: fakeRender });
  await renderThumb(source, 64, 36, 1, { id: 'id-b', renderImpl: fakeRender });
  assert(calls === 2, '不同 id 命中了同一个缓存，渲染次数=' + calls);
});

await t('assertRenderSource 直接抛出带 message 的 Error', () => {
  let error = null;
  try {
    assertRenderSource('export const meta = {};');
  } catch (e) {
    error = e;
  }
  assert(error instanceof Error, '没有抛 Error');
  assert(error.message.includes('render'), 'message 里没有 render：' + error.message);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
