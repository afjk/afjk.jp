// Versioned, opener-free handoff payloads.  This module deliberately has no
// DOM dependencies so the presence server and browser use the same checks.
import { canonicalizeJsonValue, isSafeHandoffSourceUrl, validateStrictSceneDocument } from './protocol.js';
import { isValidSceneDocument } from '../../scenesync-export/viewer/scene-document.js';
import { validateSingleHtmlEmbeddedAssets } from '../../scenesync-export/export/single-html-format.js';

export const SCENE_SYNC_HANDOFF_TOKEN_VERSION = 1;
export const HANDOFF_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
export const DEFAULT_HANDOFF_TOKEN_LIMITS = Object.freeze({
  maxDecodedBytes: 32 * 1024 * 1024,
  maxAssetBytes: 32 * 1024 * 1024,
  maxAssetCount: 256,
  maxAssetPathBytes: 1024,
  maxMimeBytes: 128,
  // Encoded base64 needs roughly 4/3 of the decoded limit.  The JSON body is
  // separately capped by the server; canonicalisation still bounds all trees.
  maxStringBytes: 56 * 1024 * 1024,
  maxSceneDocumentBytes: 8 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 250_000,
  maxObjectCount: 10_000,
  maxIdLength: 256,
  maxSourceUrlBytes: 8192,
});

const ASSET_MIME_TYPES = new Set([
  'application/octet-stream', 'application/wasm', 'model/gltf-binary', 'model/gltf+json',
  'image/png', 'image/jpeg', 'image/webp', 'image/vnd.radiance',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'video/mp4', 'video/webm', 'video/ogg',
  'text/plain', 'text/markdown', 'application/json',
]);

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validateEmbeddedAssetMetadata(assets, limits) {
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) {
    return { valid: false, reason: 'invalid-handoff-token-assets' };
  }
  for (const [path, asset] of Object.entries(assets)) {
    if (byteLength(path) > limits.maxAssetPathBytes || !asset || typeof asset !== 'object' || Array.isArray(asset)
      || !hasOnlyKeys(asset, new Set(['mime', 'base64']))
      || typeof asset.mime !== 'string' || byteLength(asset.mime) > limits.maxMimeBytes
      || !ASSET_MIME_TYPES.has(asset.mime)) {
      return { valid: false, reason: 'invalid-handoff-token-asset-metadata' };
    }
  }
  return { valid: true };
}

/**
 * Returns a null-prototype canonical payload or a non-sensitive validation
 * reason.  It does not apply, rewrite, or otherwise mutate a scene.
 */
export function validateHandoffTokenPayload(value, limits = {}) {
  const resolved = { ...DEFAULT_HANDOFF_TOKEN_LIMITS, ...limits };
  const canonical = canonicalizeJsonValue(value, resolved);
  if (!canonical.valid) return canonical;
  const payload = canonical.value;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !hasOnlyKeys(payload, new Set(['version', 'mode', 'sceneDocument', 'embeddedAssets', 'sourceUrl']))
    || payload.version !== SCENE_SYNC_HANDOFF_TOKEN_VERSION || typeof payload.mode !== 'string') {
    return { valid: false, reason: 'invalid-handoff-token-payload' };
  }

  if (payload.mode === 'url') {
    if (Object.hasOwn(payload, 'sceneDocument') || Object.hasOwn(payload, 'embeddedAssets')
      || typeof payload.sourceUrl !== 'string' || byteLength(payload.sourceUrl) > resolved.maxSourceUrlBytes
      || !isSafeHandoffSourceUrl(payload.sourceUrl)) {
      return { valid: false, reason: 'invalid-handoff-token-source-url' };
    }
    return { valid: true, payload: Object.assign(Object.create(null), {
      version: SCENE_SYNC_HANDOFF_TOKEN_VERSION, mode: 'url', sourceUrl: new URL(payload.sourceUrl).href,
    }) };
  }

  if (payload.mode !== 'embedded' || Object.hasOwn(payload, 'sourceUrl')) {
    return { valid: false, reason: 'invalid-handoff-token-mode' };
  }
  const strict = validateStrictSceneDocument(payload.sceneDocument, resolved);
  if (!strict.valid || !isValidSceneDocument(payload.sceneDocument)) return strict.valid
    ? { valid: false, reason: 'invalid-handoff-scene-document' } : strict;
  if (byteLength(JSON.stringify(payload.sceneDocument)) > resolved.maxSceneDocumentBytes) {
    return { valid: false, reason: 'handoff-token-scene-document-too-large' };
  }
  const metadata = validateEmbeddedAssetMetadata(payload.embeddedAssets, resolved);
  if (!metadata.valid) return metadata;
  const assets = validateSingleHtmlEmbeddedAssets(payload.embeddedAssets, {
    sceneDocument: payload.sceneDocument,
    documentBytes: resolved.maxStringBytes,
    assetCount: resolved.maxAssetCount,
    assetBytes: resolved.maxAssetBytes,
    totalAssetBytes: resolved.maxDecodedBytes,
  });
  if (!assets.valid) return assets;
  return { valid: true, payload: Object.assign(Object.create(null), {
    version: SCENE_SYNC_HANDOFF_TOKEN_VERSION,
    mode: 'embedded',
    sceneDocument: payload.sceneDocument,
    embeddedAssets: payload.embeddedAssets,
  }), decodedBytes: assets.totalBytes };
}

export function isValidHandoffToken(value) {
  return typeof value === 'string' && HANDOFF_TOKEN_PATTERN.test(value);
}
