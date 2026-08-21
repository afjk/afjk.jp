// File-level entry point for dropping Gaussian Splat captures into SceneSync.
//
// A dropped .ply / .spz is converted to a KHR_gaussian_splatting GLB and handed
// back as a File, so the caller can push it through the ordinary GLB path:
// upload, broadcast, asset cache and SceneDocument all stay unchanged.
//
// Deliberately free of any three.js import so it can be tested in Node.

import {
  UnsupportedPlyVariantError,
  UnsupportedSpzError,
} from './import-gaussian-splat.js';
import { importGaussianSplatAssetPreferringWorker } from './gaussian-splat-worker-import.js';

const GAUSSIAN_SPLAT_EXTENSIONS = /\.(ply|spz)$/i;

/** Conversion holds the whole cloud in memory, so warn before it gets painful. */
export const LARGE_SOURCE_WARNING_BYTES = 64 * 1024 * 1024;

/** Matches the presence server's SCENE_SYNC_MAX_UPLOAD_BYTES default. */
export const MAX_SOURCE_BYTES = 500 * 1024 * 1024;

export function isGaussianSplatFile(file) {
  return !!file && GAUSSIAN_SPLAT_EXTENSIONS.test(file.name || '');
}

/** capture.ply -> capture.glb */
export function gaussianSplatGlbName(fileName) {
  const base = String(fileName || '').replace(GAUSSIAN_SPLAT_EXTENSIONS, '');
  return `${base || 'gaussian-splats'}.glb`;
}

/**
 * Turn an import failure into something worth showing in a toast.
 * Unrecognized errors keep their own message rather than being flattened.
 */
export function describeGaussianSplatImportError(error) {
  if (error instanceof UnsupportedPlyVariantError) {
    switch (error.variant) {
      case 'not-gaussian-splat':
        return 'このPLYはGaussian Splatではないようです（通常の点群かメッシュ）。3DGSの学習結果を書き出したPLYを使用してください。';
      case 'compressed-chunked':
        return '圧縮PLY（SuperSplat / PlayCanvas形式）には未対応です。非圧縮のPLYで書き出してください。';
      case 'list-properties':
        return 'このPLYはlistプロパティを含むため、Gaussian Splatとして読み込めません。';
      case 'sparse-f-rest':
        return 'このPLYはSH係数（f_rest）が不連続なため読み込めません。';
      case 'no-vertex-element':
        return 'このPLYにはvertex要素がありません。';
      default:
        return error.message;
    }
  }

  if (error instanceof UnsupportedSpzError) {
    return error.variant === 'version'
      ? `未対応のSPZバージョンです（${error.message}）。`
      : error.message;
  }

  return error?.message || 'Gaussian Splatの読み込みに失敗しました';
}

/**
 * Convert a dropped Gaussian Splat file into a GLB File.
 *
 * @param {File} file dropped .ply or .spz
 * @param {Object} [options]
 * @param {'none'|'flip-x-180'} [options.upAxisCorrection]
 * @param {(status: { phase: string, file: File, bytes: number }) => void} [options.onProgress]
 * @param {Function} [options.importer] injection point for tests
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ file: File, splatCount: number, shDegree: number, sourceFormat: string, sourceBytes: number }>}
 */
export async function convertGaussianSplatFileToGlb(file, options = {}) {
  const {
    upAxisCorrection = 'none',
    onProgress = null,
    importer = importGaussianSplatAssetPreferringWorker,
    signal = null,
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
