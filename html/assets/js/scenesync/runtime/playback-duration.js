export const DEFAULT_SCENE_PLAYBACK_DURATION = 60;

function isPositiveFiniteNumber(value) {
  return Number.isFinite(value) && value > 0;
}

function getClipDuration(clip) {
  return isPositiveFiniteNumber(clip?.duration) ? clip.duration : 0;
}

function clampClipIndex(value, clipCount) {
  const index = Number.parseInt(value, 10);
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(Math.max(0, clipCount - 1), index));
}

function normalizeSpeed(value) {
  return isPositiveFiniteNumber(value) ? value : 1;
}

function getCompanionClipIndices(entry) {
  if (Array.isArray(entry?.companionClipIndices)) {
    return entry.companionClipIndices;
  }
  if (Array.isArray(entry?.companionActions)) {
    return entry.companionActions.map((companion) => companion?.clipIndex);
  }
  return [];
}

export function calculateAnimationEntryPlaybackDuration(entry) {
  if (!entry || entry.enabled === false) return 0;

  const clips = Array.isArray(entry.clips) ? entry.clips : [];
  if (clips.length === 0) return 0;

  const clipIndex = clampClipIndex(entry.clipIndex ?? entry.clip, clips.length);
  let duration = getClipDuration(clips[clipIndex]);

  for (const index of getCompanionClipIndices(entry)) {
    const companionIndex = clampClipIndex(index, clips.length);
    duration = Math.max(duration, getClipDuration(clips[companionIndex]));
  }

  if (duration <= 0) return 0;
  return duration / normalizeSpeed(entry.speed);
}

export function calculateScenePlaybackDuration({
  animationEntries = [],
  defaultDuration = DEFAULT_SCENE_PLAYBACK_DURATION,
} = {}) {
  let duration = isPositiveFiniteNumber(defaultDuration)
    ? defaultDuration
    : DEFAULT_SCENE_PLAYBACK_DURATION;

  for (const entry of animationEntries) {
    duration = Math.max(duration, calculateAnimationEntryPlaybackDuration(entry));
  }

  return Math.ceil(duration * 100) / 100;
}
