import { GLTFGaussianSplatLoaderExtension } from 'three/addons/loaders/GLTFGaussianSplatLoaderExtension.js';

export function registerSceneSyncGLTFLoaderExtensions(loader) {
  loader.register((parser) => new GLTFGaussianSplatLoaderExtension(parser));
  return loader;
}
