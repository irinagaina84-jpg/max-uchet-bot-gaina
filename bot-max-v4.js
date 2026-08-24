import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";

const MAX_API = "https://platform-api2.max.ru";
const OPENAI_API = "https://api.openai.com/v1/responses";
const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-terra";
const PORT = Number(process.env.PORT || 3000);

const russianCa = fs.readFileSync("/app/russian-trusted-root-ca.pem", "utf8");
const maxAgent = new https.Agent({
  ca: [...tls.rootCertificates, russianCa],
  keepAlive: true,
});

const state = {
  startedAt: new Date().toISOString(),
  maxAuthorized: false,
  botName: null,
  polling: false,
  lastUpdateAt: null,
  lastReplyAt: null,
  lastError: null,
  lastMaxStatus: null,
};

const historyByChat = new Map();
const pendingByChat = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error) {
  const bits = [error?.message, error?.code, error?.cause?.message, error?.cause?.code].filter(Boolean);
  return [...new Set(bits)].join(" | ") || String(error);
}

function statusPayload() {
  return {
    ok: true,
    service: "MAX учет бот",
    model: OPENAI_MODEL,
    tokenConfigured: Boolean(MAX_BOT_TOKEN),
    openaiConfigured: Boolean(OPENAI_API_KEY),
    ...state,
  };
}

http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(statusPayload(), null, 2));
}).listen(PORT, "0.0.0.0", () => console.log(`Health server listening on ${PORT}`));

function maxRequest(path, { method = "GET", body, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!MAX_BOT_TOKEN) {
      reject(new Error("MAX_BOT_TOKEN is not configured"));
      return;
    }

    const url = new URL(`${MAX_API}${path}`);
    const payload = body == null ? null : JSON.stringify(body);
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method,
      agent: maxAgent,
      headers: {
        Authorization: MAX_BOT_TOKEN,
        Accept: "application/json",
        ...(payload ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        } : {}),
      },
    }, (res) => {
      state.lastMaxStatus = res.statusCode ?? null;
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }
        if ((res.statusCode || 500) >= 400) {
          reject(new Error(`MAX ${res.statusCode}: ${data?.message || data?.error || data?.raw || "request failed"}`));
          return;
        }
        resolve(data);
      });
    });

    req.setTimeout(timeout, () => req.destroy(new Error(`MAX request timeout after ${timeout}ms`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
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

function buildInput(chatKey, text) {
  const history = trimHistory(historyByChat.get(chatKey) || []);
  const context = history.map((x) => `${x.role === "user" ? "Пользователь" : "Бот"}: ${x.content}`).join("\n\n");
  return `${SYSTEM_PROMPT}\n\n${context ? `Контекст предыдущих сообщений:\n${context}\n\n` : ""}Новые данные пользователя:\n${text}`;
}

function extractOpenAIText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const parts = [];
  for (const item of data?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item?.content || []) {
      if ((content?.type === "output_text" || content?.type === "text") && content?.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

async function askOpenAI(chatKey, text) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const response = await fetch(OPENAI_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: OPENAI_MODEL, input: buildInput(chatKey, text) }),
    signal: AbortSignal.timeout(90000),
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { raw }; }
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${data?.error?.message || data?.raw || response.statusText}`);
  const answer = extractOpenAIText(data);
  if (!answer) throw new Error("OpenAI returned an empty response");
  return answer;
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
    const answer = await askOpenAI(chatKey, joined);
    const history = historyByChat.get(chatKey) || [];
    history.push({ role: "user", content: joined }, { role: "assistant", content: answer });
    historyByChat.set(chatKey, trimHistory(history));
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
      state.lastError = null;
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
