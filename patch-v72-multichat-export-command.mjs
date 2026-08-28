import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

const privateLine = '  const text = normalizeText(msgText(message)); const imgs = imageUrls(message); if (!text && !imgs.length) return;';
if (!code.includes(privateLine)) {
  throw new Error("v72 private command anchor not found");
}

const command = String.raw`
  const multiChatExportMatch = text.match(/^экспорт\s+(?:с\s+фото|с\s+картинками|медиа|media)\b([\s\S]*)$/i);
  if (multiChatExportMatch) {
    try {
      let tail = normalizeText(multiChatExportMatch[1] || "");
      const idMatch = tail.match(/(?:^|\s)(?:чат(?:_id)?\s*[=:]?\s*)?(-?\d{10,20})(?=\s|$)/i);
      let chatId = String(SEEDED_CHAT_IDS[0] || "-77828005225953");
      if (idMatch) {
        chatId = String(idMatch[1]);
        if (/^\d+$/.test(chatId)) chatId = "-" + chatId;
        tail = normalizeText((tail.slice(0, idMatch.index) + " " + tail.slice((idMatch.index || 0) + idMatch[0].length)).trim());
      }

      const nowMs = Date.now();
      const localNow = new Date(nowMs + TZ_OFFSET_MINUTES * 60000);
      const currentYear = localNow.getUTCFullYear();
      const localDayStart = (daysOffset = 0) => {
        const d = new Date(nowMs + TZ_OFFSET_MINUTES * 60000);
        d.setUTCHours(0, 0, 0, 0);
        d.setUTCDate(d.getUTCDate() + daysOffset);
        return d.getTime() - TZ_OFFSET_MINUTES * 60000;
      };
      const normalizeYear = (value, fallback) => {
        if (!value) return fallback;
        const numeric = Number(value);
        return numeric < 100 ? 2000 + numeric : numeric;
      };

      let fromMs = 0;
      let toMs = 0;
      let periodLabel = "вся сохранённая история";
      const cleanedTail = tail.replace(/^за\s+/i, "").trim();

      if (/^(сегодня|за\s+сегодня)$/i.test(tail)) {
        fromMs = localDayStart(0);
        toMs = localDayStart(1);
        periodLabel = "сегодня";
      } else if (/^(вчера|за\s+вчера)$/i.test(tail)) {
        fromMs = localDayStart(-1);
        toMs = localDayStart(0);
        periodLabel = "вчера";
      } else if (cleanedTail) {
        const range = cleanedTail.match(/^(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?(?:\s*(?:-|по)\s*(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?)?$/i);
        if (!range) {
          throw new Error("команда не распознана. Пример: Экспорт с фото сегодня -76058846422497");
        }
        const startDay = Number(range[1]);
        const startMonth = Number(range[2]);
        const startYear = normalizeYear(range[3], currentYear);
        const endDay = Number(range[4] || range[1]);
        const endMonth = Number(range[5] || range[2]);
        const endYear = normalizeYear(range[6], startYear);
        fromMs = Date.UTC(startYear, startMonth - 1, startDay) - TZ_OFFSET_MINUTES * 60000;
        toMs = Date.UTC(endYear, endMonth - 1, endDay + 1) - TZ_OFFSET_MINUTES * 60000;
        if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
          throw new Error("неверно указан период");
        }
        const startLabel = String(startDay).padStart(2, "0") + "." + String(startMonth).padStart(2, "0") + "." + startYear;
        const endLabel = String(endDay).padStart(2, "0") + "." + String(endMonth).padStart(2, "0") + "." + endYear;
        periodLabel = fromMs + 86400000 === toMs ? startLabel : startLabel + " — " + endLabel;
      }

      const exportKey = createHash("sha256").update(MAX_BOT_TOKEN).digest("hex").slice(0, 32);
      const exportOrigin = WEBHOOK_URL ? new URL(WEBHOOK_URL).origin : "https://max-uchet-bot-gaina.irina-gaina-84-036.workers.dev";
      let exportUrl = exportOrigin + "/export/media?t=" + encodeURIComponent(exportKey)
        + "&mode=all&chat_id=" + encodeURIComponent(chatId)
        + "&limit=5000";
      if (fromMs > 0) exportUrl += "&from=" + encodeURIComponent(String(fromMs));
      if (toMs > 0) exportUrl += "&to=" + encodeURIComponent(String(toMs));

      const chatMeta = knownGroups.get(chatId);
      const chatLabel = chatMeta?.title || ("чат " + chatId);
      await sendText(
        "user_id=" + encodeURIComponent(senderId),
        "ZIP с перепиской и вложениями.\nЧат: " + chatLabel + " (" + chatId + ")\nПериод: " + periodLabel + "\n\n" + exportUrl
      );
    } catch (e) {
      state.lastError = "multi-chat export: " + errText(e);
      await sendText(
        "user_id=" + encodeURIComponent(senderId),
        "Не удалось подготовить выгрузку: " + errText(e).slice(0, 700)
      );
    }
    return;
  }`;

code = code.replace(privateLine, privateLine + command);
code = code.replace(/version:\s*"v[^"]+"\s*,?/, 'version: "v72-multichat-export",');

fs.writeFileSync(path, code);
console.log("v72 multi-chat date export command enabled");
