import { buildExportPackage, VIEWER_SOURCES } from './build-export-package.js';
import { buildSingleHtmlExport, createSingleHtmlManifest } from './build-single-html-export.js';
import { prepareSceneSyncExport } from './export-preparation.js';
import { prepareSingleHtmlDocument } from './single-html-format.js';
import {
  AUTO_EXPORT_FORMAT,
  estimateSingleHtmlExport,
  normalizeAutoSingleHtmlThresholdBytes,
  selectAutoExportFormat,
} from './auto-export-format.js';

function hasRequiredStaticViewer(prepared) {
  const required = new Set(VIEWER_SOURCES.map(({ dest }) => dest));
  return !prepared.viewerFailures.some(({ dest }) => required.has(dest));
}

/**
 * Prepares the export once, selects a format, then passes that prepared data to
 * the chosen builder. This avoids fetching every GLB/runtime twice for Auto.
 */
export async function buildAutoExport({
  format = AUTO_EXPORT_FORMAT,
  autoSingleHtmlThresholdBytes,
  confirmLargeSingleHtml = null,
  ...options
} = {}) {
  const prepared = await prepareSceneSyncExport(options);
  const manifest = createSingleHtmlManifest(prepared);
  const singleHtmlPreparation = prepareSingleHtmlDocument({
    sceneDocument: prepared.document,
    manifest,
    files: prepared.files,
    viewerFiles: prepared.viewerFiles,
  });
  const estimatedBytes = estimateSingleHtmlExport({ preparation: singleHtmlPreparation });
  const thresholdBytes = normalizeAutoSingleHtmlThresholdBytes(autoSingleHtmlThresholdBytes);
  const selection = selectAutoExportFormat({
    requestedFormat: format,
    estimatedBytes,
    thresholdBytes,
    missingAssets: prepared.missingAssets,
    hasCustomThumbnail: Boolean(options.exportMetadata?.thumbnailFile || options.exportMetadata?.thumbnail),
    singleHtmlSupported: prepared.viewerFailures.length === 0,
    staticZipSupported: hasRequiredStaticViewer(prepared),
  });
  if (!selection.format) {
    throw new Error(`Export is unsupported: ${selection.reason}`);
  }
  if (selection.warnings.includes('single-html-estimate-exceeds-auto-threshold')
    && typeof confirmLargeSingleHtml === 'function') {
    const approved = await confirmLargeSingleHtml({ estimatedBytes, thresholdBytes });
    if (!approved) return { cancelled: true, estimatedBytes, ...selection };
  }

  const builder = selection.format === 'single-html' ? buildSingleHtmlExport : buildExportPackage;
  const result = await builder({
    ...options,
    preparedExport: prepared,
    ...(selection.format === 'single-html' ? { singleHtmlPreparation } : {}),
  });
  return {
    ...result,
    estimatedBytes,
    thresholdBytes,
    selectedFormat: selection.format,
    fallbackReason: selection.reason,
    warnings: selection.warnings,
  };
}
