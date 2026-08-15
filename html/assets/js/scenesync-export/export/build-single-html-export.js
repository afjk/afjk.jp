import { createSceneDocumentFromSceneSyncState } from './export-scene-document.js';
import { collectExportAssets } from './collect-export-assets.js';
import { generateManifest } from './export-manifest.js';
import { normalizeExportMetadata } from './export-metadata.js';
import {
  fetchExportViewerSources,
  SINGLE_HTML_HANDOFF_SOURCES,
  VIEWER_SOURCES,
} from './build-export-package.js';
import {
  buildSingleHtmlDocument,
  SINGLE_HTML_EXPORT_FORMAT,
  SINGLE_HTML_EXPORT_VERSION,
} from './single-html-format.js';

function formatTimestamp(date = new Date()) {
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function downloadHtml(html, filename) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export async function buildSingleHtmlExport({
  managedObjects,
  bgmState,
  envId,
  blobBase,
  envOrigin = location.origin,
  assetCache = null,
  behaviorState = null,
  physicsState = null,
  exportMetadata = null,
}) {
  const metadata = normalizeExportMetadata(exportMetadata);
  const sceneDocument = createSceneDocumentFromSceneSyncState({
    managedObjects,
    bgmState,
    envId,
    behaviorState,
    physicsState,
    exportMetadata: metadata,
  });
  const { files, document, assetManifest, missingAssets } = await collectExportAssets({
    sceneDocument,
    blobBase,
    envOrigin,
    assetCache,
  });
  const { results: viewerFiles, failures } = await fetchExportViewerSources([
    ...VIEWER_SOURCES,
    ...SINGLE_HTML_HANDOFF_SOURCES,
  ]);
  if (failures.length > 0) {
    throw new Error(`Required viewer files could not be fetched: ${failures.map((failure) => failure.dest).join(', ')}`);
  }

  const manifest = {
    ...generateManifest({
      assetManifest,
      missingAssets,
      exportedAt: new Date().toISOString(),
      cdnDependent: true,
      metadata,
    }),
    viewer: {
      entry: 'self',
      cdnDependent: true,
      cdnDependencies: [
        'three@0.170.0',
        'three/examples addons and Draco decoder',
      ],
    },
    singleHtml: {
      format: SINGLE_HTML_EXPORT_FORMAT,
      version: SINGLE_HTML_EXPORT_VERSION,
      assetEncoding: 'base64',
      embedded: ['sceneDocument', 'manifest', 'viewer-js', 'viewer-css', 'binary-assets'],
    },
  };
  const html = await buildSingleHtmlDocument({
    sceneDocument: document,
    manifest,
    files,
    viewerFiles,
  });
  const filename = `scene-sync-export-${formatTimestamp()}.html`;
  downloadHtml(html, filename);
  return { missingAssets, filename, manifest };
}
