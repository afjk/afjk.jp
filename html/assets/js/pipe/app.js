// ── i18n ──────────────────────────────────────────────────────────────────────
const I18N = {
  ja: {
    copying:            'コピー済 ✓',
    copy:               'コピー',
    editNamePrompt:     '表示する端末名を入力',
    recvPlaceholder:    'abc12345 または https://afjk.jp/pipe/#abc12345',
    txtSendPlaceholder: 'ここにテキストを貼り付けまたは入力…',
    txtRecvPlaceholder: 'abc12345',
    txtReceivedPlaceholder: '受信したテキストがここに表示されます',
    presenceConnecting:   '接続中…',
    presenceConnected:    '接続済み',
    presenceReconnecting: '再接続しています…',
    presenceUnavailable:  '近くのデバイスの検出は利用できません',
    roomCode:    r  => `ルームコード: ${r}`,
    detectedGrp: r  => `検出されたグループ: ${r}`,
    noDevices:    '接続中のデバイスはありません。',
    notConnected: '接続されていません。',
    unknownDevice: 'デバイス',
    peerSend:     '送信',
    online:       'オンライン',
    secsAgo:  n   => `${n}秒前`,
    minsAgo:  n   => `${n}分前`,
    hoursAgo: n   => `${n}時間前`,
    selectFileFirst:    '先にファイルを選択してください。',
    pipeSizeLimit:      'ファイルサイズが 5GB を超えています。P2P 接続が確立できる環境でお試しください。',
    presenceConnFail:   '近くのデバイスとの接続を確立できません。',
    handoffSent:        '通知を送信しました。P2P 接続を開始します…',
    incomingFile: (sender, label) => `${sender} から ${label} が届きます。接続しています…`,
    fileLabel:    name => `「${name}」`,
    fileGeneric:  'ファイル',
    stranger:     '相手',
    cancelled:    'キャンセルしました',
    tryingP2P:    'ローカル P2P を試みています…',
    transferringP2P: '転送中… (P2P)',
    transferring: '転送中…',
    sendPreparing: '接続を準備中…',
    sendReady: '接続が確立しました。送信を開始します…',
    transferDone: (size, secs, spd) => `✓ 転送完了 (中継) — ${size} / ${secs}秒 / ${spd}/s`,
    transferFail: '✗ エラー',
    waitingRcvr:  '受信者を待っています…',
    startDL:      'ダウンロードを開始します…',
    waitingXfer:  '受信を待機中。送信側が転送を開始すると自動でダウンロードされます。',
    textSentOk:   '✓ 送信完了',
    textError:    '✗ エラー',
    receiving:    '受信中…',
    textRecvDone: (size, secs, spd) => `✓ 受信完了 (中継) — ${size} / ${secs}秒 / ${spd}/s`,
    p2pConnected: 'ローカル P2P 接続完了！',
    p2pReceiving: name => `受信中 (P2P): ${name}`,
    p2pProgress:  (rcvd, total) => `受信中 (P2P): ${rcvd} / ${total}`,
    p2pSendDone:  (size, secs, spd) => `✓ 転送完了 (P2P) — ${size} / ${secs}秒 / ${spd}/s`,
    p2pRecvDone:  (size, secs, spd) => `✓ 受信完了 (P2P) — ${size} / ${secs}秒 / ${spd}/s`,
    filesLabel:   n => `${n}個のファイル`,
    fileProgress: (i, n) => `ファイル ${i}/${n}`,
    allDone:      n => `✓ ${n}個のファイルを転送完了`,
    pairBtn:      'ピン',
    unpairBtn:    'ピン解除',
    roomLabel:    'ルームコード',
    roomNone:     '未設定',
    roomGenerate: '作成',
    roomCopyUrl:  'URL コピー',
    roomClear:    '退場',
    roomJoinPlaceholder: 'コードを入力',
    roomJoin:     '参加',
    roomUrlCopied:'コピー済 ✓',
    sendToAll:         n      => `全員に送信 (${n}人)`,
    broadcastSending:  n      => `${n}台に送信中…`,
    broadcastProgress: (d, n) => `${d}/${n} 完了…`,
    broadcastDone:     n      => `${n}台に送信しました`,
    torrentBtn:        'ルームに共有',
    torrentLoading:    'WebTorrent を読み込み中…',
    torrentSeeding:    'シーディング中',
    torrentShared:     'ルームに共有しました',
    torrentSentToAll:  n => `${n}台にマグネットリンクを送信しました`,
    torrentIncoming:   (sender, n) => `${sender} からトレント (${n}) が届きます…`,
    torrentRecv:       '🌊 トレント受信中…',
    torrentDone:       '🌊 受信完了 (トレント)',
    torrentCopyMagnet: 'マグネットコピー',
    torrentStop:       'シード停止',
    swarmHeading:      'ルームで保持中のファイル',
    swarmEmpty:        'まだ共有されているトレントはありません。',
    swarmDownload:     'ダウンロード',
    swarmFrom:         name => `共有者: ${name}`,
    swarmCatalogTag:   'ローカル保存',
    swarmCatalogOnly:  'アーカイブ表示のみ',
    swarmOwnedActive:  '自分がシード中',
    swarmOwnedOffline: 'ローカルのみ',
    swarmRemoveLocal:  'ローカル削除',
    gdrivePick:        'Google Driveから選択',
    gdriveDownloading: 'Driveからダウンロード中…',
    gdriveDone:        n => `${n}件のファイルを読み込みました`,
    gdriveError:       msg => `Google Drive エラー: ${msg}`,
    previewCsvRows:    n => `…(${n}行まで表示)`,
    previewTruncated:  n => `…(${n}文字で打ち切り)`,
    previewLoadError:  'プレビューの表示に失敗しました',
    torrentFallback:   'P2P 接続なし — HTTP 経由でフォールバック中…',
    torrentFallbackDL: 'HTTP でダウンロード中…',
  },
  en: {
    copying:            'Copied ✓',
    copy:               'Copy',
    editNamePrompt:     'Enter device name',
    recvPlaceholder:    'abc12345 or https://afjk.jp/pipe/#abc12345',
    txtSendPlaceholder: 'Paste or type text here…',
    txtRecvPlaceholder: 'abc12345',
    txtReceivedPlaceholder: 'Received text will appear here',
    presenceConnecting:   'Connecting...',
    presenceConnected:    'Connected',
    presenceReconnecting: 'Reconnecting...',
    presenceUnavailable:  'Nearby device detection unavailable',
    roomCode:    r  => `Room: ${r}`,
    detectedGrp: r  => `Group: ${r}`,
    noDevices:    'No devices connected.',
    notConnected: 'Not connected.',
    unknownDevice: 'Device',
    peerSend:     'Send',
    online:       'Online',
    secsAgo:  n   => `${n}s ago`,
    minsAgo:  n   => `${n}m ago`,
    hoursAgo: n   => `${n}h ago`,
    selectFileFirst:    'Please select a file first.',
    pipeSizeLimit:      'File exceeds 5GB limit for relay transfer. Try again if P2P connection is available.',
    presenceConnFail:   'Cannot connect to nearby device.',
    handoffSent:        'Notification sent. Starting P2P transfer...',
    incomingFile: (sender, label) => `Incoming ${label} from ${sender}. Connecting...`,
    fileLabel:    name => `"${name}"`,
    fileGeneric:  'file',
    stranger:     'Someone',
    cancelled:    'Cancelled',
    tryingP2P:    'Trying local P2P...',
    transferringP2P: 'Transferring... (P2P)',
    transferring: 'Transferring...',
    sendPreparing: 'Preparing connection…',
    sendReady: 'Connection ready. Starting transfer…',
    transferDone: (size, secs, spd) => `✓ Transfer complete (relay) — ${size} / ${secs}s / ${spd}/s`,
    transferFail: '✗ Error',
    waitingRcvr:  'Waiting for receiver...',
    startDL:      'Starting download...',
    waitingXfer:  'Waiting for transfer. Download will start automatically when sender begins.',
    textSentOk:   '✓ Sent',
    textError:    '✗ Error',
    receiving:    'Receiving...',
    textRecvDone: (size, secs, spd) => `✓ Received (relay) — ${size} / ${secs}s / ${spd}/s`,
    p2pConnected: 'Local P2P connected!',
    p2pReceiving: name => `Receiving (P2P): ${name}`,
    p2pProgress:  (rcvd, total) => `Receiving (P2P): ${rcvd} / ${total}`,
    p2pSendDone:  (size, secs, spd) => `✓ Transfer complete (P2P) — ${size} / ${secs}s / ${spd}/s`,
    p2pRecvDone:  (size, secs, spd) => `✓ Received (P2P) — ${size} / ${secs}s / ${spd}/s`,
    filesLabel:   n => `${n} files`,
    fileProgress: (i, n) => `File ${i}/${n}`,
    allDone:      n => `✓ ${n} files transferred`,
    pairBtn:      'Pin',
    unpairBtn:    'Unpin',
    roomLabel:    'Room code',
    roomNone:     'none',
    roomGenerate: 'Generate',
    roomCopyUrl:  'Copy URL',
    roomClear:    'Leave',
    roomJoinPlaceholder: 'Enter code',
    roomJoin:     'Join',
    roomUrlCopied:'Copied ✓',
    sendToAll:         n      => `Send to All (${n})`,
    broadcastSending:  n      => `Sending to ${n} devices…`,
    broadcastProgress: (d, n) => `${d}/${n} done…`,
    broadcastDone:     n      => `Sent to ${n} devices`,
    torrentBtn:        'Share to Room',
    torrentLoading:    'Loading WebTorrent…',
    torrentSeeding:    'Seeding',
    torrentShared:     'Shared to room.',
    torrentSentToAll:  n => `Magnet link sent to ${n} devices`,
    torrentIncoming:   (sender, n) => `Torrent incoming from ${sender} (${n})…`,
    torrentRecv:       '🌊 Receiving torrent…',
    torrentDone:       '🌊 Received (torrent)',
    torrentCopyMagnet: 'Copy Magnet',
    torrentStop:       'Stop Seeding',
    swarmHeading:      'Room Swarm',
    swarmEmpty:        'No torrents have been shared yet.',
    swarmDownload:     'Download',
    swarmFrom:         name => `Shared by ${name}`,
    swarmCatalogTag:   'Catalog only',
    swarmCatalogOnly:  'Catalog entry',
    swarmOwnedActive:  'Seeding locally',
    swarmOwnedOffline: 'Stored locally',
    swarmRemoveLocal:  'Remove local copy',
    gdrivePick:        'Select from Google Drive',
    gdriveDownloading: 'Downloading from Drive…',
    gdriveDone:        n => `${n} file${n === 1 ? '' : 's'} loaded from Drive`,
    gdriveError:       msg => `Google Drive error: ${msg}`,
    previewCsvRows:    n => `…(showing up to ${n} rows)`,
    previewTruncated:  n => `…(truncated at ${n} chars)`,
    previewLoadError:  'Failed to load preview',
    torrentFallback:   'No P2P peers — falling back to HTTP…',
    torrentFallbackDL: 'Downloading via HTTP…',
  }
};

class LanguageManager {
  constructor(translations) {
    this.translations = translations;
    this.lang = 'ja';
    this.listeners = new Set();
  }

  init() {
    const saved = localStorage.getItem('lang');
    const browser = navigator.language && navigator.language.startsWith('ja') ? 'ja' : 'en';
    this.setLang(saved || browser || 'ja');
    this.bindButtons();
  }

  bindButtons() {
    document.querySelectorAll('[data-lang-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const lang = btn.dataset.lang;
        if (lang) this.setLang(lang);
      });
    });
  }

  onChange(listener) {
    if (typeof listener === 'function') {
      this.listeners.add(listener);
    }
  }

  setLang(lang) {
    if (!this.translations[lang]) return;
    this.lang = lang;
    document.documentElement.lang = lang;
    localStorage.setItem('lang', lang);

    document.querySelectorAll('[data-ja]').forEach(el => {
      el.style.display = lang === 'ja' ? '' : 'none';
    });
    document.querySelectorAll('[data-en]').forEach(el => {
      el.style.display = lang === 'en' ? '' : 'none';
    });

    document.querySelectorAll('[data-lang-toggle]').forEach(btn => {
      const isActive = btn.dataset.lang === lang;
      btn.classList.toggle('active', isActive);
    });

    this.listeners.forEach(listener => {
      listener(lang);
    });
  }

  translate(key) {
    return this.translations[this.lang][key];
  }

  get value() {
    return this.lang;
  }
}

const languageManager = new LanguageManager(I18N);
const t = key => languageManager.translate(key);
let currentLang = 'ja';

function handleLanguageChange(lang) {
  currentLang = lang;

  const recvPath = document.getElementById('recv-path');
  if (recvPath) recvPath.placeholder = t('recvPlaceholder');
  const txtSend = document.getElementById('txt-send');
  if (txtSend) txtSend.placeholder = t('txtSendPlaceholder');
  const txtRecvPath = document.getElementById('txt-recv-path');
  if (txtRecvPath) txtRecvPath.placeholder = t('txtRecvPlaceholder');
  const txtReceived = document.getElementById('txt-received');
  if (txtReceived) txtReceived.placeholder = t('txtReceivedPlaceholder');

  updateDeviceNameLabel();
  updateSendAllBtns();
  renderPeerGrid();
  renderRoomSection();
  if (presenceState.ws) {
    presenceStatusEl.textContent = presenceState.ws.readyState === WebSocket.OPEN
      ? t('presenceConnected') : t('presenceReconnecting');
  } else {
    presenceStatusEl.textContent = t('presenceConnecting');
  }
  renderHistory();
  renderSwarmList();
}

languageManager.onChange(handleLanguageChange);

// ── Stats reporting ───────────────────────────────────────────────────────────
class TransferStatsReporter {
  constructor(endpoint) {
    this.endpoint = endpoint;
  }

  report(type, bytes, meta = null) {
    if (!type) return;
    const payload = { type, bytes };
    if (meta && typeof meta === 'object') {
      payload.meta = meta;
    }
    fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(() => {});
  }
}

const transferStatsReporter = new TransferStatsReporter(
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? `http://${location.hostname}:8787/stats`
    : `${location.protocol}//${location.hostname}/presence/stats`
);

function reportTransfer(type, bytes, meta = null) {
  transferStatsReporter.report(type, bytes, meta);
}

// ── Config ────────────────────────────────────────────────────────────────────
const GDRIVE_CLIENT_ID = '109611024015-h8dt5416re6edbun25a5iq1a3spuj0qc.apps.googleusercontent.com';
const GDRIVE_API_KEY   = 'AIzaSyCHXozZm9QMqLRgQOrKmq74Q6yutFHHeA0';
const PIPE        = 'https://pipe.afjk.jp';
const PIPE_MAX_SIZE = 5 * 1024 * 1024 * 1024; // 5GB

// ICE server config — fetched once from presence-server; TURN credentials are set via env vars
class IceConfigService {
  constructor(url) {
    this.url = url;
    this.cachePromise = null;
  }

  fetchServers() {
    if (!this.cachePromise) {
      this.cachePromise = this.load();
    }
    return this.cachePromise;
  }

  async load() {
    const fallback = [{ urls: 'stun:stun.l.google.com:19302' }];
    try {
      const signal = this.createAbortSignal(3000);
      const response = await fetch(this.url, { signal });
      if (response.ok) {
        const data = await response.json();
        const normalized = this.normalize(data);
        if (normalized.length) return normalized;
      }
    } catch {}
    return fallback;
  }

