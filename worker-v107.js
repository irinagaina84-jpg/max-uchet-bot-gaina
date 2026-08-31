import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v106.js";

const VERSION = "worker-v107-project-model";
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
  let last = "unknown";
  for (let i=0;i<5;i++) {
    if (i) await sleep(450*i);
    const r = await fetch(methodUrl(base, method), {method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(params)});
    const j = await r.json().catch(()=>({}));
    if (r.ok && !j?.error) return j?.result;
    last = String(j?.error_description || j?.error || `HTTP ${r.status}`);
    if (!(r.status===429 || r.status>=500 || /limit|tempor|timeout|execution/i.test(last))) break;
  }
  throw new Error(`${method}: ${last}`);
}

function text(v){
  if(typeof v==="string") return v.trim();
  if(v&&typeof v==="object") for(const x of Object.values(v)) if(typeof x==="string"&&x.trim()) return x.trim();
  return "";
}
function label(f){ return text(f?.EDIT_FORM_LABEL)||text(f?.LIST_COLUMN_LABEL)||text(f?.LIST_FILTER_LABEL); }
function fname(f){ return String(f?.FIELD_NAME||""); }
function enumId(f, value){ const x=(Array.isArray(f?.LIST)?f.LIST:[]).find(v=>String(v?.VALUE||"").trim()===value); return x?.ID?String(x.ID):null; }

const RECORD_TYPES=["Проект","Клиентская спецификация","Закуп у поставщика","Оплата клиента","Оплата поставщику","Неразнесенная оплата клиента"];
const PROJECTS=["КОНСТЭВО","ВЗЛЁТ","ДИП"];
const FIELD_DEFS=[
  ["RECTYPE","enumeration","Тип записи",RECORD_TYPES,650],
  ["CONTRACTNO","string","Договор — номер",null,660],
  ["CONTRACTDATE","date","Договор — дата",null,670],
  ["SPECNO","string","Спецификация — номер",null,680],
  ["SPECDATE","date","Спецификация — дата",null,690],
  ["ORDERQTY","integer","Заказ клиента — количество, шт.",null,700],
  ["ALLOCQTY","integer","Привязано к проекту, шт.",null,710],
  ["ISSUEDQTY","integer","Выдано клиенту, шт.",null,720],
  ["REMAINQTY","integer","Остаток, шт.",null,730],
  ["PURCHQTY","integer","Закуплено у поставщика, шт.",null,740],
  ["CLIENTPAID","double","Оплачено клиентом, руб.",null,750],
  ["CLIENTBAL","double","Остаток оплаты клиента, руб.",null,760],
  ["SUPPPAID","double","Оплачено поставщику, руб.",null,770],
  ["SUPPBAL","double","Долг поставщику, руб.",null,780],
  ["MODELNOTE","string","Учет — примечание",null,790],
];

async function listDealFields(env){ const r=await bx(env,"crm.deal.userfield.list",{order:{SORT:"ASC"}}); return Array.isArray(r)?r:[]; }
function findField(fields, code, lab){ return fields.find(f=>fname(f)===`UF_CRM_${code}`)||fields.find(f=>label(f)===lab)||null; }
async function ensureFields(env){
  let fields=await listDealFields(env);
  for(const [code,type,lab,values,sort] of FIELD_DEFS){
    if(findField(fields,code,lab)) continue;
    const def={FIELD_NAME:code,USER_TYPE_ID:type,XML_ID:`IF_${code}`,SORT:sort,MULTIPLE:"N",MANDATORY:"N",SHOW_FILTER:"Y",SHOW_IN_LIST:"Y",EDIT_IN_LIST:"Y",EDIT_FORM_LABEL:lab,LIST_COLUMN_LABEL:lab,LIST_FILTER_LABEL:lab};
    if(type==="enumeration") { def.LIST=values.map((v,i)=>({VALUE:v,XML_ID:`IF_${code}_${i+1}`,SORT:(i+1)*100,DEF:"N"})); def.SETTINGS={DISPLAY:"UI",LIST_HEIGHT:Math.min(values.length,7)}; }
    await bx(env,"crm.deal.userfield.add",{fields:def});
    fields=await listDealFields(env);
  }
  return fields;
}

