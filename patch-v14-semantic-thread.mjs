import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function requireAnchor(ok, label) {
  if (!ok) throw new Error(`semantic-thread patch anchor not found: ${label}`);
  console.log(`semantic-thread patched: ${label}`);
}

const semanticRules = `

СМЫСЛ ЖИВОЙ ПЕРЕПИСКИ И ФИНАЛЬНЫЙ СТАТУС:
- Читай весь смысловой эпизод до конца, а не отдельное ключевое слово. Один факт может пройти стадии: заявка -> сомнение -> уточнение -> подтверждение.
- Фраза «это не релизы», «не то», «ошибка», «не считать» может быть промежуточным спором или сообщением со слов терминала. Она НЕ является автоматической окончательной отменой, если следующие сообщения эту фразу уточняют или опровергают.
- Приоритет имеет последнее РАЗРЕШЕННОЕ состояние факта: что в итоге участники признали и использовали в работе. Если сначала написали «не релизы», а позже выяснилось, что это именно нужные релизы, финальный статус — релизы; отмену по промежуточной реплике не создавай.
- Если спор так и не разрешен, помечай факт uncertain=true и не включай его в уверенный итог.
- Ответ на конкретное сообщение относится прежде всего к процитированной строке, но после него обязательно проверь дальнейшие ответы и уточнения по этой же теме.
- В терминальных чатах шестизначные числа вида 105092, 105094 могут быть НОМЕРАМИ РЕЛИЗОВ/ТЕРМИНАЛЬНЫМИ КОДАМИ. Не отбрасывай их только потому, что номер контейнера имеет другой формат.
- Типичный блок: «СВС 2 ктк на 27.08 ...», затем «Егоров 105092, 105094», «Закиров 105088, 105090», «Трищичев 105084, 105086». Если соседний контекст показывает, что участники передают таким образом релизы, каждая такая пара означает 2 релиза для указанного водителя. Отсутствие слова «релиз» в каждой строке не превращает их обратно в простой план.
- Номер контейнера обычно имеет 4 латинские буквы + 7 цифр; номер релиза может быть коротким цифровым кодом. Не путай эти сущности.
- Не задваивай: повторное обсуждение одного кода не создает второй контейнер. Если релиз позже привел к выдаче, это один КТК со статусами «релиз -> выдано», а не два КТК.
`;

const domainRe = /const DOMAIN_RULES = `([\s\S]*?)`;/;
requireAnchor(domainRe.test(code), "DOMAIN_RULES");
code = code.replace(domainRe, (full, body) => `const DOMAIN_RULES = \`${body}${semanticRules.replace(/`/g, "\\`")}\`;`);

const helperAnchor = "function terminalFromText(text) {";
requireAnchor(code.includes(helperAnchor), "terminal helper anchor");
const semanticHelpers = `function sixDigitReleaseCodes(text) {
  return [...normalizeText(text).matchAll(/(?:^|\\D)(\\d{6})(?=\\D|$)/g)].map((m) => String(m[1]));
}

function looksLikeDriverCodeLine(text) {
  const t = normalizeText(text);
  const codes = sixDigitReleaseCodes(t);
  if (!codes.length) return false;
  return /^[А-ЯЁA-Z][А-ЯЁа-яёA-Za-z-]{2,}(?:\\s+[А-ЯЁA-Z][А-ЯЁа-яёA-Za-z-]{2,}){0,2}\\s+\\d{6}(?:\\s*[,;]\\s*\\d{6})*/.test(t);
}

function semanticReleaseHeader(text) {
  const t = normalizeText(text);
  const terminal = terminalFromText(t);
  const quantity = releaseQuantityFromText(t);
  const logistics = /(?:ктк|контейнер|водител|телефон|авто|машин|на\\s+\\d{1,2}[.\\/-]\\d{1,2})/i.test(t);
  if (!terminal || !quantity || !logistics) return null;
  return { terminal, expectedPerDriver: quantity };
}

function annotateSemanticReleaseBlocks(rows) {
  let block = null;
  let blockAt = 0;
  return rows.map((row) => {
    const text = normalizeText(msgText(row));
    const at = msgTime(row) || 0;
    const header = semanticReleaseHeader(text);
    const mentionedTerminal = terminalFromText(text);
    if (header) {
      block = header;
      blockAt = at || blockAt;
    } else if (block && mentionedTerminal && mentionedTerminal !== block.terminal) {
      block = null;
      blockAt = 0;
    } else if (block && blockAt && at && at - blockAt > 8 * 60 * 60 * 1000) {
      block = null;
      blockAt = 0;
    }

    const codes = sixDigitReleaseCodes(text);
    const semantic = block && looksLikeDriverCodeLine(text) && codes.length
      ? { terminal: block.terminal, expectedPerDriver: block.expectedPerDriver, codes, quantity: codes.length }
      : null;
    return { ...row, _semanticReleaseBlock: semantic };
  });
}

`;
code = code.replace(helperAnchor, semanticHelpers + helperAnchor);

