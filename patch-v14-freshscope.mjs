import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error(`fresh-scope patch anchor not found: ${label}`);
  code = code.replace(oldText, newText);
}

replaceOnce(
  'if (/(за весь чат|за все время|за всё время|всего|итог|общее|общий|выдан|релиз|считай|посчитай)/i.test(q)) return { start: null, end: Date.now() };',
  'if (/(за весь чат|за все время|за всё время|вся история|всю историю|с самого начала)/i.test(q)) return { start: null, end: Date.now() };',
  'do not treat normal totals as full-history requests'
);

replaceOnce(
  'return { start: Date.now() - 30*86400000, end: Date.now() };',
  'return { start: Date.now() - 14*86400000, end: Date.now() };',
  'default analysis window'
);

const privateAnchor = '  try {\n    if (imgs.length) {';
const privateReplacement = `  try {\n    if (/^(?:сброс|сбросить|новый\\s+расч[её]т|начать\\s+заново)$/i.test(text)) {\n      privateDialog.length = 0;\n      await sendText(\`user_id=\${encodeURIComponent(senderId)}\`, "Личный контекст сброшен. Для обычного итога анализирую только актуальные 14 дней. Полную историю читаю только по явной команде «за весь чат».");\n      return;\n    }\n    if (imgs.length) {`;
replaceOnce(privateAnchor, privateReplacement, 'private reset command');

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v40-fresh-scope",');

fs.writeFileSync(path, code);
console.log("fresh analysis scope enabled");
