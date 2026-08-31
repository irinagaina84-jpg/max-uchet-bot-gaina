import stableWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v96.js";

const VERSION = "worker-v100-bitrix-suppliers-payments";
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
  { value: "КОНСТЭВО", legal: "ИНТЕРФОРТУМ", root: "01 ИНТЕРФОРТУМ — проекты и первичка", folder: "01 КОНСТЭВО" },
  { value: "ВЗЛЁТ", legal: "АМИДИ ГРУПП", root: "02 АМИДИ ГРУПП — проекты и первичка", folder: "01 ВЗЛЁТ" },
  { value: "ДИП", legal: "ООО АТЛАС", root: "03 ООО АТЛАС — проекты и первичка", folder: "01 ДИП" },
];

const PROJECT_SUBS = [
  "00 СВОДНАЯ", "01 ДОГОВОРЫ И СЧЕТА", "02 ПОСТАВЩИКИ", "03 РЕЕСТР ОПЛАТ", "04 ЗАКУП",
  "05 ВЫДАЧИ И РЕЕСТРЫ КТК", "06 УПД, АКТЫ, ЗАКРЫВАЮЩИЕ", "07 ЗАЯВКИ", "99 АРХИВ",
];

const SUPPLIERS = [
  {
    title: "Май Вэй / Виктория",
    projects: ["КОНСТЭВО"],
    note: "КОНСТЭВО. Источник: рабочая сводная. 110 × 20 фут по 90 000 ₽; в источнике указано, что 110 из 110 оплачены. Не объединять автоматически с «Мин Вэй» без сверки.",
  },
  {
    title: "Мин Вэй",
    projects: ["КОНСТЭВО"],
    note: "КОНСТЭВО. Текущая детальная сверка №42/№43 и старый долг вне счетов. Название сохранено как в источнике; не объединять автоматически с «Май Вэй / Виктория».",
  },
  {
    title: "Александра",
    projects: ["ВЗЛЁТ"],
    note: "ВЗЛЁТ. Ресурс 120 × 20 DC; выдано 99; остаток 21. Из остатка 2 уже в Чехове, ещё 19 нужно найти/получить.",
  },
  {
    title: "Май Вэй",
    projects: ["ВЗЛЁТ"],
    note: "ВЗЛЁТ. Собственный закуп 36 + 20 из ресурса КОНСТЭВО = 56; выдано 56; остаток 0. Сохранено отдельной карточкой до сверки названий поставщиков.",
  },
  {
    title: "Голдконтейнер / Фахрат",
    projects: ["ВЗЛЁТ", "ДИП"],
    note: "ВЗЛЁТ: 10 × 20 DC по 90 000 ₽, оплачено 900 000 ₽, выдано 6, остаток 4. ДИП / ООО АТЛАС: закуп 75 × 20 фут по 90 000 ₽ = 6 750 000 ₽; факт оплаты по сводке не подтвержден.",
  },
  {
    title: "Наталья",
    projects: ["ВЗЛЁТ"],
    note: "ВЗЛЁТ. 6 × 20 DC по 85 000 ₽ наличными; куплены для перекрытия долга КОНСТЭВО, в свободный остаток не считать.",
  },
];

