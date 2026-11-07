# 第一次开源：发布前检查清单

这份清单只回答一件事：**把这堆文件推上去，别人点进来会不会觉得「这是个正经项目」。**
按顺序做，每一步都很短。

---

## 1. 仓库名

建议三个，按推荐顺序：

| 名字 | 好处 | 注意 |
|---|---|---|
| `dsh-video-suite` | 和 `package.json` 的 name 一致；「suite」暗示多个包 | 稍长，但对搜索友好 |
| `dsh-video-workbench` | 和插件 id 一致，老用户一眼认出 | 会让人以为仓库只有工作台 |
| `video-workbench-for-dsh` | 关键词清楚，不占 DSH 前缀 | 容易被当成 fork |

不推荐 `video-editor`、`ai-video` 这类大词：搜出来全是竞品，你的仓库会沉底。

## 2. Description（GitHub 右上角那一行）

一句话，写「给谁、解决什么」，不要写「基于 AI 的……」：

> Agent-native video workbench for DeepSeek Harness — timeline, transitions, motion cards and sound search share one project document.

中文可用：

> DeepSeek Harness 的视频工作台：时间线、转场、动效卡与音效检索共用同一份工程文档。

## 3. Topics

GitHub 的 topics 是搜索入口，填 6–8 个就够：

```
deepseek-harness  dsh-plugin  video-editing  agent  canvas  webcodecs  motion-graphics  mcp
```

不要填 `ai`、`video` 这种泛词 —— 它们不会带来有效流量。

## 4. LICENSE 为什么选 MIT

- 插件生态里 MIT 最常见，DSH 用户装之前不用想「商用要不要授权」；
- 它允许别人 fork、改、再发布，代价是你放弃追究「改了不说」；
- 如果你的目标是「被更多人用起来」，MIT 比 Apache-2.0 更省事（Apache 要求带 NOTICE、标注改动，很多人会漏）。

**但注意**：MIT 只覆盖你的原创代码。`packages/motion-lib` 里 66 张卡中有 77 张是 PolyForm Noncommercial（不可商用）、53 张 Apache-2.0、14 张 MIT；音效是 Kenney 的 CC0。这一点必须在 README 写清，否则等于替别人授权。仓库里已经写好汇总（`packages/motion-lib/NOTICE.md`）和许可全文（`LICENSES/`），**不要删掉它们**。

> 第一次开源最容易踩的坑：仓库写着 MIT，里面却混着非商用素材。别人商用之后被追责，找的是你。宁可把许可写复杂，也不要把 MIT 说成覆盖全仓库。

LICENSE 文件里的版权行现在是占位符，**推之前换成你的名字或 GitHub ID**（不用真名，ID 就行）。

## 5. README 该有哪几节

按这个顺序，缺一节都会让读者多问一句：

1. **一句话是什么** + 四个包的表格（名字 / 作用 / 版本）
2. **为什么这样设计**（工程文档只有一份）—— 这是你和其他方案的区别，别省
3. **快速开始**：clone → install → build → 装插件，四步以内
4. **可选依赖**：浏览器、ffmpeg、Python 各自怎么装、默认在哪
5. **音效库为什么没有音频**（见第 7 节）
6. **动效库与许可**：第三方卡逐条记录许可
7. **文档索引**：链到 `docs/`
8. **测试**：怎么跑、哪些需要外部依赖
9. **截图**：三张，别用生成的假图
10. **许可与安全**：LICENSE、SECURITY 的链接

## 6. Releases 要不要发

**第一个版本建议发。** 理由：

- `plugin_manager` / 用户习惯从 Releases 拿稳定版，而不是跟 main；
- tag 一打，别人引用你的版本时有锚点；
- 不用写 changelog 全文，把 `git log --oneline` 里用户能感知的几条抄过去就行。

版本号建议 `v0.1.0`，不必等「完美」再发 —— 0.x 本来就是「接口还会变」的声明。

## 7. 「开源源码但不开源音效二进制」怎么写才不显得小气

关键不是解释「我为什么不放」，而是**说明这样做对用户更好**。README 里已经这么写，原则是：

- 先说**能不能用**：不下载也能用，只是没有内置音效；下载后零解析成本。
- 再说**为什么**：音频是 CC0、有稳定来源，仓库里重复放 15MB 二进制只会让 clone 变慢、diff 失真；索引才是这个仓库的产出。
- 最后给**一条命令**：`npm run sounds:download`。有替代路径的「不提供」叫设计；没有替代路径的「不提供」才叫小气。

同样的写法适用于任何大二进制：**给获取方式，而不是给文件。**

## 8. Issue 模板要不要

第一版**建议只开两种**：

- `bug_report.md`：DSH 版本、插件版本、复现步骤、期望 / 实际、日志片段（提醒脱敏）。
- `feature_request.md`：想解决什么问题，而不是「加个功能」。

不要一上来搞五六个模板和 Discussions —— 没人填，反而显得空。

`SECURITY.md` 已经写了「不要公开 issue 报安全问题」，GitHub 的私有漏洞报告打开即可。

## 9. 第一次提交的命令

在 `开源/` 目录里执行（仓库名按第 1 节选一个）：

```bash
cd 开源
git init
git add .
git status            # 先看一眼：确认没有 node_modules、.build、音视频、密钥
git commit -m "chore: initial import of dsh-video-suite"
git branch -M main
git remote add origin https://github.com/Zhengbo19240/dsh-video-studio.git
git push -u origin main
```

推之前再跑一次仓库根目录的检查（也可以直接看 `git status` 里有没有意外文件）：

```bash
# 不该出现在暂存区的路径
git ls-files | grep -E "node_modules|\.build|\.dsh-video|\.mp4$|\.png$|\.ogg$"

# 不该出现的本机路径 / 密钥
git grep -nE "C:\\\\Users|/Users/|api_key|secret|token" -- . ':!*.md'
```

（`grep` 在 Windows PowerShell 里用 `Select-String`；上面只是示意。）

## 10. 推完之后

- 到 Settings → General 确认 Description / Topics 已填；
- 到 Settings → Security 打开「Private vulnerability reporting」；
- 新建一个 `v0.1.0` Release，正文写「首个公开版本：工作台 + 阶段机 + 66 张动效卡 + 音效索引」；
- 把 README 里的 `<本仓库地址>` 占位替换成真实地址；
- 补三张截图（`docs/images/`）。

---

## 附：这个仓库现在**没有**的东西（别在发布时误承诺）

- 没有 CI 配置（测试是本地脚本，不是 GitHub Actions）；
- 没有 npm 发布（`private: true`，装法是 `link:` 本地路径）；
- 没有示例工程（`.dsh-video` 是运行产物，按设计不入库）；
- 没有音效与缩略图二进制（见第 7 节）。
