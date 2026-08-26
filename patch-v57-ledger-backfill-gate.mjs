import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error("v57 anchor not found: " + label);
  code = code.replace(oldText, newText);
  console.log("v57 patched: " + label);
}

replaceOnce(
  'const LEDGER_PARSER_VERSION = "v56-ledger-parser-2";',
  'const LEDGER_PARSER_VERSION = "v57-ledger-parser";',
  'parser version'
);

replaceOnce(
  'async function ensureLedgerBackfill(chatId, chatTitle) {',
  'async function ensureLedgerBackfillCore(chatId, chatTitle) {',
  'rename core backfill'
);

const wrapper = [
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
  '}',
  ''
].join('\n');

replaceOnce(
  'function requestedWindow(question) {',
  wrapper + 'function requestedWindow(question) {',
  'backfill wrapper with persistent state'
);

const oldQuery = [
  'if (/(сколько|итог|выдан|выдач|релиз|остат|по терминал|за весь чат|за все время|за всё время)/i.test(text) && LEDGER_URL) {',
  '      try {',
  '        const summary = await ledgerSummary(text); state.ledgerLastSummaryTotal = Number(summary?.total || 0);',
  '        await sendText("user_id=" + encodeURIComponent(senderId), formatLedgerSummary(summary));',
  '        if (!summary?.backfill?.complete) { const primaryChat = SEEDED_CHAT_IDS[0]; const meta = knownGroups.get(String(primaryChat)); if (primaryChat) ensureLedgerBackfill(primaryChat, meta?.title || ("чат " + primaryChat)).catch((e) => { state.lastError = "ledger background: " + errText(e); }); }',
  '        return;',
  '      } catch (e) { state.lastError = "ledger query: " + errText(e); }',
  '    }'
].join('\n');

const newQuery = [
  'if (/(сколько|итог|выдан|выдач|релиз|остат|по терминал|за весь чат|за все время|за всё время)/i.test(text) && LEDGER_URL) {',
  '      try {',
  '        const summary = await ledgerSummary(text);',
  '        const ready = Boolean(summary?.backfill?.complete) && Number(summary?.event_count || 0) > 0;',
  '        if (!ready) {',
  '          const primaryChat = SEEDED_CHAT_IDS[0]; const meta = knownGroups.get(String(primaryChat));',
  '          if (primaryChat) ensureLedgerBackfill(primaryChat, meta?.title || ("чат " + primaryChat)).catch((e) => { state.lastError = "ledger background: " + errText(e); });',
  '          const p = summary?.backfill || {};',
  '          const progress = Number(p.processed || 0); const total = Number(p.total || 0);',
  '          const phase = String(p.phase || "");',
  '          let msg = "Загружаю историю чата в журнал учёта. Пока журнал не заполнен, итоговую цифру не показываю — иначе она будет неверной.";',
  '          if (progress && total) msg += " Обработано: " + progress + " из " + total + " сообщений.";',
  '          if (phase === "error" && p.last_error) msg += " Есть ошибка загрузки, я её фиксирую в диагностике.";',
  '          await sendText("user_id=" + encodeURIComponent(senderId), msg);',
  '          return;',
  '        }',
  '        state.ledgerLastSummaryTotal = Number(summary?.total || 0);',
  '        await sendText("user_id=" + encodeURIComponent(senderId), formatLedgerSummary(summary));',
  '        return;',
  '      } catch (e) { state.lastError = "ledger query: " + errText(e); }',
  '    }'
].join('\n');

replaceOnce(oldQuery, newQuery, 'never answer from empty ledger');

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v57-ledger-backfill-gate",');
code = code.replace('deterministicLedgerTotals: true,', 'deterministicLedgerTotals: true,\n  ledgerBackfillGate: true,');

fs.writeFileSync(path, code);
console.log("v57 ledger backfill gate enabled");
