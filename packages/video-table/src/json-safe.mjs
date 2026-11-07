/**
 * 序列化前的清洗：把「JSON.stringify 会失真」的值，在返回之前就地修好。
 *
 * 背景：工具层拒收「非无损 JSON」的返回值（value is not lossless JSON）。
 * 一次 `measuredCaveat: 条件 ? 文案 : undefined` 就让 video_sound_search 整条废掉，
 * agent 据此判断「音效库不可用」，绕开整个库自己去下 mp3。失败的不是音效，
 * 是返回体里一个键：JSON.stringify 会把 undefined 键丢掉，往返后结构就变了。
 *
 * 所以规矩是：**返回之前过一遍。** 宁可给 null，也不给 undefined / NaN / Infinity /
 * function —— 那些东西在往返里会消失或变成 null，而调用方看不到「曾经有过」。
 *
 * 本模块只依赖内置能力，不 import 任何项目内模块，方便单独测试与复用。
 */

/** 环引用被替换成这个字符串（不编造深层结构，也不让整个返回失败） */
const CIRCULAR_TEXT = '[Circular]';

/**
 * 递归清洗一个值，返回「一定能 JSON 往返」的纯数据。
 *
 * 规则（顺序即优先级）：
 *   - undefined / function / symbol → 对象里删键，数组里变 null
 *   - number：NaN / ±Infinity → null
 *   - Date → ISO 字符串（非法日期 → null）
 *   - bigint → 安全范围内转 number，否则转十进制字符串
 *   - 数组：逐项清洗；项被清洗成 undefined 时写 null（长度与下标必须保留）
 *   - 普通对象：删掉值为 undefined 的键；有 toJSON 的先调 toJSON
 *   - 环引用 → '[Circular]'
 *
 * 不改变入参：返回的是新结构（原始对象里已经是不可变数据的部分也复制走一层）。
 */
export function sanitizeJson(value) {
  return clean(value, new WeakSet());
}

function clean(value, seen) {
  if (value === null) return null;

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'bigint') {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  // 这三类在 JSON 里没有对应表示：调用方（对象删键 / 数组填 null）自己处理
  if (value === undefined || type === 'function' || type === 'symbol') return undefined;

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      const cleaned = clean(item, seen);
      return cleaned === undefined ? null : cleaned;
    });
  }

  if (type === 'object') {
    if (seen.has(value)) return CIRCULAR_TEXT;
    seen.add(value);

    let source = value;
    if (typeof value.toJSON === 'function') {
      try {
        source = value.toJSON();
      } catch {
        source = value; // toJSON 自己坏了，按普通对象处理，绝不让清洗抛错
      }
    }

    // toJSON 可能返回原始值（Date / 自定义类常见）：再洗一遍
    if (source !== value && (source === null || typeof source !== 'object')) {
      seen.delete(value);
      return clean(source, seen);
    }

    const out = {};
    for (const key of Object.keys(source)) {
      const raw = source[key];
      if (raw === undefined) continue; // 关键一步：值为 undefined 的键直接不写
      const cleaned = clean(raw, seen);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    seen.delete(value);
    return out;
  }

  return null;
}

/**
 * 深扫一个值里的「非无损」成分，返回路径清单（空数组 = 无损）。
 *
 * 与 sanitizeJson 的区别：这个函数**不改**值，只报告问题，给测试和排错用。
 * 报告项：undefined（含值为 undefined 的键）、NaN/Infinity、function、symbol、
 * bigint、非法 Date、环引用。
 */
export function scanLossy(value, pathStr = '$', out = [], seen = new WeakSet()) {
  if (value === undefined) {
    out.push({ path: pathStr, kind: 'undefined' });
    return out;
  }

  const type = typeof value;
  if (type === 'number') {
    if (!Number.isFinite(value)) out.push({ path: pathStr, kind: String(value) });
    return out;
  }
  if (type === 'function' || type === 'symbol' || type === 'bigint') {
    out.push({ path: pathStr, kind: type });
    return out;
  }
  if (value === null || type !== 'object') return out;

  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) out.push({ path: pathStr, kind: 'invalid Date' });
    return out;
  }

  if (seen.has(value)) {
    out.push({ path: pathStr, kind: 'circular' });
    return out;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) scanLossy(value[i], pathStr + '[' + i + ']', out, seen);
  } else {
    for (const key of Object.keys(value)) {
      const child = value[key];
      const childPath = pathStr + '.' + key;
      if (child === undefined) out.push({ path: childPath, kind: 'undefined' });
      else scanLossy(child, childPath, out, seen);
    }
  }

  seen.delete(value);
  return out;
}

/** 这个值过不过得了「无损 JSON」这一关 */
export function isLosslessJson(value) {
  return scanLossy(value).length === 0;
}

/**
 * 把错误整理成可安全返回/记录的形状。
 *
 * 错误分支也要能过同一个清洗：DomainError 的 details 里可能塞了 undefined 或 Error 对象。
 * 这里只取三样：code / message / details（清洗过），不把 stack 泄给调用方。
 */
export function errorJson(error) {
  const e = error && typeof error === 'object' ? error : {};
  return sanitizeJson({
    code: typeof e.code === 'string' && e.code ? e.code : 'INTERNAL',
    message: typeof e.message === 'string' && e.message ? e.message : String(error),
    details: e.details === undefined ? null : e.details,
  });
}
