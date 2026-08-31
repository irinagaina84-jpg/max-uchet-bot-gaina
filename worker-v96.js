import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v94.js";

const VERSION = "worker-v96-bitrix-stable";

export class MaxBotContainer extends BaseMaxBotContainer {}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/bitrix/health") {
      try {
        const response = await currentWorker.fetch(request, env, ctx);
        const payload = await response.clone().json().catch(() => null);
        return Response.json({ ok: Boolean(response.ok && payload?.ok), version: VERSION }, {
          status: response.ok ? 200 : 503,
          headers: { "Cache-Control": "no-store" },
        });
      } catch {
        return Response.json({ ok: false, version: VERSION }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
    }
    return currentWorker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, env, ctx);
  },
};
