function gaussianSplatCount(object) {
  return object?.splatGeometry?.getAttribute?.('position')?.count || 0;
}

export function inspectGaussianSplats(root) {
  const objects = [];
  let splatCount = 0;

  root?.traverse?.((object) => {
    if (object?.isGaussianSplat !== true) return;
    object.computeBoundingBox?.();
    object.computeBoundingSphere?.();
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