async function children(env,id){ const r=await bx(env,"disk.folder.getchildren",{id}); return Array.isArray(r)?r:[]; }
async function findFolder(env,parent,name){ const a=await children(env,parent); const f=a.find(x=>String(x?.TYPE||x?.type||"").toLowerCase()==="folder"&&String(x?.NAME||x?.name||"").trim()===name); return f?String(f.ID||f.id):null; }
async function ensureFolder(env,parent,name){ const e=await findFolder(env,parent,name); if(e) return e; const r=await bx(env,"disk.folder.addsubfolder",{id:parent,data:{NAME:name}}); const id=String(r?.ID||r?.id||""); if(!id) throw new Error(`folder ${name}`); return id; }
async function accountingRoot(env){
  const s=await bx(env,"disk.storage.getlist",{}); const list=Array.isArray(s)?s:[];
  const st=list.find(x=>String(x?.ENTITY_TYPE||"").toLowerCase()==="common")||list[0]; if(!st) throw new Error("storage");
  let root=String(st.ROOT_OBJECT_ID||""); if(!root) root=String((await bx(env,"disk.storage.get",{id:st.ID}))?.ROOT_OBJECT_ID||"");
  const main=await findFolder(env,root,"00 УЧЕТ — ИНТЕРФОРТУМ + АМИДИ — КОНТЕЙНЕРЫ"); if(!main) throw new Error("accounting root"); return main;
}
const SUBS=["00 КАРТОЧКА ПРОЕКТА","01 КЛИЕНТ","02 ДОГОВОРЫ","03 СПЕЦИФИКАЦИИ","04 ОПЛАТЫ КЛИЕНТА","05 ПОСТАВЩИКИ","06 ЗАКУП У ПОСТАВЩИКОВ","07 РАСПРЕДЕЛЕНИЕ ПОСТАВЩИКОВ","08 ВЫДАЧИ КЛИЕНТУ","09 УПД И ЗАКРЫВАЮЩИЕ","10 СВЕРКА И ОСТАТКИ","99 АРХИВ"];
const ROOTS=[
  ["01 ИНТЕРФОРТУМ — проекты и первичка","01 КОНСТЭВО"],
  ["02 АМИДИ ГРУПП — проекты и первичка","01 ВЗЛЁТ"],
  ["03 ООО АТЛАС — проекты и первичка","01 ДИП"],
];
async function ensureTree(env){ const root=await accountingRoot(env); const out=[]; for(const [co,pr] of ROOTS){ const c=await ensureFolder(env,root,co); const p=await ensureFolder(env,c,pr); for(const s of SUBS) await ensureFolder(env,p,s); out.push(pr); } return out; }

