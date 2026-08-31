import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v110.js";

const VERSION = "worker-v112-catalog-info";
export class MaxBotContainer extends BaseMaxBotContainer {}

function methodUrl(base, method) {
  const u = new URL(String(base || "").trim());
  if (u.protocol !== "https:" || !/\/rest\/\d+\/[^/]+\/?$/i.test(u.pathname)) throw new Error("Invalid Bitrix webhook");
  u.search = ""; u.hash = "";
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  u.pathname += `${method}.json`;
  return u.toString();
}
async function bx(env, method, params = {}) {
  const base = String(env?.BITRIX_WEBHOOK_URL || "").trim();
  const r = await fetch(methodUrl(base, method), {method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(params)});
  const j = await r.json().catch(()=>({}));
  if(!r.ok || j?.error) throw new Error(`${method}: ${j?.error_description || j?.error || `HTTP ${r.status}`}`);
  return j?.result;
}
function pick(obj, keys){ const out={}; for(const k of keys) if(obj && obj[k] !== undefined) out[k]=obj[k]; return out; }

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);
    if(url.pathname === "/bitrix/catalog-info" && request.method === "GET"){
      try{
        const c = await bx(env,"catalog.catalog.list",{select:["id","iblockId","name","productIblockId","skuPropertyId"],order:{id:"ASC"}});
        const s = await bx(env,"catalog.store.list",{select:["id","title","address","active","xmlId","code"],order:{id:"ASC"}});
        const catalogs = Array.isArray(c?.catalogs)?c.catalogs:(Array.isArray(c)?c:[]);
        const stores = Array.isArray(s?.stores)?s.stores:(Array.isArray(s)?s:[]);
        return Response.json({ok:true,version:VERSION,catalogs:catalogs.map(x=>pick(x,["id","iblockId","name","productIblockId","skuPropertyId"])),stores:stores.map(x=>pick(x,["id","title","address","active","xmlId","code"]))},{headers:{"Cache-Control":"no-store"}});
      }catch(e){
        return Response.json({ok:false,version:VERSION,error:String(e?.message||e).slice(0,300)},{status:503,headers:{"Cache-Control":"no-store"}});
      }
    }
    return currentWorker.fetch(request,env,ctx);
  },
  async scheduled(controller, env, ctx){
    if(typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller,env,ctx);
  }
};
