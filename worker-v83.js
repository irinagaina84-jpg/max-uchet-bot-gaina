import { env } from "cloudflare:workers";
import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v82.js";

const VERSION = "worker-v83-bitrix-nastya-archive";
const ROOT_FOLDER_ID = "93";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const encoder = new TextEncoder();

const APPROVED = new Map([
  ["819d362542ab86d3f53259eacb22e9259fd0aa1ca6db4bae353f696ad81d3409", { name: "fd5d6a3fa3bdd70cbd932387f033a3574b82c6ae544bfdae0e71cd2a7a46e8a9", path: "1d6e0b2df35d703935c558b9dee1504a0a102187662c2654a374c021b415286a" }],
]);

export class MaxBotContainer extends BaseMaxBotContainer {}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS,GET",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

function webhook(runtimeEnv) {
  return String(runtimeEnv?.BITRIX_WEBHOOK_URL || env.BITRIX_WEBHOOK_URL || "").trim();
}

function methodUrl(base, method) {
  const u = new URL(base);
  if (u.protocol !== "https:" || !/\/rest\/\d+\/[^/]+\/?$/i.test(u.pathname)) throw new Error("Invalid Bitrix webhook");
  u.search = ""; u.hash = "";
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  u.pathname += `${method}.json`;
  return u.toString();
}

async function bx(runtimeEnv, method, params = {}) {
  const base = webhook(runtimeEnv);
  if (!base) throw new Error("BITRIX_WEBHOOK_URL is not configured");
  const r = await fetch(methodUrl(base, method), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(String(j?.error_description || j?.error || `HTTP ${r.status}`));
  return j?.result;
}

async function hashBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function hashText(text) { return hashBytes(encoder.encode(String(text || ""))); }

function decodeBase64(value) {
  const text = String(value || "");
  if (!text || text.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 64) throw new Error("File payload too large");
  const binary = atob(text);
  if (binary.length > MAX_FILE_BYTES) throw new Error("File too large");
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function children(runtimeEnv, id) {
  const result = await bx(runtimeEnv, "disk.folder.getchildren", { id });
  return Array.isArray(result) ? result : [];
}

async function ensureFolder(runtimeEnv, parentId, name) {
  const items = await children(runtimeEnv, parentId);
  const found = items.find(x => String(x?.TYPE || x?.type || "").toLowerCase() === "folder" && String(x?.NAME || x?.name || "") === name);
  if (found) return String(found.ID || found.id);
  const created = await bx(runtimeEnv, "disk.folder.addsubfolder", { id: parentId, data: { NAME: name } });
  const id = String(created?.ID || created?.id || "");
  if (!id) throw new Error("Folder id missing");
  return id;
}

async function resolvePath(runtimeEnv, parts) {
  let id = ROOT_FOLDER_ID;
  for (const raw of parts) {
    const name = String(raw || "").trim();
    if (!name || name.length > 160 || /[\\\0]/.test(name)) throw new Error("Invalid folder name");
    id = await ensureFolder(runtimeEnv, id, name);
  }
  return id;
}

async function importFile(request, runtimeEnv) {
  const body = await request.json();
  const filename = String(body?.filename || "").trim();
  const path = Array.isArray(body?.path) ? body.path.map(String) : [];
  if (!filename || !path.length || path.length > 8) return Response.json({ ok:false, error:"Invalid metadata" }, { status:400, headers:cors });

  const bytes = decodeBase64(body?.base64);
  const fileHash = await hashBytes(bytes);
  const approved = APPROVED.get(fileHash);
  if (!approved) return Response.json({ ok:false, error:"File is not approved" }, { status:403, headers:cors });
  if (await hashText(filename) !== approved.name || await hashText(path.join("/")) !== approved.path) {
    return Response.json({ ok:false, error:"Destination mismatch" }, { status:403, headers:cors });
  }

  const folderId = await resolvePath(runtimeEnv, path);
  const existing = (await children(runtimeEnv, folderId)).find(x => String(x?.TYPE || x?.type || "").toLowerCase() === "file" && String(x?.NAME || x?.name || "") === filename);
  if (existing) return Response.json({ ok:true, already:true, folderId, fileId:String(existing.ID || existing.id || "") }, { headers:cors });

  const uploaded = await bx(runtimeEnv, "disk.folder.uploadFile", {
    id: folderId,
    data: { NAME: filename },
    fileContent: [filename, String(body.base64)],
    generateUniqueName: false,
  });
  return Response.json({ ok:true, uploaded:true, folderId, fileId:String(uploaded?.ID || uploaded?.id || ""), size:bytes.length }, { headers:cors });
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/bitrix/import-nastya-archive" && request.method === "OPTIONS") return new Response(null, { status:204, headers:cors });
    if (url.pathname === "/bitrix/import-nastya-archive/status") return Response.json({ ok:true, version:VERSION, approvedCount:APPROVED.size }, { headers:cors });
    if (url.pathname === "/bitrix/import-nastya-archive" && request.method === "POST") {
      try { return await importFile(request, runtimeEnv); }
      catch (e) { return Response.json({ ok:false, version:VERSION, error:String(e?.message || e) }, { status:500, headers:cors }); }
    }
    return currentWorker.fetch(request, runtimeEnv, ctx);
  },
  async scheduled(controller, runtimeEnv, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, runtimeEnv, ctx);
  },
};
