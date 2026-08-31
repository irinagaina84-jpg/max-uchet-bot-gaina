import crmBoardsWorker from "./worker-v102.js";
import baseWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v100.js";

export class MaxBotContainer extends BaseMaxBotContainer {}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Keep the already verified project/supplier/payment health route stable
    // so legacy verification does not repeatedly trigger the CRM board bootstrap.
    if (url.pathname === "/bitrix/health") {
      return baseWorker.fetch(request, env, ctx);
    }

    // Dedicated one-shot/idempotent CRM clients + order/payment boards bootstrap.
    if (url.pathname === "/bitrix/crm-boards") {
      const u = new URL(request.url);
      u.pathname = "/bitrix/health";
      const proxied = new Request(u.toString(), request);
      return crmBoardsWorker.fetch(proxied, env, ctx);
    }

    return baseWorker.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof baseWorker.scheduled === "function") {
      return baseWorker.scheduled(controller, env, ctx);
    }
  },
};
