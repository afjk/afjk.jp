// Reader for the INRIA "3D Gaussian Splatting" PLY layout.
//
// The de-facto training output stores one `vertex` element per splat with:
//   x, y, z                 position
//   nx, ny, nz              unused normals, present but ignored
//   f_dc_0..2               degree 0 SH coefficients
//   f_rest_0..N             higher degree SH, channel-major (all R, all G, all B)
//   opacity                 logit
//   scale_0..2              log scale
//   rot_0..3                quaternion, w first
//
// Anything that does not carry the splat-specific properties is rejected with a
// named reason rather than silently imported as a degenerate cloud.

import {
  SH_REST_COEFS_BY_DEGREE,
  createSplatCloud,
  normalizeQuaternion,
  resolveShDegree,
  sigmoid,
} from './splat-cloud.js';

const HEADER_TERMINATOR = 'end_header';
const MAX_HEADER_BYTES = 1024 * 512;

const SCALAR_TYPES = new Map([
  ['char', { size: 1, read: (view, offset, le) => view.getInt8(offset, le) }],
  ['int8', { size: 1, read: (view, offset, le) => view.getInt8(offset, le) }],
  ['uchar', { size: 1, read: (view, offset, le) => view.getUint8(offset, le) }],
  ['uint8', { size: 1, read: (view, offset, le) => view.getUint8(offset, le) }],
  ['short', { size: 2, read: (view, offset, le) => view.getInt16(offset, le) }],
  ['int16', { size: 2, read: (view, offset, le) => view.getInt16(offset, le) }],
  ['ushort', { size: 2, read: (view, offset, le) => view.getUint16(offset, le) }],
  ['uint16', { size: 2, read: (view, offset, le) => view.getUint16(offset, le) }],
  ['int', { size: 4, read: (view, offset, le) => view.getInt32(offset, le) }],
  ['int32', { size: 4, read: (view, offset, le) => view.getInt32(offset, le) }],
  ['uint', { size: 4, read: (view, offset, le) => view.getUint32(offset, le) }],
  ['uint32', { size: 4, read: (view, offset, le) => view.getUint32(offset, le) }],
  ['float', { size: 4, read: (view, offset, le) => view.getFloat32(offset, le) }],
  ['float32', { size: 4, read: (view, offset, le) => view.getFloat32(offset, le) }],
  ['double', { size: 8, read: (view, offset, le) => view.getFloat64(offset, le) }],
  ['float64', { size: 8, read: (view, offset, le) => view.getFloat64(offset, le) }],
]);

const REQUIRED_PROPERTIES = Object.freeze([
  'x', 'y', 'z',
  'opacity',
  'scale_0', 'scale_1', 'scale_2',
  'rot_0', 'rot_1', 'rot_2', 'rot_3',
  'f_dc_0', 'f_dc_1', 'f_dc_2',
]);

export class UnsupportedPlyVariantError extends Error {
  constructor(message, variant) {
    super(message);
    this.name = 'UnsupportedPlyVariantError';
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

/**
 * Split the ASCII header off the front of a PLY file.
 * @returns {{ headerText: string, bodyOffset: number }}
 */
export function splitPlyHeader(bytes) {
  const limit = Math.min(bytes.byteLength, MAX_HEADER_BYTES);
  const text = new TextDecoder('utf-8').decode(bytes.subarray(0, limit));
  const index = text.indexOf(HEADER_TERMINATOR);
  if (index < 0) throw new Error('PLY header terminator (end_header) not found');

  // The body starts after the newline that follows end_header. Measure in bytes,
  // not characters, because the header is ASCII but the decoder is not.
  const afterTerminator = index + HEADER_TERMINATOR.length;
  let bodyStart = afterTerminator;
  if (text[bodyStart] === '\r') bodyStart += 1;
  if (text[bodyStart] === '\n') bodyStart += 1;

  return {
    headerText: text.slice(0, index + HEADER_TERMINATOR.length),
    bodyOffset: bodyStart,
  };
}

/**
 * Parse a PLY header into elements and their property descriptors.
 */
export function parsePlyHeader(headerText) {
  const lines = headerText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== 'ply') throw new Error('Not a PLY file: missing "ply" magic');

  let format = null;
  const elements = [];

  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);
    const keyword = parts[0];

