import fs from 'node:fs/promises';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const month = String(process.env.MAILRU_MONTH || process.argv[2] || '').trim();
const login = String(process.env.MAILRU_LOGIN || '').trim();
const password = String(process.env.MAILRU_APP_PASSWORD || '').trim();
const outDir = path.resolve(process.env.MAILRU_OUT_DIR || 'mailru-export');

if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('MAILRU_MONTH must be YYYY-MM');
if (!login || !password) throw new Error('MAILRU_LOGIN / MAILRU_APP_PASSWORD are required');

const [year, mon] = month.split('-').map(Number);
const start = new Date(Date.UTC(year, mon - 1, 1));
const end = new Date(Date.UTC(mon === 12 ? year + 1 : year, mon === 12 ? 0 : mon, 1));

function timeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function client() {
  return new ImapFlow({
    host: 'imap.mail.ru',
    port: 993,
    secure: true,
    auth: { user: login, pass: password },
    logger: false,
    greetingTimeout: 20000,
    socketTimeout: 45000,
    disableAutoIdle: true,
  });
}

function addressList(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((x) => ({ name: x?.name || '', address: x?.address || '' })).filter((x) => x.name || x.address);
}

function attachmentMeta(att) {
  return {
    filename: att?.filename || '',
    contentType: att?.contentType || '',
    size: Number(att?.size || att?.content?.length || 0),
    contentDisposition: att?.contentDisposition || '',
    cid: att?.cid || '',
  };
}

function csvCell(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

async function listFolders() {
  const c = client();
  try {
    await timeout(c.connect(), 30000, 'connect/list');
    const list = await timeout(c.list(), 30000, 'folder list');
    return list;
  } finally {
    try { await c.logout(); } catch {}
  }
}

function wantedFolder(folder) {
  const special = String(folder?.specialUse || '').toLowerCase();
  const p = String(folder?.path || '').toLowerCase();
  if (special.includes('junk') || special.includes('trash') || special.includes('draft')) return false;
  if (/спам|корзин|удален|чернов|junk|trash|draft/.test(p)) return false;
  return true;
}

async function scanFolder(folder) {
  const folderPath = String(folder?.path || '');
  const c = client();
  const rows = [];
  try {
    await timeout(c.connect(), 30000, `connect ${folderPath}`);
    const lock = await timeout(c.getMailboxLock(folderPath), 30000, `open ${folderPath}`);
    try {
      const uids = await timeout(c.search({ since: start, before: end }, { uid: true }), 45000, `search ${folderPath}`);
      for (const uid of uids) {
        try {
          const msg = await timeout(
            c.fetchOne(uid, { source: true, envelope: true, internalDate: true, flags: true, size: true }, { uid: true }),
            30000,
            `${folderPath} uid ${uid}`
          );
          if (!msg) continue;
          const parsed = await timeout(simpleParser(msg.source || Buffer.alloc(0), { skipHtmlToText: true, skipTextToHtml: true }), 30000, `parse ${folderPath} uid ${uid}`);
          const date = parsed?.date || msg?.internalDate || msg?.envelope?.date || null;
          rows.push({
            folder: folderPath,
            uid: Number(uid),
            messageId: String(parsed?.messageId || msg?.envelope?.messageId || ''),
            date: date ? new Date(date).toISOString() : '',
            subject: String(parsed?.subject || msg?.envelope?.subject || ''),
            from: addressList(parsed?.from?.value || msg?.envelope?.from),
            to: addressList(parsed?.to?.value || msg?.envelope?.to),
            cc: addressList(parsed?.cc?.value || msg?.envelope?.cc),
            text: String(parsed?.text || '').replace(/\u0000/g, '').trim(),
            attachments: (parsed?.attachments || []).map(attachmentMeta),
            size: Number(msg?.size || 0),
            flags: [...(msg?.flags || [])].map(String),
          });
        } catch (error) {
          rows.push({ folder: folderPath, uid: Number(uid), error: String(error?.message || error) });
        }
      }
    } finally {
      lock.release();
    }
    return { rows, error: null };
  } catch (error) {
    return { rows, error: String(error?.message || error) };
  } finally {
    try { await c.logout(); } catch {}
  }
}

await fs.mkdir(outDir, { recursive: true });
const folders = (await listFolders()).filter(wantedFolder);
const rows = [];
const folderErrors = [];

for (const folder of folders) {
  console.log(`Scanning ${folder.path} (${folder.specialUse || 'normal'})...`);
  const result = await timeout(scanFolder(folder), 180000, `folder ${folder.path}`).catch((error) => ({ rows: [], error: String(error?.message || error) }));
  rows.push(...result.rows);
  if (result.error) folderErrors.push(`${folder.path}: ${result.error}`);
}

const dedupe = new Map();
for (const row of rows) {
  const key = row.messageId ? row.messageId.toLowerCase() : `${row.folder}:${row.uid}`;
  if (!dedupe.has(key)) dedupe.set(key, row);
}
const finalRows = [...dedupe.values()].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
const attachmentCount = finalRows.reduce((n, r) => n + (Array.isArray(r.attachments) ? r.attachments.length : 0), 0);
const payload = {
  version: 'mailru-github-month-export-v1',
  month,
  builtAt: new Date().toISOString(),
  foldersScanned: folders.map((f) => ({ path: f.path, specialUse: f.specialUse || '' })),
  folderErrors,
  messages: finalRows.length,
  attachments: attachmentCount,
  rows: finalRows,
};

const jsonPath = path.join(outDir, `mailru-${month}.json`);
await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2));

const csvRows = [[
  'date','folder','uid','message_id','subject','from','to','cc','text','attachments','attachment_names','error'
]];
for (const r of finalRows) {
  csvRows.push([
    r.date || '', r.folder || '', r.uid || '', r.messageId || '', r.subject || '',
    (r.from || []).map((x) => x.address || x.name).join('; '),
    (r.to || []).map((x) => x.address || x.name).join('; '),
    (r.cc || []).map((x) => x.address || x.name).join('; '),
    r.text || '',
    Array.isArray(r.attachments) ? r.attachments.length : 0,
    (r.attachments || []).map((a) => a.filename).filter(Boolean).join('; '),
    r.error || ''
  ]);
}
const csvPath = path.join(outDir, `mailru-${month}.csv`);
await fs.writeFile(csvPath, '\ufeff' + csvRows.map((r) => r.map(csvCell).join(',')).join('\r\n'));
await fs.writeFile(path.join(outDir, 'summary.txt'), [
  `Mail.ru ${month}`,
  `Messages: ${finalRows.length}`,
  `Attachments: ${attachmentCount}`,
  `Folders scanned: ${folders.length}`,
  `Folder errors: ${folderErrors.length}`,
  ...folderErrors.map((x) => `- ${x}`),
].join('\n'));

console.log(JSON.stringify({ ok: true, month, messages: finalRows.length, attachments: attachmentCount, folderErrors }, null, 2));
