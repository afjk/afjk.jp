// Writer that turns a SplatCloud into a GLB carrying KHR_gaussian_splatting.
//
// SceneSync's internal and interchange representation for Gaussian Splats is a
// GLB with this extension, so every importer funnels through here. The layout
// mirrors scripts/generate-minimal-khr-gaussian-splatting.mjs: one POINTS
// primitive, float32 accessors, one bufferView per attribute.

import {
  SH_COEFS_PER_DEGREE,
  SH_REST_COEFS_BY_DEGREE,
  computePositionBounds,
} from './splat-cloud.js';

export const KHR_GAUSSIAN_SPLATTING = 'KHR_gaussian_splatting';

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const GLB_JSON_CHUNK_TYPE = 0x4e4f534a;
const GLB_BIN_CHUNK_TYPE = 0x004e4942;
const COMPONENT_TYPE_FLOAT = 5126;
const MODE_POINTS = 0;

/** 180 degrees about X, as xyzw. Converts a Y-down source into glTF's Y-up. */
const FLIP_X_180 = [1, 0, 0, 0];

function align4(value) {
  return (value + 3) & ~3;
}

/**
 * Slice one SH coefficient out of the interleaved shRest array.
 * shRest is [coef0.r, coef0.g, coef0.b, coef1.r, ...] per splat.
 */
function extractShCoefficient(shRest, count, stride, coefIndex) {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const base = i * stride * 3 + coefIndex * 3;
    out[i * 3] = shRest[base];
    out[i * 3 + 1] = shRest[base + 1];
    out[i * 3 + 2] = shRest[base + 2];
  }
  return out;
}

/**
 * Build the attribute list for a cloud, degree 0 first then any higher bands.
 * @returns {Array<{ semantic: string, data: Float32Array, type: string }>}
 */
export function buildSplatAttributes(cloud) {
  const attributes = [
    { semantic: 'POSITION', data: cloud.positions, type: 'VEC3' },
    { semantic: `${KHR_GAUSSIAN_SPLATTING}:ROTATION`, data: cloud.rotations, type: 'VEC4' },
    { semantic: `${KHR_GAUSSIAN_SPLATTING}:SCALE`, data: cloud.scales, type: 'VEC3' },
    { semantic: `${KHR_GAUSSIAN_SPLATTING}:OPACITY`, data: cloud.opacities, type: 'SCALAR' },
    { semantic: `${KHR_GAUSSIAN_SPLATTING}:SH_DEGREE_0_COEF_0`, data: cloud.sh0, type: 'VEC3' },
  ];

  if (cloud.shRest && cloud.shDegree > 0) {
    const stride = SH_REST_COEFS_BY_DEGREE[cloud.shDegree];
    let coefIndex = 0;

    for (let degree = 1; degree <= cloud.shDegree; degree++) {
      for (let coef = 0; coef < SH_COEFS_PER_DEGREE[degree]; coef++) {
        attributes.push({
          semantic: `${KHR_GAUSSIAN_SPLATTING}:SH_DEGREE_${degree}_COEF_${coef}`,
          data: extractShCoefficient(cloud.shRest, cloud.count, stride, coefIndex),
          type: 'VEC3',
        });
        coefIndex += 1;
      }
    }
  }

  return attributes;
}

/**
 * Serialize a SplatCloud as a KHR_gaussian_splatting GLB.
 *
 * @param {import('./splat-cloud.js').SplatCloud} cloud
 * @param {Object} [options]
 * @param {string} [options.name] mesh and node name
 * @param {string} [options.generator] asset.generator string
 * @param {'none'|'flip-x-180'} [options.upAxisCorrection]
 *   Neither PLY nor SPZ records which way is up, so no correction is applied by
 *   default. When asked for, the correction is written as a node rotation and
 *   the splat data itself is left byte-faithful.
 * @returns {Uint8Array} GLB bytes
 */
