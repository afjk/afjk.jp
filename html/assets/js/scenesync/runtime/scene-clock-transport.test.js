import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeSceneClockDeactivateArgs,
  preserveLocalSceneClockTimeline,
} from './scene-clock-transport.js';

test('deactivate scene clock args preserve existing numeric now calls', () => {
  const result = normalizeSceneClockDeactivateArgs(1234, undefined, () => 9999);

  assert.deepEqual(result, {
    now: 1234,
    preserveLocalTimeline: false,
    resumeLocalTimeline: false,
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
    resumeLocalTimeline: false,
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
    resumeLocalTimeline: false,
  });
});

test('deactivate scene clock args accept resume local timeline option', () => {
  const result = normalizeSceneClockDeactivateArgs(
    { preserveLocalTimeline: true, resumeLocalTimeline: true },
    undefined,
    () => 1357
  );

  assert.deepEqual(result, {
    now: 1357,
    preserveLocalTimeline: true,
    resumeLocalTimeline: true,
  });
});

test('preserved local timeline resumes from paused time when requested', () => {
  const state = {
    mode: 'local',
    paused: true,
    pausedAt: 12.5,
    localTime: 0,
    lastUpdateNow: 100,
  };

  assert.equal(preserveLocalSceneClockTimeline(state, {
    now: 200,
    getSceneClockTime: () => state.pausedAt,
    resume: true,
  }), true);

  assert.equal(state.localTime, 12.5);
  assert.equal(state.lastUpdateNow, 200);
  assert.equal(state.paused, false);
  assert.equal(state.pausedAt, null);
});

test('preserved local timeline can keep paused state when not requested', () => {
  const state = {
    mode: 'local',
    paused: true,
    pausedAt: 4,
    localTime: 0,
    lastUpdateNow: 100,
  };

  assert.equal(preserveLocalSceneClockTimeline(state, {
    now: 300,
    getSceneClockTime: () => state.pausedAt,
    resume: false,
  }), true);

  assert.equal(state.localTime, 4);
  assert.equal(state.lastUpdateNow, 300);
  assert.equal(state.paused, true);
  assert.equal(state.pausedAt, 4);
});
