import { isValidSceneDocument } from '../../../scenesync-export/viewer/scene-document.js';
import { loadExportPackageFromBlob } from './load-export-package.js';

const ZIP_EXT_RE = /\.zip(?:$|[?#])/i;

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

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, { mode: 'cors' });
  if (!response?.ok) {
    return { ok: false, status: response?.status || 0, url };
  }
  const text = await response.text();
  return {
    ok: true,
    text,
    contentType: response.headers?.get?.('content-type') || '',
    url: response.url || url,
  };
}

async function tryFetchSceneJson(sceneUrl, fetchImpl) {
  const fetched = await fetchText(sceneUrl, fetchImpl);
  if (!fetched.ok) return { valid: false, reason: 'scene-json-fetch-failed', fetched };

  let sceneDocument;
  try {
    sceneDocument = JSON.parse(fetched.text);
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

async function tryFetchZip(url, fetchImpl) {
  const response = await fetchImpl(url, { mode: 'cors' });
  if (!response?.ok) return { valid: false, reason: 'zip-fetch-failed' };
  const blob = await response.blob();
  const result = await loadExportPackageFromBlob(blob);
  if (!result.valid) return result;
  return {
    ...result,
    sourceUrl: response.url || url,
    kind: 'zip-url',
  };
}

async function tryFetchCurrentJson(directoryUrl, fetchImpl) {
  const currentUrl = new URL('current.json', directoryUrl).href;
  const fetched = await fetchText(currentUrl, fetchImpl);
  if (!fetched.ok) return { valid: false, reason: 'current-json-fetch-failed', fetched };

  let current;
  try {
    current = JSON.parse(fetched.text);
  } catch (error) {
    return { valid: false, reason: 'invalid-current-json', error, fetched };
  }

  const versionPath = typeof current?.versionPath === 'string' && current.versionPath.trim()
    ? current.versionPath.trim()
    : (typeof current?.versionId === 'string' && current.versionId.trim()
      ? `versions/${current.versionId.trim()}/`
      : '');
  if (!versionPath) return { valid: false, reason: 'current-json-missing-version' };

  const versionDirectoryUrl = asDirectoryUrl(new URL(versionPath, directoryUrl).href);
  const sceneUrl = new URL('scene.json', versionDirectoryUrl).href;
  const result = await tryFetchSceneJson(sceneUrl, fetchImpl);
  if (!result.valid) return result;
  return {
    ...result,
    current,
    baseUrl: versionDirectoryUrl,
    sourceUrl: sceneUrl,
    kind: 'current-json-url',
  };
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
  const attempts = [];

  if (isZipUrl(parsed.href)) {
    const zipResult = await tryFetchZip(parsed.href, fetchImpl).catch((error) => (
      { valid: false, reason: 'zip-fetch-threw', error }
    ));
    if (zipResult.valid) return zipResult;
    attempts.push({ step: 'zip', reason: zipResult.reason });
  }

  const directFetched = await fetchText(parsed.href, fetchImpl).catch((error) => (
    { ok: false, reason: 'direct-fetch-threw', error, url: parsed.href }
  ));
  if (directFetched.ok) {
    const directResult = await tryFetchSceneJson(directFetched.url, async () => ({
      ok: true,
      url: directFetched.url,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? directFetched.contentType : '' },
      text: async () => directFetched.text,
    }));
    if (directResult.valid) return directResult;
    attempts.push({ step: 'direct-scene-json', reason: directResult.reason });
  } else {
    attempts.push({ step: 'direct-scene-json', reason: directFetched.reason || 'fetch-failed' });
  }

  const directoryUrl = asDirectoryUrl(parsed.href);
  const directorySceneResult = await tryFetchSceneJson(new URL('scene.json', directoryUrl).href, fetchImpl)
    .catch((error) => ({ valid: false, reason: 'directory-scene-json-threw', error }));
  if (directorySceneResult.valid) return {
    ...directorySceneResult,
    baseUrl: directoryUrl,
    kind: 'directory-scene-json-url',
  };
  attempts.push({ step: 'directory-scene-json', reason: directorySceneResult.reason });

  const currentResult = await tryFetchCurrentJson(directoryUrl, fetchImpl)
    .catch((error) => ({ valid: false, reason: 'current-json-threw', error }));
  if (currentResult.valid) return currentResult;
  attempts.push({ step: 'current-json', reason: currentResult.reason });

  if (directFetched.ok && looksLikeHtml(directFetched.text, directFetched.contentType)) {
    const href = extractSceneSyncExportHref(directFetched.text);
    if (href) {
      const markerSceneUrl = new URL(href, directFetched.url).href;
      const markerResult = await tryFetchSceneJson(markerSceneUrl, fetchImpl)
        .catch((error) => ({ valid: false, reason: 'html-marker-scene-json-threw', error }));
      if (markerResult.valid) return {
        ...markerResult,
        kind: 'html-marker-url',
      };
      attempts.push({ step: 'html-marker', reason: markerResult.reason });
    }
  }

  return {
    valid: false,
    reason: 'not-scene-sync-export-url',
    attempts,
  };
}
