import { SCENE_DOCUMENT_FORMAT, SCENE_DOCUMENT_VERSION } from '../viewer/scene-document.js';

const SKIP_ROLES = new Set([
  'multi-transform-pivot',
  'paste-preview',
  'placement-floor',
]);

function getAnimationState(obj) {
  const raw =
    obj?.userData?.animationState ||
    obj?.userData?.scenesync?.animationState ||
    null;
  if (!raw) return null;

  const clips = obj?.userData?.scenesync?.animations;
  const clipCount = Array.isArray(clips) ? clips.length : 0;
  const clipIndex = Number.isInteger(raw.clip) ? raw.clip : 0;
  // Only clamp if we actually know the clip count
  const safeClip = clipCount > 0 ? Math.max(0, Math.min(clipIndex, clipCount - 1)) : Math.max(0, clipIndex);

  return {
    enabled: raw.enabled !== false,
    clip: safeClip,
    mode: raw.mode === 'once' ? 'once' : 'loop',
    speed: Number.isFinite(raw.speed) ? raw.speed : 1,
  };
}

function buildAssetEntry(obj) {
  const asset = obj?.userData?.asset;
  if (!asset) return null;

  if (asset.type === 'primitive') {
    return {
      type: 'primitive',
      primitive: asset.primitive || 'box',
      color: asset.color || '#888888',
    };
  }

  // mesh / image / text → all stored as GLB via meshPath
  const meshPath = obj.userData?.meshPath || asset.meshPath || null;

  return {
    type: 'mesh',
    // path will be filled by collect-export-assets.js
    path: null,
    meshPath,
    mime: asset.mime || 'model/gltf-binary',
    visualBasis: asset.visualBasis || null,
    originalName: asset.originalName || null,
  };
}

function buildSkyboxEntry(envId) {
  if (!envId) return null;
  return {
    type: 'env',
    envId,
    // asset.path filled by collect-export-assets.js
    asset: { path: null },
  };
}

function buildBgmEntry(bgmState) {
  if (!bgmState?.url) return null;
  return {
    url: bgmState.url,
    name: bgmState.name || 'bgm',
    loop: bgmState.loop !== false,
    volume: Number.isFinite(bgmState.volume) ? bgmState.volume : 1,
    // asset.path filled by collect-export-assets.js
    asset: { path: null },
  };
}

export function createSceneDocumentFromSceneSyncState({
  managedObjects,
  bgmState,
  envId,
}) {
  if (!(managedObjects instanceof Map)) {
    throw new Error('managedObjects must be a Map');
  }

  const objects = [];

  for (const [objectId, obj] of managedObjects) {
    if (!obj) continue;
    if (obj.userData?.nonSerializable) continue;
    if (obj.userData?._temporary) continue;

    const role = obj.userData?.role || obj.userData?.metadata?.role;
    if (role && SKIP_ROLES.has(role)) continue;

    const asset = buildAssetEntry(obj);

    const docObj = {
      id: objectId,
      name: obj.userData?.name || obj.name || objectId,
      asset,
      position: obj.position.toArray(),
      rotation: obj.quaternion.toArray(),
      scale: obj.scale.toArray(),
      visible: obj.visible !== false,
    };

    const animation = getAnimationState(obj);
    if (animation) {
      docObj.animation = animation;
    }

    objects.push(docObj);
  }

  return {
    format: SCENE_DOCUMENT_FORMAT,
    version: SCENE_DOCUMENT_VERSION,
    units: 'meters',
    objects,
    skybox: buildSkyboxEntry(envId),
    bgm: buildBgmEntry(bgmState),
  };
}
