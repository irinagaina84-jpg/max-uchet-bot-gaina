import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error(`private-owner patch anchor not found: ${label}`);
  code = code.replace(oldText, newText);
  console.log(`private-owner patched: ${label}`);
}

replaceOnce(
  'async function handlePrivate(message) {\n  const senderId = String(message?.sender?.user_id || ""); if (!senderId) return;\n  if (!reportUserId) reportUserId = senderId; if (reportUserId !== senderId) return;\n  const text = normalizeText(msgText(message)); const imgs = imageUrls(message); if (!text && !imgs.length) return;',
  'async function handlePrivate(message) {\n  const senderId = String(message?.sender?.user_id || message?.recipient?.user_id || message?.recipient?.chat_id || ""); if (!senderId) return;\n  reportUserId = senderId;\n  const text = normalizeText(msgText(message)); const imgs = imageUrls(message); if (!text && !imgs.length) return;\n  state.lastPrivateSenderId = senderId;\n  state.lastPrivateText = text.slice(0, 200);\n  state.lastPrivateAt = new Date().toISOString();\n  if (/^(привет|тест|ping|пинг)$/i.test(text)) { await sendText(`user_id=${encodeURIComponent(senderId)}`, "На связи. Бот работает."); return; }',
  'accept current private sender and instant ping'
);

replaceOnce(
  'async function sendText(recipient, text) {\n  const parts = String(text || "").match(/[\\s\\S]{1,3500}/g) || [""];\n  for (const part of parts) await maxRequest(`/messages?${recipient}`, { method: "POST", body: { text: part }, timeout: 30000 });\n}',
  'async function sendText(recipient, text) {\n  const parts = String(text || "").match(/[\\s\\S]{1,3500}/g) || [""];\n  try {\n    for (const part of parts) await maxRequest(`/messages?${recipient}`, { method: "POST", body: { text: part }, timeout: 30000 });\n    state.lastSendAt = new Date().toISOString();\n    state.lastSendError = null;\n  } catch (e) {\n    state.lastSendError = errText(e);\n    throw e;\n  }\n}',
  'record outgoing MAX result'
);

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v50-private-owner",');
code = code.replace('dialogRoutingFixed: true,', 'dialogRoutingFixed: true,\n  privateOwnerFixed: true,');

fs.writeFileSync(path, code);
console.log("MAX private owner handling v50 enabled");
