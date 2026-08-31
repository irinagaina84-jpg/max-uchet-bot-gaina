import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v96.js";

const VERSION = "worker-v98-bitrix-project-accounting";
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
  for (let i = 0; i < 4; i++) {
    if (i) await sleep(500 * i);
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
  { code: "KONSTEVO", name: "КОНСТЭВО", legal: "ИНТЕРФОРТУМ", companyFolder: "01 ИНТЕРФОРТУМ — проекты и первичка", projectFolder: "01 КОНСТЭВО" },
  { code: "VZLET", name: "ВЗЛЁТ", legal: "АМИДИ ГРУПП", companyFolder: "02 АМИДИ ГРУПП — проекты и первичка", projectFolder: "01 ВЗЛЁТ" },
  { code: "DIP", name: "ДИП", legal: "ИНТЕРФОРТУМ", companyFolder: "01 ИНТЕРФОРТУМ — проекты и первичка", projectFolder: "02 ДИП" },
];

const PROJECT_SUBFOLDERS = [
  "00 СВОДНАЯ",
  "01 ДОГОВОРЫ И СЧЕТА",
  "02 ПОСТАВЩИКИ",
  "03 РЕЕСТР ОПЛАТ",
  "04 ЗАКУП",
  "05 ВЫДАЧИ И РЕЕСТРЫ КТК",
  "06 УПД, АКТЫ, ЗАКРЫВАЮЩИЕ",
  "07 ПЕРЕПИСКА И ЗАЯВКИ",
  "99 АРХИВ",
];

const DEAL_ENUMS = [
  { code: "PROJECT_ACCOUNTING", label: "Проект", sort: 90, values: PROJECTS.map(p => p.name) },
  { code: "PAYMENT_STATUS", label: "Оплата — статус", sort: 100, values: ["К оплате", "Частично оплачено", "Оплачено", "На проверке", "Возврат / корректировка"] },
];

const DEAL_FIELDS = [
  ["PAYMENT_DATE", "date", "Оплата — дата", 510],
  ["PAYMENT_AMOUNT", "double", "Оплата — сумма, руб.", 520],
  ["PAYMENT_SUPPLIER", "string", "Оплата — поставщик", 530],
  ["PAYMENT_INVOICE", "string", "Оплата — счёт / основание", 540],
  ["PAYMENT_PAYER", "string", "Оплата — плательщик", 550],
  ["PAYMENT_PURPOSE", "string", "Оплата — назначение", 560],
  ["PAYMENT_BALANCE", "double", "Оплата — остаток по счёту, руб.", 570],
  ["SUPPLIER_UNIT_PRICE", "double", "Поставщик — закупка за единицу, руб.", 580],
  ["SUPPLIER_PAID_QTY", "double", "Поставщик — оплачено, шт.", 590],
  ["SUPPLIER_ISSUED_QTY", "double", "Поставщик — выдано, шт.", 600],
  ["SUPPLIER_BALANCE_QTY", "double", "Поставщик — остаток, шт.", 610],
  ["REGISTRY_NOTE", "string", "Реестр — примечание", 620],
];

