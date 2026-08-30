import { getContainer } from "@cloudflare/containers";
import exportWorker, { MaxBotContainer as ExportMaxBotContainer } from "./worker-v70.js";
import botWorker from "./worker.js";

const CONTAINER_INSTANCE = "production";
const CURRENT_CHAT_ID = "-77828005225953";
const RUNTIME_RESET_VERSION = "worker-v84-mailru-year-checkpoint-runtime-r3";
const WORKER_VERSION = "worker-v84-mailru-year-checkpoint-routing";
const encoder = new TextEncoder();

export class MaxBotContainer extends ExportMaxBotContainer {
  sleepAfter = "2h";

  async putMailYearCheckpoint(year, month, payloadText) {
    const y = String(year || "");
    const m = String(month || "");
    if (!/^20\d{2}$/.test(y) || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(m) || !m.startsWith(y + "-")) {
      throw new Error("invalid checkpoint period");
    }
    const text = String(payloadText || "");
    if (!text) throw new Error("empty checkpoint payload");
    const prefix = `mail:year:${y}:${m}:`;
    const old = await this.ctx.storage.list({ prefix, limit: 1000 });
    for (const key of old.keys()) await this.ctx.storage.delete(key);

    const chunkChars = 20000;
    const chunks = Math.ceil(text.length / chunkChars);
    for (let i = 0; i < chunks; i += 1) {
      await this.ctx.storage.put(`${prefix}chunk:${String(i).padStart(4, "0")}`, text.slice(i * chunkChars, (i + 1) * chunkChars));
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    const meta = {
      year: Number(y),
      month: m,
      chunks,
      chars: text.length,
      messages: Number(parsed?.messages || 0),
      attachments: Number(parsed?.attachments || 0),
      savedAt: Date.now(),
    };
    await this.ctx.storage.put(`${prefix}meta`, meta);
    return { ok: true, ...meta };
  }

  async getMailYearCheckpointMeta(year) {
    const y = String(year || "");
    if (!/^20\d{2}$/.test(y)) throw new Error("invalid checkpoint year");
    const page = await this.ctx.storage.list({ prefix: `mail:year:${y}:`, limit: 1000 });
    const months = [];
    for (const [key, value] of page.entries()) {
      if (key.endsWith(":meta") && value && typeof value === "object") months.push(value);
    }
    months.sort((a, b) => String(a.month).localeCompare(String(b.month)));
    return { ok: true, year: Number(y), months };
  }

  async getMailYearCheckpoint(year, month) {
    const y = String(year || "");
    const m = String(month || "");
    const prefix = `mail:year:${y}:${m}:`;
    const meta = await this.ctx.storage.get(`${prefix}meta`);
    if (!meta) return { ok: false, missing: true, year: Number(y), month: m };
    let text = "";
    for (let i = 0; i < Number(meta.chunks || 0); i += 1) {
      const part = await this.ctx.storage.get(`${prefix}chunk:${String(i).padStart(4, "0")}`);
      if (typeof part !== "string") throw new Error(`checkpoint chunk missing: ${m} #${i}`);
      text += part;
    }
    return { ok: true, year: Number(y), month: m, payloadText: text, meta };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function containerHandle(runtimeEnv) {
  return getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value || "")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function checkpointAuthorized(url, runtimeEnv) {
  const token = String(runtimeEnv?.MAX_BOT_TOKEN || "");
  if (!token) return false;
  const expected = (await sha256Hex(token)).slice(0, 32);
  return String(url.searchParams.get("t") || "") === expected;
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

async function handleCheckpoint(request, runtimeEnv) {
  const url = new URL(request.url);
  if (!(await checkpointAuthorized(url, runtimeEnv))) return new Response("Forbidden", { status: 403 });
  const year = String(url.searchParams.get("year") || "");
  const month = String(url.searchParams.get("month") || "");
  const container = containerHandle(runtimeEnv);

  if (request.method === "POST") {
    if (!month) return new Response("month required", { status: 400 });
    const payloadText = await request.text();
    const result = await container.putMailYearCheckpoint(year, month, payloadText);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  }

  if (request.method === "GET" && month) {
    const result = await container.getMailYearCheckpoint(year, month);
    if (!result?.ok) return Response.json(result, { status: 404, headers: { "Cache-Control": "no-store" } });
    return new Response(String(result.payloadText || ""), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  if (request.method === "GET") {
    return Response.json(await container.getMailYearCheckpointMeta(year), { headers: { "Cache-Control": "no-store" } });
  }
  return new Response("Method not allowed", { status: 405 });
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/mail/checkpoint") {
      try { return await handleCheckpoint(request, runtimeEnv); }
      catch (error) { return Response.json({ ok: false, error: String(error?.message || error) }, { status: 500 }); }
    }
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
