/**
 * IndexedDB: the phone's own copy of everything.
 *
 * The gym has no signal and the server lives on a PC at home, so the phone is
 * the source of truth during a workout. Sessions are written here first and
 * pushed to the server whenever it happens to be reachable.
 */

const DB_NAME = 'trainer';
const DB_VERSION = 2;

let handle;

function open() {
  if (handle) return handle;
  handle = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return handle;
}

function run(storeName, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const req = fn(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export const getMeta = (key) => run('meta', 'readonly', (s) => s.get(key));
export const setMeta = (key, value) => run('meta', 'readwrite', (s) => s.put(value, key));
export const delMeta = (key) => run('meta', 'readwrite', (s) => s.delete(key));

export const putSession = (session) => run('sessions', 'readwrite', (s) => s.put(session));
export const getSession = (id) => run('sessions', 'readonly', (s) => s.get(id));
export const allSessions = () => run('sessions', 'readonly', (s) => s.getAll());
export const delSession = (id) => run('sessions', 'readwrite', (s) => s.delete(id));

export const putNote = (note) => run('notes', 'readwrite', (s) => s.put(note));
export const allNotes = () => run('notes', 'readonly', (s) => s.getAll());

function putMany(storeName, items) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        for (const item of items) store.put(item);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      }),
  );
}

export const putSessions = (sessions) => putMany('sessions', sessions);
export const putNotes = (notes) => putMany('notes', notes);
