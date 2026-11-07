# dsh-video-workbench

DSH 原生的视频工作台。一句话：**工程文档只有一份，在 Host；对话里的 agent 和界面里的你，改的都是它。**

## 现在能做什么

| 能力 | 状态 |
|---|---|
| 工程文档（JSON + revision + boundSessionId + 目录守卫） | ✅ |
| 命令引擎（17 条：轨道/片段/素材/标注/画幅） | ✅ |
| 事务：preview → apply → undo（一次手势一步撤销） | ✅ |
| 会话绑定（工具侧硬校验 / 面板侧提示） | ✅ |
| 对话页入口（composer 上方）+ 工作台面板 | ✅ |
| 素材导入（拖拽/选择，XHR 真实进度）+ 扫描 assets 目录 | ✅ |
| 预览播放（canvas 合成：视频轨 + 文字叠加；解码中显式提示） | ✅ |
| 时间线：拖动移动、拖边裁剪、播放头、缩放、标注条、片段名、淡入淡出 | ✅ |
| 检查器：起止/时长/源入点/不透明度/音量、分割、删除、来源卡片 | ✅ |
| 标注：＋标注（框选时间段 + 写"希望怎么改"）、状态切换 | ✅ |
| 导出：WebCodecs → MP4（H.264 + AAC）/ WebM（VP9 + Opus）+ 进度条 + 音频降级 | ✅ |
| Agent 工具 8 个（inspect/preview/apply/undo/annotation…） | ✅ |
| 代码图层：agent 写 JS → Worker 沙箱实时渲染 → 预览/导出都走同一条合成 | ✅ |
| 采样：agent 要帧 → 面板渲染 → 落盘 → agent 用 read_image 看 | ✅ |
| 音频：播放混音 + 导出混音（48k 立体声 → AAC/Opus） | ✅ |

## 构建与安装

`client.js` 是构建产物，**不在 git 里**（源码在 `src/client/*.js`）。拿到仓库后必须先构建：

```bash
npm i                           # esbuild 等
node scripts/build-client.mjs   # src/client/*.js → client.js（lazy-CJS factory）
```

安装：`plugin_manager install_bundle`，或对已安装实例 `set_plugin enabled=false→true` 重新激活 host 半。
客户端 bundle 随页面加载，**改完客户端要刷新页面**。

## 自测

```bash
node scripts/smoke.mjs            # 14 项：命令引擎/事务/撤销/绑定/路径守卫
node scripts/route-test.mjs       # 9 项：HTTP RPC 全链路（含 400 冲突语义）
node scripts/media-test.mjs       # 18 项：扫描/导入/哈希/Range/路径逃逸
node scripts/export-test.mjs      # 14 项：导出管线（帧数/进度/中止/兜底/音轨 6 项）
node scripts/client-load-test.mjs # 客户端 bundle 装载 + 两个座位注册
node scripts/sample-test.mjs      # 5 项：采样请求/回传/超时
node scripts/code-store-test.mjs  # 7 项：代码图层落盘 + 命令
node scripts/e2e-test.mjs         # 9 项：导入→探测→Range→插入→采样 全链路
node scripts/audio-test.mjs       # 10 项：音频调度/淡入淡出/混音
node scripts/code-layer-test.mjs  # 10 项：Worker 沙箱/虚拟时钟/超时
```

## 结构

```
index.js            host 入口：装配 store / routes / tools
src/domain.mjs      纯函数：文档、命令、不变量、diff
src/store.mjs       唯一真相：打开/落盘、事务、撤销、目录守卫、会话绑定
src/routes.mjs      RPC / SSE / 媒体 Range / 导入
src/media.mjs       素材落盘与守卫（独立模块）
src/tools.mjs       8 个原生 DSH 工具
src/client/         bridge（唯一出口）/ player / timeline / panels / exporter / main
```

## 设计约束（改代码前先读）

1. 工具返回值只放小标量；帧与媒体字节永远走媒体路由或采样接口。
2. 每次修改都必须 preview → apply；UI 与 agent 同一条路径、同一个撤销栈。
3. 工程目录之外的路径任何命令都不许碰（`resolveAssetPath` 唯一守卫）。
4. 工程与会话一一绑定；跨会话打开必须被拒绝。
5. 预览黑屏 = bug：解码未就绪时必须画显式提示，不能留空。

## 验收清单（5 分钟）

1. 刷新页面 → 新建会话选「视频剪辑」预设
2. 会话头部切到「视频工作台」→「新建视频工程」→ 选父目录
3. 拖入一个 mp4 → 出现素材卡（有进度条）→「加入主轨」
4. 再拖一个 →「画中画」→ 预览右下出现小窗
5. 播放（有声音）→ 拖片段 / 拉两端裁剪
6. 选中片段：拉亮度/色温/暗角、选蒙版圆形、打两个关键帧并选「缓入缓出」
7. 顶部「＋文字」→ 改字号颜色 →「把当前样式应用到所有字幕」
8. 顶部「导入字幕(.srt)」→ 字幕轨批量出现 → 「导出字幕(.srt)」
9. 顶部「诊断」→ 截一张能力面板（留底）
10. 顶部「导出 MP4」→ 看进度（混音→编码→封装）→ 下载 → 检查提示里的音轨
11. 顶部「操作记录」→ 点最近一条 → 验证撤销
12. 完全退出 DSH 再打开 → 回到同一会话 → 工程应自动恢复
13. 检查器底部「删除工程」→ 先试「只解绑」，再试「连文件删」
## 故障与回退

插件曾导致 DSH 启动崩溃：崩溃日志为 web boot: 1 entry did not activate（entry 卡在 loading）。
DSH 把「未激活的插件 row」当作 web boot 的致命错误，而当时 apply() 没有任何兜底：
任一注册动作抛错（例如重复注册路由/工具）就让整次启动失败。

现在：
- host apply() 全程 try/catch；路由与每个工具分别注册、分别兜住，单个失败只写日志
- client bundle 的 factory 也包了 try/catch，失败时返回空插件，绝不拖住 boot
- 环境变量 DSH_VIDEO_WORKBENCH_DISABLE=1 可让 host 半边直接不激活
- 客户端启动会向 /api/video/beacon 留痕，落在 ~/.dsh/video-workbench-client.log

回退方式（任选其一）：
1. plugin_manager set_plugin include:video-workbench enabled=false
2. 设置 DSH_VIDEO_WORKBENCH_DISABLE=1 后重启
3. plugin_manager remove_bundle dsh-video-workbench