const annotateAnchor = "const annotatedHistory = annotateReleaseSeries(history);";
requireAnchor(code.includes(annotateAnchor), "annotated history");
code = code.replace(annotateAnchor, "const annotatedHistory = annotateSemanticReleaseBlocks(annotateReleaseSeries(history));");

const hintAnchor = "const hints = [];";
requireAnchor(code.includes(hintAnchor), "release hints");
code = code.replace(hintAnchor, `const hints = [];
  const semanticBlock = m?._semanticReleaseBlock || null;
  const numericCodes = sixDigitReleaseCodes(own);
  const disputesRelease = /(?:не\\s+релиз|это\\s+не\\s+релиз|не\\s+те\\s+релиз|ошибк|не\\s+считать|неверн)/i.test(own);
  if (semanticBlock) {
    hints.push(\`semantic_terminal=\${semanticBlock.terminal}\`);
    hints.push(\`numeric_release_codes=\${semanticBlock.codes.join(",")}\`);
    hints.push(\`quantity=\${semanticBlock.quantity}\`);
    hints.push("status=LIKELY_RELEASE_CODES_BY_CHAT_STRUCTURE");
  } else if (looksLikeDriverCodeLine(own) && numericCodes.length) {
    hints.push(\`numeric_release_codes=\${numericCodes.join(",")}\`);
    hints.push("status=NUMERIC_CODES_NEED_NEIGHBOR_CONTEXT");
  }
  if (disputesRelease) hints.push("status=DISPUTE_NOT_FINAL_UNTIL_LATER_CONTEXT_RESOLVES");`);

const oldSentence = "Поздние реплики могут отменять или исправлять ранние.";
const newSentence = "Поздние реплики могут отменять или исправлять ранние, но промежуточное сомнение не считай окончательной отменой: дочитай эпизод до последнего разрешенного состояния факта.";
requireAnchor(code.includes(oldSentence), "semantic extraction sentence");
code = code.split(oldSentence).join(newSentence);

code = code.split("HINT[...] сформирован детерминированным парсером: используй его как сильную подсказку, но поздняя отмена/замена важнее.").join(
  "HINT[...] сформирован детерминированным парсером: используй его как сильную подсказку. Для status=LIKELY_RELEASE_CODES_BY_CHAT_STRUCTURE считай шестизначные коды вероятными релизами по структуре соседних сообщений. Реплика status=DISPUTE_NOT_FINAL_UNTIL_LATER_CONTEXT_RESOLVES означает только спор: проверь более поздние сообщения и примени итоговое разрешенное состояние, а не сам факт отрицательной фразы."
);

// Some older prompt fragments used Markdown backticks inside JavaScript template literals.
// They are formatting only and break the generated bot source after patching.
code = code.split('`series=<название серии>`').join('series=<название серии>');
code = code.split('`series=<название>`').join('series=<название>');

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v55-semantic-thread",');
code = code.replace(
  "incrementalChunkCache: true,",
  "incrementalChunkCache: true,\n  semanticThreadResolution: true,\n  numericTerminalReleaseCodes: true,"
);

fs.writeFileSync(path, code);
console.log("Semantic thread/release resolution v55 enabled");
