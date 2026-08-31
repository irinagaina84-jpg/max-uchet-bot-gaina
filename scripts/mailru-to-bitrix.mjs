import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const login = String(process.env.MAILRU_LOGIN || '').trim();
const password = String(process.env.MAILRU_APP_PASSWORD || '').trim();
const webhookBase = String(process.env.BITRIX_WEBHOOK_URL || '').trim().replace(/\/+$/, '') + '/';
const month = String(process.env.MAILRU_MONTH || '').trim();
const rootName = String(process.env.BITRIX_ROOT_NAME || 'Логистика — Интерфортум и Амиди').trim();

if (!login || !password) throw new Error('MAILRU_LOGIN / MAILRU_APP_PASSWORD are required');
if (!/^https:\/\/.+\/rest\/\d+\/[A-Za-z0-9_-]+\/?$/.test(webhookBase)) throw new Error('BITRIX_WEBHOOK_URL must be an incoming webhook base URL ending after the secret');
if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('MAILRU_MONTH must be YYYY-MM');

const [year, mon] = month.split('-').map(Number);
const start = new Date(Date.UTC(year, mon - 1, 1));
const end = new Date(Date.UTC(mon === 12 ? year + 1 : year, mon === 12 ? 0 : mon, 1));
const monthNames = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const monthFolderName = `${String(mon).padStart(2,'0')}_${monthNames[mon - 1]}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function timeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function sanitizeName(value, max = 120) {
  let s = String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+|\.+$/g, '').trim();
  if (!s) s = 'Без названия';
  if (s.length > max) s = s.slice(0, max).trim();
  return s;
}

function normalizeSubject(value) {
  return String(value || '')
    .replace(/^\s*((re|fw|fwd|ответ|пересл)\s*:\s*)+/ig, '')
    .replace(/^\s*\[.*?\]\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRoute(text) {
  const t = String(text || '').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  const patterns = [
    /маршрут\s*[:\-]?\s*([А-ЯЁA-Z][А-ЯЁа-яёA-Za-z0-9.()\/ ]{2,45}?)\s*(?:->|→|--|\s-\s|\s–\s|\s—\s)\s*([А-ЯЁA-Z][А-ЯЁа-яёA-Za-z0-9.()\/ ]{2,45})/i,
    /([А-ЯЁ][А-ЯЁа-яё.-]{2,30}(?:\s+[А-ЯЁа-яё.-]{2,25}){0,2})\s*(?:->|→|--|\s-\s)\s*([А-ЯЁ][А-ЯЁа-яё.-]{2,30}(?:\s+[А-ЯЁа-яё.-]{2,25}){0,2})/,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) return `${m[1].trim()} → ${m[2].trim()}`;
  }
  return '';
}

function documentFolder(filename, subject, text) {
  const s = `${filename || ''} ${subject || ''} ${text || ''}`.toLowerCase();
  if (/заявк|договор[- ]?заяв|application/.test(s)) return '01_Заявки';
  if (/сч[её]т|invoice/.test(s)) return '02_Счета';
  if (/\bттн\b|\bтн\b|транспортн.{0,10}наклад|товарн.{0,10}наклад/.test(s)) return '03_ТН-ТТН';
  if (/\bакт\b|\bупд\b|закрывающ/.test(s)) return '04_Акты-УПД';
  if (/паспорт|водител|права|удостовер|\bстс\b|свидетельств|договор.{0,10}аренд|карточк|реквизит|\bинн\b|\bогрн\b|устав|тягач|прицеп/.test(s)) return '05_Водитель-ТС-реквизиты';
  if (/выгруз|погруз|фото|photo|image|\.jpe?g$|\.png$|\.heic$|\.webp$/i.test(filename || '')) return '06_Фото-погрузка-выгрузка';
  return '99_Прочее';
}

async function bx(method, params = {}) {
  const url = `${webhookBase}${method}.json`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && !data.error) return data.result;
    const msg = `${data.error || res.status}: ${data.error_description || res.statusText || 'Bitrix error'}`;
    if (attempt === 5) throw new Error(`${method}: ${msg}`);
    await sleep(750 * attempt);
  }
}

const childCache = new Map();
async function getChildren(folderId) {
  const key = String(folderId);
  if (childCache.has(key)) return childCache.get(key);
  let all = [];
  for (let start = 0; ; start += 50) {
    const result = await bx('disk.folder.getChildren', { id: Number(folderId), start });
    const page = Array.isArray(result) ? result : [];
    all = all.concat(page);
    if (page.length < 50) break;
  }
  childCache.set(key, all);
  return all;
}

async function ensureSubfolder(parentId, name) {
  const clean = sanitizeName(name, 120);
  const children = await getChildren(parentId);
  const existing = children.find((x) => String(x.TYPE || '').toLowerCase() === 'folder' && String(x.NAME || '').trim() === clean);
  if (existing) return Number(existing.ID);
  const created = await bx('disk.folder.addSubFolder', { id: Number(parentId), data: { NAME: clean } });
  childCache.delete(String(parentId));
  return Number(created.ID);
}

async function storageChildren(storageId) {
  let all = [];
  for (let start = 0; ; start += 50) {
    const result = await bx('disk.storage.getChildren', { id: Number(storageId), start });
    const page = Array.isArray(result) ? result : [];
    all = all.concat(page);
    if (page.length < 50) break;
  }
  return all;
}

async function ensureRootFolder(storageId, name) {
  const clean = sanitizeName(name, 120);
  const children = await storageChildren(storageId);
  const existing = children.find((x) => String(x.TYPE || '').toLowerCase() === 'folder' && String(x.NAME || '').trim() === clean);
  if (existing) return Number(existing.ID);
  const created = await bx('disk.storage.addFolder', { id: Number(storageId), data: { NAME: clean } });
  return Number(created.ID);
}

async function chooseStorage() {
  const storages = await bx('disk.storage.getList', {});
  if (!Array.isArray(storages) || !storages.length) throw new Error('No accessible Bitrix24 Drive storage');
  return storages.find((x) => String(x.ENTITY_TYPE || '').toLowerCase() === 'common') || storages[0];
}

async function uploadFile(folderId, filename, buffer) {
  const safeName = sanitizeName(filename, 160);
  const children = await getChildren(folderId);
  if (children.some((x) => String(x.TYPE || '').toLowerCase() === 'file' && String(x.NAME || '') === safeName)) {
    return { skipped: true, name: safeName };
  }
  const prep = await bx('disk.folder.uploadFile', { id: Number(folderId), data: { NAME: safeName }, generateUniqueName: false });
  if (!prep?.uploadUrl || !prep?.field) throw new Error(`No upload URL for ${safeName}`);
  const form = new FormData();
  form.append(prep.field, new Blob([buffer]), safeName);
  const res = await fetch(prep.uploadUrl, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload ${safeName}: HTTP ${res.status}`);
  childCache.delete(String(folderId));
  return { skipped: false, name: safeName };
}

