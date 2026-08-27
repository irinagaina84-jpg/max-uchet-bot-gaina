import { getContainer } from "@cloudflare/containers";
import baseWorker, { MaxBotContainer } from "./worker.js";

const CONTAINER_INSTANCE = "production";
const WORKER_VERSION = "worker-v63-safe-ledger-export";
const BOT_VERSION = "v63-safe-ledger-export";
const CURRENT_CHAT_ID = "-77828005225953";
const MAX_API = "https://platform-api2.max.ru";

export { MaxBotContainer };

function containerHandle(runtimeEnv) {
  return getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE);
}

async function containerHealth(container) {
  const response = await container.fetch(new Request("http://container/health"));
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { ok: false, raw: text }; }
}

async function ensureV63(runtimeEnv) {
  const container = containerHandle(runtimeEnv);
  try {
    const health = await containerHealth(container);
    if (health?.version !== BOT_VERSION) await container.resetRuntimeOnce(WORKER_VERSION);
  } catch {
    await container.resetRuntimeOnce(WORKER_VERSION);
  }
  return container;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function messageTime(m) { return Number(m?.timestamp || m?.body?.timestamp || 0); }
function messageId(m) { return String(m?.body?.mid || m?.mid || m?.id || ""); }
function messageText(m) { return String(m?.body?.text || m?.text || ""); }
function senderName(m) {
  const s = m?.sender || {};
  return [s.first_name, s.last_name].filter(Boolean).join(" ") || s.username || String(s.user_id || "не указан");
}
function localStamp(ms) {
  const d = new Date(Number(ms || Date.now()) + 5 * 60 * 60000);
  const p = (v) => String(v).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

async function maxJson(runtimeEnv, path) {
  const r = await fetch(MAX_API + path, { headers: { Authorization: runtimeEnv.MAX_BOT_TOKEN, Accept: "application/json" } });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`MAX ${r.status}: ${data?.message || data?.error || text.slice(0, 300)}`);
  return data;
}

async function fetchAllHistory(runtimeEnv, since = 0) {
  const out = [];
  let before = Date.now();
  for (let page = 0; page < 50 && out.length < 5000; page++) {
    const q = new URLSearchParams({ chat_id: CURRENT_CHAT_ID, count: "100", from: String(before) });
    if (since) q.set("to", String(since));
    const data = await maxJson(runtimeEnv, `/messages?${q.toString()}`);
    const items = data?.messages || data?.items || [];
    if (!items.length) break;
    out.push(...items);
    const times = items.map(messageTime).filter(Boolean);
    const oldest = times.length ? Math.min(...times) : 0;
    if (!oldest || items.length < 100 || (since && oldest <= since)) break;
    before = oldest - 1;
  }
  const byId = new Map();
  for (const m of out) byId.set(messageId(m) || `${messageTime(m)}:${byId.size}`, m);
  return [...byId.values()].filter((m) => !since || messageTime(m) >= since).sort((a, b) => messageTime(a) - messageTime(b));
}

function historyText(rows, mode, since) {
  const lines = [
    "MAX — экспорт рабочей переписки",
    `chat_id: ${CURRENT_CHAT_ID}`,
    `Режим: ${mode === "new" ? "новые сообщения" : "вся история"}`,
    `Сформировано: ${localStamp(Date.now())}`,
    ...(since ? [`Начиная с: ${localStamp(since)}`] : []),
    `Сообщений: ${rows.length}`,
    ""
  ];
  for (const m of rows) {
    lines.push("============================================================");
    lines.push(`Дата: ${localStamp(messageTime(m) || Date.now())}`);
    lines.push(`Автор: ${senderName(m)}`);
    lines.push(`message_id: ${messageId(m) || "не указан"}`);
    const reply = m?.body?.reply_to || m?.body?.reply || m?.reply_to || null;
    if (reply) lines.push(`Ответ на: ${String(reply?.body?.text || reply?.text || "").replace(/\s+/g, " ").trim()}`);
    lines.push("Текст:");
    lines.push(messageText(m).trim() || "[без текста]");
    const at = Array.isArray(m?.body?.attachments) ? m.body.attachments : Array.isArray(m?.attachments) ? m.attachments : [];
    if (at.length) lines.push(`Вложения: ${at.map((a) => a?.type || "attachment").join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function exportHistory(request, runtimeEnv) {
  const url = new URL(request.url);
  const expected = (await sha256Hex(runtimeEnv.MAX_BOT_TOKEN)).slice(0, 32);
  if (!expected || url.searchParams.get("t") !== expected) return new Response("Forbidden", { status: 403 });
  const mode = url.searchParams.get("mode") === "new" ? "new" : "all";
  const since = mode === "new" ? Math.max(0, Number(url.searchParams.get("since") || 0)) : 0;
  const rows = await fetchAllHistory(runtimeEnv, since);
  const body = historyText(rows, mode, since);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const filename = `${mode === "new" ? "max_new" : "max_history"}_${stamp}.txt`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, private"
    }
  });
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/export/history") {
      try { return await exportHistory(request, runtimeEnv); }
      catch (error) { return new Response(`Export error: ${error?.message || error}`, { status: 500 }); }
    }

    const container = await ensureV63(runtimeEnv);

    if (url.pathname === "/diagnostic") {
      const [knownChats, recentUpdates, runtime, ledger] = await Promise.all([
        container.getKnownChats(), container.getRecentUpdates(), container.getRuntimeState(), container.ledgerSummary({ chat_id: CURRENT_CHAT_ID }),
      ]);
      ctx.waitUntil(containerHealth(container).catch((error) => console.error("v63 health start error", error)));
      return Response.json({ ok: true, workerVersion: WORKER_VERSION, currentChatId: CURRENT_CHAT_ID, ledgerSchemaVersion: 1, knownChatCount: knownChats.length, knownChats, recentUpdates, runtime, ledger });
    }

    if (url.pathname === "/diagnostic/full") {
      const [health, ledger] = await Promise.all([containerHealth(container), container.ledgerSummary({ chat_id: CURRENT_CHAT_ID })]);
      return Response.json({ ok: true, workerVersion: WORKER_VERSION, currentChatId: CURRENT_CHAT_ID, ledger, container: health });
    }

    return baseWorker.fetch(request, runtimeEnv, ctx);
  },

  async scheduled(_controller, runtimeEnv, ctx) {
    ctx.waitUntil((async () => { const container = await ensureV63(runtimeEnv); await containerHealth(container); })().catch((error) => console.error("v63 keepalive error", error)));
  },
};