  createAbortSignal(ms) {
    if (typeof AbortSignal?.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
    const ac = new AbortController();
    setTimeout(() => ac.abort(), ms);
    return ac.signal;
  }

  normalize(entries) {
    if (!Array.isArray(entries)) return [];
    const normalized = entries
      .map(entry => {
        if (!entry) return null;
        const urls = entry.urls;
        if (!urls || (Array.isArray(urls) && !urls.length)) return null;
        return entry;
      })
      .filter(Boolean);
    if (!normalized.length) return [];
    normalized.sort((a, b) => {
      const aTurn = Array.isArray(a.urls)
        ? a.urls.some(u => /^turn/i.test(u))
        : /^turn/i.test(a.urls);
      const bTurn = Array.isArray(b.urls)
        ? b.urls.some(u => /^turn/i.test(u))
        : /^turn/i.test(b.urls);
      return Number(bTurn) - Number(aTurn);
    });
    const hasStun = normalized.some(entry => {
      return Array.isArray(entry.urls)
        ? entry.urls.some(u => /^stun/i.test(u))
        : /^stun/i.test(entry.urls);
    });
    if (!hasStun) normalized.push({ urls: 'stun:stun.l.google.com:19302' });
    return normalized;
  }
}

const iceConfigService = new IceConfigService(
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? `http://${location.hostname}:8787/api/ice-config`
    : '/presence/api/ice-config'
);

function fetchIceServers() {
  return iceConfigService.fetchServers();
}
const params      = new URLSearchParams(location.search);
const ROOM_CODE   = sanitizeRoomCode(params.get('room'));
const PRESENCE_OVERRIDE = params.get('presence');
const DEFAULT_PRESENCE =
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? `ws://${location.hostname}:8787`
    : `${location.origin.replace(/^http/, 'ws')}/presence`;
const PRESENCE_ENDPOINT = PRESENCE_OVERRIDE || DEFAULT_PRESENCE;
const presenceState = { ws: null, id: null, peers: new Map(), reconnectTimer: null, retries: 0 };
const swarmState = { entries: new Map(), requestedPeerIds: new Set() };
let currentSwarmMagnet = null;
const localSeedInfoHashes = new Set();
let deviceName = localStorage.getItem('pipe.deviceName') || defaultDeviceName();
const deviceInfo = detectDeviceInfo();
const presenceStatusEl = document.getElementById('presence-status');
const presenceRoomEl   = document.getElementById('presence-room');
const deviceNameLabel  = document.getElementById('device-name-label');
const deviceNameBtn    = document.getElementById('device-name-btn');
const peerGrid         = document.getElementById('peer-grid');

// ── Swarm catalog storage (metadata only) ─────────────────────────────────────
const SWARM_IDB_NAME    = 'pipe-swarm';
const SWARM_IDB_STORE   = 'entries';
const SWARM_IDB_VERSION = 1;
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
    req.onerror   = () => reject(req.error);
  });
}

