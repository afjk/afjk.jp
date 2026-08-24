import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDracoTriangleGlb } from './lib/scenesync-e2e-fixtures.mjs';
import { buildGaussianSplatPly } from '../html/assets/js/scenesync/loaders/gaussian-splat/test-fixtures.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlRoot = path.join(repoRoot, 'html');
const sogFixturePath = path.join(
  htmlRoot,
  'scenesync/experiments/fixtures/ring-gaussian-splats.sog',
);
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(repoRoot, '.playwright-browsers');
const { chromium } = await import('playwright');

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
  return new Promise((resolve, reject) => {
    const server = createServer(async (request, response) => {
      const url = new URL(request.url || '/', 'http://localhost');
      if (request.method === 'POST' && url.pathname.startsWith('/presence/blob/')) {
        request.resume();
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{}');
        });
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

const server = await createStaticServer();
const address = server.address();
const url = `http://127.0.0.1:${address.port}/scenesync/?dev=1`;
const sogBytes = await readFile(sogFixturePath);
const dracoBytes = createDracoTriangleGlb();
const degree3PlyBytes = buildGaussianSplatPly([{
  position: [0, 0, 0],
  scale: [0.2, 0.1, 0.15],
  rotation: [0, 0, 0, 1],
  opacity: 0.8,
  sh0: [0.2, -0.1, 0.4],
  shRest: Array.from({ length: 45 }, (_, index) => Math.sin(index) * 0.25),
}], { shDegree: 3 });

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__sceneSyncDebug?.renderer?.(), null, {
    timeout: 30000,
  });
  phase = 'sog-import';
  const imported = await page.evaluate(async (bytes) => {
    const file = new File([Uint8Array.from(bytes)], 'ring-gaussian-splats.sog');
    const model = await globalThis.__sceneSyncDebug.dragDropManager.handleFile(file, {
      position: [0, 0, 0],
    });
    return {
      objectId: model?.userData?.objectId || null,
      importedFrom: model?.userData?.importedFrom || null,
    };
  }, Array.from(sogBytes));

  assert(imported.objectId, 'Editor SOG drop did not create an object');
  assert(imported.importedFrom?.sourceFormat === 'sog', 'Editor did not use the SOG normalization path');

  const snapshot = await page.evaluate((objectId) => (
    globalThis.__sceneSyncDebug.objects.get(objectId)
  ), imported.objectId);
  const renderer = await page.evaluate(() => globalThis.__sceneSyncDebug.renderer());
  assert(renderer.renderer === 'WebGPURenderer', 'Editor did not use WebGPURenderer');
  assert(renderer.backend === 'webgl', 'Editor default backend was not WebGL');
  assert(renderer.xrEnabled === true, 'Editor WebXR integration was not enabled');
  assert(snapshot.gaussian?.hasGaussianSplat === true, 'Editor GLB path did not create GaussianSplat');
  assert(snapshot.gaussian?.gaussianObjects === 1, 'Editor Gaussian object count changed');
  assert(snapshot.gaussian?.splatCount === 16, 'Editor did not preserve every SOG splat');
  assert(snapshot.gaussian?.selectionProxy === true, 'Editor did not create a Gaussian bounds selection proxy');
  await page.waitForTimeout(500);

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
  ), imported.objectId, { timeout: 30000 });
  const restored = await page.evaluate((objectId) => (
    globalThis.__sceneSyncDebug.objects.get(objectId)
  ), imported.objectId);
  assert(restored.gaussian?.splatCount === 16, 'Undo did not restore the Gaussian Splat');
  assert(restored.gaussian?.selectionProxy === true, 'Undo did not restore the selection proxy');

  phase = 'redo';
  await page.evaluate(() => globalThis.__sceneSyncDebug.redo());
  await page.waitForFunction((objectId) => (
    !globalThis.__sceneSyncDebug.objects.list().includes(objectId)
  ), imported.objectId, { timeout: 10000 });

  assert(pageErrors.length === 0, `Page errors: ${pageErrors.join('\n')}`);
  assert(invalidOperations.length === 0, `WebGL draw errors: ${invalidOperations.join('\n')}`);
  assert(consoleErrors.length === 0, `Console errors: ${consoleErrors.join('\n')}`);
  console.log(JSON.stringify({
    status: 'passed',
    url,
    renderer,
    objectId: imported.objectId,
    sourceFormat: imported.importedFrom.sourceFormat,
    gaussian: snapshot.gaussian,
    selected: true,
    transformControlsAttached: selected.transformControlsAttached,
    transformed: true,
    visibility: true,
    deleted: true,
    undoRestored: true,
    redoDeleted: true,
    dracoLoaded: true,
    shDegree3Preserved: true,
  }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
