import { env } from "cloudflare:workers";
import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v84.js";

const VERSION = "worker-v87-bitrix-resilient-structure";
const ROOT = "93";
const SECTION_NAMES = [
  "00 КАРТОЧКА И РЕКВИЗИТЫ",
  "01 ДОГОВОРЫ И СПЕЦИФИКАЦИИ",
  "02 СЧЕТА, УПД И ЗАКРЫВАЮЩИЕ",
  "03 ПОСТАВЩИКИ И ЗАКУПКИ",
  "04 КОНТЕЙНЕРЫ — РЕЕСТРЫ И ВЫДАЧИ",
  "05 БАНК И ПЛАТЕЖИ",
  "06 ПОДОТЧЕТ И КОМАНДИРОВКИ",
  "07 115-ФЗ И ЗАПРОСЫ БАНКОВ",
  "08 ГОТОВЫЕ СВЕРКИ И ОТЧЕТЫ",
  "99 АРХИВ ГОТОВЫХ ДОКУМЕНТОВ",
];

export class MaxBotContainer extends BaseMaxBotContainer {}
const noCache = { "Cache-Control": "no-store" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function webhook(runtimeEnv) {
  return String(runtimeEnv?.BITRIX_WEBHOOK_URL || env.BITRIX_WEBHOOK_URL || "").trim();
}
function methodUrl(base, method) {
  const u = new URL(base);
  if (u.protocol !== "https:" || !/\/rest\/\d+\/[^/]+\/?$/i.test(u.pathname)) throw new Error("Invalid Bitrix webhook");
  u.search = ""; u.hash = "";
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  u.pathname += `${method}.json`;
  return u.toString();
}
async function bx(runtimeEnv, method, params = {}) {
  const base = webhook(runtimeEnv);
  if (!base) throw new Error("BITRIX_WEBHOOK_URL is not configured");
  let last = "unknown error";
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt || method !== "profile") await sleep(attempt ? 500 * (attempt + 1) : 180);
    try {
      const r = await fetch(methodUrl(base, method), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(params),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && !j?.error) return j?.result;
      last = String(j?.error_description || j?.error || `HTTP ${r.status}`);
      const transient = r.status === 429 || r.status >= 500 || /limit|tempor|timeout|520/i.test(last);
      if (!transient) throw new Error(`${method}: ${last}`);
    } catch (e) {
      last = String(e?.message || e);
      if (attempt === 4) throw new Error(`${method}: ${last}`);
    }
  }
  throw new Error(`${method}: ${last}`);
}
async function children(runtimeEnv, id) {
  const r = await bx(runtimeEnv, "disk.folder.getChildren", { id });
  return Array.isArray(r) ? r : [];
}
const iid = x => String(x?.ID || x?.id || "");
const iname = x => String(x?.NAME || x?.name || "");
const itype = x => String(x?.TYPE || x?.type || "").toLowerCase();
async function findFolder(runtimeEnv, parentId, name) {
  return (await children(runtimeEnv, parentId)).find(x => itype(x) === "folder" && iname(x) === name) || null;
}
async function ensureFolder(runtimeEnv, parentId, name) {
  const f = await findFolder(runtimeEnv, parentId, name);
  if (f) return { id: iid(f), name, created: false };
  const r = await bx(runtimeEnv, "disk.folder.addSubFolder", { id: parentId, data: { NAME: name } });
  const id = String(r?.ID || r?.id || "");
  if (!id) throw new Error(`No folder id for ${name}`);
  return { id, name, created: true };
}
async function ensureCompany(runtimeEnv, oldName, newName) {
  let current = await findFolder(runtimeEnv, ROOT, newName);
  if (current) return { id: iid(current), name: newName };
  const old = await findFolder(runtimeEnv, ROOT, oldName);
  if (old) {
    const id = iid(old);
    await bx(runtimeEnv, "disk.folder.rename", { id, newName });
    return { id, name: newName };
  }
  return ensureFolder(runtimeEnv, ROOT, newName);
}
async function buildSections(runtimeEnv, companyId) {
  const out = {};
  for (const name of SECTION_NAMES) out[name] = await ensureFolder(runtimeEnv, companyId, name);
  return out;
}
async function foldersStage(runtimeEnv) {
  const summary = await ensureFolder(runtimeEnv, ROOT, "00 РАБОЧАЯ СВОДНАЯ");
  const IF = await ensureCompany(runtimeEnv, "01 ИНТЕРФОРТУМ — проекты и первичка", "01 ИНТЕРФОРТУМ");
  const AMIDI = await ensureCompany(runtimeEnv, "02 АМИДИ ГРУПП — проекты и первичка", "02 АМИДИ ГРУПП");
  const ifSections = await buildSections(runtimeEnv, IF.id);
  const amidiSections = await buildSections(runtimeEnv, AMIDI.id);
  await ensureFolder(runtimeEnv, ifSections["01 ДОГОВОРЫ И СПЕЦИФИКАЦИИ"].id, "КОНСТЭВО");
  await ensureFolder(runtimeEnv, ifSections["04 КОНТЕЙНЕРЫ — РЕЕСТРЫ И ВЫДАЧИ"].id, "КОНСТЭВО");
  await ensureFolder(runtimeEnv, ifSections["08 ГОТОВЫЕ СВЕРКИ И ОТЧЕТЫ"].id, "ОПЕРАЦИОННЫЙ УЧЕТ");
  await ensureFolder(runtimeEnv, amidiSections["06 ПОДОТЧЕТ И КОМАНДИРОВКИ"].id, "2026-08");
  return { ok:true, version:VERSION, stage:"folders", summary, IF, AMIDI };
}
async function collect(runtimeEnv, folderId, path = [], depth = 0, out = []) {
  if (depth > 7) return out;
  const list = await children(runtimeEnv, folderId);
  for (const x of list) {
    if (itype(x) === "file") out.push({ id:iid(x), name:iname(x), parentId:folderId, path });
    else if (itype(x) === "folder") await collect(runtimeEnv, iid(x), [...path, iname(x)], depth + 1, out);
  }
  return out;
}
function classify(f) {
  const n = f.name.toLowerCase();
  const p = f.path.join("/").toLowerCase();
  if (/\.(zip|jpg|jpeg|png|webp|heic)$/i.test(n) || n.includes("выгрузка max") || n.includes("переписк")) return null;
  const company = p.includes("амиди") || n.includes("амиди") ? "AMIDI" : "IF";
  if (n.includes("заявки иф")) return { company:"IF", section:"08 ГОТОВЫЕ СВЕРКИ И ОТЧЕТЫ", sub:"ОПЕРАЦИОННЫЙ УЧЕТ" };
  if (n.includes("спецификац")) return { company:"IF", section:"01 ДОГОВОРЫ И СПЕЦИФИКАЦИИ", sub:"КОНСТЭВО" };
  if (n.includes("реестр ктк") || n.includes("20dc") || n.includes("40hc") || n.includes("поставщики, номера, оплаты") || (n.includes("констэво") && n.endsWith(".xlsx"))) return { company:"IF", section:"04 КОНТЕЙНЕРЫ — РЕЕСТРЫ И ВЫДАЧИ", sub:"КОНСТЭВО" };
  if (n.includes("поездки, наличные и переводы") || n.includes("расходы — поездки")) return { company:"AMIDI", section:"06 ПОДОТЧЕТ И КОМАНДИРОВКИ", sub:"2026-08" };
  if (n.includes("115-фз") || n.includes("115 фз") || (n.includes("пояснен") && n.includes("банк"))) return { company, section:"07 115-ФЗ И ЗАПРОСЫ БАНКОВ" };
  if (n.includes("выписка") || n.includes("платеж") || n.includes("платёж")) return { company, section:"05 БАНК И ПЛАТЕЖИ" };
  if (n.includes("упд") || n.includes("счет-фактур") || n.includes("счёт-фактур") || n.startsWith("акт")) return { company, section:"02 СЧЕТА, УПД И ЗАКРЫВАЮЩИЕ" };
  if (n.includes("договор")) return { company, section:"01 ДОГОВОРЫ И СПЕЦИФИКАЦИИ" };
  if (n.includes("сверк") || n.includes("итог") || (n.includes("реестр") && !n.includes("ктк"))) return { company, section:"08 ГОТОВЫЕ СВЕРКИ И ОТЧЕТЫ" };
  return { company, section:"99 АРХИВ ГОТОВЫХ ДОКУМЕНТОВ", review:true };
}
async function getCompany(runtimeEnv, name) {
  const f = await findFolder(runtimeEnv, ROOT, name);
  if (!f) throw new Error(`Company folder missing: ${name}`);
  return iid(f);
}
async function getSection(runtimeEnv, companyId, name, sub) {
  let f = await findFolder(runtimeEnv, companyId, name);
  if (!f) f = await ensureFolder(runtimeEnv, companyId, name);
  let id = iid(f) || f.id;
  if (sub) {
    const sf = await findFolder(runtimeEnv, id, sub) || await ensureFolder(runtimeEnv, id, sub);
    id = iid(sf) || sf.id;
  }
  return id;
}
async function moveStage(runtimeEnv) {
  const ifId = await getCompany(runtimeEnv, "01 ИНТЕРФОРТУМ");
  const amidiId = await getCompany(runtimeEnv, "02 АМИДИ ГРУПП");
  const files = await collect(runtimeEnv, ROOT);
  const moved = [], skippedRaw = [], review = [];
  for (const f of files) {
    const c = classify(f);
    if (!c) { skippedRaw.push(f.name); continue; }
    const companyId = c.company === "AMIDI" ? amidiId : ifId;
    const target = await getSection(runtimeEnv, companyId, c.section, c.sub);
    if (String(f.parentId) !== String(target)) {
      await bx(runtimeEnv, "disk.file.moveTo", { id:f.id, targetFolderId:target });
      moved.push({ name:f.name, to:`${c.company}/${c.section}${c.sub ? "/"+c.sub : ""}` });
    }
    if (c.review) review.push(f.name);
  }
  return { ok:true, version:VERSION, stage:"move", moved, skippedRaw, review };
}
async function deleteIfEmpty(runtimeEnv, parentId, name, deleted) {
  const f = await findFolder(runtimeEnv, parentId, name);
  if (!f) return;
  const id = iid(f);
  if ((await children(runtimeEnv, id)).length === 0) {
    await bx(runtimeEnv, "disk.folder.markDeleted", { id });
    deleted.push(name);
  }
}
async function cleanupStage(runtimeEnv) {
  const deleted=[];
  for (const name of [
    "03 ПОСТАВЩИКИ — закупки, оплаты, сверки",
    "04 КОНТЕЙНЕРЫ — реестры, выдачи, остатки",
    "05 БАНК — выписки и платежи",
    "06 ПОДОТЧЕТ И КОМАНДИРОВКИ",
    "07 ЗАПРОСЫ БАНКОВ — 115-ФЗ",
    "08 ПЕРЕПИСКИ И ИСХОДНИКИ",
    "99 РАЗОБРАТЬ",
  ]) await deleteIfEmpty(runtimeEnv, ROOT, name, deleted);
  return { ok:true, version:VERSION, stage:"cleanup", deleted };
}
async function tree(runtimeEnv) {
  const root = await children(runtimeEnv, ROOT);
  const out=[];
  for (const x of root) {
    const e={id:iid(x),name:iname(x),type:itype(x)};
    if (e.type === "folder" && ["00 РАБОЧАЯ СВОДНАЯ","01 ИНТЕРФОРТУМ","02 АМИДИ ГРУПП"].includes(e.name)) {
      e.children=(await children(runtimeEnv,e.id)).map(y=>({id:iid(y),name:iname(y),type:itype(y)}));
    }
    out.push(e);
  }
  return out;
}
export default {
  async fetch(request, runtimeEnv, ctx) {
    const url=new URL(request.url);
    try {
      if (url.pathname === "/bitrix/rebuild/folders") return Response.json(await foldersStage(runtimeEnv),{headers:noCache});
      if (url.pathname === "/bitrix/rebuild/move") return Response.json(await moveStage(runtimeEnv),{headers:noCache});
      if (url.pathname === "/bitrix/rebuild/cleanup") return Response.json(await cleanupStage(runtimeEnv),{headers:noCache});
      if (url.pathname === "/bitrix/rebuild/status") return Response.json({ok:true,version:VERSION,tree:await tree(runtimeEnv)},{headers:noCache});
    } catch(e) {
      return Response.json({ok:false,version:VERSION,error:String(e?.message||e)},{status:500,headers:noCache});
    }
    return currentWorker.fetch(request,runtimeEnv,ctx);
  },
  async scheduled(controller,runtimeEnv,ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller,runtimeEnv,ctx);
  },
};
