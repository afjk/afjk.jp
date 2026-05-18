export function isSafeModeEnabled() {
  return new URLSearchParams(location.search).get('safe') === '1';
}

export function isSnapshotRestoreDisabled() {
  const params = new URLSearchParams(location.search);
  return isSafeModeEnabled() || params.get('noRestore') === '1';
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
  const params = new URLSearchParams(location.search);
  return isSafeModeEnabled() || params.get('noGlbLoad') === '1';
}

export function logDiagnosticFlags() {
  const params = new URLSearchParams(location.search);
  const flags = {
    safe: isSafeModeEnabled(),
    noRestore: isSnapshotRestoreDisabled(),
    noAssetCache: params.get('noAssetCache') === '1',
    noAssetCacheRead: params.get('noAssetCacheRead') === '1',
    noAssetCacheWrite: params.get('noAssetCacheWrite') === '1',
    noGlbLoad: isGlbLoadDisabled(),
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
