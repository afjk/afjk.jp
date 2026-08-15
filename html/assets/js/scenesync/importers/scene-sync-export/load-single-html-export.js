import {
  MAX_SINGLE_HTML_DOCUMENT_BYTES,
  createSingleHtmlAssetZip,
  parseSingleHtmlExportDocument,
} from '../../../scenesync-export/export/single-html-format.js';
import { isValidSceneDocument } from '../../../scenesync-export/viewer/scene-document.js';

export async function loadSingleHtmlExportFromBlob(blob) {
  if (Number.isFinite(blob?.size) && blob.size > MAX_SINGLE_HTML_DOCUMENT_BYTES) {
    return { valid: false, reason: 'single-html-document-too-large' };
  }
  let html;
  try {
    html = await blob.text();
  } catch (error) {
    return { valid: false, reason: 'single-html-read-failed', error };
  }

  const parsed = parseSingleHtmlExportDocument(html, { isValidSceneDocument });
  if (!parsed.valid) return parsed;

  return {
    ...parsed,
    zip: createSingleHtmlAssetZip(parsed.payload.assets),
  };
}

export function loadSingleHtmlExportFromText(html) {
  const parsed = parseSingleHtmlExportDocument(html, { isValidSceneDocument });
  if (!parsed.valid) return parsed;
  return {
    ...parsed,
    zip: createSingleHtmlAssetZip(parsed.payload.assets),
  };
}
