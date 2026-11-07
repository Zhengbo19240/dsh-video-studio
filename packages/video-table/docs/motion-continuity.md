# 运动连续性：怎么量，量出了什么，改了什么

> 起因：用户说「画面一卡一卡、不线性、运镜不丝滑」，并给了一个具体例子 ——
> 「同一张卡片左侧写着字，下一帧就变成右面是字了」。
>
> 本文记录三件事：**连续性检查器怎么做**、**6 张卡的真实体检数据**、
> **共性根因与修法**。最后附一节给卡作者的红线。

---

## 1. 工具：`video_continuity`

```
video_continuity({ projectId?, layerId?, start, end, fps = 30, threshold?, maxDim? })
```

行为：

| 参数 | 说明 |
|---|---|
| `layerId` | 动效库条目 id（`sc-timeline-travel` / `motion-sc-timeline-travel` 都认）。给了它就走**卡片模式**：临时工程里放一个覆盖 `[start,end)` 的代码片段，`localT` 就等于 `t`，所以 `[start,end)` 是**卡片自己的秒数** |
| `projectId` | 不给 `layerId` 时走**时间线模式**：按真实工程、真实片段在 `[start,end)` 采样 |
| `start` / `end` | 秒。`end` 不含。必须 `0 <= start < end` |
| `fps` | 1–60，默认 30 |
| `threshold` | 相邻帧 MAD 阈值，默认 0.035（见下） |
| `maxDim` | 每帧渲染上限，默认 480（160–1024） |

它渲帧用的是**和面板、导出同一条渲染核**（`src/headless.mjs` → `standalone-render.js`
→ `frame-render.js` → `player.js` + `code-registry.js`）。没有第二套画法。

### 返回

```jsonc
{
  "samples": 90,                     // 采样帧数
  "jumps": [                          // 相邻帧离群点
    { "t": 2.5667, "from": 76, "to": 77, "mad": 0.08602,
      "kind": "opacity",              // layout | opacity | camera | other
      "bboxFrom": {...}, "bboxTo": {...} }
  ],
  "smoothness": {
    "velocityJerkP95": 7.65,         // 相邻帧位移二阶差分的 95 分位（px）
    "jerkMax": 19,                    // 同一序列的最大值（p95 会漏掉少数尖峰，用它兜底）
    "meanSpeed": 1.416,               // 平均帧间位移（px）
    "stationaryRatio": 0.7753,        // 位移 < 0.1% 画宽的帧占比（判「卡住」）
    "jitterCount": 2,                 // 方向翻转次数
    "jitterRatio": 0.0222
  },
  "verdict": "smooth",                // smooth | minor-jumps | broken
  "worst": [...],                     // 按 mad 排序的前 3 个 jump
  "width": 480, "height": 270,
  "threshold": 0.035, "shiftThreshold": 0.05,
  "target": { "kind": "card", "id": "sc-transition-travel", "layerId": "..." },
  "range": { "start": 0, "end": 3 },
  "elapsedMs": 3514,
  "warnings": []
}
```

### 判定逻辑（`src/continuity.mjs`）

每一步都只用像素统计，不做图像识别：

1. **单帧统计** `frameStats`
   - 背景色＝出现次数最多的量化颜色（5 bit/通道）。用它而不是四角采样：卡片常有整幅出血的底色、四角却被角标占着。
   - 内容掩码＝与背景色的最大通道差 > 24 的像素。
   - bbox＝掩码的紧包围盒；另外按列/行累加掩码计数，得到两条**墨迹剖面**。
2. **帧间差异** `pairDiff`
   - `mad`：RGB 平均绝对差（0..1）。只比 RGB，alpha 在不透明底上没有信息。
   - `bboxShiftRatio`：bbox 中心位移 / 画宽。
   - `motion`：两条墨迹剖面的**互相关**位移（下面解释为什么需要它）。
   - `lumaDelta`：整帧平均亮度变化。
