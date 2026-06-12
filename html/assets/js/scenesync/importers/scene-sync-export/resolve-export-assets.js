// Resolves SceneDocument objects for import, keeping primitives and inline
// text as-is, and passing through assets that already have a shareable URL.
// ZIP-bundled image/mesh/video/text assets (asset.path with no asset.url)
// are not yet imported as shared Scene Sync assets — they are marked with
// metadata.importWarning so the object still appears (as a placeholder)
// without producing local-only blob: URLs that would leak into scene-state,
// snapshots, or re-export.
export async function resolveSceneDocumentAssets(sceneDocument) {
  const objects = [];

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

    objects.push({
      ...obj,
      metadata: {
        ...(obj.metadata || {}),
        importWarning: `Asset not imported (unsupported in this version): ${asset.path || '(unknown)'}`,
      },
    });
  }

  return { document: { ...sceneDocument, objects } };
}
