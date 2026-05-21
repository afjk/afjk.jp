import { createSceneDocumentFromSceneSyncState } from './export-scene-document.js';
import { collectExportAssets } from './collect-export-assets.js';
import { generateManifest } from './export-manifest.js';
import { generateReadme, generateReadmeHtml } from './export-readme.js';

// These viewer source files are fetched from the current origin and bundled into the ZIP
const VIEWER_SOURCES = [
  { src: '/assets/js/scenesync-export/viewer/static-viewer-entry.js', dest: 'viewer/viewer.js' },
  { src: '/assets/js/scenesync-export/viewer/create-viewer-core.js', dest: 'viewer/create-viewer-core.js' },
  { src: '/assets/js/scenesync-export/viewer/static-asset-resolver.js', dest: 'viewer/static-asset-resolver.js' },
  { src: '/assets/js/scenesync-export/viewer/scene-document.js', dest: 'viewer/scene-document.js' },
  { src: '/assets/js/scenesync-export/viewer/viewer.css', dest: 'viewer/viewer.css' },
];

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
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
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

async function fetchViewerSources() {
  const results = {};
  const failures = [];

  await Promise.all(
    VIEWER_SOURCES.map(async ({ src, dest }) => {
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        results[dest] = text;
      } catch (err) {
        failures.push({ src, dest, error: err.message });
      }
    })
  );

  return { results, failures };
}

export async function buildExportPackage({
  managedObjects,
  bgmState,
  envId,
  blobBase,
  envOrigin = location.origin,
  assetCache = null,
}) {
  // 1. Build SceneDocument from current state
  let sceneDocument;
  try {
    sceneDocument = createSceneDocumentFromSceneSyncState({
      managedObjects,
      bgmState,
      envId,
    });
  } catch (err) {
    throw new Error(`SceneDocument generation failed: ${err.message}`);
  }

  // 2. Collect assets (fetch GLBs, HDRI, BGM)
  const { files, document: updatedDoc, assetManifest, missingAssets } =
    await collectExportAssets({
      sceneDocument,
      blobBase,
      envOrigin,
      assetCache,
    });

  // 3. Fetch viewer source files
  const { results: viewerFiles, failures: viewerFailures } = await fetchViewerSources();

  if (viewerFailures.length > 0) {
    const missing = viewerFailures.map(f => f.dest).join(', ');
    throw new Error(`Required viewer files could not be fetched: ${missing}`);
  }

  // 4. Build manifest
  const exportedAt = new Date().toISOString();
  const manifest = generateManifest({
    assetManifest,
    missingAssets,
    exportedAt,
    cdnDependent: true,
  });

  // 5. Load JSZip
  const JSZip = await loadJSZip();
  const zip = new JSZip();

  // 6. Add static files
  zip.file('index.html', INDEX_HTML_TEMPLATE);
  zip.file('README.md', generateReadme());
  zip.file('README.html', generateReadmeHtml());
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('scene.json', JSON.stringify(updatedDoc, null, 2));

  // 7. Add viewer files
  for (const [dest, content] of Object.entries(viewerFiles)) {
    zip.file(dest, content);
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
  const filename = `scene-sync-export-${formatTimestamp()}.zip`;
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);

  return { missingAssets };
}
