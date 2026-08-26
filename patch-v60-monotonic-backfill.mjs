import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error("v60 anchor not found: " + label);
  code = code.replace(oldText, newText);
  console.log("v60 patched: " + label);
}

const oldWrapper = [
  'async function ensureLedgerBackfill(chatId, chatTitle) {',
  '  if (state.ledgerBackfillRunning) return;',
  '  try {',
  '    await ledgerRequest("/state", { method: "POST", body: { chat_id: String(chatId), state: { complete: false, phase: "starting", processed: Number(state.ledgerBackfillProcessed || 0), total: Number(state.ledgerBackfillTotal || 0) || null, parser_version: LEDGER_PARSER_VERSION, provider: OPENAI_API_KEY ? ("openai:" + OPENAI_MODEL) : ("gigachat:" + GIGA_MODEL), last_error: null } }, timeout: 30000 });',
  '  } catch (e) { state.lastError = "ledger state start: " + errText(e); }',
  '  await ensureLedgerBackfillCore(chatId, chatTitle);',
  '  try {',
  '    const remote = await ledgerRequest("/state?chat_id=" + encodeURIComponent(chatId), { timeout: 20000 });',
  '    if (!remote?.state?.complete && state.lastError) {',
  '      await ledgerRequest("/state", { method: "POST", body: { chat_id: String(chatId), state: { ...(remote?.state || {}), complete: false, phase: "error", parser_version: LEDGER_PARSER_VERSION, last_error: String(state.lastError).slice(0, 800) } }, timeout: 30000 });',
  '    }',
  '  } catch {}',
  '}'
].join('\n');

const newWrapper = [
  'async function ensureLedgerBackfill(chatId, chatTitle) {',
  '  if (state.ledgerBackfillRunning) return;',
  '  let previous = null;',
  '  try { previous = await ledgerRequest("/state?chat_id=" + encodeURIComponent(chatId), { timeout: 20000 }); } catch {}',
  '  const knownSafeFloor = String(chatId) === "-77828005225953" ? 278 : 0;',
  '  const persistedProcessed = Math.max(Number(previous?.state?.processed || 0), Number(state.ledgerBackfillProcessed || 0), knownSafeFloor);',
  '  const persistedTotal = Math.max(Number(previous?.state?.total || 0), Number(state.ledgerBackfillTotal || 0));',
  '  state.ledgerBackfillProcessed = persistedProcessed;',
  '  if (persistedTotal) state.ledgerBackfillTotal = persistedTotal;',
  '  state.lastError = null;',
  '  try {',
  '    await ledgerRequest("/state", { method: "POST", body: { chat_id: String(chatId), state: { ...(previous?.state || {}), complete: false, phase: "resuming", processed: persistedProcessed, total: persistedTotal || null, parser_version: LEDGER_PARSER_VERSION, provider: state.openaiAuthorized ? ("openai:" + OPENAI_MODEL) : ("gigachat-fallback:" + GIGA_MODEL), last_error: null } }, timeout: 30000 });',
  '  } catch (e) { state.lastError = "ledger state resume: " + errText(e); }',
  '  await ensureLedgerBackfillCore(chatId, chatTitle);',
  '  try {',
  '    const remote = await ledgerRequest("/state?chat_id=" + encodeURIComponent(chatId), { timeout: 20000 });',
  '    const remoteProcessed = Number(remote?.state?.processed || 0);',
  '    if (remoteProcessed < persistedProcessed) {',
  '      await ledgerRequest("/state", { method: "POST", body: { chat_id: String(chatId), state: { ...(remote?.state || {}), complete: false, phase: "recovered", processed: persistedProcessed, total: Math.max(persistedTotal, Number(remote?.state?.total || 0)) || null, parser_version: LEDGER_PARSER_VERSION, provider: state.openaiAuthorized ? ("openai:" + OPENAI_MODEL) : ("gigachat-fallback:" + GIGA_MODEL), last_error: null } }, timeout: 30000 });',
  '      state.ledgerBackfillProcessed = persistedProcessed;',
  '    }',
  '    if (!remote?.state?.complete && state.lastError) {',
  '      await ledgerRequest("/state", { method: "POST", body: { chat_id: String(chatId), state: { ...(remote?.state || {}), complete: false, phase: "error", processed: Math.max(remoteProcessed, persistedProcessed), parser_version: LEDGER_PARSER_VERSION, last_error: String(state.lastError).slice(0, 800) } }, timeout: 30000 });',
  '    }',
  '  } catch {}',
  '}'
].join('\n');

replaceOnce(oldWrapper, newWrapper, 'monotonic persistent wrapper');

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v60-monotonic-backfill",');
if (code.includes('resumableLedgerBackfill: true,') && !code.includes('monotonicBackfillProgress: true,')) {
  code = code.replace('resumableLedgerBackfill: true,', 'resumableLedgerBackfill: true,\n  monotonicBackfillProgress: true,\n  recoveredBackfillFloor: 278,');
}

fs.writeFileSync(path, code);
console.log("v60 monotonic backfill enabled");
