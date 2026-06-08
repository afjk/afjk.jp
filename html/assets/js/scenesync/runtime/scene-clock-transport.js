export function normalizeSceneClockDeactivateArgs(nowOrOptions, maybeOptions = {}, getNow = () => performance.now()) {
  const now = typeof nowOrOptions === 'number' ? nowOrOptions : getNow();
  const options = nowOrOptions && typeof nowOrOptions === 'object'
    ? nowOrOptions
    : maybeOptions;

  return {
    now,
    preserveLocalTimeline: options?.preserveLocalTimeline === true,
  };
}
