import { env } from "cloudflare:workers";
import { Container, getContainer } from "@cloudflare/containers";

const CONTAINER_INSTANCE = "production";
const PUBLIC_BASE = "https://max-uchet-bot-gaina.irina-gaina-84-036.workers.dev";
const DEFAULT_STATE_URL = `${PUBLIC_BASE}/state`;
const DEFAULT_WEBHOOK_URL = `${PUBLIC_BASE}/max-webhook`;
const CHAT_REGISTRY_VERSION = 5;
const WORKER_VERSION = "worker-v40-fresh-scope";
const STALE_CHAT_IDS = new Set(["-77765742260432"]);

function isStaleChatId(value) {
  return STALE_CHAT_IDS.has(String(value ?? ""));
}

export class MaxBotContainer extends Container {
  defaultPort = 3000;
  sleepAfter = "10m";
  envVars = {
    MAX_BOT_TOKEN: env.MAX_BOT_TOKEN,
    GIGACHAT_AUTH_KEY: env.GIGACHAT_AUTH_KEY,
    GIGACHAT_SCOPE: env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
    GIGACHAT_MODEL: env.GIGACHAT_MODEL || "GigaChat-3-Ultra",
    REPORT_USER_ID: env.REPORT_USER_ID || "",
    WATCH_CHAT_IDS: "",
    ACCOUNTING_TZ_OFFSET_MINUTES: env.ACCOUNTING_TZ_OFFSET_MINUTES || "300",
    STATE_URL: env.STATE_URL || DEFAULT_STATE_URL,
    MAX_WEBHOOK_URL: env.MAX_WEBHOOK_URL || DEFAULT_WEBHOOK_URL,
    PORT: "3000",
  };

  async ensureRegistryVersion() {
    const current = await this.ctx.storage.get("chat_registry_version");
    if (current !== CHAT_REGISTRY_VERSION) {
      await this.ctx.storage.put("chat_registry_version", CHAT_REGISTRY_VERSION);
      await this.ctx.storage.put("known_chats", []);
      await this.ctx.storage.put("recent_updates", []);
    }
  }

  async getKnownChats() {
    await this.ensureRegistryVersion();
    const current = (await this.ctx.storage.get("known_chats")) || [];
    const filtered = current.filter((x) => !isStaleChatId(x?.chat_id));
    if (filtered.length !== current.length) await this.ctx.storage.put("known_chats", filtered);
    return filtered;
  }

  async setKnownChats(chats) {
    await this.ensureRegistryVersion();
    const safe = (Array.isArray(chats) ? chats : [])
      .filter((x) => !isStaleChatId(x?.chat_id))
      .slice(0, 500);
    await this.ctx.storage.put("known_chats", safe);
    return { ok: true, count: safe.length };
  }

  async rememberChat(chatId, title = null) {
    if (chatId == null || isStaleChatId(chatId)) return { ok: false, ignored: true };
    const id = String(chatId);
    const chats = await this.getKnownChats();
    const previous = chats.find((x) => String(x?.chat_id) === id);
    const next = chats.filter((x) => String(x?.chat_id) !== id);
    next.push({ chat_id: id, title: title || previous?.title || `чат ${id}`, lastSeenAt: Date.now() });
    await this.ctx.storage.put("known_chats", next.slice(-500));
    return { ok: true, count: next.length };
  }

  async forgetChat(chatId) {
    if (chatId == null) return { ok: true };
    const id = String(chatId);
    const chats = await this.getKnownChats();
    const next = chats.filter((x) => String(x?.chat_id) !== id);
    await this.ctx.storage.put("known_chats", next);
    return { ok: true, count: next.length };
  }

  async rememberUpdate(update) {
    await this.ensureRegistryVersion();
    const existing = (await this.ctx.storage.get("recent_updates")) || [];
    const item = {
      at: Date.now(),
      update_type: String(update?.update_type || ""),
      chat_id: update?.chat_id ?? update?.message?.recipient?.chat_id ?? null,
      recipient_type: update?.message?.recipient?.chat_type ?? update?.message?.recipient?.type ?? null,
    };
    await this.ctx.storage.put("recent_updates", [...existing, item].slice(-20));
  }

  async getRecentUpdates() {
    await this.ensureRegistryVersion();
    return (await this.ctx.storage.get("recent_updates")) || [];
  }

  async getRuntimeState() {
    return { running: Boolean(this.ctx.container.running), workerVersion: WORKER_VERSION };
  }

