# 音效声学标签

给本地音效库补一组**可测量**的标签，让「我要一个硬一点的开关声」这类模糊需求能落到候选上。

一句话定死口径：**这里全部是物理测量值，不是听感结论。** 标签回答的是「这个文件长什么样」，
不是「这个声音像什么材质」。`materialGuess` 里的 `Guess` 就是这个意思 —— 字段名不许改成 `material`。

- 生成：`node tools/analyze-sounds.mjs`（默认写 `~/.dsh/sound-index.json`）
- 读取与过滤：`src/sound-index.mjs`
- 接入检索：`video_sound_search` 的 `shape` / `brightness` / `material` / `maxDurationMs`
- 测试：`node scripts/sound-tags-test.mjs`（21 条，全部现场合成音频、真的跑一遍测量）

---

## 1. 怎么跑

```bash
node tools/analyze-sounds.mjs                 # 增量：按 size+mtime 指纹跳过没变的
node tools/analyze-sounds.mjs --force         # 全量重算
node tools/analyze-sounds.mjs --root ~/.dsh/sound-library\kenney --out D:\tmp\idx.json
node tools/analyze-sounds.mjs --concurrency 8 --json --quiet
```

| 参数 | 作用 |
|---|---|
| `--force` | 忽略指纹，全部重算 |
| `--root <目录>` | 只扫这一个根（等同临时设 `DSH_SOUND_LIB`） |
| `--out <文件>` | 索引写到别处（等同 `DSH_SOUND_INDEX`） |
| `--concurrency N` | 同时跑几个 ffmpeg，默认 4 |
| `--json` | 最后打印一行机器可读的汇总 |
| `--quiet` | 不打印进度 |

