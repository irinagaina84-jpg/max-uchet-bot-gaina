import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const MAX_API = "https://platform-api2.max.ru";
const GIGA_AUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const GIGA_API = "https://api.giga.chat";

const MAX_BOT_TOKEN = (process.env.MAX_BOT_TOKEN || "").trim();
const RAW_GIGA_KEY = process.env.GIGACHAT_AUTH_KEY || "";
const GIGA_SCOPE = (process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS").trim();
const GIGA_MODEL = (process.env.GIGACHAT_MODEL || "GigaChat-3-Ultra").trim();
const PORT = Number(process.env.PORT || 3000);

function cleanAuthKey(value) {
  let s = String(value || "").trim();
  s = s.replace(/^Authorization\s*:\s*/i, "");
  s = s.replace(/^(Basic|Bearer)\s+/i, "");
  s = s.replace(/^["'`]+|["'`]+$/g, "");
  s = s.replace(/\s+/g, "");
  return s;
}

const GIGA_KEY = cleanAuthKey(RAW_GIGA_KEY);
let decodedKey = "";
try { decodedKey = Buffer.from(GIGA_KEY, "base64").toString("utf8"); } catch {}
const keyLooksBase64Pair = decodedKey.includes(":");

const russianCa = fs.readFileSync("/app/russian-trusted-root-ca.pem", "utf8");
const trustedAgent = new https.Agent({ ca: [...tls.rootCertificates, russianCa], keepAlive: true });

const state = {
  startedAt: new Date().toISOString(),
  provider: "GigaChat",
  model: GIGA_MODEL,
  maxAuthorized: false,
  botName: null,
  polling: false,
  gigachatConfigured: Boolean(GIGA_KEY),
  gigachatAuthorized: false,
  gigachatAuthMode: null,
  gigachatKeyLength: GIGA_KEY.length,
  gigachatKeyLooksBase64Pair: keyLooksBase64Pair,
  gigachatTokenExpiresAt: null,
  lastUpdateAt: null,
  lastReplyAt: null,
  lastError: null,
  lastMaxStatus: null,
  lastGigaStatus: null,
};

const historyByChat = new Map();
const pendingByChat = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let gigaAccessToken = null;
let gigaAccessExpiresAtMs = 0;

function errText(error) {
  return [error?.message, error?.code, error?.cause?.message, error?.cause?.code]
    .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" | ") || String(error);
}

http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, service: "MAX учет бот", tokenConfigured: Boolean(MAX_BOT_TOKEN), ...state }, null, 2));
}).listen(PORT, "0.0.0.0");