3. **判定** `judge`，要求「离群」：
   - 绝对门槛：`mad >= threshold`。
   - 相对门槛：`mad >= 2.5 × 局部中位数`（前后各 6 帧，跳过自己）。这条才是「正常运动」和「跳变」的分界 —— 快速运镜本身就有大 MAD，但它是连续的，不是离群。
   - `layout`：`shiftRatio >= 5% 画宽` **且** MAD 同时离群。
   - `camera`：同上，但内容铺满 ≥60% 且 bbox 面积几乎不变（整幅刚性平移＝运镜）。
   - `opacity`：MAD 离群、位移不大，但整帧亮度变化 ≥ 0.06。
   - `other`：MAD 离群，但对不上位移/亮度 —— 一般是「内容自己在换字」。
4. **verdict**
   - `broken`：出现 `layout` 或 `camera`；
   - `minor-jumps`：只有 `opacity` / `other`；
   - `smooth`：没有 jump。

### 默认值是怎么定的（不是拍脑袋）

在 480×270、30fps 下把 6 张卡各采 90–150 帧（共 534 个帧对），实测 MAD 分布：

```
p50 = 0.00025   p90 = 0.02406   p95 = 0.03278   p99 = 0.04184   max = 0.07570
```

而**单帧瞬移**（内容整体挪 10% 画宽）在合成素材上的 MAD 是 0.08 以上。
`threshold = 0.035` 落在 p95 与「瞬移」之间：比所有正常运动高，比真瞬移低。
`shiftThreshold = 0.05` 直接来自需求（「bbox 平移 > 画面宽 5%」）。
`spike = 2.5`：实测正常运动的帧间波动最大约 1.8 倍，2.5 倍能可靠分开。

### 为什么用墨迹剖面而不是 bbox 中心来量位移

bbox 在有一类卡片上会退化：`sc-timeline-travel` 有一条横跨整幅的时间轴线，
bbox 永远是「整幅 × 一条」，中心恒定不动 —— 于是「相机在横移」被量成「没动」，
`velocityJerkP95 = 0`，运镜是否丝滑完全看不出来。
墨迹剖面按列/行累加内容像素，移动的内容会整体推着剖面走，参照线不影响峰值位置。
互相关只有在「明显好于不动」（提升 ≥ 0.02）时才认这步位移，否则判 0 ——
不然纯换字（数字计数器）会被硬凑出一个位移峰值。

---

## 2. 体检结果：6 张卡

条件：`fps = 30`，窗口 `[0, 3)`，每帧上限 480×270。**修前**的数据。

| 卡 | jumps | 最严重的 3 个点（t 秒 / 类型 / MAD） | velocityJerkP95 | verdict |
|---|---|---|---|---|
| `sc-timeline-travel` | 0 | — | 1.00 | smooth |
| `tc-number-counter` | 3 | 1.6333 `other` 0.0757；1.7333 `other` 0.0727；0.3333 `layout` 0.0410 | 6.65 | broken |
| `tc-line-by-line-slide` | 0 | — | 0.00 | smooth |
| `sc-transition-travel` | 1 | **2.5667 `opacity` 0.0860** | 8.65 | minor-jumps |
| `tc-bar-chart-growth` | 0 | — | 0.00 | smooth |
| `tc-lower-third-bar` | 0 | — | 3.00 | smooth |

> 卡长超过 3 秒的（`sc-timeline-travel` 5.0s、`tc-line-by-line-slide` 4.0s、
> `tc-bar-chart-growth` 3.67s、`tc-lower-third-bar` 4.6s）另外按**全长**复测过一遍：
> 结论不变，仍然是 0 jumps。全长复测同时给了 `jerkMax`，见第 5 节。

### 逐卡结论

- **`sc-transition-travel`**：卡在 **t = 2.5667**，正是「接管瞬间页面亮度 +12% 一闪」
  那一帧。旧的写法是 `k = 1 - sinceTake / 0.16` —— 在 `sinceTake = 0` 处直接给到
  12% 白，整幅亮度**一帧内从 0 跳到 12%**。这是全文唯一一个「真正的硬切」。