async function swarmIDBPut(entry) {
  try {
    const db = await openSwarmDb();
    await new Promise((resolve, reject) => {
      const tx  = db.transaction(SWARM_IDB_STORE, 'readwrite');
      const req = tx.objectStore(SWARM_IDB_STORE).put(entry);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  } catch {}
}

async function swarmIDBGetAll() {
  try {
    const db = await openSwarmDb();
    return await new Promise(resolve => {
      const tx  = db.transaction(SWARM_IDB_STORE, 'readonly');
      const req = tx.objectStore(SWARM_IDB_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => resolve([]);
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
      const tx  = db.transaction(SWARM_IDB_STORE, 'readonly');
      const req = tx.objectStore(SWARM_IDB_STORE).get(infoHash);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => resolve(null);
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
      const tx  = db.transaction(SWARM_IDB_STORE, 'readwrite');
      const req = tx.objectStore(SWARM_IDB_STORE).delete(infoHash);
      req.onsuccess = () => resolve();
      req.onerror   = () => resolve();
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
      fromNickname: deviceName || t('unknownDevice'),
      senderId: null,
      createdAt: row.savedAt,
      catalogOnly: true,
    });
  });
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

// ── Pairing & room state ──────────────────────────────────────────────────────
// pairedIds: Set<peerId string> — loaded from IndexedDB on init
let pairedIds = new Set();
// activeRoomCode: currently connected room (from URL param, generated, or joined)
let activeRoomCode = ROOM_CODE;
let _pairingDb = null;  // IDBDatabase handle

// ── IndexedDB helpers ─────────────────────────────────────────────────────────
const IDB_NAME    = 'pipe-pairing';
const IDB_VERSION = 1;
const IDB_STORE   = 'pairs';

function openPairingDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'peerId' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function idbGetAll() {
  if (!_pairingDb) return [];
  return new Promise((resolve, reject) => {
    const tx  = _pairingDb.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function idbPut(record) {
  if (!_pairingDb) return;
  return new Promise((resolve, reject) => {
    const tx  = _pairingDb.transaction(IDB_STORE, 'readwrite');
    const req = tx.objectStore(IDB_STORE).put(record);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

async function idbDelete(peerId) {
  if (!_pairingDb) return;
  return new Promise((resolve, reject) => {
    const tx  = _pairingDb.transaction(IDB_STORE, 'readwrite');
    const req = tx.objectStore(IDB_STORE).delete(peerId);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

async function loadPairedIds() {
  const records = await idbGetAll();
  pairedIds = new Set(records.map(r => r.peerId));
}

async function pairPeer(peerId, nickname) {
  pairedIds.add(peerId);
  await idbPut({ peerId, nickname, pairedAt: Date.now() });
  renderPeerGrid();
}

async function unpairPeer(peerId) {
  pairedIds.delete(peerId);
  await idbDelete(peerId);
  renderPeerGrid();
}
// ── Cancellation state ────────────────────────────────────────────────────────
let _sendXHR = null, _sendPC = null;   // file send
let _recvPC  = null, _recvAC = null;   // file receive
let _activeSendSession = null;
let _activeRecvSession = null;
let _txtSendPC = null;                 // text send
let _txtRecvAC = null;                 // text receive
const SIG_TIMEOUT      = 8000;   // ms: wait for WebRTC signaling peer
const ICE_TIMEOUT      = 3000;   // ms: max ICE gathering time
const DC_TIMEOUT       = 5000;   // ms: wait for DataChannel open
const MAX_CHUNK_SZ     = 262144; // Upper bound per message (Chrome 126 ≈ 256 KB)
const MIN_CHUNK_SZ     = 65536;  // Safari 16.x では 64 KB 程度が安全
const FLOW_HIGH_MULT   = 32;     // bufferedAmount を chunkSize * 32 まで許容
const FLOW_LOW_MULT    = 8;      // bufferedamountlow が発火する閾値倍率
const CHUNK_PROFILE = (() => {
  const ua = navigator.userAgent || '';
  const isiOS = /iP(hone|ad|od)/.test(ua);
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  const isFirefox = /firefox/i.test(ua);
  const isChromium = /chrome|crios|edg|opr\//i.test(ua);
  if (isiOS || isSafari) return 'safari';
  if (isFirefox) return 'firefox';
  if (isChromium) return 'chromium';
  return 'default';
})();
const ENABLE_RTC_POOL  = false;  // 予備: ピアごとの PC/DC を再利用する実験機能
const RTC_IDLE_TIMEOUT = 30000;  // ms: 再利用セッションのアイドル期限（将来利用）
const RTC_DRAIN_DELAY  = 1500;   // ms: 正常終了時に接続を閉じるまで待つ
const FLOW_STALL_MS    = 1500;   // ms: bufferedAmount が減らないとみなす閾値

// ── Utilities ─────────────────────────────────────────────────────────────────
const randPath = () => Math.random().toString(36).slice(2, 10);
const logSwarm = (...args) => { try { console.debug('[swarm]', ...args); } catch {} };
const localCatalog = new Map();
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(str) {
  let bits = '';
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    bits += idx.toString(2).padStart(5, '0');
  }
  const hex = bits.match(/.{4}/g)?.map(chunk => parseInt(chunk, 2).toString(16)).join('') || '';
  return hex || null;
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

function extractInfoHash(magnetURI) {
  if (!magnetURI) return null;
  const match = magnetURI.match(/xt=urn:btih:([^&]+)/i);
  if (!match) return null;
  const hash = match[1];
  if (hash.length === 40) return hash.toLowerCase();
  if (hash.length === 32) return base32ToHex(hash);
  return null;
}

const fmt = b => {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
};

// Handles: plain path, https://pipe.afjk.jp/path, https://afjk.jp/pipe/#path
const parsePath = v => {
  v = v.trim();
  try {
    const u = new URL(v);
    if (u.hash) return decodeURIComponent(u.hash.slice(1));
    return u.pathname.replace(/^\//, '');
  } catch {}
  return v.replace(/^\//, '');
};

// Receive URL points to this page with hash so receivers also get P2P
const recvUrl = path =>
  location.origin + location.pathname + '#' + encodeURIComponent(path);

function showQR(boxId, wrapId, url) {
  const box = document.getElementById(boxId);
  box.innerHTML = '';
  new QRCode(box, { text: url, width: 120, height: 120, colorDark: '#000', colorLight: '#fff' });
  document.getElementById(wrapId).classList.add('visible');
}
function hideQR(wrapId) {
  document.getElementById(wrapId).classList.remove('visible');
}
function setStatus(id, msg, cls = '') {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = 'status ' + cls;
}
function copyField(fieldId, btnId) {
  const val = document.getElementById(fieldId).value;
  navigator.clipboard.writeText(val).then(() => {
    const btn = document.getElementById(btnId);
    const copyingSpan = btn.querySelector('[data-ja]') || btn.querySelector('[data-en]');
    btn.textContent = t('copying');
    btn.classList.add('copied');
    setTimeout(() => {
      btn.innerHTML = `<span data-ja style="display:${currentLang==='ja'?'':'none'}">${I18N.ja.copy}</span><span data-en style="display:${currentLang==='en'?'':'none'}">${I18N.en.copy}</span>`;
      btn.classList.remove('copied');
    }, 2000);
  });
}

function sanitizeRoomCode(raw) {
  if (!raw) return null;
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9\-]/g, '').slice(0, 24);
  return cleaned || null;
}

function detectDeviceInfo() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('iphone')) return 'iPhone';
  if (ua.includes('ipad')) return 'iPad';
  if (ua.includes('android')) return 'Android';
  if (ua.includes('mac os x')) return 'macOS';
  if (ua.includes('windows')) return 'Windows';
  if (ua.includes('linux')) return 'Linux';
  return 'Browser';
}

function defaultDeviceName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || 'Device';
  return platform.replace(/_/g, ' ');
}

function updateDeviceNameLabel() {
  if (deviceNameLabel) deviceNameLabel.textContent = deviceName;
  if (deviceNameBtn) {
    const key = currentLang === 'ja' ? 'data-ja-title' : 'data-en-title';
    deviceNameBtn.title = deviceNameBtn.getAttribute(key) || '';
  }
}

function editDeviceName() {
  const next = prompt(t('editNamePrompt'), deviceName) || '';
  const cleaned = next.trim().slice(0, 40);
  if (!cleaned) return;
  deviceName = cleaned;
  localStorage.setItem('pipe.deviceName', deviceName);
  updateDeviceNameLabel();
  sendPresenceHello();
}

function buildPresenceUrl() {
  try {
    const url = new URL(PRESENCE_ENDPOINT, location.href);
    // activeRoomCode overrides the URL param (generated/joined room takes priority)
    const room = activeRoomCode;
    if (room && !url.searchParams.get('room')) url.searchParams.set('room', room);
    return url;
  } catch {
    const fallback = new URL('ws://localhost:8787');
    if (activeRoomCode) fallback.searchParams.set('room', activeRoomCode);
    return fallback;
  }
}

function connectPresence() {
  if (!peerGrid || !presenceStatusEl) return;
  const url = buildPresenceUrl();
  presenceStatusEl.textContent = t('presenceConnecting');
  const ws = new WebSocket(url);
  presenceState.ws = ws;
  ws.addEventListener('open', () => {
    if (presenceState.reconnectTimer) {
      clearTimeout(presenceState.reconnectTimer);
      presenceState.reconnectTimer = null;
    }
    presenceState.retries = 0;
    presenceStatusEl.textContent = t('presenceConnected');
    renderPeerGrid();
    sendPresenceHello();
  });
  ws.addEventListener('message', handlePresenceMessage);
  ws.addEventListener('close', () => {
    // Guard against stale close events from intentionally-replaced connections.
    // applyRoomCode / clearRoom call connectPresence() immediately after ws.close(),
    // so presenceState.ws already points to the NEW ws when this fires.
    if (presenceState.ws !== ws) return;
    presenceState.ws = null;
    presenceState.id = null;
    presenceState.retries += 1;
    if (presenceState.reconnectTimer) clearTimeout(presenceState.reconnectTimer);
    if (presenceState.retries <= 3) {
      presenceStatusEl.textContent = t('presenceReconnecting');
      const delay = Math.min(3000 * Math.pow(2, presenceState.retries - 1), 30000);
      presenceState.reconnectTimer = setTimeout(connectPresence, delay);
    } else {
      presenceStatusEl.textContent = t('presenceUnavailable');
    }
  });
  ws.addEventListener('error', () => {});
}

function handlePresenceMessage(ev) {
  let data;
  try {
    data = JSON.parse(ev.data);
  } catch {
    return;
  }
  switch (data.type) {
    case 'welcome':
      {
        const prevId = presenceState.id;
        presenceState.id = data.id;
        updateLocalSwarmOwner(prevId, data.id);
      }
      updateRoomLabel(data.room);
      sendPresenceHello();
      break;
    case 'peers':
      presenceState.peers = new Map((data.peers || []).map(p => [p.id, p]));
      renderPeerGrid();
      requestSwarmSyncFromPeers();
      announceCatalogEntriesOnce();
      pruneSwarmEntries();
      // Auto-select a paired peer if exactly one is present and none selected yet
      if (!selPeerId) {
        const paired = (data.peers || []).filter(p => pairedIds.has(p.id));
        if (paired.length === 1) {
          const p = paired[0];
          selPeerId = p.id;
          document.querySelectorAll('.peer-card').forEach(c => c.classList.remove('selected'));
          document.querySelectorAll('.peer-card').forEach(c => {
            if (c.querySelector('.peer-name')?.textContent === (p.nickname || t('unknownDevice')))
              c.classList.add('selected');
          });
        }
      }
      break;
    case 'handoff':
      handleIncomingHandoff(data);
      break;
    default:
      break;
  }
}

function updateRoomLabel(roomId) {
  if (!presenceRoomEl) return;
  if (activeRoomCode) {
    presenceRoomEl.textContent = t('roomCode')(activeRoomCode);
  } else if (roomId) {
    presenceRoomEl.textContent = t('detectedGrp')(roomId);
  }
}

function sendPresenceHello() {
  if (!presenceState.ws || presenceState.ws.readyState !== WebSocket.OPEN) return;
  presenceState.ws.send(JSON.stringify({
    type: 'hello',
    nickname: deviceName,
    device: deviceInfo,
    capabilities: { file: true, text: true }
  }));
}

function updateSendAllBtns() {
  const count = presenceState.peers.size;
  ['send-all-btn', 'txt-send-all-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.style.display = count > 0 ? '' : 'none';
    btn.textContent = t('sendToAll')(count);
  });
  // Torrent button: show when files are selected (peers optional — magnet can be shared manually)
  const torrentBtn = document.getElementById('torrent-btn');
  if (torrentBtn) {
    torrentBtn.textContent = t('torrentBtn');
    torrentBtn.style.display = selFiles.length > 0 ? '' : 'none';
  }
  // Localise magnet-info buttons
  const copyBtn = document.getElementById('magnet-copy-btn');
  if (copyBtn) copyBtn.textContent = t('torrentCopyMagnet');
  const stopBtn = document.getElementById('torrent-stop-btn');
  if (stopBtn) stopBtn.textContent = t('torrentStop');
}

function renderPeerGrid() {
  if (!peerGrid) return;
  peerGrid.innerHTML = '';
  const peers = Array.from(presenceState.peers.values());
  if (!peers.length) {
    peerGrid.classList.add('empty');
    const empty = document.createElement('div');
    empty.className = 'presence-empty';
    empty.textContent = presenceState.ws ? t('noDevices') : t('notConnected');
    peerGrid.appendChild(empty);
    return;
  }
  peerGrid.classList.remove('empty');
  // Paired peers first, then alphabetical
  const sorted = [...peers].sort((a, b) => {
    const ap = pairedIds.has(a.id) ? 0 : 1;
    const bp = pairedIds.has(b.id) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return (a.nickname || '').localeCompare(b.nickname || '');
  });
  sorted.forEach(peer => {
    const isPaired = pairedIds.has(peer.id);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'peer-card' + (isPaired ? ' paired' : '');

    const left = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'peer-name';
    name.textContent = peer.nickname || t('unknownDevice');
    const meta = document.createElement('div');
    meta.className = 'peer-meta';
    const bits = [];
    if (peer.device) bits.push(peer.device);
    if (peer.lastSeen) bits.push(fmtLastSeen(peer.lastSeen));
    meta.textContent = bits.join(' · ');
    left.appendChild(name);
    left.appendChild(meta);

    const right = document.createElement('div');
    right.className = 'peer-right';

    const action = document.createElement('div');
    action.className = 'peer-action';
    action.textContent = t('peerSend');

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'peer-pair-btn';
    pinBtn.title = isPaired ? t('unpairBtn') : t('pairBtn');
    pinBtn.textContent = isPaired ? '📌' : '📍';
    pinBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (pairedIds.has(peer.id)) {
        unpairPeer(peer.id);
      } else {
        pairPeer(peer.id, peer.nickname || t('unknownDevice'));
      }
    });

    right.append(action, pinBtn);
    card.append(left, right);
    card.addEventListener('click', () => selectPeer(peer.id, peer.nickname || t('unknownDevice')));
    peerGrid.appendChild(card);
  });
  updateSendAllBtns();
}

function fmtLastSeen(ts) {
  const diff = Date.now() - Number(ts || 0);
  if (diff < 10_000) return t('online');
  if (diff < 60_000) return t('secsAgo')(Math.round(diff / 1000));
  if (diff < 3_600_000) return t('minsAgo')(Math.floor(diff / 60_000));
  return t('hoursAgo')(Math.floor(diff / 3_600_000));
}

function selectPeer(peerId, peerName) {
  selPeerId = peerId;
  // highlight selected card
  document.querySelectorAll('.peer-card').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.peer-card').forEach(c => {
    if (c.querySelector('.peer-name')?.textContent === peerName) c.classList.add('selected');
  });

  const activeTab = document.querySelector('.tab.active')?.dataset.tab;

  // show hint
  const hint = document.getElementById('peer-selected-hint');
  if (hint) {
    const readyJa = `${peerName} に送信します`;
    const readyEn = `Ready to send to ${peerName}`;
    if (activeTab === 'text') {
      const hasText = document.getElementById('txt-send').value.trim();
      hint.textContent = hasText
        ? (currentLang === 'ja' ? readyJa : readyEn)
        : (currentLang === 'ja' ? `${peerName} を選択 — テキストを入力してください` : `${peerName} selected — enter text to send`);
    } else {
      hint.textContent = selFiles.length > 0
        ? (currentLang === 'ja' ? readyJa : readyEn)
        : (currentLang === 'ja' ? `${peerName} を選択 — ファイルを選んでください` : `${peerName} selected — choose a file`);
    }
    hint.classList.add('visible');
  }

  if (activeTab === 'text') {
    const text = document.getElementById('txt-send').value.trim();
    if (text) {
      startSendTextToPeer(peerId);
    } else {
      document.getElementById('txt-send').focus();
    }
  } else {
    if (selFiles.length > 0) {
      startSendToPeer(peerId);
    } else {
      document.getElementById('tab-send').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
}

function startSendTextToPeer(peerId) {
  const text = document.getElementById('txt-send').value.trim();
  if (!text) {
    document.getElementById('txt-send').focus();
    return;
  }
  if (!presenceState.ws || presenceState.ws.readyState !== WebSocket.OPEN) {
    setStatus('txt-send-status', t('presenceConnFail'), 'err');
    return;
  }
  const path = randPath();
  presenceState.ws.send(JSON.stringify({
    type: 'handoff',
    targetId: peerId,
    payload: { kind: 'text', path }
  }));
  // reuse sendText flow but with the pre-generated path
  sendTextToPath(path);
}

function startSendToPeer(peerId) {
  if (!selFiles.length) {
    setStatus('send-status', t('selectFileFirst'), 'err');
    return;
  }
  if (!presenceState.ws || presenceState.ws.readyState !== WebSocket.OPEN) {
    setStatus('send-status', t('presenceConnFail'), 'err');
    return;
  }

  const fileInfos = selFiles.map(({ file, path }) => ({
    path,
    filename: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    url: recvUrl(path)
  }));

  if (selFiles.length === 1) {
    // Backward-compatible single-file handoff
    presenceState.ws.send(JSON.stringify({
      type: 'handoff',
      targetId: peerId,
      payload: { kind: 'file', ...fileInfos[0] }
    }));
  } else {
    presenceState.ws.send(JSON.stringify({
      type: 'handoff',
      targetId: peerId,
      payload: {
        kind: 'files',
        path: selFiles[0].path,  // signaling path (first file)
        files: fileInfos
      }
    }));
  }

  setStatus('send-status', t('handoffSent'), 'waiting');
  document.getElementById('prog-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  startSend();
}

// ── Broadcast (send to all peers) ─────────────────────────────────────────────
// Send files to a single peer via P2P or HTTP; no UI side-effects.
async function _sendFilesRawToPeer(fileEntries) {
  const ok = await trySendWebRTCFiles(fileEntries, () => {}, () => {}, () => {}, null);
  if (!ok) {
    for (const { file, path } of fileEntries) {
      await fetch(`${PIPE}/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
        },
        body: file,
      });
    }
  }
}

async function sendFilesToAllPeers() {
  const peers = Array.from(presenceState.peers.values());
  if (!peers.length) return;
  if (!selFiles.length) { setStatus('send-status', t('selectFileFirst'), 'err'); return; }
  if (!presenceState.ws || presenceState.ws.readyState !== WebSocket.OPEN) {
    setStatus('send-status', t('presenceConnFail'), 'err'); return;
  }
  const count = peers.length;
  const allBtn = document.getElementById('send-all-btn');
  if (allBtn) allBtn.disabled = true;
  setStatus('send-status', t('broadcastSending')(count), 'waiting');

  let done = 0;
  const tasks = peers.map(peer => {
    // Each peer gets its own fresh paths so piping-server paths aren't shared
    const freshFiles = selFiles.map(({ file }) => ({ file, path: randPath() }));
    const fileInfos  = freshFiles.map(({ file, path }) => ({
      path, filename: file.name, size: file.size,
      mime: file.type || 'application/octet-stream', url: recvUrl(path),
    }));
    if (freshFiles.length === 1) {
      presenceState.ws.send(JSON.stringify({
        type: 'handoff', targetId: peer.id,
        payload: { kind: 'file', ...fileInfos[0] },
      }));
    } else {
      presenceState.ws.send(JSON.stringify({
        type: 'handoff', targetId: peer.id,
        payload: { kind: 'files', path: freshFiles[0].path, files: fileInfos },
      }));
    }
    return _sendFilesRawToPeer(freshFiles).then(() => {
      done++;
      setStatus('send-status', t('broadcastProgress')(done, count), 'waiting');
    });
  });

  await Promise.allSettled(tasks);
  setStatus('send-status', t('broadcastDone')(count), 'ok');
  if (allBtn) allBtn.disabled = false;
}

async function sendTextToAllPeers() {
  const peers = Array.from(presenceState.peers.values());
  if (!peers.length) return;
  const text = document.getElementById('txt-send').value.trim();
  if (!text) { document.getElementById('txt-send').focus(); return; }
  if (!presenceState.ws || presenceState.ws.readyState !== WebSocket.OPEN) {
    setStatus('txt-send-status', t('presenceConnFail'), 'err'); return;
  }
  const count  = peers.length;
  const allBtn = document.getElementById('txt-send-all-btn');
  if (allBtn) allBtn.disabled = true;
  document.getElementById('txt-send-btn').disabled = true;
  setStatus('txt-send-status', t('broadcastSending')(count), 'waiting');

  const blob = new Blob([text], { type: 'text/plain; charset=utf-8' });
  let done = 0;
  const tasks = peers.map(peer => {
    const path = randPath();
    presenceState.ws.send(JSON.stringify({
      type: 'handoff', targetId: peer.id,
      payload: { kind: 'text', path },
    }));
    return trySendWebRTC(blob, path, () => {}, () => {}, () => {
        setStatus('txt-send-status', t('p2pConnected'), 'waiting');
      })
      .then(ok => ok ? null : fetch(`${PIPE}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: text,
      }))
      .then(() => {
        done++;
        setStatus('txt-send-status', t('broadcastProgress')(done, count), 'waiting');
      });
  });

  await Promise.allSettled(tasks);
  setStatus('txt-send-status', t('broadcastDone')(count), 'ok');
  document.getElementById('txt-send-btn').disabled = false;
  if (allBtn) allBtn.disabled = false;
}

// ── WebTorrent (swarm) ────────────────────────────────────────────────────────
const WT_CDN = '/pipe/vendor/webtorrent@2.8.5.min.js';
const SP_CDN = '/pipe/vendor/simplepeer@9.11.1.min.js';
let _wtClient = null;
let _wtClass  = null;   // WebTorrent constructor (ES module, loaded via import())
let _spLoaded = false;  // SimplePeer UMD loaded via <script> tag → window.SimplePeer

// WebtTorrent: ES Module → must use import()
async function loadWebTorrent() {
  if (_wtClass) return _wtClass;
  const mod = await import(/* webpackIgnore: true */ WT_CDN);
  _wtClass = mod.default ?? mod;
  return _wtClass;
}

// SimplePeer: UMD bundle → sets window.SimplePeer
function loadSimplePeer() {
  if (_spLoaded || window.SimplePeer) { _spLoaded = true; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SP_CDN;
    s.onload  = () => { _spLoaded = true; resolve(); };
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
  if (!entry) return;
  const key = entry.infoHash || entry.magnetURI;
  if (!key) return;
  const existing = swarmState.entries.get(key);
  if (existing) {
    if (entry.fileNames?.length) existing.fileNames = entry.fileNames;
    if (entry.totalBytes) existing.totalBytes = entry.totalBytes;
    if (entry.fromNickname) existing.fromNickname = entry.fromNickname;
    if (entry.createdAt) existing.createdAt = entry.createdAt;
    existing.catalogOnly = Boolean(existing.catalogOnly || entry.catalogOnly);
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
      const torrent = client.seed(files, t => resolve(t));
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
  const stored = localCatalog.get(infoHash);
  localCatalog.delete(infoHash);
  await swarmIDBDelete(infoHash);
  const torrent = findTorrentByInfoHash(infoHash);
  if (torrent) {
    try { torrent.destroy(); } catch {}
  }
  unregisterLocalSeederInfoHash(infoHash);
  // Always broadcast removal to peers — even if never actively seeding (catalog-only after reload),
  // unregisterLocalSeederInfoHash is a no-op and peers would keep the stale entry.
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
    const hasActiveSeeder = Array.from(seeders).some(id => activeIds.has(id));
    if (!hasActiveSeeder) {
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
  let knownInfoHash = infoHash || extractInfoHash(magnetURI);
  const entry = {
    magnetURI,
    fileNames: files.map(f => f?.name || ''),
    fileCount: files.length,
    totalBytes: files.reduce((sum, f) => sum + (f?.size || 0), 0),
    fromNickname: deviceName || t('unknownDevice'),
    senderId: presenceState.id || null,
    infoHash: knownInfoHash,
    createdAt: Date.now(),
    catalogOnly: false,
  };
  currentSwarmMagnet = magnetURI;
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
// Seeder holds pending SimplePeer instances awaiting the receiver's answer
const _wtPendingPeers = new Map();   // `${peerId}:${infoHash}` → { sp, torrent, infoHash }
// Receiver queues offers that arrive before the torrent is ready
const _wtPendingSignals = [];        // { fromId, signal, infoHash }
// Seeder stores original File[] by infoHash for piping-server fallback delivery
const _torrentSeedFiles = new Map(); // infoHash → File[]
const _wtApprovedDownloads = new Set();       // infoHash/magnet keys approved for saving
const _wtCompletedTorrents = new Map();       // key → torrent waiting for approval
const _wtPendingFallbacks = new Map();        // key → pending HTTP fallback payload

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

// Seeder: open a direct SimplePeer connection to each room peer
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
      try { torrent.addPeer(sp); } catch(e) { console.warn('[wt] addPeer:', e.message); }
      _wtPendingPeers.delete(key);
    });
    sp.on('error', e => { console.warn('[wt] sp:', e.message); _wtPendingPeers.delete(key); });
  }
}

// Receiver: handle an offer → create answer → add peer to torrent
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
    try { torrent.addPeer(sp); } catch(e) { console.warn('[wt] addPeer:', e.message); }
  });
  sp.on('error', e => console.warn('[wt] sp:', e.message));
  sp.signal(signal);
}

// Dispatcher called from handleIncomingHandoff for kind:'wt-signal'
async function handleWtSignal(fromId, signal, infoHash = '') {
  await loadSimplePeer().catch(() => {});
  // Case 1: we're the seeder — this is an answer from the receiver
  const key = infoHash ? `${fromId}:${infoHash}` : fromId;
  const pending = _wtPendingPeers.get(key) || _wtPendingPeers.get(fromId);
  if (pending) {
    pending.sp.signal(signal);
    _wtPendingPeers.delete(key);
    _wtPendingPeers.delete(fromId);
    return;
  }
  // Case 2: we're the receiver — this is an offer from the seeder
  if (!_wtClient?.torrents?.length) {
    _wtPendingSignals.push({ fromId, signal, infoHash });
    return;
  }
  // Only fall back to the first torrent when there is exactly one active torrent
  // AND the signal carries no infoHash; with multiple torrents a hashless signal
  // could be misrouted, so keep it pending instead.
  const target = findTorrentByInfoHash(infoHash) ||
    (!infoHash && _wtClient.torrents.length === 1 ? _wtClient.torrents[0] : null);
  if (target) {
    _wtHandleOffer(target, fromId, signal).catch(e => console.warn('[wt] handleOffer:', e?.message));
  } else {
    _wtPendingSignals.push({ fromId, signal, infoHash });
  }
}

function hideMagnetInfo() {
  const el = document.getElementById('magnet-info');
  if (el) el.classList.remove('visible');
}

function showMagnetInfo(magnetURI) {
  const el    = document.getElementById('magnet-info');
  const uri   = document.getElementById('magnet-uri');
  const copy  = document.getElementById('magnet-copy-btn');
  const stop  = document.getElementById('torrent-stop-btn');
  if (!el) return;
  if (uri)  uri.textContent = magnetURI;
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
  const ul  = fmt(torrent.uploadSpeed) + '/s ↑';
  const ratio = torrent.ratio.toFixed(2);
  const peers = torrent.numPeers;
  el.textContent = `${ul}  ratio: ${ratio}  peers: ${peers}`;
}

async function seedFilesAsTorrent() {
  if (!selFiles.length) { setStatus('send-status', t('selectFileFirst'), 'err'); return; }
  const btn = document.getElementById('torrent-btn');
  if (btn) btn.disabled = true;
  setStatus('send-status', t('torrentLoading'), 'waiting');

  let WT;
  try {
    WT = await loadWebTorrent();
  } catch (e) {
    setStatus('send-status', '✗ ' + e.message, 'err');
    if (btn) btn.disabled = false;
    return;
  }

  const client = getWtClient();
  const files  = selFiles.map(({ file }) => file);
  setStatus('send-status', t('torrentSeeding'), 'waiting');

  // Remove any previous torrent for same files before re-seeding
  client.torrents.slice().forEach(t => { try { t.destroy(); } catch {} });

  client.seed(files, torrent => {
    // Suppress tracker connection errors (non-fatal warnings)
    torrent.on('warning', w => console.info('[wt] warning:', w?.message || w));
    torrent.on('error',   e => console.warn('[wt] torrent error:', e?.message || e));
    // Store immediately (infoHash is available before ready) so piping-request
    // that arrives before ready is not dropped.
    _torrentSeedFiles.set(torrent.infoHash, files);
    torrent.once('ready', () => {
      persistLocalArchive(torrent.infoHash, torrent.magnetURI, files);
    });

    const magnetURI = torrent.magnetURI;
    showMagnetInfo(magnetURI);
    publishLocalSwarmEntry(magnetURI, files, torrent.infoHash || null);

    // Re-snapshot peers inside the callback: client.seed() is async (hashing),
    // so peers that joined after the seed() call started would be missed if we
    // used the snapshot captured before the call.
    const peers = Array.from(presenceState.peers.values());

    // Send handoff to all peers in room
    if (peers.length && presenceState.ws?.readyState === WebSocket.OPEN) {
      const fileNames = files.map(f => f.name).join(', ');
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
      // Also connect directly via presence (tracker-free)
      _wtConnectRoomPeers(torrent, peers);
    }
    setStatus('send-status', t('torrentShared'), 'ok');

    // Live upload stats
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
  const infoHashFromMagnet = extractInfoHash(magnetURI) || currentSwarmMagnet;
  const approvalToken = approvalKey || torrentApprovalKey(infoHashFromMagnet, magnetURI);

  // Remove any stale torrent with the same infoHash before re-adding.
  // WebTorrent may auto-destroy a torrent (e.g. timeout with no peers) but keep it
  // in its internal Map, causing client.get() to return a dead reference that blocks
  // client.add(). We always want a fresh torrent so we can wire up SimplePeer.
  const existingTorrent = infoHashFromMagnet
    ? findTorrentByInfoHash(infoHashFromMagnet)
    : (client.torrents.find(t => t.magnetURI === magnetURI) || client.get(magnetURI));
  if (existingTorrent) {
    logSwarm('existing torrent found', {
      infoHash: existingTorrent.infoHash,
      destroyed: existingTorrent.destroyed,
      inList: client.torrents.includes(existingTorrent)
    });
    if (!existingTorrent.destroyed && client.torrents.includes(existingTorrent)) {
      // Active torrent already exists — resume progress or retrigger downloads
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
      // Apply the same shouldDispatch logic as the new-torrent flush: only route
      // signals whose infoHash matches this torrent (or both sides lack a hash).
      // Unmatched signals stay pending for a future torrent.
      const existingHash = existingTorrent.infoHash || null;
      const toDispatch   = _wtPendingSignals.splice(0);
      const stillPending = [];
      toDispatch.forEach(({ fromId, signal, infoHash }) => {
        const signalHasHash  = !!infoHash;
        const torrentHasHash = !!existingHash;
        const shouldDispatch =
          (torrentHasHash && signalHasHash && infoHash === existingHash) ||
          (!torrentHasHash && !signalHasHash);
        if (shouldDispatch) {
          _wtHandleOffer(existingTorrent, fromId, signal).catch(e => console.warn('[wt] handleOffer:', e?.message));
        } else {
          stillPending.push({ fromId, signal, infoHash });
        }
      });
      if (stillPending.length) _wtPendingSignals.push(...stillPending);
      return existingTorrent;
    }
    // Stale/destroyed reference — remove before re-adding
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

  // client.add() returns the torrent synchronously; the callback fires only after
  // metadata is fetched — which requires peers. We must wire up SimplePeer BEFORE
  // the callback, otherwise we have a deadlock (no peers → no metadata → no callback
  // → no peers).
  logSwarm('client.add', magnetURI);
  const torrent = client.add(magnetURI);

  torrent.on('warning', w => console.info('[wt] warning:', w?.message || w));
  torrent.on('error',   e => { if (!torrent.done) setStatus('recv-status', '✗ ' + (e?.message || e), 'err'); });

  // Piping-server fallback: if no peers connect within 30 s, request HTTP delivery from seeder
  if (senderId) {
    const _fallbackTimer = setTimeout(() => {
      if (torrent.done || torrent.destroyed || torrent.numPeers > 0) return;
      const basePath = Math.random().toString(36).slice(2, 10);
      presenceState.ws?.send(JSON.stringify({
        type: 'handoff', targetId: senderId,
        payload: { kind: 'torrent-piping-request', infoHash: torrent.infoHash, basePath },
      }));
      setStatus('recv-status', t('torrentFallback'), 'waiting');
    }, 30_000);
    torrent.on('wire',    () => clearTimeout(_fallbackTimer));
    torrent.on('done',    () => clearTimeout(_fallbackTimer));
    torrent.on('destroy', () => clearTimeout(_fallbackTimer));
  }

  torrent.on('download', () => {
    const p  = Math.round(torrent.progress * 100);
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

  // Process any wt-signal offers already queued
  const targetHash = torrent.infoHash || null;
  if (_wtPendingSignals.length) {
    logSwarm('flushing pending signals', { count: _wtPendingSignals.length, targetHash });
    const remaining = [];
    _wtPendingSignals.forEach(({ fromId, signal, infoHash }) => {
      // Only dispatch a pending signal to this torrent when:
      //   - both sides have a known infoHash AND they match, OR
      //   - the signal carries no infoHash but targetHash is also absent
      //     (legacy / unknown hash on both sides — best-effort match).
      // Signals with a non-empty infoHash that does NOT match this torrent
      // are kept for a future torrent; signals with an empty infoHash but
      // a known targetHash are ambiguous and kept rather than misrouted.
      const signalHasHash  = !!infoHash;
      const torrentHasHash = !!targetHash;
      const shouldDispatch =
        (torrentHasHash && signalHasHash && infoHash === targetHash) ||
        (!torrentHasHash && !signalHasHash);
      if (shouldDispatch) {
        _wtHandleOffer(torrent, fromId, signal).catch(e => console.warn('[wt] handleOffer:', e?.message));
      } else {
        remaining.push({ fromId, signal, infoHash });
      }
    });
    _wtPendingSignals.splice(0, _wtPendingSignals.length, ...remaining);
  }
}

function triggerTorrentDownloads(torrent) {
  console.trace('[dbg]call triggerTorrentDownloads') 
  
  if (!torrent?.files) return;
  torrent.files.forEach(file => {
    if (!file) return;
    if (typeof file.blob === 'function') {
      console.trace('[dbg]call triggerTorrentDownloads file.blob') 
      file.blob().then(blob => triggerDownload(blob, file.name)).catch(() => {});
    } else if (typeof file.getBlob === 'function') {
      console.trace('[dbg]call triggerTorrentDownloads file.getBlob') 
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
        const timer = setTimeout(() => ac.abort(), 120_000); // 2 min timeout per file
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

async function handleIncomingHandoff(msg) {
  const payload = msg.payload || {};
  const sender  = msg.from?.nickname || t('stranger');

  if (payload.kind === 'swarm-publish') {
    addSwarmEntry(payload.entry, sender);
    return;
  }
  if (payload.kind === 'swarm-catalog') {
    addSwarmEntry({ ...payload.entry, catalogOnly: true, senderId: null }, sender);
    return;
  }
  if (payload.kind === 'swarm-sync') {
    (payload.entries || []).forEach(entry => addSwarmEntry(entry, entry?.fromNickname || sender));
    return;
  }
  if (payload.kind === 'swarm-request') {
    const requesterId = msg.from?.id;
    if (requesterId) sendSwarmSync(requesterId);
    return;
  }
  if (payload.kind === 'swarm-join' && payload.magnetURI) {
    const requesterId = msg.from?.id;
    if (!requesterId) return;
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
      if (!torrent) return;
      const peer = presenceState.peers.get(requesterId) || { id: requesterId };
      _wtConnectRoomPeers(torrent, [peer]);
    } catch {}
    return;
  }
  if (payload.kind === 'swarm-seeder') {
    const infoHash = payload.infoHash || extractInfoHash(payload.magnetURI);
    const peerId   = payload.peerId || msg.from?.id;
    updateEntrySeeder(infoHash, peerId, payload.active);
    return;
  }

  if (payload.kind === 'torrent') {
    const entry = addSwarmEntry(payload, sender);
    const approvalKey = entry
      ? torrentApprovalKey(entry.infoHash, entry.magnetURI)
      : torrentApprovalKey(payload.infoHash, payload.magnetURI);
    const label = payload.fileCount > 1
      ? t('filesLabel')(payload.fileCount)
      : (payload.fileNames || t('fileGeneric'));
    const prompt = currentLang === 'ja'
      ? `${t('torrentIncoming')(sender, label)} — ${t('swarmHeading')}で「${t('swarmDownload')}」を押すと受信が始まります`
      : `${t('torrentIncoming')(sender, label)} — Open “${t('swarmHeading')}” and press “${t('swarmDownload')}” to download.`;
    setStatus('recv-status', prompt, 'waiting');
    switchTab('receive');
    receiveTorrent(payload.magnetURI, sender, msg.from?.id, { autoDownload: false, approvalKey });
    return;
  }

  // Seeder: receiver requests HTTP fallback delivery when WebTorrent stalled
  if (payload.kind === 'torrent-piping-request') {
    const files = _torrentSeedFiles.get(payload.infoHash);
    const requesterId = msg.from?.id;
    if (!files || !files.length || !requesterId) return;
    const basePath = payload.basePath || Math.random().toString(36).slice(2, 10);
    files.forEach((file, i) => {
      fetch(`${PIPE}/${basePath}-${i}`, { method: 'POST', body: file }).catch(() => {});
    });
    presenceState.ws?.send(JSON.stringify({
      type: 'handoff', targetId: requesterId,
      payload: {
        kind: 'torrent-piping-ready',
        infoHash: payload.infoHash,
        files: files.map((f, i) => ({
          url: `${PIPE}/${basePath}-${i}`,
          name: f.name,
          size: f.size,
          mime: f.type || 'application/octet-stream',
        })),
      },
    }));
    return;
  }

  // Receiver: seeder confirmed HTTP delivery — download files from piping-server
  if (payload.kind === 'torrent-piping-ready') {
    const key = torrentApprovalKey(payload.infoHash, null);
    if (key && !_wtApprovedDownloads.has(key)) {
      _wtPendingFallbacks.set(key, payload);
      logSwarm('queued fallback download until approval', { key });
      return;
    }
    startFallbackDownload(payload);
    return;
  }

  if (payload.kind === 'wt-signal') {
    const fromId = msg.from?.id;
    if (fromId) handleWtSignal(fromId, payload.signal, payload.infoHash || '');
    return;
  }

  if (!payload.path) return;

  if (payload.kind === 'text') {
    switchTab('text');
    const input = document.getElementById('txt-recv-path');
    input.value = payload.path;
    setStatus('txt-recv-status',
      currentLang === 'ja' ? `${sender} からテキストが届きます…` : `Receiving text from ${sender}…`,
      'waiting');
    receiveText(sender);
    return;
  }

  if (payload.kind === 'files') {
    const count = payload.files?.length || 0;
    const label = count > 1 ? t('filesLabel')(count) : t('fileGeneric');
    switchTab('receive');
    const input = document.getElementById('recv-path');
    input.value = payload.path;
    document.getElementById('recv-btn').disabled = false;
    setStatus('recv-status', t('incomingFile')(sender, label), 'waiting');
    startReceiveFiles(payload.path, payload.files, sender);
    return;
  }

  // kind: 'file' (single file, backward compat)
  const label = payload.filename ? t('fileLabel')(payload.filename) : t('fileGeneric');
  switchTab('receive');
  const input = document.getElementById('recv-path');
  input.value = payload.path;
  document.getElementById('recv-btn').disabled = false;
  setStatus('recv-status', t('incomingFile')(sender, label), 'waiting');
  startReceive(sender);
}

// ── Room code management ──────────────────────────────────────────────────────
function randRoomCode() {
  // 6-char alphanumeric, easy to share verbally
  return Math.random().toString(36).slice(2, 8);
}

function roomUrl(code) {
  const u = new URL(location.href);
  u.search = '';
  u.hash   = '';
  u.searchParams.set('room', code);
  return u.toString();
}

function applyRoomCode(code) {
  activeRoomCode = code;
  // Sync URL so reloading stays in the same room
  const u = new URL(location.href);
  u.searchParams.set('room', code);
  history.replaceState(null, '', u.toString());
  // Reconnect with new room
  if (presenceState.ws) {
    presenceState.ws.close();
    presenceState.ws = null;
  }
  presenceState.retries = 0;
  connectPresence();
  renderRoomSection();
}

function generateRoom() {
  applyRoomCode(randRoomCode());
}

function joinRoom(code) {
  const cleaned = sanitizeRoomCode(code);
  if (!cleaned) return;
  applyRoomCode(cleaned);
}

function clearRoom() {
  activeRoomCode = null;
  // Remove room param from URL so reloading does not re-join
  const u = new URL(location.href);
  u.searchParams.delete('room');
  history.replaceState(null, '', u.toString());
  if (presenceState.ws) {
    presenceState.ws.close();
    presenceState.ws = null;
  }
  presenceState.retries = 0;
  connectPresence();
  renderRoomSection();
}

function copyRoomUrl() {
  if (!activeRoomCode) return;
  navigator.clipboard.writeText(roomUrl(activeRoomCode)).then(() => {
    const btn = document.getElementById('room-copy-btn');
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = t('roomUrlCopied');
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }).catch(() => {});
}

function renderRoomSection() {
  const el = document.getElementById('room-section');
  if (!el) return;
  el.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'room-section';

  const label = document.createElement('div');
  label.className = 'presence-label';
  label.textContent = t('roomLabel');
  wrap.appendChild(label);

  if (activeRoomCode) {
    const row = document.createElement('div');
    row.className = 'room-row';

    const chip = document.createElement('span');
    chip.className = 'room-chip';
    chip.textContent = activeRoomCode;
    row.appendChild(chip);

    const copyBtn = document.createElement('button');
    copyBtn.id = 'room-copy-btn';
    copyBtn.className = 'room-btn';
    copyBtn.textContent = t('roomCopyUrl');
    copyBtn.addEventListener('click', copyRoomUrl);
    row.appendChild(copyBtn);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'room-btn danger';
    clearBtn.textContent = t('roomClear');
    clearBtn.addEventListener('click', clearRoom);
    row.appendChild(clearBtn);

    wrap.appendChild(row);
  } else {
    const row = document.createElement('div');
    row.className = 'room-row';

    const genBtn = document.createElement('button');
    genBtn.className = 'room-btn';
    genBtn.textContent = t('roomGenerate');
    genBtn.addEventListener('click', generateRoom);
    row.appendChild(genBtn);
    wrap.appendChild(row);

    const joinRow = document.createElement('div');
    joinRow.className = 'room-join-row';

    const input = document.createElement('input');
    input.className = 'room-input';
    input.placeholder = t('roomJoinPlaceholder');
    input.maxLength = 24;
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') joinRoom(input.value);
    });
    joinRow.appendChild(input);

    const joinBtn = document.createElement('button');
    joinBtn.className = 'room-btn';
    joinBtn.textContent = t('roomJoin');
    joinBtn.addEventListener('click', () => joinRoom(input.value));
    joinRow.appendChild(joinBtn);

    wrap.appendChild(joinRow);
  }

  el.appendChild(wrap);
}

// ── Presence init ─────────────────────────────────────────────────────────────
function initPresence() {
  if (!peerGrid || !presenceStatusEl) return;
  updateDeviceNameLabel();
  if (deviceNameBtn) deviceNameBtn.addEventListener('click', editDeviceName);
  renderRoomSection();
  connectPresence();
}

async function initPresenceWithDb() {
  try {
    _pairingDb = await openPairingDb();
    await loadPairedIds();
  } catch (e) {
    // IndexedDB unavailable (private mode etc.) — degrade gracefully
  }
  initPresence();
}

initPresenceWithDb();

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === 'tab-' + name);
  });
}

// ── Google Drive Picker ───────────────────────────────────────────────────────
let _gdriveLoaded = false;
let _gdriveToken  = null;
let _gdriveTokenExpiry = 0;
let _gdriveTokenClient = null;

async function loadGoogleAPIs() {
  if (_gdriveLoaded) return;
  // Load gapi
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
  await new Promise(resolve => gapi.load('picker', resolve));
  // Load GIS
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
  _gdriveLoaded = true;
}

function requestGoogleToken() {
  return new Promise((resolve, reject) => {
    if (_gdriveToken && Date.now() < _gdriveTokenExpiry) { resolve(_gdriveToken); return; }
    if (!_gdriveTokenClient) {
      _gdriveTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GDRIVE_CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        callback: () => {},  // replaced below
      });
    }
    // Always update the callback so the current Promise's resolve/reject are wired up.
    _gdriveTokenClient.callback = resp => {
      if (resp.error) { reject(new Error(resp.error)); return; }
      _gdriveToken = resp.access_token;
      _gdriveTokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
      resolve(_gdriveToken);
    };
    _gdriveTokenClient.requestAccessToken({ prompt: _gdriveToken ? '' : 'select_account' });
  });
}

// Google Workspace MIME → export MIME + extension
const GDRIVE_EXPORT_MAP = {
  'application/vnd.google-apps.document':     { mime: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.spreadsheet':  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.drawing':      { mime: 'image/png', ext: '.png' },
};

async function downloadDriveFiles(pickedDocs, token) {
  const files = [];
  for (const doc of pickedDocs) {
    const { id, name, mimeType } = doc;
    const exportInfo = GDRIVE_EXPORT_MAP[mimeType];
    let url, finalMime, finalName;
    if (exportInfo) {
      url = `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportInfo.mime)}`;
      finalMime = exportInfo.mime;
      finalName = name.replace(/\.[^.]*$/, '') + exportInfo.ext;
    } else {
      url = `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
      finalMime = mimeType || 'application/octet-stream';
      finalName = name;
    }
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    const blob = await resp.blob();
    files.push(new File([blob], finalName, { type: finalMime }));
  }
  return files;
}

function _openPickerWithToken(token) {
  return new Promise((resolve, reject) => {
    const btn = document.getElementById('gdrive-btn');
    const origContent = btn.innerHTML;
    function restoreBtn() {
      btn.disabled = false;
      btn.innerHTML = origContent;
      languageManager.setLang(currentLang);
    }
    const picker = new google.picker.PickerBuilder()
      .addView(new google.picker.DocsView()
        .setIncludeFolders(false)
        .setSelectFolderEnabled(false))
      .setOAuthToken(token)
      .setDeveloperKey(GDRIVE_API_KEY)
      .setCallback(async data => {
        if (data.action === google.picker.Action.CANCEL) { restoreBtn(); resolve(); return; }
        if (data.action !== google.picker.Action.PICKED) return;
        try {
          btn.disabled = true;
          btn.textContent = t('gdriveDownloading');
          const files = await downloadDriveFiles(data.docs, token);
          setFiles(files);
          restoreBtn();
          setStatus('send-status', t('gdriveDone')(files.length), 'ok');
          resolve();
        } catch (e) {
          restoreBtn();
          setStatus('send-status', t('gdriveError')(e.message), 'err');
          reject(e);
        }
      })
      .build();
    picker.setVisible(true);
  });
}

// Fast-path (iOS-safe): no await at all before picker.setVisible(true).
// Called synchronously from the click handler when APIs + token are ready.
function openGoogleDrivePicker() {
  if (_gdriveLoaded && _gdriveToken && Date.now() < _gdriveTokenExpiry) {
    // Both APIs loaded and token cached: open picker with ZERO awaits.
    _openPickerWithToken(_gdriveToken).catch(() => {});
    return;
  }
  // Slow path: need to load APIs and/or authenticate (async, gesture consumed).
  _openGoogleDrivePickerAsync();
}

async function _openGoogleDrivePickerAsync() {
  const btn = document.getElementById('gdrive-btn');
  const origContent = btn.innerHTML;

  function restoreBtn() {
    btn.disabled = false;
    btn.innerHTML = origContent;
    languageManager.setLang(currentLang);
  }

  try {
    btn.disabled = true;
    btn.textContent = '…';
    await loadGoogleAPIs();

    // If token was cached while loading APIs, prompt user to tap again
    // (gesture is already consumed by the await above).
    if (_gdriveToken && Date.now() < _gdriveTokenExpiry) {
      restoreBtn();
      setStatus('send-status',
        currentLang === 'ja' ? 'もう一度タップしてファイルを選択してください' : 'Tap again to select a file',
        'ok');
      return;
    }

    // First-time: OAuth popup consumes this gesture.
    // After auth, show a hint and let next tap open the Picker.
    await requestGoogleToken();
    restoreBtn();
    setStatus('send-status',
      currentLang === 'ja' ? 'もう一度タップしてファイルを選択してください' : 'Tap again to select a file',
      'ok');
  } catch (e) {
    restoreBtn();
    if (e?.message !== 'popup_closed_by_user' && e?.message !== 'access_denied') {
      setStatus('send-status', t('gdriveError')(e?.message || e), 'err');
    }
  }
}

document.getElementById('gdrive-btn').addEventListener('click', openGoogleDrivePicker);

// ── Drop zone ─────────────────────────────────────────────────────────────────
const dz = document.getElementById('dropzone');
const fi = document.getElementById('file-input');
let selFiles = [], selPeerId = null;  // selFiles: [{file, path}]

dz.addEventListener('click', async () => {
  if (window.showOpenFilePicker) {
    try {
      const handles = await window.showOpenFilePicker({ multiple: true });
      const files = await Promise.all(handles.map(h => h.getFile()));
      setFiles(files);
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  fi.click();
});
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', e => {
  e.preventDefault(); dz.classList.remove('over');
  if (e.dataTransfer.files.length) setFiles(Array.from(e.dataTransfer.files));
});
fi.addEventListener('change', () => { if (fi.files.length) setFiles(Array.from(fi.files)); });

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Preview System (T3/T4/T5/T6/T9) ──────────────────────────────────────────

// T3: Detect preview kind from filename + MIME type
function previewKind(name, mime) {
  const ext = (name || '').split('.').pop().toLowerCase();
  const m   = (mime || '').toLowerCase();
  if (m.startsWith('image/') || /^(jpg|jpeg|png|gif|webp|avif|svg|bmp|ico)$/.test(ext)) return 'image';
  if (m.startsWith('video/') || /^(mp4|webm|ogg|ogv|mov|avi|mkv)$/.test(ext))           return 'video';
  if (m.startsWith('audio/') || /^(mp3|wav|ogg|oga|flac|aac|m4a|opus)$/.test(ext))      return 'audio';
  if (m === 'application/pdf' || ext === 'pdf')                                           return 'pdf';
  if (/^(glb|gltf)$/.test(ext) || /gltf/.test(m) || m === 'model/gltf-binary')          return 'model3d';
  if (/^(md|markdown)$/.test(ext) || m === 'text/markdown')                             return 'markdown';
  if (ext === 'csv' || m === 'text/csv')                                                return 'csv';
  if (m.startsWith('text/') || /^(txt|log|json|xml|yaml|yml|toml|ini|sh|py|js|ts|html|css|rs|go|java|c|cpp|h)$/.test(ext)) return 'text';
  return null;
}

// T6: Object URL tracking
const _previewUrls = new Set();
function _createPreviewUrl(blob) {
  const url = URL.createObjectURL(blob);
  _previewUrls.add(url);
  return url;
}
function _revokePreviewUrl(url) {
  URL.revokeObjectURL(url);
  _previewUrls.delete(url);
}

// T4: Preview Registry
const PreviewRegistry = (() => {
  const _providers = [];
  return {
    register(p) { _providers.push(p); },
    find(kind)  { return _providers.find(p => p.kinds.includes(kind)); }
  };
})();

// T5: Modal open/close
let _modalCleanup = null;
function openPreviewModal(title, renderFn) {
  if (_modalCleanup) { _modalCleanup(); _modalCleanup = null; }
  const overlay = document.getElementById('preview-modal-overlay');
  const body    = document.getElementById('preview-modal-body');
  document.getElementById('preview-modal-title').textContent = title;
  body.innerHTML = '';
  _modalCleanup = renderFn(body) || null;
  overlay.style.display = 'flex';
}
function closePreviewModal(e) {
  if (e && e.target !== document.getElementById('preview-modal-overlay')) return;
  document.getElementById('preview-modal-overlay').style.display = 'none';
  if (_modalCleanup) { _modalCleanup(); _modalCleanup = null; }
  document.getElementById('preview-modal-body').innerHTML = '';
}

// T9: Image provider
PreviewRegistry.register({
  kinds: ['image'],
  thumb(url, meta, onClick) {
    const img = Object.assign(document.createElement('img'), {
      src: url, className: 'preview-thumb'
    });
    return _a11yBtn(img, onClick, meta.name);
  },
  renderDetail(container, url, meta) {
    const wrap = document.createElement('div');
    wrap.className = 'img-edit-wrap';

    const imgEl = Object.assign(document.createElement('img'), { src: url });
    wrap.appendChild(imgEl);

    const toolbar = document.createElement('div');
    toolbar.className = 'img-edit-toolbar';

    const removeBgBtn = document.createElement('button');
    removeBgBtn.className = 'img-edit-btn';
    removeBgBtn.textContent = currentLang === 'ja' ? '✂ 背景を削除' : '✂ Remove BG';

    const progressEl = document.createElement('span');
    progressEl.className = 'img-edit-progress';

    let _resultBlob = null;
    let _resultUrl = null;
    let _disposed = false;

    removeBgBtn.addEventListener('click', async () => {
      removeBgBtn.disabled = true;
      progressEl.textContent = currentLang === 'ja' ? 'モデル読み込み中…' : 'Loading model…';
      try {
        const { removeBackground } = await import('https://esm.sh/@imgly/background-removal@1.7.0?target=es2022');
        if (_disposed) return;
        progressEl.textContent = currentLang === 'ja' ? '処理中…' : 'Processing…';
        const blob = await removeBackground(url, {
          progress(key, cur, total) {
            if (total > 0) progressEl.textContent = `${Math.round(cur / total * 100)}%`;
          }
        });
        if (_disposed) return;
        if (_resultUrl) URL.revokeObjectURL(_resultUrl);
        _resultBlob = blob;
        _resultUrl = URL.createObjectURL(blob);

        let resultImg = wrap.querySelector('.img-edit-result');
        if (!resultImg) {
          resultImg = Object.assign(document.createElement('img'), { className: 'img-edit-result' });
          wrap.insertBefore(resultImg, toolbar);
        }
        resultImg.src = _resultUrl;

        const safeName = (meta && meta.name ? meta.name.replace(/\.[^.]+$/, '') : 'image')
          .replace(/[/\\?%*:|"<>]/g, '_');
        const filename = safeName + '_nobg.png';

        let saveBtn = toolbar.querySelector('.img-edit-dl-btn');
        if (!saveBtn) {
          saveBtn = document.createElement('button');
          saveBtn.className = 'img-edit-btn img-edit-dl-btn';
          toolbar.appendChild(saveBtn);
        }
        saveBtn.onclick = async () => {
          if (!_resultBlob) return;
          const file = new File([_resultBlob], filename, { type: 'image/png' });
          if (_isMobile && navigator.canShare) {
            try {
              if (navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title: filename });
                return;
              }
            } catch (e) {
              if (e.name === 'AbortError') return;
              // その他のエラーはダウンロードにフォールバック
            }
          }
          _fallbackDownload(_resultUrl, filename);
        };
        saveBtn.textContent = _isMobile
          ? (currentLang === 'ja' ? '📤 フォトに保存' : '📤 Save to Photos')
          : (currentLang === 'ja' ? '⬇ ダウンロード' : '⬇ Download');

        let sendBtn = toolbar.querySelector('.img-edit-send-btn');
        if (!sendBtn) {
          sendBtn = document.createElement('button');
          sendBtn.className = 'img-edit-btn img-edit-send-btn';
          toolbar.appendChild(sendBtn);
        }
        sendBtn.onclick = () => {
          if (!_resultBlob) return;
          const file = new File([_resultBlob], filename, { type: 'image/png' });
          closePreviewModal();
          setFiles([file]);
          switchTab('send');
        };
        sendBtn.textContent = currentLang === 'ja' ? '➤ 送信' : '➤ Send';

        progressEl.textContent = '';
        removeBgBtn.disabled = false;
        removeBgBtn.textContent = currentLang === 'ja' ? '↺ 再実行' : '↺ Retry';
      } catch (err) {
        if (_disposed) return;
        progressEl.textContent = err?.message || String(err ?? 'Error');
        removeBgBtn.disabled = false;
      }
    });

    toolbar.appendChild(removeBgBtn);
    toolbar.appendChild(progressEl);
    wrap.appendChild(toolbar);
    container.appendChild(wrap);
    return () => {
      _disposed = true;
      if (_resultUrl) URL.revokeObjectURL(_resultUrl);
    };
  }
});

function _fallbackDownload(url, filename) {
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
const _isMobile = navigator.userAgentData?.mobile ??
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// T9: Video provider
PreviewRegistry.register({
  kinds: ['video'],
  thumb(url, meta, onClick) {
    const el = document.createElement('div');
    el.className = 'preview-thumb-icon';
    el.textContent = '🎬';
    return _a11yBtn(el, onClick, meta.name);
  },
  renderDetail(container, url) {
    const v = Object.assign(document.createElement('video'), {
      src: url, controls: true
    });
    container.appendChild(v);
    return () => { v.pause(); v.src = ''; };
  }
});

// T9: Audio provider
PreviewRegistry.register({
  kinds: ['audio'],
  thumb(url, meta, onClick) {
    const el = document.createElement('div');
    el.className = 'preview-thumb-icon';
    el.textContent = '🎵';
    return _a11yBtn(el, onClick, meta.name);
  },
  renderDetail(container, url) {
    const a = Object.assign(document.createElement('audio'), {
      src: url, controls: true
    });
    container.appendChild(a);
    return () => { a.pause(); a.src = ''; };
  }
});

// Accessibility: make any element act as a keyboard-accessible button
function _a11yBtn(el, onClick, label) {
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  if (label) el.setAttribute('aria-label', label);
  el.addEventListener('click', onClick);
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } });
  return el;
}

// T13: Size limits
const PREVIEW_MAX_BYTES = 30 * 1024 * 1024; // 30 MB – skip preview above this

// T10: PDF provider (uses browser built-in PDF viewer via iframe)
PreviewRegistry.register({
  kinds: ['pdf'],
  thumb(url, meta, onClick) {
    const el = document.createElement('div');
    el.className = 'preview-thumb-icon preview-thumb-pdf';
    el.textContent = 'PDF';
    return _a11yBtn(el, onClick, meta.name);
  },
  renderDetail(container, url) {
    const iframe = Object.assign(document.createElement('iframe'), {
      src: url,
      title: 'PDF preview',
      referrerPolicy: 'no-referrer',
      sandbox: 'allow-same-origin allow-scripts allow-downloads'
    });
    container.style.padding = '0';
    container.appendChild(iframe);
    return () => { iframe.src = ''; };
  }
});

// T12: Text provider
PreviewRegistry.register({
  kinds: ['text'],
  thumb(url, meta, onClick) {
    const el = document.createElement('div');
    el.className = 'preview-thumb-icon';
    el.textContent = '📝';
    return _a11yBtn(el, onClick, meta.name);
  },
  renderDetail(container, url) {
    const ac = new AbortController();
    const pre = document.createElement('pre');
    pre.className = 'preview-text-pre';
    pre.textContent = '…';
    container.style.alignItems = 'flex-start';
    container.appendChild(pre);
    fetch(url, { signal: ac.signal })
      .then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(text => {
        const LIMIT = 100_000;
        pre.textContent = text.length > LIMIT
          ? text.slice(0, LIMIT) + '\n' + t('previewTruncated')(LIMIT)
          : text;
      })
      .catch(e => { if (e.name !== 'AbortError') pre.textContent = t('previewLoadError'); });
    return () => ac.abort();
  }
});

// T12: Markdown provider (lazy-loads marked + DOMPurify)
PreviewRegistry.register({
  kinds: ['markdown'],
  thumb(url, meta, onClick) {
    const el = document.createElement('div');
    el.className = 'preview-thumb-icon';
    el.textContent = '📋';
    return _a11yBtn(el, onClick, meta.name);
  },
  renderDetail(container, url) {
    const ac = new AbortController();
    let disposed = false;
    const div = document.createElement('div');
    div.className = 'preview-md-body';
    div.textContent = '…';
    container.style.alignItems = 'flex-start';
    container.appendChild(div);

    const loadLib = (varName, src) => varName in window
      ? Promise.resolve()
      : new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = src;
          s.onload = res;
          s.onerror = () => rej(new Error(`Failed to load ${src}`));
          document.head.appendChild(s);
        });

    (async () => {
      try {
        const r = await fetch(url, { signal: ac.signal });
        if (!r.ok) throw new Error(r.status);
        const text = await r.text();
        await Promise.all([
          loadLib('marked',     'https://cdn.jsdelivr.net/npm/marked/marked.min.js'),
          loadLib('DOMPurify',  'https://cdn.jsdelivr.net/npm/dompurify/dist/purify.min.js')
        ]);
        if (disposed || !div.isConnected) return;
        div.innerHTML = DOMPurify.sanitize(marked.parse(text));
      } catch (e) {
        if (e.name === 'AbortError') return;
        if (!disposed && div.isConnected) div.textContent = t('previewLoadError');
      }
    })();

    return () => { disposed = true; ac.abort(); };
  }
});

// T12: CSV provider
PreviewRegistry.register({
  kinds: ['csv'],
  thumb(url, meta, onClick) {
    const el = document.createElement('div');
    el.className = 'preview-thumb-icon';
    el.textContent = '📊';
    return _a11yBtn(el, onClick, meta.name);
  },
  renderDetail(container, url) {
    const ac = new AbortController();
    const wrap = document.createElement('div');
    wrap.className = 'preview-csv-wrap';
    wrap.textContent = '…';
    container.style.alignItems = 'flex-start';
    container.appendChild(wrap);

    const parseCsv = (input, maxRows) => {
      const rows = []; let row = [], cell = '', inQ = false, started = false;
      const pushCell = () => { row.push(cell); cell = ''; started = true; };
      const pushRow  = () => { row.push(cell); rows.push(row); row = []; cell = ''; started = false; };
      for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (c === '"') {
          if (inQ && input[i + 1] === '"') { cell += '"'; i++; }
          else if (inQ) { inQ = false; }
          else if (cell === '') { inQ = true; started = true; }
          else { cell += c; started = true; }
          continue;
        }
        if (c === ',' && !inQ) { pushCell(); continue; }
        if ((c === '\n' || c === '\r') && !inQ) {
          if (c === '\r' && input[i + 1] === '\n') i++;
          if (started || cell || row.length) { pushRow(); if (rows.length >= maxRows) break; }
          continue;
        }
        cell += c; started = true;
      }
      if (rows.length < maxRows && (started || cell || row.length)) pushRow();
      return rows;
    };

    fetch(url, { signal: ac.signal })
      .then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(text => {
        const MAX = 200;
        const rows = parseCsv(text, MAX + 1);
        const table = document.createElement('table');
        table.className = 'preview-csv-table';
        rows.slice(0, MAX).forEach((row, ri) => {
          const tr = document.createElement('tr');
          row.forEach(cell => {
            const td = document.createElement(ri === 0 ? 'th' : 'td');
            td.textContent = cell;
            tr.appendChild(td);
          });
          table.appendChild(tr);
        });
        if (rows.length > MAX) {
          const tr = document.createElement('tr');
          const td = Object.assign(document.createElement('td'), {
            colSpan: 999, textContent: t('previewCsvRows')(MAX)
          });
          td.style.cssText = 'text-align:center;color:var(--muted)';
          tr.appendChild(td); table.appendChild(tr);
        }
        wrap.textContent = '';
        wrap.appendChild(table);
      })
      .catch(e => { if (e.name !== 'AbortError') wrap.textContent = t('previewLoadError'); });

    return () => ac.abort();
  }
});

// T11: GLB/GLTF provider (uses <model-viewer> web component, lazy-loaded)
PreviewRegistry.register({
  kinds: ['model3d'],
  thumb(url, meta, onClick) {
    const el = document.createElement('div');
    el.className = 'preview-thumb-icon';
    el.textContent = '🧊';
    return _a11yBtn(el, onClick, meta.name);
  },
  renderDetail(container, url) {
    let disposed = false;
    const load = () => {
      if (disposed || !container.isConnected) return;
      const mv = document.createElement('model-viewer');
      mv.setAttribute('src', url);
      mv.setAttribute('camera-controls', '');
      mv.setAttribute('auto-rotate', '');
      mv.setAttribute('shadow-intensity', '1');
      mv.style.cssText = 'width:100%;height:65vh;background:#111;border-radius:6px;';
      container.appendChild(mv);
    };
    if (customElements.get('model-viewer')) {
      load();
    } else {
      const s = document.createElement('script');
      s.type = 'module';
      s.src = 'https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js';
      s.onload = load;
      document.head.appendChild(s);
    }
    return () => { disposed = true; };
  }
});

// Build a thumb element for a File/Blob; returns { el, dispose } or null
function buildPreviewThumb(source, name, mime) {
  if (source.size > PREVIEW_MAX_BYTES) return null; // T13: skip large files
  const kind     = previewKind(name, mime);
  const provider = kind && PreviewRegistry.find(kind);
  if (!provider) return null;
  const url = _createPreviewUrl(source);
  const el  = provider.thumb(url, { name, mime }, () => {
    openPreviewModal(name, body => provider.renderDetail(body, url, { name, mime }));
  });
  return { el, dispose: () => _revokePreviewUrl(url) };
}

function renderFileList() {
  const list = document.getElementById('file-list');
  // Dispose any previous preview Object URLs
  if (list._previewDisposers) list._previewDisposers.forEach(d => d());
  list._previewDisposers = [];
  list.innerHTML = '';
  selFiles.forEach(({ file }, i) => {
    const item = document.createElement('div');
    item.className = 'file-list-item';
    item.id = `fli-${i}`;

    const thumb = buildPreviewThumb(file, file.name, file.type || '');
    if (thumb) {
      list._previewDisposers.push(thumb.dispose);
      item.appendChild(thumb.el);
    } else {
      const icon = document.createElement('div');
      icon.className = 'file-list-item-icon';
      icon.textContent = '📄';
      item.appendChild(icon);
    }

    const info = document.createElement('div');
    info.className = 'file-list-item-info';
    info.innerHTML =
      `<div class="file-list-item-name">${escHtml(file.name)}</div>` +
      `<div class="file-list-item-meta">${fmt(file.size)} · ${escHtml(file.type || 'application/octet-stream')}</div>`;
    item.appendChild(info);

    const status = document.createElement('div');
    status.className = 'file-list-item-status';
    status.id = `fli-status-${i}`;
    status.textContent = '—';
    item.appendChild(status);

    if (thumb) {
      const previewBtn = document.createElement('button');
      previewBtn.className = 'preview-open-btn';
      previewBtn.textContent = '👁';
      previewBtn.title = currentLang === 'ja' ? 'プレビュー' : 'Preview';
      previewBtn.addEventListener('click', () => thumb.el.click());
      item.appendChild(previewBtn);
    }

    list.appendChild(item);
  });
  list.classList.add('visible');
}

function setFiles(files) {
  selFiles = files.map(f => ({ file: f, path: randPath() }));
  if (!selFiles.length) return;

  renderFileList();

  // For a single file show URL + QR; for multiple files hide them
  if (selFiles.length === 1) {
    const { file, path } = selFiles[0];
    document.getElementById('file-name').textContent = file.name;
    document.getElementById('file-meta').textContent = fmt(file.size) + ' · ' + (file.type || 'application/octet-stream');
    const url = recvUrl(path);
    document.getElementById('send-url-block').style.display = 'block';
    document.getElementById('send-url').value = url;
    showQR('send-qr-box', 'send-qr-wrap', url);
  } else {
    document.getElementById('send-url-block').style.display = 'none';
    hideQR('send-qr-wrap');
  }

  document.getElementById('send-btn').disabled = false;
  setStatus('send-status', '');
  document.getElementById('prog-wrap').style.display = 'none';
  document.getElementById('prog-bar').style.width = '0%';
  updateSendAllBtns();

  // if peer already selected, auto-start
  if (selPeerId) {
    const hint = document.getElementById('peer-selected-hint');
    if (hint) {
      const card = document.querySelector('.peer-card.selected .peer-name');
      const name = card?.textContent || '';
      hint.textContent = currentLang === 'ja' ? `${name} に送信します` : `Ready to send to ${name}`;
    }
    startSendToPeer(selPeerId);
  }
}

// ── Send ──────────────────────────────────────────────────────────────────────
function _sendStart() {
  document.getElementById('send-btn').disabled      = true;
  document.getElementById('cancel-send-btn').style.display = '';
  document.getElementById('reset-send-btn').style.display  = 'none';
}
function _sendEnd() {
  document.getElementById('send-btn').disabled      = false;
  document.getElementById('cancel-send-btn').style.display = 'none';
  document.getElementById('reset-send-btn').style.display  = '';
  _sendXHR = null; _sendPC = null;
}
function cancelSend() {
  _sendXHR?.abort();
  _sendXHR = null;
  disposeRtcSession(_activeSendSession, { force: true });
  document.getElementById('prog-wrap').style.display = 'none';
  document.getElementById('prog-bar').style.width = '0%';
  setStatus('send-status', t('cancelled'), 'err');
  _sendEnd();
}

async function startSend() {
  if (!selFiles.length) return;
  _sendStart();
  document.getElementById('prog-wrap').style.display = 'block';
  setStatus('send-status', t('sendPreparing'), 'waiting');

  const ok = await trySendWebRTCFiles(selFiles,
    (fileIdx, loaded, total) => {
      const p = Math.round(loaded / total * 100);
      document.getElementById('prog-bar').style.width = p + '%';
      const prefix = selFiles.length > 1 ? t('fileProgress')(fileIdx + 1, selFiles.length) + ': ' : '';
      document.getElementById('prog-text').textContent = `${prefix}${p}%  (${fmt(loaded)} / ${fmt(total)})`;
      if (p > 0) setStatus('send-status', t('transferringP2P'), 'waiting');
      const item = document.getElementById(`fli-${fileIdx}`);
      if (item && !item.classList.contains('done')) item.classList.add('sending');
    },
    fileIdx => {
      const item = document.getElementById(`fli-${fileIdx}`);
      if (item) { item.classList.remove('sending'); item.classList.add('done'); }
      const st = document.getElementById(`fli-status-${fileIdx}`);
      if (st) st.textContent = '✓';
    },
    (totalSent, elapsed) => {
      const speed = elapsed > 0 ? totalSent / elapsed : 0;
      const msg = selFiles.length > 1
        ? t('allDone')(selFiles.length)
        : t('p2pSendDone')(fmt(totalSent), elapsed.toFixed(2), fmt(speed));
      setStatus('send-status', msg, 'ok');
      _sendEnd();
    },
    () => setStatus('send-status', t('sendReady'), 'waiting')
  );

  if (!ok) {
    if (!_sendPC && !_sendXHR && document.getElementById('cancel-send-btn').style.display === 'none') return; // cancelled
    const oversized = selFiles.find(({ file }) => file.size > PIPE_MAX_SIZE);
    if (oversized) {
      setStatus('send-status', t('pipeSizeLimit'), 'err');
      _sendEnd();
      return;
    }
    setStatus('send-status', t('waitingRcvr'), 'waiting');

    let totalSent = 0;
    let anyError = false;
    for (let i = 0; i < selFiles.length; i++) {
      if (anyError) break;
      const { file, path } = selFiles[i];
      const item = document.getElementById(`fli-${i}`);
      const st   = document.getElementById(`fli-status-${i}`);
      if (item) item.classList.add('sending');
      if (st)   st.textContent = '…';
      try {
        await sendHTTP(file, path, i, selFiles.length);
        if (item) { item.classList.remove('sending'); item.classList.add('done'); }
        if (st)   st.textContent = '✓';
        totalSent += file.size;
      } catch {
        anyError = true;
      }
    }
    if (!anyError) {
      const msg = selFiles.length > 1
        ? t('allDone')(selFiles.length)
        : t('transferDone')(fmt(totalSent), '—', '—');
      setStatus('send-status', msg, 'ok');
      _sendEnd();
    }
  }
}

async function sendHTTP(body, path, fileIdx = 0, totalFiles = 1) {
  const controller = new AbortController();
  _sendXHR = controller;
  const total = body.size || 0;
  let uploaded = 0;
  const t0 = performance.now();

  const updateProgress = () => {
    if (!total) return;
    const p = Math.round(uploaded / total * 100);
    document.getElementById('prog-bar').style.width = p + '%';
    const elapsed = (performance.now() - t0) / 1000;
    const speed   = elapsed > 0 ? uploaded / elapsed : 0;
    const prefix  = totalFiles > 1 ? t('fileProgress')(fileIdx + 1, totalFiles) + ': ' : '';
    document.getElementById('prog-text').textContent =
      `${prefix}${p}%  (${fmt(uploaded)} / ${fmt(total)})  ${fmt(speed)}/s`;
    if (p > 0 && p < 100) setStatus('send-status', t('transferring'));
  };

  let requestBody = body;
  if (typeof body.stream === 'function' && typeof ReadableStream === 'function') {
    const reader = body.stream().getReader();
    requestBody = new ReadableStream({
      async pull(ctrl) {
        const { value, done } = await reader.read();
        if (done) { ctrl.close(); return; }
        uploaded += value.byteLength;
        updateProgress();
        ctrl.enqueue(value);
      },
      cancel() {
        reader.releaseLock?.();
      }
    });
  }

  try {
    const res = await fetch(`${PIPE}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': body.type || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(body.name || 'file')}"`
      },
      body: requestBody,
      signal: controller.signal,
    });
    _sendXHR = null;
    if (!res.ok) throw new Error('HTTP upload failed');
    const elapsed = (performance.now() - t0) / 1000;
    const speed   = elapsed > 0 ? total / elapsed : 0;
    document.getElementById('prog-bar').style.width = '100%';
    document.getElementById('prog-text').textContent = totalFiles > 1
      ? t('fileProgress')(fileIdx + 1, totalFiles) + ': 100%'
      : '100%';
    if (totalFiles === 1) {
      setStatus('send-status', t('transferDone')(fmt(total), elapsed.toFixed(2), fmt(speed)), 'ok');
    }
    reportTransfer('pipe', total, {
      transport: 'http',
      files: totalFiles,
      transferMs: Math.round(elapsed * 1000)
    });
  } catch (err) {
    _sendXHR = null;
    if (controller.signal.aborted) return;
    setStatus('send-status', t('transferFail'), 'err');
    _sendEnd();
    throw err;
  }
}

function resetSend() {
  selFiles = []; fi.value = '';
  const fileList = document.getElementById('file-list');
  if (fileList) {
    if (fileList._previewDisposers) { fileList._previewDisposers.forEach(d => d()); fileList._previewDisposers = []; }
    fileList.innerHTML = ''; fileList.classList.remove('visible');
  }
  ['file-card','send-url-block','prog-wrap'].forEach(id =>
    document.getElementById(id).style.display = 'none');
  hideQR('send-qr-wrap');
  document.getElementById('send-btn').disabled = true;
  document.getElementById('prog-bar').style.width = '0%';
  setStatus('send-status', '');
  hideMagnetInfo();
  updateSendAllBtns();
}

// ── Receive ───────────────────────────────────────────────────────────────────
function setRecvSender(elId, name) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!name) { el.classList.remove('visible'); el.innerHTML = ''; return; }
  el.innerHTML = `<span class="recv-from-icon">📲</span><span>${
    currentLang === 'ja' ? '送信元：' : 'From: '
  }</span><span class="recv-from-name">${escHtml(name)}</span>`;
  el.classList.add('visible');
}

