import fs from "node:fs";

const src = "./bot-giga-v14.js";
const dst = "./bot.js";
let code = fs.readFileSync(src, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) {
    console.warn("patch skipped: " + label);
    return false;
  }
  code = code.replace(oldText, newText);
  console.log("patched: " + label);
  return true;
}

replaceOnce(
  'const PORT = Number(process.env.PORT || 3000);\nconst TZ_OFFSET_MINUTES = Number(process.env.ACCOUNTING_TZ_OFFSET_MINUTES || 300);',
  'const PORT = Number(process.env.PORT || 3000);\nconst TZ_OFFSET_MINUTES = Number(process.env.ACCOUNTING_TZ_OFFSET_MINUTES || 300);\nconst STATE_URL = (process.env.STATE_URL || "").trim();',
  'state url env'
);

replaceOnce(
  'Релиз, бронь, заявка, окно выдачи — НЕ факт выдачи.\nФакт выдачи: только когда по смыслу подтверждено «выдали», «забрали», «выпустили», «увезли», «отгрузили», «получили» или равнозначно.',
  'Для ЭТОГО рабочего учета опубликованный релиз на конкретные контейнеры или конкретное количество считается оперативной выдачей/выпуском, если позже нет отмены, замены, сообщения «не считать», «не выдали», «только бронь», «ещё согласовывают» или другого явного отката. Вопросы вроде «сделали релиз?» и планы без самого релиза не считать. Явные слова «выдали», «забрали», «выпустили», «увезли», «отгрузили», «получили» также подтверждают выдачу. Если релиз позже отменён или заменён, итог пересчитать по последнему состоянию.',
  'release accounting rule'
);

replaceOnce(
  'async function fetchHistory(chatId, since, until = Date.now(), max = 500) {',
  'async function fetchHistory(chatId, since, until = Date.now(), max = 5000) {',
  'history max'
);

replaceOnce(
  'for (let page = 0; page < 5 && out.length < max; page++) {',
  'for (let page = 0; page < 50 && out.length < max; page++) {',
  'history pages'
);

replaceOnce(
  'const history = await fetchHistory(chatId, start, end, 500);',
  'const history = await fetchHistory(chatId, start, end, 5000);',
  'extract full history'
);

replaceOnce(
  'if (q.includes("за весь чат") || q.includes("за все время") || q.includes("за всё время") || q.includes("всего")) return { start: null, end: Date.now() };',
  'if (/(за весь чат|за все время|за всё время|всего|итог|общее|общий|выдан|релиз|считай|посчитай)/i.test(q)) return { start: null, end: Date.now() };',
  'full-history intent'
);

replaceOnce(
  'Релиз без confirmed_issue не включай в выдано.',
  'Активный release включай в оперативный итог выдано/выпущено, если это реально опубликованный релиз на контейнеры/количество и позже нет cancellation/correction, которая его отменяет. Не включай только обсуждение будущего релиза, бронь, согласование или явно неподтвержденную заявку.',
  'final release rule'
);

replaceOnce(
  'Если вопрос «выпиши по Взлёту» — сначала дай подтвержденный факт выдачи по Взлёту, затем отдельно «Только релизы / ещё не подтверждено».',
  'Если вопрос «выпиши по Взлёту» — сначала дай оперативный итог по активным релизам и подтвержденным выдачам Взлёта с учетом отмен и замен. Отдельно показывай только бронь/планы/согласование, которые ещё не стали релизом.',
  'answer release wording'
);

replaceOnce(
  'Если отмена изменила итог, просто покажи уже исправленный итог и коротко укажи «учтена отмена …».',
  'Если отмена изменила итог, просто покажи уже исправленный итог и коротко укажи «учтена отмена …». Если пользователь просит «итог», «сколько», «общее количество» — сначала дай одно итоговое число, затем максимум 6 коротких строк разбивки. Если пользователь пишет «только с чата X», используй только события из chat_title, соответствующего X по смыслу, и не смешивай другие чаты.',
  'concise and chat focus'
);

const maxRequestAnchor = [
  'async function maxRequest(path, options = {}) {',
  '  const r = await requestJson(`${MAX_API}${path}`, {',
  '    ...options,',
  '    headers: { Authorization: MAX_BOT_TOKEN, Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },',
  '    body: options.body ? JSON.stringify(options.body) : null,',
  '  });',
  '  return r.data;',
  '}',
  ''
].join('\n');

const stateHelpers = maxRequestAnchor + [
  'async function loadPersistedChats() {',
  '  if (!STATE_URL) return;',
  '  try {',
  '    const r = await requestJson(STATE_URL, {',
  '      method: "GET",',
  '      headers: { "X-Internal-Auth": MAX_BOT_TOKEN, Accept: "application/json" },',
  '      timeout: 15000,',
  '    });',
  '    const list = Array.isArray(r.data) ? r.data : [];',
  '    for (const item of list) {',
  '      if (item?.chat_id == null) continue;',
  '      knownGroups.set(String(item.chat_id), {',
  '        title: String(item.title || ("чат " + item.chat_id)),',
  '        lastSeenAt: Number(item.lastSeenAt || 0),',
  '      });',
  '    }',
  '    state.knownGroupCount = knownGroups.size;',
  '  } catch (error) {',
  '    console.error("loadPersistedChats", errText(error));',
  '  }',
  '}',
  '',
  'async function persistKnownChats() {',
  '  if (!STATE_URL) return;',
  '  try {',
  '    const list = [...knownGroups.entries()].map(([chat_id, meta]) => ({',
  '      chat_id,',
  '      title: meta?.title || ("чат " + chat_id),',
  '      lastSeenAt: Number(meta?.lastSeenAt || Date.now()),',
  '    }));',
  '    await requestJson(STATE_URL, {',
  '      method: "POST",',
  '      headers: {',
  '        "X-Internal-Auth": MAX_BOT_TOKEN,',
  '        Accept: "application/json",',
  '        "Content-Type": "application/json",',
  '      },',
  '      body: JSON.stringify(list),',
  '      timeout: 15000,',
  '    });',
  '  } catch (error) {',
  '    console.error("persistKnownChats", errText(error));',
  '  }',
  '}',
  ''
].join('\n');

replaceOnce(maxRequestAnchor, stateHelpers, 'persistent chat helpers');

replaceOnce(
  'state.lastGroupChatId = String(chatId); state.lastGroupName = info.title;\n  return info;',
  'state.lastGroupChatId = String(chatId); state.lastGroupName = info.title;\n  await persistKnownChats();\n  return info;',
  'persist remembered chat'
);

replaceOnce(
  'if (u?.chat_id != null) { knownGroups.delete(String(u.chat_id)); state.knownGroupCount = knownGroups.size; }',
  'if (u?.chat_id != null) { knownGroups.delete(String(u.chat_id)); state.knownGroupCount = knownGroups.size; await persistKnownChats(); }',
  'persist removed chat'
);

replaceOnce(
  'await getGigaToken(false); state.gigachatAuthorized = true;\n      for (const id of SEEDED_CHAT_IDS) await rememberGroup(id);',
  'await getGigaToken(false); state.gigachatAuthorized = true;\n      await loadPersistedChats();\n      for (const id of SEEDED_CHAT_IDS) await rememberGroup(id);',
  'load chats on startup'
);

fs.writeFileSync(dst, code);
console.log('full-chat patch complete');
