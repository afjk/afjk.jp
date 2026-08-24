// Contract tests for the splat-transform adapter.
//
// These assert what comes *out* — a KHR_gaussian_splatting GLB whose accessors
// hold the values the source described — rather than how splat-transform gets
// there. That is the whole point of the adapter: SceneSync's guarantee is the
// GLB, and a library upgrade is allowed to change everything else.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UnsupportedSplatInputError,
  convertGaussianSplatToGlb,
  resolveArchiveEntry,
} from './splat-transform-adapter.js';
import { inspectGaussianSplatGlb, parseGlbJson } from '../khr-gaussian-splatting.js';
import { packGlb, splitGlb } from './glb-root-transform.js';
import { readGaussianSplatGlb } from './khr-glb-reader.mjs';
import {
  buildGaussianSplatPly,
  buildPointCloudPly,
  buildSpzPayload,
  gzipBytes,
} from './test-fixtures.mjs';

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../scenesync/experiments/fixtures',
);

const fixture = (name) => new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, name)));

// Degree 1 SH keeps the fixtures small while still covering the band-major
// attribute layout; values stay inside [-1, 1] because SPZ quantizes to a byte
// over that range.
const SPLATS = [
  {
    position: [1, 2, 3],
    scale: [0.1, 0.2, 0.3],
    rotation: [0, 0, 0, 1],
    opacity: 0.75,
    sh0: [1.5, -0.5, 0.25],
    shRest: Array.from({ length: 9 }, (_, i) => (i - 4) / 10),
  },
  {
    position: [-4, 5, -6],
    scale: [0.05, 0.06, 0.07],
    rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    opacity: 0.25,
    sh0: [-1, 0, 1],
    shRest: Array.from({ length: 9 }, (_, i) => (4 - i) / 10),
  },
];

const plyBytes = (options = {}) => buildGaussianSplatPly(SPLATS, { shDegree: 1, ...options });
const spzBytes = (options = {}) => gzipBytes(buildSpzPayload(SPLATS, { version: 2, shDegree: 1, ...options }));

/**
 * glTF is Y-up right-handed while a 3DGS PLY is Y-down, so the converter flips
 * x and y. Anything comparing GLB output against the source values has to
 * expect that.
 */
function toGltfPosition([x, y, z]) {
  return [-x, -y, z];
}

function maxDifference(a, b) {
  assert.equal(a.length, b.length, 'compared attributes must have the same length');
  let worst = 0;
  for (let i = 0; i < a.length; i += 1) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
}

/**
 * Pair up two decodings of the same scene by position.
 *
 * SOG stores its splats in Morton order, so index i in one file is not index i
 * in the other. Matching on position — which survives every encoding to well
 * under the splat spacing — lets the remaining attributes be compared per
 * splat instead of only in aggregate.
 */
function matchByPosition(from, to) {
  const distance = (i, j) => Math.hypot(
    from.position[i * 3] - to.position[j * 3],
    from.position[i * 3 + 1] - to.position[j * 3 + 1],
    from.position[i * 3 + 2] - to.position[j * 3 + 2],
  );

  const mapping = [];
  let worst = 0;
  for (let i = 0; i < from.count; i += 1) {
    let best = -1;
    let bestDistance = Infinity;
    for (let j = 0; j < to.count; j += 1) {
      const d = distance(i, j);
      if (d < bestDistance) { bestDistance = d; best = j; }
    }
    mapping.push(best);
    worst = Math.max(worst, bestDistance);
  }

  assert.equal(new Set(mapping).size, from.count, 'every splat should match a distinct splat');
  return { mapping, worstDistance: worst };
}

function maxDifferenceMatched(from, to, mapping, pick, components) {
  let worst = 0;
  for (let i = 0; i < from.count; i += 1) {
    for (let c = 0; c < components; c += 1) {
      worst = Math.max(worst, Math.abs(pick(from)[i * components + c] - pick(to)[mapping[i] * components + c]));
    }
  }
  return worst;
}

test('a PLY becomes a valid KHR_gaussian_splatting GLB', async () => {
  const result = await convertGaussianSplatToGlb(plyBytes(), { fileName: 'capture.ply' });

  assert.equal(result.sourceFormat, 'ply');
  assert.equal(result.splatCount, 2);
  assert.equal(result.shDegree, 1);
  assert.equal(result.sourceShDegree, 1);

  const inspection = inspectGaussianSplatGlb(result.glb);
  assert.equal(inspection.valid, true, inspection.errors.join('; '));
  assert.deepEqual(inspection.warnings, []);
});

