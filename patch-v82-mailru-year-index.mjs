import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function mustReplace(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error("v82 anchor not found: " + label);
  code = code.replace(oldText, newText);
  console.log("v82 patched: " + label);
}

const monthRunnerAnchor = 'async function runMailruIndexForUser(senderId, month) {';
if (!code.includes(monthRunnerAnchor)) throw new Error("v82 month runner anchor not found");

if (!code.includes("async function runMailruYearIndexForUser")) {
  const helpers = String.raw`
const mailYearIndexCache = new Map();
const mailYearIndexRunning = new Set();

function mailYearMonths(year) {
  const value = Number(year);
  if (!Number.isInteger(value) || value < 2000 || value > 2099) return [];
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  if (value > currentYear) return [];
  const lastMonth = value === currentYear ? now.getUTCMonth() + 1 : 12;
  return Array.from({ length: lastMonth }, (_, index) => String(value) + "-" + String(index + 1).padStart(2, "0"));
}

async function buildMailruYearIndex(year, onProgress = null) {
  const months = mailYearMonths(year);
  if (!months.length) throw new Error("год должен быть не позже текущего, например 2025 или 2026");

  const rowsById = new Map();
  const monthStats = [];
  const folderErrors = [];
  let completed = 0;

  for (const month of months) {
    const result = await buildMailruIndex(month);
    completed += 1;
    monthStats.push({ month, messages: result.messages, attachments: result.attachments });
    for (const error of Array.isArray(result.folderErrors) ? result.folderErrors : []) {
      folderErrors.push(month + ": " + error);
    }
    for (const row of Array.isArray(result.rows) ? result.rows : []) {
      const key = String(row?.messageId || "").trim().toLowerCase()
        || (String(row?.folder || "") + ":" + String(row?.uid || ""));
      if (!rowsById.has(key)) rowsById.set(key, row);
    }
    if (typeof onProgress === "function") {
      await onProgress({ completed, total: months.length, month, result });
    }
  }

  const rows = [...rowsById.values()].sort((a, b) => String(a?.date || "").localeCompare(String(b?.date || "")));
  const attachmentCount = rows.reduce((sum, row) => sum + (Array.isArray(row?.attachments) ? row.attachments.length : 0), 0);
  const payload = {
    version: "mailru-year-index-v1",
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
}

function handleMailYearHttp(url, res) {
  const year = String(url.searchParams.get("year") || "");
  const item = mailYearIndexCache.get(year);
  if (!item) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: "year_index_not_built", year }));
    return;
  }
  const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
  const body = format === "csv" ? item.csv : item.json;
  const ext = format === "csv" ? "csv" : "json";
  const type = format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Disposition": 'attachment; filename="mailru-index-' + year + '.' + ext + '"',
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function runMailruYearIndexForUser(senderId, year) {
  const yearKey = String(year);
  const months = mailYearMonths(year);
  if (!months.length) {
    await sendText("user_id=" + encodeURIComponent(senderId), "Укажи год так: Почта индекс 2025");
    return;
  }
  if (mailYearIndexRunning.has(yearKey)) {
    await sendText("user_id=" + encodeURIComponent(senderId), "Индекс " + yearKey + " уже строится. Дождись итоговых ссылок.");
    return;
  }

  mailYearIndexRunning.add(yearKey);
  let totalMessages = 0;
  let totalAttachments = 0;
  try {
    await sendText(
      "user_id=" + encodeURIComponent(senderId),
      "Строю годовой индекс Mail.ru за " + yearKey + ". Проверю " + months.length + " месяцев. Читаю темы, текст писем и названия вложений; сами файлы не скачиваю."
    );

    const result = await buildMailruYearIndex(year, async ({ completed, total, month, result: monthResult }) => {
      totalMessages += Number(monthResult?.messages || 0);
      totalAttachments += Number(monthResult?.attachments || 0);
      if (completed % 3 === 0 || completed === total) {
        await sendText(
          "user_id=" + encodeURIComponent(senderId),
          yearKey + ": готово " + completed + "/" + total + " месяцев (последний " + month + "). Пока найдено: " + totalMessages + " писем / " + totalAttachments + " вложений."
        );
      }
    });

    const exportKey = createHash("sha256").update(MAX_BOT_TOKEN).digest("hex").slice(0, 32);
    const exportOrigin = WEBHOOK_URL ? new URL(WEBHOOK_URL).origin : "https://max-uchet-bot-gaina.irina-gaina-84-036.workers.dev";
    const base = exportOrigin + "/mail/year?t=" + encodeURIComponent(exportKey) + "&year=" + encodeURIComponent(yearKey);
    await sendText(
      "user_id=" + encodeURIComponent(senderId),
      "Годовой индекс " + yearKey + " готов.\nПисем: " + result.messages + "\nВложений: " + result.attachments +
      "\n\nJSON для анализа:\n" + base + "&format=json" +
      "\n\nCSV для реестра:\n" + base + "&format=csv"
    );
  } catch (error) {
    await sendText("user_id=" + encodeURIComponent(senderId), "Не получилось построить годовой индекс Mail.ru: " + errText(error).slice(0, 900));
  } finally {
    mailYearIndexRunning.delete(yearKey);
  }
}
`;
  code = code.replace(monthRunnerAnchor, helpers + "\n" + monthRunnerAnchor);
}

const oldDirect = String.raw`  const directMailIndex = text.match(/^\s*(?:почта\s+)?индекс\s+(20\d{2}-(?:0[1-9]|1[0-2]))\s*$/i);
  if (directMailIndex) {
    void runMailruIndexForUser(senderId, directMailIndex[1]);
    return;
  }`;
const newDirect = String.raw`  const directMailIndex = text.match(/^\s*(?:почта\s+)?индекс\s+(20\d{2}(?:-(?:0[1-9]|1[0-2]))?)\s*$/i);
  if (directMailIndex) {
    const period = directMailIndex[1];
    if (/^20\d{2}$/.test(period)) void runMailruYearIndexForUser(senderId, Number(period));
    else void runMailruIndexForUser(senderId, period);
    return;
  }`;
if (code.includes(oldDirect)) mustReplace(oldDirect, newDirect, "year command routing");
else if (!code.includes("runMailruYearIndexForUser(senderId")) throw new Error("v82 direct mail command anchor not found");

const httpAnchor = String.raw`  if (req.method === "GET" && mediaUrl.pathname === "/mail/index") {
    handleMailIndexHttp(mediaUrl, res);
    return;
  }`;
if (!code.includes('mediaUrl.pathname === "/mail/year"')) {
  mustReplace(httpAnchor, httpAnchor + String.raw`
  if (req.method === "GET" && mediaUrl.pathname === "/mail/year") {
    handleMailYearHttp(mediaUrl, res);
    return;
  }`, "year HTTP export");
}

if (code.includes("mailIndexAlias: true,") && !code.includes("mailYearIndex: true,")) {
  code = code.replace("mailIndexAlias: true,", "mailIndexAlias: true,\n  mailYearIndex: true,");
}

code = code.replace(/version:\s*"v[^"]+"\s*,?/, 'version: "v82-mailru-year-index",');
fs.writeFileSync(path, code);
console.log("v82 Mail.ru year index enabled");
