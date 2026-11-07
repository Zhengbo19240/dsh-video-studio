# 音量、淡入淡出与导出峰值

这份文档回答四件事：片段上的音量字段怎么解释、怎么改、预览与导出各做了什么、以及老工程要不要迁移。

对应实现：`src/domain.mjs`（模型与命令）、`src/audio-mix.mjs`（唯一的增益/峰值数学）、
`src/client/audio.js`（预览与离线混音）、`src/client/exporter.js`（导出音轨）、
`src/audio-mix-tool.mjs`（`video_audio_mix` 报告）。

## 1. 片段模型

音频轨（`a1` / `a2` / …，`track.kind === 'audio'`）上的片段多四个字段：

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `volume` | number | `1` | 线性增益，合法区间 `0..2`。`0.5` = 约 -6 dB，`0` = 静音 |
| `fadeIn` | number（秒） | `0` | 从片段起点线性升到 `volume` 的时长 |
| `fadeOut` | number（秒） | `0` | 从 `volume` 线性降到 0 的时长 |
| `muted` | boolean | `false` | 整段静音（等价 `volume: 0`，但保留原音量值） |

约束：

- `fadeIn + fadeOut` 不得超过片段时长。写入时超了直接报错（不静默夹紧）；
  只有「淡入淡出之和超过时长」这一种历史遗留情况在**读取/播放**时按比例压缩（见第 2 节）。
- 视频轨上的片段带这些字段不报错，但播放与导出都**忽略**它们。写入路径（`clip.setAudio` /
  `clip.update` / `clip.set_property`）在非音频轨上一律拒绝 —— 免得「设了却没生效」。
- 老片段没有这些字段时按默认值解释（`volume = 1`、淡入淡出 0、不静音），不需要迁移。

`clip.split` 会把跨切点的淡入淡出清掉：左半 `fadeOut = 0`、右半 `fadeIn = 0`，再按新时长收敛。
`clip.trim` 裁短片段后，淡入淡出按比例压到放得下。

## 2. 曲线：线性（唯一选择）

选**线性**，不是等功率。理由：

1. 与 WebAudio 的 `linearRampToValueAtTime` 逐点一致，预览、离线混音、导出可以共用同一份断点，
   不会出现「测试过的曲线」和「播放用的曲线」分叉；
2. 等功率适合两条素材交叉淡化（constant-power crossfade），不适合单片段的首尾包络 ——
   单片段用等功率会让中段出现 +3 dB 的隆起，听感反而更怪。

断点由 `src/audio-mix.mjs` 的 `clipGainPoints(duration, {volume, fadeIn, fadeOut, muted})` 生成：

- 无淡入淡出：`[{t:0, v:volume}]`（常量）；
- 有淡入：`{t:0, v:0} → {t:fadeIn, v:volume}`；
- 有淡出：`{t:duration-fadeOut, v:volume} → {t:duration, v:0}`；
- `muted: true`：`[{t:0, v:0}]`；
- `fadeIn + fadeOut > duration`：两者等比缩小到正好铺满，首尾仍是 0、中段仍是 `volume`
  （短素材也有完整的进出，不互相吃掉）。

`gainAtPoints(points, t)` 在断点之间线性插值；`clipGainEnvelope` 按采样率展开成 Float32Array，
供 `video_audio_mix` 估算有效峰值。

## 3. 命令层

### 3.1 `clip.setAudio`（推荐）

```json
{ "type": "clip.setAudio", "clipId": "snd_abc", "volume": 0.4, "fadeIn": 0.2, "fadeOut": 0.5, "muted": false }
```

- `volume` 必须是 number 且落在 `0..2`。越界抛 `INVALID_ARG`，**不夹紧**：
  写 3 是意图不明，静默变成 2 会让「为什么还是太响」变得无解。
- `muted` 必须是 boolean。
- `fadeIn` / `fadeOut` 必须是 ≥ 0 的 number，且之和 ≤ 片段时长。
- 至少给一个字段，否则 `INVALID_ARG`。
- `clipId` 必须存在且属于音频轨，否则 `REF_NOT_FOUND` / `INVALID_OP`。
- 返回的 diff 里每个被改的字段都是 `{ before, after }`；老片段缺字段时 `before` 按默认值给
  （例如 `{ before: 1, after: 0.4 }`），不会出现 `undefined`。

### 3.2 `clip.update`（兼容别名）

`clip.update` 就是 `clip.setAudio` 的别名，只接受 `clipId` + `volume` / `muted` / `fadeIn` / `fadeOut`。

