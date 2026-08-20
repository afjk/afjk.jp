import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectShDegree,
  parsePlyHeader,
  readGaussianSplatPly,
  shRestIndices,
  splitPlyHeader,
  UnsupportedPlyVariantError,
} from './ply-splat-reader.js';
import { buildGaussianSplatPly, logit } from './test-fixtures.mjs';

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
    // 90 degrees about Y.
    rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    opacity: 0.25,
    sh0: [-1, 0, 1],
  },
];

test('splitPlyHeader finds the body offset past end_header', () => {
  const ply = buildGaussianSplatPly(SAMPLE);
  const { headerText, bodyOffset } = splitPlyHeader(ply);

  assert.ok(headerText.startsWith('ply\n'));
  assert.ok(headerText.endsWith('end_header'));
  // Without higher SH there are 17 float32 properties: xyz, normals, f_dc,
  // opacity, three scales and four rotation components.
  assert.equal(ply.byteLength - bodyOffset, SAMPLE.length * 17 * 4);
});

test('parsePlyHeader reads format, element count and properties', () => {
  const ply = buildGaussianSplatPly(SAMPLE);
  const { format, elements } = parsePlyHeader(splitPlyHeader(ply).headerText);

  assert.equal(format, 'binary_little_endian');
  assert.equal(elements.length, 1);
  assert.equal(elements[0].name, 'vertex');
  assert.equal(elements[0].count, 2);
  assert.equal(elements[0].properties[0].name, 'x');
  assert.equal(elements[0].properties[0].type, 'float');
});

test('detectShDegree maps f_rest counts to bands', () => {
  const names = (count) => Array.from({ length: count }, (_, i) => `f_rest_${i}`);

  assert.equal(detectShDegree([]), 0);
  assert.equal(detectShDegree(names(9)), 1);
  assert.equal(detectShDegree(names(24)), 2);
  assert.equal(detectShDegree(names(45)), 3);
});

test('shRestIndices resolves the channel-major f_rest layout', () => {
  // Degree 1 of a full degree 3 set: coefficients 0..2 of each channel, and the
  // channels are 15 apart.
  assert.deepEqual(shRestIndices(1, 45), [0, 15, 30, 1, 16, 31, 2, 17, 32]);
  // Degree 2 starts at slot 3 within each channel.
  assert.deepEqual(shRestIndices(2, 45).slice(0, 6), [3, 18, 33, 4, 19, 34]);
  // Degree 3 starts at slot 8.
  assert.deepEqual(shRestIndices(3, 45).slice(0, 3), [8, 23, 38]);
});

test('readGaussianSplatPly applies the 3DGS activations', () => {
  const cloud = readGaussianSplatPly(buildGaussianSplatPly(SAMPLE));

  assert.equal(cloud.count, 2);
  assert.equal(cloud.shDegree, 0);
  assert.equal(cloud.sourceFormat, 'ply');

  assert.deepEqual(Array.from(cloud.positions.slice(0, 3)), [1, 2, 3]);

  // scale_i is a log; the reader must exponentiate it.
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(cloud.scales[axis] - SAMPLE[0].scale[axis]) < 1e-6);
  }

  // opacity is a logit; the reader must apply the logistic function.
  assert.ok(Math.abs(cloud.opacities[0] - 0.75) < 1e-6);
  assert.ok(Math.abs(cloud.opacities[1] - 0.25) < 1e-6);

  // f_dc_* are SH coefficients and must survive untouched.
  assert.ok(Math.abs(cloud.sh0[0] - 1.5) < 1e-6);
  assert.ok(Math.abs(cloud.sh0[1] + 0.5) < 1e-6);
});

