import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error(`dialog-routing patch anchor not found: ${label}`);
  code = code.replace(oldText, newText);
  console.log(`dialog-routing patched: ${label}`);
}

replaceOnce(
  'function isGroup(message) { const r = message?.recipient || {}; const t = String(r?.chat_type || r?.type || "").toLowerCase(); if (t === "chat" || t === "channel") return true; return r?.chat_id != null && r?.user_id == null; }',
  'function isGroup(message) { const r = message?.recipient || {}; const t = String(r?.chat_type || r?.type || "").toLowerCase(); return t === "chat" || t === "channel"; }',
  'strict group detection'
);

replaceOnce(
  '    const eventChatId = u?.chat_id ?? m?.recipient?.chat_id;\n    if (isGroup(m) || (eventChatId != null && m?.recipient?.user_id == null)) {\n      if (eventChatId != null) await rememberGroup(eventChatId);\n      return;\n    }\n    await handlePrivate(m);',
  '    const eventChatId = u?.chat_id ?? m?.recipient?.chat_id;\n    const recipientType = String(m?.recipient?.chat_type || m?.recipient?.type || "").toLowerCase();\n    if (isGroup(m) || recipientType === "chat" || recipientType === "channel") {\n      if (eventChatId != null) await rememberGroup(eventChatId);\n      return;\n    }\n    await handlePrivate(m);',
  'route dialog messages to private handler'
);

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v49-dialog-routing",');
code = code.replace('hardBlockGroupSend: true,', 'hardBlockGroupSend: true,\n  dialogRoutingFixed: true,');

fs.writeFileSync(path, code);
console.log("MAX dialog routing v49 enabled");
