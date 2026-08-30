import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function mustReplace(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error("v79 anchor not found: " + label);
  code = code.replace(oldText, newText);
  console.log("v79 patched: " + label);
}

const ledgerAnchor = "async function ledgerSummary(question) {";
if (!code.includes(ledgerAnchor)) throw new Error("v79 ledgerSummary anchor not found");

const helpers = String.raw`
function groupNorm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9-]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GROUP_STOP_WORDS = new Set(["чат", "чата", "группа", "группы", "рабочий", "рабочая", "вывоз", "учет", "учёт"]);

function wantsAllGroups(question) {
  const q = groupNorm(question);
  return q.includes("все чаты")
    || q.includes("всех чат")
    || q.includes("все группы")
    || q.includes("всех групп")
    || q.includes("по всем")
    || q.includes("общая сводка по чатам")
    || q.includes("общий итог по чатам");
}

function groupScore(question, chatId, meta) {
  const q = groupNorm(question);
  const id = String(chatId || "");
  const title = groupNorm(meta?.title || "");
  let score = 0;

  if (id && (q.includes(id) || q.includes(id.replace(/^-/, "")))) score += 1000;
  if (title && q.includes(title)) score += 300;

  const tokens = title.split(" ").filter((token) => token.length >= 4 && !GROUP_STOP_WORDS.has(token));
  for (const token of tokens) {
    if (q.includes(token)) score += 80;
    else if (token.length >= 6 && q.includes(token.slice(0, 5))) score += 40;
  }

  // Stable aliases for the currently connected operational chats.
  if (title.includes("взлет") && (q.includes("взлет") || q.includes("амиди"))) score += 200;
  if (title.includes("амиди") && q.includes("амиди")) score += 200;
  if ((title.includes("констэво") || title.includes("констево")) && (q.includes("констэво") || q.includes("констево"))) score += 220;

  return score;
}

function workGroupsForQuestion(question) {
  const entries = [...knownGroups.entries()];
  if (!entries.length) return [];
  if (wantsAllGroups(question)) return entries;
  if (entries.length === 1) return entries;

  const scored = entries
    .map((entry) => ({ entry, score: groupScore(question, entry[0], entry[1]) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return [];
  const best = scored[0].score;
  const winners = scored.filter((item) => item.score === best);
  return winners.length === 1 ? [winners[0].entry] : [];
}

function groupClarificationText() {
  const rows = [...knownGroups.entries()].map(([id, meta]) => "• " + (meta?.title || ("чат " + id)) + " (" + id + ")");
  return "У меня подключено несколько рабочих групп. Чтобы не смешивать данные, укажи группу в вопросе:\n" + rows.join("\n") + "\n\nНапример: «Итог по Взлёт-Амиди» или «Итог по Констэво». Для общей сводки напиши: «По всем группам».";
}
`;

if (!code.includes("function workGroupsForQuestion(question)")) {
  code = code.replace(ledgerAnchor, helpers + "\n" + ledgerAnchor);
}

mustReplace(
  '  const params = new URLSearchParams({ chat_id: String(SEEDED_CHAT_IDS[0] || "") });',
  '  const selectedGroups = workGroupsForQuestion(question);\n  if (selectedGroups.length !== 1) throw new Error(groupClarificationText());\n  const [selectedChatId, selectedChatMeta] = selectedGroups[0];\n  const params = new URLSearchParams({ chat_id: String(selectedChatId) });',
  "ledger selects requested group"
);

mustReplace(
  '  const summary = {\n    ok: true,',
  '  const summary = {\n    ok: true,\n    chat_id: String(selectedChatId),\n    chat_title: selectedChatMeta?.title || ("чат " + selectedChatId),',
  "ledger result carries group"
);

mustReplace(
  '  const lines = ["Итого выдано: " + Number(summary?.total || 0) + " шт."];',
  '  const lines = [];\n  if (summary?.chat_title) lines.push("Чат: " + summary.chat_title);\n  lines.push("Итого выдано: " + Number(summary?.total || 0) + " шт.");',
  "summary labels group"
);

// Narrow full-history semantic analysis to exactly one named group unless the
// owner explicitly asks for all groups. Never silently merge unrelated chats.
const answerStart = code.indexOf("async function answerWorkQuestion(question) {");
const answerEnd = code.indexOf("\nasync function sendText(", answerStart);
if (answerStart < 0 || answerEnd < 0) throw new Error("v79 answerWorkQuestion block not found");
let answerBlock = code.slice(answerStart, answerEnd);

