#!/usr/bin/env node
/**
 * 配方卡转换器：把一张 `direct` 卡转成 motion-lib 条目。
 *
 *   node tools/convert.mjs --id tc-bar-chart-growth
 *   node tools/convert.mjs --all --dry                # 只报要转哪些，不写盘
 *   node tools/convert.mjs --all --limit 10
 *   node tools/convert.mjs --id tc-chart-grow --force # 已存在时先备份再覆盖
 *
 * 产出：
 *   ~/.dsh/motion-lib/<id>/code.js   —— export function render(ctx, t, env)，纯函数
 *   ~/.dsh/motion-lib/<id>/meta.json —— source / sourcePath / license / author 齐全
 *
 * 重要：转换器产出的是**自动骨架**，不是成品。骨架做三件事：
 *   1. 把卡里的参数表变成 props 默认值（人工改参数不用翻源码）；
 *   2. 按卡的时长与错峰参数画一个可运行、可 seek 的时间结构（标题 + 元素 + 结论条）；
 *   3. 顶部注释与 meta 里写明来源、作者、许可，meta.autoConverted/needsReview 标出「未标定」。
 * 真实画面由人工标定（见 tools/recipes/EVALUATION.md 的 5 张样本）。骨架不假装自己是成品。
 *
 * 冲突策略：目标目录已有 code.js 时默认**拒绝**（skipped），不静默覆盖；
 * `--force` 才写，且先把旧 code.js 备份成 code.js.bak-<时间戳>。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCatalog } from './recipes/catalog.mjs';

export function motionRoot() {
  return process.env.DSH_MOTION_LIB || path.join(os.homedir(), '.dsh', 'motion-lib');
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 3) {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}

/** 从卡片元数据里挑出能让骨架跑起来的最小参数集。 */
export function skeletonParams(card) {
  const props = {};
  const schema = card.paramsSchema && card.paramsSchema.properties ? card.paramsSchema.properties : {};
  for (const [key, spec] of Object.entries(schema)) {
    if (spec && (spec.type === 'number' || spec.type === 'string') && spec.default !== undefined) {
      props[key] = spec.default;
    }
  }
  return {
    title: card.title,
    duration: card.durationHint || 3,
    ...props,
  };
}

