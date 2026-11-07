# 转场上下文（transition host）

> 给「转场类」代码图层补上**切点两侧的画面**。
>
> 结论先行：`env.transition` 目前是「**合成帧**」语义 —— `prev.frame()` / `next.frame()`
> 返回的是按时间线时刻整帧合成后的画面（邻镜自己的位移 / 滤镜 / 蒙版、以及它上面叠的
> 媒体与文字图层都在里面），不再是素材原始帧。原始帧仍然保留在 `rawFrame()` 里。
> 两张曾经因为「需要前后两镜」被标 skip 的卡（`sc-circle-match-iris`、
> `sc-transition-hidden-cut`）已经按新契约重写并通过测试。
> 边界仍然是：**同一时间线上、真实存在的两个镜头**；不支持嵌套转场、自动圆心检测。
> 下面每一条都写清「为什么」，以及「什么情况下拿不到」。

---

## 1. 现实问题

现有代码图层只能拿到：`render(ctx2d, t, env)`，`env = { width, height, fps, duration, assets, media }`。
`media.video(id)` 返回的是**本图层所属片段**当前帧的位图。它不知道：

- 自己前后是哪个片段；
- 前一镜最后一帧长什么样；
- 后一镜第一帧长什么样；
- 切点在自己内部时间轴的哪里。

而「圆形匹配光圈切」和「藏切点」的卖点恰恰是**切点两侧对得上**。只做单层内效果，
要么丢掉匹配语义，要么根本构造不出「切点」。所以需要宿主把这三件事补上。

---

## 2. 数据模型：转场片段长什么样

真实结构（`src/domain.mjs` / `src/store.mjs`，没有改动）：

```
doc
├─ tracks: [ { id:'v1', kind:'video', … }, { id:'c1', kind:'code', … }, … ]
└─ clips:  [
     { id:'A', trackId:'v1', type:'media', assetId:'va', start:0, duration:4, … },
     { id:'B', trackId:'v1', type:'media', assetId:'vb', start:4, duration:4, … },
     { id:'X', trackId:'c1', type:'code', layerId:'sc-circle-match-iris',
       codeHash:'…', start:3, duration:2, props:{ cx:0.62, cy:0.42 }, … }
   ]
```

- **轨道**有 `kind`（`video` / `code` / `text` / `audio`），片段有 `type`（`media` / `text` / `code` / `audio`）。
- 同一条轨道上片段**不允许重叠**（`domain.assertNoOverlap`），所以一个「盖住切点」的转场图层
  **不可能再坐在主轨上**——它必须坐在**另一条轨道**（通常是 `c1`），压在下面两镜的交界处。
- 这就是本方案的数据模型前提，也是后面所有边界规则的来源。

### 「前后两镜」从哪取

**按时间取，跨轨道，主轨优先**：

1. 切点全局时间 `cutGlobal = clip.start + cutAt`；
2. 在 `cutGlobal - ε` 上正在播的片段 = `prev`，在 `cutGlobal + ε` 上正在播的片段 = `next`；
3. 候选**排除**：自己；自己所在轨道（转场图层不是「被它盖住的那一镜」）；音频片段；
4. 多个候选同时在播时按轨道排序：`video` 轨（越靠前越优先）→ `code` 轨 → `text` 轨。

`ε = 0.0005s`。这样 `prev` 就是「前一镜的最后一帧所在的片段」，`next` 是「后一镜第一帧所在的片段」。

为什么不做「相邻片段 id」：转场图层和两镜不在同一条轨道上，`adjacentClips`（domain.mjs 里给
合成器转场用的那个）根本看不到对方；`transitionAt`（`player.js`）也只认同轨贴住的邻居。
时间探测是唯一能同时覆盖「主轨 A|B 交界」和「画中画叠加」的判据。

### 切点位置：`cutAt` 怎么定

优先级（高 → 低）：

