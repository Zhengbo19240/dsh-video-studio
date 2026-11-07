/**
 * Build the client half: esbuild bundles src/client/main.js into CJS, then we
 * wrap it in DSH's lazy module factory (window.__ModuleLoader__.load).
 *
 *   node scripts/build-client.mjs
 *   node scripts/build-client.mjs --watch
 */

import { build, context } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outfile = path.join(root, '.build', 'client.bundle.cjs');
const final = path.join(root, 'client.js');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(root, 'src/client/main.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome120'],
  external: ['react'],
  outfile,
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'info',
  loader: { '.css': 'text' },
};

async function wrap() {
  const body = await readFile(outfile, 'utf8');
  const header = `/* built by scripts/build-client.mjs — do not edit by hand */
window.__ModuleLoader__.load({
  id: 'dsh-video-workbench',
  factory(require) {
    try {
      const module = { exports: {} };
      const exports = module.exports;
`;
  const footer = `
      return module.exports && module.exports.default ? module.exports.default : module.exports;
    } catch (e) {
      try {
        console.error('[video-workbench] bundle failed', e);
        fetch('/api/video/beacon', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage: 'factory-error', detail: String((e && e.message) || e) }),
        }).catch(function () {});
      } catch (_) {}
      return { inject: [], apply: function () {} };
    }
  },
});
`;
  await mkdir(path.dirname(final), { recursive: true });
  await writeFile(final, header + body + footer, 'utf8');
  console.log('wrote ' + path.relative(root, final));
}

if (watch) {
  const ctx = await context({
    ...options,
    plugins: [
      {
        name: 'wrap',
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length) return;
            await wrap();
          });
        },
      },
    ],
  });
  await ctx.watch();
  console.log('watching src/client …');
} else {
  await build(options);
  await wrap();
}
