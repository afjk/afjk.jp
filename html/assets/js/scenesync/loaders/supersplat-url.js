import { MAX_SOURCE_BYTES } from './gaussian-splat/gaussian-splat-file-import.js';
import { ensureJSZip } from '../utils/jszip-loader.js';
import {
  isAllowedSuperSplatAssetUrl,
  parseSuperSplatSceneUrl,
} from './supersplat-share.js';
import {
  normalizeSuperSplatAttribution,
  normalizeSuperSplatLicense,
} from './supersplat-metadata.js';

export const SUPERSPLAT_RESOLVER_ENDPOINT =
  'https://insta360-sog-resolver.afjk01.workers.dev/api/supersplat';

const SUPERSPLAT_ASSET_FORMATS = new Set(['sog', 'sog-meta', 'streamed-sog']);
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_FILES = 64;
const DEFAULT_FETCH_TIMEOUT_MS = 120_000;

export const SUPERSPLAT_ERROR_MESSAGES = Object.freeze({
  INVALID_SUPERSPLAT_URL:
    'SuperSplatの公開シーンURL（https://superspl.at/scene/…）を指定してください。',
  SUPERSPLAT_SCENE_NOT_FOUND:
    'このSuperSplatシーンが見つかりませんでした。URLが正しいか、公開されているかをご確認ください。',
  SUPERSPLAT_NOT_DOWNLOADABLE:
    'このSuperSplatシーンはダウンロードが許可されていないため読み込めません。',
  SUPERSPLAT_LICENSE_NOT_FOUND:
    'このSuperSplatシーンのライセンスを確認できなかったため読み込みませんでした。',
  SUPERSPLAT_ASSET_NOT_FOUND:
    'このSuperSplatシーンから読み込めるSOGを見つけられませんでした。',
  SUPERSPLAT_STREAMED_SOG_UNSUPPORTED:
    'このSuperSplatシーンはストリーミング形式です。現在SceneSyncでは未対応です。',
  SUPERSPLAT_UNAVAILABLE:
    'SuperSplatの公開ページを取得できませんでした。時間をおいて試してください。',
});

export class SuperSplatImportError extends Error {
  constructor(message, code = 'SUPERSPLAT_UNAVAILABLE') {
    super(message);
    this.name = 'SuperSplatImportError';
    this.code = code;
  }
}

function safeText(value, maxLength = 160) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function validateResolution(payload, share) {
  if (!payload || typeof payload !== 'object') {
    throw new SuperSplatImportError('SuperSplat resolverの応答が不正です。');
  }
  if (payload.provider !== 'supersplat' || payload.sceneId !== share.sceneId) {
    throw new SuperSplatImportError('SuperSplat resolverのシーン情報が一致しません。');
  }
  if (payload.downloadable !== true) {
    throw new SuperSplatImportError(
      SUPERSPLAT_ERROR_MESSAGES.SUPERSPLAT_NOT_DOWNLOADABLE,
      'SUPERSPLAT_NOT_DOWNLOADABLE',
    );
  }
  const license = normalizeSuperSplatLicense(payload.license);
  if (!license) {
    throw new SuperSplatImportError(
      SUPERSPLAT_ERROR_MESSAGES.SUPERSPLAT_LICENSE_NOT_FOUND,
      'SUPERSPLAT_LICENSE_NOT_FOUND',
    );
  }
  const attribution = payload.attribution == null
    ? null
    : normalizeSuperSplatAttribution(payload.attribution, share.sceneUrl);
  if (payload.attribution != null && !attribution) {
    throw new SuperSplatImportError('SuperSplat resolverの帰属情報が不正です。');
  }
  if (!payload.asset || !SUPERSPLAT_ASSET_FORMATS.has(payload.asset.format)) {
    throw new SuperSplatImportError(
      SUPERSPLAT_ERROR_MESSAGES.SUPERSPLAT_ASSET_NOT_FOUND,
      'SUPERSPLAT_ASSET_NOT_FOUND',
    );
  }
  if (!isAllowedSuperSplatAssetUrl(payload.asset.url)) {
    throw new SuperSplatImportError('SuperSplat resolverが未許可の配信先を返しました。');
  }

  return {
    provider: 'supersplat',
    sceneId: share.sceneId,
    pageUrl: share.sceneUrl,
    title: safeText(payload.title),
    author: safeText(payload.author),
    downloadable: true,
    license,
    attribution,
    asset: {
      format: payload.asset.format,
      url: new URL(payload.asset.url).href,
      revision: safeText(payload.asset.revision, 32) || null,
    },
  };
}

