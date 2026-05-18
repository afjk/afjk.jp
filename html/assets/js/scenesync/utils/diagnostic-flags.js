export function isSnapshotRestoreDisabled() {
  return new URLSearchParams(location.search).get('noRestore') === '1';
}

export function isAssetCacheReadDisabled() {
  const params = new URLSearchParams(location.search);
  return params.get('noAssetCache') === '1' || params.get('noAssetCacheRead') === '1';
}

export function isAssetCacheWriteDisabled() {
  const params = new URLSearchParams(location.search);
  return params.get('noAssetCache') === '1' || params.get('noAssetCacheWrite') === '1';
}

export function isGlbLoadDisabled() {
  return new URLSearchParams(location.search).get('noGlbLoad') === '1';
}

export function logDiagnosticFlags() {
  const params = new URLSearchParams(location.search);
  const flags = {
    noRestore: params.get('noRestore') === '1',
    noAssetCache: params.get('noAssetCache') === '1',
    noAssetCacheRead: params.get('noAssetCacheRead') === '1',
    noAssetCacheWrite: params.get('noAssetCacheWrite') === '1',
    noGlbLoad: params.get('noGlbLoad') === '1',
    probe: params.get('probe') === '1',
  };

  const enabledFlags = Object.entries(flags)
    .filter(([, value]) => value)
    .map(([key]) => key);

  if (enabledFlags.length > 0) {
    console.warn('[SceneSync diagnostic] Flags enabled:', enabledFlags);
  }

  return flags;
}