ffmpeg / ffprobe 的查找顺序：`DSH_FFMPEG_PATH` / `DSH_FFPROBE_PATH` → `DSH_ASR_ROOT\ffmpeg\bin\`
（默认 `~/.dsh/video-deps`）→ PATH。找不到会直接说缺哪个，不会安静地写一个空索引。

实测：本机 Kenney 整包 753 个 ogg、15.5 MB，6 并发约 27 秒跑完，0 失败。

---

## 2. 索引文件

`~/.dsh/sound-index.json`：

```json
{
  "generatedAt": "2026-11-06T05:29:44.803Z",
  "analyzer": "ffmpeg+自算",
  "caveat": "标签由声学测量得出（ffmpeg 频谱统计 + PCM 包络/过零/自相关），不是听感结论；实际音色请试听确认。",
  "version": 1,
  "file": "~\\.dsh\\sound-index.json",
  "total": 753,
  "items": {
    "kenney/ui-audio/Audio/click1.ogg": {
      "root": "kenney",
      "providerId": "ui-audio/Audio/click1.ogg",
      "file": "~\\.dsh\\sound-library\\kenney\\ui-audio\\Audio\\click1.ogg",
      "size": 4396, "mtimeMs": 1756012345678, "fingerprint": "4396:1756012345678",
      "durationMs": 94, "attackMs": 0, "decayMs": 49.9, "shape": "短促",
      "centroidHz": 4221, "brightness": "亮",
      "noisiness": "混合", "pitchiness": "无音高",
      "materialGuess": "金属倾向",
      "zcrPerSec": 4126, "flatness": 0.1567, "f0Hz": 1102.5, "autocorr": 0.491,
      "peakDbfs": -16.4, "frameCount": 20,
      "silent": false, "tooShort": false, "decayComplete": true, "truncated": false,
      "analyzedAt": "2026-11-06T05:29:12.101Z"
    }
  },
  "errors": []
}
```

- **key** = `<根名>/<packId>/<相对路径>`（正斜杠）。不用绝对路径：换盘符、换用户名都不会让整库索引失效。
  同一物理文件被两个根收录时会得到两个 key —— 这是有意的，两个根的 id 本来就不同。
- `fingerprint` = `size:mtimeMs`。指纹一致就跳过；`--force` 才重算。
- **单文件失败不中断**：错误进 `errors[]`（`{key, file, code, message}`），其它文件照常入库；
  失败的文件不会在 `items` 里留下旧数据（避免拿过期结果当现况）。
- 写盘是「临时文件 + rename」，中途被杀不会留下半个 JSON。

`zcrPerSec` / `flatness` / `f0Hz` / `autocorr` / `peakDbfs` / `frameCount` 是**中间量，只留在索引里**，
检索返回时被裁掉（`measured` 只给 5 个字段）—— 免得中间量被当成结论引用。

---

## 3. 每个维度怎么算

### durationMs

`ffprobe -show_entries format=duration`，四舍五入到毫秒。ffprobe 读不出来时退回
「解码出的采样数 / 44100」，并在语义上仍是实测时长（不是估算）。`truncated:true` 表示文件长于
180 秒，只分析了前 180 秒（其余字段都基于这段）。

### attackMs — 起音时间

1. 用 6ms 窗、2ms 跳步算 RMS 包络。
2. `onset` = 首次达到峰值 5% 的帧；`t95` = 首次达到峰值 95% 的帧。
3. `attackMs = (t95 − onset) × 2ms`。

口径说明：规格写的是「包络到峰值的时间」，实现用的是**到 95% 峰值**。原因是稳态信号
（纯音、噪声）逐帧 RMS 会因窗长不整除周期而抖动 1%~4%，真正的「最大值帧」落在哪基本看相位，
直接取 argmax 会算出几百毫秒的假 attack。95% 这个口径对瞬态（一击、点击）与真峰值几乎重合，
对稳态信号才稳定。

**局限**：长素材（几十秒的合集、预览串烧）的「最响点」可能在很后面，此时 `attackMs` 会等于
「到最响时刻的时间」，没有起音含义；这类文件请配合 `durationMs` 一起看。

### decayMs — 衰减时间

1. 把包络按**功率**做 50ms 滑动平均再开方，得到平滑包络。
2. `peakIdx` = 平滑包络首次达到最大值 99% 的帧（同样是为了避开 argmax 抖动）。
3. `decayMs` = `peakIdx` → 首次跌回最大值 10%（−20 dB）的帧。

`decayComplete:false` 表示**整段都没跌到 −20 dB**，此时 `decayMs` 只是「到文件尾还剩多久」，
不是真衰减。稳态持续音（引擎循环、环境底噪）都会落到这一类。

为什么要 50ms 平滑：6ms 窗盖不住低频周期（78 Hz 的引擎声一个周期 12.8 ms），不平滑时包络会跟着
基频起伏、在两次脉冲之间掉到接近 0 —— 于是「5 秒的引擎循环」被测成 `decay=30ms` 的「短促」。
这是实测踩到的坑，平滑后才对。

### shape — 形状

| 取值 | 判据 |
|---|---|
| `短促` | `decayMs < 150`，或 `tooShort`（`durationMs < 40`） |
| `中` | `150 ≤ decayMs ≤ 500` |
| `拖尾` | `decayMs > 500` |

两条特判：

- **tooShort**：短于 40ms 的样本，`decayMs` 会落在包络分辨率（±2ms）与平滑窗（50ms）里，
  数字不可信，一律记 `短促` 并标 `tooShort:true`。
- **峰值落在结尾**：`decayComplete:false` 且峰值出现在最后 100ms 内、时长又 ≥1 秒时，
  从峰值算出来的 decay 会接近 0，把一段持续音错标成「短促」。这种样本按整体时长记 `拖尾`。

### centroidHz — 频谱质心

`ffmpeg -af "aspectralstats=measure=centroid+flatness,astats=metadata=1:reset=1,ametadata=..."`，
逐帧取 `centroid`，**只统计能量在最响帧 −40 dB 以内的帧**，取算术平均。

不做能量门限的话，一段 3 秒点击后面跟 2.8 秒静音，质心会被静音帧（ffmpeg 给 0）硬拉到接近 0 ——
那就不叫质心了。

**局限**（重要）：

1. **单声道混响**：`-ac 1` 下混 + 40 dB 门限后，混响尾巴（往往低频更多）仍会计入前几帧；
   混响重的样本质心偏低。
2. **门限是相对的**：整段都很轻的样本会被自己的 −40 dB 门限放大噪声帧的影响。
3. 质心是**能量加权**的，不是「主频」：一个 100 Hz 基频 + 很强的高频泛音，质心可能远高于 100 Hz。
4. 8 kHz 以上的成分在 44.1 kHz 采样下仍计入，但 ffmpeg 的 FFT 窗（2048）决定分辨率约 21.5 Hz。

### brightness — 亮度

`centroidHz < 800` → `暗`；`800..2500` → `中`；`> 2500` → `亮`。

阈值来自规格（不是从这批素材拟合的），所以在本机 Kenney 库上分布会偏亮（753 条里 401 条 `亮`）——
那是这批素材本身偏高频，不是分类器坏了。

### noisiness — 噪声性

主判据是**频谱平坦度**（`flatness`，逐帧均值，同样过 40 dB 门限）：

| 取值 | 判据 |
|---|---|
| `噪声性` | `flatness ≥ 0.30` |
| `乐音性` | `flatness ≤ 0.08`，且归一化过零率 < 0.42 |
| `混合` | 其余 |

过零率只在两端兜底，不当主判据：8 kHz 纯音的过零率也有 0.36 次/采样（约 16k 次/秒），
单看过零会把高音纯音判成噪声。

**局限**：宽带一击（军鼓、玻璃碎）平坦度常落在 0.2~0.4，正好在阈值附近，同一份素材里相邻样本
可能一个判 `混合`、一个判 `噪声性`。这是连续量被离散化的必然损失，不是 bug。

### pitchiness — 是否有音高

1. 4 倍降采样（44.1 kHz → 11.025 kHz）后做归一化自相关，只扫 45 Hz..2 kHz 的 lag。
2. 要求自相关先跌到 0.5 以下（出现「谷」），再在谷之后找峰 —— 单调衰减的包络
   （一击、指数衰减）不会出现谷，因此不会报假基频。
3. 峰 > 0.55 记 `有音高`，同时给出 `f0Hz`（基频估计）。
4. 倍频防御：取「第一个 ≥90% 最大峰值的局部极大」的 lag，基频优先于它的整数倍。

**局限**：

1. **只能报 45 Hz~2 kHz**。真实基频高于 2 kHz 的信号会被折到低八度或次谐波上，
   `f0Hz` 会明显偏小（实测：8 kHz 纯音报成 1002 Hz）。
2. 降采样用的是 4 点盒式滤波，抗混叠很弱；8 kHz 附近会有镜像成分。
3. 强混响、噪声里的窄带共振都会让自相关出现峰 —— `噪声性 + 有音高` 同时出现不是矛盾，
   而是「宽带噪声 + 一个共振峰」，两个维度各自独立测量，不要交叉硬凑解释。
4. 极短样本（<40ms）的自相关样本数太少，结论不要当真。

### materialGuess — 材质倾向（经验映射）

按下面的顺序判，**先命中先返回**：

| 顺序 | 条件 | 结果 |
|---|---|---|
| 1 | `亮` 且 非 `噪声性` | `金属倾向` |
| 2 | `中` 且 `噪声性` | `塑料倾向` |
| 3 | `中` 且 `短促` | `木质倾向` |
| 4 | `乐音性` 且 `有音高` 且非 `短促` | `合成倾向` |
| 5 | 其余（含静音、`亮 + 噪声性`） | `不确定` |

顺序本身是一种取舍：`亮 + 噪声性` 的样本落到 `不确定`，而不是硬塞进 `金属` ——
宽频噪声里的材质信息本来就不可靠。

**已知的误判（实测，必须知道）**：

- **语音 / 音乐 / 长环境音上这个字段基本没有意义。** 人声的质心常在 2.8~3.7 kHz（判 `亮`）、
  平坦度低（判 `乐音性`）、自相关高（判 `有音高`），于是整批 voiceover 都落进 `金属倾向`。
  753 条里有 341 条 `金属倾向`，其中 113 条来自 142 条语音。142 条语音里只有 29 条没被标成金属。
  把这个字段当「材质线索的排序提示」，不要当「这个声音是金属做的」。
- **在本机 Kenney 库上，木质 / 金属这两支几乎是反的。** 拿包名当弱标签对账（`impactWood_*` 15 条、
  `impactMetal_*` 20 条、`impactPlank_*` 5 条）：

  | 包 | 测量结果 |
  |---|---|
  | `impactWood_*` 15 条 | `不确定` 15 / `木质倾向` 0 |
  | `impactMetal_*` 20 条 | `木质倾向` 12 / `金属倾向` 3 / `不确定` 5 |
  | `impactPlank_*` 5 条 | `木质倾向` 4 / `不确定` 1 |

  原因是两边的频谱走向跟「直觉上的材质」相反：Kenney 的木头重击是一记 60~200 Hz 的闷响
  （质心 <800 → `暗` → 规则 1~3 全部不命中 → `不确定`），而金属撞击录进了中频主体
  （质心 1~2 kHz → `中`）+ 收得快 → `木质倾向`。也就是说：**`materialGuess` 现在测的是
  「亮/中 + 快/慢 + 噪/纯」的坐标，不是材质。** 当「排序提示」勉强能用，当筛选条件会筛错。
  真要按材质筛，得换成「起音后的谱倾斜 / 泛音比」这类更针对材质的特征，而不是复用质心。
- **`塑料倾向` 在整库里 0 条。** 「中频 + 噪声性」这个格子在本机素材里没有落点 ——
  中频的东西要么平坦度低（乐音性），要么质心被推到 2.5 kHz 以上（亮）。
- 低频重击（`impactSoft`）质心只有 95~200 Hz、`乐音性`、`暗`，会落到 `不确定` ——
  它听起来确实很「闷」，但从频谱上分不出材质，这个 `不确定` 是对的。
- 一段素材里叠了多种声音（预览串烧）时，所有维度都是「平均值的平均」，结论不指向任何单个事件。

---

## 4. 接进检索

`video_sound_search` 新增四个可选参数（只作用于本地库；Freesound 结果没有测量数据）：

| 参数 | 取值 | 说明 |
|---|---|---|
| `shape` | `短促` / `中` / `拖尾` | 按衰减形状 |
| `brightness` | `暗` / `中` / `亮` | 按质心 |
| `material` | `金属倾向` / `木质倾向` / `塑料倾向` / `合成倾向` | 入参叫 `material`，落到测量值永远是 `materialGuess` |
| `maxDurationMs` | 数值 | 按测量时长（毫秒） |

命中的本地条目会多出：

```json
{
  "measured": { "shape": "短促", "brightness": "亮", "materialGuess": "金属倾向",
                "centroidHz": 4221, "decayMs": 49.9 },
  "measuredCaveat": "标签由声学测量得出（…），不是听感结论；实际音色请试听确认。"
}
```

结果顶层也有同一条 `measuredCaveat`。

**语义约定**：

- 只要指定了任一测量维度，**只保留有测量数据的条目**。没有测量数据的条目不会被「放行」——
  把「没测」当成「符合」正是要避免的事。
- 本地还没有索引时，测量过滤返回 0 条 + 一条 `NO_MEASURED_INDEX` 的 warning，并给出索引路径。
  宁可如实说「还没测」，也不返回一个看着像结果的假空。
- 拼错的枚举值直接抛 `INVALID_ARG`，不静默返回空。
- `source=freesound` 但带了测量过滤时，给一条 `MEASURED_LOCAL_ONLY` 的 warning。

RPC `sound.search` 的字段是客户端契约，本次没有扩它 —— 新参数只走 agent 工具。

---

## 5. 调参指引

阈值都集中在 `tools/analyze-sounds.mjs` 顶部，改完请重跑 `--force`：

```js
SHAPE_THRESHOLDS      = { 短促: 150, 拖尾: 500 }   // ms
BRIGHTNESS_THRESHOLDS = { 暗: 800, 亮: 2500 }      // Hz
FLATNESS_THRESHOLDS   = { 噪声性: 0.3, 乐音性: 0.08 }
PITCH_THRESHOLD       = 0.55
FRAME_GATE_DB         = 40
TOO_SHORT_MS          = 40
SMOOTH_MS             = 50
```

改阈值会让**旧索引立刻变成另一套口径**：`fingerprint` 只认文件有没有变，不认分析器版本变了。
生产上换阈值要 `--force` 重跑一次（或者先删掉 `sound-index.json`）。

---

## 6. 音频链路的四条硬约定

这四条来自真实事故（一次 1 分 38 秒的片子，agent 因为音效工具「用不了 / 不够用」，
最后自己 `Invoke-WebRequest` 下 mp3，成片和工作台彻底分家）。改这里之前先读代码注释。

### 6.1 多词查询会自动降级

关键词是 **AND** 语义：`minimal corporate ambient pulse` 一条都不命中，而 `corporate` 有 10 条。
所以多词查询 0 结果时会自动换词再试，顺序固定、最多 3 次：

1. 去掉最不常见的词（用本地库命中数当语料；没有语料时按「越长越罕见」近似）
2. 取最长的词
3. 取第一个词

命中时返回：

```json
{ "degraded": true, "degradedQuery": "corporate",
  "warnings": [{ "code": "QUERY_DEGRADED", "message": "原查询「…」无结果，已降价为「corporate」" }] }
