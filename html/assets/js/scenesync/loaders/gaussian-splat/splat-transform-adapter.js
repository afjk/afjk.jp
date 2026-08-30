// The one place SceneSync talks to @playcanvas/splat-transform.
//
// Everything about reading a 3DGS file format and writing a
// KHR_gaussian_splatting GLB lives in that library; SceneSync's job is to hand
// it bytes, name the result, and validate what comes back. Keeping the library
// behind this module means a future API change is a change here and nowhere
// else, and that no other SceneSync file has to know a splat format exists.
//
// This module is not loaded by the editor directly: it is the payload of the
// vendored conversion Worker bundle (see
// scripts/build-gaussian-splat-worker.mjs), because pulling splat-transform
// into the editor's own module graph would cost megabytes on every page load.

import {
  MemoryFileSystem,
  MemoryReadFileSystem,
  WebPCodec,
  ZipReadFileSystem,
  createChunkDataPool,
  processSourceBridged,
  readFile,
  writeSource,
} from '@playcanvas/splat-transform';

import { inspectGaussianSplatGlb } from '../khr-gaussian-splatting.js';
import {
  UP_AXIS_ROTATIONS,
  applyGlbAssetMetadata,
  wrapGlbSceneInRotationNode,
} from './glb-root-transform.js';
import {
  SUPPORTED_PLY_ENCODING,
  UnsupportedSplatInputError,
  detectSplatContainer,
  extensionOf,
  readPlyEncoding,
} from './splat-format-detect.js';

/** Formats whose reader exposes several LODs; SceneSync only wants the finest. */
const MULTI_LOD_FORMATS = new Set(['lcc', 'lcc2', 'lod']);

/** Archive members that identify the format of a multi-file capture. */
const ARCHIVE_MANIFESTS = [
  { suffix: 'meta.lcc2', inputFormat: 'lcc2' },
  { suffix: 'meta.lcc', inputFormat: 'lcc' },
  { suffix: 'lod-meta.json', inputFormat: 'lod' },
  { suffix: 'meta.json', inputFormat: 'sog' },
];

const ARCHIVE_SINGLE_FILE_FORMATS = ['ply', 'spz', 'sog', 'splat', 'ksplat'];

/**
 * Point the SOG WebP decoder at an explicit wasm URL.
 *
 * splat-transform resolves `webp.wasm` relative to its own module URL, which
 * stops being right the moment the library is bundled. The Worker bundle calls
 * this with the copy sitting next to it; under Node the default resolution is
 * already correct, so nothing calls it there.
 *
 * @param {string} url
 */
export function configureWebPWasmUrl(url) {
  WebPCodec.wasmUrl = url;
}

/** The highest spherical harmonic degree KHR_gaussian_splatting defines. */
export const MAX_SH_DEGREE = 3;

/**
 * Reject a nonsensical SH cap instead of silently keeping every band.
 *
 * Trimming only runs when the cap is below what the file has, so an
 * out-of-range value would otherwise read as "keep everything" — the caller
 * would get the opposite of a size reduction with no indication why.
 */
