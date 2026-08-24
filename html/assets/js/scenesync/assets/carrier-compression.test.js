import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compressGlbForCarrier,
  decompressGlbFromCarrier,
} from './carrier-compression.js';

test('round-trips a gzip carrier without changing canonical GLB bytes', async () => {
  const source = new Uint8Array(32 * 1024);
  source.set([0x67, 0x6c, 0x54, 0x46]);
  source.fill(7, 4);
  const raw = new Blob([source], { type: 'model/gltf-binary' });

  const compressed = await compressGlbForCarrier(raw, { minBytes: 0 });
  assert.equal(compressed.encoding, 'gzip');
  assert.equal(compressed.compressed, true);
  assert.ok(compressed.carrierSize < compressed.rawSize);

  const restored = await decompressGlbFromCarrier(compressed.blob, {
    encoding: compressed.encoding,
    expectedSize: raw.size,
  });
  assert.equal(restored.type, 'model/gltf-binary');
  assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), source);
});

test('keeps small or unsupported carrier bodies as ordinary GLB', async () => {
  const raw = new Blob([new Uint8Array([0x67, 0x6c, 0x54, 0x46])], {
    type: 'model/gltf-binary',
  });
  const belowThreshold = await compressGlbForCarrier(raw, { minBytes: 8 });
  assert.equal(belowThreshold.encoding, null);
  assert.equal(belowThreshold.blob, raw);

  const unavailable = await compressGlbForCarrier(raw, {
    minBytes: 0,
    CompressionStreamCtor: null,
  });
  assert.equal(unavailable.encoding, null);
  assert.equal(unavailable.blob, raw);
});

test('rejects unknown encodings and decoded size mismatches', async () => {
  const raw = new Blob([new Uint8Array(1024)]);
  await assert.rejects(
    compressGlbForCarrier(raw, { encoding: 'brotli', minBytes: 0 }),
    /Unsupported SceneSync carrier encoding/u,
  );

  const compressed = await compressGlbForCarrier(raw, { minBytes: 0 });
  await assert.rejects(
    decompressGlbFromCarrier(compressed.blob, {
      encoding: compressed.encoding,
      expectedSize: raw.size + 1,
    }),
    /Decoded carrier (?:size mismatch|exceeds)/u,
  );
});
