import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSceneClockDeactivateArgs } from './scene-clock-transport.js';

test('deactivate scene clock args preserve existing numeric now calls', () => {
  const result = normalizeSceneClockDeactivateArgs(1234, undefined, () => 9999);

  assert.deepEqual(result, {
    now: 1234,
    preserveLocalTimeline: false,
  });
});

test('deactivate scene clock args accept options-only calls', () => {
  const result = normalizeSceneClockDeactivateArgs(
    { preserveLocalTimeline: true },
    undefined,
    () => 4321
  );

  assert.deepEqual(result, {
    now: 4321,
    preserveLocalTimeline: true,
  });
});

test('deactivate scene clock args accept numeric now with options', () => {
  const result = normalizeSceneClockDeactivateArgs(
    2468,
    { preserveLocalTimeline: true },
    () => 9999
  );

  assert.deepEqual(result, {
    now: 2468,
    preserveLocalTimeline: true,
  });
});
