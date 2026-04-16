// Shared dependencies injected from app.js
let presenceState = null;
let swarmState = null;
let localSeedInfoHashes = null;
let localCatalog = null;
let t = null;
let fmt = null;
let logSwarm = null;
let setStatus = null;
let switchTab = null;
let setRecvSender = null;
let extractInfoHash = null;
let fetchIceServers = null;
let PIPE = '';
let reportTransfer = null;
let triggerDownload = null;
let getDeviceName = () => '';
let getSelFiles = () => [];
let getCurrentSwarmMagnet = () => null;
let setCurrentSwarmMagnet = () => {};
let getCurrentLang = () => 'en';

export function initSwarmModule(ctx) {
  presenceState = ctx.presenceState;
  swarmState = ctx.swarmState;
  localSeedInfoHashes = ctx.localSeedInfoHashes;
  localCatalog = ctx.localCatalog;
  t = ctx.t;
  fmt = ctx.fmt;
  logSwarm = ctx.logSwarm;
  setStatus = ctx.setStatus;
  switchTab = ctx.switchTab;
  setRecvSender = ctx.setRecvSender;
  extractInfoHash = ctx.extractInfoHash;
  fetchIceServers = ctx.fetchIceServers;
  PIPE = ctx.PIPE;
  reportTransfer = ctx.reportTransfer;
  triggerDownload = ctx.triggerDownload;
  getDeviceName = ctx.getDeviceName || (() => ctx.deviceName || '');
  getSelFiles = ctx.getSelFiles || (() => ctx.selFiles || []);
  getCurrentSwarmMagnet = ctx.getCurrentSwarmMagnet || (() => ctx.currentSwarmMagnet || null);
  setCurrentSwarmMagnet = ctx.setCurrentSwarmMagnet || (() => {});
  getCurrentLang = ctx.getCurrentLang || (() => ctx.currentLang || 'en');
}

// ── Swarm catalog storage (metadata only) ─────────────────────────────────────
const SWARM_IDB_NAME = 'pipe-swarm';
const SWARM_IDB_STORE = 'entries';
const SWARM_IDB_VERSION = 1;
const SWARM_ENTRY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SWARM_PRUNE_INTERVAL_MS = 5 * 60 * 1000;   // run every 5 minutes
let _swarmDb = null;
let _swarmCatalogLoaded = false;
let _swarmCatalogAnnouncedForId = null;

function openSwarmDb() {
  if (_swarmDb) return Promise.resolve(_swarmDb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SWARM_IDB_NAME, SWARM_IDB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(SWARM_IDB_STORE)) {
        db.createObjectStore(SWARM_IDB_STORE, { keyPath: 'infoHash' });
      }
    };
    req.onsuccess = e => { _swarmDb = e.target.result; resolve(_swarmDb); };
    req.onerror = () => reject(req.error);
  });
}

async function swarmIDBPut(entry) {
  try {
    const db = await openSwarmDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SWARM_IDB_STORE, 'readwrite');
      const req = tx.objectStore(SWARM_IDB_STORE).put(entry);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {}
}

