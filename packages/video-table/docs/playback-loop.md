# 预览播放循环：为什么会「一顿一顿」，以及现在怎么保证不顿

> 一句话：**预览的时间只来自播放头。墙钟不参与「这一帧要不要画」的决定；
> 每个图层同时只有一份渲染在飞，新请求只更新「最新想要的 t」。**
> 渲染跟不上帧率时，呈现帧率下降，但呈现的每一帧都是当时最新的一帧 —— 绝不回退。

相关代码：`src/client/code-registry.js`（`pumpPreview` / `requestPreview` / `tickLayers`）、
`src/client/player.js`（引擎与合成，未改动）。
回归测试：`scripts/playback-loop-test.mjs`（18 条）。

---

## 1. 症状与两条被证实的怀疑

用户反复报「预览一卡一卡，但成片看着还行」。审查怀疑两处，**都属实**：

### 怀疑一：按墙钟跳帧（属实）

修前 `tickLayers`（`src/client/code-registry.js`）:

```js
const now = Date.now();
const gap = playing ? 16 : 40;
if (now - rec.lastAt < gap) continue;      // 墙钟节流
if (Math.abs(layer.localT - rec.lastT) < 0.0005 && rec.lastT !== -999) continue;
rec.lastT = layer.localT;
rec.lastAt = now;
renderCode(rec, clip, layer.localT).catch(...);   // ← fire-and-forget
```

`Date.now()` 只有毫秒分辨率。120Hz 屏幕上两个 rAF 相隔 8.3ms，
`now - lastAt` 永远是 8 或 9，稳定小于 16 —— **每隔一帧就被砍掉**。
实测（120Hz / 25ms 渲染 / 3 秒）：提交渲染 179 次，而 rAF 触发了 360 次，
呈现帧率被钉在约 40fps 而不是 60。

### 怀疑二：fire-and-forget 导致排队与乱序（属实）

`renderCode` 不被 `await`，而 `layer.render` 在 `code-layer.js` 里走的是**串行链**
（`renderChain`）。于是每个 rAF 都往链里塞一帧：

- 渲染 25ms、帧间隔 16.7ms → 每秒多塞 20 帧，队列无限增长。
  实测 3 秒后积压 60 帧 ≈ **画面比播放头落后 1.0 秒**；
- 更糟的是 `renderCode` 在调用 `layer.render` **之前**还要 `await` 取帧 / 转场准备。
  这段耗时的抖动会让「后发的新请求」先进入渲染链，「先发的旧请求」后进入 ——
  完成顺序与请求顺序相反，旧帧盖掉新帧。

实测（60Hz、渲染很便宜但取帧耗时 45ms/1ms 交替）：**3 秒内 58 次乱序呈现**，
即画布被打回过去 58 次。这就是肉眼看到的「一顿一顿」。

这两条合起来解释了一个反直觉的现象：**导出正常、预览卡。**
导出走 `renderAt()` → 逐帧 `await renderCode()`，没有任何队列与并发；
预览走 `tickLayers()` → 不等待、不看完成顺序。

---

## 2. 现在的规则（三条，缺一条都不成立）

### 规则 1：时间只来自播放头

`requestPreview(rec, clip, localT)` 只比较「播放头要的 t」和「画布上已经是哪一帧」。
墙钟只用于统计 `presentedFps`，**不参与任何丢弃决定**。

```js
if (rec.inflight) {
  if (rec.inflightKey === key) return 'skipped';   // 在飞的就是这一帧
  rec.wantT = want; rec.wantKey = key; rec.wantGen += 1;   // 只更新「最新想要的」
  return 'coalesced';
}
if (rec.doneKey === key) return 'skipped';          // 画布上已经是这一帧
```

### 规则 2：每个图层最多一份渲染在飞

`pumpPreview` 保证单飞：在飞期间来的请求**只更新 `wantT`**，不进队列。
渲染完成后若 `wantGen` 又变了，就地再渲最新那一帧。于是：

- 队列长度恒 ≤ 1，滞后上界 ≈ 一次渲染耗时；
- 完成顺序 = 开始顺序，「旧帧盖新帧」在结构上不可能发生。

### 规则 3：完成时按「播放头方向」判过期，而不是按「有没有来过新请求」

