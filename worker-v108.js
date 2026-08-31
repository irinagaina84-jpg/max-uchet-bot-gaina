import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v107.js";

const VERSION = "worker-v108-project-model-locked";
export class MaxBotContainer extends BaseMaxBotContainer {}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/bitrix/setup-project-model") {
      return Response.json({ ok: false, version: VERSION, error: "setup route disabled" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    return currentWorker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, env, ctx);
  },
};
