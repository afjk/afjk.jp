// Runs the Gaussian Splat conversion in a Worker, with an inline fallback.
//
// Both paths run the same vendored bundle (see
// scripts/build-gaussian-splat-worker.mjs); it is never part of the editor's
// own module graph, so a session that never drops a splat capture never
// downloads it.
//
// A Worker is not always available: module workers need browser support, and a
// restrictive CSP can block worker-src outright. Rather than failing the drop,
// this falls back to converting on the main thread, which is slow to the point
// of freezing but still correct.

import { reviveImportError } from './splat-format-detect.js';

const BUNDLE_URL = new URL(
  '../../../../vendor/splat-transform/3.3.0/gaussian-splat-import.worker.js',
  import.meta.url,
);

/** Cached so a blocked or unsupported Worker is only probed once per session. */
let workerAvailability = null;

/** Cached so the inline fallback downloads the bundle at most once. */
let inlineConverterPromise = null;

export function isWorkerSupported() {
  return typeof Worker === 'function';
}

/**
 * Whether a module Worker can actually be constructed here.
 * CSP failures surface as a throw from the constructor.
 */
export function probeWorkerAvailability() {
  if (workerAvailability !== null) return workerAvailability;
  if (!isWorkerSupported()) {
    workerAvailability = false;
    return workerAvailability;
  }

  try {
    const worker = new Worker(BUNDLE_URL, { type: 'module' });
    worker.terminate();
    workerAvailability = true;
  } catch (error) {
    console.warn('[gaussian-splat] Worker unavailable, converting inline:', error);
    workerAvailability = false;
  }

  return workerAvailability;
}

/** Test seam: forget a cached probe result. */
export function resetWorkerAvailability() {
  workerAvailability = null;
  inlineConverterPromise = null;
}

/**
 * Load the converter for the inline path.
 *
 * Dynamic rather than static so the multi-megabyte bundle stays out of the
 * editor's entry chunk; the Worker path never touches this.
 */
export function loadInlineConverter() {
  if (!inlineConverterPromise) {
    inlineConverterPromise = import(BUNDLE_URL.href)
      .then((module) => module.convertGaussianSplatToGlb);
    inlineConverterPromise.catch(() => { inlineConverterPromise = null; });
  }
  return inlineConverterPromise;
}

/**
 * Convert on the main thread. Correct, but it blocks: only used when a Worker
 * cannot be created or has already failed.
 */
export async function importGaussianSplatAssetInline(arrayBuffer, options = {}) {
  const convert = await loadInlineConverter();
  return convert(arrayBuffer, options);
}

/**
 * Convert in a Worker, transferring the source buffer in and the GLB back out.
 *
 * The Worker is created per conversion and terminated afterwards: startup costs
 * a few milliseconds against seconds of work, and it guarantees the large
 * intermediate buffers are released rather than lingering in a pooled worker.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @param {{ fileName?: string, upAxisCorrection?: string, maxShDegree?: number, signal?: AbortSignal }} [options]
 */
export function importGaussianSplatAssetInWorker(arrayBuffer, options = {}) {
  const { fileName = '', upAxisCorrection = 'none', maxShDegree, signal = null } = options;

  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(BUNDLE_URL, { type: 'module' });
    } catch (error) {
      reject(error);
      return;
    }

    const id = Math.random().toString(36).slice(2);
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      // Terminating is what actually cancels: splat-transform has no cooperative
      // abort, so the surest way to stop the work and release the chunk pool,
      // the decoder state and the output buffer is to drop the whole scope.
      worker.terminate();
      fn(value);
    };

    function onAbort() {
      finish(reject, new Error('Gaussian Splatの変換を中止しました'));
    }

    worker.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.id !== id) return;

      if (data.ok) {
        finish(resolve, {
          glb: data.glb,
          splatCount: data.splatCount,
          shDegree: data.shDegree,
          sourceShDegree: data.sourceShDegree ?? data.shDegree,
          sourceFormat: data.sourceFormat,
        });
      } else {
        finish(reject, reviveImportError(data.error));
      }
    });

    // Fires for module resolution failures and uncaught worker errors alike.
    worker.addEventListener('error', (event) => {
      finish(reject, new Error(event.message || 'Gaussian Splat Workerが失敗しました'));
    });

    signal?.addEventListener('abort', onAbort);

    worker.postMessage({ id, arrayBuffer, fileName, upAxisCorrection, maxShDegree }, [arrayBuffer]);
  });
}

/**
 * True when the failure is the file's fault rather than the Worker's, in which
 * case retrying inline would only reproduce it.
 */
export function isContentError(error) {
  return error?.name === 'UnsupportedSplatInputError';
}

/** Give up on the Worker for the rest of the session. */
export function disableWorker() {
  workerAvailability = false;
}

/**
 * Convert via Worker when possible, otherwise inline.
 *
 * `rereadSource` supplies a fresh ArrayBuffer for the inline retry. The Worker
 * path transfers the source buffer and thereby detaches it, so a retry cannot
 * reuse it — and pre-emptively copying would double peak memory on every
 * import for a fallback that almost never runs.
 *
 * @param {ArrayBuffer} arrayBuffer transferred to the Worker
 * @param {Object} options
 * @param {() => Promise<ArrayBuffer>} options.rereadSource
 */
export async function importGaussianSplatAssetPreferringWorker(arrayBuffer, options = {}) {
  const { rereadSource = null, ...importOptions } = options;

  if (!probeWorkerAvailability()) {
    return importGaussianSplatAssetInline(arrayBuffer, importOptions);
  }

  try {
    return await importGaussianSplatAssetInWorker(arrayBuffer, importOptions);
  } catch (error) {
    if (isContentError(error) || !rereadSource) throw error;

    console.warn('[gaussian-splat] Worker conversion failed, retrying inline:', error);
    disableWorker();
    return importGaussianSplatAssetInline(await rereadSource(), importOptions);
  }
}
