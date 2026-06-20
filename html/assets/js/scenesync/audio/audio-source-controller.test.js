import assert from 'node:assert/strict';
import test from 'node:test';

import { createAudioSourceController } from './audio-source-controller.js';

class FakeAudio {
  constructor({ duration = 10, currentTime = 0 } = {}) {
    this.currentTime = currentTime;
    this.duration = duration;
    this.loop = false;
    this.paused = true;
    this.playbackRate = 1;
    this.seeking = false;
    this.volume = 1;
    this.seekLog = [];
    this.pauseCount = 0;
    this.playCount = 0;
  }

  play() {
    this.paused = false;
    this.playCount += 1;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.pauseCount += 1;
  }

  load() {}
}

function createHarness({
  audio = new FakeAudio(),
  offset = 0,
  loop = true,
  playbackRate = 1,
  getAnimationSample = null,
  isObjectBeingEdited = () => false,
} = {}) {
  const controller = createAudioSourceController({
    createAudio: () => audio,
    getObjectRuntimeTime: (_objectId, _nowMs, clockState) => clockState?.t ?? 0,
    getAnimationSample,
    isObjectBeingEdited,
  });

  controller.setObjectAudioSources('object-1', {
    default: {
      url: 'https://example.com/audio.mp3',
      state: 'playing',
      loop,
      offset,
      playbackRate,
    },
  });

  return { audio, controller };
}

test('pauses and seeks to the local player timeline while transport is paused', () => {
  const { audio, controller } = createHarness({ offset: 0.5 });

  controller.tick(0, { mode: 'local', t: 4, isPaused: true, rate: 1 });

  assert.equal(audio.paused, true);
  assert.equal(audio.currentTime, 4.5);
  assert.equal(audio.pauseCount, 1);
});

test('treats zero transport rate as paused', () => {
  const { audio, controller } = createHarness();

  controller.tick(0, { mode: 'local', t: 6, isPaused: false, rate: 0 });

  assert.equal(audio.paused, true);
  assert.equal(audio.currentTime, 6);
});

test('does not seek host-follow epoch seconds even after audio duration is known', () => {
  const { audio, controller } = createHarness({
    audio: new FakeAudio({ duration: 10, currentTime: 1.25 }),
  });

  controller.tick(0, {
    mode: 'host-follow',
    t: 1_780_000_000,
    isPaused: false,
    rate: 1,
  });

  assert.equal(audio.currentTime, 1.25);
  assert.equal(audio.paused, false);
});

test('updates paused audio immediately when the player timeline seeks', () => {
  const { audio, controller } = createHarness();

  controller.tick(0, { mode: 'local', t: 2, isPaused: true, rate: 1 });
  assert.equal(audio.currentTime, 2);

  controller.tick(100, { mode: 'local', t: 8, isPaused: true, rate: 1 });
  assert.equal(audio.paused, true);
  assert.equal(audio.currentTime, 8);
});

test('does not freeze edited audio while player transport is active', () => {
  let seenClockState = null;
  const { audio, controller } = createHarness({
    isObjectBeingEdited: (_objectId, clockState) => {
      seenClockState = clockState;
      return !clockState?.transportActive;
    },
  });

  controller.tick(0, {
    mode: 'local',
    t: 3,
    isPaused: false,
    rate: 1,
    transportActive: true,
  });

  assert.equal(seenClockState?.transportActive, true);
  assert.equal(audio.paused, false);
  assert.equal(audio.pauseCount, 0);
  assert.equal(audio.currentTime, 3);
});

test('resyncs audio to animation position after deselect in host-follow mode', () => {
  // Simulate: object was selected (isObjectBeingEdited=true) which forced audio.currentTime=0,
  // then deselected. In host-follow mode getTimelineTargetTime returns null (epoch >> 3600),
  // so audio must fall back to the GLB animation's current time.
  let editing = true;
  const animTime = { value: 7.3 };
  const audio = new FakeAudio({ duration: 10, currentTime: 0 });

  const { controller } = createHarness({
    audio,
    loop: true,
    isObjectBeingEdited: () => editing,
    getAnimationSample: (_objectId) => ({ time: animTime.value, duration: 10 }),
  });

  const hostFollowClock = { mode: 'host-follow', t: 1_780_000_000, isPaused: false, rate: 1 };

  // Tick while selected — audio should stay at 0
  controller.tick(0, hostFollowClock);
  assert.equal(audio.currentTime, 0);

  // Deselect
  editing = false;
  animTime.value = 7.3;

  // First tick after deselect — audio should seek to animation position
  controller.tick(16, hostFollowClock);
  assert.ok(Math.abs(audio.currentTime - 7.3) < 0.001, `expected ~7.3, got ${audio.currentTime}`);
  assert.equal(audio.paused, false);
});

test('does not restart an in-flight media seek during continuous auto sync', () => {
  const audio = new FakeAudio({ duration: 10, currentTime: 1 });
  const { controller } = createHarness({ audio });

  controller.tick(1000, { mode: 'local', t: 1, isPaused: false, rate: 1 });
  audio.currentTime = 0.8;
  audio.seeking = true;

  controller.tick(1100, { mode: 'local', t: 1.1, isPaused: false, rate: 1 });

  assert.equal(audio.currentTime, 0.8);
});

test('does not treat playbackRate progression as repeated timeline jumps', () => {
  const audio = new FakeAudio({ duration: 10, currentTime: 1 });
  const { controller } = createHarness({ audio, playbackRate: 2 });

  controller.tick(1000, { mode: 'local', t: 1, isPaused: false, rate: 1 });
  audio.currentTime = 0.8;
  audio.seeking = true;

  controller.tick(1100, { mode: 'local', t: 1.1, isPaused: false, rate: 1 });

  assert.equal(audio.currentTime, 0.8);
});

test('forces auto seek when the player timeline jumps shortly after a resync', () => {
  const audio = new FakeAudio({ duration: 10, currentTime: 0 });
  const { controller } = createHarness({ audio });

  controller.tick(1000, { mode: 'local', t: 1, isPaused: false, rate: 1 });
  assert.equal(audio.currentTime, 1);

  controller.tick(1100, { mode: 'local', t: 7, isPaused: false, rate: 1 });

  assert.equal(audio.currentTime, 7);
});
