# 小队协作规程（team crew）

> 适用场景：一个视频工程，主 agent 拆活，几个 teammate（子 agent）同时改不同的轨道 / 图层，
> 靠写租约（lease）防止互相踩。
>
> 一句话：**主 agent 只做调配，teammate 只在自己范围里动手，租约把「谁此刻能写哪一块」钉住。**
>
> 现状前提（2026-11-06 起）：写操作**默认自动领取租约**（`DSH_VIDEO_AUTO_LEASE` 默认开）。
> teammate 忘了带 `leaseId` 也不会再静默绕过 —— 它会按目标范围领一份；范围被别人占着就报
> `LEASE_CONFLICT`。父会话发租约仍然值得做（那是**调度**，提前占位、避免两个 teammate 互抢），
> 但不再是「并行安全能不能成立」的前提。机制细节见 [lease.md](lease.md)，
> 自动领取的真实验证见 [auto-lease-test.mjs](../scripts/auto-lease-test.mjs)，
> 多租约并行的真实验证见 [crew-parallel-test.mjs](../scripts/crew-parallel-test.mjs)。

---

## 1. 角色划分

分工的判据只有一个：**写作用域（scope）**。不是「谁负责什么内容」，是「谁有权写哪一段」。

| 角色 | 默认 scope | 典型工具 | 不该碰 |
|---|---|---|---|
| 素材员 | `track:v1`（主轨） | `video_edit_preview/apply` 的 `clip.insert`（media）、`clip.trim/move/split`（v1） | `t1`、`audio`、`code`、整工程操作 |
| 排版员 | `track:t1`（字幕）；文字叠加另拿 `track:v2` | `video_caption_import`、t1/v2 上的 `clip.*` 与文字样式 | `v1`、`audio`、整工程 |
| 音频员 | `audio` | `video_sound_insert`、音频片段属性 / 裁剪 | 视频轨、字幕轨、`code` |
| 合成员 | `all`（整工程，短持有） | 导出、`video_annotation_add`、`video_storyboard_save/apply`、`video_analyze`（写 `analysis.json`） | 别在 `all` 下做长剪辑，它会把所有人挡住 |
| 主 agent | 不默认持有；发租约、验收、兜底 | `lease.acquire / release / touch / list`、`video_project_inspect`、只读工具 | 不亲自做大量编辑（见第 2 节） |

几条容易记错的边界（来自 [lease.md](lease.md) 第 1、4 节）：

- 音频片段按 `audio` 算，**不按 `track:a1`**。拿 `track:a1` 去写音频会被判 `LEASE_SCOPE`。
- `code` 与 `track` 不冲突：代码图层不占轨道位，可以和研究主轨的人并行。
- `all` 与任何 scope 都冲突，**排他**。
- 协作者用 `video_analyze` 生成 `analysis.json` 时，target 是整工程，需要 `all`——这是素材员偶尔要临时升到 `all` 的唯一常见理由；做完立刻 `release`。
- `video_tts_speak` 目前**没有** `leaseId` 参数（`tts.mjs` 冻结中）。RPC `tts.speak` 会在 host 侧自动领 `audio` 租约做闸门，但底层 `ttsSpeak` 仍按会话写：`DSH_VIDEO_REQUIRE_LEASE=1` 时它会撞 `LEASE_REQUIRED`。不要让音频员以为「我拿了 audio 租约所以 tts 也完整受保护」。
- 同一会话从窄范围升到宽范围（先改 v1、再写标注）时，自动领取会回收**自己领的自动租约**再领宽的；`lease.acquire` / 父会话发下来的**显式租约不会被自动回收**，它们挡住时就是 `LEASE_CONFLICT`。

**一个角色一次只拿一个 scope**：需要跨范围时，说明这项任务本身没拆干净，回到第 4 节重拆。

---

## 2. 主 agent 的职责

主 agent 是调度员，不是主力剪辑。四件事，按顺序：

