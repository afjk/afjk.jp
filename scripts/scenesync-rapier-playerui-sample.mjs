import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createPresenceServer } from '../apps/presence-server/src/server.mjs';
import { initRapierPhysics } from '../html/assets/js/scenesync/physics/rapier-world.js';
import {
  createScenePhysicsRuntime,
  normalizeScenePhysics,
} from '../html/assets/js/scenesync/scene-physics.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const htmlRoot = path.join(repoRoot, 'html');
const require = createRequire(import.meta.url);
const WebSocket = require(path.join(repoRoot, 'apps/presence-server/node_modules/ws'));

process.env.GPT_SESSION_SECRET ||= 'scene-sync-rapier-playerui-sample-secret';

const DEFAULT_FIXTURE = path.join(repoRoot, 'fixtures/rapier/parity-basic-001.json');
const DEFAULT_TICKS = [0, 30, 60];
const DEFAULT_ROOT_NAME = '__SceneSyncRapierPlayerUiSample';
const TEST_TIMEOUT_MS = 90000;

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.hdr', 'application/octet-stream'],
  ['.glb', 'model/gltf-binary'],
  ['.wasm', 'application/wasm'],
]);

function parseArgs(argv) {
  const options = {
    fixturePath: DEFAULT_FIXTURE,
    roomId: `rapier-sample-${Date.now().toString(36)}`,
    withUnity: false,
    verify: false,
    hold: true,
    uloopBin: process.env.ULOOP_BIN || 'uloop',
    unityProject: process.env.SCENESYNC_UNITY_PROJECT || path.resolve(repoRoot, '..', 'SceneSyncClient'),
    rootName: DEFAULT_ROOT_NAME,
    rebroadcastMs: 0,
    ticks: DEFAULT_TICKS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--unity') {
      options.withUnity = true;
    } else if (arg === '--no-unity') {
      options.withUnity = false;
    } else if (arg === '--verify') {
      options.verify = true;
      options.withUnity = true;
      options.hold = false;
    } else if (arg === '--no-hold') {
      options.hold = false;
    } else if (arg === '--hold') {
      options.hold = true;
    } else if (arg === '--room') {
      options.roomId = argv[++i] || options.roomId;
    } else if (arg.startsWith('--room=')) {
      options.roomId = arg.slice('--room='.length) || options.roomId;
    } else if (arg === '--fixture') {
      options.fixturePath = path.resolve(argv[++i] || options.fixturePath);
    } else if (arg.startsWith('--fixture=')) {
      options.fixturePath = path.resolve(arg.slice('--fixture='.length) || options.fixturePath);
    } else if (arg === '--unity-project') {
      options.unityProject = path.resolve(argv[++i] || options.unityProject);
    } else if (arg.startsWith('--unity-project=')) {
      options.unityProject = path.resolve(arg.slice('--unity-project='.length) || options.unityProject);
    } else if (arg === '--uloop-bin') {
      options.uloopBin = argv[++i] || options.uloopBin;
    } else if (arg.startsWith('--uloop-bin=')) {
      options.uloopBin = arg.slice('--uloop-bin='.length) || options.uloopBin;
    } else if (arg === '--ticks') {
      options.ticks = parseTicks(argv[++i], options.ticks);
    } else if (arg.startsWith('--ticks=')) {
      options.ticks = parseTicks(arg.slice('--ticks='.length), options.ticks);
    } else if (arg === '--rebroadcast-ms') {
      options.rebroadcastMs = Math.max(0, Number(argv[++i]) || options.rebroadcastMs);
    } else if (arg.startsWith('--rebroadcast-ms=')) {
      options.rebroadcastMs = Math.max(0, Number(arg.slice('--rebroadcast-ms='.length)) || options.rebroadcastMs);
    }
  }

  return options;
}

function parseTicks(value, fallback) {
  const ticks = String(value || '')
    .split(',')
    .map((tick) => Number(tick.trim()))
    .filter((tick) => Number.isInteger(tick) && tick >= 0);
  return ticks.length ? Array.from(new Set(ticks)).sort((left, right) => left - right) : fallback;
}

function sendBuffer(res, status, body, headers = {}) {
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,OPTIONS,HEAD',
    'access-control-allow-headers': 'content-type',
    'content-length': body.byteLength,
    ...headers,
  });
  res.end(body);
}

function resolveStaticPath(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, 'http://localhost').pathname);
  } catch {
    return null;
  }

  if (pathname.endsWith('/')) pathname = `${pathname}index.html`;

  const candidate = path.resolve(htmlRoot, `.${pathname}`);
  if (!candidate.startsWith(`${htmlRoot}${path.sep}`) && candidate !== htmlRoot) return null;
  return candidate;
}

