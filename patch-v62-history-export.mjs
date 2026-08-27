import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error("v62 anchor not found: " + label);
  code = code.replace(oldText, newText);
  console.log("v62 patched: " + label);
}

const helpers = String.raw`
function exportPad2(value) { return String(value).padStart(2, "0"); }
function exportLocalStamp(ms) {
  const d = new Date(Number(ms || Date.now()) + TZ_OFFSET_MINUTES * 60000);
  return exportPad2(d.getUTCDate()) + "." + exportPad2(d.getUTCMonth() + 1) + "." + d.getUTCFullYear() + " " + exportPad2(d.getUTCHours()) + ":" + exportPad2(d.getUTCMinutes()) + ":" + exportPad2(d.getUTCSeconds());
}
function exportFileStamp(ms = Date.now()) {
  const d = new Date(Number(ms) + TZ_OFFSET_MINUTES * 60000);
  return d.getUTCFullYear() + "-" + exportPad2(d.getUTCMonth() + 1) + "-" + exportPad2(d.getUTCDate()) + "_" + exportPad2(d.getUTCHours()) + "-" + exportPad2(d.getUTCMinutes());
}
function exportAttachmentSummary(message) {
  const list = attachments(message);
  if (!list.length) return "";
  const lines = [];
  const walk = (value, urls, names, depth = 0) => {
    if (depth > 5 || value == null) return;
    if (Array.isArray(value)) { for (const item of value) walk(item, urls, names, depth + 1); return; }
    if (typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      const k = String(key).toLowerCase();
      if ((k === "url" || k.endsWith("_url")) && typeof item === "string" && /^https?:\/\//i.test(item)) urls.add(item);
      if (["filename", "file_name", "name", "title"].includes(k) && typeof item === "string" && item.length <= 300) names.add(item);
      if (k.includes("token") || k.includes("secret") || k.includes("authorization")) continue;
      walk(item, urls, names, depth + 1);
    }
  };
  for (const a of list) {
    const urls = new Set(); const names = new Set(); walk(a, urls, names);
    let line = String(a?.type || "attachment");
    if (names.size) line += " | " + [...names].join(", ");
    if (urls.size) line += " | " + [...urls].slice(0, 8).join(" | ");
    lines.push(line);
  }
  return lines.join("\n");
}
function buildHistoryExportText(chatId, chatTitle, rows, mode, checkpointMs = 0) {
  const out = [];
  out.push("MAX — экспорт рабочей переписки");
  out.push("Чат: " + chatTitle);
  out.push("chat_id: " + chatId);
  out.push("Режим: " + (mode === "new" ? "только новые сообщения" : "вся история"));
  out.push("Сформировано: " + exportLocalStamp(Date.now()));
  if (mode === "new" && checkpointMs) out.push("После контрольной точки: " + exportLocalStamp(checkpointMs));
  out.push("Сообщений: " + rows.length);
  out.push("");
  for (const m of rows) {
    const text = msgText(m).trim();
    const reply = replyInfo(m);
    const media = exportAttachmentSummary(m);
    out.push("============================================================");
    out.push("Дата: " + exportLocalStamp(msgTime(m) || Date.now()));
    out.push("Автор: " + (senderName(m) || "не указан"));
    out.push("message_id: " + (msgId(m) || "не указан"));
    if (reply) out.push(reply);
    out.push("Текст:");
    out.push(text || "[без текста]");
    if (media) { out.push("Вложения:"); out.push(media); }
    out.push("");
  }
  return out.join("\n");
}
async function getHistoryExportCheckpoint(chatId) {
  try {
    const data = await ledgerRequest("/export-state?chat_id=" + encodeURIComponent(chatId), { timeout: 20000 });
    return { ms: Number(data?.state?.export_checkpoint_ms || 0), mid: String(data?.state?.export_checkpoint_mid || "") };
  } catch { return { ms: 0, mid: "" }; }
}
async function saveHistoryExportCheckpoint(chatId, ms, mid) {
  return ledgerRequest("/export-state", { method: "POST", body: { chat_id: String(chatId), export_checkpoint_ms: Number(ms || 0), export_checkpoint_mid: String(mid || "") }, timeout: 30000 });
}
async function uploadTextFileToMax(filename, text) {
  const slot = await maxRequest("/uploads?type=file", { method: "POST", timeout: 30000 });
  if (!slot?.url) throw new Error("MAX не вернул URL загрузки файла");
  const boundary = "----maxbot" + Date.now().toString(16) + Math.random().toString(16).slice(2);
  const safeName = String(filename || "max_history.txt").replace(/[\r\n\"]+/g, "_");
  const head = Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"data\"; filename=\"" + safeName + "\"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n", "utf8");
  const body = Buffer.from(String(text || ""), "utf8");
  const tail = Buffer.from("\r\n--" + boundary + "--\r\n", "utf8");
  const payload = Buffer.concat([head, body, tail]);
  const uploaded = await requestJson(slot.url, { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=" + boundary }, body: payload, timeout: 120000 });
  const token = uploaded?.data?.token || uploaded?.data?.payload?.token || uploaded?.data?.retval?.token || slot?.token;
  if (!token) throw new Error("MAX загрузил файл, но не вернул token");
  return String(token);
}
async function sendTextFileToUser(userId, filename, text, caption) {
  const token = await uploadTextFileToMax(filename, text);
  const body = { text: caption || filename, attachments: [{ type: "file", payload: { token } }] };
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (attempt) await sleep([1200, 2200, 4000, 7000, 10000][attempt]);
      return await maxRequest("/messages?user_id=" + encodeURIComponent(userId), { method: "POST", body, timeout: 45000 });
    } catch (e) {
      lastError = e;
      if (!/attachment\.not\.ready|not\.processed|not ready/i.test(errText(e))) throw e;
    }
  }
  throw lastError || new Error("Не удалось отправить экспортный файл");
}
async function handleHistoryExportCommand(senderId, mode) {
  const chatId = String(SEEDED_CHAT_IDS[0] || "");
  if (!chatId) { await sendText("user_id=" + encodeURIComponent(senderId), "Рабочий чат не настроен."); return; }
  const meta = knownGroups.get(chatId);
  const chatTitle = meta?.title || ("чат " + chatId);
  let checkpoint = { ms: 0, mid: "" };
  let since = null;
  if (mode === "new") {
    checkpoint = await getHistoryExportCheckpoint(chatId);
    if (!checkpoint.ms) {
      await sendText("user_id=" + encodeURIComponent(senderId), "Сначала отправь «Экспорт истории». После этого «Экспорт новых» будет отдавать только новые сообщения.");
      return;
    }
    since = checkpoint.ms + 1;
  }
  await sendText("user_id=" + encodeURIComponent(senderId), mode === "new" ? "Собираю новые сообщения в файл…" : "Собираю всю историю чата в файл…");
  const rows = await fetchHistory(chatId, since, Date.now(), 5000);
  if (!rows.length) {
    await sendText("user_id=" + encodeURIComponent(senderId), mode === "new" ? "После прошлого экспорта новых сообщений нет." : "В рабочем чате сообщений для экспорта не найдено.");
    return;
  }
  const text = buildHistoryExportText(chatId, chatTitle, rows, mode, checkpoint.ms);
  const filename = (mode === "new" ? "max_new_" : "max_history_") + exportFileStamp() + ".txt";
  await sendTextFileToUser(senderId, filename, text, (mode === "new" ? "Новые сообщения" : "История чата") + ": " + rows.length + " шт.");
  const latest = rows.reduce((best, row) => msgTime(row) >= msgTime(best) ? row : best, rows[0]);
  await saveHistoryExportCheckpoint(chatId, msgTime(latest) || Date.now(), msgId(latest));
}
`;

