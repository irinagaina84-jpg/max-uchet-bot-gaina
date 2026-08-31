import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v96.js";

const VERSION = "worker-v99-bitrix-projects-corrected";
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
  for (let i = 0; i < 5; i++) {
    if (i) await sleep(600 * i);
    const r = await fetch(methodUrl(base, method), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(params),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && !j?.error) return j?.result;
    last = String(j?.error_description || j?.error || `HTTP ${r.status}`);
    if (!(r.status === 429 || r.status >= 500 || /limit|tempor|timeout|execution/i.test(last))) break;
  }
  throw new Error(`${method}: ${last}`);
}

const PROJECTS = [
  { name: "КОНСТЭВО", legal: "ИНТЕРФОРТУМ", companyFolder: "01 ИНТЕРФОРТУМ — проекты и первичка", projectFolder: "01 КОНСТЭВО" },
  { name: "ВЗЛЁТ", legal: "АМИДИ ГРУПП", companyFolder: "02 АМИДИ ГРУПП — проекты и первичка", projectFolder: "01 ВЗЛЁТ" },
  { name: "ДИП", legal: "ООО АТЛАС", companyFolder: "03 ООО АТЛАС — проекты и первичка", projectFolder: "01 ДИП" },
];

const PROJECT_SUBFOLDERS = [
  "00 СВОДНАЯ",
  "01 ДОГОВОРЫ И СЧЕТА",
  "02 ПОСТАВЩИКИ",
  "03 РЕЕСТР ОПЛАТ",
  "04 ЗАКУП",
  "05 ВЫДАЧИ И РЕЕСТРЫ КТК",
  "06 УПД, АКТЫ, ЗАКРЫВАЮЩИЕ",
  "07 ЗАЯВКИ",
  "99 АРХИВ",
];

const DEAL_ENUMS = [
  { code: "PROJ", label: "Проект", sort: 90, values: PROJECTS.map(p => p.name) },
  { code: "PAYSTAT", label: "Оплата — статус", sort: 100, values: ["К оплате", "Частично оплачено", "Оплачено", "На проверке", "Возврат / корректировка"] },
];
const DEAL_FIELDS = [
  ["PAYDATE", "date", "Оплата — дата", 510],
  ["PAYSUM", "double", "Оплата — сумма, руб.", 520],
  ["PAYSUP", "string", "Оплата — поставщик", 530],
  ["PAYINV", "string", "Оплата — счёт / основание", 540],
  ["PAYPAYER", "string", "Оплата — плательщик", 550],
  ["PAYPURP", "string", "Оплата — назначение", 560],
  ["PAYBAL", "double", "Оплата — остаток по счёту, руб.", 570],
  ["SUPPRICE", "double", "Поставщик — закупка за единицу, руб.", 580],
  ["SUPPAIDQ", "double", "Поставщик — оплачено, шт.", 590],
  ["SUPISSQ", "double", "Поставщик — выдано, шт.", 600],
  ["SUPBALQ", "double", "Поставщик — остаток, шт.", 610],
  ["REGNOTE", "string", "Реестр — примечание", 620],
];
const COMPANY_ENUMS = [
  { code: "CPROLE", label: "Роль контрагента", sort: 100, multiple: false, values: ["Поставщик", "Перевозчик", "Клиент", "Прочее"] },
  { code: "SUPPROJ", label: "Поставщик — проекты", sort: 110, multiple: true, values: PROJECTS.map(p => p.name) },
];
const COMPANY_FIELDS = [
  ["SUPTERMS", "string", "Поставщик — условия оплаты", 120],
  ["SUPBALR", "double", "Поставщик — баланс / остаток, руб.", 130],
  ["SUPRECD", "date", "Поставщик — дата последней сверки", 140],
  ["SUPNOTE", "string", "Поставщик — примечание", 150],
];

