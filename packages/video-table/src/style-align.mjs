/**
 * S1「风格确认」的对齐检查器：只做几何测量与判定，不碰 DOM、不画像素。
 *
 * 为什么要有这个文件：样片「看着哪里不对，但说不出哪里」——因为版式只活在绘制
 * 函数的坐标里，没有人把它量出来。这里把四镜的层展开成带数值的盒子（左边界、
 * 基线、字号、强调条长度、圆角/描边、安全区），再由 checkAlignment 逐项判定。
 * 每条问题都带 expected / actual / delta 三个数，面板据此说「数据卡左边距 100px，
 * 其余 96px，差 4px」，而不是「不齐」。
 *
 * 依赖方向：style-spec.mjs → style-align.mjs（版式在 style-spec 里定，这里只读几何）。
 * 本文件不 import 任何模块，所以不会成环；也因此它能被 node 测试直接 import。
 *
 * 文字宽度是估算，不是 ctx.measureText：node 里没有 canvas，而检查器必须在
 * 宿主、客户端、测试三处给出同一个答案。估算规则与「字宽」的常识一致
 * （CJK 1em、大写 0.66em、小写 0.52em、数字 0.56em），只用来说明比例关系，
 * 不用来量像素级排版；左边距/基线/安全区这几项仍然是确定性数值。
 */

/** 各项容差与合法区间。测试、面板、route 都读这里，不各写一遍数字。 */
export const ALIGN_LIMITS = {
  /** 四镜主内容左边界的一致性容差（px） */
  marginTolerance: 4,
  /** 标题/副标题基线的一致性容差（px） */
  baselineTolerance: 3,
  /** 字号层级相邻两级之比必须在 [1.4, 1.8] */
  typeRatio: [1.4, 1.8],
  /** 强调条长度 / 所属标题宽度必须在 [0.2, 0.6] */
  emphasisRatio: [0.2, 0.6],
  /** 安全区：四周留 5% */
  safeMargin: 0.05,
};

/** 参检的基线角色（四镜里出现两次以上才比较）。 */
const BASELINE_ROLES = ['eyebrow', 'title', 'subtitle'];

/** 字号层级的四级顺序（也是比较顺序）。 */
const TYPE_TIERS = ['heading', 'subtitle', 'body', 'note'];

/** 框类型的中文名（面板与报错都用它，避免出现英文 role）。 */
export const BOX_LABELS = {
  // 字号四级的键名（type-scale 直接拿它拼消息）
  heading: '标题',
  // 层上的角色名
  eyebrow: '眉标',
  title: '标题',
  subtitle: '副标题',
  body: '正文',
  note: '注释',
  emphasis: '强调条',
  badge: '徽标',
  bar: '读数条',
  label: '读数标签',
};

