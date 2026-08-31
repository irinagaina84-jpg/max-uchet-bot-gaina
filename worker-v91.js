import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v90.js";

const VERSION = "worker-v91-bitrix-crm-containers";
const PIPELINE_NAME = "КОНТЕЙНЕРЫ — ОПЕРАЦИОННЫЙ УЧЕТ";
const ENTITY_TYPE_ID = 2;
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
    if (i) await sleep(700 * i);
    const r = await fetch(methodUrl(base, method), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(params),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && !j?.error) return j?.result;
    last = String(j?.error_description || j?.error || `HTTP ${r.status}`);
    if (!(r.status === 429 || r.status >= 500 || /limit|tempor|timeout|520|execution/i.test(last))) break;
  }
  throw new Error(`${method}: ${last}`);
}

async function getPipeline(env) {
  const list = await bx(env, "crm.category.list", { entityTypeId: ENTITY_TYPE_ID });
  const categories = Array.isArray(list?.categories) ? list.categories : [];
  return categories.find(x => String(x?.name || "").trim() === PIPELINE_NAME) || null;
}
async function ensurePipeline(env) {
  let category = await getPipeline(env);
  if (category) return { category, created: false };
  const added = await bx(env, "crm.category.add", {
    entityTypeId: ENTITY_TYPE_ID,
    fields: { name: PIPELINE_NAME, sort: 50, isDefault: "N" },
  });
  category = added?.category || added;
  if (!category?.id) throw new Error("Bitrix did not return pipeline id");
  return { category, created: true };
}

const DESIRED_STAGES = [
  "Новая заявка",
  "Счёт выставлен",
  "Оплачено клиентом",
  "Закуп у поставщика",
  "Контейнер на терминале",
  "Готов к выдаче",
  "Документы закрыты",
];

async function setupPipeline(env) {
  const { category, created } = await ensurePipeline(env);
  const categoryId = Number(category.id);
  const entityId = `DEAL_STAGE_${categoryId}`;
  let statuses = await bx(env, "crm.status.list", { order: { SORT: "ASC" }, filter: { ENTITY_ID: entityId } });
  statuses = Array.isArray(statuses) ? statuses : [];
  const processing = statuses.filter(s => !String(s?.SEMANTICS || "")).sort((a,b) => Number(a.SORT||0)-Number(b.SORT||0));
  const success = statuses.filter(s => String(s?.SEMANTICS || "") === "S").sort((a,b) => Number(a.SORT||0)-Number(b.SORT||0));
  const failure = statuses.filter(s => String(s?.SEMANTICS || "") === "F").sort((a,b) => Number(a.SORT||0)-Number(b.SORT||0));
  const actions = [];

  for (let i = 0; i < DESIRED_STAGES.length; i++) {
    const name = DESIRED_STAGES[i];
    const sort = (i + 1) * 10;
    if (processing[i]?.ID) {
      await bx(env, "crm.status.update", { id: Number(processing[i].ID), fields: { NAME: name, SORT: sort } });
      actions.push({ action: "updated", name, id: processing[i].ID });
    } else {
      const code = ["REQUEST","INVOICE","CLIENT_PAID","PURCHASE","TERMINAL","READY_ISSUE","DOCS_CLOSED"][i];
      const id = await bx(env, "crm.status.add", { fields: { ENTITY_ID: entityId, STATUS_ID: code, NAME: name, SORT: sort, SEMANTICS: "" } });
      actions.push({ action: "added", name, id });
    }
  }
  if (success[0]?.ID) {
    await bx(env, "crm.status.update", { id: Number(success[0].ID), fields: { NAME: "Выдано / закрыто", SORT: 80 } });
    actions.push({ action: "updated", name: "Выдано / закрыто", id: success[0].ID });
  }
  if (failure[0]?.ID) {
    await bx(env, "crm.status.update", { id: Number(failure[0].ID), fields: { NAME: "Отменено", SORT: 90 } });
    actions.push({ action: "updated", name: "Отменено", id: failure[0].ID });
  }
  return { ok: true, version: VERSION, pipeline: { id: categoryId, name: PIPELINE_NAME, created }, actions };
}

