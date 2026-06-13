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

function audioExtForUrl(url) {
  if (typeof url !== 'string') return 'mp3';
  const clean = url.split(/[?#]/)[0].toLowerCase();
  if (clean.endsWith('.ogg') || clean.endsWith('.oga')) return 'ogg';
  if (clean.endsWith('.wav')) return 'wav';
  if (clean.endsWith('.m4a') || clean.endsWith('.mp4')) return 'm4a';
  if (clean.endsWith('.webm')) return 'webm';
  return 'mp3';
}

async function tryFetch(url) {
  const fetched = await tryFetchAsset(url);
  return fetched?.buffer || null;
}

async function tryFetchAsset(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return {
      buffer: await res.arrayBuffer(),
      contentType: res.headers.get('content-type') || null,
    };
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

  async function withCollectedAudioSources(obj) {
    if (!obj?.audioSources || typeof obj.audioSources !== 'object' || Array.isArray(obj.audioSources)) {
      return obj;
    }

    const updatedAudioSources = {};
    let changed = false;

    for (const [name, source] of Object.entries(obj.audioSources)) {
      if (!source || typeof source !== 'object') {
        updatedAudioSources[name] = source;
        continue;
      }

      const existingPath = source.asset?.path;
      if (existingPath) {
        updatedAudioSources[name] = source;
        continue;
      }

      const audioUrl = source.url;
      if (!audioUrl) {
        updatedAudioSources[name] = source;
        continue;
      }

      const zipPath = uniquePath(sanitizeFilename(`${obj.id}-${name || 'audio'}`), audioExtForUrl(audioUrl));
      const buffer = await tryFetch(audioUrl);
      changed = true;

      if (buffer) {
        files[zipPath] = buffer;
        assetManifest.push({
          id: `${obj.id}:${name}`,
          objectId: obj.id,
          kind: 'audioSource',
          name,
          path: zipPath,
          status: 'included',
        });
        updatedAudioSources[name] = {
          ...source,
          asset: {
            ...(source.asset || {}),
            path: zipPath,
          },
        };
      } else {
        missingAssets.push({
          id: `${obj.id}:${name}`,
          objectId: obj.id,
          kind: 'audioSource',
          name,
          url: audioUrl,
          reason: 'fetch-failed',
        });
        updatedAudioSources[name] = {
          ...source,
          asset: {
            ...(source.asset || {}),
            path: null,
          },
        };
      }
    }

    return changed ? { ...obj, audioSources: updatedAudioSources } : obj;
  }

  // Collect mesh / image / video / text assets
  const updatedObjects = [];
  for (const obj of sceneDocument.objects) {
    if (!obj.asset || obj.asset.type === 'primitive') {
      updatedObjects.push(await withCollectedAudioSources(obj));
      continue;
    }

    if (obj.asset.type === 'image') {
      const imageUrl = obj.asset.url;
      if (!imageUrl) { updatedObjects.push(await withCollectedAudioSources(obj)); continue; }

      const fetched = await tryFetchAsset(imageUrl);
      if (fetched) {
        const mime = obj.asset.mime || fetched.contentType || 'image/jpeg';
        const ext = extensionFor(mime, 'jpg');
        const zipPath = uniquePath(sanitizeFilename(obj.id), ext);
        files[zipPath] = fetched.buffer;
        assetManifest.push({ id: obj.id, kind: 'image', path: zipPath, status: 'included' });
        updatedObjects.push(await withCollectedAudioSources({ ...obj, asset: { ...obj.asset, mime, path: zipPath } }));
      } else {
        missingAssets.push({ id: obj.id, kind: 'image', url: imageUrl, reason: 'fetch-failed' });
        updatedObjects.push(await withCollectedAudioSources(obj)); // keep url as fallback for static-asset-resolver
      }
      continue;
    }

    if (obj.asset.type === 'video') {
      const videoUrl = obj.asset.url;
      if (!videoUrl) { updatedObjects.push(await withCollectedAudioSources(obj)); continue; }

      const fetched = await tryFetchAsset(videoUrl);
      if (fetched) {
        const mime = obj.asset.mime || fetched.contentType || null;
        const ext = videoExtFor(mime);
        const zipPath = uniquePath(sanitizeFilename(obj.id), ext);
        files[zipPath] = fetched.buffer;
        assetManifest.push({ id: obj.id, kind: 'video', path: zipPath, status: 'included' });
        updatedObjects.push(await withCollectedAudioSources({ ...obj, asset: { ...obj.asset, ...(mime ? { mime } : {}), path: zipPath } }));
      } else {
        // Videos often have CORS restrictions; keep url so static viewer can stream
        missingAssets.push({ id: obj.id, kind: 'video', url: videoUrl, reason: 'fetch-failed' });
        updatedObjects.push(await withCollectedAudioSources(obj));
      }
      continue;
    }

    if (obj.asset.type === 'text') {
      if (obj.asset.source === 'inline') {
        // Text is embedded in scene.json — no file needed
        updatedObjects.push(await withCollectedAudioSources(obj));
        continue;
      }
      const textUrl = obj.asset.url;
      if (!textUrl) { updatedObjects.push(await withCollectedAudioSources(obj)); continue; }

      const zipPath = uniquePath(sanitizeFilename(obj.id), 'txt');
      const buffer = await tryFetch(textUrl);
      if (buffer) {
        files[zipPath] = buffer;
        assetManifest.push({ id: obj.id, kind: 'text', path: zipPath, status: 'included' });
        updatedObjects.push(await withCollectedAudioSources({ ...obj, asset: { ...obj.asset, path: zipPath } }));
      } else {
        missingAssets.push({ id: obj.id, kind: 'text', url: textUrl, reason: 'fetch-failed' });
        updatedObjects.push(await withCollectedAudioSources(obj));
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
    let fetchSource = null;
    if (meshPath && blobBase) {
      fetchUrl = `${blobBase}/${meshPath}`;
      fetchSource = 'blob';
    } else if (obj.asset.url) {
      fetchUrl = obj.asset.url;
      fetchSource = 'url';
    }

    const blobBuffer = await tryFetch(fetchUrl);

    if (blobBuffer) {
      files[zipPath] = blobBuffer;
      assetManifest.push({ id: obj.id, kind: 'mesh', path: zipPath, status: 'included', source: fetchSource || 'unknown' });
      updatedObjects.push(await withCollectedAudioSources({
        ...obj,
        asset: { ...obj.asset, path: zipPath, url: undefined, meshPath: undefined, assetId: undefined },
      }));
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
        updatedObjects.push(await withCollectedAudioSources({
          ...obj,
          asset: { ...obj.asset, path: zipPath, meshPath: undefined, assetId: undefined },
        }));
      } else {
        missingAssets.push({
          id: obj.id,
          kind: 'mesh',
          assetId: assetId || null,
          meshPath: meshPath || null,
          url: obj.asset.url || null,
          reason: cachedAsset.hasError ? 'blob-fetch-and-cache-error' : 'blob-fetch-and-cache-miss',
        });
        updatedObjects.push(await withCollectedAudioSources({
          ...obj,
          asset: { ...obj.asset, path: null, meshPath: undefined, assetId: undefined },
        }));
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
