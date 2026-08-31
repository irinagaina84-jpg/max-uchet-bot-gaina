import { env } from "cloudflare:workers";
import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v80.js";

const VERSION = "worker-v81-bitrix-batch2";
const ROOT_FOLDER_ID = "93";
const TARGET_PATH = [
  "01 ИНТЕРФОРТУМ — проекты и первичка",
  "01 Констэво",
  "04 Выдачи и контейнеры",
];
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();

const APPROVED = new Map([
  ["db6df3f1bc73c2cdf76775f61b0d35c68bedccb790d47277e65fddc6194d8aaa", "b617564a1d1daed1a305dffd1cb04dca14cf3d2dc0982d75f898d89fb0a365a8"],
  ["0047ae554f882cd0018b9d015c8a7f8ef544f73e41b504113e3334ea3c7443e0", "6745f961df3100a4f5b69f04822087ee696980078025de206203cec3c1d8b65b"],
  ["3271d31397b382f3eb4d247c90416c5bab4d692b5c7dde29aedd0f4c321fc111", "d803d4955618b57fc751bef3ab93dd8f4b982c3c6bde1e9cf9929db61193770b"],
  ["680e7f321efd2d7362b66615e9164ea0edbcb486f765cfd1072c5e464dd78ca3", "ed8c439396326ceaadcb09cff820896740ebce8f35f4689d85aeae62b798405c"],
  ["2040b78fc0e0de6cbb429822cd25b161ba0c7f63d1cef74b39fb4abbd8d3dfa8", "3510d6c9aa6a63bede697a25925b0123c2ab2d5de7c80fda00866036e1ff0cf1"],
  ["d759fdc06c85a15a43d34480ce7c119c0f9596187110a1fa79755f4c25468626", "3cfe6457d1f87dbaa84489222a26950e219224dcbf4ec500d119cda90e951b9b"],
  ["a71791973a49e7a201e64a5613c70abf447781499397ee0c0d34cf51d381a793", "43d17750bed8bff936d74e1dade9b2f976aecdaf8eca79cfd63f77cdc0c0d73c"],
  ["24a6d0db33377a8c1a784d9f9b3c5a1ace6c199dc1f4853c7006e93c8bc0065a", "5ae77dbfdd126463eae90b7730faeacf2fcc85b6a4450b6be408371e846e9288"],
  ["84f31d64f84f4f80109ecd71a42d7494f0b02d666493293795e530a4908fdea2", "80003881f489b212dfb4ff6176c0b729ae16afb5cfb72ff120828811523c5ee7"],
  ["b8b729556a30dc2512a9dc65ff96c353c00ac87f5386a0a02903174f94b8d3d7", "9ef2ed612c72f10a0ca3ce45f9efef5ee2d04ef5ccee56057db07db83e84a73f"],
]);

export class MaxBotContainer extends BaseMaxBotContainer {}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS,GET",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

function bitrixWebhook(runtimeEnv) {
  return String(runtimeEnv?.BITRIX_WEBHOOK_URL || env.BITRIX_WEBHOOK_URL || "").trim();
}

function methodUrl(base, method) {
  const parsed = new URL(base);
  if (parsed.protocol !== "https:") throw new Error("Bitrix webhook must use HTTPS");
  if (!/\/rest\/\d+\/[^/]+\/?$/i.test(parsed.pathname)) throw new Error("Invalid Bitrix webhook format");
  parsed.search = "";
  parsed.hash = "";
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  parsed.pathname += `${method}.json`;
  return parsed.toString();
}

async function bx(runtimeEnv, method, params = {}) {
  const base = bitrixWebhook(runtimeEnv);
  if (!base) throw new Error("BITRIX_WEBHOOK_URL is not configured");
  const response = await fetch(methodUrl(base, method), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(params),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) throw new Error(String(payload?.error_description || payload?.error || `HTTP ${response.status}`));
  return payload?.result;
}

async function sha256HexBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256HexText(text) {
  return sha256HexBytes(encoder.encode(String(text || "")));
}

function decodeBase64(value) {
  const text = String(value || "");
  if (!text || text.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 32) throw new Error("File payload too large");
  const binary = atob(text);
  if (binary.length > MAX_FILE_BYTES) throw new Error("File too large");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function children(runtimeEnv, folderId) {
  const result = await bx(runtimeEnv, "disk.folder.getchildren", { id: folderId });
  return Array.isArray(result) ? result : [];
}

async function ensureFolder(runtimeEnv, parentId, name) {
  const items = await children(runtimeEnv, parentId);
  const found = items.find((item) => String(item?.TYPE || item?.type || "").toLowerCase() === "folder" && String(item?.NAME || item?.name || "") === name);
  if (found) return String(found.ID || found.id);
  const created = await bx(runtimeEnv, "disk.folder.addsubfolder", { id: parentId, data: { NAME: name } });
  const id = String(created?.ID || created?.id || "");
  if (!id) throw new Error("Bitrix did not return folder id");
  return id;
}

async function targetFolder(runtimeEnv) {
  let id = ROOT_FOLDER_ID;
  for (const name of TARGET_PATH) id = await ensureFolder(runtimeEnv, id, name);
  return id;
}

async function importApproved(request, runtimeEnv) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_FILE_BYTES * 2) return Response.json({ ok: false, error: "Request too large" }, { status: 413, headers: cors });
  const body = await request.json();
  const filename = String(body?.filename || "").trim();
  if (!filename || filename.length > 240) return Response.json({ ok: false, error: "Invalid filename" }, { status: 400, headers: cors });

  const bytes = decodeBase64(body?.base64);
  const fileHash = await sha256HexBytes(bytes);
  const expectedNameHash = APPROVED.get(fileHash);
  if (!expectedNameHash) return Response.json({ ok: false, error: "File is not approved for this migration" }, { status: 403, headers: cors });
  if (await sha256HexText(filename) !== expectedNameHash) return Response.json({ ok: false, error: "Filename mismatch" }, { status: 403, headers: cors });

  const folderId = await targetFolder(runtimeEnv);
  const items = await children(runtimeEnv, folderId);
  const existing = items.find((item) => String(item?.TYPE || item?.type || "").toLowerCase() === "file" && String(item?.NAME || item?.name || "") === filename);
  if (existing) return Response.json({ ok: true, already: true, fileId: String(existing.ID || existing.id || ""), folderId }, { headers: cors });

  const uploaded = await bx(runtimeEnv, "disk.folder.uploadFile", {
    id: folderId,
    data: { NAME: filename },
    fileContent: [filename, String(body.base64)],
    generateUniqueName: false,
  });
  return Response.json({ ok: true, uploaded: true, fileId: String(uploaded?.ID || uploaded?.id || ""), folderId, size: bytes.length }, { headers: cors });
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/bitrix/import-approved-2" && request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/bitrix/import-approved-2" && request.method === "POST") {
      try { return await importApproved(request, runtimeEnv); }
      catch (error) { return Response.json({ ok: false, version: VERSION, error: String(error?.message || error) }, { status: 500, headers: cors }); }
    }
    if (url.pathname === "/bitrix/import-approved-2/status") return Response.json({ ok: true, version: VERSION, approvedCount: APPROVED.size }, { headers: cors });
    return currentWorker.fetch(request, runtimeEnv, ctx);
  },
  async scheduled(controller, runtimeEnv, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, runtimeEnv, ctx);
    return undefined;
  },
};