function createStaticServer() {
  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      sendBuffer(res, 204, Buffer.alloc(0));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendBuffer(res, 405, Buffer.from('Method not allowed'), {
        'content-type': 'text/plain; charset=utf-8',
      });
      return;
    }

    const filePath = resolveStaticPath(req.url || '/');
    if (!filePath) {
      sendBuffer(res, 400, Buffer.from('Bad request'), {
        'content-type': 'text/plain; charset=utf-8',
      });
      return;
    }

    try {
      const body = await readFile(filePath);
      const contentType = mimeTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
      sendBuffer(res, 200, req.method === 'HEAD' ? Buffer.alloc(0) : body, {
        'content-type': contentType,
        ...(req.method === 'HEAD' ? { 'content-length': body.byteLength } : {}),
      });
    } catch {
      sendBuffer(res, 404, Buffer.from('Not found'), {
        'content-type': 'text/plain; charset=utf-8',
      });
    }
  });

  return listenServer(server);
}

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function serverUrl(server, scheme = 'http') {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server did not expose a TCP address');
  }
  return `${scheme}://127.0.0.1:${address.port}`;
}

function waitForEvent(target, event, timeoutMs = TEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      target.off(event, onEvent);
      target.off('error', onError);
    };
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    target.once(event, onEvent);
    if (event !== 'error') target.once('error', onError);
  });
}

function waitForMessage(ws, predicate, { timeoutMs = TEST_TIMEOUT_MS, label = 'websocket message' } = {}) {
  const seen = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${label}; recent messages: ${JSON.stringify(seen.slice(-8))}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`websocket closed while waiting for ${label}`));
    };
    const onMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      seen.push({
        type: message.type || null,
        kind: message.payload?.kind || null,
        tick: message.payload?.tick ?? null,
        hash: message.payload?.hash || null,
        from: message.from?.nickname || message.from?.id || null,
      });
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    ws.on('message', onMessage);
    ws.once('error', onError);
    ws.once('close', onClose);
  });
}

async function connectPresenceClient(wsBaseUrl, roomId, nickname) {
  const ws = new WebSocket(`${wsBaseUrl}?room=${encodeURIComponent(roomId)}`);
  const welcomePromise = waitForMessage(ws, message => message.type === 'welcome', {
    label: `${nickname} welcome`,
  });
  await waitForEvent(ws, 'open');
  ws.send(JSON.stringify({
    type: 'hello',
    nickname,
    device: 'SceneSync Rapier Sample',
    userId: `${nickname.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`,
  }));
  const welcome = await welcomePromise;
  ws.presenceId = welcome.id;
  return ws;
}

function closeWebSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  const closed = waitForEvent(ws, 'close', 5000).catch(() => {});
  ws.terminate();
  return closed;
}

