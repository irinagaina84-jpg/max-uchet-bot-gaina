import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v108.js";

const VERSION = "worker-v110-minwei-company";
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
  if (!base) throw new Error("BITRIX_WEBHOOK_URL missing");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(methodUrl(base, method), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) throw new Error(`${method}: ${j?.error_description || j?.error || `HTTP ${r.status}`}`);
    return j?.result;
  } finally {
    clearTimeout(timer);
  }
}
async function ensureCompany(env){
  const list = await bx(env,"crm.company.list",{order:{ID:"ASC"},filter:{"=TITLE":"Мин Вэй"},select:["ID","TITLE"],start:0});
  const rows = Array.isArray(list)?list:[];
  const fields = {
    TITLE:"Мин Вэй",
    COMMENTS:"Поставщик. Проект КОНСТЭВО. Отдельно ведутся оплаты, выдачи, текущая бронь и складской остаток.",
  };
  if(rows[0]?.ID){
    await bx(env,"crm.company.update",{id:rows[0].ID,fields});
    return {id:String(rows[0].ID),created:false};
  }
  const id = await bx(env,"crm.company.add",{fields,params:{REGISTER_SONET_EVENT:"N"}});
  return {id:String(id),created:true};
}
export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);
    if(url.pathname === "/bitrix/setup-minwei-company" && request.method === "GET"){
      try{
        const result = await ensureCompany(env);
        return Response.json({ok:true,version:VERSION,...result},{headers:{"Cache-Control":"no-store"}});
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
