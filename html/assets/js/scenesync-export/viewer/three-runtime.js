// Temporary pin until Three.js r186 is released.
// Native Gaussian Splatting landed after r185 and requires the WebGPU build,
// including its WebGL fallback backend.
export const SCENE_SYNC_THREE_REVISION =
  'cbba126004263d0c32d3d6d05a4fe218d261fa47';

export const SCENE_SYNC_THREE_BASE_URL =
  `https://cdn.jsdelivr.net/gh/mrdoob/three.js@${SCENE_SYNC_THREE_REVISION}/`;

export const SCENE_SYNC_THREE_IMPORTS = Object.freeze({
  three: `${SCENE_SYNC_THREE_BASE_URL}build/three.webgpu.js`,
  'three/webgpu': `${SCENE_SYNC_THREE_BASE_URL}build/three.webgpu.js`,
  'three/tsl': `${SCENE_SYNC_THREE_BASE_URL}build/three.tsl.js`,
  'three/addons/': `${SCENE_SYNC_THREE_BASE_URL}examples/jsm/`,
});

export const SCENE_SYNC_DRACO_DECODER_PATH =
  `${SCENE_SYNC_THREE_BASE_URL}examples/jsm/libs/draco/gltf/`;

export const SCENE_SYNC_THREE_RUNTIME_LABEL =
  `three.js dev @ ${SCENE_SYNC_THREE_REVISION}`;

export function shouldUseSceneSyncWebGPUBackend(search = globalThis.location?.search || '') {
  return new URLSearchParams(search).get('webgpu') === '1';
}

export function createSceneSyncRendererOptions(options = {}, search) {
  return {
    ...options,
    forceWebGL: !shouldUseSceneSyncWebGPUBackend(search),
  };
}

export function getSceneSyncRendererBackend(renderer) {
  return renderer?.backend?.isWebGLBackend === true ? 'webgl' : 'webgpu';
}
