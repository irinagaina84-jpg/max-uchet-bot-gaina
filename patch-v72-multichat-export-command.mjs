import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

const privateLine = '  const text = normalizeText(msgText(message)); const imgs = imageUrls(message); if (!text && !imgs.length) return;';
if (!code.includes(privateLine)) {
  throw new Error("v73 private command anchor not found");
}

// JavaScript \b only understands ASCII word characters. It does not create a
// boundary after the Cyrillic word "фото", so use a whitespace/end lookahead.
const commandSmokePattern = /^экспорт\s+(?:с\s+фото|с\s+картинками|медиа|media)(?=\s|$)([\s\S]*)$/i;
for (const sample of [
  "Экспорт с фото сегодня -76058846422497",
  "Экспорт с картинками 28.08 -76058846422497",
  "Экспорт медиа -76058846422497",
  "Экспорт с фото 01.06.2026-30.06.2026 -76058846422497",
]) {
  if (!commandSmokePattern.test(sample)) {
    throw new Error(`v73 ZIP command smoke test failed: ${sample}`);
  }
}

const command = String.raw`
  const multiChatExportMatch = text.match(/^экспорт\s+(?:с\s+фото|с\s+картинками|медиа|media)(?=\s|$)([\s\S]*)$/i);
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
      let periodLabel = "вся история";
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

      const chatMeta = knownGroups.get(chatId);
      const chatLabel = chatMeta?.title || ("чат " + chatId);
      await sendText(
        "user_id=" + encodeURIComponent(senderId),
        "Загружаю историю перед созданием ZIP.\nЧат: " + chatLabel + " (" + chatId + ")\nПериод: " + periodLabel
      );

      // The downloadable archive is built from Durable Object storage. For a
      // newly connected chat that storage only has webhook messages received
      // after the bot was added. Read the requested historical range from MAX
      // first and persist it, then return the ZIP link.
      const historyRows = [];
      const hardLimit = 5000;
      const lowerBound = Math.max(0, Number(fromMs || 0));
      const upperBound = Math.max(0, Number(toMs || 0));
      let before = upperBound > 0 ? Math.max(1, upperBound - 1) : Date.now() + 60000;

      for (let page = 0; page < 50 && historyRows.length < hardLimit; page += 1) {
        const query = new URLSearchParams({
          chat_id: chatId,
          count: "100",
          from: String(before),
        });
        if (lowerBound > 0) query.set("to", String(lowerBound));

        const data = await maxRequest("/messages?" + query.toString(), { timeout: 60000 });
        const items = Array.isArray(data?.messages)
          ? data.messages
          : Array.isArray(data?.items)
            ? data.items
            : [];
        if (!items.length) break;

        historyRows.push(...items);
        const times = items.map(msgTime).filter((value) => Number(value) > 0);
        const oldest = times.length ? Math.min(...times) : 0;
        if (!oldest || items.length < 100 || (lowerBound > 0 && oldest <= lowerBound)) break;
        before = oldest - 1;
      }

      const uniqueRows = new Map();
      for (const message of historyRows) {
        const key = msgId(message) || String(msgTime(message)) + ":" + uniqueRows.size;
        uniqueRows.set(key, message);
      }
      const selectedRows = [...uniqueRows.values()]
        .filter((message) => {
          const timestamp = Number(msgTime(message) || 0);
          if (lowerBound > 0 && timestamp < lowerBound) return false;
          if (upperBound > 0 && timestamp >= upperBound) return false;
          return true;
        })
        .sort((a, b) => Number(msgTime(a) || 0) - Number(msgTime(b) || 0))
        .slice(-hardLimit);

      if (!selectedRows.length) {
        throw new Error(
          "MAX не вернул сообщения за этот период. Проверьте, что бот назначен администратором чата с правом чтения всех сообщений."
        );
      }

      for (let index = 0; index < selectedRows.length; index += 50) {
        const batch = selectedRows.slice(index, index + 50).map((message) => messageToRaw(chatId, message));
        await ledgerRequest("/raw", {
          method: "POST",
          body: { records: batch },
          timeout: 120000,
        });
      }

      const exportKey = createHash("sha256").update(MAX_BOT_TOKEN).digest("hex").slice(0, 32);
      const exportOrigin = WEBHOOK_URL ? new URL(WEBHOOK_URL).origin : "https://max-uchet-bot-gaina.irina-gaina-84-036.workers.dev";
      let exportUrl = exportOrigin + "/export/media?t=" + encodeURIComponent(exportKey)
        + "&mode=all&chat_id=" + encodeURIComponent(chatId)
        + "&limit=5000";
      if (fromMs > 0) exportUrl += "&from=" + encodeURIComponent(String(fromMs));
      if (toMs > 0) exportUrl += "&to=" + encodeURIComponent(String(toMs));

      await sendText(
        "user_id=" + encodeURIComponent(senderId),
        "ZIP с перепиской и вложениями готов.\nЧат: " + chatLabel + " (" + chatId + ")\nПериод: " + periodLabel + "\nЗагружено сообщений: " + selectedRows.length + "\n\n" + exportUrl
      );
    } catch (e) {
      state.lastError = "multi-chat export: " + errText(e);
      await sendText(
        "user_id=" + encodeURIComponent(senderId),
        "Не удалось подготовить выгрузку: " + errText(e).slice(0, 900)
      );
    }
    return;
  }
  if (/^экспорт\b/i.test(text)) {
    await sendText(
      "user_id=" + encodeURIComponent(senderId),
      "Команда экспорта не распознана. Пример:\nЭкспорт с фото сегодня -76058846422497"
    );
    return;
  }`;

code = code.replace(privateLine, privateLine + command);
code = code.replace(/version:\s*"v[^"]+"\s*,?/, 'version: "v73-history-archive-export",');

fs.writeFileSync(path, code);
console.log("v73 selected-chat history backfill ZIP export enabled");