  async resetRuntimeOnce(version) {
    const key = "runtime_reset_version";
    const current = await this.ctx.storage.get(key);
    if (current === version) return { reset: false, running: Boolean(this.ctx.container.running) };
    await this.ctx.storage.put(key, version);
    const wasRunning = Boolean(this.ctx.container.running);
    if (wasRunning) await this.destroy();
    return { reset: true, wasRunning };
  }
}

function eventChatId(update) {
  return update?.chat_id ?? update?.message?.recipient?.chat_id ?? null;
}

function isGroupMessageUpdate(update) {
  const type = String(update?.message?.recipient?.chat_type || update?.message?.recipient?.type || "").toLowerCase();
  return type === "chat" || type === "channel";
}

async function processWebhook(runtimeEnv, update) {
  const container = getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE);
  const chatId = eventChatId(update);
  const type = String(update?.update_type || "");

  await container.rememberUpdate(update);

  if (type === "bot_removed" && chatId != null) {
    await container.forgetChat(chatId);
  } else if (type === "bot_added" && chatId != null) {
    await container.rememberChat(chatId, null);
  } else if (type === "chat_title_changed" && chatId != null) {
    await container.rememberChat(chatId, update?.title || null);
  } else if (["message_created", "message_edited", "message_removed"].includes(type) && chatId != null && isGroupMessageUpdate(update)) {
    await container.rememberChat(chatId, null);
  }

  try {
    await container.fetch(new Request("http://container/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update || {}),
    }));
  } catch (error) {
    console.error("Container webhook delivery deferred", error);
  }
}

async function containerHealth(runtimeEnv) {
  const container = getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE);
  const response = await container.fetch(new Request("http://container/health"));
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { ok: false, raw: text }; }
}

async function pingContainer(runtimeEnv) {
  const container = getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE);
  await container.resetRuntimeOnce(WORKER_VERSION);
  await containerHealth(runtimeEnv);
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    try {
      const url = new URL(request.url);
      const container = getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE);

      if (url.pathname === "/max-webhook") {
        if (request.method === "GET") return Response.json({ ok: true, webhook: "ready", workerVersion: WORKER_VERSION });
        if (request.method === "POST") {
          let update = {};
          try { update = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); }
          ctx.waitUntil(processWebhook(runtimeEnv, update).catch((error) => console.error("MAX webhook processing error", error)));
          return Response.json({ ok: true });
        }
        return new Response("Method not allowed", { status: 405 });
      }

      if (url.pathname === "/diagnostic") {
        const [knownChats, recentUpdates, runtime] = await Promise.all([
          container.getKnownChats(),
          container.getRecentUpdates(),
          container.getRuntimeState(),
        ]);
        ctx.waitUntil((async () => {
          await container.resetRuntimeOnce(WORKER_VERSION);
          await containerHealth(runtimeEnv);
        })().catch((error) => console.error("Background container start error", error)));
        return Response.json({
          ok: true,
          workerVersion: WORKER_VERSION,
          transport: "webhook",
          webhookUrl: runtimeEnv.MAX_WEBHOOK_URL || DEFAULT_WEBHOOK_URL,
          maxApiTransport: "trusted-container",
          staleChatFilter: [...STALE_CHAT_IDS],
          registryVersion: CHAT_REGISTRY_VERSION,
          knownChatCount: knownChats.length,
          knownChats,
          recentUpdates,
          runtime,
        });
      }

      if (url.pathname === "/diagnostic/full") {
        const health = await containerHealth(runtimeEnv);
        return Response.json({ ok: true, workerVersion: WORKER_VERSION, container: health });
      }

      if (url.pathname === "/state") {
        if (request.headers.get("X-Internal-Auth") !== runtimeEnv.MAX_BOT_TOKEN) return new Response("Forbidden", { status: 403 });
        if (request.method === "GET") return Response.json(await container.getKnownChats());
        if (request.method === "POST") return Response.json(await container.setKnownChats(await request.json()));
        return new Response("Method not allowed", { status: 405 });
      }

      return Response.json({ ok: true, workerVersion: WORKER_VERSION });
    } catch (error) {
      console.error("Worker error", error);
      return Response.json({ ok: false, workerVersion: WORKER_VERSION, error: String(error?.message || error) }, { status: 500 });
    }
  },

  async scheduled(_controller, runtimeEnv, ctx) {
    ctx.waitUntil(pingContainer(runtimeEnv).catch((error) => console.error("Keepalive error", error)));
  },
};
