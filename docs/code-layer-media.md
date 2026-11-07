# 代码图层的媒体契约（code-layer media）

代码图层是 agent 写在 `<工程>/code/<layerId>.js` 里的模块，由 `src/client/code-layer.js`
放进 **Worker + OffscreenCanvas** 里执行。本文写清它现在能拿到什么媒体、这些媒体是什么、
什么时候准备好、拿不到时该怎么退化。

面向「口播 + 人物视频」「下级层压视频」「图片环」「画中画头像」这类配方：卡片不再要求
宿主把视频放进画布，而是通过 `env.media` 直接取**当前这一帧**的画面。

---

## 1. 模块签名

```js
export function setup(props, env) {}      // 可选：props 变化时重跑
export function render(ctx2d, t, env) {}  // 必须：t 秒，任意 seek 结果一致
export const media = (props) => ['asset_id']   // 可选：声明要用的素材
```

`env` 是同一个对象，每帧更新：

```js
{
  width, height,            // 画布尺寸（原有）
  props,                    // 图层 props（原有）
  t,                        // 当前图层局部时间（原有）
  fps,                      // 新增：工程帧率
  duration,                 // 新增：本片段时长（秒）
  assets: [                 // 新增：本工程素材浅清单
    { id, kind: 'video'|'image'|'audio'|'other', width, height, duration }
  ],
  media: {                  // 新增：媒体句柄（懒求值，只在调用时查表）
    has(id)   -> boolean,
    video(id) -> ImageBitmap | null,   // 已 seek 到当前合成时间的**帧**
    image(id) -> ImageBitmap | null,   // 静态图
    size(id)  -> { width, height } | null,
    kind(id)  -> 'video'|'image'|null, // 扩展
    time(id)  -> number | null,        // 扩展：这一帧在素材里的时间
  },
  transition: {             // 新增：转场上下文（见第 4 节）
    cutAt, prev: { has, clipId, reason, message, frame(t?) },
    next: { has, clipId, reason, message, frame(t?) },
  }
}
```

### 为什么 `video(id)` 不是 `HTMLVideoElement`

Worker 里没有 `document`，也就没有 `<video>`；把 DOM 搬进 worker 不成立。所以选型是：

**主线程负责「把视频驱动到正确的时间并抓帧」，worker 只拿到已经解码好的 ImageBitmap。**

- `ctx2d.drawImage(env.media.video(id), ...)` 在 worker 里和画视频帧完全等价（ImageBitmap
  本身就是 CanvasImageSource）。
- 契约里「必须已经 seek 到当前合成时间」这条语义由主线程保证，不是留给卡片自己去 seek。
- `media.time(id)` 让卡片能核对这一帧的实际时间（调试/断言用）。
- 句柄只在本次 `render` 调用内有效：下一帧会换成新位图，上一代位图会被释放。
  不要把它存进模块级变量跨帧复用。

---

## 2. 注入时机（一次 render 的生命周期）

```
drawFrame(ctx, view) / exporter / sampler
        │  frameLayers(clips, t) → layer.localT   ← 与合成器同一份时间轴
        ▼
code-registry.renderCode(rec, clip, localT)
        │  1. rec.layer.mediaNeeds()   ← worker 在 setup 后上报的 [{id}]
        │  2. mediaBridge.frames(needs, byId, localT)
        │       · 每个素材用**独立**的 <video> 元素
        │       · seek 到 mediaFrameTime(localT, 素材时长)，等 'seeked'
        │       · 核对 |currentTime - want| ≤ 0.25s，不合格就放弃这一帧
        │       · createImageBitmap(video / img)
        ▼
layer.render(localT, { media, assets, fps, duration })
        │  postMessage 的 transfer list 里带上所有 ImageBitmap
        ▼
worker.renderFrame()
        · 安装这一帧的帧表（先清空上一帧，不会读到残留）
        · 调 render(ctx2d, localT, env)
        · 画完清空上一代位图
```

要点：

- **时间基准**：`localT` 来自 `frameLayers`，和媒体图层、转场、变速共用同一个时间轴。
  预览、导出、采样三条路径因此画面一致。
- **预览是节流的**（playing 16ms / 暂停 40ms），导出是逐帧 `await` 的；
  两者都走 `renderCode`，不存在「导出时时间没对齐」的第二套逻辑。
- **独立视频池**：不复用 `player.js` 的预览池。预览池的 `<video>` 正被播放头驱动，
  代码图层若去 seek 同一元素，两边会互相拽 `currentTime`，画面会抖。
  代价是每个被声明的素材多一个静音 `<video>`（按需创建，`dispose()` 时释放）。
