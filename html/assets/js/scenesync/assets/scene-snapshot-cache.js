const DB_NAME = 'scene-sync-room-snapshots';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const DEFAULT_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

export function createRoomSnapshotCache(options = {}) {
  const snapshotTtlMs = options.snapshotTtlMs || DEFAULT_SNAPSHOT_TTL_MS;
  let db = null;

  function createRoomKey(roomId) {
    return `${location.origin}::${roomId}`;
  }

  async function initDb() {
    if (db) return db;

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const nextDb = event.target.result;
        if (!nextDb.objectStoreNames.contains(STORE_NAME)) {
          nextDb.createObjectStore(STORE_NAME, { keyPath: 'roomKey' });
        }
      };

      req.onsuccess = () => {
        db = req.result;
        resolve(db);
      };

      req.onerror = () => {
        reject(req.error);
      };
    });
  }

  async function saveSnapshot(roomId, snapshot) {
    if (!roomId || !snapshot) return;

    const roomKey = createRoomKey(roomId);
    const record = {
      roomKey,
      roomId,
      origin: location.origin,
      schemaVersion: 1,
      savedAt: Date.now(),
      snapshot,
    };

    const nextDb = await initDb();

    return new Promise((resolve, reject) => {
      const tx = nextDb.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(record);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getRecord(roomKey) {
    const nextDb = await initDb();

    return new Promise((resolve, reject) => {
      const tx = nextDb.transaction([STORE_NAME], 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(roomKey);

      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getSnapshot(roomId) {
    if (!roomId) return null;

    const roomKey = createRoomKey(roomId);
    const record = await getRecord(roomKey);

    if (!record) return null;

    const age = Date.now() - Number(record.savedAt || 0);
    if (age > snapshotTtlMs) {
      await deleteSnapshot(roomId);
      return null;
    }

    if (record.schemaVersion !== 1) return null;
    if (record.origin !== location.origin) return null;

    return record;
  }

  async function deleteSnapshot(roomId) {
    if (!roomId) return;

    const roomKey = createRoomKey(roomId);
    const nextDb = await initDb();

    return new Promise((resolve, reject) => {
      const tx = nextDb.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(roomKey);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  return {
    createRoomKey,
    saveSnapshot,
    getSnapshot,
    deleteSnapshot,
  };
}
