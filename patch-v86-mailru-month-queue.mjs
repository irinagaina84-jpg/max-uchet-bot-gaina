import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

const httpStart = code.indexOf('function handleMailIndexHttp(url, res) {');
const runStart = code.indexOf('\n\nasync function runMailruIndexForUser', httpStart);
if (httpStart < 0 || runStart < 0) throw new Error('v86 monthly HTTP anchors not found');

const queuedHttp = String.raw`const mailIndexJobState = new Map();
const mailIndexQueue = [];
let mailIndexQueueActive = false;

function enqueueMailIndex(monthKey) {
  const win = parseMailMonth(monthKey);
  if (!win) return { status: "error", error: "invalid_month" };
  if (mailIndexCache.has(win.key)) {
    const done = { status: "done", month: win.key, finishedAt: Date.now() };
    mailIndexJobState.set(win.key, done);
    return done;
  }
  const existing = mailIndexJobState.get(win.key);
  if (existing?.status === "queued" || existing?.status === "running") return existing;

  const job = { status: "queued", month: win.key, queuedAt: Date.now(), startedAt: null, finishedAt: null, error: null };
  mailIndexJobState.set(win.key, job);
  mailIndexQueue.push(win.key);
  void processMailIndexQueue();
  return job;
}

async function processMailIndexQueue() {
  if (mailIndexQueueActive) return;
  mailIndexQueueActive = true;
  try {
    while (mailIndexQueue.length) {
      const month = mailIndexQueue.shift();
      if (!month) continue;
      if (mailIndexCache.has(month)) {
        mailIndexJobState.set(month, { status: "done", month, finishedAt: Date.now() });
        continue;
      }
      const job = mailIndexJobState.get(month) || { month };
      job.status = "running";
      job.startedAt = Date.now();
      job.error = null;
      mailIndexJobState.set(month, job);
      try {
        await buildMailruIndex(month);
        job.status = "done";
        job.finishedAt = Date.now();
      } catch (error) {
        job.status = "error";
        job.finishedAt = Date.now();
        job.error = errText(error).slice(0, 800);
        console.error("Mail.ru queued month failed", month, job.error);
      }
      mailIndexJobState.set(month, job);
    }
  } finally {
    mailIndexQueueActive = false;
  }
}

function handleMailIndexHttp(url, res) {
  const month = String(url.searchParams.get("month") || "");
  const win = parseMailMonth(month);
  if (!win) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: "invalid_month", month }));
    return;
  }

  const item = mailIndexCache.get(win.key);
  if (!item) {
    const job = enqueueMailIndex(win.key);
    const pos = Math.max(0, mailIndexQueue.indexOf(win.key));
    const isRunning = job?.status === "running";
    const isError = job?.status === "error";
    const title = isError ? "Ошибка построения" : isRunning ? "Индекс строится" : "Индекс в очереди";
    const detail = isError
      ? String(job?.error || "неизвестная ошибка")
      : isRunning
        ? "Mail.ru обрабатывает этот месяц."
        : "Перед ним в очереди: " + String(pos) + ".";
    res.writeHead(isError ? 503 : 202, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "5",
    });
    res.end(
      '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Mail.ru — ' + win.key + '</title></head>' +
      '<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:24px;line-height:1.45">' +
      '<h2>' + title + ': ' + win.key + '</h2><p>' + detail + '</p>' +
      '<p>Месяцы обрабатываются строго по одному, чтобы Mail.ru не зависала. Страница обновляется автоматически.</p></body></html>'
    );
    return;
  }

  const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
  const body = format === "csv" ? item.csv : item.json;
  const ext = format === "csv" ? "csv" : "json";
  const type = format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Disposition": 'attachment; filename="mailru-index-' + win.key + '.' + ext + '"',
    "Cache-Control": "no-store",
  });
  res.end(body);
}`;

code = code.slice(0, httpStart) + queuedHttp + code.slice(runStart);

const userStart = code.indexOf('async function runMailruIndexForUser(senderId, month) {');
const userEnd = code.indexOf('\n}\n\nasync function handlePrivate', userStart);
if (userStart < 0 || userEnd < 0) throw new Error('v86 user command anchors not found');

const userReplacement = String.raw`async function runMailruIndexForUser(senderId, month) {
  const win = parseMailMonth(month);
  if (!win) {
    await sendText("user_id=" + encodeURIComponent(senderId), "Укажи месяц так: Почта индекс 2026-01");
    return;
  }
  try {
    const exportKey = createHash("sha256").update(MAX_BOT_TOKEN).digest("hex").slice(0, 32);
    const exportOrigin = WEBHOOK_URL ? new URL(WEBHOOK_URL).origin : "https://max-uchet-bot-gaina.irina-gaina-84-036.workers.dev";
    const base = exportOrigin + "/mail/index?t=" + encodeURIComponent(exportKey) + "&month=" + encodeURIComponent(win.key);
    await sendText(
      "user_id=" + encodeURIComponent(senderId),
      "Mail.ru " + win.key + ".\nОткрой JSON — если месяц ещё не готов, он автоматически встанет в очередь и построится.\n\nJSON для анализа:\n" + base + "&format=json" +
      "\n\nCSV для реестра:\n" + base + "&format=csv" +
      "\n\nМесяцы обрабатываются по одному. Не запускай несколько одновременно."
    );
  } catch (error) {
    await sendText("user_id=" + encodeURIComponent(senderId), "Не получилось подготовить ссылки Mail.ru: " + errText(error).slice(0, 900));
  }
}`;

code = code.slice(0, userStart) + userReplacement + code.slice(userEnd + 2);

if (code.includes("mailIndexOnDemand: true,") && !code.includes("mailIndexQueue: true,")) {
  code = code.replace("mailIndexOnDemand: true,", "mailIndexOnDemand: true,\n  mailIndexQueue: true,\n  mailIndexLinkMode: true,");
}
code = code.replace('version: "v85-mailru-month-on-demand"', 'version: "v86-mailru-month-queue"');

fs.writeFileSync(path, code);
console.log("v86 Mail.ru monthly queue and link mode enabled");
