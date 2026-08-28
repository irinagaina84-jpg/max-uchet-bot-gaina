import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

const privateAnchor = 'async function handlePrivate(message) {';
if (!code.includes(privateAnchor)) throw new Error("v74 private import handler anchor not found");

const privateLine = '  const text = normalizeText(msgText(message)); const imgs = imageUrls(message); if (!text && !imgs.length) return;';
if (!code.includes(privateLine)) throw new Error("v74 private import line anchor not found");

const helpers = String.raw`
const privateImportSessions = new Map();

function privateImportChatId(senderId) {
  const digits = String(senderId || "").replace(/\D/g, "");
  const tail = (digits || "0").slice(-16).padStart(16, "0");
  return "-91" + tail;
}

function privateForwardLink(message) {
  const candidates = [
    message?.link,
    message?.body?.link,
    message?.forwarded_message,
    message?.body?.forwarded_message,
  ].filter(Boolean);
  for (const link of candidates) {
    const type = String(link?.type || link?.link_type || link?.kind || "").toLowerCase();
    if (type.includes("forward")) return link;
  }
  return null;
}

function privateForwardBody(link) {
  const candidates = [
    link?.message_body,
    link?.messageBody,
    link?.message?.body,
    link?.body,
    link?.message,
  ];
  for (const value of candidates) {
    if (value && typeof value === "object") return value;
  }
  return {};
}

function privateForwardSender(link) {
  return link?.sender || link?.message?.sender || { first_name: "Собеседник" };
}

function privateForwardAttachments(link, body) {
  const candidates = [body?.attachments, link?.attachments, link?.message?.attachments, link?.message?.body?.attachments];
  for (const value of candidates) if (Array.isArray(value)) return value;
  return [];
}

function privateForwardText(link, body) {
  return String(body?.text ?? link?.text ?? link?.message?.text ?? link?.message?.body?.text ?? "");
}

function privateForwardSourceMid(link, body) {
  return String(body?.mid || body?.id || link?.mid || link?.message_id || link?.message?.mid || link?.message?.id || "");
}

function privateForwardSourceChatId(link) {
  return String(link?.chat_id || link?.chatId || link?.message?.recipient?.chat_id || "");
}

function privateForwardSourceTimestamp(link, body) {
  let value = Number(link?.timestamp || link?.message?.timestamp || body?.timestamp || 0);
  if (value > 0 && value < 100000000000) value *= 1000;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function loadPrivateImportSession(senderId) {
  const chatId = privateImportChatId(senderId);
  const cached = privateImportSessions.get(chatId);
  if (cached?.active) return cached;
  try {
    const data = await ledgerRequest("/state?chat_id=" + encodeURIComponent(chatId), { timeout: 20000 });
    const saved = data?.state || null;
    if (saved?.kind === "private_forward_import" && saved?.active) {
      const session = { ...saved, chat_id: chatId };
      privateImportSessions.set(chatId, session);
      return session;
    }
  } catch (e) {
    state.lastError = "private import state: " + errText(e);
  }
  return null;
}

async function savePrivateImportSession(session) {
  privateImportSessions.set(session.chat_id, session);
  await ledgerRequest("/state", {
    method: "POST",
    body: { chat_id: session.chat_id, state: session },
    timeout: 30000,
  });
}

async function startPrivateImportSession(senderId, label = "Личная переписка") {
  const chatId = privateImportChatId(senderId);
  const startedAt = Date.now();
  const session = {
    kind: "private_forward_import",
    active: true,
    chat_id: chatId,
    session_id: String(startedAt),
    label: normalizeText(label || "Личная переписка").slice(0, 120) || "Личная переписка",
    started_at: startedAt,
    count: 0,
    last_timestamp: startedAt,
  };
  await savePrivateImportSession(session);
  await ledgerRequest("/raw", {
    method: "POST",
    body: {
      records: [{
        chat_id: chatId,
        mid: "import-session-" + session.session_id,
        timestamp: startedAt,
        update_type: "message_created",
        sender: { first_name: "СИСТЕМА" },
        recipient: { chat_id: chatId, chat_type: "imported_private" },
        text: "[СЛУЖЕБНАЯ ЗАПИСЬ] Импорт личной переписки: " + session.label + ". Сообщения ниже расположены в порядке пересылки. Если исходная дата не передана MAX в пересланном сообщении, дата в архиве означает время импорта.",
        body: { text: "Импорт личной переписки: " + session.label },
        attachments: [],
        imported_private: true,
        import_session_id: session.session_id,
      }],
    },
    timeout: 30000,
  });
  return session;
}

async function ingestPrivateForward(message, senderId, link) {
  let session = await loadPrivateImportSession(senderId);
  let autoStarted = false;
  if (!session) {
    session = await startPrivateImportSession(senderId, "Личная переписка");
    autoStarted = true;
  }

  const body = privateForwardBody(link);
  const sourceText = privateForwardText(link, body);
  const sourceAttachments = privateForwardAttachments(link, body);
  const outerMid = msgId(message) || randomUUID();
  const sourceMid = privateForwardSourceMid(link, body);
  const baseTimestamp = Number(msgTime(message) || Date.now());
  const timestamp = Math.max(baseTimestamp, Number(session.last_timestamp || 0) + 1);
  const recordMid = ("import-" + session.session_id + "-" + outerMid).slice(0, 190);

  await ledgerRequest("/raw", {
    method: "POST",
    body: {
      records: [{
        chat_id: session.chat_id,
        mid: recordMid,
        timestamp,
        update_type: "message_created",
        sender: privateForwardSender(link),
        recipient: { chat_id: session.chat_id, chat_type: "imported_private" },
        text: sourceText,
        body,
        attachments: sourceAttachments,
        imported_private: true,
        import_session_id: session.session_id,
        source_mid: sourceMid,
        source_chat_id: privateForwardSourceChatId(link),
        source_timestamp: privateForwardSourceTimestamp(link, body),
        imported_at: Date.now(),
      }],
    },
    timeout: 30000,
  });

  session.count = Number(session.count || 0) + 1;
  session.last_timestamp = timestamp;
  privateImportSessions.set(session.chat_id, session);
  if (session.count % 25 === 0) await savePrivateImportSession(session);

  if (autoStarted) {
    await sendText(
      "user_id=" + encodeURIComponent(senderId),
      "Начала новую пачку личной переписки. Пересылай сообщения дальше — по одному или большими пачками. Я буду сохранять молча. Когда закончишь, напиши: Собрать ZIP"
    );
  }
}

async function handlePrivateImportCommand(senderId, text) {
  const normalized = normalizeText(text);
  const startMatch = normalized.match(/^(?:начать\s+импорт|новая\s+переписка|новый\s+импорт)(?:\s*[:—-]?\s*(.*))?$/i);
  if (startMatch) {
    const label = normalizeText(startMatch[1] || "Личная переписка");
    const session = await startPrivateImportSession(senderId, label);
    await sendText(
      "user_id=" + encodeURIComponent(senderId),
      "Готово. Новая пачка создана: " + session.label + ".\nТеперь пересылай сюда сообщения из личного чата большими пачками. Я их сохраняю, но не отвечаю на каждое.\nКогда закончишь — напиши: Собрать ZIP"
    );
    return true;
  }

  if (/^(?:статус\s+импорта|сколько\s+сохранено)$/i.test(normalized)) {
    const session = await loadPrivateImportSession(senderId);
    if (!session) {
      await sendText("user_id=" + encodeURIComponent(senderId), "Сейчас активной пачки нет. Напиши: Новая переписка Имя");
    } else {
      await sendText(
        "user_id=" + encodeURIComponent(senderId),
        "Активная пачка: " + session.label + ".\nСохранено в этой сессии: примерно " + Number(session.count || 0) + " сообщений.\nДля архива: Собрать ZIP"
      );
    }
    return true;
  }

  if (/^(?:собрать\s+zip|сделать\s+zip|zip|архив\s+переписки|собрать\s+архив|готово)$/i.test(normalized)) {
    const session = await loadPrivateImportSession(senderId);
    if (!session) {
      await sendText("user_id=" + encodeURIComponent(senderId), "Нет активной пачки. Напиши: Новая переписка Имя — и затем пересылай сообщения.");
      return true;
    }

    const finishedAt = Date.now();
    const exportKey = createHash("sha256").update(MAX_BOT_TOKEN).digest("hex").slice(0, 32);
    const exportOrigin = WEBHOOK_URL ? new URL(WEBHOOK_URL).origin : "https://max-uchet-bot-gaina.irina-gaina-84-036.workers.dev";
    const fromMs = Math.max(0, Number(session.started_at || 0) - 1);
    const toMs = Math.max(finishedAt + 60000, Number(session.last_timestamp || 0) + 60000);
    const exportUrl = exportOrigin + "/export/media?t=" + encodeURIComponent(exportKey)
      + "&mode=all&chat_id=" + encodeURIComponent(session.chat_id)
      + "&limit=5000&from=" + encodeURIComponent(String(fromMs))
      + "&to=" + encodeURIComponent(String(toMs));

    const finalSession = { ...session, active: false, finished_at: finishedAt };
    await savePrivateImportSession(finalSession);
    await sendText(
      "user_id=" + encodeURIComponent(senderId),
      "ZIP готов.\nПачка: " + session.label + "\nСохранено: " + Number(session.count || 0) + " пересланных сообщений.\n\nСкачать ZIP:\n" + exportUrl + "\n\nПотом отправь этот ZIP мне в ChatGPT на анализ. Для следующего человека напиши: Новая переписка Имя"
    );
    return true;
  }

  return false;
}
`;

code = code.replace(privateAnchor, helpers + "\n" + privateAnchor);

const replacement = String.raw`  const text = normalizeText(msgText(message)); const imgs = imageUrls(message);
  const forwarded = privateForwardLink(message);
  if (forwarded) { await ingestPrivateForward(message, senderId, forwarded); return; }
  if (await handlePrivateImportCommand(senderId, text)) return;
  if (!text && !imgs.length) return;`;
code = code.replace(privateLine, replacement);

code = code.replace(/version:\s*"v[^"]+"\s*,?/, 'version: "v74-private-forward-import",');
if (code.includes("lastError: null,") && !code.includes("privateForwardImport: true,")) {
  code = code.replace("lastError: null,", "lastError: null,\n  privateForwardImport: true,");
}

fs.writeFileSync(path, code);
console.log("v74 private forwarded-message batch ZIP import enabled");
