import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error(`text-release patch anchor not found: ${label}`);
  code = code.replace(oldText, newText);
  console.log(`text-release patched: ${label}`);
}

function replaceRegex(pattern, replacement, label) {
  if (!pattern.test(code)) throw new Error(`text-release patch regex anchor not found: ${label}`);
  code = code.replace(pattern, replacement);
  console.log(`text-release patched: ${label}`);
}

const replyInfoNew = `function linkedMessageText(m) {
  const candidates = [
    m?.body?.reply_to,
    m?.body?.reply,
    m?.reply_to,
    m?.body?.linked_message,
    m?.linked_message,
    m?.body?.link?.message,
    m?.body?.link,
    m?.link?.message,
    m?.link
  ];
  for (const r of candidates) {
    if (!r) continue;
    const text = normalizeText(
      r?.body?.text || r?.text || r?.message?.body?.text || r?.message?.text || r?.linked_message?.body?.text || ""
    );
    if (text) return text;
  }
  return "";
}

function replyInfo(m) {
  const text = linkedMessageText(m);
  return text ? `Ответ на: ${text}` : "";
}`;

replaceRegex(
  /function replyInfo\(m\) \{[\s\S]*?\n\}/,
  replyInfoNew,
  "read MAX reply and linked-message text"
);

const seriesNew = `function namedReleaseSeries(text) {
  const t = normalizeText(text);
  const matches = [...t.matchAll(/(?:^|\\b)(?:по\\s+)?релиз(?:ы|а|у|ом)?\\s+([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]{2,40})(?=\\b|$)/gi)];
  for (const match of matches) {
    const name = String(match?.[1] || "").trim();
    if (!name || /\\d/.test(name)) continue;
    if (/^(?:на|для|всех|один|одна|одного|новый|новая|сегодня|завтра)$/i.test(name)) continue;
    return `Релиз ${name}`;
  }
  return null;
}

function annotateReleaseSeries(rows) {
  let current = null;
  let lastNamedAt = 0;
  return rows.map((row) => {
    const own = namedReleaseSeries(`${msgText(row)} ${linkedMessageText(row)}`);
    const at = msgTime(row);
    if (own) {
      current = own;
      lastNamedAt = at || lastNamedAt;
    } else if (current && lastNamedAt && at && at - lastNamedAt > 36 * 60 * 60 * 1000) {
      current = null;
    }
    return { ...row, _releaseSeries: current };
  });
}`;

replaceRegex(
  /function namedReleaseSeries\(text\) \{[\s\S]*?\n\}\n\nfunction annotateReleaseSeries\(rows\) \{[\s\S]*?\n\}/,
  seriesNew,
  "detect named release inside ordinary sentences"
);

