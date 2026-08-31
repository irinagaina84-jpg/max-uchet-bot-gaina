import { env } from "cloudflare:workers";
import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v82.js";

const VERSION = "worker-v84-final-files-only";
const ROOT_FOLDER_ID = "93";

export class MaxBotContainer extends BaseMaxBotContainer {}

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

async function findFolder(runtimeEnv, parentId, name) {
  const item = (await children(runtimeEnv, parentId)).find(x =>
    String(x?.TYPE || x?.type || "").toLowerCase() === "folder" && String(x?.NAME || x?.name || "") === name
  );
  return item ? String(item.ID || item.id || "") : "";
}

async function resolveExisting(runtimeEnv, parts) {
  let id = ROOT_FOLDER_ID;
  for (const name of parts) {
    id = await findFolder(runtimeEnv, id, name);
    if (!id) return "";
  }
  return id;
}

async function deleteExactFile(runtimeEnv, path, filename) {
  const folderId = await resolveExisting(runtimeEnv, path);
  if (!folderId) return { filename, found: false, deleted: false, reason: "folder_not_found" };
  const file = (await children(runtimeEnv, folderId)).find(x =>
    String(x?.TYPE || x?.type || "").toLowerCase() === "file" && String(x?.NAME || x?.name || "") === filename
  );
  if (!file) return { filename, found: false, deleted: false, reason: "file_not_found" };
  const fileId = String(file.ID || file.id || "");
  await bx(runtimeEnv, "disk.file.delete", { id: fileId });
  return { filename, found: true, deleted: true, fileId };
}

async function cleanupRaw(runtimeEnv) {
  const targets = [
    {
      path: ["08 ПЕРЕПИСКИ И ИСХОДНИКИ", "АМИДИ ГРУПП", "Взлёт", "2026-08"],
      filename: "2026-08-28 — выгрузка MAX за день.zip",
    },
    {
      path: ["08 ПЕРЕПИСКИ И ИСХОДНИКИ", "ИНТЕРФОРТУМ", "Настя", "2026-08"],
      filename: "MAX_Настя_29.08.2026.zip",
    },
  ];
  const results = [];
  for (const t of targets) results.push(await deleteExactFile(runtimeEnv, t.path, t.filename));
  return Response.json({ ok: true, version: VERSION, results }, { headers: { "Cache-Control": "no-store" } });
}

function rawBlocked(url, request) {
  if (url.pathname.startsWith("/bitrix/import-nastya-archive")) return true;
  if (url.pathname === "/bitrix/import-approved-3" && request.method === "POST") return "inspect";
  return false;
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/bitrix/cleanup-raw") {
      try { return await cleanupRaw(runtimeEnv); }
      catch (e) { return Response.json({ ok:false, version:VERSION, error:String(e?.message || e) }, { status:500, headers:{"Cache-Control":"no-store"} }); }
    }
    if (url.pathname === "/bitrix/final-files-only/status") {
      return Response.json({ ok:true, version:VERSION, policy:"finalized_working_files_only" }, { headers:{"Cache-Control":"no-store"} });
    }

    const blocked = rawBlocked(url, request);
    if (blocked === true) {
      return Response.json({ ok:false, error:"Raw chats, screenshots and ZIP archives are disabled for Bitrix migration" }, { status:410, headers:{"Cache-Control":"no-store"} });
    }
    if (blocked === "inspect") {
      try {
        const clone = request.clone();
        const body = await clone.json();
        const filename = String(body?.filename || "").toLowerCase();
        if (filename.endsWith(".zip") || filename.includes("выгрузка max")) {
          return Response.json({ ok:false, error:"Raw chat archives are disabled for Bitrix migration" }, { status:410, headers:{"Cache-Control":"no-store"} });
        }
      } catch {}
    }

    return currentWorker.fetch(request, runtimeEnv, ctx);
  },
  async scheduled(controller, runtimeEnv, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, runtimeEnv, ctx);
  },
};
