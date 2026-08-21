// Dropping high SH bands is the main lever on import size, and it is lossy, so
// these check that exactly the requested bands survive and that the ones kept
// still carry the right coefficients.

import test from 'node:test';
import assert from 'node:assert/strict';

import { importGaussianSplatAsset } from './import-gaussian-splat.js';
import { readGaussianSplatPly } from './ply-splat-reader.js';
import { readSpzPayload } from './spz-splat-reader.js';
import { resolveShDegree, SH_REST_COEFS_BY_DEGREE } from './splat-cloud.js';
import { parseGlbJson } from '../khr-gaussian-splatting.js';
import { buildGaussianSplatPly, buildSpzPayload } from './test-fixtures.mjs';

// Distinct per coefficient so a mis-sliced band is visible, and inside [-1, 1]
// because SPZ quantizes to a byte over that range.
const SH_REST = Array.from({ length: 45 }, (_, i) => (i - 22) / 46);

const SPLAT = {
  position: [1, 2, 3],
  scale: [0.1, 0.2, 0.3],
  rotation: [0, 0, 0, 1],
  opacity: 0.75,
  sh0: [1.5, -0.5, 0.25],
  shRest: SH_REST,
};

function shAttributeNames(glb) {
  return Object.keys(parseGlbJson(glb).meshes[0].primitives[0].attributes)
    .filter((name) => /SH_DEGREE_[1-3]_/.test(name));
}

test('resolveShDegree caps without ever raising the degree', () => {
  assert.equal(resolveShDegree(3, 1), 1);
  assert.equal(resolveShDegree(3, 3), 3);
  assert.equal(resolveShDegree(3), 3, 'defaults to keeping everything');
  assert.equal(resolveShDegree(0, 3), 0, 'cannot invent bands the source lacks');
  assert.equal(resolveShDegree(1, 3), 1);
});

test('resolveShDegree rejects a degree outside 0..3', () => {
  for (const bad of [-1, 4, 1.5, '2', null]) {
    assert.throws(() => resolveShDegree(3, bad), RangeError, `should reject ${bad}`);
  }
});

test('PLY reader keeps only the requested bands', () => {
  const ply = buildGaussianSplatPly([SPLAT], { shDegree: 3 });

  for (const [maxShDegree, expectedCoefs] of [[0, 0], [1, 3], [2, 8], [3, 15]]) {
    const cloud = readGaussianSplatPly(ply, { maxShDegree });
    assert.equal(cloud.shDegree, maxShDegree, `degree for cap ${maxShDegree}`);
    assert.equal(cloud.sourceShDegree, 3, 'source degree is still reported');

    if (expectedCoefs === 0) {
      assert.equal(cloud.shRest, null);
    } else {
      assert.equal(cloud.shRest.length, expectedCoefs * 3);
    }
  }
});

test('PLY reader keeps the correct coefficients, not just the right count', () => {
  const ply = buildGaussianSplatPly([SPLAT], { shDegree: 3 });
  const full = readGaussianSplatPly(ply);
  const capped = readGaussianSplatPly(ply, { maxShDegree: 1 });

  // Degree 1 occupies the first 3 coefficients, so the capped read must be a
  // prefix of the full one.
  for (let i = 0; i < capped.shRest.length; i++) {
    assert.ok(
      Math.abs(capped.shRest[i] - full.shRest[i]) < 1e-6,
      `coefficient ${i}: ${capped.shRest[i]} vs ${full.shRest[i]}`,
    );
  }
});

