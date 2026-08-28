import { getContainer } from "@cloudflare/containers";
import v64Worker, { MaxBotContainer } from "./worker-v64.js";

const CONTAINER_INSTANCE = "production";
const WORKER_VERSION = "worker-v68-streaming-container-proxy";
const encoder = new TextEncoder();

export { MaxBotContainer };

function containerHandle(runtimeEnv) {
  return getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value || "")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchContainerExport(container, internalUrl) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (attempt > 0) await sleep(1500 * attempt);
      return await container.fetch(new Request(internalUrl.toString(), {
        method: "GET",
        headers: { "X-Internal-Media-Export": "1" }
      }));
    } catch (error) {
      lastError = error;
      try {
        const health = await container.fetch(new Request("http://container/health", { method: "GET" }));
        await health.arrayBuffer();
      } catch {
        // The next attempt will start a replacement instance automatically.
      }
    }
  }
  throw lastError || new Error("container export unavailable");
}

async function proxyMediaExport(request, runtimeEnv) {
  const token = String(runtimeEnv.MAX_BOT_TOKEN || "");
  if (!token) return new Response("MAX_BOT_TOKEN is not configured", { status: 503 });

  const sourceUrl = new URL(request.url);
  const expected = (await sha256Hex(token)).slice(0, 32);
  if (sourceUrl.searchParams.get("t") !== expected) {
    return new Response("Forbidden", { status: 403 });
  }

  const internalUrl = new URL("http://container/export/media");
  for (const [key, value] of sourceUrl.searchParams.entries()) {
    if (key !== "t") internalUrl.searchParams.append(key, value);
  }

  const container = containerHandle(runtimeEnv);
  const response = await fetchContainerExport(container, internalUrl);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, private");
  headers.set("X-MAX-Export-Route", WORKER_VERSION);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/export/media") {
      try {
        return await proxyMediaExport(request, runtimeEnv);
      } catch (error) {
        return new Response(`Media export proxy error: ${error?.message || error}`, { status: 500 });
      }
    }
    return v64Worker.fetch(request, runtimeEnv, ctx);
  },

  async scheduled(controller, runtimeEnv, ctx) {
    if (typeof v64Worker.scheduled === "function") {
      return v64Worker.scheduled(controller, runtimeEnv, ctx);
    }
    return undefined;
  }
};