function _recvStart() {
  document.getElementById('recv-btn').disabled          = true;
  document.getElementById('cancel-recv-btn').style.display = '';
  document.getElementById('recv-prog-wrap').style.display = 'none';
  document.getElementById('recv-prog-bar').style.width = '0%';
  document.getElementById('recv-prog-text').textContent = '';
  setRecvSender('recv-from', null);
  const previewArea = document.getElementById('recv-preview-area');
  if (previewArea) previewArea.innerHTML = '';
}
function _recvEnd() {
  document.getElementById('recv-btn').disabled          = false;
  document.getElementById('cancel-recv-btn').style.display = 'none';
  _recvPC = null; _recvAC = null;
}
function _recvProgress(received, total) {
  const wrap = document.getElementById('recv-prog-wrap');
  const bar  = document.getElementById('recv-prog-bar');
  const text = document.getElementById('recv-prog-text');
  if (total > 0) {
    const p = Math.round(received / total * 100);
    wrap.style.display = 'block';
    bar.style.width = p + '%';
    text.textContent = `${p}%  (${fmt(received)} / ${fmt(total)})`;
  }
}
function cancelRecv() {
  disposeRtcSession(_activeRecvSession, { force: true });
  setStatus('recv-status', t('cancelled'), 'err');
  _recvEnd();
}

