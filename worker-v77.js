import { env } from "cloudflare:workers";
import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v72.js";

export class MaxBotContainer extends BaseMaxBotContainer {
  envVars = {
    ...this.envVars,
    MAILRU_LOGIN: env.MAILRU_LOGIN || "",
    MAILRU_APP_PASSWORD: env.MAILRU_APP_PASSWORD || "",
    MAILRU_LOOKBACK_DAYS: env.MAILRU_LOOKBACK_DAYS || "400",
  };
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    return currentWorker.fetch(request, runtimeEnv, ctx);
  },

  async scheduled(controller, runtimeEnv, ctx) {
    if (typeof currentWorker.scheduled === "function") {
      return currentWorker.scheduled(controller, runtimeEnv, ctx);
    }
    return undefined;
  },
};