function resolveMaxShDegree(value) {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 0 || value > MAX_SH_DEGREE) {
    throw new RangeError(
      `maxShDegree must be an integer between 0 and ${MAX_SH_DEGREE}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new UnsupportedSplatInputError('Gaussian Splatの変換を中止しました', 'aborted');
  }
}

function hasGaussianLayers(availableLayers) {
  return ['position', 'geometric', 'color'].every((layer) => availableLayers.has(layer));
}

/** Shallowest path first, so `scene/meta.lcc2` beats `scene/lod1/meta.lcc2`. */
function byPathDepth(a, b) {
  const depth = a.split('/').length - b.split('/').length;
  return depth !== 0 ? depth : a.length - b.length;
}

/**
 * Work out which member of an archive is the capture to read.
 *
 * @param {string[]} entries
 * @returns {{ filename: string, inputFormat: string }}
 */
export function resolveArchiveEntry(entries) {
  const paths = entries.filter((name) => !name.endsWith('/')).sort(byPathDepth);

  for (const { suffix, inputFormat } of ARCHIVE_MANIFESTS) {
    const match = paths.find((name) => name.toLowerCase().endsWith(suffix));
    if (match) return { filename: match, inputFormat };
  }

  for (const inputFormat of ARCHIVE_SINGLE_FILE_FORMATS) {
    const match = paths.find((name) => extensionOf(name) === inputFormat);
    if (match) return { filename: match, inputFormat };
  }

  // A ZIP reaches the splat importer only after the Scene Sync Export importer
  // has declined it, so this is the last word on the drop and has to name both
  // possibilities.
  throw new UnsupportedSplatInputError(
    'このZIPはScene Sync Exportでも、Gaussian Splatのアーカイブでもありませんでした。'
    + `含まれているファイル: ${paths.slice(0, 8).join(', ') || '(なし)'}`,
    'no-splat-in-archive',
  );
}

/**
 * Open a capture as a splat-transform ChunkSource.
 *
 * Returns the source plus a `dispose` that releases whatever backing the
 * container needed, so the caller has exactly one thing to run in `finally`.
 */
async function openSource(bytes, { fileName, container, inputFormat }) {
  const memoryFs = new MemoryReadFileSystem();

  if (container === 'zip') {
    const archiveName = fileName || 'archive.zip';
    memoryFs.set(archiveName, bytes);
    const archiveSource = await memoryFs.createSource(archiveName);
    const zipFs = new ZipReadFileSystem(archiveSource);
    try {
      const entry = resolveArchiveEntry(await zipFs.list());
      const sources = await readFile({
        filename: entry.filename,
        inputFormat: entry.inputFormat,
        options: lodOptionsFor(entry.inputFormat),
        fileSystem: zipFs,
      });
      return {
        source: sources[0],
        sourceFormat: entry.inputFormat,
        dispose: () => zipFs.close(),
      };
    } catch (error) {
      zipFs.close();
      throw error;
    }
  }

  // An LCC manifest on its own describes chunk files that are not here. Say so,
  // rather than letting the reader fail on the first missing chunk.
  if (MULTI_LOD_FORMATS.has(inputFormat)) {
    throw new UnsupportedSplatInputError(
      `${fileName || `meta.${inputFormat}`} は目次だけのファイルで、`
      + 'splatの実体は同じフォルダにあるチャンクに入っています。'
      + 'フォルダごとzipに固めてドロップしてください。',
      'incomplete-lcc',
    );
  }

  // splat-transform picks its reader from the filename, so give it one whose
  // extension matches the format we detected rather than whatever was dropped.
  const readName = `capture.${inputFormat}`;
  memoryFs.set(readName, bytes);

  const sources = await readFile({
    filename: readName,
    inputFormat,
    options: lodOptionsFor(inputFormat),
    fileSystem: memoryFs,
  });

  return { source: sources[0], sourceFormat: inputFormat, dispose: () => {} };
}

function lodOptionsFor(inputFormat) {
  return MULTI_LOD_FORMATS.has(inputFormat) ? { lodSelect: [0] } : {};
}

/**
 * Convert a Gaussian Splat capture into a KHR_gaussian_splatting GLB.
 *
 * A GLB input is validated and passed through untouched: splat-transform has no
 * GLB reader, and re-encoding SceneSync's own output would only lose fidelity.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @param {Object} [options]
 * @param {string} [options.fileName] used for format sniffing and error text
 * @param {0|1|2|3} [options.maxShDegree] drop SH bands above this degree
 * @param {'none'|'flip-x-180'} [options.upAxisCorrection]
 * @param {{ copyright?: string|null, extras?: Object }} [options.glbAssetMetadata]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ glb: Uint8Array, splatCount: number, shDegree: number, sourceShDegree: number, sourceFormat: string }>}
 */
export async function convertGaussianSplatToGlb(input, options = {}) {
  const {
    fileName = '',
    maxShDegree,
    upAxisCorrection = 'none',
    glbAssetMetadata = null,
    signal = null,
  } = options;

  const shCap = resolveMaxShDegree(maxShDegree);

  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const detected = detectSplatContainer(bytes, fileName);

  if (detected.container === 'glb') {
    return passThroughGlb(bytes, glbAssetMetadata);
  }

  if (detected.container === 'unknown') {
    throw new UnsupportedSplatInputError(
      `Gaussian Splatとして認識できませんでした${fileName ? `: ${fileName}` : ''}。`
      + '対応形式は .ply / .spz / .sog / .lcc2 / .lcc / .splat / .ksplat と、'
      + 'それらを含む .zip です。',
      'unknown-format',
    );
  }

  if (detected.inputFormat === 'ply') assertSupportedPlyEncoding(bytes);

  throwIfAborted(signal);

  const opened = await openSource(bytes, {
    fileName,
    container: detected.container,
    inputFormat: detected.inputFormat,
  });

  // The pool has to allocate whatever the source hands it, so it takes the
  // source's own chunk granularity. The GLB writer has no streaming path yet
  // and materializes a chunk at a time into one table, so a smaller pool would
  // simply be rejected rather than saving anything.
  const pool = createChunkDataPool({ chunkSize: opened.source.meta.chunkSize });

  let source = opened.source;
  const sourceShDegree = source.meta.shBands;

  try {
    if (!hasGaussianLayers(source.meta.availableLayers)) {
      throw new UnsupportedSplatInputError(
        'このファイルはGaussian Splatではないようです（通常の点群かメッシュ）。'
        + '3DGSの学習結果を書き出したファイルを使用してください。',
        'not-gaussian-splat',
      );
    }
    if (source.meta.numGaussians === 0) {
      throw new UnsupportedSplatInputError('splatが1つも含まれていません。', 'empty');
    }

    throwIfAborted(signal);

    // Trimming SH is lossy, so it only ever happens when asked for. Reducing to
    // the degree the file already has would be a no-op pass over every splat.
    if (shCap !== null && shCap < sourceShDegree) {
      source = await processSourceBridged(
        source,
        [{ kind: 'filterBands', value: shCap }],
        pool,
        {},
      );
    }

    throwIfAborted(signal);

    // Read after processing: filtering can change both.
    const splatCount = source.meta.numGaussians;
    const shDegree = source.meta.shBands;

    const outputFs = new MemoryFileSystem();
    await writeSource({
      filename: 'converted.glb',
      outputFormat: 'glb',
      source,
      pool,
      options: {},
    }, outputFs);

    let glb = outputFs.results.get('converted.glb');
    if (!glb) throw new Error('splat-transform produced no GLB output');

    const rotation = UP_AXIS_ROTATIONS[upAxisCorrection];
    if (rotation) glb = wrapGlbSceneInRotationNode(glb, rotation);
    if (glbAssetMetadata) glb = applyGlbAssetMetadata(glb, glbAssetMetadata);

    assertUsableKhrGlb(glb);

    return {
      glb,
      splatCount,
      shDegree,
      sourceShDegree,
      sourceFormat: opened.sourceFormat,
    };
  } finally {
    // The bridged source owns whatever it wrapped, so closing the last one in
    // the chain is enough — and it is the only one that must not be skipped.
    await source.close().catch(() => {});
    pool.destroy();
    opened.dispose();
  }
}

/**
 * Refuse a PLY encoding splat-transform would misread.
 *
 * Its reader decodes every record as little-endian binary whatever the header
 * says, so an ASCII or big-endian PLY comes back as zeroed splats rather than
 * an error. Every 3DGS trainer writes `binary_little_endian`, so this costs
 * nothing in practice — but silently importing an empty scene would not be
 * something the user could diagnose.
 */
function assertSupportedPlyEncoding(bytes) {
  const encoding = readPlyEncoding(bytes);
  if (encoding === null || encoding === SUPPORTED_PLY_ENCODING) return;

  throw new UnsupportedSplatInputError(
    `${encoding} 形式のPLYには対応していません。`
    + `${SUPPORTED_PLY_ENCODING}（3DGSの学習結果が標準で出力する形式）で書き出してください。`,
    'unsupported-ply-encoding',
  );
}

function passThroughGlb(bytes, glbAssetMetadata = null) {
  const inspection = inspectGaussianSplatGlb(bytes);
  if (!inspection.hasGaussianSplatting) {
    throw new UnsupportedSplatInputError(
      'このGLBにはKHR_gaussian_splattingが含まれていません。',
      'invalid-glb',
    );
  }
  if (inspection.errors.length > 0) {
    throw new UnsupportedSplatInputError(
      `KHR_gaussian_splatting GLBが不正です: ${inspection.errors.join('; ')}`,
      'invalid-glb',
    );
  }

  const primitive = inspection.primitives[0];
  const shDegree = countShDegree(primitive?.attributes || {});
  const glb = glbAssetMetadata ? applyGlbAssetMetadata(bytes, glbAssetMetadata) : bytes;
  if (glb !== bytes) assertUsableKhrGlb(glb);
  return {
    glb,
    splatCount: 0,
    shDegree,
    sourceShDegree: shDegree,
    sourceFormat: 'glb',
  };
}

function countShDegree(attributes) {
  let degree = 0;
  for (let d = 1; d <= 3; d += 1) {
    if (Number.isInteger(attributes[`KHR_gaussian_splatting:SH_DEGREE_${d}_COEF_0`])) degree = d;
  }
  return degree;
}

/** A GLB that fails inspection never reaches SceneSync's ordinary GLB path. */
function assertUsableKhrGlb(glb) {
  let inspection;
  try {
    inspection = inspectGaussianSplatGlb(glb);
  } catch (error) {
    throw new Error(`変換結果のGLBを解析できませんでした: ${error.message}`);
  }
  if (!inspection.valid) {
    const detail = inspection.errors.join('; ') || 'KHR_gaussian_splatting primitive not found';
    throw new Error(`変換結果がKHR_gaussian_splatting GLBとして不正です: ${detail}`);
  }
}

export { UnsupportedSplatInputError };
