# DSH Video Suite

**在你的 DSH 中插入一个 Agent 可调用的工作台。**

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的一套视频工作台插件：**工程文档只有一份，在 Host；对话里的 agent 和界面里的你，改的都是它。**

这个仓库把三件东西放在一起，因为它们本来就是一条流水线：

| 包 | 作用 | 版本 |
|---|---|---|
| `packages/video-table` | 视频工作台本体：时间线、预览、导出、音效、语音转字幕、配音，以及给 agent 的原生工具 | 0.2.0 |
| `packages/video-brief` | 开工前的阶段机与门禁：10 槽位简报 → 分镜脚本确认 → 风格锁定 → 才允许改时间线 / 导出 | 0.3.0 |
| `packages/motion-lib` | 66 张代码动效卡（`code.js` 纯函数 + `meta.json`），工作台原生加载 | — |
| `packages/sound-library` | 音效的**声学索引**与下载脚本；不含音频二进制 | — |

> 状态：可用。`packages/video-brief` 有完整测试；`packages/video-table` 的测试是自包含的 Node 脚本（部分需要 ffmpeg / Chromium，缺依赖时会明确说明而不是假装通过）。

---

## 为什么是「一份工程文档」

大多数 agent 剪辑方案是「模型生成一段脚本 → 渲染」。这里反过来：时间线是一份带 revision 的 JSON，agent 的每次修改都走 `preview → apply → undo`，和人在面板上拖动是**同一条路径、同一个撤销栈**。所以：

- agent 改完，你刷新就能看见；
- 你改完，agent 下次 `inspect` 读到的是同一份；
- 任何一步都能撤销，不需要「重新生成一遍」。

## 三个包怎么拼起来

```
你 / agent
   │
   ├─ video-brief   先问清 10 个槽位 → 写分镜脚本 → 你确认 → 定风格 → 才开闸
   │
   ├─ video-table   工程 JSON（唯一真相）
   │     ├─ 时间线 / 预览 / 导出（WebCodecs）
   │     ├─ 代码图层 ── motion-lib 里的动效卡
   │     ├─ 音效     ── sound-library 的索引 + 本地音频
   │     └─ ASR / TTS（可选，需本机 ffmpeg + Python）
   │
   └─ 浏览器面板    和工作台共用同一份工程与同一套命令
```

`video-brief` 是可选的门禁，但强烈建议装：它拦的是「脚本没确认就开始剪」和「风格没定就改时间线」这两类返工。

---

## 快速开始

要求：Node.js ≥ 20；一个 Chromium 系浏览器（Chrome / Edge，用于无头渲帧与导出）；DeepSeek Harness 已安装并能加载本地 bundle。

```bash
git clone https://github.com/Zhengbo19240/dsh-video-studio
cd <仓库目录>
npm install          # 安装 workspace 依赖（esbuild / react 等）
npm run build        # src/client/*.js → packages/video-table/client.js
```

`client.js` 是构建产物，**不入库**：它是几百 KB 的生成文件，每次改一行源码都会产生整文件 diff。拿到仓库后必须先 `npm run build`。

安装到 DSH（两个插件分别装，路径用绝对路径）：

```
plugin_manager install_bundle target="link:<仓库绝对路径>/packages/video-table"
plugin_manager install_bundle target="link:<仓库绝对路径>/packages/video-brief"
```

装完重启 DSH；客户端 bundle 随页面加载，之后改客户端要刷新页面。

### 可选：浏览器路径

无头渲帧会自动找 Chrome / Edge 的常见安装位置（Windows / macOS / Linux）。装在非常规位置时：

```bash
DSH_VIDEO_HEADLESS_BROWSER=/path/to/chrome
```

---

## 音效库：仓库里为什么没有音频文件

**能直接用，只是没有内置音效。** `packages/sound-library/index.json` 是一份已经算好的声学索引（753 条：时长、衰减、频谱质心、亮度、材质倾向……），它按 `<根名>/<pack>/<相对路径>` 索引，不含任何本机绝对路径。

想要声音，一条命令：

```bash
npm run sounds:download          # 下载 Kenney 的 10 个 CC0 音效包
node packages/sound-library/scripts/download-sounds.mjs --list    # 先看清单
```

它会下载并解压到 `~/.dsh/sound-library/kenney/`，目录结构与索引**逐字对齐**，所以下完直接命中，**不需要再跑分析器**（那一步要 ffmpeg，753 个文件约半分钟）。

不下载也完全能用：本地搜索返回空列表并说明原因，Freesound 在线搜索（需自备 key）不受影响。

