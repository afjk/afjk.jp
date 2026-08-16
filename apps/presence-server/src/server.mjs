import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { URL, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, createReadStream, createWriteStream, renameSync, readdirSync, statfsSync } from 'node:fs';
import { verifyLinkToken, initiatePairingCode, redeemPairingCode, revokeLinkToken, getActiveLink } from './link-token.mjs';
import { encodeSession, decodeSession } from './gpt-session.mjs';
import { createSceneSyncConfig } from './scenesync/config.mjs';
import { getActorIdFromRequest } from './scenesync/actor-id.mjs';
import { createPerActorRateLimiter } from './scenesync/rate-limit.mjs';
import { validateUpload, isGlbLike } from './scenesync/upload-guards.mjs';
import { validateSceneSyncPayload } from './scenesync/message-schema.mjs';
import { createSceneSyncLogger } from './scenesync/logger.mjs';
import { createGlbBackupManager } from './scenesync/glb-backup.mjs';
import { createServerPullImporter, validateImportJobInput } from './scenesync/server-pull-import.mjs';
import { createHandoffTokenStore } from './scenesync/handoff-token-store.mjs';
import { isValidHandoffToken, validateHandoffTokenPayload } from './scenesync/handoff-token-payload.mjs';

// IP hash salt — stable within process lifetime if not provided
const localIpHashSalt = randomUUID();

const PORT = Number(process.env.PORT || 8787);
const HEARTBEAT_MS = 30000;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HANDOFF_BINDING_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;
const sceneSyncConfig = createSceneSyncConfig(process.env);
const MAX_MESSAGE_SIZE = sceneSyncConfig.maxJsonBytes;
const STATS_FILE = process.env.STATS_FILE || '/data/stats.json';
const STATS_ARCHIVE_DIR = process.env.STATS_ARCHIVE_DIR || '/data/archive';
const isValidHandoffId = (value) => typeof value === 'string' && HANDOFF_BINDING_ID_PATTERN.test(value);

// ── Scene Graph Protocol ────────────────────────────────────────────────────
const SCENE_GRAPH_MESSAGE_TYPES = new Set([
  'scene-graph-set',
  'scene-graph-clear',
  'scene-graph-patch',
  'scene-graph-input'
]);
const SCENE_GRAPH_MAX_SIZE = 64 * 1024; // 64 KB for graph payloads

const rooms = new Map(); // roomId -> Map<clientId, Client>
const roomObjectIds = new Map(); // roomId -> Set<objectId>
const roomPhysicsTimelines = new Map(); // roomId -> Map<timelineId, PhysicsTimeline>
const roomSceneClocks = new Map(); // roomId -> latest canonical scene-clock payload
const pendingSceneRequests = new Map(); // apiRequestId -> { resolve, timer }
const pendingAiCommandResults = new Map(); // apiRequestId -> { resolve, timer }
const clientsByIpHash = new Map(); // ipHash -> Set<clientId>

const SCENE_SYNC_PHYSICS_TIMELINE_VERSION = 'SceneSyncPhysicsTimelineV1';
const DEFAULT_SCENE_PHYSICS_TIMELINE_ID = 'default';
const MAX_SCENE_PHYSICS_TIMELINE_EVENTS = Math.max(
  1,
  Math.floor(Number(process.env.SCENE_SYNC_PHYSICS_TIMELINE_EVENT_LIMIT) || 1024),
);

// ── Blob Store ────────────────────────────────────────────────────────────────
const BLOB_MAX_SIZE = sceneSyncConfig.maxUploadBytes;
const BLOB_MEMORY_THRESHOLD = 1 * 1024 * 1024; // 1MB
const BLOB_TTL_MS = 10 * 60 * 1000; // 10分
const BLOB_CLEANUP_INTERVAL = 60 * 1000; // 60秒
const BLOB_DIR = process.env.BLOB_DIR || '/data/blobs';
const sceneSyncLogger = createSceneSyncLogger({
  enabled: sceneSyncConfig.logEnabled,
  logDir: sceneSyncConfig.logDir,
  maxLineBytes: sceneSyncConfig.logMaxLineBytes,
});
const glbBackupManager = createGlbBackupManager(sceneSyncConfig, sceneSyncLogger);
const uploadRateLimiter = createPerActorRateLimiter(sceneSyncConfig.uploadsPerActorPerMinute);
const serverPullRateLimiter = createPerActorRateLimiter(sceneSyncConfig.serverPullsPerActorPerMinute);
let serverPullReservedBytes = 0;
let serverPullLiveBytes = 0;

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
  return String(raw)
    .trim()
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .slice(0, 32);
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

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const first = forwarded ? forwarded.split(',')[0].trim() : null;
  return first || req.socket.remoteAddress || 'unknown';
}

function getIpHash(req, ipHashSalt) {
  const rawIp = getClientIp(req);
  const salt = ipHashSalt || localIpHashSalt;
  return createHash('sha256')
    .update(`${salt}:${rawIp}`)
    .digest('hex')
    .slice(0, 12);
}

function getTotalClientCount() {
  let total = 0;
  rooms.forEach(room => {
    total += room.size;
  });
  return total;
}

function getRoomClientCount(roomId) {
  const room = rooms.get(roomId);
  return room ? room.size : 0;
}

function getIpClientCount(ipHash) {
  const clients = clientsByIpHash.get(ipHash);
  return clients ? clients.size : 0;
}

function getTopRooms(limit = 5) {
  const entries = Array.from(rooms.entries())
    .map(([roomId, room]) => ({ roomId, clientCount: room.size }))
    .sort((a, b) => b.clientCount - a.clientCount)
    .slice(0, limit);
  return entries;
}

function getTopIpHashes(limit = 5) {
  const entries = Array.from(clientsByIpHash.entries())
    .map(([ipHash, clients]) => ({ ipHash, clientCount: clients.size }))
    .sort((a, b) => b.clientCount - a.clientCount)
    .slice(0, limit);
  return entries;
}

function inferRoomFromReq(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const first = forwarded ? forwarded.split(',')[0].trim() : null;
  const ip = first || req.socket.remoteAddress || 'global';

  if (ip.includes(':')) {
    return sanitizeRoom(ip.replace('::ffff:', '').split(':')[0]) || 'global-v6';
  }

  const parts = ip.split('.');
  if (parts.length === 4) {
    return sanitizeRoom(`${parts[0]}-${parts[1]}-${parts[2]}-x`) || 'global';
  }

  return sanitizeRoom(ip) || 'global';
}

function shouldEnforceRoomConnectionLimit({ roomOverride }) {
  return Boolean(roomOverride);
}

function isValidScope(scope) {
  if (scope === 'scene') return true;
  if (typeof scope === 'object' && scope !== null && !Array.isArray(scope)) {
    return typeof scope.object === 'string' && scope.object.length > 0;
  }
  return false;
}

function validateSceneGraphMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return { ok: false, error: 'message must be an object' };
  }
  if (typeof msg.type !== 'string') {
    return { ok: false, error: 'type must be a string' };
  }
  if (!SCENE_GRAPH_MESSAGE_TYPES.has(msg.type)) {
    return { ok: false, error: 'unsupported scene-graph message type' };
  }

  if (!isValidScope(msg.scope)) {
    return { ok: false, error: 'invalid scope' };
  }

  if (msg.type === 'scene-graph-set' || msg.type === 'scene-graph-patch') {
    if (!msg.graph || typeof msg.graph !== 'object') {
      return { ok: false, error: 'graph is required' };
    }
    if (!Array.isArray(msg.graph.nodes) || !Array.isArray(msg.graph.edges)) {
      return { ok: false, error: 'graph.nodes and graph.edges must be arrays' };
    }
  }

  if (msg.type === 'scene-graph-input') {
    if (typeof msg.ref !== 'string') {
      return { ok: false, error: 'ref must be a string' };
    }
  }

  return { ok: true };
}

