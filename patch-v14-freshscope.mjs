import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error(`fresh-scope patch anchor not found: ${label}`);
  code = code.replace(oldText, newText);
  console.log(`fresh-scope patched: ${label}`);
}

const oldWindow = `function requestedWindow(question) {
  const q = question.toLowerCase(); const now = new Date();
  const dayStart = (daysAgo = 0) => { const d = new Date(now.getTime() + TZ_OFFSET_MINUTES*60000); d.setUTCHours(0,0,0,0); d.setUTCDate(d.getUTCDate()-daysAgo); return d.getTime()-TZ_OFFSET_MINUTES*60000; };
  if (/(за весь чат|за все время|за всё время|всего|итог|общее|общий|выдан|релиз|считай|посчитай)/i.test(q)) return { start: null, end: Date.now() };
  if (q.includes("вчера")) return { start: dayStart(1), end: dayStart(0)-1 };
  if (q.includes("сегодня")) return { start: dayStart(0), end: Date.now() };
  return { start: Date.now() - 30*86400000, end: Date.now() };
}`;

const newWindow = `function requestedWindow(question) {
  const q = String(question || "").toLowerCase();
  const now = new Date();
  const off = TZ_OFFSET_MINUTES * 60000;
  const localNow = new Date(Date.now() + off);
  const currentYear = localNow.getUTCFullYear();
  const monthNames = {
    января:1, январь:1, февраля:2, февраль:2, марта:3, март:3, апреля:4, апрель:4,
    мая:5, май:5, июня:6, июнь:6, июля:7, июль:7, августа:8, август:8,
    сентября:9, сентябрь:9, октября:10, октябрь:10, ноября:11, ноябрь:11, декабря:12, декабрь:12
  };
  const localMs = (day, month, year, endOfDay = false) => {
    const y = Number(year || currentYear);
    return Date.UTC(y, Number(month) - 1, Number(day), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0) - off;
  };
  const dayStart = (daysAgo = 0) => {
    const d = new Date(now.getTime() + off);
    d.setUTCHours(0,0,0,0);
    d.setUTCDate(d.getUTCDate()-daysAgo);
    return d.getTime()-off;
  };

  let m = q.match(/(?:с|за период с)\\s*(\\d{1,2})\\s+по\\s+(\\d{1,2})\\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\\s+(\\d{4}))?/i);
  if (m) {
    const month = monthNames[m[3]];
    return { start: localMs(m[1], month, m[4], false), end: localMs(m[2], month, m[4], true) };
  }

  m = q.match(/(?:с|за период с)\\s*(\\d{1,2})\\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\\s+(\\d{4}))?\\s+по\\s+(\\d{1,2})\\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\\s+(\\d{4}))?/i);
  if (m) {
    return { start: localMs(m[1], monthNames[m[2]], m[3] || m[6], false), end: localMs(m[4], monthNames[m[5]], m[6] || m[3], true) };
  }

  m = q.match(/(?:с|за период с)\\s*(\\d{1,2})[.\\/-](\\d{1,2})(?:[.\\/-](\\d{2,4}))?\\s+по\\s+(\\d{1,2})[.\\/-](\\d{1,2})(?:[.\\/-](\\d{2,4}))?/i);
  if (m) {
    const normYear = (v) => !v ? currentYear : Number(v) < 100 ? 2000 + Number(v) : Number(v);
    return { start: localMs(m[1], m[2], normYear(m[3]), false), end: localMs(m[4], m[5], normYear(m[6] || m[3]), true) };
  }

  if (q.includes("вчера")) return { start: dayStart(1), end: dayStart(0)-1 };
  if (q.includes("сегодня")) return { start: dayStart(0), end: Date.now() };
  if (/(за весь чат|за все время|за всё время|вся история|всю историю|с самого начала)/i.test(q)) return { start: null, end: Date.now() };
  return { start: Date.now() - 14*86400000, end: Date.now() };
}`;

replaceOnce(oldWindow, newWindow, 'date-aware accounting window');

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
const privateReplacement = `  try {\n    if (/^(?:сброс|сбросить|новый\\s+расч[её]т|начать\\s+заново)$/i.test(text)) {\n      privateDialog.length = 0;\n      await sendText(\`user_id=\${encodeURIComponent(senderId)}\`, "Контекст расчёта сброшен. Старые ответы бота больше не использую. Полную историю читаю только по явной команде «за весь чат».");\n      return;\n    }\n    if (imgs.length) {`;
replaceOnce(privateAnchor, privateReplacement, 'private reset command');

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v47-accounting-scope",');

fs.writeFileSync(path, code);
console.log("fresh accounting scope v47 enabled");