const PAYMENTS = [
  {
    title: "КОНСТЭВО — Май Вэй — наличный платеж 21.08.2026 — 2 978 000 ₽",
    project: "КОНСТЭВО", date: "2026-08-21", amount: 2978000, supplier: "Май Вэй / Виктория", status: "Оплачено",
    invoice: "26 × 20 фут + 11 × 40 фут",
    purpose: "2 340 000 ₽ за 26 × 20 фут + 638 000 ₽ за 11 × 40 фут.",
    note: "Подтвержденная агрегированная запись из рабочей сводной.",
  },
  {
    title: "ВЗЛЁТ — Голдконтейнер / Фахрат — 21.08.2026 — 900 000 ₽",
    project: "ВЗЛЁТ", date: "2026-08-21", amount: 900000, supplier: "Голдконтейнер / Фахрат", status: "Оплачено",
    invoice: "10 × 20 DC", purpose: "10 × 20 DC по 90 000 ₽.", note: "Отдельный закуп ВЗЛЁТ.",
  },
  { title: "КОНСТЭВО — счет №37 — оплачено 6 780 000 ₽", project: "КОНСТЭВО", amount: 6780000, status: "Частично оплачено", invoice: "№37", purpose: "60 × 20 DC по 113 000 ₽", note: "Агрегировано по сверке; дата отдельных платежей не установлена." },
  { title: "КОНСТЭВО — счет №39 — оплачено 747 000 ₽", project: "КОНСТЭВО", amount: 747000, status: "Оплачено", invoice: "№39", purpose: "9 × 40 HC по 83 000 ₽", note: "Счет закрыт; дата отдельных платежей не установлена." },
  { title: "КОНСТЭВО — счет №40 — оплачено 3 403 000 ₽", project: "КОНСТЭВО", amount: 3403000, status: "Частично оплачено", invoice: "№40", purpose: "41 × 40 HC по 83 000 ₽", note: "По сверке выдано 51, из них 10 сверх оплаты; дата отдельных платежей не установлена." },
  { title: "КОНСТЭВО — счет №42 — оплачено 5 900 000 ₽", project: "КОНСТЭВО", amount: 5900000, supplier: "Мин Вэй", status: "Оплачено", invoice: "№42", purpose: "50 × 20 DC по 118 000 ₽", note: "Агрегировано по текущей сверке; выдано 8, остаток к выдаче 42." },
  { title: "КОНСТЭВО — счет №43 — оплачено 4 150 000 ₽", project: "КОНСТЭВО", amount: 4150000, supplier: "Мин Вэй", status: "Оплачено", invoice: "№43", purpose: "50 × 40 HC по 83 000 ₽", note: "Агрегировано по текущей сверке; выдано 43, остаток к выдаче 7." },
  { title: "КОНСТЭВО — спецификация №8 — оплачено 775 000 ₽", project: "КОНСТЭВО", amount: 775000, status: "Оплачено", invoice: "Спецификация №8", purpose: "5 × 40 HC по 155 000 ₽", note: "Владивосток; выдачи на дату сверки не подтверждены." },
  { title: "ДИП — ООО АТЛАС — Фахрат — закуп 6 750 000 ₽ — на проверке", project: "ДИП", amount: 6750000, supplier: "Голдконтейнер / Фахрат", status: "На проверке", invoice: "75 × 20 фут", purpose: "План закупа 75 × 20 фут по 90 000 ₽", note: "В исходной сводке стоит «закуп план / наличные», подтвержденная сумма оплаты не указана; не считать оплаченным до подтверждения." },
];

function textLabel(v) {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object") {
    for (const key of ["ru", "RU", "en", "EN"]) if (typeof v[key] === "string") return v[key].trim();
    for (const x of Object.values(v)) if (typeof x === "string" && x.trim()) return x.trim();
  }
  return "";
}
function fieldLabel(f) {
  return textLabel(f?.EDIT_FORM_LABEL) || textLabel(f?.LIST_COLUMN_LABEL) || textLabel(f?.LIST_FILTER_LABEL);
}
function fieldName(f) { return String(f?.FIELD_NAME || "").trim(); }

