// Preload a MAX-friendly formatter, then start the semantic bot.
// This keeps model reasoning intact while making outgoing messages readable on a phone.

const originalMatch = String.prototype.match;

function cleanCell(value) {
  return String(value || "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/`/g, "")
    .trim();
}

function normalizeType(value) {
  const s = cleanCell(value).replace(/\s+/g, " ");
  if (/40\s*(HC|фут)/i.test(s)) return "40 HC";
  if (/20\s*(DC|фут)/i.test(s)) return "20 DC";
  return s;
}

function isSeparatorCells(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c.replace(/\s/g, "")));
}

function looksLikeHeader(cells) {
  const joined = cells.join(" ").toLowerCase();
  return joined.includes("клиент") && joined.includes("терминал") && joined.includes("тип") && joined.includes("колич");
}

function tableRowToText(cells) {
  const c = cells.map(cleanCell).filter((x) => x.length > 0);
  if (c.length < 2) return c.join(" — ");

  // Common accounting table: client | terminal | type | quantity
  if (c.length >= 4) {
    const client = c[0];
    const terminal = c[1];
    const type = normalizeType(c[2]);
    const qty = c[3];
    const terminalPart = terminal && terminal !== "—" && terminal !== "-" ? ` — ${terminal}` : "";
    const qtyPart = qty ? `${qty} × ${type || "конт."}` : type;
    return `• ${client}${terminalPart}: ${qtyPart}`;
  }

  return `• ${c.join(" — ")}`;
}

function sanitizeBotText(raw) {
  const source = String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*---+\s*$/gm, "")
    .replace(/^\s*\*\s+/gm, "• ");

  const lines = source.split("\n");
  const out = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^\|.*\|$/.test(trimmed)) {
      const cells = trimmed.split("|").slice(1, -1).map((x) => x.trim());
      if (isSeparatorCells(cells) || looksLikeHeader(cells)) continue;
      const row = tableRowToText(cells);
      if (row) out.push(row);
      continue;
    }

    let text = line
      .replace(/^Общий итог фактической выдачи.*?:?$/i, "ИТОГ ПО ВЫДАЧЕ")
      .replace(/^Общий итог по подтвержденной выдаче.*?:?$/i, "ИТОГ ПО ВЫДАЧЕ")
      .replace(/^Детализация\s*[«\"]?([^»\"]+)[»\"]?\s*\(выданное\)\s*:?$/i, "$1")
      .replace(/^На основе анализа хронологии и переписки,?\s*/i, "")
      .replace(/\s+$/g, "");

    out.push(text);
  }

  let result = out.join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  // Keep mobile replies concise when the model repeats long formal introductions.
  result = result
    .replace(/^итоговый учет выданных контейнеров \(фактическая выдача\) выглядит следующим образом\.?\s*/i, "")
    .replace(/^фактическая выдача выглядит следующим образом\.?\s*/i, "")
    .trim();

  return result || String(raw || "");
}

String.prototype.match = function patchedMatch(regexp) {
  if (regexp instanceof RegExp && regexp.source === "[\\s\\S]{1,3900}" && regexp.flags.includes("g")) {
    return originalMatch.call(sanitizeBotText(String(this)), regexp);
  }
  return originalMatch.call(this, regexp);
};

await import("./bot-giga-v14.js");
