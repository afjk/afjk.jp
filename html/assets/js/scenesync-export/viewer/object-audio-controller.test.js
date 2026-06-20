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
    this.seeking = false;
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

test('exposes playing timeline audio as the media clock', () => {
  const { audio, controller } = createHarness({ source: { offset: 0.5 } });

  controller.tick(1000, { t: 4, isPaused: false, playing: true, rate: 1, duration: 10 });
  audio.currentTime = 4.25;

  const clockState = controller.getMediaClockState({
    t: 4.5,
    time: 4.5,
    isPaused: false,
    playing: true,
    rate: 1,
    duration: 10,
  });

  assert.equal(clockState.mediaClockActive, true);
  assert.deepEqual(clockState.mediaClockSource, { objectId: 'speaker', name: 'default' });
  assert.equal(clockState.time, 3.75);
  assert.equal(clockState.t, 3.75);

  controller.tick(1100, clockState);
  assert.equal(audio.currentTime, 4.25);
});

test('does not expose event-only or animation-synced audio as the media clock', () => {
  const eventOnly = createHarness({ source: { state: 'stopped' } });
  eventOnly.audio.paused = false;
  eventOnly.audio.currentTime = 2;
  assert.equal(eventOnly.controller.getMediaClockState({
    t: 2,
    isPaused: false,
    playing: true,
    rate: 1,
  }), null);

  const animationSynced = createHarness({
    source: {
      sync: { mode: 'animation', offset: 0 },
    },
    getAnimationSample: () => ({ time: 2, duration: 10 }),
  });
  animationSynced.controller.tick(1000, { t: 2, isPaused: false, playing: true, rate: 1 });
  animationSynced.audio.currentTime = 2;

  assert.equal(animationSynced.controller.getMediaClockState({
    t: 2,
    isPaused: false,
    playing: true,
    rate: 1,
  }), null);
});

test('resyncs object audio when the player timeline seeks while playing', () => {
  const { audio, controller } = createHarness();

  controller.tick(1000, { t: 1, isPaused: false, playing: true, rate: 1 });
  audio.currentTime = 1.05;

  controller.tick(1100, { t: 7, isPaused: false, playing: true, rate: 1 });

  assert.equal(audio.currentTime, 7);
});

test('does not restart an in-flight media seek during continuous auto sync', () => {
  const { audio, controller } = createHarness({
    audio: new FakeAudio({ duration: 10, currentTime: 1 }),
  });

  controller.tick(1000, { t: 1, isPaused: false, playing: true, rate: 1 });
  audio.currentTime = 0.8;
  audio.seeking = true;

  controller.tick(1100, { t: 1.1, isPaused: false, playing: true, rate: 1 });

  assert.equal(audio.currentTime, 0.8);
});

test('does not treat playbackRate progression as repeated timeline jumps', () => {
  const { audio, controller } = createHarness({
    audio: new FakeAudio({ duration: 10, currentTime: 1 }),
    source: { playbackRate: 2 },
  });

  controller.tick(1000, { t: 1, isPaused: false, playing: true, rate: 1 });
  audio.currentTime = 0.8;
  audio.seeking = true;

  controller.tick(1100, { t: 1.1, isPaused: false, playing: true, rate: 1 });

  assert.equal(audio.currentTime, 0.8);
});

test('forces auto seek when the player timeline jumps shortly after a resync', () => {
  const { audio, controller } = createHarness({
    audio: new FakeAudio({ duration: 10, currentTime: 0 }),
  });

  controller.tick(1000, { t: 1, isPaused: false, playing: true, rate: 1 });
  assert.equal(audio.currentTime, 1);

  controller.tick(1100, { t: 7, isPaused: false, playing: true, rate: 1 });

  assert.equal(audio.currentTime, 7);
});