async function swarmIDBGetAll() {
  try {
    const db = await openSwarmDb();
    return await new Promise(resolve => {
      const tx = db.transaction(SWARM_IDB_STORE, 'readonly');
      const req = tx.objectStore(SWARM_IDB_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

async function swarmIDBGet(infoHash) {
  if (!infoHash) return null;
  try {
    const db = await openSwarmDb();
    return await new Promise(resolve => {
      const tx = db.transaction(SWARM_IDB_STORE, 'readonly');
      const req = tx.objectStore(SWARM_IDB_STORE).get(infoHash);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function swarmIDBDelete(infoHash) {
  if (!infoHash) return;
  try {
    const db = await openSwarmDb();
    await new Promise(resolve => {
      const tx = db.transaction(SWARM_IDB_STORE, 'readwrite');
      const req = tx.objectStore(SWARM_IDB_STORE).delete(infoHash);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch {}
}

async function loadLocalSwarmCatalog() {
  if (_swarmCatalogLoaded) return;
  _swarmCatalogLoaded = true;
  const rows = await swarmIDBGetAll();
  rows.forEach(row => {
    if (!row?.infoHash) return;
    localCatalog.set(row.infoHash, row);
    addSwarmEntry({
      magnetURI: row.magnetURI,
      fileNames: row.fileNames,
      fileCount: row.fileCount,
      totalBytes: row.totalBytes,
      infoHash: row.infoHash,
      fromNickname: getDeviceName() || t('unknownDevice'),
      senderId: null,
      createdAt: row.savedAt,
      catalogOnly: true,
    });
  });
}

function serializeSwarmEntry(entry) {
  return {
    magnetURI: entry.magnetURI,
    fileNames: entry.fileNames,
    fileCount: entry.fileCount,
    totalBytes: entry.totalBytes,
    fromNickname: entry.fromNickname,
    senderId: entry.senderId,
    infoHash: entry.infoHash,
    createdAt: entry.createdAt,
    seeders: Array.from(entry.seeders || []),
    catalogOnly: Boolean(entry.catalogOnly)
  };
}

function announceCatalogEntriesOnce() {
  if (!presenceState.peers.size) return;
  if (_swarmCatalogAnnouncedForId === presenceState.id) return;
  _swarmCatalogAnnouncedForId = presenceState.id;
  const catalogEntries = Array.from(swarmState.entries.values())
    .filter(e => e.catalogOnly);
  if (!catalogEntries.length) return;
  catalogEntries.forEach(entry => {
    presenceState.peers.forEach((_, peerId) => {
      sendSwarmMessage(peerId, { kind: 'swarm-catalog', entry: serializeSwarmEntry(entry) });
    });
  });
}

// ── WebTorrent (swarm) ────────────────────────────────────────────────────────
const WT_CDN = '/pipe/vendor/webtorrent@2.8.5.min.js';
const SP_CDN = '/pipe/vendor/simplepeer@9.11.1.min.js';
let _wtClient = null;
let _wtClass = null;
let _spLoaded = false;

async function loadWebTorrent() {
  if (_wtClass) return _wtClass;
  const mod = await import(/* webpackIgnore: true */ WT_CDN);
  _wtClass = mod.default ?? mod;
  return _wtClass;
}

function loadSimplePeer() {
  if (_spLoaded || window.SimplePeer) { _spLoaded = true; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SP_CDN;
    s.onload = () => { _spLoaded = true; resolve(); };
    s.onerror = () => reject(new Error('SimplePeer load failed'));
    document.head.appendChild(s);
  });
}

// ── Swarm (room torrent list) ────────────────────────────────────────────────
function requestSwarmSyncFromPeers() {
  if (!presenceState.ws || presenceState.ws.readyState !== WebSocket.OPEN) return;
  const activeIds = new Set(presenceState.peers.keys());
  swarmState.requestedPeerIds.forEach(id => {
    if (!activeIds.has(id)) swarmState.requestedPeerIds.delete(id);
  });
  presenceState.peers.forEach((_, peerId) => {
    if (swarmState.requestedPeerIds.has(peerId)) return;
    sendSwarmMessage(peerId, { kind: 'swarm-request' });
    swarmState.requestedPeerIds.add(peerId);
  });
}

function sendSwarmMessage(targetId, payload) {
  if (!presenceState.ws || presenceState.ws.readyState !== WebSocket.OPEN) return;
  presenceState.ws.send(JSON.stringify({ type: 'handoff', targetId, payload }));
}

function broadcastSwarmPublish(entry) {
  presenceState.peers.forEach((_, peerId) => {
    sendSwarmMessage(peerId, { kind: 'swarm-publish', entry: serializeSwarmEntry(entry) });
  });
}

function sendSwarmSync(targetId) {
  if (!swarmState.entries.size) return;
  const entries = Array.from(swarmState.entries.values()).map(entry => serializeSwarmEntry(entry));
  sendSwarmMessage(targetId, { kind: 'swarm-sync', entries });
}

function normalizeSwarmEntry(rawEntry, senderFallback) {
  if (!rawEntry || !rawEntry.magnetURI) return null;
  const fileNames = Array.isArray(rawEntry.fileNames) ? rawEntry.fileNames.slice(0, 5) : [];
  const fileCount = Number(rawEntry.fileCount) || fileNames.length || 1;
  const totalBytes = Number(rawEntry.totalBytes) || 0;
  const infoHash = rawEntry.infoHash || extractInfoHash(rawEntry.magnetURI);
  const seeders = new Set(Array.isArray(rawEntry.seeders) ? rawEntry.seeders : []);
  return {
    magnetURI: rawEntry.magnetURI,
    fileNames,
    fileCount,
    totalBytes,
    fromNickname: rawEntry.fromNickname || senderFallback || t('stranger'),
    senderId: rawEntry.senderId || null,
    infoHash,
    createdAt: rawEntry.createdAt || Date.now(),
    seeders,
    catalogOnly: Boolean(rawEntry.catalogOnly)
  };
}

function addSwarmEntry(rawEntry, senderFallback) {
  const entry = normalizeSwarmEntry(rawEntry, senderFallback);
  if (!entry) return null;
  const key = entry.infoHash || entry.magnetURI;
  if (!key) return null;
  const existing = swarmState.entries.get(key);
  if (existing) {
    if (entry.fileNames?.length) existing.fileNames = entry.fileNames;
    if (entry.totalBytes) existing.totalBytes = entry.totalBytes;
    if (entry.fromNickname) existing.fromNickname = entry.fromNickname;
    if (entry.createdAt) existing.createdAt = entry.createdAt;
    existing.catalogOnly = Boolean(existing.catalogOnly && entry.catalogOnly);
    entry.seeders?.forEach(id => existing.seeders.add(id));
    renderSwarmList();
    return existing;
  }
  if (entry.senderId) entry.seeders.add(entry.senderId);
  swarmState.entries.set(key, entry);
  renderSwarmList();
  return entry;
}

function removeSwarmEntry(infoHashOrMagnet) {
  if (!infoHashOrMagnet) return;
  if (swarmState.entries.delete(infoHashOrMagnet)) {
    renderSwarmList();
  }
}

async function persistLocalArchive(infoHash, magnetURI, fileObjs) {
  if (!infoHash || !fileObjs?.length) return;
  try {
    const storedFiles = [];
    for (const file of fileObjs) {
      if (!file) continue;
      let blob;
      if (file instanceof Blob) {
        blob = file;
      } else if (file.blob instanceof Blob) {
        blob = file.blob;
      } else if (typeof file.blob === 'function') {
        blob = await file.blob();
      } else if (typeof file.getBlob === 'function') {
        blob = await new Promise(resolve => file.getBlob((err, b) => resolve(err ? null : b)));
      } else if (file.blobPromise instanceof Promise) {
        blob = await file.blobPromise;
      } else {
        blob = new Blob([file]);
      }
      if (!blob) continue;
      storedFiles.push({
        name: file.name || file.fileName || 'file',
        type: file.type || blob.type || 'application/octet-stream',
        size: blob.size || file.size || 0,
        blob
      });
    }
    if (!storedFiles.length) return;
    const payload = {
      infoHash,
      magnetURI,
      fileNames: storedFiles.map(f => f.name),
      fileCount: storedFiles.length,
      totalBytes: storedFiles.reduce((sum, f) => sum + (f.size || 0), 0),
      savedAt: Date.now(),
      files: storedFiles
    };
    localCatalog.set(infoHash, payload);
    await swarmIDBPut(payload);
  } catch (e) {
    console.warn('[swarm] persistLocalArchive failed', e);
  }
}

async function seedStoredEntry(infoHash) {
  if (!infoHash) return null;
  const existing = findTorrentByInfoHash(infoHash);
  if (existing) return existing;
  let stored = localCatalog.get(infoHash);
  if (!stored) {
    stored = await swarmIDBGet(infoHash);
    if (stored) localCatalog.set(infoHash, stored);
  }
  if (!stored?.files?.length) return null;
  try {
    await loadWebTorrent();
    const files = stored.files.map(f =>
      new File([f.blob], f.name || 'file', { type: f.type || 'application/octet-stream' })
    );
    const client = getWtClient();
    return await new Promise(resolve => {
      client.seed(files, torrent => resolve(torrent));
    });
  } catch (e) {
    console.warn('[swarm] seedStoredEntry failed', e);
    return null;
  }
}

async function collectFilesFromTorrent(torrent) {
  const out = [];
  if (!torrent?.files) return out;
  for (const file of torrent.files) {
    let blob = null;
    try {
      if (typeof file.blob === 'function') {
        blob = await file.blob();
      } else if (typeof file.getBlob === 'function') {
        blob = await new Promise(resolve => file.getBlob((err, b) => resolve(err ? null : b)));
      }
    } catch {}
    if (!blob) continue;
    out.push(new File([blob], file.name || 'file', { type: file.type || blob.type || 'application/octet-stream' }));
  }
  return out;
}

async function removeLocalArchive(infoHash) {
  if (!infoHash) return;
  localCatalog.delete(infoHash);
  await swarmIDBDelete(infoHash);
  const torrent = findTorrentByInfoHash(infoHash);
  if (torrent) {
    try { torrent.destroy(); } catch {}
  }
  unregisterLocalSeederInfoHash(infoHash);
  presenceState.peers.forEach((_, peerId) => {
    sendSwarmMessage(peerId, { kind: 'swarm-seeder', infoHash, active: false, peerId: presenceState.id });
  });
  const entry = findSwarmEntryByInfoHash(infoHash);
  if (entry) {
    entry.seeders?.delete(presenceState.id);
    if (!entry.seeders || !entry.seeders.size) {
      removeSwarmEntry(infoHash);
    } else {
      renderSwarmList();
    }
  }
}

function requestSwarmPeerConnection(entry) {
  const infoHash = entry?.infoHash || extractInfoHash(entry?.magnetURI);
  if (!infoHash) {
    logSwarm('requestSwarmPeerConnection skipped — missing infoHash');
    return;
  }
  const targets = new Set();
  if (entry.senderId && entry.senderId !== presenceState.id) targets.add(entry.senderId);
  presenceState.peers.forEach((_, peerId) => {
    if (peerId && peerId !== presenceState.id) targets.add(peerId);
  });
  if (!targets.size) {
    logSwarm('requestSwarmPeerConnection no peers to notify');
    return;
  }
  logSwarm('requestSwarmPeerConnection broadcast', { infoHash, targets: Array.from(targets) });
  targets.forEach(peerId => {
    sendSwarmMessage(peerId, { kind: 'swarm-join', magnetURI: entry.magnetURI, infoHash });
  });
  presenceState.peers.forEach((_, peerId) => {
    if (peerId !== presenceState.id) {
      sendSwarmMessage(peerId, { kind: 'swarm-who-seeds', infoHash });
    }
  });
}

function swarmEntryLabel(entry) {
  const count = entry.fileCount || (entry.fileNames?.length ?? 0);
  if (count > 1) return t('filesLabel')(count);
  const first = entry.fileNames?.[0];
  return first || t('fileGeneric');
}

function renderSwarmList() {
  const block = document.getElementById('swarm-block');
  const title = document.getElementById('swarm-title');
  const empty = document.getElementById('swarm-empty');
  const list = document.getElementById('swarm-list');
  if (!block || !title || !empty || !list) return;
  title.textContent = t('swarmHeading');
  const entries = Array.from(swarmState.entries.values())
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  list.innerHTML = '';
  if (!entries.length) {
    empty.style.display = '';
    empty.textContent = t('swarmEmpty');
    return;
  }
  empty.style.display = 'none';
  entries.forEach(entry => {
    const infoHash = entry.infoHash || entry.magnetURI;
    const ownsLocal = infoHash ? localCatalog.has(infoHash) : false;
    const isSeeding = entry.seeders?.has(presenceState.id);
    const item = document.createElement('div');
    item.className = 'swarm-item';
    if (isSeeding) item.classList.add('local-active');
    else if (ownsLocal) item.classList.add('local-catalog');
    const main = document.createElement('div');
    main.className = 'swarm-item-main';
    const name = document.createElement('div');
    name.className = 'swarm-item-name';
    name.textContent = swarmEntryLabel(entry);
    const meta = document.createElement('div');
    meta.className = 'swarm-item-meta';
    const metaBits = [];
    if (entry.totalBytes) metaBits.push(fmt(entry.totalBytes));
    if (entry.fromNickname) metaBits.push(t('swarmFrom')(entry.fromNickname));
    const isCatalogOnly = entry.catalogOnly && (!entry.seeders || !entry.seeders.size);
    if (isSeeding) metaBits.push(t('swarmOwnedActive'));
    else if (ownsLocal) metaBits.push(t('swarmOwnedOffline'));
    if (isCatalogOnly) metaBits.push(t('swarmCatalogTag'));
    meta.textContent = metaBits.join(' · ');
    main.appendChild(name);
    main.appendChild(meta);
    const actions = document.createElement('div');
    actions.className = 'swarm-item-actions';
    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'btn btn-ghost';
    dlBtn.textContent = t('swarmDownload');
    if (isCatalogOnly) dlBtn.title = t('swarmCatalogOnly');
    dlBtn.onclick = async () => {
      const approvalKey = torrentApprovalKey(entry.infoHash, entry.magnetURI);
      approveTorrentDownloadKey(approvalKey);
      const label = swarmEntryLabel(entry);
      requestSwarmPeerConnection(entry);
      setStatus('recv-status', t('torrentIncoming')(entry.fromNickname || t('stranger'), label), 'waiting');
      let existing = entry.infoHash ? findTorrentByInfoHash(entry.infoHash) : null;
      if (!existing && _wtClient) {
        existing = _wtClient.torrents.find(t => t.magnetURI === entry.magnetURI);
      }
      if (!existing || existing.destroyed) {
        try {
          await receiveTorrent(entry.magnetURI, entry.fromNickname || t('stranger'), entry.senderId || null, {
            autoDownload: true,
            approvalKey
          });
        } catch (e) {
          console.warn('[swarm] receiveTorrent failed', e?.message || e);
        }
      }
    };
    const rmBtn = document.createElement('button');
    rmBtn.type = 'button';
    rmBtn.className = 'btn btn-ghost';
    rmBtn.textContent = t('swarmRemoveLocal');
    rmBtn.onclick = () => removeLocalArchive(infoHash);
    rmBtn.style.visibility = ownsLocal ? '' : 'hidden';
    actions.appendChild(rmBtn);
    actions.appendChild(dlBtn);
    item.appendChild(main);
    item.appendChild(actions);
    list.appendChild(item);
  });
}

function pruneSwarmEntries() {
  const activeIds = new Set(presenceState.peers.keys());
  if (presenceState.id) activeIds.add(presenceState.id);
  let changed = false;
  swarmState.entries.forEach((entry, key) => {
    if (entry.catalogOnly) return;
    const seeders = entry.seeders || new Set();
    seeders.forEach(id => {
      if (!activeIds.has(id)) { seeders.delete(id); changed = true; }
    });
    if (!seeders.size) {
      swarmState.entries.delete(key);
      changed = true;
    }
  });
  if (changed) renderSwarmList();
}

function pruneExpiredSwarmEntries() {
  const now = Date.now();
  let changed = false;
  swarmState.entries.forEach((entry, key) => {
    if (entry.seeders?.has(presenceState.id)) return;
    const age = now - (entry.createdAt || 0);
    if (age > SWARM_ENTRY_TTL_MS) {
      swarmState.entries.delete(key);
      changed = true;
    }
  });
  if (changed) renderSwarmList();
}

function updateEntrySeeder(infoHash, peerId, active) {
  if (!infoHash || !peerId) return;
  const entry = findSwarmEntryByInfoHash(infoHash);
  if (!entry) return;
  entry.seeders = entry.seeders || new Set();
  const beforeSize = entry.seeders.size;
  if (active) {
    entry.seeders.add(peerId);
    entry.catalogOnly = false;
  } else {
    entry.seeders.delete(peerId);
  }
  if (active && entry.senderId === peerId) {
    entry.senderId = peerId;
  }
  if (!active && entry.seeders.size === 0) {
    if (localCatalog.has(infoHash)) {
      entry.catalogOnly = true;
      renderSwarmList();
    } else {
      removeSwarmEntry(infoHash);
    }
  } else if (entry.seeders.size !== beforeSize) {
    renderSwarmList();
  }
}

function announceSeeder(infoHash, active) {
  if (!infoHash) return;
  updateEntrySeeder(infoHash, presenceState.id, active);
  presenceState.peers.forEach((_, peerId) => {
    sendSwarmMessage(peerId, { kind: 'swarm-seeder', infoHash, active, peerId: presenceState.id });
  });
}

function registerLocalSeederInfoHash(infoHash) {
  if (!infoHash || localSeedInfoHashes.has(infoHash)) return;
  localSeedInfoHashes.add(infoHash);
  announceSeeder(infoHash, true);
}

function unregisterLocalSeederInfoHash(infoHash) {
  if (!infoHash || !localSeedInfoHashes.has(infoHash)) return;
  localSeedInfoHashes.delete(infoHash);
  announceSeeder(infoHash, false);
}

function unregisterAllLocalSeeders() {
  Array.from(localSeedInfoHashes).forEach(hash => unregisterLocalSeederInfoHash(hash));
}

function updateLocalSwarmOwner(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  let changed = false;
  swarmState.entries.forEach(entry => {
    entry.seeders = entry.seeders || new Set();
    if (entry.senderId === oldId) {
      entry.senderId = newId;
      entry.seeders?.delete(oldId);
      entry.seeders?.add(newId);
      changed = true;
    }
    if (entry.seeders?.has(oldId)) {
      entry.seeders.delete(oldId);
      entry.seeders.add(newId);
      changed = true;
    }
  });
  if (changed) renderSwarmList();
}

function publishLocalSwarmEntry(magnetURI, files, infoHash = null) {
  if (!magnetURI || !files?.length) return;
  logSwarm('publishLocalSwarmEntry', { magnetURI, infoHash, files: files.map(f => f?.name) });
  const knownInfoHash = infoHash || extractInfoHash(magnetURI);
  const entry = {
    magnetURI,
    fileNames: files.map(f => f?.name || ''),
    fileCount: files.length,
    totalBytes: files.reduce((sum, f) => sum + (f?.size || 0), 0),
    fromNickname: getDeviceName() || t('unknownDevice'),
    senderId: presenceState.id || null,
    infoHash: knownInfoHash,
    createdAt: Date.now(),
    catalogOnly: false,
  };
  setCurrentSwarmMagnet(magnetURI);
  addSwarmEntry(entry, entry.fromNickname);
  broadcastSwarmPublish(entry);
  registerLocalSeederInfoHash(knownInfoHash);
}

function findTorrentByInfoHash(infoHash) {
  if (!infoHash || !_wtClient?.torrents?.length) return null;
  return _wtClient.torrents.find(t => t.infoHash === infoHash) || null;
}

function findSwarmEntryByInfoHash(infoHash) {
  if (!infoHash) return null;
  return swarmState.entries.get(infoHash) || null;
}

function getWtClient() {
  if (!_wtClass) throw new Error('WebTorrent not loaded');
  if (!_wtClient || _wtClient.destroyed) {
    _wtClient = new _wtClass({ tracker: false });
    _wtClient.on('error', e => console.warn('[wt]', e?.message || e));
  }
  return _wtClient;
}

// ── Presence-based direct peer signaling (tracker-free) ──────────────────────
const _wtPendingPeers = new Map();
const _wtPendingSignals = [];
const _torrentSeedFiles = new Map();
const _wtApprovedDownloads = new Set();
const _wtCompletedTorrents = new Map();
const _wtPendingFallbacks = new Map();
const WT_SIGNAL_TTL_MS = 30000;
const WT_SIGNAL_MAX = 50;

function _pruneWtPendingSignals() {
  const now = Date.now();
  for (let i = _wtPendingSignals.length - 1; i >= 0; i--) {
    if (now - _wtPendingSignals[i].ts > WT_SIGNAL_TTL_MS) {
      _wtPendingSignals.splice(i, 1);
    }
  }
  while (_wtPendingSignals.length > WT_SIGNAL_MAX) {
    _wtPendingSignals.shift();
  }
}

function torrentApprovalKey(infoHash, magnetURI) {
  return infoHash || extractInfoHash(magnetURI || '') || magnetURI || null;
}

function approveTorrentDownloadKey(key) {
  if (!key) return;
  if (_wtApprovedDownloads.has(key)) return;
  _wtApprovedDownloads.add(key);
  const pendingTorrent = _wtCompletedTorrents.get(key);
  if (pendingTorrent?.done) {
    _wtCompletedTorrents.delete(key);
    triggerTorrentDownloads(pendingTorrent);
  }
  const pendingFallback = _wtPendingFallbacks.get(key);
  if (pendingFallback) {
    _wtPendingFallbacks.delete(key);
    startFallbackDownload(pendingFallback);
  }
}

async function _wtConnectRoomPeers(torrent, roomPeers) {
  await loadSimplePeer().catch(() => {});
  const SP = window.SimplePeer;
  if (!SP) return;
  const iceServers = await fetchIceServers();
  const infoHash = torrent?.infoHash || extractInfoHash(torrent?.magnetURI || '') || '';
  for (const peer of roomPeers) {
    const sp = new SP({ initiator: true, trickle: false, config: { iceServers } });
    const key = infoHash ? `${peer.id}:${infoHash}` : peer.id;
    _wtPendingPeers.set(key, { sp, torrent, infoHash });
    sp.on('signal', offer => {
      const payload = { kind: 'wt-signal', signal: offer, infoHash };
      presenceState.ws?.send(JSON.stringify({ type: 'handoff', targetId: peer.id, payload }));
    });
    sp.on('connect', () => {
      try { torrent.addPeer(sp); } catch (e) { console.warn('[wt] addPeer:', e.message); }
      _wtPendingPeers.delete(key);
    });
    sp.on('error', e => { console.warn('[wt] sp:', e.message); _wtPendingPeers.delete(key); });
  }
}

async function _wtHandleOffer(torrent, fromId, signal) {
  const SP = window.SimplePeer;
  if (!SP) return;
  const iceServers = await fetchIceServers();
  const sp = new SP({ initiator: false, trickle: false, config: { iceServers } });
  sp.on('signal', answer => {
    presenceState.ws?.send(JSON.stringify({
      type: 'handoff', targetId: fromId,
      payload: { kind: 'wt-signal', signal: answer, infoHash: torrent?.infoHash || '' },
    }));
  });
  sp.on('connect', () => {
    try { torrent.addPeer(sp); } catch (e) { console.warn('[wt] addPeer:', e.message); }
  });
  sp.on('error', e => console.warn('[wt] sp:', e.message));
  sp.signal(signal);
}

async function handleWtSignal(fromId, signal, infoHash = '') {
  await loadSimplePeer().catch(() => {});
  const key = infoHash ? `${fromId}:${infoHash}` : fromId;
  const pending = _wtPendingPeers.get(key) || _wtPendingPeers.get(fromId);
  if (pending) {
    pending.sp.signal(signal);
    _wtPendingPeers.delete(key);
    _wtPendingPeers.delete(fromId);
    return;
  }
  if (!_wtClient?.torrents?.length) {
    _pruneWtPendingSignals();
    _wtPendingSignals.push({ fromId, signal, infoHash, ts: Date.now() });
    return;
  }
  const target = findTorrentByInfoHash(infoHash) || _wtClient.torrents[0];
  if (target) {
    _wtHandleOffer(target, fromId, signal).catch(e => console.warn('[wt] handleOffer:', e?.message));
  } else {
    _pruneWtPendingSignals();
    _wtPendingSignals.push({ fromId, signal, infoHash, ts: Date.now() });
  }
}

function hideMagnetInfo() {
  const el = document.getElementById('magnet-info');
  if (el) el.classList.remove('visible');
}

function showMagnetInfo(magnetURI) {
  const el = document.getElementById('magnet-info');
  const uri = document.getElementById('magnet-uri');
  const copy = document.getElementById('magnet-copy-btn');
  const stop = document.getElementById('torrent-stop-btn');
  if (!el) return;
  if (uri) uri.textContent = magnetURI;
  if (copy) {
    copy.textContent = t('torrentCopyMagnet');
    copy.onclick = () => {
      navigator.clipboard.writeText(magnetURI).then(() => {
        const orig = copy.textContent;
        copy.textContent = t('copying');
        setTimeout(() => { copy.textContent = orig; }, 1500);
      }).catch(() => {});
    };
  }
  if (stop) stop.textContent = t('torrentStop');
  el.classList.add('visible');
}

function updateMagnetStats(torrent) {
  const el = document.getElementById('magnet-stats');
  if (!el) return;
  const ul = fmt(torrent.uploadSpeed) + '/s ↑';
  const ratio = torrent.ratio.toFixed(2);
  const peers = torrent.numPeers;
  el.textContent = `${ul}  ratio: ${ratio}  peers: ${peers}`;
}

async function seedFilesAsTorrent() {
  const selFiles = getSelFiles();
  if (!selFiles.length) { setStatus('send-status', t('selectFileFirst'), 'err'); return; }
  const btn = document.getElementById('torrent-btn');
  if (btn) btn.disabled = true;
  setStatus('send-status', t('torrentLoading'), 'waiting');

  try {
    await loadWebTorrent();
  } catch (e) {
    setStatus('send-status', '✗ ' + e.message, 'err');
    if (btn) btn.disabled = false;
    return;
  }

  const client = getWtClient();
  const files = selFiles.map(({ file }) => file);
  setStatus('send-status', t('torrentSeeding'), 'waiting');

  client.torrents.slice().forEach(torrent => {
    if (_torrentSeedFiles.has(torrent.infoHash)) { try { torrent.destroy(); } catch {} }
  });
  _torrentSeedFiles.clear();

  client.seed(files, torrent => {
    torrent.on('warning', w => console.info('[wt] warning:', w?.message || w));
    torrent.on('error', e => console.warn('[wt] torrent error:', e?.message || e));
    _torrentSeedFiles.set(torrent.infoHash, files);
    torrent.once('ready', () => {
      persistLocalArchive(torrent.infoHash, torrent.magnetURI, files);
    });

    const magnetURI = torrent.magnetURI;
    showMagnetInfo(magnetURI);
    publishLocalSwarmEntry(magnetURI, files, torrent.infoHash || null);

    const peers = Array.from(presenceState.peers.values());
    if (peers.length && presenceState.ws?.readyState === WebSocket.OPEN) {
      const fileNames = files.map(f => f.name);
      const count = peers.length;
      peers.forEach(peer => {
        presenceState.ws.send(JSON.stringify({
          type: 'handoff',
          targetId: peer.id,
          payload: {
            kind: 'torrent',
            magnetURI,
            infoHash: torrent.infoHash || null,
            fileNames,
            fileCount: files.length,
          }
        }));
      });
      setStatus('send-status', t('torrentSentToAll')(count), 'waiting');
      _wtConnectRoomPeers(torrent, peers);
    }
    setStatus('send-status', t('torrentShared'), 'ok');

    const statsInterval = setInterval(() => {
      if (torrent.destroyed) { clearInterval(statsInterval); return; }
      updateMagnetStats(torrent);
    }, 1000);

    if (btn) btn.disabled = false;
  });
}

function stopSeeding() {
  if (_wtClient) {
    _wtClient.destroy(() => { _wtClient = null; });
  }
  _torrentSeedFiles.clear();
  unregisterAllLocalSeeders();
  hideMagnetInfo();
  setStatus('send-status', '');
}

async function receiveTorrent(magnetURI, sender, senderId = null, opts = {}) {
  logSwarm('receiveTorrent start', { magnetURI, sender });
  switchTab('receive');
  setRecvSender('recv-from', sender);
  setStatus('recv-status', t('torrentRecv'), 'waiting');
  document.getElementById('recv-prog-wrap').style.display = 'block';
  document.getElementById('recv-prog-bar').style.width = '0%';
  document.getElementById('recv-prog-text').textContent = '';

  try {
    await loadWebTorrent();
  } catch (e) {
    setStatus('recv-status', '✗ ' + e.message, 'err');
    return;
  }

  const { autoDownload = true, approvalKey = null } = opts || {};
  const client = getWtClient();
  const infoHashFromMagnet = extractInfoHash(magnetURI) || getCurrentSwarmMagnet();
  const approvalToken = approvalKey || torrentApprovalKey(infoHashFromMagnet, magnetURI);

  const existingTorrent = infoHashFromMagnet
    ? findTorrentByInfoHash(infoHashFromMagnet)
    : (client.torrents.find(torrent => torrent.magnetURI === magnetURI) || client.get(magnetURI));
  if (existingTorrent) {
    logSwarm('existing torrent found', {
      infoHash: existingTorrent.infoHash,
      destroyed: existingTorrent.destroyed,
      inList: client.torrents.includes(existingTorrent)
    });
    if (!existingTorrent.destroyed && client.torrents.includes(existingTorrent)) {
      if (existingTorrent.done) {
        setStatus('recv-status', t('torrentDone'), 'ok');
        const key = approvalToken || torrentApprovalKey(existingTorrent.infoHash, magnetURI);
        const approved = autoDownload || (key && _wtApprovedDownloads.has(key));
        if (approved) {
          if (key) _wtApprovedDownloads.add(key);
          triggerTorrentDownloads(existingTorrent);
          if (key) _wtCompletedTorrents.delete(key);
        } else if (key) {
          _wtCompletedTorrents.set(key, existingTorrent);
          logSwarm('existing torrent done — waiting for approval', { key });
        }
      } else {
        setStatus('recv-status', t('torrentRecv'), 'waiting');
      }
      _wtPendingSignals.splice(0).forEach(({ fromId, signal }) => _wtHandleOffer(existingTorrent, fromId, signal).catch(e => console.warn('[wt] handleOffer:', e?.message)));
      return existingTorrent;
    }
    try {
      existingTorrent.destroy?.();
      logSwarm('destroyed stale torrent', existingTorrent.infoHash);
    } catch (e) {
      logSwarm('destroy error', e?.message);
    }
    try {
      logSwarm('client.remove (object)');
      client.remove(existingTorrent);
    } catch (e) {
      logSwarm('client.remove error', e?.message);
    }
  }

  logSwarm('client.add', magnetURI);
  const torrent = client.add(magnetURI);

  torrent.on('warning', w => console.info('[wt] warning:', w?.message || w));
  torrent.on('error', e => { if (!torrent.done) setStatus('recv-status', '✗ ' + (e?.message || e), 'err'); });

  {
    const _fallbackTimer = setTimeout(() => {
      if (torrent.done || torrent.destroyed || torrent.numPeers > 0) return;
      const basePath = Math.random().toString(36).slice(2, 10);
      const fallbackPayload = { kind: 'torrent-piping-request', infoHash: torrent.infoHash, basePath };
      if (senderId) {
        presenceState.ws?.send(JSON.stringify({
          type: 'handoff', targetId: senderId, payload: fallbackPayload,
        }));
      } else {
        presenceState.peers.forEach((_, peerId) => {
          presenceState.ws?.send(JSON.stringify({
            type: 'handoff', targetId: peerId, payload: fallbackPayload,
          }));
        });
      }
      setStatus('recv-status', t('torrentFallback'), 'waiting');
    }, 30_000);
    torrent.on('wire', () => clearTimeout(_fallbackTimer));
    torrent.on('done', () => clearTimeout(_fallbackTimer));
    torrent.on('destroy', () => clearTimeout(_fallbackTimer));
  }

  torrent.on('download', () => {
    const p = Math.round(torrent.progress * 100);
    const dl = fmt(torrent.downloadSpeed);
    document.getElementById('recv-prog-bar').style.width = p + '%';
    document.getElementById('recv-prog-text').textContent = `${p}%  ↓${dl}/s`;
  });

  torrent.on('done', () => {
    document.getElementById('recv-prog-bar').style.width = '100%';
    setStatus('recv-status', t('torrentDone'), 'ok');
    logSwarm('torrent done', torrent.infoHash);
    const key = approvalToken || torrentApprovalKey(torrent.infoHash, magnetURI);
    const shouldDownload = autoDownload || (key && _wtApprovedDownloads.has(key));
    if (shouldDownload) {
      if (key) _wtApprovedDownloads.add(key);
      triggerTorrentDownloads(torrent);
      if (key) _wtCompletedTorrents.delete(key);
    } else if (key) {
      _wtCompletedTorrents.set(key, torrent);
      logSwarm('torrent done — waiting for download approval', { key });
    }
    registerLocalSeederInfoHash(torrent.infoHash || extractInfoHash(magnetURI));
    reportTransfer('torrent', torrent.length || 0);
    collectFilesFromTorrent(torrent).then(files => {
      if (files.length) {
        persistLocalArchive(torrent.infoHash || extractInfoHash(magnetURI), magnetURI, files);
      }
    });
  });

  const targetHash = torrent.infoHash || null;
  _pruneWtPendingSignals();
  if (_wtPendingSignals.length) {
    logSwarm('flushing pending signals', { count: _wtPendingSignals.length, targetHash });
    const remaining = [];
    _wtPendingSignals.forEach(({ fromId, signal, infoHash, ts }) => {
      const signalHasHash = !!infoHash;
      const torrentHasHash = !!targetHash;
      const shouldDispatch =
        (torrentHasHash && signalHasHash && infoHash === targetHash) ||
        (!torrentHasHash && !signalHasHash);
      if (shouldDispatch) {
        _wtHandleOffer(torrent, fromId, signal).catch(e => console.warn('[wt] handleOffer:', e?.message));
      } else {
        remaining.push({ fromId, signal, infoHash, ts });
      }
    });
    _wtPendingSignals.splice(0, _wtPendingSignals.length, ...remaining);
  }
}

function triggerTorrentDownloads(torrent) {
  if (!torrent?.files) return;
  torrent.files.forEach(file => {
    if (!file) return;
    if (typeof file.blob === 'function') {
      file.blob().then(blob => triggerDownload(blob, file.name)).catch(() => {});
    } else if (typeof file.getBlob === 'function') {
      file.getBlob((err, blob) => { if (!err) triggerDownload(blob, file.name); });
    }
  });
}

function startFallbackDownload(payload) {
  setStatus('recv-status', t('torrentFallbackDL'), 'waiting');
  (async () => {
    try {
      for (const { url, name } of (payload.files || [])) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 120_000);
        try {
          const r = await fetch(url, { signal: ac.signal });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          triggerDownload(await r.blob(), name);
        } finally {
          clearTimeout(timer);
        }
      }
      setStatus('recv-status', t('torrentDone'), 'ok');
    } catch (e) {
      setStatus('recv-status', '✗ ' + (e?.message || e), 'err');
    }
  })();
}

async function handleSwarmHandoff(msg) {
  const payload = msg.payload || {};
  const sender = msg.from?.nickname || t('stranger');

  if (payload.kind === 'swarm-publish') {
    addSwarmEntry(payload.entry, sender);
    return true;
  }
  if (payload.kind === 'swarm-catalog') {
    addSwarmEntry({ ...payload.entry, catalogOnly: true, senderId: null }, sender);
    return true;
  }
  if (payload.kind === 'swarm-sync') {
    (payload.entries || []).forEach(entry => addSwarmEntry(entry, entry?.fromNickname || sender));
    return true;
  }
  if (payload.kind === 'swarm-request') {
    const requesterId = msg.from?.id;
    if (requesterId) sendSwarmSync(requesterId);
    return true;
  }
  if (payload.kind === 'swarm-join' && payload.magnetURI) {
    const requesterId = msg.from?.id;
    if (!requesterId) return true;
    const requestedInfoHash = payload.infoHash || extractInfoHash(payload.magnetURI);
    logSwarm('swarm-join received', { requesterId, infoHash: requestedInfoHash });
    try {
      await loadWebTorrent();
      const client = getWtClient();
      let torrent = requestedInfoHash
        ? findTorrentByInfoHash(requestedInfoHash)
        : (client.get(payload.magnetURI) || client.torrents.find(t => t.magnetURI === payload.magnetURI));
      if (!torrent && requestedInfoHash) {
        torrent = await seedStoredEntry(requestedInfoHash);
        if (torrent) {
          const entry = findSwarmEntryByInfoHash(requestedInfoHash);
          if (entry) {
            entry.catalogOnly = false;
            entry.seeders = entry.seeders || new Set();
            entry.seeders.add(presenceState.id);
            renderSwarmList();
          }
          registerLocalSeederInfoHash(requestedInfoHash);
        }
      }
      if (!torrent) return true;
      const peer = presenceState.peers.get(requesterId) || { id: requesterId };
      _wtConnectRoomPeers(torrent, [peer]);
    } catch {}
    return true;
  }
  if (payload.kind === 'swarm-seeder') {
    const infoHash = payload.infoHash || extractInfoHash(payload.magnetURI);
    const peerId = payload.peerId || msg.from?.id;
    updateEntrySeeder(infoHash, peerId, payload.active);
    return true;
  }
  if (payload.kind === 'swarm-who-seeds') {
    const queryHash = payload.infoHash;
    if (!queryHash) return true;
    const isSeed = localSeedInfoHashes.has(queryHash) || localCatalog.has(queryHash);
    if (isSeed && msg.from?.id) {
      sendSwarmMessage(msg.from.id, { kind: 'swarm-i-seed', infoHash: queryHash });
    }
    return true;
  }
  if (payload.kind === 'swarm-i-seed') {
    const hash = payload.infoHash;
    const seederId = msg.from?.id;
    if (!hash || !seederId) return true;
    const entry = findSwarmEntryByInfoHash(hash);
    if (entry) {
      entry.seeders = entry.seeders || new Set();
      entry.seeders.add(seederId);
      entry.catalogOnly = false;
      renderSwarmList();
    }
    const torrent = findTorrentByInfoHash(hash);
    if (torrent && !torrent.destroyed) {
      const peer = presenceState.peers.get(seederId) || { id: seederId };
      _wtConnectRoomPeers(torrent, [peer]);
    }
    return true;
  }
  if (payload.kind === 'torrent') {
    const entry = addSwarmEntry(payload, sender);
    const approvalKey = entry
      ? torrentApprovalKey(entry.infoHash, entry.magnetURI)
      : torrentApprovalKey(payload.infoHash, payload.magnetURI);
    const label = payload.fileCount > 1
      ? t('filesLabel')(payload.fileCount)
      : (payload.fileNames || t('fileGeneric'));
    const prompt = getCurrentLang() === 'ja'
      ? `${t('torrentIncoming')(sender, label)} — ${t('swarmHeading')}で「${t('swarmDownload')}」を押すと受信が始まります`
      : `${t('torrentIncoming')(sender, label)} — Open “${t('swarmHeading')}” and press “${t('swarmDownload')}” to download.`;
    setStatus('recv-status', prompt, 'waiting');
    switchTab('receive');
    receiveTorrent(payload.magnetURI, sender, msg.from?.id, { autoDownload: false, approvalKey });
    return true;
  }
  if (payload.kind === 'torrent-piping-request') {
    const files = _torrentSeedFiles.get(payload.infoHash);
    const requesterId = msg.from?.id;
    if (!files || !files.length || !requesterId) return true;
    const basePath = payload.basePath || Math.random().toString(36).slice(2, 10);
    files.forEach((file, i) => {
      fetch(`${PIPE}/${basePath}-${i}`, { method: 'POST', body: file }).catch(() => {});
    });
    presenceState.ws?.send(JSON.stringify({
      type: 'handoff', targetId: requesterId,
      payload: {
        kind: 'torrent-piping-ready',
        infoHash: payload.infoHash,
        files: files.map((file, i) => ({
          url: `${PIPE}/${basePath}-${i}`,
          name: file.name,
          size: file.size,
          mime: file.type || 'application/octet-stream',
        })),
      },
    }));
    return true;
  }
  if (payload.kind === 'torrent-piping-ready') {
    const key = torrentApprovalKey(payload.infoHash, null);
    if (key && !_wtApprovedDownloads.has(key)) {
      _wtPendingFallbacks.set(key, payload);
      logSwarm('queued fallback download until approval', { key });
      return true;
    }
    startFallbackDownload(payload);
    return true;
  }
  if (payload.kind === 'wt-signal') {
    const fromId = msg.from?.id;
    if (fromId) handleWtSignal(fromId, payload.signal, payload.infoHash || '');
    return true;
  }
  return false;
}

setInterval(() => {
  if (presenceState && swarmState) pruneExpiredSwarmEntries();
}, SWARM_PRUNE_INTERVAL_MS);

export {
  loadLocalSwarmCatalog,
  announceCatalogEntriesOnce,
  requestSwarmSyncFromPeers,
  pruneSwarmEntries,
  addSwarmEntry,
  renderSwarmList,
  updateLocalSwarmOwner,
  seedFilesAsTorrent,
  stopSeeding,
  receiveTorrent,
  handleWtSignal,
  startFallbackDownload,
  unregisterAllLocalSeeders,
  handleSwarmHandoff,
};
