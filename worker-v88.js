import { env } from "cloudflare:workers";
import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v87.js";

const VERSION = "worker-v88-bitrix-final-organizer";
const ROOT = "93";
const CARD_HASH = "21ba370e5c3a78739f0bede79477b75716f75123c09ff3dcbb28a8b63f655453";
const CARD_NAME = "Карточка предприятия — ИНТЕРФОРТУМ — 31.08.2026.jpg";

export class MaxBotContainer extends BaseMaxBotContainer {}
const noCache = { "Cache-Control": "no-store" };
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS,GET",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  let last = "unknown";
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(attempt ? 450 * (attempt + 1) : 160);
    const r = await fetch(methodUrl(base, method), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(params),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && !j?.error) return j?.result;
    last = String(j?.error_description || j?.error || `HTTP ${r.status}`);
    if (!(r.status === 429 || r.status >= 500 || /limit|tempor|timeout|520/i.test(last))) break;
  }
  throw new Error(`${method}: ${last}`);
}
async function children(runtimeEnv, id) {
  const r = await bx(runtimeEnv, "disk.folder.getChildren", { id });
  return Array.isArray(r) ? r : [];
}
const iid = x => String(x?.ID || x?.id || "");
const iname = x => String(x?.NAME || x?.name || "");
const itype = x => String(x?.TYPE || x?.type || "").toLowerCase();
async function findFolder(runtimeEnv, parentId, name) {
  return (await children(runtimeEnv, parentId)).find(x => itype(x) === "folder" && iname(x) === name) || null;
}
async function ensureFolder(runtimeEnv, parentId, name) {
  const f = await findFolder(runtimeEnv, parentId, name);
  if (f) return iid(f);
  const r = await bx(runtimeEnv, "disk.folder.addSubFolder", { id: parentId, data: { NAME: name } });
  const id = String(r?.ID || r?.id || "");
  if (!id) throw new Error(`No folder id: ${name}`);
  return id;
}

async function moveLegacyFiles(runtimeEnv, folderId, report) {
  const list = await children(runtimeEnv, folderId);
  for (const x of list) {
    if (itype(x) === "folder") {
      await moveLegacyFiles(runtimeEnv, iid(x), report);
      continue;
    }
    if (itype(x) !== "file") continue;
    const name = iname(x);
    const n = name.toLowerCase();
    if (/\.(zip|jpg|jpeg|png|webp|heic)$/i.test(n) || n.includes("выгрузка max") || n.includes("переписк")) {
      report.rawLeft.push({ id: iid(x), name });
      continue;
    }
    let targetPath = null;
    if (n.includes("спецификац")) targetPath = ["01 ИНТЕРФОРТУМ", "01 ДОГОВОРЫ И СПЕЦИФИКАЦИИ", "КОНСТЭВО"];
    else if (n.includes("реестр ктк") || n.includes("20dc") || n.includes("40hc") || n.includes("поставщики, номера, оплаты") || n.includes("констэво")) targetPath = ["01 ИНТЕРФОРТУМ", "04 КОНТЕЙНЕРЫ — РЕЕСТРЫ И ВЫДАЧИ", "КОНСТЭВО"];
    else if (n.includes("заявки иф")) targetPath = ["01 ИНТЕРФОРТУМ", "08 ГОТОВЫЕ СВЕРКИ И ОТЧЕТЫ", "ОПЕРАЦИОННЫЙ УЧЕТ"];
    if (!targetPath) {
      report.unclassifiedLeft.push({ id: iid(x), name });
      continue;
    }
    let target = ROOT;
    for (const part of targetPath) target = await ensureFolder(runtimeEnv, target, part);
    await bx(runtimeEnv, "disk.file.moveTo", { id: iid(x), targetFolderId: target });
    report.movedLegacy.push({ name, to: targetPath.join("/") });
  }
}

async function deleteEmptyTree(runtimeEnv, folderId, report, depth = 0) {
  if (depth > 8) return false;
  let list = await children(runtimeEnv, folderId);
  for (const x of list) if (itype(x) === "folder") await deleteEmptyTree(runtimeEnv, iid(x), report, depth + 1);
  list = await children(runtimeEnv, folderId);
  if (list.length === 0) {
    await bx(runtimeEnv, "disk.folder.markDeleted", { id: folderId });
    report.deletedFolders.push(folderId);
    return true;
  }
  return false;
}

