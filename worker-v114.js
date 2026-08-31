import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v113.js";

const VERSION = "worker-v114-minwei-finalize";
export class MaxBotContainer extends BaseMaxBotContainer {}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    ...extra,
  };
}

async function jsonFromResponse(r) {
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: text.slice(0, 500) || `HTTP ${r.status}` }; }
}

async function runApprovedPayload(encoded, env, ctx) {
  if (typeof encoded !== "string" || !encoded || encoded.length > 10000) {
    return { ok: false, http: 400, body: { ok: false, error: "Invalid approved payload" } };
  }
  const internalUrl = `https://internal.invalid/bitrix/apply-minwei-approved?p=${encodeURIComponent(encoded)}`;
  const r = await currentWorker.fetch(new Request(internalUrl, { method: "GET" }), env, ctx);
  return { ok: r.ok, http: r.status, body: await jsonFromResponse(r) };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/bitrix/finalize-minwei" && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/bitrix/finalize-minwei/status" && request.method === "GET") {
      return Response.json(
        { ok: true, version: VERSION, ready: true },
        { headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }) },
      );
    }

    if (url.pathname === "/bitrix/finalize-minwei" && request.method === "POST") {
      try {
        const raw = await request.text();
        if (!raw || raw.length > 20000) throw new Error("Invalid request size");
        const body = JSON.parse(raw);

        const crm = await runApprovedPayload(body?.crm, env, ctx);
        if (!crm.ok || crm.body?.ok !== true) {
          return Response.json(
            { ok: false, version: VERSION, stage: "crm", crm },
            { status: 503, headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }) },
          );
        }

        const catalog = await runApprovedPayload(body?.catalog, env, ctx);
        if (!catalog.ok || catalog.body?.ok !== true) {
          return Response.json(
            { ok: false, version: VERSION, stage: "catalog", crm: crm.body, catalog },
            { status: 503, headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }) },
          );
        }

        return Response.json(
          { ok: true, version: VERSION, crm: crm.body, catalog: catalog.body },
          { headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }) },
        );
      } catch (e) {
        return Response.json(
          { ok: false, version: VERSION, error: String(e?.message || e).slice(0, 500) },
          { status: 400, headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }) },
        );
      }
    }

    return currentWorker.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, env, ctx);
  },
};
