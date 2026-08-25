import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error(`MAX history patch anchor not found: ${label}`);
  code = code.replace(oldText, newText);
  console.log(`MAX history patched: ${label}`);
}

replaceOnce(
  'const q = new URLSearchParams({ chat_id: String(chatId), count: "100", to: String(before) });\n    if (since) q.set("from", String(since));',
  'const q = new URLSearchParams({ chat_id: String(chatId), count: "100", from: String(before) });\n    if (since) q.set("to", String(since));',
  'MAX from/to semantics'
);

replaceOnce(
  'if (!state.lastHistoryMessages) return "В подключённых чатах за этот период я не нашёл сообщений для анализа.";',
  'if (!state.lastHistoryMessages) {\n    if (state.lastError) return `Не удалось прочитать историю рабочего чата: ${state.lastError}`;\n    return "В подключённых чатах за этот период я не нашёл сообщений для анализа.";\n  }',
  'history access diagnostics'
);

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v42-max-history-fixed",');
fs.writeFileSync(path, code);
console.log("MAX history time bounds fixed");
