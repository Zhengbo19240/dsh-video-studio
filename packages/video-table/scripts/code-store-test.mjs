import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import { ProjectStore } from "../src/store.mjs";
import { writeCode, readCode, listCodeLayers } from "../src/code-store.mjs";

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('code-store');

let pass=0, fail=0;
const t=async(n,f)=>{try{await f();pass++;console.log("  ok   "+n)}catch(e){fail++;console.log("  FAIL "+n+" :: "+e.message)}};
const root=await fs.mkdtemp(path.join(os.tmpdir(),"vw-code-"));

await t("写代码 → 读回一致", async()=>{
  const r=await writeCode(root,"ly1","export function render(ctx,t){}");
  if(!r.codeHash.startsWith("sha256:")) throw new Error("hash");
  const src=await readCode(root,"ly1");
  if(!src.includes("render")) throw new Error("source mismatch");
});
await t("layerId 非法被拒", async()=>{
  try{ await writeCode(root,"../evil","x"); throw new Error("should reject"); }
  catch(e){ if(e.code!=="INVALID_ARG") throw e; }
});
await t("空源码被拒", async()=>{
  try{ await writeCode(root,"ly2","   "); throw new Error("should reject"); }
  catch(e){ if(e.code!=="INVALID_ARG") throw e; }
});
await t("listLayers", async()=>{ const l=await listCodeLayers(root); if(!l.includes("ly1")) throw new Error(JSON.stringify(l)); });
await t("读不存在 → NOT_FOUND", async()=>{
  try{ await readCode(root,"nope"); throw new Error("should reject"); }
  catch(e){ if(e.code!=="NOT_FOUND") throw e; }
});

// 代码图层命令
const store=new ProjectStore();
const doc=await store.open(root,"s1");
await t("新建代码片段后 revision+1 且时长正确", async()=>{
  const p=store.preview(doc.projectId,"s1",undefined,[{type:"clip.insert",clipId:"code_1",trackId:"c1",clipType:"code",layerId:"ly1",codeHash:"sha256:x",props:{},start:1,duration:4}]);
  const a=await store.applyPreview(p.previewId,"s1");
  const d=store.get(doc.projectId).doc;
  const c=d.clips.find(x=>x.id==="code_1");
  if(!c||c.type!=="code") throw new Error("clip missing");
  if(d.duration!==5) throw new Error("duration="+d.duration);
  if(a.revision!==1) throw new Error("rev="+a.revision);
});
await t("更新 codeHash 与 props", async()=>{
  const p=store.preview(doc.projectId,"s1",undefined,[
    {type:"code_layer.set_code",clipId:"code_1",codeHash:"sha256:y"},
    {type:"code_layer.set_props",clipId:"code_1",props:{title:"hi"}},
  ]);
  await store.applyPreview(p.previewId,"s1");
  const c=store.get(doc.projectId).doc.clips.find(x=>x.id==="code_1");
  if(c.codeHash!=="sha256:y"||c.props.title!=="hi") throw new Error(JSON.stringify(c.props));
});

await fs.rm(root,{recursive:true,force:true});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
