import { isZipFile } from './detect-scene-sync-export.js';
import { loadExportPackageFromBlob } from './load-export-package.js';
import { resolveSceneDocumentAssets } from './resolve-export-assets.js';
import { applySceneDocument } from './apply-scene-document.js';

export { isZipFile };

// Entry point for "Open Export": detects whether `file` is a Scene Sync Export
// ZIP and, if so, upserts its objects into the current scene.
export async function tryOpenSceneSyncExportFile(file, context = {}) {
  if (!isZipFile(file)) return { handled: false };

  const { managedObjects, addOrUpdateObject, broadcast, showToast, confirmOpen } = context;

  const result = await loadExportPackageFromBlob(file);
  if (!result.valid) {
    showToast?.('このZIPはScene Sync Exportではありません');
    return { handled: true, error: result.reason };
  }

  const { document: resolvedDocument } = await resolveSceneDocumentAssets(
    result.sceneDocument,
    result.zip
  );

  const objects = resolvedDocument.objects || [];
  const updateCount = objects.filter((obj) => managedObjects.has(obj.id)).length;
  const addCount = objects.length - updateCount;

  const confirmFn = confirmOpen
    || (typeof window !== 'undefined' ? window.confirm.bind(window) : null);
  const message =
    'Scene Sync Exportを読み込みます\n\n'
    + `- objects: ${objects.length}\n`
    + `- update existing: ${updateCount}\n`
    + `- add new: ${addCount}\n\n`
    + '同じIDのオブジェクトは上書きされます。\n'
    + 'Exportに含まれない既存オブジェクトは残ります。';

  if (confirmFn && !confirmFn(message)) {
    return { handled: true, cancelled: true };
  }

  const stats = applySceneDocument(resolvedDocument, { managedObjects, addOrUpdateObject, broadcast });
  showToast?.(`Scene Sync Exportを読み込みました（追加: ${stats.added} / 更新: ${stats.updated}）`);

  return { handled: true, stats };
}
