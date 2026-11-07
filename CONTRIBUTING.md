# 贡献指南

## 先跑起来

```bash
npm install
npm run build          # 生成 packages/video-table/client.js
npm test               # 阶段机测试（最快的一条回归线）
```

## 改动前先读这三件事

1. **工程文档只有一份。** 所有改动都必须经过 `preview → apply → undo`，不要在 UI 或工具里直接改 JSON。`src/store.mjs` 是唯一写入点，`src/domain.mjs` 是纯函数层。
2. **跨进程的返回值只放小标量。** 帧和媒体字节走媒体路由或采样接口，不要把 Buffer 塞进工具返回值。
3. **代码图层必须是 `t` 的纯函数。** 任意 seek 结果一致；不能依赖上一帧的状态。

## 提交什么

- Bug 修复：附一个能复现的最小工程或测试；如果涉及画面，给一张改前 / 改后帧。
- 新动效卡：放在 `packages/motion-lib/<id>/`，必须有 `code.js` 与 `meta.json`；`meta.json` 的 `source` / `license` / `author` 必须写清楚。第三方移植请保留原许可与署名。
- 文档：`docs/` 下按现有编号与语气写；不要贴本机绝对路径，用 `~/.dsh/...` 或环境变量名。

## 不要提交

- `node_modules/`、`client.js`、`.build/`、`reports/`、任何 `*.mp4` / 证据 PNG。
- 音频二进制（`*.ogg` / `*.mp3` / …）。音效走 `packages/sound-library` 的下载脚本。
- API key、cookie、带个人路径的工程文件。Freesound key 只从 `FREESOUND_API_KEY` 读，绝不写进代码或配置示例。

## 测试约定

- `packages/video-brief`：`npm test` 必须全绿，不允许跳过。
- `packages/video-table/scripts/*-test.mjs`：自包含、用临时目录、不写用户的真实工程。需要 ffmpeg / Chromium 的脚本要在缺依赖时**明确说明并退出**，不能假装通过。
- 新测试请优先用「断言行为」而不是「断言文件哈希」；基线指纹只用于保护已标定的卡。

## 提交信息

```
<area>: <做了什么>

为什么这么做，以及怎么验证的。
```

`area` 用 `table` / `brief` / `motion-lib` / `sound-library` / `docs`。

## 许可

提交代码即表示同意以 MIT 分发。提交第三方素材时，请确认许可允许再分发，并在 `meta.json` 里写明。
