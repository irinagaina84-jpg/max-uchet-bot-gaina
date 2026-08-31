import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v104.js";

export class MaxBotContainer extends BaseMaxBotContainer {}

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    ...extra,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname === "/bitrix/crm-boards-run") {
      return new Response(null, { status: 204, headers: cors() });
    }

    if (url.pathname === "/bitrix/crm-boards-run" && request.method === "GET") {
      const internal = new URL(request.url);
      internal.pathname = "/bitrix/crm-boards";
      const response = await currentWorker.fetch(new Request(internal.toString(), request), env, ctx);
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(cors())) headers.set(k, v);
      return new Response(response.body, { status: response.status, headers });
    }

    return currentWorker.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, env, ctx);
  },
};
