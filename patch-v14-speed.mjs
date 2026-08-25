import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error(`speed patch anchor not found: ${label}`);
  code = code.replace(oldText, newText);
  console.log(`speed patched: ${label}`);
}

replaceOnce(
  'const privateDialog = [];',
  'const privateDialog = [];\nconst analysisCache = new Map();\nconst ANALYSIS_CACHE_TTL_MS = 30 * 60 * 1000;',
  'analysis cache storage'
);

const oldExtract = `async function extractChat(chatId, title, start, end) {
  const history = await fetchHistory(chatId, start, end, 5000); let imageCount = 0; const events = [];
  for (const part of chunkRows(history)) { const r = await extractChunkSafe(title, part); imageCount += r.imageCount; events.push(...r.events); }
  return { historyCount: history.length, imageCount, events };
}`;

const newExtract = `async function extractChat(chatId, title, start, end) {
  const key = String(chatId) + ":" + String(start ?? "all");
  const cached = analysisCache.get(key);
  if (cached && Date.now() - cached.at < ANALYSIS_CACHE_TTL_MS) {
    return { ...cached.value, cacheHit: true };
  }

  const history = await fetchHistory(chatId, start, end, 5000);
  let imageCount = 0;
  const events = [];
  for (const part of chunkRows(history)) {
    const r = await extractChunkSafe(title, part);
    imageCount += r.imageCount;
    events.push(...r.events);
  }
  const value = { historyCount: history.length, imageCount, events };
  analysisCache.set(key, { at: Date.now(), value });
  return { ...value, cacheHit: false };
}`;

replaceOnce(oldExtract, newExtract, 'reuse extracted accounting events');

replaceOnce(
  'if (eventChatId != null) await rememberGroup(eventChatId);\n      return;',
  'if (eventChatId != null) { await rememberGroup(eventChatId); analysisCache.clear(); historyCache.clear(); }\n      return;',
  'invalidate cache on new group data'
);

replaceOnce(
  'if (type === "message_removed") historyCache.clear();',
  'if (type === "message_removed") { historyCache.clear(); analysisCache.clear(); }',
  'invalidate cache on removed messages'
);

replaceOnce(
  'privateDialog.length = 0;\n      historyCache.clear();',
  'privateDialog.length = 0;\n      historyCache.clear();\n      analysisCache.clear();',
  'reset analysis cache on user reset'
);

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v48-fast-accounting-cache",');

fs.writeFileSync(path, code);
console.log("fast accounting cache v48 enabled");
