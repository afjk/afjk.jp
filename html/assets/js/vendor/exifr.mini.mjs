// exifr v7 mini ESM bundle
// Source: https://cdn.jsdelivr.net/npm/exifr@7/dist/mini.esm.mjs
// For local development, this is a minimal implementation.
// In production, download the actual minified bundle from the CDN above.

function parseXmp(xmpString) {
  const result = {};
  if (!xmpString) return undefined;

  // Extract GPano namespace attributes
  const gPanoMatch = xmpString.match(/GPano:ProjectionType\s*=\s*"([^"]+)"/);
  if (gPanoMatch) {
    result['GPano:ProjectionType'] = gPanoMatch[1];
  }

  // Also try without namespace prefix
  const projMatch = xmpString.match(/ProjectionType\s*=\s*"([^"]+)"/);
  if (projMatch && !result['GPano:ProjectionType']) {
    result.ProjectionType = projMatch[1];
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export async function parse(file, options = {}) {
  if (!file) return undefined;

  try {
    const shouldParseXmp = options.xmp !== false;
    if (!shouldParseXmp) return undefined;

    // Read file as ArrayBuffer
    const arrayBuffer = await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer();
    const view = new Uint8Array(arrayBuffer);
    const text = new TextDecoder().decode(view);

    // Simple XMP extraction (looks for XML-like structures)
    const xmpStart = text.indexOf('<x:xmpmeta');
    const xmpEnd = text.indexOf('</x:xmpmeta>');

    if (xmpStart !== -1 && xmpEnd !== -1) {
      const xmpBlock = text.substring(xmpStart, xmpEnd + 12);
      return parseXmp(xmpBlock);
    }

    return undefined;
  } catch (e) {
    return undefined;
  }
}

export default { parse };
