import { buildSingleHtmlDocumentSkeleton, prepareSingleHtmlDocument } from './single-html-format.js';

export const AUTO_EXPORT_FORMAT = 'auto';
export const SINGLE_HTML_EXPORT_FORMAT = 'single-html';
export const STATIC_ZIP_EXPORT_FORMAT = 'static-zip';

// Keep the automatic choice comfortably below the 100 MiB hard Single HTML
// limit. Hosts may override this only with a finite, non-negative integer.
export const DEFAULT_AUTO_SINGLE_HTML_THRESHOLD_BYTES = 32 * 1024 * 1024;

export function normalizeAutoSingleHtmlThresholdBytes(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 0
    ? value
    : DEFAULT_AUTO_SINGLE_HTML_THRESHOLD_BYTES;
}

export function base64EncodedByteLength(byteLength) {
  const length = Number(byteLength);
  if (!Number.isFinite(length) || length < 0) return 0;
  return 4 * Math.ceil(length / 3);
}

export function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

/**
 * Exact final UTF-8 size without materialising potentially huge base64 data.
 * The shared skeleton serializes the same escaped JSON/template/modules/CSS as
 * buildSingleHtmlDocument; base64 is ASCII and therefore simply adds its exact
 * 4 * ceil(n / 3) byte length to each empty value.
 */
export function estimateSingleHtmlExport({ preparation = null, ...input } = {}) {
  const prepared = preparation || prepareSingleHtmlDocument(input);
  const { html, assetByteLengths } = buildSingleHtmlDocumentSkeleton({ preparation: prepared });
  return utf8ByteLength(html) + Object.values(assetByteLengths)
    .reduce((total, byteLength) => total + base64EncodedByteLength(byteLength), 0);
}

/** Determines the output format without doing any I/O. */
export function selectAutoExportFormat({
  requestedFormat = AUTO_EXPORT_FORMAT,
  estimatedBytes = 0,
  thresholdBytes = DEFAULT_AUTO_SINGLE_HTML_THRESHOLD_BYTES,
  missingAssets = [],
  hasCustomThumbnail = false,
  singleHtmlSupported = true,
  staticZipSupported = true,
} = {}) {
  const threshold = normalizeAutoSingleHtmlThresholdBytes(thresholdBytes);
  const hasMissingAssets = missingAssets.length > 0;
  const result = (format, reason, warnings = []) => ({
    format,
    reason,
    warnings: hasMissingAssets && !warnings.includes('external-assets-not-embedded')
      ? [...warnings, 'external-assets-not-embedded']
      : warnings,
  });
  if (requestedFormat === STATIC_ZIP_EXPORT_FORMAT) {
    return result(STATIC_ZIP_EXPORT_FORMAT, 'forced-static-zip');
  }
  if (requestedFormat === SINGLE_HTML_EXPORT_FORMAT) {
    if (hasCustomThumbnail) return result(null, 'single-html-custom-thumbnail-unsupported');
    if (!singleHtmlSupported) return result(null, 'single-html-required-dependency-unembeddable');
    const warnings = [];
    if (estimatedBytes > threshold) warnings.push('single-html-estimate-exceeds-auto-threshold');
    if (hasMissingAssets) warnings.push('external-assets-not-embedded');
    return result(SINGLE_HTML_EXPORT_FORMAT, 'forced-single-html', warnings);
  }
  if (hasCustomThumbnail) {
    return staticZipSupported
      ? result(STATIC_ZIP_EXPORT_FORMAT, 'custom-thumbnail-requires-static-zip')
      : result(null, 'custom-thumbnail-requires-static-zip-unavailable');
  }
  if (!singleHtmlSupported) {
    return staticZipSupported
      ? result(STATIC_ZIP_EXPORT_FORMAT, 'single-html-required-dependency-unembeddable')
      : result(null, 'required-viewer-dependency-unavailable');
  }
  // A ZIP retains remote URL fallback. A file:// Single HTML export is less
  // faithful when a required scene asset could not be embedded.
  if (hasMissingAssets) {
    return staticZipSupported
      ? result(STATIC_ZIP_EXPORT_FORMAT, 'unembedded-external-assets-prefer-static-zip', ['external-assets-not-embedded'])
      : result(null, 'unembedded-external-assets-static-zip-unavailable');
  }
  if (estimatedBytes > threshold) {
    return staticZipSupported
      ? result(STATIC_ZIP_EXPORT_FORMAT, 'single-html-estimate-exceeds-threshold')
      : result(null, 'single-html-estimate-exceeds-threshold-and-static-zip-unavailable');
  }
  return result(SINGLE_HTML_EXPORT_FORMAT, 'within-single-html-threshold', ['three-cdn-required']);
}

export function formatEstimatedBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

/** Adds the canonical missing-asset warning once without mutating caller data. */
export function mergeMissingAssetWarning(warnings = [], missingAssets = []) {
  const current = Array.isArray(warnings) ? warnings : [];
  if (!Array.isArray(missingAssets) || missingAssets.length === 0
    || current.includes('external-assets-not-embedded')) {
    return current;
  }
  return [...current, 'external-assets-not-embedded'];
}
