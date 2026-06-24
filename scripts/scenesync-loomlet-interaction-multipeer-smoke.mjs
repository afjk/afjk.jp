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
process.env.GPT_SESSION_SECRET ||= 'scene-sync-loomlet-interaction-smoke-secret';

const TEST_TIMEOUT_MS = 90000;
const OBJECT_ID = 'loomlet-click-box';
const CLICK_X_THRESHOLD = 0.08;

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
        payloadType: message.payload?.type || null,
        channel: message.payload?.channel || null,
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
    device: 'SceneSync Loomlet Interaction Smoke',
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
  const closed = waitForEvent(ws, 'close', 5000).catch(() => {});
  ws.terminate();
  await closed;
}

async function closeServer(server) {
  if (!server) return;
  server.closeIdleConnections?.();
  await new Promise((resolve) => {
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

function summarizeConsole(consoleMessages) {
  return consoleMessages.filter((entry) => {
    if (/GL Driver Message .*ReadPixels/.test(entry.text)) return false;
    if (/Failed to load resource: the server responded with a status of 404/.test(entry.text)) return false;
    if (/THREE\.GLTFExporter: Creating normalized normal attribute/.test(entry.text)) return false;
    if (/BGM.*autoplay blocked/.test(entry.text)) return false;
    return true;
  });
}

function createClickAccumulatorGraph() {
  return {
    nodes: [
      { id: 'click', type: 'onEvent', params: { channel: 'pointer.click' } },
      { id: 'count', type: 'list.length' },
      { id: 'scale', type: 'multiply', params: { b: 6 } },
      { id: 'integrate', type: 'integrate', params: { initial: 0, min: 0, max: 2 } },
      { id: 'set', type: 'sceneSetPosition', params: { y: 1.25, z: 0 } },
    ],
    edges: [
      { from: 'click.event', to: 'count.list' },
      { from: 'count.out', to: 'scale.a' },
      { from: 'scale.out', to: 'integrate.value' },
      { from: 'integrate.out', to: 'set.x' },
    ],
  };
}

function createInteractionSceneState() {
  return {
    kind: 'scene-state',
    envId: 'studio',
    physics: {
      version: 1,
      enabled: true,
      duration: 8,
      worldOptions: {
        gravity: [0, 0, 0],
        ground: null,
        timestep: 1 / 60,
      },
    },
    objects: {
      [OBJECT_ID]: {
        name: 'Loomlet Click Box',
        asset: {
          type: 'primitive',
          primitive: 'box',
          color: '#2f80ed',
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
          linearDamping: 8,
          angularDamping: 8,
          canSleep: false,
        },
      },
    },
    loomGraphs: {
      scene: null,
      objects: {
        [OBJECT_ID]: createClickAccumulatorGraph(),
      },
    },
  };
}

function sceneUrl({ httpBaseUrl, wsBaseUrl, roomId, nickname }) {
  const params = new URLSearchParams({
    room: roomId,
    presence: wsBaseUrl,
    dev: '1',
    shell: 'player',
    name: nickname,
  });
  return `${httpBaseUrl}/scenesync/?${params.toString()}`;
}

function attachPageDiagnostics(page, label, result) {
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      result.console.push({ page: label, type, text: msg.text() });
    }
  });
  page.on('pageerror', (error) => {
    result.pageErrors.push({ page: label, text: error.message || String(error) });
  });
}

async function openPlayerPage(context, options, result) {
  const page = await context.newPage();
  attachPageDiagnostics(page, options.nickname, result);
  const url = sceneUrl(options);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TEST_TIMEOUT_MS });
  await waitForPlayerReady(page);
  return page;
}

async function waitForPlayerReady(page) {
  await page.waitForFunction(() => window.__sceneSyncDebug?.presence?.().connected, null, {
    timeout: TEST_TIMEOUT_MS,
  });
  await page.waitForFunction(() => document.body.dataset.sceneSyncShell === 'player', null, {
    timeout: TEST_TIMEOUT_MS,
  });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas');
    const rect = canvas?.getBoundingClientRect();
    return Boolean(canvas && canvas.width > 0 && rect?.width > 0 && rect?.height > 0);
  }, null, { timeout: TEST_TIMEOUT_MS });
}

async function waitForInteractionScene(page) {
  await page.waitForFunction((objectId) => {
    const debug = window.__sceneSyncDebug;
    const object = debug?.objects?.get?.(objectId);
    const physics = debug?.physics?.state?.();
    const graph = debug?.loomlet?.state?.()?.objects?.[objectId];
    return Boolean(
      object &&
      physics?.scenePhysics?.enabled === true &&
      physics?.hasBodies === true &&
      physics?.objectIds?.includes(objectId) &&
      graph,
    );
  }, OBJECT_ID, { timeout: TEST_TIMEOUT_MS });
}