- 用在这些字段上：行为与 `clip.setAudio` 完全一致。
- 用在其它字段（`start` / `duration` / `text` / `style` / `opacity` …）：
  抛 `INVALID_ARG`，消息固定为
  `clip.update 只支持音视频片段的 volume/muted/fadeIn/fadeOut；不支持的字段: <字段名>`，
  并在 `details.supported` 里列出支持的四个字段。**不做半套映射** ——
  免得调用方以为通用的「更新片段」被支持了。
- 用在视频轨片段上：抛 `INVALID_OP`，消息说明该片段不在音频轨。

### 3.3 `clip.set_property`（面板与旧调用仍在用）

`property` 为 `volume` / `fadeIn` / `fadeOut` / `muted` 时走与 `clip.setAudio` 相同的校验；
`audioRole` / `style` / `speed` 的行为不变。

旧的 `clip.set_property {property:'volume', value:4}` 这种越界写法现在会被拒绝 ——
这是有意的：`volume` 的合法区间已经从「实际没检查」收敛到 `0..2`。

### 3.4 `video_sound_insert`

新增三个参数，直接写进新片段，省掉一次编辑事务：

| 参数 | 默认 | 说明 |
|---|---|---|
| `volume` | `1` | 0..2；配乐建议 0.3–0.5 |
| `fadeIn` | `0.05` | 秒；与 `fadeOut` 之和不能超过片段时长 |
| `fadeOut` | `0.15` | 秒 |

返回 `clipId / assetId / revision / volume / fadeIn / fadeOut`。
校验失败时事务整体回滚，刚写进 `assets/` 的文件也会被清掉。

## 4. 播放与导出

### 4.1 增益链（预览 = 导出）

`src/client/audio.js` 对每个片段串一条 GainNode 链：

```
source → 片段增益（volume + fadeIn/fadeOut）→ 响度归一（仅 music/sfx）→ ducking（仅 music）→ master → 目的地
```

- 预览与导出的**离线混音**走同一个 `scheduleSegment` / `mixdown`，断点按时间铺，不按采样铺；
  两条路径使用的增益曲线逐点相同。
- 因此 `volume` 是**人声回避之前**的增益：`volume = 0.5` 的音乐片段仍会被 ducking 再压 -12 dB，
  叠加后约 -18 dB。这是有意为之 —— 音量是编曲决定，ducking 是混音纪律，两者独立。
- `muted` 的片段在调度前就被过滤，不产生任何节点。

### 4.2 导出峰值：整体压到 0.99，并如实报告

`src/client/exporter.js` 的 `prepareAudio` 在编码前量**导出区间**的峰值
（按源采样率取窗口，双声道取绝对值最大）：

- 峰值 ≤ `EXPORT_PEAK_CEILING`（`0.99`）：原样送编码器；
- 峰值 > `0.99`：整体乘一个常数增益 `0.99 / peak`，再送编码器。

为什么选「压」而不是「只提示」：

1. 编码器（AAC / Opus）对 `|sample| > 1` 只能截断，截断是失真，而且发生在用户看不到的阶段；
2. 整体乘常数不改变任何相对平衡（口播 / 配乐 / 音效的比例不变），只把总电平降一点；
3. 只提示不解决 —— 用户导出完才发现爆音已经来不及，而「重导一次」要再等几分钟。
4. 压了多少不藏着：结果里写 `audioPeak`（压之前）、`audioPeakAfterTrim`、`audioTrimDb`，
   并把 `audioWarning` 置为 `AUDIO_PEAK_TRIMMED`。

`audioPeak` 按**导出区间**扫描（只反映这次导出的这段），`audioLufs` 则是整条音轨的诊断值、不随 `range` 裁剪。两者都不要当作「成片响度」去对标准表。

预览不做这个压缩：监听时要听到真实的过载，否则用户永远不知道混音已经爆了。

## 5. `video_audio_mix`（只读）

`video_audio_mix({ projectId? })` 返回一份 JSON 报告，不改工程、不占写租约：

```json
{
  "projectId": "vp_…", "root": "…", "revision": 12, "duration": 42.5,
  "convention": { "peakUnit": "线性 0..1（1 = 满幅）", "curve": "linear", "…": "…" },
  "audioTracks": [{ "trackId": "a1", "name": "音频", "muted": false, "clipCount": 2 }],
  "clips": [{
    "clipId": "snd_abc", "trackId": "a1", "assetId": "asset_…", "asset": "assets/sfx/x.wav",
    "start": 0, "duration": 30, "sourceIn": 0, "speed": 1,
    "audioRole": "music", "volume": 0.4, "muted": false, "fadeIn": 0.05, "fadeOut": 0.15,
    "sourcePeak": 0.71, "effectivePeak": 0.284, "effectivePeakDb": -10.9,
    "peakStatus": "measured", "peakMethod": "wav-pcm", "unknownReason": null
  }],
  "overlaps": [{ "musicClipId": "snd_abc", "voiceClipId": "tts_…", "start": 3, "end": 8,
                 "duration": 5, "approxMarginDb": -2.1 }],
  "warnings": [{ "code": "ESTIMATE_NOT_BUS", "message": "…" }]
}
```

