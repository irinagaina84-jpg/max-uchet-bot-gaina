import { env } from "cloudflare:workers";
import { Container, getContainer } from "@cloudflare/containers";

const CONTAINER_INSTANCE = "production";
const PUBLIC_BASE = "https://max-uchet-bot-gaina.irina-gaina-84-036.workers.dev";
const DEFAULT_STATE_URL = `${PUBLIC_BASE}/state`;
const DEFAULT_WEBHOOK_URL = `${PUBLIC_BASE}/max-webhook`;
const DEFAULT_LEDGER_URL = `${PUBLIC_BASE}/ledger`;
const CHAT_REGISTRY_VERSION = 8;
const LEDGER_SCHEMA_VERSION = 1;
const WORKER_VERSION = "worker-v56-persistent-ledger";
const STALE_CHAT_IDS = new Set(["-77765742260432"]);
const CURRENT_CHAT_ID = "-77828005225953";

function isStaleChatId(value) { return STALE_CHAT_IDS.has(String(value ?? "")); }
function safeString(value, max = 4000) { return String(value ?? "").slice(0, max); }
function padTime(value) { return String(Math.max(0, Number(value || 0))).padStart(13, "0"); }
function normalizeContainerNumber(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function eventMatches(event, filters = {}) {
  if (filters.from && Number(event.effective_time_ms || 0) < Number(filters.from)) return false;
  if (filters.to && Number(event.effective_time_ms || 0) > Number(filters.to)) return false;
  if (filters.customer && !safeString(event.customer).toLowerCase().includes(String(filters.customer).toLowerCase())) return false;
  if (filters.terminal && !safeString(event.terminal).toLowerCase().includes(String(filters.terminal).toLowerCase())) return false;
  if (filters.release && !`${safeString(event.release_name)} ${safeString(event.release_code)}`.toLowerCase().includes(String(filters.release).toLowerCase())) return false;
  if (filters.container_type && !safeString(event.container_type).toLowerCase().includes(String(filters.container_type).toLowerCase())) return false;
  return true;
}

export class MaxBotContainer extends Container {
  defaultPort = 3000;
  sleepAfter = "10m";
  envVars = {
    MAX_BOT_TOKEN: env.MAX_BOT_TOKEN,
    OPENAI_API_KEY: env.OPENAI_API_KEY || "",
    OPENAI_MODEL: env.OPENAI_MODEL || "gpt-5.6-sol",
    GIGACHAT_AUTH_KEY: env.GIGACHAT_AUTH_KEY,
    GIGACHAT_SCOPE: env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
    GIGACHAT_MODEL: env.GIGACHAT_MODEL || "GigaChat-3-Ultra",
    REPORT_USER_ID: env.REPORT_USER_ID || "",
    WATCH_CHAT_IDS: CURRENT_CHAT_ID,
    DEFAULT_CUSTOMER: env.DEFAULT_CUSTOMER || "Взлёт",
    ACCOUNTING_TZ_OFFSET_MINUTES: env.ACCOUNTING_TZ_OFFSET_MINUTES || "300",
    STATE_URL: env.STATE_URL || DEFAULT_STATE_URL,
    LEDGER_URL: env.LEDGER_URL || DEFAULT_LEDGER_URL,
    MAX_WEBHOOK_URL: env.MAX_WEBHOOK_URL || DEFAULT_WEBHOOK_URL,
    PORT: "3000",
  };

  async ensureRegistryVersion() {
    const current = await this.ctx.storage.get("chat_registry_version");
    if (current !== CHAT_REGISTRY_VERSION) {
      await this.ctx.storage.put("chat_registry_version", CHAT_REGISTRY_VERSION);
      await this.ctx.storage.put("known_chats", [{ chat_id: CURRENT_CHAT_ID, title: `чат ${CURRENT_CHAT_ID}`, lastSeenAt: Date.now() }]);
      await this.ctx.storage.put("recent_updates", []);
    }
    const ledgerVersion = await this.ctx.storage.get("ledger_schema_version");
    if (ledgerVersion !== LEDGER_SCHEMA_VERSION) await this.ctx.storage.put("ledger_schema_version", LEDGER_SCHEMA_VERSION);
  }

  async getKnownChats() {
    await this.ensureRegistryVersion();
    const current = (await this.ctx.storage.get("known_chats")) || [];
    const filtered = current.filter((x) => !isStaleChatId(x?.chat_id));
    if (!filtered.some((x) => String(x?.chat_id) === CURRENT_CHAT_ID)) filtered.push({ chat_id: CURRENT_CHAT_ID, title: `чат ${CURRENT_CHAT_ID}`, lastSeenAt: Date.now() });
    if (JSON.stringify(filtered) !== JSON.stringify(current)) await this.ctx.storage.put("known_chats", filtered);
    return filtered;
  }
  async setKnownChats(chats) {
    await this.ensureRegistryVersion();
    const safe = (Array.isArray(chats) ? chats : []).filter((x) => !isStaleChatId(x?.chat_id)).slice(0, 500);
    if (!safe.some((x) => String(x?.chat_id) === CURRENT_CHAT_ID)) safe.push({ chat_id: CURRENT_CHAT_ID, title: `чат ${CURRENT_CHAT_ID}`, lastSeenAt: Date.now() });
    await this.ctx.storage.put("known_chats", safe);
    return { ok: true, count: safe.length };
  }
  async rememberChat(chatId, title = null) {
    if (chatId == null || isStaleChatId(chatId)) return { ok: false, ignored: true };
    const id = String(chatId); const chats = await this.getKnownChats(); const previous = chats.find((x) => String(x?.chat_id) === id);
    const next = chats.filter((x) => String(x?.chat_id) !== id); next.push({ chat_id: id, title: title || previous?.title || `чат ${id}`, lastSeenAt: Date.now() });
    await this.ctx.storage.put("known_chats", next.slice(-500)); return { ok: true, count: next.length };
  }
  async forgetChat(chatId) {
    if (chatId == null) return { ok: true }; const id = String(chatId); const chats = await this.getKnownChats(); const next = chats.filter((x) => String(x?.chat_id) !== id);
    if (id === CURRENT_CHAT_ID) next.push({ chat_id: CURRENT_CHAT_ID, title: `чат ${CURRENT_CHAT_ID}`, lastSeenAt: Date.now() });
    await this.ctx.storage.put("known_chats", next); return { ok: true, count: next.length };
  }
  async rememberUpdate(update) {
    await this.ensureRegistryVersion(); const existing = (await this.ctx.storage.get("recent_updates")) || [];
    const item = { at: Date.now(), update_type: String(update?.update_type || ""), chat_id: update?.chat_id ?? update?.message?.recipient?.chat_id ?? null, recipient_type: update?.message?.recipient?.chat_type ?? update?.message?.recipient?.type ?? null };
    await this.ctx.storage.put("recent_updates", [...existing, item].slice(-30));
  }
  async getRecentUpdates() { await this.ensureRegistryVersion(); return (await this.ctx.storage.get("recent_updates")) || []; }

  async recordRawUpdate(update) {
    await this.ensureRegistryVersion(); const type = String(update?.update_type || ""); const m = update?.message || null;
    if (!m || !["message_created", "message_edited", "message_removed"].includes(type)) return { ok: true, ignored: true };
    const chatId = String(update?.chat_id ?? m?.recipient?.chat_id ?? ""); if (!chatId || isStaleChatId(chatId)) return { ok: true, ignored: true };
    const mid = safeString(m?.body?.mid ?? m?.mid ?? m?.id ?? "", 200); if (!mid) return { ok: true, ignored: true };
    const ts = Number(m?.timestamp ?? m?.body?.timestamp ?? Date.now()); const idxKey = `ledger:rawidx:${chatId}:${mid}`; let rawKey = await this.ctx.storage.get(idxKey);
    if (!rawKey) { rawKey = `ledger:raw:${chatId}:${padTime(ts)}:${mid}`; await this.ctx.storage.put(idxKey, rawKey); }
    const record = { chat_id: chatId, mid, timestamp: ts, update_type: type, removed: type === "message_removed", sender: m?.sender || null, recipient: m?.recipient || null, text: safeString(m?.body?.text ?? m?.text ?? "", 12000), body: m?.body || null, attachments: Array.isArray(m?.body?.attachments) ? m.body.attachments : Array.isArray(m?.attachments) ? m.attachments : [], saved_at: Date.now() };
    await this.ctx.storage.put(rawKey, record); return { ok: true, key: rawKey };
  }
  async putRawRecords(records) {
    await this.ensureRegistryVersion(); let count = 0;
    for (const input of Array.isArray(records) ? records : []) {
      const chatId = String(input?.chat_id || ""); const mid = safeString(input?.mid || "", 200); const ts = Number(input?.timestamp || Date.now());
      if (!chatId || !mid || isStaleChatId(chatId)) continue; const idxKey = `ledger:rawidx:${chatId}:${mid}`; let rawKey = await this.ctx.storage.get(idxKey);
      if (!rawKey) { rawKey = `ledger:raw:${chatId}:${padTime(ts)}:${mid}`; await this.ctx.storage.put(idxKey, rawKey); }
      await this.ctx.storage.put(rawKey, { ...input, chat_id: chatId, mid, timestamp: ts, saved_at: Date.now() }); count += 1;
    }
    return { ok: true, count };
  }
  async rawContext(chatId, limit = 30) {
    await this.ensureRegistryVersion(); const id = String(chatId || CURRENT_CHAT_ID);
    const page = await this.ctx.storage.list({ prefix: `ledger:raw:${id}:`, reverse: true, limit: Math.max(1, Math.min(100, Number(limit || 30))) });
    return [...page.values()].reverse();
  }
  async replaceSourceEvents(chatId, sourceMid, events) {
    await this.ensureRegistryVersion(); const id = String(chatId || CURRENT_CHAT_ID); const mid = safeString(sourceMid || "", 200); if (!mid) throw new Error("source_mid required");
    const idxKey = `ledger:eventidx:${id}:${mid}`; const oldKeys = (await this.ctx.storage.get(idxKey)) || []; for (const key of oldKeys) await this.ctx.storage.delete(key);
    const keys = []; let ordinal = 0;
    for (const input of Array.isArray(events) ? events : []) {
      ordinal += 1; const ts = Number(input?.effective_time_ms || input?.timestamp || Date.now()); const eventId = safeString(input?.event_id || `${mid}:${ordinal}`, 240); const key = `ledger:event:${id}:${padTime(ts)}:${eventId}`;
      const numbers = [...new Set((Array.isArray(input?.container_numbers) ? input.container_numbers : []).map(normalizeContainerNumber).filter(Boolean))]; const delta = Number(input?.delta_quantity || 0);
      const event = { event_id: eventId, chat_id: id, source_mid: mid, effective_time_ms: ts, event_type: safeString(input?.event_type || "context", 40), count_as_issued: Boolean(input?.count_as_issued), delta_quantity: Number.isFinite(delta) ? Math.trunc(delta) : 0, customer: input?.customer ? safeString(input.customer, 200) : null, supplier: input?.supplier ? safeString(input.supplier, 200) : null, terminal: input?.terminal ? safeString(input.terminal, 200) : null, container_type: input?.container_type ? safeString(input.container_type, 80) : null, container_numbers: numbers, release_name: input?.release_name ? safeString(input.release_name, 200) : null, release_code: input?.release_code ? safeString(input.release_code, 200) : null, uncertain: Boolean(input?.uncertain), notes: input?.notes ? safeString(input.notes, 2000) : null, parser_version: input?.parser_version ? safeString(input.parser_version, 100) : null, source_text: input?.source_text ? safeString(input.source_text, 4000) : null, saved_at: Date.now() };
      await this.ctx.storage.put(key, event); keys.push(key);
    }
    await this.ctx.storage.put(idxKey, keys); await this.ctx.storage.put("ledger:last_write_at", Date.now()); return { ok: true, replaced: oldKeys.length, written: keys.length };
  }
  async listLedgerEvents(filters = {}) {
    await this.ensureRegistryVersion(); const id = String(filters?.chat_id || CURRENT_CHAT_ID); const page = await this.ctx.storage.list({ prefix: `ledger:event:${id}:`, limit: 1000 });
    const events = [...page.values()].filter((e) => eventMatches(e, filters)); events.sort((a, b) => Number(a.effective_time_ms || 0) - Number(b.effective_time_ms || 0)); return events;
  }
  async ledgerSummary(filters = {}) {
    const events = await this.listLedgerEvents(filters); const activeNumbers = new Map(); const anonymous = []; let uncertainDelta = 0;
    for (const e of events) {
      if (!e?.count_as_issued) continue; const delta = Math.trunc(Number(e.delta_quantity || 0)); if (!delta) continue; if (e.uncertain) { uncertainDelta += delta; continue; }
      const numbers = [...new Set((e.container_numbers || []).map(normalizeContainerNumber).filter(Boolean))]; const sign = delta > 0 ? 1 : -1;
      for (const number of numbers) { if (sign > 0) activeNumbers.set(number, e); else activeNumbers.delete(number); }
      const remaining = Math.max(0, Math.abs(delta) - numbers.length); if (remaining) anonymous.push({ ...e, signed_quantity: sign * remaining });
    }
    const byTerminal = new Map(); const byType = new Map(); const add = (map, key, qty) => map.set(key || "Не указан", (map.get(key || "Не указан") || 0) + qty);
    for (const e of activeNumbers.values()) { add(byTerminal, e.terminal, 1); add(byType, e.container_type, 1); }
    let anonymousTotal = 0; for (const e of anonymous) { anonymousTotal += e.signed_quantity; add(byTerminal, e.terminal, e.signed_quantity); add(byType, e.container_type, e.signed_quantity); }
    return { ok: true, schema_version: LEDGER_SCHEMA_VERSION, chat_id: String(filters?.chat_id || CURRENT_CHAT_ID), total: activeNumbers.size + anonymousTotal, numbered_total: activeNumbers.size, anonymous_total: anonymousTotal, uncertain_delta: uncertainDelta, by_terminal: Object.fromEntries([...byTerminal.entries()].sort((a, b) => b[1] - a[1])), by_type: Object.fromEntries([...byType.entries()].sort((a, b) => b[1] - a[1])), active_container_numbers: [...activeNumbers.keys()], event_count: events.length, last_write_at: (await this.ctx.storage.get("ledger:last_write_at")) || null, backfill: (await this.ctx.storage.get(`ledger:backfill:${String(filters?.chat_id || CURRENT_CHAT_ID)}`)) || null };
  }
  async getBackfillState(chatId) { return (await this.ctx.storage.get(`ledger:backfill:${String(chatId || CURRENT_CHAT_ID)}`)) || null; }
  async setBackfillState(chatId, value) { const key = `ledger:backfill:${String(chatId || CURRENT_CHAT_ID)}`; await this.ctx.storage.put(key, { ...(value || {}), updated_at: Date.now() }); return await this.ctx.storage.get(key); }
  async resetLedger(chatId) {
    const id = String(chatId || CURRENT_CHAT_ID);
    for (const prefix of [`ledger:event:${id}:`, `ledger:eventidx:${id}:`, `ledger:raw:${id}:`, `ledger:rawidx:${id}:`]) { const page = await this.ctx.storage.list({ prefix, limit: 1000 }); for (const key of page.keys()) await this.ctx.storage.delete(key); }
    await this.ctx.storage.delete(`ledger:backfill:${id}`); await this.ctx.storage.put("ledger:last_write_at", Date.now()); return { ok: true, chat_id: id };
  }
  async getRuntimeState() { return { running: Boolean(this.ctx.container.running), workerVersion: WORKER_VERSION }; }
  async resetRuntimeOnce(version) { const key = "runtime_reset_version"; const current = await this.ctx.storage.get(key); if (current === version) return { reset: false, running: Boolean(this.ctx.container.running) }; await this.ctx.storage.put(key, version); const wasRunning = Boolean(this.ctx.container.running); if (wasRunning) await this.destroy(); return { reset: true, wasRunning }; }
}

function eventChatId(update) { return update?.chat_id ?? update?.message?.recipient?.chat_id ?? null; }
function isGroupMessageUpdate(update) { const type = String(update?.message?.recipient?.chat_type || update?.message?.recipient?.type || "").toLowerCase(); return type === "chat" || type === "channel"; }
async function processWebhook(runtimeEnv, update) {
  const container = getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE); const chatId = eventChatId(update); const type = String(update?.update_type || "");
  await container.rememberUpdate(update); await container.recordRawUpdate(update);
  if (type === "bot_removed" && chatId != null) await container.forgetChat(chatId); else if (type === "bot_added" && chatId != null) await container.rememberChat(chatId, null); else if (type === "chat_title_changed" && chatId != null) await container.rememberChat(chatId, update?.title || null); else if (["message_created", "message_edited", "message_removed"].includes(type) && chatId != null && isGroupMessageUpdate(update)) await container.rememberChat(chatId, null);
  await container.fetch(new Request("http://container/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update || {}) }));
}
async function containerHealth(runtimeEnv) { const container = getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE); const response = await container.fetch(new Request("http://container/health")); const text = await response.text(); try { return JSON.parse(text); } catch { return { ok: false, raw: text }; } }
async function pingContainer(runtimeEnv) { const container = getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE); await container.resetRuntimeOnce(WORKER_VERSION); await containerHealth(runtimeEnv); }
function internalAuthorized(request, runtimeEnv) { return Boolean(runtimeEnv.MAX_BOT_TOKEN) && request.headers.get("X-Internal-Auth") === runtimeEnv.MAX_BOT_TOKEN; }
function filtersFromUrl(url) { return { chat_id: url.searchParams.get("chat_id") || CURRENT_CHAT_ID, from: url.searchParams.get("from") || null, to: url.searchParams.get("to") || null, customer: url.searchParams.get("customer") || null, terminal: url.searchParams.get("terminal") || null, release: url.searchParams.get("release") || null, container_type: url.searchParams.get("container_type") || null }; }

