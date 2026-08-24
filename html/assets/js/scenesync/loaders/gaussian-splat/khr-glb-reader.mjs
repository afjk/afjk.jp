// Reads a KHR_gaussian_splatting GLB back into plain arrays, for tests.
//
// The importer's contract is the *content* of the GLB it produces, not the
// intermediate representation that produced it — so the tests decode the file
// with their own accessor reader rather than trusting the converter's own
// view of what it wrote.

import { parseGlbJson } from '../khr-gaussian-splatting.js';
import { splitGlb } from './glb-root-transform.js';

const COMPONENT_TYPES = new Map([
  [5120, { array: Int8Array, size: 1, normalize: (v) => Math.max(v / 127, -1) }],
  [5121, { array: Uint8Array, size: 1, normalize: (v) => v / 255 }],
  [5122, { array: Int16Array, size: 2, normalize: (v) => Math.max(v / 32767, -1) }],
  [5123, { array: Uint16Array, size: 2, normalize: (v) => v / 65535 }],
  [5125, { array: Uint32Array, size: 4, normalize: (v) => v }],
  [5126, { array: Float32Array, size: 4, normalize: (v) => v }],
]);

const COMPONENTS_PER_TYPE = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

/** Read one accessor into a Float32Array, applying `normalized` if set. */
export function readAccessor(json, bin, accessorIndex) {
  const accessor = json.accessors[accessorIndex];
  const componentType = COMPONENT_TYPES.get(accessor.componentType);
  if (!componentType) throw new Error(`Unsupported componentType ${accessor.componentType}`);

  const components = COMPONENTS_PER_TYPE[accessor.type];
  const view = json.bufferViews[accessor.bufferView];
  const byteOffset = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const elementBytes = componentType.size * components;
  const stride = view.byteStride || elementBytes;

  const out = new Float32Array(accessor.count * components);
  for (let i = 0; i < accessor.count; i += 1) {
    const source = new componentType.array(
      bin.buffer.slice(
        bin.byteOffset + byteOffset + i * stride,
        bin.byteOffset + byteOffset + i * stride + elementBytes,
      ),
    );
    for (let c = 0; c < components; c += 1) {
      out[i * components + c] = accessor.normalized
        ? componentType.normalize(source[c])
        : source[c];
    }
  }
  return out;
}

/**
 * Decode the first (and, for SceneSync imports, only) Gaussian Splat primitive.
 *
 * @returns {{ count: number, shDegree: number, position: Float32Array,
 *   rotation: Float32Array, scale: Float32Array, opacity: Float32Array,
 *   sh: Float32Array[], json: Object }}
 */
export function readGaussianSplatGlb(input) {
  const { bin } = splitGlb(input);
  const json = parseGlbJson(input);
  if (!bin) throw new Error('GLB has no BIN chunk');

  const primitive = json.meshes?.[0]?.primitives?.[0];
  const attributes = primitive?.attributes;
  if (!attributes) throw new Error('GLB has no primitive attributes');

  const read = (semantic) => (
    Number.isInteger(attributes[semantic]) ? readAccessor(json, bin, attributes[semantic]) : null
  );

  const position = read('POSITION');
  const count = position.length / 3;

  const sh = [];
  for (let degree = 0; degree <= 3; degree += 1) {
    const coefCount = degree === 0 ? 1 : 2 * degree + 1;
    const band = [];
    for (let coef = 0; coef < coefCount; coef += 1) {
      const values = read(`KHR_gaussian_splatting:SH_DEGREE_${degree}_COEF_${coef}`);
      if (!values) break;
      band.push(values);
    }
    if (band.length === 0) break;
    if (band.length !== coefCount) {
      throw new Error(`SH degree ${degree} has ${band.length} of ${coefCount} coefficients`);
    }
    sh.push(band);
  }

  return {
    count,
    shDegree: Math.max(sh.length - 1, 0),
    position,
    rotation: read('KHR_gaussian_splatting:ROTATION'),
    scale: read('KHR_gaussian_splatting:SCALE'),
    opacity: read('KHR_gaussian_splatting:OPACITY'),
    color: read('COLOR_0'),
    sh,
    json,
  };
}
