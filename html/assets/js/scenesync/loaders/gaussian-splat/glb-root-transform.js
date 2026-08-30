// Rewrites the root transform of a GLB without touching its binary payload.
//
// Up-axis correction for Gaussian Splat captures is expressed as a glTF node
// rotation rather than baked into the splats: the gaussians stay byte-identical
// to what the converter produced, and the correction can be undone later with
// the ordinary Transform gizmo.

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('Expected ArrayBuffer or typed array');
}

/** Split a GLB into its JSON object and its (optional) BIN chunk bytes. */
export function splitGlb(input) {
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
  let bin = null;
  let offset = 12;
  while (offset + 8 <= declaredLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > declaredLength) throw new Error('Invalid GLB chunk length');

    if (chunkType === JSON_CHUNK_TYPE && json === null) {
      const text = new TextDecoder().decode(bytes.subarray(start, end));
      json = JSON.parse(text.replace(/[\u0000\u0020]+$/u, ''));
    } else if (chunkType === BIN_CHUNK_TYPE && bin === null) {
      bin = bytes.subarray(start, end);
    }
    offset = end;
  }

  if (json === null) throw new Error('GLB JSON chunk not found');
  return { json, bin };
}

/** Re-emit a GLB from a JSON object and BIN payload, padding both chunks. */
export function packGlb(json, bin) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadding = (4 - (jsonBytes.byteLength % 4)) % 4;
  const jsonLength = jsonBytes.byteLength + jsonPadding;

  const binBytes = bin && bin.byteLength > 0 ? bin : null;
  const binPadding = binBytes ? (4 - (binBytes.byteLength % 4)) % 4 : 0;
  const binLength = binBytes ? binBytes.byteLength + binPadding : 0;

  const total = 12 + 8 + jsonLength + (binBytes ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, total, true);

  view.setUint32(12, jsonLength, true);
  view.setUint32(16, JSON_CHUNK_TYPE, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLength); // JSON chunks pad with spaces

  if (binBytes) {
    const binChunkStart = 20 + jsonLength;
    view.setUint32(binChunkStart, binLength, true);
    view.setUint32(binChunkStart + 4, BIN_CHUNK_TYPE, true);
    out.set(binBytes, binChunkStart + 8);
  }

  return out;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Add standards-visible copyright text and namespaced Scene Sync extras while
 * preserving the GLB's geometry and any metadata the source already carried.
 */
export function applyGlbAssetMetadata(input, metadata = {}) {
  const copyright = typeof metadata.copyright === 'string' ? metadata.copyright.trim() : '';
  const incomingExtras = isRecord(metadata.extras) ? metadata.extras : null;
  if (!copyright && !incomingExtras) return input;

  const { json, bin } = splitGlb(input);
  const asset = isRecord(json.asset) ? { ...json.asset } : { version: '2.0' };

  if (copyright) {
    const previous = typeof asset.copyright === 'string' ? asset.copyright.trim() : '';
    asset.copyright = previous && previous !== copyright
      ? `${previous}\n${copyright}`
      : copyright;
  }

  if (incomingExtras) {
    const existingExtras = isRecord(asset.extras) ? asset.extras : {};
    const extras = { ...existingExtras, ...incomingExtras };
    if (isRecord(existingExtras.scenesync) && isRecord(incomingExtras.scenesync)) {
      extras.scenesync = { ...existingExtras.scenesync, ...incomingExtras.scenesync };
    }
    asset.extras = extras;
  }

  json.asset = asset;
  return packGlb(json, bin);
}

/**
 * Parent the default scene's roots under a new node carrying `rotation`.
 *
 * Wrapping rather than editing the existing roots keeps whatever transform the
 * converter emitted intact, and leaves a single node to clear if the correction
 * turns out to be wrong.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @param {[number, number, number, number]} rotation glTF quaternion (x, y, z, w)
 * @param {string} [name]
 * @returns {Uint8Array}
 */
export function wrapGlbSceneInRotationNode(input, rotation, name = 'UpAxisCorrection') {
  const { json, bin } = splitGlb(input);

  const scenes = Array.isArray(json.scenes) ? json.scenes : [];
  const sceneIndex = Number.isInteger(json.scene) ? json.scene : 0;
  const scene = scenes[sceneIndex];
  if (!scene || !Array.isArray(scene.nodes) || scene.nodes.length === 0) {
    throw new Error('GLB has no scene nodes to rotate');
  }

  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const wrapperIndex = nodes.length;
  nodes.push({ name, rotation: [...rotation], children: [...scene.nodes] });

  json.nodes = nodes;
  scene.nodes = [wrapperIndex];

  return packGlb(json, bin);
}

/** Quaternions for the up-axis corrections SceneSync offers. */
export const UP_AXIS_ROTATIONS = Object.freeze({
  'flip-x-180': Object.freeze([1, 0, 0, 0]),
  // SuperSplat's official viewer applies this rotation to every published SOG.
  'flip-z-180': Object.freeze([0, 0, 1, 0]),
});
