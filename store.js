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

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
      if (!req.result.objectStoreNames.contains(DOCS_STORE)) req.result.createObjectStore(DOCS_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function del(key) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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
    tx.oncomplete = () => resolve(out?.result);
    tx.onerror = () => reject(tx.error);
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
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
