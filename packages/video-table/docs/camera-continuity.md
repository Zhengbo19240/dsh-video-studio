# 摄像机连续性（camera continuity）

> 给「运镜」定一个出入口契约。结论先行：**每张会移动画面的卡都必须声明它在第一帧和最后一帧的机位，
> 并且片尾真的落在那里。** 只有入口没有出口的运镜，会让下一镜的第一帧把 scale / 位置拽回去 ——
> 肉眼就是用户说的「卡一下，然后感觉位置变了」。

本文只讲机制与红线；实现见 `src/camera.mjs`、`src/camera-tools.mjs`，测试见
`scripts/camera-continuity-test.mjs`。

---

## 1. 问题现场

用户原话：

> 放大这个动效比如这两秒缓缓放大，没有缓缓返回，这样即使一个画面同样代码也会卡一下，然后感觉位置变了。
> 有的比如需要放大到一个部位运镜几秒然后返回全局视图。

实测（30fps，修复前）：

| 卡 | 首帧 scale | 末帧 scale | 下一镜首帧 | 边界跳变 |
|---|---|---|---|---|
| `tc-slow-push-in`（push，5.8s） | 1.0000 | **1.0996**（t=5.8 时 1.1000） | 1.0000 | **0.0996** |
| `media-fullscreen-kenburns`（6s） | 1.0000 | **1.0796**（t=6 时 1.0800） | 1.0000 | **0.0796** |

两张卡都只做了单向 ramp：推到 1.10 / 1.08 就停住，没有任何字段说明「这一镜结束时镜头在哪」，
下一镜自然从 1.0 起。同一段代码连续用两次时，第二次又从 1.0 开始，于是每一刀都跳一次。

根因不是缓动写得不好，是**状态没有出口**。

---

## 2. 契约

### 2.1 卡片声明

每张卡的 `code.js` 导出：

```js
export const camera = {
  in:  { scale: 1.0, x: 0, y: 0 },   // 第一帧的机位
  out: { scale: 1.0, x: 0, y: 0 },   // 最后一帧的机位（省略 = 恒等 1/0/0）
};
```

- `scale`：相对全画幅的放大倍数，1 = 原始构图。
- `x` / `y`：画面偏移，单位是**画幅比例**（0.1 = 画宽的 10%），不是像素。
  这样同一张卡在 720p / 1080p 下声明值不变；卡内要像素时自己乘 `W` / `H`。
- `camera` 也可以是 `(props) => ({ in, out })`，用于一张卡多种形态（例如 `direction:'pull'`）。
- 单片段可以覆盖：`clip.props.camera`，优先级最高。
- 没声明 = 恒等机位，**老卡不算错**。

### 2.2 曲线自证（可选，但推荐）

```js
export function cameraAt(t, duration, props) {
  return { scale, x, y };
}
```

卡片导出它，宿主 `video_camera_check` 就会**真的按卡片的曲线采样首尾帧**，
再和 `camera.out` / `camera.in` 比对。声明与曲线不一致时，检查器会单独报
「声明说了谎」——这比像素对比便宜，也比相信注释可靠。

不导出也能工作：检查器退回声明值。但那样只能验证「声明之间接不接得上」，
验证不了「画面真的落在声明上」。

### 2.3 检查器

`video_camera_check({ projectId?, trackId?, eps? })`（只读）：

- 扫时间线上**首尾相接**的片段（中间有黑场的不算一次切），逐对比 `prev.out` 与 `next.in`；
- 返回 `{ pairs, broken, total, warnings, declarations }`；
- 不通过**不阻止播放**，只给可读警告；`declarations` 单独列「声明与曲线不符」的片段；
- 宿主侧同一逻辑在 `checkProjectCamera()`，路由 `camera.check` 直接复用（预览面板可以调）。

---

## 3. 往返运镜的标准曲线

用户要的「放大到部位几秒，再回全局」用 `cameraKeyframes()` 生成：

```js
import { cameraKeyframes, cameraAt } from '../src/camera.mjs';

const shot = cameraKeyframes({
  duration: 5.8,
  zoomTo: 1.10,                 // 进入段的倍数
  center: { x: -13 / 960, y: -7 / 540 },  // 停留时的画幅偏移（比例）
  enter: 0.25, hold: 0.40, exit: 0.35,    // 默认比例
});
const cam = cameraAt(t, 5.8, shot);
```

三段：

```
进入（enter，默认 25%）→ 停留（hold，默认 40%）→ 返回（exit，默认 35%）
```

- **进入段**用 `easeOutCubic`：起手就有速度，到位收住（`t = enterEnd` 处一阶导 = 0）。
- **停留段**速度恒为 0（两端都是 1 的常数段）。
- **返回段**用 `easeInCubic` —— 它正好是 `easeOutCubic` 的**时间镜像**：
  `g(v) = 1 − f(1 − v)`。于是「同一时刻的 scale 互为镜像」：
  `exit(v) = enter(1 − v)`，误差在 1e-16 量级。
  返回段起点速度 = 进入段终点速度 = 0，和停留段接得上；落点速度 = 进入段起点速度（同一条曲线倒放）。
