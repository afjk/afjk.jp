import { inferMimeForExportAsset } from './zip-asset-upload.js';

// URL imports must become self-contained before we mutate the room.  Keeping a
// remote URL in a scene would make a successful import depend on the publisher
// forever (and would silently re-send private URL credentials to peers).
export const DEFAULT_REMOTE_ASSET_LIMITS = Object.freeze({
  maxAssets: 2048,
  maxAssetBytes: 128 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
});

function error(code, message = code) {
  const value = new Error(message);
  value.code = code;
  return value;
}

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function safePath(path) {
  if (typeof path !== 'string' || !path || path.length > 1024 || path.startsWith('/')
    || path.includes('\\') || /[:?#\u0000-\u001f]/u.test(path)) return false;
  const pieces = path.split('/');
  return pieces.every((piece) => piece && piece !== '.' && piece !== '..' && !/%2e|%2f/i.test(piece));
}

function remoteUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function basename(url, index) {
  const name = new URL(url).pathname.split('/').filter(Boolean).at(-1) || `asset-${index}`;
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || `asset-${index}`;
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw error('handoff-remote-asset-too-large');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = typeof response.arrayBuffer === 'function'
      ? await response.arrayBuffer()
      : typeof response.blob === 'function'
        ? await (await response.blob()).arrayBuffer()
        : new TextEncoder().encode(await response.text()).buffer;
    if (buffer.byteLength > maxBytes) throw error('handoff-remote-asset-too-large');
    return buffer;
  }
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw error('handoff-remote-asset-too-large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

function virtualZip(entries) {
  return {
    file(path) {
      const entry = entries.get(path);
      if (!entry) return null;
      return { async: async (type) => type === 'string'
        ? new TextDecoder().decode(entry.buffer)
        : entry.buffer.slice(0) };
    },
  };
}

function normalizeIgnoredAsset(asset) {
  if (!asset || typeof asset !== 'object') return;
  if (asset.type === 'primitive') {
    delete asset.path; delete asset.url; delete asset.username; delete asset.password;
  }
  if (asset.type === 'text' && asset.source === 'inline') {
    delete asset.path; delete asset.url; delete asset.username; delete asset.password;
  }
}

function addRef(refs, holder, key, asset, type, baseUrl, index) {
  normalizeIgnoredAsset(asset);
  if (!asset || asset.type === 'primitive' || (asset.type === 'text' && asset.source === 'inline')) return;
  const rawPath = typeof asset.path === 'string' ? asset.path : null;
  const rawUrl = typeof asset.url === 'string' ? asset.url : null;
  if (!rawPath && !rawUrl) return;
  if (rawPath && !safePath(rawPath)) throw error('handoff-unsafe-asset-path');
  // A package path is authoritative. Never let a document smuggle a second
  // remote URL past a local/static package declaration.
  const url = remoteUrl(rawPath || rawUrl, baseUrl);
  if (!url) throw error('handoff-invalid-asset-url');
  const path = rawPath || `remote-assets/${index}-${basename(url, index)}`;
  refs.push({ holder, key, asset, type, path, url });
}

// Fetches every referenced object/audio/BGM asset with credentials omitted,
// checks both advertised and actual bytes, and exposes the result through the
// same small ZIP interface used by normal ZIP imports.
export async function materializeSceneDocumentUrlAssets(sceneDocument, {
  baseUrl,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  limits = {},
  signal,
  includeSceneLevel = true,
} = {}) {
  if (!baseUrl || typeof fetchImpl !== 'function') throw error('handoff-remote-fetch-unavailable');
  const resolved = { ...DEFAULT_REMOTE_ASSET_LIMITS, ...limits };
  const document = clone(sceneDocument);
  const refs = [];
  let index = 0;
  for (const object of document.objects || []) {
    addRef(refs, object, 'asset', object.asset, 'object', baseUrl, index++);
    for (const source of Object.values(object.audioSources || {})) {
      const asset = source?.asset || (source?.url ? { url: source.url, mime: source.mime } : null);
      if (asset) addRef(refs, source, source.asset ? 'asset' : '__directUrl', asset, 'audio', baseUrl, index++);
    }
  }
  if (includeSceneLevel && (document.bgm?.asset || document.bgm?.url)) {
    const asset = document.bgm.asset || { url: document.bgm.url, mime: document.bgm.mime };
    addRef(refs, document.bgm, document.bgm.asset ? 'asset' : '__directUrl', asset, 'bgm', baseUrl, index++);
  }
  if (refs.length > resolved.maxAssets) throw error('handoff-too-many-remote-assets');

  const entries = new Map();
  const byPath = new Map();
  let total = 0;
  // Detect path collisions before any network side effect. This also makes a
  // malformed document atomic even when the first remote host is unavailable.
  for (const ref of refs) {
    if (signal?.aborted) throw error('handoff-url-timeout');
    const prior = byPath.get(ref.path);
    if (prior && prior !== ref.url) throw error('handoff-remote-asset-path-collision');
    byPath.set(ref.path, ref.url);
  }
  for (const ref of refs) {
    if (entries.has(ref.path)) continue;
    let response;
    try { response = await fetchImpl(ref.url, { mode: 'cors', credentials: 'omit', signal }); }
    catch (cause) {
      const failure = error('handoff-remote-asset-fetch-failed');
      // Fetch deliberately hides CORS as TypeError.  The handoff caller may
      // use its server-side static-export path only for that opaque class;
      // HTTP, validation, and size errors must remain browser-direct.
      failure.networkFailure = cause instanceof TypeError;
      failure.cause = cause;
      throw failure;
    }
    if (!response?.ok) throw error('handoff-remote-asset-http-error');
    const allowance = Math.min(resolved.maxAssetBytes, resolved.maxTotalBytes - total);
    if (allowance <= 0) throw error('handoff-remote-assets-too-large');
    const buffer = await readLimited(response, allowance);
    total += buffer.byteLength;
    if (total > resolved.maxTotalBytes) throw error('handoff-remote-assets-too-large');
    entries.set(ref.path, { buffer, mime: response.headers?.get?.('content-type') || '' });
  }
  for (const ref of refs) {
    const target = ref.key === '__directUrl' ? ref.holder : ref.holder[ref.key];
    if (!target) continue;
    if (ref.key === '__directUrl') {
      target.asset = { path: ref.path, mime: target.mime || entries.get(ref.path)?.mime };
      delete target.url;
    } else {
      target.path = ref.path;
      target.mime ||= entries.get(ref.path)?.mime || inferMimeForExportAsset(target);
      delete target.url;
    }
  }
  return { document, zip: virtualZip(entries), assetCount: refs.length, totalBytes: total };
}
