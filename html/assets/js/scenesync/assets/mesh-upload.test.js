import test from 'node:test';
import assert from 'node:assert/strict';

import { uploadLocalMeshAsset } from './mesh-upload.js';

test('mesh upload and asset preparation do not wait for a pending IndexedDB write', async () => {
  const events = [];
  let finishCache;
  const pendingCache = new Promise((resolve) => { finishCache = resolve; });
  const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46]).buffer;

  const result = await uploadLocalMeshAsset({
    arrayBuffer: bytes,
    name: 'capture.glb',
    meshPath: 'mesh-1',
    blobBase: 'https://scene.test/blob',
    computeAssetId: async () => 'sha256-capture',
    putCachedAsset: () => {
      events.push('cache-started');
      return pendingCache;
    },
    onAssetPrepared: (asset) => events.push(`prepared:${asset.assetId}`),
    fetchImpl: async (url, options) => {
      events.push(`uploaded:${url}`);
      assert.equal(options.method, 'POST');
      assert.equal(options.body, bytes);
      return { ok: true, status: 201 };
    },
  });

  assert.deepEqual(events, [
    'prepared:sha256-capture',
    'cache-started',
    'uploaded:https://scene.test/blob/mesh-1',
  ]);
  assert.deepEqual(result.asset, {
    type: 'mesh',
    source: 'carrier',
    assetId: 'sha256-capture',
    meshPath: 'mesh-1',
    size: 4,
    mime: 'model/gltf-binary',
    originalName: 'capture.glb',
  });

  finishCache();
});

test('cache failure is reported but does not reject a successful mesh upload', async () => {
  const cacheErrors = [];
  const result = await uploadLocalMeshAsset({
    arrayBuffer: new ArrayBuffer(12),
    meshPath: 'mesh-2',
    blobBase: 'https://scene.test/blob',
    computeAssetId: async () => 'sha256-mesh-2',
    putCachedAsset: async () => { throw new Error('quota exceeded'); },
    onCacheError: (error, context) => cacheErrors.push(`${context.phase}:${error.message}`),
    fetchImpl: async () => ({ ok: true, status: 201 }),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(result.asset.assetId, 'sha256-mesh-2');
  assert.deepEqual(cacheErrors, ['asset-cache:quota exceeded']);
});

test('upload failure still exposes prepared metadata for local snapshot recovery', async () => {
  let prepared = null;
  await assert.rejects(
    uploadLocalMeshAsset({
      arrayBuffer: new ArrayBuffer(8),
      name: 'offline.glb',
      meshPath: 'mesh-offline',
      blobBase: 'https://scene.test/blob',
      computeAssetId: async () => 'sha256-offline',
      putCachedAsset: async () => {},
      onAssetPrepared: (asset) => { prepared = asset; },
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        async json() { return { message: 'temporarily unavailable' }; },
      }),
    }),
    /temporarily unavailable/u,
  );

  assert.equal(prepared.assetId, 'sha256-offline');
  assert.equal(prepared.meshPath, 'mesh-offline');
});