export function writeGaussianSplatGlb(cloud, options = {}) {
  const {
    name = 'GaussianSplats',
    generator = 'SceneSync Gaussian Splat importer',
    upAxisCorrection = 'none',
  } = options;

  if (!cloud || !Number.isInteger(cloud.count)) throw new TypeError('Expected a SplatCloud');
  if (cloud.count === 0) throw new Error('Cannot write a GLB for an empty splat cloud');
  if (upAxisCorrection !== 'none' && upAxisCorrection !== 'flip-x-180') {
    throw new RangeError(`Unknown upAxisCorrection: ${upAxisCorrection}`);
  }

  const attributes = buildSplatAttributes(cloud);
  const binaryParts = [];
  const bufferViews = [];
  const accessors = [];
  const primitiveAttributes = {};
  let binaryLength = 0;

  for (const { semantic, data, type } of attributes) {
    const padding = align4(binaryLength) - binaryLength;
    if (padding > 0) {
      binaryParts.push(new Uint8Array(padding));
      binaryLength += padding;
    }

    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    binaryParts.push(bytes);

    bufferViews.push({ buffer: 0, byteOffset: binaryLength, byteLength: bytes.byteLength });

    const accessor = {
      bufferView: bufferViews.length - 1,
      byteOffset: 0,
      componentType: COMPONENT_TYPE_FLOAT,
      count: cloud.count,
      type,
    };

    if (semantic === 'POSITION') {
      const { min, max } = computePositionBounds(cloud.positions, cloud.count);
      accessor.min = min;
      accessor.max = max;
    }

    primitiveAttributes[semantic] = accessors.length;
    accessors.push(accessor);
    binaryLength += bytes.byteLength;
  }

  const binary = concatBytes(binaryParts, binaryLength);

  const node = { mesh: 0, name };
  if (upAxisCorrection === 'flip-x-180') node.rotation = FLIP_X_180;

  const gltf = {
    asset: { version: '2.0', generator },
    extensionsUsed: [KHR_GAUSSIAN_SPLATTING],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [node],
    meshes: [{
      name,
      primitives: [{
        mode: MODE_POINTS,
        attributes: primitiveAttributes,
        extensions: {
          [KHR_GAUSSIAN_SPLATTING]: {
            kernel: 'ellipse',
            colorSpace: 'srgb_rec709_display',
            projection: 'perspective',
            sortingMethod: 'cameraDistance',
            ...(cloud.antialiased ? { antialiased: true } : {}),
          },
        },
      }],
    }],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews,
    accessors,
  };

  return packGlb(gltf, binary);
}

function concatBytes(parts, totalLength) {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Assemble a GLB 2.0 container from a glTF JSON object and its binary chunk.
 * @returns {Uint8Array}
 */
export function packGlb(gltf, binary) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const paddedJsonLength = align4(jsonBytes.byteLength);
  const paddedBinLength = align4(binary.byteLength);
  const totalLength = 12 + 8 + paddedJsonLength + 8 + paddedBinLength;

  const glb = new Uint8Array(totalLength);
  const view = new DataView(glb.buffer);
  let offset = 0;

  view.setUint32(offset, GLB_MAGIC, true); offset += 4;
  view.setUint32(offset, GLB_VERSION, true); offset += 4;
  view.setUint32(offset, totalLength, true); offset += 4;

  view.setUint32(offset, paddedJsonLength, true); offset += 4;
  view.setUint32(offset, GLB_JSON_CHUNK_TYPE, true); offset += 4;
  glb.set(jsonBytes, offset);
  glb.fill(0x20, offset + jsonBytes.byteLength, offset + paddedJsonLength);
  offset += paddedJsonLength;

  view.setUint32(offset, paddedBinLength, true); offset += 4;
  view.setUint32(offset, GLB_BIN_CHUNK_TYPE, true); offset += 4;
  glb.set(binary, offset);
  // Remaining bytes are already zero, which is the required BIN chunk padding.

  return glb;
}
