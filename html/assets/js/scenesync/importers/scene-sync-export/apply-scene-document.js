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

async function prepareZipBackedObjectAssets(obj, {
  zip,
  uploadBlobToStore,
} = {}) {
  let asset = cloneJson(obj.asset);
  let audioSources = cloneJson(obj.audioSources);
  let skippedAssets = 0;

  if (obj.importAsset?.kind === 'blob-file') {
    const uploaded = await uploadZipAsset({
      zip,
      plan: obj.importAsset,
      uploadBlobToStore,
    });

    if (uploaded) {
      asset = cleanUploadedAsset(asset, uploaded);
    } else if (!asset?.url) {
      skippedAssets += 1;
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
    } else if (!source.url) {
      skippedAssets += 1;
    }
  }

  return { asset, audioSources, skippedAssets };
}

export async function applySceneDocument(sceneDocument, {
  managedObjects,
  addOrUpdateObject,
  broadcast,
  importGlbFileAsSceneObject,
  zip,
  uploadBlobToStore,
} = {}) {
  let added = 0;
  let updated = 0;
  let glbImported = 0;
  let skippedAssets = 0;

  for (const obj of sceneDocument.objects || []) {
    const existed = managedObjects.has(obj.id);
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
          metadata: obj.metadata,
          animation: obj.animation,
          audioSources: prepared.audioSources,
          selectAfterLoad: false,
          source: 'scene-sync-export-import',
        });

        glbImported += 1;
        continue;
      }

      skippedAssets += 1;
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

    if (obj.metadata) payload.metadata = obj.metadata;
    if (obj.animation) payload.animation = obj.animation;
    if (prepared.audioSources) payload.audioSources = prepared.audioSources;

    addOrUpdateObject(obj.id, payload, { source: 'scene-sync-export-import' });
    broadcast(payload);
  }

  return {
    total: sceneDocument.objects?.length || 0,
    added,
    updated,
    glbImported,
    skippedAssets,
  };
}
