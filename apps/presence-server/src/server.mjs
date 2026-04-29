import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { URL, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, createReadStream } from 'node:fs';
import { verifyLinkToken, initiatePairingCode, redeemPairingCode, revokeLinkToken, getActiveLink } from './link-token.mjs';
import { encodeSession, decodeSession } from './gpt-session.mjs';

const PORT = Number(process.env.PORT || 8787);
const HEARTBEAT_MS = 30000;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_SIZE = 131072; // 128 KB max WebSocket message
const STATS_FILE = process.env.STATS_FILE || '/data/stats.json';
const STATS_ARCHIVE_DIR = process.env.STATS_ARCHIVE_DIR || '/data/archive';

const rooms = new Map(); // roomId -> Map<clientId, Client>
const pendingSceneRequests = new Map(); // apiRequestId -> { resolve, timer }
const pendingAiCommandResults = new Map(); // apiRequestId -> { resolve, timer }

// ── Blob Store ────────────────────────────────────────────────────────────────
const BLOB_MAX_SIZE = 50 * 1024 * 1024; // 50MB
const BLOB_MEMORY_THRESHOLD = 1 * 1024 * 1024; // 1MB
const BLOB_TTL_MS = 10 * 60 * 1000; // 10分
const BLOB_CLEANUP_INTERVAL = 60 * 1000; // 60秒
const BLOB_DIR = process.env.BLOB_DIR || '/data/blobs';

// id → { buffer: Buffer|null, file: string|null, size: number, createdAt: number }
const blobs = new Map();

// ── Stats persistence ─────────────────────────────────────────────────────────
const STATS_LOG_LIMIT = Number(process.env.STATS_LOG_LIMIT || 500);
const STATS_ARCHIVE_AFTER = Number(process.env.STATS_ARCHIVE_AFTER || 2000);
const EMPTY_STATS = () => ({
  summary: {
    p2p: { count: 0, bytes: 0 },
    pipe: { count: 0, bytes: 0 },
    torrent: { count: 0, bytes: 0 }
  },
  logs: []
});

function loadStats() {
  try {
    return JSON.parse(readFileSync(STATS_FILE, 'utf8'));
  } catch {
    return EMPTY_STATS();
  }
}

function writeStatsFile(data) {
  mkdirSync(STATS_FILE.replace(/\/[^/]+$/, ''), { recursive: true });
  writeFileSync(STATS_FILE, JSON.stringify(data), 'utf8');
}

function saveStats(data) {
  try {
    writeStatsFile(data);
    if (stats.logs.length >= STATS_ARCHIVE_AFTER) {
      archiveStats();
    }
  } catch (err) {
    log('stats write error', err.message);
  }
}

function archiveStats() {
  try {
    mkdirSync(STATS_ARCHIVE_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = `${STATS_ARCHIVE_DIR}/stats-${ts}.json`;
    const snapshot = { summary: stats.summary, logs: stats.logs.slice() };
    writeFileSync(filePath, JSON.stringify(snapshot), 'utf8');
    stats.logs = [];
    writeStatsFile(stats);
    log('stats archived to', filePath);
  } catch (err) {
    log('archive error', err.message);
  }
}

const stats = loadStats();
if (!stats.summary) stats.summary = EMPTY_STATS().summary;
if (!stats.logs) stats.logs = [];

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function sanitizeName(raw) {
  if (!raw) return '';
  return String(raw).trim().slice(0, 40);
}

function sanitizeDevice(raw) {
  if (!raw) return '';
  return String(raw).trim().slice(0, 60);
}

function sanitizeRoom(raw) {
  if (!raw) return null;
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9\-]/g, '').slice(0, 32);
  return cleaned || null;
}

function inferRoomFromReq(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const first = forwarded ? forwarded.split(',')[0].trim() : null;
  const ip = first || req.socket.remoteAddress || 'global';
  if (ip.includes(':')) {
    return ip.replace('::ffff:', '').split(':')[0] || 'global-v6';
  }
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
  }
  return ip || 'global';
}

function getRequestUrl(req) {
  const rawUrl = req.url.startsWith('//') ? req.url.slice(1) : req.url;
  return new URL(rawUrl, `http://${req.headers.host}`);
}

class WsConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.alive = true;
    this.closed = false;
    this._fragBufs = [];
    this._fragOpcode = 0;
    socket.on('data', chunk => this.#handle(chunk));
    socket.on('close', () => this.#handleClose());
    socket.on('error', () => this.#handleClose());
  }

  send(obj) {
    try {
      const payload = Buffer.from(JSON.stringify(obj));
      this.socket.write(encodeFrame(payload));
    } catch (err) {
      log('send error', err.message);
    }
  }

  ping() {
    this.socket.write(Buffer.from([0x89, 0x00]));
  }

  close() {
    try {
      this.socket.end();
    } catch {}
  }

  #handleClose() {
    if (this.closed) return;
    this.closed = true;
    this.onClose && this.onClose();
  }

  #handle(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const isMasked = Boolean(this.buffer[1] & 0x80);
      let length = this.buffer[1] & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        length = Number(big);
        offset = 10;
      }

      // Reject oversized messages
      if (length > MAX_MESSAGE_SIZE) {
        log('oversized frame', length, '- closing connection');
        this.close();
        return;
      }

      const mask = isMasked ? this.buffer.slice(offset, offset + 4) : null;
      offset += isMasked ? 4 : 0;
      if (this.buffer.length < offset + length) return;

      let payload = this.buffer.slice(offset, offset + length);
      this.buffer = this.buffer.slice(offset + length);

      if (mask) payload = applyMask(payload, mask);

      // Control frames (close / ping / pong) — never fragmented
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) {
        this.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        continue;
      }
      if (opcode === 0xa) { this.alive = true; continue; }

      // Data frames — handle fragmentation
      if (opcode !== 0x0) {
        // First frame of a new message (text or binary)
        this._fragOpcode = opcode;
        this._fragBufs = [payload];
      } else {
        // Continuation frame
        this._fragBufs.push(payload);
      }

      if (fin) {
        const totalSize = this._fragBufs.reduce((sum, b) => sum + b.length, 0);
        if (totalSize > MAX_MESSAGE_SIZE) {
          log('oversized reassembled message', totalSize, '- closing connection');
          this._fragBufs = [];
          this.close();
          return;
        }
        const fullPayload = this._fragBufs.length === 1
          ? this._fragBufs[0]
          : Buffer.concat(this._fragBufs);
        this._fragBufs = [];
        // Only process text frames (opcode 0x1)
        if (this._fragOpcode === 0x1) {
          this.alive = true;
          const text = fullPayload.toString('utf8');
          this.onMessage && this.onMessage(text);
        }
      }
    }
  }
}

function applyMask(buf, mask) {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i += 1) {
    out[i] = buf[i] ^ mask[i % 4];
  }
  return out;
}

function encodeFrame(payload) {
  const len = payload.length;
  if (len < 126) {
    const header = Buffer.from([0x81, len]);
    return Buffer.concat([header, payload]);
  }
  if (len < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([header, payload]);
}

function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return null;
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n'
  ];
  socket.write(headers.join('\r\n'));
  return new WsConnection(socket);
}

function makeClient(conn, roomId) {
  const client = {
    id: randomUUID(),
    conn,
    roomId,
    userId: null,
    nickname: '',
    device: '',
    streaming: false,
    lastSeen: Date.now()
  };
  const room = rooms.get(roomId) ?? new Map();
  room.set(client.id, client);
  rooms.set(roomId, room);
  return client;
}

function removeClient(client) {
  const room = rooms.get(client.roomId);
  if (!room) return;
  room.delete(client.id);
  if (!room.size) {
    rooms.delete(client.roomId);
  }
}

function listPeers(roomId, excludeId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.values())
    .filter(p => p.id !== excludeId)
    .map(p => {
      const peerInfo = {
        id: p.id,
        nickname: p.nickname,
        device: p.device,
        streaming: p.streaming,
        lastSeen: p.lastSeen
      };
      if (p.userId) {
        peerInfo.userId = p.userId;
      }
      return peerInfo;
    });
}

function broadcastPeers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.forEach(client => {
    safeSend(client.conn, { type: 'peers', peers: listPeers(roomId, client.id) });
  });
}

function safeSend(conn, message) {
  try {
    conn.send(message);
  } catch (err) {
    log('send fail', err.message);
  }
}

