import { generateManifest } from './export-manifest.js';
import { prepareSceneSyncExport } from './export-preparation.js';
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

export function createSingleHtmlManifest({ assetManifest, missingAssets, metadata }) {
  return {
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
  preparedExport = null,
  singleHtmlPreparation = null,
}) {
  const prepared = preparedExport || await prepareSceneSyncExport({
    managedObjects, bgmState, envId, blobBase, envOrigin, assetCache,
    behaviorState, physicsState, exportMetadata,
  });
  const { metadata, files, document, assetManifest, missingAssets, viewerFiles, viewerFailures } = prepared;
  if (viewerFailures.length > 0) {
    throw new Error(`Required viewer files could not be fetched: ${viewerFailures.map((failure) => failure.dest).join(', ')}`);
  }

  const manifest = singleHtmlPreparation?.manifest
    || createSingleHtmlManifest({ assetManifest, missingAssets, metadata });
  const html = await buildSingleHtmlDocument({
    sceneDocument: document,
    manifest,
    files,
    viewerFiles,
    preparation: singleHtmlPreparation,
  });
  const filename = `scene-sync-export-${formatTimestamp()}.html`;
  downloadHtml(html, filename);
  return { missingAssets, filename, manifest, selectedFormat: 'single-html' };
}
