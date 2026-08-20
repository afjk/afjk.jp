// Fixture builders shared by the Gaussian Splat importer tests.
//
// These write the *source* encodings (PLY logits/log-scales, SPZ quantized
// bytes) so the tests exercise the real activation and dequantization paths
// rather than a pre-decoded shortcut.

import { SH_REST_COEFS_BY_DEGREE } from './splat-cloud.js';

/** Inverse of the logistic activation the PLY reader applies to opacity. */
export function logit(value) {
  return Math.log(value / (1 - value));
}

/**
 * Build an INRIA-layout 3DGS PLY.
 *
 * @param {Array<Object>} splats each with position, scale, rotation (xyzw),
 *   opacity (linear), sh0 and optionally shRest (coefficient-major)
 * @param {Object} [options]
 * @param {number} [options.shDegree]
 * @param {'binary_little_endian'|'binary_big_endian'|'ascii'} [options.format]
 * @returns {Uint8Array}
 */
export function buildGaussianSplatPly(splats, options = {}) {
  const { shDegree = 0, format = 'binary_little_endian' } = options;
  const restCoefs = SH_REST_COEFS_BY_DEGREE[shDegree];
  const restCount = restCoefs * 3;

  const properties = [
    'x', 'y', 'z',
    'nx', 'ny', 'nz',
    'f_dc_0', 'f_dc_1', 'f_dc_2',
    ...Array.from({ length: restCount }, (_, i) => `f_rest_${i}`),
    'opacity',
    'scale_0', 'scale_1', 'scale_2',
    'rot_0', 'rot_1', 'rot_2', 'rot_3',
  ];

  const header = [
    'ply',
    `format ${format} 1.0`,
    `element vertex ${splats.length}`,
    ...properties.map((name) => `property float ${name}`),
    'end_header',
    '',
  ].join('\n');

  const rows = splats.map((splat) => {
    const rest = new Array(restCount).fill(0);
    if (splat.shRest) {
      // Test input is coefficient-major; PLY stores channel-major.
      for (let coef = 0; coef < restCoefs; coef++) {
        for (let channel = 0; channel < 3; channel++) {
          rest[coef + channel * restCoefs] = splat.shRest[coef * 3 + channel];
        }
      }
    }

    return [
      ...splat.position,
      0, 0, 0,
      ...splat.sh0,
      ...rest,
      logit(splat.opacity),
      ...splat.scale.map((value) => Math.log(value)),
      splat.rotation[3], splat.rotation[0], splat.rotation[1], splat.rotation[2],
    ];
  });

  const headerBytes = new TextEncoder().encode(header);

  if (format === 'ascii') {
    const body = new TextEncoder().encode(`${rows.map((row) => row.join(' ')).join('\n')}\n`);
    return concat([headerBytes, body]);
  }

  const littleEndian = format === 'binary_little_endian';
  const body = new Uint8Array(rows.length * properties.length * 4);
  const view = new DataView(body.buffer);
  let offset = 0;
  for (const row of rows) {
    for (const value of row) {
      view.setFloat32(offset, value, littleEndian);
      offset += 4;
    }
  }

  return concat([headerBytes, body]);
}

/**
 * Build an uncompressed SPZ payload (the bytes that live inside the gzip
 * stream), quantizing exactly the way the reference encoder does.
 *
 * @param {Array<Object>} splats
 * @param {Object} [options]
 * @param {1|2|3} [options.version]
 * @param {number} [options.shDegree]
 * @param {number} [options.fractionalBits]
 * @param {boolean} [options.antialiased]
 * @returns {Uint8Array}
 */
