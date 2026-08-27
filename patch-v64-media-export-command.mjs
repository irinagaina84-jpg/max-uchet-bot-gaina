import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error("v64 anchor not found: " + label);
  code = code.replace(oldText, newText);
  console.log("v64 patched: " + label);
}

const privateLine = '  const text = normalizeText(msgText(message)); const imgs = imageUrls(message); if (!text && !imgs.length) return;';
const command = String.raw`
  if (/^экспорт\s+(?:с\s+фото|с\s+картинками|медиа|media)$/i.test(text)) {
    try {
      const exportKey = createHash("sha256").update(MAX_BOT_TOKEN).digest("hex").slice(0, 32);
      const exportOrigin = WEBHOOK_URL ? new URL(WEBHOOK_URL).origin : "https://max-uchet-bot-gaina.irina-gaina-84-036.workers.dev";
      const exportUrl = exportOrigin + "/export/media?t=" + encodeURIComponent(exportKey) + "&mode=all";
      await sendText("user_id=" + encodeURIComponent(senderId), "Готовлю полный ZIP с перепиской и картинками. Открой ссылку после сообщения:\n\n" + exportUrl);
    } catch (e) {
      state.lastError = "media export: " + errText(e);
      await sendText("user_id=" + encodeURIComponent(senderId), "Не удалось подготовить экспорт с фото: " + errText(e).slice(0, 700));
    }
    return;
  }
  if (/^экспорт\s+нов(?:ых|ое)\s+(?:с\s+фото|с\s+картинками|медиа|media)$/i.test(text)) {
    try {
      const chatId = String(SEEDED_CHAT_IDS[0] || "");
      const checkpoint = await getHistoryExportCheckpoint(chatId);
      if (!checkpoint.ms) {
        await sendText("user_id=" + encodeURIComponent(senderId), "Сначала отправь «Экспорт истории» или «Экспорт с фото», чтобы установить контрольную точку.");
        return;
      }
      const exportKey = createHash("sha256").update(MAX_BOT_TOKEN).digest("hex").slice(0, 32);
      const exportOrigin = WEBHOOK_URL ? new URL(WEBHOOK_URL).origin : "https://max-uchet-bot-gaina.irina-gaina-84-036.workers.dev";
      const exportUrl = exportOrigin + "/export/media?t=" + encodeURIComponent(exportKey) + "&mode=new&since=" + encodeURIComponent(String(checkpoint.ms + 1));
      await sendText("user_id=" + encodeURIComponent(senderId), "Готовлю ZIP только с новыми сообщениями и картинками. Открой ссылку:\n\n" + exportUrl);
    } catch (e) {
      state.lastError = "new media export: " + errText(e);
      await sendText("user_id=" + encodeURIComponent(senderId), "Не удалось подготовить экспорт новых с фото: " + errText(e).slice(0, 700));
    }
    return;
  }`;

replaceOnce(privateLine, privateLine + command, "private media export commands");

if (code.includes('exportDownloadLink: true,') && !code.includes('mediaExportZip: true,')) {
  code = code.replace('exportDownloadLink: true,', 'exportDownloadLink: true,\n  mediaExportZip: true,');
}

fs.writeFileSync(path, code);
console.log("v64 MAX media export command enabled");
