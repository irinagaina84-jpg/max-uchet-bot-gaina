import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error(`MAX history patch anchor not found: ${label}`);
  code = code.replace(oldText, newText);
  console.log(`MAX history patched: ${label}`);
}

replaceOnce(
  'const q = new URLSearchParams({ chat_id: String(chatId), count: "100", to: String(before) });\n    if (since) q.set("from", String(since));',
  'const q = new URLSearchParams({ chat_id: String(chatId), count: "100", from: String(before) });\n    if (since) q.set("to", String(since));',
  'MAX from/to semantics'
);

replaceOnce(
  `async function gigaJson(messages, schema) {
  const data = await gigaRaw({ messages, stream: false, response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema } } });
  const text = String(data?.choices?.[0]?.message?.content || "{}").trim();
  try { return JSON.parse(text); } catch {
    const m = text.match(/\\{[\\s\\S]*\\}/); if (m) return JSON.parse(m[0]);
    throw new Error(\`GigaChat returned non-JSON: \${text.slice(0, 300)}\`);
  }
}`,
  `async function gigaJson(messages, schema) {
  const data = await gigaRaw({
    messages,
    stream: false,
    response_format: { type: "json_schema", schema, strict: true }
  });
  const choice = data?.choices?.[0] || {};
  const finishReason = String(choice?.finish_reason || "");
  let text = String(choice?.message?.content || "{}").trim();
  if (finishReason && finishReason !== "stop") {
    throw new Error(\`GigaChat structured output incomplete: finish_reason=\${finishReason}\`);
  }
  const candidates = [text];
  const unfenced = text.replace(/^\\s*\\`\\`\\`(?:json)?\\s*/i, "").replace(/\\s*\\`\\`\\`\\s*$/, "").trim();
  if (unfenced !== text) candidates.push(unfenced);
  const first = unfenced.indexOf("{");
  const last = unfenced.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(unfenced.slice(first, last + 1));
  let lastError = null;
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); }
    catch (error) { lastError = error; }
  }
  throw new Error(\`GigaChat invalid JSON: \${lastError?.message || "parse failed"}; chars=\${text.length}\`);
}`,
  'robust GigaChat structured JSON'
);

replaceOnce(
  'function chunkRows(rows, size = 45, overlap = 8) {\n  const out = []; for (let i = 0; i < rows.length; i += Math.max(1, size - overlap)) out.push(rows.slice(i, i + size)); return out;\n}',
  `async function extractChunkSafe(chatTitle, rows, depth = 0) {
  try {
    return await extractChunk(chatTitle, rows);
  } catch (error) {
    const message = errText(error);
    console.error(\`extractChunkSafe depth=\${depth} rows=\${rows.length}: \${message}\`);
    if (rows.length <= 3 || depth >= 5) throw error;
    const mid = Math.ceil(rows.length / 2);
    const left = await extractChunkSafe(chatTitle, rows.slice(0, mid), depth + 1);
    const right = await extractChunkSafe(chatTitle, rows.slice(mid), depth + 1);
    return {
      events: [...(left.events || []), ...(right.events || [])],
      imageCount: Number(left.imageCount || 0) + Number(right.imageCount || 0)
    };
  }
}

function chunkRows(rows, size = 28, overlap = 4) {
  const out = []; for (let i = 0; i < rows.length; i += Math.max(1, size - overlap)) out.push(rows.slice(i, i + size)); return out;
}`,
  'adaptive chunk splitting'
);

replaceOnce(
  'for (const part of chunkRows(history)) { const r = await extractChunk(title, part); imageCount += r.imageCount; events.push(...r.events); }',
  'for (const part of chunkRows(history)) { const r = await extractChunkSafe(title, part); imageCount += r.imageCount; events.push(...r.events); }',
  'safe chunk extraction'
);

replaceOnce(
  'Преобразуй фрагмент рабочей переписки в журнал событий. Поздние реплики могут отменять или исправлять ранние. Используй message_id как источник. Один человеческий смысловой эпизод может включать несколько сообщений.',
  'Преобразуй фрагмент рабочей переписки в журнал событий. Поздние реплики могут отменять или исправлять ранние. Используй message_id как источник. Один человеческий смысловой эпизод может включать несколько сообщений. Возвращай только события, которые реально важны для учета контейнеров, релизов, выдач, отмен, исправлений или оплат. Не создавай context-события для приветствий, коротких подтверждений и пустой болтовни.',
  'reduce extraction output'
);

replaceOnce(
  `function compactEvents(extractions) {
  return extractions.flatMap((x) => x.events.map((e) => ({ ...e, chat_title: x.title, chat_id: x.chatId })));
}`,
  `function compactEvents(extractions) {
  const seen = new Set();
  const out = [];
  for (const x of extractions) for (const e of x.events || []) {
    const key = JSON.stringify([
      e.event_type,
      e.source_message_ids || [],
      e.container_numbers || [],
      e.release_id || null,
      e.quantity ?? null,
      e.customer || null,
      e.terminal || null
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    const item = { event_type: e.event_type, chat_title: x.title };
    for (const [k, v] of Object.entries(e)) {
      if (k === "event_type") continue;
      if (v == null || v === "") continue;
      if (Array.isArray(v) && !v.length) continue;
      if (k === "uncertain" && v === false) continue;
      item[k] = v;
    }
    out.push(item);
  }
  return out;
}`,
  'compact final event payload'
);

replaceOnce(
  'const { start, end } = requestedWindow(question); const extractions = [];',
  'state.lastError = null; const { start, end } = requestedWindow(question); const extractions = [];',
  'clear stale analysis error'
);

replaceOnce(
  'if (!state.lastHistoryMessages) return "В подключённых чатах за этот период я не нашёл сообщений для анализа.";',
  'if (!state.lastHistoryMessages) {\n    if (state.lastError) return `Не удалось прочитать историю рабочего чата: ${state.lastError}`;\n    return "В подключённых чатах за этот период я не нашёл сообщений для анализа.";\n  }',
  'history access diagnostics'
);

replaceOnce(
  'const answer = await answerWorkQuestion(text); await sendText(`user_id=${encodeURIComponent(senderId)}`, answer);',
  'if (/(сколько|итог|выдан|выдач|релиз|остат|считай|посчитай|за весь чат)/i.test(text)) await sendText(`user_id=${encodeURIComponent(senderId)}`, "Считаю по всей истории чата. Если сообщений много, это может занять несколько минут…");\n    const answer = await answerWorkQuestion(text); await sendText(`user_id=${encodeURIComponent(senderId)}`, answer);',
  'private progress acknowledgement'
);

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v46-resilient-full-history",');
fs.writeFileSync(path, code);
console.log("MAX full-history analysis made resilient");
