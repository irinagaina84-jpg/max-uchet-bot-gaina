import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v110.js";

const VERSION = "worker-v111-catalog-check";
export class MaxBotContainer extends BaseMaxBotContainer {}

function methodUrl(base, method) {
  const u = new URL(String(base || "").trim());
  if (u.protocol !== "https:" || !/\/rest\/\d+\/[^/]+\/?$/i.test(u.pathname)) throw new Error("Invalid Bitrix webhook");
  u.search = ""; u.hash = "";
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  u.pathname += `${method}.json`;
  return u.toString();
}

async function bxRaw(env, method, params = {}) {
  const base = String(env?.BITRIX_WEBHOOK_URL || "").trim();
  if (!base) throw new Error("BITRIX_WEBHOOK_URL missing");
  const r = await fetch(methodUrl(base, method), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(params),
  });
  const j = await r.json().catch(() => ({}));
  return { http: r.status, ok: r.ok && !j?.error, error: j?.error || null, error_description: j?.error_description || null, result: j?.result ?? null };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/bitrix/check-catalog" && request.method === "GET") {
      const catalog = await bxRaw(env, "catalog.catalog.list", {});
      const stores = await bxRaw(env, "catalog.store.list", {});
      return Response.json({
        ok: Boolean(catalog.ok && stores.ok),
        version: VERSION,
        catalog: { ok: catalog.ok, http: catalog.http, error: catalog.error, error_description: catalog.error_description, count: Array.isArray(catalog.result) ? catalog.result.length : (Array.isArray(catalog.result?.catalogs) ? catalog.result.catalogs.length : null) },
        stores: { ok: stores.ok, http: stores.http, error: stores.error, error_description: stores.error_description, count: Array.isArray(stores.result) ? stores.result.length : (Array.isArray(stores.result?.stores) ? stores.result.stores.length : null) },
      }, { status: catalog.ok && stores.ok ? 200 : 403, headers: { "Cache-Control": "no-store" } });
    }
    return currentWorker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, env, ctx);
  },
};
