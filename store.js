// Key/value persistence in one IndexedDB object store ('ec') inside one database
// ('english-coach'). The whole app — settings, the voice print, consent, the last
// transcript — goes through get/set/del here instead of scattering indexedDB calls,
// so every screen agrees on where state lives and the database is opened once.

import { migrateSettings } from './providers.js';

const DB_NAME = 'english-coach';
const STORE_NAME = 'ec';
const DOCS_STORE = 'documents';
const DB_VERSION = 2;

let dbPromise = null;

// A tab still open on an older version keeps its connection and blocks the upgrade;
// without onblocked the open never settles and the app hangs on load (settings live
// here too). Every connection closes itself when a newer version asks, so from now on
// only a tab older than this code can block.
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
      if (!req.result.objectStoreNames.contains(DOCS_STORE)) req.result.createObjectStore(DOCS_STORE, { keyPath: 'id' });
    };
    let blocked = false;
    req.onblocked = () => {
      blocked = true;
      dbPromise = null;
      reject(new Error('[almacenamiento] Cierra las otras pestañas de English Coach y recarga.'));
    };
    req.onsuccess = () => {
      const conn = req.result;
      if (blocked) { conn.close(); return; }
      conn.onversionchange = () => { conn.close(); dbPromise = null; };
      resolve(conn);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
}

// A transaction that runs out of quota aborts: onerror may not fire for it, and
// without onabort the caller waits for ever.
function settle(tx, resolve, reject, value = () => undefined) {
  tx.oncomplete = () => resolve(value());
  tx.onerror = () => reject(storageError(tx.error));
  tx.onabort = () => reject(storageError(tx.error));
}

function storageError(error) {
  if (error?.name === 'QuotaExceededError') {
    return Object.assign(new Error('[almacenamiento] No queda espacio en este dispositivo.'), { name: 'QuotaExceededError' });
  }
  return error || new Error('[almacenamiento] No se pudo guardar.');
}

function db() {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

export async function get(key) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const req = conn.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function set(key, value) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    settle(tx, resolve, reject);
  });
}

export async function del(key) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    settle(tx, resolve, reject);
  });
}

// Settings are read through here so the Phase 1 shape ({ groqKey, groqBase })
// is migrated once, on the first load after the update, and written back.
export async function loadSettings() {
  const stored = await get('settings');
  const settings = migrateSettings(stored);
  if (stored && (JSON.stringify(stored) !== JSON.stringify(settings))) await set('settings', settings);
  return settings;
}

// «Mis documentos»: one record per file — name, size, passages of text — in a store
// of its own so the settings key never carries two megabytes of passages. The file
// itself is never kept.
async function docsTx(mode, run) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(DOCS_STORE, mode);
    const out = run(tx.objectStore(DOCS_STORE));
    settle(tx, resolve, reject, () => out?.result);
  });
}

export async function listDocuments() {
  const all = await docsTx('readonly', (s) => s.getAll());
  return all.sort((a, b) => a.addedAt - b.addedAt);
}

export const putDocument = (record) => docsTx('readwrite', (s) => s.put(record));
export const deleteDocument = (id) => docsTx('readwrite', (s) => s.delete(id));

export async function setDocumentEnabled(id, enabled) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(DOCS_STORE, 'readwrite');
    const s = tx.objectStore(DOCS_STORE);
    const req = s.get(id);
    req.onsuccess = () => { if (req.result) s.put({ ...req.result, enabled }); };
    settle(tx, resolve, reject);
  });
}
