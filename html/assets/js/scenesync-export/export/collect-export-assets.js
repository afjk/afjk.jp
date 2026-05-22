function sanitizeFilename(name) {
  return (name || 'asset')
    .replace(/[^a-zA-Z0-9_\-.]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 80);
}

function extensionFor(mime, fallback = 'bin') {
  if (!mime) return fallback;
  if (mime.includes('gltf-binary') || mime.includes('model/gltf+json')) return 'glb';
  if (mime.includes('audio/mpeg') || mime.includes('audio/mp3')) return 'mp3';
  if (mime.includes('audio/ogg')) return 'ogg';
  if (mime.includes('audio/wav')) return 'wav';
  if (mime.includes('image/jpeg')) return 'jpg';
  if (mime.includes('image/png')) return 'png';
  if (mime.includes('image/hdr') || mime.includes('x-hdr')) return 'hdr';
  return fallback;
}

async function tryFetch(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

async function tryGetCachedAssetBuffer({ assetCache, assetId, meshPath }) {
  if (!assetCache) return { found: false, hasError: false };

  let record = null;
  let hasError = false;

  try {
    if (assetId && typeof assetCache.getByAssetId === 'function') {
      record = await assetCache.getByAssetId(assetId);
    }

    if (!record && meshPath && typeof assetCache.getByMeshPath === 'function') {
      record = await assetCache.getByMeshPath(meshPath);
    }
  } catch (err) {
    console.warn('[Export] IndexedDB asset cache lookup failed:', err);
    return { found: false, hasError: true };
  }

  const blob = record?.blob;
  if (!blob) return { found: false, hasError: false };

  try {
    return {
      found: true,
      hasError: false,
      buffer: await blob.arrayBuffer(),
      mime: record.mime || blob.type || 'model/gltf-binary',
      size: record.size || blob.size || null,
      source: 'indexeddb',
    };
  } catch (err) {
    console.warn('[Export] Failed to read cached asset blob:', err);
    return { found: false, hasError: true };
  }
}

export async function collectExportAssets({
  sceneDocument,
  blobBase,
  envOrigin,
  assetCache = null,
}) {
  const files = {};
  const assetManifest = [];
  const missingAssets = [];

  const usedPaths = new Set();

  function uniquePath(base, ext) {
    let path = `assets/${base}.${ext}`;
    let n = 1;
    while (usedPaths.has(path)) {
      path = `assets/${base}-${n++}.${ext}`;
    }
    usedPaths.add(path);
    return path;
  }

  function videoExtFor(mime) {
    if (!mime) return 'mp4';
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('ogg')) return 'ogv';
    return 'mp4';
  }

  // Collect mesh / image / video / text assets
  const updatedObjects = [];
  for (const obj of sceneDocument.objects) {
    if (!obj.asset || obj.asset.type === 'primitive') {
      updatedObjects.push(obj);
      continue;
    }

    if (obj.asset.type === 'image') {
      const imageUrl = obj.asset.url;
      if (!imageUrl) { updatedObjects.push(obj); continue; }

      const ext = extensionFor(obj.asset.mime || 'image/jpeg', 'jpg');
      const zipPath = uniquePath(sanitizeFilename(obj.id), ext);
      const buffer = await tryFetch(imageUrl);
      if (buffer) {
        files[zipPath] = buffer;
        assetManifest.push({ id: obj.id, kind: 'image', path: zipPath, status: 'included' });
        updatedObjects.push({ ...obj, asset: { ...obj.asset, path: zipPath } });
      } else {
        missingAssets.push({ id: obj.id, kind: 'image', url: imageUrl, reason: 'fetch-failed' });
        updatedObjects.push(obj); // keep url as fallback for static-asset-resolver
      }
      continue;
    }

    if (obj.asset.type === 'video') {
      const videoUrl = obj.asset.url;
      if (!videoUrl) { updatedObjects.push(obj); continue; }

      const ext = videoExtFor(obj.asset.mime);
      const zipPath = uniquePath(sanitizeFilename(obj.id), ext);
      const buffer = await tryFetch(videoUrl);
      if (buffer) {
        files[zipPath] = buffer;
        assetManifest.push({ id: obj.id, kind: 'video', path: zipPath, status: 'included' });
        updatedObjects.push({ ...obj, asset: { ...obj.asset, path: zipPath } });
      } else {
        // Videos often have CORS restrictions; keep url so static viewer can stream
        missingAssets.push({ id: obj.id, kind: 'video', url: videoUrl, reason: 'fetch-failed' });
        updatedObjects.push(obj);
      }
      continue;
    }

    if (obj.asset.type === 'text') {
      if (obj.asset.source === 'inline') {
        // Text is embedded in scene.json — no file needed
        updatedObjects.push(obj);
        continue;
      }
      const textUrl = obj.asset.url;
      if (!textUrl) { updatedObjects.push(obj); continue; }

      const zipPath = uniquePath(sanitizeFilename(obj.id), 'txt');
      const buffer = await tryFetch(textUrl);
      if (buffer) {
        files[zipPath] = buffer;
        assetManifest.push({ id: obj.id, kind: 'text', path: zipPath, status: 'included' });
        updatedObjects.push({ ...obj, asset: { ...obj.asset, path: zipPath } });
      } else {
        missingAssets.push({ id: obj.id, kind: 'text', url: textUrl, reason: 'fetch-failed' });
        updatedObjects.push(obj);
      }
      continue;
    }

    const meshPath = obj.asset.meshPath;
    const assetId = obj.asset.assetId;
    const mime = obj.asset.mime || 'model/gltf-binary';
    const ext = extensionFor(mime, 'glb');
    const baseName = sanitizeFilename(obj.asset.originalName?.replace(/\.[^.]+$/, '') || obj.id);
    const zipPath = uniquePath(baseName, ext);

    let fetchUrl = null;
    if (meshPath && blobBase) {
      fetchUrl = `${blobBase}/${meshPath}`;
    }

    const blobBuffer = await tryFetch(fetchUrl);

    if (blobBuffer) {
      files[zipPath] = blobBuffer;
      assetManifest.push({ id: obj.id, kind: 'mesh', path: zipPath, status: 'included', source: 'blob' });
      updatedObjects.push({
        ...obj,
        asset: { ...obj.asset, path: zipPath, meshPath: undefined, assetId: undefined },
      });
    } else {
      // Try IndexedDB cache as fallback
      const cachedAsset = await tryGetCachedAssetBuffer({ assetCache, assetId, meshPath });

      if (cachedAsset.found) {
        files[zipPath] = cachedAsset.buffer;
        assetManifest.push({
          id: obj.id,
          kind: 'mesh',
          path: zipPath,
          status: 'included',
          source: 'indexeddb',
        });
        updatedObjects.push({
          ...obj,
          asset: { ...obj.asset, path: zipPath, meshPath: undefined, assetId: undefined },
        });
      } else {
        missingAssets.push({
          id: obj.id,
          kind: 'mesh',
          assetId: assetId || null,
          meshPath: meshPath || null,
          reason: cachedAsset.hasError ? 'blob-fetch-and-cache-error' : 'blob-fetch-and-cache-miss',
        });
        updatedObjects.push({ ...obj, asset: { ...obj.asset, path: null, meshPath: undefined, assetId: undefined } });
      }
    }
  }

  // Collect environment (HDRI)
  let updatedSkybox = sceneDocument.skybox;
  if (sceneDocument.skybox?.envId) {
    const envId = sceneDocument.skybox.envId;
    const hdrUrl = envOrigin ? `${envOrigin}/assets/hdri/${envId}.hdr` : null;
    const buffer = await tryFetch(hdrUrl);

    if (buffer) {
      const zipPath = uniquePath('env', 'hdr');
      files[zipPath] = buffer;
      assetManifest.push({ id: `skybox-${envId}`, kind: 'skybox', path: zipPath, status: 'included' });
      updatedSkybox = {
        ...sceneDocument.skybox,
        asset: { path: zipPath },
      };
    } else {
      missingAssets.push({ id: `skybox-${envId}`, kind: 'skybox', reason: 'fetch-failed' });
      updatedSkybox = {
        ...sceneDocument.skybox,
        asset: { path: null },
      };
    }
  }

  // Collect BGM
  let updatedBgm = sceneDocument.bgm;
  if (sceneDocument.bgm?.url) {
    const bgmUrl = sceneDocument.bgm.url;
    const mimeGuess = bgmUrl.endsWith('.mp3') ? 'audio/mpeg'
      : bgmUrl.endsWith('.ogg') ? 'audio/ogg'
        : bgmUrl.endsWith('.wav') ? 'audio/wav'
          : 'audio/mpeg';
    const ext = extensionFor(mimeGuess, 'mp3');
    const zipPath = uniquePath('bgm', ext);

    const buffer = await tryFetch(bgmUrl);

    if (buffer) {
      files[zipPath] = buffer;
      assetManifest.push({ id: 'bgm', kind: 'bgm', path: zipPath, status: 'included' });
      updatedBgm = {
        ...sceneDocument.bgm,
        asset: { path: zipPath },
      };
    } else {
      missingAssets.push({ id: 'bgm', kind: 'bgm', url: bgmUrl, reason: 'fetch-failed' });
      updatedBgm = {
        ...sceneDocument.bgm,
        asset: { path: null },
      };
    }
  }

  const updatedDocument = {
    ...sceneDocument,
    objects: updatedObjects,
    skybox: updatedSkybox,
    bgm: updatedBgm,
  };

  return {
    files,
    document: updatedDocument,
    assetManifest,
    missingAssets,
  };
}
