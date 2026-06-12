// Upserts every object in a SceneDocument into the current scene.
// Objects with an existing objectId are updated in place; new objectIds are added.
// Objects not present in the document are left untouched (no scene clear).
//
// Objects marked with `importAsset.kind === 'glb-file'` are loaded from the
// ZIP via `importGlbFileAsSceneObject`, reusing the normal GLB-file import
// route with an explicit objectId/transform. All other objects go through
// `addOrUpdateObject` + `broadcast` as before.
export async function applySceneDocument(sceneDocument, {
  managedObjects,
  addOrUpdateObject,
  broadcast,
  importGlbFileAsSceneObject,
  zip,
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
          audioSources: obj.audioSources,
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
      asset: obj.asset,
      visible: obj.visible !== false,
    };

    if (obj.metadata) payload.metadata = obj.metadata;
    if (obj.animation) payload.animation = obj.animation;
    if (obj.audioSources) payload.audioSources = obj.audioSources;

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
