/**
 * 音效库面板的服务端渲染断言。
 *
 * 方式照 scripts/render-test.mjs：起一份假 window/document，用
 * react-dom/server 把组件渲成 HTML，再对字符串做断言。
 *
 *   node scripts/sound-panel-test.mjs
 */

import React from "react";
import { renderToString } from "react-dom/server";
import {
  SoundLibrary,
  SOUND_EMPTY_LOCAL_TEXT,
  soundDurationText,
  soundEmptyReason,
  soundErrorText,
  soundPreviewPlan,
  soundSourceLabel,
} from "../src/client/panels.js";
import { Workbench } from "../src/client/main.js";
import { setState } from "../src/client/bridge.js";

globalThis.window = { addEventListener() {}, removeEventListener() {}, prompt: () => null };
globalThis.document = { createElement: () => ({ getContext: () => ({}), style: {} }) };

// 宿主侧契约还没接上时，rpc 会失败；这里记下调用次数用于验证「未展开不请求」。
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  return {
    json: async () => ({
      ok: false,
      error: { code: "NO_SUCH_METHOD", message: "宿主侧还没有 sound.search" },
    }),
  };
};
globalThis.EventSource = class {
  addEventListener() {}
  removeEventListener() {}
  close() {}
};

const doc = {
  projectId: "vp_1",
  title: "验收工程",
  revision: 3,
  boundSessionId: "s1",
  ratio: "16:9",
  fps: 30,
  duration: 8.5,
  tracks: [
    { id: "v1", kind: "video", name: "主轨", clips: ["c1"] },
    { id: "a1", kind: "audio", name: "音频", clips: [] },
  ],
  annotations: [],
  assets: [],
  clips: [],
};
const clips = [
  { id: "c1", trackId: "v1", type: "media", assetId: "asset_1", start: 0, duration: 4, sourceIn: 0 },
];

setState({
  projectId: "vp_1",
  sessionId: "s1",
  doc,
  clips,
  assets: [],
  playhead: 1.2,
  zoom: 70,
  selection: null,
  busy: null,
  toast: null,
  error: null,
});

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log("  ok   " + name);
  } catch (e) {
    fail += 1;
    console.log("  FAIL " + name + " :: " + e.message);
  }
};

const renderPanel = (props) =>
  renderToString(React.createElement(SoundLibrary, Object.assign({ projectId: "vp_1", sessionId: "s1", playhead: 1.2 }, props)));

const collapsed = renderPanel({});
const expanded = renderPanel({ defaultOpen: true });
// 来源固定为 Freesound 时才该出现排序下拉；纯 SSR 跑不出 effect，所以用 defaultSource 直接给定
const freesoundPanel = renderPanel({ defaultOpen: true, defaultSource: "freesound" });

t("折叠头显示「音效库」", () => {
  if (!collapsed.includes("音效库")) throw new Error("没有面板标题");
  if (!collapsed.includes("展开")) throw new Error("没有展开提示");
});

t("未展开时不请求 RPC，也不渲染搜索框", () => {
  const before = fetchCalls;
  if (collapsed.includes("搜音效")) throw new Error("折叠时不该出现搜索框");
  if (fetchCalls !== before) throw new Error("折叠时发生了 RPC 调用 " + (fetchCalls - before) + " 次");
  if (fetchCalls !== 0) throw new Error("首次渲染就请求了 RPC：" + fetchCalls);
});

t("展开后渲染搜索框 / 来源下拉 / 最长时长", () => {
  if (!expanded.includes("搜音效…")) throw new Error("没有搜索框 placeholder");
  if (!expanded.includes("Freesound")) throw new Error("没有来源选项");
  if (!expanded.includes("最长时长")) throw new Error("没有最长时长输入");
  if (!expanded.includes("全部")) throw new Error("没有「全部」来源");
});

t("展开后有 URL 导入输入框与「导入链接」按钮", () => {
  if (!expanded.includes("粘贴音效直链")) throw new Error("没有导入输入框");
  if (!expanded.includes("导入链接")) throw new Error("没有导入按钮");
  if (collapsed.includes("导入链接")) throw new Error("折叠时不该出现导入按钮");
});

t("展开后有「获取音效包」入口，折叠时不渲染", () => {
  if (!expanded.includes("获取音效包")) throw new Error("没有 Kenney 入口");
  if (!expanded.includes("kenney.nl")) throw new Error("没有 CC0 来源说明");
  if (collapsed.includes("获取音效包")) throw new Error("折叠时不该出现 Kenney 入口");
});

t("结果区带 maxHeight 内部滚动（不让面板撑高整页）", () => {
  if (!expanded.includes("max-height:260px")) throw new Error("结果区没有 maxHeight:260px");
  if (!expanded.includes("overflow-y:auto")) throw new Error("结果区没有内部滚动");
});

t("local 条目：拿到 /api/video/sound 的 url 就可播", () => {
  const plan = soundPreviewPlan(
    { id: "local_1", provider: "local", title: "关门声", duration: 1.8 },
    { kind: "url", url: "/api/video/sound?entryId=local_1" },
  );
  if (!plan.playable) throw new Error("拿到 url 的 local 条目应可播");
  if (plan.url !== "/api/video/sound?entryId=local_1") throw new Error("url 没被采纳：" + plan.url);
  if (plan.kind !== "url") throw new Error("kind 应为 url：" + plan.kind);
});

