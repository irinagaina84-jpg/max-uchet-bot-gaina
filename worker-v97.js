import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v96.js";

const VERSION = "worker-v97-bitrix-transport-import";
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class MaxBotContainer extends BaseMaxBotContainer {}

function methodUrl(base, method) {
  const u = new URL(String(base || "").trim());
  if (u.protocol !== "https:" || !/\/rest\/\d+\/[^/]+\/?$/i.test(u.pathname)) throw new Error("Invalid Bitrix webhook");
  u.search = ""; u.hash = "";
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  u.pathname += `${method}.json`;
  return u.toString();
}

async function bx(env, method, params = {}) {
  const base = String(env?.BITRIX_WEBHOOK_URL || "").trim();
  if (!base) throw new Error("BITRIX_WEBHOOK_URL missing");
  let last = "unknown";
  for (let i = 0; i < 5; i++) {
    if (i) await sleep(650 * i);
    const r = await fetch(methodUrl(base, method), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(params),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && !j?.error) return j?.result;
    last = String(j?.error_description || j?.error || `HTTP ${r.status}`);
    if (!(r.status === 429 || r.status >= 500 || /limit|tempor|timeout|520|execution/i.test(last))) break;
  }
  throw new Error(`${method}: ${last}`);
}

const APPS = [
  {
    no: "215",
    date: "2026-06-19",
    title: "Перевозка №215 — Таксимо — ГОК Западный — Справцев",
    customer: "ООО Интерфортум",
    fleet: "ИП Справцев Леонид Васильевич",
    route: "Таксимо — ГОК Западный",
    vehicle: "Т477УС196",
    driver: "Справцев Леонид Васильевич",
    clientRate: 195000,
    loadDate: "2026-07-17",
    unloadDate: "2026-07-20",
    containerType: "40 HC",
    qty: 1,
    sourceStatus: "В работе",
    note: "Статус в исходном реестре: В работе. Стройматериалы. Фото контейнера + пломба.",
  },
  {
    no: "252",
    date: "2026-06-05",
    title: "Перевозка №252 — Таксимо — ГОК Западный — Гермес",
    customer: "ООО Интерфортум",
    fleet: "ООО Гермес",
    route: "Таксимо — ГОК Западный",
    vehicle: "Х780КР138",
    driver: "Бадаев Александр Сергеевич",
    clientRate: 240000,
    loadDate: "2026-07-25",
    unloadDate: "2026-07-30",
    containerType: "40 HC",
    qty: 1,
    sourceStatus: "В работе",
    note: "Статус в исходном реестре: В работе. Стройматериалы. Фото контейнера + пломба.",
  },
];

async function enumValueId(env, fieldName, wanted) {
  const fields = await bx(env, "crm.deal.userfield.list", { filter: { FIELD_NAME: fieldName, LANG: "ru" } });
  const field = Array.isArray(fields) ? fields[0] : null;
  const list = Array.isArray(field?.LIST) ? field.LIST : [];
  const found = list.find(x => String(x?.VALUE || "").trim() === wanted);
  return found?.ID ? String(found.ID) : null;
}

async function findExisting(env, app) {
  try {
    const list = await bx(env, "crm.deal.list", {
      order: { ID: "ASC" },
      filter: { "=UF_CRM_TRANSPORT_REQUEST_NO": app.no },
      select: ["ID", "TITLE", "UF_CRM_TRANSPORT_REQUEST_NO"],
      start: 0,
    });
    if (Array.isArray(list) && list.length) return list[0];
  } catch {}
  const list = await bx(env, "crm.deal.list", {
    order: { ID: "ASC" },
    filter: { "=TITLE": app.title },
    select: ["ID", "TITLE"],
    start: 0,
  });
  return Array.isArray(list) && list.length ? list[0] : null;
}

