// Worker entry for Gaussian Splat conversion, and the bundle's public surface.
//
// Conversion is CPU and allocation heavy: a large capture takes seconds and
// holds hundreds of megabytes, which would freeze the editor if it ran on the
// main thread. Both the source bytes and the resulting GLB are transferred
// rather than cloned, so neither crosses the boundary twice.
//
// This file is the entry point of the vendored bundle built by
// scripts/build-gaussian-splat-worker.mjs. It doubles as that bundle's module
// interface: the editor dynamically imports it when a Worker cannot be created
// (module workers unsupported, or worker-src blocked by CSP) and converts
// inline instead. Registering the message handler is therefore conditional —
// importing the bundle on the main thread must not install one.

import {
  configureWebPWasmUrl,
  convertGaussianSplatToGlb,
} from './splat-transform-adapter.js';
import { serializeImportError } from './splat-format-detect.js';

export { convertGaussianSplatToGlb };

// Replaced with `true` by the bundler (see scripts/build-gaussian-splat-worker.mjs).
// Left undefined when the module is loaded from source, as the Node tests do.
// eslint-disable-next-line no-undef
const IS_VENDORED_BUNDLE = typeof __SPLAT_TRANSFORM_BUNDLED__ === 'boolean' && __SPLAT_TRANSFORM_BUNDLED__;

// splat-transform resolves webp.wasm (needed to decode SOG) relative to its own
// module URL, which the bundler flattens away. The build copies the wasm next
// to the bundle, so this is where it is. Unbundled, the library's own default
// is already right.
if (IS_VENDORED_BUNDLE) {
  configureWebPWasmUrl(new URL('./webp.wasm', import.meta.url).href);
}

const isWorkerScope = typeof WorkerGlobalScope !== 'undefined'
  && typeof self !== 'undefined'
  && self instanceof WorkerGlobalScope;

/**
 * Make the GLB its own exact-sized buffer so it can be transferred.
 *
 * splat-transform writes into a growable slab and hands back a view of it, so
 * transferring as-is would move a buffer several times the GLB's size — and
 * leaving it as a view means postMessage structured-clones the bytes instead.
 * Compacting costs one copy either way and lets the slab be collected first.
 */
function compactForTransfer(glb) {
  return glb.byteOffset === 0 && glb.byteLength === glb.buffer.byteLength ? glb : glb.slice();
}

export async function handleConversionMessage(data, post) {
  const { id, arrayBuffer, fileName, upAxisCorrection, maxShDegree } = data || {};

  try {
    const result = await convertGaussianSplatToGlb(arrayBuffer, {
      fileName,
      upAxisCorrection,
      maxShDegree,
    });

    const glb = compactForTransfer(result.glb);
    post({
      id,
      ok: true,
      glb,
      splatCount: result.splatCount,
      shDegree: result.shDegree,
      sourceShDegree: result.sourceShDegree,
      sourceFormat: result.sourceFormat,
    }, [glb.buffer]);
  } catch (error) {
    post({ id, ok: false, error: serializeImportError(error) }, []);
  }
}

if (isWorkerScope) {
  self.addEventListener('message', (event) => {
    handleConversionMessage(event.data, (message, transfer) => self.postMessage(message, transfer));
  });
}
