export const SINGLE_HTML_EXPORT_FORMAT = 'single-html-v1';
export const SINGLE_HTML_EXPORT_VERSION = 1;
const MODULE_SPECIFIER_PREFIX = 'scene-sync-single-html/';
const SINGLE_HTML_PAYLOAD_ID = 'scene-sync-single-html-payload';
// Single HTML is intended for portable scenes, not unbounded archive uploads.
// These limits leave room for typical images/audio and are deliberately below
// the 500 MiB GLB cache limit used by Scene Sync's general asset pipeline.
export const MAX_SINGLE_HTML_DOCUMENT_BYTES = 100 * 1024 * 1024;
export const MAX_SINGLE_HTML_ASSET_COUNT = 2048;
export const MAX_SINGLE_HTML_ASSET_BYTES = 64 * 1024 * 1024;
export const MAX_SINGLE_HTML_TOTAL_ASSET_BYTES = 96 * 1024 * 1024;

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
  const assets = Object.create(null);
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

function utf8ByteLength(value) {
  let length = 0;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      length += 4;
      index += 1;
    } else length += 3;
  }
  return length;
}

function readOpeningTag(source, start) {
  if (source[start] !== '<' || /[!/?]/u.test(source[start + 1] || '')) return null;
  let index = start + 1;
  const nameStart = index;
  while (index < source.length && !/[\s/>]/u.test(source[index])) index += 1;
  const name = source.slice(nameStart, index).toLowerCase();
  if (!name) return null;

  let quote = null;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return { name, opening: source.slice(start, index + 1), end: index + 1 };
    }
  }
  return null;
}

function skipHtmlComment(source, start) {
  const end = source.indexOf('-->', start + 4);
  return end < 0 ? source.length : end + 3;
}

function findRawTextClosingTag(source, name, from) {
  let index = from;
  while (index < source.length) {
    const start = source.indexOf('<', index);
    if (start < 0) return null;
    if (source[start + 1] === '/') {
      const candidate = source.slice(start + 2, start + 2 + name.length);
      const boundary = source[start + 2 + name.length];
      if (candidate.toLowerCase() === name && /[\s>]/u.test(boundary || '')) {
        const end = source.indexOf('>', start + 2 + name.length);
        return end < 0 ? null : { start, end: end + 1 };
      }
    }
    index = start + 1;
  }
  return null;
}

function parseOpeningTagAttributes(openingTag, tagName) {
  const attributes = new Map();
  let index = 1 + tagName.length;
  const end = openingTag.length - 1;
  while (index < end) {
    while (index < end && /\s/u.test(openingTag[index])) index += 1;
    if (index >= end || openingTag[index] === '/') break;
    const nameStart = index;
    while (index < end && !/[\s=/>]/u.test(openingTag[index])) index += 1;
    const name = openingTag.slice(nameStart, index).toLowerCase();
    if (!name) break;
    while (index < end && /\s/u.test(openingTag[index])) index += 1;
    let value = '';
    if (openingTag[index] === '=') {
      index += 1;
      while (index < end && /\s/u.test(openingTag[index])) index += 1;
      const quote = openingTag[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const valueStart = index;
        while (index < end && openingTag[index] !== quote) index += 1;
        value = openingTag.slice(valueStart, index);
        if (openingTag[index] === quote) index += 1;
      } else {
        const valueStart = index;
        while (index < end && !/[\s>]/u.test(openingTag[index])) index += 1;
        value = openingTag.slice(valueStart, index);
      }
    }
    if (!attributes.has(name)) attributes.set(name, value);
  }
  return attributes;
}

function inspectSingleHtmlDocument(html) {
  const source = String(html);
  let marker = null;
  let payloadText = null;
  let payloadFound = false;
  let index = 0;

  while (index < source.length) {
    const start = source.indexOf('<', index);
    if (start < 0) break;
    if (source.startsWith('<!--', start)) {
      index = skipHtmlComment(source, start);
      continue;
    }
    const tag = readOpeningTag(source, start);
    if (!tag) {
      index = start + 1;
      continue;
    }
    const attributes = parseOpeningTagAttributes(tag.opening, tag.name);
    if (tag.name === 'meta' && attributes.get('name') === 'scene-sync-export-format') {
      marker = attributes.get('content') ?? '';
    }

    if (tag.name === 'script' || tag.name === 'style') {
      const closing = findRawTextClosingTag(source, tag.name, tag.end);
      if (tag.name === 'script' && attributes.get('id') === SINGLE_HTML_PAYLOAD_ID && !payloadFound) {
        payloadFound = true;
        payloadText = closing ? source.slice(tag.end, closing.start) : null;
      }
      index = closing ? closing.end : source.length;
      continue;
    }
    index = tag.end;
  }
  return { marker, payloadText, payloadFound };
}

function estimatedBase64DecodedBytes(base64) {
  if (typeof base64 !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)) {
    throw new Error('invalid base64');
  }
  return (base64.length / 4) * 3 - (base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0));
}

