import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error(`sync chats patch anchor not found: ${label}`);
  code = code.replace(oldText, newText);
}

// Replace loadPersistedChats so memory always mirrors durable storage instead of only appending.
replaceOnce(
`async function loadPersistedChats() {
  if (!STATE_URL) return;
  try {
    const r = await requestJson(STATE_URL, {
      method: "GET",
      headers: { "X-Internal-Auth": MAX_BOT_TOKEN, Accept: "application/json" },
      timeout: 15000,
    });
    const list = Array.isArray(r.data) ? r.data : [];
    for (const item of list) {
      if (item?.chat_id == null) continue;
      knownGroups.set(String(item.chat_id), {
        title: String(item.title || ("чат " + item.chat_id)),
        lastSeenAt: Number(item.lastSeenAt || 0),
      });
    }
    state.knownGroupCount = knownGroups.size;
  } catch (error) {
    console.error("loadPersistedChats", errText(error));
  }
}`,
`async function loadPersistedChats() {
  if (!STATE_URL) return;
  try {
    const r = await requestJson(STATE_URL, {
      method: "GET",
      headers: { "X-Internal-Auth": MAX_BOT_TOKEN, Accept: "application/json" },
      timeout: 15000,
    });
    const list = Array.isArray(r.data) ? r.data : [];
    knownGroups.clear();
    for (const item of list) {
      if (item?.chat_id == null) continue;
      knownGroups.set(String(item.chat_id), {
        title: String(item.title || ("чат " + item.chat_id)),
        lastSeenAt: Number(item.lastSeenAt || 0),
      });
    }
    state.knownGroupCount = knownGroups.size;
  } catch (error) {
    console.error("loadPersistedChats", errText(error));
  }
}

async function syncKnownChats() {
  await loadPersistedChats();
  const active = new Map();

  for (const [id, meta] of knownGroups) {
    try {
      await maxRequest(`/chats/${encodeURIComponent(id)}/members/me`, { timeout: 15000 });
      let title = meta?.title || `чат ${id}`;
      try {
        const c = await maxRequest(`/chats/${encodeURIComponent(id)}`, { timeout: 15000 });
        if (c?.title) title = String(c.title);
      } catch {}
      active.set(String(id), { title, lastSeenAt: meta?.lastSeenAt || Date.now() });
    } catch (error) {
      // 403/404 means the bot is no longer a member/admin of that chat: remove it.
      if (![403, 404].includes(Number(error?.status))) {
        // For transient MAX/network errors, keep the chat instead of losing it.
        active.set(String(id), meta);
      }
    }
  }

  knownGroups.clear();
  for (const [id, meta] of active) knownGroups.set(id, meta);
  state.knownGroupCount = knownGroups.size;
  await persistKnownChats();
}`,
'live chat sync helper'
);

// Always sync before any work analysis.
replaceOnce(
`async function answerWorkQuestion(question) {
  const { start, end } = requestedWindow(question);`,
`async function answerWorkQuestion(question) {
  await syncKnownChats();
  const { start, end } = requestedWindow(question);`,
'sync before analysis'
);

// Sync before listing chats in private conversation.
replaceOnce(
`if (/какие\s+чаты|какие.*чаты.*вид|список.*чат/i.test(text)) {
      const rows = [];`,
`if (/какие\s+чаты|какие.*чаты.*вид|список.*чат/i.test(text)) {
      await syncKnownChats();
      const rows = [];`,
'sync before chat list'
);

code = code.replace(
  'version: "v27-webhook-fullchat-silent",',
  'version: "v28-webhook-live-chat-sync",'
);

fs.writeFileSync(path, code);
console.log('live chat synchronization enabled');
