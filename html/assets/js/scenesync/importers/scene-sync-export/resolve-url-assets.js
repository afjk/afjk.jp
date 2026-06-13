function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function resolveUrl(path, baseUrl) {
  if (!path || typeof path !== 'string') return null;
  try {
    return new URL(path, baseUrl).href;
  } catch {
    return null;
  }
}

function resolveAsset(asset, baseUrl) {
  const next = cloneJson(asset);
  if (!next || typeof next !== 'object') return next;

  if (next.type === 'text' && next.source === 'inline') {
    delete next.path;
    return next;
  }

  if (next.path) {
    const url = resolveUrl(next.path, baseUrl);
    if (url) {
      next.url = url;
      next.source = 'url';
    }
    delete next.path;
  }

  return next;
}

function resolveAudioSources(audioSources, baseUrl) {
  if (!audioSources || typeof audioSources !== 'object' || Array.isArray(audioSources)) {
    return cloneJson(audioSources);
  }

  const resolved = {};
  for (const [name, source] of Object.entries(audioSources)) {
    const next = cloneJson(source);
    if (!next || typeof next !== 'object') {
      resolved[name] = next;
      continue;
    }

    const assetPath = next.asset?.path;
    if (assetPath) {
      const url = resolveUrl(assetPath, baseUrl);
      if (url) next.url = url;
    }
    if (next.asset) delete next.asset;
    resolved[name] = next;
  }
  return resolved;
}

function resolveBgm(bgm, baseUrl) {
  const next = cloneJson(bgm);
  if (!next || typeof next !== 'object') return next;

  const assetPath = next.asset?.path;
  if (assetPath) {
    const url = resolveUrl(assetPath, baseUrl);
    if (url) next.url = url;
  }
  delete next.asset;
  delete next.importAsset;
  return next;
}

export function resolveSceneDocumentAssetsFromUrl(sceneDocument, { baseUrl } = {}) {
  if (!baseUrl) {
    return { document: cloneJson(sceneDocument) };
  }

  const objects = (sceneDocument.objects || []).map((obj) => {
    const next = {
      ...cloneJson(obj),
      asset: resolveAsset(obj.asset, baseUrl),
    };

    delete next.importAsset;
    delete next.importAudioSources;

    if (obj.audioSources !== undefined) {
      next.audioSources = resolveAudioSources(obj.audioSources, baseUrl);
    }

    return next;
  });

  return {
    document: {
      ...cloneJson(sceneDocument),
      objects,
      bgm: resolveBgm(sceneDocument.bgm, baseUrl),
    },
  };
}
