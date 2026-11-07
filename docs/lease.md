# 视频工程写租约（lease）

多个 agent 在同一个视频工程上并行工作时，`sessionId` 只能回答「这是谁的会话」，回答不了
「此刻谁有权写哪一块」。写租约补的就是这一层：**租约按范围划分，不同范围可以同时存在，
同一范围串行**。

2026-11-06 起，工具与 RPC 的写操作**默认自动领取租约**（`ensureWriteAccess`）：
调用方忘传 `leaseId` 不再等于静默绕过，而是「按目标范围替本会话领一份，领不到就报错」。
**并行安全不再靠自觉。**

实现分三处：

| 位置 | 内容 |
|---|---|
| `src/lease.mjs` | 纯函数：解析范围、判冲突、判过期、校验写入（**已冻结，不在这里改**） |
| `src/store.mjs` | 租约表（进程内存）+ 统一写入口 `ensureWriteAccess` / `writeEntry` / `writeAccessInfo` |
| `src/*-tools.mjs`、`src/routes.mjs` | 写类工具与 RPC 都走 `ensureWriteAccess`，返回体带 `leaseId` |

测试：`scripts/auto-lease-test.mjs`（自动领取，21 条）、`scripts/lease-integration-test.mjs`（store 层）、
`scripts/lease-tools-test.mjs`（工具↔target 表，跑在 `DSH_VIDEO_AUTO_LEASE=0` 的旧行为下）。

---

## 1. 范围语义（scope）

| scope | 含义 | 与谁冲突 |
|---|---|---|
| `all` | 整工程（导出、整工程操作、标注、分镜落盘、分析结果、素材导入） | 与一切冲突 |
| `track:<id>` | 单条轨道：`track:v1`、`track:v2`、`track:t1` … | 同一条轨道；不与别的轨道冲突 |
| `code` | 代码图层（`c1` 上的 code 片段、动效插入） | 只与 `code` 冲突 |
| `audio` | 音频轨（`a1` / `a2` 的插入、属性、裁剪） | 只与 `audio` 冲突 |

判定规则（`lease.mjs` 的 `scopesOverlap`）：

- `all` 与任何 scope 重叠。
- 两条 `track:` 只有 trackId 相同才重叠。
- `code` 与 `audio` 各自独占，**不与 `track` 冲突**（代码图层不占轨道位，音频轨单独成类）。
- 过期租约不参与冲突判定；`listLeases` 会顺手把它们清掉。

> 注意：音频片段按 `audio` 算，不按 `track:a1`。写 a1 请申请 `audio`；
> 用 `track:a1` 去写音频会被判 `LEASE_SCOPE`。

---

## 2. 自动领取（本轮核心）

`ProjectStore#ensureWriteAccess({ projectId, sessionId, leaseId, target, ops, label })`：

1. **传了 `leaseId`** → 照旧 `assertLease`，不自动领取（父会话交给子 agent 的租约仍然有效）。
   唯一例外见第 4 节「过期重领」。
2. **没传** → 按 `target`（或从 `ops` 推导）得出所需 scope，对**本会话** `acquireLease`：
   - 本会话已有能覆盖该范围的租约 → 直接复用，`leaseAcquired:false`；
   - 否则新领，`leaseAcquired:true`；
   - 与**别人的**租约重叠 → 抛 `LEASE_CONFLICT`（原文案，`details.conflicts` 列出冲突方），
     **绝不降级放行**。
3. 自动领取需要 `sessionId`（工具从调用上下文取；RPC 从 `params.sessionId` 取）。
   两者都没有、也没传 `leaseId` → `LEASE_REQUIRED`。

返回体（工具 / RPC 会给调用方带出去）：

```jsonc
{
  "leaseId": "lease_mw4o7uv4_1",
  "lease": {
    "leaseId": "lease_mw4o7uv4_1",
    "scope": "track:v1",
    "label": "video_edit_preview",
    "sessionId": "session-auto-lease",
    "expiresAt": 1793951786944,
    "remainingMs": 599999,
    "human": "track:v1（剩 600s，会话 session-）"
  },
  "leaseScope": "track:v1",
  "leaseAcquired": true
}
```

- `leaseAcquired:false` 表示这是复用，不是新领 —— 连续调用看到同一个 `leaseId` 是正常的。
- `label` 是用途（工具名 / RPC 方法名）。复用时保留第一次的 `label`，不会改。
- 关掉自动领取时，返回体没有 `leaseId`，多一个 `warning`（见第 5 节）。

### 2.1 同一会话从窄范围升到宽范围

单个 agent 的常见路径是「先改 v1，再写标注（整工程）」。如果严格按冲突规则，
后一步会和自己上一步领的 v1 撞上，等于单人流程自己挡自己。所以：

