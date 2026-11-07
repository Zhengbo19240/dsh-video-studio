# sound-library

音效的**声学索引** + 一个下载脚本。仓库里没有音频二进制。

## 里面有什么

```
index.json                  753 条声学测量值（相对路径）
scripts/download-sounds.mjs 从 kenney.nl 下载 CC0 音效包并解压
```

`index.json` 的 key 是 `<根名>/<pack>/<相对路径>`，例如：

```
kenney/ui-audio/Audio/click1.ogg
```

条目里没有本机绝对路径 —— `file` 字段同样是 `<根名>/<相对路径>`。换盘符、换用户名都不会让索引失效。

索引字段（时长、衰减、频谱质心、亮度、材质倾向……）都是**声学测量值**，不是听感结论。`materialGuess` 的 `Guess` 就是这个意思。每个字段怎么算，见仓库根目录 `docs/sound-tags.md`。

## 下载音效

```bash
node scripts/download-sounds.mjs --list        # 先看索引里有哪些包
node scripts/download-sounds.mjs               # 全部下载
node scripts/download-sounds.mjs --pack ui-audio
```

落点：`~/.dsh/sound-library/kenney/<pack>/`（可用 `DSH_SOUND_LIB` 改根目录）。目录结构与索引逐字对齐，**下完直接命中，不需要再跑分析器**。

脚本会：

1. 读 `index.json` 得出包清单与每个包应有的文件数；
2. 通过 kenney.nl 的两步下载（资源页 → 签名 zip）取包；
3. 解压前检查 zip 条目，拒绝绝对路径与 `..`；
4. 解压到对应目录，并把 `~/.dsh/sound-sources.json` 写成指向该目录（不存在才写）。

失败不会中断其它包：最后汇总哪些包没下成，并说明这些包在索引里的条目暂时不会命中。

## 不下载也能用

工作台照常启动。本地搜索返回空列表并说明「本地没有音频」；声学过滤会提示缺索引条目；Freesound 在线搜索（自备 key）不受影响。

## 授权

音频来自 [Kenney](https://kenney.nl/assets/category:Audio)，CC0 1.0（公共领域）。本仓库只分发索引与下载器；音频本身请从来源获取，并按 CC0 使用（CC0 不要求署名，但署名是好习惯）。
