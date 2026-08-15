import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { SINGLE_HTML_HANDOFF_SOURCES } from '../html/assets/js/scenesync-export/export/build-export-package.js';
import { buildSingleHtmlDocument } from '../html/assets/js/scenesync-export/export/single-html-format.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlRoot = path.join(repoRoot, 'html');
const require = createRequire(import.meta.url);
const WebSocket = require(path.join(repoRoot, 'apps/presence-server/node_modules/ws'));
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(repoRoot, '.playwright-browsers');
process.env.GPT_SESSION_SECRET ||= 'scene-sync-handoff-e2e-secret';
const TEST_TIMEOUT_MS = 120_000;

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'], ['.glb', 'model/gltf-binary'], ['.wasm', 'application/wasm'],
]);

function serverUrl(server, scheme = 'http') {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server has no TCP address');
  return `${scheme}://127.0.0.1:${address.port}`;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function resolveStaticPath(urlPath) {
  let pathname = decodeURIComponent(new URL(urlPath, 'http://localhost').pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const candidate = path.resolve(htmlRoot, `.${pathname}`);
  return candidate.startsWith(`${htmlRoot}${path.sep}`) ? candidate : null;
}

function createStaticServer(presenceHttpUrl) {
  return createServer(async (req, res) => {
    requestLog.push(`${req.method || 'GET'} ${req.url || '/'}`);
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname.startsWith('/presence/blob')) {
        const body = req.method === 'PUT' || req.method === 'POST' ? await readRequest(req) : undefined;
        const upstream = await fetch(`${presenceHttpUrl}${url.pathname.replace('/presence', '')}${url.search}`, {
          method: req.method,
          headers: req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {},
          body,
        });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
          'content-length': bytes.length,
        });
        res.end(bytes);
        return;
      }
      const filePath = resolveStaticPath(req.url || '/');
      if (!filePath) throw new Error('invalid path');
      const body = await readFile(filePath);
      res.writeHead(200, {
        'content-type': mimeTypes.get(path.extname(filePath)) || 'application/octet-stream',
        'content-length': body.length,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    }
  });
}

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function waitForMessage(ws, predicate, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label}`));
    }, TEST_TIMEOUT_MS);
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
    };
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

async function connectObserver(wsUrl, roomId) {
  const ws = new WebSocket(`${wsUrl}?room=${encodeURIComponent(roomId)}`);
  const welcome = waitForMessage(ws, (message) => message.type === 'welcome', 'observer welcome');
  await waitForOpen(ws);
  ws.send(JSON.stringify({ type: 'hello', nickname: 'Handoff Observer', device: 'E2E', userId: 'handoff-observer' }));
  await welcome;
  ws.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type !== 'handoff' || message.payload?.kind !== 'scene-request' || !message.from?.id) return;
    ws.send(JSON.stringify({
      type: 'handoff',
      targetId: message.from.id,
      payload: { kind: 'scene-state', envId: 'outdoor_day', objects: {}, bgm: null },
    }));
  });
  return ws;
}

function align4(length) { return (length + 3) & ~3; }

function createTriangleGlb() {
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: 42 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
  }));
  const jsonLength = align4(json.length);
  const glb = new Uint8Array(12 + 8 + jsonLength + 8 + 44);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, glb.length, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true); glb.set(json, 20);
  glb.fill(0x20, 20 + json.length, 20 + jsonLength);
  const binaryOffset = 20 + jsonLength;
  view.setUint32(binaryOffset, 44, true); view.setUint32(binaryOffset + 4, 0x004e4942, true);
  const data = new DataView(glb.buffer, binaryOffset + 8);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => data.setFloat32(index * 4, value, true));
  data.setUint16(36, 0, true); data.setUint16(38, 1, true); data.setUint16(40, 2, true);
  return glb;
}

async function loadHandoffFiles() {
  const files = {};
  for (const { src, dest } of SINGLE_HTML_HANDOFF_SOURCES) {
    files[dest] = await readFile(path.join(htmlRoot, src.replace(/^\//u, '')), 'utf8');
  }
  files['viewer/viewer.css'] = '#loading-overlay { display: none }';
  files['viewer/viewer.js'] = 'globalThis.__HANDOFF_SOURCE_READY__ = true;';
  return files;
}

let presenceServer;
let staticServer;
let observer;
let browser;
let tempDir;
const requestLog = [];
try {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'scene-sync-handoff-e2e-'));
  process.env.SCENE_SYNC_GLB_BACKUP_DIR = path.join(tempDir, 'glb-backup');
  process.env.SCENE_SYNC_GLB_BACKUP_MIN_FREE_BYTES = '0';
  const { createPresenceServer } = await import('../apps/presence-server/src/server.mjs');
  presenceServer = await listen(createPresenceServer());
  const presenceHttpUrl = serverUrl(presenceServer);
  const presenceWsUrl = serverUrl(presenceServer, 'ws');
  staticServer = await listen(createStaticServer(presenceHttpUrl));
  const targetOrigin = serverUrl(staticServer);
  const targetUrl = `${targetOrigin}/scenesync/?presence=${encodeURIComponent(presenceWsUrl)}`;
  const roomId = `handoff-e2e-${Date.now().toString(36)}`.slice(0, 24);
  observer = await connectObserver(presenceWsUrl, roomId);

  const sceneDocument = {
    format: 'scene-sync-export-scene', version: 2,
    objects: [
      {
        id: 'handoff-e2e-image', position: [-1, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        asset: { type: 'image', path: 'assets/pixel.png', mime: 'image/png' },
      },
      {
        id: 'handoff-e2e-glb', position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        asset: { type: 'mesh', path: 'assets/triangle.glb', mime: 'model/gltf-binary' },
      },
    ],
  };
  const sourceHtml = (await buildSingleHtmlDocument({
    sceneDocument,
    manifest: { singleHtml: { format: 'single-html-v1', version: 1 } },
    files: {
      'assets/pixel.png': Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')),
      'assets/triangle.glb': createTriangleGlb(),
    },
    viewerFiles: await loadHandoffFiles(),
  })).replace(
    '<body>',
    `<body><script>globalThis.__SCENE_SYNC_HANDOFF_TARGET_URL__ = ${JSON.stringify(targetUrl)};<\/script>`,
  );
  const sourcePath = path.join(tempDir, 'source.html');
  await writeFile(sourcePath, sourceHtml);

  const observedAdds = new Map();
  const observerDiagnostics = [];
  const addsDone = new Promise((resolve) => {
    observer.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      observerDiagnostics.push(JSON.stringify(message));
      if (message.type === 'handoff' && message.payload?.kind === 'scene-add'
        && ['handoff-e2e-image', 'handoff-e2e-glb'].includes(message.payload.objectId)) {
        observedAdds.set(message.payload.objectId, message.payload);
        if (observedAdds.size === 2) resolve();
      }
    });
  });

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const sourceDiagnostics = [];
  page.on('console', (message) => sourceDiagnostics.push(`console:${message.type()}:${message.text()}`));
  page.on('pageerror', (error) => sourceDiagnostics.push(`pageerror:${error.message}`));
  await page.goto(pathToFileURL(sourcePath).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__HANDOFF_SOURCE_READY__ === true);
  await page.locator('#scene-sync-handoff-room').fill(roomId);
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#scene-sync-handoff button').click();
  const popup = await popupPromise;
  const popupDiagnostics = [];
  popup.on('console', (message) => popupDiagnostics.push(`console:${message.type()}:${message.text()}`));
  popup.on('pageerror', (error) => popupDiagnostics.push(`pageerror:${error.message}`));
  await popup.waitForLoadState('domcontentloaded');
  try {
    await page.waitForFunction(() => document.getElementById('scene-sync-handoff-status')?.textContent === 'Opened in Scene Sync.', null, {
      timeout: TEST_TIMEOUT_MS,
    });
  } catch (error) {
    const status = await page.locator('#scene-sync-handoff-status').textContent().catch(() => 'unavailable');
    throw new Error(`${error.message}\npopup=${popup.url()}\nstatus=${status}\nsource=${sourceDiagnostics.join('\n')}\npopup diagnostics=${popupDiagnostics.join('\n')}\nrequests=${requestLog.join('\n')}`);
  }
  await Promise.race([
    addsDone,
    new Promise((_, reject) => setTimeout(() => reject(new Error(
      `Timed out waiting for peer broadcasts\nobserved=${observerDiagnostics.join('\n')}\npopup=${popupDiagnostics.join('\n')}`,
    )), 10_000)),
  ]);
  const targetState = await popup.evaluate(async () => {
    const { managedObjects, presenceState } = await import('/assets/js/scenesync/scene.js');
    return {
      room: presenceState.room,
      objects: ['handoff-e2e-image', 'handoff-e2e-glb'].map((id) => ({
        id,
        asset: managedObjects.get(id)?.userData?.asset || null,
      })),
    };
  });
  assert.equal(targetState.room, roomId);
  assert.equal(targetState.objects[0].asset?.type, 'image');
  assert.equal(targetState.objects[1].asset?.type, 'mesh');
  assert.equal(observedAdds.get('handoff-e2e-image')?.asset?.path, undefined);
  assert.equal(observedAdds.get('handoff-e2e-glb')?.asset?.source, 'carrier');
  const allowedPopupWarning = /GL Driver Message|unknown input adapter/u;
  const unexpectedDiagnostics = [
    ...sourceDiagnostics.filter((entry) => entry.startsWith('pageerror:') || entry.startsWith('console:error:')
      || entry.startsWith('console:warning:')),
    ...popupDiagnostics.filter((entry) => entry.startsWith('pageerror:') || entry.startsWith('console:error:')
      || (entry.startsWith('console:warning:') && !allowedPopupWarning.test(entry))),
  ];
  assert.deepEqual(unexpectedDiagnostics, []);
  console.log(JSON.stringify({ status: 'passed', roomId, targetState, observed: [...observedAdds.keys()] }, null, 2));
} finally {
  await browser?.close();
  if (observer && observer.readyState !== WebSocket.CLOSED) observer.terminate();
  await closeServer(staticServer);
  await presenceServer?.stop?.();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
}