async function fetchJson(url, { fetchImpl, timeoutMs, signal }) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason);
  signal?.addEventListener?.('abort', abortFromParent, { once: true });
  const timerId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { mode: 'cors', signal: controller.signal });
    let payload = null;
    try {
      payload = await response.json();
    } catch {}
    return { response, payload };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new SuperSplatImportError('SuperSplatの確認がタイムアウトしました。');
    }
    throw new SuperSplatImportError(
      `SuperSplat resolverへ接続できませんでした: ${error?.message || 'network error'}`,
    );
  } finally {
    clearTimeout(timerId);
    signal?.removeEventListener?.('abort', abortFromParent);
  }
}

/** Resolve a public scene only after its Downloadable flag and license pass. */
export async function resolveSuperSplatScene(input, options = {}) {
  const share = parseSuperSplatSceneUrl(input);
  if (!share) {
    throw new SuperSplatImportError(
      SUPERSPLAT_ERROR_MESSAGES.INVALID_SUPERSPLAT_URL,
      'INVALID_SUPERSPLAT_URL',
    );
  }

  const endpoint = options.resolverEndpoint || SUPERSPLAT_RESOLVER_ENDPOINT;
  const resolverUrl = new URL(endpoint);
  resolverUrl.searchParams.set('url', share.sceneUrl);
  const { response, payload } = await fetchJson(resolverUrl, {
    fetchImpl: options.fetchImpl || globalThis.fetch,
    timeoutMs: options.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS,
    signal: options.signal,
  });

  if (!response.ok) {
    const code = safeText(payload?.code, 80) || 'SUPERSPLAT_UNAVAILABLE';
    const message = SUPERSPLAT_ERROR_MESSAGES[code]
      || safeText(payload?.error, 240)
      || `SuperSplatのシーンを解決できませんでした (HTTP ${response.status})`;
    throw new SuperSplatImportError(message, code);
  }

  const resolved = validateResolution(payload, share);
  if (resolved.asset.format === 'streamed-sog') {
    throw new SuperSplatImportError(
      SUPERSPLAT_ERROR_MESSAGES.SUPERSPLAT_STREAMED_SOG_UNSUPPORTED,
      'SUPERSPLAT_STREAMED_SOG_UNSUPPORTED',
    );
  }
  return resolved;
}

async function readResponseBytes(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SuperSplatImportError('SuperSplatアセットが大きすぎます。');
  }

  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new SuperSplatImportError('SuperSplatアセットが大きすぎます。');
    }
    return bytes;
  }

  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SuperSplatImportError('SuperSplatアセットが大きすぎます。');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchAssetBytes(url, options = {}) {
  if (!isAllowedSuperSplatAssetUrl(url)) {
    throw new SuperSplatImportError('未許可のSuperSplatアセットURLです。');
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener?.('abort', abortFromParent, { once: true });
  const timerId = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS);

  try {
    const response = await (options.fetchImpl || globalThis.fetch)(url, {
      mode: 'cors',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new SuperSplatImportError(`SuperSplatアセットを取得できませんでした (HTTP ${response.status})`);
    }
    return await readResponseBytes(response, options.maxBytes ?? MAX_SOURCE_BYTES);
  } catch (error) {
    if (error instanceof SuperSplatImportError) throw error;
    if (controller.signal.aborted) {
      throw new SuperSplatImportError('SuperSplatアセットの取得がタイムアウトしました。');
    }
    throw new SuperSplatImportError(
      `SuperSplatアセットを取得できませんでした: ${error?.message || 'network error'}`,
    );
  } finally {
    clearTimeout(timerId);
    options.signal?.removeEventListener?.('abort', abortFromParent);
  }
}

/** Collect every WebP referenced by an unbundled SOG meta.json. */
export function collectSogManifestFiles(manifest) {
  const found = new Set();
  const seen = new Set();

  const walk = (value, depth = 0) => {
    if (depth > 12 || !value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'files' && Array.isArray(child)) {
        for (const fileName of child) {
          if (typeof fileName === 'string') found.add(fileName.trim());
        }
      }
      walk(child, depth + 1);
    }
  };
  walk(manifest);

  const files = [...found].filter(Boolean);
  if (files.length < 1 || files.length > MAX_MANIFEST_FILES) {
    throw new SuperSplatImportError('SuperSplatのSOG manifestに必要な画像がありません。');
  }
  return files;
}

