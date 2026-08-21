// Reader for Niantic's SPZ container (versions 1-3).
//
// The file is a gzip stream wrapping a 16 byte header followed by fixed-size
// sections, one section per attribute, each holding every splat before the next
// section begins:
//
//   header      magic "NGSP", version, numSplats, shDegree, fractionalBits, flags
//   positions   v1: half floats;  v2/v3: 24 bit signed fixed point
//   alphas      1 byte per splat, alpha * 255
//   colors      3 bytes per splat, degree 0 SH scaled by 0.15 and biased by 0.5
//   scales      3 bytes per splat, log scale encoded as (log(s) + 10) * 16
//   rotations   v1/v2: 3 bytes, xyz with w recovered;  v3: 4 bytes, smallest-three
//   sh          shCoefs * 3 bytes per splat, coefficient-major, (byte - 128) / 128
//
// Decoding is byte-exact against the reference implementation; the only
// conversion applied on top is turning SPZ's display colors back into the raw
// degree 0 SH coefficients that KHR_gaussian_splatting stores.

import {
  SH_REST_COEFS_BY_DEGREE,
  createSplatCloud,
  normalizeQuaternion,
  resolveShDegree,
} from './splat-cloud.js';

const SPZ_MAGIC = 0x5053474e; // "NGSP" little endian
const SPZ_HEADER_BYTES = 16;
const SPZ_COLOR_SCALE = 0.15;
const FLAG_ANTIALIASED = 0x01;
const FLAG_LOD = 0x80;

export class UnsupportedSpzError extends Error {
  constructor(message, variant) {
    super(message);
    this.name = 'UnsupportedSpzError';
    this.variant = variant;
  }
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('Expected ArrayBuffer or typed array');
}

/** SPZ payloads are always gzip framed; detect the RFC 1952 magic. */
export function isGzip(bytes) {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Inflate a gzip stream using DecompressionStream, which exists in browsers and
 * in Node 18+. Callers that already hold the plain payload can skip this.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function gunzip(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('DecompressionStream is unavailable, cannot inflate SPZ');
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Parse the 16 byte SPZ header from an already inflated payload.
 */
export function parseSpzHeader(bytes) {
  if (bytes.byteLength < SPZ_HEADER_BYTES) throw new Error('SPZ payload is shorter than its header');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SPZ_MAGIC) throw new Error('Invalid SPZ magic');

  const version = view.getUint32(4, true);
  if (version < 1 || version > 3) throw new UnsupportedSpzError(`Unsupported SPZ version: ${version}`, 'version');

  const flags = view.getUint8(14);

  return {
    version,
    count: view.getUint32(8, true),
    shDegree: view.getUint8(12),
    fractionalBits: view.getUint8(13),
    flags,
    antialiased: (flags & FLAG_ANTIALIASED) !== 0,
    lod: (flags & FLAG_LOD) !== 0,
    reserved: view.getUint8(15),
  };
}

function halfToFloat(half) {
  const sign = (half & 0x8000) ? -1 : 1;
  const exponent = (half >> 10) & 0x1f;
  const mantissa = half & 0x03ff;

  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa ? NaN : sign * Infinity;
  return sign * (mantissa + 1024) * 2 ** (exponent - 25);
}

/**
 * Decode an inflated SPZ payload into a SplatCloud.
 * @param {ArrayBuffer|Uint8Array} input inflated payload, not the gzip stream
 * @returns {import('./splat-cloud.js').SplatCloud}
 */
export function readSpzPayload(input, options = {}) {
  const { maxShDegree } = options;
  const bytes = toUint8Array(input);
  const header = parseSpzHeader(bytes);

  if (header.shDegree > 3) {
    throw new UnsupportedSpzError(`Unsupported SPZ SH degree: ${header.shDegree}`, 'sh-degree');
  }

  const shDegree = resolveShDegree(header.shDegree, maxShDegree);
  const cloud = createSplatCloud(header.count, shDegree);
  cloud.sourceFormat = 'spz';
  cloud.antialiased = header.antialiased;
  cloud.sourceShDegree = header.shDegree;

  const { count } = header;
  const positionBytes = header.version === 1 ? count * 3 * 2 : count * 3 * 3;
  const rotationBytes = header.version === 3 ? count * 4 : count * 3;
  const shCoefs = SH_REST_COEFS_BY_DEGREE[header.shDegree];
  const shBytes = count * shCoefs * 3;

  let offset = SPZ_HEADER_BYTES;
  const required = offset + positionBytes + count + count * 3 + count * 3 + rotationBytes + shBytes;
  if (required > bytes.byteLength) {
    throw new Error(`SPZ payload is truncated: need ${required} bytes, have ${bytes.byteLength}`);
  }

  // Positions.
  if (header.version === 1) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < count * 3; i++) {
      cloud.positions[i] = halfToFloat(view.getUint16(offset + i * 2, true));
    }
  } else {
    const divisor = 1 << header.fractionalBits;
    for (let i = 0; i < count * 3; i++) {
      const base = offset + i * 3;
      // Sign-extend 24 bits by shifting into the high byte and back down.
      const raw = (bytes[base + 2] << 24) | (bytes[base + 1] << 16) | (bytes[base] << 8);
      cloud.positions[i] = (raw >> 8) / divisor;
    }
  }
  offset += positionBytes;

  // Alphas, already linear.
  for (let i = 0; i < count; i++) cloud.opacities[i] = bytes[offset + i] / 255;
  offset += count;

  // Colors are stored as display values; recover the degree 0 SH coefficient.
  for (let i = 0; i < count * 3; i++) {
    cloud.sh0[i] = (bytes[offset + i] / 255 - 0.5) / SPZ_COLOR_SCALE;
  }
  offset += count * 3;

  // Scales, log encoded.
  for (let i = 0; i < count * 3; i++) {
    cloud.scales[i] = Math.exp(bytes[offset + i] / 16 - 10);
  }
  offset += count * 3;

  // Rotations.
  if (header.version === 3) {
    readSmallestThreeRotations(bytes, offset, count, cloud.rotations);
  } else {
    for (let i = 0; i < count; i++) {
      const base = offset + i * 3;
      const x = bytes[base] / 127.5 - 1;
      const y = bytes[base + 1] / 127.5 - 1;
      const z = bytes[base + 2] / 127.5 - 1;
      cloud.rotations[i * 4] = x;
      cloud.rotations[i * 4 + 1] = y;
      cloud.rotations[i * 4 + 2] = z;
      cloud.rotations[i * 4 + 3] = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
      normalizeQuaternion(cloud.rotations, i * 4);
    }
  }
  offset += rotationBytes;

  // Higher order SH, already coefficient-major which is what SplatCloud wants.
  //
  // The bands sit contiguously per splat in degree order, so keeping only the
  // first coefficients of each splat's block is exactly degrees 1..shDegree.
  // The source stride still spans every band the file carries.
  if (cloud.shRest) {
    const sourceCoefs = SH_REST_COEFS_BY_DEGREE[header.shDegree];
    const keptFloats = SH_REST_COEFS_BY_DEGREE[cloud.shDegree] * 3;

    for (let i = 0; i < count; i++) {
      const source = offset + i * sourceCoefs * 3;
      const destination = i * keptFloats;
      for (let j = 0; j < keptFloats; j++) {
        cloud.shRest[destination + j] = (bytes[source + j] - 128) / 128;
      }
    }
  }

  return cloud;
}