1. `clip.props.cutAt`（秒，图层内时间）—— 剪辑/分镜显式写下的值；
2. **真实切点推断**：在图层覆盖的时间范围内，找同一视觉轨上「A 结束、B 开始」的时刻，
   取离 `duration/2` 最近的那个；
3. 兜底：`duration / 2`。

为什么默认不是硬编码 `duration/2`：把切点交给「效果卡自己猜」，会让改片段长度时切点
悄悄跑掉；而时间线本来就知道切点在哪。推断失败（图层没盖住任何交界）时才退回中点。

**越界**：`cutAt < 0` 夹到 `0`，`> duration` 夹到 `duration`，并在内部标记 `source='clamped'`。
不抛错——一个坏 props 不该让整帧黑掉。夹到边界后，另一侧自然没有邻居，卡片走降级。

`cutAt = 0` 的语义是「切点正好在图层起点」：`prev` 仍然能取到起点前那一镜的最后一帧；
`cutAt = duration` 同理能取到终点后那一镜的第一帧。这两个边界是有用的，不是错误。

---

## 3. 契约

```js
export const transitionNeeds = (props, env) => ({
  prev: true, next: true,       // 要哪几侧
  composed: 'both',             // 可选：'prev' | 'next' | 'both' | true；不写 = 只要原始素材帧
});

export function render(ctx2d, t, env) {
  const tr = env.transition;         // 永远存在（老卡片不读它就没有任何影响）
  // tr.cutAt      number   切点在图层内的时间（秒，已夹到 [0, duration]）
  // tr.declared   boolean  模块是否声明过邻帧需求
  // tr.composed   false|'prev'|'next'|'both'  归一化后的合成声明
  // tr.prev/next  {
  //   has: boolean,       结构上有没有相邻镜头
  //   clipId: string|null,
  //   reason: string,     'ok' | 'none' | 'no-media' | 'no-asset' | 'decode-failed' | 'timeout'
  //                       | 'compose-failed' | 'compose-timeout' | 'copy-failed'
  //   message: string,    对应的中文诊断（可直接画在角落排查）
  //   composed: boolean,  这一侧**实际**拿到的是不是合成帧（失败时 false）
  //   frame(t?): ImageBitmap|null       合成帧（默认帧）；合成失败 → null，不拿原始帧冒充
  //   rawFrame(t?): ImageBitmap|null    原始素材帧（旧行为，始终保留）
  // }
  const before = tr.prev.frame();    // 前一镜最后一帧——**合成后的真实画面**
  const after  = tr.next.frame();    // 后一镜第一帧——**合成后的真实画面**
  const raw    = tr.prev.rawFrame(); // 同一时刻的素材原始帧，卡可以自己比较
}
```

### `frame(t?)` 的参数

- 省略 → 默认帧：`prev` = 前一镜**末帧**（`duration - 半帧`），`next` = 后一镜**首帧**（半帧）。
  合成帧只预取这一个时刻。
- 给数字 → 该邻镜**素材源时间**（秒），走**原始素材帧**那条路。这个时刻的帧只有被宿主
  预取过才拿得到，否则返回 `null`——帧表是按帧传进 worker 的，不会在 render 里发起异步解码
  （`render` 必须是同步的、t 的纯函数）。

### 合成帧语义（本版新增，**有意的行为变更**）

`frame()` 从「素材原始帧」升级成「按时间线时刻合成的一帧」：

- 合成时跑的是**同一个** `player.drawFrame`（预览 / 导出 / 采样共用的那个合成器），
  所以邻镜自己的 `transform`（位移 / 缩放 / 旋转 / 不透明度 / 关键帧）、`effects` 滤镜、
  `mask` 蒙版、上层画中画、文字叠层，全都在这张帧里。
- 只有**显式声明 `composed`** 才走合成；没声明时 `frame()` 仍是原始素材帧，一次合成都不做。
- **代码图层不参与合成**。转场卡自己就在代码轨上，合成里再画代码层是递归；文字与媒体叠层照常。
- 合成失败（没帧、drawFrame 报错、超时、位图转换失败）→ 该侧 `frame()` 返回 `null`、
  `composed:false`，`reason` + 中文 `message` 说明原因；**不抛**。`rawFrame()` 仍然可用。
