import { generateManifest } from './export-manifest.js';
import { generateReadme, generateReadmeHtml } from './export-readme.js';
import {
  collectExportSceneStats,
  generateExportThumbnail,
  resolveExportThumbnailTitle,
} from './export-thumbnail.js';
import { prepareSceneSyncExport } from './export-preparation.js';
import { VIEWER_SOURCES } from './viewer-sources.js';

export { VIEWER_SOURCES, SINGLE_HTML_HANDOFF_SOURCES, fetchExportViewerSources } from './viewer-sources.js';
const INDEX_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scene Sync Export</title>
  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/",
      "@dimforge/rapier3d-deterministic-compat": "./viewer/rapier/rapier.js"
    }
  }
  <\/script>
  <link rel="stylesheet" href="viewer/viewer.css">
  <script>
    if (location.protocol === 'file:') {
      window.addEventListener('DOMContentLoaded', function () {
        var warning = document.getElementById('file-protocol-warning');
        var loading = document.getElementById('loading-overlay');
        if (warning) warning.classList.remove('hidden');
        if (loading) loading.classList.add('hidden');
      });
    }
  <\/script>
</head>
<body>
  <canvas id="viewer-canvas"></canvas>
  <div id="viewer-ui">
    <div id="loading-overlay">Loading scene…</div>
    <div id="file-protocol-warning" class="hidden">
      <div>
        <h1 style="font-size:20px;margin-bottom:12px;">このままでは表示できません</h1>
        <p>
          <code>index.html</code> を直接開くと、ブラウザの制限により
          3Dモデルやシーンファイルを読み込めないことがあります。
        </p>
        <p style="margin-top:12px;font-size:14px;">
          ZIPを展開したフォルダで、次のコマンドを実行してください。
        </p>
        <code style="margin-top:8px;display:inline-block;padding:4px 10px;background:rgba(255,255,255,.15);border-radius:4px;">python3 -m http.server 8080</code>
        <p style="margin-top:12px;font-size:14px;">
          そのあと、ブラウザで
          <code style="padding:2px 6px;background:rgba(255,255,255,.15);border-radius:4px;">http://localhost:8080</code>
          を開いてください。
        </p>
        <p style="margin-top:16px;font-size:14px;">
          詳しくは <a href="./README.html" style="color:#8ab4ff;">README.html</a> を見てください。
        </p>
      </div>
    </div>
    <div id="missing-notice" class="hidden"></div>
    <div id="viewer-title">Scene Sync Export</div>
    <div id="viewer-controls"></div>
  </div>
  <script type="module" src="viewer/viewer.js"><\/script>
