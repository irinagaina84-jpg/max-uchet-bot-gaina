import fs from "node:fs";

const path = "./bot.js";
let code = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText, label) {
  if (!code.includes(oldText)) throw new Error("v58 anchor not found: " + label);
  code = code.replace(oldText, newText);
  console.log("v58 patched: " + label);
}

replaceOnce(
  '        const retryable = e?.status === 429 || [500, 502, 503, 504].includes(Number(e?.status));\n        if (!retryable) throw e;\n        const delays = [1200, 2500, 5000, 10000, 20000, 35000];\n        await sleep(delays[Math.min(attempt, delays.length - 1)]);',
  '        const errorText = errText(e);\n        const quotaExceeded = Number(e?.status) === 429 && /quota|billing|plan/i.test(errorText);\n        if (quotaExceeded) throw e;\n        const retryable = Number(e?.status) === 429 || [500, 502, 503, 504].includes(Number(e?.status));\n        if (!retryable) throw e;\n        const delays = [800, 1600, 3200, 6000, 10000, 15000];\n        await sleep(delays[Math.min(attempt, delays.length - 1)]);',
  'quota errors fail fast'
);

code = code.replace(/version:\s*"v[^"]+",/, 'version: "v58-openai-quota-fallback",');
if (code.includes('ledgerBackfillGate: true,') && !code.includes('openaiQuotaFastFallback: true,')) {
  code = code.replace('ledgerBackfillGate: true,', 'ledgerBackfillGate: true,\n  openaiQuotaFastFallback: true,');
}

fs.writeFileSync(path, code);
console.log("v58 OpenAI quota fast fallback enabled");
