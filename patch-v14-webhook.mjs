import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceIfPresent(oldText, newText, label) {
  if (!code.includes(oldText)) {
    console.warn(`webhook patch skipped: ${label}`);
    return false;
  }
  code = code.replace(oldText, newText);
  console.log(`webhook patched: ${label}`);
  return true;
}

if (!code.includes('const WEBHOOK_URL = (process.env.MAX_WEBHOOK_URL || "").trim();')) {
  replaceIfPresent(
    'const STATE_URL = (process.env.STATE_URL || "").trim();',
    'const STATE_URL = (process.env.STATE_URL || "").trim();\nconst WEBHOOK_URL = (process.env.MAX_WEBHOOK_URL || "").trim();',
    'webhook env'
  );
}

const serverOld = [
  'http.createServer((_req, res) => {',
  '  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });',
  '  res.end(JSON.stringify({ ok: true, service: "MAX учет бот", ...state }, null, 2));',
  '}).listen(PORT, "0.0.0.0");'
].join('\n');

const serverNew = [
  'http.createServer((req, res) => {',
  '  if (req.method === "POST" && req.url === "/update") {',
  '    let raw = "";',
  '    req.setEncoding("utf8");',
  '    req.on("data", (chunk) => { raw += chunk; });',
  '    req.on("end", () => {',
  '      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });',
  '      res.end(JSON.stringify({ ok: true }));',
  '      try {',
  '        const update = JSON.parse(raw || "{}");',
  '        Promise.resolve(handleUpdate(update)).catch((error) => {',
  '          state.lastError = `webhook update: ${errText(error)}`;',
  '        });',
  '      } catch (error) {',
  '        state.lastError = `webhook parse: ${errText(error)}`;',
  '      }',
  '    });',
  '    return;',
  '  }',
  '',
  '  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });',
  '  res.end(JSON.stringify({ ok: true, service: "MAX учет бот", ...state }, null, 2));',
  '}).listen(PORT, "0.0.0.0");'
].join('\n');

if (!code.includes('req.method === "POST" && req.url === "/update"')) {
  replaceIfPresent(serverOld, serverNew, 'http update endpoint');
}

replaceIfPresent(
  'if (/^(какие чаты|какие чаты видишь|список чатов)$/i.test(text)) {',
  'if (/какие\\s+чаты|какие.*чаты.*вид|список.*чат/i.test(text)) {',
  'chat list command'
);

const startNew = [
  'async function ensureWebhook() {',
  '  if (!WEBHOOK_URL) throw new Error("MAX_WEBHOOK_URL is not configured");',
  '  try {',
  '    await maxRequest(`/subscriptions?url=${encodeURIComponent(WEBHOOK_URL)}`, { method: "DELETE", timeout: 20000 });',
  '  } catch (error) {',
  '    console.error("remove current webhook", errText(error));',
  '  }',
  '  const result = await maxRequest("/subscriptions", {',
  '    method: "POST",',
  '    body: {',
  '      url: WEBHOOK_URL,',
  '      update_types: ["message_created","message_edited","message_removed","bot_added","bot_removed","chat_title_changed","bot_started","bot_stopped"]',
  '    },',
  '    timeout: 30000',
  '  });',
  '  if (result?.success === false) throw new Error(result?.message || "MAX webhook subscription failed");',
  '  state.polling = false;',
  '  state.webhookMode = true;',
  '  state.webhookConfigured = true;',
  '}',
  '',
  'async function start() {',
  '  while (true) {',
  '    try {',
  '      await maxRequest("/me", { timeout: 12000 });',
  '      state.maxAuthorized = true;',
  '      await getGigaToken(false);',
  '      state.gigachatAuthorized = true;',
  '      if (typeof loadPersistedChats === "function") await loadPersistedChats();',
  '      for (const id of SEEDED_CHAT_IDS) await rememberGroup(id);',
  '      await ensureWebhook();',
  '      state.lastError = null;',
  '      while (true) await sleep(60000);',
  '    } catch (e) {',
  '      state.maxAuthorized = false;',
  '      state.webhookConfigured = false;',
  '      state.lastError = `startup: ${errText(e)}`;',
  '      await sleep(5000);',
  '    }',
  '  }',
  '}',
  '',
  'void start();'
].join('\n');

const startPattern = /async function start\(\) \{[\s\S]*?\n\}\n\nvoid start\(\);/;
if (startPattern.test(code)) {
  code = code.replace(startPattern, startNew);
  console.log('webhook patched: startup');
} else if (!code.includes('async function ensureWebhook()')) {
  throw new Error('webhook startup block not found');
}

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v30-webhook-refresh",');

fs.writeFileSync(path, code);
console.log("MAX webhook transport enabled and subscription refreshed");