/** 生成 code.js 源码。纯函数：同样的 (t, env) 永远得到同一帧。 */
export function buildCode(card, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const defaults = skeletonParams(card);
  const duration = num(defaults.duration, 3);
  const paramKeys = Object.keys(defaults).filter((k) => k !== 'title' && k !== 'duration');
  const defaultsText = JSON.stringify(defaults, null, 2);
  const license = card.license || 'unknown';
  const sourceRepo = card.sourceRepo || '';

  return `/**
 * ${card.title} —— 自动转换骨架（autoConverted，尚未人工标定）
 *
 * 配方来源：${card.source} / ${card.sourcePath}
 * 来源仓库：${sourceRepo}
 * 作者：${card.author}（Vincentwei1021）
 * 许可：${license}
 * 许可说明：${card.licenseNote || ''}
 * 本项目不商用；如需商用，PolyForm 卡须先取得作者书面授权，Apache-2.0 卡须保留本声明。
 * 生成时间：${generatedAt}
 * 生成器：tools/convert.mjs
 *
 * 契约：render(ctx2d, t, env)，t 单位秒，env = { width, height, props, fps, duration }。
 * 只依赖 Canvas2D；不读时钟、不碰 DOM，任意 seek 结果一致。
 * 参数默认值来自卡里的参数表；人工标定时直接改 DEFAULTS 与 render 的绘制。
 */

export const meta = {
  title: ${JSON.stringify(card.title)},
  duration: ${duration},
  kind: ${JSON.stringify(card.kind)},
  source: ${JSON.stringify(card.source)},
  sourcePath: ${JSON.stringify(card.sourcePath)},
  license: ${JSON.stringify(license)},
  author: ${JSON.stringify(card.author)},
  autoConverted: true,
  needsReview: true,
};

// 卡里的参数表 → props 默认值（${paramKeys.length} 项）
const DEFAULTS = ${defaultsText};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const tw = (t, t0, d, ease) => ease(clamp01((t - t0) / d));
const lerp = (a, b, p) => a + (b - a) * p;

// 与 GSAP 同名的缓动（纯数学，实现自写）
const power2Out = (x) => 1 - Math.pow(1 - x, 3);
const power3Out = (x) => 1 - Math.pow(1 - x, 4);
const backOut = (s) => (x) => {
  const u = x - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
};

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

export function render(ctx, t, env) {
  const w = env.width;
  const h = env.height;
  const props = env.props || {};
  const cfg = Object.assign({}, DEFAULTS, props);
  const duration = Math.max(0.1, Number(cfg.duration) || ${duration});

  const accent = cfg.accent || '#e8720c';
  const ink = cfg.ink || '#1d1d1f';
  const paper = cfg.background || '#f6f6f8';

  // 背景（不放任何东西在这之前）
  ctx.save();
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, w, h);

  const pad = Math.round(w * 0.08);
  const titleSize = Math.round(h * 0.075);

  // ① 标题淡入（0.15 → 0.35s）
  const titleP = tw(t, 0.15, 0.35, power2Out);
  ctx.globalAlpha = titleP;
  ctx.fillStyle = ink;
  ctx.font = '600 ' + titleSize + 'px system-ui, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(String(cfg.title), pad, pad * 0.75);
  ctx.globalAlpha = 1;

  // ② 元素错峰升起：柱数 / 块数取 count（默认 7），错峰取 stagger 或整组 ≤0.4s 反算
  const count = Math.max(2, Math.min(24, Math.round(Number(cfg.count) || 7)));
  const total = duration * 0.45;
  const stagger = Math.min(
    Number(cfg.barStagger) || Number(cfg.stagger) || total / Math.max(1, count - 1),
    0.12,
  );
  const grow = Math.min(0.45, Math.max(0.16, total - stagger * (count - 1)));

  const baseY = Math.round(h * 0.86);
  const chartH = Math.round(h * 0.42);
  const chartW = Math.round(w - pad * 2);
  const slot = chartW / count;
  const barW = Math.min(slot * 0.58, Math.round(h * 0.09));

  // 基线
  const baseP = tw(t, 0.3, 0.24, power2Out);
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.fillRect(pad, baseY, chartW * baseP, Math.max(1, Math.round(h * 0.004)));

  // 柱子：只做 scaleY（与卡里的实现纪律一致：不动 height）
  const values = Array.isArray(cfg.values) && cfg.values.length === count
    ? cfg.values
    : Array.from({ length: count }, (_, i) => 18 + (i / Math.max(1, count - 1)) * 74);

  for (let i = 0; i < count; i += 1) {
    const p = tw(t, 0.5 + i * stagger, grow, power3Out);
    if (p <= 0) continue;
    const value = Math.max(0, Math.min(100, Number(values[i]) || 0));
    const full = (value / 100) * chartH;
    const x = pad + slot * i + (slot - barW) / 2;
    const y = baseY - full * p;
    ctx.fillStyle = accent;
    roundRect(ctx, x, y, barW, full * p, Math.min(barW * 0.18, 8));
    ctx.fill();
  }

  // ③ 结论条：最后一根到顶后弹出
  const lastTop = 0.5 + (count - 1) * stagger + grow;
  const chipP = tw(t, lastTop, 0.2, backOut(1.4));
  if (chipP > 0) {
    const label = String(cfg.chip || cfg.summary || cfg.title);
    ctx.save();
    ctx.font = '600 ' + Math.round(h * 0.045) + 'px system-ui, "Microsoft YaHei", sans-serif';
    const textW = ctx.measureText(label).width;
    const chipW = textW + Math.round(h * 0.06);
    const chipH = Math.round(h * 0.11);
    const chipX = pad + chartW - chipW;
    const chipY = baseY - chartH - chipH - Math.round(h * 0.04);
    ctx.globalAlpha = clamp01(chipP);
    ctx.translate(chipX + chipW, chipY + chipH / 2);
    ctx.scale(0.8 + 0.2 * chipP, 0.8 + 0.2 * chipP);
    ctx.translate(-(chipX + chipW), -(chipY + chipH / 2));
    ctx.fillStyle = accent;
    roundRect(ctx, chipX, chipY, chipW, chipH, chipH * 0.28);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, chipX + chipW / 2, chipY + chipH / 2 + 1);
    ctx.restore();
  }

  // ④ 底部时间轨：一眼看出当前 t 落在卡的哪一段（骨架专用，人工标定时删掉）
  const railY = h - Math.round(h * 0.035);
  const railH = Math.max(2, Math.round(h * 0.006));
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  ctx.fillRect(pad, railY, chartW, railH);
  ctx.fillStyle = accent;
  ctx.fillRect(pad, railY, chartW * clamp01(t / duration), railH);

  ctx.restore();
}
`;
}

