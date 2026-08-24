// Exercises the Worker entry's message contract directly.
//
// The bundle's `handleConversionMessage` is what a real Worker's listener
// calls, so testing it covers the reply shape, the transfer list and the error
// serialization without needing a Worker at all.

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleConversionMessage } from './gaussian-splat-import.worker.js';
import { inspectGaussianSplatGlb, parseGlbJson } from '../khr-gaussian-splatting.js';
import { buildGaussianSplatPly, buildPointCloudPly } from './test-fixtures.mjs';

const SAMPLE = [
  {
    position: [1, 2, 3],
    scale: [0.1, 0.2, 0.3],
    rotation: [0, 0, 0, 1],
    opacity: 0.75,
    sh0: [1.5, -0.5, 0.25],
  },
  {
    position: [-4, 5, -6],
    scale: [0.05, 0.05, 0.05],
    rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    opacity: 0.25,
    sh0: [-1, 0, 1],
  },
];

function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** Send one message and return its single reply. */
async function request(payload) {
  const posted = [];
  await handleConversionMessage(payload, (data, transfer) => posted.push({ data, transfer }));

  assert.equal(posted.length, 1, 'the worker must post exactly one reply');
  return posted[0];
}

const plyRequest = (overrides = {}) => ({
  id: 'req',
  arrayBuffer: toArrayBuffer(buildGaussianSplatPly(SAMPLE)),
  fileName: 'capture.ply',
  ...overrides,
});

test('the worker converts a PLY payload and reports splat stats', async () => {
  const { data } = await request(plyRequest({ id: 'req-1', upAxisCorrection: 'none' }));

  assert.equal(data.id, 'req-1');
  assert.equal(data.ok, true);
  assert.equal(data.splatCount, 2);
  assert.equal(data.shDegree, 0);
  assert.equal(data.sourceShDegree, 0);
  assert.equal(data.sourceFormat, 'ply');
  assert.equal(inspectGaussianSplatGlb(data.glb).valid, true);
});

test('the worker hands the GLB over instead of copying it', async () => {
  const { data, transfer } = await request(plyRequest({ id: 'req-2' }));

  assert.deepEqual(transfer, [data.glb.buffer], 'the GLB should be handed over, not copied');
  assert.equal(data.glb.byteOffset, 0);
  assert.equal(
    data.glb.byteLength,
    data.glb.buffer.byteLength,
    'transferring a view of a larger slab would move far more than the GLB',
  );
});

test('the worker echoes the request id so replies can be matched', async () => {
  const { data } = await request(plyRequest({ id: 'a-specific-id' }));
  assert.equal(data.id, 'a-specific-id');
});

test('the worker applies upAxisCorrection', async () => {
  const { data } = await request(plyRequest({ id: 'req-3', upAxisCorrection: 'flip-x-180' }));

  assert.equal(data.ok, true);
  const json = parseGlbJson(data.glb);
  assert.deepEqual(json.nodes[json.scenes[json.scene ?? 0].nodes[0]].rotation, [1, 0, 0, 0]);
  assert.equal(inspectGaussianSplatGlb(data.glb).valid, true);
});

test('the worker applies maxShDegree', async () => {
  const shRest = Array.from({ length: 45 }, (_, i) => i / 100);
  const ply = buildGaussianSplatPly([{ ...SAMPLE[0], shRest }], { shDegree: 3 });

  const { data } = await request({
    id: 'req-sh',
    arrayBuffer: toArrayBuffer(ply),
    fileName: 'capture.ply',
    maxShDegree: 1,
  });

  assert.equal(data.shDegree, 1);
  assert.equal(data.sourceShDegree, 3);
});

test('the worker serializes a variant error instead of throwing', async () => {
  const notSplat = buildPointCloudPly([{ position: [0, 0, 0] }]);

  const { data, transfer } = await request({
    id: 'req-4',
    arrayBuffer: toArrayBuffer(notSplat),
    fileName: 'cloud.ply',
  });

  assert.equal(data.ok, false);
  assert.equal(data.error.name, 'UnsupportedSplatInputError');
  assert.equal(data.error.variant, 'not-gaussian-splat');
  assert.deepEqual(transfer, []);
});

test('the worker reports an unrecognized container with the supported list', async () => {
  const { data } = await request({
    id: 'req-5',
    arrayBuffer: new Uint8Array([9, 9, 9, 9]).buffer,
    fileName: 'scan.xyz',
  });

  assert.equal(data.ok, false);
  assert.equal(data.error.variant, 'unknown-format');
  assert.match(data.error.message, /\.ply/);
});

test('an error reply is structuredClone-able', async () => {
  const { data } = await request({
    id: 'req-6',
    arrayBuffer: new Uint8Array([9, 9, 9, 9]).buffer,
    fileName: 'scan.xyz',
  });

  // postMessage clones; an Error subclass would be flattened, so the reply
  // must already be a plain object.
  assert.doesNotThrow(() => structuredClone(data));
});
