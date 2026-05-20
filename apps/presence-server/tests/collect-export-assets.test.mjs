import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { collectExportAssets } from '../../../html/assets/js/scenesync-export/export/collect-export-assets.js';

function makeSceneDoc(objects = [], skybox = null, bgm = null) {
  return {
    format: 'scene-sync-export-scene',
    version: 1,
    units: 'meters',
    objects,
    skybox,
    bgm,
  };
}

// Minimal fetch mock helper
function mockFetch(responses) {
  const original = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const entry = responses[url];
    if (!entry) {
      return { ok: false, status: 404 };
    }
    if (entry === 'error') {
      throw new Error('network error');
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => entry,
    };
  };

  return () => { globalThis.fetch = original; };
}

test('collectExportAssets', async (t) => {
  await t.test('rewrites mesh asset path to assets/ and returns buffer', async () => {
    const buf = new ArrayBuffer(8);
    const restore = mockFetch({
      'http://localhost:8787/blob/abc123': buf,
    });

    try {
      const doc = makeSceneDoc([{
        id: 'obj-1',
        asset: { type: 'mesh', meshPath: 'abc123', mime: 'model/gltf-binary' },
        position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true,
      }]);

      const result = await collectExportAssets({
        sceneDocument: doc,
        blobBase: 'http://localhost:8787/blob',
        envOrigin: null,
      });

      const obj = result.document.objects[0];
      assert.ok(obj.asset.path.startsWith('assets/'), `expected assets/ path, got: ${obj.asset.path}`);
      assert.ok(obj.asset.path.endsWith('.glb'), `expected .glb extension, got: ${obj.asset.path}`);
      assert.equal(result.missingAssets.length, 0);
      assert.ok(result.files[obj.asset.path]);
    } finally {
      restore();
    }
  });

  await t.test('records missing asset when fetch fails', async () => {
    const restore = mockFetch({});

    try {
      const doc = makeSceneDoc([{
        id: 'obj-missing',
        asset: { type: 'mesh', meshPath: 'no-such-path', mime: 'model/gltf-binary' },
        position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true,
      }]);

      const result = await collectExportAssets({
        sceneDocument: doc,
        blobBase: 'http://localhost:8787/blob',
        envOrigin: null,
      });

      assert.equal(result.missingAssets.length, 1);
      assert.equal(result.missingAssets[0].id, 'obj-missing');
      assert.equal(result.missingAssets[0].reason, 'blob-fetch-and-cache-miss');
    } finally {
      restore();
    }
  });

  await t.test('package generation continues after partial asset failure', async () => {
    const buf = new ArrayBuffer(4);
    const restore = mockFetch({
      'http://localhost:8787/blob/exists': buf,
    });

    try {
      const doc = makeSceneDoc([
        {
          id: 'obj-ok',
          asset: { type: 'mesh', meshPath: 'exists', mime: 'model/gltf-binary' },
          position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true,
        },
        {
          id: 'obj-fail',
          asset: { type: 'mesh', meshPath: 'missing', mime: 'model/gltf-binary' },
          position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true,
        },
      ]);

      const result = await collectExportAssets({
        sceneDocument: doc,
        blobBase: 'http://localhost:8787/blob',
        envOrigin: null,
      });

      assert.equal(result.document.objects.length, 2, 'both objects should be in output');
      assert.equal(result.missingAssets.length, 1);
      assert.equal(result.missingAssets[0].id, 'obj-fail');

      const okObj = result.document.objects.find(o => o.id === 'obj-ok');
      assert.ok(okObj?.asset?.path, 'ok object should have an asset path');
    } finally {
      restore();
    }
  });

  await t.test('passes through primitive objects unchanged', async () => {
    const restore = mockFetch({});

    try {
      const doc = makeSceneDoc([{
        id: 'prim-1',
        asset: { type: 'primitive', primitive: 'box', color: '#ff0000' },
        position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true,
      }]);

      const result = await collectExportAssets({
        sceneDocument: doc,
        blobBase: 'http://localhost:8787/blob',
        envOrigin: null,
      });

      assert.equal(result.missingAssets.length, 0);
      const obj = result.document.objects[0];
      assert.equal(obj.asset.type, 'primitive');
    } finally {
      restore();
    }
  });

  await t.test('rewrites remote asset path to /presence/blob → assets/', async () => {
    const buf = new ArrayBuffer(4);
    const restore = mockFetch({
      'https://example.com/presence/blob/mesh-xyz': buf,
    });

    try {
      const doc = makeSceneDoc([{
        id: 'obj-remote',
        asset: { type: 'mesh', meshPath: 'mesh-xyz', mime: 'model/gltf-binary' },
        position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true,
      }]);

      const result = await collectExportAssets({
        sceneDocument: doc,
        blobBase: 'https://example.com/presence/blob',
        envOrigin: null,
      });

      const obj = result.document.objects[0];
      assert.ok(obj.asset.path.startsWith('assets/'), `path should start with assets/, got: ${obj.asset.path}`);
    } finally {
      restore();
    }
  });

  await t.test('includes assetManifest entries for fetched assets', async () => {
    const buf = new ArrayBuffer(4);
    const restore = mockFetch({
      'http://blob/path1': buf,
    });

    try {
      const doc = makeSceneDoc([{
        id: 'obj-a',
        asset: { type: 'mesh', meshPath: 'path1', mime: 'model/gltf-binary' },
        position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true,
      }]);

      const result = await collectExportAssets({
        sceneDocument: doc,
        blobBase: 'http://blob',
        envOrigin: null,
      });

      assert.equal(result.assetManifest.length, 1);
      assert.equal(result.assetManifest[0].id, 'obj-a');
      assert.equal(result.assetManifest[0].status, 'included');
      assert.equal(result.assetManifest[0].source, 'blob');
    } finally {
      restore();
    }
  });

  await t.test('includes source field in assetManifest', async () => {
    const buf = new ArrayBuffer(4);
    const restore = mockFetch({
      'http://blob/path1': buf,
    });

    try {
      const doc = makeSceneDoc([{
        id: 'obj-a',
        asset: { type: 'mesh', meshPath: 'path1', mime: 'model/gltf-binary' },
        position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true,
      }]);

      const result = await collectExportAssets({
        sceneDocument: doc,
        blobBase: 'http://blob',
        envOrigin: null,
      });

      assert.equal(result.assetManifest[0].source, 'blob');
    } finally {
      restore();
    }
  });

  await t.test('blob fetch success includes assetId in SceneDocument', async () => {
    const buf = new ArrayBuffer(4);
    const restore = mockFetch({
      'http://blob/path1': buf,
    });

    try {
      const doc = makeSceneDoc([{
        id: 'obj-with-id',
        asset: {
          type: 'mesh',
          meshPath: 'path1',
          assetId: 'asset-123',
          mime: 'model/gltf-binary',
        },
        position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true,
      }]);

      const result = await collectExportAssets({
        sceneDocument: doc,
        blobBase: 'http://blob',
        envOrigin: null,
      });

      const obj = result.document.objects[0];
      assert.equal(obj.asset.assetId, undefined, 'assetId should be removed from exported asset');
      assert.ok(obj.asset.path.startsWith('assets/'));
    } finally {
      restore();
    }
  });

  await t.test('IndexedDB fallback by assetId succeeds when blob fetch fails', async () => {
    const restore = mockFetch({});

    try {
      const cachedBlob = new Blob([new ArrayBuffer(8)], { type: 'model/gltf-binary' });
      const mockCache = {
        getByAssetId: async (id) => {
          if (id === 'asset-123') {
            return {
              assetId: 'asset-123',
              meshPath: 'path1',
              blob: cachedBlob,
              mime: 'model/gltf-binary',
              size: 8,
            };
          }
          return null;
        },
        getByMeshPath: async () => null,
      };

      const doc = makeSceneDoc([{
        id: 'obj-cached',
        asset: {
          type: 'mesh',
          meshPath: 'path1',
          assetId: 'asset-123',
          mime: 'model/gltf-binary',
        },
        position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true,
      }]);

      const result = await collectExportAssets({
        sceneDocument: doc,
        blobBase: 'http://blob',
        envOrigin: null,
        assetCache: mockCache,
      });

      assert.equal(result.missingAssets.length, 0, 'no missing assets');
      assert.equal(result.assetManifest.length, 1);
      assert.equal(result.assetManifest[0].status, 'included');
      assert.equal(result.assetManifest[0].source, 'indexeddb');
      assert.ok(result.files[result.document.objects[0].asset.path]);
    } finally {
      restore();
    }
  });

  await t.test('IndexedDB fallback by meshPath succeeds when assetId lookup fails', async () => {
    const restore = mockFetch({});

    try {
      const cachedBlob = new Blob([new ArrayBuffer(12)], { type: 'model/gltf-binary' });
      const mockCache = {
        getByAssetId: async () => null,
        getByMeshPath: async (path) => {
          if (path === 'path1') {
            return {
              assetId: 'asset-123',
              meshPath: 'path1',
              blob: cachedBlob,
              mime: 'model/gltf-binary',
              size: 12,
            };
          }
          return null;
        },
      };

      const doc = makeSceneDoc([{
        id: 'obj-cached-by-path',
        asset: {
          type: 'mesh',
          meshPath: 'path1',
          assetId: 'unknown-id',
          mime: 'model/gltf-binary',
        },
        position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true,
      }]);

      const result = await collectExportAssets({
        sceneDocument: doc,
        blobBase: 'http://blob',
        envOrigin: null,
        assetCache: mockCache,
      });

      assert.equal(result.missingAssets.length, 0);
      assert.equal(result.assetManifest.length, 1);
      assert.equal(result.assetManifest[0].source, 'indexeddb');
    } finally {
      restore();
    }
  });

  await t.test('missing asset recorded with blob-fetch-and-cache-miss when both fail', async () => {
    const restore = mockFetch({});

    try {
      const mockCache = {
        getByAssetId: async () => null,
        getByMeshPath: async () => null,
      };

      const doc = makeSceneDoc([{
        id: 'obj-missing-both',
        asset: {
          type: 'mesh',
          meshPath: 'path1',
          assetId: 'asset-123',
          mime: 'model/gltf-binary',
        },
        position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true,
      }]);

      const result = await collectExportAssets({
        sceneDocument: doc,
        blobBase: 'http://blob',
        envOrigin: null,
        assetCache: mockCache,
      });

      assert.equal(result.missingAssets.length, 1);
      assert.equal(result.missingAssets[0].id, 'obj-missing-both');
      assert.equal(result.missingAssets[0].assetId, 'asset-123');
      assert.equal(result.missingAssets[0].meshPath, 'path1');
      assert.equal(result.missingAssets[0].reason, 'blob-fetch-and-cache-miss');
    } finally {
      restore();
    }
  });

  await t.test('cache fallback gracefully handles cache errors', async () => {
    const restore = mockFetch({});

    try {
      const mockCache = {
        getByAssetId: async () => { throw new Error('IndexedDB error'); },
        getByMeshPath: async () => { throw new Error('IndexedDB error'); },
      };

      const doc = makeSceneDoc([{
        id: 'obj-cache-error',
        asset: {
          type: 'mesh',
          meshPath: 'path1',
          assetId: 'asset-123',
          mime: 'model/gltf-binary',
        },
        position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true,
      }]);

      const result = await collectExportAssets({
        sceneDocument: doc,
        blobBase: 'http://blob',
        envOrigin: null,
        assetCache: mockCache,
      });

      assert.equal(result.missingAssets.length, 1);
      assert.equal(result.missingAssets[0].reason, 'blob-fetch-and-cache-miss');
    } finally {
      restore();
    }
  });

  await t.test('works with null assetCache without error', async () => {
    const buf = new ArrayBuffer(4);
    const restore = mockFetch({
      'http://blob/path1': buf,
    });

    try {
      const doc = makeSceneDoc([{
        id: 'obj-a',
        asset: { type: 'mesh', meshPath: 'path1', assetId: 'asset-123', mime: 'model/gltf-binary' },
        position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true,
      }]);

      const result = await collectExportAssets({
        sceneDocument: doc,
        blobBase: 'http://blob',
        envOrigin: null,
        assetCache: null,
      });

      assert.equal(result.missingAssets.length, 0);
      assert.equal(result.assetManifest.length, 1);
      assert.equal(result.assetManifest[0].source, 'blob');
    } finally {
      restore();
    }
  });
});
