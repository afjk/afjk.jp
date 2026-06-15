import test from 'node:test';
import assert from 'node:assert/strict';

import { createObjectAudioController } from './object-audio-controller.js';

class FakeAudio {
  constructor({ duration = 10, currentTime = 0 } = {}) {
    this.currentTime = currentTime;
    this.duration = duration;
    this.loop = false;
    this.muted = false;
    this.paused = true;
    this.playbackRate = 1;
    this.preload = '';
    this.src = '';
    this.volume = 1;
    this.pauseCount = 0;
    this.playCount = 0;
  }

  addEventListener() {}

  load() {}

  pause() {
    this.paused = true;
    this.pauseCount += 1;
  }

  play() {
    this.paused = false;
    this.playCount += 1;
    return Promise.resolve();
  }
}

function createSceneDoc(source = {}) {
  return {
    objects: [{
      id: 'speaker',
      audioSources: {
        default: {
          url: 'https://example.test/audio.mp3',
          state: 'playing',
          loop: true,
          ...source,
        },
      },
    }],
  };
}

function createHarness({
  audio = new FakeAudio(),
  source = {},
  getAnimationSample = null,
} = {}) {
  const controller = createObjectAudioController({
    sceneDoc: createSceneDoc(source),
    resolver: { resolveAsset: () => null },
    createAudio: (url) => {
      audio.src = url;
      return audio;
    },
    getAnimationSample,
    now: () => 1000,
  });
  return { audio, controller };
}

test('seeks object audio to the paused player timeline without playing', () => {
  const { audio, controller } = createHarness({ source: { offset: 0.5 } });

  controller.tick(1000, { t: 4, isPaused: true, playing: false, rate: 1 });

  assert.equal(audio.paused, true);
  assert.equal(audio.currentTime, 4.5);
  assert.equal(audio.playCount, 0);
});

test('plays object audio from the player timeline and applies transport rate', () => {
  const { audio, controller } = createHarness({ source: { playbackRate: 1.25 } });

  controller.tick(1000, { t: 3, isPaused: false, playing: true, rate: 2 });

  assert.equal(audio.paused, false);
  assert.equal(audio.currentTime, 3);
  assert.equal(audio.playbackRate, 2.5);
});

test('resyncs object audio when the player timeline seeks while playing', () => {
  const { audio, controller } = createHarness();

  controller.tick(1000, { t: 1, isPaused: false, playing: true, rate: 1 });
  audio.currentTime = 1.05;

  controller.tick(1100, { t: 7, isPaused: false, playing: true, rate: 1 });

  assert.equal(audio.currentTime, 7);
});

