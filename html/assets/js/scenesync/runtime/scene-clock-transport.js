export function normalizeSceneClockDeactivateArgs(nowOrOptions, maybeOptions = {}, getNow = () => performance.now()) {
  const now = typeof nowOrOptions === 'number' ? nowOrOptions : getNow();
  const options = nowOrOptions && typeof nowOrOptions === 'object'
    ? nowOrOptions
    : maybeOptions;

  return {
    now,
    preserveLocalTimeline: options?.preserveLocalTimeline === true,
    resumeLocalTimeline: options?.resumeLocalTimeline === true,
  };
}

export function preserveLocalSceneClockTimeline(state, {
  now,
  getSceneClockTime,
  resume = false,
} = {}) {
  if (!state || state.mode !== 'local' || typeof getSceneClockTime !== 'function') return false;

  state.localTime = getSceneClockTime(now);
  state.lastUpdateNow = now;

  if (resume) {
    state.paused = false;
    state.pausedAt = null;
  }

  return true;
}