function closeHttpServer(server) {
  if (!server) return Promise.resolve();
  server.closeIdleConnections?.();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 3000);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopPresenceServer(server) {
  if (!server) return;
  await Promise.race([
    server.stop(),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);
}

function vector3(value, fallback = [0, 0, 0]) {
  return Array.isArray(value) && value.length >= 3
    ? [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0]
    : [...fallback];
}

function quat(value, fallback = [0, 0, 0, 1]) {
  return Array.isArray(value) && value.length >= 4
    ? [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0, Number(value[3]) || 0]
    : [...fallback];
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function fixtureBodyToSceneObject(body) {
  const halfExtents = vector3(body.halfExtents, [0.5, 0.5, 0.5]);
  const position = vector3(body.position, [0, 0, 0]);
  const rotation = quat(body.rotation, [0, 0, 0, 1]);
  const scale = halfExtents.map(component => component * 2);
  const isStatic = body.type === 'fixed' || body.type === 'static' || body.static === true || Number(body.density) === 0;
  const physics = {
    version: 1,
    enabled: true,
    bodyType: isStatic ? 'static' : 'dynamic',
    shape: body.shape === 'sphere' ? 'sphere' : 'box',
    halfExtents,
    density: isStatic ? 0 : finite(body.density, finite(body.mass, 1)),
    friction: finite(body.friction, 0.5),
    restitution: finite(body.restitution, 0.2),
    initialTransform: { position, rotation, scale },
  };

  if (!isStatic) {
    physics.velocity = vector3(body.linearVelocity || body.velocity, [0, 0, 0]);
    physics.angularVelocity = vector3(body.angularVelocity, [0, 0, 0]);
    physics.linearDamping = finite(body.linearDamping, 0);
    physics.angularDamping = finite(body.angularDamping, 0);
    physics.canSleep = body.canSleep !== false;
    physics.ccd = body.ccd === true;
  }

  return {
    name: body.id === 'floor' ? 'Rapier Sample Floor' : 'Rapier Sample Box',
    asset: {
      type: 'primitive',
      primitive: physics.shape,
      color: body.id === 'floor' ? '#6b7479' : '#296bdc',
    },
    position,
    rotation,
    scale,
    physics,
  };
}

function createSceneStateFromFixture(fixture) {
  const objects = {};
  for (const body of fixture.bodies || []) {
    if (!body?.id) continue;
    objects[body.id] = fixtureBodyToSceneObject(body);
  }

  return {
    kind: 'scene-state',
    envId: 'studio',
    physics: {
      version: 1,
      enabled: true,
      duration: 10,
      worldOptions: {
        gravity: vector3(fixture.gravity, [0, -9.81, 0]),
        ground: null,
        timestep: finite(fixture.timestep, 1 / 60),
      },
    },
    objects,
  };
}

function createSceneClockPayload({ controllerId, revision, startRoomNow, includeReset = false }) {
  const nowMs = Date.now();
  const roomNow = nowMs / 1000;
  const payload = {
    kind: 'scene-clock',
    action: includeReset ? 'mode' : 'sync',
    mode: 'shared-playback',
    source: 'room',
    offset: -startRoomNow,
    paused: false,
    rate: 1,
    controller: {
      id: controllerId,
      nickname: 'Rapier Sample Loader',
    },
    revision,
    roomNow,
    sentAt: nowMs,
  };

  if (includeReset) {
    payload.physicsBaseline = {
      kind: 'reset',
      time: 0,
      worldEpochTime: 0,
      preserveMotion: false,
      reason: 'rapier-playerui-sample',
    };
  }

  return payload;
}

async function loadFixture(fixturePath) {
  return JSON.parse(await readFile(fixturePath, 'utf8'));
}

function vectorValue(values) {
  return {
    values: [...values],
    toArray() {
      return [...this.values];
    },
    fromArray(next) {
      this.values = [...next];
    },
  };
}

function createRuntimeObject(objectId, entry) {
  return {
    userData: {
      objectId,
      physics: entry.physics,
      asset: entry.asset,
    },
    position: vectorValue(vector3(entry.position, [0, 0, 0])),
    scale: vectorValue(vector3(entry.scale, [1, 1, 1])),
    quaternion: {
      values: quat(entry.rotation, [0, 0, 0, 1]),
      toArray() {
        return [...this.values];
      },
      fromArray(next) {
        this.values = [...next];
      },
    },
    updateMatrixWorld() {},
  };
}

async function createExpectedHashes(sceneState, ticks) {
  await initRapierPhysics();
  const scenePhysics = normalizeScenePhysics(sceneState.physics);
  const entries = Object.entries(sceneState.objects || {})
    .map(([objectId, entry]) => ({
      objectId,
      object: createRuntimeObject(objectId, entry),
      physics: entry.physics,
    }));
  const runtime = createScenePhysicsRuntime({
    getScenePhysics: () => scenePhysics,
    getObjectEntries: () => entries,
    isClockActive: () => true,
  });
  const hashes = {};
  for (const tick of ticks) {
    const timestep = scenePhysics.worldOptions.timestep || 1 / 60;
    const time = tick === 0 ? 0 : tick * timestep + 1e-6;
    const result = runtime.update({
      t: time,
      mode: 'shared-playback',
      active: true,
      transportActive: true,
    });
    if (result.tick !== tick) {
      throw new Error(`SceneSync runtime reached tick ${result.tick}, expected ${tick}.`);
    }
    hashes[String(tick)] = result.hash;
  }
  return hashes;
}

function csharpString(value) {
  return `System.Text.Encoding.UTF8.GetString(System.Convert.FromBase64String("${Buffer.from(value).toString('base64')}"))`;
}

async function execFileWithTimeout(file, args, options = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await execFileAsync(file, args, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      throw new Error(`timed out after ${timeoutMs}ms: ${file} ${args.join(' ')}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function executeUnityCode(options, code) {
  const { stdout, stderr } = await execFileWithTimeout(
    options.uloopBin,
    ['--project-path', options.unityProject, 'execute-dynamic-code', '--code', code],
    { maxBuffer: 1024 * 1024 * 8 },
    45000,
  );
  const output = `${stdout || ''}${stderr || ''}`.trim();
  if (output) {
    let parsed = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // Keep raw output for error reporting below.
    }
    if (parsed && parsed.success === false) throw new Error(output);
  }
  return output;
}

async function controlPlayMode(options, action) {
  await execFileWithTimeout(
    options.uloopBin,
    ['--project-path', options.unityProject, 'control-play-mode', '--action', action, '--timeout-seconds', '60'],
    { maxBuffer: 1024 * 1024 * 4 },
    75000,
  );
}

function createUnitySetupCode({ rootName, presenceUrl, roomId }) {
  return `
using UnityEngine;
using Afjk.SceneSync.Rapier;

void DestroyIfFound(string name)
{
    var target = GameObject.Find(name);
    if (target != null) UnityEngine.Object.DestroyImmediate(target);
}

var rootName = ${csharpString(rootName)};
DestroyIfFound(rootName);
DestroyIfFound("__SceneSyncImportDebug");
DestroyIfFound("__SceneSyncBootstrapDebug");

var root = new GameObject(rootName);
var sample = root.AddComponent<SceneSyncRapierParitySampleBootstrap>();
sample.PresenceUrl = ${csharpString(presenceUrl)};
sample.Room = ${csharpString(roomId)};
sample.Nickname = "Unity Rapier Sample";
sample.AutoConnect = true;
sample.RequireSceneClock = true;
sample.BuildOnStart = true;
Debug.Log("ok:scenesync-rapier-playerui-sample-configured:" + rootName);
`;
}

async function setupUnitySample(options, presenceUrl, roomId) {
  await controlPlayMode(options, 'Stop').catch(() => {});
  await executeUnityCode(options, createUnitySetupCode({
    rootName: options.rootName,
    presenceUrl,
    roomId,
  }));
  await controlPlayMode(options, 'Play');
}

async function cleanupUnitySample(options) {
  await controlPlayMode(options, 'Stop').catch((error) => {
    console.warn(`[unity-cleanup] ${error.message}`);
  });
  await executeUnityCode(options, `
using UnityEngine;
void DestroyIfFound(string name)
{
    var target = GameObject.Find(name);
    if (target != null) UnityEngine.Object.DestroyImmediate(target);
}
DestroyIfFound(${csharpString(options.rootName)});
DestroyIfFound("__SceneSyncImportDebug");
DestroyIfFound("__SceneSyncBootstrapDebug");
Debug.Log("ok:scenesync-rapier-playerui-sample-cleanup");
`).catch((error) => {
    console.warn(`[unity-cleanup] ${error.message}`);
  });
}

function sendBroadcast(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'broadcast', payload }));
}

function sendHandoff(ws, targetId, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !targetId) return;
  ws.send(JSON.stringify({ type: 'handoff', targetId, payload }));
}

function installLoaderHandlers(ws, sceneState, expectedHashes) {
  let revision = 0;
  let sentResetClock = false;
  let startRoomNow = Date.now() / 1000;
  const hashTable = new Map();
  const observedPhysicsHashes = [];
  const physicsHashWaiters = new Set();
  const publishScene = () => sendBroadcast(ws, sceneState);
  const publishClock = (targetId = null, { reset = false } = {}) => {
    revision += 1;
    const includeReset = reset || !sentResetClock;
    if (includeReset) {
      startRoomNow = Date.now() / 1000;
      sentResetClock = true;
    }
    const payload = createSceneClockPayload({
      controllerId: ws.presenceId,
      revision,
      startRoomNow,
      includeReset,
    });
    if (targetId) sendHandoff(ws, targetId, payload);
    else sendBroadcast(ws, payload);
  };

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type !== 'handoff' || !message.payload) return;
    const payload = message.payload;
    if (payload.kind === 'scene-request') {
      if (message.from?.nickname !== 'Unity Rapier Sample') {
        sendHandoff(ws, message.from?.id, sceneState);
      }
      publishClock(message.from?.id, { reset: !sentResetClock });
      return;
    }

    if (payload.kind !== 'scene-physics-hash') return;
    const peer = message.from?.nickname || message.from?.id || 'unknown';
    const tick = payload.tick;
    const hash = payload.hash;
    if (!Number.isInteger(tick) || typeof hash !== 'string') return;

    const expected = expectedHashes[String(tick)];
    const record = { message, peer, tick, hash };
    observedPhysicsHashes.push(record);
    while (observedPhysicsHashes.length > 32) observedPhysicsHashes.shift();

    for (const waiter of Array.from(physicsHashWaiters)) {
      if (!waiter.predicate(record)) continue;
      physicsHashWaiters.delete(waiter);
      waiter.resolve(record);
    }

    const key = `${tick}:${hash}`;
    if (!hashTable.has(key)) hashTable.set(key, new Set());
    hashTable.get(key).add(peer);
    const peers = Array.from(hashTable.get(key)).sort();
    const status = expected ? (expected === hash ? 'MATCH' : `MISMATCH expected=${expected}`) : 'OBSERVED';
    console.log(`[physics-hash] tick=${tick} hash=${hash} peers=${peers.join(',')} ${status}`);
  });

  const waitForPhysicsHash = ({ peer, tick, timeoutMs = TEST_TIMEOUT_MS }) => {
    const predicate = record => (
      record.tick === tick
      && (!peer || record.peer === peer)
    );
    const existing = observedPhysicsHashes.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (record) => {
          clearTimeout(timer);
          resolve(record);
        },
      };
      const timer = setTimeout(() => {
        physicsHashWaiters.delete(waiter);
        reject(new Error(`timed out waiting for physics hash tick ${tick}; recent hashes: ${JSON.stringify(observedPhysicsHashes.slice(-8).map(record => ({
          tick: record.tick,
          hash: record.hash,
          peer: record.peer,
        })))}`));
      }, timeoutMs);
      physicsHashWaiters.add(waiter);
    });
  };

  return { publishScene, publishClock, waitForPhysicsHash };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const fixture = await loadFixture(options.fixturePath);
  const sceneState = createSceneStateFromFixture(fixture);
  const expectedHashes = await createExpectedHashes(sceneState, options.ticks);

  const presenceServer = createPresenceServer();
  await listenServer(presenceServer);
  const staticServer = await createStaticServer();
  const wsBaseUrl = `${serverUrl(presenceServer, 'ws')}/ws`;
  const playerUrl = `${serverUrl(staticServer)}/scenesync/?room=${encodeURIComponent(options.roomId)}&presence=${encodeURIComponent(wsBaseUrl)}&dev=1`;
  const loaderWs = await connectPresenceClient(wsBaseUrl, options.roomId, 'Rapier Sample Loader');
  const loader = installLoaderHandlers(loaderWs, sceneState, expectedHashes);
  const targetTick = Math.max(...options.ticks);
  const unityHashPromise = options.verify
    ? loader.waitForPhysicsHash({ peer: 'Unity Rapier Sample', tick: targetTick })
    : null;
  let rebroadcastTimer = null;
  let unityStarted = false;

  const cleanup = async () => {
    if (rebroadcastTimer) clearInterval(rebroadcastTimer);
    if (unityStarted) await cleanupUnitySample(options);
    await closeWebSocket(loaderWs);
    await closeHttpServer(staticServer);
    await stopPresenceServer(presenceServer);
  };

  try {
    console.log(JSON.stringify({
      roomId: options.roomId,
      playerUrl,
      presenceUrl: wsBaseUrl,
      fixture: path.relative(repoRoot, options.fixturePath),
      expectedHashes,
      unity: options.withUnity ? options.unityProject : null,
    }, null, 2));

    if (options.withUnity) {
      await setupUnitySample(options, wsBaseUrl, options.roomId);
      unityStarted = true;
      await waitForMessage(loaderWs, message => (
        (message.type === 'peers'
          && Array.isArray(message.peers)
          && message.peers.some(peer => peer.nickname === 'Unity Rapier Sample'))
        || message.from?.nickname === 'Unity Rapier Sample'
      ), { label: 'Unity Rapier Sample peer or message' });
    }

    if (!options.withUnity) {
      loader.publishScene();
    }
    loader.publishClock();
    if (options.rebroadcastMs > 0 && options.hold) {
      rebroadcastTimer = setInterval(() => {
        loader.publishScene();
        loader.publishClock();
      }, options.rebroadcastMs);
    }

    if (options.verify) {
      const record = await unityHashPromise;
      assert.equal(record.hash, expectedHashes[String(targetTick)]);
      console.log(JSON.stringify({
        ok: true,
        verified: 'unity-web-rapier-parity',
        roomId: options.roomId,
        tick: targetTick,
        hash: record.hash,
      }, null, 2));
      return;
    }

    if (options.hold) {
      console.log('Open PlayerUI URL above. Press Ctrl+C to stop the sample.');
      await new Promise((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
    }
  } finally {
    await cleanup();
  }
}

run().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
