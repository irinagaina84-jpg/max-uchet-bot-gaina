import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error("v63 anchor not found: " + label);
  code = code.replace(oldText, newText);
  console.log("v63 patched: " + label);
}

if (code.includes('import { randomUUID } from "node:crypto";')) {
  code = code.replace('import { randomUUID } from "node:crypto";', 'import { randomUUID, createHash } from "node:crypto";');
}

const oldSend = '  await sendTextFileToUser(senderId, filename, text, (mode === "new" ? "Новые сообщения" : "История чата") + ": " + rows.length + " шт.");';
const newSend = `  const exportKey = createHash("sha256").update(MAX_BOT_TOKEN).digest("hex").slice(0, 32);\n  const exportOrigin = WEBHOOK_URL ? new URL(WEBHOOK_URL).origin : "https://max-uchet-bot-gaina.irina-gaina-84-036.workers.dev";\n  const exportUrl = exportOrigin + "/export/history?t=" + encodeURIComponent(exportKey) + "&mode=" + encodeURIComponent(mode) + (mode === "new" && checkpoint.ms ? "&since=" + encodeURIComponent(String(checkpoint.ms + 1)) : "");\n  await sendText("user_id=" + encodeURIComponent(senderId), (mode === "new" ? "Новые сообщения" : "История чата") + ": " + rows.length + " шт.\\n\\nСкачать TXT:\\n" + exportUrl);`;
replaceOnce(oldSend, newSend, "direct protected export link");

const summaryPattern = /async function ledgerSummary\(question\) \{[\s\S]*?\n\}\n\nfunction formatLedgerSummary/;
if (!summaryPattern.test(code)) throw new Error("v63 ledgerSummary not found");
const safeSummary = String.raw`async function ledgerSummary(question) {
  const win = requestedWindow(question);
  const params = new URLSearchParams({ chat_id: String(SEEDED_CHAT_IDS[0] || "") });
  if (win.start) params.set("from", String(win.start));
  if (win.end) params.set("to", String(win.end));
  const q = normalizeText(question);
  const tm = q.match(/(Купавн\w*|Чехов\w*|СВС|SVS|Союз\s*Плюс|Шубино|Тетрис\s*Юг|Жуковск\w*)/i);
  if (tm) params.set("terminal", tm[1]);
  const rm = q.match(/релиз(?:а|у|ом|ы)?\s+([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]{2,40})/i);
  if (rm) params.set("release", "Релиз " + rm[1]);

  const data = await ledgerRequest("/events?" + params.toString(), { timeout: 30000 });
  const events = Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : [];
  const activeNumbers = new Map();
  const anonymous = [];
  const seenAnon = new Set();
  let uncertainDelta = 0;
  const recapRx = /(^|\b)(итого|всего|общий итог|остаток|осталось|по терминалам|за все время|за всё время|на текущий момент|на сегодня выдано|выдано всего|уже выдано)\b/i;
  const norm = (v) => String(v || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  const addMap = (map, key, qty) => map.set(key || "Не указан", (map.get(key || "Не указан") || 0) + qty);

  for (const e of events) {
    if (!e?.count_as_issued) continue;
    const delta = Math.trunc(Number(e.delta_quantity || 0));
    if (!delta) continue;
    if (e.uncertain) { uncertainDelta += delta; continue; }
    const numbers = [...new Set((e.container_numbers || []).map((x) => String(x || "").toUpperCase().replace(/[^A-Z0-9]/g, "")).filter(Boolean))];
    const sign = delta > 0 ? 1 : -1;
    for (const number of numbers) {
      if (sign > 0) activeNumbers.set(number, e);
      else activeNumbers.delete(number);
    }
    let remaining = Math.max(0, Math.abs(delta) - numbers.length);
    if (!remaining) continue;

    const source = norm(e.source_text);
    if (sign > 0 && recapRx.test(source)) continue;

    const exactKey = [sign, remaining, norm(e.terminal), norm(e.container_type), norm(e.release_name), norm(e.release_code), source].join("|");
    if (sign > 0 && source && seenAnon.has(exactKey)) continue;
    if (sign > 0 && source) seenAnon.add(exactKey);
    anonymous.push({ ...e, signed_quantity: sign * remaining });
  }

  const byTerminal = new Map();
  const byType = new Map();
  for (const e of activeNumbers.values()) { addMap(byTerminal, e.terminal, 1); addMap(byType, e.container_type, 1); }
  let anonymousTotal = 0;
  for (const e of anonymous) {
    anonymousTotal += Number(e.signed_quantity || 0);
    addMap(byTerminal, e.terminal, Number(e.signed_quantity || 0));
    addMap(byType, e.container_type, Number(e.signed_quantity || 0));
  }
  let backfill = null;
  try { backfill = (await ledgerRequest("/state?chat_id=" + encodeURIComponent(String(SEEDED_CHAT_IDS[0] || "")), { timeout: 15000 }))?.state || null; } catch {}
  const summary = {
    ok: true,
    total: activeNumbers.size + anonymousTotal,
    numbered_total: activeNumbers.size,
    anonymous_total: anonymousTotal,
    uncertain_delta: uncertainDelta,
    by_terminal: Object.fromEntries([...byTerminal.entries()].filter(([,v]) => v).sort((a,b) => b[1]-a[1])),
    by_type: Object.fromEntries([...byType.entries()].filter(([,v]) => v).sort((a,b) => b[1]-a[1])),
    active_container_numbers: [...activeNumbers.keys()],
    event_count: events.length,
    backfill,
    safe_mode: true
  };
  state.ledgerLastSummaryTotal = summary.total;
  return summary;
}

function formatLedgerSummary`;
code = code.replace(summaryPattern, safeSummary);
console.log("v63 patched: safe deterministic ledger totals");

code = code.replace(/version:\s*"v[^"]+"\s*,?/, 'version: "v63-safe-ledger-export",');
if (code.includes('historyExportFiles: true,') && !code.includes('safeLedgerSummary: true,')) {
  code = code.replace('historyExportFiles: true,', 'historyExportFiles: true,\n  safeLedgerSummary: true,\n  exportDownloadLink: true,\n  recapAnonymousSuppression: true,');
}

fs.writeFileSync(path, code);
console.log("v63 safe ledger/export link enabled");
