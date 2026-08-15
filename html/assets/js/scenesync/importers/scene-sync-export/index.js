import { isSingleHtmlFile, isZipFile } from './detect-scene-sync-export.js';
import { loadExportPackageFromBlob } from './load-export-package.js';
import { loadExportPackageFromUrl } from './load-export-package-from-url.js';
import { loadSingleHtmlExportFromBlob } from './load-single-html-export.js';
import { resolveSceneDocumentAssets } from './resolve-export-assets.js';
import { materializeSceneDocumentUrlAssets } from './materialize-url-assets.js';
import { applySceneDocument } from './apply-scene-document.js';
import { applySceneDocumentSettings } from './apply-scene-settings.js';
import { createSingleHtmlAssetZip } from '../../../scenesync-export/export/single-html-format.js';

async function applyImportedBehaviorsIfNeeded(resolvedDocument, context) {
  if (!resolvedDocument.behaviors) return null;
  if (typeof context.applySceneBehaviors !== 'function') return null;

  return await context.applySceneBehaviors(resolvedDocument.behaviors, {
    source: 'scene-sync-export-import',
    notify: true,
    broadcast: true,
  });
}

export { isSingleHtmlFile, isZipFile };

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

async function applyLoadedSceneSyncExport(result, context, {
  kind,
  confirm = true,
  rejectExistingObjectIds = false,
  applySceneLevel = true,
  showPreview = true,
} = {}) {
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

  // URL handoffs must reject ID conflicts before contacting a publisher's
  // assets. This keeps add-only semantics cheap and prevents a colliding page
  // from using the importer as an unnecessary remote fetch primitive.
  if (rejectExistingObjectIds) {
    const rawIds = new Set();
    for (const object of result.sceneDocument?.objects || []) {
      if (rawIds.has(object.id)) {
        const error = new Error(`Duplicate object ID: ${object.id}`);
        error.code = 'handoff-duplicate-object-id';
        throw error;
      }
      rawIds.add(object.id);
      if (managedObjects.has(object.id)) {
        const error = new Error(`Object ID already exists: ${object.id}`);
        error.code = 'handoff-object-id-conflict';
        throw error;
      }
    }
  }

  let importResult = result;
  if (!result.zip && result.baseUrl) {
    const materialized = await materializeSceneDocumentUrlAssets(result.sceneDocument, {
      baseUrl: result.baseUrl,
      fetchImpl: context.fetchImpl,
    });
    importResult = { ...result, sceneDocument: materialized.document, zip: materialized.zip };
  }
  const { document: resolvedDocument } = await resolveSceneDocumentAssets(importResult.sceneDocument, {
    zip: importResult.zip,
  });
  const objects = resolvedDocument.objects || [];
  const incomingObjectIds = new Set();
  for (const object of objects) {
    if (incomingObjectIds.has(object.id)) {
      const error = new Error(`Duplicate object ID: ${object.id}`);
      error.code = 'handoff-duplicate-object-id';
      throw error;
    }
    incomingObjectIds.add(object.id);
  }
  const existingObjectIds = new Set(
    objects
      .filter((obj) => managedObjects.has(obj.id))
      .map((obj) => obj.id)
  );
  const updateCount = existingObjectIds.size;
  const addCount = objects.length - updateCount;

  function assertObjectAvailable(objectId) {
    if (!managedObjects.has(objectId)) return;
    const error = new Error(`Object ID already exists: ${objectId}`);
    error.code = 'handoff-object-id-conflict';
    throw error;
  }

  if (rejectExistingObjectIds && existingObjectIds.size > 0) {
    assertObjectAvailable([...existingObjectIds][0]);
  }

  if (confirm) {
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
      return { handled: true, cancelled: true, kind };
    }
  }

  showToast?.(`Scene Sync Exportを復元中…（0/${objects.length}）`, 60000);
  const preview = showPreview
    ? await showSceneDocumentImportPreview(resolvedDocument, { zip: importResult.zip, addOrUpdateObject })
    : { previewed: 0, dispose() {} };
  if (preview.previewed > 0) {
    showToast?.(`Scene Sync Exportを復元中…（プレビュー表示 / 0/${objects.length}）`, 60000);
  }

  let stats;
  let settingsResult;
  let behaviorsResult = null;
  try {
    stats = await applySceneDocument(resolvedDocument, {
      managedObjects,
      addOrUpdateObject,
      broadcast,
      importGlbFileAsSceneObject,
      zip: importResult.zip,
      uploadBlobToStore,
      existingObjectIds,
      assertObjectAvailable: rejectExistingObjectIds ? assertObjectAvailable : undefined,
      onProgress: ({ processed, total }) => {
        showToast?.(`Scene Sync Exportを復元中…（${processed}/${total}）`, 60000);
      },
    });

    if (applySceneLevel) {
      showToast?.(
        `Scene Sync Exportを復元中…（${objects.length}/${objects.length} / 設定を適用中）`,
        60000,
      );
      settingsResult = await applySceneDocumentSettings(resolvedDocument, {
        environmentManager,
        broadcast,
        applySceneBgm,
        applyScenePhysics,
        zip: importResult.zip,
        uploadBlobToStore,
      });
      behaviorsResult = await applyImportedBehaviorsIfNeeded(resolvedDocument, { applySceneBehaviors });
    }
  } finally {
    preview.dispose();
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
    kind,
  };
}