export function buildSpzPayload(splats, options = {}) {
  const {
    version = 2,
    shDegree = 0,
    fractionalBits = 12,
    antialiased = false,
  } = options;

  const count = splats.length;
  const restCoefs = SH_REST_COEFS_BY_DEGREE[shDegree];
  const positionBytes = version === 1 ? count * 3 * 2 : count * 3 * 3;
  const rotationBytes = version === 3 ? count * 4 : count * 3;
  const shBytes = count * restCoefs * 3;

  const total = 16 + positionBytes + count + count * 3 + count * 3 + rotationBytes + shBytes;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, 0x5053474e, true);
  view.setUint32(4, version, true);
  view.setUint32(8, count, true);
  view.setUint8(12, shDegree);
  view.setUint8(13, fractionalBits);
  view.setUint8(14, antialiased ? 0x01 : 0x00);
  view.setUint8(15, 0);

  let offset = 16;

  if (version === 1) {
    for (let i = 0; i < count; i++) {
      for (let axis = 0; axis < 3; axis++) {
        view.setUint16(offset, floatToHalf(splats[i].position[axis]), true);
        offset += 2;
      }
    }
  } else {
    const fixed = 1 << fractionalBits;
    for (let i = 0; i < count; i++) {
      for (let axis = 0; axis < 3; axis++) {
        const quantized = Math.round(splats[i].position[axis] * fixed) & 0xffffff;
        bytes[offset] = quantized & 0xff;
        bytes[offset + 1] = (quantized >> 8) & 0xff;
        bytes[offset + 2] = (quantized >> 16) & 0xff;
        offset += 3;
      }
    }
  }

  for (let i = 0; i < count; i++) bytes[offset++] = Math.round(splats[i].opacity * 255);

  for (let i = 0; i < count; i++) {
    for (let channel = 0; channel < 3; channel++) {
      const encoded = (splats[i].sh0[channel] * 0.15 + 0.5) * 255;
      bytes[offset++] = clampByte(Math.round(encoded));
    }
  }

  for (let i = 0; i < count; i++) {
    for (let axis = 0; axis < 3; axis++) {
      bytes[offset++] = clampByte(Math.round((Math.log(splats[i].scale[axis]) + 10) * 16));
    }
  }

  if (version === 3) {
    for (let i = 0; i < count; i++) {
      const packed = packSmallestThree(splats[i].rotation);
      bytes[offset] = packed & 0xff;
      bytes[offset + 1] = (packed >>> 8) & 0xff;
      bytes[offset + 2] = (packed >>> 16) & 0xff;
      bytes[offset + 3] = (packed >>> 24) & 0xff;
      offset += 4;
    }
  } else {
    for (let i = 0; i < count; i++) {
      const [x, y, z] = normalizeXyzw(splats[i].rotation);
      bytes[offset++] = clampByte(Math.round((x + 1) * 127.5));
      bytes[offset++] = clampByte(Math.round((y + 1) * 127.5));
      bytes[offset++] = clampByte(Math.round((z + 1) * 127.5));
    }
  }

  for (let i = 0; i < count; i++) {
    const rest = splats[i].shRest || new Array(restCoefs * 3).fill(0);
    for (let j = 0; j < restCoefs * 3; j++) {
      bytes[offset++] = clampByte(Math.round(rest[j] * 128) + 128);
    }
  }

  return bytes;
}

/** Gzip a payload so tests can exercise the framed path too. */
export async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function clampByte(value) {
  return Math.max(0, Math.min(255, value));
}

function normalizeXyzw(quaternion) {
  const length = Math.hypot(...quaternion);
  return quaternion.map((value) => value / length);
}

function packSmallestThree(quaternion) {
  const quat = normalizeXyzw(quaternion);
  let largest = 0;
  for (let i = 1; i < 4; i++) {
    if (Math.abs(quat[i]) > Math.abs(quat[largest])) largest = i;
  }

  const negate = quat[largest] < 0 ? 1 : 0;
  let packed = largest;
  for (let i = 0; i < 4; i++) {
    if (i === largest) continue;
    const negativeBit = (quat[i] < 0 ? 1 : 0) ^ negate;
    const magnitude = Math.floor(((1 << 9) - 1) * (Math.abs(quat[i]) / Math.SQRT1_2) + 0.5);
    packed = (packed << 10) | (negativeBit << 9) | magnitude;
  }
  return packed >>> 0;
}

function floatToHalf(value) {
  const buffer = new DataView(new ArrayBuffer(4));
  buffer.setFloat32(0, value, true);
  const bits = buffer.getUint32(0, true);

  const sign = (bits >>> 16) & 0x8000;
  let exponent = ((bits >>> 23) & 0xff) - 112;
  let mantissa = bits & 0x7fffff;

  if (exponent <= 0) return sign;
  if (exponent >= 0x1f) return sign | 0x7c00;

  // Round to nearest even on the 13 bits being dropped.
  const roundBit = mantissa & 0x1000;
  mantissa >>>= 13;
  if (roundBit) {
    mantissa += 1;
    if (mantissa === 0x400) {
      mantissa = 0;
      exponent += 1;
      if (exponent >= 0x1f) return sign | 0x7c00;
    }
  }

  return sign | (exponent << 10) | mantissa;
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
