import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

const historyPattern = /async function mediaFetchAllHistory\(since = 0\) \{[\s\S]*?\n\}\nfunction mediaHistoryText/;
if (!historyPattern.test(code)) {
  throw new Error("v69 media history fetch anchor not found");
}

const historyReplacement = String.raw`async function mediaFetchAllHistory(since = 0, until = 0, maxRows = 5000) {
  const chatId = String(SEEDED_CHAT_IDS[0] || "-77828005225953");
  const hardLimit = Math.max(1, Math.min(5000, Number(maxRows || 5000)));
  const out = [];
  let before = until > 0 ? Math.max(1, until - 1) : Date.now();
  for (let page = 0; page < 50 && out.length < hardLimit; page++) {
    const q = new URLSearchParams({ chat_id: chatId, count: "100", from: String(before) });
    if (since > 0) q.set("to", String(since));
    const data = await maxRequest("/messages?" + q.toString(), { timeout: 60000 });
    const items = data?.messages || data?.items || [];
    if (!items.length) break;
    out.push(...items);
    const times = items.map(mediaMessageTime).filter(Boolean);
    const oldest = times.length ? Math.min(...times) : 0;
    if (!oldest || items.length < 100 || (since > 0 && oldest <= since)) break;
    before = oldest - 1;
  }
  const byId = new Map();
  for (const m of out) byId.set(mediaMessageId(m) || String(mediaMessageTime(m)) + ":" + byId.size, m);
  let rows = [...byId.values()].filter((m) => {
    const timestamp = mediaMessageTime(m);
    if (since > 0 && timestamp < since) return false;
    if (until > 0 && timestamp >= until) return false;
    return true;
  }).sort((a, b) => mediaMessageTime(a) - mediaMessageTime(b));
  if (rows.length > hardLimit) rows = rows.slice(rows.length - hardLimit);
  return rows;
}
function mediaHistoryText`;
code = code.replace(historyPattern, historyReplacement);

code = code.replace(
  "function mediaHistoryText(rows, mode, since) {",
  "function mediaHistoryText(rows, mode, since, until = 0) {"
);
code = code.replace(
  '    ...(since ? ["Начиная с: " + mediaLocalStamp(since)] : []),',
  '    ...(since ? ["Начиная с: " + mediaLocalStamp(since)] : []),\n    ...(until ? ["До: " + mediaLocalStamp(until - 1)] : []),'
);

const oldRangeBlock = [
  '  const mode = url.searchParams.get("mode") === "new" ? "new" : "all";',
  '  const since = mode === "new" ? Math.max(0, Number(url.searchParams.get("since") || 0)) : 0;',
  '  const rows = await mediaFetchAllHistory(since);'
].join("\n");
const newRangeBlock = [
  '  const mode = url.searchParams.get("mode") === "new" ? "new" : "all";',
  '  let since = mode === "new" ? Math.max(0, Number(url.searchParams.get("since") || 0)) : 0;',
  '  const explicitFrom = Math.max(0, Number(url.searchParams.get("from") || 0));',
  '  if (explicitFrom > 0) since = Math.max(since, explicitFrom);',
  '  const until = Math.max(0, Number(url.searchParams.get("to") || 0));',
  '  const maxRows = Math.max(1, Math.min(5000, Number(url.searchParams.get("limit") || 5000)));',
  '  if (until > 0 && since > 0 && until <= since) throw new Error("Неверный период выгрузки");',
  '  const rows = await mediaFetchAllHistory(since, until, maxRows);'
].join("\n");
if (!code.includes(oldRangeBlock)) {
  throw new Error("v69 media handler range anchor not found");
}
code = code.replace(oldRangeBlock, newRangeBlock);

code = code.replace(
  'mediaHistoryText(rows, mode, since)',
  'mediaHistoryText(rows, mode, since, until)'
);

