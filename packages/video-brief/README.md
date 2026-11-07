# dsh-video-brief

> 0.3.0：新增 `script` 阶段（写分镜脚本 → 用户确认）与三个脚本工具。旧工程升级说明见「怎么装」。

DSH 插件，**只做 host 侧**：视频任务开工前先把需求问成一张 10 槽位的简报（`.dsh-video/brief.json`），
再按**六阶段状态机**把「补需求 → 写脚本并等用户确认 → 定风格 → 改时间线 → 导出」分段放行。
`brief` 没齐写不了脚本，脚本没确认进不了 style（不许渲染样片），风格没锁不让动时间线，没进 build 不让导出。

十一个工具：

| 工具 | 作用 |
|---|---|
| `video_brief_start` | 读 brief，返回缺失槽位（每轮最多 3 条） |
| `video_brief_confirm` | 写回答案；部分答案自动进 clarify，满 10 项自动进 script |
| `video_reference_register` | 登记参考图 / 样片路径（只记路径与数量，不复制文件） |
| `video_reference_skip` | 显式登记「无参考」（用户确认过才调用） |
| `video_stage_get` | 读阶段 + 事实（含脚本状态）+ 下一步 + 被拦清单 + history |
| `video_stage_advance` | 手动推进阶段（只能前进，跳级要 force，倒退拒绝） |
| `video_script_draft` | 写入 / 更新分镜脚本草稿，返回结构化校验；校验失败不写盘 |
| `video_script_read` | 读 `script.json` + 是否已确认 + 上次确认时间 |
| `video_script_confirm` | 用户确认后把 `confirmed=true` 落盘，阶段自动进 style |
| `video_style_confirm` | 写 `style.json`（confirmed=true），阶段自动进 locked |
| `video_style_read` | 读当前 `style.json`，没有/未确认返回 null |

没有客户端 UI，装完不需要刷新页面。

---

## 它解决什么问题

现有的两个开工前插件，在视频场景上都有硬伤：

| 插件 | 问题 | 在视频任务上的后果 |
|---|---|---|
| `dsh-grill-first` | 判定是纯正则，「做个 30 秒竖屏视频」四维齐 → `clear` 直接放过 | 该问的一个没问，直接开剪 |
| | `maxQuestionsPerRound` 没有执行点，只写在提示词里 | 模型仍然一问一轮 |
| | `gateMode` 默认 `warn`，`strict` 也只看"四维齐不齐" | 拦不住任何真实的视频需求缺口 |
| `dsh-discuss-mode` | 产物是纯文本，不落盘、没有确认卡片 | 下一轮对话就忘了上次问了什么 |
| | 工具拦截是黑名单 | `video_edit_apply`、`video_code_write` 这类全漏放 |

这个插件换成另一种判定：**不看措辞，看 10 个具体槽位是否都有答案 + 风格是否被确认过**，
答案落盘，门禁直接读文件。

三个明确的设计后果：

1. 槽位缺一不可，**轮数到顶也不放行**（`grill-first` 是问够轮数就直接 clear）。
2. 一把一问完：`missing` 一次最多给 3 条，且带 `question` 和 `why`，模型不用自己想问什么。
3. 门禁读的是磁盘上的真实状态，不是会话里的隐藏变量，所以换会话、换 agent 也拦得住。

---

## 和 grill-first / discuss-mode 的边界

| | dsh-grill-first | dsh-discuss-mode | **dsh-video-brief** |
|---|---|---|---|
| 触发 | 所有新任务 | 用户 `/discuss` | 视频工程（`.dsh-video/`）里的写操作与导出 |
| 判定依据 | 正则四维打分 | 模式状态 | `brief.json` 10 槽位 + `script.json` 是否确认 + `style.json` 是否确认 + `state.json` 阶段 |
| 产物 | 提示词 + 两层记忆 | 无 | `brief.json` / `script.json` / `style.json` / `state.json` |
| 拦截范围 | 通用变更类工具 | 黑名单 | 视频写类 + 工程文件写入 + `video_export*` |
| 到顶行为 | 直接放行 | — | **不放行** |

三者可以共存，各管一段：`grill_first` 管"这件事要不要做"，`video_brief` 管"这条片子怎么做、做到哪一步"。
真的不需要提问时，用户可以直说「直接做」——但那是**用户**的跳过权，不是模型自己判断出来的。

---

## 六阶段状态机

