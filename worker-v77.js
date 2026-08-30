import { env } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import currentWorker, { MaxBotContainer as BaseMaxBotContainer } from "./worker-v72.js";

const MAIL_CONTAINER_INSTANCE = "mail-index-v86";
const encoder = new TextEncoder();

export class MaxBotContainer extends BaseMaxBotContainer {
  sleepAfter = "2h";
  envVars = {
    ...this.envVars,
    MAILRU_LOGIN: env.MAILRU_LOGIN || "",
    MAILRU_APP_PASSWORD: env.MAILRU_APP_PASSWORD || "",
    MAILRU_LOOKBACK_DAYS: env.MAILRU_LOOKBACK_DAYS || "400",
  };
}

function hasValue(value) {
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

function mailBindingNames(source) {
  try {
    return Object.keys(source || {})
      .filter((key) => /mail/i.test(String(key)))
      .sort();
  } catch {
    return [];
  }
}

function mailQueryParam(url, name) {
  const direct = url.searchParams.get(name);
  if (direct != null && direct !== "") return direct;

  const escaped = url.searchParams.get(`amp;${name}`);
  if (escaped != null && escaped !== "") return escaped;

  const repaired = String(url.search || "")
    .replace(/&amp;/gi, "&")
    .replace(/%26amp%3B/gi, "&")
    .replace(/^\?/, "");
  return new URLSearchParams(repaired).get(name) || "";
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value || "")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorizedMailRequest(request, runtimeEnv) {
  const url = new URL(request.url);
  const token = String(runtimeEnv?.MAX_BOT_TOKEN || "");
  if (!token) return { error: new Response("MAX_BOT_TOKEN is not configured", { status: 503 }) };
  const expected = (await sha256Hex(token)).slice(0, 32);
  if (mailQueryParam(url, "t") !== expected) return { error: new Response("Forbidden", { status: 403 }) };
  return { url };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMailIndexContainer(runtimeEnv, month, format, timeoutMs = 4500) {
  const container = getContainer(runtimeEnv.MAX_BOT_CONTAINER, MAIL_CONTAINER_INSTANCE);
  const request = new Request(
    "http://container/mail/index?month=" + encodeURIComponent(month) + "&format=" + encodeURIComponent(format),
    { method: "GET" }
  );
  const result = await Promise.race([
    container.fetch(request).then((response) => ({ response })),
    delay(timeoutMs).then(() => ({ timeout: true })),
  ]);
  return result;
}

async function kickMailIndex(runtimeEnv, month, format) {
  try {
    const container = getContainer(runtimeEnv.MAX_BOT_CONTAINER, MAIL_CONTAINER_INSTANCE);
    const response = await container.fetch(new Request(
      "http://container/mail/index?month=" + encodeURIComponent(month) + "&format=" + encodeURIComponent(format),
      { method: "GET" }
    ));
    try { await response.arrayBuffer(); } catch {}
  } catch (error) {
    console.error("mail index kickoff failed", month, error?.message || error);
  }
}

function mailLoadingPage(month, format) {
  const label = format === "csv" ? "CSV" : "JSON";
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Mail.ru — ${month}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f6f7f9;color:#111}
.wrap{max-width:560px;margin:0 auto;padding:32px 20px}
.card{background:#fff;border-radius:18px;padding:24px;box-shadow:0 2px 14px rgba(0,0,0,.06)}
h2{font-size:23px;margin:0 0 12px}p{font-size:17px;line-height:1.45;margin:10px 0}.muted{color:#6b7280}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#2563eb;margin-right:8px;animation:pulse 1.2s infinite}@keyframes pulse{50%{opacity:.25}}button{font-size:16px;padding:12px 16px;border:0;border-radius:12px;background:#111;color:#fff;margin-top:12px}
</style>
</head>
<body><div class="wrap"><div class="card">
<h2><span class="dot"></span>Mail.ru: ${month}</h2>
<p id="status">Готовлю ${label}-файл. Страница не зависла.</p>
<p class="muted">Месяцы обрабатываются по одному. Проверяю готовность автоматически.</p>
<button id="retry" type="button">Проверить сейчас</button>
</div></div>
<script>
(() => {
  const status = document.getElementById('status');
  const retry = document.getElementById('retry');
  let busy = false;
  let finished = false;
  const checkUrl = new URL(location.href);
  checkUrl.searchParams.set('mode','check');
  async function check() {
    if (busy || finished) return;
    busy = true;
    status.textContent = 'Проверяю готовность…';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const r = await fetch(checkUrl.toString(), { cache:'no-store', signal:controller.signal });
      if (r.status === 200) {
        const blob = await r.blob();
        const cd = r.headers.get('content-disposition') || '';
        const m = cd.match(/filename="?([^";]+)"?/i);
        const filename = m ? m[1] : 'mailru-index-${month}.${format}';
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
        finished = true;
        status.textContent = 'Готово. Файл скачан.';
        retry.textContent = 'Скачать ещё раз';
        retry.onclick = () => { finished = false; check(); };
        return;
      }
      status.textContent = 'Индекс строится или ждёт очереди. Следующая проверка через 5 секунд…';
    } catch (e) {
      status.textContent = 'Ещё не готово. Повторяю проверку…';
    } finally {
      clearTimeout(timer);
      busy = false;
      if (!finished) setTimeout(check, 5000);
    }
  }
  retry.addEventListener('click', check);
  setTimeout(check, 500);
})();
</script></body></html>`;
}

async function serveMailIndex(request, runtimeEnv, ctx) {
  const auth = await authorizedMailRequest(request, runtimeEnv);
  if (auth.error) return auth.error;
  const url = auth.url;
  const month = String(mailQueryParam(url, "month") || "");
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) return new Response("Invalid month", { status: 400 });
  const format = mailQueryParam(url, "format") === "csv" ? "csv" : "json";
  const mode = mailQueryParam(url, "mode");

  if (mode !== "check") {
    ctx.waitUntil(kickMailIndex(runtimeEnv, month, format));
    return new Response(mailLoadingPage(month, format), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const result = await fetchMailIndexContainer(runtimeEnv, month, format, 4500);
  if (result?.timeout || !result?.response) {
    return Response.json({ ok: false, building: true, month }, { status: 202, headers: { "Cache-Control": "no-store" } });
  }

  const response = result.response;
  if (response.status === 202 || response.status === 404 || response.status >= 500) {
    try { await response.arrayBuffer(); } catch {}
    return Response.json({ ok: false, building: true, month }, { status: 202, headers: { "Cache-Control": "no-store" } });
  }

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Mail-Container", MAIL_CONTAINER_INSTANCE);
  return new Response(response.body, { status: response.status, headers });
}

async function serveMailYear(request, runtimeEnv) {
  const auth = await authorizedMailRequest(request, runtimeEnv);
  if (auth.error) return auth.error;
  const url = auth.url;
  const year = String(mailQueryParam(url, "year") || "");
  if (!/^20\d{2}$/.test(year)) return new Response("Invalid year", { status: 400 });
  const format = mailQueryParam(url, "format") === "csv" ? "csv" : "json";
  const container = getContainer(runtimeEnv.MAX_BOT_CONTAINER, MAIL_CONTAINER_INSTANCE);
  const response = await container.fetch(new Request(
    "http://container/mail/year?year=" + encodeURIComponent(year) + "&format=" + encodeURIComponent(format),
    { method: "GET" }
  ));
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Mail-Container", MAIL_CONTAINER_INSTANCE);
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, runtimeEnv, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/mail/index") {
      return serveMailIndex(request, runtimeEnv, ctx);
    }
    if (url.pathname === "/mail/year") {
      return serveMailYear(request, runtimeEnv);
    }
    if (url.pathname === "/mail/env-check") {
      return Response.json({
        ok: true,
        runtime: {
          login: hasValue(runtimeEnv?.MAILRU_LOGIN),
          password: hasValue(runtimeEnv?.MAILRU_APP_PASSWORD),
        },
        global: {
          login: hasValue(env.MAILRU_LOGIN),
          password: hasValue(env.MAILRU_APP_PASSWORD),
        },
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/mail/env-keys") {
      return Response.json({
        ok: true,
        runtimeNames: mailBindingNames(runtimeEnv),
        globalNames: mailBindingNames(env),
      }, { headers: { "Cache-Control": "no-store" } });
    }
    return currentWorker.fetch(request, runtimeEnv, ctx);
  },

  async scheduled(controller, runtimeEnv, ctx) {
    if (typeof currentWorker.scheduled === "function") {
      return currentWorker.scheduled(controller, runtimeEnv, ctx);
    }
    return undefined;
  },
};