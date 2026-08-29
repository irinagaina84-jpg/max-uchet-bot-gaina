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

function hasValue(value) {
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

function mailBindingNames(source) {
  try {
    return Object.keys(source || {})
      .filter((key) => /mail/i.test(String(key)))
      .sort();
  } catch {
    return [];
  }
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/mail/env-check") {
      return Response.json({
        ok: true,
        runtime: {
          login: hasValue(runtimeEnv?.MAILRU_LOGIN),
          password: hasValue(runtimeEnv?.MAILRU_APP_PASSWORD),
        },
        global: {
          login: hasValue(env.MAILRU_LOGIN),
          password: hasValue(env.MAILRU_APP_PASSWORD),
        },
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/mail/env-keys") {
      return Response.json({
        ok: true,
        runtimeNames: mailBindingNames(runtimeEnv),
        globalNames: mailBindingNames(env),
      }, { headers: { "Cache-Control": "no-store" } });
    }
    return currentWorker.fetch(request, runtimeEnv, ctx);
  },

  async scheduled(controller, runtimeEnv, ctx) {
    if (typeof currentWorker.scheduled === "function") {
      return currentWorker.scheduled(controller, runtimeEnv, ctx);
    }
    return undefined;
  },
};