const oldFilename = '  const filename = (mode === "new" ? "max_new_media_" : "max_history_media_") + mediaFileStamp(Date.now()) + ".zip";';
const newFilename = [
  '  const periodSuffix = (since || until)',
  '    ? mediaFileStamp(since || Date.now()).slice(0, 10) + "_" + mediaFileStamp((until || Date.now()) - (until ? 1 : 0)).slice(0, 10)',
  '    : mediaFileStamp(Date.now());',
  '  const filename = (mode === "new" ? "max_new_media_" : "max_history_media_") + periodSuffix + ".zip";'
].join("\n");
if (!code.includes(oldFilename)) {
  throw new Error("v69 media filename anchor not found");
}
code = code.replace(oldFilename, newFilename);

code = code.replace(
  '    "X-MAX-Archive-Version": "v68-streaming"',
  '    "X-MAX-Archive-Version": "v69-date-range",\n    "X-MAX-From": String(since || 0),\n    "X-MAX-To": String(until || 0)'
);

const commandAnchor = '  if (/^экспорт\\s+(?:с\\s+фото|с\\s+картинками|медиа|media)$/i.test(text)) {';
if (!code.includes(commandAnchor)) {
  throw new Error("v69 media command anchor not found");
}

const rangeCommand = String.raw`
  const mediaRangeMatch = text.match(/^экспорт\s+(?:с\s+фото|с\s+картинками|медиа|media)\s+(?:за\s+)?(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?(?:\s*(?:-|по)\s*(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?)?$/i);
  if (mediaRangeMatch) {
    try {
      const nowLocal = new Date(Date.now() + TZ_OFFSET_MINUTES * 60000);
      const currentYear = nowLocal.getUTCFullYear();
      const normalizeYear = (value, fallback) => {
        if (!value) return fallback;
        const numeric = Number(value);
        return numeric < 100 ? 2000 + numeric : numeric;
      };
      const startDay = Number(mediaRangeMatch[1]);
      const startMonth = Number(mediaRangeMatch[2]);
      const startYear = normalizeYear(mediaRangeMatch[3], currentYear);
      const endDay = Number(mediaRangeMatch[4] || mediaRangeMatch[1]);
      const endMonth = Number(mediaRangeMatch[5] || mediaRangeMatch[2]);
      const endYear = normalizeYear(mediaRangeMatch[6], startYear);
      const fromMs = Date.UTC(startYear, startMonth - 1, startDay) - TZ_OFFSET_MINUTES * 60000;
      const toMs = Date.UTC(endYear, endMonth - 1, endDay + 1) - TZ_OFFSET_MINUTES * 60000;
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
        throw new Error("неверно указан период");
      }
      const exportKey = createHash("sha256").update(MAX_BOT_TOKEN).digest("hex").slice(0, 32);
      const exportOrigin = WEBHOOK_URL ? new URL(WEBHOOK_URL).origin : "https://max-uchet-bot-gaina.irina-gaina-84-036.workers.dev";
      const exportUrl = exportOrigin + "/export/media?t=" + encodeURIComponent(exportKey)
        + "&mode=all&from=" + encodeURIComponent(String(fromMs))
        + "&to=" + encodeURIComponent(String(toMs))
        + "&limit=5000";
      const label = String(startDay).padStart(2, "0") + "." + String(startMonth).padStart(2, "0") + "." + startYear
        + (fromMs + 86400000 === toMs ? "" : " — " + String(endDay).padStart(2, "0") + "." + String(endMonth).padStart(2, "0") + "." + endYear);
      await sendText("user_id=" + encodeURIComponent(senderId), "ZIP с перепиской и картинками за " + label + ":\n\n" + exportUrl);
    } catch (e) {
      state.lastError = "dated media export: " + errText(e);
      await sendText("user_id=" + encodeURIComponent(senderId), "Не удалось подготовить выгрузку за период: " + errText(e).slice(0, 700));
    }
    return;
  }
`;
code = code.replace(commandAnchor, rangeCommand + "\n" + commandAnchor);

code = code.replace(/version:\s*"v[^"]+"\s*,?/, 'version: "v69-date-range-media-export",');
fs.writeFileSync(path, code);
console.log("v69 date-range media export enabled");