```
   ┌────────┐ brief 有答案 ┌─────────┐ 10/10  ┌────────┐ 用户明确确认脚本 ┌───────┐ style_confirm ┌────────┐ 首次写操作 ┌───────┐
   │  idle  │ ───────────▶ │ clarify │ ─────▶ │ script │ ───────────────▶ │ style │ ────────────▶ │ locked │ ─────────▶ │ build │
   └────────┘              └─────────┘        └────────┘                  └───────┘               └────────┘            └───────┘
      只放行                 只放行 brief       写脚本并等用户确认           定风格 / 渲染样片          再放行写类            再放行导出
   brief/只读               + 只读工具         （没确认不许渲染样片）        写类仍锁                   （含工程文件）        （video_export*）
```

| 阶段 | 含义 | 这个阶段能做什么 |
|---|---|---|
| `idle` | 没有 brief 或空 | `video_brief_start` 拿缺失清单、只读工具 |
| `clarify` | brief 1..9/10 | 同上；`video_brief_confirm` 补答案（一轮 ≤3 条） |
| `script` | brief 10/10，脚本还没确认 | `video_script_draft` / `video_script_read`：写分镜脚本并逐条给用户看；**不许渲染样片、不许定风格、写类仍锁** |
| `style` | 脚本已确认（`script.json confirmed=true`），风格还没确认 | 渲染 4 张关键帧 + 8 秒样片请用户看；再加 `video_style_confirm` / `video_style_read`；**写类仍锁** |
| `locked` | 风格已确认（`style.json confirmed=true`） | 改写时间线、写工程内文件；**导出仍锁** |
| `build` | 生产阶段 | 写类 + `video_export*` 全放行 |

### 状态文件

`<工程根>/.dsh-video/state.json`：

```json
{
  "stage": "clarify",
  "since": "2026-01-01T00:00:00.000Z",
  "history": [
    { "stage": "clarify", "at": "2026-01-01T00:00:00.000Z", "by": "tool", "reason": "brief-ready" },
    { "stage": "script",  "at": "2026-01-01T00:05:00.000Z", "by": "tool", "reason": "brief-ready" },
    { "stage": "style",   "at": "2026-01-01T00:07:00.000Z", "by": "tool", "reason": "script-confirmed" }
  ]
}
```

- 原子写（`.tmp` → rename）、同实例写串行、坏文件降级 `idle` 并备份成 `state.json.bak`——
  和 `brief.json` 共用 `store.mjs` 的同一套实现，没有第二套。
- `history` 除 `stage / at / by` 外可能带 `reason`（`brief-ready` / `script-confirmed` / `style-confirmed` / `first-write` / `self-heal`）、
  `forced` / `jump`（跳级）、`from`（自愈回落的来源阶段）。
- `by` 目前是 `tool`；`user` 留给将来工作台里的人工按钮。

### 风格文件

`<工程根>/.dsh-video/style.json`：

```json
{
  "spec": {
    "tone": "克制、专业，不喊口号",
    "palette": ["#0B0B0F", "#7C5CFF"],
    "font": "思源黑体 Medium",
    "density": "med",
    "pace": 2.5
  },
  "confirmed": true,
  "confirmedAt": "2026-01-01T00:00:00.000Z",
  "confirmedBy": "user",
  "preview": {
    "keyframes": ["preview/kf-1.png", "preview/kf-2.png", "preview/kf-3.png", "preview/kf-4.png"],
    "clip": "preview/style-8s.mp4"
  }
}
```

- `tone / palette / font / density / pace` 缺一不可；`palette` 是 1..12 个 `#RGB` / `#RRGGBB`（可带 alpha）。
- `preview` 可选：最多 4 张关键帧 + 一段 8 秒 `.mp4`，**只记相对路径**（不接受盘符、根路径、`..` 逃逸）。
- 插件**不渲染**任何帧或视频。预览产物是工作台那一路的能力，这里只记录"用户已确认这一版"这件事。
- 未确认或 spec 不合法的 `style.json` 读出来是 `null`，不会当成"已确认"。

### 脚本文件

`<工程根>/.dsh-video/script.json`：

