import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error("v63 anchor not found: " + label);
  code = code.replace(oldText, newText);
  console.log("v63 patched: " + label);
}

const oldSend = '  await sendTextFileToUser(senderId, filename, text, (mode === "new" ? "Новые сообщения" : "История чата") + ": " + rows.length + " шт.");';
const newSend = `  const stored = await ledgerRequest("/export-store", { method: "POST", body: { filename, text }, timeout: 60000 });\n  if (!stored?.url) throw new Error("Worker не вернул ссылку экспорта");\n  await sendText("user_id=" + encodeURIComponent(senderId), (mode === "new" ? "Новые сообщения" : "История чата") + ": " + rows.length + " шт.\\n\\nСкачать TXT:\\n" + stored.url + "\\n\\nСсылка действует 30 минут.");`;
replaceOnce(oldSend, newSend, "export via Worker download link");

const oldCheckpointGet = '    const data = await ledgerRequest("/state?chat_id=" + encodeURIComponent(chatId), { timeout: 20000 });';
const newCheckpointGet = '    const data = await ledgerRequest("/export-state?chat_id=" + encodeURIComponent(chatId), { timeout: 20000 });';
replaceOnce(oldCheckpointGet, newCheckpointGet, "dedicated export checkpoint read");

const oldCheckpointReturn = '    return { ms: Number(data?.state?.export_checkpoint_ms || 0), mid: String(data?.state?.export_checkpoint_mid || "") };';
replaceOnce(oldCheckpointReturn, oldCheckpointReturn, "checkpoint shape validation");

const oldCheckpointSave = `  let current = null;\n  try { current = await ledgerRequest("/state?chat_id=" + encodeURIComponent(chatId), { timeout: 20000 }); } catch {}\n  return ledgerRequest("/state", { method: "POST", body: { chat_id: String(chatId), state: { ...(current?.state || {}), export_checkpoint_ms: Number(ms || 0), export_checkpoint_mid: String(mid || "") } }, timeout: 30000 });`;
const newCheckpointSave = `  return ledgerRequest("/export-state", { method: "POST", body: { chat_id: String(chatId), export_checkpoint_ms: Number(ms || 0), export_checkpoint_mid: String(mid || "") }, timeout: 30000 });`;
replaceOnce(oldCheckpointSave, newCheckpointSave, "dedicated export checkpoint write");

code = code.replace(/version:\s*"v[^"]+"\s*,?/, 'version: "v63-safe-ledger-export",');
if (code.includes('historyExportFiles: true,') && !code.includes('safeLedgerSummary: true,')) {
  code = code.replace('historyExportFiles: true,', 'historyExportFiles: true,\n  safeLedgerSummary: true,\n  exportDownloadLink: true,\n  recapAnonymousSuppression: true,');
}

fs.writeFileSync(path, code);
console.log("v63 safe ledger/export link enabled");
