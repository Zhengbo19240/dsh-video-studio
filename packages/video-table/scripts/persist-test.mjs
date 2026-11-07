import { useTempBindings } from './_bindings-guard.mjs';
import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import { ProjectStore } from "../src/store.mjs";

const cleanupBindings = useTempBindings('persist');
const bind = process.env.DSH_VIDEO_BINDINGS;
let pass=0, fail=0;
const t=async(n,f)=>{try{await f();pass++;console.log("  ok   "+n)}catch(e){fail++;console.log("  FAIL "+n+" :: "+e.message)}};

const root = await fs.mkdtemp(path.join(os.tmpdir(), "vw-proj-"));
const S = "session-persist";

await t("打开工程会写绑定表", async()=>{
  const store = new ProjectStore();
  await store.open(root, S);
  const map = JSON.parse(await fs.readFile(bind, "utf8"));
  if (!map[S] || map[S].root !== path.resolve(root)) throw new Error(JSON.stringify(map));
});

await t("新进程（新 store）能按会话恢复工程", async()=>{
  const store2 = new ProjectStore();
  const doc = await store2.restore(S);
  if (!doc) throw new Error("没有恢复");
  if (doc.boundSessionId !== S) throw new Error("绑定不对");
});

await t("改动能落盘、重启后还在", async()=>{
  const store3 = new ProjectStore();
  await store3.open(root, S);
  const p = store3.preview(store3.get((await store3.restore(S)).projectId).doc.projectId, S, undefined, [
    { type: "clip.insert", clipId: "c1", trackId: "v1", clipType: "text", start: 0, duration: 2, text: "持久化" },
  ]);
  await store3.applyPreview(p.previewId, S);
  const store4 = new ProjectStore();
  const doc = await store4.restore(S);
  if (!doc || doc.clips.length !== 1) throw new Error("片段没恢复: " + (doc ? doc.clips.length : "null"));
  if (doc.clips[0].text !== "持久化") throw new Error("内容不对");
});

await t("删除工程（不删文件）会解除绑定，目录还在", async()=>{
  const store = new ProjectStore();
  const doc = await store.restore(S);
  await store.delete(doc.projectId, S, false);
  const map = JSON.parse(await fs.readFile(bind, "utf8"));
  if (map[S]) throw new Error("绑定未清除");
  await fs.access(path.join(root, ".dsh-video", "project.json"));
});

await t("恢复已删除的工程返回 null", async()=>{
  const store = new ProjectStore();
  const doc = await store.restore(S);
  if (doc) throw new Error("不该恢复");
});

await t("删除工程（含文件）会把目录删掉", async()=>{
  const S2 = "session-del";
  const root2 = await fs.mkdtemp(path.join(os.tmpdir(), "vw-proj2-"));
  const store = new ProjectStore();
  const doc = await store.open(root2, S2);
  const r = await store.delete(doc.projectId, S2, true);
  if (!r.filesDeleted) throw new Error("filesDeleted=false");
  let gone = false;
  try { await fs.access(root2); } catch { gone = true; }
  if (!gone) throw new Error("目录还在");
});

await t("跨会话删除被拒", async()=>{
  const S3 = "session-x";
  const root3 = await fs.mkdtemp(path.join(os.tmpdir(), "vw-proj3-"));
  const store = new ProjectStore();
  const doc = await store.open(root3, S3);
  try { await store.delete(doc.projectId, "other", false); throw new Error("应当拒绝"); }
  catch(e){ if (e.code !== "BOUND_TO_OTHER_SESSION") throw e; }
  await fs.rm(root3, { recursive: true, force: true });
});

await fs.rm(root, { recursive: true, force: true });
cleanupBindings();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
