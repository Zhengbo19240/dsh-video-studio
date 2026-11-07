import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import { ProjectStore } from "../src/store.mjs";
import { evaluateTransform } from "../src/client/player.js";

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('keyframe');

let pass=0, fail=0;
const t=async(n,f)=>{try{await f();pass++;console.log("  ok   "+n)}catch(e){fail++;console.log("  FAIL "+n+" :: "+e.message)}};
const root=await fs.mkdtemp(path.join(os.tmpdir(),"vw-kf-"));
const store=new ProjectStore();
const doc=await store.open(root,"s1");
const apply=async(ops)=>{const p=store.preview(doc.projectId,"s1",undefined,ops);return store.applyPreview(p.previewId,"s1")};
const clipNow=()=>store.get(doc.projectId).doc.clips[0];

await t("关键帧：写入并去重（同属性同时间覆盖）", async()=>{
  await apply([{type:"clip.insert",clipId:"c1",trackId:"v1",clipType:"text",start:0,duration:4,text:"x"}]);
  await apply([{type:"clip.set_keyframe",clipId:"c1",property:"scale",t:0,value:1}]);
  await apply([{type:"clip.set_keyframe",clipId:"c1",property:"scale",t:2,value:2}]);
  await apply([{type:"clip.set_keyframe",clipId:"c1",property:"scale",t:2,value:3}]);
  const c=clipNow();
  if(c.keyframes.length!==2) throw new Error("数量="+c.keyframes.length);
  if(c.keyframes[1].value!==3) throw new Error("未覆盖");
});

await t("关键帧：越界时间被拒", async()=>{
  try{ await apply([{type:"clip.set_keyframe",clipId:"c1",property:"opacity",t:9,value:1}]); throw new Error("应当拒绝"); }
  catch(e){ if(e.code!=="INVALID_OP") throw e; }
});

await t("关键帧：未知属性被拒", async()=>{
  try{ await apply([{type:"clip.set_keyframe",clipId:"c1",property:"blur",t:0,value:1}]); throw new Error("应当拒绝"); }
  catch(e){ if(e.code!=="INVALID_ARG") throw e; }
});

await t("插值：两端夹住、中点线性", async()=>{
  const c=clipNow();
  if(evaluateTransform(c,0).scale!==1) throw new Error("t0="+evaluateTransform(c,0).scale);
  const mid=evaluateTransform(c,1).scale;
  if(Math.abs(mid-2) > 1e-6) throw new Error("t1="+mid); // 0→1, 2→3, t=1 → 2
  if(evaluateTransform(c,3.5).scale!==3) throw new Error("尾部未夹住");
});

await t("插值：无关键帧时回落到静态变换", async()=>{
  const fake={transform:{scale:1.5,opacity:0.8},keyframes:[]};
  const r=evaluateTransform(fake,2);
  if(r.scale!==1.5||r.opacity!==0.8) throw new Error(JSON.stringify(r));
});

await t("删除关键帧（按属性）", async()=>{
  await apply([{type:"clip.remove_keyframe",clipId:"c1",property:"scale"}]);
  if((clipNow().keyframes||[]).length!==0) throw new Error("未清空");
});

await fs.rm(root,{recursive:true,force:true});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