function decodeBase64(base64) {
  estimatedBase64DecodedBytes(base64);

  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function resolveSingleHtmlLimits(limits = {}) {
  return {
    documentBytes: Number.isFinite(limits.documentBytes) ? limits.documentBytes : MAX_SINGLE_HTML_DOCUMENT_BYTES,
    assetCount: Number.isFinite(limits.assetCount) ? limits.assetCount : MAX_SINGLE_HTML_ASSET_COUNT,
    assetBytes: Number.isFinite(limits.assetBytes) ? limits.assetBytes : MAX_SINGLE_HTML_ASSET_BYTES,
    totalAssetBytes: Number.isFinite(limits.totalAssetBytes) ? limits.totalAssetBytes : MAX_SINGLE_HTML_TOTAL_ASSET_BYTES,
  };
}

function validateSingleHtmlAssets(assets, limits) {
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return { valid: false, reason: 'invalid-single-html-assets' };
  const entries = Object.entries(assets);
  if (entries.length > limits.assetCount) return { valid: false, reason: 'single-html-too-many-assets' };
  let totalBytes = 0;
  try {
    for (const [path, asset] of entries) {
      if (!isSafeSingleHtmlAssetPath(path)
        || !asset || typeof asset !== 'object' || Array.isArray(asset)
        || !Object.hasOwn(asset, 'mime') || typeof asset.mime !== 'string'
        || !Object.hasOwn(asset, 'base64') || typeof asset.base64 !== 'string') {
        return { valid: false, reason: 'invalid-single-html-assets' };
      }
      const assetBytes = estimatedBase64DecodedBytes(asset.base64);
      if (assetBytes > limits.assetBytes) return { valid: false, reason: 'single-html-asset-too-large' };
      totalBytes += assetBytes;
      if (totalBytes > limits.totalAssetBytes) return { valid: false, reason: 'single-html-assets-too-large' };
    }
  } catch {
    return { valid: false, reason: 'invalid-single-html-assets' };
  }
  return { valid: true, totalBytes };
}

export function validateSingleHtmlEmbeddedAssets(assets, options = {}) {
  const resolvedLimits = resolveSingleHtmlLimits(options);
  if (options.sceneDocument !== undefined) {
    let serializedDocument;
    try {
      serializedDocument = JSON.stringify({
        sceneDocument: options.sceneDocument,
        assets,
      });
    } catch {
      return { valid: false, reason: 'invalid-single-html-scene-document' };
    }
    if (typeof serializedDocument !== 'string'
      || utf8ByteLength(serializedDocument) > resolvedLimits.documentBytes) {
      return { valid: false, reason: 'single-html-document-too-large' };
    }
  }
  return validateSingleHtmlAssets(assets, resolvedLimits);
}

function isSafeSingleHtmlAssetPath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((part) => part && part !== '.' && part !== '..'
    && part !== '__proto__' && part !== 'constructor' && part !== 'prototype');
}

/**
 * Parses the inert payload in a Single HTML export. This deliberately uses no
 * DOM APIs: imports must also work in Node-based validation/tests, and HTML
 * must never be executed merely to inspect an export.
 */
export function parseSingleHtmlExportDocument(html, { isValidSceneDocument, limits } = {}) {
  const resolvedLimits = resolveSingleHtmlLimits(limits);
  if (typeof html !== 'string' || utf8ByteLength(html) > resolvedLimits.documentBytes) {
    return { valid: false, reason: 'single-html-document-too-large' };
  }
  const { marker, payloadText } = inspectSingleHtmlDocument(html);
  if (marker == null) return { valid: false, reason: 'not-single-html-export' };
  if (marker !== SINGLE_HTML_EXPORT_FORMAT) {
    return { valid: false, reason: 'invalid-single-html-marker' };
  }

  if (payloadText == null) return { valid: false, reason: 'missing-single-html-payload' };

  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch (error) {
    return { valid: false, reason: 'invalid-single-html-payload', error };
  }

  if (payload?.format !== SINGLE_HTML_EXPORT_FORMAT) {
    return { valid: false, reason: 'invalid-single-html-payload' };
  }
  if (payload.version !== SINGLE_HTML_EXPORT_VERSION) {
    return { valid: false, reason: 'unsupported-single-html-version' };
  }
  if (typeof isValidSceneDocument === 'function' && !isValidSceneDocument(payload.sceneDocument)) {
    return { valid: false, reason: 'invalid-single-html-scene-document' };
  }
  const assets = validateSingleHtmlEmbeddedAssets(payload.assets, resolvedLimits);
  if (!assets.valid) return assets;

  return {
    valid: true,
    payload,
    sceneDocument: payload.sceneDocument,
    manifest: payload.manifest || null,
  };
}

/**
 * Makes embedded assets available through the small JSZip-compatible surface
 * consumed by the existing import pipeline. Keeping binary data in this
 * provider avoids long-lived Blob URLs; normal import ownership (GLB import
 * and blob-store upload) remains responsible for the resulting URLs.
 */
export function createSingleHtmlAssetZip(assets = {}) {
  return {
    file(path) {
      if (!assets || typeof assets !== 'object' || !Object.hasOwn(assets, path)) return null;
      const asset = assets[path];
      if (!asset) return null;
      return {
        async async(type) {
          const bytes = decodeBase64(asset.base64);
          if (type === 'arraybuffer') {
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          }
          if (type === 'string') {
            return new TextDecoder().decode(bytes);
          }
          throw new Error(`Unsupported Single HTML asset read type: ${type}`);
        },
      };
    },
  };
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
  import('scene-sync-single-html/scenesync/handoff/source.js')
    .then(({ mountSingleHtmlHandoff }) => mountSingleHtmlHandoff({
      sceneDocument: payload.sceneDocument,
      embeddedAssets: payload.assets,
    }))
    .catch((error) => console.error('[Scene Sync handoff]', error));
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
    viewerFiles['scenesync/handoff/source.css'],
  ].filter((source) => typeof source === 'string').join('\n');
  const modules = {};
  const embeddedFiles = { ...files };

  for (const [path, source] of Object.entries(viewerFiles)) {
    if (path === 'viewer/viewer.css'
      || path === 'viewer/player-shell.css'
      || path === 'scenesync/handoff/source.css') continue;
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
