// Shared in-memory representation for Gaussian Splat imports.
//
// Every reader (PLY / SPZ) decodes into this shape, and the KHR GLB writer only
// ever consumes this shape. Values are stored in KHR_gaussian_splatting
// conventions, which means activations are already applied:
//
//   scales    linear standard deviations   (PLY stores log, SPZ stores log/16-10)
//   opacities linear alpha in [0, 1]       (PLY stores a logit)
//   rotations normalized quaternion, xyzw  (PLY stores wxyz)
//   sh0/shRest raw spherical harmonic coefficients, NOT display RGB
//
// Spherical harmonics past degree 0 are kept coefficient-major and
// channel-minor, i.e. [coef0.r, coef0.g, coef0.b, coef1.r, ...]. This matches
// both the SPZ payload order and the KHR attribute split, so the writer can
// slice it without reshuffling.

export const SH_C0 = 0.28209479177387814;

/** Number of SH coefficients contributed by each degree band. */
export const SH_COEFS_PER_DEGREE = Object.freeze([1, 3, 5, 7]);

/** Total SH coefficients past degree 0, indexed by max degree. */
export const SH_REST_COEFS_BY_DEGREE = Object.freeze([0, 3, 8, 15]);

/**
 * @typedef {Object} SplatCloud
 * @property {number} count               splat count
 * @property {Float32Array} positions     count * 3
 * @property {Float32Array} rotations     count * 4, xyzw, normalized
 * @property {Float32Array} scales        count * 3, linear
 * @property {Float32Array} opacities     count, 0..1
 * @property {Float32Array} sh0           count * 3, degree 0 SH coefficient
 * @property {Float32Array|null} shRest   count * SH_REST_COEFS_BY_DEGREE[shDegree] * 3
 * @property {number} shDegree            0..3
 * @property {boolean} antialiased        source asked for the antialiased kernel
 * @property {string} sourceFormat        'ply' | 'spz'
 */

/**
 * Allocate an empty cloud so readers can fill typed arrays in place.
 * @param {number} count
 * @param {number} shDegree
 * @returns {SplatCloud}
 */
export function createSplatCloud(count, shDegree = 0) {
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError(`Invalid splat count: ${count}`);
  }
  if (!Number.isInteger(shDegree) || shDegree < 0 || shDegree > 3) {
    throw new RangeError(`Unsupported SH degree: ${shDegree}`);
  }

  const restCoefs = SH_REST_COEFS_BY_DEGREE[shDegree];

  return {
    count,
    positions: new Float32Array(count * 3),
    rotations: new Float32Array(count * 4),
    scales: new Float32Array(count * 3),
    opacities: new Float32Array(count),
    sh0: new Float32Array(count * 3),
    shRest: restCoefs > 0 ? new Float32Array(count * restCoefs * 3) : null,
    shDegree,
    antialiased: false,
    sourceFormat: 'ply',
  };
}

/** Logistic activation: PLY stores opacity as a logit. */
export function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

/**
 * Normalize a quaternion in place within a Float32Array.
 * Degenerate quaternions fall back to identity rather than producing NaN,
 * which would poison the whole accessor min/max.
 */
export function normalizeQuaternion(target, offset) {
  const x = target[offset];
  const y = target[offset + 1];
  const z = target[offset + 2];
  const w = target[offset + 3];
  const length = Math.hypot(x, y, z, w);

  if (!(length > 1e-8)) {
    target[offset] = 0;
    target[offset + 1] = 0;
    target[offset + 2] = 0;
    target[offset + 3] = 1;
    return;
  }

  target[offset] = x / length;
  target[offset + 1] = y / length;
  target[offset + 2] = z / length;
  target[offset + 3] = w / length;
}

/**
 * Convert a degree 0 SH coefficient triple to display RGB.
 * Only used for diagnostics and tests; the GLB carries coefficients.
 */
export function sh0ToRgb(sh0, offset = 0) {
  return [
    sh0[offset] * SH_C0 + 0.5,
    sh0[offset + 1] * SH_C0 + 0.5,
    sh0[offset + 2] * SH_C0 + 0.5,
  ];
}

/** Inverse of {@link sh0ToRgb}. */
export function rgbToSh0(r, g, b) {
  return [(r - 0.5) / SH_C0, (g - 0.5) / SH_C0, (b - 0.5) / SH_C0];
}

/**
 * Per-axis min/max of the position array, as glTF accessors require.
 * @param {Float32Array} positions
 * @param {number} count
 */
export function computePositionBounds(positions, count) {
  if (count === 0) return { min: [0, 0, 0], max: [0, 0, 0] };

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < count; i++) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i * 3 + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }

  return { min, max };
}