function httpsRequestJson(urlString, { method = "GET", headers = {}, body = null, timeout = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = body == null ? null : Buffer.from(body);
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method,
      agent: trustedAgent,
      headers: { ...headers, ...(payload ? { "Content-Length": payload.length } : {}) },
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
          const e = new Error(`${status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
          e.status = status;
          e.data = data;
          reject(e);
          return;
        }
        resolve({ status, data });
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
  const result = await httpsRequestJson(`${MAX_API}${path}`, {
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

function authCandidates() {
  const list = [];
  if (GIGA_KEY) list.push({ mode: "basic-as-copied", header: `Basic ${GIGA_KEY}` });
  if (GIGA_KEY.includes(":")) {
    list.push({ mode: "basic-encoded-pair", header: `Basic ${Buffer.from(GIGA_KEY, "utf8").toString("base64")}` });
  }
  if (GIGA_KEY) list.push({ mode: "bearer-as-copied", header: `Bearer ${GIGA_KEY}` });
  if (GIGA_KEY && !keyLooksBase64Pair && !GIGA_KEY.includes(":")) {
    list.push({ mode: "basic-encoded-raw", header: `Basic ${Buffer.from(GIGA_KEY, "utf8").toString("base64")}` });
  }
  const seen = new Set();
  return list.filter((x) => !seen.has(x.header) && seen.add(x.header));
}

async function getGigaAccessToken(force = false) {
  if (!GIGA_KEY) throw new Error("GIGACHAT_AUTH_KEY is not configured");
  if (!force && gigaAccessToken && Date.now() < gigaAccessExpiresAtMs - 60000) return gigaAccessToken;

  const form = new URLSearchParams({ scope: GIGA_SCOPE }).toString();
  const errors = [];
  for (const candidate of authCandidates()) {
    try {
      const result = await httpsRequestJson(GIGA_AUTH_URL, {
        method: "POST",
        timeout: 30000,
        headers: {
          Authorization: candidate.header,
          RqUID: randomUUID(),
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      });
      state.lastGigaStatus = result.status;
      const token = result.data?.access_token;
      if (!token) throw new Error("GigaChat did not return access_token");
      const expiresAt = Number(result.data?.expires_at || 0);
      gigaAccessToken = token;
      gigaAccessExpiresAtMs = expiresAt > 1000000000 ? expiresAt * 1000 : Date.now() + 29 * 60 * 1000;
      state.gigachatAuthorized = true;
      state.gigachatAuthMode = candidate.mode;
      state.gigachatTokenExpiresAt = new Date(gigaAccessExpiresAtMs).toISOString();
      return token;
    } catch (e) {
      errors.push(`${candidate.mode}: ${errText(e)}`);
      state.lastGigaStatus = e?.status || null;
    }
  }
  state.gigachatAuthorized = false;
  throw new Error(`GigaChat authorization failed; ${errors.join("; ")}`);
}

async function gigaRequest(path, payload) {
  let token = await getGigaAccessToken(false);
  try {
    const result = await httpsRequestJson(`${GIGA_API}${path}`, {
      method: "POST",
      timeout: 90000,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.lastGigaStatus = result.status;
    return result.data;
  } catch (e) {
    if (e?.status === 401) {
      token = await getGigaAccessToken(true);
      const retry = await httpsRequestJson(`${GIGA_API}${path}`, {
        method: "POST",
        timeout: 90000,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      state.lastGigaStatus = retry.status;
      return retry.data;
    }
    throw e;
  }
}

async function clearWebhooks() {
  try {
    const data = await maxRequest("/subscriptions");
    for (const sub of Array.isArray(data?.subscriptions) ? data.subscriptions : []) {
      if (sub?.url) await maxRequest(`/subscriptions?url=${encodeURIComponent(sub.url)}`, { method: "DELETE" }).catch(() => {});
    }
  } catch {}
}

function chatKey(update) {
  const m = update?.message;
  return String(m?.recipient?.chat_id ?? m?.sender?.user_id ?? "unknown");
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

const SYSTEM = `Ты рабочий бот по учету морских контейнеров. Отвечай по-русски, коротко и точно.
Распознавай терминалы, количество, типы 20/40 фут и номера контейнеров. Считай выдачи, остатки, бронь, оплаты и общие итоги. Не задваивай одинаковые номера. Если данные противоречат друг другу, явно покажи расхождение. Арифметику перепроверяй. Ничего не придумывай.`;

async function askGiga(key, text) {
  const history = trimHistory(historyByChat.get(key) || []);
  const data = await gigaRequest("/v1/chat/completions", {
    model: GIGA_MODEL,
    messages: [
      { role: "system", content: SYSTEM },
      ...history.map((x) => ({ role: x.role, content: x.content })),
      { role: "user", content: text },
    ],
    stream: false,
  });
  const answer = data?.choices?.[0]?.message?.content;
  if (!answer) throw new Error("GigaChat returned an empty response");
  return String(answer).trim();
}

async function sendMessage(message, text) {
  const chatId = message?.recipient?.chat_id;
  const userId = message?.sender?.user_id;
  const q = chatId != null ? `chat_id=${encodeURIComponent(chatId)}` : `user_id=${encodeURIComponent(userId)}`;
  const chunks = String(text).match(/[\s\S]{1,3900}/g) || [];
  for (const chunk of chunks) await maxRequest(`/messages?${q}`, { method: "POST", body: { text: chunk } });
  state.lastReplyAt = new Date().toISOString();
}

async function flush(key) {
  const pending = pendingByChat.get(key);
  if (!pending) return;
  pendingByChat.delete(key);
  const text = pending.texts.join("\n");
  try {
    const answer = await askGiga(key, text);
    const history = historyByChat.get(key) || [];
    history.push({ role: "user", content: text }, { role: "assistant", content: answer });
    historyByChat.set(key, trimHistory(history));
    state.lastError = null;
    await sendMessage(pending.message, answer);
  } catch (e) {
    state.lastError = `Processing: ${errText(e)}`;
    await sendMessage(pending.message, `Ошибка обработки: ${e.message}`).catch(() => {});
  }
}

function queue(update) {
  const m = update?.message;
  const text = m?.body?.text;
  if (!text || m?.sender?.is_bot) return;
  state.lastUpdateAt = new Date().toISOString();
  const key = chatKey(update);
  const current = pendingByChat.get(key);
  if (current?.timer) clearTimeout(current.timer);
  const pending = current || { texts: [], message: m };
  pending.texts.push(text);
  pending.message = m;
  pending.timer = setTimeout(() => void flush(key), 800);
  pendingByChat.set(key, pending);
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
      for (const update of data?.updates || []) {
        if (update?.update_type === "message_created") queue(update);
        if (update?.update_type === "bot_started" && update.user?.user_id != null) {
          await maxRequest(`/messages?user_id=${encodeURIComponent(update.user.user_id)}`, { method: "POST", body: { text: "Готов. Присылай данные по контейнерам." } }).catch(() => {});
        }
      }
    } catch (e) {
      state.lastError = `Polling: ${errText(e)}`;
      await sleep(3000);
    }
  }
}

async function start() {
  while (true) {
    try {
      const me = await maxRequest("/me", { timeout: 12000 });
      state.maxAuthorized = true;
      state.botName = me?.username || me?.first_name || String(me?.user_id || "MAX bot");
      await clearWebhooks();
      try { await getGigaAccessToken(false); state.lastError = null; }
      catch (e) { state.lastError = `GigaChat auth: ${errText(e)}`; }
      await pollForever();
    } catch (e) {
      state.maxAuthorized = false;
      state.polling = false;
      state.lastError = `Startup: ${errText(e)}`;
      await sleep(5000);
    }
  }
}

void start();
