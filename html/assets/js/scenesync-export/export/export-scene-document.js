import { SCENE_DOCUMENT_FORMAT, SCENE_DOCUMENT_VERSION } from '../viewer/scene-document.js';
import { LOOMLET_RUNTIME_METADATA } from '../../scenesync/loomlet-runtime-integration.js';
import { normalizeAudioSourcesMap } from '../../scenesync/audio/audio-source.js';

const SKIP_ROLES = new Set([
  'multi-transform-pivot',
  'paste-preview',
  'placement-floor',
]);

function cloneJson(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}

function clonePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return cloneJson(value);
}

function copyStringField(target, source, key) {
  if (typeof source?.[key] === 'string') target[key] = source[key];
}

function copyFiniteNumberField(target, source, key) {
  if (Number.isFinite(source?.[key])) target[key] = source[key];
}

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
  const clipName = typeof raw.clipName === 'string' && raw.clipName.trim()
    ? raw.clipName.trim()
    : clips?.[safeClip]?.name || null;

  const state = {
    enabled: raw.enabled !== false,
    clip: safeClip,
    mode: raw.mode === 'once' ? 'once' : 'loop',
    speed: Number.isFinite(raw.speed) ? raw.speed : 1,
  };

  if (clipName) {
    state.clipName = clipName;
  }
  if (Number.isFinite(raw.offset)) {
    state.offset = raw.offset;
  }

  return state;
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

  if (asset.type === 'image') {
    const entry = {
      type: 'image',
      source: asset.source || 'url',
      url: asset.url || null,
      path: null, // filled by collect-export-assets.js
    };
    copyStringField(entry, asset, 'mime');
    copyFiniteNumberField(entry, asset, 'width');
    copyFiniteNumberField(entry, asset, 'height');
    copyStringField(entry, asset, 'assetId');
    copyStringField(entry, asset, 'originalName');
    return entry;
  }

  if (asset.type === 'video') {
    const entry = {
      type: 'video',
      source: asset.source || 'url',
      url: asset.url || null,
      path: null, // filled by collect-export-assets.js
    };
    copyStringField(entry, asset, 'mime');
    copyFiniteNumberField(entry, asset, 'width');
    copyFiniteNumberField(entry, asset, 'height');
    copyStringField(entry, asset, 'assetId');
    copyStringField(entry, asset, 'originalName');
    return entry;
  }

  if (asset.type === 'text') {
    const entry = {
      type: 'text',
      source: asset.source || 'inline',
      format: asset.format || 'plain',
      fontFamily: asset.fontFamily || 'system-sans',
      fontSize: asset.fontSize || 32,
      fontWeight: asset.fontWeight || 'normal',
      fontStyle: asset.fontStyle || 'normal',
      color: asset.color || '#ffffff',
      backgroundColor: asset.backgroundColor || 'rgba(0,0,0,0.65)',
      align: asset.align || 'center',
    };
    const layout = clonePlainObject(asset.layout);
    if (layout) entry.layout = layout;
    const scroll = clonePlainObject(asset.scroll);
    if (scroll) entry.scroll = scroll;
    if (asset.source === 'inline') {
      entry.text = asset.text || '';
    } else {
      entry.url = asset.url || null;
      entry.path = null; // filled by collect-export-assets.js
    }
    return entry;
  }

  // mesh → GLB via meshPath
  const meshPath = obj.userData?.meshPath || asset.meshPath || null;
  const assetId = asset.assetId || obj.userData?.assetId || obj.userData?.scenesync?.assetId || null;

  const entry = {
    type: 'mesh',
    source: asset.source || (asset.url ? 'url' : 'carrier'),
    // path will be filled by collect-export-assets.js
    path: null,
    meshPath,
    assetId,
    mime: asset.mime || 'model/gltf-binary',
    visualBasis: asset.visualBasis || null,
    originalName: asset.originalName || null,
  };

  copyStringField(entry, asset, 'url');
  return entry;
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
  behaviorState = null,
  physicsState = null,
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
    // Skip objects that have no renderable asset representation
    if (!asset) continue;

    const docObj = {
      id: objectId,
      name: obj.userData?.name || obj.name || objectId,
      asset,
      position: obj.position.toArray(),
      rotation: obj.quaternion.toArray(),
      scale: obj.scale.toArray(),
      visible: obj.visible !== false,
    };

    const metadata = clonePlainObject(obj.userData?.metadata);
    if (metadata) {
      docObj.metadata = metadata;
    }

    const animation = getAnimationState(obj);
    if (animation) {
      docObj.animation = animation;
    }

    const audioSources = normalizeAudioSourcesMap(obj.userData?.audioSources);
    if (Object.keys(audioSources).length > 0) {
      docObj.audioSources = audioSources;
    }

    const physics = clonePlainObject(obj.userData?.physics);
    if (physics) {
      docObj.physics = physics;
    }

    objects.push(docObj);
  }

  const doc = {
    format: SCENE_DOCUMENT_FORMAT,
    version: SCENE_DOCUMENT_VERSION,
    units: 'meters',
    loomletRuntime: { ...LOOMLET_RUNTIME_METADATA },
    objects,
    skybox: buildSkyboxEntry(envId),
    bgm: buildBgmEntry(bgmState),
  };

  if (behaviorState) {
    doc.behaviors = JSON.parse(JSON.stringify(behaviorState));
  }

  const physics = clonePlainObject(physicsState);
  if (physics?.enabled) {
    doc.physics = physics;
  }

  return doc;
}
