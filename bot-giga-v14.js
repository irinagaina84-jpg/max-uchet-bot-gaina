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
const SEEDED_CHAT_IDS = (process.env.WATCH_CHAT_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);

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
  const data = await gigaRaw({ messages, stream: false, response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema } } });
  const text = String(data?.choices?.[0]?.message?.content || "{}").trim();
  try { return JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]);
    throw new Error(`GigaChat returned non-JSON: ${text.slice(0, 300)}`);
  }
}

const DOMAIN_RULES = `Ты — приватный аналитик владельца бизнеса по продаже морских контейнеров.
Твоя задача — понимать смысл рабочей переписки целиком, а не искать отдельные слова.

Главная схема учёта: КЛИЕНТ → ТЕРМИНАЛ → ТИП (20 DC/40 HC) → КОЛИЧЕСТВО → НОМЕРА.
Поставщик — отдельное поле и никогда автоматически не является клиентом или терминалом.

Критически важно различать:
- release — релиз/заявка/бронь/слот/окно, но ещё не подтверждённая фактическая выдача;
- confirmed_issue — фактически выдано/забрано/выпущено/увезено;
- cancellation — отмена/снятие/откат/«не считать»;
- correction — исправление предыдущих данных/замена машины/номера/клиента/терминала/типа/количества;
- payment — оплата/перевод/полученные деньги; не считать выдачей;
- context — важный контекст, который сам по себе не меняет количество выданных.

Релиз, бронь, заявка, окно выдачи — НЕ факт выдачи.
Факт выдачи: только когда по смыслу подтверждено «выдали», «забрали», «выпустили», «увезли», «отгрузили», «получили» или равнозначно.
Поздняя отмена или исправление имеет приоритет над ранним сообщением.
Один номер контейнера нельзя считать дважды, если это тот же физический контейнер.
Если сообщение содержит противоречие, не выдумывай — сохрани uncertain=true и объясни в notes.

Читай разговор по смыслу: «там ещё 2 надо», «эти два сняла», «это не Май Вэй, это Просто Контейнер», «это тест, не учитывай» должны менять трактовку предыдущих сообщений.`;

const EVENT_SCHEMA = {
  type: "object",
  properties: {
    events: { type: "array", items: { type: "object", properties: {
      event_type: { type: "string", enum: ["release","confirmed_issue","cancellation","correction","payment","context"] },
      customer: { type: ["string","null"] }, supplier: { type: ["string","null"] }, terminal: { type: ["string","null"] },
      container_type: { type: ["string","null"] }, quantity: { type: ["integer","null"] }, container_numbers: { type: "array", items: { type: "string" } },
      amount_rub: { type: ["number","null"] }, release_id: { type: ["string","null"] },
      effective_time_ms: { type: ["integer","null"] }, source_message_ids: { type: "array", items: { type: "string" } },
      uncertain: { type: "boolean" }, notes: { type: ["string","null"] }
    }, required: ["event_type","customer","supplier","terminal","container_type","quantity","container_numbers","amount_rub","release_id","effective_time_ms","source_message_ids","uncertain","notes"], additionalProperties: false } }
  }, required: ["events"], additionalProperties: false
};