const FIELD_DEFS = [
  ["LEGAL_ENTITY", "string", "Юрлицо: ИНТЕРФОРТУМ / АМИДИ", 100],
  ["SUPPLIER", "string", "Поставщик", 110],
  ["TERMINAL", "string", "Терминал", 120],
  ["CONTAINER_TYPE", "string", "Тип контейнера: 20 / 40", 130],
  ["CONTAINER_NUMBER", "string", "Номер контейнера", 140],
  ["CONTAINER_QTY", "integer", "Количество контейнеров", 150],
  ["INVOICE_NUMBER", "string", "Номер счёта", 160],
  ["PURCHASE_PRICE", "double", "Цена закупа, руб.", 170],
  ["SALE_PRICE", "double", "Цена продажи, руб.", 180],
  ["PAID_AMOUNT", "double", "Оплачено, руб.", 190],
  ["SUPPLIER_BALANCE", "double", "Остаток поставщику, руб.", 200],
  ["PURCHASE_DATE", "date", "Дата закупа", 210],
  ["ISSUE_DATE", "date", "Дата выдачи", 220],
  ["DOC_STATUS", "string", "Статус документов / УПД", 230],
];

async function ensureField(env, def) {
  const [code, type, label, sort] = def;
  const fullName = `UF_CRM_${code}`;
  const existing = await bx(env, "crm.deal.userfield.list", { filter: { FIELD_NAME: fullName, LANG: "ru" } });
  if (Array.isArray(existing) && existing.length) return { fieldName: fullName, label, created: false, id: existing[0]?.ID };
  const id = await bx(env, "crm.deal.userfield.add", {
    fields: {
      FIELD_NAME: code,
      USER_TYPE_ID: type,
      XML_ID: `IF_${code}`,
      SORT: sort,
      MULTIPLE: "N",
      MANDATORY: "N",
      SHOW_FILTER: "Y",
      SHOW_IN_LIST: "Y",
      EDIT_FORM_LABEL: label,
      LIST_COLUMN_LABEL: label,
      LIST_FILTER_LABEL: label,
    },
  });
  return { fieldName: fullName, label, created: true, id };
}

async function setupFields(env, batch) {
  const size = 5;
  const start = Math.max(0, (Number(batch) - 1) * size);
  const defs = FIELD_DEFS.slice(start, start + size);
  if (!defs.length) return { ok: true, version: VERSION, batch: Number(batch), fields: [], done: true };
  const fields = [];
  for (const def of defs) fields.push(await ensureField(env, def));
  return { ok: true, version: VERSION, batch: Number(batch), fields, done: start + size >= FIELD_DEFS.length };
}

async function status(env) {
  const pipeline = await getPipeline(env);
  const custom = await bx(env, "crm.deal.userfield.list", { filter: { LANG: "ru" }, order: { SORT: "ASC" } });
  const ourFields = (Array.isArray(custom) ? custom : []).filter(x => FIELD_DEFS.some(d => `UF_CRM_${d[0]}` === x.FIELD_NAME));
  let stages = [];
  if (pipeline?.id) {
    const entityId = `DEAL_STAGE_${Number(pipeline.id)}`;
    const r = await bx(env, "crm.status.list", { order: { SORT: "ASC" }, filter: { ENTITY_ID: entityId } });
    stages = (Array.isArray(r) ? r : []).map(s => ({ id: s.STATUS_ID, name: s.NAME, semantics: s.SEMANTICS, sort: s.SORT }));
  }
  return { ok: true, version: VERSION, pipeline: pipeline ? { id: pipeline.id, name: pipeline.name } : null, stages, fieldCount: ourFields.length, fields: ourFields.map(x => ({ fieldName: x.FIELD_NAME, label: x.EDIT_FORM_LABEL || x.LIST_COLUMN_LABEL || "" })) };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/bitrix/crm/setup/pipeline") return Response.json(await setupPipeline(env), { headers: { "Cache-Control": "no-store" } });
      if (url.pathname === "/bitrix/crm/setup/fields") return Response.json(await setupFields(env, url.searchParams.get("batch") || "1"), { headers: { "Cache-Control": "no-store" } });
      if (url.pathname === "/bitrix/crm/setup/status") return Response.json(await status(env), { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      return Response.json({ ok: false, version: VERSION, error: String(e?.message || e) }, { status: 500, headers: { "Cache-Control": "no-store" } });
    }
    return currentWorker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, env, ctx);
  },
};
