export const CLOCK_SOURCES = Object.freeze({
  LOCAL: 'local',
  ROOM: 'room',
});

export const CLOCK_MODES = Object.freeze({
  LOCAL_PREVIEW: 'local-preview',
  SHARED_PLAYBACK: 'shared-playback',
  ROOM_TIME: 'room-time',
});

export const CLOCK_MODE_LABELS = Object.freeze({
  [CLOCK_MODES.LOCAL_PREVIEW]: 'Local Preview',
  [CLOCK_MODES.SHARED_PLAYBACK]: 'Shared Playback',
  [CLOCK_MODES.ROOM_TIME]: 'Room Time',
});

export function normalizeClockMode(mode, fallback = CLOCK_MODES.LOCAL_PREVIEW) {
  return Object.values(CLOCK_MODES).includes(mode) ? mode : fallback;
}

export function clockSourceForMode(mode) {
  switch (normalizeClockMode(mode)) {
    case CLOCK_MODES.SHARED_PLAYBACK:
    case CLOCK_MODES.ROOM_TIME:
      return CLOCK_SOURCES.ROOM;
    case CLOCK_MODES.LOCAL_PREVIEW:
    default:
      return CLOCK_SOURCES.LOCAL;
  }
}

export function createClockState({
  mode = CLOCK_MODES.LOCAL_PREVIEW,
  offset = 0,
  paused = false,
  pausedTime,
  rate = 1,
} = {}) {
  const normalizedMode = normalizeClockMode(mode);
  const normalizedRate = Number.isFinite(rate) && rate >= 0 ? rate : 1;
  return {
    mode: normalizedMode,
    source: clockSourceForMode(normalizedMode),
    offset: Number.isFinite(offset) ? offset : 0,
    paused: paused === true,
    pausedTime: Number.isFinite(pausedTime) ? pausedTime : undefined,
    rate: normalizedRate,
  };
}

export function getClockSourceNow(state, {
  localNow = 0,
  roomNow = 0,
} = {}) {
  return state?.source === CLOCK_SOURCES.ROOM ? roomNow : localNow;
}

export function getActiveClockTime(state, sources = {}) {
  if (!state) return 0;
  if (state.paused && Number.isFinite(state.pausedTime)) {
    return Math.max(0, state.pausedTime);
  }
  const sourceNow = getClockSourceNow(state, sources);
  const rate = Number.isFinite(state.rate) && state.rate >= 0 ? state.rate : 1;
  const offset = Number.isFinite(state.offset) ? state.offset : 0;
  return Math.max(0, sourceNow * rate + offset);
}

export function seekClockState(state, targetTime, sources = {}) {
  if (!state) return false;
  const time = Math.max(0, Number(targetTime) || 0);
  const sourceNow = getClockSourceNow(state, sources);
  const rate = Number.isFinite(state.rate) && state.rate >= 0 ? state.rate : 1;
  state.offset = time - sourceNow * rate;
  if (state.paused) state.pausedTime = time;
  return true;
}

export function pauseClockState(state, sources = {}) {
  if (!state || state.paused) return false;
  state.pausedTime = getActiveClockTime(state, sources);
  state.paused = true;
  return true;
}

export function resumeClockState(state, sources = {}) {
  if (!state || !state.paused) return false;
  const pausedTime = Number.isFinite(state.pausedTime)
    ? state.pausedTime
    : getActiveClockTime(state, sources);
  state.paused = false;
  state.pausedTime = undefined;
  seekClockState(state, pausedTime, sources);
  return true;
}

export function setClockRate(state, rate, sources = {}) {
  if (!state) return false;
  const nextRate = Number(rate);
  if (!Number.isFinite(nextRate) || nextRate < 0) return false;
  const currentTime = getActiveClockTime(state, sources);
  state.rate = nextRate;
  seekClockState(state, currentTime, sources);
  return true;
}

export function setClockMode(state, mode, sources = {}, {
  preserveTime = true,
  resetToZero = false,
} = {}) {
  if (!state) return false;
  const nextMode = normalizeClockMode(mode, state.mode);
  const nextSource = clockSourceForMode(nextMode);
  const currentTime = resetToZero
    ? 0
    : (preserveTime ? getActiveClockTime(state, sources) : 0);

  state.mode = nextMode;
  state.source = nextSource;
  state.paused = nextMode === CLOCK_MODES.ROOM_TIME ? false : state.paused;
  state.pausedTime = state.paused ? currentTime : undefined;
  seekClockState(state, currentTime, sources);
  return true;
}

export function getObjectAge(activeTime, objectClockState, {
  mode = CLOCK_MODES.LOCAL_PREVIEW,
} = {}) {
  const normalizedMode = normalizeClockMode(mode);
  const epochTime = normalizedMode === CLOCK_MODES.LOCAL_PREVIEW
    ? Number(objectClockState?.epochTime)
    : (Number.isFinite(Number(objectClockState?.sharedEpochTime))
      ? Number(objectClockState.sharedEpochTime)
      : Number(objectClockState?.epochTime));
  if (!Number.isFinite(activeTime) || !Number.isFinite(epochTime)) return 0;
  return Math.max(0, activeTime - epochTime);
}

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
  if (!state || !['local', CLOCK_MODES.LOCAL_PREVIEW].includes(state.mode) || typeof getSceneClockTime !== 'function') return false;

  const preservedTime = getSceneClockTime(now);
  state.localTime = preservedTime;
  if (state.mode === CLOCK_MODES.LOCAL_PREVIEW) {
    state.offset = preservedTime - (now / 1000) * (state.rate || 1);
  }
  state.lastUpdateNow = now;

  if (resume) {
    state.paused = false;
    state.pausedAt = null;
  }

  return true;
}
