function mimeFromAsset(asset) {
  return asset?.mime || 'application/octet-stream';
}

// Resolves object.asset.path entries against the ZIP archive into Blob URLs,
// leaving asset.url as-is when already present, and marking unresolved
// assets with metadata.importWarning instead of dropping the object.
export async function resolveSceneDocumentAssets(sceneDocument, zip) {
  const objects = [];
  const blobUrls = [];

  for (const obj of sceneDocument.objects || []) {
    const asset = obj.asset;

    if (!asset || asset.type === 'primitive') {
      objects.push(obj);
      continue;
    }

    if (asset.type === 'text' && asset.source === 'inline') {
      objects.push(obj);
      continue;
    }

    if (asset.url) {
      objects.push(obj);
      continue;
    }

    const entry = asset.path && zip ? zip.file(asset.path) : null;
    if (entry) {
      try {
        const buffer = await entry.async('arraybuffer');
        const blob = new Blob([buffer], { type: mimeFromAsset(asset) });
        const url = URL.createObjectURL(blob);
        blobUrls.push(url);
        objects.push({
          ...obj,
          // Blob URL for local rendering only.
          asset: { ...asset, url, source: 'url' },
          // blob: URLs are only valid in this browser session, so other
          // peers must not receive them — broadcast a placeholder instead.
          broadcastAsset: { ...asset, path: null, url: null },
          metadata: {
            ...(obj.metadata || {}),
            importWarning: `Asset not synced to other peers: ${asset.path}`,
          },
        });
        continue;
      } catch {
        // fall through to missing-asset handling below
      }
    }

    objects.push({
      ...obj,
      metadata: {
        ...(obj.metadata || {}),
        importWarning: `Missing asset: ${asset.path || asset.url || '(unknown)'}`,
      },
    });
  }

  return { document: { ...sceneDocument, objects }, blobUrls };
}
