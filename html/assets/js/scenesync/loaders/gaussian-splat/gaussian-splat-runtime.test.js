import test from 'node:test';
import assert from 'node:assert/strict';

import {
  disposeObject3DResources,
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
