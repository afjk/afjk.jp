import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchMeshBlobWithRetry,
  shouldRetryMeshFetchError,
} from './mesh-blob-fetch.js';

function responseWithBlob({
  status = 200,
  size = 4,
  contentLength = size,
  contentEncoding = null,
} = {}) {
  const headers = new Headers();
  if (contentLength !== null) {
    headers.set('content-length', String(contentLength));
  }
  if (contentEncoding) {
    headers.set('content-encoding', contentEncoding);
  }

  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    async blob() {
      return new Blob([new Uint8Array(size)]);
    },
  };
}

test('retries when the response body read fails after a 200', async () => {
  let calls = 0;
  const result = await fetchMeshBlobWithRetry('https://example.test/blob/model', {
    retryDelaysMs: [0],
    logger: null,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': '4' }),
          async blob() {
            throw new TypeError('network body failed');
          },
        };
      }
      return responseWithBlob({ size: 4 });
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.blob.size, 4);
  assert.equal(result.expectedSize, 4);
});

test('keeps final body read failure metadata after retries are exhausted', async () => {
  let calls = 0;

  await assert.rejects(
    fetchMeshBlobWithRetry('https://example.test/blob/model', {
      retryDelaysMs: [0],
      logger: null,
      fetchImpl: async () => {
        calls++;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': '4' }),
          async blob() {
            throw new TypeError('network body failed');
          },
        };
      },
    }),
    (err) => {
      assert.equal(err.expectedSize, 4);
      assert.equal(err.retryable, true);
      return true;
    }
  );

  assert.equal(calls, 2);
});

test('does not retry expired blobs', async () => {
  let calls = 0;

  await assert.rejects(
    fetchMeshBlobWithRetry('https://example.test/blob/missing', {
      retryDelaysMs: [0],
      logger: null,
      fetchImpl: async () => {
        calls++;
        return responseWithBlob({ status: 404, size: 0, contentLength: 0 });
      },
    }),
    (err) => err.status === 404
  );

  assert.equal(calls, 1);
});

test('retries retryable HTTP failures', async () => {
  let calls = 0;
  const result = await fetchMeshBlobWithRetry('https://example.test/blob/model', {
    retryDelaysMs: [0],
    logger: null,
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? responseWithBlob({ status: 503, size: 0, contentLength: 0 })
        : responseWithBlob({ size: 8 });
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.blob.size, 8);
});

test('treats content-length mismatch as retryable', async () => {
  let calls = 0;
  const result = await fetchMeshBlobWithRetry('https://example.test/blob/model', {
    retryDelaysMs: [0],
    logger: null,
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? responseWithBlob({ size: 3, contentLength: 4 })
        : responseWithBlob({ size: 4, contentLength: 4 });
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.blob.size, 4);
});

test('allows successful responses without content-length', async () => {
  let calls = 0;
  const result = await fetchMeshBlobWithRetry('https://example.test/blob/model', {
    retryDelaysMs: [0],
    logger: null,
    fetchImpl: async () => {
      calls++;
      return responseWithBlob({ size: 7, contentLength: null });
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.blob.size, 7);
  assert.equal(result.expectedSize, null);
});

test('skips size validation for encoded responses', async () => {
  let calls = 0;
  const result = await fetchMeshBlobWithRetry('https://example.test/blob/model', {
    retryDelaysMs: [0],
    logger: null,
    fetchImpl: async () => {
      calls++;
      return responseWithBlob({ size: 12, contentLength: 4, contentEncoding: 'gzip' });
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.blob.size, 12);
  assert.equal(result.expectedSize, null);
});

test('keeps non-retryable client errors non-retryable', () => {
  assert.equal(shouldRetryMeshFetchError({ status: 400 }), false);
  assert.equal(shouldRetryMeshFetchError({ status: 408 }), true);
  assert.equal(shouldRetryMeshFetchError(new TypeError('network failed')), true);
});
