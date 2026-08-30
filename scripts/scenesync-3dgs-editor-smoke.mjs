import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDracoTriangleGlb } from './lib/scenesync-e2e-fixtures.mjs';
import { buildGaussianSplatPly } from '../html/assets/js/scenesync/loaders/gaussian-splat/test-fixtures.mjs';
import { DEFAULT_GAUSSIAN_CARRIER_COMPRESSION_MIN_BYTES } from '../html/assets/js/scenesync/assets/carrier-compression.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlRoot = path.join(repoRoot, 'html');
const sogFixturePath = process.env.SCENESYNC_3DGS_SOG_FIXTURE
  ? path.resolve(repoRoot, process.env.SCENESYNC_3DGS_SOG_FIXTURE)
  : path.join(htmlRoot, 'scenesync/experiments/fixtures/ring-gaussian-splats.sog');
const expectedSplatCount = Number(process.env.SCENESYNC_3DGS_EXPECTED_SPLATS || 16);
const gaussianLoadTimeoutMs = Number(process.env.SCENESYNC_3DGS_LOAD_TIMEOUT_MS || 30000);
const transportOnly = process.env.SCENESYNC_3DGS_TRANSPORT_ONLY === '1';
const sogFixtureName = path.basename(sogFixturePath);
const liveSuperSplatSceneUrl = String(process.env.SCENESYNC_3DGS_SUPERSPLAT_URL || '').trim();
const superSplatSceneUrl = liveSuperSplatSceneUrl
  || 'https://superspl.at/scene/scenesync-ring';
const superSplatExpectedCount = Number(
  process.env.SCENESYNC_3DGS_SUPERSPLAT_EXPECTED_SPLATS
    || (liveSuperSplatSceneUrl ? Number.NaN : expectedSplatCount),
);
const superSplatResolverPattern =
  'https://insta360-sog-resolver.afjk01.workers.dev/api/supersplat**';
const superSplatAssetUrl =
  'https://scenesync-fixture.cloudfront.net/scenesync-ring/v1/ring-gaussian-splats.sog';
const configuredDropPosition = String(process.env.SCENESYNC_3DGS_DROP_POSITION || '')
  .split(',')
  .map(Number);
const sogDropPosition = configuredDropPosition.length === 3
  && configuredDropPosition.every(Number.isFinite)
  ? configuredDropPosition
  : [0, 0, 0];
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(repoRoot, '.playwright-browsers');
process.env.GPT_SESSION_SECRET ||= 'scene-sync-3dgs-editor-smoke-secret';
process.env.LINK_TOKEN_SECRET ||= 'scene-sync-3dgs-editor-smoke-link-secret';
process.env.BLOB_DIR ||= path.join(tmpdir(), `scene-sync-3dgs-editor-smoke-${process.pid}`);
const { chromium } = await import('playwright');
const { createPresenceServer } = await import('../apps/presence-server/src/server.mjs');

