import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v92.js";

const VERSION = "worker-v93-bitrix-modern-card";
const FIELDS = [
  "UF_CRM_OP_STATUS",
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
    if (!(r.status === 429 || r.status >= 500 || /limit|tempor|timeout|520|execution/i.test(last))) break;
  }
  throw new Error(`${method}: ${last}`);
}

async function getConfig(env, scope) {
  return bx(env, "crm.item.details.configuration.get", { entityTypeId: 2, scope });
}

function addSection(config) {
  const source = Array.isArray(config) ? config : [];
  const cleaned = source.filter(s => String(s?.name || "") !== "if_container_ops");
  cleaned.push({
    name: "if_container_ops",
    title: "КОНТЕЙНЕРЫ — УЧЁТ",
    type: "section",
    elements: FIELDS.map(name => ({ name, optionFlags: "1" })),
  });
  return cleaned;
}

async function auditModern(env) {
  const personal = await getConfig(env, "P").catch(e => ({ __error: String(e?.message || e) }));
  const common = await getConfig(env, "C").catch(e => ({ __error: String(e?.message || e) }));
  const section = Array.isArray(personal) ? personal.find(s => s?.name === "if_container_ops") : null;
  return {
    ok: true,
    version: VERSION,
    personal: Array.isArray(personal) ? { count: personal.length, section: section ? { title: section.title, elements: Array.isArray(section.elements) ? section.elements.length : 0 } : null } : { count: 0, error: personal?.__error || null },
    common: Array.isArray(common) ? { count: common.length } : { count: 0, error: common?.__error || null },
  };
}

async function setupModern(env) {
  const personal = await getConfig(env, "P");
  const common = await getConfig(env, "C");
  const source = Array.isArray(personal) && personal.length ? personal : (Array.isArray(common) && common.length ? common : null);
  if (!source) {
    return { ok: true, version: VERSION, changed: false, reason: "modern_api_also_has_no_saved_configuration" };
  }
  const data = addSection(source);
  await bx(env, "crm.item.details.configuration.set", { entityTypeId: 2, scope: "P", data });
  return { ok: true, version: VERSION, changed: true, source: source === personal ? "P" : "C", target: "P", sections: data.length, containerFields: FIELDS.length };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/bitrix/crm/modern-card/audit") return Response.json(await auditModern(env), { headers: { "Cache-Control": "no-store" } });
      if (url.pathname === "/bitrix/crm/modern-card/setup") return Response.json(await setupModern(env), { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      return Response.json({ ok: false, version: VERSION, error: String(e?.message || e) }, { status: 500, headers: { "Cache-Control": "no-store" } });
    }
    return currentWorker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, env, ctx);
  },
};
