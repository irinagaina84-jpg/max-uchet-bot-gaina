import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v100.js";

const VERSION = "worker-v101-bitrix-clients-orders-dashboard";
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

const PROJECTS = ["КОНСТЭВО", "ВЗЛЁТ", "ДИП"];
const CLIENTS = [
  { title: "АО КОНСТЭВО", projects: ["КОНСТЭВО"], status: "Активный", note: "Клиент проекта КОНСТЭВО. Контейнерные поставки ведутся по отдельным счетам и спецификациям." },
  { title: "ВЗЛЁТ", projects: ["ВЗЛЁТ"], status: "Активный", note: "Клиент проекта ВЗЛЁТ. Текущий заказ: партия 20-футовых контейнеров; учет выдач и остатков ведется по реестру проекта." },
  { title: "ООО АТЛАС", projects: ["ДИП"], status: "Активный", note: "Клиент проекта ДИП. В рабочей сводной: 75 × 20-футовых контейнеров." },
];
const ORDERS = [
  { title: "КОНСТЭВО — текущие поставки контейнеров", client: "АО КОНСТЭВО", project: "КОНСТЭВО", stage: "Закуп и поставщики", type: "20 / 40 фут", qty: 0, amount: 0, note: "Текущий проект. Детализация по счетам и спецификациям ведется в реестре оплат и выдач." },
  { title: "ВЗЛЁТ — заказ 200 × 20 фут", client: "ВЗЛЁТ", project: "ВЗЛЁТ", stage: "Выдача / исполнение", type: "20 DC", qty: 200, amount: 0, note: "Активный заказ. Сводка проекта содержит выдачи, поставщиков и остатки." },
  { title: "ДИП — ООО АТЛАС — 75 × 20 фут", client: "ООО АТЛАС", project: "ДИП", stage: "Закуп и поставщики", type: "20 фут БУ", qty: 75, amount: 9750000, note: "По рабочей сводной: продажа 75 × 20 фут по 130 000 ₽ с НДС; закуп поставщика учитывается отдельно." },
];

