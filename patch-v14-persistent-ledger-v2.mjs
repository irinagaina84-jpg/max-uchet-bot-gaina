import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error("ledger-v2 anchor not found: " + label);
  code = code.replace(oldText, newText);
  console.log("ledger-v2 patched: " + label);
}

function replaceRegex(pattern, replacement, label) {
  if (!pattern.test(code)) throw new Error("ledger-v2 regex anchor not found: " + label);
  code = code.replace(pattern, replacement);
  console.log("ledger-v2 patched: " + label);
}

replaceOnce(
  'const WEBHOOK_URL = (process.env.MAX_WEBHOOK_URL || "").trim();',
  'const WEBHOOK_URL = (process.env.MAX_WEBHOOK_URL || "").trim();\nconst LEDGER_URL = (process.env.LEDGER_URL || "").trim();\nconst DEFAULT_CUSTOMER = (process.env.DEFAULT_CUSTOMER || "Взлёт").trim();\nconst LEDGER_PARSER_VERSION = "v56-ledger-parser";',
  'ledger env'
);

replaceOnce(
  'lastError: null,',
  'lastError: null,\n  ledgerMode: true,\n  ledgerReady: false,\n  ledgerBackfillRunning: false,\n  ledgerBackfillProcessed: 0,\n  ledgerBackfillTotal: 0,\n  ledgerLastWriteAt: null,\n  ledgerLastSummaryTotal: null,',
  'ledger diagnostics'
);

const schemaBlock = [
  'const LEDGER_EVENT_SCHEMA = {',
  '  type: "object",',
  '  properties: {',
  '    events: { type: "array", items: { type: "object", properties: {',
  '      source_mid: { type: "string" },',
  '      event_type: { type: "string", enum: ["release","confirmed_issue","cancellation","correction","context"] },',
  '      count_as_issued: { type: "boolean" },',
  '      delta_quantity: { type: "integer" },',
  '      customer: { type: ["string","null"] }, supplier: { type: ["string","null"] }, terminal: { type: ["string","null"] },',
  '      container_type: { type: ["string","null"] }, container_numbers: { type: "array", items: { type: "string" } },',
  '      release_name: { type: ["string","null"] }, release_code: { type: ["string","null"] },',
  '      effective_time_ms: { type: ["integer","null"] }, uncertain: { type: "boolean" }, notes: { type: ["string","null"] }',
  '    }, required: ["source_mid","event_type","count_as_issued","delta_quantity","customer","supplier","terminal","container_type","container_numbers","release_name","release_code","effective_time_ms","uncertain","notes"], additionalProperties: false } }',
  '  },',
  '  required: ["events"],',
  '  additionalProperties: false',
  '};',
  ''
].join('\n');
replaceOnce('const EVENT_SCHEMA = {', schemaBlock + 'const EVENT_SCHEMA = {', 'ledger schema');

