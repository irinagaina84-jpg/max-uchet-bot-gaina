import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

if (!code.includes('import { simpleParser } from "mailparser";')) {
  const anchor = 'import { ImapFlow } from "imapflow";';
  if (!code.includes(anchor)) throw new Error("v78 ImapFlow import anchor not found");
  code = code.replace(anchor, anchor + '\nimport { simpleParser } from "mailparser";');
}

const privateAnchor = 'async function handlePrivate(message) {';
if (!code.includes(privateAnchor)) throw new Error("v78 private handler anchor not found");

const helpers = String.raw`
const mailIndexCache = new Map();
const mailIndexRunning = new Set();

function parseMailMonth(value) {
  const match = String(value || "").trim().match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return {
    key: match[1] + "-" + match[2],
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
}

function mailAddressList(value) {
  const list = Array.isArray(value) ? value : [];
  return list.map((item) => {
    const name = String(item?.name || "").trim();
    const address = String(item?.address || "").trim();
    return name && address ? name + " <" + address + ">" : (address || name);
  }).filter(Boolean).join("; ");
}

function mailAttachmentList(structure) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const dp = node.dispositionParameters || {};
    const p = node.parameters || {};
    const name = String(dp.filename || p.name || "").trim();
    const disposition = String(node.disposition || "").toLowerCase();
    if (name || disposition === "attachment") {
      out.push({
        name: name || "без имени",
        size: Math.max(0, Number(node.size || 0)),
        type: [node.type, node.subtype].filter(Boolean).join("/").toLowerCase(),
      });
    }
    for (const child of Array.isArray(node.childNodes) ? node.childNodes : []) walk(child);
  };
  walk(structure);
  return out;
}

function mailThreadKey(subject, inReplyTo, messageId) {
  const reply = String(inReplyTo || "").trim().toLowerCase();
  if (reply) return "reply:" + reply;
  const normalized = String(subject || "")
    .toLowerCase()
    .replace(/^\s*((re|fw|fwd|ответ|пересылка)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? "subject:" + normalized : "message:" + String(messageId || "").toLowerCase();
}

function mailCsvCell(value) {
  return '"' + String(value ?? "").replace(/"/g, '""') + '"';
}

function mailRowsCsv(rows) {
  const headers = ["date","folder","from","to","subject","message_id","in_reply_to","thread_key","text_preview","attachments"];
  const lines = [headers.map(mailCsvCell).join(",")];
  for (const row of rows) {
    lines.push([
      row.date, row.folder, row.from, row.to, row.subject, row.messageId,
      row.inReplyTo, row.threadKey, row.text,
      row.attachments.map((a) => a.name + " (" + a.size + " bytes)").join("; "),
    ].map(mailCsvCell).join(","));
  }
  return "\uFEFF" + lines.join("\n");
}

async function buildMailruIndex(monthKey) {
  const win = parseMailMonth(monthKey);
  if (!win) throw new Error("месяц должен быть в формате ГГГГ-ММ, например 2026-08");
  if (!MAILRU_LOGIN || !MAILRU_APP_PASSWORD) throw new Error("Mail.ru не подключена");

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

  const rows = [];
  const seen = new Set();
  const folderErrors = [];
  await client.connect();
  try {
    const boxes = (await client.list()).filter(mailFolderAllowed);
    for (const box of boxes) {
      try {
        await client.mailboxOpen(box.path, { readOnly: true });
        const uids = await client.search({ since: win.start, before: win.end }, { uid: true });
        for (let offset = 0; offset < uids.length; offset += 100) {
          const uidSet = uids.slice(offset, offset + 100).join(",");
          if (!uidSet) continue;
          for await (const message of client.fetch(
            uidSet,
            {
              uid: true,
              envelope: true,
              internalDate: true,
              size: true,
              bodyStructure: true,
              source: { start: 0, maxLength: 98304 },
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
                text = String(parsed.html).replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
              }
            } catch {}
            if (text.length > 12000) text = text.slice(0, 12000) + "\n[текст обрезан для индекса]";

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
      } catch (error) {
        folderErrors.push(String(box.path) + ": " + errText(error).slice(0, 300));
      }
    }
  } finally {
    try { await client.logout(); } catch {}
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  const attachmentCount = rows.reduce((sum, row) => sum + row.attachments.length, 0);
  const payload = {
    version: "mailru-index-v1",
    month: win.key,
    builtAt: new Date().toISOString(),
    messages: rows.length,
    attachments: attachmentCount,
    note: "Индекс содержит заголовки, текстовый preview и метаданные вложений. Сами вложения не скачаны.",
    folderErrors,
    rows,
  };
  const json = JSON.stringify(payload, null, 2);
  const csv = mailRowsCsv(rows);
  mailIndexCache.set(win.key, { payload, json, csv, builtAt: Date.now() });
  while (mailIndexCache.size > 3) mailIndexCache.delete(mailIndexCache.keys().next().value);
  return payload;
}

function handleMailIndexHttp(url, res) {
  const month = String(url.searchParams.get("month") || "");
  const item = mailIndexCache.get(month);
  if (!item) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: "index_not_built", month }));
    return;
  }
  const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
  const body = format === "csv" ? item.csv : item.json;
  const ext = format === "csv" ? "csv" : "json";
  const type = format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Disposition": 'attachment; filename="mailru-index-' + month + '.' + ext + '"',
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function runMailruIndexForUser(senderId, month) {
  const win = parseMailMonth(month);
  if (!win) {
    await sendText("user_id=" + encodeURIComponent(senderId), "Укажи месяц так: Почта индекс 2026-08");
    return;
  }
  if (mailIndexRunning.has(win.key)) {
    await sendText("user_id=" + encodeURIComponent(senderId), "Индекс " + win.key + " уже строится. Дождись ссылки.");
    return;
  }
  mailIndexRunning.add(win.key);
  try {
    await sendText("user_id=" + encodeURIComponent(senderId), "Строю индекс Mail.ru за " + win.key + ". Читаю темы, текст писем и названия вложений. Сами файлы не скачиваю.");
    const result = await buildMailruIndex(win.key);
    const exportKey = createHash("sha256").update(MAX_BOT_TOKEN).digest("hex").slice(0, 32);
    const exportOrigin = WEBHOOK_URL ? new URL(WEBHOOK_URL).origin : "https://max-uchet-bot-gaina.irina-gaina-84-036.workers.dev";
    const base = exportOrigin + "/mail/index?t=" + encodeURIComponent(exportKey) + "&month=" + encodeURIComponent(win.key);
    await sendText(
      "user_id=" + encodeURIComponent(senderId),
      "Индекс " + win.key + " готов.\nПисем: " + result.messages + "\nВложений: " + result.attachments +
      "\n\nJSON для анализа:\n" + base + "&format=json" +
      "\n\nCSV для реестра:\n" + base + "&format=csv"
    );
  } catch (error) {
    await sendText("user_id=" + encodeURIComponent(senderId), "Не получилось построить индекс Mail.ru: " + errText(error).slice(0, 900));
  } finally {
    mailIndexRunning.delete(win.key);
  }
}
`;