if (!answerBlock.includes("const selectedWorkGroups = workGroupsForQuestion(question);")) {
  const initOld = 'state.lastError = null; const { start, end } = requestedWindow(question); const extractions = [];';
  const initNew = 'state.lastError = null; const { start, end } = requestedWindow(question); const extractions = [];\n  const selectedWorkGroups = workGroupsForQuestion(question);\n  if (!selectedWorkGroups.length) return groupClarificationText();\n  const groupContextKey = selectedWorkGroups.map(([id]) => String(id)).sort().join(",");';
  if (!answerBlock.includes(initOld)) throw new Error("v79 answer init anchor not found");
  answerBlock = answerBlock.replace(initOld, initNew);

  const loopOld = 'for (const [chatId, meta] of knownGroups) {';
  if (!answerBlock.includes(loopOld)) throw new Error("v79 answer groups loop not found");
  answerBlock = answerBlock.replace(loopOld, 'for (const [chatId, meta] of selectedWorkGroups) {');

  const dialogOld = 'const dialogContext = privateDialog.slice(-6).map((x) => `${x.role}: ${x.text}`).join("\\n");';
  const dialogNew = 'const dialogContext = privateDialog.filter((x) => x.group_key === groupContextKey).slice(-6).map((x) => `${x.role}: ${x.text}`).join("\\n");';
  if (!answerBlock.includes(dialogOld)) throw new Error("v79 dialog context anchor not found");
  answerBlock = answerBlock.replace(dialogOld, dialogNew);

  const pushOld = 'privateDialog.push({ role: "user", text: question }, { role: "assistant", text: answer }); if (privateDialog.length > 12) privateDialog.splice(0, privateDialog.length - 12);';
  const pushNew = 'privateDialog.push({ role: "user", text: question, group_key: groupContextKey }, { role: "assistant", text: answer, group_key: groupContextKey }); if (privateDialog.length > 40) privateDialog.splice(0, privateDialog.length - 40);';
  if (!answerBlock.includes(pushOld)) throw new Error("v79 dialog push anchor not found");
  answerBlock = answerBlock.replace(pushOld, pushNew);
}
code = code.slice(0, answerStart) + answerBlock + code.slice(answerEnd);

// Exact ID/release lookups are also narrowed when the question names a group.
const lookupStart = code.indexOf("async function exactLookup(question) {");
const lookupEnd = code.indexOf("\nasync function answerWorkQuestion(question) {", lookupStart);
if (lookupStart >= 0 && lookupEnd > lookupStart) {
  let lookupBlock = code.slice(lookupStart, lookupEnd);
  const lookupLoop = 'for (const [chatId, meta] of knownGroups) {';
  if (lookupBlock.includes(lookupLoop) && !lookupBlock.includes("lookupGroups")) {
    lookupBlock = lookupBlock.replace(
      '  const hits = [];',
      '  const hits = [];\n  const selected = workGroupsForQuestion(question);\n  const lookupGroups = selected.length ? selected : [...knownGroups.entries()];'
    );
    lookupBlock = lookupBlock.replace(lookupLoop, 'for (const [chatId, meta] of lookupGroups) {');
    code = code.slice(0, lookupStart) + lookupBlock + code.slice(lookupEnd);
  }
}

// Background ledger backfill must follow the selected group, never the first
// seeded chat.
const backfillOld = 'if (!summary?.backfill?.complete) { const primaryChat = SEEDED_CHAT_IDS[0]; const meta = knownGroups.get(String(primaryChat)); if (primaryChat) ensureLedgerBackfill(primaryChat, meta?.title || ("чат " + primaryChat)).catch((e) => { state.lastError = "ledger background: " + errText(e); }); }';
const backfillNew = 'if (!summary?.backfill?.complete) { const primaryChat = summary?.chat_id; const meta = knownGroups.get(String(primaryChat)); if (primaryChat) ensureLedgerBackfill(primaryChat, meta?.title || summary?.chat_title || ("чат " + primaryChat)).catch((e) => { state.lastError = "ledger background: " + errText(e); }); }';
if (code.includes(backfillOld)) code = code.replace(backfillOld, backfillNew);
else console.warn("v79 backfill anchor not found; continuing");

code = code.replace(/version:\s*"v[^"]+"\s*,?/, 'version: "v79-group-isolation",');
if (code.includes("mailruIndex: true,") && !code.includes("groupIsolation: true,")) {
  code = code.replace("mailruIndex: true,", "mailruIndex: true,\n  groupIsolation: true,");
}

fs.writeFileSync(path, code);
console.log("v79 group isolation enabled");