音频包来自 [Kenney](https://kenney.nl/assets/category:Audio)，CC0 1.0。我们不在仓库里重复分发这些二进制：它们本来就有稳定来源，而且 15 MB 的 ogg 会让每次 clone 变慢、让 diff 失去意义。索引才是这个仓库的产出。

Freesound 是可选能力，默认关闭，只从环境变量读 key，详见 [docs/freesound.md](docs/freesound.md)。

---

## 动效库

`packages/motion-lib/` 下每个目录是一张卡：

```
<id>/
├─ code.js     export function render(ctx, t, env)，必须是 t 的纯函数（可任意 seek）
├─ meta.json   标题、标签、来源、许可、参数、依赖素材
└─ SKILL.md    少数需要外部渲染器的卡才有
```

用法：把目录复制（或软链）到 `~/.dsh/motion-lib/`，或用环境变量 `DSH_MOTION_LIB` 指向它。工作台会扫描并列为原生动效，`video_motion_insert` 可直接插到时间线。

**许可**：66 张卡全部为可商用授权，逐条记录在 `meta.json` 的 `license` / `source` / `author`：

| 许可 | 张数 | 说明 |
|---|---:|---|
| Apache-2.0 | 48 | 上游移植，须保留版权与许可声明 |
| MIT | 14 | 上游移植，须保留版权与许可声明 |
| 本仓库原创 | 4 | 随根目录 MIT |

**本仓库不含任何非商用（Noncommercial）素材。** 曾有部分卡片来自非商用授权（PolyForm / Shotcraft），已全部排除、不随本仓库分发。

根目录的 MIT 只覆盖本仓库原创代码；第三方卡按各自许可再分发。汇总见 [packages/motion-lib/NOTICE.md](packages/motion-lib/NOTICE.md)，许可全文在 `packages/motion-lib/LICENSES/`。关于"为什么这样分许可"，见 [docs/licensing.md](docs/licensing.md)。

缩略图没有随仓库分发（`meta.json` 的 `thumb` 为 `null`）。需要预览图时用工作台的 `video_motion_list` / 渲染工具现场生成。

---

## 文档

| 文档 | 讲什么 |
|---|---|
| [docs/production-workflow.md](docs/production-workflow.md) | 一条片子从需求到导出的完整工序 |
| [docs/lease.md](docs/lease.md) | 写租约：多个 agent / 会话同时改一个工程时怎么不打架 |
| [docs/transition-host.md](docs/transition-host.md) | 转场宿主与合成 |
| [docs/code-layer-media.md](docs/code-layer-media.md) | 代码图层怎么拿媒体、怎么保证可 seek |
| [docs/playback-loop.md](docs/playback-loop.md) | 播放循环与掉帧排查 |
| [docs/headless-sampling.md](docs/headless-sampling.md) | 无头渲帧：agent 怎么「看」到画面 |
| [docs/camera-continuity.md](docs/camera-continuity.md) | 机位连续性检查 |
| [docs/motion-continuity.md](docs/motion-continuity.md) | 动效连续性：卡顿、跳变、位移 |
| [docs/audio-mix.md](docs/audio-mix.md) | 音频混音与音量包络 |
| [docs/sound-tags.md](docs/sound-tags.md) | 声学标签：每个字段怎么测出来的 |
| [docs/freesound.md](docs/freesound.md) | Freesound 接入：默认关闭、自备 key、遵守条款 |

---

## 测试

```bash
# 阶段机：完整、无外部依赖
npm test                       # = cd packages/video-brief && npm test

# 工作台：自包含的 Node 脚本，按需挑
node packages/video-table/scripts/smoke.mjs
node packages/video-table/scripts/route-test.mjs
node packages/video-table/scripts/media-test.mjs
node packages/video-table/scripts/undo-stack-test.mjs
```

`packages/video-table/scripts/` 里的测试大多用临时目录与桩对象，不碰你的真实工程；少数（ASR、TTS、音效分析、无头渲染）需要本机 ffmpeg / Python / Chromium，缺依赖时脚本会直接说明缺什么。

**没有随仓库发布的测试**：8 个围绕内部策展台账的脚本（配方卡批次、机制合并记录、性能基线、样张对比）。它们断言的是内部台账文件，不是产品行为；公开仓库不带台账，也就不带这些断言。其余测试全部保留。

---

## 演示

这个系统的核心体验在**动态**里：一句话改完，时间线当场变。静态截图说明不了多少，所以不放图。
装上之后自己开一个工程，两分钟能看出它和「生成一段 MP4」的工具差在哪。

<!--
发布者备忘（GitHub 不渲染这一段）：

想补图时，用 `显示工作台的技术文件夹/capture-ui.mjs` 截真实界面，
放到 docs/images/ ，把下面三行换成实际图片引用：

  ![工作台](docs/images/workbench.png)      工作台面板：时间线 + 预览 + 检查器
  ![agent 改片](docs/images/agent-edit.png)  对话里让 agent 改一个片段，面板同步变化
  ![动效库](docs/images/motion-lib.png)      动效库列表与一张卡的预览

原则：由发布者本人截真机界面，不用示意图、不用生成图凑数——读者一眼能看出真伪。
-->

---

## 许可

本仓库原创代码采用 MIT，见 [LICENSE](LICENSE)。第三方动效卡、音效素材各自保留原许可：动效卡的汇总见 [packages/motion-lib/NOTICE.md](packages/motion-lib/NOTICE.md)（其中 77 张为非商用授权），音效来自 Kenney（CC0）。

## 安全

请不要在 issue / PR 里贴 API key、cookie、工程文件里的私人路径。报告安全问题的方式见 [SECURITY.md](SECURITY.md)。
