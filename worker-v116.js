import baseWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v114.js";
import approvedWorker from "./worker-v113.js";

const VERSION = "worker-v116-minwei-existing-field-fix";
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
  u.search = "";
  u.hash = "";
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  u.pathname += `${method}.json`;
  return u.toString();
}
async function bx(env, method, params = {}) {
  const base = String(env?.BITRIX_WEBHOOK_URL || "").trim();
  if (!base) throw new Error("BITRIX_WEBHOOK_URL missing");
  let last = "unknown";
  for (let i = 0; i < 5; i++) {
    if (i) await sleep(300 * i);
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

async function normalizeExistingCompanyFields(env) {
  let uf = await bx(env, "crm.company.userfield.list", { order: { SORT: "ASC" } });
  uf = Array.isArray(uf) ? uf : [];

  const defs = [
    {
      match: f => /(?:^|_)CPROLE$/i.test(String(f?.FIELD_NAME || "")),
      label: "Роль контрагента",
    },
    {
      match: f => String(f?.FIELD_NAME || "").toUpperCase() === "UF_CRM_SUPPAIDTOT",
      label: "Поставщик — оплачено всего, руб.",
    },
    {
      match: f => String(f?.FIELD_NAME || "").toUpperCase() === "UF_CRM_SUPPADVREM",
      label: "Поставщик — остаток аванса, руб.",
    },
  ];

  const normalized = [];
  for (const def of defs) {
    const f = uf.find(def.match);
    if (!f?.ID) continue;
    try {
      await bx(env, "crm.company.userfield.update", {
        id: f.ID,
        fields: {
          EDIT_FORM_LABEL: def.label,
          LIST_COLUMN_LABEL: def.label,
          LIST_FILTER_LABEL: def.label,
          SHOW_FILTER: "Y",
          SHOW_IN_LIST: "Y",
          EDIT_IN_LIST: "Y",
        },
      });
      normalized.push(String(f.FIELD_NAME || f.ID));
    } catch (e) {
      // Some Bitrix editions reject non-essential label updates. The field still exists;
      // the fallback importer will be retried below and report a precise error if needed.
      normalized.push(`${String(f.FIELD_NAME || f.ID)}:exists`);
    }
  }
  return normalized;
}

async function runApproved(encoded, env, ctx) {
  if (typeof encoded !== "string" || !encoded || encoded.length > 10000) throw new Error("Invalid approved payload");
  const u = `https://internal.invalid/bitrix/apply-minwei-approved?p=${encodeURIComponent(encoded)}`;
  const r = await approvedWorker.fetch(new Request(u, { method: "GET" }), env, ctx);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.ok !== true) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/bitrix/finalize-minwei" && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    if (url.pathname === "/bitrix/finalize-minwei" && request.method === "POST") {
      try {
        const raw = await request.text();
        if (!raw || raw.length > 20000) throw new Error("Invalid request size");
        const body = JSON.parse(raw);

        const normalized = await normalizeExistingCompanyFields(env);
        const crm = await runApproved(body?.crm, env, ctx);
        const catalog = await runApproved(body?.catalog, env, ctx);

        return Response.json(
          { ok: true, version: VERSION, normalized, crm, catalog },
          { headers: cors({ "Content-Type": "application/json; charset=utf-8" }) },
        );
      } catch (e) {
        return Response.json(
          { ok: false, version: VERSION, error: String(e?.message || e).slice(0, 600) },
          { status: 503, headers: cors({ "Content-Type": "application/json; charset=utf-8" }) },
        );
      }
    }

    return baseWorker.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof baseWorker.scheduled === "function") return baseWorker.scheduled(controller, env, ctx);
  },
};
