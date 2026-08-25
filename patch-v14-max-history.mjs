import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

const fetchHistoryReplacement = `async function fetchHistory(chatId, since, until = Date.now(), max = 5000) {
  const out = [];
  let before = Number(until || Date.now());
  for (let page = 0; page < 50 && out.length < max; page++) {
    const q = new URLSearchParams({ chat_id: String(chatId), count: "100" });
    // For the first full-history page, omit time bounds entirely: MAX then returns latest messages.
    // For pagination, "from" is the upper time boundary and "to" is the lower boundary.
    if (page > 0 || since || before < Date.now() - 60000) q.set("from", String(before));
    if (since) q.set("to", String(since));
    const d = await maxRequest(\`/messages?\${q}\`, { timeout: 30000 });
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
    .filter((m) => { const id = msgId(m) || String(msgTime(m)) + "|" + msgText(m); if (seen.has(id)) return false; seen.add(id); return true; })
    .sort((a,b) => msgTime(a)-msgTime(b))
    .slice(-max);
}`;

const historyPattern = /async function fetchHistory\(chatId, since, until = Date\.now\(\), max = \d+\) \{[\s\S]*?\n\}\n\nasync function extractChunk/;
if (!historyPattern.test(code)) throw new Error("MAX history function not found");
code = code.replace(historyPattern, fetchHistoryReplacement + "\n\nasync function extractChunk");
console.log("MAX history patched: robust pagination");

const diagnosticHelper = `async function historyAccessDiagnostic() {
  const lines = [];
  for (const [chatId, meta] of knownGroups) {
    try {
      const [chat, membership] = await Promise.all([
        maxRequest(\`/chats/\${encodeURIComponent(chatId)}\`, { timeout: 15000 }),
        maxRequest(\`/chats/\${encodeURIComponent(chatId)}/members/me\`, { timeout: 15000 }),
      ]);
      let latestCount = -1;
      let messageError = "";
      try {
        const latest = await maxRequest(\`/messages?chat_id=\${encodeURIComponent(chatId)}&count=3\`, { timeout: 20000 });
        latestCount = Array.isArray(latest?.messages) ? latest.messages.length : Array.isArray(latest?.items) ? latest.items.length : 0;
      } catch (error) {
        messageError = errText(error);
      }
      const permissions = Array.isArray(membership?.permissions) ? membership.permissions.map(String) : [];
      const canReadAll = permissions.includes("read_all_messages");
      lines.push([
        \`Чат: \${meta?.title || chat?.title || chatId} (\${chatId})\`,
        \`Статус: \${chat?.status || "неизвестно"}; сообщений по данным чата: \${chat?.messages_count ?? "?"}\`,
        \`Бот администратор: \${membership?.is_admin === true ? "да" : "нет"}\`,
        \`Право read_all_messages: \${canReadAll ? "есть" : "НЕТ"}\`,
        messageError ? \`GET /messages: ошибка \${messageError}\` : \`GET /messages: получено \${latestCount} последних сообщений\`,
      ].join("\n"));
    } catch (error) {
      lines.push(\`Чат \${meta?.title || chatId} (\${chatId}): ошибка проверки доступа — \${errText(error)}\`);
    }
  }
  return lines.join("\n\n") || "Нет подключённых рабочих чатов.";
}
`;

if (!code.includes("async function historyAccessDiagnostic()")) {
  code = code.replace("async function answerWorkQuestion(question) {", diagnosticHelper + "\nasync function answerWorkQuestion(question) {");
}

const oldNoHistory = 'if (!state.lastHistoryMessages) return "В подключённых чатах за этот период я не нашёл сообщений для анализа.";';
const newerNoHistory = 'if (!state.lastHistoryMessages) {\n    if (state.lastError) return `Не удалось прочитать историю рабочего чата: ${state.lastError}`;\n    return "В подключённых чатах за этот период я не нашёл сообщений для анализа.";\n  }';
const replacementNoHistory = `if (!state.lastHistoryMessages) {
    const diagnostic = await historyAccessDiagnostic();
    return \`Не могу прочитать историю для расчёта. Проверка доступа:\n\n\${diagnostic}\`;
  }`;
if (code.includes(newerNoHistory)) code = code.replace(newerNoHistory, replacementNoHistory);
else if (code.includes(oldNoHistory)) code = code.replace(oldNoHistory, replacementNoHistory);
else throw new Error("history no-data response anchor not found");

const commandAnchor = 'if (/какие\\s+чаты|какие.*чаты.*вид|список.*чат/i.test(text)) {';
if (code.includes(commandAnchor) && !code.includes('проверка\\s+(?:истории|доступа)')) {
  code = code.replace(commandAnchor,
    'if (/^(?:проверка\\s+(?:истории|доступа)|диагностика\\s+чата)$/i.test(text)) { await sendText(`user_id=${encodeURIComponent(senderId)}`, await historyAccessDiagnostic()); return; }\n    ' + commandAnchor
  );
}

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v43-history-access-diagnostic",');
fs.writeFileSync(path, code);
console.log("MAX history reader and access diagnostics enabled");