const helpers = `function terminalFromText(text) {
  const t = normalizeText(text).toLowerCase();
  const terminals = [
    ["Союз Плюс", /союз\\s*плюс/i],
    ["СВС", /(?:^|\\b)(?:свс|svs)(?:\\b|$)/i],
    ["Тетрис Юг", /тетрис\\s*юг/i],
    ["Шубино", /шубино/i],
    ["Купавна", /купавн/i],
    ["Чехов", /чехов/i],
    ["Сухой Порт", /сух(?:ой|ого)\\s*порт|dry\\s*port/i],
    ["Союз Восток", /союз\\s*восток/i],
    ["Жуковский", /жуковск/i]
  ];
  for (const [name, re] of terminals) if (re.test(t)) return name;
  return null;
}

function compactReleaseNotation(text) {
  const t = normalizeText(text);
  const m = t.match(/(?:^|\\s)([A-ZА-ЯЁ][A-ZА-ЯЁ0-9_-]{1,20})[-–— ]+(\\d{1,3})\\s*[xх×]\\s*(20|40)\\s*(DC|HC)?(?:\\s*\\/\\s*[pр])?(?:$|\\s)/i);
  if (!m) return null;
  const code = String(m[1] || "").toUpperCase();
  const quantity = Number(m[2]);
  const size = String(m[3]);
  const suffix = String(m[4] || (size === "20" ? "DC" : "HC")).toUpperCase();
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  return { code, quantity, container_type: `${size} ${suffix}` };
}

function releaseQuantityFromText(text) {
  const t = normalizeText(text);
  let m = t.match(/(?:^|\\b)(\\d{1,3})\\s*(?:ктк|контейнер(?:а|ов)?|шт\\.?)(?:\\b|$)/i);
  if (m) return Number(m[1]);
  m = t.match(/(?:^|\\b)(\\d{1,3})\\s*[xх×]\\s*(?:20|40)\\s*(?:DC|HC)?(?:\\b|$)/i);
  if (m) return Number(m[1]);
  return null;
}

function releaseTextHint(m) {
  const own = normalizeText(msgText(m));
  const linked = linkedMessageText(m);
  const joined = normalizeText(`${own} ${linked}`);
  const series = namedReleaseSeries(joined) || m?._releaseSeries || null;
  const terminal = terminalFromText(joined);
  const compact = compactReleaseNotation(own);
  const quantity = compact?.quantity || releaseQuantityFromText(own);
  const ctype = compact?.container_type || null;
  const explicitRelease = /(?:^|\\b)(?:по\\s+)?релиз(?:ы|а|у|ом)?(?:\\b|$)/i.test(own) || /\\/\\s*[pр](?:$|\\s)/i.test(own);
  const waitingOnly = /жд[её]м\\s+релиз|ожидаем\\s+релиз|будет\\s+релиз|на\\s+завтра.*жд[её]м/i.test(own) && !series;
  const confirmation = /^(?:да|верно|ага|ок|оки|подтверждаю)$/i.test(own);
  const hints = [];
  if (series) hints.push(`series=${series}`);
  if (terminal) hints.push(`terminal=${terminal}`);
  if (quantity) hints.push(`quantity=${quantity}`);
  if (ctype) hints.push(`type=${ctype}`);
  if (compact?.code) hints.push(`code=${compact.code}`);
  if (explicitRelease && !waitingOnly) hints.push("status=ACTIVE_RELEASE");
  if (waitingOnly) hints.push("status=PLAN_WAITING_RELEASE_NOT_ACTIVE");
  if (confirmation && linked) hints.push("status=CONFIRMS_REPLIED_MESSAGE");
  return hints.length ? `HINT[${hints.join("; ")}]` : "";
}

function deterministicTextReleaseEvents(rows) {
  const events = [];
  for (const m of rows) {
    const own = normalizeText(msgText(m));
    const linked = linkedMessageText(m);
    const joined = normalizeText(`${own} ${linked}`);
    const series = namedReleaseSeries(joined) || m?._releaseSeries || null;
    const compact = compactReleaseNotation(own);
    const quantity = compact?.quantity || releaseQuantityFromText(own);
    const terminal = terminalFromText(joined);
    const explicitRelease = /(?:^|\\b)(?:по\\s+)?релиз(?:ы|а|у|ом)?(?:\\b|$)/i.test(own) || /\\/\\s*[pр](?:$|\\s)/i.test(own);
    const waitingOnly = /жд[её]м\\s+релиз|ожидаем\\s+релиз|будет\\s+релиз|на\\s+завтра.*жд[её]м/i.test(own) && !series;
    if (!quantity || waitingOnly) continue;
    if (!explicitRelease && !series && !compact) continue;

    events.push({
      event_type: "release",
      customer: null,
      supplier: null,
      terminal,
      container_type: compact?.container_type || null,
      quantity,
      container_numbers: [],
      amount_rub: null,
      release_id: series || compact?.code || null,
      effective_time_ms: msgTime(m) || null,
      source_message_ids: [msgId(m)].filter(Boolean),
      uncertain: !explicitRelease && !series,
      notes: compact?.code && series ? `series=${series}; code=${compact.code}; deterministic_text_release=true` : series ? `series=${series}; deterministic_text_release=true` : `code=${compact?.code || ""}; deterministic_text_release=true`
    });
  }
  return events;
}`;

replaceOnce(
  'function historyContextLine(m) {\n  const time = new Date(msgTime(m) || Date.now()).toISOString();\n  const series = m?._releaseSeries ? ` | СЕРИЯ=${m._releaseSeries}` : "";\n  return `[${time}] ${senderName(m)} | id=${msgId(m)}${series} | ${replyInfo(m)} ${normalizeText(msgText(m))}`.trim();\n}',
  `function historyContextLine(m) {\n  const time = new Date(msgTime(m) || Date.now()).toISOString();\n  const series = m?._releaseSeries ? \` | СЕРИЯ=\${m._releaseSeries}\` : "";\n  const hint = releaseTextHint(m);\n  return \`[\${time}] \${senderName(m)} | id=\${msgId(m)}\${series} | \${replyInfo(m)} \${normalizeText(msgText(m))}\${hint ? \` | \${hint}\` : ""}\`.trim();\n}\n\n${helpers}`,
  "add deterministic hints to transcript"
);

