import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

const anchor = '  const forwarded = privateForwardLink(message);';
if (!code.includes(anchor)) throw new Error("v80 private forwarded anchor not found");

if (!code.includes("mailCommandPriority: true,")) {
  const direct = String.raw`
  // Mail.ru commands have absolute priority in the owner's private dialog.
  // They must never fall through to multi-group accounting analysis.
  const directMailIndex = text.match(/^\s*почта\s+индекс\s+(20\d{2}-(?:0[1-9]|1[0-2]))\s*$/i);
  if (directMailIndex) {
    void runMailruIndexForUser(senderId, directMailIndex[1]);
    return;
  }
  if (/^\s*(?:почта\s+статус|mail\s+status|почта\s+проверить|проверить\s+почту|инвентаризация\s+почты|почта\s+инвентаризация)\s*$/i.test(text)) {
    if (await handleMailruCommand(senderId, text)) return;
  }
`;
  code = code.replace(anchor, direct + "\n" + anchor);

  if (code.includes("groupIsolation: true,")) {
    code = code.replace("groupIsolation: true,", "groupIsolation: true,\n  mailCommandPriority: true,");
  }
}

code = code.replace(/version:\s*"v[^"]+"\s*,?/, 'version: "v80-mail-command-priority",');
fs.writeFileSync(path, code);
console.log("v80 Mail.ru command priority enabled");
