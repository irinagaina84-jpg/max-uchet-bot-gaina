import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v89.js";

const VERSION = "worker-v90-final-working-import";
const ROOT = "93";
const MAX_BYTES = 2 * 1024 * 1024;

const APPROVED = new Map([
  ["21ba370e5c3a78739f0bede79477b75716f75123c09ff3dcbb28a8b63f655453", {
    name: "Карточка предприятия — ИНТЕРФОРТУМ — 31.08.2026.jpg",
    path: ["01 ИНТЕРФОРТУМ", "00 КАРТОЧКА И РЕКВИЗИТЫ"]
  }],
  ["725a78f430a2d0a2be807d4f205aac20a64361339a0971d46629ce3041fb9350", {
    name: "ИНТЕРФОРТУМ — рабочая сводная проектов.xlsx",
    path: ["00 РАБОЧАЯ СВОДНАЯ", "ИНТЕРФОРТУМ"]
  }],
  ["6d94d800a9cd964542ac86a8602012960744c4c83e74671793964abae19456d3", {
    name: "ВЗЛЁТ — Реестр КТК 24.08.2026 — ФИНАЛ.xlsx",
    path: ["02 АМИДИ ГРУПП", "04 КОНТЕЙНЕРЫ — РЕЕСТРЫ И ВЫДАЧИ", "ВЗЛЁТ"]
  }],
  ["77d7042b93ac4d82d4802acc214f3aa12dba1341da70b2373a437605ae079625", {
    name: "ВЗЛЁТ — общая сводная по закупу и выдачам.xlsx",
    path: ["02 АМИДИ ГРУПП", "08 ГОТОВЫЕ СВЕРКИ И ОТЧЕТЫ", "ВЗЛЁТ"]
  }]
]);

export class MaxBotContainer extends BaseMaxBotContainer {}
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"POST,OPTIONS,GET","Access-Control-Allow-Headers":"Content-Type","Cache-Control":"no-store"};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function methodUrl(base,method){
  const u=new URL(String(base||"").trim());
  if(u.protocol!=="https:"||!/\/rest\/\d+\/[^/]+\/?$/i.test(u.pathname)) throw new Error("Invalid Bitrix webhook");
  u.search="";u.hash="";if(!u.pathname.endsWith("/"))u.pathname+="/";u.pathname+=`${method}.json`;return u.toString();
}
async function bx(env,method,params={}){
  const base=String(env?.BITRIX_WEBHOOK_URL||"").trim();if(!base)throw new Error("BITRIX_WEBHOOK_URL missing");
  let last="unknown";
  for(let i=0;i<5;i++){
    await sleep(i?400*(i+1):120);
    const r=await fetch(methodUrl(base,method),{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(params)});
    const j=await r.json().catch(()=>({}));if(r.ok&&!j?.error)return j?.result;
    last=String(j?.error_description||j?.error||`HTTP ${r.status}`);
    if(!(r.status===429||r.status>=500||/limit|tempor|timeout|520/i.test(last)))break;
  }
  throw new Error(`${method}: ${last}`);
}
async function children(env,id){const r=await bx(env,"disk.folder.getChildren",{id});return Array.isArray(r)?r:[];}
const iid=x=>String(x?.ID||x?.id||"");const iname=x=>String(x?.NAME||x?.name||"");const itype=x=>String(x?.TYPE||x?.type||"").toLowerCase();
async function ensureFolder(env,parentId,name){
  const found=(await children(env,parentId)).find(x=>itype(x)==="folder"&&iname(x)===name);if(found)return iid(found);
  const r=await bx(env,"disk.folder.addSubFolder",{id:parentId,data:{NAME:name}});const id=String(r?.ID||r?.id||"");if(!id)throw new Error(`Folder id missing: ${name}`);return id;
}
async function hash(bytes){const d=await crypto.subtle.digest("SHA-256",bytes);return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,"0")).join("");}
function decode(v){const text=String(v||"");if(!text||text.length>Math.ceil(MAX_BYTES*4/3)+64)throw new Error("Payload too large");const b=atob(text);if(b.length>MAX_BYTES)throw new Error("File too large");const out=new Uint8Array(b.length);for(let i=0;i<b.length;i++)out[i]=b.charCodeAt(i);return out;}
async function upload(request,env){
  const body=await request.json();const filename=String(body?.filename||"");const path=Array.isArray(body?.path)?body.path.map(String):[];const bytes=decode(body?.base64);const h=await hash(bytes);const approved=APPROVED.get(h);
  if(!approved||filename!==approved.name||JSON.stringify(path)!==JSON.stringify(approved.path)) return Response.json({ok:false,error:"File or destination is not approved"},{status:403,headers:cors});
  let target=ROOT;for(const part of approved.path)target=await ensureFolder(env,target,part);
  const existing=(await children(env,target)).find(x=>itype(x)==="file"&&iname(x)===approved.name);
  if(existing)return Response.json({ok:true,already:true,fileId:iid(existing),folderId:target},{headers:cors});
  const r=await bx(env,"disk.folder.uploadFile",{id:target,data:{NAME:approved.name},fileContent:[approved.name,String(body.base64)],generateUniqueName:false});
  return Response.json({ok:true,uploaded:true,fileId:String(r?.ID||r?.id||""),folderId:target},{headers:cors});
}

export default{
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(url.pathname==="/bitrix/import-final-working/status")return Response.json({ok:true,version:VERSION,approvedCount:APPROVED.size},{headers:cors});
    if(url.pathname==="/bitrix/import-final-working"&&request.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
    if(url.pathname==="/bitrix/import-final-working"&&request.method==="POST"){
      try{return await upload(request,env);}catch(e){return Response.json({ok:false,version:VERSION,error:String(e?.message||e)},{status:500,headers:cors});}
    }
    return currentWorker.fetch(request,env,ctx);
  },
  async scheduled(controller,env,ctx){if(typeof currentWorker.scheduled==="function")return currentWorker.scheduled(controller,env,ctx);}
};
