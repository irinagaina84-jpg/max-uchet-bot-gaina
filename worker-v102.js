import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v100.js";

const VERSION = "worker-v102-bitrix-crm-boards";
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
    if (i) await sleep(350 * i);
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

const CLIENTS = [
  { title: "АО КОНСТЭВО", note: "Клиент проекта КОНСТЭВО." },
  { title: "ВЗЛЁТ", note: "Клиент проекта ВЗЛЁТ." },
  { title: "ООО АТЛАС", note: "Клиент проекта ДИП." },
];

const ORDERS = [
  { title: "КОНСТЭВО — текущие поставки контейнеров", client: "АО КОНСТЭВО", stage: "Выдача / исполнение", amount: 0, note: "Текущие поставки ведутся по счетам, спецификациям, реестрам оплат и выдач." },
  { title: "ВЗЛЁТ — заказ 200 × 20 фут", client: "ВЗЛЁТ", stage: "Выдача / исполнение", amount: 27000000, note: "200 × 20 фут; рабочая цена продажи 135 000 ₽ за единицу. Детализация выдач и остатков — в реестре проекта." },
  { title: "ДИП — ООО АТЛАС — 75 × 20 фут", client: "ООО АТЛАС", stage: "Закуп и поставщики", amount: 9750000, note: "75 × 20 фут БУ; продажа 130 000 ₽ за единицу с НДС по рабочей сводной." },
];

function labelText(v) {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object") {
    for (const k of ["ru","RU","en","EN"]) if (typeof v[k] === "string") return v[k].trim();
    for (const x of Object.values(v)) if (typeof x === "string" && x.trim()) return x.trim();
  }
  return "";
}

async function getRoleField(env) {
  const rows = await bx(env, "crm.company.userfield.list", { order: { SORT: "ASC" } });
  const list = Array.isArray(rows) ? rows : [];
  const field = list.find(f => {
    const label = labelText(f?.EDIT_FORM_LABEL) || labelText(f?.LIST_COLUMN_LABEL) || labelText(f?.LIST_FILTER_LABEL);
    return label === "Роль контрагента";
  });
  if (!field) return null;
  const role = (Array.isArray(field.LIST) ? field.LIST : []).find(x => String(x?.VALUE || "").trim() === "Клиент");
  return role?.ID ? { name: String(field.FIELD_NAME), clientId: String(role.ID) } : null;
}

