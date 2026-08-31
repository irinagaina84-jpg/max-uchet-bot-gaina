import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v105.js";

export class MaxBotContainer extends BaseMaxBotContainer {}

function htmlPage(title, body, ok = true) {
  const color = ok ? "#12805c" : "#b42318";
  return new Response(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f7fb;color:#172033;margin:0;padding:24px}.card{max-width:760px;margin:0 auto;background:#fff;border-radius:20px;padding:24px;box-shadow:0 10px 35px rgba(25,50,90,.12)}h1{font-size:25px;margin:0 0 12px;color:${color}}pre{white-space:pre-wrap;background:#0f172a;color:#e5edf8;border-radius:14px;padding:16px;line-height:1.45}.note{color:#667085}</style></head><body><div class="card"><h1>${title}</h1>${body}</div></body></html>`, { status: ok ? 200 : 500, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function decodeB64Utf8(s) {
  const bin = atob(String(s || ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/bitrix/crm-import-form" && request.method === "POST") {
      try {
        const form = await request.formData();
        const logs = [];
        let total = 0, created = 0, updated = 0;

        for (let i = 1; i <= 4; i++) {
          const encoded = form.get(`b${i}`);
          if (!encoded) throw new Error(`Пачка ${i} отсутствует`);
          const raw = decodeB64Utf8(encoded);
          const internalUrl = new URL(request.url);
          internalUrl.pathname = "/bitrix/crm-import-approved";
          internalUrl.search = "";
          const r = await currentWorker.fetch(new Request(internalUrl.toString(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: raw,
          }), env, ctx);
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j?.ok) throw new Error(`Пачка ${i}: ${j?.error || `HTTP ${r.status}`}`);
          total += Number(j.count || 0);
          created += Number(j.created || 0);
          updated += Number(j.updated || 0);
          logs.push(`Пачка ${i}: ${j.count || 0} записей; создано ${j.created || 0}; обновлено ${j.updated || 0}.`);
        }

        let boards = "Доски CRM: проверка отдельно.";
        try {
          const u = new URL(request.url);
          u.pathname = "/bitrix/crm-boards-run";
          u.search = "";
          const br = await currentWorker.fetch(new Request(u.toString(), { method: "GET" }), env, ctx);
          const bj = await br.json().catch(() => ({}));
          if (br.ok && bj?.ok) boards = `Доски CRM готовы. Заказов: ${bj.orderCount || 0}; платежей перенесено: ${bj.paymentsMoved || 0}.`;
          else boards = `Карточки загружены. Доски CRM: ${bj?.error || `HTTP ${br.status}`}.`;
        } catch (e) {
          boards = `Карточки загружены. Доски CRM требуют отдельной проверки.`;
        }

        logs.push(boards);
        logs.push(`Итого обработано: ${total}. Создано: ${created}. Обновлено: ${updated}.`);
        return htmlPage("Готово — CRM загружена в Bitrix24", `<p>Клиенты и поставщики обработаны.</p><pre>${logs.join("\n")}</pre><p class="note">Теперь можно открыть Bitrix24 → CRM → Компании и CRM → Сделки.</p>`, true);
      } catch (e) {
        return htmlPage("Ошибка загрузки", `<p>Загрузка не завершена.</p><pre>${String(e?.message || e).replace(/[<>]/g, "")}</pre><p class="note">Вернись в чат и пришли этот экран — я исправлю.</p>`, false);
      }
    }

    return currentWorker.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof currentWorker.scheduled === "function") return currentWorker.scheduled(controller, env, ctx);
  },
};
