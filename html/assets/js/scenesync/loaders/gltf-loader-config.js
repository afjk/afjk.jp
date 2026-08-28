import {
  SCENE_SYNC_GAUSSIAN_SPLAT_PATCH,
  loadSceneSyncGaussianSplatLoaderExtension,
} from './gaussian-splat-three-patch.js';

let gaussianSplatLoaderExtension = null;

export async function initializeSceneSyncGLTFLoaderExtensions() {
  gaussianSplatLoaderExtension ||= await loadSceneSyncGaussianSplatLoaderExtension();
  return gaussianSplatLoaderExtension;
}

export function registerSceneSyncGLTFLoaderExtensions(loader) {
  if (!gaussianSplatLoaderExtension) {
    throw new Error('Scene Sync GLTF loader extensions were not initialized');
  }
  loader.register((parser) => new gaussianSplatLoaderExtension(parser));
  return loader;
}

export function getSceneSyncGLTFLoaderExtensionDiagnostics() {
  return {
    initialized: typeof gaussianSplatLoaderExtension === 'function',
    gaussianSplatPatch: SCENE_SYNC_GAUSSIAN_SPLAT_PATCH,
  };
}
