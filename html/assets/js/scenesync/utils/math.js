export function extractYaw(quat) {
  const x = quat.x;
  const y = quat.y;
  const z = quat.z;
  const w = quat.w;

  return Math.atan2(
    2 * (w * y + x * z),
    1 - 2 * (y * y + x * x)
  );
}

export function isFiniteVec3Array(value) {
  return Array.isArray(value) &&
    value.length >= 3 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Number.isFinite(value[2]);
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