function logSceneGraphMessage(msg) {
  const scopeStr = msg.scope === 'scene' ? 'scene' : JSON.stringify(msg.scope);
  switch (msg.type) {
    case 'scene-graph-set':
      log('[SceneSync] scene-graph-set scope=' + scopeStr + ' nodes=' + msg.graph.nodes.length + ' edges=' + msg.graph.edges.length);
      break;
    case 'scene-graph-clear':
      log('[SceneSync] scene-graph-clear scope=' + scopeStr);
      break;
    case 'scene-graph-patch':
      log('[SceneSync] scene-graph-patch scope=' + scopeStr + (msg.graph ? ' nodes=' + msg.graph.nodes.length + ' edges=' + msg.graph.edges.length : ''));
      break;
    case 'scene-graph-input':
      log('[SceneSync] scene-graph-input scope=' + scopeStr + ' ref=' + msg.ref);
      break;
  }
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

  terminate() {
    try {
      this.socket.destroy();
    } catch {}
    this.#handleClose();
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

function makeClient(conn, roomId, ipHash) {
  const client = {
    id: randomUUID(),
    conn,
    roomId,
    userId: null,
    nickname: '',
    device: '',
    streaming: false,
    lastSeen: Date.now(),
    connectedAt: Date.now(),
    ipHash
  };
  const room = rooms.get(roomId) ?? new Map();
  room.set(client.id, client);
  rooms.set(roomId, room);

  if (ipHash) {
    const clients = clientsByIpHash.get(ipHash) ?? new Set();
    clients.add(client.id);
    clientsByIpHash.set(ipHash, clients);
  }

  return client;
}

function removeClient(client) {
  const room = rooms.get(client.roomId);
  if (!room) return;
  room.delete(client.id);
  if (!room.size) {
    rooms.delete(client.roomId);
    roomObjectIds.delete(client.roomId);
    roomPhysicsTimelines.delete(client.roomId);
    roomSceneClocks.delete(client.roomId);
  }

  if (client.ipHash) {
    const clients = clientsByIpHash.get(client.ipHash);
    if (clients) {
      clients.delete(client.id);
      if (!clients.size) {
        clientsByIpHash.delete(client.ipHash);
      }
    }
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
    sceneSyncLogger.log('error', { reason: err.message });
  }
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stableJsonStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizePhysicsTimelineId(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : DEFAULT_SCENE_PHYSICS_TIMELINE_ID;
}

function cloneRoomPhysicsTimelines(roomId) {
  const source = roomPhysicsTimelines.get(roomId);
  const draft = new Map();
  if (!source) return draft;
  for (const [timelineId, timeline] of source.entries()) {
    draft.set(timelineId, {
      timelineId: timeline.timelineId,
      timelineRevision: timeline.timelineRevision,
      forkTick: timeline.forkTick,
      lastEventRevision: timeline.lastEventRevision,
      clearRevision: timeline.clearRevision || 0,
      events: cloneJson(timeline.events) || [],
    });
  }
  return draft;
}

function commitRoomPhysicsTimelines(roomId, timelines) {
  if (!timelines || timelines.size === 0) {
    roomPhysicsTimelines.delete(roomId);
    return;
  }
  roomPhysicsTimelines.set(roomId, timelines);
}

function getPhysicsTimeline(timelines, timelineId) {
  const normalizedTimelineId = normalizePhysicsTimelineId(timelineId);
  const existing = timelines.get(normalizedTimelineId);
  if (existing) return existing;

  const timeline = {
    timelineId: normalizedTimelineId,
    timelineRevision: 0,
    forkTick: 0,
    lastEventRevision: 0,
    clearRevision: 0,
    events: [],
  };
  timelines.set(normalizedTimelineId, timeline);
  return timeline;
}

function resetRoomPhysicsTimelines(timelines) {
  timelines.clear();
}

function getLatestPhysicsEventTick(timeline) {
  return timeline.events.reduce((max, event) => Math.max(max, Number(event.applyTick) || 0), 0);
}

function branchPhysicsTimeline(timeline, branchTick) {
  const normalizedBranchTick = Math.max(0, Math.floor(Number(branchTick) || 0));
  timeline.timelineRevision += 1;
  timeline.forkTick = normalizedBranchTick;
  timeline.events = timeline.events.filter(event => Number(event.applyTick) <= normalizedBranchTick);
}

function findPhysicsTimelineEventByInputId(timeline, inputId) {
  if (typeof inputId !== 'string' || !inputId.trim()) return null;
  return timeline.events.find(event => event.inputId === inputId.trim()) || null;
}

function areSceneBatchOperationsMirrored(ops, actions) {
  if (!Array.isArray(ops) || !Array.isArray(actions)) return false;
  if (ops.length !== actions.length) return false;
  for (let index = 0; index < ops.length; index += 1) {
    if (stableJsonStringify(ops[index]) !== stableJsonStringify(actions[index])) return false;
  }
  return true;
}

function collectSceneBatchOperations(payload) {
  const ops = Array.isArray(payload?.ops) ? payload.ops : null;
  const actions = Array.isArray(payload?.actions) ? payload.actions : null;
  if (ops && actions) {
    return areSceneBatchOperationsMirrored(ops, actions)
      ? ops
      : [...ops, ...actions];
  }
  return ops || actions || [];
}

function clearPhysicsTimeline(timelines, timelineId) {
  const timeline = getPhysicsTimeline(timelines, timelineId);
  // A clear opens a fresh timeline epoch. timelineRevision is the branch/epoch
  // counter and clearRevision is the history-clear generation; both advance by
  // one. Stale inputs from before the clear are rejected because their
  // clearRevision no longer matches (see canonicalize stale check below).
  timeline.timelineRevision += 1;
  timeline.clearRevision += 1;
  timeline.forkTick = 0;
  timeline.lastEventRevision = 0;
  timeline.events = [];
  return timeline;
}

function canonicalizeScenePhysicsPayloadInTimelines(timelines, payload) {
  if (payload?.kind === 'scene-batch') {
    const nextPayload = { ...payload };
    if (
      Array.isArray(payload.ops) &&
      Array.isArray(payload.actions) &&
      areSceneBatchOperationsMirrored(payload.ops, payload.actions)
    ) {
      const operations = [];
      for (const operation of payload.ops) {
        const result = canonicalizeScenePhysicsPayloadInTimelines(timelines, operation);
        if (!result.ok) return result;
        operations.push(result.payload);
      }
      nextPayload.ops = operations;
      nextPayload.actions = cloneJson(operations);
      return { ok: true, payload: nextPayload };
    }

    for (const key of ['ops', 'actions']) {
      if (!Array.isArray(payload[key])) continue;
      const operations = [];
      for (const operation of payload[key]) {
        const result = canonicalizeScenePhysicsPayloadInTimelines(timelines, operation);
        if (!result.ok) return result;
        operations.push(result.payload);
      }
      nextPayload[key] = operations;
    }
    return { ok: true, payload: nextPayload };
  }

  if (payload?.kind === 'scene-physics-input-log-clear') {
    const timelineId = normalizePhysicsTimelineId(payload.timelineId);
    const timeline = clearPhysicsTimeline(timelines, timelineId);
    return {
      ok: true,
      payload: {
        ...payload,
        timelineVersion: SCENE_SYNC_PHYSICS_TIMELINE_VERSION,
        timelineId,
        timelineRevision: timeline.timelineRevision,
        timelineForkTick: timeline.forkTick,
        timelineClearRevision: timeline.clearRevision,
        lastEventRevision: timeline.lastEventRevision,
      },
    };
  }

  if (payload?.kind !== 'scene-physics-input') {
    if (payload?.kind === 'scene-state') {
      resetRoomPhysicsTimelines(timelines);
    }
    if (payload?.kind === 'scene-physics' && payload?.physics?.enabled !== true) {
      resetRoomPhysicsTimelines(timelines);
    }
    return { ok: true, payload };
  }

  const timelineId = normalizePhysicsTimelineId(payload.timelineId);
  const timeline = getPhysicsTimeline(timelines, timelineId);
  const applyTick = Math.max(0, Math.floor(Number(payload.applyTick) || 0));
  const requestedBranchTick = Math.max(0, Math.floor(Number(payload.branchTick ?? applyTick) || 0));
  const branchTick = Math.min(requestedBranchTick, applyTick);
  const payloadTimelineRevision = Math.max(0, Math.floor(Number(payload.timelineRevision) || 0));
  const payloadTimelineClearRevision = Math.max(0, Math.floor(Number(payload.timelineClearRevision) || 0));
  const latestTick = getLatestPhysicsEventTick(timeline);
  const existingEvent = findPhysicsTimelineEventByInputId(timeline, payload.inputId);
  if (existingEvent) {
    return { ok: true, payload: cloneJson(existingEvent), duplicate: true };
  }

  if (
    payloadTimelineRevision < timeline.timelineRevision ||
    payloadTimelineClearRevision !== (timeline.clearRevision || 0)
  ) {
    return {
      ok: false,
      status: 409,
      error: 'stale_physics_timeline',
      message: '古い物理タイムラインの入力は破棄されました。',
    };
  }

  const shouldBranch = payloadTimelineRevision > timeline.timelineRevision || applyTick < latestTick;

  if (shouldBranch) {
    branchPhysicsTimeline(timeline, branchTick);
  }

  timeline.lastEventRevision += 1;
  const eventRevision = timeline.lastEventRevision;
  const inputId = typeof payload.inputId === 'string' && payload.inputId.trim()
    ? payload.inputId.trim()
    : `${timelineId}:${timeline.timelineRevision}:${eventRevision}`;
  const event = {
    ...payload,
    inputId,
    timelineVersion: SCENE_SYNC_PHYSICS_TIMELINE_VERSION,
    timelineId,
    timelineRevision: timeline.timelineRevision,
    timelineForkTick: timeline.forkTick,
    timelineClearRevision: timeline.clearRevision || 0,
    branchTick,
    eventRevision,
  };

  timeline.events.push(cloneJson(event));
  while (timeline.events.length > MAX_SCENE_PHYSICS_TIMELINE_EVENTS) {
    timeline.events.shift();
  }

  return { ok: true, payload: event };
}

function canonicalizeScenePhysicsPayload(roomId, payload) {
  const draft = cloneRoomPhysicsTimelines(roomId);
  const result = canonicalizeScenePhysicsPayloadInTimelines(draft, payload);
  if (result.ok) {
    commitRoomPhysicsTimelines(roomId, draft);
  }
  return result;
}

function canonicalizeSceneClockPayload(roomId, payload) {
  if (payload?.kind !== 'scene-clock') {
    return { ok: true, payload };
  }

  const previous = roomSceneClocks.get(roomId);
  const previousRevision = Math.max(0, Math.floor(Number(previous?.revision) || 0));
  const nextPayload = {
    ...payload,
    mode: payload.mode || 'shared-playback',
    source: payload.source || 'room',
    revision: previousRevision + 1,
  };

  roomSceneClocks.set(roomId, cloneJson(nextPayload));
  return { ok: true, payload: nextPayload };
}

function payloadIncludesScenePhysicsInput(payload) {
  if (payload?.kind === 'scene-physics-input') return true;
  if (payload?.kind !== 'scene-batch') return false;
  const operations = collectSceneBatchOperations(payload);
  return operations.some(payloadIncludesScenePhysicsInput);
}

// True when a payload must flow through the room physics timeline canonicalizer
// (to be recorded / assigned a canonical eventRevision, or to clear the log).
function payloadRequiresScenePhysicsTimeline(payload) {
  if (payload?.kind === 'scene-physics-input') return true;
  if (payload?.kind === 'scene-physics-input-log-clear') return true;
  if (payload?.kind !== 'scene-batch') return false;
  const operations = collectSceneBatchOperations(payload);
  return operations.some(payloadRequiresScenePhysicsTimeline);
}

function payloadRequiresScenePhysicsSenderEcho(payload) {
  if (payload?.kind === 'scene-clock') return true;
  if (payload?.kind === 'scene-physics-input-log-clear') return true;
  if (payloadIncludesScenePhysicsInput(payload)) return true;
  if (payload?.kind !== 'scene-batch') return false;
  const operations = collectSceneBatchOperations(payload);
  return operations.some(payloadRequiresScenePhysicsSenderEcho);
}

function sendRoomSceneClock(client) {
  const latest = roomSceneClocks.get(client.roomId);
  if (!latest) return;
  safeSend(client.conn, {
    type: 'handoff',
    from: {
      id: 'server',
      nickname: 'SceneSync',
      device: 'server',
    },
    payload: {
      ...cloneJson(latest),
      action: 'mode',
    },
  });
}

function getRequestedRoomPhysicsTimelineId(payload) {
  if (payload?.kind === 'scene-physics-input-log-request') {
    return payload.timelineId || null;
  }
  if (payload?.kind !== 'scene-event-log-request') {
    return false;
  }

  const timelines = Array.isArray(payload.timelines) ? payload.timelines : [];
  if (timelines.length > 0) {
    const physicsTimeline = timelines.find(timeline => (
      timeline &&
      typeof timeline === 'object' &&
      !Array.isArray(timeline) &&
      (
        timeline.source === 'physics' ||
        (
          timeline.source === undefined &&
          timeline.timelineId !== undefined &&
          normalizePhysicsTimelineId(timeline.timelineId) === normalizePhysicsTimelineId(payload.timelineId)
        )
      )
    ));
    return physicsTimeline ? (physicsTimeline.timelineId || null) : false;
  }

  return payload.timelineId || null;
}

function sendRoomPhysicsTimeline(client, timelineId = null) {
  const roomTimelines = roomPhysicsTimelines.get(client.roomId);
  if (!roomTimelines) return;
  const sender = {
    id: 'server',
    nickname: 'SceneSync',
    device: 'server',
  };

  const normalizedTimelineId = timelineId ? normalizePhysicsTimelineId(timelineId) : null;
  for (const timeline of roomTimelines.values()) {
    if (normalizedTimelineId && timeline.timelineId !== normalizedTimelineId) continue;
    if (timeline.clearRevision > 0) {
      safeSend(client.conn, {
        type: 'handoff',
        from: sender,
        payload: {
          kind: 'scene-physics-input-log-clear',
          timelineVersion: SCENE_SYNC_PHYSICS_TIMELINE_VERSION,
          timelineId: timeline.timelineId,
          timelineRevision: timeline.timelineRevision,
          timelineForkTick: 0,
          timelineClearRevision: timeline.clearRevision,
          lastEventRevision: 0,
          reason: 'timeline-replay',
        },
      });
    }
    for (const event of timeline.events) {
      safeSend(client.conn, {
        type: 'handoff',
        from: sender,
        payload: cloneJson(event),
      });
    }
  }
}

function createHandoffMessage(sender, payload) {
  return {
    type: 'handoff',
    from: {
      id: sender.id,
      nickname: sender.nickname,
      device: sender.device
    },
    payload: payload || {}
  };
}

function deliverHandoff(sender, msg) {
  const room = rooms.get(sender.roomId);
  if (!room) return;
  const target = room.get(msg.targetId);
  if (!target) return;
  let payload = msg.payload;
  // scene-physics-input is broadcast-shaped state: even when it arrives as a
  // targeted handoff it must pass through the room physics timeline so it gets a
  // canonical eventRevision (and clears are recorded), matching the broadcast path.
  if (payloadRequiresScenePhysicsTimeline(payload)) {
    const physicsTimelinePayload = canonicalizeScenePhysicsPayload(sender.roomId, payload);
    if (!physicsTimelinePayload.ok) {
      safeSend(sender.conn, {
        type: 'error',
        error: physicsTimelinePayload.error || 'physics_timeline_rejected',
        message: physicsTimelinePayload.message,
      });
      return;
    }
    payload = physicsTimelinePayload.payload;
  }
  const sceneClockPayload = canonicalizeSceneClockPayload(sender.roomId, payload);
  if (!sceneClockPayload.ok) {
    safeSend(sender.conn, {
      type: 'error',
      error: sceneClockPayload.error || 'scene_clock_rejected',
      message: sceneClockPayload.message,
    });
    return;
  }
  safeSend(target.conn, createHandoffMessage(sender, sceneClockPayload.payload));
}

function broadcastHandoff(sender, msg, { includeSender = false } = {}) {
  const room = rooms.get(sender.roomId);
  if (!room) return;
  const payload = createHandoffMessage(sender, msg.payload);
  room.forEach(client => {
    if (includeSender || client.id !== sender.id) {
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

// Import jobs are a same-origin control plane, unlike the public presence API.
// Do not attach permissive CORS headers: another origin must not be able to
// turn a visitor's browser into a server-pull client.
function sendImportJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }).end(JSON.stringify(payload));
}

function isSameOriginImportRequest(req, allowedOrigins = sceneSyncConfig.serverPullAllowedOrigins) {
  const origin = String(req.headers.origin || '');
  if (!origin) return false;
  const fetchSite = String(req.headers['sec-fetch-site'] || '');
  return allowedOrigins.includes(origin) && (!fetchSite || fetchSite === 'same-origin');
}

function sendTokenJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }).end(JSON.stringify(payload));
}

const HANDOFF_TOKEN_UPLOAD_CORS = Object.freeze({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

function sendTokenUploadJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json', ...HANDOFF_TOKEN_UPLOAD_CORS }).end(JSON.stringify(payload));
}

function isTokenClaimRequestSameOrigin(req, allowedOrigins = sceneSyncConfig.serverPullAllowedOrigins) {
  return isSameOriginImportRequest(req, allowedOrigins);
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendJsonBodyError(res, error) {
  if (error?.status === 413) {
    sendJson(res, 413, { error: 'payload_too_large', message: 'ファイルの読み込みに失敗しました。' });
    return;
  }
  sendJson(res, 400, { error: 'invalid JSON body' });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      totalBytes += chunk.length;
      if (totalBytes > sceneSyncConfig.maxJsonBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(createHttpError(413, 'JSON body too large'));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        reject(createHttpError(400, 'invalid JSON body'));
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(createHttpError(400, 'invalid JSON body'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(createHttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', () => reject(createHttpError(400, 'invalid JSON body')));
  });
}

function getOrCreateRoomObjectSet(roomId) {
  const existing = roomObjectIds.get(roomId);
  if (existing) return existing;
  const next = new Set();
  roomObjectIds.set(roomId, next);
  return next;
}

function simulateObjectLimitUpdate(objectIds, payload, roomId, actorId) {
  let nextObjectIds = new Set(objectIds);
  if (!payload || typeof payload !== 'object') return { ok: true, nextObjectIds };

  if (payload.kind === 'scene-add' && typeof payload.objectId === 'string') {
    if (!nextObjectIds.has(payload.objectId) && nextObjectIds.size >= sceneSyncConfig.maxObjectsPerRoom) {
      sceneSyncLogger.log('object_limit_reached', {
        roomId,
        actorId,
        kind: payload.kind,
        reason: 'max objects reached',
      });
      return { ok: false, status: 429, error: 'object limit reached', message: '配置できるオブジェクト数の上限に達しました。' };
    }
    nextObjectIds.add(payload.objectId);
  }

  if (payload.kind === 'scene-remove' && typeof payload.objectId === 'string') {
    nextObjectIds.delete(payload.objectId);
  }

  if (payload.kind === 'scene-state' && payload.objects && typeof payload.objects === 'object' && !Array.isArray(payload.objects)) {
    const objectKeys = Object.keys(payload.objects);
    const next = new Set(objectKeys.slice(0, sceneSyncConfig.maxObjectsPerRoom));
    if (objectKeys.length > sceneSyncConfig.maxObjectsPerRoom) {
      sceneSyncLogger.log('object_limit_reached', {
        roomId,
        actorId,
        kind: payload.kind,
        reason: 'scene-state truncated to max object limit',
      });
    }
    nextObjectIds = next;
  }

  if (payload.kind === 'scene-batch') {
    const operations = collectSceneBatchOperations(payload);
    for (const op of operations) {
      const result = simulateObjectLimitUpdate(nextObjectIds, op, roomId, actorId);
      if (!result.ok) return result;
      nextObjectIds = result.nextObjectIds;
    }
  }

  return { ok: true, nextObjectIds };
}

function applySceneObjectLimits(roomId, payload, actorId = '') {
  const objectIds = getOrCreateRoomObjectSet(roomId);
  const result = simulateObjectLimitUpdate(objectIds, payload, roomId, actorId);
  if (!result.ok) return result;
  roomObjectIds.set(roomId, result.nextObjectIds);
  return { ok: true };
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

async function runRoomBroadcast({ roomId, payload, onBehalfOfUserId = null, sender = createApiSender('AI'), actorId = '' }) {
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

  if (
    nextPayload?.kind === 'scene-physics-input-log-request' ||
    nextPayload?.kind === 'scene-event-log-request'
  ) {
    return {
      status: 400,
      body: { error: `${nextPayload.kind} requires a websocket client` },
    };
  }

  if (nextPayload?.type && SCENE_GRAPH_MESSAGE_TYPES.has(nextPayload.type)) {
    const validation = validateSceneGraphMessage(nextPayload);
    if (!validation.ok) {
      return {
        status: 400,
        body: { error: 'invalid scene-graph message', details: validation.error }
      };
    }

    const msgSize = JSON.stringify(nextPayload).length;
    if (msgSize > SCENE_GRAPH_MAX_SIZE) {
      return {
        status: 413,
        body: { error: 'scene-graph message too large' }
      };
    }

    logSceneGraphMessage(nextPayload);

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

  const validation = validateSceneSyncPayload(nextPayload);
  if (!validation.ok) {
    sceneSyncLogger.log('schema_invalid', {
      roomId,
      actorId,
      kind: nextPayload?.kind,
      payloadSize: Buffer.byteLength(JSON.stringify(nextPayload || {}), 'utf8'),
      reason: validation.reason,
    });
    return {
      status: 400,
      body: {
        error: 'invalid scene sync payload',
        reason: validation.reason,
        kind: nextPayload?.kind || null,
      },
    };
  }

  const objectLimit = applySceneObjectLimits(roomId, nextPayload, actorId);
  if (!objectLimit.ok) {
    return {
      status: objectLimit.status,
      body: { error: objectLimit.error, message: objectLimit.message },
    };
  }

  // Always run physics inputs / clears through the room timeline, even with no
  // peers connected, so late joiners receive the full input history. (Other
  // payload kinds pass through unchanged; scene-state still resets the log.)
  {
    const physicsTimelinePayload = canonicalizeScenePhysicsPayload(roomId, nextPayload);
    if (!physicsTimelinePayload.ok) {
      return {
        status: physicsTimelinePayload.status || 409,
        body: {
          error: physicsTimelinePayload.error || 'physics timeline rejected',
          message: physicsTimelinePayload.message,
        },
      };
    }
    nextPayload = physicsTimelinePayload.payload;
  }
  const sceneClockPayload = canonicalizeSceneClockPayload(roomId, nextPayload);
  if (!sceneClockPayload.ok) {
    return {
      status: sceneClockPayload.status || 409,
      body: {
        error: sceneClockPayload.error || 'scene clock rejected',
        message: sceneClockPayload.message,
      },
    };
  }
  nextPayload = sceneClockPayload.payload;

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
    const enableDev = process.env.ENABLE_DEV_TURN === 'true';
    if (enableDev) {
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

async function storeServerPulledBlob({ id, body, mime, maxBytes, signal }) {
  const temporaryPath = `${BLOB_DIR}/.${id}.part`;
  const filePath = `${BLOB_DIR}/${id}.import`;
  let size = 0;
  let reserved = false;
  let output = null;
  try {
    mkdirSync(BLOB_DIR, { recursive: true });
    if (serverPullLiveBytes + serverPullReservedBytes + maxBytes > sceneSyncConfig.serverPullMaxLiveBytes) {
      throw createHttpError(413, 'handoff-server-pull-capacity');
    }
    const fs = statfsSync(BLOB_DIR);
    const freeBytes = Number(fs.bavail) * Number(fs.bsize);
    if (!Number.isFinite(freeBytes) || freeBytes < maxBytes) throw createHttpError(507, 'handoff-server-pull-disk-full');
    serverPullReservedBytes += maxBytes;
    reserved = true;
    output = createWriteStream(temporaryPath, { flags: 'wx' });
    // The write/drain promises below observe operational errors; retain a
    // listener as well so teardown after an abort cannot become unhandled.
    output.on('error', () => {});
    const waitForDrain = () => new Promise((resolve, reject) => {
      const done = () => { output.off('error', failed); resolve(); };
      const failed = (error) => { output.off('drain', done); reject(error); };
      output.once('drain', done);
      output.once('error', failed);
    });
    for await (const raw of body) {
      if (signal?.aborted) { body.destroy?.(); throw createHttpError(504, 'handoff-url-timeout'); }
      const chunk = Buffer.from(raw);
      size += chunk.length;
      if (size > maxBytes) { body.destroy?.(); throw createHttpError(413, 'handoff-remote-asset-too-large'); }
      if (!output.write(chunk)) await waitForDrain();
    }
    await new Promise((resolve, reject) => {
      output.once('error', reject);
      output.end(resolve);
    });
    renameSync(temporaryPath, filePath);
    blobs.set(id, {
      size,
      createdAt: Date.now(),
      contentType: mime || 'application/octet-stream',
      buffer: null,
      file: filePath,
      serverPullBytes: size,
    });
    serverPullLiveBytes += size;
    serverPullReservedBytes -= maxBytes;
    reserved = false;
    return { size, mime, url: `/presence/blob/${id}` };
  } catch (error) {
    try { output?.destroy(error); } catch {}
    try { body.destroy?.(error); } catch {}
    try { unlinkSync(temporaryPath); } catch {}
    try { unlinkSync(filePath); } catch {}
    throw error;
  } finally {
    if (reserved) serverPullReservedBytes -= maxBytes;
  }
}

function createPresenceServer({
  serverPullImporter: injectedServerPullImporter,
  serverPullAllowedOrigins = sceneSyncConfig.serverPullAllowedOrigins,
  // Narrow test transport injection.  Storage remains the server's atomic
  // blob store, never a caller-provided sink.
  serverPullFetchImpl,
  serverPullResolveHost,
  serverPullAllowHttpForTests = false,
  handoffTokenDir,
} = {}) {
  // Import blobs are process-local TTL state. They cannot be safely served
  // after a restart, so remove stale partial/staged files before accepting
  // jobs instead of leaking disk space indefinitely.
  try {
    mkdirSync(BLOB_DIR, { recursive: true });
    for (const name of readdirSync(BLOB_DIR)) {
      if (/^(?:\.[a-f0-9]{32}\.part|[a-f0-9]{32}\.import)$/u.test(name)) {
        try { unlinkSync(`${BLOB_DIR}/${name}`); } catch {}
      }
    }
  } catch (error) {
    log('server pull blob sweep failed', error?.message || String(error));
  }
  sceneSyncLogger.log('server_start', {
    maxUploadBytes: sceneSyncConfig.maxUploadBytes,
    maxJsonBytes: sceneSyncConfig.maxJsonBytes,
    maxRoomConnections: sceneSyncConfig.maxRoomConnections,
    maxObjectsPerRoom: sceneSyncConfig.maxObjectsPerRoom,
  });
  const importJobs = new Map();
  const completedImportJobs = new Map();
  let activeServerPulls = 0;
  const effectiveHandoffTokenDir = handoffTokenDir || sceneSyncConfig.handoffTokenDir;
  const handoffTokenStore = createHandoffTokenStore({
    dir: effectiveHandoffTokenDir,
    maxEntries: sceneSyncConfig.handoffTokenMaxEntries,
    maxActiveUploads: sceneSyncConfig.handoffTokenMaxActiveUploads,
    maxStagedBytes: sceneSyncConfig.handoffTokenMaxStagedBytes,
    maxEncodedBytes: sceneSyncConfig.handoffTokenMaxEncodedBytes,
    minFreeBytes: sceneSyncConfig.handoffTokenMinFreeBytes,
  });
  const handoffTokenRateLimiter = createPerActorRateLimiter(sceneSyncConfig.handoffTokenUploadsPerIpPerMinute);
  const handoffTokenClaimRateLimiter = createPerActorRateLimiter(sceneSyncConfig.handoffTokenClaimsPerIpPerMinute);
  let inFlightTokenUploads = 0;
  let activeTokenClaims = 0;
  // Injection is used by isolated integration tests to supply an in-process
  // HTTPS/DNS transport. Production always constructs the hardened default.
  const serverPullImporter = injectedServerPullImporter || createServerPullImporter({
    storeAsset: storeServerPulledBlob,
    removeAsset: async (id) => deleteBlob(id),
    ...(serverPullFetchImpl ? { fetchImpl: serverPullFetchImpl } : {}),
    ...(serverPullResolveHost ? { resolveHost: serverPullResolveHost } : {}),
    allowHttpForTests: serverPullAllowHttpForTests,
  });
  const server = createServer(async (req, res) => {
    const path = req.url.split('?')[0].replace(/\/+/g, '/');

  // CORS preflight
    if (req.method === 'OPTIONS') {
      if (path === '/scene-sync/handoff-tokens/upload') {
        res.writeHead(204, HANDOFF_TOKEN_UPLOAD_CORS).end();
      } else if (path === '/scene-sync/handoff-tokens/claim' || path.startsWith('/scene-sync/import-jobs')) {
        // This control plane is same-origin only; do not advertise it through
        // the otherwise public presence API's wildcard CORS policy.
        res.writeHead(204, { 'cache-control': 'no-store' }).end();
      } else if (path.startsWith('/blob/')) {
        setBlobCors(req, res);
        res.writeHead(204).end();
      } else {
        res.writeHead(204, CORS).end();
      }
      return;
    }

  // ── Opener-free Scene Sync handoff tokens ──────────────────────────
  // The token is *only* accepted in the bounded JSON body.  Uploads stage to
  // a private .part file and publish only after JSON + payload validation.
    if (req.method === 'POST' && path === '/scene-sync/handoff-tokens/upload') {
      const actorId = getActorIdFromRequest(req, sceneSyncConfig.actorHashSalt, {
        trustProxy: sceneSyncConfig.trustReverseProxy, includeUserAgent: false,
      });
      const declaredLength = Number(req.headers['content-length'] || 0);
      if (!handoffTokenRateLimiter.allow(actorId)) { sendTokenUploadJson(res, 429, { error: 'handoff-token-rate-limited' }); return; }
      if (Number.isFinite(declaredLength) && declaredLength > sceneSyncConfig.handoffTokenMaxEncodedBytes) {
        sendTokenUploadJson(res, 413, { error: 'handoff-token-body-too-large' }); return;
      }
      if (inFlightTokenUploads >= sceneSyncConfig.handoffTokenMaxActiveUploads) { sendTokenUploadJson(res, 429, { error: 'handoff-token-capacity' }); return; }
      try { handoffTokenStore.reserveRequest(); } catch (error) { sendTokenUploadJson(res, Number(error?.status) || 429, { error: error?.code || 'handoff-token-capacity' }); return; }
      inFlightTokenUploads += 1;
      let requestReserved = true;
      const temporaryPath = `${effectiveHandoffTokenDir}/.upload-${randomUUID()}.part`;
      let output = null;
      let outputClosed = null;
      let earlyToken = null;
      let aborted = false;
      let total = 0;
      const abort = () => {
        aborted = true;
        // An error makes a writer paused on backpressure reject immediately;
        // close remains the final cleanup barrier below.
        try { output?.destroy(new Error('handoff token upload aborted')); } catch {}
        try { req.destroy(); } catch {}
      };
      req.once('aborted', abort);
      res.once('close', abort);
      req.setTimeout(sceneSyncConfig.handoffTokenUploadIdleTimeoutMs, abort);
      const timeout = setTimeout(abort, sceneSyncConfig.handoffTokenUploadMaxDurationMs);
      try {
        mkdirSync(effectiveHandoffTokenDir, { recursive: true });
        output = createWriteStream(temporaryPath, { flags: 'wx' });
        output.on('error', () => {});
        // `createWriteStream()` opens asynchronously. Keep one close promise
        // from creation time so failure cleanup cannot unlink before a delayed
        // open has created an orphan .upload-*.part file.
        outputClosed = new Promise((resolve) => output.once('close', resolve));
        const waitForDrain = () => new Promise((resolve, reject) => {
          const cleanup = () => { output.off('drain', done); output.off('error', failed); output.off('close', closed); };
          const done = () => { cleanup(); resolve(); };
          const failed = (error) => { cleanup(); reject(error); };
          const closed = () => { cleanup(); reject(new Error('handoff token upload stream closed')); };
          output.once('drain', done); output.once('error', failed); output.once('close', closed);
        });
        for await (const raw of req) {
          if (aborted) throw createHttpError(408, 'handoff-token-upload-aborted');
          const chunk = Buffer.from(raw); total += chunk.length;
          if (total > sceneSyncConfig.handoffTokenMaxEncodedBytes) throw createHttpError(413, 'handoff-token-body-too-large');
          if (!output.write(chunk)) await waitForDrain();
        }
        await new Promise((resolve, reject) => { output.once('error', reject); output.end(resolve); });
        if (aborted) throw createHttpError(408, 'handoff-token-upload-aborted');
        // This is the only intentional materialisation: maxEncodedBytes is
        // capped (56 MiB default) before readFileSync/JSON.parse, while the
        // decoded payload validator caps embedded bytes at 32 MiB.
        const raw = readFileSync(temporaryPath);
        let body;
        try { body = JSON.parse(raw.toString('utf8')); } catch { throw createHttpError(400, 'handoff-token-invalid-json'); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 4
          || !Object.hasOwn(body, 'token') || !Object.hasOwn(body, 'sessionId') || !Object.hasOwn(body, 'requestId') || !Object.hasOwn(body, 'payload')
          || !isValidHandoffToken(body.token) || !isValidHandoffId(body.sessionId) || !isValidHandoffId(body.requestId)) {
          throw createHttpError(400, 'handoff-token-invalid-request');
        }
        if (!earlyToken) { handoffTokenStore.begin(body.token, { requestReserved: true }); requestReserved = false; earlyToken = body.token; }
        const validation = validateHandoffTokenPayload(body.payload);
        if (!validation.valid) throw createHttpError(400, 'handoff-token-invalid-payload');
        if (validation.payload.mode === 'url') {
          const origin = String(req.headers.origin || '');
          if (!origin || origin === 'null' || new URL(validation.payload.sourceUrl).origin !== origin) {
            throw createHttpError(403, 'handoff-token-source-origin-mismatch');
          }
        }
        // Do not retain the bearer token in ready staging data. The token has
        // already been converted to a SHA-256 map/file key by the store.
        writeFileSync(temporaryPath, JSON.stringify({ sessionId: body.sessionId, requestId: body.requestId, payload: validation.payload }), 'utf8');
        total = readFileSync(temporaryPath).length;
        renameSync(temporaryPath, handoffTokenStore.paths.partPath(body.token));
        const expiresAt = handoffTokenStore.publish(body.token, total, body);
        sendTokenUploadJson(res, 201, { status: 'ready', expiresAt });
      } catch (error) {
        const code = typeof error?.code === 'string' && /^handoff-token-[a-z0-9-]{1,100}$/u.test(error.code) ? error.code : 'handoff-token-upload-failed';
        if (!res.writableEnded) sendTokenUploadJson(res, Number(error?.status) || 500, { error: code });
        if (earlyToken) handoffTokenStore.cancel(earlyToken);
        try { output?.destroy(); } catch {}
        try { await outputClosed; } catch {}
        try { unlinkSync(temporaryPath); } catch {}
      } finally {
        clearTimeout(timeout); req.off('aborted', abort); res.off('close', abort); if (requestReserved) handoffTokenStore.releaseRequest(); inFlightTokenUploads -= 1;
      }
      return;
    }

    if (req.method === 'POST' && path === '/scene-sync/handoff-tokens/claim') {
      if (!isTokenClaimRequestSameOrigin(req, serverPullAllowedOrigins)) { sendTokenJson(res, 403, { error: 'handoff-token-origin-forbidden' }); return; }
      let body;
      try { body = await readJsonBody(req); } catch { sendTokenJson(res, 400, { error: 'handoff-token-invalid-request' }); return; }
      if (!body || Object.keys(body).length !== 3 || !isValidHandoffToken(body.token)
        || !isValidHandoffId(body.sessionId) || !isValidHandoffId(body.requestId)) { sendTokenJson(res, 400, { error: 'handoff-token-invalid-request' }); return; }
      const actorId = getActorIdFromRequest(req, sceneSyncConfig.actorHashSalt, { trustProxy: sceneSyncConfig.trustReverseProxy, includeUserAgent: false });
      if (!handoffTokenClaimRateLimiter.allow(actorId) || activeTokenClaims >= sceneSyncConfig.handoffTokenMaxActiveClaims) { sendTokenJson(res, 202, { status: 'pending' }); return; }
      activeTokenClaims += 1;
      let claimed;
      try { claimed = await handoffTokenStore.claim(body.token, body); } finally { activeTokenClaims -= 1; }
      // Unknown, expired, malformed, and in-flight uploads intentionally have
      // the same non-sensitive 202 response.
      if (claimed.state !== 'ready') { sendTokenJson(res, 202, { status: 'pending' }); return; }
      sendTokenJson(res, 200, { payload: claimed.payload });
      return;
    }

  // ── Scene Sync server-pull URL handoff ─────────────────────────────
  // This is intentionally a two-step, one-use import job. It is not a proxy:
  // the only successful response is a validated Scene Sync document with
  // materialized local blob URLs.
    if (req.method === 'POST' && path === '/scene-sync/import-jobs') {
      if (!isSameOriginImportRequest(req, serverPullAllowedOrigins)) {
        sendImportJson(res, 403, { error: 'handoff-origin-forbidden' });
        return;
      }
      let input;
      try { input = validateImportJobInput(await readJsonBody(req), { allowHttpForTests: serverPullAllowHttpForTests }); }
      catch (error) { sendImportJson(res, error?.status || 400, { error: error?.code || 'handoff-invalid-import-job' }); return; }
      const actorId = getActorIdFromRequest(req, sceneSyncConfig.actorHashSalt, { trustProxy: sceneSyncConfig.trustReverseProxy, includeUserAgent: false });
      if (!serverPullRateLimiter.allow(actorId)) {
        sendImportJson(res, 429, { error: 'handoff-rate-limited' });
        return;
      }
      if (importJobs.size >= 100) {
        sendImportJson(res, 429, { error: 'handoff-import-job-capacity' });
        return;
      }
      if (activeServerPulls >= 2) {
        sendImportJson(res, 429, { error: 'handoff-server-pull-busy' });
        return;
      }
      const jobId = randomUUID().replace(/-/g, '');
      const token = `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
      activeServerPulls += 1;
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once('aborted', abort);
      res.once('close', abort);
      try {
        const inspection = await serverPullImporter.inspect(input.sourceUrl, { signal: controller.signal });
        // Inspection can itself run for minutes.  Start the one-use job TTL
        // only once its validated metadata is ready to return.
        const expiresAt = Date.now() + 10 * 60 * 1000;
        importJobs.set(jobId, { ...input, token, actorId, expiresAt, digest: inspection.digest });
        // Only metadata leaves the server at inspection time. The target can
        // reject duplicate IDs before a single remote asset byte is fetched.
        sendImportJson(res, 201, { jobId, token, expiresAt, digest: inspection.digest, sessionId: input.sessionId, requestId: input.requestId, sceneDocument: inspection.sceneDocument });
      } catch (error) {
        const status = Number(error?.status) || 400;
        const code = typeof error?.code === 'string' && /^handoff-[a-z0-9-]{1,100}$/u.test(error.code)
          ? error.code : 'handoff-server-pull-failed';
        sendImportJson(res, status, { error: code });
      } finally {
        req.off('aborted', abort);
        res.off('close', abort);
        activeServerPulls -= 1;
      }
      return;
    }

    const materializeMatch = path.match(/^\/scene-sync\/import-jobs\/([a-f0-9]{32})\/materialize$/u);
    if (req.method === 'POST' && materializeMatch) {
      if (!isSameOriginImportRequest(req, serverPullAllowedOrigins)) { sendImportJson(res, 403, { error: 'handoff-origin-forbidden' }); return; }
      let body;
      try { body = await readJsonBody(req); }
      catch (error) { sendImportJson(res, error?.status || 400, { error: 'handoff-invalid-import-job' }); return; }
      const job = importJobs.get(materializeMatch[1]);
      const actorId = getActorIdFromRequest(req, sceneSyncConfig.actorHashSalt, { trustProxy: sceneSyncConfig.trustReverseProxy, includeUserAgent: false });
      // Delete before the remote request: replay cannot turn this endpoint into
      // a repeated fetch primitive, even if the first request times out.
      importJobs.delete(materializeMatch[1]);
      if (!job || job.expiresAt < Date.now() || job.actorId !== actorId || typeof body.token !== 'string' || body.token !== job.token || body.digest !== job.digest
        || body.sessionId !== job.sessionId || body.requestId !== job.requestId) {
        sendImportJson(res, 404, { error: 'handoff-import-job-not-found' });
        return;
      }
      if (activeServerPulls >= 2) {
        sendImportJson(res, 429, { error: 'handoff-server-pull-busy' });
        return;
      }
      activeServerPulls += 1;
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once('aborted', abort);
      res.once('close', abort);
      try {
        const result = await serverPullImporter(job.sourceUrl, { signal: controller.signal, expectedDigest: job.digest });
        const committedAt = Date.now();
        for (const id of result.storedIds) {
          const entry = blobs.get(id);
          if (entry) entry.createdAt = committedAt;
        }
        completedImportJobs.set(materializeMatch[1], {
          token: job.token, actorId, sessionId: job.sessionId, requestId: job.requestId, storedIds: result.storedIds, expiresAt: Date.now() + BLOB_TTL_MS,
        });
        sendImportJson(res, 200, {
          sceneDocument: result.sceneDocument,
          assetCount: result.assetCount,
          totalBytes: result.totalBytes,
          cleanup: { jobId: materializeMatch[1], token: job.token, sessionId: job.sessionId, requestId: job.requestId },
        });
      } catch (error) {
        const status = Number(error?.status) || 400;
        const code = typeof error?.code === 'string' && /^handoff-[a-z0-9-]{1,100}$/u.test(error.code)
          ? error.code : 'handoff-server-pull-failed';
        sendImportJson(res, status, { error: code });
      } finally {
        req.off('aborted', abort);
        res.off('close', abort);
        activeServerPulls -= 1;
      }
      return;
    }

    const cancelMatch = path.match(/^\/scene-sync\/import-jobs\/([a-f0-9]{32})\/cancel$/u);
    if (req.method === 'POST' && cancelMatch) {
      if (!isSameOriginImportRequest(req, serverPullAllowedOrigins)) { sendImportJson(res, 403, { error: 'handoff-origin-forbidden' }); return; }
      let body;
      try { body = await readJsonBody(req); }
      catch (error) { sendImportJson(res, error?.status || 400, { error: 'handoff-invalid-import-job' }); return; }
      const job = importJobs.get(cancelMatch[1]);
      const actorId = getActorIdFromRequest(req, sceneSyncConfig.actorHashSalt, { trustProxy: sceneSyncConfig.trustReverseProxy, includeUserAgent: false });
      importJobs.delete(cancelMatch[1]);
      if (!job || job.actorId !== actorId || job.token !== body.token || body.sessionId !== job.sessionId || body.requestId !== job.requestId) { sendImportJson(res, 404, { error: 'handoff-import-job-not-found' }); return; }
      res.writeHead(204, { 'cache-control': 'no-store' }).end();
      return;
    }

    const cleanupMatch = path.match(/^\/scene-sync\/import-jobs\/([a-f0-9]{32})\/cleanup$/u);
    if (req.method === 'POST' && cleanupMatch) {
      if (!isSameOriginImportRequest(req, serverPullAllowedOrigins)) { sendImportJson(res, 403, { error: 'handoff-origin-forbidden' }); return; }
      let body;
      try { body = await readJsonBody(req); }
      catch (error) { sendImportJson(res, error?.status || 400, { error: 'handoff-invalid-import-job' }); return; }
      const completed = completedImportJobs.get(cleanupMatch[1]);
      const actorId = getActorIdFromRequest(req, sceneSyncConfig.actorHashSalt, { trustProxy: sceneSyncConfig.trustReverseProxy, includeUserAgent: false });
      completedImportJobs.delete(cleanupMatch[1]);
      if (!completed || completed.expiresAt < Date.now() || completed.actorId !== actorId || completed.token !== body.token
        || body.sessionId !== completed.sessionId || body.requestId !== completed.requestId) {
        sendImportJson(res, 404, { error: 'handoff-import-job-not-found' });
        return;
      }
      for (const id of completed.storedIds) deleteBlob(id);
      sendImportJson(res, 204, {});
      return;
    }

  // ── Blob Store ────────────────────────────────────────────
  // POST /blob/:id
    if (req.method === 'POST' && path.startsWith('/blob/')) {
      setBlobCors(req, res);
      const actorId = getActorIdFromRequest(req, sceneSyncConfig.actorHashSalt, { trustProxy: sceneSyncConfig.trustReverseProxy });
      const originalName = decodeURIComponent(path.slice(6));
      const id = originalName.replace(/[^a-z0-9\-]/gi, '').slice(0, 32);
      if (!id) {
        res.writeHead(400, CORS).end('invalid id');
        return;
      }
      if (blobs.has(id)) {
        res.writeHead(409, CORS).end('conflict');
        return;
      }
      if (!uploadRateLimiter.allow(actorId)) {
        sceneSyncLogger.log('rate_limited', { actorId, roomId: sanitizeRoom(getRequestUrl(req).searchParams.get('room')), reason: 'uploads_per_actor_per_minute exceeded' });
        sendJson(res, 429, { error: 'rate_limited', message: '短時間に多くのアップロードが行われました。少し待ってから再度お試しください。' });
        return;
      }

      const chunks = [];
      let totalSize = 0;
      let rejected = false;
      const contentType = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
      sceneSyncLogger.log('upload_received', {
        actorId,
        fileSize: Number(req.headers['content-length'] || 0) || undefined,
        mimeType: contentType,
      });

      req.on('data', chunk => {
        if (rejected) return;
        totalSize += chunk.length;
        if (totalSize > BLOB_MAX_SIZE) {
          rejected = true;
          sceneSyncLogger.log('upload_rejected', { actorId, fileSize: totalSize, mimeType: contentType, reason: 'size limit exceeded' });
          sendJson(res, 413, { error: 'file_too_large', message: 'ファイルサイズが大きすぎます。' });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (res.writableEnded || rejected) return;
        const buffer = Buffer.concat(chunks);
        const uploadValidation = validateUpload({
          size: buffer.length,
          mimeType: contentType,
          filename: originalName,
          buffer,
          maxUploadBytes: sceneSyncConfig.maxUploadBytes,
        });
        if (!uploadValidation.ok) {
          sceneSyncLogger.log('upload_rejected', {
            actorId,
            fileSize: buffer.length,
            mimeType: contentType,
            reason: uploadValidation.reason,
          });
          sendJson(res, uploadValidation.status, { error: uploadValidation.code, message: uploadValidation.message });
          return;
        }

        const entry = {
          size: buffer.length,
          createdAt: Date.now(),
          contentType,
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
            sceneSyncLogger.log('error', { reason: err.message, detail: 'blob_write_error' });
            res.writeHead(500, CORS).end('write error');
            return;
          }
        }

        blobs.set(id, entry);
        log('blob stored', id, entry.size, entry.buffer ? 'memory' : 'disk');

        if (isGlbLike({ filename: originalName, mimeType: contentType })) {
          void glbBackupManager.saveAcceptedGlb({
            buffer,
            roomId: sanitizeRoom(getRequestUrl(req).searchParams.get('room')) || '',
            actorId,
            filename: originalName,
            mimeType: contentType,
            source: 'upload',
            blobId: id,
          });
        }

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
    const actorId = getActorIdFromRequest(req, sceneSyncConfig.actorHashSalt, { trustProxy: sceneSyncConfig.trustReverseProxy });
    const id = path.slice(6).replace(/[^a-z0-9\-]/gi, '').slice(0, 32);
    const entry = blobs.get(id);
    if (!entry) {
      sceneSyncLogger.log('blob_404', { actorId, reason: 'blob not found' });
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
      sceneSyncLogger.log('blob_served', { actorId, fileSize: entry.size, mimeType: entry.contentType });
      res.writeHead(200, {
        'content-type': entry.contentType || 'application/octet-stream',
        'content-length': entry.size,
        'cache-control': 'no-store',
        // Blobs are fetched from third-party static exports.  Keep every
        // delivery non-sniffable (and navigation-sandboxed) even if a future
        // uploader accidentally supplies an active MIME type.
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        ...corsHeaders,
      }).end(entry.buffer);
    } else if (entry.file) {
      sceneSyncLogger.log('blob_served', { actorId, fileSize: entry.size, mimeType: entry.contentType });
      const stream = createReadStream(entry.file);
      res.writeHead(200, {
        'content-type': entry.contentType || 'application/octet-stream',
        'content-length': entry.size,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        ...corsHeaders,
      });
      stream.pipe(res);
      stream.on('error', (err) => {
        log(`[blob] read error ${id}:`, err.message);
        sceneSyncLogger.log('error', { reason: err.message, detail: 'blob_read_error' });
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
    } catch (error) {
      sendJsonBodyError(res, error);
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
    } catch (error) {
      sendJsonBodyError(res, error);
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
    } catch (error) {
      sendJsonBodyError(res, error);
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

  // ── AI Wrapper Endpoints (/api/gpt/* and /api/ai/*) ─────────────────
  const isAiRedeemPath = path === '/api/gpt/link/redeem' || path === '/api/ai/link/redeem';
  if (req.method === 'POST' && isAiRedeemPath) {
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

  const isAiRevokePath = path === '/api/gpt/link/revoke' || path === '/api/ai/link/revoke';
  if (req.method === 'POST' && isAiRevokePath) {
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

  const aiRoomApiMatch = path.match(/^\/api\/(?:gpt|ai)\/room\/([^/]+)\/(scene|broadcast|ai-command)$/);
  if (aiRoomApiMatch && req.method === 'POST') {
    const roomId = sanitizeRoom(aiRoomApiMatch[1]);
    const action = aiRoomApiMatch[2];
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
        sendJson(res, 400, { error: 'use the dedicated /ai-command endpoint for ai-command' });
        return;
      }

      const result = await runRoomBroadcast({
        roomId,
        payload: body.payload,
        onBehalfOfUserId: session.payload.userId,
        sender: createApiSender('AI'),
        actorId: getActorIdFromRequest(req, sceneSyncConfig.actorHashSalt, { trustProxy: sceneSyncConfig.trustReverseProxy }),
      });

      if (result.status >= 400) {
        sceneSyncLogger.log('ai_broadcast_failed', {
          roomId,
          status: result.status,
          error: result.body?.error,
          reason: result.body?.reason,
          kind: body?.payload?.kind,
          opCount: Array.isArray(body?.payload?.ops)
            ? body.payload.ops.length
            : null,
          hasSessionId: typeof body?.sessionId === 'string',
        });
      }

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
        } catch (error) {
          sendJsonBodyError(res, error);
          return;
        }

        // For scene-graph-* messages, don't unwrap payload
        if (payload && typeof payload === 'object' && payload.payload && typeof payload.payload === 'object' && !SCENE_GRAPH_MESSAGE_TYPES.has(payload.type)) {
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
          actorId: getActorIdFromRequest(req, sceneSyncConfig.actorHashSalt, { trustProxy: sceneSyncConfig.trustReverseProxy }),
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

  const openSockets = new Set();
  server.on('connection', socket => {
    openSockets.add(socket);
    socket.on('close', () => {
      openSockets.delete(socket);
    });
  });

  server.on('upgrade', (req, socket) => {
    const url = getRequestUrl(req);
    if (url.pathname !== '/' && url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const roomOverride = sanitizeRoom(url.searchParams.get('room'));
    const isInferredRoom = !roomOverride;
    const roomId = roomOverride || inferRoomFromReq(req) || 'global';
    const actorId = getActorIdFromRequest(req, sceneSyncConfig.actorHashSalt, { trustProxy: sceneSyncConfig.trustReverseProxy });
    const ipHash = getIpHash(req, sceneSyncConfig.ipHashSalt);
    const conn = acceptWebSocket(req, socket);
    if (!conn) return;
    const currentRoom = rooms.get(roomId);

    const shouldEnforceLimit = shouldEnforceRoomConnectionLimit({ roomOverride });
    if (shouldEnforceLimit && (currentRoom?.size || 0) >= sceneSyncConfig.maxRoomConnections) {
      const ipClientCount = getIpClientCount(ipHash);
      sceneSyncLogger.log('ws_room_full_reject', {
        roomId,
        ipHash,
        roomClientCount: currentRoom?.size || 0,
        maxRoomConnections: sceneSyncConfig.maxRoomConnections,
        totalClientCount: getTotalClientCount(),
        ipClientCount
      });
      safeSend(conn, {
        type: 'error',
        error: 'room_full',
        message: 'このルームは現在混み合っています。',
      });
      conn.close();
      return;
    }

    const client = makeClient(conn, roomId, ipHash);
    log('client connected', client.id, 'room', roomId);

    sceneSyncLogger.log('ws_connection_open', {
      roomId,
      clientId: client.id,
      peerId: client.id,
      ipHash,
      roomClientCount: getRoomClientCount(roomId),
      totalClientCount: getTotalClientCount(),
      ipClientCount: getIpClientCount(ipHash),
      roomOverride: Boolean(roomOverride)
    });

    conn.send({ type: 'welcome', id: client.id, room: roomId, serverTime: Date.now() });
    sendRoomSceneClock(client);
    broadcastPeers(roomId);

    conn.onMessage = raw => {
      client.lastSeen = Date.now();
      if (Buffer.byteLength(raw, 'utf8') > sceneSyncConfig.maxJsonBytes) {
        sceneSyncLogger.log('schema_invalid', { roomId, actorId, payloadSize: Buffer.byteLength(raw, 'utf8'), reason: 'ws message too large' });
        safeSend(conn, { type: 'error', error: 'payload_too_large', message: 'ファイルの読み込みに失敗しました。' });
        return;
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        sceneSyncLogger.log('schema_invalid', { roomId, actorId, payloadSize: Buffer.byteLength(raw, 'utf8'), reason: 'invalid json' });
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
            // Validate scene-graph-* messages
            if (SCENE_GRAPH_MESSAGE_TYPES.has(data.payload.type)) {
              const validation = validateSceneGraphMessage(data.payload);
              if (!validation.ok) {
                safeSend(conn, {
                  type: 'error',
                  error: 'invalid scene-graph message',
                  details: validation.error
                });
                return;
              }

              const msgSize = JSON.stringify(data.payload).length;
              if (msgSize > SCENE_GRAPH_MAX_SIZE) {
                safeSend(conn, {
                  type: 'error',
                  error: 'scene-graph message too large'
                });
                return;
              }

              logSceneGraphMessage(data.payload);
            }

            if (!SCENE_GRAPH_MESSAGE_TYPES.has(data.payload.type)) {
              const validation = validateSceneSyncPayload(data.payload);
              if (!validation.ok) {
                sceneSyncLogger.log('schema_invalid', {
                  roomId,
                  actorId,
                  kind: data.payload?.kind,
                  payloadSize: Buffer.byteLength(JSON.stringify(data.payload || {}), 'utf8'),
                  reason: validation.reason,
                });
                safeSend(conn, {
                  type: 'error',
                  error: 'invalid_message',
                  message: 'ファイルの読み込みに失敗しました。',
                });
                return;
              }

              if (data.payload.kind === 'scene-physics-input-log-request') {
                sendRoomPhysicsTimeline(client, data.payload.timelineId);
                return;
              }

              if (data.payload.kind === 'scene-event-log-request') {
                const requestedTimelineId = getRequestedRoomPhysicsTimelineId(data.payload);
                if (requestedTimelineId !== false) {
                  sendRoomPhysicsTimeline(client, requestedTimelineId);
                }
              }

              const objectLimit = applySceneObjectLimits(roomId, data.payload, actorId);
              if (!objectLimit.ok) {
                safeSend(conn, {
                  type: 'error',
                  error: objectLimit.error,
                  message: objectLimit.message,
                });
                return;
              }

              const physicsTimelinePayload = canonicalizeScenePhysicsPayload(roomId, data.payload);
              if (!physicsTimelinePayload.ok) {
                safeSend(conn, {
                  type: 'error',
                  error: physicsTimelinePayload.error || 'physics_timeline_rejected',
                  message: physicsTimelinePayload.message,
                });
                return;
              }
              data.payload = physicsTimelinePayload.payload;
              const sceneClockPayload = canonicalizeSceneClockPayload(roomId, data.payload);
              if (!sceneClockPayload.ok) {
                safeSend(conn, {
                  type: 'error',
                  error: sceneClockPayload.error || 'scene_clock_rejected',
                  message: sceneClockPayload.message,
                });
                return;
              }
              data.payload = sceneClockPayload.payload;
            }

            broadcastHandoff(client, data, {
              includeSender: payloadRequiresScenePhysicsSenderEcho(data.payload),
            });
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
      const durationMs = Date.now() - client.connectedAt;

      const closeLogBase = {
        roomId,
        clientId: client.id,
        peerId: client.id,
        ipHash: client.ipHash,
        durationMs,
        code: 1000,
        reason: 'closed'
      };

      removeClient(client);

      sceneSyncLogger.log('ws_connection_close', {
        ...closeLogBase,
        roomClientCount: getRoomClientCount(roomId),
        totalClientCount: getTotalClientCount(),
        ipClientCount: getIpClientCount(client.ipHash)
      });

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

  const importJobCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, job] of importJobs) {
      if (job.expiresAt <= now) importJobs.delete(id);
    }
    for (const [id, job] of completedImportJobs) {
      if (job.expiresAt <= now) completedImportJobs.delete(id);
    }
  }, BLOB_CLEANUP_INTERVAL);

  const handoffTokenCleanupInterval = setInterval(() => {
    handoffTokenStore.sweep();
    handoffTokenStore.sweepOrphanUploads(sceneSyncConfig.handoffTokenUploadMaxDurationMs);
  }, BLOB_CLEANUP_INTERVAL);

  let connectionSummaryInterval = null;
  if (sceneSyncConfig.connectionSummaryIntervalMs > 0) {
    connectionSummaryInterval = setInterval(() => {
      sceneSyncLogger.log('ws_connection_summary', {
        roomCount: rooms.size,
        totalClientCount: getTotalClientCount(),
        topRooms: getTopRooms(5),
        topIpHashes: getTopIpHashes(5)
      });
    }, sceneSyncConfig.connectionSummaryIntervalMs);
  }

  const heartbeatInterval = setInterval(() => {
    rooms.forEach(room => {
      room.forEach(client => {
        if (!client.conn.alive) {
          const durationMs = Date.now() - client.connectedAt;
          sceneSyncLogger.log('ws_heartbeat_terminate', {
            roomId: client.roomId,
            clientId: client.id,
            peerId: client.id,
            ipHash: client.ipHash,
            durationMs
          });
          client.conn.close();
          return;
        }
        client.conn.alive = false;
        client.conn.ping();
      });
    });
  }, HEARTBEAT_MS);

  let cleanupComplete = false;
  const cleanupServerState = () => {
    if (cleanupComplete) return;
    cleanupComplete = true;
    clearInterval(blobCleanupInterval);
    clearInterval(importJobCleanupInterval);
    clearInterval(handoffTokenCleanupInterval);
    clearInterval(heartbeatInterval);
    if (connectionSummaryInterval) clearInterval(connectionSummaryInterval);
    rooms.clear();
    roomObjectIds.clear();
    roomPhysicsTimelines.clear();
    clientsByIpHash.clear();
    importJobs.clear();
    completedImportJobs.clear();
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
  };

  server.on('close', cleanupServerState);

  server.stop = () => {
    rooms.forEach(room => {
      room.forEach(client => client.conn.terminate());
    });
    openSockets.forEach(socket => {
      try {
        socket.destroy();
      } catch {}
    });
    cleanupServerState();
    return new Promise(resolve => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      server.close(finish);
      server.unref?.();
      server.closeAllConnections?.();
      setTimeout(finish, 100);
    });
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
  if (entry.serverPullBytes) serverPullLiveBytes = Math.max(0, serverPullLiveBytes - entry.serverPullBytes);
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
