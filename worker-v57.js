import { getContainer } from "@cloudflare/containers";
import baseWorker, { MaxBotContainer } from "./worker.js";

const CONTAINER_INSTANCE = "production";
const WORKER_VERSION = "worker-v62-history-export";
const BOT_VERSION = "v62-history-export";
const CURRENT_CHAT_ID = "-77828005225953";

export { MaxBotContainer };

function containerHandle(runtimeEnv) {
  return getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE);
}

async function containerHealth(container) {
  const response = await container.fetch(new Request("http://container/health"));
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { ok: false, raw: text }; }
}

async function ensureV62(runtimeEnv) {
  const container = containerHandle(runtimeEnv);
  try {
    const health = await containerHealth(container);
    if (health?.version !== BOT_VERSION) {
      await container.resetRuntimeOnce(WORKER_VERSION);
    }
  } catch {
    await container.resetRuntimeOnce(WORKER_VERSION);
  }
  return container;
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    const container = await ensureV62(runtimeEnv);

    if (url.pathname === "/diagnostic") {
      const [knownChats, recentUpdates, runtime, ledger] = await Promise.all([
        container.getKnownChats(),
        container.getRecentUpdates(),
        container.getRuntimeState(),
        container.ledgerSummary({ chat_id: CURRENT_CHAT_ID }),
      ]);
      ctx.waitUntil(containerHealth(container).catch((error) => console.error("v62 health start error", error)));
      return Response.json({
        ok: true,
        workerVersion: WORKER_VERSION,
        currentChatId: CURRENT_CHAT_ID,
        ledgerSchemaVersion: 1,
        knownChatCount: knownChats.length,
        knownChats,
        recentUpdates,
        runtime,
        ledger,
      });
    }

    if (url.pathname === "/diagnostic/full") {
      const [health, ledger] = await Promise.all([
        containerHealth(container),
        container.ledgerSummary({ chat_id: CURRENT_CHAT_ID }),
      ]);
      return Response.json({ ok: true, workerVersion: WORKER_VERSION, currentChatId: CURRENT_CHAT_ID, ledger, container: health });
    }

    return baseWorker.fetch(request, runtimeEnv, ctx);
  },

  async scheduled(_controller, runtimeEnv, ctx) {
    ctx.waitUntil((async () => {
      const container = await ensureV62(runtimeEnv);
      await containerHealth(container);
    })().catch((error) => console.error("v62 keepalive error", error)));
  },
};