export default {
  async fetch(request, runtimeEnv, ctx) {
    try {
      const url = new URL(request.url); const container = getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE);
      if (url.pathname === "/max-webhook") {
        if (request.method === "GET") return Response.json({ ok: true, webhook: "ready", workerVersion: WORKER_VERSION });
        if (request.method === "POST") { let update = {}; try { update = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); } ctx.waitUntil(processWebhook(runtimeEnv, update).catch((error) => console.error("MAX webhook processing error", error))); return Response.json({ ok: true }); }
        return new Response("Method not allowed", { status: 405 });
      }
      if (url.pathname.startsWith("/ledger")) {
        if (!internalAuthorized(request, runtimeEnv)) return new Response("Forbidden", { status: 403 });
        if (url.pathname === "/ledger/summary" && request.method === "GET") return Response.json(await container.ledgerSummary(filtersFromUrl(url)));
        if (url.pathname === "/ledger/events" && request.method === "GET") return Response.json({ ok: true, events: await container.listLedgerEvents(filtersFromUrl(url)) });
        if (url.pathname === "/ledger/events" && request.method === "POST") { const body = await request.json(); return Response.json(await container.replaceSourceEvents(body?.chat_id, body?.source_mid, body?.events || [])); }
        if (url.pathname === "/ledger/raw" && request.method === "POST") { const body = await request.json(); return Response.json(await container.putRawRecords(body?.records || [])); }
        if (url.pathname === "/ledger/context" && request.method === "GET") return Response.json({ ok: true, records: await container.rawContext(url.searchParams.get("chat_id") || CURRENT_CHAT_ID, Number(url.searchParams.get("limit") || 30)) });
        if (url.pathname === "/ledger/state" && request.method === "GET") return Response.json({ ok: true, state: await container.getBackfillState(url.searchParams.get("chat_id") || CURRENT_CHAT_ID) });
        if (url.pathname === "/ledger/state" && request.method === "POST") { const body = await request.json(); return Response.json({ ok: true, state: await container.setBackfillState(body?.chat_id || CURRENT_CHAT_ID, body?.state || {}) }); }
        if (url.pathname === "/ledger/reset" && request.method === "POST") { const body = await request.json().catch(() => ({})); return Response.json(await container.resetLedger(body?.chat_id || CURRENT_CHAT_ID)); }
        return new Response("Not found", { status: 404 });
      }
      if (url.pathname === "/diagnostic") {
        const [knownChats, recentUpdates, runtime, ledger] = await Promise.all([container.getKnownChats(), container.getRecentUpdates(), container.getRuntimeState(), container.ledgerSummary({ chat_id: CURRENT_CHAT_ID })]);
        ctx.waitUntil((async () => { await container.resetRuntimeOnce(WORKER_VERSION); await containerHealth(runtimeEnv); })().catch((error) => console.error("Background container start error", error)));
        return Response.json({ ok: true, workerVersion: WORKER_VERSION, transport: "webhook", webhookUrl: runtimeEnv.MAX_WEBHOOK_URL || DEFAULT_WEBHOOK_URL, currentChatId: CURRENT_CHAT_ID, registryVersion: CHAT_REGISTRY_VERSION, ledgerSchemaVersion: LEDGER_SCHEMA_VERSION, knownChatCount: knownChats.length, knownChats, recentUpdates, runtime, ledger });
      }
      if (url.pathname === "/diagnostic/full") { const [health, ledger] = await Promise.all([containerHealth(runtimeEnv), container.ledgerSummary({ chat_id: CURRENT_CHAT_ID })]); return Response.json({ ok: true, workerVersion: WORKER_VERSION, currentChatId: CURRENT_CHAT_ID, ledger, container: health }); }
      if (url.pathname === "/state") { if (!internalAuthorized(request, runtimeEnv)) return new Response("Forbidden", { status: 403 }); if (request.method === "GET") return Response.json(await container.getKnownChats()); if (request.method === "POST") return Response.json(await container.setKnownChats(await request.json())); return new Response("Method not allowed", { status: 405 }); }
      return Response.json({ ok: true, workerVersion: WORKER_VERSION, currentChatId: CURRENT_CHAT_ID, ledgerSchemaVersion: LEDGER_SCHEMA_VERSION });
    } catch (error) { console.error("Worker error", error); return Response.json({ ok: false, workerVersion: WORKER_VERSION, error: String(error?.message || error) }, { status: 500 }); }
  },
  async scheduled(_controller, runtimeEnv, ctx) { ctx.waitUntil(pingContainer(runtimeEnv).catch((error) => console.error("Keepalive error", error))); },
};
