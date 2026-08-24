import {
  compressGlbForCarrier,
  DEFAULT_GAUSSIAN_CARRIER_COMPRESSION_MIN_BYTES,
} from './carrier-compression.js';

function meshUploadError(response, payload) {
  const error = new Error(payload?.message || `Mesh upload failed: ${response?.status || 'unknown'}`);
  error.status = Number(response?.status || 0) || null;
  return error;
}

async function readUploadErrorPayload(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Prepare and upload a locally imported GLB without making IndexedDB part of
 * the network/broadcast critical path.
 *
 * Large Gaussian captures can take a long time to commit to IndexedDB (or the
 * request can remain pending when several tabs share the database). The
 * renderable object still receives its canonical asset metadata before the
 * upload starts, so a room snapshot can restore it from assetId while the
 * upload is in flight. Cache persistence then proceeds as best effort.
 */
export async function uploadLocalMeshAsset({
  arrayBuffer,
  name = null,
  meshPath,
  blobBase,
  fetchImpl = globalThis.fetch,
  computeAssetId,
  putCachedAsset,
  onAssetPrepared,
  onCacheError,
  onCompressionError,
  onProgress,
  carrierCompression = null,
  carrierCompressionMinBytes = DEFAULT_GAUSSIAN_CARRIER_COMPRESSION_MIN_BYTES,
  compressCarrier = compressGlbForCarrier,
  signal,
} = {}) {
  if (!(arrayBuffer instanceof ArrayBuffer)) {
    throw new TypeError('uploadLocalMeshAsset requires an ArrayBuffer');
  }
  if (!meshPath || !blobBase || typeof fetchImpl !== 'function') {
    throw new Error('uploadLocalMeshAsset requires meshPath, blobBase, and fetch');
  }

  const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
  onProgress?.({ phase: 'asset-id', rawBytes: blob.size });
  let assetId = null;
  try {
    assetId = await computeAssetId?.(arrayBuffer) || null;
  } catch (error) {
    onCacheError?.(error, { phase: 'asset-id' });
  }

  const asset = {
    type: 'mesh',
    source: 'carrier',
    assetId,
    meshPath,
    size: blob.size,
    mime: 'model/gltf-binary',
    originalName: name || null,
  };

  onAssetPrepared?.(asset);

  // Start persistence, but never await it here. Upload completion is what
  // gates cross-player visibility; IndexedDB is only a local recovery layer.
  if (assetId && typeof putCachedAsset === 'function') {
    try {
      Promise.resolve(putCachedAsset({
        assetId,
        meshPath,
        blob,
        source: 'local-file',
      })).catch((error) => onCacheError?.(error, { phase: 'asset-cache' }));
    } catch (error) {
      onCacheError?.(error, { phase: 'asset-cache' });
    }
  }

  let uploadBody = arrayBuffer;
  let uploadMime = 'model/gltf-binary';
  if (carrierCompression) {
    onProgress?.({ phase: 'compressing', rawBytes: blob.size });
    try {
      const compressed = await compressCarrier(blob, {
        encoding: carrierCompression,
        minBytes: carrierCompressionMinBytes,
        signal,
      });
      if (compressed?.encoding && compressed?.blob) {
        uploadBody = compressed.blob;
        uploadMime = compressed.blob.type || 'application/gzip';
        asset.carrierEncoding = compressed.encoding;
        asset.carrierSize = compressed.carrierSize;
        // Refresh the local snapshot now that it knows how the carrier body is encoded.
        onAssetPrepared?.(asset);
      }
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      onCompressionError?.(error, { phase: 'carrier-compression' });
      // Compression is an optimization. A normal GLB upload remains compatible
      // with older peers and must still succeed if the encoder fails.
      uploadBody = arrayBuffer;
      uploadMime = 'model/gltf-binary';
    }
  }

  onProgress?.({
    phase: 'uploading',
    rawBytes: blob.size,
    carrierBytes: Number(asset.carrierSize || blob.size),
    carrierEncoding: asset.carrierEncoding || null,
  });

  const response = await fetchImpl(`${blobBase}/${meshPath}`, {
    method: 'POST',
    headers: { 'Content-Type': uploadMime },
    body: uploadBody,
    signal,
  });

  if (!response.ok) {
    throw meshUploadError(response, await readUploadErrorPayload(response));
  }

  onProgress?.({
    phase: 'uploaded',
    rawBytes: blob.size,
    carrierBytes: Number(asset.carrierSize || blob.size),
    carrierEncoding: asset.carrierEncoding || null,
  });

  return { asset, blob };
}
