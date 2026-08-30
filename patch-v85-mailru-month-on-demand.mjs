import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

code = code.replace(
  "while (mailIndexCache.size > 3) mailIndexCache.delete(mailIndexCache.keys().next().value);",
  "while (mailIndexCache.size > 24) mailIndexCache.delete(mailIndexCache.keys().next().value);"
);

const start = code.indexOf("function handleMailIndexHttp(url, res) {");
const end = code.indexOf("\n\nasync function runMailruIndexForUser", start);
if (start < 0 || end < 0) throw new Error("v85 monthly HTTP handler anchor not found");

const replacement = String.raw`function handleMailIndexHttp(url, res) {
  const month = String(url.searchParams.get("month") || "");
  const win = parseMailMonth(month);
  if (!win) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: "invalid_month", month }));
    return;
  }

  const item = mailIndexCache.get(win.key);
  if (!item) {
    if (!mailIndexRunning.has(win.key)) {
      mailIndexRunning.add(win.key);
      void buildMailruIndex(win.key)
        .catch((error) => console.error("Mail.ru on-demand index failed", win.key, errText(error)))
        .finally(() => mailIndexRunning.delete(win.key));
    }

    const format = url.searchParams.get("format") === "csv" ? "CSV" : "JSON";
    res.writeHead(202, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "5",
    });
    res.end(
      '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Mail.ru — индекс строится</title></head>' +
      '<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:24px;line-height:1.45">' +
      '<h2>Индекс Mail.ru за ' + win.key + ' восстанавливается</h2>' +
      '<p>Формат: ' + format + '. Страница обновится автоматически. Ничего нажимать не нужно.</p>' +
      '<p>Если писем много, это может занять несколько минут.</p></body></html>'
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

code = code.slice(0, start) + replacement + code.slice(end);

if (code.includes("mailYearParallel: true,") && !code.includes("mailIndexOnDemand: true,")) {
  code = code.replace("mailYearParallel: true,", "mailYearParallel: true,\n  mailIndexOnDemand: true,");
}
code = code.replace('version: "v83-mailru-year-parallel"', 'version: "v85-mailru-month-on-demand"');

fs.writeFileSync(path, code);
console.log("v85 Mail.ru monthly on-demand rebuild enabled");
