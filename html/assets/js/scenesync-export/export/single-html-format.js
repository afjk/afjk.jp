export const SINGLE_HTML_EXPORT_FORMAT = 'single-html-v1';
export const SINGLE_HTML_EXPORT_VERSION = 1;
const MODULE_SPECIFIER_PREFIX = 'scene-sync-single-html/';

function normalizePath(path) {
  const output = [];
  for (const part of String(path).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      output.pop();
    } else {
      output.push(part);
    }
  }
  return output.join('/');
}

function dirname(path) {
  const index = String(path).lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

/**
 * JSON embedded in an HTML script element must not be able to terminate that
 * element. Escaping these characters also keeps the generated HTML portable.
 */
export function stringifySafeEmbeddedJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003C')
    .replaceAll('>', '\\u003E')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export async function arrayBufferToBase64(value) {
  const buffer = value instanceof Blob ? await value.arrayBuffer() : value;
  const bytes = buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer);

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export async function encodeSingleHtmlAssets(files = {}) {
  const assets = {};
  for (const [path, value] of Object.entries(files)) {
    if (value == null) continue;
    const blob = value instanceof Blob ? value : null;
    assets[path] = {
      mime: blob?.type || inferSingleHtmlAssetMime(path),
      base64: await arrayBufferToBase64(value),
    };
  }
  return assets;
}

export function inferSingleHtmlAssetMime(path) {
  const extension = String(path).split('.').pop()?.toLowerCase();
  return {
    glb: 'model/gltf-binary',
    hdr: 'image/vnd.radiance',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    webm: 'video/webm',
    wasm: 'application/wasm',
  }[extension] || 'application/octet-stream';
}

export function rewriteSingleHtmlModuleImports(source, modulePath) {
  const base = dirname(modulePath);
  return String(source).replace(
    /(\bfrom\s*|\bimport\s*(?:\(\s*)?)(['"])(\.{1,2}\/[^'"]+)\2/gu,
    (match, prefix, quote, specifier) => {
      const target = normalizePath(`${base}/${specifier}`);
      return `${prefix}${quote}${MODULE_SPECIFIER_PREFIX}${target}${quote}`;
    },
  );
}

function makeRuntimeScript() {
  return `
(() => {
  const readJson = (id) => JSON.parse(document.getElementById(id).textContent);
  const decodeBase64 = (base64) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };
  const payload = readJson('scene-sync-single-html-payload');
  const assetUrls = {};
  for (const [path, asset] of Object.entries(payload.assets)) {
    assetUrls[path] = URL.createObjectURL(new Blob([decodeBase64(asset.base64)], { type: asset.mime }));
  }
  globalThis.__SCENE_SYNC_SINGLE_HTML_EXPORT__ = true;
  globalThis.__SCENE_SYNC_SINGLE_HTML_ASSET_URLS__ = assetUrls;
  globalThis.__SCENE_SYNC_SINGLE_HTML_SCENE_DOCUMENT__ = payload.sceneDocument;
  globalThis.__SCENE_SYNC_SINGLE_HTML_MANIFEST__ = payload.manifest;

  const moduleUrls = {};
  for (const [path, source] of Object.entries(payload.modules)) {
    moduleUrls[path] = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  }
  const imports = {
    three: 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js',
    'three/addons/': 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/',
    '@dimforge/rapier3d-deterministic-compat': moduleUrls['viewer/rapier/rapier.js'],
  };
  for (const [path, url] of Object.entries(moduleUrls)) {
    imports['scene-sync-single-html/' + path] = url;
  }
  const importMap = document.createElement('script');
  importMap.type = 'importmap';
  importMap.textContent = JSON.stringify({ imports });
  document.head.appendChild(importMap);
  import('scene-sync-single-html/viewer/viewer.js').catch((error) => {
    const loading = document.getElementById('loading-overlay');
    if (loading) loading.textContent = 'Failed to start scene: ' + error.message;
    console.error('[Scene Sync single HTML]', error);
  });
})();`;
}

/**
 * Produces one portable HTML document. Viewer source remains as ES modules,
 * but is embedded and materialized as Blob URLs at startup so the generated
 * file never needs sibling JS/CSS/asset files.
 */
export async function buildSingleHtmlDocument({
  sceneDocument,
  manifest,
  files = {},
  viewerFiles = {},
}) {
  const viewerCss = [
    viewerFiles['viewer/viewer.css'],
    viewerFiles['viewer/player-shell.css'],
  ].filter((source) => typeof source === 'string').join('\n');
  const modules = {};
  const embeddedFiles = { ...files };

  for (const [path, source] of Object.entries(viewerFiles)) {
    if (path === 'viewer/viewer.css' || path === 'viewer/player-shell.css') continue;
    if (typeof source === 'string') {
      let rewritten = rewriteSingleHtmlModuleImports(source, path);
      if (path === 'viewer/rapier/rapier.js') {
        rewritten = rewritten.replace(
          'new URL("rapier_wasm3d_bg.wasm","<deleted>")',
          'globalThis.__SCENE_SYNC_SINGLE_HTML_ASSET_URLS__["viewer/rapier/rapier_wasm3d_bg.wasm"]',
        );
      }
      modules[path] = rewritten;
    } else {
      embeddedFiles[path] = source;
    }
  }

  const payload = {
    format: SINGLE_HTML_EXPORT_FORMAT,
    version: SINGLE_HTML_EXPORT_VERSION,
    manifest,
    sceneDocument,
    modules,
    assets: await encodeSingleHtmlAssets(embeddedFiles),
  };

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="scene-sync-export-format" content="${SINGLE_HTML_EXPORT_FORMAT}">
  <title>Scene Sync Export</title>
  <style>${viewerCss.replaceAll('</style', '<\\/style')}</style>
</head>
<body>
  <canvas id="viewer-canvas"></canvas>
  <div id="viewer-ui">
    <div id="loading-overlay">Loading scene…</div>
    <div id="file-protocol-warning" class="hidden"></div>
    <div id="missing-notice" class="hidden"></div>
    <div id="viewer-title">Scene Sync Export</div>
    <div id="viewer-controls"></div>
  </div>
  <script id="scene-sync-single-html-payload" type="application/json">${stringifySafeEmbeddedJson(payload)}</script>
  <script>${makeRuntimeScript().replaceAll('</script', '<\\/script')}</script>
</body>
</html>`;
}
