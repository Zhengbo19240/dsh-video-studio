# Freesound 接入（可选）

工作台的 `video_sound_search` 可以同时搜本地声音库和 [Freesound](https://freesound.org/)。在线部分**默认关闭**，只有你显式提供 key 时才可用。

## 怎么开

```bash
# Windows（当前用户，永久）
setx FREESOUND_API_KEY "你的 key"

# macOS / Linux
export FREESOUND_API_KEY="你的 key"
```

改完要**重启 DSH**：环境变量在进程启动时读取。

key 在 Freesound 的 [API keys 页面](https://freesound.org/apiv2/apply/) 申请。这是你自己的账号与配额，本项目不代管、不转存、不内置任何 key。

## 行为

| 情况 | 表现 |
|---|---|
| 没设 `FREESOUND_API_KEY` | 本地结果照常返回；在线部分跳过，并在 `warnings` 里给 `NO_API_KEY`。不会报错、不会静默变成空结果 |
| key 无效 / 配额用尽 | 在线部分失败，原因写进 `warnings`；本地结果不受影响 |
| 搜索成功 | 返回 id、时长、标签、许可、试听地址。**不自动下载**，要下载必须再调一次插入工具 |

源码里没有 key、没有用户名、没有写死的 attribution。返回结果里的作者名来自 Freesound 的 API 响应（`username`），是运行时数据，不是仓库内容。

## 条款

使用在线搜索即表示你同意遵守 Freesound 的 [API 使用条款](https://freesound.org/docs/api/terms_of_use.html) 与各音频自己的许可（CC0 / CC-BY / CC-BY-NC 等）。请注意：

- 每个音效的许可不同，**商用前逐个确认**；需要署名的（CC-BY）请按原页面要求署名。
- 不要用脚本批量抓取超出配额；本项目按需搜索，不做预抓。
- 预览音质与正式文件不同，正式使用请回到 Freesound 页面下载原文件并遵守其许可。

## 为什么不做「一键下载整个 Freesound」

因为那既违反配额与条款，也会把许可各异的音频混进仓库。这里只提供检索与试听；要不要用、怎么署名，由你按每个音效的许可决定。
