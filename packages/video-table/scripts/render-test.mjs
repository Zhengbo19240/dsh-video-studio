import React from "react";
import { renderToString } from "react-dom/server";
import { Workbench, DockEntry } from "../src/client/main.js";
import { state, setState } from "../src/client/bridge.js";

globalThis.window = { addEventListener() {}, removeEventListener() {}, prompt: () => null };
globalThis.document = { createElement: () => ({ getContext: () => ({}), style: {} }) };
globalThis.fetch = async () => ({ json: async () => ({ ok: true, value: {} }) });
globalThis.EventSource = class { addEventListener() {} removeEventListener() {} close() {} };

const doc = {
  projectId: "vp_1", title: "验收工程", revision: 3, boundSessionId: "s1", ratio: "16:9", fps: 30, duration: 8.5,
  root: "D:/验收工程",
  tracks: [
    { id: "v1", kind: "video", name: "主轨", clips: ["c1"] },
    { id: "c1", kind: "code", name: "代码图层", clips: ["c2"] },
    { id: "a1", kind: "audio", name: "音频", clips: [] },
    { id: "t1", kind: "text", name: "字幕", clips: ["c3"] },
  ],
  annotations: [{ id: "an1", range: { start: 1, end: 2.5 }, expected: "这里太吵", status: "open", intent: "change" }],
  assets: [{ id: "asset_1", name: "a.mp4", path: "assets/a.mp4", mime: "video/mp4", probe: { duration: 5, width: 1920, height: 1080 } }],
  clips: [], assets2: null,
};
const clips = [
  { id: "c1", trackId: "v1", type: "media", assetId: "asset_1", start: 0, duration: 4, sourceIn: 0 },
  { id: "c2", trackId: "c1", type: "code", layerId: "ly1", start: 2, duration: 3, props: {} },
  { id: "c3", trackId: "t1", type: "text", text: "你好", start: 1, duration: 2 },
];

setState({ projectId: "vp_1", sessionId: "s1", doc, clips, assets: doc.assets, playhead: 1.2, zoom: 70, selection: { kind: "clip", id: "c1" }, busy: null, toast: null, error: null });

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ok   " + name); } catch (e) { fail++; console.log("  FAIL " + name + " :: " + e.message); } };

t("工作台首屏可渲染", () => {
  const html = renderToString(React.createElement(Workbench));
  if (!html.includes("验收工程")) throw new Error("没有标题");
  if (!html.includes("素材")) throw new Error("没有素材区");
  if (!html.includes("主轨")) throw new Error("没有轨道头");
  if (html.length < 2000) throw new Error("输出过短 " + html.length);
});

t("选中片段时检查器显示片段属性", () => {
  const html = renderToString(React.createElement(Workbench));
  if (!html.includes("片段")) throw new Error("检查器缺片段标题");
});

t("空工程也能渲染（不崩）", () => {
  setState({ doc: null, clips: [], assets: [] });
  const html = renderToString(React.createElement(Workbench));
  if (!html.includes("视频工作台")) throw new Error("空态没有标题");
});

t("对话框入口可渲染", () => {
  const html = renderToString(React.createElement(DockEntry, { sessionId: "s1" }));
  if (!html.includes("视频工作台")) throw new Error("入口没有标题");
});

// ---- 选择面板（没进入工程时的那一屏）----
// 选择面板的额度计数只数 origin:'panel'（新语义）；fixture 必须标清楚，
// 否则两条都按历史/agent 记录解释，已用会显示 0/2。
const otherEntry = { projectId: "vp_2", root: "D:/别的工程", title: "别人的工程", sessionId: "abcdef1234567890", origin: "panel", since: "2026-11-01T00:00:00Z" };
setState({
  sessionId: "s1",
  projectId: "vp_1",
  doc,
  clips,
  assets: doc.assets,
  active: false,
  enabled: [
    { projectId: "vp_1", root: "D:/验收工程", title: "验收工程", sessionId: "s1", origin: "panel", since: "2026-11-01T00:00:00Z" },
    otherEntry,
  ],
  max: 2,
  mine: [doc],
  playhead: 0,
  selection: null,
  busy: null,
  toast: null,
  error: null,
});

t("选择面板显示「已用 N/2」与全局上限", () => {
  const html = renderToString(React.createElement(Workbench));
  if (!html.includes("已用 2/2")) throw new Error("没有额度计数");
  if (!html.includes("全局最多 2 个工程")) throw new Error("没有上限说明");
});

t("选择面板：本会话工程卡有标题/路径/摘要/状态/四个按钮", () => {
  const html = renderToString(React.createElement(Workbench));
  if (!html.includes("验收工程")) throw new Error("没有标题");
  if (!html.includes("D:/验收工程")) throw new Error("没有路径");
  if (!html.includes("r3 · 8.50s · 30fps · 16:9")) throw new Error("没有摘要行");
  if (!html.includes("已启用")) throw new Error("没有状态");
  for (const label of ["启用", "进入", "停止启用", "重命名"]) {
    if (!html.includes(label)) throw new Error("缺按钮: " + label);
  }
});

t("选择面板：其他会话的工程只读列出并标出会话（前 5 + 末 4）", () => {
  const html = renderToString(React.createElement(Workbench));
  if (!html.includes("别人的工程")) throw new Error("没有列出占用者");
  if (!html.includes("会话 abcde…7890")) throw new Error("没有会话标识（前 5 + 末 4）");
  if (!html.includes("其他会话已启用的工程")) throw new Error("没有只读区标题");
});

t("选择面板：agent 打开的工程不占额度，单独一行说明", () => {
  // 语义第 4 条：已用只数 origin==='panel'，agent 占的另起一行说明。
  setState({
    enabled: [
      { projectId: "vp_1", root: "D:/验收工程", title: "验收工程", sessionId: "s1", origin: "panel", since: "2026-11-01T00:00:00Z" },
      { projectId: "vp_a", root: "D:/agent/a", title: "agent 工程A", sessionId: "s9", origin: "agent", since: "2026-11-02T00:00:00Z" },
      { projectId: "vp_b", root: "D:/agent/b", title: "agent 工程B", sessionId: "s9", origin: "agent", since: "2026-11-02T00:00:00Z" },
    ],
    max: 2,
  });
  const html = renderToString(React.createElement(Workbench));
  if (!html.includes("已用 1/2")) throw new Error("agent 占的工程被算进额度了");
  if (!html.includes("另有 2 个由 agent 打开（不占额度）")) throw new Error("没有 agent 单独说明");
});

t("选择面板：未进入时不挂工作台（没有播放/导出 MP4）", () => {
  const html = renderToString(React.createElement(Workbench));
  if (html.includes("导出 MP4")) throw new Error("没进入也挂了工作台");
  if (html.includes("回到对话")) throw new Error("没进入也渲染了工作台顶栏");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
