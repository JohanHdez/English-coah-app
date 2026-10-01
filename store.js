// Key/value persistence in one IndexedDB object store ('ec') inside one database
// ('english-coach'). The whole app — settings, the voice print, consent, the last
// transcript — goes through get/set/del here instead of scattering indexedDB calls,
// so every screen agrees on where state lives and the database is opened once.

const DB_NAME = 'english-coach';
const STORE_NAME = 'ec';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
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