```json
{
  "version": 1,
  "title": "30 秒讲清 DSH 视频流程",
  "logline": "从问询到开工，一条片子怎么走完六阶段",
  "duration": 7,
  "shots": [
    {
      "no": 1,
      "time": { "start": 0, "duration": 3 },
      "visual": "黑底白字标题",
      "narration": "做一条视频，先别急着开剪。",
      "onScreenText": "先问清",
      "transition": "硬切"
    }
  ],
  "confirmed": false,
  "confirmedAt": null,
  "draftCount": 1,
  "revisedAt": "2026-01-01T00:00:00.000Z"
}
```

- 每一镜必须有 `time.start`（≥0）与 `time.duration`（>0），且必须**首尾相接**：下一镜的 `start` 要等于上一镜的 `start + duration`（重叠 / 断档都会报错）。
- `visual` 不能为空；`narration` 与 `onScreenText` 至少要有一样（两样都空 = 空镜）。
- `video_script_draft` 校验失败**不写盘**，返回 `{ ok:false, problems:[{shot, field, message}] }`。
- 允许反复改：每次内容变化 `draftCount + 1`，并把 `confirmed` 重置为 `false`；内容没变的重复调用是幂等的。
- `confirmed=true` 只能由 `video_script_confirm` 写入（agent 转述用户明确同意后调用）。
- 没确认的脚本进不了 `style`：既不能渲染 4 张关键帧 / 8 秒样片，也不能确认风格。

### stage 是存储式还是派生式？

**存储式 + 事实校正**，不是纯派生：

- `build` 推不出来——"开始生产"是一个动作，不是任何文件的状态，所以必须落盘；
- 前五个阶段虽然可以由 `brief` / `script` / `style` 的事实推出来，但仍然存下来，因为 `history` 需要记录**怎么走到这里的**，
  纯派生会把"从哪来"丢掉；
- 存下来的值不能和事实矛盾：读取时如果阶段**领先于事实**，会回落到事实允许的最高阶段并写 `history`
  （`reason: "self-heal"`）；领先是不允许的，落后是允许的（下一节）。

一句话：**`state.json` 是进度的权威记录，事实是它的上限。**

---

## 状态与事实的一致性规则

事实允许的阶段上限（`factsStage`）：

| brief | 脚本 | 风格已确认 | 允许的最高阶段 |
|---|---|---|---|
| 空 | — | 否 | `idle` |
| 1..9/10 | — | 否 | `clarify` |
| 10/10 | 没写 / 未确认 | 否 | `script` |
| 10/10 | **已确认** | 否 | `style` |
| 10/10 | **已确认** | **是** | `locked`（`build` 只能由动作产生） |
| 1..9/10 | — | **是** | `style` |
| 10/10 | **没有 script.json（历史工程）** | **是** | `locked`（脚本缺失不收回已有阶段） |

规则四条：

1. **领先必自愈。** `stage=locked` 但 brief 只剩 9 项 → 读一次 `video_stage_get` 就回落到 `style`，
   在 `history` 里记 `{ reason:"self-heal", from:"locked" }`，并重写 `state.json`。
   `stage=build` 但事实不齐同样回落。注意：**历史工程缺 script.json 不算事实不足**——否则升级一次就把老工程打回去。
2. **落后不自动补。** `stage=idle` 但 brief 已经有答案，不会偷偷改阶段；用 `video_brief_confirm`
   或 `video_stage_advance` 明确推进。`video_stage_get` 的 `nextStep` / `blocked` 会直接提示
   「状态落后于事实，先 advance 到 X」。这样 `history` 里的每一步都有出处。
3. **confirm / script_confirm / style_confirm 自动推进。** `video_brief_confirm` 成功后：有答案 → `clarify`，
   满 10 项 → `script`（若脚本 / 风格已确认则更高）；`video_script_confirm` 成功后 → `style`；
   `video_style_confirm` 成功后 → `locked`。
4. **force 不能越过事实。** 跳级需要 `force:true`，但 brief 没满、脚本没确认、风格没确认时，
   force 也进不了 `style` / `locked` / `build`，返回 `brief-not-ready` / `script-not-confirmed` / `style-not-confirmed`。
   force 只解决"跳过中间阶段"，不解决"事实不够"。

为什么「brief 只有 9 项 + 风格已确认」停在 `style` 而不是 `clarify`：
风格确认是用户点过头的事实，不能因为 brief 后来退项就自动撤销——那会逼用户重做已经确认的东西。
停在 `style` 表示"回到补 brief、补完再锁"，但此时 `video_stage_advance {to:"style"}` 仍要求 brief 满 10 项；
自愈出来的 `style` 是一个修复位，不是重新确认位。

---

