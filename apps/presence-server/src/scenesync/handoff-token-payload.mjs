// Server-local copy of the token payload gate. The Docker image copies only
// apps/presence-server/src, so do not import browser assets from here.
export const HANDOFF_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_DECODED = 32 * 1024 * 1024;
const MAX_SCENE = 8 * 1024 * 1024;
const MIME = new Set(['application/octet-stream', 'application/wasm', 'application/json', 'model/gltf-binary', 'model/gltf+json', 'image/png', 'image/jpeg', 'image/webp', 'image/vnd.radiance', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'video/mp4', 'video/webm', 'video/ogg', 'text/plain', 'text/markdown']);
const bytes = (value) => Buffer.byteLength(String(value), 'utf8');
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const b64Bytes = (value) => {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return -1;
  return value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
};
function canonical(value, { depth = 0, state = { nodes: 0, strings: 0 } } = {}) {
  if (++state.nodes > 250_000 || depth > 64) throw new Error('complex');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('number'); return value; }
  if (typeof value === 'string') { state.strings += bytes(value); if (state.strings > 56 * 1024 * 1024) throw new Error('strings'); return value; }
  if (Array.isArray(value)) return value.map((item) => canonical(item, { depth: depth + 1, state }));
  if (!plain(value)) throw new Error('object');
  const out = Object.create(null);
  for (const [key, child] of Object.entries(value)) { state.strings += bytes(key); out[key] = canonical(child, { depth: depth + 1, state }); }
  return out;
}
function documentValid(doc) {
  if (!plain(doc) || doc.format !== 'scene-sync-export-scene' || ![1, 2].includes(doc.version) || !Array.isArray(doc.objects) || doc.objects.length > 10_000 || bytes(JSON.stringify(doc)) > MAX_SCENE) return false;
  const ids = new Set();
  return doc.objects.every((item) => plain(item) && typeof item.id === 'string' && item.id && item.id.length <= 256 && !ids.has(item.id) && (ids.add(item.id), true)
    && [[item.position, 3], [item.rotation, 4], [item.scale, 3]].every(([vector, length]) => Array.isArray(vector) && vector.length === length && vector.every(Number.isFinite)));
}
export function isValidHandoffToken(value) { return typeof value === 'string' && HANDOFF_TOKEN_PATTERN.test(value); }
export function validateHandoffTokenPayload(input) {
  let value; try { value = canonical(input); } catch { return { valid: false, reason: 'invalid-handoff-token-payload' }; }
  const keys = Object.keys(value || {});
  if (!plain(value) || value.version !== 1 || !['embedded', 'url'].includes(value.mode) || keys.some((key) => !['version', 'mode', 'sceneDocument', 'embeddedAssets', 'sourceUrl'].includes(key))) return { valid: false, reason: 'invalid-handoff-token-payload' };
  if (value.mode === 'url') {
    try { const url = new URL(value.sourceUrl); if (keys.length !== 3 || !/^https?:$/u.test(url.protocol) || url.username || url.password || bytes(value.sourceUrl) > 8192) throw new Error(); return { valid: true, payload: Object.assign(Object.create(null), { version: 1, mode: 'url', sourceUrl: url.href }) }; } catch { return { valid: false, reason: 'invalid-handoff-token-source-url' }; }
  }
  if (Object.hasOwn(value, 'sourceUrl') || !documentValid(value.sceneDocument) || !plain(value.embeddedAssets)) return { valid: false, reason: 'invalid-handoff-token-payload' };
  let total = 0; const entries = Object.entries(value.embeddedAssets);
  if (entries.length > 256) return { valid: false, reason: 'invalid-handoff-token-assets' };
  for (const [path, asset] of entries) {
    const count = b64Bytes(asset?.base64);
    if (!path || bytes(path) > 1024 || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || ['.', '..', '__proto__', 'constructor', 'prototype'].includes(part)) || !plain(asset) || Object.keys(asset).some((key) => key !== 'mime' && key !== 'base64') || !MIME.has(asset.mime) || bytes(asset.mime) > 128 || count < 0 || count > MAX_DECODED || (total += count) > MAX_DECODED) return { valid: false, reason: 'invalid-handoff-token-assets' };
  }
  return { valid: true, payload: Object.assign(Object.create(null), { version: 1, mode: 'embedded', sceneDocument: value.sceneDocument, embeddedAssets: value.embeddedAssets }) };
}
