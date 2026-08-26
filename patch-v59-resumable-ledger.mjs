import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error("v59 anchor not found: " + label);
  code = code.replace(oldText, newText);
  console.log("v59 patched: " + label);
}

// Split only when the provider response is too long.
replaceOnce(
  'async function extractLedgerChunk(chatTitle, rows) {',
  'async function extractLedgerChunkOnce(chatTitle, rows) {',
  'rename base extractor'
);

const adaptive = [
  'function ledgerEventFingerprint(e) {',
  '  return JSON.stringify([String(e?.source_mid || ""), String(e?.event_type || ""), Number(e?.delta_quantity || 0), Boolean(e?.count_as_issued), String(e?.terminal || ""), String(e?.container_type || ""), String(e?.release_name || ""), String(e?.release_code || ""), [...(e?.container_numbers || [])].map(String).sort()]);',
  '}',
  '',
  'async function extractLedgerChunk(chatTitle, rows) {',
  '  try { return await extractLedgerChunkOnce(chatTitle, rows); }',
  '  catch (e) {',
  '    const text = errText(e);',
  '    const tooLong = /finish_reason=length|structured output incomplete|maximum context|too many tokens|context length/i.test(text);',
  '    if (!tooLong || !Array.isArray(rows) || rows.length <= 6) throw e;',
  '    const cut = Math.ceil(rows.length / 2);',
  '    const left = rows.slice(0, cut);',
  '    const right = rows.slice(cut);',
  '    const a = await extractLedgerChunk(chatTitle, left);',
  '    await sleep(state.openaiAuthorized ? 250 : 800);',
  '    const b = await extractLedgerChunk(chatTitle, right);',
  '    const seen = new Set(); const out = [];',
  '    for (const ev of [...a, ...b]) { const fp = ledgerEventFingerprint(ev); if (seen.has(fp)) continue; seen.add(fp); out.push(ev); }',
  '    return out;',
  '  }',
  '}',
  ''
].join('\n');

replaceOnce(
  'async function writeLedgerEvents(chatId, rows, events, forceMids = []) {',
  adaptive + 'async function writeLedgerEvents(chatId, rows, events, forceMids = []) {',
  'adaptive split'
);

// Resume from persisted progress. Context overlap is read-only: only source mids in the new segment may be written.
const oldLoop = [
  '    const size = OPENAI_API_KEY ? 70 : 24; const overlap = OPENAI_API_KEY ? 8 : 4; const step = Math.max(1, size - overlap);',
  '    let processed = 0;',
  '    for (let i = 0; i < history.length; i += step) {',
  '      const rows = history.slice(i, i + size); const events = await extractLedgerChunk(chatTitle, rows); await writeLedgerEvents(chatId, rows, events);',
  '      processed = Math.min(history.length, i + rows.length); state.ledgerBackfillProcessed = processed;',
  '      await ledgerRequest("/state", { method: "POST", body: { chat_id: String(chatId), state: { complete: false, processed, total: history.length, parser_version: LEDGER_PARSER_VERSION } }, timeout: 30000 });',
  '      await sleep(OPENAI_API_KEY ? 350 : 1800);',
  '    }'
].join('\n');

const newLoop = [
  '    const usingOpenAI = Boolean(state.openaiAuthorized);',
  '    const size = usingOpenAI ? 56 : 14; const overlap = usingOpenAI ? 6 : 3; const step = Math.max(1, size - overlap);',
  '    const savedProcessed = Math.max(Number(remote?.state?.processed || 0), Number(state.ledgerBackfillProcessed || 0));',
  '    let processed = Math.min(history.length, savedProcessed);',
  '    for (let newStart = processed; newStart < history.length; newStart += step) {',
  '      const contextStart = Math.max(0, newStart - overlap);',
  '      const newEnd = Math.min(history.length, newStart + step);',
  '      const contextEnd = Math.min(history.length, newEnd + overlap);',
  '      const rows = history.slice(contextStart, contextEnd);',
  '      const writable = new Set(history.slice(newStart, newEnd).map((m) => msgId(m)));',
  '      const events = (await extractLedgerChunk(chatTitle, rows)).filter((e) => writable.has(String(e?.source_mid || "")));',
  '      await writeLedgerEvents(chatId, rows, events);',
  '      processed = Math.max(processed, newEnd); state.ledgerBackfillProcessed = processed;',
  '      await ledgerRequest("/state", { method: "POST", body: { chat_id: String(chatId), state: { complete: false, phase: "running", processed, total: history.length, parser_version: LEDGER_PARSER_VERSION, provider: state.openaiAuthorized ? ("openai:" + OPENAI_MODEL) : ("gigachat-fallback:" + GIGA_MODEL), last_error: null } }, timeout: 30000 });',
  '      await sleep(state.openaiAuthorized ? 350 : 1200);',
  '    }'
].join('\n');
replaceOnce(oldLoop, newLoop, 'resume without rewriting old events');

// Do not erase a previously good error-free state with stale errors.
replaceOnce(
  '    state.ledgerReady = true;\n  } catch (e) { state.lastError = "ledger backfill: " + errText(e); } finally { state.ledgerBackfillRunning = false; }',
  '    state.ledgerReady = true; state.lastError = null;\n  } catch (e) { state.lastError = "ledger backfill: " + errText(e); } finally { state.ledgerBackfillRunning = false; }',
  'clear stale error on success'
);

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v59-resumable-ledger",');
if (code.includes('openaiQuotaFastFallback: true,') && !code.includes('resumableLedgerBackfill: true,')) {
  code = code.replace('openaiQuotaFastFallback: true,', 'openaiQuotaFastFallback: true,\n  resumableLedgerBackfill: true,\n  immutableProcessedLedger: true,\n  adaptiveLedgerChunkSplit: true,');
}

fs.writeFileSync(path, code);
console.log("v59 safe resumable ledger enabled");
