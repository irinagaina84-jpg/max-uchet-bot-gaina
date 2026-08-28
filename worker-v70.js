import { getContainer } from "@cloudflare/containers";
import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v67.js";

const CONTAINER_INSTANCE = "production";
const CURRENT_CHAT_ID = "-77828005225953";
const WORKER_VERSION = "worker-v70-durable-storage-export";
const TZ_OFFSET_MINUTES = 300;
const encoder = new TextEncoder();
const MAX_RECORDS = 5000;
const MAX_FILE_BYTES = 30 * 1024 * 1024;

function padTime(value) {
  return String(Math.max(0, Number(value || 0))).padStart(13, "0");
}

export class MaxBotContainer extends BaseMaxBotContainer {
  async rawRangePage(chatId, from = 0, to = 0, startAfter = "", limit = 200) {
    await this.ensureRegistryVersion();
    const id = String(chatId || CURRENT_CHAT_ID);
    const prefix = `ledger:raw:${id}:`;
    const hardLimit = Math.max(1, Math.min(250, Number(limit || 200)));
    const options = {
      prefix,
      end: Number(to || 0) > 0 ? `${prefix}${padTime(to)}` : `${prefix}\uffff`,
      limit: hardLimit,
    };
    if (startAfter) options.startAfter = String(startAfter);
    else options.start = Number(from || 0) > 0 ? `${prefix}${padTime(from)}` : prefix;

    const page = await this.ctx.storage.list(options);
    const records = [];
    let next = "";
    for (const [key, value] of page.entries()) {
      next = key;
      const body = value?.body || {};
      records.push({
        chat_id: String(value?.chat_id || id),
        mid: String(value?.mid || ""),
        timestamp: Number(value?.timestamp || 0),
        update_type: String(value?.update_type || ""),
        removed: Boolean(value?.removed),
        sender: value?.sender || null,
        recipient: value?.recipient || null,
        text: String(value?.text || body?.text || ""),
        reply: body?.reply_to || body?.reply || null,
        attachments: Array.isArray(value?.attachments)
          ? value.attachments
          : Array.isArray(body?.attachments)
            ? body.attachments
            : [],
        saved_at: Number(value?.saved_at || 0),
      });
    }
    return {
      ok: true,
      records,
      next: page.size === hardLimit ? next : "",
    };
  }
}