const COMPANY_ENUMS = [
  { code: "COUNTERPARTY_ROLE", label: "Роль контрагента", sort: 100, multiple: false, values: ["Поставщик", "Перевозчик", "Клиент", "Прочее"] },
  { code: "SUPPLIER_PROJECTS", label: "Поставщик — проекты", sort: 110, multiple: true, values: PROJECTS.map(p => p.name) },
];
const COMPANY_FIELDS = [
  ["SUPPLIER_PAYMENT_TERMS", "string", "Поставщик — условия оплаты", 120],
  ["SUPPLIER_BALANCE_RUB", "double", "Поставщик — баланс / остаток, руб.", 130],
  ["SUPPLIER_RECONCILIATION_DATE", "date", "Поставщик — дата последней сверки", 140],
  ["SUPPLIER_NOTE", "string", "Поставщик — примечание", 150],
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

async function ensureProjectFolders(env) {
  const root = await mainRoot(env);
  const made = [];
  for (const p of PROJECTS) {
    const company = await ensureFolder(env, root, p.companyFolder);
    const project = await ensureFolder(env, company, p.projectFolder);
    for (const name of PROJECT_SUBFOLDERS) await ensureFolder(env, project, name);
    made.push({ project: p.name, folderId: project });
  }

  const suppliersRoot = await ensureFolder(env, root, "03 ПОСТАВЩИКИ — закупки, оплаты, сверки");
  const supplierSections = ["00 РЕЕСТР ПОСТАВЩИКОВ", "01 ОПЛАТЫ ПОСТАВЩИКАМ", "02 СВЕРКИ", "03 ДОКУМЕНТЫ ПОСТАВЩИКОВ"];
  for (const name of supplierSections) await ensureFolder(env, suppliersRoot, name);
  for (const p of PROJECTS) {
    const pf = await ensureFolder(env, suppliersRoot, p.name);
    for (const name of ["01 ПОСТАВЩИКИ", "02 ОПЛАТЫ", "03 СВЕРКИ"]) await ensureFolder(env, pf, name);
  }

  const bankRoot = await ensureFolder(env, root, "05 БАНК — выписки и платежи");
  const payments = await ensureFolder(env, bankRoot, "00 РЕЕСТР ОПЛАТ ПО ПРОЕКТАМ");
  for (const p of PROJECTS) await ensureFolder(env, payments, p.name);
  return made;
}

async function listDealFields(env) {
  const r = await bx(env, "crm.deal.userfield.list", { order: { SORT: "ASC" } });
  return Array.isArray(r) ? r : [];
}
async function ensureDealEnum(env, def, existing) {
  const fullName = `UF_CRM_${def.code}`;
  if (existing.some(x => String(x?.FIELD_NAME || "") === fullName)) return;
  await bx(env, "crm.deal.userfield.add", { fields: {
    FIELD_NAME: def.code, USER_TYPE_ID: "enumeration", XML_ID: `IF_${def.code}`, SORT: def.sort,
    MULTIPLE: "N", MANDATORY: "N", SHOW_FILTER: "Y", SHOW_IN_LIST: "Y", EDIT_IN_LIST: "Y",
    EDIT_FORM_LABEL: def.label, LIST_COLUMN_LABEL: def.label, LIST_FILTER_LABEL: def.label,
    LIST: def.values.map((v, i) => ({ VALUE: v, XML_ID: `IF_${def.code}_${i+1}`, SORT: (i+1)*100, DEF: "N" })),
    SETTINGS: { DISPLAY: "UI", LIST_HEIGHT: 1 },
  }});
}
async function ensureDealField(env, def, existing) {
  const [code, type, label, sort] = def;
  if (existing.some(x => String(x?.FIELD_NAME || "") === `UF_CRM_${code}`)) return;
  await bx(env, "crm.deal.userfield.add", { fields: {
    FIELD_NAME: code, USER_TYPE_ID: type, XML_ID: `IF_${code}`, SORT: sort,
    MULTIPLE: "N", MANDATORY: "N", SHOW_FILTER: "Y", SHOW_IN_LIST: "Y", EDIT_IN_LIST: "Y",
    EDIT_FORM_LABEL: label, LIST_COLUMN_LABEL: label, LIST_FILTER_LABEL: label,
  }});
}

async function listCompanyFields(env) {
  const r = await bx(env, "crm.company.userfield.list", { order: { SORT: "ASC" } });
  return Array.isArray(r) ? r : [];
}
async function ensureCompanyEnum(env, def, existing) {
  const fullName = `UF_CRM_${def.code}`;
  if (existing.some(x => String(x?.FIELD_NAME || "") === fullName)) return;
  await bx(env, "crm.company.userfield.add", { fields: {
    FIELD_NAME: def.code, USER_TYPE_ID: "enumeration", XML_ID: `IF_${def.code}`, SORT: def.sort,
    MULTIPLE: def.multiple ? "Y" : "N", MANDATORY: "N", SHOW_FILTER: "Y", SHOW_IN_LIST: "Y", EDIT_IN_LIST: "Y",
    EDIT_FORM_LABEL: def.label, LIST_COLUMN_LABEL: def.label, LIST_FILTER_LABEL: def.label,
    LIST: def.values.map((v, i) => ({ VALUE: v, XML_ID: `IF_${def.code}_${i+1}`, SORT: (i+1)*100, DEF: "N" })),
    SETTINGS: { DISPLAY: "UI", LIST_HEIGHT: Math.min(5, def.values.length) },
  }});
}
async function ensureCompanyField(env, def, existing) {
  const [code, type, label, sort] = def;
  if (existing.some(x => String(x?.FIELD_NAME || "") === `UF_CRM_${code}`)) return;
  await bx(env, "crm.company.userfield.add", { fields: {
    FIELD_NAME: code, USER_TYPE_ID: type, XML_ID: `IF_${code}`, SORT: sort,
    MULTIPLE: "N", MANDATORY: "N", SHOW_FILTER: "Y", SHOW_IN_LIST: "Y", EDIT_IN_LIST: "Y",
    EDIT_FORM_LABEL: label, LIST_COLUMN_LABEL: label, LIST_FILTER_LABEL: label,
  }});
}

async function ensureCrmFields(env) {
  let deal = await listDealFields(env);
  for (const def of DEAL_ENUMS) { await ensureDealEnum(env, def, deal); deal = await listDealFields(env); }
  for (const def of DEAL_FIELDS) { await ensureDealField(env, def, deal); deal = await listDealFields(env); }
  let company = await listCompanyFields(env);
  for (const def of COMPANY_ENUMS) { await ensureCompanyEnum(env, def, company); company = await listCompanyFields(env); }
  for (const def of COMPANY_FIELDS) { await ensureCompanyField(env, def, company); company = await listCompanyFields(env); }
}

async function dealCategories(env) {
  try {
    const r = await bx(env, "crm.dealcategory.list", { order: { SORT: "ASC" } });
    return Array.isArray(r) ? r : [];
  } catch {
    const r = await bx(env, "crm.category.list", { entityTypeId: 2 });
    return Array.isArray(r) ? r : (Array.isArray(r?.categories) ? r.categories : []);
  }
}
async function ensureDealCategory(env, name, sort) {
  let list = await dealCategories(env);
  let found = list.find(x => String(x?.NAME || x?.name || "").trim() === name);
  if (found) return Number(found.ID || found.id);
  try {
    const id = await bx(env, "crm.dealcategory.add", { fields: { NAME: name, SORT: sort } });
    if (Number(id) >= 0) return Number(id);
  } catch {}
  const r = await bx(env, "crm.category.add", { entityTypeId: 2, fields: { name, sort } });
  return Number(r?.category?.id || r?.id);
}

async function enumId(env, fieldName, value) {
  const rows = await bx(env, "crm.deal.userfield.list", { filter: { FIELD_NAME: fieldName } });
  const field = Array.isArray(rows) ? rows[0] : null;
  const found = (Array.isArray(field?.LIST) ? field.LIST : []).find(x => String(x?.VALUE || "") === value);
  return found?.ID ? String(found.ID) : null;
}

async function ensureProjectCards(env, categoryId) {
  for (const p of PROJECTS) {
    const title = `${p.name} — ${p.legal}`;
    const existing = await bx(env, "crm.deal.list", { filter: { "=TITLE": title, "=CATEGORY_ID": categoryId }, select: ["ID", "TITLE", "CATEGORY_ID"], start: 0 });
    if (Array.isArray(existing) && existing.length) continue;
    const fields = { TITLE: title, CATEGORY_ID: categoryId, COMMENTS: "Карточка проекта для учёта поставщиков, оплат, закупа, выдач и закрывающих документов." };
    const projectEnum = await enumId(env, "UF_CRM_PROJECT_ACCOUNTING", p.name);
    if (projectEnum) fields.UF_CRM_PROJECT_ACCOUNTING = projectEnum;
    await bx(env, "crm.deal.add", { fields, params: { REGISTER_SONET_EVENT: "N" } });
  }
}

async function ensureProjectAccounting(env) {
  const folders = await ensureProjectFolders(env);
  await ensureCrmFields(env);
  const projectCategoryId = await ensureDealCategory(env, "ПРОЕКТЫ — УЧЕТ", 70);
  const paymentCategoryId = await ensureDealCategory(env, "ОПЛАТЫ ПОСТАВЩИКАМ", 80);
  await ensureProjectCards(env, projectCategoryId);
  return { ok: true, version: VERSION, folders: folders.length, projectCategoryId, paymentCategoryId, projects: PROJECTS.length };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/bitrix/health") {
      let configured = false;
      try { configured = Boolean((await ensureProjectAccounting(env))?.ok); } catch { configured = false; }
      try {
        const response = await currentWorker.fetch(request, env, ctx);
        const payload = await response.clone().json().catch(() => null);
        return Response.json({ ok: Boolean(response.ok && payload?.ok), version: VERSION, projectAccountingConfigured: configured }, { status: response.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
      } catch {
        return Response.json({ ok: false, version: VERSION, projectAccountingConfigured: configured }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
    }
    return currentWorker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    try { await ensureProjectAccounting(env); } catch {}
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, env, ctx);
  },
};
