import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error("ledger-safety anchor not found: " + label);
  code = code.replace(oldText, newText);
  console.log("ledger-safety patched: " + label);
}

replaceOnce(
  'const LEDGER_PARSER_VERSION = "v56-ledger-parser";',
  'const LEDGER_PARSER_VERSION = "v56-ledger-parser-2";',
  'parser version'
);

const oldFn = [
  'async function writeLedgerEvents(chatId, rows, events) {',
  '  const rowMap = new Map(rows.map((row) => [msgId(row), row]));',
  '  const byMid = new Map(rows.map((row) => [msgId(row), []]));',
  '  for (const e of events || []) {',
  '    const mid = String(e?.source_mid || ""); if (!byMid.has(mid)) continue; const row = rowMap.get(mid);',
  '    byMid.get(mid).push({ ...e, effective_time_ms: Number(e?.effective_time_ms || msgTime(row) || Date.now()), source_text: msgText(row), parser_version: LEDGER_PARSER_VERSION });',
  '  }',
  '  for (const [mid, list] of byMid) await ledgerRequest("/events", { method: "POST", body: { chat_id: String(chatId), source_mid: mid, events: list }, timeout: 60000 });',
  '  state.ledgerLastWriteAt = new Date().toISOString();',
  '}'
].join('\n');

const newFn = [
  'async function writeLedgerEvents(chatId, rows, events, forceMids = []) {',
  '  const rowMap = new Map(rows.map((row) => [msgId(row), row]));',
  '  const byMid = new Map();',
  '  for (const forced of forceMids || []) { const mid = String(forced || ""); if (mid && rowMap.has(mid)) byMid.set(mid, []); }',
  '  for (const e of events || []) {',
  '    const mid = String(e?.source_mid || ""); if (!rowMap.has(mid)) continue; const row = rowMap.get(mid);',
  '    if (!byMid.has(mid)) byMid.set(mid, []);',
  '    byMid.get(mid).push({ ...e, effective_time_ms: Number(e?.effective_time_ms || msgTime(row) || Date.now()), source_text: msgText(row), parser_version: LEDGER_PARSER_VERSION });',
  '  }',
  '  for (const [mid, list] of byMid) await ledgerRequest("/events", { method: "POST", body: { chat_id: String(chatId), source_mid: mid, events: list }, timeout: 60000 });',
  '  state.ledgerLastWriteAt = new Date().toISOString();',
  '}'
].join('\n');

replaceOnce(oldFn, newFn, 'safe event replacement');

replaceOnce(
  'const events = await extractLedgerChunk(chatTitle, rows); await writeLedgerEvents(chatId, rows, events); state.ledgerReady = true;',
  'const events = await extractLedgerChunk(chatTitle, rows); await writeLedgerEvents(chatId, rows, events, [mid]); state.ledgerReady = true;',
  'only current message may be cleared on reparse'
);

fs.writeFileSync(path, code);
console.log("Ledger overlap safety enabled");
