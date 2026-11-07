import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SampleBroker } from "../src/samples.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "vw-sample-"));
const broker = new SampleBroker();

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log("  ok   " + n); };
const bad = (n, e) => { fail++; console.log("  FAIL " + n + " :: " + e.message); };

// 1) 请求 → 列表 → 回传
const p = broker.request("vp_1", [1, 2.5], 640);
const list = broker.list("vp_1");
if (list.length === 1 && list[0].times.length === 2) ok("pending 列表可读"); else bad("pending 列表可读", new Error(JSON.stringify(list)));

const jpeg = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
const r = await broker.fulfill("vp_1", root, list[0].requestId, [{ time: 1, dataUrl: jpeg }, { time: 2.5, dataUrl: jpeg }]);
if (!r.ok) bad("fulfill 返回 ok", new Error("not ok"));
const value = await p;
const stat = await fs.stat(value.samples[0].path);
if (value.samples.length === 2 && stat.size === 4) ok("回传写盘并可解析"); else bad("回传写盘", new Error("size " + stat.size));
if (broker.list("vp_1").length === 0) ok("回传后出队"); else bad("回传后出队", new Error("still pending"));

// 2) 超时
const p2 = broker.request("vp_1", [0], 640, { timeoutMs: 50 });
try { await p2; bad("超时拒绝", new Error("resolved")); }
catch (e) { if (e.code === "WORKBENCH_OFFLINE") ok("超时返回 WORKBENCH_OFFLINE"); else bad("超时码", e); }

// 3) 过期 fulfill
const r2 = await broker.fulfill("vp_1", root, "sp_nope", []);
if (r2.ok === false) ok("过期请求被拒"); else bad("过期请求被拒", new Error("ok"));

await fs.rm(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
