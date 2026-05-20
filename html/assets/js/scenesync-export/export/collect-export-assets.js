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

export async function collectExportAssets({
  sceneDocument,
  blobBase,
  envOrigin,
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

  // Collect mesh assets
  const updatedObjects = [];
  for (const obj of sceneDocument.objects) {
    if (!obj.asset || obj.asset.type === 'primitive') {
      updatedObjects.push(obj);
      continue;
    }

    const meshPath = obj.asset.meshPath;
    const mime = obj.asset.mime || 'model/gltf-binary';
    const ext = extensionFor(mime, 'glb');
    const baseName = sanitizeFilename(obj.asset.originalName?.replace(/\.[^.]+$/, '') || obj.id);
    const zipPath = uniquePath(baseName, ext);

    let fetchUrl = null;
    if (meshPath && blobBase) {
      fetchUrl = `${blobBase}/${meshPath}`;
    }

    const buffer = await tryFetch(fetchUrl);

    if (buffer) {
      files[zipPath] = buffer;
      assetManifest.push({ id: obj.id, kind: 'mesh', path: zipPath, status: 'included' });
      updatedObjects.push({
        ...obj,
        asset: { ...obj.asset, path: zipPath, meshPath: undefined },
      });
    } else {
      missingAssets.push({ id: obj.id, kind: 'mesh', path: meshPath, reason: 'fetch-failed' });
      updatedObjects.push({ ...obj, asset: { ...obj.asset, path: null, meshPath: undefined } });
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