const helpers = [
  'async function ledgerRequest(pathname, { method = "GET", body = null, timeout = 60000 } = {}) {',
  '  if (!LEDGER_URL) throw new Error("LEDGER_URL is not configured");',
  '  const base = LEDGER_URL.replace(/\\/$/, "");',
  '  const url = pathname.startsWith("http") ? pathname : base + pathname;',
  '  const headers = { "X-Internal-Auth": MAX_BOT_TOKEN, Accept: "application/json" };',
  '  if (body != null) headers["Content-Type"] = "application/json";',
  '  const r = await requestJson(url, { method, headers, body: body == null ? null : JSON.stringify(body), timeout });',
  '  return r.data;',
  '}',
  '',
  'function messageToRaw(chatId, m) {',
  '  return { chat_id: String(chatId), mid: msgId(m), timestamp: msgTime(m) || Date.now(), text: msgText(m), sender: m?.sender || null, recipient: m?.recipient || null, body: m?.body || null, attachments: attachments(m) };',
  '}',
  '',
  'function ledgerPrompt(chatTitle) {',
  '  return DOMAIN_RULES + "\\n\\nПРАВИЛА ПОСТОЯННОГО ЖУРНАЛА:\\n" +',
  '    "- Преобразуй переписку в журнал событий. Для каждого события укажи source_mid.\\n" +',
  '    "- Конкретный опубликованный релиз/выпуск считаем оперативной выдачей, если далее нет отмены, замены, не считать, не выдали или явного плана/брони. Для активного release count_as_issued=true и delta_quantity>0.\\n" +',
  '    "- confirmed_issue тоже count_as_issued=true, но не создавай второй плюс, если это тот же контейнер/релиз; используй номера для дедупликации.\\n" +',
  '    "- cancellation/сняли/не считать дают отрицательный delta_quantity только на реально отменяемое количество.\\n" +',
  '    "- correction сама не добавляет количество, если это исправление терминала, поставщика, имени или номера.\\n" +',
  '    "- Чехов 10 релиз Ирина = release_name Релиз Ирина, terminal Чехов, delta_quantity 10. GFM-10x20DC/p = релиз 10 x 20 DC.\\n" +',
  '    "- Шестизначные терминальные коды могут быть кодами релизов. Ответы и цитаты связывай с исходным сообщением.\\n" +',
  '    "- Если клиент явно не назван, customer=" + DEFAULT_CUSTOMER + ", потому что подключенный чат относится к этому проекту.\\n" +',
  '    "- Не придумывай количество. При неразрешенном споре uncertain=true. source_mid обязан быть реальным id строки.\\n\\nНазвание чата: " + chatTitle;',
  '}',
  '',
  'async function extractLedgerChunk(chatTitle, rows) {',
  '  const annotated = typeof annotateSemanticReleaseBlocks === "function" ? annotateSemanticReleaseBlocks(annotateReleaseSeries(rows)) : (typeof annotateReleaseSeries === "function" ? annotateReleaseSeries(rows) : rows);',
  '  const imageTexts = [];',
  '  for (const m of annotated) for (const url of imageUrls(m)) {',
  '    try { imageTexts.push("[message_id=" + msgId(m) + "] IMAGE: " + await describeImage(url)); }',
  '    catch (e) { imageTexts.push("[message_id=" + msgId(m) + "] IMAGE_ERROR: " + errText(e)); }',
  '  }',
  '  const transcript = annotated.map(historyContextLine).join("\\n");',
  '  const parsed = await gigaJson([',
  '    { role: "system", content: ledgerPrompt(chatTitle) },',
  '    { role: "user", content: "Хронология:\\n" + transcript + "\\n\\nКартинки:\\n" + (imageTexts.join("\\n") || "нет") }',
  '  ], LEDGER_EVENT_SCHEMA);',
  '  return (parsed?.events || []).map((e) => ({ ...e, parser_version: LEDGER_PARSER_VERSION }));',
  '}',
  '',
  'async function writeLedgerEvents(chatId, rows, events) {',
  '  const rowMap = new Map(rows.map((row) => [msgId(row), row]));',
  '  const byMid = new Map(rows.map((row) => [msgId(row), []]));',
  '  for (const e of events || []) {',
  '    const mid = String(e?.source_mid || ""); if (!byMid.has(mid)) continue; const row = rowMap.get(mid);',
  '    byMid.get(mid).push({ ...e, effective_time_ms: Number(e?.effective_time_ms || msgTime(row) || Date.now()), source_text: msgText(row), parser_version: LEDGER_PARSER_VERSION });',
  '  }',
  '  for (const [mid, list] of byMid) await ledgerRequest("/events", { method: "POST", body: { chat_id: String(chatId), source_mid: mid, events: list }, timeout: 60000 });',
  '  state.ledgerLastWriteAt = new Date().toISOString();',
  '}',
  '',
  'async function processMessageIntoLedger(chatId, chatTitle, message) {',
  '  const mid = msgId(message); if (!mid) return; const ts = msgTime(message) || Date.now();',
  '  await ledgerRequest("/raw", { method: "POST", body: { records: [messageToRaw(chatId, message)] }, timeout: 30000 });',
  '  const rows = await fetchHistory(chatId, Math.max(0, ts - 45 * 60 * 1000), ts + 10 * 60 * 1000, 80);',
  '  const events = await extractLedgerChunk(chatTitle, rows); await writeLedgerEvents(chatId, rows, events); state.ledgerReady = true;',
  '}',
  '',
  'async function clearMessageFromLedger(chatId, mid) {',
  '  if (!mid) return; await ledgerRequest("/events", { method: "POST", body: { chat_id: String(chatId), source_mid: String(mid), events: [] }, timeout: 30000 });',
  '}',
  '',
  'async function ledgerSummary(question) {',
  '  const win = requestedWindow(question); const params = new URLSearchParams({ chat_id: String(SEEDED_CHAT_IDS[0] || "") });',
  '  if (win.start) params.set("from", String(win.start)); if (win.end) params.set("to", String(win.end));',
  '  const q = normalizeText(question);',
  '  const tm = q.match(/(Купавн\\w*|Чехов\\w*|СВС|SVS|Союз\\s*Плюс|Шубино|Тетрис\\s*Юг|Жуковск\\w*)/i); if (tm) params.set("terminal", tm[1]);',
  '  const rm = q.match(/релиз(?:а|у|ом|ы)?\\s+([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]{2,40})/i); if (rm) params.set("release", "Релиз " + rm[1]);',
  '  return ledgerRequest("/summary?" + params.toString(), { timeout: 30000 });',
  '}',
  '',
  'function formatLedgerSummary(summary) {',
  '  const lines = ["Итого выдано: " + Number(summary?.total || 0) + " шт."];',
  '  const terminals = Object.entries(summary?.by_terminal || {}).filter(([, qty]) => Number(qty) !== 0);',
  '  if (terminals.length) { lines.push("", "По терминалам:"); for (const [name, qty] of terminals) lines.push("• " + name + " — " + qty + " шт."); }',
  '  const types = Object.entries(summary?.by_type || {}).filter(([, qty]) => Number(qty) !== 0);',
  '  if (types.length > 1) { lines.push("", "По типам:"); for (const [name, qty] of types) lines.push("• " + name + " — " + qty + " шт."); }',
  '  if (Number(summary?.uncertain_delta || 0)) lines.push("", "Отдельно спорных/неподтвержденных: " + summary.uncertain_delta + " шт. — в итог не включены.");',
  '  if (summary?.backfill && !summary.backfill.complete) lines.push("", "История ещё догружается: обработано " + (summary.backfill.processed || 0) + " из " + (summary.backfill.total || "?") + " сообщений.");',
  '  return lines.join("\\n");',
  '}',
  '',
  'async function ensureLedgerBackfill(chatId, chatTitle) {',
  '  if (state.ledgerBackfillRunning) return; let remote = null;',
  '  try { remote = await ledgerRequest("/state?chat_id=" + encodeURIComponent(chatId), { timeout: 20000 }); } catch {}',
  '  if (remote?.state?.complete && remote?.state?.parser_version === LEDGER_PARSER_VERSION) { state.ledgerReady = true; return; }',
  '  state.ledgerBackfillRunning = true;',
  '  try {',
  '    const history = await fetchHistory(chatId, null, Date.now(), 5000); state.ledgerBackfillTotal = history.length;',
  '    await ledgerRequest("/raw", { method: "POST", body: { records: history.map((m) => messageToRaw(chatId, m)) }, timeout: 120000 });',
  '    const size = OPENAI_API_KEY ? 70 : 24; const overlap = OPENAI_API_KEY ? 8 : 4; const step = Math.max(1, size - overlap);',
  '    let processed = 0;',
  '    for (let i = 0; i < history.length; i += step) {',
  '      const rows = history.slice(i, i + size); const events = await extractLedgerChunk(chatTitle, rows); await writeLedgerEvents(chatId, rows, events);',
  '      processed = Math.min(history.length, i + rows.length); state.ledgerBackfillProcessed = processed;',
  '      await ledgerRequest("/state", { method: "POST", body: { chat_id: String(chatId), state: { complete: false, processed, total: history.length, parser_version: LEDGER_PARSER_VERSION } }, timeout: 30000 });',
  '      await sleep(OPENAI_API_KEY ? 350 : 1800);',
  '    }',
  '    await ledgerRequest("/state", { method: "POST", body: { chat_id: String(chatId), state: { complete: true, processed: history.length, total: history.length, parser_version: LEDGER_PARSER_VERSION } }, timeout: 30000 });',
  '    state.ledgerReady = true;',
  '  } catch (e) { state.lastError = "ledger backfill: " + errText(e); } finally { state.ledgerBackfillRunning = false; }',
  '}',
  ''
].join('\n');
replaceOnce('function requestedWindow(question) {', helpers + 'function requestedWindow(question) {', 'ledger helpers');