replaceOnce('async function sendText(recipient, text) {', helpers + '\nasync function sendText(recipient, text) {', 'history export helpers');

const privateLine = '  const text = normalizeText(msgText(message)); const imgs = imageUrls(message); if (!text && !imgs.length) return;';
const privateReplacement = privateLine + String.raw`
  if (/^экспорт\s+(?:истории|чата|всей\s+истории)$/i.test(text)) {
    try { await handleHistoryExportCommand(senderId, "all"); }
    catch (e) { state.lastError = "history export: " + errText(e); await sendText("user_id=" + encodeURIComponent(senderId), "Не удалось выгрузить историю: " + errText(e).slice(0, 700)); }
    return;
  }
  if (/^экспорт\s+нов(?:ых|ое)$/i.test(text)) {
    try { await handleHistoryExportCommand(senderId, "new"); }
    catch (e) { state.lastError = "new export: " + errText(e); await sendText("user_id=" + encodeURIComponent(senderId), "Не удалось выгрузить новые сообщения: " + errText(e).slice(0, 700)); }
    return;
  }`;
replaceOnce(privateLine, privateReplacement, 'private export commands');

// v61 briefly emitted a version property without its comma. This replacement also repairs that generated text.
code = code.replace(/version:\s*"v[^"]+"\s*,?/, 'version: "v62-history-export",');
if (code.includes('calendarDateWindows: true,') && !code.includes('historyExportFiles: true,')) {
  code = code.replace('calendarDateWindows: true,', 'calendarDateWindows: true,\n  historyExportFiles: true,\n  incrementalHistoryExport: true,');
}

fs.writeFileSync(path, code);
console.log("v62 MAX history export enabled");