- **需求来源**：模块导出的 `media` 描述符在 `setup` 之后求值（可以是函数，也可是数组）。
  声明写坏了按「没有媒体需求」处理，不会让老卡片黑屏。
- `player.js` 的 `mediaDiagnostic` / `ensureVideos` 语义未改：代码图层的媒体是另一条通道。

---

## 3. 降级规则（卡片必须能优雅退化）

| 情况 | 宿主行为 | 卡片该看到 |
|---|---|---|
| `props.assetId` 没给 / 模块没导出 `media` | 不发媒体帧 | `has()` false，`video()` / `image()` null |
| 素材不在工程素材表里 | 跳过 | 同上 |
| 素材在，但 `<video>` 元数据/首帧还没到 | 超时（默认 2.5s）后放弃 | 同上 |
| 解码失败 / 编码不支持 | 捕获，放弃 | 同上 |
| seek 超时或落点偏差 > 0.25s | **放弃这一帧**（不拿上一帧冒充） | 同上 |
| 静态图加载失败 | 放弃 | 同上 |
| 媒体桥本身抛错 | 注册表捕获，`media` 为空 | 同上 |

任何一条路径都**不抛错**：`media.has` / `video` / `image` / `size` 对未知 id、`null`、
非字符串参数一律返回 `false` / `null`。卡片应在 `video()` 返回 `null` 时画占位
（示例卡就是这么做的），而不是让整帧变成 `RENDER_FAILED`。

老卡片（只读 `props`、不声明 `media`）行为完全不变：没有额外消息、没有额外解码、
`env` 里只是多了几个字段。

---

## 4. 转场上下文（`env.transition`）

「转场类」卡片不只是遮罩动画：它们要让**切点两侧对得上**（圆形匹配、藏切点）。
为此 `env` 多了一份转场上下文（设计细节与边界见 `docs/transition-host.md`）：

```js
export const transitionNeeds = () => ({ prev: true, next: true }); // 可选：声明要哪几侧

export function render(ctx2d, t, env) {
  const tr = env.transition;    // 永远存在；不读它 = 没有任何副作用
  tr.cutAt;                     // 切点在图层内的时间（秒，已夹到 [0, duration]）
  tr.composed;                  // false | 'prev' | 'next' | 'both'（模块声明要合成哪几侧）
  tr.prev.has;                  // 结构上有没有「前一镜」
  tr.prev.clipId;               // 那一镜的片段 id（没有则 null）
  tr.prev.reason;               // 'ok' | 'none' | 'no-media' | 'no-asset' | 'decode-failed' | 'timeout'
                                // | 'compose-failed' | 'compose-timeout'
  tr.prev.message;              // 中文诊断，可直接画在角落排查
  tr.prev.composed;             // 这一侧**实际**拿到的是不是合成帧
  tr.prev.frame(t?);            // 前一镜最后一帧（**合成帧**：含位移/滤镜/蒙版/叠层）；传 t → 原始素材帧
  tr.prev.rawFrame(t?);         // 同一时刻的原始素材帧（旧行为，卡可以自己比较）
  tr.next.frame();              // 后一镜第一帧（同上）
}
```

要点：

- **先声明，后解码。** 只有导出了 `transitionNeeds` 并声明了那一侧，宿主才会去取帧；
  没声明的模块拿得到结构信息，但 `frame()` 永远返回 `null`。老卡片完全不受影响。
- **要合成帧得再声明 `composed`。** `transitionNeeds = () => ({prev:true, next:true, composed:'both'})`。
  不写 `composed` 时 `frame()` 是**邻片段素材的原始帧**（旧行为，省一次整帧合成）；
  写了才会把邻镜的 transform / 滤镜 / 蒙版 / 上层媒体与文字叠层合成进去。
- **`has: true` 不等于有帧。** 相邻是文字卡 / 纯色卡 / 代码卡、素材缺失、seek 超时，
  都会出现 `has:true` + `frame():null`。卡片必须把这种情况当正常分支（走降级），
  而不是当错误。
- **合成失败也是正常分支。** 声明了 composed 但合成失败时，`frame()` 返回 `null`、
  `composed:false`、`message` 是中文原因；此时 `rawFrame()` 仍然可用，卡可以自己退回原始帧。
- **同步、可任意 seek。** `frame()` / `rawFrame()` 只返回「这一帧已经预取并送进 worker」的位图；
  `render` 里不能异步解码，所以不要在它们上面等任何东西。合成帧只预取默认帧（切点时刻）。
