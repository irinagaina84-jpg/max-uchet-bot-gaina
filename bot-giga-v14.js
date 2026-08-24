import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import sharp from "sharp";
import { randomUUID } from "node:crypto";

const MAX_API = "https://platform-api2.max.ru";
const GIGA_AUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const GIGA_API = "https://api.giga.chat";
const MAX_BOT_TOKEN = (process.env.MAX_BOT_TOKEN || "").trim();
const RAW_GIGA_KEY = process.env.GIGACHAT_AUTH_KEY || "";
const GIGA_SCOPE = (process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS").trim();
const GIGA_MODEL = (process.env.GIGACHAT_MODEL || "GigaChat-3-Ultra").trim();
const PORT = Number(process.env.PORT || 3000);
const TZ_OFFSET_MINUTES = Number(process.env.ACCOUNTING_TZ_OFFSET_MINUTES || 300);
const SEEDED_CHAT_IDS = (process.env.WATCH_CHAT_IDS || "-77765742260432").split(",").map((x) => x.trim()).filter(Boolean);

function cleanKey(v) {
  let s = String(v || "").trim();
  s = s.replace(/^Authorization\s*:\s*/i, "");
  s = s.replace(/^(Basic|Bearer)\s+/i, "");
  s = s.replace(/^["'`]+|["'`]+$/g, "");
  return s.replace(/\s+/g, "");
}
const GIGA_KEY = cleanKey(RAW_GIGA_KEY);
let decodedKey = "";
try { decodedKey = Buffer.from(GIGA_KEY, "base64").toString("utf8"); } catch {}
const keyLooksPair = decodedKey.includes(":");

const russianCa = fs.readFileSync("/app/russian-trusted-root-ca.pem", "utf8");
const agent = new https.Agent({ ca: [...tls.rootCertificates, russianCa], keepAlive: true });

let gigaToken = null;
let gigaExpiresAt = 0;
let reportUserId = (process.env.REPORT_USER_ID || "").trim() || null;
const knownGroups = new Map(SEEDED_CHAT_IDS.map((id) => [String(id), { title: `чат ${id}`, lastSeenAt: 0 }]));
const imageCache = new Map();
const privateDialog = [];

const state = {
  startedAt: new Date().toISOString(),
  version: "v14-semantic-events",
  maxAuthorized: false,
  polling: false,
  gigachatAuthorized: false,
  silentGroupMode: true,
  multiChat: true,
  semanticConversationUnderstanding: true,
  structuredEventExtraction: true,
  clearAnswerMode: true,
  imageReading: true,
  knownGroupCount: knownGroups.size,
  lastGroupChatId: null,
  lastGroupName: null,
  lastHistoryMessages: 0,
  lastHistoryImages: 0,
  lastHistoryChats: 0,
  lastExtractedEvents: 0,
  lastError: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => [e?.message, e?.code, e?.cause?.message].filter(Boolean).join(" | ") || String(e);

http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, service: "MAX учет бот", ...state }, null, 2));
}).listen(PORT, "0.0.0.0");

