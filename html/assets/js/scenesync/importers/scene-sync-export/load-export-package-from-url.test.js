import { test } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { loadExportPackageFromUrl } from './load-export-package-from-url.js';

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
      return typeof body === 'string' ? body : JSON.stringify(body);
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