- 老卡只读 `frame()` 的，画面会更接近真实成片 —— 这是有意变更，不是 regression；
  需要旧行为的卡改读 `rawFrame()`。

### 为什么必须显式声明 `transitionNeeds`

不声明的模块，宿主**不解码任何邻帧**，只把结构信息（`has` / `cutAt` / `clipId`）放进去。
理由：老卡片占绝大多数，给每一张卡都白 seek 两帧是纯浪费；而「声明」本身是卡片作者
唯一需要多写的一行。声明写坏（抛错）按「不声明」处理，不阻断渲染。

---

## 4. 取帧链路

```
code-registry.renderCode(clip, localT)
  │
  ├─ resolveTransitionContext(clip, {clips, tracks, fps})
  │     └─ cutAt / cutGlobal / prev / next（纯计算）
  │
  ├─ rec.layer.transitionNeeds()  ← worker 在 setup 后上报
  │     └─ 没声明 → 只发结构，不解码
  │
  ├─ prepareSide(prev/next)
  │     ├─ 邻片段的素材 → 源时间（sourceOffsetOf，与合成器同一套变速公式）
  │     ├─ transitionFrameKey(clipId, 源时间) → 帧级 LRU（默认 8 帧）
  │     └─ bridge.frameAt(asset, 源时间)
  │           └─ 主线程独立 <video> 池：seek → 等 seeked → 核对落点(≤0.25s)
  │              → createImageBitmap → 返回位图
  │
  ├─ 复制一份给 worker（缓存里那一份不能被 transfer 走）
  └─ layer.render(localT, { transition, transitionFrames })
        └─ transfer list 带上所有邻帧位图 → worker 建帧表
```

时间基准和 media 通道完全一致：`localT` 来自 `frameLayers`，变速映射用 `sourceOffsetOf`，
所以**预览 / 导出 / 采样三条路径看到的是同一个切点、同一对帧**。

### 缓存

- 键：`clipId@源时间`（毫秒量化），容量 8，LRU。
- 命中：只做一次 `createImageBitmap(bitmap)` 复制，**不重新 seek/解码**。
- 淘汰：回调 `close()` 释放旧位图；注册表 `dispose()` 清空缓存。
- 同一键的并发请求合并成一次解码（single-flight）。
- 时间线数组引用一变（任何一次编辑都会刷新出新的 `clips` 数组）就整体清空：
  邻片段可能换了素材，旧帧不能再用。这条是「按 assetId 做键」的廉价替代。

### 合成帧（composed）链路与成本

声明了 `composed` 时，`prepareSide` 在原始帧之外再走一次合成：

```
prepareSide(side)
  │
  ├─ 原始素材帧：bridge.frameAt(asset, 源时间) → 帧级 LRU（8 帧）→ rawFrame()
  │
  └─ 合成帧：registry.composeFrameAt(plan.cutGlobal)
        ├─ composer = createCompositeFrameProvider({ drawFrame: player.drawFrame, … })
        ├─ 按**时间线时刻** frameLayers(clips, cutGlobal) → 去掉代码图层
        ├─ 每个媒体图层：bridge.frameAt(asset, sourceTime(clip)) → 位图
        ├─ 离屏 Canvas（OffscreenCanvas 优先）960×540 → player.drawFrame 整帧合成
        ├─ createImageBitmap(canvas)
        └─ 缓存键 `globalTime(毫秒)+doc.revision`，容量 4，LRU，single-flight
```

成本（实测见下）：

- **每帧一次整屏合成**（960×540 的 drawImage 叠加 + 一次 `createImageBitmap`）。
  这是合成帧真正的固定开销，与工程里有几层媒体关系不大。
- **每个媒体图层一次取帧**：合成要拿「该时刻每一层媒体的画面」，所以有 N 层媒体
  就有 N 次 `frameAt`（独立 <video> 池 seek + createImageBitmap）。素材帧缓存是
  「clipId@源时间」，而合成是「时间线时刻」，两者不共享缓存 —— 这一项比旧的原始帧更贵。
