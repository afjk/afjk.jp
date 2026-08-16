// A small, fragment-only handoff envelope for CSP-constrained embedded
// viewers.  It intentionally carries only compact Single HTML payloads; the
// target validates the decoded JSON with the normal token payload validator
// before it can reach an importer.
export const MAX_INLINE_HANDOFF_DECODED_BYTES = 384 * 1024;
export const MAX_INLINE_HANDOFF_ENCODED_BYTES = 512 * 1024;
// Sources stay below the strict scene/asset payload caps without importing the
// target-only validator into portable Static/Single HTML module graphs.
export const MAX_INLINE_HANDOFF_SOURCE_BYTES = 128 * 1024;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

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