replaceRegex(
  /async function handleGroupMessage\(message\) \{[\s\S]*?\}/,
  [
    'async function handleGroupMessage(message) {',
    '  const chatId = message?.recipient?.chat_id; if (chatId == null) return;',
    '  const info = await rememberGroup(chatId);',
    '  processMessageIntoLedger(chatId, info?.title || ("чат " + chatId), message).catch((e) => { state.lastError = "ledger message: " + errText(e); });',
    '  /* SILENT: nothing sent to group */',
    '}'
  ].join('\n'),
  'group writes ledger'
);

replaceOnce(
  'if (type === "bot_removed") { if (u?.chat_id != null) { knownGroups.delete(String(u.chat_id)); state.knownGroupCount = knownGroups.size; } return; }',
  'if (type === "bot_removed") { if (u?.chat_id != null) { knownGroups.delete(String(u.chat_id)); state.knownGroupCount = knownGroups.size; } return; }\n  if (type === "message_removed") { const chatId = u?.chat_id ?? u?.message?.recipient?.chat_id; const mid = u?.message?.body?.mid ?? u?.message?.mid ?? u?.message_id; if (chatId != null && mid) clearMessageFromLedger(chatId, mid).catch((e) => { state.lastError = "ledger remove: " + errText(e); }); return; }',
  'remove clears ledger source'
);

