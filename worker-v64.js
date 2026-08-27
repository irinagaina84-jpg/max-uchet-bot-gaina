import { getContainer } from "@cloudflare/containers";
import v63Worker, { MaxBotContainer } from "./worker-v57.js";

const CONTAINER_INSTANCE = "production";
const WORKER_VERSION = "worker-v64-media-export";
const CURRENT_CHAT_ID = "-77828005225953";
const MAX_API = "https://platform-api2.max.ru";
const encoder = new TextEncoder();

export { MaxBotContainer };

function containerHandle(runtimeEnv) {
  return getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE);
}

async function ensureV64Image(runtimeEnv) {
  const container = containerHandle(runtimeEnv);
  try { await container.resetRuntimeOnce(WORKER_VERSION); } catch {}
  return container;
}

async function sha256Hex(value) {
  const bytes = encoder.encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function messageTime(m) { return Number(m?.timestamp || m?.body?.timestamp || 0); }
function messageId(m) { return String(m?.body?.mid || m?.mid || m?.id || ""); }
function messageText(m) { return String(m?.body?.text || m?.text || ""); }
function senderName(m) {
  const s = m?.sender || {};
  return [s.first_name, s.last_name].filter(Boolean).join(" ") || s.username || String(s.user_id || "не указан");
}
function localStamp(ms) {
  const d = new Date(Number(ms || Date.now()) + 5 * 60 * 60000);
  const p = (v) => String(v).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
function localFileStamp(ms) {
  const d = new Date(Number(ms || Date.now()) + 5 * 60 * 60000);
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}`;
}

async function maxJson(runtimeEnv, path) {
  const r = await fetch(MAX_API + path, { headers: { Authorization: runtimeEnv.MAX_BOT_TOKEN, Accept: "application/json" } });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`MAX ${r.status}: ${data?.message || data?.error || text.slice(0, 300)}`);
  return data;
}

async function fetchAllHistory(runtimeEnv, since = 0) {
  const out = [];
  let before = Date.now();
  for (let page = 0; page < 50 && out.length < 5000; page++) {
    const q = new URLSearchParams({ chat_id: CURRENT_CHAT_ID, count: "100", from: String(before) });
    if (since) q.set("to", String(since));
    const data = await maxJson(runtimeEnv, `/messages?${q.toString()}`);
    const items = data?.messages || data?.items || [];
    if (!items.length) break;
    out.push(...items);
    const times = items.map(messageTime).filter(Boolean);
    const oldest = times.length ? Math.min(...times) : 0;
    if (!oldest || items.length < 100 || (since && oldest <= since)) break;
    before = oldest - 1;
  }
  const byId = new Map();
  for (const m of out) byId.set(messageId(m) || `${messageTime(m)}:${byId.size}`, m);
  return [...byId.values()].filter((m) => !since || messageTime(m) >= since).sort((a, b) => messageTime(a) - messageTime(b));
}

function messageAttachments(m) {
  return Array.isArray(m?.body?.attachments) ? m.body.attachments : Array.isArray(m?.attachments) ? m.attachments : [];
}

function imageEntries(m) {
  const out = [];
  const list = messageAttachments(m);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const type = String(a?.type || a?.payload?.type || "").toLowerCase();
    if (!["image", "photo"].includes(type)) continue;
    const p = a?.payload || a;
    const candidates = [p?.url, p?.photo?.url, p?.photo?.full_url, p?.photos?.large?.url, p?.photos?.medium?.url, p?.photos?.small?.url, p?.token?.url];
    const url = candidates.find((v) => typeof v === "string" && /^https?:\/\//i.test(v));
    out.push({ attachmentIndex: i + 1, type, url: url || "" });
  }
  return out;
}

function historyText(rows, mode, since) {
  const lines = [
    "MAX — экспорт рабочей переписки с медиа",
    `chat_id: ${CURRENT_CHAT_ID}`,
    `Режим: ${mode === "new" ? "новые сообщения" : "вся история"}`,
    `Сформировано: ${localStamp(Date.now())}`,
    ...(since ? [`Начиная с: ${localStamp(since)}`] : []),
    `Сообщений: ${rows.length}`,
    `Картинок в сообщениях: ${rows.reduce((n, m) => n + imageEntries(m).length, 0)}`,
    ""
  ];
  for (const m of rows) {
    lines.push("============================================================");
    lines.push(`Дата: ${localStamp(messageTime(m) || Date.now())}`);
    lines.push(`Автор: ${senderName(m)}`);
    lines.push(`message_id: ${messageId(m) || "не указан"}`);
    const reply = m?.body?.reply_to || m?.body?.reply || m?.reply_to || null;
    if (reply) lines.push(`Ответ на: ${String(reply?.body?.text || reply?.text || "").replace(/\s+/g, " ").trim()}`);
    lines.push("Текст:");
    lines.push(messageText(m).trim() || "[без текста]");
    const imgs = imageEntries(m);
    if (imgs.length) lines.push(`Картинки: ${imgs.length}`);
    const other = messageAttachments(m).filter((a) => !["image", "photo"].includes(String(a?.type || a?.payload?.type || "").toLowerCase()));
    if (other.length) lines.push(`Другие вложения: ${other.map((a) => a?.type || "attachment").join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function le16(value) { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, value & 0xffff, true); return a; }
function le32(value) { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, value >>> 0, true); return a; }
function joinBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
function zipLocalHeader(nameBytes) {
  return joinBytes([le32(0x04034b50), le16(20), le16(0x0808), le16(0), le16(0), le16(0), le32(0), le32(0), le32(0), le16(nameBytes.length), le16(0), nameBytes]);
}
function zipDescriptor(crc, size) { return joinBytes([le32(0x08074b50), le32(crc), le32(size), le32(size)]); }
function zipCentralHeader(nameBytes, crc, size, offset) {
  return joinBytes([le32(0x02014b50), le16(20), le16(20), le16(0x0808), le16(0), le16(0), le16(0), le32(crc), le32(size), le32(size), le16(nameBytes.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(offset), nameBytes]);
}
function zipEnd(count, centralSize, centralOffset) {
  return joinBytes([le32(0x06054b50), le16(0), le16(0), le16(count), le16(count), le32(centralSize), le32(centralOffset), le16(0)]);
}
function safePart(value, fallback = "item") {
  const s = String(value || "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 90);
  return s || fallback;
}
function imageExtension(contentType, url) {
  const t = String(contentType || "").toLowerCase();
  if (t.includes("png")) return "png";
  if (t.includes("webp")) return "webp";
  if (t.includes("gif")) return "gif";
  if (t.includes("avif")) return "avif";
  if (t.includes("heic") || t.includes("heif")) return "heic";
  if (t.includes("jpeg") || t.includes("jpg")) return "jpg";
  const m = String(url || "").match(/\.(jpg|jpeg|png|webp|gif|avif|heic|heif)(?:[?#]|$)/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg").replace("heif", "heic") : "jpg";
}
function csvCell(value) { return `"${String(value ?? "").replace(/"/g, '""')}"`; }

async function fetchImage(runtimeEnv, url) {
  if (!url) throw new Error("у вложения нет URL");
  let response = await fetch(url, { redirect: "follow", headers: { Accept: "image/*,*/*" } });
  if (!response.ok) response = await fetch(url, { redirect: "follow", headers: { Accept: "image/*,*/*", Authorization: runtimeEnv.MAX_BOT_TOKEN } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > 25 * 1024 * 1024) throw new Error(`слишком большой файл: ${declared} bytes`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 25 * 1024 * 1024) throw new Error(`слишком большой файл: ${bytes.length} bytes`);
  return { bytes, contentType: String(response.headers.get("content-type") || "image/jpeg").split(";")[0].toLowerCase() };
}

function addZipFile(name, bytes, offset) {
  const nameBytes = encoder.encode(name);
  const crc = crc32(bytes);
  const local = zipLocalHeader(nameBytes);
  const descriptor = zipDescriptor(crc, bytes.length);
  const central = zipCentralHeader(nameBytes, crc, bytes.length, offset);
  return { local, bytes, descriptor, central, nextOffset: offset + local.length + bytes.length + descriptor.length };
}

async function* mediaZipGenerator(runtimeEnv, rows, mode, since) {
  let offset = 0;
  const central = [];
  const manifest = [["date", "author", "message_id", "attachment_index", "file", "status", "content_type", "bytes", "source_url", "error"]];
  const errors = [];
  let okImages = 0;

  const historyBytes = encoder.encode(historyText(rows, mode, since));
  let item = addZipFile("history.txt", historyBytes, offset);
  yield item.local; yield item.bytes; yield item.descriptor; central.push(item.central); offset = item.nextOffset;

  for (const m of rows) {
    const imgs = imageEntries(m);
    for (let n = 0; n < imgs.length; n++) {
      const img = imgs[n];
      const mid = safePart(messageId(m), `msg_${messageTime(m) || 0}`);
      const dateFolder = localFileStamp(messageTime(m) || Date.now()).slice(0, 10);
      let filename = "";
      try {
        const downloaded = await fetchImage(runtimeEnv, img.url);
        const ext = imageExtension(downloaded.contentType, img.url);
        filename = `media/${dateFolder}/${localFileStamp(messageTime(m) || Date.now())}_${mid}_${String(n + 1).padStart(2, "0")}.${ext}`;
        item = addZipFile(filename, downloaded.bytes, offset);
        yield item.local; yield item.bytes; yield item.descriptor; central.push(item.central); offset = item.nextOffset;
        okImages += 1;
        manifest.push([localStamp(messageTime(m)), senderName(m), messageId(m), img.attachmentIndex, filename, "ok", downloaded.contentType, downloaded.bytes.length, img.url, ""]);
      } catch (error) {
        const message = String(error?.message || error);
        errors.push(`${localStamp(messageTime(m))} | message_id=${messageId(m)} | image=${img.attachmentIndex} | ${message} | ${img.url}`);
        manifest.push([localStamp(messageTime(m)), senderName(m), messageId(m), img.attachmentIndex, filename, "error", "", "", img.url, message]);
      }
    }
  }

  const manifestText = manifest.map((row) => row.map(csvCell).join(",")).join("\r\n");
  item = addZipFile("manifest.csv", encoder.encode("\ufeff" + manifestText), offset);
  yield item.local; yield item.bytes; yield item.descriptor; central.push(item.central); offset = item.nextOffset;

  const summary = [
    "MAX — архив истории с изображениями",
    `Сообщений: ${rows.length}`,
    `Картинок найдено: ${manifest.length - 1}`,
    `Картинок скачано: ${okImages}`,
    `Ошибок скачивания: ${errors.length}`,
    "",
    "Каждая картинка связана с исходным сообщением через message_id в manifest.csv.",
    "Если в errors.txt есть строки, пришлите только эти недоступные изображения отдельно."
  ].join("\n");
  item = addZipFile("README.txt", encoder.encode(summary), offset);
  yield item.local; yield item.bytes; yield item.descriptor; central.push(item.central); offset = item.nextOffset;

  if (errors.length) {
    item = addZipFile("errors.txt", encoder.encode(errors.join("\n")), offset);
    yield item.local; yield item.bytes; yield item.descriptor; central.push(item.central); offset = item.nextOffset;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const c of central) { yield c; centralSize += c.length; }
  yield zipEnd(central.length, centralSize, centralOffset);
}

function streamFromGenerator(generator) {
  const iterator = generator[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { try { await iterator.return?.(); } catch {} }
  });
}

async function exportMedia(request, runtimeEnv) {
  const url = new URL(request.url);
  const expected = (await sha256Hex(runtimeEnv.MAX_BOT_TOKEN)).slice(0, 32);
  if (!expected || url.searchParams.get("t") !== expected) return new Response("Forbidden", { status: 403 });
  const mode = url.searchParams.get("mode") === "new" ? "new" : "all";
  const since = mode === "new" ? Math.max(0, Number(url.searchParams.get("since") || 0)) : 0;
  const rows = await fetchAllHistory(runtimeEnv, since);
  const imageCount = rows.reduce((n, m) => n + imageEntries(m).length, 0);
  const filename = `${mode === "new" ? "max_new_media" : "max_history_media"}_${localFileStamp(Date.now())}.zip`;
  const stream = streamFromGenerator(mediaZipGenerator(runtimeEnv, rows, mode, since));
  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, private",
      "X-MAX-Messages": String(rows.length),
      "X-MAX-Images": String(imageCount)
    }
  });
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/export/media") {
      try { return await exportMedia(request, runtimeEnv); }
      catch (error) { return new Response(`Media export error: ${error?.message || error}`, { status: 500 }); }
    }
    await ensureV64Image(runtimeEnv);
    return v63Worker.fetch(request, runtimeEnv, ctx);
  },

  async scheduled(controller, runtimeEnv, ctx) {
    ctx.waitUntil(ensureV64Image(runtimeEnv).catch((error) => console.error("v64 image refresh error", error)));
    return v63Worker.scheduled(controller, runtimeEnv, ctx);
  },
};
