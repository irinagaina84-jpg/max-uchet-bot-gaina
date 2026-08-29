import { env } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v72.js";

const CONTAINER_INSTANCE = "production";
const encoder = new TextEncoder();

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

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value || "")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function serveMailIndex(request, runtimeEnv) {
  const url = new URL(request.url);
  const token = String(runtimeEnv?.MAX_BOT_TOKEN || "");
  if (!token) return new Response("MAX_BOT_TOKEN is not configured", { status: 503 });
  const expected = (await sha256Hex(token)).slice(0, 32);
  if (url.searchParams.get("t") !== expected) return new Response("Forbidden", { status: 403 });

  const month = String(url.searchParams.get("month") || "");
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) return new Response("Invalid month", { status: 400 });
  const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
  const container = getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE);
  const response = await container.fetch(new Request(
    "http://container/mail/index?month=" + encodeURIComponent(month) + "&format=" + encodeURIComponent(format),
    { method: "GET" }
  ));
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/mail/index") {
      return serveMailIndex(request, runtimeEnv);
    }
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
