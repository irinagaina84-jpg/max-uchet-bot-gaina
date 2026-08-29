import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function mustReplace(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error("v77 anchor not found: " + label);
  code = code.replace(oldText, newText);
  console.log("v77 patched: " + label);
}

if (!code.includes('import { ImapFlow } from "imapflow";')) {
  const cryptoImport = code.match(/import\s+\{[^\n}]*\}\s+from\s+"node:crypto";/);
  if (!cryptoImport) throw new Error("v77 crypto import anchor not found");
  code = code.replace(cryptoImport[0], cryptoImport[0] + '\nimport { ImapFlow } from "imapflow";');
  console.log("v77 patched: imapflow import");
}

if (!code.includes('const MAILRU_LOGIN =')) {
  const seededMatch = code.match(/const SEEDED_CHAT_IDS = [^\n]+;/);
  if (!seededMatch) throw new Error("v77 SEEDED_CHAT_IDS anchor not found");
  code = code.replace(
    seededMatch[0],
    seededMatch[0] + '\nconst MAILRU_LOGIN = (process.env.MAILRU_LOGIN || "").trim();\nconst MAILRU_APP_PASSWORD = (process.env.MAILRU_APP_PASSWORD || "").trim();\nconst MAILRU_LOOKBACK_DAYS = Math.max(30, Number(process.env.MAILRU_LOOKBACK_DAYS || 400));'
  );
  console.log("v77 patched: mail env");
}

const privateAnchor = 'async function handlePrivate(message) {';
if (!code.includes(privateAnchor)) throw new Error("v77 private handler anchor not found");

