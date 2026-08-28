import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

const commandAnchor = "async function handlePrivateImportCommand(senderId, text) {";
if (!code.includes(commandAnchor)) throw new Error("v75 import command anchor not found");

const screenshotHelper = String.raw`
async function ingestPrivateScreenshot(message, senderId, session) {
  const outerMid = msgId(message) || randomUUID();
  const baseTimestamp = Number(msgTime(message) || Date.now());
  const timestamp = Math.max(baseTimestamp, Number(session.last_timestamp || 0) + 1);
  const recordMid = ("import-screen-" + session.session_id + "-" + outerMid).slice(0, 190);
  const rawAttachments = attachments(message);
  const screenshotCount = Math.max(1, imageUrls(message).length || rawAttachments.length);
  const caption = String(msgText(message) || "").trim();

  await ledgerRequest("/raw", {
    method: "POST",
    body: {
      records: [{
        chat_id: session.chat_id,
        mid: recordMid,
        timestamp,
        update_type: "message_created",
        sender: message?.sender || { first_name: "Ирина" },
        recipient: { chat_id: session.chat_id, chat_type: "imported_private" },
        text: caption || "[СКРИНШОТ ИЗ ЛИЧНОЙ ПЕРЕПИСКИ]",
        body: message?.body || { text: caption },
        attachments: rawAttachments,
        imported_private: true,
        import_session_id: session.session_id,
        source_kind: "screenshot",
        imported_at: Date.now(),
      }],
    },
    timeout: 30000,
  });

  session.count = Number(session.count || 0) + 1;
  session.screenshot_count = Number(session.screenshot_count || 0) + screenshotCount;
  session.last_timestamp = timestamp;
  privateImportSessions.set(session.chat_id, session);
  if (session.count % 10 === 0) await savePrivateImportSession(session);
}

`;

code = code.replace(commandAnchor, screenshotHelper + commandAnchor);

const oldPrivateFlow = String.raw`  const text = normalizeText(msgText(message)); const imgs = imageUrls(message);
  const forwarded = privateForwardLink(message);
  if (forwarded) { await ingestPrivateForward(message, senderId, forwarded); return; }
  if (await handlePrivateImportCommand(senderId, text)) return;
  if (!text && !imgs.length) return;`;

const newPrivateFlow = String.raw`  const text = normalizeText(msgText(message)); const imgs = imageUrls(message);
  const forwarded = privateForwardLink(message);
  if (forwarded) { await ingestPrivateForward(message, senderId, forwarded); return; }
  if (await handlePrivateImportCommand(senderId, text)) return;
  if (imgs.length) {
    const importSession = await loadPrivateImportSession(senderId);
    if (importSession) { await ingestPrivateScreenshot(message, senderId, importSession); return; }
  }
  if (!text && !imgs.length) return;`;

if (!code.includes(oldPrivateFlow)) throw new Error("v75 private flow anchor not found");
code = code.replace(oldPrivateFlow, newPrivateFlow);

code = code.replace(
  '"Готово. Новая пачка создана: " + session.label + ".\\nТеперь пересылай сюда сообщения из личного чата большими пачками. Я их сохраняю, но не отвечаю на каждое.\\nКогда закончишь — напиши: Собрать ZIP"',
  '"Готово. Новая пачка создана: " + session.label + ".\\nТеперь пересылай сюда сообщения из личного чата большими пачками и кидай скриншоты. Я всё складываю в один архив и не отвечаю на каждый элемент.\\nКогда закончишь — напиши: Собрать ZIP"'
);

code = code.replace(
  '"Активная пачка: " + session.label + ".\\nСохранено в этой сессии: примерно " + Number(session.count || 0) + " сообщений.\\nДля архива: Собрать ZIP"',
  '"Активная пачка: " + session.label + ".\\nСохранено элементов: примерно " + Number(session.count || 0) + ". Скриншотов: " + Number(session.screenshot_count || 0) + ".\\nДля архива: Собрать ZIP"'
);

code = code.replace(
  '"ZIP готов.\\nПачка: " + session.label + "\\nСохранено: " + Number(session.count || 0) + " пересланных сообщений.\\n\\nСкачать ZIP:\\n" + exportUrl',
  '"ZIP готов.\\nПачка: " + session.label + "\\nСохранено элементов: " + Number(session.count || 0) + ". Скриншотов: " + Number(session.screenshot_count || 0) + ".\\n\\nСкачать ZIP:\\n" + exportUrl'
);

code = code.replace(/version:\s*"v[^"]+"\s*,?/, 'version: "v75-private-import-screenshots",');
if (code.includes("privateForwardImport: true,") && !code.includes("privateImportScreenshots: true,")) {
  code = code.replace("privateForwardImport: true,", "privateForwardImport: true,\n  privateImportScreenshots: true,");
}

fs.writeFileSync(path, code);
console.log("v75 screenshots in private import session enabled");