test('readGaussianSplatPly reorders the quaternion from wxyz to xyzw', () => {
  const cloud = readGaussianSplatPly(buildGaussianSplatPly(SAMPLE));

  assert.deepEqual(Array.from(cloud.rotations.slice(0, 4)), [0, 0, 0, 1]);

  const second = Array.from(cloud.rotations.slice(4, 8));
  assert.ok(Math.abs(second[0]) < 1e-6);
  assert.ok(Math.abs(second[1] - Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(second[2]) < 1e-6);
  assert.ok(Math.abs(second[3] - Math.SQRT1_2) < 1e-6);
});

test('readGaussianSplatPly normalizes unnormalized quaternions', () => {
  const ply = buildGaussianSplatPly([{
    ...SAMPLE[0],
    rotation: [0, 0, 0, 4],
  }]);
  const cloud = readGaussianSplatPly(ply);

  assert.ok(Math.abs(cloud.rotations[3] - 1) < 1e-6);
});

test('readGaussianSplatPly de-interleaves higher order SH into coefficient order', () => {
  const shRest = Array.from({ length: 45 }, (_, i) => i / 100);
  const ply = buildGaussianSplatPly([{ ...SAMPLE[0], shRest }], { shDegree: 3 });
  const cloud = readGaussianSplatPly(ply);

  assert.equal(cloud.shDegree, 3);
  assert.equal(cloud.shRest.length, 45);
  for (let i = 0; i < 45; i++) {
    assert.ok(
      Math.abs(cloud.shRest[i] - shRest[i]) < 1e-6,
      `coefficient ${i}: ${cloud.shRest[i]} != ${shRest[i]}`,
    );
  }
});

test('readGaussianSplatPly handles ascii and big endian bodies', () => {
  const reference = readGaussianSplatPly(buildGaussianSplatPly(SAMPLE));

  for (const format of ['ascii', 'binary_big_endian']) {
    const cloud = readGaussianSplatPly(buildGaussianSplatPly(SAMPLE, { format }));
    assert.equal(cloud.count, reference.count, format);
    for (let i = 0; i < reference.positions.length; i++) {
      assert.ok(
        Math.abs(cloud.positions[i] - reference.positions[i]) < 1e-5,
        `${format} position ${i}`,
      );
    }
    assert.ok(Math.abs(cloud.opacities[0] - reference.opacities[0]) < 1e-5, format);
  }
});

test('readGaussianSplatPly rejects a plain point cloud', () => {
  const ply = new TextEncoder().encode([
    'ply',
    'format ascii 1.0',
    'element vertex 1',
    'property float x',
    'property float y',
    'property float z',
    'end_header',
    '0 0 0',
    '',
  ].join('\n'));

  assert.throws(() => readGaussianSplatPly(ply), (error) => {
    assert.ok(error instanceof UnsupportedPlyVariantError);
    assert.equal(error.variant, 'not-gaussian-splat');
    assert.match(error.message, /opacity/);
    return true;
  });
});

test('readGaussianSplatPly names the compressed SuperSplat variant', () => {
  const ply = new TextEncoder().encode([
    'ply',
    'format binary_little_endian 1.0',
    'element chunk 1',
    'property float min_x',
    'element vertex 1',
    'property uint packed_position',
    'end_header',
    '',
  ].join('\n'));

  assert.throws(() => readGaussianSplatPly(ply), (error) => {
    assert.equal(error.variant, 'compressed-chunked');
    return true;
  });
});

test('readGaussianSplatPly rejects a truncated binary body', () => {
  const ply = buildGaussianSplatPly(SAMPLE);
  assert.throws(
    () => readGaussianSplatPly(ply.subarray(0, ply.byteLength - 8)),
    /truncated/,
  );
});

test('logit round-trips through the reader activation', () => {
  const ply = buildGaussianSplatPly([{ ...SAMPLE[0], opacity: 0.123 }]);
  const cloud = readGaussianSplatPly(ply);
  assert.ok(Math.abs(cloud.opacities[0] - 0.123) < 1e-6);
  assert.ok(Number.isFinite(logit(0.123)));
});
