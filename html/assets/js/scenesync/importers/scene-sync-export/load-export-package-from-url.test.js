import { test } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { loadExportPackageFromUrl } from './load-export-package-from-url.js';
import {
  MAX_SINGLE_HTML_DOCUMENT_BYTES,
  buildSingleHtmlDocument,
} from '../../../scenesync-export/export/single-html-format.js';

function sceneDocument(extra = {}) {
  return {
    format: 'scene-sync-export-scene',
    version: 2,
    objects: [
      {
        id: 'box-1',
        name: 'Box',
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        asset: { type: 'primitive', primitive: 'box' },
      },
    ],
    ...extra,
  };
}

async function bodyToText(body) {
  if (body instanceof Blob) return await body.text();
  return typeof body === 'string' ? body : JSON.stringify(body);
}

function bodyToBlob(body, contentType) {
  if (body instanceof Blob) return body;
  return new Blob([
    typeof body === 'string' ? body : JSON.stringify(body),
  ], { type: contentType });
}

function response({ url, body, contentType = 'application/json', ok = true, status = 200 }) {
  return {
    ok,
    status,
    url,
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-type' ? contentType : '';
      },
    },
    async text() {
      return await bodyToText(body);
    },
    async blob() {
      return bodyToBlob(body, contentType);
    },
    async arrayBuffer() {
      return await bodyToBlob(body, contentType).arrayBuffer();
    },
  };
}

function createFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);
    const route = routes[href];
    if (!route) {
      return response({ url: href, body: 'not found', ok: false, status: 404 });
    }
    return response({ url: href, ...route });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

async function withFakeJSZip(scene, fn) {
  const original = globalThis.JSZip;
  globalThis.JSZip = {
    async loadAsync() {
      return {
        file(path) {
          if (path === 'scene.json') {
            return {
              async async(type) {
                strictEqual(type, 'string');
                return JSON.stringify(scene);
              },
            };
          }
          return null;
        },
      };
    },
  };

  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete globalThis.JSZip;
    } else {
      globalThis.JSZip = original;
    }
  }
}

test('loads ZIP content from application/zip URLs without requiring a .zip extension', async () => {
  const fetchImpl = createFetch({
    'https://example.com/download?id=123': {
      body: new Blob(['zip-like-bytes'], { type: 'application/zip' }),
      contentType: 'application/zip',
    },
  });

  await withFakeJSZip(sceneDocument({ objects: [{ ...sceneDocument().objects[0], id: 'zip-box' }] }), async () => {
    const result = await loadExportPackageFromUrl('https://example.com/download?id=123', { fetchImpl });

    strictEqual(result.valid, true);
    strictEqual(result.kind, 'zip-url');
    strictEqual(result.sourceUrl, 'https://example.com/download?id=123');
    strictEqual(result.sceneDocument.objects[0].id, 'zip-box');
    deepStrictEqual(fetchImpl.calls, ['https://example.com/download?id=123']);
  });
});

test('loads octet-stream ZIP content when magic bytes start with PK', async () => {
  const fetchImpl = createFetch({
    'https://cdn.example.com/export/abc': {
      body: new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0])], {
        type: 'application/octet-stream',
      }),
      contentType: 'application/octet-stream',
    },
  });

  await withFakeJSZip(sceneDocument({ objects: [{ ...sceneDocument().objects[0], id: 'octet-zip-box' }] }), async () => {
    const result = await loadExportPackageFromUrl('https://cdn.example.com/export/abc', { fetchImpl });

    strictEqual(result.valid, true);
    strictEqual(result.kind, 'zip-url');
    strictEqual(result.sceneDocument.objects[0].id, 'octet-zip-box');
    deepStrictEqual(fetchImpl.calls, ['https://cdn.example.com/export/abc']);
  });
});

test('loads a direct scene.json URL', async () => {
  const fetchImpl = createFetch({
    'https://example.com/world/scene.json': { body: sceneDocument() },
  });

  const result = await loadExportPackageFromUrl('https://example.com/world/scene.json', { fetchImpl });

  strictEqual(result.valid, true);
  strictEqual(result.kind, 'scene-json-url');
  strictEqual(result.baseUrl, 'https://example.com/world/');
  strictEqual(result.sceneDocument.objects[0].id, 'box-1');
});

test('URL loader omits credentials and forwards an AbortSignal for page and marker fetches', async () => {
  const calls = [];
  const controller = new AbortController();
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/index.html')) return response({ url: String(url), body: '<link rel="scene-sync-export" href="scene.json">', contentType: 'text/html' });
    return response({ url: String(url), body: { format: 'scene-sync-export-scene', version: 2, objects: [] } });
  };
  const result = await loadExportPackageFromUrl('https://example.test/index.html', { fetchImpl, signal: controller.signal, maxDocumentBytes: 1024 });
  strictEqual(result.valid, true);
  strictEqual(calls.length, 2);
  for (const call of calls) {
    strictEqual(call.options.credentials, 'omit');
    strictEqual(call.options.signal, controller.signal);
  }
});

