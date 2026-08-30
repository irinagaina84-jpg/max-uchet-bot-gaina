import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

const start = code.indexOf('async function buildMailruYearIndex(year, onProgress = null) {');
const end = code.indexOf('\nfunction handleMailYearHttp', start);
if (start < 0 || end < 0) throw new Error('v83 year function anchors not found');

const replacement = String.raw`async function buildMailruYearIndex(year, onProgress = null) {
  const months = mailYearMonths(year);
  if (!months.length) throw new Error("год должен быть не позже текущего, например 2025 или 2026");

  const rowsById = new Map();
  const statsByMonth = new Map();
  const folderErrors = [];
  let completed = 0;
  let cursor = 0;
  const concurrency = Math.min(3, months.length);

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= months.length) return;
      const month = months[index];
      const result = await buildMailruIndex(month);
      statsByMonth.set(month, { month, messages: result.messages, attachments: result.attachments });
      for (const error of Array.isArray(result.folderErrors) ? result.folderErrors : []) {
        folderErrors.push(month + ": " + error);
      }
      for (const row of Array.isArray(result.rows) ? result.rows : []) {
        const key = String(row?.messageId || "").trim().toLowerCase()
          || (String(row?.folder || "") + ":" + String(row?.uid || ""));
        if (!rowsById.has(key)) rowsById.set(key, row);
      }
      completed += 1;
      if (typeof onProgress === "function") {
        await onProgress({ completed, total: months.length, month, result });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const rows = [...rowsById.values()].sort((a, b) => String(a?.date || "").localeCompare(String(b?.date || "")));
  const attachmentCount = rows.reduce((sum, row) => sum + (Array.isArray(row?.attachments) ? row.attachments.length : 0), 0);
  const monthStats = months.map((month) => statsByMonth.get(month) || { month, messages: 0, attachments: 0 });
  const payload = {
    version: "mailru-year-index-v2-parallel",
    year: Number(year),
    builtAt: new Date().toISOString(),
    messages: rows.length,
    attachments: attachmentCount,
    months: monthStats,
    note: "Годовой индекс содержит заголовки, текст писем и метаданные вложений. Сами вложения не скачаны.",
    folderErrors,
    rows,
  };
  const json = JSON.stringify(payload, null, 2);
  const csv = mailRowsCsv(rows);
  mailYearIndexCache.set(String(year), { payload, json, csv, builtAt: Date.now() });
  while (mailYearIndexCache.size > 2) mailYearIndexCache.delete(mailYearIndexCache.keys().next().value);
  return payload;
}`;

code = code.slice(0, start) + replacement + code.slice(end);
code = code.replace('if (completed % 3 === 0 || completed === total) {', 'if (completed >= 1) {');
if (code.includes('mailYearIndex: true,') && !code.includes('mailYearParallel: true,')) {
  code = code.replace('mailYearIndex: true,', 'mailYearIndex: true,\n  mailYearParallel: true,');
}
code = code.replace(/version:\s*"v[^"]+"\s*,?/, 'version: "v83-mailru-year-parallel",');
fs.writeFileSync(path, code);
console.log('v83 Mail.ru year parallel index enabled');