- **`tc-number-counter`**：三个点都不是布局 bug，是**内容在换字**：
  - `t = 0.3333`：计数起步，`shown` 从 `0` 一步跨到 `9,738`（`power3Out` 起点斜率 3，
    `1/39` 的进度就是 7.5% 的量程），数字块在**一帧内从 1 个字宽铺到 5 个字宽**，
    墨迹整体横移 → 被判 `layout`。这是「计数器的第一帧」，不是元素瞬移。
  - `t = 1.6333` / `1.7333`：计数落定 + 落定弹跳（scale 1→1.08→1，0.09s/0.18s）。
    数字从 `127,997` 跳到 `128,000`，五个字形同时换 → `other`。
- **`tc-line-by-line-slide` / `tc-bar-chart-growth`**：`meanSpeed = 0`。
  前者是**淡入**（alpha 从 0 到 1，位置不动，剖面互相关看不到位移），
  后者是**柱状图长高**（缩放不是平移）。两者都连续，只是「位移」这个量对它们为 0。
- **`tc-lower-third-bar`**：`jerkMax = 26` 但 `velocityJerkP95 = 1.5` ——
  抖的是出场那 1–2 帧（`scaleX → 0`），时长太短，p95 看不见。它没有 jump，
  但「出场最后两帧掉得急」是真实观感，只是还没到跳变的门槛。

---

## 3. 共性根因（一句话）

> **把「离散量」或「分段硬切」直接喂给绘制和布局**：`if (t >= T)` 这种在一帧里
> 从无到有的分支、`Math.round` 之后的量，以及**短时长（0.15–0.25s）配 easeOut 起步**
> 的缓动 —— 后者起点斜率是 3，30fps 下一帧就走完 35–40% 的行程。

展开成三种可复现的形态：

1. **分段硬切**：`sinceTake >= 0 ? a : b`、`if (k < 0.5) … else …`。
   在分界点两侧取值不相等，就是「上一帧没有、下一帧全有」。
   → `sc-transition-travel` 的接管闪光就是这一种（判定为 `opacity`，MAD 0.086）。
2. **短时长 + 大斜率缓动**：`tw(t, landAt, 0.25, power3Out)`。
   `power3Out'(0) = 3`，`0.25s` 在 30fps 下只有 7.5 帧 → 第一帧 `u = 0.133`
   → 进度 `35%`。画面上是「啪」一下出现，不是淡入。
   → `tc-number-counter` 的单位/涨跌/标签四个淡入全是这个写法。
3. **离散量驱动布局**：`Math.round(target * progress)` 之后，
   文本宽度、块起点跟着它走 —— 位数一变，整块位移一个数字宽。
   → `tc-number-counter` 的 `x = numRight - slotWidth(shownText)` 属于这一类
   （本例里它已经用终值 `finalText` 定住了块宽，所以位移只发生在字形层，没成大位移；
   但这是**唯一挡住它变成真·跳变**的东西，卡作者不该指望每次都这么走运）。

---

## 4. 修了什么（两处，同一个病）

两处改动的机制是同一条：**让状态成为 `t` 的连续函数，并且两端斜率有界。**

### 4.1 `sc-transition-travel`：接管闪光的硬起（真缺陷）

```js
// 修前：sinceTake = 0 那一帧 alpha 从 0 直接到 0.12
const sinceTake = time - (RUSH_A + RUSH_DUR * 0.82);
if (sinceTake >= 0 && sinceTake < 0.16) {
  const k = 1 - sinceTake / 0.16;
  ctx.fillStyle = 'rgba(255, 236, 200, ' + (0.12 * k).toFixed(3) + ')';
  ctx.fillRect(0, 0, W, H);
}

// 修后：sin² 包络。两端斜率为 0，峰值仍是 12%，时长拉到 0.30s（约 9 帧）
const FLASH_DUR = 0.3;
const sinceTake = time - (RUSH_A + RUSH_DUR * 0.82);
if (sinceTake >= 0 && sinceTake < FLASH_DUR) {
  const u = sinceTake / FLASH_DUR;
  const k = Math.sin(Math.PI * u) ** 2;
  ctx.fillStyle = 'rgba(255, 236, 200, ' + (0.12 * k).toFixed(5) + ')';
  ctx.fillRect(0, 0, W, H);
}
```

