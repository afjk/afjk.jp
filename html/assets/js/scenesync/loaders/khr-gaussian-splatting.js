export const KHR_GAUSSIAN_SPLATTING = 'KHR_gaussian_splatting';

export const KHR_GAUSSIAN_SPLATTING_REQUIRED_ATTRIBUTES = Object.freeze([
  'POSITION',
  'KHR_gaussian_splatting:ROTATION',
  'KHR_gaussian_splatting:SCALE',
  'KHR_gaussian_splatting:OPACITY',
  'KHR_gaussian_splatting:SH_DEGREE_0_COEF_0',
]);

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK_TYPE = 0x4e4f534a;
const GLB_VERSION = 2;
const GLTF_POINTS_MODE = 0;

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('Expected ArrayBuffer or typed array');
}

export function parseGlbJson(input) {
  const bytes = toUint8Array(input);
  if (bytes.byteLength < 20) throw new Error('GLB is too short');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('Invalid GLB magic');
  if (view.getUint32(4, true) !== GLB_VERSION) throw new Error('Only GLB 2.0 is supported');

  const declaredLength = view.getUint32(8, true);
  if (declaredLength > bytes.byteLength || declaredLength < 20) {
    throw new Error('Invalid GLB length');
  }

  let offset = 12;
  while (offset + 8 <= declaredLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > declaredLength) throw new Error('Invalid GLB chunk length');

    if (chunkType === GLB_JSON_CHUNK_TYPE) {
      const jsonBytes = bytes.subarray(chunkStart, chunkEnd);
      const jsonText = new TextDecoder().decode(jsonBytes).replace(/[\u0000\u0020]+$/u, '');
      return JSON.parse(jsonText);
    }
    offset = chunkEnd;
  }

  throw new Error('GLB JSON chunk not found');
}

export function findGaussianSplatPrimitives(gltfJson) {
  const meshes = Array.isArray(gltfJson?.meshes) ? gltfJson.meshes : [];
  const results = [];

  meshes.forEach((mesh, meshIndex) => {
    const primitives = Array.isArray(mesh?.primitives) ? mesh.primitives : [];
    primitives.forEach((primitive, primitiveIndex) => {
      const extension = primitive?.extensions?.[KHR_GAUSSIAN_SPLATTING];
      if (!extension) return;

      const attributes = primitive.attributes || {};
      const missingAttributes = KHR_GAUSSIAN_SPLATTING_REQUIRED_ATTRIBUTES
        .filter((semantic) => !Number.isInteger(attributes[semantic]));

      results.push({
        meshIndex,
        primitiveIndex,
        primitive,
        extension,
        attributes,
        missingAttributes,
        validMode: primitive.mode === GLTF_POINTS_MODE,
        supportedKernel: extension.kernel === 'ellipse',
        supportedColorSpace: extension.colorSpace === 'srgb_rec709_display'
          || extension.colorSpace === 'lin_rec709_display',
        supportedProjection: extension.projection == null || extension.projection === 'perspective',
        supportedSortingMethod: extension.sortingMethod == null || extension.sortingMethod === 'cameraDistance',
      });
    });
  });

  return results;
}

export function inspectGaussianSplatGltf(gltfJson) {
  const primitives = findGaussianSplatPrimitives(gltfJson);
  const extensionsUsed = Array.isArray(gltfJson?.extensionsUsed) ? gltfJson.extensionsUsed : [];
  const extensionsRequired = Array.isArray(gltfJson?.extensionsRequired) ? gltfJson.extensionsRequired : [];
  const warnings = [];
  const errors = [];

  if (primitives.length > 0 && !extensionsUsed.includes(KHR_GAUSSIAN_SPLATTING)) {
    errors.push(`${KHR_GAUSSIAN_SPLATTING} primitive exists but extensionsUsed does not declare it`);
  }

  for (const entry of primitives) {
    const label = `meshes[${entry.meshIndex}].primitives[${entry.primitiveIndex}]`;
    if (!entry.validMode) errors.push(`${label}: mode must be POINTS (0)`);
    if (entry.missingAttributes.length > 0) {
      errors.push(`${label}: missing required attributes: ${entry.missingAttributes.join(', ')}`);
    }
    if (!entry.supportedKernel) warnings.push(`${label}: unknown kernel ${String(entry.extension.kernel)}`);
    if (!entry.supportedColorSpace) warnings.push(`${label}: unknown colorSpace ${String(entry.extension.colorSpace)}`);
    if (!entry.supportedProjection) warnings.push(`${label}: unsupported projection ${String(entry.extension.projection)}`);
    if (!entry.supportedSortingMethod) warnings.push(`${label}: unsupported sortingMethod ${String(entry.extension.sortingMethod)}`);
  }

  return {
    hasGaussianSplatting: primitives.length > 0,
    extensionDeclared: extensionsUsed.includes(KHR_GAUSSIAN_SPLATTING),
    extensionRequired: extensionsRequired.includes(KHR_GAUSSIAN_SPLATTING),
    primitives,
    warnings,
    errors,
    valid: primitives.length > 0 && errors.length === 0,
  };
}

export function inspectGaussianSplatGlb(input) {
  return inspectGaussianSplatGltf(parseGlbJson(input));
}
