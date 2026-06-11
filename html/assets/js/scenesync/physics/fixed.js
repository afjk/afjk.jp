// Deterministic 16.16 fixed-point math for Scene Sync physics.
//
// All simulation state is stored as raw fixed-point integers so that every
// client (browser / Unity / Godot) can compute bit-identical results.
// Porting rules (see docs/scene-sync-physics.md):
//   fmul(a, b)  = floor((a * b) / 2^16)   (= (a * b) >> 16 in 64-bit ints)
//   fdiv(a, b)  = floor((a * 2^16) / b)   (floored division, not truncated)
//   fsqrt(a)    = floor(sqrt(a * 2^16))
//
// JavaScript numbers represent integers exactly up to 2^53. fmul is exact
// when the smaller-magnitude operand is passed first (|a| < 2^37) and
// |a * b| stays below 2^68; the world enforces this through its
// position / velocity / mass / impulse clamps.

export const FP_SHIFT = 16;
export const FP_ONE = 65536;

export function toFp(value) {
  if (!Number.isFinite(value)) return 0;
  // `+ 0` normalizes -0 so raw state never contains negative zero
  return Math.round(value * FP_ONE) + 0;
}

export function fromFp(raw) {
  return raw / FP_ONE;
}

export function floorDiv(n, d) {
  if (d === 0) throw new RangeError('floorDiv: division by zero');
  let q = Math.floor(n / d);
  // Float division can round across an integer boundary; correct with exact
  // integer remainders so the result is always the true floored quotient.
  let r = n - q * d;
  if (d > 0) {
    while (r < 0) { q -= 1; r += d; }
    while (r >= d) { q += 1; r -= d; }
  } else {
    while (r > 0) { q -= 1; r += d; }
    while (r <= d) { q += 1; r -= d; }
  }
  return q + 0;
}

export function fmul(a, b) {
  // Split b so that both partial products stay below 2^53.
  // floor((a*b) / 2^16) = a*bh + floor((a*bl) / 2^16) because a*bh*2^16 is
  // an exact multiple of 2^16, and dividing by a power of two is exact.
  const bh = Math.floor(b / FP_ONE);
  const bl = b - bh * FP_ONE;
  return a * bh + Math.floor((a * bl) / FP_ONE) + 0;
}

export function fdiv(a, b) {
  return floorDiv(a * FP_ONE, b);
}

export function fclamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function fsqrt(a) {
  if (a <= 0) return 0;
  const n = BigInt(a) << 16n;
  // Newton's method seeded above the true root converges downward; the final
  // correction loops make the result exact regardless of the float seed.
  let x = BigInt(Math.floor(Math.sqrt(Number(n)))) + 2n;
  for (;;) {
    const next = (x + n / x) >> 1n;
    if (next >= x) break;
    x = next;
  }
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return Number(x);
}

// --- vec3 helpers (arrays of raw fixed-point ints) ---

export function toFpVec(v) {
  return [toFp(v[0]), toFp(v[1]), toFp(v[2])];
}

export function fromFpVec(v) {
  return [fromFp(v[0]), fromFp(v[1]), fromFp(v[2])];
}

export function vadd(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vsub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vneg(v) {
  return [-v[0], -v[1], -v[2]];
}

export function vscale(v, s) {
  return [fmul(v[0], s), fmul(v[1], s), fmul(v[2], s)];
}

export function vdot(a, b) {
  return fmul(a[0], b[0]) + fmul(a[1], b[1]) + fmul(a[2], b[2]);
}

export function vlenSq(v) {
  return vdot(v, v);
}

export function vlen(v) {
  return fsqrt(vdot(v, v));
}

export function vclampComponents(v, limit) {
  return [
    fclamp(v[0], -limit, limit),
    fclamp(v[1], -limit, limit),
    fclamp(v[2], -limit, limit),
  ];
}

// --- deterministic PRNG (xorshift32) ---

export function createXorShift32(seed = 1) {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  function nextUint32() {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state;
  }
  function nextFp() {
    // [0, FP_ONE)
    return nextUint32() >>> 16;
  }
  function nextFpRange(minFp, maxFp) {
    return minFp + fmul(maxFp - minFp, nextFp());
  }
  return { nextUint32, nextFp, nextFpRange };
}

// --- FNV-1a 32-bit hash for state divergence checks ---

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function hashInit() {
  return FNV_OFFSET;
}

function hashByte(h, byte) {
  return Math.imul(h ^ (byte & 0xff), FNV_PRIME) >>> 0;
}

export function hashUint32(h, value) {
  const v = value >>> 0;
  h = hashByte(h, v);
  h = hashByte(h, v >>> 8);
  h = hashByte(h, v >>> 16);
  h = hashByte(h, v >>> 24);
  return h;
}

export function hashInt(h, value) {
  const bits = BigInt.asUintN(64, BigInt(value));
  h = hashUint32(h, Number(bits & 0xffffffffn));
  return hashUint32(h, Number(bits >> 32n));
}

export function hashString(h, str) {
  for (let i = 0; i < str.length; i += 1) {
    h = hashUint32(h, str.charCodeAt(i));
  }
  return h;
}

export function hashHex(h) {
  return (h >>> 0).toString(16).padStart(8, '0');
}
