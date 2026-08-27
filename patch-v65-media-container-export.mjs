import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

const serverPattern = /http\.createServer\(\(_req, res\) => \{[\s\S]*?\}\)\.listen\(PORT, "0\.0\.0\.0"\);/;
if (!serverPattern.test(code)) throw new Error("v65 http server anchor not found");

const server = String.raw`http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://container");
    if (url.pathname === "/export/media") {
      await handleMediaExportHttp(url, res);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, service: "MAX учет бот", ...state }, null, 2));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("container export error: " + errText(e));
  }
}).listen(PORT, "0.0.0.0");`;
code = code.replace(serverPattern, server);

const marker = "function requestJson(urlString, { method = \"GET\", headers = {}, body = null, timeout = 60000 } = {}) {";
if (!code.includes(marker)) throw new Error("v65 requestJson anchor not found");

const helpers = String.raw`
function mediaMessageTime(m) { return Number(m?.timestamp || m?.body?.timestamp || 0); }
function mediaMessageId(m) { return String(m?.body?.mid || m?.mid || m?.id || ""); }
function mediaSenderName(m) {
  const s = m?.sender || {};
  return [s.first_name, s.last_name].filter(Boolean).join(" ") || s.username || String(s.user_id || "не указан");
}
function mediaLocalStamp(ms) {
  const d = new Date(Number(ms || Date.now()) + TZ_OFFSET_MINUTES * 60000);
  const p = (v) => String(v).padStart(2, "0");
  return p(d.getUTCDate()) + "." + p(d.getUTCMonth() + 1) + "." + d.getUTCFullYear() + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds());
}
function mediaFileStamp(ms) {
  const d = new Date(Number(ms || Date.now()) + TZ_OFFSET_MINUTES * 60000);
  const p = (v) => String(v).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + "_" + p(d.getUTCHours()) + "-" + p(d.getUTCMinutes()) + "-" + p(d.getUTCSeconds());
}
async function mediaFetchAllHistory(since = 0) {
  const chatId = String(SEEDED_CHAT_IDS[0] || "-77828005225953");
  const out = [];
  let before = Date.now();
  for (let page = 0; page < 50 && out.length < 5000; page++) {
    const q = new URLSearchParams({ chat_id: chatId, count: "100", from: String(before) });
    const data = await maxRequest("/messages?" + q.toString(), { timeout: 60000 });
    const items = data?.messages || data?.items || [];
    if (!items.length) break;
    out.push(...items);
    const times = items.map(mediaMessageTime).filter(Boolean);
    const oldest = times.length ? Math.min(...times) : 0;
    if (!oldest || items.length < 100 || (since && oldest <= since)) break;
    before = oldest - 1;
  }
  const byId = new Map();
  for (const m of out) byId.set(mediaMessageId(m) || String(mediaMessageTime(m)) + ":" + byId.size, m);
  return [...byId.values()].filter((m) => !since || mediaMessageTime(m) >= since).sort((a, b) => mediaMessageTime(a) - mediaMessageTime(b));
}
function mediaHistoryText(rows, mode, since) {
  const chatId = String(SEEDED_CHAT_IDS[0] || "-77828005225953");
  const lines = [
    "MAX — экспорт рабочей переписки с медиа",
    "chat_id: " + chatId,
    "Режим: " + (mode === "new" ? "новые сообщения" : "вся история"),
    "Сформировано: " + mediaLocalStamp(Date.now()),
    ...(since ? ["Начиная с: " + mediaLocalStamp(since)] : []),
    "Сообщений: " + rows.length,
    "Картинок в сообщениях: " + rows.reduce((n, m) => n + imageUrls(m).length, 0),
    ""
  ];
  for (const m of rows) {
    lines.push("============================================================");
    lines.push("Дата: " + mediaLocalStamp(mediaMessageTime(m) || Date.now()));
    lines.push("Автор: " + mediaSenderName(m));
    lines.push("message_id: " + (mediaMessageId(m) || "не указан"));
    const reply = m?.body?.reply_to || m?.body?.reply || m?.reply_to || null;
    if (reply) lines.push("Ответ на: " + String(reply?.body?.text || reply?.text || "").replace(/\s+/g, " ").trim());
    lines.push("Текст:");
    lines.push(String(m?.body?.text || m?.text || "").trim() || "[без текста]");
    const imgs = imageUrls(m);
    if (imgs.length) lines.push("Картинки: " + imgs.length);
    lines.push("");
  }
  return lines.join("\n");
}
const MEDIA_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function mediaCrc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = MEDIA_CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function mediaLe16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b; }
function mediaLe32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; }
function mediaZip(entries) {
  const body = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = mediaCrc32(data);
    const local = Buffer.concat([
      mediaLe32(0x04034b50), mediaLe16(20), mediaLe16(0x0800), mediaLe16(0), mediaLe16(0), mediaLe16(0),
      mediaLe32(crc), mediaLe32(data.length), mediaLe32(data.length), mediaLe16(name.length), mediaLe16(0), name
    ]);
    body.push(local, data);
    central.push(Buffer.concat([
      mediaLe32(0x02014b50), mediaLe16(20), mediaLe16(20), mediaLe16(0x0800), mediaLe16(0), mediaLe16(0), mediaLe16(0),
      mediaLe32(crc), mediaLe32(data.length), mediaLe32(data.length), mediaLe16(name.length), mediaLe16(0), mediaLe16(0),
      mediaLe16(0), mediaLe16(0), mediaLe32(0), mediaLe32(offset), name
    ]));
    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.concat([
    mediaLe32(0x06054b50), mediaLe16(0), mediaLe16(0), mediaLe16(entries.length), mediaLe16(entries.length),
    mediaLe32(centralBuf.length), mediaLe32(offset), mediaLe16(0)
  ]);
  return Buffer.concat([...body, centralBuf, end]);
}
function mediaSafePart(value, fallback = "item") {
  const s = String(value || "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  return s || fallback;
}
function mediaExt(contentType, url) {
  const t = String(contentType || "").toLowerCase();
  if (t.includes("png")) return "png";
  if (t.includes("webp")) return "webp";
  if (t.includes("gif")) return "gif";
  if (t.includes("avif")) return "avif";
  if (t.includes("heic") || t.includes("heif")) return "heic";
  const m = String(url || "").match(/\.(jpg|jpeg|png|webp|gif|avif|heic|heif)(?:[?#]|$)/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg").replace("heif", "heic") : "jpg";
}
function mediaCsvCell(v) { return '"' + String(v ?? "").replace(/"/g, '""') + '"'; }
async function handleMediaExportHttp(url, res) {
  const mode = url.searchParams.get("mode") === "new" ? "new" : "all";
  const since = mode === "new" ? Math.max(0, Number(url.searchParams.get("since") || 0)) : 0;
  const rows = await mediaFetchAllHistory(since);
  const entries = [{ name: "history.txt", data: Buffer.from(mediaHistoryText(rows, mode, since), "utf8") }];
  const manifest = [["date","author","message_id","image_index","file","status","content_type","bytes","source_url","error"]];
  const errors = [];
  let found = 0;
  let saved = 0;
  for (const m of rows) {
    const urls = imageUrls(m);
    found += urls.length;
    for (let i = 0; i < urls.length; i++) {
      const src = urls[i];
      let filename = "";
      try {
        const got = await download(src);
        const mid = mediaSafePart(mediaMessageId(m), "msg_" + String(mediaMessageTime(m) || 0));
        const folder = mediaFileStamp(mediaMessageTime(m) || Date.now()).slice(0, 10);
        filename = "media/" + folder + "/" + mediaFileStamp(mediaMessageTime(m) || Date.now()) + "_" + mid + "_" + String(i + 1).padStart(2, "0") + "." + mediaExt(got.contentType, src);
        entries.push({ name: filename, data: got.buffer });
        saved++;
        manifest.push([mediaLocalStamp(mediaMessageTime(m)), mediaSenderName(m), mediaMessageId(m), i + 1, filename, "ok", got.contentType, got.buffer.length, src, ""]);
      } catch (e) {
        const msg = errText(e);
        errors.push(mediaLocalStamp(mediaMessageTime(m)) + " | message_id=" + mediaMessageId(m) + " | image=" + (i + 1) + " | " + msg + " | " + src);
        manifest.push([mediaLocalStamp(mediaMessageTime(m)), mediaSenderName(m), mediaMessageId(m), i + 1, filename, "error", "", "", src, msg]);
      }
    }
  }
  const manifestText = "\ufeff" + manifest.map((row) => row.map(mediaCsvCell).join(",")).join("\r\n");
  entries.push({ name: "manifest.csv", data: Buffer.from(manifestText, "utf8") });
  entries.push({ name: "README.txt", data: Buffer.from([
    "MAX — архив истории с изображениями",
    "Сообщений: " + rows.length,
    "Картинок найдено: " + found,
    "Картинок скачано: " + saved,
    "Ошибок скачивания: " + errors.length,
    "",
    "Картинки связаны с исходными сообщениями через message_id в manifest.csv."
  ].join("\n"), "utf8") });
  if (errors.length) entries.push({ name: "errors.txt", data: Buffer.from(errors.join("\n"), "utf8") });
  const zip = mediaZip(entries);
  const filename = (mode === "new" ? "max_new_media_" : "max_history_media_") + mediaFileStamp(Date.now()) + ".zip";
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": 'attachment; filename="' + filename + '"',
    "Cache-Control": "no-store, private",
    "Content-Length": String(zip.length),
    "X-MAX-Messages": String(rows.length),
    "X-MAX-Images": String(found),
    "X-MAX-Images-Saved": String(saved)
  });
  res.end(zip);
}

`;

code = code.replace(marker, helpers + marker);
code = code.replace(/version:\s*"v[^"]+"\s*,?/, 'version: "v65-media-container-export",');
fs.writeFileSync(path, code);
console.log("v65 media export moved into MAX container");