## 10 个槽位与优先级

优先级数字越小越先问。`missing` 永远按这个顺序取前 3 条。

| 序 | id | 标题 | 为什么要这条 |
|---|---|---|---|
| 1 | `goal` | 目标与验收 | 目标含糊，时长/节奏/镜头数全在拍脑袋；验收标准是唯一能说"收工"的依据 |
| 2 | `platform` | 平台与画幅 | 画幅决定构图和字幕安全区；平台决定时长上限与开头 3 秒规则 |
| 3 | `duration` | 时长 | 决定镜头数与信息密度，先定死才排得下分镜 |
| 4 | `audience` | 受众 | 同一份内容对不同受众要换开场、换术语、换举证方式 |
| 5 | `tone` | 调性 | 决定文案口吻、配乐、转场；定晚了整片要重剪 |
| 6 | `pace` | 节奏 | 决定剪辑密度与音乐选择，也决定工作量 |
| 7 | `deliverable` | 交付形态 | MP4 / 工程 / 分镜 / 字幕，返工成本差一个量级 |
| 8 | `visual` | 画面偏好 | 定了才好选素材和动效，否则每版都"不像" |
| 9 | `reference` | 参考素材 | 4–5 张参考图比一万字形容词都准；没有也必须要用户显式说「无参考」，不许默认略过 |
| 10 | `taboo` | 禁忌 | 踩了要整条重做；通常一句话能说完，但没确认就不能算过 |

「平台 + 时长」排在「受众 + 调性」前面是有意的：先知道碗多大，再决定盛什么。

`brief.json` 的形状：

```json
{
  "version": 1,
  "topic": "30 秒竖屏宣传片",
  "round": 2,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:05:00.000Z",
  "slots": {
    "goal": "让新用户 3 秒内看懂痛点",
    "platform": "视频号 9:16",
    "duration": "30 秒"
  }
}
```

---

## 参考素材：没有就显式说「无参考」

`reference` 不是普通文本槽位：它是 `kind: 'references'`，值是「路径清单」或「显式无参考」。
其它 9 个槽位可以一句话答完，这一个不行——聊风格时必须固定先问参考素材：

> 有没有参考图或样片？最好给 4–5 张图（1 条样片也行）——一张图胜过一万字描述，图能直接锚定画风、构图和节奏。真没有的话，请明确回一句「无参考」，我记下来再继续。

`video_brief_start` 的 `missing` 里，`reference` 这一条的 `question` 就是上面这句
（槽位定义里的 `askText`）；`missing` 也会带 `kind: 'references'`。不要把它改写成「随便描述一下」。

槽位字段：

```js
{
  id: 'reference',
  title: '参考素材',
  kind: 'references',
  accepts: ['image', 'video', 'text'],
  explicitNone: true,
  askText: '……（上面那句固定提问）',
  why: '挑 4–5 张「就是这种感觉」的图，比写一万字形容词都准；没有参考也请说一声，我好按你的描述走，而不是自己猜。',
}
```

**值有三种形态**：

| 形态 | 写法 | referenceStatus |
|---|---|---|
| 路径清单 | `{ kind: 'references', paths: ['refs/a.png', ...], count: 4, note?: '画风参考' }` | `{ state: 'provided', count: 4 }` |
| 显式无参考 | 字符串 `"无参考"`（「没有参考」「暂时没有」等同义说法也行），或 `{ skipped: true, reason?: '没找到合适的' }` | `{ state: 'explicit-none' }` |
| 没回答 | 未填 / 空串 / 纯空白 / `{}` / `{ skipped: false }` | `{ state: 'missing' }` |

- 空串和空白**不会**被当成「无参考」：`missing` 里继续出现，brief 不算满。
- 显式无参考算这一项已填，`buildSummary` 会标注「（用户确认无参考）」；
  但它**不是 ready 的捷径**——其余 9 项仍然要齐。
- 缺参考时 `buildSummary` 与门禁的 `buildDenyReason` 会给一段专门文案：
  先问有没有参考图 / 样片，再提醒图片胜过一万字描述，最后要求显式确认。

两个工具（都写 `brief.json`，沿用同一套原子写 + 串行队列）：

| 工具 | 参数 | 返回 |
|---|---|---|
| `video_reference_register` | `{ paths: string[], note?: string }`，路径必须是工程内相对路径 | `{ count, paths, state, reference, written, ready, stillMissing, summary, rejected? }` |
| `video_reference_skip` | `{ reason?: string }` | `{ state: 'explicit-none', reference, written, ready, stillMissing, summary }` |

