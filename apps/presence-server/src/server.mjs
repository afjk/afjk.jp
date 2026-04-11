import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const PORT = Number(process.env.PORT || 8787);
const HEARTBEAT_MS = 30000;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const STATS_FILE = process.env.STATS_FILE || '/data/stats.json';

const rooms = new Map(); // roomId -> Map<clientId, Client>

// ── Stats persistence ─────────────────────────────────────────────────────────
const STATS_LOG_LIMIT = Number(process.env.STATS_LOG_LIMIT || 500);
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

function saveStats(data) {
  try {
    mkdirSync(STATS_FILE.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(STATS_FILE, JSON.stringify(data), 'utf8');
  } catch (err) {
    log('stats write error', err.message);
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

class WsConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.alive = true;
    socket.on('data', chunk => this.#handle(chunk));
    socket.on('close', () => this.onClose && this.onClose());
    socket.on('error', () => this.onClose && this.onClose());
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

  #handle(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
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

      const mask = isMasked ? this.buffer.slice(offset, offset + 4) : null;
      offset += isMasked ? 4 : 0;
      if (this.buffer.length < offset + length) return;

      let payload = this.buffer.slice(offset, offset + length);
      this.buffer = this.buffer.slice(offset + length);

      if (mask) payload = applyMask(payload, mask);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        // ping -> respond with pong
        this.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        continue;
      }
      if (opcode === 0xa) {
        this.alive = true;
        continue;
      }
      if (opcode !== 0x1) continue; // text frames only

      this.alive = true;
      const text = payload.toString('utf8');
      this.onMessage && this.onMessage(text);
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
    nickname: '',
    device: '',
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
    .map(p => ({
      id: p.id,
      nickname: p.nickname,
      device: p.device,
      lastSeen: p.lastSeen
    }));
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

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

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

const server = createServer((req, res) => {
  const path = req.url.split('?')[0].replace(/\/+/g, '/');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }

  // GET /stats
  if (req.method === 'GET' && path === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json', ...CORS })
       .end(JSON.stringify(stats));
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

  res.writeHead(200, { 'content-type': 'text/plain' }).end('presence ok');
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
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
    switch (data.type) {
      case 'hello':
        client.nickname = sanitizeName(data.nickname);
        client.device = sanitizeDevice(data.device);
        broadcastPeers(roomId);
        break;
      case 'handoff':
        if (data.targetId && data.payload) {
          deliverHandoff(client, data);
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

setInterval(() => {
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

server.listen(PORT, () => {
  log(`presence server listening on ${PORT}`);
});
