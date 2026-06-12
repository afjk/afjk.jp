// Upserts every object in a SceneDocument into the current scene.
// Objects with an existing objectId are updated in place; new objectIds are added.
// Objects not present in the document are left untouched (no scene clear).
export function applySceneDocument(sceneDocument, { managedObjects, addOrUpdateObject, broadcast }) {
  let added = 0;
  let updated = 0;

  for (const obj of sceneDocument.objects || []) {
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

    if (managedObjects.has(obj.id)) {
      updated += 1;
    } else {
      added += 1;
    }

    addOrUpdateObject(obj.id, payload, { source: 'scene-sync-export-import' });

    // For objects whose asset was resolved to a local blob: URL, broadcast a
    // placeholder instead so other peers don't receive an unusable URL.
    const broadcastPayload = obj.broadcastAsset
      ? { ...payload, asset: obj.broadcastAsset }
      : payload;
    broadcast(broadcastPayload);
  }

  return { total: sceneDocument.objects?.length || 0, added, updated };
}
