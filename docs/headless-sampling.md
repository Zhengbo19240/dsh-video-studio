# 无头采样、探路与成片回填

> 这一轮针对的是一条真实的事故链：**agent 看不见自己的片子 → 自建渲染器 → 片子不在工程里 → 声音进不去工程 → 交付物与工程分家。**
> 补的是两个口子：让 agent 在任何时候都能看见（`video_probe` / `video_sample` 无头降级 / `video_strip`），
> 让出去的片子能回来（`project.exports[]` / `video_export_scan` / `video_export_adopt`）。

## 1. 为什么必须共用一份渲染核

无头渲染如果自己再写一套绘制逻辑，agent 看到的就是另一只眼睛：偏色的、和面板不一致的。
所以 `video_sample` 的两条路径共用 `src/client/frame-render.js`：

```
面板路径 (sampler.js)                无头路径 (standalone-render.js)
        │                                     │
        └────────────┬────────────────────────┘
                     ▼
             frame-render.js
        frameLayers → renderLayers → player.drawFrame
                     │
              player.js / code-registry.js
```

- `player.frameLayers(clips, t)` 摊平图层（转场、变速、效果都在里面）
- `code.renderLayers(layers)` 用**同一个** `code-registry.js` 跑代码图层 Worker
- `player.drawFrame(ctx, ...)` 画到画布
- 面板编码成 JPEG 0.82（历史行为），无头编码成 PNG（无损，便于比对）

**实测数字**（`scripts/headless-sample-test.mjs`，Windows / Chrome 与 Edge 同机）：

| 对比 | MAD |
|---|---|
| 同一实现两次渲染（确定性） | 0 |
| Chrome vs Edge 两个 Chromium 同 t | 0 |
| 面板编码 JPEG 0.82 vs 无头 PNG（同帧） | **0.00158** |

MAD 定义：RGB 三通道平均绝对差 ÷ 255，取值 0–1；验收线 0.02。

## 2. 后端优先级

`src/headless.mjs` 的探测顺序：

1. `@napi-rs/canvas` —— 装了就用它做 Node 侧的拼图与 PNG 处理（`composeStripWithNapi`）。
   **渲帧本身仍然走浏览器页面**：视频解码与代码图层 Worker 只有真实 Chromium 才有一致语义，
   这是保证像素一致的唯一办法。napi 缺失时由页面自己拼图，输出等价。
2. Chrome / Edge headless（`--headless=new`，每次任务一个独立的 `--user-data-dir`，
   所以并行渲染互不踩 profile —— 报告里「三个进程抢一个 profile」的问题在这里断掉）。
3. 都没有 → `HEADLESS_UNAVAILABLE`，返回安装提示。

环境变量：

| 变量 | 作用 |
|---|---|
| `DSH_VIDEO_HEADLESS_BROWSER` | 指定浏览器可执行文件 |
| `DSH_VIDEO_HEADLESS_FLAGS` | 追加启动参数 |
| `DSH_VIDEO_HEADLESS_TIMEOUT_MS` | 单个渲染任务的超时（默认 60s） |
| `DSH_VIDEO_HEADLESS_DEBUG=1` | 打印页面请求、Chrome stderr |

## 3. 工具

### `video_probe`

```json
{
  "workbenchOpen": false,
  "panelUrl": "http://127.0.0.1:49671",
  "engineVersion": "0.1.0",
  "headlessAvailable": true,
  "headlessBackend": "chrome",
  "headlessBackends": { "napiCanvas": false, "chrome": true, "edge": true },
  "project": { "projectId": "vp_x", "root": "D:/proj", "title": "…", "duration": 9, "revision": 3 },
  "enabledQuota": { "used": 1, "max": 2 },
  "sampleBroker": { "lastPollAt": 1762..., "pending": 0 }
}
```

`workbenchOpen` 的判据是**面板的心跳**：面板每 700ms 轮询一次 `sample.pending`，
5 秒内有过轮询就是开着。不再靠「请求超时」反推，也不再靠报错文案猜。

### `video_sample`

面板开着 → 走面板（`via: "panel"`）；面板没开或没响应 → 无头（`via: "headless"`）。
返回值里带 `projectId` / `root` / `revision`，PNG 落在 `<root>/.dsh-video/samples/`。

### `video_strip`

```json
{ "projectId": "vp_x", "layerId": "n01-open", "start": 0, "end": 12, "fps": 6, "tile": 4 }
```

- 帧数 = `round((end-start)*fps)+1`，但上限 `min(tile², 60)`
- 网格：列数 = `tile`，行数 = `ceil(frames/tile)`
- `fps` 夹在 0.5–30，`tile` 夹在 1–8；被夹了什么写在 `clamped[]` 里
- 返回 `{ png, frames, times, cols, rows, width, height, clamped, layer }`
- `layerId` 只用于回报该图层覆盖哪一段（`layer.range`）；图始终是整条时间线的合成 ——
  判节奏要看合成结果，把代码图层单独抠出来反而看不出它和画面其它部分的关系

用途就是报告里那句话：4 张静帧判不出「2.2 秒一镜会不会拖」，一张 16 格的连拍能。

### `video_export_scan` / `video_export_adopt`

- `scan`：递归扫工程目录（深度 ≤4）里的 `.mp4/.mov/.m4v/.webm`，跳过 `.dsh-video`、`assets`、`code`、`node_modules`、`.git`。
  在 `project.exports[]` 里找不到的标 `unmanaged: true`，并尽量用 ffprobe 补时长。
  同时报 `missingFiles`（登记了但文件不在）。
- `adopt`：只登记 `path + 时长 + 大小 + 时间 + source`，**不复制、不移动文件**。
  工程外的路径直接拒绝（`OUTSIDE_PROJECT`）。

导出回填（面板侧）：导出成功后客户端把字节 POST 到 `/api/video/export`，
宿主写进 `<root>/exports/<name>` 并登记 `source: "workbench"`。
上传失败只提示，不影响用户已下载的那份文件 —— 之后 `scan` 会把它标成 unmanaged，`adopt` 可补登。

## 4. 工程归属

- `video_setup` **幂等**：目录里已有 `.dsh-video/project.json` 就复用，返回 `reused: true`，
  绝不会在它旁边静默建第二个工程。
- 所有写类工具（preview / apply / code_write / annotation_add / caption_import / export_adopt）
  返回都带 `projectId` + `root` + `revision`。
- `video_code_write` 返回**真实** `clipId`（新建时也一样），不再返回 null。
- `REVISION_CONFLICT` 的 `details` 现在是：

```json
{
  "expected": 7,
  "actual": 9,
  "lastTransactionId": "tx_ab12cd",
  "lastActor": "panel",
  "lastSummary": "裁剪 c3",
  "hint": "工程在 r7 之后被改过一次（tx_ab12cd · panel · 裁剪 c3），现在是 r9。…",
  "op": "video_edit_preview"
}
```

## 5. 自测

```powershell
node scripts/headless-sample-test.mjs
```

18 条，覆盖：probe 两态、sample 两路径、MAD 三项、strip 网格与夹紧、setup 幂等、
export scan/adopt（含拒绝工程外文件）、code_write 的 clipId、写类落点、冲突诊断。

没有 Chromium 时，渲帧相关的用例会标 `SKIP` 并写明原因，不会假装通过。
