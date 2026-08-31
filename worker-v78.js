import { env } from "cloudflare:workers";
import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v77.js";

const BITRIX_BRIDGE_VERSION = "worker-v78-bitrix-bridge";

export class MaxBotContainer extends BaseMaxBotContainer {
  envVars = {
    ...this.envVars,
    BITRIX_WEBHOOK_URL: env.BITRIX_WEBHOOK_URL || "",
  };
}

function bitrixWebhook(runtimeEnv) {
  return String(runtimeEnv?.BITRIX_WEBHOOK_URL || env.BITRIX_WEBHOOK_URL || "").trim();
}

function bitrixMethodUrl(base, method) {
  const parsed = new URL(base);
  if (parsed.protocol !== "https:") throw new Error("Bitrix webhook must use HTTPS");
  if (!/\/rest\/\d+\/[^/]+\/?$/i.test(parsed.pathname)) throw new Error("Invalid Bitrix webhook format");
  parsed.search = "";
  parsed.hash = "";
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  parsed.pathname += `${method}.json`;
  return parsed.toString();
}

async function bitrixHealth(runtimeEnv) {
  const base = bitrixWebhook(runtimeEnv);
  if (!base) {
    return Response.json({
      ok: false,
      version: BITRIX_BRIDGE_VERSION,
      configured: false,
      connected: false,
      error: "BITRIX_WEBHOOK_URL is not configured",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  let response;
  try {
    response = await fetch(bitrixMethodUrl(base, "profile"), {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "follow",
    });
  } catch (error) {
    return Response.json({
      ok: false,
      version: BITRIX_BRIDGE_VERSION,
      configured: true,
      connected: false,
      error: String(error?.message || error).slice(0, 300),
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }

  let payload = null;
  try { payload = await response.json(); } catch {}
  const connected = response.ok && Boolean(payload?.result) && !payload?.error;

  return Response.json({
    ok: connected,
    version: BITRIX_BRIDGE_VERSION,
    configured: true,
    connected,
    bitrixStatus: response.status,
    error: connected ? null : String(payload?.error_description || payload?.error || `HTTP ${response.status}`).slice(0, 300),
  }, {
    status: connected ? 200 : 502,
    headers: { "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/bitrix/health") {
      return bitrixHealth(runtimeEnv);
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
