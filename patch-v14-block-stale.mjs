import fs from "node:fs";

const path = "./bot.js";
const BLOCKED_CHAT_ID = "-77765742260432";
let code = fs.readFileSync(path, "utf8");

function replaceAllSafe(oldText, newText, label) {
  if (!code.includes(oldText)) {
    console.warn(`blocked-chat patch skipped: ${label}`);
    return false;
  }
  code = code.split(oldText).join(newText);
  console.log(`blocked-chat patched: ${label}`);
  return true;
}

replaceAllSafe(
  'async function rememberGroup(chatId) {\n  if (chatId == null) return null;',
  `async function rememberGroup(chatId) {\n  if (chatId == null || String(chatId) === "${BLOCKED_CHAT_ID}") return null;`,
  'rememberGroup guard'
);

replaceAllSafe(
  'const list = Array.isArray(r.data) ? r.data : [];\n    for (const item of list) {\n      if (item?.chat_id == null) continue;',
  `const list = Array.isArray(r.data) ? r.data : [];\n    knownGroups.clear();\n    for (const item of list) {\n      if (item?.chat_id == null) continue;\n      if (String(item.chat_id) === "${BLOCKED_CHAT_ID}") continue;`,
  'persisted chat filter'
);

replaceAllSafe(
  'for (const [chatId, meta] of knownGroups) {',
  `for (const [chatId, meta] of knownGroups) {\n    if (String(chatId) === "${BLOCKED_CHAT_ID}") continue;`,
  'analysis loop filter'
);

replaceAllSafe(
  'const rows = []; for (const [id, m] of knownGroups) rows.push(`• ${m.title || "чат"} (${id})`);',
  `const rows = []; for (const [id, m] of knownGroups) { if (String(id) === "${BLOCKED_CHAT_ID}") continue; rows.push(\`• \${m.title || "чат"} (\${id})\`); }`,
  'chat list filter'
);

replaceAllSafe(
  'knownGroups.set(String(chatId), { title: info.title, lastSeenAt: Date.now() });',
  `if (String(chatId) === "${BLOCKED_CHAT_ID}") return null;\n  knownGroups.set(String(chatId), { title: info.title, lastSeenAt: Date.now() });`,
  'set guard'
);

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v41-current-chat-only",');
fs.writeFileSync(path, code);
console.log('stale MAX chat is hard-blocked inside bot runtime');