test('GLB attributes carry the values the PLY described', async () => {
  const { glb } = await convertGaussianSplatToGlb(plyBytes(), { fileName: 'capture.ply' });
  const decoded = readGaussianSplatGlb(glb);

  assert.equal(decoded.count, 2);
  assert.equal(decoded.shDegree, 1);

  assert.deepEqual(
    Array.from(decoded.position),
    [...toGltfPosition(SPLATS[0].position), ...toGltfPosition(SPLATS[1].position)],
  );

  // SCALE is linear in the GLB; the PLY stores its logarithm.
  const expectedScale = [...SPLATS[0].scale, ...SPLATS[1].scale];
  assert.ok(maxDifference(decoded.scale, expectedScale) < 1e-6, 'scale should be linear');

  // OPACITY is linear alpha; the PLY stores its logit.
  assert.ok(
    maxDifference(decoded.opacity, [SPLATS[0].opacity, SPLATS[1].opacity]) < 1e-6,
    'opacity should be linear alpha',
  );

  // Rotations stay unit quaternions through the coordinate flip.
  for (let i = 0; i < decoded.count; i += 1) {
    const q = decoded.rotation.subarray(i * 4, i * 4 + 4);
    const norm = Math.hypot(q[0], q[1], q[2], q[3]);
    assert.ok(Math.abs(norm - 1) < 1e-5, `rotation ${i} should be normalized, got ${norm}`);
  }

  // Degree 0 is view independent, so it survives the flip unchanged.
  assert.ok(
    maxDifference(decoded.sh[0][0], [...SPLATS[0].sh0, ...SPLATS[1].sh0]) < 1e-6,
    'degree 0 SH should be carried through verbatim',
  );

  // COLOR_0 is the degree 0 SH evaluated to display RGB, plus alpha.
  const SH_C0 = 0.28209479177387814;
  assert.ok(Math.abs(decoded.color[0] - (SPLATS[0].sh0[0] * SH_C0 + 0.5)) < 0.01);
  assert.ok(Math.abs(decoded.color[3] - SPLATS[0].opacity) < 0.01);
});

test('the same scene as PLY and as SPZ converts to the same GLB content', async () => {
  const fromPly = readGaussianSplatGlb(
    (await convertGaussianSplatToGlb(plyBytes(), { fileName: 'a.ply' })).glb,
  );
  const fromSpz = readGaussianSplatGlb(
    (await convertGaussianSplatToGlb(await spzBytes(), { fileName: 'a.spz' })).glb,
  );

  assert.equal(fromSpz.count, fromPly.count);
  assert.equal(fromSpz.shDegree, fromPly.shDegree);

  // SPZ quantizes positions to 1/4096, scales and opacity to a byte, and SH
  // rest coefficients to a byte over [-1, 1].
  assert.ok(maxDifference(fromPly.position, fromSpz.position) < 1e-3, 'position');
  assert.ok(maxDifference(fromPly.scale, fromSpz.scale) < 1e-2, 'scale');
  assert.ok(maxDifference(fromPly.opacity, fromSpz.opacity) < 5e-3, 'opacity');
  assert.ok(maxDifference(fromPly.sh[0][0], fromSpz.sh[0][0]) < 2e-2, 'sh degree 0');
  for (let coef = 0; coef < 3; coef += 1) {
    assert.ok(maxDifference(fromPly.sh[1][coef], fromSpz.sh[1][coef]) < 2e-2, `sh degree 1 coef ${coef}`);
  }
});

test('a SOG bundle converts to the same content as the PLY it came from', async () => {
  const fromPly = readGaussianSplatGlb(
    (await convertGaussianSplatToGlb(fixture('ring-gaussian-splats.ply'), { fileName: 'ring.ply' })).glb,
  );

  const result = await convertGaussianSplatToGlb(fixture('ring-gaussian-splats.sog'), {
    fileName: 'ring.sog',
  });
  assert.equal(result.sourceFormat, 'sog');
  assert.equal(result.splatCount, fromPly.count);
  assert.equal(inspectGaussianSplatGlb(result.glb).valid, true);

  const fromSog = readGaussianSplatGlb(result.glb);
  const { mapping, worstDistance } = matchByPosition(fromSog, fromPly);

  // SOG quantizes positions into a grid over the scene bounds, and its SH
  // codebook is exact at this splat count.
  assert.ok(worstDistance < 1e-3, `position, worst distance ${worstDistance}`);
  assert.ok(maxDifferenceMatched(fromSog, fromPly, mapping, (g) => g.scale, 3) < 1e-3, 'scale');
  assert.ok(maxDifferenceMatched(fromSog, fromPly, mapping, (g) => g.opacity, 1) < 1e-2, 'opacity');
  assert.ok(maxDifferenceMatched(fromSog, fromPly, mapping, (g) => g.sh[0][0], 3) < 1e-3, 'sh degree 0');
  assert.ok(maxDifferenceMatched(fromSog, fromPly, mapping, (g) => g.sh[1][0], 3) < 1e-2, 'sh degree 1');
});