function deliverHandoff(sender, msg) {
  const room = rooms.get(sender.roomId);
  if (!room) return;
  const target = room.get(msg.targetId);
  if (!target) return;
  const payload = {
    type: 'handoff',
    from: {
      id: sender.id,
      nickname: sender.nickname,
      device: sender.device
    },
    payload: msg.payload || {}
  };
  safeSend(target.conn, payload);
}

function broadcastHandoff(sender, msg) {
  const room = rooms.get(sender.roomId);
  if (!room) return;
  const payload = {
    type: 'handoff',
    from: {
      id: sender.id,
      nickname: sender.nickname,
      device: sender.device
    },
    payload: msg.payload || {}
  };
  room.forEach(client => {
    if (client.id !== sender.id) {
      safeSend(client.conn, payload);
    }
  });
}

function getRoomClients(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.values());
}

function createApiSender(name) {
  return {
    id: `api-${randomUUID()}`,
    nickname: sanitizeName(name) || 'AI',
    device: 'REST API'
  };
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    ...CORS,
    ...extraHeaders
  }).end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        reject(new Error('invalid JSON body'));
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('invalid JSON body'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', () => reject(new Error('invalid JSON body')));
  });
}

function handlePendingSceneState(data) {
  if (!data?.targetId || data?.payload?.kind !== 'scene-state') return false;
  const pending = pendingSceneRequests.get(data.targetId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingSceneRequests.delete(data.targetId);
  const { kind, ...sceneState } = data.payload;
  pending.resolve(sceneState);
  return true;
}

function handlePendingAiCommandResult(data) {
  if (!data?.targetId || data?.payload?.kind !== 'ai-result') return false;
  const pending = pendingAiCommandResults.get(data.targetId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingAiCommandResults.delete(data.targetId);
  pending.resolve(data.payload);
  return true;
}

function waitForSceneState(requestId, timeoutMs = 5000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingSceneRequests.delete(requestId);
      resolve({ objects: {} });
    }, timeoutMs);
    pendingSceneRequests.set(requestId, { resolve, timer });
  });
}

function waitForAiCommandResult(requestId, timeoutMs = 10000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingAiCommandResults.delete(requestId);
      resolve({
        kind: 'ai-result',
        ok: false,
        error: 'ai-command timeout',
      });
    }, timeoutMs);
    pendingAiCommandResults.set(requestId, { resolve, timer });
  });
}

function findLatestUserPeer(roomId, userId) {
  const peers = getRoomClients(roomId).filter(client => client.userId === userId);
  if (!peers.length) return null;
  peers.sort((a, b) => b.lastSeen - a.lastSeen);
  return peers[0];
}

function resolveGptSession(body, expectedRoomId = null) {
  if (!body || typeof body.sessionId !== 'string') {
    return { ok: false, status: 400, error: 'sessionId is required in request body' };
  }
  const decoded = decodeSession(body.sessionId);
  if (!decoded.ok) {
    return { ok: false, status: decoded.status, error: decoded.error };
  }
  if (expectedRoomId && decoded.payload.roomId !== expectedRoomId) {
    return { ok: false, status: 403, error: 'roomId mismatch' };
  }
  return decoded;
}

function broadcastAiLinkEstablished(roomId, result) {
  const peers = getRoomClients(roomId);
  const message = {
    type: 'handoff',
    from: { id: `api-link-${randomUUID()}`, nickname: 'AI', device: 'REST API' },
    payload: {
      kind: 'ai-link-established',
      linkId: result.linkId,
      userId: result.userId,
      peerId: result.peerId || null,
      roomId: result.roomId,
      expiresAt: result.expiresAt
    }
  };
  peers.forEach(client => safeSend(client.conn, message));
}

function broadcastAiLinkRevoked(roomId, linkId, reason = 'ai-revoked') {
  if (!roomId) return;
  const peers = getRoomClients(roomId);
  const message = {
    type: 'handoff',
    from: { id: `api-revoke-${randomUUID()}`, nickname: 'AI', device: 'REST API' },
    payload: {
      kind: 'ai-link-revoked',
      linkId,
      reason
    }
  };
  peers.forEach(client => safeSend(client.conn, message));
}

async function fetchRoomSceneState(roomId, sender = createApiSender('AI')) {
  const peers = getRoomClients(roomId);
  if (!peers.length) {
    return { objects: {} };
  }

  safeSend(peers[0].conn, {
    type: 'handoff',
    from: sender,
    payload: { kind: 'scene-request' }
  });
  return waitForSceneState(sender.id);
}

