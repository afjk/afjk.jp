import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const htmlRoot = path.join(repoRoot, 'html');
const browserPath = path.join(repoRoot, '.playwright-browsers');

process.env.PLAYWRIGHT_BROWSERS_PATH ||= browserPath;

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

function createWavBuffer() {
  const sampleRate = 8000;
  const durationSeconds = 0.18;
  const samples = Math.floor(sampleRate * durationSeconds);
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * t) * 0x2200);
    buffer.writeInt16LE(sample, 44 + i * 2);
  }
  return buffer;
}

const testAssets = new Map([
  ['url-image.png', { body: PNG_1X1, mime: 'image/png' }],
  ['file-image.png', { body: PNG_1X1, mime: 'image/png' }],
  ['url-text.md', { body: Buffer.from('# URL Text\n\nExport Import E2E\n', 'utf8'), mime: 'text/markdown; charset=utf-8' }],
  ['tone.wav', { body: createWavBuffer(), mime: 'audio/wav' }],
]);

const blobStore = new Map();
const blobUploads = [];

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
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS,HEAD',
    'access-control-allow-headers': 'content-type',
    'content-length': body.byteLength,
    ...headers,
  });
  res.end(body);
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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

    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/presence/blob/')) {
      const key = pathname.slice('/presence/blob/'.length);
      if (req.method === 'POST') {
        const body = await readRequestBody(req);
        const mime = req.headers['content-type'] || 'application/octet-stream';
        blobStore.set(key, { body, mime });
        blobUploads.push({ key, mime, size: body.byteLength });
        sendBuffer(res, 200, Buffer.from(JSON.stringify({ ok: true, path: key })), {
          'content-type': 'application/json; charset=utf-8',
        });
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const record = blobStore.get(key);
        if (!record) {
          sendBuffer(res, 404, Buffer.from('Not found'), { 'content-type': 'text/plain; charset=utf-8' });
          return;
        }
        sendBuffer(res, 200, req.method === 'HEAD' ? Buffer.alloc(0) : record.body, {
          'content-type': record.mime,
          ...(req.method === 'HEAD' ? { 'content-length': record.body.byteLength } : {}),
        });
        return;
      }
    }

    if (pathname.startsWith('/__e2e/assets/')) {
      const name = pathname.slice('/__e2e/assets/'.length);
      if (req.method === 'POST') {
        const body = await readRequestBody(req);
        const mime = req.headers['content-type'] || 'application/octet-stream';
        testAssets.set(name, { body, mime });
        sendBuffer(res, 200, Buffer.from(JSON.stringify({ ok: true, name })), {
          'content-type': 'application/json; charset=utf-8',
        });
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const record = testAssets.get(name);
        if (!record) {
          sendBuffer(res, 404, Buffer.from('Not found'), { 'content-type': 'text/plain; charset=utf-8' });
          return;
        }
        sendBuffer(res, 200, req.method === 'HEAD' ? Buffer.alloc(0) : record.body, {
          'content-type': record.mime,
          ...(req.method === 'HEAD' ? { 'content-length': record.body.byteLength } : {}),
        });
        return;
      }
    }

    if (pathname.startsWith('/__e2e/blob/')) {
      const key = pathname.slice('/__e2e/blob/'.length);
      if (req.method === 'DELETE' || req.method === 'POST') {
        const deleted = blobStore.delete(key);
        sendBuffer(res, 200, Buffer.from(JSON.stringify({ ok: true, deleted, key })), {
          'content-type': 'application/json; charset=utf-8',
        });
        return;
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendBuffer(res, 405, Buffer.from('Method not allowed'), { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }

    const filePath = resolveStaticPath(req.url || '/');
    if (!filePath) {
      sendBuffer(res, 400, Buffer.from('Bad request'), { 'content-type': 'text/plain; charset=utf-8' });
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
      sendBuffer(res, 404, Buffer.from('Not found'), { 'content-type': 'text/plain; charset=utf-8' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function serverUrl(server) {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Static server did not expose a TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function summarizeConsole(consoleMessages) {
  return consoleMessages.filter((entry) => {
    if (/GL Driver Message .*ReadPixels/.test(entry.text)) return false;
    if (/BGM.*autoplay blocked/.test(entry.text)) return false;
    if (/THREE\.GLTFExporter: Creating normalized normal attribute/.test(entry.text)) return false;
    if (/Failed to load resource: the server responded with a status of 404/.test(entry.text)) return false;
    if (/TransformControls: The attached 3D object must be a part of the scene graph/.test(entry.text)) return false;
    return true;
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run() {
  const { chromium } = await import('playwright');
  const server = await createStaticServer();
  const baseUrl = serverUrl(server);
  const result = {
    url: `${baseUrl}/scenesync/?room=e2e-export-import-${Date.now()}`,
    console: [],
    pageErrors: [],
    assertions: [],
  };

  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1280, height: 900 },
    });

    await context.addInitScript(() => {
      localStorage.setItem('sceneSync.welcomeSeen', 'true');
      localStorage.setItem('sceneSync.displayName', 'SceneSync E2E');
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
    page.on('dialog', async (dialog) => {
      result.assertions.push(`dialog:${dialog.type()}`);
      await dialog.accept();
    });

    await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#export-btn', { state: 'visible', timeout: 60000 });
    await page.waitForFunction(() => window.__sceneSyncDebug?.dragDropManager, null, { timeout: 60000 });
    await page.waitForFunction(
      () => document.querySelector('canvas') && document.querySelector('canvas').width > 0,
      null,
      { timeout: 60000 },
    );

    // Product-default Auto should choose a portable Single HTML for a small,
    // fully embeddable scene before this test seeds its ZIP-import fixture.
    const autoDownloadPromise = page.waitForEvent('download', { timeout: 120000 });
    await page.locator('#export-btn').click();
    await page.locator('#export-dialog:not([hidden])').waitFor({ state: 'visible' });
    assert(await page.locator('#export-format-input').inputValue() === 'auto', 'Auto must be the default export format');
    await page.locator('#export-submit').click();
    const autoDownload = await autoDownloadPromise;
    const autoPath = await autoDownload.path();
    assert(autoPath, 'Auto download path unavailable');
    const autoHtml = await readFile(autoPath, 'utf8');
    assert(/\.html$/i.test(autoDownload.suggestedFilename()), 'Auto small scene should download Single HTML');
    assert(/meta name="scene-sync-export-format" content="single-html-v1"/.test(autoHtml), 'Auto download lacks Single HTML marker');
    await page.locator('#toast.show').waitFor({ state: 'visible' });
    assert(/出力: Single HTML/.test(await page.locator('#toast').textContent()), 'Auto result toast should name its selected format');
    result.autoDownload = { suggested: autoDownload.suggestedFilename(), marker: 'single-html-v1' };

    const seeded = await page.evaluate(async ({ baseUrl }) => {
      const mod = await import('/assets/js/scenesync/scene.js');
      const THREE = await import('three');
      const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
      const { createSceneAssetCache } = await import('/assets/js/scenesync/assets/asset-cache.js');
      window.__sceneSyncE2eModule = mod;

      const dragDropManager = window.__sceneSyncDebug.dragDropManager;
      const cache = createSceneAssetCache();
      const positionContext = (x, y, z) => ({
        position: new THREE.Vector3(x, y, z),
        targetKind: 'scene',
        surfaceKind: 'floor',
        normalArray: [0, 1, 0],
      });
      const findBy = (predicate) => {
        for (const [objectId, obj] of mod.managedObjects.entries()) {
          if (predicate(obj, objectId)) return { objectId, obj };
        }
        return null;
      };
      const waitForObject = async (predicate, label) => {
        const started = performance.now();
        while (performance.now() - started < 20000) {
          const found = findBy(predicate);
          if (found) return found;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const current = Array.from(mod.managedObjects.entries()).map(([objectId, obj]) => ({
          objectId,
          name: obj.userData?.name || obj.name || null,
          asset: obj.userData?.asset || null,
          metadata: obj.userData?.metadata || null,
        }));
        throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(current)}`);
      };
      const waitForMeshAsset = async (objectId) => {
        const started = performance.now();
        while (performance.now() - started < 20000) {
          const obj = mod.managedObjects.get(objectId);
          const asset = obj?.userData?.asset;
          if (asset?.type === 'mesh' && asset.meshPath && asset.assetId) {
            return { objectId, asset };
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`Timed out waiting for mesh upload ${objectId}`);
      };
      const makePngFile = async (name) => {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 48;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#2c7be5';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffdd55';
        ctx.fillRect(10, 8, 36, 24);
        const blob = await new Promise((resolve, reject) => {
          canvas.toBlob((value) => value ? resolve(value) : reject(new Error('canvas.toBlob failed')), 'image/png');
        });
        return new File([blob], name, { type: 'image/png' });
      };
      const makeGlbBlob = async (name, color) => {
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.4, 0.4, 0.4),
          new THREE.MeshStandardMaterial({ color }),
        );
        mesh.name = name;
        const exporter = new GLTFExporter();
        const arrayBuffer = await new Promise((resolve, reject) => {
          exporter.parse(mesh, resolve, reject, { binary: true });
        });
        return new Blob([arrayBuffer], { type: 'model/gltf-binary' });
      };
      const makeVideoBlob = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        const stream = canvas.captureStream(10);
        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
          ? 'video/webm;codecs=vp8'
          : 'video/webm';
        const recorder = new MediaRecorder(stream, { mimeType });
        const chunks = [];
        recorder.addEventListener('dataavailable', (event) => {
          if (event.data?.size) chunks.push(event.data);
        });
        recorder.start();
        for (let i = 0; i < 8; i += 1) {
          ctx.fillStyle = i % 2 ? '#3366ff' : '#ffcc33';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#101010';
          ctx.fillRect(8 + i, 8 + i, 20, 20);
          await new Promise((resolve) => setTimeout(resolve, 70));
        }
        await new Promise((resolve) => {
          recorder.addEventListener('stop', resolve, { once: true });
          recorder.stop();
        });
        stream.getTracks().forEach((track) => track.stop());
        return new Blob(chunks, { type: 'video/webm' });
      };
      const uploadTestAsset = async (name, blob) => {
        const response = await fetch(`/__e2e/assets/${name}`, {
          method: 'POST',
          headers: { 'Content-Type': blob.type || 'application/octet-stream' },
          body: blob,
        });
        if (!response.ok) throw new Error(`Failed to upload test asset ${name}`);
        return `${baseUrl}/__e2e/assets/${name}`;
      };

      for (const obj of mod.managedObjects.values()) {
        mod.scene.remove(obj);
      }
      mod.managedObjects.clear();

      const seededObjects = {};

      const primitive = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: 0xff3355 }),
      );
      primitive.position.set(1.25, 0.75, -0.5);
      primitive.scale.set(1.1, 1.2, 1.3);
      primitive.name = 'E2E Primitive';
      primitive.userData.objectId = 'e2e-primitive';
      primitive.userData.name = 'E2E Primitive';
      primitive.userData.asset = { type: 'primitive', primitive: 'box', color: '#ff3355' };
      primitive.userData.metadata = { e2e: true, role: 'prop' };
      mod.scene.add(primitive);
      mod.managedObjects.set('e2e-primitive', primitive);
      seededObjects.primitive = 'e2e-primitive';

      await uploadTestAsset('url-image.png', await makePngFile('url-image.png'));
      await dragDropManager.urlImporter(
        `${baseUrl}/__e2e/assets/url-image.png`,
        new THREE.Vector3(-1, 1, 0),
        { surfaceKind: 'floor', normalArray: [0, 1, 0] },
      );
      seededObjects.urlImage = (await waitForObject(
        (obj) => obj.userData?.asset?.type === 'image' && obj.userData.asset.url?.endsWith('/url-image.png'),
        'URL image object',
      )).objectId;

      const imageFile = await makePngFile('e2e-file-image.png');
      await dragDropManager.handleFile(imageFile, positionContext(-2, 1, 0));
      seededObjects.fileImage = (await waitForObject(
        (obj) => obj.userData?.asset?.type === 'image' && obj.userData?.name === 'image: e2e-file-image.png',
        'file image object',
      )).objectId;

      await dragDropManager.urlImporter(
        `${baseUrl}/__e2e/assets/url-text.md`,
        new THREE.Vector3(0, 1, 0.5),
        { surfaceKind: 'floor', normalArray: [0, 1, 0] },
      );
      seededObjects.urlText = (await waitForObject(
        (obj) => obj.userData?.asset?.type === 'text' && obj.userData.asset.url?.endsWith('/url-text.md'),
        'URL text object',
      )).objectId;

      const textFile = new File(['File text E2E\n'], 'e2e-file-text.md', { type: 'text/markdown' });
      await dragDropManager.handleFile(textFile, positionContext(0.5, 1, 0.5));
      seededObjects.fileText = (await waitForObject(
        (obj) => obj.userData?.asset?.type === 'text' && obj.userData.asset.text === 'File text E2E\n',
        'file text object',
      )).objectId;

      const videoUrl = await uploadTestAsset('url-video.webm', await makeVideoBlob());
      await dragDropManager.urlImporter(
        videoUrl,
        new THREE.Vector3(1.5, 1, 0),
        { surfaceKind: 'floor', normalArray: [0, 1, 0] },
      );
      seededObjects.urlVideo = (await waitForObject(
        (obj) => obj.userData?.asset?.type === 'video' && obj.userData.asset.url?.endsWith('/url-video.webm'),
        'URL video object',
      )).objectId;

      await dragDropManager.urlImporter(
        `${baseUrl}/__e2e/assets/tone.wav`,
        new THREE.Vector3(0, 1, 0),
        { hitObjectId: 'e2e-primitive' },
      );
      await waitForObject(
        (obj, id) => id === 'e2e-primitive' && obj.userData?.audioSources?.default?.url?.endsWith('/tone.wav'),
        'object audio source',
      );

      await dragDropManager.urlImporter(
        `${baseUrl}/__e2e/assets/tone.wav`,
        new THREE.Vector3(3, 1, 0),
        { surfaceKind: 'floor', normalArray: [0, 1, 0] },
      );

      await dragDropManager.urlImporter(
        `${baseUrl}/__e2e/assets/url-image.png`,
        new THREE.Vector3(0, 2, -2),
        { upness: 1, targetKind: 'sky' },
      );
      const urlSkyboxObject = await waitForObject(
        (obj) => obj.userData?.metadata?.role === 'sky-sphere'
          && obj.userData?.metadata?.sourceName === 'url-image.png',
        'URL skybox image object',
      );
      seededObjects.urlSkyImageReplaced = urlSkyboxObject.objectId;

      const skyboxFile = await makePngFile('e2e-file-skybox.png');
      await dragDropManager.handleFile(skyboxFile, {
        ...positionContext(0, 2, -2),
        targetKind: 'sky',
        upness: 1,
      });
      seededObjects.fileSkyImage = (await waitForObject(
        (obj, id) => id !== urlSkyboxObject.objectId
          && obj.userData?.metadata?.role === 'sky-sphere'
          && obj.userData?.metadata?.sourceName === 'e2e-file-skybox.png',
        'file skybox image object',
      )).objectId;

      const urlGlbBlob = await makeGlbBlob('e2e-url-model', 0x33dd99);
      const urlGlb = await uploadTestAsset('url-model.glb', urlGlbBlob);
      await dragDropManager.urlImporter(
        urlGlb,
        new THREE.Vector3(-1.5, 0, -1),
        { surfaceKind: 'floor', normalArray: [0, 1, 0] },
      );
      seededObjects.urlGlb = (await waitForObject(
        (obj) => obj.userData?.asset?.type === 'mesh' && obj.userData.asset.url?.endsWith('/url-model.glb'),
        'URL GLB object',
      )).objectId;

      const fileGlb = new File(
        [await makeGlbBlob('e2e-file-model', 0xdd9933)],
        'e2e-file-model.glb',
        { type: 'model/gltf-binary' },
      );
      await dragDropManager.handleFile(fileGlb, positionContext(2, 0, -1));
      const fileGlbObject = await waitForObject(
        (obj) => obj.userData?.asset?.type === 'mesh' && obj.userData.asset.originalName === 'e2e-file-model.glb',
        'file GLB object',
      );
      seededObjects.fileGlb = fileGlbObject.objectId;
      const fileGlbAsset = await waitForMeshAsset(fileGlbObject.objectId);
      await fetch(`/__e2e/blob/${fileGlbAsset.asset.meshPath}`, { method: 'DELETE' });
      seededObjects.fileGlbMeshPathDeletedBeforeExport = fileGlbAsset.asset.meshPath;
      seededObjects.fileGlbAssetId = fileGlbAsset.asset.assetId;

      return {
        objects: seededObjects,
        objectIds: Array.from(mod.managedObjects.keys()).sort(),
        summary: Array.from(mod.managedObjects.entries()).map(([objectId, obj]) => ({
          objectId,
          name: obj.userData?.name || obj.name || objectId,
          asset: obj.userData?.asset || null,
          audioSources: obj.userData?.audioSources || null,
          metadata: obj.userData?.metadata || null,
        })).sort((a, b) => a.objectId.localeCompare(b.objectId)),
      };
    }, { baseUrl });
    result.seeded = seeded;
    result.assertions.push(`seeded:${seeded.objectIds.length}`);

    const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
    await page.locator('#export-btn').click();
    await page.locator('#export-dialog:not([hidden])').waitFor({ state: 'visible' });
    // This regression test inspects a Static ZIP. Auto is the product default,
    // so keep the test explicit about the artifact it validates.
    await page.locator('#export-format-input').selectOption('static-zip');
    await page.locator('#export-submit').click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    assert(downloadPath, 'Download path unavailable');
    result.download = {
      suggested: download.suggestedFilename(),
    };

    const zipBuffer = await readFile(downloadPath);
    const zipInspect = await page.evaluate(async (base64) => {
      if (!window.JSZip) {
        throw new Error('JSZip not available after export');
      }
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const zip = await window.JSZip.loadAsync(bytes);
      const files = Object.keys(zip.files).sort();
      const sceneJson = JSON.parse(await zip.file('scene.json').async('string'));
      const manifestJson = JSON.parse(await zip.file('manifest.json').async('string'));
      return {
        fileCount: files.length,
        files,
        hasIndex: files.includes('index.html'),
        hasScene: files.includes('scene.json'),
        hasManifest: files.includes('manifest.json'),
        hasViewer: files.includes('viewer/viewer.js'),
        hasLoomletRuntime: files.includes('viewer/loomlet/loomlet-scenesync-runtime.browser.js'),
        objectIds: (sceneJson.objects || []).map((o) => o.id).sort(),
        objects: sceneJson.objects || [],
        bgm: sceneJson.bgm || null,
        skybox: sceneJson.skybox || null,
        assetManifest: manifestJson.assets || manifestJson.assetManifest || [],
        missingAssets: manifestJson.missingAssets || [],
      };
    }, zipBuffer.toString('base64'));
    result.zipInspect = {
      fileCount: zipInspect.fileCount,
      hasIndex: zipInspect.hasIndex,
      hasScene: zipInspect.hasScene,
      hasManifest: zipInspect.hasManifest,
      hasViewer: zipInspect.hasViewer,
      hasLoomletRuntime: zipInspect.hasLoomletRuntime,
      objectIds: zipInspect.objectIds,
      assetManifest: zipInspect.assetManifest,
      missingAssets: zipInspect.missingAssets,
      bgm: zipInspect.bgm,
      skybox: zipInspect.skybox,
    };

    assert(zipInspect.hasIndex, 'Export ZIP missing index.html');
    assert(zipInspect.hasScene, 'Export ZIP missing scene.json');
    assert(zipInspect.hasManifest, 'Export ZIP missing manifest.json');
    assert(zipInspect.hasViewer, 'Export ZIP missing viewer/viewer.js');
    assert(zipInspect.hasLoomletRuntime, 'Export ZIP missing Loomlet runtime');
    assert(zipInspect.missingAssets.length === 0, `Export had missing assets: ${JSON.stringify(zipInspect.missingAssets)}`);

    const byId = new Map(zipInspect.objects.map((obj) => [obj.id, obj]));
    const seededIds = seeded.objects;
    for (const [label, objectId] of Object.entries(seededIds)) {
      if (label.endsWith('DeletedBeforeExport') || label.endsWith('AssetId')) continue;
      if (label === 'urlSkyImageReplaced') continue;
      assert(byId.has(objectId), `scene.json missing seeded object ${label}:${objectId}`);
    }
    assert(!byId.has(seededIds.urlSkyImageReplaced), 'replaced URL skybox object should not remain in scene.json');
    assert(byId.get(seededIds.primitive)?.audioSources?.default?.asset?.path, 'object audio source was not bundled');
    assert(zipInspect.bgm?.asset?.path, 'BGM was not bundled');
    assert(byId.get(seededIds.urlImage)?.asset?.path, 'URL image was not bundled');
    assert(byId.get(seededIds.fileImage)?.asset?.path, 'file image blob was not bundled');
    assert(byId.get(seededIds.urlText)?.asset?.path, 'URL text was not bundled');
    assert(byId.get(seededIds.urlVideo)?.asset?.path, 'URL video was not bundled');
    assert(byId.get(seededIds.fileSkyImage)?.asset?.path, 'file skybox image mesh was not bundled');
    assert(byId.get(seededIds.urlGlb)?.asset?.path, 'URL GLB was not bundled');
    assert(byId.get(seededIds.fileGlb)?.asset?.path, 'file GLB IndexedDB fallback was not bundled');
    assert(
      zipInspect.assetManifest.some((entry) => entry.id === seededIds.fileGlb && entry.source === 'indexeddb'),
      'file GLB did not export from IndexedDB fallback',
    );
    result.assertions.push('export-zip-all-assets-ok');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const cleared = await page.evaluate(() => {
      const mod = window.__sceneSyncE2eModule;
      for (const obj of mod.managedObjects.values()) {
        mod.scene.remove(obj);
      }
      mod.managedObjects.clear();
      return mod.managedObjects.size;
    });
    assert(cleared === 0, 'Could not clear scene before import');
    result.assertions.push('cleared-before-import');

    const uploadsBeforeImport = blobUploads.length;
    await page.setInputFiles('#file-input', {
      name: result.download.suggested,
      mimeType: 'application/zip',
      buffer: zipBuffer,
    });

    await page.waitForFunction(
      ({ expectedIds }) => {
        const mod = window.__sceneSyncE2eModule;
        if (!mod) return false;
        return expectedIds.every((objectId) => {
          const obj = mod.managedObjects.get(objectId);
          return obj && obj.userData?.metadata?.importPreview !== true;
        });
      },
      { expectedIds: zipInspect.objectIds },
      { timeout: 90000 },
    );
    await page.waitForTimeout(1000);

    const imported = await page.evaluate(({ expectedIds }) => {
      const mod = window.__sceneSyncE2eModule;
      return expectedIds.map((objectId) => {
        const obj = mod.managedObjects.get(objectId);
        return {
          objectId,
          name: obj?.userData?.name || obj?.name || null,
          asset: obj?.userData?.asset || null,
          audioSources: obj?.userData?.audioSources || null,
          metadata: obj?.userData?.metadata || null,
          position: obj?.position?.toArray?.() || null,
          scale: obj?.scale?.toArray?.() || null,
          visible: obj?.visible ?? null,
        };
      }).sort((a, b) => a.objectId.localeCompare(b.objectId));
    }, { expectedIds: zipInspect.objectIds });
    result.imported = imported;

    const importedById = new Map(imported.map((obj) => [obj.objectId, obj]));
    const expectBlobUrl = (url, label) => {
      assert(typeof url === 'string' && url.includes('/presence/blob/'), `${label} did not resolve to presence blob URL: ${url}`);
    };

    assert(importedById.get(seededIds.primitive)?.asset?.type === 'primitive', 'primitive import mismatch');
    expectBlobUrl(importedById.get(seededIds.primitive)?.audioSources?.default?.url, 'object audio source');
    assert(importedById.get(seededIds.fileText)?.asset?.text === 'File text E2E\n', 'file text import mismatch');
    expectBlobUrl(importedById.get(seededIds.urlText)?.asset?.url, 'URL text import');
    expectBlobUrl(importedById.get(seededIds.urlImage)?.asset?.url, 'URL image import');
    expectBlobUrl(importedById.get(seededIds.fileImage)?.asset?.url, 'file image import');
    expectBlobUrl(importedById.get(seededIds.urlVideo)?.asset?.url, 'URL video import');
    assert(importedById.get(seededIds.urlGlb)?.asset?.type === 'mesh', 'URL GLB import did not produce mesh asset');
    assert(importedById.get(seededIds.urlGlb)?.asset?.meshPath, 'URL GLB import missing meshPath after re-upload');
    assert(importedById.get(seededIds.fileGlb)?.asset?.type === 'mesh', 'file GLB import did not produce mesh asset');
    assert(importedById.get(seededIds.fileGlb)?.asset?.meshPath, 'file GLB import missing meshPath after re-upload');
    assert(importedById.get(seededIds.fileSkyImage)?.asset?.type === 'mesh', 'file skybox image import did not produce mesh asset');
    assert(importedById.get(seededIds.fileSkyImage)?.asset?.meshPath, 'file skybox image import missing meshPath after re-upload');
    assert(blobUploads.length > uploadsBeforeImport, 'Scene Sync Export import did not upload ZIP-bundled assets');
    result.blobUploads = {
      total: blobUploads.length,
      duringImport: blobUploads.slice(uploadsBeforeImport),
    };
    result.assertions.push('import-all-assets-ok');

    result.console = summarizeConsole(result.console);
    result.status = 'passed';
    return result;
  } finally {
    if (browser) await browser.close();
    await closeServer(server);
  }
}

try {
  const result = await run();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  if (/Executable doesn't exist|browserType\.launch/.test(String(error?.message || error))) {
    console.error(`\nInstall the local Chromium binary with:\n  npm run test:e2e:install-browsers`);
  }
  process.exitCode = 1;
}