/**
 * SPZ v3 packs a quaternion into 32 bits: the two high bits name the component
 * with the largest magnitude, and the remaining three components each take 10
 * bits (9 magnitude + 1 sign) scaled against 1/sqrt(2).
 */
function readSmallestThreeRotations(bytes, offset, count, target) {
  const maxValue = Math.SQRT1_2;
  const valueMask = (1 << 9) - 1;

  for (let i = 0; i < count; i++) {
    const base = offset + i * 4;
    const packed = bytes[base] | (bytes[base + 1] << 8) | (bytes[base + 2] << 16) | (bytes[base + 3] << 24);
    const largestIndex = packed >>> 30;

    const quaternion = [0, 0, 0, 0];
    let remaining = packed;
    let sumSquares = 0;

    for (let component = 3; component >= 0; component--) {
      if (component === largestIndex) continue;
      const magnitude = remaining & valueMask;
      const negative = (remaining >>> 9) & 1;
      remaining >>>= 10;
      const value = maxValue * (magnitude / valueMask);
      quaternion[component] = negative === 0 ? value : -value;
      sumSquares += value * value;
    }

    quaternion[largestIndex] = Math.sqrt(Math.max(0, 1 - sumSquares));

    target[i * 4] = quaternion[0];
    target[i * 4 + 1] = quaternion[1];
    target[i * 4 + 2] = quaternion[2];
    target[i * 4 + 3] = quaternion[3];
    normalizeQuaternion(target, i * 4);
  }
}

/**
 * Decode a .spz file, inflating it first when it is gzip framed.
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<import('./splat-cloud.js').SplatCloud>}
 */
export async function readGaussianSplatSpz(input, options = {}) {
  const bytes = toUint8Array(input);
  const payload = isGzip(bytes) ? await gunzip(bytes) : bytes;
  return readSpzPayload(payload, options);
}