    if (keyword === 'format') {
      format = parts[1];
    } else if (keyword === 'element') {
      elements.push({ name: parts[1], count: Number(parts[2]), properties: [] });
    } else if (keyword === 'property') {
      const element = elements[elements.length - 1];
      if (!element) throw new Error('PLY property declared before any element');

      if (parts[1] === 'list') {
        element.properties.push({
          name: parts[4],
          isList: true,
          countType: parts[2],
          entryType: parts[3],
        });
      } else {
        element.properties.push({ name: parts[2], isList: false, type: parts[1] });
      }
    } else if (keyword === HEADER_TERMINATOR) {
      break;
    }
  }

  if (!format) throw new Error('PLY header has no format line');
  if (!['ascii', 'binary_little_endian', 'binary_big_endian'].includes(format)) {
    throw new Error(`Unsupported PLY format: ${format}`);
  }

  return { format, elements };
}

/**
 * Count f_rest_* properties and derive the SH degree they encode.
 * INRIA writes 3 * (bands - 1) coefficients: 9 for degree 1, 24 for 2, 45 for 3.
 */
export function detectShDegree(propertyNames) {
  const restCount = propertyNames.filter((name) => /^f_rest_\d+$/.test(name)).length;
  if (restCount === 0) return 0;

  for (let degree = 3; degree >= 1; degree--) {
    if (restCount === SH_REST_COEFS_BY_DEGREE[degree] * 3) return degree;
  }

  // Truncated or padded SH sets show up in the wild. Fall back to the highest
  // complete band rather than mis-indexing into f_rest.
  for (let degree = 3; degree >= 1; degree--) {
    if (restCount >= SH_REST_COEFS_BY_DEGREE[degree] * 3) return degree;
  }
  return 0;
}

/**
 * Build the f_rest index map for one SH degree band.
 *
 * f_rest is channel-major: with 45 coefficients, indices 0..14 are red,
 * 15..29 green, 30..44 blue. Within a channel, degree 1 occupies slots 0..2,
 * degree 2 slots 3..7 and degree 3 slots 8..14.
 *
 * @returns {number[]} f_rest indices ordered [coef0.r, coef0.g, coef0.b, ...]
 */
export function shRestIndices(degree, totalRestProperties) {
  const perChannel = totalRestProperties / 3;
  const bandStart = SH_REST_COEFS_BY_DEGREE[degree - 1];
  const bandLength = SH_REST_COEFS_BY_DEGREE[degree] - bandStart;
  const indices = [];

  for (let coef = 0; coef < bandLength; coef++) {
    for (let channel = 0; channel < 3; channel++) {
      indices.push(bandStart + coef + channel * perChannel);
    }
  }

  return indices;
}

function assertSplatProperties(propertyNames) {
  if (propertyNames.some((name) => name.startsWith('packed_') || name === 'min_x')) {
    throw new UnsupportedPlyVariantError(
      'Compressed SuperSplat/PlayCanvas PLY is not supported. Export an uncompressed PLY.',
      'compressed-chunked',
    );
  }

  const missing = REQUIRED_PROPERTIES.filter((name) => !propertyNames.includes(name));
  if (missing.length > 0) {
    throw new UnsupportedPlyVariantError(
      `PLY vertex element is missing Gaussian Splat properties: ${missing.join(', ')}. `
      + 'This looks like a plain point cloud or mesh rather than a 3DGS export.',
      'not-gaussian-splat',
    );
  }
}

function readAsciiBody(bytes, bodyOffset, element, propertyNames) {
  const text = new TextDecoder('utf-8').decode(bytes.subarray(bodyOffset));
  const rows = [];
  let cursor = 0;

  for (let i = 0; i < element.count; i++) {
    let lineEnd = text.indexOf('\n', cursor);
    if (lineEnd < 0) lineEnd = text.length;
    const line = text.slice(cursor, lineEnd).trim();
    cursor = lineEnd + 1;

    if (!line) {
      i -= 1;
      if (cursor >= text.length) throw new Error('PLY body ended before all vertices were read');
      continue;
    }

    const values = line.split(/\s+/).map(Number);
    if (values.length < propertyNames.length) {
      throw new Error(`PLY ascii row ${i} has ${values.length} values, expected ${propertyNames.length}`);
    }
    rows.push(values);
  }

  return rows;
}

/**
 * Decode a 3D Gaussian Splatting PLY into a SplatCloud.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @param {Object} [options]
 * @param {number} [options.maxShDegree] drop SH bands above this degree
 * @returns {import('./splat-cloud.js').SplatCloud}
 */
