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
const GLB_BIN_CHUNK_TYPE = 0x004e4942;
const GLB_VERSION = 2;
const GLTF_POINTS_MODE = 0;
const SH_C0 = 0.2820947917738781;

const TYPE_COMPONENTS = Object.freeze({
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
});

const COMPONENT_TYPES = Object.freeze({
  5120: { bytes: 1, read: (view, offset) => view.getInt8(offset), normalize: (v) => Math.max(-1, v / 127) },
  5121: { bytes: 1, read: (view, offset) => view.getUint8(offset), normalize: (v) => v / 255 },
  5122: { bytes: 2, read: (view, offset) => view.getInt16(offset, true), normalize: (v) => Math.max(-1, v / 32767) },
  5123: { bytes: 2, read: (view, offset) => view.getUint16(offset, true), normalize: (v) => v / 65535 },
  5125: { bytes: 4, read: (view, offset) => view.getUint32(offset, true), normalize: null },
  5126: { bytes: 4, read: (view, offset) => view.getFloat32(offset, true), normalize: null },
});

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('Expected ArrayBuffer or typed array');
}

export function parseGlb(input) {
  const bytes = toUint8Array(input);
  if (bytes.byteLength < 20) throw new Error('GLB is too short');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('Invalid GLB magic');
  if (view.getUint32(4, true) !== GLB_VERSION) throw new Error('Only GLB 2.0 is supported');

  const declaredLength = view.getUint32(8, true);
  if (declaredLength > bytes.byteLength || declaredLength < 20) {
    throw new Error('Invalid GLB length');
  }

  let json = null;
  let binaryChunk = null;
  let offset = 12;
  while (offset + 8 <= declaredLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > declaredLength) throw new Error('Invalid GLB chunk length');

    if (chunkType === GLB_JSON_CHUNK_TYPE && json == null) {
      const jsonBytes = bytes.subarray(chunkStart, chunkEnd);
      const jsonText = new TextDecoder().decode(jsonBytes).replace(/[\u0000\u0020]+$/u, '');
      json = JSON.parse(jsonText);
    } else if (chunkType === GLB_BIN_CHUNK_TYPE && binaryChunk == null) {
      binaryChunk = bytes.subarray(chunkStart, chunkEnd);
    }
    offset = chunkEnd;
  }

  if (!json) throw new Error('GLB JSON chunk not found');
  return { json, binaryChunk };
}

export function parseGlbJson(input) {
  return parseGlb(input).json;
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

function readAccessor({ json, binaryChunk }, accessorIndex) {
  if (!binaryChunk) throw new Error('GLB BIN chunk not found');
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor) throw new Error(`Accessor ${accessorIndex} not found`);
  if (accessor.sparse) throw new Error(`Accessor ${accessorIndex}: sparse accessors are not supported by the 3DGS spike decoder`);
  if (!Number.isInteger(accessor.bufferView)) throw new Error(`Accessor ${accessorIndex}: bufferView is required`);

  const bufferView = json.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new Error(`Accessor ${accessorIndex}: bufferView ${accessor.bufferView} not found`);
  if ((bufferView.buffer ?? 0) !== 0) throw new Error(`Accessor ${accessorIndex}: only GLB buffer 0 is supported`);

  const component = COMPONENT_TYPES[accessor.componentType];
  if (!component) throw new Error(`Accessor ${accessorIndex}: unsupported componentType ${accessor.componentType}`);
  const componentCount = TYPE_COMPONENTS[accessor.type];
  if (!componentCount) throw new Error(`Accessor ${accessorIndex}: unsupported accessor type ${accessor.type}`);

  const elementSize = component.bytes * componentCount;
  const stride = bufferView.byteStride || elementSize;
  if (stride < elementSize) throw new Error(`Accessor ${accessorIndex}: invalid byteStride ${stride}`);

  const baseOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
  const viewStart = bufferView.byteOffset || 0;
  const viewEnd = viewStart + bufferView.byteLength;
  const requiredEnd = baseOffset + Math.max(0, accessor.count - 1) * stride + elementSize;
  if (baseOffset < viewStart || requiredEnd > viewEnd || requiredEnd > binaryChunk.byteLength) {
    throw new Error(`Accessor ${accessorIndex}: data range exceeds bufferView`);
  }

  const view = new DataView(binaryChunk.buffer, binaryChunk.byteOffset, binaryChunk.byteLength);
  const values = new Array(accessor.count);
  for (let i = 0; i < accessor.count; i++) {
    const element = new Array(componentCount);
    const elementOffset = baseOffset + i * stride;
    for (let c = 0; c < componentCount; c++) {
      const raw = component.read(view, elementOffset + c * component.bytes);
      element[c] = accessor.normalized && component.normalize ? component.normalize(raw) : raw;
    }
    values[i] = element;
  }
  return { accessor, values };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function diffuseColorFromSh0(sh0) {
  return sh0.map((coefficient) => clamp01(coefficient * SH_C0 + 0.5));
}

export function decodeGaussianSplatGlb(input) {
  const parsed = parseGlb(input);
  const inspection = inspectGaussianSplatGltf(parsed.json);
  if (!inspection.valid) {
    throw new Error(`Invalid KHR_gaussian_splatting GLB: ${inspection.errors.join('; ')}`);
  }

  const primitives = inspection.primitives.map((entry) => {
    const attrs = entry.attributes;
    const position = readAccessor(parsed, attrs.POSITION);
    const rotation = readAccessor(parsed, attrs['KHR_gaussian_splatting:ROTATION']);
    const scale = readAccessor(parsed, attrs['KHR_gaussian_splatting:SCALE']);
    const opacity = readAccessor(parsed, attrs['KHR_gaussian_splatting:OPACITY']);
    const sh0 = readAccessor(parsed, attrs['KHR_gaussian_splatting:SH_DEGREE_0_COEF_0']);

    const count = position.accessor.count;
    for (const [name, decoded] of [['rotation', rotation], ['scale', scale], ['opacity', opacity], ['sh0', sh0]]) {
      if (decoded.accessor.count !== count) {
        throw new Error(`KHR_gaussian_splatting ${name} accessor count does not match POSITION`);
      }
    }

    const splats = new Array(count);
    for (let i = 0; i < count; i++) {
      const opacityValue = opacity.values[i][0];
      if (opacityValue < 0 || opacityValue > 1) throw new Error(`Splat ${i}: opacity is outside [0, 1]`);
      if (scale.values[i].some((value) => value < 0)) throw new Error(`Splat ${i}: scale contains a negative value`);

      splats[i] = {
        position: position.values[i],
        rotation: rotation.values[i],
        scale: scale.values[i],
        opacity: opacityValue,
        sh0: sh0.values[i],
        color: diffuseColorFromSh0(sh0.values[i]),
      };
    }

    return {
      meshIndex: entry.meshIndex,
      primitiveIndex: entry.primitiveIndex,
      extension: entry.extension,
      splats,
    };
  });

  return { json: parsed.json, inspection, primitives };
}
