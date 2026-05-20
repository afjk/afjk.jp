export const SCENE_DOCUMENT_FORMAT = 'scene-sync-export-scene';
export const SCENE_DOCUMENT_VERSION = 1;

function isNumberArray(arr, length) {
  return Array.isArray(arr) && arr.length >= length && arr.every(v => typeof v === 'number');
}

function isValidObject(obj) {
  return (
    obj != null &&
    typeof obj.id === 'string' &&
    isNumberArray(obj.position, 3) &&
    isNumberArray(obj.rotation, 4) &&
    isNumberArray(obj.scale, 3)
  );
}

export function isValidSceneDocument(doc) {
  if (doc == null) return false;
  if (doc.format !== SCENE_DOCUMENT_FORMAT) return false;
  if (doc.version !== SCENE_DOCUMENT_VERSION) return false;
  if (!Array.isArray(doc.objects)) return false;
  if (!doc.objects.every(isValidObject)) return false;
  return true;
}
