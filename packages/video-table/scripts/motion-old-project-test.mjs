import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import { ProjectStore } from "../src/store.mjs";
import { motionTools } from "../src/motion-tools.mjs";

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('motion-old-project');

const root = await fs.mkdtemp(path.join(os.tmpdir(), "vw-old-"));
const store = new ProjectStore();
const doc = await store.open(root, "s1");
// 模拟旧工程：没有 v2
const d = store.get(doc.projectId).doc;
d.tracks = d.tracks.filter((t) => t.id !== "v2");
console.log("before tracks:", d.tracks.map((t) => t.id).join(","));

const tools = Object.fromEntries(motionTools({ store }).map((t) => [t.name, t]));
const res = await tools.video_motion_insert.execute({ entryId: "scanline-glint", duration: 2 }, { agent: { id: "s1" } });
console.log("insert:", res.human);
const after = store.get(doc.projectId).doc;
console.log("after tracks:", after.tracks.map((t) => t.id).join(","));
console.log("clip track:", after.clips[0].trackId, "type:", after.clips[0].type);
await fs.rm(root, { recursive: true, force: true });
