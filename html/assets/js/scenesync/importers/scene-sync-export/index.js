import { isZipFile } from './detect-scene-sync-export.js';
import { loadExportPackageFromBlob } from './load-export-package.js';
import { loadExportPackageFromUrl } from './load-export-package-from-url.js';
import { resolveSceneDocumentAssets } from './resolve-export-assets.js';
import { resolveSceneDocumentAssetsFromUrl } from './resolve-url-assets.js';
import { applySceneDocument } from './apply-scene-document.js';
import { applySceneDocumentSettings } from './apply-scene-settings.js';

async function applyImportedBehaviorsIfNeeded(resolvedDocument, context) {
  if (!resolvedDocument.behaviors) return null;
  if (typeof context.applySceneBehaviors !== 'function') return null;

  return await context.applySceneBehaviors(resolvedDocument.behaviors, {
    source: 'scene-sync-export-import',
    notify: true,
    broadcast: true,
  });
}

export { isZipFile };

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function inferPreviewMime(asset) {
  const mime = typeof asset?.mime === 'string' ? asset.mime.trim() : '';
  if (mime) return mime;
  const path = String(asset?.path || '').toLowerCase();
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.mp4') || path.endsWith('.m4v')) return 'video/mp4';
  if (path.endsWith('.webm')) return 'video/webm';
  if (path.endsWith('.ogv')) return 'video/ogg';
  if (path.endsWith('.md') || path.endsWith('.markdown')) return 'text/markdown';
  if (path.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

function buildPreviewBasePayload(obj) {
  const payload = {
    kind: 'scene-add',
    objectId: obj.id,
    name: obj.name || obj.id,
    position: obj.position,
    rotation: obj.rotation,
    scale: obj.scale,
    visible: obj.visible !== false,
  };

  if (obj.metadata) {
    payload.metadata = {
      ...cloneJson(obj.metadata),
      importPreview: true,
    };
  } else {
    payload.metadata = { importPreview: true };
  }

  if (obj.animation) payload.animation = cloneJson(obj.animation);
  return payload;
}

function buildPlaceholderPreviewAsset(asset) {
  return {
    type: 'primitive',
    primitive: 'box',
    color: '#4f8cff',
    previewAssetType: asset?.type || 'unknown',
  };
}

async function readZipEntryBlobUrl(zip, path, mime, objectUrls) {
  const entry = path ? zip?.file?.(path) : null;
  if (!entry || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return null;
  }

  const buffer = await entry.async('arraybuffer');
  const blob = new Blob([buffer], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

async function readZipEntryText(zip, path) {
  const entry = path ? zip?.file?.(path) : null;
  if (!entry) return null;
  return await entry.async('string');
}

async function buildPreviewAsset(asset, zip, objectUrls) {
  if (!asset || asset.type === 'primitive') {
    return cloneJson(asset || { type: 'primitive', primitive: 'box', color: '#4f8cff' });
  }

  if (asset.type === 'image' || asset.type === 'video') {
    const mime = inferPreviewMime(asset);
    const localUrl = await readZipEntryBlobUrl(zip, asset.path, mime, objectUrls);
    const url = localUrl || asset.url || null;
    if (!url) return buildPlaceholderPreviewAsset(asset);
    const previewAsset = {
      ...cloneJson(asset),
      source: localUrl ? 'local-preview' : (asset.source || 'url'),
      url,
      mime,
    };
    delete previewAsset.path;
    return previewAsset;
  }

  if (asset.type === 'text') {
    if (asset.source === 'inline') return cloneJson(asset);
    const text = await readZipEntryText(zip, asset.path);
    if (text != null) {
      const previewAsset = {
        ...cloneJson(asset),
        source: 'inline',
        text,
      };
      delete previewAsset.path;
      delete previewAsset.url;
      return previewAsset;
    }
    if (asset.url) {
      const previewAsset = cloneJson(asset);
      delete previewAsset.path;
      return previewAsset;
    }
    return buildPlaceholderPreviewAsset(asset);
  }

  // Avoid double-parsing GLB files just for preview; the final import path
  // loads the real mesh and replaces this placeholder as soon as it is ready.
  return buildPlaceholderPreviewAsset(asset);
}

export async function showSceneDocumentImportPreview(sceneDocument, {
  zip,
  addOrUpdateObject,
} = {}) {
  if (typeof addOrUpdateObject !== 'function') {
    return { previewed: 0, dispose() {} };
  }

  const objectUrls = [];
  let previewed = 0;

  for (const obj of sceneDocument.objects || []) {
    const payload = buildPreviewBasePayload(obj);
    payload.asset = await buildPreviewAsset(obj.asset, zip, objectUrls);
    addOrUpdateObject(obj.id, payload, { source: 'scene-sync-export-import-preview' });
    previewed += 1;
  }

  return {
    previewed,
    dispose() {
      if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
      for (const url of objectUrls) {
        URL.revokeObjectURL(url);
      }
      objectUrls.length = 0;
    },
  };
}

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
    uploadBlobToStore,
    applySceneBgm,
    applyScenePhysics,
    applySceneBehaviors,
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
  const existingObjectIds = new Set(
    objects
      .filter((obj) => managedObjects.has(obj.id))
      .map((obj) => obj.id)
  );
  const updateCount = existingObjectIds.size;
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

  showToast?.(`Scene Sync Exportを復元中…（0/${objects.length}）`, 60000);

  const preview = await showSceneDocumentImportPreview(resolvedDocument, {
    zip: result.zip,
    addOrUpdateObject,
  });
  if (preview.previewed > 0) {
    showToast?.(`Scene Sync Exportを復元中…（プレビュー表示 / 0/${objects.length}）`, 60000);
  }

  let completed = false;
  let stats;
  let settingsResult;
  let behaviorsResult = null;
  try {
    stats = await applySceneDocument(resolvedDocument, {
      managedObjects,
      addOrUpdateObject,
      broadcast,
      importGlbFileAsSceneObject,
      zip: result.zip,
      uploadBlobToStore,
      existingObjectIds,
      onProgress: ({ processed, total }) => {
        showToast?.(`Scene Sync Exportを復元中…（${processed}/${total}）`, 60000);
      },
    });

    const settingsMessage = `Scene Sync Exportを復元中…（${objects.length}/${objects.length} / 設定を適用中）`;
    showToast?.(settingsMessage, 60000);

    settingsResult = await applySceneDocumentSettings(resolvedDocument, {
      environmentManager,
      broadcast,
      applySceneBgm,
      applyScenePhysics,
      zip: result.zip,
      uploadBlobToStore,
    });

    behaviorsResult = await applyImportedBehaviorsIfNeeded(resolvedDocument, { applySceneBehaviors });
    completed = true;
  } finally {
    if (completed) preview.dispose();
  }

  const behaviorCount = behaviorsResult?.applied || 0;
  const toastSuffix = behaviorCount > 0 ? ` / Behavior: ${behaviorCount}` : '';
  showToast?.(
    `Scene Sync Exportを読み込みました（追加: ${stats.added} / 更新: ${stats.updated} / GLB: ${stats.glbImported || 0}${toastSuffix}）`
  );

  return { handled: true, stats, settings: settingsResult, behaviors: behaviorsResult };
}

export async function tryOpenSceneSyncExportUrl(url, context = {}) {
  const {
    managedObjects,
    addOrUpdateObject,
    broadcast,
    showToast,
    confirmOpen,
    environmentManager,
    importGlbFileAsSceneObject,
    uploadBlobToStore,
    applySceneBgm,
    applyScenePhysics,
    applySceneBehaviors,
    fetchImpl,
  } = context;

  const result = await loadExportPackageFromUrl(url, { fetchImpl });
  if (!result.valid) {
    if (result.shouldBlockGenericImport) {
      showToast?.(`Scene Sync Export URLを読み込めませんでした（${result.reason}）`);
      return { handled: true, error: result.reason };
    }
    return { handled: false, reason: result.reason };
  }

  const { document: resolvedDocument } = result.zip
    ? await resolveSceneDocumentAssets(result.sceneDocument, { zip: result.zip })
    : resolveSceneDocumentAssetsFromUrl(result.sceneDocument, { baseUrl: result.baseUrl });

  const objects = resolvedDocument.objects || [];
  const existingObjectIds = new Set(
    objects
      .filter((obj) => managedObjects.has(obj.id))
      .map((obj) => obj.id)
  );
  const updateCount = existingObjectIds.size;
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

  showToast?.(`Scene Sync Exportを復元中…（0/${objects.length}）`, 60000);

  const preview = await showSceneDocumentImportPreview(resolvedDocument, {
    zip: result.zip,
    addOrUpdateObject,
  });
  if (preview.previewed > 0) {
    showToast?.(`Scene Sync Exportを復元中…（プレビュー表示 / 0/${objects.length}）`, 60000);
  }

  let completed = false;
  let stats;
  let settingsResult;
  let behaviorsResult = null;
  try {
    stats = await applySceneDocument(resolvedDocument, {
      managedObjects,
      addOrUpdateObject,
      broadcast,
      importGlbFileAsSceneObject,
      zip: result.zip,
      uploadBlobToStore,
      existingObjectIds,
      onProgress: ({ processed, total }) => {
        showToast?.(`Scene Sync Exportを復元中…（${processed}/${total}）`, 60000);
      },
    });

    const settingsMessage = `Scene Sync Exportを復元中…（${objects.length}/${objects.length} / 設定を適用中）`;
    showToast?.(settingsMessage, 60000);

    settingsResult = await applySceneDocumentSettings(resolvedDocument, {
      environmentManager,
      broadcast,
      applySceneBgm,
      applyScenePhysics,
      zip: result.zip,
      uploadBlobToStore,
    });

    behaviorsResult = await applyImportedBehaviorsIfNeeded(resolvedDocument, { applySceneBehaviors });
    completed = true;
  } finally {
    if (completed) preview.dispose();
  }

  const behaviorCount = behaviorsResult?.applied || 0;
  const toastSuffix = behaviorCount > 0 ? ` / Behavior: ${behaviorCount}` : '';
  showToast?.(
    `Scene Sync Exportを読み込みました（追加: ${stats.added} / 更新: ${stats.updated} / GLB: ${stats.glbImported || 0}${toastSuffix}）`
  );

  return {
    handled: true,
    stats,
    settings: settingsResult,
    behaviors: behaviorsResult,
    sourceUrl: result.sourceUrl || url,
    kind: result.kind,
  };
}