这是实现时踩过的一个坑，值得写下来：
**如果一完成就问「渲染期间有没有新请求」，那么渲染慢于帧率时每一帧都算过期，
画布会一帧都不更新**（实测 presented = 0）。正确的判据是方向：

```js
const superseded = gen !== rec.wantGen;
const wantNow = rec.wantT;
const wentBackwards =
  superseded && (wantNow === null || wantNow < wantT - 1e-9);

if (wentBackwards) {
  previewStats.staleDrops += 1;   // 播放头倒退了：这份「未来帧」作废，绝不上屏
  continue;                        // 立刻去渲新位置
}
// 播放头前进（正常播放）：这份结果仍是最新完成的一帧 → 上屏，再接着渲最新
```

也就是说：

- **正常向前播放**：每一份完成的结果都是「当时最新的一帧」，上屏它，然后立刻追上最新；
  代价是呈现帧率下降，收益是画面永远贴着播放头。
- **seek 回退 / 导出抢占**：在飞的那份属于「过去的位置」，上屏就是旧帧盖新帧 —— 丢弃。
- **暂停**：同一个 t 重复 tick 直接被 `doneKey` 挡掉，一个像素都不重画。

---

## 3. 实测：修前 vs 修后

测量装置与 `scripts/playback-loop-test.mjs` 同一个模型：虚拟时钟 + 假 rAF +
假渲染器（内部串行链与 `code-layer.js` 同构）。播放 3 秒，记录每个 rAF 时刻画布上的 t。

- **丢帧率** = 画布内容变化次数 / rAF 次数
- **乱序** = 后呈现的 t 小于前一次呈现的 t 的次数
- **MAD** = 每个 rAF 时刻「播放头 t − 画布 t」的平均值（秒）
- **末帧滞后** = 最后一个 rAF 时画布落后多少秒
- **积压** = 已提交进渲染链但还没开始的帧数

### 60Hz / 渲染 25ms / 3 秒（任务指定场景）

| 指标 | 修前 | 修后 |
|---|---|---|
| 呈现帧数 | 118（39.3fps） | 119（39.7fps） |
| 丢帧率 | 34.4% | 33.9% |
| 乱序次数 | 0 | 0 |
| MAD | **0.522s** | **0.044s** |
| 末帧滞后 | **1.017s** | **0.050s** |
| 积压 | **60 帧** | **0** |

注意：**丢帧率几乎没变** —— 渲染 25ms 就是追不上 60Hz，这部分是物理限制。
变的是「丢的是哪些帧」：修前丢掉的是最新的、显示的是排队中的陈旧帧（越播越落后），
修后丢掉的是中间的、显示的永远是最新完成的那一帧（滞后封顶在一次渲染耗时）。

### 全部场景

| 场景 | 修前 呈现/乱序/MAD/末帧滞后/积压 | 修后 |
|---|---|---|
| 60Hz / 25ms | 118 / 0 / 0.522 / 1.017 / 60 | **119 / 0 / 0.044 / 0.050 / 0** |
| 60Hz / 0ms（理想） | 178 / 0 / 0.017 / 0.017 / 0 | 179 / 0 / 0.017 / 0.017 / 0 |
| 60Hz / 3ms + 取帧抖动 45:1 | 119 / **58** / 0.044 / 0.017 / 0 | **89 / 0** / 0.058 / 0.083 / 0 |
| 120Hz / 25ms | 119 / 0 / 0.522 / 1.008 / 59 | 119 / 0 / **0.042** / **0.050** / 0 |
| 30Hz / 25ms | 88 / 0 / 0.033 / 0.033 / 0 | 89 / 0 / 0.033 / 0.033 / 0 |
| 60Hz / 60ms（重卡） | 49 / 0 / **1.120** / **2.167** / 129 | 49 / 0 / **0.098** / **0.117** / 0 |

（数字来源：同一份装置在改前 / 改后各跑一遍；修后这组数字由
`scripts/playback-loop-test.mjs` 的断言守着。）

修后所有场景的 `staleDrops` 都是 0：正常向前播放没有出现过任何过期帧。

### 低帧率与 seek

- 120Hz 下 `requested` = 360（每帧都请求），实际渲染 120 帧 —— 由渲染能力决定，
  不再被 16ms 墙钟门砍掉一半。
