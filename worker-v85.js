import { env } from "cloudflare:workers";
import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v84.js";

const VERSION = "worker-v85-bitrix-clean-structure";
const ROOT_FOLDER_ID = "93";

export class MaxBotContainer extends BaseMaxBotContainer {}

function webhook(runtimeEnv) {
  return String(runtimeEnv?.BITRIX_WEBHOOK_URL || env.BITRIX_WEBHOOK_URL || "").trim();
}

function methodUrl(base, method) {
  const u = new URL(base);
  if (u.protocol !== "https:" || !/\/rest\/\d+\/[^/]+\/?$/i.test(u.pathname)) throw new Error("Invalid Bitrix webhook");
  u.search = "";
  u.hash = "";
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

function itemId(x) { return String(x?.ID || x?.id || ""); }
function itemName(x) { return String(x?.NAME || x?.name || ""); }
function itemType(x) { return String(x?.TYPE || x?.type || "").toLowerCase(); }

async function findFolder(runtimeEnv, parentId, name) {
  return (await children(runtimeEnv, parentId)).find(x => itemType(x) === "folder" && itemName(x) === name) || null;
}

async function ensureFolder(runtimeEnv, parentId, name) {
  const found = await findFolder(runtimeEnv, parentId, name);
  if (found) return { id: itemId(found), name, created: false };
  const created = await bx(runtimeEnv, "disk.folder.addsubfolder", { id: parentId, data: { NAME: name } });
  const id = String(created?.ID || created?.id || "");
  if (!id) throw new Error(`Folder id missing for ${name}`);
  return { id, name, created: true };
}

async function renameTopFolderIfNeeded(runtimeEnv, oldName, newName) {
  const old = await findFolder(runtimeEnv, ROOT_FOLDER_ID, oldName);
  const current = await findFolder(runtimeEnv, ROOT_FOLDER_ID, newName);
  if (current) return { id: itemId(current), renamed: false };
  if (old) {
    const id = itemId(old);
    await bx(runtimeEnv, "disk.folder.rename", { id, newName });
    return { id, renamed: true };
  }
  const made = await ensureFolder(runtimeEnv, ROOT_FOLDER_ID, newName);
  return { id: made.id, renamed: false };
}

const SECTION_NAMES = [
  "00 КАРТОЧКА И РЕКВИЗИТЫ",
  "01 ДОГОВОРЫ И СПЕЦИФИКАЦИИ",
  "02 СЧЕТА, УПД И ЗАКРЫВАЮЩИЕ",
  "03 ПОСТАВЩИКИ И ЗАКУПКИ",
  "04 КОНТЕЙНЕРЫ — РЕЕСТРЫ И ВЫДАЧИ",
  "05 БАНК И ПЛАТЕЖИ",
  "06 ПОДОТЧЕТ И КОМАНДИРОВКИ",
  "07 115-ФЗ И ЗАПРОСЫ БАНКОВ",
  "08 ГОТОВЫЕ СВЕРКИ И ОТЧЕТЫ",
  "99 АРХИВ ГОТОВЫХ ДОКУМЕНТОВ",
];

async function buildCompany(runtimeEnv, companyId) {
  const sections = {};
  for (const name of SECTION_NAMES) sections[name] = await ensureFolder(runtimeEnv, companyId, name);
  return sections;
}

async function ensureSub(runtimeEnv, section, name) {
  return ensureFolder(runtimeEnv, section.id, name);
}

async function collectFiles(runtimeEnv, folderId, path = [], depth = 0, out = []) {
  if (depth > 8) return out;
  for (const x of await children(runtimeEnv, folderId)) {
    const id = itemId(x), name = itemName(x), type = itemType(x);
    if (type === "file") out.push({ id, name, path, parentId: folderId });
    else if (type === "folder") await collectFiles(runtimeEnv, id, [...path, name], depth + 1, out);
  }
  return out;
}

function isRaw(name) {
  const n = name.toLowerCase();
  return /\.(zip|jpg|jpeg|png|webp|heic)$/i.test(n) || n.includes("выгрузка max") || n.includes("переписк");
}

function classify(file) {
  const n = file.name.toLowerCase();
  const p = file.path.join(" /").toLowerCase();
  if (isRaw(file.name)) return { action: "ignore", reason: "raw" };

  if (n === "заявки иф.xlsx" || n.includes("заявки иф")) {
    return { company: "IF", section: "08 ГОТОВЫЕ СВЕРКИ И ОТЧЕТЫ", sub: "ОПЕРАЦИОННЫЙ УЧЕТ" };
  }
  if (n.includes("спецификац")) {
    return { company: "IF", section: "01 ДОГОВОРЫ И СПЕЦИФИКАЦИИ", sub: "КОНСТЭВО" };
  }
  if (n.includes("реестр ктк") || n.includes("20dc") || n.includes("40hc") || n.includes("поставщики, номера, оплаты") || (n.includes("констэво") && n.endsWith(".xlsx"))) {
    return { company: "IF", section: "04 КОНТЕЙНЕРЫ — РЕЕСТРЫ И ВЫДАЧИ", sub: "КОНСТЭВО" };
  }
  if (n.includes("расходы — поездки") || n.includes("поездки, наличные и переводы") || p.includes("амиди групп /2026-08")) {
    return { company: "AMIDI", section: "06 ПОДОТЧЕТ И КОМАНДИРОВКИ", sub: "2026-08" };
  }
  if (n.includes("115-фз") || n.includes("115 фз") || n.includes("пояснен") && n.includes("банк")) {
    return { company: p.includes("амиди") ? "AMIDI" : "IF", section: "07 115-ФЗ И ЗАПРОСЫ БАНКОВ" };
  }
  if (n.includes("выписка") || n.includes("платеж") || n.includes("платёж")) {
    return { company: p.includes("амиди") ? "AMIDI" : "IF", section: "05 БАНК И ПЛАТЕЖИ" };
  }
  if (n.includes("упд") || n.includes("счет-фактур") || n.includes("счёт-фактур") || n.includes("акт ")) {
    return { company: p.includes("амиди") ? "AMIDI" : "IF", section: "02 СЧЕТА, УПД И ЗАКРЫВАЮЩИЕ" };
  }
  if (n.includes("сверк") || n.includes("итог") || n.includes("реестр") && !n.includes("ктк")) {
    return { company: p.includes("амиди") ? "AMIDI" : "IF", section: "08 ГОТОВЫЕ СВЕРКИ И ОТЧЕТЫ" };
  }
  return { action: "unclassified" };
}

async function moveFile(runtimeEnv, fileId, targetFolderId) {
  await bx(runtimeEnv, "disk.file.moveto", { id: fileId, targetFolderId });
}

async function markEmptyLegacy(runtimeEnv, folderId, protectedIds, result, depth = 0) {
  if (depth > 10 || protectedIds.has(String(folderId))) return false;
  let items = await children(runtimeEnv, folderId);
  for (const x of items) {
    if (itemType(x) === "folder") await markEmptyLegacy(runtimeEnv, itemId(x), protectedIds, result, depth + 1);
  }
  items = await children(runtimeEnv, folderId);
  if (items.length === 0 && !protectedIds.has(String(folderId))) {
    await bx(runtimeEnv, "disk.folder.markdeleted", { id: folderId });
    result.push(String(folderId));
    return true;
  }
  return false;
}

async function compactTree(runtimeEnv, folderId, depth = 0, maxDepth = 4) {
  if (depth > maxDepth) return [];
  const out = [];
  for (const x of await children(runtimeEnv, folderId)) {
    const entry = { id: itemId(x), name: itemName(x), type: itemType(x) };
    if (entry.type === "folder" && depth < maxDepth) entry.children = await compactTree(runtimeEnv, entry.id, depth + 1, maxDepth);
    out.push(entry);
  }
  return out;
}

async function rebuild(runtimeEnv) {
  const ifTop = await renameTopFolderIfNeeded(runtimeEnv, "01 ИНТЕРФОРТУМ — проекты и первичка", "01 ИНТЕРФОРТУМ");
  const amidiTop = await renameTopFolderIfNeeded(runtimeEnv, "02 АМИДИ ГРУПП — проекты и первичка", "02 АМИДИ ГРУПП");
  const summary = await ensureFolder(runtimeEnv, ROOT_FOLDER_ID, "00 РАБОЧАЯ СВОДНАЯ");
  const ifSections = await buildCompany(runtimeEnv, ifTop.id);
  const amidiSections = await buildCompany(runtimeEnv, amidiTop.id);

  const protectedIds = new Set([ROOT_FOLDER_ID, summary.id, ifTop.id, amidiTop.id]);
  for (const s of Object.values(ifSections)) protectedIds.add(s.id);
  for (const s of Object.values(amidiSections)) protectedIds.add(s.id);

  const ifKonstevoSpec = await ensureSub(runtimeEnv, ifSections["01 ДОГОВОРЫ И СПЕЦИФИКАЦИИ"], "КОНСТЭВО");
  const ifKonstevoKtk = await ensureSub(runtimeEnv, ifSections["04 КОНТЕЙНЕРЫ — РЕЕСТРЫ И ВЫДАЧИ"], "КОНСТЭВО");
  const ifOps = await ensureSub(runtimeEnv, ifSections["08 ГОТОВЫЕ СВЕРКИ И ОТЧЕТЫ"], "ОПЕРАЦИОННЫЙ УЧЕТ");
  const amidiAug = await ensureSub(runtimeEnv, amidiSections["06 ПОДОТЧЕТ И КОМАНДИРОВКИ"], "2026-08");
  [ifKonstevoSpec, ifKonstevoKtk, ifOps, amidiAug].forEach(s => protectedIds.add(s.id));

  const all = await collectFiles(runtimeEnv, ROOT_FOLDER_ID);
  const moved = [], ignoredRaw = [], unclassified = [];
  for (const f of all) {
    const c = classify(f);
    if (c.action === "ignore") { ignoredRaw.push({ name: f.name, path: f.path }); continue; }
    if (c.action === "unclassified") { unclassified.push({ name: f.name, path: f.path }); continue; }
    const sections = c.company === "AMIDI" ? amidiSections : ifSections;
    let target = sections[c.section];
    if (c.sub) target = await ensureSub(runtimeEnv, target, c.sub);
    protectedIds.add(target.id);
    if (String(f.parentId) !== String(target.id)) {
      await moveFile(runtimeEnv, f.id, target.id);
      moved.push({ name: f.name, to: `${c.company}/${c.section}${c.sub ? `/${c.sub}` : ""}` });
    }
  }

  const legacyTopNames = [
    "03 ПОСТАВЩИКИ — закупки, оплаты, сверки",
    "04 КОНТЕЙНЕРЫ — реестры, выдачи, остатки",
    "05 БАНК — выписки и платежи",
    "06 ПОДОТЧЕТ И КОМАНДИРОВКИ",
    "07 ЗАПРОСЫ БАНКОВ — 115-ФЗ",
    "08 ПЕРЕПИСКИ И ИСХОДНИКИ",
    "99 РАЗОБРАТЬ",
  ];
  const trashedEmptyFolders = [];
  for (const name of legacyTopNames) {
    const f = await findFolder(runtimeEnv, ROOT_FOLDER_ID, name);
    if (f) await markEmptyLegacy(runtimeEnv, itemId(f), protectedIds, trashedEmptyFolders);
  }
  await markEmptyLegacy(runtimeEnv, ifTop.id, protectedIds, trashedEmptyFolders);
  await markEmptyLegacy(runtimeEnv, amidiTop.id, protectedIds, trashedEmptyFolders);

  return {
    ok: true,
    version: VERSION,
    policy: "finalized_working_files_only",
    moved,
    ignoredRaw,
    unclassified,
    trashedEmptyFolders,
    tree: await compactTree(runtimeEnv, ROOT_FOLDER_ID, 0, 3),
  };
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/bitrix/rebuild-structure") {
      try {
        return Response.json(await rebuild(runtimeEnv), { headers: { "Cache-Control": "no-store" } });
      } catch (e) {
        return Response.json({ ok: false, version: VERSION, error: String(e?.message || e) }, { status: 500, headers: { "Cache-Control": "no-store" } });
      }
    }
    if (url.pathname === "/bitrix/structure") {
      try {
        return Response.json({ ok: true, version: VERSION, tree: await compactTree(runtimeEnv, ROOT_FOLDER_ID, 0, 4) }, { headers: { "Cache-Control": "no-store" } });
      } catch (e) {
        return Response.json({ ok: false, version: VERSION, error: String(e?.message || e) }, { status: 500, headers: { "Cache-Control": "no-store" } });
      }
    }
    return currentWorker.fetch(request, runtimeEnv, ctx);
  },
  async scheduled(controller, runtimeEnv, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, runtimeEnv, ctx);
  },
};
