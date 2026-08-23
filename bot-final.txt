import http from "node:http";
import https from "node:https";

const MAX_API = "https://platform-api2.max.ru";
const OPENAI_API = "https://api.openai.com/v1/responses";
const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-terra";
const PORT = Number(process.env.PORT || 3000);

if (!MAX_BOT_TOKEN) throw new Error("MAX_BOT_TOKEN is not set");
if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");

const RUSSIAN_TRUSTED_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIFwjCCA6qgAwIBAgICEAAwDQYJKoZIhvcNAQELBQAwcDELMAkGA1UEBhMCUlUx
PzA9BgNVBAoMNlRoZSBNaW5pc3RyeSBvZiBEaWdpdGFsIERldmVsb3BtZW50IGFu
ZCBDb21tdW5pY2F0aW9uczEgMB4GA1UEAwwXUnVzc2lhbiBUcnVzdGVkIFJvb3Qg
Q0EwHhcNMjIwMzAxMjEwNDE1WhcNMzIwMjI3MjEwNDE1WjBwMQswCQYDVQQGEwJS
VTE/MD0GA1UECgw2VGhlIE1pbmlzdHJ5IG9mIERpZ2l0YWwgRGV2ZWxvcG1lbnQg
YW5kIENvbW11bmljYXRpb25zMSAwHgYDVQQDDBdSdXNzaWFuIFRydXN0ZWQgUm9v
dCBDQTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAMfFOZ8pUAL3+r2n
qqE0Zp52selXsKGFYoG0GM5bwz1bSFtCt+AZQMhkWQheI3poZAToYJu69pHLKS6Q
XBiwBC1cvzYmUYKMYZC7jE5YhEU2bSL0mX7NaMxMDmH2/NwuOVRj8OImVa5s1F4U
zn4Kv3PFlDBjjSjXKVY9kmjUBsXQrIHeaqmUIsPIlNWUnimXS0I0abExqkbdrXbX
YwCOXhOO2pDUx3ckmJlCMUGacUTnylyQW2VsJIyIGA8V0xzdaeUXg0VZ6ZmNUr5Y
Ber/EAOLPb8NYpsAhJe2mXjMB/J9HNsoFMBFJ0lLOT/+dQvjbdRZoOT8eqJpWnVD
U+QL/qEZnz57N88OWM3rabJkRNdU/Z7x5SFIM9FrqtN8xewsiBWBI0K6XFuOBOTD
4V08o4TzJ8+Ccq5XlCUW2L48pZNCYuBDfBh7FxkB7qDgGDiaftEkZZfApRg2E+M9
G8wkNKTPLDc4wH0FDTijhgxR3Y4PiS1HL2Zhw7bD3CbslmEGgfnnZojNkJtcLeBH
BLa52/dSwNU4WWLubaYSiAmA9IUMX1/RpfpxOxd4Ykmhz97oFbUaDJFipIggx5sX
ePAlkTdWnv+RWBxlJwMQ25oEHmRguNYf4Zr/Rxr9cS93Y+mdXIZaBEE0KS2iLRqa
OiWBki9IMQU4phqPOBAaG7A+eP8PAgMBAAGjZjBkMB0GA1UdDgQWBBTh0YHlzlpf
BKrS6badZrHF+qwshzAfBgNVHSMEGDAWgBTh0YHlzlpfBKrS6badZrHF+qwshzAS
BgNVHRMBAf8ECDAGAQH/AgEEMA4GA1UdDwEB/wQEAwIBhjANBgkqhkiG9w0BAQsF
AAOCAgEAALIY1wkilt/urfEVM5vKzr6utOeDWCUczmWX/RX4ljpRdgF+5fAIS4vH
tmXkqpSCOVeWUrJV9QvZn6L227ZwuE15cWi8DCDal3Ue90WgAJJZMfTshN4OI8cq
W9E4EG9wglbEtMnObHlms8F3CHmrw3k6KmUkWGoa+/ENmcVl68u/cMRl1JbW2bM+
/3A+SAg2c6iPDlehczKx2oa95QW0SkPPWGuNA/CE8CpyANIhu9XFrj3RQ3EqeRcS
AQQod1RNuHpfETLU/A2gMmvn/w/sx7TB3W5BPs6rprOA37tutPq9u6FTZOcG1Oqj
C/B7yTqgI7rbyvox7DEXoX7rIiEqyNNUguTk/u3SZ4VXE2kmxdmSh3TQvybfbnXV
4JbCZVaqiZraqc7oZMnRoWrXRG3ztbnbes/9qhRGI7PqXqeKJBztxRTEVj8ONs1d
WN5szTwaPIvhkhO3CO5ErU2rVdUr89wKpNXbBODFKRtgxUT70YpmJ46VVaqdAhOZ
D9EUUn4YaeLaS8AjSF/h7UkjOibNc4qVDiPP+rkehFWM66PVnP1Msh93tc+taIfC
EYVMxjh8zNbFuoc7fzvvrFILLe7ifvEIUqSVIC/AzplM/Jxw7buXFeGP1qVCBEHq
391d/9RAfaZ12zkwFsl+IKwE/OZxW8AHa9i1p4GO0YSNuczzEm4=
-----END CERTIFICATE-----`;

const SYSTEM_PROMPT = `Ты рабочий бот по учету морских контейнеров. Отвечай по-русски, коротко и точно.
Основные задачи:
- распознавать терминалы, количество, типы 20/40 фут, номера контейнеров;
- считать выдачи, остатки, бронь, оплаты и общие итоги;
- не задваивать одинаковые номера контейнеров;
- если данные противоречат друг другу, явно показать расхождение;
- арифметику перепроверять перед ответом;
- ничего не придумывать: если данных не хватает, так и написать.
Если пользователь присылает большой список, сначала структурируй его, затем дай итог. Если присылает продолжение, учитывай предыдущий контекст диалога.`;

const historyByChat = new Map();
const pendingByChat = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function maxRequest(path, { method = "GET", body, timeout = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${MAX_API}${path}`);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method,
      ca: RUSSIAN_TRUSTED_ROOT_CA,
      headers: {
        Authorization: MAX_BOT_TOKEN,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
        if ((res.statusCode || 500) >= 400) {
          reject(new Error(`MAX ${res.statusCode}: ${data?.message || data?.raw || "request failed"}`));
          return;
        }
        resolve(data);
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error("MAX request timeout")));
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
      try {
        await maxRequest(`/subscriptions?url=${encodeURIComponent(sub.url)}`, { method: "DELETE" });
      } catch (e) {
        console.warn("Could not remove webhook:", e.message);
      }
    }
  } catch (e) {
    console.warn("Webhook check skipped:", e.message);
  }
}

