import { env } from "cloudflare:workers";
import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v78.js";

const VERSION = "worker-v79-bitrix-folders";
const FOLDERS = [
  "00 РАБОЧАЯ СВОДНАЯ",
  "01 ИНТЕРФОРТУМ — проекты и первичка",
  "02 АМИДИ ГРУПП — проекты и первичка",
  "03 ПОСТАВЩИКИ — закупки, оплаты, сверки",
  "04 КОНТЕЙНЕРЫ — реестры, выдачи, остатки",
  "05 БАНК — выписки и платежи",
  "06 ПОДОТЧЕТ И КОМАНДИРОВКИ",
  "07 ЗАПРОСЫ БАНКОВ — 115-ФЗ",
  "08 ПЕРЕПИСКИ И ИСХОДНИКИ",
  "99 РАЗОБРАТЬ",
];

export class MaxBotContainer extends BaseMaxBotContainer {}

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
  const body = new URLSearchParams();
  const append = (prefix, value) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => append(`${prefix}[${index}]`, item));
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => append(`${prefix}[${key}]`, item));
      return;
    }
    if (value !== undefined && value !== null) body.append(prefix, String(value));
  };
  Object.entries(params).forEach(([key, value]) => append(key, value));
  const response = await fetch(methodUrl(base, method), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    throw new Error(String(payload?.error_description || payload?.error || `HTTP ${response.status}`));
  }
  return payload?.result;
}

function storageSummary(item) {
  return {
    id: String(item?.ID || item?.id || ""),
    name: String(item?.NAME || item?.name || ""),
    entityType: String(item?.ENTITY_TYPE || item?.entityType || ""),
    entityId: String(item?.ENTITY_ID || item?.entityId || ""),
    rootObjectId: String(item?.ROOT_OBJECT_ID || item?.rootObjectId || ""),
  };
}

async function getStorages(runtimeEnv) {
  const result = await bx(runtimeEnv, "disk.storage.getlist", {});
  return (Array.isArray(result) ? result : []).map(storageSummary);
}

function chooseCompanyStorage(storages) {
  const normalized = storages.map((s) => ({ ...s, n: `${s.name} ${s.entityType}`.toLowerCase() }));
  return normalized.find((s) => s.entityType.toLowerCase() === "common")
    || normalized.find((s) => /общ|company|common|компан/.test(s.n))
    || null;
}

async function folderChildren(runtimeEnv, folderId) {
  const result = await bx(runtimeEnv, "disk.folder.getchildren", { id: folderId });
  return Array.isArray(result) ? result : [];
}

async function ensureFolder(runtimeEnv, parentId, name) {
  const children = await folderChildren(runtimeEnv, parentId);
  const found = children.find((item) => String(item?.TYPE || item?.type || "").toLowerCase() === "folder"
    && String(item?.NAME || item?.name || "").trim() === name);
  if (found) return { id: String(found.ID || found.id), name, created: false };
  const created = await bx(runtimeEnv, "disk.folder.addsubfolder", { id: parentId, data: { NAME: name } });
  return { id: String(created?.ID || created?.id || ""), name, created: true };
}

async function bootstrap(runtimeEnv) {
  const storages = await getStorages(runtimeEnv);
  const storage = chooseCompanyStorage(storages);
  if (!storage) {
    return Response.json({ ok: false, version: VERSION, error: "Company/common Bitrix Disk storage not found", storages }, {
      status: 409,
      headers: { "Cache-Control": "no-store" },
    });
  }
  let rootId = storage.rootObjectId;
  if (!rootId) {
    const full = await bx(runtimeEnv, "disk.storage.get", { id: storage.id });
    rootId = String(full?.ROOT_OBJECT_ID || full?.rootObjectId || "");
  }
  if (!rootId) throw new Error("Bitrix storage root folder not found");

  const top = await ensureFolder(runtimeEnv, rootId, "00 УЧЕТ — ИНТЕРФОРТУМ + АМИДИ — КОНТЕЙНЕРЫ");
  const folders = [];
  for (const name of FOLDERS) folders.push(await ensureFolder(runtimeEnv, top.id, name));

  return Response.json({
    ok: true,
    version: VERSION,
    storage: { id: storage.id, name: storage.name, entityType: storage.entityType },
    root: top,
    folders,
  }, { headers: { "Cache-Control": "no-store" } });
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/bitrix/storages") {
      try {
        return Response.json({ ok: true, version: VERSION, storages: await getStorages(runtimeEnv) }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        return Response.json({ ok: false, version: VERSION, error: String(error?.message || error) }, { status: 500 });
      }
    }
    if (url.pathname === "/bitrix/bootstrap") {
      try { return await bootstrap(runtimeEnv); }
      catch (error) {
        return Response.json({ ok: false, version: VERSION, error: String(error?.message || error) }, { status: 500, headers: { "Cache-Control": "no-store" } });
      }
    }
    return currentWorker.fetch(request, runtimeEnv, ctx);
  },
  async scheduled(controller, runtimeEnv, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, runtimeEnv, ctx);
    return undefined;
  },
};
