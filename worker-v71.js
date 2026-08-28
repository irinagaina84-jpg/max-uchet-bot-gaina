import { getContainer } from "@cloudflare/containers";
import exportWorker, { MaxBotContainer as ExportMaxBotContainer } from "./worker-v70.js";
import botWorker from "./worker.js";

const CONTAINER_INSTANCE = "production";
const CURRENT_CHAT_ID = "-77828005225953";
const RUNTIME_RESET_VERSION = "worker-v76-forward-source-chat-register-runtime-r1";
const WORKER_VERSION = "worker-v76-forward-source-chat-register-routing";

// Keep the Node bot warm. The cron runs every 5 minutes; a 30-minute sleep
// window also protects private commands when one cron invocation is delayed.
export class MaxBotContainer extends ExportMaxBotContainer {
  sleepAfter = "30m";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function containerHandle(runtimeEnv) {
  return getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE);
}

async function ensureBotRuntime(runtimeEnv) {
  const container = containerHandle(runtimeEnv);

  // Reset only once for this release. Unlike the old wrapper chain, no other
  // request changes this marker, so the process is not destroyed repeatedly.
  try {
    await container.resetRuntimeOnce(RUNTIME_RESET_VERSION);
  } catch {
    // A replacement process can still be started by the health request.
  }

  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
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

async function diagnostic(runtimeEnv, full = false) {
  const container = containerHandle(runtimeEnv);
  const [knownChats, recentUpdates, runtime, ledger] = await Promise.all([
    container.getKnownChats(),
    container.getRecentUpdates(),
    container.getRuntimeState(),
    container.ledgerSummary({ chat_id: CURRENT_CHAT_ID }),
  ]);

  const result = {
    ok: true,
    workerVersion: WORKER_VERSION,
    currentChatId: CURRENT_CHAT_ID,
    knownChatCount: knownChats.length,
    knownChats,
    recentUpdates,
    runtime,
    ledger,
  };

  if (full) {
    const health = await ensureBotRuntime(runtimeEnv);
    result.container = health.data;
  }

  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);

    // Durable-storage exports are handled by v70. These paths do not enter the
    // legacy v64/v63 wrappers and therefore cannot restart the chat bot.
    if (["/export/media", "/export/saved", "/export/health"].includes(url.pathname)) {
      return exportWorker.fetch(request, runtimeEnv, ctx);
    }

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

    if (url.pathname === "/diagnostic") {
      try { return await diagnostic(runtimeEnv, false); }
      catch (error) {
        return Response.json({ ok: false, workerVersion: WORKER_VERSION, error: String(error?.message || error) }, { status: 500 });
      }
    }

    if (url.pathname === "/diagnostic/full") {
      try { return await diagnostic(runtimeEnv, true); }
      catch (error) {
        return Response.json({ ok: false, workerVersion: WORKER_VERSION, error: String(error?.message || error) }, { status: 500 });
      }
    }

    // All webhook, private-message, state and ledger traffic goes straight to
    // the stable base worker. The obsolete v64/v63 image guards are bypassed;
    // they were alternately destroying the same container on every request.
    return botWorker.fetch(request, runtimeEnv, ctx);
  },

  async scheduled(_controller, runtimeEnv, ctx) {
    ctx.waitUntil(ensureBotRuntime(runtimeEnv).catch((error) => {
      console.error("MAX bot runtime keepalive failed", error);
    }));
  },
};
