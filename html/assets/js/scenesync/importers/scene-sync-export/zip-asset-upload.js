function basename(path, fallback = 'asset') {
  if (typeof path !== 'string' || !path.trim()) return fallback;
  return path.split('/').filter(Boolean).pop() || fallback;
}

function extensionFromPath(path) {
  const name = basename(path, '');
  const match = name.match(/(\.[a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : '';
}

export function inferMimeForExportAsset(asset, fallback = 'application/octet-stream') {
  if (typeof asset?.mime === 'string' && asset.mime.trim()) return asset.mime.trim();

  const path = asset?.path || asset?.asset?.path || '';
  const ext = extensionFromPath(path);
  switch (ext) {
    case '.glb': return 'model/gltf-binary';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.mp4':
    case '.m4v': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.ogv': return 'video/ogg';
    case '.mp3': return 'audio/mpeg';
    case '.ogg':
    case '.oga': return 'audio/ogg';
    case '.wav': return 'audio/wav';
    case '.m4a': return 'audio/mp4';
    case '.md':
    case '.markdown': return 'text/markdown';
    case '.txt': return 'text/plain';
    default: return fallback;
  }
}

function extensionForUpload(path, mime) {
  const fromPath = extensionFromPath(path);
  if (fromPath) return fromPath;
  if (mime.includes('gltf-binary')) return '.glb';
  if (mime.includes('jpeg')) return '.jpg';
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('video/mp4')) return '.mp4';
  if (mime.includes('video/webm')) return '.webm';
  if (mime.includes('audio/mpeg') || mime.includes('audio/mp3')) return '.mp3';
  if (mime.includes('audio/ogg')) return '.ogg';
  if (mime.includes('audio/wav')) return '.wav';
  if (mime.includes('markdown')) return '.md';
  if (mime.includes('text/plain')) return '.txt';
  return '';
}

export function makeZipAssetImportPlan({
  path,
  mime,
  originalName,
  kind = 'blob-file',
} = {}) {
  if (typeof path !== 'string' || !path.trim()) return null;
  return {
    kind,
    path,
    originalName: originalName || basename(path),
    mime: mime || inferMimeForExportAsset({ path }),
  };
}

export async function uploadZipAsset({
  zip,
  plan,
  uploadBlobToStore,
  signal,
} = {}) {
  if (!zip || !plan?.path || typeof uploadBlobToStore !== 'function') return null;

  const entry = zip.file(plan.path);
  if (!entry) return null;

  try {
    const mime = plan.mime || inferMimeForExportAsset({ path: plan.path });
    const buffer = await entry.async('arraybuffer');
    const blob = new Blob([buffer], { type: mime });
    const uploaded = await uploadBlobToStore(blob, mime, extensionForUpload(plan.path, mime), signal);
    if (!uploaded?.url) return null;

    return {
      ...uploaded,
      mime,
      size: blob.size,
      originalName: plan.originalName || basename(plan.path),
    };
  } catch (error) {
    console.warn('[SceneSync Export Import] ZIP asset upload failed:', {
      path: plan.path,
      mime: plan.mime || inferMimeForExportAsset({ path: plan.path }),
      error: error?.message || String(error),
    });
    return null;
  }
}
