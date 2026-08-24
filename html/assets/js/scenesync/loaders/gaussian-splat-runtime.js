function gaussianSplatCount(object) {
  return object?.splatGeometry?.getAttribute?.('position')?.count || 0;
}

function materialNeedsNormals(material) {
  return Boolean(
    material?.isMeshStandardMaterial
    || material?.isMeshPhysicalMaterial
    || material?.isMeshLambertMaterial
    || material?.isMeshPhongMaterial
    || material?.isMeshToonMaterial
    || material?.isMeshNormalMaterial
  );
}

export function ensureSceneSyncMeshNormals(root) {
  let generated = 0;
  root?.traverse?.((object) => {
    if (!object?.isMesh || object.isGaussianSplat || object.isGaussianSplatSelectionProxy) return;
    const geometry = object.geometry;
    if (!geometry?.getAttribute?.('position') || geometry.getAttribute('normal')) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (!materials.some(materialNeedsNormals)) return;

    // NORMAL is optional in glTF. The pinned WebGPURenderer WebGL backend can
    // lose its constant default attribute binding on SwiftShader, so provide
    // the standard generated normals explicitly for lit conventional meshes.
    geometry.computeVertexNormals?.();
    if (geometry.getAttribute('normal')) generated += 1;
  });
  return generated;
}

export function inspectGaussianSplats(root) {
  const objects = [];
  let splatCount = 0;

  root?.traverse?.((object) => {
    if (object?.isGaussianSplat !== true) return;
    // Three.js computeBoundingSphere() also computes the splat-aware box.
    // Calling both methods would scan every Gaussian twice for the box, which
    // is noticeable on multi-million-splat captures.
    object.computeBoundingSphere?.();
    if (object.boundingBox == null) object.computeBoundingBox?.();
    objects.push(object);
    splatCount += gaussianSplatCount(object);
  });

  return {
    hasGaussianSplat: objects.length > 0,
    gaussianObjects: objects.length,
    splatCount,
    objects,
  };
}

export function shouldAutoScaleSceneSyncGlb(diagnostics) {
  // Captured Gaussian scenes use authored coordinates as world-scale spatial
  // data. Shrinking a large capture to the conventional-GLB 10m limit puts
  // every splat on screen at once and causes severe transparent overdraw.
  // Preserve the source scale; wrapper transforms remain fully synchronized.
  return diagnostics?.hasGaussianSplat !== true;
}

export function shouldGroundSceneSyncGlb(diagnostics) {
  // A Gaussian capture is usually a world-sized scene whose authored origin is
  // meaningful. Grounding its lowest bound (often a distant outlier) can move
  // the useful part of the capture tens of metres above the drop point. Keep
  // the wrapper origin at the requested placement, as SuperSplat does; normal
  // object-style GLBs retain Scene Sync's existing bottom-on-ground placement.
  return diagnostics?.hasGaussianSplat !== true;
}

function isHierarchyVisible(object) {
  for (let current = object; current; current = current.parent) {
    if (current.visible === false) return false;
  }
  return true;
}

export function createGaussianSplatFrustumTest(THREE) {
  if (!THREE?.Frustum || !THREE?.Matrix4 || !THREE?.Sphere) return () => true;

  const frustum = new THREE.Frustum();
  const projectionScreenMatrix = new THREE.Matrix4();
  const worldSphere = new THREE.Sphere();

  return (object, camera) => {
    if (!object?.boundingSphere || !camera?.projectionMatrix || !camera?.matrixWorldInverse) {
      return true;
    }

    camera.updateMatrixWorld?.();
    object.updateWorldMatrix?.(true, false);
    projectionScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projectionScreenMatrix);
    worldSphere.copy(object.boundingSphere).applyMatrix4(object.matrixWorld);
    return frustum.intersectsSphere(worldSphere);
  };
}

