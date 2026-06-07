import assert from 'node:assert/strict';
import test from 'node:test';
import { createExpiredGlbRecovery } from './expired-glb-recovery.js';

test('reports recovery unavailable when no peers can provide the missing GLB', async () => {
  const recovery = createExpiredGlbRecovery({
    assetCache: {},
    fileTransfer: {},
    presenceState: {
      id: 'local-peer',
      peers: [],
    },
    sendHandoff() {
      throw new Error('sendHandoff should not be called without peers');
    },
    async loadGlbBlobForObject() {},
  });

  let failure = null;
  recovery.onRecoveryFailed((event) => {
    failure = event;
  });

  const result = await recovery.handleMissingGlb(
    'object-1',
    'mesh-1',
    1024,
    'asset-1',
    { name: 'Model' }
  );

  assert.equal(result.started, false);
  assert.equal(result.reason, 'no-peers');
  assert.equal(typeof result.requestId, 'string');
  assert.equal(failure.objectId, 'object-1');
  assert.equal(failure.reason, 'no-peers');
  assert.deepEqual(failure.info, { name: 'Model' });
});