export function buildMeta(card, options = {}) {
  return {
    title: card.title,
    kind: 'motion',
    tags: Array.isArray(card.tags) ? card.tags : [],
    source: card.source,
    sourcePath: card.sourcePath,
    sourceRepo: card.sourceRepo || '',
    license: card.license,
    licenseNote: card.licenseNote || '',
    author: card.author,
    description: card.intent || '',
    duration: card.durationHint || 3,
    feasibility: card.feasibility,
    kindClass: card.kind,
    category: card.category || '',
    autoConverted: true,
    needsReview: true,
    generatedAt: options.generatedAt || new Date().toISOString(),
    generatedBy: 'tools/convert.mjs',
    paramsSchema: card.paramsSchema || { type: 'object', properties: {}, required: [] },
    propsInputs: card.propsInputs || [],
  };
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 转换一张卡。
 * @returns {{ok:boolean, id:string, dir?:string, skipped?:boolean, reason?:string, backup?:string}}
 */
export async function convertCard(card, options = {}) {
  const root = options.motionRoot || motionRoot();
  const id = String(card.id || '');
  if (!/^(tc|sc)-[a-zA-Z0-9_-]{1,60}$/.test(id)) {
    return { ok: false, id, reason: 'id 必须是 tc-/sc- 前缀（不碰其它 agent 的目录）' };
  }
  if (card.feasibility !== 'direct') {
    return { ok: false, id, reason: `只转 direct 卡，这张是 ${card.feasibility}` };
  }
  const dir = path.join(root, id);
  const codePath = path.join(dir, 'code.js');
  const metaPath = path.join(dir, 'meta.json');
  const hasCode = await exists(codePath);

  if (hasCode && !options.force) {
    return {
      ok: false,
      skipped: true,
      id,
      dir,
      reason: 'code.js 已存在，未覆盖（要覆盖加 --force，会先备份）',
    };
  }

  let backup = null;
  if (hasCode && options.force) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = codePath + '.bak-' + stamp;
    await fs.copyFile(codePath, backup);
  }

  await fs.mkdir(dir, { recursive: true });
  const generatedAt = options.generatedAt || new Date().toISOString();
  await fs.writeFile(codePath, buildCode(card, { generatedAt }), 'utf8');
  await fs.writeFile(metaPath, JSON.stringify(buildMeta(card, { generatedAt }), null, 2) + '\n', 'utf8');
  return { ok: true, id, dir, backup };
}

function argValue(name, fallback) {
  const at = process.argv.indexOf(name);
  if (at >= 0 && process.argv[at + 1]) return process.argv[at + 1];
  return fallback;
}

async function main() {
  const catalog = await loadCatalog();
  const wanted = argValue('--id');
  const all = process.argv.includes('--all');
  const dry = process.argv.includes('--dry');
  const force = process.argv.includes('--force');
  const limit = Number(argValue('--limit', 0)) || 0;

  let cards = catalog.cards.filter((c) => c.feasibility === 'direct');
  if (wanted) cards = catalog.cards.filter((c) => c.id === wanted);
  if (limit > 0) cards = cards.slice(0, limit);
  if (!cards.length) {
    console.error(wanted ? `找不到卡 ${wanted}` : '目录里没有 direct 卡');
    process.exit(1);
  }

  let wrote = 0;
  let skipped = 0;
  let failed = 0;
  for (const card of cards) {
    if (dry) {
      console.log(`[dry] ${card.id} → ${path.join(motionRoot(), card.id)} (${card.durationHint}s)`);
      continue;
    }
    const result = await convertCard(card, { force });
    if (result.ok) {
      wrote += 1;
      console.log(`ok   ${result.id} → ${result.dir}${result.backup ? `（旧文件备份为 ${path.basename(result.backup)}）` : ''}`);
    } else if (result.skipped) {
      skipped += 1;
      console.log(`skip ${result.id}：${result.reason}`);
    } else {
      failed += 1;
      console.log(`fail ${result.id}：${result.reason}`);
    }
  }
  if (!dry) console.log(`\n转换完成：写入 ${wrote}，跳过 ${skipped}，失败 ${failed}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

export { exists as _exists };
