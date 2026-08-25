import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error(`fresh-scope patch anchor not found: ${label}`);
  code = code.replace(oldText, newText);
  console.log(`fresh-scope patched: ${label}`);
}

replaceOnce(
  'if (/(за весь чат|за все время|за всё время|всего|итог|общее|общий|выдан|релиз|считай|посчитай)/i.test(q)) return { start: null, end: Date.now() };',
  'if (/(за весь чат|за все время|за всё время|вся история|всю историю|с самого начала)/i.test(q)) return { start: null, end: Date.now() };',
  'explicit full-history only'
);

replaceOnce(
  'return { start: Date.now() - 30*86400000, end: Date.now() };',
  'return { start: Date.now() - 14*86400000, end: Date.now() };',
  'default analysis window'
);

replaceOnce(
  'const dialogContext = privateDialog.slice(-6).map((x) => `${x.role}: ${x.text}`).join("\\n");',
  'const dialogContext = privateDialog.filter((x) => x.role === "user").slice(-4).map((x) => `${x.role}: ${x.text}`).join("\\n");',
  'exclude old bot answers from new accounting facts'
);

replaceOnce(
  'if (/(сколько|итог|выдан|выдач|релиз|остат|считай|посчитай|за весь чат)/i.test(text)) await sendText(`user_id=${encodeURIComponent(senderId)}`, "Считаю по всей истории чата. Это может занять несколько минут…");',
  'if (/(сколько|итог|выдан|выдач|релиз|остат|считай|посчитай|за весь чат)/i.test(text)) { const whole = /(за весь чат|за все время|за всё время|вся история|всю историю|с самого начала)/i.test(text); await sendText(`user_id=${encodeURIComponent(senderId)}`, whole ? "Считаю по всей истории чата. Это может занять несколько минут…" : "Считаю по сообщениям за нужный период…"); }',
  'accurate progress message'
);

const privateAnchor = '  try {\n    if (imgs.length) {';
const privateReplacement = `  try {\n    if (/^(?:сброс|сбросить|новый\\s+расч[её]т|начать\\s+заново)$/i.test(text)) {\n      privateDialog.length = 0;\n      historyCache.clear();\n      await sendText(\`user_id=\${encodeURIComponent(senderId)}\`, "Контекст расчёта сброшен. Старые ответы бота больше не использую. Полную историю читаю только по явной команде «за весь чат».");\n      return;\n    }\n    if (imgs.length) {`;
replaceOnce(privateAnchor, privateReplacement, 'private reset command');

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v47-accounting-scope",');

fs.writeFileSync(path, code);
console.log("fresh accounting scope v47 enabled");
