import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error(`release-series patch anchor not found: ${label}`);
  code = code.replace(oldText, newText);
  console.log(`release-series patched: ${label}`);
}

function replaceRegex(pattern, replacement, label) {
  if (!pattern.test(code)) throw new Error(`release-series patch regex anchor not found: ${label}`);
  code = code.replace(pattern, replacement);
  console.log(`release-series patched: ${label}`);
}

replaceOnce(
  'function historyContextLine(m) {\n  const time = new Date(msgTime(m) || Date.now()).toISOString();\n  return `[${time}] ${senderName(m)} | id=${msgId(m)} | ${replyInfo(m)} ${normalizeText(msgText(m))}`.trim();\n}',
  'function historyContextLine(m) {\n  const time = new Date(msgTime(m) || Date.now()).toISOString();\n  const series = m?._releaseSeries ? ` | СЕРИЯ=${m._releaseSeries}` : "";\n  return `[${time}] ${senderName(m)} | id=${msgId(m)}${series} | ${replyInfo(m)} ${normalizeText(msgText(m))}`.trim();\n}\n\nfunction namedReleaseSeries(text) {\n  const t = normalizeText(text);\n  const m = t.match(/^(?:релиз|релизы)\\s+([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]{2,40})(?:\\s*[:—-])?$/i);\n  if (!m) return null;\n  const name = String(m[1] || "").trim();\n  if (/\\d/.test(name)) return null;\n  return `Релиз ${name}`;\n}\n\nfunction annotateReleaseSeries(rows) {\n  let current = null;\n  return rows.map((row) => {\n    const own = namedReleaseSeries(msgText(row));\n    if (own) current = own;\n    return { ...row, _releaseSeries: current };\n  });\n}',
  'carry named release series through history'
);

replaceOnce(
  'try { imageTexts.push(`[message_id=${msgId(m)}] IMAGE: ${await describeImage(url)}`); }',
  'try { imageTexts.push(`[message_id=${msgId(m)}]${m?._releaseSeries ? ` [СЕРИЯ=${m._releaseSeries}]` : ""} IMAGE: ${await describeImage(url)}`); }',
  'attach release series to image-only messages'
);

replaceOnce(
  'const history = await fetchHistory(chatId, start, end, 5000);\n  const cacheKey = historyFingerprint(chatId, history);',
  'const history = await fetchHistory(chatId, start, end, 5000);\n  const annotatedHistory = annotateReleaseSeries(history);\n  const cacheKey = historyFingerprint(chatId, annotatedHistory);',
  'annotate history before extraction'
);

replaceOnce(
  'for (const part of chunkRows(history)) {',
  'for (const part of chunkRows(annotatedHistory)) {',
  'extract annotated history'
);

replaceOnce(
  'Преобразуй фрагмент рабочей переписки в журнал событий. Поздние реплики могут отменять или исправлять ранние. Используй message_id как источник. Один человеческий смысловой эпизод может включать несколько сообщений. Возвращай только события, важные для учета контейнеров, релизов, выдач, отмен, исправлений или оплат. Не создавай context-события для приветствий, коротких подтверждений и пустой болтовни. Ответ должен быть максимально компактным.',
  'Преобразуй фрагмент рабочей переписки в журнал событий. Поздние реплики могут отменять или исправлять ранние. Используй message_id как источник. Один человеческий смысловой эпизод может включать несколько сообщений. Возвращай только события, важные для учета контейнеров, релизов, выдач, отмен, исправлений или оплат. Не создавай context-события для приветствий, коротких подтверждений и пустой болтовни. Ответ должен быть максимально компактным. В строках может быть СЕРИЯ=Релиз Ирина / Релиз Матвейченкова и т.п. Это заголовок серии, который относится ко всем следующим сообщениям и картинкам до следующего заголовка. Для КАЖДОГО события из такой строки обязательно сохрани принадлежность к серии: если отдельного номера релиза нет — запиши release_id равным названию серии; если отдельный номер релиза есть — сохрани его в release_id, а в notes обязательно добавь `series=<название серии>`. Картинка без текста тоже наследует СЕРИЮ.',
  'teach semantic extraction about named series'
);

const exactLookupNew = `function isExactLookupQuestion(text) {
  const t = normalizeText(text).toUpperCase();
  // Exact lookup is ONLY for technical identifiers: container numbers, numeric release IDs, codes.
  if (/\\b[A-Z]{4}\\d{6,7}\\b/.test(t)) return true;
  if (/(?:РЕЛИЗ|RELEASE|НОМЕР|№|#)\\s*[:№#-]?\\s*[A-ZА-Я]{0,5}\\d[A-ZА-Я0-9-]{2,}/i.test(t)) return true;
  return false;
}`;

replaceRegex(
  /function isExactLookupQuestion\(text\) \{[\s\S]*?\n\}/,
  exactLookupNew,
  'do not treat human names as exact release IDs'
);

replaceOnce(
  '8) Если пользователь называет клиента (например «по Взлёту»), фильтруй события по явной или надёжно следующей из переписки привязке к этому клиенту.',
  '8) Если пользователь называет клиента (например «по Взлёту»), фильтруй события по явной или надёжно следующей из переписки привязке к этому клиенту. Если пользователь спрашивает про именованную серию вида «Релиз Ирина», «Релиз Матвейченкова» и т.п., фильтруй по release_id и notes с series=<название>; собери ВСЕ события этой серии, включая картинки и текстовые сообщения без повторения имени.',
  'final answer understands named series'
);

replaceOnce(
  'const answer = await answerWorkQuestion(text); await sendText(`user_id=${encodeURIComponent(senderId)}`, answer);',
  'const answer = await answerWorkQuestion(text); await sendText(`user_id=${encodeURIComponent(senderId)}`, answer);',
  'no-op anchor validation'
);

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v52-release-series",');
code = code.replace('accountingAccuracyFixed: true,', 'accountingAccuracyFixed: true,\n  namedReleaseSeriesFixed: true,');

fs.writeFileSync(path, code);
console.log("MAX named release series v52 enabled");
