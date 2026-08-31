import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v119.js";

const VERSION = "worker-v120-minwei-server-trigger";
export class MaxBotContainer extends BaseMaxBotContainer {}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/bitrix/run-minwei-approved-once" && request.method === "GET") {
      try {
        const crm = url.searchParams.get("crm") || "";
        const catalog = url.searchParams.get("catalog") || "";
        if (!crm || !catalog || crm.length > 10000 || catalog.length > 10000) {
          return Response.json({ ok: false, version: VERSION, error: "Invalid approved payloads" }, { status: 400, headers: { "Cache-Control": "no-store" } });
        }

        const internal = new Request("https://internal.invalid/bitrix/finalize-minwei", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ crm, catalog }),
        });
        const response = await currentWorker.fetch(internal, env, ctx);
        const body = await response.text();
        return new Response(body, {
          status: response.status,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        });
      } catch (e) {
        return Response.json({ ok: false, version: VERSION, error: String(e?.message || e).slice(0, 700) }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
    }

    if (url.pathname === "/bitrix/run-minwei-approved-once/status" && request.method === "GET") {
      return Response.json({ ok: true, version: VERSION, ready: true }, { headers: { "Cache-Control": "no-store" } });
    }

    return currentWorker.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, env, ctx);
  },
};
