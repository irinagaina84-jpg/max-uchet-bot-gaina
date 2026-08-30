import { getContainer } from "@cloudflare/containers";
import exportWorker, { MaxBotContainer as ExportMaxBotContainer } from "./worker-v70.js";
import botWorker from "./worker.js";

const CONTAINER_INSTANCE = "production";
const CURRENT_CHAT_ID = "-77828005225953";
const RUNTIME_RESET_VERSION = "worker-v82-mailru-year-index-runtime-r2";
const WORKER_VERSION = "worker-v82-mailru-year-index-routing";

export class MaxBotContainer extends ExportMaxBotContainer {
  sleepAfter = "30m";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function containerHandle(runtimeEnv) {
  return getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE);
}

function runtimeResetVersion(runtimeEnv) {
  const mailReady = Boolean(
    String(runtimeEnv?.MAILRU_LOGIN || "").trim()
    && String(runtimeEnv?.MAILRU_APP_PASSWORD || "").trim()
  );
  return `${RUNTIME_RESET_VERSION}-${mailReady ? "mail-ready" : "mail-missing"}`;
}

async function ensureBotRuntime(runtimeEnv) {
  const container = containerHandle(runtimeEnv);
  const resetVersion = runtimeResetVersion(runtimeEnv);
  try { await container.resetRuntimeOnce(resetVersion); } catch {}

  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      if (attempt > 0) await sleep(1200 * attempt);
      const response = await container.fetch(new Request("http://container/health", { method: "GET" }));
      const text = await response.text();
      if (!response.ok) throw new Error(`container health ${response.status}: ${text.slice(0, 300)}`);
      let data = null;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return { ok: true, status: response.status, data, resetVersion };
    } catch (error) { lastError = error; }
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
  const result = { ok: true, workerVersion: WORKER_VERSION, currentChatId: CURRENT_CHAT_ID, knownChatCount: knownChats.length, knownChats, recentUpdates, runtime, ledger };
  if (full) result.container = (await ensureBotRuntime(runtimeEnv)).data;
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    if (["/export/media", "/export/saved", "/export/health"].includes(url.pathname)) return exportWorker.fetch(request, runtimeEnv, ctx);
    if (url.pathname === "/bot/health") {
      try {
        const result = await ensureBotRuntime(runtimeEnv);
        return Response.json({ ok: true, runtime: result.resetVersion, container: result.data }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        return Response.json({ ok: false, runtime: runtimeResetVersion(runtimeEnv), error: String(error?.message || error) }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
    }
    if (url.pathname === "/diagnostic") {
      try { return await diagnostic(runtimeEnv, false); }
      catch (error) { return Response.json({ ok: false, workerVersion: WORKER_VERSION, error: String(error?.message || error) }, { status: 500 }); }
    }
    if (url.pathname === "/diagnostic/full") {
      try { return await diagnostic(runtimeEnv, true); }
      catch (error) { return Response.json({ ok: false, workerVersion: WORKER_VERSION, error: String(error?.message || error) }, { status: 500 }); }
    }
    return botWorker.fetch(request, runtimeEnv, ctx);
  },

  async scheduled(_controller, runtimeEnv, ctx) {
    ctx.waitUntil(ensureBotRuntime(runtimeEnv).catch((error) => console.error("MAX bot runtime keepalive failed", error)));
  },
};