test('an LCC2 octree zipped into one file converts', async () => {
  const result = await convertGaussianSplatToGlb(fixture('ring-gaussian-splats.lcc2.zip'), {
    fileName: 'ring-gaussian-splats.lcc2.zip',
  });

  assert.equal(result.sourceFormat, 'lcc2');
  assert.equal(result.splatCount, 16);
  assert.equal(inspectGaussianSplatGlb(result.glb).valid, true);
});

test('resolveArchiveEntry prefers a manifest, shallowest first', () => {
  assert.deepEqual(
    resolveArchiveEntry(['scene/3dgs/chunk0.sog', 'scene/meta.lcc2']),
    { filename: 'scene/meta.lcc2', inputFormat: 'lcc2' },
  );
  assert.deepEqual(
    resolveArchiveEntry(['a/b/c/meta.lcc2', 'meta.lcc2']),
    { filename: 'meta.lcc2', inputFormat: 'lcc2' },
  );
  assert.deepEqual(
    resolveArchiveEntry(['notes.txt', 'capture.ply']),
    { filename: 'capture.ply', inputFormat: 'ply' },
  );
});

test('an archive with nothing recognizable is reported as such', () => {
  assert.throws(
    () => resolveArchiveEntry(['readme.md', 'thumb.png']),
    (error) => error instanceof UnsupportedSplatInputError && error.variant === 'no-splat-in-archive',
  );
});

test('maxShDegree keeps exactly the requested bands', async () => {
  for (const [maxShDegree, expectedDegree] of [[0, 0], [1, 1], [2, 1], [3, 1]]) {
    const result = await convertGaussianSplatToGlb(plyBytes(), { fileName: 'a.ply', maxShDegree });
    assert.equal(result.shDegree, expectedDegree, `cap ${maxShDegree}`);
    assert.equal(result.sourceShDegree, 1, 'the source degree is still reported');
    assert.equal(readGaussianSplatGlb(result.glb).shDegree, expectedDegree);
  }
});

test('SH bands are kept in full by default', async () => {
  const ply = buildGaussianSplatPly(
    [{ ...SPLATS[0], shRest: Array.from({ length: 45 }, (_, i) => (i - 22) / 46) }],
    { shDegree: 3 },
  );

  const result = await convertGaussianSplatToGlb(ply, { fileName: 'a.ply' });
  assert.equal(result.shDegree, 3, 'quality must not be reduced unless asked for');

  const attributes = parseGlbJson(result.glb).meshes[0].primitives[0].attributes;
  for (const [degree, coefs] of [[1, 3], [2, 5], [3, 7]]) {
    for (let coef = 0; coef < coefs; coef += 1) {
      assert.ok(
        Number.isInteger(attributes[`KHR_gaussian_splatting:SH_DEGREE_${degree}_COEF_${coef}`]),
        `degree ${degree} coef ${coef} should be present`,
      );
    }
  }
});

test('dropping bands leaves the surviving coefficients untouched', async () => {
  const ply = buildGaussianSplatPly(
    [{ ...SPLATS[0], shRest: Array.from({ length: 45 }, (_, i) => (i - 22) / 46) }],
    { shDegree: 3 },
  );

  const full = readGaussianSplatGlb((await convertGaussianSplatToGlb(ply, { fileName: 'a.ply' })).glb);
  const trimmed = readGaussianSplatGlb(
    (await convertGaussianSplatToGlb(ply, { fileName: 'a.ply', maxShDegree: 1 })).glb,
  );

  assert.equal(trimmed.shDegree, 1);
  assert.deepEqual(Array.from(trimmed.sh[0][0]), Array.from(full.sh[0][0]));
  for (let coef = 0; coef < 3; coef += 1) {
    assert.deepEqual(Array.from(trimmed.sh[1][coef]), Array.from(full.sh[1][coef]));
  }
});

test('upAxisCorrection is a node rotation, not a rewrite of the splats', async () => {
  const plain = await convertGaussianSplatToGlb(plyBytes(), { fileName: 'a.ply' });
  const flipped = await convertGaussianSplatToGlb(plyBytes(), {
    fileName: 'a.ply',
    upAxisCorrection: 'flip-x-180',
  });

  const json = parseGlbJson(flipped.glb);
  const root = json.nodes[json.scenes[json.scene ?? 0].nodes[0]];
  assert.deepEqual(root.rotation, [1, 0, 0, 0], '180 degrees about X');
  assert.equal(inspectGaussianSplatGlb(flipped.glb).valid, true);

  // The gaussians themselves must be identical either way.
  assert.deepEqual(
    Array.from(readGaussianSplatGlb(flipped.glb).position),
    Array.from(readGaussianSplatGlb(plain.glb).position),
  );
});

