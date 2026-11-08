# 提交到 dsh-market（市场）的步骤

市场是**索引仓库**：投稿只改市场的仓库，不改这里的仓库。合并后市场的 CI 自动重生成 README 与页面。

## 先说清一个前提

本仓库**没有发布到 npm**，而市场按「包名」安装。所以：

```
投了 PR 之后：市场上会出现这个项目（能被看到、被搜到）
但用户点「安装」会失败：dsh-video-suite 在 npm 上不存在
```

如果你不能接受「点了装不上」，就**先别投**，等哪天发了 npm 再投。这份文档只是把该做的事写好，不催你投。

## 投稿文件

在 dsh-market 仓库里新建一个文件：

```
data/plugins/Zhengbo19240__dsh-video-studio.yml
```

内容：

```yaml
name: dsh-video-suite
repo: Zhengbo19240/dsh-video-studio
category: workflow
description: DSH 视频工作台：面板 + 阶段机 + 可被 agent 调用的剪辑工具，工程文档由对话与界面共用
```

字段说明：

| 字段 | 值 | 为什么 |
|---|---|---|
| `name` | `dsh-video-suite` | 与根 `package.json` 的 name 一致 |
| `repo` | `Zhengbo19240/dsh-video-studio` | 不带 `https://`、不带 `.git` |
| `category` | `workflow` | 它是「一段工序」而不是单个工具；也可用 `tools` |
| `description` | 只说功能 | 市场要求不带营销词（「强大」「最好」这类） |

## 提交步骤

1. Fork `dsh-market` 仓库
2. 在 fork 里新建上面的 yml
3. 提交 PR，标题写 `Add dsh-video-suite`
4. 等 CI 检查：仓库存在、`dsh.bundle` 已声明、有 `dsh-plugin` topic、仓库满 1 天

## 准入条件自查（当前状态）

```
dsh.bundle 在根 package.json      ✓
仓库创建超过 1 天                  ✓（2026-11-07 创建）
description 无营销词               ✓
dsh-plugin topic                  ✓（在 GitHub 仓库 About 里已加）
有 LICENSE                        ✓ MIT
README 有安装与验证步骤            ✓
不含非商用素材                     ✓（82 张已排除）
```

## 什么时候该改这份文档

发了 npm 之后，把开头「先说清一个前提」整段删掉，并补一句：

```
npm 包：dsh-video-suite / dsh-video-workbench / dsh-video-brief / dsh-video-preset
安装：dsh plugin --profile desktop add dsh-video-suite
```