- 缓存键是**毫秒级时间线时刻 + revision**，所以预览里每换一帧就是一个新键；
  LRU=4 只能兜住「同一帧被重复请求」（重绘、prev/next 先后请求）。**不要指望它跨帧命中。**
- 时间线一编辑（revision 变）整个合成缓存立即作废并 `close()`。
- 合成结果缓存里那一份不能直接 transfer，每次仍要 `createImageBitmap(bitmap)` 复制一份给 worker。

### 性能建议（转场卡）

1. **转场卡尽量短**。合成帧按「声明了 composed 的代码图层的每一帧」计费，卡片时长翻倍，
   合成次数就翻倍；1–2.5 秒足够讲完一个转场。
2. **别在合成帧上再叠 blur**。`frame()` 拿到的位图已经是整帧，卡里再 `ctx.filter='blur(…)'`
   会在大位图上做一遍全屏卷积，且每帧都做；需要柔化就在卡自己的小范围内做。
3. **不要在卡里逐帧读合成帧像素**（`getImageData`）。那会把每帧变成一次 GPU→CPU 回读。
4. 只有真的需要「邻镜的位移 / 滤镜 / 上层叠层」时才声明 `composed`；
   只想看构图或色彩分布的卡用 `rawFrame()` 就够了，成本低一个量级。
5. 一帧里同时合成的侧数越少越好：`: 'prev'` 比 `'both'` 便宜一半。

### 超时与失败

- 单侧超时默认 2500ms（`opts.transitionTimeoutMs` 可改）。超时 / seek 落点偏差过大 /
  解码失败 / 素材缺失 → 该侧 `frame()` 返回 `null`，`reason` + 中文 `message` 说明原因，
  **不抛错、不拿上一帧冒充**。
- 整个邻帧准备阶段被 `try/catch` 包住，失败退化为「有结构、没帧」，渲染照常进行。

---

## 5. 降级矩阵

| 情况 | 宿主行为 | 卡片看到 |
|---|---|---|
| 图层在最前面 / 最后面 | 那一侧不解码 | `has:false`、`reason:'none'`、`frame()→null` |
| 相邻是纯色卡 / 文字卡 / 代码卡 | 不取帧 | `has:true`、`reason:'no-media'`、`frame()→null` |
| 相邻片段素材不在素材表 | 不取帧 | `has:true`、`reason:'no-asset'`、`frame()→null` |
| seek 超时 / 落点偏差 > 0.25s | 放弃这一侧 | `reason:'timeout'` / `'decode-failed'`、中文诊断 |
| 浏览器不支持复制位图 | 放弃这一侧 | `reason:'copy-failed'` |
| 模块没声明 `transitionNeeds` | 不调解码 | 结构照给，`declared:false`，`frame()→null` |
| 模块声明抛错 | 当作没声明 | 同上，不阻断 |
| 没有可用媒体桥 | 不取帧 | `reason:'decode-failed'`（或直接 null） |
| 声明了 composed，但合成失败 | `frame()→null`、`composed:false` | `reason:'compose-failed'` / `'compose-timeout'`、中文诊断；`rawFrame()` 仍可用 |
| 声明了 composed，但这一时刻没有媒体层 | 合成放弃 | 同上，`reason:'compose-failed'` |
| 没声明 composed | 不合成 | `composed:false`，`frame()` 是原始素材帧（旧行为） |

**卡片必须把「`has:true` 但 `frame()→null`」当成正常情况**：`has` 只表示结构上有邻镜头，
不表示这一帧一定取得到。两张验证卡都走「有帧 / 无帧」两条分支；合成失败时它们退回
`rawFrame()`，并在 `props.debug` 的角标里注明「原始素材帧（合成不可用）」。

---

## 6. 明确没做的部分（以及为什么）