function requestJson(urlString, { method = "GET", headers = {}, body = null, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method,
      agent,
      headers: { ...headers, ...(payload ? { "Content-Length": payload.length } : {}) },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => raw += c);
      res.on("end", () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }
        const status = res.statusCode || 500;
        if (status >= 400) {
          const detail = data?.message || data?.error?.message || data?.error || data?.raw || res.statusMessage || "request failed";
          const e = new Error(`${status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
          e.status = status;
          reject(e);
          return;
        }
        resolve({ status, data, headers: res.headers });
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`timeout ${timeout}ms`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function download(urlString, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    const url = new URL(urlString);
    const req = https.request({ hostname: url.hostname, port: url.port || 443, path: `${url.pathname}${url.search}`, method: "GET", agent, headers: { Accept: "image/*,*/*" } }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode || 0) && res.headers.location) {
        res.resume(); resolve(download(new URL(res.headers.location, url).toString(), redirects + 1)); return;
      }
      if ((res.statusCode || 500) >= 400) { res.resume(); reject(new Error(`image HTTP ${res.statusCode}`)); return; }
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > 20 * 1024 * 1024) req.destroy(new Error("image too large")); else chunks.push(c); });
      res.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType: String(res.headers["content-type"] || "image/jpeg").split(";")[0].toLowerCase() }));
    });
    req.setTimeout(45000, () => req.destroy(new Error("image timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function maxRequest(path, options = {}) {
  const r = await requestJson(`${MAX_API}${path}`, {
    ...options,
    headers: { Authorization: MAX_BOT_TOKEN, Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : null,
  });
  return r.data;
}

function authCandidates() {
  const a = [];
  if (GIGA_KEY) a.push(`Basic ${GIGA_KEY}`);
  if (GIGA_KEY.includes(":")) a.push(`Basic ${Buffer.from(GIGA_KEY).toString("base64")}`);
  if (GIGA_KEY) a.push(`Bearer ${GIGA_KEY}`);
  if (GIGA_KEY && !keyLooksPair && !GIGA_KEY.includes(":")) a.push(`Basic ${Buffer.from(GIGA_KEY).toString("base64")}`);
  return [...new Set(a)];
}

async function getGigaToken(force = false) {
  if (!force && gigaToken && Date.now() < gigaExpiresAt - 60000) return gigaToken;
  const form = new URLSearchParams({ scope: GIGA_SCOPE }).toString();
  const errors = [];
  for (const authorization of authCandidates()) {
    try {
      const r = await requestJson(GIGA_AUTH_URL, { method: "POST", headers: { Authorization: authorization, RqUID: randomUUID(), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: form, timeout: 30000 });
      gigaToken = r.data?.access_token;
      if (!gigaToken) throw new Error("no access_token");
      const exp = Number(r.data?.expires_at || 0);
      gigaExpiresAt = exp > 1e12 ? exp : exp > 1e9 ? exp * 1000 : Date.now() + 29 * 60 * 1000;
      state.gigachatAuthorized = true;
      return gigaToken;
    } catch (e) { errors.push(errText(e)); }
  }
  state.gigachatAuthorized = false;
  throw new Error(errors.join("; "));
}

async function gigaRaw(payload) {
  let token = await getGigaToken(false);
  const call = (t) => requestJson(`${GIGA_API}/v1/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${t}`, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ model: GIGA_MODEL, ...payload }), timeout: 120000 });
  try { return (await call(token)).data; }
  catch (e) {
    if (e?.status !== 401) throw e;
    token = await getGigaToken(true);
    return (await call(token)).data;
  }
}

async function gigaChat(messages) {
  const data = await gigaRaw({ messages, stream: false });
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

async function gigaJson(messages, schema) {
  const data = await gigaRaw({
    messages,
    stream: false,
    response_format: { type: "json_schema", schema, strict: true },
  });
  const content = String(data?.choices?.[0]?.message?.content || "").trim();
  try { return JSON.parse(content); }
  catch { throw new Error(`GigaChat вернул не JSON: ${content.slice(0, 300)}`); }
}

async function uploadImage(inputBuffer, inputType) {
  let buffer = inputBuffer;
  let contentType = String(inputType || "image/jpeg").toLowerCase();
  if (!["image/jpeg","image/png","image/tiff","image/bmp"].includes(contentType)) {
    buffer = await sharp(buffer, { animated: false }).rotate().flatten({ background: "white" }).jpeg({ quality: 95 }).toBuffer();
    contentType = "image/jpeg";
  }
  const token = await getGigaToken(false);
  const boundary = `----maxbot${randomUUID().replaceAll("-", "")}`;
  const ext = contentType === "image/png" ? "png" : contentType === "image/tiff" ? "tiff" : contentType === "image/bmp" ? "bmp" : "jpg";
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\ngeneral\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="release.${ext}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const r = await requestJson(`${GIGA_API}/v1/files`, { method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": `multipart/form-data; boundary=${boundary}` }, body: Buffer.concat([head, buffer, tail]), timeout: 120000 });
  if (!r.data?.id) throw new Error("GigaChat file upload without id");
  return r.data.id;
}

function imageUrls(message) {
  const a = Array.isArray(message?.body?.attachments) ? message.body.attachments : [];
  return a.filter((x) => x?.type === "image").map((x) => x?.payload?.url).filter((x) => typeof x === "string" && /^https?:\/\//i.test(x));
}
function mid(message) { return String(message?.body?.mid || message?.timestamp || ""); }
function sender(message) { return String(message?.sender?.name || message?.sender?.first_name || message?.sender?.username || message?.sender?.user_id || ""); }
function isGroup(message) { const t = String(message?.recipient?.chat_type || message?.recipient?.type || "").toLowerCase(); return t === "chat" || t === "channel"; }

const DOMAIN_RULES = `
Ты аналитик реальной переписки по продаже и выдаче морских контейнеров. Понимай смысл диалога целиком, включая короткие ответы «да», «эти 2», «не считать», «это Шубино», «всё выдали», ответы на предыдущие сообщения, исправления и отмены.

РОЛИ СУЩНОСТЕЙ НЕЛЬЗЯ ПУТАТЬ:
- Клиенты/проекты: Взлёт (Взлет), Констэво, Атлас и другие покупатели, которые явно следуют из переписки.
- Поставщики: Ming Way / MING WAY / Май Вэй, Александра, Фахрат / Goldcontainer / Голдконтейнер, Наталья / Мой контейнер, Просто Контейнер, Амиди и другие поставщики.
- Терминалы/локации: Шубино, Чехов, Сухой порт, Купавна, Союз Плюс, СВС / Союз Восток, Тетрис Юг и другие площадки.
Это подсказки классификации, а не жесткое ограничение. Если переписка явно говорит иначе — следуй фактам.

Главный учет: КЛИЕНТ -> ТЕРМИНАЛ -> ТИП 20DC/40HC -> КОЛИЧЕСТВО -> НОМЕРА.
Поставщик — отдельное поле и не заменяет клиента или терминал.
Релиз, бронь, заявка, окно выдачи — НЕ факт выдачи.
Факт выдачи: только когда по смыслу подтверждено «выдали», «забрали», «выпустили», «увезли», «отгрузили», «получили» или равнозначно.
Поздняя отмена/исправление/перенос имеет приоритет над прежним сообщением.
Одинаковый номер контейнера не задваивать.
Если клиент не определен надежно — client=null. Не выдумывать.
`;

const EVENT_SCHEMA = {
  type: "object",
  properties: {
    chat_topic: { type: "string", description: "Кратко, о чем идет переписка в этом фрагменте" },
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          event_type: { type: "string", enum: ["release", "confirmed_issue", "cancellation", "correction", "transfer", "booking", "payment", "question", "other"] },
          client: { type: ["string", "null"] },
          supplier: { type: ["string", "null"] },
          terminal: { type: ["string", "null"] },
          container_type: { type: ["string", "null"], description: "20DC, 40HC или null" },
          quantity: { type: ["integer", "null"] },
          container_numbers: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["confirmed", "unconfirmed", "cancelled", "corrected", "informational"] },
          refers_to: { type: ["string", "null"], description: "К чему относится отмена/уточнение, если понятно" },
          meaning: { type: "string", description: "Человеческое объяснение смысла события" },
          evidence: { type: "string", description: "Короткая опора на смысл переписки без длинной цитаты" },
          confidence: { type: "string", enum: ["high", "medium", "low"] }
        },
        required: ["event_type","client","supplier","terminal","container_type","quantity","container_numbers","status","refers_to","meaning","evidence","confidence"],
        additionalProperties: false
      }
    }
  },
  required: ["chat_topic", "events"],
  additionalProperties: false
};

async function chatInfo(chatId) {
  const id = String(chatId);
  try {
    const c = await maxRequest(`/chats/${encodeURIComponent(id)}`, { timeout: 15000 });
    const meta = { title: c?.title || `чат ${id}`, lastSeenAt: Date.now() };
    knownGroups.set(id, meta); state.knownGroupCount = knownGroups.size;
    return meta;
  } catch {
    return knownGroups.get(id) || { title: `чат ${id}`, lastSeenAt: Date.now() };
  }
}

async function rememberGroup(chatId) {
  if (chatId == null) return null;
  const info = await chatInfo(String(chatId));
  state.lastGroupChatId = String(chatId); state.lastGroupName = info.title;
  return info;
}

async function analyzeImageMessage(message, chatTitle, nearby = "") {
  const urls = imageUrls(message); if (!urls.length) return "";
  const key = mid(message) || urls.join("|"); if (imageCache.has(key)) return imageCache.get(key);
  const messages = [{ role: "system", content: DOMAIN_RULES }];
  for (let i = 0; i < Math.min(urls.length, 8); i++) {
    const f = await download(urls[i]);
    const id = await uploadImage(f.buffer, f.contentType);
    messages.push({ role: "user", content: i === 0 ? `Прочитай скрин/релиз из чата «${chatTitle}». Контекст рядом: ${nearby || "нет"}. Определи отдельно клиента, поставщика, терминал, тип, количество, номера, даты/окно и является ли это только релизом либо есть факт выдачи. Не путай MING WAY с терминалом, а Шубино с клиентом без явного подтверждения.` : "Продолжение того же релиза.", attachments: [id] });
  }
  const answer = await gigaChat(messages); imageCache.set(key, answer); return answer;
}

function dayBounds(offsetDays = 0) {
  const off = TZ_OFFSET_MINUTES * 60000;
  const local = new Date(Date.now() + off);
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + offsetDays, 0, 0, 0, 0);
  const start = startLocal - off; return { start, end: start + 86400000 - 1 };
}

async function fetchHistory(chatId, since, until = Date.now(), max = 500) {
  const out = []; const seen = new Set(); let upper = until;
  for (let page = 0; page < 5 && out.length < max; page++) {
    const p = new URLSearchParams({ chat_id: String(chatId), count: "100" });
    if (upper != null) p.set("from", String(upper));
    if (since != null) p.set("to", String(since));
    const d = await maxRequest(`/messages?${p}`, { timeout: 45000 });
    const batch = Array.isArray(d?.messages) ? d.messages : [];
    if (!batch.length) break;
    let oldest = Infinity;
    for (const m of batch) {
      const id = mid(m) || `${m?.timestamp}-${sender(m)}`;
      if (seen.has(id)) continue; seen.add(id);
      const ts = Number(m?.timestamp || 0);
      if (since != null && ts < since) continue;
      if (ts > until) continue;
      out.push(m); if (ts > 0) oldest = Math.min(oldest, ts);
    }
    if (batch.length < 100 || !Number.isFinite(oldest)) break;
    upper = oldest - 1; if (since != null && upper < since) break;
  }
  out.sort((a,b) => Number(a?.timestamp||0)-Number(b?.timestamp||0)); return out;
}

function fmtTs(ts) {
  const d = new Date(Number(ts || 0) + TZ_OFFSET_MINUTES * 60000);
  return `${String(d.getUTCDate()).padStart(2,"0")}.${String(d.getUTCMonth()+1).padStart(2,"0")} ${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}`;
}

async function buildTranscript(title, messages) {
  const lines = []; let images = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const text = String(m?.body?.text || "").trim();
    const prefix = `[${fmtTs(m?.timestamp)}] ${sender(m)}:`;
    if (text) lines.push(`${prefix} ${text}`);
    if (imageUrls(m).length && images < 24) {
      images++;
      const nearby = messages.slice(Math.max(0,i-4), Math.min(messages.length,i+5)).map((x)=>String(x?.body?.text||"").trim()).filter(Boolean).join(" | ");
      try { lines.push(`${prefix} [КАРТИНКА/РЕЛИЗ] ${await analyzeImageMessage(m, title, nearby)}`); }
      catch (e) { lines.push(`${prefix} [КАРТИНКА НЕ ПРОЧИТАНА: ${errText(e)}]`); }
    }
  }
  state.lastHistoryImages += images;
  return lines.join("\n");
}

function requestedWindow(question) {
  const q = String(question || "").toLowerCase();
  if (q.includes("сегодня")) return dayBounds(0);
  if (q.includes("вчера")) return dayBounds(-1);
  if (q.includes("за весь чат") || q.includes("за все время") || q.includes("за всё время") || q.includes("всего")) return { start: null, end: Date.now() };
  return { start: Date.now() - 30 * 86400000, end: Date.now() };
}

async function extractEvents(question, chatId, title, start, end) {
  const history = await fetchHistory(chatId, start, end, 500);
  state.lastHistoryMessages += history.length;
  if (!history.length) return null;
  const tr = await buildTranscript(title, history);
  if (!tr.trim()) return null;

  const chunks = []; const chunkSize = 15000;
  for (let i = 0; i < tr.length; i += chunkSize) chunks.push(tr.slice(i, i + chunkSize));
  const allEvents = [];
  const topics = [];
  for (let i = 0; i < chunks.length; i++) {
    const parsed = await gigaJson([
      { role: "system", content: DOMAIN_RULES },
      { role: "user", content: `Запрос пользователя: «${question}».
Это часть ${i+1}/${chunks.length} хронологической переписки чата «${title}».
Разбери СМЫСЛ разговора. Сообщения могут ссылаться на предыдущие реплики и картинки. Короткое «эти 2 Шубино» может исправлять предыдущий терминал; «не считать» отменяет ранее обсуждаемое; «всё выдали» может подтверждать выдачу предыдущего релиза. Извлеки события, сохраняя такие связи в refers_to/meaning.
Не фильтруй только по словам из вопроса: сначала пойми, о чем разговаривают, потом выдели события, которые помогут ответить.

ПЕРЕПИСКА:\n${chunks[i]}` }
    ], EVENT_SCHEMA);
    if (parsed?.chat_topic) topics.push(parsed.chat_topic);
    if (Array.isArray(parsed?.events)) allEvents.push(...parsed.events);
  }
  return { chat_id: String(chatId), chat_title: title, topics, events: allEvents };
}

function compactEvents(extractions) {
  const out = [];
  for (const x of extractions) {
    if (!x) continue;
    out.push({ chat_title: x.chat_title, topics: x.topics, events: x.events });
  }
  return out;
}

async function answerWorkQuestion(question) {
  const { start, end } = requestedWindow(question);
  const groups = [...knownGroups.entries()];
  if (!groups.length) return "Я пока не вижу ни одного рабочего чата. Добавь меня администратором в чат и оставь там любое новое сообщение — дальше я сам буду его учитывать.";

  state.lastHistoryMessages = 0; state.lastHistoryImages = 0; state.lastHistoryChats = 0; state.lastExtractedEvents = 0;
  const extractions = [];
  for (const [id, cached] of groups) {
    const meta = await chatInfo(id);
    try {
      const parsed = await extractEvents(question, id, meta.title || cached.title, start, end);
      if (parsed) {
        extractions.push(parsed);
        state.lastHistoryChats += 1;
        state.lastExtractedEvents += parsed.events.length;
      }
    } catch (e) {
      state.lastError = `chat ${id}: ${errText(e)}`;
    }
  }
  if (!extractions.length) return "В подключённых чатах за этот период я не нашёл сообщений для анализа.";

  const data = compactEvents(extractions);
  const dialogContext = privateDialog.slice(-6).map((x) => `${x.role}: ${x.text}`).join("\n");
  const answer = await gigaChat([
    { role: "system", content: `${DOMAIN_RULES}\n
СТИЛЬ ОТВЕТА:
Пиши как рабочую сводку для владельца бизнеса: коротко, понятно, без канцелярита и без объяснений про API/доступ.
Сразу отвечай на вопрос. Не пиши «недостаточно данных», если в событиях есть хоть что-то полезное.
Если вопрос «выпиши по Взлёту» — сначала дай подтвержденный факт выдачи по Взлёту, затем отдельно «Только релизы / ещё не подтверждено».
Формат по умолчанию:
«Взлёт — выдано: N шт.»
«• Чехов — 6 × 20 DC»
«• Шубино — 2 × 20 DC»
Потом при необходимости номера.
Не перечисляй технические chat_id.
Не называй Shubino клиентом. Не называй MING WAY терминалом: MING WAY — поставщик, если переписка не доказывает иное.
Если отмена изменила итог, просто покажи уже исправленный итог и коротко укажи «учтена отмена …».
` },
    { role: "user", content: `Текущий вопрос: «${question}».
Контекст последних вопросов пользователя в личке:\n${dialogContext || "нет"}

Ниже уже структурированное понимание переписок всех доступных чатов. Сведи события хронологически, применив corrections/cancellations/transfers к более ранним событиям. Один номер не считай дважды. Релиз без confirmed_issue не включай в выдано.

ДАННЫЕ:\n${JSON.stringify(data)}` }
  ]);

  privateDialog.push({ role: "user", text: question }, { role: "assistant", text: answer });
  if (privateDialog.length > 12) privateDialog.splice(0, privateDialog.length - 12);
  return answer;
}

async function sendUser(userId, text) {
  for (const part of String(text).match(/[\s\S]{1,3900}/g) || []) {
    await maxRequest(`/messages?user_id=${encodeURIComponent(userId)}`, { method: "POST", body: { text: part } });
  }
}

async function handleGroupMessage(m) {
  const chatId = m?.recipient?.chat_id;
  if (chatId == null) return;
  await rememberGroup(chatId);
  // В группе бот всегда молчит. Аналитика идет только в личку по запросу.
}

function isSmallTalk(text) {
  const s = String(text || "").trim().toLowerCase();
  return /^(привет|здравствуй|здравствуйте|спасибо|ок|окей|поняла|готово|тест|ты работаешь\??)$/i.test(s);
}

async function handlePrivate(m) {
  const uid = m?.sender?.user_id; if (uid == null) return;
  if (!reportUserId) reportUserId = String(uid);
  const text = String(m?.body?.text || "").trim();
  try {
    if (imageUrls(m).length) {
      const answer = await analyzeImageMessage(m, "личный чат", text);
      await sendUser(uid, answer); return;
    }
    if (!text) return;
    if (/^(какие чаты|какие чаты видишь|список чатов)$/i.test(text)) {
      const rows = [];
      for (const [id] of knownGroups) { const info = await chatInfo(id); rows.push(`• ${info.title}`); }
      await sendUser(uid, rows.length ? `Вижу чаты:\n${rows.join("\n")}` : "Пока не вижу рабочих чатов.");
      return;
    }
    if (isSmallTalk(text)) {
      await sendUser(uid, "Да, я на связи."); return;
    }
    // Любая рабочая фраза идет через смысловой анализ истории всех чатов.
    const answer = await answerWorkQuestion(text);
    state.lastError = null;
    await sendUser(uid, answer);
  } catch (e) {
    state.lastError = `private: ${errText(e)}`;
    await sendUser(uid, `Не получилось обработать запрос: ${e.message}`);
  }
}

async function handleUpdate(u) {
  const type = u?.update_type;
  if (type === "bot_added") {
    if (u?.chat_id != null) await rememberGroup(u.chat_id);
    return;
  }
  if (type === "bot_removed") {
    if (u?.chat_id != null) { knownGroups.delete(String(u.chat_id)); state.knownGroupCount = knownGroups.size; }
    return;
  }
  if (type === "chat_title_changed") {
    if (u?.chat_id != null) await rememberGroup(u.chat_id);
    return;
  }
  if (["message_created","message_edited"].includes(type)) {
    const m = u?.message; if (!m || m?.sender?.is_bot) return;
    if (isGroup(m)) await handleGroupMessage(m); else await handlePrivate(m);
  }
  // message_removed учитывается при следующем чтении истории: удаленного сообщения уже не будет в GET /messages.
}

async function poll() {
  let marker = null, first = true; state.polling = true;
  while (true) {
    try {
      const p = new URLSearchParams({ limit: "100", timeout: "30", types: "message_created,message_edited,message_removed,bot_added,bot_removed,chat_title_changed,bot_started" });
      if (!first && marker != null) p.set("marker", String(marker));
      const d = await maxRequest(`/updates?${p}`, { timeout: 40000 });
      first = false; if (d?.marker != null) marker = d.marker;
      for (const u of d?.updates || []) await handleUpdate(u);
    } catch (e) {
      state.lastError = `poll: ${errText(e)}`;
      await sleep(3000);
    }
  }
}

async function start() {
  while (true) {
    try {
      await maxRequest("/me", { timeout: 12000 }); state.maxAuthorized = true;
      await getGigaToken(false); state.gigachatAuthorized = true;
      for (const id of SEEDED_CHAT_IDS) await rememberGroup(id);
      await poll();
    } catch (e) {
      state.maxAuthorized = false; state.polling = false; state.lastError = `startup: ${errText(e)}`;
      await sleep(5000);
    }
  }
}

void start();
