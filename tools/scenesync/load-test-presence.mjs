#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const presenceServerPath = resolve(__dirname, '../../apps/presence-server');

const require = createRequire(import.meta.url);
const WebSocket = require(resolve(presenceServerPath, 'node_modules/ws'));

const GENERIC_ROOM_NAMES = new Set([
  'test',
  'demo',
  'room',
  'default',
  'safe-test',
  'load-test',
  'mcp-test',
  'tmp',
  'temp',
  'test-room',
  'demo-room',
  'default-room',
]);

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    url: null,
    room: null,
    clients: 20,
    duration: 60,
    'ramp-ms': 100,
    'send-interval': 5000,
    broadcast: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];

      if (key === 'broadcast' || key === 'verbose') {
        options[key] = true;
      } else if (nextArg && !nextArg.startsWith('--')) {
        const value = nextArg;
        if (key === 'clients' || key === 'duration' || key === 'ramp-ms' || key === 'send-interval') {
          options[key] = parseInt(value, 10);
        } else {
          options[key] = value;
        }
        i++;
      }
    }
  }

  return options;
}

function generateRoomName() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const timestamp = `${year}${month}${day}-${hours}${minutes}${seconds}`;

  let random = '';
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 6; i++) {
    random += chars[Math.floor(Math.random() * chars.length)];
  }

  return `load-${timestamp}-${random}`;
}

function isGenericRoom(room) {
  return GENERIC_ROOM_NAMES.has(room.toLowerCase());
}

class LoadTestClient {
  constructor(id, url, room) {
    this.id = id;
    this.url = url;
    this.room = room;
    this.ws = null;
    this.connected = false;
    this.connectStartTime = null;
    this.connectLatency = 0;
    this.messageCount = 0;
    this.closeCode = null;
    this.closeReason = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.connectStartTime = performance.now();
      const wsUrl = `${this.url}?room=${this.room}`;

      try {
        this.ws = new WebSocket(wsUrl);

        const timeoutId = setTimeout(() => {
          this.ws.terminate();
          reject(new Error(`Connection timeout for client ${this.id}`));
        }, 10000);

        this.ws.on('open', () => {
          clearTimeout(timeoutId);
          this.connectLatency = Math.round(performance.now() - this.connectStartTime);
          this.connected = true;

          this.ws.send(JSON.stringify({
            type: 'hello',
            nickname: `LoadTest-${this.id}`,
            device: 'LoadTest',
          }));
        });

        this.ws.on('message', (data) => {
          const message = JSON.parse(data.toString());
          if (message.type === 'welcome') {
            resolve();
          } else {
            this.messageCount++;
          }
        });

        this.ws.on('close', (code, reason) => {
          this.closeCode = code;
          this.closeReason = reason;
          this.connected = false;
          if (!this.connected || this.connectLatency === 0) {
            reject(new Error(`Connection closed for client ${this.id}: ${code} ${reason}`));
          }
        });

        this.ws.on('error', (err) => {
          clearTimeout(timeoutId);
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
      } catch (err) {
        // Ignore send errors
      }
    }
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore
      }
    }
  }
}

