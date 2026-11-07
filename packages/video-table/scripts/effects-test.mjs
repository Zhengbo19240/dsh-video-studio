import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import { ProjectStore } from "../src/store.mjs";

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('effects');
let pass=0, fail=0;
const t=async(n,f)=>{try{await f();pass++;console.log("  ok   "+n)}catch(e){fail++;console.log("  FAIL "+n+" :: "+e.message)}};
const root=await fs.mkdtemp(path.join(os.tmpdir(),"vw-fx-"));
const store=new ProjectStore();
const doc=await store.open(root,"s1");
const apply=async(ops)=>{const p=store.preview(doc.projectId,"s1",undefined,ops);return store.applyPreview(p.previewId,"s1")};

await t("效果：亮度写入 + 幂等更新", async()=>{
  await apply([{type:"clip.insert",clipId:"c1",trackId:"v1",clipType:"text",start:0,duration:2,text:"x"}]);
  await apply([{type:"clip.set_effect",clipId:"c1",effect:"brightness",value:1.4}]);
  await apply([{type:"clip.set_effect",clipId:"c1",effect:"brightness",value:0.8}]);
  const c=store.get(doc.projectId).doc.clips[0];
  const fx=(c.effects||[]).filter(e=>e.type==="brightness");
  if(fx.length!==1) throw new Error("重复条目 "+fx.length);
  if(fx[0].value!==0.8) throw new Error("值="+fx[0].value);
});
await t("效果：传 null 移除", async()=>{
  await apply([{type:"clip.set_effect",clipId:"c1",effect:"brightness",value:null}]);
  const c=store.get(doc.projectId).doc.clips[0];
  if((c.effects||[]).length!==0) throw new Error("未移除");
});
await t("效果：未知效果被拒", async()=>{
  try{ await apply([{type:"clip.set_effect",clipId:"c1",effect:"sepia",value:1}]); throw new Error("应当拒绝"); }
  catch(e){ if(e.code!=="INVALID_ARG") throw e; }
});
await t("效果：写入后 revision 前进", async()=>{
  const before=store.get(doc.projectId).doc.revision;
  const r=await apply([{type:"clip.set_effect",clipId:"c1",effect:"blur",value:4}]);
  if(r.revision!==before+1) throw new Error("revision="+r.revision);
});
await t("效果：undo 能退回（最后一步）", async()=>{
  const cur=store.get(doc.projectId).doc.revision;
  const tx=store.get(doc.projectId).undo.slice(-1)[0].transactionId;
  const r=await store.undo(doc.projectId,"s1",tx);
  const c=store.get(doc.projectId).doc.clips[0];
  if((c.effects||[]).some(e=>e.type==="blur")) throw new Error("未回退");
});
await fs.rm(root,{recursive:true,force:true});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