```

- `degraded` / `degradedQuery` **永远存在**（没降级时是 `false` / `null`），形状稳定，调用方不用判键在不在。
- 三次都空 → 正常返回 0 条 + `degraded:false`，另给一条 `DEGRADE_EXHAUSTED` 说明「这是真的没有」。
  **降级不会把真 0 结果伪装成降级过还是没有。**
- 两种情况不降级：带测量过滤（0 条是过滤器造成的，换词会把「没测」和「没词」混成一件事）、
  在线源自己出错（网络 / 没 key 不是词的问题）。

### 6.2 时长维度：minDuration

`video_sound_search` 的 `minDuration`（秒）与 `maxDuration` 共存，两者都给时校验 `min ≤ max`，
否则 `INVALID_ARG`（不会拼出一个必然为空的过滤器）。

- **在线**：拼成 `filter=duration:[min TO max]`；只给下限时上限写 `*`，只给上限时下限写 0。
- **本地**：按条目时长过滤。**下限存在时时长未知的条目会被排除**，并给一条
  `DURATION_UNKNOWN`（说清排除了几条）。理由：拿 0.05 秒的点击声去凑 60 秒的 BGM 比空结果更糟；
  只给上限时未知时长仍放行（不能证明超限就不排除，沿用旧语义）。
- `loopable`：在线条目按 Freesound 的 `loop` 标签给 `true/false` —— `false` 只表示**没打这个标签**，
  不代表技术上不能循环；本地库没有这类元数据，一律 `null`（不猜）。

### 6.3 video_sound_fetch：只拿文件，不进时间线

`video_sound_insert` 只认「当前工程的时间线」，而成片在离线 ffmpeg 里拼的时候无处安放，
于是就有了「自己下 mp3」。现在有出口：

- 落点统一是 `<工程根>/assets/sfx/<原名>`（与时间线素材 `assets/` 分开，人一眼能找到）。
- 重名依次 `-1`、`-2`；写之前先比「同大小 + sha256 前 8 位」——同一份内容**复用已有文件**，不堆副本。
- 返回 `{ localPath, relPath, name, bytes, durationMs, source, reused }`。
- **不插片段、不改 doc（revision / clips / assets 不变）、不占租约**：它只写文件。
- 失败是带 code 的可读错误：`DOWNLOAD_FAILED`（下载失败 / 超过 20MB 上限）、
  `NOT_FOUND`（本地条目不存在 / 在线条目没搜过所以缓存里没有）、`IO_FAILED`（写盘失败）。

### 6.4 所有 video_sound_* 返回体必须是 lossless JSON

工具层会拒收「非无损 JSON」的返回值（`value is not lossless JSON`），而调用方看不到
「哪个键坏了」——上一次它被理解成「音效库不可用」，agent 直接绕开了整个库。

- 清洗工具：`src/json-safe.mjs` 的 `sanitizeJson()`（递归删 undefined 键、NaN/±Infinity → null、
  Date → ISO、环引用 → `"[Circular]"`）。
- 落点：`video_sound_*` 的 `define()` 统一在 `execute` 外层过一遍；核心函数
  `searchSounds` / `fetchSound` 自己也会过一遍（RPC 与直接调用的路径同样干净）。
- 测试里用 `scanLossy()` 深扫 + JSON 往返等价做断言，**含各条错误分支**
  （`scripts/sound-chain-test.mjs`）。

---

## 7. 这份东西不做什么

- 不做「像不像金属」的判断，只给概率线索（而且用 `Guess` 标着）。
- 不比对人耳听感，不做主观评分。
- 不改动音效文件本身，不重采样、不写 sidecar。
- 不分析 Freesound 在线结果（需要下载，成本与授权都不合适）。
