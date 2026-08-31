import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v103.js";

const VERSION = "worker-v104-approved-crm-company-import";
const APPROVED_HASHES = new Set([
  "12bfdc17ce400ade16be3a5f8cdefe516394c5c8e3e7f8deb9d3e897525bd8dd",
  "3a5b9736637e318e895bee949908354f0bd821aaab8c98221a676b9f725336a9",
  "5c3c9d0844b5a05f13095cee505b887964ae1d2ec19bf4e38fe4bc6870022fef",
  "5c966481bb6017183bd99535ed88b13d1d07b206cfe2eed1ce4d2d09814fbad2",
]);

export class MaxBotContainer extends BaseMaxBotContainer {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    ...extra,
  };
}

function methodUrl(base, method) {
  const u = new URL(String(base || "").trim());
  if (u.protocol !== "https:" || !/\/rest\/\d+\/[^/]+\/?$/i.test(u.pathname)) throw new Error("Invalid Bitrix webhook");
  u.search = "";
  u.hash = "";
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  u.pathname += `${method}.json`;
  return u.toString();
}

async function bx(env, method, params = {}) {
  const base = String(env?.BITRIX_WEBHOOK_URL || "").trim();
  if (!base) throw new Error("BITRIX_WEBHOOK_URL missing");
  let last = "unknown";
  for (let i = 0; i < 5; i++) {
    if (i) await sleep(450 * i);
    const r = await fetch(methodUrl(base, method), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(params),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && !j?.error) return j?.result;
    last = String(j?.error_description || j?.error || `HTTP ${r.status}`);
    if (!(r.status === 429 || r.status >= 500 || /limit|tempor|timeout|execution/i.test(last))) break;
  }
  throw new Error(`${method}: ${last}`);
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function labelText(v) {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object") {
    for (const k of ["ru", "RU", "en", "EN"]) if (typeof v[k] === "string") return v[k].trim();
    for (const x of Object.values(v)) if (typeof x === "string" && x.trim()) return x.trim();
  }
  return "";
}

function fieldLabel(f) {
  return labelText(f?.EDIT_FORM_LABEL) || labelText(f?.LIST_COLUMN_LABEL) || labelText(f?.LIST_FILTER_LABEL);
}

function enumId(field, value) {
  const list = Array.isArray(field?.LIST) ? field.LIST : [];
  const row = list.find(x => String(x?.VALUE || "").trim() === value);
  return row?.ID ? String(row.ID) : null;
}

async function roleField(env) {
  let fields = await bx(env, "crm.company.userfield.list", { order: { SORT: "ASC" } });
  fields = Array.isArray(fields) ? fields : [];
  let field = fields.find(f => fieldLabel(f) === "Роль контрагента");
  if (!field) {
    await bx(env, "crm.company.userfield.add", { fields: {
      FIELD_NAME: "CPROLE",
      USER_TYPE_ID: "enumeration",
      XML_ID: "IF_CPROLE",
      SORT: 100,
      MULTIPLE: "N",
      MANDATORY: "N",
      SHOW_FILTER: "Y",
      SHOW_IN_LIST: "Y",
      EDIT_IN_LIST: "Y",
      EDIT_FORM_LABEL: "Роль контрагента",
      LIST_COLUMN_LABEL: "Роль контрагента",
      LIST_FILTER_LABEL: "Роль контрагента",
      LIST: ["Поставщик", "Перевозчик", "Клиент", "Прочее"].map((v, i) => ({
        VALUE: v, XML_ID: `IF_CPROLE_${i+1}`, SORT: (i+1) * 100, DEF: "N"
      })),
      SETTINGS: { DISPLAY: "UI", LIST_HEIGHT: 4 },
    }});
    fields = await bx(env, "crm.company.userfield.list", { order: { SORT: "ASC" } });
    fields = Array.isArray(fields) ? fields : [];
    field = fields.find(f => fieldLabel(f) === "Роль контрагента");
  }
  if (!field?.FIELD_NAME) throw new Error("Role field unavailable");
  const clientId = enumId(field, "Клиент");
  const supplierId = enumId(field, "Поставщик");
  if (!clientId || !supplierId) throw new Error("Role enum values unavailable");
  return { name: String(field.FIELD_NAME), clientId, supplierId };
}

