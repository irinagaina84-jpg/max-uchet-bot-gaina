import fs from "node:fs";

const src = "./bot-giga-v14.js";
const dst = "./bot.js";
let code = fs.readFileSync(src, "utf8");

const anchor = `  const data = compactEvents(extractions);\n  const dialogContext = privateDialog.slice(-6).map((x) => \`${'${x.role}'}: ${'${x.text}'}\`).join("\\n");\n  const answer = await gigaChat([`;

const replacement = `  const data = compactEvents(extractions);\n  const dialogContext = privateDialog.slice(-6).map((x) => \`${'${x.role}'}: ${'${x.text}'}\`).join("\\n");\n\n  const moneyIntent = /(сумм|сколько\\s+денег|сколько\\s+заплат|сколько\\s+оплат|итог.*(руб|₽|денег|оплат|платеж)|платеж|платёж)/i.test(question);\n  if (moneyIntent) {\n    const money = await gigaJson([\n      { role: "system", content: \`${'${DOMAIN_RULES}'}\\n\\nЗадача: посчитать только денежный итог по запросу пользователя. Учитывай только относящиеся к запросу платежи. Не задваивай повторно упомянутые переводы. Не включай отмененные, ошибочно назначенные или внутренние переводы, если из контекста ясно, что они не являются оплатой нужному контрагенту. Верни только JSON по схеме.\` },\n      { role: "user", content: \`Запрос: «${'${question}'}».\\nКонтекст личного диалога:\\n${'${dialogContext || "нет"}'}\\n\\nСобытия из рабочих чатов:\\n${'${JSON.stringify(data)}'}\` }\n    ], {\n      type: "object",\n      properties: {\n        total_rub: { type: ["number", "null"] },\n        subject: { type: ["string", "null"] }\n      },\n      required: ["total_rub", "subject"],\n      additionalProperties: false\n    });\n\n    const answer = money?.total_rub == null\n      ? "Точную сумму по переписке определить не удалось."\n      : \`Итого${'${money.subject ? ` ${money.subject}` : ""}'}: ${'${Math.round(Number(money.total_rub)).toLocaleString("ru-RU")}'} ₽\`;\n\n    privateDialog.push({ role: "user", text: question }, { role: "assistant", text: answer });\n    if (privateDialog.length > 12) privateDialog.splice(0, privateDialog.length - 12);\n    return answer;\n  }\n\n  const answer = await gigaChat([`;

if (!code.includes(anchor)) {
  throw new Error("money patch anchor not found");
}

code = code.replace(anchor, replacement);
fs.writeFileSync(dst, code);
console.log("money-total patch applied");
