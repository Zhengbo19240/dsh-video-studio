/**
 * 视频脚本契约：<工程根>/.dsh-video/script.json。
 *
 * 这一层只做**校验、归一化、草稿构建**，不渲染任何帧或视频，也不碰文件系统。
 * script.json 是「分镜级脚本」：每一镜要有时间、画面、旁白/口播、屏上文字、转场。
 *
 * 生命周期：
 * - `video_script_draft` 每改一次 → draftCount +1、confirmed 重置 false；
 * - 内容没变的重复 draft → 幂等，不累加、不重置；
 * - 只有 `video_script_confirm` 能把 confirmed 写成 true；
 * - `confirmed !== true` 时，阶段机不许进入 style（脚本没确认，不许渲染样片、不许开工）。
 */

/** script.json 的格式版本。 */
export const SCRIPT_VERSION = 1;

/** 时间比较的容差（秒）。 */
const EPSILON = 1e-6;

/** 毫秒 → ISO；非法值用当前时间。 */
function iso(now) {
  const value = Number.isFinite(now) ? now : Date.now();
  return new Date(value).toISOString();
}

/** 字符串去空白；非字符串 → 空串。 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 数字解析；非法返回 null（0 是合法数字，不算 null）。 */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 一镜在问题列表里的编号：优先用 shot.no，其次用序号。 */
function shotNumber(shot, index) {
  const no = finiteNumber(shot && shot.no);
  return no !== null && Number.isInteger(no) && no > 0 ? no : index + 1;
}

/**
 * 一镜的 time 只接受 { start, duration }（秒）。
 * 也接受 time 是 "0-3" 这种字符串吗？不接受——那会逼着后面每一步都再解析一次；
 * 明确的结构比宽松的字符串更好校验。
 */
function readTime(shot) {
  const time = shot && typeof shot === 'object' ? shot.time : null;
  if (!time || typeof time !== 'object' || Array.isArray(time)) return { error: 'missing' };
  return {
    start: finiteNumber(time.start),
    duration: finiteNumber(time.duration),
  };
}

/**
 * 校验脚本。不合法时**不返回归一化镜头**，让调用方不写盘。
 *
 * 规则：
 * - shots 必须是非空数组；
 * - 每镜 time.start 必须 ≥0，time.duration 必须 >0；
 * - 镜头必须首尾相接：start 与上一镜结束时间不一致 → 重叠 / 断档；
 * - visual 不能为空；
 * - narration 与 onScreenText 至少要有一样（两样都空 = 空镜）。
 *
 * @param {unknown} raw
 * @returns {{
 *   ok:boolean,
 *   problems:Array<{shot:number, field:string, message:string}>,
 *   shots:Array<object>,
 *   shotCount:number,
 *   totalDuration:number,
 *   title:string,
 *   logline:string,
 *   duration:number,
 * }}
 */
export function validateScript(raw) {
  const problems = [];
  const shots = [];
  const fallback = {
    ok: false,
    problems,
    shots,
    shotCount: 0,
    totalDuration: 0,
    title: '',
    logline: '',
    duration: 0,
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push({ shot: 0, field: 'script', message: 'script 必须是对象：{ title, logline, duration, shots }' });
    return fallback;
  }

  const title = text(raw.title);
  const logline = text(raw.logline);
  const rawShots = Array.isArray(raw.shots) ? raw.shots : null;
  if (!rawShots || rawShots.length === 0) {
    problems.push({ shot: 0, field: 'shots', message: 'shots 必须是非空数组：至少写 1 个镜头' });
    return { ...fallback, title, logline, shotCount: 0 };
  }

  let totalDuration = 0;
  let previousEnd = null;
  rawShots.forEach((shot, index) => {
    const no = shotNumber(shot, index);
    if (!shot || typeof shot !== 'object' || Array.isArray(shot)) {
      problems.push({ shot: no, field: 'shot', message: '镜头必须是对象：{ no, time, visual, narration, onScreenText, transition }' });
      previousEnd = null;
      return;
    }

    const time = readTime(shot);
    let start = null;
    let duration = null;
    if (time.error === 'missing') {
      problems.push({ shot: no, field: 'time', message: '缺时间：time 必须是 { start, duration }（秒）' });
    } else {
      start = time.start;
      duration = time.duration;
      if (start === null || start < 0) {
        problems.push({ shot: no, field: 'time.start', message: `起点必须是不小于 0 的数字（当前 ${JSON.stringify(start)}）` });
        start = null;
      }
      if (duration === null || duration <= 0) {
        problems.push({
          shot: no,
          field: 'time.duration',
          message: `每镜时长必须大于 0 秒（当前 ${JSON.stringify(duration)}）`,
        });
        duration = null;
      }
    }

    const visual = text(shot.visual);
    if (visual === '') problems.push({ shot: no, field: 'visual', message: '缺画面：visual 不能为空' });

    const narration = text(shot.narration);
    const onScreenText = text(shot.onScreenText);
    if (narration === '' && onScreenText === '') {
      problems.push({
        shot: no,
        field: 'narration',
        message: '空镜：narration 与 onScreenText 至少要有一样（旁白/口播或屏上文字）',
      });
    }

    const transition = text(shot.transition);

    if (start !== null && duration !== null) {
      if (previousEnd !== null) {
        const gap = start - previousEnd;
        if (gap < -EPSILON) {
          problems.push({
            shot: no,
            field: 'time.start',
            message: `与上一镜重叠：应从 ${previousEnd}s 开始，实际 ${start}s`,
          });
        } else if (gap > EPSILON) {
          problems.push({
            shot: no,
            field: 'time.start',
            message: `与上一镜之间有断档：应从 ${previousEnd}s 开始，实际 ${start}s`,
          });
        }
      }
      previousEnd = start + duration;
      totalDuration = previousEnd;
    } else {
      previousEnd = null;
    }

    shots.push({
      no,
      time: {
        start: start === null ? 0 : start,
        duration: duration === null ? 0 : duration,
      },
      visual,
      narration,
      onScreenText,
      transition,
    });
  });

  if (problems.length > 0) {
    return { ok: false, problems, shots: [], shotCount: rawShots.length, totalDuration: 0, title, logline, duration: 0 };
  }

  const declared = finiteNumber(raw.duration);
  return {
    ok: true,
    problems: [],
    shots,
    shotCount: shots.length,
    totalDuration,
    title,
    logline,
    duration: declared !== null && declared > 0 ? declared : totalDuration,
  };
}