峰值只有两种来源：

| `peakMethod` | 含义 | 精度 |
|---|---|---|
| `wav-pcm` | 纯 JS 解 WAV（PCM 8/16/24/32、float32），按片段源窗口 × 音量包络逐样本取最大 | 准（含淡入淡出、静音、`sourceIn`、`speed`） |
| `ffmpeg-volumedetect` | `ffmpeg -af volumedetect` 量整段素材峰值，再乘 `volume` | 近似（不含淡入淡出、ducking、归一） |

两条都拿不到（素材缺失、格式不认识、没有 ffmpeg）：`peakStatus = "unknown"`、`peak` 为 `null`、
`unknownReason` 写清原因。**不会填一个猜的数字。**

`effectivePeak` 是「片段 × 音量」的估计，不是混音总线：ducking、响度归一、多片段叠加都不在里面。
`overlaps[].approxMarginDb` 只表示量级（配乐比口播高/低多少 dB），用来判断「是不是明显盖住」，
不要当实测。报告里 `warnings` 会明确写出这两条注意事项。

典型用法：

```
video_audio_mix → 看到 music 片段 effectivePeak 0.5、voice 0.3
→ video_edit_preview [{type:'clip.setAudio', clipId:'snd_abc', volume:0.3}]
→ video_edit_apply
→ video_audio_mix 复查
```

## 6. 老工程要不要迁移

**不需要改文件。** 缺省字段按默认值解释，行为与之前完全一致（volume 1 / 无淡入淡出 / 不静音）。

需要「迁移」的只有两种情况，而且都是**按需**、只动被点名的片段：

1. **响度不合预期**（配乐盖口播）：不是数据迁移，是内容调整。先 `video_audio_mix` 找出口播与配乐
   的重叠区间和量级差，再用 `clip.setAudio` 把配乐降到 0.3–0.5，然后复查。
2. **老工程里存在越界值**（过去 `clip.set_property` 不校验，可能写过 `volume: 4`、
   负数淡入淡出、或淡入淡出之和超过时长）：
   - 读取/播放侧宽容：`src/client/audio.js` 的 `normalizeSegment` 把 `volume` 夹到 `0..2`、
     淡入淡出夹到非负，超出时长的部分按比例压缩。所以老工程**不会突然没声音或爆音**。
   - 写入侧严格：对这类片段再执行 `clip.setAudio` 时，如果新值仍越界会报错；把值改到合法区间即可。
   - 想知道哪些片段有问题，直接看 `video_audio_mix` 的 `volume` / `fadeIn` / `fadeOut`
     （报告里给的是「实际生效值」，不是原始脏值）。

## 7. 测试与实测数字

`node scripts/audio-volume-test.mjs`（31 条，全部通过）覆盖：

- `clip.setAudio` 正常改 / 超范围拒绝 / 片段不存在 / 非音频轨拒绝 / 淡入淡出之和越界；
- `clip.update` 别名映射与非音频字段的明确错误；
- `clip.insert` 音频轨默认 `volume = 1`、视频轨忽略；
- `clip.split` 清掉跨切点淡入淡出；
- 包络首 0 / 中 1 / 尾 0（线性），淡入淡出重叠按比例压缩；
- WAV 解码峰值、`volume = 0.5` 的有效峰值比 = 0.500000（容差 1e-6）；
- 逐采样渲染的混音：`volume 1 → 0.5` 峰值比 0.500000（容差 1e-6）；`volume 1.5` 比值 1.500000；
  `muted` 输出全 0；
- 导出 `prepareAudio`：同一输入 `volume 1 vs 0.5` 峰值比 0.500000；峰值 1.4 时
  `trimmed = true`、`peakAfterTrim ≤ 0.99`、`warning = AUDIO_PEAK_TRIMMED`、调用方 buffer 未被修改；
- `video_audio_mix` 与时间线一致、`effectivePeak = 0.25`（0.5 素材 × 0.5 音量）、
  重叠量级约 -6 dB、缺失素材标 unknown、返回体是无损 JSON；
- `video_sound_insert(volume: 0.4)` 落进片段的 `volume` 就是 0.4。