replaceOnce(
  'const parsed = await gigaJson([\n    { role: "system", content: `${DOMAIN_RULES}\\n\\nПреобразуй фрагмент рабочей переписки в журнал событий. Поздние реплики могут отменять или исправлять ранние. Используй message_id как источник. Один человеческий смысловой эпизод может включать несколько сообщений. Возвращай только события, важные для учета контейнеров, релизов, выдач, отмен, исправлений или оплат. Не создавай context-события для приветствий, коротких подтверждений и пустой болтовни. Ответ должен быть максимально компактным. В строках может быть СЕРИЯ=Релиз Ирина / Релиз Матвейченкова и т.п. Это заголовок серии, который относится ко всем следующим сообщениям и картинкам до следующего заголовка. Для КАЖДОГО события из такой строки обязательно сохрани принадлежность к серии: если отдельного номера релиза нет — запиши release_id равным названию серии; если отдельный номер релиза есть — сохрани его в release_id, а в notes обязательно добавь `series=<название серии>`. Картинка без текста тоже наследует СЕРИЮ.` },\n    { role: "user", content }\n  ], EVENT_SCHEMA);\n  return { events: parsed?.events || [], imageCount: imageTexts.length };',
  'const parsed = await gigaJson([\n    { role: "system", content: `${DOMAIN_RULES}\\n\\nПреобразуй фрагмент рабочей переписки в журнал событий. Поздние реплики могут отменять или исправлять ранние. Используй message_id как источник. Один человеческий смысловой эпизод может включать несколько сообщений. Возвращай только события, важные для учета контейнеров, релизов, выдач, отмен, исправлений или оплат. Не создавай context-события для приветствий, коротких подтверждений и пустой болтовни. Ответ должен быть максимально компактным. В строках может быть СЕРИЯ=Релиз Ирина / Релиз Матвейченкова и т.п. Это заголовок серии, который относится ко всем следующим сообщениям и картинкам до следующего заголовка. Фразы вида «Чехов 10 релиз Ирина», «все Чехов по релизу Ирина», «пусть ставит релиз Ирина» — это явная связь с именованным релизом. HINT[...] сформирован детерминированным парсером: используй его как сильную подсказку, но поздняя отмена/замена важнее. Компактная запись вида GFM-10x20DC/p означает quantity=10, type=20 DC, code=GFM и является релизной записью; терминал и серия могут следовать из цитируемого/соседнего контекста. Ответ «Да» на вопрос «Один релиз на всех троих?» подтверждает смысл вопроса и должен объединяться с цитируемым сообщением. Для КАЖДОГО события из строки с СЕРИЯ обязательно сохрани принадлежность к серии: если отдельного номера релиза нет — release_id=название серии; если отдельный номер есть — сохрани его в release_id, а notes добавь series=<название серии>.` },\n    { role: "user", content }\n  ], EVENT_SCHEMA);\n  const deterministic = deterministicTextReleaseEvents(rows);\n  return { events: [...deterministic, ...(parsed?.events || [])], imageCount: imageTexts.length };',
  "merge deterministic textual releases with semantic extraction"
);

replaceOnce(
  '8) Если пользователь называет клиента (например «по Взлёту»), фильтруй события по явной или надёжно следующей из переписки привязке к этому клиенту. Если пользователь спрашивает про именованную серию вида «Релиз Ирина», «Релиз Матвейченкова» и т.п., фильтруй по release_id и notes с series=<название>; собери ВСЕ события этой серии, включая картинки и текстовые сообщения без повторения имени.',
  '8) Если пользователь называет клиента (например «по Взлёту»), фильтруй события по явной или надёжно следующей из переписки привязке к этому клиенту. Если пользователь спрашивает про именованную серию вида «Релиз Ирина», «Релиз Матвейченкова» и т.п., фильтруй по release_id и notes с series=<название>; собери ВСЕ события этой серии, включая картинки и текстовые сообщения без повторения имени. Обязательно учитывай текстовые формы «Чехов 10 релиз Ирина», «по релизу Ирина», reply-цепочки и компактные записи вида GFM-10x20DC/p.',
  "final answer uses text release patterns"
);

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v53-text-release-logic",');
code = code.replace('namedReleaseSeriesFixed: true,', 'namedReleaseSeriesFixed: true,\n  textReleaseLogicFixed: true,');

fs.writeFileSync(path, code);
console.log("MAX textual release logic v53 enabled");
