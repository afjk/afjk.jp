// Upserts every object in a SceneDocument into the current scene.
// Objects with an existing objectId are updated in place; new objectIds are added.
// Objects not present in the document are left untouched (no scene clear).
//
// Objects marked with `importAsset.kind === 'glb-file'` are loaded from the
// ZIP via `importGlbFileAsSceneObject`, reusing the normal GLB-file import
// route with an explicit objectId/transform. All other objects go through
// `addOrUpdateObject` + `broadcast` as before.
import { uploadZipAsset } from './zip-asset-upload.js';

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function cleanUploadedAsset(asset, uploaded) {
  const next = {
    ...(asset || {}),
    url: uploaded.url,
    mime: uploaded.mime || asset?.mime,
  };

  if (next.type === 'text') {
    next.source = 'url';
  } else {
    next.source = 'blob';
  }

  delete next.path;
  return next;
}

function cleanUploadedAudioSource(source, uploaded) {
  const next = {
    ...(source || {}),
    url: uploaded.url,
  };
  delete next.asset;
  return next;
}

function appendImportWarning(metadata, warning) {
  const previous = typeof metadata?.importWarning === 'string'
    ? metadata.importWarning.trim()
    : '';
  if (previous && previous.includes(warning)) {
    return metadata || {};
  }
  return {
    ...(metadata || {}),
    importWarning: previous ? `${previous}; ${warning}` : warning,
  };
}

function placeholderAssetForFailedZipImport(asset) {
  return {
    type: 'primitive',
    primitive: 'box',
    color: '#ff4d4f',
    missingAssetType: asset?.type || 'unknown',
  };
}

function cleanFailedZipBackedAsset(asset, plan) {
  const next = { ...(asset || {}) };
  delete next.path;

  if (next.url) {
    return {
      asset: next,
      fallbackUsed: true,
    };
  }

  return {
    asset: placeholderAssetForFailedZipImport(asset),
    fallbackUsed: false,
    warning: `ZIP asset could not be re-uploaded: ${plan?.path || '(unknown)'}`,
  };
}

function cleanFailedZipBackedAudioSource(source) {
  if (!source?.url) return null;
  const next = { ...source };
  delete next.asset;
  return next;
}

async function prepareZipBackedObjectAssets(obj, {
  zip,
  uploadBlobToStore,
} = {}) {
  let asset = cloneJson(obj.asset);
  let audioSources = cloneJson(obj.audioSources);
  let metadata = cloneJson(obj.metadata);
  let skippedAssets = 0;

  if (obj.importAsset?.kind === 'blob-file') {
    const uploaded = await uploadZipAsset({
      zip,
      plan: obj.importAsset,
      uploadBlobToStore,
    });

    if (uploaded) {
      asset = cleanUploadedAsset(asset, uploaded);
    } else {
      const cleaned = cleanFailedZipBackedAsset(asset, obj.importAsset);
      asset = cleaned.asset;
      if (!cleaned.fallbackUsed) {
        skippedAssets += 1;
        metadata = appendImportWarning(metadata, cleaned.warning);
      }
    }
  }

  const audioPlans = obj.importAudioSources || {};
  for (const [name, plan] of Object.entries(audioPlans)) {
    const source = audioSources?.[name];
    if (!source || !plan?.path) continue;

    const uploaded = await uploadZipAsset({
      zip,
      plan,
      uploadBlobToStore,
    });

    if (uploaded) {
      audioSources = {
        ...(audioSources || {}),
        [name]: cleanUploadedAudioSource(source, uploaded),
      };
    } else {
      const cleanedSource = cleanFailedZipBackedAudioSource(source);
      audioSources = { ...(audioSources || {}) };
      if (cleanedSource) {
        audioSources[name] = cleanedSource;
      } else {
        delete audioSources[name];
        skippedAssets += 1;
        metadata = appendImportWarning(
          metadata,
          `ZIP audio source could not be re-uploaded: ${plan.path || '(unknown)'}`
        );
      }
    }
  }

  if (asset?.path && !obj.importAsset) {
    const cleaned = cleanFailedZipBackedAsset(asset, { path: asset.path });
    asset = cleaned.asset;
    if (!cleaned.fallbackUsed) {
      skippedAssets += 1;
      metadata = appendImportWarning(metadata, cleaned.warning);
    }
  }

  if (audioSources && typeof audioSources === 'object' && !Array.isArray(audioSources)) {
    for (const [name, source] of Object.entries(audioSources)) {
      if (!source?.asset?.path) continue;
      const cleanedSource = cleanFailedZipBackedAudioSource(source);
      audioSources = { ...audioSources };
      if (cleanedSource) {
        audioSources[name] = cleanedSource;
      } else {
        delete audioSources[name];
        skippedAssets += 1;
        metadata = appendImportWarning(
          metadata,
          `ZIP audio source could not be re-uploaded: ${source.asset.path || '(unknown)'}`
        );
      }
    }
  }

  return { asset, audioSources, metadata, skippedAssets };
}