async function startSharedPlayback(page) {
  return page.evaluate(() => {
    window.__sceneSyncDebug.sceneClock.requestControl();
    window.__sceneSyncDebug.sceneClock.play();
    return window.__sceneSyncDebug.sceneClock.state();
  });
}

async function waitForSharedPlayback(page) {
  await page.waitForFunction(() => {
    const state = window.__sceneSyncDebug?.sceneClock?.state?.();
    return state?.mode === 'shared-playback' &&
      state?.transportActive === true &&
      state?.active === true;
  }, null, { timeout: TEST_TIMEOUT_MS });
}

async function clickSceneObject(page, objectId) {
  const pointHandle = await page.waitForFunction((id) => {
    const point = window.__sceneSyncDebug?.objects?.screenPoint?.(id);
    if (
      point?.visible === true &&
      Number.isFinite(point.clientX) &&
      Number.isFinite(point.clientY)
    ) {
      return point;
    }
    return false;
  }, objectId, { timeout: TEST_TIMEOUT_MS });
  const point = await pointHandle.jsonValue();
  await page.mouse.move(point.clientX, point.clientY);
  await page.mouse.down({ button: 'left' });
  await page.waitForTimeout(60);
  await page.mouse.up({ button: 'left' });
  return point;
}

async function waitForObjectX(page, minX = CLICK_X_THRESHOLD) {
  await page.waitForFunction(({ objectId, threshold }) => {
    const object = window.__sceneSyncDebug?.objects?.get?.(objectId);
    return Number(object?.position?.[0]) >= threshold;
  }, { objectId: OBJECT_ID, threshold: minX }, { timeout: TEST_TIMEOUT_MS });
  return page.evaluate((objectId) => window.__sceneSyncDebug.objects.get(objectId), OBJECT_ID);
}

async function waitForPlayerInteractionHistory(page, eventId) {
  await page.waitForFunction(({ eventId }) => {
    const events = window.__sceneSyncDebug?.playerInteraction?.timeline?.()?.eventHistory || [];
    return events.some(event => event.eventId === eventId && event.channel === 'pointer.click');
  }, { eventId }, { timeout: TEST_TIMEOUT_MS });
  return page.evaluate((id) => (
    window.__sceneSyncDebug.playerInteraction.timeline().eventHistory
      .find(event => event.eventId === id)
  ), eventId);
}

async function waitForLoomletClickEvaluation(page, eventId) {
  await page.waitForFunction(({ objectId, eventId, threshold }) => {
    const key = `object:${objectId}`;
    const records = window.__sceneSyncDebug?.loomlet?.debug?.()?.eventEvaluations?.[key] || [];
    return records.some(record => (
      record.events?.some(event => (
        event.eventId === eventId &&
        event.channel === 'pointer.click' &&
        event.target === objectId
      )) &&
      record.effects?.some(effect => (
        effect.type === 'scene.setPosition' &&
        effect.objectId === objectId &&
        Array.isArray(effect.position) &&
        Number(effect.position[0]) >= threshold
      ))
    ));
  }, { objectId: OBJECT_ID, eventId, threshold: CLICK_X_THRESHOLD }, { timeout: TEST_TIMEOUT_MS });
  return page.evaluate(({ objectId, eventId }) => {
    const key = `object:${objectId}`;
    return window.__sceneSyncDebug.loomlet.debug().eventEvaluations[key]
      .find(record => record.events?.some(event => event.eventId === eventId));
  }, { objectId: OBJECT_ID, eventId });
}

