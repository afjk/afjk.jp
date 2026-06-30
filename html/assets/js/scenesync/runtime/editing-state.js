function getSceneObjectId(object) {
  return object?.userData?.objectId || null;
}

function collectionHasObjectId(collection, objectId) {
  if (!collection || !objectId) return false;
  if (typeof collection.has === 'function') return collection.has(objectId);
  if (Array.isArray(collection)) return collection.includes(objectId);
  return false;
}

export function isObjectActivelyEdited({
  objectId,
  transformObject = null,
  xrTwoHand = null,
  grabbers = [],
  ignoreTransformObject = false,
} = {}) {
  if (!objectId) return false;

  if (!ignoreTransformObject && getSceneObjectId(transformObject) === objectId) {
    return true;
  }

  if (xrTwoHand?.active && getSceneObjectId(xrTwoHand.object) === objectId) {
    return true;
  }

  for (const grabber of grabbers || []) {
    if (grabber?.active && getSceneObjectId(grabber.object) === objectId) {
      return true;
    }
  }

  return false;
}

export function shouldFreezeObjectForEditorRuntime({
  objectId,
  selectedObjectIds = null,
  transformObject = null,
  xrTwoHand = null,
  grabbers = [],
  transportActive = false,
  ignoreTransformObject = false,
} = {}) {
  if (!objectId) return false;

  if (isObjectActivelyEdited({ objectId, transformObject, xrTwoHand, grabbers, ignoreTransformObject })) {
    return true;
  }

  if (transportActive) {
    return false;
  }

  return collectionHasObjectId(selectedObjectIds, objectId);
}