const RECORDS=[
  {title:"[ПРОЕКТ] КОНСТЭВО — АО КОНСТЭВО",project:"КОНСТЭВО",type:"Проект",order:514,issued:171,remain:343,clientPaid:21755000,note:"По спецификациям №37/39/40/42/43/№8: 514 шт.; оплачено клиентом 215 шт. на 21 755 000 ₽; выдано 171; осталось по спецификациям 343. Старый долг 2×20 DC учитывать отдельно."},
  {title:"КОНСТЭВО — №37 — 300×20 DC",project:"КОНСТЭВО",type:"Клиентская спецификация",spec:"№37",order:300,issued:60,remain:240,clientPaid:6780000,note:"Цена продажи 113 000 ₽/шт. Оплаченная часть 60 закрыта; 240 не оплачены и не выданы."},
  {title:"КОНСТЭВО — №39 — 9×40 HC",project:"КОНСТЭВО",type:"Клиентская спецификация",spec:"№39",order:9,issued:9,remain:0,clientPaid:747000,note:"Закрыто. Цена 83 000 ₽/шт."},
  {title:"КОНСТЭВО — №40 — 100×40 HC",project:"КОНСТЭВО",type:"Клиентская спецификация",spec:"№40",order:100,issued:51,remain:49,clientPaid:3403000,note:"Оплачено 41 шт.; выдано 51, в том числе 10 сверх оплаты. Цена 83 000 ₽/шт."},
  {title:"КОНСТЭВО — №42 — 50×20 DC — Мин Вэй",project:"КОНСТЭВО",type:"Клиентская спецификация",spec:"№42",supplier:"Мин Вэй",order:50,alloc:50,issued:8,remain:42,clientPaid:5900000,note:"Поставщик по выдачам: Мин Вэй. Закупленное количество и оплата поставщику требуют отдельной сверки; не подставлять автоматически."},
  {title:"КОНСТЭВО — №43 — 50×40 HC — Мин Вэй",project:"КОНСТЭВО",type:"Клиентская спецификация",spec:"№43",supplier:"Мин Вэй",order:50,alloc:50,issued:43,remain:7,clientPaid:4150000,note:"Поставщик по выдачам: Мин Вэй. Закупленное количество и оплата поставщику требуют отдельной сверки."},
  {title:"КОНСТЭВО — Спец №8 — 5×40 HC",project:"КОНСТЭВО",type:"Клиентская спецификация",spec:"№8",order:5,issued:0,remain:5,clientPaid:775000,note:"Владивосток; выдачи пока не подтверждены."},
  {title:"КОНСТЭВО — старый долг Мин Вэй — 2×20 DC",project:"КОНСТЭВО",type:"Закуп у поставщика",supplier:"Мин Вэй",alloc:2,issued:0,remain:2,note:"Вне счетов №37/39/40/42/43/№8. Учитывать отдельно."},

  {title:"[ПРОЕКТ] ВЗЛЁТ — 200×20 DC",project:"ВЗЛЁТ",type:"Проект",order:200,issued:161,remain:39,note:"20 фут БУ, Москва. Продажа 135 000 ₽ с НДС. По выдачам: Александра 99 + Май Вэй 56 + Фахрат 6 = 161; Наталья 0."},
  {title:"ВЗЛЁТ — заказ клиента — 200×20 DC",project:"ВЗЛЁТ",type:"Клиентская спецификация",order:200,issued:161,remain:39,note:"Контрольный остаток клиента 39 контейнеров."},
  {title:"ВЗЛЁТ — закуп — Александра — 120×20 DC",project:"ВЗЛЁТ",type:"Закуп у поставщика",supplier:"Александра",purchase:120,alloc:120,issued:99,remain:21,note:"100×115 000 ₽ с НДС + 20×88 000 ₽ наличными. Из остатка 21: 2 уже в Чехове, еще 19 нужно найти/получить."},
  {title:"ВЗЛЁТ — закуп — Май Вэй — ресурс 56×20 DC",project:"ВЗЛЁТ",type:"Закуп у поставщика",supplier:"Май Вэй",purchase:36,alloc:56,issued:56,remain:0,note:"Собственный закуп 36×90 000 ₽/шт + 20 из ресурса КОНСТЭВО. Выдано 56, остаток 0."},
  {title:"ВЗЛЁТ — закуп — Фахрат / Голдконтейнер — 10×20 DC",project:"ВЗЛЁТ",type:"Закуп у поставщика",supplier:"Фахрат / Голдконтейнер",purchase:10,alloc:10,issued:6,remain:4,suppPaid:900000,note:"10×90 000 ₽ наличными. Оплачено 900 000 ₽; выдано 6; остаток 4."},
  {title:"ВЗЛЁТ — закуп — Наталья — 6×20 DC",project:"ВЗЛЁТ",type:"Закуп у поставщика",supplier:"Наталья",purchase:6,alloc:6,issued:0,remain:6,note:"6×85 000 ₽ наличными. Куплены для перекрытия долга КОНСТЭВО; в свободный остаток ВЗЛЁТа не считать."},

  {title:"[ПРОЕКТ] ДИП — ООО АТЛАС — 75×20",project:"ДИП",type:"Проект",order:75,issued:0,remain:75,note:"ООО АТЛАС. 75×20-футовые БУ. Продажа 130 000 ₽/шт с НДС; выручка 9 750 000 ₽."},
  {title:"ДИП — ООО АТЛАС — заказ 75×20",project:"ДИП",type:"Клиентская спецификация",order:75,issued:0,remain:75,note:"Продажа 130 000 ₽/шт с НДС. Договор/номер спецификации привязать после загрузки подписанных документов."},
  {title:"ДИП — закуп — Фахрат — 75×20",project:"ДИП",type:"Закуп у поставщика",supplier:"Фахрат / Голдконтейнер",purchase:75,alloc:75,issued:0,remain:75,note:"План закупа 75×90 000 ₽ = 6 750 000 ₽ наличными. Факт оплаты поставщику пока не подтвержден — не считать оплаченным."},
];

