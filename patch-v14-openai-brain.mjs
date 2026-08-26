import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label, required = true) {
  if (!code.includes(oldText)) {
    if (required) throw new Error(`openai patch anchor not found: ${label}`);
    console.log(`openai skipped: ${label}`);
    return;
  }
  code = code.replace(oldText, newText);
  console.log(`openai patched: ${label}`);
}

function replaceRegex(pattern, replacement, label, required = true) {
  if (!pattern.test(code)) {
    if (required) throw new Error(`openai patch regex anchor not found: ${label}`);
    console.log(`openai skipped: ${label}`);
    return;
  }
  code = code.replace(pattern, replacement);
  console.log(`openai patched: ${label}`);
}

replaceOnce(
  'const GIGA_MODEL = (process.env.GIGACHAT_MODEL || "GigaChat-3-Ultra").trim();',
  'const GIGA_MODEL = (process.env.GIGACHAT_MODEL || "GigaChat-3-Ultra").trim();\nconst OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();\nconst OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-5.6-sol").trim();\nconst OPENAI_API = "https://api.openai.com";',
  'OpenAI env'
);

replaceOnce(
  'gigachatAuthorized: false,',
  'gigachatAuthorized: false,\n  openaiConfigured: Boolean(OPENAI_API_KEY),\n  openaiAuthorized: false,\n  aiProvider: OPENAI_API_KEY ? "openai:" + OPENAI_MODEL : "gigachat:" + GIGA_MODEL,\n  lastOpenAIError: null,',
  'AI diagnostics'
);

const aiFunctions = String.raw`let openaiRequestChain = Promise.resolve();
let openaiLastCallAt = 0;
const OPENAI_MIN_GAP_MS = Number(process.env.OPENAI_MIN_GAP_MS || 250);

async function openaiRaw(payload) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const run = async () => {
    let lastError = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const gap = Math.max(0, openaiLastCallAt + OPENAI_MIN_GAP_MS - Date.now());
      if (gap) await sleep(gap);
      openaiLastCallAt = Date.now();
      try {
        const body = { model: OPENAI_MODEL, ...payload };
        const r = await requestJson(OPENAI_API + "/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + OPENAI_API_KEY,
            Accept: "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body),
          timeout: 180000
        });
        state.openaiAuthorized = true;
        state.aiProvider = "openai:" + OPENAI_MODEL;
        state.lastOpenAIError = null;
        return r.data;
      } catch (e) {
        lastError = e;
        state.openaiAuthorized = false;
        state.lastOpenAIError = errText(e).slice(0, 500);
        const retryable = e?.status === 429 || [500, 502, 503, 504].includes(Number(e?.status));
        if (!retryable) throw e;
        const delays = [1200, 2500, 5000, 10000, 20000, 35000];
        await sleep(delays[Math.min(attempt, delays.length - 1)]);
      }
    }
    throw lastError || new Error("OpenAI retry limit reached");
  };
  const queued = openaiRequestChain.then(run, run);
  openaiRequestChain = queued.catch(() => {});
  return queued;
}

function chatText(data) {
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

async function aiRaw(payload) {
  if (OPENAI_API_KEY) {
    try {
      return await openaiRaw(payload);
    } catch (e) {
      state.lastOpenAIError = errText(e).slice(0, 500);
      state.aiProvider = "gigachat-fallback:" + GIGA_MODEL;
    }
  }
  return gigaRaw(payload);
}

async function gigaChat(messages) {
  const data = await aiRaw({ messages, stream: false });
  return chatText(data);
}

async function gigaJson(messages, schema) {
  if (OPENAI_API_KEY) {
    try {
      const data = await openaiRaw({
        messages,
        stream: false,
        response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema } }
      });
      const text = chatText(data) || "{}";
      return JSON.parse(text);
    } catch (e) {
      state.lastOpenAIError = errText(e).slice(0, 500);
      state.aiProvider = "gigachat-fallback:" + GIGA_MODEL;
    }
  }
  const data = await gigaRaw({ messages, stream: false, response_format: { type: "json_schema", schema, strict: true } });
  const choice = data?.choices?.[0] || {};
  const finishReason = String(choice?.finish_reason || "");
  const text = String(choice?.message?.content || "{}").trim();
  if (finishReason && finishReason !== "stop") throw new Error("GigaChat structured output incomplete: finish_reason=" + finishReason);
  const candidates = [text, text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim()];
  const unfenced = candidates[1];
  const first = unfenced.indexOf("{");
  const last = unfenced.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(unfenced.slice(first, last + 1));
  let lastError = null;
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch (error) { lastError = error; }
  }
  throw new Error("GigaChat invalid JSON: " + (lastError?.message || "parse failed") + "; chars=" + text.length);
}`;