1. **拆活**：把目标拆成「一个 scope 一件事」的任务。拆不出单 scope 的，就继续拆或标成 `all` 并安排独占时段。
2. **发租约（推荐，不再必需）**：`lease.acquire` 拿 scope，把 `{ projectId, leaseId, scope }` 交给 teammate。**租约的持有会话是主 agent**，teammate 只是拿 `leaseId` 当通行证；不带 `leaseId` 时 teammate 也会自己领一份。
3. **验收**：读 `video_project_inspect` / `video_timeline_inspect` / 磁盘上的 `.dsh-video/project.json`，核对 revision、片段 id、轨道号；不以 teammate 的「我做完了」为准。
4. **兜底**：冲突时仲裁（换范围 / 排队 / 降级为串行）；租约过期时补发；teammate 上下文满了时接手收尾（见第 5 节）。

明确不做的：

- 不长期持有 `all`。`all` 是短租，导出/整工程操作做完立刻 `release`。
- 不在自己手里排队做「顺手的一点小编辑」。主 agent 一动手，就同时占着调度权和写权，冲突时没人仲裁。
- 不替 teammate 猜 revision。teammate 每次 `preview` 前必须自己读当前 revision。

---

## 3. 一次派活的完整序列

可复制。假设父会话是 `session-parent`，工程 `vp_abc`，要把主轨交给 agentA。

### 3.1 父会话：发租约

```jsonc
// 1) 拿主轨（默认 10 分钟；长任务靠 touch 续）
{ "method": "lease.acquire",
  "params": { "projectId": "vp_abc", "sessionId": "session-parent",
              "scope": "track:v1", "ttlMs": 600000,
              "label": "agentA / 主轨 v1" } }
// → { "lease": { "leaseId": "lease_m3k2_1", "scope": "track:v1",
//                 "expiresAt": 1762400000000, "remainingMs": 600000,
//                 "human": "track:v1（剩 600s，会话 session-）" },
//     "conflicts": [] }
```

### 3.2 父会话：把三样东西交给 teammate

```text
工程：vp_abc
租约：lease_m3k2_1（范围 track:v1，到期 <ISO 时间>）
任务：把 v1 上 c1 前移 0.5s、c2 裁到 3s，写完回报 revision 与两个片段 id
禁止：不要碰 t1 / audio / code / 整工程
```

只交 `leaseId` 不够——teammate 还要 `projectId`（或让工具用租约反查工程）和**明确的写作用域**。
`sessionId` 不用交：带租约的写路径不校验会话。

不带 `leaseId` 也能干：teammate 用自己的会话 + `projectId` 调工具时，会自动领一份对应范围的租约
（返回体里带 `leaseId`，可以拿去复用）。**但父会话已经发过同一范围时，它会撞 `LEASE_CONFLICT`** ——
所以要么统一由父会话发，要么统一让 teammate 自己领，别两边都做。

### 3.3 teammate：干活

```jsonc
// 先读当前 revision（video_timeline_inspect 或 project.summary），再 preview
{ "method": "edit.preview",
  "params": { "projectId": "vp_abc", "leaseId": "lease_m3k2_1",
              "baseRevision": 12,
              "ops": [{ "type": "clip.trim", "clipId": "c1", "start": 0.5 },
                      { "type": "clip.trim", "clipId": "c2", "duration": 3 }] } }
// → { "previewId": "pv_xxx", ... }

// 应用同一个 leaseId（工具层调用 video_edit_apply 时也带 leaseId）
{ "method": "edit.apply",
  "params": { "previewId": "pv_xxx", "leaseId": "lease_m3k2_1" } }
// → { "transactionId": "tx_xxx", "revision": 13, ... }
```

轮询间隔长于 5 分钟就 `touch` 一次（5 秒内重复 touch 不改变到期时间，不必狂刷）：

```jsonc
{ "method": "lease.touch", "params": { "projectId": "vp_abc", "leaseId": "lease_m3k2_1" } }
```

### 3.4 父会话：收工释放

```jsonc
{ "method": "lease.release",
  "params": { "projectId": "vp_abc", "leaseId": "lease_m3k2_1", "sessionId": "session-parent" } }
// → { "released": true }
```

**释放只能由持有会话做。** teammate 调 `release` 会得到 `{ "released": false }`（不报错），
租约还在——下一个 agent 会继续撞 `LEASE_CONFLICT`。这是交接时最常见的「以为放掉了」。

### 3.5 多个 teammate 并行时