test('SPZ reader keeps the correct coefficients across the fixed-size section', () => {
  const payload = buildSpzPayload([SPLAT, SPLAT], { version: 2, shDegree: 3 });
  const full = readSpzPayload(payload);
  const capped = readSpzPayload(payload, { maxShDegree: 2 });

  assert.equal(full.shDegree, 3);
  assert.equal(capped.shDegree, 2);
  assert.equal(capped.sourceShDegree, 3);
  assert.equal(capped.shRest.length, 2 * SH_REST_COEFS_BY_DEGREE[2] * 3);

  // SPZ packs every band contiguously per splat, so a truncated read has to
  // stride over the source layout rather than copying a flat prefix. Checking
  // the second splat is what catches getting that wrong.
  const keptPerSplat = SH_REST_COEFS_BY_DEGREE[2] * 3;
  const fullPerSplat = SH_REST_COEFS_BY_DEGREE[3] * 3;

  for (let splat = 0; splat < 2; splat++) {
    for (let i = 0; i < keptPerSplat; i++) {
      assert.ok(
        Math.abs(capped.shRest[splat * keptPerSplat + i] - full.shRest[splat * fullPerSplat + i]) < 1e-6,
        `splat ${splat} coefficient ${i}`,
      );
    }
  }
});

test('capping to 0 drops the SH accessors from the GLB entirely', async () => {
  const ply = buildGaussianSplatPly([SPLAT], { shDegree: 3 });
  const { glb, shDegree, sourceShDegree } = await importGaussianSplatAsset(ply, {
    fileName: 'a.ply',
    maxShDegree: 0,
  });

  assert.equal(shDegree, 0);
  assert.equal(sourceShDegree, 3);
  assert.deepEqual(shAttributeNames(glb), []);
});

test('capping to 1 emits exactly the three degree 1 accessors', async () => {
  const ply = buildGaussianSplatPly([SPLAT], { shDegree: 3 });
  const { glb } = await importGaussianSplatAsset(ply, { fileName: 'a.ply', maxShDegree: 1 });

  assert.deepEqual(shAttributeNames(glb).sort(), [
    'KHR_gaussian_splatting:SH_DEGREE_1_COEF_0',
    'KHR_gaussian_splatting:SH_DEGREE_1_COEF_1',
    'KHR_gaussian_splatting:SH_DEGREE_1_COEF_2',
  ]);
});

test('reduction shrinks the GLB roughly in line with the dropped coefficients', async () => {
  // 512 splats so per-splat data dominates the JSON header.
  const splats = Array.from({ length: 512 }, () => SPLAT);
  const ply = buildGaussianSplatPly(splats, { shDegree: 3 });

  const sizes = {};
  for (const degree of [0, 1, 2, 3]) {
    const { glb } = await importGaussianSplatAsset(ply, { fileName: 'a.ply', maxShDegree: degree });
    sizes[degree] = glb.byteLength;
  }

  assert.ok(sizes[0] < sizes[1] && sizes[1] < sizes[2] && sizes[2] < sizes[3], JSON.stringify(sizes));

  // Degree 0 keeps 11 floats per splat, degree 3 keeps 11 + 45. The ratio
  // should land near 56/11, so a generous band still catches a broken slice.
  const ratio = sizes[3] / sizes[0];
  assert.ok(ratio > 3.5 && ratio < 6, `degree 3 / degree 0 size ratio was ${ratio.toFixed(2)}`);
});

test('capping above the source degree is a no-op', async () => {
  const ply = buildGaussianSplatPly([{ ...SPLAT, shRest: SH_REST.slice(0, 9) }], { shDegree: 1 });

  const uncapped = await importGaussianSplatAsset(ply, { fileName: 'a.ply' });
  const capped = await importGaussianSplatAsset(ply, { fileName: 'a.ply', maxShDegree: 3 });

  assert.equal(capped.shDegree, 1);
  assert.deepEqual(Array.from(capped.glb), Array.from(uncapped.glb));
});

test('an invalid maxShDegree fails the import rather than being ignored', async () => {
  const ply = buildGaussianSplatPly([SPLAT], { shDegree: 3 });
  await assert.rejects(
    () => importGaussianSplatAsset(ply, { fileName: 'a.ply', maxShDegree: 7 }),
    RangeError,
  );
});
