import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPresenceServer } from '../apps/presence-server/src/server.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const htmlRoot = path.join(repoRoot, 'html');
const browserPath = path.join(repoRoot, '.playwright-browsers');
const require = createRequire(import.meta.url);
const WebSocket = require(path.join(repoRoot, 'apps/presence-server/node_modules/ws'));

process.env.PLAYWRIGHT_BROWSERS_PATH ||= browserPath;
process.env.GPT_SESSION_SECRET ||= 'scene-sync-physics-live-room-smoke-secret';

const TEST_TIMEOUT_MS = 60000;

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

  if (pathname.endsWith('/')) {
    pathname = `${pathname}index.html`;
  }

  const candidate = path.resolve(htmlRoot, `.${pathname}`);
  if (!candidate.startsWith(`${htmlRoot}${path.sep}`) && candidate !== htmlRoot) {
    return null;
  }
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

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function listenPresenceServer(server) {
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
    if (event !== 'error') {
      target.once('error', onError);
    }
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
        from: message.from?.id || null,
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
    device: 'Unity Smoke',
    userId: `${nickname.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`,
  }));
  const welcome = await welcomePromise;
  ws.presenceId = welcome.id;
  return ws;
}

async function closeWebSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.CLOSING) {
    await waitForEvent(ws, 'close', 5000).catch(() => {});
    return;
  }
  ws.terminate();
  await waitForEvent(ws, 'close', 5000).catch(() => {});
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function summarizeConsole(consoleMessages) {
  return consoleMessages.filter((entry) => {
    if (/GL Driver Message .*ReadPixels/.test(entry.text)) return false;
    if (/Failed to load resource: the server responded with a status of 404/.test(entry.text)) return false;
    if (/THREE\.GLTFExporter: Creating normalized normal attribute/.test(entry.text)) return false;
    if (/BGM.*autoplay blocked/.test(entry.text)) return false;
    return true;
  });
}