1. **合成帧里的代码图层**。合成只画媒体与文字图层：转场卡自己就在代码轨上，
   在合成里再画代码层是递归（而且没有防环机制）。所以「邻镜上叠了一张代码卡」这件事，
   在邻帧里看不到；文字与画中画媒体能看到的。
2. **嵌套转场 / 转场里再套动效**。邻片段本身是代码图层时，不会去渲染它再取帧
   （同上，递归）。这类邻居只会得到 `has:true` + `frame():null`。
3. **自动圆心检测**。`sc-circle-match-iris` 的圆心来自 `props.cx/cy`，不做逐像素圆检测
   （全帧读像素是这批卡的性能红线）。
4. **跨轨道「取最上面那层」**。排序规则是主轨优先，不是视觉层级（`v2` 上的画中画不会被当成主画面）。
   合成帧本身会把 v2 画上去，但 `pickNeighborClip` 选「哪一镜是邻镜」仍按主轨优先。
5. **让卡片在 render 里按需异步取任意帧**。`render` 是同步纯函数，`frame(t)` 只能命中预取；
   合成帧也只预取「默认帧」那一刻。
6. **在 worker 里读位图像素**（`getImageData`）。技术上可以，但会让「亮度/色彩匹配」类卡
   变成逐像素操作，违背性能预算；需要时再单独设计。

---

## 7. 对导出路径的影响

**会变慢，量级取决于转场卡长度与媒体层数。**

- 导出走 `player.frameLayers(clips, t)` → `codeRef.current.renderLayers(layers)` →
  `player.drawFrame`。`renderLayers` 与预览的 `tickLayers` 调的是同一个 `renderCode`，
  所以**导出和预览拿到的是同一套合成帧**（同一份 `globalTime = cutGlobal`、同一个缓存键语义）。
- 每帧（每个声明了 composed 的转场图层）多出来的固定开销：
  1. 每个媒体层一次 `bridge.frameAt`（seek + createImageBitmap）；
  2. 一次 960×540 的整帧 `drawFrame`；
  3. 一次 `createImageBitmap(canvas)`（合成位图）；
  4. 一次 `createImageBitmap(合成位图)`（复制给 worker，缓存那份不能 transfer）。
- 旧路径（只取原始帧）只有第 1 步的两帧，且「前一镜末帧 / 后一镜首帧」的时间固定，
  缓存命中后每帧只剩复制。**合成帧的时间线时刻虽然也固定，但缓存键含 revision，
  且导出逐帧推进时同一时刻会被重复请求** —— 在切点附近能命中，离开切点就重新合成。
- 实测（本机 Edge headless，960×540、两层媒体 + 一层文字，n=40）：整帧合成
  （draw + `createImageBitmap`）**平均 2.06ms**，p50 1.9ms，p95 3.4ms，max 3.5ms。
  这**不含**每个媒体层的 `<video>` seek + 解码 —— 那部分和旧的原始帧通道同价，
  合成只是把「每帧一次整帧光栅化」加在上面。导出 30fps、切点前后 2.4 秒的转场卡：
  **固定多出约 0.15 秒**（72 帧 × 2.1ms）+ 每帧 N 层 × seek/decode。相对整片导出是线性的小增量，
  但**不会**改变帧时间对齐（导出是一帧一帧 await 的）。
- 一次都没声明 `composed` 的老卡片：导出路径**完全不变**（不解码、不多发消息）。
- 如果导出时媒体桥不可用（例如没有 DOM 的测试环境），合成帧为 `null`，卡片走降级（必要时
  退回 `rawFrame()`），导出不会中断。

**结论**：合成帧会把「声明了 composed 的转场卡覆盖的帧」拖慢，每帧几毫秒到十几毫秒；
它不会拖慢整条时间线（没有转场卡的区域零开销）。转场卡越短、媒体层越少、越好。

---

## 8. 两张验证卡

### `~/.dsh/motion-lib/sc-circle-match-iris/`

