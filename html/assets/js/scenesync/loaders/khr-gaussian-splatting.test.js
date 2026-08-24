import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
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

test('minimal fixture matches the Three.js native KHR loader input contract', async () => {
  const fixtureUrl = new URL('../../../../scenesync/experiments/fixtures/minimal-khr-gaussian-splatting.glb', import.meta.url);
  const bytes = await readFile(fixtureUrl);
  const json = parseGlbJson(bytes);
  const inspection = inspectGaussianSplatGltf(json);

  assert.equal(inspection.valid, true);
  assert.equal(inspection.primitives.length, 1);

  const primitive = inspection.primitives[0].primitive;
  const positionAccessor = json.accessors[primitive.attributes.POSITION];
  const rotationAccessor = json.accessors[primitive.attributes['KHR_gaussian_splatting:ROTATION']];
  const scaleAccessor = json.accessors[primitive.attributes['KHR_gaussian_splatting:SCALE']];
  const opacityAccessor = json.accessors[primitive.attributes['KHR_gaussian_splatting:OPACITY']];
  const sh0Accessor = json.accessors[primitive.attributes['KHR_gaussian_splatting:SH_DEGREE_0_COEF_0']];

  assert.equal(positionAccessor.count, 8);
  assert.equal(positionAccessor.type, 'VEC3');
  assert.equal(rotationAccessor.count, 8);
  assert.equal(rotationAccessor.type, 'VEC4');
  assert.equal(scaleAccessor.count, 8);
  assert.equal(scaleAccessor.type, 'VEC3');
  assert.equal(opacityAccessor.count, 8);
  assert.equal(opacityAccessor.type, 'SCALAR');
  assert.equal(sh0Accessor.count, 8);
  assert.equal(sh0Accessor.type, 'VEC3');
});
