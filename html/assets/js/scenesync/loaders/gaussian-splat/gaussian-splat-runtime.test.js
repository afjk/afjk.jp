import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGaussianSplatSortScheduler,
  disposeObject3DResources,
  ensureSceneSyncMeshNormals,
  inspectGaussianSplats,
  prepareGaussianSplatRoot,
  shouldAutoScaleSceneSyncGlb,
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
    boundingBox: null,
    splatGeometry: {
      getAttribute(name) {
        return name === 'position' ? { count: 16 } : null;
      },
    },
    computeBoundingBox() { boxComputes += 1; this.boundingBox = {}; },
    computeBoundingSphere() {
      sphereComputes += 1;
      this.boundingBox = {};
    },
  };
  const root = traversable([gaussian, { isMesh: true }]);

  const diagnostics = prepareGaussianSplatRoot(root, null, { selectionProxy: false });
  assert.equal(diagnostics.hasGaussianSplat, true);
  assert.equal(diagnostics.gaussianObjects, 1);
  assert.equal(diagnostics.splatCount, 16);
  assert.equal(root.userData.scenesync.hasGaussianSplat, true);
  assert.equal(root.userData.scenesync.gaussianSplatCount, 16);
  assert.equal(boxComputes, 0, 'bounding box must not be scanned twice');
  assert.equal(sphereComputes, 1);
});

test('Gaussian captures preserve authored scale while conventional GLBs keep auto scaling', () => {
  assert.equal(shouldAutoScaleSceneSyncGlb({ hasGaussianSplat: true }), false);
  assert.equal(shouldAutoScaleSceneSyncGlb({ hasGaussianSplat: false }), true);
  assert.equal(shouldAutoScaleSceneSyncGlb(null), true);
});

test('WebGL Gaussian CPU sorting is bounded while WebGPU and XR keep native sorting', () => {
  let sorts = 0;
  const gaussian = {
    isGaussianSplat: true,
    visible: true,
    autoSort: true,
    updateSort() { sorts += 1; },
  };
  const root = traversable([gaussian, { isMesh: true }]);
  const camera = {};
  const scheduler = createGaussianSplatSortScheduler({ minIntervalMs: 250 });
  const webgl = { backend: { isWebGLBackend: true } };

  assert.equal(scheduler.update({ root, renderer: webgl, camera, now: 0 }).sortCalls, 1);
  assert.equal(gaussian.autoSort, false);
  assert.equal(scheduler.update({ root, renderer: webgl, camera, now: 100 }).sortCalls, 0);
  assert.equal(scheduler.update({ root, renderer: webgl, camera, now: 250 }).sortCalls, 1);
  assert.equal(sorts, 2);

  assert.equal(scheduler.update({
    root,
    renderer: webgl,
    camera,
    now: 260,
    continuous: true,
  }).mode, 'native');
  assert.equal(gaussian.autoSort, true, 'WebXR must retain native view-dependent sorting');

  scheduler.update({ root, renderer: { backend: {} }, camera, now: 270 });
  assert.equal(gaussian.autoSort, true, 'WebGPU sorting must stay on Three.js compute');
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