export async function applySceneSyncHandoffPayload({
  sceneDocument,
  embeddedAssets,
}, context = {}) {
  return await applyLoadedSceneSyncExport({
    sceneDocument,
    zip: createSingleHtmlAssetZip(embeddedAssets),
  }, context, {
    kind: 'single-html-handoff',
    confirm: false,
    rejectExistingObjectIds: true,
    applySceneLevel: false,
    showPreview: false,
  });
}

export async function applySceneSyncHandoffUrl({ sourceUrl }, context = {}) {
  const result = await loadExportPackageFromUrl(sourceUrl, { fetchImpl: context.fetchImpl });
  if (!result.valid) {
    const failure = new Error(`Scene Sync Export URL failed: ${result.reason}`);
    failure.code = 'handoff-url-load-failed';
    throw failure;
  }
  try {
    return await applyLoadedSceneSyncExport(result, context, {
      kind: 'url-handoff',
      confirm: false,
      rejectExistingObjectIds: true,
      applySceneLevel: false,
      showPreview: false,
    });
  } catch (cause) {
    if (typeof cause?.code === 'string' && cause.code.startsWith('handoff-')) throw cause;
    const failure = new Error('Scene Sync URL handoff import failed');
    failure.code = 'handoff-url-import-failed';
    throw failure;
  }
}

// Entry point for "Open Export": detects Scene Sync Export ZIPs and portable
// Single HTML files, then upserts their objects into the current scene.
export async function tryOpenSceneSyncExportFile(file, context = {}) {
  const isZip = isZipFile(file);
  const isSingleHtml = isSingleHtmlFile(file);
  if (!isZip && !isSingleHtml) return { handled: false };

  const { showToast } = context;

  const result = isSingleHtml
    ? await loadSingleHtmlExportFromBlob(file)
    : await loadExportPackageFromBlob(file);
  if (!result.valid) {
    if (isSingleHtml && result.reason === 'not-single-html-export') return { handled: false };
    const label = isSingleHtml ? 'このHTMLはScene Sync Single HTML Exportではありません' : 'このZIPはScene Sync Exportではありません';
    showToast?.(label);
    return { handled: true, error: result.reason, kind: isSingleHtml ? 'single-html-local' : 'zip-local' };
  }

  return await applyLoadedSceneSyncExport(result, context, {
    kind: isSingleHtml ? 'single-html-local' : 'zip-local',
  });
}

export async function tryOpenSceneSyncExportUrl(url, context = {}) {
  const { showToast, fetchImpl } = context;

  const result = await loadExportPackageFromUrl(url, { fetchImpl });
  if (!result.valid) {
    if (result.shouldBlockGenericImport) {
      const message = result.reason === 'single-html-fetch-failed'
        ? 'Single HTML Exportを取得できませんでした。ネットワークを確認し、公開元でCORSを許可してください。'
        : result.reason === 'single-html-http-error'
          ? `Single HTML Exportを取得できませんでした（HTTP ${result.status || 'error'}）。URLを確認してください。`
          : `Scene Sync Export URLを読み込めませんでした（${result.reason}）`;
      showToast?.(message);
      return { handled: true, error: result.reason, status: result.status || 0 };
    }
    return { handled: false, reason: result.reason };
  }

  const applied = await applyLoadedSceneSyncExport(result, { ...context, fetchImpl }, {
    kind: result.kind,
    confirm: true,
    rejectExistingObjectIds: false,
    applySceneLevel: true,
    showPreview: true,
  });
  return { ...applied, sourceUrl: result.sourceUrl || url, kind: result.kind };
}
