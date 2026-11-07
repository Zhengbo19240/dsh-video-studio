/**
 * 动效/素材库。
 *
 * 两个来源合并成同一份条目表：
 *   1. ~/.agents/skills/<id>/        —— agent skill（vibe-motion 这类，SKILL.md + scripts）
 *   2. ~/.dsh/motion-lib/<id>/       —— 本工作台的原生移植（code.js），可覆盖同名 skill
 *
 * 判定：同一个 id，只要 ~/.dsh/motion-lib 里有 code.js，就算 native；
 * 否则来自 skills 的条目是 needRender（要跑它自己的脚本产文件）。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function motionRoot() {
  return process.env.DSH_MOTION_LIB || path.join(os.homedir(), '.dsh', 'motion-lib');
}

/** 默认只收录与视频/动效相关的 skill；其余 lark/office/academic 之类不该进素材库。 */
const DEFAULT_SKILL_ALLOWLIST = [
  '3d-chladni-render',
  'brand-launch-video-star',
  'claude-typer',
  'colorize',
  'fisheye-motion',
  'light-spotlight-render',
  'printed-curtain-render',
  'procedural-fish-render',
  'remotion-3d-ticker',
  'remotion-candlestick',
  'remotion-vinyl-player',
  'ruler-progress-render',
  'threejs-earth-render',
  'wechat-2d-render',
];

/**
 * 白名单文件：<motion-lib>/skill-allowlist.json，形如
 *   { "ids": ["colorize", "..."], "includeAll": false }
 * 文件存在时以它为准；不存在时用内置默认表。includeAll=true 才扫描全部 skill。
 */
function readAllowlist() {
  try {
    const raw = readFileSync(path.join(motionRoot(), 'skill-allowlist.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.includeAll === true) return null; // null = 不限制
    if (parsed && Array.isArray(parsed.ids)) return new Set(parsed.ids.map(String));
  } catch {
    /* 没有文件或写坏了，退回默认 */
  }
  return new Set(DEFAULT_SKILL_ALLOWLIST);
}

export function skillsRoot() {
  return process.env.DSH_SKILLS_DIR || path.join(os.homedir(), '.agents', 'skills');
}

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

/** 缩略图约定：卡目录下的 thumb.png，尺寸 480×270×3 横拼；meta.thumb 为相对路径。 */
const THUMB_FILE = 'thumb.png';
const THUMB_REASON = '需要外部渲染器，暂无原生实现';

/**
 * 从 meta 里解析缩略图的绝对路径。
 * 只认 meta.thumb；文件不在就返回 null（agent 拿到的路径必须能直接 read_image）。
 * 没写 thumb 字段的老卡，若目录里已有 thumb.png 也认，避免白丢图。
 */
async function resolveThumb(sub, meta, hasCode) {
  let declared;
  if (Object.prototype.hasOwnProperty.call(meta, 'thumb')) declared = meta.thumb;
  else declared = (await exists(path.join(sub, THUMB_FILE))) ? THUMB_FILE : null;
  const candidate = typeof declared === 'string' && declared.trim() ? declared.trim() : null;
  const thumb = candidate ? path.resolve(sub, candidate) : null;
  const thumbReady = thumb ? await exists(thumb) : false;
  const thumbReason = meta.thumbReason || (thumbReady ? null : hasCode ? '缩略图尚未生成' : THUMB_REASON);
  return { thumb: thumbReady ? thumb : null, thumbReason };
}

async function scan(dir, kind) {
  const allow = kind === 'skill' ? readAllowlist() : null;
  let dirs = [];
  try {
    dirs = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    if (allow && !allow.has(d.name)) continue;
    const sub = path.join(dir, d.name);
    const skillPath = path.join(sub, 'SKILL.md');
    const codePath = path.join(sub, 'code.js');
    const hasSkill = await exists(skillPath);
    const hasCode = await exists(codePath);
    if (!hasSkill && !hasCode) continue;
    const meta = await readJson(path.join(sub, 'meta.json'));
    const { thumb, thumbReason } = await resolveThumb(sub, meta, hasCode);
    let fm = {};
    if (hasSkill) {
      try {
        fm = parseFrontmatter(await fs.readFile(skillPath, 'utf8'));
      } catch {
        fm = {};
      }
    }
    out.push({
      id: d.name,
      title: meta.title || fm.name || d.name,
      description: meta.description || fm.description || '',
      kind: meta.kind || 'motion',
      tags: meta.tags || [],
      source: meta.source || (kind === 'skill' ? 'agents/skills' : 'motion-lib'),
      license: meta.license || null,
      native: hasCode,
      needRender: !hasCode,
      thumb,
      thumbReason,
      // 诚实性字段：只读透出，不改变任何既有行为。
      //   fixed        = 复核过、修好了，声明与实现一致
      //   approximate  = 只能做到近似，标题/描述已改成真实能做到的事，limitations 写清差在哪
      //   not-supported= 做不到，标废（文件保留，列表里可按键过滤掉）
      //   unreviewed   = 还没复核（老卡默认）
      verdict: typeof meta.verdict === 'string' ? meta.verdict : 'unreviewed',
      verdictReason: typeof meta.verdictReason === 'string' ? meta.verdictReason : null,
      limitations: Array.isArray(meta.limitations) ? meta.limitations.filter((x) => typeof x === 'string') : [],
      honestyCheckedAt: typeof meta.honestyCheckedAt === 'string' ? meta.honestyCheckedAt : null,
      libraryId: kind === 'skill' ? 'skills' : 'motion-lib',
      dir: sub,
    });
  }
  return out;
}

export async function listEntries(query) {
  const [natives, skills] = await Promise.all([
    scan(motionRoot(), 'native'),
    scan(skillsRoot(), 'skill'),
  ]);
  const byId = new Map();
  for (const s of skills) byId.set(s.id, s);
  for (const n of natives) {
    const prev = byId.get(n.id);
    byId.set(n.id, prev ? Object.assign({}, prev, n, { native: true, needRender: false }) : n);
  }
  let out = [...byId.values()];
  const q = String(query || '').trim().toLowerCase();
  if (q) {
    out = out.filter((e) =>
      (e.id + ' ' + e.title + ' ' + e.description + ' ' + e.tags.join(' ')).toLowerCase().includes(q),
    );
  }
  out.sort((a, b) => Number(b.native) - Number(a.native) || a.id.localeCompare(b.id));
  return out;
}

function safeId(id) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(id || ''))) throw new Error('非法条目 id');
  return String(id);
}

export async function readEntryCode(id) {
  safeId(id);
  try {
    return await fs.readFile(path.join(motionRoot(), id, 'code.js'), 'utf8');
  } catch {
    return null;
  }
}

export async function readEntryDoc(id) {
  safeId(id);
  for (const dir of [path.join(motionRoot(), id), path.join(skillsRoot(), id)]) {
    try {
      return await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
    } catch {
      /* 继续找下一个 */
    }
  }
  return null;
}
