import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v94.js";

const VERSION = "worker-v95-bitrix-transport";
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

const ENUM_FIELDS = [
  { code: "WORK_TYPE", label: "Направление учёта", sort: 70, values: ["Контейнеры", "Перевозки"] },
  {
    code: "TRANSPORT_STATUS",
    label: "Статус перевозки",
    sort: 80,
    values: [
      "Новая заявка", "Подбор парка", "Парк подтверждён", "Машина назначена", "Погрузка",
      "В пути", "Выгружено", "Документы", "Оплата парку", "Закрыто", "Отменено",
    ],
  },
];

const TRANSPORT_FIELDS = [
  ["TRANSPORT_CUSTOMER", "string", "Перевозки — заказчик", 300],
  ["TRANSPORT_REQUEST_NO", "string", "Перевозки — № заявки", 310],
  ["TRANSPORT_REQUEST_DATE", "date", "Перевозки — дата заявки", 320],
  ["TRANSPORT_FLEET", "string", "Перевозки — парк / перевозчик", 330],
  ["TRANSPORT_ROUTE", "string", "Перевозки — маршрут", 340],
  ["TRANSPORT_LOADING", "string", "Перевозки — адрес погрузки", 350],
  ["TRANSPORT_UNLOADING", "string", "Перевозки — адрес выгрузки", 360],
  ["TRANSPORT_LOAD_DATE", "date", "Перевозки — дата погрузки", 370],
  ["TRANSPORT_UNLOAD_DATE", "date", "Перевозки — дата выгрузки", 380],
  ["TRANSPORT_VEHICLE", "string", "Перевозки — машина / госномер", 390],
  ["TRANSPORT_DRIVER", "string", "Перевозки — водитель", 400],
  ["TRANSPORT_FLEET_RATE", "double", "Перевозки — ставка парка, руб.", 410],
  ["TRANSPORT_CLIENT_RATE", "double", "Перевозки — ставка клиенту, руб.", 420],
  ["TRANSPORT_FLEET_PAID", "double", "Перевозки — оплачено парку, руб.", 430],
  ["TRANSPORT_FLEET_BALANCE", "double", "Перевозки — остаток парку, руб.", 440],
  ["TRANSPORT_DOC_STATUS", "string", "Перевозки — документы / УПД / акт", 450],
];

const INTERFORTUM_PARKS = ["ИП Справцев Леонид Васильевич", "ООО Гермес"];
const PARK_SUBFOLDERS = ["01 ЗАЯВКИ", "02 РЕЙСЫ", "03 ДОКУМЕНТЫ", "04 ОПЛАТЫ", "05 СВЕРКА"];

async function listUserFields(env) {
  const r = await bx(env, "crm.deal.userfield.list", { filter: { LANG: "ru" }, order: { SORT: "ASC" } });
  return Array.isArray(r) ? r : [];
}

async function ensureEnum(env, def, existing) {
  const name = `UF_CRM_${def.code}`;
  if (existing.some(x => String(x?.FIELD_NAME || "") === name)) return { name, created: false };
  const list = def.values.map((value, i) => ({ VALUE: value, XML_ID: `IF_${def.code}_${i + 1}`, SORT: (i + 1) * 100, DEF: i === 0 ? "Y" : "N" }));
  await bx(env, "crm.deal.userfield.add", {
    fields: {
      FIELD_NAME: def.code, USER_TYPE_ID: "enumeration", XML_ID: `IF_${def.code}`, SORT: def.sort,
      MULTIPLE: "N", MANDATORY: "N", SHOW_FILTER: "Y", SHOW_IN_LIST: "Y", EDIT_IN_LIST: "Y",
      EDIT_FORM_LABEL: def.label, LIST_COLUMN_LABEL: def.label, LIST_FILTER_LABEL: def.label,
      LIST: list, SETTINGS: { DISPLAY: "UI", LIST_HEIGHT: 1 },
    },
  });
  return { name, created: true };
}

async function ensureField(env, def, existing) {
  const [code, type, label, sort] = def;
  const name = `UF_CRM_${code}`;
  if (existing.some(x => String(x?.FIELD_NAME || "") === name)) return { name, created: false };
  await bx(env, "crm.deal.userfield.add", {
    fields: {
      FIELD_NAME: code, USER_TYPE_ID: type, XML_ID: `IF_${code}`, SORT: sort,
      MULTIPLE: "N", MANDATORY: "N", SHOW_FILTER: "Y", SHOW_IN_LIST: "Y", EDIT_IN_LIST: "Y",
      EDIT_FORM_LABEL: label, LIST_COLUMN_LABEL: label, LIST_FILTER_LABEL: label,
    },
  });
  return { name, created: true };
}