export async function applySceneDocument(sceneDocument, {
  managedObjects,
  addOrUpdateObject,
  broadcast,
  importGlbFileAsSceneObject,
  zip,
  uploadBlobToStore,
  existingObjectIds,
  onProgress,
} = {}) {
  let added = 0;
  let updated = 0;
  let glbImported = 0;
  let skippedAssets = 0;
  const total = sceneDocument.objects?.length || 0;
  let processed = 0;

  function reportProgress(obj) {
    processed += 1;
    onProgress?.({
      total,
      processed,
      objectId: obj?.id || null,
      added,
      updated,
      glbImported,
      skippedAssets,
    });
  }

  for (const obj of sceneDocument.objects || []) {
    const existed = existingObjectIds instanceof Set
      ? existingObjectIds.has(obj.id)
      : managedObjects.has(obj.id);
    if (existed) {
      updated += 1;
    } else {
      added += 1;
    }

    const prepared = await prepareZipBackedObjectAssets(obj, {
      zip,
      uploadBlobToStore,
    });
    skippedAssets += prepared.skippedAssets;

    if (obj.importAsset?.kind === 'glb-file') {
      const entry = zip?.file(obj.importAsset.path);
      if (entry && importGlbFileAsSceneObject) {
        const buffer = await entry.async('arraybuffer');
        const file = new File(
          [buffer],
          obj.importAsset.originalName,
          { type: obj.importAsset.mime || 'model/gltf-binary' }
        );

        await importGlbFileAsSceneObject(file, {
          objectId: obj.id,
          name: obj.name || obj.id,
          position: obj.position,
          rotation: obj.rotation,
          scale: obj.scale,
          visible: obj.visible !== false,
          metadata: prepared.metadata,
          animation: obj.animation,
          audioSources: prepared.audioSources,
          selectAfterLoad: false,
          source: 'scene-sync-export-import',
        });

        glbImported += 1;
        reportProgress(obj);
        continue;
      }

      const cleaned = cleanFailedZipBackedAsset(prepared.asset, obj.importAsset);
      prepared.asset = cleaned.asset;
      if (!cleaned.fallbackUsed) {
        skippedAssets += 1;
        prepared.metadata = appendImportWarning(
          prepared.metadata,
          cleaned.warning || `ZIP asset could not be re-uploaded: ${obj.importAsset.path || '(unknown)'}`
        );
      }
    }

    const payload = {
      kind: 'scene-add',
      objectId: obj.id,
      name: obj.name || obj.id,
      position: obj.position,
      rotation: obj.rotation,
      scale: obj.scale,
      asset: prepared.asset,
      visible: obj.visible !== false,
    };

    if (prepared.metadata) payload.metadata = prepared.metadata;
    if (obj.animation) payload.animation = obj.animation;
    if (prepared.audioSources) payload.audioSources = prepared.audioSources;

    addOrUpdateObject(obj.id, payload, { source: 'scene-sync-export-import' });
    broadcast(payload);
    reportProgress(obj);
  }

  return {
    total,
    added,
    updated,
    glbImported,
    skippedAssets,
  };
}