async function children(env, folderId) {
  const r = await bx(env, "disk.folder.getchildren", { id: folderId });
  return Array.isArray(r) ? r : [];
}
async function findFolder(env, parentId, name) {
  const items = await children(env, parentId);
  const found = items.find(x => String(x?.TYPE || x?.type || "").toLowerCase() === "folder" && String(x?.NAME || x?.name || "").trim() === name);
  return found ? String(found.ID || found.id) : null;
}
async function ensureFolder(env, parentId, name) {
  const existing = await findFolder(env, parentId, name);
  if (existing) return existing;
  const added = await bx(env, "disk.folder.addsubfolder", { id: parentId, data: { NAME: name } });
  const id = String(added?.ID || added?.id || "");
  if (!id) throw new Error(`Folder id missing: ${name}`);
  return id;
}
async function mainRoot(env) {
  const storages = await bx(env, "disk.storage.getlist", {});
  const list = Array.isArray(storages) ? storages : [];
  const storage = list.find(s => String(s?.ENTITY_TYPE || "").toLowerCase() === "common") || list.find(s => /общ|common|company|компан/i.test(String(s?.NAME || "")));
  if (!storage) throw new Error("Common storage missing");
  let rootId = String(storage?.ROOT_OBJECT_ID || "");
  if (!rootId) {
    const full = await bx(env, "disk.storage.get", { id: storage.ID });
    rootId = String(full?.ROOT_OBJECT_ID || "");
  }
  const main = await findFolder(env, rootId, "00 УЧЕТ — ИНТЕРФОРТУМ + АМИДИ — КОНТЕЙНЕРЫ");
  if (!main) throw new Error("Accounting root missing");
  return main;
}

async function treeHasFiles(env, folderId) {
  const items = await children(env, folderId);
  for (const item of items) {
    const type = String(item?.TYPE || item?.type || "").toLowerCase();
    if (type === "file") return true;
    if (type === "folder" && await treeHasFiles(env, String(item.ID || item.id))) return true;
  }
  return false;
}
async function cleanupWrongDipFolder(env, root) {
  const oldCompany = await findFolder(env, root, "01 ИНТЕРФОРТУМ — проекты и первичка");
  if (!oldCompany) return false;
  const oldDip = await findFolder(env, oldCompany, "02 ДИП");
  if (!oldDip) return false;
  if (await treeHasFiles(env, oldDip)) return false;
  try { await bx(env, "disk.folder.delete", { id: oldDip }); return true; } catch { return false; }
}

function labelOf(f) {
  return String(f?.EDIT_FORM_LABEL || f?.LIST_COLUMN_LABEL || f?.LIST_FILTER_LABEL || "").trim();
}
async function listDealFields(env) {
  const r = await bx(env, "crm.deal.userfield.list", { order: { SORT: "ASC" } });
  return Array.isArray(r) ? r : [];
}
async function listCompanyFields(env) {
  const r = await bx(env, "crm.company.userfield.list", { order: { SORT: "ASC" } });
  return Array.isArray(r) ? r : [];
}
async function ensureEnumField(env, entity, def, existing) {
  if (existing.some(f => labelOf(f) === def.label)) return;
  const method = entity === "deal" ? "crm.deal.userfield.add" : "crm.company.userfield.add";
  await bx(env, method, { fields: {
    FIELD_NAME: def.code,
    USER_TYPE_ID: "enumeration",
    XML_ID: `IF_${def.code}`,
    SORT: def.sort,
    MULTIPLE: def.multiple ? "Y" : "N",
    MANDATORY: "N",
    SHOW_FILTER: "Y",
    SHOW_IN_LIST: "Y",
    EDIT_IN_LIST: "Y",
    EDIT_FORM_LABEL: def.label,
    LIST_COLUMN_LABEL: def.label,
    LIST_FILTER_LABEL: def.label,
    LIST: def.values.map((v, i) => ({ VALUE: v, XML_ID: `IF_${def.code}_${i+1}`, SORT: (i+1)*100, DEF: "N" })),
    SETTINGS: { DISPLAY: "UI", LIST_HEIGHT: Math.min(5, def.values.length) },
  }});
}
async function ensureScalarField(env, entity, def, existing) {
  const [code, type, label, sort] = def;
  if (existing.some(f => labelOf(f) === label)) return;
  const method = entity === "deal" ? "crm.deal.userfield.add" : "crm.company.userfield.add";
  await bx(env, method, { fields: {
    FIELD_NAME: code,
    USER_TYPE_ID: type,
    XML_ID: `IF_${code}`,
    SORT: sort,
    MULTIPLE: "N",
    MANDATORY: "N",
    SHOW_FILTER: "Y",
    SHOW_IN_LIST: "Y",
    EDIT_IN_LIST: "Y",
    EDIT_FORM_LABEL: label,
    LIST_COLUMN_LABEL: label,
    LIST_FILTER_LABEL: label,
  }});
}
async function ensureCrmFields(env) {
  let deal = await listDealFields(env);
  for (const def of DEAL_ENUMS) { await ensureEnumField(env, "deal", def, deal); deal = await listDealFields(env); }
  for (const def of DEAL_FIELDS) { await ensureScalarField(env, "deal", def, deal); deal = await listDealFields(env); }
  let company = await listCompanyFields(env);
  for (const def of COMPANY_ENUMS) { await ensureEnumField(env, "company", def, company); company = await listCompanyFields(env); }
  for (const def of COMPANY_FIELDS) { await ensureScalarField(env, "company", def, company); company = await listCompanyFields(env); }
}

