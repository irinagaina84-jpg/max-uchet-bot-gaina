const raw = process.env.GIGACHAT_AUTH_KEY || "";
let normalized = raw.trim();
normalized = normalized.replace(/^Authorization\s*:\s*/i, "");
normalized = normalized.replace(/^Basic\s+/i, "");
normalized = normalized.replace(/\s+/g, "");
if (normalized.includes(":")) {
  normalized = Buffer.from(normalized, "utf8").toString("base64");
}
process.env.GIGACHAT_AUTH_KEY = normalized;
await import("./bot-core.js");