`register` 只记录路径与数量：**不复制文件、不读文件内容、不做图像分析**。重复路径自动去重，
多次调用与已有清单合并（并发调用也不会互相覆盖）。`../`、绝对路径、盘符路径会被拒；
混合提交时只写合法项，被拒的列在 `rejected` 里，整批非法则一个字节都不写。
`skip` 只应在用户明确说过没有参考时调用，模型不能替用户默认跳过；重复调用幂等。

**为什么必须显式确认**：不填不等于没有。模型替用户默认「没参考」，
就会跳过整个视觉锚定环节，最后按自己的想象剪一版——返工成本远高于多问一句。

**能力边界（如实说明）**：装上这个插件不等于获得图像理解能力。4 张图登记进来只是路径字符串；
真正「看图」需要宿主或其它插件提供视觉工具，`dsh-video-brief` 本身没有图像分析能力，
也不会去读这些文件。

---

## 门禁矩阵

`gate` 三档：`off` / `warn`（默认）/ `enforce`。`warn` 只记日志、不拦；`enforce` 真拒；`off` 不挂钩子、也不读四个 JSON。

| 工具类 | `idle` | `clarify` | `script` | `style` | `locked` | `build` |
|---|---|---|---|---|---|---|
| `video_brief_start` / `video_brief_confirm` / `video_reference_register` / `video_reference_skip` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `video_stage_get` / `video_stage_advance` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 只读视频工具、`read` / `read_image` / `grep` / `glob` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `video_script_draft` / `video_script_confirm` | ✓* | ✓* | ✓* | ✓* | ✓* | ✓* |
| `video_script_read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `video_style_confirm` / `video_style_read` | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |
| `video_edit_apply` / `video_code_write` / `video_motion_insert` / `video_sound_insert` / `video_storyboard_apply` / `video_caption_import` | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| `video_transcribe`（`applyToTimeline:true`） | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| `video_transcribe`（其余参数） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `write` / `edit` → 工程内、`.dsh-video/` 外 | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| `write` / `edit` → `.dsh-video/` 内 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `write` / `edit` → 工程目录之外 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `video_export*`（前缀匹配） | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| 其余工具（与视频无关） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

\* 脚本工具的真实门槛不是阶段，而是 `briefReady`：brief 10/10 就放行 draft/confirm（允许 state 落后于事实），
brief 没满时 `enforce` 真拒（`brief-not-ready`）。`video_script_read` 是只读，永远放行。

补充规则：

- 「是不是视频工程」由 `<工程根>/.dsh-video/` 是否存在决定。不是视频工程时，`write`/`edit` **完全不碰**——
  否则在同一工作区里写普通代码也会被拦，那是纯误伤。
- 相对路径按会话 cwd 解析；Windows 下路径比较不分大小写。
- `locked` 阶段**第一次被放行的写操作**会自动把阶段推进到 `build`（`history.reason = "first-write"`）。
  写 `.dsh-video/` 内的工程文档不算，否则写 `brief.json` 就进 build 了。
  自动推进失败只记日志，不拦操作。
- 门禁自己出异常（读盘失败、判定抛错）→ 放行并记 warning。门禁坏掉不该让人干不了活。
- `off` 档不挂钩子，所以也不会自动进 build。

拒绝码：

| code | 含义 |
|---|---|
| `brief-not-ready` | 当前 idle/clarify 但 brief 没满（脚本工具也是这个码） |
| `script-not-confirmed` | 当前 script，要进 style / 定风格 / 写时间线；或 force 跳 locked/build 但脚本没确认 |
| `style-not-confirmed` | 当前 style，写类工具要等风格确认 |
| `not-building` | 当前 locked，导出要先进 build |
| `stage-blocked` | 其他阶段原因 |
| `script-missing` | `video_script_confirm`：还没有脚本草稿 |
| `invalid-script` | `video_script_draft`：校验失败，没有写盘 |
| `needs-force` / `backwards` / `bad-stage` / `brief-empty` | `video_stage_advance` 的拒绝原因 |

拒绝时返回中文原因，形如：

> `video_edit_apply 被阶段门禁拦下了：当前 script——脚本还没确认。下一步：video_script_draft 写分镜脚本 → 用户明确同意后 video_script_confirm → video_style_confirm 定风格；之后才改写时间线。`

---

## 怎么装（**下面命令都没有在这台机器上执行过**）

装法与同目录的 `dsh-video-table` 完全一致——`link:` 依赖 + bundle 列表。

推荐（交给 DSH 自己装，它会改 profile 的 `package.json` 与 bundles 列表）：

```
plugin_manager install_bundle target="link:dsh-video-brief（本仓库 packages/video-brief）"
```

手工等价（三步，顺序不能反）：

```powershell
# 1) 在 profile 的 dependencies 里加 link:，并在 dsh.profile.bundles 里加 "dsh-video-brief"
#    文件：~/.dsh\profiles\desktop\package.json
#    "dsh-video-brief": "link:dsh-video-brief（本仓库 packages/video-brief）"