function normalizeText(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function msgText(m) { return String(m?.body?.text || m?.text || ""); }
function msgId(m) { return String(m?.body?.mid || m?.mid || m?.id || ""); }
function msgTime(m) { return Number(m?.timestamp || m?.body?.timestamp || 0); }
function senderName(m) { const s = m?.sender || {}; return [s.first_name, s.last_name].filter(Boolean).join(" ") || s.username || String(s.user_id || ""); }
function isGroup(message) { const t = String(message?.recipient?.chat_type || message?.recipient?.type || "").toLowerCase(); return t === "chat" || t === "channel"; }

async function chatInfo(chatId) {
  try { const c = await maxRequest(`/chats/${encodeURIComponent(chatId)}`, { timeout: 15000 }); return { title: c?.title || `чат ${chatId}` }; }
  catch { return { title: `чат ${chatId}` }; }
}

async function rememberGroup(chatId) {
  if (chatId == null) return null;
  const info = await chatInfo(chatId);
  knownGroups.set(String(chatId), { title: info.title, lastSeenAt: Date.now() });
  state.knownGroupCount = knownGroups.size; state.lastGroupChatId = String(chatId); state.lastGroupName = info.title;
  return info;
}

function replyInfo(m) {
  const r = m?.body?.reply_to || m?.body?.reply || m?.reply_to || null;
  if (!r) return "";
  return normalizeText(`Ответ на: ${r?.body?.text || r?.text || ""}`);
}

function attachments(m) { return Array.isArray(m?.body?.attachments) ? m.body.attachments : Array.isArray(m?.attachments) ? m.attachments : []; }
function imageUrls(m) {
  const urls = [];
  for (const a of attachments(m)) {
    const type = String(a?.type || a?.payload?.type || "").toLowerCase();
    if (!["image","photo"].includes(type)) continue;
    const p = a?.payload || a;
    const candidates = [p?.url, p?.photo?.url, p?.photo?.full_url, p?.photos?.large?.url, p?.photos?.medium?.url, p?.photos?.small?.url, p?.token?.url];
    for (const u of candidates) if (typeof u === "string" && /^https?:\/\//.test(u)) urls.push(u);
  }
  return [...new Set(urls)];
}

function historyContextLine(m) {
  const time = new Date(msgTime(m) || Date.now()).toISOString();
  return `[${time}] ${senderName(m)} | id=${msgId(m)} | ${replyInfo(m)} ${normalizeText(msgText(m))}`.trim();
}

async function convertImage(buffer, contentType) {
  try {
    if (contentType === "image/webp" || contentType === "image/avif" || contentType === "image/heic" || contentType === "image/heif") {
      return { buffer: await sharp(buffer).jpeg({ quality: 88 }).toBuffer(), mime: "image/jpeg" };
    }
  } catch (e) { console.error("convertImage", errText(e)); }
  return { buffer, mime: ["image/jpeg","image/png"].includes(contentType) ? contentType : "image/jpeg" };
}

async function describeImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  const p = (async () => {
    const dl = await download(url); const converted = await convertImage(dl.buffer, dl.contentType);
    const b64 = converted.buffer.toString("base64");
    const data = await gigaRaw({ messages: [{ role: "user", content: [
      { type: "text", text: "Прочитай изображение как рабочий документ по контейнерам. Извлеки весь значимый текст: клиент/получатель, поставщик, терминал, тип 20DC/40HC, номера контейнеров, количество, даты/окна, номер релиза, статус. Не придумывай." },
      { type: "image_url", image_url: { url: `data:${converted.mime};base64,${b64}` } }
    ] }], stream: false });
    return String(data?.choices?.[0]?.message?.content || "").trim();
  })(); imageCache.set(url, p); return p;
}

async function fetchHistory(chatId, since, until = Date.now(), max = 500) {
  const out = []; let before = until;
  for (let page = 0; page < 5 && out.length < max; page++) {
    const q = new URLSearchParams({ chat_id: String(chatId), count: "100", to: String(before) });
    if (since) q.set("from", String(since));
    const d = await maxRequest(`/messages?${q}`, { timeout: 30000 });
    const items = d?.messages || d?.items || [];
    if (!items.length) break;
    out.push(...items); const oldest = Math.min(...items.map(msgTime).filter(Boolean));
    if (!oldest || items.length < 100 || (since && oldest <= since)) break; before = oldest - 1;
  }
  return out.filter((m) => (!since || msgTime(m) >= since) && msgTime(m) <= until).sort((a,b) => msgTime(a)-msgTime(b)).slice(-max);
}

async function extractChunk(chatTitle, rows) {
  const imageTexts = [];
  for (const m of rows) for (const url of imageUrls(m)) {
    try { imageTexts.push(`[message_id=${msgId(m)}] IMAGE: ${await describeImage(url)}`); }
    catch (e) { imageTexts.push(`[message_id=${msgId(m)}] IMAGE_ERROR: ${errText(e)}`); }
  }
  const transcript = rows.map(historyContextLine).join("\n");
  const content = `Название рабочего чата: ${chatTitle}\n\nХронология сообщений:\n${transcript}\n\nРезультат чтения картинок:\n${imageTexts.join("\n") || "нет"}`;
  const parsed = await gigaJson([
    { role: "system", content: `${DOMAIN_RULES}\n\nПреобразуй фрагмент рабочей переписки в журнал событий. Поздние реплики могут отменять или исправлять ранние. Используй message_id как источник. Один человеческий смысловой эпизод может включать несколько сообщений.` },
    { role: "user", content }
  ], EVENT_SCHEMA);
  return { events: parsed?.events || [], imageCount: imageTexts.length };
}

function chunkRows(rows, size = 45, overlap = 8) {
  const out = []; for (let i = 0; i < rows.length; i += Math.max(1, size - overlap)) out.push(rows.slice(i, i + size)); return out;
}

async function extractChat(chatId, title, start, end) {
  const history = await fetchHistory(chatId, start, end, 500); let imageCount = 0; const events = [];
  for (const part of chunkRows(history)) { const r = await extractChunk(title, part); imageCount += r.imageCount; events.push(...r.events); }
  return { historyCount: history.length, imageCount, events };
}

function requestedWindow(question) {
  const q = question.toLowerCase(); const now = new Date();
  const dayStart = (daysAgo = 0) => { const d = new Date(now.getTime() + TZ_OFFSET_MINUTES*60000); d.setUTCHours(0,0,0,0); d.setUTCDate(d.getUTCDate()-daysAgo); return d.getTime()-TZ_OFFSET_MINUTES*60000; };
  if (q.includes("за весь чат") || q.includes("за все время") || q.includes("за всё время") || q.includes("всего")) return { start: null, end: Date.now() };
  if (q.includes("вчера")) return { start: dayStart(1), end: dayStart(0)-1 };
  if (q.includes("сегодня")) return { start: dayStart(0), end: Date.now() };
  return { start: Date.now() - 30*86400000, end: Date.now() };
}

function compactEvents(extractions) {
  return extractions.flatMap((x) => x.events.map((e) => ({ ...e, chat_title: x.title, chat_id: x.chatId })));
}

function isExactLookupQuestion(text) {
  const t = normalizeText(text);
  return /(?:релиз|release|номер|контейнер|контейнера|контейнеру|найди|откуда|где).*\b[A-ZА-Я0-9-]{5,}\b/i.test(t) || /\b[A-Z]{4}\d{6,7}\b/i.test(t);
}

function lookupTerms(text) {
  const set = new Set();
  for (const m of normalizeText(text).matchAll(/\b[A-ZА-Я]{0,6}\d[A-ZА-Я0-9-]{4,}\b/gi)) set.add(m[0].toUpperCase());
  for (const m of normalizeText(text).matchAll(/(?:релиз|release|номер)\s*[№#:]?\s*([A-ZА-Я0-9-]{3,})/gi)) set.add(m[1].toUpperCase());
  return [...set];
}

async function exactLookup(question) {
  const terms = lookupTerms(question);
  if (!terms.length) return null;
  const hits = [];
  for (const [chatId, meta] of knownGroups) {
    try {
      const history = await fetchHistory(chatId, null, Date.now(), 500);
      for (const m of history) {
        const hay = `${msgText(m)} ${replyInfo(m)}`.toUpperCase();
        if (terms.some((t) => hay.includes(t))) hits.push({ chatId, title: meta.title, message: m });
      }
    } catch (e) { state.lastError = `lookup ${chatId}: ${errText(e)}`; }
  }
  if (!hits.length) return `По истории доступных рабочих чатов точного совпадения для «${terms.join(", ")}» не найдено.`;
  hits.sort((a,b) => msgTime(a.message)-msgTime(b.message));
  const ctx = [];
  for (const h of hits.slice(-10)) {
    const neighborhood = await fetchHistory(h.chatId, Math.max(0, msgTime(h.message)-10*60*1000), msgTime(h.message)+10*60*1000, 80);
    ctx.push(`ЧАТ: ${h.title} (${h.chatId})\n${neighborhood.map(historyContextLine).join("\n")}`);
  }
  const answer = await gigaChat([
    { role: "system", content: `${DOMAIN_RULES}\n\nЭто точный поиск по идентификатору. Сначала сообщи, где он реально найден: название чата, дата/время, автор, исходный текст. Затем объясни только то, что подтверждается ближайшим контекстом. НИКОГДА не приписывай этому номеру поставщика, клиента, терминал, тип, количество или факт выдачи из другого сообщения, если связь не подтверждена явным текстом/ответом/контекстом. Если есть только голая строка «Релиз N», так и скажи: «Других подтверждающих данных к этому релизу нет».` },
    { role: "user", content: `Запрос: ${question}\n\nТочные совпадения и контекст:\n${ctx.join("\n\n---\n\n")}` }
  ]);
  return answer;
}

async function answerWorkQuestion(question) {
  const { start, end } = requestedWindow(question); const extractions = [];
  for (const [chatId, meta] of knownGroups) {
    try { const r = await extractChat(chatId, meta.title, start, end); extractions.push({ chatId, title: meta.title, ...r }); }
    catch (e) { state.lastError = `history ${chatId}: ${errText(e)}`; }
  }
  state.lastHistoryMessages = extractions.reduce((s,x)=>s+x.historyCount,0); state.lastHistoryImages = extractions.reduce((s,x)=>s+x.imageCount,0); state.lastHistoryChats = extractions.length;
  state.lastExtractedEvents = extractions.reduce((s,x)=>s+x.events.length,0);
  if (!state.lastHistoryMessages) return "В подключённых чатах за этот период я не нашёл сообщений для анализа.";
  const data = compactEvents(extractions);
  const dialogContext = privateDialog.slice(-6).map((x) => `${x.role}: ${x.text}`).join("\n");
  const answer = await gigaChat([
    { role: "system", content: `${DOMAIN_RULES}\n\nТы отвечаешь владельцу в ЛИЧКЕ. Перед тобой не сырые сообщения, а события, извлечённые из полной хронологии нескольких рабочих чатов.\n\nПравила финального ответа:\n1) confirmed_issue увеличивает фактическую выдачу.\n2) release не включай в фактическую выдачу, пока нет подтверждения. Покажи отдельно, если это полезно.\n3) cancellation отменяет предыдущий соответствующий релиз/выдачу, если по смыслу именно это отменено.\n4) correction заменяет старые данные новыми, не создаёт дополнительную выдачу.\n5) Убирай дубли по номерам контейнеров и по смыслу одного эпизода.\n6) payment не считать контейнером.\n7) Если клиент явно не указан, не придумывай его. Название терминала/поставщика не превращай в клиента.\n8) Если пользователь называет клиента (например «по Взлёту»), фильтруй события по явной или надёжно следующей из переписки привязке к этому клиенту.\n9) Если пользователь спрашивает «сколько выдали», считай только confirmed_issue.\n10) Если просит «релизы», считай release отдельно.\n11) Ответь именно на текущий вопрос, учитывая последние уточнения личного диалога.\n\nСТИЛЬ ОТВЕТА:\nПиши как рабочую сводку для владельца бизнеса: коротко, понятно, без канцелярита и без объяснений про API/доступ.\nСразу отвечай на вопрос. Не пиши «недостаточно данных», если в событиях есть хоть что-то полезное.\nЕсли вопрос «выпиши по Взлёту» — сначала дай подтвержденный факт выдачи по Взлёту, затем отдельно «Только релизы / ещё не подтверждено».\nФормат по умолчанию:\n«Взлёт — выдано: N шт.»\n«• Чехов — 6 × 20 DC»\n«• Шубино — 2 × 20 DC»\nПотом при необходимости номера.\nНе перечисляй технические chat_id.\nНе называй Shubino клиентом. Не называй MING WAY терминалом: MING WAY — поставщик, если переписка не доказывает иное.\nЕсли отмена изменила итог, просто покажи уже исправленный итог и коротко укажи «учтена отмена …».` },
    { role: "user", content: `Текущий вопрос: «${question}».\nПоследний контекст личного диалога:\n${dialogContext || "нет"}\n\nСобытия из рабочих чатов:\n${JSON.stringify(data)}` }
  ]);
  privateDialog.push({ role: "user", text: question }, { role: "assistant", text: answer }); if (privateDialog.length > 12) privateDialog.splice(0, privateDialog.length - 12);
  return answer;
}

async function sendText(recipient, text) {
  const parts = String(text || "").match(/[\s\S]{1,3500}/g) || [""];
  for (const part of parts) await maxRequest(`/messages?${recipient}`, { method: "POST", body: { text: part }, timeout: 30000 });
}

async function handlePrivate(message) {
  const senderId = String(message?.sender?.user_id || ""); if (!senderId) return;
  if (!reportUserId) reportUserId = senderId; if (reportUserId !== senderId) return;
  const text = normalizeText(msgText(message)); const imgs = imageUrls(message); if (!text && !imgs.length) return;
  try {
    if (imgs.length) {
      const descriptions = []; for (const u of imgs) descriptions.push(await describeImage(u));
      const answer = await gigaChat([{ role: "system", content: `${DOMAIN_RULES}\n\nПользователь прислал изображение прямо в личку. Прочитай и ответь на его подпись/вопрос. Если подпись отсутствует — кратко выпиши, что видно по контейнерам.` }, { role: "user", content: `Вопрос: ${text || "Что здесь написано?"}\nИзображение:\n${descriptions.join("\n")}` }]);
      await sendText(`user_id=${encodeURIComponent(senderId)}`, answer); return;
    }
    if (/^(какие чаты|какие чаты видишь|список чатов)$/i.test(text)) {
      const rows = []; for (const [id, m] of knownGroups) rows.push(`• ${m.title || "чат"} (${id})`);
      await sendText(`user_id=${encodeURIComponent(senderId)}`, rows.length ? `Вижу чаты:\n${rows.join("\n")}` : "Пока не зарегистрирован ни один групповой чат. Добавьте меня администратором в рабочий чат — я запомню его молча."); return;
    }
    if (isExactLookupQuestion(text)) {
      const found = await exactLookup(text); if (found) { await sendText(`user_id=${encodeURIComponent(senderId)}`, found); return; }
    }
    const answer = await answerWorkQuestion(text); await sendText(`user_id=${encodeURIComponent(senderId)}`, answer);
  } catch (e) { state.lastError = `private: ${errText(e)}`; await sendText(`user_id=${encodeURIComponent(senderId)}`, `Ошибка анализа: ${errText(e).slice(0,1000)}`); }
}

async function handleGroupMessage(message) { const chatId = message?.recipient?.chat_id; if (chatId != null) await rememberGroup(chatId); /* SILENT: nothing sent to group */ }

async function handleUpdate(u) {
  const type = u?.update_type || ""; state.lastUpdateType = type; state.lastUpdateAt = new Date().toISOString();
  if (type === "bot_added") { await rememberGroup(u?.chat_id); return; }
  if (type === "bot_removed") { if (u?.chat_id != null) { knownGroups.delete(String(u.chat_id)); state.knownGroupCount = knownGroups.size; } return; }
  if (type === "chat_title_changed") { await rememberGroup(u?.chat_id); return; }
  if (["message_created","message_edited"].includes(type)) {
    const m = u?.message; if (!m || m?.sender?.is_bot) return;
    if (isGroup(m)) await handleGroupMessage(m); else await handlePrivate(m);
  }
}

async function poll() {
  let marker = null, first = true; state.polling = true;
  while (true) {
    try {
      const q = new URLSearchParams({ limit: "100", timeout: "30", types: "message_created,message_edited,message_removed,bot_added,bot_removed,chat_title_changed,bot_started" }); if (marker != null) q.set("marker", String(marker));
      const d = await maxRequest(`/updates?${q}`, { timeout: 40000 });
      if (first && marker == null) { marker = d?.marker ?? null; first = false; continue; }
      first = false; if (d?.marker != null) marker = d.marker;
      for (const u of d?.updates || []) await handleUpdate(u);
    } catch (e) { state.lastError = `poll: ${errText(e)}`; await sleep(2500); }
  }
}

async function start() {
  while (true) {
    try {
      await maxRequest("/me", { timeout: 12000 }); state.maxAuthorized = true;
      await getGigaToken(false); state.gigachatAuthorized = true;
      for (const id of SEEDED_CHAT_IDS) await rememberGroup(id);
      await poll();
    } catch (e) { state.maxAuthorized = false; state.polling = false; state.lastError = `startup: ${errText(e)}`; await sleep(5000); }
  }
}

void start();