- 想落点更稳（比如这一镜是最后一镜、后面没有切点）可以传 `exitEase: 'easeInOutQuad'`：
  两端速度都为 0，但此时返回段**不再**是进入段的严格镜像 —— 二选一，文档写清，不偷偷替换。

为什么必须镜像：不镜像的返回段（比如线性、或者随便一个 easeInOut）在 hold 结束时会「重新起步」，
观众看到的是「停住 → 猛地往回」，也就是「回得生硬」。镜像让返回看起来是同一口气倒放。

---

## 4. 红线（写成规则，不靠自觉）

1. **禁止片尾停在非 `out` 值。**
   卡片最后渲染的那一帧的 scale / 偏移必须精确等于 `camera.out`。
   注意「最后一帧的时间通常不是 `duration`」：帧网格对齐会差半帧到一帧。
   做法是**片尾前 1.5 帧收干并钉死**（`tc-slow-push-in`、`media-fullscreen-kenburns` 都这么做），
   而不是写 `t / duration` 然后祈祷采样点正好等于 duration。

2. **禁止用 `progress < X ? a : b` 这种分段硬切做运镜。**
   分段可以有自己的缓动，但段与段之间必须一阶连续（速度为 0 或两端相等）。
   硬切会让画面在切换那一帧「弹」一下 —— 这正是「卡一下」的另一种来源。

3. **往返必须镜像。**
   返回段要么是进入段的时间镜像（`easeInCubic`），要么两端速度都为 0（`easeInOutQuad`）。
   不允许「进入有缓动、返回线性」。

4. **hold 段两端一阶导必须 ≈ 0。**
   进入段收不住、返回段起不来，都会在 hold 边界抽一下。

5. **跨镜必须 `prev.out ≈ next.in`**（默认容差 1e-3）。
   不满足时不许默认「观众看不出来」：跑 `video_camera_check`，把跳变数值写成可读警告。

6. **声明必须与曲线一致。**
   `camera.out` 写 1.0、`cameraAt(duration)` 给 1.08，比不声明更坏 —— 检查器会报
   `declarations`，路过的每一双眼睛都会被误导。

---

## 5. 两种修法（都合法，选一种）

| 场景 | 修法 | 例子 |
|---|---|---|
| 镜头要回到原来的构图（用户说的「返回全局视图」） | 片尾回到 `1.0`，与 `in` 一致 | `tc-slow-push-in`（进 → 停 → 回，末帧 1.000） |
| 镜头是「推上去就不回来」的一整镜，后面接同一机位的续镜 | 声明 `out`，让片尾**精确**停在 `out`；下一镜 `in` 写同一个值 | `media-fullscreen-kenburns`（`out: 1.08`，末帧 1.080；下一镜 `in: 1.08` 时 Δ=0） |

第二种不是「不修」，是**把状态说清楚**：以前下一镜从 1.0 起，是因为没人知道上一镜停在 1.08。
现在陈明了，检查器会在下一镜没接上时报出来。

`media-fullscreen-kenburns` 额外提供 `direction:'return'`：片尾回到 1.0（进 → 停 → 回），
接普通 1.0 素材时用它。

---

## 6. 实现与边界

- `src/camera.mjs`：纯函数。`cameraAt` / `cameraKeyframes` / `cameraContinuity` /
  `scanCameraContinuity` / `mirrorEase` / `cameraVelocityAt`。不读盘、不渲染。
- `src/camera-tools.mjs`：`video_camera_check`（只读）与 `video_camera_keyframes`（只读）。
  卡片模块按 `文件 + mtime` 缓存；读不到 / 语法坏 / 顶层抛错都按「没有 camera 声明」处理。
- **不做像素对比**。检查器比的是机位声明与曲线，不是两帧像素：像素对比要浏览器、
  对整条时间线太贵，而且「机位接没接上」本来就是一个数值问题。
  转场宿主（`docs/transition-host.md`）的 composed frame 解决的是「邻镜长什么样」；
  这里解决的是「邻镜的镜头在哪」，两者共用同一套「按时间取邻接片段」的边界语义。
- **不改播放**。检查不通过只是警告；时间线、导出、预览都不受它影响。
- 有间隙（中间空档 > 1ms）的两段不算一次切，不参与比较 —— 那本来就该黑场。

---

## 7. 本地验证

```bash
node scripts/camera-continuity-test.mjs    # 曲线 / 连续性 / 扫描 / 工具 / 两张示范卡
node scripts/camera-continuity-test.mjs --verbose   # 逐条打印
```

覆盖（≥14 条）：端点精确相等、三段比例、hold 两端速度为 0、进入/返回镜像、
`cameraContinuity` 的 1.6→1.0 判定、缺省 camera、`mirrorEase` 端点与中点对称、
构造时间线上的 broken 计数、返回值无损 JSON、两张示范卡的声明与末帧。
