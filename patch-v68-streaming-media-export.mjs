import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

const startMarker = "async function handleMediaExportHttp(url, res) {";
const endMarker = "\nfunction requestJson(";
const start = code.indexOf(startMarker);
const end = code.indexOf(endMarker, start);
if (start < 0 || end < 0) {
  throw new Error("v68 media export function anchor not found");
}

const replacement = String.raw`async function mediaWriteResponseChunk(res, chunk) {
  if (!chunk || !chunk.length || res.writableEnded || res.destroyed) return;
  if (res.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("error", onError);
      res.off("close", onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("media export client disconnected")); };
    res.once("drain", onDrain);
    res.once("error", onError);
    res.once("close", onClose);
  });
}

function mediaStreamingZipEntry(name, data, offset) {
  const nameBuffer = Buffer.from(String(name), "utf8");
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const crc = mediaCrc32(payload);
  const local = Buffer.concat([
    mediaLe32(0x04034b50), mediaLe16(20), mediaLe16(0x0800), mediaLe16(0), mediaLe16(0), mediaLe16(0),
    mediaLe32(crc), mediaLe32(payload.length), mediaLe32(payload.length), mediaLe16(nameBuffer.length), mediaLe16(0), nameBuffer
  ]);
  const central = Buffer.concat([
    mediaLe32(0x02014b50), mediaLe16(20), mediaLe16(20), mediaLe16(0x0800), mediaLe16(0), mediaLe16(0), mediaLe16(0),
    mediaLe32(crc), mediaLe32(payload.length), mediaLe32(payload.length), mediaLe16(nameBuffer.length), mediaLe16(0), mediaLe16(0),
    mediaLe16(0), mediaLe16(0), mediaLe32(0), mediaLe32(offset), nameBuffer
  ]);
  return { local, payload, central, nextOffset: offset + local.length + payload.length };
}

async function handleMediaExportHttp(url, res) {
  const mode = url.searchParams.get("mode") === "new" ? "new" : "all";
  const since = mode === "new" ? Math.max(0, Number(url.searchParams.get("since") || 0)) : 0;
  const rows = await mediaFetchAllHistory(since);
  const found = rows.reduce((total, message) => total + imageUrls(message).length, 0);
  const filename = (mode === "new" ? "max_new_media_" : "max_history_media_") + mediaFileStamp(Date.now()) + ".zip";

  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": 'attachment; filename="' + filename + '"',
    "Cache-Control": "no-store, private",
    "X-MAX-Messages": String(rows.length),
    "X-MAX-Images": String(found),
    "X-MAX-Archive-Version": "v68-streaming"
  });

  const central = [];
  const manifest = [["date","author","message_id","image_index","file","status","content_type","bytes","source_url","error"]];
  const errors = [];
  let offset = 0;
  let saved = 0;

  const addEntry = async (name, data) => {
    const entry = mediaStreamingZipEntry(name, data, offset);
    await mediaWriteResponseChunk(res, entry.local);
    await mediaWriteResponseChunk(res, entry.payload);
    central.push(entry.central);
    offset = entry.nextOffset;
  };

  await addEntry("history.txt", Buffer.from(mediaHistoryText(rows, mode, since), "utf8"));

  for (const message of rows) {
    const urls = imageUrls(message);
    for (let index = 0; index < urls.length; index++) {
      const source = urls[index];
      let file = "";
      try {
        const downloaded = await download(source);
        const mid = mediaSafePart(mediaMessageId(message), "msg_" + String(mediaMessageTime(message) || 0));
        const folder = mediaFileStamp(mediaMessageTime(message) || Date.now()).slice(0, 10);
        file = "media/" + folder + "/" + mediaFileStamp(mediaMessageTime(message) || Date.now()) + "_" + mid + "_" + String(index + 1).padStart(2, "0") + "." + mediaExt(downloaded.contentType, source);
        await addEntry(file, downloaded.buffer);
        saved += 1;
        manifest.push([mediaLocalStamp(mediaMessageTime(message)), mediaSenderName(message), mediaMessageId(message), index + 1, file, "ok", downloaded.contentType, downloaded.buffer.length, source, ""]);
      } catch (error) {
        const messageText = errText(error);
        errors.push(mediaLocalStamp(mediaMessageTime(message)) + " | message_id=" + mediaMessageId(message) + " | image=" + (index + 1) + " | " + messageText + " | " + source);
        manifest.push([mediaLocalStamp(mediaMessageTime(message)), mediaSenderName(message), mediaMessageId(message), index + 1, file, "error", "", "", source, messageText]);
      }
    }
  }

  const manifestText = "\ufeff" + manifest.map((row) => row.map(mediaCsvCell).join(",")).join("\r\n");
  await addEntry("manifest.csv", Buffer.from(manifestText, "utf8"));
  await addEntry("README.txt", Buffer.from([
    "MAX — архив истории с изображениями",
    "Версия: v68-streaming",
    "Сообщений: " + rows.length,
    "Картинок найдено: " + found,
    "Картинок скачано: " + saved,
    "Ошибок скачивания: " + errors.length,
    "",
    "Картинки связаны с исходными сообщениями через message_id в manifest.csv."
  ].join("\n"), "utf8"));
  if (errors.length) await addEntry("errors.txt", Buffer.from(errors.join("\n"), "utf8"));

  const centralOffset = offset;
  let centralSize = 0;
  for (const entry of central) {
    await mediaWriteResponseChunk(res, entry);
    centralSize += entry.length;
  }
  const endRecord = Buffer.concat([
    mediaLe32(0x06054b50), mediaLe16(0), mediaLe16(0), mediaLe16(central.length), mediaLe16(central.length),
    mediaLe32(centralSize), mediaLe32(centralOffset), mediaLe16(0)
  ]);
  await mediaWriteResponseChunk(res, endRecord);
  res.end();
}
`;

code = code.slice(0, start) + replacement + code.slice(end);
code = code.replace(/version:\s*"v[^"]+"\s*,?/, 'version: "v68-streaming-media-export",');
fs.writeFileSync(path, code);
console.log("v68 streaming media export enabled");