const mimeByExtension = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.glb', 'model/gltf-binary'],
  ['.wasm', 'application/wasm'],
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createStaticServer() {
  const blobs = new Map();
  return new Promise((resolve, reject) => {
    const server = createServer(async (request, response) => {
      const url = new URL(request.url || '/', 'http://localhost');
      if (url.pathname === '/__scene-sync-3dgs-fixture.sog') {
        const body = await readFile(sogFixturePath);
        response.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': body.byteLength,
        });
        response.end(body);
        return;
      }
      if (url.pathname.startsWith('/presence/blob/')) {
        const id = url.pathname.slice('/presence/blob/'.length);
        if (request.method === 'POST') {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          blobs.set(id, Buffer.concat(chunks));
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{}');
          return;
        }
        if (request.method === 'GET' || request.method === 'HEAD') {
          const body = blobs.get(id);
          if (!body) {
            response.writeHead(404).end('Not found');
            return;
          }
          response.writeHead(200, {
            'content-type': 'model/gltf-binary',
            'content-length': body.byteLength,
          });
          response.end(request.method === 'HEAD' ? undefined : body);
          return;
        }
        if (request.method === 'DELETE') {
          response.writeHead(blobs.delete(id) ? 204 : 404).end();
          return;
        }
        response.writeHead(405).end('Method not allowed');
        return;
      }

      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const filePath = path.resolve(htmlRoot, `.${pathname}`);
      if (!filePath.startsWith(`${htmlRoot}${path.sep}`)) {
        response.writeHead(400).end('Bad request');
        return;
      }
      try {
        const body = await readFile(filePath);
        response.writeHead(200, {
          'content-type': mimeByExtension.get(path.extname(filePath)) || 'application/octet-stream',
          'content-length': body.byteLength,
        });
        response.end(body);
      } catch {
        response.writeHead(404).end('Not found');
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
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
  if (!address || typeof address === 'string') throw new Error('server did not expose an address');
  return `${scheme}://127.0.0.1:${address.port}`;
}

const server = await createStaticServer();
const presenceServer = createPresenceServer();
await listenServer(presenceServer);
const roomId = `gaussian-${Date.now().toString(36)}`;
const presenceUrl = `${serverUrl(presenceServer, 'ws')}/ws`;
const url = `${serverUrl(server)}/scenesync/?dev=1&room=${roomId}&presence=${encodeURIComponent(presenceUrl)}`;
const dracoBytes = createDracoTriangleGlb();
const degree3PlyBytes = buildGaussianSplatPly([{
  position: [0, 0, 0],
  scale: [0.2, 0.1, 0.15],
  rotation: [0, 0, 0, 1],
  opacity: 0.8,
  sh0: [0.2, -0.1, 0.4],
  shRest: Array.from({ length: 45 }, (_, index) => Math.sin(index) * 0.25),
}], { shDegree: 3 });
const widePlyBytes = buildGaussianSplatPly([
  {
    position: [-25, -20, 0],
    scale: [0.2, 0.2, 0.2],
    rotation: [0, 0, 0, 1],
    opacity: 0.8,
    sh0: [0.2, 0.1, 0],
  },
  {
    position: [25, 30, 0],
    scale: [0.2, 0.2, 0.2],
    rotation: [0, 0, 0, 1],
    opacity: 0.8,
    sh0: [0, 0.1, 0.2],
  },
]);
const sogFixtureBytes = await readFile(sogFixturePath);

let browser;
try {
  browser = await chromium.launch({ headless: true });
  e2eFlow: {
  const sourceContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const targetContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await sourceContext.addInitScript(() => {
    localStorage.setItem('sceneSync.welcomeSeen', 'true');
    localStorage.setItem('sceneSync.displayName', 'Gaussian Source');
  });
  await targetContext.addInitScript(() => {
    localStorage.setItem('sceneSync.welcomeSeen', 'true');
    localStorage.setItem('sceneSync.displayName', 'Gaussian Player');
  });
  const page = await sourceContext.newPage();
  const targetPage = await targetContext.newPage();
  if (!liveSuperSplatSceneUrl) {
    await page.route(superSplatResolverPattern, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          provider: 'supersplat',
          sceneId: 'scenesync-ring',
          pageUrl: superSplatSceneUrl,
          title: 'SceneSync Ring',
          author: 'SceneSync fixture',
          downloadable: true,
          license: {
            code: 'CC0-1.0',
            label: 'CC0 1.0',
            url: 'https://creativecommons.org/publicdomain/zero/1.0/',
          },
          attribution: {
            status: 'complete',
            text: '"SceneSync Ring" by SceneSync fixture\nSource: https://superspl.at/scene/scenesync-ring\nLicensed under CC0 1.0',
            sourceUrl: superSplatSceneUrl,
            creators: [{ name: 'SceneSync fixture', url: null }],
            publisher: { name: 'SceneSync fixture', url: null },
          },
          asset: { format: 'sog', url: superSplatAssetUrl, revision: 'v1' },
        }),
      });
    });
    await page.route(superSplatAssetUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        headers: { 'access-control-allow-origin': '*' },
        body: sogFixtureBytes,
      });
    });
  }
  const pageErrors = [];
  const consoleErrors = [];
  const invalidOperations = [];
  const requestUrls = [];
  let phase = 'startup';
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    const text = message.text();
    if (/WebGL: INVALID_OPERATION/iu.test(text)) {
      if (invalidOperations.length < 20) invalidOperations.push(`${phase}: ${text}`);
      return;
    }
    if (message.type() !== 'error') return;
    if (/WebSocket|presence\/|favicon/iu.test(text)) return;
    consoleErrors.push(text);
  });
  page.on('request', (request) => requestUrls.push(request.url()));
  targetPage.on('pageerror', (error) => pageErrors.push(`target: ${error.message}`));
  targetPage.on('console', (message) => {
    const text = message.text();
    if (/WebGL: INVALID_OPERATION/iu.test(text)) {
      if (invalidOperations.length < 20) invalidOperations.push(`target/${phase}: ${text}`);
      return;
    }
    if (message.type() !== 'error') return;
    if (/WebSocket|presence\/|favicon/iu.test(text)) return;
    consoleErrors.push(`target: ${text}`);
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await targetPage.goto(`${url}&shell=player&name=Gaussian%20Player`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__sceneSyncDebug?.renderer?.(), null, {
    timeout: 30000,
  });
  await targetPage.waitForFunction(() => globalThis.__sceneSyncDebug?.renderer?.(), null, {
    timeout: 30000,
  });
  await page.waitForFunction(() => (
    globalThis.__sceneSyncDebug?.presence?.().connected
      && globalThis.__sceneSyncDebug.presence().peers.length === 1
  ), null, { timeout: 30000 });
  phase = 'sog-import';
  const importStartedAt = Date.now();
  const imported = await page.evaluate(async ({ fileName, dropPosition }) => {
    const response = await fetch('/__scene-sync-3dgs-fixture.sog');
    if (!response.ok) throw new Error(`fixture fetch failed: ${response.status}`);
    const file = new File([await response.arrayBuffer()], fileName);
    const model = await globalThis.__sceneSyncDebug.dragDropManager.handleFile(file, {
      position: dropPosition,
    });
    return {
      objectId: model?.userData?.objectId || null,
      importedFrom: model?.userData?.importedFrom || null,
    };
  }, { fileName: sogFixtureName, dropPosition: sogDropPosition });
  const sourceReadyMs = Date.now() - importStartedAt;

  assert(imported.objectId, 'Editor SOG drop did not create an object');
  assert(imported.importedFrom?.sourceFormat === 'sog', 'Editor did not use the SOG normalization path');

  const snapshot = await page.evaluate((objectId) => (
    globalThis.__sceneSyncDebug.objects.get(objectId)
  ), imported.objectId);
  const renderer = await page.evaluate(() => globalThis.__sceneSyncDebug.renderer());
  assert(renderer.renderer === 'WebGPURenderer', 'Editor did not use WebGPURenderer');
  assert(renderer.backend === 'webgl', 'Editor default backend was not WebGL');
  assert(renderer.xrEnabled === true, 'Editor WebXR integration was not enabled');
  assert(renderer.initialized === true, 'Editor Gaussian extension was not initialized');
  assert(
    renderer.gaussianSplatPatch === 'xr-stereo-mediumpModelViewMatrix-cameraViewport-smooth-kernel',
    'Editor did not use the production Gaussian XR stereo/smooth patch',
  );
  assert(snapshot.gaussian?.hasGaussianSplat === true, 'Editor GLB path did not create GaussianSplat');
  assert(snapshot.gaussian?.gaussianObjects === 1, 'Editor Gaussian object count changed');
  assert(snapshot.gaussian?.splatCount === expectedSplatCount, 'Editor did not preserve every SOG splat');
  assert(JSON.stringify(snapshot.position) === JSON.stringify(sogDropPosition),
    'Editor moved the Gaussian capture away from its requested drop position');
  assert(snapshot.gaussian?.selectionProxy === true, 'Editor did not create a Gaussian bounds selection proxy');
  assert(snapshot.asset?.assetId, 'Editor did not attach a persistent assetId to the SOG GLB');
  assert(snapshot.asset?.meshPath, 'Editor did not attach a shared meshPath to the SOG GLB');
  const expectsCompressedCarrier = snapshot.asset?.size >= DEFAULT_GAUSSIAN_CARRIER_COMPRESSION_MIN_BYTES;
  if (expectsCompressedCarrier) {
    assert(snapshot.asset?.carrierEncoding === 'gzip', 'Large Gaussian carrier was not gzip encoded');
    assert(snapshot.asset?.carrierSize < snapshot.asset?.size,
      'Large Gaussian carrier did not reduce the transferred byte size');
  }

  phase = 'presence-sync';
  await targetPage.waitForFunction((objectId) => (
    globalThis.__sceneSyncDebug?.objects?.get(objectId)?.gaussian?.hasGaussianSplat === true
  ), imported.objectId, { timeout: gaussianLoadTimeoutMs });
  const targetReadyMs = Date.now() - importStartedAt;
  const targetSnapshot = await targetPage.evaluate((objectId) => (
    globalThis.__sceneSyncDebug.objects.get(objectId)
  ), imported.objectId);
  assert(targetSnapshot.gaussian?.splatCount === expectedSplatCount,
    'A second player did not receive the SOG-derived Gaussian Splat');
  assert(targetSnapshot.asset?.carrierEncoding === snapshot.asset?.carrierEncoding,
    'A second player did not receive the mesh carrier encoding');
  assert(targetSnapshot.asset?.carrierSize === snapshot.asset?.carrierSize,
    'A second player did not receive the mesh carrier byte size');

  phase = 'supersplat-url-import';
  const superSplatImported = await page.evaluate(async ({ sceneUrl, position }) => {
    const debug = globalThis.__sceneSyncDebug;
    const before = new Set(debug.objects.list());
    await debug.dragDropManager.urlImporter(sceneUrl, { toArray: () => position }, {
      targetKind: 'scene',
    });
    const objectId = debug.objects.list().find((id) => !before.has(id)) || null;
    const { managedObjects } = await import('/assets/js/scenesync/scene.js');
    const object = objectId ? managedObjects.get(objectId) : null;
    return {
      objectId,
      importedFrom: object?.userData?.importedFrom || null,
      metadata: object?.userData?.metadata || null,
    };
  }, { sceneUrl: superSplatSceneUrl, position: [2, 0, 0] });
  assert(superSplatImported.objectId, 'SuperSplat URL did not create an Editor object');
  assert(superSplatImported.importedFrom?.provider === 'supersplat',
    'SuperSplat URL did not use the Gaussian conversion path');
  assert(typeof superSplatImported.metadata?.gaussianSplatSource?.license?.code === 'string',
    'SuperSplat attribution metadata was not retained');
  assert(typeof superSplatImported.metadata?.gaussianSplatSource?.license?.url === 'string',
    'SuperSplat license URL was not retained');
  assert(superSplatImported.metadata?.gaussianSplatSource?.attribution?.status === 'complete',
    'SuperSplat structured attribution was not retained');
  const superSplatSnapshot = await page.evaluate((objectId) => (
    globalThis.__sceneSyncDebug.objects.get(objectId)
  ), superSplatImported.objectId);
  assert(superSplatSnapshot.gaussian?.hasGaussianSplat === true,
    'SuperSplat URL did not render as GaussianSplat');
  if (Number.isFinite(superSplatExpectedCount)) {
    assert(superSplatSnapshot.gaussian?.splatCount === superSplatExpectedCount,
      'SuperSplat URL did not preserve every SOG splat');
  }
  assert(JSON.stringify(superSplatSnapshot.position) === JSON.stringify([2, 0, 0]),
    'SuperSplat URL ignored its requested placement');
  const embeddedSuperSplatAsset = await page.evaluate(async ({ assetId, timeoutMs }) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('scene-sync-assets');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const record = await new Promise((resolve, reject) => {
        const request = db.transaction(['assets'], 'readonly').objectStore('assets').get(assetId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
      db.close();
      if (record?.blob) {
        const bytes = new Uint8Array(await record.blob.arrayBuffer());
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(16, true) !== 0x4e4f534a) {
          return null;
        }
        const jsonLength = view.getUint32(12, true);
        const jsonText = new TextDecoder()
          .decode(bytes.subarray(20, 20 + jsonLength))
          .replace(/[\u0000\u0020]+$/u, '');
        const gltfAsset = JSON.parse(jsonText).asset || null;
        const [{ GLBFileLoader }, { scene }] = await Promise.all([
          import('/assets/js/scenesync/loaders/glb-file-loader.js'),
          import('/assets/js/scenesync/scene.js'),
        ]);
        const loader = new GLBFileLoader();
        let reimportedSource = null;
        let model = null;
        try {
          const file = new File([record.blob], 'embedded-supersplat.glb', {
            type: 'model/gltf-binary',
          });
          model = await loader.loadFromFile(file, null, scene);
          reimportedSource = structuredClone(
            model.userData?.metadata?.gaussianSplatSource || null,
          );
        } finally {
          if (model) scene.remove(model);
          loader.dispose();
        }
        return { gltfAsset, reimportedSource };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }, {
    assetId: superSplatSnapshot.asset.assetId,
    timeoutMs: gaussianLoadTimeoutMs,
  });
  assert(typeof embeddedSuperSplatAsset?.gltfAsset?.copyright === 'string',
    'Generated SuperSplat GLB did not contain asset.copyright');
  const embeddedSuperSplatSource = embeddedSuperSplatAsset?.gltfAsset?.extras
    ?.scenesync?.gaussianSplatSource;
  assert(embeddedSuperSplatSource?.pageUrl === superSplatSceneUrl,
    'Generated SuperSplat GLB did not contain namespaced source metadata');
  assert(typeof embeddedSuperSplatSource?.license?.url === 'string',
    'Generated SuperSplat GLB did not contain the license URL');
  assert(embeddedSuperSplatSource?.attribution?.status === 'complete',
    'Generated SuperSplat GLB did not contain structured attribution');
  assert(embeddedSuperSplatAsset?.reimportedSource?.pageUrl === superSplatSceneUrl,
    'A standalone SuperSplat GLB did not restore its source metadata when re-imported');
  assert(embeddedSuperSplatAsset?.reimportedSource?.attribution?.status === 'complete',
    'A standalone SuperSplat GLB did not restore its attribution when re-imported');
  await targetPage.waitForFunction((objectId) => (
    globalThis.__sceneSyncDebug?.objects?.get(objectId)?.gaussian?.hasGaussianSplat === true
  ), superSplatImported.objectId, { timeout: gaussianLoadTimeoutMs });
  const targetSuperSplatMetadata = await targetPage.evaluate(async (objectId) => {
    const { managedObjects } = await import('/assets/js/scenesync/scene.js');
    return managedObjects.get(objectId)?.userData?.metadata || null;
  }, superSplatImported.objectId);
  assert(targetSuperSplatMetadata?.gaussianSplatSource?.pageUrl === superSplatSceneUrl,
    'A second player did not receive SuperSplat source metadata');
  assert(targetSuperSplatMetadata?.gaussianSplatSource?.attribution?.status === 'complete',
    'A second player did not receive SuperSplat attribution metadata');

  const targetCachedBytes = await targetPage.evaluate(async ({ assetId, timeoutMs }) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('scene-sync-assets');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const record = await new Promise((resolve, reject) => {
        const request = db.transaction(['assets'], 'readonly').objectStore('assets').get(assetId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
      db.close();
      if (record?.blob) return record.blob.size;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }, { assetId: snapshot.asset.assetId, timeoutMs: gaussianLoadTimeoutMs });
  assert(targetCachedBytes === snapshot.asset.size,
    'A second player did not cache the decoded canonical GLB');

  phase = 'snapshot-persistence';
  const persisted = await page.evaluate(async ({ roomId: expectedRoomId, objectId, assetId, timeoutMs }) => {
    const openDb = (name) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = (db, storeName, key) => new Promise((resolve, reject) => {
      const request = db.transaction([storeName], 'readonly').objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const [snapshotDb, assetDb] = await Promise.all([
        openDb('scene-sync-room-snapshots'),
        openDb('scene-sync-assets'),
      ]);
      const [roomRecord, assetRecord] = await Promise.all([
        read(snapshotDb, 'snapshots', `${location.origin}::${expectedRoomId}`),
        read(assetDb, 'assets', assetId),
      ]);
      snapshotDb.close();
      assetDb.close();
      const entry = roomRecord?.snapshot?.objects?.find((item) => item.objectId === objectId);
      if (entry?.asset?.assetId === assetId && assetRecord?.blob) {
        return {
          snapshotAssetId: entry.asset.assetId,
          snapshotMeshPath: entry.asset.meshPath,
          cachedBytes: assetRecord.blob.size,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }, {
    roomId,
    objectId: imported.objectId,
    assetId: snapshot.asset.assetId,
    timeoutMs: gaussianLoadTimeoutMs,
  });
  assert(persisted?.snapshotMeshPath === snapshot.asset.meshPath,
    'Room snapshot did not persist the uploaded Gaussian asset reference');
  assert(persisted.cachedBytes > 0, 'Converted Gaussian GLB was not cached for reload');

  // Leave the source as the only participant and remove the temporary server
  // blob. Reload must now come from the room snapshot + IndexedDB assetId, not
  // from the still-live peer or the ten-minute carrier URL.
  await targetContext.close();
  await page.waitForFunction(() => (
    globalThis.__sceneSyncDebug?.presence?.().connected
      && globalThis.__sceneSyncDebug.presence().peers.length === 0
  ), null, { timeout: 30000 });
  const deletedCarrier = await page.evaluate(async (meshPath) => {
    const response = await fetch(`/presence/blob/${meshPath}`, { method: 'DELETE' });
    return response.status;
  }, snapshot.asset.meshPath);
  assert(deletedCarrier === 204, 'E2E carrier blob was not removed before reload');

  phase = 'snapshot-reload';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction((objectId) => (
    globalThis.__sceneSyncDebug?.objects?.get(objectId)?.gaussian?.hasGaussianSplat === true
  ), imported.objectId, { timeout: gaussianLoadTimeoutMs });
  const reloadedSnapshot = await page.evaluate((objectId) => (
    globalThis.__sceneSyncDebug.objects.get(objectId)
  ), imported.objectId);
  assert(reloadedSnapshot.asset?.assetId === snapshot.asset.assetId,
    'Reloaded Gaussian object lost its persistent asset identity');
  assert(reloadedSnapshot.asset?.carrierEncoding === snapshot.asset?.carrierEncoding,
    'Reloaded Gaussian object lost its mesh carrier encoding');
  await page.waitForFunction((objectId) => (
    globalThis.__sceneSyncDebug?.objects?.get(objectId)?.gaussian?.hasGaussianSplat === true
  ), superSplatImported.objectId, { timeout: gaussianLoadTimeoutMs });
  const reloadedSuperSplatMetadata = await page.evaluate(async (objectId) => {
    const { managedObjects } = await import('/assets/js/scenesync/scene.js');
    return managedObjects.get(objectId)?.userData?.metadata || null;
  }, superSplatImported.objectId);
  assert(reloadedSuperSplatMetadata?.gaussianSplatSource?.pageUrl === superSplatSceneUrl,
    'Reloaded SuperSplat object lost its source and license metadata');
  assert(reloadedSuperSplatMetadata?.gaussianSplatSource?.attribution?.status === 'complete',
    'Reloaded SuperSplat object lost its attribution metadata');

  if (transportOnly) {
    assert(pageErrors.length === 0, `Page errors: ${pageErrors.join('\n')}`);
    assert(invalidOperations.length === 0, `WebGL draw errors: ${invalidOperations.join('\n')}`);
    assert(consoleErrors.length === 0, `Console errors: ${consoleErrors.join('\n')}`);
    console.log(JSON.stringify({
      status: 'passed',
      transportOnly: true,
      fixture: sogFixtureName,
      dropPosition: sogDropPosition,
      objectId: imported.objectId,
      sourceReadyMs,
      targetReadyMs,
      rawGlbBytes: snapshot.asset?.size || null,
      carrierBytes: snapshot.asset?.carrierSize || snapshot.asset?.size || null,
      carrierEncoding: snapshot.asset?.carrierEncoding || null,
      gaussian: snapshot.gaussian,
      playerSynchronized: true,
      snapshotPersisted: true,
      reloadedFromAssetCache: true,
      targetCachedRawGlb: true,
      superSplatUrlImported: true,
      superSplatUrlSynchronized: true,
      superSplatUrlRestored: true,
      superSplatGlbAttributionEmbedded: true,
      superSplatGlbAttributionReimported: true,
    }, null, 2));
    break e2eFlow;
  }

  phase = 'draco-import';
  const dracoObjectId = await page.evaluate(async (bytes) => {
    const file = new File([Uint8Array.from(bytes)], 'draco-triangle.glb');
    const model = await globalThis.__sceneSyncDebug.dragDropManager.handleFile(file, {
      position: [-1.5, 0, 0],
    });
    return model?.userData?.objectId || null;
  }, Array.from(dracoBytes));
  assert(dracoObjectId, 'Editor did not load the Draco GLB');
  assert(requestUrls.some((requestUrl) => (
    requestUrl.includes('cbba126004263d0c32d3d6d05a4fe218d261fa47')
    && /draco_decoder(?:\.wasm|\.js)$/u.test(requestUrl)
  )), 'Editor did not use the pinned Three.js Draco decoder');
  const dracoSnapshot = await page.evaluate((objectId) => (
    globalThis.__sceneSyncDebug.objects.get(objectId)
  ), dracoObjectId);
  assert(dracoSnapshot && dracoSnapshot.gaussian === null, 'Editor normal Draco GLB regressed');
  await page.waitForTimeout(500);

  phase = 'sh3-import';
  const shResult = await page.evaluate(async (bytes) => {
    const file = new File([Uint8Array.from(bytes)], 'degree-3.ply');
    const model = await globalThis.__sceneSyncDebug.dragDropManager.handleFile(file, {
      position: [1.5, 0, 0],
    });
    let splat = null;
    model?.traverse?.((object) => { if (object.isGaussianSplat) splat = object; });
    return {
      objectId: model?.userData?.objectId || null,
      shDegree: splat?.splatGeometry?.getAttribute?.('sphericalHarmonics3') ? 3 : 0,
      hasSh1: Boolean(splat?.splatGeometry?.getAttribute?.('sphericalHarmonics1')),
      hasSh2: Boolean(splat?.splatGeometry?.getAttribute?.('sphericalHarmonics2')),
    };
  }, Array.from(degree3PlyBytes));
  assert(shResult.objectId, 'Editor PLY drop did not create an object');
  assert(shResult.shDegree === 3 && shResult.hasSh1 && shResult.hasSh2,
    'Editor discarded or broke the continuous SH1-SH3 attribute set');
  await page.waitForTimeout(500);

  phase = 'selection';
  const screenPoint = await page.evaluate((objectId) => (
    globalThis.__sceneSyncDebug.objects.screenPoint(objectId)
  ), imported.objectId);
  assert(screenPoint?.visible === true, 'Imported Gaussian Splat is outside the Editor camera');
  await page.evaluate(({ clientX, clientY }) => {
    globalThis.__sceneSyncDebug.selectAt(clientX, clientY);
  }, screenPoint);
  await page.waitForFunction((objectId) => (
    globalThis.__sceneSyncDebug.getSelection().selectedObjectIds.includes(objectId)
  ), imported.objectId, { timeout: 10000 });

  const selected = await page.evaluate((objectId) => (
    globalThis.__sceneSyncDebug.objects.get(objectId)
  ), imported.objectId);
  assert(selected.transformControlsAttached === true, 'TransformControls did not attach to the Gaussian wrapper');

  phase = 'transform';
  const transformed = await page.evaluate(async (objectId) => {
    const { managedObjects } = await import('/assets/js/scenesync/scene.js');
    const object = managedObjects.get(objectId);
    object.position.set(1, 2, -1);
    object.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 4);
    object.scale.setScalar(1.5);
    object.visible = false;
    object.updateMatrixWorld(true);
    let splat = null;
    object.traverse((child) => { if (child.isGaussianSplat) splat = child; });
    return {
      position: object.position.toArray(),
      scale: object.scale.toArray(),
      visible: object.visible,
      splatMatrixWorld: splat?.matrixWorld?.toArray?.() || null,
    };
  }, imported.objectId);
  assert(JSON.stringify(transformed.position) === JSON.stringify([1, 2, -1]), 'Gaussian wrapper position did not update');
  assert(JSON.stringify(transformed.scale) === JSON.stringify([1.5, 1.5, 1.5]), 'Gaussian wrapper scale did not update');
  assert(transformed.visible === false, 'Gaussian wrapper visibility did not update');
  assert(Array.isArray(transformed.splatMatrixWorld), 'Gaussian child did not inherit wrapper transform');

  phase = 'delete';
  await page.evaluate(() => globalThis.__sceneSyncDebug.deleteSelected());
  await page.waitForFunction((objectId) => (
    !globalThis.__sceneSyncDebug.objects.list().includes(objectId)
  ), imported.objectId, { timeout: 10000 });

  phase = 'undo';
  await page.evaluate(() => globalThis.__sceneSyncDebug.undo());
  await page.waitForFunction((objectId) => (
    globalThis.__sceneSyncDebug.objects.get(objectId)?.gaussian?.hasGaussianSplat === true
  ), imported.objectId, { timeout: gaussianLoadTimeoutMs });
  const restored = await page.evaluate((objectId) => (
    globalThis.__sceneSyncDebug.objects.get(objectId)
  ), imported.objectId);
  assert(restored.gaussian?.splatCount === expectedSplatCount, 'Undo did not restore the Gaussian Splat');
  assert(restored.gaussian?.selectionProxy === true, 'Undo did not restore the selection proxy');

  phase = 'redo';
  await page.evaluate(() => globalThis.__sceneSyncDebug.redo());
  await page.waitForFunction((objectId) => (
    !globalThis.__sceneSyncDebug.objects.list().includes(objectId)
  ), imported.objectId, { timeout: 10000 });

  phase = 'natural-scale';
  const widePly = await page.evaluate(async (bytes) => {
    const file = new File([Uint8Array.from(bytes)], 'wide-capture.ply');
    const model = await globalThis.__sceneSyncDebug.dragDropManager.handleFile(file, {
      position: [0, 0, -100],
    });
    return globalThis.__sceneSyncDebug.objects.get(model?.userData?.objectId || '');
  }, Array.from(widePlyBytes));
  assert(widePly?.gaussian?.splatCount === 2, 'Wide PLY did not load as GaussianSplat');
  assert(JSON.stringify(widePly.scale) === JSON.stringify([1, 1, 1]),
    'Gaussian capture was still auto-shrunk to the conventional GLB size limit');
  assert(JSON.stringify(widePly.position) === JSON.stringify([0, 0, -100]),
    'Gaussian capture was moved above its requested placement by bounds grounding');

  phase = 'frame-selection';
  await page.keyboard.press('f');
  await page.waitForTimeout(100);
  const framedPoint = await page.evaluate((objectId) => (
    globalThis.__sceneSyncDebug.objects.screenPoint(objectId)
  ), widePly.objectId);
  assert(framedPoint?.visible === true, 'F did not bring the selected Gaussian into camera depth');
  assert(Math.abs(framedPoint.ndc[0]) < 0.05 && Math.abs(framedPoint.ndc[1]) < 0.05,
    'F did not center the selected Gaussian bounds');

  assert(pageErrors.length === 0, `Page errors: ${pageErrors.join('\n')}`);
  assert(invalidOperations.length === 0, `WebGL draw errors: ${invalidOperations.join('\n')}`);
  assert(consoleErrors.length === 0, `Console errors: ${consoleErrors.join('\n')}`);
  console.log(JSON.stringify({
    status: 'passed',
    url,
    renderer,
    objectId: imported.objectId,
    sourceFormat: imported.importedFrom.sourceFormat,
    fixture: sogFixtureName,
    dropPosition: sogDropPosition,
    sourceReadyMs,
    targetReadyMs,
    rawGlbBytes: snapshot.asset?.size || null,
    carrierBytes: snapshot.asset?.carrierSize || snapshot.asset?.size || null,
    carrierEncoding: snapshot.asset?.carrierEncoding || null,
    gaussian: snapshot.gaussian,
    playerSynchronized: true,
    snapshotPersisted: true,
    reloadedFromAssetCache: true,
    targetCachedRawGlb: true,
    authoredGaussianScalePreserved: true,
    authoredGaussianOriginPreserved: true,
    frameSelectionShortcut: true,
    selected: true,
    transformControlsAttached: selected.transformControlsAttached,
    transformed: true,
    visibility: true,
    deleted: true,
    undoRestored: true,
    redoDeleted: true,
    dracoLoaded: true,
    shDegree3Preserved: true,
    superSplatUrlImported: true,
    superSplatUrlSynchronized: true,
    superSplatUrlRestored: true,
    superSplatGlbAttributionEmbedded: true,
    superSplatGlbAttributionReimported: true,
  }, null, 2));
  }
} finally {
  await browser?.close();
  await presenceServer.stop?.();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
