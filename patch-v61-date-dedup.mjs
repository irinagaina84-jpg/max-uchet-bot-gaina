import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error("v61 anchor not found: " + label);
  code = code.replace(oldText, newText);
  console.log("v61 patched: " + label);
}

const oldWindow = [
  'function requestedWindow(question) {',
  '  const q = question.toLowerCase(); const now = new Date();',
  '  const dayStart = (daysAgo = 0) => { const d = new Date(now.getTime() + TZ_OFFSET_MINUTES*60000); d.setUTCHours(0,0,0,0); d.setUTCDate(d.getUTCDate()-daysAgo); return d.getTime()-TZ_OFFSET_MINUTES*60000; };',
  '  if (q.includes("за весь чат") || q.includes("за все время") || q.includes("за всё время") || q.includes("всего")) return { start: null, end: Date.now() };',
  '  if (q.includes("вчера")) return { start: dayStart(1), end: dayStart(0)-1 };',
  '  if (q.includes("сегодня")) return { start: dayStart(0), end: Date.now() };',
  '  return { start: Date.now() - 30*86400000, end: Date.now() };',
  '}'
].join('\n');

const newWindow = [
  'function requestedWindow(question) {',
  '  const q = normalizeText(question).toLowerCase().replace(/ё/g, "е");',
  '  const nowMs = Date.now();',
  '  const localNow = new Date(nowMs + TZ_OFFSET_MINUTES * 60000);',
  '  const currentYear = localNow.getUTCFullYear();',
  '  const toYear = (raw) => { if (!raw) return currentYear; const n = Number(raw); return n < 100 ? 2000 + n : n; };',
  '  const bounds = (year, month, day) => {',
  '    const start = Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0) - TZ_OFFSET_MINUTES * 60000;',
  '    return { start, end: start + 86400000 - 1 };',
  '  };',
  '  const dayStart = (daysAgo = 0) => {',
  '    const d = new Date(nowMs + TZ_OFFSET_MINUTES * 60000);',
  '    d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - daysAgo);',
  '    return d.getTime() - TZ_OFFSET_MINUTES * 60000;',
  '  };',
  '  const months = { января:1, январь:1, февраля:2, февраль:2, марта:3, март:3, апреля:4, апрель:4, мая:5, май:5, июня:6, июнь:6, июля:7, июль:7, августа:8, август:8, сентября:9, сентябрь:9, октября:10, октябрь:10, ноября:11, ноябрь:11, декабря:12, декабрь:12 };',
  '  let m;',
  '',
  '  if (q.includes("позавчера")) return { start: dayStart(2), end: dayStart(1) - 1 };',
  '  if (q.includes("вчера")) return { start: dayStart(1), end: dayStart(0) - 1 };',
  '  if (q.includes("сегодня")) return { start: dayStart(0), end: nowMs };',
  '',
  '  m = q.match(/(?:с\\s*)?(\\d{1,2})[.\\/-](\\d{1,2})(?:[.\\/-](\\d{2,4}))?\\s*(?:по|до|[-–—])\\s*(\\d{1,2})[.\\/-](\\d{1,2})(?:[.\\/-](\\d{2,4}))?/);',
  '  if (m) {',
  '    const y1 = toYear(m[3]); let y2 = toYear(m[6] || m[3]);',
  '    if (!m[6] && Number(m[5]) < Number(m[2])) y2 = y1 + 1;',
  '    return { start: bounds(y1, m[2], m[1]).start, end: bounds(y2, m[5], m[4]).end };',
  '  }',
  '',
  '  m = q.match(/(?:с\\s*)?(\\d{1,2})\\s*(?:по|до|[-–—])\\s*(\\d{1,2})\\s+(января|январь|февраля|февраль|марта|март|апреля|апрель|мая|май|июня|июнь|июля|июль|августа|август|сентября|сентябрь|октября|октябрь|ноября|ноябрь|декабря|декабрь)(?:\\s+(\\d{4}))?/);',
  '  if (m) { const month = months[m[3]]; const year = toYear(m[4]); return { start: bounds(year, month, m[1]).start, end: bounds(year, month, m[2]).end }; }',
  '',
  '  m = q.match(/(?:за\\s+|на\\s+)?(\\d{1,2})[.\\/-](\\d{1,2})(?:[.\\/-](\\d{2,4}))?/);',
  '  if (m) return bounds(toYear(m[3]), m[2], m[1]);',
  '',
  '  m = q.match(/(?:за\\s+|на\\s+)?(\\d{1,2})\\s+(января|январь|февраля|февраль|марта|март|апреля|апрель|мая|май|июня|июнь|июля|июль|августа|август|сентября|сентябрь|октября|октябрь|ноября|ноябрь|декабря|декабрь)(?:\\s+(\\d{4}))?/);',
  '  if (m) return bounds(toYear(m[3]), months[m[2]], m[1]);',
  '',
  '  m = q.match(/(?:за\\s+)?последн(?:ие|их)\\s+(\\d{1,3})\\s+дн/);',
  '  if (m) { const n = Math.max(1, Number(m[1])); return { start: dayStart(n - 1), end: nowMs }; }',
  '',
  '  if (/(за весь чат|за все время|за весь период|с самого начала|с начала)/.test(q)) return { start: null, end: nowMs };',
  '  if (/сколько\\s+всего|всего\\s+выдано|итог\\s+всего/.test(q)) return { start: null, end: nowMs };',
  '  return { start: nowMs - 30 * 86400000, end: nowMs };',
  '}'
].join('\n');

replaceOnce(oldWindow, newWindow, 'calendar date windows');

const recapAnchor = '    "- confirmed_issue тоже count_as_issued=true, но не создавай второй плюс, если это тот же контейнер/релиз; используй номера для дедупликации.\\n" +';
const recapReplacement = [
  '    "- confirmed_issue тоже count_as_issued=true, но не создавай второй плюс, если это тот же контейнер/релиз; используй номера для дедупликации.\\n" +',
  '    "- Повторная сводка, пересказ уже опубликованных релизов, цитата старого количества или подтверждение без НОВОЙ выдачи — это context с count_as_issued=false. Не прибавляй повторно ранее учтенное количество.\\n" +',
  '    "- Если новое сообщение говорит «итого», «всего», «уже выдали», «получается» и лишь суммирует предыдущие сообщения, это не новое событие выдачи. Новым плюсом считай только новый релиз/новую фактическую выдачу.\\n" +'
].join('\n');
if (code.includes(recapAnchor)) code = code.replace(recapAnchor, recapReplacement);
else console.log('v61 recap prompt anchor not found; date fix still applied');

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v61-date-dedup",');
code = code.replace('recoveredBackfillFloor: 256,', 'recoveredBackfillFloor: 278,');
if (code.includes('monotonicBackfillProgress: true,') && !code.includes('calendarDateWindows: true,')) {
  code = code.replace('monotonicBackfillProgress: true,', 'monotonicBackfillProgress: true,\n  calendarDateWindows: true,\n  recapDoubleCountProtection: true,');
}

fs.writeFileSync(path, code);
console.log("v61 date windows and recap protection enabled");