function createLivePhysicsSceneState() {
  return {
    kind: 'scene-state',
    envId: 'studio',
    physics: {
      version: 1,
      enabled: true,
      duration: 4,
      worldOptions: {
        gravity: -9.81,
        ground: null,
        timestep: 1 / 60,
      },
    },
    objects: {
      'live-box': {
        name: 'Live Physics Box',
        asset: {
          type: 'primitive',
          primitive: 'box',
          color: '#4488ff',
        },
        position: [0, 1.25, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        physics: {
          version: 1,
          enabled: true,
          bodyType: 'dynamic',
          shape: 'box',
          halfExtents: [0.5, 0.5, 0.5],
          mass: 1,
          restitution: 0.2,
          friction: 0.5,
          velocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
        },
      },
    },
  };
}

function createSnapshotRequestPayload(hashPayload, requestId) {
  return {
    kind: 'scene-physics-snapshot-request',
    source: 'physics',
    phase: 'postPhysics',
    snapshotVersion: 'SceneSyncPhysicsSnapshotV1',
    profile: hashPayload.profile || 'SceneSyncRapierParity-0.30',
    hashVersion: hashPayload.hashVersion || 'SceneSyncCanonicalPhysicsHashV1',
    requestId,
    reason: 'live-room-smoke',
    tick: hashPayload.tick,
    localTick: hashPayload.tick,
    remoteHash: hashPayload.hash,
    localHash: '0000000000000000',
    sceneClockRevision: hashPayload.sceneClockRevision,
  };
}

async function run() {
  const { chromium } = await import('playwright');
  const presenceServer = createPresenceServer();
  await listenPresenceServer(presenceServer);
  const staticServer = await createStaticServer();
  const httpBaseUrl = serverUrl(staticServer);
  const wsBaseUrl = `${serverUrl(presenceServer, 'ws')}/ws`;
  const roomId = `physics-live-${Date.now().toString(36)}`;
  const result = {
    roomId,
    url: `${httpBaseUrl}/scenesync/?room=${roomId}&presence=${encodeURIComponent(wsBaseUrl)}&dev=1`,
    console: [],
    pageErrors: [],
    assertions: [],
  };

  let browser;
  let unityWs;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });

    await context.addInitScript(() => {
      localStorage.setItem('sceneSync.welcomeSeen', 'true');
      localStorage.setItem('sceneSync.displayName', 'SceneSync Web Smoke');
    });

    const page = await context.newPage();
    page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        result.console.push({ type, text: msg.text() });
      }
    });
    page.on('pageerror', (error) => {
      result.pageErrors.push(error.message || String(error));
    });

    await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: TEST_TIMEOUT_MS });
    await page.waitForFunction(() => window.__sceneSyncDebug?.presence?.().connected, null, {
      timeout: TEST_TIMEOUT_MS,
    });
    await page.waitForFunction(
      () => document.querySelector('canvas') && document.querySelector('canvas').width > 0,
      null,
      { timeout: TEST_TIMEOUT_MS },
    );
    const webPresence = await page.evaluate(() => window.__sceneSyncDebug.presence());
    assert.ok(webPresence.id, 'web peer must have a presence id');
    result.assertions.push(`web:${webPresence.id}`);

    unityWs = await connectPresenceClient(wsBaseUrl, roomId, 'Unity Physics Smoke');
    assert.ok(unityWs.presenceId, 'unity peer must have a presence id');
    result.assertions.push(`unity:${unityWs.presenceId}`);

    await page.waitForFunction(() => {
      const presence = window.__sceneSyncDebug?.presence?.();
      return presence?.peers?.some(peer => peer.nickname === 'Unity Physics Smoke');
    }, null, { timeout: TEST_TIMEOUT_MS });

    unityWs.send(JSON.stringify({
      type: 'broadcast',
      payload: createLivePhysicsSceneState(),
    }));

    await page.waitForFunction(() => {
      const physics = window.__sceneSyncDebug?.physics?.state?.();
      return physics?.scenePhysics?.enabled === true
        && physics?.objectIds?.includes('live-box')
        && physics?.hasBodies === true;
    }, null, { timeout: TEST_TIMEOUT_MS });
    result.assertions.push('scene-state-applied');

    const hashPromise = waitForMessage(unityWs, message => (
      message.type === 'handoff'
      && message.payload?.kind === 'scene-physics-hash'
      && message.from?.id === webPresence.id
      && Number.isInteger(message.payload.tick)
      && typeof message.payload.hash === 'string'
    ), { label: 'web scene-physics-hash' });

    await page.evaluate(() => {
      const clock = window.__sceneSyncDebug.sceneClock.requestControl();
      window.__sceneSyncDebug.sceneClock.play();
      return clock;
    });

    const hashMessage = await hashPromise;
    result.assertions.push(`hash:${hashMessage.payload.tick}:${hashMessage.payload.hash}`);

    const requestId = `snapshot-request-${Date.now().toString(36)}`;
    const snapshotPromise = waitForMessage(unityWs, message => (
      message.type === 'handoff'
      && message.payload?.kind === 'scene-physics-snapshot'
      && message.payload?.requestId === requestId
      && message.from?.id === webPresence.id
    ), { label: 'targeted scene-physics-snapshot' });

    unityWs.send(JSON.stringify({
      type: 'broadcast',
      payload: createSnapshotRequestPayload(hashMessage.payload, requestId),
    }));

    const snapshotMessage = await snapshotPromise;
    const snapshot = snapshotMessage.payload;
    assert.equal(snapshot.snapshotVersion, 'SceneSyncPhysicsSnapshotV1');
    assert.equal(snapshot.requestId, requestId);
    assert.ok(Number.isInteger(snapshot.tick), 'snapshot tick must be an integer');
    assert.equal(typeof snapshot.hash, 'string');
    assert.ok(Array.isArray(snapshot.bodies), 'snapshot must include bodies');
    assert.ok(snapshot.bodies.some(body => body.id === 'live-box'), 'snapshot must include live-box body');
    result.assertions.push(`snapshot:${snapshot.tick}:${snapshot.hash}:${snapshot.bodies.length}`);

    const consoleMessages = summarizeConsole(result.console)
      .filter(entry => entry.type === 'error');
    assert.deepEqual(result.pageErrors, [], 'page errors should be empty');
    assert.deepEqual(consoleMessages, [], `unexpected browser console errors: ${JSON.stringify(consoleMessages)}`);

    console.log(JSON.stringify({
      ok: true,
      roomId,
      assertions: result.assertions,
    }, null, 2));
  } finally {
    await closeWebSocket(unityWs);
    if (browser) await browser.close();
    await closeServer(staticServer);
    if (presenceServer) await presenceServer.stop();
  }
}

run().catch((error) => {
  const message = error?.stack || error?.message || String(error);
  console.error(message);
  if (/Executable doesn't exist|browserType\.launch/.test(message)) {
    console.error('Run `npm run test:e2e:install-browsers` and retry this smoke test.');
  }
  process.exit(1);
});
