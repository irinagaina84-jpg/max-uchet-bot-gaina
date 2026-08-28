import fs from "node:fs";

const path = "./patch-v65-media-container-export.mjs";
let source = fs.readFileSync(path, "utf8");

const start = source.indexOf("const serverPattern = ");
const endMarker = "code = code.replace(serverPattern, server);";
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0) {
  throw new Error("v65 source server block not found");
}

const syncStart = "http.createServer((req, res) => {";
const asyncStart = "http.createServer(async (req, res) => {";
const exportGuard = [
  "",
  "  const mediaUrl = new URL(req.url || \"/\", \"http://container\");",
  "  if (req.method === \"GET\" && mediaUrl.pathname === \"/export/media\") {",
  "    try {",
  "      await handleMediaExportHttp(mediaUrl, res);",
  "    } catch (e) {",
  "      if (!res.headersSent) res.writeHead(500, { \"Content-Type\": \"text/plain; charset=utf-8\" });",
  "      if (!res.writableEnded) res.end(\"container export error: \" + errText(e));",
  "    }",
  "    return;",
  "  }"
].join("\n");

const replacement = [
  `const serverSyncStart = ${JSON.stringify(syncStart)};`,
  `const serverAsyncStart = ${JSON.stringify(asyncStart)};`,
  `const exportGuard = ${JSON.stringify(exportGuard)};`,
  "",
  `if (!code.includes(${JSON.stringify('mediaUrl.pathname === "/export/media"')})) {`,
  "  if (code.includes(serverSyncStart)) {",
  "    code = code.replace(serverSyncStart, serverAsyncStart + exportGuard);",
  "  } else if (code.includes(serverAsyncStart)) {",
  "    code = code.replace(serverAsyncStart, serverAsyncStart + exportGuard);",
  "  } else {",
  "    throw new Error(\"v65 http server anchor not found\");",
  "  }",
  "}"
].join("\n");

source = source.slice(0, start) + replacement + source.slice(end + endMarker.length);
fs.writeFileSync(path, source);
console.log("v65 server anchor fixed without removing webhook endpoint");