- 本会话已持有的 **自动租约**（`auto:true`，即由 `ensureWriteAccess` 领的）在需要升范围时会被回收，
  再领更宽的一条；返回体里 `leaseSuperseded` 列出被回收的 `leaseId`。
- **显式租约一个都不碰**：`lease.acquire` 申请的、`lease.ensure` 申请的、父会话发给子 agent 的，
  自动领取不会替你释放。它们挡住时如实抛 `LEASE_CONFLICT`。
  这时要么 `lease.release`，要么由持有会话自己处理。

> 升级只在「冲突方全部是自己 + 全是自动租约」时发生。只要有一个别人的租约，
> 或者有一个自己的显式租约，就在**不动任何状态**的前提下抛冲突。

### 2.2 只读工具不领租约

`video_project_inspect`、`video_timeline_inspect`、`video_sample`、`video_analysis_read`、
`video_annotation_list`、`video_motion_list` / `video_motion_read`、`video_sound_search` /
`video_sound_sources`、`video_storyboard_from_srt` / `video_storyboard_read`、
`video_asr_status`、`video_tts_probe` / `video_tts_voices` 一律不碰租约表
（`scripts/auto-lease-test.mjs` 断言「只读前后 store 里租约数量不变」）。

`video_project_open` / `video_setup` 是「先把工程打开」的引导路径，不领租约。

---

## 3. 开关矩阵

两个环境开关：

- `DSH_VIDEO_AUTO_LEASE`：`0` 关掉自动领取，回到旧行为；**默认开**。
- `DSH_VIDEO_REQUIRE_LEASE`：`1` 要求写操作必须持有租约；默认关。

| AUTO_LEASE | REQUIRE_LEASE | 没传 leaseId 的写 | 返回体 |
|---|---|---|---|
| 开（默认） | 0 | **自动领取后放行**；冲突抛 `LEASE_CONFLICT` | 带 `leaseId` / `lease` / `leaseScope` / `leaseAcquired` |
| 开（默认） | 1 | **自动领取后放行**（自动领取算「有租约」） | 同上 |
| 0 | 0 | 旧行为：只校验会话归属（`assertSession`） | 带 `warning`：「并行安全已关闭」 |
| 0 | 1 | `LEASE_REQUIRED` | — |

结论：**要严格就开 REQUIRE**（自动领取会把该领的都领上，面板与工具不再被误挡）；
**要排障/复现旧行为就关 AUTO**，但这时并行安全确实回到「靠自觉」，每个写结果都会带 warning 提醒你。

`DSH_VIDEO_AUTO_LEASE=0` 的 warning 原文：

> 并行安全已关闭（DSH_VIDEO_AUTO_LEASE=0）：这次写没有领取租约，只校验了会话归属。
> 同一工程的另一个 agent 可能同时改同一片段，后提交的会覆盖先提交的。

---

## 4. 过期与续租

- 默认 TTL 10 分钟；`lease.touch` 续租（5 秒节流：5 秒内重复 touch 不改变到期时间）。
- **过期后带旧 `leaseId` 继续写**（自动领取开着时）：按原持有会话、原 scope 自动重领一条，
  返回体里 `leaseRenewed:true`、`leaseId` 是**新的**。旧 `previewId` 仍然可用
  （它记的是范围，不是租约 id），只要 revision 对得上。
- 重领时如果原 scope 已经被别人拿走 → `LEASE_CONFLICT`（不降级、不偷偷换个范围）。
- 自动领取关掉时，过期就是 `LEASE_EXPIRED`，不会重领；下一次不带 `leaseId` 的调用会重新领。
- **不自动释放**。租约到期自然失效，写完不回收 —— 这样同一个 agent 连续调用能一直复用同一份租约。
  长任务（>10 分钟）必须自己 `lease.touch`，否则中途会走一次「过期重领」（会拿到新 `leaseId`）。

---

## 5. 释放策略

- 写完**不自动释放**。理由：连续调用要复用；提前释放等于把「我还在写」的信号撤掉，
  另一个 agent 会立刻插进来。
- 需要腾位置时手动 `lease.release`（只能由持有会话释放；别人释放返回 `{released:false}` 不报错）。
- 工具有没有异常都不会释放租约；异常时最坏结果是等 10 分钟自然过期，不会留下幽灵写权限
  （租约只在进程内存，重启即清空）。

---

## 6. RPC

```jsonc
// lease.acquire —— 显式申请（父会话发租约给 teammate 时用）
{ "method": "lease.acquire",
  "params": { "projectId": "vp_xxx", "sessionId": "session-parent",
              "scope": "track:v1", "ttlMs": 600000, "label": "主轨剪辑" } }
// → { lease: { leaseId, scope, label, sessionId, expiresAt, remainingMs, human }, conflicts: [] }
// 冲突时抛 LEASE_CONFLICT，details.conflicts: [{ leaseId, scope, label, sessionId, expiresAt }]

// lease.ensure —— 便利方法：本会话在该 scope 上「保证持有」，幂等
{ "method": "lease.ensure",
  "params": { "projectId": "vp_xxx", "sessionId": "session-xxx",
              "scope": "code", "label": "面板：代码图层" } }
// → { lease: {...}, acquired: false, reused: true }
```