为什么是 `sin²` 而不是 `smoothstep`：闪光是个**单峰**（起→亮→落），
`sin²` 天然两端为 0 且两端导数为 0；`smoothstep` 是单调的，得再套一层。
体感还是「一闪」，只是每一帧只走一小步。

### 4.2 `tc-number-counter`：四个短淡入的起步斜率

```js
// 修前：0.16–0.25s 的淡入全部用 power3Out，第一帧 35%
const unitP  = tw(t, landAt, CONFIG.unitDur, power3Out);
const labelP = tw(t, CONFIG.labelAt, CONFIG.labelDur, power3Out);

// 修后：smoothstep（两端斜率为 0，首帧 4.9%）
const smoothstep = (x) => x * x * (3 - 2 * x);
const unitP  = tw(t, landAt, CONFIG.unitDur, smoothstep);
const labelP = tw(t, CONFIG.labelAt, CONFIG.labelDur, smoothstep);
```

`duration` 没动：只是把「怎么走完这段路」从「先冲 35% 再减速」改成「起手轻、收尾轻」。

> 诚实说明：这一处改动**没有改变体检读数**（`tc-number-counter` 的 3 个 jump 还在）。
> 因为那三帧的主因是「数字落定、五个字形同时换」，不是那 35% 的透明度。
> 它是同一类病的一个次要出口，改了是顺手，不是靠它治病。

---

## 5. 修前 / 修后对比

同一把尺子（最终版 `video_continuity`）、同一窗口（`[0,3)` @30fps，480×270）。

| 卡 | jumps 修前 → 修后 | 最严重点 t | velocityJerkP95 修前 → 修后 | MAD 峰值 修前 → 修后 | verdict 修前 → 修后 |
|---|---|---|---|---|---|
| `sc-transition-travel` | **1 → 0** | 2.5667（消失） | **8.65 → 7.65** | **0.0860 → 0.0470** | minor-jumps → **smooth** |
| `tc-number-counter` | 3 → 3 | 1.6333 / 1.7333 / 0.3333 | 6.65 → 6.65 | 0.0757 → 0.0757 | broken → broken |
| `sc-timeline-travel` | 0 → 0 | — | 1.00 → 1.00 | 0.0019 → 0.0019 | smooth |
| `tc-line-by-line-slide` | 0 → 0 | — | 0.00 → 0.00 | 0.0168 → 0.0168 | smooth |
| `tc-bar-chart-growth` | 0 → 0 | — | 0.00 → 0.00 | 0.0045 → 0.0045 | smooth |
| `tc-lower-third-bar` | 0 → 0 | — | 3.00 → 3.00 | 0.0121 → 0.0121 | smooth |

全长复测（各自按 `meta.duration`）：

| 卡 | 窗口 | jumps | velocityJerkP95 | jerkMax |
|---|---|---|---|---|
| `sc-timeline-travel` | 0–5.0s | 0 | 3.00 | 29 |
| `tc-number-counter` | 0–2.87s | 3 | 6.85 | 52 |
| `tc-line-by-line-slide` | 0–4.0s | 0 | 0.00 | 0 |
| `sc-transition-travel` | 0–3.0s | **0**（修前 1） | **7.65**（修前 8.65） | **19**（修前 28） |
| `tc-bar-chart-growth` | 0–3.67s | 0 | 0.00 | 0 |
| `tc-lower-third-bar` | 0–4.6s | 0 | 1.50 | 26 |