function containerHandle(runtimeEnv) {
  return getContainer(runtimeEnv.MAX_BOT_CONTAINER, CONTAINER_INSTANCE);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value || "")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function localDate(ms) {
  const date = new Date(Number(ms || Date.now()) + TZ_OFFSET_MINUTES * 60000);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function localStamp(ms) {
  const date = new Date(Number(ms || Date.now()) + TZ_OFFSET_MINUTES * 60000);
  return `${pad2(date.getUTCDate())}.${pad2(date.getUTCMonth() + 1)}.${date.getUTCFullYear()} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

function senderName(record) {
  const sender = record?.sender || {};
  return [sender.first_name, sender.last_name].filter(Boolean).join(" ")
    || sender.username
    || String(sender.user_id || "не указан");
}

function replyText(record) {
  const reply = record?.reply || null;
  return String(reply?.body?.text || reply?.text || "").replace(/\s+/g, " ").trim();
}

async function loadRawRecords(runtimeEnv, from, to, requestedLimit) {
  const stub = containerHandle(runtimeEnv);
  const hardLimit = Math.max(1, Math.min(MAX_RECORDS, Number(requestedLimit || MAX_RECORDS)));
  const records = [];
  let cursor = "";
  for (let page = 0; page < 30 && records.length < hardLimit; page += 1) {
    const size = Math.min(200, hardLimit - records.length);
    const result = await stub.rawRangePage(CURRENT_CHAT_ID, from, to, cursor, size);
    const items = Array.isArray(result?.records) ? result.records : [];
    records.push(...items);
    if (!result?.next || !items.length) break;
    cursor = String(result.next);
  }
  const byMid = new Map();
  for (const record of records) {
    const key = String(record?.mid || `${record?.timestamp || 0}:${byMid.size}`);
    const previous = byMid.get(key);
    if (!previous || Number(record?.saved_at || 0) >= Number(previous?.saved_at || 0)) byMid.set(key, record);
  }
  return [...byMid.values()]
    .filter((record) => {
      const timestamp = Number(record?.timestamp || 0);
      if (from > 0 && timestamp < from) return false;
      if (to > 0 && timestamp >= to) return false;
      return true;
    })
    .sort((a, b) => Number(a?.timestamp || 0) - Number(b?.timestamp || 0));
}

function safePart(value, fallback = "item") {
  const text = String(value || "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9А-Яа-яЁё._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
  return text || fallback;
}

function collectAttachmentValues(value, state, path = "root", depth = 0) {
  if (value == null || depth > 8) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectAttachmentValues(value[index], state, `${path}[${index}]`, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const normalized = String(key).toLowerCase();
    const nextPath = `${path}.${key}`;
    if (typeof item === "string") {
      if (/^https?:\/\//i.test(item)) state.urls.push({ url: item, path: nextPath });
      if (["filename", "file_name", "name", "title"].includes(normalized) && item.length <= 300) state.names.push(item);
      if (["mime", "mime_type", "content_type"].includes(normalized) && item.length <= 150) state.contentTypes.push(item);
    }
    if (normalized.includes("secret") || normalized.includes("authorization")) continue;
    collectAttachmentValues(item, state, nextPath, depth + 1);
  }
}

function urlScore(candidate, type) {
  const value = `${candidate.path} ${candidate.url}`.toLowerCase();
  let score = 0;
  if (/original|download|source|full|large|file|video|audio|document/.test(value)) score += 80;
  if (/\.(jpe?g|png|webp|gif|avif|heic|heif|mp4|mov|webm|mp3|m4a|wav|ogg|opus|pdf|docx?|xlsx?|pptx?|zip)(?:[?#]|$)/i.test(candidate.url)) score += 60;
  if (/thumb|thumbnail|preview|poster|small|medium|avatar|icon|cover/.test(value)) score -= 90;
  if ((type === "image" || type === "photo") && /jpe?g|png|webp|gif|avif|heic|heif/.test(value)) score += 50;
  if (type === "video" && /mp4|mov|webm|video/.test(value)) score += 50;
  if ((type === "audio" || type === "voice") && /mp3|m4a|wav|ogg|opus|audio/.test(value)) score += 50;
  return score;
}

function attachmentAsset(attachment, attachmentIndex) {
  const type = String(attachment?.type || attachment?.payload?.type || "attachment").toLowerCase();
  const state = { urls: [], names: [], contentTypes: [] };
  collectAttachmentValues(attachment, state);
  const unique = new Map();
  for (const candidate of state.urls) if (!unique.has(candidate.url)) unique.set(candidate.url, candidate);
  const candidates = [...unique.values()].sort((a, b) => urlScore(b, type) - urlScore(a, type));
  const best = candidates[0] || null;
  return {
    attachmentIndex,
    type,
    url: best?.url || "",
    sourceUrls: candidates.map((candidate) => candidate.url),
    originalName: state.names[0] || "",
    declaredContentType: state.contentTypes[0] || "",
    raw: attachment,
  };
}

function attachmentAssets(record) {
  const list = Array.isArray(record?.attachments) ? record.attachments : [];
  return list.map((attachment, index) => attachmentAsset(attachment, index + 1));
}

function historyText(records, from, to) {
  const attachmentCount = records.reduce((total, record) => total + attachmentAssets(record).length, 0);
  const lines = [
    "MAX — резервная выгрузка из сохранённого журнала",
    `Версия: ${WORKER_VERSION}`,
    `Чат: ${CURRENT_CHAT_ID}`,
    `Период: ${from ? localDate(from) : "начало"} — ${to ? localDate(to - 1) : "сейчас"}`,
    `Сформировано: ${localStamp(Date.now())}`,
    `Сообщений: ${records.length}`,
    `Вложений в журнале: ${attachmentCount}`,
    "",
  ];
  let currentDay = "";
  for (const record of records) {
    const day = localDate(record?.timestamp || Date.now());
    if (day !== currentDay) {
      currentDay = day;
      lines.push("############################################################");
      lines.push(`ДЕНЬ: ${day}`);
      lines.push("############################################################");
    }
    lines.push("============================================================");
    lines.push(`Дата: ${localStamp(record?.timestamp || Date.now())}`);
    lines.push(`Автор: ${senderName(record)}`);
    lines.push(`message_id: ${record?.mid || "не указан"}`);
    if (record?.removed) lines.push("Статус: сообщение удалено");
    const reply = replyText(record);
    if (reply) lines.push(`Ответ на: ${reply}`);
    lines.push("Текст:");
    lines.push(String(record?.text || "").trim() || "[без текста]");
    const assets = attachmentAssets(record);
    if (assets.length) {
      lines.push("Вложения:");
      for (const asset of assets) {
        lines.push([
          `${asset.attachmentIndex}. ${asset.type}`,
          asset.originalName ? `имя=${asset.originalName}` : "",
          asset.url ? `url=${asset.url}` : "URL недоступен",
        ].filter(Boolean).join(" | "));
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) c = CRC32_TABLE[(c ^ bytes[index]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function le16(value) {
  const result = new Uint8Array(2);
  new DataView(result.buffer).setUint16(0, value & 0xffff, true);
  return result;
}

function le32(value) {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value >>> 0, true);
  return result;
}

function joinBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function addZipFile(name, bytes, offset) {
  const nameBytes = encoder.encode(name);
  const crc = crc32(bytes);
  const local = joinBytes([
    le32(0x04034b50), le16(20), le16(0x0800), le16(0), le16(0), le16(0),
    le32(crc), le32(bytes.length), le32(bytes.length), le16(nameBytes.length), le16(0), nameBytes,
  ]);
  const central = joinBytes([
    le32(0x02014b50), le16(20), le16(20), le16(0x0800), le16(0), le16(0), le16(0),
    le32(crc), le32(bytes.length), le32(bytes.length), le16(nameBytes.length), le16(0), le16(0),
    le16(0), le16(0), le32(0), le32(offset), nameBytes,
  ]);
  return { local, bytes, central, nextOffset: offset + local.length + bytes.length };
}

function zipEnd(count, centralSize, centralOffset) {
  return joinBytes([
    le32(0x06054b50), le16(0), le16(0), le16(count), le16(count),
    le32(centralSize), le32(centralOffset), le16(0),
  ]);
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function extensionFrom(contentType, url, type) {
  const normalized = String(contentType || "").toLowerCase();
  const mimeMap = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "image/avif": "avif", "image/heic": "heic", "video/mp4": "mp4", "video/quicktime": "mov",
    "video/webm": "webm", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav",
    "audio/ogg": "ogg", "application/pdf": "pdf", "application/zip": "zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  };
  if (mimeMap[normalized]) return mimeMap[normalized];
  const match = String(url || "").match(/\.([A-Za-z0-9]{1,8})(?:[?#]|$)/);
  if (match) return match[1].toLowerCase();
  if (type === "image" || type === "photo") return "jpg";
  if (type === "video") return "mp4";
  if (type === "audio" || type === "voice") return "ogg";
  return "bin";
}

async function fetchAttachment(runtimeEnv, asset) {
  if (!asset.url) throw new Error("у вложения нет доступного URL");
  const attempts = [
    { Accept: "*/*" },
    { Accept: "*/*", Authorization: String(runtimeEnv.MAX_BOT_TOKEN || "") },
  ];
  let lastStatus = 0;
  for (const headers of attempts) {
    const response = await fetch(asset.url, { redirect: "follow", headers });
    lastStatus = response.status;
    if (!response.ok) continue;
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_FILE_BYTES) throw new Error(`файл больше ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} МБ`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`файл больше ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} МБ`);
    return {
      bytes,
      contentType: String(response.headers.get("content-type") || asset.declaredContentType || "application/octet-stream").split(";")[0].toLowerCase(),
    };
  }
  throw new Error(`HTTP ${lastStatus || "ошибка скачивания"}`);
}

async function* archiveGenerator(runtimeEnv, records, from, to) {
  let offset = 0;
  const central = [];
  const manifest = [[
    "date", "author", "message_id", "attachment_index", "type", "original_name",
    "file", "status", "content_type", "bytes", "source_url", "error",
  ]];
  const errors = [];
  let saved = 0;

  const addEntry = function* (name, bytes) {
    const entry = addZipFile(name, bytes, offset);
    yield entry.local;
    yield entry.bytes;
    central.push(entry.central);
    offset = entry.nextOffset;
  };

  yield* addEntry("history.txt", encoder.encode(historyText(records, from, to)));
  yield* addEntry("messages.json", encoder.encode(JSON.stringify(records, null, 2)));

  for (const record of records) {
    if (record?.removed) continue;
    const timestamp = Number(record?.timestamp || Date.now());
    const mid = safePart(record?.mid, `msg_${timestamp}`);
    for (const asset of attachmentAssets(record)) {
      let filename = "";
      try {
        const downloaded = await fetchAttachment(runtimeEnv, asset);
        const extension = extensionFrom(downloaded.contentType, asset.url, asset.type);
        const originalBase = asset.originalName
          ? safePart(asset.originalName.replace(/\.[A-Za-z0-9]{1,8}$/i, ""), `attachment_${asset.attachmentIndex}`)
          : `attachment_${asset.attachmentIndex}`;
        filename = `attachments/${localDate(timestamp)}/${localDate(timestamp)}_${String(timestamp)}_${mid}_${String(asset.attachmentIndex).padStart(2, "0")}_${originalBase}.${extension}`;
        yield* addEntry(filename, downloaded.bytes);
        saved += 1;
        manifest.push([
          localStamp(timestamp), senderName(record), record?.mid || "", asset.attachmentIndex,
          asset.type, asset.originalName, filename, "ok", downloaded.contentType,
          downloaded.bytes.length, asset.url, "",
        ]);
      } catch (error) {
        const message = String(error?.message || error);
        errors.push(`${localStamp(timestamp)} | message_id=${record?.mid || ""} | attachment=${asset.attachmentIndex} | ${message} | ${asset.url}`);
        manifest.push([
          localStamp(timestamp), senderName(record), record?.mid || "", asset.attachmentIndex,
          asset.type, asset.originalName, filename, "error", "", "", asset.url, message,
        ]);
      }
    }
  }

  const manifestText = "\ufeff" + manifest.map((row) => row.map(csvCell).join(",")).join("\r\n");
  yield* addEntry("manifest.csv", encoder.encode(manifestText));
  const totalAttachments = manifest.length - 1;
  const readme = [
    "MAX — резервная выгрузка без запуска контейнерного процесса",
    `Версия: ${WORKER_VERSION}`,
    `Период: ${from ? localDate(from) : "начало"} — ${to ? localDate(to - 1) : "сейчас"}`,
    `Сообщений из сохранённого журнала: ${records.length}`,
    `Вложений найдено: ${totalAttachments}`,
    `Вложений скачано: ${saved}`,
    `Ошибок скачивания: ${errors.length}`,
    "",
    "history.txt — переписка; messages.json — исходные сохранённые записи;",
    "manifest.csv — связь файлов с сообщениями; errors.txt — недоступные вложения.",
    "Архив строится из Durable Object storage и не зависит от работающего Node-контейнера.",
  ].join("\n");
  yield* addEntry("README.txt", encoder.encode(readme));
  if (errors.length) yield* addEntry("errors.txt", encoder.encode(errors.join("\n")));

  const centralOffset = offset;
  let centralSize = 0;
  for (const entry of central) {
    yield entry;
    centralSize += entry.length;
  }
  yield zipEnd(central.length, centralSize, centralOffset);
}

function streamFromGenerator(generator) {
  return new ReadableStream({
    async pull(controller) {
      try {
        const result = await generator.next();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      if (typeof generator.return === "function") await generator.return();
    },
  });
}

async function exportFromDurableStorage(request, runtimeEnv) {
  const token = String(runtimeEnv.MAX_BOT_TOKEN || "");
  if (!token) return new Response("MAX_BOT_TOKEN is not configured", { status: 503 });
  const url = new URL(request.url);
  const expected = (await sha256Hex(token)).slice(0, 32);
  if (url.searchParams.get("t") !== expected) return new Response("Forbidden", { status: 403 });

  let from = Math.max(0, Number(url.searchParams.get("from") || 0));
  const mode = url.searchParams.get("mode") === "new" ? "new" : "all";
  if (mode === "new") from = Math.max(from, Number(url.searchParams.get("since") || 0));
  const to = Math.max(0, Number(url.searchParams.get("to") || 0));
  const limit = Math.max(1, Math.min(MAX_RECORDS, Number(url.searchParams.get("limit") || MAX_RECORDS)));
  if (from > 0 && to > 0 && to <= from) return new Response("Invalid date range", { status: 400 });

  const records = await loadRawRecords(runtimeEnv, from, to, limit);
  const suffix = from || to
    ? `${from ? localDate(from) : "start"}_${to ? localDate(to - 1) : "now"}`
    : `all_${localDate(Date.now())}`;
  const filename = `max_saved_chat_${suffix}.zip`;
  return new Response(streamFromGenerator(archiveGenerator(runtimeEnv, records, from, to)), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, private",
      "X-MAX-Export-Source": "durable-storage",
      "X-MAX-Export-Version": WORKER_VERSION,
      "X-MAX-Messages": String(records.length),
    },
  });
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/export/media" || url.pathname === "/export/saved") {
      try {
        return await exportFromDurableStorage(request, runtimeEnv);
      } catch (error) {
        return new Response(`Saved export error: ${error?.message || error}`, { status: 500 });
      }
    }
    return currentWorker.fetch(request, runtimeEnv, ctx);
  },

  async scheduled(controller, runtimeEnv, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, runtimeEnv, ctx);
    return undefined;
  },
};