async function listFields(env, entity) {
  const method = entity === "deal" ? "crm.deal.userfield.list" : "crm.company.userfield.list";
  const r = await bx(env, method, { order: { SORT: "ASC" } });
  return Array.isArray(r) ? r : [];
}
function findField(fields, code, label) {
  const exact = fields.find(f => fieldName(f) === `UF_CRM_${code}`);
  if (exact) return exact;
  return fields.find(f => fieldLabel(f) === label) || null;
}
async function addEnum(env, entity, code, label, values, multiple, sort) {
  const method = entity === "deal" ? "crm.deal.userfield.add" : "crm.company.userfield.add";
  await bx(env, method, { fields: {
    FIELD_NAME: code, USER_TYPE_ID: "enumeration", XML_ID: `IF_${code}`, SORT: sort,
    MULTIPLE: multiple ? "Y" : "N", MANDATORY: "N", SHOW_FILTER: "Y", SHOW_IN_LIST: "Y", EDIT_IN_LIST: "Y",
    EDIT_FORM_LABEL: label, LIST_COLUMN_LABEL: label, LIST_FILTER_LABEL: label,
    LIST: values.map((v, i) => ({ VALUE: v, XML_ID: `IF_${code}_${i+1}`, SORT: (i+1)*100, DEF: "N" })),
    SETTINGS: { DISPLAY: "UI", LIST_HEIGHT: Math.min(5, values.length) },
  }});
}
async function addScalar(env, entity, code, type, label, sort) {
  const method = entity === "deal" ? "crm.deal.userfield.add" : "crm.company.userfield.add";
  await bx(env, method, { fields: {
    FIELD_NAME: code, USER_TYPE_ID: type, XML_ID: `IF_${code}`, SORT: sort,
    MULTIPLE: "N", MANDATORY: "N", SHOW_FILTER: "Y", SHOW_IN_LIST: "Y", EDIT_IN_LIST: "Y",
    EDIT_FORM_LABEL: label, LIST_COLUMN_LABEL: label, LIST_FILTER_LABEL: label,
  }});
}
async function ensureFields(env) {
  let deal = await listFields(env, "deal");
  const dealDefs = [
    ["PROJ", "enumeration", "Проект", PROJECTS.map(p => p.value), false, 90],
    ["PAYSTAT", "enumeration", "Оплата — статус", ["К оплате", "Частично оплачено", "Оплачено", "На проверке", "Возврат / корректировка"], false, 100],
    ["PAYDATE", "date", "Оплата — дата", null, false, 510],
    ["PAYSUM", "double", "Оплата — сумма, руб.", null, false, 520],
    ["PAYSUP", "string", "Оплата — поставщик", null, false, 530],
    ["PAYINV", "string", "Оплата — счёт / основание", null, false, 540],
    ["PAYPURP", "string", "Оплата — назначение", null, false, 560],
    ["REGNOTE", "string", "Реестр — примечание", null, false, 620],
  ];
  for (const [code, type, label, values, multiple, sort] of dealDefs) {
    if (findField(deal, code, label)) continue;
    if (type === "enumeration") await addEnum(env, "deal", code, label, values, multiple, sort);
    else await addScalar(env, "deal", code, type, label, sort);
    deal = await listFields(env, "deal");
  }

  let company = await listFields(env, "company");
  const companyDefs = [
    ["CPROLE", "enumeration", "Роль контрагента", ["Поставщик", "Перевозчик", "Клиент", "Прочее"], false, 100],
    ["SUPPROJ", "enumeration", "Поставщик — проекты", PROJECTS.map(p => p.value), true, 110],
    ["SUPNOTE", "string", "Поставщик — примечание", null, false, 150],
  ];
  for (const [code, type, label, values, multiple, sort] of companyDefs) {
    if (findField(company, code, label)) continue;
    if (type === "enumeration") await addEnum(env, "company", code, label, values, multiple, sort);
    else await addScalar(env, "company", code, type, label, sort);
    company = await listFields(env, "company");
  }
  return { deal, company };
}

function enumId(field, value) {
  const list = Array.isArray(field?.LIST) ? field.LIST : [];
  const x = list.find(i => String(i?.VALUE || "").trim() === value);
  return x?.ID ? String(x.ID) : null;
}

