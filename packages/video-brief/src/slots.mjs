/**
 * 视频简报的 10 个槽位（缺一不可）。
 *
 * priority 越小越先问。顺序不是随便排的：
 *   目标 → 平台 → 时长 → 受众 → 调性 → 节奏 → 交付 → 画面 → 参考素材 → 禁忌
 * - goal 决定验收，排第一；
 * - platform + duration 直接决定「容量」（画幅、安全区、开头 3 秒规则、能塞几个信息点），
 *   所以排在受众和调性前面——先知道碗多大，再决定盛什么；
 * - audience / tone / pace 决定叙述方式；
 * - deliverable / visual / reference 决定实现路径与返工成本；
 * - taboo 一句话能说完，但踩了要整片重做，所以即使排最后也必须确认过。
 */

/** 默认 10 个槽位。id 是稳定契约，改 id 会让已有 brief.json 里的答案对不上。 */
export const DEFAULT_SLOTS = [
  {
    id: 'goal',
    title: '目标与验收',
    priority: 10,
    question: '这条视频要达成什么？验收标准写清楚：观众看完应该做什么，或者你凭什么判断它成了。',
    why: '目标含糊，后面的时长、节奏、镜头数全在拍脑袋；验收标准是唯一能说"收工"的依据。',
  },
  {
    id: 'platform',
    title: '平台与画幅',
    priority: 20,
    question: '发在哪、什么画幅？抖音/视频号 9:16、B站 16:9、小红书 3:4 或 1:1，平台有硬性规格吗？',
    why: '画幅决定构图和字幕安全区，平台决定时长上限与开头 3 秒的硬规则。',
  },
  {
    id: 'duration',
    title: '时长',
    priority: 30,
    question: '成片多长？有没有硬上限（例如必须 ≤30 秒）？',
    why: '时长决定镜头数与信息密度；先定死才排得下分镜，否则每版都要重排。',
  },
  {
    id: 'audience',
    title: '受众',
    priority: 40,
    question: '给谁看？他们现在知道什么、在意什么、会为什么划走？',
    why: '同一份内容对不同受众要换开场、换术语、换举证方式。',
  },
  {
    id: 'tone',
    title: '调性',
    priority: 50,
    question: '调性走哪一路：专业 / 亲和 / 燃 / 克制 / 幽默 / 高级感？能举一句你认可的说话方式最好。',
    why: '调性决定文案口吻、配乐和转场；定晚了整片要重剪。',
  },
  {
    id: 'pace',
    title: '节奏',
    priority: 60,
    question: '节奏偏快还是偏慢？大概几个镜头，要不要卡点？',
    why: '节奏决定剪辑密度与音乐选择，也直接决定工作量。',
  },
  {
    id: 'deliverable',
    title: '交付形态',
    priority: 70,
    question: '交付什么：成片 MP4 / 工程文件 / 分镜脚本 / 字幕文件？分辨率、帧率、码率有要求吗？',
    why: '交付形态不同，返工成本差一个量级；先对齐再动手。',
  },
  {
    id: 'visual',
    title: '画面偏好',
    priority: 80,
    question: '画面偏好：实拍 / 动画 / 图文 / 混剪？配色、字体、品牌规范有没有必须遵守的？',
    why: '画面风格定了才好选素材和动效，否则每一版都"不像"。',
  },
  {
    id: 'reference',
    title: '参考素材',
    priority: 90,
    // 唯一一个非文本槽位：值是「路径清单」或「显式无参考」，判定逻辑在 brief.mjs。
    kind: 'references',
    accepts: ['image', 'video', 'text'],
    // 允许填「无参考」，但必须是显式值（字符串同义说法或 { skipped: true }）；
    // 空着 / 空白 = 没回答，仍然算缺。
    explicitNone: true,
    question: '有参考图或样片吗？最好给 4–5 张图（或一条能对标的片子）；没有也请明确说「无参考」。',
    // 固定提问文案：讨论风格时必须原样问，不要自己改写成别的。
    askText: '有没有参考图或样片？最好给 4–5 张图（1 条样片也行）——一张图胜过一万字描述，图能直接锚定画风、构图和节奏。真没有的话，请明确回一句「无参考」，我记下来再继续。',
    why: '挑 4–5 张「就是这种感觉」的图，比写一万字形容词都准；没有参考也请说一声，我好按你的描述走，而不是自己猜。',
  },
  {
    id: 'taboo',
    title: '禁忌',
    priority: 100,
    question: '有哪些不能出现的东西：内容、词、画面、颜色、风格、版权或授权限制？',
    why: '禁忌是硬约束，踩了要整条重做；通常一句话能说完，但没确认就不能算过。',
  },
];

/** 默认槽位 id 列表（顺序即优先级顺序）。 */
export const SLOT_IDS = DEFAULT_SLOTS.map((slot) => slot.id);

/** 参考素材类槽位的 id（值可以是路径清单 / 显式无参考，不是纯文本）。 */
export const REFERENCE_SLOT_IDS = DEFAULT_SLOTS
  .filter((slot) => slot.kind === 'references')
  .map((slot) => slot.id);

/** 取一组槽位里所有参考素材类槽位的 id（没传就用默认表）。 */
export function referenceIdSet(slots) {
  const source = Array.isArray(slots) && slots.length > 0 ? slots : DEFAULT_SLOTS;
  return new Set(source.filter((slot) => slot && slot.kind === 'references').map((slot) => slot.id));
}

/** 把一行值压成可比较的文本（去空白）。 */
function flat(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * 归一化槽位配置：**按 id 打补丁**，不整份替换。
 *
 * 为什么不做整份替换：配置写错一个字段就把槽位删掉，等于给门禁放水
 * （槽位越少越容易 ready）。这里只允许改 title / question / why / priority，
 * 或者用 `remove: true` 显式删掉某一条；未知 id 一律忽略。
 *
 * @param {unknown} input 来自插件配置的 slots 数组。
 * @returns {Array<{id:string,title:string,priority:number,question:string,why:string}>}
 */
export function normalizeSlots(input) {
  const base = DEFAULT_SLOTS.map((slot, index) => ({ ...slot, index }));
  const overrides = new Map();
  if (Array.isArray(input)) {
    for (const entry of input) {
      if (!entry || typeof entry !== 'object') continue;
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      if (id === '' || !SLOT_IDS.includes(id)) continue;
      overrides.set(id, entry);
    }
  }
  const merged = [];
  for (const slot of base) {
    const patch = overrides.get(slot.id);
    if (patch && patch.remove === true) continue;
    const next = { ...slot };
    if (patch) {
      const title = flat(patch.title);
      const question = flat(patch.question);
      const why = flat(patch.why);
      const askText = flat(patch.askText);
      if (title !== '') next.title = title;
      if (question !== '') next.question = question;
      if (why !== '') next.why = why;
      // 固定提问文案可以被覆写，但「有没有参考图」这条语义不建议改没了。
      if (askText !== '' && next.askText !== undefined) next.askText = askText;
      const priority = Number(patch.priority);
      if (Number.isFinite(priority)) next.priority = priority;
    }
    merged.push(next);
  }
  return merged
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map(({ index, ...slot }) => slot);
}

/** 槽位 id 集合（用于校验 answers 的键）。 */
export function slotIdSet(slots) {
  return new Set(slots.map((slot) => slot.id));
}