async function run() {
  const { chromium } = await import('playwright');
  const presenceServer = createPresenceServer();
  await listenServer(presenceServer);
  const staticServer = await createStaticServer();
  const httpBaseUrl = serverUrl(staticServer);
  const wsBaseUrl = `${serverUrl(presenceServer, 'ws')}/ws`;
  const roomId = `loomlet-interaction-${Date.now().toString(36)}`;
  const result = {
    roomId,
    console: [],
    pageErrors: [],
    assertions: [],
  };

  let browser;
  let loaderWs;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    await context.addInitScript(() => {
      localStorage.setItem('sceneSync.welcomeSeen', 'true');
      localStorage.setItem('sceneSync.displayName', 'Loomlet Smoke');
    });

    const actor = await openPlayerPage(context, {
      httpBaseUrl,
      wsBaseUrl,
      roomId,
      nickname: 'Loomlet Actor',
    }, result);
    const observer = await openPlayerPage(context, {
      httpBaseUrl,
      wsBaseUrl,
      roomId,
      nickname: 'Loomlet Observer',
    }, result);

    await Promise.all([
      actor.waitForFunction(() => window.__sceneSyncDebug.presence().peers.length >= 1, null, {
        timeout: TEST_TIMEOUT_MS,
      }),
      observer.waitForFunction(() => window.__sceneSyncDebug.presence().peers.length >= 1, null, {
        timeout: TEST_TIMEOUT_MS,
      }),
    ]);
    const actorPresence = await actor.evaluate(() => window.__sceneSyncDebug.presence());
    assert.ok(actorPresence.id, 'actor must have a presence id');
    result.assertions.push(`actor:${actorPresence.id}`);

    loaderWs = await connectPresenceClient(wsBaseUrl, roomId, 'Loomlet Interaction Loader');
    loaderWs.send(JSON.stringify({
      type: 'broadcast',
      payload: createInteractionSceneState(),
    }));

    await Promise.all([
      waitForInteractionScene(actor),
      waitForInteractionScene(observer),
    ]);
    result.assertions.push('scene-state+loom-graph-applied');

    await startSharedPlayback(actor);
    await Promise.all([
      waitForSharedPlayback(actor),
      waitForSharedPlayback(observer),
    ]);
    result.assertions.push('shared-playback-active');

    const clickMessagePromise = waitForMessage(loaderWs, message => (
      message.type === 'handoff' &&
      message.payload?.kind === 'scene-event' &&
      message.payload?.channel === 'pointer.click' &&
      message.payload?.target === OBJECT_ID &&
      message.from?.id === actorPresence.id
    ), { label: 'actor pointer.click scene-event' });

    const clickPoint = await clickSceneObject(actor, OBJECT_ID);
    const clickMessage = await clickMessagePromise;
    const clickEventId = clickMessage.payload.eventId;
    result.assertions.push(`click:${Math.round(clickPoint.clientX)},${Math.round(clickPoint.clientY)}:${clickEventId}`);

    const [actorObject, observerObject, actorEvaluation, observerEvaluation] = await Promise.all([
      waitForObjectX(actor),
      waitForObjectX(observer),
      waitForLoomletClickEvaluation(actor, clickEventId),
      waitForLoomletClickEvaluation(observer, clickEventId),
    ]);
    result.assertions.push(
      `synced-x:${actorObject.position[0].toFixed(4)}:${observerObject.position[0].toFixed(4)}`,
    );
    result.assertions.push(
      `loomlet-eval:${actorEvaluation.tick ?? 'na'}:${observerEvaluation.tick ?? 'na'}`,
    );

    await closeWebSocket(loaderWs);
    loaderWs = null;

    const late = await openPlayerPage(context, {
      httpBaseUrl,
      wsBaseUrl,
      roomId,
      nickname: 'Loomlet Late Observer',
    }, result);
    await waitForInteractionScene(late);
    await waitForSharedPlayback(late);
    await waitForPlayerInteractionHistory(late, clickEventId);
    const lateEvaluation = await waitForLoomletClickEvaluation(late, clickEventId);
    const lateObject = await waitForObjectX(late);
    result.assertions.push(`late-replay:${lateEvaluation.tick ?? 'na'}:${lateObject.position[0].toFixed(4)}`);

    const consoleErrors = summarizeConsole(result.console)
      .filter(entry => entry.type === 'error');
    assert.deepEqual(result.pageErrors, [], 'page errors should be empty');
    assert.deepEqual(consoleErrors, [], `unexpected browser console errors: ${JSON.stringify(consoleErrors)}`);

    console.log(JSON.stringify({
      ok: true,
      roomId,
      assertions: result.assertions,
    }, null, 2));
  } finally {
    await closeWebSocket(loaderWs);
    if (browser) await browser.close();
    await closeServer(staticServer);
    await stopPresenceServer(presenceServer);
  }
}

run().catch((error) => {
  const message = error?.stack || error?.message || String(error);
  console.error(message);
  if (/Executable doesn't exist/.test(message)) {
    console.error('Run `npm run test:e2e:install-browsers` and retry this smoke test.');
  } else if (/MachPortRendezvousServer|Permission denied/.test(message)) {
    console.error('Chromium could not launch in the current macOS sandbox; existing Playwright smokes fail the same way in this environment.');
  }
  process.exit(1);
});
