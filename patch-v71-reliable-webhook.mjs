import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

const startPattern = /async function start\(\) \{[\s\S]*?\n\}\n\nvoid start\(\);/;
if (!startPattern.test(code)) {
  throw new Error("v71 startup block not found");
}

const reliableStart = String.raw`async function start() {
  while (true) {
    try {
      await maxRequest("/me", { timeout: 12000 });
      state.maxAuthorized = true;

      // The webhook and basic export commands must not depend on an AI provider.
      await ensureWebhook();
      state.webhookConfigured = true;
      state.webhookMode = true;

      try {
        if (typeof loadPersistedChats === "function") await loadPersistedChats();
        for (const id of SEEDED_CHAT_IDS) await rememberGroup(id);
        state.lastChatLoadError = null;
      } catch (chatError) {
        state.lastChatLoadError = errText(chatError);
      }

      try {
        await getGigaToken(false);
        state.gigachatAuthorized = true;
        state.lastAiError = null;
      } catch (aiError) {
        state.gigachatAuthorized = false;
        state.lastAiError = errText(aiError);
      }

      state.lastError = null;
      let lastWebhookRefreshAt = Date.now();
      let lastAiRetryAt = Date.now();

      while (true) {
        await sleep(60000);

        // Refresh the MAX subscription periodically so commands keep arriving.
        if (Date.now() - lastWebhookRefreshAt >= 10 * 60 * 1000) {
          try {
            await ensureWebhook();
            state.webhookConfigured = true;
            lastWebhookRefreshAt = Date.now();
          } catch (webhookError) {
            state.webhookConfigured = false;
            state.lastError = "webhook refresh: " + errText(webhookError);
            throw webhookError;
          }
        }

        // AI is optional for chat listing and archive export. Retry it separately.
        if (!state.gigachatAuthorized && Date.now() - lastAiRetryAt >= 5 * 60 * 1000) {
          lastAiRetryAt = Date.now();
          try {
            await getGigaToken(true);
            state.gigachatAuthorized = true;
            state.lastAiError = null;
          } catch (aiError) {
            state.gigachatAuthorized = false;
            state.lastAiError = errText(aiError);
          }
        }
      }
    } catch (e) {
      state.maxAuthorized = false;
      state.webhookConfigured = false;
      state.lastError = "startup: " + errText(e);
      await sleep(5000);
    }
  }
}

void start();`;

code = code.replace(startPattern, reliableStart);
code = code.replace(/version:\s*"v[^"]+"\s*,?/, 'version: "v71-reliable-webhook",');

fs.writeFileSync(path, code);
console.log("v71 reliable MAX webhook enabled; basic commands no longer depend on AI");