replaceOnce(
  'if (isExactLookupQuestion(text)) {',
  [
    'if (/(сколько|итог|выдан|выдач|релиз|остат|по терминал|за весь чат|за все время|за всё время)/i.test(text) && LEDGER_URL) {',
    '      try {',
    '        const summary = await ledgerSummary(text); state.ledgerLastSummaryTotal = Number(summary?.total || 0);',
    '        await sendText("user_id=" + encodeURIComponent(senderId), formatLedgerSummary(summary));',
    '        if (!summary?.backfill?.complete) { const primaryChat = SEEDED_CHAT_IDS[0]; const meta = knownGroups.get(String(primaryChat)); if (primaryChat) ensureLedgerBackfill(primaryChat, meta?.title || ("чат " + primaryChat)).catch((e) => { state.lastError = "ledger background: " + errText(e); }); }',
    '        return;',
    '      } catch (e) { state.lastError = "ledger query: " + errText(e); }',
    '    }',
    '    if (isExactLookupQuestion(text)) {'
  ].join('\n'),
  'private query uses ledger'
);

replaceOnce(
  'for (const id of SEEDED_CHAT_IDS) await rememberGroup(id);\n      await ensureWebhook();',
  'for (const id of SEEDED_CHAT_IDS) { const info = await rememberGroup(id); ensureLedgerBackfill(id, info?.title || ("чат " + id)).catch((e) => { state.lastError = "ledger startup: " + errText(e); }); }\n      await ensureWebhook();',
  'startup backfill'
);

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v56-persistent-ledger",');
code = code.replace('numericTerminalReleaseCodes: true,', 'numericTerminalReleaseCodes: true,\n  persistentAccountingLedger: true,\n  deterministicLedgerTotals: true,');

fs.writeFileSync(path, code);
console.log("Persistent accounting ledger v56 enabled");
