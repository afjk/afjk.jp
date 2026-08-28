import {
  SCENE_SYNC_GAUSSIAN_SPLAT_PATCH,
  loadSceneSyncGaussianSplatLoaderExtension,
} from './gaussian-splat-three-patch.js';

let gaussianSplatLoaderExtension = null;

export async function initializeSceneSyncGLTFLoaderExtensions() {
  gaussianSplatLoaderExtension ||= await loadSceneSyncGaussianSplatLoaderExtension();
  return gaussianSplatLoaderExtension;
}

export async function registerSceneSyncGLTFLoaderExtensions(loader) {
  const extension = await initializeSceneSyncGLTFLoaderExtensions();
  loader.register((parser) => new extension(parser));
  return loader;
}

export function getSceneSyncGLTFLoaderExtensionDiagnostics() {
  return {
    initialized: typeof gaussianSplatLoaderExtension === 'function',
    gaussianSplatPatch: SCENE_SYNC_GAUSSIAN_SPLAT_PATCH,
  };
}
