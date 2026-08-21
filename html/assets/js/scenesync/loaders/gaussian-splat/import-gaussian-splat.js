// Entry point for importing Gaussian Splat assets into SceneSync.
//
// SceneSync keeps one internal representation for splats: a GLB carrying
// KHR_gaussian_splatting. PLY and SPZ are accepted as inputs and normalized to
// that GLB here, so the rest of the pipeline (SceneDocument, asset cache,
// export) only ever sees GLB.

import { inspectGaussianSplatGlb } from '../khr-gaussian-splatting.js';
import { readGaussianSplatPly, UnsupportedPlyVariantError } from './ply-splat-reader.js';
import { readGaussianSplatSpz, isGzip, UnsupportedSpzError } from './spz-splat-reader.js';
import { writeGaussianSplatGlb } from './khr-glb-writer.js';

const GLB_MAGIC = 0x46546c67;

export { UnsupportedPlyVariantError, UnsupportedSpzError };

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('Expected ArrayBuffer or typed array');
}

/**
 * Identify a Gaussian Splat container from its leading bytes, falling back to
 * the file extension when the magic is inconclusive.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @param {string} [fileName]
 * @returns {'ply'|'spz'|'glb'|'unknown'}
 */
export function detectSplatFormat(input, fileName = '') {
  const bytes = toUint8Array(input);

  if (bytes.byteLength >= 4) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) === GLB_MAGIC) return 'glb';
  }

  if (bytes.byteLength >= 3 && bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79) {
    return 'ply'; // "ply"
  }

  // SPZ is gzip framed, but so are other things; only claim it when the name
  // agrees or nothing else matched.
  if (isGzip(bytes)) return 'spz';

  const extension = fileName.toLowerCase().split('.').pop();
  if (extension === 'ply' || extension === 'spz' || extension === 'glb') return extension;

  return 'unknown';
}

/**
 * Convert a Gaussian Splat asset to a KHR_gaussian_splatting GLB.
 *
 * A GLB input is validated and passed through untouched, so re-importing an
 * asset SceneSync already produced is lossless.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @param {Object} [options]
 * @param {string} [options.fileName] used for format sniffing and naming
 * @param {'none'|'flip-x-180'} [options.upAxisCorrection]
 * @returns {Promise<{ glb: Uint8Array, cloud: import('./splat-cloud.js').SplatCloud|null, sourceFormat: string, splatCount: number, shDegree: number }>}
 */
export async function importGaussianSplatAsset(input, options = {}) {
  const { fileName = '', upAxisCorrection = 'none', maxShDegree } = options;
  const bytes = toUint8Array(input);
  const format = detectSplatFormat(bytes, fileName);

  if (format === 'glb') {
    const inspection = inspectGaussianSplatGlb(bytes);
    if (!inspection.hasGaussianSplatting) {
      throw new Error('GLB does not contain a KHR_gaussian_splatting primitive');
    }
    if (inspection.errors.length > 0) {
      throw new Error(`Invalid KHR_gaussian_splatting GLB: ${inspection.errors.join('; ')}`);
    }
    return {
      glb: bytes,
      cloud: null,
      sourceFormat: 'glb',
      splatCount: 0,
      shDegree: 0,
    };
  }

  let cloud;
  if (format === 'ply') {
    cloud = readGaussianSplatPly(bytes, { maxShDegree });
  } else if (format === 'spz') {
    cloud = await readGaussianSplatSpz(bytes, { maxShDegree });
  } else {
    throw new Error(
      `Unrecognized Gaussian Splat container${fileName ? ` for ${fileName}` : ''}. `
      + 'Supported inputs are .ply, .spz and KHR_gaussian_splatting .glb.',
    );
  }

  const name = deriveName(fileName);
  const glb = writeGaussianSplatGlb(cloud, {
    name,
    generator: `SceneSync Gaussian Splat importer (${cloud.sourceFormat})`,
    upAxisCorrection,
  });

  return {
    glb,
    cloud,
    sourceFormat: cloud.sourceFormat,
    splatCount: cloud.count,
    shDegree: cloud.shDegree,
    sourceShDegree: cloud.sourceShDegree ?? cloud.shDegree,
  };
}

function deriveName(fileName) {
  if (!fileName) return 'GaussianSplats';
  const base = fileName.split('/').pop().replace(/\.(ply|spz|glb)$/i, '');
  return base || 'GaussianSplats';
}

/**
 * Flatten an import failure into something structuredClone can carry.
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
  if (serialized?.name === 'UnsupportedPlyVariantError') {
    return new UnsupportedPlyVariantError(serialized.message, serialized.variant);
  }
  if (serialized?.name === 'UnsupportedSpzError') {
    return new UnsupportedSpzError(serialized.message, serialized.variant);
  }
  return new Error(serialized?.message || 'Gaussian Splat import failed');
}