父会话先把不重叠的 scope 一次发完（`track:v1`、`track:t1`、`code`、`audio` 可同时持有），
再并行派活。不要让 teammate 自己去抢租约——那等于把调度权交给运气：

```jsonc
{ "method": "lease.acquire", "params": { "projectId": "vp_abc", "sessionId": "session-parent",
  "scope": "track:t1", "label": "agentB / 字幕 t1" } }
{ "method": "lease.acquire", "params": { "projectId": "vp_abc", "sessionId": "session-parent",
  "scope": "code", "label": "agentC / 代码图层" } }
{ "method": "lease.acquire", "params": { "projectId": "vp_abc", "sessionId": "session-parent",
  "scope": "audio", "label": "agentD / 配音音效" } }
```

同会话重复 acquire 同 scope 是**幂等**的（返回原租约，不新增、也不续期）。所以父会话重试发租约是安全的。

---

## 4. 任务板约定

任务板是工程目录下的一份文件（建议 `项目代办.md`），不是任何 agent 的记忆。每条任务必须写清
**写作用域**，否则两个人会领到同一段。

字段固定：

| 字段 | 必填 | 说明 |
|---|---|---|
| 任务 id | 是 | `t-001`，稳定不改 |
| 负责人 | 是 | agentA / agentB / 主 agent |
| 目标 | 是 | 一句话，可验收 |
| 写作用域 | **是** | `track:v1` / `track:t1` / `code` / `audio` / `all`（`all` 必须写独占时段） |
| 具体资源 | 建议 | 片段 id、图层 id、时间区间，如 `c1..c5 / 0–12s` |
| 验收 | 是 | 看什么、等于什么（如 revision +2、v1 上 3 个片段） |
| 状态 | 是 | 待领 / 进行中 / 待验收 / 已完成 / 阻塞 |
| 租约 | 进行中必填 | `lease_xxx`（到期时间） |

示例：

```markdown
| id | 负责人 | 目标 | 写作用域 | 具体资源 | 验收 | 状态 | 租约 |
|---|---|---|---|---|---|---|---|
| t-001 | agentA | 主轨前移并裁切 | track:v1 | c1,c2 / 0–8s | v1 片段 2 个，revision+1 | 进行中 | lease_m3k2_1 |
| t-002 | agentB | 补 6 条字幕 | track:t1 | t1 新片段 6 个 | 字幕轨 6 条，文本无误 | 进行中 | lease_m3k5_2 |
| t-003 | 主 agent | 导出 1080p | all | 整工程 | 文件存在且可解码 | 待领 | —（导出前现领，做完即放） |
```

规则：

1. **一条任务一个 scope。** 需要同时改 v1 和 t1 的，拆成两条，或标成串行的 `all` 独占。
2. **进行中的任务 scope 不许重叠。** 领取前先扫一眼状态为「进行中」的行；重叠就排队，不硬上。
3. **资源也要写。** 同一轨道上两人接力的场景（A 交班给 B），用片段 id / 时间区间划清，别只写 scope。
4. **`all` 单独一行、单独时段。** 导出、分镜落盘、`video_analyze` 这类操作期间，其他人不应有写任务在跑。
5. **改了状态就落盘。** 任务板的更新在「干完一笔事务」之后、`release` 之前做。

---

## 5. 换班（上下文快满时）

teammate 的上下文是消耗品，租约和任务板才是可交接的状态。触发条件：上下文用到约 8 成，或任务
自然告一段落。

**换班三步，缺一不可：**

1. **收尾**：把在写的预览要么 `apply` 掉、要么丢弃（不要留着半成品）；在写事务完成后才更新状态。
2. **写两处文档**（不靠它自己的记忆）：
   - `项目代办.md`：任务状态改成「进行中（交班）」，写明已完成到哪个 revision、下一步、验收口径。
   - `知识图谱.md`：这一轮定下的约束、踩过的坑、被否决的方案（例如「不要用 track:a1 写音频」）。
3. **交租约**：租约是能力，**`leaseId` 本身可以转交给新 agent**（新会话不需要是持有者，带租约的写
   路径不校验 `sessionId`）。要么把 `{ projectId, leaseId, scope, 到期时间 }` 交给新 agent，
   要么交回主 agent 由它 `release` 后重发。

