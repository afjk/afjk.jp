// The File-level wrapper: naming, size limits, progress and error text.
//
// Conversion itself is injected as `importer` — here it is the adapter called
// directly, which is the same code the vendored Worker bundle runs, without
// paying to load the bundle in every test.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SOURCE_BYTES,
  convertGaussianSplatFileToGlb,
  describeGaussianSplatImportError,
  formatBytes,
  gaussianSplatGlbName,
  isGaussianSplatFile,
} from './gaussian-splat-file-import.js';
import { UnsupportedSplatInputError } from './splat-format-detect.js';
import { convertGaussianSplatToGlb } from './splat-transform-adapter.js';
import { inspectGaussianSplatGlb, parseGlbJson } from '../khr-gaussian-splatting.js';
import {
  buildGaussianSplatPly,
  buildPointCloudPly,
  buildSpzPayload,
  gzipBytes,
} from './test-fixtures.mjs';

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

/** The real conversion, minus the Worker plumbing. */
const importer = (arrayBuffer, options) => convertGaussianSplatToGlb(arrayBuffer, options);

function plyFile(name = 'capture.ply', splats = SAMPLE) {
  return new File([buildGaussianSplatPly(splats)], name);
}

const convert = (file, options = {}) => convertGaussianSplatFileToGlb(file, { importer, ...options });

test('isGaussianSplatFile accepts every supported container', () => {
  for (const name of ['a.ply', 'a.PLY', 'a.spz', 'a.sog', 'a.lcc2', 'a.splat', 'site.lcc2.zip']) {
    assert.equal(isGaussianSplatFile(new File([], name)), true, name);
  }
  assert.equal(isGaussianSplatFile(new File([], 'a.glb')), false);
  assert.equal(isGaussianSplatFile(new File([], 'a.png')), false);
  assert.equal(isGaussianSplatFile(null), false);
});

test('gaussianSplatGlbName swaps the extension', () => {
  assert.equal(gaussianSplatGlbName('capture.ply'), 'capture.glb');
  assert.equal(gaussianSplatGlbName('room.sog'), 'room.glb');
});

test('convertGaussianSplatFileToGlb returns a loadable GLB File', async () => {
  const result = await convert(plyFile());

  assert.equal(result.file.name, 'capture.glb');
  assert.equal(result.file.type, 'model/gltf-binary');
  assert.equal(result.splatCount, 2);
  assert.equal(result.shDegree, 0);
  assert.equal(result.sourceFormat, 'ply');
  assert.ok(result.sourceBytes > 0);

  const glb = new Uint8Array(await result.file.arrayBuffer());
  assert.equal(inspectGaussianSplatGlb(glb).valid, true);
});

test('convertGaussianSplatFileToGlb handles gzip framed SPZ', async () => {
  const spz = new File([await gzipBytes(buildSpzPayload(SAMPLE))], 'room.spz');
  const result = await convert(spz);

  assert.equal(result.file.name, 'room.glb');
  assert.equal(result.sourceFormat, 'spz');
  assert.equal(result.splatCount, 2);
  assert.equal(inspectGaussianSplatGlb(new Uint8Array(await result.file.arrayBuffer())).valid, true);
});

test('convertGaussianSplatFileToGlb reports progress phases in order', async () => {
  const phases = [];
  await convert(plyFile(), { onProgress: ({ phase }) => phases.push(phase) });

  assert.deepEqual(phases, ['reading', 'converting', 'converted']);
});

test('convertGaussianSplatFileToGlb passes upAxisCorrection through', async () => {
  const result = await convert(plyFile(), { upAxisCorrection: 'flip-x-180' });

  const json = parseGlbJson(new Uint8Array(await result.file.arrayBuffer()));
  const root = json.nodes[json.scenes[json.scene ?? 0].nodes[0]];
  assert.deepEqual(root.rotation, [1, 0, 0, 0]);
});

test('convertGaussianSplatFileToGlb passes maxShDegree through', async () => {
  const shRest = Array.from({ length: 45 }, (_, i) => i / 100);
  const file = new File([buildGaussianSplatPly([{ ...SAMPLE[0], shRest }], { shDegree: 3 })], 'a.ply');

  const trimmed = await convert(file, { maxShDegree: 1 });
  assert.equal(trimmed.shDegree, 1);
  assert.equal(trimmed.sourceShDegree, 3);
});

test('the converted GLB carries the full SH set by default', async () => {
  const shRest = Array.from({ length: 45 }, (_, i) => i / 100);
  const file = new File(
    [buildGaussianSplatPly([{ ...SAMPLE[0], shRest }], { shDegree: 3 })],
    'detailed.ply',
  );

  const result = await convert(file);
  assert.equal(result.shDegree, 3);

  const glb = new Uint8Array(await result.file.arrayBuffer());
  const attributes = parseGlbJson(glb).meshes[0].primitives[0].attributes;
  assert.ok('KHR_gaussian_splatting:SH_DEGREE_3_COEF_6' in attributes);
});

test('convertGaussianSplatFileToGlb rejects a non-splat extension', async () => {
  await assert.rejects(
    () => convert(new File([], 'model.glb')),
    /Gaussian Splatファイルではありません/,
  );
});

test('convertGaussianSplatFileToGlb rejects a file over the upload limit', async () => {
  // Report a large size without allocating it.
  const file = plyFile();
  Object.defineProperty(file, 'size', { value: MAX_SOURCE_BYTES + 1 });

  await assert.rejects(() => convert(file), /大きすぎます/);
});

test('convertGaussianSplatFileToGlb surfaces the underlying variant error', async () => {
  const notSplat = new File([buildPointCloudPly([{ position: [0, 0, 0] }])], 'cloud.ply');

  await assert.rejects(
    () => convert(notSplat),
    (error) => error instanceof UnsupportedSplatInputError && error.variant === 'not-gaussian-splat',
  );
});

test('describeGaussianSplatImportError explains each variant', () => {
  const message = (variant) => describeGaussianSplatImportError(
    new UnsupportedSplatInputError('raw', variant),
  );

  assert.match(message('not-gaussian-splat'), /Gaussian Splatではない/);
  assert.match(message('no-splat-in-archive'), /LCC2/);
  assert.match(message('empty'), /splatが1つも/);
  assert.match(message('invalid-glb'), /KHR_gaussian_splatting/);
  assert.match(message('aborted'), /中止/);
  // An unmapped variant keeps the original message instead of being swallowed.
  assert.equal(message('something-new'), 'raw');
});

test('describeGaussianSplatImportError falls back to the raw message', () => {
  assert.equal(describeGaussianSplatImportError(new Error('boom')), 'boom');
  assert.match(describeGaussianSplatImportError(null), /失敗しました/);
});

test('a revived worker error is described like the original', () => {
  // Errors that crossed postMessage are plain objects rebuilt by name, so the
  // instanceof check alone would miss them.
  const revived = Object.assign(new Error('raw'), {
    name: 'UnsupportedSplatInputError',
    variant: 'not-gaussian-splat',
  });
  assert.match(describeGaussianSplatImportError(revived), /Gaussian Splatではない/);
});

test('formatBytes scales units', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2.00 GB');
  assert.equal(formatBytes(NaN), '不明');
});
