import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

const fetchHistoryReplacement = `async function fetchHistory(chatId, since, until = Date.now(), max = 5000) {
  const out = [];
  let before = Number(until || Date.now());
  for (let page = 0; page < 50 && out.length < max; page++) {
    const q = new URLSearchParams({ chat_id: String(chatId), count: "100" });
    if (page > 0 || since) q.set("from", String(before));
    if (since) q.set("to", String(since));
    const d = await maxRequest(\`/messages?\${q.toString()}\`, { timeout: 30000 });
    const items = Array.isArray(d?.messages) ? d.messages : Array.isArray(d?.items) ? d.items : [];
    if (!items.length) break;
    out.push(...items);
    const times = items.map(msgTime).filter(Boolean);
    const oldest = times.length ? Math.min(...times) : 0;
    if (!oldest || items.length < 100 || (since && oldest <= since)) break;
    before = oldest - 1;
  }
  const seen = new Set();
  return out
    .filter((m) => (!since || msgTime(m) >= since) && msgTime(m) <= until)
    .filter((m) => {
      const id = msgId(m) || String(msgTime(m)) + "|" + msgText(m);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a,b) => msgTime(a)-msgTime(b))
    .slice(-max);
}`;

const historyPattern = /async function fetchHistory\(chatId, since, until = Date\.now\(\), max = \d+\) \{[\s\S]*?\n\}\n\nasync function extractChunk/;
if (!historyPattern.test(code)) throw new Error("MAX history function not found");
code = code.replace(historyPattern, fetchHistoryReplacement + "\n\nasync function extractChunk");
code = code.replace(/version:\s*"v[^"]+",/, 'version: "v44-current-chat-history"');
fs.writeFileSync(path, code);
console.log("safe MAX history pagination enabled");
