export function generateManifest({
  assetManifest = [],
  missingAssets = [],
  exportedAt = new Date().toISOString(),
  cdnDependent = true,
}) {
  const notes = [
    'This is a read-only exported scene.',
    'Editing and multi-user sync are not included.',
    'Open through a local web server when previewing locally.',
  ];

  if (cdnDependent) {
    // TODO: bundle three.js into the ZIP for offline use
    notes.push(
      'This viewer requires an internet connection to load three.js from cdn.jsdelivr.net.'
    );
  }

  return {
    format: 'scene-sync-export',
    version: 1,
    exportedAt,
    viewer: { entry: 'index.html' },
    assets: assetManifest,
    missingAssets,
    notes,
  };
}