async function maintenance(runtimeEnv) {
  const report = { movedLegacy: [], rawLeft: [], unclassifiedLeft: [], deletedFolders: [] };
  const rootItems = await children(runtimeEnv, ROOT);
  const oldTopNames = ["01 ИНТЕРФОРТУМ — проекты и первичка", "02 АМИДИ ГРУПП — проекты и первичка"];
  for (const name of oldTopNames) {
    const f = rootItems.find(x => itype(x) === "folder" && iname(x) === name);
    if (!f) continue;
    await moveLegacyFiles(runtimeEnv, iid(f), report);
    await deleteEmptyTree(runtimeEnv, iid(f), report);
  }
  const ifFolder = await findFolder(runtimeEnv, ROOT, "01 ИНТЕРФОРТУМ");
  if (ifFolder) {
    for (const name of ["01 Констэво", "90 Общие документы ИНТЕРФОРТУМ"]) {
      const f = await findFolder(runtimeEnv, iid(ifFolder), name);
      if (!f) continue;
      await moveLegacyFiles(runtimeEnv, iid(f), report);
      await deleteEmptyTree(runtimeEnv, iid(f), report);
    }
  }
  return { ok: true, version: VERSION, ...report };
}

async function tree(runtimeEnv, folderId = ROOT, depth = 0, maxDepth = 4) {
  if (depth > maxDepth) return [];
  const out = [];
  for (const x of await children(runtimeEnv, folderId)) {
    const e = { id: iid(x), name: iname(x), type: itype(x) };
    if (e.type === "folder" && depth < maxDepth) e.children = await tree(runtimeEnv, e.id, depth + 1, maxDepth);
    out.push(e);
  }
  return out;
}

function decodeBase64(v) {
  const text = String(v || "");
  if (!text || text.length > 4 * 1024 * 1024) throw new Error("Invalid payload");
  const bin = atob(text);
  if (bin.length > 2 * 1024 * 1024) throw new Error("File too large");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function sha256(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function importCard(request, runtimeEnv) {
  const body = await request.json();
  if (String(body?.filename || "") !== CARD_NAME) return Response.json({ ok:false, error:"Wrong file name" }, { status:403, headers:cors });
  const bytes = decodeBase64(body?.base64);
  if (await sha256(bytes) !== CARD_HASH) return Response.json({ ok:false, error:"File is not approved" }, { status:403, headers:cors });
  let target = ROOT;
  for (const part of ["01 ИНТЕРФОРТУМ", "00 КАРТОЧКА И РЕКВИЗИТЫ"]) target = await ensureFolder(runtimeEnv, target, part);
  const existing = (await children(runtimeEnv, target)).find(x => itype(x) === "file" && iname(x) === CARD_NAME);
  if (existing) return Response.json({ ok:true, already:true, fileId:iid(existing), folderId:target }, { headers:cors });
  const r = await bx(runtimeEnv, "disk.folder.uploadFile", {
    id: target,
    data: { NAME: CARD_NAME },
    fileContent: [CARD_NAME, String(body.base64)],
    generateUniqueName: false,
  });
  return Response.json({ ok:true, uploaded:true, fileId:String(r?.ID || r?.id || ""), folderId:target }, { headers:cors });
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/bitrix/final-maintenance") return Response.json(await maintenance(runtimeEnv), { headers:noCache });
      if (url.pathname === "/bitrix/final-tree") return Response.json({ ok:true, version:VERSION, tree:await tree(runtimeEnv) }, { headers:noCache });
      if (url.pathname === "/bitrix/import-company-card/status") return Response.json({ ok:true, version:VERSION, ready:true }, { headers:cors });
      if (url.pathname === "/bitrix/import-company-card" && request.method === "OPTIONS") return new Response(null, { status:204, headers:cors });
      if (url.pathname === "/bitrix/import-company-card" && request.method === "POST") return await importCard(request, runtimeEnv);
    } catch (e) {
      return Response.json({ ok:false, version:VERSION, error:String(e?.message || e) }, { status:500, headers:noCache });
    }
    return currentWorker.fetch(request, runtimeEnv, ctx);
  },
  async scheduled(controller, runtimeEnv, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, runtimeEnv, ctx);
  },
};