async function ensureFolders(env) {
  const root = await mainRoot(env);
  const made = [];
  for (const p of PROJECTS) {
    const company = await ensureFolder(env, root, p.companyFolder);
    const project = await ensureFolder(env, company, p.projectFolder);
    for (const sub of PROJECT_SUBFOLDERS) await ensureFolder(env, project, sub);
    made.push({ project: p.name, legal: p.legal, folderId: project });
  }
  const suppliersRoot = await ensureFolder(env, root, "03 ПОСТАВЩИКИ — закупки, оплаты, сверки");
  for (const sub of ["00 РЕЕСТР ПОСТАВЩИКОВ", "01 ОПЛАТЫ ПОСТАВЩИКАМ", "02 СВЕРКИ", "03 ДОКУМЕНТЫ ПОСТАВЩИКОВ"]) await ensureFolder(env, suppliersRoot, sub);
  for (const p of PROJECTS) {
    const pf = await ensureFolder(env, suppliersRoot, p.name);
    for (const sub of ["01 ПОСТАВЩИКИ", "02 ОПЛАТЫ", "03 СВЕРКИ"]) await ensureFolder(env, pf, sub);
  }
  const bankRoot = await ensureFolder(env, root, "05 БАНК — выписки и платежи");
  const paymentsRoot = await ensureFolder(env, bankRoot, "00 РЕЕСТР ОПЛАТ ПО ПРОЕКТАМ");
  for (const p of PROJECTS) await ensureFolder(env, paymentsRoot, p.name);
  const cleanedWrongDip = await cleanupWrongDipFolder(env, root);
  return { made, cleanedWrongDip };
}

async function cleanupWrongDipDeal(env) {
  try {
    const rows = await bx(env, "crm.deal.list", { filter: { "=TITLE": "ДИП — ИНТЕРФОРТУМ" }, select: ["ID","TITLE","COMMENTS"], start: 0 });
    let removed = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      const c = String(row?.COMMENTS || "");
      if (c.includes("Карточка проекта")) {
        await bx(env, "crm.deal.delete", { id: row.ID });
        removed++;
      }
    }
    return removed;
  } catch { return 0; }
}

async function ensureSonetProjects(env) {
  const created = [];
  for (const p of PROJECTS) {
    const name = `${p.name} — ${p.legal}`;
    const list = await bx(env, "sonet_group.get", { FILTER: { NAME: name, PROJECT: "Y", ACTIVE: "Y" }, ORDER: { ID: "DESC" } });
    const found = Array.isArray(list) ? list.find(x => String(x?.NAME || "").trim() === name) : null;
    if (found) { created.push({ name, id: found.ID, created: false }); continue; }
    const id = await bx(env, "sonet_group.create", { NAME: name, DESCRIPTION: `Рабочий проект ${p.name}. Юрлицо: ${p.legal}.`, PROJECT: "Y", VISIBLE: "N", OPENED: "N", CLOSED: "N" });
    created.push({ name, id, created: true });
  }
  return created;
}

async function ensureAll(env) {
  const folders = await ensureFolders(env);
  await ensureCrmFields(env);
  const removedWrongDeals = await cleanupWrongDipDeal(env);
  let sonetReady = true;
  let sonetProjects = [];
  let sonetError = null;
  try { sonetProjects = await ensureSonetProjects(env); }
  catch (e) { sonetReady = false; sonetError = String(e?.message || e).slice(0, 180); }
  return { ok: true, version: VERSION, folders: folders.made.length, cleanedWrongDip: folders.cleanedWrongDip, removedWrongDeals, sonetReady, sonetProjects: sonetProjects.length, sonetError };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/bitrix/health") {
      let setup = null;
      try { setup = await ensureAll(env); }
      catch (e) { setup = { ok: false, error: String(e?.message || e).slice(0, 180) }; }
      try {
        const response = await currentWorker.fetch(request, env, ctx);
        const payload = await response.clone().json().catch(() => null);
        return Response.json({ ok: Boolean(response.ok && payload?.ok && setup?.ok), version: VERSION, projectAccountingConfigured: Boolean(setup?.ok), sonetReady: Boolean(setup?.sonetReady), setup }, { status: response.ok && setup?.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
      } catch {
        return Response.json({ ok: false, version: VERSION, projectAccountingConfigured: Boolean(setup?.ok), sonetReady: Boolean(setup?.sonetReady), setup }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
    }
    return currentWorker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    try { await ensureAll(env); } catch {}
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, env, ctx);
  },
};
