import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v116.js";

const VERSION = "worker-v117-minwei-field-repair";
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
  const r = await fetch(methodUrl(base, method), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(`${method}: ${j?.error_description || j?.error || `HTTP ${r.status}`}`);
  return j?.result;
}
function labelText(v) {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object") for (const x of Object.values(v)) if (typeof x === "string" && x.trim()) return x.trim();
  return "";
}
function fieldLabel(f) {
  return labelText(f?.EDIT_FORM_LABEL) || labelText(f?.LIST_COLUMN_LABEL) || labelText(f?.LIST_FILTER_LABEL);
}

async function repair(env) {
  let uf = await bx(env, "crm.company.userfield.list", { order: { SORT: "ASC" } });
  uf = Array.isArray(uf) ? uf : [];
  const defs = [
    { code: "CPROLE", label: "Роль контрагента" },
    { code: "SUPPAIDTOT", label: "Поставщик — оплачено всего, руб." },
    { code: "SUPPADVREM", label: "Поставщик — остаток аванса, руб." },
  ];
  const result = [];
  for (const d of defs) {
    const f = uf.find(x => String(x?.FIELD_NAME || "").toUpperCase() === `UF_CRM_${d.code}`);
    if (!f?.ID) {
      result.push({ code: d.code, exists: false });
      continue;
    }
    let updated = false;
    let error = null;
    try {
      await bx(env, "crm.company.userfield.update", {
        id: f.ID,
        fields: {
          EDIT_FORM_LABEL: d.label,
          LIST_COLUMN_LABEL: d.label,
          LIST_FILTER_LABEL: d.label,
          SHOW_FILTER: "Y",
          SHOW_IN_LIST: "Y",
          EDIT_IN_LIST: "Y",
        },
      });
      updated = true;
    } catch (e) {
      error = String(e?.message || e).slice(0, 240);
    }
    result.push({ code: d.code, exists: true, id: String(f.ID), before: fieldLabel(f), updated, error });
  }
  let after = await bx(env, "crm.company.userfield.list", { order: { SORT: "ASC" } });
  after = Array.isArray(after) ? after : [];
  for (const row of result) {
    const f = after.find(x => String(x?.FIELD_NAME || "").toUpperCase() === `UF_CRM_${row.code}`);
    row.after = f ? fieldLabel(f) : "";
  }
  const role = result.find(x => x.code === "CPROLE");
  return { result, roleReady: !!role?.exists && role.after === "Роль контрагента" };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/bitrix/fix-minwei-fields" && request.method === "GET") {
      try {
        const r = await repair(env);
        return Response.json({ ok: true, version: VERSION, ...r }, { headers: { "Cache-Control": "no-store" } });
      } catch (e) {
        return Response.json({ ok: false, version: VERSION, error: String(e?.message || e).slice(0, 400) }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
    }
    return currentWorker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, env, ctx);
  },
};