function createBroadcastResponse(roomId, peers, userPresent) {
  return {
    ok: true,
    room: roomId,
    peers: peers.length,
    userPresent,
  };
}

async function runAiCommand({ roomId, onBehalfOfUserId, payload, sender = createApiSender('AI') }) {
  const peers = getRoomClients(roomId);
  const userPresent = Boolean(onBehalfOfUserId) && peers.some(client => client.userId === onBehalfOfUserId);
  const targetClient = payload.targetPeerId
    ? peers.find(client => client.id === payload.targetPeerId) || null
    : findLatestUserPeer(roomId, onBehalfOfUserId);

  if (!targetClient) {
    return {
      status: 404,
      body: { error: 'target peer not found', userPresent }
    };
  }

  const aiCommandPayload = {
    ...payload,
    targetPeerId: targetClient.id,
  };

  safeSend(targetClient.conn, {
    type: 'handoff',
    from: sender,
    payload: aiCommandPayload,
  });

  const result = await waitForAiCommandResult(sender.id);
  return {
    status: 200,
    body: {
      ok: result.ok !== false,
      room: roomId,
      peers: peers.length,
      userPresent,
      targetPeerId: targetClient.id,
      result,
    }
  };
}

async function runRoomBroadcast({ roomId, payload, onBehalfOfUserId = null, sender = createApiSender('AI') }) {
  const peers = getRoomClients(roomId);
  let nextPayload = payload;
  if (onBehalfOfUserId) {
    nextPayload = { ...payload, onBehalfOf: onBehalfOfUserId };
  }

  if (nextPayload?.kind === 'ai-command') {
    return runAiCommand({
      roomId,
      onBehalfOfUserId,
      payload: nextPayload,
      sender,
    });
  }

  const message = {
    type: 'handoff',
    from: sender,
    payload: nextPayload
  };
  peers.forEach(client => safeSend(client.conn, message));

  const userPresent = Boolean(onBehalfOfUserId) && peers.some(client => client.userId === onBehalfOfUserId);
  return {
    status: 200,
    body: createBroadcastResponse(roomId, peers, userPresent),
  };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function setBlobCors(req, res) {
  const origin = req.headers['origin'] || '';
  const allowed = [
    'https://afjk.jp',
    'https://staging.afjk.jp',
    'http://localhost:8888',
    'http://localhost:3000',
  ];
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const MEDIAMTX_API = process.env.MEDIAMTX_API_URL || 'http://mediamtx:9997';

async function fetchStreamStats() {
  try {
    const res = await globalThis.fetch(MEDIAMTX_API + '/v3/paths/list');
    if (!res.ok) return { sessions: 0, bytes: 0 };
    const data = await res.json();
    const items = data.items || [];
    let sessions = 0;
    let bytes = 0;
    for (const path of items) {
      if (path.source) sessions += 1;
      bytes += (path.inboundBytes || 0) + (path.outboundBytes || 0);
    }
    return { sessions, bytes };
  } catch {
    return { sessions: 0, bytes: 0 };
  }
}

function buildTurnServers() {
  const raw = process.env.TURN_URLS || process.env.TURN_URL || '';
  const username = process.env.TURN_USERNAME || '';
  const credential = process.env.TURN_CREDENTIAL || '';
  const urls = raw.split(',').map(u => u.trim()).filter(Boolean);
  if (!urls.length) {
    const devTurn = process.env.DEV_TURN_URL || 'turn:localhost:3478?transport=udp';
    const enableDev = process.env.ENABLE_DEV_TURN !== 'false';
    if (enableDev && process.env.NODE_ENV !== 'production') {
      urls.push(devTurn);
    }
  }
  return urls.map(url => ({
    urls: url,
    username,
    credential
  }));
}

function recordTransfer(entry) {
  const { type, bytes = 0, meta = null, timestamp = Date.now() } = entry || {};
  if (!type || !stats.summary[type]) return;
  stats.summary[type].count += 1;
  stats.summary[type].bytes += Number(bytes) || 0;
  const logEntry = { type, bytes: Number(bytes) || 0, ts: timestamp };
  if (meta && typeof meta === 'object') {
    logEntry.meta = meta;
  }
  stats.logs.push(logEntry);
  if (stats.logs.length > STATS_LOG_LIMIT) {
    stats.logs.splice(0, stats.logs.length - STATS_LOG_LIMIT);
  }
  saveStats(stats);
}

function createPresenceServer() {
  const server = createServer(async (req, res) => {
    const path = req.url.split('?')[0].replace(/\/+/g, '/');

  // CORS preflight
    if (req.method === 'OPTIONS') {
      if (path.startsWith('/blob/')) {
        setBlobCors(req, res);
        res.writeHead(204).end();
      } else {
        res.writeHead(204, CORS).end();
      }
      return;
    }

  // ── Blob Store ────────────────────────────────────────────
  // POST /blob/:id
    if (req.method === 'POST' && path.startsWith('/blob/')) {
      setBlobCors(req, res);
      const id = path.slice(6).replace(/[^a-z0-9\-]/gi, '').slice(0, 32);
      if (!id) {
        res.writeHead(400, CORS).end('invalid id');
        return;
      }
      if (blobs.has(id)) {
        res.writeHead(409, CORS).end('conflict');
        return;
      }

      const chunks = [];
      let totalSize = 0;

      req.on('data', chunk => {
        totalSize += chunk.length;
        if (totalSize > BLOB_MAX_SIZE) {
          res.writeHead(413, CORS).end('too large');
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (res.writableEnded) return;
        const buffer = Buffer.concat(chunks);
        const entry = {
          size: buffer.length,
          createdAt: Date.now(),
          buffer: null,
          file: null,
        };

        if (buffer.length <= BLOB_MEMORY_THRESHOLD) {
          entry.buffer = buffer;
        } else {
          try {
            mkdirSync(BLOB_DIR, { recursive: true });
            const filePath = BLOB_DIR + '/' + id + '.glb';
            writeFileSync(filePath, buffer);
            entry.file = filePath;
          } catch (err) {
            log('blob write error', err.message);
            res.writeHead(500, CORS).end('write error');
            return;
          }
        }

        blobs.set(id, entry);
        log('blob stored', id, entry.size, entry.buffer ? 'memory' : 'disk');

        res.writeHead(201, { 'content-type': 'application/json', ...CORS })
           .end(JSON.stringify({
             id,
             size: entry.size,
             expiresAt: entry.createdAt + BLOB_TTL_MS,
           }));
      });
      return;
    }

  // GET /blob/:id
    if (req.method === 'GET' && path.startsWith('/blob/')) {
    setBlobCors(req, res);
    const id = path.slice(6).replace(/[^a-z0-9\-]/gi, '').slice(0, 32);
    const entry = blobs.get(id);
    if (!entry) {
      res.writeHead(404).end('not found');
      return;
    }

    const corsHeaders = {};
    const origin = req.headers['origin'] || '';
    const allowed = [
      'https://afjk.jp',
      'https://staging.afjk.jp',
      'http://localhost:8888',
      'http://localhost:3000',
    ];
    if (allowed.includes(origin)) {
      corsHeaders['Access-Control-Allow-Origin'] = origin;
    }

    if (entry.buffer) {
      res.writeHead(200, {
        'content-type': 'model/gltf-binary',
        'content-length': entry.size,
        'cache-control': 'no-store',
        ...corsHeaders,
      }).end(entry.buffer);
    } else if (entry.file) {
      const stream = createReadStream(entry.file);
      res.writeHead(200, {
        'content-type': 'model/gltf-binary',
        'content-length': entry.size,
        'cache-control': 'no-store',
        ...corsHeaders,
      });
      stream.pipe(res);
      stream.on('error', (err) => {
        log(`[blob] read error ${id}:`, err.message);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    }
    return;
  }

  // DELETE /blob/:id
    if (req.method === 'DELETE' && path.startsWith('/blob/')) {
    setBlobCors(req, res);
    const id = path.slice(6).replace(/[^a-z0-9\-]/gi, '').slice(0, 32);
    deleteBlob(id);
    res.writeHead(204).end();
    return;
  }

  // GET /stats
    if (req.method === 'GET' && (path === '/stats' || path === '/stats/export')) {
    const url = getRequestUrl(req);
    const limit = Math.min(Number(url.searchParams.get('limit')) || STATS_LOG_LIMIT, STATS_LOG_LIMIT);
    const typeFilter = url.searchParams.get('type');
    const format = (url.searchParams.get('format') || 'json').toLowerCase();
    let logs = stats.logs.slice(-limit);
    if (typeFilter) {
      logs = logs.filter(entry => entry.type === typeFilter);
    }
    if (format === 'csv') {
      const header = 'ts,type,bytes,meta\n';
      const rows = logs.map(entry => {
        const meta = entry.meta ? JSON.stringify(entry.meta) : '';
        return `${entry.ts},${entry.type},${entry.bytes},"${meta.replace(/"/g, '""')}"`;
      }).join('\n');
      res.writeHead(200, { 'content-type': 'text/csv', ...CORS })
         .end(header + rows);
      return;
    }
    const streamStats = await fetchStreamStats();
    const payload = {
      summary: stats.summary,
      stream: streamStats,
      logs,
    };
    res.writeHead(200, { 'content-type': 'application/json', ...CORS })
       .end(JSON.stringify(payload));
    return;
  }

  // POST /stats
    if (req.method === 'POST' && path === '/stats') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (payload && typeof payload === 'object') {
          recordTransfer(payload);
        }
      } catch {}
      res.writeHead(204, CORS).end();
    });
    return;
  }

  // GET /api/ice-config — STUN + optional TURN (set TURN_URL / TURN_USERNAME / TURN_CREDENTIAL env vars)
  // CORS は同一サイト・ローカル開発のみ許可（外部サイトから credentials を取得されないよう制限）
    if (req.method === 'GET' && path === '/api/ice-config') {
    const origin = (req.headers['origin'] || '').replace(/\/$/, '');
    const prodOrigin = (process.env.ALLOWED_ORIGIN || 'https://afjk.jp').replace(/\/$/, '');
    const devOrigins = (process.env.ALLOWED_DEV_ORIGINS || 'http://localhost:8888,http://127.0.0.1:8888')
      .split(',')
      .map(o => o.trim().replace(/\/$/, ''))
      .filter(Boolean);
    const allowed = !origin
      || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      || origin === prodOrigin
      || devOrigins.includes(origin);
    if (!allowed) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden');
      return;
    }
    const iceCors = {
      'content-type': 'application/json',
      'access-control-allow-origin': origin || '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
      vary: 'Origin',
    };
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    const turnServers = buildTurnServers();
    if (turnServers.length) {
      turnServers.forEach(entry => iceServers.push(entry));
    }
    res.writeHead(200, iceCors).end(JSON.stringify(iceServers));
    return;
  }

  // ── AI Pairing Endpoints ────────────────────────────────────────────
  // POST /api/link/initiate
  if (req.method === 'POST' && path === '/api/link/initiate') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }

    const { roomId, userId, peerId } = body;
    if (!roomId || !userId) {
      sendJson(res, 400, { error: 'missing roomId or userId' });
      return;
    }

    const sanitized = sanitizeRoom(roomId);
    if (!sanitized) {
      sendJson(res, 400, { error: 'invalid roomId' });
      return;
    }

    const { code, expiresAt } = initiatePairingCode(sanitized, userId, peerId || null);
    sendJson(res, 200, { code, expiresAt });
    return;
  }

  // POST /api/link/redeem
  if (req.method === 'POST' && path === '/api/link/redeem') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }

    const { code } = body;
    if (!code) {
      sendJson(res, 400, { error: 'missing code' });
      return;
    }

    const result = redeemPairingCode(code);
    if (!result.ok) {
      const statusCode = result.error === 'not found' ? 404 : result.error === 'already redeemed' ? 410 : 400;
      sendJson(res, statusCode, { error: result.error });
      return;
    }

    broadcastAiLinkEstablished(result.roomId, result);

    sendJson(res, 200, result);
    return;
  }

  // POST /api/link/revoke
  if (req.method === 'POST' && path === '/api/link/revoke') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }

    let linkId = body?.linkId;
    let revokeUserId = null;
    let revokeRoomId = null;

    // If Authorization Bearer token provided, extract linkId from it
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const result = verifyLinkToken(token);
      if (result.valid) {
        linkId = result.payload.linkId;
        revokeUserId = result.payload.userId;
        revokeRoomId = result.payload.roomId;
      }
    }

    if (!linkId) {
      sendJson(res, 400, { error: 'missing linkId or Authorization header' });
      return;
    }

    if (!revokeRoomId) {
      const activeLink = getActiveLink(linkId);
      if (activeLink) {
        revokeUserId = activeLink.userId;
        revokeRoomId = activeLink.roomId;
      }
    }

    revokeLinkToken(linkId);

    broadcastAiLinkRevoked(revokeRoomId, linkId, 'ai-revoked');

    sendJson(res, 200, { ok: true });
    return;
  }

  // ── GPT Wrapper Endpoints ───────────────────────────────────────────
  if (req.method === 'POST' && path === '/api/gpt/link/redeem') {
    const body = await readJsonBody(req).catch(() => null);
    if (!body || typeof body.code !== 'string') {
      sendJson(res, 400, { error: 'code is required' });
      return;
    }

    const result = redeemPairingCode(body.code);
    if (!result.ok) {
      const statusCode = result.error === 'not found' ? 404 : result.error === 'already redeemed' ? 410 : 400;
      sendJson(res, statusCode, { error: result.error });
      return;
    }

    broadcastAiLinkEstablished(result.roomId, result);
    const session = encodeSession(result.linkToken, {
      roomId: result.roomId,
      exp: result.expiresAt,
    });
    sendJson(res, 200, {
      ok: true,
      sessionId: session.sessionId,
      roomId: session.roomId,
      expiresAt: session.expiresAt,
    });
    return;
  }

  if (req.method === 'POST' && path === '/api/gpt/link/revoke') {
    const body = await readJsonBody(req).catch(() => null);
    const session = resolveGptSession(body);
    if (!session.ok) {
      sendJson(res, session.status, { error: session.error });
      return;
    }

    revokeLinkToken(session.payload.linkId);
    broadcastAiLinkRevoked(session.payload.roomId, session.payload.linkId, 'ai-revoked');
    sendJson(res, 200, { ok: true });
    return;
  }

  const gptRoomApiMatch = path.match(/^\/api\/gpt\/room\/([^/]+)\/(scene|broadcast|ai-command)$/);
  if (gptRoomApiMatch && req.method === 'POST') {
    const roomId = sanitizeRoom(gptRoomApiMatch[1]);
    const action = gptRoomApiMatch[2];
    if (!roomId) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    const body = await readJsonBody(req).catch(() => null);
    const session = resolveGptSession(body, roomId);
    if (!session.ok) {
      sendJson(res, session.status, { error: session.error });
      return;
    }

    if (action === 'scene') {
      const sceneState = await fetchRoomSceneState(roomId, createApiSender('AI'));
      sendJson(res, 200, sceneState);
      return;
    }

    if (action === 'broadcast') {
      if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
        sendJson(res, 400, { error: 'payload is required' });
        return;
      }
      if (body.payload.kind === 'ai-command') {
        sendJson(res, 400, { error: 'use /api/gpt/room/{roomId}/ai-command for ai-command' });
        return;
      }

      const result = await runRoomBroadcast({
        roomId,
        payload: body.payload,
        onBehalfOfUserId: session.payload.userId,
        sender: createApiSender('AI'),
      });
      sendJson(res, result.status, result.body);
      return;
    }

    if (action === 'ai-command') {
      if (typeof body.action !== 'string' || !body.action.trim()) {
        sendJson(res, 400, { error: 'action is required' });
        return;
      }

      const result = await runAiCommand({
        roomId,
        onBehalfOfUserId: session.payload.userId,
        payload: {
          kind: 'ai-command',
          requestId: body.requestId || `req-${Date.now()}`,
          action: body.action,
          params: body.params && typeof body.params === 'object' ? body.params : {},
          targetPeerId: body.targetPeerId,
        },
        sender: createApiSender('AI'),
      });
      sendJson(res, result.status, result.body);
      return;
    }
  }

    const roomApiMatch = path.match(/^\/api\/room\/([^/]+)\/(broadcast|scene)$/);
    if (roomApiMatch) {
      const roomId = sanitizeRoom(roomApiMatch[1]);
      const action = roomApiMatch[2];
      const url = getRequestUrl(req);
      const name = url.searchParams.get('name') || url.searchParams.get('nickname') || 'AI';
      const sender = createApiSender(name);

      if (!roomId) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }

      if (req.method === 'POST' && action === 'broadcast') {
        let payload;
        try {
          payload = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' });
          return;
        }

        if (payload && typeof payload === 'object' && payload.payload && typeof payload.payload === 'object') {
          payload = payload.payload;
        }

        // Validate linkToken if Authorization Bearer header is present
        let onBehalfOfUserId = null;
        const authHeader = req.headers['authorization'] || '';
        if (authHeader.startsWith('Bearer ')) {
          const token = authHeader.slice(7);
          const result = verifyLinkToken(token);
          if (!result.valid) {
            sendJson(res, 401, { error: result.error });
            return;
          }
          // Ensure token roomId matches URL roomId
          if (result.payload.roomId !== roomId) {
            sendJson(res, 403, { error: 'roomId mismatch' });
            return;
          }
          onBehalfOfUserId = result.payload.userId;
        }

        const result = await runRoomBroadcast({
          roomId,
          payload,
          onBehalfOfUserId,
          sender,
        });
        sendJson(res, result.status, result.body);
        return;
      }

      if (req.method === 'GET' && action === 'scene') {
        const sceneState = await fetchRoomSceneState(roomId, sender);
        sendJson(res, 200, sceneState);
        return;
      }
    }

    res.writeHead(200, { 'content-type': 'text/plain' }).end('presence ok');
  });

  server.on('upgrade', (req, socket) => {
    const url = getRequestUrl(req);
    if (url.pathname !== '/' && url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const roomOverride = sanitizeRoom(url.searchParams.get('room'));
    const roomId = roomOverride || inferRoomFromReq(req);
    const conn = acceptWebSocket(req, socket);
    if (!conn) return;

    const client = makeClient(conn, roomId);
    log('client connected', client.id, 'room', roomId);

    conn.send({ type: 'welcome', id: client.id, room: roomId });
    broadcastPeers(roomId);

    conn.onMessage = raw => {
      client.lastSeen = Date.now();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }

      if (handlePendingSceneState(data)) {
        return;
      }

      if (handlePendingAiCommandResult(data)) {
        return;
      }

      switch (data.type) {
        case 'hello':
          client.nickname = sanitizeName(data.nickname);
          client.device = sanitizeDevice(data.device);
          client.streaming = Boolean(data.streaming);
          if (data.userId) {
            client.userId = String(data.userId);
          }
          broadcastPeers(roomId);
          break;
        case 'handoff':
          if (data.targetId && data.payload) {
            deliverHandoff(client, data);
          }
          break;
        case 'broadcast':
          if (data.payload) {
            broadcastHandoff(client, data);
          }
          break;
        case 'ping':
          safeSend(conn, { type: 'pong', at: Date.now() });
          break;
        default:
          break;
      }
    };

    conn.onClose = () => {
      log('client disconnected', client.id);
      removeClient(client);
      broadcastPeers(roomId);
    };
  });

  const blobCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of blobs) {
      if (now - entry.createdAt > BLOB_TTL_MS) {
        log('blob expired', id);
        deleteBlob(id);
      }
    }
  }, BLOB_CLEANUP_INTERVAL);

  const heartbeatInterval = setInterval(() => {
    rooms.forEach(room => {
      room.forEach(client => {
        if (!client.conn.alive) {
          client.conn.close();
          return;
        }
        client.conn.alive = false;
        client.conn.ping();
      });
    });
  }, HEARTBEAT_MS);

  server.on('close', () => {
    clearInterval(blobCleanupInterval);
    clearInterval(heartbeatInterval);
    rooms.clear();
    pendingSceneRequests.forEach(({ timer, resolve }) => {
      clearTimeout(timer);
      resolve({ objects: {} });
    });
    pendingSceneRequests.clear();
    pendingAiCommandResults.forEach(({ timer, resolve }) => {
      clearTimeout(timer);
      resolve({ kind: 'ai-result', ok: false, error: 'server stopped' });
    });
    pendingAiCommandResults.clear();
  });

  server.stop = () => {
    rooms.forEach(room => {
      room.forEach(client => client.conn.close());
    });
    return new Promise(resolve => server.close(resolve));
  };

  return server;
}

// ── Blob Store Cleanup ────────────────────────────────────
function deleteBlob(id) {
  const entry = blobs.get(id);
  if (!entry) return;
  if (entry.file) {
    try { unlinkSync(entry.file); } catch {}
  }
  blobs.delete(id);
  log('blob deleted', id);
}

export { createPresenceServer };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createPresenceServer();
  server.listen(PORT, () => {
    log(`presence server listening on ${PORT}`);
  });
}
