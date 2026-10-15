// Cache chống trùng bằng IndexedDB (chỉ background dùng).
// Mỗi link là một bản ghi { url, host, post_id, savedAt }, khoá chính = url.

const DB_NAME = 'toi_crawler';
const DB_VERSION = 1;
const STORE = 'seen';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'url' });
        store.createIndex('host', 'host');
        store.createIndex('host_savedAt', ['host', 'savedAt']);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

const reqDone = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const txDone = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

async function store(mode) {
  const db = await openDb();
  const tx = db.transaction(STORE, mode);
  return { tx, store: tx.objectStore(STORE) };
}

// Duyệt con trỏ trên index, xoá từng bản ghi khớp. Trả về số bản ghi đã xoá.
async function deleteByIndex(indexName, range) {
  const { tx, store: s } = await store('readwrite');
  let n = 0;
  const req = s.index(indexName).openKeyCursor(range);
  req.onsuccess = () => {
    const cur = req.result;
    if (!cur) return;
    s.delete(cur.primaryKey);
    n++;
    cur.continue();
  };
  await txDone(tx);
  return n;
}

export async function addSeen({ url, host, post_id = null }) {
  const { tx, store: s } = await store('readwrite');
  s.put({ url, host, post_id, savedAt: Date.now() });
  await txDone(tx);
}

export async function addMany(records) {
  if (!records.length) return;
  const { tx, store: s } = await store('readwrite');
  for (const r of records) s.put(r);
  await txDone(tx);
}

// Trả về những url trong danh sách đã có trong cache
export async function filterSeen(urls) {
  if (!urls?.length) return [];
  const { store: s } = await store('readonly');
  const keys = await Promise.all(urls.map(u => reqDone(s.getKey(u))));
  return urls.filter((_, i) => keys[i] !== undefined);
}

export async function countSeen(host) {
  const { store: s } = await store('readonly');
  return reqDone(s.index('host').count(IDBKeyRange.only(host)));
}

export function clearHost(host) {
  return deleteByIndex('host', IDBKeyRange.only(host));
}

// Xoá các link của host đã lưu trước thời điểm cutoff (ms)
export function purgeOlderThan(host, cutoff) {
  return deleteByIndex('host_savedAt', IDBKeyRange.bound([host, 0], [host, cutoff], false, true));
}