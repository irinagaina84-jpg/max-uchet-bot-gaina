import { env } from "cloudflare:workers";
import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v85.js";

const VERSION = "worker-v86-interfortum-card";
const ROOT_FOLDER_ID = "93";
const APPROVED_HASH = "21ba370e5c3a78739f0bede79477b75716f75123c09ff3dcbb28a8b63f655453";
const APPROVED_NAME = "Карточка предприятия — ИНТЕРФОРТУМ — 31.08.2026.jpg";
const APPROVED_PATH = ["01 ИНТЕРФОРТУМ", "00 КАРТОЧКА И РЕКВИЗИТЫ"];

export class MaxBotContainer extends BaseMaxBotContainer {}

const headers = {
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
async function children(runtimeEnv, id) {
  const result = await bx(runtimeEnv, "disk.folder.getchildren", { id });
  return Array.isArray(result) ? result : [];
}
function idOf(x) { return String(x?.ID || x?.id || ""); }
function nameOf(x) { return String(x?.NAME || x?.name || ""); }
function typeOf(x) { return String(x?.TYPE || x?.type || "").toLowerCase(); }
async function resolvePath(runtimeEnv) {
  let id = ROOT_FOLDER_ID;
  for (const name of APPROVED_PATH) {
    const f = (await children(runtimeEnv, id)).find(x => typeOf(x) === "folder" && nameOf(x) === name);
    if (!f) throw new Error(`Folder not found: ${name}`);
    id = idOf(f);
  }
  return id;
}
function decode(value) {
  const b = atob(String(value || ""));
  if (!b || b.length > 2 * 1024 * 1024) throw new Error("Invalid file size");
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
async function hash(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function upload(request, runtimeEnv) {
  const body = await request.json();
  if (String(body?.filename || "") !== APPROVED_NAME) return Response.json({ ok:false, error:"Wrong file name" }, { status:403, headers });
  const bytes = decode(body?.base64);
  if (await hash(bytes) !== APPROVED_HASH) return Response.json({ ok:false, error:"File is not approved" }, { status:403, headers });
  const folderId = await resolvePath(runtimeEnv);
  const existing = (await children(runtimeEnv, folderId)).find(x => typeOf(x) === "file" && nameOf(x) === APPROVED_NAME);
  if (existing) return Response.json({ ok:true, already:true, fileId:idOf(existing), folderId }, { headers });
  const result = await bx(runtimeEnv, "disk.folder.uploadfile", {
    id: folderId,
    data: { NAME: APPROVED_NAME },
    fileContent: [APPROVED_NAME, String(body.base64)],
    generateUniqueName: false,
  });
  return Response.json({ ok:true, uploaded:true, fileId:String(result?.ID || result?.id || ""), folderId }, { headers });
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/bitrix/import-interfortum-card" && request.method === "OPTIONS") return new Response(null, { status:204, headers });
    if (url.pathname === "/bitrix/import-interfortum-card/status") return Response.json({ ok:true, version:VERSION, ready:true }, { headers });
    if (url.pathname === "/bitrix/import-interfortum-card" && request.method === "POST") {
      try { return await upload(request, runtimeEnv); }
      catch (e) { return Response.json({ ok:false, version:VERSION, error:String(e?.message || e) }, { status:500, headers }); }
    }
    return currentWorker.fetch(request, runtimeEnv, ctx);
  },
  async scheduled(controller, runtimeEnv, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, runtimeEnv, ctx);
  },
};
