import { getContainer } from "@cloudflare/containers";
import v70Worker, { MaxBotContainer } from "./worker-v70.js";

const CONTAINER_INSTANCE = "production";
const RUNTIME_RESET_VERSION = "worker-v71-reliable-webhook-runtime";

export { MaxBotContainer };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function containerHandle(runtimeEnv) {
  return getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE);
}

async function ensureBotRuntime(runtimeEnv) {
  const container = containerHandle(runtimeEnv);
  try {
    await container.resetRuntimeOnce(RUNTIME_RESET_VERSION);
  } catch {
    // A new instance can still be started by the health request below.
  }

  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (attempt > 0) await sleep(1200 * attempt);
      const response = await container.fetch(new Request("http://container/health", { method: "GET" }));
      const text = await response.text();
      if (!response.ok) throw new Error(`container health ${response.status}: ${text.slice(0, 300)}`);
      let data = null;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return { ok: true, status: response.status, data };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("MAX bot container did not start");
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/bot/health") {
      try {
        const result = await ensureBotRuntime(runtimeEnv);
        return Response.json({ ok: true, runtime: RUNTIME_RESET_VERSION, container: result.data }, {
          headers: { "Cache-Control": "no-store" },
        });
      } catch (error) {
        return Response.json({ ok: false, runtime: RUNTIME_RESET_VERSION, error: String(error?.message || error) }, {
          status: 503,
          headers: { "Cache-Control": "no-store" },
        });
      }
    }

    if (url.pathname === "/max-webhook" && request.method === "POST") {
      // Wake a fresh Node runtime first. This keeps private commands working even
      // after a previous large archive caused the old instance to stop.
      try {
        await ensureBotRuntime(runtimeEnv);
      } catch (error) {
        console.error("MAX runtime wake before webhook failed", error);
      }
    }

    return v70Worker.fetch(request, runtimeEnv, ctx);
  },

  async scheduled(controller, runtimeEnv, ctx) {
    ctx.waitUntil(ensureBotRuntime(runtimeEnv).catch((error) => {
      console.error("MAX bot runtime keepalive failed", error);
    }));
    if (typeof v70Worker.scheduled === "function") {
      return v70Worker.scheduled(controller, runtimeEnv, ctx);
    }
    return undefined;
  },
};
