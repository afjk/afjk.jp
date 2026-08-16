// A small, fragment-only handoff envelope for CSP-constrained embedded
// viewers.  It intentionally carries only compact Single HTML payloads; the
// target validates the decoded JSON with the normal token payload validator
// before it can reach an importer.
export const MAX_INLINE_HANDOFF_DECODED_BYTES = 384 * 1024;
export const MAX_INLINE_HANDOFF_ENCODED_BYTES = 512 * 1024;
// Sources stay below the strict scene/asset payload caps without importing the
// target-only validator into portable Static/Single HTML module graphs.
export const MAX_INLINE_HANDOFF_SOURCE_BYTES = 128 * 1024;
export const INLINE_HANDOFF_PAYLOAD_LIMITS = Object.freeze({
  maxDecodedBytes: 128 * 1024,
  maxAssetBytes: 64 * 1024,
  maxAssetCount: 32,
  maxSceneDocumentBytes: 128 * 1024,
  maxStringBytes: 384 * 1024,
  maxDepth: 32,
  maxNodes: 50_000,
});

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;
const ROOM_PATTERN = /^[a-z0-9-]{1,24}$/u;
const PASSIVE_MIME_TYPES = new Set([
  'application/octet-stream', 'application/wasm', 'model/gltf-binary', 'model/gltf+json',
  'image/png', 'image/jpeg', 'image/webp', 'image/vnd.radiance',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'video/mp4', 'video/webm', 'video/ogg',
  'text/plain', 'text/markdown', 'application/json',
]);

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function hasOnlyKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function decodedBase64Bytes(value) {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) return -1;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function isBoundedJsonTree(value) {
  const ancestors = new WeakSet();
  let nodes = 0; let stringBytes = 0;
  function visit(input, depth) {
    nodes += 1;
    if (nodes > INLINE_HANDOFF_PAYLOAD_LIMITS.maxNodes || depth > INLINE_HANDOFF_PAYLOAD_LIMITS.maxDepth) return false;
    if (input === null || typeof input === 'boolean') return true;
    if (typeof input === 'number') return Number.isFinite(input);
    if (typeof input === 'string') {
      stringBytes += byteLength(input);
      return stringBytes <= INLINE_HANDOFF_PAYLOAD_LIMITS.maxStringBytes;
    }
    if (!input || typeof input !== 'object' || ancestors.has(input)) return false;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(input)) return false;
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        for (let index = 0; index < input.length; index += 1) {
          if (!Object.hasOwn(input, index) || !visit(input[index], depth + 1)) return false;
        }
        return true;
      }
      for (const [key, child] of Object.entries(input)) {
        stringBytes += byteLength(key);
        if (stringBytes > INLINE_HANDOFF_PAYLOAD_LIMITS.maxStringBytes || !visit(child, depth + 1)) return false;
      }
      return true;
    } finally {
      ancestors.delete(input);
    }
  }
  return visit(value, 0);
}

// This is a source-side choice guard, not an importer. The target repeats the
// complete strict SceneDocument/payload validation before any mutation.
export function isInlineHandoffEnvelopeEligible(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || !hasOnlyKeys(envelope, ['kind', 'payload', 'requestId', 'roomId', 'sessionId', 'version'])
    || envelope.kind !== 'scene-sync-inline-handoff' || envelope.version !== 1
    || !HANDOFF_ID_PATTERN.test(envelope.sessionId || '') || !HANDOFF_ID_PATTERN.test(envelope.requestId || '')
    || (envelope.roomId != null && (!ROOM_PATTERN.test(envelope.roomId) || envelope.roomId.length > 24))) return false;
  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !hasOnlyKeys(payload, ['embeddedAssets', 'mode', 'sceneDocument', 'version'])
    || payload.version !== 1 || payload.mode !== 'embedded'
    || !payload.sceneDocument || typeof payload.sceneDocument !== 'object' || Array.isArray(payload.sceneDocument)
    || !payload.embeddedAssets || typeof payload.embeddedAssets !== 'object' || Array.isArray(payload.embeddedAssets)) return false;
  if (!isBoundedJsonTree(payload.sceneDocument)) return false;
  let sceneJson;
  try { sceneJson = JSON.stringify(payload.sceneDocument); } catch { return false; }
  if (typeof sceneJson !== 'string' || byteLength(sceneJson) > INLINE_HANDOFF_PAYLOAD_LIMITS.maxSceneDocumentBytes) return false;
  const assets = Object.entries(payload.embeddedAssets);
  if (assets.length > INLINE_HANDOFF_PAYLOAD_LIMITS.maxAssetCount) return false;
  let totalBytes = 0;
  for (const [path, asset] of assets) {
    if (!path || byteLength(path) > 1024 || !asset || typeof asset !== 'object' || Array.isArray(asset)
      || !hasOnlyKeys(asset, ['base64', 'mime']) || typeof asset.mime !== 'string'
      || byteLength(asset.mime) > 128 || !PASSIVE_MIME_TYPES.has(asset.mime)) return false;
    const bytes = decodedBase64Bytes(asset.base64);
    if (bytes < 0 || bytes > INLINE_HANDOFF_PAYLOAD_LIMITS.maxAssetBytes) return false;
    totalBytes += bytes;
    if (totalBytes > INLINE_HANDOFF_PAYLOAD_LIMITS.maxDecodedBytes) return false;
  }
  return true;
}

function encodeBase64Url(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function decodeBase64Url(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + padding);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function encodeInlineHandoffPayload(payload, { maxDecodedBytes = MAX_INLINE_HANDOFF_SOURCE_BYTES } = {}) {
  if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 1 || maxDecodedBytes > MAX_INLINE_HANDOFF_DECODED_BYTES) return null;
  let json;
  try { json = JSON.stringify(payload); } catch { return null; }
  if (typeof json !== 'string') return null;
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > maxDecodedBytes) return null;
  const encoded = encodeBase64Url(bytes);
  return encoded.length <= MAX_INLINE_HANDOFF_ENCODED_BYTES ? encoded : null;
}

export function decodeInlineHandoffPayload(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0
    || encoded.length > MAX_INLINE_HANDOFF_ENCODED_BYTES || !BASE64URL_PATTERN.test(encoded)) {
    return { valid: false, reason: 'invalid-inline-handoff-payload' };
  }
  try {
    const bytes = decodeBase64Url(encoded);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_INLINE_HANDOFF_DECODED_BYTES) {
      return { valid: false, reason: 'inline-handoff-payload-too-large' };
    }
    if (encodeBase64Url(bytes) !== encoded) return { valid: false, reason: 'invalid-inline-handoff-payload' };
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { valid: true, value: JSON.parse(json) };
  } catch {
    return { valid: false, reason: 'invalid-inline-handoff-payload' };
  }
}

export function isInlineHandoffPayloadEncoding(value) {
  return typeof value === 'string' && value.length > 0
    && value.length <= MAX_INLINE_HANDOFF_ENCODED_BYTES && BASE64URL_PATTERN.test(value);
}
