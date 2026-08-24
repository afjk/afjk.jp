import test from 'node:test';
import assert from 'node:assert/strict';

import {
  disableWorker,
  importGaussianSplatAssetInWorker,
  importGaussianSplatAssetPreferringWorker,
  isContentError,
  isWorkerSupported,
  probeWorkerAvailability,
  resetWorkerAvailability,
} from './gaussian-splat-worker-import.js';
import { UnsupportedSplatInputError } from './splat-format-detect.js';
import { buildGaussianSplatPly } from './test-fixtures.mjs';

const SAMPLE = [{
  position: [1, 2, 3],
  scale: [0.1, 0.2, 0.3],
  rotation: [0, 0, 0, 1],
  opacity: 0.75,
  sh0: [1.5, -0.5, 0.25],
}];

function plyBuffer() {
  const bytes = buildGaussianSplatPly(SAMPLE);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * Minimal stand-in for a module Worker. `respond` decides what the fake worker
 * posts back for each message it receives.
 */
function installFakeWorker(respond, { constructorThrows = false } = {}) {
  const created = [];

  class FakeWorker {
    constructor(url, options) {
      if (constructorThrows) throw new Error('blocked by Content-Security-Policy');
      this.url = url;
      this.options = options;
      this.listeners = { message: [], error: [] };
      this.terminated = false;
      created.push(this);
    }

    addEventListener(type, handler) {
      this.listeners[type]?.push(handler);
    }

    removeEventListener(type, handler) {
      const list = this.listeners[type];
      if (list) this.listeners[type] = list.filter((entry) => entry !== handler);
    }

    postMessage(data) {
      queueMicrotask(() => {
        if (this.terminated) return;
        const reply = respond?.(data, this);
        if (reply === undefined) return;
        const type = reply?.__error ? 'error' : 'message';
        const payload = reply?.__error ? reply.__error : { data: reply };
        for (const handler of this.listeners[type]) handler(payload);
      });
    }

    terminate() {
      this.terminated = true;
    }
  }

  globalThis.Worker = FakeWorker;
  resetWorkerAvailability();
  return created;
}

function removeFakeWorker() {
  delete globalThis.Worker;
  resetWorkerAvailability();
}

test('isWorkerSupported reflects the global', () => {
  removeFakeWorker();
  assert.equal(isWorkerSupported(), false);

  installFakeWorker(() => undefined);
  assert.equal(isWorkerSupported(), true);
  removeFakeWorker();
});

test('probeWorkerAvailability reports false when Worker is missing', () => {
  removeFakeWorker();
  assert.equal(probeWorkerAvailability(), false);
});

test('probeWorkerAvailability reports false when the constructor is blocked', () => {
  installFakeWorker(() => undefined, { constructorThrows: true });
  assert.equal(probeWorkerAvailability(), false);
  removeFakeWorker();
});

test('probeWorkerAvailability caches its result', () => {
  const created = installFakeWorker(() => undefined);

  assert.equal(probeWorkerAvailability(), true);
  assert.equal(created.length, 1);
  assert.equal(probeWorkerAvailability(), true);
  assert.equal(created.length, 1, 'second probe must not construct another Worker');

  removeFakeWorker();
});

test('importGaussianSplatAssetInWorker resolves with the worker result', async () => {
  installFakeWorker((message) => ({
    id: message.id,
    ok: true,
    glb: new Uint8Array([1, 2, 3]),
    splatCount: 42,
    shDegree: 2,
    sourceFormat: 'ply',
  }));

  const result = await importGaussianSplatAssetInWorker(plyBuffer(), { fileName: 'a.ply' });

  assert.equal(result.splatCount, 42);
  assert.equal(result.shDegree, 2);
  assert.equal(result.sourceFormat, 'ply');
  assert.deepEqual(Array.from(result.glb), [1, 2, 3]);

  removeFakeWorker();
});

test('importGaussianSplatAssetInWorker terminates the worker when done', async () => {
  const created = installFakeWorker((message) => ({
    id: message.id, ok: true, glb: new Uint8Array([1]), splatCount: 1, shDegree: 0, sourceFormat: 'ply',
  }));

  await importGaussianSplatAssetInWorker(plyBuffer());

  const worker = created[created.length - 1];
  assert.equal(worker.terminated, true);

  removeFakeWorker();
});

test('importGaussianSplatAssetInWorker revives the original error class', async () => {
  installFakeWorker((message) => ({
    id: message.id,
    ok: false,
    error: {
      name: 'UnsupportedSplatInputError',
      message: 'not a splat',
      variant: 'not-gaussian-splat',
    },
  }));

  await assert.rejects(
    () => importGaussianSplatAssetInWorker(plyBuffer()),
    (error) => {
      assert.ok(error instanceof UnsupportedSplatInputError);
      assert.equal(error.variant, 'not-gaussian-splat');
      return true;
    },
  );

  removeFakeWorker();
});

test('importGaussianSplatAssetInWorker rejects on a worker error event', async () => {
  installFakeWorker(() => ({ __error: { message: 'module failed to load' } }));

  await assert.rejects(
    () => importGaussianSplatAssetInWorker(plyBuffer()),
    /module failed to load/,
  );

  removeFakeWorker();
});

test('importGaussianSplatAssetInWorker honours an abort signal', async () => {
  installFakeWorker(() => undefined); // never replies
  const controller = new AbortController();

  const pending = importGaussianSplatAssetInWorker(plyBuffer(), { signal: controller.signal });
  controller.abort();

  await assert.rejects(() => pending, /中止しました/);
  removeFakeWorker();
});

test('preferring-worker converts inline when no Worker exists', async () => {
  removeFakeWorker();

  const result = await importGaussianSplatAssetPreferringWorker(plyBuffer(), {
    fileName: 'inline.ply',
  });

  assert.equal(result.splatCount, 1);
  assert.equal(result.sourceFormat, 'ply');
});

test('preferring-worker does not retry inline for a content error', async () => {
  let workerCalls = 0;
  installFakeWorker((message) => {
    workerCalls += 1;
    return {
      id: message.id,
      ok: false,
      error: { name: 'UnsupportedSplatInputError', message: 'nope', variant: 'not-gaussian-splat' },
    };
  });

  let rereads = 0;
  await assert.rejects(
    () => importGaussianSplatAssetPreferringWorker(plyBuffer(), {
      rereadSource: async () => { rereads += 1; return plyBuffer(); },
    }),
    (error) => error instanceof UnsupportedSplatInputError,
  );

  assert.equal(workerCalls, 1);
  assert.equal(rereads, 0, 'a bad file must not be re-read and re-converted');

  removeFakeWorker();
});

test('preferring-worker retries inline when the worker infrastructure fails', async () => {
  installFakeWorker(() => ({ __error: { message: 'worker exploded' } }));

  let rereads = 0;
  const result = await importGaussianSplatAssetPreferringWorker(plyBuffer(), {
    fileName: 'retry.ply',
    rereadSource: async () => { rereads += 1; return plyBuffer(); },
  });

  assert.equal(rereads, 1);
  assert.equal(result.splatCount, 1);
  assert.equal(result.sourceFormat, 'ply');

  removeFakeWorker();
});

test('preferring-worker stops using the worker after an infrastructure failure', async () => {
  let workerCalls = 0;
  installFakeWorker((message) => {
    workerCalls += 1;
    return { __error: { message: 'worker exploded' } };
  });

  const convert = () => importGaussianSplatAssetPreferringWorker(plyBuffer(), {
    rereadSource: async () => plyBuffer(),
  });

  await convert();
  await convert();

  assert.equal(workerCalls, 1, 'the worker must not be retried once it has failed');

  removeFakeWorker();
});

test('isContentError separates file problems from worker problems', () => {
  assert.equal(isContentError(new UnsupportedSplatInputError('x', 'not-gaussian-splat')), true);
  assert.equal(isContentError(new Error('worker exploded')), false);
});

test('disableWorker forces the inline path', async () => {
  installFakeWorker((message) => ({
    id: message.id, ok: true, glb: new Uint8Array([9]), splatCount: 999, shDegree: 0, sourceFormat: 'ply',
  }));

  disableWorker();
  const result = await importGaussianSplatAssetPreferringWorker(plyBuffer());

  assert.equal(result.splatCount, 1, 'should have converted inline, not via the worker');
  removeFakeWorker();
});
