import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isGzip,
  parseSpzHeader,
  readGaussianSplatSpz,
  readSpzPayload,
  UnsupportedSpzError,
} from './spz-splat-reader.js';
import { buildSpzPayload, gzipBytes } from './test-fixtures.mjs';
import { SH_C0 } from './splat-cloud.js';

const SAMPLE = [
  {
    position: [1.5, -2.25, 0.75],
    scale: [0.1, 0.2, 0.05],
    rotation: [0, 0, 0, 1],
    opacity: 0.8,
    sh0: [1.2, -0.4, 0.6],
  },
  {
    position: [-3.125, 0.5, 4.0],
    scale: [0.02, 0.02, 0.02],
    rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    opacity: 0.4,
    sh0: [-0.8, 0.2, 1.0],
  },
];

test('parseSpzHeader reads the 16 byte header', () => {
  const header = parseSpzHeader(buildSpzPayload(SAMPLE, { version: 2, shDegree: 2 }));

  assert.equal(header.version, 2);
  assert.equal(header.count, 2);
  assert.equal(header.shDegree, 2);
  assert.equal(header.fractionalBits, 12);
  assert.equal(header.antialiased, false);
  assert.equal(header.lod, false);
});

test('parseSpzHeader rejects a bad magic', () => {
  const payload = buildSpzPayload(SAMPLE);
  payload[0] ^= 0xff;
  assert.throws(() => parseSpzHeader(payload), /Invalid SPZ magic/);
});

test('parseSpzHeader rejects an unsupported version', () => {
  const payload = buildSpzPayload(SAMPLE);
  new DataView(payload.buffer).setUint32(4, 9, true);
  assert.throws(() => parseSpzHeader(payload), (error) => {
    assert.ok(error instanceof UnsupportedSpzError);
    assert.equal(error.variant, 'version');
    return true;
  });
});

test('readSpzPayload dequantizes v2 fixed point positions', () => {
  const cloud = readSpzPayload(buildSpzPayload(SAMPLE, { version: 2 }));

  assert.equal(cloud.count, 2);
  assert.equal(cloud.sourceFormat, 'spz');
  // 12 fractional bits resolve to 1/4096, and these inputs are exact in binary.
  assert.ok(Math.abs(cloud.positions[0] - 1.5) < 1e-6);
  assert.ok(Math.abs(cloud.positions[1] + 2.25) < 1e-6);
  assert.ok(Math.abs(cloud.positions[3] + 3.125) < 1e-6);
});

test('readSpzPayload sign-extends negative 24 bit positions', () => {
  const cloud = readSpzPayload(buildSpzPayload([{
    ...SAMPLE[0],
    position: [-100.5, -0.25, -2047.75],
  }], { version: 2 }));

  assert.ok(Math.abs(cloud.positions[0] + 100.5) < 1e-4);
  assert.ok(Math.abs(cloud.positions[1] + 0.25) < 1e-4);
  assert.ok(Math.abs(cloud.positions[2] + 2047.75) < 1e-4);
});

test('readSpzPayload decodes v1 half float positions', () => {
  const cloud = readSpzPayload(buildSpzPayload(SAMPLE, { version: 1 }));

  assert.ok(Math.abs(cloud.positions[0] - 1.5) < 1e-3);
  assert.ok(Math.abs(cloud.positions[1] + 2.25) < 1e-3);
  assert.ok(Math.abs(cloud.positions[3] + 3.125) < 1e-3);
});

test('readSpzPayload converts stored colors back to SH coefficients', () => {
  const cloud = readSpzPayload(buildSpzPayload(SAMPLE));

  // The 0.15 color scale plus 8 bit quantization bounds the error at ~0.05.
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(cloud.sh0[i] - SAMPLE[0].sh0[i]) < 0.05,
      `sh0[${i}] ${cloud.sh0[i]} vs ${SAMPLE[0].sh0[i]}`,
    );
  }

  // And the coefficient must still map into a sane display color.
  const red = cloud.sh0[0] * SH_C0 + 0.5;
  assert.ok(red > 0 && red < 1.2);
});