- 全画幅坐标一致：两侧都用 `cover` 铺满、不缩放不位移（卡片自己的绘制），所以 `(cx, cy)`
  在旧画面里是哪个像素，在新画面里还是那个像素——圆心匹配靠这个保证。
- 卡片声明了 `composed:'both'`：圆内是**邻镜合成帧**（含邻镜的位移 / 滤镜 / 文字叠层），
  不是素材原始帧。
- 切点前：旧画面 + 双脉冲环（越接近切点越亮）。
- 切点后：新画面从圆心扩散，带细描边和内侧柔光。
- 降级：合成失败 → 退回 `rawFrame()` 并在 debug 角标注明；两侧都没有 → 深色底 + 扩散光圈。

### `~/.dsh/motion-lib/sc-transition-hidden-cut/`

- 一条高光带扫过画面；**换画面的边界就是光带本身**（光带后侧是下一镜）。
- `cutAt` 时边界正好在画面中间，硬切藏在最亮处；前后各有一团闪白。
- 两条连续元素：光带上的尘点、一条贯穿全屏的细光轴，都只是 `t` 的函数，跨切点绝对连续。
- 也声明了 `composed:'both'`：光带两侧的「旧/新画面」都是合成帧，所以邻镜的调色/位移
  在切点两侧仍然连续（这正是藏切点需要的）。
- 降级：合成失败 → 退回 `rawFrame()`；没有邻帧时只是一次漏光扫过（仍然是一次可用过场），不抛错。

样张见 `.build/transition-composite-previews/`（由 `node scripts/transition-composite-test.mjs --preview`
生成，真实 Chromium Canvas2D 渲染；画面里的「邻帧」就是按 `player.drawFrame` 合成出来的）。

---

## 9. 测试

```bash
node scripts/transition-host-test.mjs              # 21 条原始帧契约测试（假桥 + 假 store）
node scripts/transition-host-test.mjs --preview    # 额外生成真实 PNG 样张（原始帧语义）
node scripts/transition-composite-test.mjs         # 20 条合成帧契约测试（假 drawFrame + 假日志）
node scripts/transition-composite-test.mjs --preview  # 合成帧真实样张
```

`transition-composite-test.mjs` 覆盖：缓存键（毫秒 + revision）/ `composed` 归一化 /
中文失败诊断 / 合成帧包含上层媒体与文字 / 缓存命中只合成一次 / LRU 4 淘汰 /
revision 失效 / 同键并发合并 / 无媒体失败 / drawFrame 抛错 / 超时 / 无画布 /
未声明 composed 零合成 / `composed:'prev'` 只合成 prev / worker 的 `frame()` 与 `rawFrame()` /
合成失败时 `frame()→null` + `composed:false` / 老卡零合成 / 导出与预览一致 /
位图 transfer 与旧帧释放。

---

## 10. 改动清单

- `src/client/code-registry.js`：`createCompositeFrameProvider` / `compositeFrameKey` /
  `composedFrameKey` / `normalizeComposedNeeds` / `composeReasonText`；
  `prepareSide` 增加合成分支；媒体桥新增 `composeNeighborFrame(globalTime, {clipId})`；
  `defaultContext` 带 `revision`；`composeStats` / `lastComposeDiagnostic` / `composeFrame` 对外暴露。
- `src/client/code-layer.js`：`transitionNeeds.composed` 的加载与上报；`env.transition` 门面新增
  `composed` / `rawFrame(t)`；帧表记录区分合成帧与原始帧。
- `src/client/player.js`：`drawFrame` 新增 `mediaFrame` 覆盖通道（合成取帧走同一条绘制路径），
  媒体绘制抽成 `paintMediaSource`（预览池与合成位图共用）。
- `scripts/transition-composite-test.mjs`（新）：上述 20 条测试、样张与真实耗时测量。
- 两张卡：`sc-circle-match-iris` / `sc-transition-hidden-cut`（声明 `composed:'both'`，
  合成失败退回 `rawFrame()`，debug 角标注明来源）。
- **未改** `domain.mjs`、`store.mjs`、`routes.mjs`、`src/client/main.js`。