function resolveManifestFile(metaUrl, fileName) {
  if (fileName.length > 256 || fileName.includes('\\') || fileName.startsWith('/')) {
    throw new SuperSplatImportError('SuperSplatのSOG manifestに不正なファイル名があります。');
  }
  const segments = fileName.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new SuperSplatImportError('SuperSplatのSOG manifestに不正なファイル名があります。');
  }

  const base = new URL('./', metaUrl);
  const assetUrl = new URL(fileName, base);
  if (assetUrl.origin !== base.origin || !assetUrl.pathname.startsWith(base.pathname)) {
    throw new SuperSplatImportError('SuperSplatのSOG manifestが配信元の外を参照しています。');
  }
  if (!/\.webp$/i.test(assetUrl.pathname) || !isAllowedSuperSplatAssetUrl(assetUrl.href)) {
    throw new SuperSplatImportError('SuperSplatのSOG manifestに未対応のファイルがあります。');
  }
  return { fileName, url: assetUrl.href };
}

function safeFileBase(resolution) {
  const candidate = resolution.title || `supersplat-${resolution.sceneId}`;
  const safe = candidate
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return safe || `supersplat-${resolution.sceneId}`;
}

/** Download a bundled or unbundled public SOG as one File for the converter. */
export async function downloadSuperSplatSource(resolution, options = {}) {
  if (resolution.asset.format === 'streamed-sog') {
    throw new SuperSplatImportError(
      SUPERSPLAT_ERROR_MESSAGES.SUPERSPLAT_STREAMED_SOG_UNSUPPORTED,
      'SUPERSPLAT_STREAMED_SOG_UNSUPPORTED',
    );
  }

  const fileBase = safeFileBase(resolution);
  const common = {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  };

  if (resolution.asset.format === 'sog') {
    options.onProgress?.({ phase: 'downloading', index: 1, total: 1, fileName: `${fileBase}.sog` });
    const bytes = await fetchAssetBytes(resolution.asset.url, {
      ...common,
      maxBytes: MAX_SOURCE_BYTES,
    });
    return new File([bytes], `${fileBase}.sog`, { type: 'application/octet-stream' });
  }

  const metaBytes = await fetchAssetBytes(resolution.asset.url, {
    ...common,
    maxBytes: MAX_MANIFEST_BYTES,
  });
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(metaBytes));
  } catch {
    throw new SuperSplatImportError('SuperSplatのSOG manifestを解析できませんでした。');
  }

  const entries = collectSogManifestFiles(manifest)
    .map((fileName) => resolveManifestFile(resolution.asset.url, fileName));
  const JSZip = options.JSZip || await (options.ensureJSZip || ensureJSZip)();
  const zip = new JSZip();
  zip.file('meta.json', metaBytes);

  let totalBytes = metaBytes.byteLength;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    options.onProgress?.({
      phase: 'downloading',
      index: index + 1,
      total: entries.length,
      fileName: entry.fileName,
    });
    const bytes = await fetchAssetBytes(entry.url, {
      ...common,
      maxBytes: MAX_SOURCE_BYTES - totalBytes,
    });
    totalBytes += bytes.byteLength;
    zip.file(entry.fileName, bytes);
  }

  options.onProgress?.({ phase: 'packaging', index: entries.length, total: entries.length });
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  if (blob.size > MAX_SOURCE_BYTES) {
    throw new SuperSplatImportError('SuperSplatアセットが大きすぎます。');
  }
  return new File([blob], `${fileBase}.supersplat.zip`, { type: 'application/zip' });
}
