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

function createHarness({ audio = new FakeAudio(), offset = 0, loop = true } = {}) {
  const controller = createAudioSourceController({
    createAudio: () => audio,
    getObjectRuntimeTime: (_objectId, _nowMs, clockState) => clockState?.t ?? 0,
  });

  controller.setObjectAudioSources('object-1', {
    default: {
      url: 'https://example.com/audio.mp3',
      state: 'playing',
      loop,
      offset,
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
