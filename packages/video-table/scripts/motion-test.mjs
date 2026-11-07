import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import { ProjectStore } from "../src/store.mjs";
import { motionTools } from "../src/motion-tools.mjs";

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('motion');

const root = await fs.mkdtemp(path.join(os.tmpdir(), "vw-motion-"));
const store = new ProjectStore();
const doc = await store.open(root, "s1");
const tools = motionTools({ store });
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
console.log("tools:", tools.map((t) => t.name).join(","));

const list = await byName.video_motion_list.execute({}, { agent: { id: "s1" } });
console.log("list count:", list.count, "native:", list.entries.filter(e => e.native).length);

const ins = await byName.video_motion_insert.execute({ entryId: "scanline-glint", duration: 2 }, { agent: { id: "s1" } });
console.log("inserted:", JSON.stringify(ins));

const clips = store.get(doc.projectId).doc.clips;
console.log("clip provenance:", JSON.stringify(clips[0].provenance));
const code = await fs.readFile(path.join(root, "code", ins.layerId, "index.js"), "utf8");
console.log("code first line:", code.split("\n")[0]);

try { await byName.video_motion_insert.execute({ entryId: "nope" }, { agent: { id: "s1" } }); }
catch (e) { console.log("missing entry ->", e.code); }

await fs.rm(root, { recursive: true, force: true });
