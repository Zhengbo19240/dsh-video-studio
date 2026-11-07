import { readFileSync } from "node:fs";

const React = {
  createElement: (...a) => ({ type: a[0], props: a[1] }),
  Fragment: "Fragment",
  useRef: (v) => ({ current: v }),
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useReducer: (f, i) => [i, () => {}],
  useEffect: () => {},
  useMemo: (f) => f(),
  useCallback: (f) => f,
  createContext: () => ({ Provider: "p", Consumer: "c" }),
};

let loaded = null;
globalThis.window = {
  __ModuleLoader__: { load: (m) => { loaded = m; } },
  addEventListener() {}, removeEventListener() {},
  setTimeout, clearTimeout, setInterval, clearInterval,
};
globalThis.document = { createElement: () => ({ style: {}, addEventListener() {}, removeEventListener() {}, getContext: () => ({}), load() {}, play() {} }) };
globalThis.fetch = async () => ({ json: async () => ({ ok: true, value: {} }) });
globalThis.EventSource = class { addEventListener() {} removeEventListener() {} close() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const code = readFileSync("./client.js", "utf8");
new Function("window", "document", "EventSource", "requestAnimationFrame", "cancelAnimationFrame", code)(
  globalThis.window, globalThis.document, globalThis.EventSource, globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame,
);
if (!loaded) throw new Error("__ModuleLoader__.load 没有被调用");
if (loaded.id !== "dsh-video-workbench") throw new Error("id 不对: " + loaded.id);
const plugin = loaded.factory((name) => {
  if (name === "react") return React;
  throw new Error("unexpected require: " + name);
});
if (typeof plugin.apply !== "function") throw new Error("没有 apply");
const registered = [];
const disposers = [];
const ctx = {
  effect: (fn) => { const d = fn(); if (typeof d === "function") disposers.push(d); },
  slots: {
    register: (opt, Comp) => { registered.push({ opt, Comp }); return () => {}; },
    inject: (name, fn) => { const d = fn(); return typeof d === "function" ? d : () => {}; },
  },
  layout: { selectPanel() {} },
  get: () => ({ pickDirectory: async () => null, createDirectory: async () => null }),
};
plugin.apply(ctx);
const names = registered.map((r) => r.opt.name + (r.opt.key ? "#" + r.opt.key : "") + (r.opt.id ? "#" + r.opt.id : ""));
console.log("register ok:", names.join(", "));
const expected = ["conversation.view#video-workbench"];
for (const e of expected) if (!names.includes(e)) throw new Error("缺少座位: " + e);
console.log("client load test passed");