export function createGaussianSplatSortScheduler({
  minIntervalMs = 250,
  isObjectInView = null,
} = {}) {
  const initialized = new WeakSet();
  let lastSortAt = Number.NEGATIVE_INFINITY;

  return {
    update({ root, renderer, camera, now = performance.now(), continuous = false } = {}) {
      const isWebGL = renderer?.backend?.isWebGLBackend === true;
      const useNativeAutoSort = !isWebGL || continuous === true;
      const intervalElapsed = now - lastSortAt >= minIntervalMs;
      let gaussianObjects = 0;
      let sortCalls = 0;
      let skippedObjects = 0;

      root?.traverse?.((object) => {
        if (object?.isGaussianSplat !== true) return;
        gaussianObjects += 1;
        object.autoSort = useNativeAutoSort;

        // GaussianSplat's WebGL fallback sorts every splat synchronously on
        // the CPU. During OrbitControls damping that can run on many adjacent
        // frames. Use its public manual sort API at a bounded cadence, while
        // keeping Three.js native auto sorting for WebGPU and WebXR.
        if (useNativeAutoSort || !camera) return;
        if (!isHierarchyVisible(object) || isObjectInView?.(object, camera) === false) {
          skippedObjects += 1;
          return;
        }
        if (!initialized.has(object) || intervalElapsed) {
          object.updateSort?.(renderer, camera);
          initialized.add(object);
          sortCalls += 1;
        }
      });

      if (!useNativeAutoSort && intervalElapsed && gaussianObjects > 0) {
        lastSortAt = now;
      }

      return {
        mode: useNativeAutoSort ? 'native' : 'throttled-webgl',
        gaussianObjects,
        sortCalls,
        skippedObjects,
      };
    },
  };
}

export function addGaussianSplatSelectionProxy(root, THREE, diagnostics = inspectGaussianSplats(root)) {
  if (!diagnostics.hasGaussianSplat || !THREE?.Box3 || !THREE?.Mesh) return null;

  root.updateMatrixWorld?.(true);
  const bounds = new THREE.Box3().setFromObject(root);
  if (bounds.isEmpty()) return null;

  const inverseRoot = root.matrixWorld.clone().invert();
  bounds.applyMatrix4(inverseRoot);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  if (![size.x, size.y, size.z].every(Number.isFinite)) return null;

  const proxy = new THREE.Mesh(
    new THREE.BoxGeometry(
      Math.max(size.x, Number.EPSILON),
      Math.max(size.y, Number.EPSILON),
      Math.max(size.z, Number.EPSILON),
    ),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
    }),
  );
  proxy.name = 'Gaussian Splat Selection Proxy';
  proxy.position.copy(center);
  proxy.isGaussianSplatSelectionProxy = true;
  proxy.userData.nonSerializable = true;
  proxy.userData.role = 'gaussian-splat-selection-proxy';
  proxy.userData.isGaussianSplatSelectionProxy = true;
  root.add(proxy);

  // GaussianSplat inherits Mesh.raycast(), which only tests its internal unit
  // quad, not the source splat extent. Keep selection deterministic through
  // the bounds proxy until Three.js provides a native splat raycast.
  for (const object of diagnostics.objects) object.raycast = () => {};

  return proxy;
}

export function disposeObject3DResources(root) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();

  root?.traverse?.((object) => {
    if (object?.splatGeometry) geometries.add(object.splatGeometry);
    if (object?.geometry) geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object?.material)
      ? object.material
      : object?.material
        ? [object.material]
        : [];
    for (const material of objectMaterials) materials.add(material);
  });

  for (const material of materials) {
    for (const key of Object.keys(material)) {
      const value = material[key];
      if (value?.isTexture) textures.add(value);
    }
  }
  for (const texture of textures) texture.dispose?.();
  for (const material of materials) material.dispose?.();
  for (const geometry of geometries) geometry.dispose?.();
}

export function prepareGaussianSplatRoot(root, THREE, { selectionProxy = true } = {}) {
  ensureSceneSyncMeshNormals(root);
  const diagnostics = inspectGaussianSplats(root);
  if (!diagnostics.hasGaussianSplat) return diagnostics;

  root.userData = root.userData || {};
  root.userData.scenesync = {
    ...root.userData.scenesync,
    hasGaussianSplat: true,
    gaussianSplatCount: diagnostics.splatCount,
    gaussianSplatObjects: diagnostics.gaussianObjects,
  };

  if (selectionProxy) {
    addGaussianSplatSelectionProxy(root, THREE, diagnostics);
  }

  let disposed = false;
  const previousDisposable = root.userData.disposable;
  root.userData.disposable = () => {
    if (disposed) return;
    disposed = true;
    previousDisposable?.();
    disposeObject3DResources(root);
  };

  return diagnostics;
}
