import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createObjectAudioController } from '../../../html/assets/js/scenesync-export/viewer/object-audio-controller.js';

class FakeAudio {
  constructor(url) {
    this.src = url;
    this.preload = '';
    this.loop = false;
    this.volume = 1;
    this.playbackRate = 1;
    this.currentTime = 0;
    this.duration = 10;
    this.muted = false;
    this.paused = true;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.loadCalls = 0;
    this.mutedDuringPlay = [];
  }

  play() {
    this.playCalls += 1;
    this.mutedDuringPlay.push(this.muted);
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }

  load() {
    this.loadCalls += 1;
  }

  addEventListener() {}

  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }
}

function makeController({ audioSources, getAnimationSample = null } = {}) {
  const created = [];
  const resolver = {
    resolveAsset: (asset) => asset?.path || null,
  };

  const controller = createObjectAudioController({
    sceneDoc: {
      objects: [
        {
          id: 'speaker-1',
          audioSources,
        },
      ],
    },
    resolver,
    getAnimationSample,
    createAudio: (url) => {
      const audio = new FakeAudio(url);
      created.push(audio);
      return audio;
    },
    now: () => 0,
  });

  return { controller, created };
}

test('static object AudioSource controller', async (t) => {
  await t.test('plays only sources whose desired state is playing', async () => {
    const { controller, created } = makeController({
      audioSources: {
        ambience: { name: 'ambience', url: 'ambience.mp3', playOnAwake: true },
        narration: { name: 'narration', url: 'narration.mp3', state: 'playing' },
        click: { name: 'click', url: 'click.mp3' },
      },
    });

    assert.equal(controller.elements.length, 3);
    assert.equal(controller.hasAudioSources(), true);
    assert.equal(controller.hasPlaybackTargets(), true);
    assert.deepEqual(controller.getPlaybackTargetElements().map((audio) => audio.src), [
      'ambience.mp3',
      'narration.mp3',
    ]);

    controller.tick(0);
    assert.equal(created[0].playCalls, 1);
    assert.equal(created[1].playCalls, 1);
    assert.equal(created[2].playCalls, 0);

    controller.pausePlaybackTargets();
    assert.equal(created[0].paused, true);
    assert.equal(created[1].paused, true);
    assert.equal(created[2].playCalls, 0);

    await controller.playPlaybackTargets();
    assert.equal(created[0].playCalls, 2);
    assert.equal(created[1].playCalls, 2);
    assert.equal(created[2].playCalls, 0);
  });

  await t.test('unlocks event-only audio sources without leaving them playing', async () => {
    const { controller, created } = makeController({
      audioSources: {
        click: { name: 'click', url: 'click.mp3' },
        hit: { name: 'hit', url: 'hit.mp3', state: 'stopped' },
      },
    });

    created[0].currentTime = 3;

    assert.equal(controller.hasAudioSources(), true);
    assert.equal(controller.hasPlaybackTargets(), false);
    assert.equal(controller.isAudioUnlocked(), false);

    const unlocked = await controller.unlockAudio();

    assert.equal(unlocked, true);
    assert.equal(controller.isAudioUnlocked(), true);
    assert.equal(created[0].mutedDuringPlay[0], true);
    assert.equal(created[1].mutedDuringPlay[0], true);
    assert.equal(created[0].muted, false);
    assert.equal(created[0].paused, true);
    assert.equal(created[0].currentTime, 3);
    assert.equal(created[1].paused, true);
  });

  await t.test('playOneShot reuses unlocked event-only audio element', async () => {
    const { controller, created } = makeController({
      audioSources: {
        click: { name: 'click', url: 'click.mp3' },
      },
    });

    assert.equal(await controller.unlockAudio(), true);
    assert.equal(created.length, 1);

    controller.applyEffect({
      type: 'audioSource.playOneShot',
      objectId: 'speaker-1',
      name: 'click',
      options: { offset: 1.25, volume: 0.35 },
    });

    assert.equal(created.length, 1, 'playOneShot should not create a new Audio after unlock');
    assert.equal(created[0].playCalls, 2);
    assert.equal(created[0].mutedDuringPlay[1], false);
    assert.equal(created[0].volume, 0.35);
    assert.equal(created[0].currentTime, 1.25);
    assert.equal(created[0].paused, false);

    controller.tick(16);
    assert.equal(created[0].paused, false, 'tick should not immediately stop the transient one-shot');
  });

  await t.test('playOneShot keeps using transient audio for playing sources', async () => {
    const { controller, created } = makeController({
      audioSources: {
        music: { name: 'music', url: 'music.mp3', state: 'playing' },
      },
    });

    assert.equal(await controller.unlockAudio(), true);
    controller.applyEffect({
      type: 'audioSource.playOneShot',
      objectId: 'speaker-1',
      name: 'music',
    });

    assert.equal(created.length, 2);
    assert.equal(created[0].src, 'music.mp3');
    assert.equal(created[1].src, 'music.mp3');
    assert.equal(created[1].playCalls, 1);
  });

  await t.test('syncs playing audio sources to animation samples', () => {
    let sampleTime = 2;
    const { controller, created } = makeController({
      audioSources: {
        default: {
          name: 'default',
          url: 'music.mp3',
          state: 'playing',
          loop: true,
          offset: 0.5,
          sync: {
            mode: 'animation',
            animationClipName: 'Run',
            offset: 1,
            driftThreshold: 0,
          },
        },
      },
      getAnimationSample: (_objectId, clipName) => (
        clipName === 'Run' ? { time: sampleTime, duration: 10 } : null
      ),
    });

    controller.tick(0);
    assert.ok(Math.abs(created[0].currentTime - 3.5) < 0.001);

    sampleTime = 9.8;
    controller.tick(16);
    assert.ok(Math.abs(created[0].currentTime - 1.3) < 0.001);
  });

  await t.test('routes syncToAnimation and unsync effects', () => {
    let sampleTime = 4;
    const { controller, created } = makeController({
      audioSources: {
        default: {
          name: 'default',
          url: 'voice.mp3',
          state: 'playing',
          sync: null,
        },
      },
      getAnimationSample: () => ({ time: sampleTime, duration: 10 }),
    });

    controller.applyEffect({
      type: 'audioSource.syncToAnimation',
      objectId: 'speaker-1',
      name: 'default',
      sync: { offset: 0.25 },
    });
    controller.tick(0);
    assert.ok(Math.abs(created[0].currentTime - 4.25) < 0.001);

    controller.applyEffect({
      type: 'audioSource.unsync',
      objectId: 'speaker-1',
      name: 'default',
    });
    created[0].currentTime = 1;
    sampleTime = 7;
    controller.tick(16);
    assert.equal(created[0].currentTime, 1);
  });
});