test('the default is no correction at all', async () => {
  const { glb } = await convertGaussianSplatToGlb(plyBytes(), { fileName: 'a.ply' });
  const json = parseGlbJson(glb);
  for (const node of json.nodes) {
    assert.equal(node.rotation, undefined, 'no node should carry a rotation by default');
  }
});

test('a KHR GLB is validated and passed through untouched', async () => {
  const { glb } = await convertGaussianSplatToGlb(plyBytes(), { fileName: 'a.ply' });
  const result = await convertGaussianSplatToGlb(glb, { fileName: 'a.glb' });

  assert.equal(result.sourceFormat, 'glb');
  assert.equal(result.shDegree, 1);
  assert.equal(result.glb, glb, 'the bytes should not be re-encoded');
});

test('a GLB without the extension is rejected rather than passed on', async () => {
  const source = fixture('minimal-khr-gaussian-splatting.glb');
  const { json, bin } = splitGlb(source);
  assert.ok(json.meshes[0].primitives[0].extensions.KHR_gaussian_splatting, 'fixture sanity');

  delete json.meshes[0].primitives[0].extensions;
  json.extensionsUsed = [];

  await assert.rejects(
    convertGaussianSplatToGlb(packGlb(json, bin), { fileName: 'plain.glb' }),
    (error) => error instanceof UnsupportedSplatInputError && error.variant === 'invalid-glb',
  );
});

test('a GLB missing a required attribute is rejected', async () => {
  const source = fixture('minimal-khr-gaussian-splatting.glb');
  const { json, bin } = splitGlb(source);

  delete json.meshes[0].primitives[0].attributes['KHR_gaussian_splatting:OPACITY'];

  await assert.rejects(
    convertGaussianSplatToGlb(packGlb(json, bin), { fileName: 'partial.glb' }),
    (error) => error instanceof UnsupportedSplatInputError
      && error.variant === 'invalid-glb'
      && /OPACITY/.test(error.message),
  );
});

test('a plain point cloud PLY is reported as not a Gaussian Splat', async () => {
  const cloud = buildPointCloudPly([{ position: [0, 0, 0] }, { position: [1, 1, 1] }]);

  await assert.rejects(
    convertGaussianSplatToGlb(cloud, { fileName: 'cloud.ply' }),
    (error) => error instanceof UnsupportedSplatInputError && error.variant === 'not-gaussian-splat',
  );
});

test('an unrecognized container names the formats that are supported', async () => {
  await assert.rejects(
    convertGaussianSplatToGlb(new Uint8Array([9, 9, 9, 9]), { fileName: 'scan.xyz' }),
    (error) => error instanceof UnsupportedSplatInputError
      && error.variant === 'unknown-format'
      && /\.ply/.test(error.message)
      && /\.sog/.test(error.message),
  );
});

test('a truncated capture fails instead of producing a partial GLB', async () => {
  const truncated = plyBytes().subarray(0, plyBytes().length - 40);
  await assert.rejects(convertGaussianSplatToGlb(truncated, { fileName: 'cut.ply' }));
});

test('an already-aborted signal stops before any work', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    convertGaussianSplatToGlb(plyBytes(), { fileName: 'a.ply', signal: controller.signal }),
    (error) => error instanceof UnsupportedSplatInputError && error.variant === 'aborted',
  );
});

test('an ASCII or big-endian PLY is refused instead of decoded as zeros', async () => {
  for (const format of ['ascii', 'binary_big_endian']) {
    await assert.rejects(
      convertGaussianSplatToGlb(plyBytes({ format }), { fileName: `a.${format}.ply` }),
      (error) => error instanceof UnsupportedSplatInputError
        && error.variant === 'unsupported-ply-encoding'
        && error.message.includes(format),
      format,
    );
  }
});

test('a bare LCC manifest says to zip the folder instead', async () => {
  const manifest = new TextEncoder().encode(JSON.stringify({
    totalSplats: 1, lodSplats: [1], totalLevels: 1, root: { splatFiles: ['chunk0.sog'] },
  }));

  await assert.rejects(
    convertGaussianSplatToGlb(manifest, { fileName: 'meta.lcc2' }),
    (error) => error instanceof UnsupportedSplatInputError
      && error.variant === 'incomplete-lcc'
      && /zip/.test(error.message),
  );
});

test('maxShDegree outside 0..3 is rejected rather than ignored', async () => {
  for (const bad of [-1, 4, 99, 1.5, '2', null, NaN]) {
    await assert.rejects(
      convertGaussianSplatToGlb(plyBytes(), { fileName: 'a.ply', maxShDegree: bad }),
      RangeError,
      `should reject ${JSON.stringify(bad)}`,
    );
  }
});

test('an omitted maxShDegree keeps every band', async () => {
  const result = await convertGaussianSplatToGlb(plyBytes(), {
    fileName: 'a.ply',
    maxShDegree: undefined,
  });
  assert.equal(result.shDegree, 1);
});