async function startReceive(sender = null) {
  const path = parsePath(document.getElementById('recv-path').value);
  if (!path) return;
  _recvStart();
  setRecvSender('recv-from', sender);
  setStatus('recv-status', t('tryingP2P'), 'waiting');

  const ok = await tryRecvWebRTC(path,
    msg => setStatus('recv-status', msg, 'waiting'),
    (msg, blob, filename) => { triggerDownload(blob, filename); setStatus('recv-status', msg, 'ok'); _recvEnd(); },
    (received, total) => _recvProgress(received, total)
  );

  if (!ok) {
    if (document.getElementById('cancel-recv-btn').style.display === 'none') return; // cancelled
    setStatus('recv-status', t('startDL'), 'waiting');
    const a = Object.assign(document.createElement('a'), {
      href: `${PIPE}/${path}`, download: ''
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() =>
      setStatus('recv-status', t('waitingXfer')), 1200);
    _recvEnd();
  }
}

// Receive multiple files arriving via a single P2P session (kind: 'files' handoff)
async function startReceiveFiles(sigPath, fileInfos, sender) {
  _recvStart();
  setRecvSender('recv-from', sender);
  setStatus('recv-status', t('tryingP2P'), 'waiting');

  const fileCount = fileInfos?.length || 1;
  let filesReceived = 0;

  const ok = await tryRecvWebRTC(sigPath,
    msg => setStatus('recv-status', msg, 'waiting'),
    (msg, blob, filename) => {
      triggerDownload(blob, filename);
      filesReceived++;
      if (filesReceived >= fileCount) {
        const finalMsg = fileCount > 1 ? t('allDone')(fileCount) : msg;
        setStatus('recv-status', finalMsg, 'ok');
        _recvEnd();
      } else {
        setStatus('recv-status',
          currentLang === 'ja'
            ? `${filesReceived}/${fileCount} 完了…`
            : `${filesReceived}/${fileCount} done…`,
          'waiting');
      }
    },
    (received, total) => _recvProgress(received, total)
  );

  if (!ok) {
    // HTTP fallback: trigger a download for each file path
    const infos = fileInfos || [{ path: sigPath, filename: '' }];
    for (const info of infos) {
      const a = Object.assign(document.createElement('a'), {
        href: `${PIPE}/${info.path}`, download: info.filename || ''
      });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      await new Promise(r => setTimeout(r, 600));
    }
    setTimeout(() => setStatus('recv-status', t('waitingXfer')), 1200);
    _recvEnd();
  }
}

// ── Text ──────────────────────────────────────────────────────────────────────
function cancelTxtSend() {
  _txtSendPC?.close(); _txtSendPC = null;
  setStatus('txt-send-status', t('cancelled'), 'err');
  document.getElementById('txt-send-btn').disabled          = false;
  document.getElementById('cancel-txt-send-btn').style.display = 'none';
}
function cancelTxtRecv() {
  _txtRecvAC?.abort(); _txtRecvAC = null;
  setStatus('txt-recv-status', t('cancelled'), 'err');
  document.getElementById('txt-recv-btn').disabled          = false;
  document.getElementById('cancel-txt-recv-btn').style.display = 'none';
}

async function sendText() {
  const text = document.getElementById('txt-send').value;
  if (!text.trim()) return;
  await sendTextToPath(randPath());
}

async function sendTextToPath(path) {
  const text = document.getElementById('txt-send').value;
  if (!text.trim()) return;

  const url = recvUrl(path);
  document.getElementById('txt-url-block').style.display = 'block';
  document.getElementById('txt-url').value = url;
  showQR('txt-qr-box', 'txt-qr-wrap', url);
  setStatus('txt-send-status', t('tryingP2P'), 'waiting');
  document.getElementById('txt-send-btn').disabled          = true;
  document.getElementById('cancel-txt-send-btn').style.display = '';

  const blob = new Blob([text], { type: 'text/plain; charset=utf-8' });
  const ok = await trySendWebRTC(blob, path,
    () => {},
    msg => {
      setStatus('txt-send-status', msg, 'ok');
      document.getElementById('txt-send-btn').disabled          = false;
      document.getElementById('cancel-txt-send-btn').style.display = 'none';
    },
    () => setStatus('txt-send-status', t('sendReady'), 'waiting')
  );

  if (!ok) {
    if (document.getElementById('cancel-txt-send-btn').style.display === 'none') return; // cancelled
    setStatus('txt-send-status', t('waitingRcvr'), 'waiting');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${PIPE}/${path}`);
    xhr.setRequestHeader('Content-Type', 'text/plain; charset=utf-8');
    xhr.addEventListener('load', () => {
      setStatus('txt-send-status', t('textSentOk'), 'ok');
      document.getElementById('txt-send-btn').disabled          = false;
      document.getElementById('cancel-txt-send-btn').style.display = 'none';
    });
    xhr.addEventListener('abort', () => {});
    xhr.addEventListener('error', () => {
      setStatus('txt-send-status', t('textError'), 'err');
      document.getElementById('txt-send-btn').disabled          = false;
      document.getElementById('cancel-txt-send-btn').style.display = 'none';
    });
    xhr.send(text);
  }
}

function isUrl(text) {
  // scheme://... 形式ならURLとみなす（http/https/カスタムスキーム両対応）
  return /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\/\S+$/.test(text.trim());
}

function setReceivedText(text, sender = null) {
  addToHistory(text, sender);
  const ta   = document.getElementById('txt-received');
  const card = document.getElementById('txt-received-url-card');
  const link = document.getElementById('txt-received-url-link');
  const trimmed = text.trim();
  if (isUrl(trimmed)) {
    ta.style.display = 'none';
    link.href = trimmed;
    link.textContent = trimmed;
    card.classList.add('visible');
  } else {
    ta.style.display = '';
    card.classList.remove('visible');
    ta.value = text;
  }
}

async function receiveText(sender = null) {
  const path = parsePath(document.getElementById('txt-recv-path').value);
  if (!path) return;
  _txtRecvAC = new AbortController();
  setRecvSender('txt-recv-from', sender);
  setStatus('txt-recv-status', t('tryingP2P'), 'waiting');
  document.getElementById('txt-recv-btn').disabled          = true;
  document.getElementById('cancel-txt-recv-btn').style.display = '';

  const ok = await tryRecvWebRTC(path,
    msg => setStatus('txt-recv-status', msg, 'waiting'),
    (msg, blob) => {
      blob.text().then(tx => {
        setReceivedText(tx, sender);
        setStatus('txt-recv-status', msg, 'ok');
      });
      document.getElementById('txt-recv-btn').disabled          = false;
      document.getElementById('cancel-txt-recv-btn').style.display = 'none';
    }
  );

  if (!ok) {
    if (!_txtRecvAC) return; // cancelled
    setStatus('txt-recv-status', t('receiving'), 'waiting');
    try {
      const t0  = performance.now();
      const res = await fetch(`${PIPE}/${path}`, { signal: _txtRecvAC.signal });
      const txt = await res.text();
      const elapsed = (performance.now() - t0) / 1000;
      const speed   = elapsed > 0 ? new Blob([txt]).size / elapsed : 0;
      setReceivedText(txt, sender);
      setStatus('txt-recv-status', t('textRecvDone')(fmt(new Blob([txt]).size), elapsed.toFixed(2), fmt(speed)), 'ok');
    } catch (e) {
      if (e.name !== 'AbortError') setStatus('txt-recv-status', '✗ ' + e.message, 'err');
    }
    document.getElementById('txt-recv-btn').disabled          = false;
    document.getElementById('cancel-txt-recv-btn').style.display = 'none';
    _txtRecvAC = null;
  }
}

// ── WebRTC helpers ────────────────────────────────────────────────────────────
function waitForIce(pc) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') resolve();
    };
    setTimeout(resolve, ICE_TIMEOUT);
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(label)), ms))
  ]);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  _showRecvPreview(blob, filename);
}

function _showRecvPreview(blob, filename) {
  const mime     = blob.type || '';
  const kind     = previewKind(filename, mime);
  const provider = kind && PreviewRegistry.find(kind);
  if (!provider) return;
  const area = document.getElementById('recv-preview-area');
  if (!area) return;

  const url  = _createPreviewUrl(blob);
  const card = document.createElement('div');
  card.className = 'recv-preview-card';

  const thumbEl = provider.thumb(url, { name: filename, mime }, () => {
    openPreviewModal(filename, body => provider.renderDetail(body, url, { name: filename, mime }));
  });
  card.appendChild(thumbEl);

  const info = document.createElement('div');
  info.className = 'recv-preview-card-info';
  const nameEl = document.createElement('div');
  nameEl.className = 'recv-preview-card-name';
  nameEl.textContent = filename;
  info.appendChild(nameEl);
  card.appendChild(info);

  const openBtn = document.createElement('button');
  openBtn.className = 'preview-open-btn';
  openBtn.textContent = currentLang === 'ja' ? '👁 プレビュー' : '👁 Preview';
  openBtn.addEventListener('click', () => {
    openPreviewModal(filename, body => provider.renderDetail(body, url, { name: filename, mime }));
  });
  card.appendChild(openBtn);

  area.appendChild(card);
}

function resolveChunking(pc) {
  const rawMax = pc.sctp?.maxMessageSize;
  let target = MAX_CHUNK_SZ;
  if (CHUNK_PROFILE === 'safari') target = 64 * 1024;
  else if (CHUNK_PROFILE === 'firefox') target = 128 * 1024;
  else if (CHUNK_PROFILE === 'chromium') target = 512 * 1024;
  const limit  = Number.isFinite(rawMax) && rawMax > 0 ? Math.min(rawMax, target) : target;
  const chunk  = Math.max(MIN_CHUNK_SZ, Math.min(limit, MAX_CHUNK_SZ));
  return {
    chunkSize: chunk,
    flowHigh : chunk * FLOW_HIGH_MULT,
    flowLow  : chunk * FLOW_LOW_MULT
  };
}

function shrinkChunk(session) {
  if (!session || session.chunkSize <= MIN_CHUNK_SZ) return false;
  const next = Math.max(MIN_CHUNK_SZ, Math.floor(session.chunkSize / 2));
  if (next === session.chunkSize) return false;
  session.chunkSize = next;
  session.flowHigh = next * FLOW_HIGH_MULT;
  session.flowLow = next * FLOW_LOW_MULT;
  return true;
}

function waitForBufferDrain(dc, highWater, lowWater) {
  if (dc.bufferedAmount <= highWater) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      dc.removeEventListener('bufferedamountlow', onLow);
      dc.removeEventListener('close', onClose);
      dc.removeEventListener('error', onClose);
    };
    const onLow = () => {
      if (dc.bufferedAmount <= lowWater) {
        cleanup();
        resolve();
      }
    };
    const onClose = err => {
      cleanup();
      reject(err instanceof Error ? err : new Error('DataChannel closed'));
    };
    dc.addEventListener('bufferedamountlow', onLow);
    dc.addEventListener('close', onClose);
    dc.addEventListener('error', onClose);
  });
}

function payloadLength(payload) {
  if (payload instanceof ArrayBuffer) return payload.byteLength;
  if (ArrayBuffer.isView(payload)) return payload.byteLength;
  if (typeof payload === 'string') return new TextEncoder().encode(payload).byteLength;
  return 0;
}

function disposeRtcSession(session, opts = {}) {
  if (!session) return;
  const { force = false } = opts;
  const performClose = () => {
    if (session.disposeTimer) {
      clearTimeout(session.disposeTimer);
      session.disposeTimer = null;
    }
    try { session.dc?.close(); } catch {}
    try { session.pc?.close(); } catch {}
    session.ac?.abort();
    if (session.kind === 'send') {
      if (_activeSendSession === session) _activeSendSession = null;
      _sendPC = null;
    }
    if (session.kind === 'recv') {
      if (_activeRecvSession === session) _activeRecvSession = null;
      _recvPC = null;
      _recvAC = null;
    }
  };
  if (!force && !ENABLE_RTC_POOL) {
    if (session.disposeTimer) clearTimeout(session.disposeTimer);
    session.disposeTimer = setTimeout(performClose, RTC_DRAIN_DELAY);
    return;
  }
  if (force && session.disposeTimer) {
    clearTimeout(session.disposeTimer);
    session.disposeTimer = null;
  }
  if (force && ENABLE_RTC_POOL) {
    // even when pooling, allow explicit force-close
    try { session.dc?.close(); } catch {}
    try { session.pc?.close(); } catch {}
    session.ac?.abort();
    if (session.kind === 'send') {
      if (_activeSendSession === session) _activeSendSession = null;
      _sendPC = null;
    }
    if (session.kind === 'recv') {
      if (_activeRecvSession === session) _activeRecvSession = null;
      _recvPC = null;
      _recvAC = null;
    }
    return;
  }
  if (ENABLE_RTC_POOL && !force) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(performClose, RTC_IDLE_TIMEOUT);
    return;
  }
  performClose();
}

async function initSendRtcSession(path) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SIG_TIMEOUT);
  const pc = new RTCPeerConnection({ iceServers: await fetchIceServers() });
  _sendPC = pc;
  const dc = pc.createDataChannel('pipe', { ordered: true });
  const session = { kind: 'send', ac, pc, dc, startedAt: performance.now(), chunkSize: 0 };
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc);

    fetch(`${PIPE}/${path}.__offer`, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pc.localDescription)
    }).catch(() => {});

    const res = await fetch(`${PIPE}/${path}.__answer`, { signal: ac.signal });
    if (!res.ok) throw new Error('no answer');
    await pc.setRemoteDescription(await res.json());

    await withTimeout(new Promise((resolve, reject) => {
      dc.onopen  = resolve;
      dc.onerror = reject;
    }), DC_TIMEOUT, 'DataChannel timeout');

    clearTimeout(timer);
    const cfg = resolveChunking(pc);
    dc.bufferedAmountLowThreshold = cfg.flowLow;
    Object.assign(session, cfg);
    session.readyAt = performance.now();
    session.handshakeMs = session.readyAt - session.startedAt;
    _activeSendSession = session;
    return session;
  } catch (e) {
    clearTimeout(timer);
    ac.abort();
    try { pc.close(); } catch {}
    throw e;
  }
}

async function initRecvRtcSession(path) {
  const ac = new AbortController();
  _recvAC = ac;
  const timer = setTimeout(() => ac.abort(), SIG_TIMEOUT);
  const pc = new RTCPeerConnection({ iceServers: await fetchIceServers() });
  _recvPC = pc;
  const session = { kind: 'recv', ac, pc, startedAt: performance.now() };
  try {
    const res = await fetch(`${PIPE}/${path}.__offer`, { signal: ac.signal });
    if (!res.ok) throw new Error('no offer');

    const offer = await res.json();
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIce(pc);

    fetch(`${PIPE}/${path}.__answer`, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pc.localDescription)
    }).catch(() => {});

    const dc = await withTimeout(new Promise((resolve, reject) => {
      pc.ondatachannel = e => resolve(e.channel);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') reject(new Error('connection failed'));
      };
    }), DC_TIMEOUT, 'DataChannel timeout');
    dc.binaryType = 'arraybuffer';

    clearTimeout(timer);
    session.dc = dc;
    session.readyAt = performance.now();
    session.handshakeMs = session.readyAt - session.startedAt;
    _activeRecvSession = session;
    return session;
  } catch (e) {
    clearTimeout(timer);
    ac.abort();
    try { pc.close(); } catch {}
    throw e;
  }
}

// ── WebRTC send ───────────────────────────────────────────────────────────────
// onProgress(loaded, total), onDone(message)
// Returns true if P2P succeeded, false to fall back to HTTP
async function trySendWebRTC(body, path, onProgress, onDone, onReady) {
  let session = null;
  let success = false;
  try {
    session = await initSendRtcSession(path);
    const { pc, dc } = session;
    let chunkSize = session.chunkSize;
    let flowHigh = session.flowHigh;
    let flowLow = session.flowLow;
    const refreshChunks = () => {
      chunkSize = session.chunkSize;
      flowHigh = session.flowHigh;
      flowLow = session.flowLow;
    };

    if (typeof onReady === 'function') onReady();

    const filename = body instanceof File ? body.name : 'file';
    const mime     = body instanceof Blob ? (body.type || 'application/octet-stream') : 'application/octet-stream';
    const total    = body instanceof Blob ? body.size : payloadLength(body);

    dc.send(JSON.stringify({ t: 'meta', name: filename, mime, size: total }));

    const t0   = performance.now();
    let sent   = 0;
    const feed = async view => {
      let offset = 0;
      while (offset < view.byteLength) {
        if (pc.connectionState === 'closed' || pc.connectionState === 'failed') throw new Error('cancelled');
        if (dc.bufferedAmount > flowHigh) {
          const stallStart = performance.now();
          await waitForBufferDrain(dc, flowHigh, flowLow);
          const stall = performance.now() - stallStart;
          if (stall > FLOW_STALL_MS && shrinkChunk(session)) refreshChunks();
        }
        const size  = Math.min(chunkSize, view.byteLength - offset);
        const chunk = view.subarray(offset, offset + size);
        dc.send(chunk);
        offset += size;
        sent   += size;
        onProgress(sent, total);
      }
    };

    if (body instanceof Blob && typeof body.stream === 'function') {
      const reader = body.stream().getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          await feed(value);
        }
      } finally {
        reader.releaseLock?.();
      }
    } else {
      const raw = body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : ArrayBuffer.isView(body)
          ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
          : new TextEncoder().encode(String(body ?? ''));
      await feed(raw);
    }

    dc.send(JSON.stringify({ t: 'done' }));
    const elapsed = (performance.now() - t0) / 1000;
    const speed   = sent / elapsed;
    onDone(t('p2pSendDone')(fmt(sent), elapsed.toFixed(2), fmt(speed)));
    reportTransfer('p2p', sent, {
      chunkSize: session.chunkSize,
      profile: CHUNK_PROFILE,
      handshakeMs: Math.round(session.handshakeMs || 0),
      transferMs: Math.round(elapsed * 1000),
      files: 1
    });
    success = true;
    return true;
  } catch (e) {
    return false;
  } finally {
    disposeRtcSession(session, { force: !success });
  }
}

// ── WebRTC send (multi-file) ──────────────────────────────────────────────────
// fileEntries: [{file, path}] — uses first path for signaling
// onProgress(fileIdx, loaded, total), onFileDone(fileIdx), onAllDone(totalSent, elapsed)
async function trySendWebRTCFiles(fileEntries, onProgress, onFileDone, onAllDone, onReady) {
  const sigPath = fileEntries[0].path;
  let session = null;
  let success = false;
  try {
    session = await initSendRtcSession(sigPath);
    const { pc, dc } = session;
    let chunkSize = session.chunkSize;
    let flowHigh = session.flowHigh;
    let flowLow = session.flowLow;
    const refreshChunks = () => {
      chunkSize = session.chunkSize;
      flowHigh = session.flowHigh;
      flowLow = session.flowLow;
    };

    if (typeof onReady === 'function') onReady();

    let totalSent = 0;
    const t0 = performance.now();

    for (let i = 0; i < fileEntries.length; i++) {
      const { file } = fileEntries[i];
      const mime  = file.type || 'application/octet-stream';
      const total = file.size;

      dc.send(JSON.stringify({ t: 'meta', name: file.name, mime, size: total, index: i, count: fileEntries.length }));

      let fileSent = 0;
      const feed = async view => {
        let offset = 0;
        while (offset < view.byteLength) {
          if (pc.connectionState === 'closed' || pc.connectionState === 'failed') throw new Error('cancelled');
          if (dc.bufferedAmount > flowHigh) {
            const stallStart = performance.now();
            await waitForBufferDrain(dc, flowHigh, flowLow);
            const stall = performance.now() - stallStart;
            if (stall > FLOW_STALL_MS && shrinkChunk(session)) refreshChunks();
          }
          const size  = Math.min(chunkSize, view.byteLength - offset);
          const chunk = view.subarray(offset, offset + size);
          dc.send(chunk);
          offset   += size;
          fileSent += size;
          totalSent += size;
          onProgress(i, fileSent, total);
        }
      };

      const reader = file.stream().getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          await feed(value);
        }
      } finally {
        reader.releaseLock?.();
      }

      dc.send(JSON.stringify({ t: 'done' }));
      onFileDone(i);
    }

    dc.send(JSON.stringify({ t: 'all-done' }));
    const elapsed = (performance.now() - t0) / 1000;
    onAllDone(totalSent, elapsed);
    reportTransfer('p2p', totalSent, {
      chunkSize: session.chunkSize,
      profile: CHUNK_PROFILE,
      handshakeMs: Math.round(session.handshakeMs || 0),
      transferMs: Math.round(elapsed * 1000),
      files: fileEntries.length
    });
    success = true;
    return true;
  } catch (e) {
    return false;
  } finally {
    disposeRtcSession(session, { force: !success });
  }
}

// ── WebRTC receive ────────────────────────────────────────────────────────────
// onStatus(message), onDone(message, blob, filename), onProgress(received, total)
// Returns true if P2P succeeded
async function tryRecvWebRTC(path, onStatus, onDone, onProgress) {
  let session = null;
  let success = false;
  try {
    session = await initRecvRtcSession(path);
    const { dc } = session;
    _recvAC = session.ac;
    onStatus(t('p2pConnected'));

    await new Promise(resolve => {
      let meta = null, chunks = [], recvd = 0;
      let t0 = null, isMulti = false;
      dc.onmessage = e => {
        if (typeof e.data === 'string') {
          const msg = JSON.parse(e.data);
          if (msg.t === 'meta') {
            meta   = msg;
            chunks = []; recvd = 0; t0 = null;
            isMulti = (msg.count > 1);
            onStatus(t('p2pReceiving')(meta.name));
          } else if (msg.t === 'done') {
            const elapsed = t0 ? (performance.now() - t0) / 1000 : 0;
            const speed   = elapsed > 0 ? recvd / elapsed : 0;
            const blob    = new Blob(chunks, { type: meta.mime });
            onDone(t('p2pRecvDone')(fmt(recvd), elapsed.toFixed(2), fmt(speed)), blob, meta.name);
            if (!isMulti) resolve();
          } else if (msg.t === 'all-done') {
            resolve();
          }
        } else {
          if (!t0) t0 = performance.now();
          chunks.push(e.data);
          recvd += e.data.byteLength;
          if (meta) {
            onStatus(t('p2pProgress')(fmt(recvd), fmt(meta.size)));
            if (onProgress) onProgress(recvd, meta.size);
          }
        }
      };
      dc.onerror = resolve;
    });
    success = true;
    return true;
  } catch (e) {
    return false;
  } finally {
    disposeRtcSession(session, { force: !success });
  }
}

// ── Init: auto-receive if URL has hash ────────────────────────────────────────
(function () {
  const hash = location.hash.slice(1);
  if (!hash) return;
  const path = decodeURIComponent(hash);
  // Clear hash without reload
  history.replaceState(null, '', location.pathname);
  // Switch to receive tab and auto-start
  switchTab('receive');
  const input = document.getElementById('recv-path');
  input.value = path;
  document.getElementById('recv-btn').disabled = false;
  startReceive();
})();

// ── Text receive history ──────────────────────────────────────────────────────
const HISTORY_KEY = 'pipe.textHistory';
const MAX_HISTORY = 50;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}
function saveHistory(arr) { localStorage.setItem(HISTORY_KEY, JSON.stringify(arr)); }

function addToHistory(text, sender = null) {
  if (!text.trim()) return;
  const arr = loadHistory();
  arr.unshift({ text, ts: Date.now(), sender: sender || null });
  if (arr.length > MAX_HISTORY) arr.splice(MAX_HISTORY);
  saveHistory(arr);
  renderHistory();
}

function removeFromHistory(idx) {
  const arr = loadHistory();
  arr.splice(idx, 1);
  saveHistory(arr);
  renderHistory();
}

function clearHistory() {
  saveHistory([]);
  renderHistory();
}

function copyHistItem(idx) {
  const arr = loadHistory();
  if (arr[idx]) navigator.clipboard.writeText(arr[idx].text).catch(() => {});
}

function renderHistory() {
  const container = document.getElementById('txt-history');
  if (!container) return;
  const arr = loadHistory();
  container.innerHTML = '';

  if (!arr.length) {
    const empty = document.createElement('div');
    empty.className = 'hist-empty';
    empty.textContent = currentLang === 'ja' ? '受信履歴はありません' : 'No history yet';
    container.appendChild(empty);
    return;
  }

  const copyLabel = currentLang === 'ja' ? 'コピー' : 'Copy';
  arr.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = 'hist-item';
    const trimmed = item.text.trim();
    const preview = trimmed.length > 120 ? trimmed.slice(0, 120) + '…' : trimmed;
    const bodyHtml = isUrl(trimmed)
      ? `<a href="${escHtml(trimmed)}" target="_blank" rel="noopener">${escHtml(preview)}</a>`
      : escHtml(preview);
    el.innerHTML =
      `<div class="hist-header">` +
        `<span class="hist-time">${escHtml(fmtLastSeen(item.ts))}${item.sender ? ` · ${escHtml(item.sender)}` : ''}</span>` +
        `<div class="hist-btns">` +
          `<button class="hist-btn" onclick="copyHistItem(${i})">${copyLabel}</button>` +
          `<button class="hist-btn hist-del" onclick="removeFromHistory(${i})">×</button>` +
        `</div>` +
      `</div>` +
      `<div class="hist-body" onclick="copyHistItem(${i})">${bodyHtml}</div>`;
    container.appendChild(el);
  });
}

// ── Lang init ─────────────────────────────────────────────────────────────────
languageManager.init();
renderHistory();
renderSwarmList();
loadLocalSwarmCatalog();

// Pre-load Google APIs in background so the OAuth popup fires synchronously
// within the user gesture when the button is clicked (required on iOS Safari).
loadGoogleAPIs().then(() => {
  // Also pre-initialize the token client after APIs are ready.
  if (!_gdriveTokenClient) {
    _gdriveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GDRIVE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      callback: () => {},  // replaced at request time
    });
  }
}).catch(() => {});

Object.assign(window, {
  copyField,
  startSend,
  cancelSend,
  resetSend,
  sendFilesToAllPeers,
  seedFilesAsTorrent,
  stopSeeding,
  startReceive,
  cancelRecv,
  sendText,
  cancelTxtSend,
  sendTextToAllPeers,
  receiveText,
  cancelTxtRecv,
  clearHistory,
  copyHistItem,
  removeFromHistory,
  closePreviewModal,
});

window.addEventListener('beforeunload', () => {
  unregisterAllLocalSeeders();
});
