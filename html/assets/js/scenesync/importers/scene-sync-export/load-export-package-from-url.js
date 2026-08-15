import { isValidSceneDocument } from '../../../scenesync-export/viewer/scene-document.js';
import { MAX_SINGLE_HTML_DOCUMENT_BYTES } from '../../../scenesync-export/export/single-html-format.js';
import { loadExportPackageFromBlob } from './load-export-package.js';
import { loadSingleHtmlExportFromText } from './load-single-html-export.js';

const ZIP_EXT_RE = /\.zip(?:$|[?#])/i;
const SCENE_JSON_RE = /(?:^|\/)scene\.json$/i;
const CURRENT_JSON_RE = /(?:^|\/)current\.json$/i;
const HTML_EXT_RE = /\.html?(?:$|[?#])/i;
const ZIP_CONTENT_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
]);
const ZIP_MAGIC_SIGNATURES = new Set([
  '80,75,3,4',
  '80,75,5,6',
  '80,75,7,8',
]);
// Handoff entry documents are metadata, not assets. Keep them bounded before
// parsing; large assets are governed by the separate 500 MiB materializer.
export const DEFAULT_URL_HANDOFF_DOCUMENT_LIMIT_BYTES = 10 * 1024 * 1024;

function fetchImplFromOptions(options = {}) {
  return options.fetchImpl || globalThis.fetch?.bind(globalThis);
}

function ensureFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available');
  }
  return fetchImpl;
}

function isZipUrl(url) {
  try {
    return ZIP_EXT_RE.test(new URL(url).pathname);
  } catch {
    return ZIP_EXT_RE.test(String(url || ''));
  }
}

