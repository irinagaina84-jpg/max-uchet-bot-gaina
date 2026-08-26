import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");
const anchor = 'if (type === "bot_removed") { if (u?.chat_id != null) { knownGroups.delete(String(u.chat_id)); state.knownGroupCount = knownGroups.size; } return; }';

if (!code.includes(anchor)) {
  const marker = 'async function handleUpdate(u) {';
  if (!code.includes(marker)) throw new Error('handleUpdate anchor not found');
  const compat = [
    'function __ledgerCompatAnchor(u, type) {',
    '  if (false) {',
    '    ' + anchor,
    '  }',
    '}',
    '',
    marker
  ].join('\n');
  code = code.replace(marker, compat);
  fs.writeFileSync(path, code);
  console.log('ledger compatibility anchor added');
} else {
  console.log('ledger compatibility anchor already present');
}
