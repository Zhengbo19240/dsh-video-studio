import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import { ProjectStore } from "../src/store.mjs";
import { humanDiff } from "../src/diff-text.mjs";

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('humandiff');
let pass=0, fail=0;
const t=async(n,f)=>{try{await f();pass++;console.log("  ok   "+n)}catch(e){fail++;console.log("  FAIL "+n+" :: "+e.message)}};
const root=await fs.mkdtemp(path.join(os.tmpdir(),"vw-human-"));
const store=new ProjectStore();
const doc=await store.open(root,"s1");
const p=await store.preview(doc.projectId,"s1",undefined,[
  {type:"clip.insert",clipId:"t1",trackId:"t1",clipType:"text",start:1,duration:2,text:"你好"},
]);
await t("preview 返回可读摘要", async()=>{
  if(!p.human) throw new Error("没有 human");
  console.log("    → " + p.human);
  if(!p.human.includes("新增")) throw new Error("措辞不对: "+p.human);
});
await t("apply 返回同一条摘要", async()=>{
  const a=await store.applyPreview(p.previewId,"s1");
  if(!a.human || !a.human.includes("r0")) throw new Error(a.human);
});
await t("修改类摘要说清改了什么", async()=>{
  const p2=await store.preview(doc.projectId,"s1",undefined,[{type:"clip.set_text",clipId:"t1",text:"改过的"}]);
  if(!p2.human.includes("文案")) throw new Error(p2.human);
});
await t("删除类摘要", async()=>{
  const p3=await store.preview(doc.projectId,"s1",undefined,[{type:"clip.delete",clipId:"t1"}]);
  if(!p3.human.includes("删除")) throw new Error(p3.human);
});
await t("无变化时说明无变化", async()=>{
  const empty={revision:1,clips:[],tracks:[],assets:[],annotations:[]};
  const s=humanDiff(empty,{...empty,revision:2},{revision:2,added:[],removed:[],modified:[]});
  if(!s.includes("没有可见变化")) throw new Error(s);
});
await fs.rm(root,{recursive:true,force:true});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
