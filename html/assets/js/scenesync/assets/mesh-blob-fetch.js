const DEFAULT_MESH_BLOB_FETCH_RETRY_DELAYS_MS = [750];

function waitForMeshRetry(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function readContentLength(headers) {
  const contentEncoding = headers?.get?.('content-encoding');
  if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
    return null;
  }

  const raw = headers?.get?.('content-length');
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function decorateMeshFetchError(error, fields = {}) {
  const err = error instanceof Error ? error : new Error(String(error));
  Object.assign(err, fields);
  return err;
}

export function shouldRetryMeshFetchError(error) {
  const status = Number(error?.status || 0);
  if (status === 404) return false;
  if (error?.retryable === false) return false;
  if (!status) return true;
  return status >= 500 || status === 408 || status === 429;
}

export async function fetchMeshBlobWithRetry(url, options = {}) {
  const {
    objectId = null,
    meshPath = null,
    retryDelaysMs = DEFAULT_MESH_BLOB_FETCH_RETRY_DELAYS_MS,
    fetchImpl = globalThis.fetch,
    logger = console,
    signal,
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchMeshBlobWithRetry requires fetch');
  }

  let lastError = null;
  const maxAttemptIndex = retryDelaysMs.length;

  for (let attemptIndex = 0; attemptIndex <= maxAttemptIndex; attemptIndex++) {
    if (attemptIndex > 0) {
      await waitForMeshRetry(retryDelaysMs[attemptIndex - 1]);
    }

    try {
      const response = await fetchImpl(url, { cache: 'no-store', signal });
      const expectedSize = readContentLength(response.headers);

      if (!response.ok) {
        throw decorateMeshFetchError(
          new Error(`HTTP ${response.status} loading mesh`),
          {
            status: response.status,
            expectedSize,
            retryable: shouldRetryMeshFetchError({ status: response.status }),
          }
        );
      }

      try {
        const blob = await response.blob();
        if (expectedSize !== null && blob.size !== expectedSize) {
          throw decorateMeshFetchError(
            new Error(`Mesh blob size mismatch: expected ${expectedSize}, got ${blob.size}`),
            {
              expectedSize,
              actualSize: blob.size,
              retryable: true,
            }
          );
        }
        return { blob, expectedSize };
      } catch (blobErr) {
        throw decorateMeshFetchError(blobErr, {
          expectedSize,
          retryable: true,
        });
      }
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
      if (!shouldRetryMeshFetchError(err) || attemptIndex >= maxAttemptIndex) {
        throw err;
      }

      logger?.warn?.('[SceneSync] Mesh fetch failed; retrying', {
        objectId,
        meshPath,
        attempt: attemptIndex + 1,
        maxAttempts: maxAttemptIndex + 1,
        status: err?.status || null,
        expectedSize: err?.expectedSize || null,
        error: err?.message || String(err),
      });
    }
  }

  throw lastError || new Error('Mesh fetch failed');
}
