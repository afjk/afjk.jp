// Server-side materialization for Scene Sync URL handoffs.  This deliberately
// accepts an export *description*, never exposes a fetched response, and only
// returns a validated document whose assets point to our blob store.
import { createHash, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const SERVER_PULL_LIMITS = Object.freeze({
  maxDocumentBytes: 10 * 1024 * 1024,
  maxAssets: 2048,
  maxAssetBytes: 128 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
  maxRedirects: 5,
  timeoutMs: 30_000,
  overallTimeoutMs: 10 * 60 * 1000,
});

const HANDOFF_ID = /^[A-Za-z0-9_-]{22,128}$/u;

function failure(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function header(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  return headers[String(name).toLowerCase()] || headers[name] || '';
}

function contentType(headers) {
  return String(header(headers, 'content-type')).split(';')[0].trim().toLowerCase();
}

function safeUrl(value, { allowHttpForTests = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > 8192) throw failure('handoff-invalid-source-url');
  let url;
  try { url = new URL(value); } catch { throw failure('handoff-invalid-source-url'); }
  if (url.username || url.password || (url.protocol !== 'https:' && !(allowHttpForTests && url.protocol === 'http:'))) {
    throw failure('handoff-invalid-source-url');
  }
  if (!allowHttpForTests && url.port) throw failure('handoff-invalid-source-url');
  return url;
}

function ipv4IsPublic(value) {
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function isPublicIp(address) {
  const family = net.isIP(address);
  if (family === 4) return ipv4IsPublic(address);
  if (family !== 6) return false;
  const value = ipv6ToBigInt(address);
  if (value == null) return false;
  // Reject all special-use ranges with real prefix arithmetic, so compressed
  // spellings such as 2001::1 cannot evade a textual prefix check.
  if (hasV6Prefix(value, 0n, 128) || hasV6Prefix(value, 1n, 128)
    || hasV6Prefix(value, 0n, 96) || hasV6Prefix(value, 0xffffn, 96) // compatible/mapped
    || hasV6Prefix(value, 0x7en, 7) || hasV6Prefix(value, 0x3fan, 10) || hasV6Prefix(value, 0xffn, 8)
    || hasV6Prefix(value, 0x64ff9b0000000000000000n, 96) || hasV6Prefix(value, 0x64ff9b0001n, 48)
    || hasV6Prefix(value, 0x100n, 64) || hasV6Prefix(value, 0x20010000n, 32) // discard/Teredo
    || hasV6Prefix(value, 0x2002n, 16) || hasV6Prefix(value, 0x20010db8n, 32)
    || hasV6Prefix(value, 0x20010002n, 48) || hasV6Prefix(value, 0x20010n, 28)) return false;
  return true;
}

function ipv6ToBigInt(address) {
  const raw = String(address).toLowerCase().split('%')[0];
  if (!raw || raw.split('::').length > 2) return null;
  const [leftRaw, rightRaw] = raw.split('::');
  const expand = (part) => part ? part.split(':').filter(Boolean) : [];
  let left = expand(leftRaw); let right = expand(rightRaw);
  const dotted = [...left, ...right].findIndex((part) => part.includes('.'));
  if (dotted >= 0) {
    const all = [...left, ...right];
    if (dotted !== all.length - 1 || !net.isIP(all[dotted])) return null;
    const octets = all[dotted].split('.').map(Number);
    all.splice(dotted, 1, ((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16));
    left = raw.includes('::') ? all.slice(0, left.length) : all;
    right = raw.includes('::') ? all.slice(left.length) : [];
  }
  const count = left.length + right.length;
  if ((raw.includes('::') && count >= 8) || (!raw.includes('::') && count !== 8)) return null;
  const groups = [...left, ...Array(raw.includes('::') ? 8 - count : 0).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function hasV6Prefix(value, prefix, bits) {
  const width = BigInt(128 - bits);
  return (value >> width) === prefix;
}

async function resolvePublicHost(hostname, resolveHost) {
  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) throw failure('handoff-ssrf-blocked', 403);
    return [{ address: hostname, family: net.isIP(hostname) }];
  }
  const records = await resolveHost(hostname);
  if (!Array.isArray(records) || records.length === 0 || records.some((record) => !isPublicIp(record?.address))) {
    throw failure('handoff-ssrf-blocked', 403);
  }
  return records;
}

function requestOnce(url, addresses, { timeoutMs, signal }) {
  const transport = url.protocol === 'https:' ? https : http;
  const lookup = (_hostname, _options, callback) => callback(null, addresses[0].address, addresses[0].family);
  return new Promise((resolve, reject) => {
    let responseRef = null;
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const finishReject = (error) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const request = transport.request(url, {
      method: 'GET', headers: { accept: 'text/html,application/json,*/*;q=0.1', 'accept-encoding': 'identity', 'user-agent': 'SceneSyncServerPull/1' },
      lookup, timeout: timeoutMs, servername: url.hostname,
    }, (response) => {
      if (settled) { response.destroy(); return; }
      responseRef = response;
      response.setTimeout(timeoutMs, () => response.destroy(failure('handoff-url-idle-timeout', 504)));
      response.once('close', cleanup);
      settled = true;
      resolve(response);
    });
    const abort = () => {
      const error = failure('handoff-url-timeout', 504);
      request.destroy(error);
      responseRef?.destroy(error);
    };
    if (signal) signal.addEventListener('abort', abort, { once: true });
    request.once('timeout', abort);
    request.once('error', finishReject);
    request.end();
  });
}

async function nativeFetch(url, options) {
  const addresses = await resolvePublicHost(url.hostname, options.resolveHost);
  return await requestOnce(url, addresses, options);
}

async function fetchSafe(urlValue, options) {
  let url = safeUrl(urlValue, options);
  for (let redirects = 0; redirects <= options.limits.maxRedirects; redirects += 1) {
    if (options.requiredOrigin && url.origin !== options.requiredOrigin) throw failure('handoff-cross-origin-redirect', 403);
    // Validate before *every* request, including injected transports used by
    // integration tests. Native transport also pins its connection to this
    // validated address via request.lookup.
    await resolvePublicHost(url.hostname, options.resolveHost);
    const response = options.fetchImpl
      ? await options.fetchImpl(url.href, { signal: options.signal, redirect: 'manual' })
      : await nativeFetch(url, options);
    const status = Number(response.statusCode || response.status || 0);
    const location = header(response.headers, 'location');
    if (status >= 300 && status < 400 && location) {
      if (redirects === options.limits.maxRedirects) throw failure('handoff-too-many-redirects', 400);
      try { response.resume?.(); } catch {}
      url = safeUrl(new URL(location, url).href, options);
      // Every redirect starts a fresh request and therefore a fresh DNS/public-IP validation.
      continue;
    }
    if (status < 200 || status >= 300) {
      try { response.resume?.(); } catch {}
      throw failure('handoff-remote-http-error', 400);
    }
    const encoding = String(header(response.headers, 'content-encoding')).trim().toLowerCase();
    if (encoding && encoding !== 'identity') { try { response.destroy?.(); } catch {} throw failure('handoff-encoded-response-rejected'); }
    return { response, url };
  }
  throw failure('handoff-too-many-redirects', 400);
}

async function readTextLimited(response, maxBytes) {
  const declared = Number(header(response.headers, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw failure('handoff-document-too-large', 413);
  const chunks = []; let total = 0;
  for await (const raw of response.body || response) {
    const chunk = Buffer.from(raw);
    total += chunk.length;
    if (total > maxBytes) { response.destroy?.(); throw failure('handoff-document-too-large', 413); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function extractMarker(html) {
  const link = html.match(/<link\b[^>]*\brel=["']scene-sync-export["'][^>]*\bhref=["']([^"']+)["'][^>]*>/iu)
    || html.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']scene-sync-export["'][^>]*>/iu);
  return link?.[1] || null;
}

function assertSceneDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || document.format !== 'scene-sync-export-scene' || document.version !== 2 || !Array.isArray(document.objects)) {
    throw failure('handoff-invalid-scene-document');
  }
  if (document.objects.length > 10_000) throw failure('handoff-too-many-objects', 413);
  let nodes = 0; let stringBytes = 0;
  const visit = (value, depth = 0) => {
    nodes += 1;
    if (nodes > 250_000 || depth > 64) throw failure('handoff-scene-too-complex', 413);
    if (typeof value === 'string') { stringBytes += Buffer.byteLength(value); if (stringBytes > SERVER_PULL_LIMITS.maxDocumentBytes) throw failure('handoff-scene-too-large', 413); return; }
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw failure('handoff-invalid-scene-document'); return; }
    if (!value || typeof value !== 'object') throw failure('handoff-invalid-scene-document');
    for (const [key, child] of Object.entries(value)) { stringBytes += Buffer.byteLength(key); visit(child, depth + 1); }
  };
  visit(document);
  const ids = new Set();
  for (const object of document.objects) {
    if (!object || typeof object !== 'object' || typeof object.id !== 'string' || !object.id || object.id.length > 256
      || ids.has(object.id) || ![object.position, object.rotation, object.scale].every(Array.isArray)) {
      throw failure('handoff-invalid-scene-document');
    }
    if (object.position.length !== 3 || object.rotation.length !== 4 || object.scale.length !== 3
      || ![...object.position, ...object.rotation, ...object.scale].every(Number.isFinite)) throw failure('handoff-invalid-scene-document');
    ids.add(object.id);
    const asset = object.asset;
    if (asset && (typeof asset !== 'object' || !['primitive', 'mesh', 'image', 'video', 'text'].includes(asset.type))) {
      throw failure('handoff-invalid-asset-type');
    }
  }
}

function assetUrl(value, baseUrl, sourceOrigin) {
  if (typeof value !== 'string' || !value || value.length > 1024) throw failure('handoff-unsafe-asset-path');
  if (value.startsWith('/') || value.includes('\\') || value.includes('?') || value.includes('#') || /\u0000|[\x00-\x1f]|%2e|%2f/iu.test(value)
    || value.split('/').some((segment) => !segment || segment === '.' || segment === '..' || segment.includes(':'))) throw failure('handoff-unsafe-asset-path');
  const url = safeUrl(new URL(value, baseUrl).href, { allowHttpForTests: baseUrl.protocol === 'http:' });
  if (url.origin !== sourceOrigin) throw failure('handoff-cross-origin-asset', 403);
  return url;
}

function collectAssets(document, baseUrl, maxAssets) {
  const refs = []; const paths = new Map();
  const add = (asset, type, assign) => {
    if (!asset || typeof asset !== 'object' || asset.type === 'primitive' || (asset.type === 'text' && asset.source === 'inline')) return;
    const raw = typeof asset.path === 'string' ? asset.path : asset.url;
    if (!raw) return;
    const url = assetUrl(raw, baseUrl, baseUrl.origin);
    const path = typeof asset.path === 'string' ? asset.path : url.pathname.slice(1);
    const prior = paths.get(path);
    if (prior && prior.href !== url.href) throw failure('handoff-remote-asset-path-collision');
    paths.set(path, url);
    refs.push({ url, path, type, assign });
  };
  for (const object of document.objects) {
    add(object.asset, object.asset?.type, (saved) => {
      if (object.asset?.type === 'mesh') {
        object.asset = {
          ...object.asset,
          source: 'carrier',
          meshPath: saved.id,
          mime: object.asset?.mime || saved.mime,
          size: saved.size,
        };
        delete object.asset.path;
        delete object.asset.url;
        return;
      }
      object.asset = {
        ...object.asset, url: saved.url, mime: object.asset?.mime || saved.mime,
        // URL-backed mesh/text import paths are explicit; otherwise mesh
        // becomes a default box and text is silently treated as inline.
        ...(object.asset?.type === 'mesh' || object.asset?.type === 'text' ? { source: 'url' } : {}),
      };
      delete object.asset.path;
    });
    for (const source of Object.values(object.audioSources || {})) {
      const asset = source?.asset || (source?.url ? { url: source.url } : null);
      add(asset, 'audio', (saved) => {
        source.url = saved.url; source.mime ||= saved.mime; delete source.asset;
      });
    }
  }
  // BGM is intentionally not carried by URL handoff (the browser importer also
  // excludes scene-level settings); do not fetch an unrelated long-lived asset.
  if (refs.length > maxAssets) throw failure('handoff-too-many-remote-assets', 413);
  return refs;
}

function mimeAllowed(type, mime) {
  if (!mime || mime === 'application/octet-stream') return true;
  if (type === 'mesh') return mime === 'model/gltf-binary' || mime === 'model/gltf+json';
  if (type === 'image') return mime.startsWith('image/');
  if (type === 'video') return mime.startsWith('video/');
  if (type === 'audio') return mime.startsWith('audio/');
  if (type === 'text') return mime.startsWith('text/') || mime === 'application/json';
  return false;
}

export function createServerPullImporter({
  storeAsset,
  removeAsset = async () => {},
  fetchImpl,
  resolveHost = (host) => dnsLookup(host, { all: true, verbatim: true }),
  allowHttpForTests = false,
  limits = {},
} = {}) {
  if (typeof storeAsset !== 'function') throw new Error('storeAsset is required');
  const resolvedLimits = { ...SERVER_PULL_LIMITS, ...limits };
  const fetchOptions = { fetchImpl, resolveHost, allowHttpForTests, limits: resolvedLimits, timeoutMs: resolvedLimits.timeoutMs };

  async function inspect(sourceUrl, { signal } = {}) {
    const deadline = new AbortController();
    const abort = () => deadline.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const deadlineTimer = setTimeout(abort, resolvedLimits.overallTimeoutMs);
    try {
      const sourceOrigin = safeUrl(sourceUrl, { allowHttpForTests }).origin;
      const first = await fetchSafe(sourceUrl, { ...fetchOptions, signal: deadline.signal, requiredOrigin: sourceOrigin });
      const firstType = contentType(first.response.headers);
      const firstText = await readTextLimited(first.response, resolvedLimits.maxDocumentBytes);
      // Server pull intentionally has no ZIP or Single HTML semantics. Their
      // payloads would be arbitrary remote bodies rather than a static marker.
      if (/zip|octet-stream/u.test(firstType) || /scene-sync-export-format/i.test(firstText)) {
        throw failure('handoff-url-kind-rejected');
      }
      let sceneUrl = first.url;
      let sceneText = firstText;
      const marker = extractMarker(firstText);
      if (marker) {
        sceneUrl = safeUrl(new URL(marker, first.url).href, { allowHttpForTests });
        if (sceneUrl.origin !== first.url.origin) throw failure('handoff-cross-origin-marker', 403);
        const scene = await fetchSafe(sceneUrl.href, { ...fetchOptions, signal: deadline.signal, requiredOrigin: sourceOrigin });
        sceneUrl = scene.url;
        sceneText = await readTextLimited(scene.response, resolvedLimits.maxDocumentBytes);
      }
      let sceneDocument;
      try { sceneDocument = JSON.parse(sceneText); } catch {
        // Mirror static world URLs supported by the browser loader: a plain
        // directory can expose scene.json directly or current.json -> an
        // immutable version directory. This remains same-origin and marker/
        // JSON-only; ZIP and Single HTML are deliberately rejected above.
        if (marker) throw failure('handoff-invalid-scene-json');
        const directory = new URL('./', first.url);
        let sceneCandidate = new URL('scene.json', directory);
        let sceneFetched;
        try { sceneFetched = await fetchSafe(sceneCandidate.href, { ...fetchOptions, signal: deadline.signal, requiredOrigin: sourceOrigin }); }
        catch {
          let currentFetched;
          try { currentFetched = await fetchSafe(new URL('current.json', directory).href, { ...fetchOptions, signal: deadline.signal, requiredOrigin: sourceOrigin }); }
          catch { throw failure('handoff-not-scene-sync-export'); }
          let current;
          try { current = JSON.parse(await readTextLimited(currentFetched.response, resolvedLimits.maxDocumentBytes)); }
          catch { throw failure('handoff-invalid-current-json'); }
          const versionPath = typeof current?.versionPath === 'string' ? current.versionPath
            : typeof current?.versionId === 'string' ? `versions/${current.versionId}/` : '';
          if (!versionPath) throw failure('handoff-current-json-missing-version');
          sceneCandidate = assetUrl(`${versionPath.replace(/\/$/u, '')}/scene.json`, directory, sourceOrigin);
          sceneFetched = await fetchSafe(sceneCandidate.href, { ...fetchOptions, signal: deadline.signal, requiredOrigin: sourceOrigin });
        }
        sceneUrl = sceneFetched.url;
        sceneText = await readTextLimited(sceneFetched.response, resolvedLimits.maxDocumentBytes);
        try { sceneDocument = JSON.parse(sceneText); } catch { throw failure('handoff-invalid-scene-json'); }
      }
      assertSceneDocument(sceneDocument);
      const digest = createHash('sha256').update(JSON.stringify(sceneDocument)).digest('base64url');
      return { sceneDocument, sceneUrl, sourceOrigin, digest };
    } finally {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function importSceneSyncUrl(sourceUrl, { signal, expectedDigest } = {}) {
    const stored = [];
    try {
      const inspected = await inspect(sourceUrl, { signal });
      if (expectedDigest && expectedDigest !== inspected.digest) throw failure('handoff-inspection-changed', 409);
      const { sceneUrl, sourceOrigin } = inspected;
      const document = inspected.sceneDocument;
      const refs = collectAssets(document, sceneUrl, resolvedLimits.maxAssets);
      const unique = new Map();
      for (const ref of refs) if (!unique.has(ref.url.href)) unique.set(ref.url.href, ref);
      if (unique.size > resolvedLimits.maxAssets) throw failure('handoff-too-many-remote-assets', 413);
      let total = 0;
      const materialized = new Map();
      for (const ref of unique.values()) {
        const fetched = await fetchSafe(ref.url.href, { ...fetchOptions, signal, requiredOrigin: sourceOrigin });
        const mime = contentType(fetched.response.headers);
        if (!mimeAllowed(ref.type, mime)) { fetched.response.destroy?.(); throw failure('handoff-invalid-asset-mime'); }
        const declared = Number(header(fetched.response.headers, 'content-length'));
        const allowance = Math.min(resolvedLimits.maxAssetBytes, resolvedLimits.maxTotalBytes - total);
        if (allowance <= 0 || (Number.isFinite(declared) && declared > allowance)) throw failure('handoff-remote-assets-too-large', 413);
        const id = randomUUID().replace(/-/g, '');
        const storedAsset = await storeAsset({ id, body: fetched.response.body || fetched.response, mime: mime || 'application/octet-stream', maxBytes: allowance, signal });
        if (!storedAsset || !Number.isFinite(storedAsset.size) || storedAsset.size > allowance) throw failure('handoff-asset-store-failed', 500);
        stored.push(id); total += storedAsset.size;
        materialized.set(ref.url.href, { id, size: storedAsset.size, url: storedAsset.url, mime: storedAsset.mime || mime });
      }
      for (const ref of refs) {
        const saved = materialized.get(ref.url.href);
        ref.assign(saved);
      }
      return { sceneDocument: document, assetCount: unique.size, totalBytes: total, storedIds: stored, digest: inspected.digest };
    } catch (error) {
      await Promise.allSettled(stored.map((id) => removeAsset(id)));
      throw error;
    }
  }
  importSceneSyncUrl.inspect = inspect;
  return importSceneSyncUrl;
}

export function validateImportJobInput(body) {
  if (!body || typeof body !== 'object' || typeof body.sourceUrl !== 'string'
    || !HANDOFF_ID.test(body.sessionId || '') || !HANDOFF_ID.test(body.requestId || '')) {
    throw failure('handoff-invalid-import-job');
  }
  safeUrl(body.sourceUrl);
  return { sourceUrl: new URL(body.sourceUrl).href, sessionId: body.sessionId, requestId: body.requestId };
}
