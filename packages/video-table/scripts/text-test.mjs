import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import { ProjectStore } from "../src/store.mjs";

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('text');
let pass=0, fail=0;
const t=async(n,f)=>{try{await f();pass++;console.log("  ok   "+n)}catch(e){fail++;console.log("  FAIL "+n+" :: "+e.message)}};
const root=await fs.mkdtemp(path.join(os.tmpdir(),"vw-txt-"));
const store=new ProjectStore();
const doc=await store.open(root,"s1");
const apply=async(ops)=>{const p=store.preview(doc.projectId,"s1",undefined,ops);return store.applyPreview(p.previewId,"s1")};
const c=()=>store.get(doc.projectId).doc.clips[0];
await t("文字内容可改", async()=>{
  await apply([{type:"clip.insert",clipId:"t1",trackId:"t1",clipType:"text",start:0,duration:2,text:"旧"}]);
  await apply([{type:"clip.set_text",clipId:"t1",text:"新字幕"}]);
  if(c().text!=="新字幕") throw new Error("text="+c().text);
});
await t("字号/颜色/位置写入", async()=>{
  await apply([{type:"clip.set_text_style",clipId:"t1",style:{fontSize:48,color:"#ff0000",y:0.5,bold:true}}]);
  const s=c().style;
  if(s.fontSize!==48||s.color!=="#ff0000"||s.y!==0.5||s.bold!==true) throw new Error(JSON.stringify(s));
});
await t("非法字号被拒", async()=>{
  try{ await apply([{type:"clip.set_text_style",clipId:"t1",style:{fontSize:400}}]); throw new Error("应当拒绝"); }
  catch(e){ if(e.code!=="INVALID_ARG") throw e; }
});
await t("非法颜色被拒", async()=>{
  try{ await apply([{type:"clip.set_text_style",clipId:"t1",style:{color:"red"}}]); throw new Error("应当拒绝"); }
  catch(e){ if(e.code!=="INVALID_ARG") throw e; }
});
await t("未知样式字段被拒", async()=>{
  try{ await apply([{type:"clip.set_text_style",clipId:"t1",style:{shadow:1}}]); throw new Error("应当拒绝"); }
  catch(e){ if(e.code!=="INVALID_ARG") throw e; }
});
await t("非文字片段加样式被拒", async()=>{
  await apply([{type:"clip.insert",clipId:"m1",trackId:"c1",clipType:"code",layerId:"ly1",start:0,duration:1}]);
  try{ await apply([{type:"clip.set_text_style",clipId:"m1",style:{fontSize:20}}]); throw new Error("应当拒绝"); }
  catch(e){ if(e.code!=="INVALID_OP") throw e; }
});
await fs.rm(root,{recursive:true,force:true});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
