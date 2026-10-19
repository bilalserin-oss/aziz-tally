// Aziz Tally for Chromebook - saved counts in Chrome's built-in database (IndexedDB).
// One record per change; each save is "strict", meaning Chrome writes it to disk
// before reporting success, so a sudden shutdown loses nothing that was confirmed.

const DB_NAME = 'aziz-tally';
const STORE = 'events';

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbStorage {
  static open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('day', 'day');
        }
      };
      req.onsuccess = () => resolve(new IdbStorage(req.result));
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('The saved counts are busy in another window.'));
    });
  }

  constructor(db) { this.db = db; }

  /** A day's records, oldest first (records come back in the order they were saved). */
  async loadDay(key) {
    const tx = this.db.transaction(STORE, 'readonly');
    const rows = await request(tx.objectStore(STORE).index('day').getAll(IDBKeyRange.only(key)));
    return rows.map(({ id, ...e }) => e);
  }

  async listDays() {
    const tx = this.db.transaction(STORE, 'readonly');
    const keys = [];
    await new Promise((resolve, reject) => {
      const cur = tx.objectStore(STORE).index('day').openKeyCursor(null, 'nextunique');
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        keys.push(c.key);
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
    return keys;
  }

  append(e) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readwrite', { durability: 'strict' });
      tx.objectStore(STORE).add({ ...e });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('save failed'));
      tx.onabort = () => reject(tx.error || new Error('save cancelled'));
    });
  }
}
