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
  return s.replace(/\s+/g, "");
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
  gigachatTokenExpiresAt: null,
  imageReading: true,
  groupHistoryReading: true,
  lastGroupChatId: null,
  lastAttachmentTypes: [],
  lastImageAt: null,
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

function httpsJson(urlString, { method = "GET", headers = {}, body = null, timeout = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
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
        resolve({ status, data, headers: res.headers });
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`request timeout after ${timeout}ms`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function downloadBuffer(urlString, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects while downloading image"));
    const url = new URL(urlString);
    const client = url.protocol === "http:" ? http : https;
    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "http:" ? 80 : 443),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { "User-Agent": "max-uchet-bot/1.0", Accept: "image/*,*/*" },
      ...(url.protocol === "https:" ? { agent: trustedAgent } : {}),
    };
    const req = client.request(options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(downloadBuffer(next, redirects + 1));
        return;
      }
      if ((res.statusCode || 500) >= 400) {
        res.resume();
        reject(new Error(`image download HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) req.destroy(new Error("image is larger than 16 MB"));
        else chunks.push(chunk);
      });
      res.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType: String(res.headers["content-type"] || "image/jpeg").split(";")[0] }));
    });
    req.setTimeout(45000, () => req.destroy(new Error("image download timeout")));
    req.on("error", reject);
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

function authCandidates() {
  const list = [];
  if (GIGA_KEY) list.push({ mode: "basic-as-copied", header: `Basic ${GIGA_KEY}` });
  if (GIGA_KEY.includes(":")) list.push({ mode: "basic-encoded-pair", header: `Basic ${Buffer.from(GIGA_KEY, "utf8").toString("base64")}` });
  if (GIGA_KEY) list.push({ mode: "bearer-as-copied", header: `Bearer ${GIGA_KEY}` });
  if (GIGA_KEY && !keyLooksBase64Pair && !GIGA_KEY.includes(":")) list.push({ mode: "basic-encoded-raw", header: `Basic ${Buffer.from(GIGA_KEY, "utf8").toString("base64")}` });
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
      const result = await httpsJson(GIGA_AUTH_URL, {
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
      const token = result.data?.access_token;
      if (!token) throw new Error("GigaChat did not return access_token");
      const expiresAt = Number(result.data?.expires_at || 0);
      gigaAccessToken = token;
      gigaAccessExpiresAtMs = expiresAt > 1e12 ? expiresAt : expiresAt > 1e9 ? expiresAt * 1000 : Date.now() + 29 * 60 * 1000;
      state.lastGigaStatus = result.status;
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
    const result = await httpsJson(`${GIGA_API}${path}`, {
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
      const retry = await httpsJson(`${GIGA_API}${path}`, {
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

async function uploadImageToGiga(buffer, contentType = "image/jpeg") {
  const token = await getGigaAccessToken(false);
  const boundary = `----maxbot${randomUUID().replaceAll("-", "")}`;
  const extension = contentType.includes("png") ? "png" : contentType.includes("tiff") ? "tiff" : contentType.includes("bmp") ? "bmp" : "jpg";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\ngeneral\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="release.${extension}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buffer, tail]);
  const result = await httpsJson(`${GIGA_API}/v1/files`, {
    method: "POST",
    timeout: 90000,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const id = result.data?.id;
  if (!id) throw new Error("GigaChat file upload did not return id");
  return id;
}

function messageImageUrls(message) {
  const attachments = Array.isArray(message?.body?.attachments) ? message.body.attachments : [];
  const urls = [];
  for (const attachment of attachments) {
    if (attachment?.type !== "image") continue;
    const direct = attachment?.payload?.url;
    if (typeof direct === "string" && /^https?:\/\//i.test(direct)) urls.push(direct);
  }
  return [...new Set(urls)];
}

function isGroupMessage(message) {
  const type = String(message?.recipient?.chat_type || "").toLowerCase();
  return type && type !== "dialog";
}

async function recentChatMessages(chatId, count = 50) {
  const q = new URLSearchParams({ chat_id: String(chatId), count: String(Math.max(1, Math.min(100, count))) });
  const data = await maxRequest(`/messages?${q}`);
  return Array.isArray(data?.messages) ? data.messages : [];
}

function latestImageMessage(messages, currentMid) {
  for (const msg of messages) {
    if (currentMid && msg?.body?.mid === currentMid) continue;
    if (messageImageUrls(msg).length) return msg;
  }
  return null;
}

const SYSTEM = `Ты аналитик учета морских контейнеров. Отвечай по-русски, точно и без домыслов.
Главный разрез учета: КЛИЕНТ -> ТЕРМИНАЛ -> ТИП КОНТЕЙНЕРА -> КОЛИЧЕСТВО/НОМЕРА.
Релиз сам по себе НЕ означает фактическую выдачу. Фактом выдачи считай только явный смысл: выдали, забрали, выпустили, машина увезла и аналогичные подтверждения.
Отмены, исправления, переносы и фразы «не считать», «это не этому клиенту» должны отменять или корректировать прежний факт, а не создавать новый.
При чтении релиза со скрина извлекай только то, что реально видно: клиент (если указан), терминал, тип 20DC/40HC, количество, номера контейнеров, даты/окно, получателя/водителя если есть. Если поле не видно — пиши «не определено».`;

async function analyzeImageUrls(urls, extraPrompt = "") {
  const selected = urls.slice(0, 10);
  if (!selected.length) throw new Error("В последнем релизе не найдено изображение");
  const uploaded = [];
  for (const url of selected) {
    const { buffer, contentType } = await downloadBuffer(url);
    uploaded.push(await uploadImageToGiga(buffer, contentType));
  }
  const messages = [{ role: "system", content: SYSTEM }];
  uploaded.forEach((id, index) => {
    messages.push({
      role: "user",
      content: index === 0
        ? `Прочитай этот релиз со скрина. ${extraPrompt}\nВерни структурированно: клиент; терминал; тип контейнера; количество; номера контейнеров; дата/окно; что это означает (релиз/выдача/другое). Не придумывай отсутствующие данные.`
        : "Это продолжение того же релиза. Учти изображение вместе с предыдущим.",
      attachments: [id],
    });
  });
  const data = await gigaRequest("/v1/chat/completions", { model: GIGA_MODEL, messages, stream: false });
  const answer = data?.choices?.[0]?.message?.content;
  if (!answer) throw new Error("GigaChat returned an empty image analysis");
  return String(answer).trim();
}

async function askGiga(key, text) {
  const history = historyByChat.get(key) || [];
  const short = history.slice(-16);
  const data = await gigaRequest("/v1/chat/completions", {
    model: GIGA_MODEL,
    messages: [{ role: "system", content: SYSTEM }, ...short, { role: "user", content: text }],
    stream: false,
  });
  const answer = data?.choices?.[0]?.message?.content;
  if (!answer) throw new Error("GigaChat returned an empty response");
  history.push({ role: "user", content: text }, { role: "assistant", content: String(answer).trim() });
  historyByChat.set(key, history.slice(-18));
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

function looksLikeReleaseCommand(text) {
  const s = String(text || "").toLowerCase();
  return s.includes("разбери последний релиз") || s.includes("прочитай последний релиз") || s.includes("что в последнем релизе") || s.includes("разбери релиз выше");
}

async function handleGroupMessage(message) {
  const chatId = message?.recipient?.chat_id;
  if (chatId == null) return;
  state.lastGroupChatId = String(chatId);
  const types = (message?.body?.attachments || []).map((x) => x?.type).filter(Boolean);
  state.lastAttachmentTypes = types;
  if (types.includes("image")) state.lastImageAt = new Date().toISOString();

  const text = String(message?.body?.text || "").trim();
  if (!looksLikeReleaseCommand(text)) return; // group is read silently unless explicitly asked

  try {
    const history = await recentChatMessages(chatId, 50);
    const imageMessage = latestImageMessage(history, message?.body?.mid);
    if (!imageMessage) {
      await sendMessage(message, "Я вижу этот групповой чат, но среди последних 50 сообщений не нашёл изображения релиза.");
      return;
    }
    const urls = messageImageUrls(imageMessage);
    const result = await analyzeImageUrls(urls, `Команда пользователя: ${text}`);
    state.lastError = null;
    await sendMessage(message, result);
  } catch (e) {
    state.lastError = `Group image analysis: ${errText(e)}`;
    await sendMessage(message, `Не смог прочитать релиз: ${e.message}`).catch(() => {});
  }
}

function privateChatKey(message) {
  return String(message?.recipient?.chat_id ?? message?.sender?.user_id ?? "private");
}

async function handlePrivateMessage(message) {
  const text = String(message?.body?.text || "").trim();
  const urls = messageImageUrls(message);
  if (!text && !urls.length) return;
  try {
    let answer;
    if (urls.length) answer = await analyzeImageUrls(urls, text || "Разбери этот релиз");
    else answer = await askGiga(privateChatKey(message), text);
    state.lastError = null;
    await sendMessage(message, answer);
  } catch (e) {
    state.lastError = `Private processing: ${errText(e)}`;
    await sendMessage(message, `Ошибка обработки: ${e.message}`).catch(() => {});
  }
}

async function handleUpdate(update) {
  if (update?.update_type !== "message_created") return;
  const message = update?.message;
  if (!message || message?.sender?.is_bot) return;
  state.lastUpdateAt = new Date().toISOString();
  if (isGroupMessage(message)) await handleGroupMessage(message);
  else await handlePrivateMessage(message);
}

async function clearWebhooks() {
  try {
    const data = await maxRequest("/subscriptions");
    for (const sub of Array.isArray(data?.subscriptions) ? data.subscriptions : []) {
      if (sub?.url) await maxRequest(`/subscriptions?url=${encodeURIComponent(sub.url)}`, { method: "DELETE" }).catch(() => {});
    }
  } catch {}
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
        if (update?.update_type === "message_created") await handleUpdate(update);
        if (update?.update_type === "bot_started" && update.user?.user_id != null) {
          await maxRequest(`/messages?user_id=${encodeURIComponent(update.user.user_id)}`, { method: "POST", body: { text: "Готов. В групповых чатах читаю сообщения молча; команда «Разбери последний релиз» прочитает последний скрин релиза." } }).catch(() => {});
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