# 2) 装依赖（建 node_modules 里的 junction）
cd ~/.dsh\profiles\desktop
pnpm install

# 3) 重启 DSH（host 插件只在启动时装配）
```

装完自检：新会话里问「现在有哪些 video 工具」，应能看到 11 个：
`video_brief_start` / `video_brief_confirm` / `video_reference_register` / `video_reference_skip` /
`video_stage_get` / `video_stage_advance` / `video_script_draft` / `video_script_read` / `video_script_confirm` /
`video_style_confirm` / `video_style_read`。
对任意视频工程调一次 `video_stage_get`：空工程返回 `stage:"idle"`；调 `video_brief_start` 返回 `verdict:"needs-answers"` 且 `missing` 恰好 3 条。

从 0.1.x / 0.2.x 升级：

- 老工程只有 `brief.json`：第一次 `video_stage_get` 会显示 `idle`（`state.json` 不存在，阶段落后于事实），
  按 `nextStep` 调一次幂等的 `video_brief_confirm` 后进入 `script`（不再直接进 `style`）。
- **历史工程（已有 `style.json`，甚至 `state=locked/build`，但没有 `script.json`）**：
  升级后阶段**不会被收回**；`video_stage_get` 返回 `scriptMissing:true`，`nextStep` 提示先补脚本
  （`video_script_draft` → 用户确认 → `video_script_confirm`），补完继续干活即可。
  为了不打断在做的活，历史工程在 `locked` 的首次写操作仍按原行为自动进 `build`；
  脚本缺失是「建议先补」，不是「不许干活」。新工程没有这个口子：进 `style` 必须先确认脚本。
- `enforce` 下，新工程要从 `script` 走到 `style` 必须先把脚本确认；写类工具仍然要等风格确认。
  默认 `warn`，不会突然锁死。

> 注意：`cordis.patch.yml` 里的 `config` 是**整份替换**语义。要改 `gate` / `maxRounds` / `slots`，
> 就把整个 config 块照抄一遍再改，不要只写一行。

---

## 怎么关

按"最小可逆"排序，几种关法：

| 目的 | 做法 | 需要重启 |
|---|---|---|
| 只停用（最快回退） | `plugin_manager set_plugin target=dsh-video-brief enabled=false` | 否（下一次装配生效） |
| 应急 / 排查 | 设环境变量 `DSH_VIDEO_BRIEF_DISABLE=1` | 是 |
| 只关拦截、保留十一个工具 | `cordis.patch.yml` 里把 `gate` 改成 `off` | 是 |
| 只关提示段 | config 里 `promptSection: false` | 是 |
| 彻底卸载 | `plugin_manager remove_bundle dsh-video-brief`，并从 profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里删掉那两行，再 `pnpm install` | 是 |

**一键回退**（推荐给"装上去发现不对"这种场景）：`plugin_manager set_plugin target=dsh-video-brief enabled=false`。
它不动物理依赖、不删任何文件，随时可以再 `enabled=true` 回来。

另：插件对 `.dsh-video/` 是**只快照不删除**。卸载插件不会删掉工程里的 `brief.json` / `script.json` / `style.json` / `state.json`，
需要清空就手动删；`brief.json` / `state.json` 坏了插件自己会备份成 `*.bak` 再重建。

---

## 产品决定：脚本 / 风格没确认，想先看效果或改一版时间线

脚本这一关是硬的：brief 十项齐了也只是**能写脚本**；脚本没被用户确认，
不允许渲染任何样片（4 张关键帧、8 秒视频都不行），更不允许动时间线。
脚本是唯一能在没有视觉产物时逐条讨论的东西——先把"每镜画面 + 旁白/屏上文字 + 转场"对齐，再花渲染成本。

风格没确认时，也**不开口子给写类工具，不做"预览豁免"开关**。明确分两条路：

1. **看效果，不改**：脚本确认后，先渲染 4 张关键帧 + 8 秒预览片（`video_style_confirm` 的 `preview`）
   来对齐风格；必要时用 `video_sample` 渲染当前时间线的帧（工作台能力，只读）。
   这是 `style` 阶段被允许的全部"看"。
2. **一定要改**：先用 `video_style_confirm` 做一个**最小可确认**的风格（tone / palette / font / density / pace，
   哪怕是假设值），阶段进 `locked`，再改；改完不满意可以直接再 `video_style_confirm` 覆盖同一份 `style.json`，
   阶段保持在 `locked`。这样"试改"是可迭代的，但每次试改都建立在一次明确的风格确认上。

原因：一旦允许"脚本 / 风格没确认也能写"，`style` 与 `locked` 就没有意义，整个阶段机退化成只有 brief 的一道门。
默认 `gate: warn` 是给**首次安装观察期**的（写操作会放行并留日志），不是产品上的"试改通道"；
需要严格时切 `enforce`。

---

## 自测

```bash
npm test
# 等价于：
node test/brief.test.mjs
node test/script-stage-test.mjs
```

两套共 98 条，纯 Node、不依赖 DSH 运行时（存储注入内存 fs，门禁用假 context）：

```
✓ 01 空 brief：needs-answers，missing 恰好 3 条且按优先级
...
✓ 70 提示段：阶段规则表，≤400 字，覆盖六个阶段与关键工具

