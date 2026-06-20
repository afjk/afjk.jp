import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateViewerPlaybackDuration,
  clipTimeForMode,
  createViewerSceneClock,
} from './viewer-scene-clock.js';

test('viewer scene clock supports play, pause, seek, stop, and rate', () => {
  let now = 1000;
  const clock = createViewerSceneClock({ duration: 10, now: () => now });

  assert.deepEqual(clock.getState(), {
    time: 0,
    t: 0,
    delta: 0,
    isPaused: true,
    playing: false,
    mode: 'local',
    rate: 1,
    duration: 10,
    transportActive: false,
  });

  clock.play();
  now += 2500;
  assert.equal(clock.tick().time, 2.5);

  clock.setRate(2);
  now += 1000;
  assert.equal(clock.tick().time, 4.5);

  clock.pause();
  now += 1000;
  assert.equal(clock.tick().time, 4.5);

  clock.seek(8);
  assert.equal(clock.getState().time, 8);

  clock.stop();
  assert.equal(clock.getState().time, 0);
  assert.equal(clock.getState().isPaused, true);
});

test('viewer scene clock clamps to duration and restarts when played from the end', () => {
  let now = 0;
  const clock = createViewerSceneClock({ duration: 3, now: () => now });

  clock.play();
  now = 5000;
  const endState = clock.tick();
  assert.equal(endState.time, 3);
  assert.equal(endState.isPaused, true);

  clock.play();
  assert.equal(clock.getState().time, 0);
  assert.equal(clock.getState().playing, true);
});

test('viewer scene clock can be aligned to media time without emitting transport events', () => {
  let now = 0;
  let changeCount = 0;
  const clock = createViewerSceneClock({ duration: 10, now: () => now });
  clock.onChange(() => { changeCount += 1; });

  clock.play();
  assert.equal(changeCount, 1);

  now = 1000;
  clock.syncPlaybackTime(4, now);

  assert.equal(clock.getState().time, 4);
  assert.equal(clock.getState().playing, true);
  assert.equal(changeCount, 1);

  now = 1500;
  assert.equal(clock.tick().time, 4.5);
});

test('viewer playback duration includes animation and physics durations', () => {
  const duration = calculateViewerPlaybackDuration({
    defaultDuration: 1,
    physicsDuration: 4.25,
    animationEntries: [{
      enabled: true,
      clips: [{ duration: 3 }],
      clipIndex: 0,
      speed: 0.5,
      mode: 'once',
      offset: 1,
    }],
  });

  assert.equal(duration, 4.25);
});

test('viewer clip time wraps loops and clamps once animations', () => {
  assert.equal(clipTimeForMode(3.5, 2, 'loop'), 1.5);
  assert.equal(clipTimeForMode(3.5, 2, 'once'), 2);
});