function textLabel(v) {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object") {
    for (const k of ["ru","RU","en","EN"]) if (typeof v[k] === "string") return v[k].trim();
    for (const x of Object.values(v)) if (typeof x === "string" && x.trim()) return x.trim();
  }
  return "";
}
function fieldLabel(f) { return textLabel(f?.EDIT_FORM_LABEL) || textLabel(f?.LIST_COLUMN_LABEL) || textLabel(f?.LIST_FILTER_LABEL); }
function fieldName(f) { return String(f?.FIELD_NAME || "").trim(); }
function enumId(field, value) {
  const list = Array.isArray(field?.LIST) ? field.LIST : [];
  const row = list.find(x => String(x?.VALUE || "").trim() === value);
  return row?.ID ? String(row.ID) : null;
}
function enumValue(field, id) {
  const list = Array.isArray(field?.LIST) ? field.LIST : [];
  const row = list.find(x => String(x?.ID || "") === String(id || ""));
  return row ? String(row.VALUE || "").trim() : "";
}
async function listFields(env, entity) {
  const method = entity === "deal" ? "crm.deal.userfield.list" : "crm.company.userfield.list";
  const r = await bx(env, method, { order: { SORT: "ASC" } });
  return Array.isArray(r) ? r : [];
}
function findField(fields, code, label) {
  return fields.find(f => fieldName(f) === `UF_CRM_${code}`) || fields.find(f => fieldLabel(f) === label) || null;
}
async function addEnum(env, entity, code, label, values, multiple, sort) {
  const method = entity === "deal" ? "crm.deal.userfield.add" : "crm.company.userfield.add";
  return bx(env, method, { fields: {
    FIELD_NAME: code, USER_TYPE_ID: "enumeration", XML_ID: `IF_${code}`, SORT: sort,
    MULTIPLE: multiple ? "Y" : "N", MANDATORY: "N", SHOW_FILTER: "Y", SHOW_IN_LIST: "Y", EDIT_IN_LIST: "Y",
    EDIT_FORM_LABEL: label, LIST_COLUMN_LABEL: label, LIST_FILTER_LABEL: label,
    LIST: values.map((v,i) => ({ VALUE: v, XML_ID: `IF_${code}_${i+1}`, SORT: (i+1)*100, DEF: "N" })),
    SETTINGS: { DISPLAY: "UI", LIST_HEIGHT: Math.min(6, values.length) },
  }});
}
async function addScalar(env, entity, code, type, label, sort) {
  const method = entity === "deal" ? "crm.deal.userfield.add" : "crm.company.userfield.add";
  return bx(env, method, { fields: {
    FIELD_NAME: code, USER_TYPE_ID: type, XML_ID: `IF_${code}`, SORT: sort,
    MULTIPLE: "N", MANDATORY: "N", SHOW_FILTER: "Y", SHOW_IN_LIST: "Y", EDIT_IN_LIST: "Y",
    EDIT_FORM_LABEL: label, LIST_COLUMN_LABEL: label, LIST_FILTER_LABEL: label,
  }});
}
async function ensureDashboardFields(env) {
  let company = await listFields(env, "company");
  const companyDefs = [
    ["CLPROJ", "enumeration", "Клиент — проекты", PROJECTS, true, 170],
    ["CLSTAT", "enumeration", "Клиент — статус", ["Активный", "Потенциальный", "На паузе", "Архив"], false, 180],
  ];
  for (const [code,type,label,values,multiple,sort] of companyDefs) {
    if (findField(company, code, label)) continue;
    await addEnum(env, "company", code, label, values, multiple, sort);
    company = await listFields(env, "company");
  }
  let deal = await listFields(env, "deal");
  const dealDefs = [
    ["ORDTYPE", "string", "Заказ — тип контейнера", null, false, 700],
    ["ORDQTY", "double", "Заказ — количество, шт.", null, false, 710],
    ["ORDISS", "double", "Заказ — выдано, шт.", null, false, 720],
    ["ORDBAL", "double", "Заказ — остаток, шт.", null, false, 730],
    ["ORDNOTE", "string", "Заказ — примечание", null, false, 740],
  ];
  for (const [code,type,label,values,multiple,sort] of dealDefs) {
    if (findField(deal, code, label)) continue;
    await addScalar(env, "deal", code, type, label, sort);
    deal = await listFields(env, "deal");
  }
  return { company, deal };
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
async function ensureCategory(env, name, sort) {
  const list = await dealCategories(env);
  const found = list.find(x => String(x?.NAME || x?.name || "").trim() === name);
  if (found) return Number(found.ID || found.id);
  try {
    const id = await bx(env, "crm.dealcategory.add", { fields: { NAME: name, SORT: sort } });
    if (Number.isFinite(Number(id))) return Number(id);
  } catch {}
  const r = await bx(env, "crm.category.add", { entityTypeId: 2, fields: { name, sort } });
  return Number(r?.category?.id || r?.id);
}
async function statusRows(env, categoryId) {
  const entityId = `DEAL_STAGE_${categoryId}`;
  const r = await bx(env, "crm.status.list", { order: { SORT: "ASC" }, filter: { ENTITY_ID: entityId } });
  return Array.isArray(r) ? r : [];
}
async function ensureStages(env, categoryId, defs) {
  const entityId = `DEAL_STAGE_${categoryId}`;
  let rows = await statusRows(env, categoryId);
  for (const def of defs) {
    let row = rows.find(x => String(x?.NAME || "").trim() === def.name);
    if (!row) {
      await bx(env, "crm.status.add", { fields: { ENTITY_ID: entityId, STATUS_ID: def.code, NAME: def.name, SORT: def.sort } });
      rows = await statusRows(env, categoryId);
      row = rows.find(x => String(x?.NAME || "").trim() === def.name);
    }
  }
  return rows;
}
function stageId(categoryId, rows, name) {
  const row = rows.find(x => String(x?.NAME || "").trim() === name);
  if (!row) return `C${categoryId}:NEW`;
  const sid = String(row?.STATUS_ID || "").trim();
  return sid.startsWith(`C${categoryId}:`) ? sid : `C${categoryId}:${sid}`;
}

async function listCompanies(env) {
  const r = await bx(env, "crm.company.list", { order: { ID: "ASC" }, filter: {}, select: ["ID","TITLE"], start: 0 });
  return Array.isArray(r) ? r : [];
}
async function ensureClients(env, companyFields) {
  const roleField = findField(companyFields, "CPROLE", "Роль контрагента");
  const roleId = roleField ? enumId(roleField, "Клиент") : null;
  const projField = findField(companyFields, "CLPROJ", "Клиент — проекты");
  const statField = findField(companyFields, "CLSTAT", "Клиент — статус");
  const noteField = findField(companyFields, "SUPNOTE", "Поставщик — примечание");
  const rows = await listCompanies(env);
  const out = [];
  for (const c of CLIENTS) {
    let row = rows.find(x => String(x?.TITLE || "").trim().toUpperCase().replace(/[«»"]/g, "") === c.title.toUpperCase().replace(/[«»"]/g, ""));
    const fields = { TITLE: c.title, COMMENTS: c.note };
    if (roleField && roleId) fields[fieldName(roleField)] = roleId;
    if (projField) {
      const ids = c.projects.map(v => enumId(projField, v)).filter(Boolean);
      if (ids.length) fields[fieldName(projField)] = ids;
    }
    if (statField) { const id = enumId(statField, c.status); if (id) fields[fieldName(statField)] = id; }
    if (noteField && fieldLabel(noteField) !== "Поставщик — примечание") fields[fieldName(noteField)] = c.note;
    if (row?.ID) {
      await bx(env, "crm.company.update", { id: row.ID, fields });
      out.push({ title: c.title, id: row.ID, created: false });
    } else {
      const id = await bx(env, "crm.company.add", { fields, params: { REGISTER_SONET_EVENT: "N" } });
      rows.push({ ID: id, TITLE: c.title });
      out.push({ title: c.title, id, created: true });
    }
  }
  return out;
}

async function ensureOrders(env, categoryId, stages, dealFields, clients) {
  const projectField = findField(dealFields, "PROJ", "Проект");
  const typeField = findField(dealFields, "ORDTYPE", "Заказ — тип контейнера");
  const qtyField = findField(dealFields, "ORDQTY", "Заказ — количество, шт.");
  const noteField = findField(dealFields, "ORDNOTE", "Заказ — примечание");
  const existing = await bx(env, "crm.deal.list", { order: { ID: "ASC" }, filter: { CATEGORY_ID: categoryId }, select: ["ID","TITLE"], start: 0 });
  const rows = Array.isArray(existing) ? existing : [];
  const byClient = new Map(clients.map(x => [x.title, x.id]));
  const out = [];
  for (const o of ORDERS) {
    let row = rows.find(x => String(x?.TITLE || "").trim() === o.title);
    const fields = {
      TITLE: o.title,
      CATEGORY_ID: categoryId,
      STAGE_ID: stageId(categoryId, stages, o.stage),
      COMPANY_ID: byClient.get(o.client) || 0,
      OPPORTUNITY: Number(o.amount || 0),
      CURRENCY_ID: "RUB",
      COMMENTS: o.note,
    };
    if (projectField) { const id = enumId(projectField, o.project); if (id) fields[fieldName(projectField)] = id; }
    if (typeField) fields[fieldName(typeField)] = o.type;
    if (qtyField) fields[fieldName(qtyField)] = Number(o.qty || 0);
    if (noteField) fields[fieldName(noteField)] = o.note;
    if (row?.ID) {
      await bx(env, "crm.deal.update", { id: row.ID, fields });
      out.push({ title: o.title, id: row.ID, created: false });
    } else {
      const id = await bx(env, "crm.deal.add", { fields, params: { REGISTER_SONET_EVENT: "N" } });
      rows.push({ ID: id, TITLE: o.title });
      out.push({ title: o.title, id, created: true });
    }
  }
  return out;
}

async function movePaymentDeals(env, categoryId, stages, dealFields) {
  const payStatusField = findField(dealFields, "PAYSTAT", "Оплата — статус");
  const paySumField = findField(dealFields, "PAYSUM", "Оплата — сумма, руб.");
  if (!payStatusField && !paySumField) return [];
  const select = ["ID","TITLE","CATEGORY_ID","STAGE_ID"];
  if (payStatusField) select.push(fieldName(payStatusField));
  if (paySumField) select.push(fieldName(paySumField));
  const all = await bx(env, "crm.deal.list", { order: { ID: "ASC" }, filter: {}, select, start: 0 });
  const rows = Array.isArray(all) ? all : [];
  const moved = [];
  for (const row of rows) {
    const payStatusRaw = payStatusField ? row[fieldName(payStatusField)] : null;
    const paySumRaw = paySumField ? row[fieldName(paySumField)] : null;
    if (!payStatusRaw && !(Number(paySumRaw) > 0)) continue;
    const statusValue = payStatusField ? enumValue(payStatusField, payStatusRaw) : "";
    const stageName = statusValue === "Оплачено" ? "Оплачено" : statusValue === "На проверке" ? "На проверке" : statusValue === "К оплате" ? "К оплате" : "Частично / сверка";
    await bx(env, "crm.deal.update", { id: row.ID, fields: { CATEGORY_ID: categoryId, STAGE_ID: stageId(categoryId, stages, stageName) } });
    moved.push({ id: row.ID, title: row.TITLE });
  }
  return moved;
}

async function setup(env) {
  // First run the existing project/supplier/payment setup.
  const baseReq = new Request("https://internal.local/bitrix/health");
  const baseResp = await currentWorker.fetch(baseReq, env, { waitUntil() {} });
  if (!baseResp.ok) {
    const t = await baseResp.text().catch(() => "");
    throw new Error(`Base Bitrix setup failed: ${t.slice(0,180)}`);
  }

  const fields = await ensureDashboardFields(env);
  const ordersCategoryId = await ensureCategory(env, "КЛИЕНТЫ И ЗАКАЗЫ", 100);
  const paymentsCategoryId = await ensureCategory(env, "ОПЛАТЫ ПОСТАВЩИКАМ", 200);
  if (!ordersCategoryId || !paymentsCategoryId) throw new Error("Deal categories not created");

  const orderStages = await ensureStages(env, ordersCategoryId, [
    { code: "NEW", name: "Новый заказ", sort: 100 },
    { code: "DOCS", name: "Документы / согласование", sort: 200 },
    { code: "CLIENTPAY", name: "Оплата клиента", sort: 300 },
    { code: "PROCUREMENT", name: "Закуп и поставщики", sort: 400 },
    { code: "FULFILLMENT", name: "Выдача / исполнение", sort: 500 },
    { code: "WON", name: "Закрыт", sort: 600 },
    { code: "PROBLEM", name: "Проблема / пауза", sort: 700 },
  ]);
  const paymentStages = await ensureStages(env, paymentsCategoryId, [
    { code: "TOPAY", name: "К оплате", sort: 100 },
    { code: "PARTIAL", name: "Частично / сверка", sort: 200 },
    { code: "CHECK", name: "На проверке", sort: 300 },
    { code: "PAID", name: "Оплачено", sort: 400 },
  ]);

  const clients = await ensureClients(env, fields.company);
  const orders = await ensureOrders(env, ordersCategoryId, orderStages, fields.deal, clients);
  const movedPayments = await movePaymentDeals(env, paymentsCategoryId, paymentStages, fields.deal);

  const companies = await listCompanies(env);
  const supplierRole = findField(fields.company, "CPROLE", "Роль контрагента");
  const clientRoleId = supplierRole ? enumId(supplierRole, "Клиент") : null;
  const supplierRoleId = supplierRole ? enumId(supplierRole, "Поставщик") : null;

  return {
    ok: true,
    version: VERSION,
    clientsReady: clients.length === CLIENTS.length,
    clientCount: clients.length,
    ordersBoardReady: orders.length === ORDERS.length,
    orderCount: orders.length,
    ordersCategoryId,
    paymentsBoardReady: movedPayments.length > 0,
    paymentsMoved: movedPayments.length,
    paymentsCategoryId,
    companyBaseReady: Boolean(clientRoleId && supplierRoleId),
    companyCountObserved: companies.length,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/bitrix/health") {
      try {
        const result = await setup(env);
        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
      } catch (e) {
        return Response.json({ ok: false, version: VERSION, error: String(e?.message || e).slice(0,320) }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
    }
    return currentWorker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    try { await setup(env); } catch {}
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, env, ctx);
  },
};