**交班消息模板：**

```text
工程：vp_abc
任务：t-002（进行中，then t-004）
已完成：revision 17，t1 上字幕 6 条（id 见任务板）
未完成：t-004 需要把第 6 条字幕上移 0.5s
写作用域：track:t1（不要碰 v1 / audio）
租约：lease_m3k5_2，到期 <ISO>；我不是持有者，不能 release，只能转交或让主 agent 收
已核对：磁盘 project.json 与内存一致，revision 17
```

新 agent 接手时**先读这两份文档，再 `lease.list` 确认租约还在**，然后从任务板的下一条继续。
不要凭「上一个 agent 说做完 6 条」就直接改第 7 条——先看一眼时间线。

---

## 6. 失败处置与反例

### 6.1 五类错误

| 错误码 | 含义 | 处置 |
|---|---|---|
| `LEASE_CONFLICT` | 要的 scope 被别人（或自己的**显式**租约）占着；`details.conflicts` 里有冲突方 | 不做重试风暴。换不冲突的 scope、排队等 `release`，或让主 agent 仲裁。租约最多 10 分钟自然过期，没有强制回收 |
| `LEASE_EXPIRED` | 租约已过期（10 分钟无 `touch`）。**自动领取开着时不会看到它**：带旧 `leaseId` 的写会自动按原 scope 重领（返回新 `leaseId` + `leaseRenewed:true`） | 只在 `DSH_VIDEO_AUTO_LEASE=0` 时出现：重新 `acquire` 同 scope，别拿旧 `leaseId` 去 apply |
| `LEASE_NOT_FOUND` | 记录已被清掉（别人 `list` 过、或进程重启过） | 重新 `acquire`（或干脆不带 `leaseId` 让自动领取处理）。永远不要跨重启缓存 `leaseId` |
| `LEASE_SCOPE` | 租约范围不覆盖本次目标 | 不带 `leaseId` 重试（自动领正确范围），或交给持有正确范围的人 |
| `REVISION_CONFLICT` | 预览基于旧版本（别人先提交了） | 重读 revision，重新 `preview`。不要重试旧的 `previewId` |

### 6.2 邻居在写时的重试策略

- 冲突后**先看 `lease.list`**：对方还在、scope 还占着 → 不要空转，去做不冲突的部分（换轨 / 整理素材 / 写文档）。
- 真要重试：退避 `200ms → 400ms → 800ms`，最多 5 次，带一点随机；这期间每次重试前**重读 revision**。
- 别用 `while (true)` 轮询 `acquire`。同一个 scope 在同会话内是幂等的，重复 acquire 不会变快，只会刷日志。
- 等不到就上报主 agent，由它决定：换范围、排队、还是把 `all` 独占时段让出来。
- 注意：**范围不重叠 ≠ 不会冲突**。两笔提交仍共享全局 `revision`；两个 preview 用了同一个 `baseRevision`，
  后 apply 的那笔会 `REVISION_CONFLICT`（证明脚本里有这条证据）。

### 6.3 反例

1. **两个 agent 都拿 `all`。** 第二个会直接 `LEASE_CONFLICT`；先拿的那个只要不释放，所有人都被挡住，
   **等于没并行**。`all` 只能短持有。
2. **父会话已经发过同一范围，teammate 又让工具自动领一次。** 两边都以为「我占着」，
   第二个会收到 `LEASE_CONFLICT`。约定：**要么统一由父会话发、要么统一让 teammate 自己领**；
   发租约是调度手段，不是安全前提。
3. **两个 preview 共用同一个 `baseRevision`。** 就算 scope 不重叠，第二笔也会 `REVISION_CONFLICT`。
   每个 agent 必须自己读 revision。
4. **拿 `track:a1` 写音频。** 判 `LEASE_SCOPE`（音频按 `audio` 一类算）。
5. **teammate 自己 `release` 父会话发的租约。** 返回 `{ released:false }`，不报错；租约还占着，
   下一个 agent 一直冲突。释放权只在持有会话手里。