`sc-transition-travel` 的 `jerkMax` 从 28 降到 19，也是同一次修正的副作用：
那一帧整幅亮度突变本身就是一次「速度突变」，去掉它，二阶差分也跟着降。

> 自查记录：体检做到一半发现工具自己有个**差一帧**的 bug —— `diffs[i]` 比的是
> `frames[i]` 与 `frames[i+1]`，但报出的 `t` / `bboxFrom` 用的是 `frames[i]`，
> 于是所有跳点都早一帧（第一次报 2.5333，实际是 2.5667）。已修，上表都是修后重测的数。

---

## 6. 哪些卡的问题不是共性、是它自己写坏了

- **`sc-transition-travel` 的接管闪光**：典型的一次性手写分支（`sinceTake >= 0` 直接给最大值），
  不是普遍写法问题。已经修掉。剩余 7.65 的 `jerkP95` 来自它自己的
  `quintOut` 接管段（0.7u 主推 + 0.3u 补完的**分段拼接**），
  拼接点的一阶导不连续 —— 但那是这张卡的**设计**（急推 + 接管），
  不动它，只记录：拼接点 2.4–2.6s 是它最不顺的一段。
- **`tc-number-counter` 的三个 jump**：不是布局缺陷，是计数器本身的语义 ——
  数字在换、落定在弹。要改成「首帧不跨 7.5%」，只能换缓动或降低量程，
  那是产品决策，不是 bug 修复。**它的 `t = 1.6333` 是 30fps 下这张卡最「跳」的一帧，用户如果嫌「一卡一卡」，指的是这里。**
- **`tc-lower-third-bar` 的 `jerkMax = 26`**：出场 `scaleX → 0` 压到 0.2–0.3s，
  最后两帧掉得急。p95 看不见（只占 2 帧），但肉眼能看见。属于它自己的节奏选择。

反过来说：**6 张卡里 4 张的 `jumps = 0`** —— 用户描述的「一帧之间字跑到另一边」
在这 6 张卡里**只有 `tc-number-counter` 的起步帧沾边**，而且是计数器的语义。
如果用户还在别的卡上看到真瞬移，那是别的卡；拿 `video_continuity` 跑一遍就知道。

### 改动清单（含基线刷新）

| 文件 | 改了什么 |
|---|---|
| `~/.dsh/motion-lib/sc-transition-travel/code.js` | 接管闪光：硬起 → `sin²` 包络 |
| `~/.dsh/motion-lib/tc-number-counter/code.js` | 4 处短淡入：`power3Out` → `smoothstep` |
| `scripts/card-honesty-test.mjs` | `PROTECTED['sc-transition-travel'].code` 换成新 sha256 |
| `tools/recipes/mechanism-groups.json` | `protected` 里同一张卡的 `checksums.code` |
| `tools/recipes/skeleton-audit.json` | `humanChecksums['tc-number-counter']` |
| `tools/recipes/media-perf.json` | `perCard['sc-transition-travel'].codeFingerprint` |

后四个是**基线指纹**，不是断言：断言原样保留，只是把「受保护卡的指纹」更新到修后版本
（这正是它们存在的意义 —— 改卡之后必须显式更新台账，否则测试会拦住你）。
卡本身的 `meta.json` 一个字节都没动。

---

## 7. 写卡时的连续性红线

卡作者（人或 agent）改 `code.js` 时，下面四条是硬线。

### 7.1 禁止在 `render` 里用条件分支切换布局位置

```js
// ✗ 断点：p 跨过 0.5 时 x 直接换一边
const x = p < 0.5 ? left : right;

// ✓ 同一个变量的连续插值
const x = left + (right - left) * easeInOutQuad(p);
```

同理，`if (t >= T) { 出现 }` 这种「一帧从无到有」也要给一个包络：

