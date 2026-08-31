import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v108.js";

const VERSION = "worker-v109-minwei-supplier";
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
  const r = await fetch(methodUrl(base, method), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(`${method}: ${j?.error_description || j?.error || `HTTP ${r.status}`}`);
  return j?.result;
}
function text(v){
  if(typeof v === "string") return v.trim();
  if(v && typeof v === "object") for(const x of Object.values(v)) if(typeof x === "string" && x.trim()) return x.trim();
  return "";
}
function fieldLabel(f){ return text(f?.EDIT_FORM_LABEL)||text(f?.LIST_COLUMN_LABEL)||text(f?.LIST_FILTER_LABEL); }
async function roleField(env){
  const r = await bx(env,"crm.company.userfield.list",{order:{SORT:"ASC"}});
  const fields = Array.isArray(r)?r:[];
  const f = fields.find(x => fieldLabel(x) === "Роль контрагента");
  if(!f) throw new Error("Role field not found");
  const row = (Array.isArray(f.LIST)?f.LIST:[]).find(x => String(x?.VALUE||"").trim() === "Поставщик");
  if(!row?.ID) throw new Error("Supplier role not found");
  return {name:String(f.FIELD_NAME), id:String(row.ID)};
}
async function ensureSupplier(env){
  const role = await roleField(env);
  const list = await bx(env,"crm.company.list",{order:{ID:"ASC"},filter:{"=TITLE":"Мин Вэй"},select:["ID","TITLE"],start:0});
  const rows = Array.isArray(list)?list:[];
  const fields = {
    TITLE:"Мин Вэй",
    COMMENTS:"Поставщик. Проект КОНСТЭВО. Складской учет и оплаты ведутся отдельными реестрами.",
    [role.name]:role.id,
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
    if(url.pathname === "/bitrix/setup-minwei-supplier" && request.method === "GET"){
      try{
        const result = await ensureSupplier(env);
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