| 方法 | params | 返回 |
|---|---|---|
| `lease.acquire` | `projectId, sessionId, scope?, ttlMs?, label?` | `{ lease, conflicts }` |
| `lease.ensure` | `projectId, sessionId, scope, ttlMs?, label?` | `{ lease, acquired, reused }` |
| `lease.release` | `projectId, leaseId, sessionId` | `{ released: boolean }`（幂等） |
| `lease.touch` | `projectId, leaseId` | `{ lease \| null }` |
| `lease.list` | `projectId` | `{ leases: [{ leaseId, scope, label, sessionId, expiresAt, remainingMs, human }] }` |

`lease.ensure` 与 `lease.acquire` 的区别：`ensure` 会先看本会话是否已经**覆盖**这个 scope
（例如已持 `all`，再 ensure `track:v1` 直接复用），并按需回收自己的自动租约；
领到的是**显式租约**（`auto` 不置位），后续自动领取不会替你释放它。

`ttlMs` 默认 10 分钟；`human` 形如 `track:v1（剩 600s，会话 session-）`。

`edit.preview` / `edit.apply` 也自动领取：带 `leaseId` 就按预览记录的目标范围校验，
不带就用 `sessionId` 领（RPC 的 `sessionId` 由面板带上来）。

---

## 7. 工具 → target 判定

写类工具都走 `ensureWriteAccess`，自动领取所需 scope：

| 工具 | target | 需要的 scope |
|---|---|---|
| `video_edit_preview` / `video_edit_apply` | 由 ops 推导（见下） | 取决于 ops |
| `video_annotation_add` | `{type:'project'}` | `all` |
| `video_code_write` | `{type:'code'}` | `code` |
| `video_caption_import` | `{type:'track',trackId:'t1'}` | `track:t1` |
| `video_motion_insert` | `{type:'code'}` | `code` |
| `video_sound_insert` | `{type:'audio'}` | `audio` |
| `video_storyboard_save` / `video_storyboard_apply` | `{type:'project'}` | `all` |
| `video_analyze`（写 `analysis.json`） | `{type:'project'}` | `all` |
| `video_transcribe`（仅 `applyToTimeline:true`） | `{type:'track',trackId:'t1'}` | `track:t1` |

`video_edit_preview` 的 ops → target 推导：

- `clip.insert`：`clipType:'code'` → `code`；音频轨（a1/a2）→ `audio`；其余 → `track:<trackId>`
- `clip.*` / `code_layer.*`：代码片段 → `code`；音频轨 → `audio`；其余 → `clip:<所在轨>`
- `clip.move` 跨轨：源轨 + 目标轨都要覆盖
- `track.set_muted` / `track.set_locked` → 那条轨道
- `project.set_ratio` / `annotation.*` → 整工程
- `track.add` / `asset.*` → 不单列（前者只是补空轨，后者是插入动作的附带效果）
- 其余不认识的动作 → 整工程（保守）

`video_edit_apply` 只拿得到 `previewId`，范围从预览记录里取（`store.previewTargets`），
所以「预览时领的什么，apply 就校验什么」。

---

## 8. 父会话把租约交给子 agent（仍然推荐，但不再必需）

自动领取之后，teammate 用自己的会话 + `projectId` 就能**自己**领到需要的那份租约，
不会再撞 `BOUND_TO_OTHER_SESSION`。父会话发租约的价值变成了「调度」：提前占住范围，
避免两个 teammate 同时去抢同一条轨道。

```jsonc
// 1) 父会话：拿主轨（10 分钟，不够就 touch）
{ "method": "lease.acquire",
  "params": { "projectId": "vp_abc", "sessionId": "session-parent",
              "scope": "track:v1", "label": "agentA / 主轨 v1" } }
// → { "lease": { "leaseId": "lease_m3k2_1", "scope": "track:v1", ... } }

// 2) 子 agent A：带 leaseId 写（会话不参与校验）
{ "method": "edit.preview",
  "params": { "projectId": "vp_abc", "leaseId": "lease_m3k2_1",
              "baseRevision": 12,
              "ops": [{ "type": "clip.trim", "clipId": "c1", "start": 0, "duration": 3 }] } }

// 3) 不带 leaseId 也行：A 会自动领一份 track:v1；但如果父会话已经发下去了，会撞 LEASE_CONFLICT
//    —— 这正是「范围已经被别人占着」的正确表现，不是 bug。

// 4) 父会话释放（或让它自然过期）
{ "method": "lease.release",
  "params": { "projectId": "vp_abc", "leaseId": "lease_m3k2_1", "sessionId": "session-parent" } }
```

