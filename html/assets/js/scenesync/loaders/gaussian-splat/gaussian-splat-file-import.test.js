import test from 'node:test';
import assert from 'node:assert/strict';

import {
  convertGaussianSplatFileToGlb,
  describeGaussianSplatImportError,
  formatBytes,
  gaussianSplatGlbName,
  isGaussianSplatFile,
  MAX_SOURCE_BYTES,
} from './gaussian-splat-file-import.js';
import {
  UnsupportedPlyVariantError,
  UnsupportedSpzError,
} from './import-gaussian-splat.js';
import { inspectGaussianSplatGlb, parseGlbJson } from '../khr-gaussian-splatting.js';
import { buildGaussianSplatPly, buildSpzPayload, gzipBytes } from './test-fixtures.mjs';

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

function plyFile(name = 'capture.ply', splats = SAMPLE) {
  return new File([buildGaussianSplatPly(splats)], name);
}

test('isGaussianSplatFile matches only .ply and .spz', () => {
  assert.equal(isGaussianSplatFile(new File([], 'a.ply')), true);
  assert.equal(isGaussianSplatFile(new File([], 'a.PLY')), true);
  assert.equal(isGaussianSplatFile(new File([], 'a.spz')), true);
  assert.equal(isGaussianSplatFile(new File([], 'a.glb')), false);
  assert.equal(isGaussianSplatFile(new File([], 'a.png')), false);
  assert.equal(isGaussianSplatFile(null), false);
});

test('gaussianSplatGlbName swaps the extension', () => {
  assert.equal(gaussianSplatGlbName('capture.ply'), 'capture.glb');
  assert.equal(gaussianSplatGlbName('scan.SPZ'), 'scan.glb');
  assert.equal(gaussianSplatGlbName('room.v2.ply'), 'room.v2.glb');
  assert.equal(gaussianSplatGlbName(''), 'gaussian-splats.glb');
});

test('convertGaussianSplatFileToGlb returns a loadable GLB File', async () => {
  const result = await convertGaussianSplatFileToGlb(plyFile());

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
  const result = await convertGaussianSplatFileToGlb(spz);

  assert.equal(result.file.name, 'room.glb');
  assert.equal(result.sourceFormat, 'spz');
  assert.equal(result.splatCount, 2);

  const glb = new Uint8Array(await result.file.arrayBuffer());
  assert.equal(inspectGaussianSplatGlb(glb).valid, true);
});

test('convertGaussianSplatFileToGlb reports progress phases in order', async () => {
  const phases = [];
  await convertGaussianSplatFileToGlb(plyFile(), {
    onProgress: ({ phase }) => phases.push(phase),
  });

  assert.deepEqual(phases, ['reading', 'converting', 'converted']);
});

test('convertGaussianSplatFileToGlb passes upAxisCorrection through', async () => {
  const result = await convertGaussianSplatFileToGlb(plyFile(), {
    upAxisCorrection: 'flip-x-180',
  });

  const glb = new Uint8Array(await result.file.arrayBuffer());
  assert.deepEqual(parseGlbJson(glb).nodes[0].rotation, [1, 0, 0, 0]);
});

test('convertGaussianSplatFileToGlb rejects a non-splat extension', async () => {
  await assert.rejects(
    () => convertGaussianSplatFileToGlb(new File([], 'model.glb')),
    /Gaussian Splatファイルではありません/,
  );
});

test('convertGaussianSplatFileToGlb rejects a file over the upload limit', async () => {
  // Report a large size without allocating it.
  const file = plyFile();
  Object.defineProperty(file, 'size', { value: MAX_SOURCE_BYTES + 1 });

  await assert.rejects(
    () => convertGaussianSplatFileToGlb(file),
    /大きすぎます/,
  );
});

test('convertGaussianSplatFileToGlb surfaces the underlying variant error', async () => {
  const notSplat = new File([new TextEncoder().encode([
    'ply', 'format ascii 1.0', 'element vertex 1',
    'property float x', 'property float y', 'property float z',
    'end_header', '0 0 0', '',
  ].join('\n'))], 'cloud.ply');

  await assert.rejects(
    () => convertGaussianSplatFileToGlb(notSplat),
    (error) => {
      assert.ok(error instanceof UnsupportedPlyVariantError);
      assert.equal(error.variant, 'not-gaussian-splat');
      return true;
    },
  );
});

test('describeGaussianSplatImportError explains each PLY variant', () => {
  const message = (variant) => describeGaussianSplatImportError(
    new UnsupportedPlyVariantError('raw', variant),
  );

  assert.match(message('not-gaussian-splat'), /Gaussian Splatではない/);
  assert.match(message('compressed-chunked'), /圧縮PLY/);
  assert.match(message('list-properties'), /list/);
  assert.match(message('sparse-f-rest'), /f_rest/);
  // An unmapped variant keeps the original message instead of being swallowed.
  assert.equal(message('something-new'), 'raw');
});

test('describeGaussianSplatImportError explains SPZ and generic failures', () => {
  assert.match(
    describeGaussianSplatImportError(new UnsupportedSpzError('Unsupported SPZ version: 9', 'version')),
    /未対応のSPZバージョン/,
  );
  assert.equal(describeGaussianSplatImportError(new Error('boom')), 'boom');
  assert.match(describeGaussianSplatImportError(null), /失敗しました/);
});

test('formatBytes scales units', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2.00 GB');
  assert.equal(formatBytes(NaN), '不明');
});

test('the converted GLB carries the full SH set when the source has one', async () => {
  const shRest = Array.from({ length: 45 }, (_, i) => i / 100);
  const file = new File(
    [buildGaussianSplatPly([{ ...SAMPLE[0], shRest }], { shDegree: 3 })],
    'detailed.ply',
  );

  const result = await convertGaussianSplatFileToGlb(file);
  assert.equal(result.shDegree, 3);

  const glb = new Uint8Array(await result.file.arrayBuffer());
  const attributes = parseGlbJson(glb).meshes[0].primitives[0].attributes;
  assert.ok('KHR_gaussian_splatting:SH_DEGREE_3_COEF_6' in attributes);
});
