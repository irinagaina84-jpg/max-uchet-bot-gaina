import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error(`sync chats patch anchor not found: ${label}`);
  code = code.replace(oldText, newText);
}

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
      const chat = await maxRequest(`/chats/${encodeURIComponent(id)}`, { timeout: 15000 });
      const chatType = String(chat?.type || "").toLowerCase();
      const chatStatus = String(chat?.status || "").toLowerCase();

      // Never treat a private dialog as a monitored work chat.
      if (!["chat", "channel"].includes(chatType)) continue;
      if (chatStatus && chatStatus !== "active") continue;

      const me = await maxRequest(`/chats/${encodeURIComponent(id)}/members/me`, { timeout: 15000 });
      const permissions = Array.isArray(me?.permissions) ? me.permissions.map(String) : [];
      const isAdmin = me?.is_admin === true || permissions.length > 0;
      const canReadAll = permissions.includes("read_all_messages");

      // History via GET /messages is available only for an admin bot.
      if (!isAdmin || !canReadAll) continue;

      // Verify that the history endpoint is actually available right now.
      await maxRequest(`/messages?chat_id=${encodeURIComponent(id)}&count=1`, { timeout: 15000 });

      active.set(String(id), {
        title: String(chat?.title || meta?.title || `чат ${id}`),
        lastSeenAt: meta?.lastSeenAt || Date.now(),
        type: chatType,
      });
    } catch (error) {
      // A stale/non-admin/private chat must not remain in the working list.
      console.error(`sync chat ${id}: ${errText(error)}`);
    }
  }

  knownGroups.clear();
  for (const [id, meta] of active) knownGroups.set(id, meta);
  state.knownGroupCount = knownGroups.size;
  await persistKnownChats();
}`,
'live chat sync helper'
);

replaceOnce(
`async function answerWorkQuestion(question) {
  const { start, end } = requestedWindow(question);`,
`async function answerWorkQuestion(question) {
  await syncKnownChats();
  const { start, end } = requestedWindow(question);`,
'sync before analysis'
);

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
  'version: "v29-admin-chat-filter",'
);

fs.writeFileSync(path, code);
console.log('strict admin work-chat synchronization enabled');
