import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

const oldBlock = String.raw`  const body = privateForwardBody(link);
  const sourceText = privateForwardText(link, body);
  const sourceAttachments = privateForwardAttachments(link, body);
  const outerMid = msgId(message) || randomUUID();`;

const newBlock = String.raw`  const body = privateForwardBody(link);
  const sourceText = privateForwardText(link, body);
  const sourceAttachments = privateForwardAttachments(link, body);
  const sourceChatId = privateForwardSourceChatId(link);

  // MAX no longer has GET /chats for discovery. If a bot_added/group-message
  // webhook was missed, a forwarded message from that group still carries the
  // source chat id. Verify that it is a real group/channel and persist it so
  // the owner's "Какие чаты видишь?" and analysis/export commands can use it.
  if (sourceChatId) {
    try {
      const sourceChat = await maxRequest("/chats/" + encodeURIComponent(sourceChatId), { timeout: 15000 });
      const sourceType = String(sourceChat?.type || "").toLowerCase();
      if (sourceType === "chat" || sourceType === "channel") {
        knownGroups.set(String(sourceChatId), {
          title: String(sourceChat?.title || ("чат " + sourceChatId)),
          lastSeenAt: Date.now(),
        });
        state.knownGroupCount = knownGroups.size;
        state.lastGroupChatId = String(sourceChatId);
        state.lastGroupName = String(sourceChat?.title || ("чат " + sourceChatId));
        if (typeof persistKnownChats === "function") await persistKnownChats();
      }
    } catch (sourceChatError) {
      state.lastForwardSourceChatError = errText(sourceChatError);
    }
  }

  const outerMid = msgId(message) || randomUUID();`;

if (!code.includes(oldBlock)) throw new Error("v76 forwarded source chat anchor not found");
code = code.replace(oldBlock, newBlock);

const oldSourceField = "        source_chat_id: privateForwardSourceChatId(link),";
const newSourceField = "        source_chat_id: sourceChatId,";
if (!code.includes(oldSourceField)) throw new Error("v76 source_chat_id field anchor not found");
code = code.replace(oldSourceField, newSourceField);

code = code.replace(/version:\s*"v[^"]+"\s*,?/, 'version: "v76-forward-source-chat-register",');
if (code.includes("privateImportScreenshots: true,") && !code.includes("forwardSourceChatRegister: true,")) {
  code = code.replace("privateImportScreenshots: true,", "privateImportScreenshots: true,\n  forwardSourceChatRegister: true,");
}

fs.writeFileSync(path, code);
console.log("v76 forwarded group source chat auto-registration enabled");
