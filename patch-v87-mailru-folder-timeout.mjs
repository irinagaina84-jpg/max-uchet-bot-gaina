import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

const start = code.indexOf('async function buildMailruIndex(monthKey) {');
const end = code.indexOf('\n\nfunction mailYearMonths', start) >= 0
  ? code.indexOf('\n\nfunction mailYearMonths', start)
  : code.indexOf('\n\nconst mailIndexJobState', start);
if (start < 0 || end < 0) throw new Error('v87 buildMailruIndex anchors not found');

const replacement = String.raw`const mailIndexFolderProgress = new Map();

async function buildMailruIndex(monthKey) {
  const win = parseMailMonth(monthKey);
  if (!win) throw new Error("месяц должен быть в формате ГГГГ-ММ, например 2026-08");
  if (!MAILRU_LOGIN || !MAILRU_APP_PASSWORD) throw new Error("Mail.ru не подключена");

  const rows = [];
  const seen = new Set();
  const folderErrors = [];
  let boxes = [];

  const discovery = new ImapFlow({
    host: "imap.mail.ru",
    port: 993,
    secure: true,
    auth: { user: MAILRU_LOGIN, pass: MAILRU_APP_PASSWORD },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });

  try {
    await discovery.connect();
    boxes = (await discovery.list()).filter(mailFolderAllowed);
  } finally {
    try { await discovery.logout(); } catch {}
  }

  const progress = { month: win.key, totalFolders: boxes.length, doneFolders: 0, currentFolder: "", startedAt: Date.now() };
  mailIndexFolderProgress.set(win.key, progress);

  const scanFolder = async (box) => {
    const client = new ImapFlow({
      host: "imap.mail.ru",
      port: 993,
      secure: true,
      auth: { user: MAILRU_LOGIN, pass: MAILRU_APP_PASSWORD },
      logger: false,
      connectionTimeout: 12000,
      greetingTimeout: 12000,
      socketTimeout: 25000,
    });
    let timer = null;
    try {
      progress.currentFolder = String(box.path);
      mailIndexFolderProgress.set(win.key, { ...progress });
      await client.connect();
      await client.mailboxOpen(box.path, { readOnly: true });
      const uids = await client.search({ since: win.start, before: win.end }, { uid: true });
      if (!uids.length) return;

      const work = (async () => {
        for (let offset = 0; offset < uids.length; offset += 75) {
          const uidSet = uids.slice(offset, offset + 75).join(",");
          if (!uidSet) continue;
          for await (const message of client.fetch(
            uidSet,
            {
              uid: true,
              envelope: true,
              internalDate: true,
              size: true,
              bodyStructure: true,
              source: { start: 0, maxLength: 65536 },
            },
            { uid: true }
          )) {
            const env = message?.envelope || {};
            const messageId = String(env.messageId || "").trim();
            const dedupe = messageId.toLowerCase() || (String(box.path) + ":" + String(message?.uid || ""));
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);

            let text = "";
            try {
              const parsed = await simpleParser(Buffer.from(message?.source || ""), {
                skipTextToHtml: true,
                skipHtmlToText: false,
              });
              text = String(parsed?.text || "").replace(/\u0000/g, "").trim();
              if (!text && parsed?.html) {
                text = String(parsed.html)
                  .replace(/<style[\s\S]*?<\/style>/gi, " ")
                  .replace(/<script[\s\S]*?<\/script>/gi, " ")
                  .replace(/<[^>]+>/g, " ")
                  .replace(/&nbsp;/gi, " ")
                  .replace(/&amp;/gi, "&")
                  .replace(/\s+/g, " ")
                  .trim();
              }
            } catch {}
            if (text.length > 10000) text = text.slice(0, 10000) + "\n[текст обрезан для индекса]";

            const attachments = mailAttachmentList(message?.bodyStructure);
            const date = message?.internalDate || env.date || win.start;
            const inReplyTo = String(env.inReplyTo || "").trim();
            const subject = String(env.subject || "").trim();
            rows.push({
              date: new Date(date).toISOString(),
              folder: String(box.path),
              uid: Number(message?.uid || 0),
              from: mailAddressList(env.from),
              to: mailAddressList(env.to),
              cc: mailAddressList(env.cc),
              subject,
              messageId,
              inReplyTo,
              threadKey: mailThreadKey(subject, inReplyTo, messageId),
              messageSize: Math.max(0, Number(message?.size || 0)),
              text,
              attachments,
            });
          }
        }
      })();

      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { client.close(); } catch {}
          reject(new Error("таймаут папки 40 секунд"));
        }, 40000);
      });
      await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      try { await client.logout(); } catch {}
    }
  };

  for (const box of boxes) {
    try {
      await scanFolder(box);
    } catch (error) {
      folderErrors.push(String(box.path) + ": " + errText(error).slice(0, 300));
    } finally {
      progress.doneFolders += 1;
      progress.currentFolder = "";
      mailIndexFolderProgress.set(win.key, { ...progress });
    }
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  const attachmentCount = rows.reduce((sum, row) => sum + row.attachments.length, 0);
  const payload = {
    version: "mailru-index-v3-folder-timeout",
    month: win.key,
    builtAt: new Date().toISOString(),
    messages: rows.length,
    attachments: attachmentCount,
    note: "Индекс содержит заголовки, текстовый preview и метаданные вложений. Сами вложения не скачаны. Зависшая IMAP-папка пропускается по таймауту и попадает в folderErrors.",
    folderErrors,
    rows,
  };
  const json = JSON.stringify(payload, null, 2);
  const csv = mailRowsCsv(rows);
  mailIndexCache.set(win.key, { payload, json, csv, builtAt: Date.now() });
  while (mailIndexCache.size > 24) mailIndexCache.delete(mailIndexCache.keys().next().value);
  mailIndexFolderProgress.delete(win.key);
  return payload;
}`;

code = code.slice(0, start) + replacement + code.slice(end);

if (code.includes("mailIndexQueue: true,") && !code.includes("mailFolderTimeout: true,")) {
  code = code.replace("mailIndexQueue: true,", "mailIndexQueue: true,\n  mailFolderTimeout: true,");
}
code = code.replace('version: "v86-mailru-month-queue"', 'version: "v87-mailru-folder-timeout"');

fs.writeFileSync(path, code);
console.log("v87 Mail.ru per-folder timeout enabled");
