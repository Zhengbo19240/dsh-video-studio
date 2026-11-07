import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import { ProjectStore } from "../src/store.mjs";
import { evaluateTransform } from "../src/client/player.js";

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('ease');

let pass=0, fail=0;
const t=async(n,f)=>{try{await f();pass++;console.log("  ok   "+n)}catch(e){fail++;console.log("  FAIL "+n+" :: "+e.message)}};
const root=await fs.mkdtemp(path.join(os.tmpdir(),"vw-ease-"));
const store=new ProjectStore();
const doc=await store.open(root,"s1");
const apply=async(ops)=>{const p=store.preview(doc.projectId,"s1",undefined,ops);return store.applyPreview(p.previewId,"s1")};

await t("关键帧可带缓动并落盘", async()=>{
  await apply([{type:"clip.insert",clipId:"c1",trackId:"t1",clipType:"text",start:0,duration:4,text:"x"}]);
  await apply([{type:"clip.set_keyframe",clipId:"c1",property:"scale",t:0,value:1,ease:"easeIn"}]);
  await apply([{type:"clip.set_keyframe",clipId:"c1",property:"scale",t:4,value:3}]);
  const c=store.get(doc.projectId).doc.clips[0];
  if(c.keyframes[0].ease!=="easeIn") throw new Error(JSON.stringify(c.keyframes));
});
await t("easeIn：中点应偏低（1.5 而不是 2）", async()=>{
  const c=store.get(doc.projectId).doc.clips[0];
  const v=evaluateTransform(c,2).scale;
  if(Math.abs(v-1.5)>1e-6) throw new Error("v="+v);
});
await t("easeOut：中点应偏高", async()=>{
  const c=store.get(doc.projectId).doc.clips[0];
  c.keyframes[0].ease="easeOut";
  const v=evaluateTransform(c,2).scale;
  if(Math.abs(v-2.5)>1e-6) throw new Error("v="+v);
});
await t("easeInOut：中点正好一半", async()=>{
  const c=store.get(doc.projectId).doc.clips[0];
  c.keyframes[0].ease="easeInOut";
  const v=evaluateTransform(c,2).scale;
  if(Math.abs(v-2)>1e-6) throw new Error("v="+v);
});
await t("非法缓动被拒", async()=>{
  try{ await apply([{type:"clip.set_keyframe",clipId:"c1",property:"opacity",t:1,value:0.5,ease:"bounce"}]); throw new Error("应当拒绝"); }
  catch(e){ if(e.code!=="INVALID_ARG") throw e; }
});
await t("线性（缺省）保持原行为", async()=>{
  const c=store.get(doc.projectId).doc.clips[0];
  c.keyframes[0].ease=undefined;
  const v=evaluateTransform(c,2).scale;
  if(Math.abs(v-2)>1e-6) throw new Error("v="+v);
});

await fs.rm(root,{recursive:true,force:true});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
