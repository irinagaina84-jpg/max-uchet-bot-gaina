import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const MAX_API = "https://platform-api2.max.ru";
const GIGA_AUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const GIGA_API = "https://api.giga.chat";

const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN || "";
const GIGACHAT_AUTH_KEY = process.env.GIGACHAT_AUTH_KEY || "";
const GIGACHAT_SCOPE = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS";
const GIGACHAT_MODEL = process.env.GIGACHAT_MODEL || "GigaChat-3-Ultra";
const PORT = Number(process.env.PORT || 3000);

const russianCa = fs.readFileSync("/app/russian-trusted-root-ca.pem", "utf8");
const trustedAgent = new https.Agent({
  ca: [...tls.rootCertificates, russianCa],
  keepAlive: true,
});

const state = {
  startedAt: new Date().toISOString(),
  provider: "GigaChat",
  model: GIGACHAT_MODEL,
  maxAuthorized: false,
  botName: null,
  polling: false,
  gigachatConfigured: Boolean(GIGACHAT_AUTH_KEY),
  gigachatAuthorized: false,
  gigachatTokenExpiresAt: null,
  lastUpdateAt: null,
  lastReplyAt: null,
  lastError: null,
  lastMaxStatus: null,
  lastGigaStatus: null,
};

const historyByChat = new Map();
const pendingByChat = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let gigaAccessToken = null;
let gigaAccessExpiresAtMs = 0;

function errorText(error) {
  const bits = [error?.message, error?.code, error?.cause?.message, error?.cause?.code].filter(Boolean);
  return [...new Set(bits)].join(" | ") || String(error);
}

function statusPayload() {
  return {
    ok: true,
    service: "MAX учет бот",
    tokenConfigured: Boolean(MAX_BOT_TOKEN),
    ...state,
  };
}

http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(statusPayload(), null, 2));
}).listen(PORT, "0.0.0.0", () => console.log(`Health server listening on ${PORT}`));

