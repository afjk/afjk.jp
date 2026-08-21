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

const COMPONENTS_PER_TYPE = { SCALAR: 1, VEC3: 3, VEC4: 4 };

/**
 * Copy a contiguous source array straight into the binary chunk.
 * Used for every attribute the SplatCloud already stores in accessor order.
 */
function writeContiguous(source) {
  return (target, floatOffset) => target.set(source, floatOffset);
}

/**
 * Scatter one SH coefficient out of the interleaved shRest array.
 *
 * shRest is [coef0.r, coef0.g, coef0.b, coef1.r, ...] per splat, so each
 * coefficient is a strided slice. Writing it directly into the output avoids a
 * full temporary copy per coefficient, which for a million splats at degree 3
 * is fifteen 12 MB allocations.
 */
function writeShCoefficient(shRest, count, stride, coefIndex) {
  return (target, floatOffset) => {
    for (let i = 0; i < count; i++) {
      const source = i * stride * 3 + coefIndex * 3;
      const destination = floatOffset + i * 3;
      target[destination] = shRest[source];
      target[destination + 1] = shRest[source + 1];
      target[destination + 2] = shRest[source + 2];
    }
  };
}

/**
 * Describe every attribute of a cloud without materializing the SH slices.
 *
 * Each descriptor carries a `write(target, floatOffset)` that emits the
 * attribute into the shared binary chunk, so the writer allocates the payload
 * exactly once.
 *
 * @returns {Array<{ semantic: string, type: string, floatCount: number, write: Function }>}
 */
export function buildSplatAttributes(cloud) {
  const { count } = cloud;

  const attributes = [
    { semantic: 'POSITION', type: 'VEC3', source: cloud.positions },
    { semantic: `${KHR_GAUSSIAN_SPLATTING}:ROTATION`, type: 'VEC4', source: cloud.rotations },
    { semantic: `${KHR_GAUSSIAN_SPLATTING}:SCALE`, type: 'VEC3', source: cloud.scales },
    { semantic: `${KHR_GAUSSIAN_SPLATTING}:OPACITY`, type: 'SCALAR', source: cloud.opacities },
    { semantic: `${KHR_GAUSSIAN_SPLATTING}:SH_DEGREE_0_COEF_0`, type: 'VEC3', source: cloud.sh0 },
  ].map(({ semantic, type, source }) => ({
    semantic,
    type,
    floatCount: count * COMPONENTS_PER_TYPE[type],
    write: writeContiguous(source),
  }));

  if (cloud.shRest && cloud.shDegree > 0) {
    const stride = SH_REST_COEFS_BY_DEGREE[cloud.shDegree];
    let coefIndex = 0;

    for (let degree = 1; degree <= cloud.shDegree; degree++) {
      for (let coef = 0; coef < SH_COEFS_PER_DEGREE[degree]; coef++) {
        attributes.push({
          semantic: `${KHR_GAUSSIAN_SPLATTING}:SH_DEGREE_${degree}_COEF_${coef}`,
          type: 'VEC3',
          floatCount: count * 3,
          write: writeShCoefficient(cloud.shRest, count, stride, coefIndex),
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
  const bufferViews = [];
  const accessors = [];
  const primitiveAttributes = {};

  // Every attribute is float32, so each one is already 4 byte aligned and the
  // layout can be computed up front. Doing so lets the payload be allocated
  // once and written in place instead of being concatenated afterwards.
  let binaryLength = 0;
  const layout = attributes.map(({ semantic, type, floatCount, write }) => {
    const byteOffset = binaryLength;
    binaryLength += floatCount * 4;
    return { semantic, type, floatCount, write, byteOffset };
  });

  const binary = new Uint8Array(binaryLength);
  const floatView = new Float32Array(binary.buffer);

  for (const { semantic, type, floatCount, write, byteOffset } of layout) {
    write(floatView, byteOffset / 4);

    bufferViews.push({ buffer: 0, byteOffset, byteLength: floatCount * 4 });

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
  }

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