function getChatKey(update) {
  const m = update?.message;
  return String(m?.recipient?.chat_id ?? update?.chat_id ?? m?.sender?.user_id ?? update?.user?.user_id ?? "unknown");
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
  const response = await fetch(OPENAI_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
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
  let rest = text.trim();
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
  for (const chunk of splitMessage(text)) await maxRequest(`/messages?${q}`, { method: "POST", body: { text: chunk } });
}

async function flushChat(chatKey) {
  const pending = pendingByChat.get(chatKey);
  if (!pending) return;
  pendingByChat.delete(chatKey);
  const joined = pending.texts.join("\n");
  const normalized = joined.trim().toLowerCase();
  if (["/reset", "reset", "сброс", "сбросить"].includes(normalized)) {
    historyByChat.delete(chatKey);
    await sendMessage(pending.message, "Контекст сброшен. Присылай новые данные.");
    return;
  }
  try {
    const answer = await askOpenAI(chatKey, joined);
    const history = historyByChat.get(chatKey) || [];
    history.push({ role: "user", content: joined }, { role: "assistant", content: answer });
    historyByChat.set(chatKey, trimHistory(history));
    await sendMessage(pending.message, answer);
  } catch (e) {
    console.error("Processing error:", e);
    await sendMessage(pending.message, `Ошибка обработки: ${e.message}`).catch(() => {});
  }
}

function queueMessage(update) {
  const m = update?.message;
  const text = m?.body?.text;
  if (!text || typeof text !== "string" || m?.sender?.is_bot) return;
  const chatKey = getChatKey(update);
  const existing = pendingByChat.get(chatKey);
  if (existing?.timer) clearTimeout(existing.timer);
  const pending = existing || { texts: [], message: m };
  pending.texts.push(text);
  pending.message = m;
  pending.timer = setTimeout(() => void flushChat(chatKey), 2500);
  pendingByChat.set(chatKey, pending);
}

async function handleUpdate(update) {
  if (update?.update_type === "message_created") queueMessage(update);
  if (update?.update_type === "bot_started" && update.user?.user_id != null) {
    await maxRequest(`/messages?user_id=${encodeURIComponent(update.user.user_id)}`, {
      method: "POST",
      body: { text: "Готов. Присылай данные по контейнерам или большой список — посчитаю и сведу итоги." },
    }).catch((e) => console.warn("Welcome failed:", e.message));
  }
}

async function pollForever() {
  let marker = null;
  let first = true;
  while (true) {
    try {
      const p = new URLSearchParams({ limit: "100", timeout: "30", types: "message_created,bot_started" });
      if (!first && marker != null) p.set("marker", String(marker));
      const data = await maxRequest(`/updates?${p}`, { timeout: 40000 });
      first = false;
      if (data?.marker != null) marker = data.marker;
      for (const update of data?.updates || []) await handleUpdate(update);
    } catch (e) {
      console.error("Polling error:", e.message);
      await sleep(2500);
    }
  }
}

async function main() {
  const me = await maxRequest("/me");
  console.log(`MAX bot authorized: ${me?.first_name || me?.username || me?.user_id || "OK"}`);
  await clearWebhookSubscriptions();
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("MAX учет бот работает\n");
  }).listen(PORT, "0.0.0.0", () => console.log(`Health server listening on ${PORT}`));
  await pollForever();
}

main().catch((e) => { console.error("Fatal error:", e); process.exit(1); });
