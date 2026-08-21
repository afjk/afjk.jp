// Exercises the real worker module by giving it a `self` to attach to, so the
// message contract is verified rather than only the client that talks to it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { inspectGaussianSplatGlb } from '../khr-gaussian-splatting.js';
import { buildGaussianSplatPly } from './test-fixtures.mjs';

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

// The worker registers its listener on import, and ES modules are only
// evaluated once, so the shim is installed and the module imported a single
// time for the whole file.
let messageHandler = null;
const posted = [];

globalThis.self = {
  addEventListener(type, fn) {
    if (type === 'message') messageHandler = fn;
  },
  postMessage(data, transfer) {
    posted.push({ data, transfer });
  },
};

await import('./gaussian-splat-import.worker.js');

/** Send one message to the worker and return its single reply. */
async function request(payload) {
  assert.ok(messageHandler, 'worker module must register a message listener');
  posted.length = 0;

  await messageHandler({ data: payload });
  // The handler is async; let its continuation run before reading the reply.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(posted.length, 1, 'worker must post exactly one reply');
  return posted[0];
}

test('worker converts a PLY payload and reports splat stats', async () => {
  const source = toArrayBuffer(buildGaussianSplatPly(SAMPLE));

  const { data } = await request({
    id: 'req-1',
    arrayBuffer: source,
    fileName: 'capture.ply',
    upAxisCorrection: 'none',
  });

  assert.equal(data.id, 'req-1');
  assert.equal(data.ok, true);
  assert.equal(data.splatCount, 2);
  assert.equal(data.shDegree, 0);
  assert.equal(data.sourceFormat, 'ply');
  assert.equal(inspectGaussianSplatGlb(data.glb).valid, true);
});

test('worker marks the GLB buffer as transferable', async () => {
  const source = toArrayBuffer(buildGaussianSplatPly(SAMPLE));

  const { data, transfer } = await request({
    id: 'req-2',
    arrayBuffer: source,
    fileName: 'capture.ply',
  });

  assert.deepEqual(transfer, [data.glb.buffer], 'the GLB should be handed over, not copied');
});

test('worker echoes the request id so replies can be matched', async () => {

  const { data } = await request({
    id: 'a-specific-id',
    arrayBuffer: toArrayBuffer(buildGaussianSplatPly(SAMPLE)),
    fileName: 'capture.ply',
  });

  assert.equal(data.id, 'a-specific-id');
});

test('worker applies upAxisCorrection', async () => {

  const { data } = await request({
    id: 'req-3',
    arrayBuffer: toArrayBuffer(buildGaussianSplatPly(SAMPLE)),
    fileName: 'capture.ply',
    upAxisCorrection: 'flip-x-180',
  });

  assert.equal(data.ok, true);
  assert.equal(inspectGaussianSplatGlb(data.glb).valid, true);
});

test('worker serializes a variant error instead of throwing', async () => {
  const notSplat = new TextEncoder().encode([
    'ply', 'format ascii 1.0', 'element vertex 1',
    'property float x', 'property float y', 'property float z',
    'end_header', '0 0 0', '',
  ].join('\n'));

  const { data } = await request({
    id: 'req-4',
    arrayBuffer: toArrayBuffer(notSplat),
    fileName: 'cloud.ply',
  });

  assert.equal(data.ok, false);
  assert.equal(data.error.name, 'UnsupportedPlyVariantError');
  assert.equal(data.error.variant, 'not-gaussian-splat');
  assert.match(data.error.message, /opacity/);
});

test('worker reports an unrecognized container as a plain error', async () => {

  const { data } = await request({
    id: 'req-5',
    arrayBuffer: new Uint8Array([9, 9, 9, 9]).buffer,
    fileName: 'scan.xyz',
  });

  assert.equal(data.ok, false);
  assert.equal(data.error.name, 'Error');
  assert.match(data.error.message, /Supported inputs/);
});
