import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error(`webhook patch anchor not found: ${label}`);
  code = code.replace(oldText, newText);
}

replaceOnce(
  'const STATE_URL = (process.env.STATE_URL || "").trim();',
  'const STATE_URL = (process.env.STATE_URL || "").trim();\nconst WEBHOOK_URL = (process.env.MAX_WEBHOOK_URL || "").trim();',
  'webhook env'
);

replaceOnce(
  'http.createServer((_req, res) => {\n  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });\n  res.end(JSON.stringify({ ok: true, service: "MAX учет бот", ...state }, null, 2));\n}).listen(PORT, "0.0.0.0");',
  `http.createServer((req, res) => {\n  if (req.method === "POST" && req.url === "/update") {\n    let raw = "";\n    req.setEncoding("utf8");\n    req.on("data", (chunk) => { raw += chunk; });\n    req.on("end", () => {\n      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });\n      res.end(JSON.stringify({ ok: true }));\n      try {\n        const update = JSON.parse(raw || "{}");\n        Promise.resolve(handleUpdate(update)).catch((error) => {\n          state.lastError = \`webhook update: \${errText(error)}\`;\n        });\n      } catch (error) {\n        state.lastError = \`webhook parse: \${errText(error)}\`;\n      }\n    });\n    return;\n  }\n\n  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });\n  res.end(JSON.stringify({ ok: true, service: "MAX учет бот", ...state }, null, 2));\n}).listen(PORT, "0.0.0.0");`,
  'http update endpoint'
);

replaceOnce(
  'if (/^(какие чаты|какие чаты видишь|список чатов)$/i.test(text)) {',
  'if (/какие\\s+чаты|какие.*чаты.*вид|список.*чат/i.test(text)) {',
  'chat list command'
);

const startOld = `async function start() {\n  while (true) {\n    try {\n      await maxRequest("/me", { timeout: 12000 }); state.maxAuthorized = true;\n      await getGigaToken(false); state.gigachatAuthorized = true;\n      await loadPersistedChats();\n      for (const id of SEEDED_CHAT_IDS) await rememberGroup(id);\n      await poll();\n    } catch (e) {\n      state.maxAuthorized = false; state.polling = false; state.lastError = \`startup: \${errText(e)}\`;\n      await sleep(5000);\n    }\n  }\n}\n\nvoid start();`;

const startNew = `async function ensureWebhook() {\n  if (!WEBHOOK_URL) throw new Error("MAX_WEBHOOK_URL is not configured");\n\n  const current = await maxRequest("/subscriptions", { timeout: 20000 });\n  const subscriptions = Array.isArray(current?.subscriptions) ? current.subscriptions : [];\n\n  for (const sub of subscriptions) {\n    const url = String(sub?.url || "");\n    if (url && url !== WEBHOOK_URL) {\n      try {\n        await maxRequest(\`/subscriptions?url=\${encodeURIComponent(url)}\`, { method: "DELETE", timeout: 20000 });\n      } catch (error) {\n        console.error("remove old webhook", errText(error));\n      }\n    }\n  }\n\n  const already = subscriptions.some((sub) => String(sub?.url || "") === WEBHOOK_URL);\n  if (!already) {\n    const result = await maxRequest("/subscriptions", {\n      method: "POST",\n      body: {\n        url: WEBHOOK_URL,\n        update_types: [\n          "message_created",\n          "message_edited",\n          "message_removed",\n          "bot_added",\n          "bot_removed",\n          "chat_title_changed",\n          "bot_started"\n        ]\n      },\n      timeout: 30000\n    });\n    if (result?.success === false) throw new Error(result?.message || "MAX webhook subscription failed");\n  }\n\n  state.polling = false;\n  state.webhookMode = true;\n  state.webhookConfigured = true;\n}\n\nasync function start() {\n  while (true) {\n    try {\n      await maxRequest("/me", { timeout: 12000 });\n      state.maxAuthorized = true;\n      await getGigaToken(false);\n      state.gigachatAuthorized = true;\n      await loadPersistedChats();\n      for (const id of SEEDED_CHAT_IDS) await rememberGroup(id);\n      await ensureWebhook();\n      state.lastError = null;\n      while (true) await sleep(60000);\n    } catch (e) {\n      state.maxAuthorized = false;\n      state.webhookConfigured = false;\n      state.lastError = \`startup: \${errText(e)}\`;\n      await sleep(5000);\n    }\n  }\n}\n\nvoid start();`;

replaceOnce(startOld, startNew, 'webhook startup');

code = code.replace(
  'version: "v24-fullchat-silent",',
  'version: "v27-webhook-fullchat-silent",'
);

fs.writeFileSync(path, code);
console.log("MAX webhook transport enabled");
