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
const GIGA_KEY_RAW = process.env.GIGACHAT_AUTH_KEY || "";
const GIGA_SCOPE = (process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS").trim();
const GIGA_MODEL = (process.env.GIGACHAT_MODEL || "GigaChat-3-Ultra").trim();
const PORT = Number(process.env.PORT || 3000);
const TZ_OFFSET_MINUTES = Number(process.env.ACCOUNTING_TZ_OFFSET_MINUTES || 300);
const DEFAULT_CHAT_IDS = (process.env.WATCH_CHAT_IDS || "-77765742260432")
  .split(",").map((x) => x.trim()).filter(Boolean);

function cleanKey(v) {
  let s = String(v || "").trim();
  s = s.replace(/^Authorization\s*:\s*/i, "");
  s = s.replace(/^(Basic|Bearer)\s+/i, "");
  s = s.replace(/^["'`]+|["'`]+$/g, "");
  return s.replace(/\s+/g, "");
}
const GIGA_KEY = cleanKey(GIGA_KEY_RAW);
let decodedKey = "";
try { decodedKey = Buffer.from(GIGA_KEY, "base64").toString("utf8"); } catch {}
const keyLooksPair = decodedKey.includes(":");

const russianCa = fs.readFileSync("/app/russian-trusted-root-ca.pem", "utf8");
const agent = new https.Agent({ ca: [...tls.rootCertificates, russianCa], keepAlive: true });

let gigaToken = null;
let gigaExpires = 0;
let reportUserId = (process.env.REPORT_USER_ID || "").trim() || null;
const knownGroups = new Map(DEFAULT_CHAT_IDS.map((id) => [id, { title: `чат ${id}` }]));
const imageCache = new Map();

const state = {
  startedAt: new Date().toISOString(),
  version: "v12-full-history",
  maxAuthorized: false,
  polling: false,
  gigachatAuthorized: false,
  silentGroupMode: true,
  fullHistoryAnalytics: true,
  readsTextAndImages: true,
  reportUserKnown: Boolean(reportUserId),
  knownGroupCount: knownGroups.size,
  lastGroupChatId: null,
  lastGroupName: null,
  lastHistoryMessages: 0,
  lastHistoryImages: 0,
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
        res.resume();
        resolve(download(new URL(res.headers.location, url).toString(), redirects + 1));
        return;
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
  if (GIGA_KEY) a.push({ mode: "basic", value: `Basic ${GIGA_KEY}` });
  if (GIGA_KEY.includes(":")) a.push({ mode: "basic-encoded-pair", value: `Basic ${Buffer.from(GIGA_KEY).toString("base64")}` });
  if (GIGA_KEY) a.push({ mode: "bearer", value: `Bearer ${GIGA_KEY}` });
  if (GIGA_KEY && !keyLooksPair && !GIGA_KEY.includes(":")) a.push({ mode: "basic-encoded-raw", value: `Basic ${Buffer.from(GIGA_KEY).toString("base64")}` });
  const seen = new Set(); return a.filter((x) => !seen.has(x.value) && seen.add(x.value));
}

async function getGigaToken(force = false) {
  if (!force && gigaToken && Date.now() < gigaExpires - 60000) return gigaToken;
  const form = new URLSearchParams({ scope: GIGA_SCOPE }).toString();
  const errors = [];
  for (const c of authCandidates()) {
    try {
      const r = await requestJson(GIGA_AUTH_URL, { method: "POST", headers: { Authorization: c.value, RqUID: randomUUID(), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: form, timeout: 30000 });
      gigaToken = r.data?.access_token;
      if (!gigaToken) throw new Error("no access_token");
      const exp = Number(r.data?.expires_at || 0);
      gigaExpires = exp > 1e12 ? exp : exp > 1e9 ? exp * 1000 : Date.now() + 29 * 60 * 1000;
      state.gigachatAuthorized = true;
      return gigaToken;
    } catch (e) { errors.push(`${c.mode}: ${errText(e)}`); }
  }
  state.gigachatAuthorized = false;
  throw new Error(errors.join("; "));
}

async function gigaChat(messages) {
  let token = await getGigaToken(false);
  try {
    const r = await requestJson(`${GIGA_API}/v1/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ model: GIGA_MODEL, messages, stream: false }), timeout: 120000 });
    return String(r.data?.choices?.[0]?.message?.content || "").trim();
  } catch (e) {
    if (e?.status !== 401) throw e;
    token = await getGigaToken(true);
    const r = await requestJson(`${GIGA_API}/v1/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ model: GIGA_MODEL, messages, stream: false }), timeout: 120000 });
    return String(r.data?.choices?.[0]?.message?.content || "").trim();
  }
}

async function uploadImage(inputBuffer, inputType) {
  let buffer = inputBuffer; let contentType = String(inputType || "image/jpeg").toLowerCase();
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

const SYSTEM = `Ты аналитик учета морских контейнеров. Основной разрез: КЛИЕНТ -> ТЕРМИНАЛ -> ТИП 20DC/40HC -> КОЛИЧЕСТВО -> НОМЕРА. Поставщик, терминал и клиент — разные сущности. Релиз/бронь/заявка/окно НЕ являются фактической выдачей. Выдачу считай только если переписка по смыслу подтверждает: выдали, забрали, выпустили, увезли, отгрузили и т.п. Читай переписку хронологически. Поздняя отмена, исправление, перенос, «не считать», «это другому клиенту» отменяет или исправляет старый факт. Не задваивай одинаковый контейнер. Если клиент не определяется надежно — так и пиши.`;

async function chatInfo(chatId) {
  try {
    const c = await maxRequest(`/chats/${encodeURIComponent(chatId)}`, { timeout: 15000 });
    const meta = { title: c?.title || `чат ${chatId}` };
    knownGroups.set(String(chatId), meta); state.knownGroupCount = knownGroups.size;
    return meta;
  } catch { return knownGroups.get(String(chatId)) || { title: `чат ${chatId}` }; }
}

async function analyzeImageMessage(message, chatTitle, nearby = "") {
  const urls = imageUrls(message); if (!urls.length) return "";
  const key = mid(message) || urls.join("|"); if (imageCache.has(key)) return imageCache.get(key);
  const messages = [{ role: "system", content: SYSTEM }];
  for (let i = 0; i < Math.min(urls.length, 8); i++) {
    const f = await download(urls[i]);
    const id = await uploadImage(f.buffer, f.contentType);
    messages.push({ role: "user", content: i === 0 ? `Прочитай релиз/скрин из чата «${chatTitle}». Рядом текст: ${nearby || "нет"}. Верни все номера контейнеров, тип, терминал/локацию, даты/окно, клиента только если явно виден/следует из текста. Отдельно укажи: это только релиз или подтвержденная выдача.` : "Продолжение того же релиза.", attachments: [id] });
  }
  const answer = await gigaChat(messages); imageCache.set(key, answer); return answer;
}

function dayBounds(offsetDays = 0) {
  const off = TZ_OFFSET_MINUTES * 60000;
  const local = new Date(Date.now() + off);
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + offsetDays, 0, 0, 0, 0);
  const start = startLocal - off; return { start, end: start + 86400000 - 1 };
}

async function fetchHistory(chatId, since = null, until = Date.now(), max = 1000) {
  const out = []; const seen = new Set(); let upper = until;
  for (let page = 0; page < 10 && out.length < max; page++) {
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
      if (since != null && ts < since) continue; if (ts > until) continue;
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

async function transcript(chatId, title, messages) {
  const lines = []; let imageCount = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]; const text = String(m?.body?.text || "").trim(); const prefix = `[${fmtTs(m?.timestamp)}] ${sender(m)}:`;
    if (text) lines.push(`${prefix} ${text}`);
    if (imageUrls(m).length && imageCount < 40) {
      imageCount++;
      const nearby = messages.slice(Math.max(0,i-3), Math.min(messages.length,i+4)).map((x)=>String(x?.body?.text||"").trim()).filter(Boolean).join(" | ");
      try { lines.push(`${prefix} [КАРТИНКА] ${await analyzeImageMessage(m, title, nearby)}`); }
      catch (e) { lines.push(`${prefix} [КАРТИНКА НЕ ПРОЧИТАНА: ${errText(e)}]`); }
    }
  }
  state.lastHistoryImages = imageCount; return lines.join("\n");
}

async function summarizeTranscript(question, title, text) {
  const chunks = []; const size = 22000;
  for (let i=0;i<text.length;i+=size) chunks.push(text.slice(i,i+size));
  const extracted = [];
  for (let i=0;i<chunks.length;i++) {
    extracted.push(await gigaChat([{role:"system",content:SYSTEM},{role:"user",content:`Это часть ${i+1}/${chunks.length} хронологической переписки чата «${title}». Извлеки только события, влияющие на учет: релизы, подтвержденные выдачи, номера, клиентов, терминалы, типы, отмены/исправления/переносы. Обязательно различай релиз и факт выдачи. Сохрани хронологию.\n\n${chunks[i]}`} ]));
  }
  return gigaChat([{role:"system",content:SYSTEM},{role:"user",content:`Вопрос: ${question}\n\nНиже извлеченные события из всей доступной переписки «${title}». Сведи их с учетом поздних отмен и исправлений. Не задваивай номера. Релиз без подтверждения не включай в факт выдачи. Ответ дай: общий итог + клиент -> терминал -> тип -> количество; отдельно неподтвержденные релизы/спорные данные.\n\n${extracted.join("\n\n---\n\n")}`}]);
}

function targetGroup(question) {
  const q = String(question||"").toLowerCase();
  for (const [id,m] of knownGroups) if (m.title && q.includes(m.title.toLowerCase())) return {id,title:m.title};
  if (state.lastGroupChatId && knownGroups.has(String(state.lastGroupChatId))) { const m=knownGroups.get(String(state.lastGroupChatId)); return {id:String(state.lastGroupChatId),title:m.title}; }
  if (knownGroups.size === 1) { const [id,m] = [...knownGroups.entries()][0]; return {id,title:m.title}; }
  if (DEFAULT_CHAT_IDS.length) { const id=DEFAULT_CHAT_IDS[0]; return {id,title:(knownGroups.get(id)?.title || `чат ${id}`)}; }
  return null;
}

async function answerFromHistory(question) {
  const t = targetGroup(question); if (!t) return "Не знаю, какой чат анализировать.";
  const info = await chatInfo(t.id); t.title = info.title;
  let since = null, until = Date.now(); const q = String(question).toLowerCase();
  if (q.includes("сегодня")) { const b=dayBounds(0); since=b.start; until=Math.min(b.end,Date.now()); }
  else if (q.includes("вчера")) { const b=dayBounds(-1); since=b.start; until=b.end; }
  const history = await fetchHistory(t.id, since, until, 1000); state.lastHistoryMessages = history.length;
  if (!history.length) return `В чате «${t.title}» за этот период сообщения не найдены.`;
  const tr = await transcript(t.id, t.title, history);
  return summarizeTranscript(question, t.title, tr);
}

async function sendUser(userId, text) {
  for (const part of String(text).match(/[\s\S]{1,3900}/g) || []) await maxRequest(`/messages?user_id=${encodeURIComponent(userId)}`, { method:"POST", body:{text:part} });
}

async function handleGroup(m) {
  const chatId = String(m?.recipient?.chat_id ?? ""); if (!chatId) return;
  const info = await chatInfo(chatId); state.lastGroupChatId=chatId; state.lastGroupName=info.title;
  // В группе бот всегда молчит. Текст и картинки будут читаться из полной истории при запросе в личке.
  if (imageUrls(m).length && reportUserId) {
    try { await sendUser(reportUserId, `Новая картинка/релиз из «${info.title}»\n\n${await analyzeImageMessage(m, info.title, String(m?.body?.text||""))}`); }
    catch (e) { state.lastError=`group image: ${errText(e)}`; }
  }
}

function needsHistory(text) { return /(чат|итог|выдал|выдали|выдач|релиз|контейнер|терминал|клиент|отмен|исправ|сколько|сегодня|вчера|проверь)/i.test(String(text||"")); }

async function handlePrivate(m) {
  const uid = m?.sender?.user_id; if (uid == null) return;
  if (!reportUserId) { reportUserId=String(uid); state.reportUserKnown=true; }
  const text = String(m?.body?.text||"").trim();
  if (imageUrls(m).length) { await sendUser(uid, await analyzeImageMessage(m,"личный чат",text)); return; }
  if (!text) return;
  try {
    if (/^(какие чаты|какие чаты видишь|список чатов)$/i.test(text)) {
      const rows=[]; for (const id of new Set([...DEFAULT_CHAT_IDS,...knownGroups.keys()])) { const i=await chatInfo(id); rows.push(`• ${i.title} (${id})`); }
      await sendUser(uid, `Вижу/знаю чаты:\n${rows.join("\n")}`); return;
    }
    const answer = needsHistory(text) ? await answerFromHistory(text) : await gigaChat([{role:"system",content:SYSTEM},{role:"user",content:text}]);
    state.lastError=null; await sendUser(uid,answer);
  } catch (e) { state.lastError=`private: ${errText(e)}`; await sendUser(uid,`Ошибка обработки: ${e.message}`); }
}

async function poll() {
  let marker=null, first=true; state.polling=true;
  while(true) {
    try {
      const p=new URLSearchParams({limit:"100",timeout:"30",types:"message_created,bot_started"}); if(!first && marker!=null) p.set("marker",String(marker));
      const d=await maxRequest(`/updates?${p}`,{timeout:40000}); first=false; if(d?.marker!=null) marker=d.marker;
      for(const u of d?.updates||[]) if(u?.update_type==="message_created" && !u?.message?.sender?.is_bot) { if(isGroup(u.message)) await handleGroup(u.message); else await handlePrivate(u.message); }
    } catch(e) { state.lastError=`poll: ${errText(e)}`; await sleep(3000); }
  }
}

async function start() {
  while(true) {
    try {
      await maxRequest("/me",{timeout:12000}); state.maxAuthorized=true;
      await getGigaToken(false); state.gigachatAuthorized=true;
      for(const id of DEFAULT_CHAT_IDS) await chatInfo(id);
      await poll();
    } catch(e) { state.maxAuthorized=false; state.polling=false; state.lastError=`startup: ${errText(e)}`; await sleep(5000); }
  }
}

void start();
