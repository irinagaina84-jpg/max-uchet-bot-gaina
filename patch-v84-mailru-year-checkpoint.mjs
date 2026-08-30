import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

const start = code.indexOf('async function buildMailruYearIndex(year, onProgress = null) {');
const end = code.indexOf('\nfunction handleMailYearHttp', start);
if (start < 0 || end < 0) throw new Error('v84 year function anchors not found');

const replacement = String.raw`
function mailYearCheckpointUrl(year, month = "") {
  const key = createHash("sha256").update(MAX_BOT_TOKEN).digest("hex").slice(0, 32);
  const origin = WEBHOOK_URL ? new URL(WEBHOOK_URL).origin : "https://max-uchet-bot-gaina.irina-gaina-84-036.workers.dev";
  let url = origin + "/mail/checkpoint?t=" + encodeURIComponent(key) + "&year=" + encodeURIComponent(String(year));
  if (month) url += "&month=" + encodeURIComponent(String(month));
  return url;
}

async function loadMailYearCheckpointMeta(year) {
  const response = await fetch(mailYearCheckpointUrl(year), { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error("checkpoint meta HTTP " + response.status + ": " + text.slice(0, 300));
  let data = null;
  try { data = JSON.parse(text); } catch { throw new Error("checkpoint meta returned invalid JSON"); }
  return Array.isArray(data?.months) ? data.months : [];
}

async function loadMailYearMonthCheckpoint(year, month) {
  const response = await fetch(mailYearCheckpointUrl(year, month), { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error("checkpoint " + month + " HTTP " + response.status + ": " + text.slice(0, 300));
  try { return JSON.parse(text); }
  catch { throw new Error("checkpoint " + month + " returned invalid JSON"); }
}

async function saveMailYearMonthCheckpoint(year, month, result) {
  const body = JSON.stringify(result);
  const response = await fetch(mailYearCheckpointUrl(year, month), {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Accept: "application/json" },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error("checkpoint save " + month + " HTTP " + response.status + ": " + text.slice(0, 300));
  return true;
}

async function buildMailruYearIndex(year, onProgress = null) {
  const months = mailYearMonths(year);
  if (!months.length) throw new Error("год должен быть не позже текущего, например 2025 или 2026");

  const savedMeta = await loadMailYearCheckpointMeta(year);
  const savedByMonth = new Map(
    savedMeta
      .filter((item) => months.includes(String(item?.month || "")))
      .map((item) => [String(item.month), item])
  );
  const localResults = new Map();
  const pending = months.filter((month) => !savedByMonth.has(month));
  let completed = savedByMonth.size;
  let totalMessages = [...savedByMonth.values()].reduce((sum, item) => sum + Number(item?.messages || 0), 0);
  let totalAttachments = [...savedByMonth.values()].reduce((sum, item) => sum + Number(item?.attachments || 0), 0);
  let cursor = 0;
  const concurrency = Math.min(3, pending.length);

  if (completed && typeof onProgress === "function") {
    await onProgress({
      completed,
      total: months.length,
      month: "сохранено ранее",
      result: null,
      totalMessages,
      totalAttachments,
      resumed: true,
    });
  }

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= pending.length) return;
      const month = pending[index];
      const result = await buildMailruIndex(month);

      // This write is the durability boundary: only after it succeeds do we
      // count the month as complete. A container restart can then resume it.
      await saveMailYearMonthCheckpoint(year, month, result);
      localResults.set(month, result);
      savedByMonth.set(month, { month, messages: result.messages, attachments: result.attachments });
      completed += 1;
      totalMessages += Number(result?.messages || 0);
      totalAttachments += Number(result?.attachments || 0);

      if (typeof onProgress === "function") {
        await onProgress({
          completed,
          total: months.length,
          month,
          result,
          totalMessages,
          totalAttachments,
          resumed: false,
        });
      }
    }
  };

  if (concurrency > 0) await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const rowsById = new Map();
  const monthStats = [];
  const folderErrors = [];
  for (const month of months) {
    const result = localResults.get(month) || await loadMailYearMonthCheckpoint(year, month);
    monthStats.push({ month, messages: Number(result?.messages || 0), attachments: Number(result?.attachments || 0) });
    for (const error of Array.isArray(result?.folderErrors) ? result.folderErrors : []) {
      folderErrors.push(month + ": " + error);
    }
    for (const row of Array.isArray(result?.rows) ? result.rows : []) {
      const key = String(row?.messageId || "").trim().toLowerCase()
        || (String(row?.folder || "") + ":" + String(row?.uid || ""));
      if (!rowsById.has(key)) rowsById.set(key, row);
    }
  }

  const rows = [...rowsById.values()].sort((a, b) => String(a?.date || "").localeCompare(String(b?.date || "")));
  const attachmentCount = rows.reduce((sum, row) => sum + (Array.isArray(row?.attachments) ? row.attachments.length : 0), 0);
  const payload = {
    version: "mailru-year-index-v3-checkpoint",
    year: Number(year),
    builtAt: new Date().toISOString(),
    messages: rows.length,
    attachments: attachmentCount,
    months: monthStats,
    note: "Годовой индекс содержит заголовки, текст писем и метаданные вложений. Сами вложения не скачаны. Каждый завершённый месяц сохранён и переживает перезапуск контейнера.",
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

const oldProgress = String.raw`    const result = await buildMailruYearIndex(year, async ({ completed, total, month, result: monthResult }) => {
      totalMessages += Number(monthResult?.messages || 0);
      totalAttachments += Number(monthResult?.attachments || 0);
      if (completed >= 1) {
        await sendText(
          "user_id=" + encodeURIComponent(senderId),
          yearKey + ": готово " + completed + "/" + total + " месяцев (последний " + month + "). Пока найдено: " + totalMessages + " писем / " + totalAttachments + " вложений."
        );
      }
    });`;
const newProgress = String.raw`    const result = await buildMailruYearIndex(year, async ({ completed, total, month, result: monthResult, totalMessages: savedMessages, totalAttachments: savedAttachments, resumed }) => {
      totalMessages = Number(savedMessages || 0);
      totalAttachments = Number(savedAttachments || 0);
      await sendText(
        "user_id=" + encodeURIComponent(senderId),
        yearKey + ": готово " + completed + "/" + total + " месяцев (" + (resumed ? "продолжаю с сохранённого прогресса" : "последний " + month) + "). Пока найдено: " + totalMessages + " писем / " + totalAttachments + " вложений."
      );
    });`;
if (!code.includes(oldProgress)) throw new Error('v84 progress callback anchor not found');
code = code.replace(oldProgress, newProgress);

if (code.includes('mailYearParallel: true,') && !code.includes('mailYearCheckpoint: true,')) {
  code = code.replace('mailYearParallel: true,', 'mailYearParallel: true,\n  mailYearCheckpoint: true,');
}
code = code.replace(/version:\s*"v83-mailru-year-parallel"\s*,?/, 'version: "v84-mailru-year-checkpoint",');

fs.writeFileSync(path, code);
console.log('v84 Mail.ru durable yearly checkpoint enabled');
