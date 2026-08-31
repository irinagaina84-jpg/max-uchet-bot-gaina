import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v91.js";

const VERSION = "worker-v92-bitrix-crm-card";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OPS_FIELD = "UF_CRM_OP_STATUS";
const CONTAINER_FIELDS = [
  OPS_FIELD,
  "UF_CRM_LEGAL_ENTITY",
  "UF_CRM_SUPPLIER",
  "UF_CRM_TERMINAL",
  "UF_CRM_CONTAINER_TYPE",
  "UF_CRM_CONTAINER_NUMBER",
  "UF_CRM_CONTAINER_QTY",
  "UF_CRM_INVOICE_NUMBER",
  "UF_CRM_PURCHASE_PRICE",
  "UF_CRM_SALE_PRICE",
  "UF_CRM_PAID_AMOUNT",
  "UF_CRM_SUPPLIER_BALANCE",
  "UF_CRM_PURCHASE_DATE",
  "UF_CRM_ISSUE_DATE",
  "UF_CRM_DOC_STATUS",
];

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
    if (!(r.status === 429 || r.status >= 500 || /limit|tempor|timeout|520|execution/i.test(last))) break;
  }
  throw new Error(`${method}: ${last}`);
}

async function ensureOpsStatus(env) {
  const existing = await bx(env, "crm.deal.userfield.list", { filter: { FIELD_NAME: OPS_FIELD, LANG: "ru" } });
  if (Array.isArray(existing) && existing.length) {
    return { ok: true, version: VERSION, created: false, id: existing[0]?.ID, fieldName: OPS_FIELD };
  }
  const values = [
    ["NEW", "Новая заявка"],
    ["INVOICE", "Счёт выставлен"],
    ["CLIENT_PAID", "Оплачено клиентом"],
    ["PURCHASE", "Закуп у поставщика"],
    ["TERMINAL", "Контейнер на терминале"],
    ["READY", "Готов к выдаче"],
    ["DOCS", "Документы закрыты"],
    ["DONE", "Выдано / закрыто"],
    ["CANCEL", "Отменено"],
  ].map(([xml, value], i) => ({ VALUE: value, XML_ID: `IF_OP_${xml}`, SORT: (i + 1) * 100, DEF: i === 0 ? "Y" : "N" }));
  const id = await bx(env, "crm.deal.userfield.add", {
    fields: {
      FIELD_NAME: "OP_STATUS",
      USER_TYPE_ID: "enumeration",
      XML_ID: "IF_OP_STATUS",
      SORT: 90,
      MULTIPLE: "N",
      MANDATORY: "N",
      SHOW_FILTER: "Y",
      SHOW_IN_LIST: "Y",
      EDIT_IN_LIST: "Y",
      EDIT_FORM_LABEL: "Операционный статус",
      LIST_COLUMN_LABEL: "Операционный статус",
      LIST_FILTER_LABEL: "Операционный статус",
      LIST: values,
      SETTINGS: { DISPLAY: "UI", LIST_HEIGHT: 1 },
    },
  });
  return { ok: true, version: VERSION, created: true, id, fieldName: OPS_FIELD };
}

async function getConfig(env, scope) {
  return bx(env, "crm.deal.details.configuration.get", { scope });
}

function withContainerSection(data) {
  const input = Array.isArray(data) ? data : [];
  const cleaned = input.filter(s => String(s?.name || "") !== "if_container_ops");
  cleaned.push({
    name: "if_container_ops",
    title: "КОНТЕЙНЕРЫ — УЧЁТ",
    type: "section",
    elements: CONTAINER_FIELDS.map(name => ({ name, optionFlags: 1 })),
  });
  return cleaned;
}

async function setupCard(env) {
  let sourceScope = "P";
  let base = await getConfig(env, "P");
  if (!Array.isArray(base) || !base.length) {
    sourceScope = "C";
    base = await getConfig(env, "C");
  }
  if (!Array.isArray(base) || !base.length) {
    return { ok: true, version: VERSION, changed: false, reason: "no_saved_card_configuration", message: "Existing Bitrix card layout is not explicitly saved; skipped to avoid replacing it blindly." };
  }
  const data = withContainerSection(base);
  await bx(env, "crm.deal.details.configuration.set", { scope: "P", data });
  return { ok: true, version: VERSION, changed: true, sourceScope, targetScope: "P", section: "КОНТЕЙНЕРЫ — УЧЁТ", elementCount: CONTAINER_FIELDS.length };
}

async function audit(env) {
  const fields = await bx(env, "crm.deal.userfield.list", { order: { SORT: "ASC" }, filter: { LANG: "ru" } });
  const ours = (Array.isArray(fields) ? fields : []).filter(x => CONTAINER_FIELDS.includes(String(x?.FIELD_NAME || "")));
  const personal = await getConfig(env, "P").catch(() => null);
  const common = await getConfig(env, "C").catch(() => null);
  const personalSection = Array.isArray(personal) ? personal.find(s => s?.name === "if_container_ops") : null;
  return {
    ok: true,
    version: VERSION,
    fieldCount: ours.length,
    fields: ours.map(x => ({ name: x.FIELD_NAME, label: x.EDIT_FORM_LABEL || x.LIST_COLUMN_LABEL || "", type: x.USER_TYPE_ID })),
    card: {
      personalSaved: Array.isArray(personal) && personal.length > 0,
      commonSaved: Array.isArray(common) && common.length > 0,
      containerSection: personalSection ? { title: personalSection.title, count: Array.isArray(personalSection.elements) ? personalSection.elements.length : 0 } : null,
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/bitrix/crm/setup/ops-status") return Response.json(await ensureOpsStatus(env), { headers: { "Cache-Control": "no-store" } });
      if (url.pathname === "/bitrix/crm/setup/card") return Response.json(await setupCard(env), { headers: { "Cache-Control": "no-store" } });
      if (url.pathname === "/bitrix/crm/audit") return Response.json(await audit(env), { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      return Response.json({ ok: false, version: VERSION, error: String(e?.message || e) }, { status: 500, headers: { "Cache-Control": "no-store" } });
    }
    return currentWorker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, env, ctx);
  },
};
