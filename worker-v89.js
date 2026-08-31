import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v88.js";

const VERSION = "worker-v89-bitrix-filing-fix";
const SOURCE_FOLDER_ID = "229";
const TARGET_FOLDER_ID = "231";
const FILE_NAME = "КОНСТЭВО — Спецификация №8 — Реестр КТК 28.08.2026.xlsx";

export class MaxBotContainer extends BaseMaxBotContainer {}

async function callBitrix(runtimeEnv, method, params = {}) {
  const base = String(runtimeEnv?.BITRIX_WEBHOOK_URL || "").trim();
  if (!base) throw new Error("BITRIX_WEBHOOK_URL missing");
  const u = new URL(base);
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  u.pathname += `${method}.json`;
  const r = await fetch(u.toString(), {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(params)});
  const j = await r.json().catch(()=>({}));
  if (!r.ok || j?.error) throw new Error(String(j?.error_description || j?.error || `HTTP ${r.status}`));
  return j?.result;
}
async function children(runtimeEnv,id){ const r=await callBitrix(runtimeEnv,"disk.folder.getChildren",{id}); return Array.isArray(r)?r:[]; }
const idOf=x=>String(x?.ID||x?.id||"");
const nameOf=x=>String(x?.NAME||x?.name||"");
const typeOf=x=>String(x?.TYPE||x?.type||"").toLowerCase();

async function fix(runtimeEnv){
  const src=await children(runtimeEnv,SOURCE_FOLDER_ID);
  const file=src.find(x=>typeOf(x)==="file"&&nameOf(x)===FILE_NAME);
  if(file){ await callBitrix(runtimeEnv,"disk.file.moveTo",{id:idOf(file),targetFolderId:TARGET_FOLDER_ID}); }
  const target=await children(runtimeEnv,TARGET_FOLDER_ID);
  const ok=target.some(x=>typeOf(x)==="file"&&nameOf(x)===FILE_NAME);
  return {ok,version:VERSION,moved:Boolean(file),file:FILE_NAME};
}

export default {
  async fetch(request,runtimeEnv,ctx){
    const url=new URL(request.url);
    if(url.pathname==="/bitrix/fix-registry-filing"){
      try{return Response.json(await fix(runtimeEnv),{headers:{"Cache-Control":"no-store"}})}
      catch(e){return Response.json({ok:false,version:VERSION,error:String(e?.message||e)},{status:500})}
    }
    return currentWorker.fetch(request,runtimeEnv,ctx);
  },
  async scheduled(controller,runtimeEnv,ctx){
    if(typeof currentWorker.scheduled==="function") return currentWorker.scheduled(controller,runtimeEnv,ctx);
  }
};
