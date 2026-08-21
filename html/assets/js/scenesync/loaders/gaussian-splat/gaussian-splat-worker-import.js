// Runs the Gaussian Splat conversion in a Worker, with an inline fallback.
//
// A Worker is not always available: module workers need browser support, and a
// restrictive CSP can block worker-src outright. Rather than failing the drop,
// this falls back to converting on the main thread, which is slower to the
// point of freezing but still correct.

import {
  importGaussianSplatAsset,
  reviveImportError,
} from './import-gaussian-splat.js';

const WORKER_URL = new URL('./gaussian-splat-import.worker.js', import.meta.url);

/** Cached so a blocked or unsupported Worker is only probed once per session. */
let workerAvailability = null;

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
    const worker = new Worker(WORKER_URL, { type: 'module' });
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
}

/**
 * Convert in a Worker, transferring the source buffer in and the GLB back out.
 *
 * The Worker is created per conversion and terminated afterwards: startup costs
 * a few milliseconds against seconds of work, and it guarantees the large
 * intermediate buffers are released rather than lingering in a pooled worker.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @param {{ fileName?: string, upAxisCorrection?: string, signal?: AbortSignal }} [options]
 */
export function importGaussianSplatAssetInWorker(arrayBuffer, options = {}) {
  const { fileName = '', upAxisCorrection = 'none', maxShDegree, signal = null } = options;

  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(WORKER_URL, { type: 'module' });
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
          cloud: null,
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
  return error?.name === 'UnsupportedPlyVariantError' || error?.name === 'UnsupportedSpzError';
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
    return importGaussianSplatAsset(arrayBuffer, importOptions);
  }

  try {
    return await importGaussianSplatAssetInWorker(arrayBuffer, importOptions);
  } catch (error) {
    if (isContentError(error) || !rereadSource) throw error;

    console.warn('[gaussian-splat] Worker conversion failed, retrying inline:', error);
    disableWorker();
    return importGaussianSplatAsset(await rereadSource(), importOptions);
  }
}
