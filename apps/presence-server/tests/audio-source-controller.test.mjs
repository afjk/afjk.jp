import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAudioSourceController } from '../../../html/assets/js/scenesync/audio/audio-source-controller.js';

function makeHarness(overrides = {}) {
  const created = [];
  function makeFakeAudio(url) {
    const audio = {
      url,
      src: url,
      paused: true,
      currentTime: 0,
      duration: 10,
      loop: false,
      volume: 1,
      playbackRate: 1,
      play() { this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; },
      load() {},
      addEventListener(type, fn) { this[`on_${type}`] = fn; },
    };
    created.push(audio);
    return audio;
  }
  const controller = createAudioSourceController({
    createAudio: makeFakeAudio,
    getObjectRuntimeTime: () => 0,
    isObjectBeingEdited: () => false,
    ...overrides,
  });
  return { controller, created };
}

test('AudioSource controller', async (t) => {
  await t.test('playOnAwake autoplays on tick', () => {
    const { controller, created } = makeHarness();
    controller.setObjectAudioSources('speaker-1', {
      default: { type: 'audioSource', name: 'default', url: 'https://x/a.mp3', playOnAwake: true, loop: true },
    });
    controller.tick(0);
    assert.equal(created.length, 1);
    assert.equal(created[0].paused, false);
    assert.equal(created[0].loop, true);
  });

  await t.test('does not autoplay without playOnAwake', () => {
    const { controller, created } = makeHarness();
    controller.setObjectAudioSources('speaker-1', {
      default: { type: 'audioSource', name: 'default', url: 'https://x/a.mp3', playOnAwake: false },
    });
    controller.tick(0);
    // entry stays stopped; no audio element is forced to play
    assert.ok(created.length === 0 || created[0].paused === true);
  });

  await t.test('play / pause / stop host API', () => {
    const { controller, created } = makeHarness();
    controller.setObjectAudioSources('speaker-1', {
      default: { type: 'audioSource', name: 'default', url: 'https://x/a.mp3' },
    });
    assert.equal(controller.play('speaker-1', 'default'), true);
    assert.equal(created[0].paused, false);

    controller.pause('speaker-1', 'default');
    assert.equal(created[0].paused, true);

    created[0].currentTime = 5;
    controller.stop('speaker-1', 'default');
    assert.equal(created[0].paused, true);
    assert.equal(created[0].currentTime, 0);
  });

  await t.test('seek and setVolume', () => {
    const { controller, created } = makeHarness();
    controller.setObjectAudioSources('speaker-1', {
      default: { type: 'audioSource', name: 'default', url: 'https://x/a.mp3' },
    });
    controller.seek('speaker-1', 'default', 3.5);
    assert.equal(created[0].currentTime, 3.5);
    controller.setVolume('speaker-1', 'default', 0.25);
    assert.equal(created[0].volume, 0.25);
    assert.equal(controller.getObjectAudioSources('speaker-1').default.volume, 0.25);
  });

  await t.test('setClip swaps the underlying url, keeps playing, and preserves config', () => {
    const { controller, created } = makeHarness();
    controller.setObjectAudioSources('speaker-1', {
      default: { type: 'audioSource', name: 'default', url: 'https://x/a.mp3', loop: true, volume: 0.4 },
    });
    controller.play('speaker-1', 'default');
    controller.setClip('speaker-1', 'default', 'https://x/b.mp3');
    const last = created[created.length - 1];
    assert.equal(last.url, 'https://x/b.mp3');
    assert.equal(last.paused, false);
    const config = controller.getObjectAudioSources('speaker-1').default;
    assert.equal(config.url, 'https://x/b.mp3');
    assert.equal(config.loop, true);
    assert.equal(config.volume, 0.4);
  });

  await t.test('playOneShot creates a non-looping transient audio', () => {
    const { controller, created } = makeHarness();
    controller.setObjectAudioSources('speaker-1', {
      default: { type: 'audioSource', name: 'default', url: 'https://x/a.mp3' },
    });
    controller.playOneShot('speaker-1', 'default');
    const last = created[created.length - 1];
    assert.equal(last.loop, false);
    assert.equal(last.paused, false);
  });

  await t.test('syncToAnimation locks currentTime to animation sample on tick', () => {
    let sampleTime = 2;
    const { controller, created } = makeHarness({
      getAnimationSample: () => ({ time: sampleTime, duration: 10 }),
    });
    controller.setObjectAudioSources('speaker-1', {
      default: { type: 'audioSource', name: 'default', url: 'https://x/a.mp3' },
    });
    controller.play('speaker-1', 'default');
    controller.syncToAnimation('speaker-1', 'default', { animationClipName: 'dance', offset: 0.5 });
    controller.tick(0);
    assert.ok(Math.abs(created[0].currentTime - 2.5) < 0.001);

    // animation loops back to near 0 -> audio resyncs
    sampleTime = 0.1;
    controller.tick(16);
    assert.ok(Math.abs(created[0].currentTime - 0.6) < 0.001);
  });

  await t.test('freezes playback while object is being edited', () => {
    let editing = true;
    const { controller, created } = makeHarness({ isObjectBeingEdited: () => editing });
    controller.setObjectAudioSources('speaker-1', {
      default: { type: 'audioSource', name: 'default', url: 'https://x/a.mp3', playOnAwake: true },
    });
    controller.play('speaker-1', 'default');
    created[0].currentTime = 4;
    controller.tick(0);
    assert.equal(created[0].paused, true);
    assert.equal(created[0].currentTime, 0);
  });

  await t.test('disposeObject stops and clears playback', () => {
    const { controller, created } = makeHarness();
    controller.setObjectAudioSources('speaker-1', {
      default: { type: 'audioSource', name: 'default', url: 'https://x/a.mp3' },
    });
    controller.play('speaker-1', 'default');
    controller.disposeObject('speaker-1');
    assert.equal(created[0].paused, true);
    assert.deepEqual(controller.getObjectAudioSources('speaker-1'), {});
  });
});