async function ensureDeal(env, app) {
  const existing = await findExisting(env, app);
  if (existing?.ID) return { no: app.no, id: existing.ID, created: false };

  const workType = await enumValueId(env, "UF_CRM_WORK_TYPE", "Перевозки");
  const fields = {
    TITLE: app.title,
    UF_CRM_LEGAL_ENTITY: "ИНТЕРФОРТУМ",
    UF_CRM_TRANSPORT_CUSTOMER: app.customer,
    UF_CRM_TRANSPORT_REQUEST_NO: app.no,
    UF_CRM_TRANSPORT_REQUEST_DATE: app.date,
    UF_CRM_TRANSPORT_FLEET: app.fleet,
    UF_CRM_TRANSPORT_ROUTE: app.route,
    UF_CRM_TRANSPORT_VEHICLE: app.vehicle,
    UF_CRM_TRANSPORT_DRIVER: app.driver,
    UF_CRM_TRANSPORT_CLIENT_RATE: app.clientRate,
    UF_CRM_TRANSPORT_LOAD_DATE: app.loadDate,
    UF_CRM_TRANSPORT_UNLOAD_DATE: app.unloadDate,
    UF_CRM_CONTAINER_TYPE: app.containerType,
    UF_CRM_CONTAINER_QTY: app.qty,
    COMMENTS: app.note,
  };
  if (workType) fields.UF_CRM_WORK_TYPE = workType;
  const id = await bx(env, "crm.deal.add", { fields, params: { REGISTER_SONET_EVENT: "N" } });
  return { no: app.no, id, created: true };
}

async function children(env, folderId) {
  const r = await bx(env, "disk.folder.getchildren", { id: folderId });
  return Array.isArray(r) ? r : [];
}
async function findFolder(env, parentId, name) {
  const items = await children(env, parentId);
  const found = items.find(x => String(x?.TYPE || x?.type || "").toLowerCase() === "folder" && String(x?.NAME || x?.name || "").trim() === name);
  return found ? String(found.ID || found.id) : null;
}
async function ensureFolder(env, parentId, name) {
  const existing = await findFolder(env, parentId, name);
  if (existing) return existing;
  const added = await bx(env, "disk.folder.addsubfolder", { id: parentId, data: { NAME: name } });
  return String(added?.ID || added?.id || "");
}
async function mainAccountingRoot(env) {
  const storages = await bx(env, "disk.storage.getlist", {});
  const list = Array.isArray(storages) ? storages : [];
  const storage = list.find(s => String(s?.ENTITY_TYPE || "").toLowerCase() === "common") || list.find(s => /общ|common|company|компан/i.test(String(s?.NAME || "")));
  if (!storage) throw new Error("Common storage missing");
  let rootId = String(storage?.ROOT_OBJECT_ID || "");
  if (!rootId) {
    const full = await bx(env, "disk.storage.get", { id: storage.ID });
    rootId = String(full?.ROOT_OBJECT_ID || "");
  }
  const main = await findFolder(env, rootId, "00 УЧЕТ — ИНТЕРФОРТУМ + АМИДИ — КОНТЕЙНЕРЫ");
  if (!main) throw new Error("Accounting root missing");
  return main;
}
async function ensureAppFolder(env, app) {
  const root = await mainAccountingRoot(env);
  const company = await ensureFolder(env, root, "01 ИНТЕРФОРТУМ");
  const transport = await ensureFolder(env, company, "03 ПЕРЕВОЗКИ");
  const parks = await ensureFolder(env, transport, "02 ПАРКИ");
  const park = await ensureFolder(env, parks, app.fleet);
  const applications = await ensureFolder(env, park, "01 ЗАЯВКИ");
  return ensureFolder(env, applications, `${app.no} — ${app.route}`);
}

async function importApps(env) {
  const deals = [];
  const folders = [];
  for (const app of APPS) {
    deals.push(await ensureDeal(env, app));
    folders.push({ no: app.no, folderId: await ensureAppFolder(env, app) });
  }
  return { ok: true, version: VERSION, deals, folders };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/bitrix/health") {
      let imported = false;
      try { const r = await importApps(env); imported = r.ok; } catch { imported = false; }
      try {
        const response = await currentWorker.fetch(request, env, ctx);
        const payload = await response.clone().json().catch(() => null);
        return Response.json({ ok: Boolean(response.ok && payload?.ok), version: VERSION, transportImported: imported }, {
          status: response.ok ? 200 : 503,
          headers: { "Cache-Control": "no-store" },
        });
      } catch {
        return Response.json({ ok: false, version: VERSION, transportImported: imported }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
    }
    return currentWorker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    try { await importApps(env); } catch {}
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, env, ctx);
  },
};