const CJK = /[\u1100-\u11FF\u2E80-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;

const round3 = (v) => Math.round(Number(v) * 1000) / 1000;

function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 单行文字宽度的估算（em 系数见文件头）。多行取最长的一行。 */
export function estimateTextWidth(text, sizePx) {
  const size = Math.max(1, finite(sizePx, 16));
  let widest = 0;
  for (const line of String(text === undefined || text === null ? '' : text).split('\n')) {
    let em = 0;
    for (const ch of line) {
      let w;
      if (CJK.test(ch)) w = 1;
      else if (ch === ' ') w = 0.28;
      else if (/[0-9]/.test(ch)) w = 0.56;
      else if (/[A-Z]/.test(ch)) w = 0.66;
      else if (/[a-z]/.test(ch)) w = 0.52;
      else if (/[.,:;!?'"|·、，。/]/.test(ch)) w = 0.34;
      else w = 0.52;
      em += w;
    }
    widest = Math.max(widest, em);
  }
  return widest * size;
}

/** 行数（绘制端按 '\n' 硬切，不做自动换行 —— 检查器必须和它一致）。 */
export function countTextLines(text) {
  return String(text === undefined || text === null ? '' : text).split('\n').length;
}

function median(values) {
  const list = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/**
 * 把一个镜头的内容层量成盒子。
 *
 * 入参是 buildStyleShots 给的镜头（layers + theme）。这里只读，不写回 ——
 * 检查器不能顺手改画面，否则「检查通过」就变成「检查者自己摆平」。
 */
function measureShot(shot, width, height, scale) {
  const theme = (shot && shot.theme) || {};
  const layers = Array.isArray(shot && shot.layers) ? shot.layers : [];
  const boxes = [];
  let contentLeft = Infinity;

  for (const layer of layers) {
    if (!layer || layer.type === 'backdrop' || layer.type === 'grid') continue;
    const x = finite(layer.x, 0.1) * width;
    const y = finite(layer.y, 0.5) * height;

    if (layer.type === 'text') {
      const size = Math.max(1, finite(layer.size, 28) * scale);
      const lineHeight = size * finite(layer.lineHeight, 1.2);
      const lines = countTextLines(layer.text);
      const w = estimateTextWidth(layer.text, size);
      const h = (lines - 1) * lineHeight + size;
      const align = layer.align || 'left';
      const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
      boxes.push({
        type: 'text',
        role: layer.role || 'body',
        text: layer.text,
        left,
        top: y,
        right: left + w,
        bottom: y + h,
        width: w,
        height: h,
        size,
        designSize: finite(layer.size, 28),
        baseline: y,
      });
      contentLeft = Math.min(contentLeft, left);
      continue;
    }

    if (layer.type === 'rule') {
      const h = Math.max(1, finite(layer.h, 6) * scale);
      const w = Math.max(2, finite(layer.w, 0.1) * width);
      boxes.push({ type: 'rule', role: 'emphasis', left: x, top: y, right: x + w, bottom: y + h, width: w, height: h });
      contentLeft = Math.min(contentLeft, x);
      continue;
    }

    if (layer.type === 'bar') {
      const h = Math.max(1, finite(layer.h, 14) * scale);
      const w = Math.max(2, finite(layer.w, 0.6) * width);
      boxes.push({ type: 'bar', role: 'bar', left: x, top: y, right: x + w, bottom: y + h, width: w, height: h });
      contentLeft = Math.min(contentLeft, x);
      // 读数标签画在条上方 8px、基线对齐底部；它也是文字，必须一起进安全区
      const labelSize = Math.max(1, finite(layer.labelSize, 15) * scale);
      const label = String(layer.label === undefined ? '' : layer.label);
      boxes.push({
        type: 'text',
        role: 'label',
        text: label,
        left: x,
        top: y - 8 * scale - labelSize,
        right: x + estimateTextWidth(label, labelSize),
        bottom: y - 8 * scale,
        width: estimateTextWidth(label, labelSize),
        height: labelSize,
        size: labelSize,
        designSize: finite(layer.labelSize, 15),
        baseline: y - 8 * scale - labelSize,
      });
      continue;
    }

    if (layer.type === 'badge') {
      const size = Math.max(1, finite(layer.size, 15) * scale);
      const pad = 12 * scale;
      const text = String(layer.text === undefined ? '' : layer.text);
      // 与 paintShotLayers 里的算法保持一致：它用字符数 × 0.62em，不是估算宽度
      const w = Math.min(width * 0.8, Array.from(text).length * size * 0.62 + pad * 2);
      const h = size * 2;
      boxes.push({ type: 'badge', role: 'badge', text, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h });
      contentLeft = Math.min(contentLeft, x);
    }
    // scrim 是满幅背景，按设计就该出画，不参与左边距与安全区
  }

  const roles = {};
  for (const box of boxes) {
    if (box.type === 'text' && box.role && box.role !== 'label' && !roles[box.role]) roles[box.role] = box;
  }

  const emphasisBox = boxes.find((box) => box.type === 'rule') || null;
  const reference =
    (roles.title && roles.title.width ? roles.title : null) ||
    (roles.subtitle && roles.subtitle.width ? roles.subtitle : null) ||
    (roles.body && roles.body.width ? roles.body : null);

  return {
    index: Number.isInteger(shot && shot.index) ? shot.index : 0,
    kind: (shot && shot.kind) || 'unknown',
    label: (shot && shot.label) || (shot && shot.kind) || 'unknown',
    contentLeft: Number.isFinite(contentLeft) ? contentLeft : null,
    radius: Number.isFinite(Number(theme.radius)) ? Number(theme.radius) : null,
    strokeWidth: Number.isFinite(Number(theme.strokeWidth)) ? Number(theme.strokeWidth) : null,
    padding: Number.isFinite(Number(theme.padding)) ? Number(theme.padding) : null,
    roles,
    boxes,
    textSizes: boxes.filter((box) => box.type === 'text').map((box) => ({ role: box.role, size: box.designSize, text: box.text })),
    emphasis: emphasisBox
      ? {
          width: emphasisBox.width,
          reference: reference ? { role: reference.role, width: reference.width } : null,
          ratio: reference && reference.width ? emphasisBox.width / reference.width : null,
        }
      : null,
  };
}

/**
 * 量一份「四镜布局」。
 *
 * @param {Array} shots buildStyleShots 的输出（只读）
 * @param {{spec?: object, width?: number, height?: number}} [options]
 * @returns {{width:number,height:number,scale:number,margin:number|null,typeScale:object,
 *   safe:{left:number,right:number,top:number,bottom:number}, shots:Array}}
 */
export function measureLayout(shots, options = {}) {
  const width = Math.max(2, Math.round(finite(options.width, 1280)));
  const height = Math.max(2, Math.round(finite(options.height, 720)));
  const scale = height / 720;
  const spec = options.spec || null;
  const font = (spec && spec.font) || {};

  const measured = (Array.isArray(shots) ? shots : []).map((shot) => measureShot(shot, width, height, scale));
  const margin = median(measured.map((shot) => shot.contentLeft));

  // 字号层级取 spec 的四个值（设计像素）；没有 spec 时从层里回收，仍然能判定。
  const typeScale = {
    heading: finite(font.heading, 0) || maxDesignSize(measured),
    subtitle: finite(font.subtitle, 0) || 0,
    body: finite(font.body, 0) || 0,
    note: finite(font.note, 0) || minDesignSize(measured),
  };

  return {
    width,
    height,
    scale,
    margin,
    typeScale,
    safe: {
      left: width * ALIGN_LIMITS.safeMargin,
      right: width * (1 - ALIGN_LIMITS.safeMargin),
      top: height * ALIGN_LIMITS.safeMargin,
      bottom: height * (1 - ALIGN_LIMITS.safeMargin),
    },
    shots: measured,
  };
}

function maxDesignSize(shots) {
  let max = 0;
  for (const shot of shots) for (const item of shot.textSizes) max = Math.max(max, item.size);
  return max || 1;
}

function minDesignSize(shots) {
  let min = Infinity;
  for (const shot of shots) for (const item of shot.textSizes) min = Math.min(min, item.size);
  return Number.isFinite(min) ? min : 1;
}

function makeIssue(severity, code, message, shotKind, expected, actual, delta, extra) {
  return Object.assign(
    {
      severity,
      code,
      message,
      shotKind: shotKind || null,
      expected: round3(expected),
      actual: round3(actual),
      delta: round3(delta),
    },
    extra || {},
  );
}

/**
 * 对齐判定。
 *
 * 六类检查（每类一组 issue；有一条 error 就 ok=false）：
 *   1) margin-consistent    四镜主内容左边界（±4px）
 *   2) baseline-consistent  眉标/标题/副标题基线（±3px）
 *   3) type-scale           标题>副标题>正文>note，相邻比 1.4–1.8
 *   4) emphasis-ratio       强调条 / 所属标题宽 0.2–0.6
 *   5) radius/stroke        四镜圆角与描边宽度一致
 *   6) safe-area            任何文字不越过 5% 安全区
 * 外加一条 warn：font-tier-drift（层里出现不在四级字号里的字号）
 *
 * @param {object} layout measureLayout 的输出
 * @returns {{ok:boolean, issues:Array, checks:Array, summary:{total:number,passed:number,failed:number}}}
 */
export function checkAlignment(layout) {
  const issues = [];
  const shots = Array.isArray(layout && layout.shots) ? layout.shots : [];
  const width = finite(layout && layout.width, 1280);
  const height = finite(layout && layout.height, 720);
  const margin = layout && Number.isFinite(layout.margin) ? layout.margin : median(shots.map((s) => s.contentLeft));
  const tol = ALIGN_LIMITS;
  const checks = [];

  const record = (key, label) => {
    const before = issues.length;
    return () => {
      const count = issues.length - before;
      checks.push({ key, label, passed: count === 0, issues: count });
    };
  };

  // ---- 1) 左边距 ----
  const doneMargin = record('margin', '左边距');
  if (Number.isFinite(margin) && shots.length > 1) {
    for (const shot of shots) {
      if (!Number.isFinite(shot.contentLeft)) continue;
      const delta = shot.contentLeft - margin;
      if (Math.abs(delta) > tol.marginTolerance) {
        issues.push(
          makeIssue(
            'error',
            'margin-consistent',
            `${shot.label}：左边距 ${round3(shot.contentLeft)}px，其余 ${round3(margin)}px，差 ${round3(Math.abs(delta))}px`,
            shot.kind,
            margin,
            shot.contentLeft,
            delta,
          ),
        );
      }
    }
  }
  doneMargin();

  // ---- 2) 基线 ----
  const doneBaseline = record('baseline', '基线');
  for (const role of BASELINE_ROLES) {
    const have = shots.filter((shot) => shot.roles && shot.roles[role]);
    if (have.length < 2) continue;
    const expected = median(have.map((shot) => shot.roles[role].baseline));
    for (const shot of have) {
      const actual = shot.roles[role].baseline;
      const delta = actual - expected;
      if (Math.abs(delta) > tol.baselineTolerance) {
        issues.push(
          makeIssue(
            'error',
            'baseline-consistent',
            `${shot.label}：${BOX_LABELS[role]}基线 ${round3(actual)}px，其余 ${round3(expected)}px，差 ${round3(Math.abs(delta))}px`,
            shot.kind,
            expected,
            actual,
            delta,
            { role },
          ),
        );
      }
    }
  }
  doneBaseline();

  // ---- 3) 字号层级 ----
  const doneScale = record('typeScale', '字号层级');
  const scale = (layout && layout.typeScale) || {};
  for (let i = 0; i < TYPE_TIERS.length - 1; i += 1) {
    const upper = TYPE_TIERS[i];
    const lower = TYPE_TIERS[i + 1];
    const a = finite(scale[upper], 0);
    const b = finite(scale[lower], 0);
    if (!(a > 0) || !(b > 0)) continue;
    const ratio = a / b;
    if (ratio < tol.typeRatio[0]) {
      issues.push(
        makeIssue(
          'error',
          'type-scale',
          `${BOX_LABELS[upper]} ${a}px / ${BOX_LABELS[lower]} ${b}px = ${round3(ratio)}，小于 ${tol.typeRatio[0]}`,
          null,
          tol.typeRatio[0],
          ratio,
          ratio - tol.typeRatio[0],
          { pair: [upper, lower] },
        ),
      );
    } else if (ratio > tol.typeRatio[1]) {
      issues.push(
        makeIssue(
          'error',
          'type-scale',
          `${BOX_LABELS[upper]} ${a}px / ${BOX_LABELS[lower]} ${b}px = ${round3(ratio)}，大于 ${tol.typeRatio[1]}`,
          null,
          tol.typeRatio[1],
          ratio,
          ratio - tol.typeRatio[1],
          { pair: [upper, lower] },
        ),
      );
    }
  }
  // 层里出现四级之外的零散字号（例如徽标写死 15px）：warn，不阻断
  const known = new Set(TYPE_TIERS.map((tier) => finite(scale[tier], 0)).filter((v) => v > 0));
  for (const shot of shots) {
    if (!known.size) break;
    const tiers = [...known];
    for (const item of shot.textSizes || []) {
      if (!item.size) continue;
      const nearest = tiers.reduce((best, v) => (Math.abs(v - item.size) < Math.abs(best - item.size) ? v : best), tiers[0]);
      if (Math.abs(nearest - item.size) > 0.5) {
        issues.push(
          makeIssue(
            'warn',
            'font-tier-drift',
            `${shot.label}：${BOX_LABELS[item.role] || item.role} ${item.size}px 不在四级字号里（最近 ${nearest}px）`,
            shot.kind,
            nearest,
            item.size,
            item.size - nearest,
            { role: item.role },
          ),
        );
      }
    }
  }
  doneScale();

  // ---- 4) 强调条比例 ----
  const doneEmphasis = record('emphasis', '强调条比例');
  for (const shot of shots) {
    const emphasis = shot.emphasis;
    if (!emphasis) continue;
    if (!emphasis.reference || !(emphasis.ratio > 0)) {
      issues.push(
        makeIssue(
          'warn',
          'emphasis-ratio',
          `${shot.label}：强调条 ${round3(emphasis.width)}px 找不到可比的标题宽度`,
          shot.kind,
          tol.emphasisRatio[0],
          0,
          -tol.emphasisRatio[0],
        ),
      );
      continue;
    }
    const ratio = emphasis.ratio;
    if (ratio < tol.emphasisRatio[0]) {
      issues.push(
        makeIssue(
          'error',
          'emphasis-ratio',
          `${shot.label}：强调条 ${round3(emphasis.width)}px / 标题 ${round3(emphasis.reference.width)}px = ${round3(ratio)}，小于 ${tol.emphasisRatio[0]}`,
          shot.kind,
          tol.emphasisRatio[0],
          ratio,
          ratio - tol.emphasisRatio[0],
          { reference: emphasis.reference.role },
        ),
      );
    } else if (ratio > tol.emphasisRatio[1]) {
      issues.push(
        makeIssue(
          'error',
          'emphasis-ratio',
          `${shot.label}：强调条 ${round3(emphasis.width)}px / 标题 ${round3(emphasis.reference.width)}px = ${round3(ratio)}，大于 ${tol.emphasisRatio[1]}`,
          shot.kind,
          tol.emphasisRatio[1],
          ratio,
          ratio - tol.emphasisRatio[1],
          { reference: emphasis.reference.role },
        ),
      );
    }
  }
  doneEmphasis();

  // ---- 5) 圆角 / 描边 ----
  const doneCorners = record('corners', '圆角与描边');
  for (const [key, code, label] of [
    ['radius', 'radius-consistent', '圆角'],
    ['strokeWidth', 'stroke-consistent', '描边'],
  ]) {
    const have = shots.filter((shot) => Number.isFinite(shot[key]));
    if (have.length < 2) continue;
    const expected = median(have.map((shot) => shot[key]));
    for (const shot of have) {
      const delta = shot[key] - expected;
      if (Math.abs(delta) > 0.01) {
        issues.push(
          makeIssue(
            'error',
            code,
            `${shot.label}：${label} ${round3(shot[key])}px，其余 ${round3(expected)}px，差 ${round3(Math.abs(delta))}px`,
            shot.kind,
            expected,
            shot[key],
            delta,
          ),
        );
      }
    }
  }
  doneCorners();

  // ---- 6) 安全区 ----
  const doneSafe = record('safeArea', '安全区');
  const safe = {
    left: width * tol.safeMargin,
    right: width * (1 - tol.safeMargin),
    top: height * tol.safeMargin,
    bottom: height * (1 - tol.safeMargin),
  };
  for (const shot of shots) {
    for (const box of shot.boxes || []) {
      const what = `${BOX_LABELS[box.role] || box.role}${box.text ? '「' + String(box.text).replace(/\n/g, ' ') + '」' : ''}`;
      if (box.left < safe.left) {
        issues.push(
          makeIssue(
            'error',
            'safe-area',
            `${shot.label}：${what}左边界 ${round3(box.left)}px，越过安全区 ${round3(safe.left)}px`,
            shot.kind,
            safe.left,
            box.left,
            box.left - safe.left,
            { edge: 'left', role: box.role },
          ),
        );
      }
      if (box.right > safe.right) {
        issues.push(
          makeIssue(
            'error',
            'safe-area',
            `${shot.label}：${what}右边界 ${round3(box.right)}px，越过安全区 ${round3(safe.right)}px`,
            shot.kind,
            safe.right,
            box.right,
            box.right - safe.right,
            { edge: 'right', role: box.role },
          ),
        );
      }
      if (box.top < safe.top) {
        issues.push(
          makeIssue(
            'error',
            'safe-area',
            `${shot.label}：${what}上边界 ${round3(box.top)}px，越过安全区 ${round3(safe.top)}px`,
            shot.kind,
            safe.top,
            box.top,
            box.top - safe.top,
            { edge: 'top', role: box.role },
          ),
        );
      }
      if (box.bottom > safe.bottom) {
        issues.push(
          makeIssue(
            'error',
            'safe-area',
            `${shot.label}：${what}下边界 ${round3(box.bottom)}px，越过安全区 ${round3(safe.bottom)}px`,
            shot.kind,
            safe.bottom,
            box.bottom,
            box.bottom - safe.bottom,
            { edge: 'bottom', role: box.role },
          ),
        );
      }
    }
  }
  doneSafe();

  const failed = checks.filter((check) => !check.passed).length;
  return {
    ok: issues.every((item) => item.severity !== 'error'),
    issues,
    checks,
    summary: { total: checks.length, passed: checks.length - failed, failed, errors: issues.filter((i) => i.severity === 'error').length, warnings: issues.filter((i) => i.severity === 'warn').length },
  };
}