function norm(s) {
  return String(s || "").trim().toUpperCase().replace(/[«»\"]/g, "").replace(/\s+/g, " ");
}

async function ensureClients(env) {
  const role = await getRoleField(env);
  const existing = await bx(env, "crm.company.list", { order: { ID: "ASC" }, filter: {}, select: ["ID","TITLE"], start: 0 });
  const rows = Array.isArray(existing) ? existing : [];
  const out = [];
  for (const c of CLIENTS) {
    let found = rows.find(x => norm(x?.TITLE) === norm(c.title));
    const fields = { TITLE: c.title, COMMENTS: c.note };
    if (role) fields[role.name] = role.clientId;
    if (found?.ID) {
      await bx(env, "crm.company.update", { id: found.ID, fields });
      out.push({ title: c.title, id: found.ID, created: false });
    } else {
      const id = await bx(env, "crm.company.add", { fields, params: { REGISTER_SONET_EVENT: "N" } });
      rows.push({ ID: id, TITLE: c.title });
      out.push({ title: c.title, id, created: true });
    }
  }
  return out;
}

async function categories(env) {
  try {
    const r = await bx(env, "crm.dealcategory.list", { order: { SORT: "ASC" } });
    return Array.isArray(r) ? r : [];
  } catch {
    const r = await bx(env, "crm.category.list", { entityTypeId: 2 });
    return Array.isArray(r) ? r : (Array.isArray(r?.categories) ? r.categories : []);
  }
}

async function ensureCategory(env, name, sort) {
  let list = await categories(env);
  let found = list.find(x => String(x?.NAME || x?.name || "").trim() === name);
  if (found) return Number(found.ID || found.id);
  try {
    const id = await bx(env, "crm.dealcategory.add", { fields: { NAME: name, SORT: sort } });
    if (Number.isFinite(Number(id))) return Number(id);
  } catch {}
  const r = await bx(env, "crm.category.add", { entityTypeId: 2, fields: { name, sort } });
  return Number(r?.category?.id || r?.id);
}

async function stageRows(env, categoryId) {
  const entityId = `DEAL_STAGE_${categoryId}`;
  const r = await bx(env, "crm.status.list", { order: { SORT: "ASC" }, filter: { ENTITY_ID: entityId } });
  return Array.isArray(r) ? r : [];
}

async function ensureStages(env, categoryId, defs) {
  const entityId = `DEAL_STAGE_${categoryId}`;
  let rows = await stageRows(env, categoryId);
  for (const d of defs) {
    if (rows.some(x => String(x?.NAME || "").trim() === d.name)) continue;
    try {
      await bx(env, "crm.status.add", { fields: { ENTITY_ID: entityId, STATUS_ID: d.code, NAME: d.name, SORT: d.sort } });
    } catch {}
    rows = await stageRows(env, categoryId);
  }
  return rows;
}

function stageId(categoryId, rows, name) {
  const found = rows.find(x => String(x?.NAME || "").trim() === name);
  if (!found) return `C${categoryId}:NEW`;
  const raw = String(found.STATUS_ID || "").trim();
  return raw.startsWith(`C${categoryId}:`) ? raw : `C${categoryId}:${raw}`;
}

async function ensureOrders(env, categoryId, stages, clients) {
  const existing = await bx(env, "crm.deal.list", { order: { ID: "ASC" }, filter: { CATEGORY_ID: categoryId }, select: ["ID","TITLE"], start: 0 });
  const rows = Array.isArray(existing) ? existing : [];
  const companyMap = new Map(clients.map(x => [x.title, x.id]));
  const out = [];
  for (const o of ORDERS) {
    let found = rows.find(x => String(x?.TITLE || "").trim() === o.title);
    const fields = {
      TITLE: o.title,
      CATEGORY_ID: categoryId,
      STAGE_ID: stageId(categoryId, stages, o.stage),
      COMPANY_ID: companyMap.get(o.client) || 0,
      OPPORTUNITY: Number(o.amount || 0),
      CURRENCY_ID: "RUB",
      COMMENTS: o.note,
    };
    if (found?.ID) {
      await bx(env, "crm.deal.update", { id: found.ID, fields });
      out.push({ title: o.title, id: found.ID, created: false });
    } else {
      const id = await bx(env, "crm.deal.add", { fields, params: { REGISTER_SONET_EVENT: "N" } });
      rows.push({ ID: id, TITLE: o.title });
      out.push({ title: o.title, id, created: true });
    }
  }
  return out;
}

async function movePayments(env, categoryId, stages) {
  const all = await bx(env, "crm.deal.list", { order: { ID: "ASC" }, filter: {}, select: ["ID","TITLE","CATEGORY_ID","COMMENTS"], start: 0 });
  const rows = Array.isArray(all) ? all : [];
  const moved = [];
  for (const row of rows) {
    const title = String(row?.TITLE || "").trim();
    if (!title.startsWith("ОПЛАТА /")) continue;
    let stageName = "Частично / сверка";
    if (/НА ПРОВЕРКЕ|АТЛАС|ДИП/i.test(title + " " + String(row?.COMMENTS || ""))) stageName = "На проверке";
    else if (/№39|№42|№43|СПЕЦ №8|900 000/i.test(title + " " + String(row?.COMMENTS || ""))) stageName = "Оплачено";
    await bx(env, "crm.deal.update", { id: row.ID, fields: { CATEGORY_ID: categoryId, STAGE_ID: stageId(categoryId, stages, stageName) } });
    moved.push({ id: row.ID, title });
  }
  return moved;
}

async function setup(env) {
  const clients = await ensureClients(env);
  const ordersCategoryId = await ensureCategory(env, "КЛИЕНТЫ И ЗАКАЗЫ", 100);
  const paymentsCategoryId = await ensureCategory(env, "ОПЛАТЫ ПОСТАВЩИКАМ", 200);
  if (!ordersCategoryId || !paymentsCategoryId) throw new Error("CRM categories unavailable");

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

  const orders = await ensureOrders(env, ordersCategoryId, orderStages, clients);
  const payments = await movePayments(env, paymentsCategoryId, paymentStages);
  return {
    ok: true,
    version: VERSION,
    clientsReady: clients.length === 3,
    clientCount: clients.length,
    ordersBoardReady: orders.length === 3,
    orderCount: orders.length,
    ordersCategoryId,
    paymentsBoardReady: payments.length > 0,
    paymentsMoved: payments.length,
    paymentsCategoryId,
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
