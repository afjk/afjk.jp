// Worker that converts a Gaussian Splat capture into a KHR GLB.
//
// Conversion is CPU and allocation heavy: a million splats at SH degree 3 takes
// seconds and holds hundreds of megabytes, which would freeze the editor if it
// ran on the main thread. Both the source bytes and the resulting GLB are
// transferred rather than cloned, so neither crosses the boundary twice.

import { importGaussianSplatAsset, serializeImportError } from './import-gaussian-splat.js';

self.addEventListener('message', async (event) => {
  const { id, arrayBuffer, fileName, upAxisCorrection } = event.data || {};

  try {
    const result = await importGaussianSplatAsset(arrayBuffer, { fileName, upAxisCorrection });

    // packGlb allocates an exact-sized buffer, so the view covers it whole and
    // the buffer can be handed over instead of copied. A GLB passed straight
    // through may instead be a view into the source buffer, which is equally
    // fine to transfer since the worker is done with it.
    const glb = result.glb;
    const transfer = glb.byteOffset === 0 && glb.byteLength === glb.buffer.byteLength
      ? [glb.buffer]
      : [];

    self.postMessage({
      id,
      ok: true,
      glb,
      splatCount: result.splatCount,
      shDegree: result.shDegree,
      sourceFormat: result.sourceFormat,
    }, transfer);
  } catch (error) {
    self.postMessage({ id, ok: false, error: serializeImportError(error) });
  }
});