6. **把租约当锁来「等」。** 租约到期是自动的，但你没有任何办法催别人放；唯一的强制力是 10 分钟 TTL。
7. **以为自动领取会替你回收显式租约。** 不会。`lease.acquire` / `lease.ensure` / 父会话发下来的租约
   挡住整工程操作时，`video_annotation_add` 之类会如实报 `LEASE_CONFLICT` —— 先 `release` 再升范围。

---

## 7. 现在能不能这么干

**能（已验证）：**

- 不同轨道 / 代码 / 音频之间的并行有租约保护。证明脚本里 agentA（`track:v1`）和 agentB（`track:t1`）
  用 `Promise.all` 同时 `preview → applyPreview`，两笔都成功，revision 从 1 递增到 3，两处改动都落进
  磁盘 `.dsh-video/project.json`，基线片段和素材一个没丢；第三人抢 `track:v1` 被 `LEASE_CONFLICT`
  挡住，文案里带着 `agentA / 主轨 v1 … lease_xxx`。
- **忘传 `leaseId` 不再等于绕过**：`scripts/auto-lease-test.mjs` 里，v1 预览自动领 `track:v1`、
  第二笔复用同一 `leaseId`、不同 target 领到不同 scope、另一个会话抢同一 scope 直接
  `LEASE_CONFLICT`、teammate 用自己的会话自动领到租约后成功写入 —— 21 条全绿。
- 并行两笔同时自动领取并各自提交（t1 + code），revision +2，实测输出：
  `t1 lease_…_3 @ r1 / code lease_…_4 @ r2（总 revision 2）`。
- 过期与接手、幂等重试、越界拒绝（拿 `track:v1` 写 `t1` → `LEASE_SCOPE`）都已实测。
- 复现：`node scripts/crew-parallel-test.mjs`（14 条）、`node scripts/auto-lease-test.mjs`（21 条）。

**不能 / 有限：**

- **同一轨道仍然串行。** 两个素材员都想要 `track:v1`，只能排队，没有「片段级」租约。
- **自动领取不会替你回收显式租约。** 拿着父会话发的 `track:t1` 去做整工程操作会 `LEASE_CONFLICT`，
  必须先 `release`。自动领取只回收它自己领的那类租约（`auto:true`）。
- **面板不需要自己领租约，但它仍然要带 `sessionId`。** RPC 写入在 host 侧自动领；
  `tts.speak` 是例外的一部分（见下条）。
- **租约只在内存。** 进程重启后全部 `LEASE_NOT_FOUND`；跨重启的协作信息必须写进任务板 / 知识图谱。
- **全局 revision 是单点。** 范围不重叠也可能因 `baseRevision` 相同而有一笔 `REVISION_CONFLICT`，
  必须重读再 preview。
- **`video_tts_speak` 尚未透传 `leaseId`**（`tts.mjs` 冻结中）：RPC `tts.speak` 会领 `audio` 租约，
  但底层写仍按会话，`DSH_VIDEO_REQUIRE_LEASE=1` 时内层会 `LEASE_REQUIRED`。这一处还没接完。

**一句话结论：** 这套规程现在可以放心派多个 teammate 并行干活 —— 工具与 RPC 会按目标范围
**自动领租约**，抢到同一范围就是 `LEASE_CONFLICT`，不再有「忘了传 `leaseId` 就静默覆盖」的路径。
父会话发租约剩下的是**调度价值**（提前占位、避免互抢），不是安全前提。
真正还要靠人的只有两件事：任务板写清写作用域、同一轨道别硬塞两个人。

---

## 8. 相关文件

- 范围语义、自动领取、开关矩阵、错误码、RPC 字段：[lease.md](lease.md)
- 自动领取的真实验证（21 条，含真实输出）：[../scripts/auto-lease-test.mjs](../scripts/auto-lease-test.mjs)
- 多租约并行的真实验证（14 条断言，含真实输出）：[../scripts/crew-parallel-test.mjs](../scripts/crew-parallel-test.mjs)
- 工具 ↔ target 表（旧行为）：[../scripts/lease-tools-test.mjs](../scripts/lease-tools-test.mjs)
- 租约纯函数：`src/lease.mjs`；租约表与写闸门（`ensureWriteAccess`）：`src/store.mjs`；RPC：`src/routes.mjs`