replaceRegex(
  /async function gigaChat\(messages\) \{[\s\S]*?\n\}\n\nasync function gigaJson\(messages, schema\) \{[\s\S]*?\n\}/,
  aiFunctions,
  'OpenAI primary provider wrappers'
);

replaceOnce(
  'const data = await gigaRaw({ messages: [{ role: "user", content: [',
  'const data = await aiRaw({ messages: [{ role: "user", content: [',
  'OpenAI vision primary',
  false
);

replaceOnce(
  'function chunkRows(rows, size = 32, overlap = 4) {',
  'function chunkRows(rows, size = (OPENAI_API_KEY ? 90 : 32), overlap = (OPENAI_API_KEY ? 8 : 4)) {',
  'larger GPT context chunks'
);

const extractChatNew = String.raw`const extractionCache = new Map();
const EXTRACTION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function historyFingerprint(chatId, history) {
  let h = 2166136261;
  for (const m of history) {
    const s = String(msgId(m)) + "|" + String(msgTime(m)) + "|" + String(msgText(m).length) + "|" + msgText(m).slice(0, 80) + "|" + String(attachments(m).length) + "|" + String(m?._releaseSeries || "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return String(chatId) + ":" + history.length + ":" + (h >>> 0);
}

async function extractChat(chatId, title, start, end) {
  const history = await fetchHistory(chatId, start, end, 5000);
  const annotatedHistory = annotateReleaseSeries(history);
  let imageCount = 0;
  const events = [];
  let cacheHits = 0;
  const parts = chunkRows(annotatedHistory);

  for (const part of parts) {
    const key = historyFingerprint(chatId, part);
    const cached = extractionCache.get(key);
    let r;
    if (cached && Date.now() - cached.at < EXTRACTION_CACHE_TTL_MS) {
      r = cached.value;
      cacheHits += 1;
    } else {
      r = await extractChunkSafe(title, part);
      extractionCache.set(key, { at: Date.now(), value: r });
    }
    imageCount += Number(r?.imageCount || 0);
    events.push(...(r?.events || []));
  }

  while (extractionCache.size > 600) extractionCache.delete(extractionCache.keys().next().value);
  return { historyCount: history.length, imageCount, events, cacheHit: parts.length > 0 && cacheHits === parts.length, chunkCacheHits: cacheHits, chunkCount: parts.length };
}`;

replaceRegex(
  /const extractionCache = new Map\(\);[\s\S]*?async function extractChat\(chatId, title, start, end\) \{[\s\S]*?\n\}\n\nfunction requestedWindow/,
  extractChatNew + "\n\nfunction requestedWindow",
  'incremental chunk cache'
);

replaceOnce(
  'state.lastExtractedEvents = extractions.reduce((s,x)=>s+x.events.length,0); state.lastCacheHits = extractions.filter((x) => x.cacheHit).length;',
  'state.lastExtractedEvents = extractions.reduce((s,x)=>s+x.events.length,0); state.lastCacheHits = extractions.reduce((s,x)=>s+Number(x.chunkCacheHits || 0),0); state.lastChunkCount = extractions.reduce((s,x)=>s+Number(x.chunkCount || 0),0);',
  'chunk cache diagnostics',
  false
);

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v54-openai-brain",');
if (code.includes('textReleaseLogicFixed: true,') && !code.includes('openaiPrimaryBrain: true,')) {
  code = code.replace('textReleaseLogicFixed: true,', 'textReleaseLogicFixed: true,\n  openaiPrimaryBrain: true,\n  incrementalChunkCache: true,');
}

fs.writeFileSync(path, code);
console.log("GPT-5.6 Sol primary brain v54 enabled");