- seek 回退时 `staleDrops ≥ 1`：在飞的那份「未来帧」被丢弃，画布直接落到新位置。
- 暂停后同一 t 重复 tick：`submitted` 不再增长。

---

## 4. 指标：控制台与代码

注册表返回 `playbackStats()`，同时挂在全局：

```js
__dshPlaybackStats()
// {
//   requested: 180,      // 需要新帧的请求数（同一 t 的重复请求不算）
//   renders: 120,        // 真正发起渲染的次数
//   presented: 119,      // 上屏的帧数（画布真的换过一次）
//   droppedFrames: 61,   // requested - presented
//   staleDrops: 0,       // 过期帧被丢弃的次数（播放头倒退 / 导出抢占）—— 正常播放恒为 0
//   lateFrames: 119,     // 完成时播放头已前进的帧数（仍上屏）
//   coalesced: 179,      // 在飞期间被合并掉的新请求数
//   presentedFps: 41,    // 最近 1 秒窗口内的实际呈现帧率
//   windowMs: 1000,
//   layers: 1
// }
```

回归时看三个数：

| 指标 | 健康值 | 变红说明什么 |
|---|---|---|
| `staleDrops` | 0 | 有过期帧上屏（旧帧盖新帧回来了） |
| `presentedFps` | 随渲染耗时变化，但 **> 30**（25ms 渲染下约 40） | 掉到个位数 = 又变成排队等旧帧 |
| `droppedFrames` | 可以很大 | 这是「降帧不呈现过期帧」的代价，不是 bug |

---

## 5. 导出路径未受影响（证据）

- `renderAt()` / `renderLayers()`（导出、采样、无头渲染走这两条）仍然是**逐帧 await**，
  改动只有一处：进严格渲染前先 `retirePreview(rec)` —— 把预览的在飞请求作废并等它落地，
  避免两路抢同一块画布（测试 15 断言「导出帧一定赢」）。
- `scripts/playback-loop-test.mjs` 的第 14 条：同一时间线逐帧 `renderAt`，
  呈现的帧序列与请求的 t 序列**逐帧差为 0**（MAD = 0）。
- 完整回归（改后全绿）：`playback-test`(25) · `code-layer-test`(10) ·
  `code-layer-media-test`(19) · `transition-composite-test`(20) ·
  `transition-host-test`(21) · `export-test`(14) · `sample-test`(5) · `render-test`(9) ·
  `headless-sample-test`(19) · `perf-regression-test`(31)。

---

## 6. 如果这还不是主因，剩下的嫌疑在哪

这个修复只覆盖**代码图层（type: 'code'）**的预览重绘。如果用户的「一顿一顿」
出现在纯视频轨道的时间线上，最可能的下一站是：

1. **`player.paintPreviewFrame` 的「未就绪就整帧不画」**（`frameMediaReadiness`）。
   播放中只要有一个媒体图层在 `seeking` 或漂移 > `DRIFT_TOLERANCE`(0.25s)，
   整帧都不画 —— 代码图层再新也上不了屏，观感就是整幅画面卡住。
   这条比代码图层的问题更「全局」，但它每帧都要一次判定，且只有在 seek 发生时才触发。
2. **`<video>` 池的 drift 纠正**（`syncMedia`：播放中漂移 > 0.25s 才 seek 一次）。
   每次纠正都会进入上一条的「不画」，形成一次可感知的停顿。
3. **`onTick` 的 UI 节流 33ms**：只影响播放头数字与时间线滚动，不影响画面。

判断方法：打开控制台跑 `__dshPlaybackStats()` 播放一段。
`presentedFps` 正常但画面还是卡 → 主因在 1/2（合成器整帧 hold），不在代码图层。
`presentedFps` 很低甚至不动 → 还在代码图层这条路上，回来看 `staleDrops` 与 `renders`。

---

## 7. 改动的边界

- 只动 `src/client/code-registry.js` 的预览循环（`tick` / `tickLayers` /
  `renderCode` 的调用方），没有动 `code-layer.js`、`player.js`、`exporter.js`。
- `src/lease.mjs`、`~/.dsh/motion-lib/**`、`dsh-video-brief（本仓库 packages/video-brief）`、`tools/recipes/**` 未触碰。
- `client.js` 是构建产物，由 `node scripts/build-client.mjs` 重新生成。