const helpers = String.raw`
let mailInventoryRunning = false;

function mailMonthKey(value) {
  const date = value instanceof Date ? value : new Date(value || 0);
  if (!Number.isFinite(date.getTime())) return "без даты";
  return String(date.getUTCFullYear()) + "-" + String(date.getUTCMonth() + 1).padStart(2, "0");
}

function mailReadableBytes(bytes) {
  const value = Math.max(0, Number(bytes || 0));
  if (value >= 1024 * 1024 * 1024) return (value / (1024 * 1024 * 1024)).toFixed(2) + " ГБ";
  if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + " МБ";
  if (value >= 1024) return (value / 1024).toFixed(0) + " КБ";
  return String(value) + " Б";
}

function mailAttachmentStats(structure) {
  const result = { count: 0, bytes: 0 };
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const disposition = String(node.disposition || "").toLowerCase();
    const dispositionParameters = node.dispositionParameters || {};
    const parameters = node.parameters || {};
    const filename = String(dispositionParameters.filename || parameters.name || "").trim();
    const isAttachment = disposition === "attachment" || Boolean(filename);
    if (isAttachment) {
      result.count += 1;
      result.bytes += Math.max(0, Number(node.size || 0));
    }
    for (const child of Array.isArray(node.childNodes) ? node.childNodes : []) walk(child);
  };
  walk(structure);
  return result;
}

function mailFolderAllowed(box) {
  const specialUse = String(box?.specialUse || "").toLowerCase();
  if (/trash|junk|spam|draft/.test(specialUse)) return false;
  const flags = [...(box?.flags || [])].map((value) => String(value).toLowerCase());
  if (flags.includes("\\noselect")) return false;
  return Boolean(box?.path);
}

async function scanMailruInventory() {
  if (!MAILRU_LOGIN || !MAILRU_APP_PASSWORD) {
    throw new Error("MAILRU_LOGIN / MAILRU_APP_PASSWORD не переданы в контейнер");
  }

  const client = new ImapFlow({
    host: "imap.mail.ru",
    port: 993,
    secure: true,
    auth: { user: MAILRU_LOGIN, pass: MAILRU_APP_PASSWORD },
    logger: false,
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 120000,
  });

  const since = new Date(Date.now() - MAILRU_LOOKBACK_DAYS * 86400000);
  const monthly = new Map();
  const seen = new Set();
  const folderStats = [];
  const errors = [];
  let messageCount = 0;
  let attachmentCount = 0;
  let attachmentBytes = 0;

  client.on("error", (error) => {
    state.lastMailError = errText(error).slice(0, 500);
  });

  await client.connect();
  try {
    const boxes = (await client.list()).filter(mailFolderAllowed);
    for (const box of boxes) {
      const folder = { path: String(box.path), messages: 0, attachments: 0, attachmentBytes: 0 };
      try {
        await client.mailboxOpen(box.path, { readOnly: true });
        const uids = await client.search({ since }, { uid: true });
        for (let offset = 0; offset < uids.length; offset += 300) {
          const uidSet = uids.slice(offset, offset + 300).join(",");
          if (!uidSet) continue;
          for await (const message of client.fetch(
            uidSet,
            { uid: true, envelope: true, internalDate: true, size: true, bodyStructure: true },
            { uid: true }
          )) {
            const messageId = String(message?.envelope?.messageId || "").trim().toLowerCase();
            const dedupeKey = messageId || (String(box.path) + ":" + String(message?.uid || ""));
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            const date = message?.internalDate || message?.envelope?.date || since;
            const month = mailMonthKey(date);
            const files = mailAttachmentStats(message?.bodyStructure);
            const row = monthly.get(month) || { messages: 0, attachments: 0, attachmentBytes: 0 };
            row.messages += 1;
            row.attachments += files.count;
            row.attachmentBytes += files.bytes;
            monthly.set(month, row);

            messageCount += 1;
            attachmentCount += files.count;
            attachmentBytes += files.bytes;
            folder.messages += 1;
            folder.attachments += files.count;
            folder.attachmentBytes += files.bytes;
          }
        }
        folderStats.push(folder);
      } catch (error) {
        errors.push(String(box.path) + ": " + errText(error).slice(0, 300));
      }
    }
  } finally {
    try { await client.logout(); } catch {}
  }

  return {
    since: since.toISOString(),
    days: MAILRU_LOOKBACK_DAYS,
    folders: folderStats,
    messages: messageCount,
    attachments: attachmentCount,
    attachmentBytes,
    monthly: [...monthly.entries()].sort((a, b) => b[0].localeCompare(a[0])),
    errors,
  };
}

function formatMailruInventory(result) {
  const lines = [
    "Mail.ru — инвентаризация почты",
    "Период: последние " + result.days + " дней",
    "Папок проверено: " + result.folders.length,
    "Писем: " + result.messages,
    "Вложений: " + result.attachments + " (примерно " + mailReadableBytes(result.attachmentBytes) + ")",
    "",
    "По месяцам:",
  ];
  for (const [month, row] of result.monthly) {
    lines.push("• " + month + " — " + row.messages + " писем / " + row.attachments + " файлов (" + mailReadableBytes(row.attachmentBytes) + ")");
  }
  if (result.errors.length) {
    lines.push("", "Не удалось проверить " + result.errors.length + " папок:");
    for (const item of result.errors.slice(0, 5)) lines.push("• " + item);
  }
  lines.push("", "Это только подсчёт метаданных. Письма и файлы не удалялись, не перемещались и не помечались прочитанными.");
  return lines.join("\n");
}

async function runMailruInventoryForUser(senderId) {
  if (mailInventoryRunning) {
    await sendText("user_id=" + encodeURIComponent(senderId), "Проверка почты уже идёт. Дождись итоговой сводки.");
    return;
  }
  mailInventoryRunning = true;
  try {
    await sendText("user_id=" + encodeURIComponent(senderId), "Проверяю Mail.ru за год с запасом. Пока только считаю письма и вложения — ничего не скачиваю и не меняю.");
    const result = await scanMailruInventory();
    state.lastMailScanAt = new Date().toISOString();
    state.lastMailMessages = result.messages;
    state.lastMailAttachments = result.attachments;
    await sendText("user_id=" + encodeURIComponent(senderId), formatMailruInventory(result));
  } catch (error) {
    state.lastMailError = errText(error).slice(0, 500);
    await sendText("user_id=" + encodeURIComponent(senderId), "Не получилось проверить Mail.ru: " + errText(error).slice(0, 900));
  } finally {
    mailInventoryRunning = false;
  }
}

async function handleMailruCommand(senderId, text) {
  const normalized = normalizeText(text).toLowerCase();
  if (/^(?:почта\s+статус|mail\s+status)$/i.test(normalized)) {
    await sendText(
      "user_id=" + encodeURIComponent(senderId),
      MAILRU_LOGIN && MAILRU_APP_PASSWORD
        ? "Mail.ru подключена. Для инвентаризации напиши: Почта проверить"
        : "Mail.ru пока не подключена к контейнеру."
    );
    return true;
  }
  if (/^(?:почта\s+проверить|проверить\s+почту|инвентаризация\s+почты|почта\s+инвентаризация)$/i.test(normalized)) {
    void runMailruInventoryForUser(senderId);
    return true;
  }
  return false;
}
`;

if (!code.includes("async function scanMailruInventory()")) {
  code = code.replace(privateAnchor, helpers + "\n" + privateAnchor);
}

const flowAnchor = '  if (await handlePrivateImportCommand(senderId, text)) return;';
if (!code.includes('if (await handleMailruCommand(senderId, text)) return;')) {
  mustReplace(
    flowAnchor,
    flowAnchor + '\n  if (await handleMailruCommand(senderId, text)) return;',
    "private mail command"
  );
}

code = code.replace(/version:\s*"v[^"]+"\s*,?/, 'version: "v77-mailru-inventory",');
if (code.includes("forwardSourceChatRegister: true,") && !code.includes("mailruInventory: true,")) {
  code = code.replace("forwardSourceChatRegister: true,", "forwardSourceChatRegister: true,\n  mailruInventory: true,");
}

fs.writeFileSync(path, code);
console.log("v77 Mail.ru read-only inventory enabled");
