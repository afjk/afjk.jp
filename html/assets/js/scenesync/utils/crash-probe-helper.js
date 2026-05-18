const CRASH_PROBE_KEY = 'sceneSync.crashProbe';

export function isCrashProbeEnabled() {
  return new URLSearchParams(location.search).get('probe') === '1';
}

export function markCrashProbe(phase, details = {}) {
  if (!isCrashProbeEnabled()) return;
  try {
    localStorage.setItem(CRASH_PROBE_KEY, JSON.stringify({
      phase,
      details,
      at: Date.now(),
      href: location.href,
    }));
    console.warn('[SceneSync crash-probe]', phase, details);
  } catch (error) {
    console.warn('[SceneSync crash-probe] failed to write', error);
  }
}

export function clearCrashProbe(phase = 'complete') {
  if (!isCrashProbeEnabled()) return;
  try {
    localStorage.setItem(CRASH_PROBE_KEY, JSON.stringify({
      phase,
      completed: true,
      at: Date.now(),
      href: location.href,
    }));
  } catch {}
}

export function reportPreviousCrashProbe() {
  if (!isCrashProbeEnabled()) return;
  try {
    const raw = localStorage.getItem(CRASH_PROBE_KEY);
    if (!raw) return;
    const value = JSON.parse(raw);
    if (!value?.completed) {
      console.warn('[SceneSync crash-probe] previous session may have crashed near:', value);
    }
  } catch {}
}