async function children(env, folderId) {
  const r = await bx(env, "disk.folder.getchildren", { id: folderId });
  return Array.isArray(r) ? r : [];
}
async function findFolder(env, parentId, name) {
  const rows = await children(env, parentId);
  const f = rows.find(x => String(x?.TYPE || x?.type || "").toLowerCase() === "folder" && String(x?.NAME || x?.name || "").trim() === name);
  return f ? String(f.ID || f.id) : null;
}
async function ensureFolder(env, parentId, name) {
  const id = await findFolder(env, parentId, name);
  if (id) return id;
  const r = await bx(env, "disk.folder.addsubfolder", { id: parentId, data: { NAME: name } });
  const added = String(r?.ID || r?.id || "");
  if (!added) throw new Error(`Folder id missing for ${name}`);
  return added;
}
async function accountingRoot(env) {
  const storages = await bx(env, "disk.storage.getlist", {});
  const list = Array.isArray(storages) ? storages : [];
  const storage = list.find(s => String(s?.ENTITY_TYPE || "").toLowerCase() === "common") || list.find(s => /общ|common|company|компан/i.test(String(s?.NAME || "")));
  if (!storage) throw new Error("Common storage not found");
  let rootId = String(storage?.ROOT_OBJECT_ID || "");
  if (!rootId) rootId = String((await bx(env, "disk.storage.get", { id: storage.ID }))?.ROOT_OBJECT_ID || "");
  const main = await findFolder(env, rootId, "00 УЧЕТ — ИНТЕРФОРТУМ + АМИДИ — КОНТЕЙНЕРЫ");
  if (!main) throw new Error("Accounting root not found");
  return main;
}
async function ensureStructure(env) {
  const root = await accountingRoot(env);
  for (const p of PROJECTS) {
    const company = await ensureFolder(env, root, p.root);
    const project = await ensureFolder(env, company, p.folder);
    for (const sub of PROJECT_SUBS) await ensureFolder(env, project, sub);
  }
  const suppliers = await ensureFolder(env, root, "03 ПОСТАВЩИКИ — закупки, оплаты, сверки");
  for (const sub of ["00 РЕЕСТР ПОСТАВЩИКОВ", "01 ОПЛАТЫ ПОСТАВЩИКАМ", "02 СВЕРКИ", "03 ДОКУМЕНТЫ ПОСТАВЩИКОВ"]) await ensureFolder(env, suppliers, sub);
  for (const p of PROJECTS) {
    const pf = await ensureFolder(env, suppliers, p.value);
    for (const sub of ["01 ПОСТАВЩИКИ", "02 ОПЛАТЫ", "03 СВЕРКИ"]) await ensureFolder(env, pf, sub);
  }
  const bank = await ensureFolder(env, root, "05 БАНК — выписки и платежи");
  const payRoot = await ensureFolder(env, bank, "00 РЕЕСТР ОПЛАТ ПО ПРОЕКТАМ");
  for (const p of PROJECTS) await ensureFolder(env, payRoot, p.value);

  // Remove the earlier wrong empty DIP folder under Interfortum only when it contains no files.
  try {
    const oldCompany = await findFolder(env, root, "01 ИНТЕРФОРТУМ — проекты и первичка");
    const wrongDip = oldCompany ? await findFolder(env, oldCompany, "02 ДИП") : null;
    if (wrongDip) {
      const stack = [wrongDip]; let hasFiles = false;
      while (stack.length && !hasFiles) {
        const id = stack.pop();
        for (const item of await children(env, id)) {
          const t = String(item?.TYPE || item?.type || "").toLowerCase();
          if (t === "file") { hasFiles = true; break; }
          if (t === "folder") stack.push(String(item.ID || item.id));
        }
      }
      if (!hasFiles) await bx(env, "disk.folder.delete", { id: wrongDip }).catch(() => null);
    }
  } catch {}
  return true;
}

async function ensureSupplierCompanies(env, companyFields) {
  const roleField = findField(companyFields, "CPROLE", "Роль контрагента");
  const projectsField = findField(companyFields, "SUPPROJ", "Поставщик — проекты");
  const noteField = findField(companyFields, "SUPNOTE", "Поставщик — примечание");
  const roleId = roleField ? enumId(roleField, "Поставщик") : null;
  const all = await bx(env, "crm.company.list", { order: { ID: "ASC" }, filter: {}, select: ["ID", "TITLE"], start: 0 });
  const rows = Array.isArray(all) ? all : [];
  const result = [];
  for (const s of SUPPLIERS) {
    let row = rows.find(x => String(x?.TITLE || "").trim() === s.title);
    const fields = { TITLE: s.title, COMMENTS: s.note };
    if (roleField && roleId) fields[fieldName(roleField)] = roleId;
    if (projectsField) {
      const ids = s.projects.map(v => enumId(projectsField, v)).filter(Boolean);
      if (ids.length) fields[fieldName(projectsField)] = ids;
    }
    if (noteField) fields[fieldName(noteField)] = s.note;
    if (row?.ID) {
      await bx(env, "crm.company.update", { id: row.ID, fields });
      result.push({ title: s.title, id: row.ID, created: false });
    } else {
      const id = await bx(env, "crm.company.add", { fields, params: { REGISTER_SONET_EVENT: "N" } });
      row = { ID: id, TITLE: s.title }; rows.push(row);
      result.push({ title: s.title, id, created: true });
    }
  }
  return result;
}