async function runLoadTest() {
  const options = parseArgs();

  if (!options.url) {
    console.error('Error: --url is required');
    console.error('Usage: node load-test-presence.mjs --url <ws-url> [options]');
    process.exit(1);
  }

  // Generate or validate room name
  let room = options.room;
  if (!room) {
    room = generateRoomName();
    console.log(`Generated room: ${room}`);
  } else if (isGenericRoom(room)) {
    console.warn(`Warning: room name "${room}" is generic and may collide with real users.`);
    console.warn('Use a unique room name for release/load testing.');
  }

  const browserUrl = options.url.replace(/\/+$/, '').replace(/^wss?:\/\//, 'https://');
  console.log(`Browser URL:\n${browserUrl}/scenesync/?room=${room}\n`);

  console.log('Scene Sync presence load test\n');
  console.log(`endpoint: ${options.url}`);
  console.log(`room: ${room}`);
  console.log(`clients requested: ${options.clients}`);

  const clients = [];
  let connectFailures = 0;
  let roomFullRejections = 0;
  const connectLatencies = [];

  // Ramp up clients
  const rampInterval = options['ramp-ms'] || 100;
  for (let i = 0; i < options.clients; i++) {
    const client = new LoadTestClient(i, options.url, room);

    try {
      await client.connect();
      clients.push(client);
      connectLatencies.push(client.connectLatency);

      if (options.verbose) {
        console.log(`  Client ${i} connected (${client.connectLatency}ms)`);
      }
    } catch (err) {
      const errMsg = err.message || '';
      if (errMsg.includes('room_full') || errMsg.includes('1008')) {
        roomFullRejections++;
      } else {
        connectFailures++;
      }

      if (options.verbose) {
        console.log(`  Client ${i} failed: ${err.message}`);
      }
    }

    // Wait before connecting next client
    if (i < options.clients - 1) {
      await new Promise(resolve => setTimeout(resolve, rampInterval));
    }
  }

  const connectedCount = clients.length;
  console.log(`clients connected: ${connectedCount}`);
  console.log(`connect failures: ${connectFailures}`);
  if (roomFullRejections > 0) {
    console.log(`room_full rejections: ${roomFullRejections}`);
  }

  // Broadcast test if enabled
  let broadcastObjectId = null;
  if (options.broadcast && connectedCount > 0) {
    broadcastObjectId = `load-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const broadcastInterval = setInterval(() => {
      clients.forEach((client) => {
        if (client.connected) {
          client.send({
            kind: 'scene-add',
            objectId: broadcastObjectId,
            name: 'Load Test Object',
            position: [0, 0.5, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
            asset: {
              type: 'primitive',
              primitive: 'sphere',
              color: '#ff00ff',
            },
          });
        }
      });
    }, options['send-interval'] || 5000);

    setTimeout(() => clearInterval(broadcastInterval), options.duration * 1000);
  }

  // Keep connections alive
  const startTime = performance.now();
  const durationMs = options.duration * 1000;

  await new Promise(resolve => setTimeout(resolve, durationMs));

  // Track unexpected closes
  const closeLatency = performance.now() - startTime;
  let unexpectedCloses = 0;
  clients.forEach((client) => {
    if (!client.connected && client.closeCode !== 1000 && client.closeCode !== 1001) {
      unexpectedCloses++;
    }
  });

  // Clean up broadcast object if used
  if (broadcastObjectId && connectedCount > 0) {
    clients.forEach((client) => {
      if (client.connected) {
        client.send({
          kind: 'scene-remove',
          objectId: broadcastObjectId,
        });
      }
    });
  }

  // Close all connections
  clients.forEach(client => client.close());

  // Wait for closes
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Calculate statistics
  const totalMessages = clients.reduce((sum, c) => sum + c.messageCount, 0);
  const avgMessages = connectedCount > 0 ? Math.round(totalMessages / connectedCount) : 0;
  const avgLatency = connectLatencies.length > 0
    ? Math.round(connectLatencies.reduce((a, b) => a + b, 0) / connectLatencies.length)
    : 0;
  const maxLatency = connectLatencies.length > 0 ? Math.max(...connectLatencies) : 0;

  // Print summary
  console.log(`unexpected closes: ${unexpectedCloses}`);
  console.log(`messages received total: ${totalMessages}`);
  if (connectedCount > 0) {
    console.log(`average messages/client: ${avgMessages}`);
    console.log(`connect latency avg: ${avgLatency}ms`);
    console.log(`connect latency max: ${maxLatency}ms`);
  }
  console.log(`duration: ${options.duration}s\n`);

  // Determine result
  let result = 'OK';
  let hasFailure = false;

  if (connectedCount < options.clients) {
    result = 'FAIL';
    hasFailure = true;
  }
  if (connectFailures > 0) {
    result = 'FAIL';
    hasFailure = true;
  }
  if (roomFullRejections > 0 && !options.broadcast) {
    result = 'FAIL';
    hasFailure = true;
  }
  if (unexpectedCloses > 0) {
    result = 'WARN';
  }

  console.log(`Result: ${result}`);

  process.exit(hasFailure ? 1 : 0);
}

runLoadTest().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