function imapClient() {
  return new ImapFlow({
    host: 'imap.mail.ru', port: 993, secure: true,
    auth: { user: login, pass: password },
    logger: false, greetingTimeout: 30000, socketTimeout: 120000, disableAutoIdle: true,
  });
}

function wantedFolder(folder) {
  const special = String(folder?.specialUse || '').toLowerCase();
  const p = String(folder?.path || '').toLowerCase();
  if (special.includes('junk') || special.includes('trash') || special.includes('draft')) return false;
  if (/спам|корзин|удален|чернов|junk|trash|draft/.test(p)) return false;
  return true;
}

async function listFolders() {
  const c = imapClient();
  try {
    await timeout(c.connect(), 30000, 'connect/list');
    return (await timeout(c.list(), 30000, 'folder list')).filter(wantedFolder);
  } finally { try { await c.logout(); } catch {} }
}

async function scanMonth() {
  const folders = await listFolders();
  const messages = [];
  const seen = new Set();
  for (const folder of folders) {
    const c = imapClient();
    try {
      await timeout(c.connect(), 30000, `connect ${folder.path}`);
      const lock = await timeout(c.getMailboxLock(folder.path), 30000, `open ${folder.path}`);
      try {
        const uids = await timeout(c.search({ since: start, before: end }, { uid: true }), 120000, `search ${folder.path}`);
        for (const uid of uids) {
          const msg = await timeout(c.fetchOne(uid, { source: true, envelope: true, internalDate: true }, { uid: true }), 120000, `${folder.path} uid ${uid}`);
          if (!msg?.source) continue;
          const parsed = await timeout(simpleParser(msg.source, { skipHtmlToText: true, skipTextToHtml: true }), 120000, `parse ${folder.path} uid ${uid}`);
          if (!parsed.attachments?.length) continue;
          const messageId = String(parsed.messageId || msg.envelope?.messageId || `${folder.path}:${uid}`).toLowerCase();
          if (seen.has(messageId)) continue;
          seen.add(messageId);
          const date = parsed.date || msg.internalDate || msg.envelope?.date || new Date();
          messages.push({
            folder: folder.path,
            uid: Number(uid),
            messageId,
            date: new Date(date),
            subject: normalizeSubject(parsed.subject || msg.envelope?.subject || 'Без темы'),
            text: String(parsed.text || '').replace(/\u0000/g, '').trim(),
            attachments: parsed.attachments,
          });
        }
      } finally { lock.release(); }
    } finally { try { await c.logout(); } catch {} }
  }
  return messages.sort((a,b) => a.date - b.date);
}