- **时间基准与 `media` 通道一致**：`localT` 来自 `frameLayers`，变速用同一个
  `sourceOffsetOf`，所以预览、导出、采样看到的是同一对帧。
- 邻帧同样**只在本次 `render` 调用内有效**，下一帧会被释放。

降级规则（卡片作者的最小要求）：

| 情况 | `has` | `frame()` | 卡片该做什么 |
|---|---|---|---|
| 时间线首端 / 末端 | `false` | `null` | 画普通光圈 / 擦除，不假装匹配 |
| 相邻是纯色卡 / 文字卡 | `true` | `null` | 同上，或用 `reason` 画一行调试提示 |
| 素材缺失 / 超时 / 解码失败 | `true` | `null` | 同上 |
| 两侧都有 | `true` | 位图 | 完整效果 |

两张示例卡：`~/.dsh/motion-lib/sc-circle-match-iris/`（圆心匹配光圈）与
`~/.dsh/motion-lib/sc-transition-hidden-cut/`（扫光藏切点）。

## 5. 示例卡（`~/.dsh/motion-lib/`）

### `media-pip` —— 画中画

```js
export function media(props) {
  return props && props.assetId ? [String(props.assetId)] : [];
}

export function render(ctx, t, env) {
  const id = env.props && env.props.assetId;
  const src = id && env.media ? env.media.video(id) : null;
  // src 为 null 时画虚线占位框（带原因文字）
  // 有 src 时：右下角、按 media.size 的真实比例（未知时回落 16:9）、圆角裁切、0.5s 淡入
}
```

实测（Node 桩环境，见 `scripts/code-layer-media-test.mjs`）：

- 有媒体：`drawImage` 被调用一次，目标矩形在右下角，`globalAlpha` 随 `t/0.5` 从 0 到 1；
- 无媒体：不抛错，画占位框与「素材未就绪或不存在」；
- `props.assetId` 缺失：不抛错，占位框写「props.assetId 未设置」。

### `media-fullscreen-kenburns` —— 全屏缓慢推镜

```js
// cover 铺满，再乘 1 + 0.08 * clamp(t / duration)
```

- 有媒体：铺满整帧，随时间从 1.0 缓慢放大到 1.08（`duration` 缺省取 `env.duration`）；
- 无媒体 / 缺 `props`：画深色占位底，不抛错。

两张卡的 `props` 都只有 `assetId`（可选 `scale` / `duration`）。

---

## 6. 已知边界

- 每一帧都要 `seek + createImageBitmap`，代价比直接画 `<video>` 高；预览已按 16/40ms
  节流，导出是逐帧严格等待。素材很多的长片段导出会慢，这是「时间必须精确」的代价。
- 帧落点精度取决于浏览器的 seek 行为，通常在一帧以内；偏差超过 0.25s 时宁可画占位。
- `media` 描述符只在 `setup`（含 props 更新）后重新求值，不会每帧调用。若需求依赖
  运行中的时间，请在 `render` 里用 `env.assets` / `props` 自行选择，而不是改声明。
- Worker 内 `media.video()` 拿到的是位图，没有 `duration` / `currentTime` 属性；
  素材级信息请用 `env.assets`。

---

## 7. 相关测试

```bash
node scripts/code-layer-media-test.mjs   # 新契约：注入、降级、时间对齐、示例卡
node scripts/code-layer-test.mjs         # 老契约回归
```

`code-layer-media-test.mjs` 覆盖：

1. `env` 新字段齐全（fps / duration / assets / media）；
2. 素材缺失时 `has/video/image/size/kind/time` 返回 false/null 且不抛；
3. 老卡片（只读 props）在没有 media 时行为不变；
4. `assets` 清单结构（id / kind / width / height / duration）；
5. 时间对齐：给定 `localT`，帧时间落在期望区间；
6. 位图经 transfer list 送达 worker；
7. 上一帧的媒体不会残留到下一帧；
8. 两张示例卡在「有媒体 / 无媒体 / props 缺失」三种情况都不抛，无媒体时画占位；
9. `assetSummary` / `mediaFrameTime` 纯函数；
10. 注册表在媒体桥失败时降级为空媒体。

转场上下文单独有一套（21 条，含假桥、假 store、真实样张）：

```bash
node scripts/transition-host-test.mjs
node scripts/transition-host-test.mjs --preview
```

合成帧（`transitionNeeds.composed`）另有一套 20 条：

```bash
node scripts/transition-composite-test.mjs
node scripts/transition-composite-test.mjs --preview   # 真实样张 + Chromium 实测耗时
```
