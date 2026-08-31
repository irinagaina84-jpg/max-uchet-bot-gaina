import { env } from "cloudflare:workers";
import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v81.js";

const VERSION = "worker-v82-bitrix-batch3";
const ROOT_FOLDER_ID = "93";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();

const APPROVED = new Map([
  ["b1ca9f4dc17e0569b38b3d0a27d3f83a609631ce7b17830adb320f150a1d0207", { name: "55d41c19ad4297ce6d59df33e38d816212bb4cc26f0f3dd77fc36726fc43da96", path: "5649e92c8ec293565eda5384d1aab1917c5b949a08dfd0994525b2141dcf6ffb" }],
  ["1b92775f57c3dc9df534ef10c24c6455410753b6e1103c47cfcb79e6ded4f105", { name: "71b72c660d6663622ad37c0d1bbe7327db77fe6b480018b32bbcc5580df25db0", path: "edf0e9e8b350ac15b3719d636008b2c366f3af862abd601267309f1264caf107" }],
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
  const binary = atob(text);
  if (!text || binary.length > MAX_FILE_BYTES) throw new Error("File too large");
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
    if (url.pathname === "/bitrix/import-approved-3" && request.method === "OPTIONS") return new Response(null, { status:204, headers:cors });
    if (url.pathname === "/bitrix/import-approved-3/status") return Response.json({ ok:true, version:VERSION, approvedCount:APPROVED.size }, { headers:cors });
    if (url.pathname === "/bitrix/import-approved-3" && request.method === "POST") {
      try { return await importFile(request, runtimeEnv); }
      catch (e) { return Response.json({ ok:false, version:VERSION, error:String(e?.message || e) }, { status:500, headers:cors }); }
    }
    return currentWorker.fetch(request, runtimeEnv, ctx);
  },
  async scheduled(controller, runtimeEnv, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, runtimeEnv, ctx);
  },
};