async function ensurePaymentDeals(env, dealFields) {
  const projectField = findField(dealFields, "PROJ", "Проект");
  const statusField = findField(dealFields, "PAYSTAT", "Оплата — статус");
  const dateField = findField(dealFields, "PAYDATE", "Оплата — дата");
  const sumField = findField(dealFields, "PAYSUM", "Оплата — сумма, руб.");
  const supplierField = findField(dealFields, "PAYSUP", "Оплата — поставщик");
  const invoiceField = findField(dealFields, "PAYINV", "Оплата — счёт / основание");
  const purposeField = findField(dealFields, "PAYPURP", "Оплата — назначение");
  const noteField = findField(dealFields, "REGNOTE", "Реестр — примечание");

  const existing = await bx(env, "crm.deal.list", { order: { ID: "ASC" }, filter: {}, select: ["ID", "TITLE"], start: 0 });
  const rows = Array.isArray(existing) ? existing : [];
  const result = [];
  for (const p of PAYMENTS) {
    let row = rows.find(x => String(x?.TITLE || "").trim() === p.title);
    const fields = { TITLE: p.title, OPPORTUNITY: Number(p.amount || 0), CURRENCY_ID: "RUB", COMMENTS: p.note || "" };
    if (projectField) { const id = enumId(projectField, p.project); if (id) fields[fieldName(projectField)] = id; }
    if (statusField) { const id = enumId(statusField, p.status); if (id) fields[fieldName(statusField)] = id; }
    if (dateField && p.date) fields[fieldName(dateField)] = p.date;
    if (sumField) fields[fieldName(sumField)] = Number(p.amount || 0);
    if (supplierField && p.supplier) fields[fieldName(supplierField)] = p.supplier;
    if (invoiceField && p.invoice) fields[fieldName(invoiceField)] = p.invoice;
    if (purposeField && p.purpose) fields[fieldName(purposeField)] = p.purpose;
    if (noteField && p.note) fields[fieldName(noteField)] = p.note;
    if (row?.ID) {
      await bx(env, "crm.deal.update", { id: row.ID, fields });
      result.push({ title: p.title, id: row.ID, created: false });
    } else {
      const id = await bx(env, "crm.deal.add", { fields, params: { REGISTER_SONET_EVENT: "N" } });
      row = { ID: id, TITLE: p.title }; rows.push(row);
      result.push({ title: p.title, id, created: true });
    }
  }
  return result;
}

async function ensureRealProjects(env) {
  const result = [];
  for (const p of PROJECTS) {
    const name = `${p.value} — ${p.legal}`;
    try {
      const list = await bx(env, "sonet_group.get", { FILTER: { NAME: name, PROJECT: "Y", ACTIVE: "Y" }, ORDER: { ID: "DESC" } });
      const found = Array.isArray(list) ? list.find(x => String(x?.NAME || "").trim() === name) : null;
      if (found) { result.push({ name, id: found.ID, created: false }); continue; }
      const id = await bx(env, "sonet_group.create", { NAME: name, DESCRIPTION: `Рабочий проект ${p.value}. Юрлицо: ${p.legal}.`, PROJECT: "Y", VISIBLE: "N", OPENED: "N", CLOSED: "N" });
      result.push({ name, id, created: true });
    } catch (e) {
      return { ready: false, error: String(e?.message || e).slice(0, 220), projects: result };
    }
  }
  return { ready: true, error: null, projects: result };
}

async function finalize(env) {
  await ensureStructure(env);
  const fieldSets = await ensureFields(env);
  const supplierCompanies = await ensureSupplierCompanies(env, fieldSets.company);
  const paymentDeals = await ensurePaymentDeals(env, fieldSets.deal);
  const realProjects = await ensureRealProjects(env);
  return {
    ok: true,
    version: VERSION,
    suppliersReady: supplierCompanies.length === SUPPLIERS.length,
    supplierCount: supplierCompanies.length,
    paymentsReady: paymentDeals.length === PAYMENTS.length,
    paymentCount: paymentDeals.length,
    projectsModuleReady: realProjects.ready,
    projectsModuleError: realProjects.error,
    projectsModuleCount: realProjects.projects.length,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/bitrix/health") {
      let setup;
      try { setup = await finalize(env); }
      catch (e) { setup = { ok: false, version: VERSION, error: String(e?.message || e).slice(0, 260) }; }
      return Response.json(setup, { status: setup.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
    }
    return stableWorker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    try { await finalize(env); } catch {}
    if (typeof stableWorker.scheduled === "function") return stableWorker.scheduled(controller, env, ctx);
  },
};