async function children(env, folderId) {
  const r = await bx(env, "disk.folder.getchildren", { id: folderId });
  return Array.isArray(r) ? r : [];
}

async function ensureFolder(env, parentId, name) {
  const items = await children(env, parentId);
  const found = items.find(x => String(x?.TYPE || x?.type || "").toLowerCase() === "folder" && String(x?.NAME || x?.name || "").trim() === name);
  if (found) return String(found.ID || found.id);
  const added = await bx(env, "disk.folder.addsubfolder", { id: parentId, data: { NAME: name } });
  const id = String(added?.ID || added?.id || "");
  if (!id) throw new Error(`Folder id missing for ${name}`);
  return id;
}

async function findRoot(env) {
  const storages = await bx(env, "disk.storage.getlist", {});
  const list = Array.isArray(storages) ? storages : [];
  const storage = list.find(s => String(s?.ENTITY_TYPE || "").toLowerCase() === "common") || list.find(s => /общ|common|company|компан/i.test(String(s?.NAME || "")));
  if (!storage) throw new Error("Common disk storage not found");
  let rootId = String(storage?.ROOT_OBJECT_ID || "");
  if (!rootId) {
    const full = await bx(env, "disk.storage.get", { id: storage.ID });
    rootId = String(full?.ROOT_OBJECT_ID || "");
  }
  if (!rootId) throw new Error("Storage root missing");
  const rootChildren = await children(env, rootId);
  const main = rootChildren.find(x => String(x?.TYPE || "").toLowerCase() === "folder" && String(x?.NAME || "").trim() === "00 УЧЕТ — ИНТЕРФОРТУМ + АМИДИ — КОНТЕЙНЕРЫ");
  if (!main) throw new Error("Main accounting folder not found");
  return String(main.ID || main.id);
}

async function ensureParkTree(env, parksFolderId, parks) {
  for (const park of parks) {
    const parkId = await ensureFolder(env, parksFolderId, park);
    for (const sub of PARK_SUBFOLDERS) await ensureFolder(env, parkId, sub);
  }
}

async function ensureTransportTree(env) {
  const root = await findRoot(env);
  const companies = ["01 ИНТЕРФОРТУМ", "02 АМИДИ ГРУПП"];
  const result = [];
  for (const company of companies) {
    const companyId = await ensureFolder(env, root, company);
    const transportId = await ensureFolder(env, companyId, "03 ПЕРЕВОЗКИ");
    const names = [
      "00 РЕЕСТР ПЕРЕВОЗОК", "01 ЗАЯВКИ", "02 ПАРКИ", "03 РЕЙСЫ",
      "04 ДОКУМЕНТЫ — АКТЫ, УПД, ТТН", "05 ОПЛАТЫ ПАРКАМ", "06 СВЕРКИ ПО ПАРКАМ", "99 АРХИВ ЗАКРЫТЫХ",
    ];
    const folders = [];
    for (const name of names) folders.push({ name, id: await ensureFolder(env, transportId, name) });
    const parksFolder = folders.find(x => x.name === "02 ПАРКИ");
    if (company === "01 ИНТЕРФОРТУМ" && parksFolder) await ensureParkTree(env, parksFolder.id, INTERFORTUM_PARKS);
    result.push({ company, transportId, folders });
  }
  return result;
}

async function ensureTransportSetup(env) {
  const existing = await listUserFields(env);
  const changes = [];
  for (const def of ENUM_FIELDS) changes.push(await ensureEnum(env, def, existing));
  const afterEnums = await listUserFields(env);
  for (const def of TRANSPORT_FIELDS) changes.push(await ensureField(env, def, afterEnums));
  const tree = await ensureTransportTree(env);
  return { ok: true, version: VERSION, fieldCount: ENUM_FIELDS.length + TRANSPORT_FIELDS.length, changes, treeCount: tree.length, parkCount: INTERFORTUM_PARKS.length };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/bitrix/health") {
      let setupOk = false;
      try { await ensureTransportSetup(env); setupOk = true; } catch { setupOk = false; }
      try {
        const response = await currentWorker.fetch(request, env, ctx);
        const payload = await response.clone().json().catch(() => null);
        return Response.json({ ok: Boolean(response.ok && payload?.ok), version: VERSION, transportConfigured: setupOk }, {
          status: response.ok ? 200 : 503, headers: { "Cache-Control": "no-store" },
        });
      } catch {
        return Response.json({ ok: false, version: VERSION, transportConfigured: setupOk }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
    }
    return currentWorker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    try { await ensureTransportSetup(env); } catch {}
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, env, ctx);
  },
};
