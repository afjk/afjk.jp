import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreSelectionLocks } from './selection-locks.js';

test('restoration uses current peers and successfully loaded objects, excluding departed/self connection IDs', () => {
  const peer = { id: 'live', nickname: 'Current name' };
  const hints = { photo: 'live', missing: 'live', departed: 'gone', oldSelf: 'old-self' };
  assert.deepEqual(restoreSelectionLocks(hints, ['photo', 'departed', 'oldSelf'], [peer]), [['photo', peer]]);
  assert.deepEqual(restoreSelectionLocks(hints, ['photo'], []), []);
});
test('legacy and malformed snapshots do not invent persistent locks', () => {
  for (const hints of [undefined, null, [], 'invalid', { photo: { id: 'live' } }]) {
    assert.deepEqual(restoreSelectionLocks(hints, ['photo'], [{ id: 'live' }]), []);
  }
});
