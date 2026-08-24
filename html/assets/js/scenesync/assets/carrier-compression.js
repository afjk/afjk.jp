export const SCENE_SYNC_GZIP_CARRIER_ENCODING = 'gzip';
export const DEFAULT_GAUSSIAN_CARRIER_COMPRESSION_MIN_BYTES = 8 * 1024 * 1024;
export const MAX_DECOMPRESSED_CARRIER_BYTES = 500 * 1024 * 1024;

function normalizeEncoding(encoding) {
  if (encoding === undefined || encoding === null || encoding === '' || encoding === 'identity') {
    return null;
  }
  return String(encoding).toLowerCase();
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  const error = new Error('Carrier compression was aborted');
  error.name = 'AbortError';
  throw error;
}

async function collectStreamAsBlob(stream, type, options = {}) {
  const {
    maxBytes = Number.POSITIVE_INFINITY,
    signal = null,
  } = options;
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Decoded carrier exceeds the ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  return new Blob(chunks, { type });
}

/**
 * Losslessly compress a canonical GLB for its temporary presence carrier.
 *
 * The returned encoding is null when compression is unavailable, below the
 * size threshold, or larger than the original. Callers must keep the original
 * GLB for IndexedDB and exports; only the carrier body uses this result.
 */
export async function compressGlbForCarrier(blob, options = {}) {
  if (!(blob instanceof Blob)) {
    throw new TypeError('compressGlbForCarrier requires a Blob');
  }

  const {
    encoding = SCENE_SYNC_GZIP_CARRIER_ENCODING,
    minBytes = DEFAULT_GAUSSIAN_CARRIER_COMPRESSION_MIN_BYTES,
    CompressionStreamCtor = globalThis.CompressionStream,
    signal = null,
  } = options;
  const normalizedEncoding = normalizeEncoding(encoding);

  if (normalizedEncoding === null || blob.size < Math.max(0, Number(minBytes) || 0)) {
    return {
      blob,
      encoding: null,
      compressed: false,
      rawSize: blob.size,
      carrierSize: blob.size,
    };
  }
  if (normalizedEncoding !== SCENE_SYNC_GZIP_CARRIER_ENCODING) {
    throw new Error(`Unsupported SceneSync carrier encoding: ${normalizedEncoding}`);
  }
  if (typeof CompressionStreamCtor !== 'function') {
    return {
      blob,
      encoding: null,
      compressed: false,
      rawSize: blob.size,
      carrierSize: blob.size,
    };
  }

  throwIfAborted(signal);
  const stream = blob.stream().pipeThrough(new CompressionStreamCtor(normalizedEncoding));
  const compressedBlob = await collectStreamAsBlob(stream, 'application/gzip', { signal });
  throwIfAborted(signal);

  if (compressedBlob.size >= blob.size) {
    return {
      blob,
      encoding: null,
      compressed: false,
      rawSize: blob.size,
      carrierSize: blob.size,
    };
  }

  return {
    blob: compressedBlob,
    encoding: normalizedEncoding,
    compressed: true,
    rawSize: blob.size,
    carrierSize: compressedBlob.size,
  };
}

/** Restore a carrier blob to the ordinary model/gltf-binary bytes Three.js expects. */
export async function decompressGlbFromCarrier(blob, options = {}) {
  if (!(blob instanceof Blob)) {
    throw new TypeError('decompressGlbFromCarrier requires a Blob');
  }

  const {
    encoding = null,
    expectedSize = null,
    DecompressionStreamCtor = globalThis.DecompressionStream,
    signal = null,
  } = options;
  const normalizedEncoding = normalizeEncoding(encoding);

  if (normalizedEncoding === null) return blob;
  if (normalizedEncoding !== SCENE_SYNC_GZIP_CARRIER_ENCODING) {
    throw new Error(`Unsupported SceneSync carrier encoding: ${normalizedEncoding}`);
  }
  if (typeof DecompressionStreamCtor !== 'function') {
    throw new Error('This browser cannot decompress SceneSync gzip carrier assets');
  }

  const hasExpectedSize = expectedSize !== null && expectedSize !== undefined;
  const numericExpectedSize = Number(expectedSize);
  const validExpectedSize = hasExpectedSize
    && Number.isFinite(numericExpectedSize)
    && numericExpectedSize >= 0;
  const maxBytes = validExpectedSize
    ? Math.min(numericExpectedSize, MAX_DECOMPRESSED_CARRIER_BYTES)
    : MAX_DECOMPRESSED_CARRIER_BYTES;

  throwIfAborted(signal);
  const stream = blob.stream().pipeThrough(new DecompressionStreamCtor(normalizedEncoding));
  const decoded = await collectStreamAsBlob(stream, 'model/gltf-binary', { maxBytes, signal });
  throwIfAborted(signal);

  if (validExpectedSize && decoded.size !== numericExpectedSize) {
    throw new Error(
      `Decoded carrier size mismatch: expected ${numericExpectedSize}, got ${decoded.size}`,
    );
  }

  return decoded;
}
