/**
 * 风格产物契约：<工程根>/.dsh-video/style.json。
 *
 * 这里只做**校验与归一化**，不渲染任何帧或视频——预览产物是工作台那一路的事，
 * 本插件只负责把"用户已经确认过这一版风格"这件事记下来。
 *
 * spec 五件套缺一不可：
 *   tone    一句调性描述
 *   palette 1..12 个 #RGB/#RRGGBB/#RRGGBBAA
 *   font    字体 / 字族
 *   density low | med | high
 *   pace    秒 / 镜头（>0 且 ≤60）
 * preview 可选：
 *   keyframes 最多 4 张**相对路径**
 *   clip      8 秒预览片，**相对路径**、.mp4
 */

/** 密度枚举。 */
export const STYLE_DENSITIES = ['low', 'med', 'high'];

/** 宽松一点的颜色格式：3/4/6/8 位十六进制。 */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** 相对路径判定：不接受盘符、根路径、URL scheme，也不接受 .. 逃逸。 */
export function isRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const text = value.trim();
  if (/^[a-zA-Z]:[\\/]/.test(text)) return false;
  if (text.startsWith('/') || text.startsWith('\\')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return false;
  const parts = text.split(/[\\/]+/);
  return !parts.includes('..');
}

/** 截断文本到上限。 */
function clipText(value, limit) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * 校验并归一化 spec。
 * @returns {{ok:boolean, spec:null|object, errors:string[]}}
 */
export function normalizeStyleSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, spec: null, errors: ['spec 必须是对象：{ tone, palette, font, density, pace }'] };
  }
  const errors = [];
  const tone = typeof raw.tone === 'string' ? raw.tone.trim() : '';
  const font = typeof raw.font === 'string' ? raw.font.trim() : '';
  if (tone === '') errors.push('tone 不能为空（一句调性描述，例如「克制、专业，不喊口号」）');
  else if (tone.length > 200) errors.push('tone 太长（≤200 字）');
  if (font === '') errors.push('font 不能为空（字体 / 字族）');
  else if (font.length > 200) errors.push('font 太长（≤200 字）');

  const palette = [];
  if (!Array.isArray(raw.palette) || raw.palette.length === 0) {
    errors.push('palette 至少给 1 个十六进制颜色，例如 ["#0B0B0F", "#7C5CFF"]');
  } else if (raw.palette.length > 12) {
    errors.push('palette 最多 12 个颜色');
  } else {
    for (const item of raw.palette) {
      const color = typeof item === 'string' ? item.trim() : '';
      if (!HEX_COLOR.test(color)) {
        errors.push(`palette 里的 ${JSON.stringify(item)} 不是合法十六进制颜色（#RGB / #RRGGBB）`);
        break;
      }
      palette.push(color);
    }
  }

  const density = typeof raw.density === 'string' ? raw.density.trim().toLowerCase() : '';
  if (!STYLE_DENSITIES.includes(density)) errors.push('density 只能是 low / med / high');

  const pace = Number(raw.pace);
  if (!Number.isFinite(pace) || pace <= 0 || pace > 60) {
    errors.push('pace 必须是 >0 且 ≤60 的数字（秒/镜头）');
  }

  if (errors.length > 0) return { ok: false, spec: null, errors };
  return { ok: true, spec: { tone: clipText(tone, 200), palette, font: clipText(font, 200), density, pace }, errors: [] };
}

/**
 * 校验并归一化 preview（可选）。
 * @returns {{ok:boolean, preview:null|object, errors:string[]}}
 */
export function normalizeStylePreview(raw) {
  if (raw === undefined || raw === null) return { ok: true, preview: null, errors: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, preview: null, errors: ['preview 必须是对象：{ keyframes, clip }'] };
  }
  const errors = [];
  const preview = {};
  if (raw.keyframes !== undefined) {
    if (!Array.isArray(raw.keyframes)) {
      errors.push('preview.keyframes 必须是数组（相对路径，最多 4 张）');
    } else {
      if (raw.keyframes.length > 4) errors.push('preview.keyframes 最多 4 张');
      const list = [];
      for (const item of raw.keyframes) {
        if (!isRelativePath(item)) {
          errors.push(`preview.keyframes 里的 ${JSON.stringify(item)} 必须是不带盘符、不以 / 开头、不含 .. 的相对路径`);
          break;
        }
        list.push(String(item).trim());
      }
      preview.keyframes = list;
    }
  }
  if (raw.clip !== undefined) {
    if (!isRelativePath(raw.clip)) {
      errors.push('preview.clip 必须是相对路径（相对工程根）');
    } else {
      const clip = String(raw.clip).trim();
      if (!/\.mp4$/i.test(clip)) errors.push('preview.clip 必须是 .mp4（8 秒预览片）');
      else preview.clip = clip;
    }
  }
  if (errors.length > 0) return { ok: false, preview: null, errors };
  return { ok: true, preview: Object.keys(preview).length > 0 ? preview : null, errors: [] };
}

/**
 * 读盘归一化：只认 confirmed=true 且 spec 合法的 style.json。
 * 坏结构 / 未确认 / spec 不合法 → null（读工具返回 null，而不是抛错）。
 */
export function normalizeStyle(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.confirmed !== true) return null;
  const spec = normalizeStyleSpec(raw.spec);
  if (!spec.ok) return null;
  const preview = normalizeStylePreview(raw.preview);
  const fallbackAt = new Date(Number.isFinite(options.now) ? options.now : Date.now()).toISOString();
  const style = {
    spec: spec.spec,
    confirmed: true,
    confirmedAt: typeof raw.confirmedAt === 'string' && raw.confirmedAt.trim() !== '' ? raw.confirmedAt : fallbackAt,
    confirmedBy: raw.confirmedBy === 'tool' ? 'tool' : 'user',
  };
  if (preview.ok && preview.preview) style.preview = preview.preview;
  return style;
}

/**
 * 工具入口：先校验，再生成要落盘的对象。
 * @returns {{ok:boolean, style:null|object, errors:string[]}}
 */
export function buildStyle(input = {}) {
  const spec = normalizeStyleSpec(input.spec);
  const preview = normalizeStylePreview(input.preview);
  const errors = [...spec.errors, ...preview.errors];
  if (errors.length > 0) return { ok: false, style: null, errors };
  const style = {
    spec: spec.spec,
    confirmed: true,
    confirmedAt: new Date(Number.isFinite(input.now) ? input.now : Date.now()).toISOString(),
    confirmedBy: 'user',
  };
  if (preview.preview) style.preview = preview.preview;
  return { ok: true, style, errors: [] };
}