function isSceneJsonUrl(url) {
  try {
    return SCENE_JSON_RE.test(new URL(url).pathname);
  } catch {
    return SCENE_JSON_RE.test(String(url || '').split(/[?#]/)[0]);
  }
}

function isCurrentJsonUrl(url) {
  try {
    return CURRENT_JSON_RE.test(new URL(url).pathname);
  } catch {
    return CURRENT_JSON_RE.test(String(url || '').split(/[?#]/)[0]);
  }
}

function isHtmlUrl(url) {
  try {
    return HTML_EXT_RE.test(new URL(url).pathname);
  } catch {
    return HTML_EXT_RE.test(String(url || ''));
  }
}

function asDirectoryUrl(url) {
  const parsed = new URL(url);
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}

function directoryOfUrl(url) {
  return new URL('./', url).href;
}

function normalizeContentType(contentType = '') {
  return String(contentType || '').split(';')[0].trim().toLowerCase();
}

function hasZipContentType(contentType) {
  return ZIP_CONTENT_TYPES.has(normalizeContentType(contentType));
}

function hasOctetStreamContentType(contentType) {
  return normalizeContentType(contentType) === 'application/octet-stream';
}

async function blobHasZipMagic(blob) {
  if (!blob || typeof blob.slice !== 'function') return false;
  const buffer = await blob.slice(0, 4).arrayBuffer();
  const bytes = Array.from(new Uint8Array(buffer));
  if (bytes.length < 2) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  if (bytes.length < 4) return true;
  return ZIP_MAGIC_SIGNATURES.has(bytes.slice(0, 4).join(','));
}

async function responseBlobLimited(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('url-document-too-large');
  const reader = response.body?.getReader?.();
  if (!reader) {
    if (typeof response.blob === 'function' && typeof response.arrayBuffer !== 'function') {
      const blob = await response.blob();
      if (blob.size > maxBytes) throw new Error('url-document-too-large');
      return blob;
    }
    const source = typeof response.arrayBuffer === 'function' ? await response.arrayBuffer()
      : new TextEncoder().encode(await response.text()).buffer;
    if (source.byteLength > maxBytes) throw new Error('url-document-too-large');
    return new Blob([source]);
  }
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { try { await reader.cancel(); } catch {} throw new Error('url-document-too-large'); }
    chunks.push(value);
  }
  return new Blob(chunks);
}

async function fetchBlob(url, fetchImpl, { signal, maxBytes = Infinity } = {}) {
  const response = await fetchImpl(url, { mode: 'cors', credentials: 'omit', signal });
  if (!response?.ok) {
    return { ok: false, status: response?.status || 0, reason: 'http-error', url: response?.url || url };
  }

  const blob = await responseBlobLimited(response, maxBytes);

  return {
    ok: true,
    blob,
    contentType: response.headers?.get?.('content-type') || blob.type || '',
    url: response.url || url,
  };
}

async function fetchText(url, fetchImpl, options = {}) {
  const response = await fetchImpl(url, { mode: 'cors', credentials: 'omit', signal: options.signal });
  if (!response?.ok) {
    return { ok: false, status: response?.status || 0, url };
  }
  let text;
  try { text = await (await responseBlobLimited(response, options.maxBytes ?? Infinity)).text(); }
  catch (error) { return { ok: false, reason: error.message === 'url-document-too-large' ? 'url-document-too-large' : 'fetch-failed', url }; }
  return {
    ok: true,
    text,
    contentType: response.headers?.get?.('content-type') || '',
    url: response.url || url,
  };
}

function parseSceneJsonText(text, fetched) {
  let sceneDocument;
  try {
    sceneDocument = JSON.parse(text);
  } catch (error) {
    return { valid: false, reason: 'invalid-scene-json', error, fetched };
  }

  if (!isValidSceneDocument(sceneDocument)) {
    return { valid: false, reason: 'invalid-scene-document', fetched };
  }

  return {
    valid: true,
    sceneDocument,
    manifest: null,
    baseUrl: directoryOfUrl(fetched.url),
    sourceUrl: fetched.url,
    kind: 'scene-json-url',
  };
}

async function tryFetchSceneJson(sceneUrl, fetchImpl, options) {
  const fetched = await fetchText(sceneUrl, fetchImpl, options);
  if (!fetched.ok) return { valid: false, reason: 'scene-json-fetch-failed', fetched };
  return parseSceneJsonText(fetched.text, fetched);
}

function looksLikeHtml(text, contentType = '') {
  return /html/i.test(contentType) || /^\s*<!doctype html/i.test(text) || /^\s*<html[\s>]/i.test(text);
}

function extractSceneSyncExportHref(html) {
  const linkMatch = html.match(/<link\b[^>]*\brel=["']scene-sync-export["'][^>]*\bhref=["']([^"']+)["'][^>]*>/i)
    || html.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']scene-sync-export["'][^>]*>/i);
  if (linkMatch) return linkMatch[1];

  const metaMatch = html.match(/<meta\b[^>]*\bname=["']scene-sync-export["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/i)
    || html.match(/<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["']scene-sync-export["'][^>]*>/i);
  return metaMatch?.[1] || null;
}

async function shouldTreatAsZip(fetched, originalUrl) {
  const contentType = fetched?.contentType || '';
  if (isZipUrl(originalUrl)) return true;
  if (hasZipContentType(contentType)) return true;
  if (hasOctetStreamContentType(contentType) && await blobHasZipMagic(fetched.blob)) return true;
  return false;
}

async function tryLoadZipBlob(blob, url) {
  const result = await loadExportPackageFromBlob(blob);
  if (!result.valid) return result;
  return {
    ...result,
    sourceUrl: url,
    kind: 'zip-url',
  };
}

function shouldBlockSceneJsonFallback(result) {
  return result && !result.valid && result.reason !== 'scene-json-fetch-failed';
}

function blockingResult(result, attempts) {
  return {
    valid: false,
    reason: result?.reason || 'invalid-scene-sync-export-url',
    error: result?.error,
    status: result?.status || result?.fetched?.status || 0,
    attempts,
    shouldBlockGenericImport: true,
  };
}

function isLikelyHtmlResponse(fetched, url) {
  return isHtmlUrl(url) || /html/i.test(fetched?.contentType || '');
}

function singleHtmlFetchFailure(fetched) {
  if (fetched?.reason === 'url-document-too-large') return { reason: 'single-html-document-too-large' };
  if (fetched?.status) {
    return { reason: 'single-html-http-error', status: fetched.status, error: fetched.error };
  }
  return { reason: 'single-html-fetch-failed', error: fetched?.error };
}

async function resolveCurrentJson(current, directoryUrl, fetchImpl, options) {
  const versionPath = typeof current?.versionPath === 'string' && current.versionPath.trim()
    ? current.versionPath.trim()
    : (typeof current?.versionId === 'string' && current.versionId.trim()
      ? `versions/${current.versionId.trim()}/`
      : '');
  if (!versionPath) return { valid: false, reason: 'current-json-missing-version' };

  const versionDirectoryUrl = asDirectoryUrl(new URL(versionPath, directoryUrl).href);
  const sceneUrl = new URL('scene.json', versionDirectoryUrl).href;
  const result = await tryFetchSceneJson(sceneUrl, fetchImpl, options);
  if (!result.valid) {
    return {
      ...result,
      shouldBlockGenericImport: true,
    };
  }
  return {
    ...result,
    current,
    baseUrl: versionDirectoryUrl,
    sourceUrl: sceneUrl,
    kind: 'current-json-url',
  };
}

async function tryFetchCurrentJson(directoryUrl, fetchImpl, options) {
  const currentUrl = new URL('current.json', directoryUrl).href;
  const fetched = await fetchText(currentUrl, fetchImpl, options);
  if (!fetched.ok) return { valid: false, reason: 'current-json-fetch-failed', fetched };

  let current;
  try {
    current = JSON.parse(fetched.text);
  } catch (error) {
    return { valid: false, reason: 'invalid-current-json', error, fetched };
  }

  return resolveCurrentJson(current, directoryUrl, fetchImpl, options);
}

export async function loadExportPackageFromUrl(url, options = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return { valid: false, reason: 'invalid-url', error };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'unsupported-url-protocol' };
  }

  const fetchImpl = ensureFetch(fetchImplFromOptions(options));
  const fetchOptions = { signal: options.signal, maxBytes: options.maxDocumentBytes ?? Infinity };
  const attempts = [];

  const directFetched = await fetchBlob(parsed.href, fetchImpl, fetchOptions).catch((error) => (
    { ok: false, reason: error?.message || 'direct-fetch-threw', error, url: parsed.href }
  ));
  let directText = null;
  if (directFetched.ok) {
    const zipCandidate = await shouldTreatAsZip(directFetched, parsed.href);
    if (zipCandidate) {
      if (options.handoffOnly) {
        return { valid: false, reason: 'handoff-url-kind-rejected', shouldBlockGenericImport: true };
      }
      const zipResult = await tryLoadZipBlob(directFetched.blob, directFetched.url)
        .catch((error) => ({ valid: false, reason: 'zip-load-threw', error }));
      if (zipResult.valid) return zipResult;
      attempts.push({ step: 'zip', reason: zipResult.reason });
      return blockingResult(zipResult, attempts);
    }

    if (directFetched.blob.size > MAX_SINGLE_HTML_DOCUMENT_BYTES
      && isLikelyHtmlResponse(directFetched, parsed.href)) {
      const tooLarge = { reason: 'single-html-document-too-large', size: directFetched.blob.size };
      attempts.push({ step: 'single-html', reason: tooLarge.reason });
      return blockingResult(tooLarge, attempts);
    }

    directText = await directFetched.blob.text();
    const singleHtmlResult = loadSingleHtmlExportFromText(directText);
    if (singleHtmlResult.valid) {
      if (options.handoffOnly) {
        return { valid: false, reason: 'handoff-url-kind-rejected', shouldBlockGenericImport: true };
      }
      return {
        ...singleHtmlResult,
        sourceUrl: directFetched.url || parsed.href,
        kind: 'single-html-url',
      };
    }
    // A Single HTML marker is an explicit claim that this is an export, so
    // do not fall through to generic URL import with a malformed document.
    if (singleHtmlResult.reason !== 'not-single-html-export') {
      attempts.push({ step: 'single-html', reason: singleHtmlResult.reason });
      return blockingResult(singleHtmlResult, attempts);
    }

    if (looksLikeHtml(directText, directFetched.contentType)) {
      const href = extractSceneSyncExportHref(directText);
      if (href) {
        const markerSceneUrl = new URL(href, directFetched.url || parsed.href).href;
        const markerResult = await tryFetchSceneJson(markerSceneUrl, fetchImpl, fetchOptions)
          .catch((error) => ({ valid: false, reason: 'html-marker-scene-json-threw', error }));
        if (markerResult.valid) return {
          ...markerResult,
          kind: 'html-marker-url',
        };
        attempts.push({ step: 'html-marker', reason: markerResult.reason });
        return blockingResult(markerResult, attempts);
      }
    }
    const directResult = parseSceneJsonText(directText, {
      ...directFetched,
      text: directText,
    });
    if (directResult.valid) return directResult;
    attempts.push({ step: 'direct-scene-json', reason: directResult.reason });

    if (isSceneJsonUrl(directFetched.url || parsed.href)) {
      return blockingResult(directResult, attempts);
    }

    if (isCurrentJsonUrl(directFetched.url || parsed.href)) {
      let current;
      try {
        current = JSON.parse(directText);
      } catch (error) {
        return blockingResult({ reason: 'invalid-current-json', error }, attempts);
      }
      const currentResult = await resolveCurrentJson(current, directoryOfUrl(directFetched.url), fetchImpl, fetchOptions)
        .catch((error) => ({ valid: false, reason: 'current-json-threw', error }));
      if (currentResult.valid) return currentResult;
      return blockingResult(currentResult, attempts);
    }
  } else {
    attempts.push({ step: 'direct-scene-json', reason: directFetched.reason || 'fetch-failed' });
    if (isZipUrl(parsed.href) || isSceneJsonUrl(parsed.href) || isCurrentJsonUrl(parsed.href)) {
      return blockingResult({ reason: directFetched.reason || 'fetch-failed', error: directFetched.error }, attempts);
    }
    if (isHtmlUrl(parsed.href)) {
      return blockingResult(singleHtmlFetchFailure(directFetched), attempts);
    }
  }

  const directoryUrl = asDirectoryUrl(parsed.href);
  const directorySceneResult = await tryFetchSceneJson(new URL('scene.json', directoryUrl).href, fetchImpl, fetchOptions)
    .catch((error) => ({ valid: false, reason: 'directory-scene-json-threw', error }));
  if (directorySceneResult.valid) return {
    ...directorySceneResult,
    baseUrl: directoryUrl,
    kind: 'directory-scene-json-url',
  };
  attempts.push({ step: 'directory-scene-json', reason: directorySceneResult.reason });
  if (shouldBlockSceneJsonFallback(directorySceneResult)) {
    return blockingResult(directorySceneResult, attempts);
  }

  const currentResult = await tryFetchCurrentJson(directoryUrl, fetchImpl, fetchOptions)
    .catch((error) => ({ valid: false, reason: 'current-json-threw', error }));
  if (currentResult.valid) return currentResult;
  attempts.push({ step: 'current-json', reason: currentResult.reason });
  if (currentResult.shouldBlockGenericImport) {
    return blockingResult(currentResult, attempts);
  }

  return {
    valid: false,
    reason: 'not-scene-sync-export-url',
    attempts,
  };
}