test('marks explicit invalid scene.json URLs as blocking generic URL fallback', async () => {
  const fetchImpl = createFetch({
    'https://example.com/world/scene.json': {
      body: {
        format: 'not-scene-sync-export',
        version: 2,
        objects: [],
      },
    },
  });

  const result = await loadExportPackageFromUrl('https://example.com/world/scene.json', { fetchImpl });

  strictEqual(result.valid, false);
  strictEqual(result.reason, 'invalid-scene-document');
  strictEqual(result.shouldBlockGenericImport, true);
  deepStrictEqual(fetchImpl.calls, ['https://example.com/world/scene.json']);
});

test('loads a direct current.json URL through versionPath', async () => {
  const fetchImpl = createFetch({
    'https://example.com/world/current.json': {
      body: { versionPath: 'versions/v4/' },
    },
    'https://example.com/world/versions/v4/scene.json': {
      body: sceneDocument({ objects: [{ ...sceneDocument().objects[0], id: 'box-4' }] }),
    },
  });

  const result = await loadExportPackageFromUrl('https://example.com/world/current.json', { fetchImpl });

  strictEqual(result.valid, true);
  strictEqual(result.kind, 'current-json-url');
  strictEqual(result.baseUrl, 'https://example.com/world/versions/v4/');
  strictEqual(result.sceneDocument.objects[0].id, 'box-4');
});

test('loads a version directory URL by resolving ./scene.json', async () => {
  const fetchImpl = createFetch({
    'https://example.com/worlds/demo/versions/v1/': {
      body: '<!doctype html><title>Demo</title>',
      contentType: 'text/html',
    },
    'https://example.com/worlds/demo/versions/v1/scene.json': { body: sceneDocument() },
  });

  const result = await loadExportPackageFromUrl('https://example.com/worlds/demo/versions/v1/', { fetchImpl });

  strictEqual(result.valid, true);
  strictEqual(result.kind, 'directory-scene-json-url');
  strictEqual(result.baseUrl, 'https://example.com/worlds/demo/versions/v1/');
});

test('loads a stable world URL through current.json versionPath', async () => {
  const fetchImpl = createFetch({
    'https://example.com/worlds/demo/': {
      body: '<!doctype html><title>Demo</title>',
      contentType: 'text/html',
    },
    'https://example.com/worlds/demo/scene.json': {
      body: 'not found',
      ok: false,
      status: 404,
    },
    'https://example.com/worlds/demo/current.json': {
      body: { versionPath: 'versions/v2/' },
    },
    'https://example.com/worlds/demo/versions/v2/scene.json': {
      body: sceneDocument({ objects: [{ ...sceneDocument().objects[0], id: 'box-2' }] }),
    },
  });

  const result = await loadExportPackageFromUrl('https://example.com/worlds/demo/', { fetchImpl });

  strictEqual(result.valid, true);
  strictEqual(result.kind, 'current-json-url');
  strictEqual(result.baseUrl, 'https://example.com/worlds/demo/versions/v2/');
  strictEqual(result.sceneDocument.objects[0].id, 'box-2');
});

test('loads a stable world URL through current.json versionId', async () => {
  const fetchImpl = createFetch({
    'https://example.com/worlds/demo/': {
      body: '<!doctype html><title>Demo</title>',
      contentType: 'text/html',
    },
    'https://example.com/worlds/demo/scene.json': {
      body: 'not found',
      ok: false,
      status: 404,
    },
    'https://example.com/worlds/demo/current.json': {
      body: { versionId: 'v3' },
    },
    'https://example.com/worlds/demo/versions/v3/scene.json': {
      body: sceneDocument(),
    },
  });

  const result = await loadExportPackageFromUrl('https://example.com/worlds/demo/', { fetchImpl });

  strictEqual(result.valid, true);
  strictEqual(result.baseUrl, 'https://example.com/worlds/demo/versions/v3/');
});

test('loads HTML scene-sync-export marker without executing HTML', async () => {
  const fetchImpl = createFetch({
    'https://example.com/worlds/demo/index.html': {
      body: '<!doctype html><link rel="scene-sync-export" href="./data/scene.json"><script>throw new Error("no")</script>',
      contentType: 'text/html',
    },
    'https://example.com/worlds/demo/index.html/scene.json': {
      body: 'not found',
      ok: false,
      status: 404,
    },
    'https://example.com/worlds/demo/index.html/current.json': {
      body: 'not found',
      ok: false,
      status: 404,
    },
    'https://example.com/worlds/demo/data/scene.json': {
      body: sceneDocument(),
    },
  });

  const result = await loadExportPackageFromUrl('https://example.com/worlds/demo/index.html', { fetchImpl });

  strictEqual(result.valid, true);
  strictEqual(result.kind, 'html-marker-url');
  strictEqual(result.baseUrl, 'https://example.com/worlds/demo/data/');
});