test('readSpzPayload exponentiates log encoded scales', () => {
  const cloud = readSpzPayload(buildSpzPayload(SAMPLE));

  assert.ok(Math.abs(cloud.scales[0] - 0.1) < 0.01);
  assert.ok(Math.abs(cloud.scales[1] - 0.2) < 0.01);
  assert.ok(Math.abs(cloud.scales[3] - 0.02) < 0.01);
});

test('readSpzPayload keeps alpha linear', () => {
  const cloud = readSpzPayload(buildSpzPayload(SAMPLE));

  assert.ok(Math.abs(cloud.opacities[0] - 0.8) < 0.01);
  assert.ok(Math.abs(cloud.opacities[1] - 0.4) < 0.01);
});

test('readSpzPayload recovers v2 rotations with the implied w', () => {
  const cloud = readSpzPayload(buildSpzPayload(SAMPLE, { version: 2 }));

  assert.ok(Math.abs(cloud.rotations[3] - 1) < 0.02);

  const second = Array.from(cloud.rotations.slice(4, 8));
  assert.ok(Math.abs(second[0] - Math.SQRT1_2) < 0.02);
  assert.ok(Math.abs(second[3] - Math.SQRT1_2) < 0.02);
});

test('readSpzPayload unpacks v3 smallest-three rotations', () => {
  const rotations = [
    [0, 0, 0, 1],
    [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    [0.5, 0.5, 0.5, 0.5],
    [0, -0.6, 0.8, 0],
  ];
  const splats = rotations.map((rotation) => ({ ...SAMPLE[0], rotation }));
  const cloud = readSpzPayload(buildSpzPayload(splats, { version: 3 }));

  for (let i = 0; i < rotations.length; i++) {
    const decoded = Array.from(cloud.rotations.slice(i * 4, i * 4 + 4));
    // Quaternions are sign-ambiguous, so compare against both representations.
    const sameSign = rotations[i].every((value, axis) => Math.abs(decoded[axis] - value) < 0.01);
    const flipped = rotations[i].every((value, axis) => Math.abs(decoded[axis] + value) < 0.01);
    assert.ok(sameSign || flipped, `rotation ${i}: ${decoded} vs ${rotations[i]}`);
  }
});

test('readSpzPayload dequantizes higher order SH', () => {
  const shRest = Array.from({ length: 24 }, (_, i) => (i - 12) / 32);
  const cloud = readSpzPayload(buildSpzPayload(
    [{ ...SAMPLE[0], shRest }],
    { shDegree: 2 },
  ));

  assert.equal(cloud.shDegree, 2);
  assert.equal(cloud.shRest.length, 24);
  for (let i = 0; i < 24; i++) {
    assert.ok(Math.abs(cloud.shRest[i] - shRest[i]) < 0.01, `shRest[${i}]`);
  }
});

test('readSpzPayload records the antialiased flag', () => {
  const cloud = readSpzPayload(buildSpzPayload(SAMPLE, { antialiased: true }));
  assert.equal(cloud.antialiased, true);
});

test('readSpzPayload rejects a truncated payload', () => {
  const payload = buildSpzPayload(SAMPLE);
  assert.throws(() => readSpzPayload(payload.subarray(0, payload.byteLength - 4)), /truncated/);
});

test('readGaussianSplatSpz inflates a gzip framed file', async () => {
  const payload = buildSpzPayload(SAMPLE);
  const gzipped = await gzipBytes(payload);

  assert.ok(isGzip(gzipped));
  assert.ok(!isGzip(payload));

  const cloud = await readGaussianSplatSpz(gzipped);
  assert.equal(cloud.count, 2);
  assert.ok(Math.abs(cloud.positions[0] - 1.5) < 1e-6);
});

test('readGaussianSplatSpz accepts an already inflated payload', async () => {
  const cloud = await readGaussianSplatSpz(buildSpzPayload(SAMPLE));
  assert.equal(cloud.count, 2);
});