const report = { month, rootName, messagesWithAttachments: 0, attachments: 0, uploaded: 0, skipped: 0, errors: [] };

console.log(`Scanning Mail.ru ${month}...`);
const messages = await scanMonth();
report.messagesWithAttachments = messages.length;
report.attachments = messages.reduce((n,m) => n + m.attachments.length, 0);
console.log(`Found ${report.messagesWithAttachments} messages, ${report.attachments} attachments`);

const storage = await chooseStorage();
console.log(`Using Bitrix storage: ${storage.NAME} (${storage.ID})`);
const rootId = await ensureRootFolder(Number(storage.ID), rootName);
const yearId = await ensureSubfolder(rootId, String(year));
const monthId = await ensureSubfolder(yearId, monthFolderName);
const unlinkedId = await ensureSubfolder(monthId, '99_Без маршрута');

const threadFolderCache = new Map();
for (const m of messages) {
  const combined = `${m.subject}\n${m.text}`;
  const route = extractRoute(combined);
  const dateStr = m.date.toISOString().slice(0,10);
  const subjectShort = sanitizeName(m.subject, 70);
  const threadKey = `${route || 'NO_ROUTE'}|${subjectShort}`;
  let threadId = threadFolderCache.get(threadKey);
  if (!threadId) {
    const parentId = route ? monthId : unlinkedId;
    const folderName = route ? `${dateStr} — ${sanitizeName(route, 55)} — ${subjectShort}` : `${dateStr} — ${subjectShort}`;
    threadId = await ensureSubfolder(parentId, folderName);
    threadFolderCache.set(threadKey, threadId);
  }

  for (let i = 0; i < m.attachments.length; i++) {
    const att = m.attachments[i];
    const rawName = att.filename || `attachment-${i+1}`;
    const category = documentFolder(rawName, m.subject, m.text);
    const categoryId = await ensureSubfolder(threadId, category);
    const extMatch = String(rawName).match(/(\.[A-Za-zА-Яа-я0-9]{1,8})$/);
    const ext = extMatch ? extMatch[1] : '';
    const base = ext ? rawName.slice(0, -ext.length) : rawName;
    const hash = crypto.createHash('sha1').update(m.messageId).digest('hex').slice(0,7);
    const prefixed = `${m.date.toISOString().slice(0,10).replaceAll('-','')}_${m.uid}_${hash}_${sanitizeName(base, 100)}${ext}`;
    try {
      const r = await uploadFile(categoryId, prefixed, att.content || Buffer.alloc(0));
      if (r.skipped) report.skipped++; else report.uploaded++;
      console.log(`${r.skipped ? 'SKIP' : 'UP'} ${month} ${category}/${r.name}`);
    } catch (e) {
      report.errors.push({ folder: m.folder, uid: m.uid, filename: rawName, error: String(e?.message || e) });
      console.error(`ERR ${month} ${rawName}: ${e?.message || e}`);
    }
  }
}

console.log(JSON.stringify(report, null, 2));
if (report.errors.length > 0) process.exitCode = 2;