t("拿到不到 url（旧 {kind:file} / 缺 url / 抛错）就禁用并给说明", () => {
  const file = soundPreviewPlan(
    { id: "local_2", provider: "local", title: "关门声" },
    { kind: "file", path: "D:/proj/assets/sfx/door.wav" },
  );
  if (file.playable) throw new Error("kind:file 不该被判为可播");
  if (file.url !== "") throw new Error("不该拼出 URL：" + file.url);
  if (file.title !== "这条音效暂不支持试听") throw new Error("禁用说明不对：" + file.title);

  const noUrl = soundPreviewPlan({ id: "local_3", provider: "local" }, { kind: "url" });
  if (noUrl.playable) throw new Error("没有 url 也被判为可播");
});

t("freesound 条目：拿到 url 才可播", () => {
  const ok = soundPreviewPlan({ id: "fs_1", provider: "freesound" }, { kind: "url", url: "https://cdn.example/a.mp3" });
  if (!ok.playable || ok.url !== "https://cdn.example/a.mp3") throw new Error("freesound url 没被采纳");
  const bad = soundPreviewPlan({ id: "fs_2", provider: "freesound" }, { kind: "url" });
  if (bad.playable) throw new Error("没有 url 也被判为可播");
});

t("时长与来源文案", () => {
  if (soundDurationText(1.8) !== "1.8s") throw new Error("1.8 → " + soundDurationText(1.8));
  if (soundDurationText(null) !== "时长未知") throw new Error("null 应显示时长未知");
  if (soundDurationText(0) !== "时长未知") throw new Error("0 应显示时长未知");
  if (soundSourceLabel("local") !== "本地") throw new Error("local 标签不对");
  if (soundSourceLabel("freesound") !== "Freesound") throw new Error("freesound 标签不对");
});

t("工作台里挂在动效库与素材之间", () => {
  const html = renderToString(React.createElement(Workbench));
  const motion = html.indexOf("动效库");
  const sound = html.indexOf("音效库");
  const media = html.indexOf("素材");
  if (motion < 0 || sound < 0 || media < 0) throw new Error("侧栏缺面板 " + JSON.stringify({ motion, sound, media }));
  if (!(motion < sound && sound < media)) throw new Error("顺序不对 " + JSON.stringify({ motion, sound, media }));
});

t("错误映射：有码给人话，没码如实透出并截断到 120 字", () => {
  const noKey = soundErrorText(Object.assign(new Error("未配置 FREESOUND_API_KEY"), { code: "NO_API_KEY" }));
  if (!noKey.includes("NO_API_KEY")) throw new Error("NO_API_KEY 文案丢了错误码：" + noKey);
  if (!noKey.includes("setx")) throw new Error("NO_API_KEY 文案没说怎么修：" + noKey);
  if (noKey.includes("还没接上")) throw new Error("又出现了「宿主侧还没接上」的假话：" + noKey);

  const net = soundErrorText(Object.assign(new Error("Freesound 请求失败: fetch failed"), { code: "NETWORK" }));
  if (!net.includes("NETWORK") || !net.includes("freesound.org")) throw new Error("NETWORK 文案不对：" + net);

  const long = soundErrorText(Object.assign(new Error("x".repeat(300)), { code: "WEIRD" }));
  if (long.length !== 121 || !long.endsWith("…")) throw new Error("未知错误应截断到 120 字 + 省略号：" + long.length);

  const plain = soundErrorText(new Error("普通错误"));
  if (plain !== "普通错误") throw new Error("没有 code 时应原样透出：" + plain);

  const empty = soundErrorText(null);
  if (empty !== "未知错误") throw new Error("空错误兜底不对：" + empty);
});

t("0 条结果：区分「本地库为空」和「这个词没匹配」", () => {
  if (soundEmptyReason({ source: "local", query: "", entries: [] }) !== SOUND_EMPTY_LOCAL_TEXT) {
    throw new Error("本地空库应给下载 / 导入引导");
  }
  if (!SOUND_EMPTY_LOCAL_TEXT.includes("获取音效包") || !SOUND_EMPTY_LOCAL_TEXT.includes("导入")) {
    throw new Error("空库引导应指向「获取音效包」和链接导入：" + SOUND_EMPTY_LOCAL_TEXT);
  }
  if (soundEmptyReason({ source: "local", query: "door", entries: [] }) !== "") {
    throw new Error("有关键词时算没匹配，不该说本地库为空");
  }
  if (soundEmptyReason({ source: "local", query: "", entries: [{ id: "x" }] }) !== "") {
    throw new Error("有结果时不该给空库提示");
  }
  if (soundEmptyReason({ source: "freesound", query: "", entries: [] }) !== "") {
    throw new Error("只看 Freesound 时不该谈本地库");
  }
  if (soundEmptyReason({ source: "local", query: "", entries: [], maxDuration: 1 }) !== "") {
    throw new Error("设了时长筛选就该说「筛掉了」，不该说本地库为空");
  }
});

t("排序下拉只在线源下出现：综合 / 评分 / 下载量", () => {
  if (!freesoundPanel.includes("综合")) throw new Error("Freesound 来源下没有「综合」排序");
  if (!freesoundPanel.includes("评分")) throw new Error("Freesound 来源下没有「评分」排序");
  if (!freesoundPanel.includes("下载量")) throw new Error("Freesound 来源下没有「下载量」排序");
  if (expanded.includes("下载量")) throw new Error("默认「全部」且无在线结果时不该出现排序下拉");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
