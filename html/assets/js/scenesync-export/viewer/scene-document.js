export const SCENE_DOCUMENT_FORMAT = 'scene-sync-export-scene';
export const SCENE_DOCUMENT_VERSION = 1;

export function isValidSceneDocument(doc) {
  return (
    doc != null &&
    doc.format === SCENE_DOCUMENT_FORMAT &&
    doc.version === SCENE_DOCUMENT_VERSION &&
    Array.isArray(doc.objects)
  );
}