</body>
</html>`;

export function generateExportIndexHtml() {
  return INDEX_HTML_TEMPLATE;
}

async function loadJSZip() {
  if (typeof globalThis.JSZip !== 'undefined') return globalThis.JSZip;

  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load JSZip'));
    document.head.appendChild(script);
  });

  return globalThis.JSZip;
}

function formatTimestamp(date = new Date()) {
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

const THUMBNAIL_EXTENSION_BY_MIME = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
]);

export const EXPORT_THUMBNAIL_FILE_LIMIT_BYTES = 10 * 1024 * 1024;
const SUPPORTED_THUMBNAIL_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export function getExportThumbnailExtension(file) {
  const mime = String(file?.type || '').toLowerCase().split(';')[0].trim();
  if (THUMBNAIL_EXTENSION_BY_MIME.has(mime)) {
    return THUMBNAIL_EXTENSION_BY_MIME.get(mime);
  }

  const name = String(file?.name || '').toLowerCase();
  const dotIndex = name.lastIndexOf('.');
  const ext = dotIndex >= 0 ? name.slice(dotIndex) : '';
  return SUPPORTED_THUMBNAIL_EXTENSIONS.has(ext) ? ext : null;
}

export function validateExportThumbnailFile(file) {
  if (!getExportThumbnailExtension(file)) {
    return 'PNG / JPEG / WebP の画像を選択してください';
  }
  if (Number.isFinite(file?.size) && file.size > EXPORT_THUMBNAIL_FILE_LIMIT_BYTES) {
    return 'Thumbnail画像は10MB以下にしてください';
  }
  return null;
}

function getCustomThumbnailFile(exportOptions) {
  const file = exportOptions?.thumbnailFile || exportOptions?.thumbnail || null;
  return file && typeof file === 'object' ? file : null;
}

async function addExportThumbnail(zip, {
  exportOptions,
  sceneDocument,
  manifest,
  filenameTitle,
}) {
  const customThumbnail = getCustomThumbnailFile(exportOptions);
  if (customThumbnail) {
    const validationError = validateExportThumbnailFile(customThumbnail);
    if (validationError) {
      throw new Error(validationError);
    }
    const extension = getExportThumbnailExtension(customThumbnail);
    const path = `thumbnail${extension}`;
    zip.file(path, customThumbnail);
    return { path, mode: 'custom' };
  }

  const thumbnail = await generateExportThumbnail({
    title: resolveExportThumbnailTitle({
      sceneDocument,
      manifest,
      fallbackTitle: filenameTitle,
    }),
    stats: collectExportSceneStats(sceneDocument),
  });
  zip.file('thumbnail.png', thumbnail.blob);
  return { path: 'thumbnail.png', mode: thumbnail.mode };
}

export async function buildExportPackage({
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
}) {
  // Direct Static ZIP exports intentionally fetch exactly their historic viewer
  // source set. Auto can pass a wider prepared set and we still write only it.
  const prepared = preparedExport || await prepareSceneSyncExport({
    managedObjects, bgmState, envId, blobBase, envOrigin, assetCache,
    behaviorState, physicsState, exportMetadata, viewerSources: VIEWER_SOURCES,
  });
  const {
    metadata, files, document: updatedDoc, assetManifest, missingAssets,
    viewerFiles, viewerFailures,
  } = prepared;

  if (viewerFailures.length > 0) {
    const requiredDestinations = new Set(VIEWER_SOURCES.map(({ dest }) => dest));
    const missing = viewerFailures.filter(({ dest }) => requiredDestinations.has(dest)).map(f => f.dest);
    if (missing.length === 0) {
      // Handoff-only sources are irrelevant to a Static ZIP.
    } else {
      throw new Error(`Required viewer files could not be fetched: ${missing.join(', ')}`);
    }
  }

  // 4. Build manifest
  const exportedAt = new Date().toISOString();
  const manifest = generateManifest({
    assetManifest,
    missingAssets,
    exportedAt,
    cdnDependent: true,
    metadata,
  });
  const filename = `scene-sync-export-${formatTimestamp()}.zip`;
  const filenameTitle = filename.replace(/\.zip$/i, '');

  // 5. Load JSZip
  const JSZip = await loadJSZip();
  const zip = new JSZip();

  // 6. Add static files
  zip.file('index.html', INDEX_HTML_TEMPLATE);
  zip.file('README.md', generateReadme());
  zip.file('README.html', generateReadmeHtml());
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('scene.json', JSON.stringify(updatedDoc, null, 2));

  const hasCustomThumbnail = Boolean(getCustomThumbnailFile(exportMetadata));
  try {
    await addExportThumbnail(zip, {
      exportOptions: exportMetadata,
      sceneDocument: updatedDoc,
      manifest,
      filenameTitle,
    });
  } catch (error) {
    if (hasCustomThumbnail) {
      throw error;
    }
    console.warn('[Export] thumbnail generation failed:', error);
  }

  // 7. Add viewer files
  const staticViewerDestinations = new Set(VIEWER_SOURCES.map(({ dest }) => dest));
  for (const [dest, content] of Object.entries(viewerFiles)) {
    if (staticViewerDestinations.has(dest)) zip.file(dest, content);
  }

  // 8. Add asset files
  for (const [zipPath, buffer] of Object.entries(files)) {
    zip.file(zipPath, buffer);
  }

  // 9. Generate ZIP blob
  let zipBlob;
  try {
    zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  } catch (err) {
    throw new Error(`ZIP generation failed: ${err.message}`);
  }

  // 10. Trigger download
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);

  return { missingAssets, filename, manifest, selectedFormat: 'static-zip' };
}
