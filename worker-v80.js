import { env } from "cloudflare:workers";
import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v79.js";

const VERSION = "worker-v80-bitrix-approved-import";
const ROOT_FOLDER_ID = "93";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();

const APPROVED = new Map([
  ["fa6275e3030358698d482ee67bfcaa58f3eceb3737f371eb5c9d0e079c16a7cf", { name: "c4d1538cb3065f9721dfc4f51e3ed94d91a54c8d30cc212ac293f2308625c319", path: "09d816aa899c4c0fca67bb433c8f41bd7754d25a063ddac77f8e64853832d526" }],
  ["008ffbd660bcd9d42946437871bc7800e552556c36bf562907fe011fec5753bb", { name: "0f380e42926b60a84bfc200be3fd73567464b3cebdf1f3c1977d9149602247d1", path: "09d816aa899c4c0fca67bb433c8f41bd7754d25a063ddac77f8e64853832d526" }],
  ["c9e7f1a6e789fbf503e6229e1200fec6cdf57fc4f6ddfec2a487456270a45a0b", { name: "3b990c62b2b713394debd58ae9cbacafe073f64a936a45cb62a414ae590d6732", path: "09d816aa899c4c0fca67bb433c8f41bd7754d25a063ddac77f8e64853832d526" }],
  ["7a0d02171a20df289315365fac458f4d1ab22be66fe7425ddbeb7ffde127f766", { name: "9eb143c046389b2218f116292416d057b8b74cb0b7c7a3fda2f5f27370c2fdf2", path: "09d816aa899c4c0fca67bb433c8f41bd7754d25a063ddac77f8e64853832d526" }],
  ["64ccde048135448feb951e712ba4519a641a838dd9eb049e5ef25f70ca06a5f2", { name: "20fa07379a370ab4ff006d2a8f1377695203d547fa865eaffa3d9ff3f3a7c19d", path: "09d816aa899c4c0fca67bb433c8f41bd7754d25a063ddac77f8e64853832d526" }],
  ["d07bcbc9d1d5764ea74cf63d75fd50d79d7a114a8200a34e9c34a1e86eed454b", { name: "861c258959f351ac8ccba5226db986fa2d9329d99fd465c3bc547e4b99c6b2ca", path: "09d816aa899c4c0fca67bb433c8f41bd7754d25a063ddac77f8e64853832d526" }],
  ["740478437a3412488489de19234139823390656dc6c5b820b35347175fe5f7fa", { name: "53268e67e2be1ea84839b480c181ff8a156597fa7c1625b999e9d6a23c2aa89d", path: "945e0c798f0297e48a307fc66117d39ad171af93368b36db5b624019f2b31ec1" }],
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

async function resolvePath(runtimeEnv, pathParts) {
  let parentId = ROOT_FOLDER_ID;
  for (const part of pathParts) {
    const name = String(part || "").trim();
    if (!name || name.length > 160 || /[\\\0]/.test(name)) throw new Error("Invalid folder name");
    parentId = await ensureFolder(runtimeEnv, parentId, name);
  }
  return parentId;
}

async function importApproved(request, runtimeEnv) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_FILE_BYTES * 2) return Response.json({ ok: false, error: "Request too large" }, { status: 413, headers: cors });
  const body = await request.json();
  const filename = String(body?.filename || "").trim();
  const pathParts = Array.isArray(body?.path) ? body.path.map((v) => String(v)) : [];
  if (!filename || filename.length > 240 || !pathParts.length || pathParts.length > 8) {
    return Response.json({ ok: false, error: "Invalid migration metadata" }, { status: 400, headers: cors });
  }

  const bytes = decodeBase64(body?.base64);
  const fileHash = await sha256HexBytes(bytes);
  const approved = APPROVED.get(fileHash);
  if (!approved) return Response.json({ ok: false, error: "File is not approved for this migration" }, { status: 403, headers: cors });

  const nameHash = await sha256HexText(filename);
  const pathHash = await sha256HexText(pathParts.join("/"));
  if (nameHash !== approved.name || pathHash !== approved.path) {
    return Response.json({ ok: false, error: "Migration destination mismatch" }, { status: 403, headers: cors });
  }

  const folderId = await resolvePath(runtimeEnv, pathParts);
  const items = await children(runtimeEnv, folderId);
  const existing = items.find((item) => String(item?.TYPE || item?.type || "").toLowerCase() === "file" && String(item?.NAME || item?.name || "") === filename);
  if (existing) {
    return Response.json({ ok: true, already: true, fileId: String(existing.ID || existing.id || ""), folderId }, { headers: cors });
  }

  const uploaded = await bx(runtimeEnv, "disk.folder.uploadFile", {
    id: folderId,
    data: { NAME: filename },
    fileContent: [filename, String(body.base64)],
    generateUniqueName: false,
  });
  return Response.json({
    ok: true,
    uploaded: true,
    fileId: String(uploaded?.ID || uploaded?.id || ""),
    folderId,
    size: bytes.length,
  }, { headers: cors });
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/bitrix/import-approved" && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (url.pathname === "/bitrix/import-approved" && request.method === "POST") {
      try { return await importApproved(request, runtimeEnv); }
      catch (error) {
        return Response.json({ ok: false, version: VERSION, error: String(error?.message || error) }, { status: 500, headers: cors });
      }
    }
    if (url.pathname === "/bitrix/import-approved/status") {
      return Response.json({ ok: true, version: VERSION, approvedCount: APPROVED.size }, { headers: cors });
    }
    return currentWorker.fetch(request, runtimeEnv, ctx);
  },
  async scheduled(controller, runtimeEnv, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, runtimeEnv, ctx);
    return undefined;
  },
};