```js
// ✗ 在 T 那一帧 alpha 0 → 0.12
if (t >= T && t < T + 0.16) { alpha = 1 - (t - T) / 0.16; }

// ✓ 两端为 0 的单峰包络
const u = clamp01((t - T) / 0.3);
const alpha = Math.sin(Math.PI * u) ** 2;
```

### 7.2 文字宽度只测一次

`ctx.measureText` 是**布局的输入**。在 `render` 里每帧重测再拿结果去算位置，
等于「布局由测量值驱动」—— 字体回退、字距、小数点都会让它在某一帧变一点点，
整块跟着挪。做法：

- 同一字体同一字号只测一次，把结果缓存到模块级 `Map`（键：`font + '\0' + text`）；
- 布局里凡是「宽度决定位置」的地方，用**终态**的宽度算（计数器用 `finalText` 的宽度），
  动画过程中不要用当前值反推布局。

### 7.3 所有位移必须有缓动，线性只留给本来就匀速的运动

- 位移、缩放、旋转、透明度：`easeOutCubic` / `easeInOutQuad` / `smoothstep`。
- **短时长（< 0.3s）优先 `smoothstep`**：`easeOut` 起步斜率 3，
  30fps 下第一帧就是 30–40% 的行程，看起来是「啪」。
- 线性只允许出现在「匀速滚动 / 传送带 / 跑马灯」这类**本身就是匀速**的运动上。
- 分段曲线（keys/values 表）要求**拼接点两侧导数相等**，否则速度会跳。

### 7.4 每帧状态必须是 `t` 的纯函数，不能依赖上一帧

```js
// ✗ 状态：结果取决于被调用了几次 / 调用顺序
let lastX = 0;
function render(ctx, t) { lastX += (target - lastX) * 0.2; draw(lastX); }

// ✓ 只吃 t
function render(ctx, t) { draw(easeOutCubic(clamp01(t / dur)) * target); }
```

判据很简单：**任意 seek、任意顺序、任意次数调用同一个 `t`，像素必须一模一样。**
（worker 里预览会节流、导出会逐帧、采样会跳帧 —— 有状态就一定对不上。）

顺带两条相关的：

- **不要 `Math.round(t * fps) / fps`**：那会把时间量化成阶梯，
  60fps 播放时每帧走两步、跳一步，就是「一卡一卡」。
- **不要把 `Math.round()` 的结果喂给布局**：整数量可以用来决定「画几个字」，
  不能用来决定「画在哪」。

---

## 8. 已知局限（别把工具当测谎仪）

1. **剖面互相关只测平移，不测缩放。** 柱状图长高、圆放大这类，
   `meanSpeed` 会是 0，`stationaryRatio` 会是 1 —— 那不是「卡住」，是「没平移」。
   缩放类的突变要看 `mad`（它一样会离群）。
2. **分辨率是整数像素。** 480 宽下 1px = 0.2% 画宽；慢于 1px/帧的运动被量成 0。
   要更细就 `maxDim` 调大（这是采样分辨率，不是渲染质量）。
3. **`velocityJerkP95` 会漏掉少数尖峰。** 一段 90 帧里只有 2–3 帧抖，p95 看不见。
   所以同时给 `jerkMax`；两者差得远，说明「抖得少但抖得狠」。
4. **`layout` / `camera` 的区分是启发式**：整幅铺满 + 面积不变 → 运镜，否则 → 布局。
   运动图形卡（白底 + 少量图形）上的相机抖动会被记成 `layout`。两者都是 `broken`，
   不影响「有没有问题」，只影响「叫什么名字」。
5. **播放器侧还有一层节流**，不在本次体检范围内：
   `code-registry.tickLayers` 按 `now - lastAt < 16/40ms` 跳过重绘，
   且 `render` 是 fire-and-forget。**预览时的「一卡一卡」可能来自这一层，
   而不是卡片本身。** 导出（逐帧 `await`）不受影响。要坐实，需要对比
   同一条时间线在预览与导出两条路径上的 MAD 序列 —— 这次没做。