/** 读取时归一化：结构不合法 → null（不存在、损坏、校验失败都走这条路）。 */
export function normalizeScript(raw, options = {}) {
  const checked = validateScript(raw);
  if (!checked.ok) return null;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const draftCount = finiteNumber(raw.draftCount);
  const doc = {
    version: SCRIPT_VERSION,
    title: checked.title,
    logline: checked.logline,
    duration: checked.duration,
    shots: checked.shots,
    confirmed: raw.confirmed === true,
    confirmedAt: typeof raw.confirmedAt === 'string' && raw.confirmedAt.trim() !== '' ? raw.confirmedAt : null,
    draftCount: draftCount !== null && draftCount >= 1 ? Math.floor(draftCount) : 1,
    revisedAt: typeof raw.revisedAt === 'string' && raw.revisedAt.trim() !== '' ? raw.revisedAt : iso(now),
  };
  const note = text(raw.note);
  if (note !== '') doc.note = note;
  return doc;
}

/** 内容签名：判断「这一版和上一版是不是同一份」（不含 draftCount / confirmed）。 */
export function scriptContentSignature(script) {
  if (!script || typeof script !== 'object') return '';
  return JSON.stringify([
    text(script.title),
    text(script.logline),
    Array.isArray(script.shots)
      ? script.shots.map((shot) => [
        shot.no,
        shot.time?.start,
        shot.time?.duration,
        text(shot.visual),
        text(shot.narration),
        text(shot.onScreenText),
        text(shot.transition),
      ])
      : [],
  ]);
}

/** 给工具与阶段状态用的摘要（不放整份镜头，只放数量与时长）。 */
export function scriptSummary(script) {
  if (!script || typeof script !== 'object') return null;
  const shots = Array.isArray(script.shots) ? script.shots : [];
  return {
    title: text(script.title),
    logline: text(script.logline),
    shotCount: shots.length,
    totalDuration: shots.reduce((sum, shot) => {
      const duration = finiteNumber(shot?.time?.duration);
      return sum + (duration !== null && duration > 0 ? duration : 0);
    }, 0),
    confirmed: script.confirmed === true,
    confirmedAt: script.confirmedAt ?? null,
    draftCount: Number(script.draftCount) || 0,
    revisedAt: script.revisedAt ?? null,
  };
}

/**
 * 构建草稿。
 *
 * - 校验失败 → `{ ok:false, problems, summary }`，调用方**不写盘**；
 * - 内容与上一版相同 → 幂等，保留 confirmed / draftCount / revisedAt；
 * - 内容变了 → draftCount +1、confirmed 重置 false、confirmedAt 清空。
 *
 * @param {unknown} raw 工具入参里的 script
 * @param {{prev?: unknown, now?: number}} [options]
 */
export function buildScriptDraft(raw, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const checked = validateScript(raw);
  const summary = {
    shotCount: checked.shotCount,
    totalDuration: checked.totalDuration,
    declaredDuration: checked.duration,
  };
  if (!checked.ok) {
    return { ok: false, problems: checked.problems, summary, script: null, idempotent: false };
  }

  const prev = options.prev ? normalizeScript(options.prev, { now }) : null;
  const base = {
    version: SCRIPT_VERSION,
    title: checked.title,
    logline: checked.logline,
    duration: checked.duration,
    shots: checked.shots,
  };

  if (prev && scriptContentSignature(prev) === scriptContentSignature(base)) {
    return { ok: true, problems: [], summary, script: prev, idempotent: true };
  }

  const script = {
    ...base,
    confirmed: false,
    confirmedAt: null,
    draftCount: (prev?.draftCount ?? 0) + 1,
    revisedAt: iso(now),
  };
  return { ok: true, problems: [], summary, script, idempotent: false };
}

/**
 * 确认脚本：把 confirmed 落成 true。
 * 调用方负责检查「脚本存在且合法」以及 brief 是否已满。
 */
export function buildScriptConfirmation(prev, options = {}) {
  const script = normalizeScript(prev, { now: options.now });
  if (!script) return null;
  const now = iso(options.now);
  const note = text(options.note);
  const next = {
    ...script,
    confirmed: true,
    confirmedAt: script.confirmed && script.confirmedAt ? script.confirmedAt : now,
  };
  if (note !== '') next.note = note;
  return next;
}
