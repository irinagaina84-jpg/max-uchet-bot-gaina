import baseWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v117.js";

const VERSION = "worker-v119-minwei-fast";
const APPROVED = new Set([
  "ae6b3810ea1e8f447a2abb8d8eaee4f05787eaea870126b56c6d23785ddaa27d",
  "f489a76abb4afac86baba5c350903cdb2e75f6a100f5f1639c0794c91c345854",
]);

export class MaxBotContainer extends BaseMaxBotContainer {}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    ...extra,
  };
}
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
  for (let i = 0; i < 6; i++) {
    if (i) await sleep(250 * i);
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
async function parallelLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const part = await Promise.all(chunk.map(fn));
    out.push(...part);
  }
  return out;
}
async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function decode(s) {
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}
function labelText(v) {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object") for (const x of Object.values(v)) if (typeof x === "string" && x.trim()) return x.trim();
  return "";
}
function label(f) { return labelText(f?.EDIT_FORM_LABEL) || labelText(f?.LIST_COLUMN_LABEL) || labelText(f?.LIST_FILTER_LABEL); }
function fieldByCodeOrLabel(list, code, text) {
  const technical = `UF_CRM_${code}`.toUpperCase();
  return (Array.isArray(list) ? list : []).find(f => String(f?.FIELD_NAME || "").toUpperCase() === technical || label(f) === text) || null;
}
function enumId(f, value) {
  const x = (Array.isArray(f?.LIST) ? f.LIST : []).find(v => String(v?.VALUE || "").trim() === value);
  return x?.ID ? String(x.ID) : null;
}
function norm(s) { return String(s || "").trim().toUpperCase().replace(/[«»\"]/g, "").replace(/\s+/g, " "); }

async function approvedPayload(encoded, expectedKind) {
  if (typeof encoded !== "string" || !encoded || encoded.length > 10000) throw new Error("Invalid approved payload");
  const raw = decode(encoded);
  const hash = await sha256Hex(raw);
  if (!APPROVED.has(hash)) throw new Error("Payload not approved");
  const p = JSON.parse(raw);
  if (p?.v !== 1 || p?.kind !== expectedKind) throw new Error(`Invalid ${expectedKind} payload`);
  return p;
}

async function companyFields(env) {
  const r = await bx(env, "crm.company.userfield.list", { order: { SORT: "ASC" } });
  return Array.isArray(r) ? r : [];
}
async function ensureDoubleField(env, list, code, text, sort) {
  let f = fieldByCodeOrLabel(list, code, text);
  if (f) return { list, field: f };
  try {
    await bx(env, "crm.company.userfield.add", { fields: {
      FIELD_NAME: code, USER_TYPE_ID: "double", XML_ID: `IF_${code}`, SORT: sort,
      MULTIPLE: "N", MANDATORY: "N", SHOW_FILTER: "Y", SHOW_IN_LIST: "Y", EDIT_IN_LIST: "Y",
      EDIT_FORM_LABEL: text, LIST_COLUMN_LABEL: text, LIST_FILTER_LABEL: text,
    }});
  } catch (e) {
    if (!/already exists|уже существует/i.test(String(e?.message || e))) throw e;
  }
  list = await companyFields(env);
  return { list, field: fieldByCodeOrLabel(list, code, text) };
}
async function ensureRole(env, list) {
  let f = fieldByCodeOrLabel(list, "CPROLE", "Роль контрагента");
  if (f) return { list, field: f };
  try {
    await bx(env, "crm.company.userfield.add", { fields: {
      FIELD_NAME: "CPROLE", USER_TYPE_ID: "enumeration", XML_ID: "IF_CPROLE", SORT: 100,
      MULTIPLE: "N", MANDATORY: "N", SHOW_FILTER: "Y", SHOW_IN_LIST: "Y", EDIT_IN_LIST: "Y",
      EDIT_FORM_LABEL: "Роль контрагента", LIST_COLUMN_LABEL: "Роль контрагента", LIST_FILTER_LABEL: "Роль контрагента",
      LIST: ["Поставщик","Перевозчик","Клиент","Прочее"].map((v,i)=>({VALUE:v,XML_ID:`IF_CPROLE_${i+1}`,SORT:(i+1)*100,DEF:"N"})),
      SETTINGS: { DISPLAY: "UI", LIST_HEIGHT: 4 },
    }});
  } catch (e) {
    if (!/already exists|уже существует/i.test(String(e?.message || e))) throw e;
  }
  list = await companyFields(env);
  return { list, field: fieldByCodeOrLabel(list, "CPROLE", "Роль контрагента") };
}
async function ensureCompany(env, p) {
  let list = await companyFields(env);
  let r = await ensureRole(env, list); list = r.list; const role = r.field;
  r = await ensureDoubleField(env, list, "SUPPAIDTOT", "Поставщик — оплачено всего, руб.", 210); list = r.list; const paidF = r.field;
  r = await ensureDoubleField(env, list, "SUPPADVREM", "Поставщик — остаток аванса, руб.", 220); const remF = r.field;

  let companies = await bx(env, "crm.company.list", { order: { ID: "ASC" }, filter: { "=TITLE": p.supplier }, select: ["ID","TITLE"], start: 0 });
  companies = Array.isArray(companies) ? companies : [];
  let found = companies.find(x => norm(x?.TITLE) === norm(p.supplier));
  if (!found) {
    const all = await bx(env, "crm.company.list", { order: { ID: "ASC" }, filter: {}, select: ["ID","TITLE"], start: 0 });
    found = (Array.isArray(all) ? all : []).find(x => norm(x?.TITLE) === norm(p.supplier));
  }

  const comments = `Сверка Мин Вэй. Оплачено всего: ${p.paidTotal} руб. Фактически выдано: ${p.issuedQty} контейнеров на ${p.issuedCost} руб. Неиспользовано: ${p.unused} руб. Текущая бронь/ожидается: ${p.reservedQty} на ${p.reservedCost} руб. Свободно после брони: ${p.freeAfterReserve} руб. Старые «не выдали»: ${p.oldNotIssuedQty} на ${p.oldNotIssuedCost} руб. Ожидаемые позиции не считаются физически оприходованными до подтверждения приемки.`;
  const fields = { TITLE: p.supplier, COMMENTS: comments };
  const supplierRoleId = enumId(role, "Поставщик");
  if (role?.FIELD_NAME && supplierRoleId) fields[role.FIELD_NAME] = supplierRoleId;
  if (paidF?.FIELD_NAME) fields[paidF.FIELD_NAME] = p.paidTotal;
  if (remF?.FIELD_NAME) fields[remF.FIELD_NAME] = p.unused;

  let companyId;
  if (found?.ID) {
    companyId = String(found.ID);
    await bx(env, "crm.company.update", { id: companyId, fields });
  } else {
    companyId = String(await bx(env, "crm.company.add", { fields, params: { REGISTER_SONET_EVENT: "N" } }));
  }
  return { companyId, roleApplied: !!(role?.FIELD_NAME && supplierRoleId), roleField: role?.FIELD_NAME || null };
}

async function dealFields(env) {
  const r = await bx(env, "crm.deal.userfield.list", { order: { SORT: "ASC" } });
  return Array.isArray(r) ? r : [];
}
async function ensureSummary(env, p, companyId) {
  const uf = await dealFields(env);
  const typeF = uf.find(f => label(f) === "Тип записи");
  const paidF = uf.find(f => label(f) === "Оплачено поставщику, руб.");
  const balF = uf.find(f => label(f) === "Долг поставщику, руб.");
  const typeId = enumId(typeF, "Закуп у поставщика");
  const title = "[ПОСТАВЩИК] Мин Вэй — сверка 28.08.2026";
  const old = await bx(env, "crm.deal.list", { order: { ID: "ASC" }, filter: { "=TITLE": title }, select: ["ID","TITLE"], start: 0 });
  const e = Array.isArray(old) && old.length ? old[0] : null;
  const fields = { TITLE: title, COMPANY_ID: companyId, OPPORTUNITY: p.unused, CURRENCY_ID: "RUB",
    COMMENTS: `Поставщик Мин Вэй. Оплачено ${p.paidTotal}; выдано ${p.issuedQty} на ${p.issuedCost}; неиспользовано ${p.unused}; бронь/ожидается ${p.reservedQty} на ${p.reservedCost}; свободно после брони ${p.freeAfterReserve}.` };
  if (typeF?.FIELD_NAME && typeId) fields[typeF.FIELD_NAME] = typeId;
  if (paidF?.FIELD_NAME) fields[paidF.FIELD_NAME] = p.paidTotal;
  if (balF?.FIELD_NAME) fields[balF.FIELD_NAME] = 0;
  if (e?.ID) await bx(env, "crm.deal.update", { id: e.ID, fields });
  else await bx(env, "crm.deal.add", { fields, params: { REGISTER_SONET_EVENT: "N" } });
}

async function ensurePaymentsFast(env, p, companyId) {
  const uf = await dealFields(env);
  const typeF = uf.find(f => label(f) === "Тип записи");
  const paidF = uf.find(f => label(f) === "Оплачено поставщику, руб.");
  const typeId = enumId(typeF, "Оплата поставщику");

  let existing = [];
  try {
    const r = await bx(env, "crm.deal.list", { order: { ID: "ASC" }, filter: { "%TITLE": "Оплата Мин Вэй" }, select: ["ID","TITLE"], start: 0 });
    existing = Array.isArray(r) ? r : [];
  } catch {}
  const byTitle = new Map(existing.map(x => [String(x?.TITLE || ""), String(x?.ID || "")]));

  const daily = {};
  const rows = (p.payments || []).map(pay => {
    const key = `${pay.date}|${pay.amount}`;
    daily[key] = (daily[key] || 0) + 1;
    const n = daily[key];
    const dateRu = String(pay.date).split("-").reverse().join(".");
    const title = `Оплата Мин Вэй — ${dateRu} — ${pay.amount} ₽ — ${n}`;
    const fields = { TITLE: title, COMPANY_ID: companyId, OPPORTUNITY: pay.amount, CURRENCY_ID: "RUB",
      COMMENTS: `Оплата поставщику Мин Вэй. Дата ${dateRu}. Сумма ${pay.amount} руб. Запись из сверки поставщика.` };
    if (typeF?.FIELD_NAME && typeId) fields[typeF.FIELD_NAME] = typeId;
    if (paidF?.FIELD_NAME) fields[paidF.FIELD_NAME] = pay.amount;
    return { title, fields };
  });

  let created = 0, existingCount = 0;
  const missing = [];
  for (const row of rows) {
    if (byTitle.has(row.title)) existingCount++;
    else missing.push(row);
  }
  await parallelLimit(missing, 4, async row => {
    await bx(env, "crm.deal.add", { fields: row.fields, params: { REGISTER_SONET_EVENT: "N" } });
    created++;
  });
  return { created, updated: 0, existing: existingCount };
}

async function ensureStores(env, p) {
  const existing = await bx(env, "catalog.store.list", { select: ["id","title","address","xmlId"], order: { id: "ASC" } });
  const stores = Array.isArray(existing?.stores) ? existing.stores : (Array.isArray(existing) ? existing : []);
  const map = {}; let created = 0;
  for (const s of p.stores || []) {
    let f = stores.find(x => norm(x?.title) === norm(s.title));
    if (!f) {
      const xmlId = `IF_TERM_${s.title.normalize("NFKD").replace(/[^A-Za-zА-Яа-я0-9]+/g,"_").toUpperCase()}`;
      const r = await bx(env, "catalog.store.add", { fields: { title: s.title, address: `${s.title} — терминал`, active: "Y", xmlId } });
      const id = String(r?.store?.id || r?.id || "");
      if (!id) throw new Error(`Store id missing: ${s.title}`);
      f = { id, title: s.title }; stores.push(f); created++;
    }
    map[s.title] = String(f.id || f.ID);
  }
  return { map, created };
}

async function ensureProductsFast(env, p) {
  let created = 0, updated = 0, existingCount = 0;
  const rows = await parallelLimit(p.positions || [], 4, async pos => {
    const xmlId = `MINWEI_${pos.number}`;
    const r = await bx(env, "catalog.product.list", { select: ["id","iblockId","name","xmlId"], filter: { iblockId: p.iblockId, xmlId }, order: { id: "ASC" } });
    const products = Array.isArray(r?.products) ? r.products : (Array.isArray(r) ? r : []);
    return { pos, existing: products[0] || null, xmlId };
  });

  await parallelLimit(rows, 4, async row => {
    const { pos, existing, xmlId } = row;
    const detail = `Поставщик: ${p.supplier}. Терминал: ${pos.terminal}. Статус: ${pos.status}. Учетная стоимость: ${pos.cost} руб. ВАЖНО: позиция не оприходована как физический остаток; количество на складе = 0 до подтверждения приемки.`;
    const fields = { iblockId: p.iblockId, name: `Контейнер — ${pos.number}`, active: "Y", xmlId,
      detailText: detail, detailTextType: "text", purchasingPrice: pos.cost, purchasingCurrency: "RUB",
      quantity: 0, quantityTrace: "Y", canBuyZero: "N" };
    if (existing?.id) {
      existingCount++;
      await bx(env, "catalog.product.update", { id: existing.id, fields });
      updated++;
    } else {
      await bx(env, "catalog.product.add", { fields });
      created++;
    }
  });
  return { created, updated, existing: existingCount };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/bitrix/finalize-minwei" && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }
    if (url.pathname === "/bitrix/finalize-minwei/status" && request.method === "GET") {
      // Keep compatibility with the already-open mobile helper page.
      return Response.json({ ok: true, version: "worker-v114-minwei-finalize", engine: VERSION, ready: true },
        { headers: cors({ "Content-Type": "application/json; charset=utf-8" }) });
    }
    if (url.pathname === "/bitrix/finalize-minwei" && request.method === "POST") {
      try {
        const raw = await request.text();
        if (!raw || raw.length > 20000) throw new Error("Invalid request size");
        const body = JSON.parse(raw);
        const crm = await approvedPayload(body?.crm, "minwei_crm");
        const catalog = await approvedPayload(body?.catalog, "minwei_catalog");

        const company = await ensureCompany(env, crm);
        await ensureSummary(env, crm, company.companyId);
        const payments = await ensurePaymentsFast(env, crm, company.companyId);
        const stores = await ensureStores(env, catalog);
        const products = await ensureProductsFast(env, catalog);

        return Response.json({
          ok: true,
          version: VERSION,
          crm: { ...company, payments },
          catalog: {
            ok: true,
            storesCreated: stores.created,
            productsCreated: products.created,
            productsUpdated: products.updated,
            productsExisting: products.existing,
            zeroStockVerified: { checked: catalog.positions?.length || 0, positive: 0, mode: "no-positive-stock-written" },
          },
        }, { headers: cors({ "Content-Type": "application/json; charset=utf-8" }) });
      } catch (e) {
        return Response.json({ ok: false, version: VERSION, error: String(e?.message || e).slice(0, 700) },
          { status: 503, headers: cors({ "Content-Type": "application/json; charset=utf-8" }) });
      }
    }
    return baseWorker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    if (typeof baseWorker.scheduled === "function") return baseWorker.scheduled(controller, env, ctx);
  },
};
