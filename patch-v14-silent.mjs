import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

const anchor = 'async function maxRequest(path, options = {}) {\n';
const guarded = 'async function maxRequest(path, options = {}) {\n  const method = String(options?.method || "GET").toUpperCase();\n  if (method === "POST" && /(?:\\?|&)chat_id=/.test(String(path))) {\n    throw new Error("GROUP_SEND_BLOCKED: silent observer mode");\n  }\n';

if (!code.includes(anchor)) {
  throw new Error("maxRequest anchor not found; refusing unsafe patch");
}

code = code.replace(anchor, guarded);
code = code.replace('version: "v14-semantic-events",', 'version: "v24-fullchat-silent",');
code = code.replace('silentGroupMode: true,', 'silentGroupMode: true,\n  hardBlockGroupSend: true,');

fs.writeFileSync(path, code);
console.log("silent observer guard enabled");