test('loads CORS-readable Single HTML URLs and exposes their embedded assets', async () => {
  const html = await buildSingleHtmlDocument({
    sceneDocument: sceneDocument({
      physics: { enabled: true },
      objects: [{
        ...sceneDocument().objects[0],
        id: 'portable-box',
        asset: { type: 'image', path: 'assets/poster.png', mime: 'image/png' },
      }],
    }),
    manifest: { singleHtml: { format: 'single-html-v1', version: 1 } },
    files: { 'assets/poster.png': new Uint8Array([137, 80, 78, 71]).buffer },
    viewerFiles: {},
  });
  const fetchImpl = createFetch({
    'https://cdn.example.com/portable/scene.html': { body: html, contentType: 'text/html' },
  });

  const result = await loadExportPackageFromUrl('https://cdn.example.com/portable/scene.html', { fetchImpl });
  strictEqual(result.valid, true);
  strictEqual(result.kind, 'single-html-url');
  strictEqual(result.sceneDocument.objects[0].id, 'portable-box');
  const asset = await result.zip.file('assets/poster.png').async('arraybuffer');
  deepStrictEqual(Array.from(new Uint8Array(asset)), [137, 80, 78, 71]);
  deepStrictEqual(fetchImpl.calls, ['https://cdn.example.com/portable/scene.html']);
});

test('detects a marked Single HTML payload without a doctype or HTML content type', async () => {
  const payload = JSON.stringify({
    format: 'single-html-v1', version: 1, assets: {}, sceneDocument: sceneDocument(),
  });
  const fetchImpl = createFetch({
    'https://cdn.example.com/portable/raw': {
      body: `<meta name="scene-sync-export-format" content="single-html-v1"><script id="scene-sync-single-html-payload">${payload}</script>`,
      contentType: 'application/octet-stream',
    },
  });
  const result = await loadExportPackageFromUrl('https://cdn.example.com/portable/raw', { fetchImpl });
  strictEqual(result.valid, true);
  strictEqual(result.kind, 'single-html-url');
  strictEqual(result.sceneDocument.objects[0].id, 'box-1');
});

test('reports a clear blocking diagnostic when a Single HTML URL cannot be fetched with CORS', async () => {
  const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
  const result = await loadExportPackageFromUrl('https://cdn.example.com/portable/scene.html', { fetchImpl });
  strictEqual(result.valid, false);
  strictEqual(result.reason, 'single-html-fetch-failed');
  strictEqual(result.shouldBlockGenericImport, true);
});

test('distinguishes Single HTML HTTP failures from CORS or network failures', async () => {
  for (const status of [404, 500]) {
    const fetchImpl = createFetch({
      'https://cdn.example.com/portable.html': { body: 'not found', ok: false, status },
    });
    const result = await loadExportPackageFromUrl('https://cdn.example.com/portable.html', { fetchImpl });
    strictEqual(result.valid, false);
    strictEqual(result.reason, 'single-html-http-error');
    strictEqual(result.status, status);
    strictEqual(result.shouldBlockGenericImport, true);
  }
});

test('rejects an oversized HTML response before converting it to text', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    url: String(url),
    headers: { get: () => 'text/html' },
    async blob() {
      return {
        size: MAX_SINGLE_HTML_DOCUMENT_BYTES + 1,
        text: async () => { throw new Error('oversized payload must not be read'); },
      };
    },
  });
  const result = await loadExportPackageFromUrl('https://cdn.example.com/portable.html', { fetchImpl });
  strictEqual(result.valid, false);
  strictEqual(result.reason, 'single-html-document-too-large');
  strictEqual(result.shouldBlockGenericImport, true);
});

test('returns invalid for non-SceneSync URLs so generic URL handling can continue', async () => {
  const fetchImpl = createFetch({
    'https://example.com/page/': {
      body: '<!doctype html><title>Not Scene Sync</title>',
      contentType: 'text/html',
    },
    'https://example.com/page/scene.json': {
      body: 'not found',
      ok: false,
      status: 404,
    },
    'https://example.com/page/current.json': {
      body: 'not found',
      ok: false,
      status: 404,
    },
  });

  const result = await loadExportPackageFromUrl('https://example.com/page/', { fetchImpl });

  strictEqual(result.valid, false);
  strictEqual(result.reason, 'not-scene-sync-export-url');
  deepStrictEqual(fetchImpl.calls, [
    'https://example.com/page/',
    'https://example.com/page/scene.json',
    'https://example.com/page/current.json',
  ]);
});
