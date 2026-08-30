// File-level entry point for dropping Gaussian Splat captures into SceneSync.
//
// A dropped capture is converted to a KHR_gaussian_splatting GLB and handed
// back as a File, so the caller can push it through the ordinary GLB path:
// upload, broadcast, asset cache and SceneDocument all stay unchanged.
//
// Nothing here knows anything about the internals of a splat format — the
// conversion lives in the vendored @playcanvas/splat-transform bundle. This
// module owns what is SceneSync's own: deciding whether a dropped file is a
// candidate at all, enforcing the upload ceiling, naming the result, and
// turning a failure into a sentence worth showing in a toast.

import {
  UnsupportedSplatInputError,
  gaussianSplatGlbName,
  isGaussianSplatFileName,
} from './splat-format-detect.js';
import { importGaussianSplatAssetPreferringWorker } from './gaussian-splat-worker-import.js';

export { gaussianSplatGlbName };

/**
 * Above this, conversion is slow enough that the user deserves a warning first.
 * The Worker keeps the editor responsive, but the GLB still has to be built in
 * memory before it can be handed back.
 */
export const LARGE_SOURCE_WARNING_BYTES = 64 * 1024 * 1024;

/** Matches the presence server's SCENE_SYNC_MAX_UPLOAD_BYTES default. */
export const MAX_SOURCE_BYTES = 500 * 1024 * 1024;

export function isGaussianSplatFile(file) {
  return isGaussianSplatFileName(file?.name);
}

/**
 * Turn an import failure into something worth showing in a toast.
 * Unrecognized errors keep their own message rather than being flattened.
 */
export function describeGaussianSplatImportError(error) {
  if (error instanceof UnsupportedSplatInputError || error?.name === 'UnsupportedSplatInputError') {
    switch (error.variant) {
      case 'not-gaussian-splat':
        return 'このファイルはGaussian Splatではないようです（通常の点群かメッシュ）。3DGSの学習結果を書き出したファイルを使用してください。';
      case 'no-splat-in-archive':
        return `${error.message} LCC2は meta.lcc2 とチャンクを含むフォルダごと圧縮したものをドロップしてください。`;
      case 'empty':
        return 'splatが1つも含まれていないファイルです。';
      case 'unsupported-ply-encoding':
      case 'incomplete-lcc':
        return error.message;
      case 'invalid-glb':
        return `KHR_gaussian_splatting GLBとして読み込めませんでした: ${error.message}`;
      case 'aborted':
        return 'Gaussian Splatの変換を中止しました。';
      default:
        return error.message;
    }
  }

  return error?.message || 'Gaussian Splatの読み込みに失敗しました';
}

/**
 * Convert a dropped Gaussian Splat file into a GLB File.
 *
 * @param {File} file a dropped capture (.ply/.spz/.sog/.lcc2/.lcc/.splat/.ksplat, or a .zip of one)
 * @param {Object} [options]
 * @param {'none'|'flip-x-180'} [options.upAxisCorrection]
 * @param {0|1|2|3} [options.maxShDegree]
 * @param {{ copyright?: string|null, extras?: Object }} [options.glbAssetMetadata]
 * @param {(status: { phase: string, file: File, bytes: number }) => void} [options.onProgress]
 * @param {Function} [options.importer] injection point for tests
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ file: File, splatCount: number, shDegree: number, sourceShDegree: number, sourceFormat: string, sourceBytes: number }>}
 */
export async function convertGaussianSplatFileToGlb(file, options = {}) {
  const {
    upAxisCorrection = 'none',
    onProgress = null,
    importer = importGaussianSplatAssetPreferringWorker,
    signal = null,
    maxShDegree,
    glbAssetMetadata = null,
  } = options;

  if (!isGaussianSplatFile(file)) {
    throw new Error(`Gaussian Splatファイルではありません: ${file?.name || '(no name)'}`);
  }

  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(
      `ファイルが大きすぎます（${formatBytes(file.size)}）。`
      + `${formatBytes(MAX_SOURCE_BYTES)} までのファイルに対応しています。`,
    );
  }

  onProgress?.({ phase: 'reading', file, bytes: file.size });
  const arrayBuffer = await file.arrayBuffer();

  onProgress?.({ phase: 'converting', file, bytes: file.size });
  const result = await importer(arrayBuffer, {
    fileName: file.name,
    upAxisCorrection,
    maxShDegree,
    glbAssetMetadata,
    signal,
    // Only read again if the Worker path fails; the common case never pays for
    // this, and the buffer above has been transferred away by then.
    rereadSource: () => file.arrayBuffer(),
  });

  const glbName = gaussianSplatGlbName(file.name);
  const converted = new File([result.glb], glbName, { type: 'model/gltf-binary' });

  onProgress?.({ phase: 'converted', file: converted, bytes: converted.size });

  return {
    file: converted,
    splatCount: result.splatCount,
    shDegree: result.shDegree,
    sourceShDegree: result.sourceShDegree ?? result.shDegree,
    sourceFormat: result.sourceFormat,
    sourceBytes: file.size,
  };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '不明';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
