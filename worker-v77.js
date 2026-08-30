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

function mailQueryParam(url, name) {
  const direct = url.searchParams.get(name);
  if (direct != null && direct !== "") return direct;

  const escaped = url.searchParams.get(`amp;${name}`);
  if (escaped != null && escaped !== "") return escaped;

  const repaired = String(url.search || "")
    .replace(/&amp;/gi, "&")
    .replace(/%26amp%3B/gi, "&")
    .replace(/^\?/, "");
  return new URLSearchParams(repaired).get(name) || "";
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value || "")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorizedMailRequest(request, runtimeEnv) {
  const url = new URL(request.url);
  const token = String(runtimeEnv?.MAX_BOT_TOKEN || "");
  if (!token) return { error: new Response("MAX_BOT_TOKEN is not configured", { status: 503 }) };
  const expected = (await sha256Hex(token)).slice(0, 32);
  if (mailQueryParam(url, "t") !== expected) return { error: new Response("Forbidden", { status: 403 }) };
  return { url };
}

async function serveMailIndex(request, runtimeEnv) {
  const auth = await authorizedMailRequest(request, runtimeEnv);
  if (auth.error) return auth.error;
  const url = auth.url;
  const month = String(mailQueryParam(url, "month") || "");
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) return new Response("Invalid month", { status: 400 });
  const format = mailQueryParam(url, "format") === "csv" ? "csv" : "json";
  const container = getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE);
  const response = await container.fetch(new Request(
    "http://container/mail/index?month=" + encodeURIComponent(month) + "&format=" + encodeURIComponent(format),
    { method: "GET" }
  ));
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

async function serveMailYear(request, runtimeEnv) {
  const auth = await authorizedMailRequest(request, runtimeEnv);
  if (auth.error) return auth.error;
  const url = auth.url;
  const year = String(mailQueryParam(url, "year") || "");
  if (!/^20\d{2}$/.test(year)) return new Response("Invalid year", { status: 400 });
  const format = mailQueryParam(url, "format") === "csv" ? "csv" : "json";
  const container = getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE);
  const response = await container.fetch(new Request(
    "http://container/mail/year?year=" + encodeURIComponent(year) + "&format=" + encodeURIComponent(format),
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
    if (url.pathname === "/mail/year") {
      return serveMailYear(request, runtimeEnv);
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