function httpsJson(urlString, { method = "GET", headers = {}, body = null, timeout = 45000, agent = trustedAgent } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = body == null ? null : Buffer.from(body);
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method,
      agent,
      headers: {
        ...headers,
        ...(payload ? { "Content-Length": payload.length } : {}),
      },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }
        const status = res.statusCode || 500;
        if (status >= 400) {
          const detail = data?.message || data?.error?.message || data?.error || data?.raw || res.statusMessage || "request failed";
          reject(new Error(`${status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`));
          return;
        }
        resolve({ status, data, headers: res.headers });
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`request timeout after ${timeout}ms`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function maxRequest(path, { method = "GET", body, timeout = 45000 } = {}) {
  if (!MAX_BOT_TOKEN) throw new Error("MAX_BOT_TOKEN is not configured");
  const result = await httpsJson(`${MAX_API}${path}`, {
    method,
    timeout,
    headers: {
      Authorization: MAX_BOT_TOKEN,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : null,
  });
  state.lastMaxStatus = result.status;
  return result.data;
}

async function getGigaAccessToken(force = false) {
  if (!GIGACHAT_AUTH_KEY) throw new Error("GIGACHAT_AUTH_KEY is not configured");
  if (!force && gigaAccessToken && Date.now() < gigaAccessExpiresAtMs - 60000) return gigaAccessToken;

  const form = new URLSearchParams({ scope: GIGACHAT_SCOPE }).toString();
  const result = await httpsJson(GIGA_AUTH_URL, {
    method: "POST",
    timeout: 30000,
    headers: {
      Authorization: `Basic ${GIGACHAT_AUTH_KEY}`,
      RqUID: randomUUID(),
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  state.lastGigaStatus = result.status;
  const token = result.data?.access_token;
  const expiresAtSeconds = Number(result.data?.expires_at || 0);
  if (!token) throw new Error("GigaChat did not return access_token");
  gigaAccessToken = token;
  gigaAccessExpiresAtMs = expiresAtSeconds > 1000000000 ? expiresAtSeconds * 1000 : Date.now() + 29 * 60 * 1000;
  state.gigachatAuthorized = true;
  state.gigachatTokenExpiresAt = new Date(gigaAccessExpiresAtMs).toISOString();
  return token;
}

async function gigaRequest(path, payload) {
  let token = await getGigaAccessToken(false);
  try {
    const result = await httpsJson(`${GIGA_API}${path}`, {
      method: "POST",
      timeout: 90000,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    state.lastGigaStatus = result.status;
    return result.data;
  } catch (error) {
    if (String(error?.message || "").startsWith("401:")) {
      token = await getGigaAccessToken(true);
      const retry = await httpsJson(`${GIGA_API}${path}`, {
        method: "POST",
        timeout: 90000,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      state.lastGigaStatus = retry.status;
      return retry.data;
    }
    throw error;
  }
}

async function clearWebhookSubscriptions() {
  try {
    const data = await maxRequest("/subscriptions");
    for (const sub of Array.isArray(data?.subscriptions) ? data.subscriptions : []) {
      if (!sub?.url) continue;
      await maxRequest(`/subscriptions?url=${encodeURIComponent(sub.url)}`, { method: "DELETE" }).catch(() => {});
    }
  } catch (error) {
    console.warn("Webhook cleanup skipped:", errorText(error));
  }
}

function getChatKey(update) {
  const m = update?.message;
  return String(m?.recipient?.chat_id ?? m?.sender?.user_id ?? update?.chat_id ?? update?.user?.user_id ?? "unknown");
}

function trimHistory(items) {
  const out = [];
  let chars = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    chars += items[i].content.length;
    if (chars > 24000 || out.length >= 18) break;
    out.unshift(items[i]);
  }
  return out;
}

const SYSTEM_PROMPT = `Ты рабочий бот по учету морских контейнеров. Отвечай по-русски, коротко и точно.
Основные задачи:
- распознавать терминалы, количество, типы 20/40 фут, номера контейнеров;
- считать выдачи, остатки, бронь, оплаты и общие итоги;
- не задваивать одинаковые номера контейнеров;
- если данные противоречат друг другу, явно показать расхождение;
- арифметику перепроверять перед ответом;
- ничего не придумывать: если данных не хватает, так и написать.
Если пользователь присылает большой список, сначала структурируй его, затем дай итог. Если присылает продолжение, учитывай предыдущий контекст диалога.`;

async function askGigaChat(chatKey, text) {
  const history = trimHistory(historyByChat.get(chatKey) || []);
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((x) => ({ role: x.role, content: x.content })),
    { role: "user", content: text },
  ];
  const data = await gigaRequest("/v1/chat/completions", {
    model: GIGACHAT_MODEL,
    messages,
    stream: false,
  });
  const answer = data?.choices?.[0]?.message?.content;
  if (!answer || typeof answer !== "string") throw new Error("GigaChat returned an empty response");
  return answer.trim();
}

function splitMessage(text, limit = 3900) {
  const chunks = [];
  let rest = String(text || "").trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendMessage(message, text) {
  const chatId = message?.recipient?.chat_id;
  const userId = message?.sender?.user_id;
  const q = chatId != null ? `chat_id=${encodeURIComponent(chatId)}` : `user_id=${encodeURIComponent(userId)}`;
  for (const chunk of splitMessage(text)) {
    await maxRequest(`/messages?${q}`, { method: "POST", body: { text: chunk } });
  }
  state.lastReplyAt = new Date().toISOString();
}

async function flushChat(chatKey) {
  const pending = pendingByChat.get(chatKey);
  if (!pending) return;
  pendingByChat.delete(chatKey);
  const joined = pending.texts.join("\n");
  const normalized = joined.trim().toLowerCase();

  try {
    if (["/reset", "reset", "сброс", "сбросить"].includes(normalized)) {
      historyByChat.delete(chatKey);
      await sendMessage(pending.message, "Контекст сброшен. Присылай новые данные.");
      return;
    }
    const answer = await askGigaChat(chatKey, joined);
    const history = historyByChat.get(chatKey) || [];
    history.push({ role: "user", content: joined }, { role: "assistant", content: answer });
    historyByChat.set(chatKey, trimHistory(history));
    state.lastError = null;
    await sendMessage(pending.message, answer);
  } catch (error) {
    state.lastError = `Processing: ${errorText(error)}`;
    console.error(state.lastError);
    await sendMessage(pending.message, `Ошибка обработки: ${error.message}`).catch(() => {});
  }
}

function queueMessage(update) {
  const m = update?.message;
  const text = m?.body?.text;
  if (!text || typeof text !== "string" || m?.sender?.is_bot) return;
  state.lastUpdateAt = new Date().toISOString();
  const chatKey = getChatKey(update);
  const existing = pendingByChat.get(chatKey);
  if (existing?.timer) clearTimeout(existing.timer);
  const pending = existing || { texts: [], message: m };
  pending.texts.push(text);
  pending.message = m;
  pending.timer = setTimeout(() => void flushChat(chatKey), 1200);
  pendingByChat.set(chatKey, pending);
}

async function handleUpdate(update) {
  if (update?.update_type === "message_created") queueMessage(update);
  if (update?.update_type === "bot_started" && update.user?.user_id != null) {
    await maxRequest(`/messages?user_id=${encodeURIComponent(update.user.user_id)}`, {
      method: "POST",
      body: { text: "Готов. Присылай данные по контейнерам — посчитаю и сведу итоги." },
    }).catch((error) => { state.lastError = `Welcome: ${errorText(error)}`; });
  }
}

async function pollForever() {
  let marker = null;
  let first = true;
  state.polling = true;
  while (true) {
    try {
      const p = new URLSearchParams({ limit: "100", timeout: "30", types: "message_created,bot_started" });
      if (!first && marker != null) p.set("marker", String(marker));
      const data = await maxRequest(`/updates?${p}`, { timeout: 40000 });
      first = false;
      if (data?.marker != null) marker = data.marker;
      for (const update of data?.updates || []) await handleUpdate(update);
    } catch (error) {
      state.lastError = `Polling: ${errorText(error)}`;
      console.error(state.lastError);
      await sleep(3000);
    }
  }
}

async function connectLoop() {
  while (true) {
    try {
      state.lastError = "Connecting to MAX...";
      const me = await maxRequest("/me", { timeout: 12000 });
      state.maxAuthorized = true;
      state.botName = me?.username || me?.first_name || String(me?.user_id || "MAX bot");
      state.lastError = null;
      console.log(`MAX bot authorized: ${state.botName}`);
      await clearWebhookSubscriptions();
      if (GIGACHAT_AUTH_KEY) {
        try { await getGigaAccessToken(false); } catch (e) { state.lastError = `GigaChat auth: ${errorText(e)}`; }
      }
      await pollForever();
    } catch (error) {
      state.maxAuthorized = false;
      state.polling = false;
      state.lastError = `Startup: ${errorText(error)}`;
      console.error(state.lastError);
      await sleep(5000);
    }
  }
}

void connectLoop();
