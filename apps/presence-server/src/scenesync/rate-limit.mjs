export function createPerActorRateLimiter(limit = 10, windowMs = 60_000) {
  const buckets = new Map();

  return {
    allow(actorId, now = Date.now()) {
      if (!actorId) return true;
      const bucket = buckets.get(actorId) || [];
      const threshold = now - windowMs;
      const active = bucket.filter(ts => ts > threshold);
      if (active.length >= limit) {
        buckets.set(actorId, active);
        return false;
      }
      active.push(now);
      buckets.set(actorId, active);
      return true;
    },
  };
}
