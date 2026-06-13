import { inferMimeForExportAsset, makeZipAssetImportPlan } from './zip-asset-upload.js';

// Resolves SceneDocument objects for import, keeping primitives and inline
// text as-is, and passing through assets that already have a shareable URL.
//
// ZIP-bundled GLB ("mesh") assets are marked with an `importAsset` plan so
// applySceneDocument() can load them via the normal GLB-file import route.
//
// ZIP-bundled image/video/text/audio assets are marked with upload plans.
// applySceneDocument() uploads those files to the Scene Sync blob store and
// replaces asset.path with a shareable asset.url before broadcasting.
const ZIP_IMPORTABLE_ASSET_TYPES = new Set(['image', 'video', 'text']);

function zipHas(zip, path) {
  return Boolean(path && zip?.file?.(path));
}

function addImportWarning(obj, path) {
  return {
    ...obj,
    metadata: {
      ...(obj.metadata || {}),
      importWarning: `Asset not imported (unsupported in this version): ${path || '(unknown)'}`,
    },
  };
}

function resolveObjectAudioSources(obj, zip) {
  const audioSources = obj.audioSources;
  if (!audioSources || typeof audioSources !== 'object' || Array.isArray(audioSources)) {
    return obj;
  }

  const importAudioSources = {};
  for (const [name, source] of Object.entries(audioSources)) {
    const path = source?.asset?.path;
    if (!zipHas(zip, path)) continue;
    importAudioSources[name] = makeZipAssetImportPlan({
      path,
      mime: inferMimeForExportAsset(source.asset, 'audio/mpeg'),
      originalName: source.asset?.originalName,
    });
  }

  if (Object.keys(importAudioSources).length === 0) return obj;
  return { ...obj, importAudioSources };
}

function resolveBgm(bgm, zip) {
  const path = bgm?.asset?.path;
  if (!zipHas(zip, path)) return bgm;
  return {
    ...bgm,
    importAsset: makeZipAssetImportPlan({
      path,
      mime: inferMimeForExportAsset(bgm.asset, 'audio/mpeg'),
      originalName: bgm.asset?.originalName || bgm.name,
    }),
  };
}

export async function resolveSceneDocumentAssets(sceneDocument, { zip } = {}) {
  const objects = [];

  for (const obj of sceneDocument.objects || []) {
    const asset = obj.asset;

    if (!asset || asset.type === 'primitive') {
      objects.push(resolveObjectAudioSources(obj, zip));
      continue;
    }

    if (asset.type === 'text' && asset.source === 'inline') {
      objects.push(resolveObjectAudioSources(obj, zip));
      continue;
    }

    if (asset.type === 'mesh' && asset.path && zip?.file(asset.path)) {
      objects.push(resolveObjectAudioSources({
        ...obj,
        importAsset: {
          kind: 'glb-file',
          path: asset.path,
          originalName: asset.originalName || asset.path.split('/').pop() || `${obj.id}.glb`,
          mime: asset.mime || 'model/gltf-binary',
        },
      }, zip));
      continue;
    }

    if (ZIP_IMPORTABLE_ASSET_TYPES.has(asset.type) && asset.path && zipHas(zip, asset.path)) {
      objects.push(resolveObjectAudioSources({
        ...obj,
        importAsset: makeZipAssetImportPlan({
          path: asset.path,
          mime: inferMimeForExportAsset(asset),
          originalName: asset.originalName,
        }),
      }, zip));
      continue;
    }

    if (asset.url) {
      objects.push(resolveObjectAudioSources(obj, zip));
      continue;
    }

    objects.push(resolveObjectAudioSources(addImportWarning(obj, asset.path), zip));
  }

  return {
    document: {
      ...sceneDocument,
      objects,
      bgm: resolveBgm(sceneDocument.bgm, zip),
    },
  };
}
