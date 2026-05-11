const DB_NAME = 'scene-sync-assets';
const STORE_NAME = 'assets';
const MAX_SINGLE_GLB_SIZE = 50 * 1024 * 1024;

export function createSceneAssetCache(options = {}) {
  let db = null;

  async function initDb() {
    if (db) return;

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);

      req.onupgradeneeded = (e) => {
        const newDb = e.target.result;
        if (!newDb.objectStoreNames.contains(STORE_NAME)) {
          newDb.createObjectStore(STORE_NAME, { keyPath: 'assetId' });
        }
      };

      req.onsuccess = () => {
        db = req.result;
        resolve();
      };

      req.onerror = () => {
        reject(req.error);
      };
    });
  }

  async function putAsset({ assetId, meshPath, blob, source = 'recovered' }) {
    if (!assetId || !blob) {
      throw new Error('putAsset requires assetId and blob');
    }

    if (blob.size > MAX_SINGLE_GLB_SIZE) {
      console.warn(`[AssetCache] GLB too large (${blob.size} bytes), skipping cache`);
      return;
    }

    if (blob.type && blob.type !== 'model/gltf-binary' && !blob.type.includes('gltf')) {
      console.warn(`[AssetCache] Unsupported MIME type: ${blob.type}, skipping cache`);
      return;
    }

    await initDb();

    const record = {
      assetId,
      meshPath: meshPath || null,
      blob,
      size: blob.size,
      mime: blob.type || 'model/gltf-binary',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      source,
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(record);

      req.onsuccess = () => {
        console.log(`[AssetCache] Stored asset ${assetId} (${blob.size} bytes)`);
        resolve();
      };

      req.onerror = () => {
        console.warn('[AssetCache] Failed to store asset:', req.error);
        reject(req.error);
      };
    });
  }

  async function getByAssetId(assetId) {
    if (!assetId) return null;

    await initDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(assetId);

      req.onsuccess = () => {
        const record = req.result;
        if (record) {
          record.lastUsedAt = Date.now();
          const txWrite = db.transaction([STORE_NAME], 'readwrite');
          txWrite.objectStore(STORE_NAME).put(record);
        }
        resolve(record || null);
      };

      req.onerror = () => {
        console.warn('[AssetCache] Error fetching asset:', req.error);
        resolve(null);
      };
    });
  }

  async function getByMeshPath(meshPath) {
    if (!meshPath) return null;

    await initDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();

      req.onsuccess = () => {
        const records = req.result || [];
        const record = records.find(r => r.meshPath === meshPath);
        if (record) {
          record.lastUsedAt = Date.now();
          const txWrite = db.transaction([STORE_NAME], 'readwrite');
          txWrite.objectStore(STORE_NAME).put(record);
        }
        resolve(record || null);
      };

      req.onerror = () => {
        console.warn('[AssetCache] Error fetching by meshPath:', req.error);
        resolve(null);
      };
    });
  }

  async function rememberMeshPathAlias(assetId, meshPath) {
    if (!assetId || !meshPath) return;

    const record = await getByAssetId(assetId);
    if (record) {
      record.meshPath = meshPath;
      await putAsset(record);
    }
  }

  return {
    putAsset,
    getByAssetId,
    getByMeshPath,
    rememberMeshPathAlias,
  };
}
