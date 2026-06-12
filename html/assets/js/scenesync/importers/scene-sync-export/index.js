import { isZipFile } from './detect-scene-sync-export.js';
import { loadExportPackageFromBlob } from './load-export-package.js';
import { resolveSceneDocumentAssets } from './resolve-export-assets.js';
import { applySceneDocument } from './apply-scene-document.js';
import { applySceneDocumentSettings } from './apply-scene-settings.js';

export { isZipFile };

// Entry point for "Open Export": detects whether `file` is a Scene Sync Export
// ZIP and, if so, upserts its objects into the current scene.
export async function tryOpenSceneSyncExportFile(file, context = {}) {
  if (!isZipFile(file)) return { handled: false };

  const {
    managedObjects,
    addOrUpdateObject,
    broadcast,
    showToast,
    confirmOpen,
    environmentManager,
    importGlbFileAsSceneObject,
  } = context;

  const result = await loadExportPackageFromBlob(file);
  if (!result.valid) {
    showToast?.('このZIPはScene Sync Exportではありません');
    return { handled: true, error: result.reason };
  }

  const { document: resolvedDocument } = await resolveSceneDocumentAssets(result.sceneDocument, {
    zip: result.zip,
  });

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

  const stats = await applySceneDocument(resolvedDocument, {
    managedObjects,
    addOrUpdateObject,
    broadcast,
    importGlbFileAsSceneObject,
    zip: result.zip,
  });

  const settingsResult = applySceneDocumentSettings(resolvedDocument, {
    environmentManager,
    broadcast,
  });

  showToast?.(
    `Scene Sync Exportを読み込みました（追加: ${stats.added} / 更新: ${stats.updated} / GLB: ${stats.glbImported || 0}）`
  );

  return { handled: true, stats, settings: settingsResult };
}
