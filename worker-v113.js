import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v110.js";

const VERSION = "worker-v113-minwei-approved-import";
const APPROVED = new Set([
  "ae6b3810ea1e8f447a2abb8d8eaee4f05787eaea870126b56c6d23785ddaa27d",
  "f489a76abb4afac86baba5c350903cdb2e75f6a100f5f1639c0794c91c345854",
]);
export class MaxBotContainer extends BaseMaxBotContainer {}
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  let last = "unknown";
  for (let i=0;i<5;i++) {
    if(i) await sleep(400*i);
    const r = await fetch(methodUrl(base,method),{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(params)});
    const j = await r.json().catch(()=>({}));
    if(r.ok && !j?.error) return j?.result;
    last = String(j?.error_description || j?.error || `HTTP ${r.status}`);
    if(!(r.status===429 || r.status>=500 || /limit|tempor|timeout|execution/i.test(last))) break;
  }
  throw new Error(`${method}: ${last}`);
}
async function sha256Hex(s){
  const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
function b64urlDecode(s){
  s=String(s||"").replace(/-/g,"+").replace(/_/g,"/");
  while(s.length%4) s+="=";
  const bin=atob(s), bytes=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}
function labelText(v){
  if(typeof v==="string") return v.trim();
  if(v&&typeof v==="object") for(const x of Object.values(v)) if(typeof x==="string"&&x.trim()) return x.trim();
  return "";
}
function fieldLabel(f){ return labelText(f?.EDIT_FORM_LABEL)||labelText(f?.LIST_COLUMN_LABEL)||labelText(f?.LIST_FILTER_LABEL); }
function enumId(f,value){ const x=(Array.isArray(f?.LIST)?f.LIST:[]).find(v=>String(v?.VALUE||"").trim()===value); return x?.ID?String(x.ID):null; }
function norm(s){ return String(s||"").trim().toUpperCase().replace(/[«»\"]/g,"").replace(/\s+/g," "); }

async function ensureRoleAndCompany(env,p){
  let uf=await bx(env,"crm.company.userfield.list",{order:{SORT:"ASC"}}); uf=Array.isArray(uf)?uf:[];
  let role=uf.find(f=>fieldLabel(f)==="Роль контрагента");
  if(!role){
    await bx(env,"crm.company.userfield.add",{fields:{FIELD_NAME:"CPROLE",USER_TYPE_ID:"enumeration",XML_ID:"IF_CPROLE",SORT:100,MULTIPLE:"N",MANDATORY:"N",SHOW_FILTER:"Y",SHOW_IN_LIST:"Y",EDIT_IN_LIST:"Y",EDIT_FORM_LABEL:"Роль контрагента",LIST_COLUMN_LABEL:"Роль контрагента",LIST_FILTER_LABEL:"Роль контрагента",LIST:["Поставщик","Перевозчик","Клиент","Прочее"].map((v,i)=>({VALUE:v,XML_ID:`IF_CPROLE_${i+1}`,SORT:(i+1)*100,DEF:"N"})),SETTINGS:{DISPLAY:"UI",LIST_HEIGHT:4}}});
    uf=await bx(env,"crm.company.userfield.list",{order:{SORT:"ASC"}}); uf=Array.isArray(uf)?uf:[]; role=uf.find(f=>fieldLabel(f)==="Роль контрагента");
  }
  const roleId=enumId(role,"Поставщик");
  if(!role?.FIELD_NAME || !roleId) throw new Error("Supplier role field unavailable");

  const fieldDefs=[
    ["SUPPAIDTOT","double","Поставщик — оплачено всего, руб.",210],
    ["SUPPADVREM","double","Поставщик — остаток аванса, руб.",220],
  ];
  for(const [code,type,lab,sort] of fieldDefs){
    if(uf.some(f=>fieldLabel(f)===lab)) continue;
    await bx(env,"crm.company.userfield.add",{fields:{FIELD_NAME:code,USER_TYPE_ID:type,XML_ID:`IF_${code}`,SORT:sort,MULTIPLE:"N",MANDATORY:"N",SHOW_FILTER:"Y",SHOW_IN_LIST:"Y",EDIT_IN_LIST:"Y",EDIT_FORM_LABEL:lab,LIST_COLUMN_LABEL:lab,LIST_FILTER_LABEL:lab}});
    uf=await bx(env,"crm.company.userfield.list",{order:{SORT:"ASC"}}); uf=Array.isArray(uf)?uf:[];
  }
  const paidF=uf.find(f=>fieldLabel(f)==="Поставщик — оплачено всего, руб.");
  const remF=uf.find(f=>fieldLabel(f)==="Поставщик — остаток аванса, руб.");
  const companies=await bx(env,"crm.company.list",{order:{ID:"ASC"},filter:{},select:["ID","TITLE"],start:0});
  const arr=Array.isArray(companies)?companies:[];
  const found=arr.find(x=>norm(x?.TITLE)===norm(p.supplier));
  const comments=`Сверка Мин Вэй. Оплачено всего: ${p.paidTotal} руб. Фактически выдано: ${p.issuedQty} контейнеров на ${p.issuedCost} руб. Неиспользовано: ${p.unused} руб. Текущая бронь/ожидается: ${p.reservedQty} на ${p.reservedCost} руб. Свободно после брони: ${p.freeAfterReserve} руб. Старые «не выдали»: ${p.oldNotIssuedQty} на ${p.oldNotIssuedCost} руб. Эти позиции не считаются фактически оприходованным складом до подтверждения приемки.`;
  const fields={TITLE:p.supplier,COMMENTS:comments,[role.FIELD_NAME]:roleId};
  if(paidF?.FIELD_NAME) fields[paidF.FIELD_NAME]=p.paidTotal;
  if(remF?.FIELD_NAME) fields[remF.FIELD_NAME]=p.unused;
  let companyId;
  if(found?.ID){ companyId=String(found.ID); await bx(env,"crm.company.update",{id:companyId,fields}); }
  else companyId=String(await bx(env,"crm.company.add",{fields,params:{REGISTER_SONET_EVENT:"N"}}));
  return companyId;
}

async function dealFields(env){ const r=await bx(env,"crm.deal.userfield.list",{order:{SORT:"ASC"}}); return Array.isArray(r)?r:[]; }
async function ensureSummaryDeal(env,p,companyId){
  const fieldsList=await dealFields(env);
  const typeF=fieldsList.find(f=>fieldLabel(f)==="Тип записи");
  const paidF=fieldsList.find(f=>fieldLabel(f)==="Оплачено поставщику, руб.");
  const balF=fieldsList.find(f=>fieldLabel(f)==="Долг поставщику, руб.");
  const typeId=enumId(typeF,"Закуп у поставщика");
  const title="[ПОСТАВЩИК] Мин Вэй — сверка 28.08.2026";
  const existing=await bx(env,"crm.deal.list",{order:{ID:"ASC"},filter:{"=TITLE":title},select:["ID","TITLE"],start:0});
  const e=Array.isArray(existing)&&existing.length?existing[0]:null;
  const fields={TITLE:title,COMPANY_ID:companyId,OPPORTUNITY:p.unused,CURRENCY_ID:"RUB",COMMENTS:`Поставщик Мин Вэй. Оплачено ${p.paidTotal}; выдано ${p.issuedQty} на ${p.issuedCost}; неиспользовано ${p.unused}; бронь/ожидается ${p.reservedQty} на ${p.reservedCost}; после брони свободно ${p.freeAfterReserve}.`};
  if(typeF?.FIELD_NAME&&typeId) fields[typeF.FIELD_NAME]=typeId;
  if(paidF?.FIELD_NAME) fields[paidF.FIELD_NAME]=p.paidTotal;
  if(balF?.FIELD_NAME) fields[balF.FIELD_NAME]=0;
  if(e?.ID) await bx(env,"crm.deal.update",{id:e.ID,fields}); else await bx(env,"crm.deal.add",{fields,params:{REGISTER_SONET_EVENT:"N"}});
}

async function ensurePayments(env,p,companyId){
  const fieldsList=await dealFields(env);
  const typeF=fieldsList.find(f=>fieldLabel(f)==="Тип записи");
  const paidF=fieldsList.find(f=>fieldLabel(f)==="Оплачено поставщику, руб.");
  const typeId=enumId(typeF,"Оплата поставщику");
  const daily={}; let created=0,updated=0;
  for(const pay of p.payments){
    const key=`${pay.date}|${pay.amount}`; daily[key]=(daily[key]||0)+1;
    const n=daily[key];
    const dateRu=pay.date.split("-").reverse().join(".");
    const title=`Оплата Мин Вэй — ${dateRu} — ${pay.amount} ₽ — ${n}`;
    const existing=await bx(env,"crm.deal.list",{order:{ID:"ASC"},filter:{"=TITLE":title},select:["ID","TITLE"],start:0});
    const e=Array.isArray(existing)&&existing.length?existing[0]:null;
    const fields={TITLE:title,COMPANY_ID:companyId,OPPORTUNITY:pay.amount,CURRENCY_ID:"RUB",COMMENTS:`Оплата поставщику Мин Вэй. Дата ${dateRu}. Сумма ${pay.amount} руб. Запись из сверки поставщика.`};
    if(typeF?.FIELD_NAME&&typeId) fields[typeF.FIELD_NAME]=typeId;
    if(paidF?.FIELD_NAME) fields[paidF.FIELD_NAME]=pay.amount;
    if(e?.ID){ await bx(env,"crm.deal.update",{id:e.ID,fields}); updated++; }
    else { await bx(env,"crm.deal.add",{fields,params:{REGISTER_SONET_EVENT:"N"}}); created++; }
  }
  return {created,updated};
}

async function ensureStores(env,p){
  const existing=await bx(env,"catalog.store.list",{select:["id","title","address","xmlId"],order:{id:"ASC"}});
  const stores=Array.isArray(existing?.stores)?existing.stores:(Array.isArray(existing)?existing:[]);
  const map={}; let created=0;
  for(const s of p.stores){
    let f=stores.find(x=>norm(x?.title)===norm(s.title));
    if(!f){
      const xmlId=`IF_TERM_${s.title.normalize("NFKD").replace(/[^A-Za-zА-Яа-я0-9]+/g,"_").toUpperCase()}`;
      const r=await bx(env,"catalog.store.add",{fields:{title:s.title,address:`${s.title} — терминал`,active:"Y",xmlId}});
      const id=String(r?.store?.id||r?.id||"");
      if(!id) throw new Error(`Store id missing: ${s.title}`);
      f={id,title:s.title}; stores.push(f); created++;
    }
    map[s.title]=String(f.id||f.ID);
  }
  return {map,created};
}

async function ensureProducts(env,p){
  let created=0,updated=0;
  const ids=[];
  for(const pos of p.positions){
    const xmlId=`MINWEI_${pos.number}`;
    const r=await bx(env,"catalog.product.list",{select:["id","iblockId","name","xmlId"],filter:{iblockId:p.iblockId,xmlId},order:{id:"ASC"}});
    const products=Array.isArray(r?.products)?r.products:(Array.isArray(r)?r:[]);
    const e=products[0];
    const detail=`Поставщик: ${p.supplier}. Терминал: ${pos.terminal}. Статус: ${pos.status}. Учетная стоимость: ${pos.cost} руб. ВАЖНО: позиция не оприходована как физический остаток; количество на складе = 0 до подтверждения приемки.`;
    const fields={iblockId:p.iblockId,name:`Контейнер — ${pos.number}`,active:"Y",xmlId,detailText:detail,detailTextType:"text",purchasingPrice:pos.cost,purchasingCurrency:"RUB",quantity:0,quantityTrace:"Y",canBuyZero:"N"};
    let id;
    if(e?.id){ id=String(e.id); await bx(env,"catalog.product.update",{id:e.id,fields}); updated++; }
    else { const a=await bx(env,"catalog.product.add",{fields}); id=String(a?.element?.id||a?.product?.id||a?.id||""); created++; }
    if(id) ids.push({id,number:pos.number,terminal:pos.terminal,status:pos.status});
  }
  return {created,updated,ids};
}

async function verifyZeroStock(env,ids){
  if(!ids.length) return {checked:0,positive:0};
  let positive=0,checked=0;
  for(const x of ids){
    const r=await bx(env,"catalog.storeproduct.list",{select:["id","storeId","productId","amount"],filter:{productId:Number(x.id)},order:{id:"ASC"}});
    const rows=Array.isArray(r?.storeProducts)?r.storeProducts:(Array.isArray(r)?r:[]);
    checked++;
    if(rows.some(v=>Number(v?.amount||0)>0)) positive++;
  }
  return {checked,positive};
}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(url.pathname==="/bitrix/apply-minwei-approved"&&request.method==="GET"){
      try{
        const raw=b64urlDecode(url.searchParams.get("p"));
        if(!raw||raw.length>12000) throw new Error("Invalid payload size");
        const hash=await sha256Hex(raw);
        if(!APPROVED.has(hash)) return Response.json({ok:false,version:VERSION,error:"Payload not approved"},{status:403,headers:{"Cache-Control":"no-store"}});
        const p=JSON.parse(raw);
        if(p?.v!==1) throw new Error("Invalid payload version");
        if(p.kind==="minwei_crm"){
          const companyId=await ensureRoleAndCompany(env,p);
          await ensureSummaryDeal(env,p,companyId);
          const pay=await ensurePayments(env,p,companyId);
          return Response.json({ok:true,version:VERSION,kind:p.kind,companyId,payments:pay},{headers:{"Cache-Control":"no-store"}});
        }
        if(p.kind==="minwei_catalog"){
          const stores=await ensureStores(env,p);
          const products=await ensureProducts(env,p);
          const stock=await verifyZeroStock(env,products.ids);
          if(stock.positive>0) throw new Error("Unexpected positive stock detected");
          return Response.json({ok:true,version:VERSION,kind:p.kind,storesCreated:stores.created,productsCreated:products.created,productsUpdated:products.updated,zeroStockVerified:stock},{headers:{"Cache-Control":"no-store"}});
        }
        throw new Error("Unknown payload kind");
      }catch(e){
        return Response.json({ok:false,version:VERSION,error:String(e?.message||e).slice(0,400)},{status:503,headers:{"Cache-Control":"no-store"}});
      }
    }
    return currentWorker.fetch(request,env,ctx);
  },
  async scheduled(controller,env,ctx){ if(typeof currentWorker.scheduled==="function") return currentWorker.scheduled(controller,env,ctx); }
};
