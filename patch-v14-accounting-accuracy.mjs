import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error(`accuracy patch anchor not found: ${label}`);
  code = code.replace(oldText, newText);
  console.log(`accuracy patched: ${label}`);
}

function replaceOptional(oldText, newText, label) {
  if (!code.includes(oldText)) {
    console.log(`accuracy skipped: ${label}`);
    return;
  }
  code = code.replace(oldText, newText);
  console.log(`accuracy patched: ${label}`);
}

function replaceRegex(pattern, replacement, label) {
  if (!pattern.test(code)) throw new Error(`accuracy patch regex anchor not found: ${label}`);
  code = code.replace(pattern, replacement);
  console.log(`accuracy patched: ${label}`);
}

const gigaRawNew = `let gigaRequestChain = Promise.resolve();
let gigaLastCallAt = 0;
const GIGA_MIN_GAP_MS = Number(process.env.GIGA_MIN_GAP_MS || 1200);

async function gigaRaw(payload) {
  const run = async () => {
    let token = await getGigaToken(false);
    const call = (t) => requestJson(\`\${GIGA_API}/v1/chat/completions\`, {
      method: "POST",
      headers: { Authorization: \`Bearer \${t}\`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ model: GIGA_MODEL, ...payload }),
      timeout: 120000
    });

    let lastError = null;
    for (let attempt = 0; attempt < 7; attempt++) {
      const waitForGap = Math.max(0, gigaLastCallAt + GIGA_MIN_GAP_MS - Date.now());
      if (waitForGap) await sleep(waitForGap);
      gigaLastCallAt = Date.now();
      try {
        return (await call(token)).data;
      } catch (e) {
        lastError = e;
        if (e?.status === 401) {
          token = await getGigaToken(true);
          continue;
        }
        const retryable = e?.status === 429 || [500, 502, 503, 504].includes(Number(e?.status));
        if (!retryable) throw e;
        state.lastRateLimitAt = new Date().toISOString();
        state.lastRateLimitStatus = Number(e?.status || 0);
        const delays = [2500, 5000, 10000, 20000, 35000, 50000, 65000];
        await sleep(delays[Math.min(attempt, delays.length - 1)]);
      }
    }
    throw lastError || new Error("GigaChat retry limit reached");
  };

  const queued = gigaRequestChain.then(run, run);
  gigaRequestChain = queued.catch(() => {});
  return queued;
}`;

replaceRegex(
  /async function gigaRaw\(payload\) \{[\s\S]*?\n\}\n\nasync function gigaChat/,
  gigaRawNew + "\n\nasync function gigaChat",
  "GigaChat throttling and 429 retry"
);

const safeChunkNew = `async function extractChunkSafe(chatTitle, rows, depth = 0) {
  try {
    return await extractChunk(chatTitle, rows);
  } catch (error) {
    const message = errText(error);
    const status = Number(error?.status || (String(message).match(/^(\\d{3}):/)?.[1] || 0));
    console.error(\`extractChunkSafe depth=\${depth} rows=\${rows.length}: \${message}\`);
    if (status === 429) throw error;
    if (rows.length > 3 && depth < 6) {
      const mid = Math.ceil(rows.length / 2);
      const left = await extractChunkSafe(chatTitle, rows.slice(0, mid), depth + 1);
      const right = await extractChunkSafe(chatTitle, rows.slice(mid), depth + 1);
      return {
        events: [...(left.events || []), ...(right.events || [])],
        imageCount: Number(left.imageCount || 0) + Number(right.imageCount || 0)
      };
    }
    throw error;
  }
}`;

replaceRegex(
  /async function extractChunkSafe\(chatTitle, rows, depth = 0\) \{[\s\S]*?\n\}\n\nfunction chunkRows/,
  safeChunkNew + "\n\nfunction chunkRows",
  "never silently discard failed chunks"
);

replaceOnce(
  'function chunkRows(rows, size = 24, overlap = 3) {',
  'function chunkRows(rows, size = 32, overlap = 4) {',
  'reduce number of extraction requests'
);

const extractChatNew = `const extractionCache = new Map();
const EXTRACTION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function historyFingerprint(chatId, history) {
  let h = 2166136261;
  for (const m of history) {
    const s = \`\${msgId(m)}|\${msgTime(m)}|\${msgText(m).length}|\${msgText(m).slice(0, 80)}|\${attachments(m).length}\`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return \`\${chatId}:\${history.length}:\${h >>> 0}\`;
}

async function extractChat(chatId, title, start, end) {
  const history = await fetchHistory(chatId, start, end, 5000);
  const cacheKey = historyFingerprint(chatId, history);
  const cached = extractionCache.get(cacheKey);
  if (cached && Date.now() - cached.at < EXTRACTION_CACHE_TTL_MS) {
    return { ...cached.value, cacheHit: true };
  }
  let imageCount = 0;
  const events = [];
  for (const part of chunkRows(history)) {
    const r = await extractChunkSafe(title, part);
    imageCount += Number(r.imageCount || 0);
    events.push(...(r.events || []));
  }
  const value = { historyCount: history.length, imageCount, events };
  extractionCache.set(cacheKey, { at: Date.now(), value });
  while (extractionCache.size > 12) extractionCache.delete(extractionCache.keys().next().value);
  return { ...value, cacheHit: false };
}`;

replaceRegex(
  /async function extractChat\(chatId, title, start, end\) \{[\s\S]*?\n\}\n\nfunction requestedWindow/,
  extractChatNew + "\n\nfunction requestedWindow",
  "cache complete extracted ledger"
);

replaceOnce(
  '2) release не включай в фактическую выдачу, пока нет подтверждения. Покажи отдельно, если это полезно.',
  '2) Для этого учета конкретный опубликованный release на контейнеры или явное количество включай в оперативную выдачу/выпуск, если позже нет cancellation, correction с отменой/заменой, «не считать», «не выдали» или указания, что это только бронь/план.',
  'count active releases as operational issue'
);

replaceOnce(
  '9) Если пользователь спрашивает «сколько выдали», считай только confirmed_issue.',
  '9) Если пользователь спрашивает «сколько выдали», считай уникальные confirmed_issue И активные конкретные release по правилу 2, не задваивая один и тот же контейнер/эпизод.',
  'issued total includes active releases'
);

replaceOnce(
  '10) Если просит «релизы», считай release отдельно.',
  '10) Если просит «релизы», считай активные release с учетом отмен/замен; если спрашивает выдано по релизам — это и есть оперативный итог по активным релизам плюс отдельные confirmed_issue, которых нет в релизах.',
  'release total semantics'
);

replaceOptional(
  'Если вопрос «выпиши по Взлёту» — сначала дай подтвержденный факт выдачи по Взлёту, затем отдельно «Только релизы / ещё не подтверждено».',
  'Если вопрос «выпиши по Взлёту» — дай единый оперативный итог активных релизов и подтвержденных выдач по Взлёту, после дедупликации и учета всех отмен/замен. Отдельно показывай только настоящую бронь/план без опубликованного релиза.',
  'Vzlet operational total semantics'
);

replaceOptional(
  'state.lastExtractedEvents = extractions.reduce((s,x)=>s+x.events.length,0);',
  'state.lastExtractedEvents = extractions.reduce((s,x)=>s+x.events.length,0); state.lastCacheHits = extractions.filter((x) => x.cacheHit).length;',
  'cache diagnostics'
);

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v51-accounting-accuracy",');
code = code.replace('privateOwnerFixed: true,', 'privateOwnerFixed: true,\n  accountingAccuracyFixed: true,');

fs.writeFileSync(path, code);
console.log("MAX accounting accuracy v51 enabled");