export function readGaussianSplatPly(input, options = {}) {
  const { maxShDegree } = options;
  const bytes = toUint8Array(input);
  const { headerText, bodyOffset } = splitPlyHeader(bytes);
  const { format, elements } = parsePlyHeader(headerText);

  const vertex = elements.find((element) => element.name === 'vertex');
  if (!vertex) throw new UnsupportedPlyVariantError('PLY has no vertex element', 'no-vertex-element');
  if (vertex.properties.some((property) => property.isList)) {
    throw new UnsupportedPlyVariantError(
      'PLY vertex element uses list properties, which 3DGS exports never do.',
      'list-properties',
    );
  }

  const propertyNames = vertex.properties.map((property) => property.name);
  assertSplatProperties(propertyNames);

  const sourceShDegree = detectShDegree(propertyNames);
  const shDegree = resolveShDegree(sourceShDegree, maxShDegree);
  // The stride into f_rest is set by what the file holds, not by what is kept,
  // so this stays the source count even when bands are dropped.
  const restPropertyCount = propertyNames.filter((name) => /^f_rest_\d+$/.test(name)).length;
  const cloud = createSplatCloud(vertex.count, shDegree);
  cloud.sourceFormat = 'ply';
  cloud.sourceShDegree = sourceShDegree;

  const indexOf = new Map(propertyNames.map((name, index) => [name, index]));
  const restIndices = [];
  for (let degree = 1; degree <= shDegree; degree++) {
    restIndices.push(...shRestIndices(degree, restPropertyCount));
  }
  const restColumns = restIndices.map((restIndex) => indexOf.get(`f_rest_${restIndex}`));
  if (restColumns.some((column) => column === undefined)) {
    throw new UnsupportedPlyVariantError(
      'PLY f_rest_* properties are not contiguous, so SH bands cannot be mapped.',
      'sparse-f-rest',
    );
  }

  const readRow = createRowReader(bytes, bodyOffset, format, vertex, propertyNames);

  const columns = {
    x: indexOf.get('x'), y: indexOf.get('y'), z: indexOf.get('z'),
    opacity: indexOf.get('opacity'),
    scale0: indexOf.get('scale_0'), scale1: indexOf.get('scale_1'), scale2: indexOf.get('scale_2'),
    rot0: indexOf.get('rot_0'), rot1: indexOf.get('rot_1'),
    rot2: indexOf.get('rot_2'), rot3: indexOf.get('rot_3'),
    fdc0: indexOf.get('f_dc_0'), fdc1: indexOf.get('f_dc_1'), fdc2: indexOf.get('f_dc_2'),
  };

  const restStride = restColumns.length;

  for (let i = 0; i < vertex.count; i++) {
    const row = readRow(i);

    cloud.positions[i * 3] = row[columns.x];
    cloud.positions[i * 3 + 1] = row[columns.y];
    cloud.positions[i * 3 + 2] = row[columns.z];

    cloud.scales[i * 3] = Math.exp(row[columns.scale0]);
    cloud.scales[i * 3 + 1] = Math.exp(row[columns.scale1]);
    cloud.scales[i * 3 + 2] = Math.exp(row[columns.scale2]);

    // PLY stores the quaternion w first; KHR wants xyzw.
    cloud.rotations[i * 4] = row[columns.rot1];
    cloud.rotations[i * 4 + 1] = row[columns.rot2];
    cloud.rotations[i * 4 + 2] = row[columns.rot3];
    cloud.rotations[i * 4 + 3] = row[columns.rot0];
    normalizeQuaternion(cloud.rotations, i * 4);

    cloud.opacities[i] = sigmoid(row[columns.opacity]);

    cloud.sh0[i * 3] = row[columns.fdc0];
    cloud.sh0[i * 3 + 1] = row[columns.fdc1];
    cloud.sh0[i * 3 + 2] = row[columns.fdc2];

    if (cloud.shRest) {
      for (let j = 0; j < restStride; j++) {
        cloud.shRest[i * restStride + j] = row[restColumns[j]];
      }
    }
  }

  return cloud;
}

function createRowReader(bytes, bodyOffset, format, vertex, propertyNames) {
  if (format === 'ascii') {
    const rows = readAsciiBody(bytes, bodyOffset, vertex, propertyNames);
    return (index) => rows[index];
  }

  const littleEndian = format === 'binary_little_endian';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let stride = 0;
  const readers = vertex.properties.map((property) => {
    const descriptor = SCALAR_TYPES.get(property.type);
    if (!descriptor) throw new Error(`Unsupported PLY property type: ${property.type}`);
    const offset = stride;
    stride += descriptor.size;
    return (base) => descriptor.read(view, base + offset, littleEndian);
  });

  const required = bodyOffset + stride * vertex.count;
  if (required > bytes.byteLength) {
    throw new Error(
      `PLY body is truncated: need ${required} bytes for ${vertex.count} vertices, file has ${bytes.byteLength}`,
    );
  }

  const row = new Array(readers.length);
  return (index) => {
    const base = bodyOffset + index * stride;
    for (let i = 0; i < readers.length; i++) row[i] = readers[i](base);
    return row;
  };
}
