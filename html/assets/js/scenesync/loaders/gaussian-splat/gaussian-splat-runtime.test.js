import test from 'node:test';
import assert from 'node:assert/strict';

import {
  disposeObject3DResources,
  ensureSceneSyncMeshNormals,
  inspectGaussianSplats,
  prepareGaussianSplatRoot,
} from '../gaussian-splat-runtime.js';

function traversable(objects) {
  return {
    userData: {},
    traverse(visitor) {
      for (const object of objects) visitor(object);
    },
  };
}

test('lit conventional meshes receive normals when glTF omits NORMAL', () => {
  let normal = null;
  let computes = 0;
  const geometry = {
    getAttribute(name) {
      if (name === 'position') return { count: 3 };
      if (name === 'normal') return normal;
      return null;
    },
    computeVertexNormals() {
      computes += 1;
      normal = { count: 3 };
    },
  };
  const root = traversable([
    { isMesh: true, geometry, material: { isMeshStandardMaterial: true } },
    { isMesh: true, geometry, material: { isMeshBasicMaterial: true } },
    { isMesh: true, isGaussianSplat: true, geometry, material: { isMeshStandardMaterial: true } },
  ]);

  assert.equal(ensureSceneSyncMeshNormals(root), 1);
  assert.equal(computes, 1);
});

test('Gaussian diagnostics use isGaussianSplat and preserve the source splat count', () => {
  let boxComputes = 0;
  let sphereComputes = 0;
  const gaussian = {
    isGaussianSplat: true,
    splatGeometry: {
      getAttribute(name) {
        return name === 'position' ? { count: 16 } : null;
      },
    },
    computeBoundingBox() { boxComputes += 1; },
    computeBoundingSphere() { sphereComputes += 1; },
  };
  const root = traversable([gaussian, { isMesh: true }]);

  const diagnostics = prepareGaussianSplatRoot(root, null, { selectionProxy: false });
  assert.equal(diagnostics.hasGaussianSplat, true);
  assert.equal(diagnostics.gaussianObjects, 1);
  assert.equal(diagnostics.splatCount, 16);
  assert.equal(root.userData.scenesync.hasGaussianSplat, true);
  assert.equal(root.userData.scenesync.gaussianSplatCount, 16);
  assert.equal(boxComputes, 1);
  assert.equal(sphereComputes, 1);
});

test('resource disposal covers Gaussian source geometry without private fields', () => {
  const disposed = [];
  const texture = { isTexture: true, dispose: () => disposed.push('texture') };
  const material = { map: texture, dispose: () => disposed.push('material') };
  const geometry = { dispose: () => disposed.push('geometry') };
  const splatGeometry = { dispose: () => disposed.push('splatGeometry') };
  const root = traversable([{ geometry, splatGeometry, material }]);

  disposeObject3DResources(root);
  assert.deepEqual(new Set(disposed), new Set(['texture', 'material', 'geometry', 'splatGeometry']));
  assert.equal(inspectGaussianSplats(root).hasGaussianSplat, false);
});