`release` 只接受租约持有会话释放；子 agent 释放会返回 `{ released:false }`（不报错）。
子 agent 可以自己 `lease.acquire`，也可以反复 `touch` 父会话给的租约把 10 分钟往后推。

---

## 9. 面板 / 客户端

- **面板写入不需要自己调 `lease.ensure`**：`edit.preview` / `edit.apply` / `annotations.add` /
  `asset.probe` / `motion.insert` / `sound.insert` / `storyboard.*` / `tts.speak` / `analyze.run` /
  `asr.transcribe` / `/api/video/import` 都会在 host 侧自动领取，面板只管发 `sessionId`。
- **只有外部脚本 / 其他插件**才需要 `lease.ensure`：它适合「先占住范围，再做一串事」的场景。
- 风格样片上传（`/api/video/style-upload`）只写 `.dsh-video/style-preview/` 下的临时产物，
  不进工程文档、不占时间线，**不需要租约**。
- 面板读到 `LEASE_CONFLICT` 时把 `details.conflicts` 原样显示（谁占着、什么时候到期），
  不要自动重试 —— 重试只会制造冲突风暴。
- `tts.speak` 的租约在 RPC 层领取（`audio`），但底层 `src/tts.mjs` 仍按会话绑定写
  （该文件冻结中）。所以在 `DSH_VIDEO_REQUIRE_LEASE=1` 下，TTS 内层写会拿到 `LEASE_REQUIRED` ——
  这是已知欠账，等 `tts.mjs` 解冻后把 `leaseId` 透传进去才算真正接完。

---

## 10. 错误码

| code | 触发场景 | 处理 |
|---|---|---|
| `LEASE_REQUIRED` | 既没 `leaseId` 也没 `sessionId`，无法自动领取；或 `AUTO_LEASE=0` + `REQUIRE_LEASE=1` | 带上会话身份，或先 `lease.acquire` |
| `LEASE_NOT_FOUND` | `leaseId` 不存在、已被释放、工程被 `delete`、进程重启过 | 重新 acquire（或直接不带 leaseId，让自动领取处理） |
| `LEASE_EXPIRED` | `AUTO_LEASE=0` 且租约超过 TTL；开着自动领取会自动重领 | 重新 acquire；不要跨重启缓存 `leaseId` |
| `LEASE_SCOPE` | 租约范围不覆盖本次目标（如拿 `track:v1` 去写 v2 / 写整工程 / 写 code） | 不带 leaseId 重试（自动领对应范围），或申请对应租约 |
| `LEASE_PROJECT_MISMATCH` | 拿 A 工程的 `leaseId` 去写 B 工程 | 每个工程单独 acquire |
| `LEASE_CONFLICT` | 要的 scope 被别人（或自己的显式租约）占着；`details.conflicts` 列出冲突方 | 等对方 `release`，换不冲突的范围，或先释放自己的显式租约 |

`assertLease` / `ensureWriteAccess` 抛出的都是 `DomainError`，`code` 从 `lease.mjs`
原样透传；RPC 层会以 HTTP 400 + `{ ok:false, error:{ code, message, details } }` 返回。

---

## 11. 重启即失效

租约表是**进程内存**（`ProjectStore#leases`），不落盘：

- DSH 重启 / 插件重载后，所有 `leaseId` 立即作废，再写会得到 `LEASE_NOT_FOUND`
  （不带 `leaseId` 则自动领新的，无感）。
- 这是有意的：重启后不该留下「幽灵写权限」。
- 工程被 `delete` 时租约表同步清空。
- 需要跨重启的协作信息请写进工程文档 / `storyboard.json`，不要依赖租约。

---

## 12. 并发落盘

`ProjectStore#persist` 对同一个工程目录的写入做了串行化，并且临时文件名带随机后缀。
两个 agent 同时 `applyPreview` 时：

- 内存里的文档按调用顺序提交（revision 单调前进）；
- 磁盘上最后落的是**后提交**的那一版，不会出现两个临时文件互相覆盖或 `rename` 报 ENOENT。

`scripts/auto-lease-test.mjs` 第 ⑥ 条是真实并发跑的：`Promise.all` 里 t1 与 code 两笔
同时自动领取、各自 apply，revision +2。

---

## 13. 多 agent 协作规程

租约只是一层机制。怎么派人、任务怎么写「写作用域」、上下文满了怎么交班、
`LEASE_CONFLICT` / `LEASE_EXPIRED` 怎么重试、哪些做法等于没并行 —— 见
[team-crew.md](team-crew.md)。里面还记录了 `scripts/crew-parallel-test.mjs` 的真实并行证明
（两份不同轨道的租约同时 preview → apply，两笔都落盘），以及这套机制目前做不到的部分。