70/70 通过，0 失败

✓ 01 validateScript：合法脚本 → ok，总时长按镜头累计
...
✓ 28 门禁钩子：三个脚本工具都走 pre-execute（read 放行、draft/confirm 按 brief 拦）

28/28 通过，0 失败
```

`brief.test.mjs` 覆盖：原来的 31 条（优先级 / 部分填写 / 10 满 ready / 轮数到顶不放行 / 幂等 confirm / 非法槽位整批拒绝 /
drift / 损坏降级 / 原子写 / 并发 confirm / 三档门禁 / 路径三区 / 提示段 / 配置 / 装配），加阶段机 27 条，加参考素材 12 条：

- 阶段纯函数：坏 state 降级、事实 → 阶段上限（含脚本维度）、自愈回落、build 事实门槛、逐级前进、跳级 force、倒退拒绝、force 不越事实（脚本未确认同样拒绝）；
- 工具：空工程 stage_get、brief 部分/满 10 自动推进到 script、script → style 的门槛、style_confirm 门槛与写盘、style_read null 语义、
  spec / preview 校验、state 损坏降级并重建、状态领先事实的自愈、advance 跳级/倒退、并发 advance 不丢 history；
- 参考素材：未填 / 空串 / 空白仍 missing、固定提问、字符串「无参考」、`{skipped:true}`、
  `referenceStatus` 三态、register 4 条路径（只记路径不复制）、skip 幂等、
  9 项齐 + 显式无参考 vs 未回答的 ready 对照、越界与绝对路径被拒、并发 register 不丢数据、
  summary / denyReason 的「图片」文案；
- 门禁：6 阶段 × 6 类工具逐格断言（含脚本工具、工程内文件、`.dsh-video/` 内、工程外）、warn/enforce 差异、
  locked 导出拒绝码、第一次写操作自动 build；
- 提示段长度与关键词。

`script-stage-test.mjs` 覆盖脚本环节的 28 条：

- 校验纯函数：合法脚本、时长为 0/负数、时间重叠、时间断档、缺 visual、空镜、多镜多问题；
- 阶段机：brief 未满进不了 script、满 10 项自动进 script、advance to style 被拒且文案提「脚本」、force 也越不过；
- draft：校验失败不写盘、合法写盘 draftCount=1、同内容幂等、改动累加且 confirmed 重置；
- read / confirm：文件缺失返回 `{script:null, confirmed:false}`、确认落盘与阶段进 style、重复确认幂等、确认后 advance 放行；
- stage_get：scriptReady / scriptConfirmed / scriptDraftCount / scriptMissing / nextStep / blocked；
- 历史工程：有 style.json 但没 script.json 时 locked/build 不降级，只标 scriptMissing 并提示补脚本；
- 门禁：未完成 brief 调 draft 被拒、script 阶段 style 与写类被拒、三个脚本工具都走 pre-execute。

---

## 目录结构

```
dsh-video-brief/
├─ package.json          只 host：dsh.bundle.patch 指向 cordis.patch.yml，无 client
├─ cordis.patch.yml      插入插件行 + 暴露 gate / maxRounds / slots
├─ index.js              apply(ctx)：注册 11 个工具、阶段门禁、提示段，每步 try/catch
├─ src/
│  ├─ slots.mjs          10 个槽位定义 + 优先级 + 参考素材字段（kind/askText/accepts/explicitNone）+ 按 id 打补丁
│  ├─ brief.mjs          纯函数：判定 / 合并 / 差异 / drift / 摘要 / referenceStatus（显式无参考语义）
│  ├─ stage.mjs          六阶段纯函数（自愈 / 前进判定 / nextStep）+ createStageService
│  ├─ script.mjs         script.json 的分镜校验（时长 / 连续 / 空镜）+ 草稿构建 / 确认
│  ├─ style.mjs          style.json 的 spec / preview 校验与归一化
│  ├─ store.mjs          通用 JSON store（原子写、串行、坏文件备份）+ brief/state/script/style 适配
│  ├─ gate.mjs           阶段矩阵纯函数 + pre-execute 钩子（含首次写自动 build）
│  ├─ memory.mjs         只读 ~/.dsh/grill-first/global.json，按主题挑偏好
│  ├─ config.mjs         配置归一化（不依赖 schemastery）
│  ├─ prompt.mjs         提示段正文（order 650，四段式工作流 + 阶段规则）
│  ├─ tools.mjs          11 个工具的定义与 execute
│  └─ workspace.mjs      会话工作区根目录解析
├─ test/
│  ├─ brief.test.mjs     70 条（含阶段机 / 门禁 / 历史回归）
│  └─ script-stage-test.mjs  28 条（脚本校验 / 阶段 / 工具 / 历史工程 / 门禁）
└─ README.md
```

---

## 几个刻意的取舍

1. **轮数到顶也不放行。** `grill-first` 用 maxRounds 兜底放行，结果是"问 3 轮就开工"。
   这里 `maxRounds` 只用来提示"别再挤了，剩下的一次问完"，ready 只由 10/10 决定。
2. **`slots` 覆盖是按 id 打补丁，不是整份替换。** 整份替换时写错一个字段就等于删槽位，
   槽位越少越容易 ready——那等于给门禁放水。
3. **默认 `warn`。** 装上就 `enforce` 会让 `/discuss` 之外的所有视频操作突然失败；
   先观察日志，确认拦得对，再改 `enforce`。
4. **`warn` 只记日志、不弹卡片。** 一次任务里要调几十次写类工具，弹卡片等于逼用户关掉插件。
5. **文件写入按"三个区"判定。** `.dsh-video/` 内永远放行（简报和工程文档要能改），
   工程内其他文件按阶段拦，工程外不碰。只做"是不是视频工程"这一层判断，不做启发式。
6. **不写 `~/.dsh` 下任何东西。** 全局偏好只读；本插件自己的状态全部在工程目录里，
   删掉工程就删掉状态。
7. **stage 存储但以事实为上限。** 纯派生表达不了 `build`，也不留"怎么走到这里"的 `history`；
   只存不校又会出现"brief 只剩 1 项但阶段还 locked"的假状态。两者都要。
8. **风格确认允许覆盖。** 迭代时重新 `video_style_confirm` 会覆盖 `style.json`、阶段保持 `locked`，
   不需要先退回 `style`——退回不在合法方向里，也不该有。
9. **导出单独一档。** 写类工具在 `locked` 就放行，是因为"改一版看效果"是剪辑的常态；
   导出是对外交付，必须显式进 `build`，避免误触。
10. **脚本一改就必须重新确认。** `video_script_draft` 只要内容变了就把 `confirmed` 重置为 false，
    门禁只认 `confirmed=true`。这样"最后给用户看的那一版"和"落到 `script.json` 的那一版"永远是同一份；
    想拿旧确认混过新脚本，过不去。
11. **历史工程不回收阶段。** 升级时老工程没有 `script.json` 是常态；如果因此把 `locked/build` 打回 `script`，
    等于升级就打断在做的活。事实不足的门槛只向前拦（新工程进 `style` 必须确认脚本），不向后收。
