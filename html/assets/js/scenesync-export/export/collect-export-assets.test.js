import assert from 'node:assert/strict';
import test from 'node:test';

import { compressGlbForCarrier } from '../../scenesync/assets/carrier-compression.js';
import { collectExportAssets } from './collect-export-assets.js';

test('decodes a gzip mesh carrier before writing an ordinary GLB export asset', async (t) => {
  const rawBytes = new Uint8Array(32 * 1024);
  rawBytes.set([0x67, 0x6c, 0x54, 0x46]);
  rawBytes.fill(5, 4);
  const compressed = await compressGlbForCarrier(
    new Blob([rawBytes], { type: 'model/gltf-binary' }),
    { minBytes: 0 },
  );
  assert.equal(compressed.encoding, 'gzip');

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://scene.test/blob/carrier-1');
    return new Response(compressed.blob, {
      status: 200,
      headers: { 'content-type': 'application/gzip' },
    });
  };

  const result = await collectExportAssets({
    sceneDocument: {
      objects: [{
        id: 'splat-1',
        asset: {
          type: 'mesh',
          source: 'carrier',
          meshPath: 'carrier-1',
          assetId: 'sha256-splat',
          size: rawBytes.byteLength,
          carrierEncoding: 'gzip',
          carrierSize: compressed.carrierSize,
          mime: 'model/gltf-binary',
          originalName: 'capture.glb',
        },
      }],
      skybox: null,
      bgm: null,
    },
    blobBase: 'https://scene.test/blob',
    envOrigin: null,
  });

  const outputPath = 'assets/capture.glb';
  assert.deepEqual(new Uint8Array(result.files[outputPath]), rawBytes);
  assert.equal(result.document.objects[0].asset.path, outputPath);
  assert.equal(Object.hasOwn(result.document.objects[0].asset, 'carrierEncoding'), false);
  assert.equal(Object.hasOwn(result.document.objects[0].asset, 'carrierSize'), false);
  assert.equal(result.missingAssets.length, 0);
});

test('falls back to the raw IndexedDB GLB when a compressed carrier cannot be decoded', async (t) => {
  const rawBytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });

  const result = await collectExportAssets({
    sceneDocument: {
      objects: [{
        id: 'splat-cache',
        asset: {
          type: 'mesh',
          source: 'carrier',
          meshPath: 'broken-gzip',
          assetId: 'sha256-cache',
          size: rawBytes.byteLength,
          carrierEncoding: 'gzip',
          carrierSize: 3,
          mime: 'model/gltf-binary',
          originalName: 'cached.glb',
        },
      }],
      skybox: null,
      bgm: null,
    },
    blobBase: 'https://scene.test/blob',
    envOrigin: null,
    assetCache: {
      async getByAssetId() {
        return {
          blob: new Blob([rawBytes], { type: 'model/gltf-binary' }),
          mime: 'model/gltf-binary',
        };
      },
    },
  });

  assert.deepEqual(new Uint8Array(result.files['assets/cached.glb']), rawBytes);
  assert.equal(result.assetManifest[0].source, 'indexeddb');
  assert.equal(result.missingAssets.length, 0);
  assert.equal(warnings.length, 1);
});
