import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLOCK_MODES,
  createClockState,
  getActiveClockTime,
  getObjectAge,
  pauseClockState,
  resumeClockState,
  seekClockState,
  setClockMode,
  setClockRate,
  normalizeSceneClockDeactivateArgs,
  preserveLocalSceneClockTimeline,
} from './scene-clock-transport.js';

test('active clock defaults local preview to local source', () => {
  const state = createClockState({ mode: CLOCK_MODES.LOCAL_PREVIEW, offset: -10 });

  assert.equal(state.source, 'local');
  assert.equal(getActiveClockTime(state, { localNow: 12, roomNow: 100 }), 2);
});

test('shared playback uses room source and offset for seek', () => {
  const state = createClockState({ mode: CLOCK_MODES.SHARED_PLAYBACK });

  assert.equal(state.source, 'room');
  seekClockState(state, 15, { localNow: 1, roomNow: 100 });

  assert.equal(state.offset, -85);
  assert.equal(getActiveClockTime(state, { localNow: 2, roomNow: 101 }), 16);
});

test('pause and resume preserve room-based shared time without following controller local time', () => {
  const state = createClockState({ mode: CLOCK_MODES.SHARED_PLAYBACK });
  seekClockState(state, 20, { roomNow: 100 });

  pauseClockState(state, { roomNow: 105 });
  assert.equal(getActiveClockTime(state, { roomNow: 999 }), 25);

  resumeClockState(state, { roomNow: 110 });
  assert.equal(getActiveClockTime(state, { roomNow: 111 }), 26);
});

test('rate changes preserve current active time', () => {
  const state = createClockState({ mode: CLOCK_MODES.LOCAL_PREVIEW, offset: 0 });
  assert.equal(getActiveClockTime(state, { localNow: 4 }), 4);

  setClockRate(state, 2, { localNow: 4 });

  assert.equal(getActiveClockTime(state, { localNow: 4 }), 4);
  assert.equal(getActiveClockTime(state, { localNow: 5 }), 6);
});

test('room time mode switches source and clears pause', () => {
  const state = createClockState({ mode: CLOCK_MODES.LOCAL_PREVIEW, offset: -5, paused: true, pausedTime: 3 });

  setClockMode(state, CLOCK_MODES.ROOM_TIME, { localNow: 10, roomNow: 100 });

  assert.equal(state.mode, CLOCK_MODES.ROOM_TIME);
  assert.equal(state.source, 'room');
  assert.equal(state.paused, false);
});

test('object age is active time minus epoch and clamps at zero', () => {
  assert.equal(getObjectAge(10, { epochTime: 4 }), 6);
  assert.equal(getObjectAge(2, { epochTime: 4 }), 0);
});

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
