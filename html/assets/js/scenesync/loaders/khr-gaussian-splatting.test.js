import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  decodeGaussianSplatGlb,
  inspectGaussianSplatGlb,
  inspectGaussianSplatGltf,
  parseGlbJson,
} from './khr-gaussian-splatting.js';

function makeValidJson() {
  return {
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_gaussian_splatting'],
    meshes: [{
      primitives: [{
        mode: 0,
        attributes: {
          POSITION: 0,
          'KHR_gaussian_splatting:ROTATION': 1,
          'KHR_gaussian_splatting:SCALE': 2,
          'KHR_gaussian_splatting:OPACITY': 3,
          'KHR_gaussian_splatting:SH_DEGREE_0_COEF_0': 4,
        },
        extensions: {
          KHR_gaussian_splatting: {
            kernel: 'ellipse',
            colorSpace: 'srgb_rec709_display',
            projection: 'perspective',
            sortingMethod: 'cameraDistance',
          },
        },
      }],
    }],
  };
}

function makeGlb(json) {
  const raw = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(raw.byteLength / 4) * 4;
  const totalLength = 12 + 8 + jsonLength;
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, totalLength);
  bytes.set(raw, 20);
  return bytes;
}

test('inspectGaussianSplatGltf accepts the KHR base ellipse representation', () => {
  const result = inspectGaussianSplatGltf(makeValidJson());
  assert.equal(result.hasGaussianSplatting, true);
  assert.equal(result.extensionDeclared, true);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.primitives.length, 1);
});

test('inspectGaussianSplatGltf reports POINTS and required attribute violations', () => {
  const json = makeValidJson();
  json.meshes[0].primitives[0].mode = 4;
  delete json.meshes[0].primitives[0].attributes['KHR_gaussian_splatting:OPACITY'];

  const result = inspectGaussianSplatGltf(json);
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /mode must be POINTS/);
  assert.match(result.errors[1], /OPACITY/);
});

test('inspectGaussianSplatGltf requires extensionsUsed declaration', () => {
  const json = makeValidJson();
  json.extensionsUsed = [];
  const result = inspectGaussianSplatGltf(json);
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /extensionsUsed/);
});

test('parseGlbJson reads a padded GLB JSON chunk', () => {
  const json = makeValidJson();
  assert.deepEqual(parseGlbJson(makeGlb(json)), json);
});

test('inspectGaussianSplatGlb inspects a GLB directly', () => {
  const result = inspectGaussianSplatGlb(makeGlb(makeValidJson()));
  assert.equal(result.valid, true);
  assert.equal(result.primitives[0].extension.kernel, 'ellipse');
});

test('minimal fixture is a real KHR_gaussian_splatting GLB and decodes 8 splats', async () => {
  const fixtureUrl = new URL('../../../../scenesync/experiments/fixtures/minimal-khr-gaussian-splatting.glb', import.meta.url);
  const bytes = await readFile(fixtureUrl);
  const decoded = decodeGaussianSplatGlb(bytes);

  assert.equal(decoded.inspection.valid, true);
  assert.equal(decoded.primitives.length, 1);
  assert.equal(decoded.primitives[0].splats.length, 8);

  const first = decoded.primitives[0].splats[0];
  assert.deepEqual(first.position.map((value) => Number(value.toFixed(3))), [-0.6, -0.4, 0]);
  assert.deepEqual(first.rotation, [0, 0, 0, 1]);
  assert.ok(Math.abs(first.opacity - 0.95) < 1e-5);
  assert.ok(first.color[0] > 0.99);
  assert.ok(first.color[1] > 0.19 && first.color[1] < 0.21);
  assert.ok(first.color[2] > 0.19 && first.color[2] < 0.21);
});