async function allDeals(env){ const out=[]; for(let start=0;start<5000;start+=50){ const r=await bx(env,"crm.deal.list",{order:{ID:"ASC"},filter:{},select:["ID","TITLE"],start}); const a=Array.isArray(r)?r:[]; out.push(...a); if(a.length<50) break; } return out; }
async function ensureRecords(env, fields){
  const projectF=findField(fields,"PROJ","Проект"); const typeF=findField(fields,"RECTYPE","Тип записи");
  const contractF=findField(fields,"CONTRACTNO","Договор — номер"); const specF=findField(fields,"SPECNO","Спецификация — номер");
  const orderF=findField(fields,"ORDERQTY","Заказ клиента — количество, шт."); const allocF=findField(fields,"ALLOCQTY","Привязано к проекту, шт.");
  const issuedF=findField(fields,"ISSUEDQTY","Выдано клиенту, шт."); const remainF=findField(fields,"REMAINQTY","Остаток, шт.");
  const purchaseF=findField(fields,"PURCHQTY","Закуплено у поставщика, шт."); const cpaidF=findField(fields,"CLIENTPAID","Оплачено клиентом, руб.");
  const spaidF=findField(fields,"SUPPPAID","Оплачено поставщику, руб."); const noteF=findField(fields,"MODELNOTE","Учет — примечание");
  const supplierF=fields.find(f=>fname(f)==="UF_CRM_SUPPLIER")||fields.find(f=>label(f)==="Поставщик");
  const rows=await allDeals(env); const byTitle=new Map(rows.map(r=>[String(r.TITLE||"").trim(),String(r.ID)]));
  let created=0,updated=0;
  for(const rec of RECORDS){
    const f={TITLE:rec.title,COMMENTS:rec.note||""};
    if(projectF){ const id=enumId(projectF,rec.project); if(id) f[fname(projectF)]=id; }
    if(typeF){ const id=enumId(typeF,rec.type); if(id) f[fname(typeF)]=id; }
    if(contractF&&rec.contract) f[fname(contractF)]=rec.contract;
    if(specF&&rec.spec) f[fname(specF)]=rec.spec;
    if(orderF&&rec.order!==undefined) f[fname(orderF)]=rec.order;
    if(allocF&&rec.alloc!==undefined) f[fname(allocF)]=rec.alloc;
    if(issuedF&&rec.issued!==undefined) f[fname(issuedF)]=rec.issued;
    if(remainF&&rec.remain!==undefined) f[fname(remainF)]=rec.remain;
    if(purchaseF&&rec.purchase!==undefined) f[fname(purchaseF)]=rec.purchase;
    if(cpaidF&&rec.clientPaid!==undefined) f[fname(cpaidF)]=rec.clientPaid;
    if(spaidF&&rec.suppPaid!==undefined) f[fname(spaidF)]=rec.suppPaid;
    if(noteF&&rec.note) f[fname(noteF)]=rec.note;
    if(supplierF&&rec.supplier) f[fname(supplierF)]=rec.supplier;
    const id=byTitle.get(rec.title);
    if(id){ await bx(env,"crm.deal.update",{id,fields:f}); updated++; }
    else { const n=await bx(env,"crm.deal.add",{fields:f,params:{REGISTER_SONET_EVENT:"N"}}); byTitle.set(rec.title,String(n)); created++; }
  }
  return {created,updated,total:RECORDS.length};
}

async function setup(env){ const fields=await ensureFields(env); const tree=await ensureTree(env); const records=await ensureRecords(env,fields); return {ok:true,version:VERSION,tree,records}; }

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(url.pathname==="/bitrix/setup-project-model" && request.method==="GET"){
      try{return Response.json(await setup(env),{headers:{"Cache-Control":"no-store"}});}catch(e){return Response.json({ok:false,version:VERSION,error:String(e?.message||e).slice(0,500)},{status:500,headers:{"Cache-Control":"no-store"}});}
    }
    return currentWorker.fetch(request,env,ctx);
  },
  async scheduled(controller,env,ctx){ if(typeof currentWorker.scheduled==="function") return currentWorker.scheduled(controller,env,ctx); }
};
