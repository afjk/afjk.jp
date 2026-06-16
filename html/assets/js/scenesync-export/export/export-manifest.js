import { normalizeExportMetadata } from './export-metadata.js';

export function generateManifest({
  assetManifest = [],
  missingAssets = [],
  exportedAt = new Date().toISOString(),
  cdnDependent = true,
  title = '',
  description = '',
  tags = [],
  author = '',
  metadata = null,
}) {
  const notes = [
    'This is a read-only exported scene.',
    'Editing and multi-user sync are not included.',
    'Open through a local web server when previewing locally.',
  ];

  if (cdnDependent) {
    // TODO: bundle viewer dependencies (three.js, addons, Draco, JSZip) into the ZIP for offline use
    notes.push(
      'This initial export may require an internet connection to load viewer dependencies' +
      ' such as three.js, Three.js addons, Draco decoder, and JSZip from cdn.jsdelivr.net.'
    );
  }

  return {
    format: 'scene-sync-export',
    version: 1,
    exportedAt,
    ...normalizeExportMetadata(metadata || { title, description, tags, author }),
    viewer: { entry: 'index.html' },
    assets: assetManifest,
    missingAssets,
    notes,
  };
}
