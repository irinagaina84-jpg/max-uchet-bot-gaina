import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error(`marker patch anchor not found: ${label}`);
  code = code.replace(oldText, newText);
}

replaceOnce(
  'const STATE_URL = (process.env.STATE_URL || "").trim();',
  'const STATE_URL = (process.env.STATE_URL || "").trim();\nconst MARKER_URL = STATE_URL ? STATE_URL.replace(/\\/state$/, "/marker") : "";',
  'marker url'
);

replaceOnce(
  'async function poll() {\n  let marker = null, first = true; state.polling = true;',
  `async function loadPollMarker() {\n  if (!MARKER_URL) return null;\n  try {\n    const r = await requestJson(MARKER_URL, {\n      method: "GET",\n      headers: { "X-Internal-Auth": MAX_BOT_TOKEN, Accept: "application/json" },\n      timeout: 15000,\n    });\n    const value = r?.data?.marker;\n    return value == null ? null : Number(value);\n  } catch (error) {\n    console.error("loadPollMarker", errText(error));\n    return null;\n  }\n}\n\nasync function savePollMarker(marker) {\n  if (!MARKER_URL || marker == null) return;\n  try {\n    await requestJson(MARKER_URL, {\n      method: "POST",\n      headers: {\n        "X-Internal-Auth": MAX_BOT_TOKEN,\n        Accept: "application/json",\n        "Content-Type": "application/json",\n      },\n      body: JSON.stringify({ marker: Number(marker) }),\n      timeout: 15000,\n    });\n  } catch (error) {\n    console.error("savePollMarker", errText(error));\n  }\n}\n\nasync function poll() {\n  let marker = await loadPollMarker();\n  let first = marker == null;\n  state.polling = true;`,
  'poll startup marker'
);

replaceOnce(
  'first = false; if (d?.marker != null) marker = d.marker;\n      for (const u of d?.updates || []) await handleUpdate(u);',
  'first = false;\n      if (d?.marker != null) { marker = d.marker; await savePollMarker(marker); }\n      for (const u of d?.updates || []) await handleUpdate(u);',
  'save marker'
);

code = code.replace(
  'version: "v24-fullchat-silent",',
  'version: "v26-fullchat-silent-marker",'
);

fs.writeFileSync(path, code);
console.log("persistent MAX update marker enabled");
