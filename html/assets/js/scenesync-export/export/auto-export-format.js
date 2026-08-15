/**
 * Policy and sizing helpers for the export format chooser.  These functions
 * intentionally have no browser dependencies so the boundary conditions can
 * be tested without fetching a scene.
 */
export const AUTO_EXPORT_FORMAT = 'auto';
export const SINGLE_HTML_EXPORT_FORMAT = 'single-html';
export const STATIC_ZIP_EXPORT_FORMAT = 'static-zip';

// Keep the automatic choice comfortably below the hard Single HTML limit.
// It is exported both as documentation and for hosts that need a different
// policy (for example an embedded editor with a lower download budget).
export const DEFAULT_AUTO_SINGLE_HTML_THRESHOLD_BYTES = 32 * 1024 * 1024;
export const SINGLE_HTML_ESTIMATE_FIXED_OVERHEAD_BYTES = 16 * 1024;
export const SINGLE_HTML_ESTIMATE_ASSET_OVERHEAD_BYTES = 96;

export function base64EncodedByteLength(byteLength) {
  const length = Number(byteLength);
  if (!Number.isFinite(length) || length < 0) return 0;
  return 4 * Math.ceil(length / 3);
}

export function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

function safeJsonByteLength(value) {
  return utf8ByteLength(JSON.stringify(value)
    .replaceAll('<', '\\u003C')
    .replaceAll('>', '\\u003E')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029'));
}

function fileByteLength(value) {
  if (typeof value === 'string') return utf8ByteLength(value);
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (Number.isFinite(value?.size)) return value.size;
  if (Number.isFinite(value?.byteLength)) return value.byteLength;
  return 0;
}

/**
 * Estimates the final HTML document after all local bytes are base64 encoded.
 * JSON punctuation, escaped document/module text, CSS and the bootstrap are
 * all accounted for.  The fixed term protects against small template changes.
 */
export function estimateSingleHtmlExport({
  sceneDocument = {},
  manifest = {},
  files = {},
  viewerFiles = {},
  fixedOverheadBytes = SINGLE_HTML_ESTIMATE_FIXED_OVERHEAD_BYTES,
  assetOverheadBytes = SINGLE_HTML_ESTIMATE_ASSET_OVERHEAD_BYTES,
} = {}) {
  let bytes = Number(fixedOverheadBytes) || 0;
  bytes += safeJsonByteLength(sceneDocument) + safeJsonByteLength(manifest);

  for (const [path, source] of Object.entries(viewerFiles)) {
    const isCss = path === 'viewer/viewer.css'
      || path === 'viewer/player-shell.css'
      || path === 'scenesync/handoff/source.css';
    if (isCss || typeof source === 'string') {
      // CSS is directly embedded, JS becomes a JSON module entry.
      bytes += isCss
        ? utf8ByteLength(String(source).replaceAll('</style', '<\\/style'))
        : safeJsonByteLength({ [path]: source });
    } else {
      bytes += base64EncodedByteLength(fileByteLength(source))
        + assetOverheadBytes + safeJsonByteLength(path);
    }
  }
  for (const [path, value] of Object.entries(files)) {
    bytes += base64EncodedByteLength(fileByteLength(value))
      + assetOverheadBytes + safeJsonByteLength(path);
  }
  return Math.ceil(bytes);
}

/** Determines the output format without doing any I/O. */
export function selectAutoExportFormat({
  requestedFormat = AUTO_EXPORT_FORMAT,
  estimatedBytes = 0,
  thresholdBytes = DEFAULT_AUTO_SINGLE_HTML_THRESHOLD_BYTES,
  missingAssets = [],
  singleHtmlSupported = true,
  staticZipSupported = true,
} = {}) {
  if (requestedFormat === STATIC_ZIP_EXPORT_FORMAT) {
    return { format: STATIC_ZIP_EXPORT_FORMAT, reason: 'forced-static-zip', warning: null };
  }
  if (requestedFormat === SINGLE_HTML_EXPORT_FORMAT) {
    if (!singleHtmlSupported) {
      return { format: null, reason: 'single-html-required-dependency-unembeddable', warning: null };
    }
    return {
      format: SINGLE_HTML_EXPORT_FORMAT,
      reason: 'forced-single-html',
      warning: estimatedBytes > thresholdBytes ? 'single-html-estimate-exceeds-auto-threshold' : null,
    };
  }
  if (!singleHtmlSupported) {
    return staticZipSupported
      ? { format: STATIC_ZIP_EXPORT_FORMAT, reason: 'single-html-required-dependency-unembeddable', warning: null }
      : { format: null, reason: 'required-viewer-dependency-unavailable', warning: null };
  }
  // A ZIP preserves the original URL fallback.  A file:// Single HTML export
  // is less reliable for missing/external assets, so fidelity wins over size.
  if (missingAssets.length > 0) {
    return staticZipSupported
      ? { format: STATIC_ZIP_EXPORT_FORMAT, reason: 'missing-assets-static-zip-fidelity', warning: 'external-assets-not-embedded' }
      : { format: null, reason: 'missing-assets-and-static-zip-unavailable', warning: null };
  }
  if (estimatedBytes > thresholdBytes) {
    return staticZipSupported
      ? { format: STATIC_ZIP_EXPORT_FORMAT, reason: 'single-html-estimate-exceeds-threshold', warning: null }
      : { format: null, reason: 'single-html-estimate-exceeds-threshold-and-static-zip-unavailable', warning: null };
  }
  return { format: SINGLE_HTML_EXPORT_FORMAT, reason: 'within-single-html-threshold', warning: 'three-cdn-required' };
}

export function formatEstimatedBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}