if (!code.includes("async function buildMailruIndex(monthKey)")) {
  code = code.replace(privateAnchor, helpers + "\n" + privateAnchor);
}

const mailHandlerAnchor = '  const normalized = normalizeText(text).toLowerCase();';
if (!code.includes('Почта индекс 2026-08')) {
  const replacement = mailHandlerAnchor + String.raw`
  const indexMatch = normalized.match(/^(?:почта\s+индекс|индекс\s+почты)\s+(20\d{2}-(?:0[1-9]|1[0-2]))$/i);
  if (indexMatch) {
    void runMailruIndexForUser(senderId, indexMatch[1]);
    return true;
  }`;
  const handlerStart = code.indexOf('async function handleMailruCommand(senderId, text) {');
  if (handlerStart < 0) throw new Error("v78 mail handler not found");
  const anchorPos = code.indexOf(mailHandlerAnchor, handlerStart);
  if (anchorPos < 0) throw new Error("v78 mail handler normalized anchor not found");
  code = code.slice(0, anchorPos) + replacement + code.slice(anchorPos + mailHandlerAnchor.length);
}

const serverAnchor = '  const mediaUrl = new URL(req.url || "/", "http://container");';
if (!code.includes('mediaUrl.pathname === "/mail/index"')) {
  if (!code.includes(serverAnchor)) throw new Error("v78 HTTP mediaUrl anchor not found");
  code = code.replace(serverAnchor, serverAnchor + String.raw`
  if (req.method === "GET" && mediaUrl.pathname === "/mail/index") {
    handleMailIndexHttp(mediaUrl, res);
    return;
  }`);
}

if (code.includes("mailruInventory: true,") && !code.includes("mailruIndex: true,")) {
  code = code.replace("mailruInventory: true,", "mailruInventory: true,\n  mailruIndex: true,");
}

fs.writeFileSync(path, code);
console.log("v78 Mail.ru monthly index enabled");
