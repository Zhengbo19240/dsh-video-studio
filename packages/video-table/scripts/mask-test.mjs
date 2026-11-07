import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import { ProjectStore } from "../src/store.mjs";

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('mask');
let pass=0, fail=0;
const t=async(n,f)=>{try{await f();pass++;console.log("  ok   "+n)}catch(e){fail++;console.log("  FAIL "+n+" :: "+e.message)}};
const root=await fs.mkdtemp(path.join(os.tmpdir(),"vw-mask-"));
const store=new ProjectStore();
const doc=await store.open(root,"s1");
const apply=async(ops)=>{const p=store.preview(doc.projectId,"s1",undefined,ops);return store.applyPreview(p.previewId,"s1")};
const c=()=>store.get(doc.projectId).doc.clips[0];

await t("矩形蒙版写入", async()=>{
  await apply([{type:"clip.insert",clipId:"m1",trackId:"v1",clipType:"code",layerId:"l1",start:0,duration:2}]);
  await apply([{type:"clip.set_mask",clipId:"m1",mask:{shape:"rect",x:0.5,y:0.5,w:0.4,h:0.4}}]);
  const m=c().mask;
  if(!m||m.shape!=="rect"||m.w!==0.4) throw new Error(JSON.stringify(m));
});
await t("圆形蒙版", async()=>{
  await apply([{type:"clip.set_mask",clipId:"m1",mask:{shape:"circle",x:0.5,y:0.5,w:0.5,h:0.5}}]);
  if(c().mask.shape!=="circle") throw new Error("shape");
});
await t("非法形状被拒", async()=>{
  try{ await apply([{type:"clip.set_mask",clipId:"m1",mask:{shape:"star",x:0.5,y:0.5,w:0.2,h:0.2}}]); throw new Error("应当拒绝"); }
  catch(e){ if(e.code!=="INVALID_ARG") throw e; }
});
await t("零宽被拒", async()=>{
  try{ await apply([{type:"clip.set_mask",clipId:"m1",mask:{shape:"rect",x:0.5,y:0.5,w:0,h:0.2}}]); throw new Error("应当拒绝"); }
  catch(e){ if(e.code!=="INVALID_ARG") throw e; }
});
await t("none 清除蒙版", async()=>{
  await apply([{type:"clip.set_mask",clipId:"m1",mask:{shape:"none"}}]);
  if(c().mask) throw new Error("未清除");
});
await t("文字片段不支持蒙版", async()=>{
  await apply([{type:"clip.insert",clipId:"t1",trackId:"t1",clipType:"text",start:0,duration:1,text:"x"}]);
  try{ await apply([{type:"clip.set_mask",clipId:"t1",mask:{shape:"rect",x:0.5,y:0.5,w:0.2,h:0.2}}]); throw new Error("应当拒绝"); }
  catch(e){ if(e.code!=="INVALID_OP") throw e; }
});
await fs.rm(root,{recursive:true,force:true});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
