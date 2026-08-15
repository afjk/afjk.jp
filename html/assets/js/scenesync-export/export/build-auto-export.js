import { buildExportPackage, VIEWER_SOURCES } from './build-export-package.js';
import { buildSingleHtmlExport, createSingleHtmlManifest } from './build-single-html-export.js';
import { prepareSceneSyncExport } from './export-preparation.js';
import {
  AUTO_EXPORT_FORMAT,
  DEFAULT_AUTO_SINGLE_HTML_THRESHOLD_BYTES,
  estimateSingleHtmlExport,
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
  autoSingleHtmlThresholdBytes = DEFAULT_AUTO_SINGLE_HTML_THRESHOLD_BYTES,
  confirmLargeSingleHtml = null,
  ...options
} = {}) {
  const prepared = await prepareSceneSyncExport(options);
  const manifest = createSingleHtmlManifest(prepared);
  const estimatedBytes = estimateSingleHtmlExport({
    sceneDocument: prepared.document,
    manifest,
    files: prepared.files,
    viewerFiles: prepared.viewerFiles,
  });
  const selection = selectAutoExportFormat({
    requestedFormat: format,
    estimatedBytes,
    thresholdBytes: autoSingleHtmlThresholdBytes,
    missingAssets: prepared.missingAssets,
    singleHtmlSupported: prepared.viewerFailures.length === 0,
    staticZipSupported: hasRequiredStaticViewer(prepared),
  });
  if (!selection.format) {
    throw new Error(`Export is unsupported: ${selection.reason}`);
  }
  if (selection.warning === 'single-html-estimate-exceeds-auto-threshold'
    && typeof confirmLargeSingleHtml === 'function') {
    const approved = await confirmLargeSingleHtml({ estimatedBytes, thresholdBytes: autoSingleHtmlThresholdBytes });
    if (!approved) return { cancelled: true, estimatedBytes, ...selection };
  }

  const builder = selection.format === 'single-html' ? buildSingleHtmlExport : buildExportPackage;
  const result = await builder({ ...options, preparedExport: prepared });
  return {
    ...result,
    estimatedBytes,
    thresholdBytes: autoSingleHtmlThresholdBytes,
    selectedFormat: selection.format,
    fallbackReason: selection.reason,
    warning: selection.warning,
  };
}