function norm(s) {
  return String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[«»\"]/g, "")
    .replace(/\s+/g, " ");
}

async function allCompanies(env) {
  const out = [];
  for (let start = 0; start < 5000; start += 50) {
    const page = await bx(env, "crm.company.list", {
      order: { ID: "ASC" },
      filter: {},
      select: ["ID", "TITLE"],
      start,
    });
    const rows = Array.isArray(page) ? page : [];
    out.push(...rows);
    if (rows.length < 50) break;
  }
  return out;
}

function command(method, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, String(v));
  }
  return `${method}?${q.toString()}`;
}

async function runBatch(env, cmds) {
  if (!cmds.length) return { ok: 0, errors: 0 };
  const result = await bx(env, "batch", { halt: 0, cmd: cmds });
  const errors = result?.result_error && typeof result.result_error === "object" ? Object.keys(result.result_error) : [];
  if (errors.length) {
    const first = errors[0];
    const e = result.result_error[first] || {};
    throw new Error(`Bitrix batch ${first}: ${String(e.error_description || e.error || "unknown").slice(0, 180)}`);
  }
  const ok = result?.result && typeof result.result === "object" ? Object.keys(result.result).length : cmds.length;
  return { ok, errors: 0 };
}

async function importCompanies(env, companies) {
  const role = await roleField(env);
  const existing = await allCompanies(env);
  const byTitle = new Map();
  for (const row of existing) {
    const key = norm(row?.TITLE);
    if (key && !byTitle.has(key)) byTitle.set(key, String(row.ID));
  }

  const commands = {};
  let created = 0;
  let updated = 0;
  let index = 0;
  for (const item of companies) {
    const title = String(item?.title || "").trim();
    const roleName = String(item?.role || "").trim();
    const note = String(item?.note || "").trim();
    if (!title || title.length > 250) throw new Error("Invalid company title");
    if (!['Клиент', 'Поставщик'].includes(roleName)) throw new Error("Invalid company role");
    if (note.length > 4000) throw new Error("Company note too long");
    const roleId = roleName === "Клиент" ? role.clientId : role.supplierId;
    const id = byTitle.get(norm(title));
    const p = {
      "fields[TITLE]": title,
      "fields[COMMENTS]": note,
      [`fields[${role.name}]`]: roleId,
      "params[REGISTER_SONET_EVENT]": "N",
    };
    if (id) {
      commands[`u${index++}`] = command("crm.company.update", { id, ...p });
      updated++;
    } else {
      commands[`a${index++}`] = command("crm.company.add", p);
      created++;
    }
  }

  const entries = Object.entries(commands);
  let applied = 0;
  for (let i = 0; i < entries.length; i += 50) {
    const chunk = Object.fromEntries(entries.slice(i, i + 50));
    const r = await runBatch(env, chunk);
    applied += r.ok;
    if (i + 50 < entries.length) await sleep(400);
  }
  return { created, updated, applied };
}

function validatePayload(payload) {
  if (!payload || Number(payload.version) !== 1) throw new Error("Invalid payload version");
  if (!Number.isInteger(Number(payload.batch)) || Number(payload.batch) < 1 || Number(payload.batch) > 4) throw new Error("Invalid batch number");
  if (!Array.isArray(payload.companies) || payload.companies.length < 1 || payload.companies.length > 35) throw new Error("Invalid companies batch");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname === "/bitrix/crm-import-approved") {
      return new Response(null, { status: 204, headers: cors() });
    }

    if (url.pathname === "/bitrix/crm-import-status" && request.method === "GET") {
      return Response.json({ ok: true, version: VERSION, approvedBatches: APPROVED_HASHES.size }, { headers: cors() });
    }

    if (url.pathname === "/bitrix/crm-import-approved" && request.method === "POST") {
      try {
        const raw = await request.text();
        if (!raw || raw.length > 180000) throw new Error("Payload too large or empty");
        const hash = await sha256Hex(raw);
        if (!APPROVED_HASHES.has(hash)) {
          return Response.json({ ok: false, version: VERSION, error: "Payload is not approved" }, { status: 403, headers: cors() });
        }
        const payload = JSON.parse(raw);
        validatePayload(payload);
        const result = await importCompanies(env, payload.companies);
        return Response.json({ ok: true, version: VERSION, batch: Number(payload.batch), count: payload.companies.length, ...result }, { headers: cors() });
      } catch (e) {
        return Response.json({ ok: false, version: VERSION, error: String(e?.message || e).slice(0, 360) }, { status: 503, headers: cors() });
      }
    }

    return currentWorker.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, env, ctx);
  },
};
