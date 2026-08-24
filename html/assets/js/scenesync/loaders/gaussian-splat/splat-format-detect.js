// Which Gaussian Splat container SceneSync was handed, and what to call it.
//
// Deliberately free of any dependency on @playcanvas/splat-transform: the main
// thread needs to recognise a dropped file (to decide whether to route it into
// the converter at all) without pulling the multi-megabyte conversion bundle
// into the editor's module graph.

/** Single-file containers SceneSync accepts as a Gaussian Splat drop. */
export const SPLAT_INPUT_EXTENSIONS = Object.freeze([
  'ply', 'spz', 'sog', 'lcc2', 'lcc', 'splat', 'ksplat', 'zip',
]);

const EXTENSION_PATTERN = new RegExp(`\\.(${SPLAT_INPUT_EXTENSIONS.join('|')})$`, 'i');

const GLB_MAGIC = 0x46546c67;

/**
 * A splat input SceneSync cannot use, with enough structure for the UI to say
 * something more helpful than the underlying library's message.
 */
export class UnsupportedSplatInputError extends Error {
  constructor(message, variant = 'unknown') {
    super(message);
    this.name = 'UnsupportedSplatInputError';
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

/** File extension, lower-cased, without the dot. */
export function extensionOf(fileName) {
  const base = String(fileName || '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function isZipArchive(bytes) {
  return bytes.byteLength >= 4
    && bytes[0] === 0x50 && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

export function isGzip(bytes) {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isGlb(bytes) {
  if (bytes.byteLength < 4) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true) === GLB_MAGIC;
}

function startsWithAscii(bytes, text) {
  if (bytes.byteLength < text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Classify a dropped file.
 *
 * `container` says how to open it: `raw` hands the bytes to splat-transform
 * directly, `zip` means the real input lives inside an archive and the entry
 * has to be located first, `glb` is already SceneSync's own interchange format.
 *
 * `inputFormat` is splat-transform's own format name, or `null` when it can
 * only be settled by looking inside the archive.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @param {string} [fileName]
 * @returns {{ container: 'raw'|'zip'|'glb'|'unknown', inputFormat: string|null, extension: string }}
 */
export function detectSplatContainer(input, fileName = '') {
  const bytes = toUint8Array(input);
  const extension = extensionOf(fileName);

  if (isGlb(bytes)) return { container: 'glb', inputFormat: 'glb', extension };
  if (startsWithAscii(bytes, 'ply')) return { container: 'raw', inputFormat: 'ply', extension };

  if (isZipArchive(bytes)) {
    // A .sog bundle is a zip too, but splat-transform mounts it itself.
    if (extension === 'sog') return { container: 'raw', inputFormat: 'sog', extension };
    return { container: 'zip', inputFormat: null, extension };
  }

  // SPZ v1-v3 is a gzip envelope; v4 exposes its NGSP magic directly.
  if (isGzip(bytes) || startsWithAscii(bytes, 'NGSP')) {
    return { container: 'raw', inputFormat: 'spz', extension };
  }

  switch (extension) {
    case 'ply':
    case 'spz':
    case 'sog':
    case 'lcc2':
    case 'lcc':
    case 'splat':
    case 'ksplat':
      return { container: 'raw', inputFormat: extension, extension };
    default:
      return { container: 'unknown', inputFormat: null, extension };
  }
}

/** The only PLY encoding splat-transform's reader actually decodes. */
export const SUPPORTED_PLY_ENCODING = 'binary_little_endian';

/**
 * The encoding declared in a PLY header, or `null` if there is no header line.
 *
 * Only the header is examined — a couple of hundred bytes — because this runs
 * before the file is handed to the converter, purely to reject encodings it
 * would otherwise decode as garbage.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {'ascii'|'binary_little_endian'|'binary_big_endian'|string|null}
 */
export function readPlyEncoding(input) {
  const bytes = toUint8Array(input);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.byteLength, 2048)));
  const match = /^format\s+(\S+)/m.exec(head);
  return match ? match[1] : null;
}

/** Whether a dropped file is worth routing into the Gaussian Splat converter. */
export function isGaussianSplatFileName(fileName) {
  return EXTENSION_PATTERN.test(String(fileName || ''));
}

/** capture.sog -> capture.glb */
export function gaussianSplatGlbName(fileName) {
  const base = String(fileName || '').replace(EXTENSION_PATTERN, '');
  return `${base || 'gaussian-splats'}.glb`;
}

/**
 * Flatten a conversion failure into something structuredClone can carry.
 * Error subclasses do not survive postMessage, so the discriminating fields
 * are copied out explicitly.
 */
export function serializeImportError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    variant: error?.variant ?? null,
  };
}

/** Rebuild the original error class from {@link serializeImportError} output. */
export function reviveImportError(serialized) {
  if (serialized?.name === 'UnsupportedSplatInputError') {
    return new UnsupportedSplatInputError(serialized.message, serialized.variant);
  }
  return new Error(serialized?.message || 'Gaussian Splat import failed');
}
